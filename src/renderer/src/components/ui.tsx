import { X } from 'lucide-react';
import type { ChangeEvent, JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { useT } from '../i18n.ts';

export type Tone = 'ok' | 'warn' | 'err' | 'idle';

export function hintProps(hint: string | undefined): { hint?: string } {
  return hint === undefined ? {} : { hint };
}

interface DraftInputProps {
  readonly value: string;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onBlur: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}

/**
 * Holds what the user is typing without pushing every keystroke upstream: the field commits on
 * blur or Enter, drops the draft on Escape, and snaps back whenever the upstream value changes.
 */
export function useDraftInput(value: string, commit: (typed: string) => void): DraftInputProps {
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const shown = draft !== null && draft.base === value ? draft.text : value;

  return {
    value: shown,
    onChange: (event) => setDraft({ base: value, text: event.target.value }),
    onBlur: () => {
      setDraft(null);
      commit(shown);
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') setDraft(null);
    },
  };
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
  const draft = useDraftInput(value, (typed) => {
    const next = normalize === undefined ? typed : normalize(typed);
    if (next !== value) onCommit(next);
  });

  return (
    <Field label={label} {...hintProps(hint)}>
      <input
        type={type}
        placeholder={placeholder ?? ''}
        spellCheck={false}
        style={mono ? undefined : { fontFamily: 'var(--sans)' }}
        {...draft}
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

export function ModalShell({
  variant,
  titleId,
  testId,
  title,
  footer,
  onClose,
  children,
}: {
  variant: string;
  titleId: string;
  testId: string;
  title: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const t = useT();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onBackdrop}>
      <div
        className={`modal ${variant}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
      >
        <header className="modal-head">
          <h1 id={titleId}>{title}</h1>
          <button className="modal-x" type="button" onClick={onClose} aria-label={t('commonClose')}>
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-foot">{footer}</footer>
      </div>
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
