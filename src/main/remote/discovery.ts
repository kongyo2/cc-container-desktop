import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

import { REMOTE_DISCOVERY_GROUP, REMOTE_DISCOVERY_PORT, REMOTE_PROTOCOL_VERSION } from '../../shared/remote.ts';
import { describeError } from '../errors.ts';
import { logWarn } from '../logger.ts';

const ANNOUNCE_INTERVAL_MS = 4_000;

const STALE_MS = 30_000;

const SCAN_MS = 25_000;

export interface AnnounceInfo {
  readonly id: string;
  readonly name: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly appVersion: string;
}

export interface SeenPeer extends AnnounceInfo {
  readonly host: string;
  readonly seenAt: number;
}

interface Interface {
  readonly address: string;
  readonly broadcast: string | null;
}

function localInterfaces(): readonly Interface[] {
  const found: Interface[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      found.push({ address: entry.address, broadcast: broadcastOf(entry.address, entry.netmask) });
    }
  }
  return found;
}

function broadcastOf(address: string, netmask: string): string | null {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  const mask = netmask.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || mask.length !== 4 || [...parts, ...mask].some((value) => !Number.isInteger(value))) {
    return null;
  }
  return parts.map((part, index) => (part | (~(mask[index] ?? 0) & 255)) >>> 0).join('.');
}

export function localAddresses(): readonly string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === 'IPv4') addresses.push(entry.address);
      else if (entry.family === 'IPv6' && !entry.address.startsWith('fe80')) addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

let socket: Socket | null = null;
let announcer: NodeJS.Timeout | null = null;
let scanUntil = 0;
let source: (() => AnnounceInfo | null) | null = null;
let notify: (() => void) | null = null;
const seen = new Map<string, SeenPeer>();

export function setDiscoveryReporter(next: (() => void) | null): void {
  notify = next;
}

function payloadOf(kind: 'announce' | 'query', info: AnnounceInfo | null): Buffer {
  return Buffer.from(
    JSON.stringify(
      kind === 'query'
        ? { v: REMOTE_PROTOCOL_VERSION, t: 'query' }
        : {
            v: REMOTE_PROTOCOL_VERSION,
            t: 'announce',
            id: info?.id ?? '',
            n: info?.name ?? '',
            p: info?.port ?? 0,
            f: info?.fingerprint ?? '',
            a: info?.appVersion ?? '',
          },
    ),
    'utf8',
  );
}

function parseBeacon(raw: Buffer, host: string): SeenPeer | 'query' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message['v'] !== REMOTE_PROTOCOL_VERSION) return null;
  if (message['t'] === 'query') return 'query';
  if (message['t'] !== 'announce') return null;
  const id = message['id'];
  const name = message['n'];
  const port = message['p'];
  const fingerprint = message['f'];
  const appVersion = message['a'];
  if (
    typeof id !== 'string' ||
    id === '' ||
    typeof name !== 'string' ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof fingerprint !== 'string' ||
    typeof appVersion !== 'string'
  ) {
    return null;
  }
  return { id, name, port, fingerprint, appVersion, host, seenAt: Date.now() };
}

function sendTo(payload: Buffer, host: string, port: number): void {
  socket?.send(payload, port, host, () => undefined);
}

function fanOut(payload: Buffer): void {
  sendTo(payload, REMOTE_DISCOVERY_GROUP, REMOTE_DISCOVERY_PORT);
  for (const entry of localInterfaces()) {
    if (entry.broadcast !== null) sendTo(payload, entry.broadcast, REMOTE_DISCOVERY_PORT);
  }
}

function bind(): void {
  if (socket !== null) return;
  const next = createSocket({ type: 'udp4', reuseAddr: true });
  socket = next;

  next.on('error', (error: Error) => {
    logWarn('app', `LAN 探索を止めました / LAN discovery stopped: ${describeError(error)}`);
    next.close();
    if (socket === next) socket = null;
  });

  next.on('message', (raw, info) => {
    const beacon = parseBeacon(raw, info.address);
    if (beacon === null) return;
    const mine = source?.() ?? null;
    if (beacon === 'query') {
      if (mine !== null) sendTo(payloadOf('announce', mine), info.address, REMOTE_DISCOVERY_PORT);
      return;
    }
    if (mine !== null && beacon.id === mine.id) return;
    seen.set(beacon.id, beacon);
    notify?.();
  });

  next.bind(REMOTE_DISCOVERY_PORT, () => {
    try {
      next.setBroadcast(true);
      next.setMulticastTTL(2);
      next.addMembership(REMOTE_DISCOVERY_GROUP);
    } catch {}
    for (const entry of localInterfaces()) {
      try {
        next.addMembership(REMOTE_DISCOVERY_GROUP, entry.address);
      } catch {}
    }
  });
}

function releaseIfIdle(): void {
  if (announcer !== null || Date.now() < scanUntil) return;
  const open = socket;
  socket = null;
  open?.close();
}

export function setAnnounceSource(next: (() => AnnounceInfo | null) | null): void {
  source = next;
}

export function startAnnouncing(): void {
  if (announcer !== null) return;
  bind();
  const beat = (): void => {
    const info = source?.() ?? null;
    if (info !== null) fanOut(payloadOf('announce', info));
  };
  beat();
  announcer = setInterval(beat, ANNOUNCE_INTERVAL_MS);
  announcer.unref();
}

export function stopAnnouncing(): void {
  if (announcer !== null) {
    clearInterval(announcer);
    announcer = null;
  }
  releaseIfIdle();
}

export function startScan(): void {
  bind();
  scanUntil = Date.now() + SCAN_MS;
  fanOut(payloadOf('query', null));
  setTimeout(() => {
    releaseIfIdle();
    notify?.();
  }, SCAN_MS + 200).unref();
}

export function isScanning(): boolean {
  return Date.now() < scanUntil;
}

export function discoveredPeers(): readonly SeenPeer[] {
  const cutoff = Date.now() - STALE_MS;
  for (const [id, peer] of seen) {
    if (peer.seenAt < cutoff) seen.delete(id);
  }
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function stopDiscovery(): void {
  stopAnnouncing();
  scanUntil = 0;
  releaseIfIdle();
  seen.clear();
}
