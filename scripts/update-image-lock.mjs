#!/usr/bin/env node
/* oxlint-disable no-await-in-loop -- one upstream request at a time keeps the rate polite */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOCK_FILE, ROOT, parseArgs } from './lib/catalog-build.mjs';

const DOCKERFILE = join(ROOT, 'docker', 'Dockerfile');
const BASE_REF_LINE = /^ARG UBUNTU_REF=(\S+)$/mu;

const NODE_LINE = 24;
const RUBY_LINE = '4.0';
const PYTHON_PACKAGES = ['uv', 'poetry', 'pytest', 'ruff', 'mypy', 'black', 'conan'];
const NPM_GLOBALS = ['pnpm', 'yarn', 'typescript', 'eslint', 'prettier'];
const PLATFORMS = ['linux/amd64', 'linux/arm64'];

const { options } = parseArgs(process.argv.slice(2));
const current = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));

async function text(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function json(url) {
  return JSON.parse(await text(url));
}

function sha256Of(listing, fileName) {
  for (const line of listing.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match !== null && match[2] === fileName) return match[1];
  }
  throw new Error(`no sha256 for ${fileName}`);
}

async function ubuntu() {
  const body = await json('https://hub.docker.com/v2/namespaces/library/repositories/ubuntu/tags/24.04');
  const platforms = {};
  for (const image of body.images) {
    const platform = `${image.os}/${image.architecture}${image.variant ? `/${image.variant}` : ''}`;
    if (platform === 'linux/amd64') platforms['linux/amd64'] = image.digest;
    if (platform === 'linux/arm64/v8' || platform === 'linux/arm64') platforms['linux/arm64'] = image.digest;
  }
  return { image: 'docker.io/library/ubuntu', tag: '24.04', indexDigest: body.digest, platforms };
}

async function node() {
  const index = await json('https://nodejs.org/dist/index.json');
  const release = index.find((entry) => entry.version.startsWith(`v${NODE_LINE}.`) && entry.lts !== false);
  if (release === undefined) throw new Error(`no LTS release found for Node ${NODE_LINE}`);
  const version = release.version.slice(1);
  const sums = await text(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`);
  const archives = {};
  for (const [platform, arch] of [
    ['linux/amd64', 'x64'],
    ['linux/arm64', 'arm64'],
  ]) {
    const file = `node-v${version}-linux-${arch}.tar.xz`;
    archives[platform] = { url: `https://nodejs.org/dist/v${version}/${file}`, sha256: sha256Of(sums, file) };
  }
  return { version, npm: release.npm, archives };
}

async function npmLatest(name) {
  const body = await json(`https://registry.npmjs.org/${name}/latest`);
  return body;
}

async function claudeCode() {
  const body = await npmLatest('@anthropic-ai/claude-code');
  return { package: '@anthropic-ai/claude-code', version: body.version, integrity: body.dist.integrity };
}

async function npmGlobals() {
  const out = {};
  for (const name of NPM_GLOBALS) out[name] = (await npmLatest(name)).version;
  return out;
}

async function bun() {
  const version = (await npmLatest('bun')).version;
  const sums = await text(`https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt`);
  const archives = {};
  for (const [platform, arch] of [
    ['linux/amd64', 'x64'],
    ['linux/arm64', 'aarch64'],
  ]) {
    const file = `bun-linux-${arch}.zip`;
    archives[platform] = {
      url: `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${file}`,
      sha256: sha256Of(sums, file),
    };
  }
  return { version, archives };
}

async function yq() {
  const body = await json(
    'https://hub.docker.com/v2/namespaces/mikefarah/repositories/yq/tags?page_size=50&ordering=last_updated',
  );
  const versions = body.results
    .map((tag) => tag.name)
    .filter((name) => /^\d+\.\d+\.\d+$/u.test(name))
    .sort((left, right) => {
      const a = left.split('.').map(Number);
      const b = right.split('.').map(Number);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    });
  const version = versions.at(-1);
  if (version === undefined) throw new Error('no yq version found');
  const bsd = await text(`https://github.com/mikefarah/yq/releases/download/v${version}/checksums-bsd`);
  const binaries = {};
  for (const [platform, arch] of [
    ['linux/amd64', 'amd64'],
    ['linux/arm64', 'arm64'],
  ]) {
    const file = `yq_linux_${arch}`;
    const match = new RegExp(`^SHA256 \\(${file}\\) = ([0-9a-f]{64})$`, 'mu').exec(bsd);
    if (match === null) throw new Error(`no sha256 for ${file}`);
    binaries[platform] = {
      url: `https://github.com/mikefarah/yq/releases/download/v${version}/${file}`,
      sha256: match[1],
    };
  }
  return { version, binaries };
}

async function python() {
  const packages = {};
  for (const name of PYTHON_PACKAGES) packages[name] = (await json(`https://pypi.org/pypi/${name}/json`)).info.version;
  return { packages };
}

async function go() {
  const releases = await json('https://go.dev/dl/?mode=json');
  const release = releases.find((entry) => entry.stable === true);
  if (release === undefined) throw new Error('no stable Go release found');
  const version = release.version.slice(2);
  const archives = {};
  for (const platform of PLATFORMS) {
    const arch = platform.split('/')[1];
    const file = release.files.find((entry) => entry.os === 'linux' && entry.arch === arch && entry.kind === 'archive');
    if (file === undefined) throw new Error(`no Go archive for ${platform}`);
    archives[platform] = { url: `https://go.dev/dl/${file.filename}`, sha256: file.sha256 };
  }
  return { version, archives };
}

async function rust() {
  const channel = await text('https://static.rust-lang.org/dist/channel-rust-stable.toml');
  const toolchain = /\[pkg\.rust\]\s*\n\s*version\s*=\s*"([0-9.]+)/u.exec(channel)?.[1];
  if (toolchain === undefined) throw new Error('no rust toolchain version found');
  const rustupVersion = /^version\s*=\s*['"]([0-9.]+)['"]/mu.exec(
    await text('https://static.rust-lang.org/rustup/release-stable.toml'),
  )?.[1];
  if (rustupVersion === undefined) throw new Error('no rustup version found');
  const binaries = {};
  for (const [platform, triple] of [
    ['linux/amd64', 'x86_64-unknown-linux-gnu'],
    ['linux/arm64', 'aarch64-unknown-linux-gnu'],
  ]) {
    const url = `https://static.rust-lang.org/rustup/archive/${rustupVersion}/${triple}/rustup-init`;
    const sha = /^([0-9a-f]{64})/u.exec((await text(`${url}.sha256`)).trim())?.[1];
    if (sha === undefined) throw new Error(`no sha256 for rustup-init ${triple}`);
    binaries[platform] = { url, sha256: sha };
  }
  return { toolchain, rustup: { version: rustupVersion, binaries } };
}

async function gradle() {
  const body = await json('https://services.gradle.org/versions/current');
  return { version: body.version, url: body.downloadUrl, sha256: body.checksum };
}

async function ruby() {
  const index = await text('https://cache.ruby-lang.org/pub/ruby/index.txt');
  const rows = index
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((row) => row[0]?.startsWith(`ruby-${RUBY_LINE}.`) && row[1]?.endsWith('.tar.xz'));
  const latest = rows.at(-1);
  if (latest === undefined) throw new Error(`no ruby ${RUBY_LINE} release found`);
  return { version: latest[0].slice('ruby-'.length), url: latest[1], sha256: latest[3] };
}

const next = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  base: await ubuntu(),
  node: await node(),
  claudeCode: await claudeCode(),
  yq: await yq(),
  npmGlobals: await npmGlobals(),
  bun: await bun(),
  python: await python(),
  go: await go(),
  rust: await rust(),
  gradle: await gradle(),
  ruby: await ruby(),
  apt: current.apt,
};

function flatten(value, prefix = '') {
  const out = {};
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value))
      Object.assign(out, flatten(child, prefix === '' ? key : `${prefix}.${key}`));
  } else {
    out[prefix] = value;
  }
  return out;
}

const before = flatten(current);
const after = flatten(next);
const changes = Object.keys(after)
  .filter((key) => key !== 'updatedAt' && before[key] !== after[key])
  .map((key) => `${key}: ${before[key] ?? '(none)'} → ${after[key]}`);

const dockerfile = readFileSync(DOCKERFILE, 'utf8');
const baseRefMatch = BASE_REF_LINE.exec(dockerfile);
if (baseRefMatch === null) throw new Error(`${DOCKERFILE} has no "ARG UBUNTU_REF=" line`);
const currentBaseRef = baseRefMatch[1];
const wantedBaseRef = `${next.base.image}@${next.base.indexDigest}`;
if (currentBaseRef !== wantedBaseRef) changes.push(`Dockerfile UBUNTU_REF: ${currentBaseRef} → ${wantedBaseRef}`);

if (options.check === true) {
  if (changes.length === 0) {
    console.log('lock is current');
    process.exit(0);
  }
  console.log(`${changes.length} change(s) available:`);
  for (const change of changes) console.log(`  ${change}`);
  process.exit(1);
}

writeFileSync(LOCK_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
if (currentBaseRef !== wantedBaseRef) {
  writeFileSync(DOCKERFILE, dockerfile.replace(BASE_REF_LINE, `ARG UBUNTU_REF=${wantedBaseRef}`), 'utf8');
}
console.log(`wrote ${LOCK_FILE} (${changes.length} change(s))`);
for (const change of changes) console.log(`  ${change}`);
