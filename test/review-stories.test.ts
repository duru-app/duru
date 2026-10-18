import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { addMark } from '../src/marks.ts';
import { taskList } from '../src/tasks.ts';
import { withRebuiltFixture, withServer, postMark, rebuild, browserMissing, withPage, TRACED, asked, why, placeOf, postJson, CANDIDATES, HELP_RECORD, HELP_KEY, PUBLISH_KEY, storiesTab, BAD_REQUEST, discardCandidate } from './review-helpers.ts';
import type { PageData } from './review-helpers.ts';

test('the data carries each story checked against the map with its status, the tests per story and the story files that could not be read, read again on every request', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual([data.stories.list, data.stories.notices], [[], []]);
      assert.deepEqual(data.stories.unknownTags.map((u) => u.tag), ['story:help-from-home', 'story:open-document', 'story:print-document', 'story:run-lab', 'story:run-lab']);
      assert.equal(data.storiesDir, path.join(config.outDir, 'stories'));
    }),
  );
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.stories.list.map((s) => [s.id, s.links.map((l) => l.verdict), s.broken, s.detached, s.status]), [
        ['change-settings', ['off-map'], false, true, 'partial'],
        ['help-from-home', ['open', 'broken'], true, false, 'pending'],
        ['open-document', ['open', 'open', 'open'], false, false, 'pass'],
        ['read-reports', [], false, false, 'untested'],
        ['run-lab', ['conditioned', 'open'], false, false, 'fail'],
      ]);
      assert.deepEqual(Object.keys(data.tests.stories).sort(), ['help-from-home', 'open-document', 'print-document', 'run-lab']);
      assert.deepEqual(data.stories.unknownTags.map((u) => u.tag), ['story:print-document']);
      assert.deepEqual(data.stories.notices.map((n) => n.file), ['lab-shortcut.json']);

      fs.writeFileSync(path.join(config.storiesDir, 'lab-shortcut.json'), JSON.stringify({ name: '실험실 결과', screens: ['/lab#Lab', '/lab/result#LabResult'], author: 'a', date: '2026-10-02' }));
      const again: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(again.stories.notices, []);
      assert.equal(again.stories.list.find((s) => s.id === 'lab-shortcut')!.reach[0].kind, 'start');

      fs.writeFileSync(path.join(config.storiesDir, 'print-document.json'), JSON.stringify({ name: '문서를 인쇄한다', screens: ['/document/:id#DocumentDetail'], author: 'a', date: '2026-10-03' }));
      const printed: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.equal(printed.stories.list.find((s) => s.id === 'print-document')!.status, 'pass');
      assert.deepEqual(printed.stories.unknownTags, []);
    }),
  );
});

test('a map.json built before links carried their conditions leaves the stories out with a message asking to rebuild apart from the story file notes, keeps the marks on stories attached, and the rest of the data and the task list still work', async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) for (const l of s.links) delete l.conditions;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    addMark(config.marksDir, { target: { story: 'run-lab' }, status: 'missing', author: 'a' }, new Date('2026-10-03T01:00:00Z'));
    await withServer(config, 'reviewer', async (base) => {
      const res = await fetch(`${base}/api/data`);
      assert.equal(res.status, 200);
      const data: PageData = await res.json();
      assert.equal(data.stories.list.length, 0);
      assert.deepEqual(data.stories.notices.map((n) => n.file), ['lab-shortcut.json']);
      assert.ok(data.stories.stale.startsWith(`${mapFile} 은 `));
      assert.match(data.stories.stale, /duru rebuild 로 맵을 다시 만드세요$/);
      assert.equal(data.map.screens.length, map.screens.length);
      assert.deepEqual([data.marks.attached.map((m) => m.key), data.marks.detached], [['story(run-lab)'], []]);
    });
    const tasks = taskList(config);
    assert.match(tasks, /^# Test tasks — 0 screens, 0 calls, 1 story, 1 open mark\n/);
    assert.equal(tasks.slice(tasks.indexOf('\n# Stories\n')), [
      '',
      '# Stories',
      '',
      'Story files are in `example-stories`.',
      '',
      'The map was built by a duru older than stories, so these stories are not checked against it. Run `duru rebuild` and read this list again.',
      '',
      '## run-lab',
      '',
      '- marks:',
      '  - missing (a, 2026-10-03)',
      '',
    ].join('\n'));
  });
});

test('in a browser, a map.json built before links carried their conditions shows the request to rebuild instead of the empty story list, and does not count it as an unreadable story file', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) for (const l of s.links) delete l.conditions;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#view-story');
        assert.match((await p.textContent('#left'))!, /duru rebuild 로 맵을 다시 만드세요/);
        assert.doesNotMatch((await p.textContent('#left'))!, /스토리 파일이 없습니다/);
        assert.equal(await p.locator('#story-list li').count(), 0);
        assert.equal(await p.locator('#left .notices li').count(), 1);
        assert.equal(await p.textContent('#left .notices li code'), 'lab-shortcut.json');
        assert.match((await p.textContent('#left'))!, /읽지 못한 스토리 파일 1/);
      }),
    );
  });
});

test('in a browser, the story list shows only the statuses that need a look, filters by 테스트 없음, 일부 화면만 테스트, 실패 and 링크 없음, and a chosen story shows its status, its story tests and the tests on each screen by depth and status', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#view-story');
        assert.equal(await p.getAttribute('#story-list li:has-text("보고서") .chip', 'title'), '스토리 테스트도, 경로의 화면에 붙은 테스트도 없습니다');

        const ids = () => p.locator('#story-list li .name .mono').allTextContents();
        assert.deepEqual(await p.locator('#left .filters legend').allTextContents(), ['상태 · 하나라도 맞으면', '그리고']);
        assert.deepEqual(await p.locator('#left .filters fieldset').evaluateAll((els) => els.map((e) => [...e.querySelectorAll('label')].map((l) => l.textContent))),
          [['테스트 없음', '일부 화면만 테스트', '실패'], ['링크 없음']]);
        await p.check('#left input[name=untested]');
        assert.deepEqual(await ids(), ['read-reports']);
        await p.check('#left input[name=partial]');
        assert.deepEqual(await ids(), ['change-settings', 'read-reports']);
        await p.check('#left input[name=broken]');
        assert.deepEqual(await ids(), []);
        assert.equal(await p.textContent('#story-list li.muted'), '해당하는 스토리가 없습니다.');
        await p.uncheck('#left input[name=untested]');
        await p.uncheck('#left input[name=partial]');
        assert.deepEqual(await ids(), ['help-from-home']);
        await p.check('#left input[name=fail]');
        assert.deepEqual(await ids(), []);
        await p.uncheck('#left input[name=broken]');
        assert.deepEqual(await ids(), ['run-lab']);

        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['실패']);
        assert.equal(await p.textContent('#center .story-tests h2'), '스토리 테스트 2');
        assert.deepEqual(await p.locator('#center .story-tests .test').evaluateAll((items) => items.map((t) => [...t.querySelectorAll('.depth, .chip')].map((e) => e.textContent))), [
          ['API', '실패'], ['API', '통과'],
        ]);
        assert.match((await p.locator('#center .story-tests .test').first().textContent())!, /Lab flow › runs the lab and reads the result com\.example/);
        const stepTests = () => p.locator('#center .story-path .step').evaluateAll((steps) => steps.map((s) => [...s.querySelectorAll('.step-tests > span')].map((e) => e.textContent.trim())));
        assert.deepEqual(await stepTests(), [['UI/E2E ✓3', 'API ✓1 ○1', '렌더링만 ✕1', '코드 ✓1', '데이터 ✕1'], ['UI/E2E ✓2 ○1', '코드 ○1'], ['화면 테스트 없음']]);
        assert.match((await p.getAttribute('#center .story-path .step:nth-child(3) .step-tests > span:first-child', 'title'))!, /opens the lab @screen:\/lab#Lab/);

        await p.uncheck('#left input[name=fail]');
        assert.equal((await ids()).length, 5);
        await p.click('#story-list li:has-text("문서를 연다")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['통과']);
        assert.deepEqual(await stepTests(), [['UI/E2E ✓1', '코드 ✓1'], ['UI/E2E ✓3', 'API ✓1 ○1', '렌더링만 ✕1', '코드 ✓1', '데이터 ✕1'], ['API ✓1 ✕2 ○1', '데이터 ○4'], ['UI/E2E ✓1', 'API ✓3 ✕3', '데이터 ✓2 ○2']]);

        await p.click('#story-list li:has-text("보고서")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['테스트 없음']);
        assert.equal(await p.textContent('#center .story-tests h2'), '스토리 테스트 0');
        assert.deepEqual(await stepTests(), [['화면 테스트 없음']]);
      }),
    ),
  );
});

test('in a browser, a story whose ID is the name of an object member shows like any other', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    fs.mkdirSync(config.storiesDir, { recursive: true });
    fs.writeFileSync(path.join(config.storiesDir, 'constructor.json'), JSON.stringify({ name: '이상한 ID', screens: ['/home#Home'], author: 'a', date: '2026-10-03' }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#view-story');
        await p.click('#story-list li:has-text("이상한 ID")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['일부 화면만 테스트']);
        assert.equal(await p.textContent('#center .story-tests h2'), '스토리 테스트 0');
      }),
    );
  });
});

test('the data carries the story candidates from the visit records, checked against the map, and the files that could not be read', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const { candidates }: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(candidates.list.map((c) => [c.name, c.source.record, c.screens.length, c.links.map((l) => l.verdict)]), [
        ['open-help', HELP_RECORD, 4, ['open', 'off-map', 'off-map']],
        ['publish-document', 'example-visits/publish-document.json', 4, ['open', 'open', 'conditioned']],
      ]);
      assert.deepEqual(candidates.notices, [{ file: 'example-visits/broken-record.json', reason: '2 번째 단계의 url 을 읽지 못했습니다' }]);
    }),
  );
});

test('the candidates from traces come from the screen orders rebuild wrote into tests.json and stored, so the page still offers and accepts them with the reports and traces gone, and also with a tests.json that has none of them', async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, async (config, copy) => {
    const visits = [HELP_KEY, PUBLISH_KEY];
    const drafts = '/home#Home > /document/:tab#DocumentList';
    fs.rmSync(path.join(copy, 'results/playwright-traced'), { recursive: true });
    await withServer(config, 'reviewer', async (base) => {
      const { candidates }: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(candidates.list.map((c) => c.key), [...visits, '/home#Home > /help#Help', drafts]);
      assert.deepEqual(candidates.notices, [{ file: 'example-visits/broken-record.json', reason: '2 번째 단계의 url 을 읽지 못했습니다' }]);
      assert.equal((await postJson(base, '/api/candidates/accept', { key: '/home#Home > /help#Help', id: 'home-help', name: 'x' })).status, 201);
    });
    const testsFile = path.join(config.outDir, 'tests.json');
    const older = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
    delete older.traced;
    fs.writeFileSync(testsFile, JSON.stringify(older));
    await withServer(config, 'reviewer', async (base) => {
      const { candidates }: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(candidates.list.map((c) => c.key), [...visits, drafts]);
      assert.equal((await postJson(base, '/api/candidates/accept', { key: drafts, id: 'drafts', name: 'x' })).status, 201);
      assert.deepEqual((await (await fetch(`${base}/api/data`)).json() as PageData).candidates.list.map((c) => c.key), visits);
    });
  });
});

const chipsIn = (p: Page, list: string) => p.locator(`${list} li`).evaluateAll((items) => items.map((li) => [...li.querySelectorAll('.chip')].map((c) => c.textContent)));

test('in a browser, the story list has a group of candidates, a chosen candidate shows its path like a story with the record steps behind each screen, and accepting it writes a story file under the name of the record, or under an ID and a name changed in a window, and moves it to the story list', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.match((await p.textContent('#left'))!, /후보 2/);
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['open-help', 'publish-document']);
        assert.deepEqual(await chipsIn(p, '#candidate-list'), [['화면 없음'], []]);
        assert.deepEqual(await p.locator('#candidate-notices li code').allTextContents(), ['example-visits/broken-record.json']);
        assert.match((await p.textContent('#left'))!, /건너뛴 파일 1/);

        await p.click('#candidate-list li:has-text("open-help")');
        assert.equal(await p.locator('#story-list li.selected').count(), 0);
        assert.equal(await p.textContent('#center h3'), 'open-help');
        assert.equal(await p.textContent('#center .source'), 'example-visits/open-help.json · 단계 1–5');
        assert.deepEqual(await p.locator('#center .story-path .step .records').allTextContents(), ['단계 1', '단계 2', '단계 3–4', '단계 5']);
        assert.equal(await p.textContent('#center .story-path .step.off-map .mono'), '/beta/inbox');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['이어짐', '판정 못 함', '판정 못 함']);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['판정 못 함 · 화면 없음']);
        assert.deepEqual(await p.locator('#right-info > :not(.talk-scope)').evaluateAll((els) => els.slice(0, 2).map((e) => e.textContent)), ['판정 못 함 · 화면 없음', '사전 조건']);
        assert.deepEqual(await p.locator('#right-info h2').allTextContents(), ['사전 조건', '받기']);
        assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '후보');
        assert.deepEqual(await p.locator('#right .story-form button').allTextContents(), ['스토리로 받기', '고쳐서 받기', '버리기']);
        assert.equal(await p.locator('#right .story-form :is(input, textarea)').count(), 0);
        assert.equal(await p.textContent('#right button.accept'), '스토리로 받기');

        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['publish-document']);
        assert.equal(await p.textContent('#center h3'), 'open-help');
        assert.match((await p.textContent('#center .source'))!, /^example-visits\/open-help\.json · 단계 1–5$/);
        const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'open-help.json'), 'utf8'));
        assert.deepEqual([saved.name, saved.author, saved.screens.length], ['open-help', 'reviewer', 4]);

        await p.click('#candidate-list li:has-text("publish-document")');
        assert.deepEqual(await p.locator('#right .accepts button').allTextContents(), ['스토리로 받기', '고쳐서 받기']);
        await p.click('#right button.accept-edited');
        await p.waitForSelector('#accept-ask[open]');
        assert.deepEqual([await p.inputValue('#accept-id'), await p.inputValue('#accept-name')], ['publish-document', 'publish-document']);
        assert.equal(await p.isVisible('#accept-ask .invalid'), false);
        await p.keyboard.press('Escape');
        assert.equal(await p.isVisible('#accept-ask'), false);
        assert.equal(await p.evaluate(() => document.activeElement!.className), 'accept-edited');

        await p.click('#right button.accept-edited');
        await p.fill('#accept-name', ' ');
        assert.equal(await p.isDisabled('#accept-ask button.accept'), true);
        await p.fill('#accept-id', 'publish');
        await p.fill('#accept-name', '문서를 발행한다');
        await p.keyboard.press('Enter');
        await p.waitForSelector('#story-list li.selected:has-text("문서를 발행한다")');
        assert.equal(await p.isVisible('#accept-ask'), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'publish.json'), 'utf8')).name, '문서를 발행한다');
      }),
    ),
  );
});

test('in a browser, a candidate discarded in another tab and read again while the window is open does not shift which candidate comes next', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("publish-document")');
        await p.click('#right button.discard');
        assert.equal((await postJson(base, '/api/candidates/discard', { key: HELP_KEY, reason: '베타 화면' })).status, 201);
        assert.equal((await postMark(base, { target: { node: '/lab#Lab' }, status: 'missing', note: '' })).status, 201);
        await p.waitForSelector('#candidate-list li:has-text("open-help")', { state: 'detached' });
        await p.fill(why, '중복');
        await p.click(`${asked} button.discard`);
        await p.waitForSelector('#candidate-list li:has-text("publish-document")', { state: 'detached' });
        assert.equal(await p.textContent('#candidate-list li.selected .name > span:first-child'), 'opens home and then help');
      }),
    ),
  );
});

test('in a browser, the tests with a trace that passed two screens or more are candidates beside the visit records, one per screen order with the report and every test title of that order as the source and its order in the address, and accepting or discarding one keeps it from coming back', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.match((await p.textContent('#left'))!, /후보 4/);
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['open-help', 'publish-document', 'opens home and then help', 'moves to the drafts without loading a page']);
        assert.deepEqual(await p.locator('#candidate-list li .name > .mono').allTextContents(), [HELP_RECORD, 'example-visits/publish-document.json', 'results/playwright-traced/visits.json', 'results/playwright-traced/visits.json']);

        await p.click('#candidate-list li:has-text("opens home and then help")');
        assert.equal(await p.textContent('#center h3'), 'opens home and then help');
        assert.equal(await p.locator('#center .story-path .step.on-map').count(), 2);
        assert.equal(await p.locator('#center .story-path .step .records').count(), 0);
        assert.equal(await p.locator('#center .source').evaluate((e) => e.firstChild!.textContent), 'results/playwright-traced/visits.json');
        const titles = ['opens home and then help', 'follows a link while waiting for the new address', 'uses the mouse right after the address changes', 'clicks a button that appears after the address changes'];
        assert.deepEqual(await p.locator('#center .source li').allTextContents(), titles);
        assert.equal(await placeOf(p), '#story?candidate=/home#Home+>+/help#Help');
        await p.reload();
        await p.waitForSelector('#candidate-list li.selected:has-text("opens home and then help")');

        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("opens home and then help")');
        assert.deepEqual(await p.locator('#center .source li').allTextContents(), titles);
        const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'opens-home-and-then-help.json'), 'utf8'));
        assert.deepEqual([saved.screens, saved.source], [['/home#Home', '/help#Help'], { report: 'results/playwright-traced/visits.json', tests: titles }]);

        await p.click('#candidate-list li:has-text("moves to the drafts")');
        await discardCandidate(p, '초안 탭만 연다');
        await p.waitForSelector('#candidate-list li:has-text("moves to the drafts")', { state: 'detached' });
        assert.equal(fs.readdirSync(path.join(config.storiesDir, 'discarded')).length, 1);
        rebuild(copy);
        await p.reload();
        await p.waitForSelector('#candidate-list li');
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['open-help', 'publish-document']);
      }),
    ),
  );
});

test('in a browser, with visit records and a map built before links carried their conditions, the candidates group asks to rebuild instead of showing none', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ visitRecords: ['example-visits'] }, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) for (const l of s.links) delete l.conditions;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    await withServer(config, 'reviewer', async (base) => {
      const { candidates } = await (await fetch(`${base}/api/data`)).json();
      assert.match(candidates.stale, /후보를 맞춰 보지 못했습니다\. duru rebuild 로 맵을 다시 만드세요$/);
      await withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.match((await p.textContent('#candidates-stale'))!, /후보를 맞춰 보지 못했습니다/);
        assert.equal(await p.locator('#candidate-list').count(), 0);
      });
    });
  });
});

test('in a browser, the candidates are followed by 「버린 후보 N」, shut until opened and staying open across a redraw, listing each discarded screen order once with its name, steps, reason and date, the latest discard first', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.equal(await p.locator('#left details.discarded-candidates').count(), 0);
        for (const [name, reason] of [['open-help', '베타 받은편지함은 맵에 없다'], ['publish-document', '문서 쪽은 따로 본다']]) {
          await p.click(`#candidate-list li:has-text("${name}")`);
          await discardCandidate(p, reason);
          await p.waitForSelector(`#candidate-list li:has-text("${name}")`, { state: 'detached' });
        }
        const group = p.locator('#left details.discarded-candidates');
        assert.equal(await p.textContent('#left details.discarded-candidates > summary'), '버린 후보 2');
        assert.equal(await group.evaluate((d: HTMLDetailsElement) => d.open), false);
        assert.equal(await p.isVisible('#discarded-list'), false);
        await p.click('#left details.discarded-candidates > summary');
        const rows = () => p.locator('#discarded-list > li').evaluateAll((items) => items.map((li) => [...li.children].map((c) => c.textContent)));
        const listed = await rows();
        assert.deepEqual(listed.map(([name, steps]) => [name, steps]), [
          ['publish-document', '/home → /document/:tab(draft|done) → /document/:id → /help'],
          ['open-help', '/signin → /home → /beta/inbox → /help'],
        ]);
        assert.match(listed[0][2]!, /^이유 문서 쪽은 따로 본다 · \d/);
        assert.match(listed[1][2]!, /^이유 베타 받은편지함은 맵에 없다 · \d/);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await group.evaluate((d: HTMLDetailsElement) => d.open), true);
      }),
    ),
  );
});

test('in a browser, 「되돌리기」 on a discarded candidate writes one undo record beside the discard even when double-clicked, offers the candidate again picked and drops it from 「버린 후보 N」, and a refused undo says why under the list', { skip: browserMissing || ((process.getuid?.() === 0 || process.platform === 'win32') && 'permissions do not stop this user from writing into the folder') }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        for (const [name, reason] of [['open-help', '베타 받은편지함은 맵에 없다'], ['publish-document', '문서 쪽은 따로 본다']]) {
          await p.click(`#candidate-list li:has-text("${name}")`);
          await discardCandidate(p, reason);
          await p.waitForSelector(`#candidate-list li:has-text("${name}")`, { state: 'detached' });
        }
        await p.click('#left details.discarded-candidates > summary');
        await p.dblclick('#discarded-list > li:has-text("open-help") button.undiscard');
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        assert.equal(await p.locator('#left .undiscard-error').count(), 0);
        assert.equal(await p.textContent('#left details.discarded-candidates > summary'), '버린 후보 1');
        assert.deepEqual(await p.locator('#discarded-list > li > div:first-child').allTextContents(), ['publish-document']);
        assert.equal(await p.textContent('#center h3'), 'open-help');
        const records = fs.readdirSync(path.join(config.storiesDir, 'discarded')).map((f) => JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'discarded', f), 'utf8')));
        assert.deepEqual(records.filter((r) => r.kind === 'undo').map(({ screens, author }) => [screens.join(' > '), author]), [[HELP_KEY, 'reviewer']]);

        const discardedFolder = path.join(config.storiesDir, 'discarded');
        fs.chmodSync(discardedFolder, 0o555);
        try {
          await p.click('#discarded-list > li:has-text("publish-document") button.undiscard');
          await p.waitForSelector('#left .undiscard-error');
          assert.match(await p.textContent('#left .undiscard-error') ?? '', /^저장하지 못했습니다: EACCES/);
          assert.equal(await p.textContent('#left details.discarded-candidates > summary'), '버린 후보 1');
        } finally {
          fs.chmodSync(discardedFolder, 0o755);
        }
        const gone = await postJson(base, '/api/candidates/undiscard', { screens: ['/home#Home'] });
        assert.deepEqual([gone.status, await gone.text()], [400, '버린 후보 /home#Home 가 없습니다']);
        assert.deepEqual(errors.splice(0), [BAD_REQUEST]);
      }),
    ),
  );
});

test('in a browser, the need files show under the story list with each one\'s name, file and how many stories pick it, the need files that could not be read with why, and pressing one shows its name, text, the stories that pick it and its file in the middle, from where a story opens', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config, copy) => {
    const stories = path.join(copy, 'example-stories');
    fs.mkdirSync(path.join(stories, 'needs'));
    fs.writeFileSync(path.join(stories, 'needs/member-account.json'), JSON.stringify({ name: '일반 회원 계정', text: '역할 USER 로 가입한 계정.\n이메일 member@example.com' }));
    fs.writeFileSync(path.join(stories, 'needs/done-document.json'), JSON.stringify({ name: '완료된 문서 하나', text: '서명이 끝난 문서가 하나 있다' }));
    fs.writeFileSync(path.join(stories, 'needs/broken.json'), '{');
    for (const id of ['run-lab', 'open-document']) {
      const story = JSON.parse(fs.readFileSync(path.join(stories, `${id}.json`), 'utf8'));
      fs.writeFileSync(path.join(stories, `${id}.json`), JSON.stringify({ ...story, needs: [{ use: 'member-account.json' }] }));
    }
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.equal(await p.textContent('#left h2.needs-head'), '공통 조건 2');
        assert.equal(await p.textContent('#left .needs-hint'), `${config.storiesDir}/needs/ 에 공통 조건마다 파일 하나`);
        assert.deepEqual(await p.locator('#need-list li').evaluateAll((items) => items.map((li) => [...li.querySelectorAll('.name > *, .count')].map((e) => e.textContent))), [
          ['완료된 문서 하나', 'needs/done-document.json', '쓰는 스토리 0'],
          ['일반 회원 계정', 'needs/member-account.json', '쓰는 스토리 2'],
        ]);
        assert.equal(await p.textContent('#left h2.need-notices-head'), '읽지 못한 공통 조건 파일 1');
        assert.match((await p.textContent('#need-notices'))!, /needs\/broken\.json\s*JSON 으로 읽지 못했습니다: /);
        assert.deepEqual(await p.locator('#story-list li .name .muted.mono').allTextContents(), ['change-settings', 'help-from-home', 'open-document', 'read-reports', 'run-lab']);

        await p.click('#need-list li:has-text("일반 회원 계정")');
        assert.equal(await p.getAttribute('#need-list li:has-text("일반 회원 계정")', 'class'), 'selected');
        assert.equal(await p.locator('#story-list li.selected').count(), 0);
        assert.deepEqual(await p.locator('#center .title-row > *').allTextContents(), ['일반 회원 계정', '공통 조건']);
        assert.equal(await p.textContent('#center .need-place'), `${config.storiesDir}/needs/member-account.json`);
        assert.equal(await p.textContent('#center .memo'), '역할 USER 로 가입한 계정.\n이메일 member@example.com');
        assert.equal(await p.textContent('#center h2.need-stories-head'), '이 공통 조건을 쓰는 스토리 2');
        assert.deepEqual(await p.locator('#need-stories li').allTextContents(), ['로그인해 문서 목록에서 문서를 연다open-document', '실험실을 열어 결과를 본다run-lab']);
        assert.equal(await p.textContent('#center details.need-file summary'), '공통 조건 파일 needs/member-account.json');
        assert.deepEqual(JSON.parse((await p.textContent('#center details.need-file pre'))!), { name: '일반 회원 계정', text: '역할 USER 로 가입한 계정.\n이메일 member@example.com' });
        assert.deepEqual(await p.locator('#center button').allTextContents(), ['고치기']);
        assert.equal(await p.locator('#center textarea, #center input').count(), 0);
        assert.equal(await p.locator('#right-dock textarea').count(), 0);
        assert.equal(await p.evaluate(() => location.hash), '#story?need=member-account.json');

        await p.click('#need-stories li:has-text("run-lab")');
        assert.equal(await p.textContent('#center h3'), '실험실을 열어 결과를 본다');
        assert.equal(await p.locator('#need-list li.selected').count(), 0);
        await p.goBack();
        await p.waitForSelector('#center .need-place');
        assert.equal(await p.textContent('#center h3'), '일반 회원 계정');
      }),
    );
  });
});

test('in a browser, a need chosen in the list is edited in the middle: 「고치기」 opens its name and text, 「취소」 leaves the file, 「저장」 writes them into the need file and every story picking it shows the new name, and after a save refused because the file changed elsewhere, 「새로 읽기」 fills in the changed file and 「덮어쓰기」 writes over it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) => {
    const file = path.join(config.storiesDir, 'needs/member-account.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ name: '일반 회원 계정', text: '역할 USER 로 가입한 계정' }));
    const storyFile = path.join(config.storiesDir, 'run-lab.json');
    fs.writeFileSync(storyFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(storyFile, 'utf8')), needs: [{ use: 'member-account.json' }] }));
    const story = fs.readFileSync(storyFile, 'utf8');
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#need-list li:has-text("일반 회원 계정")');
        await p.click('#center button.edit-need');
        assert.deepEqual([await p.inputValue('#need-name'), await p.inputValue('#need-text')], ['일반 회원 계정', '역할 USER 로 가입한 계정']);
        await p.fill('#need-name', '지울 이름');
        await p.click('#center button.cancel-need');
        assert.equal(await p.locator('#need-name').count(), 0);
        assert.equal(await p.textContent('#center h3'), '일반 회원 계정');

        await p.click('#center button.edit-need');
        await p.fill('#need-name', '회원 계정');
        await p.fill('#need-text', '역할 USER 로 가입한 계정.\n이메일 member@example.com');
        await p.click('#center button.save-need');
        await p.waitForSelector('#center .need-saved');
        assert.equal(await p.textContent('#center .need-saved'), '공통 조건 파일 needs/member-account.json 에 썼습니다');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { name: '회원 계정', text: '역할 USER 로 가입한 계정.\n이메일 member@example.com' });
        assert.equal(await p.textContent('#center h3'), '회원 계정');
        assert.equal(await p.textContent('#center .memo'), '역할 USER 로 가입한 계정.\n이메일 member@example.com');
        assert.equal(await p.textContent('#need-list li.selected .name > span'), '회원 계정');
        assert.equal(fs.readFileSync(storyFile, 'utf8'), story, 'the stories still pick the need by its file name');
        await p.click('#need-stories li:has-text("run-lab")');
        assert.equal(await p.textContent('#center .story-wide .need-use'), '공통 조건 회원 계정');

        await p.click('#need-list li:has-text("회원 계정")');
        await p.click('#center button.edit-need');
        await p.fill('#need-text', '역할 USER 계정');
        fs.writeFileSync(file, JSON.stringify({ name: '회원 계정', text: '다른 곳에서 고쳤다' }));
        await p.waitForSelector('#center .memo:has-text("다른 곳에서 고쳤다")');
        assert.equal(await p.inputValue('#need-text'), '역할 USER 계정');
        await p.click('#center button.save-need');
        await p.waitForSelector('#center .need-error');
        assert.equal(await p.textContent('#center .need-error'), '저장하지 않았습니다: 공통 조건 파일 needs/member-account.json 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다. 바뀐 파일을 새로 읽거나, 지금 적은 내용으로 덮어쓸 수 있습니다.');
        assert.deepEqual(await p.locator('#center .need-edit .fields-acts button').allTextContents(), ['새로 읽기', '덮어쓰기', '취소']);
        assert.deepEqual(errors.splice(0), ['Failed to load resource: the server responded with a status of 409 (Conflict)']);
        await p.click('#center button.reread-need');
        assert.equal(await p.inputValue('#need-text'), '다른 곳에서 고쳤다');
        assert.deepEqual(await p.locator('#center .need-edit .fields-acts button').allTextContents(), ['저장', '취소']);

        await p.fill('#need-text', '역할 USER 계정');
        fs.writeFileSync(file, JSON.stringify({ name: '회원 계정', text: '또 다른 곳에서 고쳤다' }));
        await p.waitForSelector('#center .memo:has-text("또 다른 곳에서 고쳤다")');
        await p.click('#center button.save-need');
        await p.waitForSelector('#center button.overwrite-need');
        assert.deepEqual(errors.splice(0), ['Failed to load resource: the server responded with a status of 409 (Conflict)']);
        await p.click('#center button.overwrite-need');
        await p.waitForSelector('#center .need-saved');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { name: '회원 계정', text: '역할 USER 계정' });
      }),
    );
  });
});

test('in a browser, a need file deleted or made unreadable elsewhere while its editor is open closes the editor with a notice that what was typed was not saved, and nothing is written', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) => {
    const needs = path.join(config.storiesDir, 'needs');
    fs.mkdirSync(needs);
    fs.writeFileSync(path.join(needs, 'member-account.json'), JSON.stringify({ name: '일반 회원 계정', text: '역할 USER 로 가입한 계정' }));
    fs.writeFileSync(path.join(needs, 'done-document.json'), JSON.stringify({ name: '완료된 문서 하나', text: '서명이 끝난 문서가 하나 있다' }));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#need-list li:has-text("일반 회원 계정")');
        await p.click('#center button.edit-need');
        await p.fill('#need-name', '회원 계정');
        fs.rmSync(path.join(needs, 'member-account.json'));
        await p.waitForSelector('#right .story-error');
        assert.equal(await p.textContent('#right .story-error'), '공통 조건 파일 needs/member-account.json 이 없어져 고치던 칸을 닫았습니다. 적던 이름과 내용은 저장하지 않았습니다.');
        assert.equal(await p.locator('#need-name').count(), 0);
        assert.equal(await p.locator('#need-list li.selected').count(), 0);
        assert.ok(!fs.existsSync(path.join(needs, 'member-account.json')));

        await p.click('#need-list li:has-text("완료된 문서 하나")');
        assert.equal(await p.locator('#right .story-error').count(), 0);
        await p.click('#center button.edit-need');
        await p.fill('#need-text', '서명이 끝난 문서가 두 개 있다');
        fs.writeFileSync(path.join(needs, 'done-document.json'), '{');
        await p.waitForSelector('#right .story-error');
        assert.equal(await p.textContent('#right .story-error'), '공통 조건 파일 needs/done-document.json 을 읽지 못하게 되어 고치던 칸을 닫았습니다. 적던 이름과 내용은 저장하지 않았습니다.');
        assert.equal(fs.readFileSync(path.join(needs, 'done-document.json'), 'utf8'), '{');

        await p.click('#story-list li:has-text("실험실을 열어 결과를 본다")');
        fs.writeFileSync(path.join(needs, 'admin-account.json'), JSON.stringify({ name: '관리자 계정', text: '역할 ADMIN 계정' }));
        await p.waitForSelector('#need-list li:has-text("관리자 계정")');
        assert.equal(await p.locator('#right .story-error').count(), 0, 'the notice does not come back once another place is chosen');
      }),
    );
  });
});
