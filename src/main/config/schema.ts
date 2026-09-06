import { z } from 'zod';

import { DEFAULT_IMAGE_TAG, ENDPOINT_PRESETS } from '../../shared/presets.ts';
import type { AppConfig, ConfigPatch, Extensions, ManagedNames, Profile } from '../../shared/types.ts';

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

const skillInstallSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  source: z.string().default(''),
  skills: z.array(z.string()).default([]),
  note: z.string().default(''),
});

const extensionsSchema = z.object({
  mcpServers: z.array(mcpServerSchema).default([]),
  marketplaces: z.array(marketplaceSchema).default([]),
  plugins: z.array(pluginSchema).default([]),
  skillInstalls: z.array(skillInstallSchema).default([]),
});

const appConfigSchema = z.object({
  version: z.literal(2).catch(2).default(2),
  language: z.enum(['ja', 'en']).catch('ja').default('ja'),
  defaultProfileId: z.string().nullable().default(null),
  profiles: z.array(profileSchema).default([]),
  imageTag: z.string().min(1).catch(DEFAULT_IMAGE_TAG).default(DEFAULT_IMAGE_TAG),
  autoOnboarding: z.boolean().default(true),
  autoApproveApiKey: z.boolean().default(true),
  skipPermissions: z.boolean().default(true),
  lastExportDir: z.string().nullable().default(null),
  extensions: extensionsSchema.default({ mcpServers: [], marketplaces: [], plugins: [], skillInstalls: [] }),
});

/** What the renderer may change through configSave: everything else has its own channel. */
const configPatchSchema = z
  .object({
    defaultProfileId: z.string().nullable().optional(),
    imageTag: z.string().trim().min(1).optional(),
    autoOnboarding: z.boolean().optional(),
    autoApproveApiKey: z.boolean().optional(),
    skipPermissions: z.boolean().optional(),
    lastExportDir: z.string().nullable().optional(),
  })
  .strict();

export function parseConfigPatch(raw: unknown): ConfigPatch {
  const parsed = configPatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`設定の変更内容が不正です / invalid config patch: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) patch[key] = value;
  }
  return patch as ConfigPatch;
}

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
  return { mcpServers: [], marketplaces: [], plugins: [], skillInstalls: [] };
}

export function emptyManagedNames(): ManagedNames {
  return { mcpServers: [], marketplaces: [], plugins: [] };
}

export function defaultConfig(): AppConfig {
  const profile = starterProfile();
  return {
    version: 2,
    language: 'ja',
    defaultProfileId: profile.id,
    profiles: [profile],
    imageTag: DEFAULT_IMAGE_TAG,
    autoOnboarding: true,
    autoApproveApiKey: true,
    skipPermissions: true,
    lastExportDir: null,
    extensions: emptyExtensions(),
  };
}

interface Checker {
  readonly safeParse: (value: unknown) => { readonly success: boolean };
}

export function keepValid(schema: Checker, raw: unknown, report: { dropped: number }): unknown[] {
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
    next['skillInstalls'] = keepValid(skillInstallSchema, next['skillInstalls'], report);
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

function resolveDefaultProfile(defaultProfileId: string | null, profiles: readonly Profile[]): string | null {
  if (defaultProfileId !== null && profiles.some((profile) => profile.id === defaultProfileId)) {
    return defaultProfileId;
  }
  return profiles[0]?.id ?? null;
}

function fromSchema(value: z.infer<typeof appConfigSchema>): AppConfig {
  return {
    version: 2,
    language: value.language,
    defaultProfileId: resolveDefaultProfile(value.defaultProfileId, value.profiles),
    profiles: value.profiles,
    imageTag: value.imageTag,
    autoOnboarding: value.autoOnboarding,
    autoApproveApiKey: value.autoApproveApiKey,
    skipPermissions: value.skipPermissions,
    lastExportDir: value.lastExportDir,
    extensions: value.extensions,
  };
}
