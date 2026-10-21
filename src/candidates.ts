import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathOf, screenFinder } from './address-match.ts';
import { compare, isPlainObject } from './config.ts';
import { jsonFiles } from './json-files.ts';
import { loadMarks, orderKey, recordKind, recordName, targetsOf, writeNewRecord } from './marks.ts';
import { addStory, CANDIDATES, DISCARDED, inputsProblem, RECORDS, isDate, isScreenList, isSource, isText, loadStories, SOURCE_SHAPES, STEP_FIELDS, stepProblem, writableStoriesFolder } from './stories.ts';
import type { CommentSource, StepFields, StepInput } from './stories.ts';
import { checkStories, linksWithoutConditions, staleMapMessage } from './story-paths.ts';
import { withoutTags } from './verdict.ts';

const relative = (configDir: string, file: string) => path.relative(configDir, file).split(path.sep).join('/');
const shownTitle = (title: string) => title.split(' › ').map(withoutTags).filter(Boolean).join(' › ') || title;

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

function readRecord(file: string): { reason: string } | Pick<VisitRecord, 'addresses' | 'stepCount'> {
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
  return { addresses, stepCount: steps.length };
}

interface VisitRecord {
  record: string;
  name: string;
  addresses: { address: string; step: number; inputs?: StepInput[]; skipped?: number }[];
  stepCount: number;
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
  file?: string;
  lines?: AgentLine[];
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

const sameBox = (a: StepInput, b: StepInput) => JSON.stringify(a.box) === JSON.stringify(b.box);

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

// 쓴 파일은 고치지도 지우지도 않는다.
export function storeCandidates(dir: string, list: Candidate[], now = new Date()) {
  const folder = path.join(dir, CANDIDATES);
  if (fs.existsSync(dir) && !isFolder(dir)) return { written: 0 };
  if (fs.existsSync(folder) && !isFolder(folder)) return { written: 0 };
  const stored = new Set(loadStored(dir).found.map((c) => JSON.stringify(c.screens)));
  const date = now.toISOString();
  let written = 0;
  for (const { name, screens, source, ...rest } of list) {
    const key = JSON.stringify(screens);
    if (stored.has(key)) continue;
    stored.add(key);
    try {
      writeNewRecord(path.join(folder, `${date.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.json`), { name, screens, source, date, ...carried(rest) });
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

export function acceptCandidate(dir: string, candidate: Candidate, { id, name, author }: { id: unknown; name: unknown; author: unknown }, now = new Date()) {
  const { source, stepFields } = pickedLines(candidate);
  return addStory(dir, { id, name, screens: withFields({ screens: candidate.screens, stepFields }), author, source }, now);
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

export function unacceptStory(dir: string, id: unknown) {
  if (!isFolder(dir)) throw new Error(`스토리 폴더 ${dir} 가 폴더가 아니라 스토리 파일을 지울 수 없습니다`);
  const story = loadStories(dir).stories.find((s) => s.id === id);
  if (!story) throw new Error(`스토리 ${id} 를 찾지 못했습니다`);
  if (!story.source) throw new Error(`스토리 ${id} 는 후보에서 받은 스토리가 아닙니다`);
  const stepFields = story.stepFields && ('comment' in story.source ? story.stepFields : inputFields(story.stepFields.map((f) => f.inputs ?? [])));
  const kept = storeCandidates(dir, [{ key: story.screens.join(' > '), name: story.id, screens: story.screens, source: story.source, ...carried({ stepFields }) }]);
  if (kept.reason) throw new Error(kept.reason);
  fs.rmSync(path.join(dir, story.file));
  return { id: story.id, screens: story.screens, file: story.file };
}

export function discardCandidate(dir: string, candidate: Candidate, { reason, author }: { reason: unknown; author: unknown }, now = new Date()) {
  if (!isText(reason)) throw new Error('버리는 이유가 필요합니다');
  if (!isText(author)) throw new Error('작성자가 필요합니다');
  writableStoriesFolder(dir);
  const folder = path.join(dir, DISCARDED);
  if (fs.existsSync(folder) && !fs.statSync(folder).isDirectory()) throw new Error(`스토리 폴더 안 ${DISCARDED} 가 파일이라 버린 후보를 쓸 수 없습니다`);
  const discarded = { name: candidate.name, screens: candidate.screens, reason: reason.trim(), author: author.trim(), date: now.toISOString(), source: candidate.source, ...carried(candidate) };
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
    const kept = storeCandidates(dir, [{ key: discarded.screens.join(' > '), name: discarded.name, screens: discarded.screens, source: discarded.source, ...carried(discarded) }]);
    if (kept.reason) throw new Error(kept.reason);
  }
  const undone = { screens: discarded.screens, kind: 'undo', author: author.trim(), date: now.toISOString() };
  const file = recordName({ ...undone, id: crypto.randomUUID() });
  writeNewRecord(path.join(dir, DISCARDED, file), undone);
  return { ...undone, file: path.join(DISCARDED, file) };
}

const RECORD_KEYS = ['url', 'inputs', 'skipped'];
const isAddress = (url: unknown) => typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');

// 쓴 파일은 고치지도 지우지도 않는다.
export function saveVisitRecord(dir: string, steps: unknown, now = new Date()) {
  if (!Array.isArray(steps) || !steps.length || !steps.every((s) => isPlainObject(s) && isAddress(s.url))) {
    throw new Error('steps 는 / 로 시작하는 앱 안 주소를 url 에 담은 단계를 하나 이상 차례대로 담은 목록이어야 합니다');
  }
  for (const [i, step] of steps.entries()) {
    const unknown = Object.keys(step).filter((k) => !RECORD_KEYS.includes(k));
    if (unknown.length) throw new Error(`${i + 1} 번째 단계에 모르는 항목이 있습니다: ${unknown.join(', ')}`);
    const problem = typedProblem(step, i);
    if (problem) throw new Error(problem);
  }
  writableStoriesFolder(dir);
  const folder = path.join(dir, RECORDS);
  if (fs.existsSync(folder) && !isFolder(folder)) throw new Error(`스토리 폴더 안 ${RECORDS} 가 파일이라 기록을 쓸 수 없습니다`);
  const file = path.join(RECORDS, `${now.toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.json`);
  writeNewRecord(path.join(dir, file), { steps: steps.map(({ url, inputs, skipped }) => ({ url, ...(inputs?.length && { inputs }), ...(skipped && { skipped }) })) });
  return file;
}

function recordSources(config: any) {
  const folder = path.join(config.storiesDir, RECORDS);
  if (!fs.existsSync(folder)) return { sources: config.visitRecords, notices: [] };
  if (!isFolder(folder)) return { sources: config.visitRecords, notices: [{ file: relative(config.configDir, folder), reason: `${RECORDS} 는 리뷰 페이지에서 남긴 방문 기록을 담는 폴더여야 합니다` }] };
  return { sources: [...config.visitRecords, folder], notices: [] };
}

// 순서를 고치면 코멘트 출처의 단계 번호가 바뀌므로, 코멘트 출처는 코멘트로만 맞춘다.
const sourceKey = (source: Candidate['source']) => JSON.stringify('comment' in source ? { comment: source.comment } : source);

export function storyCandidates(config: any, map: any, mapFile: string, traced: TracedTest[] = []) {
  const { sources, notices: folderNotices } = recordSources(config);
  const { records, notices: recordNotices } = loadVisitRecords(sources, config.configDir);
  const notices = [...folderNotices, ...recordNotices];
  const { discarded, notices: discardedNotices } = loadDiscarded(config.storiesDir);
  const { found: stored, notices: storedNotices } = loadStored(config.storiesDir);
  const all = [...notices, ...[...discardedNotices, ...storedNotices].map((n) => ({ ...n, file: relative(config.configDir, path.join(config.storiesDir, n.file)) }))];
  const current = discardedNow(discarded);
  const shown = shownDiscarded(current);
  if (linksWithoutConditions(map)) {
    return { list: [], discarded: shown, notices: all, stale: records.length || traced.length || stored.length ? staleMapMessage(mapFile, '후보') : undefined };
  }
  const screenAt = screenFinder(map);
  const stories = loadStories(config.storiesDir).stories;
  const seen = new Set([...stories, ...current].map((s) => JSON.stringify(s.screens)));
  // 받은 뒤 화면 순서를 고친 스토리도 그 출처의 후보를 다시 올리지 않는다.
  const taken = new Set(stories.flatMap((s) => (s.source ? [sourceKey(s.source)] : [])));
  const list: Candidate[] = [];
  const gone: Record<string, string> = {};
  for (const record of records) {
    const candidate = candidateOf(record, screenAt);
    const key = JSON.stringify(candidate.screens);
    if (seen.has(key) || taken.has(sourceKey(candidate.source))) {
      gone[candidate.key] ??= candidate.name;
      continue;
    }
    seen.add(key);
    list.push(candidate);
  }
  // 출처에는 보고 파일을 하나만 적으므로, 같은 화면 순서라도 다른 보고의 시험은 붙이지 않는다.
  const fromTraces = new Map<string, TestsSource>();
  for (const { report, title, screens, inputs, skipped } of traced) {
    const key = JSON.stringify(screens);
    const source = fromTraces.get(key);
    if (source) {
      if (source.report === report && !source.tests.includes(title)) source.tests.push(title);
    } else if (screens.length > 1 && seen.has(key)) {
      gone[screens.join(' > ')] ??= shownTitle(title);
    } else if (screens.length > 1) {
      const candidate = { key: screens.join(' > '), name: shownTitle(title), screens, source: { report, tests: [title] }, ...carried({ stepFields: inputFields(inputs), skipped }) };
      fromTraces.set(key, candidate.source);
      list.push(candidate);
    }
  }
  for (const key of fromTraces.keys()) seen.add(key);
  const byFirstSeen = stored.sort((a, b) => compare(a.date, b.date) || compare(a.screens.join(' > '), b.screens.join(' > ')));
  for (const { name, screens, source, file, offLines, ...rest } of byFirstSeen) {
    const key = JSON.stringify(screens);
    if (seen.has(key) || taken.has(sourceKey(source))) {
      gone[screens.join(' > ')] ??= name;
      continue;
    }
    seen.add(key);
    const picks = 'comment' in source && { file, lines: agentLines(source, rest.stepFields, offLines) };
    list.push({ key: screens.join(' > '), name, screens, source, ...carried(rest), ...picks });
  }
  return { list: checkStories(map, list), discarded: shown, gone, notices: all };
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

export function addCommentCandidate(config: any, map: any, mapFile: string, traced: TracedTest[], input: Record<string, unknown>, now = new Date()) {
  const { comment, name, screens } = input;
  const others = Object.keys(input).filter((k) => !['comment', 'name', 'screens'].includes(k));
  if (others.length) throw new Error(`모르는 항목이 있습니다: ${others.join(', ')}`);
  const asked = loadMarks(config.marksDir).find((m) => m.id === comment && recordKind(m) === 'comment');
  if (!asked) throw new Error(`코멘트 ${comment} 가 없습니다`);
  const order = targetsOf(asked).find((t) => t.screens !== undefined);
  if (!order) throw new Error(`코멘트 ${comment} 는 화면 순서에 단 코멘트가 아닙니다`);
  if (!isText(name)) throw new Error('name 에 후보 이름을 적어야 합니다');
  const steps = agentSteps(screens);
  if (linksWithoutConditions(map)) throw new Error(staleMapMessage(mapFile, '후보'));
  const onMap = new Set(map.screens.map((s: any) => s.id));
  const off = steps.findIndex((s) => !onMap.has(s.screen));
  if (off >= 0) throw new Error(`screens 의 ${off + 1} 번째 단계의 ${steps[off].screen} 는 맵에 없는 화면입니다`);
  const repeated = steps.findIndex((s, i) => i > 0 && s.screen === steps[i - 1].screen);
  if (repeated > 0) throw new Error(`screens 의 ${repeated} 번째와 ${repeated + 1} 번째가 같은 화면입니다`);
  const kept = steps.flatMap((s, i) => (s.reason === undefined ? [i] : []));
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
  const ids = steps.map((s) => s.screen);
  const key = JSON.stringify(ids);
  const { stories } = loadStories(config.storiesDir);
  const story = stories.find((s) => JSON.stringify(s.screens) === key);
  if (story) throw new Error(`이미 스토리 ${story.id} 의 화면 순서입니다`);
  const answered = stories.find((s) => s.source && 'comment' in s.source && s.source.comment === asked.id);
  if (answered) throw new Error(`코멘트 ${comment} 의 부탁은 이미 스토리 ${answered.id} 로 받았습니다`);
  const listed = storyCandidates(config, map, mapFile, traced);
  if (listed.discarded.some((d) => JSON.stringify(d.screens) === key)) throw new Error('이 화면 순서는 버린 후보에 있습니다. 검토자가 「되돌리기」를 누른 뒤에 올릴 수 있습니다');
  const same = listed.list.find((c) => JSON.stringify(c.screens) === key);
  if (same) throw new Error(`이미 후보 「${same.name}」의 화면 순서입니다`);

  const added = steps.flatMap((s, i) => (s.reason === undefined ? [] : [{ step: i + 1, reason: s.reason }]));
  const written = steps.flatMap(({ fields }, i) => {
    const own = Object.fromEntries(Object.entries(fields).filter(([k]) => !typed.get(i)?.[k]));
    return Object.keys(own).length ? [{ step: i + 1, ...own }] : [];
  });
  writableStoriesFolder(config.storiesDir);
  const folder = path.join(config.storiesDir, CANDIDATES);
  if (fs.existsSync(folder) && !isFolder(folder)) throw new Error(`스토리 폴더 안 ${CANDIDATES} 가 파일이라 후보를 쓸 수 없습니다`);
  const date = now.toISOString();
  const file = path.join(folder, `${date.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.json`);
  const stepFields = steps.some((s) => Object.keys(s.fields).length) ? steps.map((s) => s.fields) : undefined;
  writeNewRecord(file, { name: name.trim(), screens: ids, source: { comment: asked.id, added, written }, date, ...(stepFields && { stepFields }) });
  return { file: relative(config.configDir, file), key: ids.join(' > '), links: checkStories(map, [{ screens: ids }])[0].links };
}
