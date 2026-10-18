import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compare, isPlainObject } from './config.ts';
import { jsonFiles } from './json-files.ts';

interface RawSource {
  record?: unknown;
  steps?: unknown;
  report?: unknown;
  tests?: unknown;
}

interface RawStory {
  name?: unknown;
  needs?: unknown;
  screens?: unknown;
  expects?: unknown;
  memo?: unknown;
  author?: unknown;
  date?: unknown;
  source?: RawSource;
}

export interface InputBox {
  placeholder?: string;
  label?: string;
  testId?: string;
  nth?: number;
}

export interface StepInput {
  box: InputBox;
  value: string;
}

export type Need = string | { use: string };

export interface StepFields {
  needs?: Need[];
  linkNeeds?: Need[];
  inputs?: StepInput[];
  expects?: string[];
}

export interface Story {
  id: string;
  name: string;
  needs?: Need[];
  screens: string[];
  stepFields?: StepFields[];
  expects?: string[];
  memo: string;
  author: string;
  date: string;
  source?: { record: string; steps: [number, number] } | { report: string; tests: string[] };
  file: string;
  contentHash: string;
}

interface Notice {
  file: string;
  reason: string;
}

interface NewStory {
  id: unknown;
  name: unknown;
  needs?: unknown;
  screens: unknown[];
  expects?: unknown;
  memo?: string;
  author: unknown;
  source?: RawSource;
}

export const STORY_ID = /^[a-z0-9_-]+$/;
const FIELD_KEYS = ['needs', 'expects'] as const;
const KEYS = ['name', 'screens', ...FIELD_KEYS, 'memo', 'author', 'date', 'source'];
const STEP_FIELD_KEYS = ['needs', 'linkNeeds', 'expects'] as const;
const STEP_FIELDS = ['needs', 'linkNeeds', 'inputs', 'expects'];
const STEP_KEYS = ['screen', ...STEP_FIELDS];
const INPUT_KEYS = ['box', 'value'];
export const BOX_WORDS = ['placeholder', 'label', 'testId'] as const;
const BOX_KEYS: string[] = [...BOX_WORDS, 'nth'];
export const DISCARDED = 'discarded';
export const CANDIDATES = 'candidates';
export const NEEDS = 'needs';
export const RECORDS = 'records';
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export const isScreenList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isText);
const isNeed = (v: any) => isText(v) || (isPlainObject(v) && Object.keys(v).length === 1 && isText(v.use));
const FIELD_RULES = {
  needs: { fits: isNeed, words: '조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로' },
  linkNeeds: { fits: isNeed, words: '들어오는 링크 조건을 하나씩 글이나 { "use": 공통 조건 파일 이름 } 으로' },
  expects: { fits: isText, words: '기대 결과를 하나씩 글로' },
};
const isStep = (v: number) => Number.isInteger(v) && v > 0;
const isRecordSource = (v: RawSource) => isText(v.record) && Array.isArray(v.steps) && v.steps.length === 2 && v.steps.every(isStep) && v.steps[0] <= v.steps[1];
const isTestsSource = (v: RawSource) => isText(v.report) && Array.isArray(v.tests) && v.tests.length > 0 && v.tests.every(isText);
export const isSource = (v: RawSource) => isPlainObject(v) && Object.keys(v).length === 2 && (isRecordSource(v) || isTestsSource(v));
// Date.parse 는 2026-02-30 을 3월 2일로 넘겨 받으므로, 날짜 부분이 그대로 되돌아오는지 본다.
export const isDate = (v: unknown) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v))
  && new Date(`${v.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === v.slice(0, 10);

export const hashOf = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const screenOf = (step: any) => (isPlainObject(step) ? step.screen : step);

function fieldsProblem(fields: { needs?: unknown; linkNeeds?: unknown; expects?: unknown }, where: string, keys: readonly (keyof typeof FIELD_RULES)[] = FIELD_KEYS) {
  const fits = (key: keyof typeof FIELD_RULES, v: unknown) => Array.isArray(v) && v.every(FIELD_RULES[key].fits);
  const bad = keys.find((key) => fields[key] !== undefined && !fits(key, fields[key]));
  return bad ? `${where}${bad} 는 ${FIELD_RULES[bad].words} 적은 목록이어야 합니다` : null;
}

function stepProblem(step: any, where: string, first: boolean) {
  if (isText(step)) return null;
  if (!isPlainObject(step)) return `${where}는 화면 ID 글자나 { "screen", "needs", "linkNeeds", "inputs", "expects" } 객체여야 합니다`;
  const unknown = Object.keys(step).filter((k) => !STEP_KEYS.includes(k));
  if (unknown.length) return `${where}에 모르는 항목이 있습니다: ${unknown.join(', ')}`;
  if (!isText(step.screen)) return `${where}의 screen 에 화면 ID 를 적어야 합니다`;
  if (first && step.linkNeeds !== undefined) return `${where}에는 앞 단계가 없어 linkNeeds(들어오는 링크 조건)를 둘 수 없습니다`;
  return fieldsProblem(step, `${where}의 `, STEP_FIELD_KEYS) ?? inputsProblem(step.inputs, where);
}

function boxProblem(box: any, where: string) {
  const missing = `${where}의 box 에 상자를 찾는 말(${BOX_WORDS.join(', ')})을 하나 이상 적어야 합니다`;
  if (!isPlainObject(box)) return missing;
  const unknown = Object.keys(box).filter((k) => !BOX_KEYS.includes(k));
  if (unknown.length) return `${where}의 box 에 모르는 종류가 있습니다: ${unknown.join(', ')} (상자를 찾는 말은 ${BOX_WORDS.join(', ')} 가운데서 고릅니다)`;
  const words = BOX_WORDS.filter((k) => box[k] !== undefined);
  if (!words.length) return missing;
  const empty = words.find((k) => !isText(box[k]));
  if (empty) return `${where}의 box 의 ${empty} 에 화면에 보이는 문구를 적어야 합니다`;
  if (box.nth !== undefined && !isStep(box.nth)) return `${where}의 box 의 nth 는 1 이상의 정수여야 합니다`;
  return null;
}

export function inputsProblem(inputs: unknown, where: string) {
  if (inputs === undefined) return null;
  if (!Array.isArray(inputs)) return `${where}의 inputs 는 입력값을 { "box", "value" } 객체로 하나씩 적은 목록이어야 합니다`;
  for (const [i, input] of inputs.entries()) {
    const at = `${where}의 ${i + 1} 번째 입력값`;
    if (!isPlainObject(input)) return `${at}은 { "box", "value" } 객체여야 합니다`;
    const unknown = Object.keys(input).filter((k) => !INPUT_KEYS.includes(k));
    if (unknown.length) return `${at}에 모르는 항목이 있습니다: ${unknown.join(', ')}`;
    const problem = boxProblem(input.box, at);
    if (problem) return problem;
    if (!isText(input.value)) return `${at}의 value 에 넣을 값을 글로 적어야 합니다`;
  }
  return null;
}

function problemOf(story: RawStory) {
  if (!isPlainObject(story)) return '스토리는 JSON 객체여야 합니다';
  const unknown = Object.keys(story).filter((k) => !KEYS.includes(k));
  if (unknown.length) {
    return `모르는 항목이 있습니다: ${unknown.join(', ')}${unknown.includes('id') ? ' (스토리 ID 는 파일 이름에서 정합니다)' : ''}`;
  }
  if (!isText(story.name)) return 'name 에 스토리 이름을 적어야 합니다';
  const fields = fieldsProblem(story, '');
  if (fields) return fields;
  const { screens } = story;
  if (!Array.isArray(screens) || !screens.length) return 'screens 는 화면 ID 를 하나 이상 차례대로 담은 목록이어야 합니다';
  for (const [i, step] of screens.entries()) {
    const problem = stepProblem(step, `screens 의 ${i + 1} 번째 단계`, i === 0);
    if (problem) return problem;
  }
  const ids = screens.map(screenOf);
  const repeated = ids.findIndex((s, i) => i > 0 && s === ids[i - 1]);
  if (repeated > 0) return `screens 의 ${repeated} 번째와 ${repeated + 1} 번째가 같은 화면입니다`;
  if (story.memo !== undefined && typeof story.memo !== 'string') return 'memo 는 글자여야 합니다';
  if (!isText(story.author)) return 'author 에 작성자를 적어야 합니다';
  if (!isDate(story.date)) return 'date 는 2026-10-02 같은 날짜여야 합니다';
  if (story.source !== undefined && !isSource(story.source)) return 'source 는 { "record": 기록 파일, "steps": [첫 단계, 끝 단계] } 나 { "report": 보고 파일, "tests": [시험 제목, ...] } 여야 합니다';
  return null;
}

const fieldsOf = (raw: any): StepFields => Object.fromEntries(STEP_FIELDS.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]));

function storyOf(story: any) {
  const steps: any[] = story.screens;
  const stepFields = steps.some(isPlainObject) ? { stepFields: steps.map((s) => (isPlainObject(s) ? fieldsOf(s) : {})) } : {};
  return {
    name: story.name,
    ...(story.needs && { needs: story.needs }),
    screens: steps.map(screenOf) as string[],
    ...stepFields,
    ...(story.expects && { expects: story.expects }),
    memo: story.memo ?? '',
    author: story.author,
    date: story.date,
    ...(story.source && { source: story.source }),
  };
}

const SAY = {
  folder: (message: string) => `스토리 폴더를 읽지 못했습니다: ${message}`,
  missing: () => '링크가 가리키는 파일이 없습니다',
  link: (message: string) => `링크를 따라가지 못했습니다: ${message}`,
};

function storyFiles(dir: string): { root: string; files: { file: string; reason?: string }[] } {
  if (!fs.statSync(dir).isDirectory()) return { root: path.dirname(dir), files: [{ file: path.basename(dir) }] };
  return { root: dir, files: jsonFiles(dir, SAY).filter((f) => ![DISCARDED, CANDIDATES, NEEDS, RECORDS].includes(f.file.split(path.sep)[0])) };
}

export function loadStories(dir: string): { stories: Story[]; notices: Notice[] } {
  if (!fs.existsSync(dir)) return { stories: [], notices: [] };
  const { root, files } = storyFiles(dir);
  const stories: Story[] = [];
  const notices: Notice[] = [];
  const fileOfId = new Map<string, string>();
  for (const { file, reason } of files) {
    if (reason) {
      notices.push({ file, reason });
      continue;
    }
    const id = path.basename(file, '.json');
    if (!STORY_ID.test(id)) {
      notices.push({ file, reason: '파일 이름이 스토리 ID 규칙(영문 소문자 · 숫자 · - · _)에 맞지 않습니다' });
      continue;
    }
    if (fileOfId.has(id)) {
      notices.push({ file, reason: `스토리 ID ${id} 는 ${fileOfId.get(id)} 에서 이미 썼습니다` });
      continue;
    }
    fileOfId.set(id, file);
    let story;
    let contentHash;
    try {
      const bytes = fs.readFileSync(path.join(root, file));
      contentHash = hashOf(bytes);
      story = JSON.parse(bytes.toString('utf8'));
    } catch (err) {
      notices.push({ file, reason: `JSON 으로 읽지 못했습니다: ${(err as Error).message}` });
      continue;
    }
    const problem = problemOf(story);
    if (problem) {
      notices.push({ file, reason: problem });
      continue;
    }
    stories.push({ id, ...storyOf(story), file, contentHash });
  }
  return { stories: stories.sort((a, b) => compare(a.id, b.id)), notices };
}

export function writableStoriesFolder(dir: string) {
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new Error(`스토리 폴더 ${dir} 가 파일이라 새 파일을 쓸 수 없습니다`);
  fs.mkdirSync(dir, { recursive: true });
}

const filled = (list: unknown) => (Array.isArray(list) && !list.length ? undefined : list);

export function addStory(dir: string, { id, name, needs, screens, expects, memo = '', author, source }: NewStory, now = new Date()) {
  if (typeof id !== 'string' || !STORY_ID.test(id)) throw new Error('스토리 ID 는 영문 소문자 · 숫자 · - · _ 로만 씁니다');
  if (!isText(name)) throw new Error('스토리 이름이 필요합니다');
  if (!isText(author)) throw new Error('작성자가 필요합니다');
  writableStoriesFolder(dir);
  const taken = storyFiles(dir).files.find((f) => path.basename(f.file) === `${id}.json`);
  if (taken) throw new Error(`스토리 ID ${id} 는 ${taken.file} 이 이미 씁니다`);
  const story = { name: name.trim(), screens, needs: filled(needs), expects: filled(expects), memo, author: author.trim(), date: now.toISOString(), ...(source && { source }) };
  const problem = problemOf(story);
  if (problem) throw new Error(problem);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(story, null, 2) + '\n', { flag: 'wx' });
  return { id, ...story, file: `${id}.json` };
}

export function editStory(dir: string, id: string, { name, memo }: { name: unknown; memo: unknown }) {
  if (!isText(name)) throw new Error('스토리 이름이 필요합니다');
  if (typeof memo !== 'string') throw new Error('메모는 글자여야 합니다');
  return rewriteStory(dir, id, (raw) => ({ ...raw, name: name.trim(), memo }));
}

export class FileChanged extends Error {}

type Place = { kind: 'story' } | { kind: 'step' | 'link'; step: number; screen: string };

const PLACE_FIELDS = { story: FIELD_KEYS, step: ['needs', 'inputs', 'expects'], link: ['linkNeeds'] } as const;

const isPlace = (v: any): v is Place => isPlainObject(v) && (v.kind === 'story' || ((v.kind === 'step' || v.kind === 'link') && isStep(v.step) && isText(v.screen)));
const placeName = (place: Place) => (place.kind === 'story' ? '스토리 전체' : `screens 의 ${place.step} 번째 단계${place.kind === 'link' ? '로 들어오는 링크' : ''}`);

function withFields(raw: any, keys: readonly string[], fields: Record<string, unknown>, order: readonly string[]) {
  const next = { ...raw };
  for (const key of keys.filter((k) => Object.hasOwn(fields, k))) next[key] = Array.isArray(fields[key]) && !fields[key].length ? undefined : fields[key];
  return Object.fromEntries(order.filter((k) => next[k] !== undefined).map((k) => [k, next[k]]));
}

function placeFields(raw: any, place: Place, fields: Record<string, unknown>) {
  const keys = PLACE_FIELDS[place.kind];
  if (place.kind === 'story') return withFields(raw, keys, fields, KEYS);
  const step = raw.screens[place.step - 1];
  const next = withFields(isPlainObject(step) ? step : { screen: step }, keys, fields, STEP_KEYS);
  return { ...raw, screens: raw.screens.with(place.step - 1, Object.keys(next).length === 1 ? next.screen : next) };
}

export function writeStoryFields(dir: string, id: string, { place, fields, contentHash }: { place: unknown; fields: unknown; contentHash: unknown }) {
  if (!isPlace(place)) throw new Error('place 는 { "kind": "story" } 나 { "kind": "step" 또는 "link", "step": 단계 번호, "screen": 그 단계의 화면 ID } 여야 합니다');
  if (!isPlainObject(fields)) throw new Error('fields 는 칸 이름마다 목록을 담은 객체여야 합니다');
  const given = fields as Record<string, unknown>;
  const keys: readonly string[] = PLACE_FIELDS[place.kind];
  const others = Object.keys(given).filter((k) => !keys.includes(k));
  if (others.length) throw new Error(`${placeName(place)}에는 ${keys.join(', ')} 만 적을 수 있습니다: ${others.join(', ')}`);
  if (typeof contentHash !== 'string') throw new Error('contentHash 에 페이지가 읽은 스토리 파일 내용의 SHA-256 을 보내야 합니다');
  return rewriteStory(dir, id, (raw) => {
    if (place.kind !== 'story') {
      if (place.step > raw.screens.length) throw new Error(`스토리 ${id} 에는 ${place.step} 번째 단계가 없습니다`);
      const screen = screenOf(raw.screens[place.step - 1]);
      if (screen !== place.screen) throw new Error(`스토리 ${id} 의 ${place.step} 번째 단계는 ${place.screen} 이 아니라 ${screen} 화면이라 쓰지 않았습니다`);
    }
    const next = placeFields(raw, place, given);
    const problem = problemOf(next);
    if (problem) throw new Error(problem);
    return next;
  }, { contentHash });
}

const isStepPick = (v: any) => isPlainObject(v) && isText(v.screen)
  && (Object.keys(v).length === 1 || (Object.keys(v).length === 2 && isStep(v.step)));

function withoutLinkNeeds(step: any) {
  if (!isPlainObject(step)) return step;
  const { linkNeeds, ...rest } = step as Record<string, unknown>;
  return Object.keys(rest).length === 1 ? rest.screen : rest;
}

// 앞 단계가 바뀌면 들어오는 링크 조건을 적어 둔 링크가 없어지므로 그 조건을 뗀다.
export function writeStorySteps(dir: string, id: string, { steps, contentHash }: { steps: unknown; contentHash: unknown }) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps 에 단계를 하나 이상 차례대로 담아야 합니다');
  const bad = steps.findIndex((s) => !isStepPick(s));
  if (bad >= 0) throw new Error(`steps 의 ${bad + 1} 번째는 남길 단계의 { "step": 단계 번호, "screen": 그 단계의 화면 ID } 나 새로 넣을 단계의 { "screen": 화면 ID } 여야 합니다`);
  if (typeof contentHash !== 'string') throw new Error('contentHash 에 페이지가 읽은 스토리 파일 내용의 SHA-256 을 보내야 합니다');
  const picks: { step?: number; screen: string }[] = steps;
  return rewriteStory(dir, id, (raw) => {
    let last = 0;
    const screens = picks.map((pick, i) => {
      if (pick.step === undefined) return pick.screen;
      if (pick.step > raw.screens.length) throw new Error(`스토리 ${id} 에는 ${pick.step} 번째 단계가 없습니다`);
      const screen = screenOf(raw.screens[pick.step - 1]);
      if (screen !== pick.screen) throw new Error(`스토리 ${id} 의 ${pick.step} 번째 단계는 ${pick.screen} 이 아니라 ${screen} 화면이라 쓰지 않았습니다`);
      if (pick.step === last) throw new Error(`${pick.step} 번째 단계를 두 번 남길 수 없습니다`);
      if (pick.step < last) throw new Error(`남기는 단계는 파일에 있던 차례대로 적어야 하는데, ${pick.step} 번째 단계가 ${last} 번째 단계 뒤에 왔습니다`);
      last = pick.step;
      const step = raw.screens[pick.step - 1];
      return i > 0 && picks[i - 1].step === pick.step - 1 ? step : withoutLinkNeeds(step);
    });
    const next = { ...raw, screens };
    const problem = problemOf(next);
    if (problem) throw new Error(problem);
    return next;
  }, { contentHash });
}

function rewriteStory(dir: string, id: string, change: (raw: any) => object, read?: { contentHash: unknown }) {
  const story = loadStories(dir).stories.find((s) => s.id === id);
  if (!story) throw new Error(`스토리 ${id} 를 찾지 못했습니다`);
  const file = path.join(storyFiles(dir).root, story.file);
  const bytes = fs.readFileSync(file);
  if (read && hashOf(bytes) !== read.contentHash) throw new FileChanged(`스토리 파일 ${story.file} 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다`);
  fs.writeFileSync(file, JSON.stringify(change(JSON.parse(bytes.toString('utf8'))), null, 2) + '\n');
  return { ...loadStories(dir).stories.find((s) => s.id === id)!, previousHash: hashOf(bytes) };
}
