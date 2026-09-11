import type { Container } from 'dockerode';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import {
  CONTAINER_HOME,
  CONTAINER_USER,
  CONTAINER_WORKSPACE,
  ENVIRONMENT_LABEL,
  ENVIRONMENT_REVISION_LABEL,
  MANAGED_LABEL,
  TASK_LABEL,
} from '../../shared/presets.ts';
import type { ContainerState, ExecResult, Task } from '../../shared/types.ts';
import { describeError, logInfo, logWarn } from '../logger.ts';
import { docker, isNotFound, requireImageBuilt } from './engine.ts';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

const BASE_ENV: readonly string[] = ['TERM=xterm-256color', 'LANG=C.UTF-8'];

export interface ContainerRef {
  readonly taskId: string;
  readonly containerName: string;
  readonly volumeName: string;
}

/** Everything a task's container is created with, beyond its name and volume. */
export interface ContainerSpec {
  readonly imageTag: string;
  /** `KEY=VALUE` entries from the task's environment, applied after the base ones. */
  readonly env: readonly string[];
  readonly environmentId: string;
  readonly environmentRevision: string;
}

export function refOf(task: Task): ContainerRef {
  return { taskId: task.id, containerName: task.containerName, volumeName: task.volumeName };
}

export function containerHandle(ref: ContainerRef): Container {
  return docker().getContainer(ref.containerName);
}

interface InspectMount {
  readonly Type?: string;
  readonly Name?: string;
  readonly Destination?: string;
}

interface InspectResponse {
  readonly Id?: string;
  readonly Image?: string;
  readonly Config?: { readonly Image?: string; readonly Labels?: unknown };
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

export const MISSING_CONTAINER: ContainerState = {
  exists: false,
  running: false,
  status: 'missing',
  id: null,
  imageId: null,
  startedAt: null,
  homeVolume: null,
  environmentId: null,
  environmentRevision: null,
};

async function nullIfNotFound<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function ignoringNotFound(remove: () => Promise<void>): Promise<void> {
  try {
    await remove();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function inspectRaw(ref: ContainerRef): Promise<InspectResponse | null> {
  return nullIfNotFound(async () => (await containerHandle(ref).inspect()) as InspectResponse);
}

function labelsOf(labels: unknown): Record<string, unknown> {
  return typeof labels === 'object' && labels !== null ? (labels as Record<string, unknown>) : {};
}

function labelString(labels: Record<string, unknown>, key: string): string | null {
  const value = labels[key];
  return typeof value === 'string' ? value : null;
}

function stateOf(raw: InspectResponse): ContainerState {
  const running = raw.State?.Running === true;
  const labels = labelsOf(raw.Config?.Labels);
  return {
    exists: true,
    running,
    status: raw.State?.Status ?? 'unknown',
    id: raw.Id ?? null,
    imageId: raw.Image ?? null,
    startedAt: running ? (raw.State?.StartedAt ?? null) : null,
    homeVolume: homeVolumeOf(raw),
    environmentId: labelString(labels, ENVIRONMENT_LABEL),
    environmentRevision: labelString(labels, ENVIRONMENT_REVISION_LABEL),
  };
}

export async function inspectContainer(ref: ContainerRef): Promise<ContainerState> {
  const raw = await inspectRaw(ref);
  return raw === null ? MISSING_CONTAINER : stateOf(raw);
}

function ownedBy(labels: unknown, taskId: string): boolean {
  const map = labelsOf(labels);
  return map[MANAGED_LABEL] === 'true' && map[TASK_LABEL] === taskId;
}

function ownerLabels(taskId: string): Record<string, string> {
  return { [MANAGED_LABEL]: 'true', [TASK_LABEL]: taskId };
}

function containerLabels(ref: ContainerRef, spec: ContainerSpec): Record<string, string> {
  return {
    ...ownerLabels(ref.taskId),
    [ENVIRONMENT_LABEL]: spec.environmentId,
    [ENVIRONMENT_REVISION_LABEL]: spec.environmentRevision,
  };
}

function foreignError(name: string, noun: string): Error {
  return new Error(
    `${name} はこのタスクのために作られた${noun}ではないので触りません / ${name} exists but was not created for this task; it was left alone`,
  );
}

function foreignContainerError(ref: ContainerRef): Error {
  return foreignError(ref.containerName, 'コンテナ');
}

function foreignVolumeError(name: string): Error {
  return foreignError(name, 'ボリューム');
}

async function inspectVolume(name: string): Promise<{ readonly labels: unknown } | null> {
  return nullIfNotFound(async () => {
    const raw = (await docker().getVolume(name).inspect()) as { Labels?: unknown };
    return { labels: raw.Labels ?? {} };
  });
}

export async function volumeExists(name: string): Promise<boolean> {
  return (await inspectVolume(name)) !== null;
}

async function ownedVolumeExists(ref: ContainerRef): Promise<boolean> {
  const found = await inspectVolume(ref.volumeName);
  if (found === null) return false;
  if (!ownedBy(found.labels, ref.taskId)) throw foreignVolumeError(ref.volumeName);
  return true;
}

async function ensureVolume(ref: ContainerRef): Promise<void> {
  if (await ownedVolumeExists(ref)) return;
  logInfo('app', `ボリュームを作成します / creating volume: ${ref.volumeName}`);
  await docker().createVolume({ Name: ref.volumeName, Labels: ownerLabels(ref.taskId) });
  if (!(await ownedVolumeExists(ref))) throw foreignVolumeError(ref.volumeName);
}

async function ownedRaw(ref: ContainerRef): Promise<InspectResponse | null> {
  const raw = await inspectRaw(ref);
  if (raw === null) return null;
  if (!ownedBy(raw.Config?.Labels, ref.taskId)) throw foreignContainerError(ref);
  return raw;
}

async function createContainer(ref: ContainerRef, spec: ContainerSpec): Promise<void> {
  await requireImageBuilt(spec.imageTag);
  await ensureVolume(ref);
  logInfo(
    'app',
    `コンテナを作成します / creating container: ${ref.containerName} (${spec.env.length} env var${spec.env.length === 1 ? '' : 's'} from the environment)`,
  );
  await docker().createContainer({
    name: ref.containerName,
    Image: spec.imageTag,
    Hostname: ref.containerName,
    User: CONTAINER_USER,
    WorkingDir: CONTAINER_WORKSPACE,
    Tty: false,
    OpenStdin: false,
    // The environment's variables come last so they win over the base ones;
    // every `docker exec` into the container inherits them.
    Env: [...BASE_ENV, ...spec.env],
    Labels: containerLabels(ref, spec),
    Cmd: ['sleep', 'infinity'],
    HostConfig: {
      Binds: [`${ref.volumeName}:${CONTAINER_HOME}`],
      Init: true,
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });
}

export async function ensureContainer(ref: ContainerRef, spec: ContainerSpec): Promise<ContainerState> {
  const raw = await ownedRaw(ref);
  if (raw !== null) return stateOf(raw);
  await createContainer(ref, spec);
  return inspectContainer(ref);
}

export async function startContainer(ref: ContainerRef, spec: ContainerSpec): Promise<ContainerState> {
  const state = await ensureContainer(ref, spec);
  if (!state.running) {
    await containerHandle(ref).start();
    logInfo('app', `コンテナを起動しました / container started: ${ref.containerName}`);
  }
  return inspectContainer(ref);
}

export async function stopContainer(ref: ContainerRef): Promise<ContainerState> {
  const raw = await ownedRaw(ref);
  if (raw !== null && raw.State?.Running === true) {
    await containerHandle(ref).stop({ t: 5 });
    logInfo('app', `コンテナを停止しました / container stopped: ${ref.containerName}`);
  }
  return inspectContainer(ref);
}

export async function removeContainer(ref: ContainerRef, removeVolume: boolean): Promise<ContainerState> {
  const raw = await ownedRaw(ref);
  if (raw !== null) {
    await ignoringNotFound(async () => {
      await containerHandle(ref).remove({ force: true, v: false });
      logInfo('app', `コンテナを削除しました / container removed: ${ref.containerName}`);
    });
  }

  if (removeVolume && (await ownedVolumeExists(ref))) {
    await ignoringNotFound(async () => {
      await docker().getVolume(ref.volumeName).remove();
      logInfo('app', `ボリュームを削除しました / volume removed: ${ref.volumeName}`);
    });
  }
  return inspectContainer(ref);
}

export interface ExecOptions {
  readonly asRoot?: boolean;
  readonly workdir?: string;
  readonly env?: readonly string[];
  readonly stdin?: string;
  readonly container?: Container;
  readonly onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
}

interface LineSplitter {
  readonly push: (chunk: Buffer) => void;
  readonly flush: () => void;
}

function lineSplitter(emit: (line: string) => void): LineSplitter {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const take = (text: string): void => {
    const parts = (pending + text).split(/\r\n|\r|\n/u);
    pending = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim() !== '') emit(part);
    }
  };
  return {
    push: (chunk) => take(decoder.write(chunk)),
    flush: () => {
      take(decoder.end());
      if (pending.trim() !== '') emit(pending);
      pending = '';
    },
  };
}

export async function execCapture(
  ref: ContainerRef,
  command: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const container = options.container ?? containerHandle(ref);
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
  const onLine = options.onLine;
  const outLines = onLine === undefined ? null : lineSplitter((line) => onLine(line, 'stdout'));
  const errLines = onLine === undefined ? null : lineSplitter((line) => onLine(line, 'stderr'));
  stdout.on('data', (chunk: Buffer) => {
    outLines?.push(chunk);
    if (outBytes >= MAX_CAPTURE_BYTES) return;
    outBytes += chunk.length;
    outChunks.push(chunk);
  });
  stderr.on('data', (chunk: Buffer) => {
    errLines?.push(chunk);
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
  outLines?.flush();
  errLines?.flush();

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

export async function execChecked(
  ref: ContainerRef,
  command: readonly string[],
  options: ExecOptions = {},
): Promise<string> {
  const result = await execCapture(ref, command, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() === '' ? result.stdout.trim() : result.stderr.trim();
    throw new Error(`${command.join(' ')} → exit ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`);
  }
  return result.stdout;
}

export const NOT_RUNNING_MESSAGE =
  'タスクが起動していません。「起動」を押してください。 / The task is not running — press "Start".';

export async function requireRunning(ref: ContainerRef): Promise<void> {
  let raw: InspectResponse | null;
  try {
    raw = await ownedRaw(ref);
  } catch (error) {
    throw new Error(`${NOT_RUNNING_MESSAGE} (${describeError(error)})`, { cause: error });
  }
  if (raw === null || raw.State?.Running !== true) throw new Error(NOT_RUNNING_MESSAGE);
}

export function translateContainerError(error: unknown): unknown {
  if (!isNotFound(error)) return error;
  const message = describeError(error);
  if (!/no such container/iu.test(message)) return error;
  return new Error(NOT_RUNNING_MESSAGE, { cause: error });
}

export async function withRunningContainer<T>(ref: ContainerRef, action: () => Promise<T>): Promise<T> {
  await requireRunning(ref);
  try {
    return await action();
  } catch (error) {
    throw translateContainerError(error);
  }
}
