import { callFinder, pathOf, screenFinder } from './address-match.ts';
import { readTrace } from './playwright-trace.ts';
import type { StepInput } from './stories.ts';

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
    const order: string[] = [];
    const inputs: StepInput[][] = [];
    let skipped = 0;
    for (const { url, kind, input, inputSkipped } of steps) {
      const id = screenAt(url);
      const step = id ?? pathOf(url);
      if (step && step !== order.at(-1)) {
        order.push(step);
        inputs.push([]);
      }
      if (input && step) inputs.at(-1)!.push(input);
      else if (input || inputSkipped) skipped += 1;
      if (!id) unmatched.add(url);
      else if (PASS_LEVELS.indexOf(kind) > PASS_LEVELS.indexOf(screens.get(id)!)) screens.set(id, kind);
    }
    const calls = new Set(requests.map(({ method, url }) => callAt!(method, url)).filter(Boolean) as string[]);
    return { screens, calls, unmatched: [...unmatched], order, inputs, skipped };
  };
}
