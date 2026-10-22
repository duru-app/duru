import fs from 'node:fs';
import path from 'node:path';
import { compare } from './config.ts';
import { testRef } from './judgments.ts';
import type { TestRef } from './judgments.ts';
import { NODE_TAG, READERS, resultFiles } from './test-links.ts';
import { STATUS_RANK, titleWithoutTags } from './verdict.ts';
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
  unknownTags?: { tag: string; test: { title: string; file: string | null; line: number | null } }[];
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
  file: string;
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
  status: TestStatus | null;
  place: Place;
  rows: TestRow[];
  offNode: TestStatus[];
}

const worst = (statuses: TestStatus[]) => statuses.reduce((w, s) => (STATUS_RANK[s] > STATUS_RANK[w] ? s : w));
const byRow = (a: TestRow, b: TestRow) => compare(a.kind === 'call', b.kind === 'call') || compare(a.node, b.node) || compare(a.source, b.source) || compare(a.project ?? '', b.project ?? '');
const byPlace = (a: Place, b: Place) => compare(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || compare(a.title, b.title) || compare(a.project ?? '', b.project ?? '');

const statusIn = (t: any, project: string | null): TestStatus => (project !== null && t.projects?.[project]) || t.worstStatus || t.status;

const tagsInTitle = (title: string) => (title.match(/@\S+/g) ?? []).map((t) => t.slice(1));

function currentTests(current: CurrentTests, calls: Set<string>, projectsOf: (title: string) => (string | null)[]) {
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
  for (const test of runs.values()) test.status = test.rows.length ? worst(test.rows.map((r) => r.status)) : worst(test.offNode);
  const listed = new Set([...runs.values()].map((r) => JSON.stringify([r.file, r.place.line, r.title])));
  const offMap = groupBy(current.unknownTags ?? [], (u) => JSON.stringify([u.test.file, u.test.line, u.test.title]));
  for (const [key, entries] of offMap) {
    if (listed.has(key) || !entries.some((u) => NODE_TAG.test(u.tag))) continue;
    const { title, file, line } = entries[0].test;
    const tags = [...new Set([...tagsInTitle(title), ...entries.map((u) => u.tag)])];
    for (const project of projectsOf(title)) {
      runs.set(JSON.stringify([null, file, line, title, project]), { title, tags, file, project, status: null, place: { file, line, title, project }, rows: [], offNode: [] });
    }
  }
  return [...runs.values()];
}

type Matched = { title: string; tags: string[]; file: string | null; project: string | null };

const segments = (file: string | null) => (file ?? '').split(/[\\/]+/).filter(Boolean);
const isAbsolute = (file: string | null) => file !== null && /^(?:[\\/]|[A-Za-z]:[\\/])/.test(file);

function belowCommonFolder(files: (string | null)[]) {
  const folders = [...new Set(files.filter(isAbsolute))].map((f) => segments(f).slice(0, -1));
  let depth = 0;
  while (folders.length && depth < folders[0].length && folders.every((f) => f[depth] === folders[0][depth])) depth += 1;
  return { folder: folders[0]?.slice(0, depth) ?? [], relative: (file: string | null) => (isAbsolute(file) ? segments(file).slice(depth) : segments(file)) };
}

// 한쪽 공통 폴더의 끝 폴더들을 그쪽 경로 앞에 다시 붙여 보아, 두 쪽에 같은 파일이 가장 많아지는 것을 쓴다.
function fileKeys(beforeFiles: (string | null)[], nowFiles: (string | null)[]) {
  const [before, now] = [belowCommonFolder(beforeFiles), belowCommonFolder(nowFiles)];
  const keyed = (side: typeof before, files: (string | null)[], prefix: string[]) => new Map(files.map((f) => [f, [...(isAbsolute(f) ? prefix : []), ...side.relative(f)].join('/')]));
  const prefixes: [string[], string[]][] = [[[], []]];
  for (let k = 1; k <= Math.max(before.folder.length, now.folder.length); k += 1) {
    if (k <= before.folder.length) prefixes.push([before.folder.slice(-k), []]);
    if (k <= now.folder.length) prefixes.push([[], now.folder.slice(-k)]);
  }
  let best = { same: -1, before: new Map<string | null, string>(), now: new Map<string | null, string>() };
  for (const [beforePrefix, nowPrefix] of prefixes) {
    const keys = { before: keyed(before, beforeFiles, beforePrefix), now: keyed(now, nowFiles, nowPrefix) };
    const nowKeys = new Set(keys.now.values());
    const same = new Set([...keys.before.values()].filter((k) => nowKeys.has(k))).size;
    if (same > best.same) best = { same, ...keys };
  }
  return best;
}

const groupBy = <T>(list: T[], keyOf: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of list) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return groups;
};

const tagSet = (t: Matched) => [...new Set(t.tags)].sort().join(' ');
const overlaps = (tests: Matched[] = []) => tests.length > 1 && new Set(tests.map(tagSet)).size > 1;

function matchKeys<B extends Matched, N extends Matched>(baseline: B[], current: N[], files: ReturnType<typeof fileKeys>) {
  const keyOf = (keys: Map<string | null, string>) => (t: Matched) => JSON.stringify([titleWithoutTags(t.title), t.project, keys.get(t.file)]);
  const [before, now] = [groupBy<Matched>(baseline, keyOf(files.before)), groupBy<Matched>(current, keyOf(files.now))];
  const keys = new Map<Matched, string>();
  for (const key of new Set([...before.keys(), ...now.keys()])) {
    const withTags = overlaps(before.get(key)) || overlaps(now.get(key));
    for (const t of [...(before.get(key) ?? []), ...(now.get(key) ?? [])]) keys.set(t, JSON.stringify([key, withTags ? tagSet(t) : '']));
  }
  return { before: groupBy(baseline, (t) => keys.get(t)!), now: groupBy(current, (t) => keys.get(t)!) };
}

export function compareTests(baseline: BaselineTests, current: CurrentTests, map: { screens: string[]; calls: string[] }) {
  const baselineProjects = groupBy(baseline.tests, (t) => titleWithoutTags(t.title));
  const projectsOf = (title: string) => {
    const projects = [...new Set((baselineProjects.get(titleWithoutTags(title)) ?? []).map((t) => t.project))];
    return projects.length ? projects : [null];
  };
  const tests = currentTests(current, new Set(map.calls), projectsOf);
  const files = fileKeys(baseline.tests.map((t) => t.file), [...tests.map((t) => t.file), ...(current.unknownTags ?? []).map((u) => u.test.file)]);
  const { before, now } = matchKeys(baseline.tests, tests, files);
  const onMap = new Set([...map.screens, ...map.calls]);
  const gone: BaselineTest[][] = [];
  let compared = 0;
  let notUnderNode = 0;
  let onlyInBaseline = 0;
  const regressions = [];
  for (const [key, tests] of before) {
    const ran = tests.filter((t) => t.status !== 'pending');
    const status = worst((ran.length ? ran : tests).map((t) => t.status));
    const match = now.get(key);
    if (!match) {
      onlyInBaseline += 1;
      gone.push(tests);
      continue;
    }
    if (!match.some((t) => t.rows.length)) notUnderNode += 1;
    else {
      compared += 1;
      const nowStatus = worst(match.flatMap((t) => t.status ?? []));
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
    ...onlyInBaselineOf(gone, files, onMap),
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

// jest-junit 은 기본으로 시험 이름을 classname 에 적어, 그런 이름은 시험 파일을 가리키지 않는다.
const namesItself = (t: BaselineTest) => t.file !== null && (t.title === t.file || t.title.endsWith(` › ${t.file}`));

function onlyInBaselineOf(gone: BaselineTest[][], keys: ReturnType<typeof fileKeys>, onMap: Set<string>) {
  const nowFiles = new Set(keys.now.values());
  const testFiles = new Set<string>();
  const files = new Map<string, OnlyInBaseline[]>();
  for (const tests of gone) {
    const [first] = [...tests].sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || compare(a.title, b.title));
    const file = keys.before.get(first.file)!;
    const nodes = [...new Set(tests.flatMap((t) => t.tags.map((tag) => tag.match(NODE_TAG)?.[2]).filter((id): id is string => id !== undefined && onMap.has(id))))].sort(compare);
    const entry = { title: first.title, file, line: first.line, project: first.project, status: worst(tests.map((t) => t.status)), result: first.result, nodes };
    files.set(file, [...(files.get(file) ?? []), entry]);
    if (!tests.every(namesItself)) testFiles.add(file);
  }
  const byLine = (a: OnlyInBaseline, b: OnlyInBaseline) => (a.line ?? 0) - (b.line ?? 0) || compare(a.title, b.title) || compare(a.project ?? '', b.project ?? '');
  const onlyInBaselineFiles = [...files].map(([file, tests]) => ({ file, whole: testFiles.has(file) && !nowFiles.has(file), tests: tests.sort(byLine) })).sort((a, b) => compare(a.file, b.file));
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
  for (const { file, whole, tests } of c.onlyInBaselineFiles) {
    if (whole) lines.push(`  only in baseline ← ${file}: ${tests.length} test${tests.length === 1 ? '' : 's'}, none of this file's tests are in the current results`);
  }
  return lines;
}
