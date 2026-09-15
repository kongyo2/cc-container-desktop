import { randomUUID } from 'node:crypto';
import { connect } from 'node:tls';
import type { TLSSocket } from 'node:tls';

import { EVENTS } from '../../shared/ipc.ts';
import { REMOTE_PROTOCOL_VERSION, formatRemoteAddress, parseRemoteAddress } from '../../shared/remote.ts';
import type { RemoteAddress, RemoteLinkState, RemoteLinkView } from '../../shared/remote.ts';
import type { LogLine } from '../../shared/types.ts';
import type { RemoteRouter } from '../commands.ts';
import { AppFailure, describeError } from '../errors.ts';
import { logInfo, logWarn } from '../logger.ts';
import { broadcast } from '../window.ts';
import { RemoteChannel } from './channel.ts';
import { certificateFingerprint, instanceName, newClientId } from './identity.ts';
import { pairingProof } from './pairing.ts';
import type { EventMessage, HelloMessage, RemoteMessage } from './protocol.ts';

const CONNECT_TIMEOUT_MS = 8_000;

const HELLO_TIMEOUT_MS = 12_000;

const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

interface PairedCredentials {
  readonly clientId: string;
  readonly token: string;
}

export interface Connected {
  readonly channel: RemoteChannel;
  readonly peerId: string;
  readonly peerName: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly fingerprint: string;
  readonly address: string;
  readonly credentials: PairedCredentials | null;
}

type Credentials =
  | { readonly kind: 'auth'; readonly clientId: string; readonly token: string }
  | { readonly kind: 'pair'; readonly code: string };

function openSocket(address: RemoteAddress): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = connect({
      host: address.host,
      port: address.port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      timeout: CONNECT_TIMEOUT_MS,
    });
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error('接続がタイムアウトしました / the connection timed out')));
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      socket.off('error', fail);
      socket.on('error', () => undefined);
      resolve(socket);
    });
  });
}

function peerFingerprint(socket: TLSSocket): string {
  const certificate = socket.getPeerCertificate();
  const printed = typeof certificate.fingerprint256 === 'string' ? certificate.fingerprint256 : '';
  if (printed !== '') return printed.replaceAll(':', '').toLowerCase();
  const raw = certificate.raw;
  if (raw === undefined) throw new Error('相手の証明書を読めません / the other side presented no certificate');
  return certificateFingerprint(`-----BEGIN CERTIFICATE-----\n${raw.toString('base64')}\n-----END CERTIFICATE-----\n`);
}

export interface HandshakeOptions {
  readonly address: RemoteAddress;
  readonly expectFingerprint: string | null;
  readonly credentials: Credentials;
  readonly peerLabel: string;
}

export async function handshake(options: HandshakeOptions): Promise<Connected> {
  const socket = await openSocket(options.address);

  let fingerprint: string;
  try {
    fingerprint = peerFingerprint(socket);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  if (options.expectFingerprint !== null && options.expectFingerprint !== fingerprint) {
    socket.destroy();
    throw new AppFailure(
      'REMOTE_REJECTED',
      '相手の証明書が登録済みのものと違います。別の機械につながっているかもしれません / the certificate does not match the one saved for this machine; you may be talking to something else',
    );
  }

  let onControl: (message: RemoteMessage) => void = () => undefined;
  let live = false;
  const channel = new RemoteChannel(socket, {
    onEvent: (message) => relayEvent(options.peerLabel, message),
    onControl: (message) => onControl(message),
    onClose: (reason) => {
      if (!live) onControl({ t: 'denied', reason: 'internal', message: reason ?? 'closed' });
    },
  });

  const waitFor = <T extends RemoteMessage>(
    want: (message: RemoteMessage) => T | null,
    timeoutMs: number,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        onControl = () => undefined;
        reject(new Error('相手が応答しません / the other side did not answer'));
      }, timeoutMs);
      timer.unref();
      onControl = (message): void => {
        if (message.t === 'denied') {
          clearTimeout(timer);
          onControl = () => undefined;
          reject(new AppFailure('REMOTE_REJECTED', message.message));
          return;
        }
        const matched = want(message);
        if (matched === null) return;
        clearTimeout(timer);
        onControl = () => undefined;
        resolve(matched);
      };
    });

  try {
    const hello = await waitFor<HelloMessage>((message) => (message.t === 'hello' ? message : null), HELLO_TIMEOUT_MS);
    if (hello.protocol !== REMOTE_PROTOCOL_VERSION) {
      throw new AppFailure(
        'REMOTE_REJECTED',
        `相手のバージョンが違います / the other side speaks protocol ${hello.protocol}, this one speaks ${REMOTE_PROTOCOL_VERSION}; update both machines`,
      );
    }

    const address = formatRemoteAddress(options.address);
    if (options.credentials.kind === 'auth') {
      channel.send({
        t: 'auth',
        clientId: options.credentials.clientId,
        clientName: instanceName(),
        token: options.credentials.token,
      });
      const welcome = await waitFor((message) => (message.t === 'welcome' ? message : null), HELLO_TIMEOUT_MS);
      live = true;
      return {
        channel,
        peerId: welcome.instanceId,
        peerName: welcome.name,
        appVersion: welcome.appVersion,
        platform: welcome.platform,
        fingerprint,
        address,
        credentials: null,
      };
    }

    const clientId = newClientId();
    const nonce = randomUUID();
    channel.send({
      t: 'pair',
      clientId,
      clientName: instanceName(),
      nonce,
      proof: pairingProof(options.credentials.code, 'client', fingerprint, [hello.nonce, nonce, clientId]),
    });
    const paired = await waitFor((message) => (message.t === 'paired' ? message : null), HELLO_TIMEOUT_MS);
    if (
      paired.proof !== pairingProof(options.credentials.code, 'server', fingerprint, [hello.nonce, nonce, clientId])
    ) {
      throw new AppFailure(
        'REMOTE_REJECTED',
        '相手がペアリングコードを証明できませんでした。接続を中止します / the other side could not prove it knows the pairing code, so the connection was dropped',
      );
    }
    live = true;
    return {
      channel,
      peerId: paired.instanceId,
      peerName: paired.name,
      appVersion: paired.appVersion,
      platform: paired.platform,
      fingerprint,
      address,
      credentials: { clientId: paired.clientId, token: paired.token },
    };
  } catch (error) {
    channel.close(describeError(error));
    throw error;
  }
}

export interface LinkTarget {
  readonly peerId: string;
  readonly peerName: string;
  readonly fingerprint: string;
  readonly clientId: string;
  readonly token: string;
  readonly addresses: readonly string[];
  readonly defaultPort: number;
}

export class RemoteLink implements RemoteRouter {
  private target: LinkTarget | null = null;
  private channel: RemoteChannel | null = null;
  private status: RemoteLinkState = 'offline';
  private generation = 0;
  private epochCount = 0;
  private attempts = 0;
  private failure: string | null = null;
  private since: string | null = null;
  private address: string | null = null;
  private peerVersion: string | null = null;
  private peerPlatform: string | null = null;
  private retry: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private readonly onChange: () => void;
  private readonly onConnected: (peerId: string, address: string) => void;

  constructor(onChange: () => void, onConnected: (peerId: string, address: string) => void) {
    this.onChange = onChange;
    this.onConnected = onConnected;
  }

  get engaged(): boolean {
    return this.target !== null;
  }

  get online(): boolean {
    return this.channel !== null && !this.channel.closed;
  }

  get routeGeneration(): number {
    return this.generation;
  }

  get liveChannel(): RemoteChannel | null {
    return this.online ? this.channel : null;
  }

  get peerName(): string | null {
    return this.target?.peerName ?? null;
  }

  requireOnline(): void {
    if (this.online) return;
    const name = this.target?.peerName ?? 'the remote machine';
    throw new AppFailure(
      'REMOTE_OFFLINE',
      `${name} につながっていません。再接続を待つか、接続を解除してこの PC を操作してください / not connected to ${name}; wait for the link to come back, or disconnect to work on this machine again${this.failure === null ? '' : ` (${this.failure})`}`,
      { retryable: true },
    );
  }

  call(channel: string, args: readonly unknown[], timeoutMs?: number | null): Promise<unknown> {
    const live = this.liveChannel;
    if (live === null) {
      this.requireOnline();
      throw new AppFailure('REMOTE_OFFLINE', 'not connected');
    }
    return timeoutMs === undefined ? live.call(channel, args) : live.call(channel, args, timeoutMs);
  }

  view(): RemoteLinkView {
    return {
      state: this.status,
      epoch: this.epochCount,
      peerId: this.target?.peerId ?? null,
      peerName: this.target?.peerName ?? null,
      address: this.address,
      since: this.since,
      attempt: this.attempts,
      error: this.failure,
      peerVersion: this.peerVersion,
      peerPlatform: this.peerPlatform,
    };
  }

  engage(target: LinkTarget): void {
    this.reset();
    this.target = target;
    this.status = 'connecting';
    this.generation += 1;
    this.onChange();
    void this.run(this.generation);
  }

  adopt(target: LinkTarget, connected: Connected): void {
    this.reset();
    this.target = target;
    this.generation += 1;
    this.attach(connected, this.generation);
  }

  disengage(): void {
    const had = this.target !== null;
    this.reset();
    if (had) logInfo('app', 'リモート接続を解除しました / the remote link was released');
    this.onChange();
  }

  private reset(): void {
    this.generation += 1;
    this.target = null;
    this.status = 'offline';
    this.failure = null;
    this.attempts = 0;
    this.since = null;
    this.address = null;
    this.peerVersion = null;
    this.peerPlatform = null;
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.wake?.();
    this.wake = null;
    const open = this.channel;
    this.channel = null;
    if (open !== null) {
      this.epochCount += 1;
      open.close('disconnected by the operator');
    }
  }

  private candidates(target: LinkTarget): readonly RemoteAddress[] {
    const seen = new Set<string>();
    const list: RemoteAddress[] = [];
    for (const raw of target.addresses) {
      const parsed = parseRemoteAddress(raw, target.defaultPort);
      if (parsed === null) continue;
      const key = formatRemoteAddress(parsed);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(parsed);
    }
    return list;
  }

  private attach(connected: Connected, generation: number): void {
    this.channel = connected.channel;
    this.status = 'online';
    this.failure = null;
    this.attempts = 0;
    this.since = new Date().toISOString();
    this.address = connected.address;
    this.peerVersion = connected.appVersion;
    this.peerPlatform = connected.platform;
    this.epochCount += 1;
    connected.channel.socket.once('close', () => this.dropped(connected.channel, generation));
    logInfo('app', `リモートを操作しています / driving ${connected.peerName} at ${connected.address}`);
    this.onChange();
    try {
      this.onConnected(connected.peerId, connected.address);
    } catch (error) {
      logWarn('app', `接続先の記録を更新できませんでした / could not record this connection: ${describeError(error)}`);
    }
    if (connected.channel.closed) this.dropped(connected.channel, generation);
  }

  private dropped(channel: RemoteChannel, generation: number): void {
    if (this.generation !== generation || this.channel !== channel) return;
    this.channel = null;
    this.epochCount += 1;
    this.status = 'connecting';
    this.failure = '接続が切れました / the link dropped';
    this.since = null;
    logWarn('app', 'リモート接続が切れました。つなぎ直します / the remote link dropped; reconnecting');
    this.onChange();
    void this.run(generation);
  }

  private async run(generation: number): Promise<void> {
    try {
      await this.dial(generation);
    } catch (error) {
      this.status = 'error';
      this.failure = describeError(error);
      this.onChange();
    }
  }

  private async dial(generation: number): Promise<void> {
    /* oxlint-disable no-await-in-loop -- dialling one address at a time is the whole point here */
    while (this.generation === generation && this.target !== null && this.channel === null) {
      const target = this.target;
      this.attempts += 1;
      this.status = 'connecting';
      this.onChange();

      let connected: Connected | null = null;
      let lastError: string | null = null;
      for (const address of this.candidates(target)) {
        if (this.generation !== generation) break;
        try {
          connected = await handshake({
            address,
            expectFingerprint: target.fingerprint,
            credentials: { kind: 'auth', clientId: target.clientId, token: target.token },
            peerLabel: target.peerName,
          });
          break;
        } catch (error) {
          lastError = describeError(error);
        }
      }

      if (this.generation !== generation) {
        connected?.channel.close('superseded');
        return;
      }
      if (connected !== null && !connected.channel.closed) {
        this.attach(connected, generation);
        return;
      }

      this.status = 'error';
      this.failure = lastError ?? '接続できません / could not reach that machine';
      this.onChange();
      const wait = BACKOFF_MS[Math.min(this.attempts - 1, BACKOFF_MS.length - 1)] ?? 30_000;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.retry = setTimeout(resolve, wait);
        this.retry.unref();
      });
    }
    /* oxlint-enable no-await-in-loop */
  }
}

function relayEvent(peerLabel: string, message: EventMessage): void {
  if (message.channel === EVENTS.log) {
    const line = message.payload as LogLine | null;
    if (line !== null && typeof line === 'object' && typeof line.text === 'string') {
      broadcast(EVENTS.log, { ...line, text: `[${peerLabel}] ${line.text}` });
      return;
    }
  }
  broadcast(message.channel, message.payload);
}
