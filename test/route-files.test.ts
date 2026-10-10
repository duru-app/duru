import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';
import { startReviewServer } from '../src/review.ts';
import { checkStories } from '../src/story-paths.ts';

for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');

const SECOND = 'AdminRoutes.js';

type Copy = { copy: string; configFile: string; setConfig: (change: Record<string, unknown>) => void; src: string };
type SplitCopy = Omit<Copy, 'setConfig'> & { first: string; second: string };
type Failure = Error & { status: number | null; stderr: string };

const FIRST_ROUTES = `import { lazy } from 'react';
import { Route, Switch } from 'react-router-dom';
import Option from './_define/Option';
import SignIn from './components/SignIn';
import Home from './components/Home';
import Layout from './components/Layout';

const waitFor = (Tag) =>
  function WaitFor(props) {
    return <Tag {...props} />;
  };

const DocumentList = lazy(() => import('./components/DocumentList'));
const DocumentDetail = lazy(() => import('./components/DocumentDetail'));
const Help = lazy(() => import('./components/Help'));

export default function Routes({ session, globalSettings }) {
  return (
    <Switch>
      <Route path={Option.ROUTE_PATH.SIGN_IN} component={SignIn} exact />
      <Route>
        <Layout session={session} globalSettings={globalSettings}>
          <Switch>
            <Route path={Option.ROUTE_PATH.HOME} component={waitFor(Home)} exact />
            <Route path={\`\${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)\`} component={waitFor(DocumentList)} exact />
            <Route path={\`\${Option.ROUTE_PATH.DOCUMENT}/:id\`} component={waitFor(DocumentDetail)} exact />
          </Switch>
        </Layout>
      </Route>
      <Route path={Option.ROUTE_PATH.HELP} component={Help} exact />
    </Switch>
  );
}
`;

const secondRoutes = (extra = '') => `import { lazy } from 'react';
import { Redirect, Route, Switch } from 'react-router-dom';
import Option from './_define/Option';
import Enum from './_define/Enum';

const waitFor = (Tag) =>
  function WaitFor(props) {
    return <Tag {...props} />;
  };

const isAdminRole = (role) => role === Enum.ROLE.ADMIN;

const AdminMember = lazy(() => import('./components/AdminMember'));
const AdminGroup = lazy(() => import('./components/AdminGroup'));
const Lab = lazy(() => import('./components/Lab'));
const LabResult = lazy(() => import('./components/LabResult'));
const AdminAudit = lazy(() => import('./components/AdminAudit'));
const AdminReport = lazy(() => import('./components/AdminReport'));
const Help = lazy(() => import('./components/Help'));

export default function AdminRoutes({ memberRole, globalSettings }) {
  const isAdmin = canManageGroups(memberRole);

  return (
    <Switch>
      {isAdminRole(memberRole) && <Route path={Option.ROUTE_PATH.ADMIN_MEMBER} component={AdminMember} exact />}
      {isAdmin && <Route path={Option.ROUTE_PATH.ADMIN_GROUP} component={AdminGroup} exact />}
      {globalSettings.SYSTEM.LAB_ENABLED ? <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact /> : null}
      <Route path={Option.ROUTE_PATH.LAB_RESULT} component={waitFor(LabResult)} exact />
      <Route path={Option.ROUTE_PATH.ADMIN_AUDIT} component={AdminAudit} exact />
      <Route path={Option.ROUTE_PATH.ADMIN_REPORT} component={AdminReport} exact />
${extra}      <Redirect to={Option.ROUTE_PATH.SIGN_IN} />
    </Switch>
  );
}

function canManageGroups(role) {
  if (!role) return false;
  return isAdminRole(role);
}
`;

const lineOf = (file: string, text: string) => {
  const at = fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes(text));
  assert.ok(at >= 0, `${file} has ${text}`);
  return at + 1;
};

async function withCopy(fn: (copy: Copy) => unknown) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const setConfig = (change: Record<string, unknown>) => fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ...change }));
    return await fn({ copy, configFile, setConfig, src: path.join(copy, 'client/src') });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const withSplitCopy = (fn: (copy: SplitCopy) => unknown, { configPatch = {}, extra }: { configPatch?: Record<string, unknown>; extra?: string } = {}) => withCopy(({ src, setConfig, ...rest }) => {
  fs.writeFileSync(path.join(src, 'Routes.js'), FIRST_ROUTES);
  fs.writeFileSync(path.join(src, SECOND), secondRoutes(extra));
  setConfig({ routesFile: ['Routes.js', SECOND], ...configPatch });
  return fn({ ...rest, src, first: path.join(src, 'Routes.js'), second: path.join(src, SECOND) });
});

const mapOf = (configFile: string) => buildMap(loadConfig(configFile));
const screen = (map: ScreenMap, id: string) => map.screens.find((s) => s.id === id)!;
const IDS = ['/signin#SignIn', '/home#Home', '/document/:tab_draft_done_#DocumentList', '/document/:id#DocumentDetail', '/help#Help', '/admin/member#AdminMember', '/admin/group#AdminGroup', '/lab#Lab', '/lab/result#LabResult', '/admin/audit#AdminAudit', '/admin/report#AdminReport'];
const withoutRun = ({ meta, ...rest }: { meta: object }) => ({ ...rest, meta: { ...meta, generatedAt: null } });

test('a config that lists two route files puts the screens of both on the map in listed order, each with its own route file and line', async () => {
  await withSplitCopy(async ({ configFile, first, second }) => {
    const map = await mapOf(configFile);
    assert.deepEqual(map.screens.map((s) => [s.id, s.routeFile]), [
      ['/signin#SignIn', 'Routes.js'],
      ['/home#Home', 'Routes.js'],
      ['/document/:tab_draft_done_#DocumentList', 'Routes.js'],
      ['/document/:id#DocumentDetail', 'Routes.js'],
      ['/help#Help', 'Routes.js'],
      ['/admin/member#AdminMember', SECOND],
      ['/admin/group#AdminGroup', SECOND],
      ['/lab#Lab', SECOND],
      ['/lab/result#LabResult', SECOND],
      ['/admin/audit#AdminAudit', SECOND],
      ['/admin/report#AdminReport', SECOND],
    ]);
    assert.equal(screen(map, '/home#Home').line, lineOf(first, 'ROUTE_PATH.HOME'));
    assert.equal(screen(map, '/help#Help').line, lineOf(first, 'ROUTE_PATH.HELP'));
    assert.equal(screen(map, '/admin/member#AdminMember').line, lineOf(second, 'ROUTE_PATH.ADMIN_MEMBER'));
    assert.equal(screen(map, '/lab#Lab').line, lineOf(second, 'ROUTE_PATH.LAB}'));
    assert.equal(screen(map, '/admin/report#AdminReport').line, lineOf(second, 'ROUTE_PATH.ADMIN_REPORT'));
    assert.notEqual(screen(map, '/home#Home').line, screen(map, '/lab#Lab').line);
  });
});

test('the conditions of a route and the places a redirect and an access verdict point at are in the route file that holds them', async () => {
  await withSplitCopy(async ({ configFile, second }) => {
    const map = await mapOf(configFile);
    assert.deepEqual(screen(map, '/admin/member#AdminMember').routeGuards, ['isAdminRole(memberRole)']);
    assert.deepEqual(screen(map, '/admin/group#AdminGroup').access.kinds, ['role']);
    assert.deepEqual(screen(map, '/admin/group#AdminGroup').access.route.map((g) => [g.guard, g.kinds]), [['isAdmin', ['role']]]);
    assert.deepEqual(screen(map, '/lab#Lab').access.route.map((g) => [g.guard, g.kinds]), [['globalSettings.SYSTEM.LAB_ENABLED', ['setting']]]);
    assert.deepEqual(screen(map, '/home#Home').access.route, []);
    assert.deepEqual(map.entries, [{
      screen: '/signin#SignIn',
      reasons: [{ kind: 'redirect', file: SECOND, line: lineOf(second, '<Redirect') }, { kind: 'no-incoming-link' }],
    }]);
  });
});

test('a redirect under a condition is judged by the route file it is written in, so it does not make its target an entry screen', async () => {
  const extra = '      {isAdmin && <Redirect from="/faq" to={Option.ROUTE_PATH.HELP} />}\n';
  await withSplitCopy(async ({ configFile }) => {
    const map = await mapOf(configFile);
    assert.deepEqual(map.entries.map((e) => e.screen), ['/signin#SignIn']);
    assert.equal(screen(map, '/help#Help').access.restricted, true);
  }, { extra });
});

test('a story step through a route checks that route with the guards of its own route file', async () => {
  await withSplitCopy(async ({ configFile }) => {
    const map = await mapOf(configFile);
    const [story] = checkStories(map, [{ id: 'lab', screens: ['/lab#Lab'] }]);
    const route = story.reach.find((r) => r.kind === 'route');
    assert.deepEqual([route!.screen, route!.file, route!.line, route!.guards.map((g: { guard: string }) => g.guard)], ['/lab#Lab', SECOND, screen(map, '/lab#Lab').line, ['globalSettings.SYSTEM.LAB_ENABLED']]);
  });
});

test('the same screen ID in two route files is reported with the name and line of both', async () => {
  const extra = '      {memberRole && <Route path={Option.ROUTE_PATH.HELP} component={Help} />}\n';
  await withSplitCopy(async ({ configFile, first, second }) => {
    const map = await mapOf(configFile);
    const places = [{ file: 'Routes.js', line: lineOf(first, 'ROUTE_PATH.HELP') }, { file: SECOND, line: lineOf(second, 'ROUTE_PATH.HELP') }];
    assert.deepEqual(map.duplicateIds, [{ id: '/help#Help', places }]);
    const stdout = execFileSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
    assert.match(stdout, new RegExp(`^ {2}duplicate screen ID /help#Help ← ${places.map((p) => `${p.file}:${p.line}`).join(', ')}$`, 'm'));
  }, { extra });
});

test('the task list gives each screen and each story precondition the route file of that screen', async () => {
  await withSplitCopy(({ configFile, first, second }) => {
    const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, configFile], { encoding: 'utf8' });
    cli('rebuild');
    const tasks = cli('tasks');
    assert.match(tasks, new RegExp(`^- component: components/Home\\.js, route at Routes\\.js:${lineOf(first, 'ROUTE_PATH.HOME')}$`, 'm'));
    assert.match(tasks, new RegExp(`^- component: components/AdminMember\\.js, route at ${SECOND}:${lineOf(second, 'ROUTE_PATH.ADMIN_MEMBER')}$`, 'm'));
    assert.match(tasks, new RegExp(`^ {2}- /lab#Lab route at ${SECOND}:${lineOf(second, 'ROUTE_PATH.LAB}')}, guard `, 'm'));
    assert.doesNotMatch(tasks, /route at Routes\.js:\d+, guard/);
  }, { configPatch: { marksDir: 'example-marks', storiesDir: 'example-stories' } });
});

test('a config with one route file written as text or as a list of one gives the same map, and the config keeps no second name for it', async () => {
  const asText = loadConfig(path.join(FIXTURE, 'config.json'));
  assert.deepEqual(asText.routeFiles, ['Routes.js']);
  assert.equal('routesFile' in asText, false);

  await withCopy(async ({ configFile, setConfig }) => {
    for (const written of ['./Routes.js', '/Routes.js', '../src/Routes.js']) {
      setConfig({ routesFile: written });
      assert.deepEqual(loadConfig(configFile).routeFiles, ['Routes.js'], written);
    }
    setConfig({ routesFile: ['Routes.js', '../shared/Routes.js'] });
    assert.deepEqual(loadConfig(configFile).routeFiles, ['Routes.js', path.join('..', 'shared', 'Routes.js')]);
    setConfig({ routesFile: ['Routes.js'] });
    const asList = loadConfig(configFile);
    assert.deepEqual(asList.routeFiles, ['Routes.js']);
    const [fromText, fromList] = await Promise.all([buildMap(asText), buildMap(asList)]);
    assert.ok(fromText.screens.every((s) => s.routeFile === 'Routes.js'));
    assert.deepEqual(withoutRun({ ...fromList, meta: { ...fromList.meta, srcRoot: null } }), withoutRun({ ...fromText, meta: { ...fromText.meta, srcRoot: null } }));
    assert.deepEqual(fromText.screens.map((s) => s.id), IDS);
  });
});

const ROUTES_FILE = 'a route file as a path from srcRoot, or a list of them with each file once, such as "Routes.js" or ["Routes.js", "admin/Routes.js"]';
const ROUTES_FILE_ERROR = `routesFile must be ${ROUTES_FILE}, not `;

test('a routesFile that is empty, not text, or a list naming a file twice ends in an error that names the key, what it takes and the value', async () => {
  await withCopy(({ configFile, setConfig }) => {
    const bad = [[], '', 7, { file: 'Routes.js' }, ['Routes.js', 7], ['Routes.js', ''], [['Routes.js']], null,
      ['Routes.js', 'Routes.js'], ['Routes.js', './Routes.js'], ['Routes.js', 'admin/../Routes.js'], ['Routes.js', '/Routes.js'], ['Routes.js', '../src/Routes.js']];
    for (const value of bad) {
      setConfig({ routesFile: value });
      assert.throws(() => loadConfig(configFile), (err: Failure) => err.message === ROUTES_FILE_ERROR + JSON.stringify(value), JSON.stringify(value));
    }
    setConfig({ routesFile: [] });
    assert.throws(
      () => execFileSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8', stdio: 'pipe' }),
      (err: Failure) => err.status !== 0 && err.stderr.includes(`${ROUTES_FILE_ERROR}[]`),
    );
  });
});

test('a config without routesFile, or naming a route file that is not there, is refused when the map is built', async () => {
  await withCopy(async ({ configFile, setConfig }) => {
    setConfig({ routesFile: undefined });
    await assert.rejects(() => mapOf(configFile), (err: Failure) => err.message === `the config has no routesFile, which takes ${ROUTES_FILE}`);
    setConfig({ routesFile: ['Routes.js', 'admin/Routes.jsx'] });
    await assert.rejects(() => mapOf(configFile), (err: Failure) => err.message === `routesFile names "admin/Routes.jsx", but ${path.join(loadConfig(configFile).srcRoot, 'admin/Routes.jsx')} is not a file`);
  });
});

const LITERAL_ROUTES = `import { Route, Switch } from 'react-router-dom';
import SignIn from './components/SignIn';
import Help from './components/Help';

export default function Routes() {
  return (
    <Switch>
      <Route path="/signin" component={SignIn} exact />
      <Route path="/help" component={Help} exact />
    </Switch>
  );
}
`;

for (const keys of [['routeConstant'], ['constants', 'routeConstant']]) {
  test(`a config without ${keys.join(' and ')}, or with null for it, builds the map and gives a screen to a route whose path is written in place`, async () => {
    await withCopy(async ({ configFile, setConfig, src }) => {
      fs.writeFileSync(path.join(src, 'Routes.js'), LITERAL_ROUTES);
      for (const value of [undefined, null]) {
        setConfig(Object.fromEntries(keys.map((k) => [k, value])));
        assert.deepEqual((await mapOf(configFile)).screens.map((s) => s.id).sort(), ['/help#Help', '/signin#SignIn'], String(value));
      }
    });
  });
}

test('an empty routeConstant is taken as left out', async () => {
  await withCopy(async ({ configFile, setConfig, src }) => {
    fs.writeFileSync(path.join(src, 'Routes.js'), LITERAL_ROUTES);
    setConfig({ routeConstant: '' });
    assert.equal(loadConfig(configFile).routeConstant, null);
    assert.deepEqual((await mapOf(configFile)).screens.map((s) => s.id).sort(), ['/help#Help', '/signin#SignIn']);
  });
});

test('constants that are not an object of file paths, or a routeConstant that is not a dotted name or does not start with a name in constants, stop the run with an error that says what to write', async () => {
  await withCopy(({ configFile, setConfig }) => {
    const refused = (change: Record<string, unknown>, message: RegExp) => {
      setConfig(change);
      assert.throws(() => loadConfig(configFile), message);
    };
    refused({ constants: ['_define/Option.js'] }, /constants must map each name .* to its file as a path from srcRoot, such as \{ "Option": "_define\/Option.js" \}, not \["_define\/Option.js"\]/);
    refused({ constants: { Option: 3 } }, /constants must map each name/);
    refused({ constants: undefined, routeConstant: 'Option.ROUTE-PATH' }, /routeConstant must be the dotted name of the object that holds the route paths, such as "Option.ROUTE_PATH", not "Option.ROUTE-PATH"/);
    for (const routeConstant of ['Option.ROUTE_PATH ', ['Option', 'ROUTE_PATH'], 3]) refused({ routeConstant }, /routeConstant must be the dotted name/);
    refused({ routeConstant: 'Option.ROUTE_PATH' }, /^Error: routeConstant "Option\.ROUTE_PATH" starts with "Option", which is not a name in constants \(none\); add it to constants, or leave routeConstant out when the route paths are written in place$/);
    refused({ constants: { Option: '_define/Option.js' }, routeConstant: 'Opton.ROUTE_PATH' }, /^Error: routeConstant "Opton\.ROUTE_PATH" starts with "Opton", which is not a name in constants \("Option"\); /);
  });
});

test('a map built before screens carried their route file stops the task list, and the review server before it starts, with a line that says to rebuild', async () => {
  await withCopy(async ({ copy, configFile }) => {
    execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    const mapFile = path.join(copy, 'out/map.json');
    const map: ScreenMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    fs.writeFileSync(mapFile, JSON.stringify({ ...map, screens: map.screens.map(({ routeFile, ...s }) => s) }));
    const said = (text: string) => text.includes(`${mapFile} was built by a duru that did not record the route file of each screen — run "duru rebuild"`);
    assert.throws(() => execFileSync(process.execPath, [CLI, 'tasks', configFile], { encoding: 'utf8', stdio: 'pipe' }), (err: Failure) => err.status !== 0 && said(err.stderr));
    await assert.rejects(() => startReviewServer(loadConfig(configFile), { author: { name: 'reviewer', source: 'config' } }), (err: Failure) => said(err.message));
    const review = spawnSync(process.execPath, [CLI, 'review', configFile, '--port', '0'], { encoding: 'utf8', timeout: 20000 });
    assert.ok(review.status !== 0 && review.signal === null && said(review.stderr) && !review.stderr.includes('review page'), review.stderr);
  });
});

test('a map that turns old or unreadable while the review server runs is reported per request, and an unreadable one does not stop the server from starting', async () => {
  await withCopy(async ({ copy, configFile }) => {
    execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    const mapFile = path.join(copy, 'out/map.json');
    const good = fs.readFileSync(mapFile, 'utf8');
    const map: ScreenMap = JSON.parse(good);
    const old = JSON.stringify({ ...map, screens: map.screens.map(({ routeFile, ...s }) => s) });
    const asked = async (base: string) => {
      const replies = [await fetch(`${base}/api/data`), await fetch(`${base}/api/flow?from=${encodeURIComponent('/home#Home')}`), await fetch(`${base}/api/path-values?screen=${encodeURIComponent('/home#Home')}`)];
      return Promise.all(replies.map(async (r) => [r.status, await r.text()] as [number, string]));
    };
    const withServer = async (fn: (base: string) => Promise<void>) => {
      const server = await startReviewServer(loadConfig(configFile), { author: { name: 'reviewer', source: 'config' } });
      try {
        return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      } finally {
        server.close();
      }
    };
    await withServer(async (base) => {
      fs.writeFileSync(mapFile, old);
      for (const [status, text] of await asked(base)) assert.ok(status === 500 && text.includes('run "duru rebuild"'), `${status} ${text}`);
    });
    fs.writeFileSync(mapFile, good.slice(0, 2000));
    await withServer(async (base) => {
      assert.equal((await fetch(`${base}/api/data`)).status, 500);
      fs.writeFileSync(mapFile, good);
      assert.equal((await fetch(`${base}/api/data`)).status, 200);
    });
  });
});

test('the usage guide, the agent skill and the decision record say that route files are listed in the config', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
  assert.match(read('../README.md'), /`routesFile` is one route file as text[\s\S]*or a list of them/);
  assert.match(read('../skills/duru/SKILL.md'), /`routesFile` in the config is one route file or a list of them[\s\S]*`route at <file>:<line>`/);
  assert.match(read('../docs/decisions.md'), /\*\*Route files are listed in the config\.\*\*[\s\S]*Alternative compared: give one root route file and follow its imports/);
});

const browserMissing = fs.existsSync(chromium.executablePath()) ? false : 'Chromium is not installed (npx playwright-core install chromium)';

async function withReviewPage(configFile: string, fn: (page: Page) => Promise<void>) {
  execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
  const server = await startReviewServer(loadConfig(configFile), { author: { name: 'reviewer', source: 'config' } });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await page.waitForSelector('#view-flow.on, #view-list.on');
    await page.click('#view-list');
    await page.waitForSelector('#screen-list li');
    await fn(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
}

test('in a browser, the 라우트 line of a screen and the route step of a story name the route file that holds the route', { skip: browserMissing }, async () => {
  await withSplitCopy(({ configFile, first, second }) => withReviewPage(configFile, async (p) => {
    const routeLine = async (component: string) => {
      await p.locator('#screen-list li', { hasText: new RegExp(`${component}(?![A-Za-z])`) }).click();
      return p.locator('#right-info li', { hasText: /^라우트 / }).textContent();
    };
    assert.equal(await routeLine('Home'), `라우트 Routes.js:${lineOf(first, 'ROUTE_PATH.HOME')}`);
    assert.equal(await routeLine('Help'), `라우트 Routes.js:${lineOf(first, 'ROUTE_PATH.HELP')}`);
    assert.equal(await routeLine('Lab'), `라우트 ${SECOND}:${lineOf(second, 'ROUTE_PATH.LAB}')}`);
    assert.equal(await routeLine('AdminMember'), `라우트 ${SECOND}:${lineOf(second, 'ROUTE_PATH.ADMIN_MEMBER')}`);

    await p.click('#left .views.side button:has-text("스토리")');
    await p.click('#story-list li:has-text("실험실을 열어")');
    await p.click('#right .reach-raw > summary');
    assert.equal(await p.locator('#right .reach-route > code').textContent(), `${SECOND}:${lineOf(second, 'ROUTE_PATH.LAB}')}`);
  }), { configPatch: { storiesDir: 'example-stories' } });
});
