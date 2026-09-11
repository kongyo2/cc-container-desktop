import { assertCloneTarget } from '../../shared/git.ts';
import { taskContainerName, taskVolumeName } from '../../shared/presets.ts';
import { exportFolderName, normalizeTaskName } from '../../shared/tasks.ts';
import type {
  ContainerState,
  CreateTaskResult,
  DeleteTaskRequest,
  DeleteTaskSummary,
  ExportSummary,
  ImageStatus,
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
import { emptyManagedNames } from '../config/schema.ts';
import { getConfig, profileFor, rememberExportDir } from '../config/store.ts';
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
import { requireImageBuilt } from '../docker/engine.ts';
import { exportWorkspace, importIntoWorkspace } from '../docker/files.ts';
import { cloneIntoWorkspace } from '../docker/git.ts';
import { closeTaskTerminals, openTerminal } from '../docker/terminal.ts';
import { describeError, logInfo, logWarn } from '../logger.ts';
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

export async function taskViews(image: ImageStatus): Promise<readonly TaskView[]> {
  return Promise.all(
    listTasks().map(async (task): Promise<TaskView> => {
      let container: ContainerState;
      try {
        container = await inspectContainer(refOf(task));
      } catch (error) {
        logWarn(
          'app',
          `[${task.name}] コンテナを確認できません / cannot inspect the container: ${describeError(error)}`,
        );
        container = { ...MISSING_CONTAINER, status: 'error' };
      }
      const imageStale =
        container.exists && image.id !== null && container.imageId !== null && container.imageId !== image.id;
      return { task, container, imageStale };
    }),
  );
}

async function applyProvision(task: Task): Promise<string> {
  const outcome = await provisionInto(task);
  updateTask(task.id, { managed: outcome.managed });
  return outcome.summary;
}

function checkedSource(source: WorkspaceSource): WorkspaceSource {
  if (source.kind === 'empty') return { kind: 'empty' };
  const url = source.url.trim();
  const ref = source.ref.trim();
  assertCloneTarget(url, ref);
  return { kind: 'git', url, ref };
}

function checkedProfileId(profileId: string | null): string | null {
  if (profileId === null || profileId === '') return null;
  if (profileFor(profileId) === null) {
    throw new Error(`プロファイルが見つかりません / no such profile: ${profileId}`);
  }
  return profileId;
}

async function requireImage(): Promise<string> {
  const tag = getConfig().imageTag;
  await requireImageBuilt(tag);
  return tag;
}

export async function createTask(input: NewTaskInput): Promise<CreateTaskResult> {
  const name = normalizeTaskName(input.name);
  if (name === '') throw new Error('タスク名が空です / the task name is empty');
  const source = checkedSource(input.source);
  const profileId = checkedProfileId(input.profileId);
  const imageTag = await requireImage();

  const id = newTaskId();
  const task: Task = {
    id,
    name,
    note: typeof input.note === 'string' ? input.note.trim() : '',
    profileId,
    source,
    containerName: taskContainerName(id),
    volumeName: taskVolumeName(id),
    createdAt: new Date().toISOString(),
    managed: emptyManagedNames(),
  };
  addTask(task);
  logInfo('app', `タスクを作成します / creating task "${name}" (${task.containerName})`);

  return withTaskLock(id, async () => {
    const ref = refOf(task);
    try {
      await startContainer(ref, imageTag);
      let warning: string | null = null;
      try {
        await applyProvision(task);
      } catch (error) {
        warning = `設定の書き込みに失敗しました / provisioning failed: ${describeError(error)}`;
        logWarn('app', `[${name}] ${warning}`);
      }
      if (source.kind === 'git') {
        await withRunningContainer(ref, () => cloneIntoWorkspace(ref, source.url, source.ref));
      }
      logInfo('app', `タスクの準備ができました / task ready: ${name}`);
      return { task: getTask(id), warning };
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
    const next: { name?: string; note?: string; profileId?: string | null } = {};
    if (patch.name !== undefined) {
      const name = normalizeTaskName(patch.name);
      if (name === '') throw new Error('タスク名が空です / the task name is empty');
      next.name = name;
    }
    if (patch.note !== undefined) next.note = patch.note.trim();
    if (patch.profileId !== undefined) next.profileId = checkedProfileId(patch.profileId);

    const updated = updateTask(id, next);
    const profileChanged = patch.profileId !== undefined && updated.profileId !== current.profileId;
    if (profileChanged && (await inspectContainer(refOf(updated))).running) {
      await applyProvision(updated);
    }
    return getTask(id);
  });
}

export function startTask(id: string): Promise<string> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    await startContainer(refOf(task), getConfig().imageTag);
    return applyProvision(task);
  });
}

export function stopTask(id: string): Promise<void> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    await closeTaskTerminals(id);
    await stopContainer(refOf(task));
  });
}

export function recreateTask(id: string): Promise<string> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    const imageTag = await requireImage();
    const ref = refOf(task);
    await closeTaskTerminals(id);
    logInfo('app', `[${task.name}] コンテナを作り直します / recreating the container on ${imageTag}`);
    await removeContainer(ref, false);
    await startContainer(ref, imageTag);
    return applyProvision(task);
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

function ensureTaskContainer(ref: ContainerRef): Promise<ContainerState> {
  return ensureContainer(ref, getConfig().imageTag);
}

async function exportTo(ref: ContainerRef, taskName: string, destination: string): Promise<ExportSummary> {
  await ensureTaskContainer(ref);
  const summary = await exportWorkspace(ref, destination, exportFolderName(taskName));
  rememberExportDir(destination);
  return summary;
}

export function exportTask(id: string, destination: string): Promise<ExportSummary> {
  return withTaskLock(id, async () => {
    const task = getTask(id);
    const ref = refOf(task);
    if (!(await hasWorkspace(ref))) {
      throw new Error(
        '取り出すものがありません (コンテナもボリュームもありません) / nothing to export: no container and no volume',
      );
    }
    return exportTo(ref, task.name, destination);
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
          throw new Error(
            '取り出し先が選ばれなかったので何も消していません / no export folder was chosen, so nothing was deleted',
          );
        }
        exported = await exportTo(ref, task.name, destination);
        if (exported.skipped.length > 0) {
          throw new Error(
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
    const ref = refOf(getTask(id));
    await ensureTaskContainer(ref);
    return importIntoWorkspace(ref, paths);
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
