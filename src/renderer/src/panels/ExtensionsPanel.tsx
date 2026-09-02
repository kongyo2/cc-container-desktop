import { Plug, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { JSX, ReactNode } from 'react';
import { useEffect, useState } from 'react';

import type {
  Extensions,
  MarketplaceConfig,
  McpServerConfig,
  McpServerStatus,
  McpTransport,
  PluginConfig,
  SkillInstallConfig,
} from '../../../shared/types.ts';
import { skillInstallCommand, skillInstallProblem } from '../../../shared/skillInstall.ts';
import { newId } from '../../../shared/id.ts';
import { validateMcpServer } from '../../../shared/mcp.ts';
import { ArgEditor, PairEditor } from '../components/PairEditor.tsx';
import { Check, Field, NumberField, Section, TextField } from '../components/ui.tsx';
import { pick, useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';

const EMPTY_EXTENSIONS: Extensions = { mcpServers: [], marketplaces: [], plugins: [], skillInstalls: [] };

function EntryHead({
  title,
  enabled,
  onToggle,
  onDelete,
  children,
}: {
  title: ReactNode;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  children?: ReactNode;
}): JSX.Element {
  const t = useT();
  return (
    <div className="entry-head">
      <Check label="" checked={enabled} onChange={onToggle} />
      <strong>{title}</strong>
      {children}
      <span className="spacer" />
      <button className="btn ghost sm" onClick={onDelete} type="button" aria-label={t('commonDelete')}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function AddButton({ onClick }: { onClick: () => void }): JSX.Element {
  const t = useT();
  return (
    <button className="btn sm" onClick={onClick} type="button">
      <Plus size={13} /> {t('extAdd')}
    </button>
  );
}

function newMcpServer(): McpServerConfig {
  return {
    id: newId('mcp'),
    name: 'agentskills',
    enabled: true,
    transport: 'http',
    command: '',
    args: [],
    env: {},
    url: 'https://agentskills.io/mcp',
    headers: {},
    timeoutMs: null,
    note: '',
  };
}

function newMarketplace(): MarketplaceConfig {
  return {
    id: newId('mkt'),
    name: 'claude-plugins-official',
    enabled: true,
    sourceKind: 'github',
    repo: 'anthropics/claude-plugins-official',
    url: '',
    autoUpdate: false,
  };
}

function newPlugin(): PluginConfig {
  return { id: newId('plg'), plugin: '', marketplace: '', enabled: true };
}

function newSkillInstall(): SkillInstallConfig {
  return { id: newId('skl'), enabled: true, source: 'anthropics/skills', skills: ['frontend-design'], note: '' };
}

export function ExtensionsPanel(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const saved = useApp((state) => state.snapshot?.config.extensions) ?? EMPTY_EXTENSIONS;
  const containerRunning = useApp((state) => state.snapshot?.container.running === true);
  const run = useApp((state) => state.run);
  const setToast = useApp((state) => state.setToast);
  const setError = useApp((state) => state.setError);

  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<{ base: string; value: Extensions } | null>(null);
  const dirty = draft !== null && draft.base === savedKey;
  const extensions = dirty && draft !== null ? draft.value : saved;

  const [statuses, setStatuses] = useState<readonly McpServerStatus[]>([]);

  const update = (patch: Partial<Extensions>): void => {
    setDraft({ base: savedKey, value: { ...extensions, ...patch } });
  };

  const save = async (): Promise<boolean> => {
    const result = await run('extensions', () => window.cc.extensionsSave(extensions));
    if (result === null) return false;
    setDraft(null);
    return true;
  };

  const refreshStatus = async (): Promise<void> => {
    const result = await window.cc.mcpStatus();
    if (result.ok) setStatuses(result.value);
    else setError(result.error);
  };

  useEffect(() => {
    if (!containerRunning) return undefined;
    let cancelled = false;
    void (async () => {
      const result = await window.cc.mcpStatus();
      if (!cancelled && result.ok) setStatuses(result.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [containerRunning]);

  const statusFor = (name: string): McpServerStatus | undefined => statuses.find((status) => status.name === name);

  return (
    <>
      <Section
        title={t('extTitle')}
        actions={
          <>
            <button className="btn" disabled={!dirty} onClick={() => void save()} type="button">
              <Save size={14} /> {t('extSave')}
            </button>
            <button
              className="btn primary"
              disabled={!containerRunning}
              onClick={() => {
                void (async () => {
                  if (dirty && !(await save())) return;
                  const summary = await run('provision', () => window.cc.containerProvision());
                  if (summary !== null) setToast(summary);
                  await refreshStatus();
                })();
              }}
              type="button"
            >
              <Plug size={14} /> {t('extApply')}
            </button>
          </>
        }
      >
        <p className="hint">{t('extHint')}</p>
        <p className="hint">{t('extManagedHint')}</p>
      </Section>

      <Section
        title={t('extMcpTitle')}
        actions={
          <>
            <button
              className="btn ghost sm"
              disabled={!containerRunning}
              onClick={() => void refreshStatus()}
              type="button"
            >
              <RefreshCw size={13} /> {t('extMcpStatus')}
            </button>
            <AddButton onClick={() => update({ mcpServers: [...extensions.mcpServers, newMcpServer()] })} />
          </>
        }
      >
        <p className="hint">{t('extMcpHint')}</p>
        {extensions.mcpServers.length === 0 ? <p className="empty">{t('extMcpEmpty')}</p> : null}

        {extensions.mcpServers.map((server, index) => {
          const status = statusFor(server.name);
          const problem = server.enabled ? validateMcpServer(server) : null;
          const replace = (patch: Partial<McpServerConfig>): void => {
            update({ mcpServers: extensions.mcpServers.with(index, { ...server, ...patch }) });
          };
          return (
            <div className="entry-card" key={server.id}>
              <EntryHead
                title={server.name || t('commonUnset')}
                enabled={server.enabled}
                onToggle={(enabled) => replace({ enabled })}
                onDelete={() =>
                  update({ mcpServers: extensions.mcpServers.filter((candidate) => candidate.id !== server.id) })
                }
              >
                <span className="tag">{server.transport}</span>
                {problem === null ? null : <span className="tag err">!</span>}
                {status === undefined ? null : (
                  <span className={`tag ${status.healthy ? 'ok' : ''}`}>{status.status}</span>
                )}
              </EntryHead>

              <div className="grid2">
                <TextField label={t('extName')} value={server.name} onChange={(name) => replace({ name })} />
                <Field label={t('extTransport')}>
                  <select
                    value={server.transport}
                    onChange={(event) => replace({ transport: event.target.value as McpTransport })}
                  >
                    <option value="http">http (streamable)</option>
                    <option value="sse">sse</option>
                    <option value="stdio">stdio</option>
                  </select>
                </Field>
              </div>

              {server.transport === 'stdio' ? (
                <>
                  <TextField
                    label={t('extCommand')}
                    value={server.command}
                    onChange={(command) => replace({ command })}
                    placeholder="npx"
                  />
                  <ArgEditor
                    label={t('extArgs')}
                    value={server.args}
                    onChange={(args) => replace({ args })}
                    hint={pick(language, '1 行に 1 引数', 'one argument per line')}
                  />
                  <PairEditor
                    label={t('extEnv')}
                    value={server.env}
                    onChange={(env) => replace({ env })}
                    hint={pick(
                      language,
                      'サーバのプロセスに渡されます (Claude Code 自身の環境ではありません)',
                      "passed to the server process, not to Claude Code's own environment",
                    )}
                  />
                </>
              ) : (
                <>
                  <TextField
                    label={t('extUrl')}
                    value={server.url}
                    onChange={(url) => replace({ url })}
                    placeholder="https://agentskills.io/mcp"
                  />
                  <PairEditor
                    label={t('extHeaders')}
                    value={server.headers}
                    onChange={(headers) => replace({ headers })}
                    placeholder="Authorization=Bearer ..."
                  />
                </>
              )}

              <div className="grid2">
                <NumberField
                  label={t('extTimeout')}
                  hint="timeout (ms)"
                  value={server.timeoutMs}
                  onChange={(timeoutMs) => replace({ timeoutMs })}
                />
                <TextField
                  label={t('profileNote')}
                  value={server.note}
                  mono={false}
                  onChange={(note) => replace({ note })}
                />
              </div>
              {status === undefined || status.healthy || status.detail === '' ? null : (
                <p className="hint warn">{status.detail}</p>
              )}
            </div>
          );
        })}
      </Section>

      <Section
        title={t('extMarketTitle')}
        actions={<AddButton onClick={() => update({ marketplaces: [...extensions.marketplaces, newMarketplace()] })} />}
      >
        <p className="hint">{t('extMarketHint')}</p>
        {extensions.marketplaces.length === 0 ? <p className="empty">{t('extMarketEmpty')}</p> : null}

        {extensions.marketplaces.map((market, index) => {
          const replace = (patch: Partial<MarketplaceConfig>): void => {
            update({ marketplaces: extensions.marketplaces.with(index, { ...market, ...patch }) });
          };
          return (
            <div className="entry-card" key={market.id}>
              <EntryHead
                title={market.name || t('commonUnset')}
                enabled={market.enabled}
                onToggle={(enabled) => replace({ enabled })}
                onDelete={() =>
                  update({
                    marketplaces: extensions.marketplaces.filter((candidate) => candidate.id !== market.id),
                  })
                }
              >
                <span className="tag">{market.sourceKind}</span>
              </EntryHead>
              <div className="grid2">
                <TextField label={t('extName')} value={market.name} onChange={(name) => replace({ name })} />
                <Field label={t('extSource')}>
                  <select
                    value={market.sourceKind}
                    onChange={(event) => replace({ sourceKind: event.target.value as 'github' | 'git' })}
                  >
                    <option value="github">github</option>
                    <option value="git">git</option>
                  </select>
                </Field>
              </div>
              {market.sourceKind === 'github' ? (
                <TextField
                  label="repo"
                  value={market.repo}
                  onChange={(repo) => replace({ repo })}
                  placeholder="owner/repo"
                />
              ) : (
                <TextField
                  label="url"
                  value={market.url}
                  onChange={(url) => replace({ url })}
                  placeholder="https://git.example.com/plugins.git"
                />
              )}
              <Check
                label={t('extAutoUpdate')}
                checked={market.autoUpdate}
                onChange={(autoUpdate) => replace({ autoUpdate })}
              />
            </div>
          );
        })}
      </Section>

      <Section
        title={t('extPluginTitle')}
        actions={<AddButton onClick={() => update({ plugins: [...extensions.plugins, newPlugin()] })} />}
      >
        <p className="hint">{t('extPluginHint')}</p>
        {extensions.plugins.length === 0 ? <p className="empty">{t('extPluginEmpty')}</p> : null}

        {extensions.plugins.map((plugin, index) => {
          const replace = (patch: Partial<PluginConfig>): void => {
            update({ plugins: extensions.plugins.with(index, { ...plugin, ...patch }) });
          };
          return (
            <div className="entry-card" key={plugin.id}>
              <EntryHead
                title={
                  <>
                    {plugin.plugin || '?'}@{plugin.marketplace || '?'}
                  </>
                }
                enabled={plugin.enabled}
                onToggle={(enabled) => replace({ enabled })}
                onDelete={() => update({ plugins: extensions.plugins.filter((c) => c.id !== plugin.id) })}
              />
              <div className="grid2">
                <TextField
                  label={t('extPluginName')}
                  value={plugin.plugin}
                  onChange={(name) => replace({ plugin: name })}
                />
                <TextField
                  label={t('extMarketName')}
                  value={plugin.marketplace}
                  onChange={(marketplace) => replace({ marketplace })}
                />
              </div>
            </div>
          );
        })}
      </Section>

      <Section
        title={t('extSkillTitle')}
        actions={
          <AddButton onClick={() => update({ skillInstalls: [...extensions.skillInstalls, newSkillInstall()] })} />
        }
      >
        <p className="hint">{t('extSkillHint')}</p>
        <p className="hint">{t('extSkillRemoveHint')}</p>
        {extensions.skillInstalls.length === 0 ? <p className="empty">{t('extSkillEmpty')}</p> : null}

        {extensions.skillInstalls.map((skill, index) => {
          const replace = (patch: Partial<SkillInstallConfig>): void => {
            update({ skillInstalls: extensions.skillInstalls.with(index, { ...skill, ...patch }) });
          };
          const problem = skill.enabled ? skillInstallProblem(skill) : null;
          return (
            <div className="entry-card" key={skill.id}>
              <EntryHead
                title={skill.source.trim() === '' ? t('commonUnset') : skill.source.trim()}
                enabled={skill.enabled}
                onToggle={(enabled) => replace({ enabled })}
                onDelete={() => update({ skillInstalls: extensions.skillInstalls.filter((c) => c.id !== skill.id) })}
              >
                {skill.skills
                  .filter((name) => name.trim() !== '')
                  .map((name, position) => (
                    <span className="tag" key={`${skill.id}-${String(position)}`}>
                      {name.trim()}
                    </span>
                  ))}
                {problem === null ? null : <span className="tag err">!</span>}
              </EntryHead>

              <TextField
                label={t('extSkillSource')}
                value={skill.source}
                onChange={(source) => replace({ source })}
                hint={t('extSkillSourceHint')}
                placeholder="anthropics/skills"
              />
              <ArgEditor
                label={t('extSkillNames')}
                value={skill.skills}
                onChange={(skills) => replace({ skills })}
                hint={t('extSkillNamesHint')}
                placeholder={'frontend-design\nskill-creator'}
              />
              <TextField
                label={t('profileNote')}
                value={skill.note}
                mono={false}
                onChange={(note) => replace({ note })}
              />

              <Field label={t('extSkillCommand')}>
                <code className="command">{skillInstallCommand(skill)}</code>
              </Field>
              {problem === null ? null : <p className="hint err">{problem}</p>}
            </div>
          );
        })}
      </Section>
    </>
  );
}
