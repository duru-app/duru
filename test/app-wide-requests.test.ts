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

const requesting = (name: string, address: string, extra = '') => `import { useEffect } from 'react';
${extra}
export default function ${name}({ children }) {
  useEffect(() => {
    fetch('${address}');
  }, []);
  return <div>{children}</div>;
}
`;

const APP: Record<string, string> = {
  'api.js': `const request = (info) => info;

export const ajaxMe = () => request({ URL: '/api/me', METHOD: 'GET' });
export const ajaxUnused = () => request({ URL: '/api/unused', METHOD: 'GET' });
`,
  'hooks/useFlags.js': "export const useFlags = () => fetch('/api/flags');\n",
  'hooks/useNotices.js': "export const useNotices = () => fetch('/api/notices');\n",
  'AppProvider.js': `import { createContext, useContext, useEffect } from 'react';
import { ajaxMe } from './api';
import { useFlags } from './hooks/useFlags';

const Context = createContext(null);

export function AppProvider({ children }) {
  useFlags();
  useEffect(() => {
    ajaxMe();
  }, []);
  return <Context.Provider value={{}}>{children}</Context.Provider>;
}

export const useApp = () => useContext(Context);
`,
  'index.js': `import { createRoot } from 'react-dom/client';
import { AppProvider } from './AppProvider';
import Routes from './Routes';

createRoot(document.getElementById('root')).render(<AppProvider><Routes /></AppProvider>);
`,
  'Routes.js': `import { useEffect } from 'react';
import { Route, Switch } from 'react-router-dom';
import Login from './Login';
import Home from './Home';
import Team from './Team';
import Shell from './Shell';
import Menu from './Menu';

export default function Routes() {
  useEffect(() => {
    fetch('/api/start');
  }, []);
  return (
    <Switch>
      <Route path="/login" component={Login} exact />
      <Route>
        <Shell>
          <Menu />
          <Switch>
            <Route path="/home" component={Home} exact />
            <Route path="/team" component={Team} exact />
          </Switch>
        </Shell>
      </Route>
    </Switch>
  );
}
`,
  'Shell.js': requesting('Shell', '/api/shell'),
  'Menu.js': `import { useEffect } from 'react';
import { useNotices } from './hooks/useNotices';

export default function Menu() {
  useNotices();
  useEffect(() => {
    fetch('/api/menu');
  }, []);
  return <nav />;
}
`,
  'Login.js': requesting('Login', '/api/login'),
  'Home.js': `import { useEffect } from 'react';
import { useApp } from './AppProvider';
import { useNotices } from './hooks/useNotices';

export default function Home() {
  useApp();
  useNotices();
  useEffect(() => {
    fetch('/api/home');
  }, []);
  return <main />;
}
`,
  'Team.js': requesting('Team', '/api/team'),
};

const COMPONENTS = [{ import: './AppProvider', name: 'AppProvider' }, { import: './Routes', name: 'default' }];

function writeApp(files: Record<string, string> = {}, keys: Record<string, unknown> = { appWideComponents: COMPONENTS }) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  for (const [rel, text] of Object.entries({ ...APP, ...files })) {
    fs.mkdirSync(path.dirname(path.join(copy, 'src', rel)), { recursive: true });
    fs.writeFileSync(path.join(copy, 'src', rel), text);
  }
  const configFile = path.join(copy, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ srcRoot: 'src', routesFile: 'Routes.js', routeElements: ['Route'], apiModules: ['api.js'], outDir: 'out', ...keys }, null, 2));
  return configFile;
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const extract = (configFile: string) => spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
const sentFrom = (calls: ScreenMap['screens'][number]['apiCalls']) => calls.map((c) => `${c.file} ${c.endpoints!.map((e) => `${e.method} ${e.url}`).join()}${c.layout ? ' layout' : ''}`).sort();
const screen = (map: ScreenMap, id: string) => map.screens.find((s) => s.id === id)!;

test('a component named in appWideComponents puts the requests its code reaches under appWide, once for the app and on no screen, and stops at the screens, layouts and route files it draws', async () => {
  const map = await build(writeApp());
  assert.deepEqual(map.appWide!.components, [{ import: './AppProvider', name: 'AppProvider', file: 'AppProvider.js' }, { import: './Routes', name: 'default', file: 'Routes.js' }]);
  assert.deepEqual(sentFrom(map.appWide!.apiCalls), ['AppProvider.js GET /api/me', 'Routes.js GET /api/start', 'hooks/useFlags.js GET /api/flags']);
  assert.deepEqual(map.appWide!.sourceFiles, ['AppProvider.js', 'Routes.js', 'hooks/useFlags.js']);
  for (const s of map.screens) {
    const urls = s.apiCalls.flatMap((c) => c.endpoints!.map((e) => e.url));
    for (const url of ['/api/me', '/api/start', '/api/flags']) assert.ok(!urls.includes(url), `${s.id} sends ${url}`);
  }
});

test('a request appWide sends is a call on the map that reaches no screen, and is not counted among the calls that reach no screen', async () => {
  const configFile = writeApp();
  const map = await build(configFile);
  for (const id of ['GET:/api/me', 'GET:/api/start', 'GET:/api/flags']) assert.deepEqual(map.calls.find((c) => c.id === id)?.screens, [], id);
  assert.deepEqual(map.callsOnNoScreen, { unused: ['GET:/api/unused'], other: [] });

  const without = await build(writeApp({}, {}));
  assert.equal('appWide' in without, false);
  assert.deepEqual(without.callsOnNoScreen, { unused: ['GET:/api/unused'], other: ['GET:/api/me'] });

  const { status, stdout } = extract(configFile);
  assert.equal(status, 0);
  assert.ok(stdout.split('\n').includes('requests sent for the whole app 3 | from AppProvider (AppProvider.js), default (Routes.js)'), stdout);
});

test('a request of a screen reached only through a component drawn around or beside its route is marked layout, and one the screen\'s own code reaches is not, even when the layout sends it too', async () => {
  const map = await build(writeApp());
  assert.deepEqual(sentFrom(screen(map, '/home#Home').apiCalls), ['Home.js GET /api/home', 'Menu.js GET /api/menu layout', 'Shell.js GET /api/shell layout', 'hooks/useNotices.js GET /api/notices']);
  assert.deepEqual(sentFrom(screen(map, '/team#Team').apiCalls), ['Menu.js GET /api/menu layout', 'Shell.js GET /api/shell layout', 'Team.js GET /api/team', 'hooks/useNotices.js GET /api/notices layout']);
  assert.deepEqual(sentFrom(screen(map, '/login#Login').apiCalls), ['Login.js GET /api/login']);
});

test('appWideComponents must name components the app exports', () => {
  const failing = (keys: Record<string, unknown>) => {
    const { status, stderr } = extract(writeApp({}, keys));
    assert.notEqual(status, 0);
    return stderr;
  };
  assert.match(failing({ appWideComponents: { import: './AppProvider', name: 'AppProvider' } }), /appWideComponents must be a list of \{ "import", "name" \}/);
  assert.match(failing({ appWideComponents: [{ import: './AppProvider' }] }), /appWideComponents must be a list of \{ "import", "name" \}/);
  assert.match(failing({ appWideComponents: [{ import: './Nowhere', name: 'AppProvider' }] }), /appWideComponents import \.\/Nowhere names no file under srcRoot/);
  assert.match(failing({ appWideComponents: [{ import: './AppProvider', name: 'Missing' }] }), /appWideComponents name Missing is not exported by AppProvider\.js/);
});

test('the usage guide names the config key, the map field, the marker, the line and the folded 「공통」 calls, the agent skill says when to set the key, and the decision record names what was compared', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
  const readme = read('README.md');
  assert.match(readme, /^- `appWideComponents` — /m);
  assert.match(readme, /\*\*Whole app\.\*\* With `appWideComponents` set, the map has `appWide`/);
  assert.match(readme, /`"layout": true`/);
  assert.match(readme, /^- `requests sent for the whole app N \| from <name> \(<file>\), …` — /m);
  assert.match(readme, /folded below it under 「공통 N」/);
  assert.match(read('skills/duru/SKILL.md'), /add `"appWideComponents": \[\{ "import": /);
  assert.match(read('docs/decisions.md'), /Chosen for #461[^]*?Compared:[^]*?the same call site on every screen/);
});
