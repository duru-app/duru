import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { addJudgment } from '../src/judgments.ts';
import type { ScreenMap } from '../src/map.ts';
import { addMark, addReply } from '../src/marks.ts';
import { reviewData } from '../src/review.ts';
import { taggingLines } from '../src/tasks.ts';

type Row = { title: string; source: string; format: string; depth: string; status: string };
type NewJudgment = Parameters<typeof addJudgment>[1];
type Ctx = { copy: string; configFile: string; cli: (...args: string[]) => string };

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');

function withFixtureCopy<T>(fn: (ctx: Ctx) => T, configPatch: Record<string, unknown> = {}): T {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), marksDir: 'example-marks', ...configPatch }));
    const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, configFile], { encoding: 'utf8' });
    return fn({ copy, configFile, cli });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

// 형식은 가짜 클라이언트 설정의 테스트 출처 순서(playwright, junit, vitest, verdict)로 나온다.
const emptyTests = (...cells: string[][]) => ['- empty tests:', ...cells.flatMap(([tags, method]) => [
  `  - playwright: \`test.fixme("<what it checks>", { tag: [${tags.split(' ').map((t) => JSON.stringify(t)).join(', ')}] }, async ({ page }) => {});\``,
  `  - junit: \`@Test @Disabled @DisplayName("<what it checks> ${tags}") void ${method}() {}\``,
  `  - vitest: \`test.todo("<what it checks> ${tags}");\``,
  `  - verdict: \`VERDICT <what it checks>: <verdict> — <what was seen> ${tags}\``,
])].join('\n');

const withCases = (tags: string, method: string, cases: string[]) => [[tags, method], ...cases.map((c) => [`${tags} @${c}`, `${method}_${c.replace(/[^A-Za-z0-9]+/g, '_').replace(/_$/, '')}`])];
const REPORT_CASES = ['role:ADMIN', 'role:OWNER', 'role:other', 'setting:SYSTEM.MAIN_MENU.ADMIN=true', 'setting:SYSTEM.MAIN_MENU.ADMIN=false', 'setting:SYSTEM.MAIN_MENU.ADMIN.LIST:ADMIN_REPORT=true', 'setting:SYSTEM.MAIN_MENU.ADMIN.LIST:ADMIN_REPORT=false'];
const AUDIT_CASES = ['role:ADMIN', 'role:AUDITOR', 'role:other'];

const EXPECTED = `# Test tasks — 4 screens, 1 call, 0 stories, 5 open marks

A reviewer marked these screens, API calls and stories as needing tests (\`needs-more\`). Write the tests, put \`@screen:<screen ID>\` on each test, in its \`tag\` option for Playwright and in its title for the other formats (\`@call:<call ID>\` for a test of one API call, with \`@option:<key>=true|false\` for each on/off option the test sets, and for a screen that opens only under a role or a setting the tag of each case under \`cases\` it checks), add \`@depth:<ui|api|render|code|data|output>\` when the depth of the result source does not fit, then run \`duru rebuild\` and read this list again. For a story, write a test that goes through its screens in order and put \`@story:<story ID>\` on it as well. Under \`empty tests\`, a screen or call gets one set for each open mark, a screen one more for each case with no tests, and a story one set: an empty test for each test format in the config, with the tags already in place and held back from passing (\`test.fixme\`, \`test.todo\`, \`@Disabled\` with \`import org.junit.jupiter.api.Disabled;\`, or no verdict word). Copy the one for your runner, keep the tags, put what the test checks in place of \`<what it checks>\` (the Playwright ones of an item all carry that title), remove what holds it back and fill in the data setup and the checks. A screen, call or story stays here until a reviewer marks it \`fine\`.

Source files are under \`client/src\`.

## /admin/member#AdminMember

- marks:
  - needs-more, whole screen — "No test signs in as an admin." (Kim Min, 2026-09-29)
- component: components/AdminMember.js, route at Routes.js:42
- access: needs a role
  - route guard \`isAdminRole(memberRole)\` (role)
  - link from /home#Home at components/Home.js:17, guard \`memberRole === 'ADMIN'\` (role)
- cases (a test of one carries its tag with \`@screen:/admin/member#AdminMember\`):
  - \`@role:ADMIN\` opens for this role — tests: ui pass 1
  - \`@role:other\` blocked for a role that does not open it, named in the test title — tests: ui pass 1
  - in no case — tests: ui fail 1, ui pass 1, api pass 1
- calls:
  - GET:/api/v1/member/list — no tests
- tests:
  - ui fail — admin @screen:/admin/member#AdminMember › lists members — home.spec.ts:11 (chromium)
  - ui pass — lists members for an admin — access.spec.ts:3 (chromium)
  - ui pass — sends a member signed in as MEMBER back home — access.spec.ts:8 (chromium)
  - ui pass — lists members for an owner — access.spec.ts:23 (chromium)
  - api pass — Help service › links the member page @screen:/admin/member#AdminMember — com.example.help.HelpServiceTest
${emptyTests(['@screen:/admin/member#AdminMember', 'screen_admin_member_AdminMember'])}

## /help#Help

- marks:
  - needs-more, api depth — "The help index test fails." (reviewer, 2026-09-28)
- component: components/Help.js, route at Routes.js:41
- access: needs a setting
  - link from /document/:id#DocumentDetail at components/DocumentDetail.js:20, guard \`helpEnabled\` (setting)
  - link from /signin#SignIn at components/SignIn.js:8, guard \`globalSettings.SYSTEM.HELP_LINK_ENABLED\` through openHelp (setting)
- cases (a test of one carries its tag with \`@screen:/help#Help\`):
  - \`@setting:SYSTEM.HELP_LINK_ENABLED=true\` opens with the setting condition met — tests: ui fail 1
  - \`@setting:SYSTEM.HELP_LINK_ENABLED=false\` blocked with the setting condition not met — no tests
  - in no case — tests: ui pass 1, api fail 1, code pending 1
- calls: none
- tests:
  - ui pass — help link opens help @screen:/signin#SignIn @screen:/help#Help — sign-in.spec.ts:5 (chromium)
  - ui fail — opens help from the sign-in page while the help link is on — access.spec.ts:13 (chromium)
  - api fail — Help service › loads the help index @screen:/help#Help @depth:e2e — com.example.help.HelpServiceTest
  - code pending — searches help @screen:/help#Help — /work/app/src/home/home.test.js:17
${emptyTests(
  ['@screen:/help#Help @depth:api', 'screen_help_Help_depth_api'],
  ['@screen:/help#Help @setting:SYSTEM.HELP_LINK_ENABLED=false', 'screen_help_Help_setting_SYSTEM_HELP_LINK_ENABLED_false'],
)}

## /home#Home

- marks:
  - needs-more, data depth — "Moving a draft fails; add a data check once it is fixed." (reviewer, 2026-09-29)
- component: components/Home.js, route at Routes.js:35
- access: opens without a setting or role
- calls:
  - GET:/api/v1/document/list — no tests
  - POST:/api/v1/archive/document — not on the server, no tests
- tests:
  - ui pass — shows the document list @screen:/home#Home — home.spec.ts:3 (chromium)
  - ui pass — shows the document list @screen:/home#Home — home.spec.ts:3 (firefox)
  - ui pass — shows the home page to an admin — access.spec.ts:28 (chromium)
  - api pass — Home service @screen:/home#Home › lists recent documents — com.example.home.HomeServiceTest
  - api pending — Home service @screen:/home#Home › hides archived documents — com.example.home.HomeServiceTest
  - render fail — Home @screen:/home#Home › filters › keeps the draft filter @depth:render — /work/app/src/home/home.test.js:9
  - code pass — Home @screen:/home#Home › renders the list — /work/app/src/home/home.test.js:4
  - data fail — Home service @screen:/home#Home › moves a draft & keeps the list order @depth:data — com.example.home.HomeServiceTest
${emptyTests(['@screen:/home#Home @depth:data', 'screen_home_Home_depth_data'])}

## /lab/result#LabResult

- marks:
  - needs-more, whole screen (Kim Min, 2026-09-30)
- component: components/LabResult.js, route at Routes.js:45
- access: needs a setting
  - link from /lab#Lab at components/Lab.js:14, no guard — /lab#Lab itself needs a setting
- cases (a test of one carries its tag with \`@screen:/lab/result#LabResult\`):
  - \`@setting:SYSTEM.LAB_ENABLED=true\` opens with the setting condition met — no tests
  - \`@setting:SYSTEM.LAB_ENABLED=false\` blocked with the setting condition not met — no tests
  - in no case — no tests
- calls: none
- tests: none
${emptyTests(
  ['@screen:/lab/result#LabResult', 'screen_lab_result_LabResult'],
  ['@screen:/lab/result#LabResult @setting:SYSTEM.LAB_ENABLED=true', 'screen_lab_result_LabResult_setting_SYSTEM_LAB_ENABLED_true'],
  ['@screen:/lab/result#LabResult @setting:SYSTEM.LAB_ENABLED=false', 'screen_lab_result_LabResult_setting_SYSTEM_LAB_ENABLED_false'],
)}

# API calls

## POST:/api/v1/archive/document

- marks:
  - needs-more, api depth — "The server has no archive endpoint; check what the archive button gets back." (Kim Min, 2026-09-30)
- called from: /document/:tab#DocumentList, /home#Home
- server: not on the server
- tests: none
${emptyTests(['@call:POST:/api/v1/archive/document @depth:api', 'call_POST_api_v1_archive_document_depth_api'])}
`;

test('the task list holds the needs-more and missing marks of the fake client, leaving out fine and detached ones', () => {
  withFixtureCopy(({ cli }) => {
    cli('rebuild');
    assert.equal(cli('tasks'), EXPECTED);
  });
});

const HOME_TESTS = 'tests: ui pass 3, api pass 1, api pending 1, render fail 1, code pass 1, data fail 1';

const EXPECTED_STORIES = `
# Stories

Story files are in \`example-stories\`.

## change-settings

- name: 홈에서 개인 설정을 바꾼다
- marks:
  - needs-more — "The settings screen may have been renamed." (reviewer, 2026-10-03)
- story file: change-settings.json (Kim Min, 2026-09-30)
- memo: 개인 설정 화면은 이름이 바뀌었을 수 있다.
- status: partial — no story test, and a screen on the path has tests
- story tests: none
- screens:
  1. /home#Home — ${HOME_TESTS}
     - to /settings#Settings: not judged, a screen is not on the map
  2. /settings#Settings — not on the map
- reach: not judged, a screen is not on the map
- preconditions: none where links were found
${emptyTests(['@story:change-settings @screen:/home#Home', 'story_change_settings'])}

## help-from-home

- name: 홈에서 바로 도움말을 연다
- marks:
  - needs-more — "Home has no help link; check the way through the document page." (reviewer, 2026-10-03)
- story file: help-from-home.json (reviewer, 2026-10-02)
- memo: 홈에는 도움말 링크가 없다.
- status: pending — no story test fails and one is pending
- story tests:
  - code pending — goes from home to help @story:help-from-home — /work/app/src/home/home.test.js:19
- screens:
  1. /signin#SignIn — tests: ui pass 1, code pass 1
     - to /home#Home: open at components/SignIn.js:12
  2. /home#Home — ${HOME_TESTS}
     - to /help#Help: no link
  3. /help#Help — tests: ui pass 1, ui fail 1, api fail 1, code pending 1
- reach: unreachable, no link at 1 step
- preconditions: none where links were found
${emptyTests(['@story:help-from-home @screen:/signin#SignIn @screen:/home#Home @screen:/help#Help', 'story_help_from_home'])}

## run-lab

- name: 실험실을 열어 결과를 본다
- marks:
  - needs-more — "The story test fails before the result page; add a UI test that walks it." (Kim Min, 2026-10-03)
- story file: run-lab.json (Kim Min, 2026-10-01)
- memo: 실험실은 고객사 설정에서 켜야 보인다.
- status: fail — a story test fails
- story tests:
  - api fail — Lab flow › runs the lab and reads the result @story:run-lab — com.example.lab.LabFlowTest
  - api pass — lab result — document-checks.log:13 — the last run shows on the result page
- screens:
  1. /home#Home — ${HOME_TESTS}
     - to /lab#Lab: conditioned at components/Home.js:19
  2. /lab#Lab — tests: ui pending 1, ui pass 2, code pending 1
     - to /lab/result#LabResult: open at components/Lab.js:14
  3. /lab/result#LabResult — no tests
- reach: reachable
- preconditions:
  - link /home#Home → /lab#Lab at components/Home.js:19, guard \`globalSettings.SYSTEM.LAB_ENABLED\` (setting)
  - /lab#Lab route at Routes.js:44, guard \`globalSettings.SYSTEM.LAB_ENABLED\` (setting)
${emptyTests(['@story:run-lab @screen:/home#Home @screen:/lab#Lab @screen:/lab/result#LabResult', 'story_run_lab'])}
`;

test('the task list does not call an unchecked call missing on the server when there is no server API list', () => {
  const noList: Record<string, (ctx: Ctx) => void> = {
    'an empty list file': ({ copy }) => {
      fs.writeFileSync(path.join(copy, 'server-endpoints.txt'), '');
      fs.writeFileSync(path.join(copy, 'server-endpoints-lab.txt'), '');
    },
    'a config without serverEndpoints': ({ configFile }) => {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      delete config.serverEndpoints;
      fs.writeFileSync(configFile, JSON.stringify(config));
    },
  };
  for (const [name, edit] of Object.entries(noList)) {
    withFixtureCopy((ctx) => {
      edit(ctx);
      ctx.cli('rebuild');
      const tasks = ctx.cli('tasks');
      assert.doesNotMatch(tasks, /not on the server/, name);
      assert.match(tasks, /^ {2}- POST:\/api\/v1\/archive\/document — no tests$/m, name);
      assert.match(tasks, /^- server: not checked$/m, name);
    });
  }
});

test('with no server API list the task list says under its intro that the comparison was skipped, and with a list it does not', () => {
  const skipped = 'Server comparison skipped: the server API list is absent or has no endpoint lines, so no call below is written as missing on the server.';
  withFixtureCopy(({ copy, cli }) => {
    cli('rebuild');
    assert.doesNotMatch(cli('tasks'), /Server comparison skipped/);

    fs.writeFileSync(path.join(copy, 'server-endpoints.txt'), '');
    fs.writeFileSync(path.join(copy, 'server-endpoints-lab.txt'), '');
    cli('rebuild');
    const lines = cli('tasks').split('\n');
    assert.deepEqual(lines.slice(3, 8), ['', 'Source files are under `client/src`.', '', skipped, '']);
    assert.equal(lines[8], '## /admin/member#AdminMember');
  });
});

test('a call with a server status the task list does not know prints that status instead of saying it is not on the server', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const config = loadConfig(configFile);
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    map.calls.find((c: { id: string }) => c.id === 'POST:/api/v1/archive/document').server = { status: 'ajar' };
    fs.writeFileSync(mapFile, JSON.stringify(map));
    const tasks = cli('tasks');
    assert.match(tasks, /^- server: ajar$/m);
    assert.doesNotMatch(tasks, /^- server: not on the server$/m);
  });
});

test('the task list carries the stories whose current mark is needs-more or missing as a group of their own, leaving out stories marked fine, stories with no mark however untested, and marks whose story file is gone', () => {
  withFixtureCopy(({ cli }) => {
    cli('rebuild');
    const tasks = cli('tasks');
    assert.match(tasks, /^# Test tasks — 4 screens, 1 call, 3 stories, 8 open marks\n/);
    assert.equal(tasks.slice(0, tasks.indexOf('\n# Stories\n')), EXPECTED.replace('0 stories, 5 open marks', '3 stories, 8 open marks'));
    assert.equal(tasks.slice(tasks.indexOf('\n# Stories\n')), EXPECTED_STORIES);
  }, { storiesDir: 'example-stories' });
});

test('a marked story whose first screen opens only under a setting or a role lists what it needs, the roles that open it and each link into it', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { story: 'read-reports' }, status: 'missing', note: 'Line one.\nLine two.', author: 'a' }, new Date('2026-10-03T05:00:00Z'));
    const story = cli('tasks').split('\n## read-reports\n')[1].split('\n## ')[0];
    const guards = "guard `globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST includes 'ADMIN_REPORT'` (setting); `['ADMIN', 'OWNER'].indexOf(session['member.role']) > -1` (role); `MENUS.ADMIN` (setting)";
    assert.equal(story, [
      '',
      '- name: 관리자가 보고서를 본다',
      '- marks:',
      '  - needs-more — "Line one.',
      '    Line two." (a, 2026-10-03)',
      '- story file: read-reports.json (reviewer, 2026-10-03)',
      '- status: untested — no story test, and no screen on the path has a test',
      '- story tests: none',
      '- screens:',
      '  1. /admin/report#AdminReport — no tests',
      '- reach: reachable',
      '- preconditions:',
      '  - /admin/report#AdminReport, the first screen, needs a role and a setting; roles that open it: ADMIN, OWNER',
      `    - link from /document/:id#DocumentDetail at components/SideMenu.js:11, ${guards}`,
      `    - link from /document/:tab#DocumentList at components/SideMenu.js:11, ${guards}`,
      `    - link from /home#Home at components/SideMenu.js:11, ${guards}`,
      emptyTests(['@story:read-reports @screen:/admin/report#AdminReport', 'story_read_reports']),
      '',
    ].join('\n'));
  }, { storiesDir: 'example-stories' });
});

test('a marked story step that a move in the config joins reads as that move with its reason, and the story is reachable', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.writeFileSync(path.join(copy, 'example-stories/signin-lab.json'), JSON.stringify({ name: '로그인해서 실험 결과를 본다', screens: ['/signin#SignIn', '/lab/result#LabResult'], author: 'a', date: '2026-10-03' }));
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { story: 'signin-lab' }, status: 'missing', note: 'No test.', author: 'a' }, new Date('2026-10-03T05:00:00Z'));
    const story = cli('tasks').split('\n## signin-lab\n')[1].split('\n## ')[0];
    assert.match(story, /^ {5}- to \/lab\/result#LabResult: a move in the config \(로그인 뒤\)$/m);
    assert.match(story, /^- reach: reachable$/m);
  }, { storiesDir: 'example-stories', moves: [{ from: '/signin', to: '/lab/result', reason: '로그인 뒤' }] });
});

test('a marked story carries the needs and expects a person wrote for the whole story and under each step, after the step line and before its link, and the intro says what they are', () => {
  withFixtureCopy(({ copy, cli }) => {
    const file = path.join(copy, 'example-stories/help-from-home.json');
    const story = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({
      ...story,
      needs: ['로그인할 계정이 있다', '도움말 글이 하나\n이상 있다'],
      screens: [{ screen: '/signin#SignIn', expects: ['로그인하면 홈으로 간다'] }, '/home#Home', { screen: '/help#Help', needs: ['도움말 설정을 켠다'], expects: ['도움말 목록이 보인다'] }],
      expects: ['열어 본 도움말이 기록된다'],
    }));
    cli('rebuild');
    const tasks = cli('tasks');
    const item = tasks.split('\n## help-from-home\n')[1].split('\n## ')[0];
    assert.equal(item.slice(item.indexOf('- story tests:'), item.indexOf('- reach:')), [
      '- story tests:',
      '  - code pending — goes from home to help @story:help-from-home — /work/app/src/home/home.test.js:19',
      '- needs:',
      '  - 로그인할 계정이 있다',
      '  - 도움말 글이 하나',
      '    이상 있다',
      '- screens:',
      '  1. /signin#SignIn — tests: ui pass 1, code pass 1',
      '     - expect: 로그인하면 홈으로 간다',
      '     - to /home#Home: open at components/SignIn.js:12',
      `  2. /home#Home — ${HOME_TESTS}`,
      '     - to /help#Help: no link',
      '  3. /help#Help — tests: ui pass 1, ui fail 1, api fail 1, code pending 1',
      '     - need: 도움말 설정을 켠다',
      '     - expect: 도움말 목록이 보인다',
      '- expects at the end:',
      '  - 열어 본 도움말이 기록된다',
      '',
    ].join('\n'));
    assert.match(tasks.split('\n')[2], / A person wrote the `needs` and `expects at the end` lines of a story and the `link need from step N`, `need` and `expect` lines under a step: .* duru only carries them and does not check them against the code; set up each need and each link need from a step in the story test and check each expect there\./);
    assert.doesNotMatch(tasks, /A need written `<name>/);
  }, { storiesDir: 'example-stories' });
});

test('a marked story carries under each step the inputs a person wrote, after its needs, with the words each box is found by, its number, the value and that duru did not check the box against the code, and the intro says how to read them', () => {
  withFixtureCopy(({ copy, cli }) => {
    const file = path.join(copy, 'example-stories/help-from-home.json');
    const story = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({
      ...story,
      screens: [
        { screen: '/signin#SignIn', inputs: [{ box: { testId: 'login-email', placeholder: '이메일' }, value: 'member@example.com' }, { box: { label: '비밀번호' }, value: 'test 1234 ' }] },
        '/home#Home',
        { screen: '/help#Help', needs: ['도움말 설정을 켠다'], inputs: [{ box: { label: '서명자 "메모"', nth: 2 }, value: '확인했습니다\n고맙습니다' }], expects: ['도움말 목록이 보인다'] },
      ],
    }));
    cli('rebuild');
    const tasks = cli('tasks');
    const item = tasks.split('\n## help-from-home\n')[1].split('\n## ')[0];
    assert.equal(item.slice(item.indexOf('- screens:'), item.indexOf('- reach:')), [
      '- screens:',
      '  1. /signin#SignIn — tests: ui pass 1, code pass 1',
      '     - input: placeholder "이메일" or testId "login-email" → "member@example.com" (not checked against the code)',
      '     - input: label "비밀번호" → "test 1234 " (not checked against the code)',
      '     - to /home#Home: open at components/SignIn.js:12',
      `  2. /home#Home — ${HOME_TESTS}`,
      '     - to /help#Help: no link',
      '  3. /help#Help — tests: ui pass 1, ui fail 1, api fail 1, code pending 1',
      '     - need: 도움말 설정을 켠다',
      '     - input: label "서명자 \\"메모\\"", number 2 → "확인했습니다\\n고맙습니다" (not checked against the code)',
      '     - expect: 도움말 목록이 보인다',
      '',
    ].join('\n'));
    assert.match(tasks.split('\n')[2], / An `input` line under a step names a box to fill at that step by the words on the screen it is found by, `placeholder`, `label` or `testId` \(several joined by `or` find the same box\), with `number N` when it is the Nth of the boxes those words find, and the value to put in it as a JSON string\. duru did not look for the box in the code; if the test cannot find it, suspect the story first and tell the user which input it is\./);

    fs.writeFileSync(file, JSON.stringify({ ...story, screens: [{ screen: '/signin#SignIn', inputs: [{ box: { label: '비밀번호' }, value: 'test1234' }] }, '/home#Home', '/help#Help'] }));
    cli('rebuild');
    const intro = cli('tasks').split('\n')[2];
    assert.match(intro, / An `input` line under a step names a box/);
    assert.doesNotMatch(intro, /A person wrote the `needs`/, 'a story with only inputs does not get the intro for lines it does not have');
  }, { storiesDir: 'example-stories' });
});

test('a marked story carries under each step the conditions a person wrote for the link into it, before the step\'s own needs, and the intro says what they are', () => {
  withFixtureCopy(({ copy, cli }) => {
    const file = path.join(copy, 'example-stories/help-from-home.json');
    const story = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({
      ...story,
      screens: ['/signin#SignIn', { screen: '/home#Home', linkNeeds: ['로그인에 성공한 경우'] }, { screen: '/help#Help', needs: ['도움말 설정을 켠다'], linkNeeds: ['도움말 링크를\n누른 경우'], expects: ['도움말 목록이 보인다'] }],
    }));
    cli('rebuild');
    const tasks = cli('tasks');
    const item = tasks.split('\n## help-from-home\n')[1].split('\n## ')[0];
    assert.equal(item.slice(item.indexOf('- screens:'), item.indexOf('- reach:')), [
      '- screens:',
      '  1. /signin#SignIn — tests: ui pass 1, code pass 1',
      '     - to /home#Home: open at components/SignIn.js:12',
      `  2. /home#Home — ${HOME_TESTS}`,
      '     - link need from step 1: 로그인에 성공한 경우',
      '     - to /help#Help: no link',
      '  3. /help#Help — tests: ui pass 1, ui fail 1, api fail 1, code pending 1',
      '     - link need from step 2: 도움말 링크를',
      '       누른 경우',
      '     - need: 도움말 설정을 켠다',
      '     - expect: 도움말 목록이 보인다',
      '',
    ].join('\n'));
    assert.match(tasks.split('\n')[2], / A person wrote the `needs` and `expects at the end` lines of a story and the `link need from step N`, `need` and `expect` lines under a step: .*what has to hold on the link from step N, the step before, for the story to take it into this step.* duru only carries them and does not check them against the code; set up each need and each link need from a step in the story test and check each expect there\./);
  }, { storiesDir: 'example-stories' });
});

test('a marked story carries each need it picks from the needs folder with its name, file and text, a pick of a file that is not there or could not be read says so, and the intro says how to read them', () => {
  withFixtureCopy(({ copy, cli }) => {
    const file = path.join(copy, 'example-stories/help-from-home.json');
    const story = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.mkdirSync(path.join(copy, 'example-stories/needs'));
    fs.writeFileSync(path.join(copy, 'example-stories/needs/member-account.json'), JSON.stringify({ name: '일반 회원 계정', text: '역할 USER 로 가입한 계정.\n이메일 member@example.com' }));
    fs.writeFileSync(path.join(copy, 'example-stories/needs/broken.json'), '{');
    fs.writeFileSync(file, JSON.stringify({
      ...story,
      needs: [{ use: 'member-account.json' }, '도움말 글이 하나 있다'],
      screens: [{ screen: '/signin#SignIn', needs: [{ use: 'old-admin.json' }] }, '/home#Home', { screen: '/help#Help', needs: [{ use: 'broken.json' }] }],
    }));
    cli('rebuild');
    const tasks = cli('tasks');
    const item = tasks.split('\n## help-from-home\n')[1].split('\n## ')[0];
    assert.equal(item.slice(item.indexOf('- needs:'), item.indexOf('- reach:')), [
      '- needs:',
      '  - 일반 회원 계정 (needs/member-account.json): 역할 USER 로 가입한 계정.',
      '    이메일 member@example.com',
      '  - 도움말 글이 하나 있다',
      '- screens:',
      '  1. /signin#SignIn — tests: ui pass 1, code pass 1',
      '     - need: needs/old-admin.json — the file is missing',
      '     - to /home#Home: open at components/SignIn.js:12',
      `  2. /home#Home — ${HOME_TESTS}`,
      '     - to /help#Help: no link',
      '  3. /help#Help — tests: ui pass 1, ui fail 1, api fail 1, code pending 1',
      '     - need: needs/broken.json — the file could not be read; `duru rebuild` prints why',
      '',
    ].join('\n'));
    assert.match(tasks.split('\n')[2], / A need written `<name> \(needs\/<file>\): <text>` is one a person keeps as a file in the `needs` folder of the story folder and picks for several stories: .* A need that says the file is missing or could not be read points at a need file duru did not find or could not read; tell the user and do not guess what it holds\./);
  }, { storiesDir: 'example-stories' });
});

test('a marked story carries a need file picked by a condition on the link into a step on that step\'s link need line, and the intro says how to read it', () => {
  withFixtureCopy(({ copy, cli }) => {
    const file = path.join(copy, 'example-stories/help-from-home.json');
    const story = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.mkdirSync(path.join(copy, 'example-stories/needs'));
    fs.writeFileSync(path.join(copy, 'example-stories/needs/member-account.json'), JSON.stringify({ name: '일반 회원 계정', text: '역할 USER 로 가입한 계정' }));
    fs.writeFileSync(file, JSON.stringify({ ...story, screens: ['/signin#SignIn', { screen: '/home#Home', linkNeeds: [{ use: 'member-account.json' }] }, { screen: '/help#Help', linkNeeds: [{ use: 'old-admin.json' }] }] }));
    cli('rebuild');
    const tasks = cli('tasks');
    const item = tasks.split('\n## help-from-home\n')[1].split('\n## ')[0];
    assert.equal(item.slice(item.indexOf('- screens:'), item.indexOf('- reach:')), [
      '- screens:',
      '  1. /signin#SignIn — tests: ui pass 1, code pass 1',
      '     - to /home#Home: open at components/SignIn.js:12',
      `  2. /home#Home — ${HOME_TESTS}`,
      '     - link need from step 1: 일반 회원 계정 (needs/member-account.json): 역할 USER 로 가입한 계정',
      '     - to /help#Help: no link',
      '  3. /help#Help — tests: ui pass 1, ui fail 1, api fail 1, code pending 1',
      '     - link need from step 2: needs/old-admin.json — the file is missing',
      '',
    ].join('\n'));
    assert.match(tasks.split('\n')[2], / A need written `<name> \(needs\/<file>\): <text>` is one a person keeps as a file.* on a `link need from step N` line set it up before step N so the test can take that link\./);
  }, { storiesDir: 'example-stories' });
});

test('a marked story whose steps are written as objects with nothing more gives the same task list as with screen IDs, comments on its steps and links included', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    addMark(marksDir, { target: { story: 'help-from-home', part: { kind: 'step', key: { step: 2, screen: '/home#Home' } } }, note: 'Check the help link here.', author: 'b' }, new Date('2026-10-12T02:00:00Z'));
    addMark(marksDir, { target: { story: 'help-from-home', part: { kind: 'hop', key: { step: 1, from: '/signin#SignIn', to: '/home#Home' } } }, note: 'Signed in only?', author: 'b' }, new Date('2026-10-12T04:00:00Z'));
    const before = cli('tasks');
    assert.match(before, /- comments on steps:\n {2}- step 2: \/home#Home/);
    const file = path.join(copy, 'example-stories/help-from-home.json');
    const story = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...story, screens: story.screens.map((screen: string) => ({ screen })) }));
    assert.equal(cli('tasks'), before);
  }, { storiesDir: 'example-stories' });
});

test('a marked story whose file is still in the folder but cannot be read keeps its marks in the task list, under a note that the file could not be read', () => {
  withFixtureCopy(({ copy, cli }) => {
    fs.writeFileSync(path.join(copy, 'example-stories/run-lab.json'), '{');
    cli('rebuild');
    const tasks = cli('tasks');
    assert.match(tasks, /^# Test tasks — 4 screens, 1 call, 3 stories, 8 open marks\n/);
    assert.equal(tasks.split('\n## run-lab\n')[1], [
      '',
      '- marks:',
      '  - needs-more — "The story test fails before the result page; add a UI test that walks it." (Kim Min, 2026-10-03)',
      '- story file: could not be read; `duru rebuild` prints why',
      '',
    ].join('\n'));
  }, { storiesDir: 'example-stories' });
});

test('a story name, author or screen over several lines stays inside its item, whatever the line ending', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.writeFileSync(path.join(copy, 'example-stories/read-reports.json'), JSON.stringify({
      name: 'Read reports\r## /fake#Fake',
      screens: ['/admin/report#AdminReport', 'gone\n## /step#Step'],
      author: 'b\r\n## /forged#Forged',
      date: '2026-10-03',
    }));
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { story: 'read-reports' }, status: 'missing', author: 'a' }, new Date('2026-10-03T05:00:00Z'));
    const tasks = cli('tasks');
    assert.doesNotMatch(tasks, /^## \/(fake|forged|step)/m);
    assert.match(tasks, /^- name: Read reports\n {2}## \/fake#Fake\n/m);
    assert.match(tasks, /^- story file: read-reports\.json \(b\n {2}## \/forged#Forged, 2026-10-03\)$/m);
    assert.match(tasks, /^ {5}- to gone\n {7}## \/step#Step: not judged, a screen is not on the map\n {2}2\. gone\n {5}## \/step#Step — not on the map$/m);
  }, { storiesDir: 'example-stories' });
});

// 스킬이 시키는 대로 채운다: 제목 글과 판정 낱말을 바꾸고, 통과하지 않게 막아 둔 표시를 떼고, 몸체를 넣는다.
const fillIn = (code: string) => code
  .replace('<what it checks>', 'checks it')
  .replace('<verdict>', 'UPHOLDS')
  .replace('test.fixme(', 'test(')
  .replace('@Disabled ', '')
  .replace(/^test\.todo\((.*)\);$/, 'test($1, () => { expect(1).toBe(1); });');

// Playwright 의 JSON 리포트는 tag 필드의 태그를 앞의 @ 를 뗀 채 spec.tags 에 적는다.
const tagOption = (code: string) => (JSON.parse(code.match(/\{ tag: (\[.*?\]) \}/)![1]) as string[]).map((t) => t.slice(1));

const xmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('an empty test from the task list, filled in with its tags kept, attaches to its screen, call cell or story after a rebuild in every configured format', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withHistory', value: true }, depth: 'output' }, status: 'missing', author: 'a' }, new Date('2026-10-03T05:00:00Z'));
    const tasks = cli('tasks');
    const copied: Record<string, string[]> = { playwright: [], junit: [], vitest: [], verdict: [] };
    for (const id of ['/help#Help', 'POST:/api/v1/report/export', 'run-lab']) {
      const section = tasks.split(`\n## ${id}\n`)[1].split('\n## ')[0];
      for (const [, format, code] of section.matchAll(/^ {2}- (playwright|junit|vitest|verdict): `(.*)`$/gm)) copied[format].push(fillIn(code));
    }
    assert.deepEqual(Object.values(copied).map((c) => c.length), [4, 4, 4, 4]);
    assert.doesNotMatch(Object.values(copied).flat().join('\n'), /\.fixme|\.todo|@Disabled|<verdict>/);
    const titles = (format: string) => copied[format].map((code) => JSON.parse(code.match(/"(?:[^"\\]|\\.)*"/)![0]));
    fs.writeFileSync(path.join(copy, 'results/playwright/filled.json'), JSON.stringify({
      suites: [{ title: 'filled.spec.ts', file: 'filled.spec.ts', specs: copied.playwright.map((code, i) => ({ title: titles('playwright')[i], tags: tagOption(code), file: 'filled.spec.ts', line: i + 1, tests: [{ status: 'expected', projectName: 'chromium' }] })) }],
    }));
    fs.writeFileSync(path.join(copy, 'results/junit/filled.xml'), `<testsuites><testsuite>${titles('junit').map((t) => `<testcase classname="Filled" name="${xmlText(t)}"/>`).join('')}</testsuite></testsuites>`);
    fs.writeFileSync(path.join(copy, 'results/vitest/filled.json'), JSON.stringify({
      testResults: [{ name: 'filled.test.js', assertionResults: titles('vitest').map((title) => ({ title, status: 'passed', ancestorTitles: [] })) }],
    }));
    fs.writeFileSync(path.join(copy, 'results/verdict/documents/filled.log'), copied.verdict.map((line) => `${line}\n`).join(''));
    cli('rebuild');

    const { nodes, stories } = JSON.parse(fs.readFileSync(path.join(copy, 'out/tests.json'), 'utf8'));
    const filled = (tests: { source: string; format: string; depth: string; options?: unknown; cases?: unknown }[]) => tests.filter((t) => t.source.includes('filled')).map((t) => [t.format, t.depth, ...(t.options ? [t.options] : []), ...(t.cases ? [t.cases] : [])]);
    const formats = ['playwright', 'junit', 'vitest', 'verdict'];
    const helpOff = ['setting:SYSTEM.HELP_LINK_ENABLED=false'];
    assert.deepEqual(filled(nodes['/help#Help']), [
      ['playwright', 'api'], ['playwright', 'ui', helpOff],
      ['junit', 'api'], ['junit', 'api', helpOff],
      ['vitest', 'api'], ['vitest', 'code', helpOff],
      ['verdict', 'api'], ['verdict', 'api', helpOff],
    ]);
    assert.deepEqual(filled(nodes['POST:/api/v1/report/export']), formats.map((f) => [f, 'output', [{ key: 'withHistory', value: true }]]));
    const storyDepths = [['playwright', 'ui'], ['junit', 'api'], ['vitest', 'code'], ['verdict', 'api']];
    assert.deepEqual(filled(stories['run-lab']), storyDepths);
    for (const screen of ['/home#Home', '/lab#Lab', '/lab/result#LabResult']) assert.deepEqual(filled(nodes[screen]), storyDepths);
  }, { storiesDir: 'example-stories' });
});

test('an empty verdict line printed as the task list gives it, without a verdict word, attaches as pending rather than as a pass', () => {
  withFixtureCopy(({ copy, cli }) => {
    cli('rebuild');
    const help = cli('tasks').split('\n## /help#Help\n')[1].split('\n## ')[0];
    const line = help.match(/^ {2}- verdict: `(.*)`$/m)![1];
    fs.writeFileSync(path.join(copy, 'results/verdict/documents/unfilled.log'), `${line}\n`);
    cli('rebuild');
    const { nodes } = JSON.parse(fs.readFileSync(path.join(copy, 'out/tests.json'), 'utf8'));
    assert.deepEqual(nodes['/help#Help'].filter((t: Row) => t.source.includes('unfilled')).map((t: Row) => [t.depth, t.status]), [['api', 'pending']]);
  });
});

test('an empty Playwright, Vitest or JUnit test run as the task list gives it reports as skipped or todo and attaches as pending rather than as a pass', () => {
  withFixtureCopy(({ copy, cli }) => {
    cli('rebuild');
    const help = cli('tasks').split('\n## /help#Help\n')[1].split('\n## ')[0];
    const code = (format: string) => help.match(new RegExp(`^ {2}- ${format}: \`(.*)\`$`, 'm'))![1];
    const title = (format: string) => JSON.parse(code(format).match(/"(?:[^"\\]|\\.)*"/)![0]);
    fs.writeFileSync(path.join(copy, 'results/playwright/unfilled.json'), JSON.stringify({
      suites: [{ title: 'unfilled.spec.ts', file: 'unfilled.spec.ts', specs: [{
        title: title('playwright'), ok: true, tags: tagOption(code('playwright')), file: 'unfilled.spec.ts', line: 3, column: 5,
        tests: [{ timeout: 30000, annotations: [{ type: 'fixme' }], expectedStatus: 'skipped', projectName: 'chromium', results: [{ status: 'skipped', duration: 0 }], status: 'skipped' }],
      }] }],
    }));
    fs.writeFileSync(path.join(copy, 'results/vitest/unfilled.json'), JSON.stringify({
      testResults: [{ name: '/work/app/src/unfilled.test.js', status: 'passed', assertionResults: [{ ancestorTitles: [], fullName: title('vitest'), status: 'todo', title: title('vitest'), failureMessages: [], meta: {} }] }],
    }));
    fs.writeFileSync(path.join(copy, 'results/junit/TEST-com.example.UnfilledTest.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.UnfilledTest" tests="1" errors="0" skipped="1" failures="0">
  <testcase name="${xmlText(title('junit'))}" classname="com.example.UnfilledTest" time="0">
    <skipped message="void com.example.UnfilledTest.screen_help_Help_depth_api() is @Disabled"/>
  </testcase>
</testsuite>
`);
    cli('rebuild');
    const { nodes } = JSON.parse(fs.readFileSync(path.join(copy, 'out/tests.json'), 'utf8'));
    const unfilled = nodes['/help#Help'].filter((t: Row) => /unfilled|Unfilled/.test(t.source)).map((t: Row) => [t.format, t.title, t.status]);
    assert.deepEqual(unfilled, [
      ['playwright', '<what it checks>', 'pending'],
      ['junit', 'com.example.UnfilledTest › <what it checks> @screen:/help#Help @depth:api', 'pending'],
      ['vitest', '<what it checks> @screen:/help#Help @depth:api', 'pending'],
    ]);
  });
});

test('each JUnit empty test of an item has its own method name, even when two marked cells differ only in characters a Java name cannot hold', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    for (const key of ['weekly', 'weekly_']) addMark(marksDir, { target: { node: 'POST:/api/v1/report/schedule', option: { key, value: true } }, status: 'missing', author: 'a' }, new Date('2026-10-03T05:00:00Z'));
    const schedule = cli('tasks').split('\n## POST:/api/v1/report/schedule\n')[1].split('\n## ')[0];
    assert.deepEqual([...schedule.matchAll(/^ {2}- junit: `.* void (\w+)\(\) \{\}`$/gm)].map((m) => m[1]), [
      'call_POST_api_v1_report_schedule_option_weekly_true',
      'call_POST_api_v1_report_schedule_option_weekly_true_2',
    ]);
  }, { bodyOptions: { 'POST:/api/v1/report/schedule': ['weekly', 'weekly_'] } });
});

test('the empty tests of a story name each screen on the map once, however often the story passes it', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.writeFileSync(path.join(copy, 'example-stories/back-home.json'), JSON.stringify({ name: 'Back home', screens: ['/home#Home', '/lab#Lab', '/gone#Gone', '/home#Home'], author: 'b', date: '2026-10-03' }));
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { story: 'back-home' }, status: 'missing', author: 'a' }, new Date('2026-10-03T05:00:00Z'));
    const story = cli('tasks').split('\n## back-home\n')[1].split('\n## ')[0];
    assert.equal(story.slice(story.indexOf('- empty tests:')), `${emptyTests(['@story:back-home @screen:/home#Home @screen:/lab#Lab', 'story_back_home'])}\n`);
  }, { storiesDir: 'example-stories' });
});

test('with no test results in the config, each item says there is no format to give an empty test in', () => {
  withFixtureCopy(({ cli }) => {
    cli('rebuild');
    const help = cli('tasks').split('\n## /help#Help\n')[1].split('\n## ')[0];
    assert.match(help, /\n- empty tests: none, the config lists no test results\n$/);
  }, { tests: [] });
});

test('a tagged Playwright test added for a listed screen shows on the page and in the task list after a rebuild', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.writeFileSync(
      path.join(copy, 'results/playwright/lab-result.json'),
      JSON.stringify({
        config: { projects: [] },
        suites: [
          {
            title: 'lab-result.spec.ts',
            file: 'lab-result.spec.ts',
            specs: [
              {
                title: 'shows the experiment result @screen:/lab/result#LabResult',
                tags: ['screen:/lab/result#LabResult'],
                tests: [{ expectedStatus: 'passed', projectName: 'chromium', results: [], status: 'expected' }],
                file: 'lab-result.spec.ts',
                line: 3,
              },
            ],
          },
        ],
      }),
    );
    cli('rebuild');

    const page = reviewData(loadConfig(configFile), null);
    assert.deepEqual(page.tests.nodes['/lab/result#LabResult'].map((t: Row) => [t.title, t.depth, t.status]), [
      ['shows the experiment result @screen:/lab/result#LabResult', 'ui', 'pass'],
    ]);
    const labResult = cli('tasks').split('## /lab/result#LabResult\n')[1];
    assert.match(labResult, /^- tests:\n {2}- ui pass — shows the experiment result @screen:\/lab\/result#LabResult — lab-result\.spec\.ts:3 \(chromium\)$/m);
  });
});

const CASE_KINDS = { boundary: '입력 경계: 빈 값, 최대 길이, 특수 문자', legacy: '옛 데이터: 이전 버전에서 만든 문서', retry: '실패와 복구' };
const ARCHIVE = 'POST:/api/v1/archive/document';
const RENAME = 'PUT:/api/v1/document/{documentId}/name';

test('a kind of case a reviewer picked for a listed screen or call is a case of it in the task list with its tests, and gets an empty test while it has none', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    const specs = [
      'checks the longest title @screen:/home#Home @case:boundary',
      'retries a failed load @screen:/home#Home @case:retry',
      `archives a document from the old version @call:${ARCHIVE} @case:legacy`,
    ].map((title, i) => ({ title, file: 'cases.spec.ts', line: i + 1, tests: [{ status: 'expected', projectName: 'chromium' }] }));
    fs.writeFileSync(path.join(copy, 'results/playwright/cases.json'), JSON.stringify({ suites: [{ title: 'cases.spec.ts', file: 'cases.spec.ts', specs }] }));
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    const pick = (node: string, kind: string, status = 'needed', at = '2026-10-04T01:00:00Z') => addMark(marksDir, { target: { node, case: kind }, status, author: 'a' }, new Date(at));
    pick('/home#Home', 'legacy');
    pick('/home#Home', 'boundary');
    pick('/home#Home', 'retry');
    pick('/home#Home', 'retry', 'not-needed', '2026-10-04T02:00:00Z');
    pick(ARCHIVE, 'legacy');
    pick(ARCHIVE, 'boundary');
    pick('/lab#Lab', 'boundary');
    const tasks = cli('tasks');
    const section = (id: string) => tasks.split(`\n## ${id}\n`)[1].split('\n## ')[0].split('\n# ')[0];

    assert.match(tasks, /^# Test tasks — 4 screens, 1 call, 0 stories, 5 open marks, \d+ undecided case candidates, \d+ cases? with no tests\n/);
    assert.ok(tasks.includes('and the tag of each case under `cases` it checks: a role or setting case of a screen that opens only under one, or a kind of case a reviewer picked for the screen or call, tagged `@case:<kind>`)'));
    assert.ok(tasks.includes('a screen or call gets one set for each open mark and one more for each case with no tests, and a story one set'));
    assert.ok(!tasks.includes('\n## /lab#Lab\n'), 'a picked kind alone does not list a screen');
    assert.ok(section('/home#Home').includes([
      '- cases (a test of one carries its tag with `@screen:/home#Home`):',
      `  - \`@case:boundary\` ${CASE_KINDS.boundary} — tests: ui pass 1`,
      `  - \`@case:legacy\` ${CASE_KINDS.legacy} — no tests`,
      '  - in no case — tests: ui pass 4, api pass 1, api pending 1, render fail 1, code pass 1, data fail 1',
      '- calls:',
    ].join('\n')));
    assert.ok(section('/home#Home').endsWith(`${emptyTests(['@screen:/home#Home @depth:data', 'screen_home_Home_depth_data'], ['@screen:/home#Home @case:legacy', 'screen_home_Home_case_legacy'])}\n`));
    assert.ok(section(ARCHIVE).includes([
      '- server: not on the server',
      `- cases (a test of one carries its tag with \`@call:${ARCHIVE}\`):`,
      `  - \`@case:boundary\` ${CASE_KINDS.boundary} — no tests`,
      `  - \`@case:legacy\` ${CASE_KINDS.legacy} — tests: ui pass 1`,
      '  - in no case — no tests',
      '- tests:',
    ].join('\n')));
    assert.ok(section(ARCHIVE).endsWith(`${emptyTests([`@call:${ARCHIVE} @depth:api`, 'call_POST_api_v1_archive_document_depth_api'], [`@call:${ARCHIVE} @case:boundary`, 'call_POST_api_v1_archive_document_case_boundary'])}\n`));
  }, { caseKinds: CASE_KINDS });
});

const ENDED = { text: '끝난 문서: 끝난 뒤의 쓰기 요청은 거부된다', values: ['cancelled', 'rejected'] };

test('a picked kind that lists values is a case of each value in the task list with its tests, and each value with none gets an empty test carrying its value tag', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    const specs = [
      'refuses a cancelled document @screen:/home#Home @case:ended=cancelled',
      'refuses an ended document @screen:/home#Home @case:ended',
      `refuses archiving a rejected document @call:${ARCHIVE} @case:ended=rejected`,
    ].map((title, i) => ({ title, file: 'cases.spec.ts', line: i + 1, tests: [{ status: 'expected', projectName: 'chromium' }] }));
    fs.writeFileSync(path.join(copy, 'results/playwright/cases.json'), JSON.stringify({ suites: [{ title: 'cases.spec.ts', file: 'cases.spec.ts', specs }] }));
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    const pick = (node: string, kind: string) => addMark(marksDir, { target: { node, case: kind }, status: 'needed', author: 'a' }, new Date('2026-10-04T01:00:00Z'));
    pick('/home#Home', 'boundary');
    pick('/home#Home', 'ended');
    pick(ARCHIVE, 'ended');
    const tasks = cli('tasks');
    const section = (id: string) => tasks.split(`\n## ${id}\n`)[1].split('\n## ')[0].split('\n# ')[0];

    assert.ok(tasks.includes('or a kind of case a reviewer picked for the screen or call, tagged `@case:<kind>`, or `@case:<kind>=<value>` for a value of a kind with values)'));
    assert.ok(section('/home#Home').includes([
      '- cases (a test of one carries its tag with `@screen:/home#Home`):',
      `  - \`@case:boundary\` ${CASE_KINDS.boundary} — no tests`,
      `  - ${ENDED.text}, a case for each value:`,
      '    - `@case:ended=cancelled` — tests: ui pass 1',
      '    - `@case:ended=rejected` — no tests',
      '  - in no case — tests: ui pass 4, api pass 1, api pending 1, render fail 1, code pass 1, data fail 1',
      '- calls:',
    ].join('\n')));
    assert.ok(section('/home#Home').endsWith(`${emptyTests(['@screen:/home#Home @depth:data', 'screen_home_Home_depth_data'], ['@screen:/home#Home @case:boundary', 'screen_home_Home_case_boundary'], ['@screen:/home#Home @case:ended=rejected', 'screen_home_Home_case_ended_rejected'])}\n`));
    assert.ok(section(ARCHIVE).includes([
      `- cases (a test of one carries its tag with \`@call:${ARCHIVE}\`):`,
      `  - ${ENDED.text}, a case for each value:`,
      '    - `@case:ended=cancelled` — no tests',
      '    - `@case:ended=rejected` — tests: ui pass 1',
      '  - in no case — no tests',
      '- tests:',
    ].join('\n')));
    assert.ok(section(ARCHIVE).endsWith(`${emptyTests([`@call:${ARCHIVE} @depth:api`, 'call_POST_api_v1_archive_document_depth_api'], [`@call:${ARCHIVE} @case:ended=cancelled`, 'call_POST_api_v1_archive_document_case_ended_cancelled'])}\n`));
  }, { caseKinds: { boundary: CASE_KINDS.boundary, ended: ENDED } });
});

test('a kind a rule picked for a listed screen or call is a case of it in the task list with its tests, and gets an empty test while it has none, unless a later mark took it out', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    const specs = [
      'refuses a cancelled document @screen:/home#Home @case:ended=cancelled',
      `archives a document from the old version @call:${ARCHIVE} @case:legacy`,
    ].map((title, i) => ({ title, file: 'cases.spec.ts', line: i + 1, tests: [{ status: 'expected', projectName: 'chromium' }] }));
    fs.writeFileSync(path.join(copy, 'results/playwright/cases.json'), JSON.stringify({ suites: [{ title: 'cases.spec.ts', file: 'cases.spec.ts', specs }] }));
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    addMark(marksDir, { target: { node: '/home#Home', case: 'boundary' }, status: 'not-needed', note: '홈에는 입력 칸이 없다', rule: { index: 0, pick: { screen: '/home' } }, author: 'a' }, new Date('2026-10-04T01:00:00Z'));
    const tasks = cli('tasks');
    const section = (id: string) => tasks.split(`\n## ${id}\n`)[1].split('\n## ')[0].split('\n# ')[0];

    assert.ok(tasks.includes('or a kind of case a reviewer or a rule in the config picked for the screen or call, tagged `@case:<kind>`, or `@case:<kind>=<value>` for a value of a kind with values)'));
    assert.ok(!tasks.includes('\n## /lab#Lab\n'), 'a kind a rule picked alone does not list a screen');
    assert.ok(section('/home#Home').includes([
      '- cases (a test of one carries its tag with `@screen:/home#Home`):',
      `  - ${ENDED.text}, a case for each value:`,
      '    - `@case:ended=cancelled` — tests: ui pass 1',
      '    - `@case:ended=rejected` — no tests',
      '  - in no case — tests: ui pass 3, api pass 1, api pending 1, render fail 1, code pass 1, data fail 1',
      '- calls:',
    ].join('\n')));
    assert.ok(section('/home#Home').endsWith(`${emptyTests(['@screen:/home#Home @depth:data', 'screen_home_Home_depth_data'], ['@screen:/home#Home @case:ended=rejected', 'screen_home_Home_case_ended_rejected'])}\n`));
    assert.ok(section(ARCHIVE).includes([
      `- cases (a test of one carries its tag with \`@call:${ARCHIVE}\`):`,
      `  - \`@case:legacy\` ${CASE_KINDS.legacy} — tests: ui pass 1`,
      '  - in no case — no tests',
      '- tests:',
    ].join('\n')));
  }, { caseKinds: {
    boundary: { text: CASE_KINDS.boundary, picks: [{ screen: '/home' }] },
    legacy: { text: CASE_KINDS.legacy, picks: [{ api: '/api/v1/archive/**' }] },
    ended: { ...ENDED, picks: [{ screen: '/home' }, { screen: '/lab' }] },
  } });
});

test('with case kinds configured but none picked, the task list differs from one without them in its intro, the undecided count in its head and a section of case kinds at the end', () => {
  withFixtureCopy(({ cli }) => {
    cli('rebuild');
    const tasks = cli('tasks');
    const [listed, kinds] = tasks.split('\n# Case kinds\n');
    const [head, intro, ...rest] = listed.split('\n\n');
    const [expectedHead, expectedIntro, ...expectedRest] = EXPECTED.split('\n\n');
    const candidates = 11 + 10;
    assert.equal(head, `${expectedHead}, ${candidates * 3} undecided case candidates, 0 cases with no tests`);
    assert.notEqual(intro, expectedIntro);
    assert.deepEqual(rest, expectedRest);
    assert.deepEqual([...kinds.matchAll(/^## (\S+)$/gm)].map((m) => m[1]), Object.keys(CASE_KINDS));
    assert.deepEqual([...kinds.matchAll(/^- undecided: (.+)$/gm)].map((m) => m[1]), Array(3).fill(String(candidates)));
    assert.deepEqual([...kinds.matchAll(/^- rules: (.+)$/gm)].map((m) => m[1]), Array(3).fill('none, so every screen and call is a candidate'));
  }, { caseKinds: CASE_KINDS });
});

test('the case kinds section lists each kind\'s undecided candidates, writes first, and each screen or call picked for it whose cases have no tests, with who picked it, the tags and empty tests, leaving out those listed above under their marks while counting their cases as rebuild does', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    const specs = [`refuses a cancelled rename @call:${RENAME} @case:ended=cancelled`].map((title, i) => ({ title, file: 'cases.spec.ts', line: i + 1, tests: [{ status: 'expected', projectName: 'chromium' }] }));
    fs.writeFileSync(path.join(copy, 'results/playwright/cases.json'), JSON.stringify({ suites: [{ title: 'cases.spec.ts', file: 'cases.spec.ts', specs }] }));
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    addMark(marksDir, { target: { node: '/lab#Lab', case: 'ended' }, status: 'needed', note: '실험 화면도 문서를 쓴다', author: 'agent', via: 'duru case' }, new Date('2026-10-04T01:00:00Z'));
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/export', case: 'ended' }, status: 'not-needed', note: '내보내기는 읽기만 한다', author: 'agent', via: 'duru case' }, new Date('2026-10-04T01:00:00Z'));
    const tasks = cli('tasks');
    const kinds = tasks.slice(tasks.indexOf('\n# Case kinds\n'));
    const ended = kinds.slice(kinds.indexOf('\n## ended\n'));
    assert.match(tasks, /^# Test tasks — 4 screens, 1 call, 0 stories, 5 open marks, 7 undecided case candidates, 5 cases with no tests\n/);
    assert.ok(kinds.includes('Read the source of each undecided candidate, write requests first as they are listed, and decide it: run `duru case <config> <kind> <ID> needed`'));
    assert.ok(ended.startsWith([
      '',
      '## ended',
      '',
      `- description: ${ENDED.text}`,
      '- values: cancelled, rejected',
      '- rules:',
      '  - `picks[0]` {"screen":"/document/**","methods":["POST","PUT"]}',
      '- undecided: 7',
      '  - POST:/api/v1/auth/sign-in — call, sent from /signin#SignIn',
      '  - POST:/api/v1/report/archive — call, sent from /admin/audit#AdminAudit, /admin/report#AdminReport',
      '  - POST:/api/v1/report/schedule — call, sent from /admin/audit#AdminAudit, /admin/report#AdminReport',
      '  - GET:/api/v1/document/list — call, sent from /home#Home',
      '  - GET:/api/v1/document/{documentId} — call, sent from /document/:id#DocumentDetail',
      '  - GET:/api/v1/lab/experiment — call, sent from /lab#Lab',
      '  - GET:/api/v1/member/list — call, sent from /admin/member#AdminMember',
      '- cases with no tests: 5, 2 of them under screens and calls listed above',
      '',
      '### /lab#Lab',
      '',
      '- screen, component components/Lab.js, route at Routes.js:44',
    ].join('\n')));
    assert.ok(ended.includes([
      '- picked by: agent, 2026-10-04 — "실험 화면도 문서를 쓴다"',
      '- no tests: `@case:ended=cancelled`, `@case:ended=rejected`',
      emptyTests(['@screen:/lab#Lab @case:ended=cancelled', 'screen_lab_Lab_case_ended_cancelled'], ['@screen:/lab#Lab @case:ended=rejected', 'screen_lab_Lab_case_ended_rejected']),
      '',
      `### ${RENAME}`,
      '',
      '- call, sent from /document/:id#DocumentDetail',
      '- picked by: a rule, `caseKinds.ended.picks[0]`',
      '- no tests: `@case:ended=rejected`',
      emptyTests([`@call:${RENAME} @case:ended=rejected`, 'call_PUT_api_v1_document_documentId_name_case_ended_rejected']),
    ].join('\n')));
    assert.ok(!ended.includes(`### ${ARCHIVE}`), 'a call listed above under its mark is not repeated');
    const counted = cli('rebuild').match(/^case kind ended: undecided (\d+) \| cases with no tests (\d+)$/m)!;
    assert.deepEqual([...counted].slice(1), ['7', '5']);
    assert.match(tasks, /^# Test tasks — .*, 7 undecided case candidates, 5 cases with no tests\n/);
    assert.ok(tasks.split(`\n## ${ARCHIVE}\n`)[1].includes(`@call:${ARCHIVE} @case:ended=cancelled`));
  }, { caseKinds: { ended: { ...ENDED, picks: [{ screen: '/document/**', methods: ['POST', 'PUT'] }] } } });
});

test('with no open marks but cases with no tests the task list says the case kinds below still have work, and once nothing is left there it says only that no mark is open', () => {
  const pick = { screen: '/**' };
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.rmSync(path.join(copy, 'example-marks'), { recursive: true });
    cli('rebuild');
    const { marksDir, outDir } = loadConfig(configFile);
    assert.match(cli('tasks'), /^# Test tasks — 0 screens, 0 calls, 0 stories, 0 open marks, 0 undecided case candidates, 11 cases with no tests\n[\s\S]*\nNo open marks, but the case kinds below still have undecided candidates or cases with no tests\.\n\n# Case kinds\n/);
    const map: ScreenMap = JSON.parse(fs.readFileSync(path.join(outDir, 'map.json'), 'utf8'));
    for (const s of map.screens) addMark(marksDir, { target: { node: s.id, case: 'boundary' }, status: 'not-needed', note: '입력 칸이 없다', rule: { index: 0, pick }, author: 'agent', via: 'duru case' });
    assert.match(cli('tasks'), /^# Test tasks — 0 screens, 0 calls, 0 stories, 0 open marks\n[\s\S]*\nNo open marks\.\n\n# Case kinds\n[\s\S]*\n- undecided: none\n- cases with no tests: none\n$/);
  }, { caseKinds: { boundary: { text: CASE_KINDS.boundary, picks: [pick] } } });
});

test('with no open marks the task list says so', () => {
  withFixtureCopy(({ copy, cli }) => {
    fs.rmSync(path.join(copy, 'example-marks'), { recursive: true });
    cli('rebuild');
    assert.match(cli('tasks'), /^# Test tasks — 0 screens, 0 calls, 0 stories, 0 open marks\n[\s\S]*\nNo open marks\.\n$/);
  });
});

test('comments left on an open target after its mark follow the mark in order, while earlier comments and a target with only comments stay off the list', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    const before = cli('tasks');
    addMark(marksDir, { target: { node: '/lab#Lab', depth: 'ui' }, note: 'Before the mark.', author: 'a' }, new Date('2026-10-05T01:00:00Z'));
    addMark(marksDir, { target: { node: '/lab#Lab', depth: 'ui' }, status: 'missing', note: 'No UI test.', author: 'a' }, new Date('2026-10-05T02:00:00Z'));
    addMark(marksDir, { target: { node: '/lab#Lab', depth: 'ui' }, note: 'The empty table too.', author: 'b' }, new Date('2026-10-05T03:00:00Z'));
    addMark(marksDir, { target: { node: '/lab#Lab', depth: 'ui' }, note: 'And the error row.', author: 'a' }, new Date('2026-10-05T04:00:00Z'));
    addMark(marksDir, { target: { story: 'read-reports' }, note: 'Only a comment.', author: 'a' }, new Date('2026-10-05T05:00:00Z'));

    const after = cli('tasks');
    const lab = after.split('## /lab#Lab\n')[1].split('\n## ')[0];
    assert.match(lab, /^ {2}- needs-more, ui depth — "No UI test\." \(a, 2026-10-05\)\n {2}- comment, ui depth — "The empty table too\." \(b, 2026-10-05\)\n {2}- comment, ui depth — "And the error row\." \(a, 2026-10-05\)$/m);
    assert.doesNotMatch(after, /Before the mark|Only a comment/);
    assert.match(after.split('\n')[2], / A `comment` line under a mark is a comment a reviewer left on the same target after that mark\.$/);
    assert.doesNotMatch(before, /`comment` line/);
    assert.equal(after.includes('## read-reports'), before.includes('## read-reports'));
  });
});

test('replies follow the comment they answer, indented under it and oldest first, and a reply to a comment before the mark stays off the list', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    const early = addMark(marksDir, { target: { node: '/lab#Lab' }, note: 'Before the mark.', author: 'a' }, new Date('2026-10-05T01:00:00Z'));
    addMark(marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'No test.', author: 'a' }, new Date('2026-10-05T02:00:00Z'));
    const first = addMark(marksDir, { target: { node: '/lab#Lab' }, note: 'Is the table tested?', author: 'b' }, new Date('2026-10-05T03:00:00Z'));
    const second = addMark(marksDir, { target: { node: '/lab#Lab' }, note: 'And the error row.', author: 'b' }, new Date('2026-10-05T04:00:00Z'));
    addReply(marksDir, { replyTo: first.id, note: 'Not yet.\nWriting one now.' }, new Date('2026-10-05T06:00:00Z'));
    addReply(marksDir, { replyTo: first.id, note: 'Written.' }, new Date('2026-10-05T07:00:00Z'));
    addReply(marksDir, { replyTo: second.id, note: 'Covered by the same test.' }, new Date('2026-10-05T05:00:00Z'));
    addReply(marksDir, { replyTo: early.id, note: 'An early answer.' }, new Date('2026-10-05T08:00:00Z'));

    const out = cli('tasks');
    const lab = out.split('## /lab#Lab\n')[1].split('\n## ')[0];
    assert.match(lab, new RegExp([
      '^  - needs-more, whole screen — "No test\\." \\(a, 2026-10-05\\)',
      '  - comment, whole screen — "Is the table tested\\?" \\(b, 2026-10-05\\)',
      '    - reply — "Not yet\\.',
      '      Writing one now\\." \\(agent, 2026-10-05\\)',
      '    - reply — "Written\\." \\(agent, 2026-10-05\\)',
      '  - comment, whole screen — "And the error row\\." \\(b, 2026-10-05\\)',
      '    - reply — "Covered by the same test\\." \\(agent, 2026-10-05\\)$',
    ].join('\n'), 'm'));
    assert.doesNotMatch(out, /Before the mark|An early answer/);
    assert.match(out.split('\n')[2], / A `reply` line under a comment is an answer to that comment\.$/);
  });
});

test('comments on tests under an open screen or call follow its marks, each test named with where it is and how it is linked, with replies under them; a target that is not open, or a test that is gone, keeps them off the list', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    const test = (node: string, title: string, file: string, source: string) => ({ node, part: { kind: 'test', key: { source, file, title } } });
    addMark(marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'No test.', author: 'a' }, new Date('2026-10-12T01:00:00Z'));
    const pending = addMark(marksDir, { target: test('/lab#Lab', 'opens the lab', 'home.spec.ts', 'results/playwright/e2e.json'), note: 'Why is this pending?', author: 'b' }, new Date('2026-10-12T02:00:00Z'));
    addReply(marksDir, { replyTo: pending.id, note: 'It waits for the lab data.' }, new Date('2026-10-12T03:00:00Z'));
    addMark(marksDir, { target: test('/lab#Lab', 'opens the lab', 'home.spec.ts', 'results/playwright/e2e.json'), note: 'And on firefox?', author: 'b' }, new Date('2026-10-12T04:00:00Z'));
    addMark(marksDir, { target: test('/lab#Lab', 'a test renamed since', 'home.spec.ts', 'results/playwright/e2e.json'), note: 'Gone.', author: 'b' }, new Date('2026-10-12T05:00:00Z'));
    addMark(marksDir, { target: { node: '/document/:tab#DocumentList' }, status: 'needs-more', author: 'a' }, new Date('2026-10-12T01:00:00Z'));
    addMark(marksDir, { target: test('/document/:tab#DocumentList', 'sort by date', 'document-checks.log', 'results/verdict/documents/document-checks.log'), note: 'Is the time zone set?', author: 'b' }, new Date('2026-10-12T02:00:00Z'));
    addMark(marksDir, { target: test('/document/:tab#DocumentList', 'DocumentTable › lists the documents it is given', 'components/DocumentTable.spec.js', 'results/vitest/client-unit.json'), note: 'Can this carry the tag?', author: 'b' }, new Date('2026-10-12T03:00:00Z'));
    addMark(marksDir, { target: test('/document/:id#DocumentDetail', 'loads the detail screen only when it is needed', 'components/DocumentDetail.spec.js', 'results/vitest/client-unit.json'), note: 'Not open.', author: 'b' }, new Date('2026-10-12T02:00:00Z'));

    const out = cli('tasks');
    const lab = out.split('## /lab#Lab\n')[1].split('\n## ')[0];
    assert.match(lab, new RegExp([
      '^- marks:',
      '  - needs-more, whole screen — "No test\\." \\(a, 2026-10-12\\)',
      '- comments on tests:',
      '  - test "opens the lab" at home\\.spec\\.ts:20 — pending, tagged with this screen, from results/playwright/e2e\\.json',
      '    - comment — "Why is this pending\\?" \\(b, 2026-10-12\\)',
      '      - reply — "It waits for the lab data\\." \\(agent, 2026-10-12\\)',
      '    - comment — "And on firefox\\?" \\(b, 2026-10-12\\)',
      '- component: ',
    ].join('\n'), 'm'));
    const list = out.split('## /document/:tab#DocumentList\n')[1].split('\n## ')[0];
    assert.match(list, /^ {2}- test "sort by date" at document-checks\.log:9 — fail, tagged with this screen, from results\/verdict\/documents\/document-checks\.log — sorting ignores the time of day\n {4}- comment — "Is the time zone set\?"/m);
    assert.match(list, /^ {2}- test "DocumentTable › lists the documents it is given" at components\/DocumentTable\.spec\.js:6 — fail, imports a source file of this screen without its tag, from results\/vitest\/client-unit\.json\n/m);
    assert.doesNotMatch(out, /Gone\.|Not open\./);
    assert.match(out.split('\n')[2], / Under `comments on tests`, each test a reviewer left a comment on is named with its file and line, its status, how it is linked to the screen or call and the result file it was read from; read the result file for why it failed\.$/);
  });
});

test('comments on an opening condition and an incoming link of an open screen are listed with the source file and line each is written at, and a condition that is gone keeps its comment off the list', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    addMark(marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'No test.', author: 'a' }, new Date('2026-10-12T01:00:00Z'));
    const asked = addMark(marksDir, { target: { node: '/lab#Lab', part: { kind: 'condition', key: 'setting:SYSTEM.LAB_ENABLED=on' } }, note: 'Only with the lab on?', author: 'b' }, new Date('2026-10-12T02:00:00Z'));
    addReply(marksDir, { replyTo: asked.id, note: 'Yes, the route checks it.' }, new Date('2026-10-12T03:00:00Z'));
    addMark(marksDir, { target: { node: '/lab#Lab', part: { kind: 'link', key: { from: '/home#Home', conditions: ['setting:SYSTEM.LAB_ENABLED=on'] } } }, note: 'Is this link shown?', author: 'b' }, new Date('2026-10-12T04:00:00Z'));
    addMark(marksDir, { target: { node: '/lab#Lab', part: { kind: 'condition', key: 'role:ADMIN' } }, note: 'Gone.', author: 'b' }, new Date('2026-10-12T05:00:00Z'));

    const out = cli('tasks');
    const lab = out.split('## /lab#Lab\n')[1].split('\n## ')[0];
    assert.match(lab, new RegExp([
      '^- marks:',
      '  - needs-more, whole screen — "No test\\." \\(a, 2026-10-12\\)',
      '- comments on opening conditions:',
      '  - condition `setting:SYSTEM\\.LAB_ENABLED=on` — route at Routes\\.js:44 \\(`globalSettings\\.SYSTEM\\.LAB_ENABLED`\\); link from /home#Home at components/Home\\.js:19 \\(`globalSettings\\.SYSTEM\\.LAB_ENABLED`\\)',
      '    - comment — "Only with the lab on\\?" \\(b, 2026-10-12\\)',
      '      - reply — "Yes, the route checks it\\." \\(agent, 2026-10-12\\)',
      '- comments on incoming links:',
      '  - link from /home#Home reading `setting:SYSTEM\\.LAB_ENABLED=on`, at components/Home\\.js:19',
      '    - comment — "Is this link shown\\?" \\(b, 2026-10-12\\)',
      '- component: ',
    ].join('\n'), 'm'));
    assert.doesNotMatch(out, /Gone\./);
    assert.match(out.split('\n')[2], / Under `comments on opening conditions` and `comments on incoming links`, each role or setting condition and each link into the screen a reviewer left a comment on is named with the source file and line it is written at; if the app does not do what duru read there, tell the user it is a duru defect, and otherwise answer with that line\.$/);
  });
});

test('comments on a step and on the link between two steps of an open story are listed under it with the screen files, and the link with its verdict, while a comment on a step the story no longer has stays off the list', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    const asked = addMark(marksDir, { target: { story: 'help-from-home', part: { kind: 'step', key: { step: 2, screen: '/home#Home' } } }, note: 'Check the help link here.', author: 'b' }, new Date('2026-10-12T02:00:00Z'));
    addReply(marksDir, { replyTo: asked.id, note: 'Home has none.' }, new Date('2026-10-12T03:00:00Z'));
    addMark(marksDir, { target: { story: 'help-from-home', part: { kind: 'hop', key: { step: 1, from: '/signin#SignIn', to: '/home#Home' } } }, note: 'Signed in only?', author: 'b' }, new Date('2026-10-12T04:00:00Z'));
    addMark(marksDir, { target: { story: 'help-from-home', part: { kind: 'step', key: { step: 3, screen: '/lab#Lab' } } }, note: 'Gone.', author: 'b' }, new Date('2026-10-12T05:00:00Z'));

    const out = cli('tasks');
    const story = out.split('## help-from-home\n')[1].split('\n## ')[0];
    assert.match(story, new RegExp([
      '^- marks:',
      '  - needs-more — "Home has no help link; check the way through the document page\\." \\(reviewer, 2026-10-03\\)',
      '- comments on steps:',
      '  - step 2: /home#Home, component \\S+, route at Routes\\.js:\\d+',
      '    - comment — "Check the help link here\\." \\(b, 2026-10-12\\)',
      '      - reply — "Home has none\\." \\(agent, 2026-10-12\\)',
      '- comments on links between steps:',
      '  - step 1 → 2: from /signin#SignIn, component \\S+, route at Routes\\.js:\\d+ to /home#Home, component \\S+, route at Routes\\.js:\\d+ — open at components/SignIn\\.js:12',
      '    - comment — "Signed in only\\?" \\(b, 2026-10-12\\)',
      '- story file: help-from-home\\.json',
    ].join('\n'), 'm'));
    assert.doesNotMatch(out, /Gone\./);
    assert.match(out.split('\n')[2], / Under `comments on steps` and `comments on links between steps`, /);
  }, { storiesDir: 'example-stories' });
});

test('a comment left on two open screens shows under each with both named, and a comment with no target comes first under a section of its own with its reply', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    addMark(marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'No test.', author: 'a' }, new Date('2026-10-14T01:00:00Z'));
    addMark(marksDir, { target: { node: '/help#Help' }, status: 'missing', note: 'No test.', author: 'a' }, new Date('2026-10-14T01:00:00Z'));
    addMark(marksDir, { targets: [{ node: '/lab#Lab' }, { node: '/help#Help' }], note: 'Same setting on both?', author: 'b' }, new Date('2026-10-14T02:00:00Z'));
    const asked = addMark(marksDir, { targets: [], note: 'What does the review not cover?', author: 'b' }, new Date('2026-10-14T03:00:00Z'));
    addReply(marksDir, { replyTo: asked.id, note: 'Stories without tests.' }, new Date('2026-10-14T04:00:00Z'));

    const out = cli('tasks');
    const both = /^ {2}- comment, whole screen, left on 2 targets: \/lab#Lab; \/help#Help — "Same setting on both\?" \(b, 2026-10-14\)$/m;
    assert.match(out.split('## /lab#Lab\n')[1].split('\n## ')[0], both);
    assert.match(out.split('## /help#Help\n')[1].split('\n## ')[0], both);
    assert.match(out, /\nSource files are under `[^`]+`\.\n\n# Comments with no target\n\n- comment — "What does the review not cover\?" \(b, 2026-10-14\)\n {2}- reply — "Stories without tests\." \(agent, 2026-10-14\)\n/);
    assert.match(out.split('\n')[2], / A comment left on several targets shows under each of them, with the list of all of them; answer it once\. Under `# Comments with no target`, /);
  });
});

test('a note over several lines stays inside its mark, and a call whose API function was not found still shows', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    cli('rebuild');
    const config = loadConfig(configFile);
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'Check the start.\n## /fake#Fake\n- tests: none', author: 'a' }, new Date('2026-09-30T05:00:00Z'));
    const mapFile = path.join(copy, 'out/map.json');
    const map: ScreenMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    map.screens.find((s) => s.id === '/lab#Lab')!.apiCalls[0].endpoints = null;
    fs.writeFileSync(mapFile, JSON.stringify(map));

    const lab = cli('tasks').split('## /lab#Lab\n')[1].split('\n## ')[0];
    assert.match(lab, /^ {2}- needs-more, whole screen — "Check the start\.\n {4}## \/fake#Fake\n {4}- tests: none" \(a, 2026-09-30\)$/m);
    assert.match(lab, /^ {2}- ajaxLabExperiment at components\/Lab\.js:\d+ — not found among the API functions$/m);
  });
});

test('a result source configured with the output depth shows its tests and an output-depth mark in the task list', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.mkdirSync(path.join(copy, 'results/verdict/exports'));
    fs.writeFileSync(
      path.join(copy, 'results/verdict/exports/export-checks.log'),
      'VERDICT result file: UPHOLDS — the exported file holds every experiment row @screen:/lab/result#LabResult\n' +
        'VERDICT list file: BROKEN — the exported list misses archived documents @call:GET:/api/v1/document/list\n',
    );
    const own = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...own, tests: [...own.tests, { format: 'verdict', path: 'results/verdict/exports', depth: 'output' }] }));
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/lab/result#LabResult', depth: 'output' }, status: 'needs-more', note: 'Open the file.', author: 'a' }, new Date('2026-10-01T05:00:00Z'));

    const tasks = cli('tasks');
    const labResult = tasks.split('## /lab/result#LabResult\n')[1].split('\n## ')[0];
    assert.match(labResult, /^ {2}- needs-more, output depth — "Open the file\." \(a, 2026-10-01\)$/m);
    assert.match(labResult, /^- tests:\n {2}- output pass — result file — export-checks\.log:1 — the exported file holds every experiment row$/m);
    const home = tasks.split('## /home#Home\n')[1].split('\n## ')[0];
    assert.match(home, /^ {2}- GET:\/api\/v1\/document\/list — tests: output fail 1$/m);
  });
});

test('a guarded link from a screen that opens only under a setting says so after its guards', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    const routes = path.join(copy, 'client/src/Routes.js');
    const original = fs.readFileSync(routes, 'utf8');
    const wrapped = original
      .replace('        <Layout session={session} globalSettings={globalSettings}>\n', '        {globalSettings.SYSTEM.NAV_ENABLED && (\n        <Layout session={session} globalSettings={globalSettings}>\n')
      .replace('        </Layout>\n', '        </Layout>\n        )}\n');
    assert.ok(wrapped.includes('NAV_ENABLED && (\n') && wrapped.includes('</Layout>\n        )}\n'));
    fs.writeFileSync(routes, wrapped);
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/report#AdminReport' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const report = cli('tasks').split('## /admin/report#AdminReport\n')[1].split('\n## ')[0];
    const fromHome = report.split('\n').find((l) => l.startsWith('  - link from /home#Home'))!;
    assert.match(fromHome, /, guard `[^`]+` \(setting\); `[^`]+` \(role\); `MENUS\.ADMIN` \(setting\) — \/home#Home itself needs a setting$/);
  });
});

test('a call line in the task list names the on/off options of its request body, including those set in the config, with the tests of each option value by depth', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/report#AdminReport' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const report = cli('tasks').split('## /admin/report#AdminReport\n')[1].split('\n## ')[0];
    assert.equal(
      report.slice(report.indexOf('- calls:')),
      [
        '- calls:',
        '  - POST:/api/v1/report/export — tests: ui pass 4, ui fail 1 — options: withAttachments, withHistory',
        '    - withAttachments=true — tests: ui fail 1',
        '    - withAttachments=false — no tests',
        '    - withHistory=true — tests: ui pass 2',
        '    - withHistory=false — tests: ui fail 1',
        '    - no option tag — tests: ui pass 2',
        '  - POST:/api/v1/report/archive — tests: ui pass 1 — options: signedOnly, withHistory',
        '    - signedOnly=true — tests: ui pass 1',
        '    - signedOnly=false — no tests',
        '    - withHistory=true — tests: ui pass 1',
        '    - withHistory=false — no tests',
        '    - no option tag — no tests',
        '  - POST:/api/v1/report/schedule — no tests — options: weekly',
        '    - weekly=true — no tests',
        '    - weekly=false — no tests',
        '    - no option tag — no tests',
        '- tests: none',
        emptyTests(...withCases('@screen:/admin/report#AdminReport', 'screen_admin_report_AdminReport', REPORT_CASES)),
        '',
      ].join('\n'),
    );
  });
});

const DETAIL_CALL = 'GET:/api/v1/document/{documentId}';
const EXPORT_CALL = 'POST:/api/v1/report/export';

function withLinkedResultCall(fn: (ctx: Omit<Ctx, 'configFile'>) => void) {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.mkdirSync(path.join(copy, 'results/verdict/exports'));
    fs.writeFileSync(
      path.join(copy, 'results/verdict/exports/export-checks.log'),
      `VERDICT history in the file: UPHOLDS — every change is listed @call:${EXPORT_CALL} @option:withHistory=true\n` +
        `VERDICT package file: BROKEN — the attachments are missing @call:${EXPORT_CALL} @option:withAttachments=true @option:withHistory=false\n`,
    );
    const own = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const callLinks = [
      { from: EXPORT_CALL, to: DETAIL_CALL, note: '내보낸 파일을 연다' },
      { from: 'POST:/api/v1/archive/document', to: DETAIL_CALL, note: '보관본을 연다' },
      { from: 'POST:/api/v1/report/weekly', to: DETAIL_CALL, note: '주간 보고서를 연다' },
    ];
    fs.writeFileSync(configFile, JSON.stringify({ ...own, callLinks, tests: [...own.tests, { format: 'verdict', path: 'results/verdict/exports', depth: 'output' }] }));
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    addMark(marksDir, { target: { node: '/document/:id#DocumentDetail' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    addMark(marksDir, { target: { node: DETAIL_CALL, depth: 'output' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    fn({ copy, cli });
  });
}

const RESULT_OPTION_LINES = [
  `- options that change this result — set on POST:/api/v1/archive/document, "보관본을 연다": none, POST:/api/v1/archive/document has no options`,
  `- options that change this result — set on ${EXPORT_CALL}, "내보낸 파일을 연다" (a test for these carries \`@call:${EXPORT_CALL}\`, its \`@option:\` tag and \`@depth:output\`):`,
  '  - withAttachments=true — tests: output fail 1',
  '  - withAttachments=false — no tests at output depth',
  '  - withHistory=true — tests: output pass 1',
  '  - withHistory=false — tests: output fail 1',
  `- options that change this result — set on POST:/api/v1/report/weekly, "주간 보고서를 연다": POST:/api/v1/report/weekly is not on the map`,
];

test('a call that another call\'s options change the result of lists those options with the output-depth tests of the other call for each value, under its screen and under API calls', () => {
  withLinkedResultCall(({ cli }) => {
    const tasks = cli('tasks');
    const detail = tasks.split('## /document/:id#DocumentDetail\n')[1].split('\n## ')[0];
    const calls = detail.slice(detail.indexOf('- calls:'), detail.indexOf('\n- tests:'));
    assert.deepEqual(calls.split('\n'), [
      '- calls:',
      `  - ${DETAIL_CALL} — no tests`,
      ...RESULT_OPTION_LINES.map((l) => `    ${l}`),
      '  - PUT:/api/v1/document/{documentId}/name — tests: ui fail 1',
    ]);
    const item = tasks.split(`## ${DETAIL_CALL}\n`)[1].split('\n## ')[0];
    assert.equal(
      item.slice(0, item.indexOf('\n- tests:')),
      ['', '- marks:', '  - needs-more, output depth (a, 2026-10-01)', '- called from: /document/:id#DocumentDetail', '- server: on the server (core)', ...RESULT_OPTION_LINES].join('\n'),
    );
    assert.equal(tasks.match(/options that change this result/g)!.length, 6);
  });
});

test('a map written before call links has no result option lines and the task list still comes out', () => {
  withLinkedResultCall(({ copy, cli }) => {
    const mapFile = path.join(copy, 'out/map.json');
    const { callLinks, unknownCallLinks, ...old } = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    assert.equal(callLinks.length + unknownCallLinks.length, 3);
    fs.writeFileSync(mapFile, JSON.stringify(old));
    const tasks = cli('tasks');
    assert.match(tasks, new RegExp(`^ {2}- ${DETAIL_CALL.replace(/[{}]/g, '\\$&')} — no tests$`, 'm'));
    assert.doesNotMatch(tasks, /options that change this result/);
  });
});

test('screens that share an ID are listed once, as the last of them on the map, and the page data holds that one', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    cli('rebuild');
    const mapFile = path.join(copy, 'out/map.json');
    const map: ScreenMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    const report = map.screens.find((s) => s.id === '/admin/report#AdminReport')!;
    const plainExport = { ...report.apiCalls.find((c) => c.fn === 'ajaxReportExport')!, options: [] };
    map.screens.push({ ...report, line: 99, apiCalls: [plainExport] });
    fs.writeFileSync(mapFile, JSON.stringify(map));
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/report#AdminReport' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const list = cli('tasks');
    const sections = list.split('## /admin/report#AdminReport\n').slice(1).map((s) => s.split('\n## ')[0]);
    assert.equal(sections.length, 1);
    assert.match(sections[0], /^- calls:\n {2}- POST:\/api\/v1\/report\/export — tests: ui pass 4, ui fail 1\n- tests: none$/m);
    assert.match(list, /^# Test tasks — 5 screens,/m);
    const data = reviewData(loadConfig(configFile), null);
    assert.equal(data.map.screens.length, map.screens.length - 1);
    assert.equal(data.map.screens.find((s) => s.id === '/admin/report#AdminReport')!.line, 99);
    assert.equal(data.flow.summary.screens, data.map.screens.length);
  });
});

test('a link from a screen that opens only under a role says so', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/audit#AdminAudit' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const audit = cli('tasks').split('## /admin/audit#AdminAudit\n')[1].split('\n## ')[0];
    assert.match(audit, /^ {2}- link from \/admin\/member#AdminMember at components\/AdminMember\.js:14, no guard — \/admin\/member#AdminMember itself needs a role$/m);
  });
});

test('a link from a screen that needs both a setting and a role names both', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
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
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/help#Help' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const help = cli('tasks').split('## /help#Help\n')[1].split('\n## ')[0];
    assert.match(help, /^ {2}- link from \/admin\/report#AdminReport at components\/AdminReport\.js:10, no guard — \/admin\/report#AdminReport itself needs a role and a setting$/m);
  });
});

test('a screen whose links ask for different kinds, and a link from it, say it differs by link', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    const home = path.join(copy, 'client/src/components/Home.js');
    const src = fs.readFileSync(home, 'utf8');
    fs.writeFileSync(home, src.replace("      {session['member.role']", "      {memberRole === 'ADMIN' && <Link to={Option.ROUTE_PATH.HELP}>Help</Link>}\n      {session['member.role']"));
    fs.writeFileSync(path.join(copy, 'client/src/components/Help.js'), "import { Link } from 'react-router-dom';\nimport Option from '_define/Option';\n\nexport default function Help() {\n  return <article><Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link></article>;\n}\n");
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    for (const node of ['/help#Help', '/lab/result#LabResult']) addMark(marksDir, { target: { node }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const section = (id: string) => cli('tasks').split(`## ${id}\n`)[1].split('\n## ')[0];
    const help = section('/help#Help');
    assert.match(help, /^- access: differs by link, see each link below$/m);
    assert.match(help, /^ {2}- link from \/home#Home at components\/Home\.js:\d+, guard `memberRole === 'ADMIN'` \(role\)$/m);
    assert.match(section('/lab/result#LabResult'), /^ {2}- link from \/help#Help at components\/Help\.js:5, no guard — \/help#Help itself differs by link$/m);
  });
});

test('a call line names only the options its own screen sends in the source', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.writeFileSync(
      path.join(copy, 'client/src/components/AdminAudit.js'),
      "import { ajaxReportExport } from '_ajax/AjaxFunc';\n\nexport default function AdminAudit() {\n  return <button onClick={() => ajaxReportExport({ ids: [] })}>Export</button>;\n}\n",
    );
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/audit#AdminAudit' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const audit = cli('tasks').split('## /admin/audit#AdminAudit\n')[1].split('\n## ')[0];
    assert.match(audit, /^- calls:\n {2}- POST:\/api\/v1\/report\/export — tests: ui pass 4, ui fail 1\n- tests: none$/m);
  });
});

test('a test whose option tags name only options this screen does not send counts on no option line of the call', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.writeFileSync(
      path.join(copy, 'client/src/components/AdminAudit.js'),
      "import { ajaxReportExport } from '_ajax/AjaxFunc';\n\nexport default function AdminAudit() {\n  return <button onClick={() => ajaxReportExport({ ids: [], withAttachments: true })}>Export</button>;\n}\n",
    );
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/audit#AdminAudit' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const audit = cli('tasks').split('## /admin/audit#AdminAudit\n')[1].split('\n## ')[0];
    assert.equal(
      audit.slice(audit.indexOf('- calls:')),
      [
        '- calls:',
        '  - POST:/api/v1/report/export — tests: ui pass 4, ui fail 1 — options: withAttachments',
        '    - withAttachments=true — tests: ui fail 1',
        '    - withAttachments=false — no tests',
        '    - no option tag — tests: ui pass 2',
        '- tests: none',
        emptyTests(...withCases('@screen:/admin/audit#AdminAudit', 'screen_admin_audit_AdminAudit', AUDIT_CASES)),
        '',
      ].join('\n'),
    );
  });
});

test('a mark on an option value of a call is listed with the option key, value and depth, where the option was found, and the tests of that cell', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    const at = new Date('2026-10-01T05:00:00Z');
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withHistory', value: true } }, status: 'needs-more', note: 'Only the UI is tested.', author: 'a' }, at);
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withHistory', value: true }, depth: 'output' }, status: 'missing', note: 'Open the exported file.', author: 'a' }, at);
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withAttachments', value: false }, depth: 'ui' }, status: 'fine', author: 'a' }, at);
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/schedule', option: { key: 'weekly', value: true } }, status: 'missing', author: 'a' }, at);

    const tasks = cli('tasks');
    assert.match(tasks, /^# Test tasks — 4 screens, 3 calls, 0 stories, 8 open marks$/m);
    const section = (id: string) => tasks.split(`\n## ${id}\n`)[1].split('\n## ')[0];
    assert.equal(
      section('POST:/api/v1/report/export'),
      [
        '',
        '- marks:',
        '  - needs-more, withHistory=true — "Only the UI is tested." (a, 2026-10-01)',
        '  - needs-more, withHistory=true at output depth — "Open the exported file." (a, 2026-10-01)',
        '- called from: /admin/audit#AdminAudit, /admin/report#AdminReport',
        '- server: on the server (core)',
        '- marked options:',
        '  - withHistory — found at components/ExportDialog.js:18 (/admin/audit#AdminAudit, /admin/report#AdminReport)',
        '    - withHistory=true:',
        '      - ui pass — exports with history @call:POST:/api/v1/report/export @option:withHistory=true — export.spec.ts:3 (chromium)',
        '      - ui pass — archives signed reports with history, then exports them @call:POST:/api/v1/report/archive @call:POST:/api/v1/report/export @option:signedOnly=true @option:withHistory=true — export.spec.ts:24 (chromium)',
        '    - withHistory=true at output depth: no tests',
        '- tests:',
        '  - ui pass — exports with history @call:POST:/api/v1/report/export @option:withHistory=true — export.spec.ts:3 (chromium)',
        '  - ui fail — exports a package with attachments and without history @call:POST:/api/v1/report/export @option:withAttachments=true @option:withHistory=false — export.spec.ts:10 (chromium)',
        '  - ui pass — exports the selected reports @call:POST:/api/v1/report/export — export.spec.ts:17 (chromium)',
        '  - ui pass — archives signed reports with history, then exports them @call:POST:/api/v1/report/archive @call:POST:/api/v1/report/export @option:signedOnly=true @option:withHistory=true — export.spec.ts:24 (chromium)',
        '  - ui pass — exports signed reports only @call:POST:/api/v1/report/export @option:signedOnly=true @option:withHistory=yes — export.spec.ts:31 (chromium)',
        emptyTests(['@call:POST:/api/v1/report/export @option:withHistory=true', 'call_POST_api_v1_report_export_option_withHistory_true'], ['@call:POST:/api/v1/report/export @option:withHistory=true @depth:output', 'call_POST_api_v1_report_export_option_withHistory_true_depth_output']),
        '',
      ].join('\n'),
    );
    assert.equal(
      section('POST:/api/v1/report/schedule'),
      [
        '',
        '- marks:',
        '  - needs-more, weekly=true (a, 2026-10-01)',
        '- called from: /admin/audit#AdminAudit, /admin/report#AdminReport',
        '- server: on the server (core)',
        '- marked options:',
        '  - weekly — set in the config, not found in the source',
        '    - weekly=true: no tests',
        '- tests: none',
        emptyTests(['@call:POST:/api/v1/report/schedule @option:weekly=true', 'call_POST_api_v1_report_schedule_option_weekly_true']),
        '',
      ].join('\n'),
    );
  });
});

test('an option mark whose option is gone from the map stays out of the task list', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withComments', value: true } }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    assert.equal(cli('tasks'), EXPECTED);
  });
});

test('an API call with an open mark is listed once under API calls with its screens, server match and tests, and a call marked fine is left out', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    addMark(marksDir, { target: { node: 'PUT:/api/v1/document/{documentId}/name' }, status: 'needs-more', note: 'Rename uses the wrong method.', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/archive', depth: 'ui' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    addMark(marksDir, { target: { node: 'GET:/api/v1/member/list' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    addMark(marksDir, { target: { node: 'GET:/api/v1/member/list' }, status: 'fine', author: 'a' }, new Date('2026-10-01T06:00:00Z'));

    const tasks = cli('tasks');
    assert.match(tasks, /^# Test tasks — 4 screens, 3 calls, 0 stories, 7 open marks$/m);
    assert.equal(
      tasks.slice(tasks.indexOf('\n# API calls\n')),
      [
        '',
        '# API calls',
        '',
        '## POST:/api/v1/archive/document',
        '',
        '- marks:',
        '  - needs-more, api depth — "The server has no archive endpoint; check what the archive button gets back." (Kim Min, 2026-09-30)',
        '- called from: /document/:tab#DocumentList, /home#Home',
        '- server: not on the server',
        '- tests: none',
        emptyTests(['@call:POST:/api/v1/archive/document @depth:api', 'call_POST_api_v1_archive_document_depth_api']),
        '',
        '## POST:/api/v1/report/archive',
        '',
        '- marks:',
        '  - needs-more, ui depth (a, 2026-10-01)',
        '- called from: /admin/audit#AdminAudit, /admin/report#AdminReport',
        '- server: on the server (core)',
        '- tests:',
        '  - ui pass — archives signed reports with history, then exports them @call:POST:/api/v1/report/archive @call:POST:/api/v1/report/export @option:signedOnly=true @option:withHistory=true — export.spec.ts:24 (chromium)',
        emptyTests(['@call:POST:/api/v1/report/archive @depth:ui', 'call_POST_api_v1_report_archive_depth_ui']),
        '',
        '## PUT:/api/v1/document/{documentId}/name',
        '',
        '- marks:',
        '  - needs-more, whole call — "Rename uses the wrong method." (a, 2026-10-01)',
        '- called from: /document/:id#DocumentDetail',
        '- server: method mismatch — the server has core POST /api/v1/document/{documentId}/name',
        '- tests:',
        '  - ui fail — rename is refused by the server @call:PUT:/api/v1/document/{documentId}/name — document.spec.ts:4 (chromium)',
        emptyTests(['@call:PUT:/api/v1/document/{documentId}/name', 'call_PUT_api_v1_document_documentId_name']),
        '',
      ].join('\n'),
    );
  });
});

const HELP_UNIT = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'renders the help text' };
const TABLE_UNIT = { source: 'results/vitest/client-unit.json', file: 'components/DocumentTable.spec.js', title: 'DocumentTable › lists the documents it is given' };
const tagging = (tasks: string) => (tasks.includes('\n# Tagging\n') ? tasks.slice(tasks.indexOf('\n# Tagging\n')) : null);

const TAGGING_INTRO = "A reviewer judged that each of these tests checks a screen or API call it carries no tag for. Add the tag where its format reads it (`where`), changing nothing else in the test, then run the test so its result file is written again and run `duru rebuild`, and read this list again: a test that carries the tag counts as a test of that screen or call, and its item leaves this list. The item also leaves, without being done, if the test's file changes or its title changes in any way other than the added tag. duru does not edit test files.";

test('a pair handed over for tagging is listed under Tagging with its test file and line, title, the tag to add, where to write it and the reviewer\'s note', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { judgmentsDir } = loadConfig(configFile);
    addJudgment(judgmentsDir, { test: HELP_UNIT, node: '/help#Help', kind: 'hand-over', reason: 'checks the help text it renders\nand its heading', author: 'reviewer' }, new Date('2026-10-04T01:00:00Z'));
    addJudgment(judgmentsDir, { test: TABLE_UNIT, node: '/home#Home', kind: 'hand-over', author: 'Kim Min' }, new Date('2026-10-04T02:00:00Z'));

    assert.equal(
      tagging(cli('tasks')),
      [
        '',
        '# Tagging',
        '',
        TAGGING_INTRO,
        '',
        '## components/DocumentTable.spec.js:6 → /home#Home',
        '',
        '- title: DocumentTable › lists the documents it is given',
        '- tag to add: `@screen:/home#Home`',
        '- where: at the end of the test\'s own title, not a `describe` title',
        '- note: none (Kim Min, 2026-10-04)',
        '',
        '## components/Help.spec.js:4 → /help#Help',
        '',
        '- title: renders the help text',
        '- tag to add: `@screen:/help#Help`',
        '- where: at the end of the test\'s own title, not a `describe` title',
        '- note: "checks the help text it renders',
        '  and its heading" (reviewer, 2026-10-04)',
        '',
      ].join('\n'),
    );
  });
});

for (const [how, helpTest] of [
  ['in its tags', { tags: ['screen:/help#Help'] }],
  ['at the end of its title', { title: 'renders the help text @screen:/help#Help' }],
] satisfies [string, { tags?: string[]; title?: string }][]) {
  test(`a handed-over test that gets the screen tag ${how} leaves the task list after a rebuild and counts as a tagged test of the screen`, () => {
    withFixtureCopy(({ copy, configFile, cli }) => {
      const config = loadConfig(configFile);
      addJudgment(config.judgmentsDir, { test: HELP_UNIT, node: '/help#Help', kind: 'hand-over', author: 'reviewer' });
      const resultFile = path.join(copy, 'results/vitest/client-unit.json');
      const report = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      Object.assign(report.testResults[0].assertionResults[0], helpTest);
      fs.writeFileSync(resultFile, JSON.stringify(report));
      cli('rebuild');

      assert.equal(tagging(cli('tasks')), null);
      const { tests } = reviewData(config, null);
      assert.deepEqual(tests.awaitingTag, {});
      assert.deepEqual(tests.detachedHandOvers, {});
      assert.deepEqual(tests.nodes['/help#Help'].filter((t: Row) => t.format === 'vitest').map((t: Row) => t.title).sort(), [helpTest.title ?? HELP_UNIT.title, 'searches help @screen:/help#Help']);
      assert.deepEqual(tests.importers['/help#Help'].map((t: Row) => t.title), ['shows the day the help was last updated']);
    });
  });
}

test('undoing a hand-over returns the pair to the tests importing the screen and takes it off the task list', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const config = loadConfig(configFile);
    addJudgment(config.judgmentsDir, { test: HELP_UNIT, node: '/help#Help', kind: 'hand-over', author: 'reviewer' }, new Date('2026-10-04T01:00:00Z'));
    assert.deepEqual(reviewData(config, null).tests.importers['/help#Help'].map((t: Row) => t.title), ['shows the day the help was last updated']);
    addJudgment(config.judgmentsDir, { test: HELP_UNIT, node: '/help#Help', kind: 'undo', author: 'reviewer' }, new Date('2026-10-04T02:00:00Z'));

    assert.equal(tagging(cli('tasks')), null);
    const { tests } = reviewData(config, null);
    assert.deepEqual(tests.importers['/help#Help'].map((t: Row) => t.title), ['renders the help text', 'shows the day the help was last updated']);
    assert.deepEqual(tests.awaitingTag, {});
  });
});

test('the tagging items come in the same order for the same map, results and judgments, whatever order the judgment files were written in', () => {
  const handOvers: [NewJudgment['test'], string][] = [
    [{ ...HELP_UNIT, title: 'shows the day the help was last updated' }, '/help#Help'],
    [HELP_UNIT, '/help#Help'],
    [TABLE_UNIT, '/home#Home'],
    [TABLE_UNIT, '/document/:tab#DocumentList'],
  ];
  const listWith = (order: [NewJudgment['test'], string][]) =>
    withFixtureCopy(({ configFile, cli }) => {
      cli('rebuild');
      const { judgmentsDir } = loadConfig(configFile);
      for (const [test, node] of order) addJudgment(judgmentsDir, { test, node, kind: 'hand-over', author: 'reviewer' }, new Date('2026-10-04T01:00:00Z'));
      return tagging(cli('tasks'));
    });
  const first = listWith(handOvers);
  assert.equal(listWith([...handOvers].reverse()), first);
  assert.deepEqual(first!.match(/^## .*$/gm), [
    '## components/DocumentTable.spec.js:6 → /document/:tab#DocumentList',
    '## components/DocumentTable.spec.js:6 → /home#Home',
    '## components/Help.spec.js:4 → /help#Help',
    '## components/Help.spec.js:8 → /help#Help',
  ]);
});

const handOverEntry = (format: string, ref: Record<string, unknown> & { title: string }, line: number | null, judgment: Record<string, unknown> = {}) => ({
  title: ref.title, line, format, ref: { source: 'results/x.json', ...ref }, judgment: { reason: '', author: 'reviewer', date: '2026-10-04T01:00:00.000Z', ...judgment },
});

test('each test format says where its tag goes, and an API call gets a call tag', () => {
  assert.deepEqual(
    taggingLines({
      '/home#Home': [handOverEntry('playwright', { file: 'e2e/home.spec.ts', title: 'opens home' }, 3)],
      '/help#Help': [handOverEntry('junit', { file: 'com/example/HelpTest.java', title: 'Help service › loads the index' }, null)],
      'GET:/api/v1/help': [handOverEntry('verdict', { file: 'checks/help.log', title: 'help check' }, 13)],
    }, new Set(['GET:/api/v1/help'])),
    [
      '',
      '# Tagging',
      '',
      TAGGING_INTRO,
      '',
      '## checks/help.log:13 → GET:/api/v1/help',
      '',
      '- title: help check',
      '- tag to add: `@call:GET:/api/v1/help`',
      '- where: at the end of its VERDICT line',
      '- note: none (reviewer, 2026-10-04)',
      '',
      '## com/example/HelpTest.java → /help#Help',
      '',
      '- title: Help service › loads the index',
      '- tag to add: `@screen:/help#Help`',
      '- where: at the end of the test\'s `@DisplayName`',
      '- note: none (reviewer, 2026-10-04)',
      '',
      '## e2e/home.spec.ts:3 → /home#Home',
      '',
      '- title: opens home',
      '- tag to add: `@screen:/home#Home`',
      "- where: in the test's `tag` option (`{ tag: '@screen:/home#Home' }`), leaving the title as it is",
      '- note: none (reviewer, 2026-10-04)',
    ],
  );
});

test('a browser test handed over for a screen it opened and for a call it sent is listed under Tagging with the screen tag and the call tag', () => {
  const tests = [...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')).tests, { format: 'playwright', path: 'results/playwright-traced', depth: 'ui' }];
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { judgmentsDir } = loadConfig(configFile);
    const sent = { source: 'results/playwright-traced/calls.json', file: 'calls.spec.ts', title: 'reads a document from the server' };
    addJudgment(judgmentsDir, { test: sent, node: '/home#Home', kind: 'hand-over', reason: 'checks the list on home', author: 'reviewer' }, new Date('2026-10-04T01:00:00Z'));
    addJudgment(judgmentsDir, { test: sent, node: 'GET:/api/v1/document/{documentId}', kind: 'hand-over', author: 'reviewer' }, new Date('2026-10-04T01:00:00Z'));
    assert.deepEqual(tagging(cli('tasks'))!.split('\n').slice(4), [
      '',
      '## calls.spec.ts:6 → /home#Home',
      '',
      '- title: reads a document from the server',
      '- tag to add: `@screen:/home#Home`',
      "- where: in the test's `tag` option (`{ tag: '@screen:/home#Home' }`), leaving the title as it is",
      '- note: "checks the list on home" (reviewer, 2026-10-04)',
      '',
      '## calls.spec.ts:6 → GET:/api/v1/document/{documentId}',
      '',
      '- title: reads a document from the server',
      '- tag to add: `@call:GET:/api/v1/document/{documentId}`',
      "- where: in the test's `tag` option (`{ tag: '@call:GET:/api/v1/document/{documentId}' }`), leaving the title as it is",
      '- note: none (reviewer, 2026-10-04)',
      '',
    ]);
  }, { tests });
});

test('a browser test handed over for a screen stays under Tagging when its latest run left no trace to see the screen in', () => {
  const tests = [...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')).tests, { format: 'playwright', path: 'results/playwright-traced', depth: 'ui' }];
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const untraced = { source: 'results/playwright-traced/visits.json', file: 'untraced.spec.ts', title: 'opens help without a trace' };
    addJudgment(loadConfig(configFile).judgmentsDir, { test: untraced, node: '/help#Help', kind: 'hand-over', author: 'reviewer' }, new Date('2026-10-04T01:00:00Z'));
    assert.deepEqual(tagging(cli('tasks'))!.match(/^## .*$/gm), ['## untraced.spec.ts:5 → /help#Help']);
    assert.match(cli('rebuild'), /^pairs handed over for tagging waiting for the tag 1 \| .* 0$/m);
  }, { tests });
});

test('the reviewer\'s note is printed trimmed, and a note of only whitespace counts as none', () => {
  const lines = (reason: string) => taggingLines({ '/help#Help': [handOverEntry('vitest', HELP_UNIT, 4, { reason })] }, new Set()).find((l) => l.startsWith('- note'));
  assert.equal(lines('  \n checks the text\nand the heading \n'), '- note: "checks the text\n  and the heading" (reviewer, 2026-10-04)');
  assert.equal(lines(' \n '), '- note: none (reviewer, 2026-10-04)');
});

test('a note saved with surrounding whitespace is trimmed in the task list', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    addJudgment(loadConfig(configFile).judgmentsDir, { test: HELP_UNIT, node: '/help#Help', kind: 'hand-over', reason: '\n  checks the help text  \n', author: 'reviewer' }, new Date('2026-10-04T01:00:00Z'));
    assert.match(tagging(cli('tasks'))!, /^- note: "checks the help text" \(reviewer, 2026-10-04\)$/m);
  });
});

test('a mark\'s note is printed trimmed, and a mark whose note is only whitespace is printed without one', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    addMark(marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: '\n  checks the start\nand the end  \n', author: 'a' }, new Date('2026-10-03T05:00:00Z'));
    addMark(marksDir, { target: { node: '/admin/report#AdminReport' }, status: 'missing', note: ' \n ', author: 'a' }, new Date('2026-10-04T05:00:00Z'));
    const tasks = cli('tasks');
    assert.match(tasks, /^ {2}- needs-more, whole screen — "checks the start\n {4}and the end" \(a, 2026-10-03\)$/m);
    assert.match(tasks, /^ {2}- needs-more, whole screen \(a, 2026-10-04\)$/m);
  });
});
