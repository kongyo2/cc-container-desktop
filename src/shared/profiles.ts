import type { AppConfig, Profile } from './types.ts';

export function profileById(config: AppConfig, id: string | null): Profile | null {
  if (id === null) return null;
  return config.profiles.find((profile) => profile.id === id) ?? null;
}
