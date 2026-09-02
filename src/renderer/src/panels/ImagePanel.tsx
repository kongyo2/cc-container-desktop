import { FolderOpen, Hammer, RotateCcw, Save } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import { CodeEditor } from '../components/CodeEditor.tsx';
import { ConfirmBanner, Section } from '../components/ui.tsx';
import { pick, useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';

export function ImagePanel(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const run = useApp((state) => state.run);
  const busy = useApp((state) => state.busy);
  const setToast = useApp((state) => state.setToast);
  const setError = useApp((state) => state.setError);
  const dockerAvailable = useApp((state) => state.snapshot?.docker.available === true);

  const [dockerfile, setDockerfile] = useState('');
  const [setup, setSetup] = useState('');
  const [postCreate, setPostCreate] = useState('');
  const [dir, setDir] = useState('');
  const [dirty, setDirty] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    void (async () => {
      const result = await window.cc.imageSourcesGet();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDockerfile(result.value.dockerfile);
      setSetup(result.value.setup);
      setPostCreate(result.value.postCreate);
      setDir(result.value.dir);
      setDirty(false);
    })();
  }, [setError]);

  const setupWired = dockerfile.includes('setup.sh');

  const save = async (): Promise<boolean> => {
    const result = await window.cc.imageSourcesSave({ dockerfile, setup, postCreate });
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setDirty(false);
    return true;
  };

  return (
    <>
      <Section
        title={t('imageSectionSources')}
        actions={
          <>
            <button className="btn ghost sm" onClick={() => void window.cc.revealPath(dir)} type="button">
              <FolderOpen size={13} /> {t('imageOpenFolder')}
            </button>
            <button className="btn danger sm" onClick={() => setConfirmReset(true)} type="button">
              <RotateCcw size={13} /> {t('imageReset')}
            </button>
          </>
        }
      >
        <p className="hint">{t('imageSourcesHint')}</p>
        <p className="hint" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>
          {dir}
        </p>

        {confirmReset ? (
          <ConfirmBanner
            message={t('imageResetConfirm')}
            onConfirm={() => {
              setConfirmReset(false);
              void (async () => {
                const result = await window.cc.imageSourcesReset();
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setDockerfile(result.value.dockerfile);
                setSetup(result.value.setup);
                setPostCreate(result.value.postCreate);
                setDirty(false);
              })();
            }}
            onCancel={() => setConfirmReset(false)}
          />
        ) : null}

        <div className="row" style={{ marginBottom: 12 }}>
          <button
            className="btn"
            disabled={!dirty}
            onClick={() => {
              void (async () => {
                if (await save()) setToast(t('filesSaved'));
              })();
            }}
            type="button"
          >
            <Save size={14} /> {t('imageSave')}
          </button>
          <button
            className="btn primary"
            disabled={busy !== null || !dockerAvailable}
            onClick={() => {
              void (async () => {
                if (dirty && !(await save())) return;
                await run('build', () => window.cc.imageBuild({ noCache: false }));
              })();
            }}
            type="button"
          >
            <Hammer size={14} /> {t('imageBuild')}
          </button>
          <span className="empty" style={{ padding: 0 }}>
            {pick(
              language,
              'ビルド後に「接続」タブでコンテナを再作成すると反映されます。',
              'Recreate the container from the Connect tab after building to pick up the new image.',
            )}
          </span>
        </div>
      </Section>

      <Section title={t('imageDockerfile')}>
        <div className="cm-fixed">
          <CodeEditor
            value={dockerfile}
            language="plain"
            onChange={(value) => {
              setDockerfile(value);
              setDirty(true);
            }}
          />
        </div>
      </Section>

      <Section title={t('imageSetup')}>
        <p className="hint">{t('imageSetupHint')}</p>
        {setupWired ? null : <p className="hint warn">{t('imageSetupMissing')}</p>}
        <div className="cm-fixed">
          <CodeEditor
            value={setup}
            language="shell"
            onChange={(value) => {
              setSetup(value);
              setDirty(true);
            }}
          />
        </div>
      </Section>

      <Section title={t('imagePostCreate')}>
        <div className="cm-fixed">
          <CodeEditor
            value={postCreate}
            language="shell"
            onChange={(value) => {
              setPostCreate(value);
              setDirty(true);
            }}
          />
        </div>
      </Section>
    </>
  );
}
