import type { JSX } from 'react';
import { useState } from 'react';

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
  const [problems, setProblems] = useState<readonly string[]>([]);

  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      <textarea
        rows={3}
        spellCheck={false}
        placeholder={placeholder ?? 'KEY=VALUE'}
        defaultValue={formatEnvText(value)}
        onBlur={(event) => {
          const parsed = parseEnvText(event.target.value);
          setProblems(parsed.problems);
          if (parsed.problems.length === 0) onChange(parsed.env);
        }}
      />
      {problems.map((problem) => (
        <p className="hint warn" key={problem}>
          {problem}
        </p>
      ))}
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
