import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Page, Route } from 'playwright-core';
import { loadMarks } from '../src/marks.ts';
import { withRebuiltFixture, withServer, rebuild, browserMissing, toList, withPage, openScreenInfo, LAB_SETTING, ADMIN_ROLE, LONG_SETTING, asked, why, askedFocused, SAVE_REFUSED, untilSet, postJson, postMark, CANDIDATES, HELP_RECORD, HELP_KEY, PUBLISH_KEY, storiesTab, BAD_REQUEST, discardCandidate, holdRequests, storyStack, rightPane } from './review-helpers.ts';
import type { Guard, PageData, Reach } from './review-helpers.ts';

const HOME = '/home#Home';
const LAB = '/lab#Lab';
const LAB_RESULT = '/lab/result#LabResult';
const OWNER_ROLE = { guard: "memberRole === 'OWNER'", kinds: ['role'], roles: ['OWNER'] };
const UNREAD_ROLE = { guard: 'canManage(member)', kinds: ['role'], roles: null };
const UNREAD_SETTING = { guard: 'settingOf(key)', kinds: ['setting'], settings: null, settingsReason: '설정 키를 읽지 못했습니다' };
const settingGuard = (guard: string, path: string[], need: string, value?: unknown, root = 'globalSettings') => ({ guard, kinds: ['setting'], settings: [{ root, path, need, ...(value === undefined ? {} : { value }) }] });
const LAB_OFF = settingGuard('!globalSettings.SYSTEM.LAB_ENABLED', ['SYSTEM', 'LAB_ENABLED'], 'off');
const reachRoute = (guards: object[], screen = LAB): Reach => ({ kind: 'route', screen, file: 'Routes.js', line: 44, guards });
const reachLink = (...ways: Guard[][]): Reach => ({ kind: 'link', from: HOME, to: LAB, ways: ways.map((conditions, i) => ({ file: 'components/Home.js', line: 19 + i, conditions })) });

async function withStoryReach(reach: Reach[], fn: (p: Page) => Promise<void>, { access = {} }: { access?: Record<string, object> } = {}) {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const data: PageData = await (await route.fetch()).json();
          const screen = (id: string) => data.map.screens.find((s) => s.id === id)!;
          data.stories.list.find((s) => s.id === 'run-lab')!.reach = reach;
          for (const r of reach.filter((x) => x.kind === 'link')) {
            assert.ok(r.ways.every((w) => w.conditions.every((g) => !g.via)), 'a link step with inherited conditions needs a rebuilt map');
            const to = screen(r.to);
            to.access.links = [...to.access.links.filter((l) => l.from !== r.from), ...r.ways.map((w) => ({ from: r.from, file: w.file, line: w.line, guards: w.conditions.filter((g) => g.kinds.length), fromKinds: [] }))];
          }
          for (const [id, patch] of Object.entries(access)) Object.assign(screen(id).access, patch);
          await route.fulfill({ json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await p.click('#view-story');
        await p.click('#story-list li:has-text("실험실을 열어")');
        await fn(p);
      }),
    ),
  );
}

async function withStoryMap(edits: [string, string, string][], story: string, fn: (p: Page) => Promise<void>) {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#view-story');
        await p.click(`#story-list li:has-text("${story}")`);
        await fn(p);
      }),
    ), edits);
}

const RUN_LAB = '실험실을 열어';
const READ_REPORTS = '관리자가 보고서를 본다';
const storyScreens = (screens: string[]): [string, string, string] => ['example-stories/read-reports.json', '["/admin/report#AdminReport"]', JSON.stringify(screens)];
const LAB_FILE = 'client/src/components/Lab.js';
const resultHandler = (buttons: (string | null)[], body = 'history.push(Option.ROUTE_PATH.LAB_RESULT)'): [string, string, string][] => [
  [LAB_FILE, "import { Link } from 'react-router-dom';", "import { useHistory } from 'react-router-dom';"],
  [LAB_FILE, 'export default function Lab() {', `export default function Lab({ memberRole, globalSettings, loaded }) {\n  const history = useHistory();\n  const openResult = () => ${body};`],
  [LAB_FILE, '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>', buttons.map((guard, i) => {
    const button = `<button type="button" onClick={openResult}>Results ${i}</button>`;
    return guard ? `{${guard} && ${button}}` : button;
  }).join('\n      ')],
];

const readSummary = (p: Page) => p.locator('#center .reach-summary').evaluate((el) => {
  const text = (e: Element) => [...e.childNodes].map((c) => c.textContent).join(' ');
  return {
    lines: [...el.querySelectorAll(':scope > .need, :scope > .step-roles > li, :scope > .none')].map(text),
    leftOut: [...el.querySelectorAll(':scope > .left-out li')].map(text),
  };
});

test('in a browser, a story that needs a setting and a role shows them as two summary lines under 사전 조건 in the wording of the screen summary, and the raw conditions only once the fold is opened', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LAB_SETTING]), reachRoute([LAB_SETTING, ADMIN_ROLE])], async (p) => {
    assert.deepEqual(await p.locator('#center .title-row .chip.verdict').allTextContents(), ['도달 가능']);
    assert.deepEqual(await p.locator('#center details.story-needs').evaluate((d: HTMLDetailsElement) => [d.querySelector('summary')!.textContent, d.open, d.querySelector('summary + *')!.className]), ['사전 조건 2', false, 'reach-summary']);
    await p.click('#center .story-needs > summary');
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
    assert.equal(await p.locator('#center details.reach-raw').evaluate((d: HTMLDetailsElement) => d.open), false);
    assert.equal(await p.locator('#center .reach-raw .reach').isVisible(), false);
    assert.equal(await p.locator('#center .reach-summary .reach').count(), 0);
    await p.click('#center .reach-raw > summary');
    assert.equal(await p.locator('#center .reach-raw .reach').isVisible(), true);
    assert.match((await p.textContent('#center .reach-link'))!, /components\/Home\.js:19.*globalSettings\.SYSTEM\.LAB_ENABLED/);
    assert.match((await p.textContent('#center .reach-route'))!, /Routes\.js:44.*memberRole === 'ADMIN'/);
    assert.equal(await p.locator('#right-info .mark-form').count(), 0);
    assert.equal(await p.locator('#right-dock > .mark-form').count(), 1);
  });
});

test('in a browser, a condition that sits on several steps of a story is in the summary once', { skip: browserMissing }, async () => {
  await withStoryMap([], RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#center .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트']);
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE]), reachRoute([LAB_SETTING, ADMIN_ROLE, UNREAD_ROLE]), reachRoute([UNREAD_ROLE, ADMIN_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
});

test('in a browser, a condition inherited from a handler counts in the story summary when the link has no condition of its own and the handler is used in one place under that one condition', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'"]), RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#center .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트', '/lab → /lab/result']);
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
});

test('in a browser, a link whose handler is also used without a role condition adds no role to the story summary, while the fold still shows the role condition as written', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'", 'loaded']), RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#center .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트', '/lab → /lab/result']);
    assert.match((await p.locator('#center .reach-link').nth(1).textContent())!, /memberRole === 'ADMIN'/);
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
});

test('in a browser, conditions inherited from a handler used in several places, or next to a condition of the link itself, are not counted as needed nor as contradicting, and are listed apart with the handler that carries them', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'", "memberRole === 'OWNER'"]), RUN_LAB, async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['역할 미확인 (/lab → /lab/result)', "openResult 를 쓰는 곳에 따라 다른 조건: memberRole === 'ADMIN', memberRole === 'OWNER'"],
    });
  });
  await withStoryMap(resultHandler(['globalSettings.SYSTEM.LAB_ENABLED', '!globalSettings.SYSTEM.LAB_ENABLED']), RUN_LAB, async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['openResult 를 쓰는 곳에 따라 다른 조건: globalSettings.SYSTEM.LAB_ENABLED, !globalSettings.SYSTEM.LAB_ENABLED'],
    });
  });
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'", null], 'globalSettings.SYSTEM.LAB_ENABLED && history.push(Option.ROUTE_PATH.LAB_RESULT)'), RUN_LAB, async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['역할 미확인 (/lab → /lab/result)', "openResult 를 쓰는 곳에 따라 다른 조건: memberRole === 'ADMIN'"],
    });
  });
});

test('in a browser, a story whose only conditions are inherited from a handler used in several places does not say that nothing blocks it', { skip: browserMissing }, async () => {
  const home = 'client/src/components/Home.js';
  const edits: [string, string, string][] = [
    [home, "import { Link } from 'react-router-dom';", "import { Link, useHistory } from 'react-router-dom';"],
    [home, "const isAdmin = memberRole === 'ADMIN';", "const isAdmin = memberRole === 'ADMIN';\n  const history = useHistory();\n  const openAudit = () => history.push(Option.ROUTE_PATH.ADMIN_AUDIT);"],
    [home, "{session['member.role'] === 'AUDITOR' && <Link to={Option.ROUTE_PATH.ADMIN_AUDIT}>Audit</Link>}",
      '{globalSettings.SYSTEM.MODE_ON && <button type="button" onClick={openAudit}>Audit</button>}\n      {!globalSettings.SYSTEM.MODE_ON && <button type="button" onClick={openAudit}>Log</button>}'],
    storyScreens(['/home#Home', '/admin/audit#AdminAudit']),
  ];
  await withStoryMap(edits, READ_REPORTS, async (p) => {
    assert.deepEqual(await p.locator('#center .reach > li h3').allTextContents(), ['/home → /admin/audit']);
    assert.deepEqual(await readSummary(p), { lines: [], leftOut: ['openAudit 를 쓰는 곳에 따라 다른 조건: globalSettings.SYSTEM.MODE_ON, !globalSettings.SYSTEM.MODE_ON'] });
  });
});

test('in a browser, the first screen of a story needs from its incoming links only what every one of them needs, and is different per link when they need different settings', { skip: browserMissing }, async () => {
  await withStoryMap([storyScreens(['/help#Help'])], READ_REPORTS, async (p) => {
    assert.deepEqual(await p.locator('#center .reach > li h3').allTextContents(), ['첫 화면 /help']);
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.HELP_LINK_ENABLED 켬'], leftOut: [] });
  });
  const signIn: [string, string, string] = ['client/src/components/SignIn.js', 'globalSettings.SYSTEM.HELP_LINK_ENABLED &&', 'globalSettings.SYSTEM.LAB_ENABLED &&'];
  await withStoryMap([signIn, storyScreens(['/help#Help'])], READ_REPORTS, async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['첫 화면 /help 링크마다 다름'], leftOut: [] });
  });
  const either: [string, string, string][] = [
    [LAB_FILE, 'export default function Lab() {', 'export default function Lab({ globalSettings }) {'],
    [LAB_FILE, '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>',
      '{globalSettings.SYSTEM.MODE_ON ? <Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link> : <Link to={Option.ROUTE_PATH.LAB_RESULT}>Back</Link>}'],
    storyScreens(['/lab/result#LabResult']),
  ];
  await withStoryMap(either, READ_REPORTS, async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['첫 화면 /lab/result 링크마다 다름'], leftOut: [] });
  });
});

test('in a browser, the first screen of a story whose incoming link carries a role condition inherited from a handler that is also used without it does not present the roles of the map as complete', { skip: browserMissing }, async () => {
  const edits = [...resultHandler(["memberRole === 'ADMIN'", null], 'globalSettings.SYSTEM.LAB_ENABLED && history.push(Option.ROUTE_PATH.LAB_RESULT)'), storyScreens(['/lab/result#LabResult'])];
  await withStoryMap(edits, READ_REPORTS, async (p) => {
    assert.deepEqual(await p.locator('#center .reach > li h3').allTextContents(), ['첫 화면 /lab/result']);
    assert.deepEqual(await readSummary(p), {
      lines: ['역할 ADMIN 미확인 1', '설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['역할 일부만 읽음 (첫 화면 /lab/result)', "openResult 를 쓰는 곳에 따라 다른 조건: memberRole === 'ADMIN'"],
    });
  });
});

test('in a browser, a story step that several links reach needs in the summary only what every link needs, and is different per link only when no link needs exactly that', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE], [LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  const isAdmin = { guard: 'isAdmin', kinds: ['role'], roles: ['ADMIN'] };
  await withStoryReach([reachLink([ADMIN_ROLE], [isAdmin])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN'], leftOut: [] });
  });
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE], [OWNER_ROLE, LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 또는 OWNER', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  await withStoryReach([reachLink([ADMIN_ROLE], [LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['/home → /lab 링크마다 다름'], leftOut: [] });
  });
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE], [LAB_SETTING, LONG_SETTING]), reachRoute([LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬', '/home → /lab 링크마다 다름'], leftOut: [] });
  });
});

test('in a browser, a story whose role was not read on one step does not present the role of the other steps as enough', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([UNREAD_ROLE]), reachRoute([ADMIN_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1'], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
  await withStoryReach([{ kind: 'start', screen: HOME, kinds: ['role'], roleValues: null }, reachRoute([ADMIN_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1'], leftOut: ['역할 미확인 (첫 화면 /home)'] });
  }, { access: { [HOME]: { restricted: true, kinds: ['role'], roleValues: null, unreadableRoleGuards: [] } } });
});

test('in a browser, a role condition that was not read on one of several links of a step neither hides what the other links prove nor shows as needed', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([ADMIN_ROLE, UNREAD_ROLE], [ADMIN_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN'], leftOut: [] });
  });
  await withStoryReach([reachLink([UNREAD_ROLE], [ADMIN_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1'], leftOut: ['역할 일부만 읽음 (/home → /lab)'] });
  });
  await withStoryReach([reachLink([ADMIN_ROLE, UNREAD_ROLE], [OWNER_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 또는 OWNER 미확인 1'], leftOut: ['역할 일부만 읽음 (/home → /lab)'] });
  });
  await withStoryReach([reachLink([UNREAD_ROLE], [ADMIN_ROLE]), reachRoute([OWNER_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 OWNER 미확인 1'], leftOut: ['역할 일부만 읽음 (/home → /lab)'] });
  });
});

test('in a browser, a story whose steps allow roles that do not overlap says that no role passes every step and lists the roles of each step', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([ADMIN_ROLE]), reachRoute([OWNER_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['모든 단계를 지나는 역할 없음', '/lab 라우트: 역할 ADMIN', '/lab/result 라우트: 역할 OWNER'], leftOut: [] });
  });
});

const MODE = ['SYSTEM', 'MODE'];
const modeIs = (value: unknown) => settingGuard(`globalSettings.SYSTEM.MODE === ${JSON.stringify(value)}`, MODE, 'equals', value);

test('in a browser, a story whose steps need the same setting both on and off, or with two different values, says those needs contradict each other instead of listing them as needed', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([LAB_SETTING, modeIs('A'), LONG_SETTING]), reachRoute([LAB_OFF, modeIs('B')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: [
      '설정 SYSTEM.MAIN_MENU.LAB.LIST 에 "LAB_EXPERIMENTS"',
      '서로 어긋나는 설정: SYSTEM.LAB_ENABLED 켬 / SYSTEM.LAB_ENABLED 끔',
      '서로 어긋나는 설정: SYSTEM.MODE = "A" / SYSTEM.MODE = "B"',
    ], leftOut: [] });
  });
});

test('in a browser, a setting needed off contradicts the same setting needed present, holding a value or equal to a true value, and only the needs that contradict leave the need lines', { skip: browserMissing }, async () => {
  const modeOff = settingGuard('!globalSettings.SYSTEM.MODE', MODE, 'off');
  const modeHas = settingGuard("globalSettings.SYSTEM.MODE includes 'A'", MODE, 'includes', 'A');
  const modePresent = settingGuard('globalSettings.SYSTEM.MODE', MODE, 'present');
  await withStoryReach([reachRoute([modeOff]), reachRoute([modeIs('A')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['서로 어긋나는 설정: SYSTEM.MODE 끔 / SYSTEM.MODE = "A"'], leftOut: [] });
  });
  await withStoryReach([reachRoute([modeOff]), reachRoute([modeHas, modePresent], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['서로 어긋나는 설정: SYSTEM.MODE 끔 / SYSTEM.MODE 에 "A" / SYSTEM.MODE 있음'], leftOut: [] });
  });
  const modeOn = settingGuard('globalSettings.SYSTEM.MODE', MODE, 'on');
  await withStoryReach([reachRoute([modeOn]), reachRoute([modeIs('A'), modeIs('B')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.MODE 켬', '서로 어긋나는 설정: SYSTEM.MODE = "A" / SYSTEM.MODE = "B"'], leftOut: [] });
  });
});

test('in a browser, setting needs that a loose comparison can satisfy together are not called a contradiction', { skip: browserMissing }, async () => {
  const modeOn = settingGuard('globalSettings.SYSTEM.MODE', MODE, 'on');
  await withStoryReach([reachRoute([modeOn]), reachRoute([modeIs(0)], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.MODE 켬', '설정 SYSTEM.MODE = 0'], leftOut: [] });
  });
  await withStoryReach([reachRoute([modeIs(1)]), reachRoute([modeIs('1')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.MODE = 1', '설정 SYSTEM.MODE = "1"'], leftOut: [] });
  });
});

test('in a browser, a story whose settings come from two settings roots names the root of each setting and keeps the same path of two roots apart', { skip: browserMissing }, async () => {
  const appLab = (need: string) => settingGuard(`${need === 'off' ? '!' : ''}appSettings.SYSTEM.LAB_ENABLED`, ['SYSTEM', 'LAB_ENABLED'], need, undefined, 'appSettings');
  await withStoryReach([reachRoute([appLab('on')]), reachRoute([LAB_SETTING], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 appSettings.SYSTEM.LAB_ENABLED 켬', '설정 globalSettings.SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  await withStoryReach([reachRoute([appLab('on')]), reachRoute([LAB_OFF], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 appSettings.SYSTEM.LAB_ENABLED 켬', '설정 globalSettings.SYSTEM.LAB_ENABLED 끔'], leftOut: [] });
  });
  await withStoryReach([reachRoute([appLab('on')]), reachRoute([appLab('off')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['서로 어긋나는 설정: SYSTEM.LAB_ENABLED 켬 / SYSTEM.LAB_ENABLED 끔'], leftOut: [] });
  });
});

test('in a browser, a story whose conditions are neither a setting nor a role says that no setting or role blocks it', { skip: browserMissing }, async () => {
  const loaded = { guard: 'loaded', kinds: [] };
  await withStoryReach([reachLink([loaded])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정이나 역할로 막는 조건 없음'], leftOut: [] });
  });
});

test('in a browser, the story summary names every role and every setting in full', { skip: browserMissing }, async () => {
  const adminOrOwner = { guard: "['ADMIN', 'OWNER'].includes(memberRole)", kinds: ['role'], roles: ['ADMIN', 'OWNER'] };
  await withStoryReach([reachRoute([LAB_SETTING, LONG_SETTING, adminOrOwner])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 또는 OWNER', '설정 SYSTEM.LAB_ENABLED 켬', '설정 SYSTEM.MAIN_MENU.LAB.LIST 에 "LAB_EXPERIMENTS"'], leftOut: [] });
  });
});

test('in a browser, story conditions that the summary cannot state are listed apart from it under their own heading, outside the fold', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([LAB_SETTING, UNREAD_ROLE, UNREAD_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['읽지 못한 역할 조건: canManage(member)', '정하지 못한 설정 조건: settingOf(key) (설정 키를 읽지 못했습니다)'],
    });
    const leftOut = p.locator('#center .reach-summary .left-out');
    assert.equal(await leftOut.locator(':scope > :first-child').textContent(), '요약에 넣지 못한 조건');
    assert.equal(await leftOut.locator('xpath=ancestor::details[contains(@class, "reach-raw")]').count(), 0);
    await p.click('#center .story-needs > summary');
    assert.equal(await leftOut.isVisible(), true);
  });
  await withStoryReach([reachRoute([UNREAD_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: [], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
});

test('in a browser, the fold of a story\'s raw conditions and its long conditions stay open when the page is drawn again, and close again on another story', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LONG_SETTING]), reachRoute([LONG_SETTING, LAB_SETTING])], async (p) => {
    assert.equal(await p.locator('#center .reach-raw details.long-guard').count(), 2);
    await p.click('#center .story-needs > summary');
    await p.click('#center .reach-raw > summary');
    await p.locator('#center .reach-link .long-guard > summary').click();
    const openState = () => p.locator('#center').evaluate((r) => ({
      fold: r.querySelector<HTMLDetailsElement>('details.reach-raw')!.open,
      long: [...r.querySelectorAll<HTMLDetailsElement>('details.long-guard')].map((g) => g.open),
    }));
    const expected = { fold: true, long: [true, false] };
    assert.deepEqual(await openState(), expected);
    await p.click('#right .statuses button:has-text("테스트 필요")');
    assert.deepEqual(await openState(), expected);
    await p.fill('#right-dock textarea', 'redraw');
    await p.click('#right button.save');
    await p.waitForSelector('#right .history li:has-text("redraw")');
    assert.deepEqual(await openState(), expected);
    await p.click('#story-list li:has-text("보고서")');
    await p.click('#story-list li:has-text("실험실을 열어")');
    assert.deepEqual(await openState(), { fold: false, long: [false, false] });
  });
});

test('in a browser, the story pane and the screen pane keep what is open apart: another story leaves a screen\'s link group open, and another screen leaves a story\'s fold open', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LONG_SETTING]), reachRoute([LAB_SETTING])], async (p) => {
    const sideTab = (label: string) => p.click(label === '화면' ? '#view-list' : '#view-story');
    await sideTab('화면');
    await p.click('#screen-list li:has-text("/lab")');
    await openScreenInfo(p);
    await p.locator('#center details.link-group > summary').first().click();
    await sideTab('스토리');
    await p.click('#story-list li:has-text("보고서")');
    await p.click('#story-list li:has-text("실험실을 열어")');
    await sideTab('화면');
    assert.equal(await p.locator('#center details.link-group').first().evaluate((d: HTMLDetailsElement) => d.open), true);

    await sideTab('스토리');
    await p.click('#center .story-needs > summary');
    await p.click('#center .reach-raw > summary');
    await p.locator('#center .reach-link .long-guard > summary').click();
    const storyOpen = () => p.locator('#center').evaluate((r) => [r.querySelector<HTMLDetailsElement>('details.reach-raw')!.open, r.querySelector<HTMLDetailsElement>('.reach-link details.long-guard')!.open]);
    for (const step of [0, 1]) {
      await p.locator('#center .step.on-map').nth(step).click();
      await p.waitForSelector('#screen-list li.selected');
      await sideTab('스토리');
      assert.deepEqual(await storyOpen(), [true, true]);
    }
  });
});

test('a candidate accepted through the page becomes a story file with the server-side author, and leaves the candidates', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const res = await postJson(base, '/api/candidates/accept', { key: HELP_KEY, id: 'open-help', name: '홈에서 도움말을 연다', author: 'someone else' });
      assert.equal(res.status, 201);
      const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'open-help.json'), 'utf8'));
      assert.equal(saved.author, 'reviewer');
      assert.deepEqual(saved.source, { record: HELP_RECORD, steps: [1, 5] });
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.ok(data.stories.list.some((s) => s.id === 'open-help' && s.name === '홈에서 도움말을 연다'));
      assert.deepEqual(data.candidates.list.map((c) => c.name), ['publish-document']);

      assert.equal((await postJson(base, '/api/candidates/accept', { key: HELP_KEY, id: 'again', name: 'x' })).status, 404);
      const taken = await postJson(base, '/api/candidates/accept', { key: PUBLISH_KEY, id: 'run-lab', name: 'x' });
      assert.equal(taken.status, 400);
      assert.match(await taken.text(), /run-lab\.json 이 이미 씁니다/);
    }),
  );
});

test('a candidate discarded through the page is kept in the discarded folder with the server-side author and does not come back after the map is rebuilt', async () => {
  await withRebuiltFixture(CANDIDATES, async (config, copy) => {
    await withServer(config, 'reviewer', async (base) => {
      assert.equal((await postJson(base, '/api/candidates/discard', { key: HELP_KEY, reason: ' ' })).status, 400);
      assert.equal((await postJson(base, '/api/candidates/discard', { key: HELP_KEY, reason: '베타 화면', author: 'someone else' })).status, 201);
    });
    const [file] = fs.readdirSync(path.join(config.storiesDir, 'discarded'));
    assert.match(file, /^\d{4}-\d{2}-\d{2}-reviewer-[0-9a-f]{8}\.json$/);
    const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'discarded', file), 'utf8'));
    assert.deepEqual([saved.reason, saved.author], ['베타 화면', 'reviewer']);
    rebuild(copy);
    await withServer(config, 'reviewer', async (base) => {
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.candidates.list.map((c) => c.name), ['publish-document']);
      assert.ok(!data.stories.list.some((s) => s.name === 'open-help'));
    });
  });
});

test('a story name and memo edited through the page are written into its file', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const res = await postJson(base, '/api/stories/edit', { id: 'run-lab', name: '실험실 결과를 본다', memo: '실험실 설정을 켠다.' });
      assert.equal(res.status, 200);
      const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'));
      assert.deepEqual([saved.name, saved.memo, saved.author], ['실험실 결과를 본다', '실험실 설정을 켠다.', 'Kim Min']);
      assert.equal((await postJson(base, '/api/stories/edit', { id: 'run-lab', name: '' })).status, 400);
      assert.equal((await postJson(base, '/api/stories/edit', { id: 'nope', name: 'x', memo: '' })).status, 400);
    }),
  );
});

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('the fields of a story, a step or the link into a step are written through the page with the mark of the file it read, and the reply names the file written', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const file = path.join(config.storiesDir, 'run-lab.json');
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      const read = data.stories.list.find((s) => s.id === 'run-lab')!.contentHash;
      assert.equal(read, sha256(file));
      const inputs = [{ box: { label: '실험 이름', nth: 2 }, value: '첫 실험' }];
      const res = await postJson(base, '/api/stories/fields', { id: 'run-lab', place: { kind: 'step', step: 2, screen: '/lab#Lab' }, fields: { needs: ['실험실 설정을 켠다'], inputs }, contentHash: read });
      assert.equal(res.status, 200);
      const written = await res.json();
      assert.deepEqual([written.file, written.contentHash, written.previousHash], ['run-lab.json', sha256(file), read]);
      const link = await postJson(base, '/api/stories/fields', { id: 'run-lab', place: { kind: 'link', step: 3, screen: '/lab/result#LabResult' }, fields: { linkNeeds: ['실행이 끝난 경우'] }, contentHash: written.contentHash });
      const story = await postJson(base, '/api/stories/fields', { id: 'run-lab', place: { kind: 'story' }, fields: { expects: ['실행 기록이 한 줄 늘어난다'] }, contentHash: (await link.json()).contentHash });
      assert.equal(story.status, 200);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(saved.screens, ['/home#Home', { screen: '/lab#Lab', needs: ['실험실 설정을 켠다'], inputs }, { screen: '/lab/result#LabResult', linkNeeds: ['실행이 끝난 경우'] }]);
      assert.deepEqual(saved.expects, ['실행 기록이 한 줄 늘어난다']);
    }),
  );
});

test('a field write is refused with its reason when a field is wrong, when the story file changed since the page read it, when the body is not an object or too large, or when it comes from another host, and the file stays as it was', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const file = path.join(config.storiesDir, 'run-lab.json');
      const read = sha256(file);
      const wrong = await postJson(base, '/api/stories/fields', { id: 'run-lab', place: { kind: 'step', step: 2, screen: '/lab#Lab' }, fields: { inputs: [{ box: { label: '실험 이름', nth: 0 }, value: '첫 실험' }] }, contentHash: read });
      assert.deepEqual([wrong.status, await wrong.text()], [400, 'screens 의 2 번째 단계의 1 번째 입력값의 box 의 nth 는 1 이상의 정수여야 합니다']);
      const first = await postJson(base, '/api/stories/fields', { id: 'run-lab', place: { kind: 'link', step: 1, screen: '/home#Home' }, fields: { linkNeeds: ['반려된 경우'] }, contentHash: read });
      assert.deepEqual([first.status, await first.text()], [400, 'screens 의 1 번째 단계에는 앞 단계가 없어 linkNeeds(들어오는 링크 조건)를 둘 수 없습니다']);
      assert.equal((await postJson(base, '/api/stories/fields', ['run-lab'])).status, 400);
      const unmarked = await postJson(base, '/api/stories/fields', { id: 'run-lab', place: { kind: 'story' }, fields: { needs: ['x'] } });
      assert.deepEqual([unmarked.status, await unmarked.text()], [400, 'contentHash 에 페이지가 읽은 스토리 파일 내용의 SHA-256 을 보내야 합니다']);
      const moved = await postJson(base, '/api/stories/fields', { id: 'run-lab', place: { kind: 'step', step: 2, screen: '/home#Home' }, fields: { needs: ['x'] }, contentHash: read });
      assert.deepEqual([moved.status, await moved.text()], [400, '스토리 run-lab 의 2 번째 단계는 /home#Home 이 아니라 /lab#Lab 화면이라 쓰지 않았습니다']);
      assert.equal((await postJson(base, '/api/stories/fields', { id: 'nope', place: { kind: 'story' }, fields: {}, contentHash: read })).status, 400);

      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), memo: '다른 곳에서 고쳤다' }));
      const changed = fs.readFileSync(file, 'utf8');
      const stale = await postJson(base, '/api/stories/fields', { id: 'run-lab', place: { kind: 'story' }, fields: { needs: ['완료된 문서가 하나 있다'] }, contentHash: read });
      assert.deepEqual([stale.status, await stale.text()], [409, '스토리 파일 run-lab.json 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다']);

      const big = await postJson(base, '/api/stories/fields', { id: 'run-lab', place: { kind: 'story' }, fields: { needs: ['x'.repeat(70 * 1024)] }, contentHash: sha256(file) }).then((r) => r.status, () => 'closed');
      assert.notEqual(big, 200);
      const port = new URL(base).port;
      const body = JSON.stringify({ id: 'run-lab', place: { kind: 'story' }, fields: { needs: ['완료된 문서가 하나 있다'] }, contentHash: sha256(file) });
      const host = await new Promise((resolve, reject) => {
        http.request({ host: '127.0.0.1', port, path: '/api/stories/fields', method: 'POST', headers: { host: `attacker.example:${port}`, 'content-type': 'application/json' } }, (r) => resolve(r.statusCode)).on('error', reject).end(body);
      });
      assert.equal(host, 403);
      assert.equal(fs.readFileSync(file, 'utf8'), changed);
    }),
  );
});

const MEMBER = { name: '일반 회원 계정', text: '역할 USER 로 가입한 계정' };

test('the order of a story\'s steps is written through the page with the mark of the file it read, each kept step keeps its fields, and a comment on a step or a link whose number now points at other screens goes under 「떨어져 나감」', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const file = path.join(config.storiesDir, 'run-lab.json');
      const read = sha256(file);
      const fields = await postJson(base, '/api/stories/fields', { id: 'run-lab', place: { kind: 'step', step: 3, screen: LAB_RESULT }, fields: { expects: ['결과 표가 보인다'] }, contentHash: read });
      const filled = (await fields.json()).contentHash;
      const onStep = (step: number, screen: string) => ({ story: 'run-lab', part: { kind: 'step', key: { step, screen } } });
      const onHop = { story: 'run-lab', part: { kind: 'hop', key: { step: 1, from: HOME, to: LAB } } };
      for (const target of [onStep(1, HOME), onStep(2, LAB), onHop]) assert.equal((await postMark(base, { target, note: 'here?' })).status, 201);

      const res = await postJson(base, '/api/stories/steps', { id: 'run-lab', steps: [{ step: 1, screen: HOME }, { screen: '/help#Help' }, { step: 2, screen: LAB }, { step: 3, screen: LAB_RESULT }], contentHash: filled });
      assert.equal(res.status, 200);
      const written = await res.json();
      assert.deepEqual([written.file, written.contentHash, written.previousHash], ['run-lab.json', sha256(file), filled]);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).screens, [HOME, '/help#Help', LAB, { screen: LAB_RESULT, expects: ['결과 표가 보인다'] }]);
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.map((m) => m.target), [onStep(1, HOME)]);
      assert.deepEqual(data.marks.detached.map((m) => m.target).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [onHop, onStep(2, LAB)]);

      const stale = await postJson(base, '/api/stories/steps', { id: 'run-lab', steps: [{ step: 1, screen: HOME }], contentHash: filled });
      assert.deepEqual([stale.status, await stale.text()], [409, '스토리 파일 run-lab.json 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다']);
      const repeated = await postJson(base, '/api/stories/steps', { id: 'run-lab', steps: [{ step: 1, screen: HOME }, { screen: HOME }, { step: 3, screen: LAB }], contentHash: sha256(file) });
      assert.deepEqual([repeated.status, await repeated.text()], [400, 'screens 의 1 번째와 2 번째가 같은 화면입니다']);
      const empty = await postJson(base, '/api/stories/steps', { id: 'run-lab', steps: [], contentHash: sha256(file) });
      assert.deepEqual([empty.status, await empty.text()], [400, 'steps 에 단계를 하나 이상 차례대로 담아야 합니다']);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).screens.length, 4);
    }),
  );
});

test('a need file is made and then edited through the page with the mark of the file it read, and each reply is the need read back', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const file = path.join(config.storiesDir, 'needs/member-account.json');
      const added = await postJson(base, '/api/needs/add', { file: 'member-account.json', ...MEMBER });
      assert.equal(added.status, 201);
      assert.deepEqual(await added.json(), { file: 'member-account.json', ...MEMBER, stories: [], contentHash: sha256(file) });
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), MEMBER);

      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      const read = data.needs.list.find((n) => n.file === 'member-account.json')!.contentHash;
      assert.equal(read, sha256(file));
      const edited = await postJson(base, '/api/needs/edit', { file: 'member-account.json', name: '회원 계정', text: MEMBER.text, contentHash: read });
      assert.equal(edited.status, 200);
      assert.deepEqual(await edited.json(), { file: 'member-account.json', name: '회원 계정', text: MEMBER.text, stories: [], contentHash: sha256(file), previousHash: read });
    }),
  );
});

test('a need write is refused with its reason when the file name is wrong or taken, when the need file changed since the page read it or the mark is missing, when the body is not an object, or when it comes from another host, and the file stays as it was', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const file = path.join(config.storiesDir, 'needs/member-account.json');
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify(MEMBER));
      const read = sha256(file);
      const bad = await postJson(base, '/api/needs/add', { file: 'Member.json', ...MEMBER });
      assert.deepEqual([bad.status, await bad.text()], [400, '공통 조건 파일 이름은 영문 소문자 · 숫자 · - · _ 로 쓰고 .json 을 붙입니다']);
      const taken = await postJson(base, '/api/needs/add', { file: 'member-account.json', name: '다른 계정', text: '다른 내용' });
      assert.deepEqual([taken.status, await taken.text()], [400, '공통 조건 파일 needs/member-account.json 이 이미 있습니다']);
      const unmarked = await postJson(base, '/api/needs/edit', { file: 'member-account.json', ...MEMBER });
      assert.deepEqual([unmarked.status, await unmarked.text()], [400, 'contentHash 에 페이지가 읽은 공통 조건 파일 내용의 SHA-256 을 보내야 합니다']);
      assert.equal((await postJson(base, '/api/needs/edit', ['member-account.json'])).status, 400);
      assert.equal((await postJson(base, '/api/needs/add', null)).status, 400);

      fs.writeFileSync(file, JSON.stringify({ ...MEMBER, text: '다른 곳에서 고쳤다' }));
      const changed = fs.readFileSync(file, 'utf8');
      const stale = await postJson(base, '/api/needs/edit', { file: 'member-account.json', ...MEMBER, contentHash: read });
      assert.deepEqual([stale.status, await stale.text()], [409, '공통 조건 파일 needs/member-account.json 이 읽은 뒤에 바뀌어 덮어쓰지 않았습니다']);

      const port = new URL(base).port;
      const body = JSON.stringify({ file: 'member-account.json', ...MEMBER, contentHash: sha256(file) });
      const host = await new Promise((resolve, reject) => {
        http.request({ host: '127.0.0.1', port, path: '/api/needs/edit', method: 'POST', headers: { host: `attacker.example:${port}`, 'content-type': 'application/json' } }, (r) => resolve(r.statusCode)).on('error', reject).end(body);
      });
      assert.equal(host, 403);
      assert.equal(fs.readFileSync(file, 'utf8'), changed);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['member-account.json']);
    }),
  );
});

test('story writes that are not JSON requests are refused', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      for (const url of ['/api/candidates/accept', '/api/candidates/discard', '/api/candidates/undiscard', '/api/stories/edit', '/api/stories/fields', '/api/stories/steps', '/api/stories/unaccept', '/api/needs/add', '/api/needs/edit']) {
        const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
        assert.equal(res.status, 415, url);
      }
      assert.ok(!fs.existsSync(path.join(config.storiesDir, 'discarded')));
    }),
  );
});

test('in a browser, accepting a candidate asks for an ID in a window only when the name of the record is already the ID of a story or the server refuses it', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) => {
    fs.writeFileSync(path.join(config.storiesDir, 'open-help.json'), JSON.stringify({ name: '도움말', screens: ['/help#Help'], memo: '', author: 'Kim Min', date: '2026-10-01' }));
    fs.writeFileSync(path.join(config.storiesDir, 'publish-document.json'), '{');
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const ask = '#accept-ask';
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        assert.equal(await p.isVisible(ask), false);
        await p.click('#center button.accept');
        await p.waitForSelector(`${ask}[open]`);
        assert.equal(await p.textContent(`${ask} .candidate`), '후보 open-help');
        assert.equal(await p.inputValue('#accept-id'), 'open-help');
        assert.equal(await p.textContent(`${ask} .invalid`), '같은 ID 의 스토리가 이미 있습니다.');
        assert.equal(await p.isDisabled(`${ask} button.accept`), true);
        await p.fill('#accept-id', 'Open Help');
        assert.equal(await p.textContent(`${ask} .invalid`), '영문 소문자, 숫자, -, _ 만 쓸 수 있습니다.');
        assert.equal(await p.isDisabled(`${ask} button.accept`), true);
        await p.keyboard.press('Escape');
        assert.equal(await p.isVisible(ask), false);
        assert.equal(await p.evaluate(() => document.activeElement!.className), 'accept');
        assert.deepEqual(fs.readdirSync(config.storiesDir).filter((f) => f.startsWith('open-help')), ['open-help.json']);

        await p.click('#center button.accept');
        await p.fill('#accept-id', 'open-help-again');
        assert.equal(await p.isVisible(`${ask} .invalid`), false);
        await p.focus(`${ask} button.cancel`);
        await p.keyboard.press('Enter');
        assert.equal(await p.isVisible(ask), false);
        assert.ok(!fs.existsSync(path.join(config.storiesDir, 'open-help-again.json')));

        await p.click('#center button.accept');
        await p.fill('#accept-id', 'open-help-again');
        await p.keyboard.press('Enter');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        assert.equal(await p.isVisible(ask), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'open-help-again.json'), 'utf8')).name, 'open-help');

        await p.click('#candidate-list li:has-text("publish-document")');
        const writes = holdRequests(p, '**/api/candidates/accept');
        await p.click('#center button.accept');
        await p.waitForFunction(() => document.querySelector<HTMLFieldSetElement>('#center .story-form')!.disabled);
        await p.click('#story-list li:has-text("실험실을 열어")');
        writes.release!();
        await p.waitForSelector('#center .story-error');
        assert.match((await p.textContent('#center .story-error'))!, /저장하지 못했습니다: 스토리 ID publish-document 는 .+ 이미 씁니다/);
        assert.equal(await p.isVisible(ask), false);
        assert.deepEqual(errors.splice(0), [BAD_REQUEST]);
        await p.unroute('**/api/candidates/accept');

        await p.click('#candidate-list li:has-text("publish-document")');
        await p.click('#center button.accept');
        await p.waitForSelector(`${ask}[open]`);
        assert.match((await p.textContent(`${ask} .error`))!, /저장하지 못했습니다: 스토리 ID publish-document 는 .+ 이미 씁니다/);
        assert.equal(await p.locator('#center .story-error').count(), 0);
        assert.equal(await p.inputValue('#accept-id'), 'publish-document');
        await p.click(`${ask} button.accept`);
        await p.waitForFunction(() => /저장하지 못했습니다/.test(document.querySelector('#accept-ask .error')!.textContent) && !document.querySelector<HTMLButtonElement>('#accept-ask button.cancel')!.disabled);
        assert.deepEqual(errors.splice(0), [BAD_REQUEST, BAD_REQUEST]);
        await p.fill('#accept-id', 'publish-document-again');
        await p.click(`${ask} button.accept`);
        await p.waitForSelector('#story-list li.selected:has-text("publish-document")');
        assert.equal(await p.isVisible(ask), false);
        assert.ok(fs.existsSync(path.join(config.storiesDir, 'publish-document-again.json')));
      }),
    );
  });
});

test('in a browser, discarding a candidate asks for a reason in the same window as excluding a pair, writes the discarded file, and moves on to the next candidate', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        assert.equal(await p.locator(asked).isVisible(), false);
        await p.click('#center button.discard');
        assert.equal(await p.locator(asked).evaluate((el) => el.matches(':modal')), true);
        assert.equal(await p.textContent(`${asked} h2`), '이 후보를 버립니다');
        assert.match((await p.textContent(`${asked} .subject`))!, /^후보open-help.*example-visits\/open-help\.json화면 순서/s);
        assert.deepEqual(await p.locator(`${asked} .subject ol li`).allTextContents(), ['/signin SignIn', '/home Home', '/beta/inbox', '/help Help']);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '버리기']);
        assert.equal(await p.textContent(`${asked} .hint`), 'Ctrl+Enter 로 버리기');
        assert.equal(await p.getAttribute(why, 'placeholder'), '버리는 이유');
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), true);
        await p.fill(why, '  \n ');
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), true);
        await p.press(why, 'Control+Enter');
        assert.equal(await p.locator(asked).isVisible(), true);

        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(await p.evaluate(() => document.activeElement!.className), 'discard');
        assert.ok(!fs.existsSync(path.join(config.storiesDir, 'discarded')));

        await p.click('#center button.discard');
        assert.equal(await p.inputValue(why), '');
        await p.keyboard.type('베타 화면');
        await p.keyboard.press('Enter');
        await p.keyboard.type('아직 열지 않는다 ');
        await p.keyboard.press('Control+Enter');
        await p.waitForSelector('#candidate-list li:only-child');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(await p.textContent('#candidate-list li.selected .name > span:first-child'), 'publish-document');
        assert.equal(await p.textContent('#center h3'), 'publish-document');
        const [file] = fs.readdirSync(path.join(config.storiesDir, 'discarded'));
        const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'discarded', file), 'utf8'));
        assert.deepEqual([saved.name, saved.reason, saved.author], ['open-help', '베타 화면\n아직 열지 않는다', 'reviewer']);

        await discardCandidate(p, '중복');
        await p.waitForSelector('#candidate-list', { state: 'detached' });
        assert.match((await p.textContent('#left'))!, /후보 0/);
        assert.equal(await p.locator('#story-list li.selected').count(), 1);
      }),
    ),
  );
});

test('in a browser, a candidate discard that fails to save leaves the window open with its reason and the error, and saves when sent again', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const refuse = (route: Route) => route.fulfill({ status: 500, body: 'disk full' });
        await p.route('**/api/candidates/discard', refuse);
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        await discardCandidate(p, '베타 화면');
        await p.locator(`${asked} .error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.equal(await p.textContent(`${asked} .error`), '저장하지 못했습니다: disk full');
        assert.equal(await p.inputValue(why), '베타 화면');
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), false);
        assert.equal(await p.locator('#center .story-error').count(), 0);
        assert.equal(await p.textContent('#candidate-list li.selected .name > span:first-child'), 'open-help');

        await p.unroute('**/api/candidates/discard', refuse);
        await p.press(why, 'Control+Enter');
        await p.waitForSelector('#candidate-list li:only-child');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(fs.readdirSync(path.join(config.storiesDir, 'discarded')).length, 1);

        await p.click('#center button.discard');
        assert.equal(await p.locator(`${asked} .error`).isVisible(), false);
      }),
    ),
  );
});

test('in a browser, after a candidate is accepted the name and memo form and the mark form hold the new story, not the story viewed before', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.inputValue('#story-name'), '실험실을 열어 결과를 본다');
        await p.click('#right-dock .statuses button:has-text("테스트 필요")');
        await p.fill('#right-dock textarea', '실험실 스토리에 쓰던 메모');
        await p.click('#candidate-list li:has-text("open-help")');
        await p.click('#center button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        assert.equal(await p.inputValue('#story-name'), 'open-help');
        assert.equal(await p.inputValue('#story-memo'), '');
        assert.equal(await p.locator('#right-dock .statuses button.on').count(), 0);
        assert.equal(await p.inputValue('#right-dock textarea'), '');
      }),
    ),
  );
});

test('in a browser, a story shows its conversation unfolded at the top of the right pane with only the form below it, and stacks in the middle its verdict chip beside its name, the folded 「사전 조건 N」 and 「손볼 화면 N」 lines, then its name and memo with 「받기 되돌리기」, above 「스토리 전체」', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        await p.click('#center button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        await p.fill('#right-dock textarea', 'is the beta inbox needed?');
        await p.click('#right-dock button.save');
        await p.waitForSelector('#right-info .talk .history li:has-text("is the beta inbox needed?")');
        assert.deepEqual(await rightPane(p), { top: ['talk'], heading: '에이전트와 대화', bottom: ['mark-form'], folded: 0 });
        assert.equal(await p.locator('#right :is(.story-form, .verdict, details)').count(), 0);

        assert.deepEqual(await p.locator('#center .title-row .chip.verdict').allTextContents(), ['판정 못 함 · 화면 없음']);
        assert.deepEqual(await storyStack(p), ['title', 'source', 'needs', 'gaps', 'save', 'whole story', 'steps']);
        assert.deepEqual(await p.locator('#center details:is(.story-needs, .story-gaps)').evaluateAll((ds) => ds.map((d) => [d.querySelector('summary')!.textContent, (d as HTMLDetailsElement).open])), [['사전 조건 0', false], ['손볼 화면 2', false]]);
        assert.deepEqual(await p.locator('#center .story-save h2').allTextContents(), ['이름 · 메모', '받기 되돌리기']);
        assert.deepEqual(await p.locator('#center .story-save :is(input, textarea)').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).name)), ['story-name', 'story-memo']);

        await p.click('#center .story-needs > summary');
        await p.click('#right-dock .statuses button:has-text("테스트 필요")');
        await p.click('#right-dock button.save');
        await p.waitForSelector('#right-info .talk .history .chip.needs-more');
        assert.equal(await p.locator('#center details.story-needs').evaluate((d: HTMLDetailsElement) => d.open), true, 'the fold stays open when the page is drawn again');
        assert.deepEqual(errors, []);
      }),
    ),
  );
});

test('in a browser, a candidate has 「스토리로 받기」, 「고쳐서 받기」 and 「버리기」 at the right end of its title row beside its verdict chip and its folded 「사전 조건 N」 under the line it came from, while its conversation is unfolded at the top of the right pane', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        assert.deepEqual(await rightPane(p), { top: ['talk'], heading: '에이전트와 대화', bottom: ['mark-form'], folded: 0 });
        assert.equal(await p.locator('#right :is(.story-form, .verdict, details, button.accept)').count(), 0);
        assert.deepEqual(await storyStack(p), ['title', 'source', 'needs', 'steps']);
        assert.deepEqual(await p.locator('#center .title-row .chip.verdict').allTextContents(), ['판정 못 함 · 화면 없음']);
        assert.deepEqual(await p.locator('#center .title-row > :last-child button').allTextContents(), ['스토리로 받기', '고쳐서 받기', '버리기']);
        const [row, acts] = await Promise.all([p.locator('#center .title-row').boundingBox(), p.locator('#center .title-row > :last-child').boundingBox()]);
        assert.ok(row!.x + row!.width - (acts!.x + acts!.width) < 2, 'the buttons end at the right edge of the row');
        assert.deepEqual(await p.locator('#center details.story-needs').evaluate((d: HTMLDetailsElement) => [d.querySelector('summary')!.textContent, d.open]), ['사전 조건 0', false]);
        assert.deepEqual(errors, []);
      }),
    ),
  );
});

const enabledControls = (p: Page) => p.locator('#center :is(.story-form, .candidate-acts) :is(input, textarea, button)').evaluateAll((els) => els.filter((e) => !e.matches(':disabled')).map((e) => e.id || e.className));

test('in a browser, the whole 받기, 버리기 and 이름 · 메모 form stays disabled while its write and the reload after it are on their way', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        const writes = holdRequests(p, '**/api/{candidates/*,stories/edit}');
        await writes.done;
        await p.click('#center button.accept');
        await p.waitForFunction(() => document.querySelector('#center button.accept')!.matches(':disabled'));
        assert.deepEqual(await enabledControls(p), []);
        const reloads = holdRequests(p, '**/api/data');
        await reloads.done;
        writes.release!();
        await untilSet(() => reloads.sent.length === 1, 'the reload after the accept');
        assert.deepEqual(await enabledControls(p), []);
        reloads.release!();
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        assert.deepEqual(writes.sent, ['/api/candidates/accept']);
        assert.ok((await enabledControls(p)).includes('story-name'));

        await p.fill('#story-name', '도움말을 연다');
        await p.click('#center button.save-story');
        await p.waitForFunction(() => document.querySelector('#story-name')!.matches(':disabled'));
        assert.deepEqual(await enabledControls(p), []);
        await untilSet(() => writes.sent.length === 2, 'the edit request');
        writes.release!();
        await untilSet(() => reloads.sent.length === 2, 'the reload after the edit');
        assert.deepEqual(await enabledControls(p), []);
        reloads.release!();
        await p.waitForSelector('#story-list li.selected:has-text("도움말을 연다")');
        assert.deepEqual(writes.sent, ['/api/candidates/accept', '/api/stories/edit']);
        assert.equal(await p.inputValue('#story-name'), '도움말을 연다');
        assert.equal(await p.locator('#right .error, #center .story-error').count(), 0);
      }),
    ),
  );
});

test('in a browser, a chosen story\'s name and memo can be changed in the middle, and saving writes them into its file', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await p.locator('#center .story-save h2').allTextContents(), ['이름 · 메모']);
        assert.equal(await p.inputValue('#story-name'), '실험실을 열어 결과를 본다');
        assert.equal(await p.inputValue('#story-memo'), '실험실은 고객사 설정에서 켜야 보인다.');
        assert.deepEqual(await p.locator('#center .story-form label > span:first-child').allTextContents(), ['이름', '메모']);
        await p.fill('#story-name', '');
        assert.equal(await p.isDisabled('#center button.save-story'), true);
        await p.fill('#story-name', '실험실 결과를 본다');
        await p.fill('#story-memo', '실험실 설정을 켠다.');
        await p.click('#center button.save-story');
        await p.waitForSelector('#story-list li.selected:has-text("실험실 결과를 본다")');
        assert.equal(await p.textContent('#center h3'), '실험실 결과를 본다');
        assert.equal(await p.textContent('#center .memo'), '실험실 설정을 켠다.');
        const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'));
        assert.deepEqual([saved.name, saved.memo, saved.author, saved.date], ['실험실 결과를 본다', '실험실 설정을 켠다.', 'Kim Min', '2026-10-01']);
      }),
    ),
  );
});

test('in a browser, a candidate that was accepted but could not be read back says so in the middle', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        await p.route('**/api/data', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'down' }));
        await p.click('#center button.accept');
        await p.waitForSelector('#center .story-error');
        assert.equal(await p.textContent('#center .story-error'), '저장했지만 다시 읽지 못했습니다: down');
        assert.ok(fs.existsSync(path.join(config.storiesDir, 'open-help.json')));
        errors.length = 0;
      }),
    ),
  );
});

test('in a browser, a story accepted from a candidate has 「받기 되돌리기」, which removes its story file and offers the candidate again picked, with the comments left on the story moved under 「떨어져 나감」 as for a story file gone, while a story not accepted from a candidate has none', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.locator('#center button.unaccept').count(), 0);
        await p.click('#candidate-list li:has-text("open-help")');
        await p.click('#center button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        await p.fill('#right-dock textarea', 'is the beta inbox needed?');
        await p.click('#right-dock button.save');
        await untilSet(() => loadMarks(config.marksDir).length === 1, 'the comment');
        assert.deepEqual(await p.locator('#center .story-save h2').allTextContents(), ['이름 · 메모', '받기 되돌리기']);

        await p.click('#center button.unaccept');
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        assert.equal(fs.existsSync(path.join(config.storiesDir, 'open-help.json')), false);
        assert.equal(await p.locator('#story-list li:has-text("open-help")').count(), 0);
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['open-help', 'publish-document']);
        assert.equal(await p.textContent('#center h3'), 'open-help');
        assert.deepEqual(await p.locator('#center .accepts button').allTextContents(), ['스토리로 받기', '고쳐서 받기']);
        assert.deepEqual(await p.locator('#left .detached li').evaluateAll((items) => items.map((li) => [li.querySelector('code')!.textContent, li.querySelector('div')!.textContent])), [
          ['open-help', 'is the beta inbox needed?'],
        ]);
        assert.equal((await postJson(base, '/api/stories/unaccept', { id: 'run-lab' })).status, 400);
        assert.deepEqual(errors, []);
      }),
    ),
  );
});
