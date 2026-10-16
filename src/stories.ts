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

export interface StepFields {
  needs?: string[];
  linkNeeds?: string[];
  inputs?: StepInput[];
  expects?: string[];
}

export interface Story {
  id: string;
  name: string;
  needs?: string[];
  screens: string[];
  stepFields?: StepFields[];
  expects?: string[];
  memo: string;
  author: string;
  date: string;
  source?: { record: string; steps: [number, number] } | { report: string; tests: string[] };
  file: string;
}

interface Notice {
  file: string;
  reason: string;
}

interface NewStory {
  id: unknown;
  name: unknown;
  screens: string[];
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
const FIELD_WORDS = { needs: '조건을', linkNeeds: '들어오는 링크 조건을', expects: '기대 결과를' };
export const DISCARDED = 'discarded';
export const CANDIDATES = 'candidates';
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export const isScreenList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isText);
const isTextList = (v: unknown) => Array.isArray(v) && v.every(isText);
const isStep = (v: number) => Number.isInteger(v) && v > 0;
const isRecordSource = (v: RawSource) => isText(v.record) && Array.isArray(v.steps) && v.steps.length === 2 && v.steps.every(isStep) && v.steps[0] <= v.steps[1];
const isTestsSource = (v: RawSource) => isText(v.report) && Array.isArray(v.tests) && v.tests.length > 0 && v.tests.every(isText);
export const isSource = (v: RawSource) => isPlainObject(v) && Object.keys(v).length === 2 && (isRecordSource(v) || isTestsSource(v));
// Date.parse 는 2026-02-30 을 3월 2일로 넘겨 받으므로, 날짜 부분이 그대로 되돌아오는지 본다.
export const isDate = (v: unknown) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v))
  && new Date(`${v.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === v.slice(0, 10);

const screenOf = (step: any) => (isPlainObject(step) ? step.screen : step);

function fieldsProblem(fields: { needs?: unknown; linkNeeds?: unknown; expects?: unknown }, where: string, keys: readonly (keyof typeof FIELD_WORDS)[] = FIELD_KEYS) {
  const bad = keys.find((key) => fields[key] !== undefined && !isTextList(fields[key]));
  return bad ? `${where}${bad} 는 ${FIELD_WORDS[bad]} 하나씩 글로 적은 목록이어야 합니다` : null;
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

function inputsProblem(inputs: unknown, where: string) {
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
  return { root: dir, files: jsonFiles(dir, SAY).filter((f) => ![DISCARDED, CANDIDATES].includes(f.file.split(path.sep)[0])) };
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
    try {
      story = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch (err) {
      notices.push({ file, reason: `JSON 으로 읽지 못했습니다: ${(err as Error).message}` });
      continue;
    }
    const problem = problemOf(story);
    if (problem) {
      notices.push({ file, reason: problem });
      continue;
    }
    stories.push({ id, ...storyOf(story), file });
  }
  return { stories: stories.sort((a, b) => compare(a.id, b.id)), notices };
}

export function writableStoriesFolder(dir: string) {
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new Error(`스토리 폴더 ${dir} 가 파일이라 새 파일을 쓸 수 없습니다`);
  fs.mkdirSync(dir, { recursive: true });
}

export function addStory(dir: string, { id, name, screens, memo = '', author, source }: NewStory, now = new Date()) {
  if (typeof id !== 'string' || !STORY_ID.test(id)) throw new Error('스토리 ID 는 영문 소문자 · 숫자 · - · _ 로만 씁니다');
  if (!isText(name)) throw new Error('스토리 이름이 필요합니다');
  if (!isText(author)) throw new Error('작성자가 필요합니다');
  writableStoriesFolder(dir);
  const taken = storyFiles(dir).files.find((f) => path.basename(f.file) === `${id}.json`);
  if (taken) throw new Error(`스토리 ID ${id} 는 ${taken.file} 이 이미 씁니다`);
  const story = { name: name.trim(), screens, memo, author: author.trim(), date: now.toISOString(), ...(source && { source }) };
  const problem = problemOf(story);
  if (problem) throw new Error(problem);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(story, null, 2) + '\n', { flag: 'wx' });
  return { id, ...story, file: `${id}.json` };
}

export function editStory(dir: string, id: string, { name, memo }: { name: unknown; memo: unknown }) {
  if (!isText(name)) throw new Error('스토리 이름이 필요합니다');
  if (typeof memo !== 'string') throw new Error('메모는 글자여야 합니다');
  const story = loadStories(dir).stories.find((s) => s.id === id);
  if (!story) throw new Error(`스토리 ${id} 를 찾지 못했습니다`);
  const file = path.join(storyFiles(dir).root, story.file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, name: name.trim(), memo }, null, 2) + '\n');
  return { ...story, name: name.trim(), memo };
}
