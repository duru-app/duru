import fs from 'node:fs';
import path from 'node:path';
import { compare } from './config.ts';
import { testRef } from './judgments.ts';
import type { TestRef } from './judgments.ts';
import { NODE_TAG, READERS, resultFiles } from './test-links.ts';
import { STATUS_RANK, withoutTags } from './verdict.ts';
import type { TestStatus } from './verdict.ts';

export interface BaselineTest {
  title: string;
  tags: string[];
  file: string | null;
  line: number | null;
  project: string | null;
  status: TestStatus;
  result: string;
}

export interface BaselineResult {
  result: string;
  startedAt: string;
}

export interface BaselineTests {
  folder: string;
  label: string;
  results: BaselineResult[];
  tests: BaselineTest[];
}

interface Source {
  format: string;
  path: string;
}

const fromConfig = (configDir: string, p: string) => path.relative(configDir, p);

function commonFolder(folders: string[]) {
  const [first, ...rest] = folders.map((f) => f.split(path.sep));
  const differs = first.findIndex((part, i) => rest.some((p) => p[i] !== part));
  return (differs === -1 ? first : first.slice(0, differs)).join(path.sep) || path.sep;
}

function startedAt(format: string, file: string) {
  if (format === 'playwright' || format === 'vitest') {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = format === 'playwright' ? report.stats?.startTime : report.startTime;
    if ((typeof at === 'string' || typeof at === 'number') && !Number.isNaN(new Date(at).getTime())) return new Date(at).toISOString();
  }
  return fs.statSync(file).mtime.toISOString();
}

export function readBaselineTests(config: { configDir: string; baselineTests: Source[] }): BaselineTests {
  const tests: BaselineTest[] = [];
  const results: BaselineResult[] = [];
  const folders: string[] = [];
  for (const source of config.baselineTests) {
    const fail = (reason: string) => new Error(`baselineTests ${fromConfig(config.configDir, source.path)} could not be read: ${reason}`);
    if (!fs.existsSync(source.path)) throw fail('it does not exist');
    folders.push(fs.statSync(source.path).isDirectory() ? source.path : path.dirname(source.path));
    const before = tests.length;
    for (const file of resultFiles(source.path, READERS[source.format].extensions)) {
      const result = fromConfig(config.configDir, file);
      let read;
      try {
        read = READERS[source.format].read(file) ?? [];
      } catch (err) {
        throw fail((err as Error).message);
      }
      if (read.length) results.push({ result, startedAt: startedAt(source.format, file) });
      for (const t of read) tests.push({ title: t.title, tags: t.tags, file: t.file ?? null, line: t.line ?? null, project: t.project ?? null, status: t.status, result });
    }
    if (tests.length === before) throw fail(`it holds no ${source.format} test result`);
  }
  const folder = commonFolder(folders);
  const relative = path.relative(config.configDir, folder);
  return { folder: relative.startsWith('..') || path.isAbsolute(relative) ? folder : relative.split(path.sep).join('/') || '.', label: path.basename(folder), results, tests };
}

type Rows = Record<string, any[]> | undefined;

export interface CurrentTests {
  nodes?: Rows;
  importers?: Rows;
  passed?: Rows;
  awaitingTag?: Rows;
  discarded?: Rows;
  stories?: Rows;
  untagged?: any[];
  unknownTags?: { test: { file: string | null } }[];
}

const UNDER_NODE = [['nodes', 'tag'], ['importers', 'import'], ['passed', 'trace'], ['awaitingTag', 'hand-over']] as const;
const OFF_NODE = ['stories', 'discarded'] as const;
const LISTED_LEVELS = ['interact', 'assert'];

type Via = (typeof UNDER_NODE)[number][1];

interface TestRow {
  node: string;
  kind: 'screen' | 'call';
  via: Via;
  level?: string;
  status: TestStatus;
  listed: boolean;
  ref: TestRef;
  source: string;
  project: string | null;
}

interface OnlyInBaseline {
  title: string;
  tail: string;
  line: number | null;
  project: string | null;
  status: TestStatus;
  result: string;
  nodes: string[];
}

interface Place {
  file: string | null;
  line: number | null;
  title: string;
  project: string | null;
}

interface CurrentTest {
  title: string;
  tags: string[];
  file: string | null;
  project: string | null;
  status: TestStatus;
  place: Place;
  rows: TestRow[];
  offNode: TestStatus[];
}

const worst = (statuses: TestStatus[]) => statuses.reduce((w, s) => (STATUS_RANK[s] > STATUS_RANK[w] ? s : w));
const byRow = (a: TestRow, b: TestRow) => compare(a.kind === 'call', b.kind === 'call') || compare(a.node, b.node) || compare(a.source, b.source) || compare(a.project ?? '', b.project ?? '');
const byPlace = (a: Place, b: Place) => compare(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || compare(a.title, b.title) || compare(a.project ?? '', b.project ?? '');

const statusIn = (t: any, project: string | null): TestStatus => (project !== null && t.projects?.[project]) || t.status;

function currentTests(current: CurrentTests, calls: Set<string>) {
  const runs = new Map<string, CurrentTest>();
  const runsOf = (t: any) => (t.projects ? Object.keys(t.projects) : [t.project ?? null]).map((project: string | null) => {
    const id = JSON.stringify([t.source, t.file, t.line, t.title, project]);
    if (!runs.has(id)) runs.set(id, { title: t.title, tags: t.tags ?? [], file: t.file ?? null, project, status: t.status, place: { file: t.testFile ?? t.file ?? null, line: t.line ?? null, title: t.title, project }, rows: [], offNode: [] });
    return runs.get(id)!;
  });
  for (const [field, via] of UNDER_NODE) {
    for (const [node, list] of Object.entries(current[field] ?? {})) {
      for (const t of list) {
        const listed = via !== 'trace' || LISTED_LEVELS.includes(t.level);
        for (const run of runsOf(t)) run.rows.push({ node, kind: calls.has(node) ? 'call' : 'screen', via, ...(t.level && { level: t.level }), status: statusIn(t, run.project), listed, ref: t.ref ?? testRef(t), source: t.source, project: run.project });
      }
    }
  }
  const offNode = [...OFF_NODE.flatMap((field) => Object.values(current[field] ?? {}).flat()), ...(current.untagged ?? [])];
  for (const t of offNode) for (const run of runsOf(t)) run.offNode.push(statusIn(t, run.project));
  for (const test of runs.values()) test.status = worst(test.rows.length ? test.rows.map((r) => r.status) : test.offNode);
  return [...runs.values()];
}

type Matched = { title: string; tags: string[]; file: string | null; project: string | null };

const segments = (file: string | null) => (file ?? '').split(/[\\/]+/).filter(Boolean);
const tail = (file: string | null, length: number) => segments(file).slice(-length).join('/');

function separatingLength(files: (string | null)[]) {
  const distinct = [...new Set(files.map((f) => tail(f, Infinity)))];
  if (distinct.length < 2) return 0;
  let length = 1;
  while (new Set(distinct.map((f) => tail(f, length))).size < distinct.length) length += 1;
  return length;
}

const groupBy = <T>(list: T[], keyOf: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of list) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
};

function ownLengths(files: (string | null)[]) {
  const distinct = [...new Set(files.map((f) => tail(f, Infinity)))];
  const lengths = new Map<string, number>();
  for (let length = 1; lengths.size < distinct.length; length += 1) {
    const counts = new Map<string, number>();
    for (const f of distinct) counts.set(tail(f, length), (counts.get(tail(f, length)) ?? 0) + 1);
    for (const f of distinct) if (!lengths.has(f) && counts.get(tail(f, length)) === 1) lengths.set(f, length);
  }
  return lengths;
}

const tagSet = (t: Matched) => [...new Set(t.tags)].sort().join(' ');
const overlaps = (tests: Matched[] = []) => tests.length > 1 && new Set(tests.map(tagSet)).size > 1;

function matchKeys<B extends Matched, N extends Matched>(baseline: B[], current: N[]) {
  const titleKey = (t: Matched) => JSON.stringify([withoutTags(t.title), t.project]);
  const [before, now] = [groupBy<Matched>(baseline, titleKey), groupBy<Matched>(current, titleKey)];
  const keys = new Map<Matched, string>();
  for (const key of new Set([...before.keys(), ...now.keys()])) {
    const sides = [before.get(key) ?? [], now.get(key) ?? []];
    const length = Math.max(...sides.map((tests) => separatingLength(tests.map((t) => t.file))));
    const tailOf = (t: Matched) => (length ? tail(t.file, length) : '');
    const [tailedBefore, tailedNow] = sides.map((tests) => groupBy(tests, tailOf));
    for (const tests of sides) {
      for (const t of tests) {
        const withTags = overlaps(tailedBefore.get(tailOf(t))) || overlaps(tailedNow.get(tailOf(t)));
        keys.set(t, JSON.stringify([key, tailOf(t), withTags ? tagSet(t) : '']));
      }
    }
  }
  return { before: groupBy(baseline, (t) => keys.get(t)!), now: groupBy(current, (t) => keys.get(t)!) };
}

export function compareTests(baseline: BaselineTests, current: CurrentTests, map: { screens: string[]; calls: string[] }) {
  const tests = currentTests(current, new Set(map.calls));
  const { before, now } = matchKeys(baseline.tests, tests);
  const nowFiles = [...tests.map((t) => t.file), ...(current.unknownTags ?? []).map((u) => u.test.file)];
  const onMap = new Set([...map.screens, ...map.calls]);
  const gone: BaselineTest[][] = [];
  let compared = 0;
  let notUnderNode = 0;
  let onlyInBaseline = 0;
  const regressions = [];
  for (const [key, tests] of before) {
    const status = worst(tests.map((t) => t.status));
    const match = now.get(key);
    if (!match) {
      onlyInBaseline += 1;
      gone.push(tests);
    }
    else if (!match.some((t) => t.rows.length)) notUnderNode += 1;
    else {
      compared += 1;
      const nowStatus = worst(match.map((t) => t.status));
      if (status !== 'pass' || nowStatus === 'pass') continue;
      const under = match.filter((t) => t.rows.length);
      const results = new Set(tests.map((t) => t.result));
      regressions.push({
        change: nowStatus === 'fail' ? ('pass→fail' as const) : ('pass→pending' as const),
        test: under.map((t) => t.place).sort(byPlace)[0],
        baseline: baseline.results.filter((r) => results.has(r.result)),
        rows: under.flatMap((t) => t.rows).sort(byRow),
      });
    }
  }
  const onlyNow = [...now].filter(([key, tests]) => !before.has(key) && tests.some((t) => t.rows.length)).length;
  regressions.sort((a, b) => byPlace(a.test, b.test));
  return {
    folder: baseline.folder,
    label: baseline.label,
    results: baseline.results,
    compared,
    notUnderNode,
    onlyInBaseline,
    onlyNow,
    regressions,
    byNode: countsByNode(regressions.map((r) => r.rows)),
    ...onlyInBaselineOf(gone, baseline.tests, nowFiles, onMap),
  };
}

type Counts = { fail: number; pending: number };

function countsByNode(regressed: TestRow[][]) {
  const byNode: Record<string, { listed: Counts; chipOnly: Counts }> = {};
  for (const rows of regressed) {
    for (const node of new Set(rows.map((r) => r.node))) {
      const failing = rows.filter((r) => r.node === node && r.status !== 'pass');
      const listed = failing.filter((r) => r.listed);
      const counted = listed.length ? listed : failing;
      if (!counted.length) continue;
      const counts = (byNode[node] ??= { listed: { fail: 0, pending: 0 }, chipOnly: { fail: 0, pending: 0 } });
      counts[listed.length ? 'listed' : 'chipOnly'][worst(counted.map((r) => r.status)) as keyof Counts] += 1;
    }
  }
  return byNode;
}

// 두 쪽에서 저마다 그 파일을 다른 파일과 가르는 가장 짧은 꼬리를 구하고, 긴 쪽의 길이로 꼬리가 같으면 같은 파일이다.
function onlyInBaselineOf(gone: BaselineTest[][], all: BaselineTest[], nowFiles: (string | null)[], onMap: Set<string>) {
  const [beforeLengths, nowLengths] = [ownLengths(all.map((t) => t.file)), ownLengths(nowFiles)];
  const kept = (file: string) => [...nowLengths].some(([other, length]) => {
    const longer = Math.max(beforeLengths.get(file)!, length);
    return tail(file, longer) === tail(other, longer);
  });
  const files = new Map<string, OnlyInBaseline[]>();
  for (const tests of gone) {
    const [first] = [...tests].sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || compare(a.title, b.title));
    const file = tail(first.file, Infinity);
    const nodes = [...new Set(tests.flatMap((t) => t.tags.map((tag) => tag.match(NODE_TAG)?.[2]).filter((id): id is string => id !== undefined && onMap.has(id))))].sort(compare);
    const entry = { title: first.title, tail: tail(file, beforeLengths.get(file)!), line: first.line, project: first.project, status: worst(tests.map((t) => t.status)), result: first.result, nodes };
    files.set(file, [...(files.get(file) ?? []), entry]);
  }
  const byLine = (a: OnlyInBaseline, b: OnlyInBaseline) => (a.line ?? 0) - (b.line ?? 0) || compare(a.title, b.title) || compare(a.project ?? '', b.project ?? '');
  const onlyInBaselineFiles = [...files].map(([file, tests]) => ({ tail: tests[0].tail, whole: !kept(file), tests: tests.sort(byLine) })).sort((a, b) => compare(a.tail, b.tail));
  const onlyInBaselineByNode: Record<string, OnlyInBaseline[]> = {};
  for (const { tests } of onlyInBaselineFiles) for (const t of tests) for (const id of t.nodes) (onlyInBaselineByNode[id] ??= []).push(t);
  return { onlyInBaselineFiles, onlyInBaselineByNode };
}

export type TestComparison = ReturnType<typeof compareTests>;

const nodesOf = (rows: TestRow[]) => {
  const ids = (kind: string) => [...new Set(rows.filter((r) => r.kind === kind).map((r) => r.node))].sort(compare).map((id) => `${kind} ${id}`);
  return [...ids('screen'), ...ids('call')].join(', ');
};

export function baselineTestsLines(c: TestComparison) {
  const changed = (change: string) => c.regressions.filter((r) => r.change === change).length;
  const lines = [`test results since ${c.folder} | compared ${c.compared} | pass→fail ${changed('pass→fail')} pass→pending ${changed('pass→pending')} | not on a screen or call now ${c.notUnderNode} | only in baseline ${c.onlyInBaseline} | only now ${c.onlyNow}`];
  if (!c.compared) lines.push('  no test was compared: no baseline test matches a test under a screen or call now');
  for (const { change, test, rows } of c.regressions) {
    const at = test.line === null ? test.file : `${test.file}:${test.line}`;
    lines.push(`  ${change} ← ${at} ${test.title}${test.project ? ` (${test.project})` : ''} — ${nodesOf(rows)}`);
  }
  for (const { tail: file, whole, tests } of c.onlyInBaselineFiles) {
    if (whole) lines.push(`  only in baseline ← ${file}: ${tests.length} test${tests.length === 1 ? '' : 's'}, none of this file's tests are in the current results`);
  }
  return lines;
}
