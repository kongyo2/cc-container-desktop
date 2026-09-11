import { Container } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect } from 'react';

import { Banner } from './components/ui.tsx';
import { StatusStrip } from './components/StatusStrip.tsx';
import { useT } from './i18n.ts';
import { EnvironmentsPanel } from './panels/EnvironmentsPanel.tsx';
import { ExtensionsPanel } from './panels/ExtensionsPanel.tsx';
import { ImagesPanel } from './panels/ImagesPanel.tsx';
import { LogPanel } from './panels/LogPanel.tsx';
import { NewTaskPanel } from './panels/NewTaskPanel.tsx';
import { ProfilesPanel } from './panels/ProfilesPanel.tsx';
import { SettingsPanel } from './panels/SettingsPanel.tsx';
import { TaskSidebar } from './panels/TaskSidebar.tsx';
import { TaskWorkspace } from './panels/TaskPanel.tsx';
import { startTerminalBus } from './terminalBus.ts';
import { useApp } from './store.ts';
import type { View } from './store.ts';

function Notice({
  kind,
  text,
  flush,
  onDismiss,
}: {
  kind: 'error' | 'info';
  text: string | null;
  flush: boolean;
  onDismiss: () => void;
}): JSX.Element | null {
  if (text === null) return null;
  return (
    <div style={flush ? { padding: '10px 12px 0' } : undefined}>
      <Banner kind={kind} onDismiss={onDismiss}>
        {text}
      </Banner>
    </div>
  );
}

function StoreProblems({ problems, flush }: { problems: readonly string[]; flush: boolean }): JSX.Element | null {
  const t = useT();
  if (problems.length === 0) return null;
  return (
    <div style={flush ? { padding: '10px 12px 0' } : undefined} data-testid="store-problems">
      <Banner kind="error">
        <strong>{t('storeProblemsTitle')}</strong>
        {problems.map((problem) => (
          <div key={problem} style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>
            {problem}
          </div>
        ))}
      </Banner>
    </div>
  );
}

function Panel({ view }: { view: Exclude<View, 'tasks'> }): JSX.Element {
  switch (view) {
    case 'newTask':
      return <NewTaskPanel />;
    case 'images':
      return <ImagesPanel />;
    case 'profiles':
      return <ProfilesPanel />;
    case 'extensions':
      return <ExtensionsPanel />;
    case 'environments':
      return <EnvironmentsPanel />;
    case 'log':
      return <LogPanel />;
    case 'settings':
      return <SettingsPanel />;
  }
}

export function App(): JSX.Element {
  const t = useT();
  const view = useApp((state) => state.view);
  const snapshot = useApp((state) => state.snapshot);
  const busy = useApp((state) => state.busy);
  const error = useApp((state) => state.error);
  const toast = useApp((state) => state.toast);
  const setError = useApp((state) => state.setError);
  const setToast = useApp((state) => state.setToast);
  const refresh = useApp((state) => state.refresh);
  const appendLog = useApp((state) => state.appendLog);
  const dropTaskTabs = useApp((state) => state.dropTaskTabs);
  const applyOperation = useApp((state) => state.applyOperation);

  useEffect(() => {
    startTerminalBus();
    void refresh();
    const offLog = window.cc.onLog(appendLog);
    const offState = window.cc.onStateChanged(() => void refresh());
    const offReset = window.cc.onTerminalsReset((reset) => dropTaskTabs(reset.taskId));
    const offOperation = window.cc.onImageOperation(applyOperation);
    return () => {
      offLog();
      offState();
      offReset();
      offOperation();
    };
  }, [refresh, appendLog, dropTaskTabs, applyOperation]);

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast, setToast]);

  const flush = view === 'tasks';

  return (
    <div className="app">
      <header className="titlebar">
        <span className="brand">
          <Container size={16} />
          {t('appTitle')}
        </span>
        <span className="spacer" />
        <span className="legend">{snapshot === null ? '' : `v${snapshot.appVersion}`}</span>
      </header>

      <StatusStrip snapshot={snapshot} />

      <TaskSidebar />

      <main className={flush ? 'content flush' : 'content'}>
        {busy === null ? null : <div className="busybar" />}
        <StoreProblems problems={snapshot?.storeProblems ?? []} flush={flush} />
        <Notice kind="error" text={error} flush={flush} onDismiss={() => setError(null)} />
        <Notice kind="info" text={toast} flush={flush} onDismiss={() => setToast(null)} />
        <div className="panel-host" style={{ display: flush ? 'flex' : 'none' }}>
          <TaskWorkspace />
        </div>
        {flush ? null : <Panel view={view} />}
      </main>
    </div>
  );
}
