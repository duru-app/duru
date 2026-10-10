import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callFinder, screenFinder } from '../src/address-match.ts';

const map = {
  screens: [
    { id: 'home', path: '/home' },
    { id: 'list', path: '/document/:tab(draft|done)' },
    { id: 'detail', path: '/document/:id' },
    { id: 'unread', path: '/{?}/settings' },
  ],
};
const screenAt = screenFinder(map);

test('an address finds its screen without its query and hash, with or without the server in front', () => {
  assert.equal(screenAt('http://127.0.0.1:4598/home?tab=recent#top'), 'home');
  assert.equal(screenAt('/home?tab=recent'), 'home');
  assert.equal(screenAt('/home#top'), 'home');
});

test('a value in the address finds the screen of its route, and the first route that fits wins', () => {
  assert.equal(screenAt('http://127.0.0.1:4598/document/42?mode=edit'), 'detail');
  assert.equal(screenAt('/document/draft'), 'list');
});

test('one slash at the end and the letter case do not matter', () => {
  assert.equal(screenAt('/Home/'), 'home');
});

test('an address that fits no route, one that cannot be read and a screen whose path was not read find nothing', () => {
  assert.equal(screenAt('/nowhere'), null);
  assert.equal(screenAt('/home/more'), null);
  assert.equal(screenAt('http://['), null);
  assert.equal(screenAt('/x/settings'), null);
});

const endpoint = (callId: string | null, method: string | null, url: string | null) => ({ callId, method, url });
const calls = {
  apiFunctions: {
    documentList: { endpoints: [endpoint('GET:/api/v1/document/list', 'GET', '/api/v1/document/list')] },
    documentDetail: { endpoints: [endpoint('GET:/api/v1/document/{documentId}', 'GET', '/api/v1/document/{0}')] },
    documentRename: { endpoints: [endpoint('PUT:/api/v1/document/{0}/name', 'PUT', '/api/v1/document/{0}/name')] },
    search: { endpoints: [endpoint('GET:/api/v1/search?word={0}', 'GET', '/api/v1/search?word={0}')] },
    ping: { endpoints: [endpoint('{?}:/api/v1/ping', null, '/api/v1/ping')] },
    download: { endpoints: [endpoint(null, 'GET', null)] },
  },
};
const callAt = callFinder(calls);

test('a request finds the call with its method and path, whatever value fills a variable and whatever query follows', () => {
  assert.equal(callAt('GET', 'http://127.0.0.1:4598/api/v1/document/42'), 'GET:/api/v1/document/{documentId}');
  assert.equal(callAt('PUT', '/api/v1/document/42/name?force=true'), 'PUT:/api/v1/document/{0}/name');
  assert.equal(callAt('GET', 'http://127.0.0.1:4598/api/v1/search?word=draft#first'), 'GET:/api/v1/search?word={0}');
});

test('a request that fits several calls finds the one with the fewest variables', () => {
  assert.equal(callAt('GET', '/api/v1/document/list'), 'GET:/api/v1/document/list');
});

test('a request with another method, with a path of another length, to a path no call has or with an address that cannot be read finds nothing', () => {
  assert.equal(callAt('POST', '/api/v1/document/42/name'), null);
  assert.equal(callAt('GET', '/api/v1/document/42/name/more'), null);
  assert.equal(callAt('GET', '/api/v1/document'), null);
  assert.equal(callAt('GET', '/app.js'), null);
  assert.equal(callAt('GET', '/api/v1/ping'), null);
  assert.equal(callAt('GET', 'http://['), null);
});

test('a request is matched to the address the client code sends, not to the call ID, which leaves the API path prefix out', () => {
  const under = callFinder({
    apiFunctions: {
      detail: { endpoints: [endpoint('GET:/document/{documentId}', 'GET', '/api/v1/document/{0}')] },
      token: { endpoints: [endpoint('POST:/oauth/token', 'POST', '/oauth/token')] },
    },
  });
  assert.equal(under('GET', 'http://127.0.0.1:4598/api/v1/document/42'), 'GET:/document/{documentId}');
  assert.equal(under('GET', 'http://127.0.0.1:4598/document/42'), null);
  assert.equal(under('POST', '/oauth/token'), 'POST:/oauth/token');
  assert.equal(under('POST', '/api/v1/oauth/token'), null);
});

test('a map without API functions finds nothing', () => {
  assert.equal(callFinder({})('GET', '/api/v1/document/42'), null);
});
