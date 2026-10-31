import { callFinder } from './address-match.ts';
import type { SentRequests } from './request-options.ts';

export const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function markUnrecorded(map: any, sent: SentRequests[]): { calls: number; screens: number } {
  const callAt = callFinder(map);
  const recorded = new Set<string>();
  for (const t of sent) {
    for (const { method, url } of t.requests) {
      const id = callAt(method, url);
      if (id) recorded.add(id);
    }
  }
  const unrecorded = (map.calls ?? []).filter((c: any) => WRITES.has(c.method) && c.screens.length && !recorded.has(c.id));
  for (const call of unrecorded) call.unrecorded = true;
  return { calls: unrecorded.length, screens: new Set(unrecorded.flatMap((c: any) => c.screens)).size };
}
