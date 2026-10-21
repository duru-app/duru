import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { addMark, loadMarks } from '../src/marks.ts';
import { CLI, withRebuiltFixture, withServer, withPage, postMark, CASE_KINDS, asked, why, browserMissing, SAVE_REFUSED } from './review-helpers.ts';
import type { Config } from './review-helpers.ts';

const RENAME = 'PUT:/api/v1/document/{documentId}/name';
const ARCHIVE = 'POST:/api/v1/archive/document';
const SIGN_IN = 'POST:/api/v1/auth/sign-in';
const EXPORT = 'POST:/api/v1/report/export';
const LIST = 'GET:/api/v1/document/list';
const MEMBERS = 'GET:/api/v1/member/list';
const ENDED = { text: '끝난 문서: 끝난 뒤의 쓰기 요청은 거부된다', values: ['cancelled', 'rejected'], picks: [{ screen: '/document/**', methods: ['POST', 'PUT', 'PATCH', 'DELETE'] }, { api: '/api/v9/**' }] };
const KINDS = { ended: ENDED, boundary: CASE_KINDS.boundary };
const AT = new Date('2026-10-20T01:00:00Z');

const casesTab = '#left .views.side button:has-text("경우 종류")';
const kindRow = (kind: string) => `#case-kind-list li[data-kind="${kind}"]`;
const undecidedIds = (p: Page) => p.locator('#center .case-undecided li.case-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-node')));
const runCli = (config: Config, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args.slice(0, 1), path.join(config.configDir, 'config.json'), ...args.slice(1)], { encoding: 'utf8' }).stdout;

async function openKind(p: Page, kind: string) {
  await p.waitForSelector('#screen-list li');
  await p.click(casesTab);
  await p.click(kindRow(kind));
  await p.locator(`#center .title-row .mono:text-is("case:${kind}")`).waitFor();
}

function seed(config: Config) {
  runCli(config, 'case', 'ended', MEMBERS, 'not-needed', '--note', '회원 목록은 문서와 관계없다');
  runCli(config, 'case', 'boundary', SIGN_IN, 'needed');
  addMark(config.marksDir, { target: { node: SIGN_IN, case: 'ended' }, status: 'needed', author: '김민' }, AT);
  addMark(config.marksDir, { target: { node: LIST, case: 'ended' }, status: 'not-needed', author: '김민' }, AT);
  addMark(config.marksDir, { target: { node: EXPORT, case: 'ended' }, status: 'not-needed', note: '보고서는 문서 상태를 보지 않는다', rule: { index: 0, pick: { screen: '/admin/**', methods: ['POST'] } }, author: '김민' }, AT);
  addMark(config.marksDir, { target: { node: RENAME, case: 'boundary' }, status: 'needed', author: '김민' }, AT);
}

test('the review data carries, for each case kind, the screens and calls picked for it with the case tags no test carries, as many as rebuild counts', async () => {
  await withRebuiltFixture({ caseKinds: KINDS }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const { caseGaps } = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(caseGaps.ended, [
        { node: ARCHIVE, tags: ['case:ended=cancelled', 'case:ended=rejected'] },
        { node: RENAME, tags: ['case:ended=cancelled', 'case:ended=rejected'] },
      ]);
      assert.deepEqual(caseGaps.boundary, []);
      assert.match(runCli(config, 'rebuild'), /case kind ended: undecided 8 \| cases with no tests 4\n/);
    }));
});

test('in a browser, 「경우 종류 N」 is the third list tab only while caseKinds is set, N adding up every kind\'s undecided candidates, and each kind\'s line counts its picks, undecided candidates and cases with no tests', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.deepEqual(await p.locator('#left .views.side button .tab-name').allTextContents(), ['화면', '태그 없음']);
        await p.evaluate(() => { location.hash = '#cases?kind=ended'; });
        await p.waitForFunction(() => location.hash.startsWith('#screens'));
      })));
  await withRebuiltFixture({ caseKinds: KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.deepEqual(await p.locator('#left .views.side button').allTextContents(), ['화면 11', '태그 없음 13', '경우 종류 29']);
        await p.click(casesTab);
        assert.deepEqual(await p.locator('#case-kind-list li .kind-counts').allTextContents(), ['대상 2 · 미판정 8 · 빈칸 4', '대상 0 · 미판정 21 · 빈칸 0']);
        assert.equal(await p.evaluate(() => location.hash), '#cases?kind=ended');
      })));
  await withRebuiltFixture({ caseKinds: { every: { text: '모든 화면', picks: [{ screen: '/**' }] } } }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent(casesTab), '경우 종류 0');
        await p.click(casesTab);
        assert.equal(await p.textContent('#center .case-undecided p.muted'), '미판정 후보가 없습니다.');
      })));
});

test('in a browser, a kind shows its picks by rule, person and agent, its rules with what each picked, folded lists of picks and of what is not a target, and its undecided candidates in write, read and screen groups with the method of each request, and 「사람이 정할 것」 lets go once nothing it lists is left', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: KINDS }, (config) => {
    seed(config);
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openKind(p, 'ended');
        assert.deepEqual(await p.locator('#center .case-count').allTextContents(), ['3대상규칙 2 · 사람 1 · 에이전트 0', '1대상 아님', '6미판정', '6시험 없는 값 칸']);
        assert.deepEqual(await p.locator('#center .case-rules button.rule-line').allTextContents(), [
          '1. 화면 경로 /document/** · 메서드 POST · PUT · PATCH · DELETE 고름 2',
          '2. 요청 주소 /api/v9/** 고름 0아무것도 고르지 못함',
        ]);
        assert.deepEqual(await p.locator('#center details.case-list > summary').allTextContents(), ['대상 3', '대상 아님 1']);
        assert.deepEqual(await p.locator('#center details.case-list').evaluateAll((els) => els.map((e) => (e as HTMLDetailsElement).open)), [false, false]);
        assert.deepEqual(await p.locator('#center .case-group-head').allTextContents(), [' 쓰기 요청 3메서드를 모르는 요청도 여기에 둡니다', ' 조회 요청 3']);
        assert.deepEqual(await undecidedIds(p), ['POST:/api/v1/report/archive', EXPORT, 'POST:/api/v1/report/schedule', LIST, 'GET:/api/v1/document/{documentId}', 'GET:/api/v1/lab/experiment']);
        assert.deepEqual(await p.locator('#center .case-undecided .method').evaluateAll((els) => els.map((e) => `${e.textContent} ${e.className}`)), [...Array(3).fill('POST method m-post'), ...Array(3).fill('GET method m-get')]);
        assert.deepEqual(await p.locator('#center .case-held').allTextContents(), [
          '김민 가 26. 10. 20. 오전 10:00 에 규칙에서 뺐지만 규칙이 더는 고르지 않습니다',
          '김민 가 26. 10. 20. 오전 10:00 에 이유 없이 뺐습니다',
        ]);
        assert.equal(await p.textContent(`#center li.case-row[data-node="${EXPORT}"] .case-reason`), '예전 이유 보고서는 문서 상태를 보지 않는다');

        await p.click('#center details.case-list.not-needed > summary');
        assert.deepEqual(await p.locator('#center details.case-list.not-needed li .case-row-head').allTextContents(), [`GET/api/v1/member/list보내는 화면 /admin/member대상 아님 · agent`]);
        assert.match((await p.textContent('#center details.case-list.not-needed .case-reason'))!, /· 이유 회원 목록은 문서와 관계없다$/);
        await p.click('#center .case-rules button.rule-line[data-rule="0"]');
        assert.equal(await p.locator('#center details.case-list.needed').evaluate((e) => (e as HTMLDetailsElement).open), true);
        assert.deepEqual(await p.locator('#center details.case-list.needed li').evaluateAll((els) => els.map((e) => e.getAttribute('data-node'))), [ARCHIVE, RENAME]);
        await p.click('#center .case-filter button:has-text("모두 보기")');
        assert.deepEqual(await p.locator('#center details.case-list.needed li').evaluateAll((els) => els.map((e) => e.getAttribute('data-node'))), [ARCHIVE, SIGN_IN, RENAME]);
        assert.deepEqual(await p.locator('#center details.case-list.needed .chip').allTextContents(), ['규칙', '김민', '규칙']);

        await p.click('#center button.person-only');
        assert.equal(await p.getAttribute('#center button.person-only', 'aria-pressed'), 'true');
        assert.deepEqual(await undecidedIds(p), [EXPORT, LIST]);
        assert.equal(await p.textContent('#center button.person-only'), '사람이 정할 것 2');
        await p.click('#center button.person-only');
        assert.equal((await undecidedIds(p)).length, 6);

        assert.equal((await postMark(base, { target: { node: 'GET:/api/v1/lab/experiment', case: 'ended' }, status: 'needed' })).status, 201);
        await p.waitForFunction(() => document.querySelectorAll('#center .case-undecided li.case-row').length === 5);
        assert.deepEqual(await p.locator('#center details.case-list').evaluateAll((els) => els.map((e) => (e as HTMLDetailsElement).open)), [true, true]);

        await p.click('#center button.person-only');
        for (const node of [EXPORT, LIST]) assert.equal((await postMark(base, { target: { node, case: 'ended' }, status: 'needed' })).status, 201);
        await p.waitForFunction(() => document.querySelectorAll('#center .case-undecided li.case-row').length === 3);
        assert.equal(await p.locator('#center button.person-only').count(), 0);

        await p.click(kindRow('boundary'));
        await p.locator('#center .title-row .mono:text-is("case:boundary")').waitFor();
        assert.deepEqual(await p.locator('#center .case-count').allTextContents(), ['2대상규칙 0 · 사람 1 · 에이전트 1', '0대상 아님', '19미판정', '2시험 없는 값 칸']);
        assert.equal(await p.textContent('#center .case-rules'), '규칙이 없어 모든 화면과 호출이 후보입니다.');
        assert.deepEqual(await p.locator('#center .case-group-head label').allTextContents(), [' 쓰기 요청 4', ' 조회 요청 4', ' 화면 11']);
        assert.equal(await p.textContent('#center .case-group.screens li.case-row .where >> nth=0'), '컴포넌트 AdminAudit');
        assert.deepEqual(await p.locator('#center details.case-list').evaluateAll((els) => els.map((e) => (e as HTMLDetailsElement).open)), [false, false]);
      }));
  });
});

test('in a browser, checked candidates are decided at once: 「대상 아님…」 asks one reason and saves nothing without it, each candidate gets its own mark, the page reads the review data once, other tabs stay locked meanwhile, and the decided ones leave duru undecided', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openKind(p, 'boundary');
        assert.equal(await p.locator('#center .case-bar button').count(), 0);
        await p.check('#center input[name="group:screens"]');
        assert.equal(await p.evaluate(() => document.activeElement!.getAttribute('name')), 'group:screens');
        assert.deepEqual(await p.locator('#center .case-bar button').allTextContents(), ['대상 (11)', '대상 아님… (11)']);
        await p.uncheck('#center input[name="/admin/audit#AdminAudit"]');
        assert.equal(await p.locator('#center input[name="group:screens"]').evaluate((e) => (e as HTMLInputElement).indeterminate), true);

        await p.click('#center .case-bar button.pick-out');
        await p.locator(asked).waitFor();
        assert.equal(await p.textContent(`${asked} h2`), '고른 10개에서는 이 경우를 시험하지 않습니다');
        assert.equal(await p.isDisabled(`${asked} button.discard`), true);
        await p.click(`${asked} button.cancel`);
        assert.deepEqual(loadMarks(config.marksDir), []);

        let gate = () => {};
        const held = new Promise<void>((resolve) => { gate = resolve; });
        const reads: string[] = [];
        p.on('request', (r) => { if (r.url().endsWith('/api/data')) reads.push(r.url()); });
        await p.route('**/api/marks', async (route) => { await held; await route.continue(); });
        await p.click('#center .case-bar button.pick-out');
        await p.fill(why, '화면은 입력을 직접 받지 않는다');
        await p.click(`${asked} button.discard`);
        await p.waitForFunction(() => (document.querySelector('#left .views.side button') as HTMLButtonElement).disabled);
        assert.deepEqual(await p.locator('#left .views.side button').evaluateAll((els) => els.map((e) => (e as HTMLButtonElement).disabled)), [true, true, true]);
        assert.equal(await p.isDisabled('#view-story'), true);
        assert.equal(await p.locator(`${kindRow('ended')}.locked`).count(), 1);
        gate();
        await p.waitForFunction(() => !(document.querySelector('#left .views.side button') as HTMLButtonElement).disabled);
        await p.unroute('**/api/marks');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(reads.length, 1);
        const marks = loadMarks(config.marksDir);
        assert.equal(marks.length, 10);
        assert.ok(marks.every((m) => m.status === 'not-needed' && m.note === '화면은 입력을 직접 받지 않는다' && m.target!.case === 'boundary'));
        assert.deepEqual(await p.locator('#center .case-group-head label').allTextContents(), [' 쓰기 요청 6', ' 조회 요청 4', ' 화면 1']);
        const left = runCli(config, 'undecided', 'boundary');
        assert.match(left, /^case kind boundary: 11 undecided\n/);
        assert.ok(!left.includes('/admin/group#AdminGroup') && left.includes('/admin/audit#AdminAudit'));

        await p.check('#center input[name="group:writes"]');
        await p.click('#center .case-bar button.pick-needed');
        await p.waitForFunction(() => !document.querySelector('#center .case-group.writes'));
        assert.equal(loadMarks(config.marksDir).filter((m) => m.status === 'needed').length, 6);
        assert.deepEqual(await p.locator('#center .case-count strong').allTextContents(), ['6', '10', '5', '6']);
      })));
});

test('in a browser, saving checked candidates stops at the first failure, says which were saved and which were not, and keeps the unsaved ones checked', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openKind(p, 'ended');
        await p.check('#center input[name="group:reads"]');
        let posts = 0;
        await p.route('**/api/marks', (route) => (++posts === 2 ? route.fulfill({ status: 500, body: 'disk full' }) : route.continue()));
        await p.click('#center .case-bar button.pick-needed');
        await p.locator('#center .case-bar-error').waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.equal(await p.textContent('#center .case-bar-error'),
          `저장하지 못했습니다: disk full\n저장한 것 1: ${LIST}. 저장하지 못한 것 3: GET:/api/v1/document/{documentId}, GET:/api/v1/lab/experiment, ${MEMBERS}.`);
        assert.deepEqual(await p.locator('#center .case-group.reads input:checked').evaluateAll((els) => els.map((e) => e.getAttribute('name'))), ['group:reads', 'GET:/api/v1/document/{documentId}', 'GET:/api/v1/lab/experiment', MEMBERS]);
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target!.node, m.status]), [[LIST, 'needed']]);
      })));
});

test('in a browser, the case tab keeps its kind and pressed candidate in the address, shows that candidate\'s conversation and form on the right apart from the screen tab\'s, opens a screen or call from its name, and a later mark from 「경우별 테스트」 wins over the tab\'s', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.fill('#right-dock textarea', '화면 탭에 적던 글');
        await p.evaluate((id) => { location.hash = `#cases?kind=ended&node=${encodeURIComponent(id)}`; }, EXPORT);
        await p.locator(`#center li.case-row.selected[data-node="${EXPORT}"]`).waitFor();
        assert.equal(await p.textContent('#right .talk-scope button[aria-pressed="true"]'), '이 호출 0');
        assert.equal(await p.textContent('#right-dock .tags .tag-label'), '호출 전체');
        await p.fill('#right-dock textarea', '내보내기는 경계를 따로 본다');
        await p.click('#left .views.side button:has-text("화면")');
        assert.equal(await p.inputValue('#right-dock textarea'), '화면 탭에 적던 글');
        await p.click(casesTab);
        assert.equal(await p.inputValue('#right-dock textarea'), '내보내기는 경계를 따로 본다');

        await p.click(`#center li.case-row[data-node="${LIST}"] .where`);
        assert.equal(await p.evaluate(() => decodeURIComponent(location.hash)), `#cases?kind=ended&node=${LIST}`);
        assert.equal(await p.inputValue('#right-dock textarea'), '');

        await p.click(`#center li.case-row[data-node="${LIST}"] button.node-name`);
        await p.waitForFunction(() => location.hash.startsWith('#screens'));
        assert.equal(await p.textContent('#center .call-info summary .mono'), LIST);
        await p.goBack();
        await p.locator(`#center li.case-row.selected[data-node="${LIST}"]`).waitFor();

        await p.evaluate(() => { location.hash = '#cases?kind=gone'; });
        await p.waitForFunction(() => location.hash.startsWith('#screens'));

        await p.click('#screen-list li:has-text("/home")');
        await p.locator('table.calls tbody tr:not(.option)', { hasText: LIST }).locator('td.cell').first().click();
        const call = p.locator('#center .call-info > .cases');
        await call.locator('.case-kinds button[data-kind="ended"]').click();
        await call.locator('.case-kinds button[data-kind="ended"][aria-pressed="true"]:not([disabled])').waitFor();
        await p.click(casesTab);
        await p.click('#center details.case-list.needed > summary');
        assert.deepEqual(await p.locator('#center details.case-list.needed li').evaluateAll((els) => els.map((e) => e.getAttribute('data-node'))), [ARCHIVE, RENAME, LIST]);

        await p.click('#right .talk-scope button:has-text("전체")');
        await p.click('#right .talk-filters button:has-text("변경 기록")');
        assert.match((await p.textContent('#right .talk-changes .talk-line'))!, /^켬경우 끝난 문서/);

        const said: string[] = [];
        p.once('dialog', (d) => { said.push(d.message()); d.dismiss(); });
        await p.click('#right .talk-scope button:has-text("이 호출")');
        await p.fill('#right-dock textarea', '목록은 끝난 문서도 보인다');
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForTimeout(200);
        assert.equal(said.length, 1);
      })));
});

test('in a browser, a focused candidate checkbox keeps the focus while another candidate leaves the list on a live reload', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openKind(p, 'ended');
        await p.check(`#center input[name="${LIST}"]`);
        assert.equal(await p.evaluate(() => document.activeElement!.getAttribute('name')), LIST);
        assert.equal((await postMark(base, { target: { node: EXPORT, case: 'ended' }, status: 'needed' })).status, 201);
        await p.waitForFunction(() => document.querySelectorAll('#center .case-undecided li.case-row').length === 7);
        assert.equal(await p.evaluate(() => document.activeElement!.getAttribute('name')), LIST);
        assert.equal(await p.isChecked(`#center input[name="${LIST}"]`), true);
      })));
});
