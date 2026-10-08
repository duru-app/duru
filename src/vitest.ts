import fs from 'node:fs';
import type { TestStatus } from './verdict.ts';

export interface VitestResult {
  title: string;
  file: string;
  line: number | null;
  project: null;
  tags: string[];
  status: TestStatus;
}

const STATUS: Record<string, TestStatus> = { passed: 'pass', failed: 'fail' };

// Vitest 보고서가 아닌 JSON(testResults 배열이 없음)이면 null 을 돌려준다.
export function readVitest(file: string): VitestResult[] | null {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read Vitest report ${file}: ${(err as Error).message}`);
  }
  if (!Array.isArray(report?.testResults)) return null;

  const out: VitestResult[] = [];
  for (const result of report.testResults) {
    for (const a of result.assertionResults ?? []) {
      const titles = [...(a.ancestorTitles ?? []), a.title];
      const tags = new Set<string>((a.tags ?? []).map((t: string) => t.replace(/^@/, '')));
      for (const t of titles.join(' ').match(/@\S+/g) ?? []) tags.add(t.slice(1));
      out.push({
        title: titles.join(' › '),
        file: result.name,
        line: a.location?.line ?? null,
        project: null,
        tags: [...tags],
        status: STATUS[a.status] ?? 'pending',
      });
    }
  }
  return out;
}
