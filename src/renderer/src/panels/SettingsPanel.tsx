import { FolderOpen } from 'lucide-react';
import type { JSX } from 'react';

import type { ConfigPatch, Language } from '../../../shared/types.ts';
import { Check, Field, Section } from '../components/ui.tsx';
import { useT } from '../i18n.ts';
import { useApp } from '../store.ts';

export function SettingsPanel(): JSX.Element {
  const t = useT();
  const snapshot = useApp((state) => state.snapshot);
  const run = useApp((state) => state.run);

  if (snapshot === null) return <p className="hint">{t('commonRunning')}</p>;
  const { config } = snapshot;

  const save = (patch: ConfigPatch): void => {
    void run('config', () => window.cc.configSave(patch));
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

        <Field label={t('settingsDataDir')} hint={t('settingsDataDirHint')}>
          <div className="inline-input">
            <input type="text" value={snapshot.dataDir} readOnly spellCheck={false} />
            <button className="btn sm" type="button" onClick={() => void window.cc.revealPath(snapshot.dataDir)}>
              <FolderOpen size={13} /> {t('settingsOpenDataDir')}
            </button>
          </div>
        </Field>
      </Section>

      <Section title="About">
        <dl className="kv">
          <dt>{t('settingsAppVersion')}</dt>
          <dd>{snapshot.appVersion}</dd>
          <dt>platform</dt>
          <dd>{snapshot.platform}</dd>
          <dt>secrets</dt>
          <dd>{snapshot.secretsEncrypted ? 'encrypted (safeStorage)' : 'plain text'}</dd>
          <dt>{t('settingsInstanceId')}</dt>
          <dd>{config.dataInstanceId}</dd>
        </dl>
        {snapshot.secretsEncrypted ? null : <p className="hint warn">{t('settingsSecretsPlain')}</p>}
      </Section>
    </>
  );
}
