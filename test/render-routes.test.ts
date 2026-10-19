import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';

for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const TS_FIXTURE = path.join(import.meta.dirname, 'fixtures/ts-app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const LAST_ROUTE = '      <Redirect to={Option.ROUTE_PATH.SIGN_IN} />';

type Copy = { copy: string; configFile: string; routes: string; setConfig: (change: Record<string, unknown>) => void };

async function withCopy<T>(edits: [string, string][], fn: (copy: Copy) => T | Promise<T>, fixture = FIXTURE): Promise<T> {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(fixture, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(fixture, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const routes = path.join(copy, 'client/src/Routes.js');
    for (const [from, to] of edits) {
      const src = fs.readFileSync(routes, 'utf8');
      assert.ok(src.includes(from), `Routes.js has no ${from}`);
      fs.writeFileSync(routes, src.split(from).join(to));
    }
    const setConfig = (change: Record<string, unknown>) => fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ...change }));
    return await fn({ copy, configFile, routes, setConfig });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const withoutMeta = (map: ScreenMap) => ({ ...map, meta: null });
const ids = (map: ScreenMap) => map.screens.map((s) => s.id);
const withRoutes = (lines: string[]): [string, string] => [LAST_ROUTE, [...lines.map((l) => `      ${l}`), LAST_ROUTE].join('\n')];

const lineOf = (file: string, text: string) => {
  const at = fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes(text));
  assert.ok(at >= 0, `${file} has ${text}`);
  return at + 1;
};

function printed(command: 'extract' | 'rebuild', configFile: string) {
  const result = spawnSync(process.execPath, [CLI, command, configFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => line.includes('route not read') || line.includes('route path not read'));
}

const original = withCopy([], ({ configFile }) => build(configFile));

test('a route whose render function returns one component is read as the same route written with component, with its path, component file and conditions', async () => {
  const asRender: [string, string][] = [
    ['const isAdminRole = (role) => role === Enum.ROLE.ADMIN;', 'const isAdminRole = (role) => role === Enum.ROLE.ADMIN; const withBoundary = (page) => page;'],
    ['component={SignIn}', 'render={() => <SignIn />}'],
    ['component={Help}', 'render={(props) => <Help {...props} />}'],
    ['component={AdminMember}', 'render={(props) => (<AdminMember {...props} />)}'],
    ['component={AdminAudit}', 'render={() => { return <AdminAudit />; }}'],
    ['component={AdminReport}', 'render={function () { return withBoundary(<AdminReport />); }}'],
  ];
  await withCopy(asRender, async ({ configFile }) => {
    const map = await build(configFile);
    assert.deepEqual(withoutMeta(map), withoutMeta(await original));
    assert.deepEqual(map.screens.find((s) => s.component === 'AdminMember')!.routeGuards, ['isAdminRole(memberRole)']);
    assert.deepEqual(printed('extract', configFile), []);
  });
});

test('a route whose screen is written as its child element is read as the same route written with element', async () => {
  const asChildren: [string, string][] = [
    ['<Route path={Option.ROUTE_PATH.HELP} component={Help} exact />', '<Route path={Option.ROUTE_PATH.HELP} exact><Help /></Route>'],
    ['<Route path={Option.ROUTE_PATH.ADMIN_GROUP} component={AdminGroup} exact />', '<Route path={Option.ROUTE_PATH.ADMIN_GROUP} exact>{/* group */} <AdminGroup /></Route>'],
  ];
  await withCopy(asChildren, async ({ configFile }) => {
    const map = await build(configFile);
    assert.deepEqual(withoutMeta(map), withoutMeta(await original));
    assert.deepEqual(map.screens.find((s) => s.component === 'AdminGroup')!.routeGuards, ['isAdmin']);
  });
});

test('a render function returning a redirect is a redirect, not a screen and not a route not read', async () => {
  for (const route of ['<Route render={() => <Redirect to={Option.ROUTE_PATH.SIGN_IN} />} />', '<Route path="/old" render={() => <Redirect to={Option.ROUTE_PATH.SIGN_IN} />} />', '<Route path="/old"><Redirect to={Option.ROUTE_PATH.SIGN_IN} /></Route>']) {
    await withCopy([[LAST_ROUTE, `      ${route}`]], async ({ configFile }) => {
      assert.deepEqual(withoutMeta(await build(configFile)), withoutMeta(await original));
    });
  }
});

test('a render function whose element holds routes is a wrapper of those routes, not a screen, even when it holds them on one side of a branch', async () => {
  const wrapper: [string, string][] = [['      <Route>\n', '      <Route path="/" render={() => (\n'], ['      </Route>\n', '      )} />\n']];
  await withCopy(wrapper, async ({ configFile }) => {
    const map = await build(configFile);
    assert.deepEqual(withoutMeta(map), withoutMeta(await original));
    assert.ok(map.screens.find((s) => s.component === 'Home')!.sourceFiles.includes('components/Layout.js'));
    assert.deepEqual(printed('extract', configFile), []);
  });
  const branching: [string, string][] = [['      <Route>\n', '      <Route path="/" render={() => (session ? (\n'], ['      </Route>\n', '      ) : <Redirect to={Option.ROUTE_PATH.SIGN_IN} />)} />\n']];
  await withCopy(branching, async ({ configFile }) => {
    const map = await build(configFile);
    assert.deepEqual(ids(map), ids(await original));
    assert.deepEqual(map.screens.find((s) => s.component === 'Home')!.routeGuards, ['session']);
    assert.equal(map.unreadRoutes, undefined);
    assert.deepEqual(printed('extract', configFile), []);
  });
});

const UNREAD = [
  ['<Route path="/a" render={() => (memberRole ? <Help /> : <SignIn />)} />', 'render does not return one component'],
  ['<Route path="/b" render={() => memberRole && <Help />} />', 'render does not return one component'],
  ['<Route path="/c" render={() => <><Help /></>} />', 'render does not return one component'],
  ['<Route path="/d" render={() => <div>none</div>} />', 'render does not return one component'],
  ['<Route path="/e" render={() => null} />', 'render does not return one component'],
  ['<Route path="/f" render={() => { track(); return <Help />; }} />', 'render does not return one component'],
  ['<Route path="/g" render={renderHelp} />', 'render is not a function written in the route'],
  ['<Route path="/h"><div>none</div></Route>', "the route's children hold no component"],
];

test('a route whose render function does not return one component makes no screen, and extract and rebuild print route not read with the route file, line and reason', async () => {
  await withCopy([withRoutes(UNREAD.map(([route]) => route))], async ({ copy, configFile, routes, setConfig }) => {
    fs.writeFileSync(path.join(copy, 'client/src/More.js'), "import { Route } from 'react-router-dom';\n\nexport default () => <Route path=\"/more\" render={() => null} />;\n");
    setConfig({ routesFile: ['Routes.js', 'More.js'] });
    const map = await build(configFile);
    assert.deepEqual(ids(map), ids(await original));
    const lines = [...UNREAD.map(([route, reason]) => `  route not read ← Routes.js:${lineOf(routes, route)}: ${reason}`), '  route not read ← More.js:3: render does not return one component'];
    assert.deepEqual(printed('extract', configFile), lines);
    assert.deepEqual(printed('rebuild', configFile), lines);
  });
});

test('a route whose path or screen may sit in a spread prints route not read quoting the spread, and map.json carries the lines', async () => {
  const spreads = ['{routes.map((route) => <Route {...route} key={route.key} />)}', '<Route path="/x" {...rest} />'];
  await withCopy([withRoutes(spreads)], async ({ copy, configFile, routes }) => {
    assert.deepEqual(printed('extract', configFile), [
      `  route not read ← Routes.js:${lineOf(routes, spreads[0])}: the path may be in {...route}`,
      `  route not read ← Routes.js:${lineOf(routes, spreads[1])}: the screen may be in {...rest}`,
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(copy, 'out/map.json'), 'utf8')).unreadRoutes, [
      { file: 'Routes.js', line: lineOf(routes, spreads[0]), reason: 'the path may be in {...route}' },
      { file: 'Routes.js', line: lineOf(routes, spreads[1]), reason: 'the screen may be in {...rest}' },
    ]);
  });
});

test('a route written inside a route element listed in routeElements, such as a PrivateRoute passing its props on, prints no route not read line', async () => {
  const definitions: [string, string] = ['export default function Routes', [
    'const PrivateRoute = ({ component: Component, ...rest }) => (',
    '  <Route {...rest} render={(props) => (session ? <Component {...props} /> : <Redirect to={Option.ROUTE_PATH.SIGN_IN} />)} />',
    ');',
    'function GuardRoute({ children, ...rest }) {',
    '  return <Route {...rest} render={() => children} />;',
    '}',
    'export default function Routes',
  ].join('\n')];
  const used: [string, string] = ['<Route path={Option.ROUTE_PATH.HELP} component={Help} exact />', '<PrivateRoute path={Option.ROUTE_PATH.HELP} component={Help} exact />'];
  await withCopy([definitions, used], async ({ configFile, routes, setConfig }) => {
    setConfig({ routeElements: ['Route', 'PrivateRoute', 'GuardRoute'] });
    assert.deepEqual(ids(await build(configFile)), ids(await original));
    assert.deepEqual(printed('extract', configFile), []);
    setConfig({ routeElements: ['Route', 'PrivateRoute'] });
    assert.deepEqual(printed('extract', configFile), [`  route not read ← Routes.js:${lineOf(routes, '<Route {...rest} render={() => children} />')}: the path may be in {...rest}`]);
  });
});

test('a render or child-element route written inside a route element listed in routeElements gives no screen and no line, so the map is the one without that definition', async () => {
  const definitions: [string, string] = ['function canManageGroups(role) {', [
    'const AppRoute = ({ path, component: C }) => <Route path={path} render={(props) => <C {...props} />} />;',
    'function ShellRoute({ path, page: Page }) {',
    '  return <Route path={path}><Page /></Route>;',
    '}',
    'function canManageGroups(role) {',
  ].join('\n')];
  await withCopy([definitions], async ({ configFile, setConfig }) => {
    setConfig({ routeElements: ['Route', 'AppRoute', 'ShellRoute'] });
    assert.deepEqual(withoutMeta(await build(configFile)), withoutMeta(await original));
    assert.deepEqual(printed('extract', configFile), []);
  });
});

test('a render or child-element route made for each item of a list with a path that is not read is not a screen and prints route not read', async () => {
  const listed = [
    '{Object.values(items).map((item) => <Route key={item.url} path={`/admin/${item.url}`} render={(props) => <AdminReport {...props} />} />)}',
    '{items?.map((item) => <Route key={item.url} path={item.url}><AdminAudit /></Route>)}',
    '{items.map((item) => <Route key={item.url} path={`/old/${item.url}`} component={AdminAudit} />)}',
  ];
  await withCopy([withRoutes(listed)], async ({ configFile, routes }) => {
    assert.deepEqual(ids(await build(configFile)), [...ids(await original), '/old/{?}#AdminAudit']);
    assert.deepEqual(printed('extract', configFile), [
      `  route path not read ← Routes.js:${lineOf(routes, listed[2])}: stopped at item.url, only /old/{?}`,
      `  route not read ← Routes.js:${lineOf(routes, listed[0])}: made for each item of a list, and its path stopped at item.url`,
      `  route not read ← Routes.js:${lineOf(routes, listed[1])}: made for each item of a list, and its path stopped at item.url`,
    ]);
  });
});

test('a child-element route whose screen is declared in the routes file gives the same screen as the route written with component, and one whose screen is imported or required from a package gives no screen and no line', async () => {
  const declared: [string, string][] = [
    ["import Layout from './components/Layout';", "import Layout from './components/Layout'; import ExtPage from 'ext-pages'; const { ReqPage } = require('ext-pages');"],
    ['const isAdminRole = (role) => role === Enum.ROLE.ADMIN;', 'const isAdminRole = (role) => role === Enum.ROLE.ADMIN; const About = () => <div />;'],
  ];
  const asComponent = await withCopy([...declared, withRoutes(['<Route path="/about" component={About} />'])], async ({ configFile }) => build(configFile));
  await withCopy([...declared, withRoutes(['<Route path="/about"><About /></Route> <Route path="/ext"><ExtPage /></Route> <Route path="/ext2" render={() => <ExtPage />} /> <Route path="/req"><ReqPage /></Route>'])], async ({ configFile }) => {
    const map = await build(configFile);
    assert.deepEqual(withoutMeta(map), withoutMeta(asComponent));
    assert.ok(map.screens.some((s) => s.path === '/about'));
    assert.ok(!map.screens.some((s) => ['/ext', '/ext2', '/req'].includes(s.path)));
    assert.deepEqual(printed('extract', configFile), []);
  });
});

test('a route that draws a screen but has no path prints route not read', async () => {
  const pathless = ['<Route component={Help} />', '<Route render={() => <Help />} />', '<Route><SignIn /></Route>', '<Route index element={<Help />} />', '<Route><NotFound /></Route>'];
  const notFound: [string, string] = ['const isAdminRole = (role) => role === Enum.ROLE.ADMIN;', 'const isAdminRole = (role) => role === Enum.ROLE.ADMIN; const NotFound = () => <div />;'];
  await withCopy([notFound, withRoutes(pathless)], async ({ configFile, routes }) => {
    assert.deepEqual(ids(await build(configFile)), ids(await original));
    assert.deepEqual(printed('extract', configFile), pathless.map((route) => `  route not read ← Routes.js:${lineOf(routes, route)}: no path`));
  });
});

test('a pathless route whose screen is not read prints why it is not read instead of no path', async () => {
  const pathless = ['<Route render={renderNothing} />', '<Route render={() => (session ? <Help /> : <SignIn />)} />'];
  await withCopy([withRoutes(pathless)], async ({ configFile, routes }) => {
    assert.deepEqual(ids(await build(configFile)), ids(await original));
    assert.deepEqual(printed('extract', configFile), [
      `  route not read ← Routes.js:${lineOf(routes, pathless[0])}: render is not a function written in the route`,
      `  route not read ← Routes.js:${lineOf(routes, pathless[1])}: render does not return one component`,
    ]);
  });
});

test('a route whose children or render function hold a value, bare or inside package elements such as Switch, Suspense or ErrorBoundary, gives no screen and no line', async () => {
  const imports: [string, string][] = [
    ["import { lazy } from 'react';", "import { lazy, Suspense } from 'react'; import { ErrorBoundary } from 'react-error-boundary';"],
  ];
  const valued = [
    '<Route>{routes}</Route>',
    '<Route path="/admin">{adminRoutes}</Route>',
    '<Route>{session}</Route>',
    '<Route path="/admin"><Switch>{adminRoutes}</Switch></Route>',
    '<Route><Switch>{routes}</Switch></Route>',
    '<Route path="/admin2" render={() => <Switch>{adminRoutes}</Switch>} />',
    '<Route path="/app"><ErrorBoundary><Switch>{routes}</Switch></ErrorBoundary></Route>',
    '<Route path="/lazy" render={() => <Suspense fallback={null}><Switch>{routes}</Switch></Suspense>} />',
  ];
  await withCopy([...imports, [LAST_ROUTE, `      ${[...valued, LAST_ROUTE.trim()].join(' ')}`]], async ({ configFile }) => {
    assert.deepEqual(withoutMeta(await build(configFile)), withoutMeta(await original));
    assert.deepEqual(printed('extract', configFile), []);
  });
});

test('a route whose children or render function draw an app component holding a value, such as a Layout around a Switch of routes held in a list, gives no screen and no line', async () => {
  const declared: [string, string][] = [
    ["import { lazy } from 'react';", "import { lazy } from 'react'; import { ErrorBoundary } from 'react-error-boundary';"],
    ['const isAdminRole = (role) => role === Enum.ROLE.ADMIN;', 'const isAdminRole = (role) => role === Enum.ROLE.ADMIN; const About = () => <div />;'],
  ];
  const valued = [
    '<Route path="/admin"><Layout><Switch>{adminRoutes}</Switch></Layout></Route>',
    '<Route path="/admin2" render={() => <Layout>{renderRoutes(adminRoutes)}</Layout>} />',
    '<Route path="/admin3"><ErrorBoundary FallbackComponent={Layout}><Switch>{adminRoutes}</Switch></ErrorBoundary></Route>',
  ];
  const asComponent = await withCopy([...declared, withRoutes(['<Route path="/about" component={About} />'])], async ({ configFile }) => build(configFile));
  await withCopy([...declared, withRoutes([[...valued, '<Route path="/about"><About /></Route>'].join(' ')])], async ({ configFile }) => {
    const map = await build(configFile);
    assert.deepEqual(withoutMeta(map), withoutMeta(asComponent));
    assert.ok(map.screens.some((s) => s.path === '/about'));
    assert.deepEqual(printed('extract', configFile), []);
  });
});

test('a pathless route wrapping other routes and an element that only redirects print no route not read line', async () => {
  for (const fixture of [FIXTURE, TS_FIXTURE]) {
    await withCopy([], async ({ copy, configFile }) => {
      assert.deepEqual(printed('extract', configFile).filter((line) => line.includes('route not read')), []);
      assert.equal('unreadRoutes' in JSON.parse(fs.readFileSync(path.join(copy, 'out/map.json'), 'utf8')), false);
    }, fixture);
  }
});

test('the usage guide names the route not read line, the agent skill names render routes and that line, and the decision record names the choice', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
  const skill = read('../skills/duru/SKILL.md');
  assert.match(skill, /`render=\{\(\) => <Home \/>\}`/);
  assert.match(skill, /`<Route path=…><Home \/><\/Route>`/);
  const readme = read('../README.md');
  for (const doc of [readme, skill]) assert.ok(doc.includes('`route not read ← <route file>:<line>: <reason>`'));
  assert.match(read('../docs/decisions.md'), /#339/);
});
