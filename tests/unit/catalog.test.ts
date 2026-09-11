import assert from 'node:assert/strict';
import { test } from 'node:test';

import bundled from '../../src/shared/imageCatalog.json' with { type: 'json' };
import { CatalogInvalidError, catalogProblems, parseCatalog } from '../../src/main/images/catalog.ts';
import { IMAGE_VARIANTS } from '../../src/shared/images.ts';

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(bundled)) as Record<string, unknown>;
}

function entries(catalog: Record<string, unknown>): Record<string, unknown>[] {
  return catalog['entries'] as Record<string, unknown>[];
}

test('the bundled catalog is valid, lists every variant once and recommends exactly one', () => {
  assert.deepEqual(catalogProblems(bundled), []);
  const catalog = parseCatalog(bundled);
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(
    catalog.entries.map((entry) => entry.variant),
    [...IMAGE_VARIANTS],
  );
  assert.equal(catalog.entries.filter((entry) => entry.recommended).length, 1);
  assert.equal(catalog.entries.find((entry) => entry.recommended)?.variant, 'web');
  for (const entry of catalog.entries) {
    assert.equal(entry.id, `${entry.variant}@${entry.release}`);
    assert.equal(entry.tag, `${entry.variant}-${entry.release}`);
    assert.equal(entry.repository, catalog.repository);
    assert.ok(entry.platforms.length >= 1);
    assert.ok(entry.tools.length > 0);
    assert.ok(entry.tools.some((tool) => tool.id === 'claude-code'));
    assert.ok(entry.tools.some((tool) => tool.id === 'node'));
  }
});

test('full inherits web and web inherits base', () => {
  const catalog = parseCatalog(bundled);
  assert.equal(catalog.entries.find((entry) => entry.variant === 'full')?.inherits, 'web');
  assert.equal(catalog.entries.find((entry) => entry.variant === 'web')?.inherits, 'base');
  assert.equal(catalog.entries.find((entry) => entry.variant === 'base')?.inherits, null);
});

test('an id that does not match variant@release is rejected', () => {
  const catalog = clone();
  entries(catalog)[0]!['id'] = 'nope';
  assert.ok(catalogProblems(catalog).some((problem) => problem.includes('id must be')));
});

test('a tag that does not match variant-release is rejected', () => {
  const catalog = clone();
  entries(catalog)[1]!['tag'] = 'latest';
  assert.ok(catalogProblems(catalog).some((problem) => problem.includes('tag must be')));
});

test('a repository outside the catalog repository is rejected', () => {
  const catalog = clone();
  entries(catalog)[1]!['repository'] = 'docker.io/someone-else/images';
  assert.ok(catalogProblems(catalog).some((problem) => problem.includes('not the catalog repository')));
});

test('digests must be sha256 with 64 hex digits', () => {
  const catalog = clone();
  const platforms = entries(catalog)[0]!['platforms'] as Record<string, unknown>[];
  platforms[0]!['manifestDigest'] = 'sha256:short';
  assert.ok(catalogProblems(catalog).length > 0);
  platforms[0]!['manifestDigest'] = `sha256:${'f'.repeat(64)}`;
  platforms[0]!['compressedLayerBytes'] = 123;
  assert.deepEqual(catalogProblems(catalog), []);
});

test('a size without a digest, a duplicated platform and two recommendations are rejected', () => {
  const withSize = clone();
  const unpublished = (entries(withSize)[0]!['platforms'] as Record<string, unknown>[])[0]!;
  unpublished['manifestDigest'] = null;
  unpublished['compressedLayerBytes'] = 5;
  assert.ok(catalogProblems(withSize).some((problem) => problem.includes('size without a digest')));

  const duplicated = clone();
  const platforms = entries(duplicated)[0]!['platforms'] as Record<string, unknown>[];
  platforms.push({ ...platforms[0]! });
  assert.ok(catalogProblems(duplicated).some((problem) => problem.includes('listed twice')));

  const twice = clone();
  entries(twice)[0]!['recommended'] = true;
  assert.ok(catalogProblems(twice).some((problem) => problem.includes('exactly one entry')));
});

test('unknown keys, unknown variants and non-canonical repositories are rejected', () => {
  const extra = clone();
  extra['downloadFrom'] = 'https://example.test';
  assert.ok(catalogProblems(extra).length > 0);

  const variant = clone();
  entries(variant)[0]!['variant'] = 'gpu';
  assert.ok(catalogProblems(variant).length > 0);

  const repo = clone();
  repo['repository'] = 'kongyo2/cc-workbench';
  assert.ok(catalogProblems(repo).some((problem) => problem.includes('canonical form')));
  assert.throws(() => parseCatalog(repo), CatalogInvalidError);
});
