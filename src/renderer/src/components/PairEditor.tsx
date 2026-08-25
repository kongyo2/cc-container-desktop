import type { JSX } from 'react';

import { Field } from './ui.tsx';

export function parsePairs(text: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    pairs[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return pairs;
}

export function formatPairs(pairs: Readonly<Record<string, string>>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function PairEditor({
  label,
  hint,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  placeholder?: string;
  value: Readonly<Record<string, string>>;
  onChange: (pairs: Record<string, string>) => void;
}): JSX.Element {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      <textarea
        rows={3}
        spellCheck={false}
        placeholder={placeholder ?? 'KEY=VALUE'}
        defaultValue={formatPairs(value)}
        onBlur={(event) => onChange(parsePairs(event.target.value))}
      />
    </Field>
  );
}

export function ArgEditor({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: readonly string[];
  onChange: (args: string[]) => void;
}): JSX.Element {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      <textarea
        rows={3}
        spellCheck={false}
        placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/home/claude/workspace'}
        defaultValue={value.join('\n')}
        onBlur={(event) =>
          onChange(
            event.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line !== ''),
          )
        }
      />
    </Field>
  );
}
