import { envNameProblems, parseEnvText } from './env.ts';
import type { AppConfig, Environment, Language } from './types.ts';

export const MAX_ENVIRONMENT_NAME = 64;

export const ENV_TEXT_PLACEHOLDER = `NODE_ENV=production
GIT_AUTHOR_NAME=Your Name

# Multiline values - wrap in quotes
CONFIG="key1=val1
key2=val2"`;

export const SETUP_SCRIPT_PLACEHOLDER = `#!/bin/bash
npm install`;

export const ENV_FORMAT_URL = 'https://github.com/motdotla/dotenv#what-rules-does-the-parsing-engine-follow';

export function normalizeEnvironmentName(name: string): string {
  return name
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_ENVIRONMENT_NAME);
}

export function environmentNameProblem(name: string, language: Language): string | null {
  if (normalizeEnvironmentName(name) === '') {
    return language === 'ja' ? '名前を入力してください。' : 'Enter a name.';
  }
  return null;
}

export const RESERVED_ENV_NAMES: readonly string[] = ['HOME', 'USER', 'TERM', 'COLORTERM', 'LANG'];

export function environmentEnvProblems(envText: string): readonly string[] {
  const parsed = parseEnvText(envText);
  const reserved = Object.keys(parsed.env)
    .filter((name) => RESERVED_ENV_NAMES.includes(name))
    .map(
      (name) =>
        `${name}: アプリがコンテナ内の各プロセスに設定する変数なので、環境では上書きできません / set by the app on every process it starts, so an environment cannot override it`,
    );
  return [...parsed.problems, ...envNameProblems(parsed.env), ...reserved];
}

export function normalizeScriptText(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

export function environmentEnvEntries(environment: Environment | null): readonly string[] {
  if (environment === null) return [];
  return Object.entries(parseEnvText(environment.envText).env)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`);
}

export function environmentById(config: AppConfig, id: string | null): Environment | null {
  if (id === null) return null;
  return config.environments.find((environment) => environment.id === id) ?? null;
}

export function activeEnvironments(config: AppConfig): readonly Environment[] {
  return config.environments.filter((environment) => !environment.archived);
}

export function archivedEnvironments(config: AppConfig): readonly Environment[] {
  return config.environments.filter((environment) => environment.archived);
}

export function suggestEnvironmentName(config: AppConfig, language: Language): string {
  const taken = new Set(config.environments.map((environment) => environment.name));
  for (let index = config.environments.length + 1; ; index += 1) {
    const candidate = language === 'ja' ? `環境${index}` : `Environment ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}
