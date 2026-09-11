import { createHash } from 'node:crypto';

import { environmentEnvEntries, normalizeScriptText } from '../../shared/environments.ts';
import type { Environment, Task } from '../../shared/types.ts';
import { environmentFor, getConfig } from '../config/store.ts';
import type { ContainerSpec } from '../docker/container.ts';

/**
 * A short digest of what the environment contributes to a container: the
 * parsed variables and the setup script. Comments and ordering in the .env
 * text do not change it, so touching those never flags a task as stale.
 */
export function environmentRevision(environment: Environment | null): string {
  if (environment === null) return '';
  const payload = JSON.stringify([environmentEnvEntries(environment), normalizeScriptText(environment.setupScript)]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/** The environment a task points at, or null when it has none or it was removed. */
export function taskEnvironment(task: Task): Environment | null {
  return environmentFor(task.environmentId);
}

export function containerSpecFor(task: Task): ContainerSpec {
  const environment = taskEnvironment(task);
  return {
    imageTag: getConfig().imageTag,
    env: environmentEnvEntries(environment),
    environmentId: task.environmentId ?? '',
    environmentRevision: environmentRevision(environment),
  };
}
