import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CASE_KIND, isPlainObject } from './config.ts';
import { isText, reference } from './judgments.ts';
import type { TestRef } from './judgments.ts';
import { locatePart } from './parts.ts';
import type { PartContext, TestPlace } from './parts.ts';
import { STORY_ID } from './stories.ts';
import { DEPTHS } from './test-links.ts';

export const MARK_STATUSES = ['needs-more', 'missing', 'fine'];
export const CASE_STATUSES = ['needed', 'not-needed'];

interface MarkTarget {
  story?: string;
  node?: string;
  option?: { key: string; value: boolean };
  depth?: string;
  case?: string;
  part?: Part;
}

export interface Part {
  kind: string;
  key: TestRef;
}

export const PART_KINDS = ['test'];

// status 가 없는 표시는 코멘트고, 그 가운데 replyTo 가 있는 것은 그 ID 의 코멘트에 단 답글이다.
export interface Mark {
  id: string;
  target: MarkTarget;
  status?: string;
  replyTo?: string;
  note: string;
  author: string;
  date: string;
}

interface NewMark {
  target?: MarkTarget;
  status?: string | null;
  note?: unknown;
  author?: unknown;
}

interface MarkableMap {
  screens: { id: string }[];
  calls?: { id: string; options?: { key: string }[] }[];
}

interface MarkEntry {
  key: string;
  target: MarkTarget;
  current: Mark | null;
  history: Mark[];
  where?: TestPlace | null;
}

// 끝의 `.` 을 바꾸는 것은 Windows 가 그런 이름을 받지 않고, 화면 ID 가 `..` 이면 표시 폴더 밖을 가리키기 때문이다.
export const fileSafe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f\s]/g, '_').replace(/\.$/, '_');

export const recordName = (record: { date: string; author: string; id: string }) => `${record.date.slice(0, 10)}-${fileSafe(record.author)}-${record.id.slice(0, 8)}.json`;

export function writeNewRecord(file: string, record: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
}

export function loadMarks(dir: string): Mark[] {
  if (!fs.existsSync(dir)) return [];
  return (fs
    .readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const file = path.join(dir, f);
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`${file}: ${(err as Error).message}`);
      }
    });
}

// 표시 하나를 파일 하나로 저장하고 기존 파일은 고치지 않으므로, 두 사람이 따로 남긴 표시도 git 에서 충돌 없이 합쳐진다.
// 어느 화면의 표시인지는 폴더 이름이 아니라 파일 안의 target 으로 정한다.
function saveMark(dir: string, mark: Mark) {
  const { story, node } = mark.target;
  writeNewRecord(path.join(story ? path.join(dir, 'stories', story) : path.join(dir, fileSafe(node!)), recordName(mark)), mark);
}

function storyTarget(target: MarkTarget) {
  if (typeof target.story !== 'string' || !STORY_ID.test(target.story)) throw new Error(`"${target.story}" is not a story ID`);
  if (['node', 'option', 'depth', 'case', 'part'].some((k) => (target as Record<string, unknown>)[k] !== undefined)) throw new Error('a story mark takes no node, option, depth or case');
  return { story: target.story };
}

function nodeTarget(target: MarkTarget | undefined) {
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

function caseTarget(target: MarkTarget) {
  if (typeof target.node !== 'string' || !target.node) throw new Error('a case mark needs a node ID');
  if (typeof target.case !== 'string' || !CASE_KIND.test(target.case)) throw new Error(`"${target.case}" is not a case kind name`);
  if (target.option !== undefined || target.depth !== undefined) throw new Error('a case mark takes no option or depth');
  return { node: target.node, case: target.case };
}

function partTarget(target: MarkTarget) {
  if (typeof target.node !== 'string' || !target.node) throw new Error('a part mark needs a node ID');
  if (target.option !== undefined || target.depth !== undefined || target.case !== undefined) throw new Error('a part mark takes no option, depth or case');
  const { kind, key }: Partial<Part> = isPlainObject(target.part) ? target.part! : {};
  if (!PART_KINDS.includes(kind!)) throw new Error(`unknown part kind "${kind}" (expected ${PART_KINDS.join(', ')})`);
  if (!key || !isPlainObject(key) || !isText(key.source) || !(isText(key.file) || key.file === null) || !isText(key.title)) throw new Error('a test part needs a result file, a test file and a title');
  return { node: target.node, part: { kind: kind!, key: reference(key) } };
}

export function addMark(dir: string, { target, status, note, author }: NewMark, now = new Date()) {
  const checked: MarkTarget = target?.story !== undefined ? storyTarget(target) : target?.part !== undefined ? partTarget(target) : target?.case !== undefined ? caseTarget(target) : nodeTarget(target);
  if (checked.part && status !== undefined && status !== null) throw new Error('a comment on a part of a screen or call takes no status; put the status on the screen or call itself');
  const statuses = checked.case !== undefined ? CASE_STATUSES : MARK_STATUSES;
  const comment = (status === undefined || status === null) && checked.case === undefined;
  if (comment && (typeof note !== 'string' || !note.trim())) throw new Error('a comment needs a note');
  if (!comment && !statuses.includes(status!)) {
    throw new Error(`unknown ${checked.case !== undefined ? 'case mark' : 'mark'} status "${status}" (expected one of ${statuses.join(', ')})`);
  }
  if (typeof author !== 'string' || !author.trim()) throw new Error('mark needs an author');
  const mark: Mark = {
    id: crypto.randomUUID(),
    target: checked,
    ...(!comment && { status: status! }),
    note: typeof note === 'string' ? note : '',
    author: author.trim(),
    date: now.toISOString(),
  };
  saveMark(dir, mark);
  return mark;
}

export const recordKind = (m: Mark) => (m.replyTo !== undefined ? 'reply' : m.status === undefined ? 'comment' : 'mark');

export function addReply(dir: string, { replyTo, note, author = 'agent' }: { replyTo?: unknown; note?: unknown; author?: string }, now = new Date()) {
  const comment = loadMarks(dir).find((m) => m.id === replyTo && recordKind(m) === 'comment');
  if (!comment) throw new Error(`no comment with ID "${replyTo}"`);
  if (typeof note !== 'string' || !note.trim()) throw new Error('a reply needs a note');
  const reply: Mark = { id: crypto.randomUUID(), target: comment.target, replyTo: comment.id, note, author, date: now.toISOString() };
  saveMark(dir, reply);
  return reply;
}

// 화면 · 호출 ID 에는 괄호가 들어가지 않으므로(map.ts 의 TAG_FORBIDDEN) story(<ID>) 는 노드의 키가 될 수 없다.
const targetKey = (t: MarkTarget) => (t.story !== undefined
  ? `story(${t.story})`
  : [t.node, t.option && `${t.option.key}=${t.option.value}`, t.depth, t.case && `case:${t.case}`, t.part && `part:${t.part.kind}:${JSON.stringify(t.part.key)}`].filter(Boolean).join(' '));

export function classifyMarks(marks: Mark[], map: MarkableMap, storyIds: string[] = [], caseKinds: string[] = [], tests: PartContext['tests'] = {}): { attached: MarkEntry[]; detached: MarkEntry[] } {
  const nodes = new Map<string, Set<string>>([
    ...map.screens.map((s): [string, Set<string>] => [s.id, new Set()]),
    ...(map.calls ?? []).map((c): [string, Set<string>] => [c.id, new Set((c.options ?? []).map((o) => o.key))]),
  ]);
  const stories = new Set(storyIds);
  const kinds = new Set(caseKinds);
  const isAttached = (t: MarkTarget) => (t.story !== undefined
    ? stories.has(t.story)
    : nodes.has(t.node!) && (!t.option || nodes.get(t.node!)!.has(t.option.key)) && (t.case === undefined || kinds.has(t.case)));
  const byTarget = new Map<string, Mark[]>();
  const ordered = [...marks].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const m of ordered) {
    const key = targetKey(m.target);
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key)!.unshift(m);
  }
  const attached: MarkEntry[] = [];
  const detached: MarkEntry[] = [];
  for (const key of [...byTarget.keys()].sort()) {
    const history = byTarget.get(key)!;
    const target = history[0].target;
    const where = target.part && nodes.has(target.node!) ? locatePart(target, { tests }) : null;
    const entry = { key, target, current: history.find((m) => m.status !== undefined) ?? null, history, ...(target.part && { where }) };
    (isAttached(target) && (!target.part || where) ? attached : detached).push(entry);
  }
  return { attached, detached };
}
