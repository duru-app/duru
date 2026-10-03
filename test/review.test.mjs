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
import { addMark, loadMarks } from '../src/marks.mjs';
import { applyOverrides } from '../src/app-host.mjs';
import { startReviewServer } from '../src/review.mjs';
import { taskList } from '../src/tasks.mjs';

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

test('without a git user name the author typed on the page is used', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, null, async (base) => {
      assert.equal((await postMark(base, { target: { node: '/lab#Lab' }, status: 'fine' })).status, 400);
      assert.equal((await postMark(base, { target: { node: '/lab#Lab' }, status: 'fine', author: 'typed name' })).status, 201);
      const data = await (await fetch(`${base}/api/data`)).json();
      assert.equal(data.marks.attached[0].current.author, 'typed name');
    }),
  );
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

async function withPage(base, fn) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(base);
    await fn(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

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
          assert.match(await p.textContent('#right h2'), /API 깊이/);
          assert.equal(await p.isDisabled('#right button.save'), true);
          await p.click('#right .statuses button:has-text("더 필요")');
          await p.fill('#right textarea', 'no API test yet');
          await p.click('#right button.save');
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

test('in a browser, the story list sits next to the screen list, and a chosen story shows its screens in order with each link\'s verdict and what it takes to get to the end', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.deepEqual(await p.locator('#left .views.side button').allTextContents(), ['화면 11', '스토리 5']);
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
        assert.deepEqual(await p.locator('#right > *').evaluateAll((els) => els.slice(0, 2).map((e) => e.textContent)), ['도달 가능', '사전 조건']);
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
        assert.equal(await p.textContent('#right > p.muted'), '조건 없음');
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
        assert.match(await p.textContent('#right h2'), /^표시 — 화면 전체$/);
        assert.equal(await p.locator('#right .history li').count(), 0);
        assert.match(await p.textContent('#left'), /떨어져 나감 0/);

        fs.rmSync(path.join(config.storiesDir, 'run-lab.json'));
        await p.reload();
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
    withServer(config, null, (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await p.locator('#right h2:last-of-type + p.error').allTextContents(), ['작성자 이름을 위쪽에 적어 주세요. git user.name 이 설정되지 않았습니다.']);
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        assert.match(await p.textContent('#right'), /작성자 이름이 필요합니다/);
        await p.click('#story-list li:has-text("보고서")');
        assert.doesNotMatch(await p.textContent('#right'), /작성자 이름이 필요합니다/);
        await p.click('#story-list li:has-text("실험실을 열어")');
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.click('#left .views.side button:has-text("화면")');
        assert.doesNotMatch(await p.textContent('#right'), /작성자 이름이 필요합니다/);
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        assert.match(await p.textContent('#right'), /작성자 이름이 필요합니다/);
        await p.click('#center .story-path .step:has-text("/lab/result")');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
        assert.doesNotMatch(await p.textContent('#right'), /작성자 이름이 필요합니다/);
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
        assert.match(await p.textContent('#right .history'), /walk it/);
        await p.click('#right .statuses button:has-text("충분")');
        await p.click('#right button.save');
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

test('in a browser, a failed save does not follow the reviewer to another screen or another cell', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, null, (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const failSave = async () => {
          await p.click('#right .statuses button:has-text("없음")');
          await p.click('#right button.save');
          assert.match(await p.textContent('#right'), /작성자 이름이 필요합니다/);
        };
        await p.click('#screen-list li:has-text("/document/:id")');
        await failSave();
        await p.click('#center tr:has-text("API")');
        assert.doesNotMatch(await p.textContent('#right'), /작성자 이름이 필요합니다/);
        await failSave();
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.doesNotMatch(await p.textContent('#right'), /작성자 이름이 필요합니다/);
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
        assert.match(await p.textContent('#right > p.skipped'), /주소 못 읽은 링크 빼고 판정/);
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
        assert.equal(await p.textContent('#right > p.muted:not(.skipped)'), '판정한 구간에 조건 없음');
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
        assert.deepEqual(await access.locator('.needs .chip').allTextContents(), ['역할', '설정']);
        const fromHome = await access.locator('li:has-text("/home#Home")').innerText();
        assert.match(fromHome, /components\/SideMenu\.js:11/);
        assert.match(fromHome, /\['ADMIN', 'OWNER'\]\.indexOf\(session\['member\.role'\]\) > -1\s*역할/);
        assert.match(fromHome, /MENUS\.ADMIN\s*설정/);

        await p.uncheck('#left input[name=role]');
        await p.click('#screen-list li:has-text("/admin/member")');
        assert.match(await access.locator('.route').innerText(), /isAdminRole\(memberRole\)\s*역할/);
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.match(await access.locator('li:has-text("/lab#Lab")').innerText(), /설정 · 역할 조건 없음\s*링크를 건 화면에 필요한 것\s*설정/);
        assert.deepEqual(await access.locator('li:has-text("/lab#Lab") .from-kinds .chip').allTextContents(), ['설정']);
        await p.click('#screen-list li:has-text("/admin/audit")');
        assert.deepEqual(await access.locator('li:has-text("/admin/member#AdminMember") .from-kinds .chip').allTextContents(), ['역할']);
        await p.click('#screen-list li:has-text("/help")');
        assert.match(await access.locator('li:has-text("/signin#SignIn")').innerText(), /globalSettings\.SYSTEM\.HELP_LINK_ENABLED \(openHelp 로 물려받음\)\s*설정/);
        await p.click('#screen-list li:has-text("/signin")');
        assert.equal(await access.locator('p').innerText(), '설정이나 역할 없이 열립니다.');

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
        assert.equal(await access.locator('.needs').innerText(), '필요한 것 링크마다 다름');
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.deepEqual(await access.locator('li:has-text("/help#Help") .from-kinds .chip').allTextContents(), ['링크마다 다름']);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.match(await (await screenBox(p, '/help#Help')).locator('.l2').textContent(), / · 링크마다 다름$/);
      }),
    );
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
        assert.match(await p.textContent('#right h2'), /호출 전체/);
        assert.equal(await p.locator('#right .test').count(), 1);
        assert.match(await p.textContent('#right .test'), /rename is refused by the server/);

        await rename.locator('td.cell').nth(2).click();
        assert.match(await p.textContent('#right h2'), /API 깊이/);
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
        assert.match(await p.textContent('#right h2'), /withHistory 켬 · UI\/E2E 깊이/);
        assert.equal(await p.locator('#right .test').count(), 2);
        assert.match(await p.locator('#right .option-sites').innerText(), /components\/ExportDialog\.js:18/);

        await exportRows('withHistory 켬').locator('td.cell').nth(6).click();
        assert.match(await p.textContent('#right h2'), /withHistory 켬 · 산출물 깊이/);
        assert.equal(await p.locator('#right .test').count(), 0);
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right textarea', 'Open the exported file.');
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.missing');

        await exportRows('withAttachments 끔').locator('td.cell').first().click();
        assert.match(await p.textContent('#right h2'), /withAttachments 끔$/);
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
        assert.match(await p.textContent('#right h2'), /산출물 깊이/);
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

test('in a browser, the flow graph opens calls and branches, folds them, and a box opens the screen in the list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.equal(await p.isHidden('main'), true);
        assert.deepEqual(await boxCount(p), { screens: 11, calls: 0 });

        const home = await screenBox(p, '/home#Home');
        await home.locator('.calls').click();
        assert.deepEqual(await boxCount(p), { screens: 11, calls: 2 });
        assert.match(await home.locator('.calls').textContent(), /▾/);
        await home.locator('.calls').click();

        const signin = await screenBox(p, '/signin#SignIn');
        await signin.locator('button.toggle', { hasText: '−' }).click();
        assert.deepEqual(await boxCount(p), { screens: 1, calls: 0 });
        const folded = await screenBox(p, '/signin#SignIn');
        assert.match(await folded.locator('.l2').textContent(), /하위 합/);
        await folded.locator('button.toggle', { hasText: '+' }).click();

        await flowButton(p, '모두 펼치기').click();
        assert.deepEqual(await boxCount(p), { screens: 11, calls: 14 });
        const overlaps = await p.$$eval('#flow .box', (boxes) => boxes.flatMap((box) => {
          const outer = box.getBoundingClientRect();
          return [...box.querySelectorAll('.l1, .l3')].flatMap((line) => [...line.querySelectorAll('button')].filter((b) => {
            const r = b.getBoundingClientRect();
            const text = line.querySelector('.text')?.getBoundingClientRect();
            return r.right > outer.right + 0.5 || r.bottom > outer.bottom + 0.5 || (text && text.right > r.left + 0.5);
          }).map(() => box.title.split('\n')[0]));
        }));
        assert.deepEqual(overlaps, []);

        await flowButton(p, '모두 접기').click();
        assert.deepEqual(await boxCount(p), { screens: 1, calls: 0 });
        await (await screenBox(p, '/signin#SignIn')).locator('button[title^="이 가지 전부"]').click();
        assert.deepEqual(await boxCount(p), { screens: 11, calls: 14 });

        await (await screenBox(p, '/lab/result#LabResult')).click();
        await p.waitForSelector('main:not([hidden])');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
      }),
    ),
  );
});

const needLines = (box) => box.locator('.need').allTextContents();
const tipLines = async (box) => (await box.getAttribute('title')).split('\n').slice(1);

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
        const valueFits = await report.locator('.need .text', { hasText: '설정' }).evaluate((e) => {
          const range = document.createRange();
          range.setStart(e.firstChild, 0);
          const end = e.textContent.indexOf(' (');
          range.setEnd(e.firstChild, end < 0 ? e.textContent.length : end);
          return range.getBoundingClientRect().right <= e.getBoundingClientRect().right;
        });
        assert.ok(valueFits, 'the value is never the part cut off');
        assert.equal(await report.locator('.need .text', { hasText: '역할' }).evaluate((e) => e.scrollWidth > e.clientWidth), false);
        assert.deepEqual(await p.evaluate(() => nodeNeeds({ access: { settings: [{ from: 'route', unreadable: [], needs: [
          { path: ['SYSTEM', 'MENU'], need: 'present' },
          { path: ['SYSTEM', 'MENU', 'LIST'], need: 'includes', value: 'X' },
        ] }] } }).lines.map((l) => l.text)), ['설정 "X" (MENU.LIST 에) 외 1']);
        assert.deepEqual(await p.evaluate(() => nodeNeeds({ access: { roleValues: null, unreadableRoleGuards: [] } })), {
          lines: [{ kind: 'role', text: '역할 미확인' }], tips: ['필요한 역할: 미확인'],
        });
        assert.deepEqual((await tipLines(report)).filter((t) => t.startsWith('필요한')), [
          '필요한 역할: ADMIN, OWNER',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN.LIST 에 "ADMIN_REPORT"',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN 있음',
        ]);

        const boxes = await p.$$eval('#flow .box', (els) => els.map((e) => ({ id: e.title.split('\n')[0], left: e.offsetLeft, top: e.offsetTop, h: e.offsetHeight, over: e.scrollHeight > e.clientHeight })));
        assert.deepEqual(boxes.filter((b) => b.over).map((b) => b.id), []);
        for (const a of boxes) for (const b of boxes) {
          if (a !== b && a.left === b.left) assert.ok(a.top + a.h <= b.top || b.top + b.h <= a.top, `${a.id} and ${b.id} do not overlap`);
        }
      }),
    ),
  );
});

test('in a browser, a flow box without role or setting conditions has no extra line and keeps its size', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        const home = await screenBox(p, '/home#Home');
        assert.equal(await home.locator('.need').count(), 0);
        assert.equal(await home.evaluate((e) => e.offsetHeight), 60);
        assert.deepEqual(await tipLines(home), []);
        assert.equal(await (await screenBox(p, '/admin/audit#AdminAudit')).evaluate((e) => e.offsetHeight), 77);
      }),
    ),
  );
});

test('in a browser, a flow box sits midway between its first and last child and stays inside the canvas apart from the boxes in its column, whatever the box heights', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const trees = await p.evaluate(() => {
          const call = (id) => ({ kind: 'call', id });
          const screen = (id, access, children = [], calls = []) => {
            if (calls.length) state.openCalls.add(id);
            return { kind: 'screen', id, access, children, calls };
          };
          const role = { roleValues: ['ADMIN'], unreadableRoleGuards: [] };
          const both = { ...role, settings: [{ from: 'route', needs: [{ path: ['A'], need: 'on' }], unreadable: [] }] };
          const shapes = {
            plainOverCalls: [screen('root', {}, [screen('a', {}, [], [call('a1')]), screen('b', {}, [], [call('b1')])])],
            tallOverOneCall: [screen('root', {}, [screen('tall', role, [], [call('t1')]), screen('next', {}, [screen('grandchild', {})])])],
            tallOverScreens: [screen('root', {}, [screen('p', both, [screen('p1', {})]), screen('q', both, [screen('q1', {})])])],
            tallLast: [screen('tall', both, [], [call('t1')])],
            tallOverTallOverCall: [screen('root', {}, [screen('x', {}, [], [call('x1')]), screen('outer', both, [screen('inner', role, [], [call('i1')])])])],
          };
          return Object.fromEntries(Object.entries(shapes).map(([name, roots]) => {
            const { boxes, edges, height } = layoutTree(roots);
            return [name, { height, edges: edges.map((e) => [`${e.x1}:${e.y1}`, e.y1, e.y2]), boxes: boxes.map((b) => ({ id: b.node.id, x: b.x, y: b.y, bottom: b.y + b.height })) }];
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

test('in a browser, "back to start" returns one branch to how the page first drew it and leaves the rest alone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        const reset = async (id) => (await screenBox(p, id)).locator('button[title="처음 상태로"]').click();
        await (await screenBox(p, '/signin#SignIn')).locator('.calls').click();
        const signinCalls = (await boxCount(p)).calls;
        assert.ok(signinCalls > 0);
        await (await screenBox(p, '/lab#Lab')).locator('button.toggle', { hasText: '−' }).click();
        await (await screenBox(p, '/home#Home')).locator('button[title^="이 가지 전부"]').click();
        assert.ok((await boxCount(p)).calls > signinCalls);

        await reset('/home#Home');
        assert.deepEqual(await boxCount(p), { screens: 11, calls: signinCalls });
        assert.equal(await (await screenBox(p, '/lab#Lab')).locator('button.toggle', { hasText: '−' }).count(), 1);

        await (await screenBox(p, '/home#Home')).locator('button[title="이 가지만 보기"]').click();
        await p.waitForSelector('.flowbar .focusing');
        await (await screenBox(p, '/home#Home')).locator('button[title^="이 가지 전부"]').click();
        assert.ok((await boxCount(p)).calls > 0);
        await reset('/home#Home');
        assert.deepEqual(await boxCount(p), { screens: 10, calls: 0 });
        const bare = await p.evaluate(() => {
          const walk = (ns) => ns.flatMap((n) => [n, ...walk(n.children)]);
          return walk(state.focus.roots).find((n) => !n.children.length && !n.calls.length)?.id;
        });
        assert.ok(bare);
        assert.equal(await (await screenBox(p, bare)).locator('button[title="처음 상태로"]').count(), 0);
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
        assert.equal(await lab.locator('button.toggle', { hasText: '+' }).count(), 1);
        assert.match(await lab.getAttribute('class'), /s-pass/);
        assert.equal(await (await screenBox(p, '/home#Home')).locator('button.toggle', { hasText: '−' }).count(), 1);
        assert.equal(await p.$$eval('#flow .box.screen', (els) => els.some((e) => e.title.startsWith('/lab/result#'))), false);
      }),
    ),
  );
});

test('in a browser, one branch is shown on its own, and a late answer for an earlier click does not replace the later one', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        await (await screenBox(p, '/home#Home')).locator('button[title="이 가지만 보기"]').click();
        await p.waitForSelector('.flowbar .focusing');
        assert.match(await p.textContent('.flowbar .focusing'), /^\/home /);
        assert.equal((await boxCount(p)).screens, 10);
        await flowButton(p, '전체 보기').click();
        assert.equal((await boxCount(p)).screens, 11);

        await p.route('**/api/flow?from=*', async (route) => {
          if (route.request().url().includes(encodeURIComponent('/signin#SignIn'))) await new Promise((r) => setTimeout(r, 500));
          await route.continue();
        });
        await (await screenBox(p, '/signin#SignIn')).locator('button[title="이 가지만 보기"]').click();
        await (await screenBox(p, '/lab#Lab')).locator('button[title="이 가지만 보기"]').click();
        await p.waitForTimeout(800);
        assert.match(await p.textContent('.flowbar .focusing'), /^\/lab /);
      }),
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
