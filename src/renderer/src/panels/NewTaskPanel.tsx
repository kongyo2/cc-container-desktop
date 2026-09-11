import { Sparkles } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import { activeEnvironments } from '../../../shared/environments.ts';
import { cloneRefProblem, cloneUrlProblem } from '../../../shared/git.ts';
import { imageDisplayName, registeredImageById } from '../../../shared/images.ts';
import { taskNameProblem } from '../../../shared/tasks.ts';
import type { WorkspaceSource } from '../../../shared/types.ts';
import { Field, Pill, Section, TextField } from '../components/ui.tsx';
import { availabilityKey, availabilityTone } from '../images.ts';
import { useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';

function suggestName(count: number, language: 'ja' | 'en'): string {
  return language === 'ja' ? `タスク ${count + 1}` : `task-${count + 1}`;
}

export function NewTaskPanel(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const snapshot = useApp((state) => state.snapshot);
  const busy = useApp((state) => state.busy);
  const run = useApp((state) => state.run);
  const setError = useApp((state) => state.setError);
  const setToast = useApp((state) => state.setToast);
  const selectTask = useApp((state) => state.selectTask);
  const setView = useApp((state) => state.setView);

  const taskCount = snapshot?.tasks.length ?? 0;
  const [name, setName] = useState(() => suggestName(taskCount, language));
  const [note, setNote] = useState('');
  const [profileChoice, setProfileChoice] = useState<string | null | undefined>(undefined);
  const [environmentChoice, setEnvironmentChoice] = useState<string | undefined>(undefined);
  const [kind, setKind] = useState<WorkspaceSource['kind']>('empty');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');

  if (snapshot === null) return <p className="hint">{t('commonRunning')}</p>;
  const { config, docker, images } = snapshot;
  const working = busy !== null;
  const profileId = profileChoice === undefined ? config.defaultProfileId : profileChoice;

  const environments = activeEnvironments(config);
  const wanted = environmentChoice ?? config.defaultEnvironmentId;
  const environment =
    (wanted !== null ? environments.find((candidate) => candidate.id === wanted) : undefined) ??
    environments[0] ??
    null;
  const environmentId = environment?.id ?? null;
  const imageView = environment === null ? null : registeredImageById(images, environment.imageId);
  const imageReady = imageView !== null && imageView.availability.kind === 'ready';

  const source: WorkspaceSource =
    kind === 'git' ? { kind: 'git', url: url.trim(), ref: ref.trim() } : { kind: 'empty' };
  const formProblem =
    taskNameProblem(name, language) ?? (kind === 'git' ? (cloneUrlProblem(url) ?? cloneRefProblem(ref)) : null);
  const blocked = formProblem !== null || !docker.available || environmentId === null || !imageReady;

  const create = (): void => {
    if (environmentId === null) return;
    void (async () => {
      const result = await run('task', () => window.cc.taskCreate({ name, note, profileId, environmentId, source }));
      if (result === null) return;
      selectTask(result.task.id);
      if (result.warning === null) setToast(`${t('taskCreate')}: ${result.task.name}`);
      else setError(result.warning);
    })();
  };

  return (
    <Section title={t('taskNew')}>
      <p className="hint">{t('taskCreateHint')}</p>

      {docker.available ? null : <p className="hint warn">{t('taskDockerDown')}</p>}

      <div className="grid2">
        <TextField label={t('taskName')} value={name} mono={false} onChange={setName} />
        <Field label={t('taskEnvironment')} hint={t('taskEnvironmentHint')}>
          <select
            aria-label={t('taskEnvironment')}
            value={environmentId ?? ''}
            disabled={environments.length === 0}
            onChange={(event) => setEnvironmentChoice(event.target.value)}
            data-testid="task-environment"
          >
            {environments.length === 0 ? <option value="">{t('taskEnvironmentNone')}</option> : null}
            {environments.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
                {candidate.id === config.defaultEnvironmentId ? ` — ${t('envDefault')}` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {environments.length === 0 ? (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="hint warn" style={{ margin: 0 }}>
            {images.length === 0 ? t('envNoImages') : t('envNoneActive')}
          </span>
          <button
            className="btn sm"
            onClick={() => setView(images.length === 0 ? 'images' : 'environments')}
            type="button"
          >
            {images.length === 0 ? t('taskOpenImages') : t('taskCreateEnvironment')}
          </button>
        </div>
      ) : null}

      {environment !== null ? (
        <div className="row" style={{ marginBottom: 12 }} data-testid="task-environment-image">
          <span className="legend">{t('taskEnvironmentImage')}</span>
          {imageView === null ? (
            <span className="tag err">{t('envImageMissing')}</span>
          ) : (
            <>
              <span>{imageDisplayName(imageView.image, language)}</span>
              <Pill tone={availabilityTone(imageView.availability)}>{t(availabilityKey(imageView.availability))}</Pill>
            </>
          )}
          {imageReady ? null : (
            <>
              <span className="hint warn" style={{ margin: 0 }}>
                {t('taskImageUnavailable')}
              </span>
              <button className="btn sm" onClick={() => setView('images')} type="button">
                {t('taskOpenImages')}
              </button>
            </>
          )}
        </div>
      ) : null}

      <div className="grid2">
        <Field label={t('taskProfile')}>
          <select
            aria-label={t('taskProfile')}
            value={profileId ?? ''}
            onChange={(event) => setProfileChoice(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">{t('taskProfileNone')}</option>
            {config.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
                {profile.model === '' ? '' : ` — ${profile.model}`}
              </option>
            ))}
          </select>
        </Field>
        <TextField label={t('taskNote')} value={note} mono={false} onChange={setNote} />
      </div>

      <Field label={t('taskSource')}>
        <label className="check">
          <input type="radio" name="source" checked={kind === 'empty'} onChange={() => setKind('empty')} />
          <span>
            {t('taskSourceEmpty')}
            <span className="sub" style={{ display: 'block' }}>
              {t('taskSourceEmptyHint')}
            </span>
          </span>
        </label>
        <label className="check">
          <input type="radio" name="source" checked={kind === 'git'} onChange={() => setKind('git')} />
          <span>
            {t('taskSourceGit')}
            <span className="sub" style={{ display: 'block' }}>
              {t('taskSourceGitHint')}
            </span>
          </span>
        </label>
      </Field>

      {kind === 'git' ? (
        <div className="grid2">
          <TextField
            label={t('taskGitUrl')}
            value={url}
            onChange={setUrl}
            placeholder="https://github.com/owner/repo"
          />
          <TextField
            label={t('taskGitRef')}
            value={ref}
            onChange={setRef}
            hint={t('taskGitRefHint')}
            placeholder="main"
          />
        </div>
      ) : null}

      {formProblem === null || name.trim() === '' ? null : <p className="hint warn">{formProblem}</p>}

      <div className="row">
        <button
          className="btn primary"
          disabled={working || blocked}
          onClick={create}
          type="button"
          data-testid="create-task"
        >
          <Sparkles size={14} /> {working && busy === 'task' ? t('taskCreating') : t('taskCreate')}
        </button>
      </div>
    </Section>
  );
}
