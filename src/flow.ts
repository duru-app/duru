import type { SettingSource } from './access.ts';
import type { EndpointMatch } from './server.ts';

export interface FlowCounts {
  pass: number;
  fail: number;
  pending: number;
}

export interface FlowGuard {
  guard: string;
}

export interface FlowAccess {
  restricted: boolean;
  kinds: string[];
  links: { from: string; guards: FlowGuard[] }[];
  roleValues?: string[] | null;
  unreadableRoleGuards?: string[];
  settings?: SettingSource[];
}

export interface FlowMapScreen {
  id: string;
  path: string;
  component: string;
  dead?: boolean;
  access: FlowAccess;
  apiCalls: { endpoints?: { callId: string | null }[] | null }[];
}

export interface FlowMap {
  screens: FlowMapScreen[];
  calls?: { id: string; server: EndpointMatch }[];
  entries?: { screen: string }[];
  moves?: { from: string; to: string; reason: string }[];
}

export interface FlowTests {
  nodes: Record<string, { status: keyof FlowCounts }[]>;
  passed?: Record<string, unknown[]>;
  importers?: Record<string, unknown[]>;
}

export interface FlowCallNode {
  kind: 'call';
  id: string;
  label: string;
  server: EndpointMatch;
  counts: FlowCounts;
  passed: number;
}

export interface FlowJump {
  to: string;
  label: string;
  guards: FlowGuard[][];
  moved?: string[];
}

export interface FlowScreenNode {
  kind: 'screen';
  id: string;
  label: string;
  component: string;
  counts: FlowCounts;
  imported: number;
  passed: number;
  dead: boolean;
  restricted: boolean;
  kinds: string[];
  access: Partial<Pick<FlowAccess, 'roleValues' | 'unreadableRoleGuards' | 'settings'>>;
  guards: FlowGuard[][];
  moved?: string[];
  children: FlowScreenNode[];
  calls: FlowCallNode[];
  jumps: FlowJump[];
}

export interface FlowSummary {
  screens: number;
  tested: number;
  failing: number;
  importedOnly: number;
}

export interface FlowGroup {
  name: string;
  screens: string[];
}

export interface Flow {
  roots: FlowScreenNode[];
  unreached: FlowScreenNode[];
  groups: FlowGroup[];
  folding: boolean;
  summary: FlowSummary;
}

const GROUP_FROM = 100;
const GROUP_MAX = 20;

const countOf = (tests: FlowTests['nodes'][string] | undefined): FlowCounts => {
  const c: FlowCounts = { pass: 0, fail: 0, pending: 0 };
  for (const t of tests ?? []) c[t.status] += 1;
  return c;
};

// 진입 화면에서 너비 우선으로 링크와 설정의 moves 를 따라가며 화면마다 처음 발견한 위치에 한 번만 둔다.
// 이미 놓인 화면으로 가는 링크와 이동은 옮겨 그리지 않고 출발 노드의 jumps 에 남긴다.
export function buildFlow(map: FlowMap, tests: FlowTests): Flow {
  const byId = new Map(map.screens.map((s) => [s.id, s]));
  const outgoing = new Map<string, Map<string, { links: FlowGuard[][]; moves: string[] }>>(map.screens.map((s) => [s.id, new Map()]));
  const edgeTo = (from: string, to: string) => {
    const edges = outgoing.get(from)!;
    if (!edges.has(to)) edges.set(to, { links: [], moves: [] });
    return edges.get(to)!;
  };
  for (const target of map.screens) {
    for (const l of target.access.links) edgeTo(l.from, target.id).links.push(l.guards);
  }
  for (const m of map.moves ?? []) edgeTo(m.from, m.to).moves.push(m.reason);
  // 링크마다 조건 목록 하나. 어느 한 링크의 조건만 맞아도 들어가므로 목록끼리는 「또는」이다.
  const edgeOf = (from: string, to: string): { guards: FlowGuard[][]; moved?: string[] } => {
    const { links, moves } = outgoing.get(from)!.get(to)!;
    if (links.some((g) => g.length === 0)) return { guards: [] };
    if (moves.length) return { guards: [], moved: moves };
    const seen = new Map<string, FlowGuard[]>(links.map((g) => [g.map((x) => x.guard).join(' & '), g]));
    return { guards: [...seen.values()] };
  };

  const callsById = new Map((map.calls ?? []).map((c) => [c.id, c]));
  const callNode = (id: string): FlowCallNode => {
    const c = callsById.get(id)!;
    return { kind: 'call', id, label: id, server: c.server, counts: countOf(tests.nodes[id]), passed: tests.passed?.[id]?.length ?? 0 };
  };
  const callIdsOf = (s: FlowMapScreen) => [...new Set(s.apiCalls.flatMap((c) => (c.endpoints ?? []).map((e) => e.callId)).filter((id): id is string => Boolean(id)))].sort();

  const accessOf = ({ roleValues, unreadableRoleGuards, settings }: FlowAccess): FlowScreenNode['access'] => ({
    ...(roleValues !== undefined ? { roleValues, unreadableRoleGuards } : {}),
    ...(settings ? { settings } : {}),
  });

  const placed = new Set();
  const screenNode = (id: string, { guards, moved }: ReturnType<typeof edgeOf>): FlowScreenNode => {
    const s = byId.get(id)!;
    return {
      kind: 'screen',
      id,
      label: s.path,
      component: s.component,
      counts: countOf(tests.nodes[id]),
      imported: tests.importers?.[id]?.length ?? 0,
      passed: tests.passed?.[id]?.length ?? 0,
      dead: Boolean(s.dead),
      restricted: s.access.restricted,
      kinds: s.access.kinds,
      access: accessOf(s.access),
      guards,
      ...(moved ? { moved } : {}),
      children: [],
      calls: callIdsOf(s).map(callNode),
      jumps: [],
    };
  };
  const grow = (roots: FlowScreenNode[]) => {
    const queue = [...roots];
    while (queue.length) {
      const node = queue.shift()!;
      for (const to of [...outgoing.get(node.id)!.keys()].sort((a, b) => map.screens.indexOf(byId.get(a)!) - map.screens.indexOf(byId.get(b)!))) {
        if (placed.has(to)) {
          node.jumps.push({ to, label: byId.get(to)!.path, ...edgeOf(node.id, to) });
          continue;
        }
        placed.add(to);
        const child = screenNode(to, edgeOf(node.id, to));
        node.children.push(child);
        queue.push(child);
      }
    }
    return roots;
  };
  const plant = (ids: string[]) => {
    const roots = [...new Set(ids)].filter((id) => !placed.has(id)).map((id) => {
      placed.add(id);
      return screenNode(id, { guards: [] });
    });
    return grow(roots);
  };

  const roots = plant((map.entries ?? []).map((e) => e.screen));
  const unreached: FlowScreenNode[] = [];
  for (const s of map.screens) if (!placed.has(s.id)) unreached.push(...plant([s.id]));
  const folding = map.screens.length > GROUP_FROM;
  const groups = folding ? addressGroups(roots.filter((r) => !r.children.length)) : [];
  return { roots, unreached, groups, folding, summary: summarize([...roots, ...unreached]) };
}

export function addressGroups(screens: Pick<FlowScreenNode, 'id' | 'label'>[]): FlowGroup[] {
  const parts = new Map(screens.map((s) => [s.id, s.label.split('/').filter(Boolean)]));
  const groups: string[][] = [];
  const split = (ids: string[], depth: number) => {
    const buckets = new Map<string, string[]>();
    for (const id of ids) {
      const key = parts.get(id)!.slice(0, depth).join('/');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(id);
    }
    for (const bucket of buckets.values()) {
      if (bucket.length > GROUP_MAX && bucket.some((id) => parts.get(id)!.length > depth)) split(bucket, depth + 1);
      else if (bucket.length > 1) groups.push(bucket);
    }
  };
  split(screens.map((s) => s.id), 1);
  const order = new Map(screens.map((s, i) => [s.id, i]));
  return groups
    .sort((a, b) => order.get(a[0])! - order.get(b[0])!)
    .map((ids) => ({ name: `/${shared(ids.map((id) => parts.get(id)!)).join('/')}`, screens: ids }));
}

const shared = (lists: string[][]) => lists[0].slice(0, lists.reduce((n, l) => {
  let k = 0;
  while (k < n && l[k] === lists[0][k]) k += 1;
  return k;
}, lists[0].length));

// 「불러옴」과 「지나감」은 태그로 확정한 연결이 아니므로 테스트 있는 화면과 실패한 화면을 셀 때 넣지 않는다.
function summarize(trees: FlowScreenNode[]): FlowSummary {
  const screens: FlowScreenNode[] = [];
  const walk = (n: FlowScreenNode): void => { screens.push(n); n.children.forEach(walk); };
  trees.forEach(walk);
  const tagged = (n: FlowScreenNode) => n.counts.pass + n.counts.fail + n.counts.pending > 0;
  return {
    screens: screens.length,
    tested: screens.filter(tagged).length,
    failing: screens.filter((n) => n.counts.fail > 0).length,
    importedOnly: screens.filter((n) => !tagged(n) && n.imported + n.passed > 0).length,
  };
}
