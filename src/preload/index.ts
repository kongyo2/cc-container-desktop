import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { CHANNELS, EVENTS } from '../shared/ipc.ts';
import type { Api } from '../shared/ipc.ts';
import type { LogLine, TerminalData, TerminalExit, TerminalsReset } from '../shared/types.ts';

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
  pathForFile: (file) => webUtils.getPathForFile(file),

  configSave: (patch) => ipcRenderer.invoke(CHANNELS.configSave, patch),
  profileUpsert: (profile) => ipcRenderer.invoke(CHANNELS.profileUpsert, profile),
  profileDelete: (id) => ipcRenderer.invoke(CHANNELS.profileDelete, id),
  profileApply: (id) => ipcRenderer.invoke(CHANNELS.profileApply, id),
  secretGet: (profileId) => ipcRenderer.invoke(CHANNELS.secretGet, profileId),
  secretSet: (profileId, secret) => ipcRenderer.invoke(CHANNELS.secretSet, profileId, secret),

  environmentUpsert: (environment) => ipcRenderer.invoke(CHANNELS.environmentUpsert, environment),
  environmentArchive: (id, archived) => ipcRenderer.invoke(CHANNELS.environmentArchive, id, archived),
  environmentDelete: (id) => ipcRenderer.invoke(CHANNELS.environmentDelete, id),

  dockerProbe: () => ipcRenderer.invoke(CHANNELS.dockerProbe),
  imageBuild: (request) => ipcRenderer.invoke(CHANNELS.imageBuild, request),

  extensionsSave: (extensions) => ipcRenderer.invoke(CHANNELS.extensionsSave, extensions),
  extensionsApply: () => ipcRenderer.invoke(CHANNELS.extensionsApply),

  taskCreate: (input) => ipcRenderer.invoke(CHANNELS.taskCreate, input),
  taskUpdate: (id, patch) => ipcRenderer.invoke(CHANNELS.taskUpdate, id, patch),
  taskStart: (id) => ipcRenderer.invoke(CHANNELS.taskStart, id),
  taskStop: (id) => ipcRenderer.invoke(CHANNELS.taskStop, id),
  taskRecreate: (id) => ipcRenderer.invoke(CHANNELS.taskRecreate, id),
  taskDelete: (id, request) => ipcRenderer.invoke(CHANNELS.taskDelete, id, request),
  taskProvision: (id) => ipcRenderer.invoke(CHANNELS.taskProvision, id),
  taskExport: (id) => ipcRenderer.invoke(CHANNELS.taskExport, id),
  taskImport: (id, paths) => ipcRenderer.invoke(CHANNELS.taskImport, id, paths),
  taskPickImport: (id, pick) => ipcRenderer.invoke(CHANNELS.taskPickImport, id, pick),
  taskExec: (id, request) => ipcRenderer.invoke(CHANNELS.taskExec, id, request),
  taskMcpStatus: (id) => ipcRenderer.invoke(CHANNELS.taskMcpStatus, id),

  termOpen: (request) => ipcRenderer.invoke(CHANNELS.termOpen, request),
  termWrite: (id, data) => ipcRenderer.invoke(CHANNELS.termWrite, id, data),
  termResize: (id, cols, rows) => ipcRenderer.invoke(CHANNELS.termResize, id, cols, rows),
  termClose: (id) => ipcRenderer.invoke(CHANNELS.termClose, id),

  onLog: (listener) => subscribe<LogLine>(EVENTS.log, listener),
  onTerminalData: (listener) => subscribe<TerminalData>(EVENTS.termData, listener),
  onTerminalExit: (listener) => subscribe<TerminalExit>(EVENTS.termExit, listener),
  onStateChanged: (listener) => subscribe<void>(EVENTS.stateChanged, () => listener()),
  onTerminalsReset: (listener) => subscribe<TerminalsReset>(EVENTS.terminalsReset, listener),
};

contextBridge.exposeInMainWorld('cc', api);
