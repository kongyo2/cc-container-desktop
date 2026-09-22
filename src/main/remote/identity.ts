import { createHash, randomBytes, X509Certificate } from 'node:crypto';

import { generate } from 'selfsigned';

import { byId, withoutId } from '../../shared/collections.ts';
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, normalizeRemoteName } from '../../shared/remote.ts';
import { AppFailure, describeError } from '../errors.ts';
import { prefixedRandomId } from '../ids.ts';
import { logWarn } from '../logger.ts';
import { statePath } from '../paths.ts';
import { StateFile } from '../state/file.ts';
import { openSecret, sealSecret } from '../state/secret.ts';
import { sameSecret } from './pairing.ts';
import { defaultRemoteState, readRemoteState } from './schema.ts';
import type { RemoteClientRecord, RemotePeerRecord, RemoteState } from './schema.ts';

const CERT_YEARS = 10;

const MAX_PEER_ADDRESSES = 12;

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
  return prefixedRandomId('cli');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatches(token: string, hash: string): boolean {
  return sameSecret(Buffer.from(hashToken(token), 'hex'), Buffer.from(hash, 'hex'));
}

/** Rewrites the one record carrying `id`, or reports that the list does not hold it. */
function recordReplaced<T extends { readonly id: string }>(
  records: readonly T[],
  id: string,
  rewrite: (record: T) => T,
): readonly T[] | null {
  const index = records.findIndex((record) => record.id === id);
  const record = records[index];
  if (index === -1 || record === undefined) return null;
  return records.with(index, rewrite(record));
}

/** Drops the one record carrying `id`, refusing the whole edit when the list does not hold it. */
function recordDropped<T extends { readonly id: string }>(
  records: readonly T[],
  id: string,
  missing: string,
): readonly T[] {
  if (byId(records, id) === null) throw new AppFailure('INVALID_INPUT', missing);
  return withoutId(records, id);
}

export function listClients(): readonly RemoteClientRecord[] {
  return remoteState().clients;
}

export function findClient(clientId: string): RemoteClientRecord | null {
  return byId(remoteState().clients, clientId);
}

export function rememberClient(record: RemoteClientRecord): void {
  updateRemoteState({ clients: [...withoutId(remoteState().clients, record.id), record] });
}

export function touchClient(clientId: string, address: string): void {
  const clients = recordReplaced(remoteState().clients, clientId, (client) => ({
    ...client,
    lastSeenAt: new Date().toISOString(),
    lastAddress: address,
  }));
  if (clients !== null) updateRemoteState({ clients });
}

export function revokeClient(clientId: string): void {
  const missing = `その端末は登録されていません / no such paired machine: ${clientId}`;
  updateRemoteState({ clients: recordDropped(remoteState().clients, clientId, missing) });
}

export function listPeers(): readonly RemotePeerRecord[] {
  return remoteState().peers;
}

export function findPeer(peerId: string): RemotePeerRecord | null {
  return byId(remoteState().peers, peerId);
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
  const existing = byId(state.peers, draft.id);
  const addresses = [...new Set([...draft.addresses, ...(existing?.addresses ?? [])])].slice(0, MAX_PEER_ADDRESSES);
  const record: RemotePeerRecord = {
    id: draft.id,
    name: draft.name,
    fingerprint: draft.fingerprint,
    addresses,
    token: sealSecret(draft.token),
    clientId: draft.clientId,
    lastConnectedAt: existing?.lastConnectedAt ?? null,
  };
  updateRemoteState({ peers: [...withoutId(state.peers, draft.id), record] });
  return record;
}

export function touchPeer(peerId: string, address: string): void {
  const peers = recordReplaced(remoteState().peers, peerId, (peer) => ({
    ...peer,
    lastConnectedAt: new Date().toISOString(),
    addresses: [address, ...peer.addresses.filter((known) => known !== address)].slice(0, MAX_PEER_ADDRESSES),
  }));
  if (peers !== null) updateRemoteState({ peers });
}

export function forgetPeer(peerId: string): void {
  const missing = `その接続先は登録されていません / no such saved machine: ${peerId}`;
  updateRemoteState({ peers: recordDropped(remoteState().peers, peerId, missing) });
}
