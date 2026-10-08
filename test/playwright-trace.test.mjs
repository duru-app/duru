import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPlaywright } from '../src/playwright.ts';
import { readTrace } from '../src/playwright-trace.ts';

const RESULTS = path.join(import.meta.dirname, 'fixtures/app/results/playwright-traced');
const REPORT = path.join(RESULTS, 'visits.json');
const tests = readPlaywright(REPORT);
const traceOf = (title) => tests.find((t) => t.title === title).trace;
const address = (url) => url.replace(/^https?:\/\/[^/]+/, '');
const steps = (title) => readTrace(traceOf(title)).steps.map((s) => `${s.kind} ${address(s.url)}`);
const requests = (title) => readTrace(traceOf(title)).requests.map((r) => `${r.method} ${address(r.url)}`);

function storedZip(files) {
  const bodies = [];
  const directory = [];
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

function inTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-trace-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a test that only opens screens leaves one visit per address, in order', () => {
  assert.deepEqual(steps('opens home and then help'), ['visit /home', 'visit /help']);
});

test('a click is an interaction on the address that was open, query included', () => {
  assert.deepEqual(steps('presses the button on home'), ['visit /home?tab=recent', 'interact /home?tab=recent']);
});

test('an expect is an assertion on the address that was open', () => {
  assert.deepEqual(steps('checks the path of a document'), [
    'visit /document/42?mode=edit#participants',
    'assert /document/42?mode=edit#participants',
  ]);
});

test('a move without a page load is a visit to the new address', () => {
  assert.deepEqual(steps('moves to the drafts without loading a page'), ['visit /home', 'visit /document/draft', 'assert /document/draft']);
});

test('a click that leads to another address is an interaction on the address it was made on', () => {
  assert.deepEqual(steps('follows a link while waiting for the new address'), ['visit /home', 'interact /home', 'visit /help', 'assert /help']);
});

test('hovering and keyboard presses are interactions', () => {
  assert.deepEqual(steps('hovers and uses the keyboard on help'), ['visit /help', 'interact /help', 'interact /help']);
});

test('moving the mouse and turning the wheel are interactions', () => {
  assert.deepEqual(steps('moves the mouse and turns the wheel on help'), ['visit /help', 'interact /help', 'interact /help']);
});

test('an interaction is counted on the address that was open when the input was made', () => {
  assert.deepEqual(steps('uses the mouse right after the address changes'), ['visit /home', 'visit /help', 'interact /help']);
  assert.deepEqual(steps('clicks a button that appears after the address changes'), ['visit /home', 'visit /help', 'interact /help']);
  assert.deepEqual(steps('types into a field and submits with the keyboard'), [
    'visit /home',
    'interact /home',
    'interact /home',
    'visit /document/draft',
    'interact /document/draft',
  ]);
});

test('an expect that waited for the address to change is an assertion on the new address', () => {
  assert.deepEqual(steps('checks a text that appears after the address changes'), ['visit /home', 'visit /document/draft', 'assert /document/draft']);
});

test('an interaction that ended in an error is not counted, even when its input went in, while an expect that failed is still an assertion', () => {
  assert.deepEqual(steps('gives up on a button and on a text that are not there'), ['visit /home', 'assert /home']);
  assert.deepEqual(steps('gives up on a button that is covered'), ['visit /home']);
  assert.deepEqual(steps('gives up on a field that is switched off'), ['visit /home']);
  assert.deepEqual(steps('checks a box that refuses to change'), ['visit /home']);
  assert.deepEqual(steps('runs out of time while typing slowly'), ['visit /home']);
});

test('a test that opened no page has no steps but keeps its requests', () => {
  assert.deepEqual(readTrace(traceOf('calls the server without opening a page')), { steps: [], requests: [{ method: 'POST', url: 'http://127.0.0.1:4598/api/v1/press' }] });
});

test('an app opened from a file counts like one opened from a server', () => {
  const opened = readTrace(traceOf('opens the app from a file')).steps;
  assert.deepEqual(opened.map((s) => s.kind), ['visit', 'interact']);
  assert.match(opened[0].url, /^file:.*\/build\/index\.html$/);
});

test('nothing is counted on a page that shows no address of the app', () => {
  assert.deepEqual(steps('clicks on a blank page after leaving home'), ['visit /home']);
});

test('requests come back with their method and address in the order they were sent', () => {
  assert.deepEqual(requests('presses the button on home'), ['GET /home?tab=recent', 'GET /settings.js', 'GET /app.js', 'POST /api/v1/press']);
});

test('a trace recorded under another folder is found next to the report', () => {
  const recorded = JSON.parse(fs.readFileSync(REPORT, 'utf8')).suites.flatMap((s) => s.specs).find((s) => s.title === 'wanders off the map');
  assert.equal(fs.existsSync(recorded.tests[0].results[0].attachments[0].path), false);
  assert.equal(traceOf('wanders off the map'), path.join(RESULTS, 'test-results/visits-wanders-off-the-map-chromium/trace.zip'));
});

test('a trace file of another test lying next to the report is not taken for a test whose own trace is gone', () =>
  inTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'trace.zip'), '');
    const recorded = '/builds/app/test-results/a-one/trace.zip';
    const report = path.join(dir, 'report.json');
    fs.writeFileSync(report, JSON.stringify({
      suites: [{ title: 'a.spec.ts', specs: [{ title: 'one', file: 'a.spec.ts', line: 1, tests: [{ projectName: 'chromium', status: 'expected', results: [{ attachments: [{ name: 'trace', path: recorded }] }] }] }] }],
    }));
    assert.equal(readPlaywright(report)[0].trace, recorded);
  }));

test('the copy next to the report wins over the recorded path when both exist', () =>
  inTempDir((dir) => {
    const recorded = path.join(dir, 'project/test-results/a-one/trace.zip');
    const copy = path.join(dir, 'archive/test-results/a-one/trace.zip');
    for (const file of [recorded, copy]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }
    const report = path.join(dir, 'archive/report.json');
    fs.writeFileSync(report, JSON.stringify({
      suites: [{ title: 'a.spec.ts', specs: [{ title: 'one', file: 'a.spec.ts', line: 1, tests: [{ projectName: 'chromium', status: 'expected', results: [{ attachments: [{ name: 'trace', path: recorded }] }] }] }] }],
    }));
    assert.equal(readPlaywright(report)[0].trace, copy);
  }));

test('a test that ran without tracing has no trace', () => {
  assert.equal(traceOf('opens help without a trace'), null);
});

test('a test that ran again uses the trace of its last run', () =>
  inTempDir((dir) => {
    const first = path.join(dir, 'first.zip');
    const last = path.join(dir, 'last.zip');
    fs.writeFileSync(first, '');
    fs.writeFileSync(last, '');
    const attachment = (file) => [{ name: 'trace', contentType: 'application/zip', path: file }];
    const report = path.join(dir, 'report.json');
    fs.writeFileSync(report, JSON.stringify({
      suites: [{ title: 'a.spec.ts', specs: [{ title: 'retried', file: 'a.spec.ts', line: 1, tests: [{ projectName: 'chromium', status: 'flaky', results: [{ attachments: attachment(first) }, { attachments: attachment(last) }] }] }] }],
    }));
    assert.equal(readPlaywright(report)[0].trace, last);
  }));

test('a trace that is missing, broken or empty of browser records gives a reason instead of steps', () =>
  inTempDir((dir) => {
    assert.deepEqual(readTrace(path.join(dir, 'gone.zip')), { reason: 'trace 파일이 없습니다' });
    const broken = path.join(dir, 'broken.zip');
    fs.writeFileSync(broken, 'this is not a zip file at all');
    assert.match(readTrace(broken).reason, /^trace 파일을 열지 못했습니다: /);
    const runnerOnly = path.join(dir, 'runner-only.zip');
    fs.writeFileSync(runnerOnly, storedZip({ 'test.trace': `${JSON.stringify({ type: 'context-options', version: 8 })}\n` }));
    assert.deepEqual(readTrace(runnerOnly), { reason: 'trace 파일에서 브라우저 기록을 찾지 못했습니다' });
  }));

test('a trace recorded without snapshots gives a reason, since it cannot tell which address was open', () => {
  assert.deepEqual(readTrace(traceOf('presses the button without snapshots')), { reason: 'trace 파일에 화면 스냅숏이 없어 테스트가 연 주소를 알 수 없습니다' });
});

test('a trace of a version duru does not know gives a reason that names the version', () =>
  inTempDir((dir) => {
    const file = path.join(dir, 'newer.zip');
    fs.writeFileSync(file, storedZip({ '0-trace.trace': `${JSON.stringify({ type: 'context-options', version: 99, playwrightVersion: '9.9.9' })}\n` }));
    assert.deepEqual(readTrace(file), { reason: '두루가 모르는 trace 파일 버전입니다: 99 (Playwright 9.9.9)' });
  }));
