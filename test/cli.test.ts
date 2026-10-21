import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { addJudgment } from '../src/judgments.ts';
import { addMark, fileSafe, loadMarks, recordName } from '../src/marks.ts';
import type { Mark } from '../src/marks.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');

type Failure = Error & { status: number | null; stderr: string };
type HandOver = { node: string; title: string; file?: string | null };

test('rebuild writes map.json and tests.json to the configured output folder and prints a summary', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });

    const map = JSON.parse(fs.readFileSync(path.join(copy, 'out/map.json'), 'utf8'));
    const links = JSON.parse(fs.readFileSync(path.join(copy, 'out/tests.json'), 'utf8'));
    assert.equal(map.screens.length, 11);
    assert.deepEqual(Object.keys(links.nodes).sort(), [
      '/admin/member#AdminMember',
      '/document/:id#DocumentDetail',
      '/document/:tab#DocumentList',
      '/help#Help',
      '/home#Home',
      '/lab#Lab',
      '/signin#SignIn',
      'POST:/api/v1/report/archive',
      'POST:/api/v1/report/export',
      'PUT:/api/v1/document/{documentId}/name',
    ]);
    assert.match(stdout, /^screens 11 \|/m);
    assert.match(stdout, /^calls 10 \| dead screens 2$/m);
    assert.match(stdout, /^screens with tests 7\/11 \| tags pointing outside the map 13 \| tests without a node or story tag 13$/m);
    assert.match(stdout, /^links from unit tests to screens by the files they import 5 \| test files not read 2$/m);
    assert.match(stdout, /^calls with tests 3\/10$/m);
    assert.doesNotMatch(stdout, /bodyOptions/);
    assert.doesNotMatch(stdout, /roleGuards/);
    assert.doesNotMatch(stdout, /^case kind /m);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('rebuild prints for each case kind with rules how many screens and calls they pick and names each rule that picks nothing', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const ended = { text: '끝난 문서', picks: [{ screen: '/admin/*' }, { screen: '/document/**', methods: ['POST', 'PUT'] }, { screen: '/participant/**' }, { api: '/api/v2/**' }] };
    fs.writeFileSync(configFile, JSON.stringify({ ...config, caseKinds: { boundary: '경계', ended, legacy: { text: '옛 데이터', picks: [{ screen: '/help' }] } } }));
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.deepEqual(stdout.split('\n').filter((l) => /^(case kind \S+: rules |  caseKinds )/.test(l)), [
      'case kind ended: rules pick 4 screens, 2 calls',
      '  caseKinds ended picks[2] matches no screen: {"screen":"/participant/**"}',
      '  caseKinds ended picks[3] matches no call: {"api":"/api/v2/**"}',
      'case kind legacy: rules pick 1 screen, 0 calls',
    ]);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

const ENDED_KINDS = { ended: { text: '끝난 문서', values: ['cancelled', 'rejected'], picks: [{ screen: '/document/**', methods: ['POST', 'PUT'] }] }, legacy: '옛 데이터' };
const ENDED_WRITES = ['POST:/api/v1/auth/sign-in', 'POST:/api/v1/report/archive', 'POST:/api/v1/report/export', 'POST:/api/v1/report/schedule'];
const ENDED_READS = ['GET:/api/v1/document/list', 'GET:/api/v1/document/{documentId}', 'GET:/api/v1/lab/experiment', 'GET:/api/v1/member/list'];

const runCli = (configFile: string, command: string, ...args: string[]) => {
  try {
    return { status: 0 as number | null, stdout: execFileSync(process.execPath, [CLI, command, configFile, ...args], { encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
  } catch (err) {
    const { status, stdout, stderr } = err as Failure & { stdout: string };
    return { status, stdout, stderr };
  }
};

function withCaseKinds(fn: (configFile: string, run: (...args: string[]) => { status: number | null; stdout: string; stderr: string }) => void) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), marksDir: 'case-marks', caseKinds: ENDED_KINDS }));
    fn(configFile, ((command: string, ...args: string[]) => runCli(configFile, command, ...args)) as never);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const caseMarks = (configFile: string) => {
  const dir = path.join(path.dirname(configFile), 'case-marks');
  return fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Mark) : [];
};

test('undecided says in one line that there is no map before a rebuild and exits with 1, then lists each undecided candidate, writes first, and exits with 3 while any is left and with 0 once none is; a kind not in the config exits with 2', () => {
  withCaseKinds((configFile, run) => {
    const before = run('undecided');
    assert.equal(before.status, 1);
    assert.equal(before.stderr, `${path.join(path.dirname(configFile), 'out', 'map.json')} does not exist — run "duru rebuild" first\n`);
    run('rebuild');
    const ended = run('undecided', 'ended');
    assert.equal(ended.status, 3);
    assert.deepEqual(ended.stdout.split('\n').filter(Boolean).map((l) => l.split(' — ')[0]), ['case kind ended: 8 undecided', ...[...ENDED_WRITES, ...ENDED_READS].map((id) => `  ${id}`)]);
    assert.match(run('undecided').stdout, /\ncase kind legacy: 21 undecided\n {2}POST:/);
    assert.equal(run('undecided', 'gone').status, 2);
    for (const id of ENDED_READS) assert.equal(run('case', 'ended', id, 'needed').status, 0);
    for (const id of ENDED_WRITES) addMark(path.join(path.dirname(configFile), 'case-marks'), { target: { node: id, case: 'ended' }, status: 'not-needed', note: '문서를 바꾸지 않는다', author: 'Kim Min' });
    assert.deepEqual(run('undecided', 'ended'), { status: 0, stdout: 'case kind ended: 0 undecided\n', stderr: '' });
    assert.equal(run('undecided').status, 3);
  });
});

test('case writes a mark file the review reads, by agent unless --author names someone, with a field saying the command wrote it, and the rule it takes a target out of', () => {
  withCaseKinds((configFile, run) => {
    run('rebuild');
    assert.deepEqual(run('case', 'ended', 'PUT:/api/v1/document/{documentId}/name', 'not-needed', '--note', '이름은 막지 않는다'), { status: 0, stdout: '', stderr: '' });
    assert.equal(run('case', 'legacy', '/lab#Lab', 'needed', '--author', 'QA 에이전트', '--note', '옛 실험 데이터가 있다').status, 0);
    const marks = caseMarks(configFile).map(({ target, status, note, rule, author, via }) => ({ target, status, note, rule, author, via }));
    assert.deepEqual(marks.sort((a, b) => a.target!.node!.localeCompare(b.target!.node!)), [
      { target: { node: '/lab#Lab', case: 'legacy' }, status: 'needed', note: '옛 실험 데이터가 있다', rule: undefined, author: 'QA 에이전트', via: 'duru case' },
      { target: { node: 'PUT:/api/v1/document/{documentId}/name', case: 'ended' }, status: 'not-needed', note: '이름은 막지 않는다', rule: { index: 0, pick: ENDED_KINDS.ended.picks[0] }, author: 'agent', via: 'duru case' },
    ]);
  });
});

const personsCaseMark = (configFile: string) => addMark(path.join(path.dirname(configFile), 'case-marks'), { target: { node: '/home#Home', case: 'legacy' }, status: 'needed', author: 'Kim Min' }, new Date('2026-10-05T01:00:00Z'));
const CASE_REFUSALS: [string[], string][] = [
  [['gone', '/home#Home', 'needed'], '"gone" is not a kind in caseKinds (it has ended, legacy)\n'],
  [['ended', '/nowhere#Nowhere', 'needed'], '/nowhere#Nowhere is no screen or call on the map\n'],
  [['legacy', '/lab#Lab', 'not-needed'], 'not-needed needs a note saying why legacy need not be tested on /lab#Lab\n'],
  [['ended', 'POST:/api/v1/archive/document', 'not-needed'], 'a rule picks POST:/api/v1/archive/document for ended (caseKinds.ended.picks[0]), so taking it out needs a note saying why\n'],
  [['legacy', '/home#Home', 'needed', '--note', '홈은 옛 데이터를 읽는다'], 'Kim Min marked legacy needed on /home#Home on 2026-10-05, and duru case does not change a person\'s mark\n'],
];

test('case refuses with a reason and exits with 1 a kind not in the config, an ID not on the map, not-needed without a note and a person\'s mark, writing nothing; a call it cannot read exits with 2', () => {
  withCaseKinds((configFile, run) => {
    run('rebuild');
    personsCaseMark(configFile);
    for (const [args, stderr] of CASE_REFUSALS) assert.deepEqual(run('case', ...args), { status: 1, stdout: '', stderr }, args.join(' '));
    assert.equal(caseMarks(configFile).length, 1);
    for (const args of [['ended', '/lab#Lab'], ['ended', '/lab#Lab', 'maybe'], ['ended', '/lab#Lab', 'needed', '--note'], ['ended', '/lab#Lab', 'needed', '--why', 'x'], ['ended', '/lab#Lab', 'needed', '--note', 'a', '--note', 'b'], ['ended', '/lab#Lab', 'needed', '--server'], ['ended', '/lab#Lab', 'needed', '--server', '']]) {
      const misused = run('case', ...args);
      assert.equal(misused.status, 2, args.join(' '));
      assert.match(misused.stderr, /\n {7}duru case <config\.json> <kind> <screen or call ID> needed\|not-needed \[--note <why>\] \[--author <name> \| --server <review page address>\]\n/);
    }
  });
});

test('a candidate a person marked not-needed without a note stays undecided, keeps undecided at 3 and says only a person can decide it, and case refuses to change that mark, writing nothing', () => {
  withCaseKinds((configFile, run) => {
    run('rebuild');
    addMark(path.join(path.dirname(configFile), 'case-marks'), { target: { node: 'GET:/api/v1/lab/experiment', case: 'ended' }, status: 'not-needed', author: 'Kim Min' }, new Date('2026-10-05T01:00:00Z'));
    assert.deepEqual(run('case', 'ended', 'GET:/api/v1/lab/experiment', 'needed'), { status: 1, stdout: '', stderr: 'Kim Min marked ended not-needed on GET:/api/v1/lab/experiment on 2026-10-05, and duru case does not change a person\'s mark\n' });
    assert.equal(caseMarks(configFile).length, 1);
    for (const id of ENDED_WRITES) run('case', 'ended', id, 'needed');
    for (const id of ENDED_READS.filter((id) => id !== 'GET:/api/v1/lab/experiment')) run('case', 'ended', id, 'needed');
    assert.deepEqual(run('undecided', 'ended'), {
      status: 3,
      stdout: 'case kind ended: 1 undecided\n  GET:/api/v1/lab/experiment — call, sent from /lab#Lab — Kim Min marked it not-needed without a note on 2026-10-05, so only a person can decide it\n',
      stderr: '',
    });
  });
});

test('an agent\'s not-needed waits under review: undecided leaves it out, exits with 0 when only those are left and says how many wait, rebuild counts them, and once a reviewer reverted one case refuses it and undecided says who took it back', () => {
  withCaseKinds((configFile, run) => {
    run('rebuild');
    const marksDir = path.join(path.dirname(configFile), 'case-marks');
    addMark(marksDir, { target: { node: 'GET:/api/v1/document/list', case: 'ended' }, status: 'needed', author: 'Kim Min' }, new Date('2026-10-05T01:00:00Z'));
    for (const id of [...ENDED_WRITES, ...ENDED_READS]) assert.equal(run('case', 'ended', id, 'not-needed', '--note', '문서를 바꾸지 않는다').status, 0, id);
    const waiting = [...ENDED_WRITES, ...ENDED_READS].length;
    assert.deepEqual(run('undecided', 'ended'), {
      status: 0,
      stdout: `case kind ended: 0 undecided, ${waiting} under review\n${waiting} under review: not-needed marks of the agent that wait for a reviewer to accept or revert them on the review page\n`,
      stderr: '',
    });
    assert.match(run('rebuild').stdout, /^case kind ended: undecided 0 \| cases with no tests 6 \| under review 8$/m);

    const agentMark = caseMarks(configFile).find((m) => m.target!.node === ENDED_WRITES[0] && m.via)!;
    const later = new Date(Date.now() + 60_000);
    const day = later.toISOString().slice(0, 10);
    addMark(marksDir, { target: { node: ENDED_WRITES[0], case: 'ended' }, status: 'not-needed', note: '', author: 'Kim Min', of: agentMark.id }, later);
    assert.deepEqual(run('case', 'ended', ENDED_WRITES[0], 'needed'), { status: 1, stdout: '', stderr: `Kim Min took back the agent's not-needed for ended on ${ENDED_WRITES[0]} on ${day}, so only a person decides it now\n` });
    assert.deepEqual(run('undecided', 'ended'), {
      status: 3,
      stdout: `case kind ended: 1 undecided, ${waiting - 1} under review\n  ${ENDED_WRITES[0]} — call, sent from /signin#SignIn — Kim Min took back the agent's not-needed on ${day}, so only a person can decide it\n${waiting - 1} under review: not-needed marks of the agent that wait for a reviewer to accept or revert them on the review page\n`,
      stderr: '',
    });
  });
});

test('a not-needed of the agent a reviewer accepted, taken out of a rule that no longer picks it, is undecided again and undecided says the reviewer took it out of that rule', () => {
  withCaseKinds((configFile, run) => {
    run('rebuild');
    const rename = 'PUT:/api/v1/document/{documentId}/name';
    assert.equal(run('case', 'ended', rename, 'not-needed', '--note', '이름은 끝난 뒤에도 바꾼다').status, 0);
    const proposal = caseMarks(configFile)[0];
    const later = new Date(Date.now() + 60_000);
    addMark(path.join(path.dirname(configFile), 'case-marks'), { target: { node: rename, case: 'ended' }, status: 'not-needed', note: proposal.note, rule: proposal.rule, author: 'Kim Min', of: proposal.id }, later);
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, caseKinds: { ...config.caseKinds, ended: { ...config.caseKinds.ended, picks: [{ screen: '/document/**', methods: ['POST'] }] } } }));
    run('rebuild');
    const { status, stdout } = run('undecided', 'ended');
    assert.equal(status, 3);
    assert.ok(stdout.split('\n').includes(`  ${rename} — call, sent from /document/:id#DocumentDetail — Kim Min took it out of a rule that no longer picks it on ${later.toISOString().slice(0, 10)}, so only a person can decide it`), stdout);
  });
});

test('undecided whose reader stops early still exits with 3 while candidates are left, with nothing on stderr', () => {
  withCaseKinds((configFile, run) => {
    run('rebuild');
    const piped = execFileSync('bash', ['-c', '"$0" "$1" undecided "$2" 2>"$3" | true; echo "${PIPESTATUS[0]}"', process.execPath, CLI, configFile, path.join(path.dirname(configFile), 'stderr.txt')], { encoding: 'utf8' });
    assert.equal(piped, '3\n');
    assert.equal(fs.readFileSync(path.join(path.dirname(configFile), 'stderr.txt'), 'utf8'), '');
  });
});

test('rebuild prints for each case kind how many candidates are undecided and how many cases of the screens and calls picked for it have no tests', () => {
  withCaseKinds((configFile, run) => {
    const lines = (stdout: string) => stdout.split('\n').filter((l) => /^case kind \S+: undecided /.test(l));
    assert.deepEqual(lines(run('rebuild').stdout), ['case kind ended: undecided 8 | cases with no tests 4', 'case kind legacy: undecided 21 | cases with no tests 0']);
    run('case', 'legacy', '/lab#Lab', 'needed');
    assert.deepEqual(lines(run('rebuild').stdout), ['case kind ended: undecided 8 | cases with no tests 4', 'case kind legacy: undecided 20 | cases with no tests 1']);
  });
});

function rebuildTraced(change: (results: string) => void = () => {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config.tests.push({ format: 'playwright', path: 'results/playwright-traced', depth: 'ui' });
    fs.writeFileSync(configFile, JSON.stringify(config));
    change(path.join(copy, 'results/playwright-traced/test-results'));
    return execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

test('rebuild counts the screens that untagged browser tests passed through and the calls they sent, finding the traces next to a report whose paths point elsewhere, and leaves the screens with tests as they were', () => {
  const stdout = rebuildTraced();
  assert.match(stdout, /^links from browser tests to screens they passed through and calls they sent 34 \| traces not read 1 \| browser tests that ran without a trace \d+$/m);
  assert.match(stdout, /^screens with tests 7\/11 \|/m);
  assert.match(stdout, /^  trace results\/playwright-traced\/test-results\/no-snapshots-[^ ]+\/trace\.zip ← no-snapshots\.spec\.ts:5 presses the button without snapshots: trace 파일에 화면 스냅숏이 없어/m);
  assert.doesNotMatch(stdout, /untraced\.spec\.ts/);
});

test('rebuild leaves the pairs of browser tests that a reviewer discarded or handed over out of the links it counts', () => {
  const stdout = rebuildTraced((results) => {
    const judgmentsDir = path.resolve(results, '../../../out/judgments');
    const opened = { source: 'results/playwright-traced/visits.json', file: 'visits.spec.ts', title: 'checks the path of a document' };
    const sent = { source: 'results/playwright-traced/calls.json', file: 'calls.spec.ts', title: 'reads a document from the server' };
    addJudgment(judgmentsDir, { test: opened, node: '/document/:id#DocumentDetail', kind: 'discard', reason: 'only reads the address', author: 'a' });
    addJudgment(judgmentsDir, { test: sent, node: 'GET:/api/v1/document/{documentId}', kind: 'hand-over', author: 'a' });
    addJudgment(judgmentsDir, { test: sent, node: '/lab#Lab', kind: 'hand-over', author: 'a' });
  });
  assert.match(stdout, /^links from browser tests to screens they passed through and calls they sent 32 \|/m);
  assert.match(stdout, /^pairs discarded by reviewers 1 \|/m);
  assert.match(stdout, /^pairs handed over for tagging waiting for the tag 1 \| handed over but no longer found among the tests importing, passing through or tagged with the screen or call 1$/m);
});

test('rebuild goes on past a trace that is gone and one that is broken, and names each with its reason', () => {
  const stdout = rebuildTraced((results) => {
    fs.rmSync(path.join(results, 'visits-opens-home-and-then-help-chromium/trace.zip'));
    fs.writeFileSync(path.join(results, 'visits-presses-the-button-on-home-chromium/trace.zip'), 'not a zip');
  });
  assert.match(stdout, /^links from browser tests to screens they passed through and calls they sent 31 \| traces not read 3 \|/m);
  assert.match(stdout, /^  trace \/builds\/app\/test-results\/visits-opens-home-and-then-help-chromium\/trace\.zip ← visits\.spec\.ts:\d+ opens home and then help: trace 파일이 없습니다$/m);
  assert.match(stdout, /^  trace results\/playwright-traced\/test-results\/visits-presses-the-button-on-home-chromium\/trace\.zip ← visits\.spec\.ts:\d+ presses the button on home: trace 파일을 열지 못했습니다: /m);
  assert.match(stdout, /^stories /m);
});

test('rebuild with no server API list counts the unchecked calls and says the comparison was not made', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const withList = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(withList, /^screens 11 \| api functions 11 \| endpoints match 8 method-mismatch 1 none 1 unresolved 1$/m);
    assert.doesNotMatch(withList, /unchecked|server API list/);

    fs.writeFileSync(path.join(copy, 'server-endpoints.txt'), '');
    fs.writeFileSync(path.join(copy, 'server-endpoints-lab.txt'), '');
    const empty = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    delete config.serverEndpoints;
    fs.writeFileSync(configFile, JSON.stringify(config));
    const absent = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });

    for (const stdout of [empty, absent]) {
      assert.match(stdout, /^screens 11 \| api functions 11 \| endpoints match 0 method-mismatch 0 none 0 unresolved 1 unchecked 10$/m);
      assert.match(stdout, /^ {2}Server comparison skipped: the server API list is absent or has no endpoint lines$/m);
      assert.match(stdout, /^dead calls reachable from screens: 0$/m);
      assert.match(stdout, /^calls 10 \| dead screens 0$/m);
    }
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('rebuild warns about each call ID in bodyOptions that is not on the map', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config.bodyOptions['POST:/api/v1/report/weekly'] = ['weekly'];
    fs.writeFileSync(configFile, JSON.stringify(config));
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(stdout, /^ {2}bodyOptions POST:\/api\/v1\/report\/weekly matches no call$/m);
    assert.doesNotMatch(stdout, /bodyOptions POST:\/api\/v1\/report\/schedule/);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('rebuild warns about each guard in roleGuards that guards no route or link with a role', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, roleGuards: { isAdmin: ['ADMIN'], 'menuPolicy.canAccessTrash': ['ADMIN'] } }));
    const stdout = execFileSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
    assert.match(stdout, /^ {2}roleGuards menuPolicy\.canAccessTrash matches no role guard$/m);
    assert.doesNotMatch(stdout, /roleGuards isAdmin/);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('rebuild warns about each path in moves that matches no route', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, moves: [{ from: '/signin', to: '/home', reason: '로그인 뒤' }, { from: '/login', to: '/home', reason: '로그인 뒤' }] }));
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(stdout, /^ {2}moves \/login matches no route$/m);
    assert.doesNotMatch(stdout, /moves \/(signin|home)/);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('rebuild warns about each call in callLinks that is not on the map, naming its link', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const callLinks = [
      { from: 'POST:/api/v1/report/export', to: 'GET:/api/v1/document/{documentId}', note: '내보낸 파일을 연다' },
      { from: 'POST:/api/v1/report/weekly', to: 'GET:/api/v1/download', note: '주간 보고서를 내려받는다' },
    ];
    fs.writeFileSync(configFile, JSON.stringify({ ...config, callLinks }));
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.deepEqual(stdout.split('\n').filter((l) => l.includes('callLinks')), [
      '  callLinks POST:/api/v1/report/weekly → GET:/api/v1/download: POST:/api/v1/report/weekly matches no call',
      '  callLinks POST:/api/v1/report/weekly → GET:/api/v1/download: GET:/api/v1/download matches no call',
    ]);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('rebuild counts the stories with broken paths or screens gone from the map, the steps it could not judge and the stories in each status, and names each story file it skipped and why', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const plain = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(plain, /^stories 0 \| broken paths 0 \| detached 0 \| unjudged steps 0 \| story files skipped 0$/m);
    assert.match(plain, /^stories passing 0 \| passing on part of the path 0 \| failing 0 \| pending 0 \| partly covered 0 \| no tests 0$/m);
    assert.match(plain, /^passing stories not known to go through every step, for want of a trace or a screen on the map 0$/m);
    assert.match(plain, /^ {2}unknown story:run-lab ← com\.example\.lab\.LabFlowTest:null /m);

    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), storiesDir: 'example-stories' }));
    const lab = path.join(copy, 'client/src/components/Lab.js');
    fs.writeFileSync(lab, fs.readFileSync(lab, 'utf8').replace('</section>', '  <Link to={Option.ROUTE_PATH.NOPE}>Nope</Link>\n    </section>'));
    fs.writeFileSync(path.join(copy, 'example-stories/lab-to-sign-in.json'), JSON.stringify({ name: 'n', screens: ['/lab#Lab', '/signin#SignIn'], author: 'a', date: '2026-10-02' }));
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(stdout, /^stories 6 \| broken paths 1 \| detached 1 \| unjudged steps 1 \| story files skipped 1$/m);
    assert.match(stdout, /^stories passing 1 \| passing on part of the path 0 \| failing 1 \| pending 1 \| partly covered 2 \| no tests 1$/m);
    assert.match(stdout, /^passing stories not known to go through every step, for want of a trace or a screen on the map 1$/m);
    assert.match(stdout, /^ {2}unknown story:print-document ← stories\.spec\.ts:12 prints a document @story:print-document$/m);
    assert.doesNotMatch(stdout, /unknown story:run-lab/);
    assert.match(stdout, /^ {2}story file lab-shortcut\.json: screens 는 /m);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('rebuild counts the need files, the needs that pick a need file that is not there and the need files it skipped, and names each skipped one and why', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), storiesDir: 'example-stories' }));
    const plain = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(plain, /^need files 0 \| needs picking a need file that is not there 0 \| need files skipped 0$/m);

    const stories = path.join(copy, 'example-stories');
    fs.mkdirSync(path.join(stories, 'needs'));
    fs.writeFileSync(path.join(stories, 'needs/member-account.json'), JSON.stringify({ name: '일반 회원 계정', text: '역할 USER 계정' }));
    fs.writeFileSync(path.join(stories, 'needs/broken.json'), JSON.stringify({ name: '이름만 있다' }));
    const story = JSON.parse(fs.readFileSync(path.join(stories, 'run-lab.json'), 'utf8'));
    fs.writeFileSync(path.join(stories, 'run-lab.json'), JSON.stringify({ ...story, needs: [{ use: 'member-account.json' }, { use: 'old-admin.json' }, { use: 'broken.json' }], screens: [{ screen: story.screens[0], needs: [{ use: 'old-admin.json' }] }, ...story.screens.slice(1)] }));
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(stdout, /^need files 1 \| needs picking a need file that is not there 2 \| need files skipped 1$/m);
    assert.match(stdout, /^ {2}need file needs\/broken\.json: text 에 공통 조건 내용을 적어야 합니다$/m);
    assert.match(stdout, /^stories 5 \| broken paths 1 \| detached 1 \| unjudged steps 0 \| story files skipped 1$/m);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('rebuild leaves discarded pairs out of the links made by imports, and names each judgment file it could not read without stopping', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const judgments = path.join(copy, 'out/judgments/_help#Help');
    fs.mkdirSync(judgments, { recursive: true });
    fs.writeFileSync(path.join(judgments, 'a.json'), JSON.stringify({
      id: 'a', node: '/help#Help', kind: 'discard', reason: 'only renders a shared header', author: 'a', date: '2026-10-04T01:00:00.000Z',
      test: { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'renders the help text' },
    }));
    fs.writeFileSync(path.join(judgments, 'broken.json'), '{');
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
    assert.match(stdout, /^links from unit tests to screens by the files they import 4 \| test files not read 2$/m);
    assert.match(stdout, /^pairs discarded by reviewers 1 \| judgment files skipped 1$/m);
    assert.match(stdout, /^ {2}judgment file _help#Help\/broken\.json: not valid JSON/m);
    assert.match(stdout, /^stories /m);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

const HELP_UNIT = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js' };

function rebuildWithHandOvers(handOvers: HandOver[], check: (result: { stdout: string; lines: string[]; judgments: ReturnType<typeof addJudgment>[]; judgmentsDir: string }) => void) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const judgmentsDir = path.join(copy, 'out/judgments');
    const judgments = handOvers.map(({ node, title, file = HELP_UNIT.file }) => addJudgment(
      judgmentsDir,
      { test: { ...HELP_UNIT, file, title }, node, kind: 'hand-over', reason: '', author: 'a' },
      new Date('2026-10-04T01:00:00Z'),
    ));
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
    check({ stdout, lines: stdout.split('\n'), judgments, judgmentsDir });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

test('rebuild prints how many handed-over pairs wait for their tag and how many handed-over pairs are no longer found among the tests of the screen', () => {
  rebuildWithHandOvers([
    { node: '/help#Help', title: 'renders the help text' },
    { node: '/help#Help', title: 'shows the day the help was last updated' },
    { node: '/help#Help', title: 'a test that was renamed' },
  ], ({ stdout }) => {
    assert.match(stdout, /^links from unit tests to screens by the files they import 3 \| test files not read 2$/m);
    assert.match(stdout, /^pairs discarded by reviewers 0 \| judgment files skipped 0$/m);
    assert.match(stdout, /^pairs handed over for tagging waiting for the tag 2 \| handed over but no longer found among the tests importing, passing through or tagged with the screen or call 1$/m);
  });
});

test('rebuild counts a hand-over on the map apart from one whose screen is not on the map, and names the latter by node, test and judgment file', () => {
  rebuildWithHandOvers([
    { node: '/help#Help', title: 'renders the help text' },
    { node: '/help#Help', title: 'a test that was renamed' },
    { node: '/gone#Gone', title: 'renders the removed screen' },
  ], ({ lines, judgments, judgmentsDir }) => {
    const at = lines.findIndex((l) => l.startsWith('pairs handed over for tagging'));
    const file = path.join(judgmentsDir, '_gone#Gone', `2026-10-04-a-${judgments[2].id.slice(0, 8)}.json`);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(lines.slice(at, at + 2), [
      'pairs handed over for tagging waiting for the tag 1 | handed over but no longer found among the tests importing, passing through or tagged with the screen or call 1',
      `  handed over for /gone#Gone, which is not on the map ← components/Help.spec.js renders the removed screen (delete ${file} to clear it)`,
    ]);
  });
});

test('rebuild counts a detached hand-over for an API call, which is on the map, and does not call it off the map', () => {
  rebuildWithHandOvers([{ node: 'POST:/api/v1/report/archive', title: 'a test that was renamed' }], ({ lines }) => {
    const at = lines.findIndex((l) => l.startsWith('pairs handed over for tagging'));
    assert.equal(lines[at], 'pairs handed over for tagging waiting for the tag 0 | handed over but no longer found among the tests importing, passing through or tagged with the screen or call 1');
    assert.ok(!lines.some((l) => l.includes('not on the map')));
  });
});

test('rebuild names an off-map hand-over by its title alone when the test has no file', () => {
  rebuildWithHandOvers([{ node: '/gone#Gone', title: 'a check without a file', file: null }], ({ lines }) => {
    const line = lines.find((l) => l.includes('which is not on the map'));
    assert.match(line!, /^  handed over for \/gone#Gone, which is not on the map ← a check without a file \(delete /);
  });
});

test('rebuild counts the story candidates from the visit records and from traces, the latter also on their own, and the ones it newly stored, writes the screen order of each traced test into tests.json, and names each record or discarded candidate file it skipped and why', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const plain = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(plain, /^story candidates 0 \| from traces 0 \| newly stored 0 \| files skipped 0$/m);
    assert.equal(fs.existsSync(path.join(copy, 'out/stories')), false);

    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, storiesDir: 'example-stories', visitRecords: ['example-visits'] }));
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(stdout, /^story candidates 2 \| from traces 0 \| newly stored 2 \| files skipped 1$/m);
    assert.match(stdout, /^ {2}example-visits\/broken-record\.json: 2 번째 단계의 url 을 읽지 못했습니다$/m);

    fs.writeFileSync(configFile, JSON.stringify({ ...config, storiesDir: 'example-stories', visitRecords: ['example-visits'], tests: [...config.tests, { format: 'playwright', path: 'results/playwright-traced', depth: 'ui' }] }));
    const traced = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(traced, /^story candidates 4 \| from traces 2 \| newly stored 2 \| files skipped 1$/m);
    assert.equal(fs.readdirSync(path.join(copy, 'example-stories/candidates')).length, 4);
    const orders = JSON.parse(fs.readFileSync(path.join(copy, 'out/tests.json'), 'utf8')).traced;
    const report = 'results/playwright-traced/visits.json';
    assert.deepEqual(orders.find((t: { title: string }) => t.title === 'opens home and then help'), { report, title: 'opens home and then help', file: 'visits.spec.ts', line: 3, screens: ['/home#Home', '/help#Help'] });
    assert.deepEqual(orders.find((t: { title: string }) => t.title === 'presses the button on home'), { report, title: 'presses the button on home', file: 'visits.spec.ts', line: 8, screens: ['/home#Home'] });

    const again = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(again, /^story candidates 4 \| from traces 2 \| newly stored 0 \| files skipped 1$/m);
    fs.writeFileSync(configFile, JSON.stringify({ ...config, storiesDir: 'example-stories', visitRecords: [] }));
    const untraced = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(untraced, /^story candidates 4 \| from traces 2 \| newly stored 0 \| files skipped 0$/m);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(copy, 'out/tests.json'), 'utf8')).traced, []);

    fs.writeFileSync(path.join(copy, 'taken.txt'), 'a file');
    fs.writeFileSync(configFile, JSON.stringify({ ...config, storiesDir: 'taken.txt/stories', visitRecords: ['example-visits'] }));
    const unwritable = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(unwritable, /^story candidates [1-9]\d* \| from traces 0 \| newly stored 0 \| files skipped 1$/m);
    assert.match(unwritable, /^ {2}taken\.txt\/stories\/candidates: 후보 파일을 쓰지 못했습니다: ENOTDIR/m);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

for (const args of [['nope', 'x.json'], ['extract', 'x.json', 'out.json'], ['rebuild', 'x.json', '--port', '5000'], ['tasks', 'x.json', '--port', '5000'], ['review', 'x.json', '--port', 'abc'], ['reply', 'x.json', 'id'], ['reply', 'x.json', 'id', 'text', '--port', '5000'], ['review', 'x.json', '--server', 'http://127.0.0.1:1/'], ['wait', 'x.json'], ['wait', 'x.json', '--server'], ['wait', 'x.json', '--port', '5000'], ['case', 'x.json', 'ended', '/lab#Lab'], ['undecided', 'x.json', 'ended', 'legacy']]) {
  test(`"${args.join(' ')}" prints usage and exits with 2`, () => {
    assert.throws(
      () => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }),
      (err: Failure) => err.status === 2 && /usage: duru <extract\|rebuild\|tasks>/.test(err.stderr),
    );
  });
}

const within = <T>(promise: Promise<T>, what: string) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no ${what} within 10s`)), 10_000).unref())]);

async function withReviewFixture(fn: (configFile: string) => Promise<void>, patch: Record<string, unknown> = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), marksDir: 'example-marks', ...patch }));
    execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    return await fn(configFile);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

function startReview(configFile: string, port = 0, env: Record<string, string> = {}, cwd?: string) {
  const { CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN, ...outside } = process.env;
  const child = spawn(process.execPath, [CLI, 'review', configFile, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...outside, ...env }, cwd });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (c) => (out.stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c) => (out.stderr += c));
  const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, ...out })));
  const base = new Promise<string>((resolve, reject) => {
    child.stderr.on('data', () => {
      const m = out.stderr.match(/^review page (http:\/\/\S+?)\/?$/m);
      if (m) resolve(m[1]);
    });
    closed.then(() => reject(new Error(`review ended before printing its address:\n${out.stderr}`)));
  });
  return { child, base, closed, out };
}

for (const [how, end] of [
  ['the end request', (child: ChildProcess, base: string) => fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })],
  ['Ctrl+C', (child: ChildProcess) => child.kill('SIGINT')],
] satisfies [string, (child: ChildProcess, base: string) => unknown][]) {
  test(`review ended by ${how} exits with 0 and prints the task list, with marks made during the review, on stdout`, async () => {
    await withReviewFixture(async (configFile) => {
      const { child, base, closed } = startReview(configFile);
      try {
        const url = await within(base, 'review page address on stderr');
        const mark = await fetch(`${url}/api/marks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: { node: '/lab#Lab' }, status: 'missing', author: 'reviewer' }),
        });
        assert.equal(mark.status, 201);
        await end(child, url);

        const { code, stdout, stderr } = await within(closed, 'exit');
        assert.equal(code, 0);
        assert.equal(stdout, execFileSync(process.execPath, [CLI, 'tasks', configFile], { encoding: 'utf8' }));
        assert.match(stdout, /^## \/lab#Lab$/m);
        assert.match(stderr, /^marks .* \| author \S.* \((git user\.name|computer user name)\)$/m);
      } finally {
        child.kill();
      }
    });
  });
}

test('each mark and comment saved during the review comes out at once as one JSON line on stderr, and stdout still holds only the task list', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed, out } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const records = () => out.stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const save = async (body: unknown) => {
        const res = await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(res.status, 201);
        const saved = (await res.json()) as Mark;
        await within(new Promise<void>((resolve) => {
          const look = () => (records().some((r) => r.id === saved.id) ? resolve() : setTimeout(look, 20));
          look();
        }), 'the saved record on stderr');
        return saved;
      };
      const mark = await save({ target: { node: '/lab#Lab' }, status: 'missing', note: 'No test.' });
      const comment = await save({ target: { story: 'read-reports' }, note: 'Two lines:\nthe second one.' });
      assert.deepEqual(records(), [{ duru: 'mark', ...mark }, { duru: 'comment', ...comment }]);
      assert.equal(out.stdout, '');

      await fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const { code, stdout } = await within(closed, 'exit');
      assert.equal(code, 0);
      assert.equal(stdout, execFileSync(process.execPath, [CLI, 'tasks', configFile], { encoding: 'utf8' }));
    } finally {
      child.kill();
    }
  });
});

function readEvents(url: string) {
  const got = { text: '', ended: false };
  let opened!: () => void;
  const open = new Promise<void>((resolve) => (opened = resolve));
  const done = fetch(`${url}/api/events`).then(async (res) => {
    opened();
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const decoder = new TextDecoder();
    for await (const chunk of res.body!) got.text += decoder.decode(chunk, { stream: true });
    got.ended = true;
  });
  return { got, done, open };
}

const reply = (configFile: string, ...args: string[]) => {
  try {
    return { status: 0, stderr: execFileSync(process.execPath, [CLI, 'reply', configFile, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return err as Failure;
  }
};

const waitFor = (check: () => boolean, what: string) => within(new Promise<void>((resolve) => {
  const look = () => (check() ? resolve() : setTimeout(look, 20));
  look();
}), what);

test('a comment saved on a test under a screen comes out on stderr and on open event streams with where the test is; a reply to it carries the same place', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed, out } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const events = readEvents(url);
      const records = () => out.stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const key = { source: 'results/playwright/e2e.json', file: 'home.spec.ts', title: 'opens the lab' };
      const res = await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { node: '/lab#Lab', part: { kind: 'test', key } }, note: 'Why is this pending?' }) });
      assert.equal(res.status, 201);
      const comment = (await res.json()) as Mark;
      assert.deepEqual(reply(configFile, comment.id, 'It waits for the lab data.', '--server', `${url}/`), { status: 0, stderr: '' });
      await waitFor(() => records().length === 2, 'the comment and the reply on stderr');
      const where = { file: 'home.spec.ts', line: 20, source: 'results/playwright/e2e.json', status: 'pending', relation: 'tagged' };
      assert.deepEqual(records()[0], { duru: 'comment', ...comment, where });
      assert.deepEqual(records()[1].where, where);
      assert.deepEqual(records()[1].target, comment.target);
      await waitFor(() => events.got.text.split('\n\n').filter((e) => e.startsWith('data: ')).length === 2, 'two events on the stream');
      assert.deepEqual(events.got.text.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => JSON.parse(e.slice('data: '.length))), records());

      const refused = await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { node: '/lab#Lab', part: { kind: 'test', key } }, status: 'missing', note: 'x' }) });
      assert.equal(refused.status, 400);
      assert.match(await refused.text(), /takes no status/);
      await fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await within(closed, 'exit');
    } finally {
      child.kill();
    }
  });
});

test('a comment saved on several targets comes out on stderr with where each of them is, in their order, and a reply to it carries the same; a comment on no target comes out with empty lists and opens the task list', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed, out } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const records = () => out.stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const post = (body: unknown) => fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const targets = [{ node: '/lab#Lab' }, { node: '/lab#Lab', part: { kind: 'test', key: { source: 'results/playwright/e2e.json', file: 'home.spec.ts', title: 'opens the lab' } } }];
      const res = await post({ targets, note: 'Is the lab covered?' });
      assert.equal(res.status, 201);
      const comment = (await res.json()) as Mark;
      assert.deepEqual(reply(configFile, comment.id, 'By one pending test.', '--server', `${url}/`), { status: 0, stderr: '' });
      assert.equal((await post({ targets: [], note: 'Where do I start?' })).status, 201);
      await waitFor(() => records().length === 3, 'two comments and a reply on stderr');
      const wheres = [null, { file: 'home.spec.ts', line: 20, source: 'results/playwright/e2e.json', status: 'pending', relation: 'tagged' }];
      assert.deepEqual(records()[0], { duru: 'comment', ...comment, wheres });
      assert.deepEqual([records()[1].duru, records()[1].targets, records()[1].wheres], ['reply', targets, wheres]);
      assert.deepEqual([records()[2].targets, records()[2].wheres, 'target' in records()[2]], [[], [], false]);
      await fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await within(closed, 'exit');
      assert.match(out.stdout, /# Comments with no target\n\n- comment[^\n]*Where do I start\?/);
    } finally {
      child.kill();
    }
  });
});

test('a comment saved on a condition or an incoming link of a screen comes out on stderr with the source file and line the condition or link is written at', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed, out } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const records = () => out.stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const post = async (part: unknown) => (await (await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { node: '/admin/member#AdminMember', part }, note: 'Is this right?' }) })).json()) as Mark;
      const condition = await post({ kind: 'condition', key: 'role:ADMIN' });
      const link = await post({ kind: 'link', key: { from: '/home#Home', conditions: ['role:ADMIN'] } });
      await waitFor(() => records().length === 2, 'both comments on stderr');
      assert.deepEqual(records(), [
        { duru: 'comment', ...condition, where: { places: [
          { from: 'route', file: 'Routes.js', line: 42, guard: 'isAdminRole(memberRole)' },
          { from: '/home#Home', file: 'components/Home.js', line: 17, guard: "memberRole === 'ADMIN'" },
        ] } },
        { duru: 'comment', ...link, where: { places: [{ from: '/home#Home', file: 'components/Home.js', line: 17 }] } },
      ]);
      await fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await within(closed, 'exit');
    } finally {
      child.kill();
    }
  });
});

test('a comment saved on a step or on the link between two steps of a story comes out on stderr with the story file, the screen files, and for the link its verdict and where it is written', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed, out } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const records = () => out.stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const post = async (part: unknown) => (await (await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { story: 'help-from-home', part }, note: 'Why here?' }) })).json()) as Mark;
      await post({ kind: 'step', key: { step: 2, screen: '/home#Home' } });
      await post({ kind: 'hop', key: { step: 1, from: '/signin#SignIn', to: '/home#Home' } });
      await waitFor(() => records().length === 2, 'both comments on stderr');
      const [step, hop] = records().map((r) => r.where);
      assert.equal(step.file, 'help-from-home.json');
      assert.deepEqual([step.screen.id, step.screen.routeFile, typeof step.screen.line], ['/home#Home', 'Routes.js', 'number']);
      assert.deepEqual([hop.file, hop.from.id, hop.to.id, hop.verdict], ['help-from-home.json', '/signin#SignIn', '/home#Home', 'open']);
      assert.deepEqual(hop.ways.map((w: { file: string; line: number }) => `${w.file}:${w.line}`), ['components/SignIn.js:12']);
      assert.ok(Array.isArray(hop.preconditions));
      await fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await within(closed, 'exit');
    } finally {
      child.kill();
    }
  }, { storiesDir: 'example-stories' });
});

test('a comment saved on a story candidate comes out on stderr and on open event streams with its record, steps and screen order; a reply to it carries the same, a status is refused, and the task list stays as it was', async () => {
  await withReviewFixture(async (configFile) => {
    const tasksBefore = execFileSync(process.execPath, [CLI, 'tasks', configFile], { encoding: 'utf8' });
    const { child, base, closed, out } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const events = readEvents(url);
      const records = () => out.stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const target = { candidate: '/signin#SignIn > /home#Home > /beta/inbox > /help#Help' };
      const res = await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, note: 'Why does it pass the beta inbox?' }) });
      assert.equal(res.status, 201);
      const comment = (await res.json()) as Mark;
      assert.deepEqual(comment.target, target);
      assert.deepEqual(reply(configFile, comment.id, 'Steps 3 and 4 open /beta/inbox.', '--server', `${url}/`), { status: 0, stderr: '' });
      await waitFor(() => records().length === 2, 'the comment and the reply on stderr');
      const where = {
        name: 'open-help',
        source: { record: 'example-visits/open-help.json', steps: [1, 5] },
        screens: ['/signin#SignIn', '/home#Home', '/beta/inbox', '/help#Help'],
        stepRanges: [[1, 1], [2, 2], [3, 4], [5, 5]],
      };
      assert.deepEqual(records()[0], { duru: 'comment', ...comment, where });
      assert.deepEqual([records()[1].duru, records()[1].target, records()[1].where], ['reply', target, where]);
      await waitFor(() => events.got.text.split('\n\n').filter((e) => e.startsWith('data: ')).length === 2, 'two events on the stream');
      assert.deepEqual(events.got.text.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => JSON.parse(e.slice('data: '.length))), records());

      const refused = await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, status: 'missing', note: 'x' }) });
      assert.equal(refused.status, 400);
      assert.match(await refused.text(), /a comment on a story candidate takes no status/);
      await fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const { code, stdout } = await within(closed, 'exit');
      assert.equal(code, 0);
      assert.equal(stdout, tasksBefore);
    } finally {
      child.kill();
    }
  }, { storiesDir: 'example-stories', visitRecords: ['example-visits'] });
});

test('a comment saved on a screen order comes out on stderr, on open event streams and from wait with the files of each screen, the verdict between each two neighbours, the gaps picked and the fields typed at each step; a reply to it carries the same, a status is refused, and the task list stays as it was', async () => {
  await withReviewFixture(async (configFile) => {
    const tasksBefore = execFileSync(process.execPath, [CLI, 'tasks', configFile], { encoding: 'utf8' });
    const { child, base, closed, out } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const events = readEvents(url);
      const records = () => out.stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const target = {
        screens: ['/signin#SignIn', '/home#Home', '/help#Help'],
        gaps: [[2, 3]],
        steps: [{ step: 1, inputs: [{ box: { label: '아이디' }, value: 'duru-admin' }] }, { step: 3, expects: ['도움말이 보인다'] }],
      };
      const waiting = startWait(configFile, url);
      await waitFor(() => waiting.out.stderr.includes('waiting for a comment'), 'the waiting line on stderr');
      const res = await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, note: 'Fill in a way to help.' }) });
      assert.equal(res.status, 201);
      const comment = (await res.json()) as Mark;
      assert.deepEqual(comment.target, target);
      const waited = await within(waiting.closed, 'wait to exit');
      assert.equal(waited.code, 0);
      assert.deepEqual(reply(configFile, comment.id, 'Home has no link to help.', '--server', `${url}/`), { status: 0, stderr: '' });
      await waitFor(() => records().length === 2, 'the comment and the reply on stderr');
      const { where } = records()[0];
      assert.deepEqual(where.screens.map((s: { id: string; routeFile: string; line: unknown; componentFile: unknown }) => [s.id, s.routeFile, typeof s.line, typeof s.componentFile]), [
        ['/signin#SignIn', 'Routes.js', 'number', 'string'],
        ['/home#Home', 'Routes.js', 'number', 'string'],
        ['/help#Help', 'Routes.js', 'number', 'string'],
      ]);
      assert.deepEqual(where.links.map((l: { from: string; to: string; verdict: string; ways: { file: string; line: number }[] }) => [l.from, l.to, l.verdict, l.ways.map((w) => `${w.file}:${w.line}`)]), [
        ['/signin#SignIn', '/home#Home', 'open', ['components/SignIn.js:12']],
        ['/home#Home', '/help#Help', 'broken', []],
      ]);
      assert.deepEqual([records()[0].target, records()[1].duru, records()[1].target, records()[1].where], [target, 'reply', target, where]);
      assert.deepEqual(lines(waited.stdout), [records()[0]]);
      await waitFor(() => events.got.text.split('\n\n').filter((e) => e.startsWith('data: ')).length === 2, 'two events on the stream');
      assert.deepEqual(events.got.text.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => JSON.parse(e.slice('data: '.length))), records());

      const refused = await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, status: 'missing', note: 'x' }) });
      assert.equal(refused.status, 400);
      assert.match(await refused.text(), /a comment on a screen order takes no status/);
      await fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const { code, stdout } = await within(closed, 'exit');
      assert.equal(code, 0);
      assert.equal(stdout, tasksBefore);
    } finally {
      child.kill();
    }
  });
});

test('a reply sent with --server is saved by the running review, printed on its stderr as a "reply" line and pushed to open event streams; ending the review closes the streams and still exits with the task list', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed, out } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const events = readEvents(url);
      const records = () => out.stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const post = async (body: unknown) => (await (await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as Mark;
      await post({ target: { node: '/lab#Lab' }, status: 'missing', note: 'No test.' });
      const comment = await post({ target: { node: '/lab#Lab' }, note: 'Is the table tested?' });

      assert.deepEqual(reply(configFile, comment.id, 'Not yet, writing one now.', '--server', `${url}/`), { status: 0, stderr: '' });
      await waitFor(() => records().length === 3, 'the reply on stderr');
      const sent = records()[2];
      assert.deepEqual(sent, { duru: 'reply', id: sent.id, target: { node: '/lab#Lab' }, replyTo: comment.id, note: 'Not yet, writing one now.', author: 'agent', date: sent.date });
      await waitFor(() => events.got.text.split('\n\n').filter((e) => e.startsWith('data: ')).length === 3, 'three events on the stream');
      assert.deepEqual(events.got.text.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => JSON.parse(e.slice('data: '.length))), records());
      assert.equal(out.stdout, '');

      await fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const { code, stdout } = await within(closed, 'exit');
      assert.equal(code, 0);
      assert.equal(stdout, execFileSync(process.execPath, [CLI, 'tasks', configFile], { encoding: 'utf8' }));
      assert.match(stdout, /^ {2}- comment, whole screen — "Is the table tested\?" .*\n {4}- reply — "Not yet, writing one now\." \(agent, /m);
      await within(events.done, 'the end of the event stream');
      assert.equal(events.got.ended, true);
      assert.match(events.got.text, /event: end\ndata: review ended\n\n$/);
    } finally {
      child.kill();
    }
  });
});

test('a reply without --server is written to the marks folder and shows in the task list; an ID that is no comment stops both ways with a message naming it', async () => {
  await withReviewFixture(async (configFile) => {
    const marksDir = path.join(path.dirname(configFile), 'example-marks');
    addMark(marksDir, { target: { node: '/lab#Lab' }, status: 'missing', author: 'a' }, new Date('2026-10-05T01:00:00Z'));
    const comment = addMark(marksDir, { target: { node: '/lab#Lab' }, note: 'Is the table tested?', author: 'a' }, new Date('2026-10-05T02:00:00Z'));
    assert.deepEqual(reply(configFile, comment.id, 'Written.'), { status: 0, stderr: '' });
    assert.match(execFileSync(process.execPath, [CLI, 'tasks', configFile], { encoding: 'utf8' }), /\n {4}- reply — "Written\." \(agent, \d{4}-\d\d-\d\d\)\n/);

    const files = () => fs.readdirSync(marksDir, { recursive: true }).length;
    const before = files();
    const failed = reply(configFile, 'no-such-id', 'x');
    assert.equal(failed.status, 1);
    assert.equal(failed.stderr, 'no comment with ID "no-such-id"\n');

    const { child, base, closed } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const viaServer = reply(configFile, 'no-such-id', 'x', '--server', url);
      assert.equal(viaServer.status, 1);
      assert.equal(viaServer.stderr, 'no comment with ID "no-such-id"\n');
      assert.equal(files(), before);
      await fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await within(closed, 'exit');
      const unreachable = reply(configFile, comment.id, 'x', '--server', url);
      assert.equal(unreachable.status, 1);
      assert.match(unreachable.stderr, new RegExp(`^could not reach the review page at ${url}: `));
    } finally {
      child.kill();
    }
  });
});

const runCase = (configFile: string, ...args: string[]) => runCli(configFile, 'case', ...args);
const undecidedCount = (configFile: string, kind: string) => Number(runCli(configFile, 'undecided', kind).stdout.match(/^case kind \S+: (\d+) undecided(?:, \d+ under review)?$/m)![1]);

test('a case sent with --server is saved by the running review in the same shape and folder as one written directly, printed on its stderr as a mark line and pushed to open event streams, and the kind has one undecided candidate less; the command reads no map', async () => {
  await withReviewFixture(async (configFile) => {
    const marksDir = path.join(path.dirname(configFile), 'case-marks');
    const elsewhere = path.join(path.dirname(configFile), 'no-map.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), outDir: 'no-map-here' }));
    const { child, base, closed, out } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const events = readEvents(url);
      await within(events.open, 'the event stream');
      const records = () => out.stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      assert.equal(undecidedCount(configFile, 'ended'), 8);
      assert.deepEqual(runCase(configFile, 'ended', 'GET:/api/v1/member/list', 'needed'), { status: 0, stdout: '', stderr: '' });
      assert.equal(undecidedCount(configFile, 'ended'), 7);

      assert.deepEqual(runCase(elsewhere, 'ended', 'GET:/api/v1/document/list', 'needed', '--server', `${url}/`), { status: 0, stdout: '', stderr: '' });
      assert.deepEqual(runCase(elsewhere, 'ended', 'PUT:/api/v1/document/{documentId}/name', 'not-needed', '--note', '이름은 막지 않는다', '--server', url), { status: 0, stdout: '', stderr: '' });
      await waitFor(() => records().length === 2, 'two mark lines on stderr');
      assert.equal(undecidedCount(configFile, 'ended'), 6);

      const byNode = Object.fromEntries(loadMarks(marksDir).map((m) => [m.target!.node, m]));
      const direct = byNode['GET:/api/v1/member/list'];
      const [sent, renamed] = [byNode['GET:/api/v1/document/list'], byNode['PUT:/api/v1/document/{documentId}/name']];
      const shape = ({ id, date, target, ...rest }: Mark) => ({ ...rest, target: { ...target, node: undefined }, id: typeof id, date: typeof date });
      assert.deepEqual(shape(sent), shape(direct));
      assert.deepEqual(shape(sent), { target: { case: 'ended', node: undefined }, status: 'needed', note: '', author: 'agent', via: 'duru case', id: 'string', date: 'string' });
      assert.deepEqual([renamed.rule, renamed.author, renamed.via], [{ index: 0, pick: ENDED_KINDS.ended.picks[0] }, 'agent', 'duru case']);
      for (const m of [direct, sent, renamed]) assert.ok(fs.existsSync(path.join(marksDir, fileSafe(m.target!.node!), recordName(m))), m.target!.node);

      assert.deepEqual(records(), [{ duru: 'mark', ...sent }, { duru: 'mark', ...renamed }]);
      await waitFor(() => events.got.text.split('\n\n').filter((e) => e.startsWith('data: ')).length === 2, 'two events on the stream');
      assert.deepEqual(events.got.text.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => JSON.parse(e.slice('data: '.length))), records());
      await endReview(url);
      await within(closed, 'exit');
    } finally {
      child.kill();
    }
  }, { marksDir: 'case-marks', caseKinds: ENDED_KINDS });
});

test('case with --server refuses what case refuses directly, with the same line and exit code 1, writing nothing; an address with no review stops with one line and 1; --author with --server is a misuse that names it and exits with 2', async () => {
  await withReviewFixture(async (configFile) => {
    personsCaseMark(configFile);
    const { child, base, closed } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      for (const [args, stderr] of CASE_REFUSALS) {
        assert.deepEqual(runCase(configFile, ...args), { status: 1, stdout: '', stderr }, args.join(' '));
        assert.deepEqual(runCase(configFile, ...args, '--server', url), { status: 1, stdout: '', stderr }, `${args.join(' ')} --server`);
      }
      const named = 'a case sent with --server is always by agent; leave out --author\n';
      assert.deepEqual(runCase(configFile, 'legacy', '/lab#Lab', 'needed', '--author', 'QA 에이전트', '--server', url), { status: 2, stdout: '', stderr: named });
      assert.deepEqual(runCase(configFile, 'legacy', '/lab#Lab', 'needed', '--server', url, '--author', 'agent'), { status: 2, stdout: '', stderr: named });
      assert.equal(caseMarks(configFile).length, 1);
      await endReview(url);
      await within(closed, 'exit');
      const unreachable = runCase(configFile, 'legacy', '/lab#Lab', 'needed', '--server', url);
      assert.equal(unreachable.status, 1);
      assert.match(unreachable.stderr, new RegExp(`^could not reach the review page at ${url}: [^\\n]+\\n$`));
      assert.equal(caseMarks(configFile).length, 1);
    } finally {
      child.kill();
    }
  }, { marksDir: 'case-marks', caseKinds: ENDED_KINDS });
});

const runCandidate = (configFile: string, ...args: string[]) => runCli(configFile, 'candidate', ...args);
const LAB_CANDIDATE = { name: '로그인해 실험을 연다', screens: ['/signin#SignIn', { screen: '/home#Home', reason: '로그인하면 홈으로만 갑니다' }, '/lab#Lab'] };
const LAB_LINES = /^wrote out\/stories\/candidates\/\d{4}-\d\d-\d\d-[0-9a-f]{8}\.json\nstep 1 → 2: from \/signin#SignIn to \/home#Home — open at components\/SignIn\.js:12\nstep 2 → 3: from \/home#Home to \/lab#Lab — conditioned at components\/Home\.js:19\n$/;
const orderComment = (configFile: string, screens: string[]) => addMark(path.join(path.dirname(configFile), 'example-marks'), { target: { screens }, note: '사이를 채워 줘', author: 'hit' }).id;
const candidateInput = (configFile: string, body: unknown) => {
  const file = path.join(path.dirname(configFile), 'candidate-input.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
};
const storedCandidates = (configFile: string) => {
  const dir = path.join(path.dirname(configFile), 'out/stories/candidates');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
};

test('candidate writes the candidate an agent made for a comment on a screen order into the candidates folder with no review running, read from a file or from stdin, and prints the file and the verdict of each link between two of its steps', async () => {
  await withReviewFixture(async (configFile) => {
    const comment = orderComment(configFile, ['/signin#SignIn', '/lab#Lab']);
    const written = runCandidate(configFile, comment, candidateInput(configFile, LAB_CANDIDATE));
    assert.equal(written.status, 0, written.stderr);
    assert.match(written.stdout, LAB_LINES);
    assert.deepEqual(storedCandidates(configFile).map((c) => [c.name, c.screens, c.source]), [[LAB_CANDIDATE.name, ['/signin#SignIn', '/home#Home', '/lab#Lab'], { comment, added: [{ step: 2, reason: '로그인하면 홈으로만 갑니다' }], written: [] }]]);

    const other = orderComment(configFile, ['/home#Home', '/lab/result#LabResult']);
    const body = JSON.stringify({ name: '실험 결과를 연다', screens: ['/home#Home', { screen: '/lab#Lab', reason: '결과는 실험 목록에서 엽니다' }, '/lab/result#LabResult'] });
    const piped = execFileSync(process.execPath, [CLI, 'candidate', configFile, other, '-'], { encoding: 'utf8', input: body });
    assert.match(piped, /^wrote out\/stories\/candidates\/\S+\.json\nstep 1 → 2: from \/home#Home to \/lab#Lab — conditioned at components\/Home\.js:19\nstep 2 → 3: from \/lab#Lab to \/lab\/result#LabResult — /);
    assert.equal(storedCandidates(configFile).length, 2);
  });
});

test('candidate refuses with the reason and exits with 1 a screen not on the map, a screen twice in a row, a comment that is not there or not on a screen order and a line of the reviewer changed, the same directly and with --server, writing nothing; a file it cannot read exits with 1 and a missing argument with 2', async () => {
  await withReviewFixture(async (configFile) => {
    const comment = addMark(path.join(path.dirname(configFile), 'example-marks'), { target: { screens: ['/signin#SignIn', '/lab#Lab'], steps: [{ step: 2, expects: ['실험 목록이 보인다'] }] }, note: '채워 줘', author: 'hit' }).id;
    const onNode = addMark(path.join(path.dirname(configFile), 'example-marks'), { target: { node: '/lab#Lab' }, note: '실험', author: 'hit' }).id;
    const kept = ['/signin#SignIn', { screen: '/home#Home', reason: '홈을 거친다' }, { screen: '/lab#Lab', expects: ['실험 목록이 보인다'] }];
    const refusals: [string, unknown, string][] = [
      [comment, { name: 'x', screens: ['/signin#SignIn', { screen: '/nowhere', reason: 'x' }, kept[2]] }, 'screens 의 2 번째 단계의 /nowhere 는 맵에 없는 화면입니다\n'],
      [comment, { name: 'x', screens: [kept[0], kept[1], { screen: '/home#Home', reason: 'x' }, kept[2]] }, 'screens 의 2 번째와 3 번째가 같은 화면입니다\n'],
      ['no-such-id', { name: 'x', screens: kept }, '코멘트 no-such-id 가 없습니다\n'],
      [onNode, { name: 'x', screens: kept }, `코멘트 ${onNode} 는 화면 순서에 단 코멘트가 아닙니다\n`],
      [comment, { name: 'x', screens: [kept[0], kept[1], { screen: '/lab#Lab', expects: ['실험이 보인다'] }] }, 'screens 의 3 번째 단계 /lab#Lab 의 expects 는 검토자가 적은 줄이라 바꿀 수 없습니다\n'],
      [comment, '[1, 2]', 'the candidate in INPUT must be a JSON object with "name" and "screens"\n'],
    ];
    const { child, base, closed } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      for (const [id, body, stderr] of refusals) {
        const input = candidateInput(configFile, body);
        const expected = { status: 1, stdout: '', stderr: stderr.replace('INPUT', input) };
        assert.deepEqual(runCandidate(configFile, id, input), expected, stderr);
        assert.deepEqual(runCandidate(configFile, id, input, '--server', url), expected, `${stderr} --server`);
      }
      assert.deepEqual(storedCandidates(configFile), []);
      const missing = runCandidate(configFile, comment, path.join(path.dirname(configFile), 'no-such.json'));
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /^could not read the candidate from \S+no-such\.json: /);
      assert.match(runCandidate(configFile, comment, candidateInput(configFile, '{')).stderr, /^the candidate in \S+ is not JSON: /);
      assert.equal(runCandidate(configFile, comment).status, 2);
      assert.equal(runCandidate(configFile, comment, candidateInput(configFile, LAB_CANDIDATE), '--server').status, 2);
      await endReview(url);
      await within(closed, 'exit');
    } finally {
      child.kill();
    }
  });
});

test('a candidate sent with --server is written by the running review in the same shape as one written directly, the command prints the same lines, and open event streams hear the stories folder change', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const events = readEvents(url);
      await within(events.open, 'the event stream');
      const comment = orderComment(configFile, ['/signin#SignIn', '/lab#Lab']);
      const sent = runCandidate(configFile, comment, candidateInput(configFile, LAB_CANDIDATE), '--server', `${url}/`);
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, LAB_LINES);
      const [stored] = storedCandidates(configFile);
      assert.deepEqual([stored.name, stored.source.comment], [LAB_CANDIDATE.name, comment]);
      await waitFor(() => /event: stories\n/.test(events.got.text), 'a stories event');
      const { candidates } = (await (await fetch(`${url}/api/data`)).json()) as { candidates: { list: { name: string }[] } };
      assert.deepEqual(candidates.list.map((c) => c.name), [LAB_CANDIDATE.name]);
      await endReview(url);
      await within(closed, 'exit');
      const unreachable = runCandidate(configFile, comment, candidateInput(configFile, LAB_CANDIDATE), '--server', url);
      assert.equal(unreachable.status, 1);
      assert.match(unreachable.stderr, new RegExp(`^could not reach the review page at ${url}: [^\\n]+\\n$`));
    } finally {
      child.kill();
    }
  });
});

function startWait(configFile: string, server: string) {
  const child = spawn(process.execPath, [CLI, 'wait', configFile, '--server', server], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (c) => (out.stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c) => (out.stderr += c));
  const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => child.on('close', (code) => resolve({ code, ...out })));
  return { child, closed, out };
}

const lines = (stdout: string) => stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const endReview = (url: string) => fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

test('wait prints every unanswered comment already saved, oldest first, one JSON line each, and exits with 0; answered comments, marks and replies are left out', async () => {
  await withReviewFixture(async (configFile) => {
    const marksDir = path.join(path.dirname(configFile), 'example-marks');
    addMark(marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'No test.', author: 'a' }, new Date('2026-10-05T01:00:00Z'));
    const answered = addMark(marksDir, { target: { node: '/lab#Lab' }, note: 'Answered already?', author: 'a' }, new Date('2026-10-05T02:00:00Z'));
    const later = addMark(marksDir, { target: { node: '/home#Home' }, note: 'Second.', author: 'a' }, new Date('2026-10-05T04:00:00Z'));
    const earlier = addMark(marksDir, { target: { story: 'read-reports' }, note: 'First.', author: 'a' }, new Date('2026-10-05T03:00:00Z'));
    assert.deepEqual(reply(configFile, answered.id, 'Yes.'), { status: 0, stderr: '' });

    const { child, base, closed } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const { code, stdout } = await within(startWait(configFile, `${url}/`).closed, 'wait to exit');
      assert.equal(code, 0);
      assert.deepEqual(lines(stdout), [{ duru: 'comment', ...earlier }, { duru: 'comment', ...later }]);
      await endReview(url);
      await within(closed, 'exit');
    } finally {
      child.kill();
    }
  });
});

test('with no unanswered comment, wait says on stderr that it is waiting, skips marks and replies saved meanwhile, and exits with the next comment on stdout', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed } = startReview(configFile);
    const post = async (url: string, body: unknown) => (await (await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as Mark;
    try {
      const url = await within(base, 'review page address on stderr');
      const first = await post(url, { target: { node: '/lab#Lab' }, note: 'Answered before waiting.' });
      assert.deepEqual(reply(configFile, first.id, 'Done.', '--server', url), { status: 0, stderr: '' });
      const waiting = startWait(configFile, url);
      await waitFor(() => waiting.out.stderr.includes(`waiting for a comment at ${url}`), 'the waiting line on stderr');
      await post(url, { target: { node: '/lab#Lab' }, status: 'missing', note: 'No test.' });
      const key = { source: 'results/playwright/e2e.json', file: 'home.spec.ts', title: 'opens the lab' };
      const comment = await post(url, { target: { node: '/lab#Lab', part: { kind: 'test', key } }, note: 'Why is this pending?' });

      const { code, stdout } = await within(waiting.closed, 'wait to exit');
      assert.equal(code, 0);
      const where = { file: 'home.spec.ts', line: 20, source: 'results/playwright/e2e.json', status: 'pending', relation: 'tagged' };
      assert.deepEqual(lines(stdout), [{ duru: 'comment', ...comment, where }]);
      await endReview(url);
      await within(closed, 'exit');
    } finally {
      child.kill();
    }
  });
});

test('a change to the stories folder reaches open event streams but neither wait nor the JSON lines on the review\'s stderr: wait stays on its first connection and exits with the next comment', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed, out } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const events = readEvents(url);
      await events.open;
      const waiting = startWait(configFile, url);
      await waitFor(() => waiting.out.stderr.includes('waiting for a comment'), 'the waiting line on stderr');
      const storiesDir = path.join(path.dirname(configFile), 'example-stories');
      fs.writeFileSync(path.join(storiesDir, 'read-reports.json'), JSON.stringify({ name: '보고서를 고쳐 본다', screens: ['/admin/report#AdminReport'], author: 'a', date: '2026-10-03' }));
      await waitFor(() => events.got.text.includes('event: stories\n'), 'the stories event on the open stream');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(waiting.out.stdout, '');

      const comment = (await (await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { node: '/lab#Lab' }, note: 'After the stories changed.' }) })).json()) as Mark;
      const { code, stdout, stderr } = await within(waiting.closed, 'wait to exit');
      assert.equal(code, 0);
      assert.deepEqual(lines(stdout), [{ duru: 'comment', ...comment }]);
      assert.equal(stderr.match(/waiting for a comment/g)!.length, 1);
      assert.deepEqual(out.stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).id), [comment.id]);
      await endReview(url);
      await within(closed, 'exit');
    } finally {
      child.kill();
    }
  }, { storiesDir: 'example-stories' });
});

test('when the review ends, wait exits with 0, nothing on stdout and "review ended" on stderr; with no review page it gives up after about 10 seconds and exits with 1', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const waiting = startWait(configFile, url);
      await waitFor(() => waiting.out.stderr.includes('waiting for a comment'), 'the waiting line on stderr');
      await endReview(url);
      const { code, stdout, stderr } = await within(waiting.closed, 'wait to exit');
      assert.deepEqual({ code, stdout }, { code: 0, stdout: '' });
      assert.match(stderr, /^review ended$/m);
      await within(closed, 'exit');

      const started = Date.now();
      const gone = await Promise.race([startWait(configFile, url).closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('wait still running after 20s')), 20_000).unref())]);
      assert.equal(gone.code, 1);
      assert.equal(gone.stdout, '');
      assert.match(gone.stderr, new RegExp(`^could not reach the review page at ${url}: `));
      assert.ok(Date.now() - started >= 9_000, `gave up after ${Date.now() - started}ms`);
    } finally {
      child.kill();
    }
  });
});

test('wait treats Ctrl+C on the review as its end, but when the review stops without ending it connects again and gets the comment saved on the restarted review', async () => {
  await withReviewFixture(async (configFile) => {
    const first = startReview(configFile);
    let second: ReturnType<typeof startReview> | null = null;
    try {
      const url = await within(first.base, 'review page address on stderr');
      const port = Number(new URL(url).port);
      const waiting = startWait(configFile, url);
      await waitFor(() => waiting.out.stderr.includes('waiting for a comment'), 'the waiting line on stderr');
      first.child.kill('SIGKILL');
      await within(first.closed, 'the killed review to exit');
      second = startReview(configFile, port);
      await within(second.base, 'restarted review page address on stderr');
      const res = await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { node: '/home#Home' }, note: 'After the restart.' }) });
      const comment = (await res.json()) as Mark;
      const { code, stdout } = await within(waiting.closed, 'wait to exit');
      assert.equal(code, 0);
      assert.deepEqual(lines(stdout), [{ duru: 'comment', ...comment }]);

      assert.deepEqual(reply(configFile, comment.id, 'Seen.', '--server', url), { status: 0, stderr: '' });
      const again = startWait(configFile, url);
      await waitFor(() => again.out.stderr.includes('waiting for a comment'), 'the waiting line on stderr');
      second.child.kill('SIGINT');
      const ended = await within(again.closed, 'wait to exit');
      assert.deepEqual({ code: ended.code, stdout: ended.stdout }, { code: 0, stdout: '' });
      assert.match(ended.stderr, /^review ended$/m);
      await within(second.closed, 'exit');
    } finally {
      first.child.kill();
      second?.child.kill();
    }
  });
});

test('wait started before the review page keeps trying and gets the comment saved once the page is up', async () => {
  await withReviewFixture(async (configFile) => {
    const free = net.createServer().listen(0, '127.0.0.1');
    await new Promise((resolve) => free.on('listening', resolve));
    const port = (free.address() as AddressInfo).port;
    await new Promise((resolve) => free.close(resolve));
    const waiting = startWait(configFile, `http://127.0.0.1:${port}/`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const { child, base, closed } = startReview(configFile, port);
    try {
      const url = await within(base, 'review page address on stderr');
      const res = await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { node: '/home#Home' }, note: 'Is this tested?' }) });
      const comment = (await res.json()) as Mark;
      const { code, stdout } = await within(waiting.closed, 'wait to exit');
      assert.equal(code, 0);
      assert.deepEqual(lines(stdout), [{ duru: 'comment', ...comment }]);
      await endReview(url);
      await within(closed, 'exit');
    } finally {
      waiting.child.kill();
      child.kill();
    }
  });
});

function fakeSessionSocket() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-sock-'));
  const file = path.join(dir, 'session.sock');
  const connections: string[] = [];
  const server = net.createServer((conn) => {
    let text = '';
    conn.setEncoding('utf8').on('data', (c) => (text += c));
    conn.on('end', () => connections.push(text));
  });
  const ready = new Promise<void>((resolve) => server.listen(file, resolve));
  const close = () => new Promise<void>((resolve) => server.close(() => (fs.rmSync(dir, { recursive: true, force: true }), resolve())));
  return { file, connections, ready, close };
}

const saveMark = async (url: string, body: unknown) => {
  const res = await fetch(`${url}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 201);
  return (await res.json()) as Mark;
};

test('with a Claude Code session socket in its environment, review sends each saved comment to it as one message after the auth line, naming the config by its full path, and nothing for marks or replies', async () => {
  const session = fakeSessionSocket();
  await session.ready;
  try {
    await withReviewFixture(async (configFile) => {
      const { child, base, closed } = startReview('config.json', 0, { CLAUDE_CODE_MESSAGING_SOCKET: session.file, CLAUDE_CODE_MESSAGING_TOKEN: 'tok' }, path.dirname(configFile));
      try {
        const url = await within(base, 'review page address on stderr');
        await saveMark(url, { target: { node: '/lab#Lab' }, status: 'missing', note: 'No test.' });
        const comment = await saveMark(url, { target: { node: '/lab#Lab' }, note: 'Is the table tested?' });
        assert.deepEqual(reply(configFile, comment.id, 'Not yet.', '--server', url), { status: 0, stderr: '' });
        await waitFor(() => session.connections.length === 1, 'one connection on the session socket');
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(session.connections.length, 1);
        const [auth, message, rest] = session.connections[0].split('\n');
        assert.deepEqual(JSON.parse(auth), { type: 'auth', token: 'tok' });
        assert.equal(rest, '');
        const { type, message: { role, content } } = JSON.parse(message);
        assert.deepEqual({ type, role }, { type: 'user', role: 'user' });
        const [first, line] = content.split('\n');
        assert.equal(first, `duru review comment; answer it with duru reply ${JSON.stringify(fs.realpathSync(configFile))} ${comment.id} "<answer>" --server ${url}/`);
        assert.deepEqual(JSON.parse(line), { duru: 'comment', ...comment });
        await endReview(url);
        await within(closed, 'exit');
      } finally {
        child.kill();
      }
    });
  } finally {
    await session.close();
  }
});

test('a session socket that review cannot reach or cannot use leaves a line on stderr while the comment still goes to open event streams and the review goes on; with no socket there is no such line', async () => {
  const session = fakeSessionSocket();
  await session.ready;
  try {
    await withReviewFixture(async (configFile) => {
      const plain = startReview(configFile);
      try {
        const url = await within(plain.base, 'review page address on stderr');
        await saveMark(url, { target: { node: '/lab#Lab' }, note: 'No session here.' });
        await waitFor(() => plain.out.stderr.includes('No session here.'), 'the comment line on stderr');
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.doesNotMatch(plain.out.stderr, /could not send the comment/);
        await endReview(url);
        await within(plain.closed, 'exit');
      } finally {
        plain.child.kill();
      }

      const gone = startReview(configFile, 0, { CLAUDE_CODE_MESSAGING_SOCKET: `${session.file}.missing` });
      try {
        const url = await within(gone.base, 'review page address on stderr');
        await saveMark(url, { target: { node: '/lab#Lab' }, note: 'Still saved?' });
        await waitFor(() => /^could not send the comment to the Claude Code session: /m.test(gone.out.stderr), 'the line on stderr');
        await saveMark(url, { target: { node: '/home#Home' }, note: 'And this one?' });
        await endReview(url);
        const { code } = await within(gone.closed, 'exit');
        assert.equal(code, 0);
      } finally {
        gone.child.kill();
      }

      const bad = startReview(configFile, 0, { CLAUDE_CODE_MESSAGING_SOCKET: '99999' });
      try {
        const url = await within(bad.base, 'review page address on stderr');
        const events = readEvents(url);
        await within(events.open, 'the event stream to open');
        const saved = await saveMark(url, { target: { node: '/lab#Lab' }, note: 'Saved anyway?' });
        await waitFor(() => /^could not send the comment to the Claude Code session: /m.test(bad.out.stderr), 'the line on stderr');
        await waitFor(() => events.got.text.includes(saved.id), 'the comment on the event stream');
        await endReview(url);
        assert.equal((await within(bad.closed, 'exit')).code, 0);
      } finally {
        bad.child.kill();
      }
    });
  } finally {
    await session.close();
  }
});

test('review prints the author on stderr with where the name was read from', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      await fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const { stderr } = await within(closed, 'exit');
      assert.match(stderr, /^marks .* \| author 설정 이름 \(config\)$/m);
    } finally {
      child.kill();
    }
  }, { author: '설정 이름' });
});

test('when the task list cannot be built, ending the review reports it and the review keeps running until it can', async () => {
  await withReviewFixture(async (configFile) => {
    const { child, base, closed } = startReview(configFile);
    try {
      const url = await within(base, 'review page address on stderr');
      const broken = path.join(path.dirname(configFile), 'example-marks/broken.json');
      fs.writeFileSync(broken, '{');
      const endRequest = () => fetch(`${url}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

      const refused = await endRequest();
      assert.equal(refused.status, 500);
      assert.match(await refused.text(), /broken\.json/);
      child.kill('SIGINT');
      await within(new Promise<void>((resolve) => child.stderr.on('data', (c) => /broken\.json/.test(c) && resolve())), 'error on stderr');
      assert.equal((await fetch(`${url}/`)).status, 200);

      fs.rmSync(broken);
      assert.equal((await endRequest()).status, 200);
      const { code, stdout } = await within(closed, 'exit');
      assert.equal(code, 0);
      assert.equal(stdout, execFileSync(process.execPath, [CLI, 'tasks', configFile], { encoding: 'utf8' }));
    } finally {
      child.kill();
    }
  });
});
