/** App shell: sidebar, status header, and the panel router. */

import { Boxes, Container, FileCode2, Files, Plug, Settings, SquareTerminal } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect } from 'react';

import { Banner, Pill } from './components/ui.tsx';
import { useT } from './i18n.ts';
import { ConnectPanel } from './panels/ConnectPanel.tsx';
import { FilesPanel } from './panels/FilesPanel.tsx';
import { ImagePanel } from './panels/ImagePanel.tsx';
import { ProfilesPanel } from './panels/ProfilesPanel.tsx';
import { SettingsPanel } from './panels/SettingsPanel.tsx';
import { TerminalPanel } from './panels/TerminalPanel.tsx';
import { startTerminalBus } from './terminalBus.ts';
import { useApp } from './store.ts';
import type { TabId } from './store.ts';

const NAV: ReadonlyArray<{ id: TabId; icon: JSX.Element; key: NavKey }> = [
  { id: 'connect', icon: <Plug size={15} />, key: 'navConnect' },
  { id: 'terminal', icon: <SquareTerminal size={15} />, key: 'navTerminal' },
  { id: 'files', icon: <Files size={15} />, key: 'navFiles' },
  { id: 'profiles', icon: <Boxes size={15} />, key: 'navProfiles' },
  { id: 'image', icon: <FileCode2 size={15} />, key: 'navImage' },
  { id: 'settings', icon: <Settings size={15} />, key: 'navSettings' },
];

type NavKey = 'navConnect' | 'navTerminal' | 'navFiles' | 'navProfiles' | 'navImage' | 'navSettings';

/** Everything except the terminal, which is mounted separately and never torn down. */
function Panel({ tab }: { tab: Exclude<TabId, 'terminal'> }): JSX.Element {
  switch (tab) {
    case 'connect':
      return <ConnectPanel />;
    case 'files':
      return <FilesPanel />;
    case 'profiles':
      return <ProfilesPanel />;
    case 'image':
      return <ImagePanel />;
    case 'settings':
      return <SettingsPanel />;
  }
}

export function App(): JSX.Element {
  const t = useT();
  const tab = useApp((state) => state.tab);
  const setTab = useApp((state) => state.setTab);
  const snapshot = useApp((state) => state.snapshot);
  const busy = useApp((state) => state.busy);
  const error = useApp((state) => state.error);
  const toast = useApp((state) => state.toast);
  const setError = useApp((state) => state.setError);
  const setToast = useApp((state) => state.setToast);
  const refresh = useApp((state) => state.refresh);
  const appendLog = useApp((state) => state.appendLog);

  useEffect(() => {
    startTerminalBus();
    void refresh();
    const offLog = window.cc.onLog(appendLog);
    const offState = window.cc.onStateChanged(() => void refresh());
    return () => {
      offLog();
      offState();
    };
  }, [refresh, appendLog]);

  // A toast is a confirmation, not a dialog; it should not need dismissing.
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast, setToast]);

  const docker = snapshot?.docker;
  const container = snapshot?.container;
  const activeProfile =
    snapshot?.config.profiles.find((profile) => profile.id === snapshot.config.activeProfileId) ?? null;

  // The terminal and file panels manage their own scrolling and fill the frame.
  const flush = tab === 'terminal' || tab === 'files';

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <Container size={17} />
          {t('appTitle')}
        </span>
        <span className="spacer" />
        <Pill tone={docker?.available === true ? 'ok' : 'err'}>
          {docker?.available === true ? t('statusDockerOk') : t('statusDockerNg')}
        </Pill>
        <Pill tone={container?.running === true ? 'ok' : container?.exists === true ? 'warn' : 'idle'}>
          {container?.running === true
            ? t('statusContainerRunning')
            : container?.exists === true
              ? t('statusContainerStopped')
              : t('statusContainerMissing')}
        </Pill>
        <Pill tone={activeProfile === null ? 'warn' : 'idle'}>
          {activeProfile === null ? t('statusProfileNone') : activeProfile.name}
        </Pill>
      </header>

      <nav className="sidebar">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
            type="button"
          >
            {item.icon}
            {t(item.key)}
          </button>
        ))}
        <div className="sidebar-foot">
          {activeProfile === null ? null : (
            <>
              <div>{activeProfile.model === '' ? '—' : activeProfile.model}</div>
              <div style={{ wordBreak: 'break-all' }}>{activeProfile.baseUrl}</div>
            </>
          )}
        </div>
      </nav>

      <main className={flush ? 'content flush' : 'content'}>
        {busy === null ? null : <div className="busybar" />}
        {error === null ? null : (
          <div style={flush ? { padding: '10px 12px 0' } : undefined}>
            <Banner kind="error" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </div>
        )}
        {toast === null ? null : (
          <div style={flush ? { padding: '10px 12px 0' } : undefined}>
            <Banner kind="info" onDismiss={() => setToast(null)}>
              {toast}
            </Banner>
          </div>
        )}
        {/* Always mounted: unmounting would close every docker exec session. */}
        <div className="panel-host" style={{ display: tab === 'terminal' ? 'flex' : 'none' }}>
          <TerminalPanel />
        </div>
        {tab === 'terminal' ? null : <Panel tab={tab} />}
      </main>
    </div>
  );
}
