import { defaults } from './settings';
import type { Settings } from './settings';

export function createSettings(installed?: Partial<Settings>): Settings {
  return { SYSTEM: { ...defaults.SYSTEM, ...installed?.SYSTEM } };
}
