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
