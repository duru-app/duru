import { callFinder, screenFinder } from './address-match.mjs';
import { readTrace } from './playwright-trace.mjs';

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
    for (const { url, kind } of steps) {
      const id = screenAt(url);
      if (id && PASS_LEVELS.indexOf(kind) > PASS_LEVELS.indexOf(screens.get(id))) screens.set(id, kind);
    }
    const calls = new Set(requests.map(({ method, url }) => callAt(method, url)).filter(Boolean));
    return { screens, calls };
  };
}
