import { createHmac, timingSafeEqual } from 'node:crypto';

export type PairingRole = 'client' | 'server';

export function pairingProof(code: string, role: PairingRole, fingerprint: string, parts: readonly string[]): string {
  return createHmac('sha256', Buffer.from(code, 'utf8'))
    .update(
      [`cc-container-desktop/pair/${role}`, fingerprint, ...parts].map((part) => `${part.length}:${part}`).join('|'),
      'utf8',
    )
    .digest('base64url');
}

export function sameSecret(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sameProof(left: string, right: string): boolean {
  return sameSecret(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
