import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, safeStorage } from 'electron';

import type { AppConfig, Profile } from '../../shared/types.ts';
import { describeError, logError, logWarn } from '../logger.ts';
import { defaultConfig, readConfig } from './schema.ts';

interface SecretFile {
  readonly encrypted: boolean;
  readonly entries: Record<string, string>;
}

let cache: AppConfig | null = null;
let secretCache: SecretFile | null = null;

function userDataDir(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

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

export function getConfig(): AppConfig {
  if (cache !== null) return cache;
  const raw = readJson(configPath());
  if (raw === null) {
    cache = existsSync(configPath()) ? loadUnreadable() : defaultConfig();
    return cache;
  }

  const result = readConfig(raw);
  if (result.reset) {
    const backup = keepAside(configPath());
    logError(
      'app',
      `設定を読めなかったので初期設定に戻します / config could not be read and was replaced by defaults` +
        `${backup === null ? '' : ` — 退避先 / kept a copy at ${backup}`}`,
    );
  } else if (result.dropped > 0) {
    const backup = keepAside(configPath());
    logWarn(
      'app',
      `設定の ${result.dropped} 件を読み飛ばしました / dropped ${result.dropped} unreadable config entr` +
        `${result.dropped === 1 ? 'y' : 'ies'}${backup === null ? '' : ` — 退避先 / kept a copy at ${backup}`}`,
    );
  }
  cache = result.config;
  return cache;
}

function loadUnreadable(): AppConfig {
  const backup = keepAside(configPath());
  logError(
    'app',
    `設定ファイルが壊れています。初期設定で起動します / the config file is unreadable; starting from defaults` +
      `${backup === null ? '' : ` — 退避先 / kept a copy at ${backup}`}`,
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
  const config = getConfig();
  if (config.activeProfileId === null) return null;
  return config.profiles.find((profile) => profile.id === config.activeProfileId) ?? null;
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

function readSecretFile(): SecretFile {
  if (secretCache !== null) return secretCache;
  const raw = readJson(secretsPath());
  if (raw !== null && typeof raw === 'object' && 'entries' in raw) {
    const candidate = raw as { encrypted?: unknown; entries?: unknown };
    const entries =
      typeof candidate.entries === 'object' && candidate.entries !== null
        ? (candidate.entries as Record<string, string>)
        : {};
    secretCache = { encrypted: candidate.encrypted === true, entries };
  } else {
    if (existsSync(secretsPath())) {
      const backup = keepAside(secretsPath());
      logError(
        'app',
        `API キーのファイルを読めませんでした / the stored credentials could not be read` +
          `${backup === null ? '' : ` — 退避先 / kept a copy at ${backup}`}`,
      );
    }
    secretCache = { encrypted: secretsAreEncrypted(), entries: {} };
  }
  return secretCache;
}

function writeSecretFile(file: SecretFile): void {
  secretCache = file;
  writeAtomic(secretsPath(), `${JSON.stringify(file, null, 2)}\n`);
}

export function getSecret(profileId: string): string {
  const file = readSecretFile();
  const stored = file.entries[profileId];
  if (stored === undefined || stored === '') return '';
  if (!file.encrypted) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch (error) {
    logWarn('app', `API キーを復号できませんでした / could not decrypt API key: ${describeError(error)}`);
    return '';
  }
}

export function setSecret(profileId: string, secret: string): void {
  const file = readSecretFile();
  const canEncrypt = secretsAreEncrypted();

  const entries: Record<string, string> = {};
  if (file.encrypted !== canEncrypt) {
    for (const id of Object.keys(file.entries)) {
      const plain = getSecret(id);
      if (plain !== '') entries[id] = canEncrypt ? safeStorage.encryptString(plain).toString('base64') : plain;
    }
  } else {
    Object.assign(entries, file.entries);
  }

  if (secret === '') {
    delete entries[profileId];
  } else {
    entries[profileId] = canEncrypt ? safeStorage.encryptString(secret).toString('base64') : secret;
  }

  writeSecretFile({ encrypted: canEncrypt, entries });
}

export function deleteSecret(profileId: string): void {
  const file = readSecretFile();
  if (!(profileId in file.entries)) return;
  const entries = { ...file.entries };
  delete entries[profileId];
  writeSecretFile({ encrypted: file.encrypted, entries });
}

export function appDataDir(): string {
  return userDataDir();
}
