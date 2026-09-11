import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { resolve } from 'node:path';

import { CHANNELS } from '../shared/ipc.ts';
import type { BuildRequest, ExecRequest } from '../shared/ipc.ts';
import type {
  AppConfig,
  CreateTaskResult,
  DeleteTaskRequest,
  DeleteTaskSummary,
  ExecResult,
  ExportSummary,
  Extensions,
  ImageSources,
  ImportPick,
  ImportSummary,
  Language,
  McpServerStatus,
  NewTaskInput,
  OpenTerminalRequest,
  OpenTerminalResult,
  Profile,
  Result,
  Snapshot,
  Task,
  TaskPatch,
} from '../shared/types.ts';
import { isHttpUrl, parseUrl } from '../shared/url.ts';
import { parseConfigPatch } from './config/schema.ts';
import {
  appDataDir,
  deleteProfile,
  getConfig,
  getSecret,
  patchConfig,
  secretsAreEncrypted,
  setSecret,
  upsertProfile,
} from './config/store.ts';
import { MISSING_CONTAINER } from './docker/container.ts';
import { inspectImage, probeDocker } from './docker/engine.ts';
import { buildImage, readImageSources, resetImageSources, writeImageSources } from './docker/image.ts';
import { closeTerminal, resizeTerminal, writeTerminal } from './docker/terminal.ts';
import { describeError, notifyStateChanged } from './logger.ts';
import { isInside } from './paths.ts';
import {
  createTask,
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
import { listTasks } from './tasks/store.ts';

const MAX_CLIPBOARD_CHARS = 4 * 1024 * 1024;

let appVersion = '0.0.0';

function handle<A extends readonly unknown[], T>(channel: string, fn: (...args: A) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<Result<T>> => {
    try {
      return { ok: true, value: await fn(...(args as unknown as A)) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
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

async function snapshot(): Promise<Snapshot> {
  const config = getConfig();
  const docker = await probeDocker();
  const base = { config, docker, secretsEncrypted: secretsAreEncrypted(), appVersion, platform: process.platform };

  if (!docker.available) {
    return {
      ...base,
      image: { tag: config.imageTag, exists: false, id: null, createdAt: null, sizeBytes: null },
      tasks: listTasks().map((task) => ({ task, container: MISSING_CONTAINER, imageStale: false })),
    };
  }

  const image = await inspectImage(config.imageTag);
  const tasks = await taskViews(image);
  return { ...base, image, tasks };
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
  if (typeof id !== 'string' || id === '') throw new Error('タスク ID がありません / missing task id');
  return id;
}

export function registerIpc(version: string): void {
  appVersion = version;

  handle<[], Snapshot>(CHANNELS.snapshot, snapshot);
  handleConfigEdit<[Language]>(CHANNELS.setLanguage, (language) =>
    patchConfig({ language: language === 'en' ? 'en' : 'ja' }),
  );
  handleVoid<[string]>(CHANNELS.openExternal, async (url) => {
    const parsed = parseUrl(url);
    if (parsed === null) throw new Error(`開けない URL です / not a URL: ${url}`);
    if (!isHttpUrl(parsed)) {
      throw new Error(`http か https のリンクだけ開けます / only http and https links can be opened: ${url}`);
    }
    await shell.openExternal(parsed.toString());
  });
  handleVoid<[string]>(CHANNELS.revealPath, (path) => {
    const root = resolve(appDataDir());
    const target = resolve(path);
    if (!isInside(root, target)) {
      throw new Error(`このフォルダは開けません / that folder is outside the app's own data: ${path}`);
    }
    shell.openPath(target).catch(() => undefined);
  });
  handleVoid<[string]>(CHANNELS.clipboardWrite, (text) => {
    if (typeof text !== 'string' || text === '') return;
    clipboard.writeText(text.slice(0, MAX_CLIPBOARD_CHARS));
  });

  handleConfigEdit<[unknown]>(CHANNELS.configSave, (patch) => patchConfig(parseConfigPatch(patch)));
  handleConfigEdit<[Profile]>(CHANNELS.profileUpsert, (profile) => upsertProfile(profile));
  handle<[string], AppConfig>(CHANNELS.profileDelete, async (id) => {
    const next = deleteProfile(id);
    try {
      await forgetProfile(id);
    } finally {
      notifyStateChanged();
    }
    return next;
  });
  handle<[string], readonly string[]>(CHANNELS.profileApply, async (id) => {
    const lines = await provisionRunningTasks((task) => task.profileId === id);
    notifyStateChanged();
    return lines;
  });
  handle<[string], string>(CHANNELS.secretGet, (profileId) => getSecret(profileId));
  handleVoid<[string, string]>(CHANNELS.secretSet, (profileId, secret) => setSecret(profileId, secret));

  handle<[], Snapshot>(CHANNELS.dockerProbe, snapshot);
  handleVoid<[BuildRequest]>(CHANNELS.imageBuild, async (request) => {
    await buildImage(getConfig().imageTag, request.noCache);
    notifyStateChanged();
  });
  handle<[], ImageSources>(CHANNELS.imageSourcesGet, readImageSources);
  handle<[Partial<Pick<ImageSources, 'dockerfile' | 'setup' | 'postCreate'>>], ImageSources>(
    CHANNELS.imageSourcesSave,
    (sources) => writeImageSources(sources),
  );
  handle<[], ImageSources>(CHANNELS.imageSourcesReset, resetImageSources);

  handleConfigEdit<[Extensions]>(CHANNELS.extensionsSave, (extensions) => patchConfig({ extensions }));
  handle<[], readonly string[]>(CHANNELS.extensionsApply, async () => {
    const lines = await provisionRunningTasks();
    notifyStateChanged();
    return lines;
  });

  handle<[NewTaskInput], CreateTaskResult>(CHANNELS.taskCreate, async (input) => {
    try {
      return await createTask(input);
    } finally {
      notifyStateChanged();
    }
  });
  handle<[string, TaskPatch], Task>(CHANNELS.taskUpdate, async (id, patch) => {
    try {
      return await updateTaskDetails(requireTaskId(id), patch);
    } finally {
      notifyStateChanged();
    }
  });
  handleTaskAction<[string]>(CHANNELS.taskStart, (id) => startTask(requireTaskId(id)));
  handleTaskAction<[string]>(CHANNELS.taskStop, (id) => stopTask(requireTaskId(id)));
  handleTaskAction<[string]>(CHANNELS.taskRecreate, (id) => recreateTask(requireTaskId(id)));
  handle<[string, DeleteTaskRequest], DeleteTaskSummary>(CHANNELS.taskDelete, async (id, request) => {
    const taskId = requireTaskId(id);
    const exportFirst = request.exportFirst === true;
    const destination = exportFirst ? await pickDirectory(getConfig().lastExportDir) : null;
    try {
      return await deleteTask(taskId, { exportFirst }, destination);
    } finally {
      notifyStateChanged();
    }
  });
  handle<[string], string>(CHANNELS.taskProvision, async (id) => {
    const summary = await provisionTask(requireTaskId(id));
    notifyStateChanged();
    return summary;
  });
  handle<[string], ExportSummary | null>(CHANNELS.taskExport, async (id) => {
    const taskId = requireTaskId(id);
    const destination = await pickDirectory(getConfig().lastExportDir);
    if (destination === null) return null;
    try {
      return await exportTask(taskId, destination);
    } finally {
      notifyStateChanged();
    }
  });
  handle<[string, readonly string[]], ImportSummary>(CHANNELS.taskImport, async (id, paths) => {
    const usable =
      Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === 'string' && path.trim() !== '');
    if (!usable) throw new Error('取り込むパスがありません / import needs one or more non-empty paths');
    try {
      return await importIntoTask(requireTaskId(id), paths);
    } finally {
      notifyStateChanged();
    }
  });
  handle<[string, ImportPick], ImportSummary | null>(CHANNELS.taskPickImport, async (id, pick) => {
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
  handle<[string, ExecRequest], ExecResult>(CHANNELS.taskExec, (id, request) =>
    execInTask(requireTaskId(id), { command: [...request.command], asRoot: request.asRoot === true }),
  );
  handle<[string], readonly McpServerStatus[]>(CHANNELS.taskMcpStatus, (id) => mcpStatusOfTask(requireTaskId(id)));

  handle<[OpenTerminalRequest], OpenTerminalResult>(CHANNELS.termOpen, (request) =>
    openTaskTerminal({ ...request, taskId: requireTaskId(request.taskId) }),
  );
  handleVoid<[string, string]>(CHANNELS.termWrite, (id, data) => writeTerminal(id, data));
  handleVoid<[string, number, number]>(CHANNELS.termResize, (id, cols, rows) => resizeTerminal(id, cols, rows));
  handleVoid<[string]>(CHANNELS.termClose, (id) => closeTerminal(id));
}
