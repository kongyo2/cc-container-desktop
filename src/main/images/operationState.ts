import { isTerminalPhase } from '../../shared/images.ts';
import type {
  AppError,
  ImageOperation,
  ImageOperationKind,
  ImageOperationPhase,
  ImageOperationTarget,
  RegisteredImage,
} from '../../shared/images.ts';

export interface NewOperationInput {
  readonly id: string;
  readonly kind: ImageOperationKind;
  readonly targetKey: string;
  readonly catalogEntryId: string | null;
  readonly registeredImageId: string | null;
  readonly target: ImageOperationTarget;
  readonly now?: string;
}

export function createOperation(input: NewOperationInput): ImageOperation {
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id,
    kind: input.kind,
    sequence: 0,
    targetKey: input.targetKey,
    catalogEntryId: input.catalogEntryId,
    registeredImageId: input.registeredImageId,
    target: input.target,
    phase: 'queued',
    step: '',
    cancelRequested: false,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    pulled: false,
    downloadedBytes: 0,
    totalBytes: null,
    completedLayers: 0,
    totalLayers: 0,
    layers: [],
    error: null,
  };
}

export type OperationPatch = Partial<
  Pick<
    ImageOperation,
    | 'registeredImageId'
    | 'target'
    | 'phase'
    | 'step'
    | 'cancelRequested'
    | 'pulled'
    | 'downloadedBytes'
    | 'totalBytes'
    | 'completedLayers'
    | 'totalLayers'
    | 'layers'
    | 'error'
  >
>;

export function patchOperation(operation: ImageOperation, patch: OperationPatch, now?: string): ImageOperation {
  if (isTerminalPhase(operation.phase)) return operation;
  const stamp = now ?? new Date().toISOString();
  const next: ImageOperation = { ...operation, ...patch, sequence: operation.sequence + 1, updatedAt: stamp };
  if (isTerminalPhase(next.phase)) return { ...next, finishedAt: stamp, layers: [] };
  return next;
}

export function finishOperation(
  operation: ImageOperation,
  phase: Extract<ImageOperationPhase, 'succeeded' | 'failed' | 'cancelled' | 'interrupted'>,
  error: AppError | null,
  now?: string,
): ImageOperation {
  return patchOperation(operation, { phase, error, step: '' }, now);
}

/**
 * After a restart no operation is still running. One whose registration
 * committed (a registration for the same target, verified no earlier than the
 * operation started) is restored as succeeded; everything else is interrupted
 * and can be retried from the local state.
 */
export function recoverOperation(
  operation: ImageOperation,
  images: readonly RegisteredImage[],
  now?: string,
): ImageOperation {
  if (isTerminalPhase(operation.phase)) return operation;
  const committed = images.find(
    (image) =>
      (operation.registeredImageId !== null && image.id === operation.registeredImageId) ||
      (operation.target.pinnedDigest !== null &&
        image.pinnedDigest === operation.target.pinnedDigest &&
        image.platform === operation.target.platform &&
        image.lastVerified.verifiedAt >= operation.startedAt),
  );
  if (committed !== undefined && committed.lastVerified.verifiedAt >= operation.startedAt) {
    return patchOperation(
      { ...operation, registeredImageId: committed.id },
      { phase: 'succeeded', error: null, step: '' },
      now,
    );
  }
  return patchOperation(
    operation,
    {
      phase: 'interrupted',
      step: '',
      error: {
        code: 'INTERRUPTED',
        message:
          'アプリの終了で操作が完結しませんでした。再試行してください / the app closed before the operation finished; retry it',
        retryable: true,
      },
    },
    now,
  );
}

export const HISTORY_LIMIT = 20;

export function pruneHistory(
  operations: readonly ImageOperation[],
  keep: number = HISTORY_LIMIT,
): readonly ImageOperation[] {
  const active = operations.filter((operation) => !isTerminalPhase(operation.phase));
  const finished = operations
    .filter((operation) => isTerminalPhase(operation.phase))
    .sort((left, right) => (left.finishedAt ?? left.updatedAt).localeCompare(right.finishedAt ?? right.updatedAt))
    .slice(-keep);
  return [...active, ...finished];
}

export function sortForDisplay(operations: readonly ImageOperation[]): readonly ImageOperation[] {
  return [...operations].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}
