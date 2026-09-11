// Shared helpers for the catalog scripts. Run with `node --experimental-strip-types`
// so the app's own validation (src/main/images/catalog.ts) can be imported.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VARIANTS_FILE = join(ROOT, 'docker', 'variants.json');
export const LOCK_FILE = join(ROOT, 'docker', 'image-versions.lock.json');
export const CATALOG_FILE = join(ROOT, 'src', 'shared', 'imageCatalog.json');

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[arg.slice(2)] = true;
    } else {
      options[arg.slice(2)] = next;
      index += 1;
    }
  }
  return { options, positional };
}

export function lockValue(lock, path) {
  let current = lock;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(segment in current)) return null;
    current = current[segment];
  }
  return typeof current === 'string' ? current : null;
}

export function variantChain(variants, id) {
  const chain = [];
  let cursor = variants.find((variant) => variant.id === id) ?? null;
  const seen = new Set();
  while (cursor !== null) {
    if (seen.has(cursor.id)) throw new Error(`variant inheritance loops at ${cursor.id}`);
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.inherits === null ? null : (variants.find((variant) => variant.id === cursor.inherits) ?? null);
  }
  if (chain.length === 0) throw new Error(`unknown variant ${id}`);
  return chain;
}

export function resolveTools(definitions, lock, variants, id, measured) {
  const ids = [];
  for (const variant of variantChain(variants, id)) {
    for (const toolId of variant.tools) {
      if (!ids.includes(toolId)) ids.push(toolId);
    }
  }
  return ids.map((toolId) => {
    const definition = definitions[toolId];
    if (definition === undefined) throw new Error(`variant ${id} lists unknown tool ${toolId}`);
    let version = '';
    if (definition.versionFrom !== '' && definition.versionFrom !== 'apt') {
      version = lockValue(lock, definition.versionFrom) ?? '';
      if (version === '') throw new Error(`tool ${toolId}: lock has no value at ${definition.versionFrom}`);
    }
    const measuredVersion = measured?.[toolId];
    if (typeof measuredVersion === 'string' && measuredVersion !== '') version = measuredVersion;
    return { id: toolId, name: definition.name, version, highlight: definition.highlight === true };
  });
}
