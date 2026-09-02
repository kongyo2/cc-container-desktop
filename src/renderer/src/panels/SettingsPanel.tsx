import { Code2, Copy, FileCode2 } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import type { AppConfig, Language } from '../../../shared/types.ts';
import { Check, DeferredTextField, Field, Section } from '../components/ui.tsx';
import { pick, useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';

export function SettingsPanel(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const snapshot = useApp((state) => state.snapshot);
  const run = useApp((state) => state.run);
  const setToast = useApp((state) => state.setToast);
  const [uri, setUri] = useState('');

  if (snapshot === null) return <p className="hint">{t('commonRunning')}</p>;
  const { config } = snapshot;

  const save = (patch: Partial<AppConfig>): void => {
    void run('config', () => window.cc.configSave(patch));
  };

  const saveName =
    (patch: (name: string) => Partial<AppConfig>) =>
    (value: string): void => {
      const name = value.trim();
      if (name !== '') save(patch(name));
    };

  return (
    <>
      <Section title={t('settingsGeneral')}>
        <Field label={t('settingsLanguage')}>
          <select
            value={config.language}
            onChange={(event) => void run('config', () => window.cc.setLanguage(event.target.value as Language))}
          >
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
        </Field>

        <Check
          label={t('settingsAutoOnboarding')}
          checked={config.autoOnboarding}
          onChange={(autoOnboarding) => save({ autoOnboarding })}
        />
        <Check
          label={t('settingsAutoApprove')}
          checked={config.autoApproveApiKey}
          onChange={(autoApproveApiKey) => save({ autoApproveApiKey })}
        />
        <Check
          label={t('settingsSkipPermissions')}
          checked={config.skipPermissions}
          onChange={(skipPermissions) => save({ skipPermissions })}
        />

        <div className="grid2" style={{ marginTop: 10 }}>
          <DeferredTextField
            label={t('settingsTmuxSession')}
            value={config.tmuxSession}
            onCommit={saveName((tmuxSession) => ({ tmuxSession }))}
          />
          <DeferredTextField
            label={t('settingsContainerName')}
            value={config.containerName}
            onCommit={saveName((containerName) => ({ containerName }))}
          />
          <DeferredTextField
            label={t('settingsImageTag')}
            value={config.imageTag}
            onCommit={saveName((imageTag) => ({ imageTag }))}
          />
          <DeferredTextField
            label={t('settingsVolumeName')}
            value={config.volumeName}
            onCommit={saveName((volumeName) => ({ volumeName }))}
          />
        </div>
        <p className="hint">
          {pick(
            language,
            'コンテナ名・ボリューム名を変えると、次回の起動で新しいコンテナが作られます。前のボリュームは残ります。',
            'Changing the container or volume name creates a fresh container on the next start; the old volume stays put.',
          )}
        </p>
      </Section>

      <Section title={t('settingsIntegration')}>
        <p className="hint">{t('settingsVscodeHint')}</p>
        <div className="row">
          <button
            className="btn"
            disabled={!snapshot.container.running}
            onClick={() => {
              void (async () => {
                const result = await run('vscode', () => window.cc.containerVscode());
                if (result === null) return;
                setUri(result.uri);
                setToast(result.hint);
              })();
            }}
            type="button"
          >
            <Code2 size={14} /> {t('settingsVscode')}
          </button>
          <button
            className="btn"
            onClick={() => {
              void (async () => {
                const dir = await run('devcontainer', () => window.cc.devcontainerWrite());
                if (dir !== null && dir !== '') setToast(dir);
              })();
            }}
            type="button"
          >
            <FileCode2 size={14} /> {t('settingsDevcontainer')}
          </button>
          {uri === '' ? null : (
            <button
              className="btn sm"
              onClick={() => {
                void navigator.clipboard.writeText(uri);
                setToast(t('commonCopied'));
              }}
              type="button"
            >
              <Copy size={13} /> {t('settingsCopyUri')}
            </button>
          )}
        </div>
        {uri === '' ? null : (
          <p
            className="hint"
            style={{ fontFamily: 'var(--mono)', fontSize: 11, marginTop: 10, wordBreak: 'break-all' }}
          >
            {uri}
          </p>
        )}
      </Section>

      <Section title="About">
        <dl className="kv">
          <dt>{t('settingsAppVersion')}</dt>
          <dd>{snapshot.appVersion}</dd>
          <dt>platform</dt>
          <dd>{snapshot.platform}</dd>
          <dt>secrets</dt>
          <dd>{snapshot.secretsEncrypted ? 'encrypted (safeStorage)' : 'plain text'}</dd>
        </dl>
        {snapshot.secretsEncrypted ? null : <p className="hint warn">{t('settingsSecretsPlain')}</p>}
      </Section>
    </>
  );
}
