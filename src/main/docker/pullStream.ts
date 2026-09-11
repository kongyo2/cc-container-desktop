import { StringDecoder } from 'node:string_decoder';

import type { LayerProgress } from '../../shared/images.ts';

export interface PullEvent {
  readonly status: string | null;
  readonly id: string | null;
  readonly current: number | null;
  readonly total: number | null;
  readonly error: string | null;
}

const MAX_LINE_BYTES = 1024 * 1024;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parsePullLine(line: string): PullEvent | null {
  const trimmed = line.replace(/\r$/u, '').trim();
  if (trimmed === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const detail =
    typeof record['progressDetail'] === 'object' && record['progressDetail'] !== null
      ? (record['progressDetail'] as Record<string, unknown>)
      : {};
  const errorDetail =
    typeof record['errorDetail'] === 'object' && record['errorDetail'] !== null
      ? (record['errorDetail'] as Record<string, unknown>)
      : {};
  let error: string | null = null;
  if (typeof errorDetail['message'] === 'string' && errorDetail['message'] !== '') error = errorDetail['message'];
  else if (typeof record['error'] === 'string' && record['error'] !== '') error = record['error'];
  else if (record['error'] !== undefined && record['error'] !== null) error = String(record['error']);
  return {
    status: typeof record['status'] === 'string' ? record['status'] : null,
    id: typeof record['id'] === 'string' && record['id'] !== '' ? record['id'] : null,
    current: numberOrNull(detail['current']),
    total: numberOrNull(detail['total']),
    error,
  };
}

/**
 * Splits the pull response into JSON events. Handles messages that straddle
 * network chunks, several messages per chunk, UTF-8 sequences cut in half
 * and lines that are not JSON (skipped and counted).
 */
export class PullStreamParser {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private skipped = 0;

  get malformed(): number {
    return this.skipped;
  }

  push(chunk: Buffer | string): PullEvent[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    return this.consume(text, false);
  }

  flush(): PullEvent[] {
    return this.consume(this.decoder.end(), true);
  }

  private consume(text: string, final: boolean): PullEvent[] {
    this.pending += text;
    const events: PullEvent[] = [];
    let newline = this.pending.indexOf('\n');
    while (newline !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.take(line, events);
      newline = this.pending.indexOf('\n');
    }
    if (this.pending.length > MAX_LINE_BYTES) {
      this.pending = '';
      this.skipped += 1;
    }
    if (final && this.pending.trim() !== '') {
      this.take(this.pending, events);
      this.pending = '';
    }
    return events;
  }

  private take(line: string, events: PullEvent[]): void {
    if (line.trim() === '') return;
    const event = parsePullLine(line);
    if (event === null) this.skipped += 1;
    else events.push(event);
  }
}

interface LayerState {
  status: string;
  downloaded: number;
  total: number | null;
  done: boolean;
  reused: boolean;
}

export interface PullAggregate {
  readonly layers: Map<string, LayerState>;
  lastStatus: string | null;
  digest: string | null;
  error: string | null;
  events: number;
}

export function createPullAggregate(): PullAggregate {
  return { layers: new Map(), lastStatus: null, digest: null, error: null, events: 0 };
}

const DONE_STATUSES: readonly string[] = ['Pull complete', 'Already exists'];

/** Whole-image messages carry the reference (a tag or digest) as their id, never a layer. */
function isImageLevel(status: string): boolean {
  return status.startsWith('Pulling from ') || status.startsWith('Digest:') || status.startsWith('Status:');
}

export function applyPullEvent(aggregate: PullAggregate, event: PullEvent): void {
  aggregate.events += 1;
  if (event.error !== null) {
    aggregate.error = event.error;
    return;
  }
  if (event.status !== null && (event.id === null || isImageLevel(event.status))) {
    aggregate.lastStatus = event.status;
    const digest = /^Digest:\s*(sha256:[0-9a-f]{64})/u.exec(event.status);
    if (digest !== null) aggregate.digest = digest[1] ?? null;
    return;
  }
  if (event.id === null) return;

  const layer = aggregate.layers.get(event.id) ?? {
    status: '',
    downloaded: 0,
    total: null,
    done: false,
    reused: false,
  };
  const status = event.status ?? layer.status;
  layer.status = status;

  if (status === 'Downloading') {
    if (event.total !== null && event.total > 0) layer.total = Math.max(layer.total ?? 0, event.total);
    if (event.current !== null) layer.downloaded = Math.max(layer.downloaded, event.current);
  } else if (status === 'Download complete' || status === 'Verifying Checksum') {
    if (layer.total !== null) layer.downloaded = Math.max(layer.downloaded, layer.total);
  } else if (DONE_STATUSES.includes(status)) {
    layer.done = true;
    if (status === 'Already exists') layer.reused = true;
    if (layer.total !== null) layer.downloaded = Math.max(layer.downloaded, layer.total);
  }
  aggregate.layers.set(event.id, layer);
}

/**
 * Once the daemon has reported a clean end, everything it listed is in place:
 * blobs that only ever reached "Download complete" (the image config under the
 * containerd store, for one) count as done and their bytes as received.
 */
export function completePullAggregate(aggregate: PullAggregate): void {
  for (const layer of aggregate.layers.values()) {
    layer.done = true;
    if (layer.total !== null) layer.downloaded = Math.max(layer.downloaded, layer.total);
  }
}

export interface PullProgressSnapshot {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly completedLayers: number;
  readonly totalLayers: number;
  readonly layers: readonly LayerProgress[];
}

export function aggregateSnapshot(aggregate: PullAggregate, limit = 64): PullProgressSnapshot {
  let downloadedBytes = 0;
  let totalBytes = 0;
  let allTotalsKnown = true;
  let completedLayers = 0;
  const layers: LayerProgress[] = [];

  for (const [id, layer] of aggregate.layers) {
    downloadedBytes += layer.downloaded;
    if (layer.done) completedLayers += 1;
    if (layer.reused) {
      totalBytes += layer.total ?? 0;
    } else if (layer.total === null) {
      allTotalsKnown = false;
    } else {
      totalBytes += layer.total;
    }
    if (layers.length < limit) {
      layers.push({ id, status: layer.status, current: layer.downloaded, total: layer.total, done: layer.done });
    }
  }

  return {
    downloadedBytes,
    totalBytes: aggregate.layers.size > 0 && allTotalsKnown ? totalBytes : null,
    completedLayers,
    totalLayers: aggregate.layers.size,
    layers,
  };
}
