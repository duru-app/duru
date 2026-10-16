import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { withRebuiltFixture, withServer, browserMissing, withPage, screenBox, flowButton, filterButton, pickedBoxes, textOutside, changeData, leafEntries, paneWidths, dragEdge, rgb, nextFrame, inWindow, WALK, WALK_ON_MAP, withPathStories, flowPlace, storyRow, pickPathStory, drawnScreens, lineSteps, pathMarks, pillMarks, pathEdges, ringed, ringBadge } from './review-helpers.ts';
import type { Story, FlowView, FlowBox, FlowEdge, FlowColumns } from './review-helpers.ts';

declare const state: any;
declare let drawnGrid: { count: number; cellW: number; per: number } | null;
declare function renderFlow(): void;
declare const STORY_STATUS: Record<string, { label: string }>;
declare function pathStories(): Story[];
declare function storyTrees(flow: object, st: Story): { roots: object[]; hidden: Map<string, number> };
declare function canvas(roots: object[], options: { story: object }): { el: HTMLElement; measureWidths(): void; fit(width: number): void; measureHeights(): void; place(): unknown };
declare function flowInnerWidth(flow: HTMLElement): number;
declare function cellsPerRow(count: number, cellW: number, width: number): number;
declare function showBox(key: string): void;
declare function flowColumns(roots: object[], sizes: object, view?: FlowView): FlowColumns;
declare function layoutFlow(roots: object[], sizes: object, view?: FlowView, cols?: FlowColumns): { boxes: FlowBox[]; edges: FlowEdge[]; group: { x: number; y: number; height: number; count: number } | null; width: number; height: number; marks?: { x: number; y: number }[] };
const HOME_TARGETS = ['/document/:tab(draft|done)', '/document/:id', '/admin/member', '/admin/group', '/lab', '/admin/audit', '/admin/report'];
const HOME_GOES_TO = `2 → 3 단계: /home 에서 /help 로 가는 링크가 맵에 없습니다. /home 에서 갈 수 있는 화면: ${HOME_TARGETS.join(', ')}`;
const lineHops = (p: Page) => p.$$eval('#flow .story-line .story-hop', (els) => els.map((e) => [e.querySelector('path')!.getAttribute('class'), e.textContent]));
const hopLook = (p: Page, i: number) => p.$eval(`#flow .story-hop[data-hop="${i}"] path`, (e) => { const c = getComputedStyle(e); return [c.stroke, c.strokeWidth, c.strokeDasharray]; });
const cssColor = (p: Page, name: string) => p.evaluate((name) => getComputedStyle(document.body).getPropertyValue(name).trim(), name);
const inView = (p: Page, key: string) => p.evaluate((k) => {
  const flow = document.getElementById('flow')!;
  const r = flow.querySelector(`.box.screen[data-key="${CSS.escape(k)}"]`)!.getBoundingClientRect();
  const view = flow.getBoundingClientRect();
  return r.top >= view.top && r.bottom <= view.bottom && r.left >= view.left && r.right <= view.right;
}, key);
const drawOverlay = (p: Page, id: string) => p.evaluate((id) => {
  const st = pathStories().find((s) => s.id === id)!;
  const path = storyTrees(state.data.flow, st);
  const flow = document.getElementById('flow')!;
  const c = canvas(path.roots, { story: { st, hidden: path.hidden } });
  flow.replaceChildren(c.el);
  c.measureWidths();
  c.fit(flowInnerWidth(flow));
  c.measureHeights();
  c.place();
}, id);

test('in a browser, the flow lays out a story\'s link tags just before the box their line enters and keeps room under a box for its hidden-screen count', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        assert.equal(await p.locator('#flow-stories').isVisible(), false, 'no story list without stories');
        const out = await p.evaluate(() => {
          const screen = (id: string, children: object[] = []) => ({ kind: 'screen', id, children, calls: [], guards: [] });
          const roots = [screen('A', [screen('B'), screen('C', [screen('D')])])];
          const sizes = { A: { width: 100, height: 40 }, B: { width: 120, height: 50 }, C: { width: 80, height: 30 }, D: { width: 90, height: 30 } };
          const marks = [
            { key: 'A', kind: 'hidden', width: 80, height: 16 },
            { key: 'C', kind: 'tag', width: 30, height: 18 },
          ];
          const view = { marks };
          const cols = flowColumns(roots, sizes, view);
          return { plain: flowColumns(roots, sizes, {}).xs, xs: cols.xs, layout: layoutFlow(roots, sizes, view, cols) };
        });
        assert.deepEqual(out.plain, [0, 150, 320]);
        assert.deepEqual(out.xs, [0, 100 + 32 + 44, 176 + 120 + 50]);
        const box = Object.fromEntries(out.layout.boxes.map((b) => [b.key, b]));
        const [hidden, tag] = out.layout.marks!;
        assert.deepEqual(hidden, { x: 8, y: box.A.y + 40 + 6 });
        assert.equal(tag.y, box.C.y + 15 - 9, 'the tag sits on the line into its box');
        assert.equal(tag.x, 176 - 10 - 30);
        const toB = out.layout.edges.find((e) => e.to === 'B')!;
        assert.equal(toB.nx, 176 - 44, 'the line bends before the tags of the column it enters');
        assert.ok(out.layout.height >= hidden.y + 16, 'the canvas is tall enough for the hidden-screen count');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a story picked from the list on the left of the flow is drawn as its steps in order on one line with only its own screens, counts and lists only those, and the same row again or 「경로 끄기」 brings back the flow as it was', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    const stories = await p.evaluate(() => state.data.stories.list.map((st: Story) => [st.id, st.name]));
    assert.equal(await p.locator('.flowbar select').count(), 0, 'the bar above the flow has no story select');
    assert.equal(await p.textContent('#stories-tab'), `스토리 ${stories.length} ◀`);
    assert.deepEqual(await p.$$eval('#flow-story-list li', (els: HTMLElement[]) => els.map((e) => [e.dataset.story, e.querySelector('.name > span')!.textContent])), stories);
    assert.deepEqual(await p.$$eval('#flow-story-list li', (els) => els.map((e) => [...e.querySelectorAll('.chips .chip')].map((c) => c.textContent))), await p.evaluate(() => {
      const list: Story[] = state.data.stories.list;
      return list.map((st) => [st.status === 'pass' ? null : STORY_STATUS[st.status].label, st.broken ? '링크 없음' : null, st.detached ? '화면 없음' : null, st.unjudged ? '판정 못 함' : null].filter(Boolean));
    }), 'a row carries the status and verdict chips of the stories tab');
    const flowBox = await p.locator('#flow').boundingBox();
    const listBox = await p.locator('#flow-stories').boundingBox();
    assert.ok(listBox!.x + listBox!.width <= flowBox!.x + 1, 'the list sits left of the drawing');
    const before = await drawnScreens(p);
    await p.setViewportSize({ width: 1440, height: 400 });
    await p.evaluate(() => Object.assign(document.getElementById('flow')!, { scrollTop: 120 }));
    const scrolled = await p.evaluate(() => document.getElementById('flow')!.scrollTop);
    assert.ok(scrolled > 0, 'the flow was scrolled');

    await pickPathStory(p, 'walk-around');
    assert.equal(await flowPlace(p), '#flow?story=walk-around');
    assert.deepEqual(await p.$$eval('#flow-story-list li.selected', (els: HTMLElement[]) => els.map((e) => e.dataset.story)), ['walk-around']);
    assert.deepEqual(await lineSteps(p), WALK.map((id, i) => [String(i + 1), id]));
    assert.deepEqual(await drawnScreens(p), [...WALK_ON_MAP].sort());
    const middles = await p.$$eval('#flow .story-line [data-step]', (els) => new Set(els.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })).size);
    assert.equal(middles, 1, 'the steps sit on one line');
    const lefts = await p.$$eval('#flow .story-line [data-step]', (els) => els.map((e) => e.getBoundingClientRect().left));
    assert.deepEqual(lefts, [...lefts].sort((a, b) => a - b), 'the steps go from left to right in order');
    assert.equal(await p.locator('#flow .story-line .box.story-off').count(), 1);
    assert.match((await p.textContent('#flow .story-line .box.story-off'))!, /\/settings#Settings.*맵에 없는 화면/);
    assert.equal(await p.textContent('.flowbar .flowsummary'), '테스트 있는 화면 6/7');
    assert.equal(await filterButton(p, 'all').textContent(), '전체 7');
    assert.equal(await p.textContent('#gaps h2'), '빈틈 5');
    assert.match((await p.textContent('#gaps .lead'))!, /이 스토리의 경로/);
    assert.deepEqual(await textOutside(p), []);
    assert.equal(await p.locator('#flow-bar .story-on').count(), 0);
    assert.equal(await p.locator('#flow-head .story-on').count(), 1, 'the picked story is named in the corner of the drawing, not in the bar');

    await storyRow(p, 'walk-around').click();
    assert.equal(await flowPlace(p), '#flow');
    assert.deepEqual(await drawnScreens(p), before);
    assert.equal(await p.locator('#flow-head .story-on, #flow .story-line, #flow .mark, #flow .box.on-story, #flow .story-badge, #flow-story-list li.selected').count(), 0);
    assert.equal(await p.evaluate(() => document.getElementById('flow')!.scrollTop), scrolled, 'the flow comes back where it was scrolled to');

    await pickPathStory(p, 'run-lab');
    assert.deepEqual(await lineSteps(p), [['1', '/home#Home'], ['2', '/lab#Lab'], ['3', '/lab/result#LabResult']]);
    assert.deepEqual(await drawnScreens(p), ['/home#Home', '/lab#Lab', '/lab/result#LabResult'], 'a screen above a step in the flow is not drawn');
    await flowButton(p, '경로 끄기').click();
    assert.equal(await flowPlace(p), '#flow');
    assert.deepEqual(await drawnScreens(p), before);
  });
});

test('in a browser, every two neighbouring steps of a picked story are joined by a line in the style of their verdict, a missing link says where the screen before goes, and a screen visited twice is drawn at each of its steps', { skip: browserMissing }, async () => {
  const stories = { 'walk-around': WALK, twice: ['/signin#SignIn', '/home#Home', '/help#Help', '/home#Home'] };
  await withPathStories(stories, async (p) => {
    await pickPathStory(p, 'walk-around');
    assert.deepEqual(await lineHops(p), [
      ['story-edge l-open', ''], ['story-edge l-open', ''], ['story-edge l-open', ''], ['story-edge l-conditioned', '조건'],
      ['story-edge l-broken', '링크 없음'], ['story-edge l-open', ''], ['story-edge l-off-map', '맵에 없는 화면'],
    ]);
    assert.deepEqual(await hopLook(p, 0), [await cssColor(p, '--text').then(rgb), '3.2px', 'none']);
    assert.deepEqual(await hopLook(p, 3), [await cssColor(p, '--accent').then(rgb), '3.2px', '8px, 5px']);
    assert.deepEqual((await hopLook(p, 4)).slice(0, 2), [await cssColor(p, '--fail').then(rgb), '3.2px']);
    assert.equal(await p.getAttribute('#flow .story-hop[data-hop="4"]', 'title'), '단계 5 → 6 · 링크 없음');
    assert.deepEqual(await p.locator('#flow .story-gaps li').allTextContents(), ['5 → 6 단계: /help 에서 /lab 로 가는 링크가 맵에 없습니다. /help 에서 갈 수 있는 화면이 없습니다.']);

    await pickPathStory(p, 'help-from-home');
    assert.deepEqual(await lineHops(p), [['story-edge l-open', ''], ['story-edge l-broken', '링크 없음']]);
    assert.deepEqual(await p.locator('#flow .story-gaps li').allTextContents(), [HOME_GOES_TO]);
    assert.deepEqual(await p.locator('#flow .story-gaps li .goes-to code').allTextContents(), HOME_TARGETS);

    await pickPathStory(p, 'twice');
    assert.deepEqual(await lineSteps(p), stories.twice.map((id, i) => [String(i + 1), id]));
    assert.equal(await p.locator('#flow .story-hop').count(), 3);
    await p.locator('#flow .story-line .box.screen[data-step="3"]').click();
    assert.deepEqual(await ringBadge(p), ['4'], 'a box rings its own step');
    assert.deepEqual(await ringed(p), [['3', '/home#Home']]);
    assert.equal(await p.textContent('#center h3'), '/home');
    await p.locator('#flow .story-line .box.screen[data-step="1"]').click();
    assert.deepEqual(await ringed(p), [['1', '/home#Home']]);
    assert.deepEqual(await ringBadge(p), ['2']);
    const row = (await p.locator('#flow .story-row').boundingBox())!;
    const flow = (await p.locator('#flow').boundingBox())!;
    await p.mouse.click(Math.max(row.x, flow.x) + 20, row.y + row.height - 4);
    assert.deepEqual(await pickedBoxes(p), [], 'a click on an empty spot of the line lets the screen go');
  });
});

test('in a browser, two steps of a picked story that a move in the config joins are drawn with a green dotted line, like the legend\'s 「설정에 적은 이동」, with the reason on hover', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories', moves: [{ from: '/signin', to: '/lab/result', reason: '로그인 뒤' }] }, (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/signin-lab.json'), JSON.stringify({ name: '로그인해서 실험 결과를 본다', screens: ['/signin#SignIn', '/lab/result#LabResult'], author: 'a', date: '2026-10-03' }));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        await pickPathStory(p, 'signin-lab');
        assert.deepEqual(await lineHops(p), [['story-edge l-configured moved', '설정에 적은 이동']]);
        const [stroke, width, dashes] = await hopLook(p, 0);
        assert.deepEqual([stroke, width, dashes], [await cssColor(p, '--fine').then(rgb), '3.2px', '3px, 3px']);
        assert.equal(await p.$eval('#flow .story-hop[data-hop="0"] path', (e) => getComputedStyle(e).strokeLinecap), 'butt', 'the dots stay apart on the thick line');
        assert.equal(await p.getAttribute('#flow .story-hop[data-hop="0"]', 'title'), '단계 1 → 2 · 설정에 적은 이동 · 설정의 moves 에 적은 이동으로 이어집니다 · 로그인 뒤');
        assert.equal(await p.locator('#flow .story-gaps').count(), 0);

        await p.locator('#flow-head button.pathinfo-button').click();
        const sample = p.locator('#pathlegend li', { hasText: '설정에 적은 이동' }).locator('path');
        assert.deepEqual(await sample.evaluate((e) => { const c = getComputedStyle(e); return [c.stroke, c.strokeDasharray]; }), [stroke, dashes]);
      }, { view: 'flow' }));
  });
});

test('in a browser, the story list of the flow finds stories by name or ID and filters them like the stories tab, sharing both with it, and keeps its search box while typing', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    const ids = () => p.$$eval('#flow-story-list li[data-story]', (els: HTMLElement[]) => els.map((e) => e.dataset.story));
    const search = p.locator('#flow-stories input[type=search]');
    assert.equal(await search.getAttribute('placeholder'), '이름이나 ID 로 찾기');
    assert.deepEqual(await p.locator('#flow-stories fieldset').evaluateAll((els) => els.map((e) => [...e.querySelectorAll('label')].map((l) => l.textContent))),
      [['테스트 없음', '일부 화면만 테스트', '실패'], ['링크 없음']]);
    await search.click();
    await p.keyboard.type('홈에서');
    assert.deepEqual(await ids(), ['change-settings', 'help-from-home']);
    assert.equal(await p.evaluate(() => document.activeElement === document.querySelector('#flow-stories input[type=search]')), true, 'the box keeps the focus while typing');
    await search.fill('WALK');
    assert.deepEqual(await ids(), ['walk-around'], 'an ID is found too, whatever the case');
    await search.fill('');
    await p.check('#flow-stories input[name=broken]');
    assert.deepEqual(await ids(), await p.evaluate(() => state.data.stories.list.filter((st: Story) => st.broken).map((st: Story) => st.id)));
    await search.fill('없는 이름');
    assert.equal(await p.textContent('#flow-story-list li.muted'), '해당하는 스토리가 없습니다.');
    await search.fill('홈에서');
    assert.deepEqual(await ids(), ['help-from-home']);

    await p.click('#view-list');
    await p.click('#left .views.side button:has-text("스토리")');
    assert.equal(await p.inputValue('#left .filters input[type=search]'), '홈에서');
    assert.equal(await p.isChecked('#left input[name=broken]'), true);
    assert.deepEqual(await p.locator('#story-list li .name .mono').allTextContents(), ['help-from-home']);
    await p.uncheck('#left input[name=broken]');
    assert.deepEqual(await p.locator('#story-list li .name .mono').allTextContents(), ['change-settings', 'help-from-home']);
    await p.locator('#left .filters input[type=search]').click();
    await p.keyboard.press('End');
    await p.keyboard.type(' 바로');
    assert.deepEqual(await p.locator('#story-list li .name .mono').allTextContents(), ['help-from-home']);
    assert.equal(await p.evaluate(() => document.activeElement === document.querySelector('#left .filters input[type=search]')), true);
    await p.fill('#left .filters input[type=search]', 'run-');
    assert.deepEqual(await p.locator('#story-list li .name .mono').allTextContents(), ['run-lab']);

    await p.click('#view-flow');
    assert.equal(await search.inputValue(), 'run-');
    assert.deepEqual(await ids(), ['run-lab']);
  });
});

test('in a browser, the story list of the flow slides shut and open from a button in the top corner of the drawing that rides its edge and covers no box, without changing the picked story\'s drawing, its edge is dragged like the other panes, and its width and fold last until the page is loaded again', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    const ids = ['flow-stories', 'flow', 'gaps'];
    assert.deepEqual(await paneWidths(p, ids), [300, 1440 - 300 - 360, 360]);
    const fold = p.locator('#stories-tab');
    const toggle = async () => {
      await fold.click();
      assert.equal(await p.locator('main').evaluate((m) => m.classList.contains('sliding')), true, 'the list slides');
      await p.waitForFunction(() => !document.querySelector('main')!.classList.contains('sliding'));
    };
    await pickPathStory(p, 'walk-around');
    const steps = await lineSteps(p);
    const tabPlace = () => p.evaluate(() => {
      const tab = document.getElementById('stories-tab')!.getBoundingClientRect();
      const flow = document.getElementById('flow')!.getBoundingClientRect();
      const first = document.querySelector('#flow .box')!.getBoundingClientRect();
      return { left: Math.round(tab.left - flow.left), clear: tab.bottom <= first.top };
    });
    const count = await p.evaluate(() => pathStories().length);
    assert.equal(await fold.textContent(), `스토리 ${count} ◀`);
    assert.equal(await fold.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await tabPlace(), { left: 16, clear: true });
    await toggle();
    assert.equal(await fold.textContent(), `스토리 ${count} ▶`);
    assert.equal(await fold.getAttribute('aria-expanded'), 'false');
    assert.equal(await fold.getAttribute('title'), '스토리 목록 펴기');
    assert.equal(await fold.evaluate((e) => e === document.activeElement), true);
    assert.deepEqual(await paneWidths(p, ids), [0, 1440 - 360, 360], 'a folded list leaves no column');
    assert.equal(await p.locator('#flow-story-list').isVisible(), false);
    assert.deepEqual(await tabPlace(), { left: 16, clear: true }, 'the button moves with the edge of the drawing');
    assert.equal(await p.locator('#sash-stories').isVisible(), false, 'a folded list has no edge to drag');
    assert.deepEqual(await lineSteps(p), steps);
    assert.equal(await flowPlace(p), '#flow?story=walk-around');
    await toggle();
    assert.deepEqual(await paneWidths(p, ids), [300, 1440 - 300 - 360, 360]);

    await dragEdge(p, 'sash-stories', 100);
    assert.deepEqual(await paneWidths(p, ids), [400, 1440 - 400 - 360, 360], 'the list edge moves with the mouse');
    await dragEdge(p, 'sash-stories', -500);
    assert.equal((await paneWidths(p, ids))[0], 240, 'the list stops at its minimum');
    await dragEdge(p, 'sash-stories', 60);
    await toggle();
    await toggle();
    assert.equal((await paneWidths(p, ids))[0], 300, 'the width stays across a fold');

    await (await screenBox(p, '/home#Home')).click();
    const picked = ['flow-stories', 'flow', 'center', 'right'];
    const graph = (1440 - 300 - 360) / 2;
    assert.deepEqual(await paneWidths(p, picked), [300, graph, 1440 - 300 - 360 - graph, 360]);
    await dragEdge(p, 'sash-left', -100, { off: -3 });
    assert.deepEqual(await paneWidths(p, picked), [300, graph - 100, 1440 - 300 - 360 - graph + 100, 360], 'the drawing edge moves beside the list');
    await dragEdge(p, 'sash-stories', 40);
    assert.deepEqual(await paneWidths(p, picked), [340, graph - 100, 1440 - 340 - 360 - graph + 100, 360], 'widening the list takes from the middle pane');

    await fold.click();
    await p.reload();
    await p.waitForSelector('#flow .story-line');
    assert.equal(await fold.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await paneWidths(p, picked), [300, graph, 1440 - 300 - 360 - graph, 360], 'loading the page again starts from the first widths');
    await p.setViewportSize({ width: 600, height: 900 });
    await nextFrame(p);
    assert.equal(new Set(await p.$$eval('#flow-stories, #flow, #center, #right', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))).size, 1, 'a narrow window keeps the panes side by side');
  });
});

test('in a browser, once the story list has slid shut or open, the gathered entry screens of the flow are laid out again for the width the drawing ends at, and a box brought into view lands below the button in the corner', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories', 'walk-around.json'), JSON.stringify({ name: 'walk-around 이야기', screens: WALK, author: 'reviewer', date: '2026-10-05' }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const perRow = () => p.evaluate(() => drawnGrid!.per);
        const fits = () => p.evaluate(() => cellsPerRow(drawnGrid!.count, drawnGrid!.cellW, flowInnerWidth(document.getElementById('flow')!) / state.zoom));
        const open = await perRow();
        for (const way of ['shut', 'open']) {
          await p.click('#stories-tab');
          await p.waitForFunction(() => !document.querySelector('main')!.classList.contains('sliding'));
          assert.equal(await perRow(), await fits(), `slid ${way}`);
        }
        assert.equal(await perRow(), open);

        await p.evaluate(() => {
          document.getElementById('stories-tab')!.click();
          document.querySelector<HTMLElement>('#flow .box.screen[data-key="/home#Home"]')!.click();
        });
        await p.waitForFunction(() => !document.querySelector('main')!.classList.contains('sliding'), null, { timeout: 2000 });
        assert.equal(await perRow(), await fits(), 'a box picked while the list slides, which cuts the slide short, still ends it');
        await flowButton(p, '선택 해제').click();
        await p.click('#stories-tab');
        await p.waitForFunction(() => !document.querySelector('main')!.classList.contains('sliding'));

        await p.setViewportSize({ width: 1440, height: 400 });
        await p.evaluate(() => { const f = document.getElementById('flow')!; f.scrollTop = f.scrollHeight; });
        const key = await p.$eval('#flow .box.screen', (e: HTMLElement) => e.dataset.key!);
        await p.evaluate((k) => showBox(k), key);
        assert.equal(await p.evaluate((k) => {
          const box = document.querySelector(`#flow .box.screen[data-key="${CSS.escape(k)}"]`)!.getBoundingClientRect();
          return box.top >= document.getElementById('flow-head')!.getBoundingClientRect().bottom;
        }, key), true, 'a box brought into view lands below the button and the story name, not under them');
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    );
  });
});

test('in a browser, picking a story leaves the bar above the flow and the list beside it where they were, pressing a step of the line rings, picks and shows its box, or only rings a step off the map, and a story wider than its pane scrolls sideways inside it', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    const tops = () => p.$$eval('#flow-bar, #flow-stories', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }));
    const before = await tops();
    await pickPathStory(p, 'walk-around');
    assert.deepEqual(await tops(), before);
    const step = (i: number) => p.locator(`#flow .story-line .box[data-step="${i}"]`);

    await step(6).click();
    assert.deepEqual(await ringed(p), [['6', '/lab/result#LabResult']]);
    assert.deepEqual(await ringBadge(p), ['7']);
    assert.deepEqual(await pickedBoxes(p), ['/lab/result#LabResult']);
    assert.equal(await p.textContent('#center h3'), '/lab/result');
    assert.equal(await inView(p, '/lab/result#LabResult'), true);
    assert.equal(await flowPlace(p), '#flow?story=walk-around&screen=/lab/result#LabResult');
    await step(7).click();
    assert.deepEqual(await ringed(p), [['7', '/settings#Settings']]);
    assert.deepEqual(await ringBadge(p), ['8'], 'the box of a step off the map rings its step');

    await (await screenBox(p, '/home#Home')).click();
    assert.deepEqual(await ringBadge(p), ['2'], 'pressing a box on the path rings its step');
    await flowButton(p, '선택 해제').click();
    assert.deepEqual(await ringBadge(p), []);
    assert.deepEqual(await ringed(p), []);

    await p.setViewportSize({ width: 1280, height: 800 });
    await p.evaluate(() => renderFlow());
    const flow = await p.evaluate(() => { const f = document.getElementById('flow')!; return [f.scrollWidth, f.clientWidth]; });
    assert.ok(flow[0] > flow[1], `the drawing ${flow[0]}px wide scrolls inside its ${flow[1]}px pane`);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'the page itself does not scroll sideways');
  });
});

test('in a browser, a story path laid over the whole flow puts its hops from a box to its child on that link in the style of the story verdict and every other hop as chips with the other step number in both boxes, numbers a screen visited twice with both steps, and covers no box or mark', { skip: browserMissing }, async () => {
  const stories = { 'walk-around': WALK, twice: ['/signin#SignIn', '/home#Home', '/help#Help', '/home#Home'] };
  await withPathStories(stories, async (p) => {
    await drawOverlay(p, 'walk-around');
    assert.deepEqual(await pathEdges(p), [
      ['/home#Home', '/document/:tab_draft_done_#DocumentList', 'l-open'],
      ['/lab#Lab', '/lab/result#LabResult', 'l-open'],
      ['/signin#SignIn', '/home#Home', 'l-open'],
    ]);
    const stroke = (from: string, to: string) => p.$eval(`#flow svg path[data-from="${from}"][data-to="${to}"]`, (e) => { const c = getComputedStyle(e); return [c.strokeWidth, c.strokeDasharray, c.opacity]; });
    assert.deepEqual(await stroke('/signin#SignIn', '/home#Home'), ['3.2px', 'none', '1']);
    assert.deepEqual(await stroke('/signin#SignIn', '/help#Help'), ['1.3px', 'none', '0.35'], 'a guarded link that no hop takes is a thin grey line');
    assert.deepEqual((await pillMarks(p, 'story-badge')).sort(), WALK_ON_MAP.map((id, i) => [id, String(i + 1)]).sort());
    assert.deepEqual(await pathMarks(p, 'story-hidden'), [['/home#Home', '다른 화면 4 숨김']]);
    assert.deepEqual(await pillMarks(p, 'story-chip'), [
      ['/document/:tab_draft_done_#DocumentList', '→ 4', 'exit', 'l-open'],
      ['/document/:id#DocumentDetail', '3 →', 'entry', 'l-open'],
      ['/document/:id#DocumentDetail', '→ 5조건', 'exit', 'l-conditioned'],
      ['/lab#Lab', '✕5 →', 'entry', 'l-broken'],
      ['/lab/result#LabResult', '→ 8맵에 없는 화면', 'exit', 'l-off-map'],
      ['/help#Help', '4 →', 'entry', 'l-conditioned'],
      ['/help#Help', '✕→ 6링크 없음', 'exit', 'l-broken'],
    ]);
    const order = await (await screenBox(p, '/document/:id#DocumentDetail')).evaluate((box) => [...box.children].map((c) => c.className.split(' ')[0]));
    assert.deepEqual(order.filter((c) => c !== 'sr-only'), ['story-chip', 'story-badge', 'sq', 'path', 'tag', 'story-chip'], 'chips from earlier steps and the number come first, chips to later steps last');
    const toHelp = p.locator('#flow .story-chip.exit[data-hop="3"]');
    await toHelp.hover();
    assert.deepEqual(await p.$$eval('#flow .story-chip.hovered', (els) => els.map((e) => e.closest<HTMLElement>('.box')!.dataset.key)), ['/document/:id#DocumentDetail', '/help#Help']);

    const problems = () => p.evaluate(() => {
      const R = (e: Element) => e.getBoundingClientRect();
      const boxes = [...document.querySelectorAll<HTMLElement>('#flow .canvas > .box')];
      const marks = [...document.querySelectorAll<HTMLElement>('#flow .canvas > .mark')];
      const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
      const out = [];
      for (const m of marks) {
        for (const b of boxes) if (hit(R(m), R(b))) out.push(`${m.textContent} covers ${b.dataset.key}`);
        if (R(m).right > R(m.parentElement!).right + 0.5) out.push(`${m.textContent} sticks out of its canvas`);
      }
      marks.forEach((m, i) => marks.slice(i + 1).forEach((o) => { if (hit(R(m), R(o))) out.push(`${m.textContent} covers ${o.textContent}`); }));
      for (const line of document.querySelectorAll<SVGPathElement>('#flow .canvas svg path')) {
        const ctm = line.getScreenCTM()!;
        const len = line.getTotalLength();
        const thick = line.classList.contains('story-edge');
        for (let at = 2; at < len - 2; at += 2) {
          const q = line.getPointAtLength(at);
          const x = ctm.a * q.x + ctm.e;
          const y = ctm.d * q.y + ctm.f;
          const inside = (e: Element) => { const r = R(e); return x > r.left + 1 && x < r.right - 1 && y > r.top + 1 && y < r.bottom - 1; };
          const box = thick && boxes.find(inside);
          const under = marks.find((m) => !m.classList.contains('story-tag') && inside(m))!;
          if (box || under) {
            out.push(`${line.dataset.from} → ${line.dataset.to} runs ${box ? `across ${box.dataset.key}` : `under ${under.textContent}`}`);
            break;
          }
        }
      }
      return out;
    });
    assert.deepEqual(await problems(), []);
    assert.deepEqual(await textOutside(p), []);
    await drawOverlay(p, 'run-lab');
    assert.deepEqual(await pathEdges(p), [['/home#Home', '/lab#Lab', 'l-conditioned'], ['/lab#Lab', '/lab/result#LabResult', 'l-open']]);
    assert.deepEqual(await pathMarks(p, 'story-tag'), [['/lab#Lab', '조건', 'l-conditioned']]);
    assert.deepEqual(await problems(), []);

    await drawOverlay(p, 'twice');
    assert.deepEqual(await pillMarks(p, 'story-badge'), [['/signin#SignIn', '1'], ['/home#Home', '2·4'], ['/help#Help', '3']]);
  });
});

test('in a browser, the info icon beside a picked story opens a legend of the step number and of each kind of line between two steps drawn as small samples with short names, and Escape closes it', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    assert.equal(await p.locator('#flow-head button.pathinfo-button').count(), 0, 'no legend for a story until one is picked');
    await pickPathStory(p, 'walk-around');
    const info = p.locator('#flow-head button.pathinfo-button');
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
    assert.equal(await look('#pathlegend path.l-broken'), await look('#flow .story-hop path.l-broken'));
    assert.equal(await look('#pathlegend path.l-conditioned'), await look('#flow .story-hop path.l-conditioned'));
    const badge = (sel: string) => p.$eval(sel, (e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.height].join(' '); });
    assert.equal(await badge('#pathlegend .story-badge'), await badge('#flow .story-line .story-badge'));
    await p.evaluate(() => renderFlow());
    assert.equal(await legend.isVisible(), true, 'a redraw keeps the legend open');
    const e = await inWindow(p, '#pathlegend');
    assert.ok(e.left >= 0 && e.right <= e.width, `legend ${e.left}..${e.right} within ${e.width}`);
    await p.keyboard.press('Escape');
    assert.equal(await legend.isVisible(), false);
    assert.equal(await p.locator('#flowlegend').isVisible(), false);
  });
});
