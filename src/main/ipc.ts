/**
 * IPC handlers.
 *
 * Every handler resolves to a {@link Result} instead of rejecting: a rejected
 * `invoke` reaches the renderer as an opaque `Error: Error invoking remote
 * method`, which is useless to show a user. Failures come back as data with a
 * message the UI can render as-is.
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { CHANNELS } from '../shared/ipc.ts';
import type { BuildRequest, ExecRequest, VscodeAttachResult, WriteFileRequest } from '../shared/ipc.ts';
import { CONTAINER_WORKSPACE } from '../shared/presets.ts';
import type {
  AppConfig,
  ExecResult,
  FileEntry,
  ImageSources,
  Language,
  OpenTerminalRequest,
  OpenTerminalResult,
  Profile,
  Result,
  Snapshot,
  TmuxSession,
} from '../shared/types.ts';
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
} from './docker/container.ts';
import { inspectImage, probeDocker } from './docker/engine.ts';
import { exportWorkspace, listDirectory, makeDirectory, readFileText, writeFileText } from './docker/files.ts';
import { buildImage, readImageSources, resetImageSources, writeImageSources } from './docker/image.ts';
import { closeTerminal, openTerminal, resizeTerminal, writeTerminal } from './docker/terminal.ts';
import { openInVscode, writeDevcontainer } from './integrations/vscode.ts';
import { describeError, notifyStateChanged } from './logger.ts';

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

let appVersion = '0.0.0';

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

  /* ---------------------------------- app --------------------------------- */
  handle<[], Snapshot>(CHANNELS.snapshot, snapshot);
  handle<[Language], AppConfig>(CHANNELS.setLanguage, (language) => patchConfig({ language }));
  handle<[string], null>(CHANNELS.openExternal, async (url) => {
    await shell.openExternal(url);
    return null;
  });
  handle<[string], null>(CHANNELS.revealPath, (path) => {
    shell.openPath(path).catch(() => undefined);
    return null;
  });

  /* -------------------------------- config -------------------------------- */
  handle<[Partial<AppConfig>], AppConfig>(CHANNELS.configSave, (patch) => {
    const next = patchConfig(patch);
    notifyStateChanged();
    return next;
  });
  handle<[Profile], AppConfig>(CHANNELS.profileUpsert, (profile) => upsertProfile(profile));
  handle<[string], AppConfig>(CHANNELS.profileDelete, (id) => deleteProfile(id));
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

  /* -------------------------------- docker -------------------------------- */
  handle<[], Snapshot>(CHANNELS.dockerProbe, snapshot);
  handle<[BuildRequest], null>(CHANNELS.imageBuild, async (request) => {
    await buildImage(getConfig().imageTag, request.noCache);
    notifyStateChanged();
    return null;
  });
  handle<[], ImageSources>(CHANNELS.imageSourcesGet, readImageSources);
  handle<[Pick<ImageSources, 'dockerfile' | 'postCreate'>], ImageSources>(CHANNELS.imageSourcesSave, (sources) =>
    writeImageSources(sources),
  );
  handle<[], ImageSources>(CHANNELS.imageSourcesReset, resetImageSources);

  /* ------------------------------- container ------------------------------ */
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
    execCapture(request.command, { asRoot: request.asRoot }),
  );
  handle<[], string>(CHANNELS.containerProvision, async () => {
    const summary = await provisionContainer();
    notifyStateChanged();
    return summary;
  });
  handle<[], VscodeAttachResult>(CHANNELS.containerVscode, openInVscode);

  /* --------------------------------- tmux --------------------------------- */
  handle<[], readonly TmuxSession[]>(CHANNELS.tmuxList, listTmuxSessions);
  handle<[string], null>(CHANNELS.tmuxKill, async (name) => {
    await killTmuxSession(name);
    return null;
  });

  /* ------------------------------- terminals ------------------------------ */
  handle<[OpenTerminalRequest], OpenTerminalResult>(CHANNELS.termOpen, async (request) => {
    if (request.kind === 'claude') await provisionContainer();
    return openTerminal(request);
  });
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

  /* ------------------------------ file access ----------------------------- */
  handle<[string], readonly FileEntry[]>(CHANNELS.fsList, (path) => listDirectory(path));
  handle<[string], string>(CHANNELS.fsRead, (path) => readFileText(path));
  handle<[WriteFileRequest], null>(CHANNELS.fsWrite, async (request) => {
    await writeFileText(request.path, request.content);
    return null;
  });
  handle<[string], null>(CHANNELS.fsMkdir, async (path) => {
    await makeDirectory(path);
    return null;
  });

  /* -------------------------------- export -------------------------------- */
  handle<[], string | null>(CHANNELS.workspaceExport, async () => {
    const destination = await pickDirectory(getConfig().lastExportDir);
    if (destination === null) return null;
    saveConfig({ ...getConfig(), lastExportDir: destination });
    return exportWorkspace(destination);
  });
  handle<[], string | null>(CHANNELS.devcontainerWrite, async () => {
    const destination = await pickDirectory(getConfig().lastExportDir);
    if (destination === null) return null;
    return writeDevcontainer(destination);
  });
}

/** Exposed so the workspace path is not duplicated in the renderer's default state. */
export const DEFAULT_BROWSE_PATH: string = CONTAINER_WORKSPACE;
