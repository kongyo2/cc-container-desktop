import { RefreshCw } from 'lucide-react';
import type { JSX } from 'react';

import { Section } from '../components/ui.tsx';
import { LogPane } from '../components/LogPane.tsx';
import { useT } from '../i18n.ts';
import { useApp } from '../store.ts';

export function LogPanel(): JSX.Element {
  const t = useT();
  const snapshot = useApp((state) => state.snapshot);
  const busy = useApp((state) => state.busy);
  const run = useApp((state) => state.run);
  const clearLogs = useApp((state) => state.clearLogs);

  if (snapshot === null) return <p className="hint">{t('commonRunning')}</p>;
  const { docker } = snapshot;
  const working = busy !== null;

  return (
    <>
      <Section
        title={t('sectionDocker')}
        actions={
          <button
            className="btn sm"
            disabled={working}
            onClick={() => void run('docker', () => window.cc.dockerProbe())}
            type="button"
          >
            <RefreshCw size={13} /> {t('dockerRecheck')}
          </button>
        }
      >
        <dl className="kv">
          <dt>{t('dockerVersion')}</dt>
          <dd>{docker.version ?? t('commonNone')}</dd>
          <dt>{t('dockerApi')}</dt>
          <dd>{docker.apiVersion ?? t('commonNone')}</dd>
          <dt>OS</dt>
          <dd>{docker.os ?? t('commonNone')}</dd>
        </dl>
        {docker.available ? null : (
          <p className="hint warn">
            {t('dockerHint')}
            {docker.error === null ? '' : ` — ${docker.error}`}
          </p>
        )}
      </Section>

      <Section
        title={t('sectionLog')}
        actions={
          <button className="btn ghost sm" onClick={clearLogs} type="button">
            {t('commonClear')}
          </button>
        }
      >
        <LogPane tall />
      </Section>
    </>
  );
}
