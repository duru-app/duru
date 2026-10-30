import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildFlow } from '../src/flow.ts';
import type { FlowScreenNode } from '../src/flow.ts';
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
    assert.throws(load({ ...entry }), /^Error: routeTables must be a list of \{ "route", "table": \{ "file", "const" \}, "items" \} with an optional "menus"/);
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

test('routeTabs must be a list of entries naming the component, the prop it is handed its tabs by and the fields holding a tab\'s address and component', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const base = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const load = (routeTabs: unknown) => {
      fs.writeFileSync(configFile, JSON.stringify({ ...base, routeTabs }));
      return () => loadConfig(configFile);
    };
    const entry = { import: 'components/RouteTab', name: 'default', items: 'routes', path: 'route', component: 'Component' };
    assert.throws(load({ ...entry }), /^Error: routeTabs must be a list of \{ "import", "name", "items", "path", "component" \}: the import path and name the app imports a component by that picks a tab by the address/);
    for (const wrong of [{ name: 'RouteTab default' }, { name: 'Route.Tabs' }, { items: 'routes.tabs' }, { items: '*routes' }, { path: 'meta.*' }, { path: 'a..b' }, { component: 'Component?' }, { import: 1 }]) {
      assert.throws(load([{ ...entry, ...wrong }]), /^Error: routeTabs must be a list of/, JSON.stringify(wrong));
    }
    for (const missing of ['import', 'name', 'items', 'path', 'component']) {
      const { [missing]: _, ...rest } = entry as Record<string, unknown>;
      assert.throws(load([rest]), /^Error: routeTabs must be a list of/, missing);
    }
    assert.throws(load([{ ...entry, extra: 1 }]), /^Error: routeTabs must be a list of/);
    assert.throws(load([entry, 'RouteTab']), /, not \[\{"import":"components\/RouteTab".*"RouteTab"\]$/);
    assert.deepEqual(load([{ ...entry, path: 'meta.path' }])().routeTabs, [{ ...entry, path: 'meta.path' }]);
    assert.deepEqual(load(undefined)().routeTabs, []);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('the usage guide, the agent skill and the decision record say what routeTabs names, what it gives on the map and what it does not read', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8').replace(/\s+/g, ' ');
  const readme = read('../README.md');
  assert.match(readme, /`routeTabs` — components that pick a tab by the address[\s\S]*"routeTabs": \[\{ "import": "components\/RouteTab", "name": "default", "items": "routes", "path": "route", "component": "Component" \}\]/);
  assert.match(readme, /all five are required, and `path` and `component` may be dotted key paths inside the item, such as `"meta\.path"`/);
  assert.match(readme, /conditions written around a `push` are not read, as for the items of a `routeTables` table, so every tab becomes a screen/);
  assert.match(readme, /A tab component that is not handed its list through that prop, and reads it itself, is not read\./);
  assert.match(readme, /with the ID `<address>#<Component>`: the screen that draws the tab component is its frame/);
  assert.match(readme, /does not start with `\/` gets the drawing screen's path in front, so `billing` under `\/settings` gives `\/settings\/billing`, and an absolute address is kept as it is/);
  assert.match(readme, /gives no tab screen and a `routeTabs` line, never an error/);
  assert.match(readme, /The conditions written in an item are not read, and neither are the conditions written around a `push` of the list a tab component is handed \(`routeTabs`\)/);
  assert.match(readme, /`routeTabs <import> <name> is drawn by no screen`/);
  assert.match(readme, /`routeTabs <file>:<line> its <prop> stopped at <piece>`/);
  assert.match(readme, /`routeTabs <file>:<line> the item at <file>:<line> has no <field>`/);
  assert.match(readme, /When a `routeTabs` entry gives those addresses screens of their own, the links reach screens and the line is not printed\./);
  assert.match(read('../skills/duru/SKILL.md'), /Add a `routeTabs` entry to the config yourself as you add the other config items[\s\S]*tell the user which tab screens appeared[\s\S]*that list was not read/);
  const decisions = read('../docs/decisions.md');
  assert.match(decisions, /\*\*A component that picks a tab by the address is named in `routeTabs`, and its tabs are read from the list the screen that draws it hands it\.\*\*/);
  assert.match(decisions, /Driver's decision in #452 \(2026-10-31\)[\s\S]*the component is named in the config[\s\S]*the entries are read from the source, never guessed/);
  assert.match(decisions, /Guessing the component from `matchPath`[\s\S]*Following `push` accumulation in `listEntries`[\s\S]*those maps cannot move/);
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

test('the menu links are marked as the layout\'s on the item screens, which the route file holding the menu draws, and not on the screen whose own component draws the menu', async () => {
  await withMenuCopy(async ({ configFile }) => {
    const map = await build(configFile);
    const layoutOf = (id: string) => [...new Set(menuRows(screen(map, id)).map((l) => l.layout ?? false))];
    assert.deepEqual(layoutOf('/admin_console/users#Users'), [true]);
    assert.deepEqual(layoutOf('/admin_console/about/license#License'), [true]);
    assert.deepEqual(layoutOf('/admin_console#AdminConsole'), [false]);
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

test('when an element made for an item that reads the item\'s field holds another that reads it too, the innermost is the menu element', async () => {
  const edits: [string, string, string][] = [
    [SIDEBAR, "import SidebarSection from './SidebarSection';", "import { NavLink } from 'react-router-dom';"],
    [SIDEBAR, "sections.push(<SidebarSection key={key + '.' + subKey} name={item.url} title={section.sectionTitle} />);", 'sections.push(\n        <li key={item.url} data-testid={item.url} className={item.url === active ? \'active\' : \'\'}>\n          <NavLink to={`/old/${item.url}`}>{item.title}</NavLink>\n        </li>,\n      );'],
    [SIDEBAR, 'export default function AdminSidebar({ definition }) {', 'export default function AdminSidebar({ definition, active }) {'],
  ];
  await withMenuCopy(async ({ configFile, src }) => {
    const map = await build(configFile);
    const line = lineIn(src, SIDEBAR, '<NavLink');
    assert.notEqual(line, lineIn(src, SIDEBAR, '<li'));
    assert.deepEqual(menuRows(screen(map, '/admin_console/users#Users')).map((l) => [l.to, l.line]), [
      ['/admin_console/about/license', line], ['/admin_console/users', line], ['/admin_console/users/site', line], ['/admin_console/users/plain', line],
    ]);
  }, { edits });
});

test('an element drawn by a loop inside the item\'s loop does not count against the item\'s own elements, so the item\'s link and not a submenu link is the menu element', async () => {
  const edits: [string, string, string][] = [
    [SIDEBAR, "import SidebarSection from './SidebarSection';", "import { NavLink } from 'react-router-dom';"],
    [SIDEBAR, "sections.push(<SidebarSection key={key + '.' + subKey} name={item.url} title={section.sectionTitle} />);", 'sections.push(\n        <li key={item.url} data-testid={item.url}>\n          <NavLink to={`/old/${item.url}`}>{item.title}</NavLink>\n          {item.children && <ul>{item.children.map((c) => <NavLink key={c.url} to={c.url}>{c.title}</NavLink>)}</ul>}\n        </li>,\n      );'],
  ];
  await withMenuCopy(async ({ configFile, src }) => {
    const map = await build(configFile);
    const line = lineIn(src, SIDEBAR, '<NavLink to={`/old/');
    assert.deepEqual(menuRows(screen(map, '/admin_console/users#Users')).filter((l) => l.tableItem).map((l) => [l.to, l.line, l.guards]), [
      ['/admin_console/about/license', line, []], ['/admin_console/users', line, []], ['/admin_console/users/site', line, []], ['/admin_console/users/plain', line, []],
    ]);
  }, { edits });
});

test('a menu element drawn by a function inside the item\'s loop, as a render function of a message or a permission check, is found as the item\'s element', async () => {
  for (const drawn of [
    '<FormattedMessage key={item.url} id={item.title}>{(t) => <NavLink to={item.url}>{t}</NavLink>}</FormattedMessage>',
    '<Can key={item.url} do="see">{() => <NavLink to={item.url}>{item.title}</NavLink>}</Can>',
  ]) {
    const edits: [string, string, string][] = [
      [SIDEBAR, "import SidebarSection from './SidebarSection';", "import { NavLink } from 'react-router-dom';\nimport { FormattedMessage } from 'react-intl';\nimport { Can } from '@casl/react';"],
      [SIDEBAR, "sections.push(<SidebarSection key={key + '.' + subKey} name={item.url} title={section.sectionTitle} />);", `sections.push(\n        ${drawn},\n      );`],
    ];
    await withMenuCopy(async ({ configFile, src }) => {
      const line = lineIn(src, SIDEBAR, '<NavLink');
      assert.deepEqual(menuRows(screen(await build(configFile), '/admin_console/users#Users')).filter((l) => l.tableItem).map((l) => [l.to, l.line]), [
        ['/admin_console/about/license', line], ['/admin_console/users', line], ['/admin_console/users/site', line], ['/admin_console/users/plain', line],
      ], drawn);
    }, { edits });
  }
});

test('an element drawn by a function given in an attribute, as a dropdown overlay or a render prop, is not the menu element', async () => {
  for (const drawn of [
    '<Dropdown key={item.url} overlay={() => <Menu><Link to={item.url}>{item.title}</Link></Menu>}>\n          <NavLink to={item.url}>{item.title}</NavLink>\n        </Dropdown>',
    '<NavLink key={item.url} to={item.url}\n          render={() => <Icon name={item.url} />} />',
  ]) {
    const edits: [string, string, string][] = [
      [SIDEBAR, "import SidebarSection from './SidebarSection';", "import { Link, NavLink } from 'react-router-dom';\nimport { Dropdown, Menu, Icon } from 'antd';"],
      [SIDEBAR, "sections.push(<SidebarSection key={key + '.' + subKey} name={item.url} title={section.sectionTitle} />);", `sections.push(\n        ${drawn},\n      );`],
    ];
    await withMenuCopy(async ({ configFile, src }) => {
      const line = lineIn(src, SIDEBAR, '<NavLink');
      assert.deepEqual(menuRows(screen(await build(configFile), '/admin_console/users#Users')).filter((l) => l.tableItem).map((l) => [l.to, l.line]), [
        ['/admin_console/about/license', line], ['/admin_console/users', line], ['/admin_console/users/site', line], ['/admin_console/users/plain', line],
      ], drawn);
    }, { edits });
  }
});

test('an element drawn by a function given in an attribute is the menu element when nothing else in the loop reads the field, as a list item drawing its link through component', async () => {
  const edits: [string, string, string][] = [
    [SIDEBAR, "import SidebarSection from './SidebarSection';", "import { NavLink } from 'react-router-dom';\nimport { ListItem } from '@mui/material';"],
    [SIDEBAR, "sections.push(<SidebarSection key={key + '.' + subKey} name={item.url} title={section.sectionTitle} />);", 'sections.push(\n        <ListItem key={item.url}\n          component={(props) => <NavLink {...props} to={item.url} />}>{item.title}</ListItem>,\n      );'],
  ];
  await withMenuCopy(async ({ configFile, src }) => {
    const line = lineIn(src, SIDEBAR, '<NavLink');
    assert.notEqual(line, lineIn(src, SIDEBAR, '<ListItem'));
    assert.deepEqual(menuRows(screen(await build(configFile), '/admin_console/users#Users')).filter((l) => l.tableItem).map((l) => [l.to, l.line]), [
      ['/admin_console/about/license', line], ['/admin_console/users', line], ['/admin_console/users/site', line], ['/admin_console/users/plain', line],
    ]);
  }, { edits });
});

test('the links a menu gives for the items do not count as links into a screen when the map decides its entry screens', async () => {
  const entriesOf = (configPatch: Record<string, unknown>) => withMenuCopy(async ({ configFile }) => (await build(configFile)).entries.map((e) => e.screen), { configPatch });
  const plain = await entriesOf({ routeTables: [ROUTE_TABLE] });
  assert.ok(plain.includes('/admin_console/users/site#BrandImage'), JSON.stringify(plain));
  assert.deepEqual(await entriesOf({ routeTables: [MENU_TABLE] }), plain);
});

test('the flow drawn from a map with a menu is the flow drawn without it, so the menu links are neither tree branches nor jumps', async () => {
  const flowOf = (configPatch: Record<string, unknown>) => withMenuCopy(async ({ configFile }) => {
    const map = await build(configFile);
    const walk = (n: FlowScreenNode): unknown => [n.id, n.jumps.map((j) => j.to), n.children.map(walk)];
    const flow = buildFlow(map as never, { nodes: {} });
    return { menuRows: map.screens.reduce((sum, s) => sum + (s.access.menuLinks?.length ?? 0), 0), roots: flow.roots.map(walk), unreached: flow.unreached.map(walk) };
  }, { configPatch });
  const { menuRows: plainRows, ...plain } = await flowOf({ routeTables: [ROUTE_TABLE] });
  const { menuRows, ...withMenu } = await flowOf({ routeTables: [MENU_TABLE] });
  assert.equal(plainRows, 0);
  assert.ok(menuRows > 0);
  assert.deepEqual(withMenu, plain);
});

test('a screen only menu links for its item come into is an entry screen for that reason, and which screens are restricted does not change with the menu', async () => {
  const mapWith = (configPatch: Record<string, unknown>) => withMenuCopy(async ({ configFile }) => build(configFile), { configPatch });
  const plain = await mapWith({ routeTables: [ROUTE_TABLE] });
  const menus = await mapWith({ routeTables: [MENU_TABLE] });
  const reasonsOf = (map: ScreenMap, id: string) => map.entries.find((e) => e.screen === id)?.reasons;
  assert.deepEqual(reasonsOf(plain, '/admin_console/users/site#BrandImage'), [{ kind: 'no-incoming-link' }]);
  assert.deepEqual(reasonsOf(menus, '/admin_console/users/site#BrandImage'), [{ kind: 'menu-links-only' }]);
  assert.deepEqual(reasonsOf(menus, '/admin_console#AdminConsole'), reasonsOf(plain, '/admin_console#AdminConsole'));
  const access = (map: ScreenMap) => map.screens.map((s) => [s.id, s.access.restricted, s.access.kinds]);
  assert.deepEqual(access(menus), access(plain));
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
    [TABLE, 'const AdminDefinition = {', 'function names(lists) {\n  for (const AdminDefinition of lists) console.log(AdminDefinition);\n}\n\nexport function useAdminDefinition() {\n  const AdminDefinition = {'],
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
  const reduced: [string, string, string][] = [[SIDEBAR, `    Object.entries(section.subsections).forEach(([subKey, item]) => {
      sections.push(<SidebarSection key={key + '.' + subKey} name={item.url} title={section.sectionTitle} />);
    });`, '    sections.push(...Object.values(section.subsections).reduce((url, item) => [<SidebarSection key={item.title} name={url.url} />], []));']];
  await withMenuCopy(({ configFile }) => {
    assert.match(failure(configFile), /routeTables\[0\]\.menus\[0\]: admin\/AdminSidebar\.js has no element made for each item of a list that reads the item's url/);
  }, { edits: reduced });
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
    assert.throws(load('components/SideMenu.js'), /^Error: routeTables must be a list of \{ "route", "table": \{ "file", "const" \}, "items" \} with an optional "menus"/);
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

const TAB_ROUTE_TAB = `export default function RouteTab({ routes }) {
  return <nav>{routes.map((route) => <span key={route.route}>{route.name}</span>)}</nav>;
}
`;
const TAB_ENTRY = { import: './admin/RouteTab', name: 'default', items: 'routes', path: 'route', component: 'Component' };

const tabPage = (name: string, list: string) => `import RouteTab from './RouteTab';
import { ${list} } from './${list}';

export default function ${name}() {
  return <section><RouteTab routes={${list}} /></section>;
}
`;
const tabList = (name: string, tabs: [string, string][]) => `${tabs.map(([, component]) => `import ${component} from './${component}';`).join('\n')}

export const ${name} = [
${tabs.map(([route, component]) => `  { Component: ${component}, route: '${route}' },`).join('\n')}
];
`;

// 화면을 그리는 파일들. 라우트는 fixture 의 Route 에 적은 그대로 Routes.js 에 들어간다.
async function withTabCopy<T>(fn: (copy: Copy) => T | Promise<T>, { files = {}, routes = [] as [string, string][], routeTabs = [TAB_ENTRY] as unknown[], edits = [] as [string, string, string][] }: { files?: Record<string, string>; routes?: [string, string][]; routeTabs?: unknown[]; edits?: [string, string, string][] } = {}): Promise<T> {
  const src = { 'admin/RouteTab.js': TAB_ROUTE_TAB, ...files };
  const imports = routes.map(([name]) => `import ${name} from './admin/${name}';\n`).join('');
  const elements = routes.map(([name, path]) => `      <Route path="${path}" component={${name}} />`).join('\n');
  return withTableCopy(async (copy) => {
    for (const [file, text] of Object.entries(src)) fs.writeFileSync(path.join(copy.src, file), text);
    return fn(copy);
  }, {
    configPatch: { routeTabs },
    edits: [
      ['Routes.js', "import Layout from './components/Layout';\n", `import Layout from './components/Layout';\n${imports}`],
      ['Routes.js', LAST_ROUTE, `${elements}\n${LAST_ROUTE}`],
      ...edits,
    ],
  });
}

const tabScreens = (map: ScreenMap, ids: string[]) => map.screens.filter((s) => ids.includes(s.id));

test('a tab component drawn by two screens gives screens for the tabs of both lists, each with the screen that draws it as frame', async () => {
  const files = {
    'admin/settingsTabs.js': tabList('settingsTabs', [['/settings/billing', 'Billing'], ['/settings/members', 'Members']]),
    'admin/profileTabs.js': tabList('profileTabs', [['/profile/roles', 'Roles'], ['/profile/avatar', 'Avatar']]),
    'admin/Billing.js': page('Billing'),
    'admin/Members.js': page('Members'),
    'admin/Roles.js': page('Roles'),
    'admin/Avatar.js': page('Avatar'),
    'admin/Settings.js': tabPage('Settings', 'settingsTabs'),
    'admin/Profile.js': tabPage('Profile', 'profileTabs'),
  };
  const routes: [string, string][] = [['Settings', '/settings'], ['Profile', '/profile']];
  await withTabCopy(async ({ configFile, cli }) => {
    const map = await build(configFile);
    const ids = ['/settings/billing#Billing', '/settings/members#Members', '/profile/roles#Roles', '/profile/avatar#Avatar'];
    for (const id of ids) assert.equal(tabScreens(map, [id]).length, 1, id);
    assert.ok(screen(map, '/settings/members#Members').sourceFiles.includes('admin/Settings.js'));
    assert.ok(screen(map, '/profile/roles#Roles').sourceFiles.includes('admin/Profile.js'));
    assert.ok(!screen(map, '/profile/roles#Roles').sourceFiles.includes('admin/Settings.js'));
    assert.deepEqual(map.duplicateIds, []);
    assert.deepEqual(cli('extract').split('\n').filter((line) => line.includes('routeTabs')), []);
  }, { files, routes });
});

test('a tab whose address a route already gives makes no screen and no line, and the route screen stays as it was', async () => {
  const files = {
    'admin/settingsTabs.js': tabList('settingsTabs', [['/settings/billing', 'Billing'], ['/settings/members', 'Members']]),
    'admin/Billing.js': page('Billing'),
    'admin/Members.js': page('Members'),
    'admin/Settings.js': tabPage('Settings', 'settingsTabs'),
  };
  const routes: [string, string][] = [['Settings', '/settings'], ['Members', '/settings/members']];
  const id = '/settings/members#Members';
  const plain = await withTabCopy(async ({ configFile }) => tabScreens(await build(configFile), [id]), { files, routes, routeTabs: [] });
  await withTabCopy(async ({ configFile, cli }) => {
    const map = await build(configFile);
    const found = tabScreens(map, [id]);
    assert.equal(found.length, 1);
    assert.deepEqual(found, plain);
    assert.equal(found[0].routeFile, 'Routes.js');
    assert.equal(found[0].componentFile, 'admin/Members.js');
    assert.equal(screen(map, '/settings/billing#Billing').routeFile, 'admin/settingsTabs.js');
    assert.deepEqual(map.duplicateIds, []);
    assert.deepEqual(routeLines(cli('extract')), []);
    assert.deepEqual(cli('extract').split('\n').filter((line) => line.includes('routeTabs')), []);
  }, { files, routes });
});

test('one tab list drawn by two screens gives each tab screen once, with the first drawing screen as frame', async () => {
  const files = {
    'admin/sharedTabs.js': tabList('sharedTabs', [['/settings/billing', 'Billing'], ['/settings/members', 'Members']]),
    'admin/Billing.js': page('Billing'),
    'admin/Members.js': page('Members'),
    'admin/Settings.js': tabPage('Settings', 'sharedTabs'),
    'admin/Profile.js': tabPage('Profile', 'sharedTabs'),
  };
  const routes: [string, string][] = [['Settings', '/settings'], ['Profile', '/profile']];
  await withTabCopy(async ({ configFile, cli }) => {
    const map = await build(configFile);
    for (const id of ['/settings/billing#Billing', '/settings/members#Members']) {
      const found = tabScreens(map, [id]);
      assert.equal(found.length, 1, id);
      assert.ok(found[0].sourceFiles.includes('admin/Settings.js'), id);
      assert.ok(!found[0].sourceFiles.includes('admin/Profile.js'), id);
    }
    assert.deepEqual(map.duplicateIds, []);
    assert.deepEqual(cli('extract').split('\n').filter((line) => line.includes('routeTabs')), []);
  }, { files, routes });
});

test('a tab address is taken without what follows ? or #, so a query on a routed address makes no screen of its own', async () => {
  const files = {
    'admin/settingsTabs.js': tabList('settingsTabs', [['/settings/billing?plan=pro', 'Billing'], ['/settings/members?tab=all', 'Members']]),
    'admin/Billing.js': page('Billing'),
    'admin/Members.js': page('Members'),
    'admin/Settings.js': tabPage('Settings', 'settingsTabs'),
  };
  const routes: [string, string][] = [['Settings', '/settings'], ['Members', '/settings/members']];
  await withTabCopy(async ({ configFile }) => {
    const map = await build(configFile);
    const tabs = map.screens.filter((s) => s.path.startsWith('/settings/')).map((s) => [s.id, s.routeFile]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(tabs, [['/settings/billing#Billing', 'admin/settingsTabs.js'], ['/settings/members#Members', 'Routes.js']]);
    assert.deepEqual(map.duplicateIds, []);
  }, { files, routes });
});

test('an item address that does not start with / gets the drawing screen\'s path in front, and the tab screen takes it as it is', async () => {
  const files = {
    'admin/settingsTabs.js': tabList('settingsTabs', [['members', 'Members']]),
    'admin/Members.js': page('Members'),
    'admin/Settings.js': tabPage('Settings', 'settingsTabs'),
  };
  await withTabCopy(async ({ configFile, cli }) => {
    const map = await build(configFile);
    const found = screen(map, '/settings/members#Members');
    assert.equal(found.routeFile, 'admin/settingsTabs.js');
    assert.equal(found.componentFile, 'admin/Members.js');
    assert.ok(found.sourceFiles.includes('admin/Settings.js'));
    assert.equal(map.routeTabNotices, undefined);
    assert.deepEqual(cli('extract').split('\n').filter((line) => line.includes('routeTabs')), []);
  }, { files, routes: [['Settings', '/settings']] });
});

test('an item\'s address and component are read from the dotted key paths the entry names', async () => {
  const files = {
    'admin/settingsTabs.js': `import RouteTab from './RouteTab';
import Billing from './Billing';

export const settingsTabs = [
  { meta: { path: '/settings/billing', component: Billing } },
];
`,
    'admin/Billing.js': page('Billing'),
    'admin/Settings.js': tabPage('Settings', 'settingsTabs'),
  };
  const routeTabs = [{ ...TAB_ENTRY, path: 'meta.path', component: 'meta.component' }];
  await withTabCopy(async ({ configFile, cli }) => {
    const map = await build(configFile);
    const found = screen(map, '/settings/billing#Billing');
    assert.equal(found.componentFile, 'admin/Billing.js');
    assert.equal(map.routeTabNotices, undefined);
    assert.deepEqual(cli('extract').split('\n').filter((line) => line.includes('routeTabs')), []);
  }, { files, routes: [['Settings', '/settings']], routeTabs });
});

test('a routeTabs entry whose import names no file under srcRoot, or whose name its file does not export, stops the run', async () => {
  const files = {
    'admin/settingsTabs.js': tabList('settingsTabs', [['/settings/billing', 'Billing']]),
    'admin/Billing.js': page('Billing'),
    'admin/Settings.js': tabPage('Settings', 'settingsTabs'),
  };
  const routes: [string, string][] = [['Settings', '/settings']];
  await withTabCopy(async ({ configFile }) => {
    assert.match(failure(configFile), /routeTabs\[0\]\.import \.\/admin\/Nope names no file under srcRoot/);
  }, { files, routes, routeTabs: [{ ...TAB_ENTRY, import: './admin/Nope' }] });
  await withTabCopy(async ({ configFile }) => {
    assert.match(failure(configFile), /routeTabs\[0\]\.name Nope is not exported by admin\/RouteTab\.js/);
  }, { files, routes, routeTabs: [{ ...TAB_ENTRY, name: 'Nope' }] });
});

test('a routeTabs entry naming a component no screen draws with that prop prints one line and gives no tab screen', async () => {
  const files = { 'admin/Settings.js': page('Settings') };
  await withTabCopy(async ({ configFile, cli }) => {
    const map = await build(configFile);
    assert.deepEqual(map.routeTabNotices, [{ file: null, line: null, reason: './admin/RouteTab default is drawn by no screen' }]);
    assert.deepEqual(cli('extract').split('\n').filter((line) => line.includes('routeTabs')), ['  routeTabs ./admin/RouteTab default is drawn by no screen']);
    assert.deepEqual(map.screens.filter((s) => s.id.startsWith('/settings')).map((s) => s.id), ['/settings#Settings']);
  }, { files, routes: [['Settings', '/settings']] });
});

test('a prop the drawing screen does not hand as a list prints the part duru could not follow and gives no tab screen', async () => {
  const files = {
    'admin/Settings.js': `import RouteTab from './RouteTab';

export default function Settings({ x }) {
  return <section><RouteTab routes={x.tabs} /></section>;
}
`,
  };
  await withTabCopy(async ({ configFile, cli }) => {
    const map = await build(configFile);
    assert.deepEqual(map.screens.filter((s) => s.id.startsWith('/settings')).map((s) => s.id), ['/settings#Settings']);
    assert.deepEqual(cli('extract').split('\n').filter((line) => line.includes('routeTabs')), ['  routeTabs admin/Settings.js:4 its routes stopped at x.tabs']);
    assert.deepEqual(map.routeTabNotices, [{ file: 'admin/Settings.js', line: 4, reason: 'its routes stopped at x.tabs' }]);
  }, { files, routes: [['Settings', '/settings']] });
});

test('an item without the fields the entry names, and a field whose value stops, each print one line, once for a list two screens hand', async () => {
  const files = {
    'admin/sharedTabs.js': `import RouteTab from './RouteTab';
import Billing from './Billing';

export const sharedTabs = [
  { Component: Billing },
  { route: '/settings/billing' },
  { route: window.foo, Component: Billing },
];
`,
    'admin/Billing.js': page('Billing'),
    'admin/Settings.js': tabPage('Settings', 'sharedTabs'),
    'admin/Profile.js': tabPage('Profile', 'sharedTabs'),
  };
  await withTabCopy(async ({ configFile, cli }) => {
    const map = await build(configFile);
    const printed = cli('extract').split('\n').filter((line) => line.includes('routeTabs'));
    assert.deepEqual(printed, [
      '  routeTabs admin/sharedTabs.js:5 the item at admin/sharedTabs.js:5 has no route',
      '  routeTabs admin/sharedTabs.js:6 the item at admin/sharedTabs.js:6 has no Component',
      '  routeTabs admin/sharedTabs.js:7 the item at admin/sharedTabs.js:7: its route stopped at window.foo',
    ]);
    assert.equal(map.routeTabNotices?.length, 3);
    assert.deepEqual(map.screens.filter((s) => s.path.startsWith('/settings/billing')), []);
  }, { files, routes: [['Settings', '/settings'], ['Profile', '/profile']] });
});

const TAB_SETTINGS_DRAWING = `import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import RouteTab from './RouteTab';
import { settingsTabs } from './settingsTabs';
import { ajaxMemberList } from '../_ajax/AjaxFunc';

export default function Settings() {
  useEffect(() => {
    ajaxMemberList({ page: 1 });
  }, []);
  return <section><Link to="/home">home</Link><RouteTab routes={settingsTabs} /></section>;
}
`;

test('a tab screen holds the code of its own component and of the screen that draws it, and the links and requests that screen writes', async () => {
  const files = {
    'admin/settingsTabs.js': tabList('settingsTabs', [['/settings/billing', 'Billing'], ['/settings/members', 'Members']]),
    'admin/Billing.js': page('Billing'),
    'admin/Members.js': page('Members'),
    'admin/Settings.js': TAB_SETTINGS_DRAWING,
  };
  await withTabCopy(async ({ configFile }) => {
    const map = await build(configFile);
    const billing = screen(map, '/settings/billing#Billing');
    const members = screen(map, '/settings/members#Members');
    for (const found of [billing, members]) {
      assert.deepEqual(found.links.filter((l) => l.file === 'admin/Settings.js').map((l) => l.to), ['/home'], found.id);
      assert.deepEqual(found.apiCalls.filter((c) => c.file === 'admin/Settings.js').map((c) => c.fn), ['ajaxMemberList'], found.id);
    }
    // 탭의 소스는 그 탭의 컴포넌트와 그것을 그리는 화면, 그리고 그 화면이 그리는 파일들이다. 다른 탭의 컴포넌트는 아니다.
    assert.deepEqual(billing.sourceFiles, ['admin/Billing.js', 'admin/RouteTab.js', 'admin/Settings.js', 'admin/settingsTabs.js']);
    assert.deepEqual(members.sourceFiles, ['admin/Members.js', 'admin/RouteTab.js', 'admin/Settings.js', 'admin/settingsTabs.js']);
    assert.notEqual(billing.codeHash, members.codeHash);
    assert.deepEqual(map.duplicateIds, []);
  }, { files, routes: [['Settings', '/settings']] });
});

test('a condition written around the tab component reaches the links and requests the drawing screen gives its tabs', async () => {
  const drawing = `import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import RouteTab from './RouteTab';
import { settingsTabs } from './settingsTabs';
import { ajaxMemberList } from '../_ajax/AjaxFunc';

export default function Settings({ isAdmin }) {
  useEffect(() => {
    ajaxMemberList({ page: 1 });
  }, []);
  return (
    <section>
      <Link to="/home">home</Link>
      {isAdmin && (
        <RouteTab routes={settingsTabs} />
      )}
    </section>
  );
}
`;
  const files = {
    'admin/settingsTabs.js': tabList('settingsTabs', [['/settings/billing', 'Billing'], ['/settings/members', 'Members']]),
    'admin/Billing.js': page('Billing'),
    'admin/Members.js': page('Members'),
    'admin/Settings.js': drawing,
  };
  const line = drawing.split('\n').findIndex((l) => l.includes('<RouteTab ')) + 1;
  await withTabCopy(async ({ configFile }) => {
    const map = await build(configFile);
    const under = { via: 'RouteTab', line, guards: ['isAdmin'], file: 'Routes.js' };
    for (const id of ['/settings/billing#Billing', '/settings/members#Members']) {
      const found = screen(map, id);
      const [link] = found.links.filter((l) => l.file === 'admin/Settings.js');
      assert.deepEqual(link.inheritedGuards, [under], id);
      assert.deepEqual(found.apiCalls.filter((c) => c.file === 'admin/Settings.js').map((c) => c.inheritedGuards), [[under]], id);
      assert.ok(found.sourceFiles.includes('admin/Settings.js'), id);
    }
  }, { files, routes: [['Settings', '/settings']] });
});

test('a tab screen takes the files drawn around the screen that draws its tabs, and the links they write', async () => {
  const files = {
    'admin/settingsTabs.js': tabList('settingsTabs', [['/settings/billing', 'Billing'], ['/settings/members', 'Members']]),
    'admin/Billing.js': page('Billing'),
    'admin/Members.js': page('Members'),
    'admin/Settings.js': TAB_SETTINGS_DRAWING,
    'components/Shell.js': `import { Link } from 'react-router-dom';

export default function Shell({ children }) {
  return <div><Link to="/help">help</Link>{children}</div>;
}
`,
  };
  const edits: [string, string, string][] = [
    ['Routes.js', "import Layout from './components/Layout';\n", "import Layout from './components/Layout';\nimport Shell from './components/Shell';\n"],
    ['Routes.js', '<Route path="/settings" component={Settings} />', '<Route path="/settings"><Shell><Settings /></Shell></Route>'],
  ];
  await withTabCopy(async ({ configFile }) => {
    const map = await build(configFile);
    for (const id of ['/settings/billing#Billing', '/settings/members#Members']) {
      const found = screen(map, id);
      assert.deepEqual(found.links.filter((l) => l.file === 'components/Shell.js').map((l) => l.to), ['/help'], id);
      assert.ok(found.sourceFiles.includes('components/Shell.js'), id);
      assert.ok(found.sourceFiles.includes('admin/Settings.js'), id);
    }
  }, { files, routes: [['Settings', '/settings']], edits });
});
