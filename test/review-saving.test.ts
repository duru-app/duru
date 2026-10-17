import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addMark, loadMarks } from '../src/marks.ts';
import { withRebuiltFixture, withServer, postMark, browserMissing, toList, withPage, openDocumentScreenInShortViewport, openHistory, insideRightPane } from './review-helpers.ts';
import type { PageData, FailSave } from './review-helpers.ts';

test('a mark posted from the page is saved with the server-side author and date and is there after reopening', async () => {
  await withRebuiltFixture({}, async (config) => {
    await withServer(config, 'reviewer', async (base) => {
      const res = await postMark(base, { target: { node: '/lab#Lab', depth: 'api' }, status: 'needs-more', note: 'only a UI test', author: 'someone else' });
      assert.equal(res.status, 201);
      assert.equal((await postMark(base, { target: { node: '/lab#Lab' }, status: 'maybe' })).status, 400);
    });
    const [saved] = loadMarks(config.marksDir);
    assert.equal(config.marksDir, path.join(config.outDir, 'marks'));
    assert.equal(saved.author, 'reviewer');
    assert.match(saved.date, /^\d{4}-\d\d-\d\dT/);

    await withServer(config, 'reviewer', async (base) => {
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.map((m) => [m.key, m.current.status, m.current.note]), [['/lab#Lab api', 'needs-more', 'only a UI test']]);
    });
  });
});

test('in a browser, a comment with no status is saved from the text alone, shows in the conversation with no 「코멘트」 label and leaves the current status as it was; pressing a picked status again lets it go', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await toList(p);
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.waitForSelector('#screen-list li.selected .chip.missing');

        assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), ['없음']);
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await p.locator('#right .statuses button.on').count(), 0);
        assert.equal(await p.isDisabled('#right button.save'), true);
        await p.fill('#right-dock textarea', 'the empty list too');
        assert.equal(await p.isDisabled('#right button.save'), false);
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("the empty list too")');
        assert.equal(await p.locator('#right .history li:has-text("the empty list too") .chip').count(), 0);
        assert.equal(await p.textContent('#right .history li:has-text("the empty list too") .tag-label'), '화면 전체');
        assert.equal(await p.textContent('#screen-list li.selected .chip'), '없음');
        assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), ['없음']);
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.status ?? null, m.note]).sort(), [[null, 'the empty list too'], ['missing', '']]);

        await p.fill('#right-dock textarea', 'typed with the status still picked');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("typed with the status still picked")');
        assert.equal(await p.locator('#right .history li:has-text("typed with the status still picked") .chip').count(), 0);
        await p.click('#right .statuses button:has-text("없음")');
        p.once('dialog', (d) => assert.fail(`no unsaved warning expected, got: ${d.message()}`));
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
      }),
    ),
  );
});

test('a mark on a story is saved through the page, and one on a story ID outside the ID rule is refused', async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      assert.equal((await postMark(base, { target: { story: 'run-lab' }, status: 'missing', note: 'walk it' })).status, 201);
      const refused = await postMark(base, { target: { story: '../run-lab' }, status: 'missing' });
      assert.equal(refused.status, 400);
      assert.equal((await postMark(base, { target: { story: 'run-lab', depth: 'ui' }, status: 'missing' })).status, 400);
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.map((m) => [m.key, m.target, m.current.note, m.current.author]), [['story(run-lab)', { story: 'run-lab' }, 'walk it', 'reviewer']]);
    }),
  );
});

test('in a browser, a chosen story takes marks that are saved as files and kept as its history, and once its story file is gone the mark shows as detached under the stories', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#view-story');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await p.locator('#right h2').allTextContents(), ['사전 조건', '이름 · 메모', '에이전트와 대화']);
        assert.equal(await p.isDisabled('#right button.save'), true);
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', 'no test walks the lab');
        await p.click('#right button.save');
        await openHistory(p);
        await p.waitForSelector('#right .history li:has-text("no test walks the lab")');
        await p.click('#right .statuses button:has-text("더 필요")');
        await p.fill('#right-dock textarea', 'the story test fails');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("the story test fails")');
        assert.deepEqual(await p.locator('#right .history li .chip').allTextContents(), ['없음', '더 필요']);
        assert.equal(await p.textContent('#story-list li.selected .chip.needs-more'), '더 필요');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status!, m.note, m.author] as const).sort((a, b) => a[1].localeCompare(b[1])), [
          [{ story: 'run-lab' }, 'missing', 'no test walks the lab', 'reviewer'],
          [{ story: 'run-lab' }, 'needs-more', 'the story test fails', 'reviewer'],
        ]);
        assert.equal(fs.readdirSync(path.join(config.marksDir, 'stories', 'run-lab')).length, 2);

        await p.click('#story-list li:has-text("보고서")');
        assert.equal(await p.locator('#right .history li').count(), 0);
        assert.equal(await p.locator('#right .statuses button.on').count(), 0);
        await p.click('#view-list');
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /^화면 전체$/);
        assert.equal(await p.locator('#right .history li').count(), 0);
        assert.match((await p.textContent('#left'))!, /떨어져 나감 0/);

        fs.rmSync(path.join(config.storiesDir, 'run-lab.json'));
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.match((await p.textContent('#left'))!, /떨어져 나감 0/);
        await p.click('#view-story');
        assert.equal(await p.locator('#story-list li:has-text("실험실을 열어")').count(), 0);
        assert.match((await p.textContent('#left'))!, /떨어져 나감 1/);
        const detached = p.locator('#left .detached li');
        assert.equal(await detached.count(), 1);
        assert.equal(await detached.locator('.chip').textContent(), '더 필요');
        assert.equal(await detached.locator('code').textContent(), 'run-lab');
        assert.match((await detached.textContent())!, /the story test fails/);
        assert.doesNotMatch((await detached.textContent())!, /reviewer/);
      }),
    ),
  );
});

test('in a browser, a failed save stays with the form that tried it and is gone after choosing another story or switching tabs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        const failSave = async () => {
          if (!(await p.locator('#right .statuses button.on:has-text("없음")').count())) await p.click('#right .statuses button:has-text("없음")');
          await p.click('#right button.save');
          await p.waitForSelector('#right .error');
          assert.match((await p.textContent('#right'))!, /저장하지 못했습니다: disk full/);
        };
        await p.click('#view-story');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.locator('#right .error').count(), 0);
        await failSave();
        await p.click('#story-list li:has-text("보고서")');
        assert.doesNotMatch((await p.textContent('#right'))!, /저장하지 못했습니다/);
        await p.click('#story-list li:has-text("실험실을 열어")');
        await failSave();
        await p.click('#view-list');
        assert.doesNotMatch((await p.textContent('#right'))!, /저장하지 못했습니다/);
        await p.click('#view-story');
        await failSave();
        await p.click('#center .story-path .step:has-text("/lab/result")');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
        assert.doesNotMatch((await p.textContent('#right'))!, /저장하지 못했습니다/);
      }),
    ),
  );
});

test('in a browser, a mark on a story whose file is there but cannot be read shows on the stories tab and can be marked again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    fs.writeFileSync(path.join(config.storiesDir, 'run-lab.json'), '{');
    addMark(config.marksDir, { target: { story: 'run-lab' }, status: 'missing', note: 'walk it', author: 'a' }, new Date('2026-09-30T01:00:00Z'));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#view-story');
        assert.match((await p.textContent('#left'))!, /떨어져 나감 0/);
        const unread = p.locator('#left .unread-marks li');
        assert.equal(await unread.count(), 1);
        assert.equal(await unread.locator('.chip').textContent(), '없음');
        assert.equal(await unread.locator('code').textContent(), 'run-lab');
        await unread.click();
        assert.equal(await p.textContent('#center h3'), 'run-lab');
        assert.equal(await p.textContent('#right h2'), '에이전트와 대화');
        assert.equal(await p.locator('#right-info > :not(.talk-scope)').count(), 0);
        assert.ok(await p.evaluate(() => document.getElementById('right-dock')!.getBoundingClientRect().top - document.getElementById('right-info')!.getBoundingClientRect().bottom) < 1, 'the form sits right under the conversation buttons');
        assert.match((await p.textContent('#right .history'))!, /walk it/);
        await p.click('#right .statuses button:has-text("충분")');
        await p.click('#right button.save');
        await openHistory(p);
        await p.waitForSelector('#right .history li:nth-child(2)');
        assert.equal(await p.textContent('#right .history > li:last-child .chip'), '충분');
        assert.equal(await p.textContent('#left .unread-marks li .chip'), '충분');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status!] as const).sort((a, b) => a[1].localeCompare(b[1])), [
          [{ story: 'run-lab' }, 'fine'], [{ story: 'run-lab' }, 'missing'],
        ]);
      }),
    );
  });
});

test('in a browser, a failed save stays with the screen or cell that tried it, and a save that fails after the reviewer moved on names the target it was for', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        const failSave = async () => {
          await p.click('#right .statuses button:has-text("없음")');
          await p.click('#right button.save');
          await p.waitForSelector('#right .error');
          assert.match((await p.textContent('#right'))!, /저장하지 못했습니다: disk full/);
        };
        await p.click('#screen-list li:has-text("/document/:id")');
        await failSave();
        await p.click('#center tr:has-text("API")');
        assert.doesNotMatch((await p.textContent('#right'))!, /저장하지 못했습니다/);
        await failSave();
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.doesNotMatch((await p.textContent('#right'))!, /저장하지 못했습니다/);

        await p.click('#screen-list li:has-text("/admin/report")');
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks')
            ? new Promise((resolve, reject) => { (window as unknown as FailSave).failSave = () => reject(new Error('disk full')); })
            : real(url, init));
        });
        await p.locator('table.calls tr.option', { hasText: 'withAttachments 켬' }).first().locator('td.cell').nth(1).click();
        const cellLabel = (await p.textContent('#right .mark-form .tags .tag-label'))!;
        assert.match(cellLabel, /^withAttachments 켬 · .+ 깊이$/);
        const cellName = `${await p.textContent('#center .call-info .target-id .mono')} · ${cellLabel}`;
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.click('#center tr:has-text("화면 전체")');
        assert.equal(await p.locator('#right .error').count(), 0);
        await p.evaluate(() => (window as unknown as FailSave).failSave());
        await p.waitForSelector('#right-dock .error');
        assert.equal(await p.textContent('#right-dock .error'), `「${cellName}」 코멘트를 저장하지 못했습니다: disk full`);

        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.evaluate(() => (window as unknown as FailSave).failSave());
        await p.waitForFunction(() => document.querySelector('#right-dock .error')?.textContent === '저장하지 못했습니다: disk full');
      }),
    ),
  );
});

test('in a browser, a save that finishes after the reviewer moved to another screen, or left and came back, keeps the status and memo picked since, and a form left untouched shows the saved mark', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        let onPost: (release: () => void) => void;
        await p.route('**/api/marks', async (route) => {
          await new Promise<void>((release) => onPost(release));
          await route.continue();
        });
        const holdNextPost = () => new Promise<() => void>((resolve) => { onPost = resolve; });
        const pick = async (status: string, note: string) => {
          await p.click(`#right .statuses button:has-text("${status}")`);
          await p.fill('#right-dock textarea', note);
        };
        const assertForm = async (status: string, note: string) => {
          assert.equal(await p.inputValue('#right-dock textarea'), note);
          assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), [status]);
        };

        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#right .statuses button:has-text("없음")');
        let posting = holdNextPost();
        await p.click('#right button.save');
        let release = await posting;
        await p.click('#screen-list li:has-text("/admin/report")');
        await pick('더 필요', 'keep me');
        const documentChip = '#screen-list li:has-text("/document/:id") .chip.missing';
        assert.equal(await p.locator(documentChip).count(), 0);
        release();
        await p.waitForSelector(documentChip);
        await assertForm('더 필요', 'keep me');

        posting = holdNextPost();
        await p.click('#right button.save');
        release = await posting;
        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#screen-list li:has-text("/admin/report")');
        await pick('충분', 'second thoughts');
        const reportChip = '#screen-list li:has-text("/admin/report") .chip.needs-more';
        assert.equal(await p.locator(reportChip).count(), 0);
        release();
        await p.waitForSelector(reportChip);
        await assertForm('충분', 'second thoughts');

        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#right .statuses button:has-text("충분")');
        posting = holdNextPost();
        await p.click('#right button.save');
        release = await posting;
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#screen-list li:has-text("/lab/result")');
        release();
        await p.waitForSelector('#screen-list li:has-text("/lab/result") .chip.fine');
        await assertForm('충분', '');

        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status!, m.note] as const).sort((a, b) => a[1].localeCompare(b[1])), ([
          [{ node: '/document/:id#DocumentDetail' }, 'missing', ''],
          [{ node: '/admin/report#AdminReport' }, 'needs-more', 'keep me'],
          [{ node: '/lab/result#LabResult' }, 'fine', ''],
        ] satisfies [object, string, string][]).sort((a, b) => a[1].localeCompare(b[1])));
      }),
    ),
  );
});

test('in a browser, a save whose reload fails after the reviewer moved to another story names the story it was for, and one that stays says so plainly', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        let onPost: (release: () => void) => void;
        await p.route('**/api/marks', async (route) => {
          await new Promise<void>((release) => onPost(release));
          await route.continue();
        });
        const holdNextPost = () => new Promise<() => void>((resolve) => { onPost = resolve; });
        await p.click('#view-story');
        const first = p.locator('#story-list li:has-text("실험실을 열어")');
        const name = await first.locator('.name > span').textContent();
        await first.click();
        await p.click('#right .statuses button:has-text("없음")');
        let posting = holdNextPost();
        await p.click('#right button.save');
        let release = await posting;
        await p.click('#story-list li:has-text("보고서")');
        await p.route('**/api/data', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' }));
        release();
        await p.waitForSelector('#right-dock .error');
        assert.ok((await p.textContent('#right-dock .error'))!.startsWith(`「스토리 ${name}」 코멘트는 저장했지만 다시 읽지 못했습니다: `));

        await p.click('#right .statuses button:has-text("없음")');
        posting = holdNextPost();
        await p.click('#right button.save');
        release = await posting;
        release();
        await p.waitForFunction(() => document.querySelector('#right-dock .error')?.textContent.startsWith('저장했지만 다시 읽지 못했습니다: '));
      }),
    ),
  );
});

test('in a browser, picking a status updates the form in place, keeping the memo box and the height it was dragged to', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.equal(await p.locator('#right button.save').isEnabled(), false);
        const memo = (await p.$('#right-dock textarea'))!;
        const dragged = await memo.evaluate((e) => { e.style.height = '150px'; return e.getBoundingClientRect().height; });
        await p.click('#right .statuses button:has-text("더 필요")');
        assert.ok(await memo.evaluate((e) => e === document.querySelector('#right-dock textarea')), 'the memo box is the same element');
        assert.equal(await memo.evaluate((e) => e.getBoundingClientRect().height), dragged);
        assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), ['더 필요']);
        assert.equal(await p.locator('#right button.save').isEnabled(), true);
        await p.click('#right .statuses button:has-text("충분")');
        assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), ['충분']);
      }),
    ),
  );
});

test('in a browser, a save that is refused shows its message in the dock above the save button, both inside the visible part of the pane', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p, base);
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.resolve(new Response('mark is refused', { status: 400 })) : real(url, init));
        });
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.waitForSelector('#right-dock .error');
        assert.equal(await p.locator('#right-dock .error').count(), 1);
        assert.equal(await p.locator('#right .error ~ .save-row button.save').count(), 1);
        const inside = async () => (await insideRightPane(p, '#right .mark-form .error')) && insideRightPane(p, '#right .mark-form button.save');
        assert.match((await p.textContent('#right .error'))!, /저장하지 못했습니다: mark is refused/);
        assert.ok(await inside());

        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        await p.click('#right button.save');
        await p.waitForFunction(() => /저장하지 못했습니다: disk full/.test(document.querySelector('#right .error')?.textContent ?? ''));
        assert.ok(await inside());
      }),
    ),
  );
});

test('in a browser, a save whose reload fails after the review ended raises no page error', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        let reload: () => void;
        const reloading = new Promise<void>((resolve) => { reload = resolve; });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        await p.route('**/api/data', async (route) => {
          reload();
          await gate;
          await route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' });
        });
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await reloading;
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        release();
        await p.waitForTimeout(200);
      }),
    ),
  );
});
