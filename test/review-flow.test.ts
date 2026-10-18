import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { startReviewServer } from '../src/review.ts';
import { withRebuiltFixture, signer, withServer, browserMissing, withPage, openScreenInfo, screenBox, boxCount, flowButton, filterButton, pickedBoxes, textOutside, PICK_HINT, statusLine, tipLines, needTag, changeData, walkFlow, leafEntries, WALK, withPathStories, flowPlace } from './review-helpers.ts';
import type { PageData, FlowView, FlowBox, FlowEdge, FlowColumns } from './review-helpers.ts';

declare const state: any;
declare const GAP: number;
declare let drawnGrid: { count: number; cellW: number; per: number } | null;
declare function renderFlow(): void;
declare function setZoom(z: number): void;
declare function openNeeds(screen: { access: object }): { lines: { kind: string; text: string }[]; tips: string[]; bare: unknown };
declare function flowColumns(roots: object[], sizes: object, view?: FlowView): FlowColumns;
declare function layoutFlow(roots: object[], sizes: object, view?: FlowView, cols?: FlowColumns): { boxes: FlowBox[]; edges: FlowEdge[]; group: { x: number; y: number; height: number; count: number } | null; width: number; height: number; marks?: { x: number; y: number }[] };
const boxesWith = (p: Page, cls: string) => p.$$eval(`#flow .box.screen.${cls}`, (els: HTMLElement[]) => els.map((e) => e.dataset.key!).sort());
const lineStates = (p: Page) => p.$$eval('#flow .canvas svg path[data-from]', (els) => Object.fromEntries(els.map((e) => [
  `${(e as SVGElement).dataset.from} ${(e as SVGElement).dataset.to}`, ['on', 'dim'].filter((c) => e.classList.contains(c)).join(' '),
])));
const layoutErrors = (p: Page) => p.$$eval('#flow .canvas', (canvases) => canvases.flatMap((canvas) => {
  const origin = canvas.getBoundingClientRect();
  const els = new Map([...canvas.querySelectorAll<HTMLElement>(':scope > .box')].map((e) => [e.dataset.key, e]));
  const box = (key: string) => {
    const r = els.get(key)!.getBoundingClientRect();
    const top = r.top - origin.top;
    const left = r.left - origin.left;
    return { key, left, right: left + r.width, top, bottom: top + r.height, middle: top + r.height / 2 };
  };
  const edges = [...canvas.querySelectorAll<SVGPathElement>('svg path')].map((path) => ({
    from: box(path.dataset.from!), to: box(path.dataset.to!), start: path.getPointAtLength(0), end: path.getPointAtLength(path.getTotalLength()),
  }));
  const off = (a: number, b: number) => Math.abs(a - b) > 1;
  const errors = [];
  for (const [key, e] of els) {
    const r = e.getBoundingClientRect();
    if (off(r.left - origin.left, parseFloat(e.style.left))) errors.push(`${key} stands at x ${r.left - origin.left}, the layout put it at ${e.style.left}`);
    if (off(r.width, parseFloat(e.style.width))) errors.push(`${key} is ${r.width}px wide, the layout made it ${e.style.width}`);
  }
  for (const { from, to, start, end } of edges) {
    if (off(end.y, to.middle)) errors.push(`the line to ${to.key} ends at ${end.y}, the box's middle is at ${to.middle}`);
    if (off(end.x, to.left)) errors.push(`the line to ${to.key} ends at x ${end.x}, the box's left edge is at ${to.left}`);
    if (off(start.y, from.middle)) errors.push(`the line from ${from.key} starts at ${start.y}, not at ${from.middle}`);
    if (off(start.x, from.right)) errors.push(`the line from ${from.key} starts at x ${start.x}, not at ${from.right}`);
  }
  const parents = new Set(edges.map((e) => e.from.key));
  for (const parent of parents) {
    const kids = edges.filter((e) => e.from.key === parent).map((e) => e.to).sort((a, b) => a.top - b.top);
    const pairs = kids.slice(1).map((b, i) => [kids[i], b]).filter(([a, b]) => !parents.has(a.key) && !parents.has(b.key));
    for (const [a, b] of pairs) if (off(b.top - a.bottom, GAP)) errors.push(`${b.key} stands ${b.top - a.bottom}px below ${a.key}`);
  }
  return errors;
}));
const SCREEN_ORDER = [
  '/signin#SignIn', '/home#Home', '/document/:tab_draft_done_#DocumentList', '/document/:id#DocumentDetail', '/admin/member#AdminMember',
  '/admin/group#AdminGroup', '/lab#Lab', '/lab/result#LabResult', '/admin/audit#AdminAudit', '/admin/report#AdminReport', '/help#Help',
];
const LAB_PATHS = ['/home#Home /lab#Lab', '/lab#Lab /lab/result#LabResult', '/signin#SignIn /home#Home'];

test('in a browser, pressing a screen in the flow keeps strong only the paths through it, dims the rest, and opens the screen in the list\'s own middle and right panes beside the drawing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const shown = () => p.evaluate(() => ['flow-bar', 'flow', 'left', 'center', 'right', 'gaps'].filter((id) => !document.getElementById(id)!.hidden));
        assert.deepEqual(await shown(), ['flow-bar', 'flow', 'gaps']);
        assert.deepEqual(await boxesWith(p, 'dim'), []);

        await (await screenBox(p, '/lab#Lab')).click();
        await p.waitForSelector('#flow .box.picked');
        assert.deepEqual(await shown(), ['flow-bar', 'flow', 'center', 'right']);
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab']);
        assert.equal(await (await screenBox(p, '/lab#Lab')).getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await boxesWith(p, 'dim'), SCREEN_ORDER.filter((id) => !['/signin#SignIn', '/home#Home', '/lab#Lab', '/lab/result#LabResult'].includes(id)).sort());
        const lines = await lineStates(p);
        assert.deepEqual(Object.keys(lines).filter((k) => lines[k] === 'on').sort(), LAB_PATHS);
        assert.ok(Object.entries(lines).every(([k, v]) => LAB_PATHS.includes(k) || v === 'dim'), JSON.stringify(lines));
        assert.equal(await p.textContent('#center h3'), '/lab');
        assert.equal(await p.textContent('#center .open-needs h2'), '접근 조건');
        assert.equal(await p.locator('#right-dock .mark-form').count(), 1);
        assert.equal(await p.textContent('.flowbar .picking'), '고른 화면 /lab 선택 해제');
        assert.equal(await p.evaluate(() => decodeURIComponent(location.hash)), '#flow?screen=/lab#Lab');
        const columns = await p.evaluate(() => ['flow', 'center', 'right'].map((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().width)));
        assert.equal(columns[2], 360, 'the right pane keeps the width it has in the list');
        assert.ok(Math.abs(columns[0] - columns[1]) <= 1, `the drawing and the middle pane share the rest: ${columns}`);

        await p.click('#view-list');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/lab/);
        await p.click('#screen-list li:has-text("/help")');
        await p.click('#view-flow');
        assert.deepEqual(await pickedBoxes(p), ['/help#Help'], 'the screen chosen in the list is the one picked in the flow');

        await (await screenBox(p, '/document/:id#DocumentDetail')).click();
        assert.deepEqual(await boxesWith(p, 'jump'), ['/admin/report#AdminReport', '/help#Help'], 'the screens its links reach in other branches are marked, not dimmed');
        assert.deepEqual(await boxesWith(p, 'dim'), ['/admin/audit#AdminAudit', '/admin/group#AdminGroup', '/admin/member#AdminMember', '/document/:tab_draft_done_#DocumentList', '/lab#Lab', '/lab/result#LabResult']);

        await flowButton(p, '선택 해제').click();
        assert.deepEqual(await shown(), ['flow-bar', 'flow', 'gaps']);
        assert.deepEqual(await boxesWith(p, 'dim'), []);
        assert.deepEqual(await boxesWith(p, 'jump'), []);
        assert.equal(await p.evaluate(() => decodeURIComponent(location.hash)), '#flow');

        await (await screenBox(p, '/lab#Lab')).focus();
        await p.keyboard.press('Enter');
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'Enter on a focused screen picks it');
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right .mark-form textarea', '아직 저장하지 않은 메모');
        await (await screenBox(p, '/lab#Lab')).click();
        assert.equal(await p.inputValue('#right .mark-form textarea'), '아직 저장하지 않은 메모', 'pressing the picked screen again keeps the unsaved mark');
        await p.focus('#right .statuses button:has-text("충분")');
        await p.keyboard.press('Escape');
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'Escape in the panes keeps the pick');
        await p.locator('#center table.calls td.cell').first().click();
        assert.notEqual(await p.evaluate(() => state.target.node), '/lab#Lab');
        await (await screenBox(p, '/lab#Lab')).click();
        assert.equal(await p.evaluate(() => state.target.node), '/lab#Lab', 'pressing the picked screen goes back from a call to the screen');
        await (await screenBox(p, '/lab#Lab')).focus();
        await p.keyboard.press('Escape');
        assert.deepEqual(await pickedBoxes(p), []);
        assert.equal(await p.locator('#gaps').isVisible(), true);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a move in the config draws a screen no link reached yet under the screen it leaves with a green dotted line, marks the screen it reaches in another branch when its screen is picked, and both screens list the move with its reason', { skip: browserMissing }, async () => {
  const moves = [{ from: '/signin', to: '/lab/result', reason: '로그인 뒤' }, { from: '/lab/result', to: '/help', reason: '닫은 뒤' }, { from: '/signin', to: '/help', reason: '도움말 단추' }];
  await withRebuiltFixture({ moves }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const movedLines = () => p.$$eval('#flow .canvas svg path.moved', (els) => els.map((e) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--fine)';
          document.body.append(probe);
          const fine = getComputedStyle(probe).color;
          probe.remove();
          const c = getComputedStyle(e);
          return [(e as SVGElement).dataset.from, (e as SVGElement).dataset.to, c.stroke === fine, c.strokeDasharray];
        }).sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
        const bothMoves = [['/signin#SignIn', '/help#Help', true, '3px, 3px'], ['/signin#SignIn', '/lab/result#LabResult', true, '3px, 3px']];
        assert.deepEqual(await movedLines(), bothMoves, 'a move over a guarded link is drawn as the move');
        assert.ok((await tipLines(await screenBox(p, '/lab/result#LabResult'))).includes('설정에 적은 이동: 로그인 뒤'));
        const helpTips = await tipLines(await screenBox(p, '/help#Help'));
        assert.ok(helpTips.includes('설정에 적은 이동: 도움말 단추'));
        assert.ok(!helpTips.some((t) => t.startsWith('이 링크의 조건')), 'the guard of the link the move is drawn over is left out');
        assert.deepEqual(await boxesWith(p, 'jump'), []);

        await (await screenBox(p, '/lab/result#LabResult')).click();
        await p.waitForSelector('#flow .box.picked');
        assert.deepEqual(await boxesWith(p, 'jump'), ['/help#Help'], 'the screen its move reaches in another branch is marked');
        assert.equal((await lineStates(p))['/signin#SignIn /lab/result#LabResult'], 'on');
        assert.deepEqual(await movedLines(), bothMoves, 'a strong move line stays green and dotted');
        assert.match((await p.textContent('#center .screen-info > summary .counts'))!, /^들어오는 링크 2 · 나가는 링크 1 · /, 'the folded line counts the moves with the links');
        await openScreenInfo(p);
        assert.equal(await p.textContent('#center .access h2'), '들어오는 링크 2');
        assert.deepEqual(await p.locator('#center .access .moves li').allTextContents(), ['/signin#SignIn 설정에 적은 이동 로그인 뒤']);
        const outgoing = p.locator('#center .screen-info h2', { hasText: '나가는 링크' });
        assert.equal(await outgoing.textContent(), '나가는 링크 1');
        assert.deepEqual(await outgoing.locator('xpath=following-sibling::*[1]').locator('li').allTextContents(), ['/help#Help 설정에 적은 이동 닫은 뒤']);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a click on an empty spot of the flow drawing lets the picked screen go as 「선택 해제」 does, while a click on a line or the scrollbar, a press dragged across the drawing, or a press on a screen released just beside it keeps it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const shown = () => p.evaluate(() => ['flow-bar', 'flow', 'left', 'center', 'right', 'gaps'].filter((id) => !document.getElementById(id)!.hidden));
        const emptySpot = () => p.evaluate(() => {
          const empty = (x: number, y: number) => document.elementFromPoint(x, y)?.matches('#flow, #flow .zoom-box, #flow .canvas') ?? false;
          const r = document.getElementById('flow')!.getBoundingClientRect();
          for (let y = r.top + 20; y < r.bottom - 20; y += 8) {
            for (let x = r.left + 20; x < r.right - 60; x += 8) if ([0, 20, 40].every((d) => empty(x + d, y))) return { x, y };
          }
          return null;
        });
        const lineSpot = () => p.evaluate(() => {
          for (const line of document.querySelectorAll<SVGPathElement>('#flow .canvas svg path[data-from]')) {
            const { x, y } = line.getPointAtLength(line.getTotalLength() / 2).matrixTransform(line.getScreenCTM()!);
            if (document.elementFromPoint(x, y) === line) return { x, y };
          }
          return null;
        });

        await (await screenBox(p, '/lab#Lab')).click();
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab']);
        const line = await lineSpot();
        assert.ok(line, 'a line is drawn where nothing covers it');
        await p.mouse.click(line.x, line.y);
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'a click on a line keeps the pick');

        const spot = await emptySpot();
        assert.ok(spot, 'the drawing has an empty spot');
        await p.mouse.move(spot.x, spot.y);
        await p.mouse.down();
        await p.mouse.move(spot.x + 40, spot.y, { steps: 5 });
        await p.mouse.up();
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'a press dragged across the drawing keeps the pick');

        const edge = await p.evaluate(() => {
          for (const box of document.querySelectorAll<HTMLElement>('#flow .box.screen')) {
            const r = box.getBoundingClientRect();
            const y = r.top + r.height / 2;
            if (document.elementFromPoint(r.right - 1, y)?.closest('.box') === box && document.elementFromPoint(r.right + 2, y)?.matches('#flow .canvas')) return { x: r.right - 1, y };
          }
          return null;
        });
        assert.ok(edge, 'a screen has empty drawing just beside it');
        await p.mouse.move(edge.x, edge.y);
        await p.mouse.down();
        await p.mouse.move(edge.x + 3, edge.y);
        await p.mouse.up();
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'a press on a screen released just beside it keeps the pick');

        const bar = await p.evaluate(() => {
          const flow = document.getElementById('flow')!;
          const r = flow.getBoundingClientRect();
          return { x: r.left + flow.clientLeft + flow.clientWidth + 2, y: r.top + 40, gutter: r.width - flow.clientLeft - flow.clientWidth };
        });
        assert.ok(bar.gutter > 4, `the drawing keeps room for its scrollbar: ${bar.gutter}`);
        await p.mouse.click(bar.x, bar.y);
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'a press on the scrollbar keeps the pick');

        await p.mouse.click(spot.x, spot.y);
        assert.deepEqual(await pickedBoxes(p), []);
        assert.deepEqual(await shown(), ['flow-bar', 'flow', 'gaps']);
        assert.deepEqual(await boxesWith(p, 'dim'), []);
        assert.ok(Object.values(await lineStates(p)).every((v) => v === ''), JSON.stringify(await lineStates(p)));
        assert.equal(await p.locator('.flowbar .picking').count(), 0);
        assert.equal(await p.evaluate(() => decodeURIComponent(location.hash)), '#flow');

        await (await screenBox(p, '/help#Help')).click();
        assert.deepEqual(await pickedBoxes(p), ['/help#Help'], 'a click on a screen still picks it');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, with nothing picked the right column lists the failing screens and then the ones without a tagged test, in the order of the drawing, and pressing one picks it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const testsFile = path.join(config.outDir, 'tests.json');
    const tests = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
    tests.importers['/admin/group#AdminGroup'] = [tests.importers['/help#Help'][0]];
    fs.writeFileSync(testsFile, JSON.stringify(tests));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#gaps .gap-list');
        assert.equal(await p.textContent('#gaps h2'), '손볼 화면 9');
        assert.deepEqual(await p.locator('#gaps h3').allTextContents(), ['실패 5', '테스트 없음 4']);
        const names = (n: number) => p.locator('#gaps .gap-list').nth(n).locator('li .name > span:first-child').allTextContents();
        assert.deepEqual(await names(0), ['/home', '/document/:tab(draft|done)', '/document/:id', '/admin/member', '/help']);
        assert.deepEqual(await names(1), ['/admin/group', '/lab/result', '/admin/audit', '/admin/report']);
        const group = p.locator('#gaps .gap-list li', { hasText: '/admin/group' });
        assert.deepEqual(await group.locator('.count').allTextContents(), ['테스트 없음', '불러옴 1'], 'a screen with only untagged tests is a gap and says what it has');
        assert.equal(await p.locator('#gaps li.selected').count(), 0);

        await group.click();
        assert.deepEqual(await pickedBoxes(p), ['/admin/group#AdminGroup']);
        assert.equal(await p.textContent('#center h3'), '/admin/group');
        assert.equal(await p.locator('#gaps').isHidden(), true);
      }, { view: 'flow' }),
    );
  });
});

test('in a browser, the flow bar counts the drawn screens on one button per status, and a pressed button and the search box fade the screens they leave out without moving any', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        assert.equal(await p.textContent('.flowbar .flowsummary'), '테스트 있는 화면 7/11');
        assert.deepEqual(await p.locator('.flowbar .flow-filters button').allTextContents(), ['전체 11', '테스트 없음 4', '태그 없는 테스트만 0', '실패 5', '보류 1', '통과 1']);
        const summary = await p.evaluate(() => state.data.flow.summary);
        const count = async (key: string) => Number(await filterButton(p, key).locator('.count').textContent());
        assert.deepEqual([await count('fail'), await count('imported'), 11 - await count('none')], [summary.failing, summary.importedOnly, summary.tested], 'the buttons agree with the counts the server made');
        const pressed = () => p.$$eval('.flowbar .flow-filters button[aria-pressed=true]', (els: HTMLElement[]) => els.map((e) => e.dataset.filter));
        assert.deepEqual(await pressed(), ['all']);
        const before = await p.$$eval('#flow .box.screen', (els: HTMLElement[]) => els.map((e) => [e.dataset.key, e.style.left, e.style.top]));

        await filterButton(p, 'fail').click();
        assert.deepEqual(await pressed(), ['fail']);
        assert.deepEqual(await boxesWith(p, 'off'), ['/admin/audit#AdminAudit', '/admin/group#AdminGroup', '/admin/report#AdminReport', '/lab#Lab', '/lab/result#LabResult', '/signin#SignIn']);
        await filterButton(p, 'pending').click();
        assert.deepEqual(await pressed(), ['pending'], 'one status at a time');
        assert.deepEqual(SCREEN_ORDER.filter((id) => !(id === '/lab#Lab')).sort(), await boxesWith(p, 'off'));
        await filterButton(p, 'pending').click();
        assert.deepEqual(await pressed(), ['all'], 'pressing the pressed button again shows every screen');
        assert.deepEqual(await boxesWith(p, 'off'), []);

        const search = p.locator('.flowbar input.flow-search');
        await search.fill('admin/');
        assert.deepEqual(SCREEN_ORDER.filter((id) => !id.startsWith('/admin/')).sort(), await boxesWith(p, 'off'));
        await filterButton(p, 'none').click();
        assert.deepEqual(SCREEN_ORDER.filter((id) => !['/admin/group#AdminGroup', '/admin/audit#AdminAudit', '/admin/report#AdminReport'].includes(id)).sort(), await boxesWith(p, 'off'), 'the search and the button both apply');
        assert.equal(await search.evaluate((e) => e === document.activeElement), false);
        await search.focus();
        await p.keyboard.press('Enter');
        assert.deepEqual(await pickedBoxes(p), ['/admin/group#AdminGroup'], 'Enter picks the first screen still shown');
        assert.equal(await search.inputValue(), 'admin/', 'the search stays as typed across the redraw');
        await search.fill('');
        await filterButton(p, 'none').click();
        await flowButton(p, '선택 해제').click();
        assert.deepEqual(await p.$$eval('#flow .box.screen', (els: HTMLElement[]) => els.map((e) => [e.dataset.key, e.style.left, e.style.top])), before, 'fading and picking leave every screen where it was');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a screen in the flow is one line with its status as a square, its API calls as a count and the kind of condition that opens it, with the rest on hover', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const home = await screenBox(p, '/home#Home');
        assert.equal(await home.locator('.path').textContent(), '/home');
        assert.deepEqual(await home.locator('.tag').allTextContents(), ['API 2', '죽은 화면']);
        assert.match((await home.getAttribute('class'))!, /s-fail/);
        assert.equal(await home.locator('.sr-only').textContent(), '실패');
        assert.equal(await statusLine(home), '실패 · 불러옴 1');
        assert.deepEqual(await tipLines(home), []);
        assert.equal(await home.locator('button').count(), 0, 'a screen carries no buttons of its own');

        const audit = await screenBox(p, '/admin/audit#AdminAudit');
        assert.deepEqual(await needTag(audit), ['역할']);
        assert.deepEqual((await tipLines(audit)).filter((t) => t.startsWith('필요한')), ['필요한 역할: ADMIN, AUDITOR']);
        assert.equal(await statusLine(audit), '테스트 없음');
        const group = await screenBox(p, '/admin/group#AdminGroup');
        assert.deepEqual((await tipLines(group)).filter((t) => /역할/.test(t)), ['필요한 역할: ADMIN', '읽지 못한 역할 조건: isAdmin']);
        const lab = await screenBox(p, '/lab#Lab');
        assert.deepEqual(await needTag(lab), ['설정']);
        assert.deepEqual((await tipLines(lab)).filter((t) => t.startsWith('필요한')), ['필요한 설정: SYSTEM.LAB_ENABLED 켬']);
        assert.match((await tipLines(lab))[0], /^이 링크의 조건: globalSettings\.SYSTEM\.LAB_ENABLED$/);
        const report = await screenBox(p, '/admin/report#AdminReport');
        assert.deepEqual(await needTag(report), ['역할·설정']);
        assert.deepEqual((await tipLines(report)).filter((t) => t.startsWith('필요한')), [
          '필요한 역할: ADMIN, OWNER',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN.LIST 에 "ADMIN_REPORT"',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN 있음',
        ]);
        assert.match((await (await screenBox(p, '/help#Help')).getAttribute('class'))!, /s-fail/);
        assert.equal(await statusLine(await screenBox(p, '/help#Help')), '실패 · 불러옴 2', 'untagged tests are counted apart and do not set the status');
        assert.deepEqual(await p.evaluate(() => openNeeds({ access: { settings: [{ from: 'route', unreadable: [], needs: [
          { path: ['SYSTEM', 'MENU'], need: 'present' },
          { path: ['SYSTEM', 'MENU', 'LIST'], need: 'includes', value: 'X' },
        ] }] } }).lines.map((l) => l.text)), ['설정 "X" (MENU.LIST 에) 외 1']);
        assert.deepEqual(await p.evaluate(() => openNeeds({ access: { roleValues: null, unreadableRoleGuards: [] } })), {
          lines: [{ kind: 'role', text: '역할 미확인' }], tips: ['필요한 역할: 미확인'], bare: null,
        });

        const titles = await p.locator('#flow .box.screen').evaluateAll((boxes) => boxes.map((b) => b.getAttribute('title')!.split('\n').at(-1)));
        assert.deepEqual([...new Set(titles)], [PICK_HINT]);
        const heights = await p.$$eval('#flow .box.screen', (els: HTMLElement[]) => els.map((e) => e.offsetHeight));
        assert.ok(Math.max(...heights) < 30, `every screen is one line (${Math.max(...heights)}px)`);
        assert.deepEqual(await textOutside(p), []);
        assert.deepEqual(await layoutErrors(p), []);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a flow box sits midway between its first and last child and stays inside the canvas apart from the boxes in its column, whatever the box heights', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const { trees, gap } = await p.evaluate(() => {
          const sizes: Record<string, { width: number; height: number }> = {};
          const screen = (id: string, height: number, children: object[] = []) => {
            sizes[id] = { width: 100 + id.length * 10, height };
            return { kind: 'screen', id, children, calls: [], guards: [] };
          };
          const [plain, tall, tallest] = [24, 41, 58];
          const shapes = {
            plain: [screen('root', plain, [screen('a', plain), screen('b', plain)])],
            tallFirst: [screen('root', plain, [screen('tall', tall), screen('next', plain, [screen('grandchild', plain)])])],
            tallOverScreens: [screen('root', plain, [screen('p', tallest, [screen('p1', plain)]), screen('q', tallest, [screen('q1', plain)])])],
            tallOverTall: [screen('root', plain, [screen('x', plain), screen('outer', tallest, [screen('inner', tall)])])],
          };
          return {
            gap: GAP,
            trees: Object.fromEntries(Object.entries(shapes).map(([name, roots]) => {
              const { boxes, edges, height } = layoutFlow(roots, sizes);
              return [name, { height, edges: edges.map((e): [string, number, number] => [e.from, e.y1, e.y2]), boxes: boxes.map((b) => ({ id: b.key, x: b.x, y: b.y, bottom: b.y + b.height })) }];
            })),
          };
        });
        for (const [name, { height, edges, boxes }] of Object.entries(trees)) {
          for (const parent of new Set(edges.map(([from]) => from))) {
            const ends = edges.filter(([from]) => from === parent).map(([, , y2]) => y2);
            const [, y1] = edges.find(([from]) => from === parent)!;
            assert.equal(y1, (Math.min(...ends) + Math.max(...ends)) / 2, `${name}: the box at ${parent} sits midway between its children`);
          }
          for (const b of boxes) assert.ok(b.y >= 0 && b.bottom <= height, `${name}: ${b.id} is inside the canvas`);
          for (const a of boxes) for (const b of boxes) {
            if (a !== b && a.x === b.x) assert.ok(a.bottom + gap <= b.y || b.bottom + gap <= a.y, `${name}: ${a.id} and ${b.id} keep a gap between them`);
          }
        }
      }),
    ),
  );
});

test('in a browser, a screen in the flow says on hover when a setting condition could not be turned into a value', { skip: browserMissing }, async () => {
  const edits: [string, string, string][] = [
    ['client/src/components/DocumentDetail.js', 'const helpEnabled = system.HELP_LINK_ENABLED;', 'const helpEnabled = () => system.HELP_LINK_ENABLED;'],
    ['client/src/components/DocumentDetail.js', '{helpEnabled && <Link', '{helpEnabled() && <Link'],
  ];
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const help = await screenBox(p, '/help#Help');
        assert.deepEqual(await needTag(help), ['설정']);
        assert.ok((await tipLines(help)).some((t) => t.startsWith('정하지 못한 설정 조건: helpEnabled()')));
      }, { view: 'flow' }),
    ), edits);
});

test('in a browser, when the first flow drawing fails the message stays visible and neither view button changes that', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#failed', { state: 'visible' });
        assert.match((await p.textContent('#failed'))!, /^페이지를 그리지 못했습니다: ./);
        assert.equal(await p.isHidden('main'), true);
        assert.equal(await p.isHidden('#flow'), true);
        for (const id of ['#view-flow', '#view-list', '#view-flow']) {
          await p.click(id);
          assert.equal(await p.isVisible('#failed'), true);
          assert.equal(await p.isHidden('main'), true);
          assert.equal(await p.isHidden('#flow'), true);
        }
        assert.equal(await p.locator('main section').count(), 4);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots[0].guards = null; }) }),
    ),
  );
});

test('in a browser, a map with no screens says so in the flow, and the entryPaths hint is only for screens with no entry', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('.flowbar .flowsummary');
        assert.match((await p.textContent('#flow'))!, /entryPaths/);
        assert.doesNotMatch((await p.textContent('#flow'))!, /화면이 없습니다\./);
      }, { view: 'flow', setup: changeData((data) => {
        data.flow = { ...data.flow, roots: [], unreached: [...data.flow.roots, ...data.flow.unreached] };
      }) }),
    );
    fs.writeFileSync(mapFile, JSON.stringify({ ...map, screens: [], entries: [] }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('.flowbar .flowsummary');
        assert.match((await p.textContent('#flow'))!, /화면이 없습니다\./);
        assert.doesNotMatch((await p.textContent('#flow'))!, /entryPaths/);
        assert.equal(await p.textContent('#gaps h2'), '손볼 화면 0');
        assert.equal(await p.textContent('#gaps p:last-child'), '손볼 화면이 없습니다.');
      }, { view: 'flow' }),
    );
  });
});

const LONG_ROUTE = '/user-completed-documents/signature-requests/:documentId/participants/history';
const withLongRoute = (data: PageData) => {
  walkFlow(data.flow.roots).find((n) => n.id === '/help#Help')!.label = LONG_ROUTE;
};
const flowBoxes = (p: Page) => p.$$eval('#flow .box', (els: HTMLElement[]) => els.map((e) => {
  const r = e.getBoundingClientRect();
  return { id: e.title.split('\n')[0], left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, grouped: e.classList.contains('grouped') };
}));
const overlapping = (boxes: Awaited<ReturnType<typeof flowBoxes>>) => boxes.flatMap((a, i) => boxes.slice(i + 1)
  .filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
  .map((b) => `${a.id} / ${b.id}`));

test('in a browser, every flow box stands where the layout put it, each line ending at the middle of its box and boxes under one another keeping the layout\'s gap, also with gathered entry screens', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        assert.deepEqual(await layoutErrors(p), []);
        assert.deepEqual(await textOutside(p), []);
        assert.deepEqual(overlapping(await flowBoxes(p)), []);
      }, { view: 'flow', setup: changeData((data) => {
        withLongRoute(data);
        const extras = leafEntries(data, 3);
        extras[0].label = LONG_ROUTE;
        data.flow.roots.push(...extras);
      }) }),
    ),
  );
});

test('in a browser, resizing the window after the review ended throws nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => {} });
    try {
      await withPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async (p) => {
        await p.waitForSelector('#flow .group-head');
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        await p.setViewportSize({ width: 900, height: 700 });
        await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) });
    } finally {
      server.close();
    }
  });
});

test('in a browser, the flow is drawn again on a resize only when gathered entry screens are shown and the number of cells in a row changes', { skip: browserMissing }, async () => {
  const frames = (p: Page) => p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const mark = (p: Page) => p.evaluate(() => { document.querySelector<HTMLElement>('#flow .box')!.dataset.before = ''; });
  const kept = (p: Page) => p.evaluate(() => document.querySelector('#flow .box[data-before]') !== null);
  const resize = async (p: Page, width: number, height: number) => {
    await p.setViewportSize({ width, height });
    await frames(p);
  };
  const perRow = (p: Page) => p.evaluate(() => drawnGrid!.per);
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const wide = await perRow(p);
        await mark(p);
        await resize(p, 1430, 600);
        assert.equal(await perRow(p), wide);
        assert.ok(await kept(p), 'a small change of width that keeps the number of cells in a row keeps the drawing');
        await resize(p, 1000, 600);
        assert.ok(await perRow(p) < wide, 'a narrower window holds fewer cells in a row');
        assert.ok(!(await kept(p)), 'a change that alters the number of cells in a row draws the gathered entry screens again');
        const narrow = await perRow(p);
        await (await screenBox(p, '/home#Home')).click();
        assert.ok(await perRow(p) < narrow, 'picking a screen gives the drawing less room and fewer cells in a row');
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        assert.equal(await p.locator('#flow .group-head').count(), 0);
        await mark(p);
        await resize(p, 900, 900);
        assert.ok(await kept(p), 'with nothing gathered the width does not change the drawing');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a flow box with a long route breaks it only before a slash, its column grows no wider than the longest box needs, and no box cuts or spills its text', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const help = await (await screenBox(p, '/help#Help')).evaluate((box, route) => {
          const texts: Text[] = [];
          const walker = document.createTreeWalker(box.querySelector('.path')!, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) texts.push(walker.currentNode as Text);
          const chars = texts.flatMap((node) => [...node.data].map((ch, i) => {
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            return { ch, top: Math.round(range.getBoundingClientRect().top) };
          }));
          const whole = chars.map((c) => c.ch).join('');
          const lineStarts = chars.filter((c, i) => i > 0 && c.top > chars[i - 1].top).map((c) => c.ch);
          return { whole, routeLines: new Set(chars.map((c) => c.top)).size, lineStarts, width: box.getBoundingClientRect().width };
        }, LONG_ROUTE);
        assert.equal(help.whole, LONG_ROUTE);
        assert.ok(help.routeLines > 1, 'the long route takes more than one line');
        assert.deepEqual([...new Set(help.lineStarts)], ['/']);
        assert.ok(help.width <= 360, `the box stays within 360px (${help.width})`);
        const boxes = await flowBoxes(p);
        const left = boxes.find((b) => b.id === '/help#Help')!.left;
        assert.deepEqual([...new Set(boxes.filter((b) => b.left === left).map((b) => b.width))], [help.width], 'the boxes of a column share its width');

        const cut = await p.$$eval('#flow .box', (els: HTMLElement[]) => els
          .filter((box) => box.textContent.includes('…') || [box, ...box.querySelectorAll('*')].some((e) => getComputedStyle(e).textOverflow === 'ellipsis'))
          .map((box) => box.title.split('\n')[0]));
        assert.deepEqual(cut, []);
        assert.deepEqual(await textOutside(p), []);
        assert.deepEqual(await layoutErrors(p), []);
        assert.deepEqual(overlapping(boxes), []);
      }, { view: 'flow', setup: changeData(withLongRoute) }),
    ),
  );
});

test('in a browser, the zoom buttons shrink and grow the whole drawing around its layout, fit it into view, and keep the level across redraws', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1000, height: 300 });
        await p.waitForSelector('#flow .box.screen');
        const zoom = p.locator('#flow-zoom');
        assert.deepEqual(await zoom.locator('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['그림 전체가 보이게 맞춤', '축소', '확대']);
        assert.equal(await zoom.locator('.zoom-level').inputValue(), '100%');
        const measure = () => p.evaluate(() => {
          const canvas = document.querySelector<HTMLElement>('#flow .canvas')!;
          const box = document.querySelector<HTMLElement>('#flow .box.screen')!;
          return { layoutWidth: canvas.offsetWidth, drawnWidth: canvas.getBoundingClientRect().width, holder: canvas.parentElement!.getBoundingClientRect().width, left: box.style.left, boxWidth: box.getBoundingClientRect().width };
        });
        const full = await measure();
        await zoom.locator('.zoom-out').click();
        await zoom.locator('.zoom-out').click();
        assert.equal(await zoom.locator('.zoom-level').inputValue(), '80%');
        assert.equal(await p.evaluate(() => document.activeElement!.className), 'zoom-out', 'the pressed button keeps the focus');
        const small = await measure();
        assert.equal(small.layoutWidth, full.layoutWidth, 'the layout is worked out at full size');
        assert.equal(small.left, full.left);
        assert.ok(Math.abs(small.drawnWidth - full.layoutWidth * 0.8) <= 1, `${small.drawnWidth} against ${full.layoutWidth}`);
        assert.ok(Math.abs(small.holder - small.drawnWidth) <= 1, 'the room the drawing takes shrinks with it');
        assert.ok(Math.abs(small.boxWidth - full.boxWidth * 0.8) <= 1);
        await p.evaluate(() => renderFlow());
        assert.equal(await zoom.locator('.zoom-level').inputValue(), '80%');

        await zoom.locator('.zoom-fit').click();
        const fit = await p.evaluate(() => {
          const flow = document.getElementById('flow')!;
          return { level: state.zoom, scrollH: flow.scrollHeight, clientH: flow.clientHeight, scrollW: flow.scrollWidth, clientW: flow.clientWidth };
        });
        assert.ok(fit.level < 0.8 && fit.level >= 0.3, `fit chose ${fit.level}`);
        assert.ok(fit.scrollH <= fit.clientH + 1 && fit.scrollW <= fit.clientW + 1, `the whole drawing is in view: ${JSON.stringify(fit)}`);
        for (let i = 0; i < 20; i += 1) if (await zoom.locator('.zoom-in').isEnabled()) await zoom.locator('.zoom-in').click();
        assert.equal(await zoom.locator('.zoom-level').inputValue(), '150%');
        assert.equal(await zoom.locator('.zoom-in').isDisabled(), true);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, fit gives the largest zoom at which gathered entry screens, which take more columns as the zoom shrinks, still fit in view', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 900 });
        await p.waitForSelector('#flow .group-head');
        const fitsAt = (level: number) => p.evaluate((z) => {
          setZoom(z);
          const flow = document.getElementById('flow')!;
          const boxes = [...flow.querySelectorAll<HTMLElement>('.box.screen')].map((b) => b.getBoundingClientRect());
          const pane = flow.getBoundingClientRect();
          return flow.scrollHeight <= flow.clientHeight && flow.scrollWidth <= flow.clientWidth && boxes.every((r) => r.bottom <= pane.bottom + 1 && r.right <= pane.right + 1);
        }, level);
        await p.locator('#flow-zoom .zoom-fit').click();
        const level = await p.evaluate(() => state.zoom);
        assert.ok(level > 0.3, `fit chose ${level}`);
        assert.equal(await fitsAt(level), true, `everything fits at ${level}`);
        if (level < 1) assert.equal(await fitsAt(Math.round(level * 100 + 1) / 100), false, 'one percent more no longer fits');
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 120)); }) }),
    ),
  );
});

test('in a browser, the zoom control floats at the bottom-left of the drawing pane, stays there when a picked screen narrows the pane, and leaves the last row uncovered', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        for (const width of [1920, 1440]) {
          await p.setViewportSize({ width, height: 320 });
          await p.waitForSelector('#flow .box.screen');
          for (const pick of [false, true]) {
            if (pick) await (await screenBox(p, '/home#Home')).click();
            else if ((await pickedBoxes(p)).length) await p.locator('.flowbar .unpick').click();
            const m = await p.evaluate(() => {
              const flow = document.getElementById('flow')!;
              flow.scrollTop = flow.scrollHeight;
              flow.scrollLeft = 0;
              const pane = flow.getBoundingClientRect();
              const zoom = document.getElementById('flow-zoom')!.getBoundingClientRect();
              const meets = (r: DOMRect) => r.left < zoom.right && r.right > zoom.left && r.top < zoom.bottom && r.bottom > zoom.top;
              const others = ['.flowbar', '#center', '#right', '#gaps'].map((sel) => document.querySelector(sel)!).filter((e) => !(e as HTMLElement).hidden);
              return {
                toLeft: zoom.left - pane.left, toBottom: pane.bottom - zoom.bottom, inside: zoom.right < pane.right && zoom.top > pane.top, width: zoom.width,
                scrolls: flow.scrollHeight > flow.clientHeight,
                covered: [...flow.querySelectorAll<HTMLElement>('.box.screen, .group-head, :scope > h2')].filter((e) => meets(e.getBoundingClientRect())).map((e) => e.dataset.key ?? e.textContent),
                overlaps: others.filter((e) => meets(e.getBoundingClientRect())).map((e) => e.id || e.className),
              };
            });
            const at = `${width}px, ${pick ? 'picked' : 'not picked'}`;
            assert.ok(m.toLeft >= 8 && m.toLeft <= 24, `${at}: ${m.toLeft}px from the pane's left edge`);
            assert.ok(m.toBottom >= 8 && m.toBottom <= 32, `${at}: ${m.toBottom}px from the pane's bottom edge`);
            assert.ok(m.inside, at);
            assert.ok(m.width <= 200, `${at}: the control is ${m.width}px wide`);
            assert.ok(m.scrolls, `${at}: the drawing is taller than the pane`);
            assert.deepEqual(m.covered, [], `${at}: nothing in the drawing sits under the control when scrolled to the end`);
            assert.deepEqual(m.overlaps, [], at);
          }
          assert.deepEqual(await pickedBoxes(p), ['/home#Home']);
          await p.locator('#flow-zoom .zoom-in').click();
          assert.deepEqual(await pickedBoxes(p), ['/home#Home'], 'pressing the control does not let the picked screen go');
          await p.locator('#flow-zoom .zoom-out').click();
          await p.locator('.flowbar .unpick').click();
        }
        await p.click('#view-list');
        assert.equal(await p.locator('#flow-zoom').isVisible(), false, 'the list view has no zoom control');
        await p.click('#view-flow');
        assert.equal(await p.locator('#flow-zoom').isVisible(), true);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a percent typed into the zoom control applies on Enter or on leaving it, snaps to the nearest end when out of range, and Escape or a non-number keeps the level', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const level = p.locator('#flow-zoom .zoom-level');
        const now = () => p.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('#flow-zoom .zoom-level')!;
          return { zoom: state.zoom, value: input.value, focused: document.activeElement === input, selected: input.value.slice(input.selectionStart!, input.selectionEnd!), scale: document.querySelector<HTMLElement>('#flow .canvas')!.style.transform };
        });
        const type = async (text: string, key: string) => {
          await p.keyboard.press('Control+A');
          await p.keyboard.type(text);
          await p.keyboard.press(key);
        };
        assert.equal(await level.getAttribute('aria-label'), '배율 (퍼센트)');

        await level.click();
        assert.deepEqual(await now(), { zoom: 1, value: '100%', focused: true, selected: '100%', scale: '' }, 'pressing the percent selects it');
        await type('75', 'Enter');
        assert.deepEqual(await now(), { zoom: 0.75, value: '75%', focused: true, selected: '75%', scale: 'scale(0.75)' });
        await type('abc', 'Enter');
        assert.deepEqual(await now(), { zoom: 0.75, value: '75%', focused: true, selected: '75%', scale: 'scale(0.75)' }, 'a non-number goes back');
        await type('', 'Enter');
        assert.equal((await now()).value, '75%', 'so does an empty field');
        await p.keyboard.type('60');
        await p.keyboard.press('Escape');
        assert.deepEqual(await now(), { zoom: 0.75, value: '75%', focused: true, selected: '75%', scale: 'scale(0.75)' }, 'Escape goes back');
        await type('500', 'Enter');
        assert.equal((await now()).value, '150%');
        assert.equal(await p.locator('#flow-zoom .zoom-in').isDisabled(), true);
        await type('10%', 'Enter');
        assert.equal((await now()).value, '30%');
        assert.equal(await p.locator('#flow-zoom .zoom-out').isDisabled(), true);

        await type('90', 'Tab');
        assert.equal((await now()).zoom, 0.9, 'leaving the field applies it');
        await level.click();
        await p.keyboard.type('120');
        await p.locator('.flowbar .flowsummary').click();
        assert.deepEqual(await now(), { zoom: 1.2, value: '120%', focused: false, selected: '', scale: 'scale(1.2)' }, 'so does pressing outside it');

        await (await screenBox(p, '/home#Home')).click();
        await level.click();
        await p.keyboard.type('80');
        await p.locator('#flow-zoom .zoom-in').click();
        assert.equal((await now()).value, '90%', 'pressing + right after typing applies both');
        await level.click();
        await p.keyboard.press('Escape');
        assert.deepEqual(await pickedBoxes(p), ['/home#Home'], 'Escape in the field keeps the picked screen');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, pressing a filter, a screen box, 「선택 해제」 or 「새 스토리」 right after typing a percent does what it does and applies the percent', { skip: browserMissing }, async () => {
  await withPathStories({ walk: WALK }, async (p) => {
    const level = p.locator('#flow-zoom .zoom-level');
    const typed = async (text: string) => {
      await level.click();
      await p.keyboard.type(text);
    };
    const zoom = () => p.evaluate(() => [state.zoom, document.querySelector<HTMLInputElement>('#flow-zoom .zoom-level')!.value]);

    await typed('80');
    await filterButton(p, 'fail').click();
    assert.equal(await filterButton(p, 'fail').getAttribute('aria-pressed'), 'true', 'the filter is on');
    assert.deepEqual(await zoom(), [0.8, '80%']);

    await typed('70');
    await (await screenBox(p, '/home#Home')).click();
    assert.deepEqual(await pickedBoxes(p), ['/home#Home'], 'the screen is picked');
    assert.deepEqual(await zoom(), [0.7, '70%']);

    await typed('60');
    await p.locator('.flowbar .unpick').click();
    assert.deepEqual(await pickedBoxes(p), [], 'the screen is let go');
    assert.deepEqual(await zoom(), [0.6, '60%']);

    await typed('90');
    await p.locator('.flowbar .new-story').click();
    assert.equal(await flowPlace(p), '#story?new=1', 'a new story is started');
    assert.deepEqual(await zoom(), [0.9, '90%']);
  });
});

test('in a browser, a percent left by a press that ends in a drag applies when the drag ends, and leaves nothing behind for the next press or Tab', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const level = p.locator('#flow-zoom .zoom-level');
        const zoom = () => p.evaluate(() => state.zoom);
        await level.focus();
        await p.keyboard.type('80');
        await p.evaluate(() => {
          const box = document.querySelector('#flow .box.screen')!;
          box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          document.querySelector<HTMLInputElement>('#flow-zoom .zoom-level')!.blur();
          box.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        });
        await p.waitForFunction(() => state.zoom === 0.8);

        await level.focus();
        await p.keyboard.press('Control+A');
        await p.keyboard.type('90');
        await p.keyboard.press('Tab');
        assert.equal(await zoom(), 0.9, 'Tab applies at once after the drag');
        await p.locator('#flow-zoom .zoom-in').click();
        assert.equal(await zoom(), 1, 'no earlier percent comes back after the next press');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, flow boxes stand in columns by how many links they are from an entry screen, each column as wide as its boxes need and the same for all of them, with no two boxes overlapping', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const boxes = await flowBoxes(p);
        const byId = Object.fromEntries(boxes.map((b) => [b.id, b]));
        const columns = new Map<number, typeof boxes>();
        for (const b of boxes) columns.set(b.left, [...(columns.get(b.left) ?? []), b]);
        for (const [left, column] of columns) assert.equal(new Set(column.map((b) => b.width)).size, 1, `the boxes at ${left} share one width`);
        assert.equal(byId['/home#Home'].left, byId['/help#Help'].left);
        assert.equal(byId['/lab#Lab'].left, byId['/admin/report#AdminReport'].left);
        assert.ok(byId['/lab/result#LabResult'].left > byId['/lab#Lab'].right);
        assert.ok(byId['/signin#SignIn'].width < byId['/help#Help'].width, 'the entry column is narrower than the column holding the long route');
        assert.deepEqual(overlapping(boxes), []);
      }, { view: 'flow', setup: changeData(withLongRoute) }),
    ),
  );
});

test('in a browser, entry screens with nothing drawn under them are gathered under 「딸린 화면이 없는 진입 화면 N」 below the branching ones, its hover saying why, in several columns, each box showing what any box shows', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        assert.equal(await p.textContent('#flow .group-head'), '딸린 화면이 없는 진입 화면 8');
        assert.match((await p.getAttribute('#flow .group-head', 'title'))!, /^밑으로 이어 그린 화면이 없는 진입 화면입니다\./);
        const boxes = await flowBoxes(p);
        const grouped = boxes.filter((b) => b.grouped);
        assert.deepEqual(grouped.map((b) => b.id).sort(), Array.from({ length: 8 }, (_, i) => `/extra/${i}#Extra${i}`).sort());
        const head = await p.$eval('#flow .group-head', (e) => e.getBoundingClientRect().toJSON());
        const tree = boxes.filter((b) => !b.grouped);
        assert.ok(tree.some((b) => b.id === '/signin#SignIn'));
        assert.ok(tree.every((b) => b.bottom <= head.top), 'the branching entry screens come first');
        assert.ok(grouped.every((b) => b.top >= head.bottom), 'the gathered boxes sit under the heading');
        assert.ok(new Set(grouped.map((b) => b.left)).size > 1, 'the gathered boxes stand in more than one column');
        assert.deepEqual(overlapping(boxes), []);

        const failing = await screenBox(p, '/extra/7#Extra7');
        assert.match((await failing.getAttribute('class'))!, /s-fail/);
        assert.equal(await statusLine(failing), '실패 · 불러옴 2');
        assert.deepEqual(await needTag(await screenBox(p, '/extra/3#Extra3')), ['역할']);
        await failing.click();
        assert.deepEqual(await pickedBoxes(p), ['/extra/7#Extra7']);
        assert.equal((await boxesWith(p, 'dim')).length, (await boxCount(p)) - 1, 'a gathered screen has no paths, so every other screen dims');
        assert.equal(await p.textContent('#flow .group-head'), '딸린 화면이 없는 진입 화면 8');
        assert.deepEqual(overlapping(await flowBoxes(p)), []);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        assert.equal(await p.textContent('#flow .group-head'), '딸린 화면이 없는 진입 화면 3');
        const first = await p.$$eval('#flow .canvas', ([canvas]) => [...canvas.querySelectorAll('.box.screen')].map((e) => e.classList.contains('grouped')));
        assert.deepEqual(first, [true, true, true]);
      }, { view: 'flow', setup: changeData((data) => {
        const extras = leafEntries(data, 3);
        data.flow = { ...data.flow, unreached: [...data.flow.roots, ...data.flow.unreached], roots: extras };
      }) }),
    ),
  );
});

test('in a browser, the gathered entry screens take fewer columns once the window gets narrower', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const columns = () => p.$$eval('#flow .box.screen.grouped', (els: HTMLElement[]) => new Set(els.map((e) => e.offsetLeft)).size);
        const wide = await columns();
        assert.ok(wide > 1);
        await p.setViewportSize({ width: 700, height: 900 });
        await p.waitForFunction((n) => new Set([...document.querySelectorAll<HTMLElement>('#flow .box.screen.grouped')].map((e) => e.offsetLeft)).size < n, wide);
        assert.equal(await p.locator('#flow .box.screen.grouped').count(), 8);
        assert.deepEqual(overlapping(await flowBoxes(p)), []);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
});

test('in a browser, redrawing the flow keeps the place the reviewer scrolled to, and picking a screen already in view does not scroll', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 300 });
        await p.waitForSelector('#flow .group-head');
        const scrolled = await p.evaluate(() => {
          const flow = document.getElementById('flow')!;
          flow.scrollTop = 200;
          return flow.scrollTop;
        });
        assert.equal(scrolled, 200);
        await p.evaluate(() => renderFlow());
        assert.equal(await p.evaluate(() => document.getElementById('flow')!.scrollTop), 200);
        const visible = await p.$$eval('#flow .box.screen', (els: HTMLElement[]) => {
          const view = document.getElementById('flow')!.getBoundingClientRect();
          return els.find((e) => { const r = e.getBoundingClientRect(); return r.top > view.top + 20 && r.bottom < view.bottom - 20 && r.left > view.left && r.right < view.left + view.width / 2; })!.dataset.key!;
        });
        await (await screenBox(p, visible)).click();
        assert.equal(await p.evaluate(() => document.getElementById('flow')!.scrollTop), 200);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
});

test('in a browser, the flow layout is worked out from the trees and the box sizes alone, the same every time, and each box\'s width from the widths alone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const [first, second, columns] = await p.evaluate(() => {
          const screen = (id: string, children: object[] = []) => ({ kind: 'screen', id, children, calls: [], guards: [] });
          const roots = [screen('A', [screen('B'), screen('C')]), screen('D'), screen('E')];
          const sizes = { A: { width: 100, height: 40 }, B: { width: 120, height: 30 }, C: { width: 80, height: 50 }, D: { width: 90, height: 30 }, E: { width: 70, height: 20 } };
          const view = { group: true, width: 300 };
          state.flowPicked = true;
          state.zoom = 0.5;
          const { widths, grouped } = flowColumns(roots, sizes, view);
          return [layoutFlow(roots, sizes, view), layoutFlow(roots, sizes, view), { widths, grouped: [...grouped] }];
        });
        assert.deepEqual(first, second);
        assert.deepEqual(columns, { widths: { A: 100, B: 120, C: 120, D: 90, E: 90 }, grouped: ['D', 'E'] });
        const boxes = Object.fromEntries(first.boxes.map(({ key, ...b }) => [key, b]));
        assert.deepEqual(boxes, {
          A: { x: 0, y: 19, width: 100, height: 40, grouped: false },
          B: { x: 150, y: 0, width: 120, height: 30, grouped: false },
          C: { x: 150, y: 38, width: 120, height: 50, grouped: false },
          D: { x: 0, y: 148, width: 90, height: 30, grouped: true },
          E: { x: 114, y: 148, width: 90, height: 20, grouped: true },
        });
        const edges = Object.fromEntries(first.edges.map(({ from, to, ...e }) => [`${from} ${to}`, e]));
        assert.deepEqual(edges, {
          'A B': { x1: 100, y1: 39, x2: 150, y2: 15, guards: [] },
          'A C': { x1: 100, y1: 39, x2: 150, y2: 63, guards: [] },
        });
        assert.deepEqual(first.group, { x: 0, y: 120, height: 28, count: 2 });
        assert.equal(first.width, 270);
        assert.equal(first.height, 186);
      }, { view: 'flow' }),
    ),
  );
});
