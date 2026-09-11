import Docker from 'dockerode';

import { platformFromDaemon } from '../../shared/images.ts';
import type { ImagePlatform } from '../../shared/images.ts';
import type { DockerStatus } from '../../shared/types.ts';
import { AppFailure, classifyDockerError, describeError, isNotFound } from '../errors.ts';

export { isNotFound } from '../errors.ts';

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
  readonly Arch?: string;
}

interface InfoResponse {
  readonly ID?: string;
  readonly Name?: string;
  readonly OSType?: string;
  readonly Architecture?: string;
  readonly ServerVersion?: string;
}

export interface DaemonInfo {
  readonly engineId: string;
  readonly name: string | null;
  readonly osType: string;
  readonly architecture: string;
  readonly platform: ImagePlatform | null;
  readonly serverVersion: string | null;
}

export async function daemonInfo(): Promise<DaemonInfo> {
  let raw: InfoResponse;
  try {
    raw = (await docker().info()) as InfoResponse;
  } catch (error) {
    throw classifyDockerError(error, 'connect');
  }
  const osType = raw.OSType ?? '';
  const architecture = raw.Architecture ?? '';
  if (typeof raw.ID !== 'string' || raw.ID === '') {
    throw new AppFailure('DOCKER_ERROR', 'Docker デーモンの ID を取得できません / the Docker daemon reported no ID', {
      retryable: true,
    });
  }
  return {
    engineId: raw.ID,
    name: raw.Name ?? null,
    osType,
    architecture,
    platform: platformFromDaemon(osType, architecture),
    serverVersion: raw.ServerVersion ?? null,
  };
}

export async function requireLinuxDaemon(): Promise<DaemonInfo & { readonly platform: ImagePlatform }> {
  const info = await daemonInfo();
  if (info.osType.toLowerCase() !== 'linux') {
    throw new AppFailure(
      'LINUX_CONTAINERS_REQUIRED',
      `Docker は ${info.osType} コンテナモードです。Docker Desktop を Linux コンテナに切り替えてください / Docker is in ${info.osType} container mode; switch Docker Desktop to Linux containers`,
    );
  }
  if (info.platform === null) {
    throw new AppFailure(
      'UNSUPPORTED_PLATFORM',
      `この Docker デーモン (${info.osType}/${info.architecture}) 向けのイメージは配布されていません / no image is published for this Docker daemon (${info.osType}/${info.architecture})`,
    );
  }
  return { ...info, platform: info.platform };
}

export async function probeDocker(): Promise<DockerStatus> {
  try {
    const [version, info] = await Promise.all([
      docker().version() as Promise<VersionResponse>,
      docker().info() as Promise<InfoResponse>,
    ]);
    const osType = info.OSType ?? version.Os ?? null;
    const architecture = info.Architecture ?? version.Arch ?? null;
    return {
      available: true,
      version: version.Version ?? info.ServerVersion ?? null,
      apiVersion: version.ApiVersion ?? null,
      os: osType,
      architecture,
      platform: platformFromDaemon(osType, architecture),
      engineId: info.ID ?? null,
      name: info.Name ?? null,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      apiVersion: null,
      os: null,
      architecture: null,
      platform: null,
      engineId: null,
      name: null,
      error: describeError(error),
    };
  }
}

interface ImageInspectResponse {
  readonly Id?: string;
  readonly RepoTags?: readonly string[] | null;
  readonly RepoDigests?: readonly string[] | null;
  readonly Created?: string;
  readonly Size?: number;
  readonly Os?: string;
  readonly Architecture?: string;
  readonly Config?: {
    readonly User?: string;
    readonly WorkingDir?: string;
    readonly Labels?: Record<string, string> | null;
    readonly Env?: readonly string[] | null;
  };
}

export interface ImageInspect {
  readonly id: string;
  readonly repoTags: readonly string[];
  readonly repoDigests: readonly string[];
  readonly createdAt: string | null;
  readonly sizeBytes: number;
  readonly os: string | null;
  readonly architecture: string | null;
  readonly user: string | null;
  readonly workingDir: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly env: readonly string[];
}

function toImageInspect(raw: ImageInspectResponse): ImageInspect {
  if (typeof raw.Id !== 'string' || raw.Id === '') {
    throw new AppFailure('DOCKER_ERROR', 'イメージの ID を取得できません / the image inspect carried no ID', {
      retryable: true,
    });
  }
  return {
    id: raw.Id,
    repoTags: raw.RepoTags ?? [],
    repoDigests: raw.RepoDigests ?? [],
    createdAt: raw.Created ?? null,
    sizeBytes: typeof raw.Size === 'number' ? raw.Size : 0,
    os: raw.Os ?? null,
    architecture: raw.Architecture ?? null,
    user: raw.Config?.User ?? null,
    workingDir: raw.Config?.WorkingDir ?? null,
    labels: raw.Config?.Labels ?? {},
    env: raw.Config?.Env ?? [],
  };
}

/** Inspects an image by reference or ID. Returns null when it does not exist locally; other failures throw classified. */
export async function inspectImage(reference: string): Promise<ImageInspect | null> {
  try {
    return toImageInspect((await docker().getImage(reference).inspect()) as ImageInspectResponse);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw classifyDockerError(error, 'inspect');
  }
}

export async function pingDaemon(): Promise<boolean> {
  try {
    await docker().ping();
    return true;
  } catch {
    return false;
  }
}

export interface ContainerSummary {
  readonly id: string;
  readonly names: readonly string[];
  readonly state: string;
  readonly imageId: string;
  readonly labels: Readonly<Record<string, string>>;
}

interface ContainerListEntry {
  readonly Id?: string;
  readonly Names?: readonly string[];
  readonly State?: string;
  readonly ImageID?: string;
  readonly Labels?: Record<string, string> | null;
}

export async function listContainersByLabels(labels: readonly string[]): Promise<readonly ContainerSummary[]> {
  let raw: readonly ContainerListEntry[];
  try {
    raw = (await docker().listContainers({ all: true, filters: { label: [...labels] } })) as ContainerListEntry[];
  } catch (error) {
    throw classifyDockerError(error, 'inspect');
  }
  return raw
    .filter((entry) => typeof entry.Id === 'string')
    .map((entry) => ({
      id: entry.Id ?? '',
      names: entry.Names ?? [],
      state: entry.State ?? 'unknown',
      imageId: entry.ImageID ?? '',
      labels: entry.Labels ?? {},
    }));
}
