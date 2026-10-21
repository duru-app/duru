import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { loadJudgments } from '../src/judgments.ts';
import { loadMarks } from '../src/marks.ts';
import { PAGE_PARTS, reviewAuthor } from '../src/review.ts';
import { FIXTURE, CLI, CASE_KINDS, withRebuiltFixture, withServer, postMark, postJudgment, initGitRepoNamed } from './review-helpers.ts';
import type { Config, PageData } from './review-helpers.ts';

const snapshot = (dir: string) =>
  Object.fromEntries((fs.readdirSync(dir, { recursive: true }) as string[]).sort().map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), 'utf8') : null]));

test('the page and its data are served, with the map, the tests per screen and the marks', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>duru 리뷰<\/title>/);

      const data = await (await fetch(`${base}/api/data`)).json();
      assert.equal(data.map.screens.length, 11);
      assert.ok(data.tests.nodes['/home#Home'].length > 0);
      assert.deepEqual(data.marks, { attached: [], detached: [] });
      assert.deepEqual(data.depths, ['ui', 'api', 'render', 'code', 'data', 'output']);
      assert.equal(data.author, 'reviewer');
      assert.equal(data.authorSource, 'config');
    }),
  );
});

test('the author is the config author, else the git user name of the config folder, else the computer user name, and says where it came from', () => {
  const config = { configDir: '/projects/app', author: null };
  const asked: string[] = [];
  const git = (name: string | null) => (dir: string) => { asked.push(dir); return name; };
  const user = () => 'kim';
  assert.deepEqual(reviewAuthor({ ...config, author: '설정 이름' }, { gitName: git('Git Name'), userName: user }), { name: '설정 이름', source: 'config' });
  assert.deepEqual(reviewAuthor(config, { gitName: git('Git Name'), userName: user }), { name: 'Git Name', source: 'git' });
  assert.deepEqual(reviewAuthor(config, { gitName: git(null), userName: user }), { name: 'kim', source: 'user' });
  assert.deepEqual(asked, ['/projects/app', '/projects/app']);
  const fallback = reviewAuthor(config, { gitName: git(null) });
  assert.equal(fallback.source, 'user');
  assert.ok(fallback.name.trim().length > 0);
});

const withConfigFile = <T>(patch: object, fn: (file: string) => T) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), ...patch }));
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('the config author is kept trimmed, and is null when the config has none', () => {
  withConfigFile({ author: '  Kim Min ' }, (file) => assert.equal(loadConfig(file).author, 'Kim Min'));
  withConfigFile({}, (file) => assert.equal(loadConfig(file).author, null));
});

for (const [name, author] of [['a number', 7], ['an empty string', ''], ['only spaces', '   ']]) {
  test(`a config author that is ${name} is rejected with what it should be`, () => {
    withConfigFile({ author }, (file) => assert.throws(() => loadConfig(file), (err: Error) => /^author must be .*"Kim Min"/.test(err.message) && err.message.endsWith(`not ${JSON.stringify(author)}`)));
  });
}

const signedWith = (config: Config) => [...loadMarks(config.marksDir), ...loadJudgments(config.judgmentsDir).judgments].map((saved) => saved.author);

async function assertNewSavesSignedAs(config: Config, name: string) {
  await withServer(config, undefined, async (base) => {
    assert.equal((await (await fetch(`${base}/api/data`)).json()).author, name);
    assert.equal((await postMark(base, { target: { node: '/lab#Lab' }, status: 'fine', author: 'typed name' })).status, 201);
    const test = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'renders the help text' };
    assert.equal((await postJudgment(base, { test, node: '/help#Help', kind: 'hand-over', reason: '', author: 'typed name' })).status, 201);
  });
  assert.deepEqual(signedWith(config), [name, name]);
}

test('without a config author, a mark and a judgment are signed with the git user name of the config folder', async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    initGitRepoNamed(copy, 'Git 이름');
    await assertNewSavesSignedAs(config, 'Git 이름');
  });
});

test('with no config author and no git user name, a mark and a judgment are signed with the computer user name', async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    const noHome = path.join(copy, 'no-home');
    const noGitName = { HOME: noHome, XDG_CONFIG_HOME: noHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
    const kept = Object.fromEntries(Object.keys(noGitName).map((key) => [key, process.env[key]]));
    Object.assign(process.env, noGitName);
    try {
      await assertNewSavesSignedAs(config, os.userInfo().username);
    } finally {
      for (const [key, value] of Object.entries(kept)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

const postCase = (base: string, body: unknown) => fetch(`${base}/api/cases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a mark or a case mark saved by the page is signed with the reviewer\'s name and carries no via, whatever author and via its body names', async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const forged = { author: 'agent', via: 'duru case' };
      assert.equal((await postMark(base, { target: { node: '/lab#Lab' }, status: 'missing', note: 'x', ...forged })).status, 201);
      assert.equal((await postMark(base, { target: { node: '/lab#Lab', case: 'legacy' }, status: 'needed', ...forged })).status, 201);
      assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.author, m.via]), [['reviewer', undefined], ['reviewer', undefined]]);
    }),
  );
});

test('a case sent to /api/cases is written by agent with via, whatever author its body names; a body that is no object, a kind or ID that is not text, a status other than needed or not-needed, or a note that is not text is refused with 400 and nothing is written', async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const fine = { kind: 'legacy', node: '/lab#Lab', status: 'needed', note: '' };
      const expected = 'expected { "kind", "node", "status", "note" } with the kind, the screen or call ID and the note as text and the status needed or not-needed';
      for (const body of [null, 5, 'legacy', [fine], { ...fine, kind: 5 }, { ...fine, kind: undefined }, { ...fine, node: null }, { ...fine, node: ['/lab#Lab'] }, { ...fine, status: 'missing' }, { ...fine, status: undefined }, { ...fine, note: 5 }, { ...fine, note: null }]) {
        const refused = await postCase(base, body);
        assert.equal(refused.status, 400, JSON.stringify(body));
        assert.equal(await refused.text(), expected);
      }
      const plain = await fetch(`${base}/api/cases`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(fine) });
      assert.equal(plain.status, 415);
      assert.equal(fs.existsSync(config.marksDir), false);

      const saved = await postCase(base, { ...fine, author: 'reviewer', via: 'page' });
      assert.equal(saved.status, 201);
      const [written] = loadMarks(config.marksDir);
      assert.deepEqual(await saved.json(), written);
      assert.deepEqual([written.target, written.status, written.author, written.via], [{ node: '/lab#Lab', case: 'legacy' }, 'needed', 'agent', 'duru case']);
      assert.equal((await postCase(base, { kind: 'legacy', node: '/help#Help', status: 'needed' })).status, 201);
    }),
  );
});

test('rebuilding the map leaves the marks untouched, and marks on screens that disappeared are detached', async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    await withServer(config, 'reviewer', async (base) => {
      await postMark(base, { target: { node: '/help#Help' }, status: 'missing' });
      await postMark(base, { target: { node: '/home#Home', depth: 'ui' }, status: 'fine' });
    });
    const before = snapshot(config.marksDir);

    const routes = path.join(copy, 'client/src/Routes.js');
    fs.writeFileSync(routes, fs.readFileSync(routes, 'utf8').replace(/^.*ROUTE_PATH\.HELP.*\n/m, ''));
    execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
    assert.deepEqual(snapshot(config.marksDir), before);

    await withServer(config, 'reviewer', async (base) => {
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.map((m) => m.key), ['/home#Home ui']);
      assert.deepEqual(data.marks.detached.map((m) => m.key), ['/help#Help']);
    });
  });
});

test('with an app address, only screens without path variables get a link to the real app', async () => {
  await withRebuiltFixture({ appUrl: 'https://app.example.test/' }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.appLinks, {
        '/signin#SignIn': 'https://app.example.test/signin',
        '/home#Home': 'https://app.example.test/home',
        '/document/:tab#DocumentList': null,
        '/document/:id#DocumentDetail': null,
        '/help#Help': 'https://app.example.test/help',
        '/admin/member#AdminMember': 'https://app.example.test/admin/member',
        '/admin/group#AdminGroup': 'https://app.example.test/admin/group',
        '/admin/audit#AdminAudit': 'https://app.example.test/admin/audit',
        '/admin/report#AdminReport': 'https://app.example.test/admin/report',
        '/lab#Lab': 'https://app.example.test/lab',
        '/lab/result#LabResult': 'https://app.example.test/lab/result',
      });
    }),
  );
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data = await (await fetch(`${base}/api/data`)).json();
      assert.ok(Object.values(data.appLinks).every((l) => l === null));
      assert.equal(data.app, null);
    }),
  );
});

test('the page reports a missing map instead of serving empty data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), outDir: 'nowhere' }));
    await withServer(loadConfig(configFile), 'reviewer', async (base) => {
      const res = await fetch(`${base}/api/data`);
      assert.equal(res.status, 500);
      assert.match(await res.text(), /run "duru rebuild" first/);
      const values = [
        await fetch(`${base}/api/path-values?screen=x`),
        await fetch(`${base}/api/path-values`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screen: 'x', typed: {} }) }),
      ];
      for (const reply of values) {
        assert.equal(reply.status, 500);
        assert.match(await reply.text(), /run "duru rebuild" first/);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('requests another site could send through the browser are refused', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const plain = await fetch(`${base}/api/marks`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ target: { node: '/lab#Lab' }, status: 'fine' }) });
      assert.equal(plain.status, 415);

      const port = new URL(base).port;
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/data', headers: { host: `attacker.example:${port}` } }, (res) => resolve(res.statusCode)).on('error', reject);
      });
      assert.equal(status, 403);
      assert.equal(fs.existsSync(config.marksDir), false);
    }),
  );
});

test('the page served at / is every file of src/review-page joined in the order the server lists them', async () => {
  const dir = path.join(import.meta.dirname, '../src/review-page');
  assert.deepEqual(fs.readdirSync(dir).sort(), [...PAGE_PARTS].sort());
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      assert.equal(await (await fetch(`${base}/`)).text(), PAGE_PARTS.map((part) => fs.readFileSync(path.join(dir, part), 'utf8')).join(''));
    }),
  );
});
