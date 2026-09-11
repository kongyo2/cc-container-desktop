import { z } from 'zod';

import {
  DIGEST_PATTERN,
  IMAGE_PLATFORMS,
  IMAGE_VARIANTS,
  REGISTERED_IMAGE_ID_PATTERN,
  RELEASE_PATTERN,
  RUNTIME_CONTRACT,
} from '../../shared/images.ts';
import type { ImageOperation, RegisteredImage } from '../../shared/images.ts';
import type {
  ImageCancelRequest,
  ImageDownloadRequest,
  ImageRepairRequest,
  ImageUnregisterRequest,
} from '../../shared/ipc.ts';
import { AppFailure } from '../errors.ts';
import type { ParseOutcome } from '../state/file.ts';

const localizedSchema = z.strictObject({ ja: z.string(), en: z.string() });

const toolSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string(),
  highlight: z.boolean(),
});

const verificationSchema = z.strictObject({
  engineId: z.string().min(1),
  localImageId: z.string().min(1),
  localSizeBytes: z.number().int().nonnegative(),
  verifiedAt: z.string().datetime({ offset: true }),
  checksPassed: z.number().int().nonnegative(),
});

const registeredImageSchema = z.strictObject({
  id: z.string().regex(REGISTERED_IMAGE_ID_PATTERN),
  catalogEntryId: z.string().min(1),
  variant: z.enum(IMAGE_VARIANTS),
  release: z.string().regex(RELEASE_PATTERN),
  title: localizedSchema,
  repository: z.string().min(1),
  tag: z.string().min(1),
  indexDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  pinnedDigest: z.string().regex(DIGEST_PATTERN),
  digestKind: z.enum(['manifest', 'index']),
  platform: z.enum(IMAGE_PLATFORMS),
  runtimeContract: z.literal(RUNTIME_CONTRACT),
  sourceRevision: z.string().nullable(),
  tools: z.array(toolSchema),
  registeredAt: z.string().datetime({ offset: true }),
  lastVerified: verificationSchema,
});

const imagesFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  images: z.array(registeredImageSchema),
});

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? 'invalid' : `${issue.path.join('.') || '(root)'}: ${issue.message}`;
}

export function parseImagesFile(raw: unknown): ParseOutcome<readonly RegisteredImage[]> {
  const parsed = imagesFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: firstIssue(parsed.error) };
  const seen = new Set<string>();
  for (const image of parsed.data.images) {
    if (seen.has(image.id)) return { ok: false, problem: `duplicate registration id ${image.id}` };
    seen.add(image.id);
  }
  return { ok: true, value: parsed.data.images.map((image) => ({ ...image, runtimeContract: RUNTIME_CONTRACT })) };
}

const appErrorSchema = z.strictObject({ code: z.string().min(1), message: z.string(), retryable: z.boolean() });

const targetSchema = z.strictObject({
  variant: z.enum(IMAGE_VARIANTS),
  release: z.string().min(1),
  title: localizedSchema,
  repository: z.string().min(1),
  tag: z.string().min(1),
  pinnedDigest: z.string().regex(DIGEST_PATTERN).nullable(),
  platform: z.enum(IMAGE_PLATFORMS).nullable(),
});

const layerSchema = z.strictObject({
  id: z.string(),
  status: z.string(),
  current: z.number().nonnegative(),
  total: z.number().nonnegative().nullable(),
  done: z.boolean(),
});

const operationSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['download', 'repair']),
  sequence: z.number().int().nonnegative(),
  targetKey: z.string().min(1),
  catalogEntryId: z.string().min(1).nullable(),
  registeredImageId: z.string().min(1).nullable(),
  target: targetSchema,
  phase: z.enum([
    'queued',
    'checking',
    'pulling',
    'verifying',
    'registering',
    'succeeded',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  step: z.string(),
  cancelRequested: z.boolean(),
  startedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  pulled: z.boolean(),
  downloadedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative().nullable(),
  completedLayers: z.number().int().nonnegative(),
  totalLayers: z.number().int().nonnegative(),
  layers: z.array(layerSchema),
  error: appErrorSchema.nullable(),
});

const operationsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operations: z.array(operationSchema),
});

export function parseOperationsFile(raw: unknown): ParseOutcome<readonly ImageOperation[]> {
  const parsed = operationsFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: firstIssue(parsed.error) };
  return { ok: true, value: parsed.data.operations };
}

function invalid(label: string, error: z.ZodError): AppFailure {
  return new AppFailure('INVALID_INPUT', `${label}: ${firstIssue(error)}`);
}

const downloadRequestSchema = z.strictObject({ catalogEntryId: z.string().min(1) });
const repairRequestSchema = z.strictObject({ imageId: z.string().regex(REGISTERED_IMAGE_ID_PATTERN) });
const cancelRequestSchema = z.strictObject({ operationId: z.string().min(1) });
const unregisterRequestSchema = z.strictObject({ imageId: z.string().regex(REGISTERED_IMAGE_ID_PATTERN) });

export function parseDownloadRequest(raw: unknown): ImageDownloadRequest {
  const parsed = downloadRequestSchema.safeParse(raw);
  if (!parsed.success) throw invalid('image:downloadStart', parsed.error);
  return parsed.data;
}

export function parseRepairRequest(raw: unknown): ImageRepairRequest {
  const parsed = repairRequestSchema.safeParse(raw);
  if (!parsed.success) throw invalid('image:repairStart', parsed.error);
  return parsed.data;
}

export function parseCancelRequest(raw: unknown): ImageCancelRequest {
  const parsed = cancelRequestSchema.safeParse(raw);
  if (!parsed.success) throw invalid('image:cancel', parsed.error);
  return parsed.data;
}

export function parseUnregisterRequest(raw: unknown): ImageUnregisterRequest {
  const parsed = unregisterRequestSchema.safeParse(raw);
  if (!parsed.success) throw invalid('image:unregister', parsed.error);
  return parsed.data;
}
