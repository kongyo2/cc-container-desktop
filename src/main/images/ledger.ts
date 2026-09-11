import { createHash } from 'node:crypto';

import { imageTargetKey, normalizeRepository } from '../../shared/images.ts';
import type { ImagePlatform, RegisteredImage } from '../../shared/images.ts';

/** The registration id is derived from the unique key, so the same content always registers under the same id. */
export function registeredImageIdFor(repository: string, pinnedDigest: string, platform: ImagePlatform): string {
  const key = JSON.stringify([normalizeRepository(repository), pinnedDigest, platform]);
  return `img_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

export function registrationKey(image: RegisteredImage): string {
  return imageTargetKey(image.repository, image.pinnedDigest, image.tag, image.platform);
}

export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflictError';
  }
}

/**
 * Adds a registration or refreshes an existing one. The same key must map to
 * the same id and vice versa; anything else is a corrupted ledger and is
 * refused rather than overwritten.
 */
export function upsertRegistration(
  images: readonly RegisteredImage[],
  next: RegisteredImage,
): readonly RegisteredImage[] {
  const expectedId = registeredImageIdFor(next.repository, next.pinnedDigest, next.platform);
  if (next.id !== expectedId) {
    throw new LedgerConflictError(`registration ${next.id} does not match its key (${expectedId})`);
  }
  const nextKey = registrationKey(next);
  const byId = images.find((image) => image.id === next.id) ?? null;
  const byKey = images.find((image) => registrationKey(image) === nextKey) ?? null;
  if (byId !== null && registrationKey(byId) !== nextKey) {
    throw new LedgerConflictError(`registration ${next.id} already exists with a different key`);
  }
  if (byKey !== null && byKey.id !== next.id) {
    throw new LedgerConflictError(`the same image is already registered as ${byKey.id}`);
  }
  if (byId === null) return [...images, next];
  const merged: RegisteredImage = { ...next, registeredAt: byId.registeredAt };
  return images.map((image) => (image.id === next.id ? merged : image));
}

export function removeRegistration(images: readonly RegisteredImage[], id: string): readonly RegisteredImage[] {
  return images.filter((image) => image.id !== id);
}

export function findRegistration(images: readonly RegisteredImage[], id: string | null): RegisteredImage | null {
  if (id === null) return null;
  return images.find((image) => image.id === id) ?? null;
}
