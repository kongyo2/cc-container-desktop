import { Copy, ExternalLink, Eye, EyeOff, Plus, Save, Trash2, Upload } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import { envNameProblems, formatEnvText, parseEnvText } from '../../../shared/env.ts';
import { newId } from '../../../shared/id.ts';
import { ENDPOINT_PRESETS, MESSAGES_PATH, normalizeBaseUrl } from '../../../shared/presets.ts';
import type { AuthMode, Profile } from '../../../shared/types.ts';
import { Check, ConfirmBanner, DeferredTextField, Field, NumberField, Section, TextField } from '../components/ui.tsx';
import { pick, useLanguage, useT } from '../i18n.ts';
import { useApp } from '../store.ts';

const NO_PROFILES: readonly Profile[] = [];

function blankProfile(name: string): Profile {
  return {
    id: newId('p'),
    name,
    baseUrl: '',
    authMode: 'authToken',
    model: '',
    sonnetModel: '',
    opusModel: '',
    haikuModel: '',
    fableModel: '',
    apiTimeoutMs: null,
    contextTokens: null,
    disableNonEssentialTraffic: true,
    disableTelemetry: true,
    extraEnv: {},
    note: '',
  };
}

const ENV_PLACEHOLDER = `NODE_ENV=production
GIT_AUTHOR_NAME=Your Name

# Multiline values - wrap in quotes
CONFIG="key1=val1
key2=val2"`;

interface Tagged<T> {
  readonly id: string;
  readonly value: T;
}

export function ProfilesPanel(): JSX.Element {
  const t = useT();
  const language = useLanguage();
  const profiles = useApp((state) => state.snapshot?.config.profiles) ?? NO_PROFILES;
  const activeId = useApp((state) => state.snapshot?.config.activeProfileId ?? null);
  const containerRunning = useApp((state) => state.snapshot?.container.running === true);
  const secretsEncrypted = useApp((state) => state.snapshot?.secretsEncrypted === true);
  const run = useApp((state) => state.run);
  const setToast = useApp((state) => state.setToast);
  const setError = useApp((state) => state.setError);

  const [chosenId, setChosenId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Profile | null>(null);
  const [envEdit, setEnvEdit] = useState<Tagged<string> | null>(null);
  const [secretEdit, setSecretEdit] = useState<Tagged<string> | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const has = (id: string | null): boolean => id !== null && profiles.some((profile) => profile.id === id);
  const effectiveId = has(chosenId) ? chosenId : has(activeId) ? activeId : (profiles[0]?.id ?? null);
  const source = profiles.find((profile) => profile.id === effectiveId) ?? null;

  const draft = edits !== null && edits.id === effectiveId ? edits : source;
  const envText =
    envEdit !== null && envEdit.id === effectiveId
      ? envEdit.value
      : source === null
        ? ''
        : formatEnvText(source.extraEnv);
  const parsedEnv = parseEnvText(envText);
  const envProblems = [...parsedEnv.problems, ...envNameProblems(parsedEnv.env)];
  const secret = secretEdit !== null && secretEdit.id === effectiveId ? secretEdit.value : null;

  useEffect(() => {
    if (effectiveId === null) return undefined;
    let cancelled = false;
    void (async () => {
      const result = await window.cc.secretGet(effectiveId);
      if (cancelled) return;
      setSecretEdit({ id: effectiveId, value: result.ok ? result.value : '' });
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveId]);

  const select = (id: string): void => {
    setChosenId(id);
    setShowSecret(false);
    setConfirmDelete(false);
  };

  const update = (patch: Partial<Profile>): void => {
    if (draft === null) return;
    setEdits({ ...draft, ...patch });
  };

  const persist = async (activate: boolean): Promise<Profile | null> => {
    if (draft === null) return null;
    if (envProblems.length > 0) {
      setError(envProblems[0] ?? '');
      return null;
    }
    const profile: Profile = { ...draft, extraEnv: parseEnvText(envText).env };
    const saved = await run('profile', () => window.cc.profileUpsert(profile));
    if (saved === null) return null;

    if (secret !== null) {
      const secretResult = await window.cc.secretSet(profile.id, secret);
      if (!secretResult.ok) {
        setError(secretResult.error);
        return null;
      }
    }
    if (activate) await run('profile', () => window.cc.profileActivate(profile.id));
    setEdits(null);
    setEnvEdit(null);
    return profile;
  };

  const applyPreset = (presetId: string): void => {
    const preset = ENDPOINT_PRESETS.find((candidate) => candidate.id === presetId);
    if (preset === undefined) return;
    update({
      baseUrl: preset.baseUrl,
      authMode: preset.authMode,
      model: preset.model,
      sonnetModel: preset.model,
      opusModel: preset.model,
      haikuModel: preset.haikuModel,
      fableModel: preset.model,
      contextTokens: preset.contextTokens,
    });
  };

  const matchedPreset = ENDPOINT_PRESETS.find((preset) => preset.baseUrl !== '' && preset.baseUrl === draft?.baseUrl);

  return (
    <div className="profiles">
      <div className="profile-list">
        {profiles.length === 0 ? <p className="empty">{t('profileEmpty')}</p> : null}
        {profiles.map((profile) => (
          <div
            key={profile.id}
            className={`item ${profile.id === effectiveId ? 'selected' : ''}`}
            onClick={() => select(profile.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter') select(profile.id);
            }}
          >
            <div className="nm">
              {profile.name}
              {profile.id === activeId ? <span className="tag ok">active</span> : null}
            </div>
            <div className="meta">{profile.model === '' ? profile.baseUrl : profile.model}</div>
          </div>
        ))}
        <button
          className="btn sm"
          style={{ marginTop: 6 }}
          onClick={() => {
            const profile = blankProfile(pick(language, '新しいプロファイル', 'New profile'));
            void (async () => {
              const saved = await run('profile', () => window.cc.profileUpsert(profile));
              if (saved !== null) select(profile.id);
            })();
          }}
          type="button"
        >
          <Plus size={13} /> {t('profileNew')}
        </button>
      </div>

      <div>
        {draft === null ? (
          <p className="empty">{t('profileEmpty')}</p>
        ) : (
          <>
            <Section
              title={draft.name}
              actions={
                <>
                  <button
                    className="btn sm"
                    onClick={() => {
                      if (envProblems.length > 0) {
                        setError(envProblems[0] ?? '');
                        return;
                      }
                      const copy: Profile = {
                        ...draft,
                        id: newId('p'),
                        name: `${draft.name} copy`,
                        extraEnv: parseEnvText(envText).env,
                      };
                      void (async () => {
                        const saved = await run('profile', () => window.cc.profileUpsert(copy));
                        if (saved === null) return;
                        if (secret !== null) await window.cc.secretSet(copy.id, secret);
                        select(copy.id);
                      })();
                    }}
                    type="button"
                  >
                    <Copy size={13} /> {t('profileDuplicate')}
                  </button>
                  <button className="btn danger sm" onClick={() => setConfirmDelete(true)} type="button">
                    <Trash2 size={13} /> {t('profileDelete')}
                  </button>
                </>
              }
            >
              {confirmDelete ? (
                <ConfirmBanner
                  message={t('profileDeleteConfirm')}
                  onConfirm={() => {
                    setConfirmDelete(false);
                    setChosenId(null);
                    setEdits(null);
                    setEnvEdit(null);
                    void run('profile', () => window.cc.profileDelete(draft.id));
                  }}
                  onCancel={() => setConfirmDelete(false)}
                />
              ) : null}

              <div className="grid2">
                <TextField
                  label={t('profileName')}
                  value={draft.name}
                  mono={false}
                  onChange={(value) => update({ name: value })}
                />
                <Field label={t('profilePreset')}>
                  <div className="inline-input">
                    <select value={matchedPreset?.id ?? 'custom'} onChange={(event) => applyPreset(event.target.value)}>
                      {ENDPOINT_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                          {preset.verified ? ' ✓' : ''}
                        </option>
                      ))}
                    </select>
                    {matchedPreset === undefined || matchedPreset.keysUrl === '' ? null : (
                      <button
                        className="btn sm"
                        onClick={() => void window.cc.openExternal(matchedPreset.keysUrl)}
                        type="button"
                      >
                        <ExternalLink size={12} /> {t('profileGetKey')}
                      </button>
                    )}
                  </div>
                  <span className="sub">
                    {matchedPreset === undefined
                      ? ''
                      : matchedPreset.verified
                        ? t('profileVerified')
                        : t('profileUnverified')}
                  </span>
                </Field>
              </div>

              <DeferredTextField
                label={t('profileBaseUrl')}
                value={draft.baseUrl}
                normalize={normalizeBaseUrl}
                onCommit={(value) => update({ baseUrl: value })}
                hint={
                  draft.baseUrl === '' ? 'ANTHROPIC_BASE_URL' : `ANTHROPIC_BASE_URL — ${draft.baseUrl}${MESSAGES_PATH}`
                }
                placeholder="https://openrouter.ai/api"
              />
              <p className="hint" style={{ marginTop: -4 }}>
                {t('profileBaseUrlNote')}
              </p>

              <div className="grid2">
                <Field label={t('profileAuthMode')}>
                  <select
                    value={draft.authMode}
                    onChange={(event) => update({ authMode: event.target.value as AuthMode })}
                  >
                    <option value="authToken">{t('profileAuthToken')}</option>
                    <option value="apiKey">{t('profileApiKey')}</option>
                  </select>
                  <span className="sub">
                    {pick(
                      language,
                      'Bearer 方式は承認プロンプトが出ないので既定です。',
                      'Bearer avoids the one-time approval prompt, so it is the default.',
                    )}
                  </span>
                </Field>
                <Field label={t('profileSecret')}>
                  <div className="inline-input">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      value={secret ?? ''}
                      spellCheck={false}
                      placeholder={t('profileSecretPlaceholder')}
                      onChange={(event) => {
                        if (effectiveId === null) return;
                        setSecretEdit({ id: effectiveId, value: event.target.value });
                      }}
                    />
                    <button
                      className="btn sm"
                      onClick={() => setShowSecret((current) => !current)}
                      type="button"
                      title={showSecret ? t('profileSecretHide') : t('profileSecretShow')}
                    >
                      {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                  <span className="sub">
                    {secretsEncrypted ? t('settingsSecretsEncrypted') : t('settingsSecretsPlain')}
                  </span>
                </Field>
              </div>
            </Section>

            <Section title={pick(language, 'モデル', 'Models')}>
              <TextField label={t('profileModel')} value={draft.model} onChange={(value) => update({ model: value })} />
              <div className="grid2">
                <TextField
                  label={t('profileSonnet')}
                  value={draft.sonnetModel}
                  onChange={(value) => update({ sonnetModel: value })}
                  hint="ANTHROPIC_DEFAULT_SONNET_MODEL"
                />
                <TextField
                  label={t('profileOpus')}
                  value={draft.opusModel}
                  onChange={(value) => update({ opusModel: value })}
                  hint="ANTHROPIC_DEFAULT_OPUS_MODEL"
                />
              </div>
              <div className="grid2">
                <TextField
                  label={t('profileHaiku')}
                  value={draft.haikuModel}
                  onChange={(value) => update({ haikuModel: value })}
                  hint="ANTHROPIC_DEFAULT_HAIKU_MODEL"
                />
                <TextField
                  label={t('profileFable')}
                  value={draft.fableModel}
                  onChange={(value) => update({ fableModel: value })}
                  hint="ANTHROPIC_DEFAULT_FABLE_MODEL"
                />
              </div>
            </Section>

            <Section title={pick(language, 'その他', 'Other')}>
              <NumberField
                label={t('profileTimeout')}
                hint="API_TIMEOUT_MS"
                value={draft.apiTimeoutMs}
                onChange={(apiTimeoutMs) => update({ apiTimeoutMs })}
              />
              <NumberField
                label={t('profileContextTokens')}
                hint="CLAUDE_CODE_MAX_CONTEXT_TOKENS"
                value={draft.contextTokens}
                onChange={(contextTokens) => update({ contextTokens })}
              />
              <Check
                label={t('profileNoNonEssential')}
                checked={draft.disableNonEssentialTraffic}
                onChange={(checked) => update({ disableNonEssentialTraffic: checked })}
              />
              <Check
                label={t('profileNoTelemetry')}
                checked={draft.disableTelemetry}
                onChange={(checked) => update({ disableTelemetry: checked })}
              />
              <Field label={t('profileExtraEnv')} hint={t('profileExtraEnvHint')}>
                <textarea
                  value={envText}
                  spellCheck={false}
                  rows={8}
                  placeholder={ENV_PLACEHOLDER}
                  onChange={(event) => {
                    if (effectiveId === null) return;
                    setEnvEdit({ id: effectiveId, value: event.target.value });
                  }}
                />
              </Field>
              {envProblems.map((problem) => (
                <p className="hint warn" key={problem}>
                  {problem}
                </p>
              ))}
              <TextField
                label={t('profileNote')}
                value={draft.note}
                mono={false}
                onChange={(value) => update({ note: value })}
              />
            </Section>

            <div className="row" style={{ marginBottom: 24 }}>
              <button
                className="btn"
                onClick={() => {
                  void (async () => {
                    const saved = await persist(false);
                    if (saved !== null) setToast(t('filesSaved'));
                  })();
                }}
                type="button"
              >
                <Save size={14} /> {t('profileSave')}
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  void (async () => {
                    const saved = await persist(true);
                    if (saved === null) return;
                    if (!containerRunning) {
                      setToast(saved.name);
                      return;
                    }
                    const summary = await run('provision', () => window.cc.containerProvision());
                    if (summary !== null) setToast(summary);
                  })();
                }}
                type="button"
              >
                <Upload size={14} /> {t('profileApply')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
