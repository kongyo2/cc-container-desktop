import type { AppConfig, Profile } from './types.ts';

export function profileById(config: AppConfig, id: string | null): Profile | null {
  if (id === null) return null;
  return config.profiles.find((profile) => profile.id === id) ?? null;
}

export function defaultProfileOf(config: AppConfig): Profile | null {
  return profileById(config, config.defaultProfileId);
}
