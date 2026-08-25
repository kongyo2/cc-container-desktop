import type { AuthMode } from './types.ts';

export interface EndpointPreset {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly authMode: AuthMode;
  readonly model: string;
  readonly haikuModel: string;
  readonly contextTokens: number | null;
  readonly keysUrl: string;
  readonly verified: boolean;
}

export const MESSAGES_PATH = '/v1/messages';

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

export const CONTAINER_HOME = '/home/claude';

export const CONTAINER_WORKSPACE = '/home/claude/workspace';

export const CONTAINER_SCRIPT_DIR = '/opt/cc';

export const CONTAINER_USER = 'claude';

export const CONTAINER_UID = 1000;
export const CONTAINER_GID = 1000;

export const DEFAULT_CONTAINER_NAME = 'cc-workbench';
export const DEFAULT_IMAGE_TAG = 'cc-container-desktop:latest';
export const DEFAULT_VOLUME_NAME = 'cc-workbench-home';
export const DEFAULT_TMUX_SESSION = 'cc';
