/** The dashboard: Docker → image → container → Claude Code, in the order you need them. */

import {
  Boxes,
  CircleStop,
  Hammer,
  Play,
  RefreshCw,
  RotateCcw,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import { formatBytes, formatTime, Pill, Section } from '../components/ui.tsx';
import { LogPane } from '../components/LogPane.tsx';
import { pick, useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';

export function ConnectPanel(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const snapshot = useApp((state) => state.snapshot);
  const busy = useApp((state) => state.busy);
  const run = useApp((state) => state.run);
  const setToast = useApp((state) => state.setToast);
  const clearLogs = useApp((state) => state.clearLogs);
  const requestTerminal = useApp((state) => state.requestTerminal);
  const [confirmRemove, setConfirmRemove] = useState<'none' | 'container' | 'volume'>('none');

  if (snapshot === null) {
    return <p className="hint">{t('commonRunning')}</p>;
  }

  const { docker, image, container, config } = snapshot;
  const working = busy !== null;
  const activeProfile = config.profiles.find((profile) => profile.id === config.activeProfileId) ?? null;

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
        <div className="row" style={{ marginBottom: 10 }}>
          <Pill tone={docker.available ? 'ok' : 'err'}>
            {docker.available ? t('statusDockerOk') : t('statusDockerNg')}
          </Pill>
          {docker.version === null ? null : <span className="tag">{`${t('dockerVersion')} ${docker.version}`}</span>}
          {docker.apiVersion === null ? null : <span className="tag">{`${t('dockerApi')} ${docker.apiVersion}`}</span>}
        </div>
        {docker.available ? null : (
          <p className="hint warn">
            {t('dockerHint')}
            {docker.error === null ? '' : ` — ${docker.error}`}
          </p>
        )}
      </Section>

      <Section title={t('sectionImage')}>
        <dl className="kv">
          <dt>{t('imageTag')}</dt>
          <dd>{image.tag}</dd>
          <dt>{t('imageCreated')}</dt>
          <dd>{formatTime(image.createdAt)}</dd>
          <dt>{t('imageSize')}</dt>
          <dd>{formatBytes(image.sizeBytes)}</dd>
        </dl>
        {image.exists ? null : <p className="hint warn">{t('imageNotBuilt')}</p>}
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

      <Section title={t('sectionContainer')}>
        <div className="row" style={{ marginBottom: 10 }}>
          <Pill tone={container.running ? 'ok' : container.exists ? 'warn' : 'idle'}>
            {container.running
              ? t('statusContainerRunning')
              : container.exists
                ? t('statusContainerStopped')
                : t('statusContainerMissing')}
          </Pill>
        </div>
        <dl className="kv">
          <dt>{t('containerName')}</dt>
          <dd>{container.name}</dd>
          <dt>{t('containerStatus')}</dt>
          <dd>{container.status}</dd>
          <dt>{t('containerStartedAt')}</dt>
          <dd>{formatTime(container.startedAt)}</dd>
          <dt>{t('settingsVolumeName')}</dt>
          <dd>{config.volumeName}</dd>
        </dl>
        <p className="hint">{t('containerVolumeHint')}</p>
        <div className="row">
          <button
            className={container.running ? 'btn' : 'btn primary'}
            disabled={working || !docker.available || !image.exists}
            onClick={() => void run('container', () => window.cc.containerUp())}
            type="button"
          >
            <Play size={14} /> {t('containerStart')}
          </button>
          <button
            className="btn"
            disabled={working || !container.running}
            onClick={() => void run('container', () => window.cc.containerStop())}
            type="button"
          >
            <CircleStop size={14} /> {t('containerStop')}
          </button>
          <button
            className="btn"
            disabled={working || !container.exists}
            onClick={() => void run('container', () => window.cc.containerRestart())}
            type="button"
          >
            <RefreshCw size={14} /> {t('containerRestart')}
          </button>
          <span style={{ flex: 1 }} />
          <button
            className="btn danger"
            disabled={working || !container.exists}
            onClick={() => setConfirmRemove('container')}
            type="button"
          >
            <Trash2 size={14} /> {t('containerRemove')}
          </button>
          <button className="btn danger" disabled={working} onClick={() => setConfirmRemove('volume')} type="button">
            <Trash2 size={14} /> {t('containerRemoveWithVolume')}
          </button>
        </div>

        {confirmRemove === 'none' ? null : (
          <div className="banner error" style={{ marginTop: 12 }}>
            <span>
              {confirmRemove === 'volume'
                ? pick(
                    language,
                    'ボリュームごと削除すると、コンテナ内の設定とワークスペースが完全に消えます。先に取り出しましたか？',
                    'Removing the volume erases the container settings and the whole workspace. Have you exported it?',
                  )
                : pick(
                    language,
                    'コンテナを削除します。ボリュームは残るので、設定とワークスペースは維持されます。',
                    'This removes the container. The volume stays, so settings and the workspace survive.',
                  )}
            </span>
            <span className="spacer" />
            <button
              className="btn danger sm"
              onClick={() => {
                const withVolume = confirmRemove === 'volume';
                setConfirmRemove('none');
                void run('container', () => window.cc.containerRemove(withVolume));
              }}
              type="button"
            >
              {t('commonYes')}
            </button>
            <button className="btn sm" onClick={() => setConfirmRemove('none')} type="button">
              {t('commonCancel')}
            </button>
          </div>
        )}
      </Section>

      <Section title={t('sectionLaunch')}>
        <div className="field" style={{ maxWidth: 460 }}>
          <label>{t('activeProfile')}</label>
          <select
            value={config.activeProfileId ?? ''}
            disabled={working || config.profiles.length === 0}
            onChange={(event) => void run('profile', () => window.cc.profileActivate(event.target.value))}
          >
            {config.profiles.length === 0 ? <option value="">{t('statusProfileNone')}</option> : null}
            {config.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
                {profile.model === '' ? '' : ` — ${profile.model}`}
              </option>
            ))}
          </select>
          {activeProfile === null ? null : (
            <span className="sub">{activeProfile.baseUrl === '' ? t('commonUnset') : activeProfile.baseUrl}</span>
          )}
        </div>

        <p className="hint">{t('launchHint')}</p>
        <div className="row">
          <button
            className="btn primary"
            disabled={working || !container.running}
            onClick={() => requestTerminal('claude')}
            type="button"
          >
            <TerminalIcon size={14} /> {t('launchClaude')}
          </button>
          <button
            className="btn"
            disabled={working || !container.running}
            onClick={() => requestTerminal('shell')}
            type="button"
          >
            <Boxes size={14} /> {t('launchShell')}
          </button>
          <button
            className="btn"
            disabled={working || !container.running}
            onClick={() => {
              void (async () => {
                const summary = await run('provision', () => window.cc.containerProvision());
                if (summary !== null) setToast(summary);
              })();
            }}
            type="button"
          >
            <Upload size={14} /> {t('provision')}
          </button>
        </div>
        <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
          {t('provisionHint')}
        </p>
      </Section>

      <Section
        title={t('sectionLog')}
        actions={
          <button className="btn ghost sm" onClick={clearLogs} type="button">
            {t('commonClear')}
          </button>
        }
      >
        <LogPane />
      </Section>
    </>
  );
}
