import { X } from 'lucide-react';
import type { JSX, MouseEvent } from 'react';
import { useEffect, useState } from 'react';

import {
  ENV_FORMAT_URL,
  ENV_TEXT_PLACEHOLDER,
  SETUP_SCRIPT_PLACEHOLDER,
  environmentEnvProblems,
  environmentNameProblem,
} from '../../../shared/environments.ts';
import type { EnvironmentDraft } from '../../../shared/types.ts';
import { useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';

export interface EnvironmentDialogProps {
  readonly mode: 'create' | 'edit';
  readonly initial: EnvironmentDraft;
  readonly onClose: () => void;
}

/**
 * The "環境を編集" sheet: name, variables in .env form, a setup script, and
 * archive / cancel / save along the bottom. Saving goes through the main
 * process, which validates and normalizes the draft.
 */
export function EnvironmentDialog({ mode, initial, onClose }: EnvironmentDialogProps): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const run = useApp((state) => state.run);
  const busy = useApp((state) => state.busy);
  const setToast = useApp((state) => state.setToast);

  const [name, setName] = useState(initial.name);
  const [envText, setEnvText] = useState(initial.envText);
  const [setupScript, setSetupScript] = useState(initial.setupScript);

  const nameProblem = environmentNameProblem(name, language);
  const envProblems = environmentEnvProblems(envText);
  const working = busy !== null;
  const canSave = nameProblem === null && envProblems.length === 0 && !working;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = (): void => {
    void (async () => {
      const saved = await run('environment', () =>
        window.cc.environmentUpsert({ id: initial.id, name, envText, setupScript }),
      );
      if (saved === null) return;
      setToast(t('commonSaved'));
      onClose();
    })();
  };

  const archive = (): void => {
    void (async () => {
      const saved = await run('environment', () => window.cc.environmentArchive(initial.id, true));
      if (saved === null) return;
      setToast(t('envArchivedDone'));
      onClose();
    })();
  };

  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onBackdrop}>
      <div
        className="modal env-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="env-modal-title"
        data-testid="environment-dialog"
      >
        <header className="modal-head">
          <h1 id="env-modal-title">{mode === 'edit' ? t('envDialogEditTitle') : t('envDialogCreateTitle')}</h1>
          <button className="modal-x" type="button" onClick={onClose} aria-label={t('commonClose')}>
            <X size={20} />
          </button>
        </header>

        <div className="modal-body">
          <p className="modal-lead">{t('envDialogLead')}</p>

          <label className="modal-label" htmlFor="env-dialog-name">
            {t('envDialogName')}
          </label>
          <input
            id="env-dialog-name"
            className="modal-input"
            value={name}
            spellCheck={false}
            autoFocus={mode === 'create'}
            onChange={(event) => setName(event.target.value)}
          />
          {nameProblem === null || name === '' ? null : <p className="modal-problem">{nameProblem}</p>}

          <label className="modal-label" htmlFor="env-dialog-vars">
            {t('envDialogVars')}
          </label>
          <textarea
            id="env-dialog-vars"
            className="modal-textarea"
            rows={6}
            spellCheck={false}
            placeholder={ENV_TEXT_PLACEHOLDER}
            value={envText}
            onChange={(event) => setEnvText(event.target.value)}
          />
          <p className="modal-note">
            {t('envDialogVarsNoteBefore')}
            <button className="modal-link" type="button" onClick={() => void window.cc.openExternal(ENV_FORMAT_URL)}>
              {t('envDialogVarsNoteLink')}
            </button>
            {t('envDialogVarsNoteAfter')}
          </p>
          {envProblems.map((problem) => (
            <p className="modal-problem" key={problem}>
              {problem}
            </p>
          ))}

          <label className="modal-label" htmlFor="env-dialog-setup">
            {t('envDialogSetup')}
          </label>
          <textarea
            id="env-dialog-setup"
            className="modal-textarea"
            rows={7}
            spellCheck={false}
            placeholder={SETUP_SCRIPT_PLACEHOLDER}
            value={setupScript}
            onChange={(event) => setSetupScript(event.target.value)}
          />
          <p className="modal-note">{t('envDialogSetupNote')}</p>
        </div>

        <footer className="modal-foot">
          {mode === 'edit' ? (
            <button
              className="modal-archive"
              type="button"
              disabled={working}
              onClick={archive}
              data-testid="environment-archive"
            >
              {t('envDialogArchive')}
            </button>
          ) : null}
          <span className="spacer" />
          <button className="modal-btn" type="button" onClick={onClose}>
            {t('commonCancel')}
          </button>
          <button
            className="modal-btn primary"
            type="button"
            disabled={!canSave}
            onClick={save}
            data-testid="environment-save"
          >
            {mode === 'edit' ? t('envDialogSave') : t('envDialogCreate')}
          </button>
        </footer>
      </div>
    </div>
  );
}
