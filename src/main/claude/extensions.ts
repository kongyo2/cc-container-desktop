import { CONTAINER_HOME } from '../../shared/presets.ts';
import { validateMcpServer } from '../../shared/mcp.ts';
import type { Extensions, ManagedNames, McpServerConfig, McpServerStatus } from '../../shared/types.ts';
import { execCapture } from '../docker/container.ts';

function emptyMap(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function trimmedRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(record)) {
    const name = key.trim();
    if (name === '') continue;
    out[name] = value.trim();
  }
  return out;
}

export function mcpEntry(server: McpServerConfig): Record<string, unknown> {
  const entry: Record<string, unknown> = {};

  if (server.transport === 'stdio') {
    entry['type'] = 'stdio';
    entry['command'] = server.command.trim();
    if (server.args.length > 0) entry['args'] = server.args.map((arg) => arg.trim()).filter((arg) => arg !== '');
    const env = trimmedRecord(server.env);
    if (Object.keys(env).length > 0) entry['env'] = env;
  } else {
    entry['type'] = server.transport;
    entry['url'] = server.url.trim();
    const headers = trimmedRecord(server.headers);
    if (Object.keys(headers).length > 0) entry['headers'] = headers;
  }

  if (server.timeoutMs !== null) entry['timeout'] = server.timeoutMs;
  return entry;
}

function sameEntry(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameEntry(item, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && sameEntry(a[key], b[key]));
}

function reconcile(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  previouslyManaged: readonly string[],
  label: string,
  warnings: string[],
): { merged: Record<string, unknown>; managed: string[] } {
  const merged = emptyMap();
  for (const [key, value] of Object.entries(current)) merged[key] = value;
  for (const name of previouslyManaged) {
    if (!Object.hasOwn(next, name)) delete merged[name];
  }

  const managed: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    const foreign = !previouslyManaged.includes(key) && Object.hasOwn(current, key) && !sameEntry(current[key], value);
    if (foreign) {
      warnings.push(
        `${label} ${key}: 同じ名前の設定がコンテナ内に既にあるので触りません。別の名前にしてください / an entry of this name already exists in the container and was left alone; rename yours`,
      );
      continue;
    }
    merged[key] = value;
    managed.push(key);
  }
  return { merged, managed };
}

function preserveInvalid(
  next: Record<string, unknown>,
  existing: Record<string, unknown>,
  previouslyManaged: readonly string[],
  invalidNames: readonly string[],
  warnings: string[],
): void {
  for (const name of invalidNames) {
    if (Object.hasOwn(next, name)) continue;
    if (!previouslyManaged.includes(name) || !Object.hasOwn(existing, name)) continue;
    next[name] = existing[name];
    warnings.push(
      `${name}: 無効な編集は反映せず、直前に適用した設定を残しました / the invalid edit was not applied; the last applied configuration was kept`,
    );
  }
}

function recordAt(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function assignMerged(
  target: Record<string, unknown>,
  key: string,
  merged: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  if (Object.keys(merged).length > 0 || Object.hasOwn(source, key)) target[key] = merged;
}

export interface ExtensionPlan {
  readonly claudeJson: Record<string, unknown>;
  readonly settings: Record<string, unknown>;
  readonly managed: ManagedNames;
  readonly warnings: readonly string[];
}

export function planExtensions(
  extensions: Extensions,
  managed: ManagedNames,
  currentClaudeJson: Record<string, unknown>,
  currentSettings: Record<string, unknown>,
): ExtensionPlan {
  const warnings: string[] = [];

  const nextServers = emptyMap();
  const invalidServerNames: string[] = [];
  for (const server of extensions.mcpServers) {
    if (!server.enabled) continue;
    const problem = validateMcpServer(server);
    if (problem !== null) {
      warnings.push(problem);
      invalidServerNames.push(server.name);
      continue;
    }
    nextServers[server.name] = mcpEntry(server);
  }
  const existingServers = recordAt(currentClaudeJson, 'mcpServers');
  preserveInvalid(nextServers, existingServers, managed.mcpServers, invalidServerNames, warnings);
  const servers = reconcile(existingServers, nextServers, managed.mcpServers, 'mcp', warnings);

  const nextMarkets = emptyMap();
  const invalidMarketNames: string[] = [];
  for (const market of extensions.marketplaces) {
    if (!market.enabled) continue;
    const name = market.name.trim();
    const source =
      market.sourceKind === 'github'
        ? { source: 'github', repo: market.repo.trim() }
        : { source: 'git', url: market.url.trim() };
    if (name === '') {
      warnings.push('マーケットプレイス名が空です / a marketplace has no name and was skipped');
      continue;
    }
    if (market.sourceKind === 'github' && !/^[^/\s]+\/[^/\s]+$/u.test(market.repo.trim())) {
      warnings.push(`${market.name}: repo は owner/repo 形式で指定してください / repo must be "owner/repo"`);
      invalidMarketNames.push(name);
      continue;
    }
    if (market.sourceKind === 'git' && market.url.trim() === '') {
      warnings.push(`${market.name}: git の URL が空です / git url is empty`);
      invalidMarketNames.push(name);
      continue;
    }
    nextMarkets[name] = market.autoUpdate ? { source, autoUpdate: true } : { source };
  }
  const existingMarkets = recordAt(currentSettings, 'extraKnownMarketplaces');
  preserveInvalid(nextMarkets, existingMarkets, managed.marketplaces, invalidMarketNames, warnings);
  const markets = reconcile(existingMarkets, nextMarkets, managed.marketplaces, 'marketplace', warnings);

  const nextPlugins = emptyMap();
  for (const plugin of extensions.plugins) {
    const name = plugin.plugin.trim();
    const market = plugin.marketplace.trim();
    if (name === '' || market === '') {
      warnings.push(
        'プラグイン名とマーケットプレイス名の両方が必要です / a plugin needs both a plugin and a marketplace name',
      );
      continue;
    }
    nextPlugins[`${name}@${market}`] = plugin.enabled;
  }
  const existingPlugins = recordAt(currentSettings, 'enabledPlugins');
  const plugins = reconcile(existingPlugins, nextPlugins, managed.plugins, 'plugin', warnings);

  const claudeJson: Record<string, unknown> = {};
  assignMerged(claudeJson, 'mcpServers', servers.merged, currentClaudeJson);

  const settings: Record<string, unknown> = {};
  assignMerged(settings, 'extraKnownMarketplaces', markets.merged, currentSettings);
  assignMerged(settings, 'enabledPlugins', plugins.merged, currentSettings);

  return {
    claudeJson,
    settings,
    managed: {
      mcpServers: servers.managed,
      marketplaces: markets.managed,
      plugins: plugins.managed,
    },
    warnings,
  };
}

interface RawMcpStatus {
  readonly name?: unknown;
  readonly status?: unknown;
}

export async function readMcpStatus(): Promise<readonly McpServerStatus[]> {
  const result = await execCapture(['claude', 'mcp', 'list'], { workdir: CONTAINER_HOME });
  const text = `${result.stdout}\n${result.stderr}`;

  const statuses: McpServerStatus[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const match = /^([A-Za-z0-9_-]+):\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const [, name, rest] = match;
    if (name === undefined || rest === undefined) continue;
    const dash = rest.lastIndexOf(' - ');
    const status = dash === -1 ? rest : rest.slice(dash + 3);
    statuses.push({
      name,
      status: status.trim(),
      healthy: /connected/iu.test(status) && !/failed|error/iu.test(status),
      detail: dash === -1 ? '' : rest.slice(0, dash).trim(),
    });
  }
  return statuses;
}

export type { RawMcpStatus };
