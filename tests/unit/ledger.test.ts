import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  findRegistration,
  LedgerConflictError,
  registeredImageIdFor,
  registrationKey,
  removeRegistration,
  upsertRegistration,
} from '../../src/main/images/ledger.ts';
import { parseImagesFile } from '../../src/main/images/schema.ts';
import { REGISTERED_IMAGE_ID_PATTERN } from '../../src/shared/images.ts';
import type { RegisteredImage } from '../../src/shared/images.ts';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function registration(digest: string, platform: 'linux/amd64' | 'linux/arm64' = 'linux/amd64'): RegisteredImage {
  return {
    id: registeredImageIdFor('kongyo2/cc-workbench', digest, 'web-2026.09.1', platform),
    catalogEntryId: 'web@2026.09.1',
    variant: 'web',
    release: '2026.09.1',
    title: { ja: 'Web 開発 / 2026.09.1', en: 'Web / 2026.09.1' },
    repository: 'docker.io/kongyo2/cc-workbench',
    tag: 'web-2026.09.1',
    pinnedDigest: digest,
    platform,
    tools: [],
    registeredAt: '2026-09-11T00:00:00.000Z',
  };
}

function custom(repository: string, tag: string, digest: string | null): RegisteredImage {
  return {
    id: registeredImageIdFor(repository, digest, tag, 'linux/amd64'),
    catalogEntryId: null,
    variant: null,
    release: null,
    title: { ja: `${repository}:${tag}`, en: `${repository}:${tag}` },
    repository,
    tag,
    pinnedDigest: digest,
    platform: 'linux/amd64',
    tools: [],
    registeredAt: '2026-09-12T00:00:00.000Z',
  };
}

test('the registration id is derived from repository, digest and platform, with the repository normalized', () => {
  const id = registeredImageIdFor('kongyo2/cc-workbench', DIGEST_A, 'web-2026.09.1', 'linux/amd64');
  assert.match(id, REGISTERED_IMAGE_ID_PATTERN);
  assert.equal(registeredImageIdFor('docker.io/kongyo2/cc-workbench', DIGEST_A, 'other', 'linux/amd64'), id);
  assert.equal(registeredImageIdFor('index.docker.io/KONGYO2/cc-workbench', DIGEST_A, null, 'linux/amd64'), id);
  assert.notEqual(registeredImageIdFor('kongyo2/cc-workbench', DIGEST_B, 'web-2026.09.1', 'linux/amd64'), id);
  assert.notEqual(registeredImageIdFor('kongyo2/cc-workbench', DIGEST_A, 'web-2026.09.1', 'linux/arm64'), id);
  assert.notEqual(registeredImageIdFor('kongyo2/other', DIGEST_A, 'web-2026.09.1', 'linux/amd64'), id);
});

test('ids of digest-pinned registrations written by earlier versions are unchanged', () => {
  const earlierKey = JSON.stringify(['docker.io/kongyo2/cc-workbench', DIGEST_A, 'linux/amd64']);
  const earlierId = `img_${createHash('sha256').update(earlierKey).digest('hex').slice(0, 24)}`;
  assert.equal(registeredImageIdFor('kongyo2/cc-workbench', DIGEST_A, 'web-2026.09.1', 'linux/amd64'), earlierId);
});

test('an image without a digest is keyed by its tag', () => {
  const byTag = registeredImageIdFor('my-image', null, 'dev', 'linux/amd64');
  assert.equal(registeredImageIdFor('docker.io/library/my-image', null, 'dev', 'linux/amd64'), byTag);
  assert.notEqual(registeredImageIdFor('my-image', null, 'latest', 'linux/amd64'), byTag);
  assert.notEqual(registeredImageIdFor('my-image', DIGEST_A, 'dev', 'linux/amd64'), byTag);
  assert.equal(
    registrationKey(custom('docker.io/library/my-image', 'dev', null)),
    'docker.io/library/my-image|tag:dev|linux/amd64',
  );
});

test('re-registering the same content keeps one entry and takes the new registration time', () => {
  const first = registration(DIGEST_A);
  const ledger = upsertRegistration([], first);
  assert.equal(ledger.length, 1);
  const again = {
    ...first,
    registeredAt: '2027-01-01T00:00:00.000Z',
    tools: [{ id: 'node', name: 'Node.js', version: '24', highlight: true }],
  };
  const updated = upsertRegistration(ledger, again);
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.registeredAt, again.registeredAt);
  assert.equal(updated[0]?.tools.length, 1);
});

test('registering catalog content by hand keeps the catalog description', () => {
  const ledger = upsertRegistration([], registration(DIGEST_A));
  const byHand = custom('docker.io/kongyo2/cc-workbench', 'web-2026.09.1', DIGEST_A);
  assert.equal(byHand.id, ledger[0]?.id);
  const merged = upsertRegistration(ledger, byHand);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.catalogEntryId, 'web@2026.09.1');
  assert.equal(merged[0]?.title.en, 'Web / 2026.09.1');
  assert.equal(merged[0]?.registeredAt, byHand.registeredAt);
});

test('different digests or platforms are different registrations', () => {
  let ledger = upsertRegistration([], registration(DIGEST_A));
  ledger = upsertRegistration(ledger, registration(DIGEST_B));
  ledger = upsertRegistration(ledger, registration(DIGEST_A, 'linux/arm64'));
  ledger = upsertRegistration(ledger, custom('docker.io/library/my-image', 'dev', null));
  assert.equal(ledger.length, 4);
  assert.equal(new Set(ledger.map(registrationKey)).size, 4);
});

test('a registration whose id does not match its key, or that collides with another key, is refused', () => {
  const ledger = upsertRegistration([], registration(DIGEST_A));
  assert.throws(
    () => upsertRegistration(ledger, { ...registration(DIGEST_B), id: ledger[0]!.id }),
    LedgerConflictError,
  );
  assert.throws(
    () => upsertRegistration(ledger, { ...registration(DIGEST_A), id: 'img_000000000000000000000000' }),
    LedgerConflictError,
  );
});

test('removal and lookup', () => {
  const ledger = upsertRegistration([], registration(DIGEST_A));
  const id = ledger[0]!.id;
  assert.equal(findRegistration(ledger, id)?.pinnedDigest, DIGEST_A);
  assert.equal(findRegistration(ledger, null), null);
  assert.equal(removeRegistration(ledger, id).length, 0);
  assert.equal(removeRegistration(ledger, 'img_nope').length, 1);
});

test('the ledger file is read in its current shape and a ledger from an earlier version still reads', () => {
  const good = parseImagesFile({
    schemaVersion: 1,
    images: [registration(DIGEST_A), custom('docker.io/library/x', 'dev', null)],
  });
  assert.equal(good.ok, true);
  const legacy = parseImagesFile({ version: 1, images: [] });
  assert.equal(legacy.ok, false);
  const missingKey = parseImagesFile({
    schemaVersion: 1,
    images: [{ ...registration(DIGEST_A), platform: undefined }],
  });
  assert.equal(missingKey.ok, false);
  const duplicated = parseImagesFile({ schemaVersion: 1, images: [registration(DIGEST_A), registration(DIGEST_A)] });
  assert.equal(duplicated.ok, false);
  const nothingToFollow = parseImagesFile({
    schemaVersion: 1,
    images: [{ ...custom('docker.io/library/x', 'dev', null), tag: null }],
  });
  assert.equal(nothingToFollow.ok, false);

  const earlier = parseImagesFile({
    schemaVersion: 1,
    images: [
      {
        ...registration(DIGEST_A),
        indexDigest: null,
        digestKind: 'manifest',
        runtimeContract: 1,
        sourceRevision: 'abc1234',
        lastVerified: {
          engineId: 'engine',
          localImageId: 'sha256:local',
          localSizeBytes: 10,
          verifiedAt: '2026-09-11T00:00:00.000Z',
          checksPassed: 30,
        },
      },
    ],
  });
  assert.equal(earlier.ok, true);
  if (earlier.ok) {
    assert.equal(earlier.value[0]?.id, registration(DIGEST_A).id);
    assert.equal('lastVerified' in (earlier.value[0] ?? {}), false);
  }
});
