import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { compareMaps } from '../src/baseline.ts';
import { recordedState } from '../src/code-state.ts';
import { loadConfig } from '../src/config.ts';
import { startReviewServer } from '../src/review.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const AUTHOR = { name: 'reviewer', source: 'config' };

type Guard = { guard: string; kinds: string[]; roles?: string[] | null };
type Link = { from: string; line: number; guards: Guard[] };
type Access = { restricted: boolean; kinds: string[]; route: Guard[]; links: Link[] };
type Node = { id: string; path?: string; component?: string; access?: Partial<Access>; server?: { status: string }; screens?: string[] };
type ScreenMap = { meta: object; screens: Node[]; calls: Node[] };
type Copy = { copy: string; configFile: string; setConfig: (change: Record<string, unknown>) => void; rebuild: () => string };

async function withCopy(fn: (copy: Copy) => unknown) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const setConfig = (change: Record<string, unknown>) => fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ...change }));
    const rebuild = () => execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    return await fn({ copy, configFile, setConfig, rebuild });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const readOut = (copy: string, name: string) => JSON.parse(fs.readFileSync(path.join(copy, 'out', name), 'utf8'));
const readMap = (copy: string): ScreenMap => readOut(copy, 'map.json');
const withoutDate = ({ meta, ...rest }: { meta: object }) => rest;
const screenOf = (map: ScreenMap, id: string) => map.screens.find((s) => s.id === id)!;
const callOf = (map: ScreenMap, id: string) => map.calls.find((c) => c.id === id)!;

function olderMap(map: ScreenMap): ScreenMap {
  const old: ScreenMap = structuredClone(map);
  old.screens = old.screens.filter((s) => s.id !== '/lab/result#LabResult');
  old.screens.push({ id: '/old#OldPage', path: '/old', component: 'OldPage', access: { restricted: false, kinds: [], route: [], links: [] } });
  screenOf(old, '/admin/member#AdminMember').access!.route![0].roles = ['ADMIN', 'OWNER'];
  screenOf(old, '/help#Help').access!.links![0].guards[0].guard = 'helpOn';
  const report = screenOf(old, '/admin/report#AdminReport').access!;
  report.links = report.links!.filter((l) => l.from !== '/home#Home').map((l) => ({ ...l, line: l.line + 100 }));
  old.calls = old.calls.filter((c) => c.id !== 'GET:/api/v1/lab/experiment');
  old.calls.push({ id: 'DELETE:/api/v1/document/{documentId}', server: { status: 'match' }, screens: ['/document/:id#DocumentDetail'] });
  callOf(old, 'GET:/api/v1/document/list').screens!.push('/help#Help');
  callOf(old, 'POST:/api/v1/archive/document').server = { status: 'match' };
  callOf(old, 'POST:/api/v1/auth/sign-in').server = { status: 'unchecked' };
  return old;
}

const memberCondition = (roles: string[]) => ({
  restricted: true,
  kinds: ['role'],
  route: [{ guard: 'isAdminRole(memberRole)', kinds: ['role'], roles }],
  links: ["memberRole === 'ADMIN'"],
});
const helpCondition = (guard: string) => ({ restricted: true, kinds: ['setting'], route: [], links: ['globalSettings.SYSTEM.HELP_LINK_ENABLED', guard] });

const EXPECTED = {
  screens: {
    added: ['/lab/result#LabResult'],
    removed: [{ id: '/old#OldPage', path: '/old', component: 'OldPage' }],
    conditions: [
      { id: '/admin/member#AdminMember', before: memberCondition(['ADMIN', 'OWNER']), after: memberCondition(['ADMIN']) },
      { id: '/help#Help', before: helpCondition('helpOn'), after: helpCondition('helpEnabled') },
    ],
    calls: [
      { id: '/document/:id#DocumentDetail', added: [], removed: ['DELETE:/api/v1/document/{documentId}'] },
      { id: '/help#Help', added: [], removed: ['GET:/api/v1/document/list'] },
      { id: '/lab#Lab', added: ['GET:/api/v1/lab/experiment'], removed: [] },
    ],
  },
  calls: {
    added: ['GET:/api/v1/lab/experiment'],
    removed: ['DELETE:/api/v1/document/{documentId}'],
    server: [{ id: 'POST:/api/v1/archive/document', before: 'match', after: 'none' }],
  },
};

test('with baselineMap, rebuild prints one line of the screens and calls new, removed and changed since that map, the same on every run, and writes the same files as without it', async () => {
  await withCopy(({ copy, setConfig, rebuild }) => {
    const plain = rebuild();
    const plainMap = readMap(copy);
    const plainTests = readOut(copy, 'tests.json');
    assert.doesNotMatch(plain, /changes since/);
    const baselineFile = path.join(copy, 'releases/1.0/map.json');
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify(olderMap(plainMap)));
    setConfig({ baselineMap: 'releases/1.0/map.json' });

    const line = `changes since ${baselineFile} | screens new 1 removed 1 condition 2 calls-changed 3 | calls new 1 removed 1 server 1`;
    const first = rebuild();
    assert.deepEqual(first.split('\n').filter((l) => l !== line), plain.split('\n'));
    assert.equal(first.split('\n').filter((l) => l === line).length, 1);
    assert.match(first, new RegExp(`^calls \\d+ \\| dead screens \\d+$[\\s\\S]*^${line.replace(/[|.]/g, '\\$&')}$\\nwrote .*tests\\.json$`, 'm'));
    assert.deepEqual(withoutDate(readMap(copy)), withoutDate(plainMap));
    assert.deepEqual(withoutDate(readOut(copy, 'tests.json')), withoutDate(plainTests));
    assert.equal(rebuild(), first);
  });
});

test('with baselineMap, rebuild also prints how many screens and calls the rules of each kind pick that they did not pick on the baseline map', async () => {
  await withCopy(({ copy, setConfig, rebuild }) => {
    rebuild();
    const baselineFile = path.join(copy, 'releases/1.0/map.json');
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify(olderMap(readMap(copy))));
    setConfig({ baselineMap: 'releases/1.0/map.json', caseKinds: { boundary: '경계', ended: { text: '끝난 문서', picks: [{ screen: '/lab/**' }, { api: '/api/v1/lab/**' }, { methods: ['DELETE'] }] } } });
    assert.deepEqual(rebuild().split('\n').filter((l) => /^(case kind \S+: rules |  caseKinds )/.test(l)), [
      `case kind ended: rules pick 2 screens, 1 call | new since ${baselineFile} 2`,
      '  caseKinds ended picks[2] matches no call: {"methods":["DELETE"]}',
    ]);
  });
});

test('with baselineMap, rebuild says for each case kind how many of its undecided candidates the baseline map does not have, leaving out one picked or under review; without it the line is as before', async () => {
  await withCopy(({ copy, configFile, setConfig, rebuild }) => {
    setConfig({ caseKinds: { boundary: '경계', ended: { text: '끝난 문서', picks: [{ screen: '/document/**', methods: ['POST', 'PUT'] }] } } });
    const undecidedLines = (out: string) => out.split('\n').filter((l) => /^case kind \S+: undecided /.test(l));
    const plain = undecidedLines(rebuild());
    assert.deepEqual(plain, ['case kind boundary: undecided 21 | cases with no tests 0', 'case kind ended: undecided 8 | cases with no tests 2']);
    const baselineFile = path.join(copy, 'releases/1.0/map.json');
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify(olderMap(readMap(copy))));
    setConfig({ baselineMap: 'releases/1.0/map.json' });
    assert.deepEqual(undecidedLines(rebuild()), [
      `case kind boundary: undecided 21, 2 of them new since ${baselineFile} | cases with no tests 0`,
      `case kind ended: undecided 8, 1 of them new since ${baselineFile} | cases with no tests 2`,
    ]);
    execFileSync(process.execPath, [CLI, 'case', configFile, 'boundary', '/lab/result#LabResult', 'needed'], { encoding: 'utf8' });
    execFileSync(process.execPath, [CLI, 'case', configFile, 'ended', 'GET:/api/v1/lab/experiment', 'not-needed', '--note', '실험 화면은 문서를 쓰지 않는다'], { encoding: 'utf8' });
    assert.deepEqual(undecidedLines(rebuild()), [
      `case kind boundary: undecided 20, 1 of them new since ${baselineFile} | cases with no tests 1`,
      `case kind ended: undecided 7, 0 of them new since ${baselineFile} | cases with no tests 2 | under review 1`,
    ]);
  });
});

test('the README, the agent skill and the decision record say what undecided --new lists and exits with, the new count rebuild prints, the 「신규」 marks of the page, and when an agent uses --new', () => {
  const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
  const readme = read('../README.md');
  assert.match(readme, /undecided path\/to\/project-config\.json \[<kind>\] \[--new\]/);
  assert.match(readme, /With `--new` it lists only the undecided candidates[\s\S]*`case kind <kind>: M new undecided since <file> \(N\s+undecided in all\)`[\s\S]*`--new needs baselineMap in the config` and exits with 2/);
  assert.match(readme, /`, M of them new since <file>`/);
  assert.match(readme, /「\(신규 M\)」 follows\s+「미판정 N」[\s\S]*「신규 M」 beside\s+the person button shows only those/);
  assert.match(readme, /decides the chosen ones among the lines shown/);
  assert.match(readme, /A screen in the list carries 「신규」/);
  assert.doesNotMatch(readme, /A screen in the list carries 「생김」/);
  const skill = read('../skills/duru/SKILL.md');
  assert.match(skill, /When the user said to leave the older undecided candidates of a kind for later, run `duru undecided <config>\s+<kind> --new`/);
  assert.match(skill, /Do not use `--new` for a kind added to `caseKinds` after that map was built/);
  assert.doesNotMatch(skill, /사람이 정할 것/);
  const decisions = read('../docs/decisions.md');
  assert.match(decisions, /\*\*A new undecided candidate is a screen or call undecided now that the `baselineMap` map does not have/);
  assert.match(decisions, /- Also counting as new a candidate a rule picked on the baseline map but no longer picks/);
});

async function pageBaseline(configFile: string) {
  const server = await startReviewServer(loadConfig(configFile), { author: AUTHOR });
  try {
    const data = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/data`)).json() as { baseline: unknown };
    return data.baseline;
  } finally {
    server.close();
  }
}

test('the review page data carries what changed since baselineMap, with the map named by its path from the config and its folder, and none without it', async () => {
  await withCopy(async ({ copy, configFile, setConfig, rebuild }) => {
    rebuild();
    assert.equal(await pageBaseline(configFile), null);
    fs.mkdirSync(path.join(copy, 'v1.0'));
    fs.writeFileSync(path.join(copy, 'v1.0/map.json'), JSON.stringify(olderMap(readMap(copy))));
    setConfig({ baselineMap: 'v1.0/map.json' });
    assert.deepEqual(await pageBaseline(configFile), { file: path.join('v1.0', 'map.json'), label: 'v1.0', code: recordedState(readMap(copy).meta), ...EXPECTED });
  });
});

test('a guard that moved to another line, or the same guard on a link from another screen, is not a change of the conditions a screen opens under', () => {
  const screen = (links: Link[]) => ({ id: '/a#A', access: { restricted: true, kinds: ['setting'], route: [{ guard: 'on', kinds: ['setting'], line: 3 }], links } });
  const guard = { guard: 'menu.on', kinds: ['setting'] };
  const before = { screens: [screen([{ from: '/b#B', line: 10, guards: [guard] }])], calls: [] };
  const after = { screens: [screen([{ from: '/b#B', line: 40, guards: [guard] }, { from: '/c#C', line: 7, guards: [guard] }])], calls: [] };
  assert.deepEqual(compareMaps(before, after).screens.conditions, []);
});

test('a guarded link into a screen that opens without a condition on both maps is not a change of its conditions, while a changed guard on a link into a restricted screen is, and so is a screen that turns restricted or open', () => {
  const screen = (restricted: boolean, guards: string[]) => ({
    id: '/a#A',
    access: { restricted, kinds: restricted ? ['role'] : [], route: [], links: [{ from: '/b#B', line: 1, guards: [] }, ...guards.map((guard) => ({ from: '/c#C', line: 2, guards: [{ guard, kinds: ['role'] }] }))] },
  });
  const changed = (before: object, after: object) => compareMaps({ screens: [before], calls: [] }, { screens: [after], calls: [] }).screens.conditions.length;
  assert.equal(changed(screen(false, []), screen(false, ['isAdmin(role)'])), 0);
  assert.equal(changed(screen(true, ['isAdmin(role)']), screen(true, ['isOwner(role)'])), 1);
  assert.equal(changed(screen(false, []), screen(true, ['isAdmin(role)'])), 1);
  assert.equal(changed(screen(true, ['isAdmin(role)']), screen(false, [])), 1);
  const mixed = screen(false, ['isAdmin(role)']);
  assert.equal(changed(mixed, { ...mixed, access: { ...mixed.access, restricted: true } }), 1);
});

test('a baselineMap that is missing, unreadable or not a map with screens and calls stops rebuild and the review server, naming the file, before anything is written', async () => {
  await withCopy(async ({ copy, configFile, setConfig, rebuild }) => {
    const baselineFile = path.join(copy, 'old-map.json');
    const stopped = (said: string) => {
      const run = spawnSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
      assert.equal(run.status, 1, run.stderr);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr.trim(), said);
      assert.equal(fs.existsSync(path.join(copy, 'out')), false);
    };
    setConfig({ baselineMap: 'old-map.json' });
    stopped(`baselineMap ${baselineFile} does not exist`);
    fs.writeFileSync(baselineFile, '{ "screens": [');
    stopped(`baselineMap ${baselineFile} could not be read: ${(() => { try { JSON.parse('{ "screens": ['); } catch (err) { return (err as Error).message; } })()}`);
    for (const notMap of [[], { screens: [] }, { screens: [{ id: '/a#A' }], calls: [{ path: '/api' }] }]) {
      fs.writeFileSync(baselineFile, JSON.stringify(notMap));
      stopped(`baselineMap ${baselineFile} is not a duru map with screens and calls`);
    }

    setConfig({ baselineMap: undefined });
    rebuild();
    setConfig({ baselineMap: 'old-map.json' });
    fs.rmSync(baselineFile);
    const said = `baselineMap ${baselineFile} does not exist`;
    await assert.rejects(() => startReviewServer(loadConfig(configFile), { author: AUTHOR }), new RegExp(`^Error: ${said.replace(/[.]/g, '\\.')}$`));
    const review = spawnSync(process.execPath, [CLI, 'review', configFile, '--port', '0'], { encoding: 'utf8', timeout: 20000 });
    assert.ok(review.status !== 0 && review.signal === null && review.stderr.includes(said) && !review.stderr.includes('review page'), review.stderr);
  });
});

test('a baselineMap built by a duru that did not record the route guards, the links or the roles a route guard lets through stops rebuild, naming the file', async () => {
  await withCopy(({ copy, configFile, setConfig, rebuild }) => {
    rebuild();
    const map = readMap(copy);
    const baselineFile = path.join(copy, 'old-map.json');
    setConfig({ baselineMap: 'old-map.json' });
    const said = `baselineMap ${baselineFile} was built by a duru that did not record the roles each route guard lets through — build that version's map again with this duru`;
    const olderDuru = [
      (s: Node) => s.id === '/admin/member#AdminMember' && delete s.access!.route![0].roles,
      (s: Node) => s.id === '/help#Help' && delete s.access!.route,
      (s: Node) => s.id === '/help#Help' && delete s.access!.links,
      (s: Node) => s.id === '/home#Home' && delete s.access,
    ];
    for (const change of olderDuru) {
      const old = structuredClone(map);
      old.screens.forEach(change);
      fs.writeFileSync(baselineFile, JSON.stringify(old));
      const run = spawnSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
      assert.equal(run.status, 1, run.stderr);
      assert.equal(run.stderr.trim(), said);
    }
    const unread = structuredClone(map);
    screenOf(unread, '/admin/group#AdminGroup').access!.route![0].roles = null;
    fs.writeFileSync(baselineFile, JSON.stringify(unread));
    assert.match(rebuild(), /^changes since \S+ \| screens new 0 removed 0 condition 0 calls-changed 0 \| calls new 0 removed 0 server 0$/m);
  });
});

test('extract and tasks do not read baselineMap', async () => {
  await withCopy(({ configFile, setConfig, rebuild }) => {
    rebuild();
    setConfig({ baselineMap: 'old-map.json' });
    for (const command of ['extract', 'tasks']) execFileSync(process.execPath, [CLI, command, configFile], { encoding: 'utf8' });
  });
});

test('a baselineMap that is not a path stops with what to write', async () => {
  await withCopy(({ configFile, setConfig }) => {
    for (const baselineMap of ['', 3, ['map.json']]) {
      setConfig({ baselineMap });
      assert.throws(() => loadConfig(configFile), /^Error: baselineMap must be the path of a map\.json written by an earlier rebuild, such as "releases\/1\.5\.0\/map\.json", not /);
    }
  });
});

test('a call is not taken as changed on the server when either map was built without a server API list', () => {
  const map = (status: string) => ({ screens: [], calls: [{ id: 'GET:/api/a', server: { status } }] });
  assert.deepEqual(compareMaps(map('unchecked'), map('none')).calls.server, []);
  assert.deepEqual(compareMaps(map('match'), map('unchecked')).calls.server, []);
  assert.deepEqual(compareMaps(map('match'), map('method-mismatch')).calls.server, [{ id: 'GET:/api/a', before: 'match', after: 'method-mismatch' }]);
});

const browserMissing = fs.existsSync(chromium.executablePath()) ? false : 'Chromium is not installed (npx playwright-core install chromium)';

async function onPage(configFile: string, fn: (p: Page) => Promise<void>) {
  const server = await startReviewServer(loadConfig(configFile), { author: AUTHOR });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await page.waitForSelector('#view-flow.on, #view-list.on');
    await page.click('#view-list');
    await page.waitForSelector('#screen-list li');
    await fn(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
}

const listed = (p: Page) => p.locator('#screen-list li').evaluateAll((items) => items.map((li) => li.getAttribute('title')));
const pick = (p: Page, title: string) => p.click(`#screen-list li[title="${title}"]`);
// 칸을 합친 줄도 머리줄과 같은 수의 칸을 차지해야 비교 열이 한 줄로 선다.
const rowWidths = (p: Page) => p.locator('#center table.calls tr').evaluateAll((rows) =>
  rows.map((tr) => [...tr.children].reduce((n, td) => n + Number(td.getAttribute('colspan') ?? 1), 0)));

test('in a browser, with baselineMap the page names the baseline, marks each changed screen and call, keeps only the changed screens on request, and lists the screens and calls that are gone', { skip: browserMissing }, async () => {
  await withCopy(async ({ copy, configFile, setConfig, rebuild }) => {
    rebuild();
    fs.mkdirSync(path.join(copy, 'v1.0'));
    fs.writeFileSync(path.join(copy, 'v1.0/map.json'), JSON.stringify(olderMap(readMap(copy))));
    await onPage(configFile, async (p) => {
      assert.equal(await p.isVisible('header #baseline'), false);
      assert.equal(await p.locator('#left .baseline-filter').count(), 0);
      assert.equal(await p.locator('#left :is(.chip.change-new, .chip.change-condition, .chip.change-calls)').count(), 0);
      await pick(p, '/document/:id DocumentDetail');
      assert.equal(await p.locator('#center .baseline-banner, #center tr.removed-call, #center td.compare').count(), 0);
    });
    setConfig({ baselineMap: 'v1.0/map.json' });
    await onPage(configFile, async (p) => {
      assert.ok((await p.textContent('header #baseline'))!.startsWith('비교 기준 v1.0 커밋 모름 · duru '));
      assert.equal(await p.getAttribute('header #baseline > strong', 'title'), path.join('v1.0', 'map.json'));
      assert.equal(await p.textContent('#left .baseline-filter'), 'v1.0 와 비교바뀐 화면만 5');

      const chips = (title: string) => p.locator(`#screen-list li[title="${title}"] .badges .chip:is(.change-new, .change-condition, .change-calls)`).allTextContents();
      assert.deepEqual(await chips('/lab/result LabResult'), ['신규']);
      assert.deepEqual(await chips('/admin/member AdminMember'), ['조건 바뀜']);
      assert.deepEqual(await chips('/help Help'), ['조건 바뀜', '호출 −1']);
      assert.deepEqual(await chips('/lab Lab'), ['호출 +1']);
      assert.deepEqual(await chips('/home Home'), []);
      assert.deepEqual(await chips('/admin/report AdminReport'), []);

      assert.equal((await listed(p)).length, 11);
      await p.check('#left input[name=changed]');
      assert.deepEqual(await listed(p), ['/document/:id DocumentDetail', '/help Help', '/admin/member AdminMember', '/lab Lab', '/lab/result LabResult']);

      assert.equal(await p.textContent('#left h2:has-text("에만 있던 화면")'), 'v1.0 에만 있던 화면 1');
      assert.equal(await p.textContent('#left .removed-screens li'), '/old #OldPage 없어짐');
      assert.equal(await p.textContent('#left .baseline-rest'), '역할 · 설정 조건이 바뀐 화면 2 · 서버 대조가 바뀐 호출 1');

      await pick(p, '/admin/member AdminMember');
      assert.equal(await p.textContent('#center .baseline-banner'),
        "v1.0 와 비교: 열리는 조건 라우트 isAdminRole(memberRole) (ADMIN, OWNER) · 링크 memberRole === 'ADMIN' → 라우트 isAdminRole(memberRole) (ADMIN) · 링크 memberRole === 'ADMIN'");

      await pick(p, '/document/:id DocumentDetail');
      assert.equal(await p.textContent('#center .baseline-banner'), 'v1.0 와 비교: 호출 1개 없어짐');
      assert.equal(await p.locator('#center table.calls th').last().textContent(), 'v1.0 와 비교');
      assert.equal(await p.textContent('#center tr.removed-call'), 'DELETE:/api/v1/document/{documentId}—없어짐');
      const widths = await rowWidths(p);
      assert.ok(widths.length > 2 && widths.every((w) => w === widths[0]), String(widths));

      await p.uncheck('#left input[name=changed]');
      await pick(p, '/home Home');
      assert.equal(await p.locator('#center .baseline-banner').count(), 0);
      const compareOf = (id: string) => p.locator('#center table.calls tr', { has: p.locator(`td.call > div.mono :text-is("${id}")`) }).locator('td.compare');
      assert.equal(await compareOf('POST:/api/v1/archive/document').textContent(), '서버 대조 바뀜 (서버에 있음 → 서버에 없음)');
      assert.equal(await compareOf('GET:/api/v1/document/list').textContent(), '—');

      await pick(p, '/lab Lab');
      assert.equal(await p.textContent('#center .baseline-banner'), 'v1.0 와 비교: 호출 1개 생김');
      assert.equal(await compareOf('GET:/api/v1/lab/experiment').textContent(), '생김');

      await pick(p, '/admin/report AdminReport');
      const reportWidths = await rowWidths(p);
      assert.ok(reportWidths.length > 4 && reportWidths.every((w) => w === reportWidths[0]), String(reportWidths));
    });
  });
});
