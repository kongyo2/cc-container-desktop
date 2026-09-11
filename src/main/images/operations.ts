import { randomBytes } from 'node:crypto';

import { isTerminalPhase } from '../../shared/images.ts';
import type { AppError, ImageOperation } from '../../shared/images.ts';
import { EVENTS } from '../../shared/ipc.ts';
import { AppFailure, toAppError } from '../errors.ts';
import { logInfo, logWarn, notifyStateChanged } from '../logger.ts';
import { broadcast } from '../window.ts';
import {
  createOperation,
  finishOperation,
  patchOperation,
  pruneHistory,
  recoverOperation,
  sortForDisplay,
} from './operationState.ts';
import type { NewOperationInput, OperationPatch } from './operationState.ts';
import { listRegisteredImages, readOperationHistory, writeOperationHistory } from './store.ts';

const EMIT_INTERVAL_MS = 150;

interface LiveOperation {
  operation: ImageOperation;
  readonly controller: AbortController;
  emitTimer: ReturnType<typeof setTimeout> | null;
  emitPending: boolean;
}

const live = new Map<string, LiveOperation>();
let history: readonly ImageOperation[] = [];
let historyLoaded = false;
let chain: Promise<void> = Promise.resolve();

export interface OperationContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly current: () => ImageOperation;
  readonly update: (patch: OperationPatch, immediate?: boolean) => ImageOperation;
  readonly throwIfCancelled: () => void;
}

function loadHistory(): void {
  if (historyLoaded) return;
  historyLoaded = true;
  history = readOperationHistory();
}

function persist(): void {
  const all = [...[...live.values()].map((entry) => entry.operation), ...history];
  history = pruneHistory(all).filter((operation) => !live.has(operation.id));
  try {
    writeOperationHistory(pruneHistory(all));
  } catch (error) {
    logWarn(
      'image',
      `操作履歴を保存できませんでした / could not save the operation history: ${toAppError(error).message}`,
    );
  }
}

function emit(entry: LiveOperation, immediate: boolean): void {
  if (immediate) {
    if (entry.emitTimer !== null) {
      clearTimeout(entry.emitTimer);
      entry.emitTimer = null;
    }
    entry.emitPending = false;
    broadcast(EVENTS.imageOperation, entry.operation);
    return;
  }
  entry.emitPending = true;
  if (entry.emitTimer !== null) return;
  entry.emitTimer = setTimeout(() => {
    entry.emitTimer = null;
    if (!entry.emitPending) return;
    entry.emitPending = false;
    broadcast(EVENTS.imageOperation, entry.operation);
  }, EMIT_INTERVAL_MS);
}

export function newOperationId(): string {
  return `op_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function listOperations(): readonly ImageOperation[] {
  loadHistory();
  return sortForDisplay([...[...live.values()].map((entry) => entry.operation), ...history]);
}

function findOperation(id: string): ImageOperation | null {
  loadHistory();
  return live.get(id)?.operation ?? history.find((operation) => operation.id === id) ?? null;
}

export function activeOperationFor(targetKey: string): ImageOperation | null {
  for (const entry of live.values()) {
    if (entry.operation.targetKey === targetKey) return entry.operation;
  }
  return null;
}

export function activeOperations(): readonly ImageOperation[] {
  return [...live.values()].map((entry) => entry.operation);
}

function cancelledFailure(): AppFailure {
  return new AppFailure('CANCELLED', '操作をキャンセルしました / the operation was cancelled');
}

export function enqueueOperation(
  input: NewOperationInput,
  work: (context: OperationContext) => Promise<void>,
): ImageOperation {
  loadHistory();
  const entry: LiveOperation = {
    operation: createOperation(input),
    controller: new AbortController(),
    emitTimer: null,
    emitPending: false,
  };
  live.set(input.id, entry);
  persist();
  emit(entry, true);
  logInfo('image', `操作を受け付けました / queued ${input.kind} of ${input.target.title.en} (${input.id})`);

  const context: OperationContext = {
    id: input.id,
    signal: entry.controller.signal,
    current: () => entry.operation,
    update: (patch, immediate = false) => {
      const next = patchOperation(entry.operation, patch);
      const phaseChanged = next.phase !== entry.operation.phase;
      entry.operation = next;
      emit(entry, immediate || phaseChanged);
      if (phaseChanged) persist();
      return next;
    },
    throwIfCancelled: () => {
      if (entry.operation.cancelRequested || entry.controller.signal.aborted) throw cancelledFailure();
    },
  };

  const run = async (): Promise<void> => {
    if (entry.operation.cancelRequested) {
      settle(entry, finishOperation(entry.operation, 'cancelled', null));
      return;
    }
    try {
      await work(context);
      if (entry.operation.phase !== 'succeeded') {
        settle(entry, finishOperation(entry.operation, 'succeeded', null));
      } else {
        settle(entry, entry.operation);
      }
    } catch (error) {
      const appError: AppError = toAppError(error);
      const phase = appError.code === 'CANCELLED' ? 'cancelled' : 'failed';
      settle(entry, finishOperation(entry.operation, phase, phase === 'cancelled' ? null : appError));
    }
  };

  chain = chain.then(run, run);
  return entry.operation;
}

function settle(entry: LiveOperation, finished: ImageOperation): void {
  entry.operation = finished;
  live.delete(finished.id);
  history = [finished, ...history];
  persist();
  emit(entry, true);
  notifyStateChanged();
  const outcome = finished.error === null ? finished.phase : `${finished.phase}: ${finished.error.message}`;
  logInfo('image', `操作が終了しました / ${finished.kind} of ${finished.target.title.en} → ${outcome}`);
}

export function requestCancel(id: string): ImageOperation {
  const entry = live.get(id);
  if (entry === undefined) {
    const finished = findOperation(id);
    if (finished === null)
      throw new AppFailure('OPERATION_NOT_FOUND', `操作が見つかりません / no such operation: ${id}`);
    return finished;
  }
  if (entry.operation.phase === 'registering') {
    return entry.operation;
  }
  entry.operation = patchOperation(entry.operation, { cancelRequested: true });
  entry.controller.abort();
  emit(entry, true);
  logInfo('image', `キャンセルを受け付けました / cancel requested for ${id}`);
  return entry.operation;
}

export function markSucceeded(context: OperationContext, registeredImageId: string): void {
  context.update({ phase: 'succeeded', registeredImageId, error: null, step: '' }, true);
}

export function recoverOperationsOnStartup(): number {
  loadHistory();
  const images = listRegisteredImages();
  let recovered = 0;
  history = history.map((operation) => {
    if (isTerminalPhase(operation.phase)) return operation;
    recovered += 1;
    return recoverOperation(operation, images);
  });
  if (recovered > 0) {
    persist();
    logWarn(
      'image',
      `前回の未完了の操作を整理しました / reconciled ${recovered} unfinished operation(s) from the last run`,
    );
  }
  return recovered;
}

export async function cancelAllOperations(): Promise<void> {
  for (const id of [...live.keys()]) requestCancel(id);
  await chain.catch(() => undefined);
}
