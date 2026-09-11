import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { environmentEnvProblems, normalizeEnvironmentName, normalizeScriptText } from '../../shared/environments.ts';
import { REGISTERED_IMAGE_ID_PATTERN } from '../../shared/images.ts';
import { ENDPOINT_PRESETS } from '../../shared/presets.ts';
import type {
  AppConfig,
  ConfigPatch,
  Environment,
  EnvironmentDraft,
  Extensions,
  ManagedNames,
  Profile,
} from '../../shared/types.ts';
import { AppFailure } from '../errors.ts';
import type { ParseOutcome } from '../state/file.ts';

const INSTANCE_ID_PATTERN: RegExp = /^inst_[0-9a-f]{16}$/u;

const profileSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  baseUrl: z.string(),
  authMode: z.enum(['authToken', 'apiKey']),
  model: z.string(),
  sonnetModel: z.string(),
  opusModel: z.string(),
  haikuModel: z.string(),
  fableModel: z.string(),
  apiTimeoutMs: z.number().int().positive().nullable(),
  contextTokens: z.number().int().positive().nullable(),
  disableNonEssentialTraffic: z.boolean(),
  disableTelemetry: z.boolean(),
  extraEnv: z.record(z.string(), z.string()),
  note: z.string(),
});

const environmentSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  imageId: z.string().regex(REGISTERED_IMAGE_ID_PATTERN),
  envText: z.string(),
  setupScript: z.string(),
  archived: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const mcpServerSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  timeoutMs: z.number().int().positive().nullable(),
  note: z.string(),
});

const marketplaceSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  sourceKind: z.enum(['github', 'git']),
  repo: z.string(),
  url: z.string(),
  autoUpdate: z.boolean(),
});

const pluginSchema = z.strictObject({
  id: z.string().min(1),
  plugin: z.string(),
  marketplace: z.string(),
  enabled: z.boolean(),
});

const skillInstallSchema = z.strictObject({
  id: z.string().min(1),
  enabled: z.boolean(),
  source: z.string(),
  skills: z.array(z.string()),
  note: z.string(),
});

const extensionsSchema = z.strictObject({
  mcpServers: z.array(mcpServerSchema),
  marketplaces: z.array(marketplaceSchema),
  plugins: z.array(pluginSchema),
  skillInstalls: z.array(skillInstallSchema),
});

const appConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  dataInstanceId: z.string().regex(INSTANCE_ID_PATTERN),
  language: z.enum(['ja', 'en']),
  defaultProfileId: z.string().nullable(),
  profiles: z.array(profileSchema),
  defaultEnvironmentId: z.string().nullable(),
  environments: z.array(environmentSchema),
  autoOnboarding: z.boolean(),
  autoApproveApiKey: z.boolean(),
  skipPermissions: z.boolean(),
  lastExportDir: z.string().nullable(),
  extensions: extensionsSchema,
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? 'invalid' : `${issue.path.join('.') || '(root)'}: ${issue.message}`;
}

function invalid(label: string, error: z.ZodError): AppFailure {
  return new AppFailure('INVALID_INPUT', `${label}: ${firstIssue(error)}`);
}

const configPatchSchema = z.strictObject({
  defaultProfileId: z.string().nullable().optional(),
  defaultEnvironmentId: z.string().nullable().optional(),
  autoOnboarding: z.boolean().optional(),
  autoApproveApiKey: z.boolean().optional(),
  skipPermissions: z.boolean().optional(),
  lastExportDir: z.string().nullable().optional(),
});

export function parseConfigPatch(raw: unknown): ConfigPatch {
  const parsed = configPatchSchema.safeParse(raw);
  if (!parsed.success) throw invalid('設定の変更内容が不正です / invalid config patch', parsed.error);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) patch[key] = value;
  }
  return patch as ConfigPatch;
}

export function parseProfile(raw: unknown): Profile {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) throw invalid('プロファイルの内容が不正です / invalid profile', parsed.error);
  return parsed.data;
}

export function parseExtensions(raw: unknown): Extensions {
  const parsed = extensionsSchema.safeParse(raw);
  if (!parsed.success) throw invalid('拡張の内容が不正です / invalid extensions', parsed.error);
  return parsed.data;
}

const environmentDraftSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  imageId: z.string(),
  envText: z.string(),
  setupScript: z.string(),
});

export function parseEnvironmentDraft(raw: unknown): EnvironmentDraft {
  const parsed = environmentDraftSchema.safeParse(raw);
  if (!parsed.success) throw invalid('環境の内容が不正です / invalid environment', parsed.error);
  const name = normalizeEnvironmentName(parsed.data.name);
  if (name === '') throw new AppFailure('INVALID_INPUT', '環境の名前が空です / the environment name is empty');
  if (!REGISTERED_IMAGE_ID_PATTERN.test(parsed.data.imageId)) {
    throw new AppFailure(
      'INVALID_INPUT',
      '環境には登録済みイメージを 1 つ選んでください / an environment must name one registered image',
    );
  }
  const envText = normalizeScriptText(parsed.data.envText);
  const problem = environmentEnvProblems(envText)[0];
  if (problem !== undefined) throw new AppFailure('INVALID_INPUT', `環境変数 / environment variables: ${problem}`);
  return {
    id: parsed.data.id,
    name,
    imageId: parsed.data.imageId,
    envText,
    setupScript: normalizeScriptText(parsed.data.setupScript),
  };
}

function starterProfile(): Profile {
  const openrouter = ENDPOINT_PRESETS.find((preset) => preset.id === 'openrouter');
  return {
    id: 'openrouter-default',
    name: 'OpenRouter',
    baseUrl: openrouter?.baseUrl ?? 'https://openrouter.ai/api',
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

function emptyExtensions(): Extensions {
  return { mcpServers: [], marketplaces: [], plugins: [], skillInstalls: [] };
}

export function emptyManagedNames(): ManagedNames {
  return { mcpServers: [], marketplaces: [], plugins: [] };
}

function newInstanceId(): string {
  return `inst_${randomBytes(8).toString('hex')}`;
}

export function defaultConfig(): AppConfig {
  const profile = starterProfile();
  return {
    schemaVersion: 1,
    dataInstanceId: newInstanceId(),
    language: 'ja',
    defaultProfileId: profile.id,
    profiles: [profile],
    defaultEnvironmentId: null,
    environments: [],
    autoOnboarding: true,
    autoApproveApiKey: true,
    skipPermissions: true,
    lastExportDir: null,
    extensions: emptyExtensions(),
  };
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

function duplicateId(items: readonly { readonly id: string }[]): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) return item.id;
    seen.add(item.id);
  }
  return null;
}

export function normalizeConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    schemaVersion: 1,
    defaultProfileId: resolveDefaultProfile(config.defaultProfileId, config.profiles),
    defaultEnvironmentId: resolveDefaultEnvironment(config.defaultEnvironmentId, config.environments),
  };
}

export function readConfig(raw: unknown): ParseOutcome<AppConfig> {
  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: firstIssue(parsed.error) };
  const duplicateProfile = duplicateId(parsed.data.profiles);
  if (duplicateProfile !== null) return { ok: false, problem: `duplicate profile id ${duplicateProfile}` };
  const duplicateEnvironment = duplicateId(parsed.data.environments);
  if (duplicateEnvironment !== null) return { ok: false, problem: `duplicate environment id ${duplicateEnvironment}` };
  return { ok: true, value: normalizeConfig(parsed.data) };
}

const secretEntrySchema = z.strictObject({ enc: z.enum(['safeStorage', 'plain']), value: z.string().min(1) });

const secretsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.record(z.string(), secretEntrySchema),
});

export type SecretEntries = Readonly<Record<string, { readonly enc: 'safeStorage' | 'plain'; readonly value: string }>>;

export function readSecretsFile(raw: unknown): ParseOutcome<SecretEntries> {
  const parsed = secretsFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: firstIssue(parsed.error) };
  return { ok: true, value: parsed.data.entries };
}
