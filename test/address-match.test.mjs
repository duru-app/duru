import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenFinder } from '../src/address-match.mjs';

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
