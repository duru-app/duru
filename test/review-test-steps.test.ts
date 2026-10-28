import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright-core';
import { withRebuiltFixture, withServer, browserMissing, withPage, chooseScreen, changeData, TRACED } from './review-helpers.ts';

const STEPS = { tests: [...TRACED.tests, { format: 'playwright', path: 'results/playwright-steps', depth: 'ui' }] };

const testLine = (p: Page, title: string) => p.locator('#center .part-row', { has: p.locator('.test', { hasText: title }) });
const foldOf = (row: Locator) => row.locator('xpath=following-sibling::*[1][contains(@class, "test-steps")]');
const lines = (fold: Locator) => fold.locator('.step-lines > li').evaluateAll((items) => items.map((li) => li.textContent!.replace(/\s+/g, ' ').trim()));
const focusedSteps = (p: Page) => p.evaluate(() => {
  const el = document.activeElement as HTMLElement;
  return [el.className, el.closest('[data-steps]')?.getAttribute('data-steps') ?? null];
});

const markers = async (p: Page) => {
  const { nodes } = await (await p.context().newCDPSession(p)).send('Accessibility.getFullAXTree');
  return nodes.filter((n) => n.role?.value === 'ListMarker').map((n) => String(n.name?.value).trim());
};

async function withSteps(fn: (p: Page) => Promise<void>, setup?: (page: Page) => Promise<unknown>) {
  await withRebuiltFixture(STEPS, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await chooseScreen(p, '/home');
        await fn(p);
      }, { setup })));
}

test('in a browser, 「단계」 on a screen\'s test opens, in order, what the test opened, pressed, wrote and checked, and closes it again with the focus kept on it', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    const row = testLine(p, 'fills the boxes on home').first();
    const button = row.locator('.steps-toggle');
    assert.equal(await button.textContent(), '단계');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await foldOf(row).count(), 0);

    await button.click();
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    const [cls, place] = await focusedSteps(p);
    assert.equal(cls, 'steps-toggle');
    assert.equal(place, await button.getAttribute('data-steps'));
    assert.deepEqual(await lines(foldOf(row)), [
      '열기 /home',
      '넣기 /home 라벨 「메모」 · 1 번째 첫 메모',
      '넣기 /home 라벨 「메모」 · 2 번째 둘째 메모',
      '넣기 /home 안내 글 「이름」 Kim',
      '넣기 /home 테스트 ID 「amount」 3',
      '넣기 /home 찾은 상자를 읽지 못함 css 값',
      '넣기 /home 찾은 상자를 읽지 못함 role 값',
      '넣기 /home 라벨 「따옴표 "큰"」 q',
      '누르기 /home',
      '넣기 /home 안내 글 「이름」 빈 값',
      '넣기 /home 안내 글 「이름」 abc',
      '넣기 /home 찾은 상자를 읽지 못함 나',
      '넣기 /home 찾은 상자를 읽지 못함 켬',
      '넣기 /home 찾은 상자를 읽지 못함 끔',
      '넣기 /home 찾은 상자를 읽지 못함 켬',
      '넣기 /home 찾은 상자를 읽지 못함',
      '넣기 /home 찾은 상자를 읽지 못함 x',
      '누르기 /home',
      '열기 /document/:tab(draft|done)',
      '넣기 /document/:tab(draft|done) 안내 글 「제목」 제목 값',
    ]);
    assert.equal(await foldOf(row).locator('.step-unread').first().getAttribute('title'), '#css');

    await button.click();
    assert.equal(await foldOf(row).count(), 0);
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal((await focusedSteps(p))[0], 'steps-toggle');
  });
});

test('in a browser, a test that ran in two projects shows the steps of its own project first and the other one\'s on its chip', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    const [chromium, firefox] = [testLine(p, 'fills the boxes on home').first(), testLine(p, 'fills the boxes on home').nth(1)];
    await firefox.locator('.steps-toggle').click();
    const fold = foldOf(firefox);
    assert.deepEqual(await fold.locator('.step-project').allTextContents(), ['chromium', 'firefox']);
    assert.equal(await fold.locator('.step-project.on').textContent(), 'firefox');
    assert.deepEqual(await lines(fold), ['열기 /home', '확인 /home']);
    assert.equal(await foldOf(chromium).count(), 0);

    await fold.locator('.step-project', { hasText: 'chromium' }).click();
    assert.equal(await foldOf(firefox).locator('.step-project.on').textContent(), 'chromium');
    assert.equal((await lines(foldOf(firefox))).length, 20);
    assert.deepEqual(await p.evaluate(() => [document.activeElement!.textContent, document.activeElement!.getAttribute('aria-pressed')]), ['chromium', 'true']);
  });
});

test('in a browser, the calls a test sent come between its steps with their status, and one on the map opens that call', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    const row = testLine(p, 'lists the documents on home');
    await row.locator('.steps-toggle').click();
    assert.deepEqual(await lines(foldOf(row)), ['열기 /home', 'GET /api/v1/document/list 404', 'GET /api/v1/member/list 404']);
    await foldOf(row).locator('.request-line button', { hasText: '/api/v1/document/list' }).click();
    assert.equal(await p.textContent('#center .call-info > summary .target-id .mono'), 'GET:/api/v1/document/list');
  });
});

test('in a browser, the calls between two steps take no number, so the steps are numbered one after another', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    const row = testLine(p, 'lists the documents on home');
    await row.locator('.steps-toggle').click();
    assert.deepEqual(await lines(foldOf(row)), ['열기 /home', 'GET /api/v1/document/list 404', 'GET /api/v1/member/list 404', '누르기 /home']);
    assert.deepEqual(await markers(p), ['1.', '2.']);
  }, changeData((data) => {
    for (const runs of Object.values(data.testSteps)) runs.chromium?.push({ kind: 'press', method: 'click', path: '/home', screen: '/home#Home' });
  }));
});

test('in a browser, the steps of a test that only sent a call can be opened from the call\'s list of tests that sent it', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    await p.locator('table.calls tbody tr:not(.option)', { hasText: 'GET:/api/v1/document/list' }).locator('td.cell').first().click();
    const row = p.locator('#center .call-info .passed .part-row', { hasText: 'lists the documents calls.spec.ts' });
    await row.locator('.steps-toggle').click();
    assert.deepEqual(await lines(foldOf(row)), ['열기 /home', 'GET /api/v1/document/list 404']);
  });
});

test('in a browser, a browser test without a trace, with a trace that could not be read or that was skipped says why it has no steps, each run for itself, and a test of another kind has no 「단계」', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    const why = async (title: string, run = 0) => {
      const row = testLine(p, title).nth(run);
      await row.locator('.steps-toggle').click();
      return foldOf(row).textContent();
    };
    assert.equal(await why('opens home without a trace'), '이 테스트는 trace 파일 없이 돌아 한 일을 알 수 없습니다. Playwright 의 trace 옵션을 켜고 다시 돌리면 보입니다.');
    assert.equal(await why('opens home without snapshots'), '이 테스트의 trace 파일을 읽지 못해 한 일을 알 수 없습니다. trace 파일에 화면 스냅숏이 없어 테스트가 연 주소를 알 수 없습니다.');
    assert.equal(await why('opens home without snapshots', 1), '이 테스트는 trace 파일 없이 돌아 한 일을 알 수 없습니다. Playwright 의 trace 옵션을 켜고 다시 돌리면 보입니다.');
    assert.equal(await why('skips home'), '이 테스트는 건너뛰어 돌지 않았으므로 한 일이 없습니다.');
    const others = p.locator('#center .part-row', { has: p.locator('.test .depth, .test', { hasNotText: '.spec.' }) });
    assert.ok(await others.count() > 0);
    assert.equal(await others.locator('.steps-toggle').count(), 0);
  });
});
