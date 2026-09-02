import type { AppConfig, Profile } from './types.ts';

export function activeProfileOf(config: AppConfig): Profile | null {
  if (config.activeProfileId === null) return null;
  return config.profiles.find((profile) => profile.id === config.activeProfileId) ?? null;
}
