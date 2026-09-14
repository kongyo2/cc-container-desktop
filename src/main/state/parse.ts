import type { z } from 'zod';

import { AppFailure } from '../errors.ts';
import type { ParseOutcome } from './file.ts';

export function issueTexts(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

function firstIssue(error: z.ZodError): string {
  return issueTexts(error)[0] ?? 'invalid';
}

export function parseFailure(error: z.ZodError): ParseOutcome<never> {
  return { ok: false, problem: firstIssue(error) };
}

export function invalidInput(label: string, error: z.ZodError): AppFailure {
  return new AppFailure('INVALID_INPUT', `${label}: ${firstIssue(error)}`);
}

export function definedFields(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

export function duplicateId(items: readonly { readonly id: string }[]): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) return item.id;
    seen.add(item.id);
  }
  return null;
}
