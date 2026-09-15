import type { CommandOrigin } from './commands.ts';
import { broadcast } from './window.ts';

export interface RemoteEventSink {
  broadcast(channel: string, payload: unknown): void;
  toSession(sessionId: string, channel: string, payload: unknown): void;
}

let sink: RemoteEventSink | null = null;

export function setRemoteEventSink(next: RemoteEventSink | null): void {
  sink = next;
}

export function emitEvent(channel: string, payload?: unknown): void {
  broadcast(channel, payload);
  sink?.broadcast(channel, payload);
}

export function emitToOrigin(origin: CommandOrigin, channel: string, payload: unknown): void {
  if (origin.kind === 'local') {
    broadcast(channel, payload);
    return;
  }
  sink?.toSession(origin.sessionId, channel, payload);
}
