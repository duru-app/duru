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
  roleValues?: unknown;
  unreadableRoleGuards?: unknown;
  settings?: unknown;
}

export interface FlowMapScreen {
  id: string;
  path: string;
  component: string;
  dead?: boolean;
  access: FlowAccess;
  apiCalls: { endpoints?: { callId: string }[] }[];
}

export interface FlowMap {
  screens: FlowMapScreen[];
  calls?: { id: string; server: EndpointMatch }[];
  entries?: { screen: string }[];
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

export interface Flow {
  roots: FlowScreenNode[];
  unreached: FlowScreenNode[];
  summary?: FlowSummary;
}

const countOf = (tests: FlowTests['nodes'][string] | undefined): FlowCounts => {
  const c: FlowCounts = { pass: 0, fail: 0, pending: 0 };
  for (const t of tests ?? []) c[t.status] += 1;
  return c;
};

// 진입 화면에서 너비 우선으로 링크를 따라가며 화면마다 처음 발견한 위치에 한 번만 둔다.
// 이미 놓인 화면으로 가는 링크는 옮겨 그리지 않고 출발 노드의 jumps 에 남긴다.
// from 을 주면 진입 화면 대신 그 화면을 루트로 트리를 다시 만들고, 닿지 않는 화면은 모으지 않는다.
export function buildFlow(map: FlowMap, tests: FlowTests, { from }: { from?: string } = {}): Flow {
  const byId = new Map(map.screens.map((s) => [s.id, s]));
  const outgoing = new Map<string, Map<string, FlowGuard[][]>>(map.screens.map((s) => [s.id, new Map()]));
  for (const target of map.screens) {
    for (const l of target.access.links) {
      const edges = outgoing.get(l.from)!;
      if (!edges.has(target.id)) edges.set(target.id, []);
      edges.get(target.id)!.push(l.guards);
    }
  }
  // 링크마다 조건 목록 하나. 어느 한 링크의 조건만 맞아도 들어가므로 목록끼리는 「또는」이다.
  const edgeGuards = (from: string, to: string): FlowGuard[][] => {
    const all = outgoing.get(from)!.get(to)!;
    if (all.some((g) => g.length === 0)) return [];
    const seen = new Map<string, FlowGuard[]>(all.map((g) => [g.map((x) => x.guard).join(' & '), g]));
    return [...seen.values()];
  };

  const callsById = new Map((map.calls ?? []).map((c) => [c.id, c]));
  const callNode = (id: string): FlowCallNode => {
    const c = callsById.get(id)!;
    return { kind: 'call', id, label: id, server: c.server, counts: countOf(tests.nodes[id]), passed: tests.passed?.[id]?.length ?? 0 };
  };
  const callIdsOf = (s: FlowMapScreen) => [...new Set(s.apiCalls.flatMap((c) => (c.endpoints ?? []).map((e) => e.callId)).filter(Boolean))].sort();

  const accessOf = ({ roleValues, unreadableRoleGuards, settings }: FlowAccess): FlowScreenNode['access'] => ({
    ...(roleValues !== undefined ? { roleValues, unreadableRoleGuards } : {}),
    ...(settings ? { settings } : {}),
  });

  const placed = new Set();
  const screenNode = (id: string, guards: FlowGuard[][]): FlowScreenNode => {
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
          node.jumps.push({ to, label: byId.get(to)!.path, guards: edgeGuards(node.id, to) });
          continue;
        }
        placed.add(to);
        const child = screenNode(to, edgeGuards(node.id, to));
        node.children.push(child);
        queue.push(child);
      }
    }
    return roots;
  };
  const plant = (ids: string[]) => {
    const roots = ids.filter((id) => !placed.has(id)).map((id) => {
      placed.add(id);
      return screenNode(id, []);
    });
    return grow(roots);
  };

  if (from !== undefined) {
    if (!byId.has(from)) throw new Error(`unknown screen "${from}"`);
    return { roots: plant([from]), unreached: [] };
  }
  const roots = plant((map.entries ?? []).map((e) => e.screen));
  const unreached: FlowScreenNode[] = [];
  for (const s of map.screens) if (!placed.has(s.id)) unreached.push(...plant([s.id]));
  return { roots, unreached, summary: summarize([...roots, ...unreached]) };
}

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
