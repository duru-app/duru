import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, Route } from 'playwright-core';
import { addMark } from '../src/marks.ts';
import { withRebuiltFixture, withServer, browserMissing, withPage, untaggedTab, screenBox, filterButton, pickedBoxes, WALK, withPathStories, flowPlace, pickPathStory, lineSteps, DOCUMENT_TABLE, bulk, openDocumentTable, untilSet, placeOf, CANDIDATES, HELP_KEY, storiesTab, nowStep, chooseScreen } from './review-helpers.ts';

declare const state: any;
declare function render(): void;

test('in a browser, a step pressed on the story line is kept in the address: the same address marks the same step through tab changes, back, a reload and a fresh visit, scrolling its card into view, pressing another step replaces the address rather than adding to the history, another story drops it, and a step past the end is dropped', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p, { base }) => {
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.setViewportSize({ width: 1440, height: 600 });
    await pickPathStory(p, 'walk-around');
    const steps = await p.evaluate(() => history.length);
    await p.click('#center .story-line .box[data-step="2"]');
    await p.click('#center .story-line .box[data-step="6"]');
    assert.equal(await flowPlace(p), '#story?story=walk-around&step=7');
    assert.equal(await p.evaluate(() => history.length), steps, 'pressing steps adds nothing to the history');
    assert.deepEqual(await nowStep(p), ['7']);

    await p.click('#view-flow');
    await p.click('#view-story');
    assert.equal(await flowPlace(p), '#story?story=walk-around&step=7', 'back on the story tab');
    assert.deepEqual(await nowStep(p), ['7']);
    await p.click('#view-flow');
    await p.goBack();
    await p.waitForFunction(() => location.hash === '#story?story=walk-around&step=7');
    assert.deepEqual(await nowStep(p), ['7'], 'after going back');

    await p.reload();
    await p.waitForSelector('#center .story-line .box.now');
    assert.deepEqual(await nowStep(p), ['7'], 'after a reload');
    const cardInView = () => p.evaluate(() => {
      const r = document.querySelector('#center .story-path > .step[data-step="6"]')!.getBoundingClientRect();
      return r.top >= document.querySelector('#center .story-top')!.getBoundingClientRect().bottom - 1 && r.bottom <= document.getElementById('center')!.getBoundingClientRect().bottom + 1;
    });
    assert.equal(await cardInView(), true, 'the marked card is scrolled into view');

    await p.goto('about:blank');
    await p.goto(`${base}/#story?story=walk-around&step=7`);
    await p.waitForSelector('#center .story-line .box.now');
    assert.deepEqual(await nowStep(p), ['7'], 'on a fresh visit to the address');
    assert.equal(await cardInView(), true);

    const other = await p.$eval('#story-list li:not(.selected)[data-story]', (e: HTMLElement) => e.dataset.story!);
    await pickPathStory(p, other);
    assert.equal(await flowPlace(p), `#story?story=${other}`);
    await pickPathStory(p, 'walk-around');
    assert.equal(await flowPlace(p), '#story?story=walk-around', 'coming back through another story leaves no step');
    assert.deepEqual(await nowStep(p), []);

    await p.click('#center .story-line .box[data-step="2"]');
    await p.click('#left .new-story');
    await p.click('#left .leave-compose');
    await pickPathStory(p, 'walk-around');
    assert.equal(await flowPlace(p), '#story?story=walk-around', 'coming back through a new story leaves no step');
    assert.deepEqual(await nowStep(p), []);

    await p.evaluate(() => {
      state.story = 'unread-file';
      state.storyStep = { of: 'story\nunread-file', step: 1, screen: null };
      render();
    });
    assert.equal(await flowPlace(p), '#story?story=unread-file', 'a story the page cannot read keeps no step');

    await p.goto('about:blank');
    await p.goto(`${base}/#story?story=walk-around&step=${WALK.length + 1}`);
    await p.waitForSelector('#center .story-line');
    assert.equal(await flowPlace(p), '#story?story=walk-around', 'a step past the end is dropped');
    assert.deepEqual(await nowStep(p), []);
  });
});

test('in a browser, a story picked in the story tab is kept in the address through reloads and back and forward, its earlier addresses open it in the story tab, and a story that is gone falls back to what is there', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p, { base, errors }) => {
    await (await screenBox(p, '/lab#Lab')).click();
    assert.equal(await flowPlace(p), '#flow?screen=/lab#Lab');
    await pickPathStory(p, 'walk-around');
    assert.equal(await flowPlace(p), '#story?story=walk-around');
    await p.reload();
    await p.waitForSelector('#center .story-line');
    assert.equal(await flowPlace(p), '#story?story=walk-around');
    assert.deepEqual(await lineSteps(p), WALK.map((id, i) => [String(i + 1), id]));
    await p.goBack();
    await p.waitForFunction(() => location.hash.startsWith('#story?story=') && !location.hash.endsWith('walk-around'));
    await p.goBack();
    await p.waitForSelector('#flow .box.screen.picked');
    assert.equal(await flowPlace(p), '#flow?screen=/lab#Lab');
    assert.deepEqual(await pickedBoxes(p), ['/lab#Lab']);
    await p.goForward();
    await p.goForward();
    await p.waitForFunction(() => location.hash === '#story?story=walk-around');
    assert.deepEqual(await p.$$eval('#story-list li.selected', (els: HTMLElement[]) => els.map((e) => e.dataset.story)), ['walk-around']);

    for (const old of ['#stories?story=walk-around', '#flow?story=walk-around', `#flow?story=walk-around&screen=${encodeURIComponent('/lab#Lab')}`]) {
      await p.goto('about:blank');
      await p.goto(`${base}/${old}`);
      await p.waitForSelector('#center .story-line');
      assert.equal(await flowPlace(p), '#story?story=walk-around', `${old} opens the story in the story tab`);
    }

    await p.goto('about:blank');
    await p.goto(`${base}/#flow?story=gone&screen=${encodeURIComponent('/gone#Gone')}`);
    await p.waitForSelector('#view-story.on');
    assert.match(await flowPlace(p), /^#story\?story=(?!gone)/);
    assert.deepEqual(errors, []);
  });
});
const openAt = async (p: Page, url: string) => {
  await p.goto('about:blank');
  await p.goto(url);
};

test('in a browser, the first drawing writes the place into the address without adding a step to the history, and a redraw of the same place adds none', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        assert.equal(await placeOf(p), '#flow');
        const steps = await p.evaluate(() => history.length);
        await p.evaluate(() => render());
        await filterButton(p, 'fail').click();
        await p.locator('#flow-zoom .zoom-out').click();
        assert.equal(await p.evaluate(() => history.length), steps);

        await p.click('#view-list');
        assert.match(await placeOf(p), /^#screens\?screen=/);
        assert.equal(await p.evaluate(() => history.length), steps + 1);
        await p.check('#left input[name=no-tests]');
        await p.uncheck('#left input[name=no-tests]');
        assert.equal(await p.evaluate(() => history.length), steps + 1);
      }, { view: 'flow' })));
});

test('in a browser, the back and forward buttons go through the screens that were chosen, the left tabs and the three views', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const chosen = () => p.evaluate(() => [state.view, state.side, state.selected, state.story, document.querySelector('#screen-list li.selected, #story-list li.selected, #untagged-list li.selected')?.textContent.slice(0, 12)]);
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.click('#screen-list li:has-text("/signin")');
        await p.click('#view-story');
        await p.click('#story-list li >> nth=1');
        const story = await p.evaluate(() => state.story);
        await p.click('#view-list');
        await p.click(untaggedTab);
        await p.click('#view-flow');
        assert.equal(await placeOf(p), '#flow');

        await p.goBack();
        assert.match(await placeOf(p), /^#untagged\?test=/);
        assert.equal(await p.locator('#untagged-list li.selected').count(), 1);
        await p.goBack();
        assert.equal(await placeOf(p), '#screens?screen=/signin#SignIn');
        await p.goBack();
        assert.equal(await placeOf(p), `#story?story=${story}`);
        assert.equal(await p.locator('#story-list li.selected').count(), 1);
        await p.goBack();
        await p.goBack();
        assert.equal(await placeOf(p), '#screens?screen=/signin#SignIn');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/signin/);
        await p.goBack();
        assert.equal(await placeOf(p), '#screens?screen=/help#Help');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/help/);
        assert.match((await p.textContent('#center'))!, /\/help/);

        await p.goForward();
        assert.deepEqual((await chosen()).slice(0, 3), ['list', 'screens', '/signin#SignIn']);
        for (let i = 0; i < 5; i++) await p.goForward();
        assert.equal(await placeOf(p), '#flow');
        assert.equal(await p.locator('#flow').isVisible(), true);
      })));
});

test('in a browser, a screen picked in the flow is a place: back shows the flow with nothing picked and forward the pick', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        await (await screenBox(p, '/home#Home')).click();
        assert.equal(await placeOf(p), '#flow?screen=/home#Home');
        await (await screenBox(p, '/lab#Lab')).click();
        assert.equal(await placeOf(p), '#flow?screen=/lab#Lab');

        await p.goBack();
        assert.equal(await placeOf(p), '#flow?screen=/home#Home');
        assert.deepEqual(await pickedBoxes(p), ['/home#Home']);
        await p.goBack();
        await p.waitForSelector('#flow .box.picked', { state: 'detached' });
        assert.equal(await placeOf(p), '#flow');
        assert.equal(await p.locator('#gaps').isVisible(), true);
        await p.goForward();
        await p.waitForSelector('#flow .box.picked');
        assert.equal(await placeOf(p), '#flow?screen=/home#Home');
        assert.equal(await p.textContent('#center h3'), '/home');

        await p.click('.flowbar .picking button');
        assert.equal(await placeOf(p), '#flow');
      }, { view: 'flow' })));
});

test('in a browser, a page opened or loaded again with a place in its address shows that place, and a place that is gone falls back to what is there', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.reload();
        await p.waitForSelector('#screen-list li.selected');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/help/);
        assert.equal(await p.locator('main').isVisible(), true);

        await openAt(p, `${base}/#flow?screen=${encodeURIComponent('/home#Home')}`);
        await p.waitForSelector('#flow .box.picked');
        assert.equal(await p.textContent('.flowbar .picking strong'), '/home');
        assert.equal(await p.textContent('#center h3'), '/home');

        await openAt(p, `${base}/#screens?screen=${encodeURIComponent('/gone#Gone')}`);
        await p.waitForSelector('#screen-list li.selected');
        assert.equal(await placeOf(p), `#screens?screen=${await p.evaluate(() => state.selected)}`);
        assert.notEqual(await p.evaluate(() => state.selected), '/gone#Gone');

        await openAt(p, `${base}/#flow?screen=${encodeURIComponent('/gone#Gone')}`);
        await p.waitForSelector('#flow .box.screen');
        assert.equal(await placeOf(p), '#flow');
        assert.equal(await p.locator('#flow .box.picked').count(), 0);
        assert.deepEqual(errors, []);
      })));
});

test('in a browser, going back to a screen drops a mark that was not saved, as choosing the screen does', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.click('#screen-list li:has-text("/signin")');
        await p.fill('#right-dock textarea', 'not saved');
        await p.goBack();
        await p.goForward();
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/signin/);
        assert.equal(await p.inputValue('#right-dock textarea'), '');
      })));
});

test('in a browser, the back button does not leave the test while a bulk is in flight, and works again when it ends', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await openDocumentTable(p);
        const place = await placeOf(p);
        let held!: Route;
        await p.route('**/api/judgments', (route) => { if (held) route.continue(); else held = route; });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await untilSet(() => held, 'the first judgment request');
        await p.goBack();
        assert.equal(await placeOf(p), place);
        assert.equal(await p.textContent('#center h3'), DOCUMENT_TABLE.title);

        await held.continue();
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        await p.goBack();
        await p.waitForFunction((title) => document.querySelector('#center h3')!.textContent !== title, DOCUMENT_TABLE.title);
        assert.match(await placeOf(p), /^#untagged\?test=/);
      })));
});

test('in a browser, a chosen candidate is a place in the address, and the back button returns to the story shown before it', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await placeOf(p), '#story?story=run-lab');
        await p.click('#candidate-list li:has-text("open-help")');
        assert.equal(await placeOf(p), `#story?candidate=${HELP_KEY.replaceAll(' ', '+')}`);

        await p.goBack();
        await p.waitForSelector('#story-list li.selected:has-text("실험실을 열어")');
        assert.equal(await p.locator('#candidate-list li.selected').count(), 0);
        assert.equal(await p.textContent('#center h3'), '실험실을 열어 결과를 본다');

        await p.goForward();
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        assert.equal(await p.textContent('#center h3'), 'open-help');
      }),
    ),
  );
});

test('in a browser, 「전체」 and its filter are kept in the address: back from a pressed line returns to 「전체」 with the same filter and the pressed line in view in the group it was pressed in, forward goes to the line\'s place again, and changing the filter or the two buttons adds nothing to the history', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    for (let i = 0; i < 30; i++) addMark(config.marksDir, { target: { node: '/home#Home' }, note: `home question ${i}`, author: 'reviewer' }, new Date(Date.UTC(2026, 9, 12, 2, i)));
    addMark(config.marksDir, { target: { node: '/home#Home' }, status: 'needs-more', note: 'home verdict', author: 'reviewer' }, new Date('2026-10-12T03:00:00Z'));
    addMark(config.marksDir, { targets: [{ node: '/home#Home' }, { node: '/lab#Lab' }], note: 'lab question', author: 'reviewer' }, new Date('2026-10-12T02:15:30Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const scope = p.locator('#right-info .talk-scope button');
        const filter = (label: string) => p.locator('#right-info .talk-filters button', { hasText: label });
        const labLine = p.locator('#right-info .talk-group:last-child .talk-line', { hasText: 'lab question' });
        const inView = (line: typeof labLine) => line.evaluate((e) => {
          const r = e.getBoundingClientRect();
          const pane = document.getElementById('right')!.getBoundingClientRect();
          return r.top >= pane.top && r.bottom <= Math.min(pane.bottom, innerHeight);
        });
        await p.waitForSelector('#screen-list li');
        await chooseScreen(p, '/help');
        const steps = await p.evaluate(() => history.length);
        await scope.nth(1).click();
        await filter('테스트 필요').click();
        await filter('미답변').click();
        assert.equal(await placeOf(p), '#screens?screen=/help#Help&talk=all&filter=unanswered');
        await scope.first().click();
        assert.equal(await placeOf(p), '#screens?screen=/help#Help');
        await scope.nth(1).click();
        assert.equal(await p.evaluate(() => history.length), steps, 'the filter and the two buttons add nothing to the history');
        assert.equal(await inView(labLine), false, 'the line starts out of view');

        await labLine.click();
        assert.equal(await placeOf(p), '#screens?screen=/lab#Lab');
        assert.equal(await scope.first().getAttribute('aria-pressed'), 'true');
        assert.equal(await p.evaluate(() => history.length), steps + 1);

        await p.goBack();
        await p.waitForFunction(() => state.talkScope === 'all');
        assert.equal(await placeOf(p), '#screens?screen=/help#Help&talk=all&filter=unanswered');
        assert.match((await p.textContent('#screen-list li.selected'))!, /^\/help/);
        assert.equal(await filter('미답변').getAttribute('aria-pressed'), 'true');
        assert.equal(await inView(labLine), true, 'the pressed line is in view after going back');
        assert.match((await p.textContent('#right-info .talk-line.reached'))!, /lab question/);

        await p.goForward();
        await p.waitForFunction(() => state.talkScope === 'here');
        assert.equal(await placeOf(p), '#screens?screen=/lab#Lab');
        assert.match((await p.textContent('#screen-list li.selected'))!, /^\/lab/);

        await scope.nth(1).click();
        await labLine.click();
        assert.equal(await placeOf(p), '#screens?screen=/lab#Lab');
        await p.goBack();
        await p.waitForFunction(() => state.talkScope === 'all');
        assert.equal(await placeOf(p), '#screens?screen=/lab#Lab&talk=all&filter=unanswered', 'a line of the screen already open is a step in the history too');

        await p.reload();
        await p.waitForSelector('#right-info .all-talk');
        assert.equal(await filter('미답변').getAttribute('aria-pressed'), 'true');
        assert.deepEqual(errors, []);
      }));
  });
});
