import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptCandidate, discardCandidate, storeCandidates, storyCandidates, unacceptStory, undiscardCandidate } from '../src/candidates.ts';
import { compare, loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import { editStory, loadStories, writeStorySteps } from '../src/stories.ts';
import type { StepInput } from '../src/stories.ts';
import { linkTests } from '../src/test-links.ts';
import { traceLinker } from '../src/trace-links.ts';

type Candidate = Parameters<typeof acceptCandidate>[1];

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const EXAMPLE_STORIES = path.join(FIXTURE, 'example-stories');
const EXAMPLE_VISITS = path.join(FIXTURE, 'example-visits');
const config = loadConfig(path.join(FIXTURE, 'config.json'));
const map = await buildMap(config);

const shape = (c: Candidate) => ({ name: c.name, screens: c.screens, source: c.source, stepRanges: c.stepRanges });

function withFolder(files: Record<string, unknown>, fn: (dir: string) => void) {
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

const withStoryCopy = (fn: (dir: string) => void) => withFolder({}, (dir: string) => {
  fs.cpSync(EXAMPLE_STORIES, dir, { recursive: true });
  return fn(dir);
});

const candidatesOf = (patch: Record<string, unknown> = {}, onMap: object = map, mapFile = path.join(config.outDir, 'map.json')) => storyCandidates({ ...config, visitRecords: [EXAMPLE_VISITS], storiesDir: EXAMPLE_STORIES, ...patch }, onMap, mapFile);
const recordsIn = (records: Record<string, string[]>) => Object.fromEntries(Object.entries(records).map(([name, steps]) => [name, steps.map((url: string) => ({ url }))]));

test('visit record sources default to none and are read as paths relative to the config file', () => {
  assert.deepEqual(config.visitRecords, []);
  withFolder({ 'config.json': { srcRoot: 'src', serverEndpoints: [], visitRecords: ['records', 'one.json'] } }, (dir: string) => {
    assert.deepEqual(loadConfig(path.join(dir, 'config.json')).visitRecords, [path.join(dir, 'records'), path.join(dir, 'one.json')]);
  });
  for (const visitRecords of ['records', [''], [3]]) {
    withFolder({ 'config.json': { srcRoot: 'src', serverEndpoints: [], visitRecords } }, (dir: string) => {
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
      screens: ['/home#Home', '/document/:tab#DocumentList', '/document/:id#DocumentDetail', '/help#Help'],
      source: { record: 'example-visits/publish-document.json', steps: [1, 7] },
      stepRanges: [[1, 2], [3, 3], [4, 5], [7, 7]],
    },
  ]);
  assert.deepEqual(notices, [{ file: 'example-visits/broken-record.json', reason: '2 번째 단계의 url 을 읽지 못했습니다' }]);
});

test('a candidate is checked against the map like a story, and an address off the map shows as a screen the map does not have', () => {
  const { list } = candidatesOf();
  const help = list.find((c) => c.name === 'open-help')!;
  assert.deepEqual(help.links.map((l) => l.verdict), ['open', 'off-map', 'off-map']);
  assert.equal(help.detached, true);
  const publish = list.find((c) => c.name === 'publish-document')!;
  assert.deepEqual(publish.links.map((l) => l.verdict), ['open', 'open', 'conditioned']);
  assert.equal(publish.detached, false);
});

test('an address picks the first screen in map order whose route path matches the whole path, with variables matching one segment and their own pattern, a trailing slash and any letter case', () => {
  const records = recordsIn({
    'a.json': ['/document/done/', '/HOME', '/document/other', '/document/7/edit', '/document'],
  });
  withFolder(records, (dir: string) => {
    const { list } = candidatesOf({ visitRecords: [dir], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => c.screens), [[
      '/document/:tab#DocumentList', '/home#Home', '/document/:id#DocumentDetail', '/document/7/edit', '/document',
    ]]);
  });
});

test('a record source may be a single file or a folder searched for .json files, and a source that does not exist is noted', () => {
  withFolder({ 'one.json': [{ url: '/home' }, { url: '/lab' }], 'more/deep/two.json': [{ url: '/help' }], 'more/notes.txt': 'x' }, (dir: string) => {
    const { list, notices } = candidatesOf({ configDir: dir, visitRecords: [path.join(dir, 'one.json'), path.join(dir, 'more'), path.join(dir, 'gone')], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => [c.name, (c.source as { record: string }).record]), [['two', 'more/deep/two.json'], ['one', 'one.json']]);
    assert.deepEqual(notices, [{ file: 'gone', reason: '방문 기록 출처가 없습니다' }]);
  });
});

for (const [name, body, reason] of ([
  ['text that is not JSON', '{', /^JSON 으로 읽지 못했습니다: /],
  ['an object without steps', { url: '/home' }, /^단계 배열이거나, steps 에 단계 배열을 담은 객체여야 합니다$/],
  ['no steps', { steps: [] }, /^단계가 없습니다$/],
  ['only steps without a url', [{ action: 'open' }, { action: 'click', url: null }], /^url 이 있는 단계가 없습니다$/],
  ['a step that is not an object', ['/home'], /^1 번째 단계는 객체여야 합니다$/],
  ['a url that is not text', [{ url: '/home' }, { url: 42 }], /^2 번째 단계의 url 이 문자열이 아니거나 비어 있습니다$/],
  ['an empty address', [{ url: '/home' }, { url: '' }], /^2 번째 단계의 url 이 문자열이 아니거나 비어 있습니다$/],
  ['an address that cannot be read', [{ url: 'http://' }], /^1 번째 단계의 url 을 읽지 못했습니다$/],
  ['an address that is only a query or a hash', [{ url: '/home' }, { url: '?tab=2' }], /^2 번째 단계의 url 을 읽지 못했습니다$/],
] as [string, unknown, RegExp][])) {
  test(`a visit record with ${name} is noted with its file and why, and the other records still give candidates`, () => {
    withFolder({ 'bad.json': body, 'good.json': [{ url: '/home' }] }, (dir: string) => {
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
  }, (dir: string) => {
    const { list, notices } = candidatesOf({ configDir: dir, visitRecords: [dir], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(notices, []);
    assert.deepEqual(list.map(shape), [
      { name: 'edges', screens: ['/home#Home'], source: { record: 'edges.json', steps: [1, 4] }, stepRanges: [[2, 3]] },
      { name: 'middle', screens: ['/lab#Lab', '/home#Home'], source: { record: 'middle.json', steps: [1, 4] }, stepRanges: [[1, 3], [4, 4]] },
    ]);
  });
});

test('of two records with the same screens only the first in path order is a candidate', () => {
  withFolder(recordsIn({ 'b.json': ['/home', '/lab'], 'a.json': ['/home', '/home?x=1', '/lab'] }), (dir: string) => {
    const { list } = candidatesOf({ configDir: dir, visitRecords: [dir], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => c.name), ['a']);
  });
});

test('accepting a candidate writes a story file with the given ID and name, its screens and source, that reads back as a story and is no longer a candidate', () => {
  withStoryCopy((dir: string) => {
    const before = candidatesOf({ storiesDir: dir }).list;
    const help = before.find((c) => c.name === 'open-help')!;
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
    assert.deepEqual(read.stories.find((s) => s.id === 'open-help')!.source, { record: 'example-visits/open-help.json', steps: [1, 5] });
    assert.deepEqual(candidatesOf({ storiesDir: dir }).list.map((c) => c.name), ['publish-document']);
  });
});

test('a story accepted from a candidate keeps that candidate away after a step is taken out of its order', () => {
  withStoryCopy((dir: string) => {
    const help = candidatesOf({ storiesDir: dir }).list.find((c) => c.name === 'open-help')!;
    acceptCandidate(dir, help, { id: 'open-help', name: '홈에서 도움말을 연다', author: 'reviewer' }, new Date('2026-10-03T01:02:03Z'));
    const story = loadStories(dir).stories.find((s) => s.id === 'open-help')!;
    writeStorySteps(dir, 'open-help', { steps: [{ step: 1, screen: '/signin#SignIn' }, { step: 2, screen: '/home#Home' }, { step: 4, screen: '/help#Help' }], contentHash: story.contentHash });
    assert.deepEqual(loadStories(dir).stories.find((s) => s.id === 'open-help')!.screens, ['/signin#SignIn', '/home#Home', '/help#Help']);
    assert.deepEqual(candidatesOf({ storiesDir: dir }).list.map((c) => c.name), ['publish-document']);
  });
});

test('a story whose steps are objects with needs and expects keeps its screen order from being a candidate, like the same story with screen IDs', () => {
  withStoryCopy((dir: string) => {
    const screens = ['/signin#SignIn', '/home#Home', '/beta/inbox', '/help#Help'];
    fs.writeFileSync(path.join(dir, 'open-help.json'), JSON.stringify({
      name: '홈에서 도움말을 연다',
      needs: ['로그인할 계정이 있다'],
      screens: [screens[0], { screen: screens[1], expects: ['홈이 보인다'] }, screens[2], { screen: screens[3] }],
      author: 'reviewer',
      date: '2026-10-03',
    }));
    const { list, gone } = candidatesOf({ storiesDir: dir });
    assert.deepEqual(list.map((c) => c.name), ['publish-document']);
    assert.equal(gone![screens.join(' > ')], 'open-help');
  });
});

test('accepting a candidate needs an ID within the story ID rule that no story file uses yet, a name and an author, and writes nothing otherwise', () => {
  withStoryCopy((dir: string) => {
    const [candidate] = candidatesOf({ storiesDir: dir }).list;
    const before = fs.readdirSync(dir, { recursive: true }).sort();
    const accept = (input: Record<string, unknown>) => () => acceptCandidate(dir, candidate, { id: 'new-one', name: '이름', author: 'reviewer', ...input });
    assert.throws(accept({ id: 'New One' }), /스토리 ID 는 영문 소문자 · 숫자 · - · _ 로만 씁니다/);
    assert.throws(accept({ id: 'run-lab' }), /스토리 ID run-lab 는 run-lab\.json 이 이미 씁니다/);
    assert.throws(accept({ id: 'lab-shortcut' }), /스토리 ID lab-shortcut 는 lab-shortcut\.json 이 이미 씁니다/);
    assert.throws(accept({ name: '  ' }), /스토리 이름이 필요합니다/);
    assert.throws(accept({ author: '' }), /작성자가 필요합니다/);
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
  });
});

test('discarding a candidate writes a file of its own into the discarded folder of the stories folder, never over another, which is not read as a story and keeps that screen order from coming back', () => {
  withStoryCopy((dir: string) => {
    const help = candidatesOf({ storiesDir: dir }).list.find((c) => c.name === 'open-help')!;
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
    assert.throws(() => discardCandidate(dir, help, { reason: ' ', author: 'reviewer' }), /버리는 이유가 필요합니다/);
    assert.throws(() => discardCandidate(dir, help, { reason: 'x', author: '' }), /작성자가 필요합니다/);
  });
});

test('undoing an accepted candidate removes its story file, after which the candidate is offered again, and a story not accepted from a candidate, an unknown story or a single story file for storiesDir is refused', () => {
  withStoryCopy((dir: string) => {
    const help = candidatesOf({ storiesDir: dir }).list.find((c) => c.name === 'open-help')!;
    acceptCandidate(dir, help, { id: 'open-help', name: '홈에서 도움말을 연다', author: 'reviewer' });
    assert.deepEqual(unacceptStory(dir, 'open-help'), { id: 'open-help', screens: help.screens, file: 'open-help.json' });
    assert.equal(fs.existsSync(path.join(dir, 'open-help.json')), false);
    assert.deepEqual(candidatesOf({ storiesDir: dir }).list.map((c) => c.name), ['open-help', 'publish-document']);
    const before = fs.readdirSync(dir, { recursive: true }).sort();
    assert.throws(() => unacceptStory(dir, 'run-lab'), /스토리 run-lab 는 후보에서 받은 스토리가 아닙니다/);
    assert.throws(() => unacceptStory(dir, 'open-help'), /스토리 open-help 를 찾지 못했습니다/);
    assert.throws(() => unacceptStory(path.join(dir, 'run-lab.json'), 'run-lab'), /가 폴더가 아니라 스토리 파일을 지울 수 없습니다/);
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
  });
});

test('the candidates name each screen order discarded once, by its latest discard, the latest first', () => {
  withStoryCopy((dir: string) => {
    const [help, publish] = ['open-help', 'publish-document'].map((name) => candidatesOf({ storiesDir: dir }).list.find((c) => c.name === name)!);
    discardCandidate(dir, help, { reason: '먼저 버림', author: 'kim' }, new Date('2026-10-01T00:00:00Z'));
    discardCandidate(dir, publish, { reason: '문서 쪽은 따로 본다', author: 'lee' }, new Date('2026-10-02T00:00:00Z'));
    discardCandidate(dir, help, { reason: '다시 버림', author: 'park' }, new Date('2026-10-03T00:00:00Z'));
    const { list, discarded } = candidatesOf({ storiesDir: dir });
    assert.deepEqual(list, []);
    assert.deepEqual(discarded, [
      { name: 'open-help', screens: help.screens, reason: '다시 버림', author: 'park', date: '2026-10-03T00:00:00.000Z' },
      { name: 'publish-document', screens: publish.screens, reason: '문서 쪽은 따로 본다', author: 'lee', date: '2026-10-02T00:00:00.000Z' },
    ]);
  });
});

test('undoing a discard writes an undo record of its own beside the discard, after which the candidate is offered again and leaves the discarded list until discarded again, and a screen order not discarded now or no author is refused', () => {
  withStoryCopy((dir: string) => {
    const help = candidatesOf({ storiesDir: dir }).list.find((c) => c.name === 'open-help')!;
    discardCandidate(dir, help, { reason: '먼저 버림', author: 'kim' }, new Date('2026-10-01T00:00:00Z'));
    const undone = undiscardCandidate(dir, help.screens, { author: 'lee' }, new Date('2026-10-02T00:00:00Z'));
    assert.deepEqual({ ...undone, file: undefined }, { screens: help.screens, kind: 'undo', author: 'lee', date: '2026-10-02T00:00:00.000Z', file: undefined });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, undone.file), 'utf8')), { screens: help.screens, kind: 'undo', author: 'lee', date: '2026-10-02T00:00:00.000Z' });
    assert.equal(fs.readdirSync(path.join(dir, 'discarded')).length, 2);
    const back = candidatesOf({ storiesDir: dir });
    assert.deepEqual(back.list.map((c) => c.name), ['open-help', 'publish-document']);
    assert.deepEqual(back.discarded, []);
    assert.deepEqual(back.notices.map((n) => n.file), ['example-visits/broken-record.json']);

    const before = fs.readdirSync(dir, { recursive: true }).sort();
    assert.throws(() => undiscardCandidate(dir, help.screens, { author: 'lee' }), /버린 후보 \/signin#SignIn > \/home#Home > \/beta\/inbox > \/help#Help 가 없습니다/);
    assert.throws(() => undiscardCandidate(dir, ['/home#Home'], { author: 'lee' }), /버린 후보 \/home#Home 가 없습니다/);
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);

    discardCandidate(dir, help, { reason: '다시 버림', author: 'park' }, new Date('2026-10-03T00:00:00Z'));
    assert.deepEqual(candidatesOf({ storiesDir: dir }).discarded.map((d) => d.reason), ['다시 버림']);
    assert.throws(() => undiscardCandidate(dir, help.screens, { author: ' ' }), /작성자가 필요합니다/);
  });
});

test('a discard undone after its visit record is gone comes back from the candidate file written on undoing, under the name the discard kept', () => {
  withStoryCopy((dir: string) => {
    const help = candidatesOf({ storiesDir: dir }).list.find((c) => c.name === 'open-help')!;
    discardCandidate(dir, help, { reason: '먼저 버림', author: 'kim' }, new Date('2026-10-01T00:00:00Z'));
    undiscardCandidate(dir, help.screens, { author: 'kim' }, new Date('2026-10-02T00:00:00Z'));
    assert.deepEqual(storedIn(dir).map(({ name, screens, source }) => ({ name, screens, source })), [{ name: 'open-help', screens: help.screens, source: help.source }]);
    assert.deepEqual(leftOnlyStored(dir).list.map((c) => [c.key, c.name]), [[help.key, 'open-help']]);
  });
});

test('a hand-written discard record with a kind other than undo is noted with the candidates, while an undo record needs no reason', () => {
  withStoryCopy((dir: string) => {
    fs.mkdirSync(path.join(dir, 'discarded'));
    fs.writeFileSync(path.join(dir, 'discarded', 'restore.json'), JSON.stringify({ screens: ['/home#Home'], kind: 'restore', author: 'a', date: '2026-10-03' }));
    fs.writeFileSync(path.join(dir, 'discarded', 'undo.json'), JSON.stringify({ screens: ['/home#Home', '/help#Help'], kind: 'undo', author: 'a', date: '2026-10-03' }));
    assert.deepEqual(candidatesOf({ storiesDir: dir }).notices.map((n) => [n.file, n.reason]), [
      ['example-visits/broken-record.json', '2 번째 단계의 url 을 읽지 못했습니다'],
      [path.relative(FIXTURE, path.join(dir, 'discarded/restore.json')), 'kind 는 버린 기록이면 적지 않고, 되돌린 기록이면 "undo" 여야 합니다'],
    ]);
  });
});

test('a discarded candidate file that cannot be read is noted with the candidates and does not keep anything out', () => {
  withStoryCopy((dir: string) => {
    fs.mkdirSync(path.join(dir, 'discarded'));
    fs.writeFileSync(path.join(dir, 'discarded', 'bad.json'), JSON.stringify({ screens: ['/home#Home'], author: 'a', date: '2026-10-03' }));
    const { list, notices } = candidatesOf({ storiesDir: dir });
    assert.equal(list.length, 2);
    assert.deepEqual(notices.map((n) => [n.file, n.reason]), [
      ['example-visits/broken-record.json', '2 번째 단계의 url 을 읽지 못했습니다'],
      [path.relative(FIXTURE, path.join(dir, 'discarded/bad.json')), 'reason 에 버린 이유를 적어야 합니다'],
    ]);
  });
});

test('editing a story rewrites the name and memo of its file and leaves the rest as it was', () => {
  withStoryCopy((dir: string) => {
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
  withStoryCopy((dir: string) => {
    const file = path.join(dir, 'run-lab.json');
    const [candidate] = candidatesOf({ storiesDir: file }).list;
    const before = fs.readdirSync(dir).sort();
    assert.throws(() => acceptCandidate(file, candidate, { id: 'new-one', name: '이름', author: 'a' }), /가 파일이라 새 파일을 쓸 수 없습니다/);
    assert.throws(() => discardCandidate(file, candidate, { reason: 'x', author: 'a' }), /가 파일이라 새 파일을 쓸 수 없습니다/);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  });
});

test('a discarded entry in the stories folder that is a file, or a discarded folder that cannot be listed, is noted with the candidates instead of throwing', (t) => {
  withStoryCopy((dir: string) => {
    fs.writeFileSync(path.join(dir, 'discarded'), 'not a folder');
    const { list, notices } = candidatesOf({ storiesDir: dir });
    assert.equal(list.length, 2);
    assert.deepEqual(notices.at(-1), { file: path.relative(FIXTURE, path.join(dir, 'discarded')), reason: 'discarded 는 버린 후보를 담는 폴더여야 합니다' });
    assert.throws(() => discardCandidate(dir, list[0], { reason: 'x', author: 'a' }), /^Error: 스토리 폴더 안 discarded 가 파일이라 버린 후보를 쓸 수 없습니다$/);
    assert.equal(fs.readFileSync(path.join(dir, 'discarded'), 'utf8'), 'not a folder');
  });
  withStoryCopy((dir: string) => {
    const folder = path.join(dir, 'discarded');
    fs.mkdirSync(folder);
    fs.chmodSync(folder, 0o000);
    try {
      try {
        fs.readdirSync(folder);
        return t.skip('this user or file system can list a folder without read permission');
      } catch {}
      const { notices } = candidatesOf({ storiesDir: dir });
      assert.equal(notices.at(-1)!.file, path.relative(FIXTURE, folder));
      assert.match(notices.at(-1)!.reason, /^버린 후보 폴더를 읽지 못했습니다: EACCES/);
    } finally {
      fs.chmodSync(folder, 0o700);
    }
  });
});

const TRACED = { format: 'playwright', path: path.join(FIXTURE, 'results/playwright-traced'), depth: 'ui' };
const HOME_HELP = ['/home#Home', '/help#Help'];
const HOME_DRAFTS = ['/home#Home', '/document/:tab#DocumentList'];
const tracedCandidatesOf = (patch: Record<string, unknown> = {}, onMap: object = map, mapFile = path.join(config.outDir, 'map.json')) => {
  const settings = { ...config, visitRecords: [], storiesDir: EXAMPLE_STORIES, tests: [TRACED], ...patch };
  return storyCandidates(settings, onMap, mapFile, linkTests(settings, map).traced);
};

test('the tests with a trace in the Playwright reports give one candidate per screen order they passed, with steps on the same screen merged, every test that passed that order named in the source with its report, and a test that passed a single screen or whose trace cannot be read left out', () => {
  const { list, notices } = tracedCandidatesOf();
  assert.deepEqual(list.map((c) => ({ name: c.name, screens: c.screens, source: c.source, stepRanges: c.stepRanges })), [
    {
      name: 'opens home and then help',
      screens: HOME_HELP,
      source: {
        report: 'results/playwright-traced/visits.json',
        tests: ['opens home and then help', 'follows a link while waiting for the new address', 'uses the mouse right after the address changes', 'clicks a button that appears after the address changes'],
      },
      stepRanges: undefined,
    },
    {
      name: 'moves to the drafts without loading a page',
      screens: HOME_DRAFTS,
      source: {
        report: 'results/playwright-traced/visits.json',
        tests: ['moves to the drafts without loading a page', 'checks a text that appears after the address changes', 'types into a field and submits with the keyboard'],
      },
      stepRanges: undefined,
    },
  ]);
  assert.deepEqual(notices, []);
});

test('candidates from the visit records come first and keep their own source, and a trace whose screen order a record already gave is not a second candidate', () => {
  assert.deepEqual(tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS] }).list.map((c) => [c.name, c.source]), [
    ['open-help', { record: 'example-visits/open-help.json', steps: [1, 5] }],
    ['publish-document', { record: 'example-visits/publish-document.json', steps: [1, 7] }],
    ['opens home and then help', { report: 'results/playwright-traced/visits.json', tests: ['opens home and then help', 'follows a link while waiting for the new address', 'uses the mouse right after the address changes', 'clicks a button that appears after the address changes'] }],
    ['moves to the drafts without loading a page', { report: 'results/playwright-traced/visits.json', tests: ['moves to the drafts without loading a page', 'checks a text that appears after the address changes', 'types into a field and submits with the keyboard'] }],
  ]);
  withFolder(recordsIn({ 'help.json': ['/home', '/help'] }), (dir: string) => {
    const { list } = tracedCandidatesOf({ visitRecords: [dir], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => c.screens), [HOME_HELP, HOME_DRAFTS]);
    assert.equal(list[0].name, 'help');
  });
});

test('of two reports with tests that passed the same screen order, the candidate names the tests of the first report in path order only', () => {
  withFolder({}, (dir: string) => {
    for (const copy of ['b', 'a']) fs.cpSync(TRACED.path, path.join(dir, copy), { recursive: true });
    const { list } = tracedCandidatesOf({ configDir: dir, tests: [{ ...TRACED, path: dir }], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => [c.screens, (c.source as { report: string }).report]), [[HOME_HELP, 'a/visits.json'], [HOME_DRAFTS, 'a/visits.json']]);
  });
});

test('a candidate from a test whose title carries tags is named by the title without them, so the story name and ID offered from it carry none', () => {
  withFolder({}, (dir: string) => {
    fs.cpSync(TRACED.path, dir, { recursive: true });
    const file = path.join(dir, 'visits.json');
    const report = fs.readFileSync(file, 'utf8').replace('"title": "opens home and then help"', '"title": "opens home and then help @screen:/home#Home @depth:ui @role:ADMIN"');
    fs.writeFileSync(file, report);
    const { list } = tracedCandidatesOf({ configDir: dir, tests: [{ ...TRACED, path: dir }], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => c.name), ['opens home and then help', 'moves to the drafts without loading a page']);
  });
  const traced = [
    { report: 'results/junit/TEST-Doc.xml', title: 'DocTest › 문서를 연다 @screen:/home#Home', screens: HOME_HELP },
    { report: 'results/vitest/unit.json', title: 'drafts › 초안을 연다 @depth:code @screen:/home#Home', screens: HOME_DRAFTS },
    { report: 'results/verdict/check.log', title: '@story:open-help 도움말을 연다', screens: ['/home#Home', '/lab#Lab'] },
  ];
  assert.deepEqual(storyCandidates({ ...config, visitRecords: [], storiesDir: EXAMPLE_STORIES }, map, path.join(config.outDir, 'map.json'), traced).list.map((c) => c.name), [
    'DocTest › 문서를 연다',
    'drafts › 초안을 연다',
    '도움말을 연다',
  ]);
});

test('a candidate from a test whose describe title or own title is only tags is named by the other parts, with no separator left over', () => {
  const traced = [
    { report: 'results/playwright/e2e.json', title: '@smoke › opens help', screens: HOME_HELP },
    { report: 'results/playwright/e2e.json', title: 'Help › @screen:/help#Help @depth:ui', screens: HOME_DRAFTS },
  ];
  assert.deepEqual(storyCandidates({ ...config, visitRecords: [], storiesDir: EXAMPLE_STORIES }, map, path.join(config.outDir, 'map.json'), traced).list.map((c) => c.name), [
    'opens help',
    'Help',
  ]);
});

test('only a test that passed in a run that passed gives a candidate: a failed test with a trace gives none, nor does one expected to fail that passed, and a test that passed on retry gives the screen order of its passing run', () => {
  withFolder({}, (dir: string) => {
    fs.cpSync(TRACED.path, dir, { recursive: true });
    const file = path.join(dir, 'visits.json');
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const testOf = (title: string) => {
      const found: any[] = [];
      const walk = (suite: any) => {
        for (const spec of suite.specs ?? []) if (spec.title === title) found.push(spec.tests[0]);
        for (const child of suite.suites ?? []) walk(child);
      };
      report.suites.forEach(walk);
      return found[0];
    };
    const failed = testOf('opens home and then help');
    Object.assign(failed, { status: 'unexpected', results: [{ ...failed.results[0], status: 'failed' }] });
    const flaky = testOf('moves to the drafts without loading a page');
    Object.assign(flaky, { status: 'flaky', results: [failed.results[0], ...flaky.results] });
    Object.assign(testOf('types into a field and submits with the keyboard'), { status: 'unexpected' });
    fs.writeFileSync(file, JSON.stringify(report));
    const { list } = tracedCandidatesOf({ configDir: dir, tests: [{ ...TRACED, path: dir }], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => [c.screens, (c.source as { tests: string[] }).tests]), [
      [HOME_DRAFTS, ['moves to the drafts without loading a page', 'checks a text that appears after the address changes']],
      [HOME_HELP, ['follows a link while waiting for the new address', 'uses the mouse right after the address changes', 'clicks a button that appears after the address changes']],
    ]);
  });
});

test('a trace candidate accepted becomes a story file with the report and the test titles as its source that reads back as a story, and one discarded or with the screen order of a story is not offered again', () => {
  withStoryCopy((dir: string) => {
    const [help, drafts] = tracedCandidatesOf({ storiesDir: dir }).list;
    acceptCandidate(dir, drafts, { id: 'open-drafts', name: '홈에서 초안을 연다', author: 'reviewer' }, new Date('2026-10-03T01:02:03Z'));
    const source = { report: 'results/playwright-traced/visits.json', tests: ['moves to the drafts without loading a page', 'checks a text that appears after the address changes', 'types into a field and submits with the keyboard'] };
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'open-drafts.json'), 'utf8')).source, source);
    const read = loadStories(dir);
    assert.deepEqual(read.notices.map((n) => n.file), ['lab-shortcut.json']);
    assert.deepEqual(read.stories.find((s) => s.id === 'open-drafts')!.source, source);
    assert.deepEqual(tracedCandidatesOf({ storiesDir: dir }).list.map((c) => c.screens), [HOME_HELP]);

    const discarded = discardCandidate(dir, help, { reason: '도움말 링크만 누른다', author: 'reviewer' });
    assert.deepEqual(discarded.source, help.source);
    assert.deepEqual(tracedCandidatesOf({ storiesDir: dir }).list, []);
  });
});

test('with a map built before links carried their conditions, visit records or traces give no candidate and a request to rebuild, while without either there is no such request', () => {
  const stale: { screens: { links: { conditions?: unknown }[] }[] } = structuredClone(map);
  for (const s of stale.screens) for (const l of s.links) delete l.conditions;
  withFolder({}, (dir: string) => {
    const empty = { storiesDir: path.join(dir, 'stories') };
    const withRecords = candidatesOf(empty, stale, path.join(dir, 'map.json'));
    assert.deepEqual(withRecords.list, []);
    assert.equal((withRecords as { stale?: string }).stale, `${path.join(dir, 'map.json')} 은 링크에 조건이 없는 예전 duru 로 만든 맵이라 후보를 맞춰 보지 못했습니다. duru rebuild 로 맵을 다시 만드세요`);
    assert.equal((candidatesOf({ ...empty, visitRecords: [] }, stale) as { stale?: string }).stale, undefined);
    assert.deepEqual(tracedCandidatesOf(empty, stale, path.join(dir, 'map.json')), { list: [], discarded: [], notices: [], stale: (withRecords as { stale?: string }).stale });
  });
});

const storedIn = (dir: string) => {
  const folder = path.join(dir, 'candidates');
  return fs.existsSync(folder) ? fs.readdirSync(folder).sort().map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')) })) : [];
};
const leftOnlyStored = (dir: string, onMap: object = map, mapFile = path.join(config.outDir, 'map.json')) => storyCandidates({ ...config, visitRecords: [], storiesDir: dir }, onMap, mapFile, []);

test('every candidate is keyed by its screen order joined with " > ", whether it comes from a visit record or from traces', () => {
  assert.deepEqual(tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS] }).list.map((c) => c.key), [
    '/signin#SignIn > /home#Home > /beta/inbox > /help#Help',
    '/home#Home > /document/:tab#DocumentList > /document/:id#DocumentDetail > /help#Help',
    '/home#Home > /help#Help',
    '/home#Home > /document/:tab#DocumentList',
  ]);
});

test('storing the candidates writes one new file per screen order into the candidates folder of the stories folder, with the name, screens, source and the date it was first seen, and writes nothing for an order already stored', () => {
  withStoryCopy((dir: string) => {
    const { list } = tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS], storiesDir: dir });
    assert.deepEqual(storeCandidates(dir, list, new Date('2026-10-13T01:02:03Z')), { written: 4 });
    const stored = storedIn(dir);
    assert.ok(stored.every((s) => /^2026-10-13-[0-9a-f]{8}\.json$/.test(s.file)));
    const date = '2026-10-13T01:02:03.000Z';
    assert.deepEqual(stored.map(({ file, ...s }) => s).sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'moves to the drafts without loading a page', screens: HOME_DRAFTS, source: list[3].source, date },
      { name: 'open-help', screens: list[0].screens, source: { record: 'example-visits/open-help.json', steps: [1, 5] }, date },
      { name: 'opens home and then help', screens: HOME_HELP, source: list[2].source, date },
      { name: 'publish-document', screens: list[1].screens, source: { record: 'example-visits/publish-document.json', steps: [1, 7] }, date },
    ]);
    const again = tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS], storiesDir: dir }).list;
    assert.deepEqual(storeCandidates(dir, again, new Date('2026-10-14T00:00:00Z')), { written: 0 });
    assert.equal(storedIn(dir).length, 4);
    assert.deepEqual(loadStories(dir).notices.map((n) => n.file), ['lab-shortcut.json']);
  });
});

test('stored candidates stay in the list when the visit records and traces give none, keyed and named as when first seen, in the order of the day first seen and then the screen order, with the screen order checked against the map', () => {
  withStoryCopy((dir: string) => {
    const before = tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS], storiesDir: dir }).list;
    storeCandidates(dir, before);
    const after = leftOnlyStored(dir).list;
    const seen = (list: typeof after) => list.map((c) => [c.key, c.name, c.screens, c.source, c.links.map((l) => l.verdict)]);
    assert.deepEqual(seen(after), seen([...before].sort((a, b) => compare(a.key, b.key))));
    assert.ok(after.every((c) => c.stepRanges === undefined));
  });
});

test('when a visit record or trace gives the screen order of a stored candidate, the list shows what they give now, and two stored files with one screen order show once', () => {
  withStoryCopy((dir: string) => {
    fs.mkdirSync(path.join(dir, 'candidates'));
    const old = { name: 'an older title', screens: HOME_HELP, source: { report: 'results/old.json', tests: ['an older title'] }, date: '2026-10-01' };
    fs.writeFileSync(path.join(dir, 'candidates', '2026-10-01-aaaaaaaa.json'), JSON.stringify(old));
    fs.writeFileSync(path.join(dir, 'candidates', '2026-10-02-bbbbbbbb.json'), JSON.stringify({ ...old, name: 'from another computer' }));
    assert.deepEqual(tracedCandidatesOf({ storiesDir: dir }).list.map((c) => [c.name, (c.source as { report: string }).report]), [
      ['opens home and then help', 'results/playwright-traced/visits.json'],
      ['moves to the drafts without loading a page', 'results/playwright-traced/visits.json'],
    ]);
    assert.deepEqual(leftOnlyStored(dir).list.map((c) => c.name), ['an older title']);
  });
});

test('a stored candidate accepted or discarded leaves the list and does not come back, while its file stays', () => {
  withStoryCopy((dir: string) => {
    storeCandidates(dir, tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS], storiesDir: dir }).list);
    const stored = leftOnlyStored(dir).list;
    const help = stored.find((c) => c.name === 'open-help')!;
    const publish = stored.find((c) => c.name === 'publish-document')!;
    acceptCandidate(dir, help, { id: 'open-help', name: '홈에서 도움말을 연다', author: 'reviewer' });
    discardCandidate(dir, publish, { reason: '도움말만 연다', author: 'reviewer' });
    const left = tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS], storiesDir: dir }).list;
    assert.deepEqual(left.map((c) => c.screens), [HOME_HELP, HOME_DRAFTS]);
    assert.deepEqual(storeCandidates(dir, left), { written: 0 });
    assert.deepEqual(leftOnlyStored(dir).list.map((c) => c.screens), [HOME_DRAFTS, HOME_HELP]);
    assert.equal(storedIn(dir).length, 4);
  });
});

test('a candidate accepted before it was stored comes back when the acceptance is undone after its visit record is gone, from the candidate file written on undoing, under the story ID', () => {
  withStoryCopy((dir: string) => {
    const help = candidatesOf({ storiesDir: dir }).list.find((c) => c.name === 'open-help')!;
    acceptCandidate(dir, help, { id: 'open-help', name: '홈에서 도움말을 연다', author: 'reviewer' });
    unacceptStory(dir, 'open-help');
    assert.deepEqual(storedIn(dir).map(({ name, screens, source }) => ({ name, screens, source })), [{ name: 'open-help', screens: help.screens, source: help.source }]);
    assert.deepEqual(leftOnlyStored(dir).list.map((c) => c.key), [help.key]);
    acceptCandidate(dir, leftOnlyStored(dir).list[0], { id: 'open-help', name: '홈에서 도움말을 연다', author: 'reviewer' });
    unacceptStory(dir, 'open-help');
    assert.equal(storedIn(dir).length, 1, 'an order already stored is not stored twice');
  });
});

test('an accepted stored candidate comes back when the acceptance is undone, with no visit record or trace left', () => {
  withStoryCopy((dir: string) => {
    storeCandidates(dir, tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS], storiesDir: dir }).list);
    const help = leftOnlyStored(dir).list.find((c) => c.name === 'open-help')!;
    acceptCandidate(dir, help, { id: 'open-help', name: '홈에서 도움말을 연다', author: 'reviewer' });
    assert.equal(leftOnlyStored(dir).list.some((c) => c.key === help.key), false);
    unacceptStory(dir, 'open-help');
    assert.equal(leftOnlyStored(dir).list.find((c) => c.key === help.key)?.name, 'open-help');
  });
});

test('a stored candidate whose screen has left the map stays in the list with that step marked off the map', () => {
  withStoryCopy((dir: string) => {
    fs.mkdirSync(path.join(dir, 'candidates'));
    const gone = { name: 'opens a page that was removed', screens: ['/home#Home', '/gone#Gone'], source: { report: 'results/old.json', tests: ['opens a page that was removed'] }, date: '2026-10-01T00:00:00.000Z' };
    fs.writeFileSync(path.join(dir, 'candidates', '2026-10-01-aaaaaaaa.json'), JSON.stringify(gone));
    const [candidate] = leftOnlyStored(dir).list;
    assert.equal(candidate.key, '/home#Home > /gone#Gone');
    assert.deepEqual(candidate.steps, [{ screen: '/home#Home', onMap: true }, { screen: '/gone#Gone', onMap: false }]);
    assert.deepEqual(candidate.links.map((l) => l.verdict), ['off-map']);
    assert.equal(candidate.detached, true);
  });
});

test('a stored candidate file that cannot be read, or a candidates entry that is a file, is noted with the candidates, and storing writes nothing there', () => {
  withStoryCopy((dir: string) => {
    fs.mkdirSync(path.join(dir, 'candidates'));
    fs.writeFileSync(path.join(dir, 'candidates', 'broken.json'), '{');
    fs.writeFileSync(path.join(dir, 'candidates', 'no-source.json'), JSON.stringify({ name: 'x', screens: HOME_HELP, date: '2026-10-01' }));
    const { list, notices } = tracedCandidatesOf({ storiesDir: dir });
    assert.equal(list.length, 2);
    assert.deepEqual(notices.map((n) => n.file), ['broken.json', 'no-source.json'].map((f) => path.relative(FIXTURE, path.join(dir, 'candidates', f))));
    assert.match(notices[0].reason, /^JSON 으로 읽지 못했습니다: /);
    assert.match(notices[1].reason, /^source 는 /);
  });
  withStoryCopy((dir: string) => {
    fs.writeFileSync(path.join(dir, 'candidates'), 'not a folder');
    const { list, notices } = tracedCandidatesOf({ storiesDir: dir });
    assert.deepEqual(notices, [{ file: path.relative(FIXTURE, path.join(dir, 'candidates')), reason: 'candidates 는 스토리 후보를 담는 폴더여야 합니다' }]);
    assert.deepEqual(storeCandidates(dir, list), { written: 0 });
    assert.equal(fs.readFileSync(path.join(dir, 'candidates'), 'utf8'), 'not a folder');
  });
});

test('storing candidates into a stories folder that is a single story file, or with no candidate, writes nothing and makes no folder', () => {
  withStoryCopy((dir: string) => {
    const file = path.join(dir, 'run-lab.json');
    const before = fs.readdirSync(dir).sort();
    assert.deepEqual(storeCandidates(file, tracedCandidatesOf({ storiesDir: file }).list), { written: 0 });
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  });
  withFolder({}, (dir: string) => {
    assert.deepEqual(storeCandidates(path.join(dir, 'stories'), []), { written: 0 });
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

test('a candidate file that cannot be written stops the storing with why, instead of throwing', () => {
  withFolder({ 'taken.txt': 'a file' }, (dir: string) => {
    const result = storeCandidates(path.join(dir, 'taken.txt', 'stories'), tracedCandidatesOf({ storiesDir: path.join(dir, 'stories') }).list);
    assert.equal(result.written, 0);
    assert.match(result.reason!, /^후보 파일을 쓰지 못했습니다: ENOTDIR/);
  });
});

test('with a map built before links carried their conditions, stored candidates alone also give a request to rebuild', () => {
  const stale: { screens: { links: { conditions?: unknown }[] }[] } = structuredClone(map);
  for (const s of stale.screens) for (const l of s.links) delete l.conditions;
  withStoryCopy((dir: string) => {
    storeCandidates(dir, tracedCandidatesOf({ storiesDir: dir }).list);
    const result = leftOnlyStored(dir, stale, path.join(dir, 'map.json'));
    assert.deepEqual(result.list, []);
    assert.match((result as { stale?: string }).stale!, /예전 duru 로 만든 맵이라 후보를 맞춰 보지 못했습니다/);
  });
});

const MEMO_INPUT = { box: { label: '메모' }, value: '첫 메모' };
const withInputs = (title: string, inputs: StepInput[][], skipped = 0) => ({ report: 'results/playwright/e2e.json', title, screens: HOME_HELP, inputs, skipped });

test('the trace of an input run gives the filled values and the skipped count, one list per screen of the order', () => {
  const linkByTrace = traceLinker(map);
  const trace = linkByTrace('test/fixtures/app/traces/inputs.zip') as { order: string[]; inputs: StepInput[][]; skipped: number };
  assert.equal(trace.order.length, 2);
  assert.deepEqual(trace.inputs.map((i) => i.length), [5, 1]);
  assert.equal(trace.skipped, 10);
});

test('of traces with the same screen order, the first one read gives the inputs and the skipped count', () => {
  const traced = [withInputs('first', [[MEMO_INPUT], []], 2), withInputs('second', [[{ box: { label: '메모' }, value: '다른 값' }], []], 0)];
  const { list } = storyCandidates({ ...config, visitRecords: [], storiesDir: EXAMPLE_STORIES }, map, path.join(config.outDir, 'map.json'), traced);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].stepFields, [{ inputs: [MEMO_INPUT] }, {}]);
  assert.equal(list[0].skipped, 2);
});

test('a candidate with no input and nothing skipped carries neither field', () => {
  const { list } = storyCandidates({ ...config, visitRecords: [], storiesDir: EXAMPLE_STORIES }, map, path.join(config.outDir, 'map.json'), [withInputs('plain', [[], []])]);
  assert.equal('stepFields' in list[0], false);
  assert.equal('skipped' in list[0], false);
});

test('accepting a candidate writes its inputs into the steps of the story, and unaccepting keeps them in the stored candidate', () => {
  withFolder({}, (dir: string) => {
    const [candidate] = storyCandidates({ ...config, visitRecords: [], storiesDir: dir }, map, path.join(config.outDir, 'map.json'), [withInputs('fills memo', [[MEMO_INPUT], []], 1)]).list;
    acceptCandidate(dir, candidate, { id: 'fills-memo', name: '메모를 쓴다', author: 'reviewer' });
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'fills-memo.json'), 'utf8'));
    assert.deepEqual(written.screens, [{ screen: '/home#Home', inputs: [MEMO_INPUT] }, '/help#Help']);
    assert.equal(loadStories(dir).notices.length, 0);
    unacceptStory(dir, 'fills-memo');
    const [stored] = storyCandidates({ ...config, visitRecords: [], storiesDir: dir }, map, path.join(config.outDir, 'map.json')).list;
    assert.deepEqual(stored.stepFields, [{ inputs: [MEMO_INPUT] }, {}]);
  });
});

test('a stored candidate keeps its inputs and skipped count, and one whose stepFields do not fit its screens is reported', () => {
  withFolder({}, (dir: string) => {
    const list = storyCandidates({ ...config, visitRecords: [], storiesDir: dir }, map, path.join(config.outDir, 'map.json'), [withInputs('fills memo', [[MEMO_INPUT], []], 4)]).list;
    storeCandidates(dir, list);
    const [stored] = storyCandidates({ ...config, visitRecords: [], storiesDir: dir }, map, path.join(config.outDir, 'map.json')).list;
    assert.deepEqual([stored.stepFields, stored.skipped], [[{ inputs: [MEMO_INPUT] }, {}], 4]);
    const file = path.join(dir, 'candidates', fs.readdirSync(path.join(dir, 'candidates'))[0]);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), stepFields: [{}] }));
    const broken = storyCandidates({ ...config, visitRecords: [], storiesDir: dir }, map, path.join(config.outDir, 'map.json'));
    assert.equal(broken.list.length, 0);
    assert.match(broken.notices[0].reason, /stepFields 는 screens 와 같은 길이/);
  });
});
