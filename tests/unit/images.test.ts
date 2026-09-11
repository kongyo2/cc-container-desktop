import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  catalogEntryId,
  digestReference,
  dockerHubUrl,
  imageTargetKey,
  normalizeRepository,
  officialTag,
  operationProgress,
  platformFromDaemon,
  preferredRegisteredImage,
  pullCommand,
  repositoryDisplay,
} from '../../src/shared/images.ts';
import type { ImageOperation, RegisteredImageView } from '../../src/shared/images.ts';

test('repositories normalize to the canonical docker.io form', () => {
  assert.equal(normalizeRepository('kongyo2/cc-workbench'), 'docker.io/kongyo2/cc-workbench');
  assert.equal(normalizeRepository('docker.io/kongyo2/cc-workbench'), 'docker.io/kongyo2/cc-workbench');
  assert.equal(normalizeRepository('index.docker.io/kongyo2/cc-workbench:web-1'), 'docker.io/kongyo2/cc-workbench');
  assert.equal(normalizeRepository('KONGYO2/CC-Workbench@sha256:abc'), 'docker.io/kongyo2/cc-workbench');
  assert.equal(normalizeRepository('ubuntu'), 'docker.io/library/ubuntu');
  assert.equal(normalizeRepository('localhost:5000/cc/base:tag'), 'localhost:5000/cc/base');
  assert.equal(normalizeRepository('ghcr.io/org/name'), 'ghcr.io/org/name');
  assert.equal(normalizeRepository(''), '');
});

test('display form strips docker.io and library prefixes only', () => {
  assert.equal(repositoryDisplay('docker.io/kongyo2/cc-workbench'), 'kongyo2/cc-workbench');
  assert.equal(repositoryDisplay('docker.io/library/ubuntu'), 'ubuntu');
  assert.equal(repositoryDisplay('localhost:5000/cc/base'), 'localhost:5000/cc/base');
});

test('Docker Hub links only exist for Docker Hub repositories', () => {
  assert.equal(dockerHubUrl('kongyo2/cc-workbench'), 'https://hub.docker.com/r/kongyo2/cc-workbench');
  assert.equal(dockerHubUrl('ubuntu'), 'https://hub.docker.com/_/ubuntu');
  assert.equal(dockerHubUrl('localhost:5000/cc/base'), null);
});

test('daemon platforms are normalized from the architectures Docker reports', () => {
  assert.equal(platformFromDaemon('linux', 'x86_64'), 'linux/amd64');
  assert.equal(platformFromDaemon('linux', 'amd64'), 'linux/amd64');
  assert.equal(platformFromDaemon('linux', 'aarch64'), 'linux/arm64');
  assert.equal(platformFromDaemon('linux', 'arm64'), 'linux/arm64');
  assert.equal(platformFromDaemon('linux', 'riscv64'), null);
  assert.equal(platformFromDaemon('windows', 'x86_64'), null);
  assert.equal(platformFromDaemon(null, 'x86_64'), null);
});

test('ids, tags, references and target keys are deterministic', () => {
  assert.equal(catalogEntryId('web', '2026.09.1'), 'web@2026.09.1');
  assert.equal(officialTag('web', '2026.09.1'), 'web-2026.09.1');
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.equal(digestReference('docker.io/kongyo2/cc-workbench', digest), `kongyo2/cc-workbench@${digest}`);
  assert.equal(
    imageTargetKey('kongyo2/cc-workbench', digest, 'web-2026.09.1', 'linux/amd64'),
    `docker.io/kongyo2/cc-workbench|${digest}|linux/amd64`,
  );
  assert.equal(
    imageTargetKey('kongyo2/cc-workbench', null, 'web-2026.09.1', 'linux/arm64'),
    'docker.io/kongyo2/cc-workbench|tag:web-2026.09.1|linux/arm64',
  );
  assert.equal(
    pullCommand('docker.io/kongyo2/cc-workbench', null, 'web-2026.09.1', 'linux/amd64'),
    'docker pull --platform linux/amd64 kongyo2/cc-workbench:web-2026.09.1',
  );
  assert.equal(
    pullCommand('docker.io/kongyo2/cc-workbench', digest, 'web-2026.09.1', 'linux/arm64'),
    `docker pull --platform linux/arm64 kongyo2/cc-workbench@${digest}`,
  );
});

function operation(patch: Partial<ImageOperation>): ImageOperation {
  return {
    id: 'op',
    kind: 'download',
    sequence: 0,
    targetKey: 'k',
    catalogEntryId: 'web@2026.09.1',
    registeredImageId: null,
    target: {
      variant: 'web',
      release: '2026.09.1',
      title: { ja: 'Web', en: 'Web' },
      repository: 'docker.io/kongyo2/cc-workbench',
      tag: 'web-2026.09.1',
      pinnedDigest: null,
      platform: null,
    },
    phase: 'pulling',
    step: '',
    cancelRequested: false,
    startedAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
    finishedAt: null,
    pulled: true,
    downloadedBytes: 0,
    totalBytes: null,
    completedLayers: 0,
    totalLayers: 0,
    layers: [],
    error: null,
    ...patch,
  };
}

test('progress is a byte ratio when totals are known, a layer ratio otherwise, and never a fake 100%', () => {
  assert.equal(operationProgress(operation({ downloadedBytes: 50, totalBytes: 200 })), 0.25);
  assert.equal(operationProgress(operation({ completedLayers: 2, totalLayers: 8 })), 0.25);
  assert.equal(operationProgress(operation({})), null);
  assert.equal(operationProgress(operation({ phase: 'verifying', downloadedBytes: 200, totalBytes: 200 })), null);
  assert.equal(operationProgress(operation({ phase: 'succeeded' })), 1);
  assert.equal(operationProgress(operation({ downloadedBytes: 900, totalBytes: 200 })), 1);
});

function view(id: string, variant: 'web' | 'base', ready: boolean): RegisteredImageView {
  const digest = `sha256:${'b'.repeat(64)}`;
  return {
    image: {
      id,
      catalogEntryId: `${variant}@2026.09.1`,
      variant,
      release: '2026.09.1',
      title: { ja: variant, en: variant },
      repository: 'docker.io/kongyo2/cc-workbench',
      tag: `${variant}-2026.09.1`,
      indexDigest: null,
      pinnedDigest: digest,
      digestKind: 'manifest',
      platform: 'linux/amd64',
      runtimeContract: 1,
      sourceRevision: null,
      tools: [],
      registeredAt: '2026-09-11T00:00:00.000Z',
      lastVerified: {
        engineId: 'e',
        localImageId: 'sha256:l',
        localSizeBytes: 1,
        verifiedAt: '2026-09-11T00:00:00.000Z',
        checksPassed: 1,
      },
    },
    availability: ready ? { kind: 'ready', localImageId: 'sha256:l', localSizeBytes: 1 } : { kind: 'missing' },
    environmentIds: [],
    appliedTaskIds: [],
    inCatalog: true,
  };
}

test('a new environment prefers a usable web image, then any usable image, then anything registered', () => {
  assert.equal(preferredRegisteredImage([view('a', 'base', true), view('b', 'web', true)])?.image.id, 'b');
  assert.equal(preferredRegisteredImage([view('a', 'base', true), view('b', 'web', false)])?.image.id, 'a');
  assert.equal(preferredRegisteredImage([view('a', 'base', false)])?.image.id, 'a');
  assert.equal(preferredRegisteredImage([]), null);
});
