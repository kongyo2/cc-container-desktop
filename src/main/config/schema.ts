/**
 * Zod schemas for the on-disk configuration.
 *
 * The config file is hand-editable and survives app upgrades, so it is parsed
 * defensively: a malformed or partial file falls back to defaults per field
 * rather than taking the app down.
 */

import { z } from 'zod';

import {
  DEFAULT_CONTAINER_NAME,
  DEFAULT_IMAGE_TAG,
  DEFAULT_TMUX_SESSION,
  DEFAULT_VOLUME_NAME,
  ENDPOINT_PRESETS,
} from '../../shared/presets.ts';
import type { AppConfig, Profile } from '../../shared/types.ts';

// Both schemas stay module-local: their inferred zod types are enormous, and
// `isolatedDeclarations` would demand they be written out by hand for no gain.
// `parseConfig` is the only thing outside this file needs.
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
});

/** A ready-to-use OpenRouter profile, so a fresh install has something to point at. */
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
  };
}

/** Parses whatever was on disk, filling in defaults field by field. */
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
  };
}
