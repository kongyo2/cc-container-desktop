import { safeStorage } from 'electron';

import { describeError } from '../errors.ts';
import { logWarn } from '../logger.ts';

export interface SealedSecret {
  readonly enc: 'safeStorage' | 'plain';
  readonly value: string;
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function sealSecret(text: string): SealedSecret {
  if (!encryptionAvailable()) return { enc: 'plain', value: text };
  return { enc: 'safeStorage', value: safeStorage.encryptString(text).toString('base64') };
}

export function openSecret(entry: SealedSecret | null, label: string): string {
  if (entry === null || entry.value === '') return '';
  if (entry.enc === 'plain') return entry.value;
  try {
    return safeStorage.decryptString(Buffer.from(entry.value, 'base64'));
  } catch (error) {
    logWarn(
      'app',
      `${label} を復号できませんでした。OS のキーリングが戻れば読めます / ${label} could not be decrypted; it becomes readable again once the OS keyring is back: ${describeError(error)}`,
    );
    return '';
  }
}
