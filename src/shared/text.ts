export function normalizeDisplayName(name: string, maxLength: number): string {
  return name
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}
