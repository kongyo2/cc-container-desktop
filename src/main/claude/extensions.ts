import { CONTAINER_HOME } from '../../shared/presets.ts';
import { validateMcpServer } from '../../shared/mcp.ts';
import { nameProblem, normalizeSkillPath, validateSkill } from '../../shared/skill.ts';
import type { Extensions, ManagedNames, McpServerConfig, McpServerStatus } from '../../shared/types.ts';
import { execCapture } from '../docker/container.ts';
import { writeFileText } from '../docker/files.ts';
import { describeError, logWarn } from '../logger.ts';

const SKILLS_DIR = `${CONTAINER_HOME}/.claude/skills`;

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
    // Optional for stdio, but `claude mcp add` writes it and `claude mcp list`
    // renders entries uniformly when it is present.
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

function reconcile(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  previouslyManaged: readonly string[],
): { merged: Record<string, unknown>; managed: string[] } {
  const merged = emptyMap();
  for (const [key, value] of Object.entries(current)) merged[key] = value;
  for (const name of previouslyManaged) {
    if (!Object.hasOwn(next, name)) delete merged[name];
  }
  for (const [key, value] of Object.entries(next)) merged[key] = value;
  return { merged, managed: Object.keys(next) };
}

// `reconcile` reads absence as deletion, which is right when an entry is
// disabled or removed but wrong when it merely failed validation: a half-edited
// URL must not take down the configuration that was working a minute ago. Keep
// the last applied entry for names that are still ours.
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
  readonly ownedSkills: readonly string[];
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
  const existingServers =
    typeof currentClaudeJson['mcpServers'] === 'object' && currentClaudeJson['mcpServers'] !== null
      ? (currentClaudeJson['mcpServers'] as Record<string, unknown>)
      : {};
  preserveInvalid(nextServers, existingServers, managed.mcpServers, invalidServerNames, warnings);
  const servers = reconcile(existingServers, nextServers, managed.mcpServers);

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
  const existingMarkets =
    typeof currentSettings['extraKnownMarketplaces'] === 'object' && currentSettings['extraKnownMarketplaces'] !== null
      ? (currentSettings['extraKnownMarketplaces'] as Record<string, unknown>)
      : {};
  preserveInvalid(nextMarkets, existingMarkets, managed.marketplaces, invalidMarketNames, warnings);
  const markets = reconcile(existingMarkets, nextMarkets, managed.marketplaces);

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
  const existingPlugins =
    typeof currentSettings['enabledPlugins'] === 'object' && currentSettings['enabledPlugins'] !== null
      ? (currentSettings['enabledPlugins'] as Record<string, unknown>)
      : {};
  const plugins = reconcile(existingPlugins, nextPlugins, managed.plugins);

  const skills: PlannedSkill[] = [];
  const claimed = new Set<string>();
  for (const skill of extensions.skills) {
    if (!skill.enabled) continue;
    const check = validateSkill(skill.body, skill.files);
    for (const problem of check.errors) warnings.push(`skill: ${problem}`);
    for (const note of check.warnings) warnings.push(`skill ${check.name || '?'}: ${note}`);
    if (check.errors.length > 0) continue;
    if (claimed.has(check.name)) {
      warnings.push(
        `skill ${check.name}: 同じ名前のスキルが 2 つあります / two skills share this name; keeping the first`,
      );
      continue;
    }
    claimed.add(check.name);

    const files: { path: string; content: string }[] = [];
    for (const file of skill.files) {
      const path = normalizeSkillPath(file.path);
      if (path !== null) files.push({ path, content: file.content });
    }
    skills.push({ name: check.name, body: skill.body, files });
  }
  const skillNames = skills.map((skill) => skill.name);
  const removedSkills = managed.skills.filter((name) => !skillNames.includes(name));

  const claudeJson: Record<string, unknown> = {};
  if (Object.keys(servers.merged).length > 0 || Object.hasOwn(currentClaudeJson, 'mcpServers')) {
    claudeJson['mcpServers'] = servers.merged;
  }

  const settings: Record<string, unknown> = {};
  if (Object.keys(markets.merged).length > 0 || Object.hasOwn(currentSettings, 'extraKnownMarketplaces')) {
    settings['extraKnownMarketplaces'] = markets.merged;
  }
  if (Object.keys(plugins.merged).length > 0 || Object.hasOwn(currentSettings, 'enabledPlugins')) {
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
    ownedSkills: managed.skills,
  };
}

// A skill name the app has not managed before may already belong to a
// hand-written or synced skill in the container. That check has to happen
// BEFORE the managed list is persisted: claiming first and probing later meant
// the very next provision believed the name was ours and rm -rf'd someone
// else's work. This narrows the plan to the skills the app may actually own.
export async function claimSkills(
  plan: ExtensionPlan,
): Promise<{ readonly plan: ExtensionPlan; readonly warnings: readonly string[] }> {
  const owned = new Set(plan.ownedSkills);

  const probes = await Promise.all(
    plan.skills.map(async (skill): Promise<{ skill: PlannedSkill; keep: boolean; warning: string | null }> => {
      if (owned.has(skill.name)) return { skill, keep: true, warning: null };
      try {
        const existing = await execCapture(['test', '-e', `${SKILLS_DIR}/${skill.name}`], { workdir: '/' });
        if (existing.exitCode === 0) {
          return {
            skill,
            keep: false,
            warning: `skill ${skill.name}: 同名のスキルがコンテナ内に既にあります。別の name にしてください / a skill of this name already exists in the container and was left alone; rename yours`,
          };
        }
        return { skill, keep: true, warning: null };
      } catch (error) {
        return {
          skill,
          keep: false,
          warning: `skill ${skill.name}: 既存の確認ができなかったので書き込みません / could not check for an existing skill, so it was not written: ${describeError(error)}`,
        };
      }
    }),
  );

  const skills = probes.filter((probe) => probe.keep).map((probe) => probe.skill);
  const warnings = probes.map((probe) => probe.warning).filter((warning): warning is string => warning !== null);
  return {
    plan: { ...plan, skills, managed: { ...plan.managed, skills: skills.map((skill) => skill.name) } },
    warnings,
  };
}

export async function writeSkills(plan: ExtensionPlan): Promise<readonly string[]> {
  const warnings: string[] = [];

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
    /* oxlint-disable no-await-in-loop */
    for (const file of skill.files) {
      try {
        await writeFileText(`${root}/${file.path}`, file.content, file.path.startsWith('scripts/') ? 0o755 : 0o644);
      } catch (error) {
        warnings.push(
          `skill ${skill.name}: ${file.path} を書けませんでした / could not write ${file.path}: ${describeError(error)}`,
        );
      }
    }
    /* oxlint-enable no-await-in-loop */
  });

  const results = await Promise.allSettled([...removals, ...writes]);
  for (const result of results) {
    if (result.status === 'rejected') {
      warnings.push(`skill: ${describeError(result.reason)}`);
    }
  }
  return warnings;
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
