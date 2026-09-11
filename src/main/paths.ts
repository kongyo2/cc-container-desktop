import { existsSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';

import { app } from 'electron';

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function userDataDir(): string {
  return ensureDir(app.getPath('userData'));
}

const STATE_DIR_NAME = 'state-v1';

export function stateDir(): string {
  return ensureDir(join(userDataDir(), STATE_DIR_NAME));
}

export function statePath(fileName: string): string {
  return join(stateDir(), fileName);
}

export function brokenCopyPath(path: string): string {
  return `${path}.broken-${Date.now().toString(36)}`;
}

export function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export function isDevelopment(): boolean {
  return !app.isPackaged;
}
