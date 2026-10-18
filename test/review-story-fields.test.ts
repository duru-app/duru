import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { withRebuiltFixture, withServer, browserMissing, withPage, storiesTab, BAD_REQUEST } from './review-helpers.ts';
import type { Config } from './review-helpers.ts';

declare function drawLive(): void;
declare const events: EventSource;

const LAB = '실험실을 열어 결과를 본다';
const STEP_2 = '#center .story-path > .step[data-step="1"]';
const HOP_INTO_3 = '#center .story-path > .link[data-hop="1"]';
const STORY_BOX = '#center :is(.story-wide, .story-wide-blank)';
const EDIT = '.fields-edit';

const readStory = (config: Config) => JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'));
const editLabels = (p: Page, at: string) => p.locator(`${at} button.edit-fields`).evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
const lineValues = (rows: Element[]) => rows.map((r) => {
  const kind = r.querySelector<HTMLSelectElement>('select[aria-label="조건 적는 법"]')!;
  const use = r.querySelector<HTMLSelectElement>('select[aria-label="공통 조건"]');
  return [kind.selectedOptions[0].textContent, use ? use.selectedOptions[0].textContent : r.querySelector<HTMLInputElement>('input')!.value];
});
const MEMBER = { name: '일반 회원 계정', text: '역할 USER 로 가입한 계정' };
const DONE = { name: '완료된 문서 하나', text: '서명이 끝난 문서가 하나 있다' };
const NEEDS = { 'member-account.json': MEMBER, 'done-document.json': DONE };
const shownRows = (p: Page, at: string) => p.locator(`${at} .written-row`).evaluateAll((rows) => rows.map((r) => [r.querySelector('.written-label')!.textContent, [...r.querySelectorAll('li, tr')].map((li) => li.textContent)]));

async function withLabStory(fn: (p: Page, config: Config, errors: string[]) => Promise<void>, story?: object, needs: Record<string, object> = {}) {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) => {
    if (story) fs.writeFileSync(path.join(config.storiesDir, 'run-lab.json'), JSON.stringify(story, null, 2));
    for (const [file, need] of Object.entries(needs)) {
      fs.mkdirSync(path.join(config.storiesDir, 'needs'), { recursive: true });
      fs.writeFileSync(path.join(config.storiesDir, 'needs', file), JSON.stringify(need));
    }
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click(`#story-list li:has-text("${LAB}")`);
        await fn(p, config, errors);
      }));
  });
}

test('in a browser, a step card with nothing written shows only a pencil to write, whose table takes conditions, inputs found by one or more words and expected results, keeps what is typed when the page is drawn again, and 「저장」 writes them into the story file and draws the card again', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config) => {
    assert.deepEqual(await editLabels(p, STEP_2), ['이 단계의 조건 · 입력값 · 기대 결과 적기']);
    assert.equal(await p.locator(`${STEP_2} .step-written`).count(), 0);
    await p.click(`${STEP_2} button.edit-fields`);
    const edit = p.locator(`${STEP_2} ${EDIT}`);
    assert.deepEqual(await edit.locator('.fields-part h4').allTextContents(), ['조건', '입력값', '기대 결과']);
    assert.equal(await p.locator('#center button.edit-fields:not([disabled])').count(), 0, 'another place waits until this table is saved or cancelled');

    await edit.locator('button:has-text("조건 더하기")').click();
    await p.keyboard.type('실험실 설정을 켠다');
    await edit.locator('button:has-text("입력값 더하기")').click();
    assert.deepEqual(await edit.locator('.fields-part.inputs select option').allTextContents(), ['안내 글', '라벨', '테스트 ID']);
    await edit.locator('.fields-part.inputs select').selectOption({ label: '라벨' });
    await edit.locator('.fields-part.inputs input[aria-label="찾는 말"]').fill('실험 이름');
    await edit.locator('button:has-text("찾는 말 더하기")').click();
    assert.deepEqual(await edit.locator('.fields-part.inputs select').evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).value)), ['label', 'placeholder']);
    await edit.locator('.fields-part.inputs select').nth(1).selectOption({ label: '테스트 ID' });
    await edit.locator('.fields-part.inputs input[aria-label="찾는 말"]').nth(1).fill('lab-name');
    await edit.locator('input[aria-label="몇 번째"]').fill('2');
    await edit.locator('input[aria-label="값"]').fill('첫 실험');
    await edit.locator('button:has-text("기대 결과 더하기")').click();
    await p.keyboard.type('실험 목록이 보인다');
    await edit.locator('button:has-text("기대 결과 더하기")').click();
    await p.keyboard.type('지울 줄');
    await edit.locator('.fields-part.expects button:has-text("삭제")').nth(1).click();

    await edit.locator('.fields-part.needs input').focus();
    await p.keyboard.press('End');
    await p.keyboard.type('고');
    await p.evaluate(() => drawLive());
    assert.equal(await p.locator(`${STEP_2} ${EDIT} .fields-part.needs input`).inputValue(), '실험실 설정을 켠다고');
    assert.equal(await p.evaluate(() => (document.activeElement as HTMLInputElement).value), '실험실 설정을 켠다고', 'the focus stays in the field being typed in');
    await p.keyboard.press('Backspace');

    const before = fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8');
    await edit.locator('button.save-fields').click();
    await p.waitForSelector(`${STEP_2} .step-written`);
    assert.notEqual(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'), before);
    assert.deepEqual(readStory(config).screens, ['/home#Home', {
      screen: '/lab#Lab',
      needs: ['실험실 설정을 켠다'],
      inputs: [{ box: { label: '실험 이름', testId: 'lab-name', nth: 2 }, value: '첫 실험' }],
      expects: ['실험 목록이 보인다'],
    }, '/lab/result#LabResult']);
    assert.equal(await p.locator(EDIT).count(), 0);
    assert.deepEqual(await shownRows(p, STEP_2), [
      ['조건', ['실험실 설정을 켠다']],
      ['입력값', ['라벨 「실험 이름」 또는 테스트 ID 「lab-name」 · 2 번째첫 실험확인 안 됨']],
      ['기대 결과', ['실험 목록이 보인다']],
    ]);
    assert.equal(await p.textContent(`${STEP_2} .fields-saved`), '스토리 파일 run-lab.json 에 썼습니다');
    assert.deepEqual(await editLabels(p, STEP_2), ['이 단계의 조건 · 입력값 · 기대 결과 고치기']);
  });
});

test('in a browser, the pencil of a step card, a link row and the 「스토리 전체」 box shows only while the pointer is over its place or the keyboard is on it', { skip: browserMissing }, async () => {
  await withLabStory(async (p) => {
    const shown = (at: string) => p.locator(`${at} button.edit-fields`).evaluate((b) => getComputedStyle(b).opacity);
    for (const at of [STEP_2, HOP_INTO_3, STORY_BOX]) assert.equal(await shown(at), '0', at);
    await p.hover(STEP_2);
    assert.deepEqual([await shown(STEP_2), await shown(HOP_INTO_3)], ['1', '0']);
    await p.hover(HOP_INTO_3);
    assert.deepEqual([await shown(STEP_2), await shown(HOP_INTO_3)], ['0', '1']);
    await p.hover(STORY_BOX);
    assert.equal(await shown(STORY_BOX), '1');
    await p.mouse.move(0, 0);
    const target = `${STEP_2} button.edit-fields`;
    for (let i = 0; i < 300 && !(await p.evaluate((sel) => document.activeElement?.matches(sel), target)); i += 1) await p.keyboard.press('Tab');
    assert.equal(await shown(STEP_2), '1');
  });
});

test('in a browser, the link into a step and the 「스토리 전체」 box are written the same way, an existing pick of a need file is kept as it was, and emptying every line takes the fields out of the file', { skip: browserMissing }, async () => {
  const story = {
    name: LAB,
    screens: ['/home#Home', { screen: '/lab#Lab', needs: [{ use: 'member-account.json' }, '실험실 설정을 켠다'] }, '/lab/result#LabResult'],
    memo: '',
    author: 'Kim Min',
    date: '2026-10-01',
  };
  await withLabStory(async (p, config, errors) => {
    assert.deepEqual(await editLabels(p, HOP_INTO_3), ['들어오는 링크의 조건 적기']);
    await p.click(`${HOP_INTO_3} button.edit-fields`);
    assert.deepEqual(await p.locator(`${HOP_INTO_3} ${EDIT} .fields-part h4`).allTextContents(), ['들어오는 링크 조건']);
    await p.click(`${HOP_INTO_3} button:has-text("조건 더하기")`);
    await p.keyboard.type('실행이 끝난 경우');
    await p.click(`${HOP_INTO_3} button.save-fields`);
    await p.waitForSelector(`${HOP_INTO_3} .link-written`);
    assert.deepEqual(readStory(config).screens[2], { screen: '/lab/result#LabResult', linkNeeds: ['실행이 끝난 경우'] });
    assert.equal(await p.textContent(`${HOP_INTO_3} .fields-saved`), '스토리 파일 run-lab.json 에 썼습니다');

    assert.equal(await p.textContent(`${STORY_BOX} .story-wide-name`), '스토리 전체');
    assert.deepEqual(await editLabels(p, STORY_BOX), ['스토리 전체의 조건 · 기대 결과 적기']);
    await p.click(`${STORY_BOX} button.edit-fields`);
    assert.deepEqual(await p.locator(`${STORY_BOX} ${EDIT} .fields-part h4`).allTextContents(), ['조건', '끝난 뒤 기대 결과']);
    await p.click(`${STORY_BOX} button:has-text("조건 더하기")`);
    await p.keyboard.type('실험이 한 번 이상 돌았다');
    await p.click(`${STORY_BOX} button:has-text("기대 결과 더하기")`);
    await p.keyboard.type('마지막 실행 결과가 보인다');
    await p.click(`${STORY_BOX} button.save-fields`);
    await p.waitForSelector('#center .story-wide .written-row');
    assert.deepEqual([readStory(config).needs, readStory(config).expects], [['실험이 한 번 이상 돌았다'], ['마지막 실행 결과가 보인다']]);
    assert.deepEqual(await shownRows(p, '#center .story-wide'), [['조건', ['실험이 한 번 이상 돌았다']], ['끝난 뒤 기대 결과', ['마지막 실행 결과가 보인다']]]);

    await p.click(`${STEP_2} button.edit-fields`);
    assert.deepEqual(await p.locator(`${STEP_2} ${EDIT} .fields-part.needs tr`).evaluateAll(lineValues), [['공통 조건 고르기', 'needs/member-account.json 없음'], ['글로 적기', '실험실 설정을 켠다']]);
    await p.locator(`${STEP_2} ${EDIT} .fields-part.needs input`).fill('실험실 설정을 켠 뒤');
    await p.click(`${STEP_2} button.save-fields`);
    await p.waitForSelector(`${STEP_2} .fields-saved`);
    assert.deepEqual(readStory(config).screens[1], { screen: '/lab#Lab', needs: [{ use: 'member-account.json' }, '실험실 설정을 켠 뒤'] });

    await p.click(`${STEP_2} button.edit-fields`);
    for (let left = 2; left > 0; left--) await p.click(`${STEP_2} ${EDIT} .fields-part.needs button:has-text("삭제")`);
    await p.click(`${STEP_2} button.save-fields`);
    await p.waitForSelector(`${STEP_2} .fields-saved`);
    assert.equal(readStory(config).screens[1], '/lab#Lab');
    assert.deepEqual(await editLabels(p, STEP_2), ['이 단계의 조건 · 입력값 · 기대 결과 적기']);

    await p.click(`${STORY_BOX} button.edit-fields`);
    await p.click(`${STORY_BOX} .fields-part.needs button:has-text("삭제")`);
    await p.click(`${STORY_BOX} .fields-part.expects button:has-text("삭제")`);
    await p.click(`${STORY_BOX} button.save-fields`);
    await p.waitForSelector('#center .story-wide-blank .fields-saved');
    assert.deepEqual(Object.keys(readStory(config)), ['name', 'screens', 'memo', 'author', 'date']);
  }, story);
});

test('in a browser, 「취소」 closes the table and leaves the story file as it was', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config) => {
    const before = fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8');
    await p.click(`${STEP_2} button.edit-fields`);
    await p.click(`${STEP_2} button:has-text("조건 더하기")`);
    await p.keyboard.type('실험실 설정을 켠다');
    await p.click(`${STEP_2} button.cancel-fields`);
    assert.equal(await p.locator(EDIT).count(), 0);
    assert.equal(await p.locator(`${STEP_2} .step-written`).count(), 0);
    assert.deepEqual(await editLabels(p, STEP_2), ['이 단계의 조건 · 입력값 · 기대 결과 적기']);
    await p.waitForTimeout(300);
    assert.equal(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'), before);
  });
});

test('in a browser, a story file changed elsewhere after the table opened is redrawn around the table without losing what is typed, the save is refused with why, and 「덮어쓰기」 writes what is typed over the change', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config, errors) => {
    const file = path.join(config.storiesDir, 'run-lab.json');
    await p.click(`${STEP_2} button.edit-fields`);
    await p.click(`${STEP_2} button:has-text("조건 더하기")`);
    await p.keyboard.type('실험실 설정을 켠다');
    const elsewhere = { ...readStory(config), memo: '다른 곳에서 고쳤다' };
    fs.writeFileSync(file, JSON.stringify(elsewhere, null, 2));
    await p.waitForSelector('#center .memo:has-text("다른 곳에서 고쳤다")');
    assert.equal(await p.locator(`${STEP_2} ${EDIT} .fields-part.needs input`).inputValue(), '실험실 설정을 켠다');

    await p.click(`${STEP_2} button.save-fields`);
    await p.waitForSelector(`${STEP_2} .fields-error`);
    assert.equal(await p.textContent(`${STEP_2} .fields-error`), '저장하지 않았습니다: 스토리 파일 run-lab.json 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다. 바뀐 파일을 새로 읽거나, 지금 적은 내용으로 덮어쓸 수 있습니다.');
    assert.deepEqual(await p.locator(`${STEP_2} .fields-acts button`).allTextContents(), ['새로 읽기', '덮어쓰기', '취소']);
    assert.equal(await p.locator(`${STEP_2} ${EDIT} .fields-part.needs input`).inputValue(), '실험실 설정을 켠다');
    assert.deepEqual(readStory(config), elsewhere);
    assert.deepEqual(errors.splice(0), ['Failed to load resource: the server responded with a status of 409 (Conflict)']);

    await p.click(`${STEP_2} button.overwrite-fields`);
    await p.waitForSelector(`${STEP_2} .fields-saved`);
    assert.deepEqual(readStory(config), { ...elsewhere, screens: ['/home#Home', { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'] }, '/lab/result#LabResult'] });
  });
});

test('in a browser, after a save refused because the file changed elsewhere, 「새로 읽기」 fills the table from the changed file, drops what was typed, and the next 「저장」 writes over nothing', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config, errors) => {
    const file = path.join(config.storiesDir, 'run-lab.json');
    await p.click(`${STEP_2} button.edit-fields`);
    await p.click(`${STEP_2} button:has-text("조건 더하기")`);
    await p.keyboard.type('실험실 설정을 켠다');
    const story = readStory(config);
    const elsewhere = { ...story, screens: [story.screens[0], { screen: '/lab#Lab', needs: ['다른 곳에서 적은 조건'] }, story.screens[2]] };
    fs.writeFileSync(file, JSON.stringify(elsewhere, null, 2));
    await p.click(`${STEP_2} button.save-fields`);
    await p.waitForSelector(`${STEP_2} button.reread-fields`);
    assert.deepEqual(errors.splice(0), ['Failed to load resource: the server responded with a status of 409 (Conflict)']);

    await p.click(`${STEP_2} button.reread-fields`);
    assert.deepEqual(await p.locator(`${STEP_2} ${EDIT} .fields-part.needs input`).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)), ['다른 곳에서 적은 조건']);
    assert.equal(await p.locator(`${STEP_2} .fields-error`).count(), 0);
    assert.deepEqual(await p.locator(`${STEP_2} .fields-acts button`).allTextContents(), ['저장', '취소']);
    assert.deepEqual(readStory(config), elsewhere);

    await p.click(`${STEP_2} button:has-text("조건 더하기")`);
    await p.keyboard.type('실험실 설정을 켠다');
    await p.click(`${STEP_2} button.save-fields`);
    await p.waitForSelector(`${STEP_2} .fields-saved`);
    assert.deepEqual(readStory(config).screens[1], { screen: '/lab#Lab', needs: ['다른 곳에서 적은 조건', '실험실 설정을 켠다'] });
    assert.deepEqual(errors, []);
  });
});

test('in a browser, a wrong field is refused with the reason reading the file would give, and the table keeps what is typed', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config, errors) => {
    const before = fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8');
    await p.click(`${STEP_2} button.edit-fields`);
    await p.click(`${STEP_2} button:has-text("입력값 더하기")`);
    await p.locator(`${STEP_2} input[aria-label="찾는 말"]`).fill('서명자 메모');
    await p.locator(`${STEP_2} input[aria-label="몇 번째"]`).fill('0');
    await p.locator(`${STEP_2} input[aria-label="값"]`).fill('확인했습니다');
    await p.click(`${STEP_2} button.save-fields`);
    await p.waitForSelector(`${STEP_2} .fields-error`);
    assert.equal(await p.textContent(`${STEP_2} .fields-error`), '저장하지 않았습니다: screens 의 2 번째 단계의 1 번째 입력값의 box 의 nth 는 1 이상의 정수여야 합니다');
    assert.deepEqual(await p.locator(`${STEP_2} ${EDIT} input`).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)), ['서명자 메모', '0', '확인했습니다']);
    assert.deepEqual(errors.splice(0), [BAD_REQUEST]);
    assert.equal(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'), before);
  });
});

test('in a browser, saving the story\'s own name and memo while a table is open does not make the table\'s save look like a change made elsewhere, but a change made elsewhere before it still does', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config, errors) => {
    const file = path.join(config.storiesDir, 'run-lab.json');
    await p.click(`${STEP_2} button.edit-fields`);
    await p.click(`${STEP_2} button:has-text("조건 더하기")`);
    await p.keyboard.type('실험실 설정을 켠다');
    await p.fill('#story-name', '실험실 결과를 본다');
    await p.click('#right button.save-story');
    await p.waitForSelector(`#center h3:has-text("실험실 결과를 본다")`);
    await p.click(`${STEP_2} button.save-fields`);
    await p.waitForSelector(`${STEP_2} .fields-saved`);
    assert.deepEqual([readStory(config).name, readStory(config).screens[1]], ['실험실 결과를 본다', { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'] }]);

    await p.click(`${STEP_2} button.edit-fields`);
    await p.click(`${STEP_2} button:has-text("기대 결과 더하기")`);
    await p.keyboard.type('실험 목록이 보인다');
    fs.writeFileSync(file, JSON.stringify({ ...readStory(config), memo: '다른 곳에서 고쳤다' }, null, 2));
    await p.waitForSelector('#center .memo:has-text("다른 곳에서 고쳤다")');
    await p.fill('#story-name', '실험실 결과를 확인한다');
    await p.click('#right button.save-story');
    await p.waitForSelector(`#center h3:has-text("실험실 결과를 확인한다")`);
    await p.click(`${STEP_2} button.save-fields`);
    await p.waitForSelector(`${STEP_2} .fields-error`);
    assert.match((await p.textContent(`${STEP_2} .fields-error`))!, /읽은 뒤에 바뀌어 덮어쓰지 않았습니다/);
    assert.deepEqual(errors.splice(0), ['Failed to load resource: the server responded with a status of 409 (Conflict)']);
  });
});

test('in a browser, choosing another story while a table is open closes it, so the other story\'s places can be written', { skip: browserMissing }, async () => {
  await withLabStory(async (p) => {
    await p.click(`${STEP_2} button.edit-fields`);
    await p.click(`${STEP_2} button:has-text("조건 더하기")`);
    await p.click('#story-list li:has-text("홈에서 바로 도움말을 연다")');
    assert.equal(await p.locator('#center button.edit-fields[disabled]').count(), 0);
    assert.ok(await p.locator('#center button.edit-fields').count() > 0);
    await p.click(`#story-list li:has-text("${LAB}")`);
    assert.equal(await p.locator(EDIT).count(), 0);
  });
});

test('in a browser, a save refused because the file changed elsewhere says so without promising that saving again overwrites when the stories could not be read again', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config, errors) => {
    await p.click(`${STEP_2} button.edit-fields`);
    await p.click(`${STEP_2} button:has-text("조건 더하기")`);
    await p.keyboard.type('실험실 설정을 켠다');
    await p.route('**/api/data', (route) => route.fulfill({ status: 500, body: '읽기 실패' }));
    fs.writeFileSync(path.join(config.storiesDir, 'run-lab.json'), JSON.stringify({ ...readStory(config), memo: '다른 곳에서 고쳤다' }, null, 2));
    await p.click(`${STEP_2} button.save-fields`);
    await p.waitForSelector(`${STEP_2} .fields-error`);
    assert.equal(await p.textContent(`${STEP_2} .fields-error`), '저장하지 않았습니다: 스토리 파일 run-lab.json 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다. 바뀐 파일을 다시 읽지 못했습니다: 읽기 실패');
    assert.equal(await p.locator(`${STEP_2} ${EDIT} .fields-part.needs input`).inputValue(), '실험실 설정을 켠다');
    errors.splice(0);
  });
});

test('in a browser, saving the story\'s name and memo over a file changed on disk that the page has not read again does not let the open table write over that change', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config, errors) => {
    await p.evaluate(() => events.close());
    await p.click(`${STEP_2} button.edit-fields`);
    await p.click(`${STEP_2} button:has-text("조건 더하기")`);
    await p.keyboard.type('실험실 설정을 켠다');
    fs.writeFileSync(path.join(config.storiesDir, 'run-lab.json'), JSON.stringify({ ...readStory(config), expects: ['다른 곳에서 적은 기대 결과'] }, null, 2));
    await p.fill('#story-name', '실험실 결과를 본다');
    await p.click('#right button.save-story');
    await p.waitForSelector(`#center h3:has-text("실험실 결과를 본다")`);
    await p.click(`${STEP_2} button.save-fields`);
    await p.waitForSelector(`${STEP_2} .fields-error`);
    assert.match((await p.textContent(`${STEP_2} .fields-error`))!, /읽은 뒤에 바뀌어 덮어쓰지 않았습니다/);
    assert.deepEqual([readStory(config).expects, readStory(config).screens[1]], [['다른 곳에서 적은 기대 결과'], '/lab#Lab']);
    assert.deepEqual(errors.splice(0), ['Failed to load resource: the server responded with a status of 409 (Conflict)']);
  });
});

test('in a browser, an open table whose step shows another screen after the file changed elsewhere is closed with a notice that what was typed was not saved', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config) => {
    await p.click(`${STEP_2} button.edit-fields`);
    await p.click(`${STEP_2} button:has-text("조건 더하기")`);
    await p.keyboard.type('실험실 설정을 켠다');
    const elsewhere = { ...readStory(config), screens: ['/home#Home', '/lab/result#LabResult'] };
    fs.writeFileSync(path.join(config.storiesDir, 'run-lab.json'), JSON.stringify(elsewhere, null, 2));
    await p.waitForSelector('#right .story-error');
    assert.equal(await p.textContent('#right .story-error'), '2 번째 단계가 다른 곳에서 바뀌어 열린 표를 닫았습니다. 표에 적던 내용은 저장하지 않았습니다.');
    assert.equal(await p.locator(EDIT).count(), 0);
    assert.equal(await p.locator('#center button.edit-fields[disabled]').count(), 0);
    assert.deepEqual(readStory(config), elsewhere);
  });
});

const KIND = 'select[aria-label="조건 적는 법"]';
const USE = 'select[aria-label="공통 조건"]';

test('in a browser, each condition line chooses 「글로 적기」 or 「공통 조건 고르기」, picking lists the need files with 「새 공통 조건 만들기…」 last, going back to writing keeps the text, and 「저장」 writes the pick as { "use" } into the story file', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config) => {
    await p.click(`${STEP_2} button.edit-fields`);
    const edit = p.locator(`${STEP_2} ${EDIT}`);
    await edit.locator('button:has-text("조건 더하기")').click();
    await p.keyboard.type('실험실 설정을 켠다');
    assert.deepEqual(await edit.locator(`${KIND} option`).allTextContents(), ['글로 적기', '공통 조건 고르기']);
    await edit.locator(KIND).selectOption({ label: '공통 조건 고르기' });
    assert.deepEqual(await edit.locator(`${USE} option`).allTextContents(), ['고르지 않음', '완료된 문서 하나 (done-document.json)', '일반 회원 계정 (member-account.json)', '새 공통 조건 만들기…']);
    await edit.locator(KIND).selectOption({ label: '글로 적기' });
    assert.equal(await edit.locator('.fields-part.needs input').inputValue(), '실험실 설정을 켠다');
    await edit.locator('button:has-text("조건 더하기")').click();
    await edit.locator(KIND).nth(1).selectOption({ label: '공통 조건 고르기' });
    await edit.locator(USE).selectOption({ label: '일반 회원 계정 (member-account.json)' });
    await edit.locator('button:has-text("조건 더하기")').click();
    await edit.locator(KIND).nth(2).selectOption({ label: '공통 조건 고르기' });
    assert.deepEqual(await edit.locator('.fields-part.needs tr').evaluateAll(lineValues), [['글로 적기', '실험실 설정을 켠다'], ['공통 조건 고르기', '일반 회원 계정 (member-account.json)'], ['공통 조건 고르기', '고르지 않음']]);

    await edit.locator('button.save-fields').click();
    await p.waitForSelector(`${STEP_2} .fields-saved`);
    assert.deepEqual(readStory(config).screens[1], { screen: '/lab#Lab', needs: ['실험실 설정을 켠다', { use: 'member-account.json' }] });
    assert.deepEqual(await shownRows(p, STEP_2), [['조건', ['실험실 설정을 켠다', '공통 조건 일반 회원 계정']]]);
  }, undefined, NEEDS);
});

test('in a browser, 「새 공통 조건 만들기…」 opens fields for a file name, a name and a text in the line, 「만들기」 writes the need file and the line picks it, a refused file keeps what was typed with why, and 「그만두기」 closes the fields', { skip: browserMissing }, async () => {
  await withLabStory(async (p, config, errors) => {
    await p.click(`${STEP_2} button.edit-fields`);
    const edit = p.locator(`${STEP_2} ${EDIT}`);
    await edit.locator('button:has-text("조건 더하기")').click();
    await edit.locator(KIND).selectOption({ label: '공통 조건 고르기' });
    await edit.locator(USE).selectOption({ label: '새 공통 조건 만들기…' });
    const make = edit.locator('.new-need');
    assert.equal(await p.evaluate(() => (document.activeElement as HTMLInputElement).getAttribute('aria-label')), '새 공통 조건 파일 이름');
    assert.equal(await edit.locator('button.save-fields').isDisabled(), true, 'the table waits until the need is made or dropped');
    await make.locator('button.drop-need').click();
    assert.equal(await edit.locator('.new-need').count(), 0);
    assert.deepEqual(await edit.locator('.fields-part.needs tr').evaluateAll(lineValues), [['공통 조건 고르기', '고르지 않음']]);

    await edit.locator(USE).selectOption({ label: '새 공통 조건 만들기…' });
    await make.locator('input[aria-label="새 공통 조건 파일 이름"]').fill('member-account');
    await make.locator('input[aria-label="새 공통 조건 이름"]').fill('관리자 계정');
    await make.locator('textarea[aria-label="새 공통 조건 내용"]').fill('역할 ADMIN 으로 가입한 계정');
    await make.locator('button.make-need').click();
    await p.waitForSelector(`${STEP_2} .new-need .error`);
    assert.equal(await p.textContent(`${STEP_2} .new-need .error`), '만들지 못했습니다: 공통 조건 파일 needs/member-account.json 이 이미 있습니다');
    assert.deepEqual(errors.splice(0), [BAD_REQUEST]);
    assert.equal(await make.locator('textarea').inputValue(), '역할 ADMIN 으로 가입한 계정');

    await make.locator('input[aria-label="새 공통 조건 파일 이름"]').fill('admin-account');
    await make.locator('button.make-need').click();
    await p.waitForSelector(`${STEP_2} ${EDIT} .new-need`, { state: 'detached' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'needs/admin-account.json'), 'utf8')), { name: '관리자 계정', text: '역할 ADMIN 으로 가입한 계정' });
    assert.deepEqual(await edit.locator('.fields-part.needs tr').evaluateAll(lineValues), [['공통 조건 고르기', '관리자 계정 (admin-account.json)']]);
    assert.ok((await p.locator('#need-list li').allTextContents()).some((t) => t.includes('관리자 계정')));
    assert.equal(readStory(config).screens[1], '/lab#Lab', 'making a need does not write the story');

    await edit.locator('button.save-fields').click();
    await p.waitForSelector(`${STEP_2} .fields-saved`);
    assert.deepEqual(readStory(config).screens[1], { screen: '/lab#Lab', needs: [{ use: 'admin-account.json' }] });
  }, undefined, { 'member-account.json': MEMBER });
});

test('in a browser, only condition lines choose between writing and picking a need file, and an expected result line is text only', { skip: browserMissing }, async () => {
  await withLabStory(async (p) => {
    await p.click(`${STEP_2} button.edit-fields`);
    const edit = p.locator(`${STEP_2} ${EDIT}`);
    await edit.locator('button:has-text("조건 더하기")').click();
    await edit.locator('button:has-text("기대 결과 더하기")').click();
    assert.equal(await edit.locator(`.fields-part.needs ${KIND}`).count(), 1);
    assert.equal(await edit.locator('.fields-part.expects select').count(), 0);
    assert.equal(await edit.locator('.fields-part.expects input').count(), 1);
    await edit.locator('button.cancel-fields').click();
    await p.click(`${HOP_INTO_3} button.edit-fields`);
    await p.click(`${HOP_INTO_3} button:has-text("조건 더하기")`);
    assert.equal(await p.locator(`${HOP_INTO_3} ${EDIT} .fields-part.link-needs ${KIND}`).count(), 1);
  }, undefined, NEEDS);
});

test('in a browser, a written condition switched to 「공통 조건 고르기」 and left without a pick is not saved: the table stays open and names the line, and a blank line is still left out', { skip: browserMissing }, async () => {
  const story = { name: LAB, screens: ['/home#Home', { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'] }, '/lab/result#LabResult'], memo: '', author: 'Kim Min', date: '2026-10-01' };
  await withLabStory(async (p, config, errors) => {
    const before = fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8');
    await p.click(`${STEP_2} button.edit-fields`);
    const edit = p.locator(`${STEP_2} ${EDIT}`);
    await edit.locator('button:has-text("조건 더하기")').click();
    await edit.locator(KIND).nth(1).selectOption({ label: '공통 조건 고르기' });
    await edit.locator(KIND).nth(1).selectOption({ label: '글로 적기' });
    await edit.locator(KIND).first().selectOption({ label: '공통 조건 고르기' });
    await edit.locator('button.save-fields').click();
    assert.equal(await p.textContent(`${STEP_2} .fields-error`), '저장하지 않았습니다: 조건의 1 번째 줄에서 공통 조건을 고르지 않았습니다');
    assert.equal(await p.locator(`${STEP_2} ${EDIT}`).count(), 1);
    assert.equal(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'), before);
    assert.deepEqual(errors, []);

    await edit.locator(KIND).first().selectOption({ label: '글로 적기' });
    await edit.locator('button.save-fields').click();
    await p.waitForSelector(`${STEP_2} .fields-saved`);
    assert.deepEqual(readStory(config).screens[1], { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'] });
  }, story, NEEDS);
});

test('in a browser, a line picking a need file that is not there shows 「needs/… 없음」 as a step card does, and can pick another need file instead', { skip: browserMissing }, async () => {
  const story = { name: LAB, screens: ['/home#Home', { screen: '/lab#Lab', needs: [{ use: 'old-admin.json' }] }, '/lab/result#LabResult'], memo: '', author: 'Kim Min', date: '2026-10-01' };
  await withLabStory(async (p, config) => {
    await p.click(`${STEP_2} button.edit-fields`);
    const edit = p.locator(`${STEP_2} ${EDIT}`);
    assert.deepEqual(await edit.locator(`${USE} option`).allTextContents(), ['needs/old-admin.json 없음', '완료된 문서 하나 (done-document.json)', '일반 회원 계정 (member-account.json)', '새 공통 조건 만들기…']);
    await edit.locator(USE).selectOption({ label: '완료된 문서 하나 (done-document.json)' });
    await edit.locator('button.save-fields').click();
    await p.waitForSelector(`${STEP_2} .fields-saved`);
    assert.deepEqual(readStory(config).screens[1], { screen: '/lab#Lab', needs: [{ use: 'done-document.json' }] });
  }, story, NEEDS);
});
