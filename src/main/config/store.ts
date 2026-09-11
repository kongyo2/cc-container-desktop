import { safeStorage } from 'electron';

import { environmentById } from '../../shared/environments.ts';
import { profileById } from '../../shared/profiles.ts';
import type { AppConfig, ConfigPatch, Environment, EnvironmentDraft, Profile } from '../../shared/types.ts';
import { AppFailure, describeError } from '../errors.ts';
import { registeredImageFor } from '../images/store.ts';
import { logWarn } from '../logger.ts';
import { statePath, userDataDir } from '../paths.ts';
import { StateFile } from '../state/file.ts';
import { defaultConfig, normalizeConfig, readConfig, readSecretsFile } from './schema.ts';
import type { SecretEntries } from './schema.ts';

const configFile = new StateFile<AppConfig>({
  path: () => statePath('config.json'),
  label: '設定 (config.json) / the app config (config.json)',
  parse: readConfig,
  initial: defaultConfig,
  serialize: (config) => config,
  persistInitial: true,
});

const secretsFile = new StateFile<SecretEntries>({
  path: () => statePath('secrets.json'),
  label: 'API キーの保存先 (secrets.json) / the credential store (secrets.json)',
  parse: readSecretsFile,
  initial: () => ({}),
  serialize: (entries) => ({ schemaVersion: 1, entries }),
  persistInitial: false,
});

export function getConfig(): AppConfig {
  return configFile.get();
}

export function configStoreProblem(): string | null {
  return configFile.problem;
}

export function secretsStoreProblem(): string | null {
  return secretsFile.problem;
}

export function dataInstanceId(): string {
  return getConfig().dataInstanceId;
}

function saveConfig(next: AppConfig): AppConfig {
  return configFile.set(normalizeConfig({ ...next, dataInstanceId: getConfig().dataInstanceId }));
}

export function patchConfig(patch: ConfigPatch & Partial<Pick<AppConfig, 'language' | 'extensions'>>): AppConfig {
  return saveConfig({ ...getConfig(), ...patch });
}

export function profileFor(id: string | null): Profile | null {
  return profileById(getConfig(), id);
}

export function rememberExportDir(directory: string): AppConfig {
  return saveConfig({ ...getConfig(), lastExportDir: directory });
}

export function upsertProfile(profile: Profile): AppConfig {
  const config = getConfig();
  const index = config.profiles.findIndex((candidate) => candidate.id === profile.id);
  const profiles = index === -1 ? [...config.profiles, profile] : config.profiles.with(index, profile);
  const defaultProfileId = config.defaultProfileId ?? profile.id;
  return saveConfig({ ...config, profiles, defaultProfileId });
}

export function deleteProfile(id: string): AppConfig {
  const config = getConfig();
  const profiles = config.profiles.filter((profile) => profile.id !== id);
  const defaultProfileId = config.defaultProfileId === id ? (profiles[0]?.id ?? null) : config.defaultProfileId;
  deleteSecret(id);
  return saveConfig({ ...config, profiles, defaultProfileId });
}

export function environmentFor(id: string | null): Environment | null {
  return environmentById(getConfig(), id);
}

function requireEnvironment(config: AppConfig, id: string): { index: number; environment: Environment } {
  const index = config.environments.findIndex((environment) => environment.id === id);
  const environment = config.environments[index];
  if (index === -1 || environment === undefined) {
    throw new AppFailure('ENVIRONMENT_MISSING', `環境が見つかりません / no such environment: ${id}`);
  }
  return { index, environment };
}

export function upsertEnvironment(draft: EnvironmentDraft): AppConfig {
  if (registeredImageFor(draft.imageId) === null) {
    throw new AppFailure(
      'IMAGE_NOT_REGISTERED',
      '選んだイメージは登録されていません。「イメージ」でダウンロードして登録してください / the chosen image is not registered; download and register it on the Images page',
    );
  }
  const config = getConfig();
  const now = new Date().toISOString();
  const index = config.environments.findIndex((environment) => environment.id === draft.id);
  const existing = index === -1 ? null : (config.environments[index] ?? null);
  const unchanged =
    existing !== null &&
    existing.name === draft.name &&
    existing.imageId === draft.imageId &&
    existing.envText === draft.envText &&
    existing.setupScript === draft.setupScript;
  const next: Environment = {
    ...draft,
    archived: existing?.archived ?? false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: unchanged ? existing.updatedAt : now,
  };
  const environments = existing === null ? [...config.environments, next] : config.environments.with(index, next);
  const defaultEnvironmentId = config.defaultEnvironmentId ?? (next.archived ? null : next.id);
  return saveConfig({ ...config, environments, defaultEnvironmentId });
}

export function setEnvironmentArchived(id: string, archived: boolean): AppConfig {
  const config = getConfig();
  const { index, environment } = requireEnvironment(config, id);
  if (environment.archived === archived) return config;
  const next: Environment = { ...environment, archived, updatedAt: new Date().toISOString() };
  return saveConfig({ ...config, environments: config.environments.with(index, next) });
}

export function removeEnvironment(id: string): AppConfig {
  const config = getConfig();
  requireEnvironment(config, id);
  return saveConfig({ ...config, environments: config.environments.filter((environment) => environment.id !== id) });
}

export function environmentsUsingImage(imageId: string): readonly Environment[] {
  return getConfig().environments.filter((environment) => environment.imageId === imageId);
}

export function secretsAreEncrypted(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function getSecret(profileId: string): string {
  const stored = secretsFile.get()[profileId];
  if (stored === undefined || stored.value === '') return '';
  if (stored.enc === 'plain') return stored.value;
  try {
    return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
  } catch (error) {
    logWarn(
      'app',
      `API キーを復号できませんでした。保存はされているので、OS のキーリングが戻れば読めます / could not decrypt the stored API key; it is still on disk and becomes readable again once the OS keyring is back: ${describeError(error)}`,
    );
    return '';
  }
}

export function setSecret(profileId: string, secret: string): void {
  const entries: Record<string, { enc: 'safeStorage' | 'plain'; value: string }> = { ...secretsFile.get() };
  if (secret === '') {
    delete entries[profileId];
  } else if (secretsAreEncrypted()) {
    entries[profileId] = { enc: 'safeStorage', value: safeStorage.encryptString(secret).toString('base64') };
  } else {
    entries[profileId] = { enc: 'plain', value: secret };
  }
  secretsFile.set(entries);
}

function deleteSecret(profileId: string): void {
  const current = secretsFile.get();
  if (!(profileId in current)) return;
  const entries = { ...current };
  delete entries[profileId];
  secretsFile.set(entries);
}

export function appDataDir(): string {
  return userDataDir();
}
