import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';

import { generate } from 'selfsigned';

import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, normalizeRemoteName } from '../../shared/remote.ts';
import { AppFailure, describeError } from '../errors.ts';
import { logWarn } from '../logger.ts';
import { statePath } from '../paths.ts';
import { StateFile } from '../state/file.ts';
import { openSecret, sealSecret } from '../state/secret.ts';
import { defaultRemoteState, readRemoteState } from './schema.ts';
import type { RemoteClientRecord, RemotePeerRecord, RemoteState } from './schema.ts';

const CERT_YEARS = 10;

const stateFile = new StateFile<RemoteState>({
  path: () => statePath('remote.json'),
  label: 'リモート接続の設定 (remote.json) / the remote link store (remote.json)',
  parse: readRemoteState,
  initial: defaultRemoteState,
  serialize: (state) => state,
  persistInitial: false,
});

export function remoteState(): RemoteState {
  return stateFile.get();
}

export function remoteStoreProblem(): string | null {
  return stateFile.problem;
}

export function updateRemoteState(patch: Partial<RemoteState>): RemoteState {
  return stateFile.set({ ...stateFile.get(), ...patch });
}

export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
  readonly fingerprint: string;
}

export function certificateFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
}

let material: TlsMaterial | null = null;

async function createMaterial(name: string): Promise<TlsMaterial> {
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime());
  notAfterDate.setFullYear(notAfterDate.getFullYear() + CERT_YEARS);

  const pems = await generate([{ name: 'commonName', value: name === '' ? 'cc-container-desktop' : name }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'cc-container-desktop' },
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
  return { cert: pems.cert, key: pems.private, fingerprint: certificateFingerprint(pems.cert) };
}

export async function ensureTlsMaterial(): Promise<TlsMaterial> {
  if (material !== null) return material;

  const state = remoteState();
  if (state.tls !== null) {
    const key = openSecret(state.tls.key, 'リモート接続の秘密鍵 / the remote link private key');
    if (key !== '') {
      try {
        material = { cert: state.tls.cert, key, fingerprint: certificateFingerprint(state.tls.cert) };
        return material;
      } catch (error) {
        logWarn('app', `保存された証明書を読めません / the stored certificate is unreadable: ${describeError(error)}`);
      }
    } else {
      logWarn(
        'app',
        'リモート接続の秘密鍵を復号できないので、新しい鍵を作ります。ペアリング済みの相手は登録し直してください / the remote private key could not be decrypted, so a new identity is being minted; paired machines have to be paired again',
      );
    }
  }

  const fresh = await createMaterial(state.name);
  updateRemoteState({
    tls: { cert: fresh.cert, key: sealSecret(fresh.key) },
    clients: state.tls === null ? state.clients : [],
  });
  material = fresh;
  return fresh;
}

export function currentFingerprint(): string | null {
  if (material !== null) return material.fingerprint;
  const state = remoteState();
  if (state.tls === null) return null;
  try {
    return certificateFingerprint(state.tls.cert);
  } catch {
    return null;
  }
}

export function instanceName(): string {
  const name = normalizeRemoteName(remoteState().name);
  return name === '' ? 'workbench' : name;
}

export function instanceId(): string {
  return remoteState().instanceId;
}

export function newPairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let code = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_CODE_ALPHABET[(bytes[index] ?? 0) % PAIRING_CODE_ALPHABET.length] ?? '2';
  }
  return code;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newClientId(): string {
  return `cli_${randomBytes(8).toString('hex')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatches(token: string, hash: string): boolean {
  const offered = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(hash, 'hex');
  return offered.length === stored.length && timingSafeEqual(offered, stored);
}

export function listClients(): readonly RemoteClientRecord[] {
  return remoteState().clients;
}

export function findClient(clientId: string): RemoteClientRecord | null {
  return remoteState().clients.find((client) => client.id === clientId) ?? null;
}

export function rememberClient(record: RemoteClientRecord): void {
  const clients = remoteState().clients.filter((client) => client.id !== record.id);
  updateRemoteState({ clients: [...clients, record] });
}

export function touchClient(clientId: string, address: string): void {
  const state = remoteState();
  const index = state.clients.findIndex((client) => client.id === clientId);
  const client = state.clients[index];
  if (index === -1 || client === undefined) return;
  const clients = [...state.clients];
  clients[index] = { ...client, lastSeenAt: new Date().toISOString(), lastAddress: address };
  updateRemoteState({ clients });
}

export function revokeClient(clientId: string): void {
  const state = remoteState();
  if (!state.clients.some((client) => client.id === clientId)) {
    throw new AppFailure('INVALID_INPUT', `その端末は登録されていません / no such paired machine: ${clientId}`);
  }
  updateRemoteState({ clients: state.clients.filter((client) => client.id !== clientId) });
}

export function listPeers(): readonly RemotePeerRecord[] {
  return remoteState().peers;
}

export function findPeer(peerId: string): RemotePeerRecord | null {
  return remoteState().peers.find((peer) => peer.id === peerId) ?? null;
}

export function peerToken(peer: RemotePeerRecord): string {
  return openSecret(peer.token, `${peer.name} の接続鍵 / the access token for ${peer.name}`);
}

export interface PeerDraft {
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly addresses: readonly string[];
  readonly token: string;
  readonly clientId: string;
}

export function rememberPeer(draft: PeerDraft): RemotePeerRecord {
  const state = remoteState();
  const existing = state.peers.find((peer) => peer.id === draft.id) ?? null;
  const addresses = [...new Set([...draft.addresses, ...(existing?.addresses ?? [])])].slice(0, 12);
  const record: RemotePeerRecord = {
    id: draft.id,
    name: draft.name,
    fingerprint: draft.fingerprint,
    addresses,
    token: sealSecret(draft.token),
    clientId: draft.clientId,
    lastConnectedAt: existing?.lastConnectedAt ?? null,
  };
  updateRemoteState({ peers: [...state.peers.filter((peer) => peer.id !== draft.id), record] });
  return record;
}

export function touchPeer(peerId: string, address: string): void {
  const state = remoteState();
  const index = state.peers.findIndex((peer) => peer.id === peerId);
  const peer = state.peers[index];
  if (index === -1 || peer === undefined) return;
  const peers = [...state.peers];
  peers[index] = {
    ...peer,
    lastConnectedAt: new Date().toISOString(),
    addresses: [address, ...peer.addresses.filter((known) => known !== address)].slice(0, 12),
  };
  updateRemoteState({ peers });
}

export function forgetPeer(peerId: string): void {
  const state = remoteState();
  if (!state.peers.some((peer) => peer.id === peerId)) {
    throw new AppFailure('INVALID_INPUT', `その接続先は登録されていません / no such saved machine: ${peerId}`);
  }
  updateRemoteState({ peers: state.peers.filter((peer) => peer.id !== peerId) });
}
