import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  catalogEntryId,
  digestReference,
  dockerHubUrl,
  imageDisplayName,
  imageReference,
  imageReferenceProblem,
  imageTargetKey,
  normalizeRepository,
  officialTag,
  operationProgress,
  parseImageReference,
  platformFromDaemon,
  preferredRegisteredImage,
  pullCommand,
  registrationIdentity,
  repositoryDisplay,
} from '../../src/shared/images.ts';
import type { ImageOperation, RegisteredImageView } from '../../src/shared/images.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;

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
  assert.equal(digestReference('docker.io/kongyo2/cc-workbench', DIGEST), `kongyo2/cc-workbench@${DIGEST}`);
  assert.equal(
    imageTargetKey('kongyo2/cc-workbench', DIGEST, 'web-2026.09.1', 'linux/amd64'),
    `docker.io/kongyo2/cc-workbench|${DIGEST}|linux/amd64`,
  );
  assert.equal(
    imageTargetKey('kongyo2/cc-workbench', null, 'web-2026.09.1', 'linux/arm64'),
    'docker.io/kongyo2/cc-workbench|tag:web-2026.09.1|linux/arm64',
  );
  assert.equal(registrationIdentity(DIGEST, 'ignored'), DIGEST);
  assert.equal(registrationIdentity(null, null), 'tag:latest');
  assert.equal(
    pullCommand('docker.io/kongyo2/cc-workbench', null, 'web-2026.09.1', 'linux/amd64'),
    'docker pull --platform linux/amd64 kongyo2/cc-workbench:web-2026.09.1',
  );
  assert.equal(
    pullCommand('docker.io/kongyo2/cc-workbench', DIGEST, 'web-2026.09.1', 'linux/arm64'),
    `docker pull --platform linux/arm64 kongyo2/cc-workbench@${DIGEST}`,
  );
  assert.equal(imageReference('ghcr.io/org/name', null, null), 'ghcr.io/org/name:latest');
  assert.equal(imageReference('docker.io/library/ubuntu', DIGEST, 'noble'), `ubuntu@${DIGEST}`);
});

test('image references are parsed the way docker pull reads them', () => {
  assert.deepEqual(parseImageReference('ubuntu'), {
    repository: 'docker.io/library/ubuntu',
    tag: 'latest',
    digest: null,
  });
  assert.deepEqual(parseImageReference('  Owner/Image:v1.2  '), {
    repository: 'docker.io/owner/image',
    tag: 'v1.2',
    digest: null,
  });
  assert.deepEqual(parseImageReference('ghcr.io/owner/image:tag'), {
    repository: 'ghcr.io/owner/image',
    tag: 'tag',
    digest: null,
  });
  assert.deepEqual(parseImageReference('localhost:5000/cc/base:dev'), {
    repository: 'localhost:5000/cc/base',
    tag: 'dev',
    digest: null,
  });
  assert.deepEqual(parseImageReference(`owner/image@${DIGEST}`), {
    repository: 'docker.io/owner/image',
    tag: null,
    digest: DIGEST,
  });
  assert.deepEqual(parseImageReference(`owner/image:v1@${DIGEST}`), {
    repository: 'docker.io/owner/image',
    tag: 'v1',
    digest: DIGEST,
  });
  assert.deepEqual(parseImageReference('my-image:dev'), {
    repository: 'docker.io/library/my-image',
    tag: 'dev',
    digest: null,
  });
  assert.deepEqual(parseImageReference('a__b/c.d-e'), {
    repository: 'docker.io/a__b/c.d-e',
    tag: 'latest',
    digest: null,
  });
  assert.deepEqual(parseImageReference('[::1]:5000/team/image:dev'), {
    repository: '[::1]:5000/team/image',
    tag: 'dev',
    digest: null,
  });
  assert.deepEqual(parseImageReference('[fe80::1%25eth0]:5000/team/image'), null);
  assert.deepEqual(parseImageReference('[2001:db8::10]/team/image'), {
    repository: '[2001:db8::10]/team/image',
    tag: 'latest',
    digest: null,
  });
});

test('what docker pull would refuse is refused too', () => {
  for (const bad of [
    '',
    '   ',
    'not a ref',
    'owner/image:',
    'owner/image:tag with space',
    'owner/image@sha256:short',
    'owner/image@md5:abc',
    'owner//image',
    '/owner/image',
    'owner/image/',
    'owner/-image',
    'owner/image-',
    'ghcr.io',
    'ghcr.io/',
    'owner/image:-tag',
    `owner/image:${'x'.repeat(129)}`,
  ]) {
    assert.equal(parseImageReference(bad), null, `${JSON.stringify(bad)} should be refused`);
    assert.notEqual(imageReferenceProblem(bad, 'en'), null);
  }
  assert.equal(imageReferenceProblem('owner/image', 'ja'), null);
});

test('display names carry the release only when there is one', () => {
  assert.equal(
    imageDisplayName({ title: { ja: 'Web 開発', en: 'Web' }, release: '2026.09.1' }, 'en'),
    'Web / 2026.09.1',
  );
  assert.equal(imageDisplayName({ title: { ja: 'x', en: 'ghcr.io/o/i:t' }, release: null }, 'en'), 'ghcr.io/o/i:t');
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
      title: { ja: 'Web / 2026.09.1', en: 'Web / 2026.09.1' },
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
  assert.equal(operationProgress(operation({ phase: 'registering', downloadedBytes: 200, totalBytes: 200 })), null);
  assert.equal(operationProgress(operation({ phase: 'succeeded' })), 1);
  assert.equal(operationProgress(operation({ downloadedBytes: 900, totalBytes: 200 })), 1);
});

function view(id: string, variant: 'web' | 'base' | null, ready: boolean): RegisteredImageView {
  return {
    image: {
      id,
      catalogEntryId: variant === null ? null : `${variant}@2026.09.1`,
      variant,
      release: variant === null ? null : '2026.09.1',
      title: { ja: variant ?? 'custom', en: variant ?? 'custom' },
      repository: 'docker.io/kongyo2/cc-workbench',
      tag: variant === null ? 'dev' : `${variant}-2026.09.1`,
      pinnedDigest: variant === null ? null : `sha256:${'b'.repeat(64)}`,
      platform: 'linux/amd64',
      tools: [],
      registeredAt: '2026-09-11T00:00:00.000Z',
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
  assert.equal(preferredRegisteredImage([view('a', null, true), view('b', 'web', false)])?.image.id, 'a');
  assert.equal(preferredRegisteredImage([view('a', 'base', false)])?.image.id, 'a');
  assert.equal(preferredRegisteredImage([]), null);
});
