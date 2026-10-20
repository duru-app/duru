import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingChange } from '../src/setting-changes.ts';
import type { SettingNeed } from '../src/setting-needs.ts';

const DEFAULTS = { globalSettings: { SYSTEM: { LAB_ENABLED: false, THEME: 'light', MAIN_MENU: { ADMIN: { LIST: ['ADMIN_REPORT'] } } } } };
const MAP = { settingsDefaults: DEFAULTS, settingsDefaultsIncomplete: { globalSettings: [] } };
const SETTINGS = { root: 'globalSettings', merged: ['SYSTEM'], file: { SYSTEM: { HELP_LINK_ENABLED: true } } };
const need = (path: string, kind: string, extra: Partial<SettingNeed> = {}): SettingNeed => ({ root: 'globalSettings', path: path.split('.'), need: kind, ...extra });

test('a setting need gets its value with no change, whether that meets it, and the change to write', () => {
  assert.deepEqual(settingChange(need('SYSTEM.LAB_ENABLED', 'on', { default: false }), SETTINGS, MAP), {
    unchanged: false, known: true, met: false, set: { path: ['SYSTEM', 'LAB_ENABLED'], value: true }, blocked: null,
  });
  assert.deepEqual(settingChange(need('SYSTEM.LAB_ENABLED', 'off', { default: false }), SETTINGS, MAP), {
    unchanged: false, known: true, met: true, set: { path: ['SYSTEM', 'LAB_ENABLED'], value: false }, blocked: null,
  });
  assert.deepEqual(settingChange(need('SYSTEM.THEME', 'equals', { value: 'dark', default: 'light' }), SETTINGS, MAP), {
    unchanged: 'light', known: true, met: false, set: { path: ['SYSTEM', 'THEME'], value: 'dark' }, blocked: null,
  });
});

test('a setting the settings file sets takes its value from the file', () => {
  assert.deepEqual(settingChange(need('SYSTEM.HELP_LINK_ENABLED', 'on'), SETTINGS, MAP), {
    unchanged: true, known: true, met: true, set: { path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: true }, blocked: null,
  });
});

test('a list setting is unchanged true or false for whether the list already holds the value', () => {
  const list = 'SYSTEM.MAIN_MENU.ADMIN.LIST';
  assert.deepEqual(settingChange(need(list, 'includes', { value: 'ADMIN_REPORT' }), SETTINGS, MAP), {
    unchanged: true, known: true, met: true, set: { path: list.split('.'), item: 'ADMIN_REPORT', value: true }, blocked: null,
  });
  assert.equal(settingChange(need(list, 'includes', { value: 'ADMIN_ARCHIVE' }), SETTINGS, MAP).unchanged, false);
});

test('a setting that only has to be present has no change to write, and an empty value does not meet it', () => {
  const empty = { ...MAP, settingsDefaults: { globalSettings: { SYSTEM: { BANNER: '' } } } };
  assert.deepEqual(settingChange(need('SYSTEM.BANNER', 'present', { default: '' }), SETTINGS, empty), {
    unchanged: '', known: true, met: false, set: null, blocked: 'no-value',
  });
});

test('a setting under a default the source does not show in full is not known to be met, unless the settings file sets its key', () => {
  const partial = { ...MAP, settingsDefaultsIncomplete: { globalSettings: [['SYSTEM', 'MAIN_MENU']] } };
  const list = need('SYSTEM.MAIN_MENU.ADMIN.LIST', 'includes', { value: 'ADMIN_REPORT' });
  assert.deepEqual(settingChange(list, SETTINGS, partial), {
    unchanged: true, known: false, met: null, set: { path: list.path, item: 'ADMIN_REPORT', value: true }, blocked: 'default-incomplete',
  });
  const fromFile = { ...SETTINGS, file: { SYSTEM: { MAIN_MENU: { ADMIN: { LIST: [] } } } } };
  assert.deepEqual(settingChange(list, fromFile, partial), {
    unchanged: false, known: true, met: false, set: { path: list.path, item: 'ADMIN_REPORT', value: true }, blocked: null,
  });
});

test('without a settings file, or for a setting the file cannot change, the source default is the value and the block says why', () => {
  const lab = need('SYSTEM.LAB_ENABLED', 'on', { default: false });
  assert.deepEqual(settingChange(lab, null, MAP), { unchanged: false, known: true, met: false, set: { path: lab.path, value: true }, blocked: 'no-settings-file' });
  assert.equal(settingChange({ ...lab, root: 'appSettings' }, SETTINGS, MAP).blocked, 'other-root');
  assert.equal(settingChange(need('SYSTEM', 'on'), SETTINGS, MAP).blocked, 'whole-section');
  assert.equal(settingChange(need('CUSTOM.THEME', 'equals', { value: 'dark', default: 'light' }), SETTINGS, MAP).blocked, 'section-not-merged');
  assert.equal(settingChange(need('CUSTOM.THEME', 'equals', { value: 'dark', default: 'light' }), SETTINGS, MAP).unchanged, 'light');
});
