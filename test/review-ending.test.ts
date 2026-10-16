import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import type { Page, Route } from 'playwright-core';
import { startReviewServer } from '../src/review.ts';
import { withRebuiltFixture, signer, withServer, browserMissing, toList, withPage, SAVE_REFUSED, bulk, openDocumentTable, untilSet, judgedBy } from './review-helpers.ts';

test('the end request asks the caller to get ready, is answered, and then tells the caller to finish, and an end request that is not JSON is refused', async () => {
  await withRebuiltFixture({}, async (config) => {
    let done: () => void;
    const ended = new Promise<void>((resolve) => (done = resolve));
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => done });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const plain = await fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(plain.status, 415);
      const signalled = await Promise.race([ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 100))]);
      assert.equal(signalled, false);
      assert.equal((await fetch(`${base}/`)).status, 200);

      const res = await fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 200);
      assert.equal(await Promise.race([ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]), true);
    } finally {
      server.close();
    }
  });
});

test('in a browser, 「리뷰 끝」 ends the review and the page says so', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    let ends = 0;
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => { ends++; } });
    try {
      await withPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        assert.match((await p.textContent('#ended'))!, /리뷰를 끝냈습니다/);
        assert.equal(await p.locator('main, #flow, header button').count(), 0);
        assert.equal(ends, 1);
      });
    } finally {
      server.close();
    }
  });
});

test('in a browser, 「리뷰 끝」 asks before throwing away a mark that was picked but not saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    let ends = 0;
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => { ends++; } });
    try {
      await withPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', 'draft note');

        const asked = [];
        p.once('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForTimeout(200);
        assert.equal(asked.length, 1);
        assert.equal(ends, 0);
        assert.equal(await p.locator('#ended').count(), 0);
        assert.equal(await p.inputValue('#right-dock textarea'), 'draft note');

        await p.locator('table.calls td.cell').first().click();
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', 'call note');
        p.once('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForTimeout(200);
        assert.equal(asked.length, 2);
        assert.equal(ends, 0);
        assert.equal(await p.inputValue('#right-dock textarea'), 'call note');

        p.once('dialog', (d) => d.accept());
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        assert.equal(ends, 1);
      });
    } finally {
      server.close();
    }
  });
});

test('in a browser, 「리뷰 끝」 after the review already ended elsewhere says so rather than reporting a failure', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => () => server.close() });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage();
      await p.goto(base);
      await toList(p);
      await p.waitForSelector('#screen-list li');
      await fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await new Promise((resolve) => server.on('close', resolve));

      await p.click('header button:has-text("리뷰 끝")');
      await p.waitForSelector('#ended');
      assert.match((await p.textContent('#ended'))!, /이미/);
      assert.equal(await p.locator('#end-error').count(), 0);
    } finally {
      await browser.close();
      server.close();
    }
  });
});

test('in a browser, the page that was told the review ended shows the ended screen without errors when the end request was pending while the buttons were pressed', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        let held!: Route;
        await p.route('**/api/end', (route) => { held = route; });
        await p.check(`${bulk} input.pick-all`);
        await p.click('#end-review');
        await untilSet(() => held, 'the end request');
        await p.locator(`${bulk} button.hand-over`).click({ force: true });
        await held.continue();
        await p.locator('#ended').waitFor();
        assert.match((await p.textContent('#ended'))!, /리뷰를 끝냈습니다/);
        assert.deepEqual(judgedBy(config), []);
      })));
});

test('in a browser, a page that could not read its data still ends the review', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        const ended = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        await p.route('**/api/data', (route) => route.fulfill({ status: 500, body: 'data gone' }));
        await p.reload();
        await p.locator('#failed').waitFor();
        assert.match((await p.textContent('#failed'))!, /data gone/);
        await p.click('#end-review');
        await p.locator('#ended').waitFor({ timeout: 5000 });
        assert.match((await p.textContent('#ended'))!, /리뷰를 끝냈습니다/);
        assert.equal(ended.length, 1);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

type DataSettled = { dataSettled: boolean };
const watchDataSettled = (p: Page) => p.addInitScript(() => {
  const fetch = window.fetch;
  window.fetch = (...args) => {
    const sent = fetch(...args);
    if (String(args[0]).endsWith('/api/data')) {
      // 페이지가 이 응답을 받아 하는 일이 모두 끝난 뒤에 표시하도록 타이머로 미룬다.
      const settled = () => setTimeout(() => { (window as unknown as DataSettled).dataSettled = true; });
      sent.then((res) => {
        const json = res.json.bind(res);
        res.json = () => {
          const body = json();
          body.then(settled, settled);
          return body;
        };
      }, settled);
    }
    return sent;
  };
});

test('in a browser, 「리뷰 끝」 pressed before the data arrived ends the review, and when the end is refused the button is not left locked', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        const data = await (await fetch(`${base}/api/data`)).text();
        const ended = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        let held!: Route | null;
        await p.route('**/api/data', (route) => { held = route; });
        await p.route('**/api/end', (route) => route.fulfill({ status: 500, body: 'cannot end' }));
        await p.reload();
        await untilSet(() => held, 'the data request');
        await p.click('#end-review');
        await p.waitForFunction(() => /cannot end/.test(document.getElementById('end-error')!.textContent), null, { timeout: 5000 });
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        await held!.fulfill({ status: 200, contentType: 'application/json', body: data });
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        assert.equal(ended.length, 1);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);

        held = null;
        await p.unroute('**/api/end');
        await watchDataSettled(p);
        await p.reload();
        await untilSet(() => held, 'the data request');
        await p.click('#end-review');
        await p.locator('#ended').waitFor({ timeout: 5000 });
        assert.match((await p.textContent('#ended'))!, /리뷰를 끝냈습니다/);
        assert.equal(ended.length, 2);
        await held!.fulfill({ status: 200, contentType: 'application/json', body: data });
        await p.waitForFunction(() => (window as unknown as DataSettled).dataSettled);
        assert.equal(await p.locator('#ended').count(), 1);
      })));
});

test('in a browser, the data failing to arrive after the review ended leaves the ended screen without errors', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        let held!: Route;
        await p.route('**/api/data', (route) => { held = route; });
        await watchDataSettled(p);
        await p.reload();
        await untilSet(() => held, 'the data request');
        await p.click('#end-review');
        await p.locator('#ended').waitFor({ timeout: 5000 });
        await held.abort();
        await p.waitForFunction(() => (window as unknown as DataSettled).dataSettled);
        assert.match((await p.textContent('#ended'))!, /리뷰를 끝냈습니다/);
        assert.deepEqual(errors.splice(0), ['Failed to load resource: net::ERR_FAILED']);
      })));
});

test('in a browser, a refused end in the flow view leaves the diagram as it was drawn', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.setViewportSize({ width: 1440, height: 400 });
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box.screen');
        const scrollTop = await p.evaluate(() => {
          for (const box of document.querySelectorAll<HTMLElement>('#flow .box')) box.dataset.drawn = 'before';
          const flow = document.getElementById('flow')!;
          flow.scrollTop = 60;
          return flow.scrollTop;
        });
        assert.ok(scrollTop > 0);
        await p.route('**/api/end', (route) => route.fulfill({ status: 500, body: 'cannot end' }));
        await p.click('#end-review');
        await p.waitForFunction(() => /cannot end/.test(document.getElementById('end-error')!.textContent));
        assert.ok(await p.locator('#flow .box[data-drawn=before]').count() > 0);
        assert.equal(await p.locator('#flow .box:not([data-drawn=before])').count(), 0);
        assert.equal(await p.evaluate(() => document.getElementById('flow')!.scrollTop), scrollTop);
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});
