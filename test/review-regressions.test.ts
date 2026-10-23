import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { compareTests } from '../src/baseline-tests.ts';
import { loadConfig } from '../src/config.ts';
import { addJudgment } from '../src/judgments.ts';
import { callRegressions, startReviewServer } from '../src/review.ts';
import type { PageData } from '../src/review.ts';
import { browserMissing, CLI, FIXTURE, signer, TRACED, withPage, withServer } from './review-helpers.ts';

const RELEASE = 'releases/1.5.0';
const RELEASE_TEXT = RELEASE.replace(/[.]/g, '\\.');
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
// 지금 결과에서는 trace 로 붙은 시험 넷을 실패로 바꾸고(하나는 firefox 실행만) 내보내기 보고서를 지운다.
function keepRelease(copy: string) {
  const now = (file: string) => path.join(copy, 'results', file);
  editJson(now('playwright-traced/calls.json'), (report) => {
    const spec = specsIn(report.suites).find((s) => s.title === MEMBER_PAGES.title);
    spec.tests.push({ ...spec.tests[0], projectId: 'firefox', projectName: 'firefox' });
  });
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
  setStatus(now('playwright-traced/visits.json'), 'opens home and then help', 'unexpected');
  setStatus(now('playwright-traced/visits.json'), 'presses the button on home', 'unexpected');
  setStatus(now('playwright-traced/calls.json'), 'reads a document from the server', 'unexpected');
  editJson(now('playwright-traced/calls.json'), (report) => {
    specsIn(report.suites).find((s) => s.title === MEMBER_PAGES.title).tests.find((t: any) => t.projectName === 'firefox').status = 'unexpected';
  });
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

const screenRow = (p: Page, title: string) => p.locator(`#screen-list li[title="${title}"]`);
const listed = (p: Page) => p.locator('#screen-list li').evaluateAll((items) => items.map((li) => li.getAttribute('title')));
const pick = (p: Page, title: string) => screenRow(p, title).click();
const chipsOf = (p: Page, title: string) => screenRow(p, title).locator('.badges .chip:is(.change-new, .change-condition, .change-calls, .regressed, .call-regressed)').allTextContents();
const tipOf = async (p: Page, selector: string) => {
  const el = p.locator(selector);
  const [title, label] = [await el.getAttribute('title'), await el.getAttribute('aria-label')];
  assert.equal(label, title);
  return title;
};
const regressionOf = (p: Page, where: string, title: string) => p.locator(`${where}:has-text("${title}") .chip.regression`);
const compareOf = (p: Page, id: string) => p.locator('#center table.calls tr', { has: p.locator(`td.call > div.mono :text-is("${id}")`) }).locator('td.compare');
const pickCall = (p: Page, id: string) => p.locator(`#center table.calls button.call-name:text-is("${id}")`).click();
const rowWidths = (p: Page) => p.locator('#center table.calls tr').evaluateAll((rows) =>
  rows.map((tr) => [...tr.children].reduce((n, td) => n + Number(td.getAttribute('colspan') ?? 1), 0)));

const SCREEN_TIP = (fail: number, pending: number, passed: number) => `${RELEASE} 에서 통과하고 지금 실패한 테스트 ${fail} · 보류 ${pending}. 이 화면을 지나가기만 한 테스트의 회귀 ${passed}개는 세지 않았습니다`;

test('in a browser, with baselineTests and baselineMap the screen list counts the regressions of rows that act on or check a screen, marks a screen whose calls carry a regressed call test apart, keeps only those screens on request, and shows the new screens in the same list', { skip: browserMissing }, async () => {
  await withRelease(async ({ configFile }) => {
    await withServer(loadConfig(configFile), 'reviewer', (base) => withPage(base, async (p) => {
      await p.waitForSelector('#screen-list li');
      const header = (await p.textContent('header #baseline'))!;
      assert.ok(header.startsWith(`비교 기준 1.5.0 ${path.join(RELEASE, 'map.json')} 커밋 `), header);
      assert.equal(await p.textContent('header #baseline .baseline-tests'), '1.5.0 결과 11');
      assert.equal(await p.getAttribute('header #baseline .baseline-tests strong', 'title'), RELEASE);
      const results = (await tipOf(p, 'header #baseline .baseline-results'))!;
      assert.ok(results.startsWith(`${RELEASE} 의 결과 파일 11개와 견줍니다\n${RELEASE}/playwright/e2e.json (`), results);
      assert.equal(await p.textContent('#left .baseline-filter'), '1.5.0 와 비교바뀐 화면만 1회귀만 4');

      assert.deepEqual(await chipsOf(p, '/home Home'), ['회귀 2']);
      assert.equal(await tipOf(p, '#screen-list li[title="/home Home"] .chip.regressed'), SCREEN_TIP(2, 0, 3));
      assert.deepEqual(await chipsOf(p, '/help Help'), []);
      assert.deepEqual(await chipsOf(p, '/lab Lab'), ['신규', '회귀 1']);
      assert.equal(await tipOf(p, '#screen-list li[title="/lab Lab"] .chip.regressed'), SCREEN_TIP(0, 1, 0));
      assert.deepEqual(await chipsOf(p, '/document/:tab(draft|done) DocumentList'), ['회귀 1']);
      assert.deepEqual(await chipsOf(p, '/document/:id DocumentDetail'), ['호출 회귀 1']);
      const callChip = '#screen-list li[title="/document/:id DocumentDetail"] .chip.call-regressed';
      assert.equal(await tipOf(p, callChip), `이 화면이 보내는 호출 PUT:/api/v1/document/{documentId}/name 에 태그로 붙은 테스트 가운데 ${RELEASE} 에서 통과하고 지금 실패한 테스트 1 · 보류 0. 화면의 「회귀」에 더하지 않았습니다`);
      assert.equal(await p.locator(callChip).evaluate((el) => getComputedStyle(el).borderStyle), 'dashed');

      assert.equal((await listed(p)).length, 11);
      await p.check('#left input[name=regressed]');
      assert.deepEqual(await listed(p), ['/home Home', '/document/:tab(draft|done) DocumentList', '/document/:id DocumentDetail', '/lab Lab']);
      await p.check('#left input[name=changed]');
      assert.deepEqual(await listed(p), ['/lab Lab']);
      await p.uncheck('#left input[name=regressed]');
      assert.deepEqual(await listed(p), ['/lab Lab']);
      await p.uncheck('#left input[name=changed]');
      assert.equal((await listed(p)).length, 11);
    }));
  }, { map: true });
});

test('in a browser, a tagged, importing, passing-through, call-sending or handed-over test row that regressed carries 「통과→실패」 or 「통과→보류」 naming the baseline result, the call table counts the regressions of a call, and tests only in the baseline fold under their screen or call and under the list by file', { skip: browserMissing }, async () => {
  await withRelease(async ({ configFile }) => {
    await withServer(loadConfig(configFile), 'reviewer', (base) => withPage(base, async (p) => {
      await p.waitForSelector('#screen-list li');
      assert.equal(await p.isVisible('header #baseline'), true);
      assert.equal(await p.textContent('header #baseline'), '비교 기준 1.5.0 결과 11');
      assert.equal(await p.textContent('#left .baseline-filter'), '1.5.0 와 비교회귀만 4');
      assert.equal(await p.locator('#left input[name=changed]').count(), 0);

      await pick(p, '/home Home');
      assert.equal(await p.locator('#center .chip.regression').count(), 5);
      const passedOn = (title: string) => regressionOf(p, '#center .passed .pair-test', title);
      for (const title of ['presses the button on home', 'opens home and then help', 'reads a document from the server', MEMBER_PAGES.title]) assert.equal(await passedOn(title).textContent(), '통과→실패', title);
      assert.equal(await regressionOf(p, '#center .importers .pair-test', 'lists the documents it is given').textContent(), '통과→실패');
      const tip = (await tipOf(p, '#center .passed .pair-test:has-text("presses the button on home") .chip.regression'))!;
      assert.match(tip, new RegExp(`^${RELEASE_TEXT} 에서 통과하고 지금 실패 \\(chromium\\)\\n견준 결과 파일: ${RELEASE_TEXT}/playwright-traced/visits\\.json \\(.+ 시작\\)$`));
      assert.equal(await p.locator('#center .baseline-only').count(), 0);
      assert.equal(await compareOf(p, 'GET:/api/v1/document/list').textContent(), '—');

      await pick(p, '/lab Lab');
      assert.equal(await regressionOf(p, '#center .test', 'opens the lab').textContent(), '통과→보류');
      assert.match((await tipOf(p, '#center .test:has-text("opens the lab") .chip.regression'))!, new RegExp(`^${RELEASE_TEXT} 에서 통과하고 지금 보류 \\(chromium\\)\\n견준 결과 파일: ${RELEASE_TEXT}/playwright/e2e\\.json \\(`));
      assert.equal(await p.locator('#center .chip.regression').count(), 1);
      const labOnly = p.locator('#center details.baseline-only');
      assert.equal(await labOnly.locator('summary').textContent(), '기준에만 1');
      assert.equal(await labOnly.getAttribute('open'), null);
      await labOnly.locator('summary').click();
      assert.equal(await labOnly.locator('li').textContent(), '통과 shows the lab banner home.spec.ts:40 · chromium');
      assert.equal(await labOnly.locator('li button.bubble').count(), 0);
      assert.equal(await compareOf(p, 'GET:/api/v1/lab/experiment').textContent(), '—');

      await pick(p, '/document/:id DocumentDetail');
      const renameCompare = compareOf(p, 'PUT:/api/v1/document/{documentId}/name');
      assert.equal(await renameCompare.textContent(), '회귀 1');
      assert.equal(await tipOf(p, '#center table.calls tr:has(:text-is("PUT:/api/v1/document/{documentId}/name")) td.compare .chip.regressed'), `${RELEASE} 에서 통과하고 지금 실패한 테스트 1 · 보류 0. trace 로 이 호출을 보내기만 한 테스트의 회귀 0개는 세지 않았습니다`);
      assert.equal(await compareOf(p, 'GET:/api/v1/document/{documentId}').textContent(), '—');
      await pickCall(p, 'PUT:/api/v1/document/{documentId}/name');
      assert.equal(await regressionOf(p, '#center .call-info .test', 'rename is refused by the server').textContent(), '통과→실패');
      await pickCall(p, 'GET:/api/v1/document/{documentId}');
      assert.equal(await regressionOf(p, '#center .call-info .passed .pair-test', 'reads a document from the server').textContent(), '통과→실패');
      const widths = await rowWidths(p);
      assert.ok(widths.length > 2 && widths.every((w) => w === widths[0]), String(widths));

      await pick(p, '/admin/member AdminMember');
      assert.equal(await compareOf(p, 'GET:/api/v1/member/list').textContent(), '회귀 1');
      await pickCall(p, 'GET:/api/v1/member/list');
      assert.equal(await regressionOf(p, '#center .call-info .awaiting-tag .pair-test', MEMBER_PAGES.title).textContent(), '통과→실패');
      assert.match((await tipOf(p, `#center .call-info .awaiting-tag .pair-test:has-text("${MEMBER_PAGES.title}") .chip.regression`))!, new RegExp(`^${RELEASE_TEXT} 에서 통과하고 지금 실패 \\(firefox\\)\\n`));

      await pick(p, '/admin/report AdminReport');
      await pickCall(p, 'POST:/api/v1/report/export');
      const exportOnly = p.locator('#center .call-info details.baseline-only');
      assert.equal(await exportOnly.locator('summary').textContent(), '기준에만 5');
      const reportWidths = await rowWidths(p);
      assert.ok(reportWidths.length > 4 && reportWidths.every((w) => w === reportWidths[0]), String(reportWidths));

      const group = p.locator('#left .baseline-only-files');
      assert.equal(await p.textContent('#left h2.baseline-only-head'), '기준에만 6');
      assert.deepEqual(await group.locator(':scope > details > summary').allTextContents(), ['export.spec.ts 5 파일 없음', 'home.spec.ts 1']);
      assert.equal(await tipOf(p, '#left .baseline-only-files .chip.file-gone'), '지금 결과에 이 파일의 테스트가 하나도 없습니다');
      const home = group.locator(':scope > details', { hasText: 'home.spec.ts' });
      assert.equal(await home.getAttribute('open'), null);
      await home.locator('summary').click();
      assert.equal(await home.locator('li').textContent(), '통과 shows the lab banner home.spec.ts:40 · chromium');
      await pick(p, '/home Home');
      assert.equal(await home.getAttribute('open'), '');
    }));
  });
});
