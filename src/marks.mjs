import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STORY_ID } from './stories.mjs';
import { DEPTHS } from './test-links.mjs';

export const MARK_STATUSES = ['needs-more', 'missing', 'fine'];

// 끝의 `.` 을 바꾸는 것은 Windows 가 그런 이름을 받지 않고, 화면 ID 가 `..` 이면 표시 폴더 밖을 가리키기 때문이다.
export const fileSafe = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f\s]/g, '_').replace(/\.$/, '_');

export const recordName = (record) => `${record.date.slice(0, 10)}-${fileSafe(record.author)}-${record.id.slice(0, 8)}.json`;

export function writeNewRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
}

export function loadMarks(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const file = path.join(dir, f);
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`${file}: ${err.message}`);
      }
    });
}

// 표시 하나를 파일 하나로 저장하고 기존 파일은 고치지 않으므로, 두 사람이 따로 남긴 표시도 git 에서 충돌 없이 합쳐진다.
// 어느 화면의 표시인지는 폴더 이름이 아니라 파일 안의 target 으로 정한다.
function saveMark(dir, mark) {
  const { story, node } = mark.target;
  writeNewRecord(path.join(story ? path.join(dir, 'stories', story) : path.join(dir, fileSafe(node)), recordName(mark)), mark);
}

function storyTarget(target) {
  if (typeof target.story !== 'string' || !STORY_ID.test(target.story)) throw new Error(`"${target.story}" is not a story ID`);
  if (['node', 'option', 'depth'].some((k) => target[k] !== undefined)) throw new Error('a story mark takes no node, option or depth');
  return { story: target.story };
}

function nodeTarget(target) {
  if (typeof target?.node !== 'string' || !target.node) throw new Error('mark target needs a node ID or a story ID');
  if (target.depth !== undefined && !DEPTHS.includes(target.depth)) throw new Error(`unknown depth "${target.depth}"`);
  const { option } = target;
  if (option !== undefined && (typeof option?.key !== 'string' || !option.key || typeof option.value !== 'boolean')) {
    throw new Error('mark option needs a key and a value of true or false');
  }
  return {
    node: target.node,
    ...(option !== undefined && { option: { key: option.key, value: option.value } }),
    ...(target.depth !== undefined && { depth: target.depth }),
  };
}

export function addMark(dir, { target, status, note, author }, now = new Date()) {
  const checked = target?.story !== undefined ? storyTarget(target) : nodeTarget(target);
  if (!MARK_STATUSES.includes(status)) throw new Error(`unknown mark status "${status}" (expected one of ${MARK_STATUSES.join(', ')})`);
  if (typeof author !== 'string' || !author.trim()) throw new Error('mark needs an author');
  const mark = {
    id: crypto.randomUUID(),
    target: checked,
    status,
    note: typeof note === 'string' ? note : '',
    author: author.trim(),
    date: now.toISOString(),
  };
  saveMark(dir, mark);
  return mark;
}

// 화면 · 호출 ID 에는 괄호가 들어가지 않으므로(map.mjs 의 TAG_FORBIDDEN) story(<ID>) 는 노드의 키가 될 수 없다.
const targetKey = (t) => (t.story !== undefined ? `story(${t.story})` : [t.node, t.option && `${t.option.key}=${t.option.value}`, t.depth].filter(Boolean).join(' '));

export function classifyMarks(marks, map, storyIds = []) {
  const nodes = new Map([
    ...map.screens.map((s) => [s.id, new Set()]),
    ...(map.calls ?? []).map((c) => [c.id, new Set((c.options ?? []).map((o) => o.key))]),
  ]);
  const stories = new Set(storyIds);
  const isAttached = (t) => (t.story !== undefined ? stories.has(t.story) : nodes.has(t.node) && (!t.option || nodes.get(t.node).has(t.option.key)));
  const byTarget = new Map();
  const ordered = [...marks].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const m of ordered) {
    const key = targetKey(m.target);
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).unshift(m);
  }
  const attached = [];
  const detached = [];
  for (const key of [...byTarget.keys()].sort()) {
    const history = byTarget.get(key);
    const entry = { key, target: history[0].target, current: history[0], history };
    (isAttached(entry.target) ? attached : detached).push(entry);
  }
  return { attached, detached };
}
