import type { BrowserWindow } from 'electron';

import { EVENTS } from '../shared/ipc.ts';
import type { LogLine } from '../shared/types.ts';
import { sendToWindow } from './window.ts';

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

  sendToWindow(target, EVENTS.log, line);
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
  sendToWindow(target, EVENTS.stateChanged);
}

const USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@/gu;

const TOKEN_PARAM = /([?&](?:token|access_token|api_key|apikey|key|password)=)[^&\s]+/giu;

/** Blanks credentials embedded in URLs before a line reaches the log. */
export function redactSecrets(text: string): string {
  return text.replaceAll(USERINFO, '$1***@').replaceAll(TOKEN_PARAM, '$1***');
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
