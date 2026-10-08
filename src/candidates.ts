import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathOf, screenFinder } from './address-match.ts';
import { compare, isPlainObject } from './config.mjs';
import { jsonFiles } from './json-files.ts';
import { recordName, writeNewRecord } from './marks.ts';
import { addStory, DISCARDED, isDate, isScreenList, isText, loadStories, writableStoriesFolder } from './stories.ts';
import { checkStories, linksWithoutConditions, staleMapMessage } from './story-paths.ts';

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

function readRecord(file: string) {
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

export interface Candidate {
  name: string;
  screens: string[];
  source: { record: string; steps: number[] };
  stepRanges: [number, number][];
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
    const { addresses, stepCount, reason } = readRecord(file) as Pick<VisitRecord, 'addresses' | 'stepCount'> & { reason?: string };
    const record = relative(configDir, file);
    if (reason) notices.push({ file: record, reason });
    else records.push({ record, name: path.basename(file, '.json'), addresses, stepCount });
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
  return { name, screens, source: { record, steps: [1, stepCount] }, stepRanges };
}

function discardedProblemOf(d: any) {
  if (!isPlainObject(d)) return '버린 후보는 JSON 객체여야 합니다';
  if (!isScreenList(d.screens)) return 'screens 는 화면을 하나 이상 차례대로 담은 목록이어야 합니다';
  if (!isText(d.reason)) return 'reason 에 버린 까닭을 적어야 합니다';
  if (!isText(d.author)) return 'author 에 작성자를 적어야 합니다';
  if (!isDate(d.date)) return 'date 는 2026-10-02 같은 날짜여야 합니다';
  return null;
}

const SAY = {
  folder: (message: string) => `버린 후보 폴더를 읽지 못했습니다: ${message}`,
  missing: () => '링크가 가리키는 파일이 없습니다',
  link: (message: string) => `링크를 따라가지 못했습니다: ${message}`,
};

export function loadDiscarded(dir: string) {
  const folder = path.join(dir, DISCARDED);
  if (!fs.existsSync(folder)) return { discarded: [], notices: [] };
  if (!fs.statSync(folder).isDirectory()) return { discarded: [], notices: [{ file: DISCARDED, reason: `${DISCARDED} 는 버린 후보를 담는 폴더여야 합니다` }] };
  const discarded: any[] = [];
  const notices: { file: string; reason: string }[] = [];
  for (const found of jsonFiles(folder, SAY)) {
    const file = path.join(DISCARDED, found.file);
    if (found.reason) {
      notices.push({ file: found.file === folder ? DISCARDED : file, reason: found.reason });
      continue;
    }
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err: any) {
      notices.push({ file, reason: `JSON 으로 읽지 못했습니다: ${err.message}` });
      continue;
    }
    const problem = discardedProblemOf(d);
    if (problem) notices.push({ file, reason: problem });
    else discarded.push({ ...d, file });
  }
  return { discarded, notices };
}

export const acceptCandidate = (dir: string, candidate: Candidate, { id, name, author }: { id: string; name: string; author: string }, now = new Date()) =>
  addStory(dir, { id, name, screens: candidate.screens, author, source: candidate.source }, now);

export function discardCandidate(dir: string, candidate: Candidate, { reason, author }: { reason: string; author: string }, now = new Date()) {
  if (!isText(reason)) throw new Error('버리는 까닭이 필요합니다');
  if (!isText(author)) throw new Error('작성자가 필요합니다');
  writableStoriesFolder(dir);
  const folder = path.join(dir, DISCARDED);
  if (fs.existsSync(folder) && !fs.statSync(folder).isDirectory()) throw new Error(`스토리 폴더 안 ${DISCARDED} 가 파일이라 버린 후보를 쓸 수 없습니다`);
  const discarded = { name: candidate.name, screens: candidate.screens, reason: reason.trim(), author: author.trim(), date: now.toISOString(), source: candidate.source };
  const file = recordName({ ...discarded, id: crypto.randomUUID() });
  writeNewRecord(path.join(folder, file), discarded);
  return { ...discarded, file: path.join(DISCARDED, file) };
}

export function storyCandidates(config: any, map: any, mapFile: string) {
  const { records, notices } = loadVisitRecords(config.visitRecords, config.configDir);
  const { discarded, notices: discardedNotices } = loadDiscarded(config.storiesDir);
  const all = [...notices, ...discardedNotices.map((n) => ({ ...n, file: relative(config.configDir, path.join(config.storiesDir, n.file)) }))];
  if (linksWithoutConditions(map)) {
    return { list: [], notices: all, ...(records.length && { stale: staleMapMessage(mapFile, '후보') }) };
  }
  const screenAt = screenFinder(map);
  const seen = new Set([...loadStories(config.storiesDir).stories, ...discarded].map((s) => JSON.stringify(s.screens)));
  const list: Candidate[] = [];
  for (const record of records) {
    const candidate = candidateOf(record, screenAt);
    const key = JSON.stringify(candidate.screens);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(candidate);
  }
  return { list: checkStories(map, list), notices: all };
}
