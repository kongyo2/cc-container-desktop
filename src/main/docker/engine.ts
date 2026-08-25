import Docker from 'dockerode';

import type { DockerStatus, ImageStatus } from '../../shared/types.ts';
import { describeError } from '../logger.ts';

let client: Docker | null = null;

export function docker(): Docker {
  if (client !== null) return client;

  const host = process.env['DOCKER_HOST'];
  if (host === undefined || host === '') {
    client = process.platform === 'win32' ? new Docker({ socketPath: '//./pipe/docker_engine' }) : new Docker();
  } else {
    client = new Docker();
  }
  return client;
}

interface VersionResponse {
  readonly Version?: string;
  readonly ApiVersion?: string;
  readonly Os?: string;
}

export async function probeDocker(): Promise<DockerStatus> {
  try {
    const raw = (await docker().version()) as VersionResponse;
    return {
      available: true,
      version: raw.Version ?? null,
      apiVersion: raw.ApiVersion ?? null,
      os: raw.Os ?? null,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      apiVersion: null,
      os: null,
      error: describeError(error),
    };
  }
}

interface ImageInspectResponse {
  readonly Id?: string;
  readonly Created?: string;
  readonly Size?: number;
}

export async function inspectImage(tag: string): Promise<ImageStatus> {
  try {
    const raw = (await docker().getImage(tag).inspect()) as ImageInspectResponse;
    return {
      tag,
      exists: true,
      id: raw.Id ?? null,
      createdAt: raw.Created ?? null,
      sizeBytes: raw.Size ?? null,
    };
  } catch {
    return { tag, exists: false, id: null, createdAt: null, sizeBytes: null };
  }
}

export function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { statusCode?: unknown }).statusCode;
  return status === 404;
}
