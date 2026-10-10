import { callFinder, screenFinder } from './address-match.ts';
import { readTrace } from './playwright-trace.ts';

export const PASS_LEVELS = ['visit', 'interact', 'assert'];

export function traceLinker(map: any) {
  let screenAt: ReturnType<typeof screenFinder> | undefined;
  let callAt: ReturnType<typeof callFinder> | undefined;
  return (traceFile: string) => {
    const trace = readTrace(traceFile);
    if ('reason' in trace) return { reason: trace.reason };
    const { steps, requests } = trace;
    screenAt ??= screenFinder(map);
    callAt ??= callFinder(map);
    const screens = new Map<string, string>();
    const unmatched = new Set<string>();
    for (const { url, kind } of steps) {
      const id = screenAt(url);
      if (!id) unmatched.add(url);
      else if (PASS_LEVELS.indexOf(kind) > PASS_LEVELS.indexOf(screens.get(id)!)) screens.set(id, kind);
    }
    const calls = new Set(requests.map(({ method, url }) => callAt!(method, url)).filter(Boolean) as string[]);
    return { screens, calls, unmatched: [...unmatched] };
  };
}
