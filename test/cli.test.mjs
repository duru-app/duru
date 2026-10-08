import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addJudgment } from '../src/judgments.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');

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
      '/document/:tab_draft_done_#DocumentList',
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
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

function rebuildTraced(change = () => {}) {
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
    assert.match(plain, /^stories passing 0 \| failing 0 \| pending 0 \| partly covered 0 \| no tests 0$/m);
    assert.match(plain, /^ {2}unknown story:run-lab ← com\.example\.lab\.LabFlowTest:null /m);

    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), storiesDir: 'example-stories' }));
    const lab = path.join(copy, 'client/src/components/Lab.js');
    fs.writeFileSync(lab, fs.readFileSync(lab, 'utf8').replace('</section>', '  <Link to={Option.ROUTE_PATH.NOPE}>Nope</Link>\n    </section>'));
    fs.writeFileSync(path.join(copy, 'example-stories/lab-to-sign-in.json'), JSON.stringify({ name: 'n', screens: ['/lab#Lab', '/signin#SignIn'], author: 'a', date: '2026-10-02' }));
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(stdout, /^stories 6 \| broken paths 1 \| detached 1 \| unjudged steps 1 \| story files skipped 1$/m);
    assert.match(stdout, /^stories passing 1 \| failing 1 \| pending 1 \| partly covered 2 \| no tests 1$/m);
    assert.match(stdout, /^ {2}unknown story:print-document ← stories\.spec\.ts:12 prints a document @story:print-document$/m);
    assert.doesNotMatch(stdout, /unknown story:run-lab/);
    assert.match(stdout, /^ {2}story file lab-shortcut\.json: screens 는 /m);
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

function rebuildWithHandOvers(handOvers, check) {
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
    assert.match(line, /^  handed over for \/gone#Gone, which is not on the map ← a check without a file \(delete /);
  });
});

test('rebuild counts the story candidates from the visit records and names each record or discarded candidate file it skipped and why', () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    const plain = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(plain, /^story candidates 0 \| files skipped 0$/m);

    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), storiesDir: 'example-stories', visitRecords: ['example-visits'] }));
    const stdout = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    assert.match(stdout, /^story candidates 2 \| files skipped 1$/m);
    assert.match(stdout, /^ {2}example-visits\/broken-record\.json: 2 번째 단계의 url 을 읽지 못했습니다$/m);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

for (const args of [['nope', 'x.json'], ['extract', 'x.json', 'out.json'], ['rebuild', 'x.json', '--port', '5000'], ['tasks', 'x.json', '--port', '5000'], ['review', 'x.json', '--port', 'abc']]) {
  test(`"${args.join(' ')}" prints usage and exits with 2`, () => {
    assert.throws(
      () => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }),
      (err) => err.status === 2 && /usage: duru <extract\|rebuild\|tasks>/.test(err.stderr),
    );
  });
}

const within = (promise, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no ${what} within 10s`)), 10_000).unref())]);

async function withReviewFixture(fn, patch = {}) {
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

function startReview(configFile) {
  const child = spawn(process.execPath, [CLI, 'review', configFile, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (c) => (out.stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c) => (out.stderr += c));
  const closed = new Promise((resolve) => child.on('close', (code) => resolve({ code, ...out })));
  const base = new Promise((resolve, reject) => {
    child.stderr.on('data', () => {
      const m = out.stderr.match(/^review page (http:\/\/\S+?)\/?$/m);
      if (m) resolve(m[1]);
    });
    closed.then(() => reject(new Error(`review ended before printing its address:\n${out.stderr}`)));
  });
  return { child, base, closed };
}

for (const [how, end] of [
  ['the end request', (child, base) => fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })],
  ['Ctrl+C', (child) => child.kill('SIGINT')],
]) {
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
      await within(new Promise((resolve) => child.stderr.on('data', (c) => /broken\.json/.test(c) && resolve())), 'error on stderr');
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
