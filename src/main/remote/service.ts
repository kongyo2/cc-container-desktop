import {
  DEFAULT_REMOTE_PORT,
  decodeRemoteTicket,
  encodeRemoteTicket,
  formatRemoteAddress,
  normalizeRemoteName,
  parseRemoteAddress,
} from '../../shared/remote.ts';
import type {
  RemoteAddress,
  RemoteClientView,
  RemoteConnectRequest,
  RemoteDiscoveredView,
  RemoteHostingPatch,
  RemoteHostingView,
  RemoteInviteView,
  RemotePairRequest,
  RemotePeerView,
  RemoteStatus,
  RemoteTicket,
} from '../../shared/remote.ts';
import { remoteOriginOrNull, setRemoteRouter } from '../commands.ts';
import { closeStaleLocalTerminals } from '../docker/terminal.ts';
import { setRemoteEventSink } from '../events.ts';
import { AppFailure, describeError } from '../errors.ts';
import { logInfo, logWarn, notifyStateChanged } from '../logger.ts';
import type { RemoteChannel } from './channel.ts';
import { RemoteLink, handshake } from './client.ts';
import type { Connected, LinkTarget } from './client.ts';
import {
  discoveredPeers,
  isScanning,
  localAddresses,
  setAnnounceSource,
  setDiscoveryReporter,
  startAnnouncing,
  startScan,
  stopAnnouncing,
  stopDiscovery,
} from './discovery.ts';
import type { AnnounceInfo } from './discovery.ts';
import {
  currentFingerprint,
  ensureTlsMaterial,
  findPeer,
  forgetPeer,
  instanceName,
  listClients,
  listPeers,
  newPairingCode,
  peerToken,
  rememberPeer,
  remoteState,
  revokeClient,
  touchPeer,
  updateRemoteState,
} from './identity.ts';
import { isPairingCode } from './schema.ts';
import {
  activeInvite,
  hostSession,
  hostSessions,
  hostingPort,
  hostingProblem,
  isHosting,
  remoteEventSink,
  setInvite,
  startHosting,
  stopHosting,
} from './server.ts';

const INVITE_LIFETIME_MS = 10 * 60_000;

let version = '0.0.0';

const link = new RemoteLink(notifyStateChanged, (peerId, address) => touchPeer(peerId, address));

function announceInfo(): AnnounceInfo | null {
  const state = remoteState();
  const port = hostingPort();
  const fingerprint = currentFingerprint();
  if (!state.enabled || !state.discovery || port === null || fingerprint === null) return null;
  return { id: state.instanceId, name: instanceName(), port, fingerprint, appVersion: version };
}

function refreshAnnouncing(): void {
  if (announceInfo() === null) stopAnnouncing();
  else startAnnouncing();
}

export async function initRemote(appVersion: string): Promise<void> {
  version = appVersion;
  setRemoteEventSink(remoteEventSink);
  setRemoteRouter(link);
  setAnnounceSource(announceInfo);
  setDiscoveryReporter(notifyStateChanged);

  if (!remoteState().enabled) return;
  try {
    await startHosting(remoteState().port, version, notifyStateChanged);
    refreshAnnouncing();
  } catch (error) {
    logWarn('app', `リモート受け入れを開始できません / could not start hosting: ${describeError(error)}`);
  }
}

export async function shutdownRemote(): Promise<void> {
  link.disengage();
  stopDiscovery();
  await stopHosting();
}

function hostAddresses(port: number): readonly string[] {
  return localAddresses().map((host) => formatRemoteAddress({ host, port }));
}

function inviteView(): RemoteInviteView | null {
  const open = activeInvite();
  const fingerprint = currentFingerprint();
  const port = hostingPort();
  if (open === null || fingerprint === null || port === null) return null;
  const ticket: RemoteTicket = {
    instanceId: remoteState().instanceId,
    name: instanceName(),
    fingerprint,
    port,
    addresses: hostAddresses(port).slice(0, 8),
    code: open.code,
  };
  return { code: open.code, ticket: encodeRemoteTicket(ticket), expiresAt: new Date(open.expiresAt).toISOString() };
}

function hostingView(): RemoteHostingView {
  const state = remoteState();
  const port = hostingPort();
  const online = new Set(hostSessions().map((session) => session.clientId));
  const clients: readonly RemoteClientView[] = listClients().map((client) => ({
    id: client.id,
    name: client.name,
    pairedAt: client.pairedAt,
    lastSeenAt: client.lastSeenAt,
    lastAddress: client.lastAddress,
    online: online.has(client.id),
  }));
  return {
    enabled: state.enabled,
    listening: isHosting(),
    port: state.port,
    boundPort: port,
    discovery: state.discovery,
    addresses: hostAddresses(port ?? state.port),
    problem: hostingProblem(),
    invite: inviteView(),
    clients,
  };
}

function peerViews(): readonly RemotePeerView[] {
  return [...listPeers()]
    .sort((left, right) => (right.lastConnectedAt ?? '').localeCompare(left.lastConnectedAt ?? ''))
    .map((peer) => ({
      id: peer.id,
      name: peer.name,
      fingerprint: peer.fingerprint,
      addresses: peer.addresses,
      lastConnectedAt: peer.lastConnectedAt,
    }));
}

function discoveredViews(): readonly RemoteDiscoveredView[] {
  const known = new Set(listPeers().map((peer) => peer.id));
  const self = remoteState().instanceId;
  return discoveredPeers()
    .filter((peer) => peer.id !== self)
    .map((peer) => ({
      id: peer.id,
      name: peer.name,
      host: peer.host,
      port: peer.port,
      fingerprint: peer.fingerprint,
      appVersion: peer.appVersion,
      paired: known.has(peer.id),
    }));
}

export function remoteStatus(): RemoteStatus {
  return {
    identity: {
      instanceId: remoteState().instanceId,
      name: instanceName(),
      fingerprint: currentFingerprint() ?? '',
    },
    hosting: hostingView(),
    link: link.view(),
    peers: peerViews(),
    discovered: discoveredViews(),
    scanning: isScanning(),
  };
}

export function linkChannel(): RemoteChannel {
  const channel = link.liveChannel;
  if (channel === null) {
    throw new AppFailure('REMOTE_OFFLINE', 'リモートにつながっていません / not connected to a remote instance', {
      retryable: true,
    });
  }
  return channel;
}

export function controllerChannel(): RemoteChannel {
  const origin = remoteOriginOrNull();
  const session = origin === null ? null : hostSession(origin.sessionId);
  if (session === null) {
    throw new AppFailure(
      'REMOTE_DENIED',
      'この操作はリモート接続からのみ使えます / this request only makes sense over a remote link',
    );
  }
  return session.channel;
}

function guardLockout(patch: RemoteHostingPatch): void {
  if (remoteOriginOrNull() === null) return;
  const state = remoteState();
  if (patch.enabled === false || (patch.port !== undefined && patch.port !== state.port)) {
    throw new AppFailure(
      'REMOTE_DENIED',
      'リモートからは受け入れの停止とポート変更はできません。その PC で操作してください / hosting cannot be switched off or moved from a remote session, because that would lock you out; do it on that machine',
    );
  }
}

export async function applyHosting(patch: RemoteHostingPatch): Promise<void> {
  guardLockout(patch);
  const before = remoteState();
  const name = patch.name === undefined ? before.name : normalizeRemoteName(patch.name);
  const state = updateRemoteState({
    enabled: patch.enabled ?? before.enabled,
    port: patch.port ?? before.port,
    discovery: patch.discovery ?? before.discovery,
    name: name === '' ? before.name : name,
  });

  const restart = state.enabled && (!isHosting() || state.port !== (hostingPort() ?? state.port));
  if (!state.enabled) {
    await stopHosting();
    stopAnnouncing();
    logInfo('app', 'リモート受け入れを止めました / hosting is off');
  } else if (restart) {
    await startHosting(state.port, version, notifyStateChanged);
  }
  refreshAnnouncing();
}

export async function issueInvite(): Promise<void> {
  const state = remoteState();
  if (!state.enabled || !isHosting()) {
    updateRemoteState({ enabled: true });
    await startHosting(state.port, version, notifyStateChanged);
    refreshAnnouncing();
  }
  await ensureTlsMaterial();
  setInvite({ code: newPairingCode(), expiresAt: Date.now() + INVITE_LIFETIME_MS, attempts: 0 });
  logInfo('app', 'ペアリングコードを出しました / a pairing code is open for 10 minutes');
}

export function cancelInvite(): void {
  setInvite(null);
}

export function revokePairedClient(clientId: string): void {
  const origin = remoteOriginOrNull();
  if (origin !== null && origin.clientId === clientId) {
    throw new AppFailure(
      'REMOTE_DENIED',
      '今つないでいるこの端末は、リモートからは解除できません / the machine you are connected from cannot revoke itself remotely',
    );
  }
  for (const session of hostSessions()) {
    if (session.clientId === clientId) session.channel.close('access revoked');
  }
  revokeClient(clientId);
  logInfo('app', `リモート端末の登録を解除しました / revoked a paired machine: ${clientId}`);
}

function pairingCandidates(ticket: RemoteTicket | null, typed: string): readonly RemoteAddress[] {
  const found: RemoteAddress[] = [];
  const seen = new Set<string>();
  const add = (address: RemoteAddress | null): void => {
    if (address === null) return;
    const key = formatRemoteAddress(address);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(address);
  };
  add(parseRemoteAddress(typed, ticket?.port ?? DEFAULT_REMOTE_PORT));
  for (const address of ticket?.addresses ?? []) add(parseRemoteAddress(address, ticket?.port ?? DEFAULT_REMOTE_PORT));
  return found;
}

export async function pairWithPeer(request: RemotePairRequest): Promise<void> {
  const ticket = request.ticket.trim() === '' ? null : decodeRemoteTicket(request.ticket);
  if (request.ticket.trim() !== '' && ticket === null) {
    throw new AppFailure(
      'INVALID_INPUT',
      '招待コードを読めません。相手の画面からコピーし直してください / that invitation could not be read; copy it again from the other machine',
    );
  }
  const code = request.code === '' ? (ticket?.code ?? '') : request.code;
  if (!isPairingCode(code)) {
    throw new AppFailure(
      'INVALID_INPUT',
      'ペアリングコードを入れてください / enter the pairing code shown on the other machine',
    );
  }
  const candidates = pairingCandidates(ticket, request.address);
  if (candidates.length === 0) {
    throw new AppFailure(
      'INVALID_INPUT',
      'つなぎ先が分かりません。招待コードを貼るか、アドレスを入れてください / no address to try; paste the invitation or type an address',
    );
  }

  let failure: string | null = null;
  /* oxlint-disable no-await-in-loop -- try the addresses one at a time, first reachable wins */
  for (const address of candidates) {
    let connected: Connected | null = null;
    try {
      connected = await handshake({
        address,
        expectFingerprint: ticket?.fingerprint ?? null,
        credentials: { kind: 'pair', code },
        peerLabel: ticket?.name ?? formatRemoteAddress(address),
      });
      const credentials = connected.credentials;
      if (credentials === null) throw new AppFailure('REMOTE_ERROR', 'pairing returned no credentials');
      const reached = connected.address;
      const addresses = [reached, ...(ticket?.addresses ?? [])];
      const peer = rememberPeer({
        id: connected.peerId,
        name: connected.peerName,
        fingerprint: connected.fingerprint,
        addresses,
        token: credentials.token,
        clientId: credentials.clientId,
      });
      link.adopt(
        {
          peerId: peer.id,
          peerName: peer.name,
          fingerprint: peer.fingerprint,
          clientId: credentials.clientId,
          token: credentials.token,
          addresses: [reached, ...peer.addresses.filter((known) => known !== reached)],
          defaultPort: DEFAULT_REMOTE_PORT,
        },
        connected,
      );
      releaseStaleTerminals();
      logInfo('app', `ペアリングしました / paired with ${connected.peerName} (${connected.address})`);
      return;
    } catch (error) {
      failure = describeError(error);
      connected?.channel.close(failure);
    }
  }
  /* oxlint-enable no-await-in-loop */
  throw new AppFailure('REMOTE_ERROR', `ペアリングできませんでした / pairing failed: ${failure ?? 'unreachable'}`, {
    retryable: true,
  });
}

function targetOf(peerId: string, preferred: string): LinkTarget | null {
  const peer = findPeer(peerId);
  if (peer === null) return null;
  const token = peerToken(peer);
  const addresses = preferred === '' ? peer.addresses : [preferred, ...peer.addresses.filter((a) => a !== preferred)];
  return {
    peerId: peer.id,
    peerName: peer.name,
    fingerprint: peer.fingerprint,
    clientId: peer.clientId,
    token,
    addresses,
    defaultPort: DEFAULT_REMOTE_PORT,
  };
}

export function connectToPeer(request: RemoteConnectRequest): void {
  const target = targetOf(request.peerId, request.address.trim());
  if (target === null) {
    throw new AppFailure('INVALID_INPUT', `登録されていない接続先です / no such saved machine: ${request.peerId}`);
  }
  if (target.token === '') {
    throw new AppFailure(
      'REMOTE_REJECTED',
      `${target.peerName}: 接続鍵を読めないので、ペアリングし直してください / the saved access token could not be read; pair with this machine again`,
    );
  }
  link.engage(target);
  releaseStaleTerminals();
}

function releaseStaleTerminals(): void {
  void closeStaleLocalTerminals().catch(() => undefined);
}

export function disconnectPeer(): void {
  link.disengage();
  releaseStaleTerminals();
}

export function forgetPeerRecord(peerId: string): void {
  if (link.view().peerId === peerId) link.disengage();
  forgetPeer(peerId);
}

export function scanForPeers(): void {
  startScan();
  notifyStateChanged();
}
