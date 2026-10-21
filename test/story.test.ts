import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');

function withCopy<T>(fn: (run: (...args: string[]) => SpawnSyncReturns<string>, copy: string) => T, patch: Record<string, unknown> = {}): T {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-story-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), marksDir: 'example-marks', storiesDir: 'example-stories', ...patch }));
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, args[0], configFile, ...args.slice(1)], { encoding: 'utf8' });
    return fn(run, copy);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const section = (text: string, id: string) => text.split(`\n## ${id}\n`)[1];

test('a story no reviewer marked is printed with a line for each step to open and to check arrival, what to press, the lines a person wrote with the code that fills each input, the reasons and the empty tests', () => {
  withCopy((run) => {
    assert.equal(run('rebuild').status, 0);
    const res = run('story', 'report-detour');
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    assert.match(res.stdout, /^# Story report-detour\n/);
    const story = section(res.stdout, 'report-detour');
    assert.doesNotMatch(story, /- marks:/);
    assert.equal(story.slice(story.indexOf('- screens:'), story.indexOf('    - link from')), [
      '- screens:',
      '  1. /admin/report#AdminReport — no tests',
      '     - open: http://localhost:3000/admin/report',
      '     - arrives: `await expect(page).toHaveURL(/^[a-z]+:\\/\\/[^\\/]+\\/admin\\/report\\/?(?:[?#].*)?$/i);`',
      '     - need: 관리자 계정 (needs/admin-account.json): 역할 ADMIN 으로 가입한 계정이 있다',
      '     - to /home#Home: no link',
      '  2. /home#Home — tests: ui pass 3, api pass 1, api pending 1, render fail 1, code pass 1, data fail 1',
      '     - arrives: `await expect(page).toHaveURL(/^[a-z]+:\\/\\/[^\\/]+\\/home\\/?(?:[?#].*)?$/i);`',
      '     - input: placeholder "문서 검색" → "분기 보고" (not checked against the code)',
      '       - fill: `await page.getByPlaceholder("문서 검색", { exact: true }).fill("분기 보고");` (duru did not try it on the screen)',
      '     - to /document/:id#DocumentDetail: open at components/DocumentTable.js:13',
      '       - what to press: duru does not know',
      '  3. /document/:id#DocumentDetail — tests: ui pass 1, api pass 3, api fail 3, data pending 2, data pass 2',
      '     - arrives: `await expect(page).toHaveURL(/^[a-z]+:\\/\\/[^\\/]+\\/document\\/(?:[^\\/?#]+?)\\/?(?:[?#].*)?$/i);`',
      '     - expect: 문서 제목이 보인다',
      '     - to /admin/report#AdminReport: conditioned at components/SideMenu.js:11',
      '       - what to press: duru does not know',
      '  4. /admin/report#AdminReport — no tests',
      '     - arrives: `await expect(page).toHaveURL(/^[a-z]+:\\/\\/[^\\/]+\\/admin\\/report\\/?(?:[?#].*)?$/i);`',
      '- expects at the end:',
      '  - 보고서 화면이 열린다',
      '- reach: unreachable, no link at 1 step',
      '- preconditions:',
      '  - accounts: no app.roles in the config',
      '  - /admin/report#AdminReport, the first screen, needs a role and a setting; roles that open it: ADMIN, OWNER',
    ].join('\n') + '\n');
    assert.match(story, /^ {4}- link from \/home#Home at components\/SideMenu\.js:11, guard /m);
    assert.match(story, /^ {4}- role ADMIN or OWNER$/m);
    assert.equal(story.split('no app.roles in the config').length, 2);
    assert.match(story, /^- empty tests:\n {2}- playwright: `test\.fixme\("<what it checks>", \{ tag: \["@story:report-detour", "@screen:\/admin\/report#AdminReport", "@screen:\/home#Home", "@screen:\/document\/:id#DocumentDetail"\] \}, async \(\{ page \}\) => \{\}\);`$/m);
  }, { appUrl: 'http://localhost:3000', storiesDir: 'brief-stories' });
});

test('the fill line finds the box by every word written for it, in the order placeholder, label, test ID whatever order the story file has, takes the Nth from 0, and puts the value in a longer code span when the code has a backtick', () => {
  withCopy((run, copy) => {
    const file = path.join(copy, 'example-stories/signin-inputs.json');
    const inputs = [
      { box: { testId: 'login-email', label: '이메일', placeholder: '이메일 주소' }, value: 'a@b.c' },
      { box: { label: '서명자 "메모"', nth: 2 }, value: '`확인`\n끝' },
      { box: { testId: ' pad ' }, value: 'x' },
    ];
    fs.writeFileSync(file, JSON.stringify({ name: 'n', screens: [{ screen: '/signin#SignIn', inputs }], author: 'a', date: '2026-10-03' }));
    run('rebuild');
    const story = section(run('story', 'signin-inputs').stdout, 'signin-inputs');
    assert.deepEqual(story.split('\n').filter((l) => l.startsWith('     - input') || l.startsWith('       - fill')), [
      '     - input: placeholder "이메일 주소" and label "이메일" and testId "login-email" → "a@b.c" (not checked against the code)',
      '       - fill: `await page.getByPlaceholder("이메일 주소", { exact: true }).and(page.getByLabel("이메일", { exact: true })).and(page.getByTestId("login-email")).fill("a@b.c");` (duru did not try it on the screen)',
      '     - input: label "서명자 \\"메모\\"", number 2 → "`확인`\\n끝" (not checked against the code)',
      '       - fill: ``await page.getByLabel("서명자 \\"메모\\"", { exact: true }).nth(1).fill("`확인`\\n끝");`` (duru did not try it on the screen)',
      '     - input: testId " pad " → "x" (not checked against the code)',
      '       - fill: `await page.getByTestId(" pad ").fill("x");` (duru did not try it on the screen)',
    ]);
    fs.writeFileSync(file, JSON.stringify({ name: 'n', screens: [{ screen: '/signin#SignIn', inputs: [{ box: { placeholder: '이메일 주소', testId: 'login-email', label: '이메일' }, value: 'a@b.c' }] }], author: 'a', date: '2026-10-03' }));
    run('rebuild');
    assert.match(run('story', 'signin-inputs').stdout, /^ {7}- fill: `await page\.getByPlaceholder\("이메일 주소", \{ exact: true \}\)\.and\(page\.getByLabel\("이메일", \{ exact: true \}\)\)\.and\(page\.getByTestId\("login-email"\)\)\.fill\("a@b\.c"\);`/m);
  });
});

test('the intro of one story says what the fill line is and what to do when it finds no box', () => {
  withCopy((run) => {
    run('rebuild');
    assert.match(run('story', 'report-detour').stdout, /A `fill` line under an `input` line is Playwright code that finds the box with every word written for it, each matched exactly, takes the Nth of those boxes when the input has a number, and puts the value in; duru did not try it on the screen, so when it finds no box, try each word alone/);
  }, { storiesDir: 'brief-stories' });
});

test('the story part is the story part of the task list, apart from the marks', () => {
  withCopy((run) => {
    run('rebuild');
    const brief = section(run('story', 'run-lab').stdout, 'run-lab');
    const tasks = run('tasks').stdout;
    assert.equal(tasks.includes('\n## run-lab\n'), true);
    const first = brief.split('\n').filter((l) => l.startsWith('- status:') || l.startsWith('- story tests:') || l.startsWith('- reach:'));
    for (const line of first) assert.equal(tasks.includes(`\n${line}\n`), true, line);
  });
});

test('a screen whose route path was not read gets the reason in place of the arrival line, and a first step without appUrl is opened by its route path', () => {
  withCopy((run, copy) => {
    run('rebuild');
    const mapFile = path.join(copy, 'out/map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    map.screens.find((s: any) => s.id === '/home#Home').path = '/home/{?}';
    fs.writeFileSync(mapFile, JSON.stringify(map));
    const story = section(run('story', 'change-settings').stdout, 'change-settings');
    assert.match(story, /^ {5}- arrives: not written, the route path was not read at Routes\.js:\d+$/m);
    assert.match(story, /^ {5}- open: \/home\/\{\?\}$/m);
    assert.match(story, /^ {5}- arrives: none, the screen is not on the map$/m);
  });
});

test('a story ID that is not there, a story file that cannot be read and a map from an older duru end with 1 and one line on standard error, and nothing on standard output', () => {
  withCopy((run, copy) => {
    run('rebuild');
    fs.writeFileSync(path.join(copy, 'example-stories/bad.json'), '{');
    const missing = run('story', 'nope');
    assert.deepEqual([missing.status, missing.stdout, missing.stderr], [1, '', 'no story nope in example-stories\n']);
    const bad = run('story', 'bad');
    assert.deepEqual([bad.status, bad.stdout, bad.stderr], [1, '', 'story bad could not be read; `duru rebuild` prints why\n']);
    const mapFile = path.join(copy, 'out/map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) delete s.routeFile;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    const old = run('story', 'run-lab');
    assert.equal(old.status, 1);
    assert.equal(old.stdout, '');
    assert.match(old.stderr, /^.*run "duru rebuild"\n$/);
  });
});

test('a call without a story ID, or with two, ends with 2', () => {
  withCopy((run) => {
    for (const args of [['story'], ['story', 'a', 'b']]) {
      const res = run(...args);
      assert.equal(res.status, 2);
      assert.equal(res.stdout, '');
    }
  });
});

const arrivalOf = (stdout: string, step: number) => {
  const line = stdout.split('\n').filter((l) => l.startsWith('     - arrives:'))[step];
  return new Function(`return ${line.match(/toHaveURL\((\/.*\/i)\)/)![1]}`)() as RegExp;
};

const HOME_OK = ['/home', '/home/', '/home?x=1', '/home/?tab=1', '/home#a'];
const HOME_NO = ['/admin/home', '/login?next=/home', '/home/x'];

test('the arrival line is a regular expression on the whole address that takes a trailing slash, a query or a hash and nothing else', () => {
  withCopy((run) => {
    run('rebuild');
    const out = run('story', 'change-settings').stdout;
    assert.match(out, /toHaveURL\(\/\^\[a-z\]\+:/);
    const home = arrivalOf(out, 0);
    for (const ok of HOME_OK) assert.equal(home.test(`http://localhost:3000${ok}`), true, ok);
    for (const no of HOME_NO) assert.equal(home.test(`http://localhost:3000${no}`), false, no);
  });
});

test('the arrival line puts the path and hash of appUrl after the origin, whether it ends with a slash or not', () => {
  for (const [appUrl, prefix] of [['http://localhost:3000/app/', '/app'], ['http://localhost:3000/#', '/#'], ['http://localhost:3000/#/', '/#']]) {
    withCopy((run) => {
      run('rebuild');
      const home = arrivalOf(run('story', 'change-settings').stdout, 0);
      for (const ok of HOME_OK) assert.equal(home.test(`http://localhost:3000${prefix}${ok}`), true, `${appUrl} ${ok}`);
      for (const no of HOME_NO) assert.equal(home.test(`http://localhost:3000${prefix}${no}`), false, `${appUrl} ${no}`);
      assert.equal(home.test('http://localhost:3000/home'), false, appUrl);
    }, { appUrl });
  }
});

test('an appUrl that is not an http address gives no base and does not stop the command', () => {
  for (const appUrl of ['/app', 'localhost:3000']) {
    withCopy((run) => {
      run('rebuild');
      const res = run('story', 'change-settings');
      assert.equal(res.status, 0, appUrl);
      const home = arrivalOf(res.stdout, 0);
      assert.equal(home.test('http://localhost:3000/home'), true, appUrl);
      assert.equal(home.test('http://localhost:3000/app/home'), false, appUrl);
    }, { appUrl });
  }
});

test('a link joined by a move in the config gets no line about what to press, and the intro says so', () => {
  withCopy((run, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/signin-lab.json'), JSON.stringify({ name: 'n', screens: ['/signin#SignIn', '/lab/result#LabResult'], author: 'a', date: '2026-10-03' }));
    run('rebuild');
    const out = run('story', 'signin-lab').stdout;
    const story = section(out, 'signin-lab');
    assert.match(story, /^ {5}- to \/lab\/result#LabResult: a move in the config \(로그인 뒤\)\n(?! {7}- what to press)/m);
    assert.match(out, /appears only under a link that exists in the source/);
  }, { moves: [{ from: '/signin', to: '/lab/result', reason: '로그인 뒤' }] });
});

test('a route variable in the arrival line does not take a query or a hash for its value', () => {
  withCopy((run) => {
    run('rebuild');
    const out = run('story', 'open-document').stdout;
    const detail = arrivalOf(out, 3);
    for (const ok of ['/document/7', '/document/7?tab=1', '/document/7#top']) assert.equal(detail.test(`http://localhost:3000${ok}`), true, ok);
    for (const no of ['/document/?tab=1', '/document/#top', '/document/']) assert.equal(detail.test(`http://localhost:3000${no}`), false, no);
  });
});

const REPORT_DETOUR = { appUrl: 'http://localhost:3000', storiesDir: 'brief-stories' };
const ADMIN_PASSWORD_ENV = 'DURU_TEST_ADMIN_PASSWORD';
const APP = {
  files: 'build',
  server: 'http://127.0.0.1:1',
  apiPaths: ['/api/'],
  login: { path: '/auth/login', body: { loginId: '{id}', pw: '{password}' }, token: 'result.token', storage: { key: 'FAKE_AUTH', value: { accessToken: '{token}' } } },
  account: { id: 'duru-admin', passwordEnv: 'DURU_TEST_APP_PASSWORD' },
  roles: { ADMIN: { id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV } },
};
const SETTINGS_FILE = { path: '/settings.js', global: 'window.FAKE_SETTINGS', root: 'globalSettings', merged: ['SYSTEM', 'CUSTOM'] };
const WITH_ROLES = { ...REPORT_DETOUR, app: APP };
const WITH_SETTINGS_FILE = { ...REPORT_DETOUR, app: { ...APP, settingsFile: SETTINGS_FILE } };
const LINK_HEAD = "  - link /document/:id#DocumentDetail → /admin/report#AdminReport at components/SideMenu.js:11, guard `globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST includes 'ADMIN_REPORT'` (setting); `['ADMIN', 'OWNER'].indexOf(session['member.role']) > -1` (role); `MENUS.ADMIN` (setting)";
const ACCOUNTS = 'ADMIN duru-boss, password in DURU_TEST_ADMIN_PASSWORD; OWNER no account in app.roles';
const preconditions = (stdout: string) => section(stdout, 'report-detour').split('- preconditions:\n')[1].split('\n- empty tests:')[0];
const linkLines = (stdout: string) => {
  const lines = preconditions(stdout).split('\n');
  const at = lines.indexOf(LINK_HEAD);
  assert.notEqual(at, -1, preconditions(stdout));
  const end = lines.findIndex((l, i) => i > at && l.startsWith('  - '));
  return lines.slice(at + 1, end < 0 ? undefined : end).filter(Boolean);
};

function withPasswordSet<T>(fn: () => T) {
  process.env[ADMIN_PASSWORD_ENV] = 'pw-never-printed';
  try {
    return fn();
  } finally {
    delete process.env[ADMIN_PASSWORD_ENV];
  }
}

test('under a link between steps, a role gets the account of each role that passes with the variable holding its password, and each setting whether it is met with no change, judged against the settings file; no password is printed', () => {
  withPasswordSet(() => withCopy((run) => {
    assert.equal(run('rebuild').status, 0);
    const res = run('story', 'report-detour');
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /pw-never-printed/);
    assert.match(res.stdout, /duru never prints a password, and you pick the account/);
    assert.deepEqual(linkLines(res.stdout), [
      '    - setting SYSTEM.MAIN_MENU.ADMIN.LIST includes "ADMIN_REPORT": met with no change (checked against build/settings.js)',
      `    - role ADMIN or OWNER: ${ACCOUNTS}`,
      '    - setting SYSTEM.MAIN_MENU.ADMIN present: met with no change (checked against build/settings.js)',
      '    - judged without links to a path duru cannot read: components/SideMenu.js:19 `{?}`',
    ]);
    assert.match(preconditions(res.stdout), new RegExp(`^ {2}- /admin/report#AdminReport, the first screen, [^\\n]*\\n {4}- accounts: ${ACCOUNTS}\\n`));
  }, WITH_SETTINGS_FILE));
});

test('a setting not met names the value to put, and without a settings file that runs it is judged on the source default and says why the deployed settings were not checked', () => {
  withCopy((run, copy) => {
    run('rebuild');
    const settingsFile = path.join(copy, 'build/settings.js');
    fs.writeFileSync(settingsFile, "window.FAKE_SETTINGS = { SYSTEM: { MAIN_MENU: { ADMIN: null } } };\n");
    assert.deepEqual(linkLines(run('story', 'report-detour').stdout).filter((l) => l.includes('setting')), [
      '    - setting SYSTEM.MAIN_MENU.ADMIN.LIST includes "ADMIN_REPORT": not met with no change; put "ADMIN_REPORT" in the list (checked against build/settings.js)',
      '    - setting SYSTEM.MAIN_MENU.ADMIN present: not met with no change; duru does not know which value to put (checked against build/settings.js)',
    ]);
    fs.writeFileSync(settingsFile, "throw new Error('boom');\n");
    assert.match(linkLines(run('story', 'report-detour').stdout)[0], /: met with no change \(source default; deployed settings not checked, build\/settings\.js could not be run: boom\)$/);
    fs.rmSync(settingsFile);
    assert.match(linkLines(run('story', 'report-detour').stdout)[0], /: met with no change \(source default; deployed settings not checked, build\/settings\.js not found\)$/);
  }, WITH_SETTINGS_FILE);
  withCopy((run) => {
    run('rebuild');
    assert.match(linkLines(run('story', 'report-detour').stdout)[0], /: met with no change \(source default; deployed settings not checked\)$/);
  }, WITH_ROLES);
});

test('a setting under a default the source does not show in full is not known to be met, and still names the value to put', () => {
  withCopy((run, copy) => {
    const defaults = path.join(copy, 'client/src/store/settings.js');
    fs.writeFileSync(defaults, fs.readFileSync(defaults, 'utf8').replace("ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },", "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },\n      USER: window.INTO_USER_MENU || {},"));
    run('rebuild');
    assert.deepEqual(linkLines(run('story', 'report-detour').stdout).filter((l) => l.includes('setting')), [
      '    - setting SYSTEM.MAIN_MENU.ADMIN.LIST includes "ADMIN_REPORT": not known, its default was not read in full; put "ADMIN_REPORT" in the list (source default; deployed settings not checked)',
      '    - setting SYSTEM.MAIN_MENU.ADMIN present: not known, its default was not read in full; duru does not know which value to put (source default; deployed settings not checked)',
    ]);
  }, WITH_ROLES);
});

test('a route guard on a step gets the same lines, and a role the first screen line already gives accounts for is not given them again', () => {
  withCopy((run, copy) => {
    const routes = path.join(copy, 'client/src/Routes.js');
    fs.writeFileSync(routes, fs.readFileSync(routes, 'utf8').replace('<Route path={Option.ROUTE_PATH.ADMIN_REPORT} component={AdminReport} exact />',
      "{memberRole === 'ADMIN' && globalSettings.SYSTEM.LAB_ENABLED ? <Route path={Option.ROUTE_PATH.ADMIN_REPORT} component={AdminReport} exact /> : null}"));
    run('rebuild');
    const out = preconditions(run('story', 'report-detour').stdout);
    const route = out.split('\n').filter((l) => l.startsWith('  - /admin/report#AdminReport route at'));
    assert.equal(route.length, 2, out);
    const under = out.split(`${route[0]}\n`)[1].split('\n  - ')[0].split('\n');
    assert.deepEqual(under, [
      '    - role ADMIN: the accounts are on the first screen line',
      '    - setting SYSTEM.LAB_ENABLED on: not met with no change (false); set it to true (source default; deployed settings not checked)',
    ]);
    assert.equal(out.match(/duru-boss/g)!.length, 2, out);
  }, WITH_ROLES);
});

test('a setting guard duru could not read says why in English, and a guard that is neither a role nor a setting gets no line of its own', () => {
  withCopy((run, copy) => {
    const menu = path.join(copy, 'client/src/components/SideMenu.js');
    fs.writeFileSync(menu, fs.readFileSync(menu, 'utf8').replace('  if (MENUS.ADMIN) {', '  if (session.ready) if (MENUS.ADMIN !== false) {'));
    run('rebuild');
    const out = run('story', 'report-detour').stdout;
    const head = preconditions(out).split('\n').find((l) => l.startsWith('  - link /document/:id#DocumentDetail'))!;
    assert.match(head, /`session\.ready`(?! \()/);
    const lines = preconditions(out).split(`${head}\n`)[1].split('\n  - ')[0].split('\n').filter(Boolean);
    assert.deepEqual(lines, [
      '    - setting SYSTEM.MAIN_MENU.ADMIN.LIST includes "ADMIN_REPORT": met with no change (source default; deployed settings not checked)',
      `    - role ADMIN or OWNER: ${ACCOUNTS}`,
      '    - setting not read: it checks that a value is not equal to another, so no one value meets it',
      '    - judged without links to a path duru cannot read: components/SideMenu.js:19 `{?}`',
    ]);
  }, WITH_ROLES);
});

test('a link with several ways gets the lines under each way', () => {
  withCopy((run, copy) => {
    const menu = path.join(copy, 'client/src/components/SideMenu.js');
    fs.writeFileSync(menu, fs.readFileSync(menu, 'utf8').replace('    <nav>\n', '    <nav>\n      {globalSettings.SYSTEM.LAB_ENABLED && <Link to={Option.ROUTE_PATH.ADMIN_REPORT}>Report</Link>}\n'));
    run('rebuild');
    const out = preconditions(run('story', 'report-detour').stdout);
    const at = out.indexOf('  - link /document/:id#DocumentDetail → /admin/report#AdminReport, one of 2:\n');
    assert.notEqual(at, -1, out);
    const ways = out.slice(at).split('\n').slice(1).filter((l) => l.startsWith('    '));
    assert.deepEqual(ways.map((l) => l.replace(/, guard .*/, '')), [
      '    - at components/SideMenu.js:11',
      '      - setting SYSTEM.MAIN_MENU.ADMIN.LIST includes "ADMIN_REPORT": met with no change (source default; deployed settings not checked)',
      `      - role ADMIN or OWNER: ${ACCOUNTS}`,
      '      - setting SYSTEM.MAIN_MENU.ADMIN present: met with no change (source default; deployed settings not checked)',
      '    - at components/SideMenu.js:18',
      '      - setting SYSTEM.LAB_ENABLED on: not met with no change (false); set it to true (source default; deployed settings not checked)',
      '    - judged without links to a path duru cannot read: components/SideMenu.js:20 `{?}`',
    ]);
  }, WITH_ROLES);
});

test('the user guide says what the account and setting lines under the preconditions of one story mean, and the decision record says why the setting changes are worked out on the server', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
  assert.match(read('../README.md'), /## One story[\s\S]*`tasks` does not print these lines[\s\S]*the password is never printed[\s\S]*`source default; deployed settings not checked`[\s\S]*`setting not read:`/);
  assert.match(read('../docs/decisions.md'), /\*\*The setting changes the review page's settings bar shows and the `setting` lines of `duru story` are worked out in one server module[\s\S]*Alternatives compared:\n- The page runs the same function, pasted into it/);
});
