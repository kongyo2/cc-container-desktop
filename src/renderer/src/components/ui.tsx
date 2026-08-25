/** Small presentational primitives shared by every panel. */

import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

export type Tone = 'ok' | 'warn' | 'err' | 'idle';

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }): JSX.Element {
  return (
    <span className={`pill ${tone === 'idle' ? '' : tone}`}>
      <span className="dot" />
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
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
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

/**
 * A text field that reports its value when you leave it, not on every keystroke.
 *
 * Use this wherever a change costs an IPC round trip or gets rewritten on the
 * way in. `TextField` writes straight through, so a handler that persists and
 * then re-reads the value races the typist and eats characters, and a
 * `normalize` that trims trailing separators would delete each `/` as it is
 * typed. Here the draft is local until blur or Enter.
 *
 * The draft is tagged with the prop value it was forked from: when that prop
 * changes underneath (another pane saved, a profile was switched), the tag stops
 * matching and the field shows the new truth instead of a stale edit.
 */
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
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
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
