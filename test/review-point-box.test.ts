import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { withRebuiltFixture, withServer, withFakeApi, withPassword, appSettings, browserMissing, withPage } from './review-helpers.ts';

const BOXES = `
if (location.pathname === '/home') {
  const memos = document.createElement('div');
  const memo = () => {
    const label = document.createElement('label');
    label.style.display = 'block';
    label.append('서명자 메모 ', document.createElement('input'));
    memos.append(label);
  };
  memo();
  memo();
  setTimeout(memo, 150);
  const lab = document.createElement('input');
  lab.placeholder = '실험 이름';
  lab.dataset.testid = 'lab-name';
  const other = document.createElement('input');
  other.placeholder = '다른 이름';
  other.dataset.testid = 'other-name';
  const far = () => {
    const label = document.createElement('label');
    label.append('먼 칸 ', document.createElement('input'));
    return label;
  };
  const note = (testId) => {
    const input = document.createElement('input');
    input.placeholder = '메모';
    input.dataset.testid = testId;
    return input;
  };
  const gap = document.createElement('div');
  gap.style.height = '1600px';
  document.body.append(memos, lab, other, note('memo-a'), note('memo-b'), far(), gap, far());
}
if (location.pathname === '/help') history.replaceState({}, '', '/signin');
`;
const PATH_LINE = 'document.getElementById(\'path\').textContent = location.pathname;';
export const withBoxes: [string, string, string][] = [['build/app.js', PATH_LINE, PATH_LINE + BOXES]];

type Box = { x: number; y: number; w: number; h: number; kinds: string[] };
type Answer = { url: string; boxes: Box[]; scroll: { x: number; y: number }; page: { w: number; h: number } };

const askAtLoad = (p: Page, src: string, box: object) => p.evaluate(({ src, box }) => new Promise<Answer>((resolve) => {
  const frame = document.createElement('iframe');
  frame.id = 'probe';
  frame.style.cssText = 'position: fixed; left: -2000px; top: 0; width: 1280px; height: 900px';
  frame.src = src;
  const turn = Math.random();
  addEventListener('message', function heard(e) {
    if (e.source !== frame.contentWindow || e.data?.duru !== 'found' || e.data.turn !== turn) return;
    removeEventListener('message', heard);
    resolve(e.data);
  });
  frame.addEventListener('load', () => frame.contentWindow!.postMessage({ duru: 'find', box, turn }, new URL(src).origin), { once: true });
  document.body.append(frame);
}), { src, box });

const ask = (p: Page, origin: string, box: object) => p.evaluate(({ origin, box }) => new Promise<Answer>((resolve) => {
  const frame = document.getElementById('probe') as HTMLIFrameElement;
  const turn = Math.random();
  addEventListener('message', function heard(e) {
    if (e.source !== frame.contentWindow || e.data?.duru !== 'found' || e.data.turn !== turn) return;
    removeEventListener('message', heard);
    resolve(e.data);
  });
  frame.contentWindow!.postMessage({ duru: 'find', box, turn }, origin);
}), { origin, box });

const heardWithin = (p: Page, ms: number) => p.evaluate((ms) => new Promise<unknown[]>((resolve) => {
  const heard: unknown[] = [];
  addEventListener('message', (e) => {
    if (e.data?.duru === 'found') heard.push(e.data);
  });
  setTimeout(() => resolve(heard), ms);
}), ms);

const kindsOf = (a: Answer) => a.boxes.map((b) => b.kinds);

test('in a browser, the app answers a box lookup with where each input or textarea that has every written word sits, or else, when fewer of them than the count do, each one any written word finds, in document order, after the page has been quiet, and with no values', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          const origin = new URL(app.url).origin;
          await withPage(base, async (p) => {
            const memos = await askAtLoad(p, `${app.url}/home`, { label: '서명자 메모', nth: 2 });
            assert.equal(memos.url, '/home');
            assert.deepEqual(kindsOf(memos), [['label'], ['label'], ['label']], 'the box the app draws a moment after loading is counted too');
            assert.ok(memos.boxes.every((b, i) => i === 0 || b.y > memos.boxes[i - 1].y), 'in document order');
            assert.ok(memos.page.h > 1600);
            assert.deepEqual(memos.scroll, { x: 0, y: 0 });

            assert.deepEqual(kindsOf(await ask(p, origin, { placeholder: '실험 이름', testId: 'lab-name' })), [['placeholder', 'testId']]);
            assert.deepEqual(kindsOf(await ask(p, origin, { placeholder: '옛 이름', testId: 'lab-name' })), [['testId']], 'one written word out of date still finds the box');
            assert.deepEqual(kindsOf(await ask(p, origin, { placeholder: '실험 이름', testId: 'other-name' })), [['placeholder'], ['testId']], 'when no box has every word, boxes each word finds are counted together');
            assert.deepEqual(kindsOf(await ask(p, origin, { placeholder: '메모', testId: 'memo-b' })), [['placeholder', 'testId']], 'a box that has every word is counted alone, as a walk counts it');
            assert.deepEqual(kindsOf(await ask(p, origin, { placeholder: '메모', testId: 'memo-a', nth: 2 })), [['placeholder', 'testId'], ['placeholder']], 'when fewer boxes than the count have every word, boxes each word finds are counted together');
            assert.equal((await ask(p, origin, { placeholder: '메모' })).boxes.length, 2);
            assert.deepEqual(kindsOf(await ask(p, origin, { label: '검색어' })), []);
            assert.equal((await ask(p, origin, { label: '먼 칸' })).boxes.length, 2);

            const frame = p.frames().find((f) => f.url() === `${app.url}/home`)!;
            await frame.fill('input[data-testid="lab-name"]', '비밀 값');
            assert.doesNotMatch(JSON.stringify(await ask(p, origin, { testId: 'lab-name' })), /비밀 값/);
          });
        }),
      withBoxes),
    ),
  );
});

test('in a browser, the app answers a box lookup only from the review page that framed it', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin'] } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          await withPage(base, async (p) => {
            await askAtLoad(p, `${app.url}/home`, { label: '서명자 메모' });
            const frame = p.frames().find((f) => f.url() === `${app.url}/home`)!;
            const heard = heardWithin(p, 1000);
            await frame.evaluate(() => window.postMessage({ duru: 'find', box: { label: '서명자 메모' }, turn: 99 }, '*'));
            assert.deepEqual(await heard, [], 'a lookup the app frame posts to itself');

            const elsewhere = await p.context().browser()!.newPage();
            await elsewhere.goto(`${app.signedOutUrl}/signin`);
            await elsewhere.evaluate((src) => new Promise((resolve) => {
              const frame = document.createElement('iframe');
              frame.src = src;
              frame.addEventListener('load', resolve, { once: true });
              document.body.append(frame);
            }), `${app.url}/home`);
            const heardElsewhere = heardWithin(elsewhere, 1000);
            await elsewhere.evaluate((origin) => document.querySelector('iframe')!.contentWindow!.postMessage({ duru: 'find', box: { label: '서명자 메모' }, turn: 1 }, origin), new URL(app.url).origin);
            assert.deepEqual(await heardElsewhere, [], 'a lookup from a page at another origin');
          });
        }),
      withBoxes),
    ),
  );
});
