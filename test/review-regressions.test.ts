import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareTests } from '../src/baseline-tests.ts';
import { loadConfig } from '../src/config.ts';
import { addJudgment } from '../src/judgments.ts';
import { callRegressions, startReviewServer } from '../src/review.ts';
import type { PageData } from '../src/review.ts';
import { CLI, FIXTURE, signer, TRACED, withServer } from './review-helpers.ts';

const RELEASE = 'releases/1.5.0';
const BASELINE_TESTS = TRACED.tests.map((t) => ({ ...t, path: t.path.replace(/^results/, RELEASE) }));
const MEMBER_PAGES = { source: 'results/playwright-traced/calls.json', file: 'calls.spec.ts', title: 'turns the pages of the member list' };

type Release = { copy: string; configFile: string; rebuilt: string; setConfig: (change: Record<string, unknown>) => void };

function editJson(file: string, change: (json: any) => void) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(json);
  fs.writeFileSync(file, JSON.stringify(json));
}

const specsIn = (suites: any[]): any[] => suites.flatMap((s) => [...(s.specs ?? []), ...specsIn(s.suites ?? [])]);
const setStatus = (file: string, title: string, status: string) => editJson(file, (report) => {
  const spec = specsIn(report.suites).find((s) => s.title.startsWith(title));
  assert.ok(spec, `${file} has ${title}`);
  for (const t of spec.tests) t.status = status;
});

// 기준은 지금 결과를 베낀 것에서 시험 셋을 통과로 바꾸고 지금은 없는 시험 하나를 더한 것이다.
// 지금 결과에서는 trace 로 붙은 시험 넷을 실패로 바꾸고 내보내기 보고서를 지운다.
function keepRelease(copy: string) {
  for (const folder of ['playwright', 'junit', 'vitest', 'verdict', 'playwright-traced']) fs.cpSync(path.join(copy, 'results', folder), path.join(copy, RELEASE, folder), { recursive: true });
  const kept = (file: string) => path.join(copy, RELEASE, file);
  editJson(kept('vitest/client-unit.json'), (report) => {
    for (const r of report.testResults) for (const a of r.assertionResults) if (a.title === 'lists the documents it is given') a.status = 'passed';
  });
  setStatus(kept('playwright/e2e.json'), 'opens the lab', 'expected');
  setStatus(kept('playwright/e2e.json'), 'rename is refused by the server', 'expected');
  editJson(kept('playwright/e2e.json'), (report) => {
    const home = report.suites.find((s: any) => s.file === 'home.spec.ts');
    home.specs.push({ title: 'shows the lab banner @screen:/lab#Lab', file: 'home.spec.ts', line: 40, tests: [{ projectName: 'chromium', status: 'expected' }] });
  });
  const now = (file: string) => path.join(copy, 'results', file);
  setStatus(now('playwright-traced/visits.json'), 'opens home and then help', 'unexpected');
  setStatus(now('playwright-traced/visits.json'), 'presses the button on home', 'unexpected');
  setStatus(now('playwright-traced/calls.json'), 'reads a document from the server', 'unexpected');
  setStatus(now('playwright-traced/calls.json'), MEMBER_PAGES.title, 'unexpected');
  fs.rmSync(now('playwright/export.json'));
}

async function withRelease(fn: (release: Release) => Promise<void>, { map = false } = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const setConfig = (change: Record<string, unknown>) => fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ...change }));
    setConfig(TRACED);
    const rebuild = () => execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    if (map) {
      rebuild();
      editJson(path.join(copy, 'out/map.json'), (m) => { m.screens = m.screens.filter((s: any) => s.id !== '/lab#Lab'); });
      fs.mkdirSync(path.join(copy, RELEASE), { recursive: true });
      fs.copyFileSync(path.join(copy, 'out/map.json'), path.join(copy, RELEASE, 'map.json'));
      setConfig({ baselineMap: `${RELEASE}/map.json` });
    }
    keepRelease(copy);
    addJudgment(loadConfig(configFile).judgmentsDir, { test: MEMBER_PAGES, node: 'GET:/api/v1/member/list', kind: 'hand-over', author: 'reviewer' });
    setConfig({ baselineTests: BASELINE_TESTS });
    await fn({ copy, configFile, rebuilt: rebuild(), setConfig });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const pageData = (configFile: string) => withServer(loadConfig(configFile), 'reviewer', async (base) => (await (await fetch(`${base}/api/data`)).json()) as PageData);

test('the review page data carries the comparison with baselineTests and its folder, with the counts of the rebuild line, and none without it', async () => {
  await withRelease(async ({ configFile, rebuilt, setConfig }) => {
    const line = rebuilt.split('\n').find((l) => l.startsWith('test results since '))!;
    const [, compared, fail, pending, off, only, fresh] = line.match(/compared (\d+) \| pass→fail (\d+) pass→pending (\d+) \| not on a screen or call now (\d+) \| only in baseline (\d+) \| only now (\d+)$/)!.map(Number);
    assert.deepEqual([fail, pending, only], [6, 1, 6]);
    const data = await pageData(configFile);
    const c = data.baselineTests!;
    assert.equal(c.folder, RELEASE);
    assert.equal(c.label, '1.5.0');
    assert.ok(c.results.some((r) => r.result === `${RELEASE}/playwright/e2e.json`));
    const changed = (change: string) => c.regressions.filter((r) => r.change === change).length;
    assert.deepEqual([c.compared, changed('pass→fail'), changed('pass→pending'), c.notUnderNode, c.onlyInBaseline, c.onlyNow], [compared, fail, pending, off, only, fresh]);

    const none = { fail: 0, pending: 0 };
    assert.deepEqual(c.byNode['/home#Home'], { listed: { fail: 2, pending: 0 }, chipOnly: { fail: 3, pending: 0 } });
    assert.deepEqual(c.byNode['/help#Help'], { listed: none, chipOnly: { fail: 1, pending: 0 } });
    assert.deepEqual(c.byNode['/lab#Lab'], { listed: { fail: 0, pending: 1 }, chipOnly: none });
    assert.deepEqual(c.byNode['GET:/api/v1/member/list'], { listed: { fail: 1, pending: 0 }, chipOnly: none });
    assert.deepEqual(c.callRegressions, { '/document/:id#DocumentDetail': { fail: 1, pending: 0, calls: ['PUT:/api/v1/document/{documentId}/name'] } });
    assert.deepEqual(c.onlyInBaselineFiles.map((f) => [f.file, f.whole, f.tests.length]), [['export.spec.ts', true, 5], ['home.spec.ts', false, 1]]);
    assert.deepEqual(c.onlyInBaselineByNode['/lab#Lab'].map((t) => t.title), ['shows the lab banner @screen:/lab#Lab']);

    setConfig({ baselineTests: undefined });
    assert.equal((await pageData(configFile)).baselineTests, null);
  });
});

test('a regressed test tagged only on calls counts once on each screen that sends a failing one of them, apart from the screen\'s own count, and not on a screen that counts it already', () => {
  const was = (title: string, tags: string[] = []) => ({ title, tags, file: 'a.spec.ts', line: 1, project: null, status: 'pass' as const, result: 'e2e.json' });
  const baseline = { folder: 'releases/1.5.0', label: '1.5.0', results: [{ result: 'e2e.json', startedAt: '2026-09-30T00:00:00.000Z' }], tests: [was('saves'), was('reads'), was('both'), was('walks')] };
  const row = (title: string, status: string, extra = {}) => ({ title, status, file: 'a.spec.ts', line: 1, project: null, source: 'e2e.json', format: 'playwright', tags: [], ...extra });
  const comparison = compareTests(baseline, {
    nodes: { 'POST:/save': [row('saves', 'fail'), row('both', 'pending')], 'GET:/read': [row('reads', 'fail'), row('both', 'pending')], '/a#A': [row('walks', 'fail')] },
    passed: { '/a#A': [row('reads', 'fail', { level: 'interact' })], '/b#B': [row('saves', 'fail', { level: 'visit' })] },
  }, { screens: ['/a#A', '/b#B', '/c#C'], calls: ['POST:/save', 'GET:/read'] });
  assert.deepEqual(callRegressions(comparison, [{ id: 'POST:/save', screens: ['/a#A', '/b#B'] }, { id: 'GET:/read', screens: ['/a#A', '/c#C'] }]), {
    '/a#A': { fail: 1, pending: 1, calls: ['GET:/read', 'POST:/save'] },
    '/b#B': { fail: 1, pending: 1, calls: ['POST:/save'] },
    '/c#C': { fail: 1, pending: 1, calls: ['GET:/read'] },
  });
});

test('a baselineTests path that is missing, a result file that cannot be read, or an item that gives no test stops duru review with exit 1 and a line naming the path, with no page and no task list', async () => {
  await withRelease(async ({ copy, configFile, setConfig }) => {
    const report = path.join(copy, RELEASE, 'e2e.json');
    const stopped = async (said: string) => {
      await assert.rejects(() => startReviewServer(loadConfig(configFile), { author: signer('reviewer') }), { message: said });
      const run = spawnSync(process.execPath, [CLI, 'review', configFile, '--port', '0'], { encoding: 'utf8', timeout: 20000 });
      assert.deepEqual([run.status, run.signal, run.stdout, run.stderr], [1, null, '', `${said}\n`]);
    };
    setConfig({ baselineTests: [{ format: 'playwright', path: `${RELEASE}/e2e.json`, depth: 'ui' }] });
    await stopped(`baselineTests ${RELEASE}/e2e.json could not be read: it does not exist`);
    fs.writeFileSync(report, '{ "suites": [');
    const broken = (() => { try { JSON.parse('{ "suites": ['); } catch (err) { return (err as Error).message; } })();
    await stopped(`baselineTests ${RELEASE}/e2e.json could not be read: cannot read Playwright report ${report}: ${broken}`);
    fs.writeFileSync(report, JSON.stringify({ suites: [] }));
    await stopped(`baselineTests ${RELEASE}/e2e.json could not be read: it holds no playwright test result`);
  });
});
