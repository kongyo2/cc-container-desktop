import { createHash } from 'node:crypto';

import { environmentEnvEntries, normalizeScriptText } from '../../shared/environments.ts';
import { imageDisplayName } from '../../shared/images.ts';
import type { ImageAvailability, ImagePlatform } from '../../shared/images.ts';
import type { Environment, Task } from '../../shared/types.ts';
import { environmentFor } from '../config/store.ts';
import type { ContainerSpec } from '../docker/container.ts';
import { probeDocker } from '../docker/engine.ts';
import { AppFailure } from '../errors.ts';
import { imageAvailability } from '../images/service.ts';
import { registeredImageFor } from '../images/store.ts';

export function environmentRevision(environment: Environment | null): string {
  if (environment === null) return '';
  const payload = JSON.stringify([environmentEnvEntries(environment), normalizeScriptText(environment.setupScript)]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function taskEnvironment(task: Task): Environment | null {
  return environmentFor(task.environmentId);
}

function requireTaskEnvironment(task: Task): Environment {
  const environment = taskEnvironment(task);
  if (environment === null) {
    throw new AppFailure(
      'ENVIRONMENT_MISSING',
      `タスク "${task.name}" の環境が見つかりません / the environment of task "${task.name}" no longer exists: ${task.environmentId}`,
    );
  }
  return environment;
}

export interface ResolvedTaskRuntime {
  readonly registeredImageId: string;
  readonly localImageId: string;
  readonly platform: ImagePlatform;
  readonly engineId: string;
  readonly environmentId: string;
  readonly environmentRevision: string;
  readonly spec: ContainerSpec;
}

function describeUnavailable(availability: ImageAvailability): string {
  switch (availability.kind) {
    case 'ready':
      return '';
    case 'missing':
      return 'イメージがローカルにありません。「イメージ」で再ダウンロードしてください / the image is not present locally; re-download it on the Images page';
    case 'unavailable':
      return `Docker に接続できません / Docker is unreachable: ${availability.message}`;
    case 'incompatible':
      return `この Docker では使えません / not usable on this Docker: ${availability.message}`;
    case 'error':
      return `イメージを確認できません / the image could not be checked: ${availability.message}`;
  }
}

async function resolveImage(
  registeredImageId: string,
  environment: Environment,
  label: string,
): Promise<{ readonly localImageId: string; readonly platform: ImagePlatform; readonly engineId: string }> {
  const image = registeredImageFor(registeredImageId);
  if (image === null) {
    throw new AppFailure(
      'IMAGE_NOT_REGISTERED',
      `環境 "${environment.name}" のイメージ (${label}) は登録されていません。「イメージ」で登録し直してください / the image of environment "${environment.name}" (${label}) is not registered; register it again on the Images page`,
    );
  }
  const docker = await probeDocker();
  if (!docker.available) {
    throw new AppFailure(
      'DOCKER_UNAVAILABLE',
      `Docker に接続できません。Docker Desktop を起動してください / Docker is unreachable; start Docker Desktop (${docker.error ?? ''})`,
      { retryable: true },
    );
  }
  const availability = await imageAvailability(image, docker);
  if (availability.kind !== 'ready') {
    throw new AppFailure(
      'IMAGE_UNAVAILABLE',
      `環境 "${environment.name}" のイメージ ${imageDisplayName(image, 'ja')}: ${describeUnavailable(availability)}`,
    );
  }
  return { localImageId: availability.localImageId, platform: image.platform, engineId: docker.engineId ?? '' };
}

export async function resolveTaskRuntime(
  task: Task,
  options: { readonly allowLastApplied?: boolean } = {},
): Promise<ResolvedTaskRuntime> {
  const environment = requireTaskEnvironment(task);
  let registeredImageId = environment.imageId;
  let resolved: { readonly localImageId: string; readonly platform: ImagePlatform; readonly engineId: string };
  try {
    resolved = await resolveImage(registeredImageId, environment, environment.imageId);
  } catch (error) {
    const fallback = task.lastAppliedRuntime;
    if (options.allowLastApplied !== true || fallback === null || fallback.registeredImageId === registeredImageId) {
      throw error;
    }
    registeredImageId = fallback.registeredImageId;
    resolved = await resolveImage(
      registeredImageId,
      environment,
      `${fallback.registeredImageId} (前回適用 / last applied)`,
    );
  }
  const image = registeredImageFor(registeredImageId);
  if (image === null) throw new AppFailure('IMAGE_NOT_REGISTERED', registeredImageId);
  const revision = environmentRevision(environment);
  return {
    registeredImageId,
    localImageId: resolved.localImageId,
    platform: resolved.platform,
    engineId: resolved.engineId,
    environmentId: environment.id,
    environmentRevision: revision,
    spec: {
      localImageId: resolved.localImageId,
      registeredImageId,
      pinnedDigest: image.pinnedDigest,
      env: environmentEnvEntries(environment),
      environmentId: environment.id,
      environmentRevision: revision,
    },
  };
}
