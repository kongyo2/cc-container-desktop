import type { JSX } from 'react';

import { formatEnvText, parseEnvText } from '../../../shared/env.ts';
import { Field } from './ui.tsx';

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
        defaultValue={formatEnvText(value)}
        onBlur={(event) => onChange(parseEnvText(event.target.value).env)}
      />
    </Field>
  );
}

export function ArgEditor({
  label,
  hint,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  placeholder?: string;
  value: readonly string[];
  onChange: (args: string[]) => void;
}): JSX.Element {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      <textarea
        rows={3}
        spellCheck={false}
        placeholder={placeholder ?? '-y\n@modelcontextprotocol/server-filesystem\n/home/claude/workspace'}
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
