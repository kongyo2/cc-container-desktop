import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { BuildRequest } from '../../shared/ipc.ts';
import { describeError, logInfo } from '../logger.ts';
import { bundledDockerDir } from '../paths.ts';
import { docker } from './engine.ts';

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

function buildContext(): { readonly context: string; readonly src: readonly string[] } {
  const context = bundledDockerDir();
  if (!existsSync(join(context, 'Dockerfile'))) {
    throw new Error(`同梱の Dockerfile が見つかりません / the bundled Dockerfile is missing at ${context}`);
  }
  return { context, src: readdirSync(context) };
}

export async function buildImage(tag: string, request: BuildRequest): Promise<void> {
  const { context, src } = buildContext();
  const mode = request.noCache ? ' (--no-cache)' : request.refreshClaudeCode ? ' (refresh Claude Code)' : '';
  logInfo('build', `イメージをビルドします / building image: ${tag}${mode} — context: ${context}`);

  const buildargs: Record<string, string> = request.refreshClaudeCode
    ? { CLAUDE_CODE_REFRESH: Date.now().toString(36) }
    : {};

  const stream = await docker().buildImage(
    { context, src: [...src] },
    { t: tag, nocache: request.noCache, pull: request.noCache, dockerfile: 'Dockerfile', buildargs },
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
