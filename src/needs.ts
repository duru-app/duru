import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from './config.ts';
import { jsonFiles } from './json-files.ts';
import { isText, NEEDS, STORY_ID } from './stories.ts';
import type { Need, StepFields } from './stories.ts';

export interface NeedFile {
  file: string;
  name: string;
  text: string;
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
  folder: (message: string) => `준비물 폴더를 읽지 못했습니다: ${message}`,
  missing: () => '링크가 가리키는 파일이 없습니다',
  link: (message: string) => `링크를 따라가지 못했습니다: ${message}`,
};

export const needPath = (use: string) => `${NEEDS}/${use}`;

function problemOf(need: any) {
  if (!isPlainObject(need)) return '준비물은 { "name", "text" } JSON 객체여야 합니다';
  const unknown = Object.keys(need).filter((k) => !KEYS.includes(k));
  if (unknown.length) return `모르는 항목이 있습니다: ${unknown.join(', ')}`;
  if (!isText(need.name)) return 'name 에 준비물 이름을 적어야 합니다';
  if (!isText(need.text)) return 'text 에 준비물 내용을 적어야 합니다';
  return null;
}

function loadNeeds(dir: string) {
  const folder = path.join(dir, NEEDS);
  const found: Omit<NeedFile, 'stories'>[] = [];
  const notices: Notice[] = [];
  if (!fs.existsSync(folder)) return { found, notices };
  if (!fs.statSync(folder).isDirectory()) return { found, notices: [{ file: NEEDS, reason: `${NEEDS} 는 준비물 파일을 담는 폴더여야 합니다` }] };
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
    try {
      need = JSON.parse(fs.readFileSync(path.join(folder, entry.file), 'utf8'));
    } catch (err) {
      notices.push({ file, reason: `JSON 으로 읽지 못했습니다: ${(err as Error).message}` });
      continue;
    }
    const problem = problemOf(need);
    if (problem) notices.push({ file, reason: problem });
    else found.push({ file: use, name: need.name, text: need.text });
  }
  return { found, notices };
}

const picks = (story: PickingStory) => [...(story.needs ?? []), ...(story.stepFields ?? []).flatMap((f) => f.needs ?? [])]
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
