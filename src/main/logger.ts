import type { BrowserWindow } from 'electron';

import { EVENTS } from '../shared/ipc.ts';
import type { LogLine } from '../shared/types.ts';
import { sendToWindow } from './window.ts';

export { describeError } from './errors.ts';

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

const AUTH_HEADER = /((?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)\s+)[^\s"']+/giu;

const CREDENTIAL_ASSIGNMENT =
  /((?:[A-Za-z0-9_-]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_-]*)\s*[=:]\s*)(["']?)[^\s"']+/giu;

export function redactSecrets(text: string): string {
  return text
    .replaceAll(USERINFO, '$1***@')
    .replaceAll(TOKEN_PARAM, '$1***')
    .replaceAll(AUTH_HEADER, '$1***')
    .replaceAll(CREDENTIAL_ASSIGNMENT, '$1$2***');
}
