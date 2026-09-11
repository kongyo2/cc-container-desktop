#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { catalogProblems } from '../src/main/images/catalog.ts';
import { IMAGE_PLATFORMS, catalogEntryId, normalizeRepository, officialTag } from '../src/shared/images.ts';
import { CATALOG_FILE, LOCK_FILE, VARIANTS_FILE, parseArgs, readJson, resolveTools } from './lib/catalog-build.mjs';

const { options } = parseArgs(process.argv.slice(2));

const variantsFile = readJson(VARIANTS_FILE);
const lock = readJson(LOCK_FILE);

const repository = normalizeRepository(String(options.repository ?? variantsFile.repository));
const release = String(options.release ?? variantsFile.release);
const revision = typeof options.revision === 'string' ? options.revision : null;
const publishedAt = typeof options['published-at'] === 'string' ? options['published-at'] : null;
const digests = typeof options.digests === 'string' ? readJson(options.digests) : null;
const imageInfoDir = typeof options['image-info-dir'] === 'string' ? options['image-info-dir'] : null;
const unpublished = options.unpublished === true || (digests === null && imageInfoDir === null);
const out = typeof options.out === 'string' ? options.out : CATALOG_FILE;
const selected =
  typeof options.variants === 'string'
    ? options.variants
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '')
    : null;
const mergeFrom = typeof options.merge === 'string' ? options.merge : CATALOG_FILE;

if (!unpublished && digests === null) {
  console.error('--digests is required unless --unpublished is given');
  process.exit(2);
}
for (const name of selected ?? []) {
  if (!variantsFile.variants.some((variant) => variant.id === name)) {
    console.error(`--variants names an unknown variant: ${name}`);
    process.exit(2);
  }
}
if (selected !== null && selected.length === 0) {
  console.error('--variants lists no variant');
  process.exit(2);
}

const carried =
  selected !== null && variantsFile.variants.some((variant) => !selected.includes(variant.id))
    ? existsSync(mergeFrom)
      ? readJson(mergeFrom)
      : null
    : null;

function carriedEntry(variant) {
  if (carried === null) {
    throw new Error(`${variant.id} was not built and there is no ${mergeFrom} to carry it over from`);
  }
  const previous = (carried.entries ?? []).find((entry) => entry.variant === variant.id);
  if (previous === undefined) throw new Error(`${variant.id} was not built and ${mergeFrom} has no entry for it`);
  if (normalizeRepository(String(previous.repository)) !== repository) {
    throw new Error(`${variant.id}: the carried-over entry belongs to ${previous.repository}, not ${repository}`);
  }
  if (!unpublished && !previous.platforms.some((platform) => platform.manifestDigest !== null)) {
    throw new Error(`${variant.id} was not built and its carried-over entry is unpublished; include it in the build`);
  }
  return previous;
}

function measuredTools(variant) {
  if (imageInfoDir === null) return null;
  const file = join(imageInfoDir, `${variant}.image-info.json`);
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const info = readJson(file);
  if (info.variant !== variant) throw new Error(`${file} describes ${info.variant}, not ${variant}`);
  if (info.release !== release) throw new Error(`${file} was built for release ${info.release}, not ${release}`);
  return info.tools ?? {};
}

function platformsOf(variant) {
  if (unpublished) {
    return IMAGE_PLATFORMS.map((platform) => ({ platform, manifestDigest: null, compressedLayerBytes: null }));
  }
  const entry = digests[variant];
  if (entry === undefined) throw new Error(`digests file has no entry for ${variant}`);
  return IMAGE_PLATFORMS.map((platform) => {
    const record = entry.platforms?.[platform];
    if (record === undefined) return { platform, manifestDigest: null, compressedLayerBytes: null };
    return {
      platform,
      manifestDigest: record.digest,
      compressedLayerBytes: typeof record.compressedLayerBytes === 'number' ? record.compressedLayerBytes : null,
    };
  });
}

function generatedEntry(variant) {
  return {
    id: catalogEntryId(variant.id, release),
    variant: variant.id,
    release,
    title: variant.title,
    summary: variant.summary,
    description: variant.description,
    recommended: variant.recommended === true,
    inherits: variant.inherits ?? null,
    repository,
    tag: officialTag(variant.id, release),
    indexDigest: unpublished ? null : (digests[variant.id]?.indexDigest ?? null),
    platforms: platformsOf(variant.id),
    sourceRevision: revision,
    publishedAt: unpublished ? null : publishedAt,
    tools: resolveTools(variantsFile.tools, lock, variantsFile.variants, variant.id, measuredTools(variant.id)),
  };
}

const entries = variantsFile.variants.map((variant) =>
  selected !== null && !selected.includes(variant.id) ? carriedEntry(variant) : generatedEntry(variant),
);
const carriedCount = entries.filter((entry) => entry.release !== release || entry.sourceRevision !== revision).length;

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository,
  entries,
};

const problems = catalogProblems(catalog);
if (problems.length > 0) {
  console.error('the generated catalog is invalid:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const text = `${JSON.stringify(catalog, null, 2)}\n`;

if (options.check === true) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
  const strip = (value) => value.replace(/"generatedAt": "[^"]*"/u, '"generatedAt": ""');
  if (strip(current) !== strip(text)) {
    console.error(`${out} is out of date; run the generator`);
    process.exit(1);
  }
  console.log(`${out} is up to date (${entries.length} entries)`);
  process.exit(0);
}

writeFileSync(out, text, 'utf8');
console.log(
  `wrote ${out}: ${entries.length} entries for ${repository} @ ${release}${unpublished ? ' (unpublished, no digests)' : ''}${
    selected === null || carriedCount === 0 ? '' : ` (${carriedCount} carried over from ${mergeFrom})`
  }`,
);
