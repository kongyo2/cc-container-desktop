import type { JSX } from 'react';
import { useState } from 'react';

import {
  ENV_FORMAT_URL,
  ENV_TEXT_PLACEHOLDER,
  SETUP_SCRIPT_PLACEHOLDER,
  environmentEnvProblems,
  environmentNameProblem,
} from '../../../shared/environments.ts';
import { imageDisplayName } from '../../../shared/images.ts';
import type { EnvironmentDraft, Result } from '../../../shared/types.ts';
import { availabilityKey } from '../images.ts';
import { pick, useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';
import { ModalShell } from './ui.tsx';

export interface EnvironmentDialogProps {
  readonly mode: 'create' | 'edit';
  readonly initial: EnvironmentDraft;
  readonly onClose: () => void;
}

function ModalTextarea({
  id,
  label,
  rows,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  rows: number;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <>
      <label className="modal-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="modal-textarea"
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </>
  );
}

export function EnvironmentDialog({ mode, initial, onClose }: EnvironmentDialogProps): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const run = useApp((state) => state.run);
  const busy = useApp((state) => state.busy);
  const snapshot = useApp((state) => state.snapshot);
  const setToast = useApp((state) => state.setToast);
  const setView = useApp((state) => state.setView);

  const [name, setName] = useState(initial.name);
  const [imageId, setImageId] = useState(initial.imageId);
  const [envText, setEnvText] = useState(initial.envText);
  const [setupScript, setSetupScript] = useState(initial.setupScript);

  const images = snapshot?.images ?? [];
  const tasks = snapshot?.tasks ?? [];
  const current = images.find((view) => view.image.id === imageId) ?? null;
  const selectable = images.filter((view) => view.availability.kind === 'ready' || view.image.id === initial.imageId);
  const nameProblem = environmentNameProblem(name, language);
  const envProblems = environmentEnvProblems(envText);
  const working = busy !== null;
  const canSave = nameProblem === null && envProblems.length === 0 && imageId !== '' && current !== null && !working;
  const affected =
    mode === 'edit' && imageId !== initial.imageId
      ? tasks.filter((view) => view.task.environmentId === initial.id).length
      : 0;

  const commitAndClose = (work: () => Promise<Result<unknown>>, toast: string): void => {
    void (async () => {
      if ((await run('environment', work)) === null) return;
      setToast(toast);
      onClose();
    })();
  };

  const save = (): void => {
    commitAndClose(
      () => window.cc.environmentUpsert({ id: initial.id, name, imageId, envText, setupScript }),
      affected > 0 ? `${t('commonSaved')} — ${affected} ${t('envImageChanged')}` : t('commonSaved'),
    );
  };

  const archive = (): void => {
    commitAndClose(() => window.cc.environmentArchive(initial.id, true), t('envArchivedDone'));
  };

  const footer = (
    <>
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
    </>
  );

  return (
    <ModalShell
      variant="env-modal"
      titleId="env-modal-title"
      testId="environment-dialog"
      title={mode === 'edit' ? t('envDialogEditTitle') : t('envDialogCreateTitle')}
      footer={footer}
      onClose={onClose}
    >
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

      <label className="modal-label" htmlFor="env-dialog-image">
        {t('envDialogImage')}
      </label>
      {images.length === 0 ? (
        <div className="row" style={{ marginBottom: 20 }}>
          <span className="modal-problem" style={{ margin: 0 }}>
            {t('envNoImages')}
          </span>
          <button
            className="modal-btn"
            type="button"
            onClick={() => {
              onClose();
              setView('images');
            }}
          >
            {t('envOpenImages')}
          </button>
        </div>
      ) : (
        <select
          id="env-dialog-image"
          className="modal-input"
          value={imageId}
          onChange={(event) => setImageId(event.target.value)}
          data-testid="environment-image"
        >
          {imageId === '' ? <option value="">{pick(language, 'イメージを選択…', 'Choose an image…')}</option> : null}
          {selectable.map((view) => (
            <option key={view.image.id} value={view.image.id}>
              {imageDisplayName(view.image, language)} · {view.image.platform}
              {view.availability.kind === 'ready' ? '' : ` — ${t(availabilityKey(view.availability))}`}
            </option>
          ))}
        </select>
      )}
      <p className="modal-note">
        {t('envDialogImageNote')}
        {current !== null && current.availability.kind !== 'ready'
          ? ` ${t('envImageUnavailable')}: ${t(availabilityKey(current.availability))}`
          : ''}
      </p>
      {affected > 0 ? (
        <p className="modal-problem">
          {affected} {t('envImageChanged')}
        </p>
      ) : null}

      <ModalTextarea
        id="env-dialog-vars"
        label={t('envDialogVars')}
        rows={6}
        placeholder={ENV_TEXT_PLACEHOLDER}
        value={envText}
        onChange={setEnvText}
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

      <ModalTextarea
        id="env-dialog-setup"
        label={t('envDialogSetup')}
        rows={7}
        placeholder={SETUP_SCRIPT_PLACEHOLDER}
        value={setupScript}
        onChange={setSetupScript}
      />
      <p className="modal-note">{t('envDialogSetupNote')}</p>
    </ModalShell>
  );
}
