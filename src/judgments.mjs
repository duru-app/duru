import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileSafe, writeNewRecord } from './marks.mjs';
import { compare, isPlainObject } from './config.mjs';
import { jsonFiles } from './json-files.mjs';
import { withoutTags } from './verdict.mjs';

export const JUDGMENT_KINDS = ['discard', 'undo'];

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

// 경로 구분자는 / 로 통일해야 Windows 에서 적은 판단이 다른 OS 에서도 같은 테스트를 가리킨다.
const slashed = (p) => (typeof p === 'string' ? p.replaceAll('\\', '/') : p);

// 줄 번호와 Playwright 프로젝트 이름은 넣지 않는다. 테스트 위에 줄이 늘거나 제목에 태그를 달아도 같은 테스트여야 하기 때문이다.
// 결과 파일에 적힌 경로는 결과를 만든 컴퓨터마다 다르므로, srcRoot 아래에서 찾은 경로(testFile)가 있으면 그것을 쓴다.
const reference = ({ source, file, title }) => ({ source: slashed(source), file: slashed(file), title: typeof title === 'string' ? withoutTags(title) : title });
export const testRef = (t) => reference({ source: t.source, file: t.testFile ?? t.file, title: t.title });

const pairKey = (test, node) => JSON.stringify([test.source, test.file, test.title, node]);

// 시간대가 없는 날짜는 읽는 컴퓨터의 시간대로 풀려 순서가 달라지므로, Z 나 ±hh:mm 으로 시간대를 밝힌 날짜만 받는다.
const hasZonedDate = (v) => typeof v === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));

function problemOf(j) {
  if (!isPlainObject(j)) return 'a judgment must be a JSON object';
  const { test } = j;
  if (!isPlainObject(test) || !isText(test.source) || !(isText(test.file) || test.file === null) || !isText(test.title)) {
    return 'test needs a result source, a test file and a title';
  }
  if (!isText(j.node)) return 'judgment needs a node ID';
  if (!JUDGMENT_KINDS.includes(j.kind)) return `unknown judgment kind "${j.kind}" (expected one of ${JUDGMENT_KINDS.join(', ')})`;
  if (typeof j.reason !== 'string') return 'judgment reason must be text';
  if (j.kind === 'discard' && !j.reason.trim()) return 'a discard needs a reason';
  if (!isText(j.author)) return 'judgment needs an author';
  return null;
}

const SAY = {
  folder: (message) => `cannot read the folder: ${message}`,
  missing: () => 'the link points to no file',
  link: (message) => `cannot follow the link: ${message}`,
};

// 읽지 못하는 폴더나 파일, 형식이 틀린 파일은 예외를 던지지 않고 notices 에 담아 돌려준다.
export function loadJudgments(dir) {
  if (!fs.existsSync(dir)) return { judgments: [], notices: [] };
  const judgments = [];
  const notices = [];
  for (const { file, reason } of jsonFiles(dir, SAY)) {
    if (reason) {
      notices.push({ file, reason });
      continue;
    }
    let judgment;
    try {
      judgment = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      notices.push({ file, reason: `not valid JSON: ${err.message}` });
      continue;
    }
    const problem = problemOf(judgment) ?? (!isText(judgment.id) || !hasZonedDate(judgment.date) ? 'judgment needs an ID and a date with its time zone, like 2026-10-04T01:00:00Z' : null);
    if (problem) notices.push({ file, reason: problem });
    else judgments.push({ ...judgment, test: reference(judgment.test) });
  }
  return { judgments, notices };
}

export function addJudgment(dir, { test, node, kind, reason, author }, now = new Date()) {
  const judgment = {
    id: crypto.randomUUID(),
    test: isPlainObject(test) ? reference(test) : test,
    node,
    kind,
    reason: reason ?? '',
    author: typeof author === 'string' ? author.trim() : author,
    date: now.toISOString(),
  };
  const problem = problemOf(judgment);
  if (problem) throw new Error(problem);
  writeNewRecord(path.join(dir, fileSafe(node)), judgment);
  return judgment;
}

// importers 에 있는 테스트만 나누므로, 버린 판단의 테스트가 결과에 없으면 그 짝은 어디에도 나오지 않는다.
export function applyJudgments(tests, judgments) {
  const latest = new Map();
  const ordered = [...judgments].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || compare(a.id, b.id));
  for (const j of ordered) latest.set(pairKey(j.test, j.node), j);
  const importers = {};
  const discarded = {};
  for (const [id, list] of Object.entries(tests.importers ?? {})) {
    for (const t of list) {
      const ref = testRef(t);
      const judgment = latest.get(pairKey(ref, id));
      if (judgment?.kind === 'discard') (discarded[id] ??= []).push({ ...t, ref, judgment });
      else (importers[id] ??= []).push({ ...t, ref });
    }
  }
  return { ...tests, importers, discarded };
}
