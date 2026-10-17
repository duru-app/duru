import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { withRebuiltFixture, withServer, browserMissing, withPage, screenBox, boxCount, lineSteps, pathMarks, pillMarks, pathEdges, untilSet, placeOf, postJson, CANDIDATES, storiesTab, holdRequests, WALK, WALK_ON_MAP, withPathStories, textOutside } from './review-helpers.ts';
import type { Story, PageData } from './review-helpers.ts';

declare const state: any;
declare function canvas(roots: object[], options: object): { el: HTMLElement; measureWidths(): void; fit(width: number): void; measureHeights(): void; place(): void };
declare function flowInnerWidth(flow: HTMLElement): number;

const HELP_PATH = ['/signin#SignIn', '/home#Home', '/help#Help'];

test('a screen order sent for checking comes back judged like a story, and one that is empty, not a list or off the map is refused', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const res = await postJson(base, '/api/stories/check', { screens: HELP_PATH });
      assert.equal(res.status, 200);
      const checked: Story = await res.json();
      assert.deepEqual([checked.screens, checked.links.map((l) => l.verdict), checked.broken, checked.detached], [HELP_PATH, ['open', 'broken'], true, false]);
      for (const screens of [[], 'x', undefined, ['/home#Home', 3]]) assert.equal((await postJson(base, '/api/stories/check', { screens })).status, 400);
      const offMap = await postJson(base, '/api/stories/check', { screens: ['/home#Home', '/gone#Gone'] });
      assert.deepEqual([offMap.status, await offMap.text()], [400, '맵에 없는 화면입니다: /gone#Gone']);
      const notJson = await fetch(`${base}/api/stories/check`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(notJson.status, 415);
      assert.equal(fs.existsSync(config.storiesDir), false);
    }),
  );
});

test('a new story posted from the page is written with its screens, name, memo and the server-side author, and is refused when its ID is taken or breaks the rule, a screen repeats or a screen is off the map', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const res = await postJson(base, '/api/stories/add', { id: 'help-from-signin', name: ' 로그인해 도움말을 연다 ', memo: '홈에 링크가 없다.', screens: HELP_PATH, author: 'someone else' });
      assert.equal(res.status, 201);
      const { date, ...saved } = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'help-from-signin.json'), 'utf8'));
      assert.deepEqual(saved, { name: '로그인해 도움말을 연다', screens: HELP_PATH, memo: '홈에 링크가 없다.', author: 'reviewer' });
      assert.match(date, /^\d{4}-\d{2}-\d{2}T/);
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.stories.list.map((st) => [st.id, st.broken]), [['help-from-signin', true]]);

      const refused = async (body: object, why: RegExp) => {
        const r = await postJson(base, '/api/stories/add', { id: 'another', name: 'x', screens: ['/home#Home'], ...body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(await r.text(), why);
      };
      await refused({ id: 'help-from-signin' }, /help-from-signin\.json 이 이미 씁니다/);
      await refused({ id: 'Help From Signin' }, /스토리 ID 는/);
      await refused({ name: ' ' }, /스토리 이름이 필요합니다/);
      await refused({ memo: 3 }, /memo 는 글자여야 합니다/);
      await refused({ screens: ['/home#Home', '/home#Home'] }, /같은 화면입니다/);
      await refused({ screens: ['/gone#Gone'] }, /맵에 없는 화면입니다/);
      assert.deepEqual(fs.readdirSync(config.storiesDir), ['help-from-signin.json']);
      assert.equal((await postJson(base, '/api/stories/add', { id: 'no-memo', name: 'x', screens: ['/home#Home'] })).status, 201);
      assert.equal(JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'no-memo.json'), 'utf8')).memo, '');
    }),
  );
});

const pickScreen = (p: Page, routePath: string) => p.locator('#pick-list li').filter({ has: p.locator('.name > span:first-child', { hasText: new RegExp(`^${routePath}$`) }) }).click();
const composeSteps = (p: Page) => p.locator('#center .compose-step .screen-path').allTextContents();
const composeLinks = (p: Page) => p.locator('#center .story-path .link .link-verdict').allTextContents();
const untilJudged = (p: Page, links: number) => p.waitForFunction((n) => document.querySelectorAll('#center .story-path .link .link-verdict').length === n && !document.querySelector('#center .link.l-pending'), links);
const stepButton = (step: number, cls: string) => `#center .compose-step[data-step="${step}"] button.${cls}`;
const focusedStepButton = (p: Page) => p.evaluate(() => [document.activeElement!.closest<HTMLElement>('.compose-step')?.dataset.step, document.activeElement!.className]);

async function startNewStory(p: Page) {
  await p.waitForSelector('#screen-list li');
  await p.click(storiesTab);
  await p.click('#left button.new-story');
  await p.waitForSelector('#pick-list li');
}

test('in a browser, 「새 스토리」 turns the left column into a screen picker, each screen pressed becomes the next step with the link from the step before judged at once, and saving writes the story file and shows the new story', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await startNewStory(p);
        assert.equal(await p.locator('#pick-list li').count(), 11);
        assert.equal(await p.textContent('#center h3'), '새 스토리');
        assert.equal(await p.textContent('#center .no-steps'), '아직 넣은 화면이 없습니다.');
        assert.equal(await p.isDisabled('#right button.save-compose'), true);
        assert.equal(await p.locator('#right-dock').isVisible(), false);

        await pickScreen(p, '/signin');
        await pickScreen(p, '/home');
        await pickScreen(p, '/help');
        await untilJudged(p, 2);
        assert.deepEqual(await composeSteps(p), ['/signin', '/home', '/help']);
        assert.deepEqual(await composeLinks(p), ['이어짐', '링크 없음']);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 불가 · 링크 없음 1곳']);
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['링크 없음']);
        assert.deepEqual(await p.locator('#pick-list li .count').allTextContents(), ['넣음 1', '넣음 1', '넣음 1']);

        await p.fill('#compose-id', 'Help From Signin');
        assert.equal(await p.isVisible('label:has(#compose-id) .invalid'), true);
        await p.fill('#compose-id', 'help-from-signin');
        assert.equal(await p.isVisible('label:has(#compose-id) .invalid'), false);
        assert.equal(await p.isDisabled('#right button.save-compose'), true);
        await p.fill('#compose-name', '로그인해 도움말을 연다');
        await p.fill('#compose-memo', '홈에 링크가 없다.');
        assert.equal(await p.isDisabled('#right button.save-compose'), false);
        await p.click('#right button.save-compose');
        await p.waitForSelector('#story-list li.selected:has-text("로그인해 도움말을 연다")');

        const { date, ...saved } = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'help-from-signin.json'), 'utf8'));
        assert.deepEqual(saved, { name: '로그인해 도움말을 연다', screens: HELP_PATH, memo: '홈에 링크가 없다.', author: 'reviewer' });
        assert.equal(await p.textContent('#center h3'), '로그인해 도움말을 연다');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['이어짐', '링크 없음']);
        assert.equal(await p.textContent('#left button.new-story'), '새 스토리');
        assert.equal(await p.locator('#pick-list').count(), 0);
      }),
    ),
  );
});

test('in a browser, moving a step of a new story with 「위로」 or 「아래로」 judges the links again at once and keeps the focus on the moved step, a step goes in before another or comes out, and the same screen twice in a row is refused', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await startNewStory(p);
        await pickScreen(p, '/signin');
        await pickScreen(p, '/home');
        await untilJudged(p, 1);
        assert.deepEqual([await composeLinks(p), await p.locator('#right .verdict').allTextContents()], [['이어짐'], ['도달 가능']]);
        assert.deepEqual([await p.isDisabled(stepButton(0, 'up')), await p.isDisabled(stepButton(1, 'down'))], [true, true]);

        await p.click(stepButton(0, 'down'));
        await p.waitForFunction(() => document.querySelector('#center .story-path .link .link-verdict')?.textContent === '링크 없음');
        assert.deepEqual(await composeSteps(p), ['/home', '/signin']);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 불가 · 링크 없음 1곳']);
        assert.deepEqual(await focusedStepButton(p), ['1', 'up']);
        await p.keyboard.press('Enter');
        await p.waitForFunction(() => document.querySelector('#center .story-path .link .link-verdict')?.textContent === '이어짐');
        assert.deepEqual(await composeSteps(p), ['/signin', '/home']);
        assert.deepEqual(await focusedStepButton(p), ['0', 'down']);

        await pickScreen(p, '/home');
        assert.equal(await p.textContent('#center .compose-error'), '같은 화면을 이어서 넣을 수 없습니다.');
        assert.deepEqual(await composeSteps(p), ['/signin', '/home']);

        await p.click(stepButton(1, 'insert-before'));
        assert.match((await p.textContent('#center .insert-mark'))!, /^다음에 고르는 화면이 여기 들어갑니다/);
        await pickScreen(p, '/help');
        await pickScreen(p, '/lab');
        await untilJudged(p, 3);
        assert.deepEqual(await composeSteps(p), ['/signin', '/help', '/lab', '/home']);
        assert.equal(await p.locator('#center .compose-error').count(), 0);
        await p.click('#center .insert-mark button.insert-at-end');
        assert.equal(await p.locator('#center .insert-mark').count(), 0);

        await p.click(stepButton(1, 'remove'));
        await untilJudged(p, 2);
        assert.deepEqual(await composeSteps(p), ['/signin', '/lab', '/home']);
        assert.deepEqual(await p.locator('#pick-list li .count').allTextContents(), ['넣음 1', '넣음 1', '넣음 1']);
      }),
    ),
  );
});

test('in a browser, a step of a new story is dragged onto another step to take its place, something else dropped on a step moves nothing, and the name being typed is left alone when a verdict arrives', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await startNewStory(p);
        for (const routePath of ['/signin', '/home', '/help']) await pickScreen(p, routePath);
        await untilJudged(p, 2);
        const name = (await p.$('#compose-name'))!;
        await p.fill('#compose-name', '끌어서 옮긴다');

        await p.evaluate(() => {
          const dropped = new DataTransfer();
          dropped.setData('text/plain', '0');
          document.querySelector('#center .compose-step[data-step="1"]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dropped, bubbles: true, cancelable: true }));
        });
        assert.deepEqual(await composeSteps(p), ['/signin', '/home', '/help']);

        await p.locator('#center .compose-step[data-step="2"]').dragTo(p.locator('#center .compose-step[data-step="0"]'));
        await p.waitForFunction(() => document.querySelector('#center .compose-step .screen-path')?.textContent === '/help');
        await untilJudged(p, 2);
        assert.deepEqual(await composeSteps(p), ['/help', '/signin', '/home']);
        assert.deepEqual(await composeLinks(p), ['링크 없음', '이어짐']);
        assert.equal(await name.evaluate((el: HTMLInputElement) => el.isConnected && el.value), '끌어서 옮긴다');
        assert.equal(await p.textContent('#center h3'), '끌어서 옮긴다');
      }),
    ),
  );
});

test('in a browser, a new story being written is a place in the address and is kept while the reviewer looks at the story list, ending the review asks about it first, and 「쓰던 것 버리기」 throws it away', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await startNewStory(p);
        assert.equal(await placeOf(p), '#story?new=1');
        await pickScreen(p, '/home');
        await p.fill('#compose-name', '쓰다 만 스토리');
        await p.click('#left button.leave-compose');
        assert.equal(await p.textContent('#left button.new-story'), '새 스토리 이어 쓰기');
        assert.match(await placeOf(p), /^#story\?story=/);
        assert.equal(await p.locator('#story-list li.selected').count(), 1);

        await p.goBack();
        await p.waitForSelector('#pick-list li');
        assert.deepEqual(await composeSteps(p), ['/home']);
        assert.equal(await p.inputValue('#compose-name'), '쓰다 만 스토리');

        let asked: string | null = null;
        p.once('dialog', (dialog) => {
          asked = dialog.message();
          dialog.dismiss();
        });
        await p.click('#end-review');
        assert.match(asked!, /^저장하지 않은 새 스토리가 있습니다/);
        assert.equal(await p.locator('#ended').count(), 0);

        await p.click('#right button.drop-draft');
        await p.waitForSelector('#story-list li');
        assert.equal(await p.textContent('#left button.new-story'), '새 스토리');
        await p.click('#left button.new-story');
        assert.equal(await p.textContent('#center .no-steps'), '아직 넣은 화면이 없습니다.');
        assert.equal(await p.inputValue('#compose-name'), '');
        assert.deepEqual(fs.readdirSync(config.storiesDir).filter((f) => f.includes('쓰다')), []);
      }),
    ),
  );
});

test('in a browser, the notice that the same screen cannot follow itself stays when a verdict asked for earlier arrives, and goes with the next change', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await startNewStory(p);
        const checks = holdRequests(p, '**/api/stories/check');
        await checks.done;
        await pickScreen(p, '/signin');
        await pickScreen(p, '/home');
        await pickScreen(p, '/home');
        assert.equal(await p.textContent('#center .compose-error'), '같은 화면을 이어서 넣을 수 없습니다.');
        assert.equal(await p.textContent('#center .link.l-pending'), '맞춰 보는 중');
        await untilSet(() => checks.sent.length === 2, 'the two checks');
        checks.release!();
        await untilJudged(p, 1);
        assert.equal(await p.textContent('#center .compose-error'), '같은 화면을 이어서 넣을 수 없습니다.');
        await pickScreen(p, '/help');
        assert.equal(await p.locator('#center .compose-error').count(), 0);
        await untilSet(() => checks.sent.length === 3, 'the third check');
        checks.release!();
        await untilJudged(p, 2);
      }),
    ),
  );
});

test('in a browser, a map built before links carried their conditions has no 「새 스토리」, also with no story file yet, and its address opens the story list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) for (const l of s.links) delete l.conditions;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    await withServer(config, 'reviewer', async (base) => {
      const refused = await postJson(base, '/api/stories/check', { screens: ['/home#Home'] });
      assert.equal(refused.status, 400);
      assert.match(await refused.text(), /스토리를 맞춰 보지 못했습니다\. duru rebuild 로 맵을 다시 만드세요$/);
      await withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.equal(await p.locator('#left button.new-story').count(), 0);
        await p.evaluate(() => { location.hash = '#stories?new=1'; });
        await p.waitForFunction(() => location.hash === '#story');
        assert.equal(await p.locator('#pick-list').count(), 0);
      });
    });
  });
});

const paneSteps = (p: Page) => p.locator('#flow-stories .compose-step .screen-path').allTextContents();
const paneLinks = (p: Page) => p.locator('#flow-stories .story-path .link .link-verdict').allTextContents();
const untilPaneJudged = (p: Page, links: number) => p.waitForFunction((n) => document.querySelectorAll('#flow-stories .story-path .link .link-verdict').length === n && !document.querySelector('#flow-stories .link.l-pending'), links);
const pressBox = async (p: Page, id: string) => (await screenBox(p, id)).click();

test('in a browser, 「새 스토리」 of the flow sits in the bar and opens a pane beside the flow, and while it is open each box pressed becomes the next step instead of opening the screen and stays where it was with the focus on it, numbered on its box over the whole flow with its links kept as drawn and the link between two neighbouring steps drawn in the style of its verdict, the same box twice in a row is refused as in the list, and 「닫기」 lets a box open its screen again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#flow .box.screen');
        const drawn = await boxCount(p);
        assert.equal(await p.isVisible('#flow-stories'), false);
        await p.click('#flow-bar button.new-story');
        assert.equal(await placeOf(p), '#flow?new=1');
        assert.equal(await p.isVisible('#flow-stories'), true);
        assert.equal(await p.locator('#flow-bar button.new-story').count(), 0);
        assert.equal(await p.textContent('#flow-stories .no-steps'), '아직 넣은 화면이 없습니다.');
        assert.match((await (await screenBox(p, '/home#Home')).getAttribute('title'))!, /\n누르면 새 스토리의 단계로 넣습니다$/);

        await pressBox(p, '/home#Home');
        await p.waitForFunction(() => document.querySelector('#flow .story-badge'));
        const member = await screenBox(p, '/admin/member#AdminMember');
        await member.focus();
        const before = (await member.boundingBox())!;
        await p.keyboard.press('Enter');
        await untilPaneJudged(p, 1);
        assert.deepEqual(await pathMarks(p, 'story-tag'), [['/admin/member#AdminMember', '조건', 'l-conditioned']], 'a mark now stands before the box');
        const after = (await (await screenBox(p, '/admin/member#AdminMember')).boundingBox())!;
        assert.deepEqual([Math.round(after.x), Math.round(after.y)], [Math.round(before.x), Math.round(before.y)]);
        assert.equal(await p.evaluate(() => (document.activeElement as HTMLElement).dataset.key), '/admin/member#AdminMember');
        for (const step of [1, 0]) await p.click(`#flow-stories .compose-step[data-step="${step}"] button.remove`);
        await p.waitForSelector('#flow-stories .no-steps');

        await pressBox(p, '/home#Home');
        await p.waitForFunction(() => document.querySelector('#flow .story-badge'));
        const held = holdRequests(p, '**/api/stories/check');
        const twice = await screenBox(p, '/admin/member#AdminMember');
        const spot = (await twice.boundingBox())!;
        await twice.click();
        await twice.click();
        assert.equal(await p.textContent('#flow-stories .compose-error'), '같은 화면을 이어서 넣을 수 없습니다.');
        await untilSet(() => held.sent.length === 1, 'the check');
        held.release!();
        await untilPaneJudged(p, 1);
        await p.unroute('**/api/stories/check');
        assert.deepEqual(await paneSteps(p), ['/home', '/admin/member']);
        const kept = (await (await screenBox(p, '/admin/member#AdminMember')).boundingBox())!;
        assert.deepEqual([Math.round(kept.x), Math.round(kept.y)], [Math.round(spot.x), Math.round(spot.y)], 'a second press on the same box keeps the place of the first');
        for (const step of [1, 0]) await p.click(`#flow-stories .compose-step[data-step="${step}"] button.remove`);
        await p.waitForSelector('#flow-stories .no-steps');

        for (const id of HELP_PATH) await pressBox(p, id);
        await untilPaneJudged(p, 2);
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);
        assert.deepEqual(await paneLinks(p), ['이어짐', '링크 없음']);
        assert.deepEqual(await p.locator('#flow-stories .verdict').allTextContents(), ['도달 불가 · 링크 없음 1곳']);
        assert.equal(await p.isVisible('#center'), false, 'no screen was opened');
        assert.equal(await boxCount(p), drawn, 'the whole flow stays drawn');
        assert.deepEqual((await pillMarks(p, 'story-badge')).sort(), [['/help#Help', '3'], ['/home#Home', '2'], ['/signin#SignIn', '1']]);
        assert.deepEqual(await pathEdges(p), [['/signin#SignIn', '/home#Home', 'l-open']]);
        assert.deepEqual(await pillMarks(p, 'story-chip'), [['/home#Home', '✕→ 3링크 없음', 'exit', 'l-broken'], ['/help#Help', '✕2 →', 'entry', 'l-broken']]);
        const look = (from: string, to: string) => p.$eval(`#flow svg path[data-from="${from}"][data-to="${to}"]`, (e) => { const c = getComputedStyle(e); return [c.strokeDasharray, c.opacity]; });
        assert.deepEqual(await look('/signin#SignIn', '/help#Help'), ['5px, 4px', '0.9'], 'a guarded link keeps its dashes');

        await pressBox(p, '/help#Help');
        assert.equal(await p.textContent('#flow-stories .compose-error'), '같은 화면을 이어서 넣을 수 없습니다.');
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);
        const scrolled = await p.$eval('#flow', (f) => { f.scrollTop = 40; f.scrollLeft = 40; return [f.scrollTop, f.scrollLeft]; });
        await p.click('#flow-stories .compose-step[data-step="2"] button.remove');
        await untilPaneJudged(p, 1);
        assert.deepEqual(await p.$eval('#flow', (f) => [f.scrollTop, f.scrollLeft]), scrolled, 'a refused press leaves no place to scroll back to');
        const pending = holdRequests(p, '**/api/stories/check');
        await pressBox(p, '/help#Help');
        await untilSet(() => pending.sent.length === 1, 'the check');
        const waiting = await p.$eval('#flow', (f) => { f.scrollTop = 20; f.scrollLeft = 20; return [f.scrollTop, f.scrollLeft]; });
        await p.click('#flow-zoom .zoom-in');
        assert.deepEqual(await p.$eval('#flow', (f) => [f.scrollTop, f.scrollLeft]), waiting, 'a redraw before the verdict leaves the scroll alone');
        await p.click('#flow-zoom .zoom-out');
        pending.release!();
        await untilPaneJudged(p, 2);
        await p.unroute('**/api/stories/check');
        const judged = await p.$eval('#flow', (f) => { f.scrollTop = 20; f.scrollLeft = 20; return [f.scrollTop, f.scrollLeft]; });
        await p.click('#flow-zoom .zoom-in');
        assert.deepEqual(await p.$eval('#flow', (f) => [f.scrollTop, f.scrollLeft]), judged, 'and so does one after it');
        await p.click('#flow-zoom .zoom-out');
        await p.click('#flow .story-chip.exit');
        await untilPaneJudged(p, 3);
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help', '/home'], 'a press on the mark inside a box adds that box');
        assert.deepEqual((await pillMarks(p, 'story-badge')).sort(), [['/help#Help', '3'], ['/home#Home', '2·4'], ['/signin#SignIn', '1']]);
        await p.click('#flow-stories .compose-step[data-step="3"] button.remove');
        await untilPaneJudged(p, 2);
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);

        await p.click('#view-story');
        await p.click('#left button.leave-compose');
        await p.click('#view-flow');
        assert.equal(await placeOf(p), '#flow');
        assert.equal(await p.isVisible('#flow-stories'), false);
        assert.equal(await p.textContent('#flow-bar button.new-story'), '새 스토리 이어 쓰기');
        assert.deepEqual(await pillMarks(p, 'story-badge'), []);
        await p.click('#flow-bar button.new-story');
        assert.equal(await p.isVisible('#flow-stories'), true, 'the pane opens again');
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);
        await p.click('#flow-stories button.leave-compose');
        await p.goBack();
        await p.waitForSelector('#flow-stories .compose-step');
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);
        await p.goForward();
        await p.waitForSelector('#flow-bar button.new-story');
        await pressBox(p, '/home#Home');
        await p.waitForSelector('#center', { state: 'visible' });
        assert.equal(await placeOf(p), '#flow?screen=/home#Home');
        assert.deepEqual(errors, []);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a new story written in the story tab goes on in the flow and back with the same steps, its name being typed is left alone when a verdict arrives, and saving it in the flow writes the same story file as the story tab does and opens the saved story in the story tab', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await startNewStory(p);
        await pickScreen(p, '/signin');
        await p.fill('#compose-name', '로그인해 도움말을 연다');
        await p.click('#view-flow');
        await p.waitForSelector('#flow-stories .compose-step');
        assert.equal(await placeOf(p), '#flow?new=1');
        assert.deepEqual(await paneSteps(p), ['/signin']);
        const name = (await p.$('#flow-stories #compose-name'))!;
        assert.equal(await name.inputValue(), '로그인해 도움말을 연다');
        await pressBox(p, '/home#Home');
        await untilPaneJudged(p, 1);
        assert.equal(await name.evaluate((el: HTMLInputElement) => el.isConnected), true);

        await p.click('#view-story');
        await untilJudged(p, 1);
        assert.equal(await placeOf(p), '#story?new=1');
        assert.deepEqual(await composeSteps(p), ['/signin', '/home']);
        await p.click('#view-flow');
        await untilPaneJudged(p, 1);
        const held = holdRequests(p, '**/api/stories/check');
        await pressBox(p, '/help#Help');
        await untilSet(() => held.sent.length === 1, 'the check');
        await p.click('#view-story');
        held.release!();
        await untilJudged(p, 2);
        await p.unroute('**/api/stories/check');
        assert.deepEqual(await composeSteps(p), ['/signin', '/home', '/help']);
        await p.click('#view-flow');
        await untilPaneJudged(p, 2);
        const scrolled = await p.$eval('#flow', (f) => { f.scrollTop = 40; f.scrollLeft = 40; return [f.scrollTop, f.scrollLeft]; });
        await p.click('#flow-stories .compose-step[data-step="2"] button.remove');
        await untilPaneJudged(p, 1);
        assert.deepEqual(await p.$eval('#flow', (f) => [f.scrollTop, f.scrollLeft]), scrolled, 'a box pressed before going to the list is not scrolled back to later');
        await pressBox(p, '/help#Help');
        await untilPaneJudged(p, 2);
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);

        await p.fill('#flow-stories #compose-id', 'help-from-signin');
        await p.fill('#flow-stories #compose-memo', '홈에 링크가 없다.');
        await p.click('#flow-stories button.save-compose');
        await p.waitForSelector('#center .story-line');
        const { date, ...saved } = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'help-from-signin.json'), 'utf8'));
        assert.deepEqual(saved, { name: '로그인해 도움말을 연다', screens: HELP_PATH, memo: '홈에 링크가 없다.', author: 'reviewer' });
        assert.equal(await placeOf(p), '#story?story=help-from-signin');
        assert.equal(await p.isVisible('#flow-stories'), false);
        assert.equal(await p.textContent('#left button.new-story'), '새 스토리');
        assert.deepEqual(await lineSteps(p), HELP_PATH.map((id, i) => [String(i + 1), id]));
        assert.deepEqual(errors, []);
      }),
    ),
  );
});

const drawOverlay = (p: Page, id: string) => p.evaluate((id) => {
  const st = state.data.stories.list.find((s: { id: string }) => s.id === id);
  const flow = document.getElementById('flow')!;
  const c = canvas(state.data.flow.roots, { group: true, story: { st } });
  flow.replaceChildren(c.el);
  c.measureWidths();
  c.fit(flowInnerWidth(flow));
  c.measureHeights();
  c.place();
}, id);

test('in a browser, a story laid over the whole flow, as while a new story is written, puts its hops from a box to its child on that link in the style of the story verdict and every other hop as chips with the other step number in both boxes, numbers a screen visited twice with both steps, and covers no box or mark', { skip: browserMissing }, async () => {
  const stories = { 'walk-around': WALK, twice: ['/signin#SignIn', '/home#Home', '/help#Help', '/home#Home'] };
  await withPathStories(stories, async (p) => {
    await drawOverlay(p, 'walk-around');
    assert.deepEqual(await pathEdges(p), [
      ['/home#Home', '/document/:tab_draft_done_#DocumentList', 'l-open'],
      ['/lab#Lab', '/lab/result#LabResult', 'l-open'],
      ['/signin#SignIn', '/home#Home', 'l-open'],
    ]);
    const stroke = (from: string, to: string) => p.$eval(`#flow svg path[data-from="${from}"][data-to="${to}"]`, (e) => { const c = getComputedStyle(e); return [c.strokeWidth, c.strokeDasharray, c.opacity]; });
    assert.deepEqual(await stroke('/signin#SignIn', '/home#Home'), ['3.2px', 'none', '1']);
    assert.deepEqual((await pillMarks(p, 'story-badge')).sort(), WALK_ON_MAP.map((id, i) => [id, String(i + 1)]).sort());
    assert.deepEqual(await pillMarks(p, 'story-chip'), [
      ['/document/:tab_draft_done_#DocumentList', '→ 4', 'exit', 'l-open'],
      ['/document/:id#DocumentDetail', '3 →', 'entry', 'l-open'],
      ['/document/:id#DocumentDetail', '→ 5조건', 'exit', 'l-conditioned'],
      ['/lab#Lab', '✕5 →', 'entry', 'l-broken'],
      ['/lab/result#LabResult', '→ 8맵에 없는 화면', 'exit', 'l-off-map'],
      ['/help#Help', '4 →', 'entry', 'l-conditioned'],
      ['/help#Help', '✕→ 6링크 없음', 'exit', 'l-broken'],
    ]);
    const order = await p.locator('#flow .box.screen[data-key="/document/:id#DocumentDetail"]').evaluate((box) => [...box.children].map((c) => c.className.split(' ')[0]));
    assert.deepEqual(order.filter((c) => c !== 'sr-only'), ['story-chip', 'story-badge', 'sq', 'path', 'tag', 'story-chip'], 'chips from earlier steps and the number come first, chips to later steps last');
    await p.locator('#flow .story-chip.exit[data-hop="3"]').hover();
    assert.deepEqual(await p.$$eval('#flow .story-chip.hovered', (els) => els.map((e) => e.closest<HTMLElement>('.box')!.dataset.key)), ['/document/:id#DocumentDetail', '/help#Help']);

    const problems = () => p.evaluate(() => {
      const R = (e: Element) => e.getBoundingClientRect();
      const boxes = [...document.querySelectorAll<HTMLElement>('#flow .canvas > .box')];
      const marks = [...document.querySelectorAll<HTMLElement>('#flow .canvas > .mark')];
      const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
      const out = [];
      for (const m of marks) {
        for (const b of boxes) if (hit(R(m), R(b))) out.push(`${m.textContent} covers ${b.dataset.key}`);
        if (R(m).right > R(m.parentElement!).right + 0.5) out.push(`${m.textContent} sticks out of its canvas`);
      }
      marks.forEach((m, i) => marks.slice(i + 1).forEach((o) => { if (hit(R(m), R(o))) out.push(`${m.textContent} covers ${o.textContent}`); }));
      for (const line of document.querySelectorAll<SVGPathElement>('#flow .canvas svg path')) {
        const ctm = line.getScreenCTM()!;
        const len = line.getTotalLength();
        const thick = line.classList.contains('story-edge');
        for (let a = 2; a < len - 2; a += 2) {
          const q = line.getPointAtLength(a);
          const x = ctm.a * q.x + ctm.e;
          const y = ctm.d * q.y + ctm.f;
          const inside = (e: Element) => { const r = R(e); return x > r.left + 1 && x < r.right - 1 && y > r.top + 1 && y < r.bottom - 1; };
          const box = thick && boxes.find(inside);
          const under = marks.find((m) => !m.classList.contains('story-tag') && inside(m))!;
          if (box || under) {
            out.push(`${line.dataset.from} → ${line.dataset.to} runs ${box ? `across ${box.dataset.key}` : `under ${under.textContent}`}`);
            break;
          }
        }
      }
      return out;
    });
    assert.deepEqual(await problems(), []);
    assert.deepEqual(await textOutside(p), []);

    await drawOverlay(p, 'run-lab');
    assert.deepEqual(await pathEdges(p), [['/home#Home', '/lab#Lab', 'l-conditioned'], ['/lab#Lab', '/lab/result#LabResult', 'l-open']]);
    assert.deepEqual(await pathMarks(p, 'story-tag'), [['/lab#Lab', '조건', 'l-conditioned']]);
    assert.deepEqual(await problems(), []);

    await drawOverlay(p, 'twice');
    assert.deepEqual(await pillMarks(p, 'story-badge'), [['/signin#SignIn', '1'], ['/home#Home', '2·4'], ['/help#Help', '3']]);
  });
});
