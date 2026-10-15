import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathOf, screenFinder } from './address-match.ts';
import { compare, isPlainObject } from './config.ts';
import { jsonFiles } from './json-files.ts';
import { recordName, writeNewRecord } from './marks.ts';
import { addStory, CANDIDATES, DISCARDED, isDate, isScreenList, isSource, isText, loadStories, writableStoriesFolder } from './stories.ts';
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
    addresses.push({ address, step: i + 1 });
  }
  if (!addresses.length) return { reason: 'url 이 있는 단계가 없습니다' };
  return { addresses, stepCount: steps.length };
}

interface VisitRecord {
  record: string;
  name: string;
  addresses: { address: string; step: number }[];
  stepCount: number;
}

export interface TracedTest {
  report: string;
  title: string;
  screens: string[];
}

interface TestsSource {
  report: string;
  tests: string[];
}

export interface Candidate {
  key: string;
  name: string;
  screens: string[];
  source: { record: string; steps: number[] } | TestsSource;
  stepRanges?: [number, number][];
}

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

function candidateOf({ record, name, addresses, stepCount }: VisitRecord, screenAt: (url: string) => string | null): Candidate {
  const screens: string[] = [];
  const stepRanges: [number, number][] = [];
  for (const { address, step } of addresses) {
    const screen = screenAt(address) ?? address;
    if (screen === screens.at(-1)) stepRanges.at(-1)![1] = step;
    else {
      screens.push(screen);
      stepRanges.push([step, step]);
    }
  }
  return { key: screens.join(' > '), name, screens, source: { record, steps: [1, stepCount] }, stepRanges };
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

function storedProblemOf(c: any) {
  if (!isPlainObject(c)) return '스토리 후보는 JSON 객체여야 합니다';
  if (!isText(c.name)) return 'name 에 후보 이름을 적어야 합니다';
  if (!isScreenList(c.screens)) return 'screens 는 화면을 하나 이상 차례대로 담은 목록이어야 합니다';
  if (!isSource(c.source)) return 'source 는 { "record": 기록 파일, "steps": [첫 단계, 끝 단계] } 나 { "report": 보고 파일, "tests": [시험 제목, ...] } 여야 합니다';
  if (!isDate(c.date)) return 'date 는 2026-10-02 같은 날짜여야 합니다';
  return null;
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
  for (const { name, screens, source } of list) {
    const key = JSON.stringify(screens);
    if (stored.has(key)) continue;
    stored.add(key);
    try {
      writeNewRecord(path.join(folder, `${date.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.json`), { name, screens, source, date });
    } catch (err: any) {
      return { written, reason: `후보 파일을 쓰지 못했습니다: ${err.message}` };
    }
    written++;
  }
  return { written };
}

export const candidatePlace = ({ name, source, screens, stepRanges }: Candidate) => ({ name, source, screens, ...(stepRanges && { stepRanges }) });

export const acceptCandidate = (dir: string, candidate: Candidate, { id, name, author }: { id: unknown; name: unknown; author: unknown }, now = new Date()) =>
  addStory(dir, { id, name, screens: candidate.screens, author, source: candidate.source }, now);

export function unacceptStory(dir: string, id: unknown) {
  if (!isFolder(dir)) throw new Error(`스토리 폴더 ${dir} 가 폴더가 아니라 스토리 파일을 지울 수 없습니다`);
  const story = loadStories(dir).stories.find((s) => s.id === id);
  if (!story) throw new Error(`스토리 ${id} 를 찾지 못했습니다`);
  if (!story.source) throw new Error(`스토리 ${id} 는 후보에서 받은 스토리가 아닙니다`);
  const kept = storeCandidates(dir, [{ key: story.screens.join(' > '), name: story.id, screens: story.screens, source: story.source }]);
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
  const discarded = { name: candidate.name, screens: candidate.screens, reason: reason.trim(), author: author.trim(), date: now.toISOString(), source: candidate.source };
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
    const kept = storeCandidates(dir, [{ key: discarded.screens.join(' > '), name: discarded.name, screens: discarded.screens, source: discarded.source }]);
    if (kept.reason) throw new Error(kept.reason);
  }
  const undone = { screens: discarded.screens, kind: 'undo', author: author.trim(), date: now.toISOString() };
  const file = recordName({ ...undone, id: crypto.randomUUID() });
  writeNewRecord(path.join(dir, DISCARDED, file), undone);
  return { ...undone, file: path.join(DISCARDED, file) };
}

export function storyCandidates(config: any, map: any, mapFile: string, traced: TracedTest[] = []) {
  const { records, notices } = loadVisitRecords(config.visitRecords, config.configDir);
  const { discarded, notices: discardedNotices } = loadDiscarded(config.storiesDir);
  const { found: stored, notices: storedNotices } = loadStored(config.storiesDir);
  const all = [...notices, ...[...discardedNotices, ...storedNotices].map((n) => ({ ...n, file: relative(config.configDir, path.join(config.storiesDir, n.file)) }))];
  const current = discardedNow(discarded);
  const shown = shownDiscarded(current);
  if (linksWithoutConditions(map)) {
    return { list: [], discarded: shown, notices: all, ...((records.length || traced.length || stored.length) && { stale: staleMapMessage(mapFile, '후보') }) };
  }
  const screenAt = screenFinder(map);
  const seen = new Set([...loadStories(config.storiesDir).stories, ...current].map((s) => JSON.stringify(s.screens)));
  const list: Candidate[] = [];
  const gone: Record<string, string> = {};
  for (const record of records) {
    const candidate = candidateOf(record, screenAt);
    const key = JSON.stringify(candidate.screens);
    if (seen.has(key)) {
      gone[candidate.key] ??= candidate.name;
      continue;
    }
    seen.add(key);
    list.push(candidate);
  }
  // 출처에는 보고 파일을 하나만 적으므로, 같은 화면 순서라도 다른 보고의 시험은 붙이지 않는다.
  const fromTraces = new Map<string, TestsSource>();
  for (const { report, title, screens } of traced) {
    const key = JSON.stringify(screens);
    const source = fromTraces.get(key);
    if (source) {
      if (source.report === report && !source.tests.includes(title)) source.tests.push(title);
    } else if (screens.length > 1 && seen.has(key)) {
      gone[screens.join(' > ')] ??= shownTitle(title);
    } else if (screens.length > 1) {
      const candidate = { key: screens.join(' > '), name: shownTitle(title), screens, source: { report, tests: [title] } };
      fromTraces.set(key, candidate.source);
      list.push(candidate);
    }
  }
  for (const key of fromTraces.keys()) seen.add(key);
  const byFirstSeen = stored.sort((a, b) => compare(a.date, b.date) || compare(a.screens.join(' > '), b.screens.join(' > ')));
  for (const { name, screens, source } of byFirstSeen) {
    const key = JSON.stringify(screens);
    if (seen.has(key)) {
      gone[screens.join(' > ')] ??= name;
      continue;
    }
    seen.add(key);
    list.push({ key: screens.join(' > '), name, screens, source });
  }
  return { list: checkStories(map, list), discarded: shown, gone, notices: all };
}
