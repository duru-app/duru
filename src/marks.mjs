import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEPTHS } from './test-links.mjs';

export const MARK_STATUSES = ['needs-more', 'missing', 'fine'];

// 끝의 `.` 을 바꾸는 것은 Windows 가 그런 이름을 받지 않고, 화면 ID 가 `..` 이면 표시 폴더 밖을 가리키기 때문이다.
const fileSafe = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f\s]/g, '_').replace(/\.$/, '_');

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
  const folder = path.join(dir, fileSafe(mark.target.node));
  fs.mkdirSync(folder, { recursive: true });
  const name = `${mark.date.slice(0, 10)}-${fileSafe(mark.author)}-${mark.id.slice(0, 8)}.json`;
  fs.writeFileSync(path.join(folder, name), JSON.stringify(mark, null, 2) + '\n', { flag: 'wx' });
}

export function addMark(dir, { target, status, note, author }, now = new Date()) {
  if (typeof target?.node !== 'string' || !target.node) throw new Error('mark target needs a node ID');
  if (target.depth !== undefined && !DEPTHS.includes(target.depth)) throw new Error(`unknown depth "${target.depth}"`);
  const { option } = target;
  if (option !== undefined && (typeof option?.key !== 'string' || !option.key || typeof option.value !== 'boolean')) {
    throw new Error('mark option needs a key and a value of true or false');
  }
  if (!MARK_STATUSES.includes(status)) throw new Error(`unknown mark status "${status}" (expected one of ${MARK_STATUSES.join(', ')})`);
  if (typeof author !== 'string' || !author.trim()) throw new Error('mark needs an author');
  const mark = {
    id: crypto.randomUUID(),
    target: {
      node: target.node,
      ...(option !== undefined && { option: { key: option.key, value: option.value } }),
      ...(target.depth !== undefined && { depth: target.depth }),
    },
    status,
    note: typeof note === 'string' ? note : '',
    author: author.trim(),
    date: now.toISOString(),
  };
  saveMark(dir, mark);
  return mark;
}

const targetKey = (t) => [t.node, t.option && `${t.option.key}=${t.option.value}`, t.depth].filter(Boolean).join(' ');

export function classifyMarks(marks, map) {
  const nodes = new Map([
    ...map.screens.map((s) => [s.id, new Set()]),
    ...(map.calls ?? []).map((c) => [c.id, new Set((c.options ?? []).map((o) => o.key))]),
  ]);
  const onMap = (t) => nodes.has(t.node) && (!t.option || nodes.get(t.node).has(t.option.key));
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
    (onMap(entry.target) ? attached : detached).push(entry);
  }
  return { attached, detached };
}
