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
    assert.deepEqual(Object.keys(depth.target), ['node', 'option', 'depth']);
    assert.deepEqual(Object.keys((depth.target as { option: object }).option), ['key', 'value']);
    assert.deepEqual(fs.readdirSync(dir), ['POST__api_v1_report_export']);
    assert.deepEqual(loadMarks(dir).map((m) => m.target).sort((a: { depth?: string }, b: { depth?: string }) => (a.depth ?? '').localeCompare(b.depth ?? '')), [value.target, depth.target]);
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
