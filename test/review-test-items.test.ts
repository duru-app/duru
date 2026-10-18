import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { addJudgment, loadJudgments } from '../src/judgments.ts';
import { withRebuiltFixture, withServer, browserMissing, toList, withPage, untaggedTab, waitCallInfoInView, screenBox, statusLine, chooseScreen, TRACED, asked, why, excludeIn, DOCUMENT_TABLE, bulk, judgedBy, DETAIL_CALL, closeCallInfo } from './review-helpers.ts';
import type { PageData } from './review-helpers.ts';

const callInfoContentTop = (p: Page) => p.locator('#center').evaluate((pane) => {
  const summary = pane.querySelector('.call-info > summary')!;
  return { top: summary.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop, height: pane.clientHeight };
});

test('in a browser, a screen shows the unit tests that import its source files apart from its own tests', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const help = p.locator('#screen-list li:has-text("/help")');
        assert.equal(await help.locator('.importer-count').textContent(), '불러옴 2');
        assert.deepEqual(await p.locator('#screen-list li:has-text("/document/:id") .count').allTextContents(), ['테스트 11', '불러옴 1']);

        await help.click();
        const ownCount = (await p.textContent('#center tbody tr:first-child td:nth-child(2)'))!;
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
        assert.deepEqual(await p.locator('#center .importers .test').allTextContents(), [
          '코드통과 renders the help text components/Help.spec.js:4불러오는 파일 components/Help.js',
          '코드통과 shows the day the help was last updated components/Help.spec.js:8불러오는 파일 components/Help.js',
        ]);
        assert.match(ownCount, /^테스트 \d+개$/);
        assert.doesNotMatch((await p.textContent('#center table'))!, /renders the help text/);

        await p.click('#screen-list li:has-text("/admin/member")');
        assert.equal(await p.locator('#center .importers').count(), 0);
      })));
});

test('in a browser, a screen shows the untagged browser tests that passed through it under its own tests, the ones that checked something first, each with what it did there, its place and its result file', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const testedBefore = (await p.textContent('#meta'))!;
        const help = p.locator('#screen-list li:has-text("/help")');
        assert.equal(await help.locator('.passed-count').textContent(), '지나감 6');
        await help.click();
        assert.equal(await p.textContent('#center .passed h2'), '지나간 테스트 6');
        assert.deepEqual(await p.locator('#center .passed .test').evaluateAll((list) => list.map((el) => el.querySelector('.chip')!.textContent)), ['확인함', '조작함', '조작함', '조작함', '조작함', '지나감']);
        const first = (await p.textContent('#center .passed .test >> nth=0'))!;
        assert.match(first, /확인함 통과 follows a link while waiting for the new address visits\.spec\.ts:\d+ · chromium결과 파일 results\/playwright-traced\/visits\.json/);
        assert.deepEqual(await p.locator('#center .passed .pair-test').first().locator('.judge-row button').allTextContents(), ['제외', '포함']);
        assert.deepEqual(await p.$$eval('#center-body > table, #center .passed, #center .importers', (list) => list.map((el) => el.className || el.localName)), ['table', 'passed', 'importers']);
        assert.match(testedBefore, /테스트 있는 화면 7/);

        await p.click('#view-flow');
        assert.equal(await statusLine(await screenBox(p, '/help#Help')), '실패 · 불러옴 2 · 지나감 6');
      })));
});

test('in a browser, a call shows the untagged browser tests that sent it apart from its own tests: their number in its row, also with the screen picked in the flow, and each of them in its details', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await chooseScreen(p, '/home');
        const row = (id: string) => p.locator('table.calls tbody tr:not(.option)', { hasText: id });
        assert.equal(await row('GET:/api/v1/document/list').locator('.sent-count').textContent(), '호출함 1');
        assert.equal(await row('POST:/api/v1/archive/document').locator('.sent-count').count(), 0);
        assert.match((await row('GET:/api/v1/document/list').locator('td.cell').first().textContent())!, /^✓1\s*$/);

        await row('GET:/api/v1/document/list').locator('td.cell').first().click();
        const headings = await p.locator('#center .call-info h2').allTextContents();
        assert.deepEqual(headings.slice(headings.indexOf('테스트 1'), headings.indexOf('테스트 1') + 2), ['테스트 1', '호출한 테스트 1']);
        assert.equal(await p.locator('#center .call-info .passed .test').count(), 1);
        assert.match((await p.textContent('#center .call-info .passed .test'))!, /^호출함 통과 lists the documents calls\.spec\.ts:\d+ · chromium결과 파일 results\/playwright-traced\/calls\.json$/);
        assert.deepEqual(await p.locator('#center .call-info .passed .judge-row button').allTextContents(), ['제외', '포함']);

        await row('POST:/api/v1/archive/document').locator('td.cell').first().click();
        assert.equal(await p.locator('#center .call-info .passed').count(), 0);

        await p.click('#view-flow');
        await (await screenBox(p, '/home#Home')).click();
        assert.equal(await row('GET:/api/v1/document/list').locator('.sent-count').textContent(), '호출함 1');
      })));
});

test('in a browser, a screen with no tests of its own that browser tests passed through is kept by 「지나간 테스트만 있음」', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          delete data.tests.nodes['/document/:id#DocumentDetail'];
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.check('#left input[name="imported-only"]');
        assert.equal(await p.locator('#screen-list li').count(), 1);
        assert.equal(await p.locator('#screen-list li:has-text("/document/:id")').count(), 1);
      })));
});
const DETAIL_TEST = { source: 'results/vitest/client-unit.json', file: 'components/DocumentDetail.spec.js', title: 'loads the detail screen only when it is needed' };

test('the data carries the untagged tests with the reference a judgment points at them by', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const { tests }: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.equal(tests.untaggedCount, 13);
      assert.equal(tests.untagged!.length, 13);
      assert.deepEqual(tests.untagged!.find((t) => t.title === DOCUMENT_TABLE.title)!.ref, DOCUMENT_TABLE);
    }),
  );
});

test('in a browser, the untagged tab lists every untagged test and a search box narrows the list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent(untaggedTab), '태그 없음 13');
        await p.click(untaggedTab);
        assert.equal(await p.locator('#untagged-list li').count(), 13);
        const detail = p.locator('#untagged-list li', { hasText: 'loads the detail screen only when it is needed' });
        assert.equal(await detail.textContent(), '통과loads the detail screen only when it is needed components/DocumentDetail.spec.js:1');
        assert.match((await p.textContent('#untagged-list li:has-text("DocumentTable")'))!, /^실패/);
        await p.fill('#left input[type=search]', 'help');
        assert.deepEqual(await p.locator('#untagged-list li .title').allTextContents(), ['renders the help text', 'shows the day the help was last updated']);
        await p.fill('#left input[type=search]', 'nothing like this');
        assert.equal(await p.textContent('#untagged-list'), '해당하는 테스트가 없습니다.');
      })));
});

test('in a browser, a chosen untagged test shows the screens it imports with the files it came through, and a click on a screen opens it in the screen list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.equal(await p.textContent('#center h3'), 'DocumentTable › lists the documents it is given');
        assert.equal(await p.locator('#untagged-list li.selected').count(), 1);
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면·호출의 짝 2');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.deepEqual(await pairs.locator('.screen-path').allTextContents(), ['/document/:tab(draft|done)', '/home']);
        assert.deepEqual(await pairs.locator('.via').allTextContents(), ['components/DocumentTable.js', 'components/DocumentTable.js']);
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['불러옴', '불러옴']);
        assert.equal(await p.locator('#center .pair button').count(), 0);

        await pairs.filter({ hasText: '/home' }).click();
        assert.equal(await p.getAttribute('#left .views.side button.on', 'class'), 'on');
        assert.equal(await p.textContent('#left .views.side button.on'), '화면 11');
        assert.equal(await p.textContent('#screen-list li.selected .name'), '/home Home');
      })));
});

test('in a browser, a discarded pair and a handed-over pair show their state under the untagged test', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: '/home#Home', kind: 'discard', reason: 'only lists documents', author: 'reviewer' });
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: '/document/:tab#DocumentList', kind: 'hand-over', reason: 'covers the list', author: 'reviewer' });
        await p.reload();
        await toList(p);
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.deepEqual(await pairs.locator('.screen-path').allTextContents(), ['/document/:tab(draft|done)', '/home']);
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['태그 대기', '제외한 짝']);
        assert.match((await pairs.nth(0).textContent())!, /covers the list · \d/s);
        assert.match((await pairs.nth(1).textContent())!, /only lists documents · \d/s);
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면·호출의 짝 2');
      })));
});

test('in a browser, an untagged test whose imports were read and matched no screen says so', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("formats a date as year-month-day")');
        assert.equal(await p.locator('#center .pair').count(), 0);
        assert.equal(await p.textContent('#center .no-screens'), '이 테스트가 불러오는 파일로 이어진 화면이 없습니다. 화면 넷 이상이 함께 쓰는 파일과 찾지 못한 파일로는 잇지 않습니다.');
      })));
});

test('in a browser, an untagged test whose imports were not read says why instead of claiming it imports nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        const say = async (title: string) => {
          await p.click(`#untagged-list li:has-text("${title}")`);
          assert.equal(await p.locator('#center .pair').count(), 0);
          return p.textContent('#center .no-screens');
        };
        assert.equal(await say('Document service › sends the share mail'), '이 결과 형식(junit)에는 테스트가 불러오는 파일이 적혀 있지 않아, 어느 화면에 이어지는지 읽지 못했습니다.');
        assert.equal(await say('loads without errors'), '이 테스트는 trace 파일 없이 돌아, 어느 화면을 열고 어느 호출을 보냈는지 알 수 없습니다. Playwright 의 trace 옵션을 켜고 다시 돌리면 보입니다.');
        assert.equal(await say('cleanup'), '이 결과 형식(verdict)에는 테스트가 불러오는 파일이 적혀 있지 않아, 어느 화면에 이어지는지 읽지 못했습니다.');
        assert.equal(await say('keeps the old menu'), '테스트가 불러오는 파일을 읽지 못했습니다. 테스트 파일을 소스 폴더에서 찾지 못했습니다.');
      })));
});

test('in a browser, a tests.json without the untagged list shows the count and asks for a rebuild instead of saying there are no untagged tests', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          delete data.tests.untagged;
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent(untaggedTab), '태그 없음 13');
        await p.click(untaggedTab);
        assert.match((await p.textContent('#center-body'))!, /태그 없는 테스트 목록이 없습니다.*duru rebuild/s);
        assert.doesNotMatch((await p.textContent('#center-body'))!, /태그 없는 테스트가 없습니다/);
        assert.equal(await p.locator('#untagged-list li:not(.muted)').count(), 0);
        assert.doesNotMatch((await p.textContent('#untagged-list'))!, /해당하는 테스트가 없습니다/);
      })));
});

test('in a browser, a pair for a screen that is no longer on the map shows as an off-map item that cannot be opened', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data: PageData = await res.json();
          data.map.screens = data.map.screens.filter((s) => s.id !== '/home#Home');
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.equal(await pairs.count(), 2);
        const off = pairs.filter({ hasText: '/home#Home' });
        assert.equal(await off.count(), 1);
        assert.match((await off.getAttribute('class'))!, /off-map/);
        assert.doesNotMatch((await off.getAttribute('class'))!, /on-map/);
        assert.equal(await off.getAttribute('title'), null);
        assert.match((await off.textContent())!, /맵에 없음/);
        assert.match((await off.textContent())!, /components\/DocumentTable\.js/);
        assert.match((await pairs.filter({ hasText: '/document/:tab' }).getAttribute('class'))!, /on-map/);
        await off.click();
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.textContent('#center h3'), 'DocumentTable › lists the documents it is given');
      })));
});

test('in a browser, a hand-over of a test that no longer imports the screen shows under the test as 떨어져 나감, as it does under the screen', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const format = { source: 'results/vitest/client-unit.json', file: 'components/formatDate.spec.js', title: 'formats a date as year-month-day' };
    addJudgment(config.judgmentsDir, { test: format, node: '/help#Help', kind: 'hand-over', reason: 'was about the help date', author: 'someone' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .detached h2'), '떨어져 나감 1');

        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("formats a date as year-month-day")');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.equal(await pairs.count(), 1);
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면·호출의 짝 1');
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['떨어져 나감']);
        assert.equal(await pairs.locator('.screen-path').textContent(), '/help');
        assert.match((await pairs.textContent())!, /메모 was about the help date.*someone/s);
        assert.equal(await pairs.locator('.via').count(), 0);
        assert.equal(await p.locator('#center .no-screens').count(), 0);
      }));
  });
});

test('in a browser, the imported-only filter keeps the screens with importing tests and no tagged test, counts a pair waiting for a tag and ignores a discarded one', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        addJudgment(config.judgmentsDir, { test: DETAIL_TEST, node: '/document/:id#DocumentDetail', kind: 'discard', reason: 'only loads a view', author: 'reviewer' });
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: '/document/:tab#DocumentList', kind: 'hand-over', reason: '', author: 'reviewer' });
        const bare = ['/help#Help', '/document/:id#DocumentDetail', '/document/:tab#DocumentList'];
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          for (const id of bare) delete data.tests.nodes[id];
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.locator('#screen-list li').count(), 11);
        assert.equal(await p.locator('#left .filters label:has-text("지나간 테스트만 있음")').count(), 1);
        await p.check('#left input[name="imported-only"]');
        assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/document/:tab(draft|done)', '/help']);
        const counts = async (path: string) => (await p.locator('#screen-list li', { hasText: path }).locator('.count').allTextContents()).join('');
        assert.equal(await counts('/document/:tab'), '테스트 없음태그 대기 1');
        assert.equal(await counts('/help'), '테스트 없음불러옴 2');
        await p.uncheck('#left input[name="imported-only"]');
        assert.equal(await p.locator('#screen-list li').count(), 11);
      })));
});


test('in a browser, a browser test that passed through a screen is included with one press and waits for its tag, one excluded with a reason moves to the excluded pairs, and each comes back when undone', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const help = p.locator('#screen-list li:has-text("/help")');
        await help.click();
        const row = (title: string) => p.locator('#center .passed .pair-test', { hasText: title });
        await row('opens home and then help').locator('button.hand-over').click();
        await p.waitForSelector('#center .awaiting-tag');
        assert.equal(await p.textContent('#center .passed h2'), '지나간 테스트 5');
        assert.equal(await help.locator('.passed-count').textContent(), '지나감 5');
        assert.equal(await help.locator('.awaiting-count').textContent(), '태그 대기 1');
        assert.match((await p.textContent('#center .awaiting-tag .pair-test'))!, /^지나감 통과 opens home and then help visits\.spec\.ts:\d+ · chromium/);

        await excludeIn(row('hovers and uses the keyboard on help'), 'only hovers');
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.textContent('#center .passed h2'), '지나간 테스트 4');
        assert.match((await p.textContent('#center .discarded .pair-test'))!, /^조작함 통과 hovers and uses the keyboard on help.*only hovers · \d/s);
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => [j.test.source, j.test.file, j.test.title, j.node, j.kind, j.author]).sort(), [
          ['results/playwright-traced/visits.json', 'visits.spec.ts', 'hovers and uses the keyboard on help', '/help#Help', 'discard', 'reviewer'],
          ['results/playwright-traced/visits.json', 'visits.spec.ts', 'opens home and then help', '/help#Help', 'hand-over', 'reviewer'],
        ]);

        await p.click('#view-flow');
        assert.match(await statusLine(await screenBox(p, '/help#Help')), /지나감 4$/);
        await p.click('#view-list');

        await p.click('#center .awaiting-tag button.undo');
        await p.waitForSelector('#center .awaiting-tag', { state: 'detached' });
        await p.click('#center .discarded button.undo');
        await p.waitForSelector('#center .discarded', { state: 'detached' });
        assert.equal(await p.textContent('#center .passed h2'), '지나간 테스트 6');
        assert.equal(await help.locator('.awaiting-count').count(), 0);
      })));
});

const LIST_CALL = 'GET:/api/v1/document/list';

test('in a browser, the buttons that judge a pair sit at the right end of the row of its test, for a screen and in the call info, and so does the button that undoes a judgment', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const boxes = (group: string, control: string) => p.locator(`#center ${group} .pair-test`).first().evaluate((row, selector) => {
          const box = (el: Element) => el.getBoundingClientRect();
          const [whole, test, buttons] = [row, row.querySelector('.test')!, row.querySelector(selector)!].map(box);
          return { gapOnRight: whole.right - buttons.right, sameLine: Math.abs(buttons.top - test.top) < 4, afterTest: buttons.left >= test.right };
        }, control);
        assert.deepEqual(await boxes('.passed', '.judge-row'), { gapOnRight: 0, sameLine: true, afterTest: true });
        assert.deepEqual(await boxes('.importers', '.judge-row'), { gapOnRight: 0, sameLine: true, afterTest: true });
        await p.locator('#center .passed .pair-test').first().locator('button.hand-over').click();
        await p.waitForSelector('#center .awaiting-tag');
        assert.deepEqual(await boxes('.awaiting-tag', 'button.undo'), { gapOnRight: 0, sameLine: true, afterTest: true });

        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls tr', { hasText: 'GET:/api/v1/document/{documentId}' }).first().click();
        await p.waitForSelector('#center .call-info .pair-test .judge-row');
        assert.deepEqual(await boxes('.call-info', '.judge-row'), { gapOnRight: 0, sameLine: true, afterTest: true });
        await p.locator('#center .call-info .pair-test button.hand-over').first().click();
        await p.waitForSelector('#center .call-info .awaiting-tag button.undo');
        assert.deepEqual(await boxes('.call-info .awaiting-tag', 'button.undo'), { gapOnRight: 0, sameLine: true, afterTest: true });
      })));
});

test('in a browser, a browser test that sent a call is excluded and included in the details of the call, and the window asking why names the call', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await chooseScreen(p, '/home');
        const callRow = p.locator('table.calls tbody tr:not(.option)', { hasText: LIST_CALL });
        await callRow.locator('td.cell').first().click();
        const sent = p.locator('#center .call-info .passed .pair-test', { hasText: 'lists the documents' });
        assert.deepEqual(await sent.locator('.judge-row button').allTextContents(), ['제외', '포함']);
        assert.match((await sent.locator('button.discard').getAttribute('title'))!, /^이 테스트와 이 호출의 짝/);

        await sent.locator('button.discard').click();
        assert.match((await p.textContent(`${asked} .subject`))!, /테스트lists the documents.*calls\.spec\.ts.*호출GET:\/api\/v1\/document\/list$/s);
        await p.fill(why, 'only loads the page');
        await p.click(`${asked} button.discard`);
        await p.waitForSelector('#center .call-info .discarded');
        assert.equal(await p.locator('#center .call-info .passed').count(), 0);
        assert.equal(await callRow.locator('.sent-count').count(), 0);
        assert.match((await p.textContent('#center .call-info .discarded .pair-test'))!, /^호출함 통과 lists the documents.*only loads the page · \d/s);
        assert.deepEqual(judgedBy(config), [[LIST_CALL, 'discard', 'only loads the page', 'reviewer']]);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await p.click('#center .call-info .discarded button.undo');
        await p.waitForSelector('#center .call-info .discarded', { state: 'detached' });
        assert.equal(await callRow.locator('.sent-count').textContent(), '호출함 1');
        await p.click('#center .call-info .passed .pair-test button.hand-over');
        await p.waitForSelector('#center .call-info .awaiting-tag');
        assert.equal(await p.textContent('#center .call-info .awaiting-tag h2'), '태그 대기 1');
        assert.equal(await p.locator('#center .call-info .passed').count(), 0);
        assert.match(await p.locator('#center .call-info .target-id').innerText(), /GET:\/api\/v1\/document\/list\s+호출 전체/);
      })));
});

test('in a browser, a chosen untagged browser test shows the screens it opened and the calls it sent as pairs, judges them in one go, and a click on a call pair opens the call on a screen that sends it', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("reads a document from the server")');
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면·호출의 짝 2');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['지나감', '호출함']);
        assert.match((await pairs.nth(0).textContent())!, /^\/home Home/);
        assert.match((await pairs.nth(1).textContent())!, /^GET:\/api\/v1\/document\/\{documentId\}/);
        assert.equal(await p.locator('#center .unmatched').count(), 0);

        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        assert.equal(await p.textContent(`${asked} h2`), '짝 2개를 제외합니다');
        assert.match((await p.textContent(`${asked} .subject`))!, /화면과 호출\/home Home.*GET:\/api\/v1\/document\/\{documentId\}$/s);
        await p.click(`${asked} button.cancel`);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.deepEqual(judgedBy(config), [
          ['/home#Home', 'hand-over', '', 'reviewer'],
          [DETAIL_CALL, 'hand-over', '', 'reviewer'],
        ]);

        await pairs.nth(1).click();
        assert.equal(await p.textContent('#screen-list li.selected .name'), '/document/:id DocumentDetail');
        assert.match(await p.locator('#center .call-info .target-id').innerText(), /GET:\/api\/v1\/document\/\{documentId\}\s+호출 전체/);
        assert.match((await p.textContent('#center .call-info .awaiting-tag'))!, /reads a document from the server/);
      })));
});

test('in a browser, a call reached from another tab opens its details even when they were closed on that same call, and the middle pane scrolls to them', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const details = p.locator('#center .call-info');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls tr', { hasText: DETAIL_CALL }).first().locator('td.cell').first().click();
        await closeCallInfo(p);
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), false);

        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("reads a document from the server")');
        await p.setViewportSize({ width: 1440, height: 400 });
        await p.locator('#center').evaluate((e) => { e.scrollTop = 0; });
        await p.locator('#center .test-pairs .pair').nth(1).click();
        assert.match(await details.locator('.target-id').innerText(), /GET:\/api\/v1\/document\/\{documentId\}\s+호출 전체/);
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), true);
        const placed = await callInfoContentTop(p);
        assert.ok(placed.top > placed.height, `the call info starts at ${placed.top}px, below the ${placed.height}px the pane shows unscrolled`);
        await waitCallInfoInView(p);
        assert.ok((await p.locator('#center').evaluate((e) => e.scrollTop)) > 0);
      })));
});

test('in a browser, an untagged browser test lists the addresses it opened that fit no screen, and one with no pairs says whether its trace was read, could not be read or was never written', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        const said = async (title: string) => {
          await p.click(`#untagged-list li:has-text("${title}")`);
          return p.textContent('#center .no-screens');
        };
        assert.equal(await said('wanders off the map'), '이 테스트는 도는 동안 맵에 있는 화면을 열지도, 맵에 있는 호출을 보내지도 않았습니다.');
        assert.equal(await p.textContent('#center .unmatched h2'), '맵에 맞는 화면이 없는 주소 1');
        assert.deepEqual(await p.locator('#center .unmatched li').allTextContents(), ['http://127.0.0.1:4598/nowhere']);

        assert.equal(await said('opens help without a trace'), '이 테스트는 trace 파일 없이 돌아, 어느 화면을 열고 어느 호출을 보냈는지 알 수 없습니다. Playwright 의 trace 옵션을 켜고 다시 돌리면 보입니다.');
        assert.equal(await p.locator('#center .unmatched').count(), 0);
        assert.equal(await said('presses the button without snapshots'), '이 테스트의 trace 파일을 읽지 못해, 어느 화면을 열고 어느 호출을 보냈는지 알 수 없습니다. trace 파일에 화면 스냅숏이 없어 테스트가 연 주소를 알 수 없습니다.');

        await p.click('#untagged-list li:has-text("opens home and then help")');
        assert.deepEqual(await p.locator('#center .test-pairs .pair .pair-state').allTextContents(), ['지나감', '지나감']);
        assert.equal(await p.locator('#center .no-screens').count(), 0);
        assert.equal(await p.locator('#center .unmatched').count(), 0);
      })));
});

test('in a browser, a browser test handed over for a screen goes on waiting for its tag when its latest run left no trace, marked as not confirmed this time', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const untraced = { source: 'results/playwright-traced/visits.json', file: 'untraced.spec.ts', title: 'opens help without a trace' };
        addJudgment(config.judgmentsDir, { test: untraced, node: '/help#Help', kind: 'hand-over', reason: '', author: 'reviewer' });
        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .awaiting-tag h2'), '태그 대기 1');
        assert.match((await p.textContent('#center .awaiting-tag .pair-test'))!, /^확인 못 함 통과 opens help without a trace untraced\.spec\.ts:5결과 파일 results\/playwright-traced\/visits\.json/);
        assert.equal(await p.locator('#center .detached').count(), 0);
        await p.click('#center .awaiting-tag button.undo');
        await p.waitForSelector('#center .awaiting-tag', { state: 'detached' });
        assert.equal(await p.locator('#center .detached').count(), 0);
      })));
});

test('in a browser, a skipped browser test with no pairs says that it did not run, not that it ran without a trace', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data: PageData = await res.json();
          data.tests.untagged!.find((t) => t.title.startsWith('loads without errors'))!.status = 'pending';
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("loads without errors")');
        assert.equal(await p.textContent('#center .no-screens'), '이 테스트는 건너뛰어 돌지 않았으므로, 어느 화면을 열고 어느 호출을 보내는지 알 수 없습니다.');
      })));
});

test('in a browser, a test row shows the title without its tags, and without a part of it that held only tags, hides the tags of the screen, call, story and depth it sits under, and shows each other tag, from the title or the tag option, as a label of its own; a tests.json without tags reads them from the title', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const row = async (selector: string, hasText: string) => {
          const item = p.locator(`${selector} .test`, { hasText }).first();
          return { text: (await item.evaluate((e) => [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim())), tags: await item.locator('.test-tag').allTextContents() };
        };
        await chooseScreen(p, '/lab');
        assert.deepEqual(await row('#center-body table .part-row', 'opens the lab'), { text: 'opens the lab', tags: ['smoke', 'screen:/home#Home', 'role:ADMIN'] });
        await chooseScreen(p, '/home');
        assert.deepEqual(await row('#center-body table .part-row', 'opens the lab'), { text: 'opens the lab', tags: ['screen:/lab#Lab', 'smoke', 'role:ADMIN'] });
        await chooseScreen(p, '/admin/member');
        assert.deepEqual(await row('#center-body table .part-row', 'lists members for an admin'), { text: 'lists members for an admin', tags: ['role:ADMIN'] });
        await chooseScreen(p, '/admin/report');
        await p.locator('table.calls td.cell').first().click();
        assert.deepEqual(await row('#center .call-info .part-row', 'exports with history'), { text: 'exports with history', tags: ['option:withHistory=true'] });

        await p.click('#view-story');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await row('#center .story-tests', 'runs the lab'), { text: 'Lab flow › runs the lab and reads the result', tags: ['role:ADMIN'] });

        const testsFile = path.join(config.outDir, 'tests.json');
        const tests = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
        for (const list of Object.values(tests.nodes) as { tags?: string[] }[][]) for (const t of list) delete t.tags;
        fs.writeFileSync(testsFile, JSON.stringify(tests));
        await p.reload();
        await p.click('#view-list');
        await chooseScreen(p, '/lab');
        assert.deepEqual(await row('#center-body table .part-row', 'opens the lab'), { text: 'opens the lab', tags: ['smoke', 'screen:/home#Home', 'role:ADMIN'] });
        await chooseScreen(p, '/admin/member');
        assert.deepEqual(await row('#center-body table .part-row', 'lists members for an admin'), { text: 'lists members for an admin', tags: [] });
      })), [
    ['results/playwright/e2e.json', '"title": "opens the lab @screen:/lab#Lab"', '"title": "@smoke › opens the lab @screen:/lab#Lab @depth:ui @screen:/home#Home @role:ADMIN"'],
    ['results/junit/services.xml', 'runs the lab and reads the result @story:run-lab"', 'runs the lab and reads the result @story:run-lab @depth:api @role:ADMIN"'],
  ]);
});
