import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from 'playwright-core';
import { CLI, withRebuiltFixture, withServer, PASSWORD_ENV, ADMIN_PASSWORD_ENV, AUDITOR_PASSWORD_ENV, withFakeApi, appSettings, SETTINGS_FILE, LIST_API, API_KEY_ENV, API_KEY, ISSUING_API, VIEW_TOKEN_API, VIEW_ROUTE, loginWithHeader, roleSettings, withPasswords, withPassword, ALL_PASSWORDS, pathValueSettings, browserMissing, withPage, screenBox, settingRow, untilSet } from './review-helpers.ts';

test('in a browser, the chosen screen shows the logged-in app in a frame above its tests, with the address, the account and a new-window link, and a press inside reaches the test server', { skip: browserMissing }, async () => {
  await withFakeApi((api, presses) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin', '/login'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/home")');
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            assert.match((await bar.textContent())!, new RegExp(`${app.url}/home`));
            assert.match((await bar.textContent())!, /duru-admin/);
            assert.match((await bar.textContent())!, /맵에 없는 signedOutPaths: \/login/);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'), `${app.url}/home`);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('target'), '_blank');

            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            assert.equal(await frame.locator('#path').textContent(), '/home');
            await frame.locator('#press').click();
            await frame.locator('#pressed:has-text("pressed")').waitFor();
            assert.equal(presses.length, 1);

            await p.click('#center tr:has-text("API")');
            await p.click('#right .statuses button:has-text("없음")');
            await p.click('#right button.save');
            await p.waitForSelector('#center tr.selected .chip.missing');
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');

            const frameBox = (await p.locator('#center iframe.app').boundingBox())!;
            const tableBox = (await p.locator('#center table').first().boundingBox())!;
            assert.ok(tableBox.y > frameBox.y + frameBox.height - 1);
            assert.ok(await p.locator('#right').isVisible());

            await p.click('#screen-list li:has-text("/signin")');
            assert.match((await bar.textContent())!, /로그아웃 상태/);
            assert.doesNotMatch((await bar.textContent())!, /duru-admin/);
            await p.frameLocator('#center iframe.app').locator('#path:has-text("/signin")').waitFor();
            const signedOutFrame = p.frameLocator('#center iframe.app');
            assert.equal(await signedOutFrame.locator('#who').textContent(), '로그인 전');
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'),
              `${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent('/signin')}`);

            const appFrameHandle = p.frames().find((f) => f.url().startsWith(`${app.signedOutUrl}/signin`))!;
            await appFrameHandle.evaluate(() => {
              localStorage.setItem('FAKE_AUTH', JSON.stringify({ accessToken: 't-123' }));
              location.reload();
            });
            await signedOutFrame.locator('#who:has-text("두루 관리자")').waitFor();
          }),
        ),
      ),
    ),
  );
});

const twoFrames = (p: Page) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const pageOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollHeight - innerHeight);

async function shownApp(p: Page) {
  await twoFrames(p);
  const [width, height] = await p.frameLocator('#center iframe.app').locator('body').evaluate(() => [innerWidth, innerHeight]);
  const box = (await p.locator('#center iframe.app').boundingBox())!;
  const room = await p.locator('#center .app-stage').evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + e.clientLeft, y: r.y + e.clientTop, width: e.clientWidth, height: e.clientHeight, right: r.right, bottom: r.bottom };
  });
  const scaleText = await p.locator('#center .frame-bar .app-scale').textContent();
  return { width, height, box, room, scaleText, scale: box.width / width };
}

function assertFits(shown: Awaited<ReturnType<typeof shownApp>>) {
  const { box, room } = shown;
  assert.ok(box.x >= room.x - 0.5 && box.x + box.width <= room.x + room.width + 0.5, `app ${box.x}+${box.width} inside ${room.x}+${room.width}`);
  assert.ok(Math.abs(box.y - room.y) < 0.5 && Math.abs(box.height - room.height) < 1, `app ${box.y}+${box.height} fills ${room.y}+${room.height}`);
  assert.ok(Math.abs(shown.height - room.height / shown.scale) < 1.5, `app height ${shown.height} is ${room.height} / ${shown.scale}`);
}

function assertShrunk(shown: Awaited<ReturnType<typeof shownApp>>, width: number) {
  const percent = Math.floor((shown.room.width / width) * 100);
  assert.ok(percent < 100);
  assert.equal(shown.width, width);
  assert.equal(shown.scaleText, `${width}px 화면을 ${percent}%로 줄여서 보여 줍니다`);
  assert.ok(Math.abs(shown.box.width - (width * percent) / 100) < 0.5, `${shown.box.width} is ${width} at ${percent}%`);
  assertFits(shown);
  return percent;
}

test('in a browser, a screen picked in the flow view draws the app 1280 wide shrunk to fit the pane, a chosen width changes only the scale without reloading, and the scale follows the window', { skip: browserMissing }, async () => {
  await withFakeApi((api, presses) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.setViewportSize({ width: 1920, height: 1080 });
            await (await screenBox(p, '/home#Home')).click();
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            const width = p.locator('#center .frame-bar select.app-width');
            assert.deepEqual(await width.locator('option').allTextContents(), ['칸에 맞춤', '375', '768', '1024', '1280', '1440', '직접 입력']);
            assert.equal(await width.inputValue(), '1280');
            let shown = await shownApp(p);
            const at1920 = assertShrunk(shown, 1280);
            assert.equal(await pageOverflow(p), 0, 'the page itself does not scroll');

            await frame.locator('#press').click();
            await frame.locator('#pressed:has-text("pressed")').waitFor();
            assert.equal(presses.length, 1);
            await frame.locator('body').evaluate(() => {
              const field = document.createElement('input');
              field.id = 'typed';
              field.style.cssText = 'position: fixed; left: 1180px; top: 200px; width: 90px; height: 24px';
              document.body.append(field);
            });
            await p.mouse.click(shown.box.x + 1220 * shown.scale, shown.box.y + 212 * shown.scale);
            await p.keyboard.type('오른쪽 끝');
            assert.equal(await frame.locator('#typed').inputValue(), '오른쪽 끝');

            await width.selectOption({ label: '1024' });
            assertShrunk(await shownApp(p), 1024);
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');
            assert.equal(await frame.locator('#typed').inputValue(), '오른쪽 끝');

            await width.selectOption({ label: '칸에 맞춤' });
            shown = await shownApp(p);
            assert.equal(shown.width, shown.room.width);
            assert.equal(shown.scaleText, `칸 너비 그대로 ${shown.room.width}px`);
            assertFits(shown);
            assert.ok(await p.locator('#center .frame-bar select.app-percent').isDisabled());
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');

            await width.selectOption({ label: '1280' });
            await p.setViewportSize({ width: 2600, height: 1080 });
            shown = await shownApp(p);
            assert.ok(assertShrunk(shown, 1280) > at1920);
            await width.selectOption({ label: '1024' });
            shown = await shownApp(p);
            assert.equal(shown.width, 1024);
            assert.equal(shown.scaleText, '1024px 화면을 실제 크기로 보여 줍니다');
            assert.equal(shown.box.width, 1024);
            assertFits(shown);

            await p.setViewportSize({ width: 1920, height: 1080 });
            shown = await shownApp(p);
            assertShrunk(shown, 1024);
            const before = shown.room.height;
            await p.mouse.move(shown.room.right - 4, shown.room.bottom - 4);
            await p.mouse.down();
            await p.mouse.move(shown.room.right - 4, shown.room.bottom + 116, { steps: 5 });
            await p.mouse.up();
            shown = await shownApp(p);
            assert.ok(Math.abs(shown.room.height - before - 120) < 2, `stage grew from ${before} to ${shown.room.height}`);
            assertShrunk(shown, 1024);
            assert.equal(await pageOverflow(p), 0);
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');
          }, { view: 'flow' }),
        ),
      ),
    ),
  );
});

test('in a browser, the list view shrinks the app the same way, and the chosen width stays across screens and views until the page reloads', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/home")');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            assertShrunk(await shownApp(p), 1280);
            assert.equal(await pageOverflow(p), 0, 'the page itself does not scroll');

            await p.selectOption('#center .frame-bar select.app-width', { label: '1440' });
            await p.click('#screen-list li:has-text("/signin")');
            await frame.locator('#path:has-text("/signin")').waitFor();
            assert.equal(await p.locator('#center .frame-bar select.app-width').inputValue(), '1440');
            assertShrunk(await shownApp(p), 1440);

            await p.click('#view-flow');
            await (await screenBox(p, '/home#Home')).click();
            await frame.locator('#path:has-text("/home")').waitFor();
            assertShrunk(await shownApp(p), 1440);

            await p.reload();
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await p.locator('#center .frame-bar select.app-width').inputValue(), '1280');
            assertShrunk(await shownApp(p), 1280);
          }),
        ),
      ),
    ),
  );
});

function assertScaled(shown: Awaited<ReturnType<typeof shownApp>>, width: number, percent: number) {
  assert.equal(shown.width, width);
  assert.ok(Math.abs(shown.box.width - (width * percent) / 100) < 0.5, `${shown.box.width} is ${width} at ${percent}%`);
  assert.ok(Math.abs(shown.box.y - shown.room.y) < 0.5 && Math.abs(shown.box.height - shown.room.height) < 1, `app ${shown.box.y}+${shown.box.height} fills ${shown.room.y}+${shown.room.height}`);
  assert.ok(Math.abs(shown.height - shown.room.height / shown.scale) < 1.5, `app height ${shown.height} is ${shown.room.height} / ${shown.scale}`);
}

test('in a browser, a typed app width and a picked scale draw the app at that size, an app wider than the pane scrolls sideways inside it, and the scale cannot be picked while the width fits the pane', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.setViewportSize({ width: 1920, height: 1080 });
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/home")');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            const stage = p.locator('#center .app-stage');
            const width = p.locator('#center .frame-bar select.app-width');
            const typedWidth = p.locator('#center .frame-bar input.app-width-typed');
            const percent = p.locator('#center .frame-bar select.app-percent');
            const typedPercent = p.locator('#center .frame-bar input.app-percent-typed');
            const sideways = () => stage.evaluate((e) => ({ wide: e.classList.contains('wide'), overflow: e.scrollWidth - e.clientWidth }));
            const pageSideways = () => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
            assert.deepEqual(await percent.locator('option').allTextContents(), ['칸에 맞춤', '25%', '50%', '75%', '100%', '150%', '직접 입력']);
            assert.equal(await percent.inputValue(), '0');
            assert.ok(await percent.isEnabled());
            assert.ok(await typedWidth.isHidden());

            await width.selectOption({ label: '직접 입력' });
            assert.ok(await typedWidth.isVisible());
            assert.equal(await typedWidth.inputValue(), '1280');
            await typedWidth.fill('2000');
            await typedWidth.press('Enter');
            let shown = await shownApp(p);
            const fit = assertShrunk(shown, 2000);
            assert.deepEqual(await sideways(), { wide: false, overflow: 0 });
            await typedWidth.fill('50');
            await typedWidth.press('Enter');
            assert.equal(await typedWidth.inputValue(), '2000');
            assertShrunk(await shownApp(p), 2000);

            await percent.selectOption({ label: '25%' });
            shown = await shownApp(p);
            assertScaled(shown, 2000, 25);
            assertFits(shown);
            assert.equal(shown.scaleText, '2000px 화면을 25%로 줄여서 보여 줍니다');
            assert.deepEqual(await sideways(), { wide: false, overflow: 0 });

            await percent.selectOption({ label: '100%' });
            shown = await shownApp(p);
            assertScaled(shown, 2000, 100);
            assert.equal(shown.scaleText, '2000px 화면을 실제 크기로 보여 줍니다 · 칸을 넘는 부분은 옆으로 넘겨 봅니다');
            const over = await sideways();
            assert.equal(over.wide, true);
            assert.ok(Math.abs(over.overflow - (2000 - shown.room.width)) <= 1, `scrolls ${over.overflow} past a ${shown.room.width}px pane`);
            await stage.evaluate((e) => { e.scrollLeft = e.scrollWidth; });
            const scrolled = await shownApp(p);
            assert.ok(Math.abs(scrolled.box.x + scrolled.box.width - (scrolled.room.x + scrolled.room.width)) < 1, 'scrolled to the right edge of the app');
            assert.equal(await pageOverflow(p), 0, 'the page itself does not scroll');
            assert.equal(await pageSideways(), 0, 'the page itself does not scroll sideways');

            await percent.selectOption({ label: '150%' });
            shown = await shownApp(p);
            assertScaled(shown, 2000, 150);
            assert.equal(shown.scaleText, '2000px 화면을 150%로 키워서 보여 줍니다 · 칸을 넘는 부분은 옆으로 넘겨 봅니다');
            assert.equal((await sideways()).wide, true);
            assert.equal(await pageSideways(), 0);

            await percent.selectOption({ label: '직접 입력' });
            assert.equal(await typedPercent.inputValue(), '150');
            await typedPercent.fill('20');
            await typedPercent.press('Enter');
            shown = await shownApp(p);
            assertScaled(shown, 2000, 20);
            assertFits(shown);
            assert.equal(shown.scaleText, '2000px 화면을 20%로 줄여서 보여 줍니다');

            await p.click('#screen-list li:has-text("/signin")');
            await frame.locator('#path:has-text("/signin")').waitFor();
            assert.equal(await width.inputValue(), 'typed');
            assert.equal(await typedWidth.inputValue(), '2000');
            assert.equal(await percent.inputValue(), 'typed');
            assert.equal(await typedPercent.inputValue(), '20');
            assertScaled(await shownApp(p), 2000, 20);

            await width.selectOption({ label: '칸에 맞춤' });
            shown = await shownApp(p);
            assert.equal(shown.width, shown.room.width);
            assert.equal(shown.scaleText, `칸 너비 그대로 ${shown.room.width}px`);
            assertFits(shown);
            assert.ok(await percent.isDisabled());
            assert.ok(await typedPercent.isDisabled());
            assert.deepEqual(await sideways(), { wide: false, overflow: 0 });

            await width.selectOption({ label: '768' });
            assert.ok(await percent.isEnabled());
            assertScaled(await shownApp(p), 768, 20);
            await percent.selectOption({ label: '칸에 맞춤' });
            assert.ok(await typedPercent.isHidden());
            await width.selectOption({ label: '1280' });
            assert.ok(assertShrunk(await shownApp(p), 1280) > fit);

            await p.reload();
            await frame.locator('#path:has-text("/signin")').waitFor();
            assert.equal(await width.inputValue(), '1280');
            assert.equal(await percent.inputValue(), '0');
            assert.ok(await typedWidth.isHidden());
            assert.ok(await typedPercent.isHidden());
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen with path variables opens filled with its fixed value or the first value of its list API, and an edited value reopens it', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: 'draft' }, '/document/:id': { id: LIST_API } };
  await withFakeApi((api, presses, logins, listCalls) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...pathValueSettings(api, pathValues).app, signedOutPaths: ['/document/:tab(draft|done)'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            const newWindow = () => bar.locator('a:has-text("새 창")').getAttribute('href');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/document/:tab")');
            await frame.locator('#path:has-text("/document/draft")').waitFor();
            assert.equal(await frame.locator('#who').textContent(), '로그인 전');
            assert.equal(await bar.locator('.mono').textContent(), `${app.signedOutUrl}/document/draft`);
            assert.match((await bar.textContent())!, /로그아웃 상태/);
            assert.equal(await newWindow(), `${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent('/document/draft')}`);
            assert.equal(await bar.locator('input[name=tab]').inputValue(), 'draft');

            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            assert.equal(await bar.locator('input[name=id]').inputValue(), '17');
            assert.equal(await newWindow(), `${app.url}/document/17`);
            assert.doesNotMatch((await bar.textContent())!, /목록에서 골라/);
            assert.deepEqual(listCalls, ['GET /api/v1/documents']);

            await bar.locator('input[name=id]').fill('42');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/42")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${app.url}/document/42`);
            assert.equal(await newWindow(), `${app.url}/document/42`);

            await frame.locator('#press').click();
            await frame.locator('#pressed:has-text("pressed")').waitFor();
            await p.click('#center tr:has-text("API")');
            await p.click('#right .statuses button:has-text("없음")');
            await p.click('#right button.save');
            await p.waitForSelector('#center tr.selected .chip.missing');
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');

            await bar.locator('input[name=id]').fill('43');
            await p.click('#screen-list li:has-text("/home")');
            await frame.locator('#path:has-text("/home")').waitFor();
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/42")').waitFor();
            assert.equal(await bar.locator('input[name=id]').inputValue(), '43');
            await bar.locator('button:has-text("다시 띄우기")').click();
            await frame.locator('#path:has-text("/document/43")').waitFor();
            assert.deepEqual(listCalls, ['GET /api/v1/documents']);
            assert.equal(presses.length, 1);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen with path variables picked in the flow opens filled with the value its list API gives, in the same middle pane as the list', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:id': { id: LIST_API } };
  await withFakeApi((api, _presses, _logins, listCalls) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, pathValues), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#flow .box.screen');
            await (await screenBox(p, '/document/:id#DocumentDetail')).click();
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            assert.equal(await p.locator('#center .frame-bar input[name=id]').inputValue(), '17');
            assert.deepEqual(listCalls, ['GET /api/v1/documents']);
          }, { view: 'flow' }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen without its values opens its list screen with a notice, and a failing list API is shown before the same fallback', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: { ...LIST_API, api: '/api/v1/documents/broken' } }, '/docs/:id': { id: '1' } };
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, pathValues), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${app.url}/home`);
            assert.match((await bar.textContent())!, /목록에서 골라 들어가세요/);
            assert.match((await bar.textContent())!, /맵에 없는 pathValues: \/docs\/:id/);
            assert.equal(await bar.locator('.path-values .error').count(), 0);
            assert.equal(await bar.locator('input[name=id]').inputValue(), '');

            await bar.locator('input[name=id]').fill('42');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/42")').waitFor();
            assert.doesNotMatch((await bar.textContent())!, /목록에서 골라/);

            await p.click('#screen-list li:has-text("/document/:tab")');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.match((await bar.textContent())!, /목록에서 골라 들어가세요/);
            assert.match((await bar.locator('.path-values .error').textContent())!, /^tab: 목록 API GET \/api\/v1\/documents\/broken 요청이 500 로 실패했습니다$/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen without its values falls back to a list screen opened with its fixed values', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, { '/document/:tab(draft|done)': { tab: 'draft' } }), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await p.frameLocator('#center iframe.app').locator('#path:has-text("/document/draft")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${app.url}/document/draft`);
            assert.match((await bar.textContent())!, /목록에서 골라 들어가세요/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen without its values falls back to a linking list screen the frame account can open before one that needs another role', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, pathValues: {} } }, async (config, copy) => {
        const member = path.join(copy, 'client/src/components/AdminMember.js');
        fs.writeFileSync(member, fs.readFileSync(member, 'utf8').replace('Audit log</Link>', 'Audit log</Link>\n      <Link to={`${Option.ROUTE_PATH.DOCUMENT}/7`}>Document</Link>'));
        execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await bar.locator('text=목록에서 골라 들어가세요').waitFor();
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.url}/home`);
            await frameWho(p, '두루 관리자');
          }),
        );
      }),
    ),
  );
});

test('in a browser, a value the reviewer clears does not fall back to a list screen, and the frame says the value is missing', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, { '/document/:id': { id: '42' } }), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/42")').waitFor();

            await bar.locator('input[name=id]').fill('');
            await bar.locator('input[name=id]').press('Enter');
            await p.locator('#center .frame-note:has-text("id 값이 없어 이 화면을 띄울 수 없습니다")').waitFor();
            assert.equal(await p.locator('#center iframe.app').count(), 0);
            assert.doesNotMatch((await bar.textContent())!, /목록에서 골라/);

            await bar.locator('input[name=id]').fill('43');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/43")').waitFor();
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen with a list API opens with the value the list gives to the account the frame logs in as', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:id': { id: LIST_API } };
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            await p.selectOption('#center select.role', 'role:ADMIN');
            await frame.locator('#path:has-text("/document/27")').waitFor();
            assert.equal(await p.locator('#center .frame-bar input[name=id]').inputValue(), '27');
            await p.selectOption('#center select.role', 'auto');
            await frame.locator('#path:has-text("/document/17")').waitFor();
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a list API that failed is called again when its screen is chosen again', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: { ...LIST_API, api: '/api/v1/documents/flaky' } } };
  await withFakeApi((api, presses, logins, listCalls) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, pathValues), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:tab")');
            await bar.locator('.path-values .error:has-text("503")').waitFor();
            await p.click('#screen-list li:has-text("/home")');
            await p.click('#screen-list li:has-text("/document/:tab")');
            await frame.locator('#path:has-text("/document/done")').waitFor();
            assert.equal(await bar.locator('.path-values .error').count(), 0);
            assert.equal(listCalls.filter((c) => c.endsWith('/flaky')).length, 2);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen with an issuing API gets a new value each time it is opened, and leaving a mark asks for none', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:id': { id: ISSUING_API } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ ...ALL_PASSWORDS, [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, settingsFile: SETTINGS_FILE, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p, errors) => {
            const issued = () => requests.filter((r) => r === 'POST /api/v2/one-time-code/create').length;
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/c-1")').waitFor();
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            assert.equal(await bar.locator('input[name=id]').inputValue(), 'c-1');

            await frame.locator('#press').click();
            await frame.locator('#pressed:has-text("pressed")').waitFor();
            await p.click('#center tr:has-text("API")');
            await p.click('#right .statuses button:has-text("없음")');
            await p.click('#right button.save');
            await p.waitForSelector('#center tr.selected .chip.missing');
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');
            assert.equal(issued(), 1);

            await p.click('#screen-list li:has-text("/home")');
            await frame.locator('#path:has-text("/home")').waitFor();
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/c-2")').waitFor();
            assert.equal(await bar.locator('input[name=id]').inputValue(), 'c-2');
            assert.equal(issued(), 2);

            await p.selectOption('#center select.role', 'role:ADMIN');
            await frame.locator('#path:has-text("/document/c-3")').waitFor();
            await p.selectOption('#center select.role', 'auto');
            await frame.locator('#path:has-text("/document/c-4")').waitFor();
            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            await lab.locator('button:has-text("끄기")').click();
            await p.waitForFunction(() => document.querySelector('#center iframe.app')?.getAttribute('src')?.endsWith('/document/c-5'));
            await lab.locator('button:has-text("켜기")').click();
            await frame.locator('#path:has-text("/document/c-6")').waitFor();
            await p.route('**/api/settings', (r) => r.fulfill({ status: 400, body: 'refused' }));
            await lab.locator('button:has-text("끄기")').click();
            await p.locator('#settings-bar .error:has-text("refused")').waitFor();
            await p.unroute('**/api/settings');
            assert.deepEqual(errors.splice(0), ['Failed to load resource: the server responded with a status of 400 (Bad Request)']);
            assert.equal(await frame.locator('#path').textContent(), '/document/c-6');
            assert.equal(issued(), 6);

            await bar.locator('input[name=id]').fill('typed');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/typed")').waitFor();
            assert.equal(issued(), 6);
            assert.ok(!(await p.content()).includes(API_KEY));
          }),
        ), [['client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />',
        '{globalSettings.SYSTEM.LAB_ENABLED ? <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact /> : null}']]),
    ),
  );
});

test('in a browser, 「새 창으로 열기」 and 「다시 띄우기」 ask for a new issued value unless the reviewer typed over it, keep the other typed values, and show a failure without reloading', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:id/:code': { id: '42', code: ISSUING_API } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ [PASSWORD_ENV]: 's3cret', [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p, errors) => {
            const issued = () => requests.filter((r) => r === 'POST /api/v2/one-time-code/create').length;
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            const newTab = async () => {
              const [tab] = await Promise.all([p.context().waitForEvent('page'), bar.locator('a:has-text("새 창")').click()]);
              return tab;
            };
            const reopen = async (name: string, value: string) => {
              await bar.locator(`input[name=${name}]`).fill(value);
              await bar.locator('button:has-text("다시 띄우기")').click();
            };
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id/:code")');
            await frame.locator('#path:has-text("/document/42/c-1")').waitFor();
            const { app } = await (await fetch(`${base}/api/data`)).json();

            const tab = await newTab();
            await tab.waitForURL(`${app.url}/document/42/c-2`);
            await tab.locator('#path:has-text("/document/42/c-2")').waitFor();
            await tab.close();
            assert.equal(await frame.locator('#path').textContent(), '/document/42/c-1');
            assert.equal(issued(), 2);

            await reopen('id', '43');
            await frame.locator('#path:has-text("/document/43/c-3")').waitFor();
            assert.equal(await bar.locator('input[name=code]').inputValue(), 'c-3');
            assert.equal(issued(), 3);

            await p.route('**/api/path-values', (r) => r.fulfill({ status: 500, body: 'down' }));
            await reopen('id', '44');
            await bar.locator('.path-values .error:has-text("down")').waitFor();
            const failed = await newTab();
            if (!failed.isClosed()) await failed.waitForEvent('close');
            await p.unroute('**/api/path-values');
            assert.equal(await frame.locator('#path').textContent(), '/document/43/c-3');
            assert.equal(issued(), 3);
            assert.deepEqual(errors.splice(0), Array(2).fill('Failed to load resource: the server responded with a status of 500 (Internal Server Error)'));

            await reopen('code', 'mine');
            await frame.locator('#path:has-text("/document/44/mine")').waitFor();
            const typed = await newTab();
            await typed.waitForURL(`${app.url}/document/44/mine`);
            await typed.close();
            assert.equal(issued(), 3);

            let held!: Route;
            await p.route('**/api/path-values', (r) => { held = r; });
            await bar.locator('input[name=code]').fill('c-3');
            await reopen('id', '45');
            await untilSet(() => held, 'the path-values request');
            await p.click('#screen-list li:has-text("/home")');
            await frame.locator('#path:has-text("/home")').waitFor();
            await held.continue();
            await untilSet(() => issued() === 4, 'the new code');
            await p.waitForTimeout(300);
            assert.equal(await p.textContent('#center h3'), '/home');
            assert.equal(await frame.locator('#path').textContent(), '/home');
          }),
        ), [['client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />',
        '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id/:code`} component={waitFor(DocumentDetail)} exact />']]),
    ),
  );
});

test('in a browser, a screen whose address needs an issued query token opens with it, and a typed document id gets the token issued for that id', { skip: browserMissing }, async () => {
  const pathValues = { '/view/:documentId': { documentId: '01a1', '?token': VIEW_TOKEN_API } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ [PASSWORD_ENV]: 's3cret', [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const issued = () => requests.filter((r) => r === 'POST /api/v1/view-token/create').length;
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            const field = (name: string) => bar.locator(`input[name="${name}"]`);
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/view/:documentId")');
            await frame.locator('#path:has-text("/view/01a1?token=t-01a1-1")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${(await (await fetch(`${base}/api/data`)).json()).app.url}/view/01a1?token=t-01a1-1`);
            assert.deepEqual([await field('documentId').inputValue(), await field('?token').inputValue()], ['01a1', 't-01a1-1']);
            assert.equal(await bar.locator('label:has(input[name="?token"])').textContent(), '?token ');
            const { app } = await (await fetch(`${base}/api/data`)).json();

            const tab = await Promise.all([p.context().waitForEvent('page'), bar.locator('a:has-text("새 창")').click()]).then(([t]) => t);
            await tab.waitForURL(`${app.url}/view/01a1?token=t-01a1-2`);
            await tab.close();
            assert.equal(issued(), 2);

            await field('documentId').fill('typed7');
            await bar.locator('button:has-text("다시 띄우기")').click();
            await frame.locator('#path:has-text("/view/typed7?token=t-typed7-3")').waitFor();
            assert.equal(await field('?token').inputValue(), 't-typed7-3');
            assert.equal(issued(), 3);

            await field('?token').fill('mine');
            await field('?token').press('Enter');
            await frame.locator('#path:has-text("/view/typed7?token=mine")').waitFor();
            assert.equal(issued(), 3);
            const typedTab = await Promise.all([p.context().waitForEvent('page'), bar.locator('a:has-text("새 창")').click()]).then(([t]) => t);
            await typedTab.waitForURL(`${app.url}/view/typed7?token=mine`);
            await typedTab.close();
            assert.equal(issued(), 3);
            assert.ok(!(await p.content()).includes(API_KEY));
          }),
        ), [VIEW_ROUTE, ['build/app.js', "textContent = location.pathname;", 'textContent = location.pathname + location.search;']]),
    ),
  );
});


test('in a browser, a token that could not be asked for at first is issued once the reviewer types the document id, and the line saying it was not asked for goes away', { skip: browserMissing }, async () => {
  const pathValues = { '/view/:documentId': { '?token': VIEW_TOKEN_API } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ [PASSWORD_ENV]: 's3cret', [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/view/:documentId")');
            await bar.locator('.error:has-text("?token: documentId 값이 없어 발급 API POST /api/v1/view-token/create 를 부르지 않았습니다")').waitFor();
            assert.equal(requests.filter((r) => r === 'POST /api/v1/view-token/create').length, 0);

            await bar.locator('input[name="documentId"]').fill('typed7');
            await bar.locator('button:has-text("다시 띄우기")').click();
            await p.frameLocator('#center iframe.app').locator('#path:has-text("/view/typed7?token=t-typed7-1")').waitFor();
            assert.equal(await bar.locator('.error').count(), 0);
          }),
        ), [VIEW_ROUTE, ['build/app.js', "textContent = location.pathname;", 'textContent = location.pathname + location.search;']]),
    ),
  );
});

test('in a browser, the sign-out path lands on the signed-out address whatever path it is given', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            for (const [to, landing] of [['/signin', '/signin'], ['/.//evil.example.test', '/'], ['/%2e//evil.example.test', '/'], ['/.\\/evil.example.test', '/']]) {
              await p.goto(`${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent(to)}`);
              await p.waitForURL((u) => u.pathname !== app.signOutPath);
              assert.equal(p.url(), `${app.signedOutUrl}${landing}`, to);
            }
          }),
        ),
      ),
    ),
  );
});

const frameWho = (p: Page, name: string) => p.frameLocator('#center iframe.app').locator(`#who:has-text("${name}")`).waitFor();

test('in a browser, a screen under a role condition opens as the first configured role that meets it, and a role picked in the bar reloads the frame and stays picked on other screens', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture(roleSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const [admin, auditor] = app.roles;
            const bar = p.locator('#center .frame-bar');
            const picker = bar.locator('select.role');
            const frameSrc = () => p.locator('#center iframe.app').getAttribute('src');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/admin/member")');
            assert.deepEqual(await picker.locator('option').allTextContents(),
              ['자동', '기본 계정 (duru-admin)', 'ADMIN (duru-boss)', 'AUDITOR (duru-auditor)', 'OWNER — 계정 없음']);
            assert.equal(await picker.locator('option:has-text("OWNER")').isDisabled(), true);
            assert.equal(await picker.inputValue(), 'auto');
            assert.match((await bar.textContent())!, /ADMIN 역할 duru-boss 로 로그인/);
            assert.equal(await frameSrc(), `${admin.url}/admin/member`);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'), `${admin.url}/admin/member`);
            await frameWho(p, '두루 대표');

            await picker.selectOption({ label: 'AUDITOR (duru-auditor)' });
            await frameWho(p, '두루 감사');
            assert.equal(await frameSrc(), `${auditor.url}/admin/member`);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'), `${auditor.url}/admin/member`);
            assert.match((await bar.textContent())!, /AUDITOR 역할 duru-auditor 로 로그인/);
            assert.match(await bar.locator('.error').allTextContents().then((t) => t.join('\n')), /이 역할은 화면 조건\(ADMIN\)을 채우지 못합니다/);

            await p.click('#screen-list li:has-text("/admin/report")');
            assert.equal(await picker.inputValue(), 'role:AUDITOR');
            assert.equal(await frameSrc(), `${auditor.url}/admin/report`);
            assert.match((await bar.textContent())!, /이 역할은 화면 조건\(ADMIN, OWNER\)을 채우지 못합니다/);

            await p.click('#screen-list li:has-text("/admin/audit")');
            assert.equal(await frameSrc(), `${auditor.url}/admin/audit`);
            assert.doesNotMatch((await bar.textContent())!, /채우지 못합니다/);

            await picker.selectOption({ label: '기본 계정 (duru-admin)' });
            await frameWho(p, '두루 관리자');
            assert.equal(await frameSrc(), `${app.url}/admin/audit`);
            assert.match((await bar.textContent())!, /duru-admin 로 로그인/);

            await picker.selectOption({ label: '자동' });
            await frameWho(p, '두루 대표');
            assert.equal(await frameSrc(), `${admin.url}/admin/audit`);

            await p.click('#screen-list li:has-text("/home")');
            assert.equal(await frameSrc(), `${app.url}/home`);
            assert.match((await bar.textContent())!, /duru-admin 로 로그인/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a narrow center column puts the address above the role picker instead of squeezing it', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture(roleSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.setViewportSize({ width: 1000, height: 900 });
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/admin/member")');
            const bar = (await p.locator('#center .frame-bar').boundingBox())!;
            const address = (await p.locator('#center .frame-bar .mono').boundingBox())!;
            const picker = (await p.locator('#center .frame-bar select.role').boundingBox())!;
            assert.ok(address.width > bar.width * 0.8, `address ${address.width}px in a ${bar.width}px bar`);
            assert.ok(picker.x + picker.width <= bar.x + bar.width, 'the role picker fits in the bar');
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen whose role has no account or cannot be read from the map opens as the default account and the bar says why, and signed-out screens have no role picker', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords({ ...ALL_PASSWORDS, [AUDITOR_PASSWORD_ENV]: undefined }, () =>
      withRebuiltFixture({ app: { ...roleSettings(api, { AUDITOR: 'duru-auditor' }).app, signedOutPaths: ['/signin'] } }, async (config, copy) => {
        const home = path.join(copy, 'client/src/components/Home.js');
        fs.writeFileSync(home, fs.readFileSync(home, 'utf8').replace("const isAdmin = memberRole === 'ADMIN';", "const isAdmin = memberRole !== 'MEMBER';"));
        execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/admin/member")');
            assert.deepEqual(await bar.locator('select.role option[disabled]').allTextContents(), ['ADMIN — 계정 없음', 'OWNER — 계정 없음']);
            assert.match((await bar.locator('.error').textContent())!, /조건을 채우는 역할\(ADMIN\)에 계정이 없습니다/);
            assert.match((await bar.textContent())!, /duru-admin 로 로그인/);
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.url}/admin/member`);

            await p.click('#screen-list li:has-text("/admin/group")');
            assert.match((await bar.locator('.error').textContent())!, /어느 역할이 조건을 채우는지 맵에서 정할 수 없습니다: isAdmin/);
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.url}/admin/group`);

            await bar.locator('select.role').selectOption({ label: 'AUDITOR (duru-auditor)' });
            assert.match((await bar.locator('.error').first().textContent())!, new RegExp(AUDITOR_PASSWORD_ENV));
            assert.doesNotMatch((await bar.textContent())!, /AUDITOR 역할 duru-auditor 로 로그인/);

            await p.click('#screen-list li:has-text("/signin")');
            assert.match((await bar.textContent())!, /로그아웃 상태/);
            assert.equal(await bar.locator('select.role').count(), 0);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a screen opens as a role that logged in before one whose login failed, and guards left unread are named even when the values are known', { skip: browserMissing }, async () => {
  const roles = {
    ADMIN: { id: 'duru-auditor', passwordEnv: AUDITOR_PASSWORD_ENV },
    OWNER: { id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV },
  };
  await withFakeApi((api) =>
    withPasswords({ ...ALL_PASSWORDS, [AUDITOR_PASSWORD_ENV]: undefined }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, roles } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/admin/report")');
            await frameWho(p, '두루 대표');
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.roles[1].url}/admin/report`);
            assert.match((await bar.textContent())!, /OWNER 역할 duru-boss 로 로그인/);

            await p.click('#screen-list li:has-text("/admin/group")');
            assert.match((await bar.locator('.error').first().textContent())!, new RegExp(AUDITOR_PASSWORD_ENV));
            assert.match((await bar.textContent())!, /읽지 못한 역할 조건도 있습니다: isAdmin\b/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, without app settings the center column has no frame', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/home")');
        await p.waitForSelector('#center table');
        assert.equal(await p.locator('#center iframe').count(), 0);
        assert.equal(await p.locator('#center .frame-bar').count(), 0);
      }),
    ),
  );
});
