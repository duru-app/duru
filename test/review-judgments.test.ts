import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from 'playwright-core';
import { addJudgment, loadJudgments } from '../src/judgments.ts';
import { CLI, withRebuiltFixture, withServer, postJudgment, browserMissing, toList, withPage, untaggedTab, screenBox, statusLine, walkFlow, TRACED, asked, why, askedFocused, excludeIn, SAVE_REFUSED, DOCUMENT_TABLE, HOME_NODE, bulk, openDocumentTable, untilSet, judgedBy, DETAIL_CALL, closeCallInfo } from './review-helpers.ts';
import type { PageData, Kept, FailSave } from './review-helpers.ts';

declare const state: any;
declare function load(): Promise<void>;
declare function render(): void;

const HELP_TEST = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'renders the help text' };

test('a judgment posted from the page is saved as a new file with the server-side author, and a discarded pair moves out of the screen\'s importing tests', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      assert.equal((await postJudgment(base, { test: HELP_TEST, node: '/help#Help', kind: 'discard' })).status, 400);
      const res = await postJudgment(base, { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'only renders a shared header', author: 'someone else' });
      assert.equal(res.status, 201);
      const { judgments } = loadJudgments(config.judgmentsDir);
      assert.deepEqual(judgments.map((j) => [j.test, j.node, j.kind, j.reason, j.author]), [[HELP_TEST, '/help#Help', 'discard', 'only renders a shared header', 'reviewer']]);

      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.tests.importers['/help#Help'].map((t) => t.title), ['shows the day the help was last updated']);
      assert.deepEqual(data.tests.discarded['/help#Help'].map((t) => [t.title, t.judgment.reason]), [['renders the help text', 'only renders a shared header']]);
      assert.equal(walkFlow(data.flow.roots).find((n) => n.id === '/help#Help')!.imported, 1);
    }),
  );
});

test('in a browser, the flow counts the importing tests again after a pair is discarded', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const helpLine = async () => statusLine(await screenBox(p, '/help#Help'));
        assert.equal(await helpLine(), '실패 · 불러옴 2');

        await p.click('#view-list');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await excludeIn(first, 'only renders a shared header');
        await p.waitForSelector('#center .discarded');

        await p.click('#view-flow');
        assert.equal(await helpLine(), '실패 · 불러옴 1');
      }, { view: 'flow' })));
});

test('in a browser, a test importing a screen is discarded with a reason, stays discarded after a rebuild, and comes back when undone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await excludeIn(first, 'only renders a shared header');
        await p.waitForSelector('#center .discarded');

        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => [j.test, j.node, j.kind, j.reason, j.author]), [
          [HELP_TEST, '/help#Help', 'discard', 'only renders a shared header', 'reviewer'],
        ]);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 1');
        assert.equal(await p.locator('#screen-list li:has-text("/help") .importer-count').textContent(), '불러옴 1');
        assert.equal(await p.textContent('#center .discarded h2'), '제외한 짝 1');
        assert.match((await p.textContent('#center .discarded .importer'))!, /renders the help text.*only renders a shared header · \d/s);

        execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 1');

        await p.click('#center .discarded button.undo');
        await p.waitForSelector('#center .discarded', { state: 'detached' });
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
        assert.equal(await p.locator('#screen-list li:has-text("/help") .importer-count').textContent(), '불러옴 2');
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['discard', 'undo']);
      })));
});

test('in a browser, the window asking why a pair is excluded names the pair, and a discard without a reason cannot be sent', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        assert.equal(await p.locator(asked).isVisible(), false);
        await first.locator('button.discard').click();
        assert.equal(await p.locator(asked).evaluate((el) => el.matches(':modal')), true);
        assert.equal(await p.textContent(`${asked} h2`), '이 짝을 제외합니다');
        assert.match((await p.textContent(`${asked} .subject`))!, /테스트renders the help text.*Help\.spec\.js.*화면\/help Help/s);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '제외']);
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), true);

        await p.fill(why, '  \n ');
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), true);
        await p.press(why, 'Control+Enter');
        assert.equal(await p.locator(asked).isVisible(), true);
        assert.equal(fs.existsSync(config.judgmentsDir), false);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
      })));
});

test('in a browser, Enter breaks the line of the reason and Ctrl+Enter sends it without the blank ends, and the saved reason keeps its lines', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.locator('#center .importers .importer', { hasText: 'renders the help text' }).locator('button.discard').click();
        await p.keyboard.type(' only renders');
        await p.keyboard.press('Enter');
        await p.keyboard.type('a shared header');
        await p.keyboard.press('Enter');
        assert.equal(await p.inputValue(why), ' only renders\na shared header\n');
        assert.equal(fs.existsSync(config.judgmentsDir), false);

        await p.keyboard.press('Control+Enter');
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.reason), ['only renders\na shared header']);
        assert.equal(await p.locator('#center .discarded .memo').evaluate((el) => getComputedStyle(el).whiteSpace), 'pre-wrap');
      })));
});

async function excludePicked(p: Page, reason: string) {
  await p.click('#center .bulk-bar button.discard');
  await p.fill(why, reason);
  await p.click(`${asked} button.discard`);
}

test('in a browser, a judgment that fails to save shows its error beside the test whose button was pressed, and each way of leaving that view clears it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.route('**/api/judgments', (route) => route.fulfill({ status: 500, body: 'disk full' }));
        const errorOf = () => p.evaluate(() => state.judgmentError);
        const second = p.locator('#center .importers .importer').nth(1);
        const failToSave = async () => {
          await second.locator('button.hand-over').click();
          await second.locator('.judgment-error').waitFor();
        };
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await failToSave();
        assert.equal(await p.locator('#center .judgment-error').count(), 1);
        assert.equal(await p.locator('#center .importers .importer').first().locator('.judgment-error').count(), 0);

        await p.click('#screen-list li:not(:has-text("/help"))');
        assert.equal(await errorOf(), null);
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await failToSave();
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#left .views.side button:has-text("화면")');
        assert.equal(await errorOf(), null);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await failToSave();
        await p.click('#center table tbody tr:has-text("테스트 ") >> nth=0');
        await p.locator('#center table tbody tr.selected').waitFor();
        assert.equal(await errorOf(), null);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
        assert.deepEqual(errors.splice(0), [...SAVE_REFUSED, ...SAVE_REFUSED, ...SAVE_REFUSED]);
      })));
});

test('in a browser, choosing a story clears a judgment error that failed to save while the story list was open', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        let held!: Route;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer').first();
        await first.locator('button.hand-over').click();
        await untilSet(() => held, 'the first judgment request');
        await p.click('#left .views.side button:has-text("스토리")');
        await held.fulfill({ status: 500, body: 'disk full' });
        await p.waitForFunction(() => state.judgmentError !== null);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        await p.click('#story-list li >> nth=0');
        assert.equal(await p.evaluate(() => state.judgmentError), null);
      })));
});

test('in a browser, a judgment that fails to save after another screen was selected still shows its error', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        let held!: Route;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer').first();
        await first.locator('button.hand-over').click();
        await untilSet(() => held, 'the first judgment request');
        await p.click('#screen-list li:not(:has-text("/help"))');
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
        await held.fulfill({ status: 500, body: 'disk full' });
        await p.locator('#center .judgment-error').waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.match((await p.textContent('#center .judgment-error'))!, /저장하지 못했습니다: disk full/);
        assert.equal(await p.locator('#center .judgment-error').count(), 1);

        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
      })));
});

test('in a browser, a pair included with one press waits for its tag apart from the importing tests, and comes back when undone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        assert.deepEqual(await first.locator('.judge-row > *').allTextContents(), ['제외', '포함']);
        await first.locator('button.hand-over').click();
        await p.waitForSelector('#center .awaiting-tag');

        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => [j.test, j.node, j.kind, j.reason, j.author]), [
          [HELP_TEST, '/help#Help', 'hand-over', '', 'reviewer'],
        ]);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 1');
        assert.equal(await p.locator('#screen-list li:has-text("/help") .importer-count').textContent(), '불러옴 1');
        assert.equal(await p.textContent('#center .awaiting-tag h2'), '태그 대기 1');
        assert.match((await p.textContent('#center .awaiting-tag .importer'))!, /renders the help text/);
        assert.doesNotMatch((await p.textContent('#center .awaiting-tag .importer'))!, /reviewer/);
        assert.equal(await p.locator('#center .discarded').count(), 0);

        await p.click('#center .awaiting-tag button.undo');
        await p.waitForSelector('#center .awaiting-tag', { state: 'detached' });
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['hand-over', 'undo']);
      })));
});

test('in a browser, a hand-over saved with a note shows the note while it waits for its tag', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    addJudgment(config.judgmentsDir, { test: HELP_TEST, node: '/help#Help', kind: 'hand-over', reason: 'checks the help screen', author: 'earlier reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        assert.match((await p.textContent('#center .awaiting-tag .importer'))!, /renders the help text.*메모 checks the help screen.*earlier reviewer/s);
      }));
  });
});

test('in a browser, a hand-over whose test is no longer found shows apart and is closed by undoing it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const gone = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'a title that was renamed' };
    addJudgment(config.judgmentsDir, { test: gone, node: '/help#Help', kind: 'hand-over', reason: 'was about the help text', author: 'someone' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .detached h2'), '떨어져 나감 1');
        assert.match((await p.textContent('#center .detached p.muted'))!, /결과에서 찾을 수 없/);
        assert.match((await p.textContent('#center .detached .importer'))!, /components\/Help\.spec\.js.*a title that was renamed.*was about the help text.*someone/s);
        assert.equal(await p.locator('#center .awaiting-tag').count(), 0);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');

        await p.click('#center .detached button.undo');
        await p.waitForSelector('#center .detached', { state: 'detached' });
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['hand-over', 'undo']);
      }));
  });
});

const LIST_NODE = '/document/:tab_draft_done_#DocumentList';
const pick = '#center .pair-row input.pick';

test('in a browser, only the pairs that still import get a checkbox, the bulk buttons stay disabled until a pair is picked and say how many are', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: HOME_NODE, kind: 'discard', reason: 'only lists documents', author: 'reviewer' });
        await p.reload();
        await toList(p);
        await openDocumentTable(p);
        assert.equal(await p.locator('#center .pair').count(), 2);
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair', { hasText: '/home' }).locator('input').count(), 0);
        assert.equal(await p.locator('#center .pair', { hasText: '/home' }).locator('button').count(), 0);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), true);
        assert.equal(await p.locator(`${bulk} button.discard`).isDisabled(), true);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (0)');
        assert.equal(await p.locator(asked).isVisible(), false);

        await p.check(pick);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (1)');
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (1)');
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), false);
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.locator('#screen-list').count(), 0);
        await p.uncheck(pick);
        assert.equal(await p.locator(`${bulk} button.discard`).isDisabled(), true);
      })));
});

test('in a browser, picking a pair does not open its screen, and the pick-all box picks every pair that can be judged', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(pick.concat(' >> nth=0'));
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator(`${bulk} input.pick-all`).isChecked(), false);

        await p.check(`${bulk} input.pick-all`);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (2)');
        await p.uncheck(`${bulk} input.pick-all`);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 0);
        assert.equal(await p.locator(`${bulk} input.pick-all`).isChecked(), false);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), true);
      })));
});

test('in a browser, a pair whose screen is not on the map has no checkbox and is not picked by the pick-all box', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data: PageData = await res.json();
          data.map.screens = data.map.screens.filter((s) => s.id !== HOME_NODE);
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await openDocumentTable(p);
        assert.equal(await p.locator('#center .pair').count(), 2);
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair.off-map input').count(), 0);
        await p.check(`${bulk} input.pick-all`);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (1)');
      })));
});

test('in a browser, several pairs of one untagged test are included in one go, each as its own judgment file', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);

        assert.deepEqual(judgedBy(config), [
          [LIST_NODE, 'hand-over', '', 'reviewer'],
          [HOME_NODE, 'hand-over', '', 'reviewer'],
        ]);
        const files = (fs.readdirSync(config.judgmentsDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.json'));
        assert.equal(files.length, 2);
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['태그 대기', '태그 대기']);
        assert.equal(await p.locator(pick).count(), 0);
        assert.equal(await p.locator(bulk).count(), 0);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        assert.match((await p.textContent('#center .awaiting-tag'))!, /DocumentTable › lists the documents it is given/);
        assert.doesNotMatch((await p.textContent('#center'))!, /불러오는 테스트/);
      })));
});

test('in a browser, several pairs of one untagged test are discarded in one go with one reason, asked for in a window that lists the picked screens', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        assert.equal(await p.textContent(`${asked} h2`), '짝 2개를 제외합니다');
        assert.match((await p.textContent(`${asked} .subject`))!, /lists the documents it is given.*DocumentTable/s);
        assert.deepEqual(await p.locator(`${asked} .subject li`).allTextContents(), ['/document/:tab(draft|done) DocumentList', '/home Home']);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '제외 (2)']);
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${bulk} .bulk-error`).count(), 0);

        await p.press(why, 'Control+Enter');
        assert.equal(fs.existsSync(config.judgmentsDir), false);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);

        await p.fill(why, 'only lists documents');
        await p.press(why, 'Control+Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 2);
        assert.deepEqual(judgedBy(config), [
          [LIST_NODE, 'discard', 'only lists documents', 'reviewer'],
          [HOME_NODE, 'discard', 'only lists documents', 'reviewer'],
        ]);
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(await p.locator(bulk).count(), 0);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        assert.equal(await p.textContent('#center .discarded h2'), '제외한 짝 1');
        assert.equal(await p.locator('#center .importers').filter({ hasText: 'DocumentTable' }).count(), 0);
      })));
});

test('in a browser, the window asking for a reason is put away with 「취소」 or Escape and not by a click outside it, the reason typed goes with it and nothing is sent', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        const focusedButton = () => p.evaluate(() => [document.activeElement!.closest('.bulk-bar, .judge-row')?.className, document.activeElement!.className]);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        await p.fill(why, 'typed and dropped');
        await p.mouse.click(5, 5);
        assert.equal(await p.locator(asked).isVisible(), true);
        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(await focusedButton(), ['bulk-bar', 'discard']);

        await p.click(`${bulk} button.discard`);
        assert.equal(await p.inputValue(why), '');
        await p.click(`${asked} button.cancel`);
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(await focusedButton(), ['bulk-bar', 'discard']);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        const row = p.locator('#center .importers .importer', { hasText: 'DocumentTable' }).locator('.judge-row');
        await row.locator('button.discard').click();
        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(await focusedButton(), ['judge-row', 'discard']);
        assert.equal(fs.existsSync(config.judgmentsDir), false);
      })));
});

test('in a browser, while a discard is being saved the window stays open and locked, Ctrl+Enter and Escape do nothing, and one discard is saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let held!: Route;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          held = route;
        });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await first.locator('button.discard').click();
        await p.fill(why, 'only renders a shared header');
        await p.press(why, 'Control+Enter');
        await untilSet(() => held, 'the judgment request');

        assert.deepEqual(await p.$$eval(`${asked} button`, (list: HTMLButtonElement[]) => list.map((b) => b.disabled)), [true, true]);
        assert.equal(await p.locator(why).evaluate((el: HTMLTextAreaElement) => el.readOnly), true);
        await p.keyboard.press('Control+Enter');
        await p.keyboard.press('Escape');
        await p.keyboard.press('Escape');
        assert.equal(await p.locator(asked).isVisible(), true);
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.inputValue(why), 'only renders a shared header');
        await p.locator(`${asked} button.discard`).click({ force: true });
        assert.equal(calls, 1);

        await held.continue();
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(loadJudgments(config.judgmentsDir).judgments.length, 1);
      })));
});

test('in a browser, a discard that fails to save leaves the window open with its reason and the error, and saves when sent again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const refuse = (route: Route) => route.fulfill({ status: 500, body: 'disk full' });
        await p.route('**/api/judgments', refuse);
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await excludeIn(first, 'only renders a shared header');
        await p.locator(`${asked} .error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.equal(await p.textContent(`${asked} .error`), '저장하지 못했습니다: disk full');
        assert.equal(await p.inputValue(why), 'only renders a shared header');
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), false);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await p.unroute('**/api/judgments', refuse);
        await p.press(why, 'Control+Enter');
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.reason), ['only renders a shared header']);

        await p.locator('#center .importers .importer').first().locator('button.discard').click();
        assert.equal(await p.locator(`${asked} .error`).isVisible(), false);
      })));
});

test('in a browser, 「제외」 does not ask for a reason while the 「포함」 of the same row is being saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let held!: Route;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await first.locator('button.hand-over').click();
        await untilSet(() => held, 'the judgment request');
        await first.locator('button.discard').click();
        assert.equal(await p.locator(asked).isVisible(), false);
        await held.continue();
        await p.waitForSelector('#center .awaiting-tag');
      })));
});

test('in a browser, a judgment of another row that ends while a reason is being typed leaves the focus and the typing in the window', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        let held!: Route;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const rows = p.locator('#center .importers .importer');
        await rows.nth(0).locator('button.hand-over').click();
        await untilSet(() => held, 'the judgment request');
        await rows.nth(1).locator('button.discard').click();
        await p.keyboard.type('second row re');
        await held.fulfill({ status: 500, body: 'disk full' });
        await rows.nth(0).locator('.judgment-error').waitFor();
        await p.keyboard.type('ason');
        assert.equal(await p.inputValue(why), 'second row reason');
        assert.equal(await askedFocused(p), true);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

test('in a browser, every pair judged in bulk is undone one at a time from its screen', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        await p.click('#center .awaiting-tag button.undo');
        await p.waitForSelector('#center .awaiting-tag', { state: 'detached' });
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['hand-over', 'hand-over', 'undo']);

        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['태그 대기', '불러옴']);
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair-row', { hasText: '/home' }).locator('input.pick').count(), 1);
      })));
});

test('in a browser, the pick survives a redraw, goes when another test is chosen, and drops a pair that is judged elsewhere', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        await p.fill(why, 'typed reason');
        await p.evaluate(() => render());
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
        assert.equal(await p.inputValue(why), 'typed reason');
        await p.click(`${asked} button.cancel`);

        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: HOME_NODE, kind: 'discard', reason: 'judged elsewhere', author: 'someone' });
        await p.evaluate(async () => { await load(); render(); });
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (1)');

        await p.click('#untagged-list li:has-text("loads the detail screen only when it is needed")');
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 0);
        assert.deepEqual(await p.locator(`${bulk} button`).allTextContents(), ['제외 (0)', '포함 (0)']);
      })));
});

test('in a browser, a bulk save that fails midway stops, keeps the unsaved pairs picked and says which pairs were saved and which were not', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        const refuse = async (route: Route) => {
          calls += 1;
          if (calls === 2) await route.fulfill({ status: 500, body: 'disk full' });
          else await route.continue();
        };
        await p.route('**/api/judgments', refuse);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();

        assert.equal(calls, 2);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.deepEqual(judgedBy(config), [[LIST_NODE, 'hand-over', '', 'reviewer']]);
        const message = (await p.textContent(`${bulk} .bulk-error`))!;
        assert.match(message, /^저장하지 못했습니다: disk full\n저장한 짝 1: /);
        assert.match(message, /저장한 짝.*\/document\/:tab\(draft\|done\)/s);
        assert.match(message, /저장하지 못한 짝.*\/home/s);
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['태그 대기', '불러옴']);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator('#center .pair-row', { hasText: '/home' }).locator('input.pick').isChecked(), true);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), false);
        await p.click(`${bulk} button.discard`);
        assert.equal(await p.textContent(`${bulk} .bulk-error`), message);
        await p.click(`${asked} button.cancel`);
        assert.equal(await p.textContent(`${bulk} .bulk-error`), message);

        await p.unroute('**/api/judgments', refuse);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.equal(await p.locator(`${bulk} .bulk-error`).count(), 0);
        assert.equal(judgedBy(config).length, 2);
      })));
});

test('in a browser, the bulk controls stay disabled while the requests are in flight', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        let held!: Route;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 1) held = route;
          else route.continue();
        });
        await p.check(`${bulk} input.pick-all`);
        await excludePicked(p, 'only lists documents');
        await untilSet(() => held, 'the first judgment request');
        for (const sel of [`${bulk} button.discard`, `${bulk} button.hand-over`, `${bulk} input.pick-all`, pick, `${asked} button.discard`, `${asked} button.cancel`]) {
          assert.equal(await p.locator(sel).first().isDisabled(), true, sel);
        }
        assert.equal(await p.locator(why).evaluate((el: HTMLTextAreaElement) => el.readOnly), true);
        await p.locator(`${asked} button.discard`).click({ force: true });
        await p.press(why, 'Control+Enter');
        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), true);
        assert.equal(calls, 1);
        await held.continue();
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 2);
        assert.equal(judgedBy(config).length, 2);
      })));
});

test('in a browser, nothing leaves the test while a bulk is in flight, and the report of a bulk that fails midway is there when it ends', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const ended: string[] = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        let held!: Route;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 1) held = route;
          else route.fulfill({ status: 500, body: 'disk full' });
        });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await untilSet(() => held, 'the first judgment request');

        for (const sel of ['#left .views.side button', '#view-list', '#view-flow', '#end-review']) {
          for (const el of await p.locator(sel).all()) assert.equal(await el.isDisabled(), true, sel);
        }
        const style = (sel: string, prop: keyof CSSStyleDeclaration) => p.locator(sel).first().evaluate((el, name) => getComputedStyle(el)[name], prop);
        const otherTest = '#untagged-list li:has-text("loads the detail screen only when it is needed")';
        const homePair = '#center .pair:has-text("/home")';
        for (const sel of [otherTest, homePair]) {
          assert.equal(await style(sel, 'cursor'), 'default', sel);
          assert.equal(await p.locator(sel).first().getAttribute('title'), null, sel);
        }
        const lineBefore = await style(homePair, 'borderColor');
        await p.hover(homePair, { force: true });
        assert.equal(await style(homePair, 'borderColor'), lineBefore);
        await p.hover(otherTest, { force: true });
        assert.equal(await style(otherTest, 'backgroundColor'), 'rgba(0, 0, 0, 0)');

        await p.locator(otherTest).click({ force: true });
        assert.equal(await p.textContent('#untagged-list li.selected .title'), DOCUMENT_TABLE.title);
        assert.equal(await p.textContent('#center h3'), DOCUMENT_TABLE.title);
        await p.locator(homePair).click({ force: true });
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.locator(`${bulk} button.hand-over`).count(), 1);
        await p.locator('#left .views.side button:not(.on)').first().click({ force: true });
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        await p.locator('#view-flow').click({ force: true });
        assert.equal(await p.locator('main').isVisible(), true);
        await p.locator('#end-review').click({ force: true });
        assert.deepEqual(ended, []);

        await held.continue();
        await p.locator(`${bulk} .bulk-error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.match((await p.textContent(`${bulk} .bulk-error`))!, /저장한 짝 1.*\/document\/:tab\(draft\|done\).*저장하지 못한 짝 1.*\/home/s);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        assert.equal(await p.locator('#view-flow').isDisabled(), false);
        assert.equal(await p.locator('#left .views.side button').first().isDisabled(), false);
        assert.deepEqual(ended, []);
      })));
});

test('in a browser, while the end request is pending a bulk cannot start and the end button cannot be pressed twice, and a refused end unlocks both', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const ended = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        const judged: string[] = [];
        p.on('request', (r) => r.url().endsWith('/api/judgments') && judged.push(r.url()));
        let held!: Route;
        await p.route('**/api/end', (route) => { held = route; });
        await p.check(`${bulk} input.pick-all`);
        await p.click('#end-review');
        await untilSet(() => held, 'the end request');

        assert.equal(await p.locator('#end-review').isDisabled(), true);
        for (const kind of ['hand-over', 'discard']) {
          assert.equal(await p.locator(`${bulk} button.${kind}`).isDisabled(), true, kind);
          await p.locator(`${bulk} button.${kind}`).click({ force: true });
        }
        await p.locator('#end-review').click({ force: true });
        assert.deepEqual(judged, []);
        assert.equal(ended.length, 1);

        await held.fulfill({ status: 500, body: 'cannot end' });
        await p.waitForFunction(() => !(document.getElementById('end-review') as HTMLButtonElement).disabled);
        assert.match((await p.textContent('#end-error'))!, /cannot end/);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), false);
        assert.equal(await p.locator(`${bulk} button.discard`).isDisabled(), false);
        errors.splice(0);
        await p.unroute('**/api/end');
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.equal(judged.length, 2);
      })));
});

test('in a browser, the bulk buttons are locked in place while 「리뷰 끝」 is being sent, so the checkbox that was toggled keeps the focus', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const buttons = `${bulk} button`;
        const picked = `${pick}[data-pair="${LIST_NODE}"]`;
        const disabled = () => p.$$eval(buttons, (list: HTMLButtonElement[]) => list.map((b) => b.disabled));
        let held!: Route | null;
        await p.route('**/api/end', (route) => { held = route; });
        const refuseEnd = async () => {
          held = null;
          await p.evaluate(() => document.getElementById('end-review')!.click());
          await untilSet(() => held, 'the end request');
          assert.deepEqual(await disabled(), [true, true]);
          await held!.fulfill({ status: 500, body: 'cannot end' });
          await p.waitForFunction(() => /cannot end/.test(document.getElementById('end-error')!.textContent));
        };

        await p.check(picked);
        await p.$eval(picked, (el: HTMLInputElement & Kept) => { el.kept = true; });
        await refuseEnd();
        assert.deepEqual(await disabled(), [false, false]);
        assert.equal(await p.evaluate((sel) => document.activeElement!.matches(sel) && (document.activeElement as Element & Kept).kept, picked), true);

        await p.uncheck(picked);
        await refuseEnd();
        assert.deepEqual(await p.locator(buttons).allTextContents(), ['제외 (0)', '포함 (0)']);
        assert.deepEqual(await disabled(), [true, true]);
        assert.deepEqual(errors.splice(0), [...SAVE_REFUSED, ...SAVE_REFUSED]);
      })));
});

test('in a browser, the keyboard focus goes back to the bulk button that was pressed once the bulk ends, to the first control of the bar when that button is off, and stays in the window while a discard is not saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const active = () => p.evaluate(() => document.activeElement!.className);
        const pressEnterOn = async (sel: string) => {
          await p.focus(sel);
          await p.keyboard.press('Enter');
        };
        await p.check(`${pick}[data-pair="${LIST_NODE}"]`);
        await pressEnterOn(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 1);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), true);
        assert.equal(await active(), 'pick-all');

        await p.check(`${pick}[data-pair="${HOME_NODE}"]`);
        await pressEnterOn(`${bulk} button.discard`);
        assert.equal(await askedFocused(p), true);

        const refuse = (route: Route) => route.fulfill({ status: 500, body: 'disk full' });
        await p.route('**/api/judgments', refuse);
        await p.keyboard.type('only lists documents');
        await p.keyboard.press('Control+Enter');
        await p.locator(`${asked} .error`).waitFor();
        assert.match((await p.textContent(`${asked} .error`))!, /disk full/);
        assert.equal(await askedFocused(p), true);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        await p.keyboard.press('Escape');
        assert.equal(await active(), 'discard');

        await p.unroute('**/api/judgments', refuse);
        await pressEnterOn(`${bulk} button.discard`);
        await p.keyboard.type('only lists documents');
        await p.keyboard.press('Control+Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 1);
        assert.equal(await p.locator(bulk).count(), 0);
        assert.equal(await p.evaluate(() => document.activeElement!.matches('#center .test-pairs h2')), true);
      })));
});

test('in a browser, a bulk that ends while the reviewer types in the search box leaves the focus and the typing there', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let held!: Route;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 1) held = route;
          else route.fulfill({ status: 500, body: 'disk full' });
        });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await untilSet(() => held, 'the first judgment request');
        const search = '#left input[type=search]';
        await p.click(search);
        await p.keyboard.type('Document');
        await p.$eval(search, (el: HTMLInputElement & Kept) => { el.kept = true; });
        await held.continue();
        await p.locator(`${bulk} .bulk-error`).waitFor();
        assert.equal(await p.evaluate((sel) => document.activeElement!.matches(sel) && (document.activeElement as Element & Kept).kept, search), true);
        await p.keyboard.type(' Table');
        assert.equal(await p.inputValue(search), 'Document Table');
        assert.equal(calls, 2);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

test('in a browser, a bulk that judges every pair moves the keyboard focus to the heading of the pairs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.focus(`${bulk} button.hand-over`);
        await p.keyboard.press('Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.equal(await p.locator(bulk).count(), 0);
        assert.equal(await p.evaluate(() => document.activeElement!.matches('#center .test-pairs h2')), true);
      })));
});

test('in a browser, a pair saved by a bulk is not picked any more even when reading the data again fails, so a retry sends only the unsaved pairs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        const refuse = (route: Route) => {
          calls += 1;
          if (calls === 2) route.fulfill({ status: 500, body: 'disk full' });
          else route.continue();
        };
        const unreadable = (route: Route) => route.fulfill({ status: 500, body: 'data gone' });
        await p.route('**/api/judgments', refuse);
        await p.route('**/api/data', unreadable);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();

        assert.equal(errors.splice(0).length, 2);
        const message = (await p.textContent(`${bulk} .bulk-error`))!;
        assert.match(message, /저장했지만 다시 읽지 못했습니다: data gone/);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator('#center .pair-row', { hasText: '/home' }).locator('input.pick').isChecked(), true);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (1)');

        await p.unroute('**/api/judgments', refuse);
        await p.unroute('**/api/data', unreadable);
        const sent: string[] = [];
        await p.route('**/api/judgments', (route) => {
          sent.push(route.request().postDataJSON().node);
          route.continue();
        });
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.deepEqual(sent, [HOME_NODE]);
        assert.equal(judgedBy(config).length, 2);
      })));
});

test('in a browser, the message of a failed bulk puts the report in its own line, and says "saved" only when a pair was saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        await p.route('**/api/judgments', (route) => route.fulfill({ status: 500, body: 'disk full' }));
        await p.route('**/api/data', (route) => route.fulfill({ status: 500, body: 'data gone' }));
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();

        errors.splice(0);
        const lines = (await p.textContent(`${bulk} .bulk-error`))!.split('\n');
        assert.equal(lines.length, 3);
        assert.match(lines[0], /^저장하지 못했습니다: disk full$/);
        assert.match(lines[1], /^저장한 짝 0: 없음\. 저장하지 못한 짝 2: /);
        assert.equal(lines[2], '다시 읽지 못했습니다: data gone');
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
      })));
});

test('in a browser, a bulk discard that fails midway leaves the window open with the report, the reason and only the pairs not saved, and the rest is saved when sent again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        const refuse = async (route: Route) => {
          calls += 1;
          if (calls === 2) await route.fulfill({ status: 500, body: 'disk full' });
          else await route.continue();
        };
        await p.route('**/api/judgments', refuse);
        await p.check(`${bulk} input.pick-all`);
        await excludePicked(p, 'only lists documents');
        await p.locator(`${asked} .error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);

        const message = (await p.textContent(`${asked} .error`))!;
        assert.match(message, /^저장하지 못했습니다: disk full\n저장한 짝 1: .*저장하지 못한 짝 1: \/home/s);
        assert.equal(await p.textContent(`${bulk} .bulk-error`), message);
        assert.equal(await p.textContent(`${asked} h2`), '이 짝을 제외합니다');
        assert.deepEqual(await p.locator(`${asked} .subject li`).allTextContents(), ['/home Home']);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '제외']);
        assert.equal(await p.inputValue(why), 'only lists documents');
        assert.equal(await askedFocused(p), true);
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['제외한 짝', '불러옴']);

        await p.unroute('**/api/judgments', refuse);
        await p.press(why, 'Control+Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 2);
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(judgedBy(config).map((j) => j.slice(1, 3)), [['discard', 'only lists documents'], ['discard', 'only lists documents']]);
      })));
});

test('in a browser, the failure report and the picks of a bulk survive opening a pair\'s screen and coming back, and a click on the same test', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 2) route.fulfill({ status: 500, body: 'disk full' });
          else route.continue();
        });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();
        errors.splice(0);
        const message = await p.textContent(`${bulk} .bulk-error`);

        const intact = async () => {
          assert.equal(await p.textContent(`${bulk} .bulk-error`), message);
          assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        };
        await p.locator('#center .pair', { hasText: '/document/' }).click();
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await intact();
        await p.click('#untagged-list li:has-text("DocumentTable")');
        await intact();

        await p.click('#untagged-list li:has-text("loads the detail screen only when it is needed")');
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.equal(await p.locator(`${bulk} .bulk-error`).count(), 0);
      })));
});

test('in a browser, picking a pair redraws only the middle and keeps the keyboard focus on the checkbox that was toggled', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.evaluate(() => { document.querySelector<HTMLElement>('#untagged-list li')!.dataset.kept = 'yes'; });
        await p.locator(pick).nth(1).focus();
        await p.keyboard.press('Space');
        assert.equal(await p.evaluate(() => {
          const el = document.activeElement as HTMLInputElement;
          return el.matches('input.pick') && el.checked && [...document.querySelectorAll('input.pick')].indexOf(el);
        }), 1);
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (1)');
        assert.equal(await p.evaluate(() => document.querySelector<HTMLElement>('#untagged-list li')!.dataset.kept), 'yes');

        await p.locator(`${bulk} input.pick-all`).focus();
        await p.keyboard.press('Space');
        assert.equal(await p.evaluate(() => document.activeElement!.matches('input.pick-all')), true);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
      })));
});

test('in a browser, a judgment on a call pair that fails after the call details were closed opens them again and shows the error under the pair', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/judgments')
            ? new Promise((resolve, reject) => { (window as unknown as FailSave).failSave = () => reject(new Error('disk full')); })
            : real(url, init));
        });
        const details = p.locator('#center .call-info');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls tr', { hasText: DETAIL_CALL }).first().locator('td.cell').first().click();
        await details.locator('.pair-test button.hand-over').first().click();
        await closeCallInfo(p);
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), false);
        await p.evaluate(() => (window as unknown as FailSave).failSave());
        await p.waitForSelector('#center .call-info .judgment-error');
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), true);
        assert.ok(await details.locator('.judgment-error').isVisible());
        assert.match((await details.locator('.judgment-error').textContent())!, /저장하지 못했습니다: disk full/);
      })));
});
