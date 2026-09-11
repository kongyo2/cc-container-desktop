import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { resolve } from 'node:path';

import type { ImageOperation } from '../shared/images.ts';
import { CHANNELS } from '../shared/ipc.ts';
import type { ExecRequest } from '../shared/ipc.ts';
import type {
  AppConfig,
  CreateTaskResult,
  DeleteTaskRequest,
  DeleteTaskSummary,
  ExecResult,
  ExportSummary,
  ImportPick,
  ImportSummary,
  Language,
  McpServerStatus,
  OpenTerminalRequest,
  OpenTerminalResult,
  Result,
  Snapshot,
  Task,
} from '../shared/types.ts';
import { isHttpUrl, parseUrl } from '../shared/url.ts';
import { parseConfigPatch, parseEnvironmentDraft, parseExtensions, parseProfile } from './config/schema.ts';
import {
  appDataDir,
  configStoreProblem,
  deleteProfile,
  getConfig,
  getSecret,
  patchConfig,
  secretsAreEncrypted,
  secretsStoreProblem,
  setEnvironmentArchived,
  setSecret,
  upsertEnvironment,
  upsertProfile,
} from './config/store.ts';
import { probeDocker } from './docker/engine.ts';
import { closeTerminal, resizeTerminal, writeTerminal } from './docker/terminal.ts';
import { AppFailure, toAppError } from './errors.ts';
import { listOperations } from './images/operations.ts';
import {
  parseCancelRequest,
  parseDownloadRequest,
  parseRepairRequest,
  parseUnregisterRequest,
} from './images/schema.ts';
import {
  activeCatalog,
  cancelImageOperation,
  imageViews,
  startDownload,
  startRepair,
  unregisterImage,
} from './images/service.ts';
import { imagesStoreProblem, operationsStoreProblem } from './images/store.ts';
import { notifyStateChanged } from './logger.ts';
import { isInside, stateDir } from './paths.ts';
import { parseNewTaskInput, parseTaskPatch } from './tasks/schema.ts';
import {
  createTask,
  deleteEnvironment,
  deleteTask,
  execInTask,
  exportTask,
  forgetProfile,
  importIntoTask,
  mcpStatusOfTask,
  openTaskTerminal,
  provisionRunningTasks,
  provisionTask,
  recreateTask,
  startTask,
  stopTask,
  taskViews,
  updateTaskDetails,
} from './tasks/service.ts';
import { tasksStoreProblem } from './tasks/store.ts';

const MAX_CLIPBOARD_CHARS = 4 * 1024 * 1024;

let appVersion = '0.0.0';

function handle<A extends readonly unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<Result<T>> => {
    try {
      return { ok: true, value: await fn(...(args as unknown as A)) };
    } catch (error) {
      return { ok: false, error: toAppError(error) };
    }
  });
}

function handleVoid<A extends readonly unknown[]>(channel: string, fn: (...args: A) => Promise<void> | void): void {
  handle<A, null>(channel, async (...args) => {
    await fn(...args);
    return null;
  });
}

function handleConfigEdit<A extends readonly unknown[]>(channel: string, fn: (...args: A) => AppConfig): void {
  handle<A, AppConfig>(channel, (...args) => {
    const next = fn(...args);
    notifyStateChanged();
    return next;
  });
}

function handleTaskAction<A extends readonly unknown[]>(channel: string, fn: (...args: A) => Promise<unknown>): void {
  handle<A, Snapshot>(channel, async (...args) => {
    try {
      await fn(...args);
    } finally {
      notifyStateChanged();
    }
    return snapshot();
  });
}

function storeProblems(catalogProblem: string | null): readonly string[] {
  return [
    configStoreProblem(),
    secretsStoreProblem(),
    tasksStoreProblem(),
    imagesStoreProblem(),
    operationsStoreProblem(),
    catalogProblem,
  ].filter((problem): problem is string => problem !== null);
}

export async function snapshot(): Promise<Snapshot> {
  const config = getConfig();
  const docker = await probeDocker();
  const { catalog, problem } = activeCatalog();
  const images = await imageViews(docker);
  const tasks = await taskViews(docker, images);
  return {
    config,
    docker,
    catalog,
    images,
    operations: listOperations(),
    tasks,
    storeProblems: storeProblems(problem),
    secretsEncrypted: secretsAreEncrypted(),
    appVersion,
    platform: process.platform,
    dataDir: stateDir(),
  };
}

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

type DialogProperty = 'openDirectory' | 'createDirectory' | 'openFile' | 'multiSelections';

async function pickPaths(
  properties: readonly DialogProperty[],
  defaultPath: string | null,
): Promise<readonly string[]> {
  const window = focusedWindow();
  const options = {
    properties: [...properties],
    ...(defaultPath === null ? {} : { defaultPath }),
  };
  const result = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
  return result.canceled ? [] : result.filePaths;
}

async function pickDirectory(defaultPath: string | null): Promise<string | null> {
  const picked = await pickPaths(['openDirectory', 'createDirectory'], defaultPath);
  return picked[0] ?? null;
}

function requireTaskId(id: unknown): string {
  if (typeof id !== 'string' || id === '')
    throw new AppFailure('INVALID_INPUT', 'タスク ID がありません / missing task id');
  return id;
}

function requireEnvironmentId(id: unknown): string {
  if (typeof id !== 'string' || id === '')
    throw new AppFailure('INVALID_INPUT', '環境 ID がありません / missing environment id');
  return id;
}

function requireProfileId(id: unknown): string {
  if (typeof id !== 'string' || id === '')
    throw new AppFailure('INVALID_INPUT', 'プロファイル ID がありません / missing profile id');
  return id;
}

function requireArchivedFlag(value: unknown): boolean {
  if (typeof value !== 'boolean')
    throw new AppFailure('INVALID_INPUT', 'アーカイブ状態がありません / missing archived state');
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new AppFailure('INVALID_INPUT', `${label} は文字列で指定してください / ${label} must be a string`);
  return value;
}

export function registerIpc(version: string): void {
  appVersion = version;

  handle<[], Snapshot>(CHANNELS.snapshot, snapshot);
  handleConfigEdit<[Language]>(CHANNELS.setLanguage, (language) =>
    patchConfig({ language: language === 'en' ? 'en' : 'ja' }),
  );
  handleVoid<[string]>(CHANNELS.openExternal, async (url) => {
    const parsed = parseUrl(requireString(url, 'URL'));
    if (parsed === null) throw new AppFailure('INVALID_INPUT', `開けない URL です / not a URL: ${String(url)}`);
    if (!isHttpUrl(parsed)) {
      throw new AppFailure(
        'INVALID_INPUT',
        `http か https のリンクだけ開けます / only http and https links can be opened: ${String(url)}`,
      );
    }
    await shell.openExternal(parsed.toString());
  });
  handleVoid<[string]>(CHANNELS.revealPath, (path) => {
    const root = resolve(appDataDir());
    const target = resolve(requireString(path, 'path'));
    if (!isInside(root, target)) {
      throw new AppFailure(
        'INVALID_INPUT',
        `このフォルダは開けません / that folder is outside the app's own data: ${String(path)}`,
      );
    }
    shell.openPath(target).catch(() => undefined);
  });
  handleVoid<[string]>(CHANNELS.clipboardWrite, (text) => {
    if (typeof text !== 'string' || text === '') return;
    clipboard.writeText(text.slice(0, MAX_CLIPBOARD_CHARS));
  });

  handleConfigEdit<[unknown]>(CHANNELS.configSave, (patch) => patchConfig(parseConfigPatch(patch)));
  handleConfigEdit<[unknown]>(CHANNELS.profileUpsert, (profile) => upsertProfile(parseProfile(profile)));
  handle<[unknown], AppConfig>(CHANNELS.profileDelete, async (id) => {
    const profileId = requireProfileId(id);
    const next = deleteProfile(profileId);
    try {
      await forgetProfile(profileId);
    } finally {
      notifyStateChanged();
    }
    return next;
  });
  handle<[unknown], readonly string[]>(CHANNELS.profileApply, async (id) => {
    const profileId = requireProfileId(id);
    const lines = await provisionRunningTasks((task) => task.profileId === profileId);
    notifyStateChanged();
    return lines;
  });
  handle<[unknown], string>(CHANNELS.secretGet, (profileId) => getSecret(requireProfileId(profileId)));
  handleVoid<[unknown, unknown]>(CHANNELS.secretSet, (profileId, secret) =>
    setSecret(requireProfileId(profileId), requireString(secret, 'secret')),
  );

  handleConfigEdit<[unknown]>(CHANNELS.environmentUpsert, (draft) => upsertEnvironment(parseEnvironmentDraft(draft)));
  handleConfigEdit<[unknown, unknown]>(CHANNELS.environmentArchive, (id, archived) =>
    setEnvironmentArchived(requireEnvironmentId(id), requireArchivedFlag(archived)),
  );
  handleConfigEdit<[unknown]>(CHANNELS.environmentDelete, (id) => deleteEnvironment(requireEnvironmentId(id)));

  handle<[], Snapshot>(CHANNELS.dockerProbe, snapshot);

  handle<[unknown], ImageOperation>(CHANNELS.imageDownloadStart, (request) => {
    const operation = startDownload(parseDownloadRequest(request).catalogEntryId);
    notifyStateChanged();
    return operation;
  });
  handle<[unknown], ImageOperation>(CHANNELS.imageRepairStart, (request) => {
    const operation = startRepair(parseRepairRequest(request).imageId);
    notifyStateChanged();
    return operation;
  });
  handle<[unknown], ImageOperation>(CHANNELS.imageCancel, (request) =>
    cancelImageOperation(parseCancelRequest(request).operationId),
  );
  handleTaskAction<[unknown]>(CHANNELS.imageUnregister, (request) =>
    unregisterImage(parseUnregisterRequest(request).imageId),
  );
  handle<[], Snapshot>(CHANNELS.imageRefresh, snapshot);

  handleConfigEdit<[unknown]>(CHANNELS.extensionsSave, (extensions) =>
    patchConfig({ extensions: parseExtensions(extensions) }),
  );
  handle<[], readonly string[]>(CHANNELS.extensionsApply, async () => {
    const lines = await provisionRunningTasks();
    notifyStateChanged();
    return lines;
  });

  handle<[unknown], CreateTaskResult>(CHANNELS.taskCreate, async (input) => {
    try {
      return await createTask(parseNewTaskInput(input));
    } finally {
      notifyStateChanged();
    }
  });
  handle<[unknown, unknown], Task>(CHANNELS.taskUpdate, async (id, patch) => {
    try {
      return await updateTaskDetails(requireTaskId(id), parseTaskPatch(patch));
    } finally {
      notifyStateChanged();
    }
  });
  handleTaskAction<[unknown]>(CHANNELS.taskStart, (id) => startTask(requireTaskId(id)));
  handleTaskAction<[unknown]>(CHANNELS.taskStop, (id) => stopTask(requireTaskId(id)));
  handleTaskAction<[unknown]>(CHANNELS.taskRecreate, (id) => recreateTask(requireTaskId(id)));
  handle<[unknown, DeleteTaskRequest], DeleteTaskSummary>(CHANNELS.taskDelete, async (id, request) => {
    const taskId = requireTaskId(id);
    const exportFirst = typeof request === 'object' && request !== null && request.exportFirst === true;
    const destination = exportFirst ? await pickDirectory(getConfig().lastExportDir) : null;
    try {
      return await deleteTask(taskId, { exportFirst }, destination);
    } finally {
      notifyStateChanged();
    }
  });
  handle<[unknown], string>(CHANNELS.taskProvision, async (id) => {
    const summary = await provisionTask(requireTaskId(id));
    notifyStateChanged();
    return summary;
  });
  handle<[unknown], ExportSummary | null>(CHANNELS.taskExport, async (id) => {
    const taskId = requireTaskId(id);
    const destination = await pickDirectory(getConfig().lastExportDir);
    if (destination === null) return null;
    try {
      return await exportTask(taskId, destination);
    } finally {
      notifyStateChanged();
    }
  });
  handle<[unknown, unknown], ImportSummary>(CHANNELS.taskImport, async (id, paths) => {
    const usable =
      Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === 'string' && path.trim() !== '');
    if (!usable) {
      throw new AppFailure('INVALID_INPUT', '取り込むパスがありません / import needs one or more non-empty paths');
    }
    try {
      return await importIntoTask(requireTaskId(id), paths as string[]);
    } finally {
      notifyStateChanged();
    }
  });
  handle<[unknown, ImportPick], ImportSummary | null>(CHANNELS.taskPickImport, async (id, pick) => {
    const taskId = requireTaskId(id);
    const properties: readonly DialogProperty[] =
      pick === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'];
    const paths = await pickPaths(properties, null);
    if (paths.length === 0) return null;
    try {
      return await importIntoTask(taskId, paths);
    } finally {
      notifyStateChanged();
    }
  });
  handle<[unknown, ExecRequest], ExecResult>(CHANNELS.taskExec, (id, request) => {
    const command = Array.isArray(request?.command) ? request.command : [];
    if (command.length === 0 || !command.every((part) => typeof part === 'string')) {
      throw new AppFailure('INVALID_INPUT', 'コマンドがありません / the command is empty');
    }
    return execInTask(requireTaskId(id), { command: [...command], asRoot: request.asRoot === true });
  });
  handle<[unknown], readonly McpServerStatus[]>(CHANNELS.taskMcpStatus, (id) => mcpStatusOfTask(requireTaskId(id)));

  handle<[OpenTerminalRequest], OpenTerminalResult>(CHANNELS.termOpen, (request) =>
    openTaskTerminal({ ...request, taskId: requireTaskId(request.taskId) }),
  );
  handleVoid<[string, string]>(CHANNELS.termWrite, (id, data) => writeTerminal(id, data));
  handleVoid<[string, number, number]>(CHANNELS.termResize, (id, cols, rows) => resizeTerminal(id, cols, rows));
  handleVoid<[string]>(CHANNELS.termClose, (id) => closeTerminal(id));
}
