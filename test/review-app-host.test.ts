import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { loadConfig } from '../src/config.ts';
import { applyOverrides } from '../src/app-host.ts';
import { startReviewServer } from '../src/review.ts';
import { FIXTURE, withRebuiltFixture, signer, withServer, PASSWORD_ENV, ADMIN_PASSWORD_ENV, AUDITOR_PASSWORD_ENV, ACCOUNTS, withFakeApi, appSettings, SETTINGS_FILE, withSettingsFile, rewrite, rebuild, LIST_API, API_KEY_ENV, API_KEY, ISSUING_API, VIEW_TOKEN_API, VIEW_ROUTE, loginWithHeader, roleSettings, withPasswords, withPassword, ALL_PASSWORDS, pathValueSettings } from './review-helpers.ts';
import type { Config, PageData } from './review-helpers.ts';

const postSettings = (base: string, overrides: unknown) =>
  fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides }) });

function runSettingsFile(code: string) {
  const context = vm.createContext({});
  vm.runInContext('var window = globalThis;', context);
  vm.runInContext(code, context);
  return JSON.parse(vm.runInContext('JSON.stringify({ settings: window.FAKE_SETTINGS, kept: window.KEPT })', context));
}
const VIEW_SCREEN = '/view/:documentId#DocumentDetail';

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
          assert.match(script.headers.get('content-type')!, /javascript/);
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
    const file = path.join(build, ['/app.js', '/settings.js'].includes(req.url!) ? req.url!.slice(1) : 'index.html');
    res.writeHead(200, {
      'content-type': file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    });
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => deployed.listen(0, '127.0.0.1', resolve));
  try {
    const files = `http://127.0.0.1:${(deployed.address() as AddressInfo).port}`;
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
            assert.match(script.headers.get('content-type')!, /javascript/);
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
          const { app }: PageData = await (await fetch(`${base}/api/data`)).json();
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

const preparedFor = (config: Config, pathValues: unknown, id: string) =>
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
          const prepared = async (id: string) => (await fetch(`${base}/api/path-values?screen=${encodeURIComponent(id)}`)).json();
          assert.deepEqual(await prepared('/document/:tab_draft_done_#DocumentList'), {
            parts: ['/document', { name: 'tab', prefix: '/', optional: false, pattern: 'draft|done' }],
            values: { tab: 'draft' },
            queryNames: [],
            errors: [],
            path: '/document/draft',
            fallback: '/home#Home', fallbackPath: '/home',
          });
          const detail = await prepared('/document/:id#DocumentDetail');
          assert.deepEqual(detail, {
            parts: ['/document', { name: 'id', prefix: '/', optional: false, pattern: null }],
            values: { id: '17' },
            queryNames: [],
            errors: [],
            path: '/document/17',
            fallback: '/document/:tab_draft_done_#DocumentList', fallbackPath: '/document/draft',
          });
          assert.deepEqual(await prepared('/home#Home'), { parts: ['/home'], values: {}, queryNames: [], errors: [], path: '/home', fallback: null, fallbackPath: null });
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
          const prepared = (query: string) => fetch(`${base}/api/path-values?screen=${encodeURIComponent('/document/:id#DocumentDetail')}${query}`);
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
        const detail = (id: unknown) => preparedFor(config, { '/document/:id': { id } }, '/document/:id#DocumentDetail');
        const searched = await detail({ api: '/api/v1/documents/search', method: 'POST', body: { status: 'done' }, list: '', value: 'code' });
        assert.deepEqual([searched.values, searched.errors, searched.path], [{ id: 'done 1/2' }, [], '/document/done%201%2F2']);
        for (const [given, error] of [
          [{ ...LIST_API, api: '/api/v1/documents/empty' }, /^id: 목록 API GET \/api\/v1\/documents\/empty 가 빈 목록을 돌려주었습니다$/],
          [{ ...LIST_API, api: '/api/v1/documents/broken' }, /500 로 실패/],
          [{ ...LIST_API, api: '/api/v1/documents/text' }, /JSON 이 아닙니다/],
          [{ ...LIST_API, list: 'contents.items' }, /contents\.items 에 목록이 없습니다/],
          [{ ...LIST_API, value: 'uuid' }, /첫 항목에 uuid 값이 없습니다/],
        ] satisfies [object, RegExp][]) {
          const result = await detail(given);
          assert.deepEqual([result.values, result.path, result.fallback], [{}, null, '/home#Home'], given.api);
          assert.equal(result.errors.length, 1);
          assert.match(result.errors[0], error);
        }
        assert.deepEqual(await preparedFor(config, {}, '/document/:id#DocumentDetail'), {
          parts: ['/document', { name: 'id', prefix: '/', optional: false, pattern: null }], values: {}, queryNames: [], errors: [], path: null, fallback: '/home#Home', fallbackPath: '/home',
        });
        await withPassword('wrong', async () => {
          const result = await detail(LIST_API);
          assert.match(result.errors[0], /로그인하지 못해/);
        });
      }),
    ),
  );
});

test('an issuing API is called anew for every request, with its key and without the login token, and the key reaches no page data or message', async () => {
  const pathValues = { '/document/:id': { id: ISSUING_API } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ [PASSWORD_ENV]: 'wrong', [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, pathValues } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const prepared = async () => (await fetch(`${base}/api/path-values?screen=${encodeURIComponent('/document/:id#DocumentDetail')}`)).text();
          const first = JSON.parse(await prepared());
          assert.deepEqual([first.values, first.errors, first.path, first.issued], [{ id: 'c-1' }, [], '/document/c-1', ['id']]);
          assert.equal(JSON.parse(await prepared()).path, '/document/c-2');
          assert.equal(requests.filter((r) => r === 'POST /api/v2/one-time-code/create').length, 2);

          const texts = [JSON.stringify(first), await (await fetch(`${base}/api/data`)).text()];
          process.env[API_KEY_ENV] = 'wrong-key';
          const refused = await prepared();
          assert.match(JSON.parse(refused).errors[0], /^id: 발급 API POST \/api\/v2\/one-time-code\/create 요청이 403 로 실패했습니다$/);
          delete process.env[API_KEY_ENV];
          const missing = await prepared();
          assert.match(JSON.parse(missing).errors[0], new RegExp(`환경 변수 ${API_KEY_ENV} 에 키가 없어`));
          assert.equal(JSON.parse(missing).fallback, '/home#Home');
          for (const text of [...texts, refused, missing]) assert.ok(!text.includes(API_KEY) && !text.includes('wrong-key'), text);
        }),
      ),
    ),
  );
});

test('a query token is issued for the document id of the same address, a typed value is used in place of the configured one, and the key reaches nothing', async () => {
  const pathValues = { '/view/:documentId': { documentId: '01a1', '?token': VIEW_TOKEN_API }, '/home': { '?lang': 'ko' } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ [PASSWORD_ENV]: 'wrong', [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, pathValues } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const again = (body: string, type = 'application/json') => fetch(`${base}/api/path-values`, { method: 'POST', headers: { 'Content-Type': type }, body });
          const prepared = async (id: string, typed?: object) => (typed ? await again(JSON.stringify({ screen: id, typed })) : await fetch(`${base}/api/path-values?screen=${encodeURIComponent(id)}`)).text();
          const first = JSON.parse(await prepared(VIEW_SCREEN));
          assert.deepEqual([first.values, first.queryNames, first.errors, first.path, first.issued], [{ documentId: '01a1', '?token': 't-01a1-1' }, ['?token'], [], '/view/01a1?token=t-01a1-1', ['?token']]);
          const typed = JSON.parse(await prepared(VIEW_SCREEN, { documentId: 'typed7' }));
          assert.deepEqual([typed.values.documentId, typed.path], ['typed7', '/view/typed7?token=t-typed7-2']);
          const own = JSON.parse(await prepared(VIEW_SCREEN, { '?token': 'mine' }));
          assert.deepEqual([own.path, own.issued], ['/view/01a1?token=mine', undefined]);
          assert.equal(requests.filter((r) => r === 'POST /api/v1/view-token/create').length, 2);

          const home = JSON.parse(await prepared('/home#Home'));
          assert.deepEqual([home.parts, home.queryNames, home.path], [['/home'], ['?lang'], '/home?lang=ko']);
          const data = await (await fetch(`${base}/api/data`)).json();
          assert.equal(data.appLinks['/home#Home'], `${data.app.url}/home?lang=ko`);
          assert.equal(data.appLinks[VIEW_SCREEN], null);
          assert.deepEqual(data.app.unknownPathValues, []);

          for (const bad of ['nope', '[1]', JSON.stringify({ screen: VIEW_SCREEN }), JSON.stringify({ screen: VIEW_SCREEN, typed: { documentId: 7 } }), JSON.stringify({ screen: 7, typed: {} })]) {
            assert.equal((await again(bad)).status, 400, bad);
          }
          assert.equal((await again(JSON.stringify({ screen: VIEW_SCREEN, typed: { documentId: 'x' } }), 'text/plain')).status, 415);
          assert.equal((await fetch(`${base}/api/path-values?screen=${encodeURIComponent(VIEW_SCREEN)}&typed=${encodeURIComponent('{"documentId":"x"}')}`).then((r) => r.json())).values.documentId, '01a1');
          assert.equal((await again(JSON.stringify({ screen: '/gone#Gone', typed: {} }))).status, 404);
          process.env[API_KEY_ENV] = 'wrong-key';
          const refused = await prepared(VIEW_SCREEN, { documentId: 'typed7' });
          assert.deepEqual(JSON.parse(refused).errors, ['?token: 발급 API POST /api/v1/view-token/create 요청이 403 로 실패했습니다']);
          process.env[API_KEY_ENV] = API_KEY;
          const unsent = await prepared(VIEW_SCREEN, { documentId: '' });
          assert.deepEqual(JSON.parse(unsent).errors, ['?token: documentId 값이 없어 발급 API POST /api/v1/view-token/create 를 부르지 않았습니다']);
          assert.equal(requests.filter((r) => r === 'POST /api/v1/view-token/create').length, 4);
          for (const text of [JSON.stringify(first), JSON.stringify(typed), refused, unsent, JSON.stringify(data)]) assert.ok(!text.includes(API_KEY) && !text.includes('wrong-key'), text);
        }),
        [VIEW_ROUTE]),
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
            assert.match(served.headers.get('content-type')!, /javascript/);
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
          ] satisfies [unknown, RegExp][]) {
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
          const writeFile = (text: string) => fs.writeFileSync(path.join(copy, 'build/settings.js'), text);
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
          const server = await startReviewServer(config, { author: signer('reviewer') });
          let app;
          try {
            ({ app } = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/data`)).json());
          } finally {
            await new Promise((resolve) => server.close(resolve));
          }
          assert.equal(Boolean(app.signedOutUrl), signedOutPaths.length > 0);
          const refused = (err: { cause?: { code?: string } }) => err.cause?.code === 'ECONNREFUSED';
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
  ['a query key without a name', { pathValues: { '/document/:id': { id: '1', '?': 'x' } } }, /app\.pathValues\["\/document\/:id"\] has the key "\?" without a query parameter name/],
  ['a query value given a number', { pathValues: { '/document/:id': { '?token': 17 } } }, /app\.pathValues\["\/document\/:id"\]\.\?token must/],
  ['a query value that is a list API without its value', { login: loginWithHeader, pathValues: { '/document/:id': { '?token': { ...LIST_API, value: undefined } } } }, /app\.pathValues\["\/document\/:id"\]\.\?token must/],
  ['a query value that is an issuing API with the key itself in its header', { pathValues: { '/document/:id': { '?token': { ...ISSUING_API, header: { 'X-API-KEY': 's3cret' } } } } }, /app\.pathValues\["\/document\/:id"\]\.\?token must/],
  ...([
    ['without the value to take', { value: undefined }],
    ['whose address is not a path', { api: 'http://127.0.0.1:1/api/v1/documents' }],
    ['with a list that is not a dotted path', { list: 7 }],
    ['with a body but no method', { body: { status: 'draft' } }],
    ['with a key it does not know', { headers: {} }],
  ] satisfies [string, object][]).map(([name, change]): [string, object, RegExp] => [`a list API ${name}`, { login: loginWithHeader, pathValues: { '/document/:id': { id: { ...LIST_API, ...change } } } }, /app\.pathValues\["\/document\/:id"\]\.id must/]),
  ['a list API without login.header', { pathValues: { '/document/:id': { id: LIST_API } } }, /app\.login\.header/],
  ...([
    ['with the key itself in its header', { header: { 'X-API-KEY': 's3cret' } }],
    ['without a header', { header: undefined }],
    ['with a header that is not a map of names to text', { header: ['{key}'] }],
    ['without keyEnv', { keyEnv: undefined }],
    ['with a body but no method', { method: undefined }],
    ['whose address is not a path', { api: 'api/codes' }],
    ['with the key itself beside its header', { key: 's3cret' }],
  ] satisfies [string, object][]).map(([name, change]): [string, object, RegExp] => [`an issuing API ${name}`, { pathValues: { '/document/:id': { id: { ...ISSUING_API, ...change } } } }, /app\.pathValues\["\/document\/:id"\]\.id must/]),
  ['a login header that is not a map of header names', { login: { ...loginWithHeader, header: ['Bearer s3cret'] } }, /app\.login\.header/],
  ['a settingsFile without merged sections', { settingsFile: { ...SETTINGS_FILE, merged: [] } }, /app\.settingsFile must be/],
  ['a settingsFile path that is not absolute', { settingsFile: { ...SETTINGS_FILE, path: 'settings.js' } }, /app\.settingsFile must be/],
  ['a settingsFile global that is not a dotted name', { settingsFile: { ...SETTINGS_FILE, global: "window['FAKE_SETTINGS']" } }, /app\.settingsFile must be/],
  ['a settingsFile root that is not a settings root', { settingsFile: { ...SETTINGS_FILE, root: 'appSettings' } }, /app\.settingsFile\.root "appSettings" is not listed in settingsRoots/],
] satisfies [string, object, RegExp][]) {
  test(`app settings with ${name} are rejected`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
    try {
      const file = path.join(dir, 'config.json');
      const app = { ...appSettings('http://127.0.0.1:1').app, ...broken };
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), app }));
      assert.throws(() => loadConfig(file), (err: Error) => message.test(err.message) && !err.message.includes('s3cret'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('an issuing API is accepted without login.header, since it is called with its key and not the login token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    const app = { ...appSettings('http://127.0.0.1:1').app, pathValues: { '/document/:id': { id: ISSUING_API } } };
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), app }));
    assert.deepEqual(loadConfig(file).app.pathValues['/document/:id'].id, ISSUING_API);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a query value is accepted as a fixed value, a list API or an issuing API', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    const pathValues = { '/view/:documentId': { documentId: '1', '?lang': 'ko', '?mode': LIST_API, '?token': VIEW_TOKEN_API } };
    const app = { ...appSettings('http://127.0.0.1:1').app, login: loginWithHeader, pathValues };
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), app }));
    assert.deepEqual(loadConfig(file).app.pathValues, pathValues);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
