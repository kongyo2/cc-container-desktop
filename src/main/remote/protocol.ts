import type { AppError } from '../../shared/images.ts';
import type { Result } from '../../shared/types.ts';

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export type DenyReason = 'version' | 'unknown-client' | 'bad-credentials' | 'no-invite' | 'busy' | 'internal';

export interface HelloMessage {
  readonly t: 'hello';
  readonly protocol: number;
  readonly instanceId: string;
  readonly name: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly nonce: string;
  readonly pairing: boolean;
}

interface AuthMessage {
  readonly t: 'auth';
  readonly clientId: string;
  readonly clientName: string;
  readonly token: string;
}

interface PairMessage {
  readonly t: 'pair';
  readonly clientId: string;
  readonly clientName: string;
  readonly nonce: string;
  readonly proof: string;
}

interface WelcomeMessage {
  readonly t: 'welcome';
  readonly sessionId: string;
  readonly instanceId: string;
  readonly name: string;
  readonly appVersion: string;
  readonly platform: string;
}

interface PairedMessage {
  readonly t: 'paired';
  readonly sessionId: string;
  readonly instanceId: string;
  readonly name: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly clientId: string;
  readonly token: string;
  readonly proof: string;
}

interface DeniedMessage {
  readonly t: 'denied';
  readonly reason: DenyReason;
  readonly message: string;
}

export interface CallMessage {
  readonly t: 'call';
  readonly id: string;
  readonly channel: string;
  readonly args: readonly unknown[];
}

interface ReplyMessage {
  readonly t: 'reply';
  readonly id: string;
  readonly result: Result<unknown>;
}

export interface EventMessage {
  readonly t: 'event';
  readonly channel: string;
  readonly payload: unknown;
}

interface PingMessage {
  readonly t: 'ping';
  readonly at: number;
}

interface PongMessage {
  readonly t: 'pong';
  readonly at: number;
}

interface StreamStartMessage {
  readonly t: 'stream';
  readonly id: string;
  readonly meta: unknown;
}

interface StreamChunkMessage {
  readonly t: 'chunk';
  readonly id: string;
  readonly seq: number;
  readonly data: string;
}

interface StreamEndMessage {
  readonly t: 'streamEnd';
  readonly id: string;
  readonly error: string | null;
}

interface StreamAckMessage {
  readonly t: 'streamAck';
  readonly id: string;
  readonly seq: number;
}

interface StreamAbortMessage {
  readonly t: 'streamAbort';
  readonly id: string;
  readonly message: string;
}

export type RemoteMessage =
  | HelloMessage
  | AuthMessage
  | PairMessage
  | WelcomeMessage
  | PairedMessage
  | DeniedMessage
  | CallMessage
  | ReplyMessage
  | EventMessage
  | PingMessage
  | PongMessage
  | StreamStartMessage
  | StreamChunkMessage
  | StreamEndMessage
  | StreamAckMessage
  | StreamAbortMessage;

const MAX_TEXT = 4096;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError('a frame must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function text(source: Record<string, unknown>, field: string, limit: number = MAX_TEXT): string {
  const value = source[field];
  if (typeof value !== 'string') throw new ProtocolError(`${field} must be a string`);
  if (value.length > limit) throw new ProtocolError(`${field} is too long`);
  return value;
}

function count(source: Record<string, unknown>, field: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProtocolError(`${field} must be a number`);
  return value;
}

function flag(source: Record<string, unknown>, field: string): boolean {
  const value = source[field];
  if (typeof value !== 'boolean') throw new ProtocolError(`${field} must be a boolean`);
  return value;
}

function list(source: Record<string, unknown>, field: string): readonly unknown[] {
  const value = source[field];
  if (!Array.isArray(value)) throw new ProtocolError(`${field} must be an array`);
  return value;
}

function nullableText(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === null || value === undefined) return null;
  return text(source, field);
}

const DENY_REASONS: readonly DenyReason[] = [
  'version',
  'unknown-client',
  'bad-credentials',
  'no-invite',
  'busy',
  'internal',
];

function denyReason(source: Record<string, unknown>): DenyReason {
  const value = text(source, 'reason', 64);
  const known = DENY_REASONS.find((reason) => reason === value);
  return known ?? 'internal';
}

function appError(value: unknown): AppError {
  const source = record(value);
  return {
    code: text(source, 'code', 64),
    message: text(source, 'message', 8192),
    retryable: source['retryable'] === true,
  };
}

function result(value: unknown): Result<unknown> {
  const source = record(value);
  if (source['ok'] === true) return { ok: true, value: source['value'] ?? null };
  if (source['ok'] === false) return { ok: false, error: appError(source['error']) };
  throw new ProtocolError('a reply must carry ok: true or ok: false');
}

export function parseRemoteMessage(raw: unknown): RemoteMessage {
  const source = record(raw);
  const kind = source['t'];
  switch (kind) {
    case 'hello':
      return {
        t: 'hello',
        protocol: count(source, 'protocol'),
        instanceId: text(source, 'instanceId', 64),
        name: text(source, 'name', 256),
        appVersion: text(source, 'appVersion', 64),
        platform: text(source, 'platform', 64),
        nonce: text(source, 'nonce', 256),
        pairing: flag(source, 'pairing'),
      };
    case 'auth':
      return {
        t: 'auth',
        clientId: text(source, 'clientId', 64),
        clientName: text(source, 'clientName', 256),
        token: text(source, 'token', 512),
      };
    case 'pair':
      return {
        t: 'pair',
        clientId: text(source, 'clientId', 64),
        clientName: text(source, 'clientName', 256),
        nonce: text(source, 'nonce', 256),
        proof: text(source, 'proof', 256),
      };
    case 'welcome':
      return {
        t: 'welcome',
        sessionId: text(source, 'sessionId', 64),
        instanceId: text(source, 'instanceId', 64),
        name: text(source, 'name', 256),
        appVersion: text(source, 'appVersion', 64),
        platform: text(source, 'platform', 64),
      };
    case 'paired':
      return {
        t: 'paired',
        sessionId: text(source, 'sessionId', 64),
        instanceId: text(source, 'instanceId', 64),
        name: text(source, 'name', 256),
        appVersion: text(source, 'appVersion', 64),
        platform: text(source, 'platform', 64),
        clientId: text(source, 'clientId', 64),
        token: text(source, 'token', 512),
        proof: text(source, 'proof', 256),
      };
    case 'denied':
      return { t: 'denied', reason: denyReason(source), message: text(source, 'message', 8192) };
    case 'call':
      return {
        t: 'call',
        id: text(source, 'id', 64),
        channel: text(source, 'channel', 128),
        args: list(source, 'args'),
      };
    case 'reply':
      return { t: 'reply', id: text(source, 'id', 64), result: result(source['result']) };
    case 'event':
      return { t: 'event', channel: text(source, 'channel', 128), payload: source['payload'] ?? null };
    case 'ping':
      return { t: 'ping', at: count(source, 'at') };
    case 'pong':
      return { t: 'pong', at: count(source, 'at') };
    case 'stream':
      return { t: 'stream', id: text(source, 'id', 64), meta: source['meta'] ?? null };
    case 'chunk':
      return {
        t: 'chunk',
        id: text(source, 'id', 64),
        seq: count(source, 'seq'),
        data: text(source, 'data', 16 * 1024 * 1024),
      };
    case 'streamEnd':
      return { t: 'streamEnd', id: text(source, 'id', 64), error: nullableText(source, 'error') };
    case 'streamAck':
      return { t: 'streamAck', id: text(source, 'id', 64), seq: count(source, 'seq') };
    case 'streamAbort':
      return { t: 'streamAbort', id: text(source, 'id', 64), message: text(source, 'message') };
    default:
      throw new ProtocolError(`unknown message: ${typeof kind === 'string' ? kind.slice(0, 32) : typeof kind}`);
  }
}
