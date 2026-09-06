import { Hammer, Sparkles } from 'lucide-react';
import type { JSX } from 'react';
import { useState } from 'react';

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

  const taskCount = snapshot?.tasks.length ?? 0;
  const [name, setName] = useState(() => suggestName(taskCount, language));
  const [note, setNote] = useState('');
  const [profileId, setProfileId] = useState<string | null>(snapshot?.config.defaultProfileId ?? null);
  const [kind, setKind] = useState<WorkspaceSource['kind']>('empty');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');

  if (snapshot === null) return <p className="hint">{t('commonRunning')}</p>;
  const { config, docker, image } = snapshot;
  const working = busy !== null;

  const source: WorkspaceSource =
    kind === 'git' ? { kind: 'git', url: url.trim(), ref: ref.trim() } : { kind: 'empty' };
  // Problems with what was typed show under the form; Docker and image problems
  // already have their own notice at the top, so they only disable the button.
  const formProblem =
    taskNameProblem(name, language) ?? (kind === 'git' ? (cloneUrlProblem(url) ?? cloneRefProblem(ref)) : null);
  const blocked = formProblem !== null || !docker.available || !image.exists;

  const create = (): void => {
    void (async () => {
      const result = await run('task', () => window.cc.taskCreate({ name, note, profileId, source }));
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
            onClick={() => void run('build', () => window.cc.imageBuild({ noCache: false }))}
            type="button"
          >
            <Hammer size={13} /> {t('imageBuild')}
          </button>
        </div>
      ) : null}

      <div className="grid2">
        <TextField label={t('taskName')} value={name} mono={false} onChange={setName} />
        <Field label={t('taskProfile')}>
          <select
            value={profileId ?? ''}
            onChange={(event) => setProfileId(event.target.value === '' ? null : event.target.value)}
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

      <TextField label={t('taskNote')} value={note} mono={false} onChange={setNote} />

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
