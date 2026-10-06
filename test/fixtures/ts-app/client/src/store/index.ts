import { createSettings } from './createSettings';
import type { Settings } from './settings';

export const appSettings = createSettings((window as { APP_SETTINGS?: Partial<Settings> }).APP_SETTINGS);
