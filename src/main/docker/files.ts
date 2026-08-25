import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import * as tarFs from 'tar-fs';
import * as tarStream from 'tar-stream';

import { CONTAINER_GID, CONTAINER_UID, CONTAINER_WORKSPACE } from '../../shared/presets.ts';
import type { FileEntry, FileKind } from '../../shared/types.ts';
import { logInfo, logWarn } from '../logger.ts';
import { containerHandle, execCapture } from './container.ts';

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

  let parsed: readonly RawEntry[];
  try {
    parsed = JSON.parse(result.stdout) as readonly RawEntry[];
  } catch {
    throw new Error(describeListFailure(path, 'EUNKNOWN'));
  }
  if (!Array.isArray(parsed)) throw new Error(describeListFailure(path, 'EUNKNOWN'));

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

export async function readFileRaw(path: string, limitBytes: number = Number.POSITIVE_INFINITY): Promise<Buffer> {
  const archive = await containerHandle().getArchive({ path });
  const extract = tarStream.extract();
  const chunks: Buffer[] = [];
  let total = 0;
  let kind: string | null = null;
  let oversize = false;

  extract.on('entry', (header, stream, next) => {
    kind ??= header.type ?? null;
    const declared = typeof header.size === 'number' ? header.size : 0;
    if (header.type !== 'file' || declared > limitBytes) {
      if (header.type === 'file') oversize = true;
      stream.resume();
    } else {
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > limitBytes) {
          oversize = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
    }
    stream.on('error', () => undefined);
    stream.on('end', next);
  });

  await pipeline(archive, extract);

  if (kind !== null && kind !== 'file') throw new Error(`FILE_NOT_REGULAR:${kind}`);
  if (oversize) throw new Error('FILE_TOO_LARGE');
  return Buffer.concat(chunks);
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export async function readFileText(path: string): Promise<string> {
  const raw = await readFileRaw(path, MAX_TEXT_BYTES);
  if (raw.includes(0)) throw new Error('FILE_BINARY');
  return raw.toString('utf8');
}

async function currentMode(path: string): Promise<number | null> {
  const result = await execCapture(['stat', '-c', '%a', path], { workdir: '/' });
  if (result.exitCode !== 0) return null;
  const parsed = Number.parseInt(result.stdout.trim(), 8);
  return Number.isFinite(parsed) ? parsed : null;
}

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

function representableOnWindows(name: string): boolean {
  const base = name.split('/').pop() ?? name;
  for (const char of base) {
    if ('<>:"|?*'.includes(char)) return false;
    const code = char.codePointAt(0) ?? 0;
    if (code < 32) return false;
  }
  return base !== '' && !base.endsWith('.') && !base.endsWith(' ');
}

function escapes(root: string, name: string, header: { type?: string; linkname?: string | null }): boolean {
  const link = header.linkname ?? '';
  if (link === '') return true;
  const target = header.type === 'link' ? resolve(root, link.replace(/^\/+/u, '')) : resolve(dirname(name), link);
  return target !== root && !target.startsWith(root + sep);
}

export interface ExportResult {
  readonly path: string;
  readonly files: number;
  readonly skipped: readonly string[];
}

export async function exportWorkspace(destinationRoot: string): Promise<ExportResult> {
  if (!existsSync(destinationRoot)) mkdirSync(destinationRoot, { recursive: true });

  let finalDir = join(destinationRoot, `workspace_${timestamp()}`);
  for (let suffix = 2; existsSync(finalDir); suffix += 1) {
    finalDir = join(destinationRoot, `workspace_${timestamp()}_${suffix}`);
  }
  const scratchDir = `${finalDir}.partial`;
  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });

  const onWindows = process.platform === 'win32';
  const skipped: string[] = [];
  let files = 0;

  const archive = await containerHandle().getArchive({ path: CONTAINER_WORKSPACE });
  try {
    await pipeline(
      archive,
      tarFs.extract(scratchDir, {
        strip: 1,
        strict: false,
        map: (header) => {
          if (header.type === 'file') files += 1;
          else if (header.type !== 'directory' && header.type !== 'symlink' && header.type !== 'link') {
            skipped.push(header.name);
          }
          return header;
        },
        ignore: (name, header) => {
          if (header === undefined) return false;
          if (header.type === 'symlink' || header.type === 'link') {
            if (onWindows || escapes(scratchDir, name, header)) {
              skipped.push(header.name);
              return true;
            }
            return false;
          }
          if (onWindows && !representableOnWindows(header.name)) {
            skipped.push(header.name);
            return true;
          }
          return false;
        },
      }),
    );
    renameSync(scratchDir, finalDir);
  } catch (error) {
    rmSync(scratchDir, { recursive: true, force: true });
    throw error;
  }

  logInfo('app', `ワークスペースを取り出しました / workspace exported to ${finalDir} (${files} files)`);
  for (const name of skipped.slice(0, 20)) {
    logWarn('app', `取り出せませんでした / could not be exported: ${name}`);
  }
  if (skipped.length > 20) {
    logWarn('app', `ほか ${skipped.length - 20} 件 / and ${skipped.length - 20} more`);
  }
  return { path: finalDir, files, skipped };
}
