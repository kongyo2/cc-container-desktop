import { randomBytes } from 'node:crypto';

/** Mints one of the `<prefix>_<16 hex digits>` ids the app's id patterns expect. */
export function prefixedRandomId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}
