import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeStorage } from 'electron';

import { activeProfileOf } from '../../shared/profiles.ts';
import type { AppConfig, Profile } from '../../shared/types.ts';
import { describeError, logError, logWarn } from '../logger.ts';
import { userDataDir } from '../paths.ts';
import { defaultConfig, readConfig } from './schema.ts';

type SecretEncoding = 'safeStorage' | 'plain';

interface SecretEntry {
  readonly enc: SecretEncoding;
  readonly value: string;
}

interface SecretFile {
  readonly version: 2;
  readonly entries: Record<string, SecretEntry>;
}

let cache: AppConfig | null = null;
let secretCache: SecretFile | null = null;

function configPath(): string {
  return join(userDataDir(), 'config.json');
}

function secretsPath(): string {
  return join(userDataDir(), 'secrets.json');
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    logWarn('app', `${path} を読めませんでした / could not read ${path}: ${describeError(error)}`);
    return null;
  }
}

function keepAside(path: string): string | null {
  if (!existsSync(path)) return null;
  const backup = `${path}.broken-${Date.now().toString(36)}`;
  try {
    copyFileSync(path, backup);
    return backup;
  } catch (error) {
    logWarn('app', `退避に失敗しました / could not back up ${path}: ${describeError(error)}`);
    return null;
  }
}

/**
 * Backs the file up and returns the tail every "we could not read this" message
 * carries, so a reader is told where their old file went — or nothing at all
 * when there was no file to keep, or keeping it failed.
 */
function keptCopyNote(path: string): string {
  const backup = keepAside(path);
  return backup === null ? '' : ` — 退避先 / kept a copy at ${backup}`;
}

export function getConfig(): AppConfig {
  if (cache !== null) return cache;
  const raw = readJson(configPath());
  if (raw === null) {
    cache = existsSync(configPath()) ? loadUnreadable() : defaultConfig();
    return cache;
  }

  const result = readConfig(raw);
  if (result.reset) {
    logError(
      'app',
      `設定を読めなかったので初期設定に戻します / config could not be read and was replaced by defaults` +
        keptCopyNote(configPath()),
    );
  } else if (result.dropped > 0) {
    logWarn(
      'app',
      `設定の ${result.dropped} 件を読み飛ばしました / dropped ${result.dropped} unreadable config entr` +
        `${result.dropped === 1 ? 'y' : 'ies'}${keptCopyNote(configPath())}`,
    );
  }
  cache = result.config;
  return cache;
}

function loadUnreadable(): AppConfig {
  logError(
    'app',
    `設定ファイルが壊れています。初期設定で起動します / the config file is unreadable; starting from defaults` +
      keptCopyNote(configPath()),
  );
  return defaultConfig();
}

export function saveConfig(next: AppConfig): AppConfig {
  const normalized = readConfig(next).config;
  cache = normalized;
  writeAtomic(configPath(), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function patchConfig(patch: Partial<AppConfig>): AppConfig {
  return saveConfig({ ...getConfig(), ...patch, version: 1 });
}

export function getActiveProfile(): Profile | null {
  return activeProfileOf(getConfig());
}

export function rememberExportDir(directory: string): AppConfig {
  return saveConfig({ ...getConfig(), lastExportDir: directory });
}

export function upsertProfile(profile: Profile): AppConfig {
  const config = getConfig();
  const index = config.profiles.findIndex((candidate) => candidate.id === profile.id);
  const profiles = index === -1 ? [...config.profiles, profile] : config.profiles.with(index, profile);
  const activeProfileId = config.activeProfileId ?? profile.id;
  return saveConfig({ ...config, profiles, activeProfileId });
}

export function deleteProfile(id: string): AppConfig {
  const config = getConfig();
  const profiles = config.profiles.filter((profile) => profile.id !== id);
  const activeProfileId = config.activeProfileId === id ? (profiles[0]?.id ?? null) : config.activeProfileId;
  deleteSecret(id);
  return saveConfig({ ...config, profiles, activeProfileId });
}

export function activateProfile(id: string): AppConfig {
  return patchConfig({ activeProfileId: id });
}

export function secretsAreEncrypted(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function parseSecretFile(raw: unknown): SecretFile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const candidate = raw as { encrypted?: unknown; entries?: unknown };
  const source = candidate.entries;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return null;

  const legacyEncoding: SecretEncoding = candidate.encrypted === true ? 'safeStorage' : 'plain';
  const entries: Record<string, SecretEntry> = {};
  for (const [id, stored] of Object.entries(source as Record<string, unknown>)) {
    if (typeof stored === 'string') {
      if (stored !== '') entries[id] = { enc: legacyEncoding, value: stored };
      continue;
    }
    if (typeof stored !== 'object' || stored === null) continue;
    const entry = stored as { enc?: unknown; value?: unknown };
    if (typeof entry.value !== 'string' || entry.value === '') continue;
    entries[id] = { enc: entry.enc === 'safeStorage' ? 'safeStorage' : 'plain', value: entry.value };
  }
  return { version: 2, entries };
}

function readSecretFile(): SecretFile {
  if (secretCache !== null) return secretCache;
  const parsed = parseSecretFile(readJson(secretsPath()));
  if (parsed === null) {
    if (existsSync(secretsPath())) {
      logError(
        'app',
        `API キーのファイルを読めませんでした / the stored credentials could not be read` + keptCopyNote(secretsPath()),
      );
    }
    secretCache = { version: 2, entries: {} };
  } else {
    secretCache = parsed;
  }
  return secretCache;
}

function writeSecretFile(file: SecretFile): void {
  secretCache = file;
  writeAtomic(secretsPath(), `${JSON.stringify(file, null, 2)}\n`);
}

export function getSecret(profileId: string): string {
  const stored = readSecretFile().entries[profileId];
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
  const entries = { ...readSecretFile().entries };

  if (secret === '') {
    delete entries[profileId];
  } else if (secretsAreEncrypted()) {
    entries[profileId] = { enc: 'safeStorage', value: safeStorage.encryptString(secret).toString('base64') };
  } else {
    entries[profileId] = { enc: 'plain', value: secret };
  }

  writeSecretFile({ version: 2, entries });
}

export function deleteSecret(profileId: string): void {
  const file = readSecretFile();
  if (!(profileId in file.entries)) return;
  const entries = { ...file.entries };
  delete entries[profileId];
  writeSecretFile({ version: 2, entries });
}

export function appDataDir(): string {
  return userDataDir();
}
