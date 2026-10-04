import fs from 'node:fs';
import path from 'node:path';
import { compare } from './config.mjs';
import { importLinker } from './import-links.mjs';
import { readJunit } from './junit.mjs';
import { readPlaywright } from './playwright.mjs';
import { traceLinker } from './trace-links.mjs';
import { readVerdicts } from './verdict.mjs';
import { readVitest } from './vitest.mjs';

export const READERS = {
  playwright: { read: readPlaywright, extensions: ['.json'] },
  junit: { read: readJunit, extensions: ['.xml'] },
  vitest: { read: readVitest, extensions: ['.json'] },
  verdict: { read: readVerdicts, extensions: ['.txt', '.log'] },
};
export const DEPTHS = ['ui', 'api', 'render', 'code', 'data', 'output'];
const NODE_TAG = /^(screen|call):(.+)$/;
const STORY_TAG = /^story:(.+)$/;
const DEPTH_TAG = /^depth:(.*)$/;
const OPTION_TAG = /^option:(.*)$/;
const OPTION_VALUE = /^([^=]+)=(true|false)$/;
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const shownFile = (t) => t.testFile ?? t.file ?? '';
const byTest = (a, b) => compare(shownFile(a), shownFile(b)) || (a.line ?? 0) - (b.line ?? 0) || compare(a.title, b.title) || compare(a.source, b.source);
const STATUS_RANK = { pass: 0, pending: 1, fail: 2 };

function resultFiles(p, extensions) {
  if (!fs.statSync(p).isDirectory()) return [p];
  return fs
    .readdirSync(p, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && extensions.some((ext) => e.name.endsWith(ext)))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

export function linkTests(config, map) {
  const known = new Set([...map.screens.map((s) => `screen:${s.id}`), ...(map.calls ?? []).map((c) => `call:${c.id}`)]);
  const callOptions = new Map((map.calls ?? []).map((c) => [c.id, new Set((c.options ?? []).map((o) => o.key))]));
  const nodes = {};
  const stories = Object.create(null);
  const unknownTags = [];
  const untagged = new Map();
  const missingSources = [];
  const seenUnknown = new Set();
  const linkByImports = importLinker(config.srcRoot, map);
  const importers = {};
  const importNotices = [];
  const linkByTrace = traceLinker(map);
  const passed = {};
  const traceNotices = [];
  let untracedCount = 0;
  const shownPath = (file) => (path.relative(config.configDir, file).startsWith('..') ? file : path.relative(config.configDir, file));
  const reportUnknown = (tag, t, testKey) => {
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
      for (const t of tests) {
        const testKey = `${resultPath} ${t.file}:${t.line} ${t.title}`;
        let depth = source.depth;
        for (const tag of t.tags) {
          const value = tag.match(DEPTH_TAG)?.[1];
          if (value === undefined) continue;
          if (DEPTHS.includes(value)) depth = value;
          else reportUnknown(tag, t, testKey);
        }
        const nodeTags = t.tags.filter((tag) => NODE_TAG.test(tag));
        const calls = nodeTags.filter((tag) => known.has(tag) && tag.startsWith('call:')).map((tag) => tag.match(NODE_TAG)[2]);
        const options = [];
        for (const tag of t.tags) {
          const value = tag.match(OPTION_TAG)?.[1];
          if (value === undefined) continue;
          const m = value.match(OPTION_VALUE);
          if (m && calls.some((id) => callOptions.get(id).has(m[1]))) options.push({ key: m[1], value: m[2] === 'true' });
          else reportUnknown(tag, t, testKey);
        }
        options.sort(byKey);
        const storyTags = [...new Set(t.tags.filter((tag) => STORY_TAG.test(tag)))];
        const link = source.format === 'vitest' ? linkByImports(t.file) : null;
        if (link) {
          if (link.reason && !importNotices.some((n) => n.file === t.file)) importNotices.push({ file: t.file, reason: link.reason });
          for (const [id, via] of link.screens ?? []) {
            if (t.tags.includes(`screen:${id}`)) continue;
            (importers[id] ??= []).push({ title: t.title, file: t.file, line: t.line, source: resultPath, format: source.format, depth, status: t.status, testFile: link.file, via });
          }
        }
        if (t.trace) {
          const trace = linkByTrace(t.trace);
          if (trace.reason) traceNotices.push({ file: shownPath(t.trace), test: { title: t.title, file: t.file, line: t.line }, reason: trace.reason });
          for (const [id, level] of trace.screens ?? []) {
            if (t.tags.includes(`screen:${id}`)) continue;
            (passed[id] ??= []).push({ title: t.title, file: t.file, line: t.line, project: t.project, source: resultPath, format: source.format, depth, status: t.status, level });
          }
        } else if (source.format === 'playwright' && t.status !== 'pending') {
          untracedCount += 1;
        }
        if (nodeTags.length === 0 && storyTags.length === 0) {
          const seen = untagged.get(testKey);
          if (!seen) untagged.set(testKey, { title: t.title, file: t.file, line: t.line, source: resultPath, format: source.format, status: t.status, ...(link?.file && { testFile: link.file }) });
          else if (STATUS_RANK[t.status] > STATUS_RANK[seen.status]) seen.status = t.status;
          continue;
        }
        const test = { title: t.title, file: t.file, line: t.line, project: t.project };
        const entry = { ...test, source: resultPath, format: source.format, depth, status: t.status, ...(link?.file && { testFile: link.file }), ...(t.detail && { detail: t.detail }) };
        for (const tag of nodeTags) {
          if (!known.has(tag)) {
            reportUnknown(tag, t, testKey);
            continue;
          }
          const [, kind, id] = tag.match(NODE_TAG);
          const own = kind === 'call' ? { ...entry, options: options.filter((o) => callOptions.get(id).has(o.key)) } : entry;
          (nodes[id] ??= []).push(own);
        }
        for (const tag of storyTags) (stories[tag.match(STORY_TAG)[1]] ??= []).push(entry);
      }
    }
  }

  return { meta: { generatedAt: new Date().toISOString() }, nodes, stories, importers, importNotices, passed, traceNotices, untracedCount, unknownTags, untagged: [...untagged.values()].sort(byTest), untaggedCount: untagged.size, missingSources };
}
