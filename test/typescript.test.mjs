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
