import { testRef } from './judgments.ts';
import type { Part } from './marks.ts';

interface LinkedTest {
  title: string;
  file: string | null;
  line?: number | null;
  source: string;
  status: string;
  testFile?: string;
  detail?: string;
  level?: string;
}

type ByNode = Record<string, LinkedTest[]> | undefined;

export interface PartContext {
  tests: { nodes?: ByNode; importers?: ByNode; passed?: ByNode };
}

export interface TestPlace {
  file: string | null;
  line: number | null;
  source: string;
  status: string;
  relation: string;
  detail?: string;
}

const STATUS_RANK: Record<string, number> = { pass: 0, pending: 1, fail: 2 };

const relationOf = (list: string, t: LinkedTest) => (list === 'nodes' ? 'tagged' : list === 'importers' ? 'imported' : t.level === 'call' ? 'called' : 'passed');

export function locatePart({ node, part }: { node?: string; part?: Part }, { tests }: PartContext): TestPlace | null {
  const wanted = JSON.stringify(part!.key);
  for (const list of ['nodes', 'importers', 'passed'] as const) {
    const found = (tests[list]?.[node!] ?? []).filter((t) => JSON.stringify(testRef(t)) === wanted);
    if (!found.length) continue;
    const [t] = found;
    const status = found.reduce((worst, x) => (STATUS_RANK[x.status] > STATUS_RANK[worst] ? x.status : worst), t.status);
    return { file: t.testFile ?? t.file, line: t.line ?? null, source: t.source, status, relation: relationOf(list, t), ...(t.detail && { detail: t.detail }) };
  }
  return null;
}
