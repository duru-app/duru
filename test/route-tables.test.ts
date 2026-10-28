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

test('item screens inside a layout handed to a component around the loop as a function each get the layout\'s menu links', async () => {
  const edits: [string, string, string][] = [
    [CONSOLE, "import SchemaSettings from './SchemaSettings';\n", "import SchemaSettings from './SchemaSettings';\nimport Layout from '../components/Layout';\n\nconst Frame = ({ layout, children }) => layout(children);\nconst appLayout = (children) => <Layout>{children}</Layout>;\n"],
    [CONSOLE, '    <Switch>\n', '    <Frame layout={appLayout}>\n    <Switch>\n'],
    [CONSOLE, '    </Switch>\n', '    </Switch>\n    </Frame>\n'],
  ];
  await withTableCopy(async ({ configFile }) => {
    const items = tableScreens(await build(configFile)).filter((s) => s.tableItem);
    assert.equal(items.length, 5);
    for (const s of items) assert.deepEqual(s.links.filter((l) => l.file === 'components/SideMenu.js').map((l) => l.to), ['/admin/report'], s.id);
  }, { edits });
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

test('an item\'s address written as a call of a function in the source is read as a route path written that way is', async () => {
  const edits: [string, string, string][] = [
    [TABLE, "import { ID_PATTERN } from './patterns';", "import { ID_PATTERN } from './patterns';\nconst adminPath = (...parts) => parts.join('/');"],
    [TABLE, "url: 'about/license',", "url: adminPath('about', 'license'),"],
    [TABLE, "url: 'users/plain',", 'url: adminPath(window.section),'],
  ];
  await withTableCopy(async ({ configFile, src }) => {
    const map = await build(configFile);
    assert.equal(screen(map, '/admin_console/about/license#License').componentFile, 'admin/License.js');
    assert.ok(!map.screens.some((s) => s.tableItem?.key === 'users.subsections.plain'));
    assert.deepEqual(map.unreadRoutes, [{ file: CONSOLE, line: lineIn(src, CONSOLE, '<Route key={item.url}'), reason: `table item users.subsections.plain at ${TABLE}:${itemLine(src, 'plain')}: its url stopped at adminPath(window.section)` }]);
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

test('an item whose address is not read, or that has none while others do, gives no screen and a route not read line naming the item and where reading stopped', async () => {
  const edits: [string, string, string][] = [
    [TABLE, '      plain: {', "      computed: {\n        url: pathOf('users'),\n        schema: { id: 'Computed', component: Users },\n      },\n      nameless: {\n        schema: { id: 'Nameless', component: Users },\n      },\n      elsewhere: {\n        url: OTHER_URL,\n        schema: { id: 'Elsewhere', component: Users },\n      },\n      plain: {"],
    [TABLE, "import License from './License';", "import License from './License';\nimport { pathOf, OTHER_URL } from './patterns';"],
    ['admin/patterns.js', "export const ID_PATTERN = '[a-z0-9]{26}';", "export const ID_PATTERN = '[a-z0-9]{26}';\nexport const pathOf = (name) => `${window.base}/${name}`;\nexport const OTHER_URL = pathOf('other');"],
  ];
  await withTableCopy(async ({ configFile, src, cli }) => {
    const map = await build(configFile);
    assert.deepEqual(tableScreens(map).map((s) => s.tableItem!.key), ['about.subsections.license', 'users.subsections.list', 'users.subsections.detail', 'users.subsections.site', 'users.subsections.plain']);
    const route = `${CONSOLE}:${lineIn(src, CONSOLE, '<Route key={item.url}')}`;
    assert.deepEqual(routeLines(cli('extract')), [
      `  route not read ← ${route}: table item users.subsections.computed at ${TABLE}:${itemLine(src, 'computed')}: its url stopped at pathOf('users')`,
      `  route not read ← ${route}: table item users.subsections.nameless at ${TABLE}:${itemLine(src, 'nameless')} has no url`,
      `  route not read ← ${route}: table item users.subsections.elsewhere at ${TABLE}:${itemLine(src, 'elsewhere')}: its url stopped at pathOf('other') in admin/patterns.js:${lineIn(src, 'admin/patterns.js', 'OTHER_URL')}`,
    ]);
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

test('a loop function that takes the item apart reads the path from the name bound to the item\'s field, also under another name, and gives the same item screens', async () => {
  const expected = (map: ScreenMap) => tableScreens(map).map((s) => [s.id, s.path, s.componentFile, s.line, s.tableItem]);
  const plain = await withTableCopy(async ({ configFile }) => expected(await build(configFile)));
  for (const [param, url] of [['{ url, schema }', 'url'], ['{ url: address, schema }', 'address']]) {
    const route = LOOP_ROUTE.replaceAll('item.url', url).replace('item.schema', 'schema');
    await withTableCopy(async ({ configFile, cli }) => {
      assert.deepEqual(expected(await build(configFile)), plain);
      assert.deepEqual(routeLines(cli('extract')), []);
    }, { edits: [[CONSOLE, `(item) => (\n        ${LOOP_ROUTE}`, `(${param}) => (\n        ${route}`]] });
  }
});

test('a loop function whose path name has a default, sits deeper in the item or comes from its rest reads no field, and the table entry stops the run', async () => {
  for (const [param, url] of [["{ url = 'x', schema }", 'url'], ['{ meta: { url }, schema }', 'url'], ['{ schema, ...rest }', 'rest.url']]) {
    const route = LOOP_ROUTE.replaceAll('item.url', url).replace('item.schema', 'schema');
    await withTableCopy(({ configFile }) => {
      assert.match(failure(configFile), /routeTables\[0\]: admin\/AdminConsole\.js has no route made for each item of a list whose path reads a field of the item/);
    }, { edits: [[CONSOLE, `(item) => (\n        ${LOOP_ROUTE}`, `(${param}) => (\n        ${route}`]] });
  }
});

const LIST_TABLE = `import License from './License';
import Users from './Users';
import UserDetail from './UserDetail';
import { ID_PATTERN } from './patterns';

const makeItem = (url) => ({ url, component: Users });
const licenseRoute = { url: 'about/license', component: License };
const detailRoutes = [
  { url: \`users/:user_id(\${ID_PATTERN})\`, component: UserDetail },
];

export const adminRoutes = [
  licenseRoute,
  { url: 'users', component: Users },
  ...detailRoutes,
];

export const withCall = [...adminRoutes, makeItem('made')];
`;

const listConsole = (loop: string) => `import { Route, Switch } from 'react-router-dom';
import { adminRoutes } from './definition';

export default function AdminConsole(props) {
  return (
    <Switch>
      {adminRoutes.map(${loop})}
    </Switch>
  );
}
`;

const ITEM_ROUTE = '(route) => <Route key={route.url} path={`${props.match.url}/${route.url}`} component={route.component} />';
const LIST_ENTRY = { ...ROUTE_TABLE, table: { file: TABLE, const: 'adminRoutes' }, items: '*' };

async function withListTable<T>(loop: string, fn: (copy: Copy) => T | Promise<T>, entry: Record<string, unknown> | null = {}, table = LIST_TABLE) {
  return withTableCopy(async (copy) => {
    fs.writeFileSync(path.join(copy.src, TABLE), table);
    fs.writeFileSync(path.join(copy.src, CONSOLE), listConsole(loop));
    return fn(copy);
  }, { configPatch: { routeTables: entry ? [{ ...LIST_ENTRY, ...entry }] : [] } });
}

const listItems = (src: string) => [
  ['/admin_console/about/license#License', 'admin/License.js', { key: '0', file: TABLE, line: lineIn(src, TABLE, '  licenseRoute,') }],
  ['/admin_console/users#Users', 'admin/Users.js', { key: '1', file: TABLE, line: lineIn(src, TABLE, "  { url: 'users'") }],
  ['/admin_console/users/:user_id#UserDetail', 'admin/UserDetail.js', { key: '2', file: TABLE, line: lineIn(src, TABLE, '  { url: `users/:user_id') }],
];
const itemScreens = (map: ScreenMap) => tableScreens(map).map((s) => [s.id, s.componentFile, s.tableItem]);

test('a table that is a top-level list gives a screen for each object in it, named by its place in the list, and a number in items picks one place', async () => {
  await withListTable(ITEM_ROUTE, async ({ configFile, src, cli }) => {
    assert.deepEqual(itemScreens(await build(configFile)), listItems(src));
    assert.deepEqual(routeLines(cli('extract')), []);
  });
  await withListTable(ITEM_ROUTE, async ({ configFile, src }) => {
    assert.deepEqual(itemScreens(await build(configFile)), [listItems(src)[1]]);
  }, { items: '1' });
});

test('an item whose path is a list gives a screen for each path in it under the item\'s place, and a path in it that is not read, or an empty list, gives a route not read line naming it', async () => {
  const table = LIST_TABLE
    .replace("import { ID_PATTERN } from './patterns';", "import { ID_PATTERN } from './patterns';\nimport { OUTSIDE } from 'paths-package';\n\nconst PEOPLE = ['people'];")
    .replace("{ url: 'users', component: Users }", "{ url: ['users', ...PEOPLE, 'people', OUTSIDE], component: Users }")
    .replace('  ...detailRoutes,\n];', '  ...detailRoutes,\n  { url: [], component: Users },\n];');
  await withListTable(ITEM_ROUTE, async ({ configFile, src, cli }) => {
    const usersItem = { key: '1', file: TABLE, line: lineIn(src, TABLE, "  { url: ['users'") };
    assert.deepEqual(itemScreens(await build(configFile)), [
      ['/admin_console/about/license#License', 'admin/License.js', { key: '0', file: TABLE, line: lineIn(src, TABLE, '  licenseRoute,') }],
      ['/admin_console/users#Users', 'admin/Users.js', usersItem],
      ['/admin_console/people#Users', 'admin/Users.js', usersItem],
      ['/admin_console/users/:user_id#UserDetail', 'admin/UserDetail.js', { key: '2', file: TABLE, line: lineIn(src, TABLE, '  { url: `users/:user_id') }],
    ]);
    const route = `${CONSOLE}:${lineIn(src, CONSOLE, '<Route key={route.url}')}`;
    assert.deepEqual(routeLines(cli('extract')), [
      `  route not read ← ${route}: table item 1 at ${TABLE}:${usersItem.line}: its url stopped at OUTSIDE`,
      `  route not read ← ${route}: table item 3 at ${TABLE}:${lineIn(src, TABLE, '  { url: [],')}: its url stopped at []`,
    ]);
  }, {}, table);
});

test('a list nested in an object table is walked by the same items path', async () => {
  const edits: [string, string, string][] = [
    [TABLE, '    subsections: {\n      list: {', '    subsections: [\n      {'],
    [TABLE, '      detail: {', '      {'],
    [TABLE, '      site: {', '      {'],
    [TABLE, '      plain: {', '      {'],
    [TABLE, '      },\n    },\n  },\n};', '      },\n    ],\n  },\n};'],
  ];
  await withTableCopy(async ({ configFile }) => {
    assert.deepEqual(tableScreens(await build(configFile)).map((s) => [s.id, s.tableItem!.key]), [
      ['/admin_console/about/license#License', 'about.subsections.license'],
      ['/admin_console/users#Users', 'users.subsections.0'],
      ['/admin_console/users/:user_id#UserDetail', 'users.subsections.1'],
      ['/admin_console/users/site#BrandImage', 'users.subsections.2'],
      ['/admin_console/users/plain#SchemaSettings', 'users.subsections.3'],
    ]);
  }, { edits });
});

test('an entry of a list table that is not an object written in the source gives no screen and a route not read line naming its place', async () => {
  await withListTable(ITEM_ROUTE, async ({ configFile, src, cli }) => {
    assert.deepEqual(itemScreens(await build(configFile)), listItems(src));
    const route = `${CONSOLE}:${lineIn(src, CONSOLE, '<Route key={route.url}')}`;
    assert.deepEqual(routeLines(cli('extract')), [
      `  route not read ← ${route}: table item 3 at ${TABLE}:${lineIn(src, TABLE, 'export const withCall')} is not an object written in the source`,
    ]);
  }, { table: { file: TABLE, const: 'withCall' } });
});

test('an item spread in from a list in another file is placed at its own file and line, and a list spread twice gives its items twice', async () => {
  const detail = 'admin/detail.js';
  const table = LIST_TABLE
    .replace("import UserDetail from './UserDetail';\nimport { ID_PATTERN } from './patterns';\n", "import { detailRoutes } from './detail';\n")
    .replace(/const detailRoutes = \[\n.*\n\];\n/, '')
    .replace('export const withCall', 'export const twice = [...detailRoutes, ...adminRoutes];\n\nexport const withCall');
  const detailSource = "import UserDetail from './UserDetail';\nimport { ID_PATTERN } from './patterns';\n\nexport const detailRoutes = [\n  { url: `users/:user_id(${ID_PATTERN})`, component: UserDetail },\n];\n";
  for (const entry of [{}, { table: { file: TABLE, const: 'twice' } }]) {
    await withListTable(ITEM_ROUTE, async ({ configFile, src, cli }) => {
      fs.writeFileSync(path.join(src, detail), detailSource);
      const atDetail = { file: detail, line: lineIn(src, detail, '  { url: `users/:user_id') };
      const keys = tableScreens(await build(configFile)).map((s) => s.tableItem);
      if (!Object.keys(entry).length) {
        assert.deepEqual(keys, [
          { key: '0', file: TABLE, line: lineIn(src, TABLE, '  licenseRoute,') },
          { key: '1', file: TABLE, line: lineIn(src, TABLE, "  { url: 'users'") },
          { key: '2', ...atDetail },
        ]);
        assert.deepEqual(routeLines(cli('extract')), []);
      } else {
        assert.deepEqual(keys.map((k) => k!.key), ['0', '1', '2', '3']);
        assert.ok(!routeLines(cli('extract')).some((l) => l.includes('is not an object')));
      }
    }, entry, table);
  }
});

test('a list of plain values inside an object table gives no item and no line', async () => {
  await withTableCopy(async ({ configFile, cli }) => {
    assert.ok(!tableScreens(await build(configFile)).some((s) => s.tableItem!.key.startsWith('tabs.')));
    assert.ok(!routeLines(cli('extract')).some((l) => l.includes('tabs.subsections')));
  }, { edits: [[TABLE, '  users: {\n', "  tabs: {\n    sectionTitle: 'Tabs',\n    subsections: ['about', 'users'],\n  },\n  users: {\n"]] });
});

test('in loops nested in loops, a route that draws a field of the outer item does not look for that field in the inner item', async () => {
  const table = `import License from './License';
import Users from './Users';

export const adminRoutes = [{ layout: Users, pages: [{ url: 'about/license', component: License }] }];
`;
  const loop = '(section) => section.pages.map((page) => <Route key={page.url} path={`${props.match.url}/${page.url}`} component={section.layout} />)';
  await withListTable(loop, async ({ configFile, cli }) => {
    assert.deepEqual(tableScreens(await build(configFile)).map((s) => [s.path, s.tableItem!.key]), [['/admin_console/about/license', '0.pages.0']]);
    assert.deepEqual(routeLines(cli('extract')), []);
  }, { items: '*.pages.*' }, table);
});

test('a loop route that draws the item\'s own component, by component, element, render or children, through a parameter taken apart or read as route.component, gives a screen for each table item', async () => {
  const urlPath = '`${props.match.url}/${url}`';
  const memberPath = '`${props.match.url}/${route.url}`';
  const loops = [
    `({ url, component }) => <Route key={url} path={${urlPath}} component={component} />`,
    `({ url: address, component: Page }) => <Route key={address} path={\`\${props.match.url}/\${address}\`} element={<Page />} />`,
    `({ url, component: Component }) => <Route key={url} path={${urlPath}} render={(routeProps) => <Component {...routeProps} />} />`,
    `(route) => <Route key={route.url} path={${memberPath}} render={(routeProps) => <route.component {...routeProps} />} />`,
    `({ url, component: Component }) => <Route key={url} path={${urlPath}}><Component /></Route>`,
    `(route) => <Route key={route.url} path={${memberPath}}><route.component /></Route>`,
  ];
  for (const loop of loops) {
    await withListTable(loop, async ({ configFile, src, cli }) => {
      assert.deepEqual(itemScreens(await build(configFile)), listItems(src), loop);
      assert.deepEqual(routeLines(cli('extract')), [], loop);
    });
  }
});

test('a loop route that draws the item\'s own component takes it from the field it draws, and an item without that field gives a route not read line instead of a screen', async () => {
  const table = LIST_TABLE.replaceAll('component:', 'page:').replace('  ...detailRoutes,\n];', "  ...detailRoutes,\n  { url: 'old', redirect: 'users', component: Users },\n];");
  const urlPath = '`${props.match.url}/${url}`';
  const loops = [
    '(route) => <Route key={route.url} path={`${props.match.url}/${route.url}`} element={<route.page />} />',
    `({ url, page: Page }) => <Route key={url} path={${urlPath}} element={<Page />} />`,
    `({ url, page }) => <Route key={url} path={${urlPath}} component={page} />`,
    `({ url, page: Component }) => <Route key={url} path={${urlPath}} render={(routeProps) => <Component {...routeProps} />} />`,
    `({ url, page: Component }) => <Route key={url} path={${urlPath}}><Component /></Route>`,
  ];
  for (const loop of loops) {
    await withListTable(loop, async ({ configFile, src, cli }) => {
      assert.deepEqual(itemScreens(await build(configFile)), listItems(src), loop);
      assert.deepEqual(routeLines(cli('extract')), [
        `  route not read ← ${CONSOLE}:${lineIn(src, CONSOLE, '<Route key=')}: table item 3 at ${TABLE}:${lineIn(src, TABLE, "{ url: 'old'")} has no page`,
      ], loop);
    }, {}, table);
  }
});

test('without a table entry, a loop route that draws the item\'s own component in render or as its child gives no screen and prints no line', async () => {
  const urlPath = '`${props.match.url}/${url}`';
  const memberPath = '`${props.match.url}/${route.url}`';
  const loops = [
    `({ url, component: Component }) => <Route key={url} path={${urlPath}} render={(routeProps) => <Component {...routeProps} />} />`,
    `(route) => <Route key={route.url} path={${memberPath}} render={(routeProps) => <route.component {...routeProps} />} />`,
    `({ url, component: Component }) => <Route key={url} path={${urlPath}}><Component /></Route>`,
    `(route) => <Route key={route.url} path={${memberPath}}><route.component /></Route>`,
  ];
  for (const loop of loops) {
    await withListTable(loop, async ({ configFile, cli }) => {
      assert.deepEqual(itemScreens(await build(configFile)), [], loop);
      assert.deepEqual(routeLines(cli('extract')), [], loop);
    }, null);
  }
});

test('a loop route whose path reads the item but whose screen is not read stops the run with the entry and that route, not with a path it did read', async () => {
  const urlPath = '`${props.match.url}/${url}`';
  const loops = [
    `({ url }) => <Route key={url} path={${urlPath}} render={(routeProps) => <routeProps.page />} />`,
    `({ url, ...rest }) => <Route key={url} path={${urlPath}} {...rest} />`,
  ];
  for (const loop of loops) {
    await withListTable(loop, ({ configFile, src }) => {
      const line = lineIn(src, CONSOLE, '<Route key={url}');
      assert.match(failure(configFile), new RegExp(`routeTables\\[0\\]: the route at admin/AdminConsole\\.js:${line} is made for each item of a list and its path reads the item's url, but the screen it draws is not read`), loop);
    });
  }
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
    assert.throws(load({ ...entry }), /^Error: routeTables must be a list of \{ "route", "table": \{ "file", "const" \}, "items", "menus" \}/);
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
    assert.match(failure(configFile), /routeTables\[0\]: admin\/definition\.js has no top-level const Missing holding an object or a list/);
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

const SIDEBAR = 'admin/AdminSidebar.js';
const SIDEBAR_SOURCES: Record<string, string> = {
  [SIDEBAR]: `import SidebarSection from './SidebarSection';

export default function AdminSidebar({ definition }) {
  const sections = [];
  Object.entries(definition).forEach(([key, section]) => {
    Object.entries(section.subsections).forEach(([subKey, item]) => {
      sections.push(<SidebarSection key={key + '.' + subKey} name={item.url} title={section.sectionTitle} />);
    });
  });
  return <ul>{sections}</ul>;
}
`,
  'admin/SidebarSection.js': `import { NavLink } from 'react-router-dom';

export default function SidebarSection({ name, title, parentLink = '' }) {
  const link = parentLink + '/' + name;
  return <li><NavLink to={link}>{title}</NavLink></li>;
}
`,
};
const SIDEBAR_EDITS: [string, string, string][] = [
  [CONSOLE, "import SchemaSettings from './SchemaSettings';\n", "import SchemaSettings from './SchemaSettings';\nimport AdminSidebar from './AdminSidebar';\n"],
  [CONSOLE, '    <Switch>\n', '    <>\n    <AdminSidebar definition={AdminDefinition} />\n    <Switch>\n'],
  [CONSOLE, '    </Switch>\n', '    </Switch>\n    </>\n'],
];
const MENU_TABLE = { ...ROUTE_TABLE, menus: [SIDEBAR] };

async function withMenuCopy<T>(fn: (copy: Copy) => T | Promise<T>, { configPatch = { routeTables: [MENU_TABLE] }, edits = [] }: { configPatch?: Record<string, unknown>; edits?: [string, string, string][] } = {}): Promise<T> {
  return withTableCopy(async (copy) => {
    for (const [file, text] of Object.entries(SIDEBAR_SOURCES)) fs.writeFileSync(path.join(copy.src, file), text);
    for (const [file, from, to] of edits) {
      const text = fs.readFileSync(path.join(copy.src, file), 'utf8');
      assert.ok(text.includes(from), `${file} has no ${from}`);
      fs.writeFileSync(path.join(copy.src, file), text.split(from).join(to));
    }
    return fn(copy);
  }, { configPatch, edits: SIDEBAR_EDITS });
}

const menuRows = (s: ScreenMap['screens'][number]) => s.links.filter((l) => l.file === SIDEBAR);

test('a menu file named in a table entry gives every screen holding it one link for each table item, to the screen made from that item, at the element that reads the field the route path reads', async () => {
  await withMenuCopy(async ({ configFile, src, cli }) => {
    const map = await build(configFile);
    const line = lineIn(src, SIDEBAR, '<SidebarSection');
    const item = (key: string, sub: string) => ({ key, file: TABLE, line: itemLine(src, sub) });
    const holding = map.screens.filter((s) => s.sourceFiles.includes(SIDEBAR));
    assert.deepEqual(holding.map((s) => s.id), ['/admin_console#AdminConsole', ...tableScreens(map).filter((s) => s.tableItem).map((s) => s.id)]);
    for (const s of holding) {
      assert.deepEqual(menuRows(s).map((l) => [l.to, l.line, l.tableItem, l.targets]), [
        ['/admin_console/about/license', line, item('about.subsections.license', 'license'), ['/admin_console/about/license#License']],
        ['/admin_console/users', line, item('users.subsections.list', 'list'), ['/admin_console/users#Users']],
        ['/admin_console/users/site', line, item('users.subsections.site', 'site'), ['/admin_console/users/site#BrandImage']],
        ['/admin_console/users/plain', line, item('users.subsections.plain', 'plain'), ['/admin_console/users/plain#SchemaSettings']],
      ], s.id);
    }
    assert.deepEqual(routeLines(cli('extract')), []);
  });
});

test('without menus in the table entry the menu element gives no link for each item', async () => {
  await withMenuCopy(async ({ configFile }) => {
    const map = await build(configFile);
    assert.ok(map.screens.some((s) => s.sourceFiles.includes(SIDEBAR)));
    assert.ok(!map.screens.some((s) => s.links.some((l) => l.tableItem)));
  }, { configPatch: { routeTables: [ROUTE_TABLE] } });
});

test('a menu link element whose address reads the item field gives the item links in place of the link it would give, and the address written around the field is not read', async () => {
  const edits: [string, string, string][] = [
    [SIDEBAR, "import SidebarSection from './SidebarSection';", "import { NavLink } from 'react-router-dom';"],
    [SIDEBAR, "sections.push(<SidebarSection key={key + '.' + subKey} name={item.url} title={section.sectionTitle} />);", 'sections.push(<NavLink key={item.url} to={`/old/${item.url}`}>{item.title}</NavLink>);'],
  ];
  await withMenuCopy(async ({ configFile, src }) => {
    const map = await build(configFile);
    const line = lineIn(src, SIDEBAR, '<NavLink');
    const rows = menuRows(screen(map, '/admin_console/users#Users'));
    assert.deepEqual(rows.map((l) => [l.to, l.line]), [
      ['/admin_console/about/license', line], ['/admin_console/users', line], ['/admin_console/users/site', line], ['/admin_console/users/plain', line],
    ]);
  }, { edits });
});

test('a menu loop function that takes the item apart gives the same item links through the name bound to the field', async () => {
  const edits: [string, string, string][] = [
    [SIDEBAR, "import SidebarSection from './SidebarSection';", "import { NavLink } from 'react-router-dom';"],
    [SIDEBAR, `  const sections = [];
  Object.entries(definition).forEach(([key, section]) => {
    Object.entries(section.subsections).forEach(([subKey, item]) => {
      sections.push(<SidebarSection key={key + '.' + subKey} name={item.url} title={section.sectionTitle} />);
    });
  });
  return <ul>{sections}</ul>;`, `  const items = Object.values(definition).flatMap((section) => Object.values(section.subsections));
  return <ul>{items.map(({ url: address, title }) => <NavLink key={address} to={'/admin_console/' + address}>{title}</NavLink>)}</ul>;`],
  ];
  await withMenuCopy(async ({ configFile }) => {
    assert.deepEqual(menuRows(screen(await build(configFile), '/admin_console/users#Users')).map((l) => l.to), ['/admin_console/about/license', '/admin_console/users', '/admin_console/users/site', '/admin_console/users/plain']);
  }, { edits });
});

test('the menu link is kept under the conditions written around its element in the menu file', async () => {
  const edits: [string, string, string][] = [
    [SIDEBAR, 'export default function AdminSidebar({ definition }) {', 'export default function AdminSidebar({ definition, isAdmin }) {'],
    [SIDEBAR, '      sections.push(', '      if (isAdmin) sections.push('],
  ];
  await withMenuCopy(async ({ configFile }) => {
    const rows = menuRows(screen(await build(configFile), '/admin_console/users#Users'));
    assert.equal(rows.length, 4);
    for (const l of rows) assert.deepEqual(l.guards, ['isAdmin']);
  }, { edits });
});

test('a table declared as the only const of its name inside a function of the table file gives the same item screens and menu links', async () => {
  const edits: [string, string, string][] = [
    [TABLE, 'const AdminDefinition = {', 'export function useAdminDefinition() {\n  const AdminDefinition = {'],
    [TABLE, 'export default AdminDefinition;', '  return AdminDefinition;\n}\n\nexport default useAdminDefinition;'],
  ];
  await withMenuCopy(async ({ configFile, src }) => {
    const map = await build(configFile);
    assert.deepEqual(tableScreens(map).filter((s) => s.tableItem).map((s) => s.id), [
      '/admin_console/about/license#License', '/admin_console/users#Users', '/admin_console/users/:user_id#UserDetail', '/admin_console/users/site#BrandImage', '/admin_console/users/plain#SchemaSettings',
    ]);
    assert.deepEqual(screen(map, '/admin_console/users#Users').tableItem, { key: 'users.subsections.list', file: TABLE, line: lineIn(src, TABLE, 'list: {') });
    assert.equal(menuRows(screen(map, '/admin_console/users#Users')).length, 4);
  }, { edits });
  const twice: [string, string, string][] = [
    [TABLE, 'const AdminDefinition = {', 'function other() {\n  const AdminDefinition = {};\n  return AdminDefinition;\n}\n\nexport function useAdminDefinition() {\n  const AdminDefinition = {'],
    [TABLE, 'export default AdminDefinition;', '  return AdminDefinition;\n}\n\nexport default useAdminDefinition;'],
  ];
  await withMenuCopy(({ configFile }) => {
    assert.match(failure(configFile), /routeTables\[0\]: admin\/definition\.js has no top-level const AdminDefinition holding an object or a list, and 2 consts of that name inside functions/);
  }, { edits: twice });
});

test('a menu file that is missing, has no element reading the field the route path reads from an item of a list, or has two, stops the run with the entry', async () => {
  await withMenuCopy(({ configFile }) => {
    assert.match(failure(configFile), /routeTables\[0\]\.menus\[0\]: admin\/Missing\.js is not a file/);
  }, { configPatch: { routeTables: [{ ...ROUTE_TABLE, menus: ['admin/Missing.js'] }] } });
  await withMenuCopy(({ configFile }) => {
    assert.match(failure(configFile), /routeTables\[0\]\.menus\[0\]: admin\/AdminSidebar\.js has no element made for each item of a list that reads the item's url, the field the route at admin\/AdminConsole\.js:\d+ reads/);
  }, { edits: [[SIDEBAR, 'name={item.url}', 'name={item.title}']] });
  await withMenuCopy(({ configFile, src }) => {
    const first = lineIn(src, SIDEBAR, '<SidebarSection');
    const other = lineIn(src, SIDEBAR, '<SidebarSection', first);
    assert.match(failure(configFile), new RegExp(`routeTables\\[0\\]\\.menus\\[0\\]: admin/AdminSidebar\\.js has 2 elements made for each item of a list that read the item's url, at admin/AdminSidebar\\.js:${first} and admin/AdminSidebar\\.js:${other}`));
  }, { edits: [[SIDEBAR, '      sections.push(', '      sections.push(<SidebarSection key={subKey} name={item.url} />);\n      sections.push(']] });
});

test('menus in a table entry must be a list of files', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const base = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const load = (menus: unknown) => {
      fs.writeFileSync(configFile, JSON.stringify({ ...base, routeTables: [{ route: 'Routes.js', table: { file: 'store/settings.js', const: 'defaults' }, items: '*', menus }] }));
      return () => loadConfig(configFile);
    };
    assert.throws(load('components/SideMenu.js'), /^Error: routeTables must be a list of \{ "route", "table": \{ "file", "const" \}, "items", "menus" \}/);
    assert.throws(load([1]), /^Error: routeTables must be a list of/);
    assert.deepEqual(load(['./components/SideMenu.js'])().routeTables[0].menus, ['components/SideMenu.js']);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('the usage guide, the agent skill and the decision record describe routeTables', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
  assert.match(read('../README.md'), /`routeTables` — route files that make one route for each item of a table[\s\S]*The items give screens/);
  assert.match(read('../README.md'), /For a screen made from a table item, `, table item <key> at <file>:<line>` follows\./);
  assert.match(read('../skills/duru/SKILL.md'), /add a\s+`routeTables` entry to the config yourself as you add the other config items[\s\S]*tell the user which screens appeared/);
  assert.match(read('../README.md'), /`routeTables`[\s\S]*an\s+object or a list[\s\S]*In a\s+list the key is the item's place, counted from 0/);
  assert.match(read('../README.md'), /or with `is not an object written in the\s+source` for a list item/);
  assert.match(read('../skills/duru/SKILL.md'), /`routes\.map\(\(\{ path, component \}\) => …\)`[\s\S]*`"items": "\*"` for a list of routes/);
  assert.match(read('../docs/decisions.md'), /\*\*A route table may be a list, a route made for each item may take the item apart in its loop function, and a listed\nroute file with no route element is named in the summary\.\*\*/);
  assert.match(read('../docs/decisions.md'), /\*\*A route made for each item of a table gives screens for its items when the config names the table in `routeTables`,\nand a table file of its own is in no screen's sources\.\*\*/);
});
