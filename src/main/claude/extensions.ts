import { CONTAINER_HOME } from '../../shared/presets.ts';
import { isSafeSkillPath, nameProblem, validateSkill } from '../../shared/skill.ts';
import type { Extensions, ManagedNames, McpServerConfig, McpServerStatus } from '../../shared/types.ts';
import { execCapture } from '../docker/container.ts';
import { writeFileText } from '../docker/files.ts';
import { logWarn } from '../logger.ts';

const SKILLS_DIR = `${CONTAINER_HOME}/.claude/skills`;

const RESERVED_MCP_NAMES = new Set(
  ['workspace', 'claude-in-chrome', 'computer-use', 'claude preview', 'claude browser'].map((name) =>
    name.toLowerCase(),
  ),
);

function trimmedRecord(record: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const name = key.trim();
    if (name === '') continue;
    out[name] = value.trim();
  }
  return out;
}

export function validateMcpServer(server: McpServerConfig): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(server.name)) {
    return `${server.name}: 名前に使えるのは英数字とハイフン、アンダースコアだけです / only letters, digits, "-" and "_" are allowed in a server name`;
  }
  if (RESERVED_MCP_NAMES.has(server.name.toLowerCase())) {
    return `${server.name}: この名前は Claude Code の組み込みサーバ用に予約されています / this name is reserved for a built-in server`;
  }
  if (server.transport === 'stdio') {
    if (server.command.trim() === '') return `${server.name}: command が空です / command is empty`;
    return null;
  }
  if (server.url.trim() === '') return `${server.name}: URL が空です / url is empty`;
  try {
    // eslint-disable-next-line no-new
    new URL(server.url.trim());
  } catch {
    return `${server.name}: URL の形式が不正です / url is not a valid URL`;
  }
  return null;
}

export function mcpEntry(server: McpServerConfig): Record<string, unknown> {
  const entry: Record<string, unknown> = {};

  if (server.transport === 'stdio') {
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

function reconcile(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  previouslyManaged: readonly string[],
): { merged: Record<string, unknown>; managed: string[] } {
  const merged = { ...current };
  for (const name of previouslyManaged) {
    if (!(name in next)) delete merged[name];
  }
  Object.assign(merged, next);
  return { merged, managed: Object.keys(next) };
}

export interface PlannedSkill {
  readonly name: string;
  readonly body: string;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

export interface ExtensionPlan {
  readonly claudeJson: Record<string, unknown>;
  readonly settings: Record<string, unknown>;
  readonly managed: ManagedNames;
  readonly warnings: readonly string[];
  readonly skills: readonly PlannedSkill[];
  readonly removedSkills: readonly string[];
}

export function planExtensions(
  extensions: Extensions,
  managed: ManagedNames,
  currentClaudeJson: Record<string, unknown>,
  currentSettings: Record<string, unknown>,
): ExtensionPlan {
  const warnings: string[] = [];

  const nextServers: Record<string, unknown> = {};
  for (const server of extensions.mcpServers) {
    if (!server.enabled) continue;
    const problem = validateMcpServer(server);
    if (problem !== null) {
      warnings.push(problem);
      continue;
    }
    nextServers[server.name] = mcpEntry(server);
  }
  const existingServers =
    typeof currentClaudeJson['mcpServers'] === 'object' && currentClaudeJson['mcpServers'] !== null
      ? (currentClaudeJson['mcpServers'] as Record<string, unknown>)
      : {};
  const servers = reconcile(existingServers, nextServers, managed.mcpServers);

  const nextMarkets: Record<string, unknown> = {};
  for (const market of extensions.marketplaces) {
    if (!market.enabled) continue;
    if (market.name.trim() === '') continue;
    const source =
      market.sourceKind === 'github'
        ? { source: 'github', repo: market.repo.trim() }
        : { source: 'git', url: market.url.trim() };
    if (market.sourceKind === 'github' && !/^[^/\s]+\/[^/\s]+$/u.test(market.repo.trim())) {
      warnings.push(`${market.name}: repo は owner/repo 形式で指定してください / repo must be "owner/repo"`);
      continue;
    }
    if (market.sourceKind === 'git' && market.url.trim() === '') {
      warnings.push(`${market.name}: git の URL が空です / git url is empty`);
      continue;
    }
    nextMarkets[market.name.trim()] = market.autoUpdate ? { source, autoUpdate: true } : { source };
  }
  const existingMarkets =
    typeof currentSettings['extraKnownMarketplaces'] === 'object' && currentSettings['extraKnownMarketplaces'] !== null
      ? (currentSettings['extraKnownMarketplaces'] as Record<string, unknown>)
      : {};
  const markets = reconcile(existingMarkets, nextMarkets, managed.marketplaces);

  const nextPlugins: Record<string, unknown> = {};
  for (const plugin of extensions.plugins) {
    const name = plugin.plugin.trim();
    const market = plugin.marketplace.trim();
    if (name === '' || market === '') continue;
    nextPlugins[`${name}@${market}`] = plugin.enabled;
  }
  const existingPlugins =
    typeof currentSettings['enabledPlugins'] === 'object' && currentSettings['enabledPlugins'] !== null
      ? (currentSettings['enabledPlugins'] as Record<string, unknown>)
      : {};
  const plugins = reconcile(existingPlugins, nextPlugins, managed.plugins);

  const skills: PlannedSkill[] = [];
  for (const skill of extensions.skills) {
    if (!skill.enabled) continue;
    const check = validateSkill(skill.body, skill.files);
    for (const problem of check.errors) warnings.push(`skill: ${problem}`);
    for (const note of check.warnings) warnings.push(`skill ${check.name || '?'}: ${note}`);
    if (check.errors.length > 0) continue;
    skills.push({
      name: check.name,
      body: skill.body,
      files: skill.files.filter((file) => isSafeSkillPath(file.path)),
    });
  }
  const skillNames = skills.map((skill) => skill.name);
  const removedSkills = managed.skills.filter((name) => !skillNames.includes(name));

  const claudeJson: Record<string, unknown> = {};
  if (Object.keys(servers.merged).length > 0 || 'mcpServers' in currentClaudeJson) {
    claudeJson['mcpServers'] = servers.merged;
  }

  const settings: Record<string, unknown> = {};
  if (Object.keys(markets.merged).length > 0 || 'extraKnownMarketplaces' in currentSettings) {
    settings['extraKnownMarketplaces'] = markets.merged;
  }
  if (Object.keys(plugins.merged).length > 0 || 'enabledPlugins' in currentSettings) {
    settings['enabledPlugins'] = plugins.merged;
  }

  return {
    claudeJson,
    settings,
    managed: {
      mcpServers: servers.managed,
      marketplaces: markets.managed,
      plugins: plugins.managed,
      skills: skillNames,
    },
    warnings,
    skills,
    removedSkills,
  };
}

export async function writeSkills(plan: ExtensionPlan): Promise<void> {
  const removals = plan.removedSkills
    .filter((name) => nameProblem(name) === null)
    .map(async (name) => {
      const result = await execCapture(['rm', '-rf', `${SKILLS_DIR}/${name}`], { workdir: '/' });
      if (result.exitCode !== 0) {
        logWarn('provision', `スキルを削除できませんでした / could not remove skill ${name}: ${result.stderr.trim()}`);
      }
    });

  const writes = plan.skills.map(async (skill) => {
    const root = `${SKILLS_DIR}/${skill.name}`;
    await execCapture(['rm', '-rf', root], { workdir: '/' });

    const directories = new Set<string>();
    for (const file of skill.files) {
      const slash = file.path.lastIndexOf('/');
      if (slash > 0) directories.add(`${root}/${file.path.slice(0, slash)}`);
    }
    await execCapture(['mkdir', '-p', root, ...directories], { workdir: '/' });

    await writeFileText(`${root}/SKILL.md`, skill.body, 0o644);
    await Promise.all(
      skill.files.map((file) =>
        writeFileText(`${root}/${file.path}`, file.content, file.path.startsWith('scripts/') ? 0o755 : 0o644),
      ),
    );
  });

  await Promise.all([...removals, ...writes]);
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
