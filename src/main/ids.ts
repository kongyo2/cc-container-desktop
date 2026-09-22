import { randomBytes } from 'node:crypto';

export function prefixedRandomId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}
