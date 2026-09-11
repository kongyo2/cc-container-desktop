#!/usr/bin/env node
// Checks src/shared/imageCatalog.json with the app's own validation and,
// with --online, confirms every pinned digest resolves anonymously on Docker
// Hub with the recorded size. Run with:
//
//   node --experimental-strip-types scripts/verify-image-catalog.mjs [--file <path>] [--online] [--require-published]
/* oxlint-disable no-await-in-loop -- one upstream request at a time keeps the rate polite */
import { catalogProblems, parseCatalog } from '../src/main/images/catalog.ts';
import { normalizeRepository } from '../src/shared/images.ts';
import { CATALOG_FILE, parseArgs, readJson } from './lib/catalog-build.mjs';

const { options } = parseArgs(process.argv.slice(2));
const file = typeof options.file === 'string' ? options.file : CATALOG_FILE;

const raw = readJson(file);
const problems = catalogProblems(raw);
if (problems.length > 0) {
  console.error(`${file} is invalid:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
const catalog = parseCatalog(raw);
console.log(`${file}: ${catalog.entries.length} entries, repository ${catalog.repository}`);

let failures = 0;
const fail = (text) => {
  failures += 1;
  console.error(`  ✗ ${text}`);
};

const published = catalog.entries.flatMap((entry) =>
  entry.platforms.filter((platform) => platform.manifestDigest !== null).map((platform) => ({ entry, platform })),
);
if (options['require-published'] === true) {
  for (const entry of catalog.entries) {
    for (const platform of entry.platforms) {
      if (platform.manifestDigest === null) fail(`${entry.id} has no digest for ${platform.platform}`);
    }
  }
}

async function anonymousToken(repository) {
  const path = normalizeRepository(repository).slice('docker.io/'.length);
  const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${path}:pull`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`token request failed: ${response.status}`);
  const body = await response.json();
  return { token: body.token, path };
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

async function checkOnline() {
  if (published.length === 0) {
    console.log('  (no published digests to check)');
    return;
  }
  const { token, path } = await anonymousToken(catalog.repository);
  for (const { entry, platform } of published) {
    const url = `https://registry-1.docker.io/v2/${path}/manifests/${platform.manifestDigest}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT } });
    if (!response.ok) {
      fail(`${entry.id} ${platform.platform}: ${platform.manifestDigest} → HTTP ${response.status}`);
      continue;
    }
    const manifest = await response.json();
    const layers = Array.isArray(manifest.layers) ? manifest.layers : null;
    if (layers === null) {
      fail(`${entry.id} ${platform.platform}: digest does not point at a platform manifest`);
      continue;
    }
    const bytes = layers.reduce((sum, layer) => sum + (typeof layer.size === 'number' ? layer.size : 0), 0);
    if (platform.compressedLayerBytes !== null && platform.compressedLayerBytes !== bytes) {
      fail(
        `${entry.id} ${platform.platform}: catalog says ${platform.compressedLayerBytes} bytes, registry says ${bytes}`,
      );
      continue;
    }
    console.log(`  ✓ ${entry.id} ${platform.platform} ${platform.manifestDigest.slice(0, 19)} (${bytes} bytes)`);
  }
}

if (options.online === true) {
  await checkOnline();
}

if (failures > 0) {
  console.error(`${failures} problem(s)`);
  process.exit(1);
}
console.log('catalog OK');
