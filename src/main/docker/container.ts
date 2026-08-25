import type { Container } from 'dockerode';
import { PassThrough } from 'node:stream';

import { CONTAINER_HOME, CONTAINER_USER, CONTAINER_WORKSPACE } from '../../shared/presets.ts';
import type { AppConfig, ContainerState, ExecResult, TmuxSession } from '../../shared/types.ts';
import { getConfig } from '../config/store.ts';
import { describeError, logInfo, logWarn } from '../logger.ts';
import { docker, inspectImage, isNotFound } from './engine.ts';

const MANAGED_LABEL = 'com.cc-container-desktop.managed';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export function containerHandle(): Container {
  return docker().getContainer(getConfig().containerName);
}

interface InspectMount {
  readonly Type?: string;
  readonly Name?: string;
  readonly Destination?: string;
}

interface InspectResponse {
  readonly Id?: string;
  readonly Image?: string;
  readonly Config?: { readonly Image?: string };
  readonly State?: { readonly Running?: boolean; readonly Status?: string; readonly StartedAt?: string };
  readonly Mounts?: readonly InspectMount[];
}

function homeVolumeOf(raw: InspectResponse): string | null {
  for (const mount of raw.Mounts ?? []) {
    if (mount.Destination !== CONTAINER_HOME) continue;
    return mount.Type === 'volume' ? (mount.Name ?? null) : null;
  }
  return null;
}

const MISSING_CONTAINER: Omit<ContainerState, 'name'> = {
  exists: false,
  running: false,
  status: 'missing',
  id: null,
  image: null,
  startedAt: null,
  homeVolume: null,
};

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
      startedAt: running ? (raw.State?.StartedAt ?? null) : null,
      homeVolume: homeVolumeOf(raw),
    };
  } catch (error) {
    if (isNotFound(error)) return { name, ...MISSING_CONTAINER };
    throw error;
  }
}

function foreignVolumeError(name: string): Error {
  return new Error(
    `${name} はこのアプリが作ったボリュームではありません。「設定」タブでボリューム名を変えてください / ${name} was not created by this app; change the volume name on the Settings tab`,
  );
}

async function ensureVolume(): Promise<void> {
  const name = getConfig().volumeName;
  // The home volume holds ~/.claude.json, ~/.claude/settings.json and the
  // skills. Mounting one this app did not create and then provisioning would
  // rewrite somebody else's Claude configuration — the very thing the foreign
  // container check below refuses to do.
  if (!(await volumeIsOurs(name))) throw foreignVolumeError(name);

  try {
    await docker().getVolume(name).inspect();
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  logInfo('app', `ボリュームを作成します / creating volume: ${name}`);
  await docker().createVolume({ Name: name, Labels: { [MANAGED_LABEL]: 'true' } });
}

export async function volumeExists(name: string): Promise<boolean> {
  try {
    await docker().getVolume(name).inspect();
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function createContainer(): Promise<void> {
  const config = getConfig();
  // The Connect tab disables "start" while the image is missing, but it does so
  // from a snapshot: the tag can be retargeted on the Settings tab, or the image
  // pruned, between the snapshot and the click. Say so in a sentence rather than
  // letting Docker's raw 404 through.
  if (!(await inspectImage(config.imageTag)).exists) {
    throw new Error(
      `${config.imageTag} がまだビルドされていません。「接続」タブでビルドしてください / ${config.imageTag} has not been built yet — build it on the Connect tab`,
    );
  }
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

function foreignContainerError(name: string): Error {
  return new Error(
    `${name} はこのアプリが作ったコンテナではありません。「設定」タブでコンテナ名を変えてください / ${name} was not created by this app; change the container name on the Settings tab`,
  );
}

// An image tag or a volume name can be retargeted from the Settings tab, but a
// running container's image and binds are fixed at creation. The Settings tab
// promises "changing the container or volume name creates a fresh container on
// the next start", so both have to be treated the same way: rebuild.
// `homeVolume` is null when the mount is not a named volume, and that is not a
// mismatch — it is a container we cannot classify, so we leave it alone.
function staleReason(state: ContainerState, config: AppConfig): string | null {
  if (!state.exists) return null;
  if (state.image !== null && state.image !== config.imageTag) return `image ${config.imageTag}`;
  if (state.homeVolume !== null && state.homeVolume !== config.volumeName) return `volume ${config.volumeName}`;
  return null;
}

export async function startContainer(): Promise<ContainerState> {
  let state = await inspectContainer();

  // Never adopt a container this app did not create — starting it would go on
  // to rewrite its Claude settings and run our post-create script inside it.
  if (state.exists && !(await containerIsOurs())) {
    throw foreignContainerError(getConfig().containerName);
  }

  const stale = staleReason(state, getConfig());
  if (stale !== null) {
    logInfo('app', `設定が変わったのでコンテナを作り直します / recreating container for ${stale}`);
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
  // Same rule as starting: a container this app did not create is somebody
  // else's workload, and the name matching is not a reason to touch it.
  if (state.exists && !(await containerIsOurs())) {
    throw foreignContainerError(getConfig().containerName);
  }
  if (state.running) {
    await containerHandle().stop({ t: 5 });
    logInfo('app', 'コンテナを停止しました / container stopped');
  }
  return inspectContainer();
}

export async function restartContainer(): Promise<ContainerState> {
  const state = await inspectContainer();
  if (!state.exists) return startContainer();
  if (!(await containerIsOurs())) throw foreignContainerError(getConfig().containerName);
  // `docker restart` cannot change an image or a bind, so a container that no
  // longer matches the configured image or volume goes through startContainer,
  // which rebuilds it.
  if (staleReason(state, getConfig()) !== null) return startContainer();
  await containerHandle().restart({ t: 5 });
  logInfo('app', 'コンテナを再起動しました / container restarted');
  return inspectContainer();
}

function isManaged(labels: unknown): boolean {
  if (typeof labels !== 'object' || labels === null) return false;
  return (labels as Record<string, unknown>)[MANAGED_LABEL] === 'true';
}

async function volumeIsOurs(name: string): Promise<boolean> {
  try {
    const raw = (await docker().getVolume(name).inspect()) as { Labels?: unknown };
    return isManaged(raw.Labels);
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
}

async function containerIsOurs(): Promise<boolean> {
  try {
    const raw = (await containerHandle().inspect()) as { Config?: { Labels?: unknown } };
    return isManaged(raw.Config?.Labels);
  } catch (error) {
    if (isNotFound(error)) return true;
    throw error;
  }
}

export async function removeContainer(removeVolume: boolean): Promise<ContainerState> {
  const config = getConfig();
  const state = await inspectContainer();
  // Delete the volume this container actually has mounted at $HOME, not the one
  // the config happens to name now: after a rename in Settings those differ, and
  // deleting the configured name would destroy an unrelated volume while leaving
  // the one holding the user's work behind.
  const volumeName = state.homeVolume ?? config.volumeName;

  if (state.exists) {
    if (!(await containerIsOurs())) {
      throw foreignContainerError(config.containerName);
    }
    try {
      await containerHandle().remove({ force: true, v: false });
      logInfo('app', `コンテナを削除しました / container removed: ${config.containerName}`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  if (removeVolume) {
    if (!(await volumeIsOurs(volumeName))) {
      throw new Error(
        `${volumeName} はこのアプリが作ったボリュームではないので消しません。「設定」タブでボリューム名を変えてください / ${volumeName} was not created by this app and was left alone; change the volume name on the Settings tab`,
      );
    }
    try {
      await docker().getVolume(volumeName).remove();
      logInfo('app', `ボリュームを削除しました / volume removed: ${volumeName}`);
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
  let outBytes = 0;
  let errBytes = 0;
  stdout.on('data', (chunk: Buffer) => {
    if (outBytes >= MAX_CAPTURE_BYTES) return;
    outBytes += chunk.length;
    outChunks.push(chunk);
  });
  stderr.on('data', (chunk: Buffer) => {
    if (errBytes >= MAX_CAPTURE_BYTES) return;
    errBytes += chunk.length;
    errChunks.push(chunk);
  });
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

  const drained = (channel: PassThrough): Promise<void> =>
    new Promise<void>((resolve) => {
      if (channel.writableEnded) {
        resolve();
        return;
      }
      channel.end(() => resolve());
    });
  await Promise.all([drained(stdout), drained(stderr)]);

  const truncated = outBytes >= MAX_CAPTURE_BYTES || errBytes >= MAX_CAPTURE_BYTES;
  if (truncated) {
    logWarn('app', `出力が大きすぎるので切り詰めました / output truncated at ${MAX_CAPTURE_BYTES} bytes`);
  }
  return {
    exitCode: await settledExitCode(exec),
    stdout: Buffer.concat(outChunks).toString('utf8'),
    stderr: Buffer.concat(errChunks).toString('utf8'),
  };
}

interface ExecInspect {
  readonly ExitCode?: number | null;
  readonly Running?: boolean;
}

async function settledExitCode(exec: { inspect: () => Promise<unknown> }): Promise<number> {
  /* oxlint-disable no-await-in-loop */
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = (await exec.inspect()) as ExecInspect;
    if (typeof info.ExitCode === 'number') return info.ExitCode;
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  /* oxlint-enable no-await-in-loop */
  return -1;
}

export async function execChecked(command: readonly string[], options: ExecOptions = {}): Promise<string> {
  const result = await execCapture(command, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
    throw new Error(`${command.join(' ')} → exit ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`);
  }
  return result.stdout;
}

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

export const NOT_RUNNING_MESSAGE =
  'コンテナが起動していません。「接続」タブから起動してください。 / The container is not running — start it from the Connect tab.';

export async function requireRunning(): Promise<void> {
  let state: ContainerState;
  try {
    state = await inspectContainer();
  } catch (error) {
    throw new Error(`${NOT_RUNNING_MESSAGE} (${describeError(error)})`, { cause: error });
  }
  if (!state.running) throw new Error(NOT_RUNNING_MESSAGE);
}

export function translateContainerError(error: unknown): unknown {
  if (!isNotFound(error)) return error;
  const message = describeError(error);
  if (!/no such container/iu.test(message)) return error;
  return new Error(NOT_RUNNING_MESSAGE, { cause: error });
}

export async function withRunningContainer<T>(action: () => Promise<T>): Promise<T> {
  await requireRunning();
  try {
    return await action();
  } catch (error) {
    throw translateContainerError(error);
  }
}
