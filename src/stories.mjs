import fs from 'node:fs';
import path from 'node:path';
import { compare, isPlainObject } from './config.mjs';

export const STORY_ID = /^[a-z0-9_-]+$/;
const KEYS = ['name', 'screens', 'memo', 'author', 'date'];
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const isText = (v) => typeof v === 'string' && v.trim().length > 0;
// Date.parse 는 2026-02-30 을 3월 2일로 넘겨 받으므로, 날짜 부분이 그대로 되돌아오는지 본다.
const isDate = (v) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v))
  && new Date(`${v.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === v.slice(0, 10);

function problemOf(story) {
  if (!isPlainObject(story)) return '스토리는 JSON 객체여야 합니다';
  const unknown = Object.keys(story).filter((k) => !KEYS.includes(k));
  if (unknown.length) {
    return `모르는 항목이 있습니다: ${unknown.join(', ')}${unknown.includes('id') ? ' (스토리 ID 는 파일 이름에서 정합니다)' : ''}`;
  }
  if (!isText(story.name)) return 'name 에 스토리 이름을 적어야 합니다';
  const { screens } = story;
  if (!Array.isArray(screens) || !screens.length || !screens.every(isText)) return 'screens 는 화면 ID 를 하나 이상 차례대로 담은 목록이어야 합니다';
  const repeated = screens.findIndex((s, i) => i > 0 && s === screens[i - 1]);
  if (repeated > 0) return `screens 의 ${repeated} 번째와 ${repeated + 1} 번째가 같은 화면입니다`;
  if (story.memo !== undefined && typeof story.memo !== 'string') return 'memo 는 글자여야 합니다';
  if (!isText(story.author)) return 'author 에 작성자를 적어야 합니다';
  if (!isDate(story.date)) return 'date 는 2026-10-02 같은 날짜여야 합니다';
  return null;
}

// 폴더를 가리키는 링크는 readdirSync 가 이미 따라 들어갔으므로 null 로 건너뛴다.
function linkedFile(file) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return { reason: '링크가 가리키는 파일이 없습니다' };
    return stat.isFile() ? {} : null;
  } catch (err) {
    return { reason: `링크를 따라가지 못했습니다: ${err.message}` };
  }
}

function storyFiles(dir) {
  if (!fs.statSync(dir).isDirectory()) return { root: path.dirname(dir), files: [{ file: path.basename(dir) }] };
  let entries;
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (err) {
    return { root: dir, files: [{ file: dir, reason: `스토리 폴더를 읽지 못했습니다: ${err.message}` }] };
  }
  const files = entries
    .filter((e) => e.name.endsWith('.json') && (e.isFile() || e.isSymbolicLink()))
    .flatMap((e) => {
      const full = path.join(e.parentPath, e.name);
      const read = e.isSymbolicLink() ? linkedFile(full) : {};
      return read ? [{ file: path.relative(dir, full), ...read }] : [];
    })
    .sort((a, b) => compare(a.file, b.file));
  return { root: dir, files };
}

export function loadStories(dir) {
  if (!fs.existsSync(dir)) return { stories: [], notices: [] };
  const { root, files } = storyFiles(dir);
  const stories = [];
  const notices = [];
  const fileOfId = new Map();
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
      notices.push({ file, reason: `JSON 으로 읽지 못했습니다: ${err.message}` });
      continue;
    }
    const problem = problemOf(story);
    if (problem) {
      notices.push({ file, reason: problem });
      continue;
    }
    stories.push({ id, name: story.name, screens: story.screens, memo: story.memo ?? '', author: story.author, date: story.date, file });
  }
  return { stories: stories.sort((a, b) => compare(a.id, b.id)), notices };
}
