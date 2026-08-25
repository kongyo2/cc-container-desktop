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
  name: z.string().default(''),
  baseUrl: z.string().default(''),
  authMode: z.enum(['authToken', 'apiKey']).default('authToken'),
  model: z.string().default(''),
  sonnetModel: z.string().default(''),
  opusModel: z.string().default(''),
  haikuModel: z.string().default(''),
  fableModel: z.string().default(''),
  apiTimeoutMs: z.number().int().positive().nullable().default(null),
  contextTokens: z.number().int().positive().nullable().default(null),
  disableNonEssentialTraffic: z.boolean().default(true),
  disableTelemetry: z.boolean().default(true),
  extraEnv: z.record(z.string(), z.string()).default({}),
  note: z.string().default(''),
});

const mcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
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
  name: z.string().default(''),
  enabled: z.boolean().default(true),
  sourceKind: z.enum(['github', 'git']).default('github'),
  repo: z.string().default(''),
  url: z.string().default(''),
  autoUpdate: z.boolean().default(false),
});

const pluginSchema = z.object({
  id: z.string().min(1),
  plugin: z.string().default(''),
  marketplace: z.string().default(''),
  enabled: z.boolean().default(true),
});

const skillSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  body: z.string().default(''),
  files: z.array(z.object({ path: z.string().default(''), content: z.string().default('') })).default([]),
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
  version: z.literal(1).catch(1).default(1),
  language: z.enum(['ja', 'en']).catch('ja').default('ja'),
  activeProfileId: z.string().nullable().default(null),
  profiles: z.array(profileSchema).default([]),
  containerName: z.string().min(1).catch(DEFAULT_CONTAINER_NAME).default(DEFAULT_CONTAINER_NAME),
  imageTag: z.string().min(1).catch(DEFAULT_IMAGE_TAG).default(DEFAULT_IMAGE_TAG),
  volumeName: z.string().min(1).catch(DEFAULT_VOLUME_NAME).default(DEFAULT_VOLUME_NAME),
  autoOnboarding: z.boolean().default(true),
  autoApproveApiKey: z.boolean().default(true),
  skipPermissions: z.boolean().default(true),
  tmuxSession: z.string().min(1).catch(DEFAULT_TMUX_SESSION).default(DEFAULT_TMUX_SESSION),
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
    fableModel: openrouter?.model ?? '',
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

interface Checker {
  readonly safeParse: (value: unknown) => { readonly success: boolean };
}

function keepValid(schema: Checker, raw: unknown, report: { dropped: number }): unknown[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) report.dropped += 1;
    return [];
  }
  const items: unknown[] = [];
  for (const item of raw) {
    if (schema.safeParse(item).success) items.push(item);
    else report.dropped += 1;
  }
  return items;
}

function salvage(raw: unknown): { source: unknown; dropped: number } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { source: raw, dropped: 0 };
  const report = { dropped: 0 };
  const source: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  source['profiles'] = keepValid(profileSchema, source['profiles'], report);

  const extensions = source['extensions'];
  if (typeof extensions === 'object' && extensions !== null && !Array.isArray(extensions)) {
    const next: Record<string, unknown> = { ...(extensions as Record<string, unknown>) };
    next['mcpServers'] = keepValid(mcpServerSchema, next['mcpServers'], report);
    next['marketplaces'] = keepValid(marketplaceSchema, next['marketplaces'], report);
    next['plugins'] = keepValid(pluginSchema, next['plugins'], report);
    next['skills'] = keepValid(skillSchema, next['skills'], report);
    source['extensions'] = next;
  }

  return { source, dropped: report.dropped };
}

export interface ConfigRead {
  readonly config: AppConfig;
  readonly dropped: number;
  readonly reset: boolean;
}

export function readConfig(raw: unknown): ConfigRead {
  const { source, dropped } = salvage(raw);
  const parsed = appConfigSchema.safeParse(source);
  if (!parsed.success) return { config: defaultConfig(), dropped, reset: true };
  return { config: fromSchema(parsed.data), dropped, reset: false };
}

export function parseConfig(raw: unknown): AppConfig {
  return readConfig(raw).config;
}

// `salvage` drops profile rows that no longer parse, and a hand-edited or
// downgraded config.json can name a profile that was never there. A selection
// that resolves to nothing reads as "no profile" to the main process — which
// then provisions the container with no `env` block at all, losing its endpoint
// and credentials — while the Profiles tab goes on showing the first profile as
// the one being edited. Point it back at a profile that exists.
function resolveActiveProfile(activeProfileId: string | null, profiles: readonly Profile[]): string | null {
  if (activeProfileId === null) return null;
  if (profiles.some((profile) => profile.id === activeProfileId)) return activeProfileId;
  return profiles[0]?.id ?? null;
}

function fromSchema(value: z.infer<typeof appConfigSchema>): AppConfig {
  return {
    version: 1,
    language: value.language,
    activeProfileId: resolveActiveProfile(value.activeProfileId, value.profiles),
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
