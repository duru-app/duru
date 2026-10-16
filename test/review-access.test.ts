import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator } from 'playwright-core';
import { loadMarks } from '../src/marks.ts';
import { CLI, withRebuiltFixture, withServer, postMark, CASE_KINDS, rewrite, rebuild, browserMissing, withPage, openScreenInfo, openLinkGroups, LONG_GUARD, IN_SCREEN_GUARD, labLink, withLabLinks, screenBox, pickedBoxes, tipLines, needTag } from './review-helpers.ts';

const BOUNDARY_ON_SIGNIN: [string, string, string] = ['results/playwright/e2e.json', '"screen:/signin#SignIn",\n            "screen:/help#Help"', '"screen:/signin#SignIn",\n            "screen:/help#Help",\n            "case:boundary"'];
type CaseData = { caseKinds: Record<string, string>; map: { screens: { id: string; cases: { tag: string; kind: string }[] }[]; calls: { id: string; cases: { tag: string; kind: string }[] }[] } };
const casesIn = (data: CaseData) => [...data.map.screens, ...data.map.calls].filter((n) => n.cases.length).map((n) => [n.id, n.cases.map((c) => c.tag)]);

test('the data carries the configured case kinds, and the kinds picked for a screen or call in config order after its role or setting cases, as the latest pick of each says', async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data = async (): Promise<CaseData> => (await fetch(`${base}/api/data`)).json();
      const before = casesIn(await data());
      assert.deepEqual((await data()).caseKinds, CASE_KINDS);
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
        assert.equal(await section.locator('li').count(), 0);
        assert.deepEqual(await section.locator('.case-kinds button').allTextContents(), [CASE_KINDS.boundary, CASE_KINDS.legacy]);
        assert.deepEqual(await section.locator('.case-kinds button').evaluateAll((els) => els.map((e) => [e.getAttribute('title'), e.getAttribute('aria-pressed')])), [['@case:boundary', 'false'], ['@case:legacy', 'false']]);

        await kindButton(CASE_KINDS.boundary).click();
        await p.waitForSelector('#center .screen-info > .cases li');
        assert.deepEqual(await section.locator('li .case').allTextContents(), [CASE_KINDS.boundary]);
        assert.equal(await section.locator('li').getAttribute('title'), '@case:boundary');
        assert.deepEqual(await counts(section.locator('li')), ['UI/E2E ✓1']);
        assert.equal(await kindButton(CASE_KINDS.boundary).getAttribute('aria-pressed'), 'true');
        await kindButton(CASE_KINDS.legacy).click();
        await p.waitForSelector('#center .screen-info > .cases li:nth-child(2)');
        assert.deepEqual(await counts(section.locator('li')), ['UI/E2E ✓1', '테스트 없음']);

        await kindButton(CASE_KINDS.boundary).click();
        await p.waitForFunction(() => document.querySelectorAll('#center .screen-info > .cases li').length === 1);
        assert.deepEqual(await section.locator('li .case').allTextContents(), [CASE_KINDS.legacy]);

        await p.click('#screen-list li:has-text("/admin/member")');
        await kindButton(CASE_KINDS.legacy).click();
        await p.waitForFunction(() => document.querySelectorAll('#center .screen-info > .cases li').length === 3);
        assert.deepEqual(await section.locator('li .case').allTextContents(), ['역할 ADMIN — 열림', '여는 역할이 아닌 역할 — 막힘', CASE_KINDS.legacy]);

        await p.click('#screen-list li:has-text("/home")');
        await p.locator('table.calls td.cell').first().click();
        const callSection = p.locator('#center .call-info > .cases');
        assert.deepEqual(await callSection.locator('li').count(), 0);
        await callSection.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).click();
        await p.waitForSelector('#center .call-info > .cases li');
        assert.deepEqual(await callSection.locator('li .case').allTextContents(), [CASE_KINDS.boundary]);
        assert.deepEqual(await counts(callSection.locator('li')), ['테스트 없음']);
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
    await p.click('#right .statuses button:has-text("더 필요")');
    assert.deepEqual(await openState(), expected);
    await p.fill('#right-dock textarea', 'redraw');
    await p.click('#right button.save');
    await p.waitForSelector('#center tr.selected td.mark:has-text("더 필요")');
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
        await p.waitForSelector('#center .screen-info > .cases li');
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
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#left .views.side button:has-text("화면")');
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
        await p.waitForSelector('#center .screen-info > .cases li');
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
