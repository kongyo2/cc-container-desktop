import type { ImagePlatform } from '../../shared/images.ts';
import { AppFailure, classifyDockerError } from '../errors.ts';
import { docker, pingDaemon } from './engine.ts';
import {
  aggregateSnapshot,
  applyPullEvent,
  completePullAggregate,
  createPullAggregate,
  PullStreamParser,
} from './pullStream.ts';
import type { PullProgressSnapshot } from './pullStream.ts';

export interface PullProgress extends PullProgressSnapshot {
  readonly lastStatus: string | null;
  readonly silentSeconds: number;
}

export interface PullOutcome {
  readonly digest: string | null;
  readonly events: number;
  readonly malformed: number;
}

const STALL_NOTICE_MS = 5 * 60_000;
const STALL_FAIL_MS = 15 * 60_000;
const STALL_CHECK_INTERVAL_MS = 30_000;

function cancelledFailure(): AppFailure {
  return new AppFailure('CANCELLED', '取得をキャンセルしました / the download was cancelled');
}

interface PullStream extends NodeJS.ReadableStream {
  destroy?: (error?: Error) => void;
}

/**
 * Pulls one reference for one platform and reports layer progress. Resolves
 * only when the daemon closed the stream cleanly without an error event; an
 * aborted signal, a premature close, an in-stream error or a dead daemon after
 * a long silence all reject.
 */
export async function pullImage(
  reference: string,
  platform: ImagePlatform,
  signal: AbortSignal,
  onProgress: (progress: PullProgress) => void,
): Promise<PullOutcome> {
  if (signal.aborted) throw cancelledFailure();

  let stream: PullStream;
  try {
    stream = (await docker().pull(reference, { platform, abortSignal: signal })) as PullStream;
  } catch (error) {
    if (signal.aborted) throw cancelledFailure();
    throw classifyDockerError(error, 'pull');
  }

  const parser = new PullStreamParser();
  const aggregate = createPullAggregate();
  let lastEventAt = Date.now();
  let settled = false;
  let ended = false;

  return new Promise<PullOutcome>((resolve, reject) => {
    const report = (): void => {
      onProgress({
        ...aggregateSnapshot(aggregate),
        lastStatus: aggregate.lastStatus,
        silentSeconds: Math.floor((Date.now() - lastEventAt) / 1000),
      });
    };

    const finish = (error: AppFailure | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      signal.removeEventListener('abort', onAbort);
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ digest: aggregate.digest, events: aggregate.events, malformed: parser.malformed });
    };

    const tearDown = (): void => {
      try {
        stream.destroy?.();
      } catch {
        // the stream may already be gone
      }
    };

    const onAbort = (): void => {
      tearDown();
      finish(cancelledFailure());
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const timer = setInterval(() => {
      const silent = Date.now() - lastEventAt;
      if (silent < STALL_NOTICE_MS) return;
      report();
      if (silent < STALL_FAIL_MS) return;
      void pingDaemon().then((alive) => {
        if (alive || settled) return;
        tearDown();
        finish(
          new AppFailure(
            'PULL_STALLED',
            `${Math.round(silent / 60_000)} 分間進捗がなく、Docker デーモンも応答しません / no progress for ${Math.round(silent / 60_000)} minutes and the Docker daemon stopped answering`,
            { retryable: true },
          ),
        );
        return undefined;
      });
    }, STALL_CHECK_INTERVAL_MS);

    const consume = (events: ReturnType<PullStreamParser['push']>): boolean => {
      for (const event of events) applyPullEvent(aggregate, event);
      if (aggregate.error !== null) {
        tearDown();
        finish(classifyDockerError(new Error(aggregate.error), 'pull'));
        return false;
      }
      return true;
    };

    stream.on('data', (chunk: Buffer) => {
      lastEventAt = Date.now();
      if (consume(parser.push(chunk))) report();
    });
    stream.on('error', (error: Error) => {
      finish(signal.aborted ? cancelledFailure() : classifyDockerError(error, 'pull'));
    });
    stream.on('end', () => {
      ended = true;
      if (!consume(parser.flush())) return;
      completePullAggregate(aggregate);
      report();
      finish(null);
    });
    stream.on('close', () => {
      if (settled) return;
      if (ended) {
        finish(null);
        return;
      }
      finish(
        signal.aborted
          ? cancelledFailure()
          : new AppFailure(
              'NETWORK_ERROR',
              '取得ストリームが完了前に閉じられました / the pull stream closed before the daemon reported completion',
              { retryable: true },
            ),
      );
    });
  });
}
