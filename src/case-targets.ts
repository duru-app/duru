import { compare } from './config.ts';
import type { CaseKind, CasePick } from './config.ts';
import type { Mark, MarkEntry, MarkRule } from './marks.ts';

interface TargetMap {
  screens: { id: string; path?: string }[];
  calls?: { id: string; method?: string; path?: string; screens?: string[] }[];
}

export type CaseTargetState = 'rule' | 'needed' | 'not-needed' | 'undecided';

// review 는 리뷰어를 기다리는 에이전트의 「대상 아님」이고, 그동안 state 와 mark 는 그 밑의 판정으로 정한다.
export interface CaseTarget {
  state: CaseTargetState;
  rules: number[];
  mark: Mark | null;
  review?: Mark;
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
  undecided: string[];
  review: string[];
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

export const isProposal = (m: Mark) => m.via !== undefined && m.status === 'not-needed';

export function acceptsProposal(mark: Mark, history: Mark[]) {
  const proposal = history.find((m) => m.id === mark.of);
  return proposal !== undefined && mark.status === 'not-needed' && mark.note === proposal.note;
}

export const revertIn = (history: Mark[]) => history.find((m) => m.of !== undefined && !acceptsProposal(m, history)) ?? null;

export class ProposalChanged extends Error {}

export function caseTargets(map: TargetMap, caseKinds: Record<string, CaseKind>, attached: MarkEntry[]): Record<string, KindTargets> {
  const allScreens = map.screens.map((s) => s.id);
  const allCalls = (map.calls ?? []).map((c) => c.id);
  const methods = new Map((map.calls ?? []).map((c) => [c.id, c.method]));
  const undecidedGroup = (id: string) => (!methods.has(id) ? 2 : methods.get(id) === 'GET' ? 1 : 0);
  return Object.fromEntries(Object.entries(caseKinds).map(([kind, caseKind]) => {
    const rules = rulePicks(map, caseKind);
    const sides = caseKind.picks.length
      ? { screens: caseKind.picks.some((p) => !picksCalls(p)), calls: caseKind.picks.some(picksCalls) }
      : { screens: true, calls: true };
    const byNode = new Map<string, number[]>();
    rules.forEach((r, i) => {
      for (const id of [...r.screens, ...r.calls]) byNode.set(id, [...(byNode.get(id) ?? []), i]);
    });
    const marked = new Map(attached.filter((e) => e.target.case === kind && e.current).map((e) => [e.target.node!, e]));
    const candidates = new Set([...(sides.screens ? allScreens : []), ...(sides.calls ? allCalls : [])]);
    const nodes: Record<string, CaseTarget> = {};
    const unused: Record<string, Mark> = {};
    for (const id of [...allScreens, ...allCalls]) {
      if (!candidates.has(id) && !marked.has(id)) continue;
      const picked = byNode.get(id) ?? [];
      const entry = marked.get(id);
      const review = entry && isProposal(entry.current!) ? entry.current! : null;
      const mark = (review ? entry!.history.find((m) => m.status !== undefined && !isProposal(m)) : entry?.current) ?? null;
      let target: CaseTarget;
      if (mark?.status === 'needed') target = { state: 'needed', rules: picked, mark };
      else if (mark?.status === 'not-needed' && picked.length) target = mark.rule ? { state: 'not-needed', rules: picked, mark } : { state: 'rule', rules: picked, mark: null };
      else if (mark?.status === 'not-needed' && !mark.rule && mark.note?.trim()) target = { state: 'not-needed', rules: [], mark };
      else {
        if (mark?.rule) unused[id] = mark;
        target = { state: picked.length ? 'rule' : 'undecided', rules: picked, mark: null };
      }
      if (review) target.review = review;
      if (candidates.has(id) || target.state !== 'undecided' || review) nodes[id] = target;
    }
    const inOrder = (keep: (t: CaseTarget) => boolean) => Object.keys(nodes).filter((id) => keep(nodes[id])).sort((a, b) => undecidedGroup(a) - undecidedGroup(b) || compare(a, b));
    return [kind, { sides, rules, nodes, unused, undecided: inOrder((t) => t.state === 'undecided' && !t.review), review: inOrder((t) => t.review !== undefined) }];
  }));
}

export const pickedKinds = (targets: Record<string, KindTargets>, id: string) => Object.entries(targets)
  .filter(([, t]) => ['rule', 'needed'].includes(t.nodes[id]?.state))
  .map(([kind]) => ({ tag: `case:${kind}`, kind: 'case' }));

export const kindTags = (kind: string, caseKind: CaseKind) => (caseKind.values.length ? caseKind.values.map((v) => `case:${kind}=${v}`) : [`case:${kind}`]);

export function casesWithoutTests(kind: string, caseKind: CaseKind, targets: KindTargets, tests: Record<string, { cases?: string[] }[]>) {
  return Object.entries(targets.nodes)
    .filter(([, t]) => t.state === 'rule' || t.state === 'needed')
    .map(([node, target]) => ({ node, target, tags: kindTags(kind, caseKind).filter((tag) => !(tests[node] ?? []).some((t) => t.cases?.includes(tag))) }))
    .filter((c) => c.tags.length);
}

export function commandCaseRule(map: TargetMap, caseKinds: Record<string, CaseKind>, attached: MarkEntry[], { kind, node, status, note }: { kind: string; node: string; status: string; note: string }) {
  if (!Object.hasOwn(caseKinds, kind)) {
    const kinds = Object.keys(caseKinds);
    throw new Error(`"${kind}" is not a kind in caseKinds (${kinds.length ? `it has ${kinds.join(', ')}` : 'it has none'})`);
  }
  const isCall = (map.calls ?? []).some((c) => c.id === node);
  if (!isCall && !map.screens.some((s) => s.id === node)) throw new Error(`${node} is no screen or call on the map`);
  const entry = attached.find((e) => e.target.case === kind && e.target.node === node);
  const current = entry?.current ?? null;
  const revert = entry ? revertIn(entry.history) : null;
  if (revert) {
    throw new Error(`${revert.author} took back the agent's not-needed for ${kind} on ${node} on ${revert.date.slice(0, 10)}, so only a person decides it now`);
  }
  const held = current && isProposal(current) ? entry!.history.find((m) => m.status !== undefined && !isProposal(m)) : current;
  if (held && held.via === undefined && status !== 'not-needed') {
    throw new Error(`${held.author} marked ${kind} ${held.status} on ${node} on ${held.date.slice(0, 10)}, and duru case does not change a person's mark`);
  }
  if (status !== 'not-needed') return undefined;
  const rule = exclusionOf(() => map, caseKinds, { target: { node, case: kind }, status, note });
  if (!note.trim()) throw new Error(`not-needed needs a note saying why ${kind} need not be tested on ${node}`);
  const { sides } = caseTargets(map, { [kind]: caseKinds[kind] }, [])[kind];
  if (!(isCall ? sides.calls : sides.screens) && !current) {
    throw new Error(`the rules of ${kind} pick only ${isCall ? 'screens' : 'calls'}, so ${node} is no candidate, and not-needed there only takes back a mark, which it does not have`);
  }
  return rule;
}

export function answerProposal(map: TargetMap, caseKinds: Record<string, CaseKind>, attached: MarkEntry[], { kind, node, of, answer }: { kind: string; node: string; of: string; answer: 'accept' | 'revert' }) {
  const entry = attached.find((e) => e.target.case === kind && e.target.node === node);
  const current = entry?.current;
  if (!current || !isProposal(current)) throw new ProposalChanged(`no agent not-needed for ${kind} on ${node} waits for a reviewer any more`);
  if (current.id !== of) throw new ProposalChanged(`the agent wrote ${kind} on ${node} again after the page read it`);
  const target = { node, case: kind };
  if (answer === 'accept') return { target, status: 'not-needed', note: current.note, rule: exclusionOf(() => map, caseKinds, { target, status: 'not-needed', note: current.note }), of };
  const under = entry!.history.find((m) => m.status !== undefined && m.via === undefined);
  return { target, status: under?.status ?? 'not-needed', note: under?.note ?? '', rule: under?.rule, of };
}
