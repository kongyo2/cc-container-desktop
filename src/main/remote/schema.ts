import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { z } from 'zod';

import {
  DEFAULT_REMOTE_PORT,
  MAX_REMOTE_NAME,
  normalizePairingCode,
  normalizeRemoteName,
  PAIRING_CODE_LENGTH,
  REMOTE_FINGERPRINT_PATTERN,
  REMOTE_INSTANCE_ID_PATTERN,
} from '../../shared/remote.ts';
import type { RemoteConnectRequest, RemoteHostingPatch, RemotePairRequest } from '../../shared/remote.ts';
import type { ParseOutcome } from '../state/file.ts';
import type { SealedSecret } from '../state/secret.ts';
import { definedFields, duplicateIdProblem, parseFailure, parseInput } from '../state/parse.ts';

const sealedSchema = z.strictObject({ enc: z.enum(['safeStorage', 'plain']), value: z.string() });

const clientSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  tokenHash: z.string().min(1),
  pairedAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }).nullable(),
  lastAddress: z.string().nullable(),
});

const peerSchema = z.strictObject({
  id: z.string().regex(REMOTE_INSTANCE_ID_PATTERN),
  name: z.string(),
  fingerprint: z.string().regex(REMOTE_FINGERPRINT_PATTERN),
  addresses: z.array(z.string()),
  token: sealedSchema,
  clientId: z.string().min(1),
  lastConnectedAt: z.string().datetime({ offset: true }).nullable(),
});

const remoteStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  instanceId: z.string().regex(REMOTE_INSTANCE_ID_PATTERN),
  name: z.string(),
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  discovery: z.boolean(),
  tls: z.strictObject({ cert: z.string(), key: sealedSchema }).nullable(),
  clients: z.array(clientSchema),
  peers: z.array(peerSchema),
});

export interface RemoteClientRecord {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly pairedAt: string;
  readonly lastSeenAt: string | null;
  readonly lastAddress: string | null;
}

export interface RemotePeerRecord {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly addresses: readonly string[];
  readonly token: SealedSecret;
  readonly clientId: string;
  readonly lastConnectedAt: string | null;
}

export interface RemoteState {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly port: number;
  readonly discovery: boolean;
  readonly tls: { readonly cert: string; readonly key: SealedSecret } | null;
  readonly clients: readonly RemoteClientRecord[];
  readonly peers: readonly RemotePeerRecord[];
}

function newRemoteInstanceId(): string {
  return `rid_${randomBytes(8).toString('hex')}`;
}

function defaultName(): string {
  const name = normalizeRemoteName(hostname());
  return name === '' ? 'workbench' : name;
}

export function defaultRemoteState(): RemoteState {
  return {
    schemaVersion: 1,
    instanceId: newRemoteInstanceId(),
    name: defaultName(),
    enabled: false,
    port: DEFAULT_REMOTE_PORT,
    discovery: true,
    tls: null,
    clients: [],
    peers: [],
  };
}

export function readRemoteState(raw: unknown): ParseOutcome<RemoteState> {
  const parsed = remoteStateSchema.safeParse(raw);
  if (!parsed.success) return parseFailure(parsed.error);
  const duplicate =
    duplicateIdProblem(parsed.data.clients, 'remote client') ?? duplicateIdProblem(parsed.data.peers, 'remote peer');
  if (duplicate !== null) return { ok: false, problem: duplicate };
  return { ok: true, value: parsed.data };
}

const hostingPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  discovery: z.boolean().optional(),
  name: z
    .string()
    .max(MAX_REMOTE_NAME * 4)
    .optional(),
});

export function parseHostingPatch(raw: unknown): RemoteHostingPatch {
  const patch = parseInput(hostingPatchSchema, raw, 'リモート設定が不正です / invalid remote settings');
  const fields = definedFields(patch) as RemoteHostingPatch;
  return fields.name === undefined ? fields : { ...fields, name: normalizeRemoteName(fields.name) };
}

const pairRequestSchema = z.strictObject({
  ticket: z.string().max(8192),
  address: z.string().max(512),
  code: z.string().max(64),
});

export function parsePairRequest(raw: unknown): RemotePairRequest {
  const request = parseInput(pairRequestSchema, raw, 'ペアリングの内容が不正です / invalid pairing request');
  return { ...request, code: normalizePairingCode(request.code) };
}

const connectRequestSchema = z.strictObject({
  peerId: z.string().regex(REMOTE_INSTANCE_ID_PATTERN),
  address: z.string().max(512),
});

export function parseConnectRequest(raw: unknown): RemoteConnectRequest {
  return parseInput(connectRequestSchema, raw, '接続先の指定が不正です / invalid connect request');
}

export function isPairingCode(code: string): boolean {
  return code.length === PAIRING_CODE_LENGTH && normalizePairingCode(code) === code;
}
