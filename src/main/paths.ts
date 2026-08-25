import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

export function bundledDockerDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'docker') : join(app.getAppPath(), 'docker');
}

export function userDockerDir(): string {
  const dir = join(app.getPath('userData'), 'docker');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
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
