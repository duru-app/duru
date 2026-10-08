import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/ts-app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const READ_SETTINGS = { import: './settings/readSettings', name: 'readSettings', root: 'globalSettings', section: 'SYSTEM' };

const FILES = {
  'client/src/settings/readSettings.ts': `export function readSettings<T extends Record<string, unknown>>(defaults: T): T {
  return { ...defaults, ...(window as { APP_SETTINGS?: { SYSTEM?: Partial<T> } }).APP_SETTINGS?.SYSTEM };
}
`,
  'client/src/settings/unreached.ts': `import { readSettings } from './readSettings';

export const unreached = readSettings({ UNREACHED: true }).UNREACHED;
`,
  'client/src/screens/labSettings.ts': `import { readSettings } from '../settings/readSettings';
import { titleOf } from './scheduleReport';

const labSettings = readSettings({
  LAB_BETA: false,
  LAB_TITLE: titleOf('lab'),
  REPORT_ENABLED: false,
  PAGE_SIZE: 20,
});

export default labSettings;
`,
  'client/src/settings/broken.ts': `import { readSettings } from './readSettings';

export const broken = readSettings({ BROKEN: true }) +;
`,
  'client/src/screens/archiveSettings.ts': `import { readSettings } from '../settings/readSettings';

export default readSettings({ ARCHIVE_DAYS: 30 });
`,
  'client/src/screens/reportSettings.ts': `import { readSettings } from '../settings/readSettings';

export const reportSettings = readSettings({ PAGE_SIZE: 50, REPORT_LIMIT: 10 } as const);
`,
};

const EDITS = [
  ['client/src/screens/Lab.tsx', "import { scheduleReport } from './scheduleReport';", "import { scheduleReport } from './scheduleReport';\nimport labSettings from './labSettings';"],
  ['client/src/screens/Lab.tsx', '<button onClick={() => scheduleReport(ids)}>Every week</button>', '<button onClick={() => scheduleReport(ids)}>Every week</button>\n      {labSettings.LAB_BETA && <Link to={Option.ROUTE_PATH.REPORT}>Report</Link>}'],
  ['client/src/screens/Home.tsx', "import Option from '../_define/Option';", "import Option from '../_define/Option';\nimport { reportSettings } from './reportSettings';"],
  ['client/src/screens/Home.tsx', '<Banner {...banner} />', '<Banner {...banner} />\n      <p>{reportSettings.REPORT_LIMIT}</p>'],
  ['client/src/screens/Archive.tsx', "import Option from '../_define/Option';", "import Option from '../_define/Option';\nimport archiveSettings from './archiveSettings';"],
  ['client/src/screens/Archive.tsx', '<Link to={Option.ROUTE_PATH.PROFILE}>Profile</Link>', '<Link to={Option.ROUTE_PATH.PROFILE} title={`${archiveSettings.ARCHIVE_DAYS}`}>Profile</Link>'],
  ['client/src/screens/Inbox.tsx', "import Option from '../_define/Option';", "import Option from '../_define/Option';\nimport { readSettings } from '../settings/readSettings';"],
  ['client/src/screens/Inbox.tsx', '<main>', "<main title={readSettings({ INBOX_TITLE: 'Inbox' }).INBOX_TITLE}>"],
  ['client/src/pages/MailRoutes.tsx', "import Outbox from '../screens/Outbox';", "import Outbox from '../screens/Outbox';\nimport { readSettings } from '../settings/readSettings';\n\nconst mailSettings = readSettings({ OUTBOX_ENABLED: false });"],
  ['client/src/pages/MailRoutes.tsx', '<Route path={Option.ROUTE_PATH.OUTBOX} element={<Outbox />} />', '{mailSettings.OUTBOX_ENABLED && <Route path={Option.ROUTE_PATH.OUTBOX} element={<Outbox />} />}'],
  ['client/src/screens/scheduleReport.ts', 'export ', "export const titleOf = (name: string) => `${name}`.toUpperCase();\n\nexport "],
];

async function inCopy(config, fn, { files = FILES, edits = EDITS } = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true });
      fs.writeFileSync(path.join(copy, rel), text, { flag: 'wx' });
    }
    for (const [rel, from, to] of edits) {
      const file = path.join(copy, rel);
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(src.includes(from), `${rel} has no ${from}`);
      fs.writeFileSync(file, src.replace(from, to));
    }
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ...config }));
    return await fn(copy, configFile);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const lineOf = (dir, rel, text) => fs.readFileSync(path.join(dir, 'client/src', rel), 'utf8').split('\n').findIndex((l) => l.includes(text)) + 1;
const screen = (map, id) => map.screens.find((s) => s.id === id);
const need = (key, value) => ({ root: 'globalSettings', path: ['SYSTEM', key], need: 'on', default: value });

test('a screen reading the object a settings function returns, declared in its own file, or exported by default or by name from another file, reads those settings', async () => {
  await inCopy({ settingsFunctions: [READ_SETTINGS] }, async (dir, configFile) => {
    const map = await buildMap(loadConfig(configFile));
    const reads = (id) => screen(map, id).settingReads.map((r) => `${r.key} ${r.file}:${r.line}`);
    assert.deepEqual(reads('/lab#Lab'), [`SYSTEM.LAB_BETA screens/Lab.tsx:${lineOf(dir, 'screens/Lab.tsx', 'labSettings.LAB_BETA')}`]);
    assert.deepEqual(reads('/home#Home'), [
      `SYSTEM.REPORT_LIMIT screens/Home.tsx:${lineOf(dir, 'screens/Home.tsx', 'reportSettings.REPORT_LIMIT')}`,
      `SYSTEM.REPORT_ENABLED screens/Home.tsx:${lineOf(dir, 'screens/Home.tsx', 'SYSTEM.REPORT_ENABLED')}`,
    ]);
    assert.deepEqual(reads('/archive#Archive'), [`SYSTEM.ARCHIVE_DAYS screens/Archive.tsx:${lineOf(dir, 'screens/Archive.tsx', 'archiveSettings.ARCHIVE_DAYS')}`]);
    assert.deepEqual(reads('/inbox#Inbox'), []);
  });
});

test('a link or a route guarded by the object a settings function returns opens under that setting, with the default passed to the function', async () => {
  await inCopy({ settingsFunctions: [READ_SETTINGS] }, async (dir, configFile) => {
    const map = await buildMap(loadConfig(configFile));
    const line = lineOf(dir, 'screens/Lab.tsx', 'labSettings.LAB_BETA');
    assert.deepEqual(screen(map, '/lab#Lab').links.find((l) => l.line === line).conditions, [
      { guard: 'labSettings.LAB_BETA', kinds: ['setting'], settings: [need('LAB_BETA', false)] },
    ]);
    const outbox = screen(map, '/outbox#Outbox');
    assert.deepEqual(outbox.access.route, [{ guard: 'mailSettings.OUTBOX_ENABLED', kinds: ['setting'], settings: [need('OUTBOX_ENABLED', false)] }]);
    assert.equal(outbox.access.restricted, true);
  });
});

test('the objects passed to a settings function are setting defaults; a value the source does not show is incomplete, settingsDefaults wins over a different default, and two different defaults leave the value unknown', async () => {
  await inCopy({ settingsFunctions: [READ_SETTINGS] }, async (dir, configFile) => {
    const map = await buildMap(loadConfig(configFile));
    assert.deepEqual(map.settingsDefaults, {
      globalSettings: { SYSTEM: { LAB_ENABLED: false, REPORT_ENABLED: true, OUTBOX_ENABLED: false, ARCHIVE_DAYS: 30, LAB_BETA: false, REPORT_LIMIT: 10 } },
    });
    assert.deepEqual(map.settingsDefaultsIncomplete, { globalSettings: [['SYSTEM', 'LAB_TITLE'], ['SYSTEM', 'PAGE_SIZE']] });
    const at = (text) => `screens/labSettings.ts:${lineOf(dir, 'screens/labSettings.ts', text)}`;
    assert.deepEqual(map.settingsCallNotices, [
      { file: 'screens/labSettings.ts', line: lineOf(dir, 'screens/labSettings.ts', 'REPORT_ENABLED'), reason: 'default of globalSettings.SYSTEM.REPORT_ENABLED differs from settingsDefaults, whose value the map keeps' },
      { file: 'screens/reportSettings.ts', line: 3, reason: `default of globalSettings.SYSTEM.PAGE_SIZE differs from the one at ${at('PAGE_SIZE')}, so the map leaves it unknown` },
      { file: 'screens/Inbox.tsx', line: lineOf(dir, 'screens/Inbox.tsx', 'INBOX_TITLE'), reason: 'readSettings is called here but not as const <name> = readSettings({ … }) or export default readSettings({ … }), so what it returns is not read as settings' },
    ]);
  });
});

test('extract prints the settings function calls it could not read in files the route files lead to and the functions called in none of them', async () => {
  const other = { ...READ_SETTINGS, name: 'readOther' };
  await inCopy({ settingsFunctions: [READ_SETTINGS, other] }, async (dir, configFile) => {
    const run = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.split('\n').filter((l) => l.includes('settingsFunctions'));
    assert.deepEqual(lines, [
      '  settingsFunctions readOther from ./settings/readSettings is called in no file the route files lead to by import',
      `  settingsFunctions screens/labSettings.ts:${lineOf(dir, 'screens/labSettings.ts', 'REPORT_ENABLED')} default of globalSettings.SYSTEM.REPORT_ENABLED differs from settingsDefaults, whose value the map keeps`,
      `  settingsFunctions screens/reportSettings.ts:3 default of globalSettings.SYSTEM.PAGE_SIZE differs from the one at screens/labSettings.ts:${lineOf(dir, 'screens/labSettings.ts', 'PAGE_SIZE')}, so the map leaves it unknown`,
      `  settingsFunctions screens/Inbox.tsx:${lineOf(dir, 'screens/Inbox.tsx', 'INBOX_TITLE')} readSettings is called here but not as const <name> = readSettings({ … }) or export default readSettings({ … }), so what it returns is not read as settings`,
    ]);
  });
});

test('without settingsFunctions the same source gives the map it gave before, with no settings function notices', async () => {
  const fixture = await buildMap(loadConfig(path.join(FIXTURE, 'config.json')));
  await inCopy({}, async (dir, configFile) => {
    const map = await buildMap(loadConfig(configFile));
    assert.equal('settingsCallNotices' in map, false);
    assert.deepEqual(map.settingsDefaults, fixture.settingsDefaults);
    assert.deepEqual(screen(map, '/lab#Lab').settingReads, []);
    assert.deepEqual(screen(map, '/outbox#Outbox').access.route, []);
    assert.equal(screen(map, '/outbox#Outbox').access.restricted, false);
  });
});

test('a settings function config that is not { import, name, root, section } with a root from settingsRoots, or whose relative import names no file, stops the run', async () => {
  const refused = (entry, message) => inCopy({ settingsFunctions: [entry] }, async (dir, configFile) => assert.throws(() => loadConfig(configFile), message));
  await refused({ ...READ_SETTINGS, root: 'settings' }, /settingsFunctions root "settings" is not listed in settingsRoots/);
  await refused({ ...READ_SETTINGS, defaults: true }, /settingsFunctions must be a list of \{ "import", "name", "root", "section" \}/);
  await refused({ ...READ_SETTINGS, section: 'SYSTEM.MENU' }, /settingsFunctions must be a list/);
  await refused({ ...READ_SETTINGS, name: 'read-settings' }, /settingsFunctions must be a list/);
  await inCopy({ settingsFunctions: [{ ...READ_SETTINGS, import: './settings/gone' }] }, async (dir, configFile) => {
    await assert.rejects(buildMap(loadConfig(configFile)), /settingsFunctions import \.\/settings\/gone names no file under srcRoot/);
  });
});

test('a settings function imported through a file that re-exports it, and a result exported through one, are read as settings', async () => {
  const files = {
    ...FILES,
    'client/src/settings/index.ts': "export { readSettings } from './readSettings';\n",
    'client/src/screens/profileSettings.ts': "import { readSettings } from '../settings';\n\nexport const profileSettings = readSettings({ PROFILE_BADGE: true });\n",
    'client/src/screens/allSettings.ts': "export { default as labSettings } from './labSettings';\nexport * from './reportSettings';\nexport * from './profileSettings';\n",
  };
  const edits = [
    ...EDITS,
    ['client/src/screens/Profile.tsx', "import type { Settings } from '../store/settings';", "import type { Settings } from '../store/settings';\nimport { labSettings, profileSettings, reportSettings } from './allSettings';"],
    ['client/src/screens/Profile.tsx', '<section>', '<section title={`${labSettings.LAB_TITLE} ${reportSettings.REPORT_LIMIT} ${profileSettings.PROFILE_BADGE}`}>'],
  ];
  await inCopy({ settingsFunctions: [READ_SETTINGS] }, async (dir, configFile) => {
    const map = await buildMap(loadConfig(configFile));
    const keys = screen(map, '/profile#LazyPage.Profile').settingReads.map((r) => r.key).sort();
    assert.deepEqual(keys, ['SYSTEM.LAB_TITLE', 'SYSTEM.PROFILE_BADGE', 'SYSTEM.REPORT_ENABLED', 'SYSTEM.REPORT_LIMIT']);
    assert.equal(map.settingsDefaults.globalSettings.SYSTEM.PROFILE_BADGE, true);
  }, { files, edits });
});

test('a settings function called in a file the route files do not lead to, such as a test, gives no default and no notice', async () => {
  const files = {
    ...FILES,
    'client/src/screens/labSettings.test.ts': "import { readSettings } from '../settings/readSettings';\n\nconst testSettings = readSettings({ LAB_BETA: true, ONLY_IN_TEST: 1, REPORT_ENABLED: false });\n\nexport default testSettings;\n",
  };
  await inCopy({ settingsFunctions: [READ_SETTINGS] }, async (dir, configFile) => {
    const map = await buildMap(loadConfig(configFile));
    assert.deepEqual(map.settingsDefaults.globalSettings.SYSTEM, { LAB_ENABLED: false, REPORT_ENABLED: true, OUTBOX_ENABLED: false, ARCHIVE_DAYS: 30, LAB_BETA: false, REPORT_LIMIT: 10 });
    assert.deepEqual(map.settingsCallNotices.filter((n) => n.file === 'screens/labSettings.test.ts'), []);
  }, { files });
});

test('two calls passing a default the source does not show in full are not said to differ', async () => {
  const files = {
    ...FILES,
    'client/src/screens/paging.ts': 'export const PAGE = Number(globalThis.PAGE ?? 20);\n',
    'client/src/screens/labSettings.ts': FILES['client/src/screens/labSettings.ts'].replace("import { titleOf } from './scheduleReport';", "import { titleOf } from './scheduleReport';\nimport { PAGE } from './paging';").replace('PAGE_SIZE: 20', 'PAGE_SIZE: PAGE'),
    'client/src/screens/reportSettings.ts': "import { readSettings } from '../settings/readSettings';\nimport { PAGE } from './paging';\n\nexport const reportSettings = readSettings({ PAGE_SIZE: PAGE, REPORT_LIMIT: 10 } as const);\n",
  };
  await inCopy({ settingsFunctions: [READ_SETTINGS] }, async (dir, configFile) => {
    const map = await buildMap(loadConfig(configFile));
    const pageSize = map.settingsCallNotices.filter((n) => n.reason.includes('PAGE_SIZE'));
    assert.deepEqual(pageSize, [{
      file: 'screens/reportSettings.ts',
      line: 4,
      reason: `the map cannot tell whether the default of globalSettings.SYSTEM.PAGE_SIZE here is the one at screens/labSettings.ts:${lineOf(dir, 'screens/labSettings.ts', 'PAGE_SIZE')}, since the source does not show both in full, so it leaves the default unknown`,
    }]);
    assert.equal(Object.hasOwn(map.settingsDefaults.globalSettings.SYSTEM, 'PAGE_SIZE'), false);
    assert.ok(map.settingsDefaultsIncomplete.globalSettings.some((p) => p.join('.') === 'SYSTEM.PAGE_SIZE'));
  }, { files });
});

test('a symbolic link under srcRoot that points nowhere does not stop the run', async () => {
  await inCopy({ settingsFunctions: [READ_SETTINGS] }, async (dir, configFile) => {
    fs.symlinkSync(path.join(dir, 'client/src/screens/missing.ts'), path.join(dir, 'client/src/screens/gone.ts'));
    const map = await buildMap(loadConfig(configFile));
    assert.ok(screen(map, '/lab#Lab'));
  });
});

test('the README and the agent skill say what settingsFunctions takes and what its summary lines mean', () => {
  const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
  assert.match(read('../README.md'), /`settingsFunctions` — functions whose returned object holds settings[\s\S]*`\{ "import", "name", "root", "section" \}`/);
  assert.match(read('../README.md'), /`settingsFunctions <file>:<line> <what>`/);
  const entry = read('../README.md').split('\n- ').find((item) => item.startsWith('`settingsFunctions` —'));
  assert.doesNotMatch(entry, /is a read of/, 'which reads count is fixed by the tests, not written in the README');
  assert.match(read('../skills/duru/SKILL.md'), /add the function to\s+`settingsFunctions` as `\{ "import", "name", "root", "section" \}`/);
  assert.match(read('../skills/duru/SKILL.md'), /Lines starting with `settingsFunctions` in the `extract` summary/);
});
