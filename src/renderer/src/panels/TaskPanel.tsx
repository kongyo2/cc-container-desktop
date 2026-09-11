import {
  CircleStop,
  Download,
  FolderInput,
  FileInput,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  SquareTerminal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { DragEvent, JSX } from 'react';
import { useState } from 'react';

import { activeEnvironments, environmentById } from '../../../shared/environments.ts';
import { describeSource } from '../../../shared/tasks.ts';
import type { ImportPick, ImportSummary, TaskView } from '../../../shared/types.ts';
import { TerminalView } from '../components/TerminalView.tsx';
import { Check, Pill, formatTime } from '../components/ui.tsx';
import type { Tone } from '../components/ui.tsx';
import { useLanguage, useT } from '../i18n.ts';
import { selectedTaskView, tabsOfTask, useApp } from '../store.ts';

function statusOf(view: TaskView): {
  tone: Tone;
  label: 'taskStatusRunning' | 'taskStatusStopped' | 'taskStatusMissing' | 'taskStatusError';
} {
  if (view.container.running) return { tone: 'ok', label: 'taskStatusRunning' };
  if (view.container.exists) return { tone: 'warn', label: 'taskStatusStopped' };
  if (view.container.status === 'error') return { tone: 'err', label: 'taskStatusError' };
  return { tone: 'idle', label: 'taskStatusMissing' };
}

function NameEditor({ id, name }: { id: string; name: string }): JSX.Element {
  const t = useT();
  const run = useApp((state) => state.run);
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const shown = draft !== null && draft.base === name ? draft.text : name;

  const commit = (): void => {
    setDraft(null);
    const next = shown.trim();
    if (next === '' || next === name) return;
    void run('task', () => window.cc.taskUpdate(id, { name: next }));
  };

  return (
    <input
      className="task-name-input"
      value={shown}
      spellCheck={false}
      title={t('taskRename')}
      aria-label={t('taskName')}
      onChange={(event) => setDraft({ base: name, text: event.target.value })}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(null);
      }}
    />
  );
}

function TaskHeader({ view }: { view: TaskView }): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const snapshot = useApp((state) => state.snapshot);
  const busy = useApp((state) => state.busy);
  const run = useApp((state) => state.run);
  const setToast = useApp((state) => state.setToast);
  const openTab = useApp((state) => state.openTab);
  const dropTaskTabs = useApp((state) => state.dropTaskTabs);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exportFirst, setExportFirst] = useState(true);

  const { task, container, imageStale, environmentStale } = view;
  const working = busy !== null;
  const status = statusOf(view);
  const profiles = snapshot?.config.profiles ?? [];
  const environments = snapshot === null ? [] : activeEnvironments(snapshot.config);
  const environment = snapshot === null ? null : environmentById(snapshot.config, task.environmentId);
  const environmentPlaceholder =
    environment === null
      ? task.environmentId === null
        ? t('taskEnvironmentNone')
        : t('taskEnvironmentMissing')
      : environment.archived
        ? `${environment.name} (${t('taskEnvironmentArchived')})`
        : null;
  const dockerUp = snapshot?.docker.available === true;
  const stale = imageStale || environmentStale;

  const reportImport = (summary: ImportSummary | null): void => {
    if (summary === null) return;
    setToast(`${t('taskImportDone')}: ${summary.sources.map((source) => source.split(/[\\/]/u).pop()).join(', ')}`);
  };

  const pickImport = (pick: ImportPick): void => {
    void (async () => {
      reportImport(await run('import', () => window.cc.taskPickImport(task.id, pick)));
    })();
  };

  return (
    <div className="task-head">
      <div className="task-title-row">
        <NameEditor id={task.id} name={task.name} />
        <Pill tone={status.tone}>{t(status.label)}</Pill>
        {imageStale ? <span className="tag warn">{t('taskImageStale')}</span> : null}
        {environmentStale ? (
          <span className="tag warn" data-testid="environment-stale">
            {t('taskEnvironmentStale')}
          </span>
        ) : null}
      </div>
      <div className="task-meta">
        <span title={t('taskSource')}>{describeSource(task.source, language)}</span>
        <span title={t('taskContainer')}>{task.containerName}</span>
        <span title={t('taskCreatedAt')}>{formatTime(task.createdAt)}</span>
        {task.note === '' ? null : <span className="task-note">{task.note}</span>}
      </div>

      <div className="row task-actions">
        <select
          value={task.profileId ?? ''}
          disabled={working}
          title={t('taskProfile')}
          aria-label={t('taskProfile')}
          onChange={(event) =>
            void run('task', () =>
              window.cc.taskUpdate(task.id, { profileId: event.target.value === '' ? null : event.target.value }),
            )
          }
        >
          <option value="">{t('taskProfileNone')}</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
              {profile.model === '' ? '' : ` — ${profile.model}`}
            </option>
          ))}
        </select>

        <select
          value={task.environmentId ?? ''}
          disabled={working}
          title={t('taskEnvironment')}
          aria-label={t('taskEnvironment')}
          data-testid="task-environment"
          onChange={(event) => {
            const environmentId = event.target.value;
            if (environmentId === '' || environmentId === task.environmentId) return;
            void run('task', () => window.cc.taskUpdate(task.id, { environmentId }));
          }}
        >
          {environmentPlaceholder === null ? null : (
            <option value={task.environmentId ?? ''} disabled>
              {environmentPlaceholder}
            </option>
          )}
          {environments.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>

        {container.running ? (
          <button
            className="btn"
            disabled={working}
            onClick={() => void run('task', () => window.cc.taskStop(task.id))}
            type="button"
            data-testid="task-stop"
          >
            <CircleStop size={14} /> {t('taskStop')}
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={working || !dockerUp}
            onClick={() => void run('task', () => window.cc.taskStart(task.id))}
            type="button"
            data-testid="task-start"
          >
            <Play size={14} /> {t('taskStart')}
          </button>
        )}
        <button
          className={container.running ? 'btn primary' : 'btn'}
          disabled={working || !container.running}
          onClick={() => openTab(task.id, 'claude')}
          type="button"
          data-testid="open-claude"
        >
          <Sparkles size={14} /> {t('terminalClaude')}
        </button>
        <button
          className="btn"
          disabled={working || !container.running}
          onClick={() => openTab(task.id, 'shell')}
          type="button"
          data-testid="open-shell"
        >
          <SquareTerminal size={14} /> {t('terminalNew')}
        </button>

        <span className="spacer" />

        <button className="btn sm" disabled={working || !dockerUp} onClick={() => pickImport('files')} type="button">
          <FileInput size={13} /> {t('taskImportFiles')}
        </button>
        <button className="btn sm" disabled={working || !dockerUp} onClick={() => pickImport('folder')} type="button">
          <FolderInput size={13} /> {t('taskImportFolder')}
        </button>
        <button
          className="btn sm"
          disabled={working || !dockerUp}
          onClick={() => {
            void (async () => {
              const summary = await run('export', () => window.cc.taskExport(task.id));
              if (summary === null) return;
              setToast(
                `${t('taskExportDone')}: ${summary.path} (${summary.files} files` +
                  `${summary.skipped.length === 0 ? '' : `, ${summary.skipped.length} skipped`})`,
              );
            })();
          }}
          type="button"
          data-testid="task-export"
        >
          <Download size={13} /> {t('taskExport')}
        </button>
        {stale ? (
          <button
            className="btn sm"
            disabled={working}
            onClick={() => void run('task', () => window.cc.taskRecreate(task.id))}
            type="button"
            data-testid="task-recreate"
          >
            <RefreshCw size={13} /> {t('taskRecreate')}
          </button>
        ) : null}
        <button
          className="btn sm"
          disabled={working || !container.running}
          title={t('taskProvisionHint')}
          onClick={() => {
            void (async () => {
              const summary = await run('provision', () => window.cc.taskProvision(task.id));
              if (summary !== null) setToast(summary);
            })();
          }}
          type="button"
        >
          <Upload size={13} /> {t('taskProvision')}
        </button>
        <button
          className="btn danger sm"
          disabled={working}
          onClick={() => setConfirmDelete(true)}
          type="button"
          data-testid="task-delete"
        >
          <Trash2 size={13} /> {t('taskDelete')}
        </button>
      </div>

      {imageStale ? <p className="hint warn">{t('taskImageStaleHint')}</p> : null}
      {environmentStale ? <p className="hint warn">{t('taskEnvironmentStaleHint')}</p> : null}

      {confirmDelete ? (
        <div className="banner error" data-testid="delete-confirm">
          <span>
            {t('taskDeleteConfirm')}
            <Check label={t('taskDeleteExportFirst')} checked={exportFirst} onChange={setExportFirst} />
          </span>
          <span className="spacer" />
          <button
            className="btn danger sm"
            onClick={() => {
              setConfirmDelete(false);
              void (async () => {
                const summary = await run('task', () => window.cc.taskDelete(task.id, { exportFirst }));
                if (summary === null) return;
                dropTaskTabs(task.id);
                setToast(
                  summary.exportedTo === null
                    ? t('taskDeleteDone')
                    : `${t('taskDeleteDone')} — ${t('taskExportDone')}: ${summary.exportedTo}`,
                );
              })();
            }}
            type="button"
            data-testid="delete-confirm-yes"
          >
            {t('commonYes')}
          </button>
          <button className="btn sm" onClick={() => setConfirmDelete(false)} type="button">
            {t('commonCancel')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function TaskWorkspace(): JSX.Element {
  const t = useT();
  const snapshot = useApp((state) => state.snapshot);
  const selected = useApp(selectedTaskView);
  const tabs = useApp((state) => state.tabs);
  const activeTab = useApp((state) => state.activeTab);
  const busy = useApp((state) => state.busy);
  const run = useApp((state) => state.run);
  const setView = useApp((state) => state.setView);
  const setError = useApp((state) => state.setError);
  const setToast = useApp((state) => state.setToast);
  const openTab = useApp((state) => state.openTab);
  const closeTab = useApp((state) => state.closeTab);
  const activateTab = useApp((state) => state.activateTab);
  const markTabOpened = useApp((state) => state.markTabOpened);
  const markTabExited = useApp((state) => state.markTabExited);
  const [dragging, setDragging] = useState(false);

  const taskId = selected?.task.id ?? null;
  const running = selected?.container.running === true;
  const ownTabs = tabsOfTask(tabs, taskId);
  const activeKey = taskId === null ? undefined : activeTab[taskId];

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (taskId === null || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDragging(false);
    if (taskId === null || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    const paths = [...event.dataTransfer.files]
      .map((file) => window.cc.pathForFile(file))
      .filter((path) => path !== '');
    if (paths.length === 0) return;
    void (async () => {
      const summary = await run('import', () => window.cc.taskImport(taskId, paths));
      if (summary !== null) setToast(`${t('taskImportDone')}: ${summary.entries} entries`);
    })();
  };

  if (snapshot === null) {
    return (
      <div className="task-shell">
        <p className="empty">{t('commonRunning')}</p>
      </div>
    );
  }

  if (snapshot.tasks.length === 0) {
    return (
      <div className="task-shell">
        <div className="welcome">
          <Sparkles size={28} />
          <h1>{t('taskWelcome')}</h1>
          <p>{t('taskWelcomeHint')}</p>
          {snapshot.docker.available ? null : <p className="hint warn">{t('taskDockerDown')}</p>}
          <button className="btn primary" disabled={busy !== null} onClick={() => setView('newTask')} type="button">
            <Plus size={14} /> {t('taskNew')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`task-shell ${dragging ? 'dragging' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {selected === null ? (
        <p className="empty">{t('taskNoneSelected')}</p>
      ) : (
        <TaskHeader key={selected.task.id} view={selected} />
      )}

      {selected === null ? null : (
        <div className="term-tabs">
          {ownTabs.map((tab) => (
            <span
              key={tab.key}
              className={`tab ${tab.key === activeKey ? 'active' : ''}`}
              onClick={() => activateTab(tab.taskId, tab.key)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter') activateTab(tab.taskId, tab.key);
              }}
            >
              {tab.kind === 'claude' ? <Sparkles size={12} /> : <SquareTerminal size={12} />}
              {tab.kind === 'claude' ? t('terminalClaude') : 'bash'}
              {tab.exited ? <span className="tag">exit</span> : null}
              <button
                className="x"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.key);
                }}
                aria-label={t('terminalClose')}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <button
            className="btn ghost sm"
            disabled={!running}
            onClick={() => openTab(selected.task.id, 'shell')}
            type="button"
          >
            <Plus size={13} /> {t('terminalNew')}
          </button>
          <button
            className="btn ghost sm"
            disabled={!running}
            onClick={() => openTab(selected.task.id, 'claude')}
            type="button"
          >
            <Sparkles size={13} /> {t('terminalClaude')}
          </button>
        </div>
      )}

      {selected !== null && ownTabs.length === 0 ? (
        <div className="term-body" style={{ display: 'grid', placeItems: 'center' }}>
          <p className="empty">{running ? t('terminalEmpty') : t('taskNeedsRunning')}</p>
        </div>
      ) : null}

      {tabs.map((tab) => (
        <TerminalView
          key={tab.key}
          taskId={tab.taskId}
          kind={tab.kind}
          active={tab.taskId === taskId && tab.key === activeKey}
          onOpened={(id) => markTabOpened(tab.key, id)}
          onExit={() => markTabExited(tab.key)}
          onError={setError}
        />
      ))}

      <div className="term-side">
        <span>{t('terminalDetachHint')}</span>
        <span className="spacer" />
        <span>{t('taskDropHint')}</span>
      </div>
    </div>
  );
}
