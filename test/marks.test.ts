import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMark, addReply, classifyMarks, loadMarks } from '../src/marks.ts';

const MAP = { screens: [{ id: '/home#Home' }, { id: '/lab#Lab' }], calls: [{ id: 'GET:/api/v1/document/list' }] };

function withMarksDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    return fn(path.join(dir, 'marks'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a mark is written with its target, status, note, author and date, and read back', () => {
  withMarksDir((dir: string) => {
    assert.deepEqual(loadMarks(dir), []);
    const mark = addMark(dir, { target: { node: '/home#Home', depth: 'api' }, status: 'needs-more', note: 'no API test for the list', author: 'reviewer' }, new Date('2026-09-30T01:00:00Z'));
    assert.match(mark.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(loadMarks(dir), [
      { id: mark.id, target: { node: '/home#Home', depth: 'api' }, status: 'needs-more', note: 'no API test for the list', author: 'reviewer', date: '2026-09-30T01:00:00.000Z' },
    ]);
  });
});

test('each mark is a new file in its screen\'s folder, named by date, author and short ID, and earlier files are never rewritten', () => {
  withMarksDir((dir: string) => {
    const first = addMark(dir, { target: { node: '/document/:id#DocumentDetail' }, status: 'fine', author: 'Kim Min' }, new Date('2026-09-30T01:00:00Z'));
    const firstFile = path.join(dir, '_document__id#DocumentDetail', `2026-09-30-Kim_Min-${first.id.slice(0, 8)}.json`);
    const before = fs.readFileSync(firstFile, 'utf8');
    const second = addMark(dir, { target: { node: '/document/:id#DocumentDetail', depth: 'ui' }, status: 'missing', author: 'Kim Min' }, new Date('2026-10-01T01:00:00Z'));
    addMark(dir, { target: { node: '/lab#Lab' }, status: 'fine', author: 'lee' }, new Date('2026-10-01T01:00:00Z'));
    assert.equal(fs.readFileSync(firstFile, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(dir, '_document__id#DocumentDetail')).sort(), [
      `2026-09-30-Kim_Min-${first.id.slice(0, 8)}.json`,
      `2026-10-01-Kim_Min-${second.id.slice(0, 8)}.json`,
    ]);
    assert.equal(fs.readdirSync(dir).length, 2);
  });
});

test('a screen ID that would point outside the marks folder still lands inside it', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { node: '..' }, status: 'fine', author: 'a' });
    assert.deepEqual(fs.readdirSync(path.dirname(dir)), ['marks']);
    assert.equal(loadMarks(dir).length, 1);
  });
});

test('which screen a mark belongs to comes from its target, not from the folder it sits in', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { node: '/lab#Lab' }, status: 'missing', author: 'a' });
    fs.renameSync(path.join(dir, '_lab#Lab'), path.join(dir, 'moved'));
    assert.deepEqual(classifyMarks(loadMarks(dir), MAP).attached.map((m) => m.key), ['/lab#Lab']);
  });
});

test('a mark file that is not valid JSON is reported with its path', () => {
  withMarksDir((dir: string) => {
    fs.mkdirSync(path.join(dir, '_lab#Lab'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_lab#Lab', 'broken.json'), '{');
    assert.throws(() => loadMarks(dir), /broken\.json/);
  });
});

test('marking the same target again keeps the history, and the latest mark is the current one', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { node: '/home#Home' }, status: 'needs-more', note: 'first', author: 'a' }, new Date('2026-09-30T01:00:00Z'));
    addMark(dir, { target: { node: '/home#Home' }, status: 'fine', note: 'second', author: 'b' }, new Date('2026-09-30T02:00:00Z'));
    addMark(dir, { target: { node: '/home#Home', depth: 'ui' }, status: 'missing', author: 'a' }, new Date('2026-09-30T03:00:00Z'));
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP);
    assert.deepEqual(detached, []);
    assert.deepEqual(attached.map((m) => [m.key, m.current!.status, m.history.map((h) => h.note)]), [
      ['/home#Home', 'fine', ['second', 'first']],
      ['/home#Home ui', 'missing', ['']],
    ]);
  });
});

test('a comment is a mark with no status: it needs a note, keeps its place in the history, and the latest mark with a status stays current', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { node: '/home#Home' }, status: 'needs-more', note: 'first', author: 'a' }, new Date('2026-09-30T01:00:00Z'));
    const comment = addMark(dir, { target: { node: '/home#Home' }, note: 'the empty list too', author: 'b' }, new Date('2026-09-30T02:00:00Z'));
    addMark(dir, { target: { story: 'run-lab' }, note: 'only a comment', author: 'b' }, new Date('2026-09-30T03:00:00Z'));
    assert.deepEqual(Object.keys(comment), ['id', 'target', 'note', 'author', 'date']);
    const { attached } = classifyMarks(loadMarks(dir), MAP, ['run-lab']);
    assert.deepEqual(attached.map((m) => [m.key, m.current?.status ?? null, m.history.map((h) => [h.status ?? null, h.note])]), [
      ['/home#Home', 'needs-more', [[null, 'the empty list too'], ['needs-more', 'first']]],
      ['story(run-lab)', null, [[null, 'only a comment']]],
    ]);
    assert.throws(() => addMark(dir, { target: { node: '/home#Home' }, note: '  ', author: 'a' }), /a comment needs a note/);
    assert.throws(() => addMark(dir, { target: { node: '/home#Home', case: 'empty' }, note: 'x', author: 'a' }), /unknown case mark status/);
  });
});

test('a reply is a new file in the folder of the comment it answers, with the same target, the comment ID and the author agent; only a comment takes one', () => {
  withMarksDir((dir: string) => {
    const comment = addMark(dir, { target: { node: '/home#Home', depth: 'ui' }, note: 'why is the list empty?', author: 'b' }, new Date('2026-09-30T02:00:00Z'));
    const mark = addMark(dir, { target: { node: '/home#Home' }, status: 'missing', author: 'b' });
    const reply = addReply(dir, { replyTo: comment.id, note: 'the fixture has no rows' }, new Date('2026-09-30T03:00:00Z'));
    assert.deepEqual(reply, { id: reply.id, target: { node: '/home#Home', depth: 'ui' }, replyTo: comment.id, note: 'the fixture has no rows', author: 'agent', date: '2026-09-30T03:00:00.000Z' });
    assert.deepEqual(fs.readdirSync(path.join(dir, '_home#Home')).sort(), [`2026-09-30-agent-${reply.id.slice(0, 8)}.json`, `2026-09-30-b-${comment.id.slice(0, 8)}.json`, `${mark.date.slice(0, 10)}-b-${mark.id.slice(0, 8)}.json`].sort());
    const { attached } = classifyMarks(loadMarks(dir), MAP);
    assert.deepEqual(attached.find((m) => m.key === '/home#Home ui')!.history.map((h) => [h.note, h.replyTo ?? null]), [['the fixture has no rows', comment.id], ['why is the list empty?', null]]);

    for (const id of ['no-such-id', mark.id, reply.id]) assert.throws(() => addReply(dir, { replyTo: id, note: 'x' }), { message: `no comment with ID "${id}"` });
    assert.throws(() => addReply(dir, { replyTo: comment.id, note: ' ' }), /a reply needs a note/);
    assert.equal(loadMarks(dir).length, 3);
  });
});

test('a mark whose node is gone from the map is detached, not dropped', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { node: '/lab#Lab', depth: 'data' }, status: 'missing', author: 'a' });
    addMark(dir, { target: { node: '/settings#Settings' }, status: 'needs-more', note: 'renamed?', author: 'a' });
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP);
    assert.deepEqual(attached.map((m) => m.key), ['/lab#Lab data']);
    assert.deepEqual(detached.map((m) => [m.key, m.current!.note]), [['/settings#Settings', 'renamed?']]);
    assert.equal(loadMarks(dir).length, 2);
  });
});

test('a mark on an API call or on one depth of it is attached while the call is on the map', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { node: 'GET:/api/v1/document/list' }, status: 'missing', author: 'a' });
    addMark(dir, { target: { node: 'GET:/api/v1/document/list', depth: 'api' }, status: 'needs-more', author: 'a' });
    addMark(dir, { target: { node: 'DELETE:/api/v1/document/list' }, status: 'missing', author: 'a' });
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP);
    assert.deepEqual(attached.map((m) => m.key), ['GET:/api/v1/document/list', 'GET:/api/v1/document/list api']);
    assert.deepEqual(detached.map((m) => m.key), ['DELETE:/api/v1/document/list']);
  });
});

const OPTION_MAP = {
  screens: [{ id: '/admin/report#AdminReport' }],
  calls: [{ id: 'POST:/api/v1/report/export', options: [{ key: 'withHistory' }] }],
};

test('a mark on an option value, or on one depth of it, is written with the option in its target and stays in the call\'s folder', () => {
  withMarksDir((dir: string) => {
    const call = 'POST:/api/v1/report/export';
    const value = addMark(dir, { target: { node: call, option: { key: 'withHistory', value: true } }, status: 'missing', author: 'a' }, new Date('2026-10-01T01:00:00Z'));
    const depth = addMark(dir, { target: { depth: 'output', option: { value: false, key: 'withHistory' }, node: call }, status: 'needs-more', author: 'a' }, new Date('2026-10-01T02:00:00Z'));
    assert.deepEqual(value.target, { node: call, option: { key: 'withHistory', value: true } });
    assert.deepEqual(Object.keys(depth.target!), ['node', 'option', 'depth']);
    assert.deepEqual(Object.keys((depth.target as { option: object }).option), ['key', 'value']);
    assert.deepEqual(fs.readdirSync(dir), ['POST__api_v1_report_export']);
    assert.deepEqual(loadMarks(dir).map((m) => m.target!).sort((a: { depth?: string }, b: { depth?: string }) => (a.depth ?? '').localeCompare(b.depth ?? '')), [value.target, depth.target]);
  });
});

test('marks on a call, its depth, its option values and their depths are kept apart, each with its own history', () => {
  withMarksDir((dir: string) => {
    const node = 'POST:/api/v1/report/export';
    addMark(dir, { target: { node }, status: 'fine', author: 'a' });
    addMark(dir, { target: { node, depth: 'ui' }, status: 'fine', author: 'a' });
    addMark(dir, { target: { node, option: { key: 'withHistory', value: true } }, status: 'missing', author: 'a' }, new Date('2026-10-01T01:00:00Z'));
    addMark(dir, { target: { node, option: { key: 'withHistory', value: true } }, status: 'needs-more', author: 'b' }, new Date('2026-10-01T02:00:00Z'));
    addMark(dir, { target: { node, option: { key: 'withHistory', value: false } }, status: 'missing', author: 'a' });
    addMark(dir, { target: { node, option: { key: 'withHistory', value: true }, depth: 'ui' }, status: 'missing', author: 'a' });
    const { attached, detached } = classifyMarks(loadMarks(dir), OPTION_MAP);
    assert.deepEqual(detached, []);
    assert.deepEqual(attached.map((m) => [m.key, m.current!.status, m.history.length]), [
      [node, 'fine', 1],
      [`${node} ui`, 'fine', 1],
      [`${node} withHistory=false`, 'missing', 1],
      [`${node} withHistory=true`, 'needs-more', 2],
      [`${node} withHistory=true ui`, 'missing', 1],
    ]);
  });
});

test('a mark on an option the map no longer has is detached while the call stays, and so is an option mark on a screen', () => {
  withMarksDir((dir: string) => {
    const node = 'POST:/api/v1/report/export';
    addMark(dir, { target: { node, option: { key: 'withHistory', value: true } }, status: 'missing', author: 'a' });
    addMark(dir, { target: { node, option: { key: 'withAttachments', value: true }, depth: 'output' }, status: 'missing', author: 'a' });
    addMark(dir, { target: { node: '/admin/report#AdminReport', option: { key: 'withHistory', value: true } }, status: 'missing', author: 'a' });
    const { attached, detached } = classifyMarks(loadMarks(dir), OPTION_MAP);
    assert.deepEqual(attached.map((m) => m.key), [`${node} withHistory=true`]);
    assert.deepEqual(detached.map((m) => m.key), ['/admin/report#AdminReport withHistory=true', `${node} withAttachments=true output`]);
  });
});

test('a mark on a story is written with only the story in its target, in that story\'s folder under stories, and keeps its history', () => {
  withMarksDir((dir: string) => {
    const first = addMark(dir, { target: { story: 'run-lab' }, status: 'missing', note: 'first', author: 'Kim Min' }, new Date('2026-10-01T01:00:00Z'));
    const second = addMark(dir, { target: { story: 'run-lab' }, status: 'needs-more', note: 'second', author: 'b' }, new Date('2026-10-02T01:00:00Z'));
    assert.deepEqual(first.target, { story: 'run-lab' });
    assert.deepEqual(fs.readdirSync(dir), ['stories']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'stories', 'run-lab')).sort(), [
      `2026-10-01-Kim_Min-${first.id.slice(0, 8)}.json`,
      `2026-10-02-b-${second.id.slice(0, 8)}.json`,
    ]);
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP, ['run-lab']);
    assert.deepEqual(detached, []);
    assert.deepEqual(attached.map((m) => [m.key, m.target, m.current!.status, m.history.map((h) => h.note)]), [
      ['story(run-lab)', { story: 'run-lab' }, 'needs-more', ['second', 'first']],
    ]);
  });
});

test('a mark on a story with no story file is detached, while marks on screens stay as they are', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { story: 'old-story' }, status: 'missing', note: 'gone?', author: 'a' });
    addMark(dir, { target: { story: 'run-lab' }, status: 'fine', author: 'a' });
    addMark(dir, { target: { node: '/home#Home' }, status: 'missing', author: 'a' });
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP, ['run-lab']);
    assert.deepEqual(attached.map((m) => m.key), ['/home#Home', 'story(run-lab)']);
    assert.deepEqual(detached.map((m) => [m.key, m.current!.note]), [['story(old-story)', 'gone?']]);
  });
});

test('a mark on a story never shares its history with a mark on a call, whatever the call\'s method', () => {
  withMarksDir((dir: string) => {
    const map = { screens: [], calls: [{ id: 'story:run-lab' }] };
    addMark(dir, { target: { story: 'run-lab' }, status: 'missing', author: 'a' }, new Date('2026-10-01T01:00:00Z'));
    addMark(dir, { target: { node: 'story:run-lab' }, status: 'fine', author: 'a' }, new Date('2026-10-02T01:00:00Z'));
    const { attached } = classifyMarks(loadMarks(dir), map, ['run-lab']);
    assert.deepEqual(attached.map((m) => [m.target, m.current!.status, m.history.length]), [
      [{ story: 'run-lab' }, 'missing', 1],
      [{ node: 'story:run-lab' }, 'fine', 1],
    ]);
  });
});

test('a case mark is written with only its node and kind in its target, in the node\'s folder, and the latest one of a node and kind is current, apart from the node\'s own marks', () => {
  withMarksDir((dir: string) => {
    const call = 'GET:/api/v1/document/list';
    const picked = addMark(dir, { target: { case: 'boundary', node: '/home#Home' }, status: 'needed', author: 'a' }, new Date('2026-10-01T01:00:00Z'));
    addMark(dir, { target: { node: '/home#Home', case: 'boundary' }, status: 'not-needed', author: 'b' }, new Date('2026-10-01T02:00:00Z'));
    addMark(dir, { target: { node: '/home#Home', case: 'legacy' }, status: 'needed', author: 'a' });
    addMark(dir, { target: { node: call, case: 'boundary' }, status: 'needed', author: 'a' });
    addMark(dir, { target: { node: '/home#Home' }, status: 'missing', author: 'a' });
    assert.deepEqual(picked.target, { node: '/home#Home', case: 'boundary' });
    assert.deepEqual(Object.keys(picked.target), ['node', 'case']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['GET__api_v1_document_list', '_home#Home']);
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP, [], ['boundary', 'legacy']);
    assert.deepEqual(detached, []);
    assert.deepEqual(attached.map((m) => [m.key, m.current!.status, m.history.length]), [
      ['/home#Home', 'missing', 1],
      ['/home#Home case:boundary', 'not-needed', 2],
      ['/home#Home case:legacy', 'needed', 1],
      [`${call} case:boundary`, 'needed', 1],
    ]);
  });
});

test('a case mark whose kind is gone from the config, or whose node is gone from the map, is detached', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { node: '/home#Home', case: 'boundary' }, status: 'needed', author: 'a' });
    addMark(dir, { target: { node: '/home#Home', case: 'legacy' }, status: 'needed', author: 'a' });
    addMark(dir, { target: { node: '/settings#Settings', case: 'boundary' }, status: 'needed', author: 'a' });
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP, [], ['boundary']);
    assert.deepEqual(attached.map((m) => m.key), ['/home#Home case:boundary']);
    assert.deepEqual(detached.map((m) => m.key), ['/home#Home case:legacy', '/settings#Settings case:boundary']);
    assert.deepEqual(classifyMarks(loadMarks(dir), MAP).attached, []);
  });
});

for (const [name, input] of [
  ['an unknown status', { target: { node: '/home#Home' }, status: 'done', author: 'a' }],
  ['an unknown depth', { target: { node: '/home#Home', depth: 'e2e' }, status: 'fine', author: 'a' }],
  ['an option with no key', { target: { node: '/home#Home', option: { value: true } }, status: 'fine', author: 'a' }],
  ['an option value that is not true or false', { target: { node: '/home#Home', option: { key: 'withHistory', value: 'yes' } }, status: 'fine', author: 'a' }],
  ['an option that is not an object', { target: { node: '/home#Home', option: 'withHistory=true' }, status: 'fine', author: 'a' }],
  ['no target node', { target: {}, status: 'fine', author: 'a' }],
  ['a story and a node', { target: { story: 'run-lab', node: '/home#Home' }, status: 'fine', author: 'a' }],
  ['a story and a depth', { target: { story: 'run-lab', depth: 'ui' }, status: 'fine', author: 'a' }],
  ['a story and an option', { target: { story: 'run-lab', option: { key: 'withHistory', value: true } }, status: 'fine', author: 'a' }],
  ['a story ID outside the ID rule', { target: { story: '../run-lab' }, status: 'fine', author: 'a' }],
  ['a story ID that is not text', { target: { story: 7 }, status: 'fine', author: 'a' }],
  ['no author', { target: { node: '/home#Home' }, status: 'fine', author: ' ' }],
  ['a case status on a node', { target: { node: '/home#Home' }, status: 'needed', author: 'a' }],
  ['a case status on a story', { target: { story: 'run-lab' }, status: 'not-needed', author: 'a' }],
  ['a mark status on a case', { target: { node: '/home#Home', case: 'boundary' }, status: 'missing', author: 'a' }],
  ['a case and a depth', { target: { node: '/home#Home', case: 'boundary', depth: 'ui' }, status: 'needed', author: 'a' }],
  ['a case and an option', { target: { node: 'GET:/api/v1/document/list', case: 'boundary', option: { key: 'withHistory', value: true } }, status: 'needed', author: 'a' }],
  ['a case and a story', { target: { story: 'run-lab', case: 'boundary' }, status: 'needed', author: 'a' }],
  ['a case with no node', { target: { case: 'boundary' }, status: 'needed', author: 'a' }],
  ['a case kind outside the name rule', { target: { node: '/home#Home', case: 'two words' }, status: 'needed', author: 'a' }],
  ['a case kind that is not text', { target: { node: '/home#Home', case: 7 }, status: 'needed', author: 'a' }],
]) {
  test(`a mark with ${name} is refused and nothing is written`, () => {
    withMarksDir((dir: string) => {
      assert.throws(() => addMark(dir, input as Parameters<typeof addMark>[1]));
      assert.equal(fs.existsSync(dir), false);
    });
  });
}

const LIST_TEST = { source: 'results/playwright/report.json', file: 'e2e/list.spec.ts', title: 'list shows rows' };

test('a comment on a test under a screen is written with the test in its target, kept in the screen\'s folder and read back; the test is named by its result file, test file and title without tags', () => {
  withMarksDir((dir: string) => {
    const comment = addMark(dir, {
      target: { node: '/home#Home', part: { kind: 'test', key: { title: 'list shows rows @screen:/home#Home', file: 'e2e\\list.spec.ts', source: 'results\\playwright\\report.json' } } },
      note: 'why does this fail?',
      author: 'a',
    }, new Date('2026-10-12T01:00:00Z'));
    assert.deepEqual(comment.target, { node: '/home#Home', part: { kind: 'test', key: LIST_TEST } });
    assert.deepEqual(Object.keys((comment.target as { part: { key: object } }).part.key), ['source', 'file', 'title']);
    assert.deepEqual(fs.readdirSync(dir), ['_home#Home']);
    assert.deepEqual(loadMarks(dir), [comment]);
  });
});

test('a test part takes a comment only: a status, an empty note, a depth, an option, a case, an unknown kind or a test without its result file or title is refused and nothing is written', () => {
  withMarksDir((dir: string) => {
    const part = { kind: 'test', key: LIST_TEST };
    const refused: [object, RegExp][] = [
      [{ target: { node: '/home#Home', part }, status: 'missing', note: 'x' }, /a comment on a part of a screen or call takes no status; put the status on the screen or call itself/],
      [{ target: { node: '/home#Home', part }, note: ' ' }, /a comment needs a note/],
      [{ target: { node: '/home#Home', depth: 'ui', part }, note: 'x' }, /a part mark takes no option, depth or case/],
      [{ target: { node: 'GET:/api/v1/document/list', option: { key: 'k', value: true }, part }, note: 'x' }, /a part mark takes no option, depth or case/],
      [{ target: { node: '/home#Home', case: 'empty', part }, note: 'x' }, /a part mark takes no option, depth or case/],
      [{ target: { node: '/home#Home', part: { kind: 'row', key: LIST_TEST } }, note: 'x' }, /unknown part kind "row" \(expected test, condition, link\)/],
      [{ target: { node: '/home#Home', part: { kind: 'test', key: { file: 'e2e/list.spec.ts', title: 't' } } }, note: 'x' }, /a test part needs a result file, a test file and a title/],
      [{ target: { node: '/home#Home', part: { kind: 'test', key: { source: 'r.json', file: 'e2e/list.spec.ts', title: ' ' } } }, note: 'x' }, /a test part needs a result file, a test file and a title/],
      [{ target: { story: 'run-lab', part }, note: 'x' }, /unknown story part kind "test" \(expected step, hop\)/],
    ];
    for (const [input, message] of refused) assert.throws(() => addMark(dir, { ...input, author: 'a' }), message);
    assert.deepEqual(loadMarks(dir), []);
    const noFile = addMark(dir, { target: { node: '/home#Home', part: { kind: 'test', key: { source: 'results/junit/a.xml', file: null, title: 'saves' } } }, note: 'x', author: 'a' });
    assert.deepEqual((noFile.target as { part: object }).part, { kind: 'test', key: { source: 'results/junit/a.xml', file: null, title: 'saves' } });
  });
});

const LINKS = { nodes: { '/home#Home': [{ ...LIST_TEST, line: 8, status: 'fail', format: 'playwright', depth: 'ui' }] } };

test('comments on a test of a screen are kept in their own entry with where the test is, leave the screen\'s current status alone, and are detached once the test is gone', () => {
  withMarksDir((dir: string) => {
    const part = { kind: 'test', key: LIST_TEST };
    addMark(dir, { target: { node: '/home#Home' }, status: 'needs-more', author: 'a' }, new Date('2026-10-12T01:00:00Z'));
    const comment = addMark(dir, { target: { node: '/home#Home', part }, note: 'why does this fail?', author: 'a' }, new Date('2026-10-12T02:00:00Z'));
    const reply = addReply(dir, { replyTo: comment.id, note: 'the list API answers 500' }, new Date('2026-10-12T03:00:00Z'));
    assert.deepEqual(reply.target, comment.target);
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP, [], [], LINKS);
    assert.deepEqual(detached, []);
    assert.deepEqual(attached.map((m) => [m.key, m.current?.status ?? null, m.history.map((h) => h.note)]), [
      ['/home#Home', 'needs-more', ['']],
      [`/home#Home part:test:${JSON.stringify(LIST_TEST)}`, null, ['the list API answers 500', 'why does this fail?']],
    ]);
    assert.deepEqual(attached[1].where, { file: 'e2e/list.spec.ts', line: 8, source: LIST_TEST.source, status: 'fail', relation: 'tagged' });
    assert.equal('where' in attached[0], false);

    const renamed = { nodes: { '/home#Home': [{ ...LINKS.nodes['/home#Home'][0], title: 'list shows every row' }] } };
    const after = classifyMarks(loadMarks(dir), MAP, [], [], renamed);
    assert.deepEqual(after.attached.map((m) => m.key), ['/home#Home']);
    assert.deepEqual(after.detached.map((m) => [m.target, m.where]), [[{ node: '/home#Home', part }, null]]);
  });
});

test('a comment on a condition or an incoming link of a screen is written with its key, the link\'s conditions or guards sorted once each, and anything else is refused with the reason', () => {
  withMarksDir((dir: string) => {
    const role = addMark(dir, { target: { node: '/lab#Lab', part: { kind: 'condition', key: 'role:ADMIN' } }, note: 'only admins?', author: 'a' });
    assert.deepEqual(role.target, { node: '/lab#Lab', part: { kind: 'condition', key: 'role:ADMIN' } });
    const link = addMark(dir, { target: { node: '/lab#Lab', part: { kind: 'link', key: { from: '/home#Home', conditions: ['setting:LAB=on', 'role:ADMIN', 'setting:LAB=on'] } } }, note: 'is this link there?', author: 'a' });
    assert.deepEqual(link.target, { node: '/lab#Lab', part: { kind: 'link', key: { from: '/home#Home', conditions: ['role:ADMIN', 'setting:LAB=on'] } } });
    const unread = addMark(dir, { target: { node: '/lab#Lab', part: { kind: 'link', key: { from: '/home#Home', guards: ['labOn()'] } } }, note: 'x', author: 'a' });
    assert.deepEqual(unread.target, { node: '/lab#Lab', part: { kind: 'link', key: { from: '/home#Home', guards: ['labOn()'] } } });
    assert.deepEqual(loadMarks(dir).length, 3);

    const refused: [object, RegExp][] = [
      [{ kind: 'condition', key: 'ADMIN' }, /a condition part needs a key such as role:<role> or setting:<path>=on/],
      [{ kind: 'condition', key: { role: 'ADMIN' } }, /a condition part needs a key such as role:<role> or setting:<path>=on/],
      [{ kind: 'link', key: { conditions: ['role:ADMIN'] } }, /a link part needs the screen it starts from and either the conditions read from it or its guards/],
      [{ kind: 'link', key: { from: '/home#Home', conditions: [] } }, /a link part needs the screen it starts from and either the conditions read from it or its guards/],
      [{ kind: 'link', key: { from: '/home#Home', conditions: ['role:ADMIN'], guards: [] } }, /a link part needs the screen it starts from and either the conditions read from it or its guards/],
      [{ kind: 'link', key: { from: '/home#Home', guards: [7] } }, /a link part needs the screen it starts from and either the conditions read from it or its guards/],
    ];
    for (const [part, message] of refused) assert.throws(() => addMark(dir, { target: { node: '/lab#Lab', part } as never, note: 'x', author: 'a' }), message);
    assert.throws(() => addMark(dir, { target: { node: '/lab#Lab', part: { kind: 'condition', key: 'role:ADMIN' } }, status: 'missing', note: 'x', author: 'a' }), /takes no status/);
    assert.deepEqual(loadMarks(dir).length, 3);
  });
});

const LAB_ROUTE = { guard: 'globalSettings.LAB', kinds: ['setting'], settings: [{ root: 'globalSettings', path: ['LAB'], need: 'on' }] };
const labMap = (line: number, route = [LAB_ROUTE]) => ({
  screens: [
    { id: '/home#Home', access: { restricted: false, kinds: [], route: [], links: [] } },
    {
      id: '/lab#Lab', routeFile: 'Routes.js', line,
      access: {
        restricted: route.length > 0, kinds: route.length ? ['setting'] : [], route,
        links: [{ from: '/home#Home', file: 'components/Home.js', line: line + 5, guards: route }],
        ...(route.length && { settings: [{ from: 'route', needs: LAB_ROUTE.settings, unreadable: [] }] }),
      },
    },
  ],
  calls: [],
});

test('comments on a condition and an incoming link stay on them when only the lines move, carry where they are written, and are detached once the condition and the link\'s reading are gone', () => {
  withMarksDir((dir: string) => {
    const condition = { node: '/lab#Lab', part: { kind: 'condition', key: 'setting:LAB=on' } };
    const link = { node: '/lab#Lab', part: { kind: 'link', key: { from: '/home#Home', conditions: ['setting:LAB=on'] } } };
    addMark(dir, { target: condition, note: 'is LAB really needed?', author: 'a' });
    addMark(dir, { target: link, note: 'and on this link?', author: 'a' });

    const before = classifyMarks(loadMarks(dir), labMap(44), [], [], {});
    assert.deepEqual(before.detached, []);
    const moved = classifyMarks(loadMarks(dir), labMap(50), [], [], {});
    assert.deepEqual(moved.detached, []);
    assert.deepEqual(moved.attached.map((m) => m.where), [
      { places: [{ from: 'route', file: 'Routes.js', line: 50, guard: 'globalSettings.LAB' }, { from: '/home#Home', file: 'components/Home.js', line: 55, guard: 'globalSettings.LAB' }] },
      { places: [{ from: '/home#Home', file: 'components/Home.js', line: 55 }] },
    ]);

    const gone = classifyMarks(loadMarks(dir), labMap(50, []), [], [], {});
    assert.deepEqual(gone.attached, []);
    assert.deepEqual(gone.detached.map((m) => [m.target, m.where]), [[condition, null], [link, null]]);
  });
});

const TRACE_KEY = '/home#Home > /help#Help';
const RECORD_KEY = '/signin#SignIn > /home#Home > /help#Help';

test('a comment on a story candidate is written with only the candidate key in its target, in that key\'s folder under stories/candidates, and a reply to it carries the same target', () => {
  withMarksDir((dir: string) => {
    const fromRecord = addMark(dir, { target: { candidate: RECORD_KEY }, note: 'why does it pass the beta inbox?', author: 'Kim Min' }, new Date('2026-10-13T01:00:00Z'));
    const fromTrace = addMark(dir, { target: { candidate: TRACE_KEY }, note: 'which test gives this?', author: 'a' }, new Date('2026-10-13T02:00:00Z'));
    const reply = addReply(dir, { replyTo: fromRecord.id, note: 'step 3 opens it' }, new Date('2026-10-13T03:00:00Z'));
    assert.deepEqual([fromRecord.target, fromTrace.target, reply.target], [{ candidate: RECORD_KEY }, { candidate: TRACE_KEY }, { candidate: RECORD_KEY }]);
    assert.equal('status' in fromRecord, false);
    assert.deepEqual(fs.readdirSync(dir), ['stories']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'stories', 'candidates')).sort(), ['_home#Home____help#Help', '_signin#SignIn____home#Home____help#Help']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'stories', 'candidates', '_signin#SignIn____home#Home____help#Help')).sort(), [
      `2026-10-13-Kim_Min-${fromRecord.id.slice(0, 8)}.json`,
      `2026-10-13-agent-${reply.id.slice(0, 8)}.json`,
    ]);
    assert.equal(loadMarks(dir).length, 3);
  });
});

test('a comment on a candidate whose screen order is too long for a folder name is saved in a folder cut short with a hash of the whole key, and read back with its full key', () => {
  withMarksDir((dir: string) => {
    const screens = Array.from({ length: 12 }, (_, i) => `/settings/users/:userId/step${i}#UserEditPage`);
    const key = screens.join(' > ');
    const other = [...screens.slice(0, 11), '/settings/users/:userId/last#UserEditPage'].join(' > ');
    const comment = addMark(dir, { target: { candidate: key }, note: 'why so long?', author: 'a' });
    addMark(dir, { target: { candidate: other }, note: 'and this one?', author: 'a' });
    const folders = fs.readdirSync(path.join(dir, 'stories', 'candidates'));
    assert.equal(folders.length, 2);
    for (const f of folders) assert.match(f, /^_settings_users__userId_step0#UserEditPage____settings_users__userId_st-[0-9a-f]{8}$/);
    assert.deepEqual(loadMarks(dir).find((m) => m.id === comment.id)!.target, { candidate: key });
  });
});

test('a comment on a story candidate is attached while the candidate is listed and detached once it is not, apart from the marks on a story of the same name', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { candidate: 'open-help' }, note: 'why this order?', author: 'a' }, new Date('2026-10-13T01:00:00Z'));
    addMark(dir, { target: { story: 'open-help' }, status: 'missing', author: 'a' }, new Date('2026-10-13T02:00:00Z'));
    addMark(dir, { target: { candidate: TRACE_KEY }, note: 'which test?', author: 'a' }, new Date('2026-10-13T03:00:00Z'));
    const listed = classifyMarks(loadMarks(dir), MAP, ['open-help'], [], {}, {}, ['open-help', TRACE_KEY]);
    assert.deepEqual(listed.detached, []);
    assert.deepEqual(listed.attached.map((m) => [m.key, m.current?.status ?? null, m.history.map((h) => h.note)]), [
      [`candidate(${TRACE_KEY})`, null, ['which test?']],
      ['candidate(open-help)', null, ['why this order?']],
      ['story(open-help)', 'missing', ['']],
    ]);
    const taken = classifyMarks(loadMarks(dir), MAP, ['open-help'], [], {}, {}, [TRACE_KEY]);
    assert.deepEqual(taken.attached.map((m) => m.key), [`candidate(${TRACE_KEY})`, 'story(open-help)']);
    assert.deepEqual(taken.detached.map((m) => m.target), [{ candidate: 'open-help' }]);
  });
});

test('a comment on a story candidate takes no status, and a candidate key mixed with a story, a node or a part, or an empty one, is refused and nothing is written', () => {
  withMarksDir((dir: string) => {
    const refused: [object, RegExp][] = [
      [{ target: { candidate: 'open-help' }, status: 'missing', note: 'x' }, /a comment on a story candidate takes no status; accept it as a story to give it one/],
      [{ target: { candidate: 'open-help' }, status: 'fine' }, /a comment on a story candidate takes no status/],
      [{ target: { candidate: 'open-help' }, note: ' ' }, /a comment needs a note/],
      [{ target: { candidate: ' ' }, note: 'x' }, /a candidate mark needs the key of a story candidate/],
      [{ target: { candidate: 3 }, note: 'x' }, /a candidate mark needs the key of a story candidate/],
      [{ target: { candidate: 'open-help', story: 'open-help' }, note: 'x' }, /a candidate mark takes no story, screens, node, option, depth, case or part/],
      [{ target: { candidate: 'open-help', node: '/home#Home' }, note: 'x' }, /a candidate mark takes no story, screens, node, option, depth, case or part/],
      [{ target: { candidate: 'open-help', depth: 'ui' }, note: 'x' }, /a candidate mark takes no story, screens, node, option, depth, case or part/],
      [{ target: { candidate: 'open-help', part: { kind: 'test', key: LIST_TEST } }, note: 'x' }, /a candidate mark takes no story, screens, node, option, depth, case or part/],
    ];
    for (const [input, message] of refused) assert.throws(() => addMark(dir, { ...input, author: 'a' } as Parameters<typeof addMark>[1]), message);
    assert.equal(fs.existsSync(dir), false);
  });
});

const ORDER = ['/home#Home', '/lab#Lab'];

test('a comment on a screen order is written with the screens in its target, in a folder under stories/orders named by the screens joined with " > ", and a reply to it carries the same target', () => {
  withMarksDir((dir: string) => {
    const comment = addMark(dir, { target: { screens: ORDER }, note: 'fill in a way through the lab', author: 'Kim Min' }, new Date('2026-10-15T01:00:00Z'));
    const reply = addReply(dir, { replyTo: comment.id, note: 'home links to the lab directly' }, new Date('2026-10-15T02:00:00Z'));
    assert.deepEqual([comment.target, reply.target], [{ screens: ORDER }, { screens: ORDER }]);
    assert.equal('status' in comment, false);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'stories', 'orders')), ['_home#Home____lab#Lab']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'stories', 'orders', '_home#Home____lab#Lab')).sort(), [
      `2026-10-15-Kim_Min-${comment.id.slice(0, 8)}.json`,
      `2026-10-15-agent-${reply.id.slice(0, 8)}.json`,
    ]);
    const long = Array.from({ length: 12 }, (_, i) => `/settings/users/:userId/step${i}#UserEditPage`);
    addMark(dir, { target: { screens: long }, note: 'why so long?', author: 'a' });
    assert.ok(fs.readdirSync(path.join(dir, 'stories', 'orders')).some((f) => /^_settings_users__userId_step0#UserEditPage____settings_users__userId_st-[0-9a-f]{8}$/.test(f)));
    assert.deepEqual(classifyMarks(loadMarks(dir), MAP).attached.map((m) => m.key), [`order(${ORDER.join(' > ')})`]);
  });
});

test('a comment on a screen order is attached while every screen in it is on the map and detached once one is not, apart from a comment on a single screen of it', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { screens: ORDER }, note: 'fill in a way', author: 'a' });
    addMark(dir, { target: { screens: ['/lab#Lab'] }, note: 'start here', author: 'a' });
    addMark(dir, { target: { node: '/lab#Lab' }, status: 'missing', author: 'a' });
    const kept = classifyMarks(loadMarks(dir), MAP);
    assert.deepEqual(kept.detached, []);
    assert.deepEqual(kept.attached.map((m) => [m.key, m.target]), [['/lab#Lab', { node: '/lab#Lab' }], ['order(/home#Home > /lab#Lab)', { screens: ORDER }], ['order(/lab#Lab)', { screens: ['/lab#Lab'] }]]);
    const gone = classifyMarks(loadMarks(dir), { screens: [{ id: '/lab#Lab' }] });
    assert.deepEqual(gone.detached.map((m) => m.target), [{ screens: ORDER }]);
  });
});

test('a comment on a screen order takes no status, and an order that is empty, not a list of screen IDs, has the same screen twice in a row, is mixed with another kind of target or comes twice in one comment is refused and nothing is written', () => {
  withMarksDir((dir: string) => {
    const refused: [object, RegExp][] = [
      [{ target: { screens: ORDER }, status: 'missing', note: 'x' }, /a comment on a screen order takes no status/],
      [{ target: { screens: ORDER }, note: ' ' }, /a comment needs a note/],
      [{ target: { screens: [] }, note: 'x' }, /a screen order mark needs a list of one or more screen IDs/],
      [{ target: { screens: '/home#Home' }, note: 'x' }, /a screen order mark needs a list of one or more screen IDs/],
      [{ target: { screens: ['/home#Home', ' '] }, note: 'x' }, /a screen order mark needs a list of one or more screen IDs/],
      [{ target: { screens: ['/home#Home > /lab#Lab'] }, note: 'x' }, /a screen order mark needs a list of one or more screen IDs without spaces/],
      [{ target: { screens: ['/home#Home', '/lab#Lab', '/lab#Lab'] }, note: 'x' }, /screens 2 and 3 of a screen order are the same screen/],
      [{ target: { screens: ORDER, node: '/home#Home' }, note: 'x' }, /a screen order mark takes no story, candidate, node, option, depth, case or part/],
      [{ target: { screens: ORDER, story: 'run-lab' }, note: 'x' }, /a screen order mark takes no story/],
      [{ target: { screens: ORDER, candidate: 'open-help' }, note: 'x' }, /a candidate mark takes no story, screens/],
      [{ targets: [{ screens: ORDER }, { screens: ['/lab#Lab'] }], note: 'x' }, /a mark takes one screen order at most/],
    ];
    for (const [input, message] of refused) assert.throws(() => addMark(dir, { ...input, author: 'a' } as Parameters<typeof addMark>[1]), message);
    assert.equal(fs.existsSync(dir), false);
    const both = addMark(dir, { targets: [{ screens: ORDER }, { node: '/lab#Lab' }], note: 'and the lab itself?', author: 'a' });
    assert.deepEqual(both.targets, [{ screens: ORDER }, { node: '/lab#Lab' }]);
  });
});

const STEP = { kind: 'step', key: { step: 2, screen: '/lab#Lab' } };
const HOP = { kind: 'hop', key: { step: 1, from: '/home#Home', to: '/lab#Lab' } };
const LAB_PATH = {
  id: 'run-lab', file: 'run-lab.json', screens: ['/home#Home', '/lab#Lab'],
  links: [{ verdict: 'conditioned', ways: [{ file: 'components/Home.js', line: 17, conditions: [] }] }],
  reach: [{ kind: 'link', from: '/home#Home', to: '/lab#Lab' }, { kind: 'route', screen: '/lab#Lab' }, { kind: 'route', screen: '/home#Home' }],
};
const LAB_SCREENS = { screens: [{ id: '/home#Home', routeFile: 'Routes.js', line: 3, componentFile: 'components/Home.js' }, { id: '/lab#Lab', routeFile: 'Routes.js', line: 9, componentFile: null }] };

test('a comment on a step or on the link between two steps of a story is written with the story and the step numbered from 1, in the story\'s folder, keyed apart from the story, and refused with a status or a malformed key', () => {
  withMarksDir((dir: string) => {
    const step = addMark(dir, { target: { story: 'run-lab', part: STEP }, note: 'check the result table here', author: 'a' });
    const hop = addMark(dir, { target: { story: 'run-lab', part: HOP }, note: 'is the link really there?', author: 'a' });
    assert.deepEqual([step.target, hop.target], [{ story: 'run-lab', part: STEP }, { story: 'run-lab', part: HOP }]);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'stories', 'run-lab')).length, 2);
    addMark(dir, { target: { story: 'run-lab' }, status: 'missing', author: 'a' });
    assert.deepEqual(classifyMarks(loadMarks(dir), MAP, ['run-lab']).attached.map((m) => m.key), [
      'story(run-lab)',
      `story(run-lab) part:hop:${JSON.stringify(HOP.key)}`,
      `story(run-lab) part:step:${JSON.stringify(STEP.key)}`,
    ]);
    const refused: [object, RegExp][] = [
      [{ target: { story: 'run-lab', part: STEP }, status: 'missing', note: 'x' }, /a comment on a step or a hop of a story takes no status; put the status on the story itself/],
      [{ target: { story: 'run-lab', part: { kind: 'step', key: { step: 0, screen: '/lab#Lab' } } }, note: 'x' }, /a step part needs its step number, counted from 1, and the screen of that step/],
      [{ target: { story: 'run-lab', part: { kind: 'step', key: { step: 1.5, screen: '/lab#Lab' } } }, note: 'x' }, /a step part needs its step number/],
      [{ target: { story: 'run-lab', part: { kind: 'step', key: { step: 2 } } }, note: 'x' }, /a step part needs its step number/],
      [{ target: { story: 'run-lab', part: { kind: 'hop', key: { step: 1, from: '/home#Home' } } }, note: 'x' }, /a hop part needs the number of the step it leaves, counted from 1, and the screens it leaves and reaches/],
      [{ target: { story: 'run-lab', node: '/lab#Lab', part: STEP }, note: 'x' }, /a story mark takes no screens, node, option, depth or case/],
      [{ target: { node: '/lab#Lab', part: STEP }, note: 'x' }, /unknown part kind "step" \(expected test, condition, link\)/],
    ];
    for (const [input, message] of refused) assert.throws(() => addMark(dir, { ...input, author: 'a' } as Parameters<typeof addMark>[1]), message);
    assert.equal(loadMarks(dir).length, 3);
  });
});

test('a comment on a story step or link stays while the story has that screen at that step, carries the screen files or the link\'s verdict and preconditions, is detached once the story file changes there, and stays with an unreadable story', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { story: 'run-lab', part: STEP }, note: 'check the result table here', author: 'a' });
    addMark(dir, { target: { story: 'run-lab', part: HOP }, note: 'is the link really there?', author: 'a' });
    const same = classifyMarks(loadMarks(dir), LAB_SCREENS, ['run-lab'], [], {}, {}, [], [LAB_PATH]);
    assert.deepEqual(same.detached, []);
    assert.deepEqual(same.attached.map((m) => m.where), [
      {
        file: 'run-lab.json',
        from: { id: '/home#Home', componentFile: 'components/Home.js', routeFile: 'Routes.js', line: 3 },
        to: { id: '/lab#Lab', componentFile: null, routeFile: 'Routes.js', line: 9 },
        verdict: 'conditioned',
        ways: [{ file: 'components/Home.js', line: 17, conditions: [] }],
        preconditions: [{ kind: 'link', from: '/home#Home', to: '/lab#Lab' }, { kind: 'route', screen: '/lab#Lab' }],
      },
      { file: 'run-lab.json', screen: { id: '/lab#Lab', componentFile: null, routeFile: 'Routes.js', line: 9 } },
    ]);
    const changed = classifyMarks(loadMarks(dir), LAB_SCREENS, ['run-lab'], [], {}, {}, [], [{ ...LAB_PATH, screens: ['/home#Home', '/help#Help'] }]);
    assert.deepEqual(changed.attached, []);
    assert.deepEqual(changed.detached.map((m) => [m.target.part!.kind, m.where]), [['hop', null], ['step', null]]);
    const unreadable = classifyMarks(loadMarks(dir), LAB_SCREENS, ['run-lab'], [], {}, {}, [], []);
    assert.deepEqual(unreadable.attached.map((m) => [m.target.part!.kind, m.where]), [['hop', null], ['step', null]]);
    const gone = classifyMarks(loadMarks(dir), LAB_SCREENS, [], [], {}, {}, [], []);
    assert.equal(gone.detached.length, 2);
  });
});

const LAB_TEST = { node: '/lab#Lab', part: { kind: 'test', key: { source: 'results/e2e.json', file: 'lab.spec.ts', title: 'opens the lab' } } };

test('a comment on several targets is written with all of them under targets in the first one\'s folder, one with none under general/, one with one target keeps target as before, and a reply carries the same targets', () => {
  withMarksDir((dir: string) => {
    const many = addMark(dir, { targets: [{ node: '/lab#Lab' }, LAB_TEST, { story: 'run-lab' }], note: 'do these agree?', author: 'a' });
    const none = addMark(dir, { targets: [], note: 'what does duru not cover?', author: 'a' });
    const one = addMark(dir, { targets: [{ node: '/home#Home' }], note: 'one place', author: 'a' });
    assert.deepEqual([many.targets, 'target' in many], [[{ node: '/lab#Lab' }, LAB_TEST, { story: 'run-lab' }], false]);
    assert.deepEqual([none.targets, 'target' in none], [[], false]);
    assert.deepEqual([one.target, 'targets' in one], [{ node: '/home#Home' }, false]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['_home#Home', '_lab#Lab', 'general']);
    const reply = addReply(dir, { replyTo: many.id, note: 'they do' });
    assert.deepEqual([reply.targets, 'target' in reply], [many.targets, false]);
    assert.equal(fs.readdirSync(path.join(dir, '_lab#Lab')).length, 2);
  });
});

test('a mark on several targets or none takes no status, no case, and no target twice', () => {
  withMarksDir((dir: string) => {
    const refused: [object, RegExp][] = [
      [{ targets: [{ node: '/lab#Lab' }, { node: '/home#Home' }], status: 'missing', note: 'x' }, /a status takes exactly one target; a comment on several targets or none takes no status/],
      [{ targets: [], status: 'fine' }, /a status takes exactly one target/],
      [{ targets: [{ node: '/lab#Lab', case: 'empty' }, { node: '/home#Home' }], note: 'x' }, /a case mark takes exactly one target/],
      [{ targets: [{ node: '/lab#Lab' }, { node: '/lab#Lab' }], note: 'x' }, /a mark names the same target twice/],
      [{ targets: [], note: ' ' }, /a comment needs a note/],
      [{ targets: { node: '/lab#Lab' }, note: 'x' }, /mark targets must be a list/],
    ];
    for (const [input, message] of refused) assert.throws(() => addMark(dir, { ...input, author: 'a' } as Parameters<typeof addMark>[1]), message);
    assert.equal(fs.existsSync(dir), false);
  });
});

test('a comment on several targets is in the history of each, stays on the ones still there and is detached from the one that is gone, and one with no target is in the general entry', () => {
  withMarksDir((dir: string) => {
    addMark(dir, { target: { node: '/lab#Lab' }, status: 'missing', author: 'a' }, new Date('2026-10-14T01:00:00Z'));
    addMark(dir, { targets: [{ node: '/lab#Lab' }, { node: '/gone#Gone' }], note: 'both?', author: 'a' }, new Date('2026-10-14T02:00:00Z'));
    addMark(dir, { targets: [], note: 'in general', author: 'a' }, new Date('2026-10-14T03:00:00Z'));
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP);
    assert.deepEqual(attached.map((m) => [m.key, m.current?.status ?? null, m.history.map((h) => h.note)]), [
      ['/lab#Lab', 'missing', ['both?', '']],
      ['general()', null, ['in general']],
    ]);
    assert.deepEqual(detached.map((m) => [m.key, m.target, m.history.map((h) => h.note)]), [['/gone#Gone', { node: '/gone#Gone' }, ['both?']]]);
  });
});
