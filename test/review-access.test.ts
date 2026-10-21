import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { addMark, loadMarks } from '../src/marks.ts';
import type { AnnouncedMark } from '../src/review.ts';
import { startReviewServer } from '../src/review.ts';
import { CLI, withRebuiltFixture, withServer, postMark, CASE_KINDS, signer, asked, why, SAVE_REFUSED, rewrite, rebuild, browserMissing, withPage, openScreenInfo, openLinkGroups, LONG_GUARD, IN_SCREEN_GUARD, labLink, withLabLinks, screenBox, pickedBoxes, tipLines, needTag } from './review-helpers.ts';

const BOUNDARY_ON_SIGNIN: [string, string, string] = ['results/playwright/e2e.json', '"screen:/signin#SignIn",\n            "screen:/help#Help"', '"screen:/signin#SignIn",\n            "screen:/help#Help",\n            "case:boundary"'];
type CaseData = { caseKinds: Record<string, { text: string; values: string[] }>; map: { screens: { id: string; cases: { tag: string; kind: string }[] }[]; calls: { id: string; cases: { tag: string; kind: string }[] }[] } };
const casesIn = (data: CaseData) => [...data.map.screens, ...data.map.calls].filter((n) => n.cases.length).map((n) => [n.id, n.cases.map((c) => c.tag)]);

test('the data carries the configured case kinds, and the kinds picked for a screen or call in config order after its role or setting cases, as the latest pick of each says', async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data = async (): Promise<CaseData> => (await fetch(`${base}/api/data`)).json();
      const before = casesIn(await data());
      assert.deepEqual((await data()).caseKinds, { boundary: { text: CASE_KINDS.boundary, values: [], picks: [] }, legacy: { text: CASE_KINDS.legacy, values: [], picks: [] } });
      for (const [node, kind] of [['/admin/member#AdminMember', 'legacy'], ['/admin/member#AdminMember', 'boundary'], ['GET:/api/v1/document/list', 'legacy'], ['/signin#SignIn', 'legacy']]) {
        assert.equal((await postMark(base, { target: { node, case: kind }, status: 'needed' })).status, 201);
      }
      assert.equal((await postMark(base, { target: { node: '/signin#SignIn', case: 'legacy' }, status: 'not-needed' })).status, 201);
      assert.equal((await postMark(base, { target: { node: '/signin#SignIn', case: 'legacy' }, status: 'missing' })).status, 400);
      assert.equal((await postMark(base, { target: { node: '/signin#SignIn' }, status: 'needed' })).status, 400);
      const after = Object.fromEntries(casesIn(await data()));
      assert.deepEqual(after['/admin/member#AdminMember'], ['role:ADMIN', 'role:other', 'case:boundary', 'case:legacy']);
      assert.deepEqual(after['GET:/api/v1/document/list'], ['case:legacy']);
      assert.equal(after['/signin#SignIn'], undefined);
      assert.deepEqual(Object.keys(after).sort(), [...before.map(([id]) => id), 'GET:/api/v1/document/list'].sort());
    }),
  );
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data: CaseData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.caseKinds, {});
      assert.ok(data.map.calls.every((c) => c.cases.length === 0));
    }),
  );
});

const RULED = {
  boundary: CASE_KINDS.boundary,
  ended: { text: '끝난 문서: 끝난 뒤의 쓰기 요청은 거부된다', values: ['cancelled', 'rejected'], picks: [{ screen: '/document/**', methods: ['POST', 'PUT'] }] },
  legacy: { text: CASE_KINDS.legacy, picks: [{ screen: '/admin/*' }] },
};
const RULE_ENDED = { index: 0, pick: RULED.ended.picks[0] };
type TargetData = { caseTargets: Record<string, { nodes: Record<string, { state: string; rules: number[]; mark: { author: string; note: string; rule?: object } | null }>; unused: Record<string, object> }> };

test('the data carries the kinds a rule picks for a screen or call as its cases with the rule that picked each, and a later mark wins over the rule', async () => {
  await withRebuiltFixture({ caseKinds: RULED }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data = async (): Promise<CaseData & TargetData> => (await fetch(`${base}/api/data`)).json();
      const before = await data();
      const cases = (d: CaseData): Record<string, string[]> => Object.fromEntries(casesIn(d));
      const ruled = Object.entries(cases(before)).filter(([, tags]) => tags.some((t) => t.startsWith('case:'))).map(([id, tags]) => [id, tags.filter((t) => t.startsWith('case:'))]);
      assert.deepEqual(ruled, [
        ['/admin/member#AdminMember', ['case:legacy']],
        ['/admin/group#AdminGroup', ['case:legacy']],
        ['/admin/audit#AdminAudit', ['case:legacy']],
        ['/admin/report#AdminReport', ['case:legacy']],
        ['POST:/api/v1/archive/document', ['case:ended']],
        [RENAME, ['case:ended']],
      ]);
      assert.deepEqual(cases(before)['/admin/member#AdminMember'], ['role:ADMIN', 'role:other', 'case:legacy']);
      assert.deepEqual(before.caseTargets.ended.nodes[RENAME], { state: 'rule', rules: [0], mark: null });
      assert.deepEqual(before.caseTargets.legacy.nodes['/admin/group#AdminGroup'], { state: 'rule', rules: [0], mark: null });

      assert.equal((await postMark(base, { target: { node: RENAME, case: 'ended' }, status: 'not-needed', note: '이름은 끝난 문서에서도 막지 않는다' })).status, 201);
      assert.equal((await postMark(base, { target: { node: '/admin/group#AdminGroup', case: 'boundary' }, status: 'needed' })).status, 201);
      const out = await data();
      assert.deepEqual(cases(out)[RENAME], undefined);
      assert.deepEqual(cases(out)['/admin/group#AdminGroup'], ['role:ADMIN', 'role:other', 'case:boundary', 'case:legacy']);
      const { state, rules, mark } = out.caseTargets.ended.nodes[RENAME];
      assert.deepEqual([state, rules, mark?.author, mark?.note, mark?.rule], ['not-needed', [0], 'reviewer', '이름은 끝난 문서에서도 막지 않는다', RULE_ENDED]);

      assert.equal((await postMark(base, { target: { node: RENAME, case: 'ended' }, status: 'needed' })).status, 201);
      const back = await data();
      assert.deepEqual(cases(back)[RENAME], ['case:ended']);
      assert.deepEqual([back.caseTargets.ended.nodes[RENAME].state, back.caseTargets.ended.nodes[RENAME].mark?.author], ['needed', 'reviewer']);
    }),
  );
});

test('a not-needed pick without a reason is refused on a screen or call a rule picks and saved with one, naming the rule in the file and in the mark line; elsewhere it needs no reason as before', async () => {
  await withRebuiltFixture({ caseKinds: RULED }, async (config) => {
    const lines: AnnouncedMark[] = [];
    const server = await startReviewServer(config, { author: signer('reviewer'), onMark: (line) => lines.push(line) });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const refused = await postMark(base, { target: { node: RENAME, case: 'ended' }, status: 'not-needed' });
      assert.equal(refused.status, 400);
      assert.equal(await refused.text(), `a rule picks ${RENAME} for ended (caseKinds.ended.picks[0]), so taking it out needs a note saying why`);
      assert.equal((await postMark(base, { target: { node: '/admin/member#AdminMember', case: 'legacy' }, status: 'not-needed', note: ' ' })).status, 400);
      assert.equal((await postMark(base, { targets: [{ node: RENAME, case: 'ended' }], status: 'not-needed' })).status, 400);
      assert.equal(loadMarks(config.marksDir).length, 0);

      const saved = await postMark(base, { target: { node: RENAME, case: 'ended' }, status: 'not-needed', note: '이름은 막지 않는다' });
      assert.equal(saved.status, 201);
      assert.deepEqual((await saved.json()).rule, RULE_ENDED);
      for (const [node, kind] of [['GET:/api/v1/document/list', 'ended'], ['/signin#SignIn', 'boundary'], ['/signin#SignIn', 'gone']]) {
        assert.equal((await postMark(base, { target: { node, case: kind }, status: 'not-needed', rule: RULE_ENDED })).status, 201);
      }
      const byTarget = (a: string[], b: string[]) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`);
      const files = loadMarks(config.marksDir).map((m) => [m.target!.node, m.target!.case, m.note, m.rule ?? null]).sort(byTarget as never);
      assert.deepEqual(files, [
        ['/signin#SignIn', 'boundary', '', null],
        ['/signin#SignIn', 'gone', '', null],
        ['GET:/api/v1/document/list', 'ended', '', null],
        [RENAME, 'ended', '이름은 막지 않는다', RULE_ENDED],
      ]);
      assert.deepEqual(lines.map((l) => [l.target!.node, l.target!.case, l.note, l.rule ?? null]).sort(byTarget as never), files);
      assert.ok(lines.every((l) => l.duru === 'mark'));
    } finally {
      server.close();
    }
  });
});

test('in a browser, with case kinds in the config every screen and every call shows a button per kind, and pressing one makes it a case with its tests until pressed again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const section = p.locator('#center .screen-info > .cases');
        const kindButton = (text: string) => section.locator('.case-kinds button', { hasText: text });
        const counts = async (rows: Locator) => (await rows.locator('.step-tests').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
        const picks = () => loadMarks(config.marksDir).filter((m) => m.target?.case !== undefined).sort((a, b) => a.date.localeCompare(b.date)).map((m) => [m.target!.node, m.target!.case, m.status]);

        await p.click('#screen-list li:has-text("/signin")');
        await openScreenInfo(p);
        assert.equal(await section.locator('h2').textContent(), '경우별 테스트');
        assert.equal(await section.locator('li:not(.case-undecided-row)').count(), 0);
        assert.deepEqual(await section.locator('.case-kinds button').allTextContents(), [CASE_KINDS.boundary, CASE_KINDS.legacy]);
        assert.deepEqual(await section.locator('.case-kinds button').evaluateAll((els) => els.map((e) => [e.getAttribute('title'), e.getAttribute('aria-pressed')])), [['@case:boundary', 'false'], ['@case:legacy', 'false']]);

        await kindButton(CASE_KINDS.boundary).click();
        await p.waitForSelector('#center .screen-info > .cases li:not(.case-undecided-row)');
        assert.deepEqual(await section.locator('li .case').allTextContents(), [CASE_KINDS.boundary]);
        assert.equal(await section.locator('li:not(.case-undecided-row)').getAttribute('title'), '@case:boundary');
        assert.deepEqual(await counts(section.locator('li:not(.case-undecided-row)')), ['UI/E2E ✓1']);
        assert.deepEqual(await section.locator('.case-head .chip').allTextContents(), ['reviewer']);
        assert.equal(await kindButton(CASE_KINDS.boundary).getAttribute('aria-pressed'), 'true');
        await kindButton(CASE_KINDS.legacy).click();
        await p.waitForSelector('#center .screen-info > .cases li:not(.case-undecided-row):nth-child(2)');
        assert.deepEqual(await counts(section.locator('li:not(.case-undecided-row)')), ['UI/E2E ✓1', '테스트 없음']);

        await kindButton(CASE_KINDS.boundary).click();
        await p.waitForFunction(() => document.querySelectorAll('#center .screen-info > .cases li:not(.case-undecided-row)').length === 1);
        assert.deepEqual(await section.locator('li .case').allTextContents(), [CASE_KINDS.legacy]);

        await p.click('#screen-list li:has-text("/admin/member")');
        await kindButton(CASE_KINDS.legacy).click();
        await p.waitForFunction(() => document.querySelectorAll('#center .screen-info > .cases li:not(.case-undecided-row)').length === 3);
        assert.deepEqual(await section.locator('li .case').allTextContents(), ['역할 ADMIN — 열림', '여는 역할이 아닌 역할 — 막힘', CASE_KINDS.legacy]);

        await p.click('#screen-list li:has-text("/home")');
        await p.locator('table.calls td.cell').first().click();
        const callSection = p.locator('#center .call-info > .cases');
        assert.deepEqual(await callSection.locator('li:not(.case-undecided-row)').count(), 0);
        await callSection.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).click();
        await p.waitForSelector('#center .call-info > .cases li:not(.case-undecided-row)');
        assert.deepEqual(await callSection.locator('li .case').allTextContents(), [CASE_KINDS.boundary]);
        assert.deepEqual(await counts(callSection.locator('li:not(.case-undecided-row)')), ['테스트 없음']);
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /^호출 전체$/);

        assert.deepEqual(picks(), [
          ['/signin#SignIn', 'boundary', 'needed'],
          ['/signin#SignIn', 'legacy', 'needed'],
          ['/signin#SignIn', 'boundary', 'not-needed'],
          ['/admin/member#AdminMember', 'legacy', 'needed'],
          ['GET:/api/v1/document/list', 'boundary', 'needed'],
        ]);
      }),
    ), [BOUNDARY_ON_SIGNIN]);
});

const ENDED = { text: '끝난 문서: 끝난 뒤의 쓰기 요청은 거부된다', values: ['cancelled', 'rejected'] };
const RENAME = 'PUT:/api/v1/document/{documentId}/name';
const ENDED_TESTS: [string, string, string][] = [
  ['results/playwright/e2e.json', '"screen:/signin#SignIn",\n            "screen:/help#Help"', '"screen:/signin#SignIn",\n            "screen:/help#Help",\n            "case:ended=cancelled",\n            "case:ended"'],
  ['results/playwright/e2e.json', `"call:${RENAME}"\n`, `"call:${RENAME}",\n            "case:ended=rejected"\n`],
];

test('in a browser, a picked kind that lists values shows a row per value under it, with the tests of that value by depth and result or 「테스트 없음」, in screen info and in call details', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: { boundary: CASE_KINDS.boundary, ended: ENDED } }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      for (const node of ['/signin#SignIn', RENAME]) assert.equal((await postMark(base, { target: { node, case: 'ended' }, status: 'needed' })).status, 201);
      await withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const rows = async (section: Locator) => ({
          kinds: await section.locator('li .case').allTextContents(),
          values: await section.locator('.case-values > li').evaluateAll((els) => els.map((e) => [e.getAttribute('title'), e.querySelector('.case-value')!.textContent, (e.querySelector('.step-tests') as HTMLElement).innerText.replace(/\s+/g, ' ').trim()])),
        });

        await p.click('#screen-list li:has-text("/signin")');
        await openScreenInfo(p);
        const section = p.locator('#center .screen-info > .cases');
        await section.locator('.case-values').waitFor();
        assert.deepEqual(await rows(section), {
          kinds: [ENDED.text],
          values: [['@case:ended=cancelled', 'cancelled', 'UI/E2E ✓1'], ['@case:ended=rejected', 'rejected', '테스트 없음']],
        });
        assert.deepEqual(await section.locator('.case-kinds button').evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute('title'), e.getAttribute('aria-pressed')])), [
          [CASE_KINDS.boundary, '@case:boundary', 'false'],
          [ENDED.text, '@case:ended=cancelled\n@case:ended=rejected', 'true'],
        ]);

        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls tbody tr:not(.option)', { hasText: RENAME }).locator('td.cell').first().click();
        const callSection = p.locator('#center .call-info > .cases');
        await callSection.locator('.case-values').waitFor();
        assert.deepEqual(await rows(callSection), {
          kinds: [ENDED.text],
          values: [['@case:ended=cancelled', 'cancelled', '테스트 없음'], ['@case:ended=rejected', 'rejected', 'UI/E2E ✕1']],
        });
      });
    }), ENDED_TESTS);
});

test('in a browser, a screen whose links ask for different kinds has its own filter and says so in its access panel, on links from it and in its flow box', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    rewrite(copy, 'client/src/components/Home.js', "      {session['member.role']", "      {memberRole === 'ADMIN' && <Link to={Option.ROUTE_PATH.HELP}>Help</Link>}\n      {session['member.role']");
    fs.writeFileSync(path.join(copy, 'client/src/components/Help.js'), "import { Link } from 'react-router-dom';\nimport Option from '_define/Option';\n\nexport default function Help() {\n  return <article><Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link></article>;\n}\n");
    rebuild(copy);
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.check('#left input[name=mixed]');
        assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/help', '/lab/result']);
        await p.uncheck('#left input[name=mixed]');
        const access = p.locator('#center .access');
        await p.click('#screen-list li:has-text("/help")');
        await openScreenInfo(p);
        assert.deepEqual(await p.locator('#center .open-needs .need').allTextContents(), ['링크마다 다름']);
        await p.click('#screen-list li:has-text("/lab/result")');
        await openLinkGroups(access);
        assert.deepEqual(await access.locator('li:has-text("/help#Help") .from-kinds .chip').allTextContents(), ['링크마다 다름']);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        const help = await screenBox(p, '/help#Help');
        assert.deepEqual(await needTag(help), ['링크마다 다름']);
        assert.equal((await tipLines(help)).at(-1), '링크마다 다름');
      }),
    );
  });
});

const groupSummaries = (groups: Locator) => groups.locator(':scope > summary').allInnerTexts();

test('in a browser, the incoming links with the same conditions form one group with their number, and opening it shows where each link is and its conditions as written', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    const groups = await open();
    assert.equal(await p.textContent('#center .access h2'), '들어오는 링크 7');
    assert.deepEqual(await groupSummaries(groups), [
      '조건 없음 링크 2',
      '역할 ADMIN · 설정 SYSTEM.LAB_ENABLED 켬 링크 3',
      '설정 SYSTEM.LAB_ENABLED 켬 링크 1',
      '설정 "LAB_EXPERIMENTS" (LAB.LIST 에) 링크 1',
    ]);
    const both = groups.nth(1);
    assert.equal(await both.locator('li').first().isVisible(), false);
    await both.locator(':scope > summary').click();
    const links = await both.locator('li').allInnerTexts();
    assert.equal(links.length, 3);
    assert.match(links[0], /\/admin\/group#AdminGroup\s+components\/AdminGroup\.js:9/);
    for (const text of links) {
      assert.match(text, /globalSettings\.SYSTEM\.LAB_ENABLED\s*설정/);
      assert.match(text, /memberRole === 'ADMIN'\s*역할/);
    }
    await groups.nth(0).locator(':scope > summary').click();
    assert.match(await groups.nth(0).locator('li').first().innerText(), /\/help#Help\s+components\/Help\.js:5/);
  });
});

test('in a browser, a route condition that is neither a setting nor a role is listed apart as not blocking the screen and is left out of the summary', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    await open();
    assert.deepEqual(await p.locator('#center .open-needs .need').allTextContents(), ['설정 SYSTEM.LAB_ENABLED 켬']);
    assert.doesNotMatch(await p.locator('#center .open-needs').innerText(), /location\.pathname/);
    const inScreen = p.locator('#center .in-screen');
    assert.match(await inScreen.locator('h2').innerText(), /^화면 안 조건.*막지 않/);
    assert.deepEqual(await inScreen.locator('code').allTextContents(), [IN_SCREEN_GUARD]);
  });
});

test('in a browser, the groups of incoming links and the links in each come in the same order however the map lists them', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open, reverse) => {
    const order = async (groups: Locator) => {
      const out = [];
      for (let i = 0; i < await groups.count(); i++) {
        await groups.nth(i).locator(':scope > summary').click();
        out.push([(await groupSummaries(groups))[i], await groups.nth(i).locator('li code.from').allTextContents()]);
      }
      return out;
    };
    const first = await order(await open());
    reverse();
    const second = await order(await open());
    assert.deepEqual(second, first);
    assert.deepEqual(first[1][1], ['/admin/group#AdminGroup', '/admin/member#AdminMember', '/document/:id#DocumentDetail']);
  });
});

test('in a browser, a long condition is folded and reads in full once opened', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    const groups = await open();
    const long = groups.nth(3);
    await long.locator(':scope > summary').click();
    const full = long.locator('.long-guard code.full');
    assert.equal(await full.isVisible(), false);
    await long.locator('.long-guard > summary').click();
    assert.equal(await full.isVisible(), true);
    assert.equal(await full.innerText(), LONG_GUARD);
    const box = (await full.boundingBox())!;
    const pane = (await p.locator('#center .screen-info').boundingBox())!;
    assert.ok(box.x + box.width <= pane.x + pane.width, 'the full condition wraps inside the pane');
  });
});

test('in a browser, links whose conditions read the same but resolve to different roles form separate groups, each summarised by its own roles', { skip: browserMissing }, async () => {
  const canManage = (roles: string[]) => ({ guard: 'canManage', kinds: ['role'], roles });
  await withLabLinks(async (p, open) => {
    const groups = await open();
    assert.deepEqual(await groupSummaries(groups), ['역할 ADMIN 외 1 링크 1', '역할 ADMIN 링크 1']);
    for (const g of await groups.all()) assert.equal(await g.locator('li').count(), 1);
  }, { only: [
    labLink('/home#Home', 'components/Home.js', 19, [canManage(['ADMIN', 'OWNER'])]),
    labLink('/help#Help', 'components/Help.js', 5, [canManage(['ADMIN'])]),
  ] });
});

test('in a browser, opened link groups and opened long conditions stay open when the screen info is redrawn, and close again on another screen', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    const groups = await open();
    await groups.nth(0).locator(':scope > summary').click();
    await groups.nth(3).locator(':scope > summary').click();
    await groups.nth(3).locator('.long-guard > summary').click();
    const openState = () => p.locator('#center .access').evaluate((a) => ({
      groups: [...a.querySelectorAll<HTMLDetailsElement>('details.link-group')].map((g) => g.open),
      long: [...a.querySelectorAll<HTMLDetailsElement>('details.long-guard')].map((g) => g.open),
    }));
    const expected = { groups: [true, false, false, true], long: [true] };
    assert.deepEqual(await openState(), expected);
    await p.click('#right .statuses button:has-text("테스트 필요")');
    assert.deepEqual(await openState(), expected);
    await p.fill('#right-dock textarea', 'redraw');
    await p.click('#right button.save');
    await p.waitForSelector('#center tr.selected td.mark:has-text("테스트 필요")');
    assert.deepEqual(await openState(), expected);
    await p.click('#screen-list li:has-text("/home")');
    await p.click('#screen-list li:has-text("/lab")');
    assert.deepEqual(await openState(), { groups: [false, false, false, false], long: [false] });
  });
});

test('in a browser, the headings of the incoming links and of the in-screen conditions keep the top margin of the other screen info headings', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    await open();
    const marginOf = (text: string) => p.locator('#center .screen-info h2', { hasText: text }).first().evaluate((e) => getComputedStyle(e).marginTop);
    const source = await marginOf('소스 위치');
    assert.notEqual(source, '0px');
    assert.equal(await marginOf('들어오는 링크'), source);
    assert.equal(await marginOf('화면 안 조건'), source);
  });
});

test('in a browser, a second press on a case kind button while the first is saving writes nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/signin")');
        await openScreenInfo(p);
        await p.locator('#center .screen-info > .cases .case-kinds button[title="@case:boundary"]').evaluate((b: HTMLButtonElement) => {
          b.click();
          b.click();
        });
        await p.waitForSelector('#center .screen-info > .cases li:not(.case-undecided-row)');
        await p.waitForSelector('#center .screen-info > .cases .case-kinds button:not([disabled])');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]), [[{ node: '/signin#SignIn', case: 'boundary' }, 'needed']]);
      }, { view: 'list' }),
    ),
  );
});

test('in a browser, a case kind pick that fails to save or to reload shows its error next to the case kind buttons, not in the comment form, until another target or tab is chosen', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#screen-list li:has-text("/signin")');
        await openScreenInfo(p);
        await p.evaluate(() => {
          const real = window.fetch;
          (window as unknown as { realFetch: typeof fetch }).realFetch = real;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        const section = p.locator('#center .screen-info > .cases');
        await section.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).click();
        await section.locator('.error').waitFor();
        assert.equal(await section.locator('.error').textContent(), `「/signin#SignIn · 경우 ${CASE_KINDS.boundary}」 코멘트를 저장하지 못했습니다: disk full`);
        assert.equal(await p.locator('#right .error').count(), 0);
        assert.equal(await section.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).isEnabled(), true);
        await p.click('#view-story');
        await p.click('#view-list');
        assert.equal(await p.locator('#center .cases .error').count(), 0, 'a tab switch clears the error');

        await p.evaluate(() => {
          const real = (window as unknown as { realFetch: typeof fetch }).realFetch;
          window.fetch = (url, init) => (String(url).includes('/api/data') ? Promise.reject(new Error('gone')) : real(url, init));
        });
        await section.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).click();
        await section.locator('.error').waitFor();
        assert.equal(await section.locator('.error').textContent(), `「/signin#SignIn · 경우 ${CASE_KINDS.boundary}」 코멘트는 저장했지만 다시 읽지 못했습니다: gone`);
        assert.equal(await p.locator('#right .error').count(), 0);
        await p.click('#screen-list li:has-text("/home")');
        assert.equal(await p.locator('#center .cases .error').count(), 0);
      }, { view: 'list' }),
    ),
  );
});

test('in a browser, a screen picked in the flow shows the same case kind buttons in the screen info, and a kind pressed there becomes its case while the screen stays picked', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        await (await screenBox(p, '/signin#SignIn')).click();
        await openScreenInfo(p);
        const section = p.locator('#center .screen-info > .cases');
        assert.deepEqual(await section.locator('.case-kinds button').allTextContents(), [CASE_KINDS.boundary, CASE_KINDS.legacy]);
        await section.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).click();
        await p.waitForSelector('#center .screen-info > .cases li:not(.case-undecided-row)');
        assert.deepEqual(await section.locator('li .case').allTextContents(), [CASE_KINDS.boundary]);
        assert.equal((await section.locator('li .step-tests').innerText()).replace(/\s+/g, ' ').trim(), 'UI/E2E ✓1');
        assert.deepEqual(await pickedBoxes(p), ['/signin#SignIn']);
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]), [[{ node: '/signin#SignIn', case: 'boundary' }, 'needed']]);
      }, { view: 'flow' }),
    ), [BOUNDARY_ON_SIGNIN]);
});

test('in a browser, a link from a screen that needs both a setting and a role shows both marks', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    fs.writeFileSync(path.join(copy, 'client/src/components/AdminReport.js'), `import { Link } from 'react-router-dom';
import Option from '_define/Option';
import ExportDialog from './ExportDialog';

export default function AdminReport() {
  return (
    <section>
      Reports
      <ExportDialog />
      <Link to={Option.ROUTE_PATH.HELP}>Help</Link>
    </section>
  );
}
`);
    execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await openScreenInfo(p);
        await openLinkGroups(p.locator('#center .access'));
        const link = p.locator('#center .access li:has-text("/admin/report#AdminReport")');
        assert.match(await link.innerText(), /링크를 건 화면에 필요한 것/);
        assert.deepEqual(await link.locator('.from-kinds .chip').allTextContents(), ['역할', '설정']);
      }),
    );
  });
});

const ARCHIVE = 'POST:/api/v1/archive/document';
const RULE_TEXT = '화면 경로 /document/** · 메서드 POST · PUT (설정 caseKinds.ended.picks 1번째 줄)';
const callCases = (p: Page) => p.locator('#center .call-info > .cases');
async function openCall(p: Page, screen: string, call: string) {
  await p.click(`#screen-list li:has-text("${screen}")`);
  await p.locator('table.calls tbody tr:not(.option)', { hasText: call }).locator('td.cell').first().click();
  await callCases(p).waitFor();
}
const chips = (section: Locator) => section.locator('.case-head .chip').evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute('title')]));
const kindButtons = (section: Locator) => section.locator('.case-kinds button').evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute('aria-pressed')]));
const DATE_TITLE = (tail: string) => new RegExp(`^\\d{2}\\. \\d{1,2}\\. \\d{1,2}\\. (오전|오후) \\d{1,2}:\\d{2} ${tail}`);

test('in a browser, 「경우별 테스트」 shows 「규칙」 for a kind a rule picked, the author for one a person picked, and 「대상 아님 · <author>」 with its reason under it for one taken out, with the rule or the date on hover, in screen info and call details', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: RULED }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      for (const node of [RENAME, '/admin/member#AdminMember']) assert.equal((await postMark(base, { target: { node, case: 'boundary' }, status: 'needed' })).status, 201);
      assert.equal((await postMark(base, { target: { node: ARCHIVE, case: 'ended' }, status: 'not-needed', note: '보관은 끝난 문서에서도 된다' })).status, 201);
      await withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await openCall(p, '/document/:id', RENAME);
        const call = callCases(p);
        assert.deepEqual(await call.locator('li .case').allTextContents(), [CASE_KINDS.boundary, RULED.ended.text]);
        const [person, rule] = await chips(call);
        assert.equal(person[0], 'reviewer');
        assert.match(person[1]!, DATE_TITLE('에 골랐습니다$'));
        assert.deepEqual(rule, ['규칙', `규칙이 골랐습니다: ${RULE_TEXT}`]);
        assert.deepEqual(await call.locator('.take-out').allTextContents(), ['이 요청은 규칙에서 빼기…']);
        assert.equal(await call.locator('.case-kinds button', { hasText: RULED.ended.text }).getAttribute('title'), '@case:ended=cancelled\n@case:ended=rejected\n누르면 이유를 적고 규칙에서 뺍니다');
        assert.deepEqual(await kindButtons(call), [[CASE_KINDS.boundary, 'true'], [RULED.ended.text, 'true'], [RULED.legacy.text, 'false']]);

        await openCall(p, '/home', ARCHIVE);
        assert.deepEqual(await call.locator('li .case').allTextContents(), [RULED.ended.text]);
        const out = call.locator('li.case-left-out');
        const [[text, title]] = await chips(call);
        assert.equal(text, '대상 아님 · reviewer');
        assert.match(title!, DATE_TITLE(`에 규칙에서 뺐습니다\n${RULE_TEXT.replace(/[()*/.]/g, '\\$&')}$`));
        assert.equal(await out.locator('.case-reason').textContent(), '이유 보관은 끝난 문서에서도 된다');
        assert.equal(await out.locator('.case-unused').count(), 0);
        assert.equal(await call.locator('.take-out').count(), 0);
        assert.deepEqual(await kindButtons(call), [[CASE_KINDS.boundary, 'false'], [RULED.ended.text, 'false'], [RULED.legacy.text, 'false']]);

        await p.click('#screen-list li:has-text("/admin/member")');
        await openScreenInfo(p);
        const screen = p.locator('#center .screen-info > .cases');
        assert.deepEqual(await screen.locator('li .case').allTextContents(), ['역할 ADMIN — 열림', '여는 역할이 아닌 역할 — 막힘', CASE_KINDS.boundary, RULED.legacy.text]);
        assert.deepEqual((await chips(screen)).map(([t]) => t), ['reviewer', '규칙']);
        assert.equal((await chips(screen))[1][1], '규칙이 골랐습니다: 화면 경로 /admin/* (설정 caseKinds.legacy.picks 1번째 줄)');
        assert.deepEqual(await screen.locator('.take-out').allTextContents(), ['이 화면은 규칙에서 빼기…']);
      });
    }));
});

test('in a browser, 「이 요청은 규칙에서 빼기…」 and the pressed kind button of a kind a rule picked open the same dialog, which saves nothing without a reason and keeps the reason when saving fails; once saved the row is 「대상 아님 · <author>」 and pressing the kind again puts it back as that person\'s pick, whose row can still be taken out of the rule', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: RULED }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const picks = () => loadMarks(config.marksDir).sort((a, b) => a.date.localeCompare(b.date)).map((m) => [m.target!.node, m.target!.case, m.status, m.note, m.rule ?? null]);
        await p.waitForSelector('#screen-list li');
        await openCall(p, '/document/:id', RENAME);
        const call = callCases(p);
        const endedButton = call.locator('.case-kinds button', { hasText: RULED.ended.text });

        await call.locator('.take-out').click();
        await p.locator(asked).waitFor();
        assert.equal(await p.textContent(`${asked} h2`), '이 요청을 규칙에서 뺍니다');
        assert.equal(await p.textContent(`${asked} .subject`), `경우 종류${RULED.ended.text} case:ended요청${RENAME}규칙${RULE_TEXT}`);
        assert.equal(await p.textContent(`${asked} button.discard`), '빼기');
        assert.equal(await p.isDisabled(`${asked} button.discard`), true);
        await p.fill(why, '   ');
        assert.equal(await p.isDisabled(`${asked} button.discard`), true);
        await p.click(`${asked} button.cancel`);
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(await p.evaluate(() => document.activeElement!.matches('#center .call-info .take-out')), true);
        assert.deepEqual(picks(), []);

        await endedButton.click();
        await p.locator(asked).waitFor();
        assert.equal(await p.textContent(`${asked} h2`), '이 요청을 규칙에서 뺍니다');
        assert.equal(await p.inputValue(why), '');
        await p.fill(why, '이름은 끝난 문서에서도 막지 않는다');
        await p.route('**/api/marks', (route) => route.fulfill({ status: 500, body: 'disk full' }));
        await p.click(`${asked} button.discard`);
        await p.locator(`${asked} .error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.equal(await p.textContent(`${asked} .error`), '저장하지 못했습니다: disk full');
        assert.equal(await p.inputValue(why), '이름은 끝난 문서에서도 막지 않는다');
        await p.unroute('**/api/marks');
        await p.click(`${asked} button.discard`);
        await call.locator('li.case-left-out').waitFor();
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual((await chips(call)).map(([t]) => t), ['대상 아님 · reviewer']);
        assert.equal(await call.locator('li.case-left-out .case-reason').textContent(), '이유 이름은 끝난 문서에서도 막지 않는다');
        assert.equal(await endedButton.getAttribute('aria-pressed'), 'false');
        assert.deepEqual(picks(), [[RENAME, 'ended', 'not-needed', '이름은 끝난 문서에서도 막지 않는다', RULE_ENDED]]);

        await endedButton.click();
        await p.waitForFunction(() => document.querySelectorAll('#center .call-info > .cases li.case-left-out').length === 0);
        assert.equal(await p.locator(asked).isVisible(), false);
        const [[author, picked]] = await chips(call);
        assert.equal(author, 'reviewer');
        assert.match(picked!, DATE_TITLE(`에 골랐습니다\n규칙도 골랐습니다: ${RULE_TEXT.replace(/[()*/.]/g, '\\$&')}$`));
        assert.equal(await endedButton.getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await call.locator('.take-out').allTextContents(), ['이 요청은 규칙에서 빼기…']);
        assert.deepEqual(picks().at(-1), [RENAME, 'ended', 'needed', '', null]);

        for (const opener of [endedButton, call.locator('.take-out')]) {
          await opener.click();
          await p.locator(asked).waitFor();
          assert.equal(await p.textContent(`${asked} h2`), '이 요청을 규칙에서 뺍니다');
          await p.click(`${asked} button.cancel`);
        }

        await p.click('#screen-list li:has-text("/admin/member")');
        await openScreenInfo(p);
        await p.locator('#center .screen-info > .cases .take-out').click();
        assert.equal(await p.textContent(`${asked} h2`), '이 화면을 규칙에서 뺍니다');
        assert.match((await p.textContent(`${asked} .subject`))!, /^경우 종류.*case:legacy화면\/admin\/member AdminMember규칙화면 경로 \/admin\/\* \(설정 caseKinds\.legacy\.picks 1번째 줄\)$/);
        await p.click(`${asked} button.cancel`);
        assert.equal(picks().length, 2);
      })));
});

test('in a browser, cancelling the reason dialog puts the focus back on the button it came from in screen info, also while a call\'s details show the same kind', { skip: browserMissing }, async () => {
  const kinds = { ...RULED, ended: { ...RULED.ended, picks: [{ screen: '/document/**' }, ...RULED.ended.picks] } };
  await withRebuiltFixture({ caseKinds: kinds }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await openCall(p, '/document/:id', RENAME);
        await openScreenInfo(p);
        const screen = p.locator('#center .screen-info > .cases');
        assert.deepEqual(await callCases(p).locator('.take-out').allTextContents(), ['이 요청은 규칙에서 빼기…']);
        assert.deepEqual(await screen.locator('.take-out').allTextContents(), ['이 화면은 규칙에서 빼기…']);
        for (const from of ['.take-out[data-kind="ended"]', '.case-kinds button[data-kind="ended"]']) {
          await screen.locator(from).click();
          await p.locator(asked).waitFor();
          assert.equal(await p.textContent(`${asked} h2`), '이 화면을 규칙에서 뺍니다');
          await p.click(`${asked} button.cancel`);
          assert.equal(await p.evaluate((sel) => document.activeElement!.matches(sel), `#center .screen-info > .cases ${from}`), true, from);
        }
        assert.deepEqual(loadMarks(config.marksDir), []);
      })));
});

test('in a browser, a request taken out of a rule that no longer picks it is undecided again, its 「미판정」 line saying who took it out and the old reason, also when an agent took it out or its kind has no rules left, as a kind pressed off with no reason says who did, while a screen the kind no longer takes as a candidate keeps its 「대상 아님」 row as no longer used', { skip: browserMissing }, async () => {
  const kinds = { boundary: CASE_KINDS.boundary, ended: { ...RULED.ended, picks: [{ screen: '/document/**', methods: ['POST'] }] }, legacy: CASE_KINDS.legacy };
  await withRebuiltFixture({ caseKinds: kinds }, (config) => {
    const at = new Date('2026-10-04T01:00:00Z');
    addMark(config.marksDir, { target: { node: RENAME, case: 'ended' }, status: 'not-needed', note: '이름은 막지 않는다', rule: RULE_ENDED, author: 'agent', via: 'duru case' }, at);
    addMark(config.marksDir, { target: { node: RENAME, case: 'legacy' }, status: 'not-needed', note: '옛 문서도 같은 칸을 쓴다', rule: { index: 0, pick: { methods: ['PUT'] } }, author: 'reviewer' }, at);
    addMark(config.marksDir, { target: { node: RENAME, case: 'boundary' }, status: 'not-needed', author: 'reviewer' }, at);
    addMark(config.marksDir, { target: { node: '/document/:id#DocumentDetail', case: 'ended' }, status: 'not-needed', note: '상세 화면은 읽기만 한다', rule: { index: 0, pick: { screen: '/document/**' } }, author: 'reviewer' }, at);
    return withServer(config, 'reviewer', async (base) => {
      const { caseTargets }: { caseTargets: Record<string, { undecided: string[] }> } = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(['boundary', 'ended', 'legacy'].map((kind) => caseTargets[kind].undecided.includes(RENAME)), [true, true, true]);
      await withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await openCall(p, '/document/:id', RENAME);
        const call = callCases(p);
        assert.equal(await call.locator('li.case-left-out').count(), 0);
        const lines = call.locator('li.case-undecided-row');
        assert.deepEqual(await lines.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind'))), ['boundary', 'ended', 'legacy']);
        assert.match((await lines.nth(0).locator('.case-held').textContent())!, /^reviewer 가 .+ 에 이유 없이 뺐습니다$/);
        assert.match((await lines.nth(1).locator('.case-held').textContent())!, /^agent 가 .+ 에 규칙에서 뺐지만 규칙이 더는 고르지 않습니다$/);
        assert.equal(await lines.filter({ hasText: '아직 아무도 정하지 않았습니다' }).count(), 0);
        assert.match((await lines.nth(2).locator('.case-held').textContent())!, /^reviewer 가 .+ 에 규칙에서 뺐지만 규칙이 더는 고르지 않습니다$/);
        assert.deepEqual(await call.locator('.case-reason').allTextContents(), ['예전 이유 이름은 막지 않는다', '예전 이유 옛 문서도 같은 칸을 쓴다']);
        assert.deepEqual(await kindButtons(call), [[CASE_KINDS.boundary, 'false'], [RULED.ended.text, 'false'], [CASE_KINDS.legacy, 'false']]);

        await openScreenInfo(p);
        const screen = p.locator('#center .screen-info > .cases');
        const out = screen.locator('li.case-left-out.unused');
        await out.waitFor();
        assert.equal(await out.locator('.case').textContent(), RULED.ended.text);
        const [text, title] = await out.locator('.case-head .chip').evaluate((e) => [e.textContent, e.getAttribute('title')]);
        assert.equal(text, '대상 아님 · reviewer');
        assert.match(title!, /에 규칙에서 뺐습니다\n지금 규칙: 화면 경로 \/document\/\*\* · 메서드 POST \(설정 caseKinds\.ended\.picks 1번째 줄\)$/);
        assert.equal(await out.locator('.case-reason').textContent(), '이유 상세 화면은 읽기만 한다');
        assert.equal(await out.locator('.case-unused').textContent(), '규칙이 이 화면을 더는 고르지 않아, 이 표시는 쓰이지 않습니다');
        assert.equal(await screen.locator('li.case-undecided-row[data-kind="ended"]').count(), 0);
      });
    });
  });
});

test('in a browser, a 「대상 아님」 with a reason on a request no rule picks, written by duru case, shows as 「대상 아님 · <author>」 with its reason and the date on hover, while the data lists the kind\'s undecided requests without it, writes first', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: RULED }, (config, copy) => {
    const read = 'GET:/api/v1/document/{documentId}';
    execFileSync(process.execPath, [CLI, 'case', path.join(copy, 'config.json'), 'ended', read, 'not-needed', '--note', '읽기는 끝난 문서에서도 된다'], { stdio: 'pipe' });
    return withServer(config, 'reviewer', async (base) => {
      const { caseTargets }: { caseTargets: Record<string, { undecided: string[]; nodes: Record<string, { state: string; mark: { author: string; via?: string } | null }> }> } = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual([caseTargets.ended.nodes[read].state, caseTargets.ended.nodes[read].mark?.author, caseTargets.ended.nodes[read].mark?.via], ['not-needed', 'agent', 'duru case']);
      assert.ok(!caseTargets.ended.undecided.includes(read));
      const firstRead = caseTargets.ended.undecided.findIndex((id) => id.startsWith('GET:'));
      assert.ok(firstRead > 0 && caseTargets.ended.undecided.slice(firstRead).every((id) => id.startsWith('GET:')));
      await withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await openCall(p, '/document/:id', read);
        const call = callCases(p);
        const [[text, title]] = await chips(call);
        assert.equal(text, '대상 아님 · agent');
        assert.match(title!, DATE_TITLE('에 대상 아님으로 정했습니다$'));
        assert.equal(await call.locator('li.case-left-out .case-reason').textContent(), '이유 읽기는 끝난 문서에서도 된다');
        assert.equal(await call.locator('.take-out').count(), 0);
        assert.deepEqual(await kindButtons(call), [[CASE_KINDS.boundary, 'false'], [RULED.ended.text, 'false'], [RULED.legacy.text, 'false']]);
      });
    });
  });
});

test('in a browser, 「경우별 테스트」 has a line for each kind nobody decided on the screen or call, with ✓ saving 「대상」 at once and ✕ asking the reason as 「대상 아님…」, while the kind buttons stay as they were', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: RULED }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const exportCall = 'POST:/api/v1/report/export';
        const lines = (section: Locator) => section.locator('li.case-undecided-row').evaluateAll((els) => els.map((e) => [e.getAttribute('data-kind'), e.textContent]));
        const tips = (section: Locator) => section.locator('li.case-undecided-row >> nth=0').locator('button').evaluateAll((els) => els.map((e) => [e.getAttribute('title'), e.getAttribute('aria-label')]));
        await p.waitForSelector('#screen-list li');
        await openCall(p, '/admin/report', exportCall);
        const call = callCases(p);
        assert.deepEqual(await lines(call), [
          ['boundary', `${CASE_KINDS.boundary}미판정아직 아무도 정하지 않았습니다✓✕`],
          ['ended', `${RULED.ended.text}미판정아직 아무도 정하지 않았습니다✓✕`],
        ]);
        assert.deepEqual(await tips(call), [
          ['대상 — 이 요청에서 이 경우를 시험합니다', '대상 — 이 요청에서 이 경우를 시험합니다'],
          ['대상 아님… — 이유를 적고 이 요청에서는 시험하지 않습니다', '대상 아님… — 이유를 적고 이 요청에서는 시험하지 않습니다'],
        ]);
        assert.deepEqual(await kindButtons(call), [[CASE_KINDS.boundary, 'false'], [RULED.ended.text, 'false'], [RULED.legacy.text, 'false']]);

        await call.locator('li.case-undecided-row[data-kind="boundary"] button.yes').click();
        await p.waitForFunction(() => document.querySelectorAll('#center .call-info > .cases li.case-undecided-row').length === 1);
        assert.deepEqual(await call.locator('li .case').allTextContents(), [CASE_KINDS.boundary]);
        assert.deepEqual((await chips(call)).map(([t]) => t), ['reviewer']);

        const no = call.locator('li.case-undecided-row[data-kind="ended"] button.no');
        await no.click();
        await p.locator(asked).waitFor();
        assert.equal(await p.textContent(`${asked} h2`), '이 요청에서는 이 경우를 시험하지 않습니다');
        assert.equal(await p.textContent(`${asked} button.discard`), '대상 아님');
        await p.click(`${asked} button.cancel`);
        assert.equal(await p.evaluate(() => document.activeElement!.matches('#center .call-info > .cases li.case-undecided-row[data-kind="ended"] button.no')), true);
        await no.click();
        await p.fill(why, '보고서는 문서 상태를 보지 않는다');
        await p.click(`${asked} button.discard`);
        await call.locator('li.case-left-out').waitFor();
        assert.equal(await call.locator('li.case-undecided-row').count(), 0);
        assert.deepEqual((await chips(call)).map(([t]) => t), ['reviewer', '대상 아님 · reviewer']);
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target!.case, m.status, m.note]).sort(), [['boundary', 'needed', ''], ['ended', 'not-needed', '보고서는 문서 상태를 보지 않는다']]);

        await openScreenInfo(p);
        const screen = p.locator('#center .screen-info > .cases');
        assert.deepEqual((await lines(screen)).map(([kind]) => kind), ['boundary']);
        assert.deepEqual((await tips(screen)).map(([title]) => title), ['대상 — 이 화면에서 이 경우를 시험합니다', '대상 아님… — 이유를 적고 이 화면에서는 시험하지 않습니다']);
      })));
});
