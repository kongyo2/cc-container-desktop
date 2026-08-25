/**
 * The IPC contract.
 *
 * `Api` is the single source of truth: the preload script builds an object of
 * this shape out of `ipcRenderer.invoke` calls, and the main process registers
 * one `ipcMain.handle` per channel. Channel names are derived from the same
 * literal union, so a typo fails to compile instead of failing at runtime.
 */

import type {
  AppConfig,
  ExecResult,
  FileEntry,
  ImageSources,
  Language,
  LogLine,
  OpenTerminalRequest,
  OpenTerminalResult,
  Profile,
  Result,
  Snapshot,
  TerminalData,
  TerminalExit,
  TmuxSession,
} from './types.ts';

/** Channels the renderer invokes. */
export const CHANNELS = {
  snapshot: 'app:snapshot',
  setLanguage: 'app:setLanguage',
  openExternal: 'app:openExternal',
  revealPath: 'app:revealPath',

  configSave: 'config:save',
  profileUpsert: 'profile:upsert',
  profileDelete: 'profile:delete',
  profileActivate: 'profile:activate',
  secretGet: 'secret:get',
  secretSet: 'secret:set',

  dockerProbe: 'docker:probe',
  imageBuild: 'image:build',
  imageSourcesGet: 'image:sourcesGet',
  imageSourcesSave: 'image:sourcesSave',
  imageSourcesReset: 'image:sourcesReset',

  containerUp: 'container:up',
  containerStop: 'container:stop',
  containerRestart: 'container:restart',
  containerRemove: 'container:remove',
  containerState: 'container:state',
  containerExec: 'container:exec',
  containerProvision: 'container:provision',
  containerVscode: 'container:vscode',

  tmuxList: 'tmux:list',
  tmuxKill: 'tmux:kill',

  termOpen: 'term:open',
  termWrite: 'term:write',
  termResize: 'term:resize',
  termClose: 'term:close',

  fsList: 'fs:list',
  fsRead: 'fs:read',
  fsWrite: 'fs:write',
  fsMkdir: 'fs:mkdir',

  workspaceExport: 'workspace:export',
  devcontainerWrite: 'devcontainer:write',
} as const;

/** Events pushed from main to renderer. */
export const EVENTS = {
  log: 'evt:log',
  termData: 'evt:term:data',
  termExit: 'evt:term:exit',
  stateChanged: 'evt:state',
} as const;

/** Payload for {@link Api.fsWrite}. */
export interface WriteFileRequest {
  readonly path: string;
  readonly content: string;
}

/** Payload for {@link Api.containerExec}. */
export interface ExecRequest {
  readonly command: readonly string[];
  /** Runs as root when true; as the `claude` user otherwise. */
  readonly asRoot: boolean;
}

/** Payload for {@link Api.imageBuild}. */
export interface BuildRequest {
  readonly noCache: boolean;
}

/** What the renderer gets back from a VS Code attach request. */
export interface VscodeAttachResult {
  readonly launched: boolean;
  /** The `vscode-remote://attached-container+<hex>` URI, always returned so it can be copied manually. */
  readonly uri: string;
  readonly hint: string;
}

/** The full renderer-facing API surface exposed on `window.cc`. */
export interface Api {
  snapshot(): Promise<Result<Snapshot>>;
  setLanguage(language: Language): Promise<Result<AppConfig>>;
  openExternal(url: string): Promise<Result<null>>;
  revealPath(path: string): Promise<Result<null>>;

  configSave(patch: Partial<AppConfig>): Promise<Result<AppConfig>>;
  profileUpsert(profile: Profile): Promise<Result<AppConfig>>;
  profileDelete(id: string): Promise<Result<AppConfig>>;
  profileActivate(id: string): Promise<Result<AppConfig>>;
  secretGet(profileId: string): Promise<Result<string>>;
  secretSet(profileId: string, secret: string): Promise<Result<null>>;

  dockerProbe(): Promise<Result<Snapshot>>;
  imageBuild(request: BuildRequest): Promise<Result<null>>;
  imageSourcesGet(): Promise<Result<ImageSources>>;
  imageSourcesSave(sources: Pick<ImageSources, 'dockerfile' | 'postCreate'>): Promise<Result<ImageSources>>;
  imageSourcesReset(): Promise<Result<ImageSources>>;

  containerUp(): Promise<Result<Snapshot>>;
  containerStop(): Promise<Result<Snapshot>>;
  containerRestart(): Promise<Result<Snapshot>>;
  containerRemove(removeVolume: boolean): Promise<Result<Snapshot>>;
  containerState(): Promise<Result<Snapshot>>;
  containerExec(request: ExecRequest): Promise<Result<ExecResult>>;
  /** Writes onboarding flags + `~/.claude/settings.json` from the active profile. */
  containerProvision(): Promise<Result<string>>;
  containerVscode(): Promise<Result<VscodeAttachResult>>;

  tmuxList(): Promise<Result<readonly TmuxSession[]>>;
  tmuxKill(name: string): Promise<Result<null>>;

  termOpen(request: OpenTerminalRequest): Promise<Result<OpenTerminalResult>>;
  termWrite(id: string, data: string): Promise<Result<null>>;
  termResize(id: string, cols: number, rows: number): Promise<Result<null>>;
  termClose(id: string): Promise<Result<null>>;

  fsList(path: string): Promise<Result<readonly FileEntry[]>>;
  fsRead(path: string): Promise<Result<string>>;
  fsWrite(request: WriteFileRequest): Promise<Result<null>>;
  fsMkdir(path: string): Promise<Result<null>>;

  workspaceExport(): Promise<Result<string | null>>;
  devcontainerWrite(): Promise<Result<string | null>>;

  onLog(listener: (line: LogLine) => void): () => void;
  onTerminalData(listener: (data: TerminalData) => void): () => void;
  onTerminalExit(listener: (exit: TerminalExit) => void): () => void;
  onStateChanged(listener: () => void): () => void;
}
