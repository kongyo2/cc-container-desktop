import { z } from 'zod';

import { REGISTERED_IMAGE_ID_PATTERN } from '../../shared/images.ts';
import { TASK_ID_PATTERN } from '../../shared/tasks.ts';
import type { NewTaskInput, Task, TaskPatch } from '../../shared/types.ts';
import { AppFailure } from '../errors.ts';
import type { ParseOutcome } from '../state/file.ts';

const managedSchema = z.strictObject({
  mcpServers: z.array(z.string()),
  marketplaces: z.array(z.string()),
  plugins: z.array(z.string()),
});

const sourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('empty') }),
  z.strictObject({ kind: z.literal('git'), url: z.string(), ref: z.string() }),
]);

const appliedRuntimeSchema = z.strictObject({
  registeredImageId: z.string().regex(REGISTERED_IMAGE_ID_PATTERN),
  localImageId: z.string().min(1),
  engineId: z.string().min(1),
  environmentId: z.string().min(1),
  environmentRevision: z.string(),
  appliedAt: z.string().datetime({ offset: true }),
});

const taskSchema = z.strictObject({
  id: z.string().regex(TASK_ID_PATTERN),
  name: z.string().min(1),
  note: z.string(),
  profileId: z.string().nullable(),
  environmentId: z.string().min(1),
  source: sourceSchema,
  containerName: z.string().min(1),
  volumeName: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  managed: managedSchema,
  lastAppliedRuntime: appliedRuntimeSchema.nullable(),
});

const taskFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tasks: z.array(taskSchema),
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? 'invalid' : `${issue.path.join('.') || '(root)'}: ${issue.message}`;
}

export function readTaskFile(raw: unknown): ParseOutcome<readonly Task[]> {
  const parsed = taskFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: firstIssue(parsed.error) };
  const seen = new Set<string>();
  for (const task of parsed.data.tasks) {
    if (seen.has(task.id)) return { ok: false, problem: `duplicate task id ${task.id}` };
    seen.add(task.id);
  }
  return { ok: true, value: parsed.data.tasks };
}

const newTaskInputSchema = z.strictObject({
  name: z.string(),
  note: z.string(),
  profileId: z.string().nullable(),
  environmentId: z.string(),
  source: sourceSchema,
});

export function parseNewTaskInput(raw: unknown): NewTaskInput {
  const parsed = newTaskInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppFailure('INVALID_INPUT', `タスクの内容が不正です / invalid task input: ${firstIssue(parsed.error)}`);
  }
  return parsed.data;
}

const taskPatchSchema = z.strictObject({
  name: z.string().optional(),
  note: z.string().optional(),
  profileId: z.string().nullable().optional(),
  environmentId: z.string().min(1).optional(),
});

export function parseTaskPatch(raw: unknown): TaskPatch {
  const parsed = taskPatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppFailure(
      'INVALID_INPUT',
      `タスクの変更内容が不正です / invalid task patch: ${firstIssue(parsed.error)}`,
    );
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) patch[key] = value;
  }
  return patch as TaskPatch;
}
