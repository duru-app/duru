import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';
import { screenFinder } from '../src/address-match.ts';

const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const page = (name: string) => `export default function ${name}() {\n  return <main>${name}</main>;\n}\n`;
const linking = (name: string, addresses: string[]) => `import { Link } from 'react-router-dom';\n\nexport default function ${name}() {\n  return <nav>${addresses.map((a) => `<Link to="${a}">${a}</Link>`).join('')}</nav>;\n}\n`;

const NESTED = `import { Fragment } from 'react';
import { Route, Routes } from 'react-router-dom';
import Frame from './Frame';
import Home from './Home';
import Shelf from './Shelf';
import List from './List';
import Panel from './Panel';
import Item from './Item';
import Start from './Start';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/:team" element={<Frame />}>
        <Route path="shelf/home" element={<Home />} />
        <Route path="shelf" element={<Shelf />}>
          <Fragment>
            <Route path="list" element={<List />} />
          </Fragment>
        </Route>
        <Route element={<Panel />}>
          <Route path="item/:id" element={<Item />} />
        </Route>
        <Route path="/:team/start" element={<Start />} />
      </Route>
    </Routes>
  );
}
`;

function writeApp(files: Record<string, string>, keys: Record<string, unknown> = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  const src = path.join(copy, 'src');
  const pages = ['Frame', 'Home', 'Shelf', 'List', 'Panel', 'Item', 'Settings', 'Team', 'Account', 'Profile', 'View', 'Missing'];
  const all = { 'Routes.js': NESTED, ...Object.fromEntries(pages.map((n) => [`${n}.js`, page(n)])), 'Start.js': linking('Start', ['/acme/shelf/list', '/acme/item/7', '/shelf/list']), ...files };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  }
  const configFile = path.join(copy, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ srcRoot: 'src', routesFile: 'Routes.js', routeElements: ['Route'], apiModules: [], settingsRoots: [], outDir: 'out', ...keys }, null, 2));
  return configFile;
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const ids = (map: ScreenMap) => map.screens.map((s) => s.id);
const targets = (map: ScreenMap, id: string) => Object.fromEntries(map.screens.find((s) => s.id === id)!.links.map((l) => [l.to, l.targets]));

test('a child route written with a relative path gets the paths of the routes around it in front, through a route with no path and a Fragment, and its ID follows the path', async () => {
  const map = await build(writeApp({}));
  assert.deepEqual(ids(map), ['/:team#Frame', '/:team/shelf/home#Home', '/:team/shelf#Shelf', '/:team/shelf/list#List', '/:team/item/:id#Item', '/:team/start#Start']);
  assert.deepEqual(targets(map, '/:team/start#Start'), {
    '/acme/shelf/list': ['/:team/shelf/list#List'],
    '/acme/item/7': ['/:team/item/:id#Item'],
    '/shelf/list': [],
  });
});

test('a browser test address goes to the screen of a child route written with a relative path', async () => {
  const find = screenFinder(await build(writeApp({})));
  assert.equal(find('http://localhost:3000/o1/shelf/home'), '/:team/shelf/home#Home');
  assert.equal(find('http://localhost:3000/o1/shelf/list?tab=2'), '/:team/shelf/list#List');
  assert.equal(find('http://localhost:3000/o1/item/9'), '/:team/item/:id#Item');
});

test('moves name a joined child route by its path on the map, and a path the map keeps relative as it is written there', async () => {
  const routes = `import { Route, Routes } from 'react-router-dom';
import Frame from './Frame';
import Home from './Home';
import App from './App';
import Start from './Start';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/:team" element={<Frame />}>
        <Route path="home" element={<Home />} />
      </Route>
      <Route path="/app/*" element={<App />} />
      <Route path="/start" element={<Start />} />
    </Routes>
  );
}
`;
  const app = `import { Route, Routes } from 'react-router-dom';
import Settings from './Settings';

export default function App() {
  return (
    <Routes>
      <Route path="settings" element={<Settings />} />
    </Routes>
  );
}
`;
  const moves = [{ from: '/start', to: '/:team/home', reason: '로그인 뒤' }, { from: '/:team/home', to: 'settings', reason: '설정 버튼' }];
  const map = await build(writeApp({ 'Routes.js': routes, 'App.js': app }, { routesFile: ['Routes.js', 'App.js'], moves }));
  assert.deepEqual(map.moves, [
    { from: '/start#Start', to: '/:team/home#Home', reason: '로그인 뒤' },
    { from: '/:team/home#Home', to: 'settings#Settings', reason: '설정 버튼' },
  ]);
  assert.deepEqual(map.unknownMovePaths, []);
});

test('a relative path at the top of a Routes that no route draws is read from /, under a route with no path too, while `*` and a Routes drawn inside a route keep the path as written', async () => {
  const routes = `import { Route, Routes } from 'react-router-dom';
import View from './View';
import Panel from './Panel';
import Home from './Home';
import Missing from './Missing';
import App from './App';
import Team from './Team';
import Start from './Start';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="pub/view/:id" element={<View />} />
      <Route element={<Panel />}>
        <Route path="guide" element={<Home />} />
      </Route>
      <Route path="/app/*" element={<App />} />
      <Route path="/x/*" element={<Routes><Route path="y" element={<Team />} /></Routes>} />
      <Route path="/start" element={<Start />} />
      <Route path="*" element={<Missing />} />
    </Routes>
  );
}
`;
  const app = `import { Route, Routes } from 'react-router-dom';
import Settings from './Settings';

export default function App() {
  return (
    <Routes>
      <Route path="settings" element={<Settings />} />
    </Routes>
  );
}
`;
  const start = linking('Start', ['/pub/view/3', '/app/settings', '/x/y']);
  const map = await build(writeApp({ 'Routes.js': routes, 'App.js': app, 'Start.js': start }, { routesFile: ['Routes.js', 'App.js'] }));
  assert.deepEqual(ids(map), ['/pub/view/:id#View', '/guide#Home', '/app/*#App', '/x/*#Route', 'y#Team', '/start#Start', '*#Missing', 'settings#Settings']);
  assert.deepEqual(targets(map, '/start#Start'), {
    '/pub/view/3': ['/pub/view/:id#View'],
    '/app/settings': ['settings#Settings'],
    '/x/y': ['y#Team'],
  });
});

test('a redirect to a relative path at the top of a Routes that no route draws goes to the route read from /, and makes it an entry', async () => {
  const routes = `import { Navigate, Route, Routes } from 'react-router-dom';
import Home from './Home';

export default function AppRoutes() {
  return (
    <Routes>
      <Route index element={<Navigate to="home" replace />} />
      <Route path="home" element={<Home />} />
    </Routes>
  );
}
`;
  const map = await build(writeApp({ 'Routes.js': routes }));
  assert.deepEqual(map.entries.find((e) => e.screen === '/home#Home')?.reasons.filter((r) => r.kind === 'redirect'), [{ kind: 'redirect', file: 'Routes.js', line: 7 }]);
});

test('route elements a function returns, with no Routes around them, join a child\'s relative path to its parent\'s and keep the outermost path as written, since the caller puts them under its own routes', async () => {
  const routes = `import { Route } from 'react-router-dom';
import Account from './Account';
import Profile from './Profile';

export function accountRoutes() {
  return (
    <Route path="account" element={<Account />}>
      <Route path="profile" element={<Profile />} />
    </Route>
  );
}
`;
  const map = await build(writeApp({ 'Routes.js': routes }));
  assert.deepEqual(ids(map), ['account#Account', 'account/profile#Profile']);
});

test('a relative path a function returns, and a parent path read from a constant, are joined the same way', async () => {
  const routes = `import { Route, Routes } from 'react-router-dom';
import Frame from './Frame';
import Home from './Home';

const TEAM = '/:team';
const homePath = () => 'home';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path={TEAM} element={<Frame />}>
        <Route path={homePath()} element={<Home />} />
      </Route>
    </Routes>
  );
}
`;
  const map = await build(writeApp({ 'Routes.js': routes }));
  assert.deepEqual(ids(map), ['/:team#Frame', '/:team/home#Home']);
});

test('a child route under a parent whose path is not read is not read either, stopped where the parent\'s path stopped', async () => {
  const routes = `import { Route, Routes } from 'react-router-dom';
import Frame from './Frame';
import Home from './Home';
import { areaPath } from 'outside-paths';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path={areaPath} element={<Frame />}>
        <Route path="home" element={<Home />} />
      </Route>
    </Routes>
  );
}
`;
  const map = await build(writeApp({ 'Routes.js': routes }));
  assert.deepEqual(map.screens.map((s) => s.path), ['{?}', '{?}/home']);
  assert.deepEqual(map.unreadRoutePaths!.map((u) => [u.line, u.path, u.stoppedAt.text]), [[9, '{?}', 'areaPath'], [10, '{?}/home', 'areaPath']]);
});
