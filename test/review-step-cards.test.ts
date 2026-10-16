import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UNKNOWN } from '../src/client.ts';
import { withRebuiltFixture, withServer, rewrite, rebuild, browserMissing, withPage, untaggedTab, screenBox } from './review-helpers.ts';

declare const state: any;
declare function render(): void;

test('in a browser, the story list sits next to the screen list, and a chosen story shows its screens in order with each link\'s verdict and what it takes to get to the end', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.deepEqual(await p.locator('#left .views.side button').allTextContents(), ['화면 11', '스토리 5', '태그 없음 13']);
        assert.deepEqual(await p.locator('#left .views.side .tab-name').allTextContents(), ['화면', '스토리', '태그 없음']);
        assert.deepEqual(await p.locator('#left .views.side .tab-count').allTextContents(), ['11', '5', '13']);
        assert.equal(await p.getAttribute(untaggedTab, 'title'), '노드 태그도 스토리 태그도 없는 테스트');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.deepEqual(await p.locator('#story-list li .name > span:first-child').allTextContents(), [
          '홈에서 개인 설정을 바꾼다', '홈에서 바로 도움말을 연다', '로그인해 문서 목록에서 문서를 연다', '관리자가 보고서를 본다', '실험실을 열어 결과를 본다',
        ]);
        assert.deepEqual(await p.locator('#story-list li').evaluateAll((items) => items.map((li) => [...li.querySelectorAll('.chip')].map((c) => c.textContent))), [
          ['일부 화면만 테스트', '화면 없음'], ['보류', '링크 없음'], [], ['테스트 없음'], ['실패'],
        ]);
        assert.equal(await p.locator('#story-list li:has-text("개인 설정") .chip.l-off-map').getAttribute('title'), '맵에서 찾을 수 없는 화면: /settings#Settings');
        assert.match((await p.textContent('#left .notices'))!, /lab-shortcut\.json.*screens 는/);

        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.textContent('#center h3'), '실험실을 열어 결과를 본다');
        assert.match((await p.textContent('#center .memo'))!, /고객사 설정/);
        assert.deepEqual(await p.locator('#center .story-path .step .name > span:first-child').allTextContents(), ['/home', '/lab', '/lab/result']);
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['조건', '이어짐']);
        assert.match((await p.textContent('#center .story-path .link.l-conditioned'))!, /components\/Home\.js:19\s*globalSettings\.SYSTEM\.LAB_ENABLED\s*설정/);
        assert.deepEqual(await p.locator('#right-info > :not(.talk-scope)').evaluateAll((els) => els.slice(0, 2).map((e) => e.textContent)), ['도달 가능', '사전 조건']);
        assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트']);
        assert.match((await p.textContent('#right .reach-link'))!, /components\/Home\.js:19/);
        assert.match((await p.textContent('#right .reach-route'))!, /Routes\.js:44.*globalSettings\.SYSTEM\.LAB_ENABLED/);
        assert.equal(await p.locator('#center iframe').count(), 0);

        await p.click('#story-list li:has-text("도움말")');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['이어짐', '링크 없음']);
        assert.equal(await p.textContent('#center .story-path .link.l-broken'), '링크 없음');
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 불가 · 링크 없음 1곳']);

        await p.click('#story-list li:has-text("개인 설정")');
        assert.equal(await p.textContent('#center .story-path .step.off-map .chip'), '맵에 없는 화면');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['판정 못 함']);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['판정 못 함 · 화면 없음']);

        await p.click('#story-list li:has-text("문서를 연다")');
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 가능']);
        assert.equal(await p.textContent('#right-info > p.muted'), '조건 없음');
        await p.click('#center .story-path .step:has-text("/document/:id")');
        assert.equal(await p.getAttribute('#left .views.side button.on', 'class'), 'on');
        assert.equal(await p.textContent('#left .views.side button.on'), '화면 11');
        assert.equal(await p.textContent('#center h3'), '/document/:id');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/document\/:id/);

        await p.click('#left .views.side button:has-text("스토리")');
        assert.equal(await p.textContent('#story-list li.selected .name > span:first-child'), '로그인해 문서 목록에서 문서를 연다');

        await p.click('#view-flow');
        await (await screenBox(p, '/lab/result#LabResult')).click();
        await p.waitForSelector('#flow .box.picked');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
        await p.click('#view-list');
        assert.equal(await p.textContent('#left .views.side button.on'), '화면 11');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
      }),
    ),
  );
});

test('in a browser, the needs and expects written in a story file show in a 「스토리」 box and in each step card, the flow\'s one-line story counts them with the lines on hover, the file shows folded at the bottom, and a story without them shows none of this', { skip: browserMissing }, async () => {
  const written = {
    name: '실험 결과를 확인한다',
    needs: ['실험이 한 번 이상 돌았다'],
    screens: ['/home#Home', { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'], expects: ['실험 목록이 보인다', '「실행」 단추가 보인다'] }, '/lab/result#LabResult'],
    expects: ['마지막 실행 결과가 보인다'],
    memo: '',
    author: 'reviewer',
    date: '2026-10-05',
  };
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/lab-notes.json'), JSON.stringify(written));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험 결과를 확인한다")');
        assert.equal(await p.textContent('#center .story-wide h2'), '스토리');
        assert.deepEqual(await p.locator('#center .story-wide .written-row').evaluateAll((rows) => rows.map((r) => [r.querySelector('.written-label')!.textContent, [...r.querySelectorAll('li')].map((li) => li.textContent)])), [
          ['조건', ['실험이 한 번 이상 돌았다']],
          ['끝난 뒤 기대 결과', ['마지막 실행 결과가 보인다']],
        ]);
        assert.deepEqual(await p.locator('#center .story-path .step').evaluateAll((steps) => steps.map((s) => [...s.querySelectorAll('.step-written .written-row')].map((r) => [r.querySelector('.written-label')!.textContent, [...r.querySelectorAll('li')].map((li) => li.textContent)]))), [
          [],
          [['조건', ['실험실 설정을 켠다']], ['기대 결과', ['실험 목록이 보인다', '「실행」 단추가 보인다']]],
          [],
        ]);
        await p.click('#center .step-written li:has-text("실험 목록이 보인다")');
        assert.equal(await p.textContent('#center h3'), '실험 결과를 확인한다', 'pressing the written lines does not open the screen');
        assert.deepEqual(await p.locator('#right-info > :not(.talk-scope)').evaluateAll((els) => els.slice(0, 2).map((e) => e.textContent)), ['도달 가능', '사전 조건']);
        assert.equal(await p.textContent('#center details.story-file summary'), '스토리 파일 lab-notes.json');
        assert.equal(await p.locator('#center details.story-file[open]').count(), 0);
        await p.click('#center details.story-file summary');
        assert.deepEqual(JSON.parse((await p.textContent('#center details.story-file pre'))!), written);
        // details 의 toggle 이벤트는 다음 틱에 발생하므로, 그 뒤에 다시 그린다.
        await p.evaluate(() => new Promise((done) => setTimeout(done)).then(() => render()));
        assert.equal(await p.locator('#center details.story-file[open]').count(), 1, 'the opened file stays open when the page is drawn again');

        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.locator('#center .story-wide, #center .step-written').count(), 0);
        assert.deepEqual(JSON.parse((await p.textContent('#center details.story-file pre'))!), JSON.parse(fs.readFileSync(path.join(copy, 'example-stories/run-lab.json'), 'utf8')));

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box.screen');
        await p.click('#flow-story-list li[data-story="lab-notes"]');
        await p.waitForFunction(() => state.storyPath?.id === 'lab-notes');
        assert.deepEqual(await p.$$eval('#flow .story-line [data-step]', (els) => els.map((e) => e.querySelector('.written-count')?.textContent ?? null)), [null, '조건 1 · 기대 2', null]);
        assert.equal(await p.getAttribute('#flow .story-line [data-step="1"] .written-count', 'title'), '조건: 실험실 설정을 켠다\n기대: 실험 목록이 보인다\n기대: 「실행」 단추가 보인다');
        assert.equal(await p.textContent('#flow-head .story-on .written-count'), '조건 1 · 기대 1');
        assert.equal(await p.getAttribute('#flow-head .story-on .written-count', 'title'), '조건: 실험이 한 번 이상 돌았다\n기대: 마지막 실행 결과가 보인다');
        await p.click('#flow-story-list li[data-story="run-lab"]');
        await p.waitForFunction(() => state.storyPath?.id === 'run-lab');
        assert.equal(await p.locator('#flow .written-count, #flow-head .written-count').count(), 0);
      }),
    );
  });
});

test('in a browser, the conditions written for the link into a step show on the link row before that step and under the line before its box in the flow\'s one-line story, cut short there when long with every line on hover', { skip: browserMissing }, async () => {
  const written = {
    name: '실험 결과로 들어간다',
    screens: ['/home#Home', { screen: '/lab#Lab', linkNeeds: ['반려된 경우'] }, { screen: '/lab/result#LabResult', expects: ['결과가 보인다'], linkNeeds: ['실행이 끝나 결과 화면으로 넘어가는 경우', '결과가 하나 이상인 경우'] }],
    memo: '',
    author: 'reviewer',
    date: '2026-10-05',
  };
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/lab-links.json'), JSON.stringify(written));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험 결과로 들어간다")');
        assert.deepEqual(await p.locator('#center .story-path .link').evaluateAll((links) => links.map((l) => [
          l.querySelector('.link-verdict')!.textContent,
          [...l.querySelectorAll('.link-written .written-row')].map((r) => [r.querySelector('.written-label')!.textContent, [...r.querySelectorAll('li')].map((li) => li.textContent)]),
        ])), [
          ['조건', [['들어오는 링크 조건', ['반려된 경우']]]],
          ['이어짐', [['들어오는 링크 조건', ['실행이 끝나 결과 화면으로 넘어가는 경우', '결과가 하나 이상인 경우']]]],
        ]);
        assert.deepEqual(await p.locator('#center .story-path .step').evaluateAll((steps) => steps.map((s) => [...s.querySelectorAll('.step-written .written-label')].map((l) => l.textContent))), [[], [], ['기대 결과']], 'the link conditions stay out of the step cards');
        await p.click('#center details.story-file summary');
        assert.deepEqual(JSON.parse((await p.textContent('#center details.story-file pre'))!), written);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box.screen');
        await p.click('#flow-story-list li[data-story="lab-links"]');
        await p.waitForFunction(() => state.storyPath?.id === 'lab-links');
        assert.deepEqual(await p.$$eval('#flow .story-line [data-step]', (els) => els.map((e) => e.querySelector('.written-count')?.textContent ?? null)), [null, null, '기대 1'], 'the step boxes do not count the link conditions');
        const needs = () => p.$$eval('#flow .story-line .story-hop', (hops) => hops.map((hop) => {
          const need = hop.querySelector<HTMLElement>('.hop-need');
          if (!need) return null;
          const line = hop.querySelector('svg')!.getBoundingClientRect();
          const r = need.getBoundingClientRect();
          const tag = hop.querySelector('.story-tag')?.getBoundingClientRect();
          return {
            text: need.textContent,
            title: need.title,
            cut: need.scrollWidth > need.clientWidth,
            under: r.top >= line.bottom && (!tag || r.top >= tag.bottom),
            within: r.left >= line.left - 0.5 && r.right <= line.right + 0.5,
          };
        }));
        assert.deepEqual(await needs(), [
          { text: '반려된 경우', title: '들어오는 링크 조건\n반려된 경우', cut: false, under: true, within: true },
          { text: '실행이 끝나 결과 화면으로 넘어가는 경우 · 결과가 하나 이상인 경우', title: '들어오는 링크 조건\n실행이 끝나 결과 화면으로 넘어가는 경우\n결과가 하나 이상인 경우', cut: true, under: true, within: true },
        ]);
        assert.ok(await p.$eval('#flow .story-line .story-row', (row) => [...row.querySelectorAll('.hop-need')].every((n) => n.getBoundingClientRect().bottom <= row.getBoundingClientRect().bottom + 0.5)), 'the conditions under the lines stay inside the story row');

        await p.click('#flow-story-list li[data-story="run-lab"]');
        await p.waitForFunction(() => state.storyPath?.id === 'run-lab');
        assert.equal(await p.locator('#flow .hop-need').count(), 0);
      }),
    );
  });
});

test('in a browser, the inputs written for a step show in its card with the words its box is found by, its number, the value and 확인 안 됨 on each line, and the flow\'s one-line story counts them with the lines on hover', { skip: browserMissing }, async () => {
  const written = {
    name: '실험 이름을 적어 돌린다',
    screens: [
      '/home#Home',
      { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'], inputs: [{ box: { testId: 'lab-name', placeholder: '실험 이름' }, value: '첫 실험' }, { box: { label: '서명자 메모', nth: 2 }, value: '확인했습니다' }], expects: ['「실행」 단추가 보인다'] },
      { screen: '/lab/result#LabResult', inputs: [{ box: { label: '검색어' }, value: '계약서' }] },
    ],
    memo: '',
    author: 'reviewer',
    date: '2026-10-05',
  };
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/lab-inputs.json'), JSON.stringify(written));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험 이름을 적어 돌린다")');
        assert.deepEqual(await p.locator('#center .story-path .step').evaluateAll((steps) => steps.map((s) => [...s.querySelectorAll('.step-written .written-label')].map((l) => l.textContent))), [[], ['조건', '입력값', '기대 결과'], ['입력값']]);
        const rows = () => p.locator('#center .story-path .step').evaluateAll((steps) => steps.map((s) => [...s.querySelectorAll('.step-written .written-row.inputs tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))));
        assert.deepEqual(await rows(), [
          [],
          [['안내 글 「실험 이름」 또는 테스트 ID 「lab-name」', '첫 실험', '확인 안 됨'], ['라벨 「서명자 메모」 · 2 번째', '확인했습니다', '확인 안 됨']],
          [['라벨 「검색어」', '계약서', '확인 안 됨']],
        ]);
        assert.equal(await p.getAttribute('#center .step-written .input-unchecked >> nth=0', 'title'), 'duru 가 코드에서 이 상자를 찾아보지 않았습니다');
        await p.click('#center .step-written td:has-text("계약서")');
        assert.equal(await p.textContent('#center h3'), '실험 이름을 적어 돌린다', 'pressing an input line does not open the screen');
        await p.click('#center details.story-file summary');
        assert.deepEqual(JSON.parse((await p.textContent('#center details.story-file pre'))!), written);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box.screen');
        await p.click('#flow-story-list li[data-story="lab-inputs"]');
        await p.waitForFunction(() => state.storyPath?.id === 'lab-inputs');
        assert.deepEqual(await p.$$eval('#flow .story-line [data-step]', (els) => els.map((e) => e.querySelector('.written-count')?.textContent ?? null)), [null, '조건 1 · 입력 2 · 기대 1', '입력 1']);
        assert.equal(await p.getAttribute('#flow .story-line [data-step="1"] .written-count', 'title'), '조건: 실험실 설정을 켠다\n입력: 안내 글 「실험 이름」 또는 테스트 ID 「lab-name」 → 첫 실험\n입력: 라벨 「서명자 메모」 · 2 번째 → 확인했습니다\n기대: 「실행」 단추가 보인다');
      }),
    );
  });
});

test('in a browser, a step that a move in the config joins shows as 설정에 적은 이동 with its reason, and the story is reachable', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories', moves: [{ from: '/signin', to: '/lab/result', reason: '로그인 뒤' }] }, (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/signin-lab.json'), JSON.stringify({ name: '로그인해서 실험 결과를 본다', screens: ['/signin#SignIn', '/lab/result#LabResult'], author: 'a', date: '2026-10-03' }));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험 결과를 본다")');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['설정에 적은 이동']);
        assert.equal(await p.textContent('#center .story-path .link.l-configured'), '설정에 적은 이동 로그인 뒤');
        assert.match((await p.getAttribute('#center .story-path .link.l-configured .link-verdict', 'title'))!, /moves/);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 가능']);
      }),
    );
  });
});

test('in a browser, a step whose first screen has no link to the next but has links to a path duru cannot read is not judged, and those links are listed, also next to a conditioned step judged without them but not next to an open one', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    rewrite(copy, 'client/src/_define/Option.js', "SIGN_IN: this.CONTEXT_PATH + 'signin',", "ROOT: this.CONTEXT_PATH,\n      SIGN_IN: this.CONTEXT_PATH + 'signin',");
    rewrite(copy, 'client/src/components/Lab.js', '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>',
      '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>\n      <Link to={Option.ROUTE_PATH.ROOT}>Start</Link>\n      <Link to={Option.ROUTE_PATH.NOPE}>Nope</Link>');
    rewrite(copy, 'client/src/components/Home.js', '<Link to={Option.ROUTE_PATH.LAB}>Lab</Link>}', '<Link to={Option.ROUTE_PATH.LAB}>Lab</Link>}\n      <Link to={Option.ROUTE_PATH.NOPE}>Nope</Link>');
    rebuild(copy);
    fs.mkdirSync(config.storiesDir, { recursive: true });
    const story = (name: string, screens: string[]) => JSON.stringify({ name, screens, author: 'a', date: '2026-10-02' });
    fs.writeFileSync(path.join(config.storiesDir, 'lab-to-start.json'), story('실험실에서 처음으로', ['/lab#Lab', '/signin#SignIn']));
    fs.writeFileSync(path.join(config.storiesDir, 'home-to-lab-result.json'), story('홈에서 실험 결과로', ['/home#Home', '/lab#Lab', '/lab/result#LabResult']));
    fs.writeFileSync(path.join(config.storiesDir, 'lab-result.json'), story('실험실에서 결과로', ['/lab#Lab', '/lab/result#LabResult']));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.deepEqual(await p.locator('#story-list li').evaluateAll((items) => items.map((li) => [...li.querySelectorAll('.chip')].map((c) => c.textContent))), [
          ['일부 화면만 테스트'], ['일부 화면만 테스트'], ['일부 화면만 테스트', '판정 못 함'],
        ]);

        await p.click('#story-list li:has-text("처음으로")');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['판정 못 함']);
        assert.deepEqual(await p.locator('#center .story-path .link.l-unknown li').allTextContents(), [`components/Lab.js:16 → ${UNKNOWN}`]);
        assert.doesNotMatch((await p.textContent('#center .story-path'))!, /리다이렉트/);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['판정 못 함 · 주소 못 읽은 링크']);
        assert.equal(await p.locator('#right .skipped').count(), 0);

        await p.click('#story-list li:has-text("실험 결과로")');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['조건', '이어짐']);
        const skipped = (link: string) => p.locator(`#center .story-path .link.${link} .unknown-links li`).allTextContents();
        assert.deepEqual(await skipped('l-conditioned'), [`components/Home.js:20 → ${UNKNOWN}`]);
        assert.match((await p.textContent('#center .story-path .link.l-conditioned .skipped'))!, /판정에서 뺀 링크/);
        assert.deepEqual(await skipped('l-open'), []);
        assert.equal(await p.locator('#center .story-path .link.l-open .skipped').count(), 0);
        assert.match((await p.textContent('#right-info > p.skipped'))!, /주소 못 읽은 링크 빼고 판정/);
        assert.deepEqual(await p.locator('#right .reach-link .unknown-links li').allTextContents(), [`components/Home.js:20 → ${UNKNOWN}`]);

        await p.click('#story-list li:has-text("실험실에서 결과로")');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['이어짐']);
        assert.equal(await p.locator('#center .skipped').count(), 0);
        assert.equal(await p.locator('#right .skipped').count(), 0);
      }),
    );
  });
});

test('in a browser, the right of a story gives a verdict line for missing links and one for a screen off the map, counting the missing links', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    fs.mkdirSync(config.storiesDir, { recursive: true });
    fs.writeFileSync(path.join(config.storiesDir, 'back-and-forth.json'), JSON.stringify({
      name: '도움말을 오간다', screens: ['/home#Home', '/help#Help', '/home#Home', '/help#Help', '/settings#Settings'], author: 'a', date: '2026-10-03',
    }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("도움말을 오간다")');
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 불가 · 링크 없음 3곳', '판정 못 함 · 화면 없음']);
        assert.deepEqual(await p.locator('#right .verdict').evaluateAll((els) => els.map((e) => e.className)), ['verdict unreachable', 'verdict unjudged']);
        assert.equal(await p.textContent('#right-info > p.muted:not(.skipped)'), '판정한 구간에 조건 없음');
      }),
    );
  });
});

test('in a browser, a need that picks a need file shows as 공통 조건 with its name, its file and text on hover, in the 「스토리」 box, in the step card and next to the story\'s name in the flow, a pick of a file that is not there or could not be read shows as such while the story is still read, and pressing a picked need opens it', { skip: browserMissing }, async () => {
  const picking = {
    name: '실험 결과를 확인한다',
    needs: [{ use: 'member-account.json' }, '실험이 한 번 이상 돌았다'],
    screens: ['/home#Home', { screen: '/lab#Lab', needs: [{ use: 'old-admin.json' }, { use: 'broken.json' }] }, '/lab/result#LabResult'],
    memo: '',
    author: 'reviewer',
    date: '2026-10-05',
  };
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/lab-notes.json'), JSON.stringify(picking));
    fs.mkdirSync(path.join(copy, 'example-stories/needs'));
    fs.writeFileSync(path.join(copy, 'example-stories/needs/member-account.json'), JSON.stringify({ name: '일반 회원 계정', text: '역할 USER 로 가입한 계정' }));
    fs.writeFileSync(path.join(copy, 'example-stories/needs/broken.json'), JSON.stringify({ name: '이름만 있다' }));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험 결과를 확인한다")');
        assert.deepEqual(await p.locator('#center .story-wide .written-row.needs li').allTextContents(), ['공통 조건 일반 회원 계정', '실험이 한 번 이상 돌았다']);
        assert.equal(await p.getAttribute('#center .story-wide .need-use', 'title'), 'needs/member-account.json\n역할 USER 로 가입한 계정');
        assert.deepEqual(await p.locator('#center .story-path .step-written .written-row.needs li').allTextContents(), ['needs/old-admin.json 없음', 'needs/broken.json 읽지 못함']);
        assert.equal(await p.getAttribute('#center .step-written .need-missing', 'title'), '공통 조건 폴더에 이 파일이 없습니다');
        assert.equal(await p.getAttribute('#center .step-written .need-unread', 'title'), '공통 조건 파일을 읽지 못했습니다: text 에 공통 조건 내용을 적어야 합니다');

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box.screen');
        await p.click('#flow-story-list li[data-story="lab-notes"]');
        await p.waitForFunction(() => state.storyPath?.id === 'lab-notes');
        assert.deepEqual(await p.locator('#flow-head .story-on .need-use').allTextContents(), ['공통 조건 일반 회원 계정']);
        assert.equal(await p.getAttribute('#flow-head .story-on .written-count', 'title'), '조건: 일반 회원 계정\n조건: 실험이 한 번 이상 돌았다');
        assert.equal(await p.getAttribute('#flow .story-line [data-step="1"] .written-count', 'title'), '조건: needs/old-admin.json 없음\n조건: needs/broken.json 읽지 못함');
        await p.click('#flow-head .story-on .need-use');
        assert.equal(await p.textContent('#center h3'), '일반 회원 계정');
        assert.equal(await p.locator('#left .views.side button.on').textContent(), '스토리 6');

        await p.click('#story-list li:has-text("실험 결과를 확인한다")');
        await p.click('#center .story-wide .need-use');
        assert.equal(await p.textContent('#center h3'), '일반 회원 계정');
      }),
    );
  });
});

test('in a browser, a condition on the link into a step that picks a need file shows as 공통 조건 with its name on the link row, and by its name under the line in the flow\'s one-line story', { skip: browserMissing }, async () => {
  const linking = {
    name: '회원으로 실험실에 들어간다',
    screens: ['/home#Home', { screen: '/lab#Lab', linkNeeds: [{ use: 'member-account.json' }, '실험실 메뉴를 누른 경우'] }, { screen: '/lab/result#LabResult', linkNeeds: [{ use: 'old-admin.json' }] }],
    memo: '',
    author: 'reviewer',
    date: '2026-10-05',
  };
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/lab-member.json'), JSON.stringify(linking));
    fs.mkdirSync(path.join(copy, 'example-stories/needs'));
    fs.writeFileSync(path.join(copy, 'example-stories/needs/member-account.json'), JSON.stringify({ name: '일반 회원 계정', text: '역할 USER 로 가입한 계정' }));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("회원으로 실험실에 들어간다")');
        assert.deepEqual(await p.locator('#center .story-path .link').evaluateAll((links) => links.map((l) => [...l.querySelectorAll('.link-written li')].map((li) => li.textContent))), [
          ['공통 조건 일반 회원 계정', '실험실 메뉴를 누른 경우'],
          ['needs/old-admin.json 없음'],
        ]);
        assert.equal(await p.getAttribute('#center .link-written .need-use', 'title'), 'needs/member-account.json\n역할 USER 로 가입한 계정');

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box.screen');
        await p.click('#flow-story-list li[data-story="lab-member"]');
        await p.waitForFunction(() => state.storyPath?.id === 'lab-member');
        assert.deepEqual(await p.locator('#flow .story-line .hop-need').allTextContents(), ['일반 회원 계정 · 실험실 메뉴를 누른 경우', 'needs/old-admin.json 없음']);
      }),
    );
  });
});
