import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { resolve } from 'node:path';

import { CHANNELS } from '../shared/ipc.ts';
import type { BuildRequest, ExecRequest, ResetRequest, VscodeAttachResult, WriteFileRequest } from '../shared/ipc.ts';
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
  appDataDir,
  deleteProfile,
  getConfig,
  getSecret,
  patchConfig,
  rememberExportDir,
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
import { isInside } from './paths.ts';
import { resetContainer } from './reset.ts';

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

function handleDockerAction<A extends readonly unknown[]>(channel: string, fn: (...args: A) => Promise<void>): void {
  handle<A, Snapshot>(channel, async (...args) => {
    await fn(...args);
    notifyStateChanged();
    return snapshot();
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
        homeVolume: null,
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
  handleConfigEdit<[Language]>(CHANNELS.setLanguage, (language) => patchConfig({ language }));
  handleVoid<[string]>(CHANNELS.openExternal, async (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`開けない URL です / not a URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
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

  handleConfigEdit<[Partial<AppConfig>]>(CHANNELS.configSave, (patch) => patchConfig(patch));
  handleConfigEdit<[Profile]>(CHANNELS.profileUpsert, (profile) => upsertProfile(profile));
  handleConfigEdit<[string]>(CHANNELS.profileDelete, (id) => deleteProfile(id));
  handleConfigEdit<[string]>(CHANNELS.profileActivate, (id) => activateProfile(id));
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

  handleDockerAction<[]>(CHANNELS.containerUp, async () => {
    await startContainer();
    await provisionContainer();
  });
  handleDockerAction<[]>(CHANNELS.containerStop, async () => {
    await stopContainer();
  });
  handleDockerAction<[]>(CHANNELS.containerRestart, async () => {
    await restartContainer();
    await provisionContainer();
  });
  handleDockerAction<[boolean]>(CHANNELS.containerRemove, async (removeVolume) => {
    await removeContainer(removeVolume);
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
  handleConfigEdit<[Extensions]>(CHANNELS.extensionsSave, (extensions) => patchConfig({ extensions }));
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
  handleVoid<[string, string | undefined]>(CHANNELS.tmuxKill, (target, expectedName) =>
    withRunningContainer(() => killTmuxSession(target, expectedName)),
  );

  handle<[OpenTerminalRequest], OpenTerminalResult>(CHANNELS.termOpen, (request) =>
    withRunningContainer(async () => {
      if (request.kind === 'claude') await provisionContainer();
      return openTerminal(request);
    }),
  );
  handleVoid<[string, string]>(CHANNELS.termWrite, (id, data) => writeTerminal(id, data));
  handleVoid<[string, number, number]>(CHANNELS.termResize, (id, cols, rows) => resizeTerminal(id, cols, rows));
  handleVoid<[string]>(CHANNELS.termClose, (id) => closeTerminal(id));

  handle<[string], readonly FileEntry[]>(CHANNELS.fsList, (path) => withRunningContainer(() => listDirectory(path)));
  handle<[string], string>(CHANNELS.fsRead, (path) => withRunningContainer(() => readFileText(path)));
  handleVoid<[WriteFileRequest]>(CHANNELS.fsWrite, (request) =>
    withRunningContainer(() => writeFileText(request.path, request.content)),
  );
  handleVoid<[string]>(CHANNELS.fsMkdir, (path) => withRunningContainer(() => makeDirectory(path)));

  handle<[], string | null>(CHANNELS.workspaceExport, async () => {
    const destination = await pickDirectory(getConfig().lastExportDir);
    if (destination === null) return null;
    rememberExportDir(destination);
    const result = await withRunningContainer(() => exportWorkspace(destination));
    return result.skipped.length === 0
      ? result.path
      : `${result.path} (${result.files} files, ${result.skipped.length} skipped)`;
  });
  handle<[], string | null>(CHANNELS.devcontainerWrite, async () => {
    const destination = await pickDirectory(getConfig().lastExportDir);
    if (destination === null) return null;
    return writeDevcontainer(destination);
  });
}
