import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';
import { addMark } from '../src/marks.ts';

for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const LAST_ROUTE = '      <Redirect to={Option.ROUTE_PATH.SIGN_IN} />';
const CONSOLE = 'admin/AdminConsole.js';
const TABLE = 'admin/definition.js';
const LOOP_ROUTE = '<Route key={item.url} path={`${props.match.url}/${item.url}`} render={(routeProps) => <SchemaSettings {...routeProps} schema={item.schema} />} />';
const ROUTE_TABLE = { route: CONSOLE, table: { file: TABLE, const: 'AdminDefinition' }, items: '*.subsections.*' };

const page = (name: string) => `export default function ${name}() {
  return <article>${name}</article>;
}
`;

const SOURCES: Record<string, string> = {
  [CONSOLE]: `import { Route, Switch } from 'react-router-dom';
import AdminDefinition from './definition';
import SchemaSettings from './SchemaSettings';

export default function AdminConsole(props) {
  const schemas = Object.values(AdminDefinition).flatMap((section) => Object.values(section.subsections));
  return (
    <Switch>
      {schemas.map((item) => (
        ${LOOP_ROUTE}
      ))}
    </Switch>
  );
}
`,
  [TABLE]: `import License from './License';
import Users from './Users';
import UserDetail from './UserDetail';
import BrandImage from './BrandImage';
import { ID_PATTERN } from './patterns';

const AdminDefinition = {
  about: {
    sectionTitle: 'About',
    subsections: {
      license: {
        url: 'about/license',
        schema: { id: 'License', component: License },
      },
    },
  },
  users: {
    sectionTitle: 'Users',
    subsections: {
      list: {
        url: 'users',
        schema: { id: 'Users', component: Users },
      },
      detail: {
        url: \`users/:user_id(\${ID_PATTERN})\`,
        schema: { id: 'UserDetail', component: UserDetail },
      },
      site: {
        url: 'users/site',
        schema: { id: 'Site', settings: [{ key: 'name', type: 'text' }, { key: 'brand', type: 'custom', component: BrandImage }] },
      },
      plain: {
        url: 'users/plain',
        schema: { id: 'Plain', settings: [{ key: 'enabled', type: 'bool' }] },
      },
    },
  },
};

export default AdminDefinition;
`,
  'admin/SchemaSettings.js': `export default function SchemaSettings({ schema }) {
  const Component = schema.component;
  return Component ? <Component /> : <form>{schema.id}</form>;
}
`,
  'admin/BrandImage.js': `import { useEffect } from 'react';
import { ajaxMemberList } from '../_ajax/AjaxFunc';

export default function BrandImage() {
  useEffect(() => {
    ajaxMemberList({ page: 1 });
  }, []);
  return <img alt="brand" />;
}
`,
  'admin/patterns.js': `export const ID_PATTERN = '[a-z0-9]{26}';
`,
  'admin/License.js': page('License'),
  'admin/Users.js': page('Users'),
  'admin/UserDetail.js': page('UserDetail'),
};

type Copy = { configFile: string; src: string; cli: (...args: string[]) => string };

async function withTableCopy<T>(fn: (copy: Copy) => T | Promise<T>, { configPatch = {}, edits = [] }: { configPatch?: Record<string, unknown>; edits?: [string, string, string][] } = {}): Promise<T> {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const src = path.join(copy, 'client/src');
    const routes = path.join(src, 'Routes.js');
    fs.writeFileSync(routes, `import AdminConsole from './admin/AdminConsole';\n${fs.readFileSync(routes, 'utf8').replace(LAST_ROUTE, `      <Route path="/admin_console" component={AdminConsole} />\n${LAST_ROUTE}`)}`);
    fs.mkdirSync(path.join(src, 'admin'));
    for (const [file, text] of Object.entries(SOURCES)) fs.writeFileSync(path.join(src, file), text);
    for (const [file, from, to] of edits) {
      const text = fs.readFileSync(path.join(src, file), 'utf8');
      assert.ok(text.includes(from), `${file} has no ${from}`);
      fs.writeFileSync(path.join(src, file), text.split(from).join(to));
    }
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), routesFile: ['Routes.js', CONSOLE], routeTables: [ROUTE_TABLE], ...configPatch }));
    const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, configFile], { encoding: 'utf8' });
    return await fn({ configFile, src, cli });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const lineIn = (src: string, file: string, text: string, from = 0) => {
  const at = fs.readFileSync(path.join(src, file), 'utf8').split('\n').findIndex((l, i) => i >= from && l.includes(text));
  assert.ok(at >= 0, `${file} has ${text}`);
  return at + 1;
};
const itemLine = (src: string, key: string) => lineIn(src, TABLE, `${key}: {`, lineIn(src, TABLE, 'const AdminDefinition'));
const tableScreens = (map: ScreenMap) => map.screens.filter((s) => s.routeFile === CONSOLE);
const screen = (map: ScreenMap, id: string) => {
  const found = map.screens.find((s) => s.id === id);
  assert.ok(found, `${id} is on the map: ${map.screens.map((s) => s.id).join(', ')}`);
  return found;
};
const routeLines = (stdout: string) => stdout.split('\n').filter((line) => /route not read|route path not read|duplicate screen ID|component file not found/.test(line));

function failure(configFile: string) {
  const result = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stdout);
  return result.stderr;
}

test('a route made for each item of a table named in routeTables gives a screen for each item, with the outer screen\'s path in front, named after the first component the item holds', async () => {
  await withTableCopy(async ({ configFile, src, cli }) => {
    const map = await build(configFile);
    const line = lineIn(src, CONSOLE, '<Route key={item.url}');
    assert.deepEqual(tableScreens(map).map((s) => [s.path, s.id, s.componentFile, s.line, s.tableItem]), [
      ['/admin_console/about/license', '/admin_console/about/license#License', 'admin/License.js', line, { key: 'about.subsections.license', file: TABLE, line: itemLine(src, 'license') }],
      ['/admin_console/users', '/admin_console/users#Users', 'admin/Users.js', line, { key: 'users.subsections.list', file: TABLE, line: itemLine(src, 'list') }],
      ['/admin_console/users/:user_id([a-z0-9]{26})', '/admin_console/users/:user_id#UserDetail', 'admin/UserDetail.js', line, { key: 'users.subsections.detail', file: TABLE, line: itemLine(src, 'detail') }],
      ['/admin_console/users/site', '/admin_console/users/site#BrandImage', 'admin/BrandImage.js', line, { key: 'users.subsections.site', file: TABLE, line: itemLine(src, 'site') }],
      ['/admin_console/users/plain', '/admin_console/users/plain#SchemaSettings', 'admin/SchemaSettings.js', line, { key: 'users.subsections.plain', file: TABLE, line: itemLine(src, 'plain') }],
    ]);
    assert.ok(screen(map, '/admin_console#AdminConsole'));
    assert.deepEqual(map.duplicateIds, []);
    assert.deepEqual(routeLines(cli('extract')), []);
  });
});

test('an item screen holds the code of the page the route draws and of every component the item names, and no screen holds the table file', async () => {
  await withTableCopy(async ({ configFile }) => {
    const map = await build(configFile);
    const site = screen(map, '/admin_console/users/site#BrandImage');
    assert.deepEqual(site.sourceFiles, ['admin/BrandImage.js', 'admin/SchemaSettings.js']);
    assert.deepEqual(site.apiCalls.map((c) => c.fn), ['ajaxMemberList']);
    assert.deepEqual(screen(map, '/admin_console/users/plain#SchemaSettings').sourceFiles, ['admin/SchemaSettings.js']);
    const outer = screen(map, '/admin_console#AdminConsole');
    assert.deepEqual(outer.sourceFiles, [CONSOLE, 'admin/SchemaSettings.js']);
    assert.deepEqual(outer.apiCalls, []);
    assert.ok(!map.screens.some((s) => s.sourceFiles.includes(TABLE)));
  });
});

test('an item\'s address and components are read through names declared in the table file and imported from other files', async () => {
  const edits: [string, string, string][] = [
    [TABLE, "import { ID_PATTERN } from './patterns';", "import { ID_PATTERN } from './patterns';\nconst LICENSE_URL = 'about/license';\nconst licenseSchema = { id: 'License', component: License };"],
    [TABLE, "url: 'about/license',\n        schema: { id: 'License', component: License },", 'url: LICENSE_URL,\n        schema: licenseSchema,'],
  ];
  await withTableCopy(async ({ configFile }) => {
    const map = await build(configFile);
    assert.equal(screen(map, '/admin_console/about/license#License').componentFile, 'admin/License.js');
    assert.ok(screen(map, '/admin_console/users/:user_id#UserDetail'));
  }, { edits });
});

test('a table written in the route file itself gives the same item screens, and the route file keeps its own code and imports in its screen\'s sources, also when the outer route imports it through an index file', async () => {
  const expected = (map: ScreenMap) => tableScreens(map).map((s) => [s.id, s.componentFile]);
  const plain = await withTableCopy(async ({ configFile }) => expected(await build(configFile)));
  const routeFileSources = [CONSOLE, 'admin/BrandImage.js', 'admin/License.js', 'admin/SchemaSettings.js', 'admin/UserDetail.js', 'admin/Users.js', 'admin/patterns.js'];
  const tableInRouteFile = (src: string) => {
    const table = fs.readFileSync(path.join(src, TABLE), 'utf8').replace('\nexport default AdminDefinition;\n', '');
    const routeFile = fs.readFileSync(path.join(src, CONSOLE), 'utf8').replace("import AdminDefinition from './definition';\n", '');
    fs.writeFileSync(path.join(src, CONSOLE), `${table}\n${routeFile}`);
  };
  const configPatch = { routeTables: [{ ...ROUTE_TABLE, table: { file: CONSOLE, const: 'AdminDefinition' } }] };
  await withTableCopy(async ({ configFile, src }) => {
    tableInRouteFile(src);
    const map = await build(configFile);
    assert.deepEqual(expected(map), plain);
    assert.deepEqual(screen(map, '/admin_console#AdminConsole').sourceFiles, routeFileSources);
  }, { configPatch });
  await withTableCopy(async ({ configFile, src }) => {
    tableInRouteFile(src);
    fs.writeFileSync(path.join(src, 'admin/index.js'), "import AdminConsole from './AdminConsole';\n\nexport default AdminConsole;\n");
    const map = await build(configFile);
    assert.deepEqual(expected(map), plain);
    assert.deepEqual(screen(map, '/admin_console#AdminConsole').sourceFiles, ['admin/index.js', ...routeFileSources].sort());
  }, { configPatch, edits: [['Routes.js', "import AdminConsole from './admin/AdminConsole';", "import AdminConsole from './admin';"]] });
});

test('an item whose components only redirect gives no screen and no line, while one that also draws a page stays a screen', async () => {
  const redirects: Record<string, string> = {
    'admin/UsersRedirect.js': "import { Redirect } from 'react-router-dom';\n\nconst UsersRedirect = ({ match }) => (\n  <Redirect to={match.url.replace(/old$/, '')} />\n);\n\nexport default UsersRedirect;\n",
    'admin/MovedRedirect.js': "import { Redirect } from 'react-router-dom';\n\nexport default function MovedRedirect() {\n  return <Redirect to=\"/admin_console/users\" />;\n}\n",
    'admin/Gate.js': "import { Redirect } from 'react-router-dom';\nimport Users from './Users';\n\nconst Gate = ({ ok }) => (ok ? <Users /> : <Redirect to=\"/admin_console\" />);\n\nexport default Gate;\n",
  };
  const items = Object.entries({ old: 'UsersRedirect', moved: 'MovedRedirect', gate: 'Gate' })
    .map(([key, component]) => `      ${key}: {\n        url: 'users/${key}',\n        schema: { id: '${component}', component: ${component} },\n      },\n`).join('');
  const edits: [string, string, string][] = [
    [TABLE, '      plain: {', `${items}      plain: {`],
    [TABLE, "import License from './License';", "import License from './License';\nimport UsersRedirect from './UsersRedirect';\nimport MovedRedirect from './MovedRedirect';\nimport Gate from './Gate';"],
  ];
  await withTableCopy(async ({ configFile, src, cli }) => {
    for (const [file, text] of Object.entries(redirects)) fs.writeFileSync(path.join(src, file), text);
    const map = await build(configFile);
    const paths = tableScreens(map).map((s) => s.path);
    assert.ok(paths.includes('/admin_console/users/gate'), paths.join(', '));
    assert.ok(!paths.includes('/admin_console/users/old') && !paths.includes('/admin_console/users/moved'), paths.join(', '));
    assert.deepEqual(routeLines(cli('extract')), []);
  }, { edits });
});

test('two items that make the same screen ID are reported at their lines in the table, and the task list and the summary name the table item of a screen', async () => {
  const edits: [string, string, string][] = [
    [TABLE, "      plain: {", "      again: {\n        url: 'users',\n        schema: { id: 'Users', component: Users },\n      },\n      outside: {\n        url: 'users/outside',\n        schema: { id: 'Outside', component: OutsidePage },\n      },\n      plain: {"],
    [TABLE, "import License from './License';", "import License from './License';\nimport OutsidePage from 'outside-pages';"],
  ];
  await withTableCopy(async ({ configFile, src, cli }) => {
    const map = await build(configFile);
    const places = [{ file: TABLE, line: itemLine(src, 'list') }, { file: TABLE, line: itemLine(src, 'again') }];
    assert.deepEqual(map.duplicateIds, [{ id: '/admin_console/users#Users', places }]);
    const route = `${CONSOLE}:${lineIn(src, CONSOLE, '<Route key={item.url}')}`;
    assert.deepEqual(routeLines(cli('extract')), [
      `  duplicate screen ID /admin_console/users#Users ← ${places.map((p) => `${p.file}:${p.line}`).join(', ')}`,
      `  component file not found for /admin_console/users/outside#OutsidePage ← ${route}, table item users.subsections.outside at ${TABLE}:${itemLine(src, 'outside')}`,
    ]);

    cli('rebuild');
    const { marksDir, storiesDir } = loadConfig(configFile);
    fs.mkdirSync(storiesDir, { recursive: true });
    fs.writeFileSync(path.join(storiesDir, 'brand.json'), JSON.stringify({ name: '브랜드 이미지를 바꾼다', screens: ['/admin_console#AdminConsole', '/admin_console/users/site#BrandImage'], author: 'reviewer', date: '2026-10-20' }));
    addMark(marksDir, { target: { node: '/admin_console/users/site#BrandImage' }, status: 'needs-more', note: 'No test.', author: 'a' }, new Date('2026-10-20T01:00:00Z'));
    addMark(marksDir, { target: { story: 'brand' }, status: 'needs-more', note: 'No test.', author: 'a' }, new Date('2026-10-20T01:00:00Z'));
    addMark(marksDir, { target: { story: 'brand', part: { kind: 'step', key: { step: 2, screen: '/admin_console/users/site#BrandImage' } } }, note: 'Upload one.', author: 'b' }, new Date('2026-10-20T02:00:00Z'));
    const item = `table item users.subsections.site at ${TABLE}:${itemLine(src, 'site')}`;
    const tasks = cli('tasks');
    assert.ok(tasks.includes(`\n- component: admin/BrandImage.js, route at ${route}, ${item}\n`), tasks);
    assert.ok(tasks.includes(`\n  - step 2: /admin_console/users/site#BrandImage, component admin/BrandImage.js, route at ${route}, ${item}\n`), tasks);
  }, { edits });
});

test('routeTables must be a list of entries naming a listed route file, a table and the path to its items', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const base = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const load = (routeTables: unknown) => {
      fs.writeFileSync(configFile, JSON.stringify({ ...base, routeTables }));
      return () => loadConfig(configFile);
    };
    const entry = { route: 'Routes.js', table: { file: 'store/settings.js', const: 'defaults' }, items: '*' };
    assert.throws(load({ ...entry }), /^Error: routeTables must be a list of \{ "route", "table": \{ "file", "const" \}, "items" \}/);
    assert.throws(load([{ ...entry, table: 'store/settings.js' }]), /^Error: routeTables must be a list of/);
    assert.throws(load([{ ...entry, items: 'a..b' }]), /^Error: routeTables must be a list of/);
    assert.throws(load([{ ...entry, extra: 1 }]), /^Error: routeTables must be a list of/);
    assert.throws(load([{ ...entry, route: 'admin/Routes.js' }]), /^Error: routeTables\[0\]\.route "admin\/Routes\.js" is not listed in routesFile$/);
    assert.throws(load([entry, { ...entry, items: '*.*' }]), /^Error: routeTables\[1\]\.route "Routes\.js" is named by routeTables\[0\] too; a route file takes one table$/);
    assert.deepEqual(load([{ ...entry, route: './Routes.js' }])().routeTables, [entry]);
    assert.deepEqual(load(undefined)().routeTables, []);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('a table entry that finds no table, no item or no route made for each item, or two such routes, stops the run with the entry and what it found', async () => {
  await withTableCopy(({ configFile }) => {
    assert.match(failure(configFile), /routeTables\[0\]: admin\/definition\.js has no top-level const Missing holding an object/);
  }, { configPatch: { routeTables: [{ ...ROUTE_TABLE, table: { file: TABLE, const: 'Missing' } }] } });
  await withTableCopy(({ configFile }) => {
    assert.match(failure(configFile), /routeTables\[0\]: items "\*\.pages\.\*" finds no item with a url in AdminDefinition, which the route at admin\/AdminConsole\.js:\d+ reads/);
  }, { configPatch: { routeTables: [{ ...ROUTE_TABLE, items: '*.pages.*' }] } });
  await withTableCopy(({ configFile }) => {
    assert.match(failure(configFile), /routeTables\[0\]: Routes\.js has no route made for each item of a list whose path reads a field of the item/);
  }, { configPatch: { routeTables: [{ ...ROUTE_TABLE, route: 'Routes.js' }] } });
  const second = `${LOOP_ROUTE}\n      ))}\n      {schemas.map((item) => (\n        ${LOOP_ROUTE.replace('${props.match.url}/', '${props.match.url}/old/')}`;
  await withTableCopy(({ configFile, src }) => {
    const first = lineIn(src, CONSOLE, '<Route key={item.url}');
    const other = lineIn(src, CONSOLE, '<Route key={item.url}', first);
    assert.match(failure(configFile), new RegExp(`routeTables\\[0\\]: admin/AdminConsole\\.js has 2 routes made for each item of a list, at admin/AdminConsole\\.js:${first} and admin/AdminConsole\\.js:${other}; a route file takes one table`));
  }, { edits: [[CONSOLE, LOOP_ROUTE, second]] });
});
