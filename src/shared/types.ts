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
  readonly apiTimeoutMs: number | null;
  readonly contextTokens: number | null;
  readonly disableNonEssentialTraffic: boolean;
  readonly disableTelemetry: boolean;
  readonly extraEnv: Readonly<Record<string, string>>;
  readonly note: string;
}

export interface AppConfig {
  readonly version: 1;
  readonly language: Language;
  readonly activeProfileId: string | null;
  readonly profiles: readonly Profile[];
  readonly containerName: string;
  readonly imageTag: string;
  readonly volumeName: string;
  readonly autoOnboarding: boolean;
  readonly autoApproveApiKey: boolean;
  readonly skipPermissions: boolean;
  readonly tmuxSession: string;
  readonly lastExportDir: string | null;
  readonly exportBeforeReset: boolean;
  readonly extensions: Extensions;
  readonly managed: ManagedNames;
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
  readonly name: string;
  readonly exists: boolean;
  readonly running: boolean;
  readonly status: string;
  readonly id: string | null;
  readonly image: string | null;
  readonly startedAt: string | null;
}

export interface TmuxSession {
  readonly name: string;
  readonly windows: number;
  readonly attached: boolean;
  readonly createdAt: string;
}

export type FileKind = 'file' | 'dir' | 'link' | 'other';

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly mode: string;
  readonly modifiedAt: string;
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
  readonly container: ContainerState;
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

export type TerminalKind = 'claude' | 'shell' | 'attach';

export interface OpenTerminalRequest {
  readonly kind: TerminalKind;
  readonly sessionName: string;
  readonly cols: number;
  readonly rows: number;
}

export interface OpenTerminalResult {
  readonly id: string;
  readonly sessionName: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface ImageSources {
  readonly dockerfile: string;
  readonly setup: string;
  readonly postCreate: string;
  readonly dir: string;
}

export interface ResetSummary {
  readonly exportedTo: string | null;
  readonly exportedFiles: number;
  readonly exportSkipped: number;
  readonly rebuiltImage: boolean;
  readonly containerName: string;
  readonly provisionError: string | null;
}

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

export interface SkillConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly body: string;
  readonly files: readonly SkillFileConfig[];
}

export interface SkillFileConfig {
  readonly path: string;
  readonly content: string;
}

export interface Extensions {
  readonly mcpServers: readonly McpServerConfig[];
  readonly marketplaces: readonly MarketplaceConfig[];
  readonly plugins: readonly PluginConfig[];
  readonly skills: readonly SkillConfig[];
}

export interface ManagedNames {
  readonly mcpServers: readonly string[];
  readonly marketplaces: readonly string[];
  readonly plugins: readonly string[];
  readonly skills: readonly string[];
}

export interface McpServerStatus {
  readonly name: string;
  readonly status: string;
  readonly healthy: boolean;
  readonly detail: string;
}
