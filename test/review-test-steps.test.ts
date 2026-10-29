import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
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

test('in a browser, a test that ran in two projects shows the steps of its own project first and the other one\'s on its chip, and 「trace」 opens the run whose steps are shown', { skip: browserMissing }, async () => {
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
    assert.match((await firefox.locator('a.trace').getAttribute('href'))!, /project%3Dchromium$/);
    assert.match((await chromium.locator('a.trace').getAttribute('href'))!, /project%3Dchromium$/);
    await fold.locator('.step-project', { hasText: 'firefox' }).click();
    assert.match((await firefox.locator('a.trace').getAttribute('href'))!, /project%3Dfirefox$/);
    await chromium.locator('.steps-toggle').click();
    await foldOf(chromium).locator('.step-project', { hasText: 'firefox' }).click();
    assert.match((await chromium.locator('a.trace').getAttribute('href'))!, /project%3Dfirefox$/);
    assert.match((await firefox.locator('a.trace').getAttribute('href'))!, /project%3Dfirefox$/);
    await foldOf(firefox).locator('.step-project', { hasText: 'chromium' }).click();
    assert.match((await chromium.locator('a.trace').getAttribute('href'))!, /project%3Dfirefox$/);
  });
});

test('in a browser, a trace that could not be read is still told when tests.json came from a duru that wrote no source or project on its notices', { skip: browserMissing }, async () => {
  const withoutRun = changeData((data) => {
    for (const n of data.tests.traceNotices) {
      delete n.test.source;
      delete n.test.project;
    }
  });
  await withSteps(async (p) => {
    const row = testLine(p, 'opens home without snapshots').first();
    await row.locator('.steps-toggle').click();
    assert.equal(await foldOf(row).textContent(), '이 테스트의 trace 파일을 읽지 못해 한 일을 알 수 없습니다. trace 파일에 화면 스냅숏이 없어 테스트가 연 주소를 알 수 없습니다.');
  }, withoutRun);
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

test('in a browser, a test in a call\'s list of tests that sent it shows the status it got for that call next to 「호출함」', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    await p.locator('table.calls tbody tr:not(.option)', { hasText: 'GET:/api/v1/document/list' }).locator('td.cell').first().click();
    const test = p.locator('#center .call-info .passed .test', { hasText: 'lists the documents calls.spec.ts' });
    assert.deepEqual(await test.locator('.chip').allTextContents(), ['호출함', '404', '통과']);
    assert.equal(await test.locator('.chip.status-error').count(), 1);
  });
});

test('in a browser, each test of a screen sits on its own line, apart from the next one, with the line under the pointer shaded', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    const rows = p.locator('#center td .test-row');
    assert.ok(await rows.count() > 1);
    const look = (row: Locator) => row.evaluate((el) => [getComputedStyle(el).borderTopStyle, getComputedStyle(el).backgroundColor]);
    const [first, second] = [rows.first(), rows.nth(1)];
    assert.equal((await look(second))[0], 'solid');
    const plain = (await look(second))[1];
    await second.locator('.steps-toggle').hover();
    assert.notEqual((await look(second))[1], plain);
    assert.equal((await look(first))[1], plain);
    assert.equal(await first.locator('.steps-toggle').count(), 1);
  });
});

test('in a browser, a step line shows a small picture of the screen after it, and pressing it shows the picture large until it is closed', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    const row = testLine(p, 'shows the screen after each step');
    await row.locator('.steps-toggle', { hasText: '단계' }).click();
    const thumbs = foldOf(row).locator('button.shot-thumb img');
    assert.equal(await thumbs.count(), 3);
    await thumbs.first().evaluate((img: HTMLImageElement) => img.decode());
    assert.ok(await thumbs.first().evaluate((img: HTMLImageElement) => img.naturalWidth) > 0);
    assert.equal(await testLine(p, 'fills the boxes on home').first().locator('xpath=following-sibling::*[1]').locator('button.shot-thumb').count(), 0);

    await foldOf(row).locator('button.shot-thumb').nth(2).click();
    const view = p.locator('#shot-view');
    assert.ok(await view.evaluate((d: HTMLDialogElement) => d.open));
    const big = view.locator('img');
    await big.evaluate((img: HTMLImageElement) => img.decode());
    const width = (img: Locator) => img.evaluate((el: HTMLImageElement) => el.getBoundingClientRect().width);
    assert.ok(await width(big) > 1.5 * await width(thumbs.nth(2)));
    await p.keyboard.press('Escape');
    assert.equal(await view.evaluate((d: HTMLDialogElement) => d.open), false);

    await foldOf(row).evaluate((el: HTMLElement) => { el.style.width = '300px'; });
    const thumb = foldOf(row).locator('button.shot-thumb').first();
    const right = (box: { x: number; width: number } | null) => box!.x + box!.width;
    assert.ok(right(await thumb.locator('img').boundingBox()) <= right(await thumb.boundingBox()));
    assert.ok(right(await thumb.boundingBox()) <= right(await foldOf(row).boundingBox()));
  });
});

test('in a browser, 「재생」 shows a test\'s steps one at a time in a large window, each with the screen picture, moving on by itself and stopping at the last step', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    const row = testLine(p, 'shows the screen after each step');
    await row.locator('.steps-toggle').click();
    const all = await lines(foldOf(row));
    assert.ok(all.length > 2);
    const own = await foldOf(row).locator('.step-lines > li').evaluateAll((items) => items.map((li) => li.querySelector('img')?.getAttribute('src') ?? null));
    assert.ok(own.includes(null));
    assert.equal(await testLine(p, 'fills the boxes on home').first().locator('button.replay').count(), 0);
    const replay = row.locator('button.replay');
    assert.equal(await replay.textContent(), '재생');
    await replay.click();
    const view = p.locator('#replay-view');
    assert.ok(await view.evaluate((d: HTMLDialogElement) => d.open));
    const count = () => view.locator('.replay-count').textContent();
    const shown = () => view.locator('.replay-line > li').evaluate((li) => li.textContent!.replace(/\s+/g, ' ').trim());
    const pause = view.locator('button.pause');
    assert.equal(await count(), `1/${all.length}`);
    assert.equal(await shown(), all[0]);
    assert.ok(await view.locator('button.back').isDisabled());
    assert.equal(await pause.textContent(), '멈춤');
    const img = view.locator('img');
    await img.evaluate((el: HTMLImageElement) => el.decode());
    assert.ok(await img.evaluate((el: HTMLImageElement) => el.naturalWidth) > 0);
    assert.ok(await img.evaluate((el: HTMLImageElement) => {
      const box = el.getBoundingClientRect();
      return Math.min(box.width, box.height * el.naturalWidth / el.naturalHeight);
    }) > 600);

    await p.clock.runFor(2000);
    assert.equal(await count(), `2/${all.length}`);
    assert.equal(await shown(), all[1]);
    await pause.click();
    assert.equal(await pause.textContent(), '계속');
    await p.clock.runFor(5000);
    assert.equal(await count(), `2/${all.length}`);
    await view.locator('button.next').click();
    assert.equal(await count(), `3/${all.length}`);
    assert.equal(await shown(), all[2]);
    await p.keyboard.press('ArrowLeft');
    assert.equal(await count(), `2/${all.length}`);

    await pause.click();
    await p.clock.runFor(2000 * all.length);
    assert.equal(await count(), `${all.length}/${all.length}`);
    assert.ok(await view.locator('button.next').isDisabled());
    assert.equal(await pause.textContent(), '처음부터');
    let kept: string | null = null;
    const expected = own.map((src) => (kept = src ?? kept));
    for (let at = all.length - 1; at >= 0; at--) {
      assert.equal(await img.getAttribute('src'), expected[at]);
      if (at) await p.keyboard.press('ArrowLeft');
    }
    assert.equal(await count(), `1/${all.length}`);
    await p.keyboard.press('Alt+ArrowRight');
    assert.equal(await count(), `1/${all.length}`);
    await p.keyboard.press('Escape');
    assert.equal(await view.evaluate((d: HTMLDialogElement) => d.open), false);
  }, (page) => page.clock.install());
});

test('in a browser, 「재생」 says there is no screen picture on a step whose page had none yet and on the lines after it that keep it, and shows a picture again on the next step that has one', { skip: browserMissing }, async () => {
  let back = '';
  await withSteps(async (p) => {
    await testLine(p, 'shows the screen after each step').locator('button.replay').click();
    const view = p.locator('#replay-view');
    await view.locator('button.pause').click();
    await view.locator('button.next').click();
    assert.equal(await view.locator('.replay-count').textContent(), '2/5');
    assert.ok(await view.locator('img').isHidden());
    assert.equal(await view.locator('.no-shot').textContent(), '화면 그림 없음');
    for (const at of ['3/5', '4/5']) {
      await view.locator('button.next').click();
      assert.equal(await view.locator('.replay-count').textContent(), at);
      assert.ok(await view.locator('img').isHidden());
      assert.ok(await view.locator('.no-shot').isVisible());
    }
    await view.locator('button.next').click();
    assert.ok(await view.locator('img').isVisible());
    assert.equal(await view.locator('img').getAttribute('src'), `/test-shots/${encodeURIComponent(back)}`);
    assert.ok(await view.locator('.no-shot').isHidden());
  }, changeData((data) => {
    const keys = Object.keys(data.testSteps).filter((k) => k.includes('shows the screen after each step'));
    assert.equal(keys.length, 1);
    const lines = data.testSteps[keys[0]].chromium as { kind: string; shot?: string | null }[];
    assert.deepEqual(lines.map((line) => line.kind), ['open', 'write', 'press', 'request', 'open']);
    back = lines[2].shot!;
    lines[4].shot = back;
    lines[1].shot = null;
    delete lines[2].shot;
  }));
});

test('in a browser, 「trace」 opens the test\'s trace in the Playwright trace viewer in a new tab, and is greyed out once the trace file is gone', { skip: browserMissing }, async () => {
  await withSteps(async (p) => {
    const trace = testLine(p, 'shows the screen after each step').locator('a.trace');
    assert.equal(await trace.textContent(), 'trace');
    assert.equal(await trace.getAttribute('target'), '_blank');
    const [viewer] = await Promise.all([p.context().waitForEvent('page'), trace.click()]);
    await viewer.getByText('Navigate to "/home"').waitFor();
    await viewer.getByText('Fill "첫 메모"').waitFor();
    assert.equal(await testLine(p, 'opens home without a trace').locator('.trace, .replay').count(), 0);
    await viewer.close();
  });
  await withRebuiltFixture(STEPS, async (config, copy) => {
    fs.rmSync(path.join(copy, 'results/playwright-steps/test-results/steps-shows-the-screen-after-each-step-chromium'), { recursive: true });
    await withServer(config, 'reviewer', (base) => withPage(base, async (p) => {
      await p.waitForSelector('#screen-list li');
      await chooseScreen(p, '/home');
      const row = testLine(p, 'shows the screen after each step');
      assert.equal(await row.locator('a.trace').count(), 0);
      assert.equal(await row.locator('button.trace:disabled').textContent(), 'trace');
      assert.equal(await row.locator('button.replay').textContent(), '재생');
      await row.locator('.steps-toggle', { hasText: '단계' }).click();
      await foldOf(row).locator('button.shot-thumb img').first().evaluate((img: HTMLImageElement) => img.decode());
    }));
  });
});

test('the review server sends a test\'s trace and screen pictures only for what tests.json names, and no file outside the trace viewer', async () => {
  await withRebuiltFixture(STEPS, (config) => withServer(config, 'reviewer', async (base) => {
    const status = async (url: string) => (await fetch(`${base}${url}`)).status;
    const [key] = Object.keys(JSON.parse(fs.readFileSync(path.join(config.outDir, 'tests.json'), 'utf8')).traceFiles).filter((k) => k.includes('shows the screen'));
    assert.equal(await status(`/trace-viewer/test-trace?steps=${encodeURIComponent(key)}&project=chromium`), 200);
    assert.equal(await status(`/trace-viewer/test-trace?steps=${encodeURIComponent(key)}&project=firefox`), 404);
    assert.equal(await status('/trace-viewer/index.html'), 200);
    assert.equal(await status('/trace-viewer/sw.bundle.js'), 200);
    assert.equal(await status('/trace-viewer/..%2F..%2Fpackage.json'), 404);
    assert.equal(await status('/test-shots/page@191be84288f2d906ed440904919e2f78-1793237455323.jpeg'), 200);
    assert.equal(await status('/test-shots/..%2Ftests.json'), 404);
    assert.equal(await status('/test-shots/%E0%A4%A.jpeg'), 404);
    fs.mkdirSync(path.join(config.outDir, 'test-shots', 'page@folder-1.jpeg'));
    assert.equal(await status('/test-shots/page@folder-1.jpeg'), 404);
    assert.equal(await status('/trace-viewer/assets'), 404);
    assert.equal(await status('/trace-viewer/index.html/x'), 404);
    assert.equal(await status(`/test-shots/${'a'.repeat(300)}.jpeg`), 404);
    if (process.getuid?.() !== 0) {
      const locked = path.join(config.outDir, 'test-shots', 'page@191be84288f2d906ed440904919e2f78-1793237455323.jpeg');
      fs.chmodSync(locked, 0o000);
      assert.equal(await status('/test-shots/page@191be84288f2d906ed440904919e2f78-1793237455323.jpeg'), 500);
    }
  }));
});
