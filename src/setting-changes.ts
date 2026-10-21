import type { SettingsOverride } from './app-host.ts';
import type { SettingNeed } from './setting-needs.ts';

export interface SettingsFileValues {
  root: string;
  merged: string[];
  file: Record<string, Record<string, unknown>> | null;
}

export interface MapDefaults {
  settingsDefaults?: Record<string, any>;
  settingsDefaultsIncomplete?: Record<string, string[][]>;
}

export type SettingBlock = 'no-settings-file' | 'other-root' | 'whole-section' | 'section-not-merged' | 'default-incomplete' | 'no-value';

export interface SettingChange {
  // 목록에 값이 있어야 하는 조건은 바꾸지 않은 목록에 그 값이 있는지(true / false)다.
  unchanged?: unknown;
  known: boolean;
  met: boolean | null;
  set: SettingsOverride | null;
  blocked: SettingBlock | null;
}

const valueAt = (v: unknown, keys: string[]) => keys.reduce((o: any, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), v);

function meets(need: SettingNeed, value: unknown) {
  return { on: Boolean(value), off: !value, equals: value === need.value, includes: value === true, present: Boolean(value) }[need.need] ?? false;
}

export function settingChange(need: SettingNeed, settings: SettingsFileValues | null, map: MapDefaults): SettingChange {
  const [section, key, ...rest] = need.path;
  const fromFile = Boolean(settings && need.root === settings.root && need.path.length >= 2 && settings.merged.includes(section));
  const fileSection = fromFile ? settings!.file?.[section] : undefined;
  const fileSets = fileSection !== null && typeof fileSection === 'object' && Object.hasOwn(fileSection, key);
  const incomplete = map.settingsDefaultsIncomplete?.[need.root] ?? [];
  const known = !incomplete.some((p) => p.every((k, i) => k === need.path[i])) || fileSets;
  const value = !fromFile ? need.default : valueAt(fileSets ? fileSection![key] : map.settingsDefaults?.[need.root]?.[section]?.[key], rest);
  const unchanged = need.need === 'includes' ? Array.isArray(value) && value.includes(need.value) : value;
  const set: SettingsOverride | null = need.need === 'present' ? null
    : need.need === 'includes' ? { path: need.path, item: need.value as SettingsOverride['item'], value: true }
      : { path: need.path, value: need.need === 'equals' ? need.value : need.need === 'on' };
  const blocked: SettingBlock | null = !settings ? 'no-settings-file'
    : need.root !== settings.root ? 'other-root'
      : need.path.length < 2 ? 'whole-section'
        : !settings.merged.includes(section) ? 'section-not-merged'
          : (need.need === 'includes' || need.path.length > 2) && !known ? 'default-incomplete'
            : need.need === 'present' ? 'no-value' : null;
  return { ...(unchanged !== undefined ? { unchanged } : {}), known, met: known ? meets(need, unchanged) : null, set, blocked };
}
