#!/usr/bin/env node
// Generates src/shared/imageCatalog.json from docker/variants.json,
// docker/image-versions.lock.json and (after a publish) the digests and
// image-info.json files CI collected. Run with:
//
//   node --experimental-strip-types scripts/generate-image-catalog.mjs [options]
//
//   --unpublished              write the catalog without digests (pre-publish state)
//   --digests <file>           JSON: { "<variant>": { indexDigest, platforms: { "<platform>": { digest, compressedLayerBytes } } } }
//   --image-info-dir <dir>     directory holding <variant>.image-info.json files from the verify step
//   --repository <repo>        override docker/variants.json repository
//   --release <YYYY.MM.N>      override docker/variants.json release
//   --revision <sha>           source revision the images were built from
//   --published-at <iso>       publication time
//   --out <file>               output path (default src/shared/imageCatalog.json)
//   --check                    do not write; fail if the output would differ from the file on disk
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

if (!unpublished && digests === null) {
  console.error('--digests is required unless --unpublished is given');
  process.exit(2);
}

function measuredTools(variant) {
  if (imageInfoDir === null) return null;
  const file = join(imageInfoDir, `${variant}.image-info.json`);
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const info = readJson(file);
  if (info.variant !== variant) throw new Error(`${file} describes ${info.variant}, not ${variant}`);
  if (info.release !== release) throw new Error(`${file} was built for release ${info.release}, not ${release}`);
  if (info.runtimeContract !== 1) throw new Error(`${file} has runtime contract ${info.runtimeContract}`);
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

const entries = variantsFile.variants.map((variant) => ({
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
  runtimeContract: 1,
  sourceRevision: revision,
  publishedAt: unpublished ? null : publishedAt,
  tools: resolveTools(variantsFile.tools, lock, variantsFile.variants, variant.id, measuredTools(variant.id)),
}));

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
  `wrote ${out}: ${entries.length} entries for ${repository} @ ${release}${unpublished ? ' (unpublished, no digests)' : ''}`,
);
