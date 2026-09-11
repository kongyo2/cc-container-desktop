import type { ImageOperation, RegisteredImage } from '../../shared/images.ts';
import { AppFailure, describeError } from '../errors.ts';
import { logInfo } from '../logger.ts';
import { statePath } from '../paths.ts';
import { StateFile } from '../state/file.ts';
import { findRegistration, LedgerConflictError, removeRegistration, upsertRegistration } from './ledger.ts';
import { parseImagesFile, parseOperationsFile } from './schema.ts';

const imagesFile = new StateFile<readonly RegisteredImage[]>({
  path: () => statePath('images.json'),
  label: '登録イメージの台帳 (images.json) / the image ledger (images.json)',
  parse: parseImagesFile,
  initial: () => [],
  serialize: (images) => ({ schemaVersion: 1, images }),
  persistInitial: false,
});

const operationsFile = new StateFile<readonly ImageOperation[]>({
  path: () => statePath('image-operations.json'),
  label: 'イメージ操作の履歴 (image-operations.json) / the image operation history (image-operations.json)',
  parse: parseOperationsFile,
  initial: () => [],
  serialize: (operations) => ({ schemaVersion: 1, operations }),
  persistInitial: false,
});

export function listRegisteredImages(): readonly RegisteredImage[] {
  return imagesFile.get();
}

export function registeredImageFor(id: string | null): RegisteredImage | null {
  return findRegistration(imagesFile.get(), id);
}

export function imagesStoreProblem(): string | null {
  return imagesFile.problem;
}

export function operationsStoreProblem(): string | null {
  return operationsFile.problem;
}

/** The point of no return for a registration: the ledger on disk is the truth. */
export function commitRegistration(image: RegisteredImage): RegisteredImage {
  let next: readonly RegisteredImage[];
  try {
    next = upsertRegistration(imagesFile.get(), image);
  } catch (error) {
    if (error instanceof LedgerConflictError) {
      throw new AppFailure(
        'REGISTRATION_WRITE_FAILED',
        `台帳と矛盾するので登録しません / not registered: ${error.message}`,
      );
    }
    throw error;
  }
  try {
    imagesFile.set(next);
  } catch (error) {
    if (error instanceof AppFailure) throw error;
    throw new AppFailure(
      'REGISTRATION_WRITE_FAILED',
      `取得は完了しましたが登録を保存できませんでした / the image was fetched but the registration could not be saved: ${describeError(error)}`,
      { retryable: true, cause: error },
    );
  }
  logInfo(
    'image',
    `登録しました / registered ${image.variant}@${image.release} as ${image.id} (${image.pinnedDigest})`,
  );
  return image;
}

export function dropRegistration(id: string): void {
  const current = imagesFile.get();
  if (findRegistration(current, id) === null) return;
  imagesFile.set(removeRegistration(current, id));
  logInfo('image', `登録を解除しました / unregistered ${id}`);
}

export function readOperationHistory(): readonly ImageOperation[] {
  return operationsFile.get();
}

export function writeOperationHistory(operations: readonly ImageOperation[]): void {
  if (operationsFile.problem !== null) return;
  operationsFile.set(operations.map((operation) => ({ ...operation, layers: [] })));
}
