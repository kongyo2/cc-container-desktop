export type Language = 'ja' | 'en';

export type AuthMode = 'authToken' | 'apiKey';

export interface Profile {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly authMode: AuthMode;
  readonly model: string;
  readonly sonnetModel: string;
  readonly opusModel: string;
  readonly haikuModel: string;
  readonly fableModel: string;
  readonly apiTimeoutMs: number | null;
  readonly contextTokens: number | null;
  readonly disableNonEssentialTraffic: boolean;
  readonly disableTelemetry: boolean;
  readonly extraEnv: Readonly<Record<string, string>>;
  readonly note: string;
}

export interface AppConfig {
  readonly version: 2;
  readonly language: Language;
  readonly defaultProfileId: string | null;
  readonly profiles: readonly Profile[];
  readonly imageTag: string;
  readonly autoOnboarding: boolean;
  readonly autoApproveApiKey: boolean;
  readonly skipPermissions: boolean;
  readonly lastExportDir: string | null;
  readonly extensions: Extensions;
}

export type ConfigPatch = Partial<
  Pick<
    AppConfig,
    'defaultProfileId' | 'imageTag' | 'autoOnboarding' | 'autoApproveApiKey' | 'skipPermissions' | 'lastExportDir'
  >
>;

export type WorkspaceSource =
  { readonly kind: 'empty' } | { readonly kind: 'git'; readonly url: string; readonly ref: string };

export interface Task {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly profileId: string | null;
  readonly source: WorkspaceSource;
  readonly containerName: string;
  readonly volumeName: string;
  readonly createdAt: string;
  readonly managed: ManagedNames;
}

export interface NewTaskInput {
  readonly name: string;
  readonly note: string;
  readonly profileId: string | null;
  readonly source: WorkspaceSource;
}

export interface TaskPatch {
  readonly name?: string;
  readonly note?: string;
  readonly profileId?: string | null;
}

export interface CreateTaskResult {
  readonly task: Task;
  readonly warning: string | null;
}

export interface DockerStatus {
  readonly available: boolean;
  readonly version: string | null;
  readonly apiVersion: string | null;
  readonly os: string | null;
  readonly error: string | null;
}

export interface ImageStatus {
  readonly tag: string;
  readonly exists: boolean;
  readonly id: string | null;
  readonly createdAt: string | null;
  readonly sizeBytes: number | null;
}

export interface ContainerState {
  readonly exists: boolean;
  readonly running: boolean;
  readonly status: string;
  readonly id: string | null;
  readonly imageId: string | null;
  readonly startedAt: string | null;
  readonly homeVolume: string | null;
}

export interface TaskView {
  readonly task: Task;
  readonly container: ContainerState;
  readonly imageStale: boolean;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Snapshot {
  readonly config: AppConfig;
  readonly docker: DockerStatus;
  readonly image: ImageStatus;
  readonly tasks: readonly TaskView[];
  readonly secretsEncrypted: boolean;
  readonly appVersion: string;
  readonly platform: string;
}

export interface LogLine {
  readonly stream: 'build' | 'app' | 'provision';
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
  readonly at: number;
}

export interface TerminalData {
  readonly id: string;
  readonly data: string;
}

export interface TerminalExit {
  readonly id: string;
  readonly exitCode: number | null;
}

export interface TerminalsReset {
  readonly taskId: string;
}

export type TerminalKind = 'claude' | 'shell';

export interface OpenTerminalRequest {
  readonly taskId: string;
  readonly kind: TerminalKind;
  readonly cols: number;
  readonly rows: number;
}

export interface OpenTerminalResult {
  readonly id: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface ImageSources {
  readonly dockerfile: string;
  readonly setup: string;
  readonly postCreate: string;
  readonly dir: string;
}

export interface ExportSummary {
  readonly path: string;
  readonly files: number;
  readonly skipped: readonly string[];
}

export interface ImportSummary {
  readonly entries: number;
  readonly sources: readonly string[];
}

export interface DeleteTaskRequest {
  readonly exportFirst: boolean;
}

export interface DeleteTaskSummary {
  readonly exportedTo: string | null;
  readonly exportedFiles: number;
}

export type ImportPick = 'files' | 'folder';

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: McpTransport;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number | null;
  readonly note: string;
}

export type MarketplaceSourceKind = 'github' | 'git';

export interface MarketplaceConfig {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly sourceKind: MarketplaceSourceKind;
  readonly repo: string;
  readonly url: string;
  readonly autoUpdate: boolean;
}

export interface PluginConfig {
  readonly id: string;
  readonly plugin: string;
  readonly marketplace: string;
  readonly enabled: boolean;
}

export interface SkillInstallConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly source: string;
  readonly skills: readonly string[];
  readonly note: string;
}

export interface Extensions {
  readonly mcpServers: readonly McpServerConfig[];
  readonly marketplaces: readonly MarketplaceConfig[];
  readonly plugins: readonly PluginConfig[];
  readonly skillInstalls: readonly SkillInstallConfig[];
}

export interface ManagedNames {
  readonly mcpServers: readonly string[];
  readonly marketplaces: readonly string[];
  readonly plugins: readonly string[];
}

export interface McpServerStatus {
  readonly name: string;
  readonly status: string;
  readonly healthy: boolean;
  readonly detail: string;
}
