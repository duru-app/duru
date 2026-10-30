import { callFinder } from './address-match.ts';
import { readTrace } from './playwright-trace.ts';
import type { TestStatus } from './verdict.ts';

export type SentTrace = { trace: string; title: string; file: string | null; line: number | null; project: string | null; status: TestStatus };

export type RequestSent = { test: string; file: string | null; line: number | null; project: string | null; values: boolean[] };

type MapOption = { key: string; values: boolean[]; sources: string[]; sites: { screen: string; file: string; line: number }[]; requests?: RequestSent[] };

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byOption = (a: { key: string }, b: { key: string }) => compare(a.key, b.key);
const byRequest = (a: RequestSent, b: RequestSent) => compare(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || compare(a.test, b.test) || compare(a.project ?? '', b.project ?? '');

export function bodyOptions(body: string): { key: string; value: boolean }[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const found = new Map<string, boolean[]>();
  const walk = (value: unknown, at: string) => {
    if (typeof value === 'boolean') {
      const values = found.get(at) ?? [];
      if (!values.includes(value)) values.push(value);
      found.set(at, values);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, `${at}[]`);
      return;
    }
    if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) walk(item, at ? `${at}.${name}` : name);
  };
  walk(json, '');
  return [...found]
    .filter(([key]) => key !== '')
    .sort(([a], [b]) => compare(a, b))
    .flatMap(([key, values]) => values.map((value) => ({ key, value })));
}

export function addRequestOptions(map: any, sent: SentTrace[]): { options: number; calls: number } {
  const callAt = callFinder(map);
  const leftOut = new Set<string>((map.leftOutBodyTypeFields ?? []).map((r: { call: string; field: string }) => `${r.call}\n${r.field}`));
  const optionsOf = new Map<string, MapOption[]>((map.calls ?? []).map((c: any) => [c.id, (c.options ??= [])]));
  const sending = new Map<string, { call: string; key: string; test: string; file: string | null; line: number | null; project: string | null; values: Set<boolean> }>();
  for (const t of sent) {
    const trace = readTrace(t.trace);
    if ('reason' in trace) continue;
    for (const { method, url, body } of trace.requests) {
      if (!body) continue;
      const call = callAt(method, url);
      const options = call ? optionsOf.get(call) : undefined;
      if (!call || !options) continue;
      for (const { key, value } of bodyOptions(body)) {
        if (leftOut.has(`${call}\n${key}`)) continue;
        let option = options.find((o) => o.key === key);
        if (!option) {
          option = { key, values: [true, false], sources: ['request'], sites: [] };
          options.push(option);
        }
        if (!option.sources.includes('request')) option.sources.push('request');
        const id = JSON.stringify([call, key, t.file, t.line, t.title, t.project]);
        const one = sending.get(id) ?? { call, key, test: t.title, file: t.file, line: t.line, project: t.project, values: new Set<boolean>() };
        one.values.add(value);
        sending.set(id, one);
      }
    }
  }
  for (const { call, key, test, file, line, project, values } of sending.values()) {
    const option = optionsOf.get(call)!.find((o) => o.key === key)!;
    (option.requests ??= []).push({ test, file, line, project, values: [true, false].filter((v) => values.has(v)) });
  }
  for (const options of optionsOf.values()) {
    for (const option of options) option.requests?.sort(byRequest);
    options.sort(byOption);
  }
  const withRequest = (map.calls ?? []).filter((c: any) => c.options.some((o: MapOption) => o.sources.includes('request')));
  return { options: withRequest.reduce((n: number, c: any) => n + c.options.filter((o: MapOption) => o.sources.includes('request')).length, 0), calls: withRequest.length };
}
