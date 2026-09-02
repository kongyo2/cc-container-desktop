import type { JSX, ReactNode } from 'react';
import { useState } from 'react';

import { formatEnvText, parseEnvText } from '../../../shared/env.ts';
import { Field, hintProps } from './ui.tsx';

/**
 * A textarea the user edits freely and that only reports back on blur, so a
 * half-typed line is never parsed. `children` is for whatever the caller wants
 * to show underneath — parse problems, usually.
 */
function TextAreaField({
  label,
  hint,
  placeholder,
  defaultValue,
  onCommit,
  children,
}: {
  label: string;
  hint?: string;
  placeholder: string;
  defaultValue: string;
  onCommit: (text: string) => void;
  children?: ReactNode;
}): JSX.Element {
  return (
    <Field label={label} {...hintProps(hint)}>
      <textarea
        rows={3}
        spellCheck={false}
        placeholder={placeholder}
        defaultValue={defaultValue}
        onBlur={(event) => onCommit(event.target.value)}
      />
      {children}
    </Field>
  );
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
  const [problems, setProblems] = useState<readonly string[]>([]);

  return (
    <TextAreaField
      label={label}
      {...hintProps(hint)}
      placeholder={placeholder ?? 'KEY=VALUE'}
      defaultValue={formatEnvText(value)}
      onCommit={(text) => {
        const parsed = parseEnvText(text);
        setProblems(parsed.problems);
        if (parsed.problems.length === 0) onChange(parsed.env);
      }}
    >
      {problems.map((problem) => (
        <p className="hint warn" key={problem}>
          {problem}
        </p>
      ))}
    </TextAreaField>
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
    <TextAreaField
      label={label}
      {...hintProps(hint)}
      placeholder={placeholder ?? '-y\n@modelcontextprotocol/server-filesystem\n/home/claude/workspace'}
      defaultValue={value.join('\n')}
      onCommit={(text) =>
        onChange(
          text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== ''),
        )
      }
    />
  );
}
