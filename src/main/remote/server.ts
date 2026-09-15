import { randomUUID } from 'node:crypto';
import { createServer } from 'node:tls';
import type { Server, TLSSocket } from 'node:tls';

import { REMOTE_PROTOCOL_VERSION } from '../../shared/remote.ts';
import type { CommandOrigin } from '../commands.ts';
import { invokeFromRemote } from '../commands.ts';
import { closeOriginTerminals } from '../docker/terminal.ts';
import type { RemoteEventSink } from '../events.ts';
import { describeError, toAppError } from '../errors.ts';
import { logInfo, logWarn } from '../logger.ts';
import { RemoteChannel } from './channel.ts';
import {
  ensureTlsMaterial,
  findClient,
  hashToken,
  instanceId,
  instanceName,
  newClientId,
  newToken,
  rememberClient,
  tokenMatches,
  touchClient,
} from './identity.ts';
import { pairingProof, sameProof } from './pairing.ts';
import type { DenyReason } from './protocol.ts';

const HANDSHAKE_TIMEOUT_MS = 20_000;

const MAX_SESSIONS = 8;

const MAX_INVITE_ATTEMPTS = 5;

export interface HostSession {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly address: string;
  readonly since: string;
  readonly channel: RemoteChannel;
}

export interface ActiveInvite {
  readonly code: string;
  readonly expiresAt: number;
  attempts: number;
}

const sessions = new Map<string, HostSession>();

let server: Server | null = null;
let boundPort: number | null = null;
let problem: string | null = null;
let invite: ActiveInvite | null = null;

export function hostSessions(): readonly HostSession[] {
  return [...sessions.values()];
}

export function hostSession(sessionId: string): HostSession | null {
  return sessions.get(sessionId) ?? null;
}

export function hostingPort(): number | null {
  return boundPort;
}

export function hostingProblem(): string | null {
  return problem;
}

export function activeInvite(): ActiveInvite | null {
  if (invite !== null && invite.expiresAt <= Date.now()) invite = null;
  return invite;
}

export function setInvite(next: ActiveInvite | null): void {
  invite = next;
}

function addressOf(socket: TLSSocket): string {
  const host = socket.remoteAddress ?? '?';
  return socket.remotePort === undefined ? host : `${host}:${socket.remotePort}`;
}

export const remoteEventSink: RemoteEventSink = {
  broadcast(channel: string, payload: unknown): void {
    for (const session of sessions.values()) session.channel.event(channel, payload);
  },
  toSession(sessionId: string, channel: string, payload: unknown): void {
    sessions.get(sessionId)?.channel.event(channel, payload);
  },
};

function originOf(session: HostSession): CommandOrigin {
  return {
    kind: 'remote',
    sessionId: session.id,
    clientId: session.clientId,
    clientName: session.clientName,
  };
}

let handshaking = 0;

function serve(socket: TLSSocket, fingerprint: string, appVersion: string, onChange: () => void): void {
  const address = addressOf(socket);
  const nonce = randomUUID();
  let session: HostSession | null = null;

  handshaking += 1;
  let counted = true;
  const settle = (): void => {
    if (!counted) return;
    counted = false;
    handshaking -= 1;
  };

  const deny = (reason: DenyReason, message: string): void => {
    settle();
    logWarn('app', `リモート接続を断りました / refused a remote connection from ${address}: ${message}`);
    channel.send({ t: 'denied', reason, message });
    setTimeout(() => channel.close(message), 50);
  };

  const channel: RemoteChannel = new RemoteChannel(socket, {
    onCall: (message) => {
      if (session === null) {
        channel.reply(message.id, {
          ok: false,
          error: { code: 'REMOTE_REJECTED', message: 'not authenticated', retryable: false },
        });
        return;
      }
      const origin = originOf(session);
      void (async () => {
        try {
          const value = await invokeFromRemote(message.channel, message.args, origin);
          channel.reply(message.id, { ok: true, value: value ?? null });
        } catch (error) {
          channel.reply(message.id, { ok: false, error: toAppError(error) });
        }
      })();
    },
    onControl: (message) => {
      if (message.t === 'auth') {
        if (session !== null) return;
        const client = findClient(message.clientId);
        if (client === null) {
          deny(
            'unknown-client',
            'この PC の登録がありません。ホスト側でペアリングし直してください / this machine is not paired any more; pair again from the host',
          );
          return;
        }
        if (!tokenMatches(message.token, client.tokenHash)) {
          deny('bad-credentials', '接続鍵が違います / the access token did not match');
          return;
        }
        session = {
          id: randomUUID(),
          clientId: client.id,
          clientName: message.clientName === '' ? client.name : message.clientName,
          address,
          since: new Date().toISOString(),
          channel,
        };
        sessions.set(session.id, session);
        settle();
        touchClient(client.id, address);
        channel.send({
          t: 'welcome',
          sessionId: session.id,
          instanceId: instanceId(),
          name: instanceName(),
          appVersion,
          platform: process.platform,
        });
        logInfo('app', `リモート操作が始まりました / a remote controller attached: ${session.clientName} (${address})`);
        onChange();
        return;
      }

      if (message.t === 'pair') {
        if (session !== null) return;
        const open = activeInvite();
        if (open === null) {
          deny(
            'no-invite',
            'ペアリングは受け付けていません。ホスト側で「ペアリングコードを出す」を押してください / this machine is not accepting pairings; press "show a pairing code" on the host',
          );
          return;
        }
        open.attempts += 1;
        const expected = pairingProof(open.code, 'client', fingerprint, [nonce, message.nonce, message.clientId]);
        if (!sameProof(expected, message.proof)) {
          if (open.attempts >= MAX_INVITE_ATTEMPTS) {
            invite = null;
            logWarn('app', 'ペアリングコードを無効にしました / the pairing code was cancelled after too many attempts');
          }
          deny('bad-credentials', 'ペアリングコードが違います / the pairing code did not match');
          return;
        }

        const token = newToken();
        const clientId = message.clientId === '' ? newClientId() : message.clientId;
        rememberClient({
          id: clientId,
          name: message.clientName,
          tokenHash: hashToken(token),
          pairedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          lastAddress: address,
        });
        invite = null;
        session = {
          id: randomUUID(),
          clientId,
          clientName: message.clientName,
          address,
          since: new Date().toISOString(),
          channel,
        };
        sessions.set(session.id, session);
        settle();
        channel.send({
          t: 'paired',
          sessionId: session.id,
          instanceId: instanceId(),
          name: instanceName(),
          appVersion,
          platform: process.platform,
          clientId,
          token,
          proof: pairingProof(open.code, 'server', fingerprint, [nonce, message.nonce, clientId]),
        });
        logInfo('app', `ペアリングしました / paired with ${message.clientName} (${address})`);
        onChange();
        return;
      }

      deny('internal', `unexpected message: ${message.t}`);
    },
    onClose: (reason) => {
      settle();
      const closed = session;
      session = null;
      if (closed === null) return;
      sessions.delete(closed.id);
      void closeOriginTerminals(originOf(closed)).catch(() => undefined);
      logInfo(
        'app',
        `リモート操作が終わりました / a remote controller detached: ${closed.clientName} (${reason ?? 'closed'})`,
      );
      onChange();
    },
  });

  channel.send({
    t: 'hello',
    protocol: REMOTE_PROTOCOL_VERSION,
    instanceId: instanceId(),
    name: instanceName(),
    appVersion,
    platform: process.platform,
    nonce,
    pairing: activeInvite() !== null,
  });

  setTimeout(() => {
    if (session === null && !channel.closed) channel.close('handshake timed out');
  }, HANDSHAKE_TIMEOUT_MS).unref();
}

let transitions: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = transitions.then(work, work);
  transitions = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function startHosting(port: number, appVersion: string, onChange: () => void): Promise<void> {
  return serialize(() => openListener(port, appVersion, onChange));
}

export function stopHosting(): Promise<void> {
  return serialize(closeListener);
}

async function openListener(port: number, appVersion: string, onChange: () => void): Promise<void> {
  await closeListener();
  const material = await ensureTlsMaterial();
  problem = null;

  const next = createServer(
    { key: material.key, cert: material.cert, minVersion: 'TLSv1.3', requestCert: false },
    (socket) => {
      if (sessions.size + handshaking >= MAX_SESSIONS) {
        socket.destroy();
        return;
      }
      serve(socket, material.fingerprint, appVersion, onChange);
    },
  );

  next.on('error', (error: Error) => {
    problem = describeError(error);
    logWarn('app', `リモート受け入れを続けられません / hosting stopped: ${problem}`);
    boundPort = null;
    onChange();
  });
  next.on('tlsClientError', () => undefined);

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => {
      next.off('listening', ready);
      reject(error);
    };
    const ready = (): void => {
      next.off('error', failed);
      resolve();
    };
    next.once('error', failed);
    next.once('listening', ready);
    next.listen(port);
  });

  server = next;
  const address = next.address();
  boundPort = typeof address === 'object' && address !== null ? address.port : port;
  logInfo('app', `リモート接続を受け付けます / hosting on port ${boundPort} (${material.fingerprint.slice(0, 16)}…)`);
}

async function closeListener(): Promise<void> {
  const running = server;
  server = null;
  boundPort = null;
  invite = null;
  for (const session of sessions.values()) session.channel.close('hosting stopped');
  sessions.clear();
  if (running === null) return;
  await new Promise<void>((resolve) => {
    running.close(() => resolve());
    setTimeout(resolve, 2000).unref();
  });
}

export function isHosting(): boolean {
  return server !== null && boundPort !== null;
}
