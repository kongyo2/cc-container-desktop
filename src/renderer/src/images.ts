import { isTerminalPhase } from '../../shared/images.ts';
import type { ImageAvailability, ImageOperation, ImageOperationPhase } from '../../shared/images.ts';
import type { MessageKey } from '../../shared/i18n.ts';
import type { Tone } from './components/ui.tsx';

export function phaseKey(phase: ImageOperationPhase): MessageKey {
  switch (phase) {
    case 'queued':
      return 'opPhaseQueued';
    case 'checking':
      return 'opPhaseChecking';
    case 'pulling':
      return 'opPhasePulling';
    case 'registering':
      return 'opPhaseRegistering';
    case 'succeeded':
      return 'opPhaseSucceeded';
    case 'failed':
      return 'opPhaseFailed';
    case 'cancelled':
      return 'opPhaseCancelled';
    case 'interrupted':
      return 'opPhaseInterrupted';
  }
}

export function kindKey(kind: ImageOperation['kind']): MessageKey {
  switch (kind) {
    case 'download':
      return 'opKindDownload';
    case 'custom':
      return 'opKindCustom';
    case 'repair':
      return 'opKindRepair';
  }
}

export function stepKey(operation: ImageOperation): MessageKey | null {
  switch (operation.step) {
    case 'local-found':
      return 'opStepLocalFound';
    case 'stalled':
      return 'opStepStalled';
    default:
      return null;
  }
}

export function availabilityKey(availability: ImageAvailability): MessageKey {
  switch (availability.kind) {
    case 'ready':
      return 'imageStatusReady';
    case 'missing':
      return 'imageStatusMissing';
    case 'unavailable':
      return 'imageStatusUnavailable';
    case 'incompatible':
      return 'imageStatusIncompatible';
    case 'error':
      return 'imageStatusError';
  }
}

export function availabilityTone(availability: ImageAvailability): Tone {
  switch (availability.kind) {
    case 'ready':
      return 'ok';
    case 'missing':
      return 'warn';
    case 'unavailable':
      return 'idle';
    case 'incompatible':
    case 'error':
      return 'err';
  }
}

export function phaseTone(phase: ImageOperationPhase): Tone {
  switch (phase) {
    case 'succeeded':
      return 'ok';
    case 'failed':
    case 'interrupted':
      return 'err';
    case 'cancelled':
      return 'idle';
    default:
      return 'warn';
  }
}

export function operationForTarget(
  operations: readonly ImageOperation[],
  match: (operation: ImageOperation) => boolean,
): ImageOperation | null {
  const related = operations.filter(match);
  const running = related.find((operation) => !isTerminalPhase(operation.phase));
  if (running !== undefined) return running;
  const latest = related[0] ?? null;
  return latest !== null && latest.phase !== 'succeeded' ? latest : null;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
