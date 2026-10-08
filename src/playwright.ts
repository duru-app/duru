import fs from 'node:fs';
import path from 'node:path';
import type { TestStatus } from './verdict.ts';

export interface PlaywrightResult {
  title: string;
  file: string;
  line: number;
  project: string | null;
  tags: string[];
  status: TestStatus;
  trace: string | null;
}

const STATUS: Record<string, TestStatus> = { expected: 'pass', flaky: 'pass', unexpected: 'fail', skipped: 'pending' };

// 결과를 다른 폴더로 옮겨 두고 같은 자리에서 다시 돌렸을 수 있어, 보고서 옆의 사본을 적힌 경로보다 먼저 찾는다.
// 파일 이름은 모든 테스트가 같으므로 테스트 폴더 이름까지는 맞아야 그 테스트의 것으로 본다.
function tracePath(reportFile: string, results: any): string | null {
  const recorded = results?.at(-1)?.attachments?.find((a: any) => a.name === 'trace' && a.path)?.path;
  if (!recorded) return null;
  const parts = recorded.split(/[\\/]/).filter((part: string) => part && part !== '.' && part !== '..');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const copy = path.join(path.dirname(reportFile), ...parts.slice(i));
    if (fs.existsSync(copy)) return copy;
  }
  return recorded;
}

// Playwright 보고서가 아닌 JSON(suites 배열이 없음)이면 null 을 돌려준다.
export function readPlaywright(file: string): PlaywrightResult[] | null {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read Playwright report ${file}: ${(err as Error).message}`);
  }
  if (!Array.isArray(report?.suites)) return null;

  const out: PlaywrightResult[] = [];
  const walk = (suite: any, titles: string[]): void => {
    for (const spec of suite.specs ?? []) {
      const tags = new Set<string>((spec.tags ?? []).map((t: string) => t.replace(/^@/, '')));
      for (const t of [...titles, spec.title].join(' ').match(/@\S+/g) ?? []) tags.add(t.slice(1));
      for (const test of spec.tests ?? []) {
        out.push({
          title: [...titles, spec.title].join(' › '),
          file: spec.file,
          line: spec.line,
          project: test.projectName ?? null,
          tags: [...tags],
          status: STATUS[test.status] ?? 'pending',
          trace: tracePath(file, test.results),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  // 최상위 suite 는 파일이라 제목에 넣지 않는다.
  for (const top of report.suites) walk(top, []);
  return out;
}
