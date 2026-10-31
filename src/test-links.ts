import fs from 'node:fs';
import path from 'node:path';
import { screenCases } from './access.ts';
import { codeHasher } from './code-state.ts';
import { compare } from './config.ts';
import type { TracedTest } from './candidates.ts';
import { importLinker } from './import-links.ts';
import { readJunit } from './junit.ts';
import { readPlaywright } from './playwright.ts';
import { copyShots } from './playwright-trace.ts';
import type { SentTrace } from './request-options.ts';
import { traceLinker } from './trace-links.ts';
import type { Walks } from './trace-links.ts';
import { STATUS_RANK, namesSource, readVerdicts, withProjectRun } from './verdict.ts';
import type { TestStatus } from './verdict.ts';
import { readVitest } from './vitest.ts';

type ImportLink = { reason?: string; file?: string; screens?: Map<string, string[]> };

interface Reader {
  read: (file: string) => any[] | null;
  extensions: string[];
}

interface UntaggedTest {
  title: string;
  tags: string[];
  file: string | null;
  line: number | null;
  source: string;
  format: string;
  status: TestStatus;
  testFile?: string;
  unmatched?: string[];
  projects?: Record<string, TestStatus>;
}

export const READERS: Record<string, Reader> = {
  playwright: { read: readPlaywright, extensions: ['.json'] },
  junit: { read: readJunit, extensions: ['.xml'] },
  vitest: { read: readVitest, extensions: ['.json'] },
  verdict: { read: readVerdicts, extensions: ['.txt', '.log'] },
};
export const DEPTHS = ['ui', 'api', 'render', 'code', 'data', 'output'];
export const NODE_TAG = /^(screen|call):(.+)$/;
const STORY_TAG = /^story:(.+)$/;
const DEPTH_TAG = /^depth:(.*)$/;
const OPTION_TAG = /^option:(.*)$/;
const OPTION_VALUE = /^([^=]+)=(true|false)$/;
const ACCESS_CASE_TAG = /^(role|setting):/;
const KIND_TAG = /^case:([^=]*)(?:=(.*))?$/;
const LIMIT_TAG = /^limit(?::(.*))?$/;
const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const shownFile = (t: { testFile?: string; file?: string | null }) => t.testFile ?? t.file ?? '';
const byTest = (a: UntaggedTest, b: UntaggedTest) => compare(shownFile(a), shownFile(b)) || (a.line ?? 0) - (b.line ?? 0) || compare(a.title, b.title) || compare(a.source, b.source);

function withLimit(t: any, format: string) {
  if (format === 'verdict' || t.status !== 'pass') return t;
  const sources = [...new Set<string>(t.tags.flatMap((tag: string) => {
    const m = tag.match(LIMIT_TAG);
    return m ? [m[1] ?? ''] : [];
  }))];
  if (!sources.length) return t;
  const written = sources.filter(Boolean).join(' ');
  if (sources.every(namesSource)) return { ...t, status: 'limit', detail: written };
  return { ...t, status: 'pending', detail: written ? `출처 없음 — ${written}` : '출처 없음' };
}

export function readResults(format: string, file: string) {
  return READERS[format].read(file)?.map((t) => withLimit(t, format)) ?? null;
}

export function resultFiles(p: string, extensions: string[]) {
  if (!fs.statSync(p).isDirectory()) return [p];
  return fs
    .readdirSync(p, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && extensions.some((ext: string) => e.name.endsWith(ext)))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

export function sentTraces(config: any): SentTrace[] {
  const sent: SentTrace[] = [];
  for (const source of config.tests) {
    if (source.format !== 'playwright' || !fs.existsSync(source.path)) continue;
    for (const file of resultFiles(source.path, READERS[source.format].extensions)) {
      let tests: any[] | null;
      try {
        tests = READERS[source.format].read(file);
      } catch {
        continue;
      }
      for (const t of tests ?? []) if (t.trace) sent.push({ trace: t.trace, title: t.title, file: t.file, line: t.line, project: t.project ?? null, status: t.status });
    }
  }
  return sent;
}

export function linkTests(config: any, map: any) {
  const known = new Set([...map.screens.map((s: any) => `screen:${s.id}`), ...(map.calls ?? []).map((c: any) => `call:${c.id}`)]);
  const callOptions = new Map<string, Set<string>>((map.calls ?? []).map((c: any) => [c.id, new Set((c.options ?? []).map((o: any) => o.key))]));
  const screensById = new Map<string, any>(map.screens.map((s: any) => [s.id, s]));
  const hasKinds = Object.keys(config.caseKinds).length > 0;
  const isKindCase = (tag: string) => {
    const [, kind, value] = tag.match(KIND_TAG)!;
    if (!Object.hasOwn(config.caseKinds, kind)) return false;
    const { values } = config.caseKinds[kind];
    return value === undefined ? !values.length : values.includes(value);
  };
  const caseTagsMemo = new Map<string, Set<string>>();
  const caseTagsOf = (id: string) => {
    if (!caseTagsMemo.has(id)) caseTagsMemo.set(id, new Set(screenCases(screensById.get(id).access).map((c) => c.tag)));
    return caseTagsMemo.get(id)!;
  };
  const nodes: Record<string, any[]> = {};
  const stories: Record<string, any[]> = Object.create(null);
  const unknownTags: { tag: string; test: { title: string; file: string | null; line: number | null } }[] = [];
  const untagged = new Map<string, any>();
  const missingSources = [];
  const seenUnknown = new Set();
  const linkByImports = importLinker(config.srcRoot, map, config.aliases);
  const importers: Record<string, any[]> = {};
  const importNotices: { file: string; reason: string }[] = [];
  const linkByTrace = traceLinker(map);
  const passed: Record<string, any[]> = {};
  const traceNotices = [];
  const screenOrders: TracedTest[] = [];
  const walks: Walks = {};
  const traceFiles: Record<string, Record<string, string>> = {};
  let untracedCount = 0;
  const shownPath = (file: string) => (path.relative(config.configDir, file).startsWith('..') ? file : path.relative(config.configDir, file));
  const reportUnknown = (tag: string, t: any, testKey: string) => {
    if (seenUnknown.has(`${tag} ${testKey}`)) return;
    seenUnknown.add(`${tag} ${testKey}`);
    unknownTags.push({ tag, test: { title: t.title, file: t.file, line: t.line } });
  };

  for (const source of config.tests) {
    if (!fs.existsSync(source.path)) {
      missingSources.push(path.relative(config.configDir, source.path));
      continue;
    }
    for (const file of resultFiles(source.path, READERS[source.format].extensions)) {
      const tests = READERS[source.format].read(file);
      if (!tests) continue;
      const resultPath = path.relative(config.configDir, file);
      for (const run of tests) {
        const t = withLimit(run, source.format);
        const testKey = `${resultPath} ${t.file}:${t.line} ${t.title}`;
        let depth = source.depth;
        for (const tag of t.tags) {
          const value = tag.match(DEPTH_TAG)?.[1];
          if (value === undefined) continue;
          if (DEPTHS.includes(value)) depth = value;
          else reportUnknown(tag, t, testKey);
        }
        const nodeTags: string[] = t.tags.filter((tag: string) => NODE_TAG.test(tag));
        const calls = nodeTags.filter((tag) => known.has(tag) && tag.startsWith('call:')).map((tag) => tag.match(NODE_TAG)![2]);
        const options: { key: string; value: boolean }[] = [];
        for (const tag of t.tags) {
          const value = tag.match(OPTION_TAG)?.[1];
          if (value === undefined) continue;
          const m = value.match(OPTION_VALUE);
          if (m && calls.some((id) => callOptions.get(id)!.has(m[1]))) options.push({ key: m[1], value: m[2] === 'true' });
          else reportUnknown(tag, t, testKey);
        }
        options.sort(byKey);
        const screens = nodeTags.filter((tag) => known.has(tag) && tag.startsWith('screen:')).map((tag) => tag.match(NODE_TAG)![2]);
        const caseTags = [...new Set<string>(t.tags.filter((tag: string) => ACCESS_CASE_TAG.test(tag)))].sort();
        for (const tag of caseTags) if (!screens.some((id) => caseTagsOf(id).has(tag))) reportUnknown(tag, t, testKey);
        const kindTags = hasKinds ? [...new Set<string>(t.tags.filter((tag: string) => KIND_TAG.test(tag)))].sort() : [];
        const kindCases = screens.length || calls.length ? kindTags.filter(isKindCase) : [];
        for (const tag of kindTags) if (!kindCases.includes(tag)) reportUnknown(tag, t, testKey);
        const storyTags = [...new Set<string>(t.tags.filter((tag: string) => STORY_TAG.test(tag)))];
        const link: ImportLink | null = source.format === 'vitest' ? linkByImports(t.file) : null;
        if (link) {
          if (link.reason && !importNotices.some((n) => n.file === t.file)) importNotices.push({ file: t.file, reason: link.reason });
          for (const [id, via] of link.screens ?? []) {
            if (t.tags.includes(`screen:${id}`)) continue;
            (importers[id] ??= []).push({ title: t.title, tags: t.tags, file: t.file, line: t.line, source: resultPath, format: source.format, depth, status: t.status, testFile: link.file, via });
          }
        }
        const trace = t.trace ? linkByTrace(t.trace) : null;
        const passedOrder = trace && !trace.reason && (t.status === 'pass' || t.status === 'limit') && t.traceRunPassed ? trace.order! : null;
        const stepsKey = trace?.walk && JSON.stringify([resultPath.split(path.sep).join('/'), t.file, t.line, t.title]);
        if (stepsKey) {
          (walks[stepsKey] ??= {})[t.project ?? ''] = trace!.walk!;
          (traceFiles[stepsKey] ??= {})[t.project ?? ''] = shownPath(t.trace).split(path.sep).join('/');
        }
        const steps = stepsKey ? { steps: stepsKey } : {};
        if (trace) {
          const traced = { title: t.title, tags: t.tags, file: t.file, line: t.line, project: t.project, source: resultPath, format: source.format, depth, status: t.status, ...steps };
          if (trace.reason) traceNotices.push({ file: shownPath(t.trace), test: { title: t.title, file: t.file, line: t.line, source: resultPath, project: t.project }, reason: trace.reason });
          else if (passedOrder) screenOrders.push({ report: resultPath.split(path.sep).join('/'), title: t.title, file: t.file, line: t.line, screens: passedOrder, ...(trace.inputs!.some((i) => i.length) && { inputs: trace.inputs! }), ...(trace.skipped! > 0 && { skipped: trace.skipped! }) });
          for (const [id, level] of trace.screens ?? []) {
            if (t.tags.includes(`screen:${id}`)) continue;
            (passed[id] ??= []).push({ ...traced, level });
          }
          for (const id of trace.calls ?? []) {
            if (!t.tags.includes(`call:${id}`)) (passed[id] ??= []).push({ ...traced, level: 'call' });
          }
        } else if (source.format === 'playwright' && run.status !== 'pending') {
          untracedCount += 1;
        }
        if (nodeTags.length === 0 && storyTags.length === 0) {
          const seen = untagged.get(testKey);
          if (!seen) untagged.set(testKey, { title: t.title, tags: t.tags, file: t.file, line: t.line, source: resultPath, format: source.format, status: t.status, ...(link?.file && { testFile: link.file }), ...(trace?.unmatched && { unmatched: trace.unmatched }), ...(t.project != null && { projects: withProjectRun(undefined, t.project, t.status) }) });
          else {
            if (STATUS_RANK[t.status] > STATUS_RANK[seen.status]) seen.status = t.status;
            if (trace?.unmatched) seen.unmatched = [...new Set([...(seen.unmatched ?? []), ...trace.unmatched])];
            if (t.project != null) seen.projects = withProjectRun(seen.projects, t.project, t.status);
          }
          continue;
        }
        const test = { title: t.title, tags: t.tags, file: t.file, line: t.line, project: t.project };
        const entry = { ...test, source: resultPath, format: source.format, depth, status: t.status, ...(link?.file && { testFile: link.file }), ...(t.detail && { detail: t.detail }), ...(trace?.unmatched && { unmatched: trace.unmatched }), ...steps };
        for (const tag of nodeTags) {
          if (!known.has(tag)) {
            reportUnknown(tag, t, testKey);
            continue;
          }
          const [, kind, id] = tag.match(NODE_TAG)!;
          const cases = [...(kind === 'screen' && caseTags.length ? caseTags.filter((tag) => caseTagsOf(id).has(tag)) : []), ...kindCases];
          const own = { ...entry, ...(kind === 'call' && { options: options.filter((o) => callOptions.get(id)!.has(o.key)) }), ...(cases.length > 0 && { cases }) };
          (nodes[id] ??= []).push(own);
        }
        const storyEntry = passedOrder ? { ...entry, screens: passedOrder } : entry;
        for (const tag of storyTags) (stories[tag.match(STORY_TAG)![1]] ??= []).push(storyEntry);
      }
    }
  }

  const hash = codeHasher(config.srcRoot);
  const testFiles = new Set<string>([...Object.values(nodes), ...Object.values(stories), ...Object.values(importers), [...untagged.values()]].flat().map((t) => t.testFile).filter(Boolean));
  const testFileHashes = Object.fromEntries([...testFiles].map((f) => f.replaceAll('\\', '/')).sort().map((f) => [f, hash([f])]));
  return { meta: { generatedAt: new Date().toISOString() }, nodes, stories, importers, importNotices, passed, traceNotices, traced: screenOrders, walks, traceFiles, untracedCount, unknownTags, untagged: [...untagged.values()].sort(byTest), untaggedCount: untagged.size, missingSources, testFileHashes };
}

export function writeShots(config: any, { walks, traceFiles }: Pick<ReturnType<typeof linkTests>, 'walks' | 'traceFiles'>, dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, runs] of Object.entries(walks)) {
    for (const [project, lines] of Object.entries(runs)) {
      const names = lines.flatMap((line) => ('shot' in line && line.shot ? [line.shot] : []));
      if (names.length) copyShots(path.resolve(config.configDir, traceFiles[key][project]), names, dir);
    }
  }
}
