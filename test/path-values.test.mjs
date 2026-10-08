import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asIsPath, fallbackScreen, fillPath, opensAsIs, pathParts, preparePathValues, unknownPathValues } from '../src/path-values.ts';

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

const VIEW_TOKEN = { api: '/api/v1/view-token/create', method: 'POST', header: { 'X-API-KEY': '{key}' }, keyEnv: KEY_ENV, body: { referenceType: 'DOCUMENT', referenceId: '{documentId}' }, value: 'contents.accessToken' };
const viewMap = { screens: [screen('/home#Home', '/home'), screen('/view/:documentId#View', '/view/:documentId', ['/home#Home'])] };

// 요청 본문의 referenceId 로 토큰을 만들어, 어느 문서 번호가 요청에 실렸는지 알 수 있게 한다.
function tokenServer(calls = []) {
  return async (api, options) => {
    calls.push([api, options.body]);
    return new Response(JSON.stringify({ contents: { accessToken: `t-${options.body.referenceId}` } }));
  };
}

async function viewing(pathValues, fetchServer, typed, { fetchApi = null, key = 'k3y' } = {}) {
  process.env[KEY_ENV] = key;
  try {
    return await preparePathValues(viewMap, viewMap.screens[1], { '/view/:documentId': pathValues }, fetchApi, null, fetchServer, typed);
  } finally {
    delete process.env[KEY_ENV];
  }
}

test('a query value is issued with the path variable it names in its request body, and ends the path as an encoded query string', async () => {
  const calls = [];
  const result = await viewing({ documentId: 'doc 1', '?token': VIEW_TOKEN }, tokenServer(calls));
  assert.deepEqual(calls, [['/api/v1/view-token/create', { referenceType: 'DOCUMENT', referenceId: 'doc 1' }]]);
  assert.deepEqual([result.values, result.queryNames, result.errors, result.issued], [{ documentId: 'doc 1', '?token': 't-doc 1' }, ['?token'], [], ['?token']]);
  assert.equal(result.path, '/view/doc%201?token=t-doc%201');
  const encoded = await viewing({ documentId: '7', '?a b': 'x&y=z', '?token': VIEW_TOKEN }, tokenServer());
  assert.equal(encoded.path, '/view/7?a%20b=x%26y%3Dz&token=t-7');
});

test('a query value may be fixed or come from a list API, and the order of the configuration is kept', async () => {
  const list = { api: '/api/v1/modes', list: 'contents', value: 'code' };
  const fetchApi = async () => new Response(JSON.stringify({ contents: [{ code: 'edit' }] }));
  const result = await viewing({ '?mode': list, documentId: '7', '?lang': 'ko' }, tokenServer(), undefined, { fetchApi });
  assert.deepEqual([result.queryNames, result.path, result.issued], [['?mode', '?lang'], '/view/7?mode=edit&lang=ko', undefined]);
});

test('variables resolve in two waves, so a body may name only a variable that did not need another one', async () => {
  const order = [];
  const fetchServer = async (api, options) => {
    order.push(api);
    return new Response(JSON.stringify({ id: `id-${options.body.seed ?? 'x'}`, contents: { accessToken: `t-${options.body.referenceId}` } }));
  };
  const issuedId = { ...VIEW_TOKEN, api: '/api/ids', body: { seed: '1' }, value: 'id' };
  const result = await viewing({ documentId: issuedId, '?token': VIEW_TOKEN }, fetchServer);
  assert.deepEqual(order, ['/api/ids', '/api/v1/view-token/create']);
  assert.deepEqual([result.errors, result.path, result.issued], [[], '/view/id-1?token=t-id-1', ['documentId', '?token']]);
  const chained = await viewing({ documentId: VIEW_TOKEN, '?token': { ...VIEW_TOKEN, body: { referenceId: '{documentId}' } } }, tokenServer());
  assert.deepEqual(chained.errors.map((e) => e.replace(/ 발급.*/, '')), ['documentId: documentId 값이 없어', '?token: documentId 값이 없어']);
});

test('an issuing request whose body needs a variable without a value is not sent, and the error names the variable but not the key; a list API sends its body as written', async () => {
  for (const [pathValues, error] of [
    [{ '?token': VIEW_TOKEN }, '?token: documentId 값이 없어 발급 API POST /api/v1/view-token/create 를 부르지 않았습니다'],
    [{ documentId: { api: '/api/ids', list: '', value: 'id' }, '?token': VIEW_TOKEN }, null],
  ]) {
    const calls = [];
    const result = await viewing(pathValues, tokenServer(calls), undefined, { fetchApi: async () => new Response('{}', { status: 500 }) });
    assert.deepEqual([calls, result.path, result.fallback], [[], null, '/home#Home']);
    assert.equal(result.errors.at(-1).startsWith('?token: documentId 값이 없어 '), true);
    assert.equal(result.errors.every((e) => !e.includes('k3y')), true);
    if (error) assert.deepEqual(result.errors, [error]);
  }
  const listed = { api: '/api/v1/tokens', method: 'POST', list: 'contents', value: 'code', body: { id: '{documentId}' } };
  const sent = [];
  const fetchApi = async (api, options) => { sent.push(options.body); return new Response(JSON.stringify({ contents: [{ code: 'c' }] })); };
  const result = await viewing({ documentId: '7', '?token': listed }, tokenServer(), undefined, { fetchApi });
  assert.deepEqual([sent, result.path, result.errors], [[{ id: '{documentId}' }], '/view/7?token=c', []]);
});

test('the path variables named in the body of an issuing API fill every string of the body at any depth, and braces that name no path variable stay as written', async () => {
  const calls = [];
  const body = { a: '{documentId}-{other}', query: 'mutation{createToken(doc:"{documentId}"){token}}', list: ['{documentId}', { deep: 'x{documentId}y{documentId}' }], n: 3, flag: true, nothing: null };
  const result = await viewing({ documentId: '7$&', '?token': { ...VIEW_TOKEN, body } }, tokenServer(calls));
  assert.deepEqual(calls[0][1], { a: '7$&-{other}', query: 'mutation{createToken(doc:"7$&"){token}}', list: ['7$&', { deep: 'x7$&y7$&' }], n: 3, flag: true, nothing: null });
  assert.equal(result.errors.length, 0);
});

test('a value typed by the reviewer is used instead of the configured one, and an issued value typed over is not requested', async () => {
  const calls = [];
  const typedId = await viewing({ documentId: '7', '?token': VIEW_TOKEN }, tokenServer(calls), { documentId: 'typed-9' });
  assert.deepEqual([calls.length, calls[0][1].referenceId, typedId.values.documentId, typedId.path], [1, 'typed-9', 'typed-9', '/view/typed-9?token=t-typed-9']);
  const listCalls = [];
  const fetchApi = async () => { listCalls.push('list'); return new Response('[]'); };
  const overList = await viewing({ documentId: { api: '/api/ids', list: '', value: 'id' }, '?token': VIEW_TOKEN }, tokenServer(), { documentId: 'typed-9' }, { fetchApi });
  assert.deepEqual([listCalls, overList.errors, overList.issued], [[], [], ['?token']]);
  const none = [];
  const overToken = await viewing({ documentId: '7', '?token': VIEW_TOKEN }, tokenServer(none), { '?token': 'mine' });
  assert.deepEqual([none, overToken.path, overToken.issued], [[], '/view/7?token=mine', undefined]);
  const cleared = await viewing({ documentId: '7', '?token': VIEW_TOKEN }, tokenServer(), { '?token': '' });
  assert.deepEqual([cleared.path, cleared.errors], [null, []]);
});

test('a query value that cannot be obtained leaves no path, like a missing path variable', async () => {
  const result = await viewing({ documentId: '7', '?token': VIEW_TOKEN }, async () => new Response('{}', { status: 403 }));
  assert.deepEqual([result.path, result.values, result.fallback], [null, { documentId: '7' }, '/home#Home']);
  assert.deepEqual(result.errors, ['?token: 발급 API POST /api/v1/view-token/create 요청이 403 로 실패했습니다']);
});

test('a screen with only fixed query values opens as is with them, one with an issued query value does not, and a fallback screen needing an unissued query value is skipped', async () => {
  assert.equal(opensAsIs('/status'), true);
  assert.equal(opensAsIs('/status', { '?lang': 'ko' }), true);
  assert.equal(asIsPath('/status', { '?lang': 'ko', '?a b': 'x&y' }), '/status?lang=ko&a%20b=x%26y');
  assert.equal(opensAsIs('/status', { '?lang': 'ko', '?token': VIEW_TOKEN }), false);
  assert.equal(opensAsIs('/status', { '?lang': '' }), false);
  const map = { screens: [screen('/home#Home', '/home'), screen('/status#Status', '/status', ['/home#Home'])] };
  const fixed = await preparePathValues(map, map.screens[1], { '/status': { '?lang': 'ko' } }, null);
  assert.deepEqual([fixed.parts, fixed.path, fixed.queryNames, fixed.fallback], [['/status'], '/status?lang=ko', ['?lang'], null]);
  const issued = await preparePathValues(map, map.screens[1], { '/status': { '?token': VIEW_TOKEN } }, null);
  assert.equal(issued.fallback, '/home#Home');
  const linking = { screens: [screen('/a#A', '/a', ['/b#B']), screen('/b#B', '/b'), screen('/c#C', '/c', ['/b#B', '/a#A'])] };
  assert.deepEqual(fallbackScreen(linking, linking.screens[2], { '/b': { '?lang': 'ko' } }), { id: '/b#B', path: '/b?lang=ko' });
  assert.equal(fallbackScreen(linking, linking.screens[2], { '/b': { '?t': VIEW_TOKEN }, '/a': { '?t': VIEW_TOKEN } }), null);
});

test('a query key is not an unknown variable, but a route path missing from the map still is', () => {
  const map = { screens: [screen('/view/:documentId#View', '/view/:documentId')] };
  assert.deepEqual(unknownPathValues(map, { '/view/:documentId': { documentId: '7', '?token': 'x' }, '/gone': { '?token': 'x' } }), ['/gone']);
  assert.deepEqual(unknownPathValues(map, { '/view/:documentId': { id: '7' } }), ['/view/:documentId 의 id']);
});
