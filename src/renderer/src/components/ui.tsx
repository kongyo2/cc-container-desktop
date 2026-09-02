import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

import { useT } from '../i18n.ts';

export type Tone = 'ok' | 'warn' | 'err' | 'idle';

export function hintProps(hint: string | undefined): { hint?: string } {
  return hint === undefined ? {} : { hint };
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }): JSX.Element {
  const lamp = tone === 'ok' ? 'live' : tone === 'warn' ? 'hold' : tone === 'err' ? 'fault' : 'off';
  return (
    <span className={`session lamp-${lamp}`}>
      <span className="lamp" />
      {children}
    </span>
  );
}

export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="section">
      <header>
        <h2>{title}</h2>
        <span className="spacer" />
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint === undefined ? null : <span className="sub">{hint}</span>}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  type = 'text',
  mono = true,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  type?: 'text' | 'password';
  mono?: boolean;
}): JSX.Element {
  return (
    <Field label={label} {...hintProps(hint)}>
      <input
        type={type}
        value={value}
        placeholder={placeholder ?? ''}
        style={mono ? undefined : { fontFamily: 'var(--sans)' }}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

export function DeferredTextField({
  label,
  value,
  onCommit,
  normalize,
  hint,
  placeholder,
  type = 'text',
  mono = true,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  normalize?: (value: string) => string;
  hint?: string;
  placeholder?: string;
  type?: 'text' | 'password';
  mono?: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const shown = draft !== null && draft.base === value ? draft.text : value;

  const commit = (): void => {
    setDraft(null);
    const next = normalize === undefined ? shown : normalize(shown);
    if (next !== value) onCommit(next);
  };

  return (
    <Field label={label} {...hintProps(hint)}>
      <input
        type={type}
        value={shown}
        placeholder={placeholder ?? ''}
        spellCheck={false}
        style={mono ? undefined : { fontFamily: 'var(--sans)' }}
        onChange={(event) => setDraft({ base: value, text: event.target.value })}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') setDraft(null);
        }}
      />
    </Field>
  );
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | null;
  onChange: (value: number | null) => void;
}): JSX.Element {
  const t = useT();
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={1000}
        value={value ?? ''}
        placeholder={t('commonUnset')}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          onChange(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
        }}
      />
    </Field>
  );
}

export function Banner({
  kind,
  children,
  onDismiss,
}: {
  kind: 'error' | 'info';
  children: ReactNode;
  onDismiss?: () => void;
}): JSX.Element {
  return (
    <div className={`banner ${kind}`}>
      <span>{children}</span>
      <span className="spacer" />
      {onDismiss === undefined ? null : (
        <button className="btn ghost sm" onClick={onDismiss} type="button">
          ×
        </button>
      )}
    </div>
  );
}

export function ConfirmBanner({
  message,
  onConfirm,
  onCancel,
  spaced = false,
}: {
  message: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  spaced?: boolean;
}): JSX.Element {
  const t = useT();
  return (
    <div className="banner error" style={spaced ? { marginTop: 12 } : undefined}>
      <span>{message}</span>
      <span className="spacer" />
      <button className="btn danger sm" onClick={onConfirm} type="button">
        {t('commonYes')}
      </button>
      <button className="btn sm" onClick={onCancel} type="button">
        {t('commonCancel')}
      </button>
    </div>
  );
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}

export function formatTime(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}
