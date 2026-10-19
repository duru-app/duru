import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from 'playwright-core';
import { withRebuiltFixture, withServer, withFakeApi, withPassword, withPasswords, ALL_PASSWORDS, appSettings, roleSettings, browserMissing, withPage, storiesTab, untilSet } from './review-helpers.ts';
import type { PageData } from './review-helpers.ts';

const EMAIL = { box: { placeholder: '이메일' }, value: 'member@example.com' };
const MEMO = { box: { label: '메모' }, value: '첫 메모' };

async function startNewStory(p: Page) {
  await p.waitForSelector('#screen-list li');
  await p.click(storiesTab);
  await p.click('#left button.new-story');
  await p.waitForSelector('#pick-list li');
}

const pickScreen = (p: Page, routePath: string) => p.locator('#pick-list li').filter({ has: p.locator('.name > span:first-child', { hasText: new RegExp(`^${routePath}$`) }) }).click();

async function walkFrame(p: Page, origin: string) {
  await p.waitForSelector('#center .walk-stage iframe.app');
  let frame: Frame | undefined;
  await untilSet(() => (frame = p.frames().find((f) => f.url().startsWith(origin) && !f.url().includes('/__duru/'))), `the app frame on ${origin}`);
  await frame!.waitForLoadState();
  return frame!;
}

const goTo = (frame: Frame, url: string) => frame.evaluate((to) => history.pushState({}, '', to), url);

function typeInto(frame: Frame, attrs: Record<string, string>, value: string, { label }: { label?: string } = {}) {
  return frame.evaluate(({ attrs, value, label }) => {
    const input = document.createElement('input');
    for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
    if (label) {
      const wrap = document.createElement('label');
      wrap.append(label, input);
      document.body.append(wrap);
    } else document.body.append(input);
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { attrs, value, label });
}

const walkSteps = (p: Page) => p.$$eval('#walk-steps > li', (els) => els.map((e) => e.querySelector('.name')!.textContent));
const untilWalkSteps = (p: Page, n: number) => p.waitForFunction((n) => document.querySelectorAll('#walk-steps > li').length === n, n);
const recordFiles = (storiesDir: string) => {
  const folder = path.join(storiesDir, 'records');
  return fs.existsSync(folder) ? fs.readdirSync(folder).sort().map((f) => JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'))) : [];
};

test('in a browser, 「● 기록」 in a new story fills the center with the app and stacks each screen passed in the app on the left after the steps already there, with the addresses, the values typed and the inputs left out, takes no message from elsewhere, and 「기록 끝」 writes the record file and draws the path in one row', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            await startNewStory(p);
            await pickScreen(p, '/signin');
            await p.waitForSelector('#center .compose-step[data-step="0"]');
            assert.equal(await p.textContent('#center .title-row button.walk-start'), '● 기록');
            await p.click('#center button.walk-start');

            const frame = await walkFrame(p, app.url);
            assert.equal(new URL(frame.url()).pathname, '/signin');
            assert.equal(await p.isVisible('#flow'), false);
            assert.equal(await p.locator('#pick-list').count(), 0);
            assert.equal(await p.isDisabled('#right button.save-compose'), true);
            const [stage, center] = await Promise.all([p.locator('#center .walk-stage').boundingBox(), p.locator('#center').boundingBox()]);
            assert.ok(stage!.y + stage!.height > center!.y + center!.height - 40, 'the app reaches the bottom of the center column');
            await untilWalkSteps(p, 1);

            await typeInto(frame, { placeholder: '이메일' }, EMAIL.value);
            await typeInto(frame, { type: 'password', placeholder: '비밀번호' }, 's3cret');
            await goTo(frame, '/home');
            await goTo(frame, '/home?tab=recent#top');
            await p.evaluate(() => window.postMessage({ duru: 'walk', url: '/admin/member' }, '*'));
            await goTo(frame, '/beta/inbox');
            await typeInto(frame, {}, MEMO.value, { label: '메모' });
            await untilWalkSteps(p, 3);
            await p.waitForSelector('#walk-steps > li:nth-child(3) .walk-inputs');
            assert.deepEqual(await walkSteps(p), [
              '/signin/signin값을 적지 않은 입력 1개안내 글 「이메일」 → member@example.com',
              '/home/home → /home?tab=recent#top',
              '/beta/inbox 맵에 없는 화면/beta/inbox라벨 「메모」 → 첫 메모',
            ]);
            assert.equal(await p.textContent('#center .walk-bar .walk-at'), '/beta/inbox');
            assert.match((await p.textContent('#center .walk-bar .walk-status'))!, /받은 주소 4/);
            assert.ok(!(await p.content()).includes('s3cret'));

            await p.click('#center .walk-bar button.end-walk');
            await p.waitForSelector('#center .walk-note:has-text("기록 파일")');
            assert.deepEqual(recordFiles(config.storiesDir), [{ steps: [
              { url: '/signin', inputs: [EMAIL], skipped: 1 },
              { url: '/home' },
              { url: '/home?tab=recent#top' },
              { url: '/beta/inbox', inputs: [MEMO] },
            ] }]);
            assert.equal(await p.locator('#center .walk-stage').count(), 0);
            await p.waitForSelector('#flow .story-line .box[data-step="2"]');
            assert.deepEqual(await p.$$eval('#flow .story-line [data-step]', (els) => els.map((e) => (e as HTMLElement).dataset.screen)), ['/signin#SignIn', '/home#Home', '/beta/inbox']);
            assert.equal(await p.locator('#flow .story-line .story-hop').count(), 2);
            assert.equal(await p.locator('#flow .canvas').count(), 0);
            assert.deepEqual(await p.locator('#center .compose-step .screen-path').allTextContents(), ['/signin', '/home']);
            assert.equal(await p.textContent('#center .compose-step[data-step="2"] .chip.l-off-map'), '맵에 없는 화면');
            assert.equal(await p.locator('#pick-list li').count() > 0, true);

            await p.click('#flow .story-line .box[data-step="1"]');
            assert.equal(await p.getAttribute('#center .compose-step[data-step="1"] button.step-press', 'aria-pressed'), 'true');
            await p.click('#flow .compose-diagram-bar button.whole-diagram');
            await p.waitForSelector('#flow .canvas .box.screen.on-story');
            assert.equal(await p.locator('#flow .compose-diagram-bar button.line-diagram').count(), 1);
            await p.click('#flow .compose-diagram-bar button.line-diagram');
            await p.waitForSelector('#flow .story-line');
          }),
        ),
      ),
    ),
  );
});

function changeField(frame: Frame, id: string, attrs: Record<string, string>, value?: string) {
  return frame.evaluate(({ id, attrs, value }) => {
    let field = document.getElementById(id) as HTMLInputElement | null;
    if (!field) {
      field = document.createElement('input');
      field.id = id;
      for (const [k, v] of Object.entries(attrs)) field.setAttribute(k, v);
      document.body.append(field);
    }
    if (value !== undefined) field.value = value;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, { id, attrs, value });
}

test('in a browser, a recorded value cleared in the app leaves its step and the record, a box changed again without a name counts once on its screen, and the app opened again after leaving the story tab goes on from the last address without a step of its own, keeping a login made in the signed-out pane', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            await startNewStory(p);
            await p.click('#center button.walk-start');
            const frame = await walkFrame(p, app.url);
            await goTo(frame, '/signin');
            await changeField(frame, 'email', { placeholder: '이메일' }, EMAIL.value);
            await p.waitForSelector('#walk-steps > li:nth-child(2) .walk-inputs');
            await changeField(frame, 'email', {}, '');
            await changeField(frame, 'name', { placeholder: '이름' }, '  ');
            for (let i = 0; i < 3; i++) await changeField(frame, 'agree', { type: 'checkbox' });
            await changeField(frame, 'other', { type: 'checkbox' });
            await goTo(frame, '/help');
            await untilWalkSteps(p, 3);
            assert.deepEqual(await walkSteps(p), ['/ 맵에 없는 화면/', '/signin/signin값을 적지 않은 입력 2개', '/help/help']);

            await p.click('#view-list');
            await p.click(storiesTab);
            const again = await walkFrame(p, app.url);
            assert.equal(new URL(again.url()).pathname, '/help');
            await goTo(again, '/home');
            await untilWalkSteps(p, 4);
            assert.deepEqual(await walkSteps(p), ['/ 맵에 없는 화면/', '/signin/signin값을 적지 않은 입력 2개', '/help/help', '/home/home']);

            const token = await again.evaluate(() => localStorage.getItem('FAKE_AUTH'));
            assert.ok(token);
            await p.selectOption('#center .walk-pane', 'signed-out');
            const signedOut = await walkFrame(p, app.signedOutUrl);
            await untilSet(() => recordFiles(config.storiesDir).length === 1, 'the record of the account pane');
            await signedOut.evaluate((token) => localStorage.setItem('FAKE_AUTH', token), token);
            await goTo(signedOut, '/help');
            await untilWalkSteps(p, 5);
            await p.evaluate(() => { location.hash = `#screens?screen=${encodeURIComponent('/home#Home')}`; });
            await p.waitForSelector('#view-list.on');
            await p.click(storiesTab);
            const resumed = await walkFrame(p, app.signedOutUrl);
            assert.equal(new URL(resumed.url()).pathname, '/help');
            assert.equal(await resumed.evaluate(() => localStorage.getItem('FAKE_AUTH')), token);
            await goTo(resumed, '/signin');
            await untilWalkSteps(p, 6);
            assert.deepEqual((await walkSteps(p)).slice(4), ['/help/help', '/signin/signin']);

            await p.click('#center .walk-bar button.end-walk');
            await untilSet(() => recordFiles(config.storiesDir).length === 2, 'the record of the signed-out pane');
            assert.deepEqual(recordFiles(config.storiesDir).map((r) => JSON.stringify(r)).sort(), [
              { steps: [{ url: '/' }, { url: '/signin', skipped: 2 }, { url: '/help' }, { url: '/home' }] },
              { steps: [{ url: '/home' }, { url: '/help' }, { url: '/signin' }] },
            ].map((r) => JSON.stringify(r)).sort());
          }),
        ),
      ),
    ),
  );
});

test('in a browser, after a recording the values typed can be changed and conditions and expected results written for the whole story and for a step, all saved with the story, whose screen order then hides the candidate of the record file', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            await startNewStory(p);
            await pickScreen(p, '/home');
            await p.waitForSelector('#center .compose-step[data-step="0"]');
            await p.click('#center button.walk-start');
            const frame = await walkFrame(p, app.url);
            await goTo(frame, '/signin');
            await typeInto(frame, { placeholder: '이메일' }, EMAIL.value);
            await goTo(frame, '/help');
            await untilWalkSteps(p, 3);
            await p.click('#center .walk-bar button.end-walk');
            await p.waitForSelector('#center .walk-note:has-text("기록 파일")');
            const [record] = (await (await fetch(`${base}/api/data`)).json() as PageData).candidates.list.filter((c) => typeof c.source.record === 'string' && c.source.record.includes('/records/'));
            assert.deepEqual(record.screens, ['/home#Home', '/signin#SignIn', '/help#Help']);

            await p.hover('#center .compose-step[data-step="1"]');
            await p.click('#center .compose-step[data-step="1"] button.edit-fields');
            const value = p.locator('#center .compose-step[data-step="1"] .fields-edit input[aria-label="값"]');
            assert.equal(await value.inputValue(), EMAIL.value);
            await value.fill('other@example.com');
            await p.click('#center .compose-step[data-step="1"] .fields-part.expects button.add-line');
            await p.fill('#center .compose-step[data-step="1"] .fields-part.expects input', '로그인 칸이 보인다');
            await p.click('#center .compose-step[data-step="1"] button.close-fields');
            assert.match((await p.textContent('#center .compose-step[data-step="1"] .step-written'))!, /other@example\.com.*로그인 칸이 보인다/);

            await p.hover('#center .story-wide-blank');
            await p.click('#center .story-wide-blank button.edit-fields');
            await p.click('#center .fields-edit .fields-part.needs button.add-line');
            await p.fill('#center .fields-edit .fields-part.needs .line-text input', '회원 계정이 있다');
            await p.click('#center .fields-edit button.close-fields');

            await p.fill('#compose-id', 'walked-help');
            await p.fill('#compose-name', '로그인하고 도움말을 연다');
            await p.click('#right button.save-compose');
            await p.waitForSelector('#story-list li.selected:has-text("로그인하고 도움말을 연다")');
            const { date, ...saved } = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'walked-help.json'), 'utf8'));
            assert.deepEqual(saved, {
              name: '로그인하고 도움말을 연다',
              screens: ['/home#Home', { screen: '/signin#SignIn', inputs: [{ box: { placeholder: '이메일' }, value: 'other@example.com' }], expects: ['로그인 칸이 보인다'] }, '/help#Help'],
              needs: ['회원 계정이 있다'],
              memo: '',
              author: 'reviewer',
            });
            const after: PageData = await (await fetch(`${base}/api/data`)).json();
            assert.equal(after.candidates.list.some((c) => c.source.record === record.source.record), false);
            assert.equal(recordFiles(config.storiesDir).length, 1);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, choosing another pane while recording writes what was received so far as one record and starts another in that pane, which opens signed out through the sign-out address', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, signedOutPaths: ['/signin'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            await startNewStory(p);
            await p.click('#center button.walk-start');
            assert.deepEqual(await p.locator('#center .walk-pane option').allTextContents(), ['기본 계정 (duru-admin)', 'ADMIN 역할 (duru-boss)', 'AUDITOR 역할 (duru-auditor)', '로그아웃 상태']);
            const first = await walkFrame(p, app.url);
            await goTo(first, '/help');
            await untilWalkSteps(p, 2);

            await p.selectOption('#center .walk-pane', 'signed-out');
            const signedOut = await walkFrame(p, app.signedOutUrl);
            await signedOut.locator('#who:has-text("로그인 전")').waitFor();
            assert.equal(new URL(signedOut.url()).pathname, '/help');
            await untilSet(() => recordFiles(config.storiesDir).length === 1, 'the first record');
            assert.deepEqual(recordFiles(config.storiesDir), [{ steps: [{ url: '/' }, { url: '/help' }] }]);
            await goTo(signedOut, '/signin');
            await untilWalkSteps(p, 3);
            assert.equal(await p.locator(`#center iframe.app[src^="${app.url}/"]`).count(), 0);

            await p.click('#center .walk-bar button.end-walk');
            await untilSet(() => recordFiles(config.storiesDir).length === 2, 'the second record');
            assert.deepEqual(recordFiles(config.storiesDir).map((r) => r.steps.map((s: { url: string }) => s.url)).sort(), [['/', '/help'], ['/help', '/signin']]);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, an app that blocks inline scripts sends no address: the bar says none came, and 「기록 끝」 says the app sent none and writes no record', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          await withPage(base, async (p, errors) => {
            await startNewStory(p);
            await p.click('#center button.walk-start');
            await walkFrame(p, app.url);
            await p.waitForSelector('#center .walk-bar .walk-status:has-text("아직 앱에서 받은 주소가 없습니다")');
            await p.click('#center .walk-bar button.end-walk');
            assert.equal(await p.textContent('#center .walk-note'), '앱에서 주소를 받지 못했습니다. 앱이 보안 정책으로 인라인 스크립트를 막으면 주소를 받을 수 없습니다.');
            assert.equal(await p.locator('#flow .canvas').count() > 0, true);
            assert.deepEqual(recordFiles(config.storiesDir), []);
            errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('Content Security Policy')));
          }, {
            setup: (page) => page.route(`${app.url}/**`, async (route) => {
              const res = await route.fetch();
              const type = res.headers()['content-type'] ?? '';
              await route.fulfill({ response: res, headers: type.startsWith('text/html') ? { ...res.headers(), 'content-security-policy': "script-src 'self'" } : res.headers() });
            }),
          });
        }),
      ),
    ),
  );
});

test('in a browser, a review with only appUrl says that recording needs app instead of offering 「● 기록」, and one without either says nothing', { skip: browserMissing }, async () => {
  for (const [patch, note] of [[{ appUrl: 'http://localhost:3000' }, '앱을 돌아다니며 기록하는 것은 설정에 app 을 적어 duru 가 앱을 띄울 때만 됩니다'], [{}, null]] as const) {
    await withRebuiltFixture(patch, (config) =>
      withServer(config, 'reviewer', (base) =>
        withPage(base, async (p) => {
          await startNewStory(p);
          assert.equal(await p.locator('#center button.walk-start').count(), 0);
          assert.equal(await p.locator('#center .no-walk').count(), note ? 1 : 0);
          if (note) assert.equal(await p.textContent('#center .no-walk'), note);
        }),
      ),
    );
  }
});
