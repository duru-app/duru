import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Locator } from 'playwright-core';
import { addMark, addReply, loadMarks } from '../src/marks.ts';
import { startReviewServer } from '../src/review.ts';
import { taskList } from '../src/tasks.ts';
import { withRebuiltFixture, signer, withServer, postMark, CASE_KINDS, browserMissing, withPage, reply, openScreenInfo, openLinkGroups, screenBox, chooseScreen, TRACED, postJson, CANDIDATES, HELP_KEY, storiesTab, discardCandidate } from './review-helpers.ts';
import type { PageData } from './review-helpers.ts';

test('in a browser, an entry under 「떨어져 나감」 with a comment and an answer shows the comment, not the answer', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const comment = addMark(config.marksDir, { target: { node: '/gone#Gone' }, note: 'is this screen gone?', author: 'a' }, new Date('2026-10-03T01:00:00Z'));
    addReply(config.marksDir, { replyTo: comment.id, note: 'yes, it was removed' }, new Date('2026-10-03T02:00:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#left .detached li');
        const entry = (await p.textContent('#left .detached li'))!;
        assert.match(entry, /is this screen gone\?/);
        assert.doesNotMatch(entry, /removed/);
      }),
    );
  });
});

const partOf = (node: string, source: string, file: string, title: string) => ({ node, part: { kind: 'test', key: { source, file, title } } });

test('in a browser, the bubble of a tagged, an importing, a passing and a calling test row puts that test in as the tag, a comment saved with it shows its count on the row, also after reloading, and the status buttons stay off', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        const comment = async (row: Locator, title: string, note: string) => {
          await row.hover();
          await row.locator('.bubble').click();
          assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), `테스트 「${title}」`);
          assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
          await p.fill('#right-dock textarea', note);
          await p.click('#right-dock button.save');
          await row.locator('.part-count', { hasText: '코멘트 1' }).waitFor();
        };
        await chooseScreen(p, '/lab');
        await comment(p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ }), 'opens the lab', 'why pending?');
        await chooseScreen(p, '/home');
        await comment(p.locator('#center .importers .part-row', { hasText: 'DocumentTable' }), 'DocumentTable › lists the documents it is given', 'can this carry the tag?');
        await p.locator('table.calls tbody tr:not(.option)', { hasText: 'GET:/api/v1/document/list' }).locator('td.cell').first().click();
        await comment(p.locator('#center .call-info .passed .part-row', { hasText: 'lists the documents' }), 'lists the documents', 'does it check the rows?');
        await chooseScreen(p, '/help');
        await comment(p.locator('#center .passed .part-row', { hasText: 'follows a link while waiting for the new address' }), 'follows a link while waiting for the new address', 'is help checked here?');

        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status ?? null, m.note]).sort((a, b) => String(a[2]).localeCompare(String(b[2]))), [
          [partOf('/home#Home', 'results/vitest/client-unit.json', 'components/DocumentTable.spec.js', 'DocumentTable › lists the documents it is given'), null, 'can this carry the tag?'],
          [partOf('GET:/api/v1/document/list', 'results/playwright-traced/calls.json', 'calls.spec.ts', 'lists the documents'), null, 'does it check the rows?'],
          [partOf('/help#Help', 'results/playwright-traced/visits.json', 'visits.spec.ts', 'follows a link while waiting for the new address'), null, 'is help checked here?'],
          [partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab'), null, 'why pending?'],
        ]);
        await p.reload();
        await chooseScreen(p, '/lab');
        assert.equal(await p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ }).locator('.part-count').textContent(), '코멘트 1');
        assert.deepEqual(errors, []);
      })));
});

test('in a browser, the conversation of a screen holds the comments on it and on its tests oldest first, each with its tag; the count of a test row narrows it to that test and its replies, and the status buttons work only while the screen itself is the one tag; with every tag taken off the comment is saved with no target', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const lab = partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab');
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'no table test', author: 'reviewer' }, new Date('2026-10-12T01:00:00Z'));
    const asked = addMark(config.marksDir, { target: lab, note: 'why pending?', author: 'reviewer' }, new Date('2026-10-12T02:00:00Z'));
    addReply(config.marksDir, { replyTo: asked.id, note: 'it waits for the lab data' }, new Date('2026-10-12T03:00:00Z'));
    addMark(config.marksDir, { target: { node: '/lab#Lab', depth: 'api' }, note: 'and the API?', author: 'reviewer' }, new Date('2026-10-12T04:00:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await chooseScreen(p, '/lab');
        const said = () => p.locator('#right-info .history > li').evaluateAll((list) => list.map((li) => [li.querySelector(':scope > .tag')?.textContent, li.querySelector(':scope > div')?.textContent]));
        assert.deepEqual(await said(), [['화면 전체', 'no table test'], ['테스트 「opens the lab」', 'why pending?'], ['API 깊이', 'and the API?']]);
        assert.match((await p.textContent('#right-info .history > li:nth-child(2) .replies'))!, /it waits for the lab data/);

        await p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ }).locator('.part-count').click();
        assert.deepEqual(await said(), [['테스트 「opens the lab」', 'why pending?']]);
        assert.equal(await p.textContent('#right-info .history-filter .tag-label'), '테스트 「opens the lab」');
        await p.click('#right-info .history-filter button');
        assert.equal((await said()).length, 3);

        assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '화면 전체');
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 3);
        const row = p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ });
        await row.hover();
        await row.locator('.bubble').click();
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
        await p.click('#right-dock .mark-form .tags .tag button');
        assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '화면 전체');
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 3);
        await p.click('#right-dock .mark-form .tags .tag button');
        assert.equal(await p.locator('#right-dock .mark-form .tags .tag').count(), 0);
        await p.fill('#right-dock textarea', 'about nothing');
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
        await p.click('#right-dock button.save');
        await p.locator('#right-dock .mark-form .tags .tag-label', { hasText: '화면 전체' }).waitFor();
        assert.deepEqual(loadMarks(config.marksDir).filter((m) => m.note === 'about nothing').map((m) => [m.target, m.targets]), [[undefined, []]]);
      }));
  });
});

test('in a browser, a comment takes more tags from bubbles and typed after @ and is saved once with every target: it counts once on each row it is on and once in 「전체」, shows with its reply whichever row narrows the conversation, shows its tags with the screen of a tag from elsewhere, and a status is refused for it; a comment with no target is listed in 「전체」 under 「대상 없음」 with its whole text and replies', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const lab = partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab');
    addMark(config.marksDir, { targets: [{ node: '/home#Home' }, partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'a test that is gone')], note: 'half lost', author: 'reviewer' }, new Date('2026-10-12T01:00:00Z'));
    const loose = addMark(config.marksDir, { targets: [], note: 'what about the tour?\nsecond line', author: 'reviewer' }, new Date('2026-10-12T02:00:00Z'));
    addReply(config.marksDir, { replyTo: loose.id, note: 'no tour yet' }, new Date('2026-10-12T03:00:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#left .detached li');
        assert.match((await p.textContent('#left .detached li'))!, /a test that is gone/);
        const said = () => p.locator('#right-info .history > li').evaluateAll((list) => list.map((li) => [[...li.querySelectorAll(':scope > .tag')].map((t) => t.textContent), li.querySelector(':scope > div')?.textContent]));
        await chooseScreen(p, '/home');
        assert.deepEqual(await said(), [[['화면 전체', '화면 /lab · 테스트 「a test that is gone」'], 'half lost']]);

        await chooseScreen(p, '/lab');
        const row = p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ });
        const notice = p.locator('#center-body .part-row', { hasText: 'shows the lab notice' });
        for (const r of [row, notice]) {
          await r.hover();
          await r.locator('.bubble').click();
        }
        const field = p.locator('#right-dock textarea');
        await field.pressSequentially('@API');
        assert.equal(await p.locator('#right-dock .tag-pick li[role=option]').first().textContent(), 'API 깊이');
        await field.press('Enter');
        const tags = ['테스트 「opens the lab」', '테스트 「shows the lab notice」', 'API 깊이'];
        assert.deepEqual(await p.locator('#right-dock .mark-form .tags .tag-label').allTextContents(), tags);
        assert.equal(await field.inputValue(), '');
        assert.equal(await p.locator('#right-dock .tag-pick').isHidden(), true);
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
        await field.pressSequentially('both of these');
        await p.click('#right-dock button.save');
        await row.locator('.part-count', { hasText: '코멘트 1' }).waitFor();
        assert.equal(await notice.locator('.part-count').textContent(), '코멘트 1');
        const saved = loadMarks(config.marksDir).filter((m) => m.note === 'both of these');
        assert.deepEqual(saved.map((m) => [m.target, m.status, m.targets!.map((t) => (t.part?.key as { title?: string } | undefined)?.title ?? t.depth)]), [[undefined, undefined, ['opens the lab', 'shows the lab notice', 'api']]]);
        assert.deepEqual(saved[0].targets![0], lab);
        await p.evaluate(async (replyTo) => {
          await fetch('/api/replies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replyTo, note: 'answered once' }) });
        }, saved[0].id);
        await p.locator('#right-info .history .replies', { hasText: 'answered once' }).waitFor();

        const depthRow = (label: string) => p.locator('#center-body > table tbody tr').filter({ has: p.locator('td.depth', { hasText: label }) });
        assert.equal(await depthRow('API').locator('.talk-count').textContent(), '코멘트 1');
        const scope = p.locator('#right-info .talk-scope button');
        assert.deepEqual(await scope.allTextContents(), ['이 화면 1', '전체 3']);
        assert.deepEqual(await said(), [[['화면 /home', '테스트 「a test that is gone」'], 'half lost'], [tags, 'both of these']]);
        for (const narrow of [depthRow('API').locator('.talk-count'), row.locator('.part-count'), notice.locator('.part-count')]) {
          await narrow.click();
          assert.deepEqual(await said(), [[tags, 'both of these']]);
          assert.match((await p.textContent('#right-info .history .replies'))!, /answered once/);
          await p.click('#right-info .history-filter button');
        }

        const res = await fetch(`${base}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targets: [{ node: '/lab#Lab' }, { node: '/home#Home' }], status: 'missing', note: 'both missing' }) });
        assert.deepEqual([res.status, await res.text()], [400, 'a status takes exactly one target; a comment on several targets or none takes no status']);

        await scope.nth(1).click();
        assert.equal(await p.locator('#right-info .talk-line', { hasText: 'both of these' }).count(), 1);
        const general = p.locator('#right-info .talk-group', { has: p.locator('h3', { hasText: '대상 없음' }) });
        assert.equal(await general.locator('button.talk-line').count(), 0);
        assert.match((await general.locator('.talk-line').textContent())!, /what about the tour\?\nsecond line[\s\S]*no tour yet/);
        assert.deepEqual(errors, []);
      }));
  });
});

test('in a browser, the @ list closes when the caret leaves the @ word and keeps the item picked with the arrows while the caret stays, an Enter that ends a composition does not pick, and a list closed with Escape stays closed; a status picked for the screen is not saved on the one tag left once the screen tag is taken off', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'needs-more', author: 'reviewer' }, new Date('2026-10-12T01:00:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await chooseScreen(p, '/lab');
        const field = p.locator('#right-dock textarea');
        const picker = p.locator('#right-dock .tag-pick');
        const tags = () => p.locator('#right-dock .mark-form .tags .tag-label').allTextContents();
        await p.click('#right-dock .statuses button:has-text("없음")');
        await field.pressSequentially('check @AP');
        await field.press('Home');
        assert.equal(await picker.isHidden(), true);
        await field.press('Enter');
        assert.deepEqual(await tags(), ['화면 전체']);
        await field.press('End');
        assert.equal(await picker.isHidden(), true);
        await field.press('Backspace');
        await field.press('Backspace');
        assert.deepEqual((await picker.locator('li[role=option]').allTextContents()).slice(0, 2), ['UI/E2E 깊이', 'API 깊이']);
        assert.equal(await picker.locator('li.on').textContent(), 'API 깊이');
        await p.keyboard.down('Shift');
        await p.keyboard.up('Shift');
        await field.press('End');
        assert.equal(await picker.locator('li.on').textContent(), 'API 깊이');
        await field.pressSequentially('u');
        assert.equal(await picker.locator('li.on').textContent(), 'UI/E2E 깊이');
        await field.press('Backspace');
        assert.equal(await picker.locator('li.on').textContent(), 'UI/E2E 깊이');
        await field.press('ArrowDown');
        await field.pressSequentially('q');
        assert.equal(await picker.locator('li[role=option]').count(), 0);
        await field.press('Backspace');
        assert.equal(await picker.locator('li.on').textContent(), 'API 깊이');
        await field.pressSequentially('i');
        assert.deepEqual((await picker.locator('li[role=option]').allTextContents()).slice(0, 2), ['UI/E2E 깊이', 'API 깊이']);
        assert.equal(await picker.locator('li.on').textContent(), 'API 깊이');
        await field.press('Enter');
        assert.deepEqual(await tags(), ['화면 전체', 'API 깊이']);
        assert.equal(await field.inputValue(), '\ncheck ');

        await field.pressSequentially('@');
        await field.press('ArrowDown');
        await field.press('Escape');
        await field.pressSequentially(' @');
        assert.equal(await picker.locator('li.on').textContent(), 'UI/E2E 깊이');
        await field.press('Backspace');
        await field.press('Backspace');
        await field.evaluate((e) => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
        assert.deepEqual(await tags(), ['화면 전체', 'API 깊이']);
        assert.equal(await picker.isVisible(), true);
        await field.pressSequentially('zz');
        assert.equal(await picker.locator('li[role=option]').count(), 0);
        await field.press('ArrowUp');
        assert.equal(await field.evaluate((e: HTMLTextAreaElement) => e.selectionStart), 0);
        assert.equal(await picker.isHidden(), true);
        await field.press('ArrowDown');
        await field.press('End');
        await field.press('Backspace');
        await field.press('Backspace');
        await field.press('Escape');
        await field.press('ArrowLeft');
        await field.press('ArrowRight');
        assert.equal(await picker.isHidden(), true);
        assert.equal(await field.inputValue(), '\ncheck @');

        await p.locator('#right-dock .mark-form .tags .tag', { hasText: '화면 전체' }).locator('button').click();
        assert.deepEqual(await tags(), ['API 깊이']);
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
        await p.fill('#right-dock textarea', 'depth only');
        await p.click('#right-dock button.save');
        await p.locator('#right-info .history li', { hasText: 'depth only' }).waitFor();
        assert.deepEqual(loadMarks(config.marksDir).filter((m) => m.note === 'depth only').map((m) => [m.target, m.status]), [[{ node: '/lab#Lab', depth: 'api' }, undefined]]);
        assert.deepEqual(errors, []);
      }));
  });
});

test('in a browser, 「전체」 groups every attached comment by its screen, call or story, latest first, filters the unanswered ones and each status, hides the form, and a line opens its place in 「이 화면」 with that comment in view; the screen list, depth rows, call cells, story rows and flow boxes show the count with a red dot while a comment waits for a reply', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config, copy) => {
    const lab = partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab');
    addMark(config.marksDir, { target: { node: 'GET:/api/v1/document/list' }, note: 'is this paged?', author: 'reviewer' }, new Date('2026-10-12T00:30:00Z'));
    addMark(config.marksDir, { target: partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'a test that is gone'), note: 'lost one', author: 'reviewer' }, new Date('2026-10-12T00:40:00Z'));
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'needs-more', note: 'old verdict', author: 'reviewer' }, new Date('2026-10-12T00:45:00Z'));
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'no table test', author: 'reviewer' }, new Date('2026-10-12T01:00:00Z'));
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'missing', author: 'reviewer' }, new Date('2026-10-12T01:30:00Z'));
    const asked = addMark(config.marksDir, { target: lab, note: 'why pending?', author: 'reviewer' }, new Date('2026-10-12T02:00:00Z'));
    addReply(config.marksDir, { replyTo: asked.id, note: 'it waits for the lab data' }, new Date('2026-10-12T03:00:00Z'));
    addMark(config.marksDir, { target: { node: '/lab#Lab', depth: 'api' }, note: 'and the API?\nsecond line', author: 'reviewer' }, new Date('2026-10-12T04:00:00Z'));
    const home = addMark(config.marksDir, { target: { node: '/home#Home' }, note: 'home first?', author: 'reviewer' }, new Date('2026-10-12T05:00:00Z'));
    addMark(config.marksDir, { target: { story: 'run-lab' }, note: 'one more step?', author: 'reviewer' }, new Date('2026-10-12T06:00:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const badge = (row: Locator) => row.locator('.talk-count').evaluate((e) => [e.textContent, !!e.querySelector('.unanswered-dot')]);
        const listed = (path: string) => p.locator('#screen-list li').filter({ has: p.locator('.name > span:first-child', { hasText: new RegExp(`^${path}$`) }) });
        await p.waitForSelector('#screen-list li');
        assert.deepEqual(await badge(listed('/lab')), ['코멘트 4', true]);
        assert.deepEqual(await badge(listed('/home')), ['코멘트 1', true]);
        assert.equal(await listed('/help').locator('.talk-count').count(), 0);

        await chooseScreen(p, '/lab');
        const depthRow = (label: string) => p.locator('#center-body > table tbody tr').filter({ has: p.locator('td.depth', { hasText: label }) });
        assert.deepEqual(await badge(depthRow('화면 전체')), ['코멘트 2', false]);
        assert.deepEqual(await badge(depthRow('API')), ['코멘트 1', true]);
        assert.equal(await p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ }).locator('.part-count .unanswered-dot').count(), 0);
        await depthRow('API').locator('.talk-count').click();
        assert.equal(await p.textContent('#right-info .history-filter .tag-label'), 'API 깊이');
        await chooseScreen(p, '/home');
        assert.deepEqual(await badge(p.locator('table.calls tbody tr:not(.option)', { hasText: 'GET:/api/v1/document/list' }).locator('td.cell').first()), ['코멘트 1', true]);

        const scope = p.locator('#right-info .talk-scope button');
        assert.deepEqual(await scope.allTextContents(), ['이 화면 1', '전체 7']);
        await scope.nth(1).click();
        assert.equal(await p.locator('#right-dock textarea').count(), 0);
        const groups = () => p.locator('#right-info .talk-group').evaluateAll((list) => list.map((g) => [g.querySelector('h3')!.textContent, [...g.querySelectorAll('.talk-line .first')].map((e) => e.textContent)]));
        assert.deepEqual(await groups(), [
          ['스토리 실험실을 열어 결과를 본다', ['one more step?']],
          ['/home', ['home first?']],
          ['/lab', ['and the API?', 'why pending?', 'no table test', 'old verdict']],
          ['호출 GET:/api/v1/document/list', ['is this paged?']],
        ]);
        assert.match((await p.textContent('#right-info .talk-line:has-text("why pending?") .meta'))!, /테스트 「opens the lab」.*· 답 1/);
        const filter = (label: string) => p.locator('#right-info .talk-filters button', { hasText: label });
        assert.equal(await filter('답 없는 것만').textContent(), '답 없는 것만 4');
        await filter('답 없는 것만').click();
        assert.deepEqual((await groups()).map(([, lines]) => lines).flat(), ['one more step?', 'home first?', 'and the API?', 'is this paged?']);
        await filter('없음').click();
        assert.deepEqual(await groups(), [['/lab', ['no table test']]]);
        await filter('더 필요').click();
        assert.deepEqual(await groups(), []);
        await filter('모두').click();
        await p.locator('table.calls tbody tr:not(.option)', { hasText: 'GET:/api/v1/document/list' }).locator('td.cell').first().locator('.talk-count').click();
        assert.equal(await scope.first().getAttribute('aria-pressed'), 'true');
        assert.equal(await p.textContent('#right-info .history-filter .tag-label'), '호출 전체');
        await scope.nth(1).click();

        await p.click('#right-info .talk-line:has-text("and the API?")');
        assert.deepEqual(await scope.allTextContents(), ['이 화면 4', '전체 7']);
        assert.equal(await scope.first().getAttribute('aria-pressed'), 'true');
        assert.match((await p.textContent('#screen-list li.selected'))!, /^\/lab/);
        assert.match((await p.textContent('#right-info .history li.reached'))!, /and the API\?/);
        assert.equal(await p.locator('#right-info .history-filter').count(), 0);

        await p.click('#view-story');
        await p.click('#left button.new-story');
        await p.click('#view-list');
        await chooseScreen(p, '/lab');
        await scope.nth(1).click();
        await p.click('#right-info .talk-line:has-text("one more step?")');
        assert.equal(await p.getAttribute('#view-story', 'class'), 'on');
        assert.match((await p.textContent('#right-dock .history li.reached'))!, /one more step\?/);
        assert.deepEqual(await badge(p.locator('#story-list li', { hasText: '실험실을 열어' })), ['코멘트 1', true]);

        await reply(copy, home.id, 'yes, the home comes first', '--server', `${base}/`);
        await p.click('#view-list');
        await listed('/home').locator('.talk-count:not(:has(.unanswered-dot))').waitFor();

        await p.click('#view-flow');
        assert.deepEqual(await badge(p.locator('#flow .box.screen[data-key="/lab#Lab"]')), ['코멘트 4', true]);
        assert.deepEqual(await badge(p.locator('#flow .box.screen[data-key="/home#Home"]')), ['코멘트 1', false]);
        assert.deepEqual(errors, []);
      }));
  });
});

test('in a browser, each step of a story and each link between two steps has a bubble that puts it in as the tag with the status buttons off, a comment saved there shows its count, and the count narrows the conversation', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const comment = async (row: Locator, tag: string, note: string) => {
          await row.locator('.part-row').hover();
          await row.locator('.part-row .bubble').click();
          assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), tag);
          assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
          await p.fill('#right-dock textarea', note);
          await p.click('#right-dock button.save');
          await row.locator('.part-count', { hasText: '코멘트 1' }).waitFor();
        };
        await p.waitForSelector('#screen-list li');
        await p.click('#view-story');
        await p.click('#story-list li:has-text("실험실을 열어")');
        await comment(p.locator('#center .story-path .step').nth(1), '단계 2 /lab', 'check the result table here');
        await comment(p.locator('#center .story-path .link').first(), '단계 1 → 2 연결', 'is this link always there?');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => m.target).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
          { story: 'run-lab', part: { kind: 'hop', key: { step: 1, from: '/home#Home', to: '/lab#Lab' } } },
          { story: 'run-lab', part: { kind: 'step', key: { step: 2, screen: '/lab#Lab' } } },
        ]);
        await p.locator('#center .story-path .step').nth(1).locator('.part-count').click();
        assert.equal(await p.textContent('#right .history-filter .tag-label'), '단계 2 /lab');
        assert.match((await p.textContent('#right .history'))!, /check the result table here/);
        assert.doesNotMatch((await p.textContent('#right .history'))!, /is this link always there/);
        await p.click('#story-list li:has-text("홈에서 개인 설정을")');
        await p.click('#right-info .talk-scope button:nth-child(2)');
        await p.click('#right-info .talk-line:has-text("check the result table here")');
        assert.equal(await p.locator('#right .history li.reached').isVisible(), true);
        assert.deepEqual(errors, []);
      })));
});

test('in a browser, each role and each setting under 「접근 조건」 and each incoming link has a bubble that puts it in as the tag, a comment saved with it shows its count there, the count narrows the conversation, and the same works on a screen picked in the flow', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const tips = p.locator('#center .open-needs .tips li');
        const comment = async (row: Locator, tag: string, note: string) => {
          await row.hover();
          await row.locator('.bubble').click();
          assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), tag);
          assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
          await p.fill('#right-dock textarea', note);
          await p.click('#right-dock button.save');
          await row.locator('.part-count', { hasText: '코멘트 1' }).waitFor();
        };
        await p.waitForSelector('#screen-list li');
        await chooseScreen(p, '/admin/report');
        await openScreenInfo(p);
        assert.deepEqual(await tips.allInnerTexts(), [
          '필요한 역할: ADMIN',
          '필요한 역할: OWNER',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN.LIST 에 "ADMIN_REPORT"',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN 있음',
        ]);
        assert.equal(await tips.nth(0).locator('.bubble').isVisible(), false, 'a bubble shows only on hover');
        await comment(tips.nth(1), '역할 OWNER', 'is OWNER really allowed?');
        await comment(tips.nth(3), '설정 SYSTEM.MAIN_MENU.ADMIN=present', 'is the menu enough?');
        await openLinkGroups(p.locator('#center .access'));
        const home = p.locator('#center .access .link-group li .part-row', { has: p.locator('code.from', { hasText: /^\/home#Home$/ }) });
        await comment(home, '/home#Home 에서 오는 링크', 'is this link shown?');

        const node = '/admin/report#AdminReport';
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status ?? null, m.note]).sort((a, b) => String(a[2]).localeCompare(String(b[2]))), [
          [{ node, part: { kind: 'condition', key: 'role:OWNER' } }, null, 'is OWNER really allowed?'],
          [{ node, part: { kind: 'condition', key: 'setting:SYSTEM.MAIN_MENU.ADMIN=present' } }, null, 'is the menu enough?'],
          [{ node, part: { kind: 'link', key: { from: '/home#Home', conditions: ['role:ADMIN', 'role:OWNER', 'setting:SYSTEM.MAIN_MENU.ADMIN.LIST:ADMIN_REPORT', 'setting:SYSTEM.MAIN_MENU.ADMIN=present'] } } }, null, 'is this link shown?'],
        ]);

        await tips.nth(1).locator('.part-count').click();
        const said = () => p.locator('#right-info .history > li').evaluateAll((list) => list.map((li) => [li.querySelector(':scope > .tag')?.textContent, li.querySelector(':scope > div')?.textContent]));
        assert.deepEqual(await said(), [['역할 OWNER', 'is OWNER really allowed?']]);

        await p.click('#view-flow');
        await (await screenBox(p, node)).click();
        await p.waitForSelector('#flow .box.picked');
        await openScreenInfo(p);
        assert.equal(await tips.nth(1).locator('.part-count').textContent(), '코멘트 1');
        await comment(tips.nth(0), '역할 ADMIN', 'and ADMIN?');
        assert.deepEqual(errors, []);
      })));
});

test('in a browser, a comment on a condition or an incoming link that is gone from the map shows under 「떨어져 나감」 with what it was on', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    addMark(config.marksDir, { target: { node: '/lab#Lab', part: { kind: 'condition', key: 'role:ADMIN' } }, note: 'admins only?', author: 'reviewer' });
    addMark(config.marksDir, { target: { node: '/lab#Lab', part: { kind: 'link', key: { from: '/signin#SignIn', guards: [] } } }, note: 'a link from sign-in?', author: 'reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#left .detached li');
        const texts = await p.locator('#left .detached li').allInnerTexts();
        assert.ok(texts.some((t) => /\/lab#Lab · 역할 ADMIN/.test(t)), texts.join('\n'));
        assert.ok(texts.some((t) => /\/lab#Lab · \/signin#SignIn 에서 오는 링크/.test(t)), texts.join('\n'));
      }));
  });
});

test('in a browser, a comment on a test that is no longer among the results shows under 「떨어져 나감」 with the test title', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    addMark(config.marksDir, { target: partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab before the rename'), note: 'why pending?', author: 'reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#left .detached li');
        assert.match((await p.textContent('#left .detached li'))!, /\/lab#Lab · 테스트 「opens the lab before the rename」/);
      }));
  });
});

test('in a browser, a case kind picked on a screen shows in its conversation with the status the case was given', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) => {
    const kind = Object.keys(CASE_KINDS)[0];
    addMark(config.marksDir, { target: { node: '/lab#Lab', case: kind }, status: 'needed', author: 'reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await chooseScreen(p, '/lab');
        assert.equal(await p.textContent('#right-info .history > li .chip'), '필요');
      }));
  });
});

test('in a browser, the default tag taken off with its × leaves a note that can be saved with no target, comes back with the note still typed, and after it or after a bubble typing goes on at the end of the note', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await chooseScreen(p, '/lab');
        await p.fill('#right-dock textarea', 'half a thought');
        await p.click('#right-dock .mark-form .tags .tag button');
        assert.equal(await p.isDisabled('#right-dock button.save'), false);
        await p.click('#right-dock .mark-form .tags button.retag');
        assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '화면 전체');
        assert.equal(await p.inputValue('#right-dock textarea'), 'half a thought');
        await p.keyboard.type(' and the rest');
        assert.equal(await p.inputValue('#right-dock textarea'), 'half a thought and the rest');
        const row = p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ });
        await row.hover();
        await row.locator('.bubble').click();
        await p.keyboard.type('.');
        assert.equal(await p.inputValue('#right-dock textarea'), 'half a thought and the rest.');
        assert.equal(await p.isDisabled('#right-dock button.save'), false);
      })));
});

test('a comment on a test saved while tests.json cannot be read is still saved and announced, with where as null', async () => {
  await withRebuiltFixture({}, async (config) => {
    const lines: unknown[] = [];
    const server = await startReviewServer(config, { author: signer('reviewer'), onMark: (line) => lines.push(line) });
    try {
      fs.writeFileSync(path.join(config.outDir, 'tests.json'), '{"nodes":');
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await postMark(base, { target: partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab'), note: 'why pending?' });
      assert.equal(res.status, 201);
      const saved = await res.json();
      assert.deepEqual(lines, [{ duru: 'comment', ...saved, where: null }]);
      assert.equal(loadMarks(config.marksDir).length, 1);
    } finally {
      server.close();
    }
  });
});

const TRACE_CANDIDATE = '/home#Home > /help#Help';
const TRACE_TITLES = ['opens home and then help', 'follows a link while waiting for the new address', 'uses the mouse right after the address changes', 'clicks a button that appears after the address changes'];

test('a comment on a candidate from a trace is announced with its result file, test titles and screen order; once the candidate is accepted it is detached under the candidate name and a reply to it is announced with where as null', async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, async (config) => {
    const lines: unknown[] = [];
    const server = await startReviewServer(config, { author: signer('reviewer'), onMark: (line) => lines.push(line) });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const target = { candidate: TRACE_CANDIDATE };
      const saved = await (await postMark(base, { target, note: 'which test gives this?' })).json();
      const where = { name: 'opens home and then help', source: { report: 'results/playwright-traced/visits.json', tests: TRACE_TITLES }, screens: ['/home#Home', '/help#Help'] };
      assert.deepEqual(lines, [{ duru: 'comment', ...saved, where }]);
      let data: PageData & { candidates: { gone: Record<string, string> } } = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.filter((m) => m.key === `candidate(${TRACE_CANDIDATE})`).map((m) => m.target), [target]);

      assert.equal((await postJson(base, '/api/candidates/accept', { key: TRACE_CANDIDATE, id: 'home-help', name: '홈에서 도움말' })).status, 201);
      const answered = await postJson(base, '/api/replies', { replyTo: saved.id, note: 'the first of the four' });
      assert.equal(answered.status, 201);
      assert.deepEqual(lines.slice(1).map((l) => [(l as { duru: string }).duru, (l as { target: unknown }).target, (l as { where: unknown }).where]), [['reply', target, null]]);
      data = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.detached.map((m) => m.target), [target]);
      assert.equal(data.candidates.gone[TRACE_CANDIDATE], 'opens home and then help');
      assert.equal(taskList(config), taskList({ ...config, marksDir: path.join(config.outDir, 'no-marks') }));
    } finally {
      server.close();
    }
  });
});

test('in a browser, the bubble of a candidate from a visit record and of one from a trace puts that candidate in as the one tag with the status buttons off, keeping a note already typed, and a comment saved there shows its count on the candidate, also after reloading; the count opens its conversation', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        const comment = async (name: string, note: string) => {
          const row = p.locator('#candidate-list li', { hasText: name });
          await row.hover();
          await row.locator('.bubble').click();
          await p.waitForSelector(`#candidate-list li.selected:has-text("${name}")`);
          assert.equal(await p.evaluate(() => document.activeElement!.matches('#right-dock textarea')), true);
          assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '후보');
          assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
          await p.keyboard.type(note);
          await p.click('#right-dock button.save');
          await p.locator('#candidate-list li', { hasText: name }).locator('.part-count', { hasText: '코멘트 1' }).waitFor();
        };
        await comment('open-help', 'why the beta inbox?');
        await p.fill('#right-dock textarea', 'and here: ');
        await comment('opens home and then help', 'which test gives this?');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status ?? null, m.note]).sort((a, b) => String(a[2]).localeCompare(String(b[2]))), [
          [{ candidate: TRACE_CANDIDATE }, null, 'and here: which test gives this?'],
          [{ candidate: HELP_KEY }, null, 'why the beta inbox?'],
        ]);

        await p.reload();
        await p.waitForSelector('#candidate-list li .part-count');
        assert.deepEqual(await p.locator('#candidate-list li').evaluateAll((items) => items.map((li) => li.querySelector('.part-count')?.textContent ?? null)), ['코멘트 1', null, '코멘트 1', null]);
        await p.locator('#candidate-list li', { hasText: 'open-help' }).locator('.part-count').click();
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        assert.equal(await p.getAttribute('#right .history-toggle', 'aria-expanded'), 'true');
        assert.deepEqual(await p.locator('#right-dock .history > li').evaluateAll((list) => list.map((li) => [li.querySelector(':scope > .tag')?.textContent, li.querySelector(':scope > div')?.textContent])), [['후보', 'why the beta inbox?']]);
        assert.deepEqual(errors, []);
      })));
});

test('in a browser, a comment on a story candidate shows in 「전체」 under the candidate\'s name, and pressing it opens that candidate on the stories tab with the comment in view and its own 「이 후보」 count', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) => {
    const asked = addMark(config.marksDir, { target: { candidate: HELP_KEY }, note: 'why the beta inbox?', author: 'reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.locator('#screen-list li').first().click();
        await p.click('#right-info .talk-scope button:nth-child(2)');
        const group = p.locator('#right-info .talk-group', { hasText: '후보 open-help' });
        assert.equal(await group.locator('.talk-line .first').textContent(), 'why the beta inbox?');
        await group.locator('.talk-line').click();
        assert.equal(await p.getAttribute('#view-story', 'class'), 'on');
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        const reached = p.locator(`#right [data-record="${asked.id}"]`);
        assert.equal(await reached.getAttribute('class'), 'reached');
        assert.equal(await reached.isVisible(), true);
        assert.deepEqual(await p.locator('#right-info .talk-scope button').allTextContents(), ['이 후보 1', '전체 1']);

        await p.fill('#right-dock textarea', 'half a question');
        await p.locator('#candidate-list li.selected .name').click();
        assert.equal(await p.inputValue('#right-dock textarea'), 'half a question');
        await p.click('#right-info .talk-scope button:nth-child(2)');
        assert.equal(await p.locator('#right-dock textarea').count(), 0);
        const row = p.locator('#candidate-list li.selected');
        await row.hover();
        await row.locator('.bubble').click();
        assert.equal(await p.inputValue('#right-dock textarea'), 'half a question');
        assert.deepEqual(errors, []);
      }));
  });
});

test('in a browser, once a candidate with comments is accepted or discarded, its comments show under 「떨어져 나감」 of the stories with the candidate name, and not under the screens', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, (config) => {
    addMark(config.marksDir, { target: { candidate: HELP_KEY }, note: 'why the beta inbox?', author: 'reviewer' });
    addMark(config.marksDir, { target: { candidate: TRACE_CANDIDATE }, note: 'which test gives this?', author: 'reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.equal(await p.locator('#left .detached li').count(), 0);
        await p.click('#candidate-list li:has-text("open-help")');
        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        await p.click('#candidate-list li:has-text("opens home and then help")');
        await discardCandidate(p, '도움말만 연다');
        await p.waitForSelector('#candidate-list li:has-text("opens home and then help")', { state: 'detached' });
        assert.deepEqual(await p.locator('#left .detached li').evaluateAll((items) => items.map((li) => [li.querySelector('code')!.textContent, li.querySelector('div')!.textContent])), [
          ['후보 opens home and then help', 'which test gives this?'],
          ['후보 open-help', 'why the beta inbox?'],
        ]);
        await p.click('#view-list');
        await p.waitForSelector('#screen-list li');
        assert.doesNotMatch((await p.textContent('#left'))!, /후보 open/);
      }));
  });
});
