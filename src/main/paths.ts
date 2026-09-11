import { existsSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';

import { app } from 'electron';

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function bundledDockerDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'docker') : join(app.getAppPath(), 'docker');
}

export function userDataDir(): string {
  return ensureDir(app.getPath('userData'));
}

export function brokenCopyPath(path: string): string {
  return `${path}.broken-${Date.now().toString(36)}`;
}

export function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}
