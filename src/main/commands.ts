import { AsyncLocalStorage } from 'node:async_hooks';

import { AppFailure } from './errors.ts';

export type CommandOrigin =
  | { readonly kind: 'local' }
  | {
      readonly kind: 'remote';
      readonly sessionId: string;
      readonly clientId: string;
      readonly clientName: string;
    };

const LOCAL_ORIGIN: CommandOrigin = { kind: 'local' };

const origins = new AsyncLocalStorage<CommandOrigin>();

export function currentOrigin(): CommandOrigin {
  return origins.getStore() ?? LOCAL_ORIGIN;
}

export function remoteOriginOrNull(): Extract<CommandOrigin, { kind: 'remote' }> | null {
  const origin = currentOrigin();
  return origin.kind === 'remote' ? origin : null;
}

function runWithOrigin<T>(origin: CommandOrigin, work: () => T): T {
  return origins.run(origin, work);
}

export interface RemoteRouter {
  readonly engaged: boolean;
  readonly online: boolean;
  readonly routeGeneration: number;
  requireOnline(): void;
  call(channel: string, args: readonly unknown[], timeoutMs?: number | null): Promise<unknown>;
}

export type CommandRun = (...args: readonly unknown[]) => Promise<unknown> | unknown;

export interface CommandOptions {
  readonly local?: boolean;
  readonly denyRemote?: boolean;
  readonly adapt?: (value: unknown) => unknown;
  readonly remote?: (router: RemoteRouter, ...args: readonly unknown[]) => Promise<unknown>;
  readonly reroute?: boolean;
  readonly offlineFallback?: boolean;
  readonly timeoutMs?: number | null;
}

interface CommandEntry extends CommandOptions {
  readonly run: CommandRun;
}

const registry = new Map<string, CommandEntry>();

let router: RemoteRouter | null = null;

export function setRemoteRouter(next: RemoteRouter | null): void {
  router = next;
}

export function routeGeneration(): number {
  return router?.routeGeneration ?? 0;
}

export function drivingRemote(): boolean {
  return router?.engaged === true;
}

export function registerCommand(channel: string, run: CommandRun, options: CommandOptions = {}): void {
  registry.set(channel, { ...options, run });
}

function entryOf(channel: string): CommandEntry {
  const entry = registry.get(channel);
  if (entry === undefined) {
    throw new AppFailure('INVALID_INPUT', `知らない操作です / unknown request: ${channel}`);
  }
  return entry;
}

async function dispatch(entry: CommandEntry, channel: string, args: readonly unknown[]): Promise<unknown> {
  const active = router;
  if (entry.local === true || active === null || !active.engaged) {
    return entry.run(...args);
  }
  if (!active.online && entry.offlineFallback === true) return entry.run(...args);
  active.requireOnline();
  if (entry.remote !== undefined) return entry.remote(active, ...args);
  const value = await active.call(channel, args, entry.timeoutMs);
  return entry.adapt === undefined ? value : entry.adapt(value);
}

const REROUTE_LIMIT = 2;

export async function invokeRouted(channel: string, args: readonly unknown[], attempt: number = 0): Promise<unknown> {
  const entry = entryOf(channel);
  const generation = routeGeneration();
  const value = await dispatch(entry, channel, args);
  if (entry.reroute === true && attempt < REROUTE_LIMIT && routeGeneration() !== generation) {
    return invokeRouted(channel, args, attempt + 1);
  }
  return value;
}

export async function invokeFromRemote(
  channel: string,
  args: readonly unknown[],
  origin: CommandOrigin,
): Promise<unknown> {
  const entry = entryOf(channel);
  if (entry.denyRemote === true) {
    throw new AppFailure(
      'REMOTE_DENIED',
      `この操作はつないでいる側の PC で行ってください / this request has to run on the controlling machine, not here: ${channel}`,
    );
  }
  return runWithOrigin(origin, () => entry.run(...args));
}
