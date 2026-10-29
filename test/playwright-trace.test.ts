import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPlaywright } from '../src/playwright.ts';
import { copyShots, readTrace } from '../src/playwright-trace.ts';

const RESULTS = path.join(import.meta.dirname, 'fixtures/app/results/playwright-traced');
const REPORT = path.join(RESULTS, 'visits.json');
type Traced = Extract<ReturnType<typeof readTrace>, { steps: unknown }>;

const tests = readPlaywright(REPORT)!;
const traceOf = (title: string) => tests.find((t) => t.title === title)!.trace;
const address = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');
const steps = (title: string) => (readTrace(traceOf(title)!) as Traced).steps.map((s) => `${s.kind} ${address(s.url)}`);
const requests = (title: string) => (readTrace(traceOf(title)!) as Traced).requests.map((r) => `${r.method} ${address(r.url)}`);

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

function inTempDir<T>(fn: (dir: string) => T) {
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
  const { steps, requests } = readTrace(traceOf('calls the server without opening a page')!) as Traced;
  assert.deepEqual({ steps, requests }, { steps: [], requests: [{ method: 'POST', url: 'http://127.0.0.1:4598/api/v1/press' }] });
});

test('an app opened from a file counts like one opened from a server', () => {
  const opened = (readTrace(traceOf('opens the app from a file')!) as Traced).steps;
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
  const recorded = JSON.parse(fs.readFileSync(REPORT, 'utf8')).suites.flatMap((s: { specs: unknown[] }) => s.specs).find((s: { title: string }) => s.title === 'wanders off the map');
  assert.equal(fs.existsSync(recorded.tests[0].results[0].attachments[0].path), false);
  assert.equal(traceOf('wanders off the map'), path.join(RESULTS, 'test-results/visits-wanders-off-the-map-chromium/trace.zip'));
});

test('a trace file of another test lying next to the report is not taken for a test whose own trace is gone', () =>
  inTempDir((dir: string) => {
    fs.writeFileSync(path.join(dir, 'trace.zip'), '');
    const recorded = '/builds/app/test-results/a-one/trace.zip';
    const report = path.join(dir, 'report.json');
    fs.writeFileSync(report, JSON.stringify({
      suites: [{ title: 'a.spec.ts', specs: [{ title: 'one', file: 'a.spec.ts', line: 1, tests: [{ projectName: 'chromium', status: 'expected', results: [{ attachments: [{ name: 'trace', path: recorded }] }] }] }] }],
    }));
    assert.equal(readPlaywright(report)![0].trace, recorded);
  }));

test('the copy next to the report wins over the recorded path when both exist', () =>
  inTempDir((dir: string) => {
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
    assert.equal(readPlaywright(report)![0].trace, copy);
  }));

test('a test that ran without tracing has no trace', () => {
  assert.equal(traceOf('opens help without a trace'), null);
});

test('a test that ran again uses the trace of its last run', () =>
  inTempDir((dir: string) => {
    const first = path.join(dir, 'first.zip');
    const last = path.join(dir, 'last.zip');
    fs.writeFileSync(first, '');
    fs.writeFileSync(last, '');
    const attachment = (file: string) => [{ name: 'trace', contentType: 'application/zip', path: file }];
    const report = path.join(dir, 'report.json');
    fs.writeFileSync(report, JSON.stringify({
      suites: [{ title: 'a.spec.ts', specs: [{ title: 'retried', file: 'a.spec.ts', line: 1, tests: [{ projectName: 'chromium', status: 'flaky', results: [{ attachments: attachment(first) }, { attachments: attachment(last) }] }] }] }],
    }));
    assert.equal(readPlaywright(report)![0].trace, last);
  }));

test('a trace that is missing, broken or empty of browser records gives a reason instead of steps', () =>
  inTempDir((dir: string) => {
    assert.deepEqual(readTrace(path.join(dir, 'gone.zip')), { reason: 'trace 파일이 없습니다' });
    const broken = path.join(dir, 'broken.zip');
    fs.writeFileSync(broken, 'this is not a zip file at all');
    assert.match((readTrace(broken) as { reason: string }).reason, /^trace 파일을 열지 못했습니다: /);
    const runnerOnly = path.join(dir, 'runner-only.zip');
    fs.writeFileSync(runnerOnly, storedZip({ 'test.trace': `${JSON.stringify({ type: 'context-options', version: 8 })}\n` }));
    assert.deepEqual(readTrace(runnerOnly), { reason: 'trace 파일에서 브라우저 기록을 찾지 못했습니다' });
  }));

test('a trace recorded without snapshots gives a reason, since it cannot tell which address was open', () => {
  assert.deepEqual(readTrace(traceOf('presses the button without snapshots')!), { reason: 'trace 파일에 화면 스냅숏이 없어 테스트가 연 주소를 알 수 없습니다' });
});

test('a trace of a version duru does not know gives a reason that names the version', () =>
  inTempDir((dir: string) => {
    const file = path.join(dir, 'newer.zip');
    fs.writeFileSync(file, storedZip({ '0-trace.trace': `${JSON.stringify({ type: 'context-options', version: 99, playwrightVersion: '9.9.9' })}\n` }));
    assert.deepEqual(readTrace(file), { reason: '두루가 모르는 trace 파일 버전입니다: 99 (Playwright 9.9.9)' });
  }));

const INPUTS = path.join(import.meta.dirname, 'fixtures/app/traces/inputs.zip');
const inputSteps = () => (readTrace(INPUTS) as Traced).steps.filter((s) => s.input || s.inputSkipped).map((s) => [address(s.url), s.input ?? 'skipped']);

test('a fill that found its box by label, placeholder or test ID gives the box words and the value', () => {
  const found = inputSteps();
  assert.deepEqual(found[2], ['/home', { box: { placeholder: '이름' }, value: 'Kim' }]);
  assert.deepEqual(found[3], ['/home', { box: { testId: 'amount' }, value: '3' }]);
  assert.deepEqual(found[0], ['/home', { box: { label: '메모', nth: 1 }, value: '첫 메모' }]);
});

test('a trailing i or s on the words is ignored, and a quote inside the words is kept', () => {
  const found = inputSteps();
  assert.deepEqual(found[1], ['/home', { box: { label: '메모', nth: 2 }, value: '둘째 메모' }]);
  assert.deepEqual(found[6], ['/home', { box: { label: '따옴표 "큰"' }, value: 'q' }]);
});

test('nth is counted from 1, while the trace counts from 0', () => {
  const found = inputSteps();
  assert.deepEqual(found.slice(0, 2).map(([, input]) => (input as { box: { nth?: number } }).box.nth), [1, 2]);
  assert.equal(found.filter(([, input]) => input !== 'skipped' && (input as { box: { nth?: number } }).box.nth === undefined).length, 4);
});

test('a fill found by CSS or role, a fill with an empty value and a fill whose box words are blank are marked skipped', () => {
  const found = inputSteps();
  const skipped = found.map(([, input]) => input === 'skipped');
  assert.deepEqual(skipped.slice(0, 8), [false, false, false, false, true, true, false, true]);
  assert.deepEqual(skipped.slice(14), [true, false]);
});

test('typing, choosing an option, checking, unchecking and picking files are marked skipped, since they write a value no input can hold', () => {
  const methods = ['type', 'selectOption', 'check', 'uncheck', 'check', 'setInputFiles'];
  const skipped = (readTrace(INPUTS) as Traced).steps.filter((s) => s.inputSkipped);
  assert.equal(skipped.length, 3 + methods.length + 1);
});

test('a key press and a click carry no input and are not marked skipped', () => {
  const plain = (readTrace(INPUTS) as Traced).steps.filter((s) => s.kind === 'interact' && !s.input && !s.inputSkipped);
  assert.equal(plain.length, 2);
});

test('an input is put on the address that was open when it was filled', () => {
  assert.deepEqual(inputSteps().at(-1), ['/document/draft', { box: { placeholder: '제목' }, value: '제목 값' }]);
});

const CALLS = path.join(RESULTS, 'test-results');
const walkOf = (file: string) => (readTrace(file) as Traced).walk.map((line) => (line.kind === 'request' ? { ...line, url: address(line.url) } : { ...line, ...(line.url && { url: address(line.url) }) }));
const walkLines = (file: string) => walkOf(file).map((line) => (line.kind === 'request' ? `${line.method} ${line.url} ${line.status ?? 'no response'}` : `${line.kind} ${line.url ?? '-'}${line.failed ? ' failed' : ''}`));

test('the walk puts the requests a test sent between its steps, with the response status', () => {
  assert.deepEqual(walkLines(path.join(CALLS, 'calls-turns-the-pages-of-the-member-list-chromium/trace.zip')), [
    'open /home',
    'GET /api/v1/member/list?page=2 404',
    'GET /api/v1/member/list?page=3 404',
  ]);
});

test('the walk leaves out the page, scripts, styles, pictures and fonts the browser loaded', () => {
  assert.equal(requests('opens home and then help').length, 6);
  assert.deepEqual(walkLines(traceOf('opens home and then help')!), ['open /home', 'open /help']);
});

type Sent = { method?: string; url: string; at?: number; status?: number; type: string; api?: true; dest?: string };

function traceZip(dir: string, events: object[], resources: Sent[], files: Record<string, string> = {}) {
  const file = path.join(dir, 'trace.zip');
  const line = (e: object) => `${JSON.stringify(e)}\n`;
  fs.writeFileSync(file, storedZip({
    '0-trace.trace': [{ type: 'context-options', version: 8 }, ...events].map(line).join(''),
    '0-trace.network': resources.map(({ method = 'GET', url, at, status = 200, type, api, dest }, i) => line({
      type: 'resource-snapshot',
      snapshot: { _monotonicTime: at ?? i + 1, ...(api && { _apiRequest: true }), request: { method, url: url.startsWith('http') ? url : `http://x${url}`, headers: dest ? [{ name: 'Sec-Fetch-Dest', value: dest }] : [] }, response: { status, content: { mimeType: type } } },
    })).join(''),
    ...files,
  }));
  return file;
}

const frameSnapshot = (name: string, url: string, at: number) => ({ type: 'frame-snapshot', snapshot: { snapshotName: name, isMainFrame: true, frameUrl: url, timestamp: at } });

const sentLines = (resources: Sent[]) => inTempDir((dir) => walkLines(traceZip(dir, [], resources)));

test('a request that is not a GET, or whose status is 400 or more, stays in the walk whatever type its response has', () => {
  assert.deepEqual(sentLines([
    { url: '/home', status: 200, type: 'text/html' },
    { method: 'POST', url: '/login', status: 200, type: 'text/html; charset=utf-8' },
    { url: '/nowhere', status: 404, type: 'text/html' },
    { url: '/report', status: 500, type: 'text/html;charset=UTF-8' },
    { url: '/app.js', status: 200, type: 'text/javascript' },
    { url: '/old.js', status: 404, type: 'text/javascript' },
    { url: '/api/v1/documents/7/preview.png', status: 500, type: 'application/json' },
    { url: '/page', status: 200, type: 'text/html', api: true },
  ]), ['POST /login 200', 'GET /nowhere 404', 'GET /report 500', 'GET /old.js 404', 'GET /api/v1/documents/7/preview.png 500', 'GET /page 200']);
});

test('a GET of a static file that got no failing status, a dev server file and the favicon are left out, and other requests stay', () => {
  assert.deepEqual(sentLines([
    { url: '/settings.js', status: -1, type: 'x-unknown' },
    { url: '/fonts/a.woff2?v=3', status: -1, type: 'x-unknown' },
    { url: '/fonts/icons.eot', status: -1, type: 'x-unknown' },
    { url: '/logo.PNG', status: -1, type: 'x-unknown' },
    { url: '/favicon.ico', status: 404, type: 'text/html' },
    { url: '/theme.css', status: 304, type: '' },
    { url: '/src/main.tsx', status: -1, type: 'x-unknown' },
    { url: '/src/styles/main.scss', status: -1, type: 'x-unknown' },
    { url: '/src/App.vue?t=1', status: 200, type: 'application/javascript' },
    { url: '/@vite/client', status: -1, type: 'x-unknown' },
    { url: '/admin/@vite/client', status: -1, type: 'x-unknown' },
    { url: '/@react-refresh', status: 200, type: 'text/javascript' },
    { url: '/main.abc.hot-update.json', status: 200, type: 'application/json' },
    { url: '/sockjs-node/info?t=1', status: 200, type: 'application/json' },
    { url: '/__webpack_hmr', status: 200, type: 'text/event-stream' },
    { url: '/_next/webpack-hmr?page=/', status: -1, type: 'x-unknown' },
    { url: '/main.def.hot-update.json', status: 404, type: 'text/html' },
    { url: '/api/v1/list', status: -1, type: 'x-unknown' },
    { url: '/api/v1/data.json', status: -1, type: 'x-unknown' },
    { url: '/api/v1/cached', status: 304, type: '' },
    { method: 'POST', url: '/upload.png', status: -1, type: 'x-unknown' },
  ]), ['GET /api/v1/list no response', 'GET /api/v1/data.json no response', 'GET /api/v1/cached 304', 'POST /upload.png no response']);
  assert.deepEqual(walkOf(traceOf('opens the app from a file')!).filter((line) => line.kind === 'request'), []);
  assert.deepEqual(walkLines(traceOf('uses the mouse right after the address changes')!).filter((line) => line.startsWith('POST')), ['POST /api/v1/press no response']);
});

test('a request sent without a page is in the walk with its status', () => {
  assert.deepEqual(walkLines(traceOf('calls the server without opening a page')!), ['POST /api/v1/press 200']);
});

test('the walk keeps an action that ended in an error as failed, while the steps leave it out', () => {
  const title = 'gives up on a button that is covered';
  assert.deepEqual(walkLines(traceOf(title)!), ['open /home', 'press /home failed']);
  assert.deepEqual(steps(title), ['visit /home']);
});

test('the walk tells pressing from writing, and puts every write in its place with the box, or with a mark that the box was not read and its selector', () => {
  const walk = walkOf(INPUTS).filter((line) => line.kind !== 'request');
  assert.deepEqual(walk.map((line) => [line.kind, 'method' in line ? line.method : null]), [
    ['open', null],
    ...[...Array(7)].map(() => ['write', 'fill']),
    ['press', 'press'],
    ['write', 'fill'], ['write', 'type'], ['write', 'selectOption'], ['write', 'check'], ['write', 'uncheck'], ['write', 'check'], ['write', 'setInputFiles'], ['write', 'fill'],
    ['press', 'click'],
    ['open', null],
    ['write', 'fill'],
  ]);
  const writes = walk.filter((line) => line.kind === 'write').map((line) => 'box' in line && line.box ? { box: line.box, value: line.value, checked: line.checked } : { unread: (line as { unread?: string }).unread, value: (line as { value?: string }).value, selector: (line as { selector?: string }).selector });
  assert.deepEqual(writes, [
    { box: { label: '메모', nth: 1 }, value: '첫 메모', checked: undefined },
    { box: { label: '메모', nth: 2 }, value: '둘째 메모', checked: undefined },
    { box: { placeholder: '이름' }, value: 'Kim', checked: undefined },
    { box: { testId: 'amount' }, value: '3', checked: undefined },
    { unread: 'box', value: 'css 값', selector: '#css' },
    { unread: 'box', value: 'role 값', selector: 'internal:role=textbox[name="코드"i]' },
    { box: { label: '따옴표 "큰"' }, value: 'q', checked: undefined },
    { box: { placeholder: '이름' }, value: '', checked: undefined },
    { box: { placeholder: '이름' }, value: 'abc', checked: undefined },
    { unread: 'box', value: '나', selector: '#sel' },
    { unread: 'box', value: undefined, selector: '#chk' },
    { unread: 'box', value: undefined, selector: '#chk' },
    { unread: 'box', value: undefined, selector: '#chk' },
    { unread: 'box', value: undefined, selector: '#file' },
    { unread: 'box', value: 'x', selector: 'internal:attr=[placeholder=" "s]' },
    { box: { placeholder: '제목' }, value: '제목 값', checked: undefined },
  ]);
  assert.deepEqual(walk.filter((line) => 'checked' in line).map((line) => (line as { checked: boolean }).checked), [true, false, true]);
  assert.deepEqual(walk.filter((line) => 'selector' in line && !('unread' in line)), []);
  assert.equal(walk.at(-1)!.url, '/document/draft');
});

test('a box found by label is read for a check as well as for a fill', () =>
  inTempDir((dir) => {
    const file = path.join(dir, 'trace.zip');
    const line = (e: object) => `${JSON.stringify(e)}\n`;
    const page = 'page@1';
    fs.writeFileSync(file, storedZip({
      '0-trace.trace': [
        line({ type: 'context-options', version: 8 }),
        line({ type: 'before', callId: 'call@1', pageId: page, method: 'goto', startTime: 1, params: { url: 'http://x/home' } }),
        line({ type: 'after', callId: 'call@1', endTime: 2 }),
        line({ type: 'frame-snapshot', snapshot: { snapshotName: 'after@call@1', isMainFrame: true, frameUrl: 'http://x/home', timestamp: 2 } }),
        line({ type: 'before', callId: 'call@2', pageId: page, method: 'check', startTime: 3, params: { selector: 'internal:label="동의"i' } }),
        line({ type: 'after', callId: 'call@2', endTime: 4 }),
      ].join(''),
    }));
    assert.deepEqual((readTrace(file) as Traced).walk, [
      { kind: 'open', url: 'http://x/home' },
      { kind: 'write', method: 'check', box: { label: '동의' }, checked: true, url: 'http://x/home' },
    ]);
  }));

function clickTrace(resources: Sent[], after = 'http://x/next', before = 'http://x/home') {
  const page = 'page@1';
  return inTempDir((dir) => walkLines(traceZip(dir, [
    { type: 'before', callId: 'call@1', pageId: page, method: 'goto', startTime: 1, params: { url: before } },
    { type: 'after', callId: 'call@1', endTime: 2 },
    frameSnapshot('after@call@1', before, 2),
    { type: 'before', callId: 'call@2', pageId: page, method: 'click', startTime: 10, params: { selector: '#next' } },
    frameSnapshot('before@call@2', before, 10),
    { type: 'after', callId: 'call@2', endTime: 20 },
    frameSnapshot('after@call@2', after, 21),
  ], resources)));
}

test('a press that loads a new page opens it when the page is asked for, so the calls the new page sends come after 「열기」', () => {
  assert.deepEqual(clickTrace([
    { url: '/api/before', at: 11, type: 'application/json' },
    { url: '/next?from=home', at: 12, type: 'text/html' },
    { url: '/api/next', at: 15, type: 'application/json' },
    { url: '/api/later', at: 25, type: 'application/json' },
  ], 'http://x/next#top'), ['open /home', 'press /home', 'GET /api/before 200', 'open /next#top', 'GET /api/next 200', 'GET /api/later 200']);
});

test('a press that changes the address without loading a page opens it when the press ends', () => {
  assert.deepEqual(clickTrace([
    { url: '/api/next', at: 15, type: 'application/json' },
    { url: '/api/later', at: 25, type: 'application/json' },
  ]), ['open /home', 'press /home', 'GET /api/next 200', 'open /next', 'GET /api/later 200']);
});

test('a page the app moves to after a press has ended opens when that page is asked for, so the calls it sends come after 「열기」', () => {
  const page = 'page@1';
  assert.deepEqual(inTempDir((dir) => walkLines(traceZip(dir, [
    { type: 'before', callId: 'call@1', pageId: page, method: 'goto', startTime: 1, params: { url: 'http://x/login' } },
    { type: 'after', callId: 'call@1', endTime: 2 },
    frameSnapshot('after@call@1', 'http://x/login', 2),
    { type: 'before', callId: 'call@2', pageId: page, method: 'click', startTime: 10, params: { selector: '#login' } },
    frameSnapshot('before@call@2', 'http://x/login', 10),
    { type: 'after', callId: 'call@2', endTime: 20 },
    frameSnapshot('after@call@2', 'http://x/login', 20),
    { type: 'before', callId: 'call@3', pageId: page, method: 'click', startTime: 30, params: { selector: '#menu' } },
    frameSnapshot('before@call@3', 'http://x/home', 30),
    { type: 'after', callId: 'call@3', endTime: 31 },
  ], [
    { method: 'POST', url: '/api/login', at: 21, type: 'application/json' },
    { url: '/home', at: 22, type: 'text/html' },
    { url: '/api/me', at: 23, type: 'application/json' },
  ]))), ['open /login', 'press /login', 'POST /api/login 200', 'open /home', 'GET /api/me 200', 'press /home']);
});

test('a press that moves the address without loading a page is not opened at a call to the new path that did not answer with a page', () => {
  assert.deepEqual(clickTrace([
    { url: '/next?_rsc=1', at: 12, type: 'text/x-component' },
  ]), ['open /home', 'press /home', 'GET /next?_rsc=1 200', 'open /next']);
});

test('a page the test opened again and got back as 304 is not a call the test sent', () => {
  assert.deepEqual(clickTrace([
    { url: '/home', at: 12, status: 304, type: '' },
  ], 'http://x/home'), ['open /home', 'press /home']);
});

test('a page asked for during a press that ends before the address changes opens once the old address was last seen, so the calls the new page sends come after 「열기」', () => {
  const page = 'page@1';
  assert.deepEqual(inTempDir((dir) => walkLines(traceZip(dir, [
    { type: 'before', callId: 'call@1', pageId: page, method: 'goto', startTime: 1, params: { url: 'http://x/home' } },
    { type: 'after', callId: 'call@1', endTime: 2 },
    frameSnapshot('after@call@1', 'http://x/home', 2),
    { type: 'before', callId: 'call@2', pageId: page, method: 'click', startTime: 10, params: { selector: '#next' } },
    frameSnapshot('before@call@2', 'http://x/home', 10),
    { type: 'after', callId: 'call@2', endTime: 20 },
    frameSnapshot('after@call@2', 'http://x/home', 20),
    { type: 'before', callId: 'call@3', pageId: page, method: 'click', startTime: 30, params: { selector: '#menu' } },
    frameSnapshot('before@call@3', 'http://x/next', 30),
    { type: 'after', callId: 'call@3', endTime: 31 },
  ], [
    { url: '/next', at: 15, type: 'text/html' },
    { url: '/api/old', at: 16, type: 'application/json' },
    { url: '/api/next', at: 22, type: 'application/json' },
  ]))), ['open /home', 'press /home', 'GET /api/old 200', 'open /next', 'GET /api/next 200', 'press /next']);
});

test('a page whose first snapshot comes after a press opens at the page request made during the press', () => {
  assert.deepEqual(inTempDir((dir) => walkLines(traceZip(dir, [
    { type: 'before', callId: 'call@1', pageId: 'page@2', method: 'click', startTime: 10, params: { selector: '#next' } },
    { type: 'after', callId: 'call@1', endTime: 20 },
    frameSnapshot('after@call@1', 'http://x/next', 20),
  ], [
    { url: '/next', at: 12, type: 'text/html' },
    { url: '/api/next', at: 15, type: 'application/json' },
  ]))), ['press -', 'open /next', 'GET /api/next 200']);
});

test('a page load the browser marks as a document is not a call the test sent, a redirect included', () => {
  assert.deepEqual(clickTrace([
    { url: '/next', at: 12, status: 302, type: '', dest: 'document' },
    { url: '/login', at: 13, type: 'text/html', dest: 'document' },
    { url: '/api/me', at: 14, type: 'application/json', dest: 'empty' },
  ], 'http://x/login'), ['open /home', 'press /home', 'open /login', 'GET /api/me 200']);
});

test('a link the browser opens as a document that answers with a file, not a page, or gets no answer with no document asked for after it, is a call the test sent', () => {
  assert.deepEqual(clickTrace([
    { url: '/api/report/export', at: 12, type: 'text/csv', dest: 'document' },
    { url: '/home?format=csv', at: 13, type: 'text/csv', dest: 'document' },
    { url: '/api/report/export?all', at: 14, status: -1, type: 'x-unknown', dest: 'document' },
  ], 'http://x/home'), ['open /home', 'press /home', 'GET /api/report/export 200', 'GET /home?format=csv 200', 'GET /api/report/export?all no response']);
});

test('a document left without an answer because another page load followed it is not a call the test sent', () => {
  assert.deepEqual(clickTrace([
    { url: '/other', at: 12, status: -1, type: 'x-unknown', dest: 'document' },
    { url: '/next', at: 13, type: 'text/html', dest: 'document' },
  ]), ['open /home', 'press /home', 'open /next']);
});

test('a document left without an answer is not a call the test sent when a later action asks for another page', () => {
  const page = 'page@1';
  assert.deepEqual(inTempDir((dir) => walkLines(traceZip(dir, [
    { type: 'before', callId: 'call@1', pageId: page, method: 'goto', startTime: 1, params: { url: 'http://x/home' } },
    { type: 'after', callId: 'call@1', endTime: 2 },
    frameSnapshot('after@call@1', 'http://x/home', 2),
    { type: 'before', callId: 'call@2', pageId: page, method: 'click', startTime: 10, params: { selector: '#other' } },
    frameSnapshot('before@call@2', 'http://x/home', 10),
    { type: 'after', callId: 'call@2', endTime: 20 },
    frameSnapshot('after@call@2', 'http://x/home', 20),
    { type: 'before', callId: 'call@3', pageId: page, method: 'click', startTime: 30, params: { selector: '#next' } },
    frameSnapshot('before@call@3', 'http://x/home', 30),
    { type: 'after', callId: 'call@3', endTime: 40 },
    frameSnapshot('after@call@3', 'http://x/next', 41),
  ], [
    { url: '/other', at: 12, status: -1, type: 'x-unknown', dest: 'document' },
    { url: '/next', at: 35, type: 'text/html', dest: 'document' },
  ]))), ['open /home', 'press /home', 'press /home', 'open /next']);
});

test('a document left without an answer on a path the test had open is not a call the test sent', () => {
  assert.deepEqual(clickTrace([
    { url: '/home', at: 12, status: -1, type: 'x-unknown', dest: 'document' },
  ], 'http://x/home'), ['open /home', 'press /home']);
});

test('a document the page then shows is a page load whatever it answered, and an error page stays a call after 「열기」', () => {
  assert.deepEqual(clickTrace([
    { url: '/next', at: 12, type: 'application/json', dest: 'document' },
  ]), ['open /home', 'press /home', 'open /next']);
  assert.deepEqual(clickTrace([
    { url: '/next', at: 12, status: 500, type: 'text/plain', dest: 'document' },
  ]), ['open /home', 'press /home', 'open /next', 'GET /next 500']);
});

test('a press that runs alongside another opens the new page at its request, judged by the snapshots in time order', () => {
  const page = 'page@1';
  assert.deepEqual(inTempDir((dir) => walkLines(traceZip(dir, [
    { type: 'before', callId: 'call@1', pageId: page, method: 'goto', startTime: 1, params: { url: 'http://x/home' } },
    { type: 'after', callId: 'call@1', endTime: 2 },
    frameSnapshot('after@call@1', 'http://x/home', 2),
    { type: 'before', callId: 'call@2', pageId: page, method: 'click', startTime: 10, params: { selector: '#next' } },
    frameSnapshot('before@call@2', 'http://x/home', 10),
    { type: 'before', callId: 'call@3', pageId: page, method: 'click', startTime: 40, params: { selector: '#menu' } },
    frameSnapshot('before@call@3', 'http://x/next', 40),
    { type: 'after', callId: 'call@3', endTime: 41 },
    { type: 'after', callId: 'call@2', endTime: 50 },
    frameSnapshot('after@call@2', 'http://x/third', 50),
  ], [
    { url: '/next', at: 35, type: 'text/html' },
    { url: '/api/next', at: 37, type: 'application/json' },
    { url: '/third', at: 45, type: 'text/html' },
  ]))), ['open /home', 'press /home', 'open /next', 'GET /api/next 200', 'press /next', 'open /third']);
});

test('a request the browser marks as not a document stays and does not open the page, even on the page path answered 304', () => {
  assert.deepEqual(clickTrace([
    { url: '/next', at: 12, status: 304, type: '', dest: 'empty' },
    { url: '/api/next', at: 15, type: 'application/json', dest: 'empty' },
  ]), ['open /home', 'press /home', 'GET /next 304', 'GET /api/next 200', 'open /next']);
});

test('without the browser\'s mark, a GET of a page the test had open that got no response or a redirect is a page load, not a call', () => {
  assert.deepEqual(clickTrace([
    { url: '/next', at: 12, status: -1, type: 'x-unknown' },
    { url: '/next', at: 13, type: 'text/html' },
    { url: '/api/next', at: 14, type: 'application/json' },
  ]), ['open /home', 'press /home', 'open /next', 'GET /api/next 200']);
});

test('a press is not opened at a request for the same path on another origin', () => {
  assert.deepEqual(clickTrace([
    { url: 'http://x:8080/next', at: 12, type: 'application/json' },
  ]), ['open /home', 'press /home', 'GET /next 200', 'open /next']);
});

test('a press that only changes the part after # opens when the press ends, even when the page path was asked for meanwhile', () => {
  assert.deepEqual(clickTrace([
    { url: '/', at: 12, type: 'application/json' },
  ], 'http://x/#/next', 'http://x/#/home'), ['open /#/home', 'press /#/home', 'GET / 200', 'open /#/next']);
});

const SHOWN = path.join(import.meta.dirname, 'fixtures/app/results/playwright-steps/test-results/steps-shows-the-screen-after-each-step-chromium/trace.zip');

test('the walk gives each step the first screen picture taken after it ended and a page opened at an address the last one before the next step acts, so a click that moved the page shows the page it moved to, and leaves the picture off a line that would repeat the one before', () => {
  const shots = walkOf(SHOWN).map((line) => (line.kind === 'request' ? `${line.method} ${line.url}` : `${line.kind} ${line.url} ${line.shot?.slice(-18) ?? '-'}`));
  assert.deepEqual(shots, [
    'open /home 1793237455323.jpeg',
    'write /home 1793237455338.jpeg',
    'press /home 1793237455389.jpeg',
    'GET /api/v1/document/list',
    'open /document/draft -',
  ]);
});

test('copyShots writes the named screen pictures of a trace into a folder and skips a name the trace does not hold', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-shots-'));
  try {
    const named = (readTrace(SHOWN) as Traced).walk.flatMap((line) => (line.kind !== 'request' && line.shot ? [line.shot] : []));
    copyShots(SHOWN, [...named, 'page@none-1.jpeg'], dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), named.toSorted());
    for (const name of named) assert.deepEqual([...fs.readFileSync(path.join(dir, name)).subarray(0, 2)], [0xff, 0xd8]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a step on a page that has no screen picture yet, as the first action in a popup, is marked as having none, apart from a line whose picture is the one before, and the page it came from shows its picture again', () => {
  const act = (callId: string, pageId: string, method: string, startTime: number, endTime: number, params = {}) => [
    { type: 'before', callId, pageId, method, startTime, params },
    { type: 'after', callId, endTime },
  ];
  const lines = inTempDir((dir) => walkOf(traceZip(dir, [
    ...act('1', 'p', 'goto', 10, 20), frameSnapshot('after@1', 'http://x/home', 20),
    ...act('2', 'q', 'fill', 30, 40, { selector: 'internal:label="메모"', value: 'a' }),
    frameSnapshot('before@2', 'http://x/pop', 30), frameSnapshot('after@2', 'http://x/pop', 40),
    ...act('3', 'q', 'click', 50, 60), frameSnapshot('before@3', 'http://x/pop', 50), frameSnapshot('after@3', 'http://x/pop', 60),
    ...act('4', 'p', 'click', 70, 80), frameSnapshot('before@4', 'http://x/home', 70), frameSnapshot('after@4', 'http://x/home', 80),
    { type: 'screencast-frame', pageId: 'p', sha1: 'home.jpeg', timestamp: 22 },
  ], [], { 'resources/home.jpeg': 'h' })));
  assert.deepEqual(lines.map((line) => (line.kind === 'request' ? line.url : `${line.kind} ${line.url} ${'shot' in line ? line.shot : 'same'}`)), [
    'open /home home.jpeg',
    'open /pop null',
    'write /pop same',
    'press /pop same',
    'press /home home.jpeg',
  ]);
});

test('a page first seen when the next action starts shows the picture from when it was seen, and that action keeps the picture after it', () => {
  const act = (callId: string, method: string, startTime: number, endTime: number, params = {}) => [
    { type: 'before', callId, pageId: 'p', method, startTime, params },
    { type: 'after', callId, endTime },
  ];
  const frame = (name: string, timestamp: number) => ({ type: 'screencast-frame', pageId: 'p', sha1: name, timestamp });
  const lines = inTempDir((dir) => walkOf(traceZip(dir, [
    ...act('1', 'goto', 10, 20), frameSnapshot('after@1', 'http://x/home', 20),
    ...act('2', 'click', 30, 40), frameSnapshot('before@2', 'http://x/home', 30), frameSnapshot('after@2', 'http://x/home', 40),
    ...act('3', 'fill', 50, 60, { selector: 'internal:label="메모"', value: 'a' }),
    frameSnapshot('before@3', 'http://x/new', 50), frameSnapshot('input@3', 'http://x/new', 55), frameSnapshot('after@3', 'http://x/new', 60),
    frame('home.jpeg', 22), frame('new.jpeg', 45), frame('filled.jpeg', 62),
  ], [], { 'resources/home.jpeg': 'h', 'resources/new.jpeg': 'n', 'resources/filled.jpeg': 'f' })));
  assert.deepEqual(lines.map((line) => (line.kind === 'request' ? line.url : `${line.kind} ${line.url} ${line.shot ?? '-'}`)), [
    'open /home home.jpeg',
    'press /home new.jpeg',
    'open /new -',
    'write /new filled.jpeg',
  ]);
});

test('a page opened at an address shows the last picture before the next step on it acts, not the blank one taken as it loaded, and keeps the old picture when none comes before that', () => {
  const act = (callId: string, method: string, startTime: number, endTime: number, params = {}) => [
    { type: 'before', callId, pageId: 'p', method, startTime, params },
    { type: 'after', callId, endTime },
  ];
  const frame = (name: string, timestamp: number) => ({ type: 'screencast-frame', pageId: 'p', sha1: name, timestamp });
  const lines = inTempDir((dir) => walkOf(traceZip(dir, [
    ...act('1', 'goto', 10, 20), frameSnapshot('after@1', 'http://x/home', 20),
    ...act('2', 'fill', 30, 50, { selector: 'internal:label="메모"', value: 'a' }),
    frameSnapshot('before@2', 'http://x/home', 30), frameSnapshot('input@2', 'http://x/home', 40), frameSnapshot('after@2', 'http://x/home', 50),
    ...act('3', 'goto', 60, 70), frameSnapshot('after@3', 'http://x/next', 70),
    ...act('4', 'click', 72, 90),
    frameSnapshot('before@4', 'http://x/next', 72), frameSnapshot('input@4', 'http://x/next', 74), frameSnapshot('after@4', 'http://x/next', 90),
    frame('blank.jpeg', 21), frame('drawn.jpeg', 35), frame('filled.jpeg', 45), frame('next.jpeg', 80),
  ], [], { 'resources/blank.jpeg': 'b', 'resources/drawn.jpeg': 'd', 'resources/filled.jpeg': 'f', 'resources/next.jpeg': 'n' })));
  assert.deepEqual(lines.map((line) => (line.kind === 'request' ? line.url : `${line.kind} ${line.url} ${line.shot ?? '-'}`)), [
    'open /home drawn.jpeg',
    'write /home filled.jpeg',
    'open /next next.jpeg',
    'press /next -',
  ]);
});

test('a page opened at an address keeps the first picture after the move when the app moved it to another address before the next step, and takes the last one before a check ends when a check comes next', () => {
  const act = (callId: string, method: string, startTime: number, endTime: number, params = {}) => [
    { type: 'before', callId, pageId: 'p', method, startTime, params },
    { type: 'after', callId, endTime },
  ];
  const frame = (name: string, timestamp: number) => ({ type: 'screencast-frame', pageId: 'p', sha1: name, timestamp });
  const lines = inTempDir((dir) => walkOf(traceZip(dir, [
    ...act('1', 'goto', 10, 20), frameSnapshot('after@1', 'http://x/login', 20),
    ...act('2', 'fill', 30, 50, { selector: 'internal:label="메모"', value: 'a' }),
    frameSnapshot('before@2', 'http://x/home', 30), frameSnapshot('input@2', 'http://x/home', 40), frameSnapshot('after@2', 'http://x/home', 50),
    ...act('3', 'goto', 60, 70), frameSnapshot('after@3', 'http://x/list', 70),
    ...act('4', 'expect', 72, 90), frameSnapshot('before@4', 'http://x/list', 72), frameSnapshot('after@4', 'http://x/list', 90),
    frame('login.jpeg', 22), frame('home.jpeg', 25), frame('filled.jpeg', 45), frame('empty.jpeg', 71), frame('rows.jpeg', 85),
  ], [], { 'resources/login.jpeg': 'l', 'resources/home.jpeg': 'h', 'resources/filled.jpeg': 'f', 'resources/empty.jpeg': 'e', 'resources/rows.jpeg': 'r' })));
  assert.deepEqual(lines.map((line) => (line.kind === 'request' ? line.url : `${line.kind} ${line.url} ${line.shot ?? '-'}`)), [
    'open /login login.jpeg',
    'open /home home.jpeg',
    'write /home filled.jpeg',
    'open /list rows.jpeg',
    'assert /list -',
  ]);
});
