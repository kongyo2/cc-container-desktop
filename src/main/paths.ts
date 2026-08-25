/**
 * Filesystem locations.
 *
 * The image sources ship with the app but are *edited* in `userData`, so the two
 * roles get two paths: {@link bundledDockerDir} is read-only reference material,
 * {@link userDockerDir} is what actually gets built.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

/** Where the pristine `Dockerfile` / `post-create.sh` live inside the installation. */
export function bundledDockerDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'docker') : join(app.getAppPath(), 'docker');
}

/** The build context the app actually uses; seeded from {@link bundledDockerDir} on first run. */
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
