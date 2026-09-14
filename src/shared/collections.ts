export function withoutId<T extends { readonly id: string }>(entries: readonly T[], id: string): readonly T[] {
  return entries.filter((entry) => entry.id !== id);
}
