import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { TLSSocket } from 'node:tls';

import type { Result } from '../../shared/types.ts';
import { AppFailure, RelayedFailure, describeError } from '../errors.ts';
import { FrameDecoder, encodeFrame } from './frame.ts';
import { ProtocolError, parseRemoteMessage } from './protocol.ts';
import type { CallMessage, EventMessage, RemoteMessage } from './protocol.ts';

const CHUNK_BYTES = 128 * 1024;

const WINDOW_CHUNKS = 8;

const PING_INTERVAL_MS = 15_000;

const SILENCE_LIMIT_MS = 50_000;

const DEFAULT_CALL_TIMEOUT_MS = 15 * 60_000;

export interface ChannelHandlers {
  readonly onCall?: (message: CallMessage) => void;
  readonly onEvent?: (message: EventMessage) => void;
  readonly onControl?: (message: RemoteMessage) => void;
  readonly onClose: (reason: string | null) => void;
}

function linkFailure(detail: string): AppFailure {
  return new AppFailure('REMOTE_ERROR', `リモート接続が切れました / the remote link dropped: ${detail}`, {
    retryable: true,
  });
}

class IncomingStream extends Readable {
  private readonly ack: (seq: number) => void;
  private highest = 0;
  private held = false;

  constructor(ack: (seq: number) => void) {
    super({ highWaterMark: CHUNK_BYTES * WINDOW_CHUNKS });
    this.ack = ack;
  }

  override _read(): void {
    if (!this.held) return;
    this.held = false;
    this.ack(this.highest);
  }

  accept(seq: number, payload: Buffer): void {
    if (this.destroyed) return;
    this.highest = seq;
    if (this.push(payload)) this.ack(seq);
    else this.held = true;
  }

  finish(error: string | null): void {
    if (this.destroyed) return;
    if (error === null) this.push(null);
    else this.destroy(new Error(error));
  }
}

interface Incoming {
  readonly stream: IncomingStream;
  readonly meta: Promise<unknown>;
  settleMeta: (value: unknown) => void;
}

interface Pending {
  readonly resolve: (result: Result<unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class RemoteChannel {
  readonly socket: TLSSocket;
  private readonly handlers: ChannelHandlers;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<string, Pending>();
  private readonly incoming = new Map<string, Incoming>();
  private readonly acks = new Map<string, number>();
  private readonly waiters = new Map<string, () => void>();
  private readonly aborted = new Map<string, string>();
  private keepalive: NodeJS.Timeout | null = null;
  private lastSeenAt = Date.now();
  private closedReason: string | null = null;

  constructor(socket: TLSSocket, handlers: ChannelHandlers) {
    this.socket = socket;
    this.handlers = handlers;

    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', (error: Error) => this.shutdown(describeError(error)));
    socket.on('close', () => this.shutdown('closed'));
    socket.on('end', () => this.shutdown('closed by the other side'));

    this.keepalive = setInterval(() => this.beat(), PING_INTERVAL_MS);
    this.keepalive.unref();
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  send(message: RemoteMessage): boolean {
    if (this.closed) return false;
    try {
      return this.socket.write(encodeFrame(message));
    } catch (error) {
      this.shutdown(describeError(error));
      return false;
    }
  }

  reply(id: string, result: Result<unknown>): void {
    this.send({ t: 'reply', id, result });
  }

  event(channel: string, payload: unknown): void {
    this.send({ t: 'event', channel, payload });
  }

  async call(channel: string, args: readonly unknown[], timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const result = await this.callResult(channel, args, timeoutMs);
    if (result.ok) return result.value;
    throw new RelayedFailure(result.error);
  }

  callResult(
    channel: string,
    args: readonly unknown[],
    timeoutMs: number = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<Result<unknown>> {
    if (this.closed) return Promise.reject(linkFailure(this.closedReason ?? 'closed'));
    const id = randomUUID();
    return new Promise<Result<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppFailure(
            'REMOTE_ERROR',
            `リモートの応答がありません / the remote instance did not answer: ${channel}`,
            { retryable: true },
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: 'call', id, channel, args: [...args] });
    });
  }

  newTransferId(): string {
    return randomUUID();
  }

  receiveStream(id: string): { readonly stream: Readable; readonly meta: Promise<unknown> } {
    const entry = this.ensureIncoming(id);
    return { stream: entry.stream, meta: entry.meta };
  }

  async sendStream(id: string, meta: unknown, source: NodeJS.ReadableStream): Promise<void> {
    this.send({ t: 'stream', id, meta });
    this.acks.set(id, 0);
    let seq = 0;
    try {
      for await (const raw of source) {
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
        for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
          const slice = buffer.subarray(offset, offset + CHUNK_BYTES);
          seq += 1;
          /* oxlint-disable-next-line no-await-in-loop -- the window is the point: one chunk at a time */
          await this.awaitWindow(id, seq);
          if (!this.send({ t: 'chunk', id, seq, data: slice.toString('base64') })) {
            /* oxlint-disable-next-line no-await-in-loop -- socket backpressure, same reason */
            await this.awaitDrain();
          }
        }
      }
      this.send({ t: 'streamEnd', id, error: null });
    } catch (error) {
      const detail = describeError(error);
      this.send({ t: 'streamEnd', id, error: detail });
      throw error instanceof Error ? error : new Error(detail);
    } finally {
      this.acks.delete(id);
      this.waiters.delete(id);
      this.aborted.delete(id);
      (source as { destroy?: () => void }).destroy?.();
    }
  }

  abortStream(id: string, message: string): void {
    this.send({ t: 'streamAbort', id, message });
  }

  cancelOutgoing(id: string, message: string): void {
    this.aborted.set(id, message);
    const waiter = this.waiters.get(id);
    if (waiter === undefined) return;
    this.waiters.delete(id);
    waiter();
  }

  close(reason: string): void {
    this.shutdown(reason);
    this.socket.destroy();
  }

  private ensureIncoming(id: string): Incoming {
    const known = this.incoming.get(id);
    if (known !== undefined) return known;
    let settleMeta: (value: unknown) => void = () => undefined;
    const meta = new Promise<unknown>((resolve) => {
      settleMeta = resolve;
    });
    const stream = new IncomingStream((seq) => this.send({ t: 'streamAck', id, seq }));
    const entry: Incoming = { stream, meta, settleMeta };
    this.incoming.set(id, entry);
    return entry;
  }

  private async awaitWindow(id: string, seq: number): Promise<void> {
    const failure = this.aborted.get(id);
    if (failure !== undefined) throw new Error(failure);
    if (this.closed) throw linkFailure(this.closedReason ?? 'closed');
    const acked = this.acks.get(id) ?? 0;
    if (seq - acked <= WINDOW_CHUNKS) return;
    await new Promise<void>((resolve) => {
      this.waiters.set(id, resolve);
    });
    const stopped = this.aborted.get(id);
    if (stopped !== undefined) throw new Error(stopped);
    if (this.closed) throw linkFailure(this.closedReason ?? 'closed');
  }

  private awaitDrain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.socket.off('drain', done);
        this.socket.off('close', done);
        resolve();
      };
      this.socket.once('drain', done);
      this.socket.once('close', done);
    });
  }

  private beat(): void {
    if (this.closed) return;
    if (Date.now() - this.lastSeenAt > SILENCE_LIMIT_MS) {
      this.close('応答がありません / no answer from the other side');
      return;
    }
    this.send({ t: 'ping', at: Date.now() });
  }

  private receive(chunk: Buffer): void {
    this.lastSeenAt = Date.now();
    let messages: readonly unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      this.close(describeError(error));
      return;
    }
    for (const raw of messages) {
      let message: RemoteMessage;
      try {
        message = parseRemoteMessage(raw);
      } catch (error) {
        this.close(error instanceof ProtocolError ? error.message : describeError(error));
        return;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: RemoteMessage): void {
    switch (message.t) {
      case 'ping':
        this.send({ t: 'pong', at: message.at });
        return;
      case 'pong':
        return;
      case 'reply': {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message.result);
        return;
      }
      case 'call':
        this.handlers.onCall?.(message);
        return;
      case 'event':
        this.handlers.onEvent?.(message);
        return;
      case 'stream':
        this.ensureIncoming(message.id).settleMeta(message.meta);
        return;
      case 'chunk': {
        const entry = this.incoming.get(message.id);
        if (entry === undefined) return;
        entry.stream.accept(message.seq, Buffer.from(message.data, 'base64'));
        return;
      }
      case 'streamEnd': {
        const entry = this.incoming.get(message.id);
        this.incoming.delete(message.id);
        entry?.settleMeta(null);
        entry?.stream.finish(message.error);
        return;
      }
      case 'streamAck': {
        this.acks.set(message.id, message.seq);
        const waiter = this.waiters.get(message.id);
        if (waiter !== undefined) {
          this.waiters.delete(message.id);
          waiter();
        }
        return;
      }
      case 'streamAbort':
        this.cancelOutgoing(message.id, message.message);
        return;
      default:
        this.handlers.onControl?.(message);
    }
  }

  private shutdown(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    if (this.keepalive !== null) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(linkFailure(reason));
    }
    this.pending.clear();
    for (const [, entry] of this.incoming) entry.stream.finish(`link closed: ${reason}`);
    this.incoming.clear();
    for (const [, waiter] of this.waiters) waiter();
    this.waiters.clear();
    this.handlers.onClose(reason);
  }
}
