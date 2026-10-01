import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { chromium } from 'playwright-core';
import { loadMarks } from '../src/marks.mjs';
import { startReviewServer } from '../src/review.mjs';
import { taskList } from '../src/tasks.mjs';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.mjs');

async function withRebuiltFixture(configPatch, fn) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
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
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
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
    return await fn(`http://127.0.0.1:${server.address().port}`, presses, logins, listCalls);
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

test('app files taken from a deployed address are served without the headers that forbid framing, with the token put in', async () => {
  const build = path.join(FIXTURE, 'build');
  const deployed = http.createServer((req, res) => {
    const file = path.join(build, req.url === '/app.js' ? 'app.js' : 'index.html');
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
        withRebuiltFixture({ app: { ...appSettings(api).app, files } }, (config) =>
          withServer(config, 'reviewer', async (base) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const page = await fetch(`${app.url}/home`);
            assert.equal(page.headers.get('x-frame-options'), null);
            assert.equal(page.headers.get('content-security-policy'), null);
            assert.match(await page.text(), /FAKE_AUTH/);
            const script = await fetch(`${app.url}/app.js`);
            assert.match(script.headers.get('content-type'), /javascript/);
            assert.doesNotMatch(await script.text(), /t-123/);
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
        assert.match(await (await screenBox(p, '/admin/report#AdminReport')).locator('.l2').textContent(), / · 역할·설정 필요$/);
        assert.doesNotMatch(await (await screenBox(p, '/signin#SignIn')).locator('.l2').textContent(), /필요/);
      }),
    ),
  );
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

            await p.click('#screen-list li:has-text("/admin/member")');
            assert.match(await bar.locator('.error').first().textContent(), new RegExp(AUDITOR_PASSWORD_ENV));
            assert.match(await bar.textContent(), /읽지 못한 역할 조건도 있습니다: isAdminRole\(memberRole\)/);
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
