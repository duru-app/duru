import fs from 'node:fs';
import path from 'node:path';

const hasIds = (list: unknown) => Array.isArray(list) && list.every((n) => typeof n?.id === 'string');
const recordsConditions = ({ access }: any) => typeof access === 'object' && access !== null && Array.isArray(access.route) && Array.isArray(access.links)
  && access.route.every((g: any) => !g.kinds?.includes('role') || 'roles' in g);

export function readBaseline(file: string) {
  if (!fs.existsSync(file)) throw new Error(`baselineMap ${file} does not exist`);
  let map;
  try {
    map = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err: any) {
    throw new Error(`baselineMap ${file} could not be read: ${err.message}`);
  }
  if (!hasIds(map?.screens) || !hasIds(map?.calls)) throw new Error(`baselineMap ${file} is not a duru map with screens and calls`);
  if (!map.screens.every(recordsConditions)) {
    throw new Error(`baselineMap ${file} was built by a duru that did not record the roles each route guard lets through — build that version's map again with this duru`);
  }
  return map;
}

const sorted = (list: Iterable<string>) => [...new Set(list)].sort();
const byGuard = (a: { guard: string }, b: { guard: string }) => (a.guard < b.guard ? -1 : a.guard > b.guard ? 1 : 0);

// 화면을 여는 데 걸린 것만 견준다. 가드가 적힌 줄이나 어느 화면에서 들어오는 링크인지는 조건이 아니다.
function conditionOf({ access }: any) {
  return {
    restricted: Boolean(access.restricted),
    kinds: sorted(access.kinds ?? []),
    route: access.route.map((g: any) => ({ guard: g.guard, kinds: sorted(g.kinds ?? []), roles: g.roles == null ? null : sorted(g.roles) })).sort(byGuard),
    links: sorted(access.links.flatMap((l: any) => (l.guards ?? []).map((g: any) => (typeof g === 'string' ? g : g.guard)))),
  };
}

function callsOfScreens(calls: any[]) {
  const byScreen = new Map<string, string[]>();
  for (const c of calls) for (const s of Array.isArray(c.screens) ? c.screens : []) byScreen.set(s, [...(byScreen.get(s) ?? []), c.id]);
  return byScreen;
}

// 한쪽 맵이라도 서버 목록 없이 만들었으면 서버 목록과 맞춰 본 결과가 없으니, 그 호출은 바뀐 것으로 치지 않는다.
export function compareMaps(baseline: any, map: any) {
  const byId = (nodes: any[]) => new Map<string, any>(nodes.map((n) => [n.id, n]));
  const [oldScreens, newScreens, oldCalls, newCalls] = [baseline.screens, map.screens, baseline.calls, map.calls].map(byId);
  const [oldCallsOf, newCallsOf] = [baseline.calls, map.calls].map(callsOfScreens);
  const conditions = [];
  const screenCalls = [];
  for (const id of sorted(newScreens.keys())) {
    if (!oldScreens.has(id)) continue;
    const [before, after] = [oldScreens.get(id), newScreens.get(id)].map(conditionOf);
    // 두 맵 모두 restricted 가 아니면 그 화면을 막는 조건이 없다는 뜻이므로, 링크의 가드가 생기거나 없어지거나 바뀐 것은 세지 않는다.
    if ((before.restricted || after.restricted) && JSON.stringify(before) !== JSON.stringify(after)) conditions.push({ id, before, after });
    const [was, now] = [oldCallsOf.get(id) ?? [], newCallsOf.get(id) ?? []];
    const added = sorted(now.filter((c) => !was.includes(c)));
    const removed = sorted(was.filter((c) => !now.includes(c)));
    if (added.length || removed.length) screenCalls.push({ id, added, removed });
  }
  const server = [];
  for (const id of sorted(newCalls.keys())) {
    const [before, after] = [oldCalls.get(id), newCalls.get(id)].map((c) => c?.server?.status ?? null);
    if (before && after && before !== after && before !== 'unchecked' && after !== 'unchecked') server.push({ id, before, after });
  }
  return {
    screens: {
      added: sorted(newScreens.keys()).filter((id) => !oldScreens.has(id)),
      removed: sorted(oldScreens.keys()).filter((id) => !newScreens.has(id)).map((id) => ({ id, path: oldScreens.get(id).path ?? null, component: oldScreens.get(id).component ?? null })),
      conditions,
      calls: screenCalls,
    },
    calls: {
      added: sorted(newCalls.keys()).filter((id) => !oldCalls.has(id)),
      removed: sorted(oldCalls.keys()).filter((id) => !newCalls.has(id)),
      server,
    },
  };
}

type BaselineChanges = ReturnType<typeof compareMaps>;

export const baselineLine = (file: string, { screens, calls }: BaselineChanges) =>
  `changes since ${file} | screens new ${screens.added.length} removed ${screens.removed.length} condition ${screens.conditions.length} calls-changed ${screens.calls.length} | calls new ${calls.added.length} removed ${calls.removed.length} server ${calls.server.length}`;

export const baselineLabel = (file: string) => path.basename(path.dirname(file));
