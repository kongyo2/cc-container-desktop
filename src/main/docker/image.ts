import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ImageSources } from '../../shared/types.ts';
import { describeError, logError, logInfo } from '../logger.ts';
import { bundledDockerDir, dockerfilePath, postCreatePath, setupPath, userDockerDir } from '../paths.ts';
import { docker } from './engine.ts';

const SOURCE_FILES = ['Dockerfile', 'setup.sh', 'post-create.sh'] as const;

export function ensureImageSources(force = false): void {
  const from = bundledDockerDir();
  const to = userDockerDir();
  for (const name of SOURCE_FILES) {
    const target = join(to, name);
    if (!force && existsSync(target)) continue;
    const source = join(from, name);
    if (!existsSync(source)) {
      logError('app', `既定の ${name} が見つかりません / bundled ${name} is missing at ${source}`);
      continue;
    }
    copyFileSync(source, target);
  }
}

function readTextOr(path: string, fallback: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : fallback;
}

export function readImageSources(): ImageSources {
  ensureImageSources();
  return {
    dockerfile: readTextOr(dockerfilePath(), ''),
    setup: readTextOr(setupPath(), ''),
    postCreate: readTextOr(postCreatePath(), ''),
    dir: userDockerDir(),
  };
}

export function writeImageSources(
  sources: Partial<Pick<ImageSources, 'dockerfile' | 'setup' | 'postCreate'>>,
): ImageSources {
  const current = readImageSources();

  const normalize = (next: string | undefined, fallback: string): string =>
    (typeof next === 'string' ? next : fallback).replaceAll('\r\n', '\n');

  writeFileSync(dockerfilePath(), normalize(sources.dockerfile, current.dockerfile), 'utf8');
  writeFileSync(setupPath(), normalize(sources.setup, current.setup), 'utf8');
  writeFileSync(postCreatePath(), normalize(sources.postCreate, current.postCreate), 'utf8');
  return readImageSources();
}

export function resetImageSources(): ImageSources {
  ensureImageSources(true);
  return readImageSources();
}

interface BuildProgress {
  readonly stream?: unknown;
  readonly status?: unknown;
  readonly error?: unknown;
  readonly errorDetail?: { readonly message?: unknown };
}

function progressText(event: BuildProgress): string | null {
  if (typeof event.stream === 'string') {
    const trimmed = event.stream.replace(/\s+$/u, '');
    return trimmed === '' ? null : trimmed;
  }
  if (typeof event.status === 'string') return event.status;
  return null;
}

export async function buildImage(tag: string, noCache: boolean): Promise<void> {
  ensureImageSources();
  const context = userDockerDir();
  const src = readdirSync(context);
  logInfo(
    'build',
    `イメージをビルドします / building image: ${tag}${noCache ? ' (--no-cache)' : ''} — context: ${src.length} entries`,
  );

  const stream = await docker().buildImage(
    { context, src },
    { t: tag, nocache: noCache, pull: noCache, dockerfile: 'Dockerfile' },
  );

  await new Promise<void>((resolve, reject) => {
    docker().modem.followProgress(
      stream,
      (error: Error | null, output: unknown[]) => {
        if (error !== null) {
          reject(new Error(describeError(error)));
          return;
        }
        for (const raw of output) {
          const event = raw as BuildProgress;
          if (event.error !== undefined) {
            const detail = event.errorDetail?.message;
            reject(new Error(typeof detail === 'string' ? detail : String(event.error)));
            return;
          }
        }
        logInfo('build', `ビルド完了 / build finished: ${tag}`);
        resolve();
      },
      (raw: unknown) => {
        const event = raw as BuildProgress;
        const text = progressText(event);
        if (text !== null) logInfo('build', text);
      },
    );
  });
}
