import { callFinder, screenFinder } from './address-match.mjs';
import { readTrace } from './playwright-trace.ts';

export const PASS_LEVELS = ['visit', 'interact', 'assert'];

export function traceLinker(map) {
  let screenAt;
  let callAt;
  return (traceFile) => {
    const { steps, requests, reason } = readTrace(traceFile);
    if (reason) return { reason };
    screenAt ??= screenFinder(map);
    callAt ??= callFinder(map);
    const screens = new Map();
    const unmatched = new Set();
    for (const { url, kind } of steps) {
      const id = screenAt(url);
      if (!id) unmatched.add(url);
      else if (PASS_LEVELS.indexOf(kind) > PASS_LEVELS.indexOf(screens.get(id))) screens.set(id, kind);
    }
    const calls = new Set(requests.map(({ method, url }) => callAt(method, url)).filter(Boolean));
    return { screens, calls, unmatched: [...unmatched] };
  };
}
