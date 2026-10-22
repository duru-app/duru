import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baselineTestsLines, compareTests, readBaselineTests } from '../src/baseline-tests.ts';
import type { BaselineTests } from '../src/baseline-tests.ts';
import { loadConfig } from '../src/config.ts';
import type { TestStatus } from '../src/verdict.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const MAP = { screens: ['/a#A', '/b#B', '/c#C'], calls: ['GET:/api/x', 'GET:/api/y'] };

type Run = { title: string; status: TestStatus; file?: string | null; line?: number | null; project?: string | null; tags?: string[] };
type Row = Run & { source?: string; format?: string; testFile?: string; level?: string; projects?: string[] };
type Now = Partial<Record<'nodes' | 'importers' | 'passed' | 'awaitingTag' | 'discarded' | 'stories', Record<string, Row[]>>> & { untagged?: Row[] };

const was = (...runs: Run[]): BaselineTests => ({
  folder: 'releases/1.5.0',
  label: '1.5.0',
  tests: runs.map((r) => ({ tags: [], file: 'a.spec.ts', line: 1, project: null, result: 'releases/1.5.0/e2e.json', ...r })),
});
const ran = (r: Row) => ({ tags: [], file: 'a.spec.ts', line: 1, project: null, source: 'results/e2e.json', format: 'playwright', ...r });
const now = (tests: Now) => Object.fromEntries(Object.entries(tests).map(([field, value]) => [field, Array.isArray(value) ? value.map(ran) : Object.fromEntries(Object.entries(value).map(([id, list]) => [id, list.map(ran)]))]));
const lines = (base: BaselineTests, tests: Now) => baselineTestsLines(compareTests(base, now(tests), MAP));
const summary = (compared: number, fail: number, pending: number, off: number, only: number, fresh: number) =>
  `test results since releases/1.5.0 | compared ${compared} | pass→fail ${fail} pass→pending ${pending} | not on a screen or call now ${off} | only in baseline ${only} | only now ${fresh}`;

test('a test that passed in the baseline and fails now is a pass→fail regression, and one that is pending now is pass→pending', () => {
  const base = was({ title: 'opens a', line: 3, project: 'chromium', status: 'pass' }, { title: 'waits on a', line: 5, project: 'chromium', status: 'pass' });
  assert.deepEqual(lines(base, { nodes: { '/a#A': [{ title: 'opens a @screen:/a#A', line: 3, project: 'chromium', status: 'fail' }, { title: 'waits on a @screen:/a#A', line: 5, project: 'chromium', status: 'pending' }] } }), [
    summary(2, 1, 1, 0, 0, 0),
    '  pass→fail ← a.spec.ts:3 opens a @screen:/a#A (chromium) — screen /a#A',
    '  pass→pending ← a.spec.ts:5 waits on a @screen:/a#A (chromium) — screen /a#A',
  ]);
});

test('fail→pass, pending→fail, fail→pending and fail→fail are compared but are not regressions', () => {
  const pairs: [TestStatus, TestStatus][] = [['fail', 'pass'], ['pending', 'fail'], ['fail', 'pending'], ['fail', 'fail']];
  const base = was(...pairs.map(([before], i) => ({ title: `t${i}`, line: i, status: before })));
  assert.deepEqual(lines(base, { nodes: { '/a#A': pairs.map(([, after], i) => ({ title: `t${i}`, line: i, status: after })) } }), [summary(4, 0, 0, 0, 0, 0)]);
});

test('a baseline test no current test matches is only in baseline, and a test under a screen now that no baseline test matches is only now, and neither is a regression', () => {
  const base = was({ title: 'kept', status: 'pass' }, { title: 'gone', status: 'pass' });
  assert.deepEqual(lines(base, { nodes: { '/a#A': [{ title: 'kept', status: 'pass' }, { title: 'new', status: 'fail' }] } }), [summary(1, 0, 0, 0, 1, 1)]);
});

test('the same title in two Playwright projects is two tests, each compared with the run of its own project', () => {
  const base = was({ title: 'opens a', project: 'chromium', status: 'pass' }, { title: 'opens a', project: 'firefox', status: 'fail' });
  assert.deepEqual(lines(base, { nodes: { '/a#A': [{ title: 'opens a', project: 'chromium', status: 'fail' }, { title: 'opens a', project: 'firefox', status: 'fail' }] } }), [
    summary(2, 1, 0, 0, 0, 0),
    '  pass→fail ← a.spec.ts:1 opens a (chromium) — screen /a#A',
  ]);
});

test('a test whose tag moved, or that was tagged after the release, is compared with its baseline run', () => {
  const base = was({ title: 'opens a @screen:/b#B', status: 'pass' }, { title: 'opens c', line: 2, status: 'pass' });
  assert.deepEqual(lines(base, { nodes: { '/a#A': [{ title: 'opens a @screen:/a#A', status: 'fail' }], '/c#C': [{ title: 'opens c @screen:/c#C', line: 2, status: 'fail' }] } }), [
    summary(2, 2, 0, 0, 0, 0),
    '  pass→fail ← a.spec.ts:1 opens a @screen:/a#A — screen /a#A',
    '  pass→fail ← a.spec.ts:2 opens c @screen:/c#C — screen /c#C',
  ]);
});

test('a test under a screen by its imports, by passing through it, by a call it sent, or handed over for tagging is compared, and a pair a reviewer discarded is not', () => {
  const base = was(
    { title: 'imports a', file: '/ci/src/a.test.js', status: 'pass' },
    { title: 'walks', file: 'walk.spec.ts', status: 'pass' },
    { title: 'handed', file: 'hand.spec.ts', status: 'pass' },
    { title: 'only discarded', file: 'gone.spec.ts', status: 'pass' },
  );
  const walks = { title: 'walks', file: 'walk.spec.ts', status: 'fail' as const };
  assert.deepEqual(lines(base, {
    importers: { '/a#A': [{ title: 'imports a', file: '/ci/src/a.test.js', testFile: 'a.test.js', format: 'vitest', status: 'fail' }] },
    passed: { '/b#B': [{ ...walks, level: 'interact' }], 'GET:/api/x': [{ ...walks, level: 'call' }] },
    discarded: { '/c#C': [walks, { title: 'only discarded', file: 'gone.spec.ts', status: 'fail' }] },
    awaitingTag: { '/c#C': [{ title: 'handed', file: 'hand.spec.ts', status: 'pending' }] },
  }), [
    summary(3, 2, 1, 1, 0, 0),
    '  pass→fail ← a.test.js:1 imports a — screen /a#A',
    '  pass→pending ← hand.spec.ts:1 handed — screen /c#C',
    '  pass→fail ← walk.spec.ts:1 walks — screen /b#B, call GET:/api/x',
  ]);
});

test('a test on two screens is compared once and its regression names both screens', () => {
  const run = { title: 'opens a and b @screen:/a#A @screen:/b#B', status: 'fail' as const };
  assert.deepEqual(lines(was({ title: 'opens a and b', status: 'pass' }), { nodes: { '/b#B': [run], '/a#A': [run] } }), [
    summary(1, 1, 0, 0, 0, 0),
    '  pass→fail ← a.spec.ts:1 opens a and b @screen:/a#A @screen:/b#B — screen /a#A, screen /b#B',
  ]);
});

test('the regression lines are ordered by test file, line, title and project, and each names every screen and call the test is on', () => {
  const runs: Run[] = [
    { title: 'z', file: 'b.spec.ts', line: 2, project: '', status: 'fail' },
    { title: 'z', file: 'a.spec.ts', line: 9, project: 'firefox', status: 'fail' },
    { title: 'z', file: 'a.spec.ts', line: 9, project: 'chromium', status: 'fail' },
    { title: 'y', file: 'a.spec.ts', line: 9, project: 'webkit', status: 'fail' },
    { title: 'Service › saves', file: 'com.example.Service', line: null, status: 'pending' },
  ];
  const base = was(...runs.map((r) => ({ ...r, status: 'pass' as const })));
  assert.deepEqual(lines(base, { nodes: { 'GET:/api/y': runs, '/b#B': runs, 'GET:/api/x': runs.slice(0, 1) } }), [
    summary(5, 4, 1, 0, 0, 0),
    '  pass→fail ← a.spec.ts:9 y (webkit) — screen /b#B, call GET:/api/y',
    '  pass→fail ← a.spec.ts:9 z (chromium) — screen /b#B, call GET:/api/y',
    '  pass→fail ← a.spec.ts:9 z (firefox) — screen /b#B, call GET:/api/y',
    '  pass→fail ← b.spec.ts:2 z — screen /b#B, call GET:/api/x, call GET:/api/y',
    '  pass→pending ← com.example.Service Service › saves — screen /b#B, call GET:/api/y',
  ]);
});

test('a skipped Playwright test left only in the untagged list counts as not on a screen or call now, not as only in baseline, and compared, not on a screen or call now and only in baseline add up to the baseline tests', () => {
  const base = was(
    { title: 'opens b', project: 'chromium', status: 'pass' },
    { title: 'opens b', project: 'firefox', status: 'pass' },
    { title: 'opens a', project: 'chromium', status: 'pass' },
    { title: 'gone', project: 'chromium', status: 'pass' },
  );
  assert.deepEqual(lines(base, {
    nodes: { '/a#A': [{ title: 'opens a @screen:/a#A', project: 'chromium', status: 'pass' }] },
    untagged: [{ title: 'opens b', projects: ['chromium', 'firefox'], status: 'pending' }],
  }), [summary(1, 0, 0, 2, 1, 0)]);
});

test('a test that passed through a screen in one project and ran without a trace in another is compared by the run of the first, and the run of the other is not on a screen or call now', () => {
  const base = was({ title: 'walks', project: 'chromium', status: 'pass' }, { title: 'walks', project: 'firefox', status: 'pass' });
  assert.deepEqual(lines(base, {
    passed: { '/b#B': [{ title: 'walks', project: 'chromium', status: 'pass', level: 'visit' }] },
    untagged: [{ title: 'walks', projects: ['chromium', 'firefox'], status: 'fail' }],
  }), [summary(1, 0, 0, 1, 0, 0)]);
});

test('tests of the same title in different files are told apart by the end of their paths, one folder deep or two', () => {
  const base = was(
    { title: 'renders', file: '/ci/app/src/a.test.js', status: 'pass' },
    { title: 'renders', file: '/ci/app/src/b.test.js', status: 'pass' },
    { title: 'replays', file: '/ci/app/src/entities/Replay/ReplayDSL.test.js', status: 'pass' },
    { title: 'replays', file: '/ci/app/src/workers/Evaluation/__tests__/ReplayDSL.test.js', status: 'pass' },
  );
  assert.deepEqual(lines(base, { importers: { '/a#A': [
    { title: 'renders', file: '/home/me/app/src/a.test.js', status: 'pass' },
    { title: 'renders', file: '/home/me/app/src/b.test.js', status: 'fail' },
    { title: 'replays', file: '/home/me/app/src/entities/Replay/ReplayDSL.test.js', status: 'pass' },
    { title: 'replays', file: '/home/me/app/src/workers/Evaluation/__tests__/ReplayDSL.test.js', status: 'pending' },
  ] } }), [
    summary(4, 1, 1, 0, 0, 0),
    '  pass→fail ← /home/me/app/src/b.test.js:1 renders — screen /a#A',
    '  pass→pending ← /home/me/app/src/workers/Evaluation/__tests__/ReplayDSL.test.js:1 replays — screen /a#A',
  ]);
});

test('verdict lines of the same name are told apart by their tags', () => {
  const verdict = (line: number, screen: string, status: TestStatus) => ({ title: 'cleanup', file: 'checks.log', line, tags: [`screen:${screen}`], status });
  const base = was(verdict(3, '/a#A', 'pass'), verdict(5, '/b#B', 'pass'));
  assert.deepEqual(lines(base, { nodes: { '/a#A': [verdict(3, '/a#A', 'fail')], '/b#B': [verdict(7, '/b#B', 'pass')] } }), [
    summary(2, 1, 0, 0, 0, 0),
    '  pass→fail ← checks.log:3 cleanup — screen /a#A',
  ]);
});

test('tests the same in title, project, path end and tags are one test with the worst status of their runs', () => {
  const verdict = (line: number, status: TestStatus) => ({ title: 'cleanup', file: 'checks.log', line, tags: ['screen:/a#A'], status });
  assert.deepEqual(lines(was(verdict(3, 'pass'), verdict(5, 'pass')), { nodes: { '/a#A': [verdict(3, 'pass'), verdict(8, 'pending')] } }), [
    summary(1, 0, 1, 0, 0, 0),
    '  pass→pending ← checks.log:3 cleanup — screen /a#A',
  ]);
});

test('a Jest test whose absolute path differs only before the checkout is the same test', () => {
  const base = was({ title: 'works', file: '/home/u1/repo/src/x/a.test.js', status: 'pass' }, { title: 'works', file: '/home/u1/repo/src/y/a.test.js', status: 'pass' });
  assert.deepEqual(lines(base, { importers: { '/a#A': [
    { title: 'works', file: '/builds/repo/src/x/a.test.js', status: 'pass' },
    { title: 'works', file: '/builds/repo/src/y/a.test.js', status: 'fail' },
  ] } }), [summary(2, 1, 0, 0, 0, 0), '  pass→fail ← /builds/repo/src/y/a.test.js:1 works — screen /a#A']);
});

test('a shared test run twice in two Vitest projects without a project name is one test with the worst status', () => {
  const shared = { title: 'formats', file: '/ci/shared/format.test.js', line: 4 };
  assert.deepEqual(lines(was({ ...shared, status: 'pass' }, { ...shared, status: 'pass' }), { importers: { '/a#A': [{ ...shared, status: 'pass' }, { ...shared, status: 'fail' }] } }), [
    summary(1, 1, 0, 0, 0, 0),
    '  pass→fail ← /ci/shared/format.test.js:4 formats — screen /a#A',
  ]);
});

test('a title shared by two tests of one file and one test of another file is split by the path end first, with the length either side needs', () => {
  const verdict = (file: string, line: number, status: TestStatus) => ({ title: 'cleanup', file, line, tags: ['screen:/a#A'], status });
  const base = was(verdict('document-checks.log', 3, 'pass'), verdict('document-checks.log', 9, 'pass'), verdict('storage-checks.txt', 2, 'pass'));
  assert.deepEqual(lines(base, { nodes: { '/a#A': [verdict('document-checks.log', 3, 'pass'), verdict('document-checks.log', 9, 'pass'), verdict('storage-checks.txt', 2, 'fail')] } }), [
    summary(2, 1, 0, 0, 0, 0),
    '  pass→fail ← storage-checks.txt:2 cleanup — screen /a#A',
  ]);
  const synced = (file: string, status: TestStatus) => ({ title: 'syncs', file, status });
  assert.deepEqual(lines(was(synced('/ci/a/x.test.js', 'pass')), { importers: { '/a#A': [synced('/me/a/x.test.js', 'fail'), synced('/me/b/x.test.js', 'pass')] } }), [
    summary(1, 1, 0, 0, 0, 1),
    '  pass→fail ← /me/a/x.test.js:1 syncs — screen /a#A',
  ]);
});

function inFolder(files: Record<string, unknown>, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-baseline-tests-'));
  try {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const playwrightReport = (title: string) => ({ suites: [{ title: 'a.spec.ts', specs: [{ title, file: 'a.spec.ts', line: 1, tests: [{ projectName: 'chromium', status: 'expected' }] }] }] });
const vitestReport = (title: string) => ({ testResults: [{ name: '/ci/src/a.test.js', assertionResults: [{ ancestorTitles: [], title, status: 'passed', location: { line: 1 } }] }] });

test('the baseline is named by the nearest folder holding every baselineTests path, as a path from the config folder, or in full outside it', () => {
  inFolder({ 'kept/1.5.0/e2e.json': playwrightReport('t'), 'project/releases/1.5.0/e2e.json': playwrightReport('t'), 'project/releases/1.5.0/unit/unit.json': vitestReport('u'), 'project/e2e.json': playwrightReport('t') }, (dir) => {
    const named = (...entries: [string, string][]) => {
      const { folder, label } = readBaselineTests({ configDir: path.join(dir, 'project'), baselineTests: entries.map(([format, p]) => ({ format, path: path.resolve(dir, 'project', p), depth: 'ui' })) });
      return [folder, label];
    };
    assert.deepEqual(named(['playwright', 'releases/1.5.0/e2e.json'], ['vitest', 'releases/1.5.0/unit']), ['releases/1.5.0', '1.5.0']);
    assert.deepEqual(named(['vitest', 'releases/1.5.0/unit']), ['releases/1.5.0/unit', 'unit']);
    assert.deepEqual(named(['playwright', 'e2e.json']), ['.', 'project']);
    assert.deepEqual(named(['playwright', '../kept/1.5.0/e2e.json']), [path.join(dir, 'kept/1.5.0'), '1.5.0']);
  });
});

type Copy = { copy: string; configFile: string; setConfig: (change: Record<string, unknown>) => void; rebuild: () => string };

function withCopy(fn: (copy: Copy) => void) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const setConfig = (change: Record<string, unknown>) => fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ...change }));
    const rebuild = () => execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    fn({ copy, configFile, setConfig, rebuild });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const readOut = (copy: string, name: string) => JSON.parse(fs.readFileSync(path.join(copy, 'out', name), 'utf8'));
const withoutDate = ({ meta, ...rest }: { meta: object }) => rest;
const BASELINE_TESTS = [
  { format: 'playwright', path: 'releases/1.5.0/playwright', depth: 'ui' },
  { format: 'junit', path: 'releases/1.5.0/junit', depth: 'api' },
  { format: 'vitest', path: 'releases/1.5.0/vitest', depth: 'code' },
  { format: 'verdict', path: 'releases/1.5.0/verdict', depth: 'api' },
];

function editJson(file: string, change: (json: any) => void) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(json);
  fs.writeFileSync(file, JSON.stringify(json));
}

// 기준은 지금 결과를 베껴 시험 둘을 통과로 바꾸고 하나를 지운 것이고, 지금 결과에서는 내보내기 보고서를 지운다.
function keepRelease(copy: string) {
  for (const folder of ['playwright', 'junit', 'vitest', 'verdict']) fs.cpSync(path.join(copy, 'results', folder), path.join(copy, 'releases/1.5.0', folder), { recursive: true });
  const kept = (file: string) => path.join(copy, 'releases/1.5.0', file);
  editJson(kept('vitest/client-unit.json'), (report) => {
    for (const r of report.testResults) for (const a of r.assertionResults) if (a.title === 'lists the documents it is given') a.status = 'passed';
  });
  editJson(kept('playwright/e2e.json'), (report) => {
    const lab = report.suites.flatMap((s: any) => s.specs).find((s: any) => s.title.startsWith('opens the lab'));
    for (const t of lab.tests) t.status = 'expected';
  });
  editJson(kept('vitest/unit.json'), (report) => {
    for (const r of report.testResults) r.assertionResults = r.assertionResults.filter((a: any) => a.title !== 'remembers the last user');
  });
  fs.rmSync(path.join(copy, 'results/playwright/export.json'));
}

const TEST_LINES = [
  'test results since releases/1.5.0 | compared 45 | pass→fail 1 pass→pending 1 | not on a screen or call now 14 | only in baseline 8 | only now 1',
  '  pass→fail ← components/DocumentTable.spec.js:6 DocumentTable › lists the documents it is given — screen /document/:tab#DocumentList, screen /home#Home',
  '  pass→pending ← home.spec.ts:20 opens the lab @screen:/lab#Lab (chromium) — screen /lab#Lab',
];
const testLines = (out: string) => out.split('\n').filter((l) => /^(test results since |  (pass→|no test was compared|only in baseline ←))/.test(l));

test('with baselineTests, rebuild prints the test results line right after the map comparison line and a line for each regression, the same on every run, and writes the same map.json and tests.json as without it', () => {
  withCopy(({ copy, setConfig, rebuild }) => {
    keepRelease(copy);
    const plain = rebuild();
    const [plainMap, plainTests] = [readOut(copy, 'map.json'), readOut(copy, 'tests.json')];
    fs.copyFileSync(path.join(copy, 'out/map.json'), path.join(copy, 'releases/1.5.0/map.json'));
    setConfig({ baselineMap: 'releases/1.5.0/map.json', baselineTests: BASELINE_TESTS });
    const first = rebuild();
    const mapLine = /^changes since \S+ \| screens new 0 removed 0 condition 0 calls-changed 0 \| calls new 0 removed 0 server 0$/;
    const out = first.split('\n');
    const at = out.findIndex((l) => mapLine.test(l));
    assert.deepEqual(out.slice(at + 1, at + 1 + TEST_LINES.length), TEST_LINES);
    assert.deepEqual(testLines(first), TEST_LINES);
    assert.deepEqual(out.filter((l, i) => i !== at && !TEST_LINES.includes(l)), plain.split('\n'));
    assert.match(first, /^screens with tests \d+\/11 \| tags pointing outside the map \d+ \| tests without a node or story tag 13$/m);
    assert.deepEqual(withoutDate(readOut(copy, 'map.json')), withoutDate(plainMap));
    assert.deepEqual(withoutDate(readOut(copy, 'tests.json')), withoutDate(plainTests));
    assert.equal(rebuild(), first);
  });
});

test('with baselineTests and no baselineMap, rebuild prints the same test lines', () => {
  withCopy(({ copy, setConfig, rebuild }) => {
    keepRelease(copy);
    setConfig({ baselineTests: BASELINE_TESTS });
    const out = rebuild();
    assert.doesNotMatch(out, /^changes since /m);
    assert.deepEqual(testLines(out), TEST_LINES);
    assert.match(out, /^entry screens [^\n]*\ntest results since /m);
  });
});

test('a baselineTests path that is missing stops rebuild with exit 1, naming the path, before anything is written', () => {
  withCopy(({ copy, configFile, setConfig }) => {
    setConfig({ baselineTests: [{ format: 'playwright', path: 'releases/gone/e2e.json', depth: 'ui' }] });
    assert.throws(() => execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8', stdio: 'pipe' }), (err: Error & { status: number; stdout: string; stderr: string }) => {
      assert.equal(err.status, 1);
      assert.equal(err.stdout, '');
      assert.equal(err.stderr.trim(), 'baselineTests releases/gone/e2e.json could not be read: it does not exist');
      return true;
    });
    assert.equal(fs.existsSync(path.join(copy, 'out')), false);
  });
});

test('a baselineTests item of an unknown format or depth stops the way tests does', () => {
  withCopy(({ configFile, setConfig }) => {
    setConfig({ baselineTests: [{ format: 'mocha', path: 'releases/1.5.0/e2e.json', depth: 'ui' }] });
    assert.throws(() => loadConfig(configFile), /^Error: baselineTests: unknown test format "mocha" \(expected one of playwright, junit, vitest, verdict\)$/);
    setConfig({ baselineTests: [{ format: 'playwright', path: 'releases/1.5.0/e2e.json', depth: 'e2e' }] });
    assert.throws(() => loadConfig(configFile), /^Error: baselineTests: unknown depth "e2e" for releases\/1\.5\.0\/e2e\.json \(expected one of /);
    setConfig({ baselineTests: [] });
    assert.equal(loadConfig(configFile).baselineTests, null);
  });
});
