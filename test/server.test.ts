import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchEndpoint, toSegments } from '../src/server.ts';

const endpoint = (label: string, method: string, path: string) => ({ label, method, path, segments: toSegments(path) });
const SERVER = [endpoint('one', 'GET', '/v1/area/{areaId}/thing/{thingId}'), endpoint('list', 'GET', '/v1/area/{areaId}/thing/list')];

test('a call whose last segment is written text with an unknown glued to it matches the endpoint whose segment that text fits, before one with a variable there', () => {
  assert.deepEqual(matchEndpoint(SERVER, 'GET', '/v1/area/{?}/thing/list{?}', ''), { status: 'match', labels: ['list'], path: '/v1/area/{areaId}/thing/list' });
});

test('a segment with an unknown glued to written text matches a variable when no written segment fits the text, and nothing when the only one there is a written segment the text does not fit', () => {
  assert.deepEqual(matchEndpoint(SERVER, 'GET', '/v1/area/{?}/thing/item{?}', ''), { status: 'match', labels: ['one'], path: '/v1/area/{areaId}/thing/{thingId}' });
  assert.deepEqual(matchEndpoint([endpoint('detail', 'GET', '/v1/area/{areaId}/thing/detail')], 'GET', '/v1/area/{?}/thing/list{?}', ''), { status: 'none' });
});
