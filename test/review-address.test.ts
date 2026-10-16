import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, Route } from 'playwright-core';
import { withRebuiltFixture, withServer, browserMissing, withPage, untaggedTab, screenBox, flowButton, filterButton, pickedBoxes, WALK, WALK_ON_MAP, withPathStories, flowPlace, pickPathStory, drawnScreens, ringed, ringBadge, DOCUMENT_TABLE, bulk, openDocumentTable, untilSet, placeOf, CANDIDATES, HELP_KEY, storiesTab } from './review-helpers.ts';

declare const state: any;
declare function render(): void;

test('in a browser, the picked story and the picked screen are kept in the address through reloads and back and forward, and a place that is gone falls back to what is there', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p, { base, errors }) => {
    const whole = (await drawnScreens(p)).length;
    await (await screenBox(p, '/lab#Lab')).click();
    await pickPathStory(p, 'walk-around');
    assert.equal(await flowPlace(p), '#flow?story=walk-around&screen=/lab#Lab', 'a picked screen on the path stays picked');
    await p.reload();
    await p.waitForSelector('#flow .story-line');
    assert.equal(await flowPlace(p), '#flow?story=walk-around&screen=/lab#Lab');
    assert.deepEqual(await drawnScreens(p), [...WALK_ON_MAP].sort());
    assert.deepEqual(await pickedBoxes(p), ['/lab#Lab']);
    assert.equal(await p.textContent('#center h3'), '/lab');
    await p.goBack();
    await p.waitForSelector('#flow .story-line', { state: 'detached' });
    assert.equal(await flowPlace(p), '#flow?screen=/lab#Lab');
    assert.equal((await drawnScreens(p)).length, whole);
    await p.goForward();
    await p.waitForSelector('#flow .story-line');
    assert.deepEqual(await p.$$eval('#flow-story-list li.selected', (els: HTMLElement[]) => els.map((e) => e.dataset.story)), ['walk-around']);
    await (await screenBox(p, '/home#Home')).click();
    assert.deepEqual(await ringBadge(p), ['2']);
    await p.goBack();
    await p.waitForFunction(() => decodeURIComponent(location.hash).endsWith('screen=/lab#Lab'));
    assert.deepEqual(await ringBadge(p), ['6'], 'going back to a picked screen rings its step');
    assert.deepEqual(await ringed(p), [['5', '/lab#Lab']]);

    await flowButton(p, '경로 끄기').click();
    assert.equal(await flowPlace(p), '#flow?screen=/lab#Lab');
    await (await screenBox(p, '/admin/group#AdminGroup')).click();
    await pickPathStory(p, 'walk-around');
    assert.equal(await flowPlace(p), '#flow?story=walk-around', 'a picked screen off the path is let go');
    assert.equal(await p.locator('#gaps').isVisible(), true);

    await p.goto(`${base}/#flow?story=gone&screen=${encodeURIComponent('/gone#Gone')}`);
    await p.reload();
    await p.waitForSelector('#flow .box.screen');
    assert.equal(await flowPlace(p), '#flow');
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

test('in a browser, the back and forward buttons go through the screens that were chosen, the left tabs and the two views', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const chosen = () => p.evaluate(() => [state.view, state.side, state.selected, state.story, document.querySelector('#screen-list li.selected, #story-list li.selected, #untagged-list li.selected')?.textContent.slice(0, 12)]);
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.click('#screen-list li:has-text("/signin")');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li >> nth=1');
        const story = await p.evaluate(() => state.story);
        await p.click(untaggedTab);
        await p.click('#view-flow');
        assert.equal(await placeOf(p), '#flow');

        await p.goBack();
        assert.match(await placeOf(p), /^#untagged\?test=/);
        assert.equal(await p.locator('#untagged-list li.selected').count(), 1);
        await p.goBack();
        assert.equal(await placeOf(p), `#stories?story=${story}`);
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
        await p.goForward();
        await p.goForward();
        await p.goForward();
        await p.goForward();
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
        assert.equal(await placeOf(p), '#stories?story=run-lab');
        await p.click('#candidate-list li:has-text("open-help")');
        assert.equal(await placeOf(p), `#stories?candidate=${HELP_KEY.replaceAll(' ', '+')}`);

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
