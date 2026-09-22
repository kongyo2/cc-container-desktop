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

function invalidInput(label: string, error: z.ZodError): AppFailure {
  return new AppFailure('INVALID_INPUT', `${label}: ${firstIssue(error)}`);
}

/** Reads a value the app was handed, rejecting it as bad input rather than as a broken store. */
export function parseInput<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalidInput(label, parsed.error);
  return parsed.data;
}

export function definedFields(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

export function duplicateIdProblem(items: readonly { readonly id: string }[], label: string): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) return `duplicate ${label} id ${item.id}`;
    seen.add(item.id);
  }
  return null;
}
