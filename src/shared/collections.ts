export function withoutId<T extends { readonly id: string }>(entries: readonly T[], id: string): readonly T[] {
  return entries.filter((entry) => entry.id !== id);
}

export function byId<T extends { readonly id: string }>(entries: readonly T[], id: string | null): T | null {
  if (id === null) return null;
  return entries.find((entry) => entry.id === id) ?? null;
}
