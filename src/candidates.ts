import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isAppPath, pathOf, screenFinder } from './address-match.ts';
import type { ForwardedRequest } from './app-host.ts';
import { compare, isPlainObject } from './config.ts';
import { jsonFiles } from './json-files.ts';
import { loadMarks, orderKey, recordKind, recordName, targetsOf, writeNewRecord } from './marks.ts';
import type { SentRequests } from './request-options.ts';
import { addStory, CANDIDATES, DISCARDED, inputsProblem, joinedFields, keptSteps, RECORDS, isDate, isScreenList, isSource, isText, loadStories, sameBox, sourceAfterSteps, SOURCE_SHAPES, STEP_FIELDS, stepProblem, writableStoriesFolder } from './stories.ts';
import type { CommentSource, ReplacedCandidate, StepFields, StepInput, StorySource } from './stories.ts';
import { checkStories, linksFromOldDuru, staleMapMessage } from './story-paths.ts';
import { titleWithoutTags } from './verdict.ts';

const relative = (configDir: string, file: string) => path.relative(configDir, file).split(path.sep).join('/');

function recordFiles(source: string): { reason?: string; files: string[] } {
  if (!fs.existsSync(source)) return { reason: '방문 기록 출처가 없습니다', files: [] };
  if (!fs.statSync(source).isDirectory()) return { files: [source] };
  try {
    return { files: (fs.readdirSync(source, { recursive: true }) as string[]).filter((f) => f.endsWith('.json')).map((f) => path.join(source, f)) };
  } catch (err: any) {
    return { reason: `방문 기록 폴더를 읽지 못했습니다: ${err.message}`, files: [] };
  }
}

const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

function typedProblem(step: any, i: number) {
  const problem = inputsProblem(step.inputs, `${i + 1} 번째 단계`);
  if (problem) return problem;
  return step.skipped === undefined || isCount(step.skipped) ? null : `${i + 1} 번째 단계의 skipped 는 넣지 못한 입력의 수로, 0 이상의 정수여야 합니다`;
}

function requestProblem(r: any, i: number) {
  const at = `requests 의 ${i + 1} 번째 요청`;
  if (!isPlainObject(r)) return `${at}은 객체여야 합니다`;
  if (typeof r.method !== 'string' || !r.method) return `${at}의 method 가 문자열이 아니거나 비어 있습니다`;
  if (!isAppPath(r.url)) return `${at}의 url 은 / 로 시작하는 주소여야 합니다`;
  if (r.body !== undefined && typeof r.body !== 'string') return `${at}의 body 는 문자열이어야 합니다`;
  if (r.shown !== undefined && !isAppPath(r.shown)) return `${at}의 shown 은 / 로 시작하는 앱 안 주소여야 합니다`;
  return null;
}

function readRecord(file: string): { reason: string } | Pick<VisitRecord, 'addresses' | 'stepCount' | 'requests'> {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err: any) {
    return { reason: `JSON 으로 읽지 못했습니다: ${err.message}` };
  }
  const steps = Array.isArray(record) ? record : isPlainObject(record) && Array.isArray(record.steps) ? record.steps : null;
  if (!steps) return { reason: '단계 배열이거나, steps 에 단계 배열을 담은 객체여야 합니다' };
  if (!steps.length) return { reason: '단계가 없습니다' };
  const addresses: { address: string; step: number }[] = [];
  for (const [i, step] of steps.entries()) {
    if (!isPlainObject(step)) return { reason: `${i + 1} 번째 단계는 객체여야 합니다` };
    if (step.url == null) continue;
    if (typeof step.url !== 'string' || !step.url.trim()) return { reason: `${i + 1} 번째 단계의 url 이 문자열이 아니거나 비어 있습니다` };
    const address = pathOf(step.url.trim());
    if (!address) return { reason: `${i + 1} 번째 단계의 url 을 읽지 못했습니다` };
    const typed = typedProblem(step, i);
    if (typed) return { reason: typed };
    addresses.push({ address, step: i + 1, ...(step.inputs?.length && { inputs: step.inputs }), ...(step.skipped && { skipped: step.skipped }) });
  }
  if (!addresses.length) return { reason: 'url 이 있는 단계가 없습니다' };
  const requests = Array.isArray(record) ? undefined : record.requests;
  if (requests !== undefined && !Array.isArray(requests)) return { reason: 'requests 는 요청 목록이어야 합니다' };
  for (const [i, r] of (requests ?? []).entries()) {
    const problem = requestProblem(r, i);
    if (problem) return { reason: problem };
  }
  return { addresses, stepCount: steps.length, ...(requests?.length && { requests }) };
}

interface VisitRecord {
  record: string;
  name: string;
  addresses: { address: string; step: number; inputs?: StepInput[]; skipped?: number }[];
  stepCount: number;
  requests?: ForwardedRequest[];
}

export interface TracedTest {
  report: string;
  title: string;
  file?: string | null;
  line?: number | null;
  screens: string[];
  inputs?: StepInput[][];
  skipped?: number;
}

interface TestsSource {
  report: string;
  tests: string[];
}

type LineField = keyof StepFields;

// line 은 source.written 에서 그 단계 · 칸의 몇 번째 줄인지(1 부터)다.
export interface OffLine {
  step: number;
  field: LineField;
  line: number;
}

// row 는 stepFields 에서 그 단계 · 칸의 몇 번째 줄인지(0 부터)다.
export interface AgentLine extends OffLine {
  row: number;
  on: boolean;
}

export interface Candidate {
  key: string;
  name: string;
  screens: string[];
  source: { record: string; steps: number[] } | TestsSource | CommentSource;
  stepRanges?: [number, number][];
  stepFields?: StepFields[];
  skipped?: number;
  skippedByRule?: { found: string[]; steps: number[] };
  file?: string;
  lines?: AgentLine[];
  offSteps?: number[];
  originals?: ReplacedCandidate[];
  acceptProblem?: string;
}

const inputFields = (inputs: StepInput[][] = []) => (inputs.some((i) => i.length) ? inputs.map((i) => (i.length ? { inputs: i } : {})) : undefined);
const carried = ({ stepFields, skipped }: { stepFields?: StepFields[]; skipped?: number }) => ({ ...(stepFields && { stepFields }), ...(skipped && { skipped }) });

export function loadVisitRecords(sources: string[], configDir: string) {
  const records: VisitRecord[] = [];
  const notices: { file: string; reason: string }[] = [];
  const files: string[] = [];
  for (const source of sources) {
    const found = recordFiles(source);
    if (found.reason) notices.push({ file: relative(configDir, source), reason: found.reason });
    files.push(...found.files);
  }
  for (const file of [...new Set(files)].sort((a, b) => compare(relative(configDir, a), relative(configDir, b)))) {
    const read = readRecord(file);
    const record = relative(configDir, file);
    if ('reason' in read) notices.push({ file: record, reason: read.reason });
    else records.push({ record, name: path.basename(file, '.json'), ...read });
  }
  return { records, notices };
}

export type SkipRule = { screen: string; where: 'start' | 'end' | 'any' };

// 한 번 뺀 순서를 다시 넣어도 그대로 남도록, 뺄 것이 없어질 때까지 되풀이한다. `any` 로 화면을 빼서 맨 앞이나
// 맨 끝에 새로 놓인 `start`·`end` 화면도 함께 빠지므로, 이미 규칙을 거친 순서를 다시 넣어도 후보가 늘지 않는다.
export function skipByRules(screens: string[], rules: SkipRule[]): { kept: number[] } {
  const named = (where: SkipRule['where']) => new Set(rules.filter((r) => r.where === where).map((r) => r.screen));
  const starts = named('start');
  const ends = named('end');
  const anywheres = named('any');
  let kept = screens.map((_, i) => i);
  for (;;) {
    const dropped = new Set<number>();
    let head = 0;
    while (head < kept.length && starts.has(screens[kept[head]])) dropped.add(head++);
    let tail = kept.length - 1;
    while (tail >= 0 && ends.has(screens[kept[tail]])) dropped.add(tail--);
    kept.forEach((screen, at) => { if (anywheres.has(screens[screen])) dropped.add(at); });
    if (!dropped.size) return { kept };
    kept = kept.filter((_, at) => !dropped.has(at));
  }
}

// 단계를 빼고 같은 화면이 나란히 남으면 한 단계다.
function sameScreenRuns(screens: string[], left: number[]) {
  const groups: number[][] = [];
  for (const i of left) {
    const group = groups.at(-1);
    if (group && screens[group.at(-1)!] === screens[i]) group.push(i);
    else groups.push([i]);
  }
  return groups;
}

// 규칙을 거친 뒤 보이는 단계마다, 찾은 순서로 몇 번째 것들이 모였는지.
function shownGroups(screens: string[], rules: SkipRule[]) {
  const { kept } = skipByRules(screens, rules);
  return kept.length === screens.length ? kept.map((i) => [i]) : sameScreenRuns(screens, kept);
}

const shownOrder = (screens: string[], rules: SkipRule[]) => shownGroups(screens, rules).map((g) => screens[g[0]]);

const rulesFor = (source: Candidate['source'], rules: SkipRule[]) => ('comment' in source ? [] : rules);

// 후보 파일의 offSteps 는 찾은 순서의 번호라 규칙을 고쳐도 같은 화면을 가리킨다. 목록의 offSteps 는 보이는 단계의 번호다.
// 규칙이 바뀌어 보이는 단계가 모두 빠진 셈이 되면 받을 수 있게 모두 되돌려 보인다.
function shownOffSteps(screens: string[], offSteps: number[] | undefined, rules: SkipRule[]) {
  if (!offSteps) return undefined;
  const groups = shownGroups(screens, rules);
  const shown = groups.flatMap((g, at) => (g.every((i) => offSteps.includes(i + 1)) ? [at + 1] : []));
  return shown.length && shown.length < groups.length ? shown : undefined;
}

// 뺀 화면이 있을 때, 파일에 남길 발견한 차례의 칸. skippedByRule 은 후보를 베껴도 같은 객체라 함께 따라간다.
const foundStepFields = new WeakMap<object, StepFields[]>();

// candidateSkipScreens 가 뺀 화면을 뺀 후보. 뺀 화면이 없으면 받은 후보를 그대로 주고, 화면이 하나도 안 남으면 null 이다.
function ruled(candidate: Candidate, rules: SkipRule[]): Candidate | null {
  if (!rules.length) return candidate;
  const groups = shownGroups(candidate.screens, rules);
  const kept = groups.flat();
  if (kept.length === candidate.screens.length) return candidate;
  if (!kept.length) return null;
  const dropped = candidate.screens.flatMap((_, i) => (kept.includes(i) ? [] : [i + 1]));
  const screens = shownOrder(candidate.screens, rules);
  const stepRanges = candidate.stepRanges && groups.map((g) => [candidate.stepRanges![g[0]][0], candidate.stepRanges![g.at(-1)!][1]] as [number, number]);
  const stepFields = candidate.stepFields && groups.map((g) => joinedFields(g.map((i) => candidate.stepFields![i] ?? {})));
  const skippedByRule = { found: candidate.screens, steps: dropped };
  if (candidate.stepFields) foundStepFields.set(skippedByRule, candidate.stepFields);
  return {
    ...candidate,
    key: screens.join(' > '),
    screens,
    ...(stepRanges && { stepRanges }),
    ...(stepFields && { stepFields }),
    skippedByRule,
  };
}

const foundOrder = ({ skippedByRule, screens, stepFields }: Candidate) => (skippedByRule ? { screens: skippedByRule.found, stepFields: foundStepFields.get(skippedByRule) } : { screens, stepFields });

function candidateOf({ record, name, addresses, stepCount }: VisitRecord, screenAt: (url: string) => string | null): Candidate {
  const screens: string[] = [];
  const stepRanges: [number, number][] = [];
  const inputs: StepInput[][] = [];
  let skipped = 0;
  for (const { address, step, inputs: typed = [], skipped: left = 0 } of addresses) {
    const screen = screenAt(address) ?? address;
    if (screen === screens.at(-1)) stepRanges.at(-1)![1] = step;
    else {
      screens.push(screen);
      stepRanges.push([step, step]);
      inputs.push([]);
    }
    for (const input of typed) {
      const at = inputs.at(-1)!;
      const kept = at.findIndex((i) => sameBox(i, input));
      if (kept >= 0) at[kept] = input;
      else at.push(input);
    }
    skipped += left;
  }
  return { key: screens.join(' > '), name, screens, source: { record, steps: [1, stepCount] }, stepRanges, ...carried({ stepFields: inputFields(inputs), skipped }) };
}

function discardedProblemOf(d: any) {
  if (!isPlainObject(d)) return '버린 후보는 JSON 객체여야 합니다';
  if (!isScreenList(d.screens)) return 'screens 는 화면을 하나 이상 차례대로 담은 목록이어야 합니다';
  if (d.kind !== undefined && d.kind !== 'undo') return 'kind 는 버린 기록이면 적지 않고, 되돌린 기록이면 "undo" 여야 합니다';
  if (d.kind === undefined && !isText(d.reason)) return 'reason 에 버린 이유를 적어야 합니다';
  if (d.backToOriginal !== undefined && d.backToOriginal !== true) return 'backToOriginal 은 원래대로 되돌린 기록이면 true 여야 합니다';
  if (!isText(d.author)) return 'author 에 작성자를 적어야 합니다';
  if (!isDate(d.date)) return 'date 는 2026-10-02 같은 날짜여야 합니다';
  return null;
}

const sameLine = (a: OffLine) => (b: OffLine) => a.step === b.step && a.field === b.field && a.line === b.line;
const OFF_LINES = 'offLines 는 받을 때 뺄 줄을 { "step", "field", "line" } 으로 하나씩, source 의 written 에 있는 줄만 겹치지 않게 적은 목록이어야 합니다';

function offLinesProblem(offLines: unknown, source: any) {
  if (!('comment' in source)) return 'offLines 는 출처가 코멘트인 후보에만 둡니다';
  if (!Array.isArray(offLines) || !offLines.length) return OFF_LINES;
  const written: CommentSource['written'] = source.written;
  const fits = (o: any, i: number) => isPlainObject(o) && Object.keys(o).length === 3 && Number.isInteger(o.line) && o.line > 0
    && STEP_FIELDS.includes(o.field) && (written.find((w) => w.step === o.step)?.[o.field as LineField]?.length ?? 0) >= o.line
    && offLines.findIndex(sameLine(o)) === i;
  return offLines.every(fits) ? null : OFF_LINES;
}

function storedProblemOf(c: any) {
  if (!isPlainObject(c)) return '스토리 후보는 JSON 객체여야 합니다';
  if (!isText(c.name)) return 'name 에 후보 이름을 적어야 합니다';
  if (!isScreenList(c.screens)) return 'screens 는 화면을 하나 이상 차례대로 담은 목록이어야 합니다';
  if (!isSource(c.source)) return SOURCE_SHAPES;
  if (!isDate(c.date)) return 'date 는 2026-10-02 같은 날짜여야 합니다';
  if (c.skipped !== undefined && !(Number.isInteger(c.skipped) && c.skipped > 0)) return 'skipped 는 옮기지 못한 동작의 수로, 1 이상의 정수여야 합니다';
  if (c.stepFields !== undefined) {
    if (!Array.isArray(c.stepFields) || c.stepFields.length !== c.screens.length) return 'stepFields 는 screens 와 같은 길이의 목록이어야 합니다';
    for (const [i, f] of c.stepFields.entries()) {
      const where = `stepFields 의 ${i + 1} 번째`;
      if (!isPlainObject(f) || 'screen' in f) return `${where}는 { "needs", "linkNeeds", "inputs", "expects" } 객체여야 합니다`;
      const problem = stepProblem({ ...f, screen: c.screens[i] }, where, i === 0);
      if (problem) return problem;
    }
  }
  if (c.offSteps !== undefined) {
    const off = c.offSteps;
    const fits = Array.isArray(off) && off.length > 0 && off.length < c.screens.length
      && off.every((s: unknown, i: number) => Number.isInteger(s) && (s as number) >= 1 && (s as number) <= c.screens.length && (i === 0 || (off[i - 1] as number) < (s as number)));
    if (!fits) return 'offSteps 는 받을 때 뺄 단계의 번호를 1 부터 세어 작은 것부터 하나씩 적은 목록이어야 하고, 단계를 하나 이상 남겨야 합니다';
  }
  if (c.acceptedAs !== undefined && !isText(c.acceptedAs)) return 'acceptedAs 는 받은 스토리의 ID 여야 합니다';
  return c.offLines === undefined ? null : offLinesProblem(c.offLines, c.source);
}

const FOLDERS = {
  [DISCARDED]: { what: '버린 후보', problemOf: discardedProblemOf },
  [CANDIDATES]: { what: '스토리 후보', problemOf: storedProblemOf },
};

function loadFolder(dir: string, name: keyof typeof FOLDERS) {
  const { what, problemOf } = FOLDERS[name];
  const folder = path.join(dir, name);
  if (!fs.existsSync(folder)) return { found: [], notices: [] };
  if (!fs.statSync(folder).isDirectory()) return { found: [], notices: [{ file: name, reason: `${name} 는 ${what}를 담는 폴더여야 합니다` }] };
  const say = {
    folder: (message: string) => `${what} 폴더를 읽지 못했습니다: ${message}`,
    missing: () => '링크가 가리키는 파일이 없습니다',
    link: (message: string) => `링크를 따라가지 못했습니다: ${message}`,
  };
  const found: any[] = [];
  const notices: { file: string; reason: string }[] = [];
  for (const entry of jsonFiles(folder, say)) {
    const file = path.join(name, entry.file);
    if (entry.reason) {
      notices.push({ file: entry.file === folder ? name : file, reason: entry.reason });
      continue;
    }
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err: any) {
      notices.push({ file, reason: `JSON 으로 읽지 못했습니다: ${err.message}` });
      continue;
    }
    const problem = problemOf(d);
    if (problem) notices.push({ file, reason: problem });
    else found.push({ ...d, file });
  }
  return { found, notices };
}

export function loadDiscarded(dir: string) {
  const { found, notices } = loadFolder(dir, DISCARDED);
  return { discarded: found, notices };
}

function discardedNow(records: any[]) {
  const latest = new Map<string, any>();
  for (const d of records) {
    const key = JSON.stringify(d.screens);
    const kept = latest.get(key);
    if (!kept || compare(kept.date, d.date) < 0 || (kept.date === d.date && compare(kept.file, d.file) < 0)) latest.set(key, d);
  }
  return [...latest.values()].filter((d) => d.kind !== 'undo');
}

const shownDiscarded = (discarded: any[]) =>
  [...discarded].sort((a, b) => compare(b.date, a.date) || compare(a.file, b.file)).map(({ name, screens, reason, author, date }) => ({ name, screens, reason, author, date }));

const isFolder = (file: string) => fs.existsSync(file) && fs.statSync(file).isDirectory();
const loadStored = (dir: string) => (isFolder(dir) ? loadFolder(dir, CANDIDATES) : { found: [], notices: [] });

const byFirstSeen = (a: any, b: any) => compare(a.date, b.date) || compare(a.screens.join(' > '), b.screens.join(' > ')) || compare(a.file, b.file);

// 쓴 파일은 고치지도 지우지도 않는다.
export function storeCandidates(dir: string, list: Candidate[], now = new Date(), acceptedAs?: string) {
  const folder = path.join(dir, CANDIDATES);
  if (fs.existsSync(dir) && !isFolder(dir)) return { written: 0 };
  if (fs.existsSync(folder) && !isFolder(folder)) return { written: 0 };
  const stored = new Set(loadStored(dir).found.map((c) => JSON.stringify(c.screens)));
  const date = now.toISOString();
  let written = 0;
  for (const candidate of list) {
    const { name, source } = candidate;
    const found = foundOrder(candidate);
    const key = JSON.stringify(found.screens);
    if (stored.has(key)) continue;
    stored.add(key);
    try {
      writeNewRecord(path.join(folder, `${date.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.json`), { name, screens: found.screens, source, date, ...carried({ stepFields: found.stepFields, skipped: candidate.skipped }), ...(acceptedAs && { acceptedAs }) });
    } catch (err: any) {
      return { written, reason: `후보 파일을 쓰지 못했습니다: ${err.message}` };
    }
    written++;
  }
  return { written };
}

export const candidatePlace = ({ name, source, screens, stepRanges }: Candidate) => ({ name, source, screens, ...(stepRanges && { stepRanges }) });

const filledFields = (fields: Record<string, unknown> = {}): StepFields => Object.fromEntries(STEP_FIELDS.filter((k) => Array.isArray(fields[k]) && fields[k].length).map((k) => [k, fields[k]]));

const withFields = ({ screens, stepFields }: Pick<Candidate, 'screens' | 'stepFields'>) => screens.map((screen, i) => {
  const fields = filledFields(stepFields?.[i] as Record<string, unknown>);
  return Object.keys(fields).length ? { screen, ...fields } : screen;
});

// 받은 스토리의 순서와 줄을 고치고 받기를 되돌리면 새 후보 파일의 stepFields 가 written 과 어긋날 수 있으므로, 같은 칸 안에서 글이 같은 줄끼리 앞에서부터 하나씩 짝짓는다.
function agentLines(source: CommentSource, stepFields: StepFields[] = [], offLines: OffLine[] = []): AgentLine[] {
  return source.written.flatMap(({ step, ...fields }) => Object.entries(fields).flatMap(([key, lines]) => {
    const field = key as LineField;
    const rows: unknown[] = stepFields[step - 1]?.[field] ?? [];
    const taken = new Set<number>();
    return (lines as unknown[]).flatMap((text, i) => {
      const row = rows.findIndex((r, at) => !taken.has(at) && isDeepStrictEqual(r, text));
      if (row < 0) return [];
      taken.add(row);
      const line = { step, field, line: i + 1 };
      return [{ ...line, row, on: !offLines.some(sameLine(line)) }];
    });
  }));
}

function pickedLines({ source, stepFields, lines }: Candidate) {
  if (!lines || !('comment' in source)) return { source, stepFields };
  const lineOn = (step: number, field: string) => (_: unknown, i: number) => lines.some((l) => l.on && l.step === step && l.field === field && l.line === i + 1);
  const rowKept = (step: number, field: string) => (_: unknown, row: number) => !lines.some((l) => !l.on && l.step === step && l.field === field && l.row === row);
  const written = source.written.flatMap(({ step, ...fields }) => {
    const kept = Object.entries(fields).map(([field, list]) => [field, (list as unknown[]).filter(lineOn(step, field))] as const).filter(([, list]) => list.length);
    return kept.length ? [{ step, ...Object.fromEntries(kept) }] : [];
  });
  const picked = stepFields?.map((fields, i) => Object.fromEntries(Object.entries(fields).map(([field, list]) => [field, (list as unknown[]).filter(rowKept(i + 1, field))])));
  return { source: { ...source, written }, stepFields: picked };
}

const stepsLeft = (screens: string[], offSteps: number[]) => sameScreenRuns(screens, screens.flatMap((_, i) => (offSteps.includes(i + 1) ? [] : [i])));
const orderLeft = (screens: string[], offSteps: number[]) => stepsLeft(screens, offSteps).map((g) => screens[g[0]]);

function stepsLeftProblem(stories: { id: string; screens: string[] }[], { screens, offSteps = [] }: Candidate) {
  if (!offSteps.length) return undefined;
  const same = stories.find((s) => isDeepStrictEqual(s.screens, orderLeft(screens, offSteps)));
  return same && `남은 단계가 이미 스토리 ${same.id} 의 화면 순서입니다. ✕ 를 바꾸거나 이 후보를 버려 주세요`;
}

export function acceptCandidate(dir: string, candidate: Candidate, { id, name, author }: { id: unknown; name: unknown; author: unknown }, now = new Date()) {
  const { source, stepFields } = pickedLines(candidate);
  const offSteps = candidate.offSteps ?? [];
  if (!offSteps.length) {
    const story = addStory(dir, { id, name, screens: withFields({ screens: candidate.screens, stepFields }), author, source }, now);
    if (candidate.file) writeAcceptedAs(dir, candidate.file, story.id);
    else storeCandidates(dir, [candidate], now, story.id);
    return story;
  }
  if (candidate.acceptProblem) throw new Error(candidate.acceptProblem);
  const groups = stepsLeft(candidate.screens, offSteps);
  const fieldsAt = (i: number): StepFields => stepFields?.[i] ?? {};
  const withoutLink = (i: number) => {
    const { linkNeeds: _, ...rest } = fieldsAt(i);
    return rest;
  };
  const steps = withFields({
    screens: groups.map((g) => candidate.screens[g[0]]),
    stepFields: groups.map((g) => (g.length === 1 ? fieldsAt(g[0]) : joinedFields([fieldsAt(g[0]), ...g.slice(1).map(withoutLink)]))),
  });
  const { screens, kept } = keptSteps(steps, groups.map((g) => g[0] + 1), groups.map((g) => g.at(-1)! + 1));
  for (const g of groups) for (const i of g.slice(1)) kept.set(i + 1, { step: kept.get(g[0] + 1)!.step, linked: false });
  const story = addStory(dir, { id, name, screens, author, source: sourceAfterSteps(source, kept) }, now);
  if (candidate.file) writeAcceptedAs(dir, candidate.file, story.id);
  return story;
}

function writeAcceptedAs(dir: string, file: string, id?: string) {
  const at = path.join(dir, file);
  const { acceptedAs: _, ...rest } = JSON.parse(fs.readFileSync(at, 'utf8'));
  fs.writeFileSync(at, JSON.stringify({ ...rest, ...(id && { acceptedAs: id }) }, null, 2) + '\n');
}

const lineOrder = (a: OffLine, b: OffLine) => a.step - b.step || STEP_FIELDS.indexOf(a.field) - STEP_FIELDS.indexOf(b.field) || a.line - b.line;

export function pickCandidateLine(dir: string, candidate: Candidate, { step, field, line, on }: Record<string, unknown>) {
  if (!candidate.lines || !candidate.file) throw new Error(`후보 「${candidate.name}」는 에이전트가 올린 후보가 아니라 줄마다 고르지 않습니다`);
  if (typeof on !== 'boolean') throw new Error('on 은 받을 줄이면 true, 뺄 줄이면 false 여야 합니다');
  const picked = candidate.lines.find((l) => l.step === step && l.field === field && l.line === line);
  if (!picked) throw new Error(`후보 「${candidate.name}」에는 에이전트가 ${step} 번째 단계의 ${field} 에 적은 ${line} 번째 줄이 없습니다`);
  const file = path.join(dir, candidate.file);
  const { offLines: before = [], ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const others: OffLine[] = before.filter((o: OffLine) => !sameLine(picked)(o));
  const offLines = (on ? others : [...others, { step: picked.step, field: picked.field, line: picked.line }]).sort(lineOrder);
  fs.writeFileSync(file, JSON.stringify({ ...rest, ...(offLines.length && { offLines }) }, null, 2) + '\n');
  return { file: candidate.file, offLines };
}

export function pickCandidateStep(dir: string, candidate: Candidate, input: object, rules: SkipRule[] = []) {
  const { step, on } = input as Record<string, unknown>;
  if (!Number.isInteger(step) || (step as number) < 1 || (step as number) > candidate.screens.length) throw new Error(`후보 「${candidate.name}」에는 ${step} 번째 단계가 없습니다`);
  if (typeof on !== 'boolean') throw new Error('on 은 넣을 단계면 true, 뺄 단계면 false 여야 합니다');
  const others = (candidate.offSteps ?? []).filter((s) => s !== step);
  const offSteps = on ? others : [...others, step as number].sort((a, b) => a - b);
  if (offSteps.length >= candidate.screens.length) throw new Error(`후보 「${candidate.name}」의 마지막 남은 단계는 뺄 수 없습니다`);
  let picked = candidate.file;
  if (!picked) {
    const folder = path.join(dir, CANDIDATES);
    if (fs.existsSync(folder) && !isFolder(folder)) throw new Error(`스토리 폴더 안 ${CANDIDATES} 가 파일이라 후보 파일을 쓸 수 없습니다`);
    const date = new Date().toISOString();
    const name = `${date.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.json`;
    const { name: candidateName, source, skipped } = candidate;
    const { screens, stepFields } = foundOrder(candidate);
    try {
      writeNewRecord(path.join(folder, name), { name: candidateName, screens, source, date, ...carried({ stepFields, skipped }) });
    } catch (err: any) {
      throw new Error(`후보 파일을 쓰지 못했습니다: ${err.message}`);
    }
    picked = path.join(CANDIDATES, name);
  }
  const file = picked!;
  const at = path.join(dir, file);
  const { offSteps: before = [], ...rest } = JSON.parse(fs.readFileSync(at, 'utf8'));
  const groups = shownGroups(rest.screens, rulesFor(candidate.source, rules));
  const pressed = groups[(step as number) - 1].map((i) => i + 1);
  const notPressed = before.filter((s: number) => !pressed.includes(s));
  const kept = on ? notPressed : [...notPressed, ...pressed];
  const hidesAll = groups.every((g) => g.every((i) => kept.includes(i + 1)));
  const cutByRule = before.filter((s: number) => !groups.flat().includes(s - 1));
  const written = (hidesAll ? [...cutByRule, ...offSteps.flatMap((s) => groups[s - 1].map((i) => i + 1))] : kept).sort((a: number, b: number) => a - b);
  fs.writeFileSync(at, JSON.stringify({ ...rest, ...(written.length && { offSteps: written }) }, null, 2) + '\n');
  return { file, offSteps };
}

export function unacceptStory(dir: string, id: unknown, rules: SkipRule[] = []) {
  if (!isFolder(dir)) throw new Error(`스토리 폴더 ${dir} 가 폴더가 아니라 스토리 파일을 지울 수 없습니다`);
  const story = loadStories(dir).stories.find((s) => s.id === id);
  if (!story) throw new Error(`스토리 ${id} 를 찾지 못했습니다`);
  if (!story.source) throw new Error(`스토리 ${id} 는 후보에서 받은 스토리가 아닙니다`);
  const source = story.source;
  const stepFields = story.stepFields && ('comment' in source ? story.stepFields : inputFields(story.stepFields.map((f) => f.inputs ?? [])));
  const found = loadStored(dir).found;
  const accepted = found.filter((c) => c.acceptedAs === story.id);
  const storyScreens = JSON.stringify(story.screens);
  const leavesStory = (c: any) => {
    const applied = rulesFor(c.source, rules);
    const off = shownOffSteps(c.screens, c.offSteps, applied) ?? [];
    const shown = shownOrder(c.screens, applied);
    return JSON.stringify(orderLeft(shown, off)) === storyScreens;
  };
  const back = accepted.find(leavesStory);
  if (!back) {
    const kept = storeCandidates(dir, [{ key: story.screens.join(' > '), name: story.id, screens: story.screens, source, ...carried({ stepFields }) }]);
    if (kept.reason) throw new Error(kept.reason);
  }
  fs.rmSync(path.join(dir, story.file));
  for (const c of accepted) writeAcceptedAs(dir, c.file);
  return { id: story.id, screens: story.screens, file: story.file, key: shownOrder(back?.screens ?? story.screens, rulesFor(source, rules)).join(' > ') };
}

export function backToOriginal(dir: string, candidate: Candidate, { author }: { author: unknown }, now = new Date()) {
  if (!candidate.originals?.length) throw new Error('이 후보는 대신하는 원래 후보가 없습니다');
  return discardCandidate(dir, candidate, { reason: '원래대로 되돌림', author }, now, { backToOriginal: true });
}

export function discardCandidate(dir: string, candidate: Candidate, { reason, author }: { reason: unknown; author: unknown }, now = new Date(), mark?: { backToOriginal: true }) {
  if (!isText(reason)) throw new Error('버리는 이유가 필요합니다');
  if (!isText(author)) throw new Error('작성자가 필요합니다');
  writableStoriesFolder(dir);
  const folder = path.join(dir, DISCARDED);
  if (fs.existsSync(folder) && !fs.statSync(folder).isDirectory()) throw new Error(`스토리 폴더 안 ${DISCARDED} 가 파일이라 버린 후보를 쓸 수 없습니다`);
  const byRule = candidate.skippedByRule;
  const beforeRule = byRule && { skippedByRule: byRule, foundStepFields: foundStepFields.get(byRule) };
  const discarded = { name: candidate.name, screens: candidate.screens, reason: reason.trim(), author: author.trim(), date: now.toISOString(), source: candidate.source, ...carried(candidate), ...beforeRule, ...mark };
  const file = recordName({ ...discarded, id: crypto.randomUUID() });
  writeNewRecord(path.join(folder, file), discarded);
  return { ...discarded, file: path.join(DISCARDED, file) };
}

export function undiscardCandidate(dir: string, screens: unknown, { author }: { author: unknown }, now = new Date()) {
  if (!isText(author)) throw new Error('작성자가 필요합니다');
  const key = JSON.stringify(screens);
  const discarded = discardedNow(loadDiscarded(dir).discarded).find((d) => JSON.stringify(d.screens) === key);
  if (!discarded) throw new Error(`버린 후보 ${Array.isArray(screens) ? screens.join(' > ') : screens} 가 없습니다`);
  if (isText(discarded.name) && isSource(discarded.source)) {
    const found = discarded.skippedByRule?.found;
    const byRule = storedProblemOf({ ...discarded, screens: found, stepFields: discarded.foundStepFields }) ? undefined : discarded.skippedByRule;
    if (byRule && discarded.foundStepFields) foundStepFields.set(byRule, discarded.foundStepFields);
    const kept = storeCandidates(dir, [{ key: discarded.screens.join(' > '), name: discarded.name, screens: discarded.screens, source: discarded.source, ...carried(discarded), ...(byRule && { skippedByRule: byRule }) }]);
    if (kept.reason) throw new Error(kept.reason);
  }
  const undone = { screens: discarded.screens, kind: 'undo', author: author.trim(), date: now.toISOString() };
  const file = recordName({ ...undone, id: crypto.randomUUID() });
  writeNewRecord(path.join(dir, DISCARDED, file), undone);
  return { ...undone, file: path.join(DISCARDED, file) };
}

const RECORD_KEYS = ['url', 'inputs', 'skipped'];

export function checkVisitSteps(steps: unknown): asserts steps is { url: string; inputs?: StepInput[]; skipped?: number }[] {
  if (!Array.isArray(steps) || !steps.length || !steps.every((s) => isPlainObject(s) && isAppPath(s.url))) {
    throw new Error('steps 는 / 로 시작하는 앱 안 주소를 url 에 담은 단계를 하나 이상 차례대로 담은 목록이어야 합니다');
  }
  for (const [i, step] of steps.entries()) {
    const unknown = Object.keys(step).filter((k) => !RECORD_KEYS.includes(k));
    if (unknown.length) throw new Error(`${i + 1} 번째 단계에 모르는 항목이 있습니다: ${unknown.join(', ')}`);
    const problem = typedProblem(step, i);
    if (problem) throw new Error(problem);
  }
}

export function saveVisitRecord(dir: string, steps: unknown, now = new Date(), requests: ForwardedRequest[] = []) {
  checkVisitSteps(steps);
  writableStoriesFolder(dir);
  const folder = path.join(dir, RECORDS);
  if (fs.existsSync(folder) && !isFolder(folder)) throw new Error(`스토리 폴더 안 ${RECORDS} 가 파일이라 기록을 쓸 수 없습니다`);
  const file = path.join(RECORDS, `${now.toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.json`);
  writeNewRecord(path.join(dir, file), {
    steps: steps.map(({ url, inputs, skipped }) => ({ url, ...(inputs?.length && { inputs }), ...(skipped && { skipped }) })),
    ...(requests.length && { requests }),
  });
  return file;
}

export function recordedRequests(config: any): SentRequests[] {
  const { records } = loadVisitRecords(recordSources(config).sources, config.configDir);
  return records.filter((r) => r.requests).map(({ record, requests }) => ({
    title: record,
    file: null,
    line: null,
    project: null,
    requests: requests!.map(({ method, url, body }) => ({ method, url, ...(body !== undefined && { body }) })),
    pageRequests: requests!.flatMap(({ method, url, shown }) => (shown ? [{ method, url, shown }] : [])),
  }));
}

function recordSources(config: any) {
  const folder = path.join(config.storiesDir, RECORDS);
  if (!fs.existsSync(folder)) return { sources: config.visitRecords, notices: [] };
  if (!isFolder(folder)) return { sources: config.visitRecords, notices: [{ file: relative(config.configDir, folder), reason: `${RECORDS} 는 리뷰 페이지에서 남긴 방문 기록을 담는 폴더여야 합니다` }] };
  return { sources: [...config.visitRecords, folder], notices: [] };
}

const sourceKey = (source: Candidate['source']) => JSON.stringify('comment' in source ? { comment: source.comment, ...(source.replaces && { replaces: source.replaces.map((r) => r.screens) }) } : source);

const replacedIn = (holders: { source?: unknown }[]): ReplacedCandidate[] => holders.flatMap(({ source }: any) => (isSource(source) && source.replaces) || []);
function replacedNow(stored: { screens: string[] }[], stories: { source?: unknown }[], current: any[]) {
  const back = new Set(current.filter((d) => d.backToOriginal).map((d) => JSON.stringify(d.screens)));
  return replacedIn([...stored.filter((s) => !back.has(JSON.stringify(s.screens))), ...stories, ...current.filter((d) => !d.backToOriginal)]);
}

function sameSource(a: Candidate['source'], b: Candidate['source']) {
  if ('report' in a && 'report' in b) return a.report === b.report && a.tests.some((title) => b.tests.includes(title));
  return sourceKey(a) === sourceKey(b);
}

const acceptedOrders = (stored: { screens: string[]; source: Candidate['source']; acceptedAs?: string }[], stories: { id: string }[], rules: SkipRule[]) =>
  new Map(stored.flatMap((c) => (stories.some((s) => s.id === c.acceptedAs) ? [[JSON.stringify(shownOrder(c.screens, rulesFor(c.source, rules))), c.acceptedAs!] as const] : [])));

const takenBy = (stories: { source?: Candidate['source'] }[]) => {
  const sources = stories.flatMap((s) => (s.source ? [s.source] : []));
  return (source: Candidate['source']) => sources.some((s) => sameSource(source, s));
};

export function storyCandidates(config: any, map: any, mapFile: string, traced: TracedTest[] = []) {
  const { sources, notices: folderNotices } = recordSources(config);
  const { records, notices: recordNotices } = loadVisitRecords(sources, config.configDir);
  const notices = [...folderNotices, ...recordNotices];
  const { discarded, notices: discardedNotices } = loadDiscarded(config.storiesDir);
  const { found: stored, notices: storedNotices } = loadStored(config.storiesDir);
  const all = [...notices, ...[...discardedNotices, ...storedNotices].map((n) => ({ ...n, file: relative(config.configDir, path.join(config.storiesDir, n.file)) }))];
  const current = discardedNow(discarded);
  const shown = shownDiscarded(current);
  if (linksFromOldDuru(map)) {
    return { list: [], discarded: shown, notices: all, stale: records.length || traced.length || stored.length ? staleMapMessage(mapFile, '후보') : undefined };
  }
  const screenAt = screenFinder(map);
  const rules: SkipRule[] = config.candidateSkipScreens ?? [];
  const found = new Set<string>();
  const cut = new Set<string>();
  const ruledOrCut = (candidate: Candidate) => {
    const after = ruled(candidate, rules);
    if (after !== candidate) cut.add(JSON.stringify(candidate.screens));
    return after;
  };
  const stories = loadStories(config.storiesDir).stories;
  // 고친 후보를 받거나 버린 뒤에도 원래 후보는 목록에 올리지 않는다. 원래대로 되돌린 후보만 예외다.
  const replaced = replacedNow(stored, stories, current);
  const seen = new Set([...stories, ...current, ...replaced].map((s) => JSON.stringify(s.screens)));
  const replacedSource = takenBy(replaced.filter((r) => !('comment' in r.source)));
  const taken = takenBy(stories.filter((s) => s.source && !('tests' in s.source)));
  const firstOfOrder = new Map<string, any>();
  for (const entry of [...stored].sort(byFirstSeen)) {
    const key = JSON.stringify(shownOrder(entry.screens, rulesFor(entry.source, rules)));
    if (!firstOfOrder.has(key)) firstOfOrder.set(key, entry);
  }
  const fromFirstOfOrder = (key: string) => {
    const entry = firstOfOrder.get(key);
    const offSteps = entry && shownOffSteps(entry.screens, entry.offSteps, rulesFor(entry.source, rules));
    return { ...(entry?.file && { file: entry.file }), ...(offSteps && { offSteps }) };
  };
  const accepted = acceptedOrders(stored, stories, rules);
  const list: Candidate[] = [];
  const gone: Record<string, string> = {};
  for (const record of records) {
    const made = candidateOf(record, screenAt);
    for (const screen of made.screens) found.add(screen);
    const candidate = ruledOrCut(made);
    if (!candidate) continue;
    const key = JSON.stringify(candidate.screens);
    if (seen.has(key) || taken(candidate.source) || replacedSource(candidate.source) || accepted.has(key)) {
      gone[candidate.key] ??= candidate.name;
      continue;
    }
    seen.add(key);
    list.push({ ...candidate, ...fromFirstOfOrder(key) });
  }
  // 출처에는 보고 파일을 하나만 적으므로, 같은 화면 순서라도 다른 보고의 시험은 붙이지 않는다.
  const fromTraces = new Map<string, TestsSource>();
  for (const { report, title, screens, inputs, skipped } of traced) {
    for (const screen of screens) found.add(screen);
    const base = { key: screens.join(' > '), name: titleWithoutTags(title), screens, source: { report, tests: [title] }, ...carried({ stepFields: inputFields(inputs), skipped }) } as Candidate;
    const candidate = ruledOrCut(base);
    const shownScreens = candidate?.screens ?? [];
    const key = JSON.stringify(shownScreens);
    if (shownScreens.length > 0 && (seen.has(key) || accepted.has(key))) {
      gone[shownScreens.join(' > ')] ??= titleWithoutTags(title);
      continue;
    }
    const source = fromTraces.get(key);
    if (source) {
      if (source.report === report && !source.tests.includes(title)) source.tests.push(title);
    } else if (candidate && shownScreens.length > 0) {
      fromTraces.set(key, candidate.source as TestsSource);
      list.push({ ...candidate, ...fromFirstOfOrder(key) });
    }
  }
  for (const key of fromTraces.keys()) seen.add(key);
  const byFirstSeenStored = stored.sort(byFirstSeen);
  const storedTests = new Map<string, TestsSource>();
  for (const { name, screens, source, file, offLines, offSteps, ...rest } of byFirstSeenStored) {
    const base = { key: screens.join(' > '), name, screens, source, ...carried(rest) } as Candidate;
    if (!('comment' in source)) for (const screen of screens) found.add(screen);
    const candidate = 'comment' in source ? base : ruledOrCut(base);
    if (!candidate) continue;
    const key = JSON.stringify(candidate.screens);
    const titles = storedTests.get(key);
    if (titles && 'tests' in source && titles.report === source.report && !replacedSource(candidate.source)) {
      titles.tests.push(...source.tests.filter((title: string) => !titles.tests.includes(title)));
      continue;
    }
    if (seen.has(key) || taken(candidate.source) || replacedSource(candidate.source) || accepted.has(key)) {
      gone[candidate.key] ??= name;
      continue;
    }
    seen.add(key);
    if ('tests' in source) storedTests.set(key, source);
    const picks = 'comment' in candidate.source && { lines: agentLines(candidate.source, rest.stepFields, offLines) };
    const shownOff = shownOffSteps(screens, offSteps, rulesFor(source, rules));
    list.push({ ...candidate, ...picks, file, ...(shownOff && { offSteps: shownOff }) });
  }
  const onMap = new Set(map.screens.map((s: any) => s.id));
  const missedRules = [...new Set(rules.map((r) => r.screen))].filter((s) => !onMap.has(s) && !found.has(s));
  const replacers = new Map(stored.filter((s) => 'comment' in s.source && s.source.replaces?.length && !taken(s.source)).map((s) => [JSON.stringify(s.screens), s.source.replaces]));
  const checked = list.map((c): Candidate => {
    const originals = replacers.get(JSON.stringify(c.screens));
    const acceptProblem = stepsLeftProblem(stories, c);
    return { ...c, ...(originals && { originals }), ...(acceptProblem && { acceptProblem }) };
  });
  return { list: checkStories(map, checked), discarded: shown, gone, notices: all, missedRules, cutByRules: cut.size };
}

const AGENT_STEPS = 'screens 는 화면 ID 나 { "screen", "reason", "needs", "linkNeeds", "inputs", "expects" } 객체를 하나 이상 차례대로 담은 목록이어야 합니다';

function agentSteps(screens: unknown) {
  if (!Array.isArray(screens) || !screens.length) throw new Error(AGENT_STEPS);
  return screens.map((step, i) => {
    const where = `screens 의 ${i + 1} 번째 단계`;
    const { reason, ...rest } = isPlainObject(step) ? step : { reason: undefined };
    if (reason !== undefined && !isText(reason)) throw new Error(`${where}의 reason 에 이 화면을 넣은 이유를 적어야 합니다`);
    const problem = stepProblem(isPlainObject(step) ? rest : step, where, i === 0);
    if (problem) throw new Error(problem);
    return { screen: (isPlainObject(step) ? rest.screen : step) as string, fields: filledFields(rest), reason: reason?.trim() as string | undefined };
  });
}

const REPLACES = 'replaces 는 이 후보가 대신하는 원래 후보를 { "screens": 지금 목록에 있는 그 후보의 화면 순서, "dropped": [{ "step", "reason", "judged" }, ...] } 로 하나 이상 담은 목록이어야 합니다';
const DROPPED_KEYS = ['step', 'reason', 'judged'];

type AskedReplace = { screens: string[]; dropped: ReplacedCandidate['dropped'] };

function replacesInput(replaces: unknown): AskedReplace[] {
  if (!Array.isArray(replaces) || !replaces.length) throw new Error(REPLACES);
  const asked = replaces.map((r, i) => {
    if (!isPlainObject(r) || !isScreenList(r.screens) || !Array.isArray(r.dropped) || Object.keys(r).some((k) => k !== 'screens' && k !== 'dropped')) throw new Error(REPLACES);
    const where = `replaces 의 ${i + 1} 번째 원래 후보`;
    const length = r.screens.length;
    const dropped: AskedReplace['dropped'] = r.dropped.map((d: any, j: number) => {
      const at = `${where}의 dropped 의 ${j + 1} 번째`;
      if (!isPlainObject(d) || Object.keys(d).some((k) => !DROPPED_KEYS.includes(k))) throw new Error(`${at}는 { "step", "reason", "judged" } 객체여야 합니다`);
      if (!Number.isInteger(d.step) || d.step < 1 || d.step > length) throw new Error(`${at}의 step 은 원래 순서의 1 번째부터 ${length} 번째까지의 단계 번호여야 합니다`);
      if (!isText(d.reason)) throw new Error(`${at}의 reason 에 이 단계를 뺀 이유를 적어야 합니다`);
      if (d.judged !== undefined && d.judged !== true) throw new Error(`${at}의 judged 는 검토자가 시키지 않았는데 뺀 단계에만 true 로 적습니다`);
      return { step: d.step, reason: d.reason.trim(), ...(d.judged === true && { judged: true as const }) };
    });
    const twice = dropped.find((d, j) => dropped.findIndex((o) => o.step === d.step) !== j);
    if (twice) throw new Error(`${where}의 dropped 에 ${twice.step} 번째 단계가 두 번 있습니다`);
    if (dropped.length === length) throw new Error(`${where}의 단계를 모두 뺄 수는 없습니다`);
    return { screens: r.screens, dropped: dropped.sort((a, b) => a.step - b.step) };
  });
  const twice = asked.find((r, i) => asked.findIndex((o) => isDeepStrictEqual(o.screens, r.screens)) !== i);
  if (twice) throw new Error(`replaces 에 원래 후보 ${orderKey(twice.screens)} 가 두 번 있습니다`);
  return asked;
}

function leftProblem(where: string, left: string[], groups: number[][], kept: string[]) {
  if (left.length === kept.length && isDeepStrictEqual([...left].sort(), [...kept].sort())) {
    return `이유를 적지 않은 단계의 차례가 ${where} 에서 dropped 의 단계를 뺀 순서 ${orderKey(left)} 와 다릅니다. 원래 후보의 단계는 차례를 바꾸지 않습니다`;
  }
  let at = 0;
  const [missing] = left.flatMap((screen, i) => (kept[at] === screen ? (at++, []) : [i]));
  if (at === kept.length && missing !== undefined) {
    return `${where} 의 ${groups[missing][0] + 1} 번째 단계 ${left[missing]} 가 이유 없이 빠졌습니다. 뺀 단계는 dropped 에 step 과 reason 으로 적습니다`;
  }
  return `이유를 적지 않은 단계는 ${where} 에서 dropped 의 단계를 뺀 순서 ${orderKey(left)} 그대로여야 합니다. 에이전트가 넣은 화면에는 reason 에 이유를 적습니다`;
}

const DROPPED_BY_REVIEWER = '검토자 제외';

function replacedCandidates(asked: AskedReplace[], list: Candidate[], kept: string[]) {
  return asked.map((r, i) => {
    const where = `replaces 의 ${i + 1} 번째 원래 후보 ${orderKey(r.screens)}`;
    const candidate = list.find((c) => isDeepStrictEqual(c.screens, r.screens));
    if (!candidate) throw new Error(`${where} 는 지금 후보 목록에 없습니다`);
    const off = candidate.offSteps ?? [];
    const dropped = [...r.dropped.filter((d) => !off.includes(d.step)), ...off.map((step) => ({ step, reason: DROPPED_BY_REVIEWER }))].sort((a, b) => a.step - b.step);
    if (dropped.length === r.screens.length) throw new Error(`${where}의 단계를 모두 뺄 수는 없습니다. ${off.join(', ')} 번째 단계는 검토자가 ✕ 로 뺐습니다`);
    const groups = stepsLeft(r.screens, dropped.map((d) => d.step));
    const left = groups.map((g) => r.screens[g[0]]);
    if (!isDeepStrictEqual(left, kept)) throw new Error(leftProblem(where, left, groups, kept) + (off.length ? `. ${off.join(', ')} 번째 단계는 검토자가 ✕ 로 뺐으므로 빠진 것으로 봅니다` : ''));
    return { ...r, dropped, candidate, groups, picked: pickedLines(candidate) };
  });
}

type Originals = ReturnType<typeof replacedCandidates>;

function fieldsFromOriginals(originals: Originals, keptAt: (number | undefined)[], i: number): StepFields {
  const k = keptAt[i];
  if (k === undefined) return {};
  const linked = (groups: number[][]) => k > 0 && keptAt[i - 1] === k - 1 && groups[k - 1].at(-1)! + 1 === groups[k][0];
  return joinedFields(originals.flatMap(({ picked, groups }) => groups[k].map((j, at) => {
    const { linkNeeds, ...rest } = picked.stepFields?.[j] ?? {};
    return at === 0 && linked(groups) && linkNeeds ? { ...rest, linkNeeds } : rest;
  })));
}

function agentLinesFromOriginals(originals: Originals, k: number | undefined, from: StepFields): StepFields {
  if (k === undefined) return {};
  const { linkNeeds, ...lines } = joinedFields(originals.flatMap(({ picked, groups }) => ('comment' in picked.source ? picked.source.written : [])
    .filter(({ step }) => groups[k].includes(step - 1))
    .map(({ step: _, ...fields }) => fields)));
  return linkNeeds && from.linkNeeds ? { ...lines, linkNeeds } : lines;
}

function inputClash(originals: Originals, k: number | undefined, typed: StepFields) {
  if (k === undefined) return null;
  const inputs = originals.map(({ picked, groups }) => joinedFields(groups[k].map((j) => picked.stepFields?.[j] ?? {})).inputs ?? []);
  return inputs.flat().find((input) => !typed.inputs?.some((t) => sameBox(t, input))
    && inputs.flat().some((other) => sameBox(other, input) && !isDeepStrictEqual(other.value, input.value))) ?? null;
}

const ownLines = (fields: StepFields, from: StepFields) => Object.fromEntries(Object.entries(fields)
  .map(([key, lines]) => [key, (lines as unknown[]).filter((line) => !((from[key as LineField] ?? []) as unknown[]).some((o) => isDeepStrictEqual(o, line)))] as const)
  .filter(([, lines]) => lines.length));

function orderChecks(order: ReturnType<typeof targetsOf>[number], steps: ReturnType<typeof agentSteps>, kept: number[]) {
  if (!isDeepStrictEqual(kept.map((i) => steps[i].screen), order.screens)) {
    throw new Error(`이유를 적지 않은 단계는 코멘트가 고른 화면 순서 ${orderKey(order.screens!)} 그대로여야 합니다. 에이전트가 넣은 화면에는 reason 에 이유를 적습니다`);
  }
  const { gaps } = order;
  const outside = gaps ? steps.findIndex((s, i) => s.reason !== undefined && !gaps.some(([a]) => a === kept.filter((k) => k < i).length)) : -1;
  if (outside >= 0) throw new Error(`screens 의 ${outside + 1} 번째 단계는 코멘트가 고른 사이(${gaps!.map(([a, b]) => `${a}-${b}`).join(', ')}) 밖에 넣은 화면입니다`);
  const typed = new Map((order.steps ?? []).map(({ step, ...fields }): [number, Record<string, unknown>] => [kept[step - 1], fields]));
  for (const [i, fields] of typed) {
    const changed = Object.keys(fields).find((key) => !isDeepStrictEqual((steps[i].fields as Record<string, unknown>)[key], fields[key]));
    if (changed) throw new Error(`screens 의 ${i + 1} 번째 단계 ${steps[i].screen} 의 ${changed} 는 검토자가 적은 줄이라 바꿀 수 없습니다`);
  }
  return typed;
}

export function addCommentCandidate(config: any, map: any, mapFile: string, traced: TracedTest[], input: Record<string, unknown>, now = new Date()) {
  const { comment, name, screens, replaces } = input;
  const others = Object.keys(input).filter((k) => !['comment', 'name', 'screens', 'replaces'].includes(k));
  if (others.length) throw new Error(`모르는 항목이 있습니다: ${others.join(', ')}`);
  const asked = loadMarks(config.marksDir).find((m) => m.id === comment && recordKind(m) === 'comment');
  if (!asked) throw new Error(`코멘트 ${comment} 가 없습니다`);
  const targets = targetsOf(asked);
  const order = targets.find((t) => t.screens !== undefined);
  if (!order && targets.some((t) => t.candidate === undefined)) throw new Error(`코멘트 ${comment} 는 화면 순서나 후보에 단 코멘트도, 대상 없는 코멘트도 아닙니다`);
  if (order && replaces !== undefined) throw new Error(`코멘트 ${comment} 는 화면 순서에 단 코멘트라 replaces 를 적지 않습니다`);
  if (!order && replaces === undefined) throw new Error(`코멘트 ${comment} 는 ${targets.length ? '후보에 단' : '대상 없는'} 코멘트라 replaces 에 이 후보가 대신하는 원래 후보를 적어야 합니다`);
  if (!isText(name)) throw new Error('name 에 후보 이름을 적어야 합니다');
  const steps = agentSteps(screens);
  const askedReplace = order ? null : replacesInput(replaces);
  if (linksFromOldDuru(map)) throw new Error(staleMapMessage(mapFile, '후보'));
  const onMap = new Set(map.screens.map((s: any) => s.id));
  const off = steps.findIndex((s) => !onMap.has(s.screen));
  if (off >= 0) throw new Error(`screens 의 ${off + 1} 번째 단계의 ${steps[off].screen} 는 맵에 없는 화면입니다`);
  const repeated = steps.findIndex((s, i) => i > 0 && s.screen === steps[i - 1].screen);
  if (repeated > 0) throw new Error(`screens 의 ${repeated} 번째와 ${repeated + 1} 번째가 같은 화면입니다`);
  const kept = steps.flatMap((s, i) => (s.reason === undefined ? [i] : []));
  const typed = order ? orderChecks(order, steps, kept) : new Map<number, Record<string, unknown>>();
  const ids = steps.map((s) => s.screen);
  const key = JSON.stringify(ids);
  const { stories } = loadStories(config.storiesDir);
  const story = stories.find((s) => JSON.stringify(s.screens) === key);
  if (story) throw new Error(`이미 스토리 ${story.id} 의 화면 순서입니다`);
  const answered = order && stories.find((s) => s.source && 'comment' in s.source && s.source.comment === asked.id);
  if (answered) throw new Error(`코멘트 ${comment} 의 부탁은 이미 스토리 ${answered.id} 로 받았습니다`);
  const acceptedAs = acceptedOrders(loadStored(config.storiesDir).found, stories, config.candidateSkipScreens ?? []).get(key);
  if (acceptedAs) throw new Error(`이미 스토리 ${acceptedAs} 로 받은 화면 순서입니다. 검토자가 받기를 되돌린 뒤에 올릴 수 있습니다`);
  const listed = storyCandidates(config, map, mapFile, traced);
  const originals = askedReplace && replacedCandidates(askedReplace, listed.list, kept.map((i) => steps[i].screen));
  if (listed.discarded.some((d) => JSON.stringify(d.screens) === key)) throw new Error('이 화면 순서는 버린 후보에 있습니다. 검토자가 「되돌리기」를 누른 뒤에 올릴 수 있습니다');
  const same = listed.list.find((c) => JSON.stringify(c.screens) === key);
  if (same) throw new Error(`이미 후보 「${same.name}」의 화면 순서입니다`);
  const replaced = replacedNow(loadStored(config.storiesDir).found, stories, discardedNow(loadDiscarded(config.storiesDir).discarded));
  if (replaced.some((r) => JSON.stringify(r.screens) === key)) throw new Error('이 화면 순서는 다른 후보가 이미 대신한 원래 후보의 순서입니다');

  const added = steps.flatMap((s, i) => (s.reason === undefined ? [] : [{ step: i + 1, reason: s.reason }]));
  const keptAt = steps.map((_, i) => (kept.includes(i) ? kept.indexOf(i) : undefined));
  const lines = steps.map(({ fields }, i) => {
    if (!originals) return { fields, own: Object.fromEntries(Object.entries(fields).filter(([k]) => !typed.get(i)?.[k])) };
    const clash = inputClash(originals, keptAt[i], fields);
    if (clash) throw new Error(`screens 의 ${i + 1} 번째 단계 ${ids[i]} 의 입력칸 ${JSON.stringify(clash.box)} 에 원래 후보들의 값이 서로 다릅니다. 이 단계의 inputs 에 남길 값을 적습니다`);
    const from = fieldsFromOriginals(originals, keptAt, i);
    return { fields: joinedFields([from, fields]), own: joinedFields([agentLinesFromOriginals(originals, keptAt[i], from), ownLines(fields, from)]) };
  });
  const written = lines.flatMap(({ own }, i) => (Object.keys(own).length ? [{ step: i + 1, ...own }] : []));
  const source: CommentSource = {
    comment: asked.id,
    added,
    written,
    ...(originals && { replaces: originals.map(({ screens, dropped, candidate }) => ({ screens, dropped, source: candidate.source as StorySource })) }),
  };
  writableStoriesFolder(config.storiesDir);
  const folder = path.join(config.storiesDir, CANDIDATES);
  if (fs.existsSync(folder) && !isFolder(folder)) throw new Error(`스토리 폴더 안 ${CANDIDATES} 가 파일이라 후보를 쓸 수 없습니다`);
  const date = now.toISOString();
  const file = path.join(folder, `${date.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.json`);
  const stepFields = lines.some((l) => Object.keys(l.fields).length) ? lines.map((l) => l.fields) : undefined;
  const skipped = originals?.reduce((sum, { candidate }) => sum + (candidate.skipped ?? 0), 0);
  writeNewRecord(file, { name: name.trim(), screens: ids, source, date, ...carried({ stepFields, skipped }) });
  return { file: relative(config.configDir, file), key: ids.join(' > '), links: checkStories(map, [{ screens: ids }])[0].links };
}
