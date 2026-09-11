import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Task } from '../../shared/types.ts';
import { droppedEntriesNote, keptCopyNote, readJson, writeAtomic } from '../config/store.ts';
import { logError, logWarn } from '../logger.ts';
import { userDataDir } from '../paths.ts';
import { readTaskFile } from './schema.ts';

let cache: readonly Task[] | null = null;

function tasksPath(): string {
  return join(userDataDir(), 'tasks.json');
}

export function listTasks(): readonly Task[] {
  if (cache !== null) return cache;
  const path = tasksPath();
  const raw = readJson(path);
  if (raw === null) {
    if (existsSync(path)) {
      logError('app', `タスク一覧を読めませんでした / the task list is unreadable${keptCopyNote(path)}`);
    }
    cache = [];
    return cache;
  }
  const result = readTaskFile(raw);
  if (result.reset) {
    logError('app', `タスク一覧を読めませんでした / the task list could not be read${keptCopyNote(path)}`);
  } else if (result.dropped > 0) {
    logWarn('app', droppedEntriesNote(result.dropped, 'タスク一覧', 'task', path));
  }
  cache = result.tasks;
  return cache;
}

function persist(tasks: readonly Task[]): void {
  writeAtomic(tasksPath(), `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`);
  cache = tasks;
}

export function getTask(id: string): Task {
  const task = listTasks().find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`タスクが見つかりません / no such task: ${id}`);
  return task;
}

export function newTaskId(): string {
  const taken = new Set(listTasks().map((task) => task.id));
  for (;;) {
    const id = randomBytes(5).toString('hex');
    if (!taken.has(id)) return id;
  }
}

export function addTask(task: Task): Task {
  const tasks = listTasks();
  if (tasks.some((candidate) => candidate.id === task.id)) {
    throw new Error(`タスク ID が重複しています / duplicate task id: ${task.id}`);
  }
  persist([...tasks, task]);
  return task;
}

export function updateTask(id: string, patch: Partial<Omit<Task, 'id'>>): Task {
  const tasks = listTasks();
  const index = tasks.findIndex((candidate) => candidate.id === id);
  if (index === -1) throw new Error(`タスクが見つかりません / no such task: ${id}`);
  const next: Task = { ...tasks[index]!, ...patch, id };
  persist(tasks.with(index, next));
  return next;
}

export function removeTask(id: string): void {
  const tasks = listTasks();
  if (!tasks.some((candidate) => candidate.id === id)) return;
  persist(tasks.filter((candidate) => candidate.id !== id));
}
