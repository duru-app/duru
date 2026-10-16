import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from './config.ts';
import { jsonFiles } from './json-files.ts';
import { FileChanged, hashOf, isText, loadStories, NEEDS, STORY_ID, writableStoriesFolder } from './stories.ts';
import type { Need, StepFields } from './stories.ts';

export interface NeedFile {
  file: string;
  name: string;
  text: string;
  contentHash: string;
  stories: string[];
}

interface Notice {
  file: string;
  reason: string;
}

interface Needs {
  list: NeedFile[];
  notices: Notice[];
}

interface PickingStory {
  id: string;
  needs?: Need[];
  stepFields?: StepFields[];
}

const KEYS = ['name', 'text'];
const SAY = {
  folder: (message: string) => `공통 조건 폴더를 읽지 못했습니다: ${message}`,
  missing: () => '링크가 가리키는 파일이 없습니다',
  link: (message: string) => `링크를 따라가지 못했습니다: ${message}`,
};

export const needPath = (use: string) => `${NEEDS}/${use}`;

function problemOf(need: any) {
  if (!isPlainObject(need)) return '공통 조건은 { "name", "text" } JSON 객체여야 합니다';
  const unknown = Object.keys(need).filter((k) => !KEYS.includes(k));
  if (unknown.length) return `모르는 항목이 있습니다: ${unknown.join(', ')}`;
  if (!isText(need.name)) return 'name 에 공통 조건 이름을 적어야 합니다';
  if (!isText(need.text)) return 'text 에 공통 조건 내용을 적어야 합니다';
  return null;
}

function loadNeeds(dir: string) {
  const folder = path.join(dir, NEEDS);
  const found: Omit<NeedFile, 'stories'>[] = [];
  const notices: Notice[] = [];
  if (!fs.existsSync(folder)) return { found, notices };
  if (!fs.statSync(folder).isDirectory()) return { found, notices: [{ file: NEEDS, reason: `${NEEDS} 는 공통 조건 파일을 담는 폴더여야 합니다` }] };
  for (const entry of jsonFiles(folder, SAY)) {
    const use = entry.file.split(path.sep).join('/');
    const file = entry.file === folder ? NEEDS : needPath(use);
    if (entry.reason) {
      notices.push({ file, reason: entry.reason });
      continue;
    }
    if (!STORY_ID.test(path.basename(entry.file, '.json'))) {
      notices.push({ file, reason: '파일 이름이 스토리 ID 와 같은 규칙(영문 소문자 · 숫자 · - · _)에 맞지 않습니다' });
      continue;
    }
    let need;
    let contentHash;
    try {
      const bytes = fs.readFileSync(path.join(folder, entry.file));
      contentHash = hashOf(bytes);
      need = JSON.parse(bytes.toString('utf8'));
    } catch (err) {
      notices.push({ file, reason: `JSON 으로 읽지 못했습니다: ${(err as Error).message}` });
      continue;
    }
    const problem = problemOf(need);
    if (problem) notices.push({ file, reason: problem });
    else found.push({ file: use, name: need.name, text: need.text, contentHash });
  }
  return { found, notices };
}

const picks = (story: PickingStory) => [...(story.needs ?? []), ...(story.stepFields ?? []).flatMap((f) => [...(f.needs ?? []), ...(f.linkNeeds ?? [])])]
  .flatMap((n) => (typeof n === 'string' ? [] : [n.use]));

export function findNeed(needs: Needs, use: string): { need: NeedFile } | { unread: string } | null {
  const need = needs.list.find((n) => n.file === use);
  if (need) return { need };
  const notice = needs.notices.find((n) => n.file === needPath(use));
  return notice ? { unread: notice.reason } : null;
}

export function checkNeeds(dir: string, stories: PickingStory[]) {
  const { found, notices } = loadNeeds(dir);
  const needs = { list: found.map((n) => ({ ...n, stories: stories.filter((st) => picks(st).includes(n.file)).map((st) => st.id) })), notices };
  return { ...needs, missing: stories.flatMap(picks).filter((use) => !findNeed(needs, use)).length };
}

const readBack = (dir: string, use: string) => checkNeeds(dir, loadStories(dir).stories).list.find((n) => n.file === use)!;

function needJson(name: unknown, text: unknown) {
  const need = { name: typeof name === 'string' ? name.trim() : name, text };
  const problem = problemOf(need);
  if (problem) throw new Error(problem);
  return JSON.stringify(need, null, 2) + '\n';
}

export function addNeed(dir: string, { file, name, text }: { file: unknown; name: unknown; text: unknown }) {
  if (typeof file !== 'string' || !file.endsWith('.json') || !STORY_ID.test(file.slice(0, -'.json'.length))) throw new Error('공통 조건 파일 이름은 영문 소문자 · 숫자 · - · _ 로 쓰고 .json 을 붙입니다');
  const json = needJson(name, text);
  writableStoriesFolder(dir);
  const folder = path.join(dir, NEEDS);
  if (fs.existsSync(folder) && !fs.statSync(folder).isDirectory()) throw new Error(`${NEEDS} 는 공통 조건 파일을 담는 폴더여야 합니다`);
  fs.mkdirSync(folder, { recursive: true });
  try {
    fs.writeFileSync(path.join(folder, file), json, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`공통 조건 파일 ${needPath(file)} 이 이미 있습니다`);
    throw err;
  }
  return readBack(dir, file);
}

export function editNeed(dir: string, { file, name, text, contentHash }: { file: unknown; name: unknown; text: unknown; contentHash: unknown }) {
  if (typeof contentHash !== 'string') throw new Error('contentHash 에 페이지가 읽은 공통 조건 파일 내용의 SHA-256 을 보내야 합니다');
  const json = needJson(name, text);
  const { found, notices } = loadNeeds(dir);
  const need = found.find((n) => n.file === file);
  if (!need) {
    const notice = typeof file === 'string' && notices.find((n) => n.file === needPath(file));
    throw new Error(notice ? `공통 조건 파일 ${notice.file} 을 읽지 못해 고치지 않았습니다: ${notice.reason}` : `공통 조건 파일 ${needPath(String(file))} 이 없습니다`);
  }
  if (need.contentHash !== contentHash) throw new FileChanged(`공통 조건 파일 ${needPath(need.file)} 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다`);
  fs.writeFileSync(path.join(dir, NEEDS, need.file), json);
  return { ...readBack(dir, need.file), previousHash: need.contentHash };
}
