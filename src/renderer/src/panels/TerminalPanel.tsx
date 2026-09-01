import { Link2, Plus, RefreshCw, Sparkles, SquareTerminal, X } from 'lucide-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';

import type { TerminalKind, TmuxSession } from '../../../shared/types.ts';
import { TerminalView } from '../components/TerminalView.tsx';
import { pick, useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';

interface Tab {
  readonly key: string;
  readonly kind: TerminalKind;
  readonly sessionName: string;
  readonly sessionId: string | undefined;
  readonly id: string | null;
  readonly exited: boolean;
}

let tabCounter = 0;

const SESSION_POLL_MS = 4000;

export function TerminalPanel(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const running = useApp((state) => state.snapshot?.container.running === true);
  const visible = useApp((state) => state.tab === 'terminal');
  const defaultSession = useApp((state) => state.snapshot?.config.tmuxSession ?? 'cc');
  const setError = useApp((state) => state.setError);
  const setTab = useApp((state) => state.setTab);

  const [tabs, setTabs] = useState<readonly Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [sessions, setSessions] = useState<readonly TmuxSession[]>([]);

  const refreshSessions = async (): Promise<void> => {
    const result = await window.cc.tmuxList();
    if (result.ok) setSessions(result.value);
  };

  const openTab = useCallback((kind: TerminalKind, sessionName: string, sessionId?: string) => {
    tabCounter += 1;
    const key = `t${tabCounter}`;
    setTabs((current) => [...current, { key, kind, sessionName, sessionId, id: null, exited: false }]);
    setActiveKey(key);
  }, []);

  useEffect(
    () =>
      useApp.subscribe((state, previous) => {
        const pending = state.pendingTerminal;
        if (pending === null || pending === previous.pendingTerminal) return;
        useApp.getState().clearPendingTerminal();
        if (state.snapshot?.container.running !== true) {
          setError(t('terminalNeedsContainer'));
          setTab('connect');
          return;
        }
        openTab(pending.kind, state.snapshot.config.tmuxSession);
      }),
    [openTab, setError, setTab, t],
  );

  useEffect(
    () =>
      window.cc.onTerminalsReset(() => {
        setTabs([]);
        setActiveKey(null);
        setSessions([]);
      }),
    [],
  );

  useEffect(() => {
    if (!running || !visible) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const result = await window.cc.tmuxList();
      if (cancelled) return;
      if (result.ok) setSessions(result.value);
    };
    const timer = window.setInterval(() => void poll(), SESSION_POLL_MS);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [running, visible]);

  const closeTab = (key: string): void => {
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.key !== key);
      setActiveKey((active) => (active === key ? (remaining[remaining.length - 1]?.key ?? null) : active));
      return remaining;
    });
    void refreshSessions();
  };

  const visibleSessions = running ? sessions : [];

  return (
    <div className="term-shell">
      <div className="term-tabs">
        {tabs.map((tab) => (
          <span
            key={tab.key}
            className={`tab ${tab.key === activeKey ? 'active' : ''}`}
            onClick={() => setActiveKey(tab.key)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setActiveKey(tab.key);
            }}
          >
            {tab.kind === 'claude' ? <Sparkles size={12} /> : <SquareTerminal size={12} />}
            {tab.kind === 'claude'
              ? `${t('terminalClaude')} · ${tab.sessionName}`
              : tab.kind === 'attach'
                ? `tmux · ${tab.sessionName}`
                : 'bash'}
            {tab.exited ? <span className="tag">exit</span> : null}
            <span
              className="x"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.key);
              }}
              role="button"
              tabIndex={-1}
              aria-label={t('terminalClose')}
            >
              <X size={12} />
            </span>
          </span>
        ))}
        <button
          className="btn ghost sm"
          disabled={!running}
          onClick={() => openTab('shell', defaultSession)}
          type="button"
        >
          <Plus size={13} /> {t('terminalNew')}
        </button>
        <button
          className="btn ghost sm"
          disabled={!running}
          onClick={() => openTab('claude', defaultSession)}
          type="button"
        >
          <Sparkles size={13} /> {t('terminalClaude')}
        </button>
      </div>

      {tabs.length === 0 ? (
        <div className="term-body" style={{ display: 'grid', placeItems: 'center' }}>
          <p className="empty">
            {running
              ? pick(
                  language,
                  '「Claude Code」または「新しいシェル」でセッションを開きます。',
                  'Open a session with "Claude Code" or "New shell".',
                )
              : t('terminalNeedsContainer')}
          </p>
        </div>
      ) : null}

      {tabs.map((tab) => (
        <TerminalView
          key={tab.key}
          kind={tab.kind}
          sessionName={tab.sessionName}
          sessionId={tab.sessionId}
          active={tab.key === activeKey}
          onOpened={(id, sessionName) => {
            setTabs((current) =>
              current.map((candidate) => (candidate.key === tab.key ? { ...candidate, id, sessionName } : candidate)),
            );
            void refreshSessions();
          }}
          onExit={() => {
            setTabs((current) =>
              current.map((candidate) => (candidate.key === tab.key ? { ...candidate, exited: true } : candidate)),
            );
            void refreshSessions();
          }}
          onError={setError}
        />
      ))}

      <div className="term-side">
        <strong style={{ fontWeight: 600 }}>{t('terminalSessions')}</strong>
        <button className="btn ghost sm" onClick={() => void refreshSessions()} type="button" title={t('filesRefresh')}>
          <RefreshCw size={12} />
        </button>
        {visibleSessions.length === 0 ? (
          <span className="empty" style={{ padding: 0 }}>
            {t('terminalNoSessions')}
          </span>
        ) : (
          visibleSessions.map((session) => (
            <span key={session.name} className="session">
              <span
                className={`lamp ${session.attached ? '' : 'off'}`}
                style={session.attached ? { background: 'var(--live)' } : undefined}
              />
              {session.name}
              <span className="tag">{`${session.windows}w`}</span>
              <button
                className="btn ghost sm"
                onClick={() => openTab('attach', session.name, session.id)}
                type="button"
              >
                <Link2 size={12} /> {t('terminalAttach')}
              </button>
              <button
                className="btn ghost sm"
                onClick={() => {
                  void (async () => {
                    const result = await window.cc.tmuxKill(session.id, session.name);
                    if (!result.ok) setError(result.error);
                    await refreshSessions();
                  })();
                }}
                type="button"
              >
                {t('terminalKill')}
              </button>
            </span>
          ))
        )}
        <span style={{ flex: 1 }} />
        <span className="empty" style={{ padding: 0 }}>
          {t('terminalDetachHint')}
        </span>
      </div>
    </div>
  );
}
