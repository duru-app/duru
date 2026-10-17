import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { withRebuiltFixture, withServer, browserMissing, withPage, storiesTab, postJson, postMark, untilSet, CANDIDATES } from './review-helpers.ts';
import type { Config, PageData } from './review-helpers.ts';

declare const state: any;

const LAB = '실험실을 열어 결과를 본다';
const HOME = '/home#Home';
const LAB_SCREEN = '/lab#Lab';
const RESULT = '/lab/result#LabResult';
const LAB_STEP = { screen: LAB_SCREEN, needs: ['실험실 설정을 켠다'] };
const RESULT_STEP = { screen: RESULT, linkNeeds: ['실행이 끝난 경우'], expects: ['결과 표가 보인다'] };
const FILLED = { name: LAB, screens: [HOME, LAB_STEP, RESULT_STEP], memo: '', author: 'Kim Min', date: '2026-10-01' };
const CARDS = '#center .story-path > .step.order-step';
const card = (i: number) => `${CARDS}[data-step="${i}"]`;

const readStory = (config: Config) => JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'));
const pickScreen = (p: Page, routePath: string) => p.locator('#pick-list li').filter({ has: p.locator('.name > span:first-child', { hasText: new RegExp(`^${routePath}$`) }) }).click();
const cardScreens = (p: Page) => p.locator(`${CARDS} .screen-path`).allTextContents();
const untilJudged = (p: Page) => p.waitForFunction(() => !document.querySelector('#center .link.l-pending') && document.querySelectorAll('#center .story-path > .link').length === Math.max(document.querySelectorAll('#center .story-path > .step').length - 1, 0));

async function withLabStory(fn: (p: Page, config: Config, base: string, errors: string[]) => Promise<void>, story: object | null = FILLED) {
  await withRebuiltFixture(CANDIDATES, (config) => {
    if (story) fs.writeFileSync(path.join(config.storiesDir, 'run-lab.json'), JSON.stringify(story, null, 2));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click(`#story-list li:has-text("${LAB}")`);
        await fn(p, config, base, errors);
      }));
  });
}

test('in a browser, 「순서 고치기」 at the end of the 「화면 순서」 heading turns the left column into a screen picker and gives each step only 「앞에 넣기」 and 「빼기」, with nothing to move or drag, and 「순서 저장」 writes the new order with each kept step\'s fields on it and the comments on a step that is gone under 「떨어져 나감」', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config, base, errors) => {
    const onStep = (step: number, screen: string) => ({ story: 'run-lab', part: { kind: 'step', key: { step, screen } } });
    for (const [target, note] of [[onStep(1, HOME), 'start here?'], [onStep(2, LAB_SCREEN), 'lab on?']] as const) assert.equal((await postMark(base, { target, note })).status, 201);
    await p.reload();
    await p.waitForSelector('#story-list li.selected');
    assert.deepEqual(await p.locator('#center .path-head').evaluate((row) => [...row.children].map((c) => c.textContent)), ['화면 순서 3', '순서 고치기']);
    await p.click('#center button.reorder');
    await p.waitForSelector('#pick-list li');
    assert.equal(await p.textContent('#left .compose-head'), `「${LAB}」에 넣을 화면`);
    assert.equal(await p.textContent('#center .path-head .editing-note'), '순서 고치는 중');
    for (let i = 0; i < 3; i++) assert.deepEqual(await p.locator(`${card(i)} .step-acts button`).allTextContents(), ['앞에 넣기', '빼기']);
    assert.equal(await p.locator('#center .story-path [draggable="true"], #center .story-path .grip, #center .story-path button:is(.up, .down)').count(), 0);
    assert.deepEqual(await p.locator(`${card(1)} .written-row`).allTextContents(), ['조건실험실 설정을 켠다']);
    assert.deepEqual(await p.locator('#right-info .steps-top button').allTextContents(), ['순서 저장', '취소']);
    assert.equal(await p.locator('#right-info .steps-top button.save-steps').isDisabled(), true, 'nothing changed yet');

    await p.click(`${card(1)} button.insert-before`);
    await pickScreen(p, '/help');
    assert.deepEqual(await cardScreens(p), ['/home', '/help', '/lab', '/lab/result']);
    await p.click('#center .insert-mark button.insert-at-end');
    await pickScreen(p, '/signin');
    await p.click(`${card(0)} button.remove`);
    assert.deepEqual(await cardScreens(p), ['/help', '/lab', '/lab/result', '/signin']);
    assert.equal(await p.locator(`${card(0)}.new-step`).count(), 1);
    assert.equal(await p.locator(`${card(0)} .written-row`).count(), 0, 'a step put in has nothing written');
    await untilJudged(p);
    assert.equal(await p.locator('#center .link-lost').count(), 0, 'the link into the last step of the file still leaves the step it had');
    assert.deepEqual(await p.locator('#center .story-file pre').evaluate((pre) => JSON.parse(pre.textContent!).screens), ['/help#Help', LAB_STEP, RESULT_STEP, '/signin#SignIn']);

    await p.click('#right-info button.save-steps');
    await p.waitForSelector('#center .steps-saved');
    assert.deepEqual(readStory(config).screens, ['/help#Help', LAB_STEP, RESULT_STEP, '/signin#SignIn']);
    assert.equal(await p.textContent('#center .steps-saved'), '스토리 파일 run-lab.json 에 썼습니다');
    assert.equal(await p.locator('#pick-list').count(), 0);
    assert.deepEqual(await p.locator('#center .story-path > .step .screen-path').allTextContents(), ['/help', '/lab', '/lab/result', '/signin']);
    assert.deepEqual(await p.locator(`#center .story-path > .step[data-step="2"] .written-row`).allTextContents(), ['기대 결과결과 표가 보인다']);
    assert.deepEqual(await p.locator('#left .detached li div').allTextContents(), ['start here?']);
    const data: PageData = await (await fetch(`${base}/api/data`)).json();
    assert.ok(data.marks.attached.some((m) => JSON.stringify(m.target) === JSON.stringify(onStep(2, LAB_SCREEN))), 'a step whose number still holds its screen keeps its comment');
    assert.deepEqual(errors, []);
  });
});

test('in a browser, an order with the same screen twice in a row or with no step is not saved and says why, and a screen next to itself is refused when put in', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config) => {
    const before = fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8');
    await p.click('#center button.reorder');
    await p.click(`${card(1)} button.insert-before`);
    await pickScreen(p, '/home');
    assert.equal(await p.textContent('#center .steps-refused'), '같은 화면을 이어서 넣을 수 없습니다.');
    await p.click('#center .insert-mark button.insert-at-end');
    await pickScreen(p, '/home');
    await p.click(`${card(2)} button.remove`);
    await p.click(`${card(1)} button.remove`);
    assert.deepEqual(await cardScreens(p), ['/home', '/home']);
    assert.equal(await p.textContent('#right-info .steps-problem'), '같은 화면이 이어진 자리가 있어 저장할 수 없습니다.');
    assert.equal(await p.locator('#right-info button.save-steps').isDisabled(), true);
    await p.click(`${card(1)} button.remove`);
    await p.click(`${card(0)} button.remove`);
    assert.equal(await p.textContent('#center .no-steps'), '단계가 하나도 없습니다.');
    assert.equal(await p.textContent('#right-info .steps-problem'), '단계가 하나도 없어 저장할 수 없습니다.');
    assert.equal(await p.locator('#right-info button.save-steps').isDisabled(), true);
    await p.click('#right-info button.cancel-steps');
    assert.deepEqual(await p.locator('#center .story-path > .step .screen-path').allTextContents(), ['/home', '/lab', '/lab/result']);
    assert.equal(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'), before);
  }, null);
});

test('in a browser, taking out a step with fields written asks first with what goes with it, also when 빼기 is pressed twice, and a step whose step before changed shows that the conditions of the link into it will go', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config) => {
    await p.click('#center button.reorder');
    await p.dblclick(`${card(1)} button.remove`);
    assert.deepEqual(await cardScreens(p), ['/home', '/lab', '/lab/result'], 'pressing 빼기 again does not take the place of 그래도 빼기');
    assert.equal(await p.textContent(`${card(1)} .remove-warn span`), '빼면 이 단계에 적은 조건 1개와 다음 단계로 들어오는 링크 조건 1개도 함께 지워집니다.');
    assert.deepEqual(await p.locator(`${card(1)} .remove-warn button`).allTextContents(), ['그래도 빼기', '두기']);
    await p.click(`${card(1)} .remove-warn button.keep`);
    assert.equal(await p.locator('#center .remove-warn').count(), 0);
    assert.deepEqual(await cardScreens(p), ['/home', '/lab', '/lab/result']);

    await p.click(`${card(2)} button.remove`);
    assert.equal(await p.textContent(`${card(2)} .remove-warn span`), '빼면 이 단계에 적은 기대 결과 1개 · 들어오는 링크 조건 1개도 함께 지워집니다.');
    await p.click(`${card(1)} button.remove`);
    assert.equal(await p.locator(`${card(1)} .remove-warn`).count(), 1, 'the warning moves to the step pressed last');
    assert.equal(await p.locator(`${card(2)} .remove-warn`).count(), 0);
    await p.click(`${card(1)} .remove-warn button.remove-anyway`);
    assert.deepEqual(await cardScreens(p), ['/home', '/lab/result']);
    assert.equal(await p.textContent('#center .story-path > .link .link-lost'), '앞 단계가 바뀌어, 저장하면 들어오는 링크 조건 1개가 지워집니다.');
    await untilJudged(p);
    let saves = 0;
    p.on('request', (r) => { if (r.url().endsWith('/api/stories/steps')) saves += 1; });
    await p.dblclick('#right-info button.save-steps');
    await p.waitForSelector('#center .steps-saved');
    assert.equal(saves, 1, 'a second press while saving sends nothing');
    assert.deepEqual(readStory(config).screens, [HOME, { screen: RESULT, expects: ['결과 표가 보인다'] }]);
  });
});

test('in a browser, only one editor is open at a time: while the order is being changed the pencils wait, and while a table is open 「순서 고치기」 waits', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config) => {
    const before = fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8');
    await p.click('#center button.reorder');
    const pencils = p.locator('#center button.edit-fields');
    assert.ok(await pencils.count() > 0);
    assert.equal(await p.locator('#center button.edit-fields:not([disabled])').count(), 0);
    assert.equal(await pencils.first().getAttribute('title'), '화면 순서를 저장하거나 취소한 뒤에 고칩니다');
    await p.click(`${card(1)} button.remove`);
    await p.click('#right-info button.cancel-steps');
    assert.equal(await p.locator('#pick-list').count(), 0);
    assert.equal(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'), before);

    await p.click('#center .story-path > .step[data-step="1"] button.edit-fields');
    assert.equal(await p.locator('#center button.reorder').isDisabled(), true);
    assert.equal(await p.getAttribute('#center button.reorder', 'title'), '열린 표를 저장하거나 취소한 뒤에 순서를 고칩니다');
    await p.click('#center .fields-edit button.cancel-fields');
    assert.equal(await p.locator('#center button.reorder').isDisabled(), false);
  });
});

test('in a browser, an order saved over a story file changed elsewhere is refused with why, and 「덮어쓰기」 writes the order over the change while keeping what the change wrote on the kept steps', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config, _base, errors) => {
    const file = path.join(config.storiesDir, 'run-lab.json');
    await p.click('#center button.reorder');
    await p.click(`${card(0)} button.remove`);
    const elsewhere = { ...FILLED, memo: '다른 곳에서 고쳤다', screens: [HOME, { ...LAB_STEP, expects: ['실험 목록이 보인다'] }, RESULT_STEP] };
    fs.writeFileSync(file, JSON.stringify(elsewhere, null, 2));
    await p.waitForSelector('#center .memo:has-text("다른 곳에서 고쳤다")');
    assert.deepEqual(await cardScreens(p), ['/lab', '/lab/result'], 'the order being changed stays');
    await untilJudged(p);

    await p.click('#right-info button.save-steps');
    await p.waitForSelector('#right-info .steps-error');
    assert.equal(await p.textContent('#right-info .steps-error'), '저장하지 않았습니다: 스토리 파일 run-lab.json 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다. 바뀐 파일을 새로 읽거나, 지금 적은 내용으로 덮어쓸 수 있습니다.');
    assert.deepEqual(await p.locator('#right-info .steps-top button').allTextContents(), ['새로 읽기', '덮어쓰기', '취소']);
    assert.deepEqual(readStory(config), elsewhere);
    assert.deepEqual(errors.splice(0), ['Failed to load resource: the server responded with a status of 409 (Conflict)']);

    await p.click('#right-info button.overwrite-steps');
    await p.waitForSelector('#center .steps-saved');
    assert.deepEqual(readStory(config), { ...elsewhere, screens: [{ screen: LAB_SCREEN, needs: ['실험실 설정을 켠다'], expects: ['실험 목록이 보인다'] }, RESULT_STEP] });
  });
});

test('in a browser, after a refused order save 「새로 읽기」 starts again from the changed file', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config, _base, errors) => {
    await p.click('#center button.reorder');
    await p.click(`${card(0)} button.remove`);
    fs.writeFileSync(path.join(config.storiesDir, 'run-lab.json'), JSON.stringify({ ...FILLED, screens: [HOME, LAB_SCREEN] }, null, 2));
    await p.waitForFunction(() => state.data.stories.list.find((s: { id: string }) => s.id === 'run-lab').steps.length === 2);
    await p.click('#right-info button.save-steps');
    await p.waitForSelector('#right-info button.reread-steps');
    errors.splice(0);
    await p.click('#right-info button.reread-steps');
    assert.deepEqual(await cardScreens(p), ['/home', '/lab']);
    assert.equal(await p.locator('#right-info button.save-steps').isDisabled(), true);
  });
});

test('in a browser, 「받기 되돌리기」 on a story with fields written says in its title and in a question that the fields go with the file, and does nothing when the question is turned down', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        const plain = await p.getAttribute('#right button.unaccept', 'title');
        assert.doesNotMatch(plain!, /조건 · 입력값 · 기대 결과/);
        const data: PageData = await (await fetch(`${base}/api/data`)).json();
        const st = data.stories.list.find((s) => s.id === 'open-help')!;
        const res = await postJson(base, '/api/stories/fields', { id: 'open-help', place: { kind: 'story' }, fields: { expects: ['도움말이 열린다'] }, contentHash: st.contentHash });
        assert.equal(res.status, 200);
        await p.waitForSelector('#center .story-wide .written-row');
        assert.equal(await p.getAttribute('#right button.unaccept', 'title'), '스토리 파일을 지우고, 같은 화면 순서를 후보 목록에 다시 올립니다. 이 스토리에 적은 조건 · 입력값 · 기대 결과도 파일과 함께 사라집니다. 이 스토리에 남은 코멘트는 「떨어져 나감」으로 갑니다.');

        const asked: string[] = [];
        p.once('dialog', (d) => { asked.push(d.message()); void d.dismiss(); });
        await p.click('#right button.unaccept');
        await untilSet(() => asked.length === 1, 'the question');
        assert.deepEqual(asked, ['받기를 되돌리면 스토리 파일 open-help.json 을 지우므로, 이 스토리에 적은 조건 · 입력값 · 기대 결과도 함께 사라집니다. 그래도 되돌릴까요?']);
        assert.equal(fs.existsSync(path.join(config.storiesDir, 'open-help.json')), true);
        p.once('dialog', (d) => void d.accept());
        await p.click('#right button.unaccept');
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        assert.equal(fs.existsSync(path.join(config.storiesDir, 'open-help.json')), false);
      })));
});
