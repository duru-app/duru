import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { withRebuiltFixture, withServer, withFakeApi, appSettings, withPassword, browserMissing, toList, withPage, screenBox, changeData, leafEntries, paneWidths, dragEdge, rgb, nextFrame } from './review-helpers.ts';

declare let drawnGrid: { count: number; cellW: number; per: number } | null;
const edgeLine = (p: Page, id: string) => p.evaluate((id) => {
  const edge = document.getElementById(id)!;
  const r = edge.getBoundingClientRect();
  const line = getComputedStyle(edge, '::before');
  return { middle: r.left + r.width / 2, grab: r.width, width: line.width, color: line.backgroundColor, delay: line.transitionDelay, accent:getComputedStyle(document.body).getPropertyValue('--accent').trim() };
}, id);

test('in a browser, the edges on both sides of the middle pane of the list are dragged from a few pixels off the line, each pane stops at its minimum width, and the widths stay until the page is loaded again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const ids = ['left', 'center', 'right'];
        for (const width of [1920, 1440]) {
          await p.setViewportSize({ width, height: 900 });
          await p.reload();
          await toList(p);
          await p.click('#screen-list li:has-text("/lab/result")');
          assert.deepEqual(await paneWidths(p, ids), [300, width - 660, 360]);
          for (const [edge, pane] of [['sash-left', 'center'], ['sash-right', 'right']]) {
            const line = await edgeLine(p, edge);
            const border = await p.evaluate((id) => document.getElementById(id)!.getBoundingClientRect().left + 0.5, pane);
            assert.equal(line.middle, border, `${edge} sits on the border of #${pane}`);
            assert.ok(line.grab >= 8, `${edge} is grabbed across ${line.grab}px`);
            assert.equal(line.width, '1px');
          }

          await dragEdge(p, 'sash-left', 100);
          assert.deepEqual(await paneWidths(p, ids), [400, width - 760, 360], `${width}: the left edge moves with the mouse`);
          await dragEdge(p, 'sash-right', -80, { off: -3 });
          assert.deepEqual(await paneWidths(p, ids), [400, width - 840, 440], `${width}: the right edge moves with the mouse`);
          await dragEdge(p, 'sash-left', -500);
          assert.equal((await paneWidths(p, ids))[0], 300, `${width}: the list stops at its minimum`);
          await dragEdge(p, 'sash-right', 1000);
          assert.equal((await paneWidths(p, ids))[2], 320, `${width}: the right pane stops at its minimum`);
          await dragEdge(p, 'sash-right', -3000);
          assert.deepEqual(await paneWidths(p, ids), [300, 360, width - 660], `${width}: the middle pane stops at its minimum`);
          await dragEdge(p, 'sash-right', width - 660 - 500);
          assert.deepEqual(await paneWidths(p, ids), [300, width - 800, 500]);

          await p.click('#view-flow');
          await toList(p);
          assert.deepEqual(await paneWidths(p, ids), [300, width - 800, 500], `${width}: the widths stay across views`);
        }

        await p.setViewportSize({ width: 1100, height: 900 });
        await nextFrame(p);
        assert.deepEqual(await paneWidths(p, ids), [300, 360, 440], 'a narrower window takes the room for the middle pane from the dragged pane');
        await p.setViewportSize({ width: 1440, height: 900 });
        await nextFrame(p);
        assert.deepEqual(await paneWidths(p, ids), [300, 640, 500], 'a wider window gives the dragged width back');

        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.deepEqual(await paneWidths(p, ids), [300, 780, 360], 'loading the page again starts from the first widths');
      }),
    ),
  );
});

test('in a browser, dragging the right edge of the flow before the drawing edge was ever dragged leaves the drawing where it is, and the drawing still grows with the window', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const ids = ['flow', 'center', 'right'];
        await p.setViewportSize({ width: 1440, height: 900 });
        await p.evaluate(() => history.replaceState(null, '', '#flow'));
        await p.reload();
        await p.waitForSelector('#flow .group-head');
        await (await screenBox(p, '/home#Home')).click();
        const [graph, center] = await paneWidths(p, ids);
        await dragEdge(p, 'sash-right', -100, { off: -3 });
        assert.deepEqual(await paneWidths(p, ids), [graph, center - 100, 460]);
        await p.setViewportSize({ width: 1920, height: 900 });
        await p.waitForFunction((w) => Math.round(document.getElementById('flow')!.getBoundingClientRect().width) === w, graph + 240);
        assert.deepEqual(await paneWidths(p, ids), [graph + 240, center + 140, 460]);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
});

test('in a browser, the edges on both sides of the middle pane of the flow are dragged, the drawing is laid out again for the width of its pane, and the drawing stops at its minimum width', { skip: browserMissing }, async () => {
  const perRow = (p: Page) => p.evaluate(() => drawnGrid!.per);
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const ids = ['flow', 'center', 'right'];
        for (const width of [1920, 1440]) {
          await p.setViewportSize({ width, height: 900 });
          await p.evaluate(() => history.replaceState(null, '', '#flow'));
          await p.reload();
          await p.waitForSelector('#flow .group-head');
          assert.equal(await p.locator('.sash:visible').count(), 0, 'with no screen picked the flow has no edge to drag');
          await (await screenBox(p, '/home#Home')).click();
          const half = (width - 360) / 2;
          assert.deepEqual(await paneWidths(p, ids), [half, half, 360]);
          const wide = await perRow(p);

          await dragEdge(p, 'sash-left', -200, { off: -3 });
          await nextFrame(p);
          assert.deepEqual(await paneWidths(p, ids), [half - 200, half + 200, 360], `${width}: the edge between the drawing and the middle pane moves with the mouse`);
          assert.ok(await perRow(p) < wide, `${width}: a narrower drawing holds fewer cells in a row`);
          await dragEdge(p, 'sash-left', -2000);
          assert.equal((await paneWidths(p, ids))[0], 240, `${width}: the drawing stops at its minimum`);
          await dragEdge(p, 'sash-right', -100);
          assert.equal((await paneWidths(p, ids))[2], 460, `${width}: the right pane moves with the mouse`);

          await p.click('#view-list');
          await p.click('#screen-list li:has-text("/home")');
          assert.equal((await paneWidths(p, ['right']))[0], 460, `${width}: the list shows the same right pane width`);
        }
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
});

test('in a browser, an edge takes the accent colour a moment after the mouse rests on it and at once while it is dragged, without getting thicker', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#screen-list li:has-text("/lab/result")');
        const unlit = 'rgba(0, 0, 0, 0)';
        assert.equal((await edgeLine(p, 'sash-right')).color, unlit, 'only the gray border shows until the mouse comes');
        const box = (await p.locator('#sash-right').boundingBox())!;
        const y = box.y + 300;
        await p.mouse.move(box.x + box.width / 2 + 3, y);
        const resting = await edgeLine(p, 'sash-right');
        assert.equal(resting.color, unlit, 'a mouse passing over does not light the edge at once');
        assert.equal(resting.delay, '0.3s', 'the edge lights only once the mouse has rested on it');
        await p.waitForTimeout(600);
        const hovered = await edgeLine(p, 'sash-right');
        assert.equal(hovered.color, rgb(hovered.accent));
        assert.equal(hovered.width, '1px');

        await p.mouse.move(box.x - 200, y);
        await p.waitForTimeout(300);
        assert.equal((await edgeLine(p, 'sash-right')).color, unlit);
        await p.mouse.move(box.x + box.width / 2, y);
        await p.mouse.down();
        const dragged = await edgeLine(p, 'sash-right');
        assert.equal(dragged.color, rgb(dragged.accent), 'a press lights the edge without the wait');
        assert.equal(dragged.width, '1px');
        await p.mouse.move(box.x - 150, y, { steps: 4 });
        assert.equal((await edgeLine(p, 'sash-right')).color, rgb(dragged.accent), 'the edge stays lit while the mouse is off it during the drag');
        await p.mouse.up();
        await p.mouse.move(box.x - 400, y);
        await p.waitForTimeout(300);
        assert.equal((await edgeLine(p, 'sash-right')).color, unlit, 'the edge goes back to gray once let go and left');
      }),
    ),
  );
});

test('in a browser, an edge dragged across the app frame keeps following the mouse, and the frame takes the mouse again once the edge is let go', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.click('#screen-list li:has-text("/home")');
            await p.frameLocator('#center iframe.app').locator('#who:has-text("두루 관리자")').waitFor();
            const frame = (await p.locator('#center iframe.app').boundingBox())!;
            const pointer = () => p.$eval('#center iframe.app', (f) => getComputedStyle(f).pointerEvents);
            assert.equal(await pointer(), 'auto');
            const edge = (await p.locator('#sash-left').boundingBox())!;
            const x = edge.x + edge.width / 2;
            const y = frame.y + frame.height / 2;
            await p.mouse.move(x, y);
            await p.mouse.down();
            assert.equal(await pointer(), 'none', 'the frame lets the mouse through while an edge is dragged');
            await p.mouse.move(x + 300, y, { steps: 15 });
            assert.equal((await paneWidths(p, ['left']))[0], 600, 'the edge followed the mouse across the frame');
            await p.mouse.up();
            assert.equal(await pointer(), 'auto');
            await p.mouse.move(x + 350, y, { steps: 3 });
            assert.equal((await paneWidths(p, ['left']))[0], 600, 'the edge no longer moves once let go');
          }),
        ),
      ),
    ),
  );
});
