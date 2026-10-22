import fs from 'node:fs';
import path from 'node:path';

export const BASELINE_TESTS = [
  { format: 'playwright', path: 'releases/1.5.0/playwright', depth: 'ui' },
  { format: 'junit', path: 'releases/1.5.0/junit', depth: 'api' },
  { format: 'vitest', path: 'releases/1.5.0/vitest', depth: 'code' },
  { format: 'verdict', path: 'releases/1.5.0/verdict', depth: 'api' },
];

const KEPT_AT = new Date('2026-10-01T00:00:00Z');

export function editJson(file: string, change: (json: any) => void) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(json);
  fs.writeFileSync(file, JSON.stringify(json));
}

function keepTimes(folder: string) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) fs.utimesSync(path.join(entry.parentPath, entry.name), KEPT_AT, KEPT_AT);
  }
}

// 기준은 지금 결과를 베껴 시험 둘을 통과로 바꾸고 하나를 지운 것이고, 지금 결과에서는 내보내기 보고서를 지운다.
export function keepRelease(copy: string) {
  for (const folder of ['playwright', 'junit', 'vitest', 'verdict']) fs.cpSync(path.join(copy, 'results', folder), path.join(copy, 'releases/1.5.0', folder), { recursive: true });
  const kept = (file: string) => path.join(copy, 'releases/1.5.0', file);
  editJson(kept('vitest/client-unit.json'), (report) => {
    for (const r of report.testResults) for (const a of r.assertionResults) if (a.title === 'lists the documents it is given') a.status = 'passed';
  });
  editJson(kept('playwright/e2e.json'), (report) => {
    const lab = report.suites.flatMap((s: any) => s.specs).find((s: any) => s.title.startsWith('opens the lab'));
    for (const t of lab.tests) t.status = 'expected';
  });
  editJson(kept('vitest/unit.json'), (report) => {
    for (const r of report.testResults) r.assertionResults = r.assertionResults.filter((a: any) => a.title !== 'remembers the last user');
  });
  keepTimes(path.join(copy, 'releases/1.5.0'));
  fs.rmSync(path.join(copy, 'results/playwright/export.json'));
}
