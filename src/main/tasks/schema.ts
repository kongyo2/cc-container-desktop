import { z } from 'zod';

import { TASK_ID_PATTERN } from '../../shared/tasks.ts';
import type { Task } from '../../shared/types.ts';
import { keepValid } from '../config/schema.ts';

const managedSchema = z.object({
  mcpServers: z.array(z.string()).default([]),
  marketplaces: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
});

const sourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }),
  z.object({ kind: z.literal('git'), url: z.string().default(''), ref: z.string().default('') }),
]);

const taskSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  name: z.string().min(1),
  note: z.string().default(''),
  profileId: z.string().nullable().default(null),
  source: sourceSchema.default({ kind: 'empty' }),
  containerName: z.string().min(1),
  volumeName: z.string().min(1),
  createdAt: z.string().default(''),
  managed: managedSchema.default({ mcpServers: [], marketplaces: [], plugins: [] }),
});

const taskFileSchema = z.object({
  version: z.literal(1).catch(1).default(1),
  tasks: z.array(taskSchema).default([]),
});

export interface TaskFileRead {
  readonly tasks: readonly Task[];
  readonly dropped: number;
  readonly reset: boolean;
}

export function readTaskFile(raw: unknown): TaskFileRead {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { tasks: [], dropped: 0, reset: raw !== null };
  }
  const report = { dropped: 0 };
  const source: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  source['tasks'] = keepValid(taskSchema, source['tasks'], report);
  const parsed = taskFileSchema.safeParse(source);
  if (!parsed.success) return { tasks: [], dropped: report.dropped, reset: true };

  const seen = new Set<string>();
  const tasks: Task[] = [];
  for (const task of parsed.data.tasks) {
    if (seen.has(task.id)) {
      report.dropped += 1;
      continue;
    }
    seen.add(task.id);
    tasks.push(task);
  }
  return { tasks, dropped: report.dropped, reset: false };
}
