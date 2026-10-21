import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CASE_KIND, isPlainObject } from './config.ts';
import type { CasePick } from './config.ts';
import { reference } from './judgments.ts';
import type { TestRef } from './judgments.ts';
import { locatePart, locateStoryPart, STORY_PART_KINDS } from './parts.ts';
import type { HopKey, HopPlace, LinkKey, PartContext, PartScreen, SourcePlaces, StepKey, StepPlace, StoryPath, TestPlace } from './parts.ts';
import { isScreenList, isText, STORY_ID } from './stories.ts';
import { DEPTHS } from './test-links.ts';

export const MARK_STATUSES = ['needs-more', 'missing', 'fine'];
export const CASE_STATUSES = ['needed', 'not-needed'];

interface MarkTarget {
  story?: string;
  candidate?: string;
  screens?: string[];
  node?: string;
  option?: { key: string; value: boolean };
  depth?: string;
  case?: string;
  part?: Part;
}

export interface Part {
  kind: string;
  key: TestRef | string | LinkKey | StepKey | HopKey;
}

export const PART_KINDS = ['test', 'condition', 'link'];

export interface MarkRule {
  index: number;
  pick: CasePick;
}

// status 가 없는 표시는 코멘트고, 그 가운데 replyTo 가 있는 것은 그 ID 의 코멘트에 단 답글이다.
// 대상이 하나면 target, 여럿이거나 없으면 targets 에 적는다.
export interface Mark {
  id: string;
  target?: MarkTarget;
  targets?: MarkTarget[];
  status?: string;
  replyTo?: string;
  note: string;
  rule?: MarkRule;
  author: string;
  date: string;
  via?: string;
}

interface NewMark {
  target?: MarkTarget;
  targets?: MarkTarget[];
  status?: string | null;
  note?: unknown;
  rule?: MarkRule;
  author?: unknown;
  via?: string;
}

interface MarkableMap {
  screens: PartScreen[];
  calls?: { id: string; options?: { key: string }[] }[];
}

export interface MarkEntry {
  key: string;
  target: MarkTarget;
  current: Mark | null;
  history: Mark[];
  where?: TestPlace | SourcePlaces | StepPlace | HopPlace | null;
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
    .filter((f) => f.endsWith('.json') && fs.statSync(path.join(dir, f)).isFile())
    .map((f) => {
      const file = path.join(dir, f);
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`${file}: ${(err as Error).message}`);
      }
    });
}

export const mergedStatus = (mark: Mark): Mark => (mark.status === 'missing' ? { ...mark, status: 'needs-more' } : mark);

// 표시 하나를 파일 하나로 저장하고 기존 파일은 고치지 않으므로, 두 사람이 따로 남긴 표시도 git 에서 충돌 없이 합쳐진다.
// 어느 화면의 표시인지는 폴더 이름이 아니라 파일 안의 target 으로 정한다.
function saveMark(dir: string, mark: Mark) {
  const [first] = targetsOf(mark);
  if (!first) return writeNewRecord(path.join(dir, 'general', recordName(mark)), mark);
  const { story, candidate, screens, node } = first;
  const folder = candidate !== undefined ? path.join(dir, 'stories', 'candidates', keyFolder(candidate))
    : screens !== undefined ? path.join(dir, 'stories', 'orders', keyFolder(orderKey(screens)))
    : story ? path.join(dir, 'stories', story) : path.join(dir, fileSafe(node!));
  writeNewRecord(path.join(folder, recordName(mark)), mark);
}

function keyFolder(key: string) {
  const safe = fileSafe(key);
  return safe.length <= 80 ? safe : `${safe.slice(0, 71)}-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

function candidateTarget(target: MarkTarget) {
  if (!isText(target.candidate)) throw new Error('a candidate mark needs the key of a story candidate');
  if (['story', 'screens', 'node', 'option', 'depth', 'case', 'part'].some((k) => (target as Record<string, unknown>)[k] !== undefined)) throw new Error('a candidate mark takes no story, screens, node, option, depth, case or part');
  return { candidate: target.candidate };
}

// 빈칸이 든 화면 ID 는 받지 않으므로 ` > ` 로 이어도 서로 다른 순서가 같은 키가 되지 않는다.
export const orderKey = (screens: string[]) => screens.join(' > ');

function orderTarget(target: MarkTarget) {
  const { screens } = target;
  if (!isScreenList(screens) || screens.some((s) => /\s/.test(s))) throw new Error('a screen order mark needs a list of one or more screen IDs without spaces');
  const repeated = screens.findIndex((s, i) => i > 0 && s === screens[i - 1]);
  if (repeated > 0) throw new Error(`screens ${repeated} and ${repeated + 1} of a screen order are the same screen`);
  if (['story', 'candidate', 'node', 'option', 'depth', 'case', 'part'].some((k) => (target as Record<string, unknown>)[k] !== undefined)) throw new Error('a screen order mark takes no story, candidate, node, option, depth, case or part');
  return { screens: [...screens] };
}

function storyTarget(target: MarkTarget) {
  if (typeof target.story !== 'string' || !STORY_ID.test(target.story)) throw new Error(`"${target.story}" is not a story ID`);
  if (['screens', 'node', 'option', 'depth', 'case'].some((k) => (target as Record<string, unknown>)[k] !== undefined)) throw new Error('a story mark takes no screens, node, option, depth or case');
  if (target.part === undefined) return { story: target.story };
  const { kind, key }: Partial<Part> = isPlainObject(target.part) ? target.part! : {};
  if (!STORY_PART_KINDS.includes(kind!)) throw new Error(`unknown story part kind "${kind}" (expected ${STORY_PART_KINDS.join(', ')})`);
  return { story: target.story, part: { kind: kind!, key: kind === 'step' ? stepKey(key) : hopKey(key) } };
}

const stepNumber = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;

function stepKey(key: unknown): StepKey {
  const { step, screen } = isPlainObject(key) ? key as Record<string, unknown> : {};
  if (!stepNumber(step) || !isText(screen)) throw new Error('a step part needs its step number, counted from 1, and the screen of that step');
  return { step, screen };
}

function hopKey(key: unknown): HopKey {
  const { step, from, to } = isPlainObject(key) ? key as Record<string, unknown> : {};
  if (!stepNumber(step) || !isText(from) || !isText(to)) throw new Error('a hop part needs the number of the step it leaves, counted from 1, and the screens it leaves and reaches');
  return { step, from, to };
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
  return { node: target.node, part: { kind: kind!, key: kind === 'condition' ? conditionKey(key) : kind === 'link' ? linkPartKey(key) : testKey(key) } };
}

function testKey(key: unknown) {
  const k = (isPlainObject(key) ? key : {}) as Record<string, unknown>;
  if (!isText(k.source) || !(isText(k.file) || k.file === null) || !isText(k.title)) throw new Error('a test part needs a result file, a test file and a title');
  return reference(k as unknown as TestRef);
}

function conditionKey(key: unknown) {
  if (typeof key !== 'string' || !/^(?:role|setting):\S/.test(key)) throw new Error('a condition part needs a key such as role:<role> or setting:<path>=on');
  return key;
}

const textList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

function linkPartKey(key: unknown): LinkKey {
  const { from, conditions, guards } = isPlainObject(key) ? key as Record<string, unknown> : {};
  const byConditions = textList(conditions) && conditions.length > 0 && guards === undefined;
  const byGuards = conditions === undefined && textList(guards);
  if (!isText(from) || !(byConditions || byGuards)) throw new Error('a link part needs the screen it starts from and either the conditions read from it or its guards');
  const sorted = (list: string[]) => [...new Set(list)].sort();
  return byConditions ? { from, conditions: sorted(conditions as string[]) } : { from, guards: sorted(guards as string[]) };
}

const checkTarget = (target: MarkTarget | undefined): MarkTarget => (target?.candidate !== undefined ? candidateTarget(target) : target?.screens !== undefined ? orderTarget(target) : target?.story !== undefined ? storyTarget(target) : target?.part !== undefined ? partTarget(target) : target?.case !== undefined ? caseTarget(target) : nodeTarget(target));

export const targetsOf = (m: { target?: MarkTarget; targets?: MarkTarget[] }) => m.targets ?? (m.target ? [m.target] : []);

export function addMark(dir: string, { target, targets, status, note, rule, author, via }: NewMark, now = new Date()) {
  if (targets !== undefined && !Array.isArray(targets)) throw new Error('mark targets must be a list');
  const all = (targets ?? [target]).map(checkTarget);
  const hasStatus = status !== undefined && status !== null;
  if (all.length !== 1) {
    if (hasStatus) throw new Error('a status takes exactly one target; a comment on several targets or none takes no status');
    if (all.some((t) => t.case !== undefined)) throw new Error('a case mark takes exactly one target');
    if (new Set(all.map(targetKey)).size !== all.length) throw new Error('a mark names the same target twice');
    if (all.filter((t) => t.screens !== undefined).length > 1) throw new Error('a mark takes one screen order at most');
  }
  const checked: MarkTarget = all.length === 1 ? all[0] : {};
  if (checked.story !== undefined && checked.part && hasStatus) throw new Error('a comment on a step or a hop of a story takes no status; put the status on the story itself');
  if (checked.part && hasStatus) throw new Error('a comment on a part of a screen or call takes no status; put the status on the screen or call itself');
  if (checked.candidate !== undefined && hasStatus) throw new Error('a comment on a story candidate takes no status; accept it as a story to give it one');
  if (checked.screens !== undefined && hasStatus) throw new Error('a comment on a screen order takes no status');
  const statuses = checked.case !== undefined ? CASE_STATUSES : MARK_STATUSES;
  const comment = !hasStatus && checked.case === undefined;
  if (comment && (typeof note !== 'string' || !note.trim())) throw new Error('a comment needs a note');
  if (!comment && !statuses.includes(status!)) {
    throw new Error(`unknown ${checked.case !== undefined ? 'case mark' : 'mark'} status "${status}" (expected one of ${statuses.join(', ')})`);
  }
  if (rule !== undefined && (checked.case === undefined || status !== 'not-needed')) throw new Error('only a not-needed case mark names the rule it takes its target out of');
  if (typeof author !== 'string' || !author.trim()) throw new Error('mark needs an author');
  const mark: Mark = {
    id: crypto.randomUUID(),
    ...(all.length === 1 ? { target: checked } : { targets: all }),
    ...(!comment && { status: status! }),
    note: typeof note === 'string' ? note : '',
    ...(rule !== undefined && { rule }),
    author: author.trim(),
    date: now.toISOString(),
    ...(via !== undefined && { via }),
  };
  saveMark(dir, mark);
  return mark;
}

export const recordKind = (m: Mark) => (m.replyTo !== undefined ? 'reply' : m.status === undefined ? 'comment' : 'mark');

export function addReply(dir: string, { replyTo, note, author = 'agent' }: { replyTo?: unknown; note?: unknown; author?: string }, now = new Date()) {
  const comment = loadMarks(dir).find((m) => m.id === replyTo && recordKind(m) === 'comment');
  if (!comment) throw new Error(`no comment with ID "${replyTo}"`);
  if (typeof note !== 'string' || !note.trim()) throw new Error('a reply needs a note');
  const reply: Mark = { id: crypto.randomUUID(), ...(comment.targets ? { targets: comment.targets } : { target: comment.target }), replyTo: comment.id, note, author, date: now.toISOString() };
  saveMark(dir, reply);
  return reply;
}

export const GENERAL = 'general()';

// story(<ID>), candidate(<후보 키>), order(<화면 순서>) 는 노드의 키와 겹치지 않는다(map.ts 의 TAG_FORBIDDEN).
const targetKey = (t: MarkTarget) => (t.candidate !== undefined
  ? `candidate(${t.candidate})`
  : t.screens !== undefined
  ? `order(${orderKey(t.screens)})`
  : t.story !== undefined
  ? [`story(${t.story})`, t.part && `part:${t.part.kind}:${JSON.stringify(t.part.key)}`].filter(Boolean).join(' ')
  : [t.node, t.option && `${t.option.key}=${t.option.value}`, t.depth, t.case && `case:${t.case}`, t.part && `part:${t.part.kind}:${JSON.stringify(t.part.key)}`].filter(Boolean).join(' '));

export function classifyMarks(marks: Mark[], map: MarkableMap, storyIds: string[] = [], caseKinds: string[] = [], tests: PartContext['tests'] = {}, roleGuards: Record<string, string[]> = {}, candidateKeys: string[] = [], storyPaths: StoryPath[] = []): { attached: MarkEntry[]; detached: MarkEntry[] } {
  const nodes = new Map<string, Set<string>>([
    ...map.screens.map((s): [string, Set<string>] => [s.id, new Set()]),
    ...(map.calls ?? []).map((c): [string, Set<string>] => [c.id, new Set((c.options ?? []).map((o) => o.key))]),
  ]);
  const stories = new Set(storyIds);
  const kinds = new Set(caseKinds);
  const candidates = new Set(candidateKeys);
  const paths = new Map(storyPaths.map((p) => [p.id, p]));
  const screenIds = new Set(map.screens.map((s) => s.id));
  const isAttached = (t: MarkTarget) => (t.candidate !== undefined
    ? candidates.has(t.candidate)
    : t.screens !== undefined
    ? t.screens.every((id) => screenIds.has(id))
    : t.story !== undefined
    ? stories.has(t.story)
    : nodes.has(t.node!) && (!t.option || nodes.get(t.node!)!.has(t.option.key)) && (t.case === undefined || kinds.has(t.case)));
  const byTarget = new Map<string, Mark[]>();
  const targetAt = new Map<string, MarkTarget>();
  const ordered = [...marks].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const m of ordered) {
    const targets = targetsOf(m);
    for (const [key, target] of targets.length ? targets.map((t): [string, MarkTarget] => [targetKey(t), t]) : [[GENERAL, {}] as [string, MarkTarget]]) {
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key)!.unshift(m);
      targetAt.set(key, target);
    }
  }
  const attached: MarkEntry[] = [];
  const detached: MarkEntry[] = [];
  for (const key of [...byTarget.keys()].sort()) {
    const history = byTarget.get(key)!;
    const target = targetAt.get(key)!;
    if (key === GENERAL) {
      attached.push({ key, target, current: null, history });
      continue;
    }
    const path = target.story !== undefined ? paths.get(target.story) : undefined;
    const where = !target.part ? null
      : target.story !== undefined ? path && locateStoryPart(target.part, path, map.screens)
      : nodes.has(target.node!) ? locatePart(target, { tests, screens: map.screens, roleGuards }) : null;
    const entry = { key, target, current: history.find((m) => m.status !== undefined) ?? null, history, ...(target.part && { where: where ?? null }) };
    // 읽지 못한 스토리 파일의 단계는 맞춰 볼 수 없으므로, 스토리 코멘트처럼 「목록 밖 스토리 코멘트」에 남긴다.
    const located = !target.part || where || (target.story !== undefined && !path);
    (isAttached(target) && located ? attached : detached).push(entry);
  }
  return { attached, detached };
}
