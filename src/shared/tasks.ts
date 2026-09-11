import type { Language, WorkspaceSource } from './types.ts';

const MAX_TASK_NAME = 64;

export const TASK_ID_PATTERN: RegExp = /^[a-z0-9]{6,32}$/u;

export function normalizeTaskName(name: string): string {
  return name
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_TASK_NAME);
}

export function exportFolderName(taskName: string): string {
  const cleaned = normalizeTaskName(taskName)
    .replaceAll(/[<>:"/\\|?*]/gu, '-')
    .replaceAll(/\s/gu, '_')
    .replaceAll(/^[.-]+|[. ]+$/gu, '');
  return cleaned === '' ? 'task' : cleaned;
}

export function taskNameProblem(name: string, language: Language): string | null {
  if (normalizeTaskName(name) === '') {
    return language === 'ja' ? 'タスク名を入力してください。' : 'Enter a task name.';
  }
  return null;
}

export function describeSource(source: WorkspaceSource, language: Language): string {
  if (source.kind === 'empty') return language === 'ja' ? '空のワークスペース' : 'empty workspace';
  return source.ref === '' ? source.url : `${source.url} @ ${source.ref}`;
}
