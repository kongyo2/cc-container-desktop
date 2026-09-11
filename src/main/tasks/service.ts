import { assertCloneTarget } from '../../shared/git.ts';
import type { ImageAvailability, RegisteredImageView } from '../../shared/images.ts';
import { taskContainerName, taskVolumeName } from '../../shared/presets.ts';
import { exportFolderName, normalizeTaskName } from '../../shared/tasks.ts';
import type {
  AppConfig,
  AppliedRuntime,
  ContainerState,
  CreateTaskResult,
  DeleteTaskRequest,
  DeleteTaskSummary,
  DockerStatus,
  ExportSummary,
  ImportSummary,
  McpServerStatus,
  NewTaskInput,
  OpenTerminalRequest,
  OpenTerminalResult,
  Task,
  TaskPatch,
  TaskView,
  WorkspaceSource,
} from '../../shared/types.ts';
import type { ExecRequest } from '../../shared/ipc.ts';
import type { ExecResult } from '../../shared/types.ts';
import { readMcpStatus } from '../claude/extensions.ts';
import { provisionTask as provisionInto } from '../claude/provision.ts';
import { runSetupIfPending, setupFailureMessage } from '../claude/setup.ts';
import { emptyManagedNames } from '../config/schema.ts';
import { environmentFor, getConfig, profileFor, rememberExportDir, removeEnvironment } from '../config/store.ts';
import {
  ensureContainer,
  execCapture,
  inspectContainer,
  MISSING_CONTAINER,
  refOf,
  removeContainer,
  startContainer,
  stopContainer,
  volumeExists,
  withRunningContainer,
} from '../docker/container.ts';
import type { ContainerRef } from '../docker/container.ts';
import { exportWorkspace, importIntoWorkspace } from '../docker/files.ts';
import { cloneIntoWorkspace } from '../docker/git.ts';
import { closeTaskTerminals, openTerminal } from '../docker/terminal.ts';
import { AppFailure, describeError } from '../errors.ts';
import { leaseImage } from '../images/service.ts';
import { logInfo, logWarn } from '../logger.ts';
import { environmentRevision, resolveTaskRuntime, taskEnvironment } from './environment.ts';
import type { ResolvedTaskRuntime } from './environment.ts';
import { addTask, getTask, listTasks, newTaskId, removeTask, updateTask } from './store.ts';

const queues = new Map<string, Promise<void>>();

export function withTaskLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(id, settled);
  void settled.then(() => {
    if (queues.get(id) === settled) queues.delete(id);
    return undefined;
  });
  return next;
}

function environmentStaleFor(task: Task, container: ContainerState): boolean {
  if (!container.exists) return false;
  const environment = taskEnvironment(task);
  if (environment === null) return true;
  return (
    container.environmentId !== environment.id || container.environmentRevision !== environmentRevision(environment)
  );
}

function viewOf(
  task: Task,
  container: ContainerState,
  docker: DockerStatus,
  images: readonly RegisteredImageView[],
): TaskView {
  const environment = taskEnvironment(task);
  const desiredImageId = environment?.imageId ?? null;
  const desired = images.find((view) => view.image.id === desiredImageId) ?? null;
  const desiredAvailability: ImageAvailability | null =
    desiredImageId === null ? null : desired === null ? { kind: 'missing' } : desired.availability;
  const appliedImageId = container.exists
    ? container.registeredImageId
    : (task.lastAppliedRuntime?.registeredImageId ?? null);

  if (!docker.available || container.status === 'error') {
    return {
      task,
      container,
      desiredImageId,
      desiredAvailability,
      appliedImageId,
      imageStale: null,
      environmentStale: null,
    };
  }
  if (!container.exists) {
    return {
      task,
      container,
      desiredImageId,
      desiredAvailability,
      appliedImageId,
      imageStale: null,
      environmentStale: null,
    };
  }

  let imageStale = false;
  if (desiredImageId !== null) {
    if (container.registeredImageId !== desiredImageId) imageStale = true;
    else if (
      desired !== null &&
      desired.availability.kind === 'ready' &&
      container.imageId !== desired.availability.localImageId
    ) {
      imageStale = true;
    }
  }
  return {
    task,
    container,
    desiredImageId,
    desiredAvailability,
    appliedImageId,
    imageStale,
    environmentStale: environmentStaleFor(task, container),
  };
}

export async function taskViews(
  docker: DockerStatus,
  images: readonly RegisteredImageView[],
): Promise<readonly TaskView[]> {
  return Promise.all(
    listTasks().map(async (task): Promise<TaskView> => {
      let container: ContainerState;
      if (!docker.available) {
        container = MISSING_CONTAINER;
      } else {
        try {
          container = await inspectContainer(refOf(task));
        } catch (error) {
          logWarn(
            'app',
            `[${task.name}] コンテナを確認できません / cannot inspect the container: ${describeError(error)}`,
          );
          container = { ...MISSING_CONTAINER, status: 'error' };
        }
      }
      return viewOf(task, container, docker, images);
    }),
  );
}

async function applyProvision(task: Task): Promise<string> {
  const outcome = await provisionInto(task);
  updateTask(task.id, { managed: outcome.managed });
  return outcome.summary;
}

async function applySetup(task: Task): Promise<string | null> {
  try {
    if (environmentStaleFor(task, await inspectContainer(refOf(task)))) {
      logWarn(
        'setup',
        `[${task.name}] コンテナが今の環境とは違う設定で作られているので、セットアップスクリプトは実行しません。「作り直す」で反映してください / the container was created with a different environment; its setup script is skipped until the task is recreated`,
      );
      return null;
    }
    const outcome = await runSetupIfPending(task);
    return outcome.exitCode === null || outcome.exitCode === 0 ? null : setupFailureMessage(outcome.exitCode);
  } catch (error) {
    const message = `セットアップスクリプトを実行できませんでした / could not run the setup script: ${describeError(error)}`;
    logWarn('setup', `[${task.name}] ${message}`);
    return message;
  }
}

function checkedSource(source: WorkspaceSource): WorkspaceSource {
  if (source.kind === 'empty') return { kind: 'empty' };
  const url = source.url.trim();
  const ref = source.ref.trim();
  assertCloneTarget(url, ref);
  return { kind: 'git', url, ref };
}

function checkedProfileId(profileId: string | null | undefined): string | null {
  if (profileId === null || profileId === undefined || profileId === '') return null;
  if (profileFor(profileId) === null) {
    throw new AppFailure('INVALID_INPUT', `プロファイルが見つかりません / no such profile: ${profileId}`);
  }
  return profileId;
}

function checkedEnvironmentId(environmentId: string | undefined): string {
  if (environmentId === undefined || environmentId === '') {
    throw new AppFailure('ENVIRONMENT_MISSING', '環境を 1 つ選んでください / a task needs an environment');
  }
  const environment = environmentFor(environmentId);
  if (environment === null) {
    throw new AppFailure('ENVIRONMENT_MISSING', `環境が見つかりません / no such environment: ${environmentId}`);
  }
  if (environment.archived) {
    throw new AppFailure(
      'ENVIRONMENT_ARCHIVED',
      `${environment.name}: アーカイブ済みの環境は選べません。復元してください / archived environments cannot be selected; restore it first`,
    );
  }
  return environmentId;
}

function appliedRuntimeOf(runtime: ResolvedTaskRuntime): AppliedRuntime {
  return {
    registeredImageId: runtime.registeredImageId,
    localImageId: runtime.localImageId,
    engineId: runtime.engineId,
    environmentId: runtime.environmentId,
    environmentRevision: runtime.environmentRevision,
    appliedAt: new Date().toISOString(),
  };
}

/** Creates (if needed) and starts the container from a runtime fixed for the whole operation, recording what was applied. */
async function startFromRuntime(task: Task, runtime: ResolvedTaskRuntime): Promise<ContainerState> {
  const release = leaseImage(runtime.registeredImageId);
  try {
    const before = await inspectContainer(refOf(task));
    const state = await startContainer(refOf(task), () => Promise.resolve(runtime.spec));
    if (!before.exists && state.exists) updateTask(task.id, { lastAppliedRuntime: appliedRuntimeOf(runtime) });
    return state;
  } finally {
    release();
  }
}

export async function createTask(input: NewTaskInput): Promise<CreateTaskResult> {
  const name = normalizeTaskName(input.name);
  if (name === '') throw new AppFailure('INVALID_INPUT', 'タスク名が空です / the task name is empty');
  const source = checkedSource(input.source);
  const profileId = checkedProfileId(input.profileId);
  const environmentId = checkedEnvironmentId(input.environmentId);

  const id = newTaskId();
  const task: Task = {
    id,
    name,
    note: typeof input.note === 'string' ? input.note.trim() : '',
    profileId,
    environmentId,
    source,
    containerName: taskContainerName(id),
    volumeName: taskVolumeName(id),
    createdAt: new Date().toISOString(),
    managed: emptyManagedNames(),
    lastAppliedRuntime: null,
  };
  const runtime = await resolveTaskRuntime(task);
  addTask(task);
  logInfo(
    'app',
    `タスクを作成します / creating task "${name}" (${task.containerName}, environment: ${environmentFor(environmentId)?.name ?? '—'}, image: ${runtime.registeredImageId})`,
  );

  return withTaskLock(id, async () => {
    const ref = refOf(task);
    try {
      await startFromRuntime(task, runtime);
      const warnings: string[] = [];
      try {
        await applyProvision(task);
      } catch (error) {
        const warning = `設定の書き込みに失敗しました / provisioning failed: ${describeError(error)}`;
        logWarn('app', `[${name}] ${warning}`);
        warnings.push(warning);
      }
      if (source.kind === 'git') {
        await withRunningContainer(ref, () => cloneIntoWorkspace(ref, source.url, source.ref));
      }
      const setupWarning = await applySetup(task);
      if (setupWarning !== null) warnings.push(setupWarning);
      logInfo('app', `タスクの準備ができました / task ready: ${name}`);
      return { task: getTask(id), warning: warnings.length === 0 ? null : warnings.join(' — ') };
    } catch (error) {
      logWarn(
        'app',
        `タスクの作成に失敗したので片付けます / task creation failed, cleaning up: ${describeError(error)}`,
      );
      try {
        await closeTaskTerminals(id);
        await removeContainer(ref, true);
      } catch (cleanupError) {
        logWarn('app', `片付けに失敗しました / cleanup failed: ${describeError(cleanupError)}`);
      }
      removeTask(id);
      throw error;
    }
  });
}

export function updateTaskDetails(id: string, patch: TaskPatch): Promise<Task> {
  return withTaskLock(id, async () => {
    const current = getTask(id);
    const next: { name?: string; note?: string; profileId?: string | null; environmentId?: string } = {};
    if (patch.name !== undefined) {
      const name = normalizeTaskName(patch.name);
      if (name === '') throw new AppFailure('INVALID_INPUT', 'タスク名が空です / the task name is empty');
      next.name = name;
    }
    if (patch.note !== undefined) next.note = patch.note.trim();
    if (patch.profileId !== undefined) next.profileId = checkedProfileId(patch.profileId);
    if (patch.environmentId !== undefined && patch.environmentId !== current.environmentId) {
      next.environmentId = checkedEnvironmentId(patch.environmentId);
    }

    const updated = updateTask(id, next);
    const profileChanged = patch.profileId !== undefined && updated.profileId !== current.profileId;
    if (profileChanged && (await inspectContainer(refOf(updated))).running) {
      await applyProvision(updated);
    }
    return getTask(id);
  });
}

/** Starting an existing container never depends on the desired image; only a missing container needs one. */
export function startTask(id: string): Promise<string> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    const existing = await inspectContainer(refOf(task));
    if (existing.exists) {
      await startContainer(refOf(task), () => {
        throw new AppFailure('APP_ERROR', 'unreachable: the container exists');
      });
    } else {
      await startFromRuntime(task, await resolveTaskRuntime(task));
    }
    const summary = await applyProvision(task);
    await applySetup(task);
    return summary;
  });
}

export function stopTask(id: string): Promise<void> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    await closeTaskTerminals(id);
    await stopContainer(refOf(task));
  });
}

/** The target image is verified before the old container is touched; the home volume is always kept. */
export function recreateTask(id: string): Promise<string> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    const runtime = await resolveTaskRuntime(task);
    const ref = refOf(task);
    await closeTaskTerminals(id);
    logInfo(
      'app',
      `[${task.name}] コンテナを作り直します / recreating the container on ${runtime.registeredImageId} (${runtime.localImageId.slice(0, 19)})`,
    );
    await removeContainer(ref, false);
    await startFromRuntime(task, runtime);
    const summary = await applyProvision(task);
    await applySetup(task);
    return summary;
  });
}

export function provisionTask(id: string): Promise<string> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    return withRunningContainer(refOf(task), () => applyProvision(task));
  });
}

async function hasWorkspace(ref: ContainerRef): Promise<boolean> {
  if ((await inspectContainer(ref)).exists) return true;
  return volumeExists(ref.volumeName);
}

/** For file operations: the existing container if there is one, otherwise a container from the desired or last applied image. */
async function ensureTaskContainer(task: Task): Promise<ContainerState> {
  return ensureContainer(refOf(task), async () => {
    const runtime = await resolveTaskRuntime(task, { allowLastApplied: true });
    return runtime.spec;
  });
}

async function exportTo(task: Task, destination: string): Promise<ExportSummary> {
  await ensureTaskContainer(task);
  const summary = await exportWorkspace(refOf(task), destination, exportFolderName(task.name));
  rememberExportDir(destination);
  return summary;
}

export function exportTask(id: string, destination: string): Promise<ExportSummary> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    if (!(await hasWorkspace(refOf(task)))) {
      throw new AppFailure(
        'INVALID_INPUT',
        '取り出すものがありません (コンテナもボリュームもありません) / nothing to export: no container and no volume',
      );
    }
    return exportTo(task, destination);
  });
}

export function deleteTask(
  id: string,
  request: DeleteTaskRequest,
  destination: string | null,
): Promise<DeleteTaskSummary> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    const ref = refOf(task);
    let exported: ExportSummary | null = null;

    if (request.exportFirst) {
      if (await hasWorkspace(ref)) {
        if (destination === null || destination === '') {
          throw new AppFailure(
            'INVALID_INPUT',
            '取り出し先が選ばれなかったので何も消していません / no export folder was chosen, so nothing was deleted',
          );
        }
        exported = await exportTo(task, destination);
        if (exported.skipped.length > 0) {
          throw new AppFailure(
            'APP_ERROR',
            `${exported.skipped.length} 件を取り出せなかったので削除を中止しました。取り出せた分は ${exported.path} にあります / ` +
              `${exported.skipped.length} item(s) could not be exported, so nothing was deleted; the partial export is at ${exported.path}`,
          );
        }
      } else {
        logInfo(
          'app',
          `[${task.name}] 取り出すものがないので削除だけ行います / nothing to export; deleting the record`,
        );
      }
    }

    await closeTaskTerminals(id);
    await removeContainer(ref, true);
    removeTask(id);
    logInfo('app', `タスクを削除しました / task deleted: ${task.name}`);
    return { exportedTo: exported?.path ?? null, exportedFiles: exported?.files ?? 0 };
  });
}

export function importIntoTask(id: string, paths: readonly string[]): Promise<ImportSummary> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    await ensureTaskContainer(task);
    return importIntoWorkspace(refOf(task), paths);
  });
}

export function execInTask(id: string, request: ExecRequest): Promise<ExecResult> {
  const ref = refOf(getTask(id));
  return withRunningContainer(ref, () => execCapture(ref, request.command, { asRoot: request.asRoot }));
}

export function mcpStatusOfTask(id: string): Promise<readonly McpServerStatus[]> {
  const ref = refOf(getTask(id));
  return withRunningContainer(ref, () => readMcpStatus(ref));
}

export function openTaskTerminal(request: OpenTerminalRequest): Promise<OpenTerminalResult> {
  return withTaskLock(request.taskId, async () => {
    const task = getTask(request.taskId);
    const ref = refOf(task);
    return withRunningContainer(ref, async () => {
      if (request.kind === 'claude') await applyProvision(task);
      return openTerminal(ref, request);
    });
  });
}

export async function provisionRunningTasks(filter: (task: Task) => boolean = () => true): Promise<readonly string[]> {
  const lines: string[] = [];
  /* oxlint-disable no-await-in-loop -- provisioning shares the host's Docker connection; keep it sequential */
  for (const task of listTasks()) {
    if (!filter(task)) continue;
    let state: ContainerState;
    try {
      state = await inspectContainer(refOf(task));
    } catch {
      continue;
    }
    if (!state.running) continue;
    try {
      const summary = await withTaskLock(task.id, () => applyProvision(getTask(task.id)));
      lines.push(`${task.name}: ${summary}`);
    } catch (error) {
      lines.push(`${task.name}: ✗ ${describeError(error)}`);
    }
  }
  /* oxlint-enable no-await-in-loop */
  return lines;
}

export async function forgetProfile(profileId: string): Promise<readonly string[]> {
  const affected = new Set<string>();
  for (const task of listTasks()) {
    if (task.profileId !== profileId) continue;
    updateTask(task.id, { profileId: null });
    affected.add(task.id);
  }
  if (affected.size === 0) return [];
  return provisionRunningTasks((task) => affected.has(task.id));
}

export function deleteEnvironment(environmentId: string): AppConfig {
  const environment = environmentFor(environmentId);
  if (environment === null) {
    throw new AppFailure('ENVIRONMENT_MISSING', `環境が見つかりません / no such environment: ${environmentId}`);
  }
  const users = listTasks().filter((task) => task.environmentId === environmentId);
  if (users.length > 0) {
    const names = users.map((task) => task.name).join(', ');
    throw new AppFailure(
      'INVALID_INPUT',
      `${environment.name}: ${users.length} 件のタスクが使っているので削除できません (${names}) / still used by ${users.length} task(s): ${names}`,
    );
  }
  logInfo('app', `環境を削除しました / environment deleted: ${environment.name}`);
  return removeEnvironment(environmentId);
}

export function tasksUsingEnvironment(environmentId: string): number {
  return listTasks().filter((task) => task.environmentId === environmentId).length;
}

export function configSnapshot(): AppConfig {
  return getConfig();
}
