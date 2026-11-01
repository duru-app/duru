import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SentTrace } from '../src/request-options.ts';
import { markUnrecorded } from '../src/unrecorded-calls.ts';

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

function withTraces<T>(traces: { method: string; url: string }[][], fn: (sent: SentTrace[]) => T) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-unrecorded-'));
  try {
    const line = (e: object) => `${JSON.stringify(e)}\n`;
    const sent = traces.map((requests, i) => {
      const file = path.join(dir, `${i}.zip`);
      fs.writeFileSync(file, storedZip({
        '0-trace.trace': line({ type: 'context-options', version: 8 }),
        '0-trace.network': requests.map(({ method, url }, at) => line({
          type: 'resource-snapshot',
          snapshot: { _monotonicTime: at + 1, request: { method, url: `http://x${url}`, headers: [] }, response: { status: 200, content: { mimeType: 'application/json' } } },
        })).join(''),
      }));
      return { trace: file, title: `test ${i}`, file: 'test/a.spec.ts', line: i + 1, project: null, status: 'pass' } as SentTrace;
    });
    return fn(sent);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const call = (method: string, url: string, screens: string[]) => ({ id: `${method}:${url}`, method, path: url, server: { status: 'match' }, apiFunctions: ['send'], screens, options: [] as object[] });

function mapOf() {
  const calls = [
    call('POST', '/api/report', ['/report#Report']),
    call('PUT', '/api/report/{0}', ['/report#Report', '/edit#Edit']),
    call('DELETE', '/api/report/{0}', ['/report#Report']),
    call('PATCH', '/api/unused', []),
    call('GET', '/api/report', ['/report#Report']),
  ];
  return {
    screens: [],
    apiFunctions: { send: { endpoints: calls.map((c) => ({ callId: c.id, method: c.method, url: c.path.replace('{0}', '{id}') })) } },
    calls,
  };
}
const unrecordedOf = (map: ReturnType<typeof mapOf>) => map.calls.filter((c: any) => c.unrecorded).map((c) => c.id);

test('a write call on a screen that no trace sent is unrecorded, and one a trace sent is not', () =>
  withTraces([[{ method: 'POST', url: '/api/report' }], [{ method: 'DELETE', url: '/api/report/7' }]], (sent) => {
    const map = mapOf();
    assert.deepEqual(markUnrecorded(map, sent), { calls: 1, screens: 2 });
    assert.deepEqual(unrecordedOf(map), ['PUT:/api/report/{0}']);
  }));

test('a GET, and a write call on no screen, are never unrecorded', () =>
  withTraces([], (sent) => {
    const map = mapOf();
    assert.deepEqual(markUnrecorded(map, sent), { calls: 3, screens: 2 });
    assert.deepEqual(unrecordedOf(map), ['POST:/api/report', 'PUT:/api/report/{0}', 'DELETE:/api/report/{0}']);
  }));

test('a trace that cannot be read records nothing, and the calls it might have sent stay unrecorded', () =>
  withTraces([[{ method: 'POST', url: '/api/report' }]], (sent) => {
    const map = mapOf();
    markUnrecorded(map, [...sent.map((s) => ({ ...s, trace: `${s.trace}.gone` }))]);
    assert.ok(unrecordedOf(map).includes('POST:/api/report'));
  }));

test('a write call a trace sent with its method in lower case is not unrecorded', () =>
  withTraces([[{ method: 'put', url: '/api/report/7' }]], (sent) => {
    const map = mapOf();
    markUnrecorded(map, sent);
    assert.ok(!unrecordedOf(map).includes('PUT:/api/report/{0}'));
  }));
