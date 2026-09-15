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
import type { CommandOptions, RemoteRouter } from './commands.ts';
import { invokeRouted, registerCommand } from './commands.ts';
import { parseConfigPatch, parseEnvironmentDraft, parseExtensions, parseProfile } from './config/schema.ts';
import {
  appDataDir,
  configStoreProblem,
  deleteProfile,
  getConfig,
  getSecret,
  patchConfig,
  rememberExportDir,
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
  parseCustomRequest,
  parseDownloadRequest,
  parseRepairRequest,
  parseUnregisterRequest,
} from './images/schema.ts';
import {
  activeCatalog,
  cancelImageOperation,
  imageViews,
  startCustomRegistration,
  startDownload,
  startRepair,
  unregisterImage,
} from './images/service.ts';
import { imagesStoreProblem, operationsStoreProblem } from './images/store.ts';
import { notifyStateChanged } from './logger.ts';
import { isInside, stateDir } from './paths.ts';
import { remoteStoreProblem } from './remote/identity.ts';
import { parseConnectRequest, parseHostingPatch, parsePairRequest } from './remote/schema.ts';
import {
  applyHosting,
  cancelInvite,
  connectToPeer,
  disconnectPeer,
  forgetPeerRecord,
  issueInvite,
  pairWithPeer,
  remoteStatus,
  revokePairedClient,
  scanForPeers,
} from './remote/service.ts';
import { hostExportStream, hostImportStream, pullWorkspace, pushImports } from './remote/transfer.ts';
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

const LONG_CALL_MS = 60 * 60_000;

const READ: CommandOptions = { adapt: adaptSnapshot, reroute: true };

let appVersion = '0.0.0';

function command<A extends readonly unknown[], T>(
  channel: string,
  fn: (...args: A) => Promise<T> | T,
  options: CommandOptions = {},
): void {
  registerCommand(channel, (...args: readonly unknown[]) => fn(...(args as unknown as A)), options);
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<Result<T>> => {
    try {
      return { ok: true, value: (await invokeRouted(channel, args)) as T };
    } catch (error) {
      return { ok: false, error: toAppError(error) };
    }
  });
}

function commandVoid<A extends readonly unknown[]>(
  channel: string,
  fn: (...args: A) => Promise<void> | void,
  options: CommandOptions = {},
): void {
  command<A, null>(
    channel,
    async (...args) => {
      await fn(...args);
      return null;
    },
    options,
  );
}

function commandConfigEdit<A extends readonly unknown[]>(channel: string, fn: (...args: A) => AppConfig): void {
  command<A, AppConfig>(channel, (...args) => {
    const next = fn(...args);
    notifyStateChanged();
    return next;
  });
}

function commandTaskAction<A extends readonly unknown[]>(channel: string, fn: (...args: A) => Promise<unknown>): void {
  command<A, Snapshot>(
    channel,
    async (...args) => {
      try {
        await fn(...args);
      } finally {
        notifyStateChanged();
      }
      return snapshot();
    },
    { adapt: adaptSnapshot, timeoutMs: LONG_CALL_MS },
  );
}

function commandRemoteAction<A extends readonly unknown[]>(
  channel: string,
  fn: (...args: A) => Promise<void> | void,
): void {
  command<A, Snapshot>(
    channel,
    async (...args) => {
      await fn(...args);
      notifyStateChanged();
      return snapshot();
    },
    { local: true, denyRemote: true },
  );
}

function storeProblems(catalogProblem: string | null): readonly string[] {
  return [
    configStoreProblem(),
    secretsStoreProblem(),
    tasksStoreProblem(),
    imagesStoreProblem(),
    operationsStoreProblem(),
    remoteStoreProblem(),
    catalogProblem,
  ].filter((problem): problem is string => problem !== null);
}

async function snapshot(): Promise<Snapshot> {
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
    remote: remoteStatus(),
  };
}

function adaptSnapshot(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const remote = remoteStatus();
  const incoming = value as Snapshot;
  return {
    ...incoming,
    remote: {
      ...incoming.remote,
      link: remote.link,
      peers: remote.peers,
      discovered: remote.discovered,
      scanning: remote.scanning,
    },
  } satisfies Snapshot;
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

async function exportFromRemote(router: RemoteRouter, taskId: string): Promise<ExportSummary | null> {
  const destination = await pickDirectory(getConfig().lastExportDir);
  if (destination === null) return null;
  const summary = await pullWorkspace(router, taskId, destination);
  rememberExportDir(destination);
  return summary;
}

function requireId(id: unknown, missing: string): string {
  if (typeof id !== 'string' || id === '') throw new AppFailure('INVALID_INPUT', missing);
  return id;
}

const requireTaskId = (id: unknown): string => requireId(id, 'タスク ID がありません / missing task id');

const requireEnvironmentId = (id: unknown): string => requireId(id, '環境 ID がありません / missing environment id');

const requireProfileId = (id: unknown): string => requireId(id, 'プロファイル ID がありません / missing profile id');

const requireTransferId = (id: unknown): string => requireId(id, '転送 ID がありません / missing transfer id');

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

function wantsExport(request: unknown): boolean {
  return typeof request === 'object' && request !== null && (request as DeleteTaskRequest).exportFirst === true;
}

function requirePaths(paths: unknown): readonly string[] {
  const usable =
    Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === 'string' && path.trim() !== '');
  if (!usable) {
    throw new AppFailure('INVALID_INPUT', '取り込むパスがありません / import needs one or more non-empty paths');
  }
  return paths as readonly string[];
}

export function registerIpc(version: string): void {
  appVersion = version;

  command<[], Snapshot>(CHANNELS.snapshot, snapshot, READ);
  commandConfigEdit<[Language]>(CHANNELS.setLanguage, (language) =>
    patchConfig({ language: language === 'en' ? 'en' : 'ja' }),
  );
  commandVoid<[string]>(
    CHANNELS.openExternal,
    async (url) => {
      const parsed = parseUrl(requireString(url, 'URL'));
      if (parsed === null) throw new AppFailure('INVALID_INPUT', `開けない URL です / not a URL: ${String(url)}`);
      if (!isHttpUrl(parsed)) {
        throw new AppFailure(
          'INVALID_INPUT',
          `http か https のリンクだけ開けます / only http and https links can be opened: ${String(url)}`,
        );
      }
      await shell.openExternal(parsed.toString());
    },
    { local: true, denyRemote: true },
  );
  commandVoid<[string]>(
    CHANNELS.revealPath,
    (path) => {
      const root = resolve(appDataDir());
      const target = resolve(requireString(path, 'path'));
      if (!isInside(root, target)) {
        throw new AppFailure(
          'INVALID_INPUT',
          `このフォルダは開けません / that folder is outside the app's own data: ${String(path)}`,
        );
      }
      shell.openPath(target).catch(() => undefined);
    },
    { local: true, denyRemote: true },
  );
  commandVoid<[string]>(
    CHANNELS.clipboardWrite,
    (text) => {
      if (typeof text !== 'string' || text === '') return;
      clipboard.writeText(text.slice(0, MAX_CLIPBOARD_CHARS));
    },
    { local: true, denyRemote: true },
  );

  commandConfigEdit<[unknown]>(CHANNELS.configSave, (patch) => patchConfig(parseConfigPatch(patch)));
  commandConfigEdit<[unknown]>(CHANNELS.profileUpsert, (profile) => upsertProfile(parseProfile(profile)));
  command<[unknown], AppConfig>(CHANNELS.profileDelete, async (id) => {
    const profileId = requireProfileId(id);
    const next = deleteProfile(profileId);
    try {
      await forgetProfile(profileId);
    } finally {
      notifyStateChanged();
    }
    return next;
  });
  command<[unknown], readonly string[]>(
    CHANNELS.profileApply,
    async (id) => {
      const profileId = requireProfileId(id);
      const lines = await provisionRunningTasks((task) => task.profileId === profileId);
      notifyStateChanged();
      return lines;
    },
    { timeoutMs: LONG_CALL_MS },
  );
  command<[unknown], string>(CHANNELS.secretGet, (profileId) => getSecret(requireProfileId(profileId)));
  commandVoid<[unknown, unknown]>(CHANNELS.secretSet, (profileId, secret) =>
    setSecret(requireProfileId(profileId), requireString(secret, 'secret')),
  );

  commandConfigEdit<[unknown]>(CHANNELS.environmentUpsert, (draft) => upsertEnvironment(parseEnvironmentDraft(draft)));
  commandConfigEdit<[unknown, unknown]>(CHANNELS.environmentArchive, (id, archived) =>
    setEnvironmentArchived(requireEnvironmentId(id), requireArchivedFlag(archived)),
  );
  commandConfigEdit<[unknown]>(CHANNELS.environmentDelete, (id) => deleteEnvironment(requireEnvironmentId(id)));

  command<[], Snapshot>(CHANNELS.dockerProbe, snapshot, READ);

  command<[unknown], ImageOperation>(CHANNELS.imageDownloadStart, (request) => {
    const operation = startDownload(parseDownloadRequest(request).catalogEntryId);
    notifyStateChanged();
    return operation;
  });
  command<[unknown], ImageOperation>(CHANNELS.imageCustomStart, (request) => {
    const operation = startCustomRegistration(parseCustomRequest(request));
    notifyStateChanged();
    return operation;
  });
  command<[unknown], ImageOperation>(CHANNELS.imageRepairStart, (request) => {
    const operation = startRepair(parseRepairRequest(request).imageId);
    notifyStateChanged();
    return operation;
  });
  command<[unknown], ImageOperation>(CHANNELS.imageCancel, (request) =>
    cancelImageOperation(parseCancelRequest(request).operationId),
  );
  commandTaskAction<[unknown]>(CHANNELS.imageUnregister, (request) =>
    unregisterImage(parseUnregisterRequest(request).imageId),
  );
  command<[], Snapshot>(CHANNELS.imageRefresh, snapshot, READ);

  commandConfigEdit<[unknown]>(CHANNELS.extensionsSave, (extensions) =>
    patchConfig({ extensions: parseExtensions(extensions) }),
  );
  command<[], readonly string[]>(
    CHANNELS.extensionsApply,
    async () => {
      const lines = await provisionRunningTasks();
      notifyStateChanged();
      return lines;
    },
    { timeoutMs: LONG_CALL_MS },
  );

  command<[unknown], CreateTaskResult>(
    CHANNELS.taskCreate,
    async (input) => {
      try {
        return await createTask(parseNewTaskInput(input));
      } finally {
        notifyStateChanged();
      }
    },
    { timeoutMs: LONG_CALL_MS },
  );
  command<[unknown, unknown], Task>(CHANNELS.taskUpdate, async (id, patch) => {
    try {
      return await updateTaskDetails(requireTaskId(id), parseTaskPatch(patch));
    } finally {
      notifyStateChanged();
    }
  });
  commandTaskAction<[unknown]>(CHANNELS.taskStart, (id) => startTask(requireTaskId(id)));
  commandTaskAction<[unknown]>(CHANNELS.taskStop, (id) => stopTask(requireTaskId(id)));
  commandTaskAction<[unknown]>(CHANNELS.taskRecreate, (id) => recreateTask(requireTaskId(id)));
  command<[unknown, DeleteTaskRequest], DeleteTaskSummary>(
    CHANNELS.taskDelete,
    async (id, request) => {
      const taskId = requireTaskId(id);
      const exportFirst = wantsExport(request);
      const destination = exportFirst ? await pickDirectory(getConfig().lastExportDir) : null;
      try {
        return await deleteTask(taskId, { exportFirst }, destination);
      } finally {
        notifyStateChanged();
      }
    },
    {
      timeoutMs: LONG_CALL_MS,
      remote: async (router, id, request) => {
        const taskId = requireTaskId(id);
        if (!wantsExport(request)) return router.call(CHANNELS.taskDelete, [taskId, { exportFirst: false }]);
        const exported = await exportFromRemote(router, taskId);
        if (exported === null) {
          throw new AppFailure(
            'INVALID_INPUT',
            '取り出し先が選ばれなかったので何も消していません / no export folder was chosen, so nothing was deleted',
          );
        }
        if (exported.skipped.length > 0) {
          throw new AppFailure(
            'APP_ERROR',
            `${exported.skipped.length} 件を取り出せなかったので削除を中止しました。取り出せた分は ${exported.path} にあります / ` +
              `${exported.skipped.length} item(s) could not be exported, so nothing was deleted; the partial export is at ${exported.path}`,
          );
        }
        await router.call(CHANNELS.taskDelete, [taskId, { exportFirst: false }]);
        return { exportedTo: exported.path, exportedFiles: exported.files } satisfies DeleteTaskSummary;
      },
    },
  );
  command<[unknown], string>(
    CHANNELS.taskProvision,
    async (id) => {
      const summary = await provisionTask(requireTaskId(id));
      notifyStateChanged();
      return summary;
    },
    { timeoutMs: LONG_CALL_MS },
  );
  command<[unknown], ExportSummary | null>(
    CHANNELS.taskExport,
    async (id) => {
      const taskId = requireTaskId(id);
      const destination = await pickDirectory(getConfig().lastExportDir);
      if (destination === null) return null;
      try {
        return await exportTask(taskId, destination);
      } finally {
        notifyStateChanged();
      }
    },
    { denyRemote: true, remote: (router, id) => exportFromRemote(router, requireTaskId(id)) },
  );
  command<[unknown, unknown], ImportSummary>(
    CHANNELS.taskImport,
    async (id, paths) => {
      try {
        return await importIntoTask(requireTaskId(id), requirePaths(paths));
      } finally {
        notifyStateChanged();
      }
    },
    {
      denyRemote: true,
      remote: (router, id, paths) => pushImports(router, requireTaskId(id), requirePaths(paths)),
    },
  );
  command<[unknown, ImportPick], ImportSummary | null>(
    CHANNELS.taskPickImport,
    async (id, pick) => {
      const taskId = requireTaskId(id);
      const paths = await pickImportPaths(pick);
      if (paths.length === 0) return null;
      try {
        return await importIntoTask(taskId, paths);
      } finally {
        notifyStateChanged();
      }
    },
    {
      denyRemote: true,
      remote: async (router, id, pick) => {
        const taskId = requireTaskId(id);
        const paths = await pickImportPaths(pick as ImportPick);
        if (paths.length === 0) return null;
        return pushImports(router, taskId, paths);
      },
    },
  );
  command<[unknown, ExecRequest], ExecResult>(CHANNELS.taskExec, (id, request) => {
    const parts = Array.isArray(request?.command) ? request.command : [];
    if (parts.length === 0 || !parts.every((part) => typeof part === 'string')) {
      throw new AppFailure('INVALID_INPUT', 'コマンドがありません / the command is empty');
    }
    return execInTask(requireTaskId(id), { command: [...parts] });
  });
  command<[unknown], readonly McpServerStatus[]>(CHANNELS.taskMcpStatus, (id) => mcpStatusOfTask(requireTaskId(id)));

  command<[unknown, unknown], null>(CHANNELS.taskExportStream, (id, transferId) =>
    hostExportStream(requireTaskId(id), requireTransferId(transferId)),
  );
  command<[unknown, unknown], null>(CHANNELS.taskImportStream, (id, transferId) =>
    hostImportStream(requireTaskId(id), requireTransferId(transferId)),
  );

  command<[unknown], Snapshot>(
    CHANNELS.remoteHostingSave,
    async (patch) => {
      await applyHosting(parseHostingPatch(patch));
      notifyStateChanged();
      return snapshot();
    },
    { adapt: adaptSnapshot },
  );
  command<[], Snapshot>(
    CHANNELS.remoteInviteCreate,
    async () => {
      await issueInvite();
      notifyStateChanged();
      return snapshot();
    },
    { adapt: adaptSnapshot },
  );
  command<[], Snapshot>(
    CHANNELS.remoteInviteCancel,
    async () => {
      cancelInvite();
      notifyStateChanged();
      return snapshot();
    },
    { adapt: adaptSnapshot },
  );
  command<[unknown], Snapshot>(
    CHANNELS.remoteClientRevoke,
    async (clientId) => {
      revokePairedClient(requireString(clientId, 'client id'));
      notifyStateChanged();
      return snapshot();
    },
    { adapt: adaptSnapshot },
  );

  commandRemoteAction<[unknown]>(CHANNELS.remotePair, (request) => pairWithPeer(parsePairRequest(request)));
  commandRemoteAction<[unknown]>(CHANNELS.remoteConnect, (request) => connectToPeer(parseConnectRequest(request)));
  commandRemoteAction<[]>(CHANNELS.remoteDisconnect, () => disconnectPeer());
  commandRemoteAction<[unknown]>(CHANNELS.remotePeerForget, (peerId) =>
    forgetPeerRecord(requireString(peerId, 'peer id')),
  );
  commandRemoteAction<[]>(CHANNELS.remoteScan, () => scanForPeers());

  command<[OpenTerminalRequest], OpenTerminalResult>(CHANNELS.termOpen, (request) =>
    openTaskTerminal({ ...request, taskId: requireTaskId(request.taskId) }),
  );
  commandVoid<[string, string]>(CHANNELS.termWrite, (id, data) => writeTerminal(id, data));
  commandVoid<[string, number, number]>(CHANNELS.termResize, (id, cols, rows) => resizeTerminal(id, cols, rows));
  commandVoid<[string]>(CHANNELS.termClose, (id) => closeTerminal(id));
}

async function pickImportPaths(pick: ImportPick): Promise<readonly string[]> {
  const properties: readonly DialogProperty[] =
    pick === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'];
  return pickPaths(properties, null);
}
