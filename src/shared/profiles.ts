import type { AppConfig, Profile } from './types.ts';

/**
 * The profile Claude Code is currently pointed at, or null when none is
 * selected. `activeProfileId` can outlive the profile it names — a delete that
 * raced a save, or a config file edited by hand — so a miss is a null, not a
 * crash.
 */
export function activeProfileOf(config: AppConfig): Profile | null {
  if (config.activeProfileId === null) return null;
  return config.profiles.find((profile) => profile.id === config.activeProfileId) ?? null;
}
