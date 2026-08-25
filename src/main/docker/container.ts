/**
 * Lifecycle of the single long-lived workbench container.
 *
 * One container is reused across every profile: switching profiles rewrites
 * `~/.claude/settings.json` inside it rather than spinning up a second box. The
 * container itself only idles (`sleep infinity`); all real work happens in
 * `docker exec` sessions, which is what makes reattaching to a running Claude
 * Code possible.
 */

import type { Container } from 'dockerode';
import { PassThrough } from 'node:stream';

import { CONTAINER_HOME, CONTAINER_USER, CONTAINER_WORKSPACE } from '../../shared/presets.ts';
import type { ContainerState, ExecResult, TmuxSession } from '../../shared/types.ts';
import { getConfig } from '../config/store.ts';
import { describeError, logInfo, logWarn } from '../logger.ts';
import { docker, isNotFound } from './engine.ts';

/** Marks containers and volumes this app created, so cleanup can tell them apart. */
const MANAGED_LABEL = 'com.cc-container-desktop.managed';

export function containerHandle(): Container {
  return docker().getContainer(getConfig().containerName);
}

interface InspectResponse {
  readonly Id?: string;
  readonly Image?: string;
  readonly Config?: { readonly Image?: string };
  readonly State?: { readonly Running?: boolean; readonly Status?: string; readonly StartedAt?: string };
}

export async function inspectContainer(): Promise<ContainerState> {
  const name = getConfig().containerName;
  try {
    const raw = (await containerHandle().inspect()) as InspectResponse;
    const running = raw.State?.Running === true;
    return {
      name,
      exists: true,
      running,
      status: raw.State?.Status ?? 'unknown',
      id: raw.Id ?? null,
      image: raw.Config?.Image ?? raw.Image ?? null,
      // Docker reports a zero timestamp for a container that has never started.
      startedAt: running ? (raw.State?.StartedAt ?? null) : null,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { name, exists: false, running: false, status: 'missing', id: null, image: null, startedAt: null };
    }
    throw error;
  }
}

async function ensureVolume(): Promise<void> {
  const name = getConfig().volumeName;
  try {
    await docker().getVolume(name).inspect();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    logInfo('app', `ボリュームを作成します / creating volume: ${name}`);
    await docker().createVolume({ Name: name, Labels: { [MANAGED_LABEL]: 'true' } });
  }
}

async function createContainer(): Promise<void> {
  const config = getConfig();
  await ensureVolume();
  logInfo('app', `コンテナを作成します / creating container: ${config.containerName}`);
  await docker().createContainer({
    name: config.containerName,
    Image: config.imageTag,
    Hostname: 'cc-workbench',
    User: CONTAINER_USER,
    WorkingDir: CONTAINER_WORKSPACE,
    Tty: false,
    OpenStdin: false,
    Env: ['TERM=xterm-256color', 'LANG=C.UTF-8'],
    Labels: { [MANAGED_LABEL]: 'true' },
    Cmd: ['sleep', 'infinity'],
    HostConfig: {
      Binds: [`${config.volumeName}:${CONTAINER_HOME}`],
      Init: true,
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });
}

/** Creates the container if needed, then starts it. Safe to call when already running. */
export async function startContainer(): Promise<ContainerState> {
  let state = await inspectContainer();

  if (state.exists && state.image !== null && state.image !== getConfig().imageTag) {
    // The image tag changed under a container that still points at the old one;
    // recreate rather than silently keeping the stale image.
    logInfo(
      'app',
      `イメージが変わったのでコンテナを作り直します / recreating container for image ${getConfig().imageTag}`,
    );
    await removeContainer(false);
    state = await inspectContainer();
  }

  if (!state.exists) {
    await createContainer();
    state = await inspectContainer();
  }
  if (!state.running) {
    await containerHandle().start();
    logInfo('app', 'コンテナを起動しました / container started');
  }
  return inspectContainer();
}

export async function stopContainer(): Promise<ContainerState> {
  const state = await inspectContainer();
  if (state.running) {
    await containerHandle().stop({ t: 5 });
    logInfo('app', 'コンテナを停止しました / container stopped');
  }
  return inspectContainer();
}

export async function restartContainer(): Promise<ContainerState> {
  const state = await inspectContainer();
  if (!state.exists) return startContainer();
  await containerHandle().restart({ t: 5 });
  logInfo('app', 'コンテナを再起動しました / container restarted');
  return inspectContainer();
}

export async function removeContainer(removeVolume: boolean): Promise<ContainerState> {
  const config = getConfig();
  const state = await inspectContainer();
  if (state.exists) {
    await containerHandle().remove({ force: true, v: false });
    logInfo('app', `コンテナを削除しました / container removed: ${config.containerName}`);
  }
  if (removeVolume) {
    try {
      await docker().getVolume(config.volumeName).remove();
      logInfo('app', `ボリュームを削除しました / volume removed: ${config.volumeName}`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return inspectContainer();
}

export interface ExecOptions {
  readonly asRoot?: boolean;
  readonly workdir?: string;
  readonly env?: readonly string[];
  readonly stdin?: string;
}

/**
 * Runs a command to completion and captures its output.
 *
 * Deliberately not a TTY: with `Tty: true` Docker merges stdout and stderr into
 * one stream and injects carriage returns, which is exactly wrong for anything
 * the app has to parse.
 */
export async function execCapture(command: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  const container = containerHandle();
  const wantsStdin = options.stdin !== undefined;
  const exec = await container.exec({
    Cmd: [...command],
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: wantsStdin,
    Tty: false,
    User: options.asRoot === true ? 'root' : CONTAINER_USER,
    WorkingDir: options.workdir ?? CONTAINER_WORKSPACE,
    Env: options.env === undefined ? [] : [...options.env],
  });

  const stream = await exec.start({ hijack: wantsStdin, stdin: wantsStdin, Tty: false });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
  stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
  docker().modem.demuxStream(stream, stdout, stderr);

  if (options.stdin !== undefined) {
    stream.write(options.stdin);
    stream.end();
  }

  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', reject);
  });

  // The demuxed halves are separate streams: the source ending does not mean
  // their `data` events have all fired yet. Wait for each to drain, or the last
  // few bytes of output go missing at random.
  const drained = (channel: PassThrough): Promise<void> =>
    new Promise<void>((resolve) => {
      if (channel.writableEnded) {
        resolve();
        return;
      }
      channel.end(() => resolve());
    });
  await Promise.all([drained(stdout), drained(stderr)]);

  const info = (await exec.inspect()) as { ExitCode?: number | null };
  return {
    exitCode: info.ExitCode ?? 0,
    stdout: Buffer.concat(outChunks).toString('utf8'),
    stderr: Buffer.concat(errChunks).toString('utf8'),
  };
}

/** Like {@link execCapture} but throws when the command fails, with stderr in the message. */
export async function execChecked(command: readonly string[], options: ExecOptions = {}): Promise<string> {
  const result = await execCapture(command, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
    throw new Error(`${command.join(' ')} → exit ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`);
  }
  return result.stdout;
}

/* ----------------------------------- tmux ---------------------------------- */

/**
 * Lists tmux sessions inside the container.
 *
 * `tmux list-sessions` exits 1 with "no server running" when nothing is up,
 * which is a normal state here rather than an error worth surfacing.
 */
export async function listTmuxSessions(): Promise<readonly TmuxSession[]> {
  const state = await inspectContainer();
  if (!state.running) return [];

  const format = '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}';
  const result = await execCapture(['tmux', 'list-sessions', '-F', format]);
  if (result.exitCode !== 0) return [];

  const sessions: TmuxSession[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [name, windows, attached, created] = line.split('\t');
    if (name === undefined) continue;
    const createdSeconds = Number.parseInt(created ?? '', 10);
    sessions.push({
      name,
      windows: Number.parseInt(windows ?? '1', 10) || 1,
      attached: attached !== undefined && attached !== '0',
      createdAt: Number.isFinite(createdSeconds) ? new Date(createdSeconds * 1000).toISOString() : '',
    });
  }
  return sessions;
}

export async function killTmuxSession(name: string): Promise<void> {
  const result = await execCapture(['tmux', 'kill-session', '-t', name]);
  if (result.exitCode !== 0) {
    logWarn('app', `tmux セッションを終了できませんでした / could not kill session ${name}: ${result.stderr.trim()}`);
  }
}

/** The one message the UI should show for "you need to start the container first". */
export const NOT_RUNNING_MESSAGE =
  'コンテナが起動していません。「接続」タブから起動してください。 / The container is not running — start it from the Connect tab.';

/**
 * Fails with a sentence the user can act on, instead of Docker's
 * `(HTTP code 404) no such container`.
 *
 * Checking first still races a container that stops mid-call, so
 * {@link translateContainerError} rewrites the 404 as well.
 */
export async function requireRunning(): Promise<void> {
  let state: ContainerState;
  try {
    state = await inspectContainer();
  } catch (error) {
    throw new Error(`${NOT_RUNNING_MESSAGE} (${describeError(error)})`, { cause: error });
  }
  if (!state.running) throw new Error(NOT_RUNNING_MESSAGE);
}

/** Rewrites a "no such container" failure; anything else is passed through untouched. */
export function translateContainerError(error: unknown): unknown {
  if (!isNotFound(error)) return error;
  const message = describeError(error);
  if (!/no such container/iu.test(message)) return error;
  return new Error(NOT_RUNNING_MESSAGE, { cause: error });
}

/** Runs `action`, converting a missing-container failure into {@link NOT_RUNNING_MESSAGE}. */
export async function withRunningContainer<T>(action: () => Promise<T>): Promise<T> {
  await requireRunning();
  try {
    return await action();
  } catch (error) {
    throw translateContainerError(error);
  }
}
