import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addRequestOptions, bodyOptions, optionBody, traceSent } from '../src/request-options.ts';
import type { RequestSent } from '../src/request-options.ts';

type Sent = { method?: string; url: string; body: string };

function storedZip(files: Record<string, string>) {
  const bodies: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    bodies.push(local, nameBytes, data);
    directory.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, ...directory, end]);
}

function withTrace<T>(requests: Sent[], fn: (trace: string) => T) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-options-'));
  try {
    const file = path.join(dir, 'trace.zip');
    const line = (e: object) => `${JSON.stringify(e)}\n`;
    fs.writeFileSync(file, storedZip({
      '0-trace.trace': line({ type: 'context-options', version: 8 }),
      '0-trace.network': requests.map(({ method = 'POST', url, body }, i) => line({
        type: 'resource-snapshot',
        snapshot: { _monotonicTime: i + 1, request: { method, url: `http://x${url}`, headers: [], postData: { text: body, mimeType: 'application/json' } }, response: { status: 200, content: { mimeType: 'application/json' } } },
      })).join(''),
    }));
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type Option = { key: string; values: boolean[]; sources: string[]; sites: { screen: string; file: string; line: number }[]; requests?: RequestSent[] };

const mapOf = () => ({
  screens: [],
  apiFunctions: { send: { endpoints: [{ callId: 'POST:/api/v1/report', method: 'POST', url: '/api/v1/report' }] } },
  calls: [{ id: 'POST:/api/v1/report', method: 'POST', path: '/api/v1/report', server: {}, apiFunctions: [], screens: [], options: [] as Option[] }],
});
const sentOf = (trace: string, title: string, project: string | null, line = 1) => traceSent({ trace, title, file: 'test/report.spec.ts', line, project })!;
const optionsOf = (map: ReturnType<typeof mapOf>) => map.calls.find((c) => c.id === 'POST:/api/v1/report')!.options;

test('optionBody keeps only the true and false values of a body and the names leading to them, so bodyOptions reads the same options from it', () => {
  const bodies = [
    '{"password":"s3cret","notify":true,"count":3,"signers":[{"name":"x","required":false},{"name":"y","required":true},"z"],"empty":{},"deep":{"a":{"b":[true,false]}}}',
    '[{"on":true},{"on":"x"}]',
    '{"watermark":false}',
  ];
  for (const body of bodies) assert.deepEqual(bodyOptions(optionBody(body)!), bodyOptions(body), body);
  assert.equal(optionBody(bodies[0]), '{"notify":true,"signers":[{"required":false},{"required":true}],"deep":{"a":{"b":[true,false]}}}');
  for (const none of ['{"password":"s3cret"}', 'true', '"x"', 'not json', '{}']) assert.equal(optionBody(none), undefined, none);
  assert.equal(optionBody(`${'['.repeat(100000)}true${']'.repeat(100000)}`), undefined, 'a body nested past the stack is dropped, not thrown');
});

test('a boolean field of a request body is an option named by where it sits, and a field of another type is not', () => {
  assert.deepEqual(bodyOptions('{"notify":true,"count":3,"note":"x","empty":{}}'), [{ key: 'notify', value: true }]);
  assert.deepEqual(bodyOptions('{"signers":[{"notify":false,"name":"x"}]}'), [{ key: 'signers[].notify', value: false }]);
  assert.deepEqual(bodyOptions('{"list":[true,false]}'), [
    { key: 'list[]', value: true },
    { key: 'list[]', value: false },
  ]);
  assert.deepEqual(bodyOptions('{"grid":[[true]]}'), [{ key: 'grid[][]', value: true }]);
  assert.deepEqual(bodyOptions('{"a":{"b":true},"z":false}'), [
    { key: 'a.b', value: true },
    { key: 'z', value: false },
  ]);
});

test('a body that is not JSON, or none at all, gives no option', () => {
  assert.deepEqual(bodyOptions('not json'), []);
  assert.deepEqual(bodyOptions('"just a string"'), []);
  assert.deepEqual(bodyOptions('null'), []);
});

test('two requests to the same call merge into one option that keeps both values', () => {
  withTrace([
    { url: '/api/v1/report', body: '{"notify":true}' },
    { url: '/api/v1/report', body: '{"notify":false}' },
  ], (trace) => {
    const map = mapOf();
    assert.deepEqual(addRequestOptions(map, [sentOf(trace, 'exports the report', 'chromium')]), { options: 1, calls: 1 });
    assert.deepEqual(optionsOf(map), [{ key: 'notify', values: [true, false], sources: ['request'], sites: [], requests: [{ test: 'exports the report', file: 'test/report.spec.ts', line: 1, project: 'chromium', values: [true, false] }] }]);
  });
});

test('a write request whose method the browser kept in lower case still gives its body options to the call', () => {
  withTrace([{ method: 'patch', url: '/api/v1/report', body: '{"notify":true}' }], (trace) => {
    const map = {
      screens: [],
      apiFunctions: { send: { endpoints: [{ callId: 'PATCH:/api/v1/report', method: 'PATCH', url: '/api/v1/report' }] } },
      calls: [{ id: 'PATCH:/api/v1/report', method: 'PATCH', path: '/api/v1/report', server: {}, apiFunctions: [], screens: [], options: [] as Option[] }],
    };
    assert.deepEqual(addRequestOptions(map, [sentOf(trace, 'exports the report', 'chromium')]), { options: 1, calls: 1 });
    assert.deepEqual(map.calls[0].options, [{ key: 'notify', values: [true, false], sources: ['request'], sites: [], requests: [{ test: 'exports the report', file: 'test/report.spec.ts', line: 1, project: 'chromium', values: [true] }] }]);
  });
});

test('each request option names the tests and the values they sent, sorted by file, line, test and project', () => {
  withTrace([{ url: '/api/v1/report', body: '{"notify":true}' }], (chromium) =>
    withTrace([{ url: '/api/v1/report', body: '{"notify":false}' }], (webkit) => {
      const map = mapOf();
      addRequestOptions(map, [sentOf(webkit, 'publishes a document', 'webkit', 12), sentOf(chromium, 'publishes a document', 'chromium', 12)]);
      assert.deepEqual(optionsOf(map)[0].requests, [
        { test: 'publishes a document', file: 'test/report.spec.ts', line: 12, project: 'chromium', values: [true] },
        { test: 'publishes a document', file: 'test/report.spec.ts', line: 12, project: 'webkit', values: [false] },
      ]);
    }));
});

test('a request to a call the map does not name, and a request without a JSON body, add no option', () => {
  withTrace([
    { url: '/api/v1/elsewhere', body: '{"notify":true}' },
    { url: '/api/v1/report', body: 'not json' },
    { method: 'GET', url: '/api/v1/report', body: '{"notify":true}' },
  ], (trace) => {
    const map = mapOf();
    assert.deepEqual(addRequestOptions(map, [sentOf(trace, 'opens the report', 'chromium')]), { options: 0, calls: 0 });
    assert.deepEqual(optionsOf(map), []);
  });
});

test('two merges of the same traces give the same options in the same order', () => {
  withTrace([
    { url: '/api/v1/report', body: '{"withHistory":true,"format":"pdf"}' },
    { url: '/api/v1/report', body: '{"watermark":false}' },
  ], (trace) => {
    const [first, second] = [mapOf(), mapOf()];
    const sent = [sentOf(trace, 'exports the report', 'chromium')];
    addRequestOptions(first, sent);
    addRequestOptions(second, sent);
    assert.deepEqual(optionsOf(first), optionsOf(second));
    assert.deepEqual(optionsOf(first).map((o) => o.key), ['watermark', 'withHistory']);
  });
});

test('a field bodyTypeExclusions leaves out of a call is not taken from a request body either', () => {
  withTrace([{ url: '/api/v1/report', body: '{"enabledInvite":true,"notify":false}' }], (trace) => {
    const map = { ...mapOf(), leftOutBodyTypeFields: [{ call: 'POST:/api/v1/report', field: 'enabledInvite' }] };
    assert.deepEqual(addRequestOptions(map, [sentOf(trace, 'invites a member', 'chromium')]), { options: 1, calls: 1 });
    assert.deepEqual(optionsOf(map), [{ key: 'notify', values: [true, false], sources: ['request'], sites: [], requests: [{ test: 'invites a member', file: 'test/report.spec.ts', line: 1, project: 'chromium', values: [false] }] }]);
  });
});

test('a field bodyTypeExclusions names but the source keeps as an option still takes the requests that sent it', () => {
  withTrace([{ url: '/api/v1/report', body: '{"enabledInvite":true}' }], (trace) => {
    const map = { ...mapOf(), keptBodyTypeExclusions: [{ call: 'POST:/api/v1/report', field: 'enabledInvite', keptBy: ['source'] }], leftOutBodyTypeFields: [] };
    map.calls[0].options.push({ key: 'enabledInvite', values: [true, false], sources: ['source'], sites: [] });
    assert.deepEqual(addRequestOptions(map, [sentOf(trace, 'invites a member', 'chromium')]), { options: 1, calls: 1 });
    assert.deepEqual(optionsOf(map), [{ key: 'enabledInvite', values: [true, false], sources: ['source', 'request'], sites: [], requests: [{ test: 'invites a member', file: 'test/report.spec.ts', line: 1, project: 'chromium', values: [true] }] }]);
  });
});
