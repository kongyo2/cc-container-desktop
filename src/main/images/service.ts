import { readFileSync } from 'node:fs';

import {
  catalogPlatform,
  digestReference,
  entryById,
  isTerminalPhase,
  RUNTIME_CONTRACT,
  tagReference,
} from '../../shared/images.ts';
import type {
  ImageAvailability,
  ImageCatalog,
  ImageCatalogEntry,
  ImageOperation,
  ImageOperationTarget,
  ImagePlatform,
  RegisteredImage,
  RegisteredImageView,
} from '../../shared/images.ts';
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
import {
  checkImageMetadata,
  repoDigestOf,
  runContractChecks,
  sourceRevisionOf,
  toolsWithMeasuredVersions,
} from './verify.ts';
import type { ExpectedImage } from './verify.ts';

let catalogCache: { readonly catalog: ImageCatalog; readonly problem: string | null } | null = null;

const EMPTY_CATALOG: ImageCatalog = {
  schemaVersion: 1,
  generatedAt: '1970-01-01T00:00:00.000Z',
  repository: '',
  entries: [],
};

/** The bundled catalog, or in development only, the file named by CC_IMAGE_CATALOG_FILE. */
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

function pinnedReference(image: RegisteredImage): string {
  return `${image.repository}@${image.pinnedDigest}`;
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
    const local = await inspectImage(pinnedReference(image));
    if (local === null) return { kind: 'missing' };
    if (docker.engineId === image.lastVerified.engineId && local.id === image.lastVerified.localImageId) {
      return { kind: 'ready', localImageId: local.id, localSizeBytes: local.sizeBytes };
    }
    return { kind: 'unverified', localImageId: local.id };
  } catch (error) {
    return { kind: 'error', message: describeError(error) };
  }
}

export interface ImageUsage {
  readonly environmentIds: readonly string[];
  readonly appliedTaskIds: readonly string[];
}

export function imageUsage(imageId: string): ImageUsage {
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
      inCatalog: entryById(catalog, image.catalogEntryId) !== null,
    });
  }
  /* oxlint-enable no-await-in-loop */
  return views;
}

const leases = new Map<string, number>();

/** A lease keeps a registration from being removed while a task is being created or recreated from it. */
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

export function leaseCount(imageId: string): number {
  return leases.get(imageId) ?? 0;
}

function targetOf(
  entry: ImageCatalogEntry,
  pinnedDigest: string | null,
  platform: ImagePlatform | null,
): ImageOperationTarget {
  return {
    variant: entry.variant,
    release: entry.release,
    title: entry.title,
    repository: entry.repository,
    tag: entry.tag,
    pinnedDigest,
    platform,
  };
}

interface FetchPlan {
  readonly daemon: DaemonInfo & { readonly platform: ImagePlatform };
  readonly reference: string;
  readonly pinnedDigest: string | null;
}

async function planFetch(
  context: OperationContext,
  entry: ImageCatalogEntry,
  pinned: string | null,
): Promise<FetchPlan> {
  context.update({ phase: 'checking', step: 'daemon' }, true);
  const daemon = await requireLinuxDaemon();
  const platformEntry = catalogPlatform(entry, daemon.platform);
  if (platformEntry === null && pinned === null) {
    throw new AppFailure(
      'UNSUPPORTED_PLATFORM',
      `${entry.title.en} は ${daemon.platform} 向けに配布されていません / ${entry.title.en} is not published for ${daemon.platform}`,
    );
  }
  const pinnedDigest = pinned ?? platformEntry?.manifestDigest ?? null;
  const reference =
    pinnedDigest === null ? tagReference(entry.repository, entry.tag) : digestReference(entry.repository, pinnedDigest);
  context.update({ target: targetOf(entry, pinnedDigest, daemon.platform), step: 'local' });
  return { daemon, reference, pinnedDigest };
}

async function ensureLocal(context: OperationContext, plan: FetchPlan): Promise<ImageInspect> {
  context.throwIfCancelled();
  const found = await inspectImage(plan.reference);
  if (found !== null) {
    context.update({ step: 'local-found' }, true);
    logInfo('image', `取得済みのイメージを確認しています / found ${plan.reference} locally; skipping the download`);
    return found;
  }
  context.update({ phase: 'pulling', step: 'pull', pulled: true }, true);
  logInfo('image', `ダウンロードします / pulling ${plan.reference} for ${plan.daemon.platform}`);
  const outcome = await pullImage(plan.reference, plan.daemon.platform, context.signal, (progress) => {
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
  const pulled = await inspectImage(plan.reference);
  if (pulled === null) {
    throw new AppFailure(
      'DIGEST_MISMATCH',
      `取得後に ${plan.reference} を解決できません / ${plan.reference} cannot be resolved after the pull`,
    );
  }
  logInfo('image', `ダウンロードが完了しました / pulled ${plan.reference} (${outcome.events} events)`);
  return pulled;
}

async function verifyAndRegister(
  context: OperationContext,
  entry: ImageCatalogEntry,
  plan: FetchPlan,
  local: ImageInspect,
  existing: RegisteredImage | null,
): Promise<RegisteredImage> {
  context.throwIfCancelled();
  context.update({ phase: 'verifying', step: 'metadata' }, true);

  const digest = plan.pinnedDigest ?? repoDigestOf(local, entry.repository);
  if (digest === null) {
    throw new AppFailure(
      'DIGEST_MISMATCH',
      `取得したイメージに ${entry.repository} のダイジェストが記録されていません / the pulled image carries no digest for ${entry.repository}`,
    );
  }
  const expected: ExpectedImage = {
    repository: entry.repository,
    pinnedDigest: digest,
    platform: plan.daemon.platform,
    variant: entry.variant,
    release: entry.release,
  };
  checkImageMetadata(local, expected);
  context.update({ target: targetOf(entry, digest, plan.daemon.platform), step: 'contract' }, true);
  const contract = await runContractChecks(local.id, expected, context.id, context.signal);

  context.throwIfCancelled();
  context.update({ phase: 'registering', step: 'ledger' }, true);

  const id = registeredImageIdFor(entry.repository, digest, plan.daemon.platform);
  const now = new Date().toISOString();
  const image: RegisteredImage = {
    id,
    catalogEntryId: entry.id,
    variant: entry.variant,
    release: entry.release,
    title: entry.title,
    repository: entry.repository,
    tag: entry.tag,
    indexDigest: entry.indexDigest,
    pinnedDigest: digest,
    digestKind: plan.pinnedDigest !== null ? 'manifest' : 'index',
    platform: plan.daemon.platform,
    runtimeContract: RUNTIME_CONTRACT,
    sourceRevision: sourceRevisionOf(local) ?? contract.imageInfo.sourceRevision ?? entry.sourceRevision,
    tools: toolsWithMeasuredVersions(entry.tools, contract.imageInfo),
    registeredAt: existing?.registeredAt ?? now,
    lastVerified: {
      engineId: plan.daemon.engineId,
      localImageId: local.id,
      localSizeBytes: local.sizeBytes,
      verifiedAt: now,
      checksPassed: contract.checksPassed,
    },
  };
  const committed = commitRegistration(image);
  markSucceeded(context, committed.id);
  notifyStateChanged();
  return committed;
}

function entryForRegistered(image: RegisteredImage): ImageCatalogEntry {
  const { catalog } = activeCatalog();
  const fromCatalog = entryById(catalog, image.catalogEntryId);
  if (fromCatalog !== null && fromCatalog.repository === image.repository) return fromCatalog;
  return {
    id: image.catalogEntryId,
    variant: image.variant,
    release: image.release,
    title: image.title,
    summary: image.title,
    description: image.title,
    recommended: false,
    inherits: null,
    repository: image.repository,
    tag: image.tag,
    indexDigest: image.indexDigest,
    platforms: [{ platform: image.platform, manifestDigest: image.pinnedDigest, compressedLayerBytes: null }],
    runtimeContract: RUNTIME_CONTRACT,
    sourceRevision: image.sourceRevision,
    publishedAt: null,
    tools: image.tools,
  };
}

export function startDownload(catalogEntryId: string): ImageOperation {
  const entry = requireCatalogEntry(catalogEntryId);
  const targetKey = `catalog:${entry.id}`;
  const running = activeOperationFor(targetKey);
  if (running !== null) return running;

  return enqueueOperation(
    {
      id: newOperationId(),
      kind: 'download',
      targetKey,
      catalogEntryId: entry.id,
      registeredImageId: null,
      target: targetOf(entry, null, null),
    },
    async (context) => {
      const plan = await planFetch(context, entry, null);
      const existingId =
        plan.pinnedDigest === null
          ? null
          : registeredImageIdFor(entry.repository, plan.pinnedDigest, plan.daemon.platform);
      const existing = registeredImageFor(existingId);
      const local = await ensureLocal(context, plan);
      await verifyAndRegister(context, entry, plan, local, existing);
    },
  );
}

export function startRepair(imageId: string): ImageOperation {
  const image = registeredImageFor(imageId);
  if (image === null) {
    throw new AppFailure('IMAGE_NOT_REGISTERED', `登録されていないイメージです / not a registered image: ${imageId}`);
  }
  const targetKey = `registered:${image.id}`;
  const running = activeOperationFor(targetKey);
  if (running !== null) return running;
  const entry = entryForRegistered(image);

  return enqueueOperation(
    {
      id: newOperationId(),
      kind: 'repair',
      targetKey,
      catalogEntryId: entry.id,
      registeredImageId: image.id,
      target: targetOf(entry, image.pinnedDigest, image.platform),
    },
    async (context) => {
      const plan = await planFetch(context, entry, image.pinnedDigest);
      if (plan.daemon.platform !== image.platform) {
        throw new AppFailure(
          'UNSUPPORTED_PLATFORM',
          `この登録は ${image.platform} 向けで、接続中の Docker は ${plan.daemon.platform} です / this registration is for ${image.platform}; the connected Docker is ${plan.daemon.platform}`,
        );
      }
      const local = await ensureLocal(context, plan);
      await verifyAndRegister(context, entry, plan, local, image);
    },
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

/** Unregistering only removes the ledger entry; the image itself stays in Docker. */
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
