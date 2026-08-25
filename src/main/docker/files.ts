/**
 * Reading and writing files inside the container.
 *
 * Directory listings come from a small Node program executed in the container —
 * `node` is guaranteed by the image, and JSON is the only listing format that
 * survives filenames with spaces, tabs or newlines in them. File contents move
 * through Docker's archive endpoints instead of `cat`, which keeps binary data
 * intact and lets the app set ownership explicitly.
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import * as tarFs from 'tar-fs';
import * as tarStream from 'tar-stream';

import { CONTAINER_GID, CONTAINER_UID, CONTAINER_WORKSPACE } from '../../shared/presets.ts';
import type { FileEntry, FileKind } from '../../shared/types.ts';
import { logInfo } from '../logger.ts';
import { containerHandle, execCapture } from './container.ts';

/**
 * Emits one JSON array describing a directory.
 *
 * Kept as a single line so it can be passed through `node -e` without a heredoc,
 * and written in CommonJS because the image's `node -e` has no ESM context.
 */
const LIST_SCRIPT = `
const fs = require('fs');
const path = require('path');
const dir = process.argv[1];
let names;
try {
  names = fs.readdirSync(dir);
} catch (error) {
  // A bare stack trace is useless in a UI banner. Emit the errno so the caller
  // can turn it into a sentence, and nothing else.
  process.stderr.write(String(error && error.code ? error.code : 'EUNKNOWN'));
  process.exit(1);
}
const out = [];
for (const name of names) {
  const full = path.join(dir, name);
  let st;
  try { st = fs.lstatSync(full); } catch { continue; }
  let kind = 'other';
  if (st.isSymbolicLink()) {
    kind = 'link';
    try { if (fs.statSync(full).isDirectory()) kind = 'dir'; } catch {}
  } else if (st.isDirectory()) kind = 'dir';
  else if (st.isFile()) kind = 'file';
  out.push({
    name,
    path: full,
    kind,
    size: st.size,
    mode: (st.mode & 0o7777).toString(8).padStart(4, '0'),
    modifiedAt: st.mtime.toISOString(),
  });
}
process.stdout.write(JSON.stringify(out));
`;

/** Turns the errno the listing script prints into something worth showing a user. */
function describeListFailure(path: string, code: string): string {
  switch (code) {
    case 'ENOENT':
      return `見つかりません / no such directory: ${path}`;
    case 'ENOTDIR':
      return `フォルダではありません / not a directory: ${path}`;
    case 'EACCES':
    case 'EPERM':
      return `権限がありません / permission denied: ${path}`;
    default:
      return `一覧を取得できません / cannot list ${path} (${code})`;
  }
}

interface RawEntry {
  readonly name?: unknown;
  readonly path?: unknown;
  readonly kind?: unknown;
  readonly size?: unknown;
  readonly mode?: unknown;
  readonly modifiedAt?: unknown;
}

function toFileKind(value: unknown): FileKind {
  return value === 'dir' || value === 'file' || value === 'link' ? value : 'other';
}

export async function listDirectory(path: string): Promise<readonly FileEntry[]> {
  const result = await execCapture(['node', '-e', LIST_SCRIPT, path], { workdir: '/' });
  if (result.exitCode !== 0) {
    throw new Error(describeListFailure(path, result.stderr.trim() || 'EUNKNOWN'));
  }

  const parsed = JSON.parse(result.stdout) as readonly RawEntry[];
  const entries: FileEntry[] = parsed.map((raw) => ({
    name: typeof raw.name === 'string' ? raw.name : '?',
    path: typeof raw.path === 'string' ? raw.path : path,
    kind: toFileKind(raw.kind),
    size: typeof raw.size === 'number' ? raw.size : 0,
    mode: typeof raw.mode === 'string' ? raw.mode : '0000',
    modifiedAt: typeof raw.modifiedAt === 'string' ? raw.modifiedAt : '',
  }));

  return entries.sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1;
    if (a.kind !== 'dir' && b.kind === 'dir') return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** Reads a file out of the container as raw bytes via Docker's archive endpoint. */
export async function readFileRaw(path: string): Promise<Buffer> {
  const archive = await containerHandle().getArchive({ path });
  const extract = tarStream.extract();
  const chunks: Buffer[] = [];

  const done = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      if (header.type === 'file') {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      } else {
        stream.resume();
      }
      stream.on('end', next);
      stream.on('error', reject);
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
  });

  archive.pipe(extract);
  await done;
  return Buffer.concat(chunks);
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Reads a file as text. Throws a translatable marker for binary or oversized content. */
export async function readFileText(path: string): Promise<string> {
  const raw = await readFileRaw(path);
  if (raw.length > MAX_TEXT_BYTES) throw new Error('FILE_TOO_LARGE');
  if (raw.includes(0)) throw new Error('FILE_BINARY');
  return raw.toString('utf8');
}

/** Reads an existing file's permission bits, or `null` when there is no such file. */
async function currentMode(path: string): Promise<number | null> {
  const result = await execCapture(['stat', '-c', '%a', path], { workdir: '/' });
  if (result.exitCode !== 0) return null;
  const parsed = Number.parseInt(result.stdout.trim(), 8);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Writes a file into the container, owned by the `claude` user.
 *
 * Omit `mode` to keep whatever the file already had — a `putArchive` entry sets
 * the mode outright, so a fixed default would silently strip the executable bit
 * off every script edited through the Files tab. New files get 0644.
 */
export async function writeFileText(path: string, content: string, mode?: number): Promise<void> {
  const slash = path.lastIndexOf('/');
  const dir = slash <= 0 ? '/' : path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (name === '') throw new Error(`invalid path: ${path}`);

  const effectiveMode = mode ?? (await currentMode(path)) ?? 0o644;

  const pack = tarStream.pack();
  pack.entry({ name, mode: effectiveMode, uid: CONTAINER_UID, gid: CONTAINER_GID, mtime: new Date() }, content);
  pack.finalize();

  await containerHandle().putArchive(pack, { path: dir });
}

export async function makeDirectory(path: string): Promise<void> {
  const result = await execCapture(['mkdir', '-p', path], { workdir: '/' });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `mkdir failed: ${path}`);
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Copies `/home/claude/workspace` out to the host.
 *
 * Extraction goes to a scratch directory first: a half-written export that shares
 * its name with a finished one is worse than no export at all.
 */
export async function exportWorkspace(destinationRoot: string): Promise<string> {
  if (!existsSync(destinationRoot)) mkdirSync(destinationRoot, { recursive: true });

  const finalDir = join(destinationRoot, `workspace_${timestamp()}`);
  const scratchDir = `${finalDir}.partial`;
  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });

  const archive = await containerHandle().getArchive({ path: CONTAINER_WORKSPACE });
  try {
    // `strip: 1` drops the leading `workspace/` component Docker puts in the tar.
    await pipeline(archive, tarFs.extract(scratchDir, { strip: 1 }));
    renameSync(scratchDir, finalDir);
  } catch (error) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw error;
  }

  logInfo('app', `ワークスペースを取り出しました / workspace exported to ${finalDir}`);
  return finalDir;
}

/** Saves a single container file to a host path — used by the Files tab's download action. */
export async function downloadFile(containerPath: string, hostPath: string): Promise<void> {
  const raw = await readFileRaw(containerPath);
  const out = createWriteStream(hostPath);
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', resolve);
    out.end(raw);
  });
}
