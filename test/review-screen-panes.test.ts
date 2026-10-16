import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { addMark, addReply, loadMarks } from '../src/marks.ts';
import { taskList } from '../src/tasks.ts';
import { withRebuiltFixture, withServer, postMark, browserMissing, toList, withPage, openScreenInfo, waitCallInfoInView, openDocumentScreenInShortViewport, insideRightPane, withLabLinks, screenBox, needTag, closeCallInfo } from './review-helpers.ts';
import type { PageData } from './review-helpers.ts';

declare function load(): Promise<void>;
declare function render(): void;
declare function hasUnsavedMark(): boolean;

test('in a browser, a screen that opens only under a role or a setting shows its tests for each case under what it needs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const cases = p.locator('#center .screen-info > .cases li');
        const counts = async () => (await cases.locator('.step-tests').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
        await p.click('#screen-list li:has-text("/admin/member")');
        await openScreenInfo(p);
        assert.equal(await p.textContent('#center .screen-info > .cases h2'), '경우별 테스트');
        assert.deepEqual(await cases.locator('.case').allTextContents(), ['역할 ADMIN — 열림', '여는 역할이 아닌 역할 — 막힘']);
        assert.deepEqual(await counts(), ['UI/E2E ✓1', 'UI/E2E ✓1']);
        await p.click('#screen-list li:has-text("/help")');
        assert.deepEqual(await cases.locator('.case').allTextContents(), ['설정 SYSTEM.HELP_LINK_ENABLED 맞춤 — 열림', '설정 SYSTEM.HELP_LINK_ENABLED 맞추지 않음 — 막힘']);
        assert.deepEqual(await counts(), ['UI/E2E ✕1', '테스트 없음']);
        await p.click('#screen-list li:has-text("/signin")');
        assert.equal(await p.locator('#center .screen-info > .cases').count(), 0);
      }),
    ),
  );
});

test('in a browser, the screen info in the middle pane starts with what opens the chosen screen under 「접근 조건」, the name carries 「역할」 and 「설정」 as the flow box does, and it is the same when the screen is picked in the flow', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await openScreenInfo(p);
        const summaryOf = async (label: string) => {
          await p.click(`#screen-list li:has-text("${label}")`);
          assert.equal(await p.locator('#center .screen-info > summary + *').evaluate((e) => e.className), 'open-needs');
          assert.equal(await p.textContent('#center .open-needs h2'), '접근 조건');
          return [await p.locator('#center .open-needs .need').allTextContents(), await p.locator('#center-head .need-kinds .chip').allTextContents()];
        };
        const report = await summaryOf('/admin/report');
        const group = await summaryOf('/admin/group');
        await p.click('#screen-list li:has-text("/signin")');
        assert.equal(await p.locator('#center .open-needs p').innerText(), '설정이나 역할 없이 열립니다.');
        assert.equal(await p.locator('#center-head .need-kinds .chip').count(), 0);
        assert.equal(await p.locator('#right .open-needs').count(), 0);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.deepEqual(report, [['역할 ADMIN 외 1', '설정 "ADMIN_REPORT" (ADMIN.LIST 에) 외 1'], ['역할', '설정']]);
        assert.deepEqual(group[1], ['역할']);
        for (const [id, words] of [['/admin/report#AdminReport', report], ['/admin/group#AdminGroup', group]] as const) {
          const box = await screenBox(p, id);
          assert.deepEqual([(await needTag(box)).join('·')], [words[1].join('·')]);
          await box.click();
          assert.equal(await p.locator('#center .screen-info').getAttribute('open'), '');
          assert.deepEqual([await p.locator('#center .open-needs .need').allTextContents(), await p.locator('#center-head .need-kinds .chip').allTextContents()], words);
          assert.equal(await p.locator('#right .open-needs').count(), 0);
        }
      }),
    ),
  );
});

test('in a browser, the right pane of a screen holds only the conversation above the form, and the screen info folded under the tables of the middle pane names its counts and reads in order once opened', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.deepEqual(await p.locator('#right-info h2').allTextContents(), ['에이전트와 대화']);
        for (const gone of ['.open-needs', '.access', '.cases', '.target-id', '.history-toggle']) assert.equal(await p.locator(`#right ${gone}`).count(), 0, gone);
        assert.equal(await p.locator('#right > :last-child').evaluate((e) => e.id), 'right-dock');
        assert.equal(await p.locator('#right-dock > .mark-form').count(), 1);
        assert.equal(await p.textContent('#right .mark-form .tags .tag-label'), '화면 전체');

        const info = p.locator('#center .screen-info');
        assert.equal(await p.locator('#center-body > :last-child').evaluate((e) => e.className), 'screen-info');
        assert.ok(await p.locator('#center-body table.calls ~ .screen-info').count());
        assert.equal(await info.evaluate((e: HTMLDetailsElement) => e.open), false);
        const s = (await (await fetch(`${base}/api/data`)).json() as PageData).map.screens.find((x) => x.id === '/document/:id#DocumentDetail')!;
        assert.equal(await info.locator(':scope > summary').innerText(), `화면 정보 들어오는 링크 ${s.access.links.length} · 나가는 링크 ${s.links!.length} · 읽는 설정값 ${s.settingReads!.length}`);
        await info.locator(':scope > summary').click();
        const headings = await info.locator('h2').allTextContents();
        assert.deepEqual(headings.map((t) => t.replace(/ \d+$/, '')), ['접근 조건', '들어오는 링크', '소스 위치', '나가는 링크', '읽는 설정값']);

        await p.locator('table.calls td.cell').first().click();
        assert.deepEqual(await p.locator('#right-info h2').allTextContents(), ['에이전트와 대화']);
        assert.equal(await p.locator('#right-dock > .mark-form').count(), 1);
        assert.equal(await p.locator('#right h2:has-text("서버 대조")').count(), 0);
      }),
    ),
  );
});

test('in a browser, the screen info lists the cases after the access conditions and the in-screen conditions between the incoming links and the source location', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    await open();
    await openScreenInfo(p);
    const headings = (await p.locator('#center .screen-info h2').allTextContents()).map((t) => t.replace(/ \d+$/, '').replace(/^(화면 안 조건) — .*$/, '$1'));
    assert.deepEqual(headings, ['접근 조건', '경우별 테스트', '들어오는 링크', '화면 안 조건', '소스 위치', '나가는 링크', '읽는 설정값']);
  });
});

test('in a browser, the opened screen info stays open on other screens, on a redraw and when a screen is picked in the flow', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const isOpen = () => p.locator('#center .screen-info').evaluate((e: HTMLDetailsElement) => e.open);
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#center .screen-info > summary');
        assert.equal(await isOpen(), true);
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await isOpen(), true);
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.waitForSelector('#screen-list li.selected .chip.missing');
        assert.equal(await isOpen(), true);
        await p.click('#view-flow');
        await (await screenBox(p, '/lab#Lab')).click();
        assert.equal(await isOpen(), true);
        await p.click('#center .screen-info > summary');
        await (await screenBox(p, '/help#Help')).click();
        assert.equal(await isOpen(), false);
      }),
    ),
  );
});

const callInfoInView = (p: Page) => p.evaluate(() => {
  const pane = document.getElementById('center')!.getBoundingClientRect();
  const summary = document.querySelector('#center .call-info > summary')?.getBoundingClientRect();
  return !!summary && summary.top >= pane.top - 0.5 && summary.bottom <= pane.bottom + 0.5;
});

test('in a browser, choosing a call near the top of a long call table scrolls only the middle pane until its details are in view', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 500 });
        await p.click('#screen-list li:has-text("/admin/report")');
        const firstCell = p.locator('table.calls tbody tr:not(.option)').first().locator('td.cell').first();
        await firstCell.scrollIntoViewIfNeeded();
        const before = await p.locator('#center').evaluate((e) => e.scrollTop);
        await firstCell.click();
        await waitCallInfoInView(p);
        assert.ok((await p.locator('#center').evaluate((e) => e.scrollTop)) > before + 100, 'the call info started below the visible part of the pane');
        assert.equal(await p.evaluate(() => document.scrollingElement!.scrollTop), 0);

        await p.locator('#center').evaluate((e) => { e.scrollTop = 0; });
        await p.emulateMedia({ reducedMotion: 'reduce' });
        await p.locator('table.calls tbody tr:not(.option)').nth(1).locator('td.cell').first().click();
        assert.ok(await callInfoInView(p), 'with reduced motion the pane jumps at once');
      }),
    ),
  );
});

test('in a browser, choosing another cell of a call whose info is closed keeps the fold closed and does not scroll the middle pane', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 500 });
        await p.emulateMedia({ reducedMotion: 'reduce' });
        await p.click('#screen-list li:has-text("/admin/report")');
        const cells = p.locator('table.calls tbody tr:not(.option)').first().locator('td.cell');
        await cells.first().click();
        await closeCallInfo(p);
        const depthCell = cells.nth(1);
        await depthCell.evaluate((e) => e.scrollIntoView({ block: 'start' }));
        assert.equal(await callInfoInView(p), false, 'the closed call info is below the visible part of the pane');
        const kept = await p.locator('#center').evaluate((e) => e.scrollTop);
        await depthCell.click();
        assert.match((await depthCell.getAttribute('class'))!, /\bselected\b/);
        assert.match(await p.locator('#center .call-info .target-id strong').innerText(), / 깊이$/);
        assert.equal(await p.locator('#center .call-info').evaluate((e: HTMLDetailsElement) => e.open), false);
        assert.equal(await p.locator('#center').evaluate((e) => e.scrollTop), kept, 'a closed call info is not scrolled to');
      }),
    ),
  );
});

test('in a browser, choosing a call shows its details open under the call table of the middle pane, naming the call and the option and depth they are for, and a closed one opens again on another call', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await p.locator('#center .call-info').count(), 0);
        await p.locator('table.calls tr.option', { hasText: 'withAttachments 켬' }).first().locator('td.cell').nth(1).click();
        const details = p.locator('#center .call-info');
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), true);
        assert.ok(await p.locator('#center-body table.calls + .call-info + .screen-info').count());
        const head = details.locator(':scope > summary .target-id');
        assert.equal(await head.locator('.mono').textContent(), 'POST:/api/v1/report/export');
        assert.match(await head.innerText(), /withAttachments 켬 · UI\/E2E 깊이/);
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /^withAttachments 켬 · UI\/E2E 깊이$/);
        assert.deepEqual((await details.locator('h2').allTextContents()).map((t) => t.replace(/ \d+$/, '')), ['옵션을 찾은 자리', '서버 대조', '테스트', '이 화면에서 부르는 곳', '이 호출을 쓰는 화면']);
        assert.deepEqual(await p.locator('#right-info h2').allTextContents(), ['에이전트와 대화']);

        await p.locator('table.calls td.cell').first().click();
        assert.match(await details.locator(':scope > summary').innerText(), /POST:\/api\/v1\/report\/export\s+호출 전체/);
        await details.locator(':scope > summary').click();
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), false);
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), false);
        await p.locator('table.calls tbody tr:not(.option)').nth(1).locator('td.cell').first().click();
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), true);

        await p.click('#screen-list li:has-text("/home")');
        assert.equal(await p.locator('#center .call-info').count(), 0);
        assert.equal(await p.locator('#right .target-id').count(), 0);
      }),
    ),
  );
});
const scrollRightToBottom = (p: Page) => p.locator('#right-info').evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
const scrollRightTo = (p: Page, top: number) => p.locator('#right-info').evaluate((el, y) => { el.scrollTop = y; return el.scrollTop; }, top);
const rightScroll = (p: Page) => p.locator('#right-info').evaluate((el) => el.scrollTop);

test('in a browser, choosing another screen or call target opens the right pane at its top, and redrawing the same target keeps the scroll offset', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p, base);
        const firstCall = p.locator('table.calls tbody tr:not(.option)').nth(0).locator('td.cell');
        const secondCall = p.locator('table.calls tbody tr:not(.option)').nth(1).locator('td.cell');

        assert.ok((await scrollRightToBottom(p)) > 0);
        await firstCall.first().click();
        assert.equal(await rightScroll(p), 0);

        assert.ok((await scrollRightToBottom(p)) > 0);
        await secondCall.first().click();
        assert.equal(await rightScroll(p), 0);

        const kept = await scrollRightToBottom(p);
        assert.ok(kept > 0);
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await rightScroll(p), kept);
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.missing');
        assert.equal(await rightScroll(p), kept);

        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await rightScroll(p), 0);
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.ok((await scrollRightToBottom(p)) > 0);
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await rightScroll(p), 0);
      }),
    ),
  );
});

test('in a browser, choosing another depth or option row of the same node keeps the right pane scroll offset, and choosing a call row resets it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p, base);
        const kept = await scrollRightTo(p, 100);
        assert.equal(kept, 100);
        await p.click('#center tr:has-text("API")');
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /API 깊이/);
        assert.equal(await rightScroll(p), kept);
        await p.click('#center tr:has-text("UI/E2E")');
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /UI\/E2E 깊이/);
        assert.equal(await rightScroll(p), kept);

        await p.locator('table.calls tbody tr:not(.option)').nth(0).locator('td.cell').first().click();
        const call = await scrollRightTo(p, 100);
        assert.equal(call, 100);
        await p.locator('table.calls tbody tr:not(.option)').nth(0).locator('td.cell').nth(2).click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, / 깊이$/);
        assert.equal(await rightScroll(p), call);
        await p.locator('table.calls tbody tr:not(.option)').nth(1).locator('td.cell').first().click();
        assert.equal(await rightScroll(p), 0);

        await p.click('#screen-list li:has-text("/admin/report")');
        await p.locator('table.calls td.cell').first().click();
        const exported = await scrollRightTo(p, 100);
        assert.equal(exported, 100);
        await p.locator('table.calls tr.option', { hasText: 'withAttachments 켬' }).first().locator('td.cell').first().click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /withAttachments 켬/);
        assert.equal(await rightScroll(p), exported);
      }),
    ),
  );
});

test('in a browser, selecting another story opens the right pane at its top', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.setViewportSize({ width: 1440, height: 360 });
        await p.click('#view-story');
        const stories = p.locator('#story-list li');
        await stories.nth(0).click();
        assert.ok((await scrollRightToBottom(p)) > 0);
        await stories.nth(1).click();
        assert.equal(await rightScroll(p), 0);
        const kept = await scrollRightToBottom(p);
        assert.ok(kept > 0);
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await rightScroll(p), kept);
      }),
    ),
  );
});
const topOf = (p: Page, selector: string) => p.locator(selector).evaluate((e) => e.getBoundingClientRect().top);

async function assertDockStaysPut(p: Page) {
  const info = p.locator('#right-info');
  assert.ok(await info.evaluate((e) => e.scrollHeight > e.clientHeight), 'the conversation part is taller than its box');
  for (const selector of ['#right .statuses', '#right button.save']) {
    assert.ok(await insideRightPane(p, selector), `${selector} is visible without scrolling`);
  }
  const before = [await topOf(p, '#right .statuses'), await topOf(p, '#right button.save')];
  assert.ok((await scrollRightToBottom(p)) > 0);
  assert.deepEqual([await topOf(p, '#right .statuses'), await topOf(p, '#right button.save')], before);
  for (const selector of ['#right .statuses', '#right button.save']) assert.ok(await insideRightPane(p, selector));
}

test('in a browser, the status buttons and the save button stay in view at the bottom of the right pane while its conversation scrolls, for a screen and for a call', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p, base);
        await assertDockStaysPut(p);

        await p.locator('table.calls td.cell').first().click();
        assert.equal(await p.locator('#center .call-info .target-id').count(), 1);
        await assertDockStaysPut(p);
      }),
    ),
  );
});

test('in a browser, the status buttons and the save button stay in view at the bottom of the right pane for a story', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.setViewportSize({ width: 1440, height: 360 });
        await p.click('#view-story');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.textContent('#right .mark-form .tags .tag-label'), '스토리');
        await assertDockStaysPut(p);
        assert.equal(await p.locator('#right-info .mark-form').count(), 0);
      }),
    ),
  );
});

test('in a browser, the conversation of a screen is open from the start with no fold, fills the pane above the form, and a long answer scrolls inside it without being cut', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const node = '/document/:id#DocumentDetail';
    const first = addMark(config.marksDir, { target: { node }, note: 'first look', author: 'reviewer' }, new Date('2026-10-03T01:00:00Z'));
    addMark(config.marksDir, { target: { node }, status: 'fine', note: 'second look', author: 'reviewer' }, new Date('2026-10-03T02:00:00Z'));
    const answer = `the long answer ${'with many words '.repeat(120)}ends here`;
    addReply(config.marksDir, { replyTo: first.id, note: answer }, new Date('2026-10-03T01:30:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.equal(await p.locator('#right .history-toggle').count(), 0);
        const list = p.locator('#right-info .history');
        assert.equal(await list.isVisible(), true);
        assert.deepEqual(await p.locator('#right-info .history > li').allTextContents().then((ts) => ts.map((t) => /second look/.test(t) ? 'second' : /first look/.test(t) ? 'first' : t)), ['first', 'second']);
        assert.equal(await list.evaluate((e) => getComputedStyle(e).maxHeight), 'none');
        const reply = p.locator('#right-info .history .replies li', { hasText: 'ends here' });
        assert.equal(await reply.evaluate((e) => getComputedStyle(e).maxHeight), 'none');
        assert.ok((await reply.evaluate((e) => e.scrollHeight - e.clientHeight)) <= 0, 'the answer is shown whole');

        const g = await p.evaluate(() => {
          const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
          const info = document.getElementById('right-info')!;
          return { pane: rect('right'), info: rect('right-info'), dock: rect('right-dock'), scrolls: info.scrollHeight > info.clientHeight };
        });
        assert.ok(Math.abs(g.info.top - g.pane.top) < 1, 'the conversation starts at the top of the pane');
        assert.ok(Math.abs(g.info.bottom - g.dock.top) < 1, 'the form sits right under it');
        assert.ok(Math.abs(g.dock.bottom - g.pane.bottom) < 1, 'the form sits at the bottom of the pane');
        assert.ok(g.scrolls, 'the long conversation scrolls inside its part');
        await p.locator('#right-info').evaluate((e) => { e.scrollTop = e.scrollHeight; });
        assert.ok(await p.evaluate(() => Math.abs(document.querySelector('#right-info .talk-scope')!.getBoundingClientRect().top - document.getElementById('right-info')!.getBoundingClientRect().top) < 1), 'the conversation buttons stay at the top while it scrolls');
        assert.ok(await insideRightPane(p, '#right button.save'));

        await p.click('#right .statuses button:has-text("더 필요")');
        await p.click('#center tr:has-text("API")');
        assert.equal(await list.isVisible(), true);
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await p.locator('#right-info .history').count(), 0);
        assert.equal(await p.locator('#right-info h2').textContent(), '에이전트와 대화');
        assert.equal(await p.locator('#right-info p.muted').textContent(), '아직 대화가 없습니다.');
      }),
    );
  });
});

test('in a browser, the dock keeps the conversation part at least 120px tall on a short window and does not make the right pane itself scroll while both fit', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const node = '/document/:id#DocumentDetail';
        for (let i = 0; i < 6; i++) {
          assert.equal((await postMark(base, { target: { node }, status: 'fine', note: `look ${i} ${'long '.repeat(20)}`, author: 'reviewer' })).status, 201);
        }
        await p.setViewportSize({ width: 1440, height: 500 });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        const geometry = () => p.evaluate(() => {
          const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
          const right = document.getElementById('right')!;
          return { info: rect('right-info').height, dock: rect('right-dock').height, pane: rect('right'), dockBottom: rect('right-dock').bottom, overflow: right.scrollHeight - right.clientHeight };
        });
        const g = await geometry();
        assert.ok(g.dock <= g.pane.height * 0.65, `the dock takes ${g.dock}px of ${g.pane.height}px`);
        assert.ok(g.info >= 120, `conversation part ${g.info}px`);
        assert.ok(g.dockBottom <= g.pane.bottom + 0.5, 'the dock is fully inside the pane');
        assert.ok(g.overflow <= 0, `the pane itself overflows by ${g.overflow}px`);
        assert.ok(await insideRightPane(p, '#right button.save'));
        assert.ok(await p.locator('#right-info').evaluate((e) => e.scrollHeight > e.clientHeight), 'the conversation part scrolls');
        assert.ok((await p.locator('#right-dock textarea').evaluate((e) => getComputedStyle(e).maxHeight)) !== 'none');
      }),
    ),
  );
});

test('in a browser, on a window too short for the conversation part and the dock the right pane itself scrolls, so the save button can be reached and pressed', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 320 });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await insideRightPane(p, '#right button.save'), false);
        const heading = (await p.locator('#right-dock .mark-form .tags').boundingBox())!;
        await p.mouse.move(heading.x + 10, heading.y + heading.height / 2);
        await p.mouse.wheel(0, 400);
        for (let i = 0; i < 20 && !(await insideRightPane(p, '#right button.save')); i++) await p.waitForTimeout(50);
        assert.ok(await insideRightPane(p, '#right button.save'), 'the save button is brought inside the pane by scrolling it');
        await p.click('#right button.save');
        await p.waitForSelector('#screen-list li.selected .chip.missing');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]), [[{ node: '/document/:id#DocumentDetail' }, 'missing']]);
        assert.ok((await p.locator('#right').evaluate((e) => e.scrollTop)) > 0);
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await p.locator('#right').evaluate((e) => e.scrollTop), 0);
      }),
    ),
  );
});

const LONG_WORD = `a${'.verylongsegment'.repeat(14)}`;

test('in a browser, long addresses and conditions wrap inside the screen info, the call info and the right pane, none of which scrolls sideways', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        assert.equal((await postMark(base, { target: { node: '/document/:id#DocumentDetail' }, status: 'fine', note: LONG_WORD, author: 'reviewer' })).status, 201);
        const longId = `GET:/api/v1/${LONG_WORD}`;
        const labels = Array.from({ length: 5 }, (_, i) => `${LONG_WORD}-${i}`);
        await p.route('**/api/data', async (route) => {
          const text = (await (await route.fetch()).text()).replaceAll('GET:/api/v1/document/{documentId}', longId);
          const data: PageData = JSON.parse(text);
          const screen = data.map.screens.find((s) => s.id === '/document/:id#DocumentDetail')!;
          const file = `components/${LONG_WORD}.js`;
          screen.componentFile = file;
          screen.routeGuards = [LONG_WORD];
          screen.access.links = [
            { from: `/${LONG_WORD}#X`, file, line: 3, guards: [], fromKinds: [] },
            { from: `/${LONG_WORD}#Y`, file, line: 4, guards: [{ guard: LONG_WORD, kinds: [] }], fromKinds: [] },
          ];
          screen.links = [{ route: 'X', line: 2, to: `/${LONG_WORD}`, file, guards: [LONG_WORD], inheritedGuards: [{ via: LONG_WORD, line: 1, guards: [LONG_WORD] }] }];
          screen.settingReads = [{ key: LONG_WORD, line: 3, guards: [], file }];
          for (const c of screen.apiCalls) Object.assign(c, { fn: LONG_WORD, file });
          for (const c of data.map.calls) if (c.id === longId) c.server = { status: 'match', labels, path: `/api/v1/${LONG_WORD}` };
          await route.fulfill({ json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        const widths = () => p.locator('#right-info, #right-dock, #right, #center .screen-info, #center .call-info').evaluateAll((els) => els.map((el) => ({ id: el.id || el.className, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })));
        const block = (heading: string) => p.locator('#center h2', { hasText: heading }).locator('xpath=following-sibling::*[1]');
        const mentions = async (heading: string, selector: string) => assert.ok((await block(heading).locator(selector, { hasText: LONG_WORD }).count()) > 0, `${heading} shows the long text in ${selector}`);

        await p.click('#screen-list li:has-text("/document/:id")');
        await openScreenInfo(p);
        await p.locator('#center details.link-group').evaluateAll((gs: HTMLDetailsElement[]) => gs.forEach((g) => { g.open = true; }));
        await p.locator('#center details.long-guard').evaluateAll((gs: HTMLDetailsElement[]) => gs.forEach((g) => { g.open = true; }));
        await mentions('들어오는 링크', 'code.from');
        assert.ok((await p.locator('#center .access details.link-group code.full', { hasText: LONG_WORD }).count()) > 0, 'a long guard in an incoming link group');
        await mentions('화면 안 조건', 'code.full');
        await mentions('소스 위치', 'code');
        await mentions('나가는 링크', 'code');
        await mentions('나가는 링크', 'code.guard');
        await mentions('읽는 설정값', 'code');
        assert.ok((await p.locator('#right-info .history li', { hasText: LONG_WORD }).count()) > 0, 'a long mark note in the conversation');
        const screen = await widths();
        assert.equal(screen.length, 4);
        for (const w of screen) assert.ok(w.scrollWidth <= w.clientWidth, `screen ${w.id}: ${w.scrollWidth} of ${w.clientWidth}`);

        await p.locator('table.calls td.cell').first().click();
        assert.match((await p.textContent('#center .call-info .target-id'))!, new RegExp(LONG_WORD.replaceAll('.', '\\.')));
        await mentions('서버 대조', 'code');
        assert.equal(await block('서버 대조').locator('.chip').innerText(), `서버에 있음 (${labels.join(', ')})`);
        await mentions('이 화면에서 부르는 곳', 'code');
        const call = await widths();
        assert.equal(call.length, 5);
        for (const w of call) assert.ok(w.scrollWidth <= w.clientWidth, `call ${w.id}: ${w.scrollWidth} of ${w.clientWidth}`);
      }),
    ),
  );
});

test('in a browser, the chosen screen shows its calls with the server match and tests by depth, and a mark on a call depth reaches the task list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:tab")');
        assert.deepEqual(await p.locator('table.calls td.call .chip').allTextContents(), ['판정 불가', '서버에 없음']);
        assert.equal(await p.locator('table.calls tr:has-text("판정 불가") td.cell').count(), 0);

        await p.click('#screen-list li:has-text("/document/:id")');
        assert.deepEqual(await p.locator('table.calls td.call .chip').allTextContents(), ['서버에 있음 (core)', '메서드 불일치']);
        const rename = p.locator('table.calls tr', { hasText: 'PUT:/api/v1/document/{documentId}/name' });
        await rename.locator('td.cell').first().click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /호출 전체/);
        assert.equal(await p.locator('#center .call-info .test').count(), 1);
        assert.match((await p.textContent('#center .call-info .test'))!, /rename is refused by the server/);

        await rename.locator('td.cell').nth(2).click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /API 깊이/);
        assert.equal(await p.locator('#center .call-info .test').count(), 0);
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', 'no API test for the rename');
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.missing');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status, m.author]), [
          [{ node: 'PUT:/api/v1/document/{documentId}/name', depth: 'api' }, 'missing', 'reviewer'],
        ]);
        assert.match(taskList(config), /^## PUT:\/api\/v1\/document\/\{documentId\}\/name\n\n- marks:\n {2}- missing, api depth — "no API test for the rename" \(reviewer, \d{4}-\d\d-\d\d\)$/m);
      }),
    ),
  );
});

test('in a browser, each call shows on and off rows for its options and a no-option row, with empty option rows standing out', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/admin/report")');
        const label = (row: Locator) => row.locator('td.call > div:first-child').innerText();
        const rows = p.locator('table.calls tbody tr');
        const labels = [];
        for (let i = 0; i < (await rows.count()); i++) labels.push(await label(rows.nth(i)));
        assert.deepEqual(labels, [
          'POST:/api/v1/report/export',
          'withAttachments 켬', 'withAttachments 끔', 'withHistory 켬', 'withHistory 끔', '옵션 지정 없음',
          'POST:/api/v1/report/archive',
          'signedOnly 켬', 'signedOnly 끔', 'withHistory 켬', 'withHistory 끔', '옵션 지정 없음',
          'POST:/api/v1/report/schedule',
          'weekly 켬', 'weekly 끔', '옵션 지정 없음',
        ]);
        const gaps = [];
        for (const row of await p.locator('table.calls tr.option.gap').all()) gaps.push(await label(row));
        assert.deepEqual(gaps, ['withAttachments 끔', 'signedOnly 끔', 'withHistory 끔', 'weekly 켬', 'weekly 끔']);
        assert.equal(await p.locator('table.calls tr.option.gap td.cell').first().innerText(), '테스트 없음');
        assert.deepEqual(await p.locator('table.calls tr.option:has-text("weekly") .chip').allTextContents(), ['설정', '설정']);

        const exportRows = (text: string) => p.locator('table.calls tr.option').filter({ hasText: text }).first();
        assert.deepEqual(await exportRows('withHistory 켬').locator('td.cell').allInnerTexts(), ['✓2', '✓2', '—', '—', '—', '—', '—']);
        const none = exportRows('옵션 지정 없음');
        assert.equal(await none.locator('td.cell').count(), 0);
        assert.deepEqual(await none.locator('td.count').allInnerTexts(), ['✓2', '✓2', '—', '—', '—', '—', '—']);

        await exportRows('withHistory 켬').locator('td.cell').nth(1).click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /withHistory 켬 · UI\/E2E 깊이/);
        assert.equal(await p.locator('#center .call-info .test').count(), 2);
        assert.match(await p.locator('#center .call-info .option-sites').innerText(), /components\/ExportDialog\.js:18/);

        await exportRows('withHistory 켬').locator('td.cell').nth(6).click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /withHistory 켬 · 산출물 깊이/);
        assert.equal(await p.locator('#center .call-info .test').count(), 0);
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', 'Open the exported file.');
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.missing');

        await exportRows('withAttachments 끔').locator('td.cell').first().click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /withAttachments 끔$/);
        await p.click('#right .statuses button:has-text("더 필요")');
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.needs-more');

        await p.locator('table.calls tr.option').filter({ hasText: 'weekly 켬' }).locator('td.cell').first().click();
        assert.match(await p.locator('#center .call-info .option-sites').innerText(), /설정에 적음/);

        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status!] as const).sort((a, b) => a[1].localeCompare(b[1])), [
          [{ node: 'POST:/api/v1/report/export', option: { key: 'withHistory', value: true }, depth: 'output' }, 'missing'],
          [{ node: 'POST:/api/v1/report/export', option: { key: 'withAttachments', value: false } }, 'needs-more'],
        ]);
        const tasks = taskList(config);
        assert.match(tasks, /^ {2}- missing, withHistory=true at output depth — "Open the exported file\." \(reviewer, \d{4}-\d\d-\d\d\)$/m);
        assert.match(tasks, /^ {4}- withAttachments=false: no tests$/m);

        assert.equal((await postMark(base, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withComments', value: true } }, status: 'missing' })).status, 201);
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.match(await p.locator('#left ul.plain').innerText(), /POST:\/api\/v1\/report\/export withComments=true/);
      }),
    ),
  );
});

const RESULT_CALL = 'GET:/api/v1/document/{documentId}';
const RESULT_LINKS = [
  { from: 'POST:/api/v1/report/export', to: RESULT_CALL, note: '내보낸 파일을 연다' },
  { from: 'POST:/api/v1/archive/document', to: RESULT_CALL, note: '보관본을 연다' },
  { from: 'POST:/api/v1/report/weekly', to: RESULT_CALL, note: '주간 보고서를 연다' },
];
const OUTPUT_EXPORT_TESTS: [string, string, string][] = [
  ['results/playwright/export.json', '@call:POST:/api/v1/report/export @option:withHistory=true"', '@call:POST:/api/v1/report/export @option:withHistory=true @depth:output"'],
  ['results/playwright/export.json', '@option:withAttachments=true @option:withHistory=false"', '@option:withAttachments=true @option:withHistory=false @depth:output"'],
];

test('the page data carries the call links of the map and the links with a call missing from it', async () => {
  await withRebuiltFixture({ callLinks: RESULT_LINKS }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const { map } = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(map.callLinks, [RESULT_LINKS[1], RESULT_LINKS[0]]);
      assert.deepEqual(map.unknownCallLinks, [{ ...RESULT_LINKS[2], missing: ['POST:/api/v1/report/weekly'] }]);
    }),
  );
});

test('in a browser, a call whose result another call\'s options change shows those options under it with the other call\'s output-depth tests per value, a link to that call, and a missing call as off the map, and its rows take no mark', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ callLinks: RESULT_LINKS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/admin/report")');
        const exportRow = (text: string) => p.locator('table.calls tr.option').filter({ hasText: text }).first();
        const VALUES = ['withAttachments 켬', 'withAttachments 끔', 'withHistory 켬', 'withHistory 끔'];
        const fromOutputCells = [];
        for (const v of VALUES) fromOutputCells.push(await exportRow(v).locator('td.cell').nth(6).innerText());
        assert.deepEqual(fromOutputCells, ['✕1', '—', '✓1', '✕1']);

        await p.click('#screen-list li:has-text("/document/:id")');
        const rows = p.locator('table.calls tbody tr');
        const label = (row: Locator) => row.locator('td.call > div:first-child').innerText();
        const labels = [];
        for (let i = 0; i < (await rows.count()); i++) labels.push(await label(rows.nth(i)));
        assert.deepEqual(labels, [
          RESULT_CALL,
          '이 결과를 바꾸는 옵션 POST:/api/v1/archive/document', '옵션 없음',
          '이 결과를 바꾸는 옵션 POST:/api/v1/report/export', ...VALUES,
          '이 결과를 바꾸는 옵션 POST:/api/v1/report/weekly맵에 없는 호출',
          'PUT:/api/v1/document/{documentId}/name',
        ]);
        const heads = p.locator('table.calls tr.result-head');
        assert.deepEqual(await heads.locator('td.call > div.muted').allInnerTexts(), ['보관본을 연다', '내보낸 파일을 연다', '주간 보고서를 연다']);

        const valueRows = p.locator('table.calls tr.option:not(.result-head)');
        assert.equal(await valueRows.locator('td.cell').count(), 0);
        const outputCounts = [];
        for (const v of VALUES) {
          const row = valueRows.filter({ hasText: v });
          assert.deepEqual((await row.locator('td').allInnerTexts()).slice(1, -1), ['', '', '', '', '', '']);
          outputCounts.push(await row.locator('td.count').innerText());
        }
        assert.deepEqual(outputCounts, ['✕1', '테스트 없음', '✓1', '✕1']);
        assert.deepEqual(await p.locator('table.calls tr.option.gap td.call > div').allInnerTexts(), ['withAttachments 끔']);
        const gapLook = await p.locator('table.calls tr.option.gap td.count .none').evaluate((el) => {
          const own = getComputedStyle(el);
          const label = getComputedStyle(el.closest('tr')!.querySelector('td.call > div')!);
          return [own.color === label.color, own.fontWeight, label.fontWeight];
        });
        assert.deepEqual(gapLook, [true, '600', '600']);

        const detached = heads.nth(2);
        assert.equal(await detached.locator('a').count(), 0);
        assert.equal(await detached.locator('.chip.l-off-map').innerText(), '맵에 없는 호출');

        const before = await p.textContent('#right .mark-form .tags .tag-label');
        await valueRows.filter({ hasText: 'withAttachments 끔' }).locator('td.count').click();
        await valueRows.filter({ hasText: 'withHistory 켬' }).locator('td.call').click();
        assert.equal(await p.textContent('#right .mark-form .tags .tag-label'), before);
        assert.equal(await p.locator('table.calls .selected').count(), 0);

        await heads.nth(1).locator('a').click();
        await p.waitForSelector('#center .call-info .target-id');
        assert.equal(await p.textContent('#center .call-info .target-id .mono'), 'POST:/api/v1/report/export');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/admin\/audit/);
      }),
    ),
  OUTPUT_EXPORT_TESTS);
});

test('in a browser, a map written before call links shows the call table without result option rows', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ callLinks: RESULT_LINKS }, (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const { callLinks, unknownCallLinks, ...old } = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    assert.equal(callLinks.length + unknownCallLinks.length, 3);
    fs.writeFileSync(mapFile, JSON.stringify(old));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.waitForSelector('table.calls');
        assert.equal(await p.locator('table.calls tr.result-head').count(), 0);
        assert.equal(await p.locator('table.calls tbody tr').count(), 2);
      }),
    );
  });
});

test('in a browser, reloading a map with no screens while a call is chosen leaves the page empty instead of failing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls td.cell').first().click();
        assert.equal((await postMark(base, { target: { node: 'GET:/api/v1/member/list' }, status: 'fine' })).status, 201);
        const mapFile = path.join(config.outDir, 'map.json');
        fs.writeFileSync(mapFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(mapFile, 'utf8')), screens: [], entries: [] }));
        await p.evaluate(() => load().then(render));
        assert.equal(await p.textContent('#center'), '화면이 없습니다.');
        assert.equal(await p.textContent('#right'), '');
        assert.equal(await p.evaluate(() => hasUnsavedMark()), false);
      }),
    ),
  );
});

test('in a browser, the output depth row comes after the other depths and takes a mark', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.deepEqual(await p.locator('#center td.depth').allTextContents(), ['화면 전체', 'UI/E2E', 'API', '렌더링만', '코드', '데이터', '산출물']);
        await p.click('#center tr:has-text("산출물")');
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /산출물 깊이/);
        await p.click('#right .statuses button:has-text("더 필요")');
        await p.click('#right button.save');
        await p.waitForSelector('#center tr.selected td.mark:has-text("더 필요")');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]), [[{ node: '/lab/result#LabResult', depth: 'output' }, 'needs-more']]);
      }),
    ),
  );
});
