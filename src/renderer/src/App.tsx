import { Container, MonitorSmartphone, Unplug } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef } from 'react';

import type { RemoteLinkView } from '../../shared/remote.ts';
import { Banner } from './components/ui.tsx';
import { StatusStrip } from './components/StatusStrip.tsx';
import { useT } from './i18n.ts';
import { EnvironmentsPanel } from './panels/EnvironmentsPanel.tsx';
import { ExtensionsPanel } from './panels/ExtensionsPanel.tsx';
import { ImagesPanel } from './panels/ImagesPanel.tsx';
import { LogPanel } from './panels/LogPanel.tsx';
import { NewTaskPanel } from './panels/NewTaskPanel.tsx';
import { ProfilesPanel } from './panels/ProfilesPanel.tsx';
import { RemotePanel } from './panels/RemotePanel.tsx';
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
    case 'remote':
      return <RemotePanel />;
    case 'log':
      return <LogPanel />;
    case 'settings':
      return <SettingsPanel />;
  }
}

function LinkGate({ link }: { link: RemoteLinkView }): JSX.Element {
  const t = useT();
  const run = useApp((state) => state.run);
  return (
    <div className="link-gate" data-testid="link-gate">
      <MonitorSmartphone size={28} />
      <h1>{t('remoteGateTitle')}</h1>
      <p>
        {link.peerName ?? ''}
        {link.address === null ? '' : ` · ${link.address}`}
        {link.attempt > 1 ? ` · ${t('remoteAttempt')} ${link.attempt}` : ''}
      </p>
      {link.error === null ? null : <p className="hint err">{link.error}</p>}
      <p className="hint">{t('remoteGateHint')}</p>
      <button className="btn" type="button" onClick={() => void run('remote', () => window.cc.remoteDisconnect())}>
        <Unplug size={14} /> {t('remoteBackToLocal')}
      </button>
    </div>
  );
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
  const dropAllTabs = useApp((state) => state.dropAllTabs);
  const applyOperation = useApp((state) => state.applyOperation);
  const link = snapshot?.remote.link ?? null;
  const epoch = link?.epoch ?? 0;
  const lastEpoch = useRef(epoch);

  useEffect(() => {
    if (lastEpoch.current === epoch) return;
    lastEpoch.current = epoch;
    dropAllTabs();
  }, [epoch, dropAllTabs]);

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
  const driving = link !== null && link.state === 'online';
  const pending = link !== null && (link.state === 'connecting' || link.state === 'error');

  return (
    <div className="app">
      <header className={driving ? 'titlebar driving' : 'titlebar'}>
        <span className="brand">
          <Container size={16} />
          {t('appTitle')}
        </span>
        {driving ? (
          <span className="driving-badge" data-testid="driving-badge">
            <MonitorSmartphone size={13} />
            {t('remoteDriving')}: {link?.peerName ?? ''}
          </span>
        ) : null}
        <span className="spacer" />
        <span className="legend">{snapshot === null ? '' : `v${snapshot.appVersion}`}</span>
      </header>

      <StatusStrip snapshot={snapshot} />

      {pending ? <LinkGate link={link} /> : null}
      {pending ? null : <TaskSidebar />}

      <main className={flush ? 'content flush' : 'content'} style={pending ? { display: 'none' } : undefined}>
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
