import { BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { CHANNELS } from '../shared/ipc.ts';
import type { BuildRequest, ExecRequest, ResetRequest, VscodeAttachResult, WriteFileRequest } from '../shared/ipc.ts';
import { CONTAINER_WORKSPACE } from '../shared/presets.ts';
import type {
  AppConfig,
  ExecResult,
  Extensions,
  FileEntry,
  ImageSources,
  Language,
  McpServerStatus,
  OpenTerminalRequest,
  OpenTerminalResult,
  Profile,
  ResetSummary,
  Result,
  Snapshot,
  TmuxSession,
} from '../shared/types.ts';
import { readMcpStatus } from './claude/extensions.ts';
import { provisionContainer } from './claude/provision.ts';
import {
  activateProfile,
  deleteProfile,
  getConfig,
  getSecret,
  patchConfig,
  saveConfig,
  secretsAreEncrypted,
  setSecret,
  upsertProfile,
} from './config/store.ts';
import {
  execCapture,
  inspectContainer,
  killTmuxSession,
  listTmuxSessions,
  removeContainer,
  restartContainer,
  startContainer,
  stopContainer,
  withRunningContainer,
} from './docker/container.ts';
import { inspectImage, probeDocker } from './docker/engine.ts';
import { exportWorkspace, listDirectory, makeDirectory, readFileText, writeFileText } from './docker/files.ts';
import { buildImage, readImageSources, resetImageSources, writeImageSources } from './docker/image.ts';
import { closeTerminal, openTerminal, resizeTerminal, writeTerminal } from './docker/terminal.ts';
import { openInVscode, writeDevcontainer } from './integrations/vscode.ts';
import { describeError, notifyStateChanged } from './logger.ts';
import { resetContainer } from './reset.ts';

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

async function snapshot(): Promise<Snapshot> {
  const config = getConfig();
  const docker = await probeDocker();

  if (!docker.available) {
    return {
      config,
      docker,
      image: { tag: config.imageTag, exists: false, id: null, createdAt: null, sizeBytes: null },
      container: {
        name: config.containerName,
        exists: false,
        running: false,
        status: 'unknown',
        id: null,
        image: null,
        startedAt: null,
      },
      secretsEncrypted: secretsAreEncrypted(),
      appVersion: appVersion,
      platform: process.platform,
    };
  }

  const [image, container] = await Promise.all([inspectImage(config.imageTag), inspectContainer()]);
  return {
    config,
    docker,
    image,
    container,
    secretsEncrypted: secretsAreEncrypted(),
    appVersion: appVersion,
    platform: process.platform,
  };
}

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

async function pickDirectory(defaultPath: string | null): Promise<string | null> {
  const window = focusedWindow();
  const options = {
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    ...(defaultPath === null ? {} : { defaultPath }),
  };
  const result = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

export function registerIpc(version: string): void {
  appVersion = version;

  handle<[], Snapshot>(CHANNELS.snapshot, snapshot);
  handle<[Language], AppConfig>(CHANNELS.setLanguage, (language) => {
    const next = patchConfig({ language });
    notifyStateChanged();
    return next;
  });
  handle<[string], null>(CHANNELS.openExternal, async (url) => {
    await shell.openExternal(url);
    return null;
  });
  handle<[string], null>(CHANNELS.revealPath, (path) => {
    shell.openPath(path).catch(() => undefined);
    return null;
  });

  handle<[Partial<AppConfig>], AppConfig>(CHANNELS.configSave, (patch) => {
    const next = patchConfig(patch);
    notifyStateChanged();
    return next;
  });
  handle<[Profile], AppConfig>(CHANNELS.profileUpsert, (profile) => {
    const next = upsertProfile(profile);
    notifyStateChanged();
    return next;
  });
  handle<[string], AppConfig>(CHANNELS.profileDelete, (id) => {
    const next = deleteProfile(id);
    notifyStateChanged();
    return next;
  });
  handle<[string], AppConfig>(CHANNELS.profileActivate, (id) => {
    const next = activateProfile(id);
    notifyStateChanged();
    return next;
  });
  handle<[string], string>(CHANNELS.secretGet, (profileId) => getSecret(profileId));
  handle<[string, string], null>(CHANNELS.secretSet, (profileId, secret) => {
    setSecret(profileId, secret);
    return null;
  });

  handle<[], Snapshot>(CHANNELS.dockerProbe, snapshot);
  handle<[BuildRequest], null>(CHANNELS.imageBuild, async (request) => {
    await buildImage(getConfig().imageTag, request.noCache);
    notifyStateChanged();
    return null;
  });
  handle<[], ImageSources>(CHANNELS.imageSourcesGet, readImageSources);
  handle<[Partial<Pick<ImageSources, 'dockerfile' | 'setup' | 'postCreate'>>], ImageSources>(
    CHANNELS.imageSourcesSave,
    (sources) => writeImageSources(sources),
  );
  handle<[], ImageSources>(CHANNELS.imageSourcesReset, resetImageSources);

  handle<[], Snapshot>(CHANNELS.containerUp, async () => {
    await startContainer();
    await provisionContainer();
    notifyStateChanged();
    return snapshot();
  });
  handle<[], Snapshot>(CHANNELS.containerStop, async () => {
    await stopContainer();
    notifyStateChanged();
    return snapshot();
  });
  handle<[], Snapshot>(CHANNELS.containerRestart, async () => {
    await restartContainer();
    await provisionContainer();
    notifyStateChanged();
    return snapshot();
  });
  handle<[boolean], Snapshot>(CHANNELS.containerRemove, async (removeVolume) => {
    await removeContainer(removeVolume);
    notifyStateChanged();
    return snapshot();
  });
  handle<[], Snapshot>(CHANNELS.containerState, snapshot);
  handle<[ExecRequest], ExecResult>(CHANNELS.containerExec, (request) =>
    withRunningContainer(() => execCapture(request.command, { asRoot: request.asRoot })),
  );
  handle<[], string>(CHANNELS.containerProvision, async () => {
    const summary = await withRunningContainer(provisionContainer);
    notifyStateChanged();
    return summary;
  });
  handle<[], VscodeAttachResult>(CHANNELS.containerVscode, openInVscode);
  handle<[Extensions], AppConfig>(CHANNELS.extensionsSave, (extensions) => {
    const next = patchConfig({ extensions });
    notifyStateChanged();
    return next;
  });
  handle<[], readonly McpServerStatus[]>(CHANNELS.mcpStatus, () => withRunningContainer(readMcpStatus));

  handle<[ResetRequest], ResetSummary>(CHANNELS.containerReset, async (request) => {
    let destination: string | null = null;
    if (request.exportFirst) {
      destination = getConfig().lastExportDir ?? (await pickDirectory(null));
      if (destination === null) throw new Error('取り出し先が選ばれませんでした / no export directory chosen');
    }
    const summary = await resetContainer(request, destination);
    notifyStateChanged();
    return summary;
  });

  handle<[], readonly TmuxSession[]>(CHANNELS.tmuxList, listTmuxSessions);
  handle<[string], null>(CHANNELS.tmuxKill, async (name) => {
    await withRunningContainer(() => killTmuxSession(name));
    return null;
  });

  handle<[OpenTerminalRequest], OpenTerminalResult>(CHANNELS.termOpen, (request) =>
    withRunningContainer(async () => {
      if (request.kind === 'claude') await provisionContainer();
      return openTerminal(request);
    }),
  );
  handle<[string, string], null>(CHANNELS.termWrite, (id, data) => {
    writeTerminal(id, data);
    return null;
  });
  handle<[string, number, number], null>(CHANNELS.termResize, async (id, cols, rows) => {
    await resizeTerminal(id, cols, rows);
    return null;
  });
  handle<[string], null>(CHANNELS.termClose, (id) => {
    closeTerminal(id);
    return null;
  });

  handle<[string], readonly FileEntry[]>(CHANNELS.fsList, (path) => withRunningContainer(() => listDirectory(path)));
  handle<[string], string>(CHANNELS.fsRead, (path) => withRunningContainer(() => readFileText(path)));
  handle<[WriteFileRequest], null>(CHANNELS.fsWrite, async (request) => {
    await withRunningContainer(() => writeFileText(request.path, request.content));
    return null;
  });
  handle<[string], null>(CHANNELS.fsMkdir, async (path) => {
    await withRunningContainer(() => makeDirectory(path));
    return null;
  });

  handle<[], string | null>(CHANNELS.workspaceExport, async () => {
    const destination = await pickDirectory(getConfig().lastExportDir);
    if (destination === null) return null;
    saveConfig({ ...getConfig(), lastExportDir: destination });
    return withRunningContainer(() => exportWorkspace(destination));
  });
  handle<[], string | null>(CHANNELS.devcontainerWrite, async () => {
    const destination = await pickDirectory(getConfig().lastExportDir);
    if (destination === null) return null;
    return writeDevcontainer(destination);
  });
}

export const DEFAULT_BROWSE_PATH: string = CONTAINER_WORKSPACE;
