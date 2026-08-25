/**
 * Endpoint presets.
 *
 * `ANTHROPIC_BASE_URL` is a *prefix*: Claude Code appends `/v1/messages` to it.
 * So OpenRouter's Anthropic-compatible endpoint, which lives at
 * `https://openrouter.ai/api/v1/messages`, needs a base URL of
 * `https://openrouter.ai/api` — including the `/v1` yourself produces
 * `/api/v1/v1/messages` and a 404 that Claude Code reports as "there's an issue
 * with the selected model", which sends you hunting in the wrong place.
 *
 * `verified` records whether this project actually ran a live request against
 * the endpoint; only OpenRouter has been, so treat the rest as starting points.
 */

import type { AuthMode } from './types.ts';

export interface EndpointPreset {
  readonly id: string;
  readonly label: string;
  /** Prefix only — Claude Code appends `/v1/messages`. */
  readonly baseUrl: string;
  readonly authMode: AuthMode;
  /** Suggested `ANTHROPIC_MODEL`; empty when the provider has no obvious default. */
  readonly model: string;
  /** Suggested Haiku-class model for background work. */
  readonly haikuModel: string;
  /** Real context window, for `CLAUDE_CODE_MAX_CONTEXT_TOKENS`; `null` to leave it alone. */
  readonly contextTokens: number | null;
  /** Where to get a key. */
  readonly keysUrl: string;
  /** True only when this repository has run a live request against the endpoint. */
  readonly verified: boolean;
}

/** The path Claude Code appends to `ANTHROPIC_BASE_URL`. Shown in the UI so the prefix rule is visible. */
export const MESSAGES_PATH = '/v1/messages';

/**
 * Trims a pasted URL back to the prefix Claude Code wants.
 *
 * People paste the full endpoint they see in provider docs; silently keeping it
 * produces a doubled path, so strip a trailing `/v1/messages` or `/messages`.
 */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/u, '');
  for (const suffix of [MESSAGES_PATH, '/messages']) {
    if (url.toLowerCase().endsWith(suffix)) {
      url = url.slice(0, -suffix.length).replace(/\/+$/u, '');
      break;
    }
  }
  return url;
}

export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    authMode: 'authToken',
    model: 'stealth/ox-alpha',
    haikuModel: 'stealth/ox-alpha',
    contextTokens: 1048576,
    keysUrl: 'https://openrouter.ai/keys',
    verified: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic (公式 / official)',
    baseUrl: 'https://api.anthropic.com',
    authMode: 'apiKey',
    model: 'claude-sonnet-5',
    haikuModel: 'claude-haiku-4-5-20251001',
    contextTokens: null,
    keysUrl: 'https://console.anthropic.com/settings/keys',
    verified: false,
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    authMode: 'authToken',
    model: '',
    haikuModel: '',
    contextTokens: null,
    keysUrl: 'https://platform.moonshot.ai/console/api-keys',
    verified: false,
  },
  {
    id: 'zai',
    label: 'Z.ai (GLM)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    authMode: 'authToken',
    model: '',
    haikuModel: '',
    contextTokens: null,
    keysUrl: 'https://z.ai/manage-apikey/apikey-list',
    verified: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authMode: 'authToken',
    model: '',
    haikuModel: '',
    contextTokens: null,
    keysUrl: 'https://platform.deepseek.com/api_keys',
    verified: false,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    authMode: 'authToken',
    model: '',
    haikuModel: '',
    contextTokens: null,
    keysUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    verified: false,
  },
  {
    id: 'custom',
    label: 'カスタム / Custom',
    baseUrl: '',
    authMode: 'authToken',
    model: '',
    haikuModel: '',
    contextTokens: null,
    keysUrl: '',
    verified: false,
  },
];

/**
 * Home directory of the unprivileged container user.
 *
 * A single named Docker volume is mounted here, so Claude Code's config, the npm
 * cache and the workspace all survive recreating (or rebuilding) the container.
 */
export const CONTAINER_HOME = '/home/claude';

/**
 * Absolute path of the workspace inside the container.
 *
 * It lives under {@link CONTAINER_HOME} on purpose: one volume covers both the
 * work and the configuration, which keeps "remove the container" from meaning
 * "lose the work".
 */
export const CONTAINER_WORKSPACE = '/home/claude/workspace';

/** Where the app drops the editable post-create script — outside the volume, so a rebuild replaces it. */
export const CONTAINER_SCRIPT_DIR = '/opt/cc';

/** The unprivileged container user, pinned to uid/gid 1000 by the Dockerfile. */
export const CONTAINER_USER = 'claude';

export const CONTAINER_UID = 1000;
export const CONTAINER_GID = 1000;

/** Defaults for a freshly installed app. */
export const DEFAULT_CONTAINER_NAME = 'cc-workbench';
export const DEFAULT_IMAGE_TAG = 'cc-container-desktop:latest';
export const DEFAULT_VOLUME_NAME = 'cc-workbench-home';
export const DEFAULT_TMUX_SESSION = 'cc';
