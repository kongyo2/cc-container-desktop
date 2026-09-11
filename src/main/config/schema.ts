import { z } from 'zod';

import { environmentEnvProblems, normalizeEnvironmentName, normalizeScriptText } from '../../shared/environments.ts';
import { isPlainObject } from '../../shared/json.ts';
import { DEFAULT_IMAGE_TAG, ENDPOINT_PRESETS } from '../../shared/presets.ts';
import type {
  AppConfig,
  ConfigPatch,
  Environment,
  EnvironmentDraft,
  Extensions,
  ManagedNames,
  Profile,
} from '../../shared/types.ts';

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

const environmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  envText: z.string().default(''),
  setupScript: z.string().default(''),
  archived: z.boolean().default(false),
  createdAt: z.string().default(''),
  updatedAt: z.string().default(''),
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
  version: z.literal(3).catch(3).default(3),
  language: z.enum(['ja', 'en']).catch('ja').default('ja'),
  defaultProfileId: z.string().nullable().default(null),
  profiles: z.array(profileSchema).default([]),
  defaultEnvironmentId: z.string().nullable().default(null),
  environments: z.array(environmentSchema).default([]),
  imageTag: z.string().min(1).catch(DEFAULT_IMAGE_TAG).default(DEFAULT_IMAGE_TAG),
  autoOnboarding: z.boolean().default(true),
  autoApproveApiKey: z.boolean().default(true),
  skipPermissions: z.boolean().default(true),
  lastExportDir: z.string().nullable().default(null),
  extensions: extensionsSchema.default({ mcpServers: [], marketplaces: [], plugins: [], skillInstalls: [] }),
});

const configPatchSchema = z.strictObject({
  defaultProfileId: z.string().nullable().optional(),
  defaultEnvironmentId: z.string().nullable().optional(),
  imageTag: z.string().trim().min(1).optional(),
  autoOnboarding: z.boolean().optional(),
  autoApproveApiKey: z.boolean().optional(),
  skipPermissions: z.boolean().optional(),
  lastExportDir: z.string().nullable().optional(),
});

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

const environmentDraftSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  envText: z.string(),
  setupScript: z.string(),
});

/** Checks what the renderer sent for an environment and normalizes it. */
export function parseEnvironmentDraft(raw: unknown): EnvironmentDraft {
  const parsed = environmentDraftSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`環境の内容が不正です / invalid environment: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  const name = normalizeEnvironmentName(parsed.data.name);
  if (name === '') throw new Error('環境の名前が空です / the environment name is empty');
  const envText = normalizeScriptText(parsed.data.envText);
  const problem = environmentEnvProblems(envText)[0];
  if (problem !== undefined) throw new Error(`環境変数 / environment variables: ${problem}`);
  return { id: parsed.data.id, name, envText, setupScript: normalizeScriptText(parsed.data.setupScript) };
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

/** The environment every fresh install starts with: the base image as it is. */
export function starterEnvironment(): Environment {
  const now = new Date().toISOString();
  return {
    id: 'environment-default',
    name: '環境1',
    envText: '',
    setupScript: '',
    archived: false,
    createdAt: now,
    updatedAt: now,
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
  const environment = starterEnvironment();
  return {
    version: 3,
    language: 'ja',
    defaultProfileId: profile.id,
    profiles: [profile],
    defaultEnvironmentId: environment.id,
    environments: [environment],
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
  if (!isPlainObject(raw)) return { source: raw, dropped: 0 };
  const report = { dropped: 0 };
  const source: Record<string, unknown> = { ...raw };

  if (source['defaultProfileId'] === undefined && typeof source['activeProfileId'] === 'string') {
    source['defaultProfileId'] = source['activeProfileId'];
  }

  // A config written before environments existed gets the starter one a fresh
  // install has, so the next task can be created without a detour.
  if (source['environments'] === undefined) {
    const starter = starterEnvironment();
    source['environments'] = [starter];
    if (source['defaultEnvironmentId'] === undefined) source['defaultEnvironmentId'] = starter.id;
  }

  source['profiles'] = keepValid(profileSchema, source['profiles'], report);
  source['environments'] = keepValid(environmentSchema, source['environments'], report);

  const extensions = source['extensions'];
  if (isPlainObject(extensions)) {
    const next: Record<string, unknown> = { ...extensions };
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

function resolveDefaultEnvironment(
  defaultEnvironmentId: string | null,
  environments: readonly Environment[],
): string | null {
  const usable = environments.filter((environment) => !environment.archived);
  if (defaultEnvironmentId !== null && usable.some((environment) => environment.id === defaultEnvironmentId)) {
    return defaultEnvironmentId;
  }
  return usable[0]?.id ?? null;
}

function dedupeById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    kept.push(item);
  }
  return kept;
}

function fromSchema(value: z.infer<typeof appConfigSchema>): AppConfig {
  const environments = dedupeById(value.environments);
  return {
    version: 3,
    language: value.language,
    defaultProfileId: resolveDefaultProfile(value.defaultProfileId, value.profiles),
    profiles: value.profiles,
    defaultEnvironmentId: resolveDefaultEnvironment(value.defaultEnvironmentId, environments),
    environments,
    imageTag: value.imageTag,
    autoOnboarding: value.autoOnboarding,
    autoApproveApiKey: value.autoApproveApiKey,
    skipPermissions: value.skipPermissions,
    lastExportDir: value.lastExportDir,
    extensions: value.extensions,
  };
}
