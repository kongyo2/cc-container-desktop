import { byId } from './collections.ts';
import type { AppConfig, Profile } from './types.ts';

export function profileById(config: AppConfig, id: string | null): Profile | null {
  return byId(config.profiles, id);
}
