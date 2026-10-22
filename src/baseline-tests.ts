import fs from 'node:fs';
import path from 'node:path';
import { compare } from './config.ts';
import { testRef } from './judgments.ts';
import type { TestRef } from './judgments.ts';
import { READERS, STATUS_RANK, resultFiles } from './test-links.ts';
import { withoutTags } from './verdict.ts';
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

export interface BaselineTests {
  folder: string;
  label: string;
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

export function readBaselineTests(config: { configDir: string; baselineTests: Source[] }): BaselineTests {
  const tests: BaselineTest[] = [];
  const folders: string[] = [];
  for (const source of config.baselineTests) {
    const fail = (reason: string) => new Error(`baselineTests ${fromConfig(config.configDir, source.path)} could not be read: ${reason}`);
    if (!fs.existsSync(source.path)) throw fail('it does not exist');
    folders.push(fs.statSync(source.path).isDirectory() ? source.path : path.dirname(source.path));
    for (const file of resultFiles(source.path, READERS[source.format].extensions)) {
      const result = fromConfig(config.configDir, file);
      for (const t of READERS[source.format].read(file) ?? []) {
        tests.push({ title: t.title, tags: t.tags, file: t.file ?? null, line: t.line ?? null, project: t.project ?? null, status: t.status, result });
      }
    }
  }
  const folder = commonFolder(folders);
  const relative = path.relative(config.configDir, folder);
  return { folder: relative.startsWith('..') || path.isAbsolute(relative) ? folder : relative.split(path.sep).join('/') || '.', label: path.basename(folder), tests };
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

interface Place {
  file: string | null;
  line: number | null;
  title: string;
  project: string | null;
}

interface CurrentTest {
  title: string;
  project: string | null;
  status: TestStatus;
  place: Place;
  rows: TestRow[];
  offNode: TestStatus[];
}

const worst = (statuses: TestStatus[]) => statuses.reduce((w, s) => (STATUS_RANK[s] > STATUS_RANK[w] ? s : w));
const byPlace = (a: Place, b: Place) => compare(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || compare(a.title, b.title) || compare(a.project ?? '', b.project ?? '');

function currentTests(current: CurrentTests, calls: Set<string>) {
  const runs = new Map<string, CurrentTest>();
  const runOf = (t: any) => {
    const project = t.project ?? null;
    const id = JSON.stringify([t.source, t.file, t.line, t.title, project]);
    if (!runs.has(id)) runs.set(id, { title: t.title, project, status: t.status, place: { file: t.testFile ?? t.file ?? null, line: t.line ?? null, title: t.title, project }, rows: [], offNode: [] });
    return runs.get(id)!;
  };
  for (const [field, via] of UNDER_NODE) {
    for (const [node, list] of Object.entries(current[field] ?? {})) {
      for (const t of list) {
        const listed = via !== 'trace' || LISTED_LEVELS.includes(t.level);
        runOf(t).rows.push({ node, kind: calls.has(node) ? 'call' : 'screen', via, ...(t.level && { level: t.level }), status: t.status, listed, ref: t.ref ?? testRef(t), source: t.source, project: t.project ?? null });
      }
    }
  }
  for (const field of OFF_NODE) for (const list of Object.values(current[field] ?? {})) for (const t of list) runOf(t).offNode.push(t.status);
  for (const t of current.untagged ?? []) runOf(t).offNode.push(t.status);
  for (const test of runs.values()) test.status = worst(test.rows.length ? test.rows.map((r) => r.status) : test.offNode);
  return [...runs.values()];
}

const keyOf = (t: { title: string; project: string | null }) => JSON.stringify([withoutTags(t.title), t.project]);

function byKey<T extends { title: string; project: string | null }>(tests: T[]) {
  const groups = new Map<string, T[]>();
  for (const t of tests) groups.set(keyOf(t), [...(groups.get(keyOf(t)) ?? []), t]);
  return groups;
}

export function compareTests(baseline: BaselineTests, current: CurrentTests, map: { screens: string[]; calls: string[] }) {
  const now = byKey(currentTests(current, new Set(map.calls)));
  const before = byKey(baseline.tests);
  let compared = 0;
  let notUnderNode = 0;
  let onlyInBaseline = 0;
  const regressions = [];
  for (const [key, tests] of before) {
    const status = worst(tests.map((t) => t.status));
    const match = now.get(key);
    if (!match) onlyInBaseline += 1;
    else if (!match.some((t) => t.rows.length)) notUnderNode += 1;
    else {
      compared += 1;
      const nowStatus = worst(match.map((t) => t.status));
      if (status !== 'pass' || nowStatus === 'pass') continue;
      const under = match.filter((t) => t.rows.length);
      regressions.push({
        change: nowStatus === 'fail' ? ('pass→fail' as const) : ('pass→pending' as const),
        test: under.map((t) => t.place).sort(byPlace)[0],
        rows: under.flatMap((t) => t.rows),
      });
    }
  }
  const onlyNow = [...now].filter(([key, tests]) => !before.has(key) && tests.some((t) => t.rows.length)).length;
  regressions.sort((a, b) => byPlace(a.test, b.test));
  return { folder: baseline.folder, label: baseline.label, compared, notUnderNode, onlyInBaseline, onlyNow, regressions };
}

export type TestComparison = ReturnType<typeof compareTests>;

const nodesOf = (rows: TestRow[]) => {
  const ids = (kind: string) => [...new Set(rows.filter((r) => r.kind === kind).map((r) => r.node))].sort(compare).map((id) => `${kind} ${id}`);
  return [...ids('screen'), ...ids('call')].join(', ');
};

export function baselineTestsLines(c: TestComparison) {
  const changed = (change: string) => c.regressions.filter((r) => r.change === change).length;
  const lines = [`test results since ${c.folder} | compared ${c.compared} | pass→fail ${changed('pass→fail')} pass→pending ${changed('pass→pending')} | not on a screen or call now ${c.notUnderNode} | only in baseline ${c.onlyInBaseline} | only now ${c.onlyNow}`];
  for (const { change, test, rows } of c.regressions) {
    const at = test.line === null ? test.file : `${test.file}:${test.line}`;
    lines.push(`  ${change} ← ${at} ${test.title}${test.project ? ` (${test.project})` : ''} — ${nodesOf(rows)}`);
  }
  return lines;
}
