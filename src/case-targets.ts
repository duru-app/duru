import type { CaseKind, CasePick } from './config.ts';
import type { Mark, MarkEntry, MarkRule } from './marks.ts';

interface TargetMap {
  screens: { id: string; path?: string }[];
  calls?: { id: string; method?: string; path?: string; screens?: string[] }[];
}

export type CaseTargetState = 'rule' | 'needed' | 'not-needed' | 'undecided';

export interface CaseTarget {
  state: CaseTargetState;
  rules: number[];
  mark: Mark | null;
}

export interface RulePicks {
  pick: CasePick;
  screens: string[];
  calls: string[];
}

export interface KindTargets {
  sides: { screens: boolean; calls: boolean };
  rules: RulePicks[];
  nodes: Record<string, CaseTarget>;
  unused: Record<string, Mark>;
}

const parts = (p: string) => p.split('/').filter(Boolean);

export function matchesPattern(pattern: string, path: string) {
  const pat = parts(pattern);
  const val = parts(path);
  const from = (i: number, j: number): boolean => {
    if (i === pat.length) return j === val.length;
    if (pat[i] === '**') {
      for (let k = j; k <= val.length; k++) if (from(i + 1, k)) return true;
      return false;
    }
    return j < val.length && (pat[i] === '*' || pat[i] === val[j]) && from(i + 1, j + 1);
  };
  return from(0, 0);
}

export const picksCalls = (pick: CasePick) => pick.methods !== undefined || pick.api !== undefined;

export function rulePicks(map: TargetMap, kind: CaseKind): RulePicks[] {
  return kind.picks.map((pick) => {
    const screens = map.screens.filter((s) => pick.screen === undefined || (typeof s.path === 'string' && matchesPattern(pick.screen, s.path))).map((s) => s.id);
    if (!picksCalls(pick)) return { pick, screens, calls: [] };
    const on = new Set(screens);
    const calls = (map.calls ?? []).filter((c) => (pick.screen === undefined || (c.screens ?? []).some((id) => on.has(id)))
      && (pick.methods === undefined || pick.methods.includes(c.method!))
      && (pick.api === undefined || (typeof c.path === 'string' && matchesPattern(pick.api, c.path)))).map((c) => c.id);
    return { pick, screens: [], calls };
  });
}

export function ruleOf(map: TargetMap, kind: CaseKind | undefined, node: string): MarkRule | null {
  if (!kind?.picks.length) return null;
  const index = rulePicks(map, kind).findIndex((r) => r.screens.includes(node) || r.calls.includes(node));
  return index < 0 ? null : { index, pick: kind.picks[index] };
}

export function exclusionOf(mapOf: () => TargetMap, caseKinds: Record<string, CaseKind>, input: { target?: unknown; targets?: unknown; status?: unknown; note?: unknown }) {
  const only = input.target ?? (Array.isArray(input.targets) && input.targets.length === 1 ? input.targets[0] : undefined);
  const { node, case: kind } = (typeof only === 'object' && only !== null ? only : {}) as Record<string, unknown>;
  if (input.status !== 'not-needed' || typeof node !== 'string' || typeof kind !== 'string' || !Object.hasOwn(caseKinds, kind) || !caseKinds[kind].picks.length) return undefined;
  const rule = ruleOf(mapOf(), caseKinds[kind], node);
  if (!rule) return undefined;
  if (typeof input.note !== 'string' || !input.note.trim()) {
    throw new Error(`a rule picks ${node} for ${kind} (caseKinds.${kind}.picks[${rule.index}]), so taking it out needs a note saying why`);
  }
  return rule;
}

export function caseTargets(map: TargetMap, caseKinds: Record<string, CaseKind>, attached: MarkEntry[]): Record<string, KindTargets> {
  const allScreens = map.screens.map((s) => s.id);
  const allCalls = (map.calls ?? []).map((c) => c.id);
  return Object.fromEntries(Object.entries(caseKinds).map(([kind, caseKind]) => {
    const rules = rulePicks(map, caseKind);
    const sides = caseKind.picks.length
      ? { screens: caseKind.picks.some((p) => !picksCalls(p)), calls: caseKind.picks.some(picksCalls) }
      : { screens: true, calls: true };
    const byNode = new Map<string, number[]>();
    rules.forEach((r, i) => {
      for (const id of [...r.screens, ...r.calls]) byNode.set(id, [...(byNode.get(id) ?? []), i]);
    });
    const marked = new Map(attached.filter((e) => e.target.case === kind && e.current).map((e) => [e.target.node!, e.current!]));
    const candidates = new Set([...(sides.screens ? allScreens : []), ...(sides.calls ? allCalls : [])]);
    const nodes: Record<string, CaseTarget> = {};
    const unused: Record<string, Mark> = {};
    for (const id of [...allScreens, ...allCalls]) {
      if (!candidates.has(id) && !marked.has(id)) continue;
      const picked = byNode.get(id) ?? [];
      const mark = marked.get(id) ?? null;
      let target: CaseTarget;
      if (mark?.status === 'needed') target = { state: 'needed', rules: picked, mark };
      else if (mark?.status === 'not-needed' && picked.length) target = mark.rule ? { state: 'not-needed', rules: picked, mark } : { state: 'rule', rules: picked, mark: null };
      else if (mark?.status === 'not-needed' && !mark.rule) target = { state: 'not-needed', rules: [], mark };
      else {
        if (mark) unused[id] = mark;
        target = { state: picked.length ? 'rule' : 'undecided', rules: picked, mark: null };
      }
      if (candidates.has(id) || target.state !== 'undecided') nodes[id] = target;
    }
    return [kind, { sides, rules, nodes, unused }];
  }));
}

export const pickedKinds = (targets: Record<string, KindTargets>, id: string) => Object.entries(targets)
  .filter(([, t]) => ['rule', 'needed'].includes(t.nodes[id]?.state))
  .map(([kind]) => ({ tag: `case:${kind}`, kind: 'case' }));
