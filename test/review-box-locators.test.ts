import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { Frame, Page } from 'playwright-core';
import { answerReviewPage } from '../src/app-host.ts';
import { fillCode, readTrace } from '../src/playwright-trace.ts';
import type { StepInput } from '../src/stories.ts';
import { browserMissing } from './review-helpers.ts';

const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (page: Page | Frame) => Promise<void>;
const runFill = (page: Page | Frame, input: StepInput) => new AsyncFunction('page', fillCode(input))(page);

test('the fill code of an input is the same whatever order the box words are written in', () => {
  const words = { placeholder: '메모장', label: '메모', testId: 'memo-b' };
  const orders = [words, { testId: 'memo-b', label: '메모', placeholder: '메모장' }, { label: '메모', testId: 'memo-b', placeholder: '메모장' }];
  assert.deepEqual(new Set(orders.map((box) => fillCode({ box: { ...box, nth: 2 }, value: 'v' }))), new Set([
    'await page.getByPlaceholder("메모장", { exact: true }).and(page.getByLabel("메모", { exact: true })).and(page.getByTestId("memo-b")).nth(1).fill("v");',
  ]));
});

const INPUTS = path.join(import.meta.dirname, 'fixtures/app/traces/inputs.zip');
const RECORDED_PAGE = `<!doctype html><title>t</title><body>
<label>메모 <input id="memo"></label><label>메모 <input id="memo2"></label>
<input placeholder="이름"><input data-testid="amount"><input id="css"><label>코드 <input></label>
<select id="sel"><option>가</option><option>나</option></select><input type="checkbox" id="chk"><input type="file" id="file"><input placeholder=" ">
<label>따옴표 "큰" <input></label>
<button onclick="history.pushState({}, '', '/document/draft'); document.body.insertAdjacentHTML('beforeend','<input placeholder=\\'제목\\'>')">go</button></body>`;

test('in a browser, the fill code of each input read from a trace fills the box the recorded test filled', { skip: browserMissing }, async () => {
  const steps = (readTrace(INPUTS) as Extract<ReturnType<typeof readTrace>, { steps: unknown }>).steps;
  const inputs = steps.flatMap((s) => (s.input ? [s.input] : []));
  const filled = ['#memo', '#memo2', 'input[placeholder="이름"]', 'input[data-testid="amount"]', 'label:has-text("따옴표") input', 'input[placeholder="제목"]'];
  assert.equal(inputs.length, filled.length);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.route('http://127.0.0.1:4598/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: RECORDED_PAGE }));
    await page.goto('http://127.0.0.1:4598/home');
    for (const [i, input] of inputs.entries()) {
      if (input.box.placeholder === '제목') await page.getByRole('button', { name: 'go' }).click();
      await runFill(page, input);
      assert.equal(await page.locator(filled[i]).inputValue(), input.value, fillCode(input));
      assert.equal(await page.locator('input').evaluateAll((els, value) => els.filter((e) => (e as HTMLInputElement).value === value).length, input.value), 1, fillCode(input));
    }
  } finally {
    await browser.close();
  }
});

const SHARED_WORDS_PAGE = `<!doctype html><meta charset="utf-8"><body>
<label for="a1">메모</label><input id="a1"><label for="a2">서명자 메모</label><input id="a2">
<label for="b1">비고</label><input id="b1"><label for="b2">비고</label><input id="b2">
<label for="c1">Note</label><input id="c1"><label for="c2">  my
   note  </label><input id="c2">
<label for="d1">내용</label><input id="d1" placeholder="내용을 적으세요"><label for="d2">내용</label><input id="d2">
<label for="e1">우편번호</label><input id="e1" aria-label="zip">
<span id="f-cap">주소</span><input id="f1" aria-labelledby="f-cap">
<label>전화 <input id="g1"> (필수)</label>
<input id="h1" aria-label="검색"><button id="h2" aria-label="검색">찾기</button>
<input id="i1" placeholder="이름"><div data-testid="email"><input id="i2" data-testid="email"></div>
<input id="j1" placeholder="메모장"><input id="j2" placeholder="메모장" data-testid="memo-b"><input id="j3" placeholder="메모장">
<input id="k1" aria-label="수량" style="display: none"><input id="k2" aria-label="수량">
<label for="l1">지역</label><select id="l1"><option>서울</option></select><label for="l2">지역</label><input id="l2">
<label for="m1">시작일</label><label for="m1">YYYY-MM-DD</label><input id="m1">
<input id="n1" data-qa="qa-box" data-testid="tid-box">
<input id="o1" data-testid=" pad "><input id="o2" type="search" placeholder="찾기"><input id="o3" type="search" placeholder="찾기">
<input id="p1" placeholder="이메일 "><input id="p2" placeholder="  검색어를
   입력하세요"><input id="p3" placeholder="이름  성">
<textarea id="t1" placeholder="의견"></textarea>
</body>`;

type Walked = { box?: Record<string, string | number>; value?: string; skipped?: true; url?: string };

async function withWalkedApp(fn: (page: Page, app: Frame) => Promise<void>) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    context.setDefaultTimeout(3000);
    await context.route('http://parent.test/**', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><script>window.heard = []; addEventListener("message", (e) => heard.push(e.data));</script><iframe src="http://app.test/home" style="width: 1200px; height: 800px"></iframe>',
    }));
    await context.route('http://app.test/**', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `${SHARED_WORDS_PAGE}<script>(${answerReviewPage})(["http://parent.test"]);</script>`,
    }));
    const page = await context.newPage();
    await page.goto('http://parent.test/');
    const app = page.frame({ url: 'http://app.test/home' })!;
    await app.waitForLoadState();
    await fn(page, app);
  } finally {
    await browser.close();
  }
}

const find = (page: Page, box: object) => page.evaluate((box) => new Promise<{ kinds: string[] }[]>((resolve) => {
  const turn = Math.random();
  addEventListener('message', function heard(e) {
    if (e.data?.duru !== 'found' || e.data.turn !== turn) return;
    removeEventListener('message', heard);
    resolve(e.data.boxes);
  });
  document.querySelector('iframe')!.contentWindow!.postMessage({ duru: 'find', box, turn }, 'http://app.test');
}), box);

test('in a browser, a walk reads the words of a typed box and counts nth the way Playwright does, so the fill code of every box it records fills that box and no other', { skip: browserMissing }, async () => {
  await withWalkedApp(async (page, app) => {
    const typed = await app.evaluate(() => [...document.querySelectorAll('input, textarea')].filter((el) => (el as HTMLElement).checkVisibility()).map((el) => {
      (el as HTMLInputElement).value = `typed ${el.id}`;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.id;
    }));
    assert.equal(typed.length, 28);
    await page.waitForFunction((n) => (window as unknown as { heard: Walked[] }).heard.filter((m) => m.box || m.skipped).length === n, typed.length);
    const walked = (await page.evaluate(() => (window as unknown as { heard: Walked[] }).heard)).filter((m) => m.box || m.skipped);
    assert.deepEqual(walked.filter((m) => m.skipped), []);
    const boxes = new Map(walked.map((m) => [m.value!.replace('typed ', ''), m.box!]));
    assert.deepEqual(Object.fromEntries(['e1', 'f1', 'c2', 'g1', 'h1', 'i2', 'j2', 'j3', 'k2', 'l2', 'm1', 'o1', 'p1', 'p2'].map((id) => [id, boxes.get(id)])), {
      e1: { label: 'zip' },
      f1: { label: '주소' },
      c2: { label: 'my note' },
      g1: { label: '전화 (필수)' },
      h1: { label: '검색', nth: 1 },
      i2: { testId: 'email', nth: 2 },
      j2: { placeholder: '메모장', testId: 'memo-b' },
      j3: { placeholder: '메모장', nth: 3 },
      k2: { label: '수량', nth: 2 },
      l2: { label: '지역', nth: 2 },
      m1: { label: '시작일' },
      o1: { testId: ' pad ' },
      p1: { placeholder: '이메일 ' },
      p2: { placeholder: '  검색어를\n   입력하세요' },
    });
    const reached: Record<string, string[]> = {};
    for (const [id, box] of boxes) {
      await app.evaluate(() => document.querySelectorAll('input, textarea').forEach((el) => { (el as HTMLInputElement).value = ''; }));
      await runFill(app, { box, value: 'filled' }).catch(() => {});
      reached[id] = await app.evaluate(() => [...document.querySelectorAll('input, textarea')].filter((el) => (el as HTMLInputElement).value === 'filled').map((el) => el.id));
    }
    assert.deepEqual(reached, Object.fromEntries([...boxes.keys()].map((id) => [id, [id]])));
  });
});

test('in a browser, the page finds a box by a label word that is its aria-label or aria-labelledby text as well as its label text, still compares words with spaces collapsed, and counts only inputs and textareas', { skip: browserMissing }, async () => {
  await withWalkedApp(async (page) => {
    const kinds = async (box: object) => (await find(page, box)).map((b) => b.kinds);
    for (const label of ['zip', '우편번호', '주소']) assert.deepEqual(await kinds({ label }), [['label']], label);
    assert.deepEqual(await kinds({ label: ' my  note ' }), [['label']]);
    assert.deepEqual(await kinds({ placeholder: '이메일' }), [['placeholder']]);
    assert.deepEqual(await kinds({ testId: 'pad' }), [['testId']]);
    assert.deepEqual(await kinds({ label: '검색' }), [['label']], 'the button with the same aria-label is not counted');
  });
});

test('the decision record keeps what was measured for the fill code, the rule chosen and how a walk reads words for it, and no longer says the words of a box are joined with or or that the page reads words as a walk does', () => {
  const decisions = fs.readFileSync(path.join(import.meta.dirname, '../docs/decisions.md'), 'utf8');
  assert.match(decisions, /\*\*`duru story` writes under each input a Playwright line that finds the box with every word written for it, each\s+matched exactly, joined by `\.and\(\)` in the order placeholder, label, test ID[\s\S]*each of the 25 boxes[\s\S]*7 of the 24 boxes[\s\S]*- `\.or\(\)` between the words: Playwright's strict mode stops the fill/);
  assert.doesNotMatch(decisions, /which is why\s+the task list joins them with `or`/);
  assert.doesNotMatch(decisions, /the words are the same either way/);
  assert.match(decisions, /A walk therefore reads the words the way these locators match them: the label from the elements `aria-labelledby`\s+names, else `aria-label`, else the box's `<label>`s/);
  assert.match(decisions, /the page's number can differ from the walk's and the code's: the driver chose\s+in #348 to keep the page's lookup as it was, and this is a known limit/);
  assert.doesNotMatch(decisions, /reads each box's words the way a walk reads them/);
});
