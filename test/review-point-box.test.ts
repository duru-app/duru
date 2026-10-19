import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from 'playwright-core';
import { withRebuiltFixture, withServer, withFakeApi, withPassword, withPasswords, ALL_PASSWORDS, PASSWORD_ENV, roleSettings, appSettings, browserMissing, withPage, storiesTab, untilSet, rewrite, rebuild } from './review-helpers.ts';
import type { Config } from './review-helpers.ts';

declare function render(): void;
declare function reloadLive(): Promise<void>;

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
  const hidden = (shown) => {
    const label = document.createElement('label');
    label.append('숨은 칸 ', document.createElement('input'));
    if (shown) label.style.cssText = 'position: absolute; right: 0; top: 400px';
    else label.style.display = 'none';
    return label;
  };
  const signer = () => {
    const label = document.createElement('label');
    label.style.display = 'block';
    label.append('참석자 서명 ', document.createElement('input'));
    return label;
  };
  const gap = document.createElement('div');
  gap.style.height = '1600px';
  document.body.append(memos, signer(), signer(), lab, other, note('memo-a'), note('memo-b'), hidden(false), hidden(true), far(), gap, far(), signer());
}
if (location.pathname === '/signin') {
  const email = document.createElement('input');
  email.placeholder = '이메일';
  document.body.append(email);
}
if (location.pathname === '/help' && !sessionStorage.getItem('moved')) {
  sessionStorage.setItem('moved', 'yes');
  history.replaceState({}, '', '/signin');
} else if (location.pathname === '/help') {
  const label = document.createElement('label');
  label.append('도움말 검색 ', document.createElement('input'));
  document.body.append(label);
}
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

const STORY = {
  name: '상자를 짚어 본다',
  screens: [
    { screen: '/home#Home', inputs: [
      { box: { placeholder: '실험 이름', testId: 'lab-name' }, value: '첫 실험' },
      { box: { label: '서명자 메모', nth: 2 }, value: '확인했습니다' },
      { box: { label: '서명자 메모', nth: 5 }, value: '없는 칸' },
      { box: { label: '검색어' }, value: '계약서' },
      { box: { label: '먼 칸', nth: 2 }, value: '아래 칸' },
      { box: { label: '숨은 칸', nth: 2 }, value: '보이는 칸' },
      { box: { label: '참석자 서명', nth: 2 }, value: '두 번째 칸' },
    ] },
    { screen: '/signin#SignIn', inputs: [{ box: { placeholder: '이메일' }, value: 'member@example.com' }] },
    { screen: '/document/:id#DocumentDetail', inputs: [{ box: { label: '메모' }, value: '못 띄움' }] },
    { screen: '/help#Help', inputs: [{ box: { label: '도움말 검색' }, value: '로그인' }] },
    { screen: '/settings#Settings', inputs: [{ box: { label: '이름' }, value: '두루' }] },
  ],
  memo: '',
  author: 'reviewer',
  date: '2026-10-19',
};
const STORY_FILE = 'example-stories/point-box.json';
const pointSettings = (api: string) => ({ app: { ...appSettings(api).app, signedOutPaths: ['/signin'] }, storiesDir: 'example-stories' });

type App = { url: string; signedOutUrl: string };

async function withPointStory(fn: (p: Page, app: App, base: string, config: Config, copy: string) => Promise<void>, { setup, csp = false, password = 's3cret', edit, roles = false }: { setup?: (app: App) => (page: Page) => Promise<unknown>; csp?: boolean; password?: string; edit?: (copy: string) => void; roles?: boolean } = {}) {
  await withFakeApi((api) =>
    withPasswords(roles ? ALL_PASSWORDS : { [PASSWORD_ENV]: password }, () =>
      withRebuiltFixture(roles ? { ...pointSettings(api), app: { ...pointSettings(api).app, roles: roleSettings(api).app.roles } } : pointSettings(api), (config, copy) => {
        fs.writeFileSync(path.join(copy, STORY_FILE), JSON.stringify(STORY));
        edit?.(copy);
        return withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          await withPage(base, async (p, errors) => {
            await p.waitForSelector('#screen-list li');
            await p.click(storiesTab);
            await p.click('#story-list li:has-text("상자를 짚어 본다")');
            await fn(p, app, base, config, copy);
            if (csp) errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Content Security Policy')));
          }, { setup: setup?.(app) });
        });
      }, withBoxes),
    ),
  );
}

const lineAt = (p: Page, step: number, row: number) => p.locator(`#center .story-path > .step[data-step="${step}"] .written-inputs tbody > tr:not(.point-reason)`).nth(row);
const chipAt = (p: Page, step: number, row: number) => lineAt(p, step, row).locator('.chip');
const untilChip = (p: Page, step: number, row: number, text: string) => p.waitForFunction(({ step, row, text }) => {
  const rows = [...document.querySelectorAll(`#center .story-path > .step[data-step="${step}"] .written-inputs tbody > tr:not(.point-reason)`)];
  return rows[row]?.querySelector('.chip')?.textContent === text;
}, { step, row, text });
const appFrame = async (p: Page, url: string) => {
  let frame: Frame | undefined;
  await untilSet(() => (frame = p.frames().find((f) => f.url() === url)), url);
  return frame!;
};
const placeLines = (p: Page) => p.locator('#right-app .point-place > div').allTextContents();
const rectOf = (p: Page, selector: string) => p.$$eval(selector, (els) => els.map((e) => {
  const r = e.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}));
const inside = (r: { left: number; top: number; right: number; bottom: number }, box: typeof r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
const READABLE = 0.75;
const scaleOf = async (p: Page) => Number(await p.getAttribute('#right-app .point-crop', 'data-scale'));

test('in a browser, pressing an input line puts 앱 화면 at the top of the right pane with the app at that step\'s screen cut down to the empty box and a small picture of where the cut sits, keeps the story pane below it, and the line then says 화면에서 찾음', { skip: browserMissing }, async () => {
  await withPointStory(async (p, app) => {
    assert.equal(await p.getAttribute('#right-app', 'hidden'), '');
    assert.equal(await chipAt(p, 0, 0).textContent(), '확인 안 됨');
    assert.equal(await chipAt(p, 0, 0).getAttribute('title'), '아직 이 줄을 눌러 앱 화면에서 찾아보지 않았습니다');
    assert.equal(await lineAt(p, 0, 0).getAttribute('title'), '누르면 오른쪽 칸에 띄운 앱 화면에서 이 상자를 짚어 보입니다');
    await lineAt(p, 0, 0).click();
    assert.equal(await p.textContent('#center h3'), '상자를 짚어 본다', 'pressing an input line does not open the screen');
    await untilChip(p, 0, 0, '화면에서 찾음');
    assert.equal(await chipAt(p, 0, 0).getAttribute('title'), '줄을 눌렀을 때 띄운 앱 화면에서 이 상자를 찾았습니다. 띄운 앱의 데이터에 따라 달라지므로 파일에는 남기지 않습니다');
    assert.equal(await p.locator('#center tr.point-line.on').count(), 1);
    assert.deepEqual(await p.$$eval('#right > *', (els) => els.map((e) => e.id)), ['right-app', 'right-info', 'right-dock']);
    assert.equal(await p.textContent('#right-app .point-head h2'), '앱 화면');
    assert.equal(await p.textContent('#right-app .point-close'), '닫기');
    assert.equal(await p.textContent('#right-app .point-which'), '1 단계 · 안내 글 「실험 이름」 또는 테스트 ID 「lab-name」 → 첫 실험');
    assert.deepEqual(await placeLines(p), ['/home', 'duru-admin 계정으로 띄움', '앱 화면에서 상자 주변만 잘라 크게 보임']);
    assert.deepEqual(await p.locator('#right-info .verdict').allTextContents(), ['도달 불가 · 링크 없음 2곳', '판정 못 함 · 화면 없음']);

    const frame = await appFrame(p, `${app.url}/home`);
    assert.equal(await frame.inputValue('input[data-testid="lab-name"]'), '', 'the box is shown as the app has it');
    const [crop] = await rectOf(p, '#right-app .point-crop');
    const scale = Number(await p.getAttribute('#right-app .point-crop', 'data-scale'));
    assert.ok(scale > (crop.right - crop.left) / 1280, `the cut is zoomed in (${scale})`);
    const marks = await rectOf(p, '#right-app .point-mark');
    assert.equal(marks.length, 1);
    assert.equal(await p.locator('#right-app .point-mark.target').count(), 1);
    assert.equal(await p.locator('#right-app .point-no').count(), 0);
    assert.ok(inside(marks[0], crop));
    const [mini] = await rectOf(p, '#right-app .point-mini');
    const [cut] = await rectOf(p, '#right-app .point-mini i');
    assert.ok(cut.right - cut.left > 0 && cut.bottom - cut.top > 0 && inside(cut, mini));
    assert.ok(cut.right - cut.left < mini.right - mini.left, 'the cut is a part of the page');

    await lineAt(p, 1, 0).click();
    await untilChip(p, 1, 0, '화면에서 찾음');
    assert.deepEqual(await placeLines(p), ['/signin', '로그인하지 않은 상태로 띄움', '앱 화면에서 상자 주변만 잘라 크게 보임']);
    assert.equal(await p.getAttribute('#right-app iframe.point-frame', 'src'), `${app.signedOutUrl}/__duru/sign-out?to=%2Fsignin`);

    await p.click('#right-app .point-close');
    assert.equal(await p.getAttribute('#right-app', 'hidden'), '');
    assert.equal(await p.locator('#right-app iframe').count(), 0);
    assert.equal(await p.locator('#center tr.point-line.on').count(), 0);
    assert.equal(await chipAt(p, 0, 0).textContent(), '화면에서 찾음');
  });
});

test('in a browser, boxes found by the same words are cut together and numbered 1 · 2 · 3 and only the one the line counts to is outlined', { skip: browserMissing }, async () => {
  await withPointStory(async (p) => {
    await lineAt(p, 0, 1).click();
    await untilChip(p, 0, 1, '화면에서 찾음');
    assert.deepEqual(await p.locator('#right-app .point-no').allTextContents(), ['1', '2', '3']);
    assert.deepEqual(await p.$$eval('#right-app .point-mark', (els) => els.map((e) => e.classList.contains('target'))), [false, true, false]);
    assert.equal(await p.textContent('#right-app .point-note'), '같은 라벨의 상자 3개 가운데 2 번째를 짚었습니다.');
    const [crop] = await rectOf(p, '#right-app .point-crop');
    assert.ok((await rectOf(p, '#right-app .point-mark')).every((m) => inside(m, crop)));
    assert.ok((await rectOf(p, '#right-app .point-no')).every((n) => inside(n, crop)), 'every number shows inside the cut');
  });
});

test('in a browser, when boxes found by the same words lie too far apart to cut together at a readable size, the cut stays around the one the line counts to with the boxes near it, and the note says where the others are', { skip: browserMissing }, async () => {
  await withPointStory(async (p) => {
    await lineAt(p, 0, 6).click();
    await untilChip(p, 0, 6, '화면에서 찾음');
    const scale = await scaleOf(p);
    assert.ok(scale >= READABLE, `the cut is readable (${scale})`);
    assert.deepEqual(await p.locator('#right-app .point-no').allTextContents(), ['1', '2']);
    assert.deepEqual(await p.$$eval('#right-app .point-mark', (els) => els.map((e) => e.classList.contains('target'))), [false, true]);
    assert.equal(await p.textContent('#right-app .point-note'), '같은 라벨의 상자 3개 가운데 2 번째를 짚었습니다. 3번은 이 그림 아래쪽에 있습니다.');
    const [crop] = await rectOf(p, '#right-app .point-crop');
    assert.ok((await rectOf(p, '#right-app .point-mark')).every((m) => inside(m, crop)));
    assert.ok((await rectOf(p, '#right-app .point-no')).every((n) => inside(n, crop)), 'every number shows inside the cut');

    await lineAt(p, 0, 4).click();
    await untilChip(p, 0, 4, '화면에서 찾음');
    assert.ok(await scaleOf(p) >= READABLE);
    assert.deepEqual(await p.locator('#right-app .point-no').allTextContents(), ['2']);
    assert.equal(await p.locator('#right-app .point-mark.target').count(), 1);
    assert.equal(await p.textContent('#right-app .point-note'), '같은 라벨의 상자 2개 가운데 2 번째를 짚었습니다. 1번은 이 그림 위쪽에 있습니다.');
    assert.ok(parseFloat((await p.getAttribute('#right-app iframe.point-frame', 'style'))!.match(/height: ([\d.]+)px/)![1]) > 1600, 'the app frame grew to hold the counted box');
    const [mark] = await rectOf(p, '#right-app .point-mark');
    const [cut] = await rectOf(p, '#right-app .point-crop');
    assert.ok(inside(mark, cut));
    assert.ok(inside((await rectOf(p, '#right-app .point-no'))[0], cut), 'the number shows inside the cut');
  });
});

test('in a browser, a box the app hides is counted but left out of the cut and not outlined, so the cut stays around the box that shows', { skip: browserMissing }, async () => {
  await withPointStory(async (p) => {
    await lineAt(p, 0, 5).click();
    await untilChip(p, 0, 5, '화면에서 찾음');
    assert.deepEqual(await p.locator('#right-app .point-no').allTextContents(), ['2']);
    assert.equal(await p.locator('#right-app .point-mark.target').count(), 1);
    const [mini] = await rectOf(p, '#right-app .point-mini');
    const [cut] = await rectOf(p, '#right-app .point-mini i');
    assert.ok(cut.left - mini.left > 20, `the cut starts beside the box that shows, not at the page's left edge (${JSON.stringify({ mini, cut })})`);
    const [crop] = await rectOf(p, '#right-app .point-crop');
    assert.ok(inside((await rectOf(p, '#right-app .point-no'))[0], crop), 'the number of a box at the right of the cut still shows inside it');
  });
});

test('in a browser, a box the screen does not have and a count past the boxes there say 못 찾음 with why on the line and in the pane, and pressing lines writes nothing and keeps nothing after a reload', { skip: browserMissing }, async () => {
  await withPointStory(async (p, _app, base, _config, copy) => {
    const before = fs.readFileSync(path.join(copy, STORY_FILE));
    const sent: string[] = [];
    p.on('request', (r) => {
      if (r.method() !== 'GET' && r.url().startsWith(base)) sent.push(`${r.method()} ${r.url()}`);
    });
    await lineAt(p, 0, 3).click();
    await untilChip(p, 0, 3, '못 찾음');
    const none = '띄운 앱 화면에 라벨 「검색어」인 상자가 없습니다';
    assert.equal(await chipAt(p, 0, 3).getAttribute('title'), none);
    assert.equal(await p.textContent('#center .story-path > .step[data-step="0"] tr.point-reason'), none);
    assert.equal(await p.textContent('#right-app .point-missing'), `못 찾음 · ${none}`);
    assert.deepEqual((await placeLines(p)).slice(2), ['앱 화면 맨 위를 보임']);
    assert.equal(await p.locator('#right-app .point-mark').count(), 0);
    assert.ok(await scaleOf(p) >= READABLE, 'the top of the app screen is shown readable, not shrunk to the whole width');

    await lineAt(p, 0, 2).click();
    await untilChip(p, 0, 2, '못 찾음');
    const fewer = '라벨 「서명자 메모」인 상자가 3개뿐이라 5 번째가 없습니다';
    assert.equal(await p.textContent('#right-app .point-missing'), `못 찾음 · ${fewer}`);
    assert.deepEqual(await p.locator('#center .story-path > .step[data-step="0"] tr.point-reason').allTextContents(), [fewer, none]);

    assert.deepEqual(sent, []);
    assert.ok(fs.readFileSync(path.join(copy, STORY_FILE)).equals(before));
    await p.reload();
    await p.click(storiesTab);
    await p.click('#story-list li:has-text("상자를 짚어 본다")');
    assert.deepEqual(await p.locator('#center .story-path > .step[data-step="0"] .chip').allTextContents(), ['확인 안 됨', '확인 안 됨', '확인 안 됨', '확인 안 됨', '확인 안 됨', '확인 안 됨', '확인 안 됨']);
  });
});

test('in a browser, a count past the boxes there says 못 찾음 also when those boxes lie farther apart than the app frame can hold', { skip: browserMissing }, async () => {
  await withPointStory(async (p, app) => {
    await lineAt(p, 0, 0).click();
    await untilChip(p, 0, 0, '화면에서 찾음');
    await (await appFrame(p, `${app.url}/home`)).evaluate(() => {
      const gap = document.createElement('div');
      gap.style.height = '5000px';
      const label = document.createElement('label');
      label.append('서명자 메모 ', document.createElement('input'));
      document.body.append(gap, label);
    });
    await lineAt(p, 0, 2).click();
    await untilChip(p, 0, 2, '못 찾음');
    assert.equal(await p.textContent('#right-app .point-missing'), '못 찾음 · 라벨 「서명자 메모」인 상자가 4개뿐이라 5 번째가 없습니다');
    assert.deepEqual((await placeLines(p)).slice(2), ['앱 화면 맨 위를 보임']);
  });
});

test('in a browser, a step whose screen cannot be opened and an app that moves to another screen leave 확인 안 됨 and the right pane says why, and a line on a screen off the map cannot be pressed', { skip: browserMissing }, async () => {
  await withPointStory(async (p) => {
    await lineAt(p, 2, 0).click();
    await p.waitForSelector('#right-app .point-why:not(.muted)');
    assert.match((await p.textContent('#right-app .point-why'))!, /^id 값이 없어 이 단계의 화면을 띄울 수 없습니다\./);
    assert.equal(await p.locator('#right-app iframe').count(), 0);
    assert.equal(await p.locator('#right-app .point-full').count(), 0);
    assert.equal(await chipAt(p, 2, 0).textContent(), '확인 안 됨');

    await lineAt(p, 3, 0).click();
    await p.waitForSelector('#right-app .point-why:has-text("옮겨 가서")');
    assert.equal(await p.textContent('#right-app .point-why'), '앱이 이 단계의 화면이 아닌 /signin 로 옮겨 가서 상자를 찾지 않았습니다.');
    assert.equal(await chipAt(p, 3, 0).textContent(), '확인 안 됨');

    await p.click('#right-app .point-close');
    const offMap = '이 단계의 화면이 맵에 없어, 앱을 어느 화면으로 띄울지 정하지 못합니다. 앱 화면에서 상자를 짚을 수 없습니다';
    assert.equal(await lineAt(p, 4, 0).getAttribute('title'), offMap);
    assert.equal(await chipAt(p, 4, 0).getAttribute('title'), offMap);
    await lineAt(p, 4, 0).click();
    assert.equal(await p.getAttribute('#right-app', 'hidden'), '');
  });
});

test('in a browser, pressing a line again after the app moved off the step\'s screen opens that screen again instead of asking the moved app', { skip: browserMissing }, async () => {
  await withPointStory(async (p) => {
    await lineAt(p, 3, 0).click();
    await p.waitForSelector('#right-app .point-why:has-text("옮겨 가서")');
    await lineAt(p, 3, 0).click();
    await untilChip(p, 3, 0, '화면에서 찾음');
    assert.equal(await p.locator('#right-app iframe').count(), 1);
  });
});

test('in a browser, when the account the app is opened with could not sign in, 앱 화면 says so and a box it does not find leaves the line 확인 안 됨', { skip: browserMissing }, async () => {
  await withPointStory(async (p) => {
    await lineAt(p, 0, 3).click();
    await p.waitForSelector('#right-app .point-why:has-text("남기지 않았습니다")');
    assert.equal(await p.textContent('#right-app .point-place .error'), '로그인 요청이 401 로 실패했습니다');
    assert.equal(await p.textContent('#right-app .point-why'), '띄운 앱 화면에 라벨 「검색어」인 상자가 없습니다. 앱을 띄운 계정에 문제가 있어 못 찾음으로 남기지 않았습니다.');
    assert.equal(await chipAt(p, 0, 3).textContent(), '확인 안 됨');
    assert.equal(await p.locator('#center tr.point-reason').count(), 0);
  }, { password: 'wrong' });
});

test('in a browser, a box not found on a screen whose role condition the map cannot read says 못 찾음, with the note about the role in 앱 화면', { skip: browserMissing }, async () => {
  await withPointStory(async (p) => {
    await lineAt(p, 0, 0).click();
    await untilChip(p, 0, 0, '못 찾음');
    assert.match((await p.textContent('#right-app'))!, /어느 역할이 조건을 채우는지 맵에서 정할 수 없습니다: isAdmin/);
    assert.equal(await p.textContent('#right-app .point-missing'), '못 찾음 · 띄운 앱 화면에 라벨 「검색어」인 상자가 없습니다');
  }, {
    edit: (copy) => {
      rewrite(copy, 'client/src/components/Home.js', "const isAdmin = memberRole === 'ADMIN';", "const isAdmin = memberRole !== 'MEMBER';");
      rebuild(copy);
      fs.writeFileSync(path.join(copy, STORY_FILE), JSON.stringify({ ...STORY, screens: [{ screen: '/admin/group#AdminGroup', inputs: [{ box: { label: '검색어' }, value: '계약서' }] }] }));
    },
  });
});

test('in a browser, a box not found on a screen opened with a role the reviewer picked that does not meet its role condition leaves the line 확인 안 됨, with the note about the role in 앱 화면', { skip: browserMissing }, async () => {
  await withPointStory(async (p) => {
    await p.click('#view-list');
    await p.click('#screen-list li:has-text("/admin/group")');
    await p.selectOption('#center .frame-bar select.role', 'role:AUDITOR');
    await p.click(storiesTab);
    await p.click('#story-list li:has-text("상자를 짚어 본다")');
    await lineAt(p, 0, 0).click();
    await p.waitForSelector('#right-app .point-why, #right-app .point-missing');
    assert.match((await p.textContent('#right-app'))!, /이 역할은 화면 조건\(ADMIN\)을 채우지 못합니다/);
    assert.equal(await chipAt(p, 0, 0).textContent(), '확인 안 됨');
    assert.equal(await p.textContent('#right-app .point-why'), '띄운 앱 화면에 라벨 「검색어」인 상자가 없습니다. 앱을 띄운 계정에 문제가 있어 못 찾음으로 남기지 않았습니다.');
  }, {
    roles: true,
    edit: (copy) => fs.writeFileSync(path.join(copy, STORY_FILE), JSON.stringify({ ...STORY, screens: [{ screen: '/admin/group#AdminGroup', inputs: [{ box: { label: '검색어' }, value: '계약서' }] }] })),
  });
});

test('in a browser, a live reload of the map that leaves out the step\'s screen closes 앱 화면', { skip: browserMissing }, async () => {
  await withPointStory(async (p, _app, _base, _config, copy) => {
    await lineAt(p, 0, 0).click();
    await untilChip(p, 0, 0, '화면에서 찾음');
    rewrite(copy, 'client/src/Routes.js', '<Route path={Option.ROUTE_PATH.HOME} component={waitFor(Home)} exact />', '');
    rebuild(copy);
    await p.evaluate(() => reloadLive());
    await p.waitForSelector('#center .story-path > .step.off-map[data-step="0"]');
    assert.equal(await p.getAttribute('#right-app', 'hidden'), '');
    assert.equal(await p.locator('#right-app .point-block').count(), 0);
    assert.equal(await p.locator('#center tr.point-line.on').count(), 0);
  });
});

test('in a browser, an app that blocks inline scripts never answers, so the line keeps 확인 안 됨 and the right pane says why', { skip: browserMissing }, async () => {
  await withPointStory(async (p) => {
    await lineAt(p, 0, 0).click();
    await p.waitForSelector('#right-app .point-why', { timeout: 10_000 });
    assert.equal(await p.textContent('#right-app .point-why'), '앱에서 답을 받지 못했습니다. 앱이 보안 정책으로 인라인 스크립트를 막으면 상자를 찾을 수 없습니다.');
    assert.equal(await chipAt(p, 0, 0).textContent(), '확인 안 됨');
  }, {
    csp: true,
    setup: (app) => (page) => page.route(`${app.url}/**`, async (route) => {
      const res = await route.fetch();
      const type = res.headers()['content-type'] ?? '';
      await route.fulfill({ response: res, headers: type.startsWith('text/html') ? { ...res.headers(), 'content-security-policy': "script-src 'self'" } : res.headers() });
    }),
  });
});

test('in a browser, 가운데에 앱 화면 전체 열기 opens the whole app at that address in the middle pane, and 단계 카드로 돌아가기 or another story brings the cards back', { skip: browserMissing }, async () => {
  await withPointStory(async (p, app) => {
    await lineAt(p, 0, 1).click();
    await untilChip(p, 0, 1, '화면에서 찾음');
    assert.equal(await p.textContent('#right-app .point-full'), '가운데에 앱 화면 전체 열기');
    await p.click('#right-app .point-full');
    await p.waitForSelector('#center-head .point-stage iframe.app');
    assert.equal(await p.getAttribute('#center-head .point-stage iframe.app', 'src'), `${app.url}/home`);
    assert.deepEqual(await p.locator('#center-head .point-bar > :is(strong, .mono, span:not(.app-scale))').allTextContents(), ['앱 화면 전체', '/home', 'duru-admin 계정으로 띄움']);
    assert.equal(await p.locator('#center-head .point-bar select.app-width').count(), 1);
    assert.equal(await p.locator('#center .story-path').count(), 0);
    assert.equal(await p.locator('#right-app .point-block').count(), 1, 'the cut stays in the right pane');

    await p.click('#center-head button.point-back');
    await p.waitForSelector('#center .story-path');
    assert.equal(await p.locator('#center-head iframe').count(), 0);

    await p.click('#right-app .point-full');
    await p.waitForSelector('#center-head .point-stage');
    await p.click('#story-list li:has-text("문서를 연다")');
    await p.waitForSelector('#center .story-path');
    assert.equal(await p.locator('#center-head iframe').count(), 0);
    assert.equal(await p.getAttribute('#right-app', 'hidden'), '');
  });
});

test('in a browser, typing a comment, re-rendering and pressing another line of the same step keep the cut-out app frame loaded, Enter presses a line and keeps it focused, and 새 스토리 closes 앱 화면', { skip: browserMissing }, async () => {
  await withPointStory(async (p, app) => {
    await lineAt(p, 0, 0).focus();
    await p.keyboard.press('Enter');
    await untilChip(p, 0, 0, '화면에서 찾음');
    assert.equal(await p.evaluate(() => document.activeElement!.matches('#center tr.point-line.on')), true);
    const frame = await appFrame(p, `${app.url}/home`);
    await frame.evaluate(() => { (window as any).kept = true; });

    await p.fill('#right-dock textarea', '상자 위치를 다시 봅니다');
    await p.evaluate(() => render());
    await lineAt(p, 0, 1).click();
    await untilChip(p, 0, 1, '화면에서 찾음');
    assert.equal(await p.locator('#right-app iframe').count(), 1);
    assert.equal(await frame.evaluate(() => (window as any).kept), true);

    await p.click('#left button.new-story');
    assert.equal(await p.getAttribute('#right-app', 'hidden'), '');
    assert.equal(await p.locator('#right-app iframe').count(), 0);
  });
});

test('in a browser, a Korean syllable being composed in a field of the middle pane is not broken when the box is found, and the line shows 화면에서 찾음 once it is composed', { skip: browserMissing }, async () => {
  await withPointStory(async (p) => {
    await p.click('#center .story-path > .step[data-step="1"] button.edit-fields');
    await p.waitForSelector('#center .fields-edit input[aria-label="값"]');
    await p.evaluate(() => {
      (document.querySelector('#center .story-path > .step[data-step="0"] tr.point-line') as HTMLElement).click();
      const field = document.querySelector('#center .fields-edit input[aria-label="값"]') as HTMLInputElement;
      field.focus();
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      (window as any).composed = field;
    });
    await p.waitForSelector('#right-app .point-mark');
    await p.waitForTimeout(100);
    assert.equal(await p.evaluate(() => (window as any).composed.isConnected && document.activeElement === (window as any).composed), true);
    assert.equal(await chipAt(p, 0, 0).textContent(), '확인 안 됨');
    await p.evaluate(() => (window as any).composed.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await untilChip(p, 0, 0, '화면에서 찾음');
  });
});

test('in a browser, input lines in the step-order editor and on new-story cards cannot be pressed and say why', { skip: browserMissing }, async () => {
  await withPointStory(async (p, app) => {
    await p.click('#center button.reorder');
    const order = p.locator('#center .order-step .written-inputs tr').first();
    await order.waitFor();
    assert.equal(await order.getAttribute('title'), '화면 순서를 고치는 동안에는 상자를 짚지 않습니다. 순서를 고친 뒤 단계 카드에서 눌러 짚어 볼 수 있습니다');
    assert.equal(await p.locator('#center tr.point-line').count(), 0);
    await p.click('#right button.cancel-steps');

    await p.click('#left button.new-story');
    await p.waitForSelector('#pick-list li');
    await p.locator('#pick-list li').filter({ has: p.locator('.name > span:first-child', { hasText: /^\/signin$/ }) }).click();
    await p.click('#center button.walk-start');
    const frame = await appFrame(p, `${app.signedOutUrl}/signin`);
    await frame.fill('input[placeholder="이메일"]', 'member@example.com');
    await frame.dispatchEvent('input[placeholder="이메일"]', 'change');
    await p.waitForSelector('#walk-steps .walk-inputs');
    await p.click('#center .walk-bar button.end-walk');
    const compose = p.locator('#center .compose-step .written-inputs tr').first();
    await compose.waitFor();
    assert.equal(await compose.getAttribute('title'), '기록하는 동안 앱에서 직접 값을 넣은 상자라 따로 짚지 않습니다. 스토리로 저장한 뒤 스토리 카드에서 눌러 짚어 볼 수 있습니다');
    await compose.click();
    assert.equal(await p.getAttribute('#right-app', 'hidden'), '');
  });
});
