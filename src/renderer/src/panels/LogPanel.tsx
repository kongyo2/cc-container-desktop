import { Hammer, RefreshCw, RotateCcw } from 'lucide-react';
import type { JSX } from 'react';

import { formatBytes, formatTime, Section } from '../components/ui.tsx';
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
  const { docker, image } = snapshot;
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
          <dt>{t('imageTag')}</dt>
          <dd>{image.tag}</dd>
          <dt>{t('imageCreated')}</dt>
          <dd>{formatTime(image.createdAt)}</dd>
          <dt>{t('imageSize')}</dt>
          <dd>{formatBytes(image.sizeBytes)}</dd>
        </dl>
        {docker.available ? null : (
          <p className="hint warn">
            {t('dockerHint')}
            {docker.error === null ? '' : ` — ${docker.error}`}
          </p>
        )}
        {docker.available && !image.exists ? <p className="hint warn">{t('imageNotBuilt')}</p> : null}
        <div className="row">
          <button
            className={image.exists ? 'btn' : 'btn primary'}
            disabled={working || !docker.available}
            onClick={() => void run('build', () => window.cc.imageBuild({ noCache: false }))}
            type="button"
          >
            <Hammer size={14} /> {t('imageBuild')}
          </button>
          <button
            className="btn"
            disabled={working || !docker.available}
            onClick={() => void run('build', () => window.cc.imageBuild({ noCache: true }))}
            type="button"
          >
            <RotateCcw size={14} /> {t('imageRebuild')}
          </button>
        </div>
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
