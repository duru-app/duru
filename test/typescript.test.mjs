import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { buildMap } from '../src/map.mjs';
import { linkTests } from '../src/test-links.mjs';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/ts-app');
const CLI = path.join(import.meta.dirname, '../src/cli.mjs');
const buildFixture = (dir = FIXTURE) => buildMap(loadConfig(path.join(dir, 'config.json')));

async function inCopy(edits, fn) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    for (const [rel, from, to] of edits) {
      const file = path.join(copy, rel);
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(src.includes(from), `${rel} has no ${from}`);
      fs.writeFileSync(file, src.split(from).join(to));
    }
    return await fn(copy);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const screen = (map, id) => map.screens.find((s) => s.id === id);
const setting = (key, need, value) => ({ root: 'globalSettings', path: key.split('.'), need, default: value });
const LAB_ON = setting('SYSTEM.LAB_ENABLED', 'on', false);
const REPORT_ON = setting('SYSTEM.REPORT_ENABLED', 'on', true);

test('extraction runs to the end on a client mixing TypeScript and JavaScript files and finds its screens, the links between them and the setting conditions', async () => {
  const map = await buildFixture();
  assert.deepEqual(map.screens.map((s) => [s.id, s.componentFile]), [
    ['/home#Home', 'screens/Home.tsx'],
    ['/document#DocumentList', 'screens/DocumentList.jsx'],
    ['/document/:id#DocumentDetail', 'screens/DocumentDetail.js'],
    ['/admin#Admin', 'screens/Admin.tsx'],
    ['/lab#Lab', 'screens/Lab.tsx'],
    ['/report#Report', 'screens/Report.ts'],
  ]);
  assert.deepEqual(
    map.screens.flatMap((s) => s.access.links.map((l) => `${l.from} → ${s.id} ${l.file}:${l.line}`)),
    [
      '/document/:id#DocumentDetail → /home#Home screens/DocumentDetail.js:5',
      '/home#Home → /document#DocumentList screens/Home.tsx:14',
      '/lab#Lab → /document#DocumentList screens/Lab.tsx:13',
      '/document#DocumentList → /document/:id#DocumentDetail screens/DocumentList.jsx:9',
      '/home#Home → /document/:id#DocumentDetail screens/Home.tsx:15',
      '/home#Home → /admin#Admin screens/Home.tsx:16',
      '/home#Home → /lab#Lab components/Banner.tsx:7',
      '/home#Home → /report#Report screens/Home.tsx:17',
    ],
  );
  assert.deepEqual(Object.fromEntries(map.screens.filter((s) => s.access.restricted).map((s) => [s.id, s.access.kinds])), {
    '/admin#Admin': ['role'],
    '/lab#Lab': ['setting'],
    '/report#Report': ['setting'],
  });
  assert.deepEqual(screen(map, '/lab#Lab').access.settings, [{ from: 'route', needs: [LAB_ON], unreadable: [] }]);
  assert.deepEqual(screen(map, '/report#Report').access.settings, [{ from: '/home#Home', file: 'screens/Home.tsx', line: 17, needs: [REPORT_ON], unreadable: [] }]);
  assert.deepEqual(map.settingsDefaults, { globalSettings: { SYSTEM: { LAB_ENABLED: false, REPORT_ENABLED: true } } });
  assert.deepEqual(map.settingsDefaultsIncomplete, { globalSettings: [] });
});

const WITHOUT_WRAPPERS = [
  ['client/src/Routes.tsx', 'Option.ROUTE_PATH.HOME as string', 'Option.ROUTE_PATH.HOME'],
  ['client/src/Routes.tsx', 'Option.ROUTE_PATH.DOCUMENT!', 'Option.ROUTE_PATH.DOCUMENT'],
  ['client/src/Routes.tsx', '(memberRole as Role)', 'memberRole'],
  ['client/src/Routes.tsx', 'globalSettings!.SYSTEM.LAB_ENABLED as boolean', 'globalSettings!.SYSTEM.LAB_ENABLED'],
  ['client/src/Routes.tsx', 'globalSettings!.SYSTEM', 'globalSettings.SYSTEM'],
  ['client/src/Routes.tsx', 'Option.ROUTE_PATH.REPORT satisfies string', 'Option.ROUTE_PATH.REPORT'],
  ['client/src/screens/Home.tsx', '(Option.ROUTE_PATH.DOCUMENT as string)', 'Option.ROUTE_PATH.DOCUMENT'],
  ['client/src/screens/Home.tsx', 'Option.ROUTE_PATH.DOCUMENT as string', 'Option.ROUTE_PATH.DOCUMENT'],
  ['client/src/screens/Home.tsx', 'recent!', 'recent'],
  ['client/src/screens/Home.tsx', '(memberRole as string)', 'memberRole'],
  ['client/src/screens/Home.tsx', '(globalSettings as Settings)', 'globalSettings'],
  ['client/src/screens/Lab.tsx', '{ ids, signedOnly: true } as ArchiveBody', '{ ids, signedOnly: true }'],
  ['client/src/screens/Lab.tsx', "session!['member.role']", "session['member.role']"],
  ['client/src/screens/scheduleReport.ts', '<ScheduleBody>{', '{'],
  ['client/src/screens/Report.ts', '(globalSettings satisfies Settings)', 'globalSettings'],
  ['client/src/screens/Report.ts', ' satisfies Record<string, unknown>', ''],
  ['client/src/store/settings.ts', 'false as boolean', 'false'],
  ['client/src/store/settings.ts', '} satisfies Settings;', '};'],
];

test('a setting read, a route address with a value appended and a request body option wrapped in as, satisfies or ! are read as if the wrapper were not there', async () => {
  const wrapped = await buildFixture();
  const plain = await inCopy(WITHOUT_WRAPPERS, (copy) => buildFixture(copy));
  const shown = WITHOUT_WRAPPERS.reduce((json, [, from, to]) => json.split(from).join(to), JSON.stringify({ ...wrapped, meta: null }));
  assert.deepEqual(JSON.parse(shown), { ...plain, meta: null });

  const home = screen(wrapped, '/home#Home');
  assert.deepEqual(home.links.filter((l) => l.file === 'screens/Home.tsx').map((l) => [l.line, l.to, l.tail ?? null]), [
    [14, '/document', null],
    [15, '/document/{*}', '/{*}'],
    [16, '/admin', null],
    [17, '/report', null],
  ]);
  assert.deepEqual(wrapped.screens.flatMap((s) => s.settingReads.map((r) => `${s.id} ${r.file}:${r.line} ${r.key}`)), [
    '/home#Home screens/Home.tsx:17 SYSTEM.REPORT_ENABLED',
    '/report#Report screens/Report.ts:6 SYSTEM.REPORT_ENABLED',
  ]);
  assert.deepEqual(wrapped.calls.map((c) => [c.id, c.options.map((o) => `${o.key} ${o.sites.map((s) => `${s.file}:${s.line}`).join(',')}`)]), [
    ['POST:/api/v1/report/archive', ['signedOnly screens/Lab.tsx:11']],
    ['POST:/api/v1/report/schedule', ['monthly screens/Report.ts:7', 'notify screens/scheduleReport.ts:6', 'weekly screens/scheduleReport.ts:6']],
  ]);
  assert.deepEqual(wrapped.screens.map((s) => s.path), ['/home', '/document', '/document/:id', '/admin', '/lab', '/report']);
});

test('a route condition in a TypeScript route file is read as a condition, and the role values are read from conditions holding type syntax, showing the condition as written', async () => {
  const map = await buildFixture();
  assert.deepEqual(screen(map, '/admin#Admin').access.route, [{ guard: "(memberRole as Role) === 'ADMIN'", kinds: ['role'], roles: ['ADMIN'] }]);
  assert.deepEqual(screen(map, '/admin#Admin').access.roleValues, ['ADMIN']);
  assert.deepEqual(screen(map, '/lab#Lab').access.route, [{ guard: 'globalSettings!.SYSTEM.LAB_ENABLED as boolean', kinds: ['setting'], settings: [LAB_ON] }]);
  const conditions = (id, file, line) => screen(map, id).links.find((l) => l.file === file && l.line === line).conditions;
  assert.deepEqual(conditions('/home#Home', 'screens/Home.tsx', 16), [{ guard: "(memberRole as string) === 'ADMIN'", kinds: ['role'], roles: ['ADMIN'] }]);
  assert.deepEqual(conditions('/lab#Lab', 'screens/Lab.tsx', 13), [{ guard: "session!['member.role'] === 'AUDITOR'", kinds: ['role'], roles: ['AUDITOR'] }]);
  assert.deepEqual(conditions('/home#Home', 'screens/Home.tsx', 17), [{ guard: '(globalSettings as Settings).SYSTEM.REPORT_ENABLED', kinds: ['setting'], settings: [REPORT_ON] }]);
});

test('the setting reads and links of a file imported or re-exported only for its types do not attach to the screen, and a file imported on a line mixing values and types is followed', async () => {
  const map = await buildFixture();
  const home = screen(map, '/home#Home');
  assert.deepEqual(home.sourceFiles, ['components/Banner.tsx', 'components/index.ts', 'screens/Home.tsx']);
  assert.deepEqual(home.links.map((l) => `${l.file}:${l.line} ${l.to}`), [
    'screens/Home.tsx:14 /document',
    'screens/Home.tsx:15 /document/{*}',
    'screens/Home.tsx:16 /admin',
    'screens/Home.tsx:17 /report',
    'components/Banner.tsx:7 /lab',
  ]);
  assert.deepEqual(home.settingReads.map((r) => r.file), ['screens/Home.tsx']);
  assert.deepEqual(screen(map, '/report#Report').sourceFiles, ['screens/Report.ts']);
  assert.equal(map.screens.some((s) => s.sourceFiles.includes('components/Badge.tsx')), false);
});

test('a unit test file written in TypeScript links the screen whose file it imports, and not the screen it imports only for its types', async () => {
  const config = loadConfig(path.join(FIXTURE, 'config.json'));
  const links = linkTests(config, await buildMap(config));
  assert.deepEqual(
    Object.fromEntries(Object.entries(links.importers).map(([id, tests]) => [id, tests.map((t) => `${t.title} | ${t.testFile} | ${t.via.join(', ')}`)])),
    { '/lab#Lab': ['Lab › renders the archive button | screens/Lab.test.ts | screens/Lab.tsx'] },
  );
  assert.deepEqual(links.importNotices, []);
});

test('a condition holding type syntax is still told apart as a role or setting condition next to import.meta, right after a keyword and right before one', async () => {
  const kindsOf = async (from, to, target) => inCopy([['client/src/screens/Home.tsx', from, to]], async (copy) => {
    const map = await buildFixture(copy);
    return screen(map, '/home#Home').links.find((l) => l.to === target).conditions.map((c) => c.kinds);
  });
  assert.deepEqual(await kindsOf('{(globalSettings as Settings).SYSTEM.REPORT_ENABLED && ', '{import.meta.env.DEV && (globalSettings as Settings).SYSTEM.REPORT_ENABLED && ', '/report'), [['setting']]);
  assert.deepEqual(await kindsOf("{(memberRole as string) === 'ADMIN' && ", "{typeof(memberRole as string) === 'string' && ", '/admin'), [['role']]);
  assert.deepEqual(await kindsOf("{(memberRole as string) === 'ADMIN' && ", "{memberRole!in ROLES && ", '/admin'), [['role']]);
});

test('an error the parser reports but can read past does not stop the extraction, in a TypeScript file as in a JavaScript one', async () => {
  const cases = [
    ['client/src/screens/Report.ts', 'return null;', 'const a = 1 const b = 2; return null;'],
    ['client/src/screens/DocumentDetail.js', 'export default function DocumentDetail() {', 'const a = 1 const b = 2;\nexport default function DocumentDetail() {'],
    ['client/src/components/index.ts', "export { type BannerProps, Banner } from './Banner';", "export { Banner };\nexport type { BannerProps };\nimport { Banner, type BannerProps } from './Banner';"],
  ];
  for (const edit of cases) {
    await inCopy([edit], async (copy) => assert.equal((await buildFixture(copy)).screens.length, 6, edit[0]));
  }
});

test('a declaration file and an import with an assert clause do not stop the extraction', async () => {
  const imports = "import './env.d';\nimport labels from './labels.json' assert { type: 'json' };\nexport default function Report";
  await inCopy([['client/src/screens/Report.ts', 'export default function Report', imports]], async (copy) => {
    fs.writeFileSync(path.join(copy, 'client/src/screens/env.d.ts'), 'export const API_URL: string;\ndeclare function load(name: string): void;\n');
    assert.equal((await buildFixture(copy)).screens.length, 6);
  });
});

test('a unit test file that cannot be read is reported with the place of the syntax error, and the map is still built', () =>
  inCopy([['client/src/screens/Lab.test.ts', "const ids = ['d1'] as string[];", "const ids = ['d1'] as;"]], async (copy) => {
    const config = loadConfig(path.join(copy, 'config.json'));
    const links = linkTests(config, await buildMap(config));
    assert.deepEqual(links.importNotices, [
      { file: '/builds/client/src/screens/Lab.test.ts', reason: '테스트 파일을 읽지 못했습니다: 5:22: Unexpected token' },
    ]);
  }));

test('each file is read in the grammar its extension names, and a file that cannot be read stops the extraction with its path, line and column', async () => {
  const cases = [
    ['screens/Lab.tsx', '{ ids, signedOnly: true } as ArchiveBody', '<ArchiveBody>{ ids, signedOnly: true }', '11:86: Unexpected token, expected "}"'],
    ['screens/DocumentDetail.js', 'export default function DocumentDetail() {', 'export default function DocumentDetail(): null {', '4:41: Unexpected token, expected "{"'],
    ['store/settings.ts', 'false as boolean', 'false as', '5:26: Unexpected token'],
  ];
  for (const [rel, from, to, place] of cases) {
    await inCopy([[`client/src/${rel}`, from, to]], async (copy) => {
      await assert.rejects(buildFixture(copy), { message: `${path.join(copy, 'client/src', rel)}:${place}` });
    });
  }
});

test('extract stops with one line naming the file, line and column of a syntax error, and writes no map', () =>
  inCopy([['client/src/screens/Report.ts', 'return null;', 'return null as;']], (copy) => {
    const result = spawnSync(process.execPath, [CLI, 'extract', path.join(copy, 'config.json')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${path.join(copy, 'client/src/screens/Report.ts')}:8:17: Unexpected token\n`);
    assert.equal(fs.existsSync(path.join(copy, 'out/map.json')), false);
  }));

const SETTINGS_FROM_FILE = [
  ['config.json', '"constant": "Settings.appSettings"', '"file": "store/settings.ts",\n      "const": "defaults"'],
];

test('route paths a function builds in a TypeScript constants module, and settings defaults a function builds, are read as values', async () => {
  const map = await buildFixture();
  assert.deepEqual(map.screens.map((s) => s.path), ['/home', '/document', '/document/:id', '/admin', '/lab', '/report']);
  assert.deepEqual(screen(map, '/lab#Lab').access.route, [{ guard: 'globalSettings!.SYSTEM.LAB_ENABLED as boolean', kinds: ['setting'], settings: [LAB_ON] }]);
  const fromFile = await inCopy(SETTINGS_FROM_FILE, (copy) => buildFixture(copy));
  assert.deepEqual({ ...map, meta: null }, { ...fromFile, meta: null });
});

test('settings defaults can come from a module kept beside the duru config that calls a function of the client', async () => {
  const fromAdapter = await inCopy([
    ['config.json', '"Settings": "store/index.ts"', '"Settings": "../../duru/defaults.ts"'],
    ['config.json', '"constant": "Settings.appSettings"', '"constant": "Settings"'],
  ], (copy) => {
    fs.mkdirSync(path.join(copy, 'duru'));
    fs.writeFileSync(path.join(copy, 'duru/defaults.ts'), [
      "import { createSettings } from '../client/src/store/createSettings';",
      "import type { Settings } from '../client/src/store/settings';",
      '',
      'const defaults: Settings = createSettings({ SYSTEM: { REPORT_ENABLED: false } });',
      'export default defaults;',
      '',
    ].join('\n'));
    return buildFixture(copy);
  });
  assert.deepEqual(fromAdapter.settingsDefaults, { globalSettings: { SYSTEM: { LAB_ENABLED: false, REPORT_ENABLED: false } } });
  assert.deepEqual(fromAdapter.settingsDefaultsIncomplete, { globalSettings: [] });
});

test('a settings root given both ways, a constant path not starting with a constants name, or one that holds no object, stops with what is wrong', async () => {
  await assert.rejects(
    inCopy([['config.json', '"constant": "Settings.appSettings"', '"constant": "Settings.appSettings",\n      "file": "store/settings.ts",\n      "const": "defaults"']], (copy) => buildFixture(copy)),
    /settingsDefaults\.globalSettings takes either "file" and "const" or "constant", not both/,
  );
  await assert.rejects(
    inCopy([['config.json', '"constant": "Settings.appSettings"', '"constant": "Store.appSettings"']], (copy) => buildFixture(copy)),
    /settingsDefaults\.globalSettings\.constant "Store\.appSettings" starts with "Store", which is not a name in constants/,
  );
  await assert.rejects(
    inCopy([['config.json', '"constant": "Settings.appSettings"', '"constant": "Settings.missing"']], (copy) => buildFixture(copy)),
    /settingsDefaults\.globalSettings: constant Settings\.missing is not an object but undefined/,
  );
});

test('a constants module importing a TypeScript file that a value import and a type import both name runs, and extract prints no warning about stripping types', () => inCopy([], (copy) => {
  const result = spawnSync(process.execPath, [CLI, 'extract', path.join(copy, 'config.json')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const map = JSON.parse(fs.readFileSync(path.join(copy, 'out/map.json'), 'utf8'));
  assert.deepEqual(map.settingsDefaults, { globalSettings: { SYSTEM: { LAB_ENABLED: false, REPORT_ENABLED: true } } });
}));

test('a TypeScript import whose names are used only as types, written without the type keyword, is dropped before the constants module runs', async () => {
  const map = await inCopy([
    ['client/src/store/createSettings.ts', "import { defaults } from './settings';\nimport type { Settings } from './settings';", "import { defaults, Settings } from './settings';"],
    ['client/src/store/index.ts', "import type { Settings } from './settings';", "import { Settings } from './settings';"],
  ], (copy) => buildFixture(copy));
  assert.deepEqual(map.settingsDefaults, { globalSettings: { SYSTEM: { LAB_ENABLED: false, REPORT_ENABLED: true } } });
});

test('a constants module that fails to run names the source file, not the copy duru runs', async () => {
  await assert.rejects(
    inCopy([['client/src/_define/Option.ts', "import { joinPath } from './paths';", "import { joinPath } from './paths';\nimport { produce } from 'immer';\nproduce();"]], (copy) => buildFixture(copy)),
    (e) => {
      assert.match(e.message, /^constants\.Option: \S+client\/src\/_define\/Option\.ts:3: The requested module 'immer' does not provide an export named 'produce'$/);
      return true;
    },
  );
});

test('a module listed in constants only for settings defaults stays among the source files of the screens that import it', async () => {
  const importStore = [['client/src/screens/Lab.tsx', "import { scheduleReport } from './scheduleReport';", "import { scheduleReport } from './scheduleReport';\nimport { appSettings } from '../store';\nexport const labSettings = appSettings;"]];
  const fromConstant = await inCopy(importStore, (copy) => buildFixture(copy));
  const fromFile = await inCopy([...importStore, ...SETTINGS_FROM_FILE, ['config.json', ',\n    "Settings": "store/index.ts"', '']], (copy) => buildFixture(copy));
  assert.ok(screen(fromConstant, '/lab#Lab').sourceFiles.includes('store/index.ts'));
  assert.deepEqual(screen(fromConstant, '/lab#Lab').sourceFiles, screen(fromFile, '/lab#Lab').sourceFiles);
});

test('a constant path that points at the function building the defaults says so', async () => {
  await assert.rejects(
    inCopy([
      ['config.json', '"Settings": "store/index.ts"', '"Settings": "store/index.ts",\n    "Factory": "store/createSettings.ts"'],
      ['config.json', '"constant": "Settings.appSettings"', '"constant": "Factory.createSettings"'],
    ], (copy) => buildFixture(copy)),
    /settingsDefaults\.globalSettings: constant Factory\.createSettings is not an object but a function: point at the value it returns/,
  );
});

test('a default or namespace import used only as a type next to a used one is dropped, and an error after a dropped import spread over several lines names the line in the source', async () => {
  const map = await inCopy([
    ['client/src/store/settings.ts', 'export type Settings =', 'export default interface Shape { SYSTEM: object }\nexport type Settings ='],
    ['client/src/store/createSettings.ts', "import { defaults } from './settings';\nimport type { Settings } from './settings';", "import Shape, { defaults } from './settings';\nimport * as Types from './settings';\nimport Option, * as Unused from '../_define/Option';\nimport type { Settings } from './settings';\ntype Kept = Shape | Types.Settings | Unused.Kind;\nconst option = Option;"],
  ], (copy) => buildFixture(copy));
  assert.deepEqual(map.settingsDefaults, { globalSettings: { SYSTEM: { LAB_ENABLED: false, REPORT_ENABLED: true } } });

  await assert.rejects(
    inCopy([['client/src/store/index.ts', "import type { Settings } from './settings';", "import {\n  Settings,\n} from './settings';\nmissing();"]], (copy) => buildFixture(copy)),
    (e) => {
      assert.match(e.message, /^constants\.Settings: \S+client\/src\/store\/index\.ts:5: missing is not defined$/);
      return true;
    },
  );
});

test('an import used only by a type-only export, or written with comments and line breaks between its names, is rewritten keeping the lines of the source', async () => {
  const map = await inCopy([
    ['client/src/store/settings.ts', 'export type Settings =', 'export default interface Shape { SYSTEM: object }\nexport type Settings ='],
    ['client/src/store/createSettings.ts', "import { defaults } from './settings';", "import Shape /* a, b */, {\n  defaults,\n} from './settings';\nimport { Settings as Exported } from './settings';\nexport type { Shape };\nexport { type Exported };"],
  ], (copy) => buildFixture(copy));
  assert.deepEqual(map.settingsDefaults, { globalSettings: { SYSTEM: { LAB_ENABLED: false, REPORT_ENABLED: true } } });

  await assert.rejects(
    inCopy([['client/src/store/index.ts', "import { createSettings } from './createSettings';", "import Option,\n  * as Unused from '../_define/Option';\ntype Kept = Unused.Kind;\nconst kept = Option;\nmissing();\nimport { createSettings } from './createSettings';"]], (copy) => buildFixture(copy)),
    (e) => {
      assert.match(e.message, /^constants\.Settings: \S+client\/src\/store\/index\.ts:5: /);
      return true;
    },
  );
});

test('every import of the same outside package in the constants modules gets one stand-in module, so state it holds is shared', async () => {
  const map = await inCopy([
    ['config.json', '"apiModules"', '"constantStubs": {\n    "registry": "export const reg = new Map();"\n  },\n  "apiModules"'],
    ['client/src/_define/paths.ts', 'export type RouteKey', "import { reg } from 'registry';\nreg.set('paths', true);\n\nexport type RouteKey"],
    ['client/src/_define/Option.ts', "import { joinPath } from './paths';", "import { joinPath } from './paths';\nimport { reg } from 'registry';\nif (reg.size !== 1) throw new Error('registry not shared');"],
  ], (copy) => buildFixture(copy));
  assert.ok(map.screens.length);
});

test('a constant path that holds text shows the text in quotes', async () => {
  await assert.rejects(
    inCopy([['config.json', '"constant": "Settings.appSettings"', '"constant": "Option.ROUTE_PATH.HOME"']], (copy) => buildFixture(copy)),
    /constant Option\.ROUTE_PATH\.HOME is not an object but "\/home"$/,
  );
});

test('imports and re-exports whose names are all marked type, a relative import that finds no file, and a source on another line than the names keep the constants module running with the lines of the source', async () => {
  const map = await inCopy([
    ['client/src/store/index.ts', "import type { Settings } from './settings';", "import { type Settings } from './settings';\nexport { type Settings as Shown } from './settings';\nexport * from './settings';\nimport { createSettings as\n  build }\n  from './createSettings'\n;"],
    ['client/src/store/index.ts', 'createSettings((window', 'build((window'],
  ], (copy) => buildFixture(copy));
  assert.deepEqual(map.settingsDefaults, { globalSettings: { SYSTEM: { LAB_ENABLED: false, REPORT_ENABLED: true } } });

  await assert.rejects(
    inCopy([['client/src/store/index.ts', "import type { Settings } from './settings';", "import { type Settings } from './settings';\nimport Kept, { defaults }\n  from './settings'\n;\nlet seen: Kept = defaults;\nmissing();"]], (copy) => buildFixture(copy)),
    (e) => {
      assert.match(e.message, /^constants\.Settings: \S+client\/src\/store\/index\.ts:7: missing is not defined$/);
      return true;
    },
  );
});

test('relative imports of the same missing file with the same stand-in share it, while another folder or another stand-in gets its own', async () => {
  const map = await inCopy([
    ['config.json', '"apiModules"', '"constantStubs": {\n    "./gone": "export const marks = [];",\n    "../_define/gone": "export const marks = [];\\nexport const other = 1;"\n  },\n  "apiModules"'],
    ['client/src/_define/paths.ts', 'export type RouteKey', "import { marks } from './gone';\nmarks.push('paths');\n\nexport type RouteKey"],
    ['client/src/store/settings.ts', 'export type Settings =', "import { marks } from './gone';\nif (marks.length) throw new Error('another folder shares');\nimport { marks as same, other } from '../_define/gone';\nif (same.length || other !== 1) throw new Error('another stand-in shares');\n\nexport type Settings ="],
    ['client/src/_define/Option.ts', "import { joinPath } from './paths';", "import { joinPath } from './paths';\nimport { marks } from './gone';\nexport * from './gone';\nif (marks.length !== 1) throw new Error('stand-ins not shared');"],
  ], (copy) => buildFixture(copy));
  assert.ok(map.screens.length);
});

test('a type-only import removed between two statements written without semicolons leaves them apart', async () => {
  const map = await inCopy([
    ['client/src/_define/Option.ts', "import { joinPath } from './paths';", "import { joinPath } from './paths';\nconst join = joinPath\nimport type { RouteKey as Key } from './paths'\n[1].forEach(() => join)\nimport { RouteKey as Typed } from './paths'\n[2].forEach((k: Typed) => join)"],
  ], (copy) => buildFixture(copy));
  assert.ok(map.screens.length);
});

test('an outside package named like a member of every object gets the empty stand-in, and a stand-in that is not source text is refused', async () => {
  const map = await inCopy([
    ['client/src/_define/Option.ts', "import { joinPath } from './paths';", "import { joinPath } from './paths';\nimport made from 'constructor';\nif (JSON.stringify(made) !== '{}') throw new Error('not the empty stand-in');"],
  ], (copy) => buildFixture(copy));
  assert.ok(map.screens.length);
  await assert.rejects(
    inCopy([['config.json', '"apiModules"', '"constantStubs": {\n    "left-out": null\n  },\n  "apiModules"']], (copy) => buildFixture(copy)),
    /constantStubs must map imports to the module source that stands in for them/,
  );
});
