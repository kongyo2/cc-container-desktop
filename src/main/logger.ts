import type { BrowserWindow } from 'electron';

import { EVENTS } from '../shared/ipc.ts';
import type { LogLine } from '../shared/types.ts';

let target: BrowserWindow | null = null;

const backlog: LogLine[] = [];
const BACKLOG_LIMIT = 500;

export function setLogTarget(window: BrowserWindow | null): void {
  target = window;
  if (window === null) return;
  for (const line of backlog) {
    window.webContents.send(EVENTS.log, line);
  }
}

export function log(stream: LogLine['stream'], level: LogLine['level'], text: string): void {
  const line: LogLine = { stream, level, text, at: Date.now() };
  backlog.push(line);
  if (backlog.length > BACKLOG_LIMIT) backlog.shift();

  const prefix = `[${stream}]`;
  if (level === 'error') console.error(prefix, text);
  else if (level === 'warn') console.warn(prefix, text);
  else console.log(prefix, text);

  if (target !== null && !target.isDestroyed()) {
    target.webContents.send(EVENTS.log, line);
  }
}

export function logInfo(stream: LogLine['stream'], text: string): void {
  log(stream, 'info', text);
}

export function logWarn(stream: LogLine['stream'], text: string): void {
  log(stream, 'warn', text);
}

export function logError(stream: LogLine['stream'], text: string): void {
  log(stream, 'error', text);
}

export function notifyStateChanged(): void {
  if (target !== null && !target.isDestroyed()) {
    target.webContents.send(EVENTS.stateChanged);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message !== error.message) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
