/** Collapses a user-typed name onto one clean line: no control characters, single spaces, capped length. */
export function normalizeDisplayName(name: string, maxLength: number): string {
  return name
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}
