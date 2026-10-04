import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { UNKNOWN } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { chromium } from 'playwright-core';
import { addJudgment, loadJudgments } from '../src/judgments.mjs';
import { addMark, loadMarks } from '../src/marks.mjs';
import { applyOverrides } from '../src/app-host.mjs';
import { reviewAuthor, startReviewServer } from '../src/review.mjs';
import { taskList } from '../src/tasks.mjs';

// git exports these to hooks and to rebase --exec; with them set, git in a test folder reads and writes the repository they name.
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.mjs');

async function withRebuiltFixture(configPatch, fn, edits = []) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    for (const [file, from, to] of edits) {
      const target = path.join(copy, file);
      const text = fs.readFileSync(target, 'utf8');
      assert.ok(text.includes(from), `${file} has ${from}`);
      fs.writeFileSync(target, text.replace(from, to));
    }
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ...configPatch }));
    execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    return await fn(loadConfig(configFile), copy);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

async function withServer(config, author, fn) {
  const server = await startReviewServer(config, { author });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const snapshot = (dir) =>
  Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort().map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), 'utf8') : null]));

const postMark = (base, body) => fetch(`${base}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const postJudgment = (base, body) => fetch(`${base}/api/judgments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('the page and its data are served, with the map, the tests per screen and the marks', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>duru 리뷰<\/title>/);

      const data = await (await fetch(`${base}/api/data`)).json();
      assert.equal(data.map.screens.length, 11);
      assert.ok(data.tests.nodes['/home#Home'].length > 0);
      assert.deepEqual(data.marks, { attached: [], detached: [] });
      assert.deepEqual(data.depths, ['ui', 'api', 'render', 'code', 'data', 'output']);
      assert.equal(data.author, 'reviewer');
    }),
  );
});

test('the data carries each story checked against the map with its status, the tests per story and the story files that could not be read, read again on every request', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual([data.stories.list, data.stories.notices], [[], []]);
      assert.deepEqual(data.stories.unknownTags.map((u) => u.tag), ['story:help-from-home', 'story:open-document', 'story:print-document', 'story:run-lab', 'story:run-lab']);
      assert.equal(data.storiesDir, path.join(config.outDir, 'stories'));
    }),
  );
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.stories.list.map((s) => [s.id, s.links.map((l) => l.verdict), s.broken, s.detached, s.status]), [
        ['change-settings', ['off-map'], false, true, 'partial'],
        ['help-from-home', ['open', 'broken'], true, false, 'pending'],
        ['open-document', ['open', 'open', 'open'], false, false, 'pass'],
        ['read-reports', [], false, false, 'untested'],
        ['run-lab', ['conditioned', 'open'], false, false, 'fail'],
      ]);
      assert.deepEqual(Object.keys(data.tests.stories).sort(), ['help-from-home', 'open-document', 'print-document', 'run-lab']);
      assert.deepEqual(data.stories.unknownTags.map((u) => u.tag), ['story:print-document']);
      assert.deepEqual(data.stories.notices.map((n) => n.file), ['lab-shortcut.json']);

      fs.writeFileSync(path.join(config.storiesDir, 'lab-shortcut.json'), JSON.stringify({ name: '실험실 결과', screens: ['/lab#Lab', '/lab/result#LabResult'], author: 'a', date: '2026-10-02' }));
      const again = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(again.stories.notices, []);
      assert.equal(again.stories.list.find((s) => s.id === 'lab-shortcut').reach[0].kind, 'start');

      fs.writeFileSync(path.join(config.storiesDir, 'print-document.json'), JSON.stringify({ name: '문서를 인쇄한다', screens: ['/document/:id#DocumentDetail'], author: 'a', date: '2026-10-03' }));
      const printed = await (await fetch(`${base}/api/data`)).json();
      assert.equal(printed.stories.list.find((s) => s.id === 'print-document').status, 'pass');
      assert.deepEqual(printed.stories.unknownTags, []);
    }),
  );
});

test('a mark posted from the page is saved with the server-side author and date and is there after reopening', async () => {
  await withRebuiltFixture({}, async (config) => {
    await withServer(config, 'reviewer', async (base) => {
      const res = await postMark(base, { target: { node: '/lab#Lab', depth: 'api' }, status: 'needs-more', note: 'only a UI test', author: 'someone else' });
      assert.equal(res.status, 201);
      assert.equal((await postMark(base, { target: { node: '/lab#Lab' }, status: 'maybe' })).status, 400);
    });
    const [saved] = loadMarks(config.marksDir);
    assert.equal(config.marksDir, path.join(config.outDir, 'marks'));
    assert.equal(saved.author, 'reviewer');
    assert.match(saved.date, /^\d{4}-\d\d-\d\dT/);

    await withServer(config, 'reviewer', async (base) => {
      const data = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.map((m) => [m.key, m.current.status, m.current.note]), [['/lab#Lab api', 'needs-more', 'only a UI test']]);
    });
  });
});

test('the author is the config author, else the git user name of the config folder, else the computer user name, and says where it came from', () => {
  const config = { configDir: '/projects/app', author: null };
  const asked = [];
  const git = (name) => (dir) => { asked.push(dir); return name; };
  const user = () => 'kim';
  assert.deepEqual(reviewAuthor({ ...config, author: '설정 이름' }, { gitName: git('Git Name'), userName: user }), { name: '설정 이름', source: 'config' });
  assert.deepEqual(reviewAuthor(config, { gitName: git('Git Name'), userName: user }), { name: 'Git Name', source: 'git' });
  assert.deepEqual(reviewAuthor(config, { gitName: git(null), userName: user }), { name: 'kim', source: 'user' });
  assert.deepEqual(asked, ['/projects/app', '/projects/app']);
  const fallback = reviewAuthor(config, { gitName: git(null) });
  assert.equal(fallback.source, 'user');
  assert.ok(fallback.name.trim().length > 0);
});

const withConfigFile = (patch, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), ...patch }));
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('the config author is kept trimmed, and is null when the config has none', () => {
  withConfigFile({ author: '  Kim Min ' }, (file) => assert.equal(loadConfig(file).author, 'Kim Min'));
  withConfigFile({}, (file) => assert.equal(loadConfig(file).author, null));
});

for (const [name, author] of [['a number', 7], ['an empty string', ''], ['only spaces', '   ']]) {
  test(`a config author that is ${name} is rejected with what it should be`, () => {
    withConfigFile({ author }, (file) => assert.throws(() => loadConfig(file), (err) => /^author must be .*"Kim Min"/.test(err.message) && err.message.endsWith(`not ${JSON.stringify(author)}`)));
  });
}

const signedWith = (config) => [...loadMarks(config.marksDir), ...loadJudgments(config.judgmentsDir).judgments].map((saved) => saved.author);

async function assertNewSavesSignedAs(config, name) {
  await withServer(config, undefined, async (base) => {
    assert.equal((await (await fetch(`${base}/api/data`)).json()).author, name);
    assert.equal((await postMark(base, { target: { node: '/lab#Lab' }, status: 'fine', author: 'typed name' })).status, 201);
    const test = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'renders the help text' };
    assert.equal((await postJudgment(base, { test, node: '/help#Help', kind: 'hand-over', reason: '', author: 'typed name' })).status, 201);
  });
  assert.deepEqual(signedWith(config), [name, name]);
}

function initGitRepoNamed(dir, name) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', name], { cwd: dir });
}

test('without a config author, a mark and a judgment are signed with the git user name of the config folder', async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    initGitRepoNamed(copy, 'Git 이름');
    await assertNewSavesSignedAs(config, 'Git 이름');
  });
});

test('with no config author and no git user name, a mark and a judgment are signed with the computer user name', async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    const noHome = path.join(copy, 'no-home');
    const noGitName = { HOME: noHome, XDG_CONFIG_HOME: noHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
    const kept = Object.fromEntries(Object.keys(noGitName).map((key) => [key, process.env[key]]));
    Object.assign(process.env, noGitName);
    try {
      await assertNewSavesSignedAs(config, os.userInfo().username);
    } finally {
      for (const [key, value] of Object.entries(kept)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test('rebuilding the map leaves the marks untouched, and marks on screens that disappeared are detached', async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    await withServer(config, 'reviewer', async (base) => {
      await postMark(base, { target: { node: '/help#Help' }, status: 'missing' });
      await postMark(base, { target: { node: '/home#Home', depth: 'ui' }, status: 'fine' });
    });
    const before = snapshot(config.marksDir);

    const routes = path.join(copy, 'client/src/Routes.js');
    fs.writeFileSync(routes, fs.readFileSync(routes, 'utf8').replace(/^.*ROUTE_PATH\.HELP.*\n/m, ''));
    execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
    assert.deepEqual(snapshot(config.marksDir), before);

    await withServer(config, 'reviewer', async (base) => {
      const data = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.map((m) => m.key), ['/home#Home ui']);
      assert.deepEqual(data.marks.detached.map((m) => m.key), ['/help#Help']);
    });
  });
});

test('with an app address, only screens without path variables get a link to the real app', async () => {
  await withRebuiltFixture({ appUrl: 'https://app.example.test/' }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.appLinks, {
        '/signin#SignIn': 'https://app.example.test/signin',
        '/home#Home': 'https://app.example.test/home',
        '/document/:tab_draft_done_#DocumentList': null,
        '/document/:id#DocumentDetail': null,
        '/help#Help': 'https://app.example.test/help',
        '/admin/member#AdminMember': 'https://app.example.test/admin/member',
        '/admin/group#AdminGroup': 'https://app.example.test/admin/group',
        '/admin/audit#AdminAudit': 'https://app.example.test/admin/audit',
        '/admin/report#AdminReport': 'https://app.example.test/admin/report',
        '/lab#Lab': 'https://app.example.test/lab',
        '/lab/result#LabResult': 'https://app.example.test/lab/result',
      });
    }),
  );
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data = await (await fetch(`${base}/api/data`)).json();
      assert.ok(Object.values(data.appLinks).every((l) => l === null));
      assert.equal(data.app, null);
    }),
  );
});

const PASSWORD_ENV = 'DURU_TEST_APP_PASSWORD';
const ADMIN_PASSWORD_ENV = 'DURU_TEST_ADMIN_PASSWORD';
const AUDITOR_PASSWORD_ENV = 'DURU_TEST_AUDITOR_PASSWORD';
const ACCOUNTS = {
  'duru-admin': { password: 's3cret', token: 't-123', name: '두루 관리자', documents: [{ id: 17 }, { id: 18 }] },
  'duru-boss': { password: 'b0ss', token: 't-boss', name: '두루 대표', documents: [{ id: 27 }] },
  'duru-auditor': { password: 'aud1t', token: 't-audit', name: '두루 감사', documents: [{ id: 37 }] },
};

async function withFakeApi(fn) {
  const presses = [];
  const logins = [];
  const listCalls = [];
  const requests = [];
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/auth/login') {
      const { loginId, pw } = JSON.parse(body);
      logins.push(loginId);
      const account = ACCOUNTS[loginId];
      return account?.password === pw ? json(res, 200, { result: { token: account.token } }) : json(res, 401, { message: 'bad login' });
    }
    const me = Object.values(ACCOUNTS).find((a) => req.headers.authorization === `Bearer ${a.token}`);
    if (!me) return json(res, 401, { message: 'no token' });
    if (req.method === 'GET' && req.url === '/api/v1/me') return json(res, 200, { name: me.name });
    if (req.url.startsWith('/api/v1/documents')) {
      listCalls.push(`${req.method} ${req.url}`);
      if (req.method === 'GET' && req.url === '/api/v1/documents') return json(res, 200, { contents: { list: me.documents } });
      if (req.method === 'POST' && req.url === '/api/v1/documents/search') return json(res, 200, [{ code: `${JSON.parse(body).status} 1/2` }]);
      if (req.method === 'GET' && req.url === '/api/v1/documents/empty') return json(res, 200, { contents: { list: [] } });
      if (req.method === 'GET' && req.url === '/api/v1/documents/broken') return json(res, 500, { message: 'broken' });
      if (req.method === 'GET' && req.url === '/api/v1/documents/flaky') {
        return listCalls.filter((c) => c.endsWith('/flaky')).length === 1 ? json(res, 503, { message: 'busy' }) : json(res, 200, { contents: { list: [{ id: 'done' }] } });
      }
      if (req.method === 'GET' && req.url === '/api/v1/documents/text') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('not json');
      }
    }
    if (req.method === 'POST' && req.url === '/api/v1/press') {
      presses.push(req.url);
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('pressed');
    }
    json(res, 404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, presses, logins, listCalls, requests);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const appSettings = (server) => ({
  app: {
    files: 'build',
    server,
    apiPaths: ['/api/'],
    login: {
      path: '/auth/login',
      body: { loginId: '{id}', pw: '{password}' },
      token: 'result.token',
      storage: { key: 'FAKE_AUTH', value: { accessToken: '{token}' } },
    },
    account: { id: 'duru-admin', passwordEnv: PASSWORD_ENV },
  },
});

const SETTINGS_FILE = { path: '/settings.js', global: 'window.FAKE_SETTINGS', root: 'globalSettings', merged: ['SYSTEM', 'CUSTOM'] };
const withSettingsFile = (api, extra = {}) => ({ app: { ...appSettings(api).app, settingsFile: SETTINGS_FILE, ...extra } });
const postSettings = (base, overrides) =>
  fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides }) });

function runSettingsFile(code) {
  const context = vm.createContext({});
  vm.runInContext('var window = globalThis;', context);
  vm.runInContext(code, context);
  return JSON.parse(vm.runInContext('JSON.stringify({ settings: window.FAKE_SETTINGS, kept: window.KEPT })', context));
}

function rewrite(copy, rel, from, to) {
  const file = path.join(copy, rel);
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes(from), `${rel} has no ${from}`);
  fs.writeFileSync(file, src.replace(from, to));
}

const rebuild = (copy) => execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });

const LIST_API = { api: '/api/v1/documents', list: 'contents.list', value: 'id' };
const loginWithHeader = { ...appSettings('http://127.0.0.1:1').app.login, header: { Authorization: 'Bearer {token}' } };

const roleSettings = (server, roles = { ADMIN: 'duru-boss', AUDITOR: 'duru-auditor' }) => ({
  app: {
    ...appSettings(server).app,
    roles: Object.fromEntries(Object.entries(roles).map(([role, id]) => [role, { id, passwordEnv: id === 'duru-boss' ? ADMIN_PASSWORD_ENV : AUDITOR_PASSWORD_ENV }])),
  },
});

async function withPasswords(values, fn) {
  for (const [env, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[env];
    else process.env[env] = value;
  }
  try {
    return await fn();
  } finally {
    for (const env of Object.keys(values)) delete process.env[env];
  }
}

const withPassword = (value, fn) => withPasswords({ [PASSWORD_ENV]: value }, fn);
const ALL_PASSWORDS = { [PASSWORD_ENV]: 's3cret', [ADMIN_PASSWORD_ENV]: 'b0ss', [AUDITOR_PASSWORD_ENV]: 'aud1t' };

test('with app settings, the app is served logged in on its own address and its API requests go to the test server', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const data = await (await fetch(`${base}/api/data`)).json();
          assert.match(data.app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
          assert.notEqual(data.app.url, base);
          assert.equal(data.app.account, 'duru-admin');
          assert.equal(data.app.error, null);
          assert.equal(data.appLinks['/home#Home'], `${data.app.url}/home`);
          assert.equal(data.appLinks['/document/:id#DocumentDetail'], null);

          const html = await (await fetch(`${data.app.url}/home`)).text();
          assert.equal(await (await fetch(`${data.app.url}/app.js/nested`)).text(), html);
          assert.match(html, /<title>가짜 앱<\/title>/);
          assert.match(html, /FAKE_AUTH/);
          assert.match(html, /t-123/);
          const script = await fetch(`${data.app.url}/app.js`);
          assert.match(script.headers.get('content-type'), /javascript/);
          assert.match(await script.text(), /FAKE_AUTH/);

          const me = await fetch(`${data.app.url}/api/v1/me`, { headers: { authorization: 'Bearer t-123' } });
          assert.equal(me.status, 200);
          assert.deepEqual(await me.json(), { name: '두루 관리자' });

          const other = await new Promise((resolve) => {
            const { port } = new URL(data.app.url);
            http.get({ host: '127.0.0.1', port, path: '/home', headers: { host: 'evil.example.test' } }, (res) => resolve(res.statusCode));
          });
          assert.equal(other, 403);

          const page = await (await fetch(`${base}/`)).text();
          const map = fs.readFileSync(path.join(config.outDir, 'map.json'), 'utf8');
          for (const text of [JSON.stringify(data), html, page, map]) assert.ok(!text.includes('s3cret'));
        }),
      ),
    ),
  );
});

test('screens listed as signed out open on a second app address that never gets the token and clears it once on the sign-out path', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin'] } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app, appLinks } = await (await fetch(`${base}/api/data`)).json();
          const signedOut = new URL(app.signedOutUrl);
          assert.equal(signedOut.hostname, '127.0.0.1');
          assert.notEqual(signedOut.port, new URL(app.url).port);
          assert.equal(appLinks['/signin#SignIn'], `${app.signedOutUrl}/signin`);
          assert.equal(appLinks['/home#Home'], `${app.url}/home`);

          const html = await (await fetch(`${app.signedOutUrl}/signin`)).text();
          assert.match(html, /<title>가짜 앱<\/title>/);
          assert.doesNotMatch(html, /t-123/);
          assert.doesNotMatch(html, /removeItem/);

          const signOut = await (await fetch(`${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent('/signin')}`)).text();
          assert.match(signOut, /localStorage\.removeItem\("FAKE_AUTH"\)/);
          assert.match(signOut, /location\.replace\(location\.origin \+ "\/signin"\)/);
          for (const to of ['//evil.example.test', '/\\evil.example.test', 'javascript:alert(1)', 'http://[', '/.//evil.example.test', '/x/..//evil.example.test', '/%2e//evil.example.test']) {
            const offSite = await (await fetch(`${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent(to)}`)).text();
            assert.match(offSite, /location\.replace\(location\.origin \+ "\/"\)/, to);
          }

          const me = await fetch(`${app.signedOutUrl}/api/v1/me`, { headers: { authorization: 'Bearer t-123' } });
          assert.equal(me.status, 200);
        }),
      ),
    ),
  );
});

test('without signedOutPaths there is no signed-out address', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.equal(app.signedOutUrl, null);
          assert.deepEqual(app.unknownSignedOutPaths, []);
        }),
      ),
    ),
  );
});

test('signedOutPaths that match no screen path in the map are listed for the page', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin', '/signin/', '/login'] } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(app.unknownSignedOutPaths, ['/signin/', '/login']);
        }),
      ),
    ),
  );
});

test('when the password variable is missing or the login is refused, the page says why and the app is served without a token', async () => {
  await withFakeApi(async (api) => {
    await withPassword(undefined, () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const data = await (await fetch(`${base}/api/data`)).json();
          assert.match(data.app.error, new RegExp(PASSWORD_ENV));
          assert.doesNotMatch(await (await fetch(`${data.app.url}/home`)).text(), /FAKE_AUTH/);
        }),
      ),
    );
    await withPassword('wrong', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const data = await (await fetch(`${base}/api/data`)).json();
          assert.match(data.app.error, /401/);
          assert.ok(!data.app.error.includes('wrong'));
        }),
      ),
    );
  });
});

test('app files taken from a deployed address are served without the headers that forbid framing, with the token and the settings overrides put in', async () => {
  const build = path.join(FIXTURE, 'build');
  const deployed = http.createServer((req, res) => {
    const file = path.join(build, ['/app.js', '/settings.js'].includes(req.url) ? req.url.slice(1) : 'index.html');
    res.writeHead(200, {
      'content-type': file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => deployed.listen(0, '127.0.0.1', resolve));
  try {
    const files = `http://127.0.0.1:${deployed.address().port}`;
    await withFakeApi((api) =>
      withPassword('s3cret', () =>
        withRebuiltFixture(withSettingsFile(api, { files }), (config) =>
          withServer(config, 'reviewer', async (base) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const page = await fetch(`${app.url}/home`);
            assert.equal(page.headers.get('x-frame-options'), null);
            assert.equal(page.headers.get('content-security-policy'), null);
            assert.match(await page.text(), /FAKE_AUTH/);
            const script = await fetch(`${app.url}/app.js`);
            assert.match(script.headers.get('content-type'), /javascript/);
            assert.doesNotMatch(await script.text(), /t-123/);

            await postSettings(base, [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
            const settings = await (await fetch(`${app.url}/settings.js`)).text();
            assert.ok(settings.startsWith(fs.readFileSync(path.join(build, 'settings.js'), 'utf8')));
            assert.deepEqual(runSettingsFile(settings).settings, { SYSTEM: { HELP_LINK_ENABLED: true, LAB_ENABLED: true } });
          }),
        ),
      ),
    );
  } finally {
    deployed.closeAllConnections();
    deployed.close();
  }
});

test('each configured role is served logged in as its own account on an address of its own, logging in once however many pages load', async () => {
  await withFakeApi((api, presses, logins) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, signedOutPaths: ['/signin'] } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(app.roles.map(({ url, ...r }) => r), [
            { role: 'ADMIN', account: 'duru-boss', error: null },
            { role: 'AUDITOR', account: 'duru-auditor', error: null },
          ]);
          const urls = [app.url, app.signedOutUrl, ...app.roles.map((r) => r.url)];
          for (const url of urls) assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
          assert.equal(new Set(urls).size, urls.length);

          for (const [url, token] of [[app.url, 't-123'], [app.roles[0].url, 't-boss'], [app.roles[1].url, 't-audit']]) {
            for (let i = 0; i < 3; i += 1) {
              const html = await (await fetch(`${url}/admin/member`)).text();
              assert.match(html, new RegExp(token));
              assert.equal(Object.values(ACCOUNTS).filter((a) => html.includes(a.token)).length, 1);
            }
            const me = await fetch(`${url}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
            assert.equal(me.status, 200);
          }
          assert.deepEqual(logins.sort(), ['duru-admin', 'duru-auditor', 'duru-boss']);
        }),
      ),
    ),
  );
});

test('an account shared by the default and roles, or by several roles, logs in once', async () => {
  await withFakeApi((api, presses, logins) =>
    withPasswords(ALL_PASSWORDS, () => {
      const roles = {
        ADMIN: { id: 'duru-admin', passwordEnv: PASSWORD_ENV },
        OWNER: { id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV },
        MANAGER: { id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV },
      };
      return withRebuiltFixture({ app: { ...appSettings(api).app, roles } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(logins.sort(), ['duru-admin', 'duru-boss']);
          for (const [url, token] of [[app.roles[0].url, 't-123'], [app.roles[1].url, 't-boss'], [app.roles[2].url, 't-boss']]) {
            assert.match(await (await fetch(`${url}/home`)).text(), new RegExp(token));
          }
        }),
      );
    }),
  );
});

test('a role whose password variable is missing gets its own error while the other accounts log in', async () => {
  await withFakeApi((api) =>
    withPasswords({ ...ALL_PASSWORDS, [AUDITOR_PASSWORD_ENV]: undefined }, () =>
      withRebuiltFixture(roleSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.equal(app.error, null);
          assert.equal(app.roles[0].error, null);
          assert.match(app.roles[1].error, new RegExp(AUDITOR_PASSWORD_ENV));
          assert.match(await (await fetch(`${app.roles[0].url}/home`)).text(), /t-boss/);
          assert.doesNotMatch(await (await fetch(`${app.roles[1].url}/home`)).text(), /FAKE_AUTH/);
        }),
      ),
    ),
  );
});

const pathValueSettings = (api, pathValues) => ({ app: { ...appSettings(api).app, login: loginWithHeader, pathValues } });

const preparedFor = (config, pathValues, id) =>
  withServer({ ...config, app: { ...config.app, pathValues } }, 'reviewer', async (base) => {
    const res = await fetch(`${base}/api/path-values?screen=${encodeURIComponent(id)}`);
    return res.status === 200 ? res.json() : res.status;
  });

test('the path values of a screen come from its fixed values and from list APIs called with the login token, with the list screen to fall back to', async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: 'draft' }, '/document/:id': { id: LIST_API } };
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, pathValues), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const prepared = async (id) => (await fetch(`${base}/api/path-values?screen=${encodeURIComponent(id)}`)).json();
          assert.deepEqual(await prepared('/document/:tab_draft_done_#DocumentList'), {
            parts: ['/document', { name: 'tab', prefix: '/', optional: false, pattern: 'draft|done' }],
            values: { tab: 'draft' },
            errors: [],
            path: '/document/draft',
            fallback: '/home#Home', fallbackPath: '/home',
          });
          const detail = await prepared('/document/:id#DocumentDetail');
          assert.deepEqual(detail, {
            parts: ['/document', { name: 'id', prefix: '/', optional: false, pattern: null }],
            values: { id: '17' },
            errors: [],
            path: '/document/17',
            fallback: '/document/:tab_draft_done_#DocumentList', fallbackPath: '/document/draft',
          });
          assert.deepEqual(await prepared('/home#Home'), { parts: ['/home'], values: {}, errors: [], path: '/home', fallback: null, fallbackPath: null });
          const unknown = await fetch(`${base}/api/path-values?screen=${encodeURIComponent('/nowhere#Nowhere')}`);
          assert.equal(unknown.status, 404);

          const data = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(data.app.unknownPathValues, []);
          assert.equal(data.appLinks['/document/:id#DocumentDetail'], null);
          for (const text of [JSON.stringify(data), JSON.stringify(detail)]) assert.ok(!text.includes('t-123'));
        }),
      ),
    ),
  );
});

test('the path values of a screen asked for with a role come from list APIs called with that role\'s token', async () => {
  const pathValues = { '/document/:id': { id: LIST_API } };
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, pathValues } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const prepared = (query) => fetch(`${base}/api/path-values?screen=${encodeURIComponent('/document/:id#DocumentDetail')}${query}`);
          assert.deepEqual((await (await prepared('')).json()).values, { id: '17' });
          assert.deepEqual((await (await prepared('&role=ADMIN')).json()).values, { id: '27' });
          assert.deepEqual((await (await prepared('&role=AUDITOR')).json()).values, { id: '37' });
          assert.equal((await prepared('&role=OWNER')).status, 404);
        }),
      ),
    ),
  );
});

test('a list API that is empty, fails or answers in another shape is reported, and the screen falls back to its list screen', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, {}), async (config) => {
        const detail = (id) => preparedFor(config, { '/document/:id': { id } }, '/document/:id#DocumentDetail');
        const searched = await detail({ api: '/api/v1/documents/search', method: 'POST', body: { status: 'done' }, list: '', value: 'code' });
        assert.deepEqual([searched.values, searched.errors, searched.path], [{ id: 'done 1/2' }, [], '/document/done%201%2F2']);
        for (const [given, error] of [
          [{ ...LIST_API, api: '/api/v1/documents/empty' }, /^id: 목록 API GET \/api\/v1\/documents\/empty 가 빈 목록을 돌려주었습니다$/],
          [{ ...LIST_API, api: '/api/v1/documents/broken' }, /500 로 실패/],
          [{ ...LIST_API, api: '/api/v1/documents/text' }, /JSON 이 아닙니다/],
          [{ ...LIST_API, list: 'contents.items' }, /contents\.items 에 목록이 없습니다/],
          [{ ...LIST_API, value: 'uuid' }, /첫 항목에 uuid 값이 없습니다/],
        ]) {
          const result = await detail(given);
          assert.deepEqual([result.values, result.path, result.fallback], [{}, null, '/home#Home'], given.api);
          assert.equal(result.errors.length, 1);
          assert.match(result.errors[0], error);
        }
        assert.deepEqual(await preparedFor(config, {}, '/document/:id#DocumentDetail'), {
          parts: ['/document', { name: 'id', prefix: '/', optional: false, pattern: null }], values: {}, errors: [], path: null, fallback: '/home#Home', fallbackPath: '/home',
        });
        await withPassword('wrong', async () => {
          const result = await detail(LIST_API);
          assert.match(result.errors[0], /로그인하지 못해/);
        });
      }),
    ),
  );
});

test('pathValues entries that match no screen path, and variables their path does not have, are listed for the page', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, { '/document/:id': { id: '1', docId: '2' }, '/docs/:id': { id: '3' } }), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(app.unknownPathValues, ['/document/:id 의 docId', '/docs/:id']);
        }),
      ),
    ),
  );
});

test('the settings file is served with the posted overrides applied the way the app merges it, on every app address, and nothing else changes', async () => {
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api, { signedOutPaths: ['/signin'] }), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },", "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'], TITLE: 'Admin' },\n      USER: { LIST: ['DOCS'] },");
        rebuild(copy);
        await withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(app.settings, { root: 'globalSettings', merged: ['SYSTEM', 'CUSTOM'], overrides: [], file: { SYSTEM: { HELP_LINK_ENABLED: true } }, fileError: null });
          const fileText = fs.readFileSync(path.join(copy, 'build/settings.js'), 'utf8');
          assert.equal(await (await fetch(`${app.url}/settings.js`)).text(), fileText);

          const overrides = [
            { path: ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'], value: ['ADMIN_ARCHIVE'] },
            { path: ['SYSTEM', 'LAB_ENABLED'], value: true },
            { path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: false },
            { path: ['CUSTOM', 'THEME'], value: 'dark' },
          ];
          const res = await postSettings(base, overrides);
          assert.equal(res.status, 200);
          assert.deepEqual((await res.json()).overrides, overrides);
          assert.deepEqual((await (await fetch(`${base}/api/data`)).json()).app.settings.overrides, overrides);

          for (const url of [app.url, app.signedOutUrl]) {
            const served = await fetch(`${url}/settings.js`);
            assert.match(served.headers.get('content-type'), /javascript/);
            const text = await served.text();
            assert.ok(text.startsWith(fileText));
            assert.deepEqual(runSettingsFile(text).settings, {
              SYSTEM: {
                HELP_LINK_ENABLED: false,
                LAB_ENABLED: true,
                MAIN_MENU: { ADMIN: { LIST: ['ADMIN_ARCHIVE'], TITLE: 'Admin' }, USER: { LIST: ['DOCS'] } },
              },
              CUSTOM: { THEME: 'dark' },
            });
          }
          assert.equal(await (await fetch(`${app.url}/app.js`)).text(), fs.readFileSync(path.join(copy, 'build/app.js'), 'utf8'));
          assert.doesNotMatch(await (await fetch(`${app.url}/home`)).text(), /ADMIN_ARCHIVE/);

          fs.writeFileSync(path.join(copy, 'build/settings.js'), "window.FAKE_SETTINGS = { SYSTEM: { MAIN_MENU: { ADMIN: { LIST: ['FROM_FILE'] } } } };\nwindow.KEPT = window.FAKE_SETTINGS.SYSTEM.MAIN_MENU;\n");
          const list = ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'];
          await postSettings(base, [{ path: list, item: 'ADMIN_REPORT', value: true }, { path: list, item: 'FROM_FILE', value: false }, { path: list, item: 'ADMIN_ARCHIVE', value: true }]);
          const fromFile = runSettingsFile(await (await fetch(`${app.url}/settings.js`)).text());
          assert.deepEqual(fromFile.settings.SYSTEM.MAIN_MENU, { ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] } });
          assert.deepEqual(fromFile.kept, { ADMIN: { LIST: ['FROM_FILE'] } });

          fs.rmSync(path.join(copy, 'build/settings.js'));
          await postSettings(base, [{ path: ['SYSTEM', 'MAIN_MENU', 'USER', 'LIST'], item: 'REPORTS', value: true }]);
          assert.deepEqual(runSettingsFile(await (await fetch(`${app.url}/settings.js`)).text()).settings, {
            SYSTEM: { MAIN_MENU: { ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'], TITLE: 'Admin' }, USER: { LIST: ['DOCS', 'REPORTS'] } } },
          });

          await postSettings(base, []);
          assert.equal(await (await fetch(`${app.url}/settings.js`)).text(), '');
          assert.deepEqual(requests, ['POST /auth/login']);
        });
      }),
    ),
  );
});

test('settings overrides that are not JSON, not a list, or reach outside the sections the app merges are refused and change nothing', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', async () => {
      await withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const notJson = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"overrides":[]}' });
          assert.equal(notJson.status, 415);
          for (const [overrides, message] of [
            ['SYSTEM.LAB_ENABLED', /not a list/],
            [[{ path: ['DISPLAY', 'PAGE_SIZE'], value: 50 }], /section DISPLAY/],
            [[{ path: ['SYSTEM'], value: {} }], /section and a key/],
            [[{ path: ['SYSTEM', 'LAB_ENABLED'] }], /LAB_ENABLED/],
            [[{ path: ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'], item: 'ADMIN_REPORT', value: 'yes' }], /list item/],
            [[{ path: ['SYSTEM', 'LAB_ENABLED'], value: true, root: 'globalSettings' }], /LAB_ENABLED/],
            [[{ path: ['SYSTEM', '__proto__', 'polluted'], value: true }], /__proto__/],
            [[{ path: ['SYSTEM', 'constructor', 'prototype', 'polluted'], value: true }], /constructor/],
            [[{ path: ['SYSTEM', 'MAIN_MENU', 'prototype'], value: true }], /prototype/],
          ]) {
            const res = await postSettings(base, overrides);
            assert.equal(res.status, 400, JSON.stringify(overrides));
            assert.match(await res.text(), message);
          }
          assert.deepEqual((await (await fetch(`${base}/api/data`)).json()).app.settings.overrides, []);
        }),
      );
      await withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          assert.equal((await (await fetch(`${base}/api/data`)).json()).app.settings, null);
          const res = await postSettings(base, [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
          assert.equal(res.status, 400);
          assert.match(await res.text(), /app\.settingsFile is not set/);
        }),
      );
    }),
  );
});

test('a settingsFile root without settingsDefaults is rejected, since the defaults the file is merged over are unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    const config = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8'));
    const app = { ...appSettings('http://127.0.0.1:1').app, settingsFile: { ...SETTINGS_FILE, root: 'appSettings' } };
    fs.writeFileSync(file, JSON.stringify({ ...config, settingsRoots: ['globalSettings', 'appSettings'], app }));
    assert.throws(() => loadConfig(file), /app\.settingsFile\.root "appSettings" has no settingsDefaults entry/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the page gets what the settings file sets in the merged sections, without the overrides, or why the file could not be run', async () => {
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config, copy) =>
        withServer(config, 'reviewer', async (base) => {
          const settingsOf = async () => (await (await fetch(`${base}/api/data`)).json()).app.settings;
          const writeFile = (text) => fs.writeFileSync(path.join(copy, 'build/settings.js'), text);
          await postSettings(base, [{ path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: false }]);
          assert.deepEqual(await settingsOf(), {
            root: 'globalSettings',
            merged: ['SYSTEM', 'CUSTOM'],
            overrides: [{ path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: false }],
            file: { SYSTEM: { HELP_LINK_ENABLED: true } },
            fileError: null,
          });

          writeFile("window.FAKE_SETTINGS = { SYSTEM: { A: 1, F: () => 1 }, CUSTOM: { B: 'x' }, DISPLAY: { C: 2 } };\nwindow.OTHER = 1;\n");
          assert.deepEqual((await settingsOf()).file, { SYSTEM: { A: 1 }, CUSTOM: { B: 'x' } });

          writeFile("throw new Error('boom');\n");
          const thrown = await settingsOf();
          assert.equal(thrown.file, null);
          assert.match(thrown.fileError, /설정 파일.*boom/);

          writeFile('while (true) {}\n');
          const endless = await settingsOf();
          assert.equal(endless.file, null);
          assert.match(endless.fileError, /설정 파일/);

          fs.rmSync(path.join(copy, 'build/settings.js'));
          assert.deepEqual((await settingsOf()).file, {});
          assert.deepEqual(requests, ['POST /auth/login']);
        }),
      ),
    ),
  );
});

test('a change inside a default the source does not show in full is refused unless the settings file sets that key, while replacing the whole key is allowed', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },", "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },\n      USER: window.INTO_USER_MENU || {},");
        rebuild(copy);
        await withServer(config, 'reviewer', async (base) => {
          const list = ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'];
          for (const overrides of [[{ path: list, item: 'ADMIN_REPORT', value: false }], [{ path: list, value: [] }]]) {
            const res = await postSettings(base, overrides);
            assert.equal(res.status, 400);
            assert.match(await res.text(), /SYSTEM\.MAIN_MENU.*not read in full/);
          }
          assert.equal((await postSettings(base, [{ path: ['SYSTEM', 'MAIN_MENU'], value: { ADMIN: { LIST: [] } } }])).status, 200);
          assert.equal((await postSettings(base, [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }])).status, 200);

          fs.writeFileSync(path.join(copy, 'build/settings.js'), "window.FAKE_SETTINGS = { SYSTEM: { MAIN_MENU: { ADMIN: { LIST: ['ADMIN_REPORT'] } } } };\n");
          assert.equal((await postSettings(base, [{ path: list, item: 'ADMIN_REPORT', value: false }])).status, 200);
        });
      }),
    ),
  );
});

test('the code put after the settings file never writes through __proto__, constructor or prototype', () => {
  const context = vm.createContext({});
  vm.runInContext('var window = globalThis;', context);
  const overrides = [
    { path: ['SYSTEM', '__proto__', 'polluted'], value: true },
    { path: ['__proto__', 'polluted'], value: true },
    { path: ['SYSTEM', 'constructor', 'prototype', 'polluted'], value: true },
    { path: ['SYSTEM', 'LAB_ENABLED'], value: true },
  ];
  vm.runInContext(`(${applyOverrides})(['__proto__', 'FAKE_SETTINGS'], {}, ${JSON.stringify(overrides)});`, context);
  vm.runInContext(`(${applyOverrides})(['FAKE_SETTINGS'], {}, ${JSON.stringify(overrides)});`, context);
  assert.equal(vm.runInContext('({}).polluted', context), undefined);
  assert.equal(vm.runInContext('Object.prototype.polluted', context), undefined);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(window.FAKE_SETTINGS)', context)), { SYSTEM: { LAB_ENABLED: true } });
});

for (const signedOutPaths of [[], ['/signin']]) {
  test(`the app server closes with the review server, with signedOutPaths ${JSON.stringify(signedOutPaths)}`, async () => {
    await withFakeApi((api) =>
      withPassword('s3cret', () =>
        withRebuiltFixture({ app: { ...roleSettings(api).app, signedOutPaths } }, async (config) => {
          const server = await startReviewServer(config, { author: 'reviewer' });
          let app;
          try {
            ({ app } = await (await fetch(`http://127.0.0.1:${server.address().port}/api/data`)).json());
          } finally {
            await new Promise((resolve) => server.close(resolve));
          }
          assert.equal(Boolean(app.signedOutUrl), signedOutPaths.length > 0);
          const refused = (err) => err.cause?.code === 'ECONNREFUSED';
          await assert.rejects(fetch(`${app.url}/home`), refused);
          if (app.signedOutUrl) await assert.rejects(fetch(`${app.signedOutUrl}/signin`), refused);
          assert.equal(app.roles.length, 2);
          for (const r of app.roles) await assert.rejects(fetch(`${r.url}/home`), refused);
        }),
      ),
    );
  });
}

for (const [name, broken, message] of [
  ['no files', { files: undefined }, /app\.files/],
  ['a server that is not an address', { server: 'not a url' }, /app\.server/],
  ['apiPaths that is not a list', { apiPaths: '/api/' }, /app\.apiPaths/],
  ['a login without body, token and storage', { login: { path: '/auth/login' } }, /app\.login/],
  ['the password itself in the account', { account: { id: 'duru-admin', password: 's3cret' } }, /app\.account/],
  ['signedOutPaths that is not a list of paths', { signedOutPaths: 'signin' }, /app\.signedOutPaths/],
  ['roles that is a list', { roles: [{ id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV }] }, /app\.roles must be/],
  ['a role without passwordEnv', { roles: { ADMIN: { id: 'duru-boss' } } }, /app\.roles\.ADMIN must be/],
  ['the password itself in a role', { roles: { ADMIN: { id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV, password: 's3cret' } } }, /app\.roles\.ADMIN must be/],
  ['pathValues that is not a map of route paths', { pathValues: ['/document/:id'] }, /app\.pathValues must/],
  ['a pathValues key that is not a route path', { pathValues: { 'document/:id': { id: '1' } } }, /app\.pathValues key "document\/:id" must be a route path/],
  ['a path variable given a number', { pathValues: { '/document/:id': { id: 17 } } }, /app\.pathValues\["\/document\/:id"\]\.id must/],
  ...[
    ['without the value to take', { value: undefined }],
    ['whose address is not a path', { api: 'http://127.0.0.1:1/api/v1/documents' }],
    ['with a list that is not a dotted path', { list: 7 }],
    ['with a body but no method', { body: { status: 'draft' } }],
    ['with a key it does not know', { headers: {} }],
  ].map(([name, change]) => [`a list API ${name}`, { login: loginWithHeader, pathValues: { '/document/:id': { id: { ...LIST_API, ...change } } } }, /app\.pathValues\["\/document\/:id"\]\.id must/]),
  ['a list API without login.header', { pathValues: { '/document/:id': { id: LIST_API } } }, /app\.login\.header/],
  ['a login header that is not a map of header names', { login: { ...loginWithHeader, header: ['Bearer s3cret'] } }, /app\.login\.header/],
  ['a settingsFile without merged sections', { settingsFile: { ...SETTINGS_FILE, merged: [] } }, /app\.settingsFile must be/],
  ['a settingsFile path that is not absolute', { settingsFile: { ...SETTINGS_FILE, path: 'settings.js' } }, /app\.settingsFile must be/],
  ['a settingsFile global that is not a dotted name', { settingsFile: { ...SETTINGS_FILE, global: "window['FAKE_SETTINGS']" } }, /app\.settingsFile must be/],
  ['a settingsFile root that is not a settings root', { settingsFile: { ...SETTINGS_FILE, root: 'appSettings' } }, /app\.settingsFile\.root "appSettings" is not listed in settingsRoots/],
]) {
  test(`app settings with ${name} are rejected`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
    try {
      const file = path.join(dir, 'config.json');
      const app = { ...appSettings('http://127.0.0.1:1').app, ...broken };
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), app }));
      assert.throws(() => loadConfig(file), (err) => message.test(err.message) && !err.message.includes('s3cret'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a list API answering with bare values is accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    const app = { ...appSettings('http://127.0.0.1:1').app, login: loginWithHeader, pathValues: { '/document/:id': { id: { ...LIST_API, list: '', value: '' } } } };
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), app }));
    assert.equal(loadConfig(file).app.pathValues['/document/:id'].id.value, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the page reports a missing map instead of serving empty data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), outDir: 'nowhere' }));
    await withServer(loadConfig(configFile), 'reviewer', async (base) => {
      const res = await fetch(`${base}/api/data`);
      assert.equal(res.status, 500);
      assert.match(await res.text(), /run "duru rebuild" first/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the flow grown from one screen is served for that screen, and an unknown screen is not found', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const res = await fetch(`${base}/api/flow?from=${encodeURIComponent('/document/:tab_draft_done_#DocumentList')}`);
      assert.equal(res.status, 200);
      const { roots } = await res.json();
      assert.deepEqual([roots[0].id, ...roots[0].children.map((c) => c.id)], ['/document/:tab_draft_done_#DocumentList', '/document/:id#DocumentDetail', '/admin/report#AdminReport']);
      assert.equal((await fetch(`${base}/api/flow?from=${encodeURIComponent('/nowhere#Nowhere')}`)).status, 404);
    }),
  );
});

test('requests another site could send through the browser are refused', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const plain = await fetch(`${base}/api/marks`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ target: { node: '/lab#Lab' }, status: 'fine' }) });
      assert.equal(plain.status, 415);

      const port = new URL(base).port;
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/data', headers: { host: `attacker.example:${port}` } }, (res) => resolve(res.statusCode)).on('error', reject);
      });
      assert.equal(status, 403);
      assert.equal(fs.existsSync(config.marksDir), false);
    }),
  );
});

test('the end request asks the caller to get ready, is answered, and then tells the caller to finish, and an end request that is not JSON is refused', async () => {
  await withRebuiltFixture({}, async (config) => {
    let done;
    const ended = new Promise((resolve) => (done = resolve));
    const server = await startReviewServer(config, { author: 'reviewer', onDone: () => done });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const plain = await fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(plain.status, 415);
      const signalled = await Promise.race([ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 100))]);
      assert.equal(signalled, false);
      assert.equal((await fetch(`${base}/`)).status, 200);

      const res = await fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 200);
      assert.equal(await Promise.race([ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]), true);
    } finally {
      server.close();
    }
  });
});

const browserMissing = fs.existsSync(chromium.executablePath()) ? false : 'Chromium is not installed (npx playwright-core install chromium)';

const toList = async (p) => {
  await p.waitForSelector('#view-flow.on');
  await p.click('#view-list');
};

async function withPage(base, fn, { view = 'list', setup } = {}) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    if (setup) await setup(page);
    await page.goto(base);
    if (view === 'list') await toList(page);
    await fn(page, errors);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

const untaggedTab = '#left .views.side button:has-text("태그 없음")';

test('in a browser, the header shows the author as text with no field, and a mark saved on the page is signed with the config author even when git has a name', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ author: '설정 이름' }, (config, copy) => {
    initGitRepoNamed(copy, 'Git 이름');
    return withServer(config, undefined, (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent('#author'), '작성자 설정 이름');
        assert.equal(await p.textContent('#author strong'), '설정 이름');
        assert.equal(await p.locator('header input').count(), 0);
        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await openHistory(p);
        await p.waitForSelector('#right .history li:has-text("설정 이름")');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => m.author), ['설정 이름']);
      }),
    );
  });
});

for (const host of ['127.0.0.1', 'localhost']) {
  test(`in a browser at ${host}, the list filters screens, a mark is saved as a file and is there after reloading`, { skip: browserMissing }, async () => {
    await withRebuiltFixture({}, (config) =>
      withServer(config, 'reviewer', (base) =>
        withPage(base.replace('127.0.0.1', host), async (p) => {
          await p.waitForSelector('#screen-list li');
          assert.equal(await p.locator('#screen-list li').count(), 11);
          assert.match(await p.textContent('#author'), /reviewer/);

          await p.fill('#left input[type=search]', 'lab');
          assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/lab', '/lab/result']);
          await p.fill('#left input[type=search]', '');
          await p.check('#left input[name=no-tests]');
          const noTests = await p.locator('#screen-list li').allTextContents();
          assert.ok(noTests.length > 0 && noTests.every((t) => t.includes('테스트 없음')));
          await p.uncheck('#left input[name=no-tests]');

          await p.click('#screen-list li:has-text("/document/:id")');
          assert.equal(await p.textContent('#center h3'), '/document/:id');
          await p.click('#center tr:has-text("API")');
          assert.match(await p.locator('#right h2', { hasText: '표시 —' }).textContent(), /API 깊이/);
          assert.equal(await p.isDisabled('#right button.save'), true);
          await p.click('#right .statuses button:has-text("더 필요")');
          await p.fill('#right textarea', 'no API test yet');
          await p.click('#right button.save');
          await openHistory(p);
          await p.waitForSelector('#right .history li:has-text("no API test yet")');
          assert.match(await p.textContent('#center tr.selected td.mark'), /더 필요/);
          assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status, m.note, m.author]), [
            [{ node: '/document/:id#DocumentDetail', depth: 'api' }, 'needs-more', 'no API test yet', 'reviewer'],
          ]);

          await p.click('#center tr:has-text("화면 전체")');
          await p.click('#right .statuses button:has-text("충분")');
          await p.click('#right button.save');
          await p.waitForSelector('#screen-list li.selected .chip');
          assert.equal(await p.textContent('#screen-list li.selected .chip'), '충분');

          await p.reload();
          await toList(p);
          await p.click('#screen-list li:has-text("/document/:id")');
          await p.click('#center tr:has-text("API")');
          assert.ok((await p.locator('#right .history li').allTextContents()).some((t) => t.includes('no API test yet')));

          await p.emulateMedia({ colorScheme: 'dark' });
          assert.notEqual(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
        }),
      ),
    );
  });
}

test('in a browser, drawing the screens side again keeps the search box and its filtering, and draws the 「떨어져 나감」 block once with the marks read again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const search = '#left input[type=search]';
        const detachedHeadings = () => p.locator('#left h2:has-text("떨어져 나감")').allTextContents();
        assert.deepEqual(await detachedHeadings(), ['떨어져 나감 0']);
        await p.fill(search, 'lab');
        await p.$eval(search, (el) => { el.kept = true; });
        await postMark(base, { target: { node: '/gone#Gone' }, status: 'missing' });
        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#right .statuses button:has-text("충분")');
        await p.click('#right button.save');
        await p.waitForSelector('#screen-list li.selected .chip');
        assert.equal(await p.$eval(search, (el) => el.kept), true);
        assert.equal(await p.inputValue(search), 'lab');
        assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/lab', '/lab/result']);
        assert.deepEqual(await detachedHeadings(), ['떨어져 나감 1']);
        assert.deepEqual(await p.locator('#left .detached li code').allTextContents(), ['/gone#Gone']);
      })));
});

test('a map.json built before links carried their conditions leaves the stories out with a message asking to rebuild apart from the story file notes, keeps the marks on stories attached, and the rest of the data and the task list still work', async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) for (const l of s.links) delete l.conditions;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    addMark(config.marksDir, { target: { story: 'run-lab' }, status: 'missing', author: 'a' }, new Date('2026-10-03T01:00:00Z'));
    await withServer(config, 'reviewer', async (base) => {
      const res = await fetch(`${base}/api/data`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.stories.list.length, 0);
      assert.deepEqual(data.stories.notices.map((n) => n.file), ['lab-shortcut.json']);
      assert.ok(data.stories.stale.startsWith(`${mapFile} 은 `));
      assert.match(data.stories.stale, /duru rebuild 로 맵을 다시 만드세요$/);
      assert.equal(data.map.screens.length, map.screens.length);
      assert.deepEqual([data.marks.attached.map((m) => m.key), data.marks.detached], [['story(run-lab)'], []]);
    });
    const tasks = taskList(config);
    assert.match(tasks, /^# Test tasks — 0 screens, 0 calls, 1 story, 1 open mark\n/);
    assert.equal(tasks.slice(tasks.indexOf('\n# Stories\n')), [
      '',
      '# Stories',
      '',
      'Story files are in `example-stories`.',
      '',
      'The map was built by a duru older than stories, so these stories are not checked against it. Run `duru rebuild` and read this list again.',
      '',
      '## run-lab',
      '',
      '- marks:',
      '  - missing (a, 2026-10-03)',
      '',
    ].join('\n'));
  });
});

test('a mark on a story is saved through the page, and one on a story ID outside the ID rule is refused', async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      assert.equal((await postMark(base, { target: { story: 'run-lab' }, status: 'missing', note: 'walk it' })).status, 201);
      const refused = await postMark(base, { target: { story: '../run-lab' }, status: 'missing' });
      assert.equal(refused.status, 400);
      assert.equal((await postMark(base, { target: { story: 'run-lab', depth: 'ui' }, status: 'missing' })).status, 400);
      const data = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.map((m) => [m.key, m.target, m.current.note, m.current.author]), [['story(run-lab)', { story: 'run-lab' }, 'walk it', 'reviewer']]);
    }),
  );
});

test('in a browser, a map.json built before links carried their conditions shows the request to rebuild instead of the empty story list, and does not count it as an unreadable story file', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) for (const l of s.links) delete l.conditions;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.match(await p.textContent('#left'), /duru rebuild 로 맵을 다시 만드세요/);
        assert.doesNotMatch(await p.textContent('#left'), /스토리 파일이 없습니다/);
        assert.equal(await p.locator('#story-list li').count(), 0);
        assert.equal(await p.locator('#left .notices li').count(), 1);
        assert.equal(await p.textContent('#left .notices li code'), 'lab-shortcut.json');
        assert.match(await p.textContent('#left'), /읽지 못한 스토리 파일 1/);
      }),
    );
  });
});

test('in a browser, the three left tabs stay on one line inside the column, also with three-digit counts and a classic scrollbar', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let counts = { screens: 11, stories: 5 };
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          const grow = (list, n) => Array.from({ length: n }, (_, i) => list[i % list.length]);
          data.map.screens = grow(data.map.screens, counts.screens);
          data.stories.list = grow(data.stories.list, counts.stories);
          if (counts.untagged !== undefined) {
            delete data.tests.untagged;
            data.tests.untaggedCount = counts.untagged;
          }
          await route.fulfill({ response: res, json: data });
        });
        const measure = () => p.evaluate(() => {
          const left = document.getElementById('left');
          const row = left.querySelector('.views.side');
          const probe = row.cloneNode(true);
          probe.style.cssText = 'position: absolute; visibility: hidden; width: 1000px';
          for (const b of [...probe.children].slice(1)) b.remove();
          probe.querySelector('.tab-name').textContent = '가';
          probe.querySelector('.tab-count').textContent = '1';
          left.append(probe);
          const oneLine = probe.firstElementChild.getBoundingClientRect().height;
          probe.remove();
          const middle = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
          const tabs = [...row.children];
          return {
            heights: tabs.map((b) => b.getBoundingClientRect().height),
            oneLine,
            drop: tabs.map((b) => Math.abs(middle(b.querySelector('.tab-name')) - middle(b.querySelector('.tab-count')))),
            inside: tabs.map((b) => {
              const box = b.getBoundingClientRect();
              const name = b.querySelector('.tab-name').getBoundingClientRect();
              const count = b.querySelector('.tab-count').getBoundingClientRect();
              const edge = b.clientLeft + parseFloat(getComputedStyle(b).paddingLeft);
              return name.left >= box.left + edge - 0.5 && name.right <= count.left && count.right <= box.right - edge + 0.5;
            }),
            cut: tabs.map((b) => {
              const name = b.querySelector('.tab-name');
              const text = document.createRange();
              text.selectNodeContents(name);
              return name.getBoundingClientRect().width < text.getBoundingClientRect().width - 0.1;
            }),
            labels: tabs.map((b) => b.textContent),
            rowScroll: [row.scrollWidth, row.clientWidth],
            leftScroll: [left.scrollWidth, left.clientWidth],
          };
        });
        const assertFits = (m, why) => {
          assert.deepEqual(m.heights, Array(3).fill(m.oneLine), `${why}: every tab is as tall as a one-line tab`);
          assert.ok(m.drop.every((d) => d <= 3), `${why}: each count stays beside its name ${m.drop}`);
          assert.deepEqual(m.inside, Array(3).fill(true), `${why}: name and count stay inside their tab's padding`);
          assert.ok(m.rowScroll[0] <= m.rowScroll[1], `${why}: row ${m.rowScroll[0]} fits in ${m.rowScroll[1]}`);
          assert.ok(m.leftScroll[0] <= m.leftScroll[1], `${why}: left column ${m.leftScroll[0]} does not scroll sideways in ${m.leftScroll[1]}`);
        };
        const show = async (c) => {
          counts = c;
          await p.reload();
          await toList(p);
          await p.waitForSelector('#screen-list li');
        };

        const scrollbar = () => p.addStyleTag({ content: '#left { padding-right: 31px !important; }' });

        await show({ screens: 11, stories: 5 });
        let m = await measure();
        assert.deepEqual(m.labels, ['화면 11', '스토리 5', '태그 없음 13']);
        assert.deepEqual(m.cut, [false, false, false]);
        assertFits(m, 'default counts');

        await show({ screens: 111, stories: 5, untagged: 999 });
        m = await measure();
        assert.deepEqual(m.labels, ['화면 111', '스토리 5', '태그 없음 999']);
        assert.deepEqual(m.cut, [false, false, false]);
        assertFits(m, 'three-digit counts');

        await show({ screens: 111, stories: 5, untagged: 999 });
        await scrollbar();
        m = await measure();
        assert.deepEqual(m.cut, [false, false, false]);
        assertFits(m, 'three-digit counts with a classic scrollbar');

        await show({ screens: 111, stories: 111, untagged: 999 });
        await scrollbar();
        await p.click('#left .views.side button:nth-child(3)');
        assertFits(await measure(), 'three-digit counts on every tab, a classic scrollbar and the widest tab chosen');
      })));
});

test('in a browser, the story list sits next to the screen list, and a chosen story shows its screens in order with each link\'s verdict and what it takes to get to the end', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.deepEqual(await p.locator('#left .views.side button').allTextContents(), ['화면 11', '스토리 5', '태그 없음 13']);
        assert.deepEqual(await p.locator('#left .views.side .tab-name').allTextContents(), ['화면', '스토리', '태그 없음']);
        assert.deepEqual(await p.locator('#left .views.side .tab-count').allTextContents(), ['11', '5', '13']);
        assert.equal(await p.getAttribute(untaggedTab, 'title'), '노드 태그도 스토리 태그도 없는 테스트');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.deepEqual(await p.locator('#story-list li .name > span:first-child').allTextContents(), [
          '홈에서 개인 설정을 바꾼다', '홈에서 바로 도움말을 연다', '로그인해 문서 목록에서 문서를 연다', '관리자가 보고서를 본다', '실험실을 열어 결과를 본다',
        ]);
        assert.deepEqual(await p.locator('#story-list li').evaluateAll((items) => items.map((li) => [...li.querySelectorAll('.chip')].map((c) => c.textContent))), [
          ['일부 화면만 테스트', '화면 없음'], ['보류', '링크 없음'], [], ['테스트 없음'], ['실패'],
        ]);
        assert.equal(await p.locator('#story-list li:has-text("개인 설정") .chip.l-off-map').getAttribute('title'), '맵에서 찾을 수 없는 화면: /settings#Settings');
        assert.match(await p.textContent('#left .notices'), /lab-shortcut\.json.*screens 는/);

        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.textContent('#center h3'), '실험실을 열어 결과를 본다');
        assert.match(await p.textContent('#center .memo'), /고객사 설정/);
        assert.deepEqual(await p.locator('#center .story-path .step .name > span:first-child').allTextContents(), ['/home', '/lab', '/lab/result']);
        assert.deepEqual(await p.locator('#center .story-path .link > .chip').allTextContents(), ['조건', '이어짐']);
        assert.match(await p.textContent('#center .story-path .link.l-conditioned'), /components\/Home\.js:19\s*globalSettings\.SYSTEM\.LAB_ENABLED\s*설정/);
        assert.deepEqual(await p.locator('#right-info > *').evaluateAll((els) => els.slice(0, 2).map((e) => e.textContent)), ['도달 가능', '사전 조건']);
        assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트']);
        assert.match(await p.textContent('#right .reach-link'), /components\/Home\.js:19/);
        assert.match(await p.textContent('#right .reach-route'), /Routes\.js:44.*globalSettings\.SYSTEM\.LAB_ENABLED/);
        assert.equal(await p.locator('#center iframe').count(), 0);

        await p.click('#story-list li:has-text("도움말")');
        assert.deepEqual(await p.locator('#center .story-path .link > .chip').allTextContents(), ['이어짐', '링크 없음']);
        assert.equal(await p.textContent('#center .story-path .link.l-broken'), '링크 없음');
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 불가 · 링크 없음 1곳']);

        await p.click('#story-list li:has-text("개인 설정")');
        assert.equal(await p.textContent('#center .story-path .step.off-map .chip'), '맵에 없는 화면');
        assert.deepEqual(await p.locator('#center .story-path .link > .chip').allTextContents(), ['판정 못 함']);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['판정 못 함 · 화면 없음']);

        await p.click('#story-list li:has-text("문서를 연다")');
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 가능']);
        assert.equal(await p.textContent('#right-info > p.muted'), '조건 없음');
        await p.click('#center .story-path .step:has-text("/document/:id")');
        assert.equal(await p.getAttribute('#left .views.side button.on', 'class'), 'on');
        assert.equal(await p.textContent('#left .views.side button.on'), '화면 11');
        assert.equal(await p.textContent('#center h3'), '/document/:id');
        assert.match(await p.textContent('#screen-list li.selected'), /\/document\/:id/);

        await p.click('#left .views.side button:has-text("스토리")');
        assert.equal(await p.textContent('#story-list li.selected .name > span:first-child'), '로그인해 문서 목록에서 문서를 연다');

        await p.click('#view-flow');
        await (await screenBox(p, '/lab/result#LabResult')).click();
        await p.waitForSelector('main:not([hidden])');
        assert.equal(await p.textContent('#left .views.side button.on'), '화면 11');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
      }),
    ),
  );
});

test('in a browser, the story list shows only the statuses that need a look, filters by 테스트 없음, 일부 화면만 테스트, 실패 and 링크 없음, and a chosen story shows its status, its story tests and the tests on each screen by depth and status', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.equal(await p.getAttribute('#story-list li:has-text("보고서") .chip', 'title'), '스토리 테스트도, 경로의 화면에 붙은 테스트도 없습니다');

        const ids = () => p.locator('#story-list li .name .mono').allTextContents();
        assert.deepEqual(await p.locator('#left .filters legend').allTextContents(), ['상태 · 하나라도 맞으면', '그리고']);
        assert.deepEqual(await p.locator('#left .filters fieldset').evaluateAll((els) => els.map((e) => [...e.querySelectorAll('label')].map((l) => l.textContent))),
          [['테스트 없음', '일부 화면만 테스트', '실패'], ['링크 없음']]);
        await p.check('#left input[name=untested]');
        assert.deepEqual(await ids(), ['read-reports']);
        await p.check('#left input[name=partial]');
        assert.deepEqual(await ids(), ['change-settings', 'read-reports']);
        await p.check('#left input[name=broken]');
        assert.deepEqual(await ids(), []);
        assert.equal(await p.textContent('#story-list li.muted'), '해당하는 스토리가 없습니다.');
        await p.uncheck('#left input[name=untested]');
        await p.uncheck('#left input[name=partial]');
        assert.deepEqual(await ids(), ['help-from-home']);
        await p.check('#left input[name=fail]');
        assert.deepEqual(await ids(), []);
        await p.uncheck('#left input[name=broken]');
        assert.deepEqual(await ids(), ['run-lab']);

        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['실패']);
        assert.equal(await p.textContent('#center .story-tests h2'), '스토리 테스트 2');
        assert.deepEqual(await p.locator('#center .story-tests .test').evaluateAll((items) => items.map((t) => [...t.querySelectorAll('.depth, .chip')].map((e) => e.textContent))), [
          ['API', '실패'], ['API', '통과'],
        ]);
        assert.match(await p.locator('#center .story-tests .test').first().textContent(), /Lab flow › runs the lab and reads the result @story:run-lab/);
        const stepTests = () => p.locator('#center .story-path .step').evaluateAll((steps) => steps.map((s) => [...s.querySelectorAll('.step-tests > span')].map((e) => e.textContent.trim())));
        assert.deepEqual(await stepTests(), [['UI/E2E ✓2', 'API ✓1 ○1', '렌더링만 ✕1', '코드 ✓1', '데이터 ✕1'], ['UI/E2E ○1', '코드 ○1'], ['화면 테스트 없음']]);
        assert.match(await p.getAttribute('#center .story-path .step:nth-child(3) .step-tests > span:first-child', 'title'), /opens the lab @screen:\/lab#Lab/);

        await p.uncheck('#left input[name=fail]');
        assert.equal((await ids()).length, 5);
        await p.click('#story-list li:has-text("문서를 연다")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['통과']);
        assert.deepEqual(await stepTests(), [['UI/E2E ✓1', '코드 ✓1'], ['UI/E2E ✓2', 'API ✓1 ○1', '렌더링만 ✕1', '코드 ✓1', '데이터 ✕1'], ['API ✓1 ✕2 ○1', '데이터 ○4'], ['UI/E2E ✓1', 'API ✓3 ✕3', '데이터 ✓2 ○2']]);

        await p.click('#story-list li:has-text("보고서")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['테스트 없음']);
        assert.equal(await p.textContent('#center .story-tests h2'), '스토리 테스트 0');
        assert.deepEqual(await stepTests(), [['화면 테스트 없음']]);
      }),
    ),
  );
});

test('in a browser, a chosen story takes marks that are saved as files and kept as its history, and once its story file is gone the mark shows as detached under the stories', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await p.locator('#right h2').allTextContents(), ['사전 조건', '표시 — 스토리']);
        assert.equal(await p.isDisabled('#right button.save'), true);
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right textarea', 'no test walks the lab');
        await p.click('#right button.save');
        await openHistory(p);
        await p.waitForSelector('#right .history li:has-text("no test walks the lab")');
        await p.click('#right .statuses button:has-text("더 필요")');
        await p.fill('#right textarea', 'the story test fails');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("the story test fails")');
        assert.deepEqual(await p.locator('#right .history li .chip').allTextContents(), ['더 필요', '없음']);
        assert.equal(await p.textContent('#story-list li.selected .chip.needs-more'), '더 필요');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status, m.note, m.author]).sort((a, b) => a[1].localeCompare(b[1])), [
          [{ story: 'run-lab' }, 'missing', 'no test walks the lab', 'reviewer'],
          [{ story: 'run-lab' }, 'needs-more', 'the story test fails', 'reviewer'],
        ]);
        assert.equal(fs.readdirSync(path.join(config.marksDir, 'stories', 'run-lab')).length, 2);

        await p.click('#story-list li:has-text("보고서")');
        assert.equal(await p.locator('#right .history li').count(), 0);
        assert.equal(await p.locator('#right .statuses button.on').count(), 0);
        await p.click('#left .views.side button:has-text("화면")');
        assert.match(await p.locator('#right h2', { hasText: '표시 —' }).textContent(), /^표시 — 화면 전체$/);
        assert.equal(await p.locator('#right .history li').count(), 0);
        assert.match(await p.textContent('#left'), /떨어져 나감 0/);

        fs.rmSync(path.join(config.storiesDir, 'run-lab.json'));
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.match(await p.textContent('#left'), /떨어져 나감 0/);
        await p.click('#left .views.side button:has-text("스토리")');
        assert.equal(await p.locator('#story-list li:has-text("실험실을 열어")').count(), 0);
        assert.match(await p.textContent('#left'), /떨어져 나감 1/);
        const detached = p.locator('#left .detached li');
        assert.equal(await detached.count(), 1);
        assert.equal(await detached.locator('.chip').textContent(), '더 필요');
        assert.equal(await detached.locator('code').textContent(), 'run-lab');
        assert.match(await detached.textContent(), /reviewer · .*the story test fails/);
      }),
    ),
  );
});

test('in a browser, a failed save stays with the form that tried it and is gone after choosing another story or switching tabs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        const failSave = async () => {
          await p.click('#right .statuses button:has-text("없음")');
          await p.click('#right button.save');
          await p.waitForSelector('#right .error');
          assert.match(await p.textContent('#right'), /저장하지 못했습니다: disk full/);
        };
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.locator('#right .error').count(), 0);
        await failSave();
        await p.click('#story-list li:has-text("보고서")');
        assert.doesNotMatch(await p.textContent('#right'), /저장하지 못했습니다/);
        await p.click('#story-list li:has-text("실험실을 열어")');
        await failSave();
        await p.click('#left .views.side button:has-text("화면")');
        assert.doesNotMatch(await p.textContent('#right'), /저장하지 못했습니다/);
        await p.click('#left .views.side button:has-text("스토리")');
        await failSave();
        await p.click('#center .story-path .step:has-text("/lab/result")');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
        assert.doesNotMatch(await p.textContent('#right'), /저장하지 못했습니다/);
      }),
    ),
  );
});

test('in a browser, a mark on a story whose file is there but cannot be read shows on the stories tab and can be marked again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    fs.writeFileSync(path.join(config.storiesDir, 'run-lab.json'), '{');
    addMark(config.marksDir, { target: { story: 'run-lab' }, status: 'missing', note: 'walk it', author: 'a' }, new Date('2026-09-30T01:00:00Z'));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.match(await p.textContent('#left'), /떨어져 나감 0/);
        const unread = p.locator('#left .unread-marks li');
        assert.equal(await unread.count(), 1);
        assert.equal(await unread.locator('.chip').textContent(), '없음');
        assert.equal(await unread.locator('code').textContent(), 'run-lab');
        await unread.click();
        assert.equal(await p.textContent('#center h3'), 'run-lab');
        assert.equal(await p.textContent('#right h2'), '표시 — 스토리');
        assert.equal(await p.locator('#right-info').isVisible(), false);
        assert.ok(await p.evaluate(() => document.getElementById('right-dock').getBoundingClientRect().top - document.getElementById('right').getBoundingClientRect().top) < 1, 'the form sits at the top of the pane');
        assert.match(await p.textContent('#right .history'), /walk it/);
        await p.click('#right .statuses button:has-text("충분")');
        await p.click('#right button.save');
        await openHistory(p);
        await p.waitForSelector('#right .history li:nth-child(2)');
        assert.equal(await p.textContent('#right .history li:first-child .chip'), '충분');
        assert.equal(await p.textContent('#left .unread-marks li .chip'), '충분');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]).sort((a, b) => a[1].localeCompare(b[1])), [
          [{ story: 'run-lab' }, 'fine'], [{ story: 'run-lab' }, 'missing'],
        ]);
      }),
    );
  });
});

test('in a browser, a failed save stays with the screen or cell that tried it, and a save that fails after the reviewer moved on names the target it was for', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        const failSave = async () => {
          await p.click('#right .statuses button:has-text("없음")');
          await p.click('#right button.save');
          await p.waitForSelector('#right .error');
          assert.match(await p.textContent('#right'), /저장하지 못했습니다: disk full/);
        };
        await p.click('#screen-list li:has-text("/document/:id")');
        await failSave();
        await p.click('#center tr:has-text("API")');
        assert.doesNotMatch(await p.textContent('#right'), /저장하지 못했습니다/);
        await failSave();
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.doesNotMatch(await p.textContent('#right'), /저장하지 못했습니다/);

        await p.click('#screen-list li:has-text("/admin/report")');
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks')
            ? new Promise((resolve, reject) => { window.failSave = () => reject(new Error('disk full')); })
            : real(url, init));
        });
        await p.locator('table.calls tr.option', { hasText: 'withAttachments 켬' }).first().locator('td.cell').nth(1).click();
        const cellLabel = (await p.textContent('#right-dock .mark-form h2')).replace('표시 — ', '');
        assert.match(cellLabel, /^withAttachments 켬 · .+ 깊이$/);
        const cellName = `${await p.textContent('#right-info .target-id .mono')} · ${cellLabel}`;
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.click('#center tr:has-text("화면 전체")');
        assert.equal(await p.locator('#right .error').count(), 0);
        await p.evaluate(() => window.failSave());
        await p.waitForSelector('#right-dock .error');
        assert.equal(await p.textContent('#right-dock .error'), `「${cellName}」 표시를 저장하지 못했습니다: disk full`);

        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.evaluate(() => window.failSave());
        await p.waitForFunction(() => document.querySelector('#right-dock .error')?.textContent === '저장하지 못했습니다: disk full');
      }),
    ),
  );
});

test('in a browser, a story whose ID is the name of an object member shows like any other', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    fs.mkdirSync(config.storiesDir, { recursive: true });
    fs.writeFileSync(path.join(config.storiesDir, 'constructor.json'), JSON.stringify({ name: '이상한 ID', screens: ['/home#Home'], author: 'a', date: '2026-10-03' }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("이상한 ID")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['일부 화면만 테스트']);
        assert.equal(await p.textContent('#center .story-tests h2'), '스토리 테스트 0');
      }),
    );
  });
});

test('in a browser, a step whose first screen has no link to the next but has links to a path duru cannot read is not judged, and those links are listed, also next to a conditioned step judged without them but not next to an open one', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    rewrite(copy, 'client/src/_define/Option.js', "SIGN_IN: this.CONTEXT_PATH + 'signin',", "ROOT: this.CONTEXT_PATH,\n      SIGN_IN: this.CONTEXT_PATH + 'signin',");
    rewrite(copy, 'client/src/components/Lab.js', '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>',
      '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>\n      <Link to={Option.ROUTE_PATH.ROOT}>Start</Link>\n      <Link to={Option.ROUTE_PATH.NOPE}>Nope</Link>');
    rewrite(copy, 'client/src/components/Home.js', '<Link to={Option.ROUTE_PATH.LAB}>Lab</Link>}', '<Link to={Option.ROUTE_PATH.LAB}>Lab</Link>}\n      <Link to={Option.ROUTE_PATH.NOPE}>Nope</Link>');
    rebuild(copy);
    fs.mkdirSync(config.storiesDir, { recursive: true });
    const story = (name, screens) => JSON.stringify({ name, screens, author: 'a', date: '2026-10-02' });
    fs.writeFileSync(path.join(config.storiesDir, 'lab-to-start.json'), story('실험실에서 처음으로', ['/lab#Lab', '/signin#SignIn']));
    fs.writeFileSync(path.join(config.storiesDir, 'home-to-lab-result.json'), story('홈에서 실험 결과로', ['/home#Home', '/lab#Lab', '/lab/result#LabResult']));
    fs.writeFileSync(path.join(config.storiesDir, 'lab-result.json'), story('실험실에서 결과로', ['/lab#Lab', '/lab/result#LabResult']));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.deepEqual(await p.locator('#story-list li').evaluateAll((items) => items.map((li) => [...li.querySelectorAll('.chip')].map((c) => c.textContent))), [
          ['일부 화면만 테스트'], ['일부 화면만 테스트'], ['일부 화면만 테스트', '판정 못 함'],
        ]);

        await p.click('#story-list li:has-text("처음으로")');
        assert.deepEqual(await p.locator('#center .story-path .link > .chip').allTextContents(), ['판정 못 함']);
        assert.deepEqual(await p.locator('#center .story-path .link.l-unknown li').allTextContents(), [`components/Lab.js:16 → ${UNKNOWN}`]);
        assert.doesNotMatch(await p.textContent('#center .story-path'), /리다이렉트/);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['판정 못 함 · 주소 못 읽은 링크']);
        assert.equal(await p.locator('#right .skipped').count(), 0);

        await p.click('#story-list li:has-text("실험 결과로")');
        assert.deepEqual(await p.locator('#center .story-path .link > .chip').allTextContents(), ['조건', '이어짐']);
        const skipped = (link) => p.locator(`#center .story-path .link.${link} .unknown-links li`).allTextContents();
        assert.deepEqual(await skipped('l-conditioned'), [`components/Home.js:20 → ${UNKNOWN}`]);
        assert.match(await p.textContent('#center .story-path .link.l-conditioned .skipped'), /판정에서 뺀 링크/);
        assert.deepEqual(await skipped('l-open'), []);
        assert.equal(await p.locator('#center .story-path .link.l-open .skipped').count(), 0);
        assert.match(await p.textContent('#right-info > p.skipped'), /주소 못 읽은 링크 빼고 판정/);
        assert.deepEqual(await p.locator('#right .reach-link .unknown-links li').allTextContents(), [`components/Home.js:20 → ${UNKNOWN}`]);

        await p.click('#story-list li:has-text("실험실에서 결과로")');
        assert.deepEqual(await p.locator('#center .story-path .link > .chip').allTextContents(), ['이어짐']);
        assert.equal(await p.locator('#center .skipped').count(), 0);
        assert.equal(await p.locator('#right .skipped').count(), 0);
      }),
    );
  });
});

test('in a browser, the right of a story gives a verdict line for missing links and one for a screen off the map, counting the missing links', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    fs.mkdirSync(config.storiesDir, { recursive: true });
    fs.writeFileSync(path.join(config.storiesDir, 'back-and-forth.json'), JSON.stringify({
      name: '도움말을 오간다', screens: ['/home#Home', '/help#Help', '/home#Home', '/help#Help', '/settings#Settings'], author: 'a', date: '2026-10-03',
    }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("도움말을 오간다")');
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 불가 · 링크 없음 3곳', '판정 못 함 · 화면 없음']);
        assert.deepEqual(await p.locator('#right .verdict').evaluateAll((els) => els.map((e) => e.className)), ['verdict unreachable', 'verdict unjudged']);
        assert.equal(await p.textContent('#right-info > p.muted:not(.skipped)'), '판정한 구간에 조건 없음');
      }),
    );
  });
});

test('in a browser, the dead screen filter keeps the screens that call an API missing on the server', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const names = () => p.locator('#screen-list li .name > span:first-child').allTextContents();
        await p.check('#left input[name=dead]');
        assert.deepEqual(await names(), ['/home', '/document/:tab(draft|done)']);
        assert.deepEqual(await p.locator('#screen-list li .chip.dead').allTextContents(), ['죽은 화면', '죽은 화면']);
        await p.fill('#left input[type=search]', 'home');
        assert.deepEqual(await names(), ['/home']);
        await p.fill('#left input[type=search]', '');
        await p.check('#left input[name=no-tests]');
        assert.deepEqual(await names(), []);
        await p.uncheck('#left input[name=dead]');
        assert.ok((await names()).length > 0);
        await p.uncheck('#left input[name=no-tests]');
        assert.equal((await names()).length, 11);
      }),
    ),
  );
});

const LONG_PATH = '/organization-settings/notification-preferences/default-recipients/:groupId(active|archived)';
const LONG_PATH_COMPONENT = 'RecipientSettings';

async function withLongListRows(fn) {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        assert.equal((await postMark(base, { target: { node: '/home#Home' }, status: 'fine', author: 'reviewer' })).status, 201);
        await p.route('**/api/data', async (route) => {
          const data = await (await route.fetch()).json();
          for (const id of ['/home#Home', '/help#Help']) {
            const screen = data.map.screens.find((s) => s.id === id);
            Object.assign(screen, { path: LONG_PATH, component: LONG_PATH_COMPONENT, dead: id === '/home#Home' });
          }
          const importer = { title: 't', file: 'a.test.js', line: 1, source: 'a.js', format: 'vitest', depth: 'code', status: 'pass', testFile: 'a.test.js', via: ['a.js'] };
          data.tests.importers['/home#Home'] = [importer, importer];
          await route.fulfill({ json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await fn(p, (id) => p.locator('#screen-list li', { hasText: LONG_PATH_COMPONENT }).nth(id === 'home' ? 0 : 1));
      }),
    ),
  );
}

const renderedLines = (locator) =>
  locator.evaluate((el) => {
    const lines = [];
    let top;
    for (const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); walker.nextNode(); ) {
      const node = walker.currentNode;
      for (let i = 0; i < node.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getClientRects()[0];
        if (!rect || /\s/.test(node.data[i])) continue;
        if (rect.top !== top) lines.push('');
        top = rect.top;
        lines[lines.length - 1] += node.data[i];
      }
    }
    return lines;
  });

test('in a browser, a long route in the screen list wraps only before a slash', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    const lines = await renderedLines(row('help').locator('.name > span:first-child'));
    assert.ok(lines.length >= 3, `the path is long enough to wrap: ${lines}`);
    assert.equal(lines.join(''), LONG_PATH);
    assert.deepEqual(lines.filter((line) => !line.startsWith('/')), []);
  });
});

test('in a browser, the component name in the screen list stays on one line', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    for (const id of ['home', 'help']) assert.deepEqual(await renderedLines(row(id).locator('.name .muted')), [LONG_PATH_COMPONENT]);
  });
});

test('in a browser, the badges of a screen list row sit below the route and leave it the full row width', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    const geometry = (r) =>
      r.evaluate((li) => {
        const box = (el) => el.getBoundingClientRect();
        const style = getComputedStyle(li);
        return {
          content: box(li).width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          name: box(li.querySelector('.name')),
          badgesTop: Math.min(...[...li.querySelectorAll('.chip, .count')].map((el) => box(el).top)),
        };
      });
    const crowded = await geometry(row('home'));
    const bare = await geometry(row('help'));
    assert.deepEqual(await row('home').locator('.chip, .count').allTextContents(), ['죽은 화면', '충분', '테스트 7', '불러옴 2']);
    assert.equal(crowded.name.width, bare.name.width);
    assert.ok(Math.abs(crowded.name.width - crowded.content) < 1, `${crowded.name.width} of ${crowded.content}`);
    assert.ok(crowded.badgesTop >= crowded.name.bottom && bare.badgesTop >= bare.name.bottom);

    const line = await row('home').evaluate((li) => {
      const boxes = [...li.querySelectorAll('.badges > *')].map((el) => el.getBoundingClientRect());
      return {
        tops: boxes.map((b) => b.top),
        widths: boxes.map((b) => b.width),
        gaps: boxes.slice(1).map((b, i) => b.left - boxes[i].right),
        content: li.querySelector('.name').getBoundingClientRect().width,
      };
    });
    assert.ok(line.widths.reduce((sum, w) => sum + w, 0) + 8 * (line.widths.length - 1) <= line.content, `the badges fit in one row width: ${line.widths} of ${line.content}`);
    assert.ok(Math.max(...line.tops) - Math.min(...line.tops) < 4, `the badges share one line: ${line.tops}`);
    assert.ok(line.gaps.every((gap) => Math.abs(gap - 8) < 0.5), `adjacent badges are 8px apart: ${line.gaps}`);
  });
});

test('in a browser, a route that spans several segments in the screen list is found by in-page text search', { skip: browserMissing }, async () => {
  await withLongListRows(async (p) => {
    for (const text of ['/organization-settings/notification-preferences', '/default-recipients/:groupId(active|archived)']) {
      const found = await p.evaluate((t) => {
        getSelection().removeAllRanges();
        return { hit: window.find(t), inList: document.getElementById('screen-list').contains(getSelection().anchorNode) };
      }, text);
      assert.deepEqual(found, { hit: true, inList: true }, text);
    }
  });
});

test('in a browser, a screen list row gives its full route and component as a tooltip and never scrolls the list sideways', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    assert.equal(await row('help').getAttribute('title'), `${LONG_PATH} ${LONG_PATH_COMPONENT}`);
    const list = await p.locator('#screen-list').evaluate((ul) => {
      ul.querySelector('.seg').append('x'.repeat(120));
      const section = ul.closest('section');
      return { scrollWidth: section.scrollWidth, clientWidth: section.clientWidth };
    });
    assert.equal(list.scrollWidth, list.clientWidth);
  });
});

test('in a browser, an over-wide route segment in the screen list is clipped at the row content edge, not drawn into the row padding', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    const li = row('help');
    const strip = await li.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(el).paddingRight);
      return { x: box.right - pad, y: box.top, width: pad, height: box.height };
    });
    const before = await p.screenshot({ clip: strip });
    await li.locator('.seg').first().evaluate((el) => el.append('x'.repeat(120)));
    const after = await p.screenshot({ clip: strip });
    assert.ok(before.equals(after), 'the right padding of the row stays empty');
    assert.equal(await li.evaluate((el) => getComputedStyle(el).overflowX), 'visible');
  });
});

const openLinkGroups = (access) => access.locator('details.link-group').evaluateAll((groups) => groups.forEach((g) => { g.open = true; }));

test('in a browser, the setting and role filters keep the screens that open only under one, and the chosen screen shows why', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const names = () => p.locator('#screen-list li .name > span:first-child').allTextContents();
        await p.check('#left input[name=setting]');
        assert.deepEqual(await names(), ['/help', '/lab', '/lab/result', '/admin/report']);
        await p.uncheck('#left input[name=setting]');
        await p.check('#left input[name=role]');
        assert.deepEqual(await names(), ['/admin/member', '/admin/group', '/admin/audit', '/admin/report']);

        const access = p.locator('#right .access');
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.deepEqual((await p.locator('#right .open-needs .need').allTextContents()).map((t) => t.split(' ')[0]), ['역할', '설정']);
        await openLinkGroups(access);
        const fromHome = await access.locator('li:has-text("/home#Home")').innerText();
        assert.match(fromHome, /components\/SideMenu\.js:11/);
        assert.match(fromHome, /\['ADMIN', 'OWNER'\]\.indexOf\(session\['member\.role'\]\) > -1\s*역할/);
        assert.match(fromHome, /MENUS\.ADMIN\s*설정/);

        await p.uncheck('#left input[name=role]');
        await p.click('#screen-list li:has-text("/admin/member")');
        assert.match(await p.locator('#right .open-needs .route').innerText(), /isAdminRole\(memberRole\)\s*역할/);
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.equal(await access.locator('details.link-group > summary').innerText(), '조건 없음 링크 1');
        await openLinkGroups(access);
        assert.match(await access.locator('li:has-text("/lab#Lab")').innerText(), /링크를 건 화면에 필요한 것\s*설정/);
        assert.deepEqual(await access.locator('li:has-text("/lab#Lab") .from-kinds .chip').allTextContents(), ['설정']);
        await p.click('#screen-list li:has-text("/admin/audit")');
        await openLinkGroups(access);
        assert.deepEqual(await access.locator('li:has-text("/admin/member#AdminMember") .from-kinds .chip').allTextContents(), ['역할']);
        await p.click('#screen-list li:has-text("/help")');
        await openLinkGroups(access);
        assert.match(await access.locator('li:has-text("/signin#SignIn")').innerText(), /globalSettings\.SYSTEM\.HELP_LINK_ENABLED \(openHelp 로 물려받음\)\s*설정/);
        await p.click('#screen-list li:has-text("/signin")');
        assert.equal(await p.locator('#right .open-needs p').innerText(), '설정이나 역할 없이 열립니다.');

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.doesNotMatch(await (await screenBox(p, '/admin/report#AdminReport')).locator('.l2').textContent(), /필요/);
        const labResult = await screenBox(p, '/lab/result#LabResult');
        assert.doesNotMatch(await labResult.locator('.l2').textContent(), /필요/);
        assert.deepEqual(await needLines(labResult), ['설정 SYSTEM.LAB_ENABLED 켬']);
        assert.doesNotMatch(await (await screenBox(p, '/signin#SignIn')).locator('.l2').textContent(), /필요/);
      }),
    ),
  );
});

test('in a browser, a screen whose links ask for different kinds has its own filter and says so in its access panel, on links from it and in its flow box', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    rewrite(copy, 'client/src/components/Home.js', "      {session['member.role']", "      {memberRole === 'ADMIN' && <Link to={Option.ROUTE_PATH.HELP}>Help</Link>}\n      {session['member.role']");
    fs.writeFileSync(path.join(copy, 'client/src/components/Help.js'), "import { Link } from 'react-router-dom';\nimport Option from '_define/Option';\n\nexport default function Help() {\n  return <article><Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link></article>;\n}\n");
    rebuild(copy);
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.check('#left input[name=mixed]');
        assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/help', '/lab/result']);
        await p.uncheck('#left input[name=mixed]');
        const access = p.locator('#right .access');
        await p.click('#screen-list li:has-text("/help")');
        assert.deepEqual(await p.locator('#right .open-needs .need').allTextContents(), ['링크마다 다름']);
        await p.click('#screen-list li:has-text("/lab/result")');
        await openLinkGroups(access);
        assert.deepEqual(await access.locator('li:has-text("/help#Help") .from-kinds .chip').allTextContents(), ['링크마다 다름']);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.match(await (await screenBox(p, '/help#Help')).locator('.l2').textContent(), / · 불러옴 2 · 링크마다 다름$/);
      }),
    );
  });
});

test('in a browser, the top of the right pane says what opens the chosen screen in the words of its flow box', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const summaryOf = async (label) => {
          await p.click(`#screen-list li:has-text("${label}")`);
          assert.equal(await p.locator('#right-info > :first-child').evaluate((e) => e.className), 'open-needs');
          assert.equal(await p.textContent('#right .open-needs h2'), '이 화면을 열려면');
          return p.locator('#right .open-needs .need').allTextContents();
        };
        const report = await summaryOf('/admin/report');
        const group = await summaryOf('/admin/group');
        await p.click('#screen-list li:has-text("/signin")');
        assert.equal(await p.locator('#right .open-needs p').innerText(), '설정이나 역할 없이 열립니다.');

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.deepEqual(report, ['역할 ADMIN 외 1', '설정 "ADMIN_REPORT" (ADMIN.LIST 에) 외 1']);
        assert.deepEqual(report, await needLines(await screenBox(p, '/admin/report#AdminReport')));
        assert.deepEqual(group, await needLines(await screenBox(p, '/admin/group#AdminGroup')));
      }),
    ),
  );
});

test('in a browser, the info part of the right pane reads in order and the mark form sits apart in the dock below it, also when a call is chosen', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        const headings = await p.locator('#right-info h2').allTextContents();
        assert.match(headings[0], /^이 화면을 열려면$/);
        assert.deepEqual(headings.slice(1).map((t) => t.replace(/ \d+$/, '')), ['들어오는 링크', '소스 위치', '나가는 링크', '읽는 설정값']);
        assert.equal(await p.locator('#right-info .mark-form').count(), 0);
        assert.equal(await p.locator('#right > :last-child').evaluate((e) => e.id), 'right-dock');
        assert.equal(await p.locator('#right-dock > .mark-form').count(), 1);
        assert.equal(await p.textContent('#right-dock .mark-form h2'), '표시 — 화면 전체');

        await p.locator('table.calls td.cell').first().click();
        assert.equal(await p.locator('#right-info .mark-form').count(), 0);
        assert.equal(await p.locator('#right-dock > .mark-form').count(), 1);
        assert.match(await p.locator('#right-dock .mark-form h2').textContent(), /^표시 — /);
        assert.match(await p.locator('#right-info h2').first().textContent(), /^서버 대조$/);
      }),
    ),
  );
});

test('in a browser, the in-screen conditions come between the incoming links and the source location', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    await open();
    const headings = (await p.locator('#right h2').allTextContents()).map((t) => t.replace(/ \d+$/, '').replace(/^(화면 안 조건) — .*$/, '$1'));
    assert.deepEqual(headings, ['이 화면을 열려면', '들어오는 링크', '화면 안 조건', '소스 위치', '나가는 링크', '읽는 설정값', '표시 — 화면 전체']);
  });
});

const openDocumentScreenInShortViewport = async (p) => {
  await p.setViewportSize({ width: 1440, height: 400 });
  await p.waitForSelector('#screen-list li');
  await p.click('#screen-list li:has-text("/document/:id")');
};
const openHistory = async (p) => {
  const toggle = p.locator('#right .history-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
};
const scrollRightToBottom = (p) => p.locator('#right-info').evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
const scrollRightTo = (p, top) => p.locator('#right-info').evaluate((el, y) => { el.scrollTop = y; return el.scrollTop; }, top);
const rightScroll = (p) => p.locator('#right-info').evaluate((el) => el.scrollTop);

test('in a browser, choosing another screen or call target opens the right pane at its top, and redrawing the same target keeps the scroll offset', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p);
        const firstCall = p.locator('table.calls tbody tr:not(.option)').nth(0).locator('td.cell');
        const secondCall = p.locator('table.calls tbody tr:not(.option)').nth(1).locator('td.cell');

        assert.ok((await scrollRightToBottom(p)) > 0);
        await firstCall.first().click();
        assert.equal(await rightScroll(p), 0);

        assert.ok((await scrollRightToBottom(p)) > 0);
        await secondCall.first().click();
        assert.equal(await rightScroll(p), 0);

        const kept = await scrollRightToBottom(p);
        assert.ok(kept > 0);
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await rightScroll(p), kept);
        await p.click('#right button.save');
        await p.waitForSelector('#right .history-toggle');
        assert.equal(await rightScroll(p), kept);

        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await rightScroll(p), 0);
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.ok((await scrollRightToBottom(p)) > 0);
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await rightScroll(p), 0);
      }),
    ),
  );
});

test('in a browser, choosing another depth or option row of the same node keeps the right pane scroll offset, and choosing a call row resets it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p);
        const kept = await scrollRightTo(p, 100);
        assert.equal(kept, 100);
        await p.click('#center tr:has-text("API")');
        assert.match(await p.textContent('#right .mark-form h2'), /API 깊이/);
        assert.equal(await rightScroll(p), kept);
        await p.click('#center tr:has-text("UI/E2E")');
        assert.match(await p.textContent('#right .mark-form h2'), /UI\/E2E 깊이/);
        assert.equal(await rightScroll(p), kept);

        await p.locator('table.calls tbody tr:not(.option)').nth(0).locator('td.cell').first().click();
        const call = await scrollRightTo(p, 100);
        assert.equal(call, 100);
        await p.locator('table.calls tbody tr:not(.option)').nth(0).locator('td.cell').nth(2).click();
        assert.match(await p.textContent('#right .mark-form h2'), / 깊이$/);
        assert.equal(await rightScroll(p), call);
        await p.locator('table.calls tbody tr:not(.option)').nth(1).locator('td.cell').first().click();
        assert.equal(await rightScroll(p), 0);

        await p.click('#screen-list li:has-text("/admin/report")');
        await p.locator('table.calls td.cell').first().click();
        const exported = await scrollRightTo(p, 100);
        assert.equal(exported, 100);
        await p.locator('table.calls tr.option', { hasText: 'withAttachments 켬' }).first().locator('td.cell').first().click();
        assert.match(await p.textContent('#right .mark-form h2'), /withAttachments 켬/);
        assert.equal(await rightScroll(p), exported);
      }),
    ),
  );
});

test('in a browser, selecting another story opens the right pane at its top', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.setViewportSize({ width: 1440, height: 360 });
        await p.click('#left .views.side button:has-text("스토리")');
        const stories = p.locator('#story-list li');
        await stories.nth(0).click();
        assert.ok((await scrollRightToBottom(p)) > 0);
        await stories.nth(1).click();
        assert.equal(await rightScroll(p), 0);
        const kept = await scrollRightToBottom(p);
        assert.ok(kept > 0);
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await rightScroll(p), kept);
      }),
    ),
  );
});

const insideRightPane = (p, selector) => p.evaluate((sel) => {
  const pane = document.getElementById('right').getBoundingClientRect();
  const box = document.querySelector(sel).getBoundingClientRect();
  return box.height > 0 && box.top >= pane.top - 0.5 && box.bottom <= pane.bottom + 0.5;
}, selector);
const topOf = (p, selector) => p.locator(selector).evaluate((e) => e.getBoundingClientRect().top);

async function assertDockStaysPut(p) {
  const info = p.locator('#right-info');
  assert.ok(await info.evaluate((e) => e.scrollHeight > e.clientHeight), 'the info part is taller than its box');
  for (const selector of ['#right .statuses', '#right button.save']) {
    assert.ok(await insideRightPane(p, selector), `${selector} is visible without scrolling`);
  }
  const before = [await topOf(p, '#right .statuses'), await topOf(p, '#right button.save')];
  assert.ok((await scrollRightToBottom(p)) > 0);
  assert.deepEqual([await topOf(p, '#right .statuses'), await topOf(p, '#right button.save')], before);
  for (const selector of ['#right .statuses', '#right button.save']) assert.ok(await insideRightPane(p, selector));
}

test('in a browser, the status buttons and the save button stay in view at the bottom of the right pane while its info part scrolls, for a screen and for a call', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p);
        await assertDockStaysPut(p);

        await p.locator('table.calls td.cell').first().click();
        assert.equal(await p.locator('#right-info .target-id').count(), 1);
        await assertDockStaysPut(p);
      }),
    ),
  );
});

test('in a browser, the status buttons and the save button stay in view at the bottom of the right pane for a story', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.setViewportSize({ width: 1440, height: 360 });
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.textContent('#right-dock .mark-form h2'), '표시 — 스토리');
        await assertDockStaysPut(p);
        assert.equal(await p.locator('#right-info .mark-form').count(), 0);
      }),
    ),
  );
});

test('in a browser, the history sits behind a closed fold next to the save button, stays open when the pane is redrawn, and closes when another target is chosen', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const node = '/document/:id#DocumentDetail';
        assert.equal((await postMark(base, { target: { node }, status: 'missing', note: 'first look', author: 'reviewer' })).status, 201);
        assert.equal((await postMark(base, { target: { node }, status: 'fine', note: 'second look', author: 'reviewer' })).status, 201);
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        const toggle = p.locator('#right-dock .save-row .history-toggle');
        assert.equal((await toggle.textContent()).trim(), '이력 2');
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(await p.locator('#right .history').isVisible(), false);

        await toggle.click();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert.deepEqual(await p.locator('#right-dock .history li').allTextContents().then((ts) => ts.map((t) => /second look/.test(t) ? 'second' : /first look/.test(t) ? 'first' : t)), ['second', 'first']);
        assert.equal(await p.locator('#right .history').isVisible(), true);
        const list = await p.locator('#right .history').evaluate((e) => ({ overflowY: getComputedStyle(e).overflowY, maxHeight: getComputedStyle(e).maxHeight }));
        assert.equal(list.overflowY, 'auto');
        assert.notEqual(list.maxHeight, 'none');

        await p.click('#right .statuses button:has-text("더 필요")');
        assert.equal(await p.locator('#right .history-toggle').getAttribute('aria-expanded'), 'true');
        assert.equal(await p.locator('#right .history').isVisible(), true);

        await p.click('#center tr:has-text("API")');
        assert.equal(await p.locator('#right .history-toggle').count(), 0);
        await p.click('#center tr:has-text("화면 전체")');
        assert.equal(await p.locator('#right .history-toggle').getAttribute('aria-expanded'), 'false');
        assert.equal(await p.locator('#right .history').isVisible(), false);

        await p.locator('#right .history-toggle').click();
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await p.locator('#right .history-toggle').count(), 0);
        assert.equal(await p.locator('#right .history').count(), 0);
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.equal(await p.locator('#right .history-toggle').getAttribute('aria-expanded'), 'false');
      }),
    ),
  );
});

test('in a browser, the dock keeps the info part at least 120px tall on a short window and does not make the right pane itself scroll while both fit', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const node = '/document/:id#DocumentDetail';
        for (let i = 0; i < 6; i++) {
          assert.equal((await postMark(base, { target: { node }, status: 'fine', note: `look ${i} ${'long '.repeat(20)}`, author: 'reviewer' })).status, 201);
        }
        await p.setViewportSize({ width: 1440, height: 500 });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        const geometry = () => p.evaluate(() => {
          const rect = (id) => document.getElementById(id).getBoundingClientRect();
          const right = document.getElementById('right');
          return { info: rect('right-info').height, dock: rect('right-dock').height, pane: rect('right'), dockBottom: rect('right-dock').bottom, overflow: right.scrollHeight - right.clientHeight };
        });
        for (const open of [false, true]) {
          if (open) await p.locator('#right .history-toggle').click();
          const g = await geometry();
          assert.ok(g.dock <= g.pane.height * 0.65, `the dock takes ${g.dock}px of ${g.pane.height}px (history open: ${open})`);
          assert.ok(g.info >= 120, `info part ${g.info}px (history open: ${open})`);
          assert.ok(g.dockBottom <= g.pane.bottom + 0.5, 'the dock is fully inside the pane');
          assert.ok(g.overflow <= 0, `the pane itself overflows by ${g.overflow}px`);
          assert.ok(await insideRightPane(p, '#right button.save'));
          assert.ok(await p.locator('#right-info').evaluate((e) => e.scrollHeight > e.clientHeight), 'the info part scrolls');
        }
        assert.ok((await p.locator('#right textarea').evaluate((e) => getComputedStyle(e).maxHeight)) !== 'none');
      }),
    ),
  );
});

test('in a browser, on a window too short for the info part and the dock the right pane itself scrolls, so the save button can be reached and pressed', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 320 });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await insideRightPane(p, '#right button.save'), false);
        const heading = await p.locator('#right-dock .mark-form h2').boundingBox();
        await p.mouse.move(heading.x + 10, heading.y + heading.height / 2);
        await p.mouse.wheel(0, 400);
        for (let i = 0; i < 20 && !(await insideRightPane(p, '#right button.save')); i++) await p.waitForTimeout(50);
        assert.ok(await insideRightPane(p, '#right button.save'), 'the save button is brought inside the pane by scrolling it');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history-toggle');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]), [[{ node: '/document/:id#DocumentDetail' }, 'missing']]);
        assert.ok((await p.locator('#right').evaluate((e) => e.scrollTop)) > 0);
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await p.locator('#right').evaluate((e) => e.scrollTop), 0);
      }),
    ),
  );
});

test('in a browser, a save that finishes after the reviewer moved to another screen, or left and came back, keeps the status and memo picked since, and a form left untouched shows the saved mark', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        let onPost;
        await p.route('**/api/marks', async (route) => {
          await new Promise((release) => onPost(release));
          await route.continue();
        });
        const holdNextPost = () => new Promise((resolve) => { onPost = resolve; });
        const pick = async (status, note) => {
          await p.click(`#right .statuses button:has-text("${status}")`);
          await p.fill('#right textarea', note);
        };
        const assertForm = async (status, note) => {
          assert.equal(await p.inputValue('#right textarea'), note);
          assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), [status]);
        };

        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#right .statuses button:has-text("없음")');
        let posting = holdNextPost();
        await p.click('#right button.save');
        let release = await posting;
        await p.click('#screen-list li:has-text("/admin/report")');
        await pick('더 필요', 'keep me');
        const documentChip = '#screen-list li:has-text("/document/:id") .chip.missing';
        assert.equal(await p.locator(documentChip).count(), 0);
        release();
        await p.waitForSelector(documentChip);
        await assertForm('더 필요', 'keep me');

        posting = holdNextPost();
        await p.click('#right button.save');
        release = await posting;
        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#screen-list li:has-text("/admin/report")');
        await pick('충분', 'second thoughts');
        const reportChip = '#screen-list li:has-text("/admin/report") .chip.needs-more';
        assert.equal(await p.locator(reportChip).count(), 0);
        release();
        await p.waitForSelector(reportChip);
        await assertForm('충분', 'second thoughts');

        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#right .statuses button:has-text("충분")');
        posting = holdNextPost();
        await p.click('#right button.save');
        release = await posting;
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#screen-list li:has-text("/lab/result")');
        release();
        await p.waitForSelector('#screen-list li:has-text("/lab/result") .chip.fine');
        await assertForm('충분', '');

        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status, m.note]).sort((a, b) => a[1].localeCompare(b[1])), [
          [{ node: '/document/:id#DocumentDetail' }, 'missing', ''],
          [{ node: '/admin/report#AdminReport' }, 'needs-more', 'keep me'],
          [{ node: '/lab/result#LabResult' }, 'fine', ''],
        ].sort((a, b) => a[1].localeCompare(b[1])));
      }),
    ),
  );
});

test('in a browser, a save whose reload fails after the reviewer moved to another story names the story it was for, and one that stays says so plainly', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        let onPost;
        await p.route('**/api/marks', async (route) => {
          await new Promise((release) => onPost(release));
          await route.continue();
        });
        const holdNextPost = () => new Promise((resolve) => { onPost = resolve; });
        await p.click('#left .views.side button:has-text("스토리")');
        const first = p.locator('#story-list li:has-text("실험실을 열어")');
        const name = await first.locator('.name > span').textContent();
        await first.click();
        await p.click('#right .statuses button:has-text("없음")');
        let posting = holdNextPost();
        await p.click('#right button.save');
        let release = await posting;
        await p.click('#story-list li:has-text("보고서")');
        await p.route('**/api/data', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' }));
        release();
        await p.waitForSelector('#right-dock .error');
        assert.ok((await p.textContent('#right-dock .error')).startsWith(`「스토리 ${name}」 표시는 저장했지만 다시 읽지 못했습니다: `));

        await p.click('#right .statuses button:has-text("없음")');
        posting = holdNextPost();
        await p.click('#right button.save');
        release = await posting;
        release();
        await p.waitForFunction(() => document.querySelector('#right-dock .error')?.textContent.startsWith('저장했지만 다시 읽지 못했습니다: '));
      }),
    ),
  );
});

test('in a browser, picking a status updates the form in place, keeping the memo box and the height it was dragged to', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.equal(await p.locator('#right button.save').isEnabled(), false);
        const memo = await p.$('#right textarea');
        const dragged = await memo.evaluate((e) => { e.style.height = '150px'; return e.getBoundingClientRect().height; });
        await p.click('#right .statuses button:has-text("더 필요")');
        assert.ok(await memo.evaluate((e) => e === document.querySelector('#right textarea')), 'the memo box is the same element');
        assert.equal(await memo.evaluate((e) => e.getBoundingClientRect().height), dragged);
        assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), ['더 필요']);
        assert.equal(await p.locator('#right button.save').isEnabled(), true);
        await p.click('#right .statuses button:has-text("충분")');
        assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), ['충분']);
      }),
    ),
  );
});

test('in a browser, a save that is refused shows its message in the dock above the save button, both inside the visible part of the pane', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p);
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.resolve(new Response('mark is refused', { status: 400 })) : real(url, init));
        });
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.waitForSelector('#right-dock .error');
        assert.equal(await p.locator('#right-dock .error').count(), 1);
        assert.equal(await p.locator('#right .error ~ .save-row button.save').count(), 1);
        const inside = async () => (await insideRightPane(p, '#right .mark-form .error')) && insideRightPane(p, '#right .mark-form button.save');
        assert.match(await p.textContent('#right .error'), /저장하지 못했습니다: mark is refused/);
        assert.ok(await inside());

        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        await p.click('#right button.save');
        await p.waitForFunction(() => /저장하지 못했습니다: disk full/.test(document.querySelector('#right .error')?.textContent ?? ''));
        assert.ok(await inside());
      }),
    ),
  );
});

test('in a browser, a save whose reload fails after the review ended raises no page error', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        let reload;
        const reloading = new Promise((resolve) => { reload = resolve; });
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        await p.route('**/api/data', async (route) => {
          reload();
          await gate;
          await route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' });
        });
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await reloading;
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        release();
        await p.waitForTimeout(200);
      }),
    ),
  );
});

test('in a browser, the right pane starts by naming the call and the option and depth that its details and form are for', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/admin/report")');
        await p.locator('table.calls tr.option', { hasText: 'withAttachments 켬' }).first().locator('td.cell').nth(1).click();
        const first = p.locator('#right-info > :first-child');
        assert.equal(await first.evaluate((e) => e.className), 'target-id');
        assert.equal(await first.locator('.mono').textContent(), 'POST:/api/v1/report/export');
        assert.match(await first.innerText(), /withAttachments 켬 · UI\/E2E 깊이/);
        assert.match(await p.locator('#right .mark-form h2').textContent(), /^표시 — withAttachments 켬 · UI\/E2E 깊이$/);

        await p.locator('table.calls td.cell').first().click();
        assert.match(await p.locator('#right-info > :first-child').innerText(), /POST:\/api\/v1\/report\/export\s+호출 전체/);

        await p.click('#screen-list li:has-text("/home")');
        assert.equal(await p.locator('#right .target-id').count(), 0);
        assert.equal(await p.locator('#right-info > :first-child h2').textContent(), '이 화면을 열려면');
      }),
    ),
  );
});

const LONG_WORD = `a${'.verylongsegment'.repeat(14)}`;

test('in a browser, long addresses and conditions wrap inside the right pane, which never scrolls sideways', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        assert.equal((await postMark(base, { target: { node: '/document/:id#DocumentDetail' }, status: 'fine', note: LONG_WORD, author: 'reviewer' })).status, 201);
        const longId = `GET:/api/v1/${LONG_WORD}`;
        const labels = Array.from({ length: 5 }, (_, i) => `${LONG_WORD}-${i}`);
        await p.route('**/api/data', async (route) => {
          const text = (await (await route.fetch()).text()).replaceAll('GET:/api/v1/document/{documentId}', longId);
          const data = JSON.parse(text);
          const screen = data.map.screens.find((s) => s.id === '/document/:id#DocumentDetail');
          const file = `components/${LONG_WORD}.js`;
          screen.componentFile = file;
          screen.routeGuards = [LONG_WORD];
          screen.access.links = [
            { from: `/${LONG_WORD}#X`, file, line: 3, guards: [], fromKinds: [] },
            { from: `/${LONG_WORD}#Y`, file, line: 4, guards: [{ guard: LONG_WORD, kinds: [] }], fromKinds: [] },
          ];
          screen.links = [{ route: 'X', line: 2, to: `/${LONG_WORD}`, file, guards: [LONG_WORD], inheritedGuards: [{ via: LONG_WORD, line: 1, guards: [LONG_WORD] }] }];
          screen.settingReads = [{ key: LONG_WORD, line: 3, guards: [], file }];
          for (const c of screen.apiCalls) Object.assign(c, { fn: LONG_WORD, file });
          for (const c of data.map.calls) if (c.id === longId) c.server = { status: 'match', labels, path: `/api/v1/${LONG_WORD}` };
          await route.fulfill({ json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        const widths = () => p.locator('#right-info, #right-dock, #right').evaluateAll((els) => els.map((el) => ({ id: el.id, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })));
        const block = (heading) => p.locator('#right h2', { hasText: heading }).locator('xpath=following-sibling::*[1]');
        const mentions = async (heading, selector) => assert.ok((await block(heading).locator(selector, { hasText: LONG_WORD }).count()) > 0, `${heading} shows the long text in ${selector}`);

        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('#right details.link-group').evaluateAll((gs) => gs.forEach((g) => { g.open = true; }));
        await p.locator('#right details.long-guard').evaluateAll((gs) => gs.forEach((g) => { g.open = true; }));
        await mentions('들어오는 링크', 'code.from');
        assert.ok((await p.locator('#right .access details.link-group code.full', { hasText: LONG_WORD }).count()) > 0, 'a long guard in an incoming link group');
        await mentions('화면 안 조건', 'code.full');
        await mentions('소스 위치', 'code');
        await mentions('나가는 링크', 'code');
        await mentions('나가는 링크', 'code.guard');
        await mentions('읽는 설정값', 'code');
        await openHistory(p);
        assert.ok((await p.locator('#right-dock .history li', { hasText: LONG_WORD }).count()) > 0, 'a long mark note in the history');
        const screen = await widths();
        assert.equal(screen.length, 3);
        for (const w of screen) assert.ok(w.scrollWidth <= w.clientWidth, `screen ${w.id}: ${w.scrollWidth} of ${w.clientWidth}`);

        await p.locator('table.calls td.cell').first().click();
        assert.match(await p.textContent('#right .target-id'), new RegExp(LONG_WORD.replaceAll('.', '\\.')));
        await mentions('서버 대조', 'code');
        assert.equal(await block('서버 대조').locator('.chip').innerText(), `서버에 있음 (${labels.join(', ')})`);
        await mentions('이 화면에서 부르는 곳', 'code');
        for (const w of await widths()) assert.ok(w.scrollWidth <= w.clientWidth, `call ${w.id}: ${w.scrollWidth} of ${w.clientWidth}`);
      }),
    ),
  );
});

const LAB_SETTING = { guard: 'globalSettings.SYSTEM.LAB_ENABLED', kinds: ['setting'], settings: [{ root: 'globalSettings', path: ['SYSTEM', 'LAB_ENABLED'], need: 'on', default: false }] };
const ADMIN_ROLE = { guard: "memberRole === 'ADMIN'", kinds: ['role'], roles: ['ADMIN'] };
const LONG_GUARD = `globalSettings.SYSTEM.MAIN_MENU.LAB.LIST includes 'LAB_EXPERIMENTS_${'WITH_A_VERY_LONG_MENU_KEY_'.repeat(4)}END'`;
const LONG_SETTING = { guard: LONG_GUARD, kinds: ['setting'], settings: [{ root: 'globalSettings', path: ['SYSTEM', 'MAIN_MENU', 'LAB', 'LIST'], need: 'includes', value: 'LAB_EXPERIMENTS' }] };
const IN_SCREEN_GUARD = "location.pathname.startsWith('/lab/experiments/legacy')";
const labLink = (from, file, line, guards) => ({ from, file, line, guards, fromKinds: [] });

async function withLabLinks(fn, { only } = {}) {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let reversed = false;
        await p.route('**/api/data', async (route) => {
          const data = await (await route.fetch()).json();
          const lab = data.map.screens.find((s) => s.id === '/lab#Lab');
          lab.routeGuards = [LAB_SETTING.guard, IN_SCREEN_GUARD];
          const links = [
            labLink('/home#Home', 'components/Home.js', 19, [LAB_SETTING]),
            labLink('/admin/member#AdminMember', 'components/AdminMember.js', 30, [ADMIN_ROLE, LAB_SETTING]),
            labLink('/help#Help', 'components/Help.js', 5, []),
            labLink('/document/:id#DocumentDetail', 'components/DocumentDetail.js', 40, [LAB_SETTING, ADMIN_ROLE]),
            labLink('/admin/group#AdminGroup', 'components/AdminGroup.js', 9, [LAB_SETTING, ADMIN_ROLE]),
            labLink('/signin#SignIn', 'components/SignIn.js', 3, []),
            labLink('/admin/audit#AdminAudit', 'components/AdminAudit.js', 7, [LONG_SETTING]),
          ];
          if (only) links.splice(0, links.length, ...only);
          lab.access.links = reversed ? links.reverse().map((l) => ({ ...l, guards: [...l.guards].reverse() })) : links;
          await route.fulfill({ json: data });
        });
        const open = async () => {
          await p.reload();
          await toList(p);
          await p.waitForSelector('#screen-list li');
          await p.click('#screen-list li:has-text("/lab")');
          return p.locator('#right .access details.link-group');
        };
        await fn(p, open, () => { reversed = true; });
      }),
    ),
  );
}

const groupSummaries = (groups) => groups.locator(':scope > summary').allInnerTexts();

test('in a browser, the incoming links with the same conditions form one group with their number, and opening it shows where each link is and its conditions as written', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    const groups = await open();
    assert.equal(await p.textContent('#right .access h2'), '들어오는 링크 7');
    assert.deepEqual(await groupSummaries(groups), [
      '조건 없음 링크 2',
      '역할 ADMIN · 설정 SYSTEM.LAB_ENABLED 켬 링크 3',
      '설정 SYSTEM.LAB_ENABLED 켬 링크 1',
      '설정 "LAB_EXPERIMENTS" (LAB.LIST 에) 링크 1',
    ]);
    const both = groups.nth(1);
    assert.equal(await both.locator('li').first().isVisible(), false);
    await both.locator(':scope > summary').click();
    const links = await both.locator('li').allInnerTexts();
    assert.equal(links.length, 3);
    assert.match(links[0], /\/admin\/group#AdminGroup\s+components\/AdminGroup\.js:9/);
    for (const text of links) {
      assert.match(text, /globalSettings\.SYSTEM\.LAB_ENABLED\s*설정/);
      assert.match(text, /memberRole === 'ADMIN'\s*역할/);
    }
    await groups.nth(0).locator(':scope > summary').click();
    assert.match(await groups.nth(0).locator('li').first().innerText(), /\/help#Help\s+components\/Help\.js:5/);
  });
});

test('in a browser, a route condition that is neither a setting nor a role is listed apart as not blocking the screen and is left out of the summary', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    await open();
    assert.deepEqual(await p.locator('#right .open-needs .need').allTextContents(), ['설정 SYSTEM.LAB_ENABLED 켬']);
    assert.doesNotMatch(await p.locator('#right .open-needs').innerText(), /location\.pathname/);
    const inScreen = p.locator('#right .in-screen');
    assert.match(await inScreen.locator('h2').innerText(), /^화면 안 조건.*막지 않/);
    assert.deepEqual(await inScreen.locator('code').allTextContents(), [IN_SCREEN_GUARD]);
  });
});

test('in a browser, the groups of incoming links and the links in each come in the same order however the map lists them', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open, reverse) => {
    const order = async (groups) => {
      const out = [];
      for (let i = 0; i < await groups.count(); i++) {
        await groups.nth(i).locator(':scope > summary').click();
        out.push([(await groupSummaries(groups))[i], await groups.nth(i).locator('li > code.from').allTextContents()]);
      }
      return out;
    };
    const first = await order(await open());
    reverse();
    const second = await order(await open());
    assert.deepEqual(second, first);
    assert.deepEqual(first[1][1], ['/admin/group#AdminGroup', '/admin/member#AdminMember', '/document/:id#DocumentDetail']);
  });
});

test('in a browser, a long condition is folded and reads in full once opened', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    const groups = await open();
    const long = groups.nth(3);
    await long.locator(':scope > summary').click();
    const full = long.locator('.long-guard code.full');
    assert.equal(await full.isVisible(), false);
    await long.locator('.long-guard > summary').click();
    assert.equal(await full.isVisible(), true);
    assert.equal(await full.innerText(), LONG_GUARD);
    const box = await full.boundingBox();
    const pane = await p.locator('#right').boundingBox();
    assert.ok(box.x + box.width <= pane.x + pane.width, 'the full condition wraps inside the pane');
  });
});

test('in a browser, links whose conditions read the same but resolve to different roles form separate groups, each summarised by its own roles', { skip: browserMissing }, async () => {
  const canManage = (roles) => ({ guard: 'canManage', kinds: ['role'], roles });
  await withLabLinks(async (p, open) => {
    const groups = await open();
    assert.deepEqual(await groupSummaries(groups), ['역할 ADMIN 외 1 링크 1', '역할 ADMIN 링크 1']);
    for (const g of await groups.all()) assert.equal(await g.locator('li').count(), 1);
  }, { only: [
    labLink('/home#Home', 'components/Home.js', 19, [canManage(['ADMIN', 'OWNER'])]),
    labLink('/help#Help', 'components/Help.js', 5, [canManage(['ADMIN'])]),
  ] });
});

test('in a browser, opened link groups and opened long conditions stay open when the right pane is redrawn, and close again on another screen', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    const groups = await open();
    await groups.nth(0).locator(':scope > summary').click();
    await groups.nth(3).locator(':scope > summary').click();
    await groups.nth(3).locator('.long-guard > summary').click();
    const openState = () => p.locator('#right .access').evaluate((a) => ({
      groups: [...a.querySelectorAll('details.link-group')].map((g) => g.open),
      long: [...a.querySelectorAll('details.long-guard')].map((g) => g.open),
    }));
    const expected = { groups: [true, false, false, true], long: [true] };
    assert.deepEqual(await openState(), expected);
    await p.click('#right .statuses button:has-text("더 필요")');
    assert.deepEqual(await openState(), expected);
    await p.fill('#right textarea', 'redraw');
    await p.click('#right button.save');
    await p.waitForSelector('#center tr.selected td.mark:has-text("더 필요")');
    assert.deepEqual(await openState(), expected);
    await p.click('#screen-list li:has-text("/home")');
    await p.click('#screen-list li:has-text("/lab")');
    assert.deepEqual(await openState(), { groups: [false, false, false, false], long: [false] });
  });
});

test('in a browser, the headings of the incoming links and of the in-screen conditions keep the top margin of the other right-pane headings', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    await open();
    const marginOf = (text) => p.locator('#right h2', { hasText: text }).first().evaluate((e) => getComputedStyle(e).marginTop);
    const source = await marginOf('소스 위치');
    assert.notEqual(source, '0px');
    assert.equal(await marginOf('들어오는 링크'), source);
    assert.equal(await marginOf('화면 안 조건'), source);
  });
});

test('in a browser, the chosen screen shows its calls with the server match and tests by depth, and a mark on a call depth reaches the task list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:tab")');
        assert.deepEqual(await p.locator('table.calls td.call .chip').allTextContents(), ['판정 불가', '서버에 없음']);
        assert.equal(await p.locator('table.calls tr:has-text("판정 불가") td.cell').count(), 0);

        await p.click('#screen-list li:has-text("/document/:id")');
        assert.deepEqual(await p.locator('table.calls td.call .chip').allTextContents(), ['서버에 있음 (core)', '메서드 불일치']);
        const rename = p.locator('table.calls tr', { hasText: 'PUT:/api/v1/document/{documentId}/name' });
        await rename.locator('td.cell').first().click();
        assert.match(await p.textContent('#right .mark-form h2'), /호출 전체/);
        assert.equal(await p.locator('#right .test').count(), 1);
        assert.match(await p.textContent('#right .test'), /rename is refused by the server/);

        await rename.locator('td.cell').nth(2).click();
        assert.match(await p.textContent('#right .mark-form h2'), /API 깊이/);
        assert.equal(await p.locator('#right .test').count(), 0);
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right textarea', 'no API test for the rename');
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.missing');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status, m.author]), [
          [{ node: 'PUT:/api/v1/document/{documentId}/name', depth: 'api' }, 'missing', 'reviewer'],
        ]);
        assert.match(taskList(config), /^## PUT:\/api\/v1\/document\/\{documentId\}\/name\n\n- marks:\n {2}- missing, api depth — "no API test for the rename" \(reviewer, \d{4}-\d\d-\d\d\)$/m);
      }),
    ),
  );
});

test('in a browser, each call shows on and off rows for its options and a no-option row, with empty option rows standing out', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/admin/report")');
        const label = (row) => row.locator('td.call > div:first-child').innerText();
        const rows = p.locator('table.calls tbody tr');
        const labels = [];
        for (let i = 0; i < (await rows.count()); i++) labels.push(await label(rows.nth(i)));
        assert.deepEqual(labels, [
          'POST:/api/v1/report/export',
          'withAttachments 켬', 'withAttachments 끔', 'withHistory 켬', 'withHistory 끔', '옵션 지정 없음',
          'POST:/api/v1/report/archive',
          'signedOnly 켬', 'signedOnly 끔', 'withHistory 켬', 'withHistory 끔', '옵션 지정 없음',
          'POST:/api/v1/report/schedule',
          'weekly 켬', 'weekly 끔', '옵션 지정 없음',
        ]);
        const gaps = [];
        for (const row of await p.locator('table.calls tr.option.gap').all()) gaps.push(await label(row));
        assert.deepEqual(gaps, ['withAttachments 끔', 'signedOnly 끔', 'withHistory 끔', 'weekly 켬', 'weekly 끔']);
        assert.equal(await p.locator('table.calls tr.option.gap td.cell').first().innerText(), '테스트 없음');
        assert.deepEqual(await p.locator('table.calls tr.option:has-text("weekly") .chip').allTextContents(), ['설정', '설정']);

        const exportRows = (text) => p.locator('table.calls tr.option').filter({ hasText: text }).first();
        assert.deepEqual(await exportRows('withHistory 켬').locator('td.cell').allInnerTexts(), ['✓2', '✓2', '—', '—', '—', '—', '—']);
        const none = exportRows('옵션 지정 없음');
        assert.equal(await none.locator('td.cell').count(), 0);
        assert.deepEqual(await none.locator('td.count').allInnerTexts(), ['✓2', '✓2', '—', '—', '—', '—', '—']);

        await exportRows('withHistory 켬').locator('td.cell').nth(1).click();
        assert.match(await p.textContent('#right .mark-form h2'), /withHistory 켬 · UI\/E2E 깊이/);
        assert.equal(await p.locator('#right .test').count(), 2);
        assert.match(await p.locator('#right .option-sites').innerText(), /components\/ExportDialog\.js:18/);

        await exportRows('withHistory 켬').locator('td.cell').nth(6).click();
        assert.match(await p.textContent('#right .mark-form h2'), /withHistory 켬 · 산출물 깊이/);
        assert.equal(await p.locator('#right .test').count(), 0);
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right textarea', 'Open the exported file.');
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.missing');

        await exportRows('withAttachments 끔').locator('td.cell').first().click();
        assert.match(await p.textContent('#right .mark-form h2'), /withAttachments 끔$/);
        await p.click('#right .statuses button:has-text("더 필요")');
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.needs-more');

        await p.locator('table.calls tr.option').filter({ hasText: 'weekly 켬' }).locator('td.cell').first().click();
        assert.match(await p.locator('#right .option-sites').innerText(), /설정에 적음/);

        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]).sort((a, b) => a[1].localeCompare(b[1])), [
          [{ node: 'POST:/api/v1/report/export', option: { key: 'withHistory', value: true }, depth: 'output' }, 'missing'],
          [{ node: 'POST:/api/v1/report/export', option: { key: 'withAttachments', value: false } }, 'needs-more'],
        ]);
        const tasks = taskList(config);
        assert.match(tasks, /^ {2}- missing, withHistory=true at output depth — "Open the exported file\." \(reviewer, \d{4}-\d\d-\d\d\)$/m);
        assert.match(tasks, /^ {4}- withAttachments=false: no tests$/m);

        assert.equal((await postMark(base, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withComments', value: true } }, status: 'missing' })).status, 201);
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.match(await p.locator('#left ul.plain').innerText(), /POST:\/api\/v1\/report\/export withComments=true/);
      }),
    ),
  );
});

test('in a browser, reloading a map with no screens while a call is chosen leaves the page empty instead of failing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls td.cell').first().click();
        assert.equal((await postMark(base, { target: { node: 'GET:/api/v1/member/list' }, status: 'fine' })).status, 201);
        const mapFile = path.join(config.outDir, 'map.json');
        fs.writeFileSync(mapFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(mapFile, 'utf8')), screens: [], entries: [] }));
        await p.evaluate(() => load().then(render));
        assert.equal(await p.textContent('#center'), '화면이 없습니다.');
        assert.equal(await p.textContent('#right'), '');
        assert.equal(await p.evaluate(() => hasUnsavedMark()), false);
      }),
    ),
  );
});

test('in a browser, the output depth row comes after the other depths and takes a mark', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.deepEqual(await p.locator('#center td.depth').allTextContents(), ['화면 전체', 'UI/E2E', 'API', '렌더링만', '코드', '데이터', '산출물']);
        await p.click('#center tr:has-text("산출물")');
        assert.match(await p.locator('#right h2', { hasText: '표시 —' }).textContent(), /산출물 깊이/);
        await p.click('#right .statuses button:has-text("더 필요")');
        await p.click('#right button.save');
        await p.waitForSelector('#center tr.selected td.mark:has-text("더 필요")');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]), [[{ node: '/lab/result#LabResult', depth: 'output' }, 'needs-more']]);
      }),
    ),
  );
});

const screenBox = async (p, id) => {
  const i = await p.$$eval('#flow .box.screen', (els, id) => els.findIndex((e) => e.title.split('\n')[0] === id), id);
  assert.ok(i >= 0, `box ${id} is drawn`);
  return p.locator('#flow .box.screen').nth(i);
};
const boxCount = async (p) => ({ screens: await p.locator('#flow .box.screen').count(), calls: await p.locator('#flow .box.call').count() });
const flowButton = (p, label) => p.locator('.flowbar button', { hasText: label });
const textOutside = (p) => p.$$eval('#flow .box', (els) => els.flatMap((box) => {
  const r = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  const side = (s) => parseFloat(cs[`border${s}Width`]) + parseFloat(cs[`padding${s}`]);
  const inner = { left: r.left + side('Left'), right: r.right - side('Right'), top: r.top + side('Top'), bottom: r.bottom - side('Bottom') };
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const t of range.getClientRects()) {
      if (t.width && (t.left < inner.left - 0.5 || t.right > inner.right + 0.5 || t.top < inner.top - 0.5 || t.bottom > inner.bottom + 0.5)) return [box.title.split('\n')[0]];
    }
  }
  return [];
}));
const layoutErrors = (p) => p.$$eval('#flow .canvas', (canvases) => canvases.flatMap((canvas) => {
  const indent = CALL_INDENT;
  const origin = canvas.getBoundingClientRect();
  const els = new Map([...canvas.querySelectorAll('.box')].map((e) => [e.dataset.key, e]));
  const box = (key) => {
    const r = els.get(key).getBoundingClientRect();
    const top = r.top - origin.top;
    const left = r.left - origin.left;
    return { key, grouped: els.get(key).classList.contains('grouped'), left, right: left + r.width, top, bottom: top + r.height, middle: top + r.height / 2 };
  };
  const edges = [...canvas.querySelectorAll('svg path')].map((path) => ({
    from: box(path.dataset.from), to: box(path.dataset.to), start: path.getPointAtLength(0), end: path.getPointAtLength(path.getTotalLength()),
  }));
  const off = (a, b) => Math.abs(a - b) > 1;
  const errors = [];
  for (const [key, e] of els) {
    const r = e.getBoundingClientRect();
    if (off(r.left - origin.left, parseFloat(e.style.left))) errors.push(`${key} stands at x ${r.left - origin.left}, the layout put it at ${e.style.left}`);
    if (off(r.width, parseFloat(e.style.width))) errors.push(`${key} is ${r.width}px wide, the layout made it ${e.style.width}`);
  }
  for (const { from, to, start, end } of edges) {
    if (off(end.y, to.middle)) errors.push(`the line to ${to.key} ends at ${end.y}, the box's middle is at ${to.middle}`);
    if (off(end.x, to.left)) errors.push(`the line to ${to.key} ends at x ${end.x}, the box's left edge is at ${to.left}`);
    const y = from.grouped ? from.bottom : from.middle;
    if (off(start.y, y)) errors.push(`the line from ${from.key} starts at ${start.y}, not at ${y}`);
    const x = from.grouped ? from.left + indent / 2 : from.right;
    if (off(start.x, x)) errors.push(`the line from ${from.key} starts at x ${start.x}, not at ${x}`);
  }
  const parents = new Set(edges.map((e) => e.from.key));
  for (const parent of parents) {
    const kids = edges.filter((e) => e.from.key === parent).map((e) => e.to).sort((a, b) => a.top - b.top);
    const pairs = kids.slice(1).map((b, i) => [kids[i], b]).filter(([a, b]) => !parents.has(a.key) && !parents.has(b.key));
    if (kids[0].grouped) pairs.unshift([box(parent), kids[0]]);
    for (const [a, b] of pairs) if (off(b.top - a.bottom, GAP)) errors.push(`${b.key} stands ${b.top - a.bottom}px below ${a.key}`);
  }
  return errors;
}));

test('in a browser, the flow graph opens calls and branches, folds them, and a box opens the screen in the list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.equal(await p.isHidden('main'), true);
        await (await screenBox(p, '/signin#SignIn')).locator('button.toggle', { hasText: /^처음으로$/ }).click();
        assert.deepEqual(await boxCount(p), { screens: 11, calls: 0 });

        const home = await screenBox(p, '/home#Home');
        await home.locator('.calls').click();
        assert.deepEqual(await boxCount(p), { screens: 11, calls: 2 });
        assert.match(await home.locator('.calls').textContent(), /▾/);
        await home.locator('.calls').click();

        const signin = await screenBox(p, '/signin#SignIn');
        await signin.locator('button.toggle', { hasText: /^접기$/ }).click();
        assert.deepEqual(await boxCount(p), { screens: 1, calls: 0 });
        const folded = await screenBox(p, '/signin#SignIn');
        assert.match(await folded.locator('.l2').textContent(), /하위 합/);
        await folded.locator('button.toggle', { hasText: /^펼치기$/ }).click();

        await flowButton(p, '모두 펼치기').click();
        assert.deepEqual(await boxCount(p), { screens: 11, calls: 14 });
        const overlaps = await p.$$eval('#flow .box', (boxes) => boxes.flatMap((box) => {
          const outer = box.getBoundingClientRect();
          return [...box.querySelectorAll('.l1, .l3, .acts')].flatMap((line) => [...line.querySelectorAll('button')].filter((b) => {
            const r = b.getBoundingClientRect();
            const text = line.querySelector('.text')?.getBoundingClientRect();
            return r.right > outer.right + 0.5 || r.bottom > outer.bottom + 0.5 || (text && text.right > r.left + 0.5);
          }).map(() => box.title.split('\n')[0]));
        }));
        assert.deepEqual(overlaps, []);

        await flowButton(p, '모두 접기').click();
        assert.deepEqual(await boxCount(p), { screens: 1, calls: 0 });
        await (await screenBox(p, '/signin#SignIn')).locator('button.toggle', { hasText: /^전부 펼치기$/ }).click();
        assert.deepEqual(await boxCount(p), { screens: 11, calls: 14 });

        await (await screenBox(p, '/lab/result#LabResult')).click();
        await p.waitForSelector('main:not([hidden])');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
      }),
    ),
  );
});

const needLines = (box) => box.locator('.need').allTextContents();
const PRESS_HINT = '누르면 목록에서 이 화면을 엽니다';
const tipLines = async (box) => (await box.getAttribute('title')).split('\n').slice(1).filter((line) => line !== PRESS_HINT);

test('in a browser, a flow box writes the roles and settings its screen needs, abridged on the box with the value first and in full on hover', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');

        const audit = await screenBox(p, '/admin/audit#AdminAudit');
        assert.deepEqual(await needLines(audit), ['역할 ADMIN 외 1']);
        assert.deepEqual((await tipLines(audit)).filter((t) => t.startsWith('필요한')), ['필요한 역할: ADMIN, AUDITOR']);

        const group = await screenBox(p, '/admin/group#AdminGroup');
        assert.deepEqual(await needLines(group), ['역할 ADMIN미확인 1']);
        assert.deepEqual((await tipLines(group)).filter((t) => /역할/.test(t)), ['필요한 역할: ADMIN', '읽지 못한 역할 조건: isAdmin']);

        const lab = await screenBox(p, '/lab#Lab');
        assert.deepEqual(await needLines(lab), ['설정 SYSTEM.LAB_ENABLED 켬']);
        assert.deepEqual((await tipLines(lab)).filter((t) => t.startsWith('필요한')), ['필요한 설정: SYSTEM.LAB_ENABLED 켬']);

        const report = await screenBox(p, '/admin/report#AdminReport');
        assert.deepEqual(await needLines(report), ['역할 ADMIN 외 1', '설정 "ADMIN_REPORT" (ADMIN.LIST 에) 외 1']);
        assert.deepEqual(await p.evaluate(() => openNeeds({ access: { settings: [{ from: 'route', unreadable: [], needs: [
          { path: ['SYSTEM', 'MENU'], need: 'present' },
          { path: ['SYSTEM', 'MENU', 'LIST'], need: 'includes', value: 'X' },
        ] }] } }).lines.map((l) => l.text)), ['설정 "X" (MENU.LIST 에) 외 1']);
        assert.deepEqual(await p.evaluate(() => openNeeds({ access: { roleValues: null, unreadableRoleGuards: [] } })), {
          lines: [{ kind: 'role', text: '역할 미확인' }], tips: ['필요한 역할: 미확인'], bare: null,
        });
        assert.deepEqual((await tipLines(report)).filter((t) => t.startsWith('필요한')), [
          '필요한 역할: ADMIN, OWNER',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN.LIST 에 "ADMIN_REPORT"',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN 있음',
        ]);

        assert.deepEqual(await textOutside(p), []);
        const boxes = await p.$$eval('#flow .box', (els) => els.map((e) => ({ id: e.title.split('\n')[0], left: e.offsetLeft, top: e.offsetTop, h: e.offsetHeight })));
        for (const a of boxes) for (const b of boxes) {
          if (a !== b && a.left === b.left) assert.ok(a.top + a.h <= b.top || b.top + b.h <= a.top, `${a.id} and ${b.id} do not overlap`);
        }
      }),
    ),
  );
});

test('in a browser, a flow box sits midway between its first and last child and stays inside the canvas apart from the boxes in its column, whatever the box heights', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const trees = await p.evaluate(() => {
          const sizes = {};
          const openCalls = [];
          const call = (id) => ({ kind: 'call', id });
          const screen = (id, height, children = [], calls = []) => {
            sizes[id] = { width: 100 + id.length * 10, height };
            for (const c of calls) sizes[`${id}>${c.id}`] = { width: 150, height: 44 };
            if (calls.length) openCalls.push(id);
            return { kind: 'screen', id, children, calls, guards: [] };
          };
          const [plain, role, both] = [60, 77, 94];
          const shapes = {
            plainOverCalls: [screen('root', plain, [screen('a', plain, [], [call('a1')]), screen('b', plain, [], [call('b1')])])],
            tallOverOneCall: [screen('root', plain, [screen('tall', role, [], [call('t1')]), screen('next', plain, [screen('grandchild', plain)])])],
            tallOverScreens: [screen('root', plain, [screen('p', both, [screen('p1', plain)]), screen('q', both, [screen('q1', plain)])])],
            tallLast: [screen('tallest', both, [], [call('t1')])],
            tallOverTallOverCall: [screen('root', plain, [screen('x', plain, [], [call('x1')]), screen('outer', both, [screen('inner', role, [], [call('i1')])])])],
          };
          return Object.fromEntries(Object.entries(shapes).map(([name, roots]) => {
            const { boxes, edges, height } = layoutFlow(roots, sizes, { openCalls });
            return [name, { height, edges: edges.map((e) => [e.from, e.y1, e.y2]), boxes: boxes.map((b) => ({ id: b.key, x: b.x, y: b.y, bottom: b.y + b.height })) }];
          }));
        });
        for (const [name, { height, edges, boxes }] of Object.entries(trees)) {
          for (const parent of new Set(edges.map(([from]) => from))) {
            const ends = edges.filter(([from]) => from === parent).map(([, , y2]) => y2);
            const [, y1] = edges.find(([from]) => from === parent);
            assert.equal(y1, (Math.min(...ends) + Math.max(...ends)) / 2, `${name}: the box at ${parent} sits midway between its children`);
          }
          for (const b of boxes) assert.ok(b.y >= 0 && b.bottom <= height, `${name}: ${b.id} is inside the canvas`);
          for (const a of boxes) for (const b of boxes) {
            if (a !== b && a.x === b.x) assert.ok(a.bottom + 12 <= b.y || b.bottom + 12 <= a.y, `${name}: ${a.id} and ${b.id} keep a gap between them`);
          }
        }
      }),
    ),
  );
});

test('in a browser, a flow box says when a setting condition could not be turned into a value', { skip: browserMissing }, async () => {
  const edits = [
    ['client/src/components/DocumentDetail.js', 'const helpEnabled = system.HELP_LINK_ENABLED;', 'const helpEnabled = () => system.HELP_LINK_ENABLED;'],
    ['client/src/components/DocumentDetail.js', '{helpEnabled && <Link', '{helpEnabled() && <Link'],
  ];
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        const help = await screenBox(p, '/help#Help');
        assert.match((await needLines(help)).join('\n'), /미확인 1/);
        assert.ok((await tipLines(help)).some((t) => t.startsWith('정하지 못한 설정 조건: helpEnabled()')));
      }),
    ), edits);
});

test('in a browser, "reset" opens one branch fully with its calls closed and leaves the rest alone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        const reset = async (id) => (await screenBox(p, id)).locator('button.toggle', { hasText: /^처음으로$/ }).click();
        await reset('/signin#SignIn');
        assert.deepEqual(await boxCount(p), { screens: 11, calls: 0 });
        await (await screenBox(p, '/signin#SignIn')).locator('.calls').click();
        const signinCalls = (await boxCount(p)).calls;
        assert.ok(signinCalls > 0);
        await (await screenBox(p, '/lab#Lab')).locator('button.toggle', { hasText: /^접기$/ }).click();
        await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^전부 펼치기$/ }).click();
        assert.ok((await boxCount(p)).calls > signinCalls);

        await reset('/home#Home');
        assert.deepEqual(await boxCount(p), { screens: 11, calls: signinCalls });
        assert.equal(await (await screenBox(p, '/lab#Lab')).locator('button.toggle', { hasText: /^접기$/ }).count(), 1);

        await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^이 가지만$/ }).click();
        await p.waitForSelector('.flowbar .focusing');
        await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^전부 펼치기$/ }).click();
        assert.ok((await boxCount(p)).calls > 0);
        await reset('/home#Home');
        assert.deepEqual(await boxCount(p), { screens: 10, calls: 0 });
        const bare = await p.evaluate(() => {
          const walk = (ns) => ns.flatMap((n) => [n, ...walk(n.children)]);
          return walk(state.focus.roots).find((n) => !n.children.length && !n.calls.length)?.id;
        });
        assert.ok(bare);
        assert.equal(await (await screenBox(p, bare)).locator('button.toggle', { hasText: /^처음으로$/ }).count(), 0);
      }),
    ),
  );
});

test('in a browser, "gaps only" folds exactly the branches with no untested or failing box', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        await p.evaluate(() => {
          const walk = (ns) => ns.flatMap((n) => [n, ...walk(n.children)]);
          const lab = walk(state.data.flow.roots).find((n) => n.id === '/lab#Lab');
          for (const n of walk([lab])) for (const x of [n, ...n.calls]) x.counts = { pass: 1, fail: 0, pending: 0 };
        });
        await flowButton(p, '빈틈만 펼치기').click();
        const lab = await screenBox(p, '/lab#Lab');
        assert.equal(await lab.locator('button.toggle', { hasText: /^펼치기$/ }).count(), 1);
        assert.match(await lab.getAttribute('class'), /s-pass/);
        assert.equal(await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^접기$/ }).count(), 1);
        assert.equal(await p.$$eval('#flow .box.screen', (els) => els.some((e) => e.title.startsWith('/lab/result#'))), false);
      }),
    ),
  );
});

test('in a browser, the page opens on the flow with a summary line counted from tagged tests, and a box with imported tests says so while its border follows its tagged tests', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        assert.equal(await p.isHidden('main'), true);
        assert.equal(await p.getAttribute('#view-flow', 'class'), 'on');
        assert.match(await p.textContent('#meta'), /^화면 11 · 테스트 있는 화면 7 · /);
        assert.equal(await p.textContent('#flow .flowsummary'), '테스트 있는 화면 7/11 · 실패 5 · 태그 없는 테스트만 있는 화면 0');
        const help = await screenBox(p, '/help#Help');
        assert.match(await help.locator('.l2').textContent(), /^✓1 ✕1 ○1 · 불러옴 2/);
        assert.match(await help.getAttribute('class'), /s-fail/);
        assert.doesNotMatch(await (await screenBox(p, '/admin/member#AdminMember')).locator('.l2').textContent(), /불러옴/);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the flow first opens only the way to untested or failing boxes, counts a screen with only imported tests as a gap, and keeps the shape the reviewer leaves across trips to the list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const testsFile = path.join(config.outDir, 'tests.json');
    const tests = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
    const passing = { title: 'passes', file: 'lab.spec.ts', line: 1, status: 'pass' };
    for (const id of ['/lab#Lab', '/lab/result#LabResult', 'GET:/api/v1/lab/experiment']) tests.nodes[id] = [passing];
    tests.importers['/admin/group#AdminGroup'] = [tests.importers['/help#Help'][0]];
    fs.writeFileSync(testsFile, JSON.stringify(tests));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        assert.equal(await p.textContent('#flow .flowsummary'), '테스트 있는 화면 8/11 · 실패 5 · 태그 없는 테스트만 있는 화면 1');
        const lab = await screenBox(p, '/lab#Lab');
        assert.equal(await lab.locator('button.toggle', { hasText: /^펼치기$/ }).count(), 1);
        assert.match(await lab.getAttribute('class'), /s-pass/);
        assert.equal(await p.$$eval('#flow .box.screen', (els) => els.some((e) => e.title.startsWith('/lab/result#'))), false);
        const group = await screenBox(p, '/admin/group#AdminGroup');
        assert.match(await group.locator('.l2').textContent(), /^테스트 없음 · 불러옴 1/);
        assert.match(await group.getAttribute('class'), /s-none/);
        const home = await screenBox(p, '/home#Home');
        assert.equal(await home.locator('button.toggle', { hasText: /^접기$/ }).count(), 1);
        assert.match(await home.locator('.calls').textContent(), /▾/);

        await home.locator('button.toggle', { hasText: /^접기$/ }).click();
        await p.click('#view-list');
        await p.waitForSelector('main:not([hidden])');
        await p.click('#view-flow');
        assert.equal(await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^펼치기$/ }).count(), 1);
        await (await screenBox(p, '/signin#SignIn')).locator('.l2').click();
        await p.waitForSelector('main:not([hidden])');
        await p.click('#view-flow');
        assert.equal(await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^펼치기$/ }).count(), 1);
        assert.match(await (await screenBox(p, '/signin#SignIn')).locator('.calls').textContent(), /▾/);
      }, { view: 'flow' }),
    );
  });
});

const changeData = (edit) => async (page) => {
  await page.route('**/api/data', async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    edit(data);
    await route.fulfill({ response: res, json: data });
  });
};

test('in a browser, when the first flow drawing fails the message stays visible and neither view button changes that', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#failed', { state: 'visible' });
        assert.match(await p.textContent('#failed'), /^페이지를 그리지 못했습니다: ./);
        assert.equal(await p.isHidden('main'), true);
        assert.equal(await p.isHidden('#flow'), true);
        for (const id of ['#view-flow', '#view-list', '#view-flow']) {
          await p.click(id);
          assert.equal(await p.isVisible('#failed'), true);
          assert.equal(await p.isHidden('main'), true);
          assert.equal(await p.isHidden('#flow'), true);
        }
        assert.equal(await p.locator('main section').count(), 3);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots[0].guards = null; }) }),
    ),
  );
});

test('in a browser, a map with no screens says so in the flow, and the entryPaths hint is only for screens with no entry', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .flowsummary');
        assert.match(await p.textContent('#flow'), /entryPaths/);
        assert.doesNotMatch(await p.textContent('#flow'), /화면이 없습니다\./);
      }, { view: 'flow', setup: changeData((data) => {
        data.flow = { ...data.flow, roots: [], unreached: [...data.flow.roots, ...data.flow.unreached] };
      }) }),
    );
    fs.writeFileSync(mapFile, JSON.stringify({ ...map, screens: [], entries: [] }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .flowsummary');
        assert.match(await p.textContent('#flow'), /화면이 없습니다\./);
        assert.doesNotMatch(await p.textContent('#flow'), /entryPaths/);
      }, { view: 'flow' }),
    );
  });
});

test('in a browser, a branch whose only gap is a screen with imported tests and no tagged test is open on first load, and a box lists its imported tests right after its test counts, before its badges', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const testsFile = path.join(config.outDir, 'tests.json');
    const tests = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
    const map = JSON.parse(fs.readFileSync(path.join(config.outDir, 'map.json'), 'utf8'));
    const passing = { title: 'passes', file: 'all.spec.ts', line: 1, status: 'pass' };
    for (const id of [...map.screens.map((x) => x.id), ...map.calls.map((c) => c.id)]) tests.nodes[id] = [passing];
    delete tests.nodes['/lab/result#LabResult'];
    tests.importers = { '/lab/result#LabResult': [passing], '/document/:tab_draft_done_#DocumentList': [passing, passing] };
    fs.writeFileSync(testsFile, JSON.stringify(tests));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        assert.equal(await p.textContent('#flow .flowsummary'), '테스트 있는 화면 10/11 · 실패 0 · 태그 없는 테스트만 있는 화면 1');
        const result = await screenBox(p, '/lab/result#LabResult');
        assert.match(await result.getAttribute('class'), /s-none/);
        assert.match(await result.locator('.l2').textContent(), /^테스트 없음 · 불러옴 1/);
        const dead = await screenBox(p, '/document/:tab_draft_done_#DocumentList');
        assert.match(await dead.locator('.l2').textContent(), / · 불러옴 2 · 죽은 화면$/);
        assert.equal(await (await screenBox(p, '/lab#Lab')).locator('button.toggle', { hasText: /^접기$/ }).count(), 1);
        const home = await screenBox(p, '/home#Home');
        assert.equal(await home.locator('button.toggle', { hasText: /^접기$/ }).count(), 1);
        assert.doesNotMatch(await home.locator('.l2').textContent(), /불러옴/);

        await home.locator('button.toggle', { hasText: /^접기$/ }).click();
        const folded = await screenBox(p, '/home#Home');
        assert.match(await folded.locator('.l2').textContent(), /\(하위 합\) · 불러옴 3/);
      }, { view: 'flow' }),
    );
  });
});

test('in a browser, one branch is shown on its own, and a late answer for an earlier click does not replace the later one', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^이 가지만$/ }).click();
        await p.waitForSelector('.flowbar .focusing');
        assert.match(await p.textContent('.flowbar .focusing'), /^\/home /);
        assert.equal((await boxCount(p)).screens, 10);
        await flowButton(p, '전체 보기').click();
        assert.equal((await boxCount(p)).screens, 11);

        await p.route('**/api/flow?from=*', async (route) => {
          if (route.request().url().includes(encodeURIComponent('/signin#SignIn'))) await new Promise((r) => setTimeout(r, 500));
          await route.continue();
        });
        await (await screenBox(p, '/signin#SignIn')).locator('button.toggle', { hasText: /^이 가지만$/ }).click();
        await (await screenBox(p, '/lab#Lab')).locator('button.toggle', { hasText: /^이 가지만$/ }).click();
        await p.waitForTimeout(800);
        assert.match(await p.textContent('.flowbar .focusing'), /^\/lab /);
      }),
    ),
  );
});

const LONG_ROUTE = '/user-completed-documents/signature-requests/:documentId/participants/history';
const LONG_COMPONENT = 'UserCompletedDocumentParticipantHistory';
const walkFlow = (ns) => ns.flatMap((n) => [n, ...walkFlow(n.children)]);
const withLongRoute = (data) => {
  const help = walkFlow(data.flow.roots).find((n) => n.id === '/help#Help');
  help.label = LONG_ROUTE;
  help.component = LONG_COMPONENT;
  help.jumps.push({ to: '/document/:id#DocumentDetail', label: '/user-completed-documents/signature-requests/:documentId', guards: [] });
};
const leafEntries = (data, count) => {
  const leaves = walkFlow(data.flow.roots).filter((n) => !n.children.length);
  return Array.from({ length: count }, (_, i) => ({ ...structuredClone(leaves[i % leaves.length]), id: `/extra/${i}#Extra${i}`, label: `/extra/${i}`, guards: [] }));
};
const flowBoxes = (p) => p.$$eval('#flow .box', (els) => els.map((e) => {
  const r = e.getBoundingClientRect();
  return { id: e.title.split('\n')[0], left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, grouped: e.classList.contains('grouped') };
}));
const overlapping = (boxes) => boxes.flatMap((a, i) => boxes.slice(i + 1)
  .filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
  .map((b) => `${a.id} / ${b.id}`));
const WIDE_COMPONENT = 'UserCompletedDocumentSignatureRequestParticipantHistoryOverview';

test('in a browser, a flow box without role or setting conditions has no extra line, and every box stands where the layout put it, each line ending at the middle of its box and boxes under one another keeping the layout\'s gap', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        const home = await screenBox(p, '/home#Home');
        assert.equal(await home.locator('.need').count(), 0);
        assert.deepEqual(await tipLines(home), []);
        assert.equal(await (await screenBox(p, '/admin/audit#AdminAudit')).locator('.need').count(), 1);
        await flowButton(p, '모두 펼치기').click();
        assert.ok(await p.locator('#flow .box.call.grouped').count() > 0, 'a gathered entry screen shows its calls');
        assert.deepEqual(await layoutErrors(p), []);
        assert.deepEqual(await textOutside(p), []);
      }, { setup: changeData((data) => {
        withLongRoute(data);
        const extras = leafEntries(data, 3);
        extras[0].label = LONG_ROUTE;
        extras[1].component = WIDE_COMPONENT;
        data.flow.roots.push(...extras);
      }) }),
    ),
  );
});

test('in a browser, a column is as wide as a component name longer than 360px needs, and the boxes it widens still stand where the layout put them', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        await flowButton(p, '모두 펼치기').click();
        const home = await (await screenBox(p, '/home#Home')).evaluate((box) => {
          const text = box.querySelector('.l1 .text').getBoundingClientRect();
          const name = box.querySelector('.l1 .component');
          return { width: box.getBoundingClientRect().width, text: text.width, name: name.getBoundingClientRect().width, nameLines: name.getClientRects().length };
        });
        assert.ok(home.width > 360, 'the box is wider than 360px');
        assert.equal(home.nameLines, 1);
        assert.ok(Math.abs(home.text - home.name) <= 1, 'the box is no wider than the name needs');
        const boxes = await flowBoxes(p);
        const left = boxes.find((b) => b.id === '/home#Home').left;
        assert.deepEqual([...new Set(boxes.filter((b) => b.left === left).map((b) => b.width))], [home.width]);
        assert.deepEqual(await layoutErrors(p), []);
        assert.deepEqual(await textOutside(p), []);
        assert.deepEqual(overlapping(boxes), []);
      }, { view: 'flow', setup: changeData((data) => {
        withLongRoute(data);
        walkFlow(data.flow.roots).find((n) => n.id === '/home#Home').component = WIDE_COMPONENT;
      }) }),
    ),
  );
});

test('in a browser, opening the API calls of a gathered entry screen leaves every cell where it was, and the calls wrap inside the cell', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const cells = () => p.$$eval('#flow .box.screen.grouped', (els) => els.map((e) => ({ id: e.title.split('\n')[0], left: e.offsetLeft, width: e.offsetWidth, top: e.offsetTop })));
        const calls = () => p.locator('#flow .box.screen.grouped').first().locator('.calls');
        if ((await calls().textContent()).includes('▾')) await calls().click();
        const closed = await cells();
        assert.equal(closed[0].id, '/extra/0#Extra0');
        await calls().click();
        assert.match(await calls().textContent(), /▾/);
        const open = await cells();
        assert.deepEqual(open.map(({ id, left, width }) => ({ id, left, width })), closed.map(({ id, left, width }) => ({ id, left, width })));
        assert.equal(open[0].top, closed[0].top);
        const callWidths = await p.$$eval('#flow .box.call.grouped', (els) => els.filter((e) => e.dataset.key.startsWith('/extra/0#Extra0>')).map((e) => e.offsetWidth));
        assert.ok(callWidths.length > 0);
        assert.deepEqual([...new Set(callWidths)], [closed[0].width - (await p.evaluate(() => CALL_INDENT))]);
        assert.deepEqual(await textOutside(p), []);
        assert.deepEqual(await layoutErrors(p), []);
        assert.deepEqual(overlapping(await flowBoxes(p)), []);
      }, { view: 'flow', setup: changeData((data) => {
        const extras = leafEntries(data, 8);
        extras[0].calls[0].label += '/usercompleteddocumentsignaturerequestsparticipantshistoryoverview';
        data.flow.roots.push(...extras);
      }) }),
    ),
  );
});

test('in a browser, a call under a gathered entry screen wraps every line inside its box, a long server label included', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const toggle = (await screenBox(p, '/extra/0#Extra0')).locator('.calls');
        if (!(await toggle.textContent()).includes('▾')) await toggle.click();
        const call = p.locator('#flow .box.call.grouped[data-key^="/extra/0#Extra0>"]').first();
        assert.match(await call.locator('.l2').textContent(), /UserCompletedDocumentSignatureRequestController\.getParticipantHistoryOverview/);
        assert.ok(await call.evaluate((e) => e.scrollWidth <= e.clientWidth), 'the call box holds its second line');
        assert.deepEqual(await textOutside(p), []);
        assert.deepEqual(overlapping(await flowBoxes(p)), []);
      }, { view: 'flow', setup: changeData((data) => {
        const extras = leafEntries(data, 8);
        extras[0].calls[0].server = { status: 'match', labels: ['UserCompletedDocumentSignatureRequestController.getParticipantHistoryOverview'] };
        data.flow.roots.push(...extras);
      }) }),
    ),
  );
});

test('in a browser, resizing the window after the review ended throws nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: 'reviewer', onDone: () => {} });
    try {
      await withPage(`http://127.0.0.1:${server.address().port}`, async (p) => {
        await p.waitForSelector('#flow .group-head');
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        await p.setViewportSize({ width: 900, height: 700 });
        await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) });
    } finally {
      server.close();
    }
  });
});

test('in a browser, the flow is drawn again on a resize only when gathered entry screens are shown and the number of cells in a row changes', { skip: browserMissing }, async () => {
  const frames = (p) => p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const mark = (p) => p.evaluate(() => { document.querySelector('#flow .box').dataset.before = ''; });
  const kept = (p) => p.evaluate(() => document.querySelector('#flow .box[data-before]') !== null);
  const resize = async (p, width, height) => {
    await p.setViewportSize({ width, height });
    await frames(p);
  };
  const perRow = (p) => p.evaluate(() => drawnGrid.per);
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const wide = await perRow(p);
        await mark(p);
        await resize(p, 1430, 600);
        assert.equal(await perRow(p), wide);
        assert.ok(await kept(p), 'a small change of width that keeps the number of cells in a row keeps the drawing');
        await resize(p, 1000, 600);
        assert.ok(await perRow(p) < wide, 'a narrower window holds fewer cells in a row');
        assert.ok(!(await kept(p)), 'a change that alters the number of cells in a row draws the gathered entry screens again');
        await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^이 가지만$/ }).click();
        await p.waitForSelector('.flowbar .focusing');
        await mark(p);
        await resize(p, 800, 600);
        assert.ok(await kept(p), 'one branch shown on its own is not drawn again');
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        assert.equal(await p.locator('#flow .group-head').count(), 0);
        await mark(p);
        await resize(p, 900, 900);
        assert.ok(await kept(p), 'with nothing gathered the width does not change the drawing');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a flow box with a long route breaks it only before a slash, keeps its component name whole, and no box cuts or spills its text', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        await flowButton(p, '모두 펼치기').click();
        const help = await (await screenBox(p, '/help#Help')).evaluate((box, [route, component]) => {
          const texts = [];
          const walker = document.createTreeWalker(box.querySelector('.l1 .text'), NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) texts.push(walker.currentNode);
          const chars = texts.flatMap((node) => [...node.data].map((ch, i) => {
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            return { ch, top: Math.round(range.getBoundingClientRect().top) };
          }));
          const whole = chars.map((c) => c.ch).join('');
          const at = whole.indexOf(route);
          const routeChars = chars.slice(at, at + route.length);
          const lineStarts = routeChars.filter((c, i) => i > 0 && c.top > routeChars[i - 1].top).map((c) => c.ch);
          const from = whole.indexOf(component);
          return {
            found: at >= 0 && from >= 0,
            routeLines: new Set(routeChars.map((c) => c.top)).size,
            lineStarts,
            componentLines: new Set(chars.slice(from, from + component.length).map((c) => c.top)).size,
            text: box.textContent,
          };
        }, [LONG_ROUTE, LONG_COMPONENT]);
        assert.ok(help.found, 'the route and the component name are written on the box');
        assert.ok(help.routeLines > 1, 'the long route takes more than one line');
        assert.deepEqual([...new Set(help.lineStarts)], ['/']);
        assert.equal(help.componentLines, 1);
        assert.match(help.text, /→ \/user-completed-documents\/signature-requests\/:documentId/);

        const cut = await p.$$eval('#flow .box', (els) => els
          .filter((box) => box.textContent.includes('…') || [box, ...box.querySelectorAll('*')].some((e) => getComputedStyle(e).textOverflow === 'ellipsis'))
          .map((box) => box.title.split('\n')[0]));
        assert.deepEqual(cut, []);
        assert.deepEqual(await textOutside(p), []);
      }, { view: 'flow', setup: changeData(withLongRoute) }),
    ),
  );
});

test('in a browser, the fold and branch buttons of a flow box carry a word and a longer explanation instead of a symbol', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        await flowButton(p, '모두 펼치기').click();
        const labels = (box) => box.locator('button.toggle').evaluateAll((els) => els.map((e) => [e.textContent, e.title]));
        const signin = await labels(await screenBox(p, '/signin#SignIn'));
        assert.deepEqual(signin.map(([word]) => word), ['접기', '전부 펼치기', '처음으로', '이 가지만']);
        assert.ok(signin.every(([word, title]) => title.length > word.length), 'each title explains more than the word');
        assert.doesNotMatch(signin[0][1], /API/, 'the fold title names no API call: a screen with child screens may have none');
        assert.match(signin[0][1], /딸린/);
        await (await screenBox(p, '/signin#SignIn')).locator('button.toggle', { hasText: /^접기$/ }).click();
        const folded = await labels(await screenBox(p, '/signin#SignIn'));
        assert.deepEqual(folded.map(([word]) => word), ['펼치기', '전부 펼치기', '처음으로', '이 가지만']);
        assert.doesNotMatch(folded[0][1], /API/);
        assert.match(folded[0][1], /딸린/);
        const symbols = await p.$$eval('#flow .box button', (els) => els.map((e) => e.textContent).filter((t) => /[−+»↺◎]/.test(t)));
        assert.deepEqual(symbols, []);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a flow box with buttons still shows its whole route and component name, with the buttons on a line of their own', { skip: browserMissing }, async () => {
  const longName = (data) => {
    const signin = walkFlow(data.flow.roots).find((n) => n.id === '/signin#SignIn');
    signin.label = LONG_ROUTE;
    signin.component = WIDE_COMPONENT;
  };
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        await flowButton(p, '모두 펼치기').click();
        assert.ok(await (await screenBox(p, '/signin#SignIn')).locator('button.toggle').count() >= 3);
        assert.deepEqual(await textOutside(p), []);
        const cut = await p.$$eval('#flow .box', (els) => els
          .filter((box) => box.textContent.includes('…') || [box, ...box.querySelectorAll('*')].some((e) => getComputedStyle(e).textOverflow === 'ellipsis'))
          .map((box) => box.title.split('\n')[0]));
        assert.deepEqual(cut, []);
        const lines = await (await screenBox(p, '/signin#SignIn')).evaluate((box) => {
          const name = box.querySelector('.l1').getBoundingClientRect();
          const acts = box.querySelector('.acts').getBoundingClientRect();
          return { componentRects: box.querySelector('.component').getClientRects().length, below: acts.top >= name.bottom - 0.5, boxWidth: box.getBoundingClientRect().width, componentWidth: box.querySelector('.component').getBoundingClientRect().width };
        });
        assert.equal(lines.componentRects, 1);
        assert.ok(lines.below, 'the buttons sit under the name line');
        assert.ok(lines.componentWidth <= lines.boxWidth, 'the component name fits within the box');
      }, { view: 'flow', setup: changeData(longName) }),
    ),
  );
});

test('in a browser, the explanation above the flow is hidden on opening and an info button shows it on hover, on click and from the keyboard', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        const legend = p.locator('#flowlegend');
        assert.equal(await legend.count(), 1);
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');
        assert.equal(await info.getAttribute('aria-controls'), 'flowlegend');

        await info.hover();
        assert.equal(await legend.isVisible(), true);
        assert.match(await legend.textContent(), /불러옴 N/);
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), false);

        await info.click();
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), true);
        assert.equal(await info.getAttribute('aria-expanded'), 'true');
        await info.click();
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');

        await info.focus();
        await p.keyboard.press('Enter');
        assert.equal(await legend.isVisible(), true);
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');
        await p.keyboard.press('Space');
        assert.equal(await legend.isVisible(), true);
        await p.keyboard.press('Space');
        assert.equal(await legend.isVisible(), false);

        await flowButton(p, '빈틈만 펼치기').focus();
        await p.keyboard.press('Tab');
        assert.equal(await info.evaluate((e) => e === document.activeElement), true, 'Tab reaches the info button');
        await p.keyboard.press('Enter');
        assert.equal(await legend.isVisible(), true);
        await flowButton(p, '모두 접기').click();
        assert.equal(await legend.isVisible(), true, 'a redraw keeps the explanation open');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the explanation shows on hover after a keyboard close and never has a native tooltip, and the fold button says what it hides without claiming API calls', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        const legend = p.locator('#flowlegend');
        assert.equal(await info.getAttribute('title'), null);
        const fold = await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^접기$/ }).getAttribute('title');
        assert.match(fold, /이 화면에 딸린 것을 숨깁니다/);
        assert.doesNotMatch(fold, /API/);

        await p.mouse.move(600, 600);
        await info.focus();
        await p.keyboard.press('Enter');
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false);
        await info.hover();
        assert.equal(await legend.isVisible(), true, 'hover shows it after a keyboard close');
        assert.equal(await info.getAttribute('aria-expanded'), 'true', 'aria-expanded says what is displayed on hover');
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');

        await p.keyboard.press('Enter');
        await p.keyboard.press('Enter');
        await info.hover();
        assert.equal(await legend.isVisible(), true, 'hover shows it after closing with Enter again');

        await info.click();
        assert.equal(await legend.isVisible(), true);
        await info.click();
        assert.equal(await legend.isVisible(), false, 'closing with the pointer on it keeps it closed');
        assert.equal(await info.getAttribute('aria-expanded'), 'false');
        await p.evaluate(() => { renderFlow(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
        assert.equal(await legend.isVisible(), false, 'a redraw keeps the close while the pointer stays on it');
        await p.mouse.move(600, 600);
        await info.hover();
        assert.equal(await legend.isVisible(), true);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the explanation stays inside the flow area at a narrow window', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 800, height: 600 });
        await p.waitForSelector('#flow .box');
        await p.locator('.flowbar button.flowinfo-button').hover();
        const edges = await p.evaluate(() => {
          const flow = document.getElementById('flow').getBoundingClientRect();
          const legend = document.getElementById('flowlegend').getBoundingClientRect();
          return { left: legend.left - flow.left, right: legend.right - flow.left, width: document.getElementById('flow').clientWidth };
        });
        assert.ok(edges.left >= 0, `left edge ${edges.left}`);
        assert.ok(edges.right <= edges.width, `right edge ${edges.right} within ${edges.width}`);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, Escape closes the explanation only while the flow view is showing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        const legend = p.locator('#flowlegend');
        await info.click();
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), true);
        await p.click('#view-list');
        await p.keyboard.press('Escape');
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.equal(await legend.isVisible(), true, 'Escape in the list view leaves it pinned');
        assert.equal(await info.getAttribute('aria-expanded'), 'true');

        await p.evaluate(() => document.addEventListener('keydown', (e) => e.preventDefault(), { once: true, capture: true }));
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), true, 'an Escape already handled elsewhere does not close it');
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, pressing Escape after the review ended throws nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: 'reviewer', onDone: () => {} });
    try {
      await withPage(`http://127.0.0.1:${server.address().port}`, async (p) => {
        await p.waitForSelector('#flow .box');
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        await p.keyboard.press('Escape');
        await p.keyboard.press('Escape');
      }, { view: 'flow' });
    } finally {
      server.close();
    }
  });
});

test('in a browser, the info icon stands at the right end of the bar apart from the expand and fold buttons, drawn as an icon with an accessible name', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 800 });
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        assert.equal(await info.getAttribute('aria-label'), '흐름도 읽는 법');
        assert.match((await info.textContent()).trim(), /^(i|ⓘ)$/, 'the only visible text is the icon glyph');
        const gaps = await p.evaluate(() => {
          const bar = document.querySelector('.flowbar').getBoundingClientRect();
          const icon = document.querySelector('.flowinfo-button').getBoundingClientRect();
          const last = [...document.querySelectorAll('.flowbar button')].find((b) => b.textContent === '빈틈만 펼치기').getBoundingClientRect();
          const controls = [...document.querySelectorAll('.flowbar button')].map((b) => b.getBoundingClientRect());
          return { gap: icon.left - last.right, toBarEdge: bar.right - icon.right, rightmost: Math.max(...controls.map((r) => r.right)) === icon.right, round: Math.abs(icon.width - icon.height) < 0.5 && icon.width <= 28 };
        });
        assert.ok(gaps.gap > 200, `the icon is ${gaps.gap}px right of 「빈틈만 펼치기」`);
        assert.ok(gaps.toBarEdge <= 20, `the icon is ${gaps.toBarEdge}px from the bar's right edge`);
        assert.ok(gaps.rightmost, 'the icon is the right-most control');
        assert.ok(gaps.round, 'a small round button');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the info icon is the last control of its row when a branch is shown on its own, and the bar spans the visible width of the flow area', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 800 });
        await p.waitForSelector('#flow .box');
        await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^이 가지만$/ }).click();
        await p.waitForSelector('.flowbar .focusing');
        const rows = await p.evaluate(() => {
          const icon = document.querySelector('.flowinfo-button').getBoundingClientRect();
          const same = [...document.querySelectorAll('.flowbar button, .flowbar .focusing')].filter((e) => {
            const r = e.getBoundingClientRect();
            return r.top < icon.bottom && r.bottom > icon.top;
          });
          const lastRight = Math.max(...same.map((e) => e.getBoundingClientRect().right));
          return { lastRight, iconRight: icon.right };
        });
        assert.equal(rows.lastRight, rows.iconRight, 'nothing sits to the right of the icon on its row');
        await p.setViewportSize({ width: 700, height: 600 });
        await flowButton(p, '전체 보기').click();
        await flowButton(p, '모두 펼치기').click();
        await p.evaluate(() => { document.getElementById('flow').scrollLeft = 300; });
        const m = await p.evaluate(() => {
          const flow = document.getElementById('flow');
          const bar = document.querySelector('.flowbar').getBoundingClientRect();
          const box = flow.getBoundingClientRect();
          return { scrollWidth: flow.scrollWidth, clientWidth: flow.clientWidth, barLeft: bar.left - box.left, barRight: bar.right - box.left };
        });
        assert.ok(m.scrollWidth > m.clientWidth, `the flow scrolls sideways (${m.scrollWidth} in ${m.clientWidth})`);
        assert.ok(Math.abs(m.barLeft) <= 0.5, `bar left ${m.barLeft}`);
        assert.ok(Math.abs(m.barRight - m.clientWidth) <= 0.5, `bar right ${m.barRight} against visible width ${m.clientWidth}`);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the legend samples, the info icon and its explanation stay inside the visible box of the flow area when everything is expanded and the flow is scrolled sideways', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 700, height: 600 });
        await p.waitForSelector('#flow .box');
        await flowButton(p, '모두 펼치기').click();
        const info = p.locator('.flowbar button.flowinfo-button');
        const frames = () => p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const edges = () => p.evaluate(() => {
          const flow = document.getElementById('flow');
          const box = flow.getBoundingClientRect();
          const rel = (r) => ({ left: r.left - box.left, right: r.right - box.left });
          return { visible: flow.clientWidth, scrolled: flow.scrollLeft, scrollWidth: flow.scrollWidth, icon: rel(document.querySelector('.flowinfo-button').getBoundingClientRect()), legend: rel(document.getElementById('flowlegend').getBoundingClientRect()), key: [...document.querySelectorAll('.flowkey li')].map((li) => rel(li.getBoundingClientRect())) };
        });
        const within = (e, { legendOpen = true } = {}) => {
          assert.equal(e.scrolled, 300, `the flow is scrolled sideways (${e.scrolled} of ${e.scrollWidth})`);
          assert.ok(e.icon.left >= 0 && e.icon.right <= e.visible, `icon ${e.icon.left}..${e.icon.right} within ${e.visible}`);
          if (legendOpen) {
            assert.ok(e.legend.left >= 0, `legend left edge ${e.legend.left}`);
            assert.ok(e.legend.right <= e.visible, `legend right edge ${e.legend.right} within ${e.visible}`);
          }
          assert.equal(e.key.length, 5);
          for (const r of e.key) assert.ok(r.left >= 0 && r.right <= e.visible, `sample ${r.left}..${r.right} within ${e.visible}`);
        };

        await p.evaluate(() => { document.getElementById('flow').scrollLeft = 300; });
        await frames();
        assert.equal(await p.locator('#flowlegend').isVisible(), false);
        within(await edges(), { legendOpen: false });

        await info.click();
        await p.mouse.move(600, 500);
        await p.evaluate(() => { document.getElementById('flow').scrollLeft = 300; });
        await frames();
        assert.equal(await p.locator('#flowlegend').isVisible(), true);
        within(await edges());

        await info.click();
        await p.mouse.move(600, 500);
        await p.evaluate(() => { document.getElementById('flow').scrollLeft = 300; });
        await frames();
        await info.hover();
        await frames();
        assert.equal(await p.locator('#flowlegend').isVisible(), true);
        within(await edges());
      }, { view: 'flow' }),
    ),
  );
});

const travelDown = async (p, info, legend, column = 'center') => {
  await info.hover();
  assert.equal(await legend.isVisible(), true);
  const button = await info.boundingBox();
  const text = await legend.boundingBox();
  const x = button.x + { left: 0.5, center: button.width / 2, right: button.width - 0.5 }[column];
  const from = button.y + button.height / 2;
  const to = text.y + 20;
  assert.ok(to > from);
  for (let y = from; y <= to; y += 1) {
    await p.mouse.move(x, y);
    assert.equal(await legend.isVisible(), true, `the explanation is gone with the pointer at x=${x}, y=${y} (icon bottom ${button.y + button.height}, explanation top ${text.y})`);
  }
  assert.equal(await p.evaluate(() => document.getElementById('flowlegend').matches(':hover')), true, 'the pointer is on the explanation');
};

test('in a browser, the pointer can travel from the info icon down into the explanation without it disappearing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        for (const column of ['center', 'left', 'right']) await travelDown(p, p.locator('.flowbar button.flowinfo-button'), p.locator('#flowlegend'), column);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the pointer can travel from the info icon into the explanation when the bar wraps onto several lines at a 500px window with one branch shown', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 500, height: 700 });
        await p.waitForSelector('#flow .box');
        await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^이 가지만$/ }).click();
        await p.waitForSelector('.flowbar .focusing');
        const rows = await p.evaluate(() => new Set([...document.querySelectorAll('.flowbar > *')].map((e) => Math.round(e.getBoundingClientRect().top))).size);
        assert.ok(rows >= 3, `the bar wraps onto ${rows} lines`);
        const info = p.locator('.flowbar button.flowinfo-button');
        await travelDown(p, info, p.locator('#flowlegend'));
        const e = await p.evaluate(() => {
          const flow = document.getElementById('flow');
          const box = flow.getBoundingClientRect();
          const legend = document.getElementById('flowlegend').getBoundingClientRect();
          const icon = document.querySelector('.flowinfo-button').getBoundingClientRect();
          return { visible: flow.clientWidth, left: legend.left - box.left, right: legend.right - box.left, iconRight: icon.right - box.left, iconBottom: icon.bottom, legendTop: legend.top };
        });
        assert.ok(e.left >= 0 && e.right <= e.visible, `legend ${e.left}..${e.right} within ${e.visible}`);
        assert.ok(e.iconRight <= e.visible, 'the icon is in view');
        assert.ok(e.legendTop >= e.iconBottom, 'the explanation opens under the icon');
      }, { view: 'flow' }),
    ),
  );
});

const KEY_LABELS = ['통과', '실패', '보류', '테스트 없음', '조건 걸린 링크'];

test('in a browser, the flow bar always shows a legend of five samples between the fold buttons and the info icon', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 800 });
        await p.waitForSelector('#flow .box');
        const key = p.locator('.flowbar ul.flowkey');
        assert.equal(await key.isVisible(), true);
        assert.equal(await key.getAttribute('aria-label'), '흐름도 범례');
        assert.deepEqual(await key.locator('li .key-label').allTextContents(), KEY_LABELS);
        assert.equal(await key.locator('li [aria-hidden="true"]').count(), 5, 'every drawn sample is hidden from a screen reader');
        assert.deepEqual(await key.locator('li').evaluateAll((items) => items.map((li) => li.textContent.trim())), ['테두리 통과', '테두리 실패', '테두리 보류', '테두리 테스트 없음', '조건 걸린 링크']);
        const m = await p.evaluate(() => {
          const rect = (e) => e.getBoundingClientRect();
          const items = [...document.querySelectorAll('.flowkey li')].map(rect);
          const icon = rect(document.querySelector('.flowinfo-button'));
          const last = rect([...document.querySelectorAll('.flowbar button')].find((b) => b.textContent === '빈틈만 펼치기'));
          return { left: Math.min(...items.map((r) => r.left)), right: Math.max(...items.map((r) => r.right)), tops: new Set(items.map((r) => Math.round(r.top + r.height / 2))).size, iconLeft: icon.left, lastRight: last.right, legendShown: getComputedStyle(document.getElementById('flowlegend')).display };
        });
        assert.ok(m.left > m.lastRight, `the legend starts at ${m.left}, right of 「빈틈만 펼치기」 ending at ${m.lastRight}`);
        assert.ok(m.right <= m.iconLeft, `the legend ends at ${m.right}, left of the icon at ${m.iconLeft}`);
        assert.ok(m.iconLeft - m.right <= 16, 'the legend sits next to the icon');
        assert.equal(m.tops, 1, 'the five samples are on one line at 1440px');
        assert.equal(m.legendShown, 'none', 'the samples show without opening the explanation');
        const before = await p.evaluate(() => document.querySelector('.canvas').getBoundingClientRect().top);
        await p.locator('.flowbar button.flowinfo-button').click();
        assert.equal(await p.evaluate(() => document.querySelector('.canvas').getBoundingClientRect().top), before, 'opening the explanation does not move the diagram');
        assert.deepEqual(await key.locator('li .key-label').allTextContents(), KEY_LABELS);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, each legend sample is drawn with the border of the boxes and the dash of the guarded links it stands for', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const { pairs, dashes } = await p.evaluate(() => {
          const border = (e) => { const c = getComputedStyle(e); return [c.borderTopColor, c.borderTopStyle, c.borderTopWidth].join(' '); };
          const canvas = document.querySelector('.canvas');
          const out = {};
          for (const cls of ['s-pass', 's-fail', 's-pending', 's-none']) {
            const box = document.createElement('div');
            box.className = `box ${cls}`;
            canvas.append(box);
            out[cls] = [border(document.querySelector(`.flowkey .swatch.${cls}`)), border(box)];
            box.remove();
          }
          const edge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          edge.setAttribute('class', 'guarded');
          canvas.querySelector('svg').append(edge);
          const stroke = (e) => { const c = getComputedStyle(e); return [c.stroke, c.strokeDasharray, c.strokeWidth].join(' '); };
          out.guarded = [stroke(document.querySelector('.flowkey svg path')), stroke(edge)];
          const dashes = [document.querySelector('.flowkey svg path'), edge].map((e) => getComputedStyle(e).strokeDasharray);
          edge.remove();
          return { pairs: out, dashes };
        });
        for (const [name, [sample, real]] of Object.entries(pairs)) assert.equal(sample, real, name);
        assert.equal(new Set(['s-pass', 's-fail', 's-pending', 's-none'].map((c) => pairs[c][0])).size, 4, 'the four border samples differ');
        for (const dash of dashes) assert.match(dash, /^\d+(\.\d+)?(px)?,? \d+(\.\d+)?(px)?$/, `a dash of two lengths, not ${dash}`);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the explanation behind the info icon holds only the jump and the imported-test samples, and no sentence of the old prose is left on the page', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 800 });
        await p.waitForSelector('#flow .box');
        await p.locator('.flowbar button.flowinfo-button').click();
        const legend = p.locator('#flowlegend');
        assert.equal(await legend.evaluate((e) => e.tagName), 'UL');
        assert.deepEqual(await legend.locator('li').evaluateAll((items) => items.map((li) => [...li.children].map((c) => c.textContent))), [
          ['→ /주소', '다른 가지에 이미 그린 화면으로 가는 링크'],
          ['불러옴 N', '태그 없이 이 화면을 불러오는 단위 테스트테두리와 테스트 수에는 넣지 않음'],
        ]);
        assert.equal(await legend.locator('li small').textContent(), '테두리와 테스트 수에는 넣지 않음');
        const page = await p.evaluate(() => document.body.textContent);
        for (const old of ['진입 화면에서 링크를 따라', '처음 닿은 자리에 한 번만', '상자의 「API」 단추로', '점선: 설정·역할 조건이 걸린 링크', '상자 테두리: 붙은 테스트']) assert.equal(page.includes(old), false, old);
        const box = await p.evaluate(() => {
          const flow = document.getElementById('flow').getBoundingClientRect();
          const e = document.getElementById('flowlegend');
          const r = e.getBoundingClientRect();
          return { left: r.left - flow.left, right: r.right - flow.left, width: r.width, visible: document.getElementById('flow').clientWidth, overflowing: [...e.querySelectorAll('li')].filter((li) => li.scrollWidth > li.clientWidth).length };
        });
        assert.ok(box.width <= 320, `the explanation is ${box.width}px wide`);
        assert.ok(box.left >= 0 && box.right <= box.visible, `explanation ${box.left}..${box.right} within ${box.visible}`);
        assert.equal(box.overflowing, 0, 'nothing in the explanation is cut off');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, at a 500px window the bar with its legend stays within the flow area, no legend label is split inside a word and the explanation is in view', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 500, height: 700 });
        await p.waitForSelector('#flow .box');
        await p.locator('.flowbar button.flowinfo-button').click();
        const m = await p.evaluate(() => {
          const flow = document.getElementById('flow');
          const box = flow.getBoundingClientRect();
          const bar = document.querySelector('.flowbar');
          const rel = (e) => { const r = e.getBoundingClientRect(); return { left: r.left - box.left, right: r.right - box.left, top: r.top, bottom: r.bottom }; };
          const icon = rel(document.querySelector('.flowinfo-button'));
          const sameLine = [...bar.querySelectorAll('button, .flowkey li')].map(rel).filter((r) => r.top < icon.bottom && r.bottom > icon.top);
          return {
            visible: flow.clientWidth, barScroll: bar.scrollWidth, barClient: bar.clientWidth,
            labels: [...document.querySelectorAll('.flowkey .key-label')].map((e) => [e.textContent, e.getClientRects().length]),
            items: [...document.querySelectorAll('.flowkey li')].map(rel), icon, legend: rel(document.getElementById('flowlegend')),
            iconIsLast: Math.max(...sameLine.map((r) => r.right)) === icon.right,
          };
        });
        assert.ok(m.barScroll <= m.barClient, `the bar's content is ${m.barScroll}px wide in a ${m.barClient}px bar`);
        assert.deepEqual(m.labels.map(([label]) => label), KEY_LABELS);
        for (const [label, rects] of m.labels) assert.equal(rects, 1, `「${label}」 is on one line`);
        for (const r of [...m.items, m.icon, m.legend]) assert.ok(r.left >= 0 && r.right <= m.visible, `${r.left}..${r.right} within ${m.visible}`);
        assert.ok(m.iconIsLast, 'the icon is the right-most thing on its line');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a screen box says on hover that pressing it opens the screen in the list, and its buttons keep their own tooltips', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const titles = await p.locator('#flow .box.screen').evaluateAll((boxes) => boxes.map((b) => b.getAttribute('title').split('\n').at(-1)));
        assert.ok(titles.length > 3);
        assert.deepEqual([...new Set(titles)], [PRESS_HINT]);
        const home = await screenBox(p, '/home#Home');
        for (const title of await home.locator('button').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('title')))) {
          assert.ok(title, 'a button inside the box has its own tooltip');
          assert.equal(title.includes(PRESS_HINT), false);
        }
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the buttons of a flow box never wrap onto a second row, at any window width', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        await flowButton(p, '모두 펼치기').click();
        for (const width of [500, 900, 1440]) {
          await p.setViewportSize({ width, height: 700 });
          await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          const rows = await p.$$eval('#flow .box .acts', (acts) => acts.map((row) => {
            const buttons = [...row.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
            const box = row.closest('.box').getBoundingClientRect();
            return { rows: new Set(buttons.map((b) => Math.round(b.top))).size, over: Math.max(...buttons.map((b) => b.right)) - box.right, widest: Math.max(...buttons.map((b) => b.right)) - Math.min(...buttons.map((b) => b.left)) };
          }));
          assert.ok(rows.length > 0);
          assert.deepEqual(rows.filter((r) => r.rows !== 1 || r.over > 0), [], `at ${width}px`);
          assert.ok(Math.max(...rows.map((r) => r.widest)) < 300, `the longest button row is ${Math.max(...rows.map((r) => r.widest))}px`);
        }
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, flow boxes stand in columns by how many links they are from an entry screen, each column as wide as its boxes need and the same for all of them, with no two boxes overlapping', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        await flowButton(p, '모두 펼치기').click();
        const boxes = await flowBoxes(p);
        const byId = Object.fromEntries(boxes.map((b) => [b.id, b]));
        const columns = new Map();
        for (const b of boxes) columns.set(b.left, [...(columns.get(b.left) ?? []), b]);
        for (const [left, column] of columns) assert.equal(new Set(column.map((b) => b.width)).size, 1, `the boxes at ${left} share one width`);
        assert.equal(byId['/home#Home'].left, byId['/help#Help'].left);
        assert.equal(byId['/lab#Lab'].left, byId['/admin/report#AdminReport'].left);
        assert.ok(byId['/lab/result#LabResult'].left > byId['/lab#Lab'].right);
        assert.ok(byId['/signin#SignIn'].width < byId['/help#Help'].width, 'the entry column is narrower than the column holding the long route');
        assert.deepEqual(overlapping(boxes), []);
      }, { view: 'flow', setup: changeData(withLongRoute) }),
    ),
  );
});

test('in a browser, entry screens that lead nowhere are gathered under 「더 뻗지 않는 진입 화면 N」 below the branching ones, in several columns, each box showing what any box shows', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        assert.equal(await p.textContent('#flow .group-head'), '더 뻗지 않는 진입 화면 8');
        const boxes = await flowBoxes(p);
        const grouped = boxes.filter((b) => b.grouped);
        const groupedScreens = await p.$$eval('#flow .box.screen.grouped', (els) => els.map((e) => e.title.split('\n')[0]));
        assert.deepEqual(groupedScreens.sort(), Array.from({ length: 8 }, (_, i) => `/extra/${i}#Extra${i}`).sort());
        const head = await p.$eval('#flow .group-head', (e) => e.getBoundingClientRect().toJSON());
        const tree = boxes.filter((b) => !b.grouped);
        assert.ok(tree.some((b) => b.id === '/signin#SignIn'));
        assert.ok(tree.every((b) => b.bottom <= head.top), 'the branching entry screens come first');
        assert.ok(grouped.every((b) => b.top >= head.bottom), 'the gathered boxes sit under the heading');
        assert.ok(new Set(grouped.filter((b) => groupedScreens.includes(b.id)).map((b) => b.left)).size > 1, 'the gathered boxes stand in more than one column');
        assert.deepEqual(overlapping(boxes), []);

        const failing = await screenBox(p, '/extra/7#Extra7');
        assert.match(await failing.getAttribute('class'), /s-fail/);
        assert.match(await failing.locator('.l2').textContent(), /^✓1 ✕1 ○1 · 불러옴 2/);
        assert.deepEqual(await needLines(await screenBox(p, '/extra/3#Extra3')), ['역할 ADMIN미확인 1']);
        const linked = await screenBox(p, '/extra/0#Extra0');
        assert.match(await linked.locator('.l3').textContent(), /→ /);
        const callsBefore = (await boxCount(p)).calls;
        await linked.locator('.calls').click();
        assert.notEqual((await boxCount(p)).calls, callsBefore);
        assert.equal(await p.textContent('#flow .group-head'), '더 뻗지 않는 진입 화면 8');
        assert.deepEqual(overlapping(await flowBoxes(p)), []);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        assert.equal(await p.textContent('#flow .group-head'), '더 뻗지 않는 진입 화면 3');
        const first = await p.$$eval('#flow .canvas', ([canvas]) => [...canvas.querySelectorAll('.box.screen')].map((e) => e.classList.contains('grouped')));
        assert.deepEqual(first, [true, true, true]);
      }, { view: 'flow', setup: changeData((data) => {
        const extras = leafEntries(data, 3);
        data.flow = { ...data.flow, unreached: [...data.flow.roots, ...data.flow.unreached], roots: extras };
      }) }),
    ),
  );
});

test('in a browser, the gathered entry screens take fewer columns once the window gets narrower', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const columns = () => p.$$eval('#flow .box.screen.grouped', (els) => new Set(els.map((e) => e.offsetLeft)).size);
        const wide = await columns();
        assert.ok(wide > 1);
        await p.setViewportSize({ width: 700, height: 900 });
        await p.waitForFunction((n) => new Set([...document.querySelectorAll('#flow .box.screen.grouped')].map((e) => e.offsetLeft)).size < n, wide);
        assert.equal(await p.locator('#flow .box.screen.grouped').count(), 8);
        assert.deepEqual(overlapping(await flowBoxes(p)), []);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
});

test('in a browser, redrawing the flow keeps the place the reviewer scrolled to', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const scrolled = await p.evaluate(() => {
          const flow = document.getElementById('flow');
          flow.scrollTop = 200;
          return flow.scrollTop;
        });
        assert.equal(scrolled, 200);
        await flowButton(p, '모두 펼치기').click();
        assert.equal(await p.evaluate(() => document.getElementById('flow').scrollTop), 200);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
});

test('in a browser, one branch shown on its own has no gathered entry screens, and the whole view brings them back', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^이 가지만$/ }).click();
        await p.waitForSelector('.flowbar .focusing');
        assert.equal(await p.locator('#flow .group-head').count(), 0);
        assert.equal(await p.locator('#flow .box.grouped').count(), 0);
        await flowButton(p, '전체 보기').click();
        assert.equal(await p.textContent('#flow .group-head'), '더 뻗지 않는 진입 화면 2');
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 2)); }) }),
    ),
  );
});

test('in a browser, the flow layout is worked out from the trees, the box sizes and the open state alone, the same every time, and each box\'s width from the widths alone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const [first, second, columns] = await p.evaluate(() => {
          const screen = (id, children = [], calls = []) => ({ kind: 'screen', id, children, calls, guards: [] });
          const roots = [screen('A', [screen('B'), screen('C')]), screen('D', [], [{ kind: 'call', id: 'GET:/d' }]), screen('E')];
          const sizes = {
            A: { width: 100, height: 40 }, B: { width: 120, height: 30 }, C: { width: 80, height: 50 },
            D: { width: 90, height: 30 }, 'D>GET:/d': { width: 200, height: 20 }, E: { width: 70, height: 20 },
          };
          const view = { collapsed: [], openCalls: ['D'], group: true, width: 300 };
          state.collapsed.add('A');
          const { widths, grouped } = flowColumns(roots, sizes, view);
          return [layoutFlow(roots, sizes, view), layoutFlow(roots, sizes, view), { widths, grouped: [...grouped] }];
        });
        assert.deepEqual(first, second);
        assert.deepEqual(columns, { widths: { A: 100, B: 120, C: 120, D: 90, 'D>GET:/d': 74, E: 90 }, grouped: ['D', 'D>GET:/d', 'E'] });
        const boxes = Object.fromEntries(first.boxes.map(({ key, ...b }) => [key, b]));
        assert.deepEqual(boxes, {
          A: { x: 0, y: 21, width: 100, height: 40, grouped: false },
          B: { x: 150, y: 0, width: 120, height: 30, grouped: false },
          C: { x: 150, y: 42, width: 120, height: 50, grouped: false },
          D: { x: 0, y: 156, width: 90, height: 30, grouped: true },
          'D>GET:/d': { x: 16, y: 198, width: 74, height: 20, grouped: true },
          E: { x: 114, y: 156, width: 90, height: 20, grouped: true },
        });
        const edges = Object.fromEntries(first.edges.map(({ from, to, ...e }) => [`${from} ${to}`, e]));
        assert.deepEqual(edges, {
          'A B': { x1: 100, y1: 41, x2: 150, y2: 15, guards: [], grouped: false },
          'A C': { x1: 100, y1: 41, x2: 150, y2: 67, guards: [], grouped: false },
          'D D>GET:/d': { x1: 8, y1: 186, x2: 16, y2: 208, guards: [], grouped: true },
        });
        assert.deepEqual(first.group, { x: 0, y: 128, height: 28, count: 2 });
        assert.equal(first.width, 270);
        assert.equal(first.height, 230);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, 「리뷰 끝」 ends the review and the page says so', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    let ends = 0;
    const server = await startReviewServer(config, { author: 'reviewer', onDone: () => { ends++; } });
    try {
      await withPage(`http://127.0.0.1:${server.address().port}`, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        assert.match(await p.textContent('#ended'), /리뷰를 끝냈습니다/);
        assert.equal(await p.locator('main, #flow, header button').count(), 0);
        assert.equal(ends, 1);
      });
    } finally {
      server.close();
    }
  });
});

test('in a browser, 「리뷰 끝」 asks before throwing away a mark that was picked but not saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    let ends = 0;
    const server = await startReviewServer(config, { author: 'reviewer', onDone: () => { ends++; } });
    try {
      await withPage(`http://127.0.0.1:${server.address().port}`, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right textarea', 'draft note');

        const asked = [];
        p.once('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForTimeout(200);
        assert.equal(asked.length, 1);
        assert.equal(ends, 0);
        assert.equal(await p.locator('#ended').count(), 0);
        assert.equal(await p.inputValue('#right textarea'), 'draft note');

        await p.locator('table.calls td.cell').first().click();
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right textarea', 'call note');
        p.once('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForTimeout(200);
        assert.equal(asked.length, 2);
        assert.equal(ends, 0);
        assert.equal(await p.inputValue('#right textarea'), 'call note');

        p.once('dialog', (d) => d.accept());
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        assert.equal(ends, 1);
      });
    } finally {
      server.close();
    }
  });
});

test('in a browser, 「리뷰 끝」 after the review already ended elsewhere says so rather than reporting a failure', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: 'reviewer', onDone: () => () => server.close() });
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage();
      await p.goto(base);
      await toList(p);
      await p.waitForSelector('#screen-list li');
      await fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await new Promise((resolve) => server.on('close', resolve));

      await p.click('header button:has-text("리뷰 끝")');
      await p.waitForSelector('#ended');
      assert.match(await p.textContent('#ended'), /이미/);
      assert.equal(await p.locator('#end-error').count(), 0);
    } finally {
      await browser.close();
      server.close();
    }
  });
});

test('in a browser, a link from a screen that needs both a setting and a role shows both marks', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    fs.writeFileSync(path.join(copy, 'client/src/components/AdminReport.js'), `import { Link } from 'react-router-dom';
import Option from '_define/Option';
import ExportDialog from './ExportDialog';

export default function AdminReport() {
  return (
    <section>
      Reports
      <ExportDialog />
      <Link to={Option.ROUTE_PATH.HELP}>Help</Link>
    </section>
  );
}
`);
    execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await openLinkGroups(p.locator('#right .access'));
        const link = p.locator('#right .access li:has-text("/admin/report#AdminReport")');
        assert.match(await link.innerText(), /링크를 건 화면에 필요한 것/);
        assert.deepEqual(await link.locator('.from-kinds .chip').allTextContents(), ['역할', '설정']);
      }),
    );
  });
});

test('in a browser, the chosen screen shows the logged-in app in a frame above its tests, with the address, the account and a new-window link, and a press inside reaches the test server', { skip: browserMissing }, async () => {
  await withFakeApi((api, presses) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin', '/login'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/home")');
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            assert.match(await bar.textContent(), new RegExp(`${app.url}/home`));
            assert.match(await bar.textContent(), /duru-admin/);
            assert.match(await bar.textContent(), /맵에 없는 signedOutPaths: \/login/);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'), `${app.url}/home`);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('target'), '_blank');

            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            assert.equal(await frame.locator('#path').textContent(), '/home');
            await frame.locator('#press').click();
            await frame.locator('#pressed:has-text("pressed")').waitFor();
            assert.equal(presses.length, 1);

            await p.click('#center tr:has-text("API")');
            await p.click('#right .statuses button:has-text("없음")');
            await p.click('#right button.save');
            await p.waitForSelector('#center tr.selected .chip.missing');
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');

            const frameBox = await p.locator('#center iframe.app').boundingBox();
            const tableBox = await p.locator('#center table').first().boundingBox();
            assert.ok(tableBox.y > frameBox.y + frameBox.height - 1);
            assert.ok(await p.locator('#right').isVisible());

            await p.click('#screen-list li:has-text("/signin")');
            assert.match(await bar.textContent(), /로그아웃 상태/);
            assert.doesNotMatch(await bar.textContent(), /duru-admin/);
            await p.frameLocator('#center iframe.app').locator('#path:has-text("/signin")').waitFor();
            const signedOutFrame = p.frameLocator('#center iframe.app');
            assert.equal(await signedOutFrame.locator('#who').textContent(), '로그인 전');
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'),
              `${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent('/signin')}`);

            const appFrameHandle = p.frames().find((f) => f.url().startsWith(`${app.signedOutUrl}/signin`));
            await appFrameHandle.evaluate(() => {
              localStorage.setItem('FAKE_AUTH', JSON.stringify({ accessToken: 't-123' }));
              location.reload();
            });
            await signedOutFrame.locator('#who:has-text("두루 관리자")').waitFor();
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen with path variables opens filled with its fixed value or the first value of its list API, and an edited value reopens it', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: 'draft' }, '/document/:id': { id: LIST_API } };
  await withFakeApi((api, presses, logins, listCalls) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...pathValueSettings(api, pathValues).app, signedOutPaths: ['/document/:tab(draft|done)'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            const newWindow = () => bar.locator('a:has-text("새 창")').getAttribute('href');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/document/:tab")');
            await frame.locator('#path:has-text("/document/draft")').waitFor();
            assert.equal(await frame.locator('#who').textContent(), '로그인 전');
            assert.equal(await bar.locator('.mono').textContent(), `${app.signedOutUrl}/document/draft`);
            assert.match(await bar.textContent(), /로그아웃 상태/);
            assert.equal(await newWindow(), `${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent('/document/draft')}`);
            assert.equal(await bar.locator('input[name=tab]').inputValue(), 'draft');

            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            assert.equal(await bar.locator('input[name=id]').inputValue(), '17');
            assert.equal(await newWindow(), `${app.url}/document/17`);
            assert.doesNotMatch(await bar.textContent(), /목록에서 골라/);
            assert.deepEqual(listCalls, ['GET /api/v1/documents']);

            await bar.locator('input[name=id]').fill('42');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/42")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${app.url}/document/42`);
            assert.equal(await newWindow(), `${app.url}/document/42`);

            await frame.locator('#press').click();
            await frame.locator('#pressed:has-text("pressed")').waitFor();
            await p.click('#center tr:has-text("API")');
            await p.click('#right .statuses button:has-text("없음")');
            await p.click('#right button.save');
            await p.waitForSelector('#center tr.selected .chip.missing');
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');

            await bar.locator('input[name=id]').fill('43');
            await p.click('#screen-list li:has-text("/home")');
            await frame.locator('#path:has-text("/home")').waitFor();
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/42")').waitFor();
            assert.equal(await bar.locator('input[name=id]').inputValue(), '43');
            await bar.locator('button:has-text("다시 띄우기")').click();
            await frame.locator('#path:has-text("/document/43")').waitFor();
            assert.deepEqual(listCalls, ['GET /api/v1/documents']);
            assert.equal(presses.length, 1);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen without its values opens its list screen with a notice, and a failing list API is shown before the same fallback', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: { ...LIST_API, api: '/api/v1/documents/broken' } }, '/docs/:id': { id: '1' } };
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, pathValues), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${app.url}/home`);
            assert.match(await bar.textContent(), /목록에서 골라 들어가세요/);
            assert.match(await bar.textContent(), /맵에 없는 pathValues: \/docs\/:id/);
            assert.equal(await bar.locator('.path-values .error').count(), 0);
            assert.equal(await bar.locator('input[name=id]').inputValue(), '');

            await bar.locator('input[name=id]').fill('42');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/42")').waitFor();
            assert.doesNotMatch(await bar.textContent(), /목록에서 골라/);

            await p.click('#screen-list li:has-text("/document/:tab")');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.match(await bar.textContent(), /목록에서 골라 들어가세요/);
            assert.match(await bar.locator('.path-values .error').textContent(), /^tab: 목록 API GET \/api\/v1\/documents\/broken 요청이 500 로 실패했습니다$/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen without its values falls back to a list screen opened with its fixed values', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, { '/document/:tab(draft|done)': { tab: 'draft' } }), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await p.frameLocator('#center iframe.app').locator('#path:has-text("/document/draft")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${app.url}/document/draft`);
            assert.match(await bar.textContent(), /목록에서 골라 들어가세요/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen without its values falls back to a linking list screen the frame account can open before one that needs another role', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, pathValues: {} } }, async (config, copy) => {
        const member = path.join(copy, 'client/src/components/AdminMember.js');
        fs.writeFileSync(member, fs.readFileSync(member, 'utf8').replace('Audit log</Link>', 'Audit log</Link>\n      <Link to={`${Option.ROUTE_PATH.DOCUMENT}/7`}>Document</Link>'));
        execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await bar.locator('text=목록에서 골라 들어가세요').waitFor();
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.url}/home`);
            await frameWho(p, '두루 관리자');
          }),
        );
      }),
    ),
  );
});

test('in a browser, a value the reviewer clears does not fall back to a list screen, and the frame says the value is missing', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, { '/document/:id': { id: '42' } }), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/42")').waitFor();

            await bar.locator('input[name=id]').fill('');
            await bar.locator('input[name=id]').press('Enter');
            await p.locator('#center .frame-note:has-text("id 값이 없어 이 화면을 띄울 수 없습니다")').waitFor();
            assert.equal(await p.locator('#center iframe.app').count(), 0);
            assert.doesNotMatch(await bar.textContent(), /목록에서 골라/);

            await bar.locator('input[name=id]').fill('43');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/43")').waitFor();
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen with a list API opens with the value the list gives to the account the frame logs in as', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:id': { id: LIST_API } };
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            await p.selectOption('#center select.role', 'role:ADMIN');
            await frame.locator('#path:has-text("/document/27")').waitFor();
            assert.equal(await p.locator('#center .frame-bar input[name=id]').inputValue(), '27');
            await p.selectOption('#center select.role', 'auto');
            await frame.locator('#path:has-text("/document/17")').waitFor();
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a list API that failed is called again when its screen is chosen again', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: { ...LIST_API, api: '/api/v1/documents/flaky' } } };
  await withFakeApi((api, presses, logins, listCalls) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, pathValues), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:tab")');
            await bar.locator('.path-values .error:has-text("503")').waitFor();
            await p.click('#screen-list li:has-text("/home")');
            await p.click('#screen-list li:has-text("/document/:tab")');
            await frame.locator('#path:has-text("/document/done")').waitFor();
            assert.equal(await bar.locator('.path-values .error').count(), 0);
            assert.equal(listCalls.filter((c) => c.endsWith('/flaky')).length, 2);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, the sign-out path lands on the signed-out address whatever path it is given', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            for (const [to, landing] of [['/signin', '/signin'], ['/.//evil.example.test', '/'], ['/%2e//evil.example.test', '/'], ['/.\\/evil.example.test', '/']]) {
              await p.goto(`${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent(to)}`);
              await p.waitForURL((u) => u.pathname !== app.signOutPath);
              assert.equal(p.url(), `${app.signedOutUrl}${landing}`, to);
            }
          }),
        ),
      ),
    ),
  );
});

const frameWho = (p, name) => p.frameLocator('#center iframe.app').locator(`#who:has-text("${name}")`).waitFor();

test('in a browser, a screen under a role condition opens as the first configured role that meets it, and a role picked in the bar reloads the frame and stays picked on other screens', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture(roleSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const [admin, auditor] = app.roles;
            const bar = p.locator('#center .frame-bar');
            const picker = bar.locator('select');
            const frameSrc = () => p.locator('#center iframe.app').getAttribute('src');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/admin/member")');
            assert.deepEqual(await picker.locator('option').allTextContents(),
              ['자동', '기본 계정 (duru-admin)', 'ADMIN (duru-boss)', 'AUDITOR (duru-auditor)', 'OWNER — 계정 없음']);
            assert.equal(await picker.locator('option:has-text("OWNER")').isDisabled(), true);
            assert.equal(await picker.inputValue(), 'auto');
            assert.match(await bar.textContent(), /ADMIN 역할 duru-boss 로 로그인/);
            assert.equal(await frameSrc(), `${admin.url}/admin/member`);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'), `${admin.url}/admin/member`);
            await frameWho(p, '두루 대표');

            await picker.selectOption({ label: 'AUDITOR (duru-auditor)' });
            await frameWho(p, '두루 감사');
            assert.equal(await frameSrc(), `${auditor.url}/admin/member`);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'), `${auditor.url}/admin/member`);
            assert.match(await bar.textContent(), /AUDITOR 역할 duru-auditor 로 로그인/);
            assert.match(await bar.locator('.error').allTextContents().then((t) => t.join('\n')), /이 역할은 화면 조건\(ADMIN\)을 채우지 못합니다/);

            await p.click('#screen-list li:has-text("/admin/report")');
            assert.equal(await picker.inputValue(), 'role:AUDITOR');
            assert.equal(await frameSrc(), `${auditor.url}/admin/report`);
            assert.match(await bar.textContent(), /이 역할은 화면 조건\(ADMIN, OWNER\)을 채우지 못합니다/);

            await p.click('#screen-list li:has-text("/admin/audit")');
            assert.equal(await frameSrc(), `${auditor.url}/admin/audit`);
            assert.doesNotMatch(await bar.textContent(), /채우지 못합니다/);

            await picker.selectOption({ label: '기본 계정 (duru-admin)' });
            await frameWho(p, '두루 관리자');
            assert.equal(await frameSrc(), `${app.url}/admin/audit`);
            assert.match(await bar.textContent(), /duru-admin 로 로그인/);

            await picker.selectOption({ label: '자동' });
            await frameWho(p, '두루 대표');
            assert.equal(await frameSrc(), `${admin.url}/admin/audit`);

            await p.click('#screen-list li:has-text("/home")');
            assert.equal(await frameSrc(), `${app.url}/home`);
            assert.match(await bar.textContent(), /duru-admin 로 로그인/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a narrow center column puts the address above the role picker instead of squeezing it', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture(roleSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.setViewportSize({ width: 1000, height: 900 });
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/admin/member")');
            const bar = await p.locator('#center .frame-bar').boundingBox();
            const address = await p.locator('#center .frame-bar .mono').boundingBox();
            const picker = await p.locator('#center .frame-bar select').boundingBox();
            assert.ok(address.width > bar.width * 0.8, `address ${address.width}px in a ${bar.width}px bar`);
            assert.ok(picker.x + picker.width <= bar.x + bar.width, 'the role picker fits in the bar');
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen whose role has no account or cannot be read from the map opens as the default account and the bar says why, and signed-out screens have no role picker', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords({ ...ALL_PASSWORDS, [AUDITOR_PASSWORD_ENV]: undefined }, () =>
      withRebuiltFixture({ app: { ...roleSettings(api, { AUDITOR: 'duru-auditor' }).app, signedOutPaths: ['/signin'] } }, async (config, copy) => {
        const home = path.join(copy, 'client/src/components/Home.js');
        fs.writeFileSync(home, fs.readFileSync(home, 'utf8').replace("const isAdmin = memberRole === 'ADMIN';", "const isAdmin = memberRole !== 'MEMBER';"));
        execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/admin/member")');
            assert.deepEqual(await bar.locator('select option[disabled]').allTextContents(), ['ADMIN — 계정 없음', 'OWNER — 계정 없음']);
            assert.match(await bar.locator('.error').textContent(), /조건을 채우는 역할\(ADMIN\)에 계정이 없습니다/);
            assert.match(await bar.textContent(), /duru-admin 로 로그인/);
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.url}/admin/member`);

            await p.click('#screen-list li:has-text("/admin/group")');
            assert.match(await bar.locator('.error').textContent(), /어느 역할이 조건을 채우는지 맵에서 정할 수 없습니다: isAdmin/);
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.url}/admin/group`);

            await bar.locator('select').selectOption({ label: 'AUDITOR (duru-auditor)' });
            assert.match(await bar.locator('.error').first().textContent(), new RegExp(AUDITOR_PASSWORD_ENV));
            assert.doesNotMatch(await bar.textContent(), /AUDITOR 역할 duru-auditor 로 로그인/);

            await p.click('#screen-list li:has-text("/signin")');
            assert.match(await bar.textContent(), /로그아웃 상태/);
            assert.equal(await bar.locator('select').count(), 0);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a screen opens as a role that logged in before one whose login failed, and guards left unread are named even when the values are known', { skip: browserMissing }, async () => {
  const roles = {
    ADMIN: { id: 'duru-auditor', passwordEnv: AUDITOR_PASSWORD_ENV },
    OWNER: { id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV },
  };
  await withFakeApi((api) =>
    withPasswords({ ...ALL_PASSWORDS, [AUDITOR_PASSWORD_ENV]: undefined }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, roles } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/admin/report")');
            await frameWho(p, '두루 대표');
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.roles[1].url}/admin/report`);
            assert.match(await bar.textContent(), /OWNER 역할 duru-boss 로 로그인/);

            await p.click('#screen-list li:has-text("/admin/group")');
            assert.match(await bar.locator('.error').first().textContent(), new RegExp(AUDITOR_PASSWORD_ENV));
            assert.match(await bar.textContent(), /읽지 못한 역할 조건도 있습니다: isAdmin\b/);
          }),
        ),
      ),
    ),
  );
});

const chooseScreen = (p, routePath) =>
  p.locator('#screen-list li').filter({ has: p.locator('.name > span:first-child', { hasText: new RegExp(`^${routePath}$`) }) }).click();
const overridesOf = async (base) => (await (await fetch(`${base}/api/data`)).json()).app.settings.overrides;
const settingRow = (p, name) => p.locator('#settings-bar .setting', { has: p.locator('code', { hasText: new RegExp(`^${name}$`) }) });

test('in a browser, choosing a screen behind a setting opens the frame with the setting on, a toggle reloads it with the new value, and 「기본값으로」 puts every setting back', { skip: browserMissing }, async () => {
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/home');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.equal(await frame.locator('#help').textContent(), 'true');
            assert.equal(await p.locator('#settings-bar').isHidden(), true);

            await chooseScreen(p, '/lab');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.equal(await frame.locator('#help').textContent(), 'true');
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
            const bar = p.locator('#settings-bar');
            assert.match(await bar.getAttribute('class'), /overridden/);
            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            assert.equal(await lab.count(), 1);
            assert.match(await lab.getAttribute('class'), /changed/);
            assert.match(await lab.locator('button.on').textContent(), /켜기/);
            assert.match(await lab.getAttribute('title'), /라우트 · \/home#Home 에서 오는 링크/);

            await lab.locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
            assert.doesNotMatch(await bar.getAttribute('class'), /overridden/);
            assert.doesNotMatch(await lab.getAttribute('class'), /changed/);
            assert.match(await lab.locator('button.on').textContent(), /끄기/);

            await lab.locator('button:has-text("켜기")').click();
            await frame.locator('#lab:has-text("true")').waitFor();
            await chooseScreen(p, '/home');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await frame.locator('#lab').textContent(), 'true');
            assert.equal(await bar.isVisible(), true);
            assert.match(await bar.locator('.others').textContent(), /SYSTEM\.LAB_ENABLED = true/);

            await bar.locator('button:has-text("기본값으로")').click();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
            assert.equal(await bar.isHidden(), true);
            assert.ok(requests.every((r) => !r.includes('settings')));

            await chooseScreen(p, '/lab/result');
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.equal(await settingRow(p, 'SYSTEM.LAB_ENABLED').getAttribute('title'), '/lab#Lab 에서 물려받음');
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting whose default the source does not show in full is written as the screen needs, even when the reviewer changed it and came back', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', '    LAB_ENABLED: false,', '    LAB_ENABLED: window.LAB_DEFAULT ?? true,');
        rewrite(copy, 'client/src/Routes.js', '{globalSettings.SYSTEM.LAB_ENABLED ? <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact /> : null}',
          '{globalSettings.SYSTEM.LAB_ENABLED ? null : <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact />}');
        rewrite(copy, 'client/src/components/Home.js', '{globalSettings.SYSTEM.LAB_ENABLED && <Link', '{<Link');
        rewrite(copy, 'build/app.js', 'LAB_ENABLED: false,', 'LAB_ENABLED: true,');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#lab:has-text("false")').waitFor();
            const off = [{ path: ['SYSTEM', 'LAB_ENABLED'], value: false }];
            assert.deepEqual(await overridesOf(base), off);

            await settingRow(p, 'SYSTEM.LAB_ENABLED').locator('button:has-text("켜기")').click();
            await frame.locator('#lab:has-text("true")').waitFor();
            await chooseScreen(p, '/home');
            await frame.locator('#path:has-text("/home")').waitFor();
            await chooseScreen(p, '/lab');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), off);

            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            await lab.locator('button:has-text("켜기")').click();
            await frame.locator('#lab:has-text("true")').waitFor();
            await lab.locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), off);
          }),
        );
      }),
    ),
  );
});

test('in a browser, picking in the select the value a setting seems to have keeps it written when its section is not shown in full', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', '    LAB_ENABLED: false,', "    LAB_ENABLED: false,\n    MODE: 'a',\n    ...window.EXTRA,");
        rewrite(copy, 'client/src/Routes.js', '{globalSettings.SYSTEM.LAB_ENABLED ? <Route', "{globalSettings.SYSTEM.MODE === 'a' ? <Route");
        rewrite(copy, 'client/src/components/Home.js', '{globalSettings.SYSTEM.LAB_ENABLED && <Link', '{<Link');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const modeA = [{ path: ['SYSTEM', 'MODE'], value: 'a' }];
            await p.waitForFunction(() => document.querySelector('#settings-bar .setting.changed'));
            assert.deepEqual(await overridesOf(base), modeA);
            const select = settingRow(p, 'SYSTEM.MODE').locator('select');
            assert.doesNotMatch(await select.locator('option').first().textContent(), /"a"/);

            await select.selectOption({ index: 0 });
            await p.waitForFunction(() => !document.querySelector('#settings-bar .setting.changed'));
            await select.selectOption('"a"');
            await p.waitForFunction(() => document.querySelector('#settings-bar .setting.changed'));
            assert.deepEqual(await overridesOf(base), modeA);
          }),
        );
      }),
    ),
  );
});

test('in a browser, coming back to a screen whose setting the reviewer took away puts the unchanged value back instead of recording a change', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#menu:has-text("ADMIN_REPORT")').waitFor();
            const entry = settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST');
            await entry.locator('input').uncheck();
            await frame.locator('#menu', { hasText: /^ADMIN_ARCHIVE$/ }).waitFor();

            await chooseScreen(p, '/home');
            await frame.locator('#path:has-text("/home")').waitFor();
            await chooseScreen(p, '/admin/report');
            await frame.locator('#menu:has-text("ADMIN_REPORT")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
            assert.doesNotMatch(await p.locator('#settings-bar').getAttribute('class'), /overridden/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting the reviewer changed stays changed when the frame reopens the same screen as another account', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#lab:has-text("true")').waitFor();
            await settingRow(p, 'SYSTEM.LAB_ENABLED').locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();

            await p.locator('#center .frame-bar select').selectOption('account');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await p.waitForFunction(() => document.querySelector('#center iframe.app')?.getAttribute('src'));
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting the reviewer changed on a screen with path variables stays changed when another role\'s values are loaded', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, settingsFile: SETTINGS_FILE, pathValues: { '/document/:id': { id: LIST_API } } } }, async (config, copy) => {
        rewrite(copy, 'client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />',
          '{globalSettings.SYSTEM.LAB_ENABLED && <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />}');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/document/:id');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            await settingRow(p, 'SYSTEM.LAB_ENABLED').locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();

            await p.locator('#center .frame-bar select').selectOption('role:ADMIN');
            await frame.locator('#path:has-text("/document/27")').waitFor();
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.deepEqual(await overridesOf(base), []);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a screen that falls back to its list screen sets what the list screen needs', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api, { pathValues: { '/document/:tab(draft|done)': { tab: 'draft' } } }), async (config, copy) => {
        rewrite(copy, 'client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />',
          '{globalSettings.SYSTEM.LAB_ENABLED && <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />}');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/document/:id');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/draft")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.match(await p.locator('#center .frame-bar').textContent(), /목록에서 골라 들어가세요/);
            assert.match(await settingRow(p, 'SYSTEM.LAB_ENABLED').getAttribute('class'), /changed/);
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
          }),
        );
      }),
    ),
  );
});

test('in a browser, path values that arrive after the reviewer moved to the story list neither draw the screen over the story nor change settings', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ ...withSettingsFile(api, { pathValues: { '/document/:tab(draft|done)': { tab: 'draft' } } }), storiesDir: 'example-stories' }, async (config, copy) => {
        rewrite(copy, 'client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />',
          '{globalSettings.SYSTEM.LAB_ENABLED && <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />}');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            let release;
            const held = new Promise((resolve) => (release = resolve));
            await p.route('**/api/path-values?*', async (route) => {
              await held;
              await route.continue();
            });
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/document/:id');
            await p.click('#left .views.side button:has-text("스토리")');
            release();
            await p.waitForFunction(() => state.pathValues.get(pathValueKey('/document/:id#DocumentDetail', null))?.pending === false);
            const arrived = await p.evaluate(() => state.pathValues.get(pathValueKey('/document/:id#DocumentDetail', null)));
            assert.deepEqual([arrived.errors, arrived.fallbackPath], [[], '/document/draft']);
            await p.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))));
            assert.equal(await p.textContent('#center h3'), '홈에서 개인 설정을 바꾼다');
            assert.equal(await p.locator('#center iframe').count(), 0);
            assert.deepEqual(await overridesOf(base), []);

            await p.click('#left .views.side button:has-text("화면")');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/draft")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a screen reached through a menu built from a settings list takes the menu entry out and back with 「목록에 넣기」', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/admin/report")').waitFor();
            assert.equal(await frame.locator('#menu').textContent(), 'ADMIN_REPORT,ADMIN_ARCHIVE');
            assert.deepEqual(await overridesOf(base), []);

            const entry = settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST');
            assert.match(await entry.textContent(), /"ADMIN_REPORT".*목록에 넣기/);
            assert.equal(await entry.locator('input[type=checkbox]').isChecked(), true);
            assert.match(await settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN').textContent(), /기본값에 있음/);

            await entry.locator('input[type=checkbox]').uncheck();
            await frame.locator('#menu:has-text("ADMIN_ARCHIVE")').waitFor();
            await p.waitForFunction(() => document.querySelector('#settings-bar .setting.changed'));
            assert.equal(await frame.locator('#menu').textContent(), 'ADMIN_ARCHIVE');
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'], item: 'ADMIN_REPORT', value: false }]);
            assert.match(await entry.getAttribute('class'), /changed/);

            await entry.locator('input[type=checkbox]').check();
            await frame.locator('#menu:has-text("ADMIN_REPORT,ADMIN_ARCHIVE")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting in a section the app does not take from the settings file cannot be changed and says why', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, settingsFile: { ...SETTINGS_FILE, merged: ['CUSTOM'] } } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/lab")').waitFor();
            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            assert.match(await lab.locator('.reason').textContent(), /SYSTEM 섹션을 읽지 않아 바꿀 수 없습니다/);
            assert.equal(await lab.locator('button:has-text("켜기")').isDisabled(), true);
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting read through another settings root and a guard whose value cannot be worked out show why they cannot be changed, and the first link that can be satisfied is', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ settingsRoots: ['globalSettings', 'appSettings'], ...withSettingsFile(api) }, async (config, copy) => {
        rewrite(copy, 'client/src/components/Home.js', '{globalSettings.SYSTEM.LAB_ENABLED && <Link', '{appSettings.SYSTEM.LAB_ENABLED && <Link');
        rewrite(copy, 'client/src/components/DocumentDetail.js', '{helpEnabled && <Link', '{helpEnabled !== false && <Link');
        fs.writeFileSync(path.join(copy, 'build/settings.js'), 'window.FAKE_SETTINGS = {};\n');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#lab:has-text("true")').waitFor();
            const rows = settingRow(p, 'SYSTEM.LAB_ENABLED');
            assert.equal(await rows.count(), 2);
            assert.equal(await rows.nth(0).locator('button:has-text("끄기")').isDisabled(), false);
            assert.match(await rows.nth(1).locator('.reason').textContent(), /appSettings 로 읽는 설정이라/);
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);

            await chooseScreen(p, '/help');
            await p.waitForFunction(() => document.querySelectorAll('#settings-bar > .setting.changed').length === 1 && document.querySelector('#settings-bar .others'));
            const unreadable = settingRow(p, 'helpEnabled !== false');
            assert.match(await unreadable.locator('.reason').textContent(), /같지 않음/);
            assert.match(await unreadable.getAttribute('title'), /\/document\/:id#DocumentDetail/);
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }, { path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: true }]);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a setting the settings file already turns on shows as on, a need for it off writes false, and setting it back to the file value drops the change', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/components/DocumentDetail.js', '{helpEnabled && <Link', '{!helpEnabled && <Link');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/help');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#help:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: false }]);
            const help = settingRow(p, 'SYSTEM.HELP_LINK_ENABLED');
            assert.match(await help.getAttribute('class'), /changed/);
            assert.match(await help.locator('button.on').textContent(), /끄기/);

            await help.locator('button:has-text("켜기")').click();
            await frame.locator('#help:has-text("true")').waitFor();
            await p.waitForFunction(() => !document.querySelector('#settings-bar .setting.changed'));
            assert.deepEqual(await overridesOf(base), []);
            assert.match(await help.locator('button.on').textContent(), /켜기/);

            fs.writeFileSync(path.join(copy, 'build/settings.js'), 'window.FAKE_SETTINGS = { SYSTEM: { HELP_LINK_ENABLED: document.title !== null } };\n');
            await p.reload();
            await toList(p);
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            await p.waitForSelector('#settings-bar .file-error');
            assert.match(await p.locator('#settings-bar .file-error').textContent(), /맵의 기본값으로 판단합니다.*document/);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a list inside a default the source does not show in full cannot be changed unless the settings file sets it, and says why', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },", "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },\n      USER: window.INTO_USER_MENU || {},");
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const entry = settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST');
            await entry.waitFor();
            assert.match(await entry.locator('.reason').textContent(), /SYSTEM\.MAIN_MENU 기본값을 소스에서 다 읽지 못해/);
            assert.equal(await entry.locator('input[type=checkbox]').isDisabled(), true);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a setting that only has to be present is not met by an empty default', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', '    LAB_ENABLED: false,\n', "    LAB_ENABLED: false,\n    BANNER: '',\n");
        rewrite(copy, 'client/src/Routes.js', '{globalSettings.SYSTEM.LAB_ENABLED ? <Route', '{globalSettings.SYSTEM.BANNER ? <Route');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const banner = settingRow(p, 'SYSTEM.BANNER');
            await banner.waitFor();
            assert.doesNotMatch(await banner.textContent(), /기본값에 있음/);
            assert.match(await banner.locator('.reason').textContent(), /넣을 수 없습니다/);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a failed settings change is shown until another screen is chosen', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await p.route('**/api/settings', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'settings store down' }));
            await chooseScreen(p, '/lab');
            await p.waitForSelector('#settings-bar .error:has-text("설정을 바꾸지 못했습니다")');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await p.unroute('**/api/settings');

            await chooseScreen(p, '/admin/report');
            await frame.locator('#path:has-text("/admin/report")').waitFor();
            await settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST').waitFor();
            assert.equal(await p.locator('#settings-bar .error').count(), 0);
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a settings change that throws is shown and does not stop the changes after it', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/admin/report")').waitFor();

            await p.evaluate(() => updateSettings(() => {
              throw new Error('change failed');
            }));
            await p.waitForSelector('#settings-bar .error:has-text("change failed")');
            await p.evaluate(() => updateSettings((list) => [...list, { path: ['SYSTEM', 'LAB_ENABLED'], value: true }]));
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
            assert.equal(await p.locator('#settings-bar .error').count(), 0);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, without app settings the center column has no frame', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/home")');
        await p.waitForSelector('#center table');
        assert.equal(await p.locator('#center iframe').count(), 0);
        assert.equal(await p.locator('#center .frame-bar').count(), 0);
      }),
    ),
  );
});

test('in a browser, a screen shows the unit tests that import its source files apart from its own tests', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const help = p.locator('#screen-list li:has-text("/help")');
        assert.equal(await help.locator('.importer-count').textContent(), '불러옴 2');
        assert.deepEqual(await p.locator('#screen-list li:has-text("/document/:id") .count').allTextContents(), ['테스트 11', '불러옴 1']);

        await help.click();
        const ownCount = await p.textContent('#center tbody tr:first-child td:nth-child(2)');
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
        assert.deepEqual(await p.locator('#center .importers .test').allTextContents(), [
          '코드통과 renders the help text components/Help.spec.js:4불러오는 파일 components/Help.js',
          '코드통과 shows the day the help was last updated components/Help.spec.js:8불러오는 파일 components/Help.js',
        ]);
        assert.match(ownCount, /^테스트 \d+개$/);
        assert.doesNotMatch(await p.textContent('#center table'), /renders the help text/);

        await p.click('#screen-list li:has-text("/admin/member")');
        assert.equal(await p.locator('#center .importers').count(), 0);
      })));
});

const HOME = '/home#Home';
const LAB = '/lab#Lab';
const LAB_RESULT = '/lab/result#LabResult';
const OWNER_ROLE = { guard: "memberRole === 'OWNER'", kinds: ['role'], roles: ['OWNER'] };
const UNREAD_ROLE = { guard: 'canManage(member)', kinds: ['role'], roles: null };
const UNREAD_SETTING = { guard: 'settingOf(key)', kinds: ['setting'], settings: null, settingsReason: '설정 키를 읽지 못했습니다' };
const settingGuard = (guard, path, need, value, root = 'globalSettings') => ({ guard, kinds: ['setting'], settings: [{ root, path, need, ...(value === undefined ? {} : { value }) }] });
const LAB_OFF = settingGuard('!globalSettings.SYSTEM.LAB_ENABLED', ['SYSTEM', 'LAB_ENABLED'], 'off');
const reachRoute = (guards, screen = LAB) => ({ kind: 'route', screen, line: 44, guards });
const reachLink = (...ways) => ({ kind: 'link', from: HOME, to: LAB, ways: ways.map((conditions, i) => ({ file: 'components/Home.js', line: 19 + i, conditions })) });

// 핸들러에서 물려받은 조건이 없는 길이면 맵은 길의 조건 중 설정이나 역할 조건만 도착 화면의 들어오는 링크에 적는다.
async function withStoryReach(reach, fn, { access = {} } = {}) {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const data = await (await route.fetch()).json();
          const screen = (id) => data.map.screens.find((s) => s.id === id);
          data.stories.list.find((s) => s.id === 'run-lab').reach = reach;
          for (const r of reach.filter((x) => x.kind === 'link')) {
            assert.ok(r.ways.every((w) => w.conditions.every((g) => !g.via)), 'a link step with inherited conditions needs a rebuilt map');
            const to = screen(r.to);
            to.access.links = [...to.access.links.filter((l) => l.from !== r.from), ...r.ways.map((w) => ({ from: r.from, file: w.file, line: w.line, guards: w.conditions.filter((g) => g.kinds.length), fromKinds: [] }))];
          }
          for (const [id, patch] of Object.entries(access)) Object.assign(screen(id).access, patch);
          await route.fulfill({ json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        await fn(p);
      }),
    ),
  );
}

async function withStoryMap(edits, story, fn) {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click(`#story-list li:has-text("${story}")`);
        await fn(p);
      }),
    ), edits);
}

const RUN_LAB = '실험실을 열어';
const READ_REPORTS = '관리자가 보고서를 본다';
const storyScreens = (screens) => ['example-stories/read-reports.json', '["/admin/report#AdminReport"]', JSON.stringify(screens)];
const LAB_FILE = 'client/src/components/Lab.js';
const resultHandler = (buttons, body = 'history.push(Option.ROUTE_PATH.LAB_RESULT)') => [
  [LAB_FILE, "import { Link } from 'react-router-dom';", "import { useHistory } from 'react-router-dom';"],
  [LAB_FILE, 'export default function Lab() {', `export default function Lab({ memberRole, globalSettings, loaded }) {\n  const history = useHistory();\n  const openResult = () => ${body};`],
  [LAB_FILE, '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>', buttons.map((guard, i) => {
    const button = `<button type="button" onClick={openResult}>Results ${i}</button>`;
    return guard ? `{${guard} && ${button}}` : button;
  }).join('\n      ')],
];

const readSummary = (p) => p.locator('#right .reach-summary').evaluate((el) => {
  const text = (e) => [...e.childNodes].map((c) => c.textContent).join(' ');
  return {
    lines: [...el.querySelectorAll(':scope > .need, :scope > .step-roles > li, :scope > .none')].map(text),
    leftOut: [...el.querySelectorAll(':scope > .left-out li')].map(text),
  };
});

test('in a browser, a story that needs a setting and a role shows them as two summary lines under 사전 조건 in the wording of the screen summary, and the raw conditions only once the fold is opened', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LAB_SETTING]), reachRoute([LAB_SETTING, ADMIN_ROLE])], async (p) => {
    assert.deepEqual(await p.locator('#right-info > *').evaluateAll((els) => els.slice(0, 3).map((e) => e.textContent.slice(0, 5))), ['도달 가능', '사전 조건', '역할 AD']);
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
    assert.equal(await p.locator('#right details.reach-raw').evaluate((d) => d.open), false);
    assert.equal(await p.locator('#right .reach-raw .reach').isVisible(), false);
    assert.equal(await p.locator('#right .reach-summary .reach').count(), 0);
    await p.click('#right .reach-raw > summary');
    assert.equal(await p.locator('#right .reach-raw .reach').isVisible(), true);
    assert.match(await p.textContent('#right .reach-link'), /components\/Home\.js:19.*globalSettings\.SYSTEM\.LAB_ENABLED/);
    assert.match(await p.textContent('#right .reach-route'), /Routes\.js:44.*memberRole === 'ADMIN'/);
    assert.equal(await p.locator('#right-info .mark-form').count(), 0);
    assert.equal(await p.locator('#right-dock > .mark-form').count(), 1);
  });
});

test('in a browser, a condition that sits on several steps of a story is in the summary once', { skip: browserMissing }, async () => {
  await withStoryMap([], RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트']);
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE]), reachRoute([LAB_SETTING, ADMIN_ROLE, UNREAD_ROLE]), reachRoute([UNREAD_ROLE, ADMIN_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
});

test('in a browser, a condition inherited from a handler counts in the story summary when the link has no condition of its own and the handler is used in one place under that one condition', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'"]), RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트', '/lab → /lab/result']);
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
});

test('in a browser, a link whose handler is also used without a role condition adds no role to the story summary, while the fold still shows the role condition as written', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'", 'loaded']), RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트', '/lab → /lab/result']);
    assert.match(await p.locator('#right .reach-link').nth(1).textContent(), /memberRole === 'ADMIN'/);
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
});

test('in a browser, conditions inherited from a handler used in several places, or next to a condition of the link itself, are not counted as needed nor as contradicting, and are listed apart with the handler that carries them', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'", "memberRole === 'OWNER'"]), RUN_LAB, async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['역할 미확인 (/lab → /lab/result)', "openResult 를 쓰는 곳에 따라 다른 조건: memberRole === 'ADMIN', memberRole === 'OWNER'"],
    });
  });
  await withStoryMap(resultHandler(['globalSettings.SYSTEM.LAB_ENABLED', '!globalSettings.SYSTEM.LAB_ENABLED']), RUN_LAB, async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['openResult 를 쓰는 곳에 따라 다른 조건: globalSettings.SYSTEM.LAB_ENABLED, !globalSettings.SYSTEM.LAB_ENABLED'],
    });
  });
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'", null], 'globalSettings.SYSTEM.LAB_ENABLED && history.push(Option.ROUTE_PATH.LAB_RESULT)'), RUN_LAB, async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['역할 미확인 (/lab → /lab/result)', "openResult 를 쓰는 곳에 따라 다른 조건: memberRole === 'ADMIN'"],
    });
  });
});

test('in a browser, a story whose only conditions are inherited from a handler used in several places does not say that nothing blocks it', { skip: browserMissing }, async () => {
  const home = 'client/src/components/Home.js';
  const edits = [
    [home, "import { Link } from 'react-router-dom';", "import { Link, useHistory } from 'react-router-dom';"],
    [home, "const isAdmin = memberRole === 'ADMIN';", "const isAdmin = memberRole === 'ADMIN';\n  const history = useHistory();\n  const openAudit = () => history.push(Option.ROUTE_PATH.ADMIN_AUDIT);"],
    [home, "{session['member.role'] === 'AUDITOR' && <Link to={Option.ROUTE_PATH.ADMIN_AUDIT}>Audit</Link>}",
      '{globalSettings.SYSTEM.MODE_ON && <button type="button" onClick={openAudit}>Audit</button>}\n      {!globalSettings.SYSTEM.MODE_ON && <button type="button" onClick={openAudit}>Log</button>}'],
    storyScreens(['/home#Home', '/admin/audit#AdminAudit']),
  ];
  await withStoryMap(edits, READ_REPORTS, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /admin/audit']);
    assert.deepEqual(await readSummary(p), { lines: [], leftOut: ['openAudit 를 쓰는 곳에 따라 다른 조건: globalSettings.SYSTEM.MODE_ON, !globalSettings.SYSTEM.MODE_ON'] });
  });
});

test('in a browser, the first screen of a story needs from its incoming links only what every one of them needs, and is different per link when they need different settings', { skip: browserMissing }, async () => {
  await withStoryMap([storyScreens(['/help#Help'])], READ_REPORTS, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['첫 화면 /help']);
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.HELP_LINK_ENABLED 켬'], leftOut: [] });
  });
  const signIn = ['client/src/components/SignIn.js', 'globalSettings.SYSTEM.HELP_LINK_ENABLED &&', 'globalSettings.SYSTEM.LAB_ENABLED &&'];
  await withStoryMap([signIn, storyScreens(['/help#Help'])], READ_REPORTS, async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['첫 화면 /help 링크마다 다름'], leftOut: [] });
  });
  const either = [
    [LAB_FILE, 'export default function Lab() {', 'export default function Lab({ globalSettings }) {'],
    [LAB_FILE, '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>',
      '{globalSettings.SYSTEM.MODE_ON ? <Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link> : <Link to={Option.ROUTE_PATH.LAB_RESULT}>Back</Link>}'],
    storyScreens(['/lab/result#LabResult']),
  ];
  await withStoryMap(either, READ_REPORTS, async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['첫 화면 /lab/result 링크마다 다름'], leftOut: [] });
  });
});

test('in a browser, the first screen of a story whose incoming link carries a role condition inherited from a handler that is also used without it does not present the roles of the map as complete', { skip: browserMissing }, async () => {
  const edits = [...resultHandler(["memberRole === 'ADMIN'", null], 'globalSettings.SYSTEM.LAB_ENABLED && history.push(Option.ROUTE_PATH.LAB_RESULT)'), storyScreens(['/lab/result#LabResult'])];
  await withStoryMap(edits, READ_REPORTS, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['첫 화면 /lab/result']);
    assert.deepEqual(await readSummary(p), {
      lines: ['역할 ADMIN 미확인 1', '설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['역할 일부만 읽음 (첫 화면 /lab/result)', "openResult 를 쓰는 곳에 따라 다른 조건: memberRole === 'ADMIN'"],
    });
  });
});

test('in a browser, a story step that several links reach needs in the summary only what every link needs, and is different per link only when no link needs exactly that', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE], [LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  const isAdmin = { guard: 'isAdmin', kinds: ['role'], roles: ['ADMIN'] };
  await withStoryReach([reachLink([ADMIN_ROLE], [isAdmin])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN'], leftOut: [] });
  });
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE], [OWNER_ROLE, LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 또는 OWNER', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  await withStoryReach([reachLink([ADMIN_ROLE], [LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['/home → /lab 링크마다 다름'], leftOut: [] });
  });
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE], [LAB_SETTING, LONG_SETTING]), reachRoute([LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬', '/home → /lab 링크마다 다름'], leftOut: [] });
  });
});

test('in a browser, a story whose role was not read on one step does not present the role of the other steps as enough', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([UNREAD_ROLE]), reachRoute([ADMIN_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1'], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
  await withStoryReach([{ kind: 'start', screen: HOME, kinds: ['role'], roleValues: null }, reachRoute([ADMIN_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1'], leftOut: ['역할 미확인 (첫 화면 /home)'] });
  }, { access: { [HOME]: { restricted: true, kinds: ['role'], roleValues: null, unreadableRoleGuards: [] } } });
});

test('in a browser, a role condition that was not read on one of several links of a step neither hides what the other links prove nor shows as needed', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([ADMIN_ROLE, UNREAD_ROLE], [ADMIN_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN'], leftOut: [] });
  });
  await withStoryReach([reachLink([UNREAD_ROLE], [ADMIN_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1'], leftOut: ['역할 일부만 읽음 (/home → /lab)'] });
  });
  await withStoryReach([reachLink([ADMIN_ROLE, UNREAD_ROLE], [OWNER_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 또는 OWNER 미확인 1'], leftOut: ['역할 일부만 읽음 (/home → /lab)'] });
  });
  await withStoryReach([reachLink([UNREAD_ROLE], [ADMIN_ROLE]), reachRoute([OWNER_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 OWNER 미확인 1'], leftOut: ['역할 일부만 읽음 (/home → /lab)'] });
  });
});

test('in a browser, a story whose steps allow roles that do not overlap says that no role passes every step and lists the roles of each step', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([ADMIN_ROLE]), reachRoute([OWNER_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['모든 단계를 지나는 역할 없음', '/lab 라우트: 역할 ADMIN', '/lab/result 라우트: 역할 OWNER'], leftOut: [] });
  });
});

const MODE = ['SYSTEM', 'MODE'];
const modeIs = (value) => settingGuard(`globalSettings.SYSTEM.MODE === ${JSON.stringify(value)}`, MODE, 'equals', value);

test('in a browser, a story whose steps need the same setting both on and off, or with two different values, says those needs contradict each other instead of listing them as needed', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([LAB_SETTING, modeIs('A'), LONG_SETTING]), reachRoute([LAB_OFF, modeIs('B')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: [
      '설정 SYSTEM.MAIN_MENU.LAB.LIST 에 "LAB_EXPERIMENTS"',
      '서로 어긋나는 설정: SYSTEM.LAB_ENABLED 켬 / SYSTEM.LAB_ENABLED 끔',
      '서로 어긋나는 설정: SYSTEM.MODE = "A" / SYSTEM.MODE = "B"',
    ], leftOut: [] });
  });
});

test('in a browser, a setting needed off contradicts the same setting needed present, holding a value or equal to a true value, and only the needs that contradict leave the need lines', { skip: browserMissing }, async () => {
  const modeOff = settingGuard('!globalSettings.SYSTEM.MODE', MODE, 'off');
  const modeHas = settingGuard("globalSettings.SYSTEM.MODE includes 'A'", MODE, 'includes', 'A');
  const modePresent = settingGuard('globalSettings.SYSTEM.MODE', MODE, 'present');
  await withStoryReach([reachRoute([modeOff]), reachRoute([modeIs('A')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['서로 어긋나는 설정: SYSTEM.MODE 끔 / SYSTEM.MODE = "A"'], leftOut: [] });
  });
  await withStoryReach([reachRoute([modeOff]), reachRoute([modeHas, modePresent], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['서로 어긋나는 설정: SYSTEM.MODE 끔 / SYSTEM.MODE 에 "A" / SYSTEM.MODE 있음'], leftOut: [] });
  });
  const modeOn = settingGuard('globalSettings.SYSTEM.MODE', MODE, 'on');
  await withStoryReach([reachRoute([modeOn]), reachRoute([modeIs('A'), modeIs('B')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.MODE 켬', '서로 어긋나는 설정: SYSTEM.MODE = "A" / SYSTEM.MODE = "B"'], leftOut: [] });
  });
});

test('in a browser, setting needs that a loose comparison can satisfy together are not called a contradiction', { skip: browserMissing }, async () => {
  const modeOn = settingGuard('globalSettings.SYSTEM.MODE', MODE, 'on');
  await withStoryReach([reachRoute([modeOn]), reachRoute([modeIs(0)], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.MODE 켬', '설정 SYSTEM.MODE = 0'], leftOut: [] });
  });
  await withStoryReach([reachRoute([modeIs(1)]), reachRoute([modeIs('1')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.MODE = 1', '설정 SYSTEM.MODE = "1"'], leftOut: [] });
  });
});

test('in a browser, a story whose settings come from two settings roots names the root of each setting and keeps the same path of two roots apart', { skip: browserMissing }, async () => {
  const appLab = (need) => settingGuard(`${need === 'off' ? '!' : ''}appSettings.SYSTEM.LAB_ENABLED`, ['SYSTEM', 'LAB_ENABLED'], need, undefined, 'appSettings');
  await withStoryReach([reachRoute([appLab('on')]), reachRoute([LAB_SETTING], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 appSettings.SYSTEM.LAB_ENABLED 켬', '설정 globalSettings.SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  await withStoryReach([reachRoute([appLab('on')]), reachRoute([LAB_OFF], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 appSettings.SYSTEM.LAB_ENABLED 켬', '설정 globalSettings.SYSTEM.LAB_ENABLED 끔'], leftOut: [] });
  });
  await withStoryReach([reachRoute([appLab('on')]), reachRoute([appLab('off')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['서로 어긋나는 설정: SYSTEM.LAB_ENABLED 켬 / SYSTEM.LAB_ENABLED 끔'], leftOut: [] });
  });
});

test('in a browser, a story whose conditions are neither a setting nor a role says that no setting or role blocks it', { skip: browserMissing }, async () => {
  const loaded = { guard: 'loaded', kinds: [] };
  await withStoryReach([reachLink([loaded])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정이나 역할로 막는 조건 없음'], leftOut: [] });
  });
});

test('in a browser, the story summary names every role and every setting in full', { skip: browserMissing }, async () => {
  const adminOrOwner = { guard: "['ADMIN', 'OWNER'].includes(memberRole)", kinds: ['role'], roles: ['ADMIN', 'OWNER'] };
  await withStoryReach([reachRoute([LAB_SETTING, LONG_SETTING, adminOrOwner])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 또는 OWNER', '설정 SYSTEM.LAB_ENABLED 켬', '설정 SYSTEM.MAIN_MENU.LAB.LIST 에 "LAB_EXPERIMENTS"'], leftOut: [] });
  });
});

test('in a browser, story conditions that the summary cannot state are listed apart from it under their own heading, outside the fold', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([LAB_SETTING, UNREAD_ROLE, UNREAD_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['읽지 못한 역할 조건: canManage(member)', '정하지 못한 설정 조건: settingOf(key) (설정 키를 읽지 못했습니다)'],
    });
    const leftOut = p.locator('#right .reach-summary .left-out');
    assert.equal(await leftOut.locator(':scope > :first-child').textContent(), '요약에 넣지 못한 조건');
    assert.equal(await leftOut.locator('xpath=ancestor::details').count(), 0);
    assert.equal(await leftOut.isVisible(), true);
  });
  await withStoryReach([reachRoute([UNREAD_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: [], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
});

test('in a browser, the fold of a story\'s raw conditions and its long conditions stay open when the right pane is redrawn, and close again on another story', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LONG_SETTING]), reachRoute([LONG_SETTING, LAB_SETTING])], async (p) => {
    assert.equal(await p.locator('#right .reach-raw details.long-guard').count(), 2);
    await p.click('#right .reach-raw > summary');
    await p.locator('#right .reach-link .long-guard > summary').click();
    const openState = () => p.locator('#right').evaluate((r) => ({
      fold: r.querySelector('details.reach-raw').open,
      long: [...r.querySelectorAll('details.long-guard')].map((g) => g.open),
    }));
    const expected = { fold: true, long: [true, false] };
    assert.deepEqual(await openState(), expected);
    await p.click('#right .statuses button:has-text("더 필요")');
    assert.deepEqual(await openState(), expected);
    await p.fill('#right textarea', 'redraw');
    await p.click('#right button.save');
    await openHistory(p);
    await p.waitForSelector('#right .history li:has-text("redraw")');
    assert.deepEqual(await openState(), expected);
    await p.click('#story-list li:has-text("보고서")');
    await p.click('#story-list li:has-text("실험실을 열어")');
    assert.deepEqual(await openState(), { fold: false, long: [false, false] });
  });
});

test('in a browser, the story pane and the screen pane keep what is open apart: another story leaves a screen\'s link group open, and another screen leaves a story\'s fold open', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LONG_SETTING]), reachRoute([LAB_SETTING])], async (p) => {
    const sideTab = (label) => p.click(`#left .views.side button:has-text("${label}")`);
    await sideTab('화면');
    await p.click('#screen-list li:has-text("/lab")');
    await p.locator('#right details.link-group > summary').first().click();
    await sideTab('스토리');
    await p.click('#story-list li:has-text("보고서")');
    await p.click('#story-list li:has-text("실험실을 열어")');
    await sideTab('화면');
    assert.equal(await p.locator('#right details.link-group').first().evaluate((d) => d.open), true);

    await sideTab('스토리');
    await p.click('#right .reach-raw > summary');
    await p.locator('#right .reach-link .long-guard > summary').click();
    const storyOpen = () => p.locator('#right').evaluate((r) => [r.querySelector('details.reach-raw').open, r.querySelector('.reach-link details.long-guard').open]);
    for (const step of [0, 1]) {
      await p.locator('#center .step.on-map').nth(step).click();
      await p.waitForSelector('#screen-list li.selected');
      await sideTab('스토리');
      assert.deepEqual(await storyOpen(), [true, true]);
    }
  });
});

const CHIP = '서버 대조 안 함';
const CHIP_EXPLANATION = '서버 API 목록(serverEndpoints)이 없거나 비어 있어 API 호출을 서버와 견주지 않았습니다. 목록을 채우고 duru rebuild 를 다시 하면 견줍니다.';

const withoutServerList = (fn) => withRebuiltFixture({}, async (config, copy) => {
  fs.writeFileSync(path.join(copy, 'server-endpoints.txt'), '');
  fs.writeFileSync(path.join(copy, 'server-endpoints-lab.txt'), '');
  rebuild(copy);
  await fn(config, copy);
});

test('in a browser, with no server API list the header line carries a 「서버 대조 안 함」 chip in both views and nothing sits above the header', { skip: browserMissing }, async () => {
  await withoutServerList((config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const box = (sel) => p.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; }, sel);
        assert.equal(await p.locator('#meta .state').isVisible(), true);
        assert.equal(await p.textContent('#meta .state'), CHIP);
        assert.match(await p.innerText('#meta'), /^화면 \d+ · 테스트 있는 화면 \d+ · 맵 .+ · 테스트 연결 .+서버 대조 안 함$/);
        assert.equal(await p.locator('#server-notice').count(), 0);
        assert.equal(await p.evaluate(() => document.body.firstElementChild.tagName), 'HEADER');
        assert.equal((await box('header')).top, 0);
        assert.equal((await box('main')).top, (await box('header')).bottom);
        assert.equal((await box('main')).height, 900 - 49);
        assert.equal(await p.locator('input[name=dead]').count(), 0);
        assert.equal(await p.locator('#left input[type=checkbox]').count(), 5);

        await p.click('#screen-list li:has-text("/document/:tab")');
        assert.deepEqual(await p.locator('table.calls td.call .chip').allTextContents(), ['판정 불가', '대조 안 함']);
        assert.equal(await p.locator('table.calls td.call .chip.v-unchecked').count(), 1);
        assert.deepEqual(await p.locator('#center .list-absent').allTextContents(), ['서버 목록 없음']);
        assert.match(await p.textContent('#center h2:has(.list-absent)'), /^API 호출 \d+ 서버 목록 없음$/);
        await p.locator('table.calls tr:has(.chip.v-unchecked) td.cell').first().click();
        assert.match(await p.textContent('#right'), /서버 대조 목록 없음\s*대조 안 함/);
        assert.deepEqual(await p.locator('#right .list-absent').allTextContents(), ['목록 없음']);
        assert.equal(await p.textContent('#right h2:has(.list-absent)'), '서버 대조 목록 없음');
        const text = () => p.innerText('body');
        assert.doesNotMatch(await text(), /죽은 화면|서버에 없음/);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        await p.click('#flow button:has-text("모두 펼치기")');
        await p.waitForSelector('#flow .box.call');
        assert.equal(await p.locator('#meta .state').isVisible(), true);
        assert.equal(await p.locator('#server-notice').count(), 0);
        assert.equal((await box('#flow')).top, (await box('header')).bottom);
        assert.equal((await box('#flow')).height, 900 - 49);
        const labels = await p.locator('#flow .box.call .l2').allTextContents();
        assert.ok(labels.length > 0);
        assert.ok(labels.every((l) => l.endsWith(' · 대조 안 함')), labels.join('|'));
        assert.doesNotMatch(await text(), /죽은 화면|서버에 없음/);
      })));
});

test('in a browser, the 「서버 대조 안 함」 chip explains itself on hover and on keyboard focus, and the popover hangs below the header and stays 16 px inside the window at wide and narrow windows', { skip: browserMissing }, async () => {
  await withoutServerList((config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const chip = p.locator('#meta .state');
        const tip = p.locator('#server-state-tip');
        assert.equal(await chip.evaluate((el) => el.tagName), 'BUTTON');
        assert.equal(await chip.getAttribute('type'), 'button');
        assert.equal(await chip.getAttribute('tabindex'), null);
        assert.equal(await chip.getAttribute('aria-describedby'), 'server-state-tip');
        assert.equal(await chip.getAttribute('title'), null);
        assert.equal(await tip.getAttribute('role'), 'note');
        assert.equal(await tip.textContent(), CHIP_EXPLANATION);
        assert.equal(await tip.isVisible(), false);

        const inside = async (width) => {
          const r = await tip.evaluate((el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, h: innerHeight }; });
          assert.ok(r.left >= 16 && r.right <= width - 16 && r.bottom <= r.h, JSON.stringify(r));
          const chipLeft = await chip.evaluate((el) => el.getBoundingClientRect().left);
          assert.ok(Math.abs(r.left - Math.max(16, Math.min(chipLeft, width - 16 - (r.right - r.left)))) < 1, `${JSON.stringify(r)} chip ${chipLeft}`);
          const header = await p.evaluate(() => document.querySelector('header').getBoundingClientRect().bottom);
          assert.ok(r.top >= header, `popover ${r.top} sits over the header ${header}`);
          assert.equal(await p.evaluate(() => { const b = document.getElementById('server-state-tip').getBoundingClientRect(); return document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2).closest('#server-state-tip') !== null; }), true);
        };

        for (const width of [1440, 1100, 800, 600]) {
          await p.setViewportSize({ width, height: 900 });
          await p.mouse.move(0, 400);
          assert.equal(await tip.isVisible(), false);
          await chip.hover();
          assert.equal(await tip.isVisible(), true, `hover at ${width}`);
          await inside(width);
          await p.mouse.move(0, 400);
          assert.equal(await tip.isVisible(), false);
          await chip.focus();
          assert.equal(await tip.isVisible(), true, `focus at ${width}`);
          await inside(width);
          await p.evaluate(() => document.activeElement.blur());
          assert.equal(await tip.isVisible(), false);
        }

        await p.setViewportSize({ width: 1440, height: 900 });
        await p.focus('#view-flow');
        await p.keyboard.press('Tab');
        assert.equal(await p.evaluate(() => document.activeElement.className), 'chip state');
        assert.equal(await tip.isVisible(), true);
      })));
});

test('in a browser, with a server API list the page has no chip, no 「목록 없음」 note and keeps the dead-screen filter', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.locator('#meta .state, #server-state-tip, #server-notice').count(), 0);
        assert.doesNotMatch(await p.textContent('#meta'), /서버 대조 안 함/);
        assert.equal(await p.locator('input[name=dead]').count(), 1);
        assert.equal(await p.locator('#left input[type=checkbox]').count(), 6);
        await p.click('#screen-list li:has-text("/document/:tab")');
        assert.equal(await p.locator('.list-absent').count(), 0);
        assert.doesNotMatch(await p.textContent('#center'), /목록 없음/);
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.equal(await p.locator('#meta .state').count(), 0);
      })));
});

test('in a browser, a 「죽은 화면」 filter left checked does not hide every screen once the map is rebuilt without a server API list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.check('#left input[name=dead]');
        const dead = await p.locator('#screen-list li').count();
        assert.ok(dead > 0 && dead < 11, String(dead));

        fs.writeFileSync(path.join(copy, 'server-endpoints.txt'), '');
        fs.writeFileSync(path.join(copy, 'server-endpoints-lab.txt'), '');
        rebuild(copy);
        await p.click('#screen-list li >> nth=0');
        await p.click('#center tr:has-text("화면 전체")');
        await p.click('#right .statuses button:has-text("충분")');
        await p.click('#right button.save');
        await p.waitForSelector('#center tr.selected td.mark:has-text("충분")');

        assert.equal(await p.locator('#meta .state').isVisible(), true);
        assert.equal(await p.locator('input[name=dead]').count(), 0);
        assert.equal(await p.locator('#screen-list li').count(), 11);
      }));
  });
});

const HELP_TEST = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'renders the help text' };

test('a judgment posted from the page is saved as a new file with the server-side author, and a discarded pair moves out of the screen\'s importing tests', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      assert.equal((await postJudgment(base, { test: HELP_TEST, node: '/help#Help', kind: 'discard' })).status, 400);
      const res = await postJudgment(base, { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'only renders a shared header', author: 'someone else' });
      assert.equal(res.status, 201);
      const { judgments } = loadJudgments(config.judgmentsDir);
      assert.deepEqual(judgments.map((j) => [j.test, j.node, j.kind, j.reason, j.author]), [[HELP_TEST, '/help#Help', 'discard', 'only renders a shared header', 'reviewer']]);

      const data = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.tests.importers['/help#Help'].map((t) => t.title), ['shows the day the help was last updated']);
      assert.deepEqual(data.tests.discarded['/help#Help'].map((t) => [t.title, t.judgment.reason]), [['renders the help text', 'only renders a shared header']]);
      const importedAt = (roots) => walkFlow(roots).find((n) => n.id === '/help#Help').imported;
      const branch = await (await fetch(`${base}/api/flow?from=${encodeURIComponent('/home#Home')}`)).json();
      assert.deepEqual([importedAt(data.flow.roots), importedAt(branch.roots)], [1, 1]);
    }),
  );
});

test('in a browser, a branch shown on its own counts the importing tests again after a pair is discarded', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const helpLine = async () => (await screenBox(p, '/help#Help')).locator('.l2').textContent();
        await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: /^이 가지만$/ }).click();
        await p.waitForSelector('.flowbar .focusing');
        assert.match(await helpLine(), /불러옴 2/);

        await p.click('#view-list');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await excludeIn(first, 'only renders a shared header');
        await p.waitForSelector('#center .discarded');

        await p.click('#view-flow');
        await p.waitForSelector('.flowbar .focusing');
        assert.match(await helpLine(), /불러옴 1/);
      }, { view: 'flow' })));
});

test('in a browser, a test importing a screen is discarded with a reason, stays discarded after a rebuild, and comes back when undone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await excludeIn(first, 'only renders a shared header');
        await p.waitForSelector('#center .discarded');

        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => [j.test, j.node, j.kind, j.reason, j.author]), [
          [HELP_TEST, '/help#Help', 'discard', 'only renders a shared header', 'reviewer'],
        ]);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 1');
        assert.equal(await p.locator('#screen-list li:has-text("/help") .importer-count').textContent(), '불러옴 1');
        assert.equal(await p.textContent('#center .discarded h2'), '제외한 짝 1');
        assert.match(await p.textContent('#center .discarded .importer'), /renders the help text.*only renders a shared header.*reviewer/s);

        execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 1');

        await p.click('#center .discarded button.undo');
        await p.waitForSelector('#center .discarded', { state: 'detached' });
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
        assert.equal(await p.locator('#screen-list li:has-text("/help") .importer-count').textContent(), '불러옴 2');
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['discard', 'undo']);
      })));
});

test('in a browser, the window asking why a pair is excluded names the pair, and a discard without a reason cannot be sent', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        assert.equal(await p.locator(asked).isVisible(), false);
        await first.locator('button.discard').click();
        assert.equal(await p.locator(asked).evaluate((el) => el.matches(':modal')), true);
        assert.equal(await p.textContent(`${asked} h2`), '이 짝을 제외합니다');
        assert.match(await p.textContent(`${asked} .pairs`), /테스트renders the help text.*Help\.spec\.js.*화면\/help Help/s);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '제외']);
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), true);

        await p.fill(why, '  \n ');
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), true);
        await p.press(why, 'Control+Enter');
        assert.equal(await p.locator(asked).isVisible(), true);
        assert.equal(fs.existsSync(config.judgmentsDir), false);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
      })));
});

test('in a browser, Enter breaks the line of the reason and Ctrl+Enter sends it without the blank ends, and the saved reason keeps its lines', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.locator('#center .importers .importer', { hasText: 'renders the help text' }).locator('button.discard').click();
        await p.keyboard.type(' only renders');
        await p.keyboard.press('Enter');
        await p.keyboard.type('a shared header');
        await p.keyboard.press('Enter');
        assert.equal(await p.inputValue(why), ' only renders\na shared header\n');
        assert.equal(fs.existsSync(config.judgmentsDir), false);

        await p.keyboard.press('Control+Enter');
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.reason), ['only renders\na shared header']);
        assert.equal(await p.locator('#center .discarded .memo').evaluate((el) => getComputedStyle(el).whiteSpace), 'pre-wrap');
      })));
});

const asked = '#exclude';
const why = `${asked} textarea`;
const askedFocused = (p) => p.evaluate((sel) => document.activeElement.matches(sel), why);

async function excludeIn(row, reason) {
  await row.locator('button.discard').click();
  await row.page().fill(why, reason);
  await row.page().click(`${asked} button.discard`);
}

async function excludePicked(p, reason) {
  await p.click('#center .bulk-bar button.discard');
  await p.fill(why, reason);
  await p.click(`${asked} button.discard`);
}

const SAVE_REFUSED = ['Failed to load resource: the server responded with a status of 500 (Internal Server Error)'];

test('in a browser, a judgment that fails to save shows its error beside the test whose button was pressed, and each way of leaving that view clears it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.route('**/api/judgments', (route) => route.fulfill({ status: 500, body: 'disk full' }));
        const errorOf = () => p.evaluate(() => state.judgmentError);
        const second = p.locator('#center .importers .importer').nth(1);
        const failToSave = async () => {
          await second.locator('button.hand-over').click();
          await second.locator('.judgment-error').waitFor();
        };
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await failToSave();
        assert.equal(await p.locator('#center .judgment-error').count(), 1);
        assert.equal(await p.locator('#center .importers .importer').first().locator('.judgment-error').count(), 0);

        await p.click('#screen-list li:not(:has-text("/help"))');
        assert.equal(await errorOf(), null);
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await failToSave();
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#left .views.side button:has-text("화면")');
        assert.equal(await errorOf(), null);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await failToSave();
        await p.click('#center table tbody tr:has-text("테스트 ") >> nth=0');
        await p.locator('#center table tbody tr.selected').waitFor();
        assert.equal(await errorOf(), null);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
        assert.deepEqual(errors.splice(0), [...SAVE_REFUSED, ...SAVE_REFUSED, ...SAVE_REFUSED]);
      })));
});

test('in a browser, choosing a story clears a judgment error that failed to save while the story list was open', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        let held;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer').first();
        await first.locator('button.hand-over').click();
        await untilSet(() => held, 'the first judgment request');
        await p.click('#left .views.side button:has-text("스토리")');
        await held.fulfill({ status: 500, body: 'disk full' });
        await p.waitForFunction(() => state.judgmentError !== null);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        await p.click('#story-list li >> nth=0');
        assert.equal(await p.evaluate(() => state.judgmentError), null);
      })));
});

test('in a browser, a judgment that fails to save after another screen was selected still shows its error', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        let held;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer').first();
        await first.locator('button.hand-over').click();
        await untilSet(() => held, 'the first judgment request');
        await p.click('#screen-list li:not(:has-text("/help"))');
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
        await held.fulfill({ status: 500, body: 'disk full' });
        await p.locator('#center .judgment-error').waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.match(await p.textContent('#center .judgment-error'), /저장하지 못했습니다: disk full/);
        assert.equal(await p.locator('#center .judgment-error').count(), 1);

        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
      })));
});

test('in a browser, a pair included with one press waits for its tag apart from the importing tests, and comes back when undone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        assert.deepEqual(await first.locator('.judge-row > *').allTextContents(), ['제외', '포함']);
        await first.locator('button.hand-over').click();
        await p.waitForSelector('#center .awaiting-tag');

        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => [j.test, j.node, j.kind, j.reason, j.author]), [
          [HELP_TEST, '/help#Help', 'hand-over', '', 'reviewer'],
        ]);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 1');
        assert.equal(await p.locator('#screen-list li:has-text("/help") .importer-count').textContent(), '불러옴 1');
        assert.equal(await p.textContent('#center .awaiting-tag h2'), '태그 대기 1');
        assert.match(await p.textContent('#center .awaiting-tag .importer'), /renders the help text.*reviewer/s);
        assert.equal(await p.locator('#center .discarded').count(), 0);

        await p.click('#center .awaiting-tag button.undo');
        await p.waitForSelector('#center .awaiting-tag', { state: 'detached' });
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['hand-over', 'undo']);
      })));
});

test('in a browser, a hand-over saved with a note shows the note while it waits for its tag', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    addJudgment(config.judgmentsDir, { test: HELP_TEST, node: '/help#Help', kind: 'hand-over', reason: 'checks the help screen', author: 'earlier reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        assert.match(await p.textContent('#center .awaiting-tag .importer'), /renders the help text.*메모 checks the help screen.*earlier reviewer/s);
      }));
  });
});

test('in a browser, a hand-over whose test is no longer found shows apart and is closed by undoing it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const gone = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'a title that was renamed' };
    addJudgment(config.judgmentsDir, { test: gone, node: '/help#Help', kind: 'hand-over', reason: 'was about the help text', author: 'someone' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .detached h2'), '떨어져 나감 1');
        assert.match(await p.textContent('#center .detached p.muted'), /결과에서 찾을 수 없/);
        assert.match(await p.textContent('#center .detached .importer'), /components\/Help\.spec\.js.*a title that was renamed.*was about the help text.*someone/s);
        assert.equal(await p.locator('#center .awaiting-tag').count(), 0);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');

        await p.click('#center .detached button.undo');
        await p.waitForSelector('#center .detached', { state: 'detached' });
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['hand-over', 'undo']);
      }));
  });
});

const DOCUMENT_TABLE = { source: 'results/vitest/client-unit.json', file: 'components/DocumentTable.spec.js', title: 'DocumentTable › lists the documents it is given' };
const DETAIL_TEST = { source: 'results/vitest/client-unit.json', file: 'components/DocumentDetail.spec.js', title: 'loads the detail screen only when it is needed' };

test('the data carries the untagged tests with the reference a judgment points at them by', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const { tests } = await (await fetch(`${base}/api/data`)).json();
      assert.equal(tests.untaggedCount, 13);
      assert.equal(tests.untagged.length, 13);
      assert.deepEqual(tests.untagged.find((t) => t.title === DOCUMENT_TABLE.title).ref, DOCUMENT_TABLE);
    }),
  );
});

test('in a browser, the untagged tab lists every untagged test and a search box narrows the list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent(untaggedTab), '태그 없음 13');
        await p.click(untaggedTab);
        assert.equal(await p.locator('#untagged-list li').count(), 13);
        const detail = p.locator('#untagged-list li', { hasText: 'loads the detail screen only when it is needed' });
        assert.equal(await detail.textContent(), '통과loads the detail screen only when it is needed components/DocumentDetail.spec.js:1');
        assert.match(await p.textContent('#untagged-list li:has-text("DocumentTable")'), /^실패/);
        await p.fill('#left input[type=search]', 'help');
        assert.deepEqual(await p.locator('#untagged-list li .title').allTextContents(), ['renders the help text', 'shows the day the help was last updated']);
        await p.fill('#left input[type=search]', 'nothing like this');
        assert.equal(await p.textContent('#untagged-list'), '해당하는 테스트가 없습니다.');
      })));
});

test('in a browser, a chosen untagged test shows the screens it imports with the files it came through, and a click on a screen opens it in the screen list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.equal(await p.textContent('#center h3'), 'DocumentTable › lists the documents it is given');
        assert.equal(await p.locator('#untagged-list li.selected').count(), 1);
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면의 짝 2');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.deepEqual(await pairs.locator('.screen-path').allTextContents(), ['/document/:tab(draft|done)', '/home']);
        assert.deepEqual(await pairs.locator('.via').allTextContents(), ['components/DocumentTable.js', 'components/DocumentTable.js']);
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['불러옴', '불러옴']);
        assert.equal(await p.locator('#center .pair button').count(), 0);

        await pairs.filter({ hasText: '/home' }).click();
        assert.equal(await p.getAttribute('#left .views.side button.on', 'class'), 'on');
        assert.equal(await p.textContent('#left .views.side button.on'), '화면 11');
        assert.equal(await p.textContent('#screen-list li.selected .name'), '/home Home');
      })));
});

test('in a browser, a discarded pair and a handed-over pair show their state under the untagged test', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: '/home#Home', kind: 'discard', reason: 'only lists documents', author: 'reviewer' });
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: '/document/:tab_draft_done_#DocumentList', kind: 'hand-over', reason: 'covers the list', author: 'reviewer' });
        await p.reload();
        await toList(p);
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.deepEqual(await pairs.locator('.screen-path').allTextContents(), ['/document/:tab(draft|done)', '/home']);
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['태그 대기', '제외한 짝']);
        assert.match(await pairs.nth(0).textContent(), /covers the list.*reviewer/s);
        assert.match(await pairs.nth(1).textContent(), /only lists documents.*reviewer/s);
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면의 짝 2');
      })));
});

test('in a browser, an untagged test whose imports were read and matched no screen says so', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("formats a date as year-month-day")');
        assert.equal(await p.locator('#center .pair').count(), 0);
        assert.equal(await p.textContent('#center .no-screens'), '이 테스트가 불러오는 파일로 이어진 화면이 없습니다. 화면 넷 이상이 함께 쓰는 파일과 찾지 못한 파일로는 잇지 않습니다.');
      })));
});

test('in a browser, an untagged test whose imports were not read says why instead of claiming it imports nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        const say = async (title) => {
          await p.click(`#untagged-list li:has-text("${title}")`);
          assert.equal(await p.locator('#center .pair').count(), 0);
          return p.textContent('#center .no-screens');
        };
        assert.equal(await say('Document service › sends the share mail'), '이 결과 형식(junit)에는 테스트가 불러오는 파일이 적혀 있지 않아, 어느 화면에 이어지는지 읽지 못했습니다.');
        assert.equal(await say('loads without errors'), '이 결과 형식(playwright)에는 테스트가 불러오는 파일이 적혀 있지 않아, 어느 화면에 이어지는지 읽지 못했습니다.');
        assert.equal(await say('cleanup'), '이 결과 형식(verdict)에는 테스트가 불러오는 파일이 적혀 있지 않아, 어느 화면에 이어지는지 읽지 못했습니다.');
        assert.equal(await say('keeps the old menu'), '테스트가 불러오는 파일을 읽지 못했습니다. 테스트 파일을 소스 폴더에서 찾지 못했습니다.');
      })));
});

test('in a browser, a tests.json without the untagged list shows the count and asks for a rebuild instead of saying there are no untagged tests', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          delete data.tests.untagged;
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent(untaggedTab), '태그 없음 13');
        await p.click(untaggedTab);
        assert.match(await p.textContent('#center-body'), /태그 없는 테스트 목록이 없습니다.*duru rebuild/s);
        assert.doesNotMatch(await p.textContent('#center-body'), /태그 없는 테스트가 없습니다/);
        assert.equal(await p.locator('#untagged-list li:not(.muted)').count(), 0);
        assert.doesNotMatch(await p.textContent('#untagged-list'), /해당하는 테스트가 없습니다/);
      })));
});

test('in a browser, a pair for a screen that is no longer on the map shows as an off-map item that cannot be opened', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          data.map.screens = data.map.screens.filter((s) => s.id !== '/home#Home');
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.equal(await pairs.count(), 2);
        const off = pairs.filter({ hasText: '/home#Home' });
        assert.equal(await off.count(), 1);
        assert.match(await off.getAttribute('class'), /off-map/);
        assert.doesNotMatch(await off.getAttribute('class'), /on-map/);
        assert.equal(await off.getAttribute('title'), null);
        assert.match(await off.textContent(), /맵에 없는 화면/);
        assert.match(await off.textContent(), /components\/DocumentTable\.js/);
        assert.match(await pairs.filter({ hasText: '/document/:tab' }).getAttribute('class'), /on-map/);
        await off.click();
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.textContent('#center h3'), 'DocumentTable › lists the documents it is given');
      })));
});

test('in a browser, a hand-over of a test that no longer imports the screen shows under the test as 떨어져 나감, as it does under the screen', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const format = { source: 'results/vitest/client-unit.json', file: 'components/formatDate.spec.js', title: 'formats a date as year-month-day' };
    addJudgment(config.judgmentsDir, { test: format, node: '/help#Help', kind: 'hand-over', reason: 'was about the help date', author: 'someone' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .detached h2'), '떨어져 나감 1');

        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("formats a date as year-month-day")');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.equal(await pairs.count(), 1);
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면의 짝 1');
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['떨어져 나감']);
        assert.equal(await pairs.locator('.screen-path').textContent(), '/help');
        assert.match(await pairs.textContent(), /메모 was about the help date.*someone/s);
        assert.equal(await pairs.locator('.via').count(), 0);
        assert.equal(await p.locator('#center .no-screens').count(), 0);
      }));
  });
});

test('in a browser, the imported-only filter keeps the screens with importing tests and no tagged test, counts a pair waiting for a tag and ignores a discarded one', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        addJudgment(config.judgmentsDir, { test: DETAIL_TEST, node: '/document/:id#DocumentDetail', kind: 'discard', reason: 'only loads a view', author: 'reviewer' });
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: '/document/:tab_draft_done_#DocumentList', kind: 'hand-over', reason: '', author: 'reviewer' });
        const bare = ['/help#Help', '/document/:id#DocumentDetail', '/document/:tab_draft_done_#DocumentList'];
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          for (const id of bare) delete data.tests.nodes[id];
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.locator('#screen-list li').count(), 11);
        assert.equal(await p.locator('#left .filters label:has-text("지나간 테스트만 있음")').count(), 1);
        await p.check('#left input[name="imported-only"]');
        assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/document/:tab(draft|done)', '/help']);
        const counts = async (path) => (await p.locator('#screen-list li', { hasText: path }).locator('.count').allTextContents()).join('');
        assert.equal(await counts('/document/:tab'), '테스트 없음태그 대기 1');
        assert.equal(await counts('/help'), '테스트 없음불러옴 2');
        await p.uncheck('#left input[name="imported-only"]');
        assert.equal(await p.locator('#screen-list li').count(), 11);
      })));
});

const LIST_NODE = '/document/:tab_draft_done_#DocumentList';
const HOME_NODE = '/home#Home';
const pick = '#center .pair-row input.pick';
const bulk = '#center .bulk-bar';

async function openDocumentTable(p) {
  await p.waitForSelector('#screen-list li');
  await p.click(untaggedTab);
  await p.click('#untagged-list li:has-text("DocumentTable")');
}

const untilSet = async (get, what, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!get()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return get();
};

const judgedBy = (config) => loadJudgments(config.judgmentsDir).judgments.map((j) => [j.node, j.kind, j.reason, j.author]).sort();

test('in a browser, only the pairs that still import get a checkbox, the bulk buttons stay disabled until a pair is picked and say how many are', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: HOME_NODE, kind: 'discard', reason: 'only lists documents', author: 'reviewer' });
        await p.reload();
        await toList(p);
        await openDocumentTable(p);
        assert.equal(await p.locator('#center .pair').count(), 2);
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair', { hasText: '/home' }).locator('input').count(), 0);
        assert.equal(await p.locator('#center .pair', { hasText: '/home' }).locator('button').count(), 0);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), true);
        assert.equal(await p.locator(`${bulk} button.discard`).isDisabled(), true);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (0)');
        assert.equal(await p.locator(asked).isVisible(), false);

        await p.check(pick);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (1)');
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (1)');
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), false);
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.locator('#screen-list').count(), 0);
        await p.uncheck(pick);
        assert.equal(await p.locator(`${bulk} button.discard`).isDisabled(), true);
      })));
});

test('in a browser, picking a pair does not open its screen, and the pick-all box picks every pair that can be judged', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(pick.concat(' >> nth=0'));
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator(`${bulk} input.pick-all`).isChecked(), false);

        await p.check(`${bulk} input.pick-all`);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (2)');
        await p.uncheck(`${bulk} input.pick-all`);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 0);
        assert.equal(await p.locator(`${bulk} input.pick-all`).isChecked(), false);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), true);
      })));
});

test('in a browser, a pair whose screen is not on the map has no checkbox and is not picked by the pick-all box', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          data.map.screens = data.map.screens.filter((s) => s.id !== HOME_NODE);
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await openDocumentTable(p);
        assert.equal(await p.locator('#center .pair').count(), 2);
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair.off-map input').count(), 0);
        await p.check(`${bulk} input.pick-all`);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (1)');
      })));
});

test('in a browser, several pairs of one untagged test are included in one go, each as its own judgment file', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);

        assert.deepEqual(judgedBy(config), [
          [LIST_NODE, 'hand-over', '', 'reviewer'],
          [HOME_NODE, 'hand-over', '', 'reviewer'],
        ]);
        const files = fs.readdirSync(config.judgmentsDir, { recursive: true }).filter((f) => f.endsWith('.json'));
        assert.equal(files.length, 2);
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['태그 대기', '태그 대기']);
        assert.equal(await p.locator(pick).count(), 0);
        assert.equal(await p.locator(bulk).count(), 0);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        assert.match(await p.textContent('#center .awaiting-tag'), /DocumentTable › lists the documents it is given/);
        assert.doesNotMatch(await p.textContent('#center'), /불러오는 테스트/);
      })));
});

test('in a browser, several pairs of one untagged test are discarded in one go with one reason, asked for in a window that lists the picked screens', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        assert.equal(await p.textContent(`${asked} h2`), '짝 2개를 제외합니다');
        assert.match(await p.textContent(`${asked} .pairs`), /lists the documents it is given.*DocumentTable/s);
        assert.deepEqual(await p.locator(`${asked} .pairs li`).allTextContents(), ['/document/:tab(draft|done) DocumentList', '/home Home']);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '제외 (2)']);
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${bulk} .bulk-error`).count(), 0);

        await p.press(why, 'Control+Enter');
        assert.equal(fs.existsSync(config.judgmentsDir), false);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);

        await p.fill(why, 'only lists documents');
        await p.press(why, 'Control+Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 2);
        assert.deepEqual(judgedBy(config), [
          [LIST_NODE, 'discard', 'only lists documents', 'reviewer'],
          [HOME_NODE, 'discard', 'only lists documents', 'reviewer'],
        ]);
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(await p.locator(bulk).count(), 0);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        assert.equal(await p.textContent('#center .discarded h2'), '제외한 짝 1');
        assert.equal(await p.locator('#center .importers').filter({ hasText: 'DocumentTable' }).count(), 0);
      })));
});

test('in a browser, the window asking for a reason is put away with 「취소」 or Escape and not by a click outside it, the reason typed goes with it and nothing is sent', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        const focusedButton = () => p.evaluate(() => [document.activeElement.closest('.bulk-bar, .judge-row')?.className, document.activeElement.className]);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        await p.fill(why, 'typed and dropped');
        await p.mouse.click(5, 5);
        assert.equal(await p.locator(asked).isVisible(), true);
        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(await focusedButton(), ['bulk-bar', 'discard']);

        await p.click(`${bulk} button.discard`);
        assert.equal(await p.inputValue(why), '');
        await p.click(`${asked} button.cancel`);
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(await focusedButton(), ['bulk-bar', 'discard']);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        const row = p.locator('#center .importers .importer', { hasText: 'DocumentTable' }).locator('.judge-row');
        await row.locator('button.discard').click();
        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(await focusedButton(), ['judge-row', 'discard']);
        assert.equal(fs.existsSync(config.judgmentsDir), false);
      })));
});

test('in a browser, while a discard is being saved the window stays open and locked, Ctrl+Enter and Escape do nothing, and one discard is saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let held;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          held = route;
        });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await first.locator('button.discard').click();
        await p.fill(why, 'only renders a shared header');
        await p.press(why, 'Control+Enter');
        await untilSet(() => held, 'the judgment request');

        assert.deepEqual(await p.$$eval(`${asked} button`, (list) => list.map((b) => b.disabled)), [true, true]);
        assert.equal(await p.locator(why).evaluate((el) => el.readOnly), true);
        await p.keyboard.press('Control+Enter');
        await p.keyboard.press('Escape');
        await p.keyboard.press('Escape');
        assert.equal(await p.locator(asked).isVisible(), true);
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.inputValue(why), 'only renders a shared header');
        await p.locator(`${asked} button.discard`).click({ force: true });
        assert.equal(calls, 1);

        await held.continue();
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(loadJudgments(config.judgmentsDir).judgments.length, 1);
      })));
});

test('in a browser, a discard that fails to save leaves the window open with its reason and the error, and saves when sent again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const refuse = (route) => route.fulfill({ status: 500, body: 'disk full' });
        await p.route('**/api/judgments', refuse);
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await excludeIn(first, 'only renders a shared header');
        await p.locator(`${asked} .error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.equal(await p.textContent(`${asked} .error`), '저장하지 못했습니다: disk full');
        assert.equal(await p.inputValue(why), 'only renders a shared header');
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), false);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await p.unroute('**/api/judgments', refuse);
        await p.press(why, 'Control+Enter');
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.reason), ['only renders a shared header']);

        await p.locator('#center .importers .importer').first().locator('button.discard').click();
        assert.equal(await p.locator(`${asked} .error`).isVisible(), false);
      })));
});

test('in a browser, 「제외」 does not ask for a reason while the 「포함」 of the same row is being saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let held;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await first.locator('button.hand-over').click();
        await untilSet(() => held, 'the judgment request');
        await first.locator('button.discard').click();
        assert.equal(await p.locator(asked).isVisible(), false);
        await held.continue();
        await p.waitForSelector('#center .awaiting-tag');
      })));
});

test('in a browser, a judgment of another row that ends while a reason is being typed leaves the focus and the typing in the window', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        let held;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const rows = p.locator('#center .importers .importer');
        await rows.nth(0).locator('button.hand-over').click();
        await untilSet(() => held, 'the judgment request');
        await rows.nth(1).locator('button.discard').click();
        await p.keyboard.type('second row re');
        await held.fulfill({ status: 500, body: 'disk full' });
        await rows.nth(0).locator('.judgment-error').waitFor();
        await p.keyboard.type('ason');
        assert.equal(await p.inputValue(why), 'second row reason');
        assert.equal(await askedFocused(p), true);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

test('in a browser, every pair judged in bulk is undone one at a time from its screen', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        await p.click('#center .awaiting-tag button.undo');
        await p.waitForSelector('#center .awaiting-tag', { state: 'detached' });
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['hand-over', 'hand-over', 'undo']);

        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['태그 대기', '불러옴']);
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair-row', { hasText: '/home' }).locator('input.pick').count(), 1);
      })));
});

test('in a browser, the pick survives a redraw, goes when another test is chosen, and drops a pair that is judged elsewhere', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        await p.fill(why, 'typed reason');
        await p.evaluate(() => render());
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
        assert.equal(await p.inputValue(why), 'typed reason');
        await p.click(`${asked} button.cancel`);

        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: HOME_NODE, kind: 'discard', reason: 'judged elsewhere', author: 'someone' });
        await p.evaluate(async () => { await load(); render(); });
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (1)');

        await p.click('#untagged-list li:has-text("loads the detail screen only when it is needed")');
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 0);
        assert.deepEqual(await p.locator(`${bulk} button`).allTextContents(), ['제외 (0)', '포함 (0)']);
      })));
});

test('in a browser, a bulk save that fails midway stops, keeps the unsaved pairs picked and says which pairs were saved and which were not', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        const refuse = async (route) => {
          calls += 1;
          if (calls === 2) await route.fulfill({ status: 500, body: 'disk full' });
          else await route.continue();
        };
        await p.route('**/api/judgments', refuse);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();

        assert.equal(calls, 2);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.deepEqual(judgedBy(config), [[LIST_NODE, 'hand-over', '', 'reviewer']]);
        const message = await p.textContent(`${bulk} .bulk-error`);
        assert.match(message, /^저장하지 못했습니다: disk full\n저장한 짝 1: /);
        assert.match(message, /저장한 짝.*\/document\/:tab\(draft\|done\)/s);
        assert.match(message, /저장하지 못한 짝.*\/home/s);
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['태그 대기', '불러옴']);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator('#center .pair-row', { hasText: '/home' }).locator('input.pick').isChecked(), true);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), false);
        await p.click(`${bulk} button.discard`);
        assert.equal(await p.textContent(`${bulk} .bulk-error`), message);
        await p.click(`${asked} button.cancel`);
        assert.equal(await p.textContent(`${bulk} .bulk-error`), message);

        await p.unroute('**/api/judgments', refuse);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.equal(await p.locator(`${bulk} .bulk-error`).count(), 0);
        assert.equal(judgedBy(config).length, 2);
      })));
});

test('in a browser, the bulk controls stay disabled while the requests are in flight', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        let held;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 1) held = route;
          else route.continue();
        });
        await p.check(`${bulk} input.pick-all`);
        await excludePicked(p, 'only lists documents');
        await untilSet(() => held, 'the first judgment request');
        for (const sel of [`${bulk} button.discard`, `${bulk} button.hand-over`, `${bulk} input.pick-all`, pick, `${asked} button.discard`, `${asked} button.cancel`]) {
          assert.equal(await p.locator(sel).first().isDisabled(), true, sel);
        }
        assert.equal(await p.locator(why).evaluate((el) => el.readOnly), true);
        await p.locator(`${asked} button.discard`).click({ force: true });
        await p.press(why, 'Control+Enter');
        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), true);
        assert.equal(calls, 1);
        await held.continue();
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 2);
        assert.equal(judgedBy(config).length, 2);
      })));
});

test('in a browser, nothing leaves the test while a bulk is in flight, and the report of a bulk that fails midway is there when it ends', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const ended = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        let held;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 1) held = route;
          else route.fulfill({ status: 500, body: 'disk full' });
        });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await untilSet(() => held, 'the first judgment request');

        for (const sel of ['#left .views.side button', '#view-list', '#view-flow', '#end-review']) {
          for (const el of await p.locator(sel).all()) assert.equal(await el.isDisabled(), true, sel);
        }
        const style = (sel, prop) => p.locator(sel).first().evaluate((el, name) => getComputedStyle(el)[name], prop);
        const otherTest = '#untagged-list li:has-text("loads the detail screen only when it is needed")';
        const homePair = '#center .pair:has-text("/home")';
        for (const sel of [otherTest, homePair]) {
          assert.equal(await style(sel, 'cursor'), 'default', sel);
          assert.equal(await p.locator(sel).first().getAttribute('title'), null, sel);
        }
        const lineBefore = await style(homePair, 'borderColor');
        await p.hover(homePair, { force: true });
        assert.equal(await style(homePair, 'borderColor'), lineBefore);
        await p.hover(otherTest, { force: true });
        assert.equal(await style(otherTest, 'backgroundColor'), 'rgba(0, 0, 0, 0)');

        await p.locator(otherTest).click({ force: true });
        assert.equal(await p.textContent('#untagged-list li.selected .title'), DOCUMENT_TABLE.title);
        assert.equal(await p.textContent('#center h3'), DOCUMENT_TABLE.title);
        await p.locator(homePair).click({ force: true });
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.locator(`${bulk} button.hand-over`).count(), 1);
        await p.locator('#left .views.side button:not(.on)').first().click({ force: true });
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        await p.locator('#view-flow').click({ force: true });
        assert.equal(await p.locator('main').isVisible(), true);
        await p.locator('#end-review').click({ force: true });
        assert.deepEqual(ended, []);

        await held.continue();
        await p.locator(`${bulk} .bulk-error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.match(await p.textContent(`${bulk} .bulk-error`), /저장한 짝 1.*\/document\/:tab\(draft\|done\).*저장하지 못한 짝 1.*\/home/s);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        assert.equal(await p.locator('#view-flow').isDisabled(), false);
        assert.equal(await p.locator('#left .views.side button').first().isDisabled(), false);
        assert.deepEqual(ended, []);
      })));
});

test('in a browser, while the end request is pending a bulk cannot start and the end button cannot be pressed twice, and a refused end unlocks both', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const ended = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        const judged = [];
        p.on('request', (r) => r.url().endsWith('/api/judgments') && judged.push(r.url()));
        let held;
        await p.route('**/api/end', (route) => { held = route; });
        await p.check(`${bulk} input.pick-all`);
        await p.click('#end-review');
        await untilSet(() => held, 'the end request');

        assert.equal(await p.locator('#end-review').isDisabled(), true);
        for (const kind of ['hand-over', 'discard']) {
          assert.equal(await p.locator(`${bulk} button.${kind}`).isDisabled(), true, kind);
          await p.locator(`${bulk} button.${kind}`).click({ force: true });
        }
        await p.locator('#end-review').click({ force: true });
        assert.deepEqual(judged, []);
        assert.equal(ended.length, 1);

        await held.fulfill({ status: 500, body: 'cannot end' });
        await p.waitForFunction(() => !document.getElementById('end-review').disabled);
        assert.match(await p.textContent('#end-error'), /cannot end/);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), false);
        assert.equal(await p.locator(`${bulk} button.discard`).isDisabled(), false);
        errors.splice(0);
        await p.unroute('**/api/end');
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.equal(judged.length, 2);
      })));
});

test('in a browser, the page that was told the review ended shows the ended screen without errors when the end request was pending while the buttons were pressed', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        let held;
        await p.route('**/api/end', (route) => { held = route; });
        await p.check(`${bulk} input.pick-all`);
        await p.click('#end-review');
        await untilSet(() => held, 'the end request');
        await p.locator(`${bulk} button.hand-over`).click({ force: true });
        await held.continue();
        await p.locator('#ended').waitFor();
        assert.match(await p.textContent('#ended'), /리뷰를 끝냈습니다/);
        assert.deepEqual(judgedBy(config), []);
      })));
});

test('in a browser, a page that could not read its data still ends the review', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        const ended = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        await p.route('**/api/data', (route) => route.fulfill({ status: 500, body: 'data gone' }));
        await p.reload();
        await p.locator('#failed').waitFor();
        assert.match(await p.textContent('#failed'), /data gone/);
        await p.click('#end-review');
        await p.locator('#ended').waitFor({ timeout: 5000 });
        assert.match(await p.textContent('#ended'), /리뷰를 끝냈습니다/);
        assert.equal(ended.length, 1);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

const watchDataSettled = (p) => p.addInitScript(() => {
  const fetch = window.fetch;
  window.fetch = (...args) => {
    const sent = fetch(...args);
    if (String(args[0]).endsWith('/api/data')) {
      // 페이지가 이 응답을 받아 하는 일이 모두 끝난 뒤에 표시하도록 타이머로 미룬다.
      const settled = () => setTimeout(() => { window.dataSettled = true; });
      sent.then((res) => {
        const json = res.json.bind(res);
        res.json = () => {
          const body = json();
          body.then(settled, settled);
          return body;
        };
      }, settled);
    }
    return sent;
  };
});

test('in a browser, 「리뷰 끝」 pressed before the data arrived ends the review, and when the end is refused the button is not left locked', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        const data = await (await fetch(`${base}/api/data`)).text();
        const ended = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        let held;
        await p.route('**/api/data', (route) => { held = route; });
        await p.route('**/api/end', (route) => route.fulfill({ status: 500, body: 'cannot end' }));
        await p.reload();
        await untilSet(() => held, 'the data request');
        await p.click('#end-review');
        await p.waitForFunction(() => /cannot end/.test(document.getElementById('end-error').textContent), null, { timeout: 5000 });
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        await held.fulfill({ status: 200, contentType: 'application/json', body: data });
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        assert.equal(ended.length, 1);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);

        held = null;
        await p.unroute('**/api/end');
        await watchDataSettled(p);
        await p.reload();
        await untilSet(() => held, 'the data request');
        await p.click('#end-review');
        await p.locator('#ended').waitFor({ timeout: 5000 });
        assert.match(await p.textContent('#ended'), /리뷰를 끝냈습니다/);
        assert.equal(ended.length, 2);
        await held.fulfill({ status: 200, contentType: 'application/json', body: data });
        await p.waitForFunction(() => window.dataSettled);
        assert.equal(await p.locator('#ended').count(), 1);
      })));
});

test('in a browser, the data failing to arrive after the review ended leaves the ended screen without errors', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        let held;
        await p.route('**/api/data', (route) => { held = route; });
        await watchDataSettled(p);
        await p.reload();
        await untilSet(() => held, 'the data request');
        await p.click('#end-review');
        await p.locator('#ended').waitFor({ timeout: 5000 });
        await held.abort();
        await p.waitForFunction(() => window.dataSettled);
        assert.match(await p.textContent('#ended'), /리뷰를 끝냈습니다/);
        assert.deepEqual(errors.splice(0), ['Failed to load resource: net::ERR_FAILED']);
      })));
});

test('in a browser, the bulk buttons are locked in place while 「리뷰 끝」 is being sent, so the checkbox that was toggled keeps the focus', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const buttons = `${bulk} button`;
        const picked = `${pick}[data-pair="${LIST_NODE}"]`;
        const disabled = () => p.$$eval(buttons, (list) => list.map((b) => b.disabled));
        let held;
        await p.route('**/api/end', (route) => { held = route; });
        const refuseEnd = async () => {
          held = null;
          await p.evaluate(() => document.getElementById('end-review').click());
          await untilSet(() => held, 'the end request');
          assert.deepEqual(await disabled(), [true, true]);
          await held.fulfill({ status: 500, body: 'cannot end' });
          await p.waitForFunction(() => /cannot end/.test(document.getElementById('end-error').textContent));
        };

        await p.check(picked);
        await p.$eval(picked, (el) => { el.kept = true; });
        await refuseEnd();
        assert.deepEqual(await disabled(), [false, false]);
        assert.equal(await p.evaluate((sel) => document.activeElement.matches(sel) && document.activeElement.kept, picked), true);

        await p.uncheck(picked);
        await refuseEnd();
        assert.deepEqual(await p.locator(buttons).allTextContents(), ['제외 (0)', '포함 (0)']);
        assert.deepEqual(await disabled(), [true, true]);
        assert.deepEqual(errors.splice(0), [...SAVE_REFUSED, ...SAVE_REFUSED]);
      })));
});

test('in a browser, a refused end in the flow view leaves the diagram as it was drawn', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.setViewportSize({ width: 1440, height: 400 });
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box.screen');
        const scrollTop = await p.evaluate(() => {
          for (const box of document.querySelectorAll('#flow .box')) box.dataset.drawn = 'before';
          const flow = document.getElementById('flow');
          flow.scrollTop = 60;
          return flow.scrollTop;
        });
        assert.ok(scrollTop > 0);
        await p.route('**/api/end', (route) => route.fulfill({ status: 500, body: 'cannot end' }));
        await p.click('#end-review');
        await p.waitForFunction(() => /cannot end/.test(document.getElementById('end-error').textContent));
        assert.ok(await p.locator('#flow .box[data-drawn=before]').count() > 0);
        assert.equal(await p.locator('#flow .box:not([data-drawn=before])').count(), 0);
        assert.equal(await p.evaluate(() => document.getElementById('flow').scrollTop), scrollTop);
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

test('in a browser, the keyboard focus goes back to the bulk button that was pressed once the bulk ends, to the first control of the bar when that button is off, and stays in the window while a discard is not saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const active = () => p.evaluate(() => document.activeElement.className);
        const pressEnterOn = async (sel) => {
          await p.focus(sel);
          await p.keyboard.press('Enter');
        };
        await p.check(`${pick}[data-pair="${LIST_NODE}"]`);
        await pressEnterOn(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 1);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), true);
        assert.equal(await active(), 'pick-all');

        await p.check(`${pick}[data-pair="${HOME_NODE}"]`);
        await pressEnterOn(`${bulk} button.discard`);
        assert.equal(await askedFocused(p), true);

        const refuse = (route) => route.fulfill({ status: 500, body: 'disk full' });
        await p.route('**/api/judgments', refuse);
        await p.keyboard.type('only lists documents');
        await p.keyboard.press('Control+Enter');
        await p.locator(`${asked} .error`).waitFor();
        assert.match(await p.textContent(`${asked} .error`), /disk full/);
        assert.equal(await askedFocused(p), true);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        await p.keyboard.press('Escape');
        assert.equal(await active(), 'discard');

        await p.unroute('**/api/judgments', refuse);
        await pressEnterOn(`${bulk} button.discard`);
        await p.keyboard.type('only lists documents');
        await p.keyboard.press('Control+Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 1);
        assert.equal(await p.locator(bulk).count(), 0);
        assert.equal(await p.evaluate(() => document.activeElement.matches('#center .test-pairs h2')), true);
      })));
});

test('in a browser, a bulk that ends while the reviewer types in the search box leaves the focus and the typing there', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let held;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 1) held = route;
          else route.fulfill({ status: 500, body: 'disk full' });
        });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await untilSet(() => held, 'the first judgment request');
        const search = '#left input[type=search]';
        await p.click(search);
        await p.keyboard.type('Document');
        await p.$eval(search, (el) => { el.kept = true; });
        await held.continue();
        await p.locator(`${bulk} .bulk-error`).waitFor();
        assert.equal(await p.evaluate((sel) => document.activeElement.matches(sel) && document.activeElement.kept, search), true);
        await p.keyboard.type(' Table');
        assert.equal(await p.inputValue(search), 'Document Table');
        assert.equal(calls, 2);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

test('in a browser, a bulk that judges every pair moves the keyboard focus to the heading of the pairs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.focus(`${bulk} button.hand-over`);
        await p.keyboard.press('Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.equal(await p.locator(bulk).count(), 0);
        assert.equal(await p.evaluate(() => document.activeElement.matches('#center .test-pairs h2')), true);
      })));
});

test('in a browser, a pair saved by a bulk is not picked any more even when reading the data again fails, so a retry sends only the unsaved pairs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        const refuse = (route) => {
          calls += 1;
          if (calls === 2) route.fulfill({ status: 500, body: 'disk full' });
          else route.continue();
        };
        const unreadable = (route) => route.fulfill({ status: 500, body: 'data gone' });
        await p.route('**/api/judgments', refuse);
        await p.route('**/api/data', unreadable);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();

        assert.equal(errors.splice(0).length, 2);
        const message = await p.textContent(`${bulk} .bulk-error`);
        assert.match(message, /저장했지만 다시 읽지 못했습니다: data gone/);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator('#center .pair-row', { hasText: '/home' }).locator('input.pick').isChecked(), true);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (1)');

        await p.unroute('**/api/judgments', refuse);
        await p.unroute('**/api/data', unreadable);
        const sent = [];
        await p.route('**/api/judgments', (route) => {
          sent.push(route.request().postDataJSON().node);
          route.continue();
        });
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.deepEqual(sent, [HOME_NODE]);
        assert.equal(judgedBy(config).length, 2);
      })));
});

test('in a browser, the message of a failed bulk puts the report in its own line, and says "saved" only when a pair was saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        await p.route('**/api/judgments', (route) => route.fulfill({ status: 500, body: 'disk full' }));
        await p.route('**/api/data', (route) => route.fulfill({ status: 500, body: 'data gone' }));
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();

        errors.splice(0);
        const lines = (await p.textContent(`${bulk} .bulk-error`)).split('\n');
        assert.equal(lines.length, 3);
        assert.match(lines[0], /^저장하지 못했습니다: disk full$/);
        assert.match(lines[1], /^저장한 짝 0: 없음\. 저장하지 못한 짝 2: /);
        assert.equal(lines[2], '다시 읽지 못했습니다: data gone');
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
      })));
});

test('in a browser, a bulk discard that fails midway leaves the window open with the report, the reason and only the pairs not saved, and the rest is saved when sent again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        const refuse = async (route) => {
          calls += 1;
          if (calls === 2) await route.fulfill({ status: 500, body: 'disk full' });
          else await route.continue();
        };
        await p.route('**/api/judgments', refuse);
        await p.check(`${bulk} input.pick-all`);
        await excludePicked(p, 'only lists documents');
        await p.locator(`${asked} .error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);

        const message = await p.textContent(`${asked} .error`);
        assert.match(message, /^저장하지 못했습니다: disk full\n저장한 짝 1: .*저장하지 못한 짝 1: \/home/s);
        assert.equal(await p.textContent(`${bulk} .bulk-error`), message);
        assert.equal(await p.textContent(`${asked} h2`), '이 짝을 제외합니다');
        assert.deepEqual(await p.locator(`${asked} .pairs li`).allTextContents(), ['/home Home']);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '제외']);
        assert.equal(await p.inputValue(why), 'only lists documents');
        assert.equal(await askedFocused(p), true);
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['제외한 짝', '불러옴']);

        await p.unroute('**/api/judgments', refuse);
        await p.press(why, 'Control+Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 2);
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(judgedBy(config).map((j) => j.slice(1, 3)), [['discard', 'only lists documents'], ['discard', 'only lists documents']]);
      })));
});

test('in a browser, the failure report and the picks of a bulk survive opening a pair\'s screen and coming back, and a click on the same test', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 2) route.fulfill({ status: 500, body: 'disk full' });
          else route.continue();
        });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();
        errors.splice(0);
        const message = await p.textContent(`${bulk} .bulk-error`);

        const intact = async () => {
          assert.equal(await p.textContent(`${bulk} .bulk-error`), message);
          assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        };
        await p.locator('#center .pair', { hasText: '/document/' }).click();
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await intact();
        await p.click('#untagged-list li:has-text("DocumentTable")');
        await intact();

        await p.click('#untagged-list li:has-text("loads the detail screen only when it is needed")');
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.equal(await p.locator(`${bulk} .bulk-error`).count(), 0);
      })));
});

test('in a browser, picking a pair redraws only the middle and keeps the keyboard focus on the checkbox that was toggled', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.evaluate(() => { document.querySelector('#untagged-list li').dataset.kept = 'yes'; });
        await p.locator(pick).nth(1).focus();
        await p.keyboard.press('Space');
        assert.equal(await p.evaluate(() => {
          const el = document.activeElement;
          return el.matches('input.pick') && el.checked && [...document.querySelectorAll('input.pick')].indexOf(el);
        }), 1);
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (1)');
        assert.equal(await p.evaluate(() => document.querySelector('#untagged-list li').dataset.kept), 'yes');

        await p.locator(`${bulk} input.pick-all`).focus();
        await p.keyboard.press('Space');
        assert.equal(await p.evaluate(() => document.activeElement.matches('input.pick-all')), true);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
      })));
});
