import { createHash } from 'node:crypto';

import { environmentEnvEntries, normalizeScriptText } from '../../shared/environments.ts';
import type { Environment, Task } from '../../shared/types.ts';
import { environmentFor, getConfig } from '../config/store.ts';
import type { ContainerSpec } from '../docker/container.ts';

export function environmentRevision(environment: Environment | null): string {
  if (environment === null) return '';
  const payload = JSON.stringify([environmentEnvEntries(environment), normalizeScriptText(environment.setupScript)]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

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
