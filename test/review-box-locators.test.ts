import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { Frame, Page } from 'playwright-core';
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

test('the decision record keeps what was measured for the fill code and the rule chosen, and no longer says the words of a box are joined with or', () => {
  const decisions = fs.readFileSync(path.join(import.meta.dirname, '../docs/decisions.md'), 'utf8');
  assert.match(decisions, /\*\*`duru story` writes under each input a Playwright line that finds the box with every word written for it, each\s+matched exactly, joined by `\.and\(\)` in the order placeholder, label, test ID[\s\S]*each of the 25 boxes[\s\S]*7 of the 24 boxes[\s\S]*- `\.or\(\)` between the words: Playwright's strict mode stops the fill/);
  assert.doesNotMatch(decisions, /which is why\s+the task list joins them with `or`/);
  assert.doesNotMatch(decisions, /the words are the same either way/);
});
