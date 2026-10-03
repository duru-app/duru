import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.mjs');

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
    assert.match(stdout, /^screens with tests 7\/11 \| tags pointing outside the map 10 \| tests without a node or story tag 13$/m);
    assert.match(stdout, /^links from unit tests to screens by the files they import 5 \| test files not read 2$/m);
    assert.match(stdout, /^calls with tests 3\/10$/m);
    assert.doesNotMatch(stdout, /bodyOptions/);
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

async function withReviewFixture(fn) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), marksDir: 'example-marks' }));
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
        assert.match(stderr, /^marks .* \| author /m);
      } finally {
        child.kill();
      }
    });
  });
}

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
