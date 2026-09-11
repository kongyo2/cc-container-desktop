import { Hammer, Sparkles } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

import { activeEnvironments } from '../../../shared/environments.ts';
import { cloneRefProblem, cloneUrlProblem } from '../../../shared/git.ts';
import { taskNameProblem } from '../../../shared/tasks.ts';
import type { WorkspaceSource } from '../../../shared/types.ts';
import { Field, Section, TextField } from '../components/ui.tsx';
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
  const { config, docker, image } = snapshot;
  const working = busy !== null;
  const profileId = profileChoice === undefined ? config.defaultProfileId : profileChoice;

  // Only an environment that still exists and is not archived can be picked;
  // the default one is preselected, the first active one otherwise.
  const environments = activeEnvironments(config);
  const wanted = environmentChoice ?? config.defaultEnvironmentId;
  const environmentId =
    wanted !== null && environments.some((environment) => environment.id === wanted)
      ? wanted
      : (environments[0]?.id ?? null);

  const source: WorkspaceSource =
    kind === 'git' ? { kind: 'git', url: url.trim(), ref: ref.trim() } : { kind: 'empty' };
  const formProblem =
    taskNameProblem(name, language) ?? (kind === 'git' ? (cloneUrlProblem(url) ?? cloneRefProblem(ref)) : null);
  const blocked = formProblem !== null || !docker.available || !image.exists || environmentId === null;

  const create = (): void => {
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
      {docker.available && !image.exists ? (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="hint warn" style={{ margin: 0 }}>
            {t('taskImageMissing')}
          </span>
          <button
            className="btn sm"
            disabled={working}
            onClick={() => void run('build', () => window.cc.imageBuild({ noCache: false, refreshClaudeCode: false }))}
            type="button"
          >
            <Hammer size={13} /> {t('imageBuild')}
          </button>
        </div>
      ) : null}

      <div className="grid2">
        <TextField label={t('taskName')} value={name} mono={false} onChange={setName} />
        <Field label={t('taskEnvironment')} hint={t('taskEnvironmentHint')}>
          <select
            value={environmentId ?? ''}
            disabled={environments.length === 0}
            onChange={(event) => setEnvironmentChoice(event.target.value)}
            data-testid="task-environment"
          >
            {environments.length === 0 ? <option value="">{t('taskEnvironmentNone')}</option> : null}
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
                {environment.id === config.defaultEnvironmentId ? ` — ${t('envDefault')}` : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {environments.length === 0 ? (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="hint warn" style={{ margin: 0 }}>
            {t('envNoneActive')}
          </span>
          <button className="btn sm" onClick={() => setView('environments')} type="button">
            {t('navEnvironments')}
          </button>
        </div>
      ) : null}

      <div className="grid2">
        <Field label={t('taskProfile')}>
          <select
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
