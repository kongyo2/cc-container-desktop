import { contextBridge, ipcRenderer } from 'electron';

import { CHANNELS, EVENTS } from '../shared/ipc.ts';
import type { Api } from '../shared/ipc.ts';
import type { LogLine, TerminalData, TerminalExit } from '../shared/types.ts';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: Api = {
  snapshot: () => ipcRenderer.invoke(CHANNELS.snapshot),
  setLanguage: (language) => ipcRenderer.invoke(CHANNELS.setLanguage, language),
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url),
  revealPath: (path) => ipcRenderer.invoke(CHANNELS.revealPath, path),
  clipboardWrite: (text) => ipcRenderer.invoke(CHANNELS.clipboardWrite, text),

  configSave: (patch) => ipcRenderer.invoke(CHANNELS.configSave, patch),
  profileUpsert: (profile) => ipcRenderer.invoke(CHANNELS.profileUpsert, profile),
  profileDelete: (id) => ipcRenderer.invoke(CHANNELS.profileDelete, id),
  profileActivate: (id) => ipcRenderer.invoke(CHANNELS.profileActivate, id),
  secretGet: (profileId) => ipcRenderer.invoke(CHANNELS.secretGet, profileId),
  secretSet: (profileId, secret) => ipcRenderer.invoke(CHANNELS.secretSet, profileId, secret),

  dockerProbe: () => ipcRenderer.invoke(CHANNELS.dockerProbe),
  imageBuild: (request) => ipcRenderer.invoke(CHANNELS.imageBuild, request),
  imageSourcesGet: () => ipcRenderer.invoke(CHANNELS.imageSourcesGet),
  imageSourcesSave: (sources) => ipcRenderer.invoke(CHANNELS.imageSourcesSave, sources),
  imageSourcesReset: () => ipcRenderer.invoke(CHANNELS.imageSourcesReset),

  containerUp: () => ipcRenderer.invoke(CHANNELS.containerUp),
  containerStop: () => ipcRenderer.invoke(CHANNELS.containerStop),
  containerRestart: () => ipcRenderer.invoke(CHANNELS.containerRestart),
  containerRemove: (removeVolume) => ipcRenderer.invoke(CHANNELS.containerRemove, removeVolume),
  containerState: () => ipcRenderer.invoke(CHANNELS.containerState),
  containerExec: (request) => ipcRenderer.invoke(CHANNELS.containerExec, request),
  containerProvision: () => ipcRenderer.invoke(CHANNELS.containerProvision),
  containerVscode: () => ipcRenderer.invoke(CHANNELS.containerVscode),
  containerReset: (request) => ipcRenderer.invoke(CHANNELS.containerReset, request),

  extensionsSave: (extensions) => ipcRenderer.invoke(CHANNELS.extensionsSave, extensions),
  mcpStatus: () => ipcRenderer.invoke(CHANNELS.mcpStatus),

  tmuxList: () => ipcRenderer.invoke(CHANNELS.tmuxList),
  tmuxKill: (target, expectedName) => ipcRenderer.invoke(CHANNELS.tmuxKill, target, expectedName),

  termOpen: (request) => ipcRenderer.invoke(CHANNELS.termOpen, request),
  termWrite: (id, data) => ipcRenderer.invoke(CHANNELS.termWrite, id, data),
  termResize: (id, cols, rows) => ipcRenderer.invoke(CHANNELS.termResize, id, cols, rows),
  termClose: (id) => ipcRenderer.invoke(CHANNELS.termClose, id),

  fsList: (path) => ipcRenderer.invoke(CHANNELS.fsList, path),
  fsRead: (path) => ipcRenderer.invoke(CHANNELS.fsRead, path),
  fsWrite: (request) => ipcRenderer.invoke(CHANNELS.fsWrite, request),
  fsMkdir: (path) => ipcRenderer.invoke(CHANNELS.fsMkdir, path),

  workspaceExport: () => ipcRenderer.invoke(CHANNELS.workspaceExport),
  devcontainerWrite: () => ipcRenderer.invoke(CHANNELS.devcontainerWrite),

  onLog: (listener) => subscribe<LogLine>(EVENTS.log, listener),
  onTerminalData: (listener) => subscribe<TerminalData>(EVENTS.termData, listener),
  onTerminalExit: (listener) => subscribe<TerminalExit>(EVENTS.termExit, listener),
  onStateChanged: (listener) => subscribe<void>(EVENTS.stateChanged, () => listener()),
  onTerminalsReset: (listener) => subscribe<void>(EVENTS.terminalsReset, () => listener()),
};

contextBridge.exposeInMainWorld('cc', api);
