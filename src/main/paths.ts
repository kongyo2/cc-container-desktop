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

export function userDockerDir(): string {
  return ensureDir(join(app.getPath('userData'), 'docker'));
}

export function dockerfilePath(): string {
  return join(userDockerDir(), 'Dockerfile');
}

export function postCreatePath(): string {
  return join(userDockerDir(), 'post-create.sh');
}

export function setupPath(): string {
  return join(userDockerDir(), 'setup.sh');
}

/**
 * True when `target` is `root` itself or sits under it. Both must already be
 * resolved: this is the containment test that keeps "reveal this folder" and
 * tar extraction from following a path back out of the directory they were
 * handed.
 */
export function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}
