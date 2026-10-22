import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baselineTestsLines, compareTests, readBaselineTests } from '../src/baseline-tests.ts';
import type { BaselineTests } from '../src/baseline-tests.ts';
import { loadConfig } from '../src/config.ts';
import { addJudgment, applyJudgments } from '../src/judgments.ts';
import type { TestStatus } from '../src/verdict.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const MAP = { screens: ['/a#A', '/b#B', '/c#C'], calls: ['GET:/api/x', 'GET:/api/y'] };

type Run = { title: string; status: TestStatus; file?: string | null; line?: number | null; project?: string | null; tags?: string[] };
type Row = Run & { source?: string; format?: string; testFile?: string; level?: string; projects?: Record<string, TestStatus> };
type Now = Partial<Record<'nodes' | 'importers' | 'passed' | 'awaitingTag' | 'discarded' | 'stories', Record<string, Row[]>>> & { untagged?: Row[] };

const was = (...runs: Run[]): BaselineTests => ({
  folder: 'releases/1.5.0',
  label: '1.5.0',
  results: [{ result: 'releases/1.5.0/e2e.json', startedAt: '2026-09-30T00:00:00.000Z' }],
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
    untagged: [{ title: 'opens b', projects: { chromium: 'pending', firefox: 'pending' }, status: 'pending' }],
  }), [summary(1, 0, 0, 2, 1, 0)]);
});

test('a test that passed through a screen in one project and ran without a trace in another is compared by the run of the first, and the run of the other is not on a screen or call now', () => {
  const base = was({ title: 'walks', project: 'chromium', status: 'pass' }, { title: 'walks', project: 'firefox', status: 'pass' });
  assert.deepEqual(lines(base, {
    passed: { '/b#B': [{ title: 'walks', project: 'chromium', status: 'pass', level: 'visit' }] },
    untagged: [{ title: 'walks', projects: { chromium: 'pass', firefox: 'fail' }, status: 'fail' }],
  }), [summary(1, 0, 0, 1, 0, 0)]);
});

test('a pair handed over from an untagged test that ran without a trace in two projects is compared project by project, each with the status of its own run', () => {
  const signs = { title: 'signs', file: 'sign.spec.ts', line: 5 };
  const handedOver = (projects: Record<string, TestStatus>, status: TestStatus) => applyJudgments(
    { untagged: [{ ...signs, tags: [], source: 'results/e2e.json', format: 'playwright', status, projects }] },
    [{ id: '1', date: '2026-10-01T00:00:00Z', author: 'r', reason: '', kind: 'hand-over', node: '/a#A', test: { source: 'results/e2e.json', file: 'sign.spec.ts', title: 'signs' } }],
  );
  const base = (webkit: TestStatus) => was({ ...signs, project: 'chromium', status: 'pass' }, { ...signs, project: 'webkit', status: webkit });
  assert.deepEqual(baselineTestsLines(compareTests(base('pass'), handedOver({ chromium: 'pass', webkit: 'fail' }, 'fail'), MAP)), [
    summary(2, 1, 0, 0, 0, 0),
    '  pass→fail ← sign.spec.ts:5 signs (webkit) — screen /a#A',
  ]);
  assert.deepEqual(baselineTestsLines(compareTests(base('pending'), handedOver({ chromium: 'pass', webkit: 'pending' }, 'pending'), MAP)), [summary(2, 0, 0, 0, 0, 0)]);
});

test('a pair a reviewer judged for a test that passed through a screen in two projects keeps the run of each project, whichever project the report lists first', () => {
  const signs = { title: 'signs', file: 'sign.spec.ts', line: 5, tags: [], source: 'results/e2e.json', format: 'playwright' };
  const judgedAs = (kind: string, projects: string[]) => applyJudgments(
    { passed: { '/a#A': projects.map((project) => ({ ...signs, project, status: project === 'webkit' ? 'fail' : 'pass', level: 'interact' })) }, untagged: [{ ...signs, status: 'fail', projects: { chromium: 'pass', webkit: 'fail' } }] },
    [{ id: '1', date: '2026-10-01T00:00:00Z', author: 'r', reason: 'r', kind, node: '/a#A', test: { source: 'results/e2e.json', file: 'sign.spec.ts', title: 'signs' } }],
  );
  const base = was({ ...signs, project: 'chromium', status: 'pass' }, { ...signs, project: 'webkit', status: 'pass' });
  for (const projects of [['chromium', 'webkit'], ['webkit', 'chromium']]) {
    assert.deepEqual(baselineTestsLines(compareTests(base, judgedAs('hand-over', projects), MAP)), [
      summary(2, 1, 0, 0, 0, 0),
      '  pass→fail ← sign.spec.ts:5 signs (webkit) — screen /a#A',
    ]);
    assert.deepEqual(baselineTestsLines(compareTests(base, judgedAs('discard', projects), MAP))[0], summary(0, 0, 0, 2, 0, 0));
  }
  const story = { ...signs, title: 'signs @story:sign', tags: ['story:sign'] };
  const fromStory = applyJudgments(
    { stories: { sign: [{ ...story, project: 'chromium', status: 'pass' }, { ...story, project: 'webkit', status: 'fail' }] }, nodes: {} },
    [{ id: '1', date: '2026-10-01T00:00:00Z', author: 'r', reason: '', kind: 'hand-over', node: '/a#A', test: { source: 'results/e2e.json', file: 'sign.spec.ts', title: 'signs' } }],
  );
  assert.deepEqual(baselineTestsLines(compareTests(base, fromStory, MAP)), [
    summary(2, 1, 0, 0, 0, 0),
    '  pass→fail ← sign.spec.ts:5 signs @story:sign (webkit) — screen /a#A',
  ]);
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

test('runs made one test where only some are under a screen count as under it, and the regression shows the first place among those', () => {
  const formats = (file: string, line: number, status: TestStatus) => ({ title: 'formats', file, line, format: 'vitest', status });
  const base = was(formats('/ci/f.test.js', 2, 'pass'), formats('/ci/f.test.js', 8, 'pass'));
  assert.deepEqual(lines(base, { importers: { '/a#A': [formats('/me/f.test.js', 8, 'fail')] }, discarded: { '/b#B': [formats('/me/f.test.js', 2, 'pass')] } }), [
    summary(1, 1, 0, 0, 0, 0),
    '  pass→fail ← /me/f.test.js:8 formats — screen /a#A',
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
  const moved = { ...shared, file: '/builds/repo/shared/format.test.js' };
  assert.deepEqual(lines(was({ ...shared, status: 'pass' }, { ...shared, status: 'pass' }), { importers: { '/a#A': [{ ...moved, status: 'pass' }, { ...moved, status: 'fail' }] } }), [
    summary(1, 1, 0, 0, 0, 0),
    '  pass→fail ← /builds/repo/shared/format.test.js:4 formats — screen /a#A',
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

test('a current test whose tags name only screens or calls the map does not have is not on a screen or call now, in every project its baseline ran in, and a test that also has a tag the map does not know is compared once', () => {
  const base = was({ title: 'old settings @screen:/z#Z', project: 'chromium', status: 'pass' }, { title: 'old settings @screen:/z#Z', project: 'firefox', status: 'pass' }, { title: 'kept', line: 2, status: 'pass' });
  const unknownTags = [
    { tag: 'screen:/z#Z', test: { title: 'old settings @screen:/z#Z', file: 'a.spec.ts', line: 1 } },
    { tag: 'depth:e2e', test: { title: 'kept @screen:/a#A @depth:e2e', file: 'a.spec.ts', line: 2 } },
  ];
  const comparison = compareTests(base, { ...now({ nodes: { '/a#A': [{ title: 'kept @screen:/a#A @depth:e2e', line: 2, status: 'fail' }] } }), unknownTags }, MAP);
  assert.deepEqual(baselineTestsLines(comparison), [summary(1, 1, 0, 2, 0, 0), '  pass→fail ← a.spec.ts:2 kept @screen:/a#A @depth:e2e — screen /a#A']);
  assert.deepEqual(comparison.onlyInBaselineFiles, []);
});

test('a baseline test only in the baseline is listed under each screen or call on the map its tags name, and under none when its tags name a screen the map does not have', () => {
  const base = was({ title: 'gone @screen:/a#A', tags: ['screen:/a#A', 'call:GET:/api/x'], line: 4, status: 'pass' }, { title: 'gone too', tags: ['screen:/z#Z'], line: 9, status: 'fail' });
  const { onlyInBaselineByNode } = compareTests(base, now({ nodes: { '/b#B': [{ title: 'kept', status: 'pass' }] } }), MAP);
  const gone = { title: 'gone @screen:/a#A', tail: 'a.spec.ts', line: 4, project: null, status: 'pass', result: 'releases/1.5.0/e2e.json', nodes: ['/a#A', 'GET:/api/x'] };
  assert.deepEqual(onlyInBaselineByNode, { '/a#A': [gone], 'GET:/api/x': [gone] });
});

test('a test file none of whose tests are in the current results is one whole missing file, and a file with a test left is not', () => {
  const base = was(
    { title: 'one', file: 'gone.spec.ts', line: 2, status: 'pass' },
    { title: 'two', file: 'gone.spec.ts', line: 1, status: 'fail' },
    { title: 'three', file: 'left.spec.ts', status: 'pass' },
    { title: 'four', file: 'left.spec.ts', line: 3, status: 'pass' },
  );
  const comparison = compareTests(base, now({ nodes: { '/a#A': [{ title: 'three', file: 'left.spec.ts', status: 'pass' }] } }), MAP);
  assert.deepEqual(baselineTestsLines(comparison), [summary(1, 0, 0, 0, 3, 0), "  only in baseline ← gone.spec.ts: 2 tests, none of this file's tests are in the current results"]);
  assert.deepEqual(comparison.onlyInBaselineFiles.map((f) => [f.tail, f.whole, f.tests.map((t) => t.title)]), [['gone.spec.ts', true, ['two', 'one']], ['left.spec.ts', false, ['four']]]);
});

test('a baseline test file one of whose tests is compared is never whole missing, even when its end must reach the checkout folder', () => {
  const run = (title: string, file: string) => ({ title, file, status: 'pass' as const });
  const base = was(run('a', '/ci/app-release/index.test.js'), run('gone', '/ci/app-release/index.test.js'), run('b', '/ci/app-release/lib/index.test.js'));
  const comparison = compareTests(base, now({ importers: { '/a#A': [run('a', '/home/me/app/index.test.js'), run('b', '/home/me/app/lib/index.test.js')] } }), MAP);
  assert.deepEqual(baselineTestsLines(comparison), [summary(2, 0, 0, 0, 1, 0)]);
  assert.deepEqual(comparison.onlyInBaselineFiles.map((f) => [f.whole, f.tests.map((t) => t.title)]), [[false, ['gone']]]);
});

test('with nothing compared the comparison prints a line saying no baseline test matched', () => {
  assert.deepEqual(lines(was({ title: 'old', status: 'pass' }), { untagged: [{ title: 'old', status: 'fail' }], nodes: { '/a#A': [{ title: 'new', status: 'fail' }] } }), [
    summary(0, 0, 0, 1, 0, 1),
    '  no test was compared: no baseline test matches a test under a screen or call now',
  ]);
});

test('a Jest test file whose absolute path differs only before the checkout is not missing, even beside files deeper down that need a longer end to tell apart, and a gone file is missing beside current files of its name in other folders', () => {
  const base = was(...[['/home/u1/repo/a.test.js', 'one'], ['/home/u1/repo/x/deep/b.test.js', 'two'], ['/home/u1/repo/y/deep/b.test.js', 'three'], ['/home/u1/repo/gone.test.js', 'four']]
    .map(([file, title]) => ({ title, file, status: 'pass' as const })));
  const renamed = [['/builds/repo/a.test.js', 'one'], ['/builds/repo/x/deep/b.test.js', 'two'], ['/builds/repo/y/deep/b.test.js', 'three']].map(([file, title]) => ({ title: `${title} renamed`, file, status: 'pass' as const }));
  assert.deepEqual(lines(base, { importers: { '/a#A': renamed } }), [
    summary(0, 0, 0, 0, 4, 3),
    '  no test was compared: no baseline test matches a test under a screen or call now',
    "  only in baseline ← gone.test.js: 1 test, none of this file's tests are in the current results",
  ]);
  const syncs = (title: string, file: string) => ({ title, file, status: 'pass' as const });
  assert.deepEqual(lines(was(syncs('old', '/ci/a/x.test.js')), { importers: { '/a#A': [syncs('new', '/me/b/x.test.js'), syncs('newer', '/me/c/x.test.js')] } }), [
    summary(0, 0, 0, 0, 1, 2),
    '  no test was compared: no baseline test matches a test under a screen or call now',
    "  only in baseline ← x.test.js: 1 test, none of this file's tests are in the current results",
  ]);
});

test('a regression on a row that only passed through a screen or only sent a call shows on that row but is not counted for the screen list', () => {
  const walks = { title: 'walks', status: 'fail' as const };
  const comparison = compareTests(was({ title: 'walks', status: 'pass' }, { title: 'handed', line: 2, status: 'pass' }), now({
    passed: { '/a#A': [{ ...walks, level: 'visit' }], 'GET:/api/x': [{ ...walks, level: 'call' }], '/b#B': [{ ...walks, level: 'interact' }] },
    awaitingTag: { '/c#C': [{ title: 'handed', line: 2, status: 'pending', level: 'visit' }] },
  }), MAP);
  const none = { fail: 0, pending: 0 };
  assert.deepEqual(comparison.byNode, {
    '/a#A': { listed: none, chipOnly: { fail: 1, pending: 0 } },
    'GET:/api/x': { listed: none, chipOnly: { fail: 1, pending: 0 } },
    '/b#B': { listed: { fail: 1, pending: 0 }, chipOnly: none },
    '/c#C': { listed: { fail: 0, pending: 1 }, chipOnly: none },
  });
  const walked = comparison.regressions.find((r) => r.test.title === 'walks')!;
  assert.deepEqual(walked.rows.map((r) => [r.node, r.via, r.level, r.listed]), [['/a#A', 'trace', 'visit', false], ['/b#B', 'trace', 'interact', true], ['GET:/api/x', 'trace', 'call', false]]);
  assert.deepEqual(walked.baseline, [{ result: 'releases/1.5.0/e2e.json', startedAt: '2026-09-30T00:00:00.000Z' }]);
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

test('baselineTests gives each result file its start time: Playwright stats.startTime, Vitest or Jest startTime, and the file\'s modified time for JUnit, verdict logs and a report that has none', () => {
  const junit = '<testsuite name="S"><testcase classname="com.example.T" name="t"/></testsuite>';
  inFolder({
    'releases/1.5.0/e2e.json': { ...playwrightReport('t'), stats: { startTime: '2026-09-30T09:00:00.000+09:00' } },
    'releases/1.5.0/export.json': playwrightReport('u'),
    'releases/1.5.0/unit.json': { ...vitestReport('v'), startTime: 1767603600000 },
    'releases/1.5.0/TEST-T.xml': junit,
    'releases/1.5.0/checks.log': 'VERDICT w: UPHOLDS\n',
  }, (dir) => {
    const modified = new Date('2026-10-01T12:00:00Z');
    for (const file of ['export.json', 'TEST-T.xml', 'checks.log']) fs.utimesSync(path.join(dir, 'releases/1.5.0', file), modified, modified);
    const read = readBaselineTests({ configDir: dir, baselineTests: [['playwright', 'e2e.json'], ['playwright', 'export.json'], ['vitest', 'unit.json'], ['junit', 'TEST-T.xml'], ['verdict', 'checks.log']].map(([format, file]) => ({ format, path: path.join(dir, 'releases/1.5.0', file), depth: 'ui' })) });
    const at = (file: string) => path.join('releases/1.5.0', file);
    assert.deepEqual(read.results, [
      { result: at('e2e.json'), startedAt: '2026-09-30T00:00:00.000Z' },
      { result: at('export.json'), startedAt: '2026-10-01T12:00:00.000Z' },
      { result: at('unit.json'), startedAt: '2026-01-05T09:00:00.000Z' },
      { result: at('TEST-T.xml'), startedAt: '2026-10-01T12:00:00.000Z' },
      { result: at('checks.log'), startedAt: '2026-10-01T12:00:00.000Z' },
    ]);
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
  'test results since releases/1.5.0 | compared 45 | pass→fail 1 pass→pending 1 | not on a screen or call now 17 | only in baseline 5 | only now 1',
  '  pass→fail ← components/DocumentTable.spec.js:6 DocumentTable › lists the documents it is given — screen /document/:tab#DocumentList, screen /home#Home',
  '  pass→pending ← home.spec.ts:20 opens the lab @screen:/lab#Lab (chromium) — screen /lab#Lab',
  "  only in baseline ← export.spec.ts: 5 tests, none of this file's tests are in the current results",
];
const testLines = (out: string) => out.split('\n').filter((l) => /^(test results since |  (pass→|no test was compared|only in baseline ←))/.test(l));

test('with baselineTests, rebuild prints the test results line right after the map comparison line, a line for each regression and for each test file gone, the same on every run, and writes the same map.json and tests.json as without it', () => {
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

test('without baselineTests, a current result file that cannot be read stops rebuild after the map comparison line and the case kind lines', () => {
  withCopy(({ copy, configFile, setConfig, rebuild }) => {
    rebuild();
    fs.copyFileSync(path.join(copy, 'out/map.json'), path.join(copy, 'releases-map.json'));
    setConfig({ baselineMap: 'releases-map.json', caseKinds: { ended: { text: '끝난 문서', picks: [{ methods: ['DELETE'] }] } } });
    fs.writeFileSync(path.join(copy, 'results/playwright/e2e.json'), '{ "suites": [');
    const run = spawnSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /cannot read Playwright report /);
    assert.deepEqual(run.stdout.trimEnd().split('\n').slice(-3), [
      `changes since ${path.join(copy, 'releases-map.json')} | screens new 0 removed 0 condition 0 calls-changed 0 | calls new 0 removed 0 server 0`,
      `case kind ended: rules pick 0 screens, 0 calls | new since ${path.join(copy, 'releases-map.json')} 0`,
      '  caseKinds ended picks[0] matches no call: {"methods":["DELETE"]}',
    ]);
  });
});

test('a baselineTests path that is missing, a result file that cannot be read, or an item that gives no test stops rebuild with exit 1, naming the path, before anything is written', () => {
  withCopy(({ copy, configFile, setConfig }) => {
    const stopped = (said: string) => {
      const run = spawnSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
      assert.equal(run.status, 1, run.stderr);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr.trim(), said);
      assert.equal(fs.existsSync(path.join(copy, 'out')), false);
    };
    setConfig({ baselineTests: [{ format: 'playwright', path: 'releases/1.5.0/e2e.json', depth: 'ui' }] });
    stopped('baselineTests releases/1.5.0/e2e.json could not be read: it does not exist');
    const report = path.join(copy, 'releases/1.5.0/e2e.json');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, '{ "suites": [');
    const broken = (() => { try { JSON.parse('{ "suites": ['); } catch (err) { return (err as Error).message; } })();
    stopped(`baselineTests releases/1.5.0/e2e.json could not be read: cannot read Playwright report ${report}: ${broken}`);
    fs.writeFileSync(report, JSON.stringify({ cookies: [] }));
    stopped('baselineTests releases/1.5.0/e2e.json could not be read: it holds no playwright test result');
    fs.mkdirSync(path.join(copy, 'releases/1.5.0/verdict'));
    fs.writeFileSync(path.join(copy, 'releases/1.5.0/verdict/notes.log'), 'no verdict here\n');
    fs.writeFileSync(report, JSON.stringify(playwrightReport('t')));
    setConfig({ baselineTests: [{ format: 'playwright', path: 'releases/1.5.0/e2e.json', depth: 'ui' }, { format: 'verdict', path: 'releases/1.5.0/verdict', depth: 'api' }] });
    stopped('baselineTests releases/1.5.0/verdict could not be read: it holds no verdict test result');
  });
});

test('a folder in baselineTests skips files of another format and verdict logs with no verdict line', () => {
  withCopy(({ copy, setConfig, rebuild }) => {
    keepRelease(copy);
    fs.mkdirSync(path.join(copy, 'releases/1.5.0/playwright/.auth'));
    fs.writeFileSync(path.join(copy, 'releases/1.5.0/playwright/.auth/user.json'), JSON.stringify({ cookies: [], origins: [] }));
    fs.writeFileSync(path.join(copy, 'releases/1.5.0/verdict/documents/notes.log'), 'checked by hand, no verdict\n');
    setConfig({ baselineTests: BASELINE_TESTS });
    assert.deepEqual(testLines(rebuild()), TEST_LINES);
  });
});

test('extract, undecided and tasks run as before with a broken baselineTests', () => {
  withCopy(({ configFile, setConfig, rebuild }) => {
    rebuild();
    setConfig({ baselineTests: [{ format: 'playwright', path: 'releases/gone/e2e.json', depth: 'ui' }] });
    for (const command of ['extract', 'undecided', 'tasks']) execFileSync(process.execPath, [CLI, command, configFile], { encoding: 'utf8' });
  });
});

test('rebuild leaves out a pair a reviewer discarded and compares a pair handed over for tagging of the same test', () => {
  withCopy(({ copy, configFile, setConfig, rebuild }) => {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    setConfig({ tests: [...config.tests, { format: 'playwright', path: 'results/playwright-traced', depth: 'ui' }], baselineTests: [{ format: 'playwright', path: 'releases/1.5.0/visits.json', depth: 'ui' }] });
    fs.mkdirSync(path.join(copy, 'releases/1.5.0'), { recursive: true });
    fs.copyFileSync(path.join(copy, 'results/playwright-traced/visits.json'), path.join(copy, 'releases/1.5.0/visits.json'));
    const title = 'follows a link while waiting for the new address';
    editJson(path.join(copy, 'results/playwright-traced/visits.json'), (report) => {
      for (const t of report.suites.flatMap((s: any) => s.specs).find((s: any) => s.title === title).tests) t.status = 'unexpected';
    });
    const judgmentsDir = path.join(copy, 'out/judgments');
    const followed = { source: 'results/playwright-traced/visits.json', file: 'visits.spec.ts', title };
    addJudgment(judgmentsDir, { test: followed, node: '/home#Home', kind: 'discard', reason: 'only starts there', author: 'a' });
    addJudgment(judgmentsDir, { test: followed, node: '/help#Help', kind: 'hand-over', author: 'a' });
    assert.deepEqual(testLines(rebuild()).filter((l) => l.startsWith('  pass→')), [`  pass→fail ← visits.spec.ts:34 ${title} (chromium) — screen /help#Help`]);
  });
});

test('a baselineTests that is not a list, or an item that is not an object with a path, stops with what to write', () => {
  withCopy(({ configFile, setConfig }) => {
    for (const baselineTests of ['releases', {}, [null], [{ format: 'playwright' }]]) {
      setConfig({ baselineTests });
      assert.throws(() => loadConfig(configFile), new RegExp(`^Error: baselineTests must be a list of \\{ "format", "path", "depth" \\} like tests, such as \\[\\{ "format": "playwright", "path": "releases/1\\.5\\.0/e2e\\.json", "depth": "ui" \\}\\], not ${JSON.stringify(baselineTests).replace(/[[\]{}.]/g, '\\$&')}$`));
    }
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

test('the README and the decision record say what baselineTests takes, what the test results line and each of its words mean, how to keep the results of a release, and why the comparison is made this way', () => {
  const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
  const readme = read('../README.md').replace(/\n {2}(?=\S)/g, ' ');
  assert.match(readme, /- `baselineTests` — the test results of an earlier version of the same client \(optional\), written like `tests`/);
  assert.match(readme, /An empty list compares nothing and prints no line about it\./);
  assert.match(readme, /straight into that version's folder[\s\S]*`cp -p`[\s\S]*only some of the tests leaves the rest as `only in baseline`/);
  assert.match(readme, /by their title without tags and their Playwright project, so a test renamed or moved to another file counts once in\s+`only in baseline` and once in `only now`/);
  assert.match(readme, /- `test results since <folder> \| compared N \| pass→fail N pass→pending N \| not on a screen or call now N \| only in baseline N \| only now N` —/);
  assert.match(readme, /now\s+did not run or gave no verdict; a `pass→pending` test may have been skipped because a test before it in a `serial`\s+group, or a `setup` project it depends on, failed/);
  assert.match(readme, /When `not on a screen or call now` is large/);
  assert.match(readme, /`compared`, `not on a screen or call now` and `only in baseline` add up to the tests of the baseline/);
  assert.match(readme, /- `  no test was compared: no baseline test matches a test under a screen or call now` —/);
  assert.match(readme, /- `  pass→fail ← <test file>:<line> <title> \(<project>\) — screen <id>, call <id>, …` —/);
  assert.match(readme, /- `  only in baseline ← <file>: N tests, none of this file's tests are in the current results` —/);
  assert.match(readme, /`baselineTests <path> could not be read: <why>`/);
  assert.match(readme, /An untagged Playwright test carries the projects it ran\s+in as `projects`, each with the worst status of the test's runs in it\./);
  const decisions = read('../docs/decisions.md');
  assert.match(decisions, /\*\*`baselineTests` names the result files kept from an earlier release in the shape of `tests`/);
  assert.match(decisions, /the shortest end that tells apart every different file in the group/);
  assert.match(decisions, /- One end length for the whole group, as the PRD reads word for word:/);
});
