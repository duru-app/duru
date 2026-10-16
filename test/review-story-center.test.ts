import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Page, Route } from 'playwright-core';
import { loadMarks } from '../src/marks.ts';
import { withRebuiltFixture, withServer, rebuild, browserMissing, toList, withPage, openScreenInfo, openHistory, LAB_SETTING, ADMIN_ROLE, LONG_SETTING, asked, why, askedFocused, SAVE_REFUSED, untilSet, postJson, CANDIDATES, HELP_RECORD, HELP_KEY, PUBLISH_KEY, storiesTab, BAD_REQUEST, discardCandidate, holdRequests } from './review-helpers.ts';
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

const readSummary = (p: Page) => p.locator('#right .reach-summary').evaluate((el) => {
  const text = (e: Element) => [...e.childNodes].map((c) => c.textContent).join(' ');
  return {
    lines: [...el.querySelectorAll(':scope > .need, :scope > .step-roles > li, :scope > .none')].map(text),
    leftOut: [...el.querySelectorAll(':scope > .left-out li')].map(text),
  };
});

test('in a browser, a story that needs a setting and a role shows them as two summary lines under 사전 조건 in the wording of the screen summary, and the raw conditions only once the fold is opened', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LAB_SETTING]), reachRoute([LAB_SETTING, ADMIN_ROLE])], async (p) => {
    assert.deepEqual(await p.locator('#right-info > :not(.talk-scope)').evaluateAll((els) => els.slice(0, 3).map((e) => e.textContent.slice(0, 5))), ['도달 가능', '사전 조건', '역할 AD']);
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
    assert.equal(await p.locator('#right details.reach-raw').evaluate((d: HTMLDetailsElement) => d.open), false);
    assert.equal(await p.locator('#right .reach-raw .reach').isVisible(), false);
    assert.equal(await p.locator('#right .reach-summary .reach').count(), 0);
    await p.click('#right .reach-raw > summary');
    assert.equal(await p.locator('#right .reach-raw .reach').isVisible(), true);
    assert.match((await p.textContent('#right .reach-link'))!, /components\/Home\.js:19.*globalSettings\.SYSTEM\.LAB_ENABLED/);
    assert.match((await p.textContent('#right .reach-route'))!, /Routes\.js:44.*memberRole === 'ADMIN'/);
    assert.equal(await p.locator('#right-info .mark-form').count(), 0);
    assert.equal(await p.locator('#right-dock > .mark-form').count(), 1);
  });
});

test('in a browser, a condition that sits on several steps of a story is in the summary once', { skip: browserMissing }, async () => {
  await withStoryMap([], RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트']);
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE]), reachRoute([LAB_SETTING, ADMIN_ROLE, UNREAD_ROLE]), reachRoute([UNREAD_ROLE, ADMIN_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
});

test('in a browser, a condition inherited from a handler counts in the story summary when the link has no condition of its own and the handler is used in one place under that one condition', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'"]), RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트', '/lab → /lab/result']);
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
});

test('in a browser, a link whose handler is also used without a role condition adds no role to the story summary, while the fold still shows the role condition as written', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'", 'loaded']), RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트', '/lab → /lab/result']);
    assert.match((await p.locator('#right .reach-link').nth(1).textContent())!, /memberRole === 'ADMIN'/);
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
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /admin/audit']);
    assert.deepEqual(await readSummary(p), { lines: [], leftOut: ['openAudit 를 쓰는 곳에 따라 다른 조건: globalSettings.SYSTEM.MODE_ON, !globalSettings.SYSTEM.MODE_ON'] });
  });
});

test('in a browser, the first screen of a story needs from its incoming links only what every one of them needs, and is different per link when they need different settings', { skip: browserMissing }, async () => {
  await withStoryMap([storyScreens(['/help#Help'])], READ_REPORTS, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['첫 화면 /help']);
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
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['첫 화면 /lab/result']);
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
    const leftOut = p.locator('#right .reach-summary .left-out');
    assert.equal(await leftOut.locator(':scope > :first-child').textContent(), '요약에 넣지 못한 조건');
    assert.equal(await leftOut.locator('xpath=ancestor::details').count(), 0);
    assert.equal(await leftOut.isVisible(), true);
  });
  await withStoryReach([reachRoute([UNREAD_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: [], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
});

test('in a browser, the fold of a story\'s raw conditions and its long conditions stay open when the right pane is redrawn, and close again on another story', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LONG_SETTING]), reachRoute([LONG_SETTING, LAB_SETTING])], async (p) => {
    assert.equal(await p.locator('#right .reach-raw details.long-guard').count(), 2);
    await p.click('#right .reach-raw > summary');
    await p.locator('#right .reach-link .long-guard > summary').click();
    const openState = () => p.locator('#right').evaluate((r) => ({
      fold: r.querySelector<HTMLDetailsElement>('details.reach-raw')!.open,
      long: [...r.querySelectorAll<HTMLDetailsElement>('details.long-guard')].map((g) => g.open),
    }));
    const expected = { fold: true, long: [true, false] };
    assert.deepEqual(await openState(), expected);
    await p.click('#right .statuses button:has-text("더 필요")');
    assert.deepEqual(await openState(), expected);
    await p.fill('#right-dock textarea', 'redraw');
    await p.click('#right button.save');
    await openHistory(p);
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
    await p.click('#right .reach-raw > summary');
    await p.locator('#right .reach-link .long-guard > summary').click();
    const storyOpen = () => p.locator('#right').evaluate((r) => [r.querySelector<HTMLDetailsElement>('details.reach-raw')!.open, r.querySelector<HTMLDetailsElement>('.reach-link details.long-guard')!.open]);
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

test('story writes that are not JSON requests are refused', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      for (const url of ['/api/candidates/accept', '/api/candidates/discard', '/api/candidates/undiscard', '/api/stories/edit', '/api/stories/unaccept']) {
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
        await p.click('#right button.accept');
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

        await p.click('#right button.accept');
        await p.fill('#accept-id', 'open-help-again');
        assert.equal(await p.isVisible(`${ask} .invalid`), false);
        await p.focus(`${ask} button.cancel`);
        await p.keyboard.press('Enter');
        assert.equal(await p.isVisible(ask), false);
        assert.ok(!fs.existsSync(path.join(config.storiesDir, 'open-help-again.json')));

        await p.click('#right button.accept');
        await p.fill('#accept-id', 'open-help-again');
        await p.keyboard.press('Enter');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        assert.equal(await p.isVisible(ask), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'open-help-again.json'), 'utf8')).name, 'open-help');

        await p.click('#candidate-list li:has-text("publish-document")');
        const writes = holdRequests(p, '**/api/candidates/accept');
        await p.click('#right button.accept');
        await p.waitForFunction(() => document.querySelector<HTMLFieldSetElement>('#right .story-form')!.disabled);
        await p.click('#story-list li:has-text("실험실을 열어")');
        writes.release!();
        await p.waitForSelector('#right .story-error');
        assert.match((await p.textContent('#right .story-error'))!, /저장하지 못했습니다: 스토리 ID publish-document 는 .+ 이미 씁니다/);
        assert.equal(await p.isVisible(ask), false);
        assert.deepEqual(errors.splice(0), [BAD_REQUEST]);
        await p.unroute('**/api/candidates/accept');

        await p.click('#candidate-list li:has-text("publish-document")');
        await p.click('#right button.accept');
        await p.waitForSelector(`${ask}[open]`);
        assert.match((await p.textContent(`${ask} .error`))!, /저장하지 못했습니다: 스토리 ID publish-document 는 .+ 이미 씁니다/);
        assert.equal(await p.locator('#right .story-error').count(), 0);
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
        await p.click('#right button.discard');
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

        await p.click('#right button.discard');
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
        assert.equal(await p.locator('#right .story-error').count(), 0);
        assert.equal(await p.textContent('#candidate-list li.selected .name > span:first-child'), 'open-help');

        await p.unroute('**/api/candidates/discard', refuse);
        await p.press(why, 'Control+Enter');
        await p.waitForSelector('#candidate-list li:only-child');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(fs.readdirSync(path.join(config.storiesDir, 'discarded')).length, 1);

        await p.click('#right button.discard');
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
        await p.click('#right-dock .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', '실험실 스토리에 쓰던 메모');
        await p.click('#candidate-list li:has-text("open-help")');
        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        assert.equal(await p.inputValue('#story-name'), 'open-help');
        assert.equal(await p.inputValue('#story-memo'), '');
        assert.equal(await p.locator('#right-dock .statuses button.on').count(), 0);
        assert.equal(await p.inputValue('#right-dock textarea'), '');
      }),
    ),
  );
});

const enabledControls = (p: Page) => p.locator('#right-info input, #right-info textarea, #right-info button').evaluateAll((els) => els.filter((e) => !e.matches(':disabled')).map((e) => e.id || e.className));

test('in a browser, the whole 받기, 버리기 and 이름 · 메모 form stays disabled while its write and the reload after it are on their way', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        const writes = holdRequests(p, '**/api/{candidates/*,stories/edit}');
        await writes.done;
        await p.click('#right button.accept');
        await p.waitForFunction(() => document.querySelector('#right button.accept')!.matches(':disabled'));
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
        await p.click('#right button.save-story');
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
        assert.equal(await p.locator('#right .error').count(), 0);
      }),
    ),
  );
});

test('in a browser, a chosen story\'s name and memo can be changed on the right, and saving writes them into its file', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await p.locator('#right h2').allTextContents(), ['사전 조건', '이름 · 메모', '에이전트와 대화']);
        assert.equal(await p.inputValue('#story-name'), '실험실을 열어 결과를 본다');
        assert.equal(await p.inputValue('#story-memo'), '실험실은 고객사 설정에서 켜야 보인다.');
        assert.deepEqual(await p.locator('#right .story-form label > span:first-child').allTextContents(), ['이름', '메모']);
        await p.fill('#story-name', '');
        assert.equal(await p.isDisabled('#right button.save-story'), true);
        await p.fill('#story-name', '실험실 결과를 본다');
        await p.fill('#story-memo', '실험실 설정을 켠다.');
        await p.click('#right button.save-story');
        await p.waitForSelector('#story-list li.selected:has-text("실험실 결과를 본다")');
        assert.equal(await p.textContent('#center h3'), '실험실 결과를 본다');
        assert.equal(await p.textContent('#center .memo'), '실험실 설정을 켠다.');
        const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'));
        assert.deepEqual([saved.name, saved.memo, saved.author, saved.date], ['실험실 결과를 본다', '실험실 설정을 켠다.', 'Kim Min', '2026-10-01']);
      }),
    ),
  );
});

test('in a browser, a candidate that was accepted but could not be read back says so on the right', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        await p.route('**/api/data', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'down' }));
        await p.click('#right button.accept');
        await p.waitForSelector('#right .story-error');
        assert.equal(await p.textContent('#right .story-error'), '저장했지만 다시 읽지 못했습니다: down');
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
        assert.equal(await p.locator('#right button.unaccept').count(), 0);
        await p.click('#candidate-list li:has-text("open-help")');
        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        await p.fill('#right-dock textarea', 'is the beta inbox needed?');
        await p.click('#right-dock button.save');
        await untilSet(() => loadMarks(config.marksDir).length === 1, 'the comment');
        assert.deepEqual(await p.locator('#right-info h2').evaluateAll((els) => els.slice(-2).map((e) => e.textContent)), ['이름 · 메모', '받기 되돌리기']);

        await p.click('#right button.unaccept');
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        assert.equal(fs.existsSync(path.join(config.storiesDir, 'open-help.json')), false);
        assert.equal(await p.locator('#story-list li:has-text("open-help")').count(), 0);
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['open-help', 'publish-document']);
        assert.equal(await p.textContent('#center h3'), 'open-help');
        assert.deepEqual(await p.locator('#right .accepts button').allTextContents(), ['스토리로 받기', '고쳐서 받기']);
        assert.deepEqual(await p.locator('#left .detached li').evaluateAll((items) => items.map((li) => [li.querySelector('code')!.textContent, li.querySelector('div')!.textContent])), [
          ['open-help', 'is the beta inbox needed?'],
        ]);
        assert.equal((await postJson(base, '/api/stories/unaccept', { id: 'run-lab' })).status, 400);
        assert.deepEqual(errors, []);
      }),
    ),
  );
});
