import { callFinder } from './address-match.ts';
import { readTrace } from './playwright-trace.ts';
import type { SentTrace } from './request-options.ts';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// 읽지 못한 trace 는 건너뛰므로, 그 trace 에만 있던 호출도 기록 없음이 된다.
export function markUnrecorded(map: any, sent: SentTrace[]): { calls: number; screens: number } {
  const callAt = callFinder(map);
  const recorded = new Set<string>();
  for (const t of sent) {
    const trace = readTrace(t.trace);
    if ('reason' in trace) continue;
    for (const { method, url } of trace.requests) {
      const id = callAt(method, url);
      if (id) recorded.add(id);
    }
  }
  const unrecorded = (map.calls ?? []).filter((c: any) => WRITES.has(c.method) && c.screens.length && !recorded.has(c.id));
  for (const call of unrecorded) call.unrecorded = true;
  return { calls: unrecorded.length, screens: new Set(unrecorded.flatMap((c: any) => c.screens)).size };
}
