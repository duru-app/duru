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

test('a story no reviewer marked is printed with a line for each step to open and to check arrival, what to press, the lines a person wrote, the reasons and the empty tests', () => {
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
      '  - /admin/report#AdminReport, the first screen, needs a role and a setting; roles that open it: ADMIN, OWNER',
    ].join('\n') + '\n');
    assert.match(story, /^ {4}- link from \/home#Home at components\/SideMenu\.js:11, guard /m);
    assert.match(story, /^- empty tests:\n {2}- playwright: `test\.fixme\("<what it checks>", \{ tag: \["@story:report-detour", "@screen:\/admin\/report#AdminReport", "@screen:\/home#Home", "@screen:\/document\/:id#DocumentDetail"\] \}, async \(\{ page \}\) => \{\}\);`$/m);
  }, { appUrl: 'http://localhost:3000', storiesDir: 'brief-stories' });
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
