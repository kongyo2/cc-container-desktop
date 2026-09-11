import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import * as tarFs from 'tar-fs';
import * as tarStream from 'tar-stream';

import { CONTAINER_GID, CONTAINER_UID, CONTAINER_WORKSPACE } from '../../shared/presets.ts';
import type { ExportSummary, ImportSummary } from '../../shared/types.ts';
import { logInfo, logWarn } from '../logger.ts';
import { isInside } from '../paths.ts';
import { containerHandle, execCapture } from './container.ts';
import type { ContainerRef } from './container.ts';

export async function readFileRaw(
  ref: ContainerRef,
  path: string,
  limitBytes: number = Number.POSITIVE_INFINITY,
): Promise<Buffer> {
  const archive = await containerHandle(ref).getArchive({ path });
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

async function currentMode(ref: ContainerRef, path: string): Promise<number | null> {
  const result = await execCapture(ref, ['stat', '-c', '%a', path], { workdir: '/' });
  if (result.exitCode !== 0) return null;
  const parsed = Number.parseInt(result.stdout.trim(), 8);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function writeFileText(ref: ContainerRef, path: string, content: string, mode?: number): Promise<void> {
  const slash = path.lastIndexOf('/');
  const dir = slash <= 0 ? '/' : path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (name === '') throw new Error(`invalid path: ${path}`);

  const effectiveMode = mode ?? (await currentMode(ref, path)) ?? 0o644;

  const pack = tarStream.pack();
  pack.entry({ name, mode: effectiveMode, uid: CONTAINER_UID, gid: CONTAINER_GID, mtime: new Date() }, content);
  pack.finalize();

  await containerHandle(ref).putArchive(pack, { path: dir });
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
  for (const segment of name.split('/')) {
    if (segment === '') continue;
    for (const char of segment) {
      if ('<>:"|?*'.includes(char)) return false;
      if ((char.codePointAt(0) ?? 0) < 32) return false;
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) return false;
  }
  return name !== '';
}

function escapes(root: string, name: string, header: { type?: string; linkname?: string | null }): boolean {
  const link = header.linkname ?? '';
  if (link === '') return true;
  const target = header.type === 'link' ? resolve(root, link.replace(/^\/+/u, '')) : resolve(dirname(name), link);
  return !isInside(root, target);
}

export async function exportWorkspace(
  ref: ContainerRef,
  destinationRoot: string,
  folderBase: string,
): Promise<ExportSummary> {
  if (!existsSync(destinationRoot)) mkdirSync(destinationRoot, { recursive: true });

  let finalDir = join(destinationRoot, `${folderBase}_${timestamp()}`);
  for (let suffix = 2; existsSync(finalDir); suffix += 1) {
    finalDir = join(destinationRoot, `${folderBase}_${timestamp()}_${suffix}`);
  }
  const scratchDir = `${finalDir}.${randomUUID().slice(0, 8)}.partial`;
  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });

  const onWindows = process.platform === 'win32';
  const skipped: string[] = [];
  let files = 0;

  const archive = await containerHandle(ref).getArchive({ path: CONTAINER_WORKSPACE });
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

function importName(source: string): string {
  const name = basename(source);
  if (name === '' || name === '.' || name === '..' || name.includes('/')) {
    throw new Error(`取り込めないパスです / cannot import this path: ${source}`);
  }
  return name;
}

async function importDirectory(ref: ContainerRef, source: string, name: string): Promise<number> {
  let entries = 0;
  const pack = tarFs.pack(source, {
    map: (header) => {
      entries += 1;
      header.name = header.name === '.' ? name : `${name}/${header.name}`;
      header.uid = CONTAINER_UID;
      header.gid = CONTAINER_GID;
      return header;
    },
  });
  await containerHandle(ref).putArchive(pack, { path: CONTAINER_WORKSPACE });
  return entries;
}

async function importFile(ref: ContainerRef, source: string, name: string, size: number, mode: number): Promise<void> {
  const pack = tarStream.pack();
  const upload = containerHandle(ref).putArchive(pack, { path: CONTAINER_WORKSPACE });
  try {
    const entry = pack.entry({ name, size, mode, uid: CONTAINER_UID, gid: CONTAINER_GID, mtime: new Date() });
    await pipeline(createReadStream(source), entry);
    pack.finalize();
  } catch (error) {
    pack.destroy(error instanceof Error ? error : new Error(String(error)));
    upload.catch(() => undefined);
    throw error;
  }
  await upload;
}

export async function importIntoWorkspace(ref: ContainerRef, paths: readonly string[]): Promise<ImportSummary> {
  const sources: string[] = [];
  let entries = 0;

  /* oxlint-disable no-await-in-loop -- one archive at a time keeps the memory bounded */
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(`取り込むパスが不正です / not a usable path: ${JSON.stringify(raw)}`);
    }
    const source = resolve(raw);
    const name = importName(source);
    let target = source;
    let stats;
    try {
      stats = lstatSync(source);
      if (stats.isSymbolicLink()) {
        target = realpathSync(source);
        stats = statSync(target);
        logInfo('app', `リンク先を取り込みます / following the link ${source} → ${target}`);
      }
    } catch {
      throw new Error(`見つかりません / not found: ${source}`);
    }
    if (stats.isDirectory()) {
      entries += await importDirectory(ref, target, name);
    } else if (stats.isFile()) {
      await importFile(ref, target, name, stats.size, stats.mode & 0o777);
      entries += 1;
    } else {
      throw new Error(`ファイルかフォルダだけ取り込めます / only files and folders can be imported: ${source}`);
    }
    sources.push(source);
    logInfo('app', `取り込みました / imported into the workspace: ${source}`);
  }
  /* oxlint-enable no-await-in-loop */

  return { entries, sources };
}
