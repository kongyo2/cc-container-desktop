import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DIGEST_PATTERN, IMAGE_PLATFORMS } from '../../src/shared/images.ts';

interface LockBase {
  readonly image: string;
  readonly tag: string;
  readonly indexDigest: string;
  readonly platforms: Readonly<Record<string, string>>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lock = JSON.parse(readFileSync(join(ROOT, 'docker', 'image-versions.lock.json'), 'utf8')) as {
  readonly base: LockBase;
};
const dockerfile = readFileSync(join(ROOT, 'docker', 'Dockerfile'), 'utf8');

test('the Dockerfile builds from the base image the lock pins', () => {
  const match = /^ARG UBUNTU_REF=(\S+)$/mu.exec(dockerfile);
  assert.ok(match !== null, 'the Dockerfile declares ARG UBUNTU_REF');
  assert.equal(match[1], `${lock.base.image}@${lock.base.indexDigest}`);
});

test('the lock pins the base by an index digest and one digest per supported platform', () => {
  assert.match(lock.base.indexDigest, DIGEST_PATTERN);
  for (const platform of IMAGE_PLATFORMS) {
    assert.match(lock.base.platforms[platform] ?? '', DIGEST_PATTERN, `no base digest for ${platform}`);
  }
});
