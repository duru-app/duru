import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { withRebuiltFixture, withServer, browserMissing, withPage, paneWidths, dragEdge, rgb, inWindow, WALK, WALK_ON_MAP, withPathStories, flowPlace, pickPathStory, drawnScreens, lineSteps, nowStep, nextFrame } from './review-helpers.ts';
import type { FlowView, FlowBox, FlowEdge, FlowColumns } from './review-helpers.ts';

declare const state: any;
declare function render(): void;
declare function revealStoryPart(part: object): void;
declare function flowColumns(roots: object[], sizes: object, view?: FlowView): FlowColumns;
declare function layoutFlow(roots: object[], sizes: object, view?: FlowView, cols?: FlowColumns): { boxes: FlowBox[]; edges: FlowEdge[]; group: { x: number; y: number; height: number; count: number } | null; width: number; height: number; marks?: { x: number; y: number }[] };
const HOME_TARGETS = ['/document/:tab(draft|done)', '/document/:id', '/admin/member', '/admin/group', '/lab', '/admin/audit', '/admin/report'];
const lineHops = (p: Page) => p.$$eval('#center .story-line .story-hop', (els) => els.map((e) => [e.querySelector('path')!.getAttribute('class'), e.textContent]));
const hopLook = (p: Page, i: number) => p.$eval(`#center .story-hop[data-hop="${i}"] path`, (e) => { const c = getComputedStyle(e); return [c.stroke, c.strokeWidth, c.strokeDasharray]; });
const cssColor = (p: Page, name: string) => p.evaluate((name) => getComputedStyle(document.body).getPropertyValue(name).trim(), name);
const inSight = (p: Page, card: string) => p.evaluate((sel) => {
  const top = document.querySelector('#center .story-top')!.getBoundingClientRect().bottom;
  const r = document.querySelector(`#center .story-path > ${sel}`)!.getBoundingClientRect();
  return r.top >= top - 1 && r.bottom <= document.getElementById('center')!.getBoundingClientRect().bottom + 1;
}, card);
const centerTop = (p: Page) => p.evaluate(() => document.getElementById('center')!.scrollTop);

test('in a browser, the flow lays out a story\'s link tags just before the box their line enters', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const out = await p.evaluate(() => {
          const screen = (id: string, children: object[] = []) => ({ kind: 'screen', id, children, calls: [], guards: [] });
          const roots = [screen('A', [screen('B'), screen('C', [screen('D')])])];
          const sizes = { A: { width: 100, height: 40 }, B: { width: 120, height: 50 }, C: { width: 80, height: 30 }, D: { width: 90, height: 30 } };
          const view = { marks: [{ key: 'C', width: 30, height: 18 }] };
          const cols = flowColumns(roots, sizes, view);
          return { plain: flowColumns(roots, sizes, {}).xs, xs: cols.xs, layout: layoutFlow(roots, sizes, view, cols) };
        });
        assert.deepEqual(out.plain, [0, 150, 320]);
        assert.deepEqual(out.xs, [0, 100 + 32 + 44, 176 + 120 + 50]);
        const box = Object.fromEntries(out.layout.boxes.map((b) => [b.key, b]));
        const [tag] = out.layout.marks!;
        assert.equal(tag.y, box.C.y + 15 - 9, 'the tag sits on the line into its box');
        assert.equal(tag.x, 176 - 10 - 30);
        const toB = out.layout.edges.find((e) => e.to === 'B')!;
        assert.equal(toB.nx, 176 - 44, 'the line bends before the tags of the column it enters');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the flow tab has no story list, and a story picked in the story tab is drawn above its step cards as its steps in order on one line showing only the step number, the screen, its test status and whether it is on the map', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    assert.equal(await p.locator('#stories-tab, #flow-story-list').count(), 0);
    assert.equal(await p.locator('.flowbar .new-story').isVisible(), true, 'the flow bar still offers a new story');
    const before = await drawnScreens(p);

    await pickPathStory(p, 'walk-around');
    assert.equal(await flowPlace(p), '#story?story=walk-around');
    assert.deepEqual(await p.$$eval('#story-list li.selected', (els: HTMLElement[]) => els.map((e) => e.dataset.story)), ['walk-around']);
    assert.deepEqual(await lineSteps(p), WALK.map((id, i) => [String(i + 1), id]));
    const middles = await p.$$eval('#center .story-line [data-step]', (els) => new Set(els.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })).size);
    assert.equal(middles, 1, 'the steps sit on one line');
    const lefts = await p.$$eval('#center .story-line [data-step]', (els) => els.map((e) => e.getBoundingClientRect().left));
    assert.deepEqual(lefts, [...lefts].sort((a, b) => a - b), 'the steps go from left to right in order');
    assert.equal(await p.locator('#center .story-line .box.story-off').count(), 1);
    assert.match((await p.textContent('#center .story-line .box.story-off'))!, /\/settings#Settings.*맵에 없는 화면/);
    assert.deepEqual(await p.$$eval('#center .story-line .box.screen', (els) => els.map((e) => [...e.classList].find((c) => c.startsWith('s-')))), await p.evaluate((ids) => {
      const status = (c: { fail: number; pending: number; pass: number }) => (c.fail ? 's-fail' : c.pending ? 's-pending' : c.pass ? 's-pass' : 's-none');
      const walk = (ns: any[]): any[] => ns.flatMap((n) => [n, ...walk(n.children)]);
      const nodes = walk([...state.data.flow.roots, ...state.data.flow.unreached]);
      return ids.map((id: string) => status(nodes.find((n) => n.id === id).counts));
    }, WALK_ON_MAP), 'each box has the test status color of its screen');
    assert.equal(await p.locator('#center .story-line :is(.written-count, .hop-need, .bubble, .tag.api, .tag.need)').count(), 0, 'what the cards below say is not repeated on the line');
    assert.equal(await p.locator('#center .story-top ~ .story-path > .step').count(), WALK.length, 'the step cards follow the line');

    await p.click('#left .filters input[type=search]');
    await p.keyboard.type('홈에서');
    assert.deepEqual(await p.$$eval('#story-list li[data-story]', (els: HTMLElement[]) => els.map((e) => e.dataset.story)), ['change-settings', 'help-from-home']);
    assert.equal(await p.evaluate(() => document.activeElement === document.querySelector('#left .filters input[type=search]')), true, 'the search box keeps the focus while typing');

    await p.click('#view-flow');
    assert.equal(await flowPlace(p), '#flow');
    assert.deepEqual(await drawnScreens(p), before);
    assert.equal(await p.locator('#flow .story-line, #flow .mark, #flow .box.on-story, #flow .story-badge').count(), 0, 'the flow draws no story');
  });
});

test('in a browser, every two neighbouring steps on the line are joined by a line in the style of their verdict that names only a missing link, a missing link card says where the screen before goes, and a screen visited twice is drawn at each of its steps', { skip: browserMissing }, async () => {
  const stories = { 'walk-around': WALK, twice: ['/signin#SignIn', '/home#Home', '/help#Help', '/home#Home'] };
  await withPathStories(stories, async (p) => {
    await pickPathStory(p, 'walk-around');
    assert.deepEqual(await lineHops(p), [
      ['story-edge l-open', ''], ['story-edge l-open', ''], ['story-edge l-open', ''], ['story-edge l-conditioned', ''],
      ['story-edge l-broken', '링크 없음'], ['story-edge l-open', ''], ['story-edge l-off-map', ''],
    ]);
    assert.deepEqual(await hopLook(p, 0), [await cssColor(p, '--text').then(rgb), '3.2px', 'none']);
    assert.deepEqual(await hopLook(p, 3), [await cssColor(p, '--accent').then(rgb), '3.2px', '8px, 5px']);
    assert.deepEqual((await hopLook(p, 4)).slice(0, 2), [await cssColor(p, '--fail').then(rgb), '3.2px']);
    assert.equal(await p.getAttribute('#center .story-hop[data-hop="4"]', 'title'), '단계 5 → 6 · 링크 없음 · 누르면 이 연결 줄로 내려갑니다');
    assert.deepEqual(await p.locator('#center .story-path .goes-on').allTextContents(), ['/help 에서 갈 수 있는 화면이 없습니다.']);
    assert.equal(await p.locator('#center .story-path > .link[data-hop="4"] .goes-on').count(), 1, 'the screens the step before goes to are in the card of the missing link');

    await pickPathStory(p, 'help-from-home');
    assert.deepEqual(await lineHops(p), [['story-edge l-open', ''], ['story-edge l-broken', '링크 없음']]);
    assert.deepEqual(await p.locator('#center .story-path .goes-on').allTextContents(), [`/home 에서 갈 수 있는 화면: ${HOME_TARGETS.join(', ')}`]);
    assert.deepEqual(await p.locator('#center .story-path .goes-on .goes-to code').allTextContents(), HOME_TARGETS);

    await pickPathStory(p, 'twice');
    assert.deepEqual(await lineSteps(p), stories.twice.map((id, i) => [String(i + 1), id]));
    assert.equal(await p.locator('#center .story-hop').count(), 3);
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.locator('#center .story-line .box.screen[data-step="3"]').click();
    assert.equal(await inSight(p, '.step[data-step="3"]'), true, 'a box brings up its own step, not the other step of the same screen');
    assert.deepEqual(await nowStep(p), ['4']);
    await p.locator('#center .story-line .box.screen[data-step="1"]').click();
    assert.equal(await inSight(p, '.step[data-step="1"]'), true);
    assert.deepEqual(await nowStep(p), ['2']);
  });
});

test('in a browser, two steps on the line that a move in the config joins are drawn with a green dotted line, like the legend\'s 「설정에 적은 이동」, with the reason on hover', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories', moves: [{ from: '/signin', to: '/lab/result', reason: '로그인 뒤' }] }, (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/signin-lab.json'), JSON.stringify({ name: '로그인해서 실험 결과를 본다', screens: ['/signin#SignIn', '/lab/result#LabResult'], author: 'a', date: '2026-10-03' }));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        await pickPathStory(p, 'signin-lab');
        assert.deepEqual(await lineHops(p), [['story-edge l-configured moved', '']]);
        const [stroke, width, dashes] = await hopLook(p, 0);
        assert.deepEqual([stroke, width, dashes], [await cssColor(p, '--fine').then(rgb), '3.2px', '3px, 3px']);
        assert.equal(await p.$eval('#center .story-hop[data-hop="0"] path', (e) => getComputedStyle(e).strokeLinecap), 'butt', 'the dots stay apart on the thick line');
        assert.equal(await p.getAttribute('#center .story-hop[data-hop="0"]', 'title'), '단계 1 → 2 · 설정에 적은 이동 · 설정의 moves 에 적은 이동으로 이어집니다 · 로그인 뒤 · 누르면 이 연결 줄로 내려갑니다');
        assert.equal(await p.locator('#center .goes-on').count(), 0);

        await p.locator('#center .story-top-bar button.pathinfo-button').click();
        const sample = p.locator('#pathlegend li', { hasText: '설정에 적은 이동' }).locator('path');
        assert.deepEqual(await sample.evaluate((e) => { const c = getComputedStyle(e); return [c.stroke, c.strokeDasharray]; }), [stroke, dashes]);
      }, { view: 'flow' }));
  });
});

test('in a browser, 「새 스토리」 in the flow bar moves to the story tab, where the list, the steps over the drawing and the right column share the width, and 「스토리 목록」 keeps the draft and takes the drawing away', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    await p.click('.flowbar .new-story');
    await p.waitForSelector('#pick-list li');
    assert.equal(await flowPlace(p), '#story?new=1');
    assert.deepEqual(await paneWidths(p, ['left', 'center', 'right']), [300, 1440 - 300 - 360, 360]);
    assert.deepEqual(await paneWidths(p, ['flow']), [1440 - 300 - 360], 'the drawing is as wide as the steps above it');
    assert.equal(await p.locator('#flow-bar').isVisible(), false);

    await p.locator('#flow .box.screen[data-key="/home#Home"]').click();
    await p.waitForSelector('#center .compose-step');
    await p.click('#left button.leave-compose');
    assert.equal(await p.locator('#flow').isVisible(), false);
    await p.click('#view-flow');
    assert.equal(await p.textContent('.flowbar .new-story'), '새 스토리 이어 쓰기');
  });
});

test('in a browser, the line kept at the top of a story covers the pane up to its top edge while the cards scroll, so no card shows above it', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    await p.setViewportSize({ width: 1440, height: 600 });
    await pickPathStory(p, 'walk-around');
    await p.evaluate(() => { document.getElementById('center')!.scrollTop = 200; });
    await nextFrame(p);
    const above = await p.evaluate(() => {
      const center = document.getElementById('center')!.getBoundingClientRect();
      const top = document.querySelector('#center .story-top')!.getBoundingClientRect();
      const shown = [];
      for (let y = Math.ceil(center.top); y < top.top; y++) {
        for (let x = center.left + 8; x < center.right - 8; x += 40) {
          const e = document.elementFromPoint(x, y);
          if (e && e.closest('#center') && !e.closest('#center .story-top') && e.textContent!.trim() && !['center', 'center-body'].includes(e.id)) shown.push(`${y}: ${e.textContent!.trim().slice(0, 20)}`);
        }
      }
      return { gap: top.top - center.top, shown: [...new Set(shown)] };
    });
    assert.deepEqual(above, { gap: 0, shown: [] });
  });
});

test('in a browser, pressing a box on the line marks that step on the line and its card, scrolling only as far as brings the card into view, pressing a line between two steps brings its link card into view and marks no step, the mark stays where it is while the cards scroll and through a redraw, the line slides sideways to keep it in view, and a step of a story the page cannot read leads nowhere', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.setViewportSize({ width: 1440, height: 600 });
    await pickPathStory(p, 'walk-around');
    const box = (i: number) => p.locator(`#center .story-line .box[data-step="${i}"]`);
    const markedCards = () => p.$$eval('#center .story-path > .step.now', (els: HTMLElement[]) => els.map((e) => e.dataset.step));
    assert.deepEqual(await nowStep(p), [], 'no step is marked before one is pressed');

    await box(2).click();
    assert.equal(await inSight(p, '.step[data-step="2"]'), true);
    assert.deepEqual(await nowStep(p), ['3']);
    assert.deepEqual(await markedCards(), ['2']);
    assert.equal(await p.getAttribute('#center .story-line .box.now', 'aria-current'), 'step');
    assert.equal(await flowPlace(p), '#story?story=walk-around&step=3', 'pressing the line keeps the story and puts the step in the address');

    await p.evaluate(() => { document.getElementById('center')!.scrollTop = 0; });
    await nextFrame(p);
    assert.deepEqual(await nowStep(p), ['3'], 'scrolling the cards leaves the mark on the pressed step');
    await box(0).click();
    assert.equal(await centerTop(p), 0, 'a card already in view is marked without scrolling');
    assert.deepEqual(await nowStep(p), ['1']);
    assert.deepEqual(await markedCards(), ['0']);

    await p.locator('#center .story-hop[data-hop="3"]').click();
    assert.equal(await inSight(p, '.link[data-hop="3"]'), true);
    assert.deepEqual(await nowStep(p), [], 'a link marks no step');

    await box(7).click();
    assert.equal(await inSight(p, '.step[data-step="7"]'), true, 'the last card comes into view too');
    assert.deepEqual(await nowStep(p), ['8']);
    await p.evaluate(() => render());
    assert.deepEqual(await nowStep(p), ['8'], 'a redraw keeps the mark');
    assert.deepEqual(await markedCards(), ['7']);

    await p.emulateMedia({ reducedMotion: 'no-preference' });
    await p.evaluate(() => { document.getElementById('center')!.scrollTop = 0; });
    await p.evaluate(() => {
      const w = window as unknown as { marks: (string | undefined)[] };
      w.marks = [];
      new MutationObserver(() => {
        const step = document.querySelector<HTMLElement>('#center .story-line .box.now')?.dataset.step;
        if (w.marks.at(-1) !== step) w.marks.push(step);
      }).observe(document.querySelector('#center .story-line')!, { subtree: true, attributes: true, attributeFilter: ['class'] });
    });
    await box(5).click();
    await p.waitForFunction(() => {
      const c = document.getElementById('center')!;
      const r = document.querySelector('#center .story-path > .step[data-step="5"]')!.getBoundingClientRect();
      return r.bottom <= c.getBoundingClientRect().bottom + 1;
    });
    await nextFrame(p);
    assert.deepEqual(await p.evaluate(() => (window as unknown as { marks: string[] }).marks), ['5'], 'a smooth scroll past the steps between marks none of them');
    await p.emulateMedia({ reducedMotion: 'reduce' });

    await p.setViewportSize({ width: 1280, height: 600 });
    await p.evaluate(() => render());
    const line = () => p.evaluate(() => { const l = document.querySelector('#center .story-line')!; return [l.scrollWidth, l.clientWidth, l.scrollLeft]; });
    const [wide, room] = await line();
    assert.ok(wide > room, `the line ${wide}px wide scrolls inside its ${room}px pane`);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'the page itself does not scroll sideways');
    await p.evaluate(() => { document.querySelector('#center .story-line')!.scrollLeft = 0; });
    await box(7).evaluate((e: HTMLElement) => e.click());
    await p.waitForFunction(() => document.querySelector('#center .story-line')!.scrollLeft > 0);
    assert.deepEqual(await nowStep(p), ['8'], 'the line slides sideways to the marked last step');
    await box(0).evaluate((e: HTMLElement) => e.click());
    assert.ok((await line())[2] < wide - room, 'and back to the marked first step');

    await p.evaluate(() => {
      state.story = 'unread-file';
      render();
      revealStoryPart({ kind: 'step', key: { step: 1 } });
    });
    assert.equal(await p.locator('#center .story-line').count(), 0, 'a step of a story the page cannot read leads nowhere, and the page goes on');
  });
});

test('in a browser, a story whose cards fit in the pane does not scroll, and pressing its boxes marks them without moving the cards', { skip: browserMissing }, async () => {
  await withPathStories({ short: WALK.slice(0, 3) }, async (p) => {
    await p.setViewportSize({ width: 1440, height: 900 });
    await pickPathStory(p, 'short');
    assert.equal(await p.evaluate(() => { const c = document.getElementById('center')!; return c.scrollHeight <= c.clientHeight; }), true, 'nothing below the cards makes the pane scroll');
    await p.locator('#center .story-line .box[data-step="2"]').click();
    await nextFrame(p);
    assert.equal(await centerTop(p), 0);
    assert.deepEqual(await nowStep(p), ['3']);
  });
});

test('in a browser, the info icon above the line opens a legend of the step number and of each kind of line between two steps drawn as small samples with short names, and Escape closes it', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    await pickPathStory(p, 'walk-around');
    const info = p.locator('#center .story-top-bar button.pathinfo-button');
    const legend = p.locator('#pathlegend');
    assert.equal(await info.getAttribute('aria-label'), '스토리 경로 읽는 법');
    assert.equal(await legend.isVisible(), false);
    await info.click();
    await p.mouse.move(5, 890);
    assert.equal(await legend.isVisible(), true);
    assert.deepEqual(await legend.locator('li > span:last-child').allTextContents(), [
      '단계 번호', '이어짐', '조건', '설정에 적은 이동', '링크 없음', '맵에 없는 화면 · 판정 못 함',
    ]);
    assert.equal(await legend.locator('li > .sample').count(), 6);
    const look = (sel: string) => p.$eval(sel, (e) => { const c = getComputedStyle(e); return [c.stroke, c.strokeWidth, c.strokeDasharray].join(' '); });
    assert.equal(await look('#pathlegend path.l-broken'), await look('#center .story-hop path.l-broken'));
    assert.equal(await look('#pathlegend path.l-conditioned'), await look('#center .story-hop path.l-conditioned'));
    const badge = (sel: string) => p.$eval(sel, (e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.height].join(' '); });
    assert.equal(await badge('#pathlegend .story-badge'), await badge('#center .story-line .story-badge'));
    await p.evaluate(() => render());
    assert.equal(await legend.isVisible(), true, 'a redraw keeps the legend open');
    const e = await inWindow(p, '#pathlegend');
    assert.ok(e.left >= 0 && e.right <= e.width, `legend ${e.left}..${e.right} within ${e.width}`);
    await p.keyboard.press('Escape');
    assert.equal(await legend.isVisible(), false);
  });
});

test('in a browser, the right pane of a story in the story tab lists, folded, the failing and untested screens on its path, and pressing one brings up its step card', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.setViewportSize({ width: 1440, height: 600 });
    await pickPathStory(p, 'walk-around');
    const gaps = p.locator('#right details.story-gaps');
    assert.equal(await gaps.evaluate((e: HTMLDetailsElement) => e.open), false);
    const expected = await p.evaluate((ids) => {
      const walk = (ns: any[]): any[] => ns.flatMap((n) => [n, ...walk(n.children)]);
      const nodes = walk([...state.data.flow.roots, ...state.data.flow.unreached]);
      const of = (id: string) => nodes.find((n) => n.id === id).counts;
      return { fail: ids.filter((id: string) => of(id).fail > 0), none: ids.filter((id: string) => { const c = of(id); return !c.fail && !c.pending && !c.pass; }) };
    }, WALK_ON_MAP);
    assert.equal(await gaps.locator('summary').textContent(), `손볼 화면 ${expected.fail.length + expected.none.length}`);
    await gaps.locator('summary').click();
    await p.waitForFunction(() => state.storyGapsOpen);
    assert.deepEqual(await gaps.locator('h3').allTextContents(), [`실패 ${expected.fail.length}`, `테스트 없음 ${expected.none.length}`].filter((t) => !t.endsWith(' 0')));
    await p.evaluate(() => render());
    assert.equal(await gaps.evaluate((e: HTMLDetailsElement) => e.open), true, 'the fold stays open when the pane is drawn again');
    const last = expected.none.at(-1)!;
    await gaps.locator('li', { hasText: last.split('#')[1] }).click();
    const step = String(WALK.indexOf(last));
    assert.equal(await inSight(p, `.step[data-step="${step}"]`), true);
    assert.deepEqual(await nowStep(p), [String(Number(step) + 1)]);
  });
});
