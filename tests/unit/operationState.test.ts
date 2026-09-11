import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createOperation,
  finishOperation,
  patchOperation,
  pruneHistory,
  recoverOperation,
} from '../../src/main/images/operationState.ts';
import { registeredImageIdFor } from '../../src/main/images/ledger.ts';
import type { ImageOperation, RegisteredImage } from '../../src/shared/images.ts';

const DIGEST = `sha256:${'d'.repeat(64)}`;

function operation(now = '2026-09-11T10:00:00.000Z'): ImageOperation {
  return createOperation({
    id: 'op_1',
    kind: 'download',
    targetKey: 'catalog:web@2026.09.1',
    catalogEntryId: 'web@2026.09.1',
    registeredImageId: null,
    target: {
      title: { ja: 'Web / 2026.09.1', en: 'Web / 2026.09.1' },
      repository: 'docker.io/kongyo2/cc-workbench',
      tag: 'web-2026.09.1',
      pinnedDigest: DIGEST,
      platform: 'linux/amd64',
    },
    now,
  });
}

function registered(registeredAt: string): RegisteredImage {
  return {
    id: registeredImageIdFor('docker.io/kongyo2/cc-workbench', DIGEST, 'web-2026.09.1', 'linux/amd64'),
    catalogEntryId: 'web@2026.09.1',
    variant: 'web',
    release: '2026.09.1',
    title: { ja: 'Web / 2026.09.1', en: 'Web / 2026.09.1' },
    repository: 'docker.io/kongyo2/cc-workbench',
    tag: 'web-2026.09.1',
    pinnedDigest: DIGEST,
    platform: 'linux/amd64',
    tools: [],
    registeredAt,
  };
}

test('every patch bumps the sequence; a terminal phase freezes the operation and drops layer detail', () => {
  const created = operation();
  assert.equal(created.sequence, 0);
  assert.equal(created.phase, 'queued');
  const pulling = patchOperation(
    created,
    { phase: 'pulling', layers: [{ id: 'l', status: 'Downloading', current: 1, total: 2, done: false }] },
    '2026-09-11T10:00:01.000Z',
  );
  assert.equal(pulling.sequence, 1);
  assert.equal(pulling.layers.length, 1);
  const done = finishOperation(pulling, 'succeeded', null, '2026-09-11T10:00:02.000Z');
  assert.equal(done.sequence, 2);
  assert.equal(done.finishedAt, '2026-09-11T10:00:02.000Z');
  assert.deepEqual(done.layers, []);
  const frozen = patchOperation(done, { phase: 'pulling' });
  assert.equal(frozen, done, 'a finished operation cannot be reopened');
});

test('a cancelled operation keeps no error while a failed one carries it', () => {
  const failed = finishOperation(operation(), 'failed', { code: 'NETWORK_ERROR', message: 'x', retryable: true });
  assert.equal(failed.error?.code, 'NETWORK_ERROR');
  const cancelled = finishOperation(operation(), 'cancelled', null);
  assert.equal(cancelled.error, null);
});

test('after a restart an operation whose registration committed is succeeded, everything else is interrupted', () => {
  const started = operation('2026-09-11T10:00:00.000Z');
  const running = patchOperation(started, { phase: 'registering' }, '2026-09-11T10:05:00.000Z');

  const committedLater = recoverOperation(running, [registered('2026-09-11T10:06:00.000Z')]);
  assert.equal(committedLater.phase, 'succeeded');
  assert.equal(committedLater.registeredImageId, registered('x').id);

  const committedEarlier = recoverOperation(running, [registered('2026-09-11T09:00:00.000Z')]);
  assert.equal(committedEarlier.phase, 'interrupted', 'an older registration of the same digest does not count');
  assert.equal(committedEarlier.error?.code, 'INTERRUPTED');

  const nothing = recoverOperation(running, []);
  assert.equal(nothing.phase, 'interrupted');

  const alreadyDone = finishOperation(running, 'failed', { code: 'X', message: 'x', retryable: false });
  assert.equal(recoverOperation(alreadyDone, []).phase, 'failed');
});

test('history keeps every active operation and only the newest finished ones', () => {
  const finished = Array.from({ length: 25 }, (_, index) =>
    finishOperation(
      { ...operation(), id: `op_${index}` },
      'succeeded',
      null,
      `2026-09-11T10:${String(index).padStart(2, '0')}:00.000Z`,
    ),
  );
  const active = patchOperation({ ...operation(), id: 'op_active' }, { phase: 'pulling' });
  const kept = pruneHistory([active, ...finished], 20);
  assert.equal(kept.length, 21);
  assert.ok(kept.some((entry) => entry.id === 'op_active'));
  assert.ok(!kept.some((entry) => entry.id === 'op_0'));
  assert.ok(kept.some((entry) => entry.id === 'op_24'));
});
