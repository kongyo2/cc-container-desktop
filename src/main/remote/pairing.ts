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

export function sameProof(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
