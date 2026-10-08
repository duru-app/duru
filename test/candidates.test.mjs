import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptCandidate, discardCandidate, storyCandidates } from '../src/candidates.ts';
import { loadConfig } from '../src/config.mjs';
import { buildMap } from '../src/map.mjs';
import { editStory, loadStories } from '../src/stories.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const EXAMPLE_STORIES = path.join(FIXTURE, 'example-stories');
const EXAMPLE_VISITS = path.join(FIXTURE, 'example-visits');
const config = loadConfig(path.join(FIXTURE, 'config.json'));
const map = await buildMap(config);

const shape = (c) => ({ name: c.name, screens: c.screens, source: c.source, stepRanges: c.stepRanges });

function withFolder(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const withStoryCopy = (fn) => withFolder({}, (dir) => {
  fs.cpSync(EXAMPLE_STORIES, dir, { recursive: true });
  return fn(dir);
});

const candidatesOf = (patch, onMap = map, mapFile = path.join(config.outDir, 'map.json')) => storyCandidates({ ...config, visitRecords: [EXAMPLE_VISITS], storiesDir: EXAMPLE_STORIES, ...patch }, onMap, mapFile);
const recordsIn = (records) => Object.fromEntries(Object.entries(records).map(([name, steps]) => [name, steps.map((url) => ({ url }))]));

test('visit record sources default to none and are read as paths relative to the config file', () => {
  assert.deepEqual(config.visitRecords, []);
  withFolder({ 'config.json': { srcRoot: 'src', serverEndpoints: [], visitRecords: ['records', 'one.json'] } }, (dir) => {
    assert.deepEqual(loadConfig(path.join(dir, 'config.json')).visitRecords, [path.join(dir, 'records'), path.join(dir, 'one.json')]);
  });
  for (const visitRecords of ['records', [''], [3]]) {
    withFolder({ 'config.json': { srcRoot: 'src', serverEndpoints: [], visitRecords } }, (dir) => {
      assert.throws(() => loadConfig(path.join(dir, 'config.json')), /visitRecords must be a list of record files or folders/);
    });
  }
});

test('the example visit records give one candidate per record, with steps on the same screen merged, a step without a url passed over, queries and hashes dropped, addresses off the map kept, and a record whose screens equal an existing story left out', () => {
  const { list, notices } = candidatesOf();
  assert.deepEqual(list.map(shape), [
    {
      name: 'open-help',
      screens: ['/signin#SignIn', '/home#Home', '/beta/inbox', '/help#Help'],
      source: { record: 'example-visits/open-help.json', steps: [1, 5] },
      stepRanges: [[1, 1], [2, 2], [3, 4], [5, 5]],
    },
    {
      name: 'publish-document',
      screens: ['/home#Home', '/document/:tab_draft_done_#DocumentList', '/document/:id#DocumentDetail', '/help#Help'],
      source: { record: 'example-visits/publish-document.json', steps: [1, 7] },
      stepRanges: [[1, 2], [3, 3], [4, 5], [7, 7]],
    },
  ]);
  assert.deepEqual(notices, [{ file: 'example-visits/broken-record.json', reason: '2 번째 단계의 url 을 읽지 못했습니다' }]);
});

test('a candidate is checked against the map like a story, and an address off the map shows as a screen the map does not have', () => {
  const { list } = candidatesOf();
  const help = list.find((c) => c.name === 'open-help');
  assert.deepEqual(help.links.map((l) => l.verdict), ['open', 'off-map', 'off-map']);
  assert.equal(help.detached, true);
  const publish = list.find((c) => c.name === 'publish-document');
  assert.deepEqual(publish.links.map((l) => l.verdict), ['open', 'open', 'conditioned']);
  assert.equal(publish.detached, false);
});

test('an address picks the first screen in map order whose route path matches the whole path, with variables matching one segment and their own pattern, a trailing slash and any letter case', () => {
  const records = recordsIn({
    'a.json': ['/document/done/', '/HOME', '/document/other', '/document/7/edit', '/document'],
  });
  withFolder(records, (dir) => {
    const { list } = candidatesOf({ visitRecords: [dir], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => c.screens), [[
      '/document/:tab_draft_done_#DocumentList', '/home#Home', '/document/:id#DocumentDetail', '/document/7/edit', '/document',
    ]]);
  });
});

test('a record source may be a single file or a folder searched for .json files, and a source that does not exist is noted', () => {
  withFolder({ 'one.json': [{ url: '/home' }, { url: '/lab' }], 'more/deep/two.json': [{ url: '/help' }], 'more/notes.txt': 'x' }, (dir) => {
    const { list, notices } = candidatesOf({ configDir: dir, visitRecords: [path.join(dir, 'one.json'), path.join(dir, 'more'), path.join(dir, 'gone')], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => [c.name, c.source.record]), [['two', 'more/deep/two.json'], ['one', 'one.json']]);
    assert.deepEqual(notices, [{ file: 'gone', reason: '방문 기록 출처가 없습니다' }]);
  });
});

for (const [name, body, reason] of [
  ['text that is not JSON', '{', /^JSON 으로 읽지 못했습니다: /],
  ['an object without steps', { url: '/home' }, /^단계 배열이거나, steps 에 단계 배열을 담은 객체여야 합니다$/],
  ['no steps', { steps: [] }, /^단계가 없습니다$/],
  ['only steps without a url', [{ action: 'open' }, { action: 'click', url: null }], /^url 이 있는 단계가 없습니다$/],
  ['a step that is not an object', ['/home'], /^1 번째 단계는 객체여야 합니다$/],
  ['a url that is not text', [{ url: '/home' }, { url: 42 }], /^2 번째 단계의 url 이 문자열이 아니거나 비어 있습니다$/],
  ['an empty address', [{ url: '/home' }, { url: '' }], /^2 번째 단계의 url 이 문자열이 아니거나 비어 있습니다$/],
  ['an address that cannot be read', [{ url: 'http://' }], /^1 번째 단계의 url 을 읽지 못했습니다$/],
  ['an address that is only a query or a hash', [{ url: '/home' }, { url: '?tab=2' }], /^2 번째 단계의 url 을 읽지 못했습니다$/],
]) {
  test(`a visit record with ${name} is noted with its file and why, and the other records still give candidates`, () => {
    withFolder({ 'bad.json': body, 'good.json': [{ url: '/home' }] }, (dir) => {
      const { list, notices } = candidatesOf({ configDir: dir, visitRecords: [dir], storiesDir: path.join(dir, 'stories') });
      assert.deepEqual(list.map((c) => c.name), ['good']);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].file, 'bad.json');
      assert.match(notices[0].reason, reason);
    });
  });
}

test('a step without a url is passed over wherever it sits, keeps its step number, and does not split steps on the same screen', () => {
  withFolder({
    'edges.json': [{ action: 'start' }, { url: '/home' }, { url: '/home?x=1' }, { action: 'end', url: null }],
    'middle.json': [{ url: '/lab' }, { action: 'note', rows: 3 }, { url: '/lab?run=1' }, { url: '/home' }],
  }, (dir) => {
    const { list, notices } = candidatesOf({ configDir: dir, visitRecords: [dir], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(notices, []);
    assert.deepEqual(list.map(shape), [
      { name: 'edges', screens: ['/home#Home'], source: { record: 'edges.json', steps: [1, 4] }, stepRanges: [[2, 3]] },
      { name: 'middle', screens: ['/lab#Lab', '/home#Home'], source: { record: 'middle.json', steps: [1, 4] }, stepRanges: [[1, 3], [4, 4]] },
    ]);
  });
});

test('of two records with the same screens only the first in path order is a candidate', () => {
  withFolder(recordsIn({ 'b.json': ['/home', '/lab'], 'a.json': ['/home', '/home?x=1', '/lab'] }), (dir) => {
    const { list } = candidatesOf({ configDir: dir, visitRecords: [dir], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => c.name), ['a']);
  });
});

test('accepting a candidate writes a story file with the given ID and name, its screens and source, that reads back as a story and is no longer a candidate', () => {
  withStoryCopy((dir) => {
    const before = candidatesOf({ storiesDir: dir }).list;
    const help = before.find((c) => c.name === 'open-help');
    const story = acceptCandidate(dir, help, { id: 'open-help', name: '홈에서 도움말을 연다', author: 'reviewer' }, new Date('2026-10-03T01:02:03Z'));
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'open-help.json'), 'utf8'));
    assert.deepEqual(written, {
      name: '홈에서 도움말을 연다',
      screens: ['/signin#SignIn', '/home#Home', '/beta/inbox', '/help#Help'],
      memo: '',
      author: 'reviewer',
      date: '2026-10-03T01:02:03.000Z',
      source: { record: 'example-visits/open-help.json', steps: [1, 5] },
    });
    assert.equal(story.id, 'open-help');
    const read = loadStories(dir);
    assert.deepEqual(read.notices.map((n) => n.file), ['lab-shortcut.json']);
    assert.deepEqual(read.stories.find((s) => s.id === 'open-help').source, { record: 'example-visits/open-help.json', steps: [1, 5] });
    assert.deepEqual(candidatesOf({ storiesDir: dir }).list.map((c) => c.name), ['publish-document']);
  });
});

test('accepting a candidate needs an ID within the story ID rule that no story file uses yet, a name and an author, and writes nothing otherwise', () => {
  withStoryCopy((dir) => {
    const [candidate] = candidatesOf({ storiesDir: dir }).list;
    const before = fs.readdirSync(dir, { recursive: true }).sort();
    const accept = (input) => () => acceptCandidate(dir, candidate, { id: 'new-one', name: '이름', author: 'reviewer', ...input });
    assert.throws(accept({ id: 'New One' }), /스토리 ID 는 영문 소문자 · 숫자 · - · _ 로만 씁니다/);
    assert.throws(accept({ id: 'run-lab' }), /스토리 ID run-lab 는 run-lab\.json 이 이미 씁니다/);
    assert.throws(accept({ id: 'lab-shortcut' }), /스토리 ID lab-shortcut 는 lab-shortcut\.json 이 이미 씁니다/);
    assert.throws(accept({ name: '  ' }), /스토리 이름이 필요합니다/);
    assert.throws(accept({ author: '' }), /작성자가 필요합니다/);
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
  });
});

test('discarding a candidate writes a file of its own into the discarded folder of the stories folder, never over another, which is not read as a story and keeps that screen order from coming back', () => {
  withStoryCopy((dir) => {
    const help = candidatesOf({ storiesDir: dir }).list.find((c) => c.name === 'open-help');
    const now = new Date('2026-10-03T01:02:03Z');
    discardCandidate(dir, help, { reason: '베타 받은편지함은 맵의 클라이언트에 없다', author: 'reviewer' }, now);
    discardCandidate(dir, help, { reason: '다시 버림', author: 'reviewer' }, now);
    const files = fs.readdirSync(path.join(dir, 'discarded')).sort();
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => /^2026-10-03-reviewer-[0-9a-f]{8}\.json$/.test(f)));
    const saved = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'discarded', f), 'utf8')));
    assert.deepEqual(saved.map((d) => d.reason).sort(), ['다시 버림', '베타 받은편지함은 맵의 클라이언트에 없다']);
    assert.deepEqual(saved[0], {
      name: 'open-help',
      screens: ['/signin#SignIn', '/home#Home', '/beta/inbox', '/help#Help'],
      reason: saved[0].reason,
      author: 'reviewer',
      date: '2026-10-03T01:02:03.000Z',
      source: { record: 'example-visits/open-help.json', steps: [1, 5] },
    });
    assert.deepEqual(loadStories(dir).notices.map((n) => n.file), ['lab-shortcut.json']);
    assert.deepEqual(candidatesOf({ storiesDir: dir }).list.map((c) => c.name), ['publish-document']);
    assert.throws(() => discardCandidate(dir, help, { reason: ' ', author: 'reviewer' }), /버리는 까닭이 필요합니다/);
    assert.throws(() => discardCandidate(dir, help, { reason: 'x', author: '' }), /작성자가 필요합니다/);
  });
});

test('a discarded candidate file that cannot be read is noted with the candidates and does not keep anything out', () => {
  withStoryCopy((dir) => {
    fs.mkdirSync(path.join(dir, 'discarded'));
    fs.writeFileSync(path.join(dir, 'discarded', 'bad.json'), JSON.stringify({ screens: ['/home#Home'], author: 'a', date: '2026-10-03' }));
    const { list, notices } = candidatesOf({ storiesDir: dir });
    assert.equal(list.length, 2);
    assert.deepEqual(notices.map((n) => [n.file, n.reason]), [
      ['example-visits/broken-record.json', '2 번째 단계의 url 을 읽지 못했습니다'],
      [path.relative(FIXTURE, path.join(dir, 'discarded/bad.json')), 'reason 에 버린 까닭을 적어야 합니다'],
    ]);
  });
});

test('editing a story rewrites the name and memo of its file and leaves the rest as it was', () => {
  withStoryCopy((dir) => {
    editStory(dir, 'run-lab', { name: '실험실 결과를 본다', memo: '' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'run-lab.json'), 'utf8')), {
      name: '실험실 결과를 본다',
      screens: ['/home#Home', '/lab#Lab', '/lab/result#LabResult'],
      memo: '',
      author: 'Kim Min',
      date: '2026-10-01',
    });
    assert.throws(() => editStory(dir, 'run-lab', { name: ' ', memo: '' }), /스토리 이름이 필요합니다/);
    assert.throws(() => editStory(dir, 'lab-shortcut', { name: 'x', memo: '' }), /스토리 lab-shortcut 를 찾지 못했습니다/);
    assert.throws(() => editStory(dir, 'run-lab', { name: 'x', memo: 3 }), /메모는 글자여야 합니다/);
  });
});

test('with a single story file for storiesDir, accepting and discarding a candidate are refused and write nothing', () => {
  withStoryCopy((dir) => {
    const file = path.join(dir, 'run-lab.json');
    const [candidate] = candidatesOf({ storiesDir: file }).list;
    const before = fs.readdirSync(dir).sort();
    assert.throws(() => acceptCandidate(file, candidate, { id: 'new-one', name: '이름', author: 'a' }), /가 파일이라 새 파일을 쓸 수 없습니다/);
    assert.throws(() => discardCandidate(file, candidate, { reason: 'x', author: 'a' }), /가 파일이라 새 파일을 쓸 수 없습니다/);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  });
});

test('a discarded entry in the stories folder that is a file, or a discarded folder that cannot be listed, is noted with the candidates instead of throwing', (t) => {
  withStoryCopy((dir) => {
    fs.writeFileSync(path.join(dir, 'discarded'), 'not a folder');
    const { list, notices } = candidatesOf({ storiesDir: dir });
    assert.equal(list.length, 2);
    assert.deepEqual(notices.at(-1), { file: path.relative(FIXTURE, path.join(dir, 'discarded')), reason: 'discarded 는 버린 후보를 담는 폴더여야 합니다' });
    assert.throws(() => discardCandidate(dir, list[0], { reason: 'x', author: 'a' }), /^Error: 스토리 폴더 안 discarded 가 파일이라 버린 후보를 쓸 수 없습니다$/);
    assert.equal(fs.readFileSync(path.join(dir, 'discarded'), 'utf8'), 'not a folder');
  });
  withStoryCopy((dir) => {
    const folder = path.join(dir, 'discarded');
    fs.mkdirSync(folder);
    fs.chmodSync(folder, 0o000);
    try {
      try {
        fs.readdirSync(folder);
        return t.skip('this user or file system can list a folder without read permission');
      } catch {}
      const { notices } = candidatesOf({ storiesDir: dir });
      assert.equal(notices.at(-1).file, path.relative(FIXTURE, folder));
      assert.match(notices.at(-1).reason, /^버린 후보 폴더를 읽지 못했습니다: EACCES/);
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });
});

test('with a map built before links carried their conditions, visit records give no candidate and a request to rebuild, while without records there is no such request', () => {
  const stale = structuredClone(map);
  for (const s of stale.screens) for (const l of s.links) delete l.conditions;
  withFolder({}, (dir) => {
    const empty = { storiesDir: path.join(dir, 'stories') };
    const withRecords = candidatesOf(empty, stale, path.join(dir, 'map.json'));
    assert.deepEqual(withRecords.list, []);
    assert.equal(withRecords.stale, `${path.join(dir, 'map.json')} 은 링크에 조건이 없는 예전 duru 로 만든 맵이라 후보를 맞춰 보지 못했습니다. duru rebuild 로 맵을 다시 만드세요`);
    assert.equal(candidatesOf({ ...empty, visitRecords: [] }, stale).stale, undefined);
  });
});
