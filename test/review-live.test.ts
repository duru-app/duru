import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { loadMarks } from '../src/marks.ts';
import { startReviewServer } from '../src/review.ts';
import { withRebuiltFixture, signer, withServer, postMark, browserMissing, toList, withPage, reply, decideCase, CASE_KINDS, pickedBoxes, WALK, withPathStories, flowPlace, storyRow, pickPathStory, lineSteps, nowStep, CANDIDATES, storiesTab } from './review-helpers.ts';
import type { PageData, Kept } from './review-helpers.ts';

declare const state: any;
declare function load(): Promise<void>;
declare function render(): void;

test('in a browser, a reply sent with duru reply --server shows under its comment on the open page without a reload, unlabelled, not indented and on its own background, and text being typed in the form keeps its place', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.fill('#right-dock textarea', 'why is the list empty?');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("why is the list empty?")');
        const [comment] = loadMarks(config.marksDir);
        await p.evaluate(() => { (window as Window & Kept).kept = true; });
        await p.click('#right-dock textarea');
        await p.keyboard.type('half');

        await reply(copy, comment.id, 'the fixture has no rows', '--server', `${base}/`);
        await p.waitForSelector('#right .history > li:has-text("why is the list empty?") .replies li:has-text("the fixture has no rows")');
        assert.equal(await p.locator('#right .history > li').count(), 1);
        assert.equal(await p.locator('#right .history .replies li .chip').count(), 0);
        assert.match((await p.textContent('#right .history .replies li .muted'))!, /^agent · /);
        const look = (sel: string) => p.locator(sel).first().evaluate((e) => ({ left: e.getBoundingClientRect().left, background: getComputedStyle(e).backgroundColor }));
        const [asked, answered] = [await look('#right .history > li'), await look('#right .history .replies li')];
        assert.ok(Math.abs(answered.left - asked.left) < 1, `the answer starts at ${answered.left}, its comment at ${asked.left}`);
        assert.notEqual(answered.background, asked.background);
        assert.equal(await p.evaluate(() => (window as Window & Kept).kept), true);
        await p.keyboard.type(' and more');
        assert.equal(await p.inputValue('#right-dock textarea'), 'half and more');
      }),
    ),
  );
});

test('in a browser, a record arriving while the reviewer types keeps the field and its caret, waits while a Korean syllable is being composed, and the page reads its own save once', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const dataReads: string[] = [];
        p.on('request', (r) => new URL(r.url()).pathname === '/api/data' && dataReads.push(r.url()));
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.fill('#right-dock textarea', 'why is the list empty?');
        const before = dataReads.length;
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("why is the list empty?")');
        await p.waitForTimeout(300);
        assert.equal(dataReads.length - before, 1);
        const [comment] = loadMarks(config.marksDir);

        const nextEvent = () => p.evaluateHandle(() => ({
          heard: new Promise<void>((resolve) => {
            const events = new EventSource('/api/events');
            events.addEventListener('message', () => { events.close(); resolve(); });
            events.addEventListener('open', () => { (window as Window & Listening).listening = true; });
          }),
        }));
        const listen = async () => {
          await p.evaluate(() => { (window as Window & Listening).listening = false; });
          const heard = await nextEvent();
          await p.waitForFunction(() => (window as Window & Listening).listening);
          return heard;
        };

        await p.click('#right-dock textarea');
        await p.keyboard.type('abcdef');
        for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowLeft');
        await reply(copy, comment.id, 'first answer', '--server', `${base}/`);
        await p.waitForSelector('#right .history .replies li:has-text("first answer")');
        await p.keyboard.type('X');
        assert.equal(await p.inputValue('#right-dock textarea'), 'abcXdef');

        await p.dispatchEvent('#right-dock textarea', 'compositionstart');
        const heard = await listen();
        const reads = dataReads.length;
        await reply(copy, comment.id, 'second answer', '--server', `${base}/`);
        await p.evaluate((h) => h.heard, heard);
        await p.waitForTimeout(300);
        assert.equal(dataReads.length, reads);
        assert.equal(await p.locator('#right .history .replies li:has-text("second answer")').count(), 0);
        await p.dispatchEvent('#right-dock textarea', 'compositionend');
        await p.waitForSelector('#right .history .replies li:has-text("second answer")');
        assert.equal(await p.inputValue('#right-dock textarea'), 'abcXdef');

        await p.dispatchEvent('#right-dock textarea', 'compositionstart');
        await p.click('#screen-list li:has-text("/home")');
        await reply(copy, comment.id, 'third answer', '--server', `${base}/`);
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.waitForSelector('#right .history .replies li:has-text("third answer")');
      }),
    ),
  );
});

type Listening = { listening?: boolean };

test('closing the review server ends the open event streams, and a stream opened after 「리뷰 끝」 is ended at once', async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => null });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const open = await fetch(`${base}/api/events`);
    const body = open.text();
    await postMark(base, { target: { node: '/home#Home' }, note: 'while the stream is open' });
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    assert.match(await body, /^data: \{"duru":"comment",[^\n]*"note":"while the stream is open"[^\n]*\n\nevent: end\ndata: review ended\n\n$/);
    await closed;

    const again = await startReviewServer(config, { author: signer('reviewer'), onDone: () => null });
    const againBase = `http://127.0.0.1:${(again.address() as AddressInfo).port}`;
    try {
      const early = (await fetch(`${againBase}/api/events`)).text();
      const [end, during] = await Promise.all([
        fetch(`${againBase}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
        postMark(againBase, { target: { node: '/home#Home' }, note: 'saved as the review ends' }),
      ]);
      assert.deepEqual([end.status, during.status], [200, 201]);
      assert.match(await early, /event: end\ndata: review ended\n\n$/);
      const late = await fetch(`${againBase}/api/events`);
      assert.equal(await late.text(), 'event: end\ndata: review ended\n\n');
      const saved = await postMark(againBase, { target: { node: '/home#Home' }, note: 'saved after the end' });
      assert.equal(saved.status, 201);
    } finally {
      again.close();
    }
  });
});

async function listenTo(url: string) {
  const res = await fetch(url);
  const got = { text: '' };
  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of res.body!) got.text += decoder.decode(chunk, { stream: true });
  })();
  return { got, stories: () => [...got.text.matchAll(/^event: stories\ndata: (.*)$/gm)].map((m) => m[1]) };
}

const until = async (check: () => boolean, what: string) => {
  for (const end = Date.now() + 5_000; !check(); await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (Date.now() > end) throw new Error(`no ${what} within 5s`);
  }
};

const storyJson = (name: string) => JSON.stringify({ name, screens: ['/home#Home'], author: 'a', date: '2026-10-03' });

test('a change under the stories folder, in any of its sub-folders, or to a folder made only after the server started, is sent once per burst on the event streams as a stories event carrying the version the data then reports, and never as a comment line or to onMark', async () => {
  await withRebuiltFixture({ storiesDir: 'later-stories' }, async (config) => {
    const lines: unknown[] = [];
    const server = await startReviewServer(config, { author: signer('reviewer'), onMark: (line) => lines.push(line) });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const version = async () => ((await (await fetch(`${base}/api/data`)).json()) as { storiesVersion: string }).storiesVersion;
    try {
      const stream = await listenTo(`${base}/api/events`);
      const missing = await version();
      fs.mkdirSync(config.storiesDir);
      for (const id of ['one', 'two', 'three']) fs.writeFileSync(path.join(config.storiesDir, `${id}.json`), storyJson(id));
      await until(() => stream.stories().length === 1, 'stories event for the new folder');
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(stream.stories(), [await version()]);
      assert.notEqual(stream.stories()[0], missing);
      assert.equal(((await (await fetch(`${base}/api/data`)).json()) as PageData).stories.list.length, 3);

      fs.writeFileSync(path.join(config.storiesDir, 'one.json'), storyJson('one'));
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(stream.stories().length, 1, 'writing the same content again changes nothing');

      fs.mkdirSync(path.join(config.storiesDir, 'candidates', 'later'), { recursive: true });
      fs.writeFileSync(path.join(config.storiesDir, 'candidates', 'later', 'note.txt'), 'x');
      await until(() => stream.stories().length === 2, 'stories event for a file in a new sub-folder');

      fs.rmSync(config.storiesDir, { recursive: true });
      await until(() => stream.stories().length === 3, 'stories event for the removed folder');
      assert.equal(stream.stories()[2], missing);
      fs.mkdirSync(config.storiesDir);
      fs.writeFileSync(path.join(config.storiesDir, 'two.json'), storyJson('two'));
      await until(() => stream.stories().length === 4, 'stories event for the folder made again');
      fs.writeFileSync(path.join(config.storiesDir, 'two.json'), storyJson('two again'));
      await until(() => stream.stories().length === 5, 'stories event for a file in the folder made again');
      assert.equal(stream.stories()[4], await version());

      assert.match(stream.got.text, /^(event: stories\ndata: [0-9a-f]+\n\n)+$/);
      assert.deepEqual(lines, []);
    } finally {
      server.close();
    }
  });
});

test('a stories setting that names one story file sends a stories event when that file is written or replaced, and nothing for its neighbours', async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories/run-lab.json' }, async (config) => {
    const server = await startReviewServer(config, { author: signer('reviewer') });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const stream = await listenTo(`${base}/api/events`);
      fs.writeFileSync(path.join(path.dirname(config.storiesDir), 'read-reports.json'), storyJson('neighbour'));
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.deepEqual(stream.stories(), []);

      fs.writeFileSync(config.storiesDir, storyJson('edited in place'));
      await until(() => stream.stories().length === 1, 'stories event for the file written');
      const replacement = `${config.storiesDir}.tmp`;
      fs.writeFileSync(replacement, storyJson('replaced'));
      fs.renameSync(replacement, config.storiesDir);
      await until(() => stream.stories().length === 2, 'stories event for the file replaced');
      const data = (await (await fetch(`${base}/api/data`)).json()) as PageData & { storiesVersion: string };
      assert.deepEqual(data.stories.list.map((s) => s.name), ['replaced']);
      assert.equal(stream.stories()[1], data.storiesVersion);
    } finally {
      server.close();
    }
  });
});

test('a sub-folder of the stories folder that cannot be read leaves the other story files watched', { skip: process.getuid?.() === 0 && 'root reads a folder whatever its permissions' }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    const locked = path.join(config.storiesDir, 'locked');
    fs.mkdirSync(locked);
    let server: http.Server | null = null;
    try {
      fs.chmodSync(locked, 0o000);
      assert.throws(() => fs.readdirSync(locked));
      server = await startReviewServer(config, { author: signer('reviewer') });
      const stream = await listenTo(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`);
      fs.writeFileSync(path.join(config.storiesDir, 'run-lab.json'), storyJson('next to a locked folder'));
      await until(() => stream.stories().length === 1, 'stories event for the story file');
    } finally {
      server?.close();
      fs.chmodSync(locked, 0o755);
    }
  });
});

test('a story file in the stories folder or in a sub-folder sends a stories event for every later write after it was replaced by a rename, deleted and written again, or its sub-folder was made again', async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    const server = await startReviewServer(config, { author: signer('reviewer') });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const stream = await listenTo(`${base}/api/events`);
      let writes = 0;
      const expectEvent = async (what: string, write: () => void) => {
        write();
        writes += 1;
        const { storiesVersion } = (await (await fetch(`${base}/api/data`)).json()) as { storiesVersion: string };
        await until(() => stream.stories().at(-1) === storiesVersion, `stories event after ${what}`);
      };
      const replace = (file: string) => () => {
        fs.writeFileSync(`${file}.tmp`, storyJson(`replaced ${writes}`));
        fs.renameSync(`${file}.tmp`, file);
      };
      const inPlace = (file: string) => () => fs.writeFileSync(file, storyJson(`in place ${writes}`));
      const story = path.join(config.storiesDir, 'run-lab.json');
      await expectEvent('a first rename over the file', replace(story));
      await expectEvent('a second rename over the file', replace(story));
      await expectEvent('a write in place after the renames', inPlace(story));
      await expectEvent('deleting and writing the file again', () => {
        fs.rmSync(story);
        fs.writeFileSync(story, storyJson('written again'));
      });
      await expectEvent('a write in place after it was written again', inPlace(story));

      const below = path.join(config.storiesDir, 'candidates');
      const candidate = path.join(below, 'later.json');
      await expectEvent('a new sub-folder with a file', () => {
        fs.mkdirSync(below);
        fs.writeFileSync(candidate, storyJson('candidate'));
      });
      await expectEvent('a first rename over the file in the sub-folder', replace(candidate));
      await expectEvent('a second rename over the file in the sub-folder', replace(candidate));
      await expectEvent('the sub-folder made again', () => {
        fs.rmSync(below, { recursive: true });
        fs.mkdirSync(below);
        fs.writeFileSync(candidate, storyJson('candidate again'));
      });
      await expectEvent('a write in place in the sub-folder made again', inPlace(candidate));
      const data = (await (await fetch(`${base}/api/data`)).json()) as { storiesVersion: string };
      assert.equal(stream.stories().at(-1), data.storiesVersion);
    } finally {
      server.close();
    }
  });
});

test('in a browser, a mark and a comment saved in one page show in a second page that is already open', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const other = await p.context().browser()!.newPage();
        const otherErrors: string[] = [];
        other.on('pageerror', (e) => otherErrors.push(e.message));
        other.on('console', (m) => m.type() === 'error' && otherErrors.push(m.text()));
        await other.goto(base);
        await toList(other);
        await other.click('#screen-list li:has-text("/document/:id")');
        await other.evaluate(() => { (window as Window & Kept).kept = true; });

        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#right .statuses button:has-text("테스트 필요")');
        await p.click('#right button.save');
        await other.waitForSelector('#screen-list li.selected .chip.needs-more');
        await p.fill('#right-dock textarea', 'from the first page');
        await p.click('#right button.save');
        await other.waitForSelector('#right .history li:has-text("from the first page")');
        assert.equal(await other.evaluate(() => (window as Window & Kept).kept), true);
        assert.deepEqual(otherErrors, []);
      }),
    ),
  );
});

test('in a browser, a reply written without --server is not pushed to the open page and shows once the page is loaded again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.fill('#right-dock textarea', 'why is the list empty?');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("why is the list empty?")');
        const [comment] = loadMarks(config.marksDir);

        await reply(copy, comment.id, 'the fixture has no rows');
        assert.equal(loadMarks(config.marksDir).length, 2);
        assert.equal(await p.locator('#right .history .replies').count(), 0);
        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.waitForSelector('#right .history > li:has-text("why is the list empty?") .replies li:has-text("the fixture has no rows")');
      }),
    ),
  );
});

test('in a browser, a case sent with duru case --server shows in 「경우별 테스트」 on the open page without a reload, one the agent takes out waiting as 「검토 중」 with its reason and a picked one with its kind pressed and agent on it, and text being typed in the form keeps its place', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const read = 'GET:/api/v1/document/{documentId}';
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls tbody tr:not(.option)', { hasText: read }).locator('td.cell').first().click();
        const cases = p.locator('#center .call-info > .cases');
        await cases.waitFor();
        await p.evaluate(() => { (window as Window & Kept).kept = true; });
        await p.click('#right-dock textarea');
        await p.keyboard.type('half');

        await decideCase(copy, 'boundary', read, 'not-needed', '--note', '읽기에는 입력이 없다', '--server', `${base}/`);
        const review = cases.locator('li.case-review-row[data-kind="boundary"]');
        await review.waitFor();
        assert.match((await review.locator('.case-proposal').textContent())!, /^agent · /);
        assert.equal(await review.locator('.case-reason').textContent(), '이유 읽기에는 입력이 없다');
        assert.equal(await cases.locator('li.case-left-out').count(), 0);

        await decideCase(copy, 'legacy', read, 'needed', '--server', base);
        await cases.locator('.case-kinds button[aria-pressed="true"]', { hasText: CASE_KINDS.legacy }).waitFor();
        assert.deepEqual(await cases.locator('.case-head .chip.pick-person').allTextContents(), ['agent']);
        assert.equal(await p.evaluate(() => (window as Window & Kept).kept), true);
        await p.keyboard.type(' and more');
        assert.equal(await p.inputValue('#right-dock textarea'), 'half and more');
      }),
    ),
  );
});

test('in a browser, a story shown in the story tab whose file changes while the page is open is drawn again from its new steps, and one whose file is removed gives way to the first story', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p, { writeStory, storyFile }) => {
    await pickPathStory(p, 'walk-around');
    await p.locator('#center .story-line .box[data-step="1"]').click();
    writeStory('walk-around', ['/signin#SignIn', '/home#Home', '/help#Help']);
    await p.evaluate(async () => { await load(); render(); });
    assert.deepEqual(await nowStep(p), ['2'], 'a pressed step whose screen stays in place stays marked');
    writeStory('walk-around', ['/signin#SignIn', '/help#Help', '/home#Home']);
    await p.evaluate(async () => { await load(); render(); });
    assert.deepEqual(await nowStep(p), [], 'a pressed step whose screen changed is no longer marked');

    writeStory('walk-around', WALK);
    await p.evaluate(async () => { await load(); render(); });
    await p.locator('#center .story-line .box[data-step="6"]').click();
    writeStory('walk-around', ['/signin#SignIn', '/help#Help']);
    await p.evaluate(async () => { await load(); render(); });
    assert.deepEqual(await lineSteps(p), [['1', '/signin#SignIn'], ['2', '/help#Help']]);
    assert.equal(await p.locator('#center .story-path > .step').count(), 2);
    assert.equal((await nowStep(p)).every((n) => Number(n) <= 2), true, 'a marked step past the new end is dropped');

    fs.rmSync(storyFile('walk-around'));
    await p.evaluate(async () => { await load(); render(); });
    assert.equal(await storyRow(p, 'walk-around').count(), 0);
    const first = await p.evaluate(() => state.data.stories.list[0].id);
    assert.equal(await flowPlace(p), `#story?story=${first}`);
  });
});

test('in a browser, a story file changed, added or removed outside the page shows without reloading it, the name being typed keeps its text and caret while the untouched memo follows the file, and the page\'s own save is read once', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const dataReads: string[] = [];
        p.on('request', (r) => new URL(r.url()).pathname === '/api/data' && dataReads.push(r.url()));
        const rewrite = (id: string, change: object) => {
          const file = path.join(config.storiesDir, `${id}.json`);
          fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...change }));
        };
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#story-list li:has-text("실험실을 열어")');
        await p.evaluate(() => { (window as Window & Kept).kept = true; });
        await p.fill('#story-name', '실험실 결과 본다');
        for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowLeft');

        rewrite('run-lab', { memo: '파일에서 고친 메모' });
        rewrite('read-reports', { name: '관리자가 보고서를 내려받는다' });
        await p.waitForSelector('#story-list li:has-text("관리자가 보고서를 내려받는다")');
        await p.waitForSelector('#center .memo:has-text("파일에서 고친 메모")');
        assert.equal(await p.inputValue('#story-memo'), '파일에서 고친 메모');
        await p.keyboard.type('를');
        assert.equal(await p.inputValue('#story-name'), '실험실 결과를 본다');

        fs.writeFileSync(path.join(config.storiesDir, 'from-outside.json'), storyJson('밖에서 쓴 스토리'));
        await p.waitForSelector('#story-list li:has-text("밖에서 쓴 스토리")');
        fs.rmSync(path.join(config.storiesDir, 'from-outside.json'));
        await p.waitForFunction(() => !document.querySelector('#story-list')!.textContent!.includes('밖에서 쓴 스토리'));
        assert.equal(await p.evaluate(() => (window as Window & Kept).kept), true);

        const before = dataReads.length;
        await p.click('#center button.save-story');
        await p.waitForSelector('#story-list li.selected:has-text("실험실 결과를 본다")');
        await p.waitForTimeout(600);
        assert.equal(dataReads.length - before, 1);
      }),
    ),
  );
});
