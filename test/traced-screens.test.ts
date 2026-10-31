import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareMaps } from '../src/baseline.ts';
import { readTrace } from '../src/playwright-trace.ts';
import { addTracedScreens } from '../src/traced-screens.ts';
import { traceSent } from '../src/request-options.ts';

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

const PAGE = 'page@1';
type Visit = { goto: string; at: number };
type Sent = { method?: string; url: string; at: number; api?: true };

function traceFile(dir: string, name: string, visits: Visit[], requests: Sent[]) {
  const file = path.join(dir, `${name}.zip`);
  const line = (e: object) => `${JSON.stringify(e)}\n`;
  const events = visits.flatMap(({ goto, at }, i) => [
    { type: 'before', callId: `call@${i}`, pageId: PAGE, method: 'goto', startTime: at, params: { url: `http://x${goto}` } },
    { type: 'after', callId: `call@${i}`, endTime: at + 1 },
    { type: 'frame-snapshot', snapshot: { snapshotName: `after@call@${i}`, isMainFrame: true, frameUrl: `http://x${goto}`, timestamp: at + 1 } },
  ]);
  fs.writeFileSync(file, storedZip({
    '0-trace.trace': [{ type: 'context-options', version: 8 }, ...events].map(line).join(''),
    '0-trace.network': requests.map(({ method = 'POST', url, at, api }) => line({
      type: 'resource-snapshot',
      snapshot: {
        _monotonicTime: at,
        ...(api ? { _apiRequest: true } : { pageref: PAGE }),
        request: { method, url: `http://x${url}`, headers: [] },
        response: { status: 200, content: { mimeType: 'application/json' } },
      },
    })).join(''),
  }));
  return file;
}

function inTempDir<T>(fn: (dir: string) => T) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-traced-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const screen = (id: string, p: string) => ({ id, path: p, component: id, apiCalls: [], access: { restricted: false, kinds: [], route: [], links: [] } });
const call = (id: string, method: string, url: string, screens: string[] = []) => ({ id, method, path: url, server: { status: 'match' }, apiFunctions: ['send'], screens, options: [] });

function mapOf(screensOfX: string[] = [], appStart: string[] = []) {
  return {
    screens: [screen('/a#A', '/a'), screen('/b#B', '/b')],
    apiFunctions: { send: { endpoints: [
      { callId: 'POST:/api/x', method: 'POST', url: '/api/x' },
      { callId: 'POST:/api/y', method: 'POST', url: '/api/y' },
      { callId: 'GET:/api/me', method: 'GET', url: '/api/me' },
    ] } },
    calls: [call('POST:/api/x', 'POST', '/api/x', screensOfX), call('POST:/api/y', 'POST', '/api/y'), call('GET:/api/me', 'GET', '/api/me')] as any[],
    ...(appStart.length && { appWide: { components: [], apiCalls: [{ fn: 'me', file: 'src/app.ts', line: 1, endpoints: appStart.map((callId) => ({ callId, method: 'GET', url: '/api/me' })) }] } }),
  };
}

const sentOf = (trace: string, title: string, line = 1) => traceSent({ trace, title, file: 'test/flow.spec.ts', line, project: 'chromium' })!;
const tracedOf = (map: ReturnType<typeof mapOf>) => Object.fromEntries(map.calls.filter((c) => c.tracedScreens).map((c) => [c.id, c.tracedScreens.map((t: any) => `${t.screen} ← ${t.tests.map((x: any) => x.test).join(', ')}`)]));

test('a request is tied to the screen the page showed when it was sent, and a request after moving to another screen to that one', () =>
  inTempDir((dir) => {
    const map = mapOf();
    const trace = traceFile(dir, 'a-then-b', [{ goto: '/a', at: 1 }, { goto: '/b', at: 10 }], [{ url: '/api/x', at: 5 }, { url: '/api/y', at: 12 }]);
    assert.deepEqual(addTracedScreens(map, [sentOf(trace, 'moves from a to b')]), { calls: 2, screens: 2 });
    assert.deepEqual(tracedOf(map), { 'POST:/api/x': ['/a#A ← moves from a to b'], 'POST:/api/y': ['/b#B ← moves from a to b'] });
    assert.deepEqual(map.calls[0].tracedScreens[0].tests, [{ test: 'moves from a to b', file: 'test/flow.spec.ts', line: 1, project: 'chromium' }]);
  }));

test('a call the source already ties to that screen gets no traced screen, and nor does a call sent at app start', () =>
  inTempDir((dir) => {
    const map = mapOf(['/a#A'], ['GET:/api/me']);
    const trace = traceFile(dir, 'a', [{ goto: '/a', at: 1 }], [{ url: '/api/x', at: 5 }, { method: 'GET', url: '/api/me', at: 6 }]);
    assert.deepEqual(addTracedScreens(map, [sentOf(trace, 'opens a')]), { calls: 0, screens: 0 });
    assert.deepEqual(tracedOf(map), {});
  }));

test('a request the test sent itself, or sent before any page showed the app, is tied to no screen', () =>
  inTempDir((dir) => {
    const map = mapOf();
    const trace = traceFile(dir, 'setup', [{ goto: '/a', at: 10 }], [{ url: '/api/y', at: 2 }, { url: '/api/x', at: 12, api: true }]);
    assert.deepEqual(addTracedScreens(map, [sentOf(trace, 'sets up by the API')]), { calls: 0, screens: 0 });
  }));

test('two tests that send a call from the same screen are both named on it, each once, ordered by file and line', () =>
  inTempDir((dir) => {
    const map = mapOf();
    const first = traceFile(dir, 'first', [{ goto: '/a', at: 1 }], [{ url: '/api/x', at: 5 }, { url: '/api/x', at: 6 }]);
    const second = traceFile(dir, 'second', [{ goto: '/a', at: 1 }], [{ url: '/api/x', at: 5 }]);
    addTracedScreens(map, [sentOf(second, 'second', 20), sentOf(first, 'first', 3)]);
    assert.deepEqual(tracedOf(map), { 'POST:/api/x': ['/a#A ← first, second'] });
  }));

test('the trace lists each request a page sent with the address it showed then, and leaves out what the test sent without a page', () =>
  inTempDir((dir) => {
    const trace = traceFile(dir, 'pages', [{ goto: '/a', at: 1 }, { goto: '/b?tab=2', at: 10 }], [{ url: '/api/x', at: 5 }, { url: '/api/x', at: 6, api: true }, { method: 'GET', url: '/api/me', at: 12 }]);
    const read = readTrace(trace) as Extract<ReturnType<typeof readTrace>, { pageRequests: unknown }>;
    assert.deepEqual(read.pageRequests, [
      { method: 'POST', url: 'http://x/api/x', shown: 'http://x/a' },
      { method: 'GET', url: 'http://x/api/me', shown: 'http://x/b?tab=2' },
    ]);
  }));

test('a screen a call is tied to only by a trace is not a change since the baseline', () =>
  inTempDir((dir) => {
    const before = mapOf();
    const after = mapOf();
    addTracedScreens(after, [sentOf(traceFile(dir, 'a', [{ goto: '/a', at: 1 }], [{ url: '/api/x', at: 5 }]), 'opens a')]);
    assert.ok(after.calls[0].tracedScreens);
    assert.deepEqual(compareMaps(before, after), { screens: { added: [], removed: [], conditions: [], calls: [] }, calls: { added: [], removed: [], server: [] } });
  }));

test('a request sent while a press moves the address without loading a page is tied to no screen, and one from a press that stays is tied', () => {
  const ep = (method: string, url: string) => ({ callId: `${method}:${url}`, method, url });
  const map: any = {
    screens: [screen('/list#List', '/list'), screen('/detail#Detail', '/detail')],
    apiFunctions: { send: { endpoints: [ep('POST', '/api/save'), ep('GET', '/api/detail'), ep('POST', '/api/more')] } },
    calls: [call('POST:/api/save', 'POST', '/api/save'), call('GET:/api/detail', 'GET', '/api/detail'), call('POST:/api/more', 'POST', '/api/more')],
  };
  addTracedScreens(map, [sentOf(path.join(import.meta.dirname, 'fixtures/traces/moves-in-place.zip'), 'moves in place')]);
  assert.deepEqual(tracedOf(map), { 'POST:/api/save': ['/list#List ← moves in place'], 'POST:/api/more': ['/detail#Detail ← moves in place'] });
});
