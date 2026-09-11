import type {
  AppConfig,
  ConfigPatch,
  CreateTaskResult,
  DeleteTaskRequest,
  DeleteTaskSummary,
  EnvironmentDraft,
  ExecResult,
  ExportSummary,
  Extensions,
  ImportPick,
  ImportSummary,
  Language,
  LogLine,
  McpServerStatus,
  NewTaskInput,
  OpenTerminalRequest,
  OpenTerminalResult,
  Profile,
  Result,
  Snapshot,
  Task,
  TaskPatch,
  TerminalData,
  TerminalExit,
  TerminalsReset,
} from './types.ts';

export const CHANNELS = {
  snapshot: 'app:snapshot',
  setLanguage: 'app:setLanguage',
  openExternal: 'app:openExternal',
  revealPath: 'app:revealPath',
  clipboardWrite: 'app:clipboardWrite',

  configSave: 'config:save',
  profileUpsert: 'profile:upsert',
  profileDelete: 'profile:delete',
  profileApply: 'profile:apply',
  secretGet: 'secret:get',
  secretSet: 'secret:set',

  environmentUpsert: 'environment:upsert',
  environmentArchive: 'environment:archive',
  environmentDelete: 'environment:delete',

  dockerProbe: 'docker:probe',
  imageBuild: 'image:build',

  extensionsSave: 'ext:save',
  extensionsApply: 'ext:apply',

  taskCreate: 'task:create',
  taskUpdate: 'task:update',
  taskStart: 'task:start',
  taskStop: 'task:stop',
  taskRecreate: 'task:recreate',
  taskDelete: 'task:delete',
  taskProvision: 'task:provision',
  taskExport: 'task:export',
  taskImport: 'task:import',
  taskPickImport: 'task:pickImport',
  taskExec: 'task:exec',
  taskMcpStatus: 'task:mcpStatus',

  termOpen: 'term:open',
  termWrite: 'term:write',
  termResize: 'term:resize',
  termClose: 'term:close',
} as const;

export const EVENTS = {
  log: 'evt:log',
  termData: 'evt:term:data',
  termExit: 'evt:term:exit',
  stateChanged: 'evt:state',
  terminalsReset: 'evt:term:reset',
} as const;

export interface ExecRequest {
  readonly command: readonly string[];
  readonly asRoot: boolean;
}

export interface BuildRequest {
  /** Rebuild every layer, pulling the base image again. */
  readonly noCache: boolean;
  /** Reinstall Claude Code (and the other global npm tools) without redoing the layers above. */
  readonly refreshClaudeCode: boolean;
}

export interface Api {
  snapshot(): Promise<Result<Snapshot>>;
  setLanguage(language: Language): Promise<Result<AppConfig>>;
  openExternal(url: string): Promise<Result<null>>;
  revealPath(path: string): Promise<Result<null>>;
  clipboardWrite(text: string): Promise<Result<null>>;
  pathForFile(file: File): string;

  configSave(patch: ConfigPatch): Promise<Result<AppConfig>>;
  profileUpsert(profile: Profile): Promise<Result<AppConfig>>;
  profileDelete(id: string): Promise<Result<AppConfig>>;
  profileApply(id: string): Promise<Result<readonly string[]>>;
  secretGet(profileId: string): Promise<Result<string>>;
  secretSet(profileId: string, secret: string): Promise<Result<null>>;

  environmentUpsert(environment: EnvironmentDraft): Promise<Result<AppConfig>>;
  environmentArchive(id: string, archived: boolean): Promise<Result<AppConfig>>;
  environmentDelete(id: string): Promise<Result<AppConfig>>;

  dockerProbe(): Promise<Result<Snapshot>>;
  imageBuild(request: BuildRequest): Promise<Result<null>>;

  extensionsSave(extensions: Extensions): Promise<Result<AppConfig>>;
  extensionsApply(): Promise<Result<readonly string[]>>;

  taskCreate(input: NewTaskInput): Promise<Result<CreateTaskResult>>;
  taskUpdate(id: string, patch: TaskPatch): Promise<Result<Task>>;
  taskStart(id: string): Promise<Result<Snapshot>>;
  taskStop(id: string): Promise<Result<Snapshot>>;
  taskRecreate(id: string): Promise<Result<Snapshot>>;
  taskDelete(id: string, request: DeleteTaskRequest): Promise<Result<DeleteTaskSummary>>;
  taskProvision(id: string): Promise<Result<string>>;
  taskExport(id: string): Promise<Result<ExportSummary | null>>;
  taskImport(id: string, paths: readonly string[]): Promise<Result<ImportSummary>>;
  taskPickImport(id: string, pick: ImportPick): Promise<Result<ImportSummary | null>>;
  taskExec(id: string, request: ExecRequest): Promise<Result<ExecResult>>;
  taskMcpStatus(id: string): Promise<Result<readonly McpServerStatus[]>>;

  termOpen(request: OpenTerminalRequest): Promise<Result<OpenTerminalResult>>;
  termWrite(id: string, data: string): Promise<Result<null>>;
  termResize(id: string, cols: number, rows: number): Promise<Result<null>>;
  termClose(id: string): Promise<Result<null>>;

  onLog(listener: (line: LogLine) => void): () => void;
  onTerminalData(listener: (data: TerminalData) => void): () => void;
  onTerminalExit(listener: (exit: TerminalExit) => void): () => void;
  onStateChanged(listener: () => void): () => void;
  onTerminalsReset(listener: (reset: TerminalsReset) => void): () => void;
}
