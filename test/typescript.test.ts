import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';
import { linkTests } from '../src/test-links.ts';

type Edit = string[];

const FIXTURE = path.join(import.meta.dirname, 'fixtures/ts-app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const buildFixture = (dir = FIXTURE) => buildMap(loadConfig(path.join(dir, 'config.json')));

async function inCopy<T>(edits: Edit[], fn: (copy: string) => T | Promise<T>): Promise<T> {
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

const screen = (map: ScreenMap, id: string) => map.screens.find((s) => s.id === id)!;
const setting = (key: string, need: string, value: boolean) => ({ root: 'globalSettings', path: key.split('.'), need, default: value });
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
    ['/archive#Archive', 'screens/Archive.tsx'],
    ['/profile#LazyPage.Profile', 'screens/Profile.tsx'],
    ['/inbox#Inbox', 'screens/Inbox.tsx'],
    ['/outbox#Outbox', 'screens/Outbox.tsx'],
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
      '/outbox#Outbox → /archive#Archive screens/Outbox.tsx:7',
      '/profile#LazyPage.Profile → /archive#Archive screens/Profile.tsx:6',
      '/archive#Archive → /profile#LazyPage.Profile screens/Archive.tsx:5',
      '/inbox#Inbox → /outbox#Outbox screens/Inbox.tsx:10',
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
  ['client/src/admin/AdminRoutes.tsx', '(memberRole as Role)', 'memberRole'],
  ['client/src/admin/AdminRoutes.tsx', 'globalSettings!.SYSTEM.LAB_ENABLED as boolean', 'globalSettings!.SYSTEM.LAB_ENABLED'],
  ['client/src/admin/AdminRoutes.tsx', 'globalSettings!.SYSTEM', 'globalSettings.SYSTEM'],
  ['client/src/admin/AdminRoutes.tsx', 'Option.ROUTE_PATH.REPORT satisfies string', 'Option.ROUTE_PATH.REPORT'],
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
    '/profile#LazyPage.Profile screens/Profile.tsx:6 SYSTEM.REPORT_ENABLED',
  ]);
  assert.deepEqual(wrapped.calls.map((c) => [c.id, c.options.map((o) => `${o.key} ${o.sites.map((s) => `${s.file}:${s.line}`).join(',')}`)]), [
    ['POST:/api/v1/report/archive', ['signedOnly screens/Lab.tsx:11']],
    ['POST:/api/v1/report/schedule', ['monthly screens/Report.ts:7', 'notify screens/scheduleReport.ts:6', 'weekly screens/scheduleReport.ts:6']],
  ]);
  assert.deepEqual(wrapped.screens.map((s) => s.path), ['/home', '/document', '/document/:id', '/admin', '/lab', '/report', '/archive', '/profile', '/inbox', '/outbox']);
});

test('a route condition in a TypeScript route file is read as a condition, and the role values are read from conditions holding type syntax, showing the condition as written', async () => {
  const map = await buildFixture();
  assert.deepEqual(screen(map, '/admin#Admin').access.route, [{ guard: "(memberRole as Role) === 'ADMIN'", kinds: ['role'], roles: ['ADMIN'] }]);
  assert.deepEqual(screen(map, '/admin#Admin').access.roleValues, ['ADMIN']);
  assert.deepEqual(screen(map, '/lab#Lab').access.route, [{ guard: 'globalSettings!.SYSTEM.LAB_ENABLED as boolean', kinds: ['setting'], settings: [LAB_ON] }]);
  const conditions = (id: string, file: string, line: number) => screen(map, id).links.find((l) => l.file === file && l.line === line)!.conditions;
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
  const kindsOf = async (from: string, to: string, target: string) => inCopy([['client/src/screens/Home.tsx', from, to]], async (copy) => {
    const map = await buildFixture(copy);
    return screen(map, '/home#Home').links.find((l) => l.to === target)!.conditions.map((c) => c.kinds);
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
    await inCopy([edit], async (copy) => assert.equal((await buildFixture(copy)).screens.length, 10, edit[0]));
  }
});

test('a declaration file and an import with an assert clause do not stop the extraction', async () => {
  const imports = "import './env.d';\nimport labels from './labels.json' assert { type: 'json' };\nexport default function Report";
  await inCopy([['client/src/screens/Report.ts', 'export default function Report', imports]], async (copy) => {
    fs.writeFileSync(path.join(copy, 'client/src/screens/env.d.ts'), 'export const API_URL: string;\ndeclare function load(name: string): void;\n');
    assert.equal((await buildFixture(copy)).screens.length, 10);
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

test('decorators on class fields, accessors, methods and classes, before or after export, and on TypeScript parameters, do not stop the extraction of .ts, .tsx, .js or .jsx screens', async () => {
  const typed = [
    'declare const dec: any;',
    '@dec export class Model { @dec value = 1; @dec accessor count = 0; @dec method() { return this.value; } constructor(@dec private readonly part: string) {} }',
    'export @dec class Other { @dec static kind = 2; }',
    '',
  ].join(' ');
  const untyped = [
    'const dec = () => {};',
    '@dec export class Model { @dec value = 1; @dec accessor count = 0; @dec method() { return this.value; } }',
    'export @dec class Other { @dec static kind = 2; }',
    '',
  ].join(' ');
  const before = await buildFixture();
  await inCopy([
    ['client/src/screens/Report.ts', 'export default function Report', `${typed}export default function Report`],
    ['client/src/screens/Lab.tsx', 'export default function Lab', `${typed}export default function Lab`],
    ['client/src/screens/DocumentDetail.js', 'export default function DocumentDetail', `${untyped}export default function DocumentDetail`],
    ['client/src/screens/DocumentList.jsx', 'export default function DocumentList', `${untyped}export default function DocumentList`],
  ], async (copy) => {
    const after = await buildFixture(copy);
    assert.deepEqual({ ...after, meta: null }, { ...before, meta: null });
  });
});

const SETTINGS_FROM_FILE = [
  ['config.json', '"constant": "Settings.appSettings"', '"file": "store/settings.ts",\n      "const": "defaults"'],
];

test('route paths a function builds in a TypeScript constants module from enum and namespace values, and settings defaults a function builds, are read as values', async () => {
  const map = await buildFixture();
  assert.deepEqual(map.screens.map((s) => s.path), ['/home', '/document', '/document/:id', '/admin', '/lab', '/report', '/archive', '/profile', '/inbox', '/outbox']);
  assert.deepEqual(map.screens.map((s) => s.id).filter((id) => /^\/(home|document|admin|lab)#/.test(id)), ['/home#Home', '/document#DocumentList', '/admin#Admin', '/lab#Lab']);
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
    (e: Error) => {
      assert.match(e.message, /^constants\.Option: \S+client\/src\/_define\/Option\.ts:3: The requested module 'immer' does not provide an export named 'produce'$/);
      return true;
    },
  );
  await assert.rejects(
    inCopy([['client/src/_define/Option.ts', 'function routePaths', "import { produce } from 'immer';\nproduce();\n\nfunction routePaths"]], (copy) => buildFixture(copy)),
    (e: Error) => {
      assert.match(e.message, /^constants\.Option: \S+client\/src\/_define\/Option\.ts:16: The requested module 'immer' does not provide an export named 'produce'$/);
      return true;
    },
  );
  await assert.rejects(
    inCopy([['client/src/_define/Option.ts', 'function routePaths', 'const segments = [Segment.Home,\n  Section.ADMIN, missing];\n\nfunction routePaths']], (copy) => buildFixture(copy)),
    (e: Error) => {
      assert.match(e.message, /^constants\.Option: \S+client\/src\/_define\/Option\.ts:17: missing is not defined$/);
      return true;
    },
  );
  await assert.rejects(
    inCopy([['client/src/_define/Option.ts', "  Document = 'document',\n}", "  Document = 'document',\n  Broken = missing(\n    1,\n    2,\n  ),\n}"]], (copy) => buildFixture(copy)),
    (e: Error) => {
      assert.match(e.message, /^constants\.Option: \S+client\/src\/_define\/Option\.ts:7: missing is not defined$/);
      return true;
    },
  );
});

test('a constants module importing a class that takes constructor parameter properties runs', async () => {
  const map = await inCopy([[
    'client/src/_define/paths.ts',
    'export const joinPath = (base: string, segment: string): string => `${base}/${segment}`;',
    [
      'class PathJoiner {',
      '  constructor(private readonly separator: string) {}',
      '',
      '  join(base: string, segment: string): string {',
      '    return `${base}${this.separator}${segment}`;',
      '  }',
      '}',
      '',
      "export const joinPath = (base: string, segment: string): string => new PathJoiner('/').join(base, segment);",
    ].join('\n'),
  ]], (copy) => buildFixture(copy));
  assert.deepEqual({ ...map, meta: null }, { ...(await buildFixture()), meta: null });
});

test('JSX in a .tsx file a constants module imports stops the extraction with the file', async () => {
  await assert.rejects(
    inCopy([['client/src/_define/Option.ts', "import { joinPath } from './paths';", "import { joinPath } from './paths';\nimport { label } from './label';\nexport const LABEL = label;"]], (copy) => {
      fs.writeFileSync(path.join(copy, 'client/src/_define/label.tsx'), 'export const label = <b>Home</b>;\n');
      return buildFixture(copy);
    }),
    /^Error: constants: cannot turn \S+client\/src\/_define\/label\.tsx into JavaScript: /,
  );
});

test('a CommonJS import or export in a TypeScript constants module stops the extraction with the file and line', async () => {
  for (const [line, shown] of [["import paths = require('./paths');", 'import … = require(…)'], ['export = {};', 'export =']]) {
    await assert.rejects(
      inCopy([['client/src/_define/Option.ts', "import { joinPath } from './paths';", `import { joinPath } from './paths';\n${line}`]], (copy) => buildFixture(copy)),
      (e: Error) => {
        assert.equal(e.message.replace(/\S+client\//, 'client/'), `constants: client/src/_define/Option.ts:3: \`${shown}\` is CommonJS, which duru cannot run as an ES module`);
        return true;
      },
    );
  }
});

test('a decorator in a file a constants module imports, on a field or on a TypeScript constructor parameter property, stops the extraction with the file, line and column', async () => {
  const cases = [
    ['store.ts', 'const dec = (v: unknown) => v;\nexport class Store {\n  @dec count = 0;\n}\n', '3:3'],
    ['store.js', 'const dec = (v) => v;\nexport class Store {\n  @dec count = 0;\n}\n', '3:3'],
    ['store.ts', 'const dec = (...v: unknown[]) => undefined;\nexport class Store {\n  constructor(@dec private readonly name: string) {}\n}\n', '3:15'],
  ];
  for (const [file, source, place] of cases) {
    await assert.rejects(
      inCopy([['client/src/_define/Option.ts', "import { joinPath } from './paths';", "import { joinPath } from './paths';\nimport { Store } from './store';\nexport const STORE = Store;"]], (copy) => {
        fs.writeFileSync(path.join(copy, 'client/src/_define', file), source);
        return buildFixture(copy);
      }),
      (e: Error) => {
        assert.equal(e.message.replace(/\S+client\//, 'client/'), `constants: client/src/_define/${file}:${place}: a decorator is not JavaScript that Node runs, so duru cannot run this file`);
        return true;
      },
    );
  }
});

test('a type-only CommonJS import in a TypeScript constants module is dropped before it runs', async () => {
  const map = await inCopy([['client/src/_define/Option.ts', "import { joinPath } from './paths';", "import { joinPath } from './paths';\nimport type Paths = require('./paths');"]], (copy) => buildFixture(copy));
  assert.deepEqual({ ...map, meta: null }, { ...(await buildFixture()), meta: null });
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
    (e: Error) => {
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
    (e: Error) => {
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
    (e: Error) => {
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

const ROUTES = 'client/src/Routes.tsx';
const ADMIN_ROUTES = 'client/src/admin/AdminRoutes.tsx';
const withoutMeta = (map: ScreenMap) => ({ ...map, meta: null });

test('a route written with element is a screen named after the element, or after the first argument of the call wrapping it, with its component file, route file and line', async () => {
  const map = await buildFixture();
  assert.deepEqual(map.screens.map((s) => [s.id, s.component, s.componentFile, s.routeFile, s.line]), [
    ['/home#Home', 'Home', 'screens/Home.tsx', 'Routes.tsx', 17],
    ['/document#DocumentList', 'DocumentList', 'screens/DocumentList.jsx', 'Routes.tsx', 18],
    ['/document/:id#DocumentDetail', 'DocumentDetail', 'screens/DocumentDetail.js', 'Routes.tsx', 19],
    ['/admin#Admin', 'Admin', 'screens/Admin.tsx', 'admin/AdminRoutes.tsx', 16],
    ['/lab#Lab', 'Lab', 'screens/Lab.tsx', 'admin/AdminRoutes.tsx', 17],
    ['/report#Report', 'Report', 'screens/Report.ts', 'admin/AdminRoutes.tsx', 18],
    ['/archive#Archive', 'Archive', 'screens/Archive.tsx', 'pages/PageRoutes.tsx', 10],
    ['/profile#LazyPage.Profile', 'LazyPage.Profile', 'screens/Profile.tsx', 'pages/PageRoutes.tsx', 11],
    ['/inbox#Inbox', 'Inbox', 'screens/Inbox.tsx', 'pages/MailRoutes.tsx', 9],
    ['/outbox#Outbox', 'Outbox', 'screens/Outbox.tsx', 'pages/MailRoutes.tsx', 10],
  ]);
});

test('routes passing a component to a wrapper declared in the route file are each named after the component they pass, and its sources are those of that component', async () => {
  const map = await buildFixture();
  assert.deepEqual(map.screens.filter((s) => ['Signed', 'Checked'].includes(s.component)), []);
  assert.deepEqual(screen(map, '/document/:id#DocumentDetail').sourceFiles, ['screens/DocumentDetail.js']);
  assert.deepEqual(screen(map, '/report#Report').sourceFiles, ['screens/Report.ts']);
});

test('of a wrapper and the component passed to it, the first whose file is found is the screen component, and the files of both are the sources of the screen', async () => {
  const frame = "import Frame from '../components/Frame';\nimport Report from '../screens/Report';";
  await inCopy([[ADMIN_ROUTES, "import Report from '../screens/Report';", frame], [ADMIN_ROUTES, '<Checked Page={Report} />', '<Frame Page={Report} />']], async (copy) => {
    fs.writeFileSync(path.join(copy, 'client/src/components/Frame.tsx'), 'export default function Frame({ Page }) {\n  return <section><Page /></section>;\n}\n');
    const report = (await buildFixture(copy)).screens.find((s) => s.path === '/report')!;
    assert.deepEqual([report.id, report.componentFile, report.sourceFiles], ['/report#Frame', 'components/Frame.tsx', ['components/Frame.tsx', 'screens/Report.ts']]);
  });
  const boundary = "import { ErrorBoundary } from 'react-error-boundary';\nimport Report from '../screens/Report';";
  await inCopy([[ADMIN_ROUTES, "import Report from '../screens/Report';", boundary], [ADMIN_ROUTES, '<Checked Page={Report} />', '<ErrorBoundary Page={Report} />']], async (copy) => {
    const report = (await buildFixture(copy)).screens.find((s) => s.path === '/report')!;
    assert.deepEqual([report.id, report.componentFile, report.sourceFiles], ['/report#Report', 'screens/Report.ts', ['screens/Report.ts']]);
  });
  const unfound = [ADMIN_ROUTES, "import Report from '../screens/Report';", "import Report from 'report-package';"];
  await inCopy([unfound], async (copy) => {
    const report = (await buildFixture(copy)).screens.find((s) => s.path === '/report')!;
    assert.deepEqual([report.id, report.componentFile], ['/report#Report', null]);
  });
  await inCopy([unfound, [ADMIN_ROUTES, "import type { Settings }", "import { ErrorBoundary } from 'react-error-boundary';\nimport type { Settings }"], [ADMIN_ROUTES, '<Checked Page={Report} />', '<ErrorBoundary Page={Report} />']], async (copy) => {
    const report = (await buildFixture(copy)).screens.find((s) => s.path === '/report')!;
    assert.deepEqual([report.id, report.componentFile], ['/report#ErrorBoundary', null]);
  });
});

test('a route whose element wraps the screen as a child, through Suspense, a guard, a fragment, a condition or several wrapping calls, is named after the child, with the files of the wrappers and the components passed to them among its sources', async () => {
  const plain = await buildFixture();
  const routes = 'client/src/Routes.tsx';
  await inCopy([
    [routes, "import Home from './screens/Home';", "import { Suspense } from 'react';\nimport { ErrorBoundary } from 'react-error-boundary';\nimport Frame from './components/Frame';\nimport Banner from './components/Banner';\nimport * as Auth from 'auth-kit';\nimport Home from './screens/Home';"],
    [routes, 'function Signed(', 'const withAuth = (page: ReactNode) => page;\nconst ready = true;\n\nfunction Guard({ children }: { children: ReactNode }) {\n  return <>{children}</>;\n}\n\nfunction Signed('],
    [routes, 'element={<Home />}', 'element={<Suspense fallback={null}><Frame><Home><h1>Home</h1></Home></Frame></Suspense>}'],
    [routes, 'element={framed(<DocumentList />)}', 'element={withAuth(framed(<Auth.Guard><>{ready ? <DocumentList /> : null}</></Auth.Guard>))}'],
    [routes, 'element={<Signed Page={DocumentDetail} />}', 'element={<Guard><ErrorBoundary FallbackComponent={Banner}>{framed(<DocumentDetail />)}</ErrorBoundary></Guard>}'],
    [routes, '<Navigate to={Option.ROUTE_PATH.DOCUMENT} replace />', '<Guard><Navigate to={Option.ROUTE_PATH.DOCUMENT} replace /></Guard>'],
  ], async (copy) => {
    fs.writeFileSync(path.join(copy, 'client/src/components/Frame.tsx'), 'export default function Frame({ children }) {\n  return <section>{children}</section>;\n}\n');
    const map = await buildFixture(copy);
    const pick = (m: ScreenMap, p: string) => m.screens.find((s) => s.path === p)!;
    for (const p of ['/home', '/document', '/document/:id']) {
      assert.deepEqual([pick(map, p).id, pick(map, p).componentFile], [pick(plain, p).id, pick(plain, p).componentFile]);
    }
    assert.deepEqual(pick(map, '/home').sourceFiles, [...pick(plain, '/home').sourceFiles, 'components/Frame.tsx'].sort());
    assert.deepEqual(pick(map, '/document/:id').sourceFiles, [...pick(plain, '/document/:id').sourceFiles, 'components/Banner.tsx'].sort());
    assert.deepEqual(map.screens.map((s) => s.id), plain.screens.map((s) => s.id));
    assert.deepEqual(map.entries.filter((e) => e.reasons.some((r) => r.kind === 'redirect')).map((e) => e.screen), ['/document#DocumentList']);
  });
});

test('the screen of a wrapping element is a child with a file, else a wrapper or passed component with a file, so a child without a file does not take over, and a redirect wrapped twice gives no screen', async () => {
  const plain = await buildFixture();
  const routes = 'client/src/Routes.tsx';
  await inCopy([
    [routes, "import Home from './screens/Home';", "import { Outlet, Suspense } from 'react';\nimport { Spinner } from 'ui-kit';\nimport Home from './screens/Home';\nimport * as Lists from './screens/DocumentList';"],
    [routes, 'function Signed(', 'function Guard({ children }: { children: ReactNode }) {\n  return <>{children}</>;\n}\n\nfunction Signed('],
    [routes, 'element={<Home />}', 'element={<Home><Outlet /></Home>}'],
    [routes, 'element={framed(<DocumentList />)}', 'element={<Suspense><Lists.default /></Suspense>}'],
    [routes, 'element={<Signed Page={DocumentDetail} />}', 'element={<Signed Page={DocumentDetail}><Spinner /></Signed>}'],
    [routes, '<Navigate to={Option.ROUTE_PATH.DOCUMENT} replace />', '<Suspense><Guard><Navigate to={Option.ROUTE_PATH.DOCUMENT} replace /></Guard></Suspense>'],
  ], async (copy) => {
    const map = await buildFixture(copy);
    const pick = (m: ScreenMap, p: string) => m.screens.find((s) => s.path === p)!;
    assert.deepEqual(map.screens.map((s) => s.path), plain.screens.map((s) => s.path));
    assert.deepEqual([pick(map, '/home').id, pick(map, '/home').sourceFiles], ['/home#Home', pick(plain, '/home').sourceFiles]);
    assert.deepEqual([pick(map, '/document').id, pick(map, '/document').componentFile], ['/document#Lists.default', 'screens/DocumentList.jsx']);
    assert.deepEqual([pick(map, '/document/:id').id, pick(map, '/document/:id').sourceFiles], [pick(plain, '/document/:id').id, pick(plain, '/document/:id').sourceFiles]);
  });
});

test('a redirect inside a wrapper with a file, a constant passed as a prop, an HTML tag holding the screen, a dotted screen under a wrapper with a file and both sides of a condition are read as the route means them', async () => {
  const plain = await buildFixture();
  const routes = 'client/src/Routes.tsx';
  await inCopy([
    [routes, "import Home from './screens/Home';", "import Home from './screens/Home';\nimport * as Lists from './screens/DocumentList';\nimport Banner from './components/Banner';\nimport Logo from './components/Badge';\nimport { ROLE } from './components/Badge';\nconst ready = true;"],
    [routes, 'element={<Home />}', 'element={<div><img src={Logo} />{ready ? <Home /> : <DocumentDetail />}</div>}'],
    [routes, 'element={framed(<DocumentList />)}', 'element={<Banner><Lists.default /></Banner>}'],
    [routes, 'element={<Signed Page={DocumentDetail} />}', 'element={<Signed role={ROLE} Page={DocumentDetail} />}'],
    [routes, '<Navigate to={Option.ROUTE_PATH.DOCUMENT} replace />', '<Banner><Navigate to={Option.ROUTE_PATH.DOCUMENT} replace /></Banner>'],
  ], async (copy) => {
    fs.appendFileSync(path.join(copy, 'client/src/components/Badge.tsx'), "\nexport const ROLE = 'ADMIN';\n");
    const map = await buildFixture(copy);
    const pick = (m: ScreenMap, p: string) => m.screens.find((s) => s.path === p)!;
    assert.deepEqual(map.screens.map((s) => s.id), plain.screens.map((s) => s.id).map((id) => (id === '/document#DocumentList' ? '/document#Lists.default' : id)));
    assert.ok(pick(map, '/home').sourceFiles.includes('screens/DocumentDetail.js'));
    assert.ok(!pick(map, '/home').sourceFiles.includes('components/Badge.tsx'));
    assert.deepEqual(pick(map, '/document').sourceFiles, ['components/Banner.tsx', 'screens/DocumentList.jsx']);
    assert.deepEqual(pick(map, '/document/:id').sourceFiles, pick(plain, '/document/:id').sourceFiles);
  });
});

test('a child with a file wins over a dotted sibling, HTML beside a redirect keeps the wrapper, a component named with capitals is passed, a constants module is not, and a dotted name in small letters is not an HTML tag', async () => {
  const plain = await buildFixture();
  const routes = 'client/src/Routes.tsx';
  await inCopy([
    [routes, "import Home from './screens/Home';", "import Home from './screens/Home';\nimport * as Layout from 'ui-layout';\nimport * as screens from './screens/DocumentList';\nimport Banner from './components/Banner';\nimport PDFViewer from './screens/DocumentDetail';\nconst ok = true;"],
    [routes, 'element={<Home />}', 'element={<Banner><Layout.Header /><Home /></Banner>}'],
    [routes, 'element={framed(<DocumentList />)}', 'element={<screens.List />}'],
    [routes, 'element={<Signed Page={DocumentDetail} />}', 'element={<Signed options={Option} page={PDFViewer} />}'],
    [routes, '<Route path="*" element={<Navigate to={Option.ROUTE_PATH.DOCUMENT} replace />} />', '<Route path="/banner" element={<Banner>{ok ? <p>hi</p> : <Navigate to={Option.ROUTE_PATH.DOCUMENT} replace />}</Banner>} />'],
  ], async (copy) => {
    const map = await buildFixture(copy);
    const pick = (p: string) => map.screens.find((s) => s.path === p)!;
    assert.equal(pick('/home').id, '/home#Home');
    assert.equal(pick('/document').id, '/document#screens.List');
    assert.deepEqual([pick('/document/:id').id, pick('/document/:id').componentFile], ['/document/:id#PDFViewer', 'screens/DocumentDetail.js']);
    assert.deepEqual([pick('/banner').id, pick('/banner').componentFile], ['/banner#Banner', 'components/Banner.tsx']);
    assert.equal(map.screens.length, plain.screens.length + 1);
  });
});

test('a component held in a lowercase name is passed under a prop named with a capital, and a dotted tag from a package ending in small letters is an HTML tag', async () => {
  const routes = 'client/src/Routes.tsx';
  await inCopy([
    [routes, "import Home from './screens/Home';", "import Home from './screens/Home';\nimport { motion } from 'framer-motion';\nconst detail = DocumentDetail;\nconst pages = { list: DocumentList };\nconst ADMIN = 'admin';"],
    [routes, 'element={<Home />}', 'element={<motion.div><p>hi</p></motion.div>}'],
    [routes, 'element={framed(<DocumentList />)}', 'element={<pages.list />}'],
    [routes, 'element={<Signed Page={DocumentDetail} />}', 'element={<Signed Page={detail} />}'],
    [routes, '<Route path="*" element={<Navigate to={Option.ROUTE_PATH.DOCUMENT} replace />} />', '<Route path="/guarded" element={<Signed role={ADMIN} />} />'],
  ], async (copy) => {
    const map = await buildFixture(copy);
    const id = (p: string) => map.screens.find((s) => s.path === p)?.id;
    assert.equal(id('/home'), undefined);
    assert.equal(id('/document'), '/document#pages.list');
    assert.equal(id('/document/:id'), '/document/:id#detail');
    assert.equal(id('/guarded'), '/guarded#Signed');
  });
});

test('a name taken from a constants module listed only for settings defaults is not a passed component, and the route passing it does not make it a screen source', async () => {
  await inCopy([
    [ROUTES, "import Home from './screens/Home';", "import Home from './screens/Home';\nimport { appSettings as AppSettings } from './store';"],
    [ROUTES, 'element={<Signed Page={DocumentDetail} />}', 'element={<Signed Config={AppSettings} Page={DocumentDetail} />}'],
  ], async (copy) => {
    const map = await buildFixture(copy);
    const detail = map.screens.find((s) => s.path === '/document/:id')!;
    assert.equal(detail.id, '/document/:id#DocumentDetail');
    assert.ok(!detail.sourceFiles.includes('store/index.ts'));
  });
});

test('a route whose element is a Navigate is not a screen, and the screen it points at is reached by that redirect unless a condition guards it', async () => {
  const map = await buildFixture();
  assert.equal(map.screens.some((s) => s.path === '*' || s.component === 'Navigate'), false);
  assert.deepEqual(map.entries, [
    { screen: '/home#Home', reasons: [{ kind: 'config' }] },
    { screen: '/document#DocumentList', reasons: [{ kind: 'redirect', file: 'Routes.tsx', line: 20 }] },
    { screen: '/inbox#Inbox', reasons: [{ kind: 'no-incoming-link' }] },
  ]);
  const toReport = '<Route path="/reports" element={<Navigate to={Option.ROUTE_PATH.REPORT} />} />';
  const withNavigate = [ADMIN_ROUTES, "import { Route, Routes } from 'react-router-dom';", "import { Navigate, Route, Routes } from 'react-router-dom';"];
  await inCopy([withNavigate, [ADMIN_ROUTES, '</Routes>', `${toReport}\n    </Routes>`]], async (copy) => {
    assert.deepEqual((await buildFixture(copy)).entries.find((e) => e.screen === '/report#Report'), { screen: '/report#Report', reasons: [{ kind: 'redirect', file: 'admin/AdminRoutes.tsx', line: 19 }] });
  });
  await inCopy([withNavigate, [ADMIN_ROUTES, '</Routes>', `{(memberRole as Role) === 'ADMIN' && ${toReport}}\n    </Routes>`]], async (copy) => {
    assert.deepEqual((await buildFixture(copy)).entries, map.entries);
  });
});

test('the screens, conditions and redirects of routes written with element are read as those of the same routes written with component', async () => {
  const asComponents = [
    [ROUTES, 'element={<Home />}', 'component={Home}'],
    [ROUTES, 'element={framed(<DocumentList />)}', 'component={framed(DocumentList)}'],
    [ROUTES, 'element={<Signed Page={DocumentDetail} />}', 'component={DocumentDetail}'],
    [ROUTES, '<Route path="*" element={<Navigate to={Option.ROUTE_PATH.DOCUMENT} replace />} />', '<Redirect to={Option.ROUTE_PATH.DOCUMENT} />'],
    [ADMIN_ROUTES, 'element={<Admin />}', 'component={Admin}'],
    [ADMIN_ROUTES, 'element={<Checked Page={Lab} />}', 'component={Lab}'],
    [ADMIN_ROUTES, 'element={<Checked Page={Report} />}', 'component={Report}'],
  ];
  const elements = await buildFixture();
  const components = await inCopy(asComponents, (copy) => buildFixture(copy));
  assert.deepEqual(withoutMeta(elements), withoutMeta(components));
  assert.deepEqual(screen(elements, '/admin#Admin').routeGuards, ["(memberRole as Role) === 'ADMIN'"]);
  assert.deepEqual(screen(elements, '/lab#Lab').routeGuards, ['globalSettings!.SYSTEM.LAB_ENABLED as boolean']);
});

test('redirect elements default to Redirect and Navigate, and a config that lists them keeps exactly the listed names', async () => {
  assert.deepEqual(loadConfig(path.join(FIXTURE, 'config.json')).redirectElements, ['Redirect', 'Navigate']);
  await inCopy([], async (copy) => {
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), redirectElements: ['Redirect'] }));
    assert.deepEqual(loadConfig(configFile).redirectElements, ['Redirect']);
    const map = await buildFixture(copy);
    assert.equal(map.entries.some((e) => e.screen === '/document#DocumentList'), false);
    assert.deepEqual(map.screens.filter((s) => s.path === '*').map((s) => [s.id, s.componentFile]), [['*#Navigate', null]]);
  });
});

const TABLE = 'client/src/pages/lazyPages.ts';
const PAGE_ROUTES = 'client/src/pages/PageRoutes.tsx';
const pageAt = (map: ScreenMap, address: string) => map.screens.find((s) => s.path === address)!;

test('screens taken out of a lazy table, one by destructuring and one as a property, each point at the file their own entry loads and carry only the setting reads and links of that file', async () => {
  const map = await buildFixture();
  const archive = screen(map, '/archive#Archive');
  const profile = screen(map, '/profile#LazyPage.Profile');
  assert.deepEqual([archive.componentFile, archive.sourceFiles], ['screens/Archive.tsx', ['screens/Archive.tsx']]);
  assert.deepEqual([profile.componentFile, profile.sourceFiles], ['screens/Profile.tsx', ['screens/Profile.tsx']]);
  assert.deepEqual([archive.settingReads.length, archive.links.map((l) => l.to)], [0, ['/profile']]);
  assert.deepEqual([profile.settingReads.map((r) => r.key), profile.links.map((l) => l.to)], [['SYSTEM.REPORT_ENABLED'], ['/archive']]);
});

test('a screen does not follow a dynamic import into the component file of another screen, so a navigation helper importing a table that preloads screens brings in the helper and the table but not the links and setting reads of the screens in it, and a screen only its own file links to is an entry', async () => {
  const map = await buildFixture();
  const inbox = screen(map, '/inbox#Inbox');
  const outbox = screen(map, '/outbox#Outbox');
  assert.deepEqual(inbox.sourceFiles, ['pages/navigateLazyPage.ts', 'pages/preloadPages.ts', 'screens/Inbox.tsx']);
  assert.deepEqual(outbox.sourceFiles, ['pages/navigateLazyPage.ts', 'pages/preloadPages.ts', 'screens/Outbox.tsx']);
  assert.deepEqual(inbox.links.map((l) => `${l.file}:${l.line} ${l.to}`), ['screens/Inbox.tsx:9 /inbox', 'screens/Inbox.tsx:10 /outbox']);
  assert.deepEqual(outbox.links.map((l) => `${l.file}:${l.line} ${l.to}`), ['screens/Outbox.tsx:7 /archive']);
  assert.deepEqual([inbox.settingReads, outbox.settingReads], [[], []]);
  assert.deepEqual(map.entries.find((e) => e.screen === '/inbox#Inbox'), { screen: '/inbox#Inbox', reasons: [{ kind: 'no-incoming-link' }] });
});

test('a screen that imports the component file of another screen with a plain import keeps that file among its sources', async () => {
  const OUTBOX = 'client/src/screens/Outbox.tsx';
  await inCopy([
    [OUTBOX, "import { navigateLazyPage } from '../pages/navigateLazyPage';", "import { navigateLazyPage } from '../pages/navigateLazyPage';\nimport Inbox from './Inbox';"],
    [OUTBOX, "  return <button", "  return <Inbox />;\n  <button"],
  ], async (copy) => {
    const outbox = screen(await buildFixture(copy), '/outbox#Outbox');
    assert.deepEqual(outbox.sourceFiles, ['pages/navigateLazyPage.ts', 'pages/preloadPages.ts', 'screens/Inbox.tsx', 'screens/Outbox.tsx']);
    assert.deepEqual(outbox.links.map((l) => `${l.file}:${l.line} ${l.to}`).sort(), ['screens/Inbox.tsx:10 /outbox', 'screens/Inbox.tsx:9 /inbox', 'screens/Outbox.tsx:9 /archive']);
  });
});

test('a screen that loads the component file of another screen only by a dynamic import loses that file, and one that also imports it with a plain import keeps it', async () => {
  const OUTBOX = 'client/src/screens/Outbox.tsx';
  const lazyInbox = [OUTBOX, "import { navigateLazyPage } from '../pages/navigateLazyPage';", "import { navigateLazyPage } from '../pages/navigateLazyPage';\nconst InboxPanel = lazy(() => import('./Inbox'));"];
  await inCopy([lazyInbox], async (copy) => {
    const outbox = screen(await buildFixture(copy), '/outbox#Outbox');
    assert.deepEqual(outbox.sourceFiles, ['pages/navigateLazyPage.ts', 'pages/preloadPages.ts', 'screens/Outbox.tsx']);
  });
  await inCopy([lazyInbox, [OUTBOX, "const InboxPanel", "import { default as InboxScreen } from './Inbox';\nconst InboxPanel"]], async (copy) => {
    const outbox = screen(await buildFixture(copy), '/outbox#Outbox');
    assert.deepEqual(outbox.sourceFiles, ['pages/navigateLazyPage.ts', 'pages/preloadPages.ts', 'screens/Inbox.tsx', 'screens/Outbox.tsx']);
  });
});

test('a table entry is followed through a wrapping call holding the dynamic import, a loader that wraps it, a call around the table, a spread table, an index file re-exporting the table and a default export', async () => {
  const shapes = [
    [[TABLE, 'Archive: lazy(loadPage.Archive),', "Archive: lazy(() => import('../screens/Archive')),"]],
    [[TABLE, "Archive: () => import('../screens/Archive'),", "Archive: () => retry(() => import('../screens/Archive')),"]],
    [[TABLE, 'export const LazyPage = {', 'export const LazyPage = Object.freeze({'], [TABLE, '} satisfies Record<keyof typeof loadPage, unknown>;', '});']],
    [[TABLE, 'export const LazyPage = {', 'const first = { Archive: lazy(loadPage.Archive) };\n\nexport const LazyPage = {\n  ...first,'], [TABLE, '  Archive: lazy(loadPage.Archive),\n  Profile', '  Profile']],
    [[PAGE_ROUTES, "from './lazyPages'", "from './index'"]],
    [[TABLE, 'export const LazyPage = {', 'export default {'], [PAGE_ROUTES, 'import { LazyPage }', 'import LazyPage']],
  ];
  for (const edits of shapes) {
    await inCopy(edits, async (copy) => {
      fs.writeFileSync(path.join(copy, 'client/src/pages/index.ts'), "export * from './lazyPages';\n");
      const map = await buildFixture(copy);
      const found = ['/archive', '/profile'].map((address) => [pageAt(map, address).id, pageAt(map, address).componentFile, pageAt(map, address).sourceFiles]);
      assert.deepEqual(found, [['/archive#Archive', 'screens/Archive.tsx', ['screens/Archive.tsx']], ['/profile#LazyPage.Profile', 'screens/Profile.tsx', ['screens/Profile.tsx']]], JSON.stringify(edits));
    });
  }
});

test('a route written as a property of what a call returns points at the file that the function given to the call returns the import of, at no file when that function wraps the import in another call, and not at the file of another screen when it builds a table of screens', async () => {
  const declared = [
    [PAGE_ROUTES, 'const { Archive } = LazyPage;', "const { Archive } = LazyPage;\nconst Drafts = createLazyComponent(() => import('../screens/Archive'));"],
    [PAGE_ROUTES, '<Archive />', '<Drafts.Component />'],
  ];
  await inCopy(declared, async (copy) => {
    const archive = pageAt(await buildFixture(copy), '/archive');
    assert.deepEqual([archive.id, archive.componentFile], ['/archive#Drafts.Component', 'screens/Archive.tsx']);
  });
  await inCopy([[TABLE, 'Archive: lazy(loadPage.Archive),', 'Archive: createLazyComponent(loadPage.Archive),'], [PAGE_ROUTES, '<Archive />', '<Archive.Component />']], async (copy) => {
    const archive = pageAt(await buildFixture(copy), '/archive');
    assert.deepEqual([archive.id, archive.componentFile], ['/archive#Archive.Component', 'screens/Archive.tsx']);
  });
  await inCopy([[TABLE, 'Archive: lazy(loadPage.Archive),', 'Archive: register(() => Later),'], [PAGE_ROUTES, '<Archive />', '<Archive.Component />']], async (copy) => {
    assert.equal(pageAt(await buildFixture(copy), '/archive').componentFile, null);
  });
  const builtByCall = "export const LazyPage = definePages(() => ({ Archive: lazy(loadPage.Archive), Profile: lazy(() => import('../screens/Profile')) }));";
  await inCopy([[TABLE, 'export const LazyPage = {\n  Archive: lazy(loadPage.Archive),\n  Profile: lazy(loadPage.Profile),\n} satisfies Record<keyof typeof loadPage, unknown>;', builtByCall]], async (copy) => {
    assert.equal(pageAt(await buildFixture(copy), '/archive').componentFile, null);
  });
  const wrapped = [declared[0][0], declared[0][1], declared[0][2].replace("() => import('../screens/Archive')", "() => retry(() => import('../screens/Archive'))")];
  await inCopy([wrapped, declared[1]], async (copy) => {
    assert.equal(pageAt(await buildFixture(copy), '/archive').componentFile, null);
  });
});

test('a name taken out of a table under another name, or out of a table inside a table, keeps the name written at the route and finds the same file', async () => {
  await inCopy([[PAGE_ROUTES, 'const { Archive } = LazyPage;', 'const { Archive: Old = null } = LazyPage;'], [PAGE_ROUTES, '<Archive />', '<Old />']], async (copy) => {
    const archive = pageAt(await buildFixture(copy), '/archive');
    assert.deepEqual([archive.id, archive.componentFile], ['/archive#Old', 'screens/Archive.tsx']);
  });
  await inCopy([
    [TABLE, 'export const LazyPage = {', 'export const Pages = { member: {'],
    [TABLE, '} satisfies Record<keyof typeof loadPage, unknown>;', '} };'],
    [PAGE_ROUTES, 'import { LazyPage }', 'import { Pages }'],
    [PAGE_ROUTES, 'const { Archive } = LazyPage;', 'const { member: { Archive } } = Pages;'],
    [PAGE_ROUTES, '<LazyPage.Profile />', "<Pages.member.Profile />"],
  ], async (copy) => {
    const map = await buildFixture(copy);
    assert.deepEqual(['/archive', '/profile'].map((address) => [pageAt(map, address).id, pageAt(map, address).componentFile]), [['/archive#Archive', 'screens/Archive.tsx'], ['/profile#Pages.member.Profile', 'screens/Profile.tsx']]);
  });
});

test('a name imported from a file that declares it with a function returning the loaded module points at the file loaded there, one declared with another kind of loader keeps the imported file, and a component imported through an index file keeps pointing at the index file, under another name too', async () => {
  await inCopy([[TABLE, 'export const LazyPage', 'export const Archive = lazy(loadPage.Archive);\n\nexport const LazyPage'], [PAGE_ROUTES, "import { LazyPage } from './lazyPages';\n\nconst { Archive } = LazyPage;", "import { Archive, LazyPage } from './lazyPages';"]], async (copy) => {
    const archive = pageAt(await buildFixture(copy), '/archive');
    assert.deepEqual([archive.id, archive.componentFile, archive.sourceFiles], ['/archive#Archive', 'screens/Archive.tsx', ['screens/Archive.tsx']]);
  });
  const named = "export const Archive = lazy(() => import('../screens/Archive').then((page) => ({ default: page.default })));\n\nexport const LazyPage";
  await inCopy([[TABLE, 'export const LazyPage', named], [PAGE_ROUTES, "import { LazyPage } from './lazyPages';\n\nconst { Archive } = LazyPage;", "import { Archive, LazyPage } from './lazyPages';"]], async (copy) => {
    assert.equal(pageAt(await buildFixture(copy), '/archive').componentFile, 'screens/Archive.tsx');
  });
  const imported = [PAGE_ROUTES, "import { LazyPage } from './lazyPages';\n\nconst { Archive } = LazyPage;", "import { Archive, LazyPage } from './lazyPages';"];
  const declaredWith = async (loader: string) => inCopy([[TABLE, 'export const LazyPage', `export const Archive = ${loader};\n\nexport const LazyPage`], imported], async (copy) => pageAt(await buildFixture(copy), '/archive').componentFile);
  const returningTheModule = [
    "lazy(async () => await import('../screens/Archive'))",
    "lazy(() => import('../screens/Archive').catch(report))",
    "lazy(() => import('../screens/Archive').then((page) => { return { default: page.default }; }).catch(report))",
    "lazy(() => import('../screens/Archive').then(function (page) { return { default: page.default }; }))",
    "lazy(() => import('../screens/Archive').then((page) => ({ default: page?.default })))",
    "lazy(() => import('../screens/Archive').then((page) => ({ default: page.default ?? page.Archive })))",
    "lazy(() => import('../screens/Archive').then((page) => ({ default: page.default || page })))",
  ];
  for (const loader of returningTheModule) assert.equal(await declaredWith(loader), 'screens/Archive.tsx', loader);
  const keepingTheFile = [
    "lazy(() => retry(() => import('../screens/Archive')))",
    "lazy(() => import('../screens/Archive').then((page) => page.start()))",
    "lazy(async () => (await import('../screens/Archive')).start())",
    "Loadable({ loader: () => import('../screens/Archive'), loading: () => null })",
    "lazy(() => import('../screens/Archive').then(() => ({ default: Later })))",
    "lazy(() => import('../screens/Archive').then((flags) => ({ default: flags.beta ? Later : Other })))",
    "lazy(() => import('../screens/Archive').then((page) => ({ default: memo(page.default) })))",
    "lazy(async () => { const page = await import('../screens/Archive'); return { default: page.default }; })",
  ];
  for (const loader of keepingTheFile) assert.equal(await declaredWith(loader), 'pages/lazyPages.ts', loader);
  await inCopy([[PAGE_ROUTES, "import { LazyPage } from './lazyPages';", "import { LazyPage } from './lazyPages';\nimport { Banner } from '../components';"], [PAGE_ROUTES, '<Archive />', '<Banner />']], async (copy) => {
    const archive = pageAt(await buildFixture(copy), '/archive');
    assert.deepEqual([archive.id, archive.componentFile], ['/archive#Banner', 'components/index.ts']);
  });
  await inCopy([[PAGE_ROUTES, "import { LazyPage } from './lazyPages';", "import { LazyPage } from './lazyPages';\nimport { Banner } from '../components';\nconst Start = Banner;"], [PAGE_ROUTES, '<Archive />', '<Start />']], async (copy) => {
    const archive = pageAt(await buildFixture(copy), '/archive');
    assert.deepEqual([archive.id, archive.componentFile], ['/archive#Start', 'components/index.ts']);
  });
});

test('a component held under another name, a member of a module imported whole and a property of an object in the route file each find the file of the component they name, and such a member standing before a sibling is the screen', async () => {
  await inCopy([
    [ROUTES, "import Home from './screens/Home';", "import Home from './screens/Home';\nimport * as Parts from './components';\nconst Detail = DocumentDetail;\nconst pages = { list: DocumentList };"],
    [ROUTES, 'element={<Home />}', 'element={<Parts.Banner />}'],
    [ROUTES, 'element={framed(<DocumentList />)}', 'element={<pages.list />}'],
    [ROUTES, 'element={<Signed Page={DocumentDetail} />}', 'element={<Detail />}'],
  ], async (copy) => {
    const map = await buildFixture(copy);
    assert.deepEqual(['/home', '/document', '/document/:id'].map((address) => [pageAt(map, address).id, pageAt(map, address).componentFile]), [
      ['/home#Parts.Banner', 'components/Banner.tsx'],
      ['/document#pages.list', 'screens/DocumentList.jsx'],
      ['/document/:id#Detail', 'screens/DocumentDetail.js'],
    ]);
    assert.ok(!pageAt(map, '/home').sourceFiles.includes('components/index.ts'));
  });
  await inCopy([
    [ROUTES, "import Home from './screens/Home';", "import Home from './screens/Home';\nimport * as Parts from './components';"],
    [ROUTES, 'element={<Home />}', 'element={<main><Parts.Banner /><Home /></main>}'],
  ], async (copy) => {
    const home = pageAt(await buildFixture(copy), '/home');
    assert.deepEqual([home.id, home.componentFile], ['/home#Parts.Banner', 'components/Banner.tsx']);
  });
});

test('a wrapper the route file makes by calling a function on an imported component adds that file to the sources, and names the screen only when nothing is passed to it', async () => {
  const wrapper = [ROUTES, "import Home from './screens/Home';", "import Home from './screens/Home';\nimport Banner from './components/Banner';\nconst withFrame = (Inner: ComponentType) => Inner;\nconst Framed = withFrame(Banner);"];
  await inCopy([wrapper, [ROUTES, '<Signed Page={DocumentDetail} />', '<Framed Page={DocumentDetail} />'], [ROUTES, 'element={<Home />}', 'element={<Framed />}']], async (copy) => {
    const map = await buildFixture(copy);
    const detail = pageAt(map, '/document/:id');
    assert.deepEqual([detail.id, detail.componentFile, detail.sourceFiles], ['/document/:id#DocumentDetail', 'screens/DocumentDetail.js', ['components/Banner.tsx', 'screens/DocumentDetail.js']]);
    assert.deepEqual([pageAt(map, '/home').id, pageAt(map, '/home').componentFile], ['/home#Framed', 'components/Banner.tsx']);
  });
});

test('a table entry that cannot be followed, a member a module does not export and index files re-exporting each other give no component file, and extract prints one line for each such screen', async () => {
  const unfollowed = [TABLE, 'Archive: lazy(loadPage.Archive),', 'Archive: lazy(globalThis.early ? loadPage.Archive : loadPage.Profile),'];
  const circular = [[PAGE_ROUTES, "import { LazyPage } from './lazyPages';", "import { LazyPage } from './lazyPages';\nimport * as Loop from './index';"], [PAGE_ROUTES, '<LazyPage.Profile />', '<Loop.Profile />']];
  await inCopy([unfollowed, ...circular], (copy) => {
    fs.writeFileSync(path.join(copy, 'client/src/pages/index.ts'), "export * from './more';\n");
    fs.writeFileSync(path.join(copy, 'client/src/pages/more.ts'), "export * from './index';\n");
    const result = spawnSync(process.execPath, [CLI, 'extract', path.join(copy, 'config.json')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.split('\n').filter((line) => line.includes('component file not found')), [
      '  component file not found for /archive#Archive ← pages/PageRoutes.tsx:11',
      '  component file not found for /profile#Loop.Profile ← pages/PageRoutes.tsx:12',
    ]);
  });
  await inCopy([], (copy) => {
    const result = spawnSync(process.execPath, [CLI, 'extract', path.join(copy, 'config.json')], { encoding: 'utf8' });
    assert.doesNotMatch(result.stdout, /component file not found/);
  });
});

test('a screen that the file declaring it wraps in a call keeps its own file when its body, an option or a data loader passed beside it holds a dynamic import, however the route file names it', async () => {
  const home = 'client/src/screens/Home.tsx';
  const helper = "const later = async () => (await import('./scheduleReport'));\n";
  const wrapped = (declared: string, exported: string) => [[home, 'export default function Home(', `import { memo } from 'react';\n\n${declared}`], [home, '  return (', `  ${helper}  return (`], [home, '  );\n}\n', `  );\n}${exported}\n`]];
  const shapes = [
    wrapped('function Home(', '\n\nexport default memo(Home);'),
    wrapped('export default memo(function Home(', ');'),
    [[home, 'export default function Home(', "const withData = (page: unknown, options: unknown) => page;\n\nfunction Home("], [home, '  );\n}\n', "  );\n}\n\nexport default withData(Home, { load: () => import('./scheduleReport') });\n"]],
    [[home, '  const banner', "  if (!recent) return useLater(() => import('./scheduleReport'));\n  const banner"]],
  ];
  await inCopy([['client/src/screens/Admin.tsx', "export default function Admin() {\n  return <h1>Admin</h1>;\n}", "function Admin() {\n  useEffect(() => {\n    import('./scheduleReport');\n  }, []);\n  return null;\n}\n\nexport default memo(Admin);"]], async (copy) => {
    assert.equal(pageAt(await buildFixture(copy), '/admin').componentFile, 'screens/Admin.tsx');
  });
  const rendered = "function Admin() {\n  const open = () => import('./scheduleReport');\n  return createElement('button', { onClick: open }, 'Admin');\n}\n\nexport default memo(Admin);";
  await inCopy([['client/src/screens/Admin.tsx', "export default function Admin() {\n  return <h1>Admin</h1>;\n}", rendered], [ADMIN_ROUTES, 'element={<Admin />}', 'component={withAuth(Admin)}']], async (copy) => {
    assert.equal(pageAt(await buildFixture(copy), '/admin').componentFile, 'screens/Admin.tsx');
  });
  const tabled = [['client/src/screens/Admin.tsx', "export default function Admin() {\n  return <h1>Admin</h1>;\n}", rendered], [ADMIN_ROUTES, "import Admin from '../screens/Admin';", "import Admin from '../screens/Admin';\nconst Pages = { Admin };"], [ADMIN_ROUTES, 'element={<Admin />}', 'element={<Pages.Admin />}']];
  await inCopy(tabled, async (copy) => {
    assert.equal(pageAt(await buildFixture(copy), '/admin').componentFile, 'screens/Admin.tsx');
  });
  const routed = "function AdminView() {\n  return <h1>Admin</h1>;\n}\n\nexport default connectRoute({ loader: () => import('./scheduleReport').then((m) => m.scheduleReport([])), component: AdminView });";
  const beside = "function AdminView() {\n  return <h1>Admin</h1>;\n}\n\nexport default withData(() => import('./scheduleReport').then((m) => m.scheduleReport([])), AdminView);";
  for (const declared of [routed, beside]) {
    await inCopy([['client/src/screens/Admin.tsx', "export default function Admin() {\n  return <h1>Admin</h1>;\n}", declared]], async (copy) => {
      assert.equal(pageAt(await buildFixture(copy), '/admin').componentFile, 'screens/Admin.tsx', declared);
    });
  }
  const plain = pageAt(await buildFixture(), '/home');
  for (const edits of shapes) {
    await inCopy(edits, async (copy) => {
      const found = pageAt(await buildFixture(copy), '/home');
      assert.deepEqual([found.id, found.componentFile], [plain.id, plain.componentFile], JSON.stringify(edits));
      assert.deepEqual(found.sourceFiles, [...plain.sourceFiles, 'screens/scheduleReport.ts'].sort());
    });
  }
});

test('the loaders of a table are read in another module than the table, and a loader of any shape gives the last source file it imports', async () => {
  const own = (map: ScreenMap) => ['/archive', '/profile'].map((address) => [pageAt(map, address).componentFile, pageAt(map, address).sourceFiles]);
  const expected = [['screens/Archive.tsx', ['screens/Archive.tsx']], ['screens/Profile.tsx', ['screens/Profile.tsx']]];
  await inCopy([[TABLE, "const loadPage = {\n  Archive: () => import('../screens/Archive'),\n  Profile: () => import('../screens/Profile'),\n};", "import { loadPage } from './loaders';"]], async (copy) => {
    fs.writeFileSync(path.join(copy, 'client/src/pages/loaders.ts'), "export const loadPage = {\n  Archive: () => import('../screens/Archive'),\n  Profile: () => import('../screens/Profile'),\n};\n");
    assert.deepEqual(own(await buildFixture(copy)), expected);
  });
  const loaders = [
    "() => Promise.all([import('../store/settings'), import('../screens/Archive')]).then(([, page]) => page)",
    "async () => { const page = await import('../screens/Archive'); return { default: page.default }; }",
    "async () => { try { await import('../store/settings'); } catch {} const page = await import('../screens/Archive'); return page; }",
    "() => new Promise((done) => setTimeout(() => done(import('../screens/Archive')), 300))",
    "() => (globalThis.early ? import('../screens/Profile') : import('../screens/Archive'))",
    "function load() { return import('../screens/Archive'); }",
  ];
  for (const loader of loaders) {
    await inCopy([[TABLE, "Archive: () => import('../screens/Archive'),", `Archive: ${loader},`]], async (copy) => {
      assert.deepEqual(own(await buildFixture(copy))[0][0], 'screens/Archive.tsx', loader);
    });
  }
});

test('a lazy declared in the route file around a loader imported from another module, and a table loader that falls back to an element when the import fails, each find the file the loader imports', async () => {
  await inCopy([[PAGE_ROUTES, "import { LazyPage } from './lazyPages';\n\nconst { Archive } = LazyPage;", "import { lazy } from 'react';\nimport { LazyPage } from './lazyPages';\nimport { loadArchive } from './loaders';\n\nconst Archive = lazy(loadArchive);"]], async (copy) => {
    fs.writeFileSync(path.join(copy, 'client/src/pages/loaders.ts'), "export const loadArchive = () => retry(() => import('../screens/Archive'));\n");
    const archive = pageAt(await buildFixture(copy), '/archive');
    assert.deepEqual([archive.componentFile, archive.sourceFiles], ['screens/Archive.tsx', ['screens/Archive.tsx']]);
  });
  await inCopy([[TABLE, "Archive: () => import('../screens/Archive'),", "Archive: () => import('../screens/Archive').catch(() => ({ default: () => <p>failed</p> })),"]], async (copy) => {
    fs.renameSync(path.join(copy, TABLE), path.join(copy, `${TABLE}x`));
    const archive = pageAt(await buildFixture(copy), '/archive');
    assert.deepEqual([archive.componentFile, archive.sourceFiles], ['screens/Archive.tsx', ['screens/Archive.tsx']]);
  });
});

test('a loader gives the last source file it imports when a later import is a style sheet or a package, one importing no source file or importing only inside a callback gives none, also when it overrides an earlier entry through a spread, a spread that cannot be read or lacks the key is passed over, and a loader is read under the loader key of an object but not as a second argument', async () => {
  const fileOf = async (edit: Edit, write?: (copy: string) => void) => inCopy([edit], async (copy) => {
    write?.(copy);
    return pageAt(await buildFixture(copy), '/archive').componentFile;
  });
  const entry = "Archive: () => import('../screens/Archive'),";
  const css = (copy: string) => fs.writeFileSync(path.join(copy, 'client/src/screens/Archive.css'), 'a {}\n');
  assert.equal(await fileOf([TABLE, entry, "Archive: () => import('../screens/Archive').then((page) => import('../screens/Archive.css').then(() => page)),"], css), 'screens/Archive.tsx');
  assert.equal(await fileOf([TABLE, entry, "Archive: () => import('../screens/Archive').then((page) => { import('some-package'); return page; }),"]), 'screens/Archive.tsx');
  assert.equal(await fileOf([TABLE, 'Archive: lazy(loadPage.Archive),', "Archive: asyncPage('archive', loadPage.Archive),"]), null);
  assert.equal(await fileOf([TABLE, entry, "Archive: () => import('../screens/Archive.css'),"], css), null);
  const unclear = "async () => { const page = await retry(() => import('../screens/Profile')); return { default: page.default }; }";
  assert.equal(await fileOf([TABLE, entry, `Archive: ${unclear},`]), null);
  const withLater = [TABLE, 'const loadPage = {', `const later = { Archive: ${unclear} };\n\nconst loadPage = {`];
  const spreadLast = (spread: string) => [TABLE, "  Profile: () => import('../screens/Profile'),\n};", `  Profile: () => import('../screens/Profile'),\n  ...${spread},\n};`];
  const tableFile = (...edits: Edit[]) => inCopy(edits, async (copy) => pageAt(await buildFixture(copy), '/archive').componentFile);
  assert.equal(await tableFile(withLater), 'screens/Archive.tsx');
  assert.equal(await tableFile(withLater, spreadLast('later')), null);
  assert.equal(await tableFile(spreadLast("(globalThis.debug ? { Debug: () => import('../screens/Profile') } : {})")), 'screens/Archive.tsx');
  assert.equal(await tableFile(spreadLast("{ Debug: () => import('../screens/Profile') }")), 'screens/Archive.tsx');
  assert.equal(await tableFile([TABLE, "Archive: () => import('../screens/Archive'),", "Archive: () => import('../screens/Profile'),\n  ['Arch' + 'ive']: () => import('../screens/Archive'),"]), null);
  const otherOnly = "{ Other: () => import('../screens/Profile') }";
  assert.equal(await tableFile([TABLE, 'const loadPage = {', "const tables = { later: { Archive: () => import('../screens/Profile') } };\n\nconst loadPage = {"], spreadLast('tables.later')), 'screens/Profile.tsx');
  assert.equal(await tableFile(spreadLast("{ Archive: other.Missing }"), [TABLE, 'const loadPage = {', `const other = ${otherOnly};\n\nconst loadPage = {`]), null);
  const nested = (spread: string) => [[TABLE, 'Archive: lazy(loadPage.Archive),', 'Archive: lazy(loadPage.screens.Archive),'], [TABLE, 'const loadPage = {', `const loadPage = {\n  screens: { Archive: () => import('../screens/Archive') },\n  ...${spread},`]];
  assert.equal(await tableFile(...nested(`{ screens: ${otherOnly} }`)), null);
  assert.equal(await tableFile(...nested(`{ others: ${otherOnly} }`)), 'screens/Archive.tsx');
  assert.equal(await fileOf([TABLE, 'Archive: lazy(loadPage.Archive),', 'Archive: Loadable({ loading: () => null, loader: loadPage.Archive }),']), 'screens/Archive.tsx');
  assert.equal(await fileOf([TABLE, 'Archive: lazy(loadPage.Archive),', 'Archive: withData({ load: loadPage.Archive }),']), null);
});

test('a table reached through index files that re-export the same file twice is still found, and a member of a module that imports a component and exports it again points at the file of that component', async () => {
  await inCopy([[PAGE_ROUTES, "from './lazyPages'", "from './index'"]], async (copy) => {
    const write = (name: string, text: string) => fs.writeFileSync(path.join(copy, 'client/src/pages', name), text);
    write('index.ts', "export * from './b';\nexport * from './c';\nexport * from './lazyPages';\n");
    write('b.ts', "export * from './shared';\n");
    write('c.ts', "export * from './shared';\n");
    write('shared.ts', 'export const unrelated = 1;\n');
    const map = await buildFixture(copy);
    assert.deepEqual(['/archive', '/profile'].map((address) => pageAt(map, address).componentFile), ['screens/Archive.tsx', 'screens/Profile.tsx']);
  });
  await inCopy([
    ['client/src/components/index.ts', "export { type BannerProps, Banner } from './Banner';", "import { Banner } from './Banner';\nexport { Banner };"],
    [ROUTES, "import Home from './screens/Home';", "import Home from './screens/Home';\nimport * as Parts from './components';"],
    [ROUTES, 'element={<Home />}', 'element={<Parts.Banner />}'],
  ], async (copy) => {
    const home = pageAt(await buildFixture(copy), '/home');
    assert.deepEqual([home.id, home.componentFile], ['/home#Parts.Banner', 'components/Banner.tsx']);
  });
});

test('a route written with component naming a loader inside a wrapping call finds the file it loads', async () => {
  await inCopy([[PAGE_ROUTES, 'element={<Archive />}', 'component={lazy(loadPage.Archive)}'], [PAGE_ROUTES, "import { LazyPage } from './lazyPages';", "import { lazy } from 'react';\nimport { LazyPage } from './lazyPages';\nimport { loadPage } from './loaders';"]], async (copy) => {
    fs.writeFileSync(path.join(copy, 'client/src/pages/loaders.ts'), "export const loadPage = {\n  Archive: () => import('../screens/Archive'),\n};\n");
    const archive = pageAt(await buildFixture(copy), '/archive');
    assert.deepEqual([archive.id, archive.componentFile, archive.sourceFiles], ['/archive#loadPage.Archive', 'screens/Archive.tsx', ['screens/Archive.tsx']]);
  });
});

test('a route written with component naming a table entry is named after it and finds its file', async () => {
  await inCopy([[PAGE_ROUTES, 'element={<LazyPage.Profile />}', 'component={LazyPage.Profile}'], [PAGE_ROUTES, 'element={<Archive />}', 'component={wrap(LazyPage.Archive)}'], [PAGE_ROUTES, 'const { Archive } = LazyPage;', 'const wrap = <T,>(page: T) => page;']], async (copy) => {
    const map = await buildFixture(copy);
    assert.deepEqual(['/archive', '/profile'].map((address) => [pageAt(map, address).id, pageAt(map, address).componentFile]), [['/archive#LazyPage.Archive', 'screens/Archive.tsx'], ['/profile#LazyPage.Profile', 'screens/Profile.tsx']]);
  });
});

test('a loader whose import is not written out, and names that lead back to themselves while taking one more key each round, give no component file instead of the table file or a crash', async () => {
  await inCopy([[TABLE, "Archive: () => import('../screens/Archive'),", "Archive: () => import(`../screens/${'Archive'}`),"]], async (copy) => {
    const archive = pageAt(await buildFixture(copy), '/archive');
    assert.deepEqual([archive.componentFile, archive.sourceFiles], [null, []]);
  });
  await inCopy([[PAGE_ROUTES, 'const { Archive } = LazyPage;', 'const Archive = other.x;\nconst other = { ...Archive };']], async (copy) => {
    assert.equal(pageAt(await buildFixture(copy), '/archive').componentFile, null);
  });
});

test('the usage guide and the agent skill name the route shapes duru reads and the default redirect elements', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
  for (const doc of [read('../README.md'), read('../skills/duru/SKILL.md')]) {
    assert.match(doc, /`component=\{Home\}`[\s\S]*`element=\{<Home \/>\}`[\s\S]*`element=\{wrap\(<Home \/>\)\}`[\s\S]*`element=\{<Wrapper Page=\{Signer\} \/>\}`[\s\S]*`element=\{<Navigate to=… \/>\}`/);
    assert.match(doc, /`redirectElements`[\s\S]*default `Redirect` and\s+`Navigate`/);
  }
});
