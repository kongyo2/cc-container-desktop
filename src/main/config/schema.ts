import { z } from 'zod';

import {
  DEFAULT_CONTAINER_NAME,
  DEFAULT_IMAGE_TAG,
  DEFAULT_TMUX_SESSION,
  DEFAULT_VOLUME_NAME,
  ENDPOINT_PRESETS,
} from '../../shared/presets.ts';
import type { AppConfig, Extensions, ManagedNames, Profile } from '../../shared/types.ts';

const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().default(''),
  authMode: z.enum(['authToken', 'apiKey']).default('authToken'),
  model: z.string().default(''),
  sonnetModel: z.string().default(''),
  opusModel: z.string().default(''),
  haikuModel: z.string().default(''),
  apiTimeoutMs: z.number().int().positive().nullable().default(null),
  contextTokens: z.number().int().positive().nullable().default(null),
  disableNonEssentialTraffic: z.boolean().default(true),
  disableTelemetry: z.boolean().default(true),
  extraEnv: z.record(z.string(), z.string()).default({}),
  note: z.string().default(''),
});

const mcpNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u);

const mcpServerSchema = z.object({
  id: z.string().min(1),
  name: mcpNameSchema,
  enabled: z.boolean().default(true),
  transport: z.enum(['stdio', 'http', 'sse']).default('http'),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().default(''),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().nullable().default(null),
  note: z.string().default(''),
});

const marketplaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  sourceKind: z.enum(['github', 'git']).default('github'),
  repo: z.string().default(''),
  url: z.string().default(''),
  autoUpdate: z.boolean().default(false),
});

const pluginSchema = z.object({
  id: z.string().min(1),
  plugin: z.string().min(1),
  marketplace: z.string().min(1),
  enabled: z.boolean().default(true),
});

const skillSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  body: z.string().default(''),
  files: z.array(z.object({ path: z.string().min(1), content: z.string().default('') })).default([]),
});

const extensionsSchema = z.object({
  mcpServers: z.array(mcpServerSchema).default([]),
  marketplaces: z.array(marketplaceSchema).default([]),
  plugins: z.array(pluginSchema).default([]),
  skills: z.array(skillSchema).default([]),
});

const managedSchema = z.object({
  mcpServers: z.array(z.string()).default([]),
  marketplaces: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
});

const appConfigSchema = z.object({
  version: z.literal(1).default(1),
  language: z.enum(['ja', 'en']).default('ja'),
  activeProfileId: z.string().nullable().default(null),
  profiles: z.array(profileSchema).default([]),
  containerName: z.string().min(1).default(DEFAULT_CONTAINER_NAME),
  imageTag: z.string().min(1).default(DEFAULT_IMAGE_TAG),
  volumeName: z.string().min(1).default(DEFAULT_VOLUME_NAME),
  autoOnboarding: z.boolean().default(true),
  autoApproveApiKey: z.boolean().default(true),
  skipPermissions: z.boolean().default(true),
  tmuxSession: z.string().min(1).default(DEFAULT_TMUX_SESSION),
  lastExportDir: z.string().nullable().default(null),
  exportBeforeReset: z.boolean().default(true),
  extensions: extensionsSchema.default({ mcpServers: [], marketplaces: [], plugins: [], skills: [] }),
  managed: managedSchema.default({ mcpServers: [], marketplaces: [], plugins: [], skills: [] }),
});

export function starterProfile(): Profile {
  const openrouter = ENDPOINT_PRESETS.find((preset) => preset.id === 'openrouter');
  return {
    id: 'openrouter-default',
    name: 'OpenRouter',
    baseUrl: openrouter?.baseUrl ?? 'https://openrouter.ai/api/v1',
    authMode: 'authToken',
    model: openrouter?.model ?? '',
    sonnetModel: openrouter?.model ?? '',
    opusModel: openrouter?.model ?? '',
    haikuModel: openrouter?.haikuModel ?? '',
    apiTimeoutMs: null,
    contextTokens: openrouter?.contextTokens ?? null,
    disableNonEssentialTraffic: true,
    disableTelemetry: true,
    extraEnv: {},
    note: '',
  };
}

export function emptyExtensions(): Extensions {
  return { mcpServers: [], marketplaces: [], plugins: [], skills: [] };
}

export function emptyManagedNames(): ManagedNames {
  return { mcpServers: [], marketplaces: [], plugins: [], skills: [] };
}

export function defaultConfig(): AppConfig {
  const profile = starterProfile();
  return {
    version: 1,
    language: 'ja',
    activeProfileId: profile.id,
    profiles: [profile],
    containerName: DEFAULT_CONTAINER_NAME,
    imageTag: DEFAULT_IMAGE_TAG,
    volumeName: DEFAULT_VOLUME_NAME,
    autoOnboarding: true,
    autoApproveApiKey: true,
    skipPermissions: true,
    tmuxSession: DEFAULT_TMUX_SESSION,
    lastExportDir: null,
    exportBeforeReset: true,
    extensions: emptyExtensions(),
    managed: emptyManagedNames(),
  };
}

export function parseConfig(raw: unknown): AppConfig {
  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) return defaultConfig();
  const value = parsed.data;
  return {
    version: 1,
    language: value.language,
    activeProfileId: value.activeProfileId,
    profiles: value.profiles,
    containerName: value.containerName,
    imageTag: value.imageTag,
    volumeName: value.volumeName,
    autoOnboarding: value.autoOnboarding,
    autoApproveApiKey: value.autoApproveApiKey,
    skipPermissions: value.skipPermissions,
    tmuxSession: value.tmuxSession,
    lastExportDir: value.lastExportDir,
    exportBeforeReset: value.exportBeforeReset,
    extensions: value.extensions,
    managed: value.managed,
  };
}
