import { randomBytes } from 'node:crypto';

import type { Task } from '../../shared/types.ts';
import { AppFailure } from '../errors.ts';
import { statePath } from '../paths.ts';
import { StateFile } from '../state/file.ts';
import { readTaskFile } from './schema.ts';

const tasksFile = new StateFile<readonly Task[]>({
  path: () => statePath('tasks.json'),
  label: 'タスク一覧 (tasks.json) / the task list (tasks.json)',
  parse: readTaskFile,
  initial: () => [],
  serialize: (tasks) => ({ schemaVersion: 1, tasks }),
  persistInitial: false,
});

export function listTasks(): readonly Task[] {
  return tasksFile.get();
}

export function tasksStoreProblem(): string | null {
  return tasksFile.problem;
}

export function getTask(id: string): Task {
  const task = listTasks().find((candidate) => candidate.id === id);
  if (task === undefined) throw new AppFailure('INVALID_INPUT', `タスクが見つかりません / no such task: ${id}`);
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
    throw new AppFailure('INVALID_INPUT', `タスク ID が重複しています / duplicate task id: ${task.id}`);
  }
  tasksFile.set([...tasks, task]);
  return task;
}

export function updateTask(id: string, patch: Partial<Omit<Task, 'id'>>): Task {
  const tasks = listTasks();
  const index = tasks.findIndex((candidate) => candidate.id === id);
  const current = tasks[index];
  if (index === -1 || current === undefined) {
    throw new AppFailure('INVALID_INPUT', `タスクが見つかりません / no such task: ${id}`);
  }
  const next: Task = { ...current, ...patch, id };
  tasksFile.set(tasks.with(index, next));
  return next;
}

export function removeTask(id: string): void {
  const tasks = listTasks();
  if (!tasks.some((candidate) => candidate.id === id)) return;
  tasksFile.set(tasks.filter((candidate) => candidate.id !== id));
}

export function tasksAppliedTo(imageId: string): readonly Task[] {
  return listTasks().filter((task) => task.lastAppliedRuntime?.registeredImageId === imageId);
}
