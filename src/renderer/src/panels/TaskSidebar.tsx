import { Boxes, HardDriveDownload, Layers, ListTodo, Plus, Puzzle, ScrollText, Settings } from 'lucide-react';
import type { JSX } from 'react';

import { environmentById } from '../../../shared/environments.ts';
import type { TaskView } from '../../../shared/types.ts';
import type { MessageKey } from '../../../shared/i18n.ts';
import { profileById } from '../../../shared/profiles.ts';
import { useT } from '../i18n.ts';
import { useActiveOperationList, useApp } from '../store.ts';
import type { View } from '../store.ts';

const NAV: ReadonlyArray<{ id: View; icon: JSX.Element; key: MessageKey }> = [
  { id: 'images', icon: <HardDriveDownload size={15} />, key: 'navImages' },
  { id: 'environments', icon: <Layers size={15} />, key: 'navEnvironments' },
  { id: 'profiles', icon: <Boxes size={15} />, key: 'navProfiles' },
  { id: 'extensions', icon: <Puzzle size={15} />, key: 'navExtensions' },
  { id: 'log', icon: <ScrollText size={15} />, key: 'navLog' },
  { id: 'settings', icon: <Settings size={15} />, key: 'navSettings' },
];

function lampOf(view: TaskView): string {
  if (view.container.running) return 'live';
  if (view.container.exists) return 'hold';
  if (view.container.status === 'error') return 'fault';
  return 'off';
}

export function TaskSidebar(): JSX.Element {
  const t = useT();
  const snapshot = useApp((state) => state.snapshot);
  const view = useApp((state) => state.view);
  const selectedTaskId = useApp((state) => state.selectedTaskId);
  const selectTask = useApp((state) => state.selectTask);
  const setView = useApp((state) => state.setView);
  const activeOperations = useActiveOperationList();

  const tasks = snapshot?.tasks ?? [];

  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <ListTodo size={14} />
        <span>{t('navTasks')}</span>
        <span className="spacer" />
        <button
          className={`btn ghost sm ${view === 'newTask' ? 'active' : ''}`}
          onClick={() => setView('newTask')}
          type="button"
          title={t('taskNew')}
          data-testid="new-task"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="task-list" data-testid="task-list">
        {tasks.length === 0 ? <p className="empty">{t('taskListEmpty')}</p> : null}
        {tasks.map((item) => {
          const profile = snapshot === null ? null : profileById(snapshot.config, item.task.profileId);
          const environment = snapshot === null ? null : environmentById(snapshot.config, item.task.environmentId);
          const stale = item.imageStale === true || item.environmentStale === true;
          const selected = view === 'tasks' && item.task.id === selectedTaskId;
          return (
            <button
              key={item.task.id}
              className={`task-item lamp-${lampOf(item)} ${selected ? 'selected' : ''}`}
              onClick={() => selectTask(item.task.id)}
              type="button"
              data-task-id={item.task.id}
            >
              <span className="lamp" />
              <span className="task-item-body">
                <span className="task-item-name">{item.task.name}</span>
                <span className="task-item-meta">
                  {stale ? `${item.imageStale === true ? t('taskImageStale') : t('taskEnvironmentStale')} · ` : ''}
                  {environment === null ? t('taskEnvironmentMissing') : environment.name}
                  {' · '}
                  {profile === null ? t('commonUnset') : profile.name}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="sidebar-nav">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={view === item.id ? 'active' : ''}
            onClick={() => setView(item.id)}
            type="button"
            title={t(item.key)}
            data-view={item.id}
          >
            {item.icon}
            <span>{t(item.key)}</span>
            {item.id === 'images' && activeOperations.length > 0 ? (
              <span className="nav-badge" data-testid="images-nav-badge">
                {activeOperations.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </nav>
  );
}
