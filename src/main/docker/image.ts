/**
 * Building the workbench image from user-editable sources.
 *
 * The `Dockerfile` and `post-create.sh` shipped with the app are copied into
 * `userData/docker` on first run and never touched again, so edits survive an
 * app upgrade. "Restore defaults" is the one path that copies over them.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ImageSources } from '../../shared/types.ts';
import { describeError, logError, logInfo } from '../logger.ts';
import { bundledDockerDir, dockerfilePath, postCreatePath, userDockerDir } from '../paths.ts';
import { docker } from './engine.ts';

const SOURCE_FILES = ['Dockerfile', 'post-create.sh'] as const;

/** Copies the bundled sources into `userData/docker` for any file that is missing. */
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

export function readImageSources(): ImageSources {
  ensureImageSources();
  return {
    dockerfile: existsSync(dockerfilePath()) ? readFileSync(dockerfilePath(), 'utf8') : '',
    postCreate: existsSync(postCreatePath()) ? readFileSync(postCreatePath(), 'utf8') : '',
    dir: userDockerDir(),
  };
}

export function writeImageSources(sources: Pick<ImageSources, 'dockerfile' | 'postCreate'>): ImageSources {
  // Both files are consumed by Linux tooling: CRLF makes bash choke on a `\r`
  // at the end of every line, and breaks `RUN` line continuations in a
  // Dockerfile. A Windows editor is the likely author, so normalize on the way
  // out rather than hoping.
  writeFileSync(dockerfilePath(), sources.dockerfile.replaceAll('\r\n', '\n'), 'utf8');
  writeFileSync(postCreatePath(), sources.postCreate.replaceAll('\r\n', '\n'), 'utf8');
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

/**
 * Builds `tag` from the user's sources, streaming Docker's output into the log pane.
 *
 * The whole `userData/docker` directory is the build context, not just the two
 * files the app ships. The Image tab hands out that folder and invites edits, so
 * a `COPY my-thing /` added to the Dockerfile has to be able to find
 * `my-thing` — with a fixed file list it would fail with "not found in build
 * context" on a Dockerfile that looks perfectly correct.
 */
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
        // followProgress reports transport errors only; a failed build step shows
        // up as an `error` field on one of the events instead.
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
