import assert from 'node:assert/strict';
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
    id: registeredImageIdFor('kongyo2/cc-workbench', digest, platform),
    catalogEntryId: 'web@2026.09.1',
    variant: 'web',
    release: '2026.09.1',
    title: { ja: 'Web 開発', en: 'Web' },
    repository: 'docker.io/kongyo2/cc-workbench',
    tag: 'web-2026.09.1',
    indexDigest: null,
    pinnedDigest: digest,
    digestKind: 'manifest',
    platform,
    runtimeContract: 1,
    sourceRevision: null,
    tools: [],
    registeredAt: '2026-09-11T00:00:00.000Z',
    lastVerified: {
      engineId: 'engine',
      localImageId: 'sha256:local',
      localSizeBytes: 10,
      verifiedAt: '2026-09-11T00:00:00.000Z',
      checksPassed: 30,
    },
  };
}

test('the registration id is derived from repository, digest and platform, with the repository normalized', () => {
  const id = registeredImageIdFor('kongyo2/cc-workbench', DIGEST_A, 'linux/amd64');
  assert.match(id, REGISTERED_IMAGE_ID_PATTERN);
  assert.equal(registeredImageIdFor('docker.io/kongyo2/cc-workbench', DIGEST_A, 'linux/amd64'), id);
  assert.equal(registeredImageIdFor('index.docker.io/KONGYO2/cc-workbench', DIGEST_A, 'linux/amd64'), id);
  assert.notEqual(registeredImageIdFor('kongyo2/cc-workbench', DIGEST_B, 'linux/amd64'), id);
  assert.notEqual(registeredImageIdFor('kongyo2/cc-workbench', DIGEST_A, 'linux/arm64'), id);
  assert.notEqual(registeredImageIdFor('kongyo2/other', DIGEST_A, 'linux/amd64'), id);
});

test('re-registering the same content keeps one entry and its original registration time', () => {
  const first = registration(DIGEST_A);
  const ledger = upsertRegistration([], first);
  assert.equal(ledger.length, 1);
  const again = {
    ...first,
    registeredAt: '2027-01-01T00:00:00.000Z',
    lastVerified: { ...first.lastVerified, checksPassed: 31 },
  };
  const updated = upsertRegistration(ledger, again);
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.registeredAt, first.registeredAt);
  assert.equal(updated[0]?.lastVerified.checksPassed, 31);
});

test('different digests or platforms are different registrations', () => {
  let ledger = upsertRegistration([], registration(DIGEST_A));
  ledger = upsertRegistration(ledger, registration(DIGEST_B));
  ledger = upsertRegistration(ledger, registration(DIGEST_A, 'linux/arm64'));
  assert.equal(ledger.length, 3);
  assert.equal(new Set(ledger.map(registrationKey)).size, 3);
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

test('the ledger file is read strictly', () => {
  const good = parseImagesFile({ schemaVersion: 1, images: [registration(DIGEST_A)] });
  assert.equal(good.ok, true);
  const legacy = parseImagesFile({ version: 1, images: [] });
  assert.equal(legacy.ok, false);
  const extraKey = parseImagesFile({ schemaVersion: 1, images: [{ ...registration(DIGEST_A), extra: true }] });
  assert.equal(extraKey.ok, false);
  const duplicated = parseImagesFile({ schemaVersion: 1, images: [registration(DIGEST_A), registration(DIGEST_A)] });
  assert.equal(duplicated.ok, false);
  const badContract = parseImagesFile({
    schemaVersion: 1,
    images: [{ ...registration(DIGEST_A), runtimeContract: 2 }],
  });
  assert.equal(badContract.ok, false);
});
