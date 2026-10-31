import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';

const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const PAGES = ['Home', 'Team', 'Help', 'Login', 'Admin', 'Usage', 'Profile'];
const page = (name: string) => `export default function ${name}() {\n  return <main>${name}</main>;\n}\n`;
const linking = (name: string, to: string, request = `/api/${name.toLowerCase()}`) => `import { useEffect } from 'react';
import { Link } from 'react-router-dom';

export default function ${name}() {
  useEffect(() => {
    fetch('${request}');
  }, []);
  return <nav><Link to="${to}">${name}</Link></nav>;
}
`;
const FRAME_PARTS: Record<string, string> = {
  'Menu.js': linking('Menu', '/help'),
  'Other.js': linking('Other', '/login'),
  'Banner.js': linking('Banner', '/admin'),
  'Shell.js': `export default function Shell({ children }) {\n  return <div>{children}</div>;\n}\n`,
};

const routesFile = (body: string, imports = '') => `import { Suspense } from 'react';
import { Route, Switch } from 'react-router-dom';
${['Home', 'Team', 'Help', 'Login', 'Admin', 'Menu', 'Other', 'Banner', 'Shell'].map((n) => `import ${n} from './${n}';`).join('\n')}
${imports}
export default function Routes({ crashed, globalSettings }) {
  return (
${body}
  );
}
`;
const GROUP = `<Switch>
            <Route path="/home" component={Home} exact />
            <Route path="/team/:team" component={Team} />
          </Switch>`;
const outer = (inside: string) => `    <Switch>
      <Route path="/login" component={Login} exact />
      <Route path="/help" component={Help} exact />
      <Route>
${inside}
      </Route>
    </Switch>`;

function writeApp(files: Record<string, string>, keys: Record<string, unknown> = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  const src = path.join(copy, 'src');
  const all = { ...Object.fromEntries(PAGES.map((n) => [`${n}.js`, page(n)])), ...FRAME_PARTS, ...files };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  }
  const configFile = path.join(copy, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ srcRoot: 'src', routesFile: 'Routes.js', routeElements: ['Route'], apiModules: [], settingsRoots: ['globalSettings'], outDir: 'out', ...keys }, null, 2));
  return configFile;
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const screen = (map: ScreenMap, id: string) => {
  const found = map.screens.find((s) => s.id === id);
  assert.ok(found, `${id} is not among ${map.screens.map((s) => s.id).join(', ')}`);
  return found;
};
const givenBy = (map: ScreenMap, id: string, file: string) => screen(map, id).links.filter((l) => l.file === file).map((l) => l.to);
const requestedBy = (map: ScreenMap, id: string, file: string) => screen(map, id).apiCalls.filter((c) => c.file === file).map((c) => c.endpoints!.map((e) => `${e.method} ${e.url}`).join());
const INSIDE = ['/home#Home', '/team/:team#Team'];

test('a component drawn beside the Switch of a group of routes gives its links and requests to every screen of that group, and to no screen outside it', async () => {
  const map = await build(writeApp({ 'Routes.js': routesFile(outer(`        <div>\n          <Menu />\n          ${GROUP}\n        </div>`)) }));
  for (const id of INSIDE) {
    assert.deepEqual(givenBy(map, id, 'Menu.js'), ['/help'], id);
    assert.deepEqual(requestedBy(map, id, 'Menu.js'), ['GET /api/menu'], id);
    assert.ok(screen(map, id).sourceFiles.includes('Menu.js'), id);
  }
  assert.deepEqual(givenBy(map, '/login#Login', 'Menu.js'), []);
  assert.deepEqual(map.screens.map((s) => s.id), ['/login#Login', '/help#Help', ...INSIDE]);
});

test('a component beside routes counts inside a fragment and on the branch that holds the routes, but not in a prop, on the other branch, or beside another group of routes', async () => {
  const inside = `        {crashed ? (
          <Other />
        ) : (
          <>
            <Suspense fallback={<Other />}>
              <Menu />
              <Shell overlay={<Other />}>
                ${GROUP}
              </Shell>
            </Suspense>
            <section>
              <Banner />
              <Switch>
                <Route path="/admin" component={Admin} />
              </Switch>
            </section>
          </>
        )}`;
  const map = await build(writeApp({ 'Routes.js': routesFile(outer(inside)) }));
  for (const id of INSIDE) {
    assert.deepEqual(givenBy(map, id, 'Menu.js'), ['/help'], id);
    assert.deepEqual(givenBy(map, id, 'Other.js'), [], id);
    assert.deepEqual(givenBy(map, id, 'Banner.js'), [], id);
  }
  assert.deepEqual(givenBy(map, '/admin#Admin', 'Banner.js'), ['/admin']);
  assert.deepEqual(givenBy(map, '/admin#Admin', 'Menu.js'), []);
  assert.deepEqual(givenBy(map, '/admin#Admin', 'Other.js'), []);
});

test('a condition written where a component beside routes is drawn guards the links and requests it gives, and the access of the screens they reach reads the setting in it', async () => {
  const inside = `        <div>
          {globalSettings.SYSTEM.HELP_ENABLED && <Menu />}
          ${GROUP}
        </div>`;
  const map = await build(writeApp({ 'Routes.js': routesFile(outer(inside)) }, { entryPaths: ['/home'] }));
  const line = routesFile(outer(inside)).split('\n').findIndex((l) => l.includes('<Menu />')) + 1;
  for (const id of INSIDE) {
    const [link] = screen(map, id).links.filter((l) => l.file === 'Menu.js');
    assert.deepEqual([link.guards, link.inheritedGuards], [[], [{ via: 'Menu', line, guards: ['globalSettings.SYSTEM.HELP_ENABLED'], file: 'Routes.js' }]], id);
    assert.deepEqual(link.conditions.map((c) => [c.guard, c.kinds, c.via, c.settings]), [['globalSettings.SYSTEM.HELP_ENABLED', ['setting'], 'Menu', [{ root: 'globalSettings', path: ['SYSTEM', 'HELP_ENABLED'], need: 'on' }]]], id);
    assert.deepEqual(screen(map, id).apiCalls.filter((c) => c.file === 'Menu.js').map((c) => c.inheritedGuards?.map((g) => g.guards)), [[['globalSettings.SYSTEM.HELP_ENABLED']]], id);
  }
  assert.deepEqual(screen(map, '/help#Help').access.kinds, ['setting']);
  assert.deepEqual(screen(map, '/help#Help').access.settings?.map((s) => [s.from, s.needs, s.unreadable]), INSIDE.map((id) => [id, [{ root: 'globalSettings', path: ['SYSTEM', 'HELP_ENABLED'], need: 'on' }], []]));
});

test('a component drawn both under a condition and without one beside the same routes gives its links without the condition', async () => {
  const inside = `        <div>
          {globalSettings.SYSTEM.HELP_ENABLED && <Menu />}
          <Menu />
          ${GROUP}
        </div>`;
  const map = await build(writeApp({ 'Routes.js': routesFile(outer(inside)) }));
  for (const id of INSIDE) assert.deepEqual(screen(map, id).links.filter((l) => l.file === 'Menu.js').map((l) => l.inheritedGuards ?? []), [[]], id);
});

test('routes returned by a function of the routes file get what is drawn beside the place the file draws that function or calls it inside JSX, while a function only exported, wrapped or drawn from another file gets nothing', async () => {
  const drawn = `function Pages() {
  return (
    ${GROUP}
  );
}

export default function Routes() {
  const renderAdmin = () => (
    <Switch>
      <Route path="/admin" component={Admin} />
    </Switch>
  );
  return (
    <>
      <Menu />
      <Pages />
      <section>
        <Banner />
        <Shell>{renderAdmin()}</Shell>
      </section>
    </>
  );
}
`;
  const files = { 'Routes.js': `import { Route, Switch } from 'react-router-dom';\n${['Home', 'Team', 'Admin', 'Menu', 'Banner', 'Shell'].map((n) => `import ${n} from './${n}';`).join('\n')}\n\n${drawn}` };
  const map = await build(writeApp(files));
  for (const id of INSIDE) {
    assert.deepEqual(givenBy(map, id, 'Menu.js'), ['/help'], id);
    assert.deepEqual(givenBy(map, id, 'Banner.js'), [], id);
  }
  assert.deepEqual(givenBy(map, '/admin#Admin', 'Banner.js'), ['/admin']);
  assert.deepEqual(givenBy(map, '/admin#Admin', 'Menu.js'), ['/help']);
  assert.ok(screen(map, '/admin#Admin').sourceFiles.includes('Shell.js'));

  const wrapped = `import { observer } from 'mobx-react';
import { Route, Switch } from 'react-router-dom';
import Home from './Home';
import Team from './Team';
import Banner from './Banner';

function Routes() {
  return (
    ${GROUP}
  );
}

export const Watched = observer(Routes);
export const Framed = () => <div><Banner />{wrap(Routes)}</div>;
export default Routes;
`;
  const alone = await build(writeApp({ 'Routes.js': wrapped, 'Uses.js': `import Menu from './Menu';\nimport Routes from './Routes';\n\nexport default () => <><Menu /><Routes /></>;\n` }));
  for (const id of INSIDE) {
    assert.deepEqual(givenBy(alone, id, 'Menu.js'), [], id);
    assert.deepEqual(givenBy(alone, id, 'Banner.js'), [], id);
  }
});

const HEADER = `import { Route, Switch } from 'react-router-dom';
import Menu from './Menu';
import Profile from './Profile';

export default function Header() {
  return (
    <Switch>
      <Route path="/team/:team" component={Menu} />
      <Route path="/home" component={Profile} />
    </Switch>
  );
}
`;

test('a component beside routes that draws its own routes is not given to the screens beside it, and extract prints one line naming where it is drawn', async () => {
  const inside = `        <div>
          <Header />
          <Banner />
          ${GROUP}
        </div>`;
  const text = routesFile(outer(inside), "import Header from './Header';\n");
  const configFile = writeApp({ 'Routes.js': text, 'Header.js': HEADER });
  const map = await build(configFile);
  for (const id of INSIDE) {
    assert.deepEqual(givenBy(map, id, 'Menu.js'), [], id);
    assert.deepEqual(givenBy(map, id, 'Banner.js'), ['/admin'], id);
    assert.ok(!screen(map, id).sourceFiles.includes('Header.js'), id);
  }
  const line = text.split('\n').findIndex((l) => l.includes('<Header />')) + 1;
  assert.deepEqual(map.framesPickingByAddress, [{ component: 'Header', file: 'Routes.js', line, componentFile: 'Header.js' }]);
  const result = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter((l) => l.includes('draws its own routes')), [
    `  Header at Routes.js:${line} is drawn beside routes but draws its own routes in Header.js, so it picks what it shows by the address; its links, requests and settings reads are given to no screen beside it`,
  ]);
});

test('a named tab component gets its tabs the drawing screen as frame', async () => {
  const settings = `import { useMemo } from 'react';
import RouteTab from './RouteTab';
import { getRoutes } from './Utils';

export default function Settings() {
  const routes = useMemo(() => getRoutes(), []);
  return <section><RouteTab routes={routes} /></section>;
}
`;
  const tab = `import { Route, Switch } from 'react-router-dom';
import Billing from './Billing';
import Members from './Members';

export default function RouteTab({ routes }) {
  return (
    <Switch>
      {routes.map((route) => <Route path={route.route} component={route.Component} key={route.route} />)}
    </Switch>
  );
}
`;
  const list = `import Billing from './Billing';
import Members from './Members';

export function getRoutes() {
  const settings = [];
  settings.push({ Component: Billing, route: '/settings/billing' });
  settings.push({ Component: Members, route: '/settings/members' });
  return settings;
}
`;
  const configFile = writeApp({
    'Routes.js': routesFile('      <Route path="/settings" component={Settings} />', "import Settings from './Settings';\n"),
    'Settings.js': settings,
    'RouteTab.js': tab,
    'Utils.js': list,
    'Billing.js': page('Billing'),
    'Members.js': page('Members'),
  }, { routeTabs: [{ import: './RouteTab', name: 'default', items: 'routes', path: 'route', component: 'Component' }] });
  const map = await build(configFile);
  for (const id of ['/settings/billing#Billing', '/settings/members#Members']) assert.ok(screen(map, id).sourceFiles.includes('Settings.js'), id);
  const result = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('a toggle named Switch from a UI library, drawn with or without children, in a component beside routes or beside them in the route file, does not count as routes', async () => {
  const routes = `import { Route, Routes } from 'react-router-dom';
import { Switch } from '@headlessui/react';
import Home from './Home';
import Team from './Team';
import Banner from './Banner';
import Header from './Header';

export default function App({ dark }) {
  return (
    <div>
      <Header />
      <section>
        <Banner />
        <Switch checked={dark}>
          <span className="sr-only">dark</span>
        </Switch>
      </section>
      <Routes>
        <Route path="/home" element={<Home />} />
        <Route path="/team/:team" element={<Team />} />
      </Routes>
    </div>
  );
}
`;
  const header = `import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Switch } from 'antd';

export default function Header() {
  const [dark, setDark] = useState(false);
  return <header><Link to="/login">in</Link><Switch checked={dark} onChange={setDark} /></header>;
}
`;
  const map = await build(writeApp({ 'Routes.js': routes, 'Header.js': header }));
  for (const id of INSIDE) {
    assert.deepEqual(givenBy(map, id, 'Header.js'), ['/login'], id);
    assert.deepEqual(givenBy(map, id, 'Banner.js'), ['/admin'], id);
  }
  assert.equal(map.framesPickingByAddress, undefined);
});

test('a Switch taken from a file of the app that re-exports the router, with require, or from another package and drawn around routes, still picks the first route that matches', async () => {
  const takes = [
    ["import { Switch } from './router';", { 'router.js': "export { Switch } from 'react-router-dom';\n" }],
    ["const { Switch } = require('react-router-dom');", {}],
    ["import { Switch } from 'wouter';", {}],
  ] as const;
  for (const [take, files] of takes) {
    const routes = `import { Route } from 'react-router-dom';
${take}
import Help from './Help';
import Team from './Team';
import Menu from './Menu';

export default function Routes() {
  return (
    <div>
      <Menu />
      <Switch>
        <Route path="/help" component={Help} exact />
        <Route path="/:team" component={Team} exact />
      </Switch>
    </div>
  );
}
`;
    const map = await build(writeApp({ ...files, 'Routes.js': routes }));
    assert.deepEqual(screen(map, '/help#Help').links.filter((l) => l.file === 'Menu.js').map((l) => l.targets), [['/help#Help']], take);
  }
});

const INNER_ROUTES = `import { Route, Switch } from 'react-router-dom';
import Usage from './Usage';
import Profile from './Profile';

export default function Settings() {
  return (
    <Switch>
      <Route path="/settings/usage" component={Usage} />
      <Route path="/settings/profile" component={Profile} />
    </Switch>
  );
}
`;
const INNER = ['/settings/usage#Usage', '/settings/profile#Profile'];
const nested = (holder: string, inner: string = INNER_ROUTES, files: Record<string, string> = {}, routes = ['Routes.js', 'settings/Settings.js']) => writeApp({
  'Routes.js': routesFile(outer(`        <Shell>\n          <Menu />\n          <Switch>\n            <Route path="/home" component={Home} exact />\n            ${holder}\n          </Switch>\n        </Shell>`), "import Settings from './settings/Settings';\n"),
  'settings/Settings.js': inner,
  'settings/Usage.js': page('Usage'),
  'settings/Profile.js': page('Profile'),
  ...files,
}, { routesFile: routes });

test('the screens of a route file drawn by a route of another route file get what is drawn around and beside that route, and what the route file draws beside its own routes', async () => {
  const map = await build(nested('<Route path="/settings" component={Settings} />', INNER_ROUTES.replace("import Profile from './Profile';", "import Profile from './Profile';\nimport Other from '../Other';").replace('    <Switch>\n', '    <>\n    <Other />\n    <Switch>\n').replace('    </Switch>\n', '    </Switch>\n    </>\n')));
  for (const id of INNER) {
    assert.deepEqual(givenBy(map, id, 'Menu.js'), ['/help'], id);
    assert.deepEqual(requestedBy(map, id, 'Menu.js'), ['GET /api/menu'], id);
    assert.deepEqual(givenBy(map, id, 'Other.js'), ['/login'], id);
    assert.ok(screen(map, id).sourceFiles.includes('Shell.js'), id);
  }
  assert.deepEqual(map.screens.map((s) => [s.id, s.path]), [['/login#Login', '/login'], ['/help#Help', '/help'], ['/home#Home', '/home'], ['/settings#Settings', '/settings'], ...INNER.map((id) => [id, id.split('#')[0]])]);
  assert.deepEqual(givenBy(map, '/login#Login', 'Menu.js'), []);
});

test('a route file drawn as an element inside the Switch of another route file gets what is drawn around and beside that element', async () => {
  const map = await build(nested('<Settings />'));
  for (const id of INNER) {
    assert.deepEqual(givenBy(map, id, 'Menu.js'), ['/help'], id);
    assert.ok(screen(map, id).sourceFiles.includes('Shell.js'), id);
  }
});

test('a route file two levels in gets the frames of both route files around it, without the route files themselves', async () => {
  const middle = `import { Route, Switch } from 'react-router-dom';
import Banner from '../Banner';
import Usage from './Usage';
import Deep from './deep/Deep';

export default function Settings() {
  return (
    <div>
      <Banner />
      <Switch>
        <Route path="/settings/usage" component={Usage} />
        <Route path="/settings/deep" component={Deep} />
      </Switch>
    </div>
  );
}
`;
  const deep = `import { Route } from 'react-router-dom';
import Profile from '../Profile';

export default function Deep() {
  return <Route path="/settings/deep/profile" component={Profile} />;
}
`;
  const map = await build(nested('<Route path="/settings" component={Settings} />', middle, { 'settings/deep/Deep.js': deep }, ['Routes.js', 'settings/Settings.js', 'settings/deep/Deep.js']));
  const id = '/settings/deep/profile#Profile';
  assert.deepEqual(givenBy(map, id, 'Menu.js'), ['/help']);
  assert.deepEqual(givenBy(map, id, 'Banner.js'), ['/admin']);
  assert.ok(!screen(map, id).sourceFiles.includes('settings/Settings.js'));
  assert.ok(!screen(map, id).sourceFiles.includes('Routes.js'));
});

test('the screens of a route file drawn by a component of a route get what is drawn beside that route, but not that component or what it draws beside the route file', async () => {
  const routes = `import { Route, Switch } from 'react-router-dom';
import Login from './Login';
import Menu from './Menu';
import TeamController from './TeamController';

export default function Routes() {
  return (
    <div>
      <Menu />
      <Switch>
        <Route path="/login" component={Login} exact />
        <Route path="/settings" render={() => <TeamController />} />
      </Switch>
    </div>
  );
}
`;
  const controller = `import { Link } from 'react-router-dom';
import Settings from './settings/Settings';
import Banner from './Banner';

export default function TeamController() {
  return <div><Link to="/login">in</Link><Banner /><Settings /></div>;
}
`;
  const map = await build(writeApp({ 'Routes.js': routes, 'TeamController.js': controller, 'settings/Settings.js': INNER_ROUTES, 'settings/Usage.js': page('Usage'), 'settings/Profile.js': page('Profile') }, { routesFile: ['Routes.js', 'settings/Settings.js'] }));
  for (const id of INNER) {
    assert.deepEqual(screen(map, id).links.map((l) => [l.file, l.to]), [['Menu.js', '/help']], id);
    assert.ok(!screen(map, id).sourceFiles.includes('TeamController.js'), id);
    assert.ok(!screen(map, id).sourceFiles.includes('Banner.js'), id);
  }
});

test('a route file drawn in two places gets what is drawn beside each of them', async () => {
  const routes = `import { Route, Switch } from 'react-router-dom';
import Login from './Login';
import Menu from './Menu';
import Banner from './Banner';
import Settings from './settings/Settings';

export default function Routes() {
  return (
    <>
      <Switch>
        <Route path="/login" component={Login} exact />
      </Switch>
      <div>
        <Menu />
        <Switch>
          <Settings />
        </Switch>
      </div>
      <section>
        <Banner />
        <Switch>
          <Settings />
        </Switch>
      </section>
    </>
  );
}
`;
  const map = await build(writeApp({ 'Routes.js': routes, 'settings/Settings.js': INNER_ROUTES, 'settings/Usage.js': page('Usage'), 'settings/Profile.js': page('Profile') }, { routesFile: ['Routes.js', 'settings/Settings.js'] }));
  for (const id of INNER) {
    assert.deepEqual(givenBy(map, id, 'Menu.js'), ['/help'], id);
    assert.deepEqual(givenBy(map, id, 'Banner.js'), ['/admin'], id);
  }
  assert.deepEqual(givenBy(map, '/login#Login', 'Menu.js'), []);
  assert.deepEqual(map.screens.map((s) => s.id), ['/login#Login', ...INNER]);
});

test('the usage guide and the agent skill name the line for a component beside routes that draws its own routes, and the decision record names the choice', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
  assert.ok(read('../README.md').includes('`<component> at <file>:<line> is drawn beside routes but draws its own routes in <component file>'));
  assert.ok(read('../skills/duru/SKILL.md').includes('`<component> at <file>:<line> is drawn beside routes but draws its own routes in <file>'));
  assert.match(read('../docs/decisions.md'), /Chosen for #467/);
});
