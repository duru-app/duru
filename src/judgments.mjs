import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileSafe, recordName, writeNewRecord } from './marks.mjs';
import { compare, isPlainObject } from './config.mjs';
import { jsonFiles } from './json-files.mjs';
import { withoutTags } from './verdict.mjs';

export const JUDGMENT_KINDS = ['discard', 'hand-over', 'undo'];

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

export const judgmentFile = (judgment) => path.join(fileSafe(judgment.node), recordName(judgment));

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
  writeNewRecord(path.join(dir, judgmentFile(judgment)), judgment);
  return judgment;
}

// 제외한 짝은 테스트가 결과에서 사라지면 어디에도 나오지 않는다.
export function applyJudgments(tests, judgments) {
  const latest = new Map();
  const ordered = [...judgments].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || compare(a.id, b.id));
  for (const j of ordered) latest.set(pairKey(j.test, j.node), j);
  const importers = {};
  const discarded = {};
  const awaitingTag = {};
  const found = new Set();
  for (const [id, list] of Object.entries(tests.importers ?? {})) {
    for (const t of list) {
      const ref = testRef(t);
      const key = pairKey(ref, id);
      const judgment = latest.get(key);
      if (judgment?.kind === 'discard') (discarded[id] ??= []).push({ ...t, ref, judgment });
      else if (judgment?.kind === 'hand-over') (awaitingTag[id] ??= []).push({ ...t, ref, judgment });
      else (importers[id] ??= []).push({ ...t, ref });
      found.add(key);
    }
  }
  const handOvers = [...latest].filter(([, judgment]) => judgment.kind === 'hand-over');
  if (handOvers.length) for (const [id, list] of Object.entries(tests.nodes ?? {})) for (const t of list) found.add(pairKey(testRef(t), id));
  const detachedHandOvers = {};
  for (const [key, judgment] of handOvers) {
    if (!found.has(key)) (detachedHandOvers[judgment.node] ??= []).push({ ref: judgment.test, judgment });
  }
  for (const list of Object.values(detachedHandOvers)) list.sort((a, b) => compare(a.ref.file, b.ref.file) || compare(a.ref.title, b.ref.title) || compare(a.ref.source, b.ref.source));
  const untagged = tests.untagged?.map((t) => ({ ...t, ref: testRef(t) }));
  return { ...tests, ...(untagged && { untagged }), importers, discarded, awaitingTag, detachedHandOvers };
}
