export const REMOTE_PROTOCOL_VERSION = 1;

export const DEFAULT_REMOTE_PORT = 47713;

export const REMOTE_DISCOVERY_PORT = 47714;

export const REMOTE_DISCOVERY_GROUP = '239.7.7.13';

const REMOTE_TICKET_PREFIX = 'CCD1.';

export const PAIRING_CODE_LENGTH = 10;

export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export const REMOTE_INSTANCE_ID_PATTERN: RegExp = /^rid_[0-9a-f]{16}$/u;

export const REMOTE_FINGERPRINT_PATTERN: RegExp = /^[0-9a-f]{64}$/u;

export const MAX_REMOTE_NAME = 48;

export type RemoteLinkState = 'offline' | 'connecting' | 'online' | 'error';

interface RemoteIdentityView {
  readonly instanceId: string;
  readonly name: string;
  readonly fingerprint: string;
}

export interface RemoteInviteView {
  readonly code: string;
  readonly ticket: string;
  readonly expiresAt: string;
}

export interface RemoteClientView {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: string;
  readonly lastSeenAt: string | null;
  readonly lastAddress: string | null;
  readonly online: boolean;
}

export interface RemoteHostingView {
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly port: number;
  readonly boundPort: number | null;
  readonly discovery: boolean;
  readonly addresses: readonly string[];
  readonly problem: string | null;
  readonly invite: RemoteInviteView | null;
  readonly clients: readonly RemoteClientView[];
}

export interface RemotePeerView {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly addresses: readonly string[];
  readonly lastConnectedAt: string | null;
}

export interface RemoteDiscoveredView {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly appVersion: string;
  readonly paired: boolean;
}

export interface RemoteLinkView {
  readonly state: RemoteLinkState;
  readonly epoch: number;
  readonly peerId: string | null;
  readonly peerName: string | null;
  readonly address: string | null;
  readonly since: string | null;
  readonly attempt: number;
  readonly error: string | null;
  readonly peerVersion: string | null;
  readonly peerPlatform: string | null;
}

export interface RemoteStatus {
  readonly identity: RemoteIdentityView;
  readonly hosting: RemoteHostingView;
  readonly link: RemoteLinkView;
  readonly peers: readonly RemotePeerView[];
  readonly discovered: readonly RemoteDiscoveredView[];
  readonly scanning: boolean;
}

export interface RemoteTicket {
  readonly instanceId: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly port: number;
  readonly addresses: readonly string[];
  readonly code: string;
}

export interface RemoteHostingPatch {
  readonly enabled?: boolean;
  readonly port?: number;
  readonly discovery?: boolean;
  readonly name?: string;
}

export interface RemotePairRequest {
  readonly ticket: string;
  readonly address: string;
  readonly code: string;
}

export interface RemoteConnectRequest {
  readonly peerId: string;
  readonly address: string;
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    const remaining = bytes.length - index;
    out += BASE64URL_ALPHABET[(triple >> 18) & 63] ?? '';
    out += BASE64URL_ALPHABET[(triple >> 12) & 63] ?? '';
    if (remaining > 1) out += BASE64URL_ALPHABET[(triple >> 6) & 63] ?? '';
    if (remaining > 2) out += BASE64URL_ALPHABET[triple & 63] ?? '';
  }
  return out;
}

function base64UrlDecode(text: string): Uint8Array | null {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of text) {
    const value = BASE64URL_ALPHABET.indexOf(character);
    if (value === -1) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}

export function normalizeRemoteName(name: string): string {
  return name
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_REMOTE_NAME);
}

export function normalizePairingCode(code: string): string {
  return [...code.toUpperCase()].filter((character) => PAIRING_CODE_ALPHABET.includes(character)).join('');
}

export function formatPairingCode(code: string): string {
  const groups = code.match(/.{1,5}/gu);
  return groups === null ? code : groups.join('-');
}

export function formatFingerprint(fingerprint: string): string {
  const groups = fingerprint.toUpperCase().match(/.{1,4}/gu);
  return groups === null ? fingerprint : groups.join(' ');
}

export function shortFingerprint(fingerprint: string): string {
  return formatFingerprint(fingerprint.slice(0, 16));
}

interface TicketPayload {
  readonly v: number;
  readonly i: string;
  readonly n: string;
  readonly f: string;
  readonly p: number;
  readonly a: readonly string[];
  readonly c: string;
}

export function encodeRemoteTicket(ticket: RemoteTicket): string {
  const payload: TicketPayload = {
    v: REMOTE_PROTOCOL_VERSION,
    i: ticket.instanceId,
    n: ticket.name,
    f: ticket.fingerprint,
    p: ticket.port,
    a: [...ticket.addresses],
    c: ticket.code,
  };
  return REMOTE_TICKET_PREFIX + base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  return list.length === value.length ? list : null;
}

export function decodeRemoteTicket(text: string): RemoteTicket | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(REMOTE_TICKET_PREFIX)) return null;
  const bytes = base64UrlDecode(trimmed.slice(REMOTE_TICKET_PREFIX.length));
  if (bytes === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const payload = parsed as Partial<TicketPayload>;
  const addresses = asStringArray(payload.a);
  if (
    payload.v !== REMOTE_PROTOCOL_VERSION ||
    typeof payload.i !== 'string' ||
    !REMOTE_INSTANCE_ID_PATTERN.test(payload.i) ||
    typeof payload.n !== 'string' ||
    typeof payload.f !== 'string' ||
    !REMOTE_FINGERPRINT_PATTERN.test(payload.f) ||
    typeof payload.p !== 'number' ||
    !Number.isInteger(payload.p) ||
    payload.p < 1 ||
    payload.p > 65535 ||
    addresses === null ||
    typeof payload.c !== 'string' ||
    normalizePairingCode(payload.c) !== payload.c ||
    payload.c.length !== PAIRING_CODE_LENGTH
  ) {
    return null;
  }
  return {
    instanceId: payload.i,
    name: normalizeRemoteName(payload.n),
    fingerprint: payload.f,
    port: payload.p,
    addresses,
    code: payload.c,
  };
}

export interface RemoteAddress {
  readonly host: string;
  readonly port: number;
}

export function parseRemoteAddress(text: string, fallbackPort: number = DEFAULT_REMOTE_PORT): RemoteAddress | null {
  const trimmed = text.trim().replace(/^\w+:\/\//u, '');
  if (trimmed === '') return null;

  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(trimmed);
  if (bracketed !== null) {
    const host = bracketed[1] ?? '';
    const port = bracketed[2] === undefined ? fallbackPort : Number.parseInt(bracketed[2], 10);
    return host === '' || port < 1 || port > 65535 ? null : { host, port };
  }

  const colons = trimmed.split(':').length - 1;
  if (colons > 1) return { host: trimmed, port: fallbackPort };
  if (colons === 1) {
    const [host = '', rawPort = ''] = trimmed.split(':');
    const port = Number.parseInt(rawPort, 10);
    if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  }
  return { host: trimmed, port: fallbackPort };
}

export function formatRemoteAddress(address: RemoteAddress): string {
  return address.host.includes(':') ? `[${address.host}]:${address.port}` : `${address.host}:${address.port}`;
}
