import { createHash } from 'node:crypto';

import { imageTargetKey, normalizeRepository, registrationIdentity } from '../../shared/images.ts';
import type { ImagePlatform, RegisteredImage } from '../../shared/images.ts';

export function registeredImageIdFor(
  repository: string,
  pinnedDigest: string | null,
  tag: string | null,
  platform: ImagePlatform,
): string {
  const key = JSON.stringify([normalizeRepository(repository), registrationIdentity(pinnedDigest, tag), platform]);
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

export function upsertRegistration(
  images: readonly RegisteredImage[],
  next: RegisteredImage,
): readonly RegisteredImage[] {
  const expectedId = registeredImageIdFor(next.repository, next.pinnedDigest, next.tag, next.platform);
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
  const merged: RegisteredImage =
    next.catalogEntryId === null && byId.catalogEntryId !== null ? { ...byId, registeredAt: next.registeredAt } : next;
  return images.map((image) => (image.id === next.id ? merged : image));
}

export function removeRegistration(images: readonly RegisteredImage[], id: string): readonly RegisteredImage[] {
  return images.filter((image) => image.id !== id);
}

export function findRegistration(images: readonly RegisteredImage[], id: string | null): RegisteredImage | null {
  if (id === null) return null;
  return images.find((image) => image.id === id) ?? null;
}
