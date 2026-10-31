import { callFinder, screenFinder } from './address-match.ts';
import { sentAtAppStart } from './map.ts';
import type { SentRequests } from './request-options.ts';

export type TracedTest = { test: string; file: string | null; line: number | null; project: string | null };
export type TracedScreen = { screen: string; tests: TracedTest[] };

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byTest = (a: TracedTest, b: TracedTest) => compare(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || compare(a.test, b.test) || compare(a.project ?? '', b.project ?? '');

// 요청을 보낸 순간 페이지가 보이던 주소의 화면에 그 요청의 호출을 잇는다.
export function addTracedScreens(map: any, sent: SentRequests[]): { calls: number; screens: number } {
  const callAt = callFinder(map);
  const screenAt = screenFinder(map);
  const calls = new Map<string, any>((map.calls ?? []).map((c: any) => [c.id, c]));
  const appStart = sentAtAppStart(map.appWide);
  const found = new Map<string, Map<string, Map<string, TracedTest>>>();
  for (const t of sent) {
    for (const { method, url, shown } of t.pageRequests) {
      const id = callAt(method, url);
      const screen = screenAt(shown);
      const call = id ? calls.get(id) : undefined;
      if (!call || !screen || appStart.has(call.id) || call.screens.includes(screen)) continue;
      const screens = found.get(call.id) ?? new Map<string, Map<string, TracedTest>>();
      found.set(call.id, screens);
      const tests = screens.get(screen) ?? new Map<string, TracedTest>();
      screens.set(screen, tests);
      tests.set(JSON.stringify([t.file, t.line, t.title, t.project]), { test: t.title, file: t.file, line: t.line, project: t.project });
    }
  }
  const linked = new Set<string>();
  for (const [id, screens] of found) {
    calls.get(id).tracedScreens = [...screens].sort(([a], [b]) => compare(a, b)).map(([screen, tests]) => {
      linked.add(screen);
      return { screen, tests: [...tests.values()].sort(byTest) };
    });
  }
  return { calls: found.size, screens: linked.size };
}
