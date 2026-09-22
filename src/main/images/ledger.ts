import { createHash } from 'node:crypto';

import { byId } from '../../shared/collections.ts';
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
  const sameId = byId(images, next.id);
  const sameKey = images.find((image) => registrationKey(image) === nextKey) ?? null;
  if (sameId !== null && registrationKey(sameId) !== nextKey) {
    throw new LedgerConflictError(`registration ${next.id} already exists with a different key`);
  }
  if (sameKey !== null && sameKey.id !== next.id) {
    throw new LedgerConflictError(`the same image is already registered as ${sameKey.id}`);
  }
  if (sameId === null) return [...images, next];
  const merged: RegisteredImage =
    next.catalogEntryId === null && sameId.catalogEntryId !== null
      ? { ...sameId, registeredAt: next.registeredAt }
      : next;
  return images.map((image) => (image.id === next.id ? merged : image));
}

export function findRegistration(images: readonly RegisteredImage[], id: string | null): RegisteredImage | null {
  return byId(images, id);
}
