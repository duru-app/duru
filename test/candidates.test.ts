import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { acceptCandidate, addCommentCandidate, discardCandidate, pickCandidateLine, pickCandidateStep, recordedRequests, saveVisitRecord, storeCandidates, storyCandidates, unacceptStory, undiscardCandidate } from '../src/candidates.ts';
import type { SkipRule } from '../src/candidates.ts';
import { compare, loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import { addMark, addReply } from '../src/marks.ts';
import { editStory, loadStories, writeStoryFields, writeStorySteps } from '../src/stories.ts';
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
    assert.deepEqual(unacceptStory(dir, 'open-help'), { id: 'open-help', screens: help.screens, file: 'open-help.json', key: help.screens.join(' > ') });
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
const HOME = '/home#Home';
const HELP = '/help#Help';
const DETAIL = '/document/:id#DocumentDetail';
const OFF_MAP = '/nowhere';
const FILE_SCREEN = '/tmp/claude-1000/-home-hit0607-duru/b41e2280-9925-40b1-adb4-5e025bb97b02/scratchpad/build/index.html';
const CALLS_HOME_TESTS = ['reads a document from the server', 'turns the pages of the member list', 'lists the documents', 'renames a document with the wrong method', 'lists the documents and the members @call:GET:/api/v1/document/list'];
const HELP_TESTS = ['hovers and uses the keyboard on help', 'moves the mouse and turns the wheel on help'];
const tracedCandidatesOf = (patch: Record<string, unknown> = {}, onMap: object = map, mapFile = path.join(config.outDir, 'map.json')) => {
  const settings = { ...config, visitRecords: [], storiesDir: EXAMPLE_STORIES, tests: [TRACED], ...patch };
  return storyCandidates(settings, onMap, mapFile, linkTests(settings, map).traced);
};

test('the tests with a trace in the Playwright reports give one candidate per screen order they passed, a test that passed a single screen among them, with steps on the same screen merged, every test that passed that order named in the source with its report, and a test whose trace cannot be read left out', () => {
  const { list, notices } = tracedCandidatesOf();
  assert.deepEqual(list.map((c) => ({ name: c.name, screens: c.screens, source: c.source, stepRanges: c.stepRanges })), [
    {
      name: 'reads a document from the server',
      screens: [HOME],
      source: { report: 'results/playwright-traced/calls.json', tests: CALLS_HOME_TESTS },
      stepRanges: undefined,
    },
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
      name: 'checks the path of a document',
      screens: [DETAIL],
      source: { report: 'results/playwright-traced/visits.json', tests: ['checks the path of a document'] },
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
    {
      name: 'wanders off the map',
      screens: [OFF_MAP],
      source: { report: 'results/playwright-traced/visits.json', tests: ['wanders off the map'] },
      stepRanges: undefined,
    },
    {
      name: 'hovers and uses the keyboard on help',
      screens: [HELP],
      source: { report: 'results/playwright-traced/visits.json', tests: HELP_TESTS },
      stepRanges: undefined,
    },
    {
      name: 'opens the app from a file',
      screens: [FILE_SCREEN],
      source: { report: 'results/playwright-traced/visits.json', tests: ['opens the app from a file'] },
      stepRanges: undefined,
    },
  ]);
  assert.deepEqual(notices, []);
});

test('two tests of one report that passed the same single screen give one candidate naming both titles, while a single screen that is already a story or a discarded candidate is not offered, and a trace that opened no screen gives nothing', () => {
  withStoryCopy((dir: string) => {
    const traced = [
      { report: 'results/playwright/e2e.json', title: 'saves an empty name', screens: [HELP] },
      { report: 'results/playwright/e2e.json', title: 'saves an empty name again', screens: [HELP] },
      { report: 'results/playwright/e2e.json', title: 'saves another report', screens: ['/admin/report#AdminReport'] },
      { report: 'results/playwright/e2e.json', title: 'calls the server without opening a page', screens: [] },
    ];
    const listed = (storiesDir: string) => storyCandidates({ ...config, visitRecords: [], storiesDir }, map, path.join(config.outDir, 'map.json'), traced);
    const first = listed(dir);
    assert.deepEqual(first.list.map((c) => [c.name, c.screens, c.source]), [
      ['saves an empty name', [HELP], { report: 'results/playwright/e2e.json', tests: ['saves an empty name', 'saves an empty name again'] }],
    ]);
    assert.deepEqual(first.gone, { '/admin/report#AdminReport': 'saves another report' });
    discardCandidate(dir, first.list[0], { reason: '도움말만 연다', author: 'reviewer' });
    const after = listed(dir);
    assert.deepEqual(after.list, []);
    assert.deepEqual(after.gone, { '/admin/report#AdminReport': 'saves another report', '/help#Help': 'saves an empty name' });
  });
});

test('candidates from the visit records come first and keep their own source, and a trace whose screen order a record already gave is not a second candidate', () => {
  assert.deepEqual(tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS] }).list.map((c) => [c.name, c.source]), [
    ['open-help', { record: 'example-visits/open-help.json', steps: [1, 5] }],
    ['publish-document', { record: 'example-visits/publish-document.json', steps: [1, 7] }],
    ['reads a document from the server', { report: 'results/playwright-traced/calls.json', tests: CALLS_HOME_TESTS }],
    ['opens home and then help', { report: 'results/playwright-traced/visits.json', tests: ['opens home and then help', 'follows a link while waiting for the new address', 'uses the mouse right after the address changes', 'clicks a button that appears after the address changes'] }],
    ['checks the path of a document', { report: 'results/playwright-traced/visits.json', tests: ['checks the path of a document'] }],
    ['moves to the drafts without loading a page', { report: 'results/playwright-traced/visits.json', tests: ['moves to the drafts without loading a page', 'checks a text that appears after the address changes', 'types into a field and submits with the keyboard'] }],
    ['wanders off the map', { report: 'results/playwright-traced/visits.json', tests: ['wanders off the map'] }],
    ['hovers and uses the keyboard on help', { report: 'results/playwright-traced/visits.json', tests: HELP_TESTS }],
    ['opens the app from a file', { report: 'results/playwright-traced/visits.json', tests: ['opens the app from a file'] }],
  ]);
  withFolder(recordsIn({ 'help.json': ['/home', '/help'] }), (dir: string) => {
    const { list } = tracedCandidatesOf({ visitRecords: [dir], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => c.screens), [HOME_HELP, [HOME], [DETAIL], HOME_DRAFTS, [OFF_MAP], [HELP], [FILE_SCREEN]]);
    assert.equal(list[0].name, 'help');
  });
});

test('of two reports with tests that passed the same screen order, the candidate names the tests of the first report in path order only', () => {
  withFolder({}, (dir: string) => {
    for (const copy of ['b', 'a']) fs.cpSync(TRACED.path, path.join(dir, copy), { recursive: true });
    const { list } = tracedCandidatesOf({ configDir: dir, tests: [{ ...TRACED, path: dir }], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => [c.screens, (c.source as { report: string }).report]), [
      [[HOME], 'a/calls.json'],
      [HOME_HELP, 'a/visits.json'],
      [[DETAIL], 'a/visits.json'],
      [HOME_DRAFTS, 'a/visits.json'],
      [[OFF_MAP], 'a/visits.json'],
      [[HELP], 'a/visits.json'],
      [[FILE_SCREEN], 'a/visits.json'],
    ]);
  });
});

test('a candidate from a test whose title carries tags is named by the title without them, so the story name and ID offered from it carry none', () => {
  withFolder({}, (dir: string) => {
    fs.cpSync(TRACED.path, dir, { recursive: true });
    const file = path.join(dir, 'visits.json');
    const report = fs.readFileSync(file, 'utf8').replace('"title": "opens home and then help"', '"title": "opens home and then help @screen:/home#Home @depth:ui @role:ADMIN"');
    fs.writeFileSync(file, report);
    const { list } = tracedCandidatesOf({ configDir: dir, tests: [{ ...TRACED, path: dir }], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => c.name), ['reads a document from the server', 'opens home and then help', 'checks the path of a document', 'moves to the drafts without loading a page', 'wanders off the map', 'hovers and uses the keyboard on help', 'opens the app from a file']);
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
      [[HOME], CALLS_HOME_TESTS],
      [[DETAIL], ['checks the path of a document']],
      [HOME_DRAFTS, ['moves to the drafts without loading a page', 'checks a text that appears after the address changes']],
      [[OFF_MAP], ['wanders off the map']],
      [HOME_HELP, ['follows a link while waiting for the new address', 'uses the mouse right after the address changes', 'clicks a button that appears after the address changes']],
      [[HELP], HELP_TESTS],
      [[FILE_SCREEN], ['opens the app from a file']],
    ]);
  });
});

test('a trace candidate accepted becomes a story file with the report and the test titles as its source that reads back as a story, and one discarded or with the screen order of a story is not offered again', () => {
  withStoryCopy((dir: string) => {
    const listed = tracedCandidatesOf({ storiesDir: dir }).list;
    const help = listed.find((c) => c.name === 'opens home and then help')!;
    const drafts = listed.find((c) => c.name === 'moves to the drafts without loading a page')!;
    acceptCandidate(dir, drafts, { id: 'open-drafts', name: '홈에서 초안을 연다', author: 'reviewer' }, new Date('2026-10-03T01:02:03Z'));
    const source = { report: 'results/playwright-traced/visits.json', tests: ['moves to the drafts without loading a page', 'checks a text that appears after the address changes', 'types into a field and submits with the keyboard'] };
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'open-drafts.json'), 'utf8')).source, source);
    const read = loadStories(dir);
    assert.deepEqual(read.notices.map((n) => n.file), ['lab-shortcut.json']);
    assert.deepEqual(read.stories.find((s) => s.id === 'open-drafts')!.source, source);
    assert.deepEqual(tracedCandidatesOf({ storiesDir: dir }).list.map((c) => c.screens), [[HOME], HOME_HELP, [DETAIL], [OFF_MAP], [HELP], [FILE_SCREEN]]);

    const discarded = discardCandidate(dir, help, { reason: '도움말 링크만 누른다', author: 'reviewer' });
    assert.deepEqual(discarded.source, help.source);
    assert.deepEqual(tracedCandidatesOf({ storiesDir: dir }).list.map((c) => c.screens), [[HOME], [DETAIL], [OFF_MAP], [HELP], [FILE_SCREEN]]);
  });
});

test('accepting a single-screen trace candidate writes a story of that one screen, which reads back as a story with no new notice and is no longer a candidate', () => {
  withStoryCopy((dir: string) => {
    const help = tracedCandidatesOf({ storiesDir: dir }).list.find((c) => c.name === 'hovers and uses the keyboard on help')!;
    acceptCandidate(dir, help, { id: 'hover-help', name: '토움말에서 마우스와 키보드를 쓴다', author: 'reviewer' }, new Date('2026-11-02T01:02:03Z'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'hover-help.json'), 'utf8')).screens, [HELP]);
    const read = loadStories(dir);
    assert.deepEqual(read.notices.map((n) => n.file), ['lab-shortcut.json']);
    assert.deepEqual(read.stories.find((s) => s.id === 'hover-help')!.screens, [HELP]);
    assert.equal(tracedCandidatesOf({ storiesDir: dir }).list.some((c) => c.name === 'hovers and uses the keyboard on help'), false);
  });
});

test('with a map built before links carried their conditions, visit records or traces give no candidate and a request to rebuild, while without either there is no such request', () => {
  const stale: { screens: { links: { conditions?: unknown }[] }[] } = structuredClone(map);
  for (const s of stale.screens) for (const l of s.links) delete l.conditions;
  withFolder({}, (dir: string) => {
    const empty = { storiesDir: path.join(dir, 'stories') };
    const withRecords = candidatesOf(empty, stale, path.join(dir, 'map.json'));
    assert.deepEqual(withRecords.list, []);
    assert.equal((withRecords as { stale?: string }).stale, `${path.join(dir, 'map.json')} 은 링크에 조건이나 이어지는 화면이 적혀 있지 않은 예전 duru 로 만든 맵이라 후보를 맞춰 보지 못했습니다. duru rebuild 로 맵을 다시 만드세요`);
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
    HOME,
    '/home#Home > /help#Help',
    DETAIL,
    '/home#Home > /document/:tab#DocumentList',
    OFF_MAP,
    HELP,
    FILE_SCREEN,
  ]);
});

test('storing the candidates writes one new file per screen order into the candidates folder of the stories folder, with the name, screens, source and the date it was first seen, and writes nothing for an order already stored', () => {
  withStoryCopy((dir: string) => {
    const { list } = tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS], storiesDir: dir });
    assert.deepEqual(storeCandidates(dir, list, new Date('2026-10-13T01:02:03Z')), { written: 9 });
    const stored = storedIn(dir);
    assert.ok(stored.every((s) => /^2026-10-13-[0-9a-f]{8}\.json$/.test(s.file)));
    const date = '2026-10-13T01:02:03.000Z';
    const sourceOf = (name: string) => list.find((c) => c.name === name)!.source;
    assert.deepEqual(stored.map(({ file, ...s }) => s).sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'checks the path of a document', screens: [DETAIL], source: sourceOf('checks the path of a document'), date },
      { name: 'hovers and uses the keyboard on help', screens: [HELP], source: sourceOf('hovers and uses the keyboard on help'), date },
      { name: 'moves to the drafts without loading a page', screens: HOME_DRAFTS, source: sourceOf('moves to the drafts without loading a page'), date },
      { name: 'open-help', screens: list[0].screens, source: { record: 'example-visits/open-help.json', steps: [1, 5] }, date },
      { name: 'opens home and then help', screens: HOME_HELP, source: sourceOf('opens home and then help'), date },
      { name: 'opens the app from a file', screens: [FILE_SCREEN], source: sourceOf('opens the app from a file'), date },
      { name: 'publish-document', screens: list[1].screens, source: { record: 'example-visits/publish-document.json', steps: [1, 7] }, date },
      { name: 'reads a document from the server', screens: [HOME], source: sourceOf('reads a document from the server'), date },
      { name: 'wanders off the map', screens: [OFF_MAP], source: sourceOf('wanders off the map'), date },
    ]);
    const again = tracedCandidatesOf({ visitRecords: [EXAMPLE_VISITS], storiesDir: dir }).list;
    assert.deepEqual(storeCandidates(dir, again, new Date('2026-10-14T00:00:00Z')), { written: 0 });
    assert.equal(storedIn(dir).length, 9);
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
      ['reads a document from the server', 'results/playwright-traced/calls.json'],
      ['opens home and then help', 'results/playwright-traced/visits.json'],
      ['checks the path of a document', 'results/playwright-traced/visits.json'],
      ['moves to the drafts without loading a page', 'results/playwright-traced/visits.json'],
      ['wanders off the map', 'results/playwright-traced/visits.json'],
      ['hovers and uses the keyboard on help', 'results/playwright-traced/visits.json'],
      ['opens the app from a file', 'results/playwright-traced/visits.json'],
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
    assert.deepEqual(left.map((c) => c.screens), [[HOME], HOME_HELP, [DETAIL], HOME_DRAFTS, [OFF_MAP], [HELP], [FILE_SCREEN]]);
    assert.deepEqual(storeCandidates(dir, left), { written: 0 });
    assert.deepEqual(leftOnlyStored(dir).list.map((c) => c.screens), [[DETAIL], [HELP], [HOME], HOME_DRAFTS, HOME_HELP, [OFF_MAP], [FILE_SCREEN]]);
    assert.equal(storedIn(dir).length, 9);
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
    assert.equal(list.length, 7);
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

const EMAIL_INPUT = { box: { placeholder: '이메일', testId: 'login-email' }, value: 'member@example.com' };
const RECORDED = [
  { url: '/signin', inputs: [EMAIL_INPUT], skipped: 1 },
  { url: '/home' },
  { url: '/home?tab=recent#top', inputs: [MEMO_INPUT] },
  { url: '/beta/inbox' },
];

test('a visit recorded on the review page is written into records/ in the stories folder as a new file with its addresses, the values typed and the number of inputs left out, and gives a candidate named by its file with those values on its steps', () => {
  withFolder({}, (dir: string) => {
    const stories = path.join(dir, 'stories');
    const now = new Date('2026-10-19T09:00:00Z');
    const file = saveVisitRecord(stories, RECORDED, now);
    assert.match(file, /^records[\\/]2026-10-19-[0-9a-f]{8}\.json$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stories, file), 'utf8')), { steps: RECORDED });
    const again = saveVisitRecord(stories, [{ url: '/home', inputs: [] }], now);
    assert.notEqual(again, file);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stories, again), 'utf8')), { steps: [{ url: '/home' }] });
    assert.deepEqual(loadStories(stories), { stories: [], notices: [] });

    const { list, notices } = storyCandidates({ ...config, configDir: dir, visitRecords: [], storiesDir: stories }, map, path.join(config.outDir, 'map.json'));
    assert.deepEqual(notices, []);
    const recorded = list.find((c) => c.screens.length > 1)!;
    assert.deepEqual({ ...shape(recorded), stepFields: recorded.stepFields, skipped: recorded.skipped }, {
      name: path.basename(file, '.json'),
      screens: ['/signin#SignIn', '/home#Home', '/beta/inbox'],
      source: { record: `stories/${file.split(path.sep).join('/')}`, steps: [1, 4] },
      stepRanges: [[1, 1], [2, 3], [4, 4]],
      stepFields: [{ inputs: [EMAIL_INPUT] }, { inputs: [MEMO_INPUT] }, {}],
      skipped: 1,
    });
  });
});

test('a recorded visit needs one or more steps, each with an address inside the app and only the values typed and the inputs left out, and writes nothing otherwise', () => {
  withFolder({}, (dir: string) => {
    const refused = (steps: unknown, why: RegExp) => assert.throws(() => saveVisitRecord(dir, steps), why, JSON.stringify(steps));
    for (const steps of [undefined, [], 'x', [{ url: 'http://localhost:3000/home' }], [{ url: '//other.example/home' }], [{ url: '' }], [{}], ['/home']]) {
      refused(steps, /steps 는 \/ 로 시작하는 앱 안 주소를 url 에 담은 단계를 하나 이상/);
    }
    refused([{ url: '/home', action: 'open' }], /1 번째 단계에 모르는 항목이 있습니다: action/);
    refused([{ url: '/home' }, { url: '/help', inputs: [{ box: {}, value: 'x' }] }], /2 번째 단계의 1 번째 입력값의 box 에 상자를 찾는 말/);
    refused([{ url: '/home', skipped: -1 }], /1 번째 단계의 skipped 는 넣지 못한 입력의 수로, 0 이상의 정수여야 합니다/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
  withFolder({ 'stories.json': '{}', 'folder/records': 'not a folder' }, (dir: string) => {
    assert.throws(() => saveVisitRecord(path.join(dir, 'stories.json'), [{ url: '/home' }]), /가 파일이라 새 파일을 쓸 수 없습니다/);
    assert.throws(() => saveVisitRecord(path.join(dir, 'folder'), [{ url: '/home' }]), /스토리 폴더 안 records 가 파일이라 기록을 쓸 수 없습니다/);
  });
});

test('a recorded visit keeps the requests sent while it was made in requests, and a visit with none writes no requests', () => {
  withFolder({}, (dir: string) => {
    const stories = path.join(dir, 'stories');
    const requests = [{ method: 'POST', url: '/api/v1/report/export', body: '{"watermark":true}', shown: '/help' }, { method: 'DELETE', url: '/api/v1/report/7' }];
    const file = saveVisitRecord(stories, [{ url: '/help' }], new Date('2026-10-31T09:00:00Z'), requests);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stories, file), 'utf8')), { steps: [{ url: '/help' }], requests });
    const none = saveVisitRecord(stories, [{ url: '/home' }], new Date('2026-10-31T09:00:00Z'), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stories, none), 'utf8')), { steps: [{ url: '/home' }] });
  });
});

test('the requests of the visit records in visitRecords and in records/ are read as sent, with the record file as the title, the requests with a shown address as page requests, and a record without requests as sending nothing', () => {
  withFolder({
    'visits/kept.json': { steps: [{ url: '/help' }], requests: [{ method: 'POST', url: '/api/v1/report/export', body: '{"watermark":true}', shown: '/help?x=1' }, { method: 'PUT', url: '/api/v1/document/7/name' }] },
    'visits/old.json': { steps: [{ url: '/home' }] },
    'visits/list.json': [{ url: '/home' }],
    'stories/records/2026-10-31-0a1b2c3d.json': { steps: [{ url: '/home' }], requests: [{ method: 'DELETE', url: '/api/v1/report/7', shown: '/home' }] },
  }, (dir: string) => {
    const sent = recordedRequests({ configDir: dir, visitRecords: [path.join(dir, 'visits')], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(sent, [
      {
        title: 'visits/kept.json', file: null, line: null, project: null,
        requests: [{ method: 'POST', url: '/api/v1/report/export', body: '{"watermark":true}' }, { method: 'PUT', url: '/api/v1/document/7/name' }],
        pageRequests: [{ method: 'POST', url: '/api/v1/report/export', shown: '/help?x=1' }],
      },
      {
        title: 'stories/records/2026-10-31-0a1b2c3d.json', file: null, line: null, project: null,
        requests: [{ method: 'DELETE', url: '/api/v1/report/7' }],
        pageRequests: [{ method: 'DELETE', url: '/api/v1/report/7', shown: '/home' }],
      },
    ].sort((a, b) => compare(a.title, b.title)));
  });
});

test('a visit record whose requests do not fit is left out with a notice, and a record without requests stays a candidate as before', () => {
  const bad: [unknown, RegExp][] = [
    [{}, /requests 는 요청 목록이어야 합니다/],
    [['POST /api'], /requests 의 1 번째 요청은 객체여야 합니다/],
    [[{ url: '/api/x' }], /requests 의 1 번째 요청의 method 가 문자열이 아니거나 비어 있습니다/],
    [[{ method: 'POST', url: 'http://x/api/x' }], /requests 의 1 번째 요청의 url 은 \/ 로 시작하는 주소여야 합니다/],
    [[{ method: 'POST', url: '/api/x', body: { a: true } }], /requests 의 1 번째 요청의 body 는 문자열이어야 합니다/],
    [[{ method: 'POST', url: '/api/x', shown: 'http://x/home' }], /requests 의 1 번째 요청의 shown 은 \/ 로 시작하는 앱 안 주소여야 합니다/],
  ];
  for (const [requests, why] of bad) {
    withFolder({ 'visits/bad.json': { steps: [{ url: '/home' }, { url: '/help' }], requests }, 'visits/old.json': { steps: [{ url: '/home' }, { url: '/help' }] } }, (dir: string) => {
      const own = { ...config, configDir: dir, visitRecords: [path.join(dir, 'visits')], storiesDir: path.join(dir, 'stories') };
      const { list, notices } = storyCandidates(own, map, path.join(config.outDir, 'map.json'));
      assert.deepEqual(notices.map((n) => n.file), ['visits/bad.json'], JSON.stringify(requests));
      assert.match(notices[0].reason, why);
      assert.deepEqual(list.map((c) => c.name), ['old']);
      assert.deepEqual(recordedRequests(own), []);
    });
  }
});

test('a visit record step may carry the values typed there and the number of inputs left out, which go onto its screen\'s step of the candidate, a later value for the same box replacing the earlier one, and a step whose values do not fit is noted', () => {
  const later = { box: { label: '메모' }, value: '고친 메모' };
  withFolder({
    'typed.json': { steps: [{ url: '/home', inputs: [MEMO_INPUT], skipped: 2 }, { url: '/home?x=1', inputs: [later, EMAIL_INPUT], skipped: 1 }, { url: '/help' }] },
    'bad.json': { steps: [{ url: '/home' }, { url: '/help', inputs: { box: { label: '메모' }, value: 'x' } }] },
    'bad-count.json': { steps: [{ url: '/home', skipped: 'two' }] },
    'zero.json': { steps: [{ url: '/home', skipped: 0 }, { url: '/signin' }] },
  }, (dir: string) => {
    const { list, notices } = candidatesOf({ configDir: dir, visitRecords: [dir], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(list.map((c) => [c.name, c.stepFields, c.skipped]), [['typed', [{ inputs: [later, EMAIL_INPUT] }, {}], 3], ['zero', undefined, undefined]]);
    assert.deepEqual(notices, [
      { file: 'bad-count.json', reason: '1 번째 단계의 skipped 는 넣지 못한 입력의 수로, 0 이상의 정수여야 합니다' },
      { file: 'bad.json', reason: '2 번째 단계의 inputs 는 입력값을 { "box", "value" } 객체로 하나씩 적은 목록이어야 합니다' },
    ]);
  });
});

test('a records entry in the stories folder that is a file is noted with the candidates', () => {
  withFolder({ 'stories/records': 'x' }, (dir: string) => {
    const { notices } = candidatesOf({ configDir: dir, visitRecords: [], storiesDir: path.join(dir, 'stories') });
    assert.deepEqual(notices, [{ file: 'stories/records', reason: 'records 는 리뷰 페이지에서 남긴 방문 기록을 담는 폴더여야 합니다' }]);
  });
});

const LAB_ORDER = ['/signin#SignIn', '/lab#Lab'];
const LAB_PATH = ['/signin#SignIn', '/home#Home', '/lab#Lab'];
const ASKED_STEPS = [{ step: 1, inputs: [EMAIL_INPUT] }, { step: 2, expects: ['실험 목록이 보인다'] }];
const THROUGH_HOME = '로그인하면 홈으로만 갑니다 (components/SignIn.js:12)';
const AGENT_SCREENS = [
  { screen: '/signin#SignIn', inputs: [EMAIL_INPUT] },
  { screen: '/home#Home', reason: THROUGH_HOME, expects: ['홈이 보인다'] },
  { screen: '/lab#Lab', needs: ['실험 메뉴가 켜져 있다'], expects: ['실험 목록이 보인다'] },
];

function withOrderComment(target: Record<string, unknown>, fn: (ctx: { cfg: typeof config; comment: string; post: (input: Record<string, unknown>, onMap?: object) => ReturnType<typeof addCommentCandidate>; files: () => string[] }) => void) {
  withFolder({}, (dir: string) => {
    const cfg = { ...config, configDir: dir, visitRecords: [], storiesDir: path.join(dir, 'stories'), marksDir: path.join(dir, 'marks') };
    const { id: comment } = addMark(cfg.marksDir, { target, note: '로그인한 뒤 실험으로 가는 길을 채워 줘\n둘째 줄', author: 'hit' }, new Date('2026-10-20T01:00:00Z'));
    const post = (input: Record<string, unknown>, onMap: object = map) => addCommentCandidate(cfg, onMap, path.join(dir, 'map.json'), [], { comment, name: '로그인해 실험을 연다', screens: AGENT_SCREENS, ...input }, new Date('2026-10-21T02:00:00Z'));
    const files = () => (fs.existsSync(cfg.storiesDir) ? (fs.readdirSync(cfg.storiesDir, { recursive: true }) as string[]).sort() : []);
    fn({ cfg, comment, post, files });
  });
}

test('a candidate an agent posts for a comment on a screen order is written into the candidates folder with the comment it answers, the steps it put in with why, and the lines it wrote, the reviewer\'s lines kept, and is listed with the links between its steps judged', () => {
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, comment, post }) => {
    const posted = post({});
    assert.match(posted.file, /^stories\/candidates\/2026-10-21-[0-9a-f]{8}\.json$/);
    assert.deepEqual([posted.key, posted.links.map((l) => [l.from, l.to, l.verdict])], [LAB_PATH.join(' > '), [['/signin#SignIn', '/home#Home', 'open'], ['/home#Home', '/lab#Lab', 'conditioned']]]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg.configDir, posted.file), 'utf8')), {
      name: '로그인해 실험을 연다',
      screens: LAB_PATH,
      source: {
        comment,
        added: [{ step: 2, reason: THROUGH_HOME }],
        written: [{ step: 2, expects: ['홈이 보인다'] }, { step: 3, needs: ['실험 메뉴가 켜져 있다'] }],
      },
      date: '2026-10-21T02:00:00.000Z',
      stepFields: [{ inputs: [EMAIL_INPUT] }, { expects: ['홈이 보인다'] }, { needs: ['실험 메뉴가 켜져 있다'], expects: ['실험 목록이 보인다'] }],
    });
    const { list, notices } = storyCandidates(cfg, map, path.join(config.outDir, 'map.json'));
    assert.deepEqual(notices, []);
    assert.deepEqual(list.map((c) => [c.key, c.name, c.source, c.links.map((l) => l.verdict)]), [[LAB_PATH.join(' > '), '로그인해 실험을 연다', JSON.parse(fs.readFileSync(path.join(cfg.configDir, posted.file), 'utf8')).source, ['open', 'conditioned']]]);
  });
});

test('a candidate from a comment is accepted into a story file with its source and every line on its steps, and unaccepting, discarding and undoing the discard keep them', () => {
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, post }) => {
    post({});
    const listed = () => storyCandidates(cfg, map, path.join(config.outDir, 'map.json')).list;
    const [candidate] = listed();
    acceptCandidate(cfg.storiesDir, candidate, { id: 'lab', name: candidate.name, author: 'hit' });
    const written = JSON.parse(fs.readFileSync(path.join(cfg.storiesDir, 'lab.json'), 'utf8'));
    assert.deepEqual(written.screens, [{ screen: '/signin#SignIn', inputs: [EMAIL_INPUT] }, { screen: '/home#Home', expects: ['홈이 보인다'] }, { screen: '/lab#Lab', needs: ['실험 메뉴가 켜져 있다'], expects: ['실험 목록이 보인다'] }]);
    assert.deepEqual(written.source, candidate.source);
    assert.deepEqual(loadStories(cfg.storiesDir).notices, []);
    assert.deepEqual(listed(), []);
    unacceptStory(cfg.storiesDir, 'lab');
    const [back] = listed();
    assert.deepEqual([back.source, back.stepFields], [candidate.source, candidate.stepFields]);
    discardCandidate(cfg.storiesDir, back, { reason: '실험은 따로 본다', author: 'hit' }, new Date('2026-10-21T03:00:00Z'));
    assert.deepEqual(listed(), []);
    undiscardCandidate(cfg.storiesDir, back.screens, { author: 'hit' }, new Date('2026-10-21T04:00:00Z'));
    const [again] = listed();
    assert.deepEqual([again.source, again.stepFields], [candidate.source, candidate.stepFields]);
  });
});

test('a story from a comment whose steps the reviewer takes out, replaces or moves keeps the agent\'s reasons and lines on the screens the agent put them on, keeps its candidate away, and gives them back so when it is unaccepted', () => {
  const signin = { step: 1, screen: '/signin#SignIn' };
  const lab = { step: 3, screen: '/lab#Lab' };
  const list = { screen: '/document/:tab#DocumentList' };
  const cases: [string, { step?: number; screen: string }[], object][] = [
    ['taken out', [signin, lab], { added: [], written: [{ step: 2, needs: ['실험 메뉴가 켜져 있다'] }] }],
    ['replaced', [signin, list, lab], { added: [], written: [{ step: 3, needs: ['실험 메뉴가 켜져 있다'] }] }],
    ['moved', [signin, list, { step: 2, screen: '/home#Home' }, lab], {
      added: [{ step: 3, reason: THROUGH_HOME }],
      written: [{ step: 3, expects: ['홈이 보인다'] }, { step: 4, needs: ['실험 메뉴가 켜져 있다'] }],
    }],
  ];
  for (const [what, steps, marks] of cases) {
    withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, comment, post }) => {
      post({});
      const listed = () => storyCandidates(cfg, map, path.join(config.outDir, 'map.json')).list;
      acceptCandidate(cfg.storiesDir, listed()[0], { id: 'lab', name: '로그인해 실험을 연다', author: 'hit' });
      const story = loadStories(cfg.storiesDir).stories.find((s) => s.id === 'lab')!;
      writeStorySteps(cfg.storiesDir, 'lab', { steps, contentHash: story.contentHash });
      assert.deepEqual(loadStories(cfg.storiesDir).stories.find((s) => s.id === 'lab')!.source, { comment, ...marks }, what);
      assert.deepEqual(listed(), [], what);
      unacceptStory(cfg.storiesDir, 'lab');
      const back = listed().find((c) => isDeepStrictEqual(c.screens, steps.map((s) => s.screen)));
      assert.deepEqual(back?.source, { comment, ...marks }, what);
    });
  }
});

test('with gaps picked on the comment, a candidate may put screens only into those gaps, while with none it may put them anywhere, before the first step and after the last too', () => {
  const order = ['/signin#SignIn', '/home#Home', '/lab/result#LabResult'];
  const reason = '실험 결과는 실험 목록에서만 엽니다';
  withOrderComment({ screens: order, gaps: [[2, 3]] }, ({ post, files }) => {
    assert.throws(() => post({ screens: ['/signin#SignIn', { screen: '/document/:tab#DocumentList', reason }, '/home#Home', { screen: '/lab#Lab', reason }, '/lab/result#LabResult'] }), {
      message: 'screens 의 2 번째 단계는 코멘트가 고른 사이(2-3) 밖에 넣은 화면입니다',
    });
    assert.deepEqual(files(), []);
    assert.equal(post({ screens: ['/signin#SignIn', '/home#Home', { screen: '/lab#Lab', reason }, '/lab/result#LabResult'] }).links.length, 3);
  });
  withOrderComment({ screens: ['/home#Home', '/lab#Lab'] }, ({ post }) => {
    const posted = post({ screens: [{ screen: '/signin#SignIn', reason: '홈은 로그인해야 열립니다' }, '/home#Home', '/lab#Lab', { screen: '/lab/result#LabResult', reason }] });
    assert.deepEqual(posted.key, ['/signin#SignIn', '/home#Home', '/lab#Lab', '/lab/result#LabResult'].join(' > '));
  });
});

test('a candidate for a comment is refused with why, writing nothing, when a screen is not on the map, a screen follows itself, the comment is not there or is not on a screen order, a line the reviewer wrote is changed or added to, or a screen the reviewer picked is left out or moved', () => {
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, comment, post, files }) => {
    const nodeComment = addMark(cfg.marksDir, { target: { node: '/lab#Lab' }, note: '실험 화면', author: 'hit' }).id;
    const replied = addReply(cfg.marksDir, { replyTo: comment, note: '찾아볼게요' }).id;
    const screens = (change: (s: Record<string, unknown>[]) => unknown[]) => change(structuredClone(AGENT_SCREENS));
    const refusals: [Record<string, unknown>, string][] = [
      [{ screens: screens((s) => s.with(1, { ...s[1], screen: '/nowhere' })) }, 'screens 의 2 번째 단계의 /nowhere 는 맵에 없는 화면입니다'],
      [{ screens: screens((s) => [s[0], s[1], { screen: '/home#Home', reason: 'x' }, s[2]]) }, 'screens 의 2 번째와 3 번째가 같은 화면입니다'],
      [{ comment: 'no-such-id' }, '코멘트 no-such-id 가 없습니다'],
      [{ comment: nodeComment }, `코멘트 ${nodeComment} 는 화면 순서나 후보에 단 코멘트도, 대상 없는 코멘트도 아닙니다`],
      [{ comment: replied }, `코멘트 ${replied} 가 없습니다`],
      [{ screens: screens((s) => s.with(2, { ...s[2], expects: ['실험이 보인다'] })) }, 'screens 의 3 번째 단계 /lab#Lab 의 expects 는 검토자가 적은 줄이라 바꿀 수 없습니다'],
      [{ screens: screens((s) => s.with(0, { ...s[0], inputs: [EMAIL_INPUT, MEMO_INPUT] })) }, 'screens 의 1 번째 단계 /signin#SignIn 의 inputs 는 검토자가 적은 줄이라 바꿀 수 없습니다'],
      [{ screens: screens((s) => s.with(0, { screen: '/signin#SignIn' })) }, 'screens 의 1 번째 단계 /signin#SignIn 의 inputs 는 검토자가 적은 줄이라 바꿀 수 없습니다'],
      [{ screens: screens((s) => [s[0], s[2], { screen: '/help#Help' }]) }, '이유를 적지 않은 단계는 코멘트가 고른 화면 순서 /signin#SignIn > /lab#Lab 그대로여야 합니다. 에이전트가 넣은 화면에는 reason 에 이유를 적습니다'],
      [{ screens: screens((s) => s.with(1, { ...s[1], reason: ' ' })) }, 'screens 의 2 번째 단계의 reason 에 이 화면을 넣은 이유를 적어야 합니다'],
      [{ screens: screens((s) => s.with(1, { ...s[1], expects: '홈' })) }, 'screens 의 2 번째 단계의 expects 는 기대 결과를 하나씩 글로 적은 목록이어야 합니다'],
      [{ name: ' ' }, 'name 에 후보 이름을 적어야 합니다'],
      [{ steps: [] }, '모르는 항목이 있습니다: steps'],
      [{ screens: [] }, 'screens 는 화면 ID 나 { "screen", "reason", "needs", "linkNeeds", "inputs", "expects" } 객체를 하나 이상 차례대로 담은 목록이어야 합니다'],
    ];
    for (const [input, message] of refusals) assert.throws(() => post(input), { message }, message);
    assert.deepEqual(files(), []);
  });
});

test('a candidate for a comment is refused when its screen order is already a story, a candidate or a discarded candidate, when a story was already accepted from that comment, or when the map was built before links carried their conditions', () => {
  withOrderComment({ screens: LAB_ORDER }, ({ cfg, comment, post, files }) => {
    const stale: { screens: { links: { conditions?: unknown }[] }[] } = structuredClone(map);
    for (const s of stale.screens) for (const l of s.links) delete l.conditions;
    assert.throws(() => post({}, stale), { message: `${path.join(cfg.configDir, 'map.json')} 은 링크에 조건이나 이어지는 화면이 적혀 있지 않은 예전 duru 로 만든 맵이라 후보를 맞춰 보지 못했습니다. duru rebuild 로 맵을 다시 만드세요` });
    assert.deepEqual(files(), []);
    post({});
    assert.throws(() => post({ name: '다시' }), { message: '이미 후보 「로그인해 실험을 연다」의 화면 순서입니다' });
    const [candidate] = storyCandidates(cfg, map, path.join(config.outDir, 'map.json')).list;
    discardCandidate(cfg.storiesDir, candidate, { reason: '버림', author: 'hit' }, new Date('2026-10-21T03:00:00Z'));
    assert.throws(() => post({}), { message: '이 화면 순서는 버린 후보에 있습니다. 검토자가 「되돌리기」를 누른 뒤에 올릴 수 있습니다' });
    undiscardCandidate(cfg.storiesDir, candidate.screens, { author: 'hit' }, new Date('2026-10-21T04:00:00Z'));
    acceptCandidate(cfg.storiesDir, storyCandidates(cfg, map, path.join(config.outDir, 'map.json')).list[0], { id: 'lab', name: 'x', author: 'hit' });
    assert.throws(() => post({}), { message: '이미 스토리 lab 의 화면 순서입니다' });
    const viaList = ['/signin#SignIn', { screen: '/document/:tab#DocumentList', reason: '문서 목록을 거쳐도 됩니다' }, '/lab#Lab'];
    assert.throws(() => post({ screens: viaList }), { message: `코멘트 ${comment} 의 부탁은 이미 스토리 lab 로 받았습니다` });
    assert.equal(files().filter((f) => f.startsWith('candidates/')).length, 1);
  });
});

const PICK_SCREENS = [
  { screen: '/signin#SignIn', inputs: [EMAIL_INPUT] },
  { screen: '/home#Home', reason: THROUGH_HOME, expects: ['홈이 보인다', '알림이 보인다'] },
  { screen: '/lab#Lab', needs: ['실험 메뉴가 켜져 있다'], linkNeeds: ['홈에서 실험을 누른다'], expects: ['실험 목록이 보인다'] },
];
const MAP_FILE = path.join(config.outDir, 'map.json');
const off = (step: number, field: string, line: number) => ({ step, field, line, on: false });
const on = (step: number, field: string, line: number) => ({ step, field, line, on: true });

test('each line the agent wrote on a candidate from a comment is listed switched on with the row it sits on, a line switched off is written into the candidate file and read back off, and switching it on again leaves the file as it was', () => {
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, post }) => {
    const file = path.join(cfg.configDir, post({ screens: PICK_SCREENS }).file);
    const before = fs.readFileSync(file, 'utf8');
    const listed = () => storyCandidates(cfg, map, MAP_FILE).list[0];
    assert.deepEqual(listed().lines, [
      { step: 2, field: 'expects', line: 1, row: 0, on: true },
      { step: 2, field: 'expects', line: 2, row: 1, on: true },
      { step: 3, field: 'needs', line: 1, row: 0, on: true },
      { step: 3, field: 'linkNeeds', line: 1, row: 0, on: true },
    ]);
    assert.equal(listed().file, path.join('candidates', path.basename(file)));
    assert.deepEqual(pickCandidateLine(cfg.storiesDir, listed(), off(3, 'linkNeeds', 1)).offLines, [{ step: 3, field: 'linkNeeds', line: 1 }]);
    pickCandidateLine(cfg.storiesDir, listed(), off(2, 'expects', 2));
    pickCandidateLine(cfg.storiesDir, listed(), off(2, 'expects', 2));
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.offLines, [{ step: 2, field: 'expects', line: 2 }, { step: 3, field: 'linkNeeds', line: 1 }]);
    assert.deepEqual({ ...written, offLines: undefined }, { ...JSON.parse(before), offLines: undefined });
    assert.deepEqual(storyCandidates(cfg, map, MAP_FILE).notices, []);
    assert.deepEqual(listed().lines!.map((l) => l.on), [true, false, true, false]);
    pickCandidateLine(cfg.storiesDir, listed(), on(2, 'expects', 2));
    pickCandidateLine(cfg.storiesDir, listed(), on(3, 'linkNeeds', 1));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('accepting a candidate from a comment writes of the agent\'s lines only those switched on, and the reviewer\'s lines as they are, keeps only those in the source of the story, and unaccepting lists the candidate file again with the lines switched off as they were', () => {
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, comment, post }) => {
    post({ screens: PICK_SCREENS });
    const listed = () => storyCandidates(cfg, map, MAP_FILE).list;
    for (const line of [off(2, 'expects', 1), off(2, 'expects', 2), off(3, 'needs', 1)]) pickCandidateLine(cfg.storiesDir, listed()[0], line);
    acceptCandidate(cfg.storiesDir, listed()[0], { id: 'lab', name: '로그인해 실험을 연다', author: 'hit' });
    const story = JSON.parse(fs.readFileSync(path.join(cfg.storiesDir, 'lab.json'), 'utf8'));
    assert.deepEqual(story.screens, [
      { screen: '/signin#SignIn', inputs: [EMAIL_INPUT] },
      '/home#Home',
      { screen: '/lab#Lab', linkNeeds: ['홈에서 실험을 누른다'], expects: ['실험 목록이 보인다'] },
    ]);
    assert.deepEqual(story.source, { comment, added: [{ step: 2, reason: THROUGH_HOME }], written: [{ step: 3, linkNeeds: ['홈에서 실험을 누른다'] }] });
    assert.deepEqual(loadStories(cfg.storiesDir).notices, []);
    unacceptStory(cfg.storiesDir, 'lab');
    assert.deepEqual(listed()[0].lines!.map((l) => l.on), [false, false, false, true]);
  });
});

test('a line the reviewer changed in a story from a comment has no box on the candidate written when the acceptance of the reordered story is undone, while a line of the agent left as it was keeps its box on the row it sits on', () => {
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, post }) => {
    post({ screens: PICK_SCREENS });
    const reordered = [...PICK_SCREENS.map((s) => s.screen), '/help#Help'];
    const listed = () => storyCandidates(cfg, map, MAP_FILE).list.find((c) => isDeepStrictEqual(c.screens, reordered))!;
    acceptCandidate(cfg.storiesDir, storyCandidates(cfg, map, MAP_FILE).list[0], { id: 'lab', name: '로그인해 실험을 연다', author: 'hit' });
    const read = () => loadStories(cfg.storiesDir).stories[0];
    writeStoryFields(cfg.storiesDir, 'lab', { place: { kind: 'step', step: 2, screen: '/home#Home' }, fields: { expects: ['홈 화면이 보인다', '알림이 보인다'] }, contentHash: read().contentHash });
    writeStorySteps(cfg.storiesDir, 'lab', { steps: [...PICK_SCREENS.map((s, i) => ({ step: i + 1, screen: s.screen })), { screen: '/help#Help' }], contentHash: read().contentHash });
    unacceptStory(cfg.storiesDir, 'lab');
    assert.deepEqual(listed().lines!.filter((l) => l.step === 2), [{ step: 2, field: 'expects', line: 2, row: 1, on: true }]);
    pickCandidateLine(cfg.storiesDir, listed(), off(2, 'expects', 2));
    assert.throws(() => pickCandidateLine(cfg.storiesDir, listed(), off(2, 'expects', 1)), { message: '후보 「lab」에는 에이전트가 2 번째 단계의 expects 에 적은 1 번째 줄이 없습니다' });
    acceptCandidate(cfg.storiesDir, listed(), { id: 'lab-again', name: '로그인해 실험을 연다', author: 'hit' });
    assert.deepEqual(loadStories(cfg.storiesDir).stories[0].stepFields![1], { expects: ['홈 화면이 보인다'] });
  });
});

test('discarding a candidate from a comment and undoing the discard lists its lines switched off as they were', () => {
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, post }) => {
    post({ screens: PICK_SCREENS });
    const listed = () => storyCandidates(cfg, map, MAP_FILE).list;
    pickCandidateLine(cfg.storiesDir, listed()[0], off(3, 'needs', 1));
    discardCandidate(cfg.storiesDir, listed()[0], { reason: '실험은 따로 본다', author: 'hit' }, new Date('2026-10-21T03:00:00Z'));
    undiscardCandidate(cfg.storiesDir, PICK_SCREENS.map((s) => s.screen), { author: 'hit' }, new Date('2026-10-21T04:00:00Z'));
    assert.deepEqual(listed()[0].lines!.map((l) => l.on), [true, true, false, true]);
  });
});

test('picking a line is refused with why, writing nothing, on a candidate from a visit record, for a line the agent did not write, or without on as true or false, and candidates from other sources carry no lines', () => {
  const record = candidatesOf().list[0];
  assert.deepEqual(['lines' in record, 'file' in record], [false, false]);
  assert.throws(() => pickCandidateLine(EXAMPLE_STORIES, record, off(1, 'needs', 1)), { message: `후보 「${record.name}」는 에이전트가 올린 후보가 아니라 줄마다 고르지 않습니다` });
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, post }) => {
    const file = path.join(cfg.configDir, post({ screens: PICK_SCREENS }).file);
    const before = fs.readFileSync(file, 'utf8');
    const [candidate] = storyCandidates(cfg, map, MAP_FILE).list;
    const refusals: [Record<string, unknown>, string][] = [
      [off(1, 'inputs', 1), '후보 「로그인해 실험을 연다」에는 에이전트가 1 번째 단계의 inputs 에 적은 1 번째 줄이 없습니다'],
      [off(3, 'expects', 1), '후보 「로그인해 실험을 연다」에는 에이전트가 3 번째 단계의 expects 에 적은 1 번째 줄이 없습니다'],
      [off(2, 'expects', 3), '후보 「로그인해 실험을 연다」에는 에이전트가 2 번째 단계의 expects 에 적은 3 번째 줄이 없습니다'],
      [{ step: 2, field: 'expects', line: 1 }, 'on 은 받을 줄이면 true, 뺄 줄이면 false 여야 합니다'],
    ];
    for (const [input, message] of refusals) assert.throws(() => pickCandidateLine(cfg.storiesDir, candidate, input), { message }, message);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
});

test('a candidate file whose lines switched off are not lines the agent wrote, repeat one, are empty or sit on a candidate from a visit record is noted with why and not listed', () => {
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, post }) => {
    const file = path.join(cfg.configDir, post({ screens: PICK_SCREENS }).file);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const lines = 'offLines 는 받을 때 뺄 줄을 { "step", "field", "line" } 으로 하나씩, source 의 written 에 있는 줄만 겹치지 않게 적은 목록이어야 합니다';
    const cases: [object, string][] = [
      [{ offLines: [{ step: 1, field: 'inputs', line: 1 }] }, lines],
      [{ offLines: [{ step: 2, field: 'expects', line: 3 }] }, lines],
      [{ offLines: [{ step: 2, field: 'expects', line: 1 }, { step: 2, field: 'expects', line: 1 }] }, lines],
      [{ offLines: [{ step: 2, field: 'expects', line: 1, on: false }] }, lines],
      [{ offLines: [] }, lines],
      [{ source: { record: 'example-visits/open-help.json', steps: [1, 2] }, offLines: [{ step: 2, field: 'expects', line: 1 }] }, 'offLines 는 출처가 코멘트인 후보에만 둡니다'],
    ];
    for (const [patch, reason] of cases) {
      fs.writeFileSync(file, JSON.stringify({ ...stored, ...patch }));
      const { list, notices } = storyCandidates(cfg, map, MAP_FILE);
      assert.deepEqual([list, notices.map((n) => n.reason)], [[], [reason]], JSON.stringify(patch));
    }
  });
});

const SIGNIN = '/signin#SignIn';
const skipStart: SkipRule[] = [{ screen: SIGNIN, where: 'start' }];
const shownWith = (dir: string, candidateSkipScreens: object[], traced: Parameters<typeof storyCandidates>[3] = []) =>
  storyCandidates({ ...config, visitRecords: [dir], storiesDir: path.join(dir, 'stories'), candidateSkipScreens }, map, MAP_FILE, traced);

test('candidateSkipScreens defaults to none, and each rule names a screen and where it is taken out of the candidates, start, end or any', () => {
  assert.deepEqual(config.candidateSkipScreens, []);
  const rules = [{ screen: SIGNIN, where: 'start' }, { screen: HELP, where: 'end' }, { screen: HOME, where: 'any' }];
  withFolder({ 'config.json': { srcRoot: 'src', serverEndpoints: [], candidateSkipScreens: rules } }, (dir: string) => {
    assert.deepEqual(loadConfig(path.join(dir, 'config.json')).candidateSkipScreens, rules);
  });
  for (const candidateSkipScreens of [{}, [SIGNIN], [{ screen: SIGNIN }], [{ screen: SIGNIN, where: 'middle' }], [{ screen: '', where: 'any' }], [{ screen: SIGNIN, where: 'any', note: 'x' }]]) {
    withFolder({ 'config.json': { srcRoot: 'src', serverEndpoints: [], candidateSkipScreens } }, (dir: string) => {
      assert.throws(() => loadConfig(path.join(dir, 'config.json')), /candidateSkipScreens must be a list of \{ "screen", "where" \}/, JSON.stringify(candidateSkipScreens));
    });
  }
});

test('a rule may name the address of a step that matches no screen, which stays in the candidate as that address; only a rule screen that is neither on the map nor in a found order is reported as missed', () => {
  withFolder(recordsIn({ 'a.json': ['/home', '/beta/inbox', '/help'] }), (dir: string) => {
    const { list, missedRules } = shownWith(dir, [{ screen: '/beta/inbox', where: 'any' }, { screen: '/nowhere#Nowhere', where: 'any' }, { screen: HELP, where: 'start' }]);
    assert.deepEqual(list.map((c) => c.screens), [[HOME, HELP]]);
    assert.deepEqual(missedRules, ['/nowhere#Nowhere']);
  });
  withFolder({}, (dir: string) => {
    const traced = [{ report: 'r.json', title: 'opens the beta inbox', screens: [HOME, '/beta/inbox', HELP] }];
    const { list, missedRules } = shownWith(dir, [{ screen: '/beta/inbox', where: 'any' }], traced);
    assert.deepEqual([list.map((c) => c.screens), missedRules], [[[HOME, HELP]], []]);
  });
});

test('the count of candidates the rules cut takes in every found order a rule changed, on the list or not', () => {
  const visits = recordsIn({ 'a.json': ['/signin', '/home', '/help'], 'b.json': ['/home', '/signin', '/help'], 'c.json': ['/signin', '/home'], 'd.json': ['/signin'], 'e.json': ['/home', '/help', '/home'] });
  const files = { ...Object.fromEntries(Object.entries(visits).map(([name, body]) => [`visits/${name}`, body])), 'stories/home-only.json': { name: 'home', screens: [HOME], author: 'kim', date: '2026-11-03' } };
  withFolder(files, (dir: string) => {
    const { list, cutByRules } = storyCandidates({ ...config, visitRecords: [path.join(dir, 'visits')], storiesDir: path.join(dir, 'stories'), candidateSkipScreens: [{ screen: SIGNIN, where: 'any' }] }, map, MAP_FILE);
    assert.deepEqual(list.map((c) => c.screens), [[HOME, HELP], [HOME, HELP, HOME]]);
    assert.equal(cutByRules, 4);
  });
});

test('the count of candidates the rules cut takes in an order found only in a test and one found only in a candidate file', () => {
  withFolder({ 'candidates/2026-10-02-aaaaaaaa.json': { name: 'stored', screens: [SIGNIN, HOME], source: { record: 'gone.json', steps: [1, 2] }, date: '2026-10-02T00:00:00.000Z' } }, (dir: string) => {
    const cfg = { ...config, visitRecords: [], storiesDir: dir, candidateSkipScreens: [{ screen: SIGNIN, where: 'any' }] };
    const { list, cutByRules } = storyCandidates(cfg, map, MAP_FILE, [{ report: 'r.json', title: 'opens help', screens: [SIGNIN, HELP] }]);
    assert.deepEqual(list.map((c) => c.screens), [[HELP], [HOME]]);
    assert.equal(cutByRules, 2);
  });
});

test('accepting or discarding a candidate a rule changed does not lower the count of candidates the rules cut', () => {
  withFolder(recordsIn({ 'a.json': ['/signin', '/home', '/help'], 'b.json': ['/signin', '/help'] }), (dir: string) => {
    const cfg = { ...config, visitRecords: [dir], storiesDir: path.join(dir, 'stories'), candidateSkipScreens: [{ screen: SIGNIN, where: 'any' }] };
    const first = storyCandidates(cfg, map, MAP_FILE);
    assert.equal(first.cutByRules, 2);
    storeCandidates(cfg.storiesDir, first.list);
    const [homeHelp, help] = first.list;
    acceptCandidate(cfg.storiesDir, homeHelp, { id: 'home-help', name: 'home and help', author: 'kim' });
    discardCandidate(cfg.storiesDir, help, { reason: 'not a story', author: 'kim' });
    const after = storyCandidates(cfg, map, MAP_FILE);
    assert.deepEqual([after.list, after.cutByRules], [[], 2]);
  });
});

test('a rule takes its screen out of a candidate from a visit record where it says: start the screens at the head of the order that a start rule names, end those at its tail, any wherever it is; steps of one screen left side by side become one step, and the candidate keeps the order it was found in and the steps taken out', () => {
  withFolder(recordsIn({ 'a.json': ['/signin', '/home', '/signin', '/help'] }), (dir: string) => {
    const shown = (rules: object[]) => shownWith(dir, rules).list.map((c) => c.screens);
    assert.deepEqual(shown([]), [[SIGNIN, HOME, SIGNIN, HELP]]);
    assert.deepEqual(shown(skipStart), [[HOME, SIGNIN, HELP]]);
    assert.deepEqual(shown([{ screen: SIGNIN, where: 'end' }]), [[SIGNIN, HOME, SIGNIN, HELP]]);
    assert.deepEqual(shown([{ screen: HELP, where: 'end' }]), [[SIGNIN, HOME, SIGNIN]]);
    assert.deepEqual(shown([{ screen: SIGNIN, where: 'any' }]), [[HOME, HELP]]);
    assert.deepEqual(shown([{ screen: HOME, where: 'start' }, ...skipStart]), [[HELP]]);
    assert.deepEqual(shown([{ screen: HOME, where: 'any' }]), [[SIGNIN, HELP]]);

    const [started] = shownWith(dir, skipStart).list;
    assert.deepEqual([started.key, started.stepRanges, started.skippedByRule], [`${HOME} > ${SIGNIN} > ${HELP}`, [[2, 2], [3, 3], [4, 4]], { found: [SIGNIN, HOME, SIGNIN, HELP], steps: [1] }]);
    const [joined] = shownWith(dir, [{ screen: HOME, where: 'any' }]).list;
    assert.deepEqual([joined.key, joined.stepRanges, joined.skippedByRule], [`${SIGNIN} > ${HELP}`, [[1, 3], [4, 4]], { found: [SIGNIN, HOME, SIGNIN, HELP], steps: [2] }]);
    assert.equal(shownWith(dir, []).list[0].skippedByRule, undefined);
  });
});

test('candidates whose orders are the same once the rules took screens out are one candidate: the first visit record in path order, and the tests of a trace with every title in its source; a candidate the rules take every screen out of is not listed', () => {
  withFolder(recordsIn({ 'a.json': ['/signin', '/help'], 'b.json': ['/help'], 'c.json': ['/signin'] }), (dir: string) => {
    assert.deepEqual(shownWith(dir, skipStart).list.map((c) => [c.name, c.screens]), [['a', [HELP]]]);
  });
  withFolder({}, (dir: string) => {
    const report = 'results/playwright/e2e.json';
    const traced = [
      { report, title: 'logs in and opens help', screens: [SIGNIN, HELP] },
      { report, title: 'opens help', screens: [HELP] },
      { report, title: 'logs in only', screens: [SIGNIN] },
    ];
    assert.deepEqual(shownWith(dir, skipStart, traced).list.map((c) => [c.name, c.screens, c.source, c.skippedByRule]), [
      ['logs in and opens help', [HELP], { report, tests: ['logs in and opens help', 'opens help'] }, { found: [SIGNIN, HELP], steps: [1] }],
    ]);
  });
});

test('the rules apply to stored candidate files each time the list is made, while the file keeps the order it was found in, and storing a candidate the rules changed writes that found order', () => {
  withStoryCopy((dir: string) => {
    fs.mkdirSync(path.join(dir, 'candidates'));
    const file = path.join(dir, 'candidates', '2026-10-01-aaaaaaaa.json');
    const old = { name: 'old', screens: [SIGNIN, HOME, HELP, '/document/:tab#DocumentList'], source: { report: 'results/old.json', tests: ['old'] }, date: '2026-10-01' };
    fs.writeFileSync(file, JSON.stringify(old));
    const listed = (candidateSkipScreens: object[]) => storyCandidates({ ...config, visitRecords: [], storiesDir: dir, candidateSkipScreens }, map, MAP_FILE, []).list.map((c) => [c.name, c.screens, c.skippedByRule]);
    assert.deepEqual(listed(skipStart), [['old', [HOME, HELP, '/document/:tab#DocumentList'], { found: old.screens, steps: [1] }]]);
    assert.deepEqual(listed([]), [['old', old.screens, undefined]]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old);
  });
  withFolder(recordsIn({ 'a.json': ['/signin', '/home', '/document/draft'] }), (dir: string) => {
    const stories = path.join(dir, 'stories');
    assert.deepEqual(storeCandidates(stories, shownWith(dir, skipStart).list), { written: 1 });
    const [name] = fs.readdirSync(path.join(stories, 'candidates'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stories, 'candidates', name), 'utf8')).screens, [SIGNIN, HOME, '/document/:tab#DocumentList']);
    assert.deepEqual(storeCandidates(stories, shownWith(dir, skipStart).list), { written: 0 });
    assert.deepEqual(shownWith(dir, skipStart).list.map((c) => c.screens), [[HOME, '/document/:tab#DocumentList']]);
  });
});

test('a candidate whose order once the rules took screens out is a story is not listed, the rules may name an address off the map, and a candidate from a comment keeps every screen', () => {
  assert.deepEqual(candidatesOf({ candidateSkipScreens: [{ screen: '/beta/inbox', where: 'any' }] }).list.map((c) => c.name), ['publish-document']);
  assert.deepEqual(candidatesOf({ candidateSkipScreens: [{ screen: '/beta/inbox', where: 'any' }, { screen: HELP, where: 'end' }] }).list.map((c) => c.screens), [[SIGNIN, HOME], [HOME, '/document/:tab#DocumentList', '/document/:id#DocumentDetail']]);
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, post }) => {
    post({});
    assert.deepEqual(storyCandidates({ ...cfg, candidateSkipScreens: skipStart }, map, MAP_FILE).list.map((c) => [c.screens, c.skippedByRule]), [[LAB_PATH, undefined]]);
  });
});

test('the usage guide names candidateSkipScreens with where each rule takes its screen out, and says under story candidates that changing a rule moves a comment on a candidate it changes under 「떨어져 나감」', () => {
  const readme = fs.readFileSync(path.join(import.meta.dirname, '../README.md'), 'utf8');
  const at = readme.indexOf('- `candidateSkipScreens` — ');
  assert.ok(at >= 0);
  const key = readme.slice(at, readme.indexOf('\n- `', at + 1));
  for (const word of ['`start`', '`end`', '`any`']) assert.ok(key.includes(word), word);
  assert.match(readme.slice(readme.indexOf('## Story candidates')), /candidateSkipScreens[^]*떨어져 나감/);
});

test('the rules reach the same order when they meet an order they already shortened, so a discarded candidate brought back is one candidate and not a second one that nobody walked', () => {
  const rules = [{ screen: HOME, where: 'any' }, { screen: SIGNIN, where: 'start' }];
  withFolder(recordsIn({ 'a.json': ['/home', '/signin', '/help'] }), (dir: string) => {
    const stories = path.join(dir, 'stories');
    const listed = () => storyCandidates({ ...config, visitRecords: [dir], storiesDir: stories, candidateSkipScreens: rules }, map, MAP_FILE, []).list.map((c) => c.screens);
    assert.deepEqual(listed(), [[HELP]]);
    assert.deepEqual(storeCandidates(stories, shownWith(dir, rules).list), { written: 1 });
    const [shown] = shownWith(dir, rules).list;
    discardCandidate(stories, shown, { reason: '잠깐 뺀다', author: 'reviewer' }, new Date('2026-10-03T00:00:00Z'));
    assert.deepEqual(listed(), []);
    undiscardCandidate(stories, shown.screens, { author: 'reviewer' }, new Date('2026-10-04T00:00:00Z'));
    assert.deepEqual(listed(), [[HELP]]);
  });
});

test('steps that the rules leave side by side become one step that keeps the needs, the link needs and the expects of every step, and inputs of the same box keep the value of the later step', () => {
  withStoryCopy((dir: string) => {
    fs.mkdirSync(path.join(dir, 'candidates'));
    const file = path.join(dir, 'candidates', '2026-10-01-bbbbbbbb.json');
    const stepFields = [
      { needs: ['first'], expects: ['one'], inputs: [{ box: { label: '메일' }, value: 'a@b' }] },
      {},
      { needs: ['second'], linkNeeds: ['third'], expects: ['two'], inputs: [{ box: { label: '메일' }, value: 'c@d' }] },
      {},
    ];
    fs.writeFileSync(file, JSON.stringify({ name: 'twice', screens: [SIGNIN, HOME, SIGNIN, HELP], stepFields, source: { report: 'results/twice.json', tests: ['twice'] }, date: '2026-10-01' }));
    const [shown] = storyCandidates({ ...config, visitRecords: [], storiesDir: dir, candidateSkipScreens: [{ screen: HOME, where: 'any' }] }, map, MAP_FILE, []).list;
    assert.deepEqual([shown.screens, shown.stepFields], [[SIGNIN, HELP], [
      { needs: ['first', 'second'], linkNeeds: ['third'], inputs: [{ box: { label: '메일' }, value: 'c@d' }], expects: ['one', 'two'] },
      {},
    ]]);
  });
});

const LAB = '/lab#Lab';
const NO_SIGNIN = '검토자가 모든 후보에서 로그인을 빼라고 했습니다';
const SEARCH_INPUT = { box: { label: '검색' }, value: '도움말' };
type Posted = ReturnType<typeof addCommentCandidate>;

function withReplaceable(records: Record<string, unknown>, fn: (ctx: {
  cfg: typeof config;
  comment: (target?: object) => string;
  post: (comment: string, input: Record<string, unknown>) => Posted;
  listed: (traced?: Parameters<typeof storyCandidates>[3]) => ReturnType<typeof storyCandidates>;
  stored: (posted: Posted) => any;
  files: () => string[];
}) => void) {
  withFolder(records, (dir: string) => {
    const cfg = { ...config, configDir: dir, visitRecords: [path.join(dir, 'visits')], storiesDir: path.join(dir, 'stories'), marksDir: path.join(dir, 'marks') };
    const comment = (target?: object) => addMark(cfg.marksDir, { ...(target ? { target } : { targets: [] }), note: '필요 없는 로그인 단계를 빼 줘', author: 'hit' }, new Date('2026-10-20T01:00:00Z')).id;
    const post = (id: string, input: Record<string, unknown>) => addCommentCandidate(cfg, map, MAP_FILE, [], { comment: id, ...input }, new Date('2026-10-21T02:00:00Z'));
    const listed = (traced: Parameters<typeof storyCandidates>[3] = []) => storyCandidates(cfg, map, MAP_FILE, traced);
    const stored = (posted: Posted) => JSON.parse(fs.readFileSync(path.join(dir, posted.file), 'utf8'));
    const folder = path.join(cfg.storiesDir, 'candidates');
    const files = () => (fs.existsSync(folder) ? fs.readdirSync(folder).sort() : []);
    fn({ cfg, comment, post, listed, stored, files });
  });
}

const HELP_VISITS = recordsIn({ 'visits/a.json': ['/signin', '/home', '/help'], 'visits/b.json': ['/signin', '/lab'] });

test('a candidate posted for a comment on a candidate is written with the originals it replaces, each with its order, the steps dropped with why and its own source, and those originals leave the list while it is listed, accepted or discarded, also when the records, the traces and the stored files give them again', () => {
  withReplaceable(HELP_VISITS, ({ cfg, comment, post, listed, stored }) => {
    const a = [SIGNIN, HOME, HELP];
    assert.deepEqual(storeCandidates(cfg.storiesDir, listed().list), { written: 2 });
    const id = comment({ candidate: a.join(' > ') });
    const posted = post(id, { name: '홈에서 도움말을 연다', screens: [HOME, HELP], replaces: [{ screens: a, dropped: [{ step: 1, reason: NO_SIGNIN }] }] });
    assert.deepEqual(stored(posted).source, {
      comment: id,
      added: [],
      written: [],
      replaces: [{ screens: a, dropped: [{ step: 1, reason: NO_SIGNIN }], source: { record: 'visits/a.json', steps: [1, 3] } }],
    });
    const report = 'results/playwright/e2e.json';
    const traced = [{ report, title: 'logs in and opens help', screens: a }];
    const names = (traced: Parameters<typeof storyCandidates>[3] = []) => listed(traced).list.map((c) => [c.name, c.screens]);
    assert.deepEqual(names(), [['b', [SIGNIN, LAB]], ['홈에서 도움말을 연다', [HOME, HELP]]]);
    assert.deepEqual(names(traced), names());
    assert.equal(listed().gone![a.join(' > ')], 'a');
    assert.deepEqual(storeCandidates(cfg.storiesDir, listed().list), { written: 0 });
    assert.deepEqual(names(), [['b', [SIGNIN, LAB]], ['홈에서 도움말을 연다', [HOME, HELP]]]);

    const replacement = listed().list[1];
    acceptCandidate(cfg.storiesDir, replacement, { id: 'help', name: replacement.name, author: 'hit' });
    assert.deepEqual(loadStories(cfg.storiesDir).stories.find((s) => s.id === 'help')!.source, stored(posted).source);
    assert.deepEqual(names(traced), [['b', [SIGNIN, LAB]]]);
    unacceptStory(cfg.storiesDir, 'help');
    discardCandidate(cfg.storiesDir, listed().list[1], { reason: '도움말은 따로 본다', author: 'hit' }, new Date('2026-10-21T03:00:00Z'));
    assert.deepEqual(names(traced), [['b', [SIGNIN, LAB]]]);
    undiscardCandidate(cfg.storiesDir, [HOME, HELP], { author: 'hit' }, new Date('2026-10-21T04:00:00Z'));
    assert.deepEqual(names(traced), [['b', [SIGNIN, LAB]], ['홈에서 도움말을 연다', [HOME, HELP]]]);
  });
});

test('one candidate may replace two originals that become the same order, keeping on each kept step the lines of the steps of both originals behind it, steps of one screen left side by side merged, and only the agent\'s own lines in written', () => {
  const records = {
    'visits/a.json': [{ url: '/signin' }, { url: '/home', inputs: [MEMO_INPUT] }, { url: '/help' }],
    'visits/c.json': [{ url: '/home' }, { url: '/signin' }, { url: '/home', inputs: [SEARCH_INPUT] }, { url: '/help' }],
  };
  withReplaceable(records, ({ comment, post, listed, stored }) => {
    const id = comment();
    const a = [SIGNIN, HOME, HELP];
    const c = [HOME, SIGNIN, HOME, HELP];
    const posted = post(id, {
      name: '홈에서 도움말을 연다',
      screens: [{ screen: HOME, inputs: [MEMO_INPUT] }, { screen: HELP, expects: ['도움말이 보인다'] }],
      replaces: [
        { screens: a, dropped: [{ step: 1, reason: NO_SIGNIN }] },
        { screens: c, dropped: [{ step: 2, reason: '홈 사이의 로그인은 시험 준비입니다', judged: true }] },
      ],
    });
    const file = stored(posted);
    assert.deepEqual(file.source.replaces.map((r: any) => [r.screens, r.dropped, r.source.record]), [
      [a, [{ step: 1, reason: NO_SIGNIN }], 'visits/a.json'],
      [c, [{ step: 2, reason: '홈 사이의 로그인은 시험 준비입니다', judged: true }], 'visits/c.json'],
    ]);
    assert.deepEqual(file.stepFields, [{ inputs: [MEMO_INPUT, SEARCH_INPUT] }, { expects: ['도움말이 보인다'] }]);
    assert.deepEqual(file.source.written, [{ step: 2, expects: ['도움말이 보인다'] }]);
    assert.deepEqual(listed().list.map((x) => [x.name, x.screens]), [['홈에서 도움말을 연다', [HOME, HELP]]]);
    assert.deepEqual(listed().list[0].lines, [{ step: 2, field: 'expects', line: 1, row: 0, on: true }]);
  });
});

test('several candidates may answer one comment with no target, and once one of them is accepted the others stay listed and another may still be posted', () => {
  withReplaceable(recordsIn({ 'visits/a.json': ['/signin', '/home', '/help'], 'visits/b.json': ['/signin', '/lab'], 'visits/d.json': ['/signin', '/home', '/lab'] }), ({ cfg, comment, post, listed, files }) => {
    const id = comment();
    const drop = (screens: string[]) => [{ screens, dropped: [{ step: 1, reason: NO_SIGNIN }] }];
    post(id, { name: '도움말', screens: [HOME, HELP], replaces: drop([SIGNIN, HOME, HELP]) });
    post(id, { name: '실험', screens: [LAB], replaces: drop([SIGNIN, LAB]) });
    const help = listed().list.find((c) => c.name === '도움말')!;
    acceptCandidate(cfg.storiesDir, help, { id: 'help', name: '도움말', author: 'hit' });
    assert.deepEqual(listed().list.map((c) => c.name), ['d', '실험']);
    post(id, { name: '홈에서 실험', screens: [HOME, LAB], replaces: drop([SIGNIN, HOME, LAB]) });
    assert.deepEqual(listed().list.map((c) => c.name), ['홈에서 실험', '실험']);
    assert.equal(files().length, 3);
  });
});

test('a candidate for a comment on a candidate or on nothing is refused with why, writing nothing, without the originals it replaces, with an original not listed, a step left out without a reason, the steps in another order, dropped steps that do not fit or an order already listed, while a candidate for a comment on a screen order takes no originals', () => {
  withReplaceable(HELP_VISITS, ({ cfg, comment, post, files }) => {
    const a = [SIGNIN, HOME, HELP];
    const where = `replaces 의 1 번째 원래 후보 ${a.join(' > ')}`;
    const id = comment({ candidate: a.join(' > ') });
    const general = comment();
    const order = comment({ screens: [SIGNIN, HELP] });
    const onNode = comment({ node: HOME });
    const replace = (dropped: unknown[], screens: string[] = a) => ({ screens, dropped });
    const signinOut = [{ step: 1, reason: NO_SIGNIN }];
    const refusals: [string, Record<string, unknown>, string][] = [
      [id, { screens: [HOME, HELP] }, `코멘트 ${id} 는 후보에 단 코멘트라 replaces 에 이 후보가 대신하는 원래 후보를 적어야 합니다`],
      [general, { screens: [HOME, HELP] }, `코멘트 ${general} 는 대상 없는 코멘트라 replaces 에 이 후보가 대신하는 원래 후보를 적어야 합니다`],
      [order, { screens: [SIGNIN, HELP], replaces: [replace(signinOut)] }, `코멘트 ${order} 는 화면 순서에 단 코멘트라 replaces 를 적지 않습니다`],
      [onNode, { screens: [HOME, HELP], replaces: [replace(signinOut)] }, `코멘트 ${onNode} 는 화면 순서나 후보에 단 코멘트도, 대상 없는 코멘트도 아닙니다`],
      [id, { screens: [HELP], replaces: [replace(signinOut, [SIGNIN, HELP])] }, `replaces 의 1 번째 원래 후보 ${SIGNIN} > ${HELP} 는 지금 후보 목록에 없습니다`],
      [id, { screens: [HELP], replaces: [replace(signinOut)] }, `${where} 의 2 번째 단계 ${HOME} 가 이유 없이 빠졌습니다. 뺀 단계는 dropped 에 step 과 reason 으로 적습니다`],
      [id, { screens: [HELP, HOME], replaces: [replace(signinOut)] }, `이유를 적지 않은 단계의 차례가 ${where} 에서 dropped 의 단계를 뺀 순서 ${HOME} > ${HELP} 와 다릅니다. 원래 후보의 단계는 차례를 바꾸지 않습니다`],
      [id, { screens: [HOME, LAB], replaces: [replace(signinOut)] }, `이유를 적지 않은 단계는 ${where} 에서 dropped 의 단계를 뺀 순서 ${HOME} > ${HELP} 그대로여야 합니다. 에이전트가 넣은 화면에는 reason 에 이유를 적습니다`],
      [id, { screens: a, replaces: [replace([])] }, '이미 후보 「a」의 화면 순서입니다'],
      [id, { screens: [HELP], replaces: [replace([{ step: 4, reason: 'x' }])] }, 'replaces 의 1 번째 원래 후보의 dropped 의 1 번째의 step 은 원래 순서의 1 번째부터 3 번째까지의 단계 번호여야 합니다'],
      [id, { screens: [HOME, HELP], replaces: [replace([{ step: 1 }])] }, 'replaces 의 1 번째 원래 후보의 dropped 의 1 번째의 reason 에 이 단계를 뺀 이유를 적어야 합니다'],
      [id, { screens: [HOME, HELP], replaces: [replace([{ step: 1, reason: 'x', judged: false }])] }, 'replaces 의 1 번째 원래 후보의 dropped 의 1 번째의 judged 는 검토자가 시키지 않았는데 뺀 단계에만 true 로 적습니다'],
      [id, { screens: [HOME, HELP], replaces: [replace([...signinOut, ...signinOut])] }, 'replaces 의 1 번째 원래 후보의 dropped 에 1 번째 단계가 두 번 있습니다'],
      [id, { screens: [HOME, HELP], replaces: [replace([1, 2, 3].map((step) => ({ step, reason: 'x' })))] }, 'replaces 의 1 번째 원래 후보의 단계를 모두 뺄 수는 없습니다'],
      [id, { screens: [HOME, HELP], replaces: [replace(signinOut), replace(signinOut)] }, `replaces 에 원래 후보 ${a.join(' > ')} 가 두 번 있습니다`],
      [id, { screens: [HOME, HELP], replaces: [] }, 'replaces 는 이 후보가 대신하는 원래 후보를 { "screens": 지금 목록에 있는 그 후보의 화면 순서, "dropped": [{ "step", "reason", "judged" }, ...] } 로 하나 이상 담은 목록이어야 합니다'],
      [id, { screens: [HOME, HELP], replaces: [{ screens: a }] }, 'replaces 는 이 후보가 대신하는 원래 후보를 { "screens": 지금 목록에 있는 그 후보의 화면 순서, "dropped": [{ "step", "reason", "judged" }, ...] } 로 하나 이상 담은 목록이어야 합니다'],
    ];
    for (const [comment, input, message] of refusals) assert.throws(() => post(comment, { name: '홈에서 도움말을 연다', ...input }), { message }, message);
    assert.deepEqual(files(), []);
    assert.ok(fs.existsSync(cfg.marksDir));
  });
});

test('a story file whose comment source names originals that do not fit is noted with the shapes a source may take, and read once they fit', () => {
  const source = { comment: 'c1', added: [], written: [], replaces: [{ screens: [SIGNIN, HOME], dropped: [{ step: 3, reason: 'x' }], source: { record: 'visits/a.json', steps: [1, 2] } }] };
  withFolder({ 'stories/help.json': { name: '도움말', screens: [HOME], memo: '', author: 'hit', date: '2026-10-01', source } }, (dir: string) => {
    const [notice] = loadStories(path.join(dir, 'stories')).notices;
    assert.match(notice.reason, /"replaces": \[\{ "screens", "dropped": \[\{ "step", "reason", "judged" \}, \.\.\.\], "source" \}, \.\.\.\]/);
    const fits = { ...source, replaces: [{ ...source.replaces[0], dropped: [{ step: 1, reason: 'x', judged: true }] }] };
    fs.writeFileSync(path.join(dir, 'stories/help.json'), JSON.stringify({ name: '도움말', screens: [HOME], memo: '', author: 'hit', date: '2026-10-01', source: fits }));
    assert.deepEqual(loadStories(path.join(dir, 'stories')).notices, []);
  });
});

test('a candidate may not take the order of an original another candidate replaces, because it would hide itself and the one it replaces', () => {
  withReplaceable(HELP_VISITS, ({ comment, post, listed, files }) => {
    const a = [SIGNIN, HOME, HELP];
    post(comment({ candidate: a.join(' > ') }), { name: '홈에서 도움말을 연다', screens: [HOME, HELP], replaces: [{ screens: a, dropped: [{ step: 1, reason: NO_SIGNIN }] }] });
    const asked = comment({ candidate: [HOME, HELP].join(' > ') });
    assert.throws(() => post(asked, { name: '로그인부터', screens: [{ screen: SIGNIN, reason: '로그인이 필요합니다' }, HOME, HELP], replaces: [{ screens: [HOME, HELP], dropped: [] }] }),
      { message: '이 화면 순서는 다른 후보가 이미 대신한 원래 후보의 순서입니다' });
    assert.equal(files().length, 1);
    assert.deepEqual(listed().list.map((c) => c.name), ['b', '홈에서 도움말을 연다']);
  });
});

test('a candidate that replaces an agent\'s candidate leaves out the lines the reviewer turned off and keeps the other lines of that agent as lines the reviewer can turn off', () => {
  withReplaceable(HELP_VISITS, ({ cfg, comment, post, listed, stored }) => {
    post(comment({ screens: [HOME, LAB] }), { name: '실험', screens: [HOME, { screen: LAB, expects: ['틀린 줄', '맞는 줄'] }] });
    const agents = () => listed().list.find((c) => c.name === '실험')!;
    pickCandidateLine(cfg.storiesDir, agents(), { step: 2, field: 'expects', line: 1, on: false });
    const posted = post(comment({ candidate: [HOME, LAB].join(' > ') }), { name: '실험만', screens: [LAB], replaces: [{ screens: [HOME, LAB], dropped: [{ step: 1, reason: '시험 준비입니다' }] }] });
    const file = stored(posted);
    assert.deepEqual(file.stepFields, [{ expects: ['맞는 줄'] }]);
    assert.deepEqual(file.source.written, [{ step: 1, expects: ['맞는 줄'] }]);
    assert.deepEqual(listed().list.find((c) => c.name === '실험만')!.lines, [{ step: 1, field: 'expects', line: 1, row: 0, on: true }]);
  });
});

test('a candidate that replaces others carries how many inputs each of them could not move', () => {
  const records = {
    'visits/a.json': [{ url: '/signin' }, { url: '/home', skipped: 2 }, { url: '/help' }],
    'visits/c.json': [{ url: '/lab' }, { url: '/home', skipped: 1 }, { url: '/help' }],
  };
  withReplaceable(records, ({ comment, post, listed, stored }) => {
    const drop = (screens: string[]) => ({ screens, dropped: [{ step: 1, reason: '시험 준비입니다' }] });
    const posted = post(comment(), { name: '홈에서 도움말을 연다', screens: [HOME, HELP], replaces: [drop([SIGNIN, HOME, HELP]), drop([LAB, HOME, HELP])] });
    assert.equal(stored(posted).skipped, 3);
    assert.equal(listed().list[0].skipped, 3);
  });
});

test('originals that typed different values into one box are refused until the agent writes the value to keep', () => {
  const typed = (value: string) => ({ box: { label: '메모' }, value });
  const records = {
    'visits/a.json': [{ url: '/signin' }, { url: '/home', inputs: [typed('하나')] }, { url: '/help' }],
    'visits/c.json': [{ url: '/lab' }, { url: '/home', inputs: [typed('둘')] }, { url: '/help' }],
  };
  withReplaceable(records, ({ comment, post, files, stored }) => {
    const id = comment();
    const drop = (screens: string[]) => ({ screens, dropped: [{ step: 1, reason: '시험 준비입니다' }] });
    const replaces = [drop([SIGNIN, HOME, HELP]), drop([LAB, HOME, HELP])];
    assert.throws(() => post(id, { name: '홈에서 도움말을 연다', screens: [HOME, HELP], replaces }),
      { message: `screens 의 1 번째 단계 ${HOME} 의 입력칸 {"label":"메모"} 에 원래 후보들의 값이 서로 다릅니다. 이 단계의 inputs 에 남길 값을 적습니다` });
    assert.deepEqual(files(), []);
    const posted = post(id, { name: '홈에서 도움말을 연다', screens: [{ screen: HOME, inputs: [typed('둘')] }, HELP], replaces });
    assert.deepEqual(stored(posted).stepFields[0].inputs, [typed('둘')]);
  });
});

test('an original stays out of the list after candidateSkipScreens changes its order, from a record and from a stored file', () => {
  withReplaceable(HELP_VISITS, ({ cfg, comment, post }) => {
    const a = [SIGNIN, HOME, HELP];
    post(comment({ candidate: a.join(' > ') }), { name: '홈에서 도움말을 연다', screens: [HOME, HELP], replaces: [{ screens: a, dropped: [{ step: 1, reason: NO_SIGNIN }] }] });
    const names = () => storyCandidates({ ...cfg, candidateSkipScreens: [{ screen: HELP, where: 'any' }] }, map, MAP_FILE).list.map((c) => c.name);
    assert.deepEqual(names(), ['b', '홈에서 도움말을 연다']);
    storeCandidates(cfg.storiesDir, storyCandidates(cfg, map, MAP_FILE).list);
    assert.deepEqual(names(), ['b', '홈에서 도움말을 연다']);
  });
});

test('replacing one of the candidates answering a comment on a screen order leaves the others from that comment listed', () => {
  withReplaceable(HELP_VISITS, ({ comment, post, listed }) => {
    const asked = comment({ screens: [HOME, LAB] });
    post(asked, { name: '첫째', screens: [HOME, { screen: HELP, reason: '도움말을 거칩니다' }, LAB] });
    post(asked, { name: '둘째', screens: [HOME, { screen: SIGNIN, reason: '다시 로그인합니다' }, LAB] });
    post(comment({ candidate: [HOME, HELP, LAB].join(' > ') }), { name: '첫째를 고침', screens: [HELP, LAB], replaces: [{ screens: [HOME, HELP, LAB], dropped: [{ step: 1, reason: '시험 준비입니다' }] }] });
    assert.deepEqual(listed().list.map((c) => c.name).filter((n) => n !== 'a' && n !== 'b').sort(), ['둘째', '첫째를 고침']);
  });
});

test('a candidate that replaces another must drop the steps the reviewer took out of it with ✕', () => {
  withReplaceable(HELP_VISITS, ({ cfg, comment, post, listed, stored }) => {
    const a = [SIGNIN, HOME, HELP];
    pickCandidateStep(cfg.storiesDir, listed().list.find((c) => c.name === 'a')!, { step: 2, on: false });
    const id = comment({ candidate: a.join(' > ') });
    assert.throws(() => post(id, { name: '홈부터', screens: [HOME, HELP], replaces: [{ screens: a, dropped: [{ step: 1, reason: NO_SIGNIN }] }] }),
      { message: `replaces 의 1 번째 원래 후보 ${a.join(' > ')} 의 2 번째 단계는 검토자가 ✕ 로 뺐습니다. dropped 에 step 과 reason 으로 적습니다` });
    const posted = post(id, { name: '도움말만', screens: [HELP], replaces: [{ screens: a, dropped: [{ step: 1, reason: NO_SIGNIN }, { step: 2, reason: '검토자가 뺐습니다' }] }] });
    assert.deepEqual(stored(posted).screens, [HELP]);
  });
});

test('the usage guide and the agent skill give duru candidate the same replaces input, each original with screens and its dropped steps with step, reason and judged, and the guide says the originals stay out of the list while the new candidate is listed, accepted or discarded', () => {
  const readme = fs.readFileSync(path.join(import.meta.dirname, '../README.md'), 'utf8');
  const skill = fs.readFileSync(path.join(import.meta.dirname, '../skills/duru/SKILL.md'), 'utf8');
  const guide = readme.slice(readme.indexOf('**Candidates that replace others.**'), readme.indexOf('## Review page'));
  for (const text of [guide, skill]) {
    const part = text.slice(text.indexOf('`replaces`'));
    for (const name of ['screens', 'dropped', 'step', 'reason', 'judged: true']) assert.match(part, new RegExp(`[\`"]${name}[\`"]`), name);
    assert.match(text, /A comment on a screen order takes no `replaces`/);
  }
  assert.match(guide, /While the new candidate is listed, accepted or discarded, the candidates it replaces are not\s+listed, even after a `rebuild`/);
  assert.match(guide, /「원래 순서 N」[^]*「판단」/);
});

const stepOff = (step: number) => ({ step, on: false });
const HOME_HELP_DRAFTS = ['/home#Home', '/help#Help', '/document/:tab#DocumentList'];
const stepOn = (step: number) => ({ step, on: true });
const helpOf = (dir: string) => candidatesOf({ storiesDir: dir }).list.find((c) => c.name === 'open-help')!;
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a step taken out of a candidate with ✕ is written into its candidate file as offSteps, the file written first for a candidate not stored yet, read back on the candidate from a visit record, and putting every step back leaves the file as it was stored', () => {
  withStoryCopy((dir: string) => {
    assert.equal(helpOf(dir).offSteps, undefined);
    const picked = pickCandidateStep(dir, helpOf(dir), stepOff(3));
    assert.match(picked.file, /^candidates\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.json$/);
    assert.deepEqual(picked.offSteps, [3]);
    const file = path.join(dir, picked.file);
    const { offSteps, ...stored } = readJson(file);
    assert.deepEqual([stored.name, stored.screens, stored.source, offSteps], ['open-help', helpOf(dir).screens, { record: 'example-visits/open-help.json', steps: [1, 5] }, [3]]);
    assert.deepEqual(helpOf(dir).offSteps, [3]);
    pickCandidateStep(dir, helpOf(dir), stepOff(1));
    pickCandidateStep(dir, helpOf(dir), stepOff(1));
    assert.deepEqual(readJson(file).offSteps, [1, 3]);
    assert.deepEqual(helpOf(dir).offSteps, [1, 3]);
    assert.equal(fs.readdirSync(path.join(dir, 'candidates')).length, 1);
    pickCandidateStep(dir, helpOf(dir), stepOn(3));
    assert.deepEqual(pickCandidateStep(dir, helpOf(dir), stepOn(1)).offSteps, []);
    assert.deepEqual(readJson(file), stored);
    assert.equal(helpOf(dir).offSteps, undefined);
    assert.deepEqual(candidatesOf({ storiesDir: dir }).notices.map((n) => n.file), ['example-visits/broken-record.json']);
  });
});

test('taking a step out of a candidate is refused with why for a step the candidate does not have, an on that is not true or false, and the last step left, and writes nothing', () => {
  withStoryCopy((dir: string) => {
    const refusals: [object, string][] = [
      [stepOff(5), '후보 「open-help」에는 5 번째 단계가 없습니다'],
      [stepOff(0), '후보 「open-help」에는 0 번째 단계가 없습니다'],
      [{ step: '2', on: false }, '후보 「open-help」에는 2 번째 단계가 없습니다'],
      [{ step: 2, on: 'off' }, 'on 은 넣을 단계면 true, 뺄 단계면 false 여야 합니다'],
    ];
    for (const [pick, message] of refusals) assert.throws(() => pickCandidateStep(dir, helpOf(dir), pick), { message });
    assert.equal(fs.existsSync(path.join(dir, 'candidates')), false);
    for (const step of [1, 2, 3]) pickCandidateStep(dir, helpOf(dir), stepOff(step));
    const [name] = fs.readdirSync(path.join(dir, 'candidates'));
    const before = fs.readFileSync(path.join(dir, 'candidates', name), 'utf8');
    assert.throws(() => pickCandidateStep(dir, helpOf(dir), stepOff(4)), { message: '후보 「open-help」의 마지막 남은 단계는 뺄 수 없습니다' });
    assert.equal(fs.readFileSync(path.join(dir, 'candidates', name), 'utf8'), before);
  });
});

test('a stored candidate whose offSteps are not step numbers of its screens from the smallest, each once, leaving one step or more, is noted with the candidates, and one that fits is listed with them', () => {
  const OFF_STEPS = 'offSteps 는 받을 때 뺄 단계의 번호를 1 부터 세어 작은 것부터 하나씩 적은 목록이어야 하고, 단계를 하나 이상 남겨야 합니다';
  for (const offSteps of [[], [2, 1], [1, 1], [3], [1, 2], ['2'], 2]) {
    withStoryCopy((dir: string) => {
      fs.mkdirSync(path.join(dir, 'candidates'));
      fs.writeFileSync(path.join(dir, 'candidates', '2026-10-01-aaaaaaaa.json'), JSON.stringify({ name: 'old', screens: HOME_HELP, source: { report: 'results/old.json', tests: ['old'] }, date: '2026-10-01', offSteps }));
      const { list, notices } = leftOnlyStored(dir);
      assert.deepEqual([list, notices.map((n) => n.reason)], [[], [OFF_STEPS]], JSON.stringify(offSteps));
    });
  }
  withStoryCopy((dir: string) => {
    fs.mkdirSync(path.join(dir, 'candidates'));
    fs.writeFileSync(path.join(dir, 'candidates', '2026-10-01-aaaaaaaa.json'), JSON.stringify({ name: 'old', screens: HOME_HELP, source: { report: 'results/old.json', tests: ['old'] }, date: '2026-10-01', offSteps: [1] }));
    const { list, notices } = leftOnlyStored(dir);
    assert.deepEqual([list.map((c) => c.offSteps), notices], [[[1]], []]);
  });
});

test('accepting a candidate with steps taken out writes only the steps left into the story file, with the source of the candidate, and the candidate does not come back, also after the candidates are stored again', () => {
  withStoryCopy((dir: string) => {
    pickCandidateStep(dir, helpOf(dir), stepOff(3));
    acceptCandidate(dir, helpOf(dir), { id: 'open-help', name: '홈에서 도움말을 연다', author: 'reviewer' }, new Date('2026-10-03T01:02:03Z'));
    const written = readJson(path.join(dir, 'open-help.json'));
    assert.deepEqual([written.screens, written.source], [['/signin#SignIn', '/home#Home', '/help#Help'], { record: 'example-visits/open-help.json', steps: [1, 5] }]);
    assert.equal('offSteps' in written, false);
    assert.deepEqual(loadStories(dir).notices.map((n) => n.file), ['lab-shortcut.json']);
    assert.deepEqual(candidatesOf({ storiesDir: dir }).list.map((c) => c.name), ['publish-document']);
    storeCandidates(dir, candidatesOf({ storiesDir: dir }).list);
    assert.deepEqual(candidatesOf({ storiesDir: dir }).list.map((c) => c.name), ['publish-document']);
    assert.deepEqual(leftOnlyStored(dir).list.map((c) => c.name), ['publish-document']);
  });
});

test('accepting a candidate from a comment with a step taken out keeps the values of the steps left, and the agent\'s reasons and lines on the screens they were on, as a story whose step is taken out does', () => {
  withOrderComment({ screens: LAB_ORDER, steps: ASKED_STEPS }, ({ cfg, comment, post }) => {
    post({});
    const listed = () => storyCandidates(cfg, map, MAP_FILE).list;
    pickCandidateStep(cfg.storiesDir, listed()[0], stepOff(2));
    assert.deepEqual(listed()[0].offSteps, [2]);
    acceptCandidate(cfg.storiesDir, listed()[0], { id: 'lab', name: '로그인해 실험을 연다', author: 'hit' });
    const story = readJson(path.join(cfg.storiesDir, 'lab.json'));
    assert.deepEqual(story.screens, [{ screen: '/signin#SignIn', inputs: [EMAIL_INPUT] }, { screen: '/lab#Lab', needs: ['실험 메뉴가 켜져 있다'], expects: ['실험 목록이 보인다'] }]);
    assert.deepEqual(story.source, { comment, added: [], written: [{ step: 2, needs: ['실험 메뉴가 켜져 있다'] }] });
    assert.deepEqual(loadStories(cfg.storiesDir).notices, []);
    assert.deepEqual(listed(), []);
  });
});

test('with two candidate files of one screen order, a step is taken out in the one the list shows, the one first seen, whichever comes first by file name', () => {
  for (const [early, late] of [['2026-10-01-aaaaaaaa.json', '2026-10-01-bbbbbbbb.json'], ['2026-10-01-bbbbbbbb.json', '2026-10-01-aaaaaaaa.json']]) {
    withStoryCopy((dir: string) => {
      fs.mkdirSync(path.join(dir, 'candidates'));
      const old = { screens: HOME_HELP, source: { report: 'results/old.json', tests: ['old'] } };
      fs.writeFileSync(path.join(dir, 'candidates', early), JSON.stringify({ ...old, name: 'first seen', date: '2026-10-01T01:00:00.000Z' }));
      fs.writeFileSync(path.join(dir, 'candidates', late), JSON.stringify({ ...old, name: 'seen later', date: '2026-10-01T02:00:00.000Z' }));
      const [listed] = leftOnlyStored(dir).list;
      assert.equal(listed.name, 'first seen', early);
      assert.equal(pickCandidateStep(dir, listed, stepOff(1)).file, path.join('candidates', early), early);
      assert.deepEqual(leftOnlyStored(dir).list.map((c) => [c.name, c.offSteps]), [['first seen', [1]]], early);
      assert.equal('offSteps' in readJson(path.join(dir, 'candidates', late)), false, early);
    });
  }
});

test('undoing the acceptance of a candidate with steps taken out gives back that candidate once, with the same steps taken out, and writes no second candidate file', () => {
  withStoryCopy((dir: string) => {
    pickCandidateStep(dir, helpOf(dir), stepOff(1));
    const files = () => fs.readdirSync(path.join(dir, 'candidates')).sort();
    const before = files();
    acceptCandidate(dir, helpOf(dir), { id: 'open-help', name: '홈에서 도움말을 연다', author: 'reviewer' });
    assert.deepEqual(readJson(path.join(dir, 'open-help.json')).screens, ['/home#Home', '/beta/inbox', '/help#Help']);
    unacceptStory(dir, 'open-help');
    assert.deepEqual(files(), before);
    assert.deepEqual(candidatesOf({ storiesDir: dir }).list.map((c) => [c.name, c.screens.length, c.offSteps]), [['open-help', 4, [1]], ['publish-document', 4, undefined]]);
  });
});

test('taking a step out of a candidate not stored yet, with a candidates entry that is a file in the stories folder, is refused with why', () => {
  withStoryCopy((dir: string) => {
    fs.writeFileSync(path.join(dir, 'candidates'), 'a file');
    assert.throws(() => pickCandidateStep(dir, helpOf(dir), stepOff(1)), { message: '스토리 폴더 안 candidates 가 파일이라 후보 파일을 쓸 수 없습니다' });
  });
});

test('a candidate from a trace accepted with a step taken out leaves the list, also once another test of that report passes the same order, and undoing the acceptance gives it back once with the step still taken out', () => {
  withFolder({}, (dir: string) => {
    const report = 'results/playwright/e2e.json';
    const settings = { ...config, visitRecords: [], storiesDir: dir };
    const first = [{ report, title: 'opens help from home', screens: [SIGNIN, '/home#Home', '/help#Help'] }];
    const grown = [...first, { report, title: 'opens help again', screens: [SIGNIN, '/home#Home', '/help#Help'] }];
    const listed = (traced: typeof first) => storyCandidates(settings, map, MAP_FILE, traced).list;
    storeCandidates(dir, listed(first));
    pickCandidateStep(dir, listed(first)[0], stepOff(1));
    acceptCandidate(dir, listed(first)[0], { id: 'help', name: '홈에서 도움말을 연다', author: 'reviewer' });
    assert.deepEqual(listed(first), []);
    assert.deepEqual(listed(grown), []);
    assert.deepEqual(listed([...grown].reverse()), []);
    storeCandidates(dir, listed(grown));
    unacceptStory(dir, 'help');
    assert.deepEqual(listed(grown).map((c) => [c.screens.length, c.offSteps]), [[3, [1]]]);
    assert.equal(fs.readdirSync(path.join(dir, 'candidates')).length, 1);
  });
});

test('once a candidate is accepted with a step taken out, another candidate file of that order leaves the list and the accepted file keeps its steps taken out', () => {
  withStoryCopy((dir: string) => {
    fs.mkdirSync(path.join(dir, 'candidates'));
    const accepted = path.join(dir, 'candidates', '2026-10-01-aaaaaaaa.json');
    const other = path.join(dir, 'candidates', '2026-10-02-bbbbbbbb.json');
    fs.writeFileSync(accepted, JSON.stringify({ name: 'accepted', screens: HOME_HELP_DRAFTS, source: { report: 'results/a.json', tests: ['accepted'] }, date: '2026-10-01', offSteps: [1] }));
    fs.writeFileSync(other, JSON.stringify({ name: 'other', screens: HOME_HELP_DRAFTS, source: { report: 'results/b.json', tests: ['other'] }, date: '2026-10-02' }));
    const listed = () => leftOnlyStored(dir).list;
    acceptCandidate(dir, listed()[0], { id: 'accepted', name: 'accepted', author: 'reviewer' });
    assert.deepEqual(listed(), []);
    assert.deepEqual(readJson(accepted).offSteps, [1]);
    assert.equal(readJson(other).offSteps, undefined);
  });
});

test('the usage guide says a step of a candidate taken out with ✕ is kept in the candidate file as offSteps and left out of the story accepted from it', () => {
  const readme = fs.readFileSync(path.join(import.meta.dirname, '../README.md'), 'utf8');
  const candidates = readme.slice(readme.indexOf('## Story candidates'));
  assert.match(candidates, /✕/);
  assert.match(candidates, /`offSteps`/);
});

const DRAFTS = '/document/:tab#DocumentList';

test('steps of one screen a ✕ leaves side by side become one step of the story, and undoing brings the one candidate back', () => {
  withFolder(recordsIn({ 'a.json': ['/home', '/help', '/home', '/signin'] }), (dir: string) => {
    const stories = path.join(dir, 'stories');
    const listed = () => shownWith(dir, []).list;
    pickCandidateStep(stories, listed()[0], stepOff(2));
    acceptCandidate(stories, listed()[0], { id: 'a', name: '홈에서 로그인', author: 'reviewer' });
    assert.deepEqual(readJson(path.join(stories, 'a.json')).screens, [HOME, SIGNIN]);
    unacceptStory(stories, 'a');
    assert.deepEqual(listed().map((c) => [c.screens, c.offSteps]), [[[HOME, HELP, HOME, SIGNIN], [2]]]);
    assert.equal(fs.readdirSync(path.join(stories, 'candidates')).length, 1);
  });
  const screens = [{ screen: HOME, expects: ['홈이 보인다'] }, { screen: HELP }, { screen: HOME, expects: ['홈이 또 보인다'] }];
  withOrderComment({ screens: [HOME, HELP, HOME] }, ({ cfg, post }) => {
    post({ screens });
    const [candidate] = storyCandidates(cfg, map, MAP_FILE).list;
    pickCandidateStep(cfg.storiesDir, candidate, stepOff(2));
    acceptCandidate(cfg.storiesDir, storyCandidates(cfg, map, MAP_FILE).list[0], { id: 'b', name: '홈', author: 'hit' });
    const [story] = loadStories(cfg.storiesDir).stories;
    assert.deepEqual(story.screens, [HOME]);
    assert.deepEqual(story.stepFields?.[0].expects, ['홈이 보인다', '홈이 또 보인다']);
    assert.deepEqual(loadStories(cfg.storiesDir).notices, []);
  });
});

const acceptWithOff = (cfg: typeof config, step: number) => {
  pickCandidateStep(cfg.storiesDir, storyCandidates(cfg, map, MAP_FILE).list[0], stepOff(step));
  acceptCandidate(cfg.storiesDir, storyCandidates(cfg, map, MAP_FILE).list[0], { id: 'joined', name: '합친 단계', author: 'hit' });
  const [story] = loadStories(cfg.storiesDir).stories;
  assert.deepEqual(loadStories(cfg.storiesDir).notices, []);
  return story;
};

test('steps a ✕ joins keep the link needs of the link into the first of them, and the step after them keeps its own because the link into it is still there', () => {
  const screens = [DRAFTS, { screen: HOME, linkNeeds: ['초안에서 홈으로'] }, HELP, { screen: HOME, linkNeeds: ['도움말에서 홈으로'] }, { screen: SIGNIN, linkNeeds: ['홈에서 로그인으로'] }];
  withOrderComment({ screens: [DRAFTS, HOME, HELP, HOME, SIGNIN] }, ({ cfg, post }) => {
    post({ screens });
    const story = acceptWithOff(cfg, 3);
    assert.deepEqual(story.screens, [DRAFTS, HOME, SIGNIN]);
    assert.deepEqual(story.stepFields?.map((f) => f.linkNeeds), [undefined, ['초안에서 홈으로'], ['홈에서 로그인으로']]);
    assert.deepEqual((story.source as { written: object[] }).written, [{ step: 2, linkNeeds: ['초안에서 홈으로'] }, { step: 3, linkNeeds: ['홈에서 로그인으로'] }]);
  });
});

test('the lines an agent wrote on steps a ✕ joins are merged in the source the way the story merges them, one line once and the last value of a box', () => {
  const box = (value: string) => ({ ...EMAIL_INPUT, value });
  const screens = [{ screen: HOME, expects: ['같은 줄'], inputs: [box('처음')] }, HELP, { screen: HOME, expects: ['같은 줄'], inputs: [box('나중')] }];
  withOrderComment({ screens: [HOME, HELP, HOME] }, ({ cfg, post }) => {
    post({ screens });
    const story = acceptWithOff(cfg, 2);
    assert.deepEqual(story.stepFields?.[0], { inputs: [box('나중')], expects: ['같은 줄'] });
    assert.deepEqual((story.source as { written: object[] }).written, [{ step: 1, inputs: [box('나중')], expects: ['같은 줄'] }]);
  });
});

test('a step a ✕ joins counts as put in by the agent only when the agent put in all of it, with each reason kept', () => {
  const agentOnly = [HOME, { screen: HELP, reason: '첫 이유' }, { screen: DRAFTS, reason: '가운데 이유' }, { screen: HELP, reason: '둘째 이유' }, SIGNIN];
  withOrderComment({ screens: [HOME, SIGNIN] }, ({ cfg, post }) => {
    post({ screens: agentOnly });
    const story = acceptWithOff(cfg, 3);
    assert.deepEqual((story.source as { added: object[] }).added, [{ step: 2, reason: '첫 이유 / 둘째 이유' }]);
  });
  const reviewers = [HOME, { screen: HELP, reason: '첫 이유' }, { screen: HOME, reason: '둘째 이유' }, SIGNIN];
  withOrderComment({ screens: [HOME, SIGNIN] }, ({ cfg, post }) => {
    post({ screens: reviewers });
    const story = acceptWithOff(cfg, 2);
    assert.deepEqual((story.source as { added: object[] }).added, []);
  });
});

test('undoing a story answers with the key of the candidate that comes back, even when another candidate leaves the same screens', () => {
  withFolder(recordsIn({ 'a.json': ['/home', '/help', '/signin'], 'b.json': ['/home', '/signin'] }), (dir: string) => {
    const stories = path.join(dir, 'stories');
    const listed = () => shownWith(dir, []).list;
    const whole = () => listed().find((c) => c.screens.length === 3)!;
    const short = () => listed().find((c) => c.screens.length === 2)!;
    pickCandidateStep(stories, whole(), stepOff(2));
    acceptCandidate(stories, short(), { id: 'b', name: '짧은 길', author: 'reviewer' });
    assert.equal(unacceptStory(stories, 'b').key, short().key);
    acceptCandidate(stories, whole(), { id: 'a', name: '긴 길', author: 'reviewer' });
    assert.equal(unacceptStory(stories, 'a').key, whole().key);
  });
});

test('with a rule taking a screen out, a ✕ numbers the step the list shows, the candidate file keeps the order it was found in with the found number, the ✕ stays on its screen when the rule goes, and accepting then undoing gives the one candidate back', () => {
  withFolder(recordsIn({ 'a.json': ['/signin', '/home', '/help', '/document/draft'] }), (dir: string) => {
    const stories = path.join(dir, 'stories');
    const listed = (rules: object[] = skipStart) => shownWith(dir, rules).list;
    const picked = pickCandidateStep(stories, listed()[0], stepOff(2), skipStart);
    assert.deepEqual(picked.offSteps, [2]);
    const file = path.join(stories, picked.file);
    assert.deepEqual([readJson(file).screens, readJson(file).offSteps], [[SIGNIN, HOME, HELP, DRAFTS], [3]]);
    assert.deepEqual(listed().map((c) => [c.screens, c.offSteps, c.file]), [[[HOME, HELP, DRAFTS], [2], picked.file]]);
    assert.deepEqual(listed([]).map((c) => [c.screens, c.offSteps]), [[[SIGNIN, HOME, HELP, DRAFTS], [3]]]);
    assert.deepEqual(storeCandidates(stories, listed()), { written: 0 });

    acceptCandidate(stories, listed()[0], { id: 'a', name: '도움말을 건너뛴다', author: 'reviewer' });
    assert.deepEqual(readJson(path.join(stories, 'a.json')).screens, [HOME, DRAFTS]);
    assert.deepEqual(listed(), []);
    unacceptStory(stories, 'a', skipStart);
    assert.deepEqual(listed().map((c) => [c.screens, c.offSteps]), [[[HOME, HELP, DRAFTS], [2]]]);
    assert.equal(fs.readdirSync(path.join(stories, 'candidates')).length, 1);

    pickCandidateStep(stories, listed()[0], stepOn(2), skipStart);
    assert.equal('offSteps' in readJson(file), false);
  });
});

test('a ✕ on a step the rules joined from two found steps takes both out of the candidate file, and the last step the list shows cannot be taken out even when the file holds more', () => {
  withFolder(recordsIn({ 'a.json': ['/signin', '/home', '/signin', '/help'] }), (dir: string) => {
    const stories = path.join(dir, 'stories');
    const rules: SkipRule[] = [{ screen: HOME, where: 'any' }];
    const listed = () => shownWith(dir, rules).list;
    assert.deepEqual(listed()[0].screens, [SIGNIN, HELP]);
    const picked = pickCandidateStep(stories, listed()[0], stepOff(1), rules);
    assert.deepEqual(readJson(path.join(stories, picked.file)).offSteps, [1, 3]);
    assert.deepEqual(listed()[0].offSteps, [1]);
    assert.throws(() => pickCandidateStep(stories, listed()[0], stepOff(2), rules), { message: '후보 「a」의 마지막 남은 단계는 뺄 수 없습니다' });
  });
});

test('a ✕ keeps a step taken out earlier that a rule now joins with others, and one pressed when every step left would be off replaces the ones the list no longer shows', () => {
  withFolder(recordsIn({ 'a.json': ['/signin', '/home', '/signin', '/help'] }), (dir: string) => {
    const stories = path.join(dir, 'stories');
    const rules: SkipRule[] = [{ screen: HOME, where: 'any' }];
    const { file } = pickCandidateStep(stories, shownWith(dir, []).list[0], stepOff(1));
    assert.deepEqual(shownWith(dir, rules).list[0].offSteps, undefined);
    pickCandidateStep(stories, shownWith(dir, rules).list[0], stepOff(2), rules);
    assert.deepEqual(readJson(path.join(stories, file)).offSteps, [1, 4]);
  });
  withFolder(recordsIn({ 'a.json': ['/signin', '/home', '/help'] }), (dir: string) => {
    const stories = path.join(dir, 'stories');
    const rules: SkipRule[] = [{ screen: HELP, where: 'any' }];
    const { file } = pickCandidateStep(stories, shownWith(dir, []).list[0], stepOff(1));
    pickCandidateStep(stories, shownWith(dir, []).list[0], stepOff(2));
    assert.deepEqual(shownWith(dir, rules).list[0].offSteps, undefined);
    pickCandidateStep(stories, shownWith(dir, rules).list[0], stepOff(2), rules);
    assert.deepEqual(readJson(path.join(stories, file)).offSteps, [2]);
    assert.deepEqual(shownWith(dir, rules).list[0].offSteps, [2]);
  });
});

test('a rule that takes out every step a ✕ left leaves the candidate with no step taken out, and a ✕ made while a rule cuts the step stays in the file after another ✕', () => {
  withFolder(recordsIn({ 'a.json': ['/signin', '/home', '/help'] }), (dir: string) => {
    const stories = path.join(dir, 'stories');
    const off = pickCandidateStep(stories, shownWith(dir, []).list[0], stepOff(1));
    pickCandidateStep(stories, shownWith(dir, []).list[0], stepOff(2));
    assert.deepEqual(readJson(path.join(stories, off.file)).offSteps, [1, 2]);

    const cutHelp = [{ screen: HELP, where: 'any' }];
    assert.deepEqual(shownWith(dir, cutHelp).list.map((c) => [c.screens, c.offSteps]), [[[SIGNIN, HOME], undefined]]);

    assert.deepEqual(shownWith(dir, skipStart).list.map((c) => [c.screens, c.offSteps]), [[[HOME, HELP], [1]]]);
    pickCandidateStep(stories, shownWith(dir, skipStart).list[0], stepOn(1), skipStart);
    assert.deepEqual(readJson(path.join(stories, off.file)).offSteps, [1]);
  });
});

test('with a rule, a candidate from a trace accepted with a step taken out leaves the list, also once another test of that report passes an order the rule makes the same', () => {
  withFolder({}, (dir: string) => {
    const report = 'results/playwright/e2e.json';
    const settings = { ...config, visitRecords: [], storiesDir: dir, candidateSkipScreens: skipStart };
    const first = [{ report, title: 'opens help from home', screens: [SIGNIN, HOME, HELP, DRAFTS] }];
    const grown = [...first, { report, title: 'opens help, signed in', screens: [HOME, HELP, DRAFTS] }];
    const listed = (traced: typeof first) => storyCandidates(settings, map, MAP_FILE, traced).list;
    pickCandidateStep(dir, listed(first)[0], stepOff(2), skipStart);
    assert.deepEqual(listed(first).map((c) => [c.screens, c.offSteps]), [[[HOME, HELP, DRAFTS], [2]]]);
    assert.deepEqual(listed(grown).map((c) => [c.screens, c.offSteps]), [[[HOME, HELP, DRAFTS], [2]]]);
    acceptCandidate(dir, listed(first)[0], { id: 'help', name: '홈에서 고른다', author: 'reviewer' });
    assert.deepEqual(listed(first), []);
    assert.deepEqual(listed(grown), []);
    assert.deepEqual(listed([...grown].reverse()), []);
  });
});

test('a candidate accepted with steps taken out keeps its found order off the list from every source, another visit record, a test of another report or another stored candidate file, until the acceptance is undone', () => {
  const visits = recordsIn({ 'a.json': ['/signin', '/home', '/help'], 'b.json': ['/signin', '/home', '/help'] });
  const other = { name: 'from c', screens: [SIGNIN, HOME, HELP], source: { record: 'c.json', steps: [1, 3] }, date: '2099-01-01T00:00:00.000Z' };
  withFolder(Object.fromEntries(Object.entries(visits).map(([name, body]) => [`visits/${name}`, body])), (dir: string) => {
    const cfg = { ...config, visitRecords: [path.join(dir, 'visits')], storiesDir: path.join(dir, 'stories') };
    const traced = [{ report: 'other.json', title: 'signs in and opens help', screens: [SIGNIN, HOME, HELP] }];
    const listed = () => storyCandidates(cfg, map, MAP_FILE, traced).list;
    storeCandidates(cfg.storiesDir, listed());
    pickCandidateStep(cfg.storiesDir, listed()[0], { step: 1, on: false });
    acceptCandidate(cfg.storiesDir, listed()[0], { id: 'home-help', name: 'home and help', author: 'kim' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg.storiesDir, 'home-help.json'), 'utf8')).screens, [HOME, HELP]);
    fs.writeFileSync(path.join(cfg.storiesDir, 'candidates', '2099-01-01-0000000c.json'), JSON.stringify(other));
    assert.deepEqual(listed(), []);
    unacceptStory(cfg.storiesDir, 'home-help');
    assert.deepEqual(listed().map((c) => [c.screens, c.offSteps]), [[[SIGNIN, HOME, HELP], [1]]]);
  });
});

test('a candidate from a visit record whose steps were taken out in the candidate file of a test that walked the same order keeps that order off the list once accepted, the test included', () => {
  withFolder(Object.fromEntries(Object.entries(recordsIn({ 'r.json': ['/signin', '/home', '/help'] })).map(([name, body]) => [`visits/${name}`, body])), (dir: string) => {
    const traced = [{ report: 't.json', title: 'signs in and opens help', screens: [SIGNIN, HOME, HELP] }];
    const storiesDir = path.join(dir, 'stories');
    storeCandidates(storiesDir, storyCandidates({ ...config, visitRecords: [], storiesDir }, map, MAP_FILE, traced).list);
    const cfg = { ...config, visitRecords: [path.join(dir, 'visits')], storiesDir };
    const listed = () => storyCandidates(cfg, map, MAP_FILE, traced).list;
    assert.deepEqual(listed().map((c) => 'record' in c.source), [true]);
    pickCandidateStep(storiesDir, listed()[0], stepOff(1));
    acceptCandidate(storiesDir, listed()[0], { id: 'home-help', name: 'home and help', author: 'kim' });
    assert.deepEqual(listed(), []);
    unacceptStory(storiesDir, 'home-help');
    assert.deepEqual(listed().map((c) => [c.screens, c.offSteps]), [[[SIGNIN, HOME, HELP], [1]]]);
    assert.equal(fs.readdirSync(path.join(storiesDir, 'candidates')).length, 1);
  });
});

test('an order accepted with a step taken out stays off the list when the source it was accepted from is gone, a test of it is retitled, or the story is edited', () => {
  withFolder(Object.fromEntries(Object.entries(recordsIn({ 'r.json': ['/signin', '/home', '/help'] })).map(([name, body]) => [`visits/${name}`, body])), (dir: string) => {
    const storiesDir = path.join(dir, 'stories');
    const walking = (title: string) => [{ report: 't.json', title, screens: [SIGNIN, HOME, HELP] }];
    const cfg = { ...config, visitRecords: [path.join(dir, 'visits')], storiesDir };
    const listed = (title = 'signs in and opens help') => storyCandidates(cfg, map, MAP_FILE, walking(title)).list;
    storeCandidates(storiesDir, storyCandidates({ ...cfg, visitRecords: [] }, map, MAP_FILE, walking('signs in and opens help')).list);
    pickCandidateStep(storiesDir, listed()[0], stepOff(1));
    acceptCandidate(storiesDir, listed()[0], { id: 'home-help', name: 'home and help', author: 'kim' });
    const story = loadStories(storiesDir).stories[0];
    writeStorySteps(storiesDir, 'home-help', { steps: [{ step: 1, screen: HOME }, { step: 2, screen: HELP }, { screen: '/lab#Lab' }], contentHash: story.contentHash });
    fs.rmSync(path.join(dir, 'visits/r.json'));
    assert.deepEqual(listed('opens help after signing in'), []);
  });
});

test('pressing ✕ on a candidate leaves it on the list when what is left is the order of a story accepted whole', () => {
  withFolder(Object.fromEntries(Object.entries(recordsIn({ 'r.json': ['/signin', '/home', '/help'] })).map(([name, body]) => [`visits/${name}`, body])), (dir: string) => {
    const storiesDir = path.join(dir, 'stories');
    const cfg = { ...config, visitRecords: [path.join(dir, 'visits')], storiesDir };
    const title = 'opens help';
    const whole = storyCandidates({ ...cfg, visitRecords: [] }, map, MAP_FILE, [{ report: 't.json', title, screens: [HOME, HELP] }]).list[0];
    acceptCandidate(storiesDir, whole, { id: 'home-help', name: 'home and help', author: 'kim' });
    const listed = () => storyCandidates(cfg, map, MAP_FILE, [{ report: 't.json', title, screens: [SIGNIN, HOME, HELP] }]).list;
    pickCandidateStep(storiesDir, listed()[0], stepOff(1));
    assert.deepEqual(listed().map((c) => [c.screens, c.offSteps]), [[[SIGNIN, HOME, HELP], [1]]]);
  });
});

test('an agent posting a candidate for an order accepted with a step taken out is refused with why, writing nothing', () => {
  withOrderComment({ screens: LAB_ORDER }, ({ cfg, post, files }) => {
    post({});
    const listed = () => storyCandidates(cfg, map, path.join(config.outDir, 'map.json')).list;
    pickCandidateStep(cfg.storiesDir, listed()[0], stepOff(2));
    acceptCandidate(cfg.storiesDir, listed()[0], { id: 'lab', name: 'x', author: 'hit' });
    const before = files();
    const { id: other } = addMark(cfg.marksDir, { target: { screens: LAB_ORDER }, note: '다시 채워 줘', author: 'hit' }, new Date('2026-10-22T01:00:00Z'));
    assert.throws(() => post({ comment: other }), { message: '이미 단계를 빼고 스토리 lab 로 받은 화면 순서입니다. 검토자가 받기를 되돌린 뒤에 올릴 수 있습니다' });
    assert.deepEqual(files(), before);
  });
});

test('undoing an acceptance after the story was edited keeps the edited order as a candidate beside the one found', () => {
  withFolder(recordsIn({ 'r.json': ['/signin', '/home', '/help'] }), (dir: string) => {
    const cfg = { ...config, visitRecords: [dir], storiesDir: path.join(dir, 'stories') };
    const listed = () => storyCandidates(cfg, map, MAP_FILE).list;
    storeCandidates(cfg.storiesDir, listed());
    pickCandidateStep(cfg.storiesDir, listed()[0], stepOff(1));
    acceptCandidate(cfg.storiesDir, listed()[0], { id: 'home-help', name: 'home and help', author: 'kim' });
    const story = loadStories(cfg.storiesDir).stories[0];
    writeStorySteps(cfg.storiesDir, 'home-help', { steps: [{ step: 1, screen: HOME }, { step: 2, screen: HELP }, { screen: '/lab#Lab' }], contentHash: story.contentHash });
    unacceptStory(cfg.storiesDir, 'home-help');
    assert.deepEqual(listed().map((c) => [c.screens, c.offSteps]), [[[SIGNIN, HOME, HELP], [1]], [[HOME, HELP, '/lab#Lab'], undefined]]);
  });
});

test('with a rule, a candidate accepted with a step taken out keeps off the list another source whose order after the rule is the same, and undoing brings one candidate back', () => {
  withFolder(recordsIn({ 'a.json': ['/signin', '/home', '/help', '/document/draft'] }), (dir: string) => {
    const stories = path.join(dir, 'stories');
    const traced = [{ report: 't.json', title: 'opens help, signed in', screens: [HOME, HELP, DRAFTS] }];
    const listed = () => shownWith(dir, skipStart, traced).list;
    pickCandidateStep(stories, listed()[0], stepOff(2), skipStart);
    acceptCandidate(stories, listed()[0], { id: 'a', name: '도움말을 건너뛴다', author: 'reviewer' });
    assert.deepEqual(listed(), []);
    unacceptStory(stories, 'a', skipStart);
    assert.deepEqual(listed().map((c) => [c.screens, c.offSteps]), [[[HOME, HELP, DRAFTS], [2]]]);
    assert.equal(fs.readdirSync(path.join(stories, 'candidates')).length, 1);
  });
});

test('a candidate file with acceptedAs that is not text is skipped with why', () => {
  withFolder({ 'candidates/2026-10-02-aaaaaaaa.json': { name: 'x', screens: [HOME, HELP], source: { record: 'r.json', steps: [1, 2] }, date: '2026-10-02T00:00:00.000Z', acceptedAs: 3 } }, (dir: string) => {
    const { list, notices } = storyCandidates({ ...config, visitRecords: [], storiesDir: dir }, map, MAP_FILE);
    assert.deepEqual(list, []);
    assert.match(notices[0].reason, /acceptedAs/);
  });
});
