// A local registry with two releases of the base image, and a catalog file
// that points the app at it (CC_IMAGE_CATALOG_FILE, honoured in development
// builds only). Everything the suites need to exercise "download and
// register" without touching Docker Hub.
//
//   CC_E2E_BASE_IMAGE   an already-built base image to reuse instead of building one
//   CC_E2E_REGISTRY_PORT  host port of the registry (default 5055)
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const REGISTRY_CONTAINER = 'cc-e2e-registry';
export const REGISTRY_PORT = Number.parseInt(process.env['CC_E2E_REGISTRY_PORT'] ?? '5055', 10);
export const REGISTRY_HOST = `127.0.0.1:${REGISTRY_PORT}`;
export const REGISTRY_REPOSITORY = `${REGISTRY_HOST}/cc-e2e/cc-workbench`;
export const RELEASE_ONE = '2026.09.1';
export const RELEASE_TWO = '2026.09.2';

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function dockerOk(args) {
  return spawnSync('docker', args, { stdio: 'ignore' }).status === 0;
}

function daemonPlatform() {
  const [os, arch] = docker(['info', '--format', '{{.OSType}} {{.Architecture}}']).split(' ');
  const normalized = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' }[arch] ?? null;
  if (os !== 'linux' || normalized === null) throw new Error(`unsupported daemon platform ${os}/${arch}`);
  return `linux/${normalized}`;
}

function ensureRegistry() {
  const state = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', REGISTRY_CONTAINER], {
    encoding: 'utf8',
  });
  if (state.status === 0 && state.stdout.trim() === 'true') return;
  if (state.status === 0) {
    docker(['rm', '-f', REGISTRY_CONTAINER]);
  }
  docker([
    'run',
    '-d',
    '--restart',
    'unless-stopped',
    '--name',
    REGISTRY_CONTAINER,
    '-p',
    `${REGISTRY_HOST}:5000`,
    'registry:2',
  ]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const probe = spawnSync('curl', ['-fsS', `http://${REGISTRY_HOST}/v2/`], { stdio: 'ignore' });
    if (probe.status === 0) return;
    spawnSync('sleep', ['0.5']);
  }
  throw new Error('the local registry did not come up');
}

function buildBase(tag) {
  const reuse = process.env['CC_E2E_BASE_IMAGE'];
  if (reuse !== undefined && reuse !== '' && dockerOk(['image', 'inspect', reuse])) {
    docker(['tag', reuse, tag]);
    return;
  }
  const args = [
    'buildx',
    'bake',
    '-f',
    'docker/docker-bake.hcl',
    'base',
    '--set',
    `base.tags=${tag}`,
    '--set',
    `base.args.IMAGE_RELEASE=${RELEASE_ONE}`,
  ];
  const secret = process.env['CC_E2E_BUILD_CA_BUNDLE'];
  if (secret !== undefined && secret !== '') args.push('--set', `base.secrets=id=build-ca-bundle,src=${secret}`);
  execFileSync('docker', args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, RELEASE: RELEASE_ONE, REVISION: 'e2e', BUILT_AT: '2026-09-11T00:00:00Z' },
  });
}

function deriveReleaseTwo(fromTag, toTag) {
  const dockerfile = [
    `FROM ${fromTag}`,
    'USER root',
    `RUN sed -i 's/"release": "${RELEASE_ONE}"/"release": "${RELEASE_TWO}"/' /opt/cc/image-info.json && echo "release two" > /opt/cc/e2e-release-two`,
    `LABEL com.cc-container-desktop.image.release="${RELEASE_TWO}" org.opencontainers.image.version="${RELEASE_TWO}"`,
    'USER claude',
    'WORKDIR /home/claude/workspace',
    'CMD ["sleep", "infinity"]',
    '',
  ].join('\n');
  execFileSync('docker', ['build', '-t', toTag, '-'], { input: dockerfile, stdio: ['pipe', 'ignore', 'inherit'] });
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** The platform manifest digest a tag resolves to, read from the registry itself (an index is unwrapped). */
function platformDigestOf(tag, platform) {
  const [name, reference] = tag.slice(REGISTRY_HOST.length + 1).split(':');
  const body = execFileSync(
    'curl',
    ['-fsS', '-H', `Accept: ${MANIFEST_ACCEPT}`, `http://${REGISTRY_HOST}/v2/${name}/manifests/${reference}`],
    { encoding: 'buffer' },
  );
  const parsed = JSON.parse(body.toString('utf8'));
  if (Array.isArray(parsed.manifests)) {
    const [os, arch] = platform.split('/');
    const match = parsed.manifests.find((entry) => entry.platform?.os === os && entry.platform?.architecture === arch);
    if (match === undefined) throw new Error(`no ${platform} manifest in the index of ${tag}`);
    return match.digest;
  }
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function pushAndForget(tag, platform) {
  docker(['push', tag]);
  const digest = platformDigestOf(tag, platform);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new Error(`unexpected digest for ${tag}: ${digest}`);
  // Drop the registry-side references so the app really has to pull them.
  docker(['image', 'rm', tag]);
  spawnSync('docker', ['image', 'rm', `${REGISTRY_REPOSITORY}@${digest}`], { stdio: 'ignore' });
  return digest;
}

function catalogEntry(release, digest, platform, recommended) {
  return {
    id: `base@${release}`,
    variant: 'base',
    release,
    title: { ja: 'Base (e2e)', en: 'Base (e2e)' },
    summary: { ja: 'E2E 用の Base イメージ', en: 'Base image for the e2e suite' },
    description: {
      ja: 'ローカルレジストリから取得する検証用イメージ',
      en: 'A verification image served from a local registry',
    },
    recommended,
    inherits: null,
    repository: REGISTRY_REPOSITORY,
    tag: `base-${release}`,
    indexDigest: null,
    platforms: [{ platform, manifestDigest: digest, compressedLayerBytes: null }],
    runtimeContract: 1,
    sourceRevision: null,
    publishedAt: '2026-09-11T00:00:00.000Z',
    tools: [
      { id: 'node', name: 'Node.js', version: '', highlight: true },
      { id: 'claude-code', name: 'Claude Code', version: '', highlight: true },
    ],
  };
}

let cached = null;

/** Builds (or reuses), pushes and forgets the two releases, then writes the catalog. Idempotent per process. */
export function ensureTestImages() {
  if (cached !== null) return cached;
  const platform = daemonPlatform();
  ensureRegistry();

  const localOne = `cc-workbench-e2e:base-${RELEASE_ONE}`;
  const localTwo = `cc-workbench-e2e:base-${RELEASE_TWO}`;
  if (!dockerOk(['image', 'inspect', localOne])) buildBase(localOne);
  if (!dockerOk(['image', 'inspect', localTwo])) deriveReleaseTwo(localOne, localTwo);

  const tagOne = `${REGISTRY_REPOSITORY}:base-${RELEASE_ONE}`;
  const tagTwo = `${REGISTRY_REPOSITORY}:base-${RELEASE_TWO}`;
  docker(['tag', localOne, tagOne]);
  docker(['tag', localTwo, tagTwo]);
  const digestOne = pushAndForget(tagOne, platform);
  const digestTwo = pushAndForget(tagTwo, platform);

  const dir = mkdtempSync(join(tmpdir(), 'cc-e2e-catalog-'));
  mkdirSync(dir, { recursive: true });
  const catalogFile = join(dir, 'imageCatalog.json');
  const catalog = {
    schemaVersion: 1,
    generatedAt: '2026-09-11T00:00:00.000Z',
    repository: REGISTRY_REPOSITORY,
    entries: [
      catalogEntry(RELEASE_ONE, digestOne, platform, true),
      catalogEntry(RELEASE_TWO, digestTwo, platform, false),
    ],
  };
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

  cached = {
    catalogFile,
    platform,
    repository: REGISTRY_REPOSITORY,
    releaseOne: { id: `base@${RELEASE_ONE}`, digest: digestOne, localTag: localOne },
    releaseTwo: { id: `base@${RELEASE_TWO}`, digest: digestTwo, localTag: localTwo },
    /**
     * Deletes the pulled image from the daemon (as `docker image prune -a`
     * would) so the registration reads as "missing". No container may still
     * use it: Docker refuses to delete an image behind a container, so the
     * suite removes its tasks first.
     */
    forgetPulled(digest) {
      const reference = `${REGISTRY_REPOSITORY}@${digest}`;
      const id = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', reference], { encoding: 'utf8' });
      if (id.status !== 0 || id.stdout.trim() === '') return;
      docker(['image', 'rm', '-f', id.stdout.trim()]);
      if (dockerOk(['image', 'inspect', reference])) throw new Error(`${reference} is still present after removal`);
    },
  };
  return cached;
}
