/**
 * Types shared by the main process, the preload bridge and the renderer.
 *
 * Everything here must stay structurally cloneable: these values cross the
 * `contextBridge` / `ipcRenderer` boundary, which uses the structured clone
 * algorithm and silently rejects class instances, functions and symbols.
 */

export type Language = 'ja' | 'en';

/**
 * Which HTTP header carries the credential.
 *
 * - `authToken` -> `ANTHROPIC_AUTH_TOKEN`, sent as `Authorization: Bearer <token>`.
 *   Claude Code never shows an approval prompt for this one, so it is the default.
 * - `apiKey` -> `ANTHROPIC_API_KEY`, sent as `X-Api-Key`. Interactive sessions ask
 *   you to approve the key once; {@link AppConfig.autoApproveApiKey} pre-answers that.
 */
export type AuthMode = 'authToken' | 'apiKey';

/** One endpoint + model + credential combination. The credential itself lives in the secret store. */
export interface Profile {
  readonly id: string;
  readonly name: string;
  /** `ANTHROPIC_BASE_URL`. No trailing slash. */
  readonly baseUrl: string;
  readonly authMode: AuthMode;
  /** `ANTHROPIC_MODEL` — the model new sessions start on. */
  readonly model: string;
  /** `ANTHROPIC_DEFAULT_SONNET_MODEL`. Empty string means "do not set". */
  readonly sonnetModel: string;
  /** `ANTHROPIC_DEFAULT_OPUS_MODEL`. Empty string means "do not set". */
  readonly opusModel: string;
  /** `ANTHROPIC_DEFAULT_HAIKU_MODEL` — also used for background tasks. */
  readonly haikuModel: string;
  /** `API_TIMEOUT_MS`. `null` leaves Claude Code's own default in place. */
  readonly apiTimeoutMs: number | null;
  /**
   * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — the real context window of a model ID
   * Claude Code does not recognize. Without it, auto-compaction runs against the
   * 200k window Claude Code assumes for unknown IDs, throwing away context a
   * 1M-token model could still hold. `null` leaves the assumption in place.
   */
  readonly contextTokens: number | null;
  /** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` — blocks auto-update, telemetry, availability probes. */
  readonly disableNonEssentialTraffic: boolean;
  /** `DISABLE_TELEMETRY`. */
  readonly disableTelemetry: boolean;
  /** Extra `env` entries merged into `~/.claude/settings.json` last, so they win. */
  readonly extraEnv: Readonly<Record<string, string>>;
  /** Free-form note shown in the profile list. */
  readonly note: string;
}

/** Persisted application configuration (`config.json` in Electron's `userData`). */
export interface AppConfig {
  readonly version: 1;
  readonly language: Language;
  readonly activeProfileId: string | null;
  readonly profiles: readonly Profile[];
  /** Docker container name. A single long-lived container is reused across profiles. */
  readonly containerName: string;
  /** Tag of the locally built image. */
  readonly imageTag: string;
  /** Named Docker volume mounted at `/home/claude`; survives container recreation. */
  readonly volumeName: string;
  /** Re-assert `hasCompletedOnboarding: true` in `~/.claude.json` on every launch. */
  readonly autoOnboarding: boolean;
  /** Pre-approve `ANTHROPIC_API_KEY` in `~/.claude.json` so interactive mode does not ask. */
  readonly autoApproveApiKey: boolean;
  /** Pass `--dangerously-skip-permissions` when launching Claude Code. */
  readonly skipPermissions: boolean;
  /** tmux session name used for the resumable Claude Code session. */
  readonly tmuxSession: string;
  /** Last directory picked in the export dialog. */
  readonly lastExportDir: string | null;
}

/** Result of probing the Docker Engine. */
export interface DockerStatus {
  readonly available: boolean;
  readonly version: string | null;
  readonly apiVersion: string | null;
  readonly os: string | null;
  readonly error: string | null;
}

/** Whether the locally built image exists. */
export interface ImageStatus {
  readonly tag: string;
  readonly exists: boolean;
  readonly id: string | null;
  readonly createdAt: string | null;
  readonly sizeBytes: number | null;
}

/** Lifecycle state of the workbench container. */
export interface ContainerState {
  readonly name: string;
  readonly exists: boolean;
  readonly running: boolean;
  /** Docker's own status string, e.g. `running`, `exited`, `created`. */
  readonly status: string;
  readonly id: string | null;
  readonly image: string | null;
  readonly startedAt: string | null;
}

/** A tmux session living inside the container. Attaching to one is how "reconnect" works. */
export interface TmuxSession {
  readonly name: string;
  readonly windows: number;
  readonly attached: boolean;
  readonly createdAt: string;
}

export type FileKind = 'file' | 'dir' | 'link' | 'other';

/** One entry in the in-container file browser. */
export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly mode: string;
  readonly modifiedAt: string;
}

/** Result of a non-interactive `docker exec`. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Everything the renderer needs to paint the dashboard in one round trip. */
export interface Snapshot {
  readonly config: AppConfig;
  readonly docker: DockerStatus;
  readonly image: ImageStatus;
  readonly container: ContainerState;
  readonly secretsEncrypted: boolean;
  readonly appVersion: string;
  readonly platform: string;
}

/** A line of build / provisioning output streamed to the renderer. */
export interface LogLine {
  readonly stream: 'build' | 'app' | 'provision';
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
  readonly at: number;
}

/** Terminal payloads pushed from main to renderer. */
export interface TerminalData {
  readonly id: string;
  readonly data: string;
}

export interface TerminalExit {
  readonly id: string;
  readonly exitCode: number | null;
}

/** How a terminal tab was opened, so the UI can label and restart it. */
export type TerminalKind = 'claude' | 'shell' | 'attach';

export interface OpenTerminalRequest {
  readonly kind: TerminalKind;
  /** For `attach`, the tmux session to attach to. Ignored otherwise. */
  readonly sessionName: string;
  readonly cols: number;
  readonly rows: number;
}

export interface OpenTerminalResult {
  readonly id: string;
  readonly sessionName: string;
}

/** Uniform result wrapper so IPC never rejects across the bridge. */
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** Editable container-image sources, materialized into `userData/docker` on first run. */
export interface ImageSources {
  readonly dockerfile: string;
  readonly postCreate: string;
  readonly dir: string;
}
