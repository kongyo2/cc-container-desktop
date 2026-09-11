import { readFileSync } from 'node:fs';

import {
  catalogPlatform,
  entryById,
  imageDisplayName,
  imageReference,
  isTerminalPhase,
  normalizeRepository,
  parseImageReference,
  registrationIdentity,
} from '../../shared/images.ts';
import type {
  CatalogTool,
  ImageAvailability,
  ImageCatalog,
  ImageCatalogEntry,
  ImageOperation,
  ImageOperationKind,
  ImageOperationTarget,
  ImagePlatform,
  ImageVariant,
  LocalizedText,
  RegisteredImage,
  RegisteredImageView,
} from '../../shared/images.ts';
import type { ImageCustomRequest } from '../../shared/ipc.ts';
import { INSTANCE_LABEL, MANAGED_LABEL, REGISTERED_IMAGE_LABEL, ROLE_LABEL } from '../../shared/presets.ts';
import type { DockerStatus } from '../../shared/types.ts';
import { dataInstanceId, environmentsUsingImage } from '../config/store.ts';
import { inspectImage, listContainersByLabels, requireLinuxDaemon } from '../docker/engine.ts';
import type { DaemonInfo, ImageInspect } from '../docker/engine.ts';
import { pullImage } from '../docker/pull.ts';
import { AppFailure, describeError } from '../errors.ts';
import { logInfo, logWarn, notifyStateChanged } from '../logger.ts';
import { isDevelopment } from '../paths.ts';
import { tasksAppliedTo } from '../tasks/store.ts';
import { bundledImageCatalog } from './bundled.ts';
import { CatalogInvalidError, parseCatalog } from './catalog.ts';
import { registeredImageIdFor } from './ledger.ts';
import {
  activeOperationFor,
  activeOperations,
  enqueueOperation,
  markSucceeded,
  newOperationId,
  requestCancel,
} from './operations.ts';
import type { OperationContext } from './operations.ts';
import { commitRegistration, dropRegistration, listRegisteredImages, registeredImageFor } from './store.ts';

let catalogCache: { readonly catalog: ImageCatalog; readonly problem: string | null } | null = null;

const EMPTY_CATALOG: ImageCatalog = {
  schemaVersion: 1,
  generatedAt: '1970-01-01T00:00:00.000Z',
  repository: '',
  entries: [],
};

export function activeCatalog(): { readonly catalog: ImageCatalog; readonly problem: string | null } {
  if (catalogCache !== null) return catalogCache;
  const override = process.env['CC_IMAGE_CATALOG_FILE'];
  try {
    if (override !== undefined && override.trim() !== '' && isDevelopment()) {
      const raw = JSON.parse(readFileSync(override, 'utf8')) as unknown;
      catalogCache = { catalog: parseCatalog(raw), problem: null };
      logWarn('image', `開発用のカタログを使います / using the development catalog override at ${override}`);
    } else {
      catalogCache = { catalog: bundledImageCatalog(), problem: null };
    }
  } catch (error) {
    const problem =
      error instanceof CatalogInvalidError
        ? error.message
        : `配布カタログを読めません / the image catalog could not be read: ${describeError(error)}`;
    catalogCache = { catalog: EMPTY_CATALOG, problem };
  }
  return catalogCache;
}

function requireCatalogEntry(id: string): ImageCatalogEntry {
  const { catalog, problem } = activeCatalog();
  if (problem !== null) throw new AppFailure('CATALOG_INVALID', problem);
  const entry = entryById(catalog, id);
  if (entry === null) {
    throw new AppFailure('INVALID_INPUT', `カタログにない ID です / not a catalog entry: ${id}`);
  }
  return entry;
}

export async function imageAvailability(image: RegisteredImage, docker: DockerStatus): Promise<ImageAvailability> {
  if (!docker.available) {
    return {
      kind: 'unavailable',
      message: docker.error ?? 'Docker に接続できません / Docker is unreachable',
    };
  }
  if (docker.platform !== image.platform) {
    const daemon = docker.platform ?? `${docker.os ?? '?'}/${docker.architecture ?? '?'}`;
    return {
      kind: 'incompatible',
      message: `${image.platform} 向けの登録ですが、接続中の Docker は ${daemon} です / registered for ${image.platform}, but the connected Docker is ${daemon}`,
    };
  }
  try {
    const local = await inspectImage(imageReference(image.repository, image.pinnedDigest, image.tag));
    if (local === null) return { kind: 'missing' };
    return { kind: 'ready', localImageId: local.id, localSizeBytes: local.sizeBytes };
  } catch (error) {
    return { kind: 'error', message: describeError(error) };
  }
}

interface ImageUsage {
  readonly environmentIds: readonly string[];
  readonly appliedTaskIds: readonly string[];
}

function imageUsage(imageId: string): ImageUsage {
  return {
    environmentIds: environmentsUsingImage(imageId).map((environment) => environment.id),
    appliedTaskIds: tasksAppliedTo(imageId).map((task) => task.id),
  };
}

export async function imageViews(docker: DockerStatus): Promise<readonly RegisteredImageView[]> {
  const { catalog } = activeCatalog();
  const images = listRegisteredImages();
  /* oxlint-disable no-await-in-loop -- one inspect at a time keeps the daemon calls orderly */
  const views: RegisteredImageView[] = [];
  for (const image of images) {
    views.push({
      image,
      availability: await imageAvailability(image, docker),
      ...imageUsage(image.id),
      inCatalog: image.catalogEntryId === null || entryById(catalog, image.catalogEntryId) !== null,
    });
  }
  /* oxlint-enable no-await-in-loop */
  return views;
}

const leases = new Map<string, number>();

export function leaseImage(imageId: string): () => void {
  leases.set(imageId, (leases.get(imageId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (leases.get(imageId) ?? 1) - 1;
    if (remaining <= 0) leases.delete(imageId);
    else leases.set(imageId, remaining);
  };
}

function leaseCount(imageId: string): number {
  return leases.get(imageId) ?? 0;
}

interface FetchTarget {
  readonly catalogEntryId: string | null;
  readonly variant: ImageVariant | null;
  readonly release: string | null;
  readonly title: LocalizedText;
  readonly repository: string;
  readonly tag: string | null;
  readonly digest: string | null;
  readonly tools: readonly CatalogTool[];
}

function operationTarget(target: FetchTarget, platform: ImagePlatform | null): ImageOperationTarget {
  return {
    title: { ja: imageDisplayName(target, 'ja'), en: imageDisplayName(target, 'en') },
    repository: target.repository,
    tag: target.tag,
    pinnedDigest: target.digest,
    platform,
  };
}

function repoDigestOf(inspect: ImageInspect, repository: string): string | null {
  const wanted = normalizeRepository(repository);
  for (const entry of inspect.repoDigests) {
    const at = entry.indexOf('@');
    if (at === -1) continue;
    if (normalizeRepository(entry.slice(0, at)) === wanted) return entry.slice(at + 1);
  }
  return null;
}

async function ensureLocal(
  context: OperationContext,
  reference: string,
  platform: ImagePlatform | null,
): Promise<ImageInspect> {
  context.throwIfCancelled();
  const found = await inspectImage(reference);
  if (found !== null) {
    context.update({ step: 'local-found' }, true);
    logInfo('image', `取得済みのイメージを使います / found ${reference} locally; skipping the download`);
    return found;
  }
  context.update({ phase: 'pulling', step: 'pull', pulled: true }, true);
  logInfo('image', `ダウンロードします / pulling ${reference}${platform === null ? '' : ` for ${platform}`}`);
  const outcome = await pullImage(reference, platform, context.signal, (progress) => {
    context.update({
      downloadedBytes: progress.downloadedBytes,
      totalBytes: progress.totalBytes,
      completedLayers: progress.completedLayers,
      totalLayers: progress.totalLayers,
      layers: progress.layers,
      step: progress.silentSeconds >= 300 ? 'stalled' : 'pull',
    });
  });
  if (outcome.malformed > 0) {
    logWarn(
      'image',
      `取得ストリームに読めない行が ${outcome.malformed} 件ありました / ${outcome.malformed} unreadable line(s) in the pull stream`,
    );
  }
  const pulled = await inspectImage(reference);
  if (pulled === null) {
    throw new AppFailure(
      'DOCKER_ERROR',
      `取得後に ${reference} を解決できません / ${reference} cannot be resolved after the pull`,
      { retryable: true },
    );
  }
  logInfo('image', `ダウンロードが完了しました / pulled ${reference} (${outcome.events} events)`);
  return pulled;
}

async function fetchAndRegister(
  context: OperationContext,
  resolve: (daemon: DaemonInfo & { readonly platform: ImagePlatform }) => FetchTarget,
  pinPlatform: boolean,
): Promise<RegisteredImage> {
  context.update({ phase: 'checking', step: 'daemon' }, true);
  const daemon = await requireLinuxDaemon();
  const target = resolve(daemon);
  const reference = imageReference(target.repository, target.digest, target.tag);
  context.update({ target: operationTarget(target, daemon.platform), step: 'local' });

  const local = await ensureLocal(context, reference, pinPlatform ? daemon.platform : null);

  context.throwIfCancelled();
  context.update({ phase: 'registering', step: 'ledger' }, true);
  const digest = target.digest ?? (target.catalogEntryId === null ? null : repoDigestOf(local, target.repository));
  const image: RegisteredImage = {
    id: registeredImageIdFor(target.repository, digest, target.tag, daemon.platform),
    catalogEntryId: target.catalogEntryId,
    variant: target.variant,
    release: target.release,
    title: target.title,
    repository: target.repository,
    tag: target.tag,
    pinnedDigest: digest,
    platform: daemon.platform,
    tools: target.tools,
    registeredAt: new Date().toISOString(),
  };
  const committed = commitRegistration(image);
  context.update({ target: operationTarget({ ...target, digest }, daemon.platform) });
  markSucceeded(context, committed.id);
  notifyStateChanged();
  return committed;
}

function catalogTarget(entry: ImageCatalogEntry, digest: string | null): FetchTarget {
  return {
    catalogEntryId: entry.id,
    variant: entry.variant,
    release: entry.release,
    title: entry.title,
    repository: entry.repository,
    tag: entry.tag,
    digest,
    tools: entry.tools,
  };
}

function registeredTarget(image: RegisteredImage): FetchTarget {
  return {
    catalogEntryId: image.catalogEntryId,
    variant: image.variant,
    release: image.release,
    title: image.title,
    repository: image.repository,
    tag: image.tag,
    digest: image.pinnedDigest,
    tools: image.tools,
  };
}

function start(
  kind: ImageOperationKind,
  targetKey: string,
  ids: { readonly catalogEntryId: string | null; readonly registeredImageId: string | null },
  initial: FetchTarget,
  resolve: (daemon: DaemonInfo & { readonly platform: ImagePlatform }) => FetchTarget,
  pinPlatform: boolean,
): ImageOperation {
  const running = activeOperationFor(targetKey);
  if (running !== null) return running;
  return enqueueOperation(
    { id: newOperationId(), kind, targetKey, ...ids, target: operationTarget(initial, null) },
    async (context) => {
      await fetchAndRegister(context, resolve, pinPlatform);
    },
  );
}

export function startDownload(catalogEntryId: string): ImageOperation {
  const entry = requireCatalogEntry(catalogEntryId);
  return start(
    'download',
    `catalog:${entry.id}`,
    { catalogEntryId: entry.id, registeredImageId: null },
    catalogTarget(entry, null),
    (daemon) => {
      const platformEntry = catalogPlatform(entry, daemon.platform);
      if (platformEntry === null && entry.platforms.length > 0) {
        throw new AppFailure(
          'UNSUPPORTED_PLATFORM',
          `${entry.title.en} は ${daemon.platform} 向けに配布されていません / ${entry.title.en} is not published for ${daemon.platform}`,
        );
      }
      return catalogTarget(entry, platformEntry?.manifestDigest ?? null);
    },
    true,
  );
}

export function startCustomRegistration(request: ImageCustomRequest): ImageOperation {
  const parsed = parseImageReference(request.reference);
  if (parsed === null) {
    throw new AppFailure(
      'INVALID_INPUT',
      `イメージ参照として読めません / not an image reference: ${request.reference.trim()}`,
    );
  }
  const name = request.name.trim();
  const shown = name === '' ? imageReference(parsed.repository, parsed.digest, parsed.tag) : name;
  const target: FetchTarget = {
    catalogEntryId: null,
    variant: null,
    release: null,
    title: { ja: shown, en: shown },
    repository: parsed.repository,
    tag: parsed.tag,
    digest: parsed.digest,
    tools: [],
  };
  return start(
    'custom',
    `custom:${parsed.repository}|${registrationIdentity(parsed.digest, parsed.tag)}`,
    { catalogEntryId: null, registeredImageId: null },
    target,
    () => target,
    false,
  );
}

export function startRepair(imageId: string): ImageOperation {
  const image = registeredImageFor(imageId);
  if (image === null) {
    throw new AppFailure('IMAGE_NOT_REGISTERED', `登録されていないイメージです / not a registered image: ${imageId}`);
  }
  const target = registeredTarget(image);
  return start(
    'repair',
    `registered:${image.id}`,
    { catalogEntryId: image.catalogEntryId, registeredImageId: image.id },
    target,
    (daemon) => {
      if (daemon.platform !== image.platform) {
        throw new AppFailure(
          'UNSUPPORTED_PLATFORM',
          `この登録は ${image.platform} 向けで、接続中の Docker は ${daemon.platform} です / this registration is for ${image.platform}; the connected Docker is ${daemon.platform}`,
        );
      }
      return target;
    },
    image.catalogEntryId !== null,
  );
}

export function cancelImageOperation(operationId: string): ImageOperation {
  return requestCancel(operationId);
}

function inUse(reason: string): AppFailure {
  return new AppFailure(
    'IMAGE_IN_USE',
    `使用中なので登録を解除できません / the registration is in use and cannot be removed: ${reason}`,
  );
}

export async function unregisterImage(imageId: string): Promise<void> {
  const image = registeredImageFor(imageId);
  if (image === null) {
    throw new AppFailure('IMAGE_NOT_REGISTERED', `登録されていないイメージです / not a registered image: ${imageId}`);
  }
  const check = (): void => {
    const usage = imageUsage(imageId);
    if (usage.environmentIds.length > 0) {
      const names = environmentsUsingImage(imageId).map((environment) => environment.name);
      throw inUse(`環境 / environments: ${names.join(', ')}`);
    }
    if (usage.appliedTaskIds.length > 0) {
      const names = tasksAppliedTo(imageId).map((task) => task.name);
      throw inUse(`タスク / tasks: ${names.join(', ')}`);
    }
    if (leaseCount(imageId) > 0) {
      throw inUse('タスクの作成または作り直しが進行中です / a task is being created or recreated from it');
    }
    if (
      activeOperations().some(
        (operation) => operation.registeredImageId === imageId && !isTerminalPhase(operation.phase),
      )
    ) {
      throw inUse('このイメージの取得操作が進行中です / an operation on this image is in progress');
    }
  };
  check();

  let containers: readonly { readonly names: readonly string[] }[];
  try {
    containers = await listContainersByLabels([
      `${MANAGED_LABEL}=true`,
      `${ROLE_LABEL}=task`,
      `${INSTANCE_LABEL}=${dataInstanceId()}`,
      `${REGISTERED_IMAGE_LABEL}=${imageId}`,
    ]);
  } catch (error) {
    throw new AppFailure(
      'DOCKER_UNAVAILABLE',
      `Docker に接続できないので、コンテナがこのイメージを使っていないことを確認できません / Docker is unreachable, so it cannot be confirmed that no container still uses this image (${describeError(error)})`,
      { retryable: true, cause: error },
    );
  }
  if (containers.length > 0) {
    throw inUse(`コンテナ / containers: ${containers.map((container) => container.names.join(',')).join(', ')}`);
  }

  check();
  dropRegistration(imageId);
  notifyStateChanged();
}
