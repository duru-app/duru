import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Locator, Page } from 'playwright-core';
import { startReviewServer } from '../src/review.ts';
import { withRebuiltFixture, signer, withServer, browserMissing, withPage, screenBox, pickedBoxes, inWindow } from './review-helpers.ts';

declare function renderFlow(): void;

test('in a browser, the explanation in the flow bar is hidden on opening and an info button shows it on hover, on click and from the keyboard', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        const legend = p.locator('#flowlegend');
        assert.equal(await legend.count(), 1);
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');
        assert.equal(await info.getAttribute('aria-controls'), 'flowlegend');

        await info.hover();
        assert.equal(await legend.isVisible(), true);
        assert.match((await legend.textContent())!, /불러옴 N/);
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), false);

        await info.click();
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), true);
        assert.equal(await info.getAttribute('aria-expanded'), 'true');
        await info.click();
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');

        await info.focus();
        await p.keyboard.press('Enter');
        assert.equal(await legend.isVisible(), true);
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');
        await p.keyboard.press('Space');
        assert.equal(await legend.isVisible(), true);
        await p.keyboard.press('Space');
        assert.equal(await legend.isVisible(), false);

        await p.locator('.flowbar input.flow-search').focus();
        await p.keyboard.press('Tab');
        assert.equal(await info.evaluate((e) => e === document.activeElement), true, 'Tab reaches the info button');
        await p.keyboard.press('Enter');
        assert.equal(await legend.isVisible(), true);
        await p.locator('#flow-zoom .zoom-out').click();
        assert.equal(await legend.isVisible(), true, 'a redraw keeps the explanation open');
        await (await screenBox(p, '/lab#Lab')).click();
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false, 'Escape closes the explanation first');
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'and keeps the picked screen');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the explanation shows on hover after a keyboard close and never has a native tooltip', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        const legend = p.locator('#flowlegend');
        assert.equal(await info.getAttribute('title'), null);

        await p.mouse.move(600, 600);
        await info.focus();
        await p.keyboard.press('Enter');
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false);
        await info.hover();
        assert.equal(await legend.isVisible(), true, 'hover shows it after a keyboard close');
        assert.equal(await info.getAttribute('aria-expanded'), 'true', 'aria-expanded says what is displayed on hover');
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');

        await p.keyboard.press('Enter');
        await p.keyboard.press('Enter');
        await info.hover();
        assert.equal(await legend.isVisible(), true, 'hover shows it after closing with Enter again');

        await info.click();
        assert.equal(await legend.isVisible(), true);
        await info.click();
        assert.equal(await legend.isVisible(), false, 'closing with the pointer on it keeps it closed');
        assert.equal(await info.getAttribute('aria-expanded'), 'false');
        await p.evaluate(() => { renderFlow(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
        assert.equal(await legend.isVisible(), false, 'a redraw keeps the close while the pointer stays on it');
        await p.mouse.move(600, 600);
        await info.hover();
        assert.equal(await legend.isVisible(), true);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the explanation stays inside the window at a narrow window, also with a screen picked', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 800, height: 600 });
        await p.waitForSelector('#flow .box');
        for (const pick of [false, true]) {
          if (pick) await (await screenBox(p, '/home#Home')).click();
          await p.locator('.flowbar button.flowinfo-button').hover();
          const e = await inWindow(p, '#flowlegend');
          assert.ok(e.left >= 0, `left edge ${e.left}`);
          assert.ok(e.right <= e.width, `right edge ${e.right} within ${e.width}`);
          await p.mouse.move(400, 500);
        }
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, Escape closes the explanation only while the flow view is showing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        const legend = p.locator('#flowlegend');
        await info.click();
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), true);
        await p.click('#view-list');
        await p.keyboard.press('Escape');
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.equal(await legend.isVisible(), true, 'Escape in the list view leaves it pinned');
        assert.equal(await info.getAttribute('aria-expanded'), 'true');

        await p.evaluate(() => document.addEventListener('keydown', (e) => e.preventDefault(), { once: true, capture: true }));
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), true, 'an Escape already handled elsewhere does not close it');
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, pressing Escape after the review ended throws nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => {} });
    try {
      await withPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async (p) => {
        await p.waitForSelector('#flow .box');
        await (await screenBox(p, '/home#Home')).click();
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        await p.keyboard.press('Escape');
        await p.keyboard.press('Escape');
      }, { view: 'flow' });
    } finally {
      server.close();
    }
  });
});

test('in a browser, the legend and the info icon stand together at the right end of the bar, which spans the whole width above the drawing and the panes', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 800 });
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        assert.equal(await info.getAttribute('aria-label'), '흐름도 읽는 법');
        assert.match((await info.textContent())!.trim(), /^(i|ⓘ)$/, 'the only visible text is the icon glyph');
        for (const pick of [false, true]) {
          if (pick) await (await screenBox(p, '/home#Home')).click();
          const m = await p.evaluate(() => {
            const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
            const bar = rect('.flowbar');
            const main = rect('main');
            const icon = rect('.flowinfo-button');
            const key = [...document.querySelectorAll('.flowkey li')].map((li) => li.getBoundingClientRect());
            const sameRow = [...document.querySelectorAll('.flowbar button, .flowbar input')].map((e) => e.getBoundingClientRect()).filter((r) => r.top < icon.bottom && r.bottom > icon.top);
            return {
              bar: [bar.left, bar.right], main: [main.left, main.right], keyRight: Math.max(...key.map((r) => r.right)), iconLeft: icon.left, iconRight: icon.right,
              toBarEdge: bar.right - icon.right, iconLast: Math.max(...sameRow.map((r) => r.right)) === icon.right, zoomInBar: !!document.querySelector('.flowbar .zoom'),
              round: Math.abs(icon.width - icon.height) < 0.5 && icon.width <= 28, drawingTop: rect('#flow').top, barBottom: bar.bottom,
            };
          });
          assert.deepEqual(m.bar, m.main, 'the bar spans the whole width');
          assert.ok(m.keyRight <= m.iconLeft && m.iconLeft - m.keyRight <= 16, 'the legend sits just left of the icon');
          assert.ok(m.toBarEdge <= 20, `the icon is ${m.toBarEdge}px from the bar's right edge`);
          assert.ok(m.iconLast, 'nothing sits right of the icon');
          assert.equal(m.zoomInBar, false, 'the zoom buttons are not in the bar');
          assert.ok(m.round, 'a small round button');
          assert.ok(Math.abs(m.drawingTop - m.barBottom) <= 1, 'the drawing starts under the bar');
        }
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, scrolling the drawing sideways leaves the bar, its legend and the explanation in place and in view', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 700, height: 600 });
        await p.waitForSelector('#flow .box');
        await (await screenBox(p, '/home#Home')).click();
        const frames = () => p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const edges = () => p.evaluate(() => {
          const rel = (r: DOMRect) => ({ left: r.left, right: r.right });
          return { width: document.documentElement.clientWidth, icon: rel(document.querySelector('.flowinfo-button')!.getBoundingClientRect()), legend: rel(document.getElementById('flowlegend')!.getBoundingClientRect()), key: [...document.querySelectorAll('.flowkey li')].map((li) => rel(li.getBoundingClientRect())) };
        });
        const before = await edges();
        const scrolled = await p.evaluate(() => {
          const flow = document.getElementById('flow')!;
          flow.scrollLeft = 200;
          return flow.scrollLeft;
        });
        assert.ok(scrolled > 0, 'the drawing scrolls sideways');
        await p.locator('.flowbar button.flowinfo-button').click();
        await p.mouse.move(350, 500);
        await frames();
        const after = await edges();
        assert.deepEqual(after.icon, before.icon);
        assert.deepEqual(after.key, before.key);
        assert.equal(after.key.length, 6);
        for (const r of [after.icon, after.legend, ...after.key]) assert.ok(r.left >= 0 && r.right <= after.width, `${r.left}..${r.right} within ${after.width}`);
      }, { view: 'flow' }),
    ),
  );
});

const travelDown = async (p: Page, info: Locator, legend: Locator, column: 'left' | 'center' | 'right' = 'center') => {
  await info.hover();
  assert.equal(await legend.isVisible(), true);
  const button = (await info.boundingBox())!;
  const text = (await legend.boundingBox())!;
  const x = button.x + { left: 0.5, center: button.width / 2, right: button.width - 0.5 }[column];
  const from = button.y + button.height / 2;
  const to = text.y + 20;
  assert.ok(to > from);
  for (let y = from; y <= to; y += 1) {
    await p.mouse.move(x, y);
    assert.equal(await legend.isVisible(), true, `the explanation is gone with the pointer at x=${x}, y=${y} (icon bottom ${button.y + button.height}, explanation top ${text.y})`);
  }
  assert.equal(await p.evaluate(() => document.getElementById('flowlegend')!.matches(':hover')), true, 'the pointer is on the explanation');
};

test('in a browser, the pointer can travel from the info icon down into the explanation without it disappearing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        for (const column of ['center', 'left', 'right'] as const) await travelDown(p, p.locator('.flowbar button.flowinfo-button'), p.locator('#flowlegend'), column);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the pointer can travel from the info icon into the explanation when the bar wraps onto several lines at a 500px window with a screen picked', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 500, height: 700 });
        await p.waitForSelector('#flow .box');
        await (await screenBox(p, '/home#Home')).click();
        await p.waitForSelector('.flowbar .picking');
        const rows = await p.evaluate(() => new Set([...document.querySelectorAll('.flowbar > *')].map((e) => Math.round(e.getBoundingClientRect().top))).size);
        assert.ok(rows >= 3, `the bar wraps onto ${rows} lines`);
        const info = p.locator('.flowbar button.flowinfo-button');
        await travelDown(p, info, p.locator('#flowlegend'));
        const e = await p.evaluate(() => {
          const legend = document.getElementById('flowlegend')!.getBoundingClientRect();
          const icon = document.querySelector('.flowinfo-button')!.getBoundingClientRect();
          return { width: document.documentElement.clientWidth, left: legend.left, right: legend.right, iconRight: icon.right, iconBottom: icon.bottom, legendTop: legend.top };
        });
        assert.ok(e.left >= 0 && e.right <= e.width, `legend ${e.left}..${e.right} within ${e.width}`);
        assert.ok(e.iconRight <= e.width, 'the icon is in view');
        assert.ok(e.legendTop >= e.iconBottom, 'the explanation opens under the icon');
      }, { view: 'flow' }),
    ),
  );
});

const KEY_LABELS = ['통과', '실패', '보류', '테스트 없음', '조건 걸린 링크', '설정에 적은 이동'];

test('in a browser, the flow bar always shows a legend of six samples next to the info icon', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 800 });
        await p.waitForSelector('#flow .box');
        const key = p.locator('.flowbar ul.flowkey');
        assert.equal(await key.isVisible(), true);
        assert.equal(await key.getAttribute('aria-label'), '흐름도 범례');
        assert.deepEqual(await key.locator('li .key-label').allTextContents(), KEY_LABELS);
        assert.equal(await key.locator('li [aria-hidden="true"]').count(), 6, 'every drawn sample is hidden from a screen reader');
        assert.deepEqual(await key.locator('li').evaluateAll((items) => items.map((li) => li.textContent.trim())), KEY_LABELS);
        const m = await p.evaluate(() => {
          const rect = (e: Element) => e.getBoundingClientRect();
          const items = [...document.querySelectorAll('.flowkey li')].map(rect);
          const icon = rect(document.querySelector('.flowinfo-button')!);
          return { right: Math.max(...items.map((r) => r.right)), tops: new Set(items.map((r) => Math.round(r.top + r.height / 2))).size, iconLeft: icon.left, legendShown: getComputedStyle(document.getElementById('flowlegend')!).display };
        });
        assert.ok(m.right <= m.iconLeft, `the legend ends at ${m.right}, left of the icon at ${m.iconLeft}`);
        assert.ok(m.iconLeft - m.right <= 16, 'the legend sits next to the icon');
        assert.equal(m.tops, 1, 'the six samples are on one line at 1440px');
        assert.equal(m.legendShown, 'none', 'the samples show without opening the explanation');
        const before = await p.evaluate(() => document.querySelector('.canvas')!.getBoundingClientRect().top);
        await p.locator('.flowbar button.flowinfo-button').click();
        assert.equal(await p.evaluate(() => document.querySelector('.canvas')!.getBoundingClientRect().top), before, 'opening the explanation does not move the diagram');
        assert.deepEqual(await key.locator('li .key-label').allTextContents(), KEY_LABELS);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, each legend sample is drawn with the square of the screens and the dash of the guarded links and of the moves it stands for', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const { pairs, dashes } = await p.evaluate(() => {
          const look = (e: Element) => { const c = getComputedStyle(e); return [c.backgroundColor, c.borderTopStyle, c.borderTopStyle === 'none' ? '' : c.borderTopColor, c.borderTopWidth, c.width].join(' '); };
          const out: Record<string, string[]> = {};
          for (const cls of ['s-pass', 's-fail', 's-pending', 's-none']) {
            const box = document.querySelector(`#flow .box.screen.${cls} .sq`);
            if (box) out[cls] = [look(document.querySelector(`.flowkey .sq.${cls}`)!), look(box)];
          }
          const canvas = document.querySelector('.canvas')!;
          const stroke = (e: Element) => { const c = getComputedStyle(e); return [c.stroke, c.strokeDasharray, c.strokeWidth].join(' '); };
          const dashes = [];
          for (const cls of ['guarded', 'moved']) {
            const edge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            edge.setAttribute('class', cls);
            canvas.querySelector('svg')!.append(edge);
            const sample = document.querySelector(`.flowkey svg path.${cls}`)!;
            out[cls] = [stroke(sample), stroke(edge)];
            dashes.push(...[sample, edge].map((e) => getComputedStyle(e).strokeDasharray));
            edge.remove();
          }
          return { pairs: out, dashes };
        });
        assert.deepEqual(Object.keys(pairs).sort(), ['guarded', 'moved', 's-fail', 's-none', 's-pass', 's-pending']);
        assert.notEqual(pairs.guarded[0], pairs.moved[0], 'a move is drawn apart from a guarded link');
        for (const [name, [sample, real]] of Object.entries(pairs)) assert.equal(sample, real, name);
        assert.equal(new Set(['s-pass', 's-fail', 's-pending', 's-none'].map((c) => pairs[c][0])).size, 4, 'the four samples differ');
        for (const dash of dashes) assert.match(dash, /^\d+(\.\d+)?(px)?,? \d+(\.\d+)?(px)?$/, `a dash of two lengths, not ${dash}`);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the explanation behind the info icon shows each tag a screen can carry, the mark of a screen reached from another branch and the untagged tests, each under its sample', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 800 });
        await p.waitForSelector('#flow .box');
        await p.locator('.flowbar button.flowinfo-button').click();
        const legend = p.locator('#flowlegend');
        assert.equal(await legend.evaluate((e) => e.tagName), 'UL');
        assert.deepEqual(await legend.locator('li').evaluateAll((items) => items.map((li) => [...li.children].map((c) => c.textContent))), [
          ['/주소API 8', '이 화면에서 부르는 API 호출의 수. 화면을 누르면 오른쪽에 호출마다 테스트가 보입니다'],
          ['/주소역할/주소설정', '특정 역할이나 설정에서만 열리는 화면. 무엇이 필요한지는 마우스를 올리면 보입니다'],
          ['/주소', '고른 화면에서 다른 가지에 이미 그린 화면으로 가는 링크나 설정에 적은 이동이 닿는 화면'],
          ['불러옴 N · 지나감 N', '태그 없이 이 화면을 불러오는 단위 테스트와, 도는 동안 이 화면을 연 브라우저 테스트. 마우스를 올리면 보입니다상태 색과 테스트 수에는 넣지 않음'],
        ]);
        const look = (sel: string) => p.$eval(sel, (e) => { const c = getComputedStyle(e); return [c.borderTopStyle, c.borderTopColor, c.color, c.fontSize].join(' '); });
        assert.equal(await look('#flowlegend .tag.api'), await look('#flow .box.screen .tag.api'));
        assert.equal(await look('#flowlegend .tag.need'), await look('#flow .box.screen .tag.need'));
        assert.equal(await legend.locator('.box.jump').count(), 1);
        const box = await p.evaluate(() => {
          const e = document.getElementById('flowlegend')!;
          const r = e.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, window: document.documentElement.clientWidth, overflowing: [...e.querySelectorAll('li')].filter((li) => li.scrollWidth > li.clientWidth).length };
        });
        assert.ok(box.width <= 320, `the explanation is ${box.width}px wide`);
        assert.ok(box.left >= 0 && box.right <= box.window, `explanation ${box.left}..${box.right} within ${box.window}`);
        assert.equal(box.overflowing, 0, 'nothing in the explanation is cut off');
        const rows = await legend.locator('li').evaluateAll((items) => items.map((li) => {
          const [sample, text] = [...li.children].map((c) => c.getBoundingClientRect());
          return { below: text.top >= sample.bottom - 1, text: Math.round(text.width), row: Math.round(li.getBoundingClientRect().width) };
        }));
        for (const r of rows) {
          assert.ok(r.below, 'the description sits under its sample');
          assert.equal(r.text, r.row, 'the description takes the whole width, however long the sample is');
        }
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, at a 500px window the bar with its legend stays within the window, no legend label is split inside a word and the explanation is in view', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 500, height: 700 });
        await p.waitForSelector('#flow .box');
        await p.locator('.flowbar button.flowinfo-button').click();
        const m = await p.evaluate(() => {
          const bar = document.querySelector('.flowbar')!;
          const rel = (e: Element) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
          return {
            width: document.documentElement.clientWidth, barScroll: bar.scrollWidth, barClient: bar.clientWidth,
            labels: [...document.querySelectorAll('.flowkey .key-label')].map((e) => [e.textContent, e.getClientRects().length]),
            items: [...document.querySelectorAll('.flowkey li, .flowbar button, .flowbar input')].map(rel), legend: rel(document.getElementById('flowlegend')!),
          };
        });
        assert.ok(m.barScroll <= m.barClient, `the bar's content is ${m.barScroll}px wide in a ${m.barClient}px bar`);
        assert.deepEqual(m.labels.map(([label]) => label), KEY_LABELS);
        for (const [label, rects] of m.labels) assert.equal(rects, 1, `「${label}」 is on one line`);
        for (const r of [...m.items, m.legend]) assert.ok(r.left >= 0 && r.right <= m.width, `${r.left}..${r.right} within ${m.width}`);
      }, { view: 'flow' }),
    ),
  );
});
