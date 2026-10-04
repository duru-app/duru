import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackScreen, fillPath, opensAsIs, pathParts, preparePathValues, unknownPathValues } from '../src/path-values.mjs';

const screen = (id, path, from = []) => ({ id, path, access: { links: from.map((f) => ({ from: f })) } });

test('a route path is split into text and its variables, with optional ones and their patterns', () => {
  assert.deepEqual(pathParts('/home'), ['/home']);
  assert.deepEqual(pathParts('/document/:id'), ['/document', { name: 'id', prefix: '/', optional: false, pattern: null }]);
  assert.deepEqual(pathParts('/document/:tab(draft|done)'), ['/document', { name: 'tab', prefix: '/', optional: false, pattern: 'draft|done' }]);
  assert.deepEqual(pathParts('/list/:tab(a|b)?/more'), ['/list', { name: 'tab', prefix: '/', optional: true, pattern: 'a|b' }, '/more']);
  assert.deepEqual(pathParts('/file/:name.:ext?'), ['/file', { name: 'name', prefix: '/', optional: false, pattern: null }, { name: 'ext', prefix: '.', optional: true, pattern: null }]);
  assert.deepEqual(pathParts('/doc-:id'), ['/doc-', { name: 'id', prefix: '', optional: false, pattern: null }]);
  assert.deepEqual(pathParts('/files/*'), ['/files', { name: '0', prefix: '/', optional: false, pattern: '.*' }]);
  assert.deepEqual(pathParts('/a\\:b'), ['/a:b']);
});

test('a path is filled with encoded values, and an optional variable without a value is left out with its slash', () => {
  assert.equal(fillPath('/document/:id', { id: '17' }), '/document/17');
  assert.equal(fillPath('/document/:tab(draft|done)', { tab: 'draft' }), '/document/draft');
  assert.equal(fillPath('/document/:tab?', {}), '/document');
  assert.equal(fillPath('/document/:tab?/edit', { tab: '' }), '/document/edit');
  assert.equal(fillPath('/list/:tab(a|b)?', { tab: 'b' }), '/list/b');
  assert.equal(fillPath('/list/:tab(a|b)?', {}), '/list');
  assert.equal(fillPath('/:tab?', {}), '/');
  assert.equal(fillPath('/search/:q', { q: 'a b/c?d' }), '/search/a%20b%2Fc%3Fd');
  assert.equal(fillPath('/document/:id', {}), null);
  assert.equal(fillPath('/home', {}), '/home');
});

test('the list screen to fall back to is the first screen linking in whose path has no variables', () => {
  const map = { screens: [
    screen('/home#Home', '/home'),
    screen('/document/:tab#List', '/document/:tab'),
    screen('/broken#Broken', '/x/{?}'),
    screen('/document/:id#Detail', '/document/:id', ['/document/:tab#List', '/broken#Broken', '/home#Home']),
    screen('/document/:id/edit#Edit', '/document/:id/edit', ['/document/:id#Detail']),
  ] };
  assert.equal(fallbackScreen(map, map.screens[3]).id, '/home#Home');
  assert.equal(fallbackScreen(map, map.screens[4]), null);
});

test('the fallback prefers a list screen the account opening the frame can open, and takes the first one when none can be', () => {
  const admin = (id, path) => ({ ...screen(id, path), access: { links: [], roleValues: ['ADMIN'] } });
  const map = { screens: [
    admin('/admin/docs#AdminDocs', '/admin/docs'),
    screen('/my/docs#MyDocs', '/my/docs'),
    { ...screen('/audit#Audit', '/audit'), access: { links: [], roleValues: null } },
    screen('/document/:id#Detail', '/document/:id', ['/admin/docs#AdminDocs', '/my/docs#MyDocs']),
    screen('/report/:id#Report', '/report/:id', ['/admin/docs#AdminDocs', '/audit#Audit']),
  ] };
  assert.equal(fallbackScreen(map, map.screens[3]).id, '/my/docs#MyDocs');
  assert.equal(fallbackScreen(map, map.screens[3], {}, 'ADMIN').id, '/admin/docs#AdminDocs');
  assert.equal(fallbackScreen(map, map.screens[3], {}, 'AUDITOR').id, '/my/docs#MyDocs');
  assert.equal(fallbackScreen(map, map.screens[4]).id, '/admin/docs#AdminDocs');
});

test('pathValues entries that match no screen path, and variables missing from their path, are listed', () => {
  const map = { screens: [screen('/home#Home', '/home'), screen('/document/:id#Detail', '/document/:id')] };
  assert.deepEqual(unknownPathValues(map, { '/document/:id': { id: '1', docId: '2' }, '/document/:no': { no: '3' } }), ['/document/:id 의 docId', '/document/:no']);
  assert.deepEqual(unknownPathValues(map, {}), []);
});

test('without a list screen to fall back to, a screen still gets its values and errors, and the fallback is null', async () => {
  const map = { screens: [screen('/document/:id#Detail', '/document/:id'), screen('/document/:id/edit#Edit', '/document/:id/edit', ['/document/:id#Detail'])] };
  const failing = async () => new Response('down', { status: 503 });
  const result = await preparePathValues(map, map.screens[1], { '/document/:id/edit': { id: { api: '/api/v1/documents', list: '', value: 'id' } } }, failing);
  assert.deepEqual(result.values, {});
  assert.equal(result.path, null);
  assert.equal(result.fallback, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /503/);
});

test('a list API that cannot be reached or does not answer in time says so', async () => {
  const map = { screens: [screen('/document/:id#Detail', '/document/:id')] };
  const given = { '/document/:id': { id: { api: '/api/v1/documents', list: '', value: 'id' } } };
  const unreachable = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  };
  const slow = async () => {
    throw new DOMException('timed out', 'TimeoutError');
  };
  assert.deepEqual((await preparePathValues(map, map.screens[0], given, unreachable)).errors, ['id: 목록 API GET /api/v1/documents 요청을 보내지 못했습니다 (ECONNREFUSED)']);
  assert.deepEqual((await preparePathValues(map, map.screens[0], given, slow)).errors, ['id: 목록 API GET /api/v1/documents 요청에 15초 안에 응답이 없었습니다']);
});

test('without the login, a list API is not called and the error says why', async () => {
  const map = { screens: [screen('/document/:id#Detail', '/document/:id')] };
  const result = await preparePathValues(map, map.screens[0], { '/document/:id': { id: { api: '/api/v1/documents', list: '', value: 'id' } } }, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /로그인/);
});

const KEY_ENV = 'DURU_TEST_PATH_VALUES_KEY';
const ISSUING = { api: '/api/codes', method: 'POST', header: { 'X-API-KEY': '{key}', Accept: 'application/json' }, keyEnv: KEY_ENV, body: { memberId: 'm1' }, value: 'contents.code' };

async function issued(fetchServer, spec = ISSUING, key = 'k3y') {
  const map = { screens: [screen('/home#Home', '/home'), screen('/view/:code/:id#View', '/view/:code/:id', ['/home#Home'])] };
  if (key === null) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = key;
  try {
    return await preparePathValues(map, map.screens[1], { '/view/:code/:id': { code: spec, id: '7' } }, null, null, fetchServer);
  } finally {
    delete process.env[KEY_ENV];
  }
}

test('an issuing API is called without the login, with the key from its environment variable in its header, every time', async () => {
  const calls = [];
  const fetchServer = async (api, options) => {
    calls.push([api, options.method, options.headers, options.body]);
    return new Response(JSON.stringify({ contents: { code: `c${calls.length}` } }));
  };
  const first = await issued(fetchServer);
  assert.deepEqual([first.values, first.errors, first.path, first.issued], [{ code: 'c1', id: '7' }, [], '/view/c1/7', ['code']]);
  assert.equal((await issued(fetchServer)).path, '/view/c2/7');
  assert.deepEqual(calls[0], ['/api/codes', 'POST', { 'X-API-KEY': 'k3y', Accept: 'application/json' }, { memberId: 'm1' }]);
  assert.equal((await issued(fetchServer, { ...ISSUING, header: { 'X-API-KEY': 'Key {key}$&' } }, '$1')).errors.length, 0);
  assert.equal(calls[2][2]['X-API-KEY'], 'Key $1$&');
});

test('an issuing API whose key, request or reply fails says why without the key, and the screen falls back', async () => {
  const answering = (body, status = 200) => async () => new Response(body, { status });
  const throwing = (err) => async () => {
    throw err;
  };
  for (const [fetchServer, error, key] of [
    [answering('{}'), /^code: 환경 변수 DURU_TEST_PATH_VALUES_KEY 에 키가 없어 발급 API POST \/api\/codes 를 부르지 않았습니다$/, null],
    [answering('{}', 403), /^code: 발급 API POST \/api\/codes 요청이 403 로 실패했습니다$/],
    [answering('not json'), /^code: 발급 API POST \/api\/codes 의 응답이 JSON 이 아닙니다$/],
    [answering('{ "contents": {} }'), /^code: 발급 API POST \/api\/codes 응답의 contents\.code 에 값이 없습니다$/],
    [throwing(new DOMException('timed out', 'TimeoutError')), /^code: 발급 API POST \/api\/codes 요청에 15초 안에 응답이 없었습니다$/],
    [throwing(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })), /요청을 보내지 못했습니다 \(ECONNREFUSED\)$/],
    [answering('{}'), /^code: 환경 변수 DURU_TEST_PATH_VALUES_KEY 의 키를 header 에 넣을 수 없습니다$/, 'k3y\nsecret'],
  ]) {
    const result = await issued(fetchServer, ISSUING, key);
    assert.deepEqual([result.values, result.path, result.fallback], [{ id: '7' }, null, '/home#Home']);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], error);
  }
  const bare = await issued(async () => new Response('"c9"'), { ...ISSUING, value: '' });
  assert.deepEqual(bare.values, { code: 'c9', id: '7' });
  assert.match((await issued(async () => new Response('{}'), { ...ISSUING, value: '' })).errors[0], /의 응답이 값 하나가 아닙니다$/);
});

test('a list screen whose variables all have fixed values is a fallback too, opened with those values', async () => {
  const map = { screens: [
    screen('/home#Home', '/home'),
    screen('/document/:tab#List', '/document/:tab'),
    screen('/document/:id#Detail', '/document/:id', ['/document/:tab#List', '/home#Home']),
  ] };
  const pathValues = { '/document/:tab': { tab: 'draft' }, '/document/:id': { id: { api: '/api/v1/documents', list: '', value: 'id' } } };
  const result = await preparePathValues(map, map.screens[2], pathValues, async () => new Response('[]'));
  assert.equal(result.fallback, '/document/:tab#List');
  assert.equal(result.fallbackPath, '/document/draft');
  assert.equal(fallbackScreen(map, map.screens[2], {}).id, '/home#Home');
});

test('a wildcard or repeated variable keeps the slashes of its value', () => {
  assert.equal(fillPath('/files/*', { 0: 'a/b c' }), '/files/a/b%20c');
  assert.equal(fillPath('/docs/:path+', { path: 'a/b' }), '/docs/a/b');
  assert.equal(fillPath('/docs/:path', { path: 'a/b' }), '/docs/a%2Fb');
});

test('a path with an unnamed group needs a value like any other variable', () => {
  assert.equal(opensAsIs('/report/(daily|weekly)'), false);
  assert.equal(opensAsIs('/a\\:b'), true);
});

test('a list API answering with bare values takes the first one itself', async () => {
  const map = { screens: [screen('/document/:id#Detail', '/document/:id')] };
  const result = await preparePathValues(map, map.screens[0], { '/document/:id': { id: { api: '/api/ids', list: '', value: '' } } }, async () => new Response('[17, 18]'));
  assert.deepEqual(result.values, { id: '17' });
});
