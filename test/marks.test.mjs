import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMark, classifyMarks, loadMarks } from '../src/marks.mjs';

const MAP = { screens: [{ id: '/home#Home' }, { id: '/lab#Lab' }], calls: [{ id: 'GET:/api/v1/document/list' }] };

function withMarksDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    return fn(path.join(dir, 'marks'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a mark is written with its target, status, note, author and date, and read back', () => {
  withMarksDir((dir) => {
    assert.deepEqual(loadMarks(dir), []);
    const mark = addMark(dir, { target: { node: '/home#Home', depth: 'api' }, status: 'needs-more', note: 'no API test for the list', author: 'reviewer' }, new Date('2026-09-30T01:00:00Z'));
    assert.match(mark.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(loadMarks(dir), [
      { id: mark.id, target: { node: '/home#Home', depth: 'api' }, status: 'needs-more', note: 'no API test for the list', author: 'reviewer', date: '2026-09-30T01:00:00.000Z' },
    ]);
  });
});

test('each mark is a new file in its screen\'s folder, named by date, author and short ID, and earlier files are never rewritten', () => {
  withMarksDir((dir) => {
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
  withMarksDir((dir) => {
    addMark(dir, { target: { node: '..' }, status: 'fine', author: 'a' });
    assert.deepEqual(fs.readdirSync(path.dirname(dir)), ['marks']);
    assert.equal(loadMarks(dir).length, 1);
  });
});

test('which screen a mark belongs to comes from its target, not from the folder it sits in', () => {
  withMarksDir((dir) => {
    addMark(dir, { target: { node: '/lab#Lab' }, status: 'missing', author: 'a' });
    fs.renameSync(path.join(dir, '_lab#Lab'), path.join(dir, 'moved'));
    assert.deepEqual(classifyMarks(loadMarks(dir), MAP).attached.map((m) => m.key), ['/lab#Lab']);
  });
});

test('a mark file that is not valid JSON is reported with its path', () => {
  withMarksDir((dir) => {
    fs.mkdirSync(path.join(dir, '_lab#Lab'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_lab#Lab', 'broken.json'), '{');
    assert.throws(() => loadMarks(dir), /broken\.json/);
  });
});

test('marking the same target again keeps the history, and the latest mark is the current one', () => {
  withMarksDir((dir) => {
    addMark(dir, { target: { node: '/home#Home' }, status: 'needs-more', note: 'first', author: 'a' }, new Date('2026-09-30T01:00:00Z'));
    addMark(dir, { target: { node: '/home#Home' }, status: 'fine', note: 'second', author: 'b' }, new Date('2026-09-30T02:00:00Z'));
    addMark(dir, { target: { node: '/home#Home', depth: 'ui' }, status: 'missing', author: 'a' }, new Date('2026-09-30T03:00:00Z'));
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP);
    assert.deepEqual(detached, []);
    assert.deepEqual(attached.map((m) => [m.key, m.current.status, m.history.map((h) => h.note)]), [
      ['/home#Home', 'fine', ['second', 'first']],
      ['/home#Home ui', 'missing', ['']],
    ]);
  });
});

test('a mark whose node is gone from the map is detached, not dropped', () => {
  withMarksDir((dir) => {
    addMark(dir, { target: { node: '/lab#Lab', depth: 'data' }, status: 'missing', author: 'a' });
    addMark(dir, { target: { node: '/settings#Settings' }, status: 'needs-more', note: 'renamed?', author: 'a' });
    const { attached, detached } = classifyMarks(loadMarks(dir), MAP);
    assert.deepEqual(attached.map((m) => m.key), ['/lab#Lab data']);
    assert.deepEqual(detached.map((m) => [m.key, m.current.note]), [['/settings#Settings', 'renamed?']]);
    assert.equal(loadMarks(dir).length, 2);
  });
});

test('a mark on an API call or on one depth of it is attached while the call is on the map', () => {
  withMarksDir((dir) => {
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
  withMarksDir((dir) => {
    const call = 'POST:/api/v1/report/export';
    const value = addMark(dir, { target: { node: call, option: { key: 'withHistory', value: true } }, status: 'missing', author: 'a' }, new Date('2026-10-01T01:00:00Z'));
    const depth = addMark(dir, { target: { depth: 'output', option: { value: false, key: 'withHistory' }, node: call }, status: 'needs-more', author: 'a' }, new Date('2026-10-01T02:00:00Z'));
    assert.deepEqual(value.target, { node: call, option: { key: 'withHistory', value: true } });
    assert.deepEqual(Object.keys(depth.target), ['node', 'option', 'depth']);
    assert.deepEqual(Object.keys(depth.target.option), ['key', 'value']);
    assert.deepEqual(fs.readdirSync(dir), ['POST__api_v1_report_export']);
    assert.deepEqual(loadMarks(dir).map((m) => m.target).sort((a, b) => (a.depth ?? '').localeCompare(b.depth ?? '')), [value.target, depth.target]);
  });
});

test('marks on a call, its depth, its option values and their depths are kept apart, each with its own history', () => {
  withMarksDir((dir) => {
    const node = 'POST:/api/v1/report/export';
    addMark(dir, { target: { node }, status: 'fine', author: 'a' });
    addMark(dir, { target: { node, depth: 'ui' }, status: 'fine', author: 'a' });
    addMark(dir, { target: { node, option: { key: 'withHistory', value: true } }, status: 'missing', author: 'a' }, new Date('2026-10-01T01:00:00Z'));
    addMark(dir, { target: { node, option: { key: 'withHistory', value: true } }, status: 'needs-more', author: 'b' }, new Date('2026-10-01T02:00:00Z'));
    addMark(dir, { target: { node, option: { key: 'withHistory', value: false } }, status: 'missing', author: 'a' });
    addMark(dir, { target: { node, option: { key: 'withHistory', value: true }, depth: 'ui' }, status: 'missing', author: 'a' });
    const { attached, detached } = classifyMarks(loadMarks(dir), OPTION_MAP);
    assert.deepEqual(detached, []);
    assert.deepEqual(attached.map((m) => [m.key, m.current.status, m.history.length]), [
      [node, 'fine', 1],
      [`${node} ui`, 'fine', 1],
      [`${node} withHistory=false`, 'missing', 1],
      [`${node} withHistory=true`, 'needs-more', 2],
      [`${node} withHistory=true ui`, 'missing', 1],
    ]);
  });
});

test('a mark on an option the map no longer has is detached while the call stays, and so is an option mark on a screen', () => {
  withMarksDir((dir) => {
    const node = 'POST:/api/v1/report/export';
    addMark(dir, { target: { node, option: { key: 'withHistory', value: true } }, status: 'missing', author: 'a' });
    addMark(dir, { target: { node, option: { key: 'withAttachments', value: true }, depth: 'output' }, status: 'missing', author: 'a' });
    addMark(dir, { target: { node: '/admin/report#AdminReport', option: { key: 'withHistory', value: true } }, status: 'missing', author: 'a' });
    const { attached, detached } = classifyMarks(loadMarks(dir), OPTION_MAP);
    assert.deepEqual(attached.map((m) => m.key), [`${node} withHistory=true`]);
    assert.deepEqual(detached.map((m) => m.key), ['/admin/report#AdminReport withHistory=true', `${node} withAttachments=true output`]);
  });
});

for (const [name, input] of [
  ['an unknown status', { target: { node: '/home#Home' }, status: 'done', author: 'a' }],
  ['an unknown depth', { target: { node: '/home#Home', depth: 'e2e' }, status: 'fine', author: 'a' }],
  ['an option with no key', { target: { node: '/home#Home', option: { value: true } }, status: 'fine', author: 'a' }],
  ['an option value that is not true or false', { target: { node: '/home#Home', option: { key: 'withHistory', value: 'yes' } }, status: 'fine', author: 'a' }],
  ['an option that is not an object', { target: { node: '/home#Home', option: 'withHistory=true' }, status: 'fine', author: 'a' }],
  ['no target node', { target: {}, status: 'fine', author: 'a' }],
  ['no author', { target: { node: '/home#Home' }, status: 'fine', author: ' ' }],
]) {
  test(`a mark with ${name} is refused and nothing is written`, () => {
    withMarksDir((dir) => {
      assert.throws(() => addMark(dir, input));
      assert.equal(fs.existsSync(dir), false);
    });
  });
}
