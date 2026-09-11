import { ArchiveRestore, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import { parseEnvText } from '../../../shared/env.ts';
import {
  activeEnvironments,
  archivedEnvironments,
  normalizeScriptText,
  suggestEnvironmentName,
} from '../../../shared/environments.ts';
import { newId } from '../../../shared/id.ts';
import { imageDisplayName, preferredRegisteredImage, registeredImageById } from '../../../shared/images.ts';
import type { Environment, EnvironmentDraft, TaskView } from '../../../shared/types.ts';
import { EnvironmentDialog } from '../components/EnvironmentDialog.tsx';
import { ConfirmBanner, Pill, Section, formatTime } from '../components/ui.tsx';
import { availabilityKey, availabilityTone } from '../images.ts';
import { pick, useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';

interface DialogState {
  readonly mode: 'create' | 'edit';
  readonly draft: EnvironmentDraft;
}

function draftOf(environment: Environment): EnvironmentDraft {
  return {
    id: environment.id,
    name: environment.name,
    imageId: environment.imageId,
    envText: environment.envText,
    setupScript: environment.setupScript,
  };
}

function usersOf(tasks: readonly TaskView[], environmentId: string): number {
  return tasks.filter((view) => view.task.environmentId === environmentId).length;
}

export function EnvironmentsPanel(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const snapshot = useApp((state) => state.snapshot);
  const busy = useApp((state) => state.busy);
  const run = useApp((state) => state.run);
  const setToast = useApp((state) => state.setToast);
  const setView = useApp((state) => state.setView);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  if (snapshot === null) return <p className="hint">{t('commonRunning')}</p>;
  const { config, tasks, images } = snapshot;
  const working = busy !== null;
  const active = activeEnvironments(config);
  const archived = archivedEnvironments(config);

  const summaryOf = (environment: Environment): string => {
    const variables = Object.keys(parseEnvText(environment.envText).env).length;
    const hasSetup = normalizeScriptText(environment.setupScript).trim() !== '';
    const users = usersOf(tasks, environment.id);
    return [
      pick(language, `環境変数 ${variables} 件`, `${variables} variable${variables === 1 ? '' : 's'}`),
      hasSetup ? t('envSetupYes') : t('envSetupNo'),
      pick(language, `タスク ${users} 件`, `${users} task${users === 1 ? '' : 's'}`),
      `${t('envUpdatedAt')} ${formatTime(environment.updatedAt)}`,
    ].join(' · ');
  };

  const imageLine = (environment: Environment): JSX.Element => {
    const view = registeredImageById(images, environment.imageId);
    if (view === null) {
      return (
        <span className="env-row-image">
          <span className="legend">{t('envImage')}</span> <span className="tag err">{t('envImageMissing')}</span>
        </span>
      );
    }
    return (
      <span className="env-row-image">
        <span className="legend">{t('envImage')}</span> {imageDisplayName(view.image, language)}
        <Pill tone={availabilityTone(view.availability)}>{t(availabilityKey(view.availability))}</Pill>
      </span>
    );
  };

  const openCreate = (): void => {
    const preferred = preferredRegisteredImage(images);
    setDialog({
      mode: 'create',
      draft: {
        id: newId('env'),
        name: suggestEnvironmentName(config, language),
        imageId: preferred?.image.id ?? '',
        envText: '',
        setupScript: '',
      },
    });
  };

  const setArchived = (environment: Environment, value: boolean): void => {
    void (async () => {
      const saved = await run('environment', () => window.cc.environmentArchive(environment.id, value));
      if (saved !== null) setToast(value ? t('envArchivedDone') : t('envRestoredDone'));
    })();
  };

  const remove = (environment: Environment): void => {
    setConfirmDeleteId(null);
    void (async () => {
      const saved = await run('environment', () => window.cc.environmentDelete(environment.id));
      if (saved !== null) setToast(`${t('envDeletedDone')}: ${environment.name}`);
    })();
  };

  return (
    <>
      <Section
        title={t('envListTitle')}
        actions={
          <button
            className="btn primary sm"
            disabled={working}
            onClick={openCreate}
            type="button"
            data-testid="env-new"
          >
            <Plus size={13} /> {t('envNew')}
          </button>
        }
      >
        <p className="hint">{t('envListHint')}</p>
        {images.length === 0 ? (
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="hint warn" style={{ margin: 0 }}>
              {t('envNoImages')}
            </span>
            <button className="btn sm" onClick={() => setView('images')} type="button">
              {t('envOpenImages')}
            </button>
          </div>
        ) : null}
        {active.length === 0 ? <p className="empty">{t('envEmpty')}</p> : null}

        <div className="env-list" data-testid="env-list">
          {active.map((environment) => {
            const isDefault = environment.id === config.defaultEnvironmentId;
            return (
              <div className="env-row" key={environment.id} data-environment-id={environment.id}>
                <div className="env-row-body">
                  <div className="env-row-name">
                    <span>{environment.name}</span>
                    {isDefault ? <span className="tag ok">{t('envDefault')}</span> : null}
                  </div>
                  <div className="env-row-meta">{imageLine(environment)}</div>
                  <div className="env-row-meta">{summaryOf(environment)}</div>
                </div>
                <div className="row">
                  {isDefault ? null : (
                    <button
                      className="btn ghost sm"
                      disabled={working}
                      onClick={() =>
                        void run('config', () => window.cc.configSave({ defaultEnvironmentId: environment.id }))
                      }
                      type="button"
                    >
                      <Star size={13} /> {t('envMakeDefault')}
                    </button>
                  )}
                  <button
                    className="btn sm"
                    disabled={working}
                    onClick={() => setDialog({ mode: 'edit', draft: draftOf(environment) })}
                    type="button"
                    data-testid="env-edit"
                  >
                    <Pencil size={13} /> {t('envEdit')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {archived.length === 0 ? null : (
          <>
            <button
              className="btn ghost sm"
              onClick={() => {
                setShowArchived((current) => !current);
                setConfirmDeleteId(null);
              }}
              type="button"
            >
              {showArchived ? t('envHideArchived') : t('envShowArchived')} ({archived.length})
            </button>
            {showArchived ? (
              <div className="env-list" style={{ marginTop: 10 }}>
                {archived.map((environment) => (
                  <div className="env-row archived" key={environment.id} data-environment-id={environment.id}>
                    <div className="env-row-body">
                      <div className="env-row-name">
                        <span>{environment.name}</span>
                        <span className="tag">{t('envArchivedTitle')}</span>
                      </div>
                      <div className="env-row-meta">{imageLine(environment)}</div>
                      <div className="env-row-meta">{summaryOf(environment)}</div>
                      {confirmDeleteId === environment.id ? (
                        <ConfirmBanner
                          message={t('envDeleteConfirm')}
                          onConfirm={() => remove(environment)}
                          onCancel={() => setConfirmDeleteId(null)}
                          spaced
                        />
                      ) : null}
                    </div>
                    <div className="row">
                      <button
                        className="btn sm"
                        disabled={working}
                        onClick={() => setArchived(environment, false)}
                        type="button"
                      >
                        <ArchiveRestore size={13} /> {t('envRestore')}
                      </button>
                      <button
                        className="btn danger sm"
                        disabled={working}
                        onClick={() => setConfirmDeleteId(environment.id)}
                        type="button"
                      >
                        <Trash2 size={13} /> {t('envDelete')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </Section>

      {dialog === null ? null : (
        <EnvironmentDialog
          key={dialog.draft.id}
          mode={dialog.mode}
          initial={dialog.draft}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
