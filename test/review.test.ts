import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { UNKNOWN } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { chromium } from 'playwright-core';
import type { Locator, Page, Route } from 'playwright-core';
import { addJudgment, loadJudgments } from '../src/judgments.ts';
import { addMark, addReply, loadMarks } from '../src/marks.ts';
import { applyOverrides } from '../src/app-host.ts';
import { reviewAuthor, startReviewServer } from '../src/review.ts';
import type { ReviewAuthor } from '../src/review.ts';
import { taskList } from '../src/tasks.ts';

// git exports these to hooks and to rebase --exec; with them set, git in a test folder reads and writes the repository they name.
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');

type Config = ReturnType<typeof loadConfig>;

type Guard = { guard: string; kinds: string[]; roles?: string[] | null; settings?: object[]; via?: unknown };
type FlowNode = { id: string; imported?: number; label: string; component: string; counts?: object; children: FlowNode[]; calls: { label: string; server?: object; counts?: object }[]; jumps: { to: string; label: string; guards: Guard[] }[]; guards: Guard[] | null };
type ScreenLink = { from: string; file: string; line: number; guards: Guard[]; fromKinds: string[] };
type MapScreen = { id: string; path: string; component: string; componentFile?: string; dead?: boolean; routeGuards: string[]; access: { links: ScreenLink[] }; links?: object[]; settingReads?: object[]; apiCalls: object[] };
type Story = { id: string; name: string; screens: string[]; links: { verdict: string }[]; broken: boolean; detached: boolean; unjudged: boolean; status: string; reach: Reach[] };
type Mark = { key: string; target: unknown; current: { status: string; note: string; author: string } };
type AppData = { url: string; signedOutUrl: string; roles: { role: string; account: string; error: string | null; url: string }[]; settings: { overrides: object[] } };
type PageData = {
  map: { screens: MapScreen[]; calls: { id: string; server?: object }[] };
  flow: { roots: FlowNode[]; unreached: FlowNode[] };
  tests: {
    importers: Record<string, { title: string }[]>;
    discarded: Record<string, { title: string; judgment: { reason: string } }[]>;
    stories: Record<string, object[]>;
    untagged?: { title: string; ref: unknown; status: string }[];
    untaggedCount?: number;
  };
  stories: { list: Story[]; notices: { file: string }[]; unknownTags: { tag: string }[]; stale: string };
  storiesDir: string;
  candidates: { list: { key: string; name: string; source: { record?: unknown; report?: string; tests?: string[] }; screens: string[]; links: { verdict: string }[] }[]; notices: object[] };
  marks: { attached: Mark[]; detached: Mark[] };
  app: AppData;
};
type FlowView = { group?: boolean; width?: number; marks?: object[] };
type FlowBox = { key: string; x: number; y: number; width: number; height: number; grouped: boolean };
type FlowEdge = { from: string; to: string; x1: number; y1: number; x2: number; y2: number; nx?: number; guards: object[] };
type FlowColumns = { widths: Record<string, number>; grouped: Set<string>; xs: number[] };

declare const state: any;
declare const GAP: number;
declare let drawnGrid: { count: number; cellW: number; per: number } | null;
declare function load(): Promise<void>;
declare function render(): void;
declare function renderFlow(): void;
declare const STORY_STATUS: Record<string, { label: string }>;
declare function pathStories(): Story[];
declare function storyTrees(flow: object, st: Story): { roots: object[]; hidden: Map<string, number> };
declare function canvas(roots: object[], options: { story: object }): { el: HTMLElement; measureWidths(): void; fit(width: number): void; measureHeights(): void; place(): unknown };
declare function flowInnerWidth(flow: HTMLElement): number;
declare function cellsPerRow(count: number, cellW: number, width: number): number;
declare function showBox(key: string): void;
declare function hasUnsavedMark(): boolean;
declare function pathValueKey(id: string, role: string | null): string;
declare function updateSettings(change: (list: object[]) => object[] | undefined): void;
declare function openNeeds(screen: { access: object }): { lines: { kind: string; text: string }[]; tips: string[]; bare: unknown };
declare function flowColumns(roots: object[], sizes: object, view?: FlowView): FlowColumns;
declare function layoutFlow(roots: object[], sizes: object, view?: FlowView, cols?: FlowColumns): { boxes: FlowBox[]; edges: FlowEdge[]; group: { x: number; y: number; height: number; count: number } | null; width: number; height: number; marks?: { x: number; y: number }[] };

async function withRebuiltFixture<T>(configPatch: object, fn: (config: Config, copy: string) => T | Promise<T>, edits: [string, string, string][] = []) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    for (const [file, from, to] of edits) {
      const target = path.join(copy, file);
      const text = fs.readFileSync(target, 'utf8');
      assert.ok(text.includes(from), `${file} has ${from}`);
      fs.writeFileSync(target, text.replace(from, to));
    }
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ...configPatch }));
    execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
    return await fn(loadConfig(configFile), copy);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const signer = (name: string, source = 'config') => ({ name, source });

async function withServer<T>(config: Config, author: string | ReviewAuthor | undefined, fn: (base: string) => T | Promise<T>) {
  const server = await startReviewServer(config, { author: typeof author === 'string' ? signer(author) : author });
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const snapshot = (dir: string) =>
  Object.fromEntries((fs.readdirSync(dir, { recursive: true }) as string[]).sort().map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), 'utf8') : null]));

const postMark = (base: string, body: object) => fetch(`${base}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const postJudgment = (base: string, body: object) => fetch(`${base}/api/judgments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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

test('the data carries each story checked against the map with its status, the tests per story and the story files that could not be read, read again on every request', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual([data.stories.list, data.stories.notices], [[], []]);
      assert.deepEqual(data.stories.unknownTags.map((u) => u.tag), ['story:help-from-home', 'story:open-document', 'story:print-document', 'story:run-lab', 'story:run-lab']);
      assert.equal(data.storiesDir, path.join(config.outDir, 'stories'));
    }),
  );
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.stories.list.map((s) => [s.id, s.links.map((l) => l.verdict), s.broken, s.detached, s.status]), [
        ['change-settings', ['off-map'], false, true, 'partial'],
        ['help-from-home', ['open', 'broken'], true, false, 'pending'],
        ['open-document', ['open', 'open', 'open'], false, false, 'pass'],
        ['read-reports', [], false, false, 'untested'],
        ['run-lab', ['conditioned', 'open'], false, false, 'fail'],
      ]);
      assert.deepEqual(Object.keys(data.tests.stories).sort(), ['help-from-home', 'open-document', 'print-document', 'run-lab']);
      assert.deepEqual(data.stories.unknownTags.map((u) => u.tag), ['story:print-document']);
      assert.deepEqual(data.stories.notices.map((n) => n.file), ['lab-shortcut.json']);

      fs.writeFileSync(path.join(config.storiesDir, 'lab-shortcut.json'), JSON.stringify({ name: '실험실 결과', screens: ['/lab#Lab', '/lab/result#LabResult'], author: 'a', date: '2026-10-02' }));
      const again: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(again.stories.notices, []);
      assert.equal(again.stories.list.find((s) => s.id === 'lab-shortcut')!.reach[0].kind, 'start');

      fs.writeFileSync(path.join(config.storiesDir, 'print-document.json'), JSON.stringify({ name: '문서를 인쇄한다', screens: ['/document/:id#DocumentDetail'], author: 'a', date: '2026-10-03' }));
      const printed: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.equal(printed.stories.list.find((s) => s.id === 'print-document')!.status, 'pass');
      assert.deepEqual(printed.stories.unknownTags, []);
    }),
  );
});

const CASE_KINDS = { boundary: '입력 경계: 빈 값, 최대 길이, 특수 문자', legacy: '옛 데이터: 이전 버전에서 만든 문서' };
const BOUNDARY_ON_SIGNIN: [string, string, string] = ['results/playwright/e2e.json', '"screen:/signin#SignIn",\n            "screen:/help#Help"', '"screen:/signin#SignIn",\n            "screen:/help#Help",\n            "case:boundary"'];
type CaseData = { caseKinds: Record<string, string>; map: { screens: { id: string; cases: { tag: string; kind: string }[] }[]; calls: { id: string; cases: { tag: string; kind: string }[] }[] } };
const casesIn = (data: CaseData) => [...data.map.screens, ...data.map.calls].filter((n) => n.cases.length).map((n) => [n.id, n.cases.map((c) => c.tag)]);

test('the data carries the configured case kinds, and the kinds picked for a screen or call in config order after its role or setting cases, as the latest pick of each says', async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data = async (): Promise<CaseData> => (await fetch(`${base}/api/data`)).json();
      const before = casesIn(await data());
      assert.deepEqual((await data()).caseKinds, CASE_KINDS);
      for (const [node, kind] of [['/admin/member#AdminMember', 'legacy'], ['/admin/member#AdminMember', 'boundary'], ['GET:/api/v1/document/list', 'legacy'], ['/signin#SignIn', 'legacy']]) {
        assert.equal((await postMark(base, { target: { node, case: kind }, status: 'needed' })).status, 201);
      }
      assert.equal((await postMark(base, { target: { node: '/signin#SignIn', case: 'legacy' }, status: 'not-needed' })).status, 201);
      assert.equal((await postMark(base, { target: { node: '/signin#SignIn', case: 'legacy' }, status: 'missing' })).status, 400);
      assert.equal((await postMark(base, { target: { node: '/signin#SignIn' }, status: 'needed' })).status, 400);
      const after = Object.fromEntries(casesIn(await data()));
      assert.deepEqual(after['/admin/member#AdminMember'], ['role:ADMIN', 'role:other', 'case:boundary', 'case:legacy']);
      assert.deepEqual(after['GET:/api/v1/document/list'], ['case:legacy']);
      assert.equal(after['/signin#SignIn'], undefined);
      assert.deepEqual(Object.keys(after).sort(), [...before.map(([id]) => id), 'GET:/api/v1/document/list'].sort());
    }),
  );
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const data: CaseData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.caseKinds, {});
      assert.ok(data.map.calls.every((c) => c.cases.length === 0));
    }),
  );
});

test('a mark posted from the page is saved with the server-side author and date and is there after reopening', async () => {
  await withRebuiltFixture({}, async (config) => {
    await withServer(config, 'reviewer', async (base) => {
      const res = await postMark(base, { target: { node: '/lab#Lab', depth: 'api' }, status: 'needs-more', note: 'only a UI test', author: 'someone else' });
      assert.equal(res.status, 201);
      assert.equal((await postMark(base, { target: { node: '/lab#Lab' }, status: 'maybe' })).status, 400);
    });
    const [saved] = loadMarks(config.marksDir);
    assert.equal(config.marksDir, path.join(config.outDir, 'marks'));
    assert.equal(saved.author, 'reviewer');
    assert.match(saved.date, /^\d{4}-\d\d-\d\dT/);

    await withServer(config, 'reviewer', async (base) => {
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.map((m) => [m.key, m.current.status, m.current.note]), [['/lab#Lab api', 'needs-more', 'only a UI test']]);
    });
  });
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

function initGitRepoNamed(dir: string, name: string) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', name], { cwd: dir });
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
        '/document/:tab_draft_done_#DocumentList': null,
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

const PASSWORD_ENV = 'DURU_TEST_APP_PASSWORD';
const ADMIN_PASSWORD_ENV = 'DURU_TEST_ADMIN_PASSWORD';
const AUDITOR_PASSWORD_ENV = 'DURU_TEST_AUDITOR_PASSWORD';
const ACCOUNTS = {
  'duru-admin': { password: 's3cret', token: 't-123', name: '두루 관리자', documents: [{ id: 17 }, { id: 18 }] },
  'duru-boss': { password: 'b0ss', token: 't-boss', name: '두루 대표', documents: [{ id: 27 }] },
  'duru-auditor': { password: 'aud1t', token: 't-audit', name: '두루 감사', documents: [{ id: 37 }] },
};

async function withFakeApi<T>(fn: (api: string, presses: string[], logins: string[], listCalls: string[], requests: string[]) => Promise<T>) {
  const presses: string[] = [];
  const logins: string[] = [];
  const listCalls: string[] = [];
  const requests: string[] = [];
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/auth/login') {
      const { loginId, pw } = JSON.parse(body);
      logins.push(loginId);
      const account = ACCOUNTS[loginId as keyof typeof ACCOUNTS];
      return account?.password === pw ? json(res, 200, { result: { token: account.token } }) : json(res, 401, { message: 'bad login' });
    }
    if (req.method === 'POST' && req.url === '/api/v2/one-time-code/create') {
      if (req.headers['x-api-key'] !== API_KEY || req.headers.authorization || !JSON.parse(body).memberId) return json(res, 403, { message: 'bad key' });
      return json(res, 200, { contents: { code: `c-${requests.filter((r) => r === requests.at(-1)).length}` } });
    }
    if (req.method === 'POST' && req.url === '/api/v1/view-token/create') {
      const { referenceType, referenceId } = JSON.parse(body);
      if (req.headers['x-api-key'] !== API_KEY || req.headers.authorization || referenceType !== 'DOCUMENT' || !referenceId) return json(res, 403, { message: 'bad key' });
      return json(res, 200, { contents: { accessToken: `t-${referenceId}-${requests.filter((r) => r === requests.at(-1)).length}` } });
    }
    const me = Object.values(ACCOUNTS).find((a) => req.headers.authorization === `Bearer ${a.token}`);
    if (!me) return json(res, 401, { message: 'no token' });
    if (req.method === 'GET' && req.url === '/api/v1/me') return json(res, 200, { name: me.name });
    if (req.url!.startsWith('/api/v1/documents')) {
      listCalls.push(`${req.method} ${req.url}`);
      if (req.method === 'GET' && req.url === '/api/v1/documents') return json(res, 200, { contents: { list: me.documents } });
      if (req.method === 'POST' && req.url === '/api/v1/documents/search') return json(res, 200, [{ code: `${JSON.parse(body).status} 1/2` }]);
      if (req.method === 'GET' && req.url === '/api/v1/documents/empty') return json(res, 200, { contents: { list: [] } });
      if (req.method === 'GET' && req.url === '/api/v1/documents/broken') return json(res, 500, { message: 'broken' });
      if (req.method === 'GET' && req.url === '/api/v1/documents/flaky') {
        return listCalls.filter((c) => c.endsWith('/flaky')).length === 1 ? json(res, 503, { message: 'busy' }) : json(res, 200, { contents: { list: [{ id: 'done' }] } });
      }
      if (req.method === 'GET' && req.url === '/api/v1/documents/text') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('not json');
      }
    }
    if (req.method === 'POST' && req.url === '/api/v1/press') {
      presses.push(req.url);
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('pressed');
    }
    json(res, 404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, presses, logins, listCalls, requests);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const appSettings = (server: string) => ({
  app: {
    files: 'build',
    server,
    apiPaths: ['/api/'],
    login: {
      path: '/auth/login',
      body: { loginId: '{id}', pw: '{password}' },
      token: 'result.token',
      storage: { key: 'FAKE_AUTH', value: { accessToken: '{token}' } },
    },
    account: { id: 'duru-admin', passwordEnv: PASSWORD_ENV },
  },
});

const SETTINGS_FILE = { path: '/settings.js', global: 'window.FAKE_SETTINGS', root: 'globalSettings', merged: ['SYSTEM', 'CUSTOM'] };
const withSettingsFile = (api: string, extra = {}) => ({ app: { ...appSettings(api).app, settingsFile: SETTINGS_FILE, ...extra } });
const postSettings = (base: string, overrides: unknown) =>
  fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides }) });

function runSettingsFile(code: string) {
  const context = vm.createContext({});
  vm.runInContext('var window = globalThis;', context);
  vm.runInContext(code, context);
  return JSON.parse(vm.runInContext('JSON.stringify({ settings: window.FAKE_SETTINGS, kept: window.KEPT })', context));
}

function rewrite(copy: string, rel: string, from: string, to: string) {
  const file = path.join(copy, rel);
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes(from), `${rel} has no ${from}`);
  fs.writeFileSync(file, src.replace(from, to));
}

const rebuild = (copy: string) => execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });

const LIST_API = { api: '/api/v1/documents', list: 'contents.list', value: 'id' };
const API_KEY_ENV = 'DURU_TEST_API_KEY';
const API_KEY = 'k3y-s3cret';
const ISSUING_API = { api: '/api/v2/one-time-code/create', method: 'POST', header: { 'X-API-KEY': '{key}' }, keyEnv: API_KEY_ENV, body: { memberId: 'duru-admin' }, value: 'contents.code' };
const VIEW_TOKEN_API = { api: '/api/v1/view-token/create', method: 'POST', header: { 'X-API-KEY': '{key}' }, keyEnv: API_KEY_ENV, body: { referenceType: 'DOCUMENT', referenceId: '{documentId}' }, value: 'contents.accessToken' };
const VIEW_ROUTE: [string, string, string] = ['client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />',
  "<Route path={'/view/:documentId'} component={waitFor(DocumentDetail)} exact />"];
const VIEW_SCREEN = '/view/:documentId#DocumentDetail';
const loginWithHeader = { ...appSettings('http://127.0.0.1:1').app.login, header: { Authorization: 'Bearer {token}' } };

const roleSettings = (server: string, roles: Record<string, string> = { ADMIN: 'duru-boss', AUDITOR: 'duru-auditor' }) => ({
  app: {
    ...appSettings(server).app,
    roles: Object.fromEntries(Object.entries(roles).map(([role, id]) => [role, { id, passwordEnv: id === 'duru-boss' ? ADMIN_PASSWORD_ENV : AUDITOR_PASSWORD_ENV }])),
  },
});

async function withPasswords<T>(values: Record<string, string | undefined>, fn: () => Promise<T>) {
  for (const [env, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[env];
    else process.env[env] = value;
  }
  try {
    return await fn();
  } finally {
    for (const env of Object.keys(values)) delete process.env[env];
  }
}

const withPassword = <T>(value: string | undefined, fn: () => Promise<T>) => withPasswords({ [PASSWORD_ENV]: value }, fn);
const ALL_PASSWORDS = { [PASSWORD_ENV]: 's3cret', [ADMIN_PASSWORD_ENV]: 'b0ss', [AUDITOR_PASSWORD_ENV]: 'aud1t' };

test('with app settings, the app is served logged in on its own address and its API requests go to the test server', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const data = await (await fetch(`${base}/api/data`)).json();
          assert.match(data.app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
          assert.notEqual(data.app.url, base);
          assert.equal(data.app.account, 'duru-admin');
          assert.equal(data.app.error, null);
          assert.equal(data.appLinks['/home#Home'], `${data.app.url}/home`);
          assert.equal(data.appLinks['/document/:id#DocumentDetail'], null);

          const html = await (await fetch(`${data.app.url}/home`)).text();
          assert.equal(await (await fetch(`${data.app.url}/app.js/nested`)).text(), html);
          assert.match(html, /<title>가짜 앱<\/title>/);
          assert.match(html, /FAKE_AUTH/);
          assert.match(html, /t-123/);
          const script = await fetch(`${data.app.url}/app.js`);
          assert.match(script.headers.get('content-type')!, /javascript/);
          assert.match(await script.text(), /FAKE_AUTH/);

          const me = await fetch(`${data.app.url}/api/v1/me`, { headers: { authorization: 'Bearer t-123' } });
          assert.equal(me.status, 200);
          assert.deepEqual(await me.json(), { name: '두루 관리자' });

          const other = await new Promise((resolve) => {
            const { port } = new URL(data.app.url);
            http.get({ host: '127.0.0.1', port, path: '/home', headers: { host: 'evil.example.test' } }, (res) => resolve(res.statusCode));
          });
          assert.equal(other, 403);

          const page = await (await fetch(`${base}/`)).text();
          const map = fs.readFileSync(path.join(config.outDir, 'map.json'), 'utf8');
          for (const text of [JSON.stringify(data), html, page, map]) assert.ok(!text.includes('s3cret'));
        }),
      ),
    ),
  );
});

test('screens listed as signed out open on a second app address that never gets the token and clears it once on the sign-out path', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin'] } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app, appLinks } = await (await fetch(`${base}/api/data`)).json();
          const signedOut = new URL(app.signedOutUrl);
          assert.equal(signedOut.hostname, '127.0.0.1');
          assert.notEqual(signedOut.port, new URL(app.url).port);
          assert.equal(appLinks['/signin#SignIn'], `${app.signedOutUrl}/signin`);
          assert.equal(appLinks['/home#Home'], `${app.url}/home`);

          const html = await (await fetch(`${app.signedOutUrl}/signin`)).text();
          assert.match(html, /<title>가짜 앱<\/title>/);
          assert.doesNotMatch(html, /t-123/);
          assert.doesNotMatch(html, /removeItem/);

          const signOut = await (await fetch(`${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent('/signin')}`)).text();
          assert.match(signOut, /localStorage\.removeItem\("FAKE_AUTH"\)/);
          assert.match(signOut, /location\.replace\(location\.origin \+ "\/signin"\)/);
          for (const to of ['//evil.example.test', '/\\evil.example.test', 'javascript:alert(1)', 'http://[', '/.//evil.example.test', '/x/..//evil.example.test', '/%2e//evil.example.test']) {
            const offSite = await (await fetch(`${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent(to)}`)).text();
            assert.match(offSite, /location\.replace\(location\.origin \+ "\/"\)/, to);
          }

          const me = await fetch(`${app.signedOutUrl}/api/v1/me`, { headers: { authorization: 'Bearer t-123' } });
          assert.equal(me.status, 200);
        }),
      ),
    ),
  );
});

test('without signedOutPaths there is no signed-out address', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.equal(app.signedOutUrl, null);
          assert.deepEqual(app.unknownSignedOutPaths, []);
        }),
      ),
    ),
  );
});

test('signedOutPaths that match no screen path in the map are listed for the page', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin', '/signin/', '/login'] } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(app.unknownSignedOutPaths, ['/signin/', '/login']);
        }),
      ),
    ),
  );
});

test('when the password variable is missing or the login is refused, the page says why and the app is served without a token', async () => {
  await withFakeApi(async (api) => {
    await withPassword(undefined, () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const data = await (await fetch(`${base}/api/data`)).json();
          assert.match(data.app.error, new RegExp(PASSWORD_ENV));
          assert.doesNotMatch(await (await fetch(`${data.app.url}/home`)).text(), /FAKE_AUTH/);
        }),
      ),
    );
    await withPassword('wrong', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const data = await (await fetch(`${base}/api/data`)).json();
          assert.match(data.app.error, /401/);
          assert.ok(!data.app.error.includes('wrong'));
        }),
      ),
    );
  });
});

test('app files taken from a deployed address are served without the headers that forbid framing, with the token and the settings overrides put in', async () => {
  const build = path.join(FIXTURE, 'build');
  const deployed = http.createServer((req, res) => {
    const file = path.join(build, ['/app.js', '/settings.js'].includes(req.url!) ? req.url!.slice(1) : 'index.html');
    res.writeHead(200, {
      'content-type': file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    });
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => deployed.listen(0, '127.0.0.1', resolve));
  try {
    const files = `http://127.0.0.1:${(deployed.address() as AddressInfo).port}`;
    await withFakeApi((api) =>
      withPassword('s3cret', () =>
        withRebuiltFixture(withSettingsFile(api, { files }), (config) =>
          withServer(config, 'reviewer', async (base) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const page = await fetch(`${app.url}/home`);
            assert.equal(page.headers.get('x-frame-options'), null);
            assert.equal(page.headers.get('content-security-policy'), null);
            assert.match(await page.text(), /FAKE_AUTH/);
            const script = await fetch(`${app.url}/app.js`);
            assert.match(script.headers.get('content-type')!, /javascript/);
            assert.doesNotMatch(await script.text(), /t-123/);

            await postSettings(base, [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
            const settings = await (await fetch(`${app.url}/settings.js`)).text();
            assert.ok(settings.startsWith(fs.readFileSync(path.join(build, 'settings.js'), 'utf8')));
            assert.deepEqual(runSettingsFile(settings).settings, { SYSTEM: { HELP_LINK_ENABLED: true, LAB_ENABLED: true } });
          }),
        ),
      ),
    );
  } finally {
    deployed.closeAllConnections();
    deployed.close();
  }
});

test('each configured role is served logged in as its own account on an address of its own, logging in once however many pages load', async () => {
  await withFakeApi((api, presses, logins) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, signedOutPaths: ['/signin'] } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app }: PageData = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(app.roles.map(({ url, ...r }) => r), [
            { role: 'ADMIN', account: 'duru-boss', error: null },
            { role: 'AUDITOR', account: 'duru-auditor', error: null },
          ]);
          const urls = [app.url, app.signedOutUrl, ...app.roles.map((r) => r.url)];
          for (const url of urls) assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
          assert.equal(new Set(urls).size, urls.length);

          for (const [url, token] of [[app.url, 't-123'], [app.roles[0].url, 't-boss'], [app.roles[1].url, 't-audit']]) {
            for (let i = 0; i < 3; i += 1) {
              const html = await (await fetch(`${url}/admin/member`)).text();
              assert.match(html, new RegExp(token));
              assert.equal(Object.values(ACCOUNTS).filter((a) => html.includes(a.token)).length, 1);
            }
            const me = await fetch(`${url}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
            assert.equal(me.status, 200);
          }
          assert.deepEqual(logins.sort(), ['duru-admin', 'duru-auditor', 'duru-boss']);
        }),
      ),
    ),
  );
});

test('an account shared by the default and roles, or by several roles, logs in once', async () => {
  await withFakeApi((api, presses, logins) =>
    withPasswords(ALL_PASSWORDS, () => {
      const roles = {
        ADMIN: { id: 'duru-admin', passwordEnv: PASSWORD_ENV },
        OWNER: { id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV },
        MANAGER: { id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV },
      };
      return withRebuiltFixture({ app: { ...appSettings(api).app, roles } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(logins.sort(), ['duru-admin', 'duru-boss']);
          for (const [url, token] of [[app.roles[0].url, 't-123'], [app.roles[1].url, 't-boss'], [app.roles[2].url, 't-boss']]) {
            assert.match(await (await fetch(`${url}/home`)).text(), new RegExp(token));
          }
        }),
      );
    }),
  );
});

test('a role whose password variable is missing gets its own error while the other accounts log in', async () => {
  await withFakeApi((api) =>
    withPasswords({ ...ALL_PASSWORDS, [AUDITOR_PASSWORD_ENV]: undefined }, () =>
      withRebuiltFixture(roleSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.equal(app.error, null);
          assert.equal(app.roles[0].error, null);
          assert.match(app.roles[1].error, new RegExp(AUDITOR_PASSWORD_ENV));
          assert.match(await (await fetch(`${app.roles[0].url}/home`)).text(), /t-boss/);
          assert.doesNotMatch(await (await fetch(`${app.roles[1].url}/home`)).text(), /FAKE_AUTH/);
        }),
      ),
    ),
  );
});

const pathValueSettings = (api: string, pathValues: unknown) => ({ app: { ...appSettings(api).app, login: loginWithHeader, pathValues } });

const preparedFor = (config: Config, pathValues: unknown, id: string) =>
  withServer({ ...config, app: { ...config.app, pathValues } }, 'reviewer', async (base) => {
    const res = await fetch(`${base}/api/path-values?screen=${encodeURIComponent(id)}`);
    return res.status === 200 ? res.json() : res.status;
  });

test('the path values of a screen come from its fixed values and from list APIs called with the login token, with the list screen to fall back to', async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: 'draft' }, '/document/:id': { id: LIST_API } };
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, pathValues), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const prepared = async (id: string) => (await fetch(`${base}/api/path-values?screen=${encodeURIComponent(id)}`)).json();
          assert.deepEqual(await prepared('/document/:tab_draft_done_#DocumentList'), {
            parts: ['/document', { name: 'tab', prefix: '/', optional: false, pattern: 'draft|done' }],
            values: { tab: 'draft' },
            queryNames: [],
            errors: [],
            path: '/document/draft',
            fallback: '/home#Home', fallbackPath: '/home',
          });
          const detail = await prepared('/document/:id#DocumentDetail');
          assert.deepEqual(detail, {
            parts: ['/document', { name: 'id', prefix: '/', optional: false, pattern: null }],
            values: { id: '17' },
            queryNames: [],
            errors: [],
            path: '/document/17',
            fallback: '/document/:tab_draft_done_#DocumentList', fallbackPath: '/document/draft',
          });
          assert.deepEqual(await prepared('/home#Home'), { parts: ['/home'], values: {}, queryNames: [], errors: [], path: '/home', fallback: null, fallbackPath: null });
          const unknown = await fetch(`${base}/api/path-values?screen=${encodeURIComponent('/nowhere#Nowhere')}`);
          assert.equal(unknown.status, 404);

          const data = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(data.app.unknownPathValues, []);
          assert.equal(data.appLinks['/document/:id#DocumentDetail'], null);
          for (const text of [JSON.stringify(data), JSON.stringify(detail)]) assert.ok(!text.includes('t-123'));
        }),
      ),
    ),
  );
});

test('the path values of a screen asked for with a role come from list APIs called with that role\'s token', async () => {
  const pathValues = { '/document/:id': { id: LIST_API } };
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, pathValues } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const prepared = (query: string) => fetch(`${base}/api/path-values?screen=${encodeURIComponent('/document/:id#DocumentDetail')}${query}`);
          assert.deepEqual((await (await prepared('')).json()).values, { id: '17' });
          assert.deepEqual((await (await prepared('&role=ADMIN')).json()).values, { id: '27' });
          assert.deepEqual((await (await prepared('&role=AUDITOR')).json()).values, { id: '37' });
          assert.equal((await prepared('&role=OWNER')).status, 404);
        }),
      ),
    ),
  );
});

test('a list API that is empty, fails or answers in another shape is reported, and the screen falls back to its list screen', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, {}), async (config) => {
        const detail = (id: unknown) => preparedFor(config, { '/document/:id': { id } }, '/document/:id#DocumentDetail');
        const searched = await detail({ api: '/api/v1/documents/search', method: 'POST', body: { status: 'done' }, list: '', value: 'code' });
        assert.deepEqual([searched.values, searched.errors, searched.path], [{ id: 'done 1/2' }, [], '/document/done%201%2F2']);
        for (const [given, error] of [
          [{ ...LIST_API, api: '/api/v1/documents/empty' }, /^id: 목록 API GET \/api\/v1\/documents\/empty 가 빈 목록을 돌려주었습니다$/],
          [{ ...LIST_API, api: '/api/v1/documents/broken' }, /500 로 실패/],
          [{ ...LIST_API, api: '/api/v1/documents/text' }, /JSON 이 아닙니다/],
          [{ ...LIST_API, list: 'contents.items' }, /contents\.items 에 목록이 없습니다/],
          [{ ...LIST_API, value: 'uuid' }, /첫 항목에 uuid 값이 없습니다/],
        ] satisfies [object, RegExp][]) {
          const result = await detail(given);
          assert.deepEqual([result.values, result.path, result.fallback], [{}, null, '/home#Home'], given.api);
          assert.equal(result.errors.length, 1);
          assert.match(result.errors[0], error);
        }
        assert.deepEqual(await preparedFor(config, {}, '/document/:id#DocumentDetail'), {
          parts: ['/document', { name: 'id', prefix: '/', optional: false, pattern: null }], values: {}, queryNames: [], errors: [], path: null, fallback: '/home#Home', fallbackPath: '/home',
        });
        await withPassword('wrong', async () => {
          const result = await detail(LIST_API);
          assert.match(result.errors[0], /로그인하지 못해/);
        });
      }),
    ),
  );
});

test('an issuing API is called anew for every request, with its key and without the login token, and the key reaches no page data or message', async () => {
  const pathValues = { '/document/:id': { id: ISSUING_API } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ [PASSWORD_ENV]: 'wrong', [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, pathValues } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const prepared = async () => (await fetch(`${base}/api/path-values?screen=${encodeURIComponent('/document/:id#DocumentDetail')}`)).text();
          const first = JSON.parse(await prepared());
          assert.deepEqual([first.values, first.errors, first.path, first.issued], [{ id: 'c-1' }, [], '/document/c-1', ['id']]);
          assert.equal(JSON.parse(await prepared()).path, '/document/c-2');
          assert.equal(requests.filter((r) => r === 'POST /api/v2/one-time-code/create').length, 2);

          const texts = [JSON.stringify(first), await (await fetch(`${base}/api/data`)).text()];
          process.env[API_KEY_ENV] = 'wrong-key';
          const refused = await prepared();
          assert.match(JSON.parse(refused).errors[0], /^id: 발급 API POST \/api\/v2\/one-time-code\/create 요청이 403 로 실패했습니다$/);
          delete process.env[API_KEY_ENV];
          const missing = await prepared();
          assert.match(JSON.parse(missing).errors[0], new RegExp(`환경 변수 ${API_KEY_ENV} 에 키가 없어`));
          assert.equal(JSON.parse(missing).fallback, '/home#Home');
          for (const text of [...texts, refused, missing]) assert.ok(!text.includes(API_KEY) && !text.includes('wrong-key'), text);
        }),
      ),
    ),
  );
});

test('a query token is issued for the document id of the same address, a typed value is used in place of the configured one, and the key reaches nothing', async () => {
  const pathValues = { '/view/:documentId': { documentId: '01a1', '?token': VIEW_TOKEN_API }, '/home': { '?lang': 'ko' } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ [PASSWORD_ENV]: 'wrong', [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, pathValues } }, (config) =>
        withServer(config, 'reviewer', async (base) => {
          const again = (body: string, type = 'application/json') => fetch(`${base}/api/path-values`, { method: 'POST', headers: { 'Content-Type': type }, body });
          const prepared = async (id: string, typed?: object) => (typed ? await again(JSON.stringify({ screen: id, typed })) : await fetch(`${base}/api/path-values?screen=${encodeURIComponent(id)}`)).text();
          const first = JSON.parse(await prepared(VIEW_SCREEN));
          assert.deepEqual([first.values, first.queryNames, first.errors, first.path, first.issued], [{ documentId: '01a1', '?token': 't-01a1-1' }, ['?token'], [], '/view/01a1?token=t-01a1-1', ['?token']]);
          const typed = JSON.parse(await prepared(VIEW_SCREEN, { documentId: 'typed7' }));
          assert.deepEqual([typed.values.documentId, typed.path], ['typed7', '/view/typed7?token=t-typed7-2']);
          const own = JSON.parse(await prepared(VIEW_SCREEN, { '?token': 'mine' }));
          assert.deepEqual([own.path, own.issued], ['/view/01a1?token=mine', undefined]);
          assert.equal(requests.filter((r) => r === 'POST /api/v1/view-token/create').length, 2);

          const home = JSON.parse(await prepared('/home#Home'));
          assert.deepEqual([home.parts, home.queryNames, home.path], [['/home'], ['?lang'], '/home?lang=ko']);
          const data = await (await fetch(`${base}/api/data`)).json();
          assert.equal(data.appLinks['/home#Home'], `${data.app.url}/home?lang=ko`);
          assert.equal(data.appLinks[VIEW_SCREEN], null);
          assert.deepEqual(data.app.unknownPathValues, []);

          for (const bad of ['nope', '[1]', JSON.stringify({ screen: VIEW_SCREEN }), JSON.stringify({ screen: VIEW_SCREEN, typed: { documentId: 7 } }), JSON.stringify({ screen: 7, typed: {} })]) {
            assert.equal((await again(bad)).status, 400, bad);
          }
          assert.equal((await again(JSON.stringify({ screen: VIEW_SCREEN, typed: { documentId: 'x' } }), 'text/plain')).status, 415);
          assert.equal((await fetch(`${base}/api/path-values?screen=${encodeURIComponent(VIEW_SCREEN)}&typed=${encodeURIComponent('{"documentId":"x"}')}`).then((r) => r.json())).values.documentId, '01a1');
          assert.equal((await again(JSON.stringify({ screen: '/gone#Gone', typed: {} }))).status, 404);
          process.env[API_KEY_ENV] = 'wrong-key';
          const refused = await prepared(VIEW_SCREEN, { documentId: 'typed7' });
          assert.deepEqual(JSON.parse(refused).errors, ['?token: 발급 API POST /api/v1/view-token/create 요청이 403 로 실패했습니다']);
          process.env[API_KEY_ENV] = API_KEY;
          const unsent = await prepared(VIEW_SCREEN, { documentId: '' });
          assert.deepEqual(JSON.parse(unsent).errors, ['?token: documentId 값이 없어 발급 API POST /api/v1/view-token/create 를 부르지 않았습니다']);
          assert.equal(requests.filter((r) => r === 'POST /api/v1/view-token/create').length, 4);
          for (const text of [JSON.stringify(first), JSON.stringify(typed), refused, unsent, JSON.stringify(data)]) assert.ok(!text.includes(API_KEY) && !text.includes('wrong-key'), text);
        }),
        [VIEW_ROUTE]),
    ),
  );
});

test('pathValues entries that match no screen path, and variables their path does not have, are listed for the page', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, { '/document/:id': { id: '1', docId: '2' }, '/docs/:id': { id: '3' } }), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(app.unknownPathValues, ['/document/:id 의 docId', '/docs/:id']);
        }),
      ),
    ),
  );
});

test('the settings file is served with the posted overrides applied the way the app merges it, on every app address, and nothing else changes', async () => {
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api, { signedOutPaths: ['/signin'] }), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },", "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'], TITLE: 'Admin' },\n      USER: { LIST: ['DOCS'] },");
        rebuild(copy);
        await withServer(config, 'reviewer', async (base) => {
          const { app } = await (await fetch(`${base}/api/data`)).json();
          assert.deepEqual(app.settings, { root: 'globalSettings', merged: ['SYSTEM', 'CUSTOM'], overrides: [], file: { SYSTEM: { HELP_LINK_ENABLED: true } }, fileError: null });
          const fileText = fs.readFileSync(path.join(copy, 'build/settings.js'), 'utf8');
          assert.equal(await (await fetch(`${app.url}/settings.js`)).text(), fileText);

          const overrides = [
            { path: ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'], value: ['ADMIN_ARCHIVE'] },
            { path: ['SYSTEM', 'LAB_ENABLED'], value: true },
            { path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: false },
            { path: ['CUSTOM', 'THEME'], value: 'dark' },
          ];
          const res = await postSettings(base, overrides);
          assert.equal(res.status, 200);
          assert.deepEqual((await res.json()).overrides, overrides);
          assert.deepEqual((await (await fetch(`${base}/api/data`)).json()).app.settings.overrides, overrides);

          for (const url of [app.url, app.signedOutUrl]) {
            const served = await fetch(`${url}/settings.js`);
            assert.match(served.headers.get('content-type')!, /javascript/);
            const text = await served.text();
            assert.ok(text.startsWith(fileText));
            assert.deepEqual(runSettingsFile(text).settings, {
              SYSTEM: {
                HELP_LINK_ENABLED: false,
                LAB_ENABLED: true,
                MAIN_MENU: { ADMIN: { LIST: ['ADMIN_ARCHIVE'], TITLE: 'Admin' }, USER: { LIST: ['DOCS'] } },
              },
              CUSTOM: { THEME: 'dark' },
            });
          }
          assert.equal(await (await fetch(`${app.url}/app.js`)).text(), fs.readFileSync(path.join(copy, 'build/app.js'), 'utf8'));
          assert.doesNotMatch(await (await fetch(`${app.url}/home`)).text(), /ADMIN_ARCHIVE/);

          fs.writeFileSync(path.join(copy, 'build/settings.js'), "window.FAKE_SETTINGS = { SYSTEM: { MAIN_MENU: { ADMIN: { LIST: ['FROM_FILE'] } } } };\nwindow.KEPT = window.FAKE_SETTINGS.SYSTEM.MAIN_MENU;\n");
          const list = ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'];
          await postSettings(base, [{ path: list, item: 'ADMIN_REPORT', value: true }, { path: list, item: 'FROM_FILE', value: false }, { path: list, item: 'ADMIN_ARCHIVE', value: true }]);
          const fromFile = runSettingsFile(await (await fetch(`${app.url}/settings.js`)).text());
          assert.deepEqual(fromFile.settings.SYSTEM.MAIN_MENU, { ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] } });
          assert.deepEqual(fromFile.kept, { ADMIN: { LIST: ['FROM_FILE'] } });

          fs.rmSync(path.join(copy, 'build/settings.js'));
          await postSettings(base, [{ path: ['SYSTEM', 'MAIN_MENU', 'USER', 'LIST'], item: 'REPORTS', value: true }]);
          assert.deepEqual(runSettingsFile(await (await fetch(`${app.url}/settings.js`)).text()).settings, {
            SYSTEM: { MAIN_MENU: { ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'], TITLE: 'Admin' }, USER: { LIST: ['DOCS', 'REPORTS'] } } },
          });

          await postSettings(base, []);
          assert.equal(await (await fetch(`${app.url}/settings.js`)).text(), '');
          assert.deepEqual(requests, ['POST /auth/login']);
        });
      }),
    ),
  );
});

test('settings overrides that are not JSON, not a list, or reach outside the sections the app merges are refused and change nothing', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', async () => {
      await withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          const notJson = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"overrides":[]}' });
          assert.equal(notJson.status, 415);
          for (const [overrides, message] of [
            ['SYSTEM.LAB_ENABLED', /not a list/],
            [[{ path: ['DISPLAY', 'PAGE_SIZE'], value: 50 }], /section DISPLAY/],
            [[{ path: ['SYSTEM'], value: {} }], /section and a key/],
            [[{ path: ['SYSTEM', 'LAB_ENABLED'] }], /LAB_ENABLED/],
            [[{ path: ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'], item: 'ADMIN_REPORT', value: 'yes' }], /list item/],
            [[{ path: ['SYSTEM', 'LAB_ENABLED'], value: true, root: 'globalSettings' }], /LAB_ENABLED/],
            [[{ path: ['SYSTEM', '__proto__', 'polluted'], value: true }], /__proto__/],
            [[{ path: ['SYSTEM', 'constructor', 'prototype', 'polluted'], value: true }], /constructor/],
            [[{ path: ['SYSTEM', 'MAIN_MENU', 'prototype'], value: true }], /prototype/],
          ] satisfies [unknown, RegExp][]) {
            const res = await postSettings(base, overrides);
            assert.equal(res.status, 400, JSON.stringify(overrides));
            assert.match(await res.text(), message);
          }
          assert.deepEqual((await (await fetch(`${base}/api/data`)).json()).app.settings.overrides, []);
        }),
      );
      await withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', async (base) => {
          assert.equal((await (await fetch(`${base}/api/data`)).json()).app.settings, null);
          const res = await postSettings(base, [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
          assert.equal(res.status, 400);
          assert.match(await res.text(), /app\.settingsFile is not set/);
        }),
      );
    }),
  );
});

test('a settingsFile root without settingsDefaults is rejected, since the defaults the file is merged over are unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    const config = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8'));
    const app = { ...appSettings('http://127.0.0.1:1').app, settingsFile: { ...SETTINGS_FILE, root: 'appSettings' } };
    fs.writeFileSync(file, JSON.stringify({ ...config, settingsRoots: ['globalSettings', 'appSettings'], app }));
    assert.throws(() => loadConfig(file), /app\.settingsFile\.root "appSettings" has no settingsDefaults entry/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the page gets what the settings file sets in the merged sections, without the overrides, or why the file could not be run', async () => {
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config, copy) =>
        withServer(config, 'reviewer', async (base) => {
          const settingsOf = async () => (await (await fetch(`${base}/api/data`)).json()).app.settings;
          const writeFile = (text: string) => fs.writeFileSync(path.join(copy, 'build/settings.js'), text);
          await postSettings(base, [{ path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: false }]);
          assert.deepEqual(await settingsOf(), {
            root: 'globalSettings',
            merged: ['SYSTEM', 'CUSTOM'],
            overrides: [{ path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: false }],
            file: { SYSTEM: { HELP_LINK_ENABLED: true } },
            fileError: null,
          });

          writeFile("window.FAKE_SETTINGS = { SYSTEM: { A: 1, F: () => 1 }, CUSTOM: { B: 'x' }, DISPLAY: { C: 2 } };\nwindow.OTHER = 1;\n");
          assert.deepEqual((await settingsOf()).file, { SYSTEM: { A: 1 }, CUSTOM: { B: 'x' } });

          writeFile("throw new Error('boom');\n");
          const thrown = await settingsOf();
          assert.equal(thrown.file, null);
          assert.match(thrown.fileError, /설정 파일.*boom/);

          writeFile('while (true) {}\n');
          const endless = await settingsOf();
          assert.equal(endless.file, null);
          assert.match(endless.fileError, /설정 파일/);

          fs.rmSync(path.join(copy, 'build/settings.js'));
          assert.deepEqual((await settingsOf()).file, {});
          assert.deepEqual(requests, ['POST /auth/login']);
        }),
      ),
    ),
  );
});

test('a change inside a default the source does not show in full is refused unless the settings file sets that key, while replacing the whole key is allowed', async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },", "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },\n      USER: window.INTO_USER_MENU || {},");
        rebuild(copy);
        await withServer(config, 'reviewer', async (base) => {
          const list = ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'];
          for (const overrides of [[{ path: list, item: 'ADMIN_REPORT', value: false }], [{ path: list, value: [] }]]) {
            const res = await postSettings(base, overrides);
            assert.equal(res.status, 400);
            assert.match(await res.text(), /SYSTEM\.MAIN_MENU.*not read in full/);
          }
          assert.equal((await postSettings(base, [{ path: ['SYSTEM', 'MAIN_MENU'], value: { ADMIN: { LIST: [] } } }])).status, 200);
          assert.equal((await postSettings(base, [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }])).status, 200);

          fs.writeFileSync(path.join(copy, 'build/settings.js'), "window.FAKE_SETTINGS = { SYSTEM: { MAIN_MENU: { ADMIN: { LIST: ['ADMIN_REPORT'] } } } };\n");
          assert.equal((await postSettings(base, [{ path: list, item: 'ADMIN_REPORT', value: false }])).status, 200);
        });
      }),
    ),
  );
});

test('the code put after the settings file never writes through __proto__, constructor or prototype', () => {
  const context = vm.createContext({});
  vm.runInContext('var window = globalThis;', context);
  const overrides = [
    { path: ['SYSTEM', '__proto__', 'polluted'], value: true },
    { path: ['__proto__', 'polluted'], value: true },
    { path: ['SYSTEM', 'constructor', 'prototype', 'polluted'], value: true },
    { path: ['SYSTEM', 'LAB_ENABLED'], value: true },
  ];
  vm.runInContext(`(${applyOverrides})(['__proto__', 'FAKE_SETTINGS'], {}, ${JSON.stringify(overrides)});`, context);
  vm.runInContext(`(${applyOverrides})(['FAKE_SETTINGS'], {}, ${JSON.stringify(overrides)});`, context);
  assert.equal(vm.runInContext('({}).polluted', context), undefined);
  assert.equal(vm.runInContext('Object.prototype.polluted', context), undefined);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(window.FAKE_SETTINGS)', context)), { SYSTEM: { LAB_ENABLED: true } });
});

for (const signedOutPaths of [[], ['/signin']]) {
  test(`the app server closes with the review server, with signedOutPaths ${JSON.stringify(signedOutPaths)}`, async () => {
    await withFakeApi((api) =>
      withPassword('s3cret', () =>
        withRebuiltFixture({ app: { ...roleSettings(api).app, signedOutPaths } }, async (config) => {
          const server = await startReviewServer(config, { author: signer('reviewer') });
          let app;
          try {
            ({ app } = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/data`)).json());
          } finally {
            await new Promise((resolve) => server.close(resolve));
          }
          assert.equal(Boolean(app.signedOutUrl), signedOutPaths.length > 0);
          const refused = (err: { cause?: { code?: string } }) => err.cause?.code === 'ECONNREFUSED';
          await assert.rejects(fetch(`${app.url}/home`), refused);
          if (app.signedOutUrl) await assert.rejects(fetch(`${app.signedOutUrl}/signin`), refused);
          assert.equal(app.roles.length, 2);
          for (const r of app.roles) await assert.rejects(fetch(`${r.url}/home`), refused);
        }),
      ),
    );
  });
}

for (const [name, broken, message] of [
  ['no files', { files: undefined }, /app\.files/],
  ['a server that is not an address', { server: 'not a url' }, /app\.server/],
  ['apiPaths that is not a list', { apiPaths: '/api/' }, /app\.apiPaths/],
  ['a login without body, token and storage', { login: { path: '/auth/login' } }, /app\.login/],
  ['the password itself in the account', { account: { id: 'duru-admin', password: 's3cret' } }, /app\.account/],
  ['signedOutPaths that is not a list of paths', { signedOutPaths: 'signin' }, /app\.signedOutPaths/],
  ['roles that is a list', { roles: [{ id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV }] }, /app\.roles must be/],
  ['a role without passwordEnv', { roles: { ADMIN: { id: 'duru-boss' } } }, /app\.roles\.ADMIN must be/],
  ['the password itself in a role', { roles: { ADMIN: { id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV, password: 's3cret' } } }, /app\.roles\.ADMIN must be/],
  ['pathValues that is not a map of route paths', { pathValues: ['/document/:id'] }, /app\.pathValues must/],
  ['a pathValues key that is not a route path', { pathValues: { 'document/:id': { id: '1' } } }, /app\.pathValues key "document\/:id" must be a route path/],
  ['a path variable given a number', { pathValues: { '/document/:id': { id: 17 } } }, /app\.pathValues\["\/document\/:id"\]\.id must/],
  ['a query key without a name', { pathValues: { '/document/:id': { id: '1', '?': 'x' } } }, /app\.pathValues\["\/document\/:id"\] has the key "\?" without a query parameter name/],
  ['a query value given a number', { pathValues: { '/document/:id': { '?token': 17 } } }, /app\.pathValues\["\/document\/:id"\]\.\?token must/],
  ['a query value that is a list API without its value', { login: loginWithHeader, pathValues: { '/document/:id': { '?token': { ...LIST_API, value: undefined } } } }, /app\.pathValues\["\/document\/:id"\]\.\?token must/],
  ['a query value that is an issuing API with the key itself in its header', { pathValues: { '/document/:id': { '?token': { ...ISSUING_API, header: { 'X-API-KEY': 's3cret' } } } } }, /app\.pathValues\["\/document\/:id"\]\.\?token must/],
  ...([
    ['without the value to take', { value: undefined }],
    ['whose address is not a path', { api: 'http://127.0.0.1:1/api/v1/documents' }],
    ['with a list that is not a dotted path', { list: 7 }],
    ['with a body but no method', { body: { status: 'draft' } }],
    ['with a key it does not know', { headers: {} }],
  ] satisfies [string, object][]).map(([name, change]): [string, object, RegExp] => [`a list API ${name}`, { login: loginWithHeader, pathValues: { '/document/:id': { id: { ...LIST_API, ...change } } } }, /app\.pathValues\["\/document\/:id"\]\.id must/]),
  ['a list API without login.header', { pathValues: { '/document/:id': { id: LIST_API } } }, /app\.login\.header/],
  ...([
    ['with the key itself in its header', { header: { 'X-API-KEY': 's3cret' } }],
    ['without a header', { header: undefined }],
    ['with a header that is not a map of names to text', { header: ['{key}'] }],
    ['without keyEnv', { keyEnv: undefined }],
    ['with a body but no method', { method: undefined }],
    ['whose address is not a path', { api: 'api/codes' }],
    ['with the key itself beside its header', { key: 's3cret' }],
  ] satisfies [string, object][]).map(([name, change]): [string, object, RegExp] => [`an issuing API ${name}`, { pathValues: { '/document/:id': { id: { ...ISSUING_API, ...change } } } }, /app\.pathValues\["\/document\/:id"\]\.id must/]),
  ['a login header that is not a map of header names', { login: { ...loginWithHeader, header: ['Bearer s3cret'] } }, /app\.login\.header/],
  ['a settingsFile without merged sections', { settingsFile: { ...SETTINGS_FILE, merged: [] } }, /app\.settingsFile must be/],
  ['a settingsFile path that is not absolute', { settingsFile: { ...SETTINGS_FILE, path: 'settings.js' } }, /app\.settingsFile must be/],
  ['a settingsFile global that is not a dotted name', { settingsFile: { ...SETTINGS_FILE, global: "window['FAKE_SETTINGS']" } }, /app\.settingsFile must be/],
  ['a settingsFile root that is not a settings root', { settingsFile: { ...SETTINGS_FILE, root: 'appSettings' } }, /app\.settingsFile\.root "appSettings" is not listed in settingsRoots/],
] satisfies [string, object, RegExp][]) {
  test(`app settings with ${name} are rejected`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
    try {
      const file = path.join(dir, 'config.json');
      const app = { ...appSettings('http://127.0.0.1:1').app, ...broken };
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), app }));
      assert.throws(() => loadConfig(file), (err: Error) => message.test(err.message) && !err.message.includes('s3cret'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('an issuing API is accepted without login.header, since it is called with its key and not the login token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    const app = { ...appSettings('http://127.0.0.1:1').app, pathValues: { '/document/:id': { id: ISSUING_API } } };
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), app }));
    assert.deepEqual(loadConfig(file).app.pathValues['/document/:id'].id, ISSUING_API);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a query value is accepted as a fixed value, a list API or an issuing API', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    const pathValues = { '/view/:documentId': { documentId: '1', '?lang': 'ko', '?mode': LIST_API, '?token': VIEW_TOKEN_API } };
    const app = { ...appSettings('http://127.0.0.1:1').app, login: loginWithHeader, pathValues };
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), app }));
    assert.deepEqual(loadConfig(file).app.pathValues, pathValues);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a list API answering with bare values is accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    const app = { ...appSettings('http://127.0.0.1:1').app, login: loginWithHeader, pathValues: { '/document/:id': { id: { ...LIST_API, list: '', value: '' } } } };
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(FIXTURE, 'config.json'), 'utf8')), app }));
    assert.equal(loadConfig(file).app.pathValues['/document/:id'].id.value, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('the end request asks the caller to get ready, is answered, and then tells the caller to finish, and an end request that is not JSON is refused', async () => {
  await withRebuiltFixture({}, async (config) => {
    let done: () => void;
    const ended = new Promise<void>((resolve) => (done = resolve));
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => done });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const plain = await fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(plain.status, 415);
      const signalled = await Promise.race([ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 100))]);
      assert.equal(signalled, false);
      assert.equal((await fetch(`${base}/`)).status, 200);

      const res = await fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 200);
      assert.equal(await Promise.race([ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 1000))]), true);
    } finally {
      server.close();
    }
  });
});

const browserMissing = fs.existsSync(chromium.executablePath()) ? false : 'Chromium is not installed (npx playwright-core install chromium)';

const toList = async (p: Page) => {
  await p.waitForSelector('#view-flow.on, #view-list.on');
  await p.click('#view-list');
};

async function withPage(base: string, fn: (p: Page, errors: string[]) => Promise<void>, { view = 'list', setup }: { view?: string; setup?: (page: Page) => Promise<unknown> } = {}) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    if (setup) await setup(page);
    await page.goto(base);
    if (view === 'list') await toList(page);
    await fn(page, errors);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

const untaggedTab = '#left .views.side button:has-text("태그 없음")';

test('in a browser, the header does not name an author taken from the config, and a mark saved on the page is signed with the config author even when git has a name', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ author: '설정 이름' }, (config, copy) => {
    initGitRepoNamed(copy, 'Git 이름');
    return withServer(config, undefined, (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent('#author'), '');
        assert.equal(await p.locator('header input').count(), 0);
        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => m.author), ['설정 이름']);
      }),
    );
  });
});

test('in a browser, the header names the author only when the name is the computer user name, and says why', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    for (const source of ['config', 'git']) {
      await withServer(config, signer('reviewer', source), (base) =>
        withPage(base, async (p) => {
          await p.waitForSelector('#screen-list li');
          assert.equal(await p.textContent('#author'), '', source);
        }));
    }
    await withServer(config, signer('hit0607', 'user'), (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent('#author'), '작성자 hit0607');
        assert.match((await p.getAttribute('#author', 'title'))!, /컴퓨터 사용자 이름/);
      }));
  });
});

test('in a browser, marks and judgments show only their date while every one of them is the reviewer\'s own, and show the names once another person\'s is among them', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li');
        await p.locator('#center .importers .importer', { hasText: 'renders the help text' }).locator('button.hand-over').click();
        await p.waitForSelector('#center .awaiting-tag');
        const signed = () => Promise.all(['#right .history li .muted', '#center .awaiting-tag .importer .detail .muted'].map((sel) => p.textContent(sel)));
        for (const text of await signed()) {
          assert.doesNotMatch(text!, /reviewer/);
          assert.match(text!, /\d/);
        }

        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: HOME_NODE, kind: 'discard', reason: 'judged elsewhere', author: 'someone' });
        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/help")');
        for (const text of await signed()) assert.match(text!, /reviewer · /);
        await p.click('#screen-list li:has-text("/home")');
        assert.match((await p.textContent('#center .discarded .importer'))!, /judged elsewhere · someone · /);
      })));
});

for (const host of ['127.0.0.1', 'localhost']) {
  test(`in a browser at ${host}, the list filters screens, a mark is saved as a file and is there after reloading`, { skip: browserMissing }, async () => {
    await withRebuiltFixture({}, (config) =>
      withServer(config, 'reviewer', (base) =>
        withPage(base.replace('127.0.0.1', host), async (p) => {
          await p.waitForSelector('#screen-list li');
          assert.equal(await p.locator('#screen-list li').count(), 11);
          assert.equal(await p.textContent('#author'), '');

          await p.fill('#left input[type=search]', 'lab');
          assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/lab', '/lab/result']);
          await p.fill('#left input[type=search]', '');
          await p.check('#left input[name=no-tests]');
          const noTests = await p.locator('#screen-list li').allTextContents();
          assert.ok(noTests.length > 0 && noTests.every((t) => t.includes('테스트 없음')));
          await p.uncheck('#left input[name=no-tests]');

          await p.click('#screen-list li:has-text("/document/:id")');
          assert.equal(await p.textContent('#center h3'), '/document/:id');
          await p.click('#center tr:has-text("API")');
          assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /API 깊이/);
          assert.equal(await p.isDisabled('#right button.save'), true);
          await p.click('#right .statuses button:has-text("더 필요")');
          await p.fill('#right-dock textarea', 'no API test yet');
          await p.click('#right button.save');
          await p.waitForSelector('#right .history li:has-text("no API test yet")');
          assert.match((await p.textContent('#center tr.selected td.mark'))!, /더 필요/);
          assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status, m.note, m.author]), [
            [{ node: '/document/:id#DocumentDetail', depth: 'api' }, 'needs-more', 'no API test yet', 'reviewer'],
          ]);

          await p.click('#center tr:has-text("화면 전체")');
          await p.click('#right .statuses button:has-text("충분")');
          await p.click('#right button.save');
          await p.waitForSelector('#screen-list li.selected .chip');
          assert.equal(await p.textContent('#screen-list li.selected .chip'), '충분');

          await p.reload();
          await toList(p);
          await p.click('#screen-list li:has-text("/document/:id")');
          await p.click('#center tr:has-text("API")');
          assert.ok((await p.locator('#right .history li').allTextContents()).some((t) => t.includes('no API test yet')));

          await p.emulateMedia({ colorScheme: 'dark' });
          assert.notEqual(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
        }),
      ),
    );
  });
}

test('in a browser, a comment with no status is saved from the text alone, shows in the conversation with no 「코멘트」 label and leaves the current status as it was; pressing a picked status again lets it go', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await toList(p);
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.waitForSelector('#screen-list li.selected .chip.missing');

        assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), ['없음']);
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await p.locator('#right .statuses button.on').count(), 0);
        assert.equal(await p.isDisabled('#right button.save'), true);
        await p.fill('#right-dock textarea', 'the empty list too');
        assert.equal(await p.isDisabled('#right button.save'), false);
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("the empty list too")');
        assert.equal(await p.locator('#right .history li:has-text("the empty list too") .chip').count(), 0);
        assert.equal(await p.textContent('#right .history li:has-text("the empty list too") .tag-label'), '화면 전체');
        assert.equal(await p.textContent('#screen-list li.selected .chip'), '없음');
        assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), ['없음']);
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.status ?? null, m.note]).sort(), [[null, 'the empty list too'], ['missing', '']]);

        await p.fill('#right-dock textarea', 'typed with the status still picked');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("typed with the status still picked")');
        assert.equal(await p.locator('#right .history li:has-text("typed with the status still picked") .chip').count(), 0);
        await p.click('#right .statuses button:has-text("없음")');
        p.once('dialog', (d) => assert.fail(`no unsaved warning expected, got: ${d.message()}`));
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
      }),
    ),
  );
});

const reply = (copy: string, ...args: string[]) => promisify(execFile)(process.execPath, [CLI, 'reply', path.join(copy, 'config.json'), ...args], { encoding: 'utf8' });

test('in a browser, a reply sent with duru reply --server shows under its comment on the open page without a reload, unlabelled, not indented and on its own background, and text being typed in the form keeps its place', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.fill('#right-dock textarea', 'why is the list empty?');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("why is the list empty?")');
        const [comment] = loadMarks(config.marksDir);
        await p.evaluate(() => { (window as Window & Kept).kept = true; });
        await p.click('#right-dock textarea');
        await p.keyboard.type('half');

        await reply(copy, comment.id, 'the fixture has no rows', '--server', `${base}/`);
        await p.waitForSelector('#right .history > li:has-text("why is the list empty?") .replies li:has-text("the fixture has no rows")');
        assert.equal(await p.locator('#right .history > li').count(), 1);
        assert.equal(await p.locator('#right .history .replies li .chip').count(), 0);
        assert.match((await p.textContent('#right .history .replies li .muted'))!, /^agent · /);
        const look = (sel: string) => p.locator(sel).first().evaluate((e) => ({ left: e.getBoundingClientRect().left, background: getComputedStyle(e).backgroundColor }));
        const [asked, answered] = [await look('#right .history > li'), await look('#right .history .replies li')];
        assert.ok(Math.abs(answered.left - asked.left) < 1, `the answer starts at ${answered.left}, its comment at ${asked.left}`);
        assert.notEqual(answered.background, asked.background);
        assert.equal(await p.evaluate(() => (window as Window & Kept).kept), true);
        await p.keyboard.type(' and more');
        assert.equal(await p.inputValue('#right-dock textarea'), 'half and more');
      }),
    ),
  );
});

test('in a browser, a record arriving while the reviewer types keeps the field and its caret, waits while a Korean syllable is being composed, and the page reads its own save once', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const dataReads: string[] = [];
        p.on('request', (r) => new URL(r.url()).pathname === '/api/data' && dataReads.push(r.url()));
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.fill('#right-dock textarea', 'why is the list empty?');
        const before = dataReads.length;
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("why is the list empty?")');
        await p.waitForTimeout(300);
        assert.equal(dataReads.length - before, 1);
        const [comment] = loadMarks(config.marksDir);

        const nextEvent = () => p.evaluateHandle(() => ({
          heard: new Promise<void>((resolve) => {
            const events = new EventSource('/api/events');
            events.addEventListener('message', () => { events.close(); resolve(); });
            events.addEventListener('open', () => { (window as Window & Listening).listening = true; });
          }),
        }));
        const listen = async () => {
          await p.evaluate(() => { (window as Window & Listening).listening = false; });
          const heard = await nextEvent();
          await p.waitForFunction(() => (window as Window & Listening).listening);
          return heard;
        };

        await p.click('#right-dock textarea');
        await p.keyboard.type('abcdef');
        for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowLeft');
        await reply(copy, comment.id, 'first answer', '--server', `${base}/`);
        await p.waitForSelector('#right .history .replies li:has-text("first answer")');
        await p.keyboard.type('X');
        assert.equal(await p.inputValue('#right-dock textarea'), 'abcXdef');

        await p.dispatchEvent('#right-dock textarea', 'compositionstart');
        const heard = await listen();
        const reads = dataReads.length;
        await reply(copy, comment.id, 'second answer', '--server', `${base}/`);
        await p.evaluate((h) => h.heard, heard);
        await p.waitForTimeout(300);
        assert.equal(dataReads.length, reads);
        assert.equal(await p.locator('#right .history .replies li:has-text("second answer")').count(), 0);
        await p.dispatchEvent('#right-dock textarea', 'compositionend');
        await p.waitForSelector('#right .history .replies li:has-text("second answer")');
        assert.equal(await p.inputValue('#right-dock textarea'), 'abcXdef');

        await p.dispatchEvent('#right-dock textarea', 'compositionstart');
        await p.click('#screen-list li:has-text("/home")');
        await reply(copy, comment.id, 'third answer', '--server', `${base}/`);
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.waitForSelector('#right .history .replies li:has-text("third answer")');
      }),
    ),
  );
});

type Listening = { listening?: boolean };

test('in a browser, an entry under 「떨어져 나감」 with a comment and an answer shows the comment, not the answer', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const comment = addMark(config.marksDir, { target: { node: '/gone#Gone' }, note: 'is this screen gone?', author: 'a' }, new Date('2026-10-03T01:00:00Z'));
    addReply(config.marksDir, { replyTo: comment.id, note: 'yes, it was removed' }, new Date('2026-10-03T02:00:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#left .detached li');
        const entry = (await p.textContent('#left .detached li'))!;
        assert.match(entry, /is this screen gone\?/);
        assert.doesNotMatch(entry, /removed/);
      }),
    );
  });
});

test('closing the review server ends the open event streams, and a stream opened after 「리뷰 끝」 is ended at once', async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => null });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const open = await fetch(`${base}/api/events`);
    const body = open.text();
    await postMark(base, { target: { node: '/home#Home' }, note: 'while the stream is open' });
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    assert.match(await body, /^data: \{"duru":"comment",[^\n]*"note":"while the stream is open"[^\n]*\n\nevent: end\ndata: review ended\n\n$/);
    await closed;

    const again = await startReviewServer(config, { author: signer('reviewer'), onDone: () => null });
    const againBase = `http://127.0.0.1:${(again.address() as AddressInfo).port}`;
    try {
      const early = (await fetch(`${againBase}/api/events`)).text();
      const [end, during] = await Promise.all([
        fetch(`${againBase}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
        postMark(againBase, { target: { node: '/home#Home' }, note: 'saved as the review ends' }),
      ]);
      assert.deepEqual([end.status, during.status], [200, 201]);
      assert.match(await early, /event: end\ndata: review ended\n\n$/);
      const late = await fetch(`${againBase}/api/events`);
      assert.equal(await late.text(), 'event: end\ndata: review ended\n\n');
      const saved = await postMark(againBase, { target: { node: '/home#Home' }, note: 'saved after the end' });
      assert.equal(saved.status, 201);
    } finally {
      again.close();
    }
  });
});

test('in a browser, a mark and a comment saved in one page show in a second page that is already open', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const other = await p.context().browser()!.newPage();
        const otherErrors: string[] = [];
        other.on('pageerror', (e) => otherErrors.push(e.message));
        other.on('console', (m) => m.type() === 'error' && otherErrors.push(m.text()));
        await other.goto(base);
        await toList(other);
        await other.click('#screen-list li:has-text("/document/:id")');
        await other.evaluate(() => { (window as Window & Kept).kept = true; });

        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await other.waitForSelector('#screen-list li.selected .chip.missing');
        await p.fill('#right-dock textarea', 'from the first page');
        await p.click('#right button.save');
        await other.waitForSelector('#right .history li:has-text("from the first page")');
        assert.equal(await other.evaluate(() => (window as Window & Kept).kept), true);
        assert.deepEqual(otherErrors, []);
      }),
    ),
  );
});

test('in a browser, a reply written without --server is not pushed to the open page and shows once the page is loaded again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.fill('#right-dock textarea', 'why is the list empty?');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("why is the list empty?")');
        const [comment] = loadMarks(config.marksDir);

        await reply(copy, comment.id, 'the fixture has no rows');
        assert.equal(loadMarks(config.marksDir).length, 2);
        assert.equal(await p.locator('#right .history .replies').count(), 0);
        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.waitForSelector('#right .history > li:has-text("why is the list empty?") .replies li:has-text("the fixture has no rows")');
      }),
    ),
  );
});

type Kept = { kept?: boolean };

test('in a browser, drawing the screens side again keeps the search box and its filtering, and draws the 「떨어져 나감」 block once with the marks read again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const search = '#left input[type=search]';
        const detachedHeadings = () => p.locator('#left h2:has-text("떨어져 나감")').allTextContents();
        assert.deepEqual(await detachedHeadings(), ['떨어져 나감 0']);
        await p.fill(search, 'lab');
        await p.$eval(search, (el: HTMLInputElement & Kept) => { el.kept = true; });
        await postMark(base, { target: { node: '/gone#Gone' }, status: 'missing' });
        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#right .statuses button:has-text("충분")');
        await p.click('#right button.save');
        await p.waitForSelector('#screen-list li.selected .chip');
        assert.equal(await p.$eval(search, (el: HTMLInputElement & Kept) => el.kept), true);
        assert.equal(await p.inputValue(search), 'lab');
        assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/lab', '/lab/result']);
        assert.deepEqual(await detachedHeadings(), ['떨어져 나감 1']);
        assert.deepEqual(await p.locator('#left .detached li code').allTextContents(), ['/gone#Gone']);
      })));
});

test('a map.json built before links carried their conditions leaves the stories out with a message asking to rebuild apart from the story file notes, keeps the marks on stories attached, and the rest of the data and the task list still work', async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) for (const l of s.links) delete l.conditions;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    addMark(config.marksDir, { target: { story: 'run-lab' }, status: 'missing', author: 'a' }, new Date('2026-10-03T01:00:00Z'));
    await withServer(config, 'reviewer', async (base) => {
      const res = await fetch(`${base}/api/data`);
      assert.equal(res.status, 200);
      const data: PageData = await res.json();
      assert.equal(data.stories.list.length, 0);
      assert.deepEqual(data.stories.notices.map((n) => n.file), ['lab-shortcut.json']);
      assert.ok(data.stories.stale.startsWith(`${mapFile} 은 `));
      assert.match(data.stories.stale, /duru rebuild 로 맵을 다시 만드세요$/);
      assert.equal(data.map.screens.length, map.screens.length);
      assert.deepEqual([data.marks.attached.map((m) => m.key), data.marks.detached], [['story(run-lab)'], []]);
    });
    const tasks = taskList(config);
    assert.match(tasks, /^# Test tasks — 0 screens, 0 calls, 1 story, 1 open mark\n/);
    assert.equal(tasks.slice(tasks.indexOf('\n# Stories\n')), [
      '',
      '# Stories',
      '',
      'Story files are in `example-stories`.',
      '',
      'The map was built by a duru older than stories, so these stories are not checked against it. Run `duru rebuild` and read this list again.',
      '',
      '## run-lab',
      '',
      '- marks:',
      '  - missing (a, 2026-10-03)',
      '',
    ].join('\n'));
  });
});

test('a mark on a story is saved through the page, and one on a story ID outside the ID rule is refused', async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      assert.equal((await postMark(base, { target: { story: 'run-lab' }, status: 'missing', note: 'walk it' })).status, 201);
      const refused = await postMark(base, { target: { story: '../run-lab' }, status: 'missing' });
      assert.equal(refused.status, 400);
      assert.equal((await postMark(base, { target: { story: 'run-lab', depth: 'ui' }, status: 'missing' })).status, 400);
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.map((m) => [m.key, m.target, m.current.note, m.current.author]), [['story(run-lab)', { story: 'run-lab' }, 'walk it', 'reviewer']]);
    }),
  );
});

test('in a browser, a map.json built before links carried their conditions shows the request to rebuild instead of the empty story list, and does not count it as an unreadable story file', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) for (const l of s.links) delete l.conditions;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.match((await p.textContent('#left'))!, /duru rebuild 로 맵을 다시 만드세요/);
        assert.doesNotMatch((await p.textContent('#left'))!, /스토리 파일이 없습니다/);
        assert.equal(await p.locator('#story-list li').count(), 0);
        assert.equal(await p.locator('#left .notices li').count(), 1);
        assert.equal(await p.textContent('#left .notices li code'), 'lab-shortcut.json');
        assert.match((await p.textContent('#left'))!, /읽지 못한 스토리 파일 1/);
      }),
    );
  });
});

test('in a browser, the three left tabs stay on one line inside the column, also with three-digit counts and a classic scrollbar', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let counts: { screens: number; stories: number; untagged?: number } = { screens: 11, stories: 5 };
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data: PageData = await res.json();
          const grow = <T>(list: T[], n: number) => Array.from({ length: n }, (_, i) => list[i % list.length]);
          data.map.screens = grow(data.map.screens, counts.screens);
          data.stories.list = grow(data.stories.list, counts.stories);
          if (counts.untagged !== undefined) {
            delete data.tests.untagged;
            data.tests.untaggedCount = counts.untagged;
          }
          await route.fulfill({ response: res, json: data });
        });
        const measure = () => p.evaluate(() => {
          const left = document.getElementById('left')!;
          const row = left.querySelector('.views.side')!;
          const probe = row.cloneNode(true) as HTMLElement;
          probe.style.cssText = 'position: absolute; visibility: hidden; width: 1000px';
          for (const b of [...probe.children].slice(1)) b.remove();
          probe.querySelector('.tab-name')!.textContent = '가';
          probe.querySelector('.tab-count')!.textContent = '1';
          left.append(probe);
          const oneLine = probe.firstElementChild!.getBoundingClientRect().height;
          probe.remove();
          const middle = (el: Element) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
          const tabs = [...row.children];
          return {
            heights: tabs.map((b) => b.getBoundingClientRect().height),
            oneLine,
            drop: tabs.map((b) => Math.abs(middle(b.querySelector('.tab-name')!) - middle(b.querySelector('.tab-count')!))),
            inside: tabs.map((b) => {
              const box = b.getBoundingClientRect();
              const name = b.querySelector('.tab-name')!.getBoundingClientRect();
              const count = b.querySelector('.tab-count')!.getBoundingClientRect();
              const edge = b.clientLeft + parseFloat(getComputedStyle(b).paddingLeft);
              return name.left >= box.left + edge - 0.5 && name.right <= count.left && count.right <= box.right - edge + 0.5;
            }),
            cut: tabs.map((b) => {
              const name = b.querySelector('.tab-name')!;
              const text = document.createRange();
              text.selectNodeContents(name);
              return name.getBoundingClientRect().width < text.getBoundingClientRect().width - 0.1;
            }),
            labels: tabs.map((b) => b.textContent),
            rowScroll: [row.scrollWidth, row.clientWidth],
            leftScroll: [left.scrollWidth, left.clientWidth],
          };
        });
        const assertFits = (m: Awaited<ReturnType<typeof measure>>, why: string) => {
          assert.deepEqual(m.heights, Array(3).fill(m.oneLine), `${why}: every tab is as tall as a one-line tab`);
          assert.ok(m.drop.every((d) => d <= 3), `${why}: each count stays beside its name ${m.drop}`);
          assert.deepEqual(m.inside, Array(3).fill(true), `${why}: name and count stay inside their tab's padding`);
          assert.ok(m.rowScroll[0] <= m.rowScroll[1], `${why}: row ${m.rowScroll[0]} fits in ${m.rowScroll[1]}`);
          assert.ok(m.leftScroll[0] <= m.leftScroll[1], `${why}: left column ${m.leftScroll[0]} does not scroll sideways in ${m.leftScroll[1]}`);
        };
        const show = async (c: typeof counts) => {
          counts = c;
          await p.reload();
          await toList(p);
          await p.waitForSelector('#screen-list li');
        };

        const scrollbar = () => p.addStyleTag({ content: '#left { padding-right: 31px !important; }' });

        await show({ screens: 11, stories: 5 });
        let m = await measure();
        assert.deepEqual(m.labels, ['화면 11', '스토리 5', '태그 없음 13']);
        assert.deepEqual(m.cut, [false, false, false]);
        assertFits(m, 'default counts');

        await show({ screens: 111, stories: 5, untagged: 999 });
        m = await measure();
        assert.deepEqual(m.labels, ['화면 111', '스토리 5', '태그 없음 999']);
        assert.deepEqual(m.cut, [false, false, false]);
        assertFits(m, 'three-digit counts');

        await show({ screens: 111, stories: 5, untagged: 999 });
        await scrollbar();
        m = await measure();
        assert.deepEqual(m.cut, [false, false, false]);
        assertFits(m, 'three-digit counts with a classic scrollbar');

        await show({ screens: 111, stories: 111, untagged: 999 });
        await scrollbar();
        await p.click('#left .views.side button:nth-child(3)');
        assertFits(await measure(), 'three-digit counts on every tab, a classic scrollbar and the widest tab chosen');
      })));
});

test('in a browser, the story list sits next to the screen list, and a chosen story shows its screens in order with each link\'s verdict and what it takes to get to the end', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.deepEqual(await p.locator('#left .views.side button').allTextContents(), ['화면 11', '스토리 5', '태그 없음 13']);
        assert.deepEqual(await p.locator('#left .views.side .tab-name').allTextContents(), ['화면', '스토리', '태그 없음']);
        assert.deepEqual(await p.locator('#left .views.side .tab-count').allTextContents(), ['11', '5', '13']);
        assert.equal(await p.getAttribute(untaggedTab, 'title'), '노드 태그도 스토리 태그도 없는 테스트');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.deepEqual(await p.locator('#story-list li .name > span:first-child').allTextContents(), [
          '홈에서 개인 설정을 바꾼다', '홈에서 바로 도움말을 연다', '로그인해 문서 목록에서 문서를 연다', '관리자가 보고서를 본다', '실험실을 열어 결과를 본다',
        ]);
        assert.deepEqual(await p.locator('#story-list li').evaluateAll((items) => items.map((li) => [...li.querySelectorAll('.chip')].map((c) => c.textContent))), [
          ['일부 화면만 테스트', '화면 없음'], ['보류', '링크 없음'], [], ['테스트 없음'], ['실패'],
        ]);
        assert.equal(await p.locator('#story-list li:has-text("개인 설정") .chip.l-off-map').getAttribute('title'), '맵에서 찾을 수 없는 화면: /settings#Settings');
        assert.match((await p.textContent('#left .notices'))!, /lab-shortcut\.json.*screens 는/);

        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.textContent('#center h3'), '실험실을 열어 결과를 본다');
        assert.match((await p.textContent('#center .memo'))!, /고객사 설정/);
        assert.deepEqual(await p.locator('#center .story-path .step .name > span:first-child').allTextContents(), ['/home', '/lab', '/lab/result']);
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['조건', '이어짐']);
        assert.match((await p.textContent('#center .story-path .link.l-conditioned'))!, /components\/Home\.js:19\s*globalSettings\.SYSTEM\.LAB_ENABLED\s*설정/);
        assert.deepEqual(await p.locator('#right-info > :not(.talk-scope)').evaluateAll((els) => els.slice(0, 2).map((e) => e.textContent)), ['도달 가능', '사전 조건']);
        assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트']);
        assert.match((await p.textContent('#right .reach-link'))!, /components\/Home\.js:19/);
        assert.match((await p.textContent('#right .reach-route'))!, /Routes\.js:44.*globalSettings\.SYSTEM\.LAB_ENABLED/);
        assert.equal(await p.locator('#center iframe').count(), 0);

        await p.click('#story-list li:has-text("도움말")');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['이어짐', '링크 없음']);
        assert.equal(await p.textContent('#center .story-path .link.l-broken'), '링크 없음');
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 불가 · 링크 없음 1곳']);

        await p.click('#story-list li:has-text("개인 설정")');
        assert.equal(await p.textContent('#center .story-path .step.off-map .chip'), '맵에 없는 화면');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['판정 못 함']);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['판정 못 함 · 화면 없음']);

        await p.click('#story-list li:has-text("문서를 연다")');
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 가능']);
        assert.equal(await p.textContent('#right-info > p.muted'), '조건 없음');
        await p.click('#center .story-path .step:has-text("/document/:id")');
        assert.equal(await p.getAttribute('#left .views.side button.on', 'class'), 'on');
        assert.equal(await p.textContent('#left .views.side button.on'), '화면 11');
        assert.equal(await p.textContent('#center h3'), '/document/:id');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/document\/:id/);

        await p.click('#left .views.side button:has-text("스토리")');
        assert.equal(await p.textContent('#story-list li.selected .name > span:first-child'), '로그인해 문서 목록에서 문서를 연다');

        await p.click('#view-flow');
        await (await screenBox(p, '/lab/result#LabResult')).click();
        await p.waitForSelector('#flow .box.picked');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
        await p.click('#view-list');
        assert.equal(await p.textContent('#left .views.side button.on'), '화면 11');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
      }),
    ),
  );
});

test('in a browser, a step that a move in the config joins shows as 설정에 적은 이동 with its reason, and the story is reachable', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories', moves: [{ from: '/signin', to: '/lab/result', reason: '로그인 뒤' }] }, (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/signin-lab.json'), JSON.stringify({ name: '로그인해서 실험 결과를 본다', screens: ['/signin#SignIn', '/lab/result#LabResult'], author: 'a', date: '2026-10-03' }));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험 결과를 본다")');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['설정에 적은 이동']);
        assert.equal(await p.textContent('#center .story-path .link.l-configured'), '설정에 적은 이동 로그인 뒤');
        assert.match((await p.getAttribute('#center .story-path .link.l-configured .link-verdict', 'title'))!, /moves/);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 가능']);
      }),
    );
  });
});

test('in a browser, the story list shows only the statuses that need a look, filters by 테스트 없음, 일부 화면만 테스트, 실패 and 링크 없음, and a chosen story shows its status, its story tests and the tests on each screen by depth and status', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.equal(await p.getAttribute('#story-list li:has-text("보고서") .chip', 'title'), '스토리 테스트도, 경로의 화면에 붙은 테스트도 없습니다');

        const ids = () => p.locator('#story-list li .name .mono').allTextContents();
        assert.deepEqual(await p.locator('#left .filters legend').allTextContents(), ['상태 · 하나라도 맞으면', '그리고']);
        assert.deepEqual(await p.locator('#left .filters fieldset').evaluateAll((els) => els.map((e) => [...e.querySelectorAll('label')].map((l) => l.textContent))),
          [['테스트 없음', '일부 화면만 테스트', '실패'], ['링크 없음']]);
        await p.check('#left input[name=untested]');
        assert.deepEqual(await ids(), ['read-reports']);
        await p.check('#left input[name=partial]');
        assert.deepEqual(await ids(), ['change-settings', 'read-reports']);
        await p.check('#left input[name=broken]');
        assert.deepEqual(await ids(), []);
        assert.equal(await p.textContent('#story-list li.muted'), '해당하는 스토리가 없습니다.');
        await p.uncheck('#left input[name=untested]');
        await p.uncheck('#left input[name=partial]');
        assert.deepEqual(await ids(), ['help-from-home']);
        await p.check('#left input[name=fail]');
        assert.deepEqual(await ids(), []);
        await p.uncheck('#left input[name=broken]');
        assert.deepEqual(await ids(), ['run-lab']);

        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['실패']);
        assert.equal(await p.textContent('#center .story-tests h2'), '스토리 테스트 2');
        assert.deepEqual(await p.locator('#center .story-tests .test').evaluateAll((items) => items.map((t) => [...t.querySelectorAll('.depth, .chip')].map((e) => e.textContent))), [
          ['API', '실패'], ['API', '통과'],
        ]);
        assert.match((await p.locator('#center .story-tests .test').first().textContent())!, /Lab flow › runs the lab and reads the result com\.example/);
        const stepTests = () => p.locator('#center .story-path .step').evaluateAll((steps) => steps.map((s) => [...s.querySelectorAll('.step-tests > span')].map((e) => e.textContent.trim())));
        assert.deepEqual(await stepTests(), [['UI/E2E ✓3', 'API ✓1 ○1', '렌더링만 ✕1', '코드 ✓1', '데이터 ✕1'], ['UI/E2E ✓2 ○1', '코드 ○1'], ['화면 테스트 없음']]);
        assert.match((await p.getAttribute('#center .story-path .step:nth-child(3) .step-tests > span:first-child', 'title'))!, /opens the lab @screen:\/lab#Lab/);

        await p.uncheck('#left input[name=fail]');
        assert.equal((await ids()).length, 5);
        await p.click('#story-list li:has-text("문서를 연다")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['통과']);
        assert.deepEqual(await stepTests(), [['UI/E2E ✓1', '코드 ✓1'], ['UI/E2E ✓3', 'API ✓1 ○1', '렌더링만 ✕1', '코드 ✓1', '데이터 ✕1'], ['API ✓1 ✕2 ○1', '데이터 ○4'], ['UI/E2E ✓1', 'API ✓3 ✕3', '데이터 ✓2 ○2']]);

        await p.click('#story-list li:has-text("보고서")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['테스트 없음']);
        assert.equal(await p.textContent('#center .story-tests h2'), '스토리 테스트 0');
        assert.deepEqual(await stepTests(), [['화면 테스트 없음']]);
      }),
    ),
  );
});

test('in a browser, a chosen story takes marks that are saved as files and kept as its history, and once its story file is gone the mark shows as detached under the stories', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await p.locator('#right h2').allTextContents(), ['사전 조건', '이름 · 메모', '에이전트와 대화']);
        assert.equal(await p.isDisabled('#right button.save'), true);
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', 'no test walks the lab');
        await p.click('#right button.save');
        await openHistory(p);
        await p.waitForSelector('#right .history li:has-text("no test walks the lab")');
        await p.click('#right .statuses button:has-text("더 필요")');
        await p.fill('#right-dock textarea', 'the story test fails');
        await p.click('#right button.save');
        await p.waitForSelector('#right .history li:has-text("the story test fails")');
        assert.deepEqual(await p.locator('#right .history li .chip').allTextContents(), ['없음', '더 필요']);
        assert.equal(await p.textContent('#story-list li.selected .chip.needs-more'), '더 필요');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status!, m.note, m.author] as const).sort((a, b) => a[1].localeCompare(b[1])), [
          [{ story: 'run-lab' }, 'missing', 'no test walks the lab', 'reviewer'],
          [{ story: 'run-lab' }, 'needs-more', 'the story test fails', 'reviewer'],
        ]);
        assert.equal(fs.readdirSync(path.join(config.marksDir, 'stories', 'run-lab')).length, 2);

        await p.click('#story-list li:has-text("보고서")');
        assert.equal(await p.locator('#right .history li').count(), 0);
        assert.equal(await p.locator('#right .statuses button.on').count(), 0);
        await p.click('#left .views.side button:has-text("화면")');
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /^화면 전체$/);
        assert.equal(await p.locator('#right .history li').count(), 0);
        assert.match((await p.textContent('#left'))!, /떨어져 나감 0/);

        fs.rmSync(path.join(config.storiesDir, 'run-lab.json'));
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.match((await p.textContent('#left'))!, /떨어져 나감 0/);
        await p.click('#left .views.side button:has-text("스토리")');
        assert.equal(await p.locator('#story-list li:has-text("실험실을 열어")').count(), 0);
        assert.match((await p.textContent('#left'))!, /떨어져 나감 1/);
        const detached = p.locator('#left .detached li');
        assert.equal(await detached.count(), 1);
        assert.equal(await detached.locator('.chip').textContent(), '더 필요');
        assert.equal(await detached.locator('code').textContent(), 'run-lab');
        assert.match((await detached.textContent())!, /the story test fails/);
        assert.doesNotMatch((await detached.textContent())!, /reviewer/);
      }),
    ),
  );
});

test('in a browser, a failed save stays with the form that tried it and is gone after choosing another story or switching tabs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        const failSave = async () => {
          if (!(await p.locator('#right .statuses button.on:has-text("없음")').count())) await p.click('#right .statuses button:has-text("없음")');
          await p.click('#right button.save');
          await p.waitForSelector('#right .error');
          assert.match((await p.textContent('#right'))!, /저장하지 못했습니다: disk full/);
        };
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.locator('#right .error').count(), 0);
        await failSave();
        await p.click('#story-list li:has-text("보고서")');
        assert.doesNotMatch((await p.textContent('#right'))!, /저장하지 못했습니다/);
        await p.click('#story-list li:has-text("실험실을 열어")');
        await failSave();
        await p.click('#left .views.side button:has-text("화면")');
        assert.doesNotMatch((await p.textContent('#right'))!, /저장하지 못했습니다/);
        await p.click('#left .views.side button:has-text("스토리")');
        await failSave();
        await p.click('#center .story-path .step:has-text("/lab/result")');
        assert.equal(await p.textContent('#center h3'), '/lab/result');
        assert.doesNotMatch((await p.textContent('#right'))!, /저장하지 못했습니다/);
      }),
    ),
  );
});

test('in a browser, a mark on a story whose file is there but cannot be read shows on the stories tab and can be marked again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config) => {
    fs.writeFileSync(path.join(config.storiesDir, 'run-lab.json'), '{');
    addMark(config.marksDir, { target: { story: 'run-lab' }, status: 'missing', note: 'walk it', author: 'a' }, new Date('2026-09-30T01:00:00Z'));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.match((await p.textContent('#left'))!, /떨어져 나감 0/);
        const unread = p.locator('#left .unread-marks li');
        assert.equal(await unread.count(), 1);
        assert.equal(await unread.locator('.chip').textContent(), '없음');
        assert.equal(await unread.locator('code').textContent(), 'run-lab');
        await unread.click();
        assert.equal(await p.textContent('#center h3'), 'run-lab');
        assert.equal(await p.textContent('#right h2'), '에이전트와 대화');
        assert.equal(await p.locator('#right-info > :not(.talk-scope)').count(), 0);
        assert.ok(await p.evaluate(() => document.getElementById('right-dock')!.getBoundingClientRect().top - document.getElementById('right-info')!.getBoundingClientRect().bottom) < 1, 'the form sits right under the conversation buttons');
        assert.match((await p.textContent('#right .history'))!, /walk it/);
        await p.click('#right .statuses button:has-text("충분")');
        await p.click('#right button.save');
        await openHistory(p);
        await p.waitForSelector('#right .history li:nth-child(2)');
        assert.equal(await p.textContent('#right .history > li:last-child .chip'), '충분');
        assert.equal(await p.textContent('#left .unread-marks li .chip'), '충분');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status!] as const).sort((a, b) => a[1].localeCompare(b[1])), [
          [{ story: 'run-lab' }, 'fine'], [{ story: 'run-lab' }, 'missing'],
        ]);
      }),
    );
  });
});

type FailSave = { failSave: () => void };

test('in a browser, a failed save stays with the screen or cell that tried it, and a save that fails after the reviewer moved on names the target it was for', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        const failSave = async () => {
          await p.click('#right .statuses button:has-text("없음")');
          await p.click('#right button.save');
          await p.waitForSelector('#right .error');
          assert.match((await p.textContent('#right'))!, /저장하지 못했습니다: disk full/);
        };
        await p.click('#screen-list li:has-text("/document/:id")');
        await failSave();
        await p.click('#center tr:has-text("API")');
        assert.doesNotMatch((await p.textContent('#right'))!, /저장하지 못했습니다/);
        await failSave();
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.doesNotMatch((await p.textContent('#right'))!, /저장하지 못했습니다/);

        await p.click('#screen-list li:has-text("/admin/report")');
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks')
            ? new Promise((resolve, reject) => { (window as unknown as FailSave).failSave = () => reject(new Error('disk full')); })
            : real(url, init));
        });
        await p.locator('table.calls tr.option', { hasText: 'withAttachments 켬' }).first().locator('td.cell').nth(1).click();
        const cellLabel = (await p.textContent('#right .mark-form .tags .tag-label'))!;
        assert.match(cellLabel, /^withAttachments 켬 · .+ 깊이$/);
        const cellName = `${await p.textContent('#center .call-info .target-id .mono')} · ${cellLabel}`;
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.click('#center tr:has-text("화면 전체")');
        assert.equal(await p.locator('#right .error').count(), 0);
        await p.evaluate(() => (window as unknown as FailSave).failSave());
        await p.waitForSelector('#right-dock .error');
        assert.equal(await p.textContent('#right-dock .error'), `「${cellName}」 코멘트를 저장하지 못했습니다: disk full`);

        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.evaluate(() => (window as unknown as FailSave).failSave());
        await p.waitForFunction(() => document.querySelector('#right-dock .error')?.textContent === '저장하지 못했습니다: disk full');
      }),
    ),
  );
});

test('in a browser, a story whose ID is the name of an object member shows like any other', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    fs.mkdirSync(config.storiesDir, { recursive: true });
    fs.writeFileSync(path.join(config.storiesDir, 'constructor.json'), JSON.stringify({ name: '이상한 ID', screens: ['/home#Home'], author: 'a', date: '2026-10-03' }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("이상한 ID")');
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['일부 화면만 테스트']);
        assert.equal(await p.textContent('#center .story-tests h2'), '스토리 테스트 0');
      }),
    );
  });
});

test('in a browser, a step whose first screen has no link to the next but has links to a path duru cannot read is not judged, and those links are listed, also next to a conditioned step judged without them but not next to an open one', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    rewrite(copy, 'client/src/_define/Option.js', "SIGN_IN: this.CONTEXT_PATH + 'signin',", "ROOT: this.CONTEXT_PATH,\n      SIGN_IN: this.CONTEXT_PATH + 'signin',");
    rewrite(copy, 'client/src/components/Lab.js', '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>',
      '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>\n      <Link to={Option.ROUTE_PATH.ROOT}>Start</Link>\n      <Link to={Option.ROUTE_PATH.NOPE}>Nope</Link>');
    rewrite(copy, 'client/src/components/Home.js', '<Link to={Option.ROUTE_PATH.LAB}>Lab</Link>}', '<Link to={Option.ROUTE_PATH.LAB}>Lab</Link>}\n      <Link to={Option.ROUTE_PATH.NOPE}>Nope</Link>');
    rebuild(copy);
    fs.mkdirSync(config.storiesDir, { recursive: true });
    const story = (name: string, screens: string[]) => JSON.stringify({ name, screens, author: 'a', date: '2026-10-02' });
    fs.writeFileSync(path.join(config.storiesDir, 'lab-to-start.json'), story('실험실에서 처음으로', ['/lab#Lab', '/signin#SignIn']));
    fs.writeFileSync(path.join(config.storiesDir, 'home-to-lab-result.json'), story('홈에서 실험 결과로', ['/home#Home', '/lab#Lab', '/lab/result#LabResult']));
    fs.writeFileSync(path.join(config.storiesDir, 'lab-result.json'), story('실험실에서 결과로', ['/lab#Lab', '/lab/result#LabResult']));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        assert.deepEqual(await p.locator('#story-list li').evaluateAll((items) => items.map((li) => [...li.querySelectorAll('.chip')].map((c) => c.textContent))), [
          ['일부 화면만 테스트'], ['일부 화면만 테스트'], ['일부 화면만 테스트', '판정 못 함'],
        ]);

        await p.click('#story-list li:has-text("처음으로")');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['판정 못 함']);
        assert.deepEqual(await p.locator('#center .story-path .link.l-unknown li').allTextContents(), [`components/Lab.js:16 → ${UNKNOWN}`]);
        assert.doesNotMatch((await p.textContent('#center .story-path'))!, /리다이렉트/);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['판정 못 함 · 주소 못 읽은 링크']);
        assert.equal(await p.locator('#right .skipped').count(), 0);

        await p.click('#story-list li:has-text("실험 결과로")');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['조건', '이어짐']);
        const skipped = (link: string) => p.locator(`#center .story-path .link.${link} .unknown-links li`).allTextContents();
        assert.deepEqual(await skipped('l-conditioned'), [`components/Home.js:20 → ${UNKNOWN}`]);
        assert.match((await p.textContent('#center .story-path .link.l-conditioned .skipped'))!, /판정에서 뺀 링크/);
        assert.deepEqual(await skipped('l-open'), []);
        assert.equal(await p.locator('#center .story-path .link.l-open .skipped').count(), 0);
        assert.match((await p.textContent('#right-info > p.skipped'))!, /주소 못 읽은 링크 빼고 판정/);
        assert.deepEqual(await p.locator('#right .reach-link .unknown-links li').allTextContents(), [`components/Home.js:20 → ${UNKNOWN}`]);

        await p.click('#story-list li:has-text("실험실에서 결과로")');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['이어짐']);
        assert.equal(await p.locator('#center .skipped').count(), 0);
        assert.equal(await p.locator('#right .skipped').count(), 0);
      }),
    );
  });
});

test('in a browser, the right of a story gives a verdict line for missing links and one for a screen off the map, counting the missing links', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    fs.mkdirSync(config.storiesDir, { recursive: true });
    fs.writeFileSync(path.join(config.storiesDir, 'back-and-forth.json'), JSON.stringify({
      name: '도움말을 오간다', screens: ['/home#Home', '/help#Help', '/home#Home', '/help#Help', '/settings#Settings'], author: 'a', date: '2026-10-03',
    }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("도움말을 오간다")');
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 불가 · 링크 없음 3곳', '판정 못 함 · 화면 없음']);
        assert.deepEqual(await p.locator('#right .verdict').evaluateAll((els) => els.map((e) => e.className)), ['verdict unreachable', 'verdict unjudged']);
        assert.equal(await p.textContent('#right-info > p.muted:not(.skipped)'), '판정한 구간에 조건 없음');
      }),
    );
  });
});

test('in a browser, the dead screen filter keeps the screens that call an API missing on the server', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const names = () => p.locator('#screen-list li .name > span:first-child').allTextContents();
        await p.check('#left input[name=dead]');
        assert.deepEqual(await names(), ['/home', '/document/:tab(draft|done)']);
        assert.deepEqual(await p.locator('#screen-list li .chip.dead').allTextContents(), ['죽은 화면', '죽은 화면']);
        await p.fill('#left input[type=search]', 'home');
        assert.deepEqual(await names(), ['/home']);
        await p.fill('#left input[type=search]', '');
        await p.check('#left input[name=no-tests]');
        assert.deepEqual(await names(), []);
        await p.uncheck('#left input[name=dead]');
        assert.ok((await names()).length > 0);
        await p.uncheck('#left input[name=no-tests]');
        assert.equal((await names()).length, 11);
      }),
    ),
  );
});

const LONG_PATH = '/organization-settings/notification-preferences/default-recipients/:groupId(active|archived)';
const LONG_PATH_COMPONENT = 'RecipientSettings';

async function withLongListRows(fn: (p: Page, row: (id: string) => Locator) => Promise<void>) {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        assert.equal((await postMark(base, { target: { node: '/home#Home' }, status: 'fine', author: 'reviewer' })).status, 201);
        await p.route('**/api/data', async (route) => {
          const data: PageData = await (await route.fetch()).json();
          for (const id of ['/home#Home', '/help#Help']) {
            const screen = data.map.screens.find((s) => s.id === id)!;
            Object.assign(screen, { path: LONG_PATH, component: LONG_PATH_COMPONENT, dead: id === '/home#Home' });
          }
          const importer = { title: 't', file: 'a.test.js', line: 1, source: 'a.js', format: 'vitest', depth: 'code', status: 'pass', testFile: 'a.test.js', via: ['a.js'] };
          data.tests.importers['/home#Home'] = [importer, importer];
          await route.fulfill({ json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await fn(p, (id) => p.locator('#screen-list li', { hasText: LONG_PATH_COMPONENT }).nth(id === 'home' ? 0 : 1));
      }),
    ),
  );
}

const renderedLines = (locator: Locator) =>
  locator.evaluate((el) => {
    const lines = [];
    let top;
    for (const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); walker.nextNode(); ) {
      const node = walker.currentNode as Text;
      for (let i = 0; i < node.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getClientRects()[0];
        if (!rect || /\s/.test(node.data[i])) continue;
        if (rect.top !== top) lines.push('');
        top = rect.top;
        lines[lines.length - 1] += node.data[i];
      }
    }
    return lines;
  });

test('in a browser, a long route in the screen list wraps only before a slash', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    const lines = await renderedLines(row('help').locator('.name > span:first-child'));
    assert.ok(lines.length >= 3, `the path is long enough to wrap: ${lines}`);
    assert.equal(lines.join(''), LONG_PATH);
    assert.deepEqual(lines.filter((line) => !line.startsWith('/')), []);
  });
});

test('in a browser, the component name in the screen list stays on one line', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    for (const id of ['home', 'help']) assert.deepEqual(await renderedLines(row(id).locator('.name .muted')), [LONG_PATH_COMPONENT]);
  });
});

test('in a browser, the badges of a screen list row sit below the route and leave it the full row width', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    const geometry = (r: Locator) =>
      r.evaluate((li) => {
        const box = (el: Element) => el.getBoundingClientRect();
        const style = getComputedStyle(li);
        return {
          content: box(li).width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          name: box(li.querySelector('.name')!),
          badgesTop: Math.min(...[...li.querySelectorAll('.chip, .count')].map((el) => box(el).top)),
        };
      });
    const crowded = await geometry(row('home'));
    const bare = await geometry(row('help'));
    assert.deepEqual(await row('home').locator('.chip, .count').allTextContents(), ['죽은 화면', '충분', '테스트 8', '불러옴 2']);
    assert.equal(crowded.name.width, bare.name.width);
    assert.ok(Math.abs(crowded.name.width - crowded.content) < 1, `${crowded.name.width} of ${crowded.content}`);
    assert.ok(crowded.badgesTop >= crowded.name.bottom && bare.badgesTop >= bare.name.bottom);

    const line = await row('home').evaluate((li) => {
      const boxes = [...li.querySelectorAll('.badges > *')].map((el) => el.getBoundingClientRect());
      return {
        tops: boxes.map((b) => b.top),
        widths: boxes.map((b) => b.width),
        gaps: boxes.slice(1).map((b, i) => b.left - boxes[i].right),
        content: li.querySelector('.name')!.getBoundingClientRect().width,
      };
    });
    assert.ok(line.widths.reduce((sum, w) => sum + w, 0) + 8 * (line.widths.length - 1) <= line.content, `the badges fit in one row width: ${line.widths} of ${line.content}`);
    assert.ok(Math.max(...line.tops) - Math.min(...line.tops) < 4, `the badges share one line: ${line.tops}`);
    assert.ok(line.gaps.every((gap) => Math.abs(gap - 8) < 0.5), `adjacent badges are 8px apart: ${line.gaps}`);
  });
});

test('in a browser, a route that spans several segments in the screen list is found by in-page text search', { skip: browserMissing }, async () => {
  await withLongListRows(async (p) => {
    for (const text of ['/organization-settings/notification-preferences', '/default-recipients/:groupId(active|archived)']) {
      const found = await p.evaluate((t) => {
        getSelection()!.removeAllRanges();
        return { hit: (window as unknown as { find: (text: string) => boolean }).find(t), inList: document.getElementById('screen-list')!.contains(getSelection()!.anchorNode) };
      }, text);
      assert.deepEqual(found, { hit: true, inList: true }, text);
    }
  });
});

test('in a browser, a screen list row gives its full route and component as a tooltip and never scrolls the list sideways', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    assert.equal(await row('help').getAttribute('title'), `${LONG_PATH} ${LONG_PATH_COMPONENT}`);
    const list = await p.locator('#screen-list').evaluate((ul) => {
      ul.querySelector('.seg')!.append('x'.repeat(120));
      const section = ul.closest('section')!;
      return { scrollWidth: section.scrollWidth, clientWidth: section.clientWidth };
    });
    assert.equal(list.scrollWidth, list.clientWidth);
  });
});

test('in a browser, an over-wide route segment in the screen list is clipped at the row content edge, not drawn into the row padding', { skip: browserMissing }, async () => {
  await withLongListRows(async (p, row) => {
    const li = row('help');
    const strip = await li.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(el).paddingRight);
      return { x: box.right - pad, y: box.top, width: pad, height: box.height };
    });
    const before = await p.screenshot({ clip: strip });
    await li.locator('.seg').first().evaluate((el) => el.append('x'.repeat(120)));
    const after = await p.screenshot({ clip: strip });
    assert.ok(before.equals(after), 'the right padding of the row stays empty');
    assert.equal(await li.evaluate((el) => getComputedStyle(el).overflowX), 'visible');
  });
});

const openScreenInfo = async (p: Page) => {
  const info = p.locator('#center .screen-info');
  await info.waitFor({ state: 'attached' });
  if (!(await info.evaluate((e: HTMLDetailsElement) => e.open))) await info.locator(':scope > summary').click();
};
const openLinkGroups = (access: Locator) => access.locator('details.link-group').evaluateAll((groups: HTMLDetailsElement[]) => groups.forEach((g) => { g.open = true; }));

test('in a browser, a screen that opens only under a role or a setting shows its tests for each case under what it needs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const cases = p.locator('#center .screen-info > .cases li');
        const counts = async () => (await cases.locator('.step-tests').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
        await p.click('#screen-list li:has-text("/admin/member")');
        await openScreenInfo(p);
        assert.equal(await p.textContent('#center .screen-info > .cases h2'), '경우별 테스트');
        assert.deepEqual(await cases.locator('.case').allTextContents(), ['역할 ADMIN — 열림', '여는 역할이 아닌 역할 — 막힘']);
        assert.deepEqual(await counts(), ['UI/E2E ✓1', 'UI/E2E ✓1']);
        await p.click('#screen-list li:has-text("/help")');
        assert.deepEqual(await cases.locator('.case').allTextContents(), ['설정 SYSTEM.HELP_LINK_ENABLED 맞춤 — 열림', '설정 SYSTEM.HELP_LINK_ENABLED 맞추지 않음 — 막힘']);
        assert.deepEqual(await counts(), ['UI/E2E ✕1', '테스트 없음']);
        await p.click('#screen-list li:has-text("/signin")');
        assert.equal(await p.locator('#center .screen-info > .cases').count(), 0);
      }),
    ),
  );
});

test('in a browser, with case kinds in the config every screen and every call shows a button per kind, and pressing one makes it a case with its tests until pressed again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const section = p.locator('#center .screen-info > .cases');
        const kindButton = (text: string) => section.locator('.case-kinds button', { hasText: text });
        const counts = async (rows: Locator) => (await rows.locator('.step-tests').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
        const picks = () => loadMarks(config.marksDir).filter((m) => m.target?.case !== undefined).sort((a, b) => a.date.localeCompare(b.date)).map((m) => [m.target!.node, m.target!.case, m.status]);

        await p.click('#screen-list li:has-text("/signin")');
        await openScreenInfo(p);
        assert.equal(await section.locator('h2').textContent(), '경우별 테스트');
        assert.equal(await section.locator('li').count(), 0);
        assert.deepEqual(await section.locator('.case-kinds button').allTextContents(), [CASE_KINDS.boundary, CASE_KINDS.legacy]);
        assert.deepEqual(await section.locator('.case-kinds button').evaluateAll((els) => els.map((e) => [e.getAttribute('title'), e.getAttribute('aria-pressed')])), [['@case:boundary', 'false'], ['@case:legacy', 'false']]);

        await kindButton(CASE_KINDS.boundary).click();
        await p.waitForSelector('#center .screen-info > .cases li');
        assert.deepEqual(await section.locator('li .case').allTextContents(), [CASE_KINDS.boundary]);
        assert.equal(await section.locator('li').getAttribute('title'), '@case:boundary');
        assert.deepEqual(await counts(section.locator('li')), ['UI/E2E ✓1']);
        assert.equal(await kindButton(CASE_KINDS.boundary).getAttribute('aria-pressed'), 'true');
        await kindButton(CASE_KINDS.legacy).click();
        await p.waitForSelector('#center .screen-info > .cases li:nth-child(2)');
        assert.deepEqual(await counts(section.locator('li')), ['UI/E2E ✓1', '테스트 없음']);

        await kindButton(CASE_KINDS.boundary).click();
        await p.waitForFunction(() => document.querySelectorAll('#center .screen-info > .cases li').length === 1);
        assert.deepEqual(await section.locator('li .case').allTextContents(), [CASE_KINDS.legacy]);

        await p.click('#screen-list li:has-text("/admin/member")');
        await kindButton(CASE_KINDS.legacy).click();
        await p.waitForFunction(() => document.querySelectorAll('#center .screen-info > .cases li').length === 3);
        assert.deepEqual(await section.locator('li .case').allTextContents(), ['역할 ADMIN — 열림', '여는 역할이 아닌 역할 — 막힘', CASE_KINDS.legacy]);

        await p.click('#screen-list li:has-text("/home")');
        await p.locator('table.calls td.cell').first().click();
        const callSection = p.locator('#center .call-info > .cases');
        assert.deepEqual(await callSection.locator('li').count(), 0);
        await callSection.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).click();
        await p.waitForSelector('#center .call-info > .cases li');
        assert.deepEqual(await callSection.locator('li .case').allTextContents(), [CASE_KINDS.boundary]);
        assert.deepEqual(await counts(callSection.locator('li')), ['테스트 없음']);
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /^호출 전체$/);

        assert.deepEqual(picks(), [
          ['/signin#SignIn', 'boundary', 'needed'],
          ['/signin#SignIn', 'legacy', 'needed'],
          ['/signin#SignIn', 'boundary', 'not-needed'],
          ['/admin/member#AdminMember', 'legacy', 'needed'],
          ['GET:/api/v1/document/list', 'boundary', 'needed'],
        ]);
      }),
    ), [BOUNDARY_ON_SIGNIN]);
});

test('in a browser, the setting and role filters keep the screens that open only under one, and the chosen screen shows why', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const names = () => p.locator('#screen-list li .name > span:first-child').allTextContents();
        await p.check('#left input[name=setting]');
        assert.deepEqual(await names(), ['/help', '/lab', '/lab/result', '/admin/report']);
        await p.uncheck('#left input[name=setting]');
        await p.check('#left input[name=role]');
        assert.deepEqual(await names(), ['/admin/member', '/admin/group', '/admin/audit', '/admin/report']);

        const access = p.locator('#center .access');
        await p.click('#screen-list li:has-text("/admin/report")');
        await openScreenInfo(p);
        assert.deepEqual((await p.locator('#center .open-needs .need').allTextContents()).map((t) => t.split(' ')[0]), ['역할', '설정']);
        await openLinkGroups(access);
        const fromHome = await access.locator('li:has-text("/home#Home")').innerText();
        assert.match(fromHome, /components\/SideMenu\.js:11/);
        assert.match(fromHome, /\['ADMIN', 'OWNER'\]\.indexOf\(session\['member\.role'\]\) > -1\s*역할/);
        assert.match(fromHome, /MENUS\.ADMIN\s*설정/);

        await p.uncheck('#left input[name=role]');
        await p.click('#screen-list li:has-text("/admin/member")');
        assert.match(await p.locator('#center .open-needs .route').innerText(), /isAdminRole\(memberRole\)\s*역할/);
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.equal(await access.locator('details.link-group > summary').innerText(), '조건 없음 링크 1');
        await openLinkGroups(access);
        assert.match(await access.locator('li:has-text("/lab#Lab")').innerText(), /링크를 건 화면에 필요한 것\s*설정/);
        assert.deepEqual(await access.locator('li:has-text("/lab#Lab") .from-kinds .chip').allTextContents(), ['설정']);
        await p.click('#screen-list li:has-text("/admin/audit")');
        await openLinkGroups(access);
        assert.deepEqual(await access.locator('li:has-text("/admin/member#AdminMember") .from-kinds .chip').allTextContents(), ['역할']);
        await p.click('#screen-list li:has-text("/help")');
        await openLinkGroups(access);
        assert.match(await access.locator('li:has-text("/signin#SignIn")').innerText(), /globalSettings\.SYSTEM\.HELP_LINK_ENABLED \(openHelp 로 물려받음\)\s*설정/);
        await p.click('#screen-list li:has-text("/signin")');
        assert.equal(await p.locator('#center .open-needs p').innerText(), '설정이나 역할 없이 열립니다.');

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        const bare = async (id: string) => (await tipLines(await screenBox(p, id))).filter((t) => / 필요$/.test(t));
        assert.deepEqual(await bare('/admin/report#AdminReport'), []);
        const labResult = await screenBox(p, '/lab/result#LabResult');
        assert.deepEqual(await bare('/lab/result#LabResult'), []);
        assert.deepEqual(await needTag(labResult), ['설정']);
        assert.deepEqual((await tipLines(labResult)).filter((t) => t.startsWith('필요한')), ['필요한 설정: SYSTEM.LAB_ENABLED 켬']);
        assert.deepEqual(await bare('/signin#SignIn'), []);
      }),
    ),
  );
});

test('in a browser, a screen whose links ask for different kinds has its own filter and says so in its access panel, on links from it and in its flow box', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    rewrite(copy, 'client/src/components/Home.js', "      {session['member.role']", "      {memberRole === 'ADMIN' && <Link to={Option.ROUTE_PATH.HELP}>Help</Link>}\n      {session['member.role']");
    fs.writeFileSync(path.join(copy, 'client/src/components/Help.js'), "import { Link } from 'react-router-dom';\nimport Option from '_define/Option';\n\nexport default function Help() {\n  return <article><Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link></article>;\n}\n");
    rebuild(copy);
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.check('#left input[name=mixed]');
        assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/help', '/lab/result']);
        await p.uncheck('#left input[name=mixed]');
        const access = p.locator('#center .access');
        await p.click('#screen-list li:has-text("/help")');
        await openScreenInfo(p);
        assert.deepEqual(await p.locator('#center .open-needs .need').allTextContents(), ['링크마다 다름']);
        await p.click('#screen-list li:has-text("/lab/result")');
        await openLinkGroups(access);
        assert.deepEqual(await access.locator('li:has-text("/help#Help") .from-kinds .chip').allTextContents(), ['링크마다 다름']);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        const help = await screenBox(p, '/help#Help');
        assert.deepEqual(await needTag(help), ['링크마다 다름']);
        assert.equal((await tipLines(help)).at(-1), '링크마다 다름');
      }),
    );
  });
});

test('in a browser, the screen info in the middle pane starts with what opens the chosen screen under 「접근 조건」, the name carries 「역할」 and 「설정」 as the flow box does, and it is the same when the screen is picked in the flow', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await openScreenInfo(p);
        const summaryOf = async (label: string) => {
          await p.click(`#screen-list li:has-text("${label}")`);
          assert.equal(await p.locator('#center .screen-info > summary + *').evaluate((e) => e.className), 'open-needs');
          assert.equal(await p.textContent('#center .open-needs h2'), '접근 조건');
          return [await p.locator('#center .open-needs .need').allTextContents(), await p.locator('#center-head .need-kinds .chip').allTextContents()];
        };
        const report = await summaryOf('/admin/report');
        const group = await summaryOf('/admin/group');
        await p.click('#screen-list li:has-text("/signin")');
        assert.equal(await p.locator('#center .open-needs p').innerText(), '설정이나 역할 없이 열립니다.');
        assert.equal(await p.locator('#center-head .need-kinds .chip').count(), 0);
        assert.equal(await p.locator('#right .open-needs').count(), 0);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.deepEqual(report, [['역할 ADMIN 외 1', '설정 "ADMIN_REPORT" (ADMIN.LIST 에) 외 1'], ['역할', '설정']]);
        assert.deepEqual(group[1], ['역할']);
        for (const [id, words] of [['/admin/report#AdminReport', report], ['/admin/group#AdminGroup', group]] as const) {
          const box = await screenBox(p, id);
          assert.deepEqual([(await needTag(box)).join('·')], [words[1].join('·')]);
          await box.click();
          assert.equal(await p.locator('#center .screen-info').getAttribute('open'), '');
          assert.deepEqual([await p.locator('#center .open-needs .need').allTextContents(), await p.locator('#center-head .need-kinds .chip').allTextContents()], words);
          assert.equal(await p.locator('#right .open-needs').count(), 0);
        }
      }),
    ),
  );
});

test('in a browser, the right pane of a screen holds only the conversation above the form, and the screen info folded under the tables of the middle pane names its counts and reads in order once opened', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.deepEqual(await p.locator('#right-info h2').allTextContents(), ['에이전트와 대화']);
        for (const gone of ['.open-needs', '.access', '.cases', '.target-id', '.history-toggle']) assert.equal(await p.locator(`#right ${gone}`).count(), 0, gone);
        assert.equal(await p.locator('#right > :last-child').evaluate((e) => e.id), 'right-dock');
        assert.equal(await p.locator('#right-dock > .mark-form').count(), 1);
        assert.equal(await p.textContent('#right .mark-form .tags .tag-label'), '화면 전체');

        const info = p.locator('#center .screen-info');
        assert.equal(await p.locator('#center-body > :last-child').evaluate((e) => e.className), 'screen-info');
        assert.ok(await p.locator('#center-body table.calls ~ .screen-info').count());
        assert.equal(await info.evaluate((e: HTMLDetailsElement) => e.open), false);
        const s = (await (await fetch(`${base}/api/data`)).json() as PageData).map.screens.find((x) => x.id === '/document/:id#DocumentDetail')!;
        assert.equal(await info.locator(':scope > summary').innerText(), `화면 정보 들어오는 링크 ${s.access.links.length} · 나가는 링크 ${s.links!.length} · 읽는 설정값 ${s.settingReads!.length}`);
        await info.locator(':scope > summary').click();
        const headings = await info.locator('h2').allTextContents();
        assert.deepEqual(headings.map((t) => t.replace(/ \d+$/, '')), ['접근 조건', '들어오는 링크', '소스 위치', '나가는 링크', '읽는 설정값']);

        await p.locator('table.calls td.cell').first().click();
        assert.deepEqual(await p.locator('#right-info h2').allTextContents(), ['에이전트와 대화']);
        assert.equal(await p.locator('#right-dock > .mark-form').count(), 1);
        assert.equal(await p.locator('#right h2:has-text("서버 대조")').count(), 0);
      }),
    ),
  );
});

test('in a browser, the screen info lists the cases after the access conditions and the in-screen conditions between the incoming links and the source location', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    await open();
    await openScreenInfo(p);
    const headings = (await p.locator('#center .screen-info h2').allTextContents()).map((t) => t.replace(/ \d+$/, '').replace(/^(화면 안 조건) — .*$/, '$1'));
    assert.deepEqual(headings, ['접근 조건', '경우별 테스트', '들어오는 링크', '화면 안 조건', '소스 위치', '나가는 링크', '읽는 설정값']);
  });
});

test('in a browser, the opened screen info stays open on other screens, on a redraw and when a screen is picked in the flow', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const isOpen = () => p.locator('#center .screen-info').evaluate((e: HTMLDetailsElement) => e.open);
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#center .screen-info > summary');
        assert.equal(await isOpen(), true);
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await isOpen(), true);
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.waitForSelector('#screen-list li.selected .chip.missing');
        assert.equal(await isOpen(), true);
        await p.click('#view-flow');
        await (await screenBox(p, '/lab#Lab')).click();
        assert.equal(await isOpen(), true);
        await p.click('#center .screen-info > summary');
        await (await screenBox(p, '/help#Help')).click();
        assert.equal(await isOpen(), false);
      }),
    ),
  );
});

const callInfoInView = (p: Page) => p.evaluate(() => {
  const pane = document.getElementById('center')!.getBoundingClientRect();
  const summary = document.querySelector('#center .call-info > summary')?.getBoundingClientRect();
  return !!summary && summary.top >= pane.top - 0.5 && summary.bottom <= pane.bottom + 0.5;
});
const waitCallInfoInView = async (p: Page) => {
  await p.waitForFunction(() => {
    const pane = document.getElementById('center')!.getBoundingClientRect();
    const summary = document.querySelector('#center .call-info > summary')?.getBoundingClientRect();
    return !!summary && summary.top >= pane.top - 0.5 && summary.bottom <= pane.bottom + 0.5;
  });
  await p.locator('#center').evaluate((e) => new Promise((resolve) => {
    let last = -1;
    let same = 0;
    const tick = () => {
      if (e.scrollTop === last) same++;
      else [last, same] = [e.scrollTop, 0];
      if (same >= 5) resolve(null);
      else requestAnimationFrame(tick);
    };
    tick();
  }));
};
const callInfoContentTop = (p: Page) => p.locator('#center').evaluate((pane) => {
  const summary = pane.querySelector('.call-info > summary')!;
  return { top: summary.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop, height: pane.clientHeight };
});

test('in a browser, choosing a call near the top of a long call table scrolls only the middle pane until its details are in view', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 500 });
        await p.click('#screen-list li:has-text("/admin/report")');
        const firstCell = p.locator('table.calls tbody tr:not(.option)').first().locator('td.cell').first();
        await firstCell.scrollIntoViewIfNeeded();
        const before = await p.locator('#center').evaluate((e) => e.scrollTop);
        await firstCell.click();
        await waitCallInfoInView(p);
        assert.ok((await p.locator('#center').evaluate((e) => e.scrollTop)) > before + 100, 'the call info started below the visible part of the pane');
        assert.equal(await p.evaluate(() => document.scrollingElement!.scrollTop), 0);

        await p.locator('#center').evaluate((e) => { e.scrollTop = 0; });
        await p.emulateMedia({ reducedMotion: 'reduce' });
        await p.locator('table.calls tbody tr:not(.option)').nth(1).locator('td.cell').first().click();
        assert.ok(await callInfoInView(p), 'with reduced motion the pane jumps at once');
      }),
    ),
  );
});

test('in a browser, choosing another cell of a call whose info is closed keeps the fold closed and does not scroll the middle pane', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 500 });
        await p.emulateMedia({ reducedMotion: 'reduce' });
        await p.click('#screen-list li:has-text("/admin/report")');
        const cells = p.locator('table.calls tbody tr:not(.option)').first().locator('td.cell');
        await cells.first().click();
        await closeCallInfo(p);
        const depthCell = cells.nth(1);
        await depthCell.evaluate((e) => e.scrollIntoView({ block: 'start' }));
        assert.equal(await callInfoInView(p), false, 'the closed call info is below the visible part of the pane');
        const kept = await p.locator('#center').evaluate((e) => e.scrollTop);
        await depthCell.click();
        assert.match((await depthCell.getAttribute('class'))!, /\bselected\b/);
        assert.match(await p.locator('#center .call-info .target-id strong').innerText(), / 깊이$/);
        assert.equal(await p.locator('#center .call-info').evaluate((e: HTMLDetailsElement) => e.open), false);
        assert.equal(await p.locator('#center').evaluate((e) => e.scrollTop), kept, 'a closed call info is not scrolled to');
      }),
    ),
  );
});

test('in a browser, choosing a call shows its details open under the call table of the middle pane, naming the call and the option and depth they are for, and a closed one opens again on another call', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await p.locator('#center .call-info').count(), 0);
        await p.locator('table.calls tr.option', { hasText: 'withAttachments 켬' }).first().locator('td.cell').nth(1).click();
        const details = p.locator('#center .call-info');
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), true);
        assert.ok(await p.locator('#center-body table.calls + .call-info + .screen-info').count());
        const head = details.locator(':scope > summary .target-id');
        assert.equal(await head.locator('.mono').textContent(), 'POST:/api/v1/report/export');
        assert.match(await head.innerText(), /withAttachments 켬 · UI\/E2E 깊이/);
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /^withAttachments 켬 · UI\/E2E 깊이$/);
        assert.deepEqual((await details.locator('h2').allTextContents()).map((t) => t.replace(/ \d+$/, '')), ['옵션을 찾은 자리', '서버 대조', '테스트', '이 화면에서 부르는 곳', '이 호출을 쓰는 화면']);
        assert.deepEqual(await p.locator('#right-info h2').allTextContents(), ['에이전트와 대화']);

        await p.locator('table.calls td.cell').first().click();
        assert.match(await details.locator(':scope > summary').innerText(), /POST:\/api\/v1\/report\/export\s+호출 전체/);
        await details.locator(':scope > summary').click();
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), false);
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), false);
        await p.locator('table.calls tbody tr:not(.option)').nth(1).locator('td.cell').first().click();
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), true);

        await p.click('#screen-list li:has-text("/home")');
        assert.equal(await p.locator('#center .call-info').count(), 0);
        assert.equal(await p.locator('#right .target-id').count(), 0);
      }),
    ),
  );
});

// 오른쪽 칸에는 대화만 있으므로, 스크롤할 만큼 긴 대화를 화면과 그 호출마다 미리 남긴다.
const openDocumentScreenInShortViewport = async (p: Page, base: string) => {
  await p.setViewportSize({ width: 1440, height: 400 });
  await p.waitForSelector('#screen-list li');
  for (const label of ['/admin/report', '/document/:id']) {
    await p.click(`#screen-list li:has-text("${label}")`);
    const nodes = [(await p.textContent('#center-head .title-row + .mono'))!, ...await p.locator('table.calls tbody tr:not(.option) td.call > .mono').allTextContents()];
    for (const node of nodes) {
      for (let i = 0; i < 3; i++) assert.equal((await postMark(base, { target: { node }, note: `${node} ${i} ${'a long remark '.repeat(40)}`, author: 'reviewer' })).status, 201);
    }
  }
  await p.reload();
  await toList(p);
  await p.waitForSelector('#screen-list li');
  await p.click('#screen-list li:has-text("/document/:id")');
};
const openHistory = async (p: Page) => {
  const toggle = p.locator('#right .history-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
};
const scrollRightToBottom = (p: Page) => p.locator('#right-info').evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
const scrollRightTo = (p: Page, top: number) => p.locator('#right-info').evaluate((el, y) => { el.scrollTop = y; return el.scrollTop; }, top);
const rightScroll = (p: Page) => p.locator('#right-info').evaluate((el) => el.scrollTop);

test('in a browser, choosing another screen or call target opens the right pane at its top, and redrawing the same target keeps the scroll offset', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p, base);
        const firstCall = p.locator('table.calls tbody tr:not(.option)').nth(0).locator('td.cell');
        const secondCall = p.locator('table.calls tbody tr:not(.option)').nth(1).locator('td.cell');

        assert.ok((await scrollRightToBottom(p)) > 0);
        await firstCall.first().click();
        assert.equal(await rightScroll(p), 0);

        assert.ok((await scrollRightToBottom(p)) > 0);
        await secondCall.first().click();
        assert.equal(await rightScroll(p), 0);

        const kept = await scrollRightToBottom(p);
        assert.ok(kept > 0);
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await rightScroll(p), kept);
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.missing');
        assert.equal(await rightScroll(p), kept);

        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await rightScroll(p), 0);
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.ok((await scrollRightToBottom(p)) > 0);
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await rightScroll(p), 0);
      }),
    ),
  );
});

test('in a browser, choosing another depth or option row of the same node keeps the right pane scroll offset, and choosing a call row resets it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p, base);
        const kept = await scrollRightTo(p, 100);
        assert.equal(kept, 100);
        await p.click('#center tr:has-text("API")');
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /API 깊이/);
        assert.equal(await rightScroll(p), kept);
        await p.click('#center tr:has-text("UI/E2E")');
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /UI\/E2E 깊이/);
        assert.equal(await rightScroll(p), kept);

        await p.locator('table.calls tbody tr:not(.option)').nth(0).locator('td.cell').first().click();
        const call = await scrollRightTo(p, 100);
        assert.equal(call, 100);
        await p.locator('table.calls tbody tr:not(.option)').nth(0).locator('td.cell').nth(2).click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, / 깊이$/);
        assert.equal(await rightScroll(p), call);
        await p.locator('table.calls tbody tr:not(.option)').nth(1).locator('td.cell').first().click();
        assert.equal(await rightScroll(p), 0);

        await p.click('#screen-list li:has-text("/admin/report")');
        await p.locator('table.calls td.cell').first().click();
        const exported = await scrollRightTo(p, 100);
        assert.equal(exported, 100);
        await p.locator('table.calls tr.option', { hasText: 'withAttachments 켬' }).first().locator('td.cell').first().click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /withAttachments 켬/);
        assert.equal(await rightScroll(p), exported);
      }),
    ),
  );
});

test('in a browser, selecting another story opens the right pane at its top', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.setViewportSize({ width: 1440, height: 360 });
        await p.click('#left .views.side button:has-text("스토리")');
        const stories = p.locator('#story-list li');
        await stories.nth(0).click();
        assert.ok((await scrollRightToBottom(p)) > 0);
        await stories.nth(1).click();
        assert.equal(await rightScroll(p), 0);
        const kept = await scrollRightToBottom(p);
        assert.ok(kept > 0);
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await rightScroll(p), kept);
      }),
    ),
  );
});

const insideRightPane = (p: Page, selector: string) => p.evaluate((sel) => {
  const pane = document.getElementById('right')!.getBoundingClientRect();
  const box = document.querySelector(sel)!.getBoundingClientRect();
  return box.height > 0 && box.top >= pane.top - 0.5 && box.bottom <= pane.bottom + 0.5;
}, selector);
const topOf = (p: Page, selector: string) => p.locator(selector).evaluate((e) => e.getBoundingClientRect().top);

async function assertDockStaysPut(p: Page) {
  const info = p.locator('#right-info');
  assert.ok(await info.evaluate((e) => e.scrollHeight > e.clientHeight), 'the conversation part is taller than its box');
  for (const selector of ['#right .statuses', '#right button.save']) {
    assert.ok(await insideRightPane(p, selector), `${selector} is visible without scrolling`);
  }
  const before = [await topOf(p, '#right .statuses'), await topOf(p, '#right button.save')];
  assert.ok((await scrollRightToBottom(p)) > 0);
  assert.deepEqual([await topOf(p, '#right .statuses'), await topOf(p, '#right button.save')], before);
  for (const selector of ['#right .statuses', '#right button.save']) assert.ok(await insideRightPane(p, selector));
}

test('in a browser, the status buttons and the save button stay in view at the bottom of the right pane while its conversation scrolls, for a screen and for a call', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p, base);
        await assertDockStaysPut(p);

        await p.locator('table.calls td.cell').first().click();
        assert.equal(await p.locator('#center .call-info .target-id').count(), 1);
        await assertDockStaysPut(p);
      }),
    ),
  );
});

test('in a browser, the status buttons and the save button stay in view at the bottom of the right pane for a story', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.setViewportSize({ width: 1440, height: 360 });
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.textContent('#right .mark-form .tags .tag-label'), '스토리');
        await assertDockStaysPut(p);
        assert.equal(await p.locator('#right-info .mark-form').count(), 0);
      }),
    ),
  );
});

test('in a browser, the conversation of a screen is open from the start with no fold, fills the pane above the form, and a long answer scrolls inside it without being cut', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const node = '/document/:id#DocumentDetail';
    const first = addMark(config.marksDir, { target: { node }, note: 'first look', author: 'reviewer' }, new Date('2026-10-03T01:00:00Z'));
    addMark(config.marksDir, { target: { node }, status: 'fine', note: 'second look', author: 'reviewer' }, new Date('2026-10-03T02:00:00Z'));
    const answer = `the long answer ${'with many words '.repeat(120)}ends here`;
    addReply(config.marksDir, { replyTo: first.id, note: answer }, new Date('2026-10-03T01:30:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.equal(await p.locator('#right .history-toggle').count(), 0);
        const list = p.locator('#right-info .history');
        assert.equal(await list.isVisible(), true);
        assert.deepEqual(await p.locator('#right-info .history > li').allTextContents().then((ts) => ts.map((t) => /second look/.test(t) ? 'second' : /first look/.test(t) ? 'first' : t)), ['first', 'second']);
        assert.equal(await list.evaluate((e) => getComputedStyle(e).maxHeight), 'none');
        const reply = p.locator('#right-info .history .replies li', { hasText: 'ends here' });
        assert.equal(await reply.evaluate((e) => getComputedStyle(e).maxHeight), 'none');
        assert.ok((await reply.evaluate((e) => e.scrollHeight - e.clientHeight)) <= 0, 'the answer is shown whole');

        const g = await p.evaluate(() => {
          const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
          const info = document.getElementById('right-info')!;
          return { pane: rect('right'), info: rect('right-info'), dock: rect('right-dock'), scrolls: info.scrollHeight > info.clientHeight };
        });
        assert.ok(Math.abs(g.info.top - g.pane.top) < 1, 'the conversation starts at the top of the pane');
        assert.ok(Math.abs(g.info.bottom - g.dock.top) < 1, 'the form sits right under it');
        assert.ok(Math.abs(g.dock.bottom - g.pane.bottom) < 1, 'the form sits at the bottom of the pane');
        assert.ok(g.scrolls, 'the long conversation scrolls inside its part');
        await p.locator('#right-info').evaluate((e) => { e.scrollTop = e.scrollHeight; });
        assert.ok(await p.evaluate(() => Math.abs(document.querySelector('#right-info .talk-scope')!.getBoundingClientRect().top - document.getElementById('right-info')!.getBoundingClientRect().top) < 1), 'the conversation buttons stay at the top while it scrolls');
        assert.ok(await insideRightPane(p, '#right button.save'));

        await p.click('#right .statuses button:has-text("더 필요")');
        await p.click('#center tr:has-text("API")');
        assert.equal(await list.isVisible(), true);
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await p.locator('#right-info .history').count(), 0);
        assert.equal(await p.locator('#right-info h2').textContent(), '에이전트와 대화');
        assert.equal(await p.locator('#right-info p.muted').textContent(), '아직 대화가 없습니다.');
      }),
    );
  });
});

test('in a browser, the dock keeps the conversation part at least 120px tall on a short window and does not make the right pane itself scroll while both fit', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const node = '/document/:id#DocumentDetail';
        for (let i = 0; i < 6; i++) {
          assert.equal((await postMark(base, { target: { node }, status: 'fine', note: `look ${i} ${'long '.repeat(20)}`, author: 'reviewer' })).status, 201);
        }
        await p.setViewportSize({ width: 1440, height: 500 });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        const geometry = () => p.evaluate(() => {
          const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
          const right = document.getElementById('right')!;
          return { info: rect('right-info').height, dock: rect('right-dock').height, pane: rect('right'), dockBottom: rect('right-dock').bottom, overflow: right.scrollHeight - right.clientHeight };
        });
        const g = await geometry();
        assert.ok(g.dock <= g.pane.height * 0.65, `the dock takes ${g.dock}px of ${g.pane.height}px`);
        assert.ok(g.info >= 120, `conversation part ${g.info}px`);
        assert.ok(g.dockBottom <= g.pane.bottom + 0.5, 'the dock is fully inside the pane');
        assert.ok(g.overflow <= 0, `the pane itself overflows by ${g.overflow}px`);
        assert.ok(await insideRightPane(p, '#right button.save'));
        assert.ok(await p.locator('#right-info').evaluate((e) => e.scrollHeight > e.clientHeight), 'the conversation part scrolls');
        assert.ok((await p.locator('#right-dock textarea').evaluate((e) => getComputedStyle(e).maxHeight)) !== 'none');
      }),
    ),
  );
});

test('in a browser, on a window too short for the conversation part and the dock the right pane itself scrolls, so the save button can be reached and pressed', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 320 });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#right .statuses button:has-text("없음")');
        assert.equal(await insideRightPane(p, '#right button.save'), false);
        const heading = (await p.locator('#right-dock .mark-form .tags').boundingBox())!;
        await p.mouse.move(heading.x + 10, heading.y + heading.height / 2);
        await p.mouse.wheel(0, 400);
        for (let i = 0; i < 20 && !(await insideRightPane(p, '#right button.save')); i++) await p.waitForTimeout(50);
        assert.ok(await insideRightPane(p, '#right button.save'), 'the save button is brought inside the pane by scrolling it');
        await p.click('#right button.save');
        await p.waitForSelector('#screen-list li.selected .chip.missing');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]), [[{ node: '/document/:id#DocumentDetail' }, 'missing']]);
        assert.ok((await p.locator('#right').evaluate((e) => e.scrollTop)) > 0);
        await p.click('#screen-list li:has-text("/admin/report")');
        assert.equal(await p.locator('#right').evaluate((e) => e.scrollTop), 0);
      }),
    ),
  );
});

test('in a browser, a save that finishes after the reviewer moved to another screen, or left and came back, keeps the status and memo picked since, and a form left untouched shows the saved mark', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        let onPost: (release: () => void) => void;
        await p.route('**/api/marks', async (route) => {
          await new Promise<void>((release) => onPost(release));
          await route.continue();
        });
        const holdNextPost = () => new Promise<() => void>((resolve) => { onPost = resolve; });
        const pick = async (status: string, note: string) => {
          await p.click(`#right .statuses button:has-text("${status}")`);
          await p.fill('#right-dock textarea', note);
        };
        const assertForm = async (status: string, note: string) => {
          assert.equal(await p.inputValue('#right-dock textarea'), note);
          assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), [status]);
        };

        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#right .statuses button:has-text("없음")');
        let posting = holdNextPost();
        await p.click('#right button.save');
        let release = await posting;
        await p.click('#screen-list li:has-text("/admin/report")');
        await pick('더 필요', 'keep me');
        const documentChip = '#screen-list li:has-text("/document/:id") .chip.missing';
        assert.equal(await p.locator(documentChip).count(), 0);
        release();
        await p.waitForSelector(documentChip);
        await assertForm('더 필요', 'keep me');

        posting = holdNextPost();
        await p.click('#right button.save');
        release = await posting;
        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#screen-list li:has-text("/admin/report")');
        await pick('충분', 'second thoughts');
        const reportChip = '#screen-list li:has-text("/admin/report") .chip.needs-more';
        assert.equal(await p.locator(reportChip).count(), 0);
        release();
        await p.waitForSelector(reportChip);
        await assertForm('충분', 'second thoughts');

        await p.click('#screen-list li:has-text("/lab/result")');
        await p.click('#right .statuses button:has-text("충분")');
        posting = holdNextPost();
        await p.click('#right button.save');
        release = await posting;
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.click('#screen-list li:has-text("/lab/result")');
        release();
        await p.waitForSelector('#screen-list li:has-text("/lab/result") .chip.fine');
        await assertForm('충분', '');

        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status!, m.note] as const).sort((a, b) => a[1].localeCompare(b[1])), ([
          [{ node: '/document/:id#DocumentDetail' }, 'missing', ''],
          [{ node: '/admin/report#AdminReport' }, 'needs-more', 'keep me'],
          [{ node: '/lab/result#LabResult' }, 'fine', ''],
        ] satisfies [object, string, string][]).sort((a, b) => a[1].localeCompare(b[1])));
      }),
    ),
  );
});

test('in a browser, a save whose reload fails after the reviewer moved to another story names the story it was for, and one that stays says so plainly', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        let onPost: (release: () => void) => void;
        await p.route('**/api/marks', async (route) => {
          await new Promise<void>((release) => onPost(release));
          await route.continue();
        });
        const holdNextPost = () => new Promise<() => void>((resolve) => { onPost = resolve; });
        await p.click('#left .views.side button:has-text("스토리")');
        const first = p.locator('#story-list li:has-text("실험실을 열어")');
        const name = await first.locator('.name > span').textContent();
        await first.click();
        await p.click('#right .statuses button:has-text("없음")');
        let posting = holdNextPost();
        await p.click('#right button.save');
        let release = await posting;
        await p.click('#story-list li:has-text("보고서")');
        await p.route('**/api/data', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' }));
        release();
        await p.waitForSelector('#right-dock .error');
        assert.ok((await p.textContent('#right-dock .error'))!.startsWith(`「스토리 ${name}」 코멘트는 저장했지만 다시 읽지 못했습니다: `));

        await p.click('#right .statuses button:has-text("없음")');
        posting = holdNextPost();
        await p.click('#right button.save');
        release = await posting;
        release();
        await p.waitForFunction(() => document.querySelector('#right-dock .error')?.textContent.startsWith('저장했지만 다시 읽지 못했습니다: '));
      }),
    ),
  );
});

test('in a browser, picking a status updates the form in place, keeping the memo box and the height it was dragged to', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        assert.equal(await p.locator('#right button.save').isEnabled(), false);
        const memo = (await p.$('#right-dock textarea'))!;
        const dragged = await memo.evaluate((e) => { e.style.height = '150px'; return e.getBoundingClientRect().height; });
        await p.click('#right .statuses button:has-text("더 필요")');
        assert.ok(await memo.evaluate((e) => e === document.querySelector('#right-dock textarea')), 'the memo box is the same element');
        assert.equal(await memo.evaluate((e) => e.getBoundingClientRect().height), dragged);
        assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), ['더 필요']);
        assert.equal(await p.locator('#right button.save').isEnabled(), true);
        await p.click('#right .statuses button:has-text("충분")');
        assert.deepEqual(await p.locator('#right .statuses button.on').allTextContents(), ['충분']);
      }),
    ),
  );
});

test('in a browser, a save that is refused shows its message in the dock above the save button, both inside the visible part of the pane', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentScreenInShortViewport(p, base);
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.resolve(new Response('mark is refused', { status: 400 })) : real(url, init));
        });
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await p.waitForSelector('#right-dock .error');
        assert.equal(await p.locator('#right-dock .error').count(), 1);
        assert.equal(await p.locator('#right .error ~ .save-row button.save').count(), 1);
        const inside = async () => (await insideRightPane(p, '#right .mark-form .error')) && insideRightPane(p, '#right .mark-form button.save');
        assert.match((await p.textContent('#right .error'))!, /저장하지 못했습니다: mark is refused/);
        assert.ok(await inside());

        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        await p.click('#right button.save');
        await p.waitForFunction(() => /저장하지 못했습니다: disk full/.test(document.querySelector('#right .error')?.textContent ?? ''));
        assert.ok(await inside());
      }),
    ),
  );
});

test('in a browser, a save whose reload fails after the review ended raises no page error', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        let reload: () => void;
        const reloading = new Promise<void>((resolve) => { reload = resolve; });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        await p.route('**/api/data', async (route) => {
          reload();
          await gate;
          await route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' });
        });
        await p.click('#right .statuses button:has-text("없음")');
        await p.click('#right button.save');
        await reloading;
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        release();
        await p.waitForTimeout(200);
      }),
    ),
  );
});

const LONG_WORD = `a${'.verylongsegment'.repeat(14)}`;

test('in a browser, long addresses and conditions wrap inside the screen info, the call info and the right pane, none of which scrolls sideways', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        assert.equal((await postMark(base, { target: { node: '/document/:id#DocumentDetail' }, status: 'fine', note: LONG_WORD, author: 'reviewer' })).status, 201);
        const longId = `GET:/api/v1/${LONG_WORD}`;
        const labels = Array.from({ length: 5 }, (_, i) => `${LONG_WORD}-${i}`);
        await p.route('**/api/data', async (route) => {
          const text = (await (await route.fetch()).text()).replaceAll('GET:/api/v1/document/{documentId}', longId);
          const data: PageData = JSON.parse(text);
          const screen = data.map.screens.find((s) => s.id === '/document/:id#DocumentDetail')!;
          const file = `components/${LONG_WORD}.js`;
          screen.componentFile = file;
          screen.routeGuards = [LONG_WORD];
          screen.access.links = [
            { from: `/${LONG_WORD}#X`, file, line: 3, guards: [], fromKinds: [] },
            { from: `/${LONG_WORD}#Y`, file, line: 4, guards: [{ guard: LONG_WORD, kinds: [] }], fromKinds: [] },
          ];
          screen.links = [{ route: 'X', line: 2, to: `/${LONG_WORD}`, file, guards: [LONG_WORD], inheritedGuards: [{ via: LONG_WORD, line: 1, guards: [LONG_WORD] }] }];
          screen.settingReads = [{ key: LONG_WORD, line: 3, guards: [], file }];
          for (const c of screen.apiCalls) Object.assign(c, { fn: LONG_WORD, file });
          for (const c of data.map.calls) if (c.id === longId) c.server = { status: 'match', labels, path: `/api/v1/${LONG_WORD}` };
          await route.fulfill({ json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        const widths = () => p.locator('#right-info, #right-dock, #right, #center .screen-info, #center .call-info').evaluateAll((els) => els.map((el) => ({ id: el.id || el.className, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })));
        const block = (heading: string) => p.locator('#center h2', { hasText: heading }).locator('xpath=following-sibling::*[1]');
        const mentions = async (heading: string, selector: string) => assert.ok((await block(heading).locator(selector, { hasText: LONG_WORD }).count()) > 0, `${heading} shows the long text in ${selector}`);

        await p.click('#screen-list li:has-text("/document/:id")');
        await openScreenInfo(p);
        await p.locator('#center details.link-group').evaluateAll((gs: HTMLDetailsElement[]) => gs.forEach((g) => { g.open = true; }));
        await p.locator('#center details.long-guard').evaluateAll((gs: HTMLDetailsElement[]) => gs.forEach((g) => { g.open = true; }));
        await mentions('들어오는 링크', 'code.from');
        assert.ok((await p.locator('#center .access details.link-group code.full', { hasText: LONG_WORD }).count()) > 0, 'a long guard in an incoming link group');
        await mentions('화면 안 조건', 'code.full');
        await mentions('소스 위치', 'code');
        await mentions('나가는 링크', 'code');
        await mentions('나가는 링크', 'code.guard');
        await mentions('읽는 설정값', 'code');
        assert.ok((await p.locator('#right-info .history li', { hasText: LONG_WORD }).count()) > 0, 'a long mark note in the conversation');
        const screen = await widths();
        assert.equal(screen.length, 4);
        for (const w of screen) assert.ok(w.scrollWidth <= w.clientWidth, `screen ${w.id}: ${w.scrollWidth} of ${w.clientWidth}`);

        await p.locator('table.calls td.cell').first().click();
        assert.match((await p.textContent('#center .call-info .target-id'))!, new RegExp(LONG_WORD.replaceAll('.', '\\.')));
        await mentions('서버 대조', 'code');
        assert.equal(await block('서버 대조').locator('.chip').innerText(), `서버에 있음 (${labels.join(', ')})`);
        await mentions('이 화면에서 부르는 곳', 'code');
        const call = await widths();
        assert.equal(call.length, 5);
        for (const w of call) assert.ok(w.scrollWidth <= w.clientWidth, `call ${w.id}: ${w.scrollWidth} of ${w.clientWidth}`);
      }),
    ),
  );
});

const LAB_SETTING = { guard: 'globalSettings.SYSTEM.LAB_ENABLED', kinds: ['setting'], settings: [{ root: 'globalSettings', path: ['SYSTEM', 'LAB_ENABLED'], need: 'on', default: false }] };
const ADMIN_ROLE = { guard: "memberRole === 'ADMIN'", kinds: ['role'], roles: ['ADMIN'] };
const LONG_GUARD = `globalSettings.SYSTEM.MAIN_MENU.LAB.LIST includes 'LAB_EXPERIMENTS_${'WITH_A_VERY_LONG_MENU_KEY_'.repeat(4)}END'`;
const LONG_SETTING = { guard: LONG_GUARD, kinds: ['setting'], settings: [{ root: 'globalSettings', path: ['SYSTEM', 'MAIN_MENU', 'LAB', 'LIST'], need: 'includes', value: 'LAB_EXPERIMENTS' }] };
const IN_SCREEN_GUARD = "location.pathname.startsWith('/lab/experiments/legacy')";
const labLink = (from: string, file: string, line: number, guards: Guard[]) => ({ from, file, line, guards, fromKinds: [] });

async function withLabLinks(fn: (p: Page, open: () => Promise<Locator>, reverse: () => void) => Promise<void>, { only }: { only?: ReturnType<typeof labLink>[] } = {}) {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let reversed = false;
        await p.route('**/api/data', async (route) => {
          const data: PageData = await (await route.fetch()).json();
          const lab = data.map.screens.find((s) => s.id === '/lab#Lab')!;
          lab.routeGuards = [LAB_SETTING.guard, IN_SCREEN_GUARD];
          const links = [
            labLink('/home#Home', 'components/Home.js', 19, [LAB_SETTING]),
            labLink('/admin/member#AdminMember', 'components/AdminMember.js', 30, [ADMIN_ROLE, LAB_SETTING]),
            labLink('/help#Help', 'components/Help.js', 5, []),
            labLink('/document/:id#DocumentDetail', 'components/DocumentDetail.js', 40, [LAB_SETTING, ADMIN_ROLE]),
            labLink('/admin/group#AdminGroup', 'components/AdminGroup.js', 9, [LAB_SETTING, ADMIN_ROLE]),
            labLink('/signin#SignIn', 'components/SignIn.js', 3, []),
            labLink('/admin/audit#AdminAudit', 'components/AdminAudit.js', 7, [LONG_SETTING]),
          ];
          if (only) links.splice(0, links.length, ...only);
          lab.access.links = reversed ? links.reverse().map((l) => ({ ...l, guards: [...l.guards].reverse() })) : links;
          await route.fulfill({ json: data });
        });
        const open = async () => {
          await p.reload();
          await toList(p);
          await p.waitForSelector('#screen-list li');
          await p.click('#screen-list li:has-text("/lab")');
          await openScreenInfo(p);
          return p.locator('#center .access details.link-group');
        };
        await fn(p, open, () => { reversed = true; });
      }),
    ),
  );
}

const groupSummaries = (groups: Locator) => groups.locator(':scope > summary').allInnerTexts();

test('in a browser, the incoming links with the same conditions form one group with their number, and opening it shows where each link is and its conditions as written', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    const groups = await open();
    assert.equal(await p.textContent('#center .access h2'), '들어오는 링크 7');
    assert.deepEqual(await groupSummaries(groups), [
      '조건 없음 링크 2',
      '역할 ADMIN · 설정 SYSTEM.LAB_ENABLED 켬 링크 3',
      '설정 SYSTEM.LAB_ENABLED 켬 링크 1',
      '설정 "LAB_EXPERIMENTS" (LAB.LIST 에) 링크 1',
    ]);
    const both = groups.nth(1);
    assert.equal(await both.locator('li').first().isVisible(), false);
    await both.locator(':scope > summary').click();
    const links = await both.locator('li').allInnerTexts();
    assert.equal(links.length, 3);
    assert.match(links[0], /\/admin\/group#AdminGroup\s+components\/AdminGroup\.js:9/);
    for (const text of links) {
      assert.match(text, /globalSettings\.SYSTEM\.LAB_ENABLED\s*설정/);
      assert.match(text, /memberRole === 'ADMIN'\s*역할/);
    }
    await groups.nth(0).locator(':scope > summary').click();
    assert.match(await groups.nth(0).locator('li').first().innerText(), /\/help#Help\s+components\/Help\.js:5/);
  });
});

test('in a browser, a route condition that is neither a setting nor a role is listed apart as not blocking the screen and is left out of the summary', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    await open();
    assert.deepEqual(await p.locator('#center .open-needs .need').allTextContents(), ['설정 SYSTEM.LAB_ENABLED 켬']);
    assert.doesNotMatch(await p.locator('#center .open-needs').innerText(), /location\.pathname/);
    const inScreen = p.locator('#center .in-screen');
    assert.match(await inScreen.locator('h2').innerText(), /^화면 안 조건.*막지 않/);
    assert.deepEqual(await inScreen.locator('code').allTextContents(), [IN_SCREEN_GUARD]);
  });
});

test('in a browser, the groups of incoming links and the links in each come in the same order however the map lists them', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open, reverse) => {
    const order = async (groups: Locator) => {
      const out = [];
      for (let i = 0; i < await groups.count(); i++) {
        await groups.nth(i).locator(':scope > summary').click();
        out.push([(await groupSummaries(groups))[i], await groups.nth(i).locator('li code.from').allTextContents()]);
      }
      return out;
    };
    const first = await order(await open());
    reverse();
    const second = await order(await open());
    assert.deepEqual(second, first);
    assert.deepEqual(first[1][1], ['/admin/group#AdminGroup', '/admin/member#AdminMember', '/document/:id#DocumentDetail']);
  });
});

test('in a browser, a long condition is folded and reads in full once opened', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    const groups = await open();
    const long = groups.nth(3);
    await long.locator(':scope > summary').click();
    const full = long.locator('.long-guard code.full');
    assert.equal(await full.isVisible(), false);
    await long.locator('.long-guard > summary').click();
    assert.equal(await full.isVisible(), true);
    assert.equal(await full.innerText(), LONG_GUARD);
    const box = (await full.boundingBox())!;
    const pane = (await p.locator('#center .screen-info').boundingBox())!;
    assert.ok(box.x + box.width <= pane.x + pane.width, 'the full condition wraps inside the pane');
  });
});

test('in a browser, links whose conditions read the same but resolve to different roles form separate groups, each summarised by its own roles', { skip: browserMissing }, async () => {
  const canManage = (roles: string[]) => ({ guard: 'canManage', kinds: ['role'], roles });
  await withLabLinks(async (p, open) => {
    const groups = await open();
    assert.deepEqual(await groupSummaries(groups), ['역할 ADMIN 외 1 링크 1', '역할 ADMIN 링크 1']);
    for (const g of await groups.all()) assert.equal(await g.locator('li').count(), 1);
  }, { only: [
    labLink('/home#Home', 'components/Home.js', 19, [canManage(['ADMIN', 'OWNER'])]),
    labLink('/help#Help', 'components/Help.js', 5, [canManage(['ADMIN'])]),
  ] });
});

test('in a browser, opened link groups and opened long conditions stay open when the screen info is redrawn, and close again on another screen', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    const groups = await open();
    await groups.nth(0).locator(':scope > summary').click();
    await groups.nth(3).locator(':scope > summary').click();
    await groups.nth(3).locator('.long-guard > summary').click();
    const openState = () => p.locator('#center .access').evaluate((a) => ({
      groups: [...a.querySelectorAll<HTMLDetailsElement>('details.link-group')].map((g) => g.open),
      long: [...a.querySelectorAll<HTMLDetailsElement>('details.long-guard')].map((g) => g.open),
    }));
    const expected = { groups: [true, false, false, true], long: [true] };
    assert.deepEqual(await openState(), expected);
    await p.click('#right .statuses button:has-text("더 필요")');
    assert.deepEqual(await openState(), expected);
    await p.fill('#right-dock textarea', 'redraw');
    await p.click('#right button.save');
    await p.waitForSelector('#center tr.selected td.mark:has-text("더 필요")');
    assert.deepEqual(await openState(), expected);
    await p.click('#screen-list li:has-text("/home")');
    await p.click('#screen-list li:has-text("/lab")');
    assert.deepEqual(await openState(), { groups: [false, false, false, false], long: [false] });
  });
});

test('in a browser, the headings of the incoming links and of the in-screen conditions keep the top margin of the other screen info headings', { skip: browserMissing }, async () => {
  await withLabLinks(async (p, open) => {
    await open();
    const marginOf = (text: string) => p.locator('#center .screen-info h2', { hasText: text }).first().evaluate((e) => getComputedStyle(e).marginTop);
    const source = await marginOf('소스 위치');
    assert.notEqual(source, '0px');
    assert.equal(await marginOf('들어오는 링크'), source);
    assert.equal(await marginOf('화면 안 조건'), source);
  });
});

test('in a browser, the chosen screen shows its calls with the server match and tests by depth, and a mark on a call depth reaches the task list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:tab")');
        assert.deepEqual(await p.locator('table.calls td.call .chip').allTextContents(), ['판정 불가', '서버에 없음']);
        assert.equal(await p.locator('table.calls tr:has-text("판정 불가") td.cell').count(), 0);

        await p.click('#screen-list li:has-text("/document/:id")');
        assert.deepEqual(await p.locator('table.calls td.call .chip').allTextContents(), ['서버에 있음 (core)', '메서드 불일치']);
        const rename = p.locator('table.calls tr', { hasText: 'PUT:/api/v1/document/{documentId}/name' });
        await rename.locator('td.cell').first().click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /호출 전체/);
        assert.equal(await p.locator('#center .call-info .test').count(), 1);
        assert.match((await p.textContent('#center .call-info .test'))!, /rename is refused by the server/);

        await rename.locator('td.cell').nth(2).click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /API 깊이/);
        assert.equal(await p.locator('#center .call-info .test').count(), 0);
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', 'no API test for the rename');
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.missing');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status, m.author]), [
          [{ node: 'PUT:/api/v1/document/{documentId}/name', depth: 'api' }, 'missing', 'reviewer'],
        ]);
        assert.match(taskList(config), /^## PUT:\/api\/v1\/document\/\{documentId\}\/name\n\n- marks:\n {2}- missing, api depth — "no API test for the rename" \(reviewer, \d{4}-\d\d-\d\d\)$/m);
      }),
    ),
  );
});

test('in a browser, each call shows on and off rows for its options and a no-option row, with empty option rows standing out', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/admin/report")');
        const label = (row: Locator) => row.locator('td.call > div:first-child').innerText();
        const rows = p.locator('table.calls tbody tr');
        const labels = [];
        for (let i = 0; i < (await rows.count()); i++) labels.push(await label(rows.nth(i)));
        assert.deepEqual(labels, [
          'POST:/api/v1/report/export',
          'withAttachments 켬', 'withAttachments 끔', 'withHistory 켬', 'withHistory 끔', '옵션 지정 없음',
          'POST:/api/v1/report/archive',
          'signedOnly 켬', 'signedOnly 끔', 'withHistory 켬', 'withHistory 끔', '옵션 지정 없음',
          'POST:/api/v1/report/schedule',
          'weekly 켬', 'weekly 끔', '옵션 지정 없음',
        ]);
        const gaps = [];
        for (const row of await p.locator('table.calls tr.option.gap').all()) gaps.push(await label(row));
        assert.deepEqual(gaps, ['withAttachments 끔', 'signedOnly 끔', 'withHistory 끔', 'weekly 켬', 'weekly 끔']);
        assert.equal(await p.locator('table.calls tr.option.gap td.cell').first().innerText(), '테스트 없음');
        assert.deepEqual(await p.locator('table.calls tr.option:has-text("weekly") .chip').allTextContents(), ['설정', '설정']);

        const exportRows = (text: string) => p.locator('table.calls tr.option').filter({ hasText: text }).first();
        assert.deepEqual(await exportRows('withHistory 켬').locator('td.cell').allInnerTexts(), ['✓2', '✓2', '—', '—', '—', '—', '—']);
        const none = exportRows('옵션 지정 없음');
        assert.equal(await none.locator('td.cell').count(), 0);
        assert.deepEqual(await none.locator('td.count').allInnerTexts(), ['✓2', '✓2', '—', '—', '—', '—', '—']);

        await exportRows('withHistory 켬').locator('td.cell').nth(1).click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /withHistory 켬 · UI\/E2E 깊이/);
        assert.equal(await p.locator('#center .call-info .test').count(), 2);
        assert.match(await p.locator('#center .call-info .option-sites').innerText(), /components\/ExportDialog\.js:18/);

        await exportRows('withHistory 켬').locator('td.cell').nth(6).click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /withHistory 켬 · 산출물 깊이/);
        assert.equal(await p.locator('#center .call-info .test').count(), 0);
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', 'Open the exported file.');
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.missing');

        await exportRows('withAttachments 끔').locator('td.cell').first().click();
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /withAttachments 끔$/);
        await p.click('#right .statuses button:has-text("더 필요")');
        await p.click('#right button.save');
        await p.waitForSelector('table.calls td.cell.selected .chip.needs-more');

        await p.locator('table.calls tr.option').filter({ hasText: 'weekly 켬' }).locator('td.cell').first().click();
        assert.match(await p.locator('#center .call-info .option-sites').innerText(), /설정에 적음/);

        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status!] as const).sort((a, b) => a[1].localeCompare(b[1])), [
          [{ node: 'POST:/api/v1/report/export', option: { key: 'withHistory', value: true }, depth: 'output' }, 'missing'],
          [{ node: 'POST:/api/v1/report/export', option: { key: 'withAttachments', value: false } }, 'needs-more'],
        ]);
        const tasks = taskList(config);
        assert.match(tasks, /^ {2}- missing, withHistory=true at output depth — "Open the exported file\." \(reviewer, \d{4}-\d\d-\d\d\)$/m);
        assert.match(tasks, /^ {4}- withAttachments=false: no tests$/m);

        assert.equal((await postMark(base, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withComments', value: true } }, status: 'missing' })).status, 201);
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.match(await p.locator('#left ul.plain').innerText(), /POST:\/api\/v1\/report\/export withComments=true/);
      }),
    ),
  );
});

const RESULT_CALL = 'GET:/api/v1/document/{documentId}';
const RESULT_LINKS = [
  { from: 'POST:/api/v1/report/export', to: RESULT_CALL, note: '내보낸 파일을 연다' },
  { from: 'POST:/api/v1/archive/document', to: RESULT_CALL, note: '보관본을 연다' },
  { from: 'POST:/api/v1/report/weekly', to: RESULT_CALL, note: '주간 보고서를 연다' },
];
const OUTPUT_EXPORT_TESTS: [string, string, string][] = [
  ['results/playwright/export.json', '@call:POST:/api/v1/report/export @option:withHistory=true"', '@call:POST:/api/v1/report/export @option:withHistory=true @depth:output"'],
  ['results/playwright/export.json', '@option:withAttachments=true @option:withHistory=false"', '@option:withAttachments=true @option:withHistory=false @depth:output"'],
];

test('the page data carries the call links of the map and the links with a call missing from it', async () => {
  await withRebuiltFixture({ callLinks: RESULT_LINKS }, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const { map } = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(map.callLinks, [RESULT_LINKS[1], RESULT_LINKS[0]]);
      assert.deepEqual(map.unknownCallLinks, [{ ...RESULT_LINKS[2], missing: ['POST:/api/v1/report/weekly'] }]);
    }),
  );
});

test('in a browser, a call whose result another call\'s options change shows those options under it with the other call\'s output-depth tests per value, a link to that call, and a missing call as off the map, and its rows take no mark', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ callLinks: RESULT_LINKS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/admin/report")');
        const exportRow = (text: string) => p.locator('table.calls tr.option').filter({ hasText: text }).first();
        const VALUES = ['withAttachments 켬', 'withAttachments 끔', 'withHistory 켬', 'withHistory 끔'];
        const fromOutputCells = [];
        for (const v of VALUES) fromOutputCells.push(await exportRow(v).locator('td.cell').nth(6).innerText());
        assert.deepEqual(fromOutputCells, ['✕1', '—', '✓1', '✕1']);

        await p.click('#screen-list li:has-text("/document/:id")');
        const rows = p.locator('table.calls tbody tr');
        const label = (row: Locator) => row.locator('td.call > div:first-child').innerText();
        const labels = [];
        for (let i = 0; i < (await rows.count()); i++) labels.push(await label(rows.nth(i)));
        assert.deepEqual(labels, [
          RESULT_CALL,
          '이 결과를 바꾸는 옵션 POST:/api/v1/archive/document', '옵션 없음',
          '이 결과를 바꾸는 옵션 POST:/api/v1/report/export', ...VALUES,
          '이 결과를 바꾸는 옵션 POST:/api/v1/report/weekly맵에 없는 호출',
          'PUT:/api/v1/document/{documentId}/name',
        ]);
        const heads = p.locator('table.calls tr.result-head');
        assert.deepEqual(await heads.locator('td.call > div.muted').allInnerTexts(), ['보관본을 연다', '내보낸 파일을 연다', '주간 보고서를 연다']);

        const valueRows = p.locator('table.calls tr.option:not(.result-head)');
        assert.equal(await valueRows.locator('td.cell').count(), 0);
        const outputCounts = [];
        for (const v of VALUES) {
          const row = valueRows.filter({ hasText: v });
          assert.deepEqual((await row.locator('td').allInnerTexts()).slice(1, -1), ['', '', '', '', '', '']);
          outputCounts.push(await row.locator('td.count').innerText());
        }
        assert.deepEqual(outputCounts, ['✕1', '테스트 없음', '✓1', '✕1']);
        assert.deepEqual(await p.locator('table.calls tr.option.gap td.call > div').allInnerTexts(), ['withAttachments 끔']);
        const gapLook = await p.locator('table.calls tr.option.gap td.count .none').evaluate((el) => {
          const own = getComputedStyle(el);
          const label = getComputedStyle(el.closest('tr')!.querySelector('td.call > div')!);
          return [own.color === label.color, own.fontWeight, label.fontWeight];
        });
        assert.deepEqual(gapLook, [true, '600', '600']);

        const detached = heads.nth(2);
        assert.equal(await detached.locator('a').count(), 0);
        assert.equal(await detached.locator('.chip.l-off-map').innerText(), '맵에 없는 호출');

        const before = await p.textContent('#right .mark-form .tags .tag-label');
        await valueRows.filter({ hasText: 'withAttachments 끔' }).locator('td.count').click();
        await valueRows.filter({ hasText: 'withHistory 켬' }).locator('td.call').click();
        assert.equal(await p.textContent('#right .mark-form .tags .tag-label'), before);
        assert.equal(await p.locator('table.calls .selected').count(), 0);

        await heads.nth(1).locator('a').click();
        await p.waitForSelector('#center .call-info .target-id');
        assert.equal(await p.textContent('#center .call-info .target-id .mono'), 'POST:/api/v1/report/export');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/admin\/audit/);
      }),
    ),
  OUTPUT_EXPORT_TESTS);
});

test('in a browser, a map written before call links shows the call table without result option rows', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ callLinks: RESULT_LINKS }, (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const { callLinks, unknownCallLinks, ...old } = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    assert.equal(callLinks.length + unknownCallLinks.length, 3);
    fs.writeFileSync(mapFile, JSON.stringify(old));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.waitForSelector('table.calls');
        assert.equal(await p.locator('table.calls tr.result-head').count(), 0);
        assert.equal(await p.locator('table.calls tbody tr').count(), 2);
      }),
    );
  });
});

test('in a browser, reloading a map with no screens while a call is chosen leaves the page empty instead of failing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls td.cell').first().click();
        assert.equal((await postMark(base, { target: { node: 'GET:/api/v1/member/list' }, status: 'fine' })).status, 201);
        const mapFile = path.join(config.outDir, 'map.json');
        fs.writeFileSync(mapFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(mapFile, 'utf8')), screens: [], entries: [] }));
        await p.evaluate(() => load().then(render));
        assert.equal(await p.textContent('#center'), '화면이 없습니다.');
        assert.equal(await p.textContent('#right'), '');
        assert.equal(await p.evaluate(() => hasUnsavedMark()), false);
      }),
    ),
  );
});

test('in a browser, the output depth row comes after the other depths and takes a mark', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.deepEqual(await p.locator('#center td.depth').allTextContents(), ['화면 전체', 'UI/E2E', 'API', '렌더링만', '코드', '데이터', '산출물']);
        await p.click('#center tr:has-text("산출물")');
        assert.match((await p.textContent('#right .mark-form .tags .tag-label'))!, /산출물 깊이/);
        await p.click('#right .statuses button:has-text("더 필요")');
        await p.click('#right button.save');
        await p.waitForSelector('#center tr.selected td.mark:has-text("더 필요")');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]), [[{ node: '/lab/result#LabResult', depth: 'output' }, 'needs-more']]);
      }),
    ),
  );
});

const screenBox = async (p: Page, id: string) => {
  const i = await p.$$eval('#flow .box.screen', (els: HTMLElement[], id) => els.findIndex((e) => e.title.split('\n')[0] === id), id);
  assert.ok(i >= 0, `box ${id} is drawn`);
  return p.locator('#flow .box.screen').nth(i);
};
const boxCount = async (p: Page) => p.locator('#flow .box.screen').count();
const flowButton = (p: Page, label: string) => p.locator(':is(.flowbar, .flow-head) button', { hasText: label });
const filterButton = (p: Page, key: string) => p.locator(`.flowbar .flow-filters button[data-filter="${key}"]`);
const pickedBoxes = (p: Page) => p.$$eval('#flow .box.screen.picked', (els: HTMLElement[]) => els.map((e) => e.dataset.key));
const boxesWith = (p: Page, cls: string) => p.$$eval(`#flow .box.screen.${cls}`, (els: HTMLElement[]) => els.map((e) => e.dataset.key!).sort());
const lineStates = (p: Page) => p.$$eval('#flow .canvas svg path[data-from]', (els) => Object.fromEntries(els.map((e) => [
  `${(e as SVGElement).dataset.from} ${(e as SVGElement).dataset.to}`, ['on', 'dim'].filter((c) => e.classList.contains(c)).join(' '),
])));
const textOutside = (p: Page) => p.$$eval('#flow .box', (els: HTMLElement[]) => els.flatMap((box) => {
  const r = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  const side = (s: 'Left' | 'Right' | 'Top' | 'Bottom') => parseFloat(cs[`border${s}Width`]) + parseFloat(cs[`padding${s}`]);
  const inner = { left: r.left + side('Left'), right: r.right - side('Right'), top: r.top + side('Top'), bottom: r.bottom - side('Bottom') };
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if ((walker.currentNode.parentElement as HTMLElement).closest('.sr-only')) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const t of range.getClientRects()) {
      if (t.width && (t.left < inner.left - 0.5 || t.right > inner.right + 0.5 || t.top < inner.top - 0.5 || t.bottom > inner.bottom + 0.5)) return [box.title.split('\n')[0]];
    }
  }
  return [];
}));
const layoutErrors = (p: Page) => p.$$eval('#flow .canvas', (canvases) => canvases.flatMap((canvas) => {
  const origin = canvas.getBoundingClientRect();
  const els = new Map([...canvas.querySelectorAll<HTMLElement>(':scope > .box')].map((e) => [e.dataset.key, e]));
  const box = (key: string) => {
    const r = els.get(key)!.getBoundingClientRect();
    const top = r.top - origin.top;
    const left = r.left - origin.left;
    return { key, left, right: left + r.width, top, bottom: top + r.height, middle: top + r.height / 2 };
  };
  const edges = [...canvas.querySelectorAll<SVGPathElement>('svg path')].map((path) => ({
    from: box(path.dataset.from!), to: box(path.dataset.to!), start: path.getPointAtLength(0), end: path.getPointAtLength(path.getTotalLength()),
  }));
  const off = (a: number, b: number) => Math.abs(a - b) > 1;
  const errors = [];
  for (const [key, e] of els) {
    const r = e.getBoundingClientRect();
    if (off(r.left - origin.left, parseFloat(e.style.left))) errors.push(`${key} stands at x ${r.left - origin.left}, the layout put it at ${e.style.left}`);
    if (off(r.width, parseFloat(e.style.width))) errors.push(`${key} is ${r.width}px wide, the layout made it ${e.style.width}`);
  }
  for (const { from, to, start, end } of edges) {
    if (off(end.y, to.middle)) errors.push(`the line to ${to.key} ends at ${end.y}, the box's middle is at ${to.middle}`);
    if (off(end.x, to.left)) errors.push(`the line to ${to.key} ends at x ${end.x}, the box's left edge is at ${to.left}`);
    if (off(start.y, from.middle)) errors.push(`the line from ${from.key} starts at ${start.y}, not at ${from.middle}`);
    if (off(start.x, from.right)) errors.push(`the line from ${from.key} starts at x ${start.x}, not at ${from.right}`);
  }
  const parents = new Set(edges.map((e) => e.from.key));
  for (const parent of parents) {
    const kids = edges.filter((e) => e.from.key === parent).map((e) => e.to).sort((a, b) => a.top - b.top);
    const pairs = kids.slice(1).map((b, i) => [kids[i], b]).filter(([a, b]) => !parents.has(a.key) && !parents.has(b.key));
    for (const [a, b] of pairs) if (off(b.top - a.bottom, GAP)) errors.push(`${b.key} stands ${b.top - a.bottom}px below ${a.key}`);
  }
  return errors;
}));

const PICK_HINT = '누르면 이 화면에 이어진 길만 진하게 남기고 이 화면을 엽니다';
const titleLines = async (box: Locator) => (await box.getAttribute('title'))!.split('\n');
const statusLine = async (box: Locator) => (await titleLines(box))[1];
const tipLines = async (box: Locator) => (await titleLines(box)).slice(2).filter((line) => line !== PICK_HINT);
const needTag = (box: Locator) => box.locator('.tag.need').allTextContents();
const SCREEN_ORDER = [
  '/signin#SignIn', '/home#Home', '/document/:tab_draft_done_#DocumentList', '/document/:id#DocumentDetail', '/admin/member#AdminMember',
  '/admin/group#AdminGroup', '/lab#Lab', '/lab/result#LabResult', '/admin/audit#AdminAudit', '/admin/report#AdminReport', '/help#Help',
];
const LAB_PATHS = ['/home#Home /lab#Lab', '/lab#Lab /lab/result#LabResult', '/signin#SignIn /home#Home'];

test('in a browser, pressing a screen in the flow keeps strong only the paths through it, dims the rest, and opens the screen in the list\'s own middle and right panes beside the drawing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const shown = () => p.evaluate(() => ['flow-bar', 'flow', 'left', 'center', 'right', 'gaps'].filter((id) => !document.getElementById(id)!.hidden));
        assert.deepEqual(await shown(), ['flow-bar', 'flow', 'gaps']);
        assert.deepEqual(await boxesWith(p, 'dim'), []);

        await (await screenBox(p, '/lab#Lab')).click();
        await p.waitForSelector('#flow .box.picked');
        assert.deepEqual(await shown(), ['flow-bar', 'flow', 'center', 'right']);
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab']);
        assert.equal(await (await screenBox(p, '/lab#Lab')).getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await boxesWith(p, 'dim'), SCREEN_ORDER.filter((id) => !['/signin#SignIn', '/home#Home', '/lab#Lab', '/lab/result#LabResult'].includes(id)).sort());
        const lines = await lineStates(p);
        assert.deepEqual(Object.keys(lines).filter((k) => lines[k] === 'on').sort(), LAB_PATHS);
        assert.ok(Object.entries(lines).every(([k, v]) => LAB_PATHS.includes(k) || v === 'dim'), JSON.stringify(lines));
        assert.equal(await p.textContent('#center h3'), '/lab');
        assert.equal(await p.textContent('#center .open-needs h2'), '접근 조건');
        assert.equal(await p.locator('#right-dock .mark-form').count(), 1);
        assert.equal(await p.textContent('.flowbar .picking'), '고른 화면 /lab 선택 해제');
        assert.equal(await p.evaluate(() => decodeURIComponent(location.hash)), '#flow?screen=/lab#Lab');
        const columns = await p.evaluate(() => ['flow', 'center', 'right'].map((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().width)));
        assert.equal(columns[2], 360, 'the right pane keeps the width it has in the list');
        assert.ok(Math.abs(columns[0] - columns[1]) <= 1, `the drawing and the middle pane share the rest: ${columns}`);

        await p.click('#view-list');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/lab/);
        await p.click('#screen-list li:has-text("/help")');
        await p.click('#view-flow');
        assert.deepEqual(await pickedBoxes(p), ['/help#Help'], 'the screen chosen in the list is the one picked in the flow');

        await (await screenBox(p, '/document/:id#DocumentDetail')).click();
        assert.deepEqual(await boxesWith(p, 'jump'), ['/admin/report#AdminReport', '/help#Help'], 'the screens its links reach in other branches are marked, not dimmed');
        assert.deepEqual(await boxesWith(p, 'dim'), ['/admin/audit#AdminAudit', '/admin/group#AdminGroup', '/admin/member#AdminMember', '/document/:tab_draft_done_#DocumentList', '/lab#Lab', '/lab/result#LabResult']);

        await flowButton(p, '선택 해제').click();
        assert.deepEqual(await shown(), ['flow-bar', 'flow', 'gaps']);
        assert.deepEqual(await boxesWith(p, 'dim'), []);
        assert.deepEqual(await boxesWith(p, 'jump'), []);
        assert.equal(await p.evaluate(() => decodeURIComponent(location.hash)), '#flow');

        await (await screenBox(p, '/lab#Lab')).focus();
        await p.keyboard.press('Enter');
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'Enter on a focused screen picks it');
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right .mark-form textarea', '아직 저장하지 않은 메모');
        await (await screenBox(p, '/lab#Lab')).click();
        assert.equal(await p.inputValue('#right .mark-form textarea'), '아직 저장하지 않은 메모', 'pressing the picked screen again keeps the unsaved mark');
        await p.focus('#right .statuses button:has-text("충분")');
        await p.keyboard.press('Escape');
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'Escape in the panes keeps the pick');
        await p.locator('#center table.calls td.cell').first().click();
        assert.notEqual(await p.evaluate(() => state.target.node), '/lab#Lab');
        await (await screenBox(p, '/lab#Lab')).click();
        assert.equal(await p.evaluate(() => state.target.node), '/lab#Lab', 'pressing the picked screen goes back from a call to the screen');
        await (await screenBox(p, '/lab#Lab')).focus();
        await p.keyboard.press('Escape');
        assert.deepEqual(await pickedBoxes(p), []);
        assert.equal(await p.locator('#gaps').isVisible(), true);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a move in the config draws a screen no link reached yet under the screen it leaves with a green dotted line, marks the screen it reaches in another branch when its screen is picked, and both screens list the move with its reason', { skip: browserMissing }, async () => {
  const moves = [{ from: '/signin', to: '/lab/result', reason: '로그인 뒤' }, { from: '/lab/result', to: '/help', reason: '닫은 뒤' }, { from: '/signin', to: '/help', reason: '도움말 단추' }];
  await withRebuiltFixture({ moves }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const movedLines = () => p.$$eval('#flow .canvas svg path.moved', (els) => els.map((e) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--fine)';
          document.body.append(probe);
          const fine = getComputedStyle(probe).color;
          probe.remove();
          const c = getComputedStyle(e);
          return [(e as SVGElement).dataset.from, (e as SVGElement).dataset.to, c.stroke === fine, c.strokeDasharray];
        }).sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
        const bothMoves = [['/signin#SignIn', '/help#Help', true, '3px, 3px'], ['/signin#SignIn', '/lab/result#LabResult', true, '3px, 3px']];
        assert.deepEqual(await movedLines(), bothMoves, 'a move over a guarded link is drawn as the move');
        assert.ok((await tipLines(await screenBox(p, '/lab/result#LabResult'))).includes('설정에 적은 이동: 로그인 뒤'));
        const helpTips = await tipLines(await screenBox(p, '/help#Help'));
        assert.ok(helpTips.includes('설정에 적은 이동: 도움말 단추'));
        assert.ok(!helpTips.some((t) => t.startsWith('이 링크의 조건')), 'the guard of the link the move is drawn over is left out');
        assert.deepEqual(await boxesWith(p, 'jump'), []);

        await (await screenBox(p, '/lab/result#LabResult')).click();
        await p.waitForSelector('#flow .box.picked');
        assert.deepEqual(await boxesWith(p, 'jump'), ['/help#Help'], 'the screen its move reaches in another branch is marked');
        assert.equal((await lineStates(p))['/signin#SignIn /lab/result#LabResult'], 'on');
        assert.deepEqual(await movedLines(), bothMoves, 'a strong move line stays green and dotted');
        assert.match((await p.textContent('#center .screen-info > summary .counts'))!, /^들어오는 링크 2 · 나가는 링크 1 · /, 'the folded line counts the moves with the links');
        await openScreenInfo(p);
        assert.equal(await p.textContent('#center .access h2'), '들어오는 링크 2');
        assert.deepEqual(await p.locator('#center .access .moves li').allTextContents(), ['/signin#SignIn 설정에 적은 이동 로그인 뒤']);
        const outgoing = p.locator('#center .screen-info h2', { hasText: '나가는 링크' });
        assert.equal(await outgoing.textContent(), '나가는 링크 1');
        assert.deepEqual(await outgoing.locator('xpath=following-sibling::*[1]').locator('li').allTextContents(), ['/help#Help 설정에 적은 이동 닫은 뒤']);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a click on an empty spot of the flow drawing lets the picked screen go as 「선택 해제」 does, while a click on a line or the scrollbar, a press dragged across the drawing, or a press on a screen released just beside it keeps it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const shown = () => p.evaluate(() => ['flow-bar', 'flow', 'left', 'center', 'right', 'gaps'].filter((id) => !document.getElementById(id)!.hidden));
        const emptySpot = () => p.evaluate(() => {
          const empty = (x: number, y: number) => document.elementFromPoint(x, y)?.matches('#flow, #flow .zoom-box, #flow .canvas') ?? false;
          const r = document.getElementById('flow')!.getBoundingClientRect();
          for (let y = r.top + 20; y < r.bottom - 20; y += 8) {
            for (let x = r.left + 20; x < r.right - 60; x += 8) if ([0, 20, 40].every((d) => empty(x + d, y))) return { x, y };
          }
          return null;
        });
        const lineSpot = () => p.evaluate(() => {
          for (const line of document.querySelectorAll<SVGPathElement>('#flow .canvas svg path[data-from]')) {
            const { x, y } = line.getPointAtLength(line.getTotalLength() / 2).matrixTransform(line.getScreenCTM()!);
            if (document.elementFromPoint(x, y) === line) return { x, y };
          }
          return null;
        });

        await (await screenBox(p, '/lab#Lab')).click();
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab']);
        const line = await lineSpot();
        assert.ok(line, 'a line is drawn where nothing covers it');
        await p.mouse.click(line.x, line.y);
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'a click on a line keeps the pick');

        const spot = await emptySpot();
        assert.ok(spot, 'the drawing has an empty spot');
        await p.mouse.move(spot.x, spot.y);
        await p.mouse.down();
        await p.mouse.move(spot.x + 40, spot.y, { steps: 5 });
        await p.mouse.up();
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'a press dragged across the drawing keeps the pick');

        const edge = await p.evaluate(() => {
          for (const box of document.querySelectorAll<HTMLElement>('#flow .box.screen')) {
            const r = box.getBoundingClientRect();
            const y = r.top + r.height / 2;
            if (document.elementFromPoint(r.right - 1, y)?.closest('.box') === box && document.elementFromPoint(r.right + 2, y)?.matches('#flow .canvas')) return { x: r.right - 1, y };
          }
          return null;
        });
        assert.ok(edge, 'a screen has empty drawing just beside it');
        await p.mouse.move(edge.x, edge.y);
        await p.mouse.down();
        await p.mouse.move(edge.x + 3, edge.y);
        await p.mouse.up();
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'a press on a screen released just beside it keeps the pick');

        const bar = await p.evaluate(() => {
          const flow = document.getElementById('flow')!;
          const r = flow.getBoundingClientRect();
          return { x: r.left + flow.clientLeft + flow.clientWidth + 2, y: r.top + 40, gutter: r.width - flow.clientLeft - flow.clientWidth };
        });
        assert.ok(bar.gutter > 4, `the drawing keeps room for its scrollbar: ${bar.gutter}`);
        await p.mouse.click(bar.x, bar.y);
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'a press on the scrollbar keeps the pick');

        await p.mouse.click(spot.x, spot.y);
        assert.deepEqual(await pickedBoxes(p), []);
        assert.deepEqual(await shown(), ['flow-bar', 'flow', 'gaps']);
        assert.deepEqual(await boxesWith(p, 'dim'), []);
        assert.ok(Object.values(await lineStates(p)).every((v) => v === ''), JSON.stringify(await lineStates(p)));
        assert.equal(await p.locator('.flowbar .picking').count(), 0);
        assert.equal(await p.evaluate(() => decodeURIComponent(location.hash)), '#flow');

        await (await screenBox(p, '/help#Help')).click();
        assert.deepEqual(await pickedBoxes(p), ['/help#Help'], 'a click on a screen still picks it');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a second press on a case kind button while the first is saving writes nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/signin")');
        await openScreenInfo(p);
        await p.locator('#center .screen-info > .cases .case-kinds button[title="@case:boundary"]').evaluate((b: HTMLButtonElement) => {
          b.click();
          b.click();
        });
        await p.waitForSelector('#center .screen-info > .cases li');
        await p.waitForSelector('#center .screen-info > .cases .case-kinds button:not([disabled])');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]), [[{ node: '/signin#SignIn', case: 'boundary' }, 'needed']]);
      }, { view: 'list' }),
    ),
  );
});

test('in a browser, a case kind pick that fails to save or to reload shows its error next to the case kind buttons, not in the comment form, until another target or tab is chosen', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#screen-list li:has-text("/signin")');
        await openScreenInfo(p);
        await p.evaluate(() => {
          const real = window.fetch;
          (window as unknown as { realFetch: typeof fetch }).realFetch = real;
          window.fetch = (url, init) => (String(url).includes('/api/marks') ? Promise.reject(new Error('disk full')) : real(url, init));
        });
        const section = p.locator('#center .screen-info > .cases');
        await section.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).click();
        await section.locator('.error').waitFor();
        assert.equal(await section.locator('.error').textContent(), `「/signin#SignIn · 경우 ${CASE_KINDS.boundary}」 코멘트를 저장하지 못했습니다: disk full`);
        assert.equal(await p.locator('#right .error').count(), 0);
        assert.equal(await section.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).isEnabled(), true);
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#left .views.side button:has-text("화면")');
        assert.equal(await p.locator('#center .cases .error').count(), 0, 'a tab switch clears the error');

        await p.evaluate(() => {
          const real = (window as unknown as { realFetch: typeof fetch }).realFetch;
          window.fetch = (url, init) => (String(url).includes('/api/data') ? Promise.reject(new Error('gone')) : real(url, init));
        });
        await section.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).click();
        await section.locator('.error').waitFor();
        assert.equal(await section.locator('.error').textContent(), `「/signin#SignIn · 경우 ${CASE_KINDS.boundary}」 코멘트는 저장했지만 다시 읽지 못했습니다: gone`);
        assert.equal(await p.locator('#right .error').count(), 0);
        await p.click('#screen-list li:has-text("/home")');
        assert.equal(await p.locator('#center .cases .error').count(), 0);
      }, { view: 'list' }),
    ),
  );
});

test('in a browser, a screen picked in the flow shows the same case kind buttons in the screen info, and a kind pressed there becomes its case while the screen stays picked', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        await (await screenBox(p, '/signin#SignIn')).click();
        await openScreenInfo(p);
        const section = p.locator('#center .screen-info > .cases');
        assert.deepEqual(await section.locator('.case-kinds button').allTextContents(), [CASE_KINDS.boundary, CASE_KINDS.legacy]);
        await section.locator('.case-kinds button', { hasText: CASE_KINDS.boundary }).click();
        await p.waitForSelector('#center .screen-info > .cases li');
        assert.deepEqual(await section.locator('li .case').allTextContents(), [CASE_KINDS.boundary]);
        assert.equal((await section.locator('li .step-tests').innerText()).replace(/\s+/g, ' ').trim(), 'UI/E2E ✓1');
        assert.deepEqual(await pickedBoxes(p), ['/signin#SignIn']);
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status]), [[{ node: '/signin#SignIn', case: 'boundary' }, 'needed']]);
      }, { view: 'flow' }),
    ), [BOUNDARY_ON_SIGNIN]);
});

test('in a browser, with nothing picked the right column lists the failing screens and then the ones without a tagged test, in the order of the drawing, and pressing one picks it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const testsFile = path.join(config.outDir, 'tests.json');
    const tests = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
    tests.importers['/admin/group#AdminGroup'] = [tests.importers['/help#Help'][0]];
    fs.writeFileSync(testsFile, JSON.stringify(tests));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#gaps .gap-list');
        assert.equal(await p.textContent('#gaps h2'), '빈틈 9');
        assert.deepEqual(await p.locator('#gaps h3').allTextContents(), ['실패 5', '테스트 없음 4']);
        const names = (n: number) => p.locator('#gaps .gap-list').nth(n).locator('li .name > span:first-child').allTextContents();
        assert.deepEqual(await names(0), ['/home', '/document/:tab(draft|done)', '/document/:id', '/admin/member', '/help']);
        assert.deepEqual(await names(1), ['/admin/group', '/lab/result', '/admin/audit', '/admin/report']);
        const group = p.locator('#gaps .gap-list li', { hasText: '/admin/group' });
        assert.deepEqual(await group.locator('.count').allTextContents(), ['테스트 없음', '불러옴 1'], 'a screen with only untagged tests is a gap and says what it has');
        assert.equal(await p.locator('#gaps li.selected').count(), 0);

        await group.click();
        assert.deepEqual(await pickedBoxes(p), ['/admin/group#AdminGroup']);
        assert.equal(await p.textContent('#center h3'), '/admin/group');
        assert.equal(await p.locator('#gaps').isHidden(), true);
      }, { view: 'flow' }),
    );
  });
});

test('in a browser, the flow bar counts the drawn screens on one button per status, and a pressed button and the search box fade the screens they leave out without moving any', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        assert.equal(await p.textContent('.flowbar .flowsummary'), '테스트 있는 화면 7/11');
        assert.deepEqual(await p.locator('.flowbar .flow-filters button').allTextContents(), ['전체 11', '테스트 없음 4', '태그 없는 테스트만 0', '실패 5', '보류 1', '통과 1']);
        const summary = await p.evaluate(() => state.data.flow.summary);
        const count = async (key: string) => Number(await filterButton(p, key).locator('.count').textContent());
        assert.deepEqual([await count('fail'), await count('imported'), 11 - await count('none')], [summary.failing, summary.importedOnly, summary.tested], 'the buttons agree with the counts the server made');
        const pressed = () => p.$$eval('.flowbar .flow-filters button[aria-pressed=true]', (els: HTMLElement[]) => els.map((e) => e.dataset.filter));
        assert.deepEqual(await pressed(), ['all']);
        const before = await p.$$eval('#flow .box.screen', (els: HTMLElement[]) => els.map((e) => [e.dataset.key, e.style.left, e.style.top]));

        await filterButton(p, 'fail').click();
        assert.deepEqual(await pressed(), ['fail']);
        assert.deepEqual(await boxesWith(p, 'off'), ['/admin/audit#AdminAudit', '/admin/group#AdminGroup', '/admin/report#AdminReport', '/lab#Lab', '/lab/result#LabResult', '/signin#SignIn']);
        await filterButton(p, 'pending').click();
        assert.deepEqual(await pressed(), ['pending'], 'one status at a time');
        assert.deepEqual(SCREEN_ORDER.filter((id) => !(id === '/lab#Lab')).sort(), await boxesWith(p, 'off'));
        await filterButton(p, 'pending').click();
        assert.deepEqual(await pressed(), ['all'], 'pressing the pressed button again shows every screen');
        assert.deepEqual(await boxesWith(p, 'off'), []);

        const search = p.locator('.flowbar input.flow-search');
        await search.fill('admin/');
        assert.deepEqual(SCREEN_ORDER.filter((id) => !id.startsWith('/admin/')).sort(), await boxesWith(p, 'off'));
        await filterButton(p, 'none').click();
        assert.deepEqual(SCREEN_ORDER.filter((id) => !['/admin/group#AdminGroup', '/admin/audit#AdminAudit', '/admin/report#AdminReport'].includes(id)).sort(), await boxesWith(p, 'off'), 'the search and the button both apply');
        assert.equal(await search.evaluate((e) => e === document.activeElement), false);
        await search.focus();
        await p.keyboard.press('Enter');
        assert.deepEqual(await pickedBoxes(p), ['/admin/group#AdminGroup'], 'Enter picks the first screen still shown');
        assert.equal(await search.inputValue(), 'admin/', 'the search stays as typed across the redraw');
        await search.fill('');
        await filterButton(p, 'none').click();
        await flowButton(p, '선택 해제').click();
        assert.deepEqual(await p.$$eval('#flow .box.screen', (els: HTMLElement[]) => els.map((e) => [e.dataset.key, e.style.left, e.style.top])), before, 'fading and picking leave every screen where it was');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a screen in the flow is one line with its status as a square, its API calls as a count and the kind of condition that opens it, with the rest on hover', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const home = await screenBox(p, '/home#Home');
        assert.equal(await home.locator('.path').textContent(), '/home');
        assert.deepEqual(await home.locator('.tag').allTextContents(), ['API 2', '죽은 화면']);
        assert.match((await home.getAttribute('class'))!, /s-fail/);
        assert.equal(await home.locator('.sr-only').textContent(), '실패');
        assert.equal(await statusLine(home), '실패 · 불러옴 1');
        assert.deepEqual(await tipLines(home), []);
        assert.equal(await home.locator('button').count(), 0, 'a screen carries no buttons of its own');

        const audit = await screenBox(p, '/admin/audit#AdminAudit');
        assert.deepEqual(await needTag(audit), ['역할']);
        assert.deepEqual((await tipLines(audit)).filter((t) => t.startsWith('필요한')), ['필요한 역할: ADMIN, AUDITOR']);
        assert.equal(await statusLine(audit), '테스트 없음');
        const group = await screenBox(p, '/admin/group#AdminGroup');
        assert.deepEqual((await tipLines(group)).filter((t) => /역할/.test(t)), ['필요한 역할: ADMIN', '읽지 못한 역할 조건: isAdmin']);
        const lab = await screenBox(p, '/lab#Lab');
        assert.deepEqual(await needTag(lab), ['설정']);
        assert.deepEqual((await tipLines(lab)).filter((t) => t.startsWith('필요한')), ['필요한 설정: SYSTEM.LAB_ENABLED 켬']);
        assert.match((await tipLines(lab))[0], /^이 링크의 조건: globalSettings\.SYSTEM\.LAB_ENABLED$/);
        const report = await screenBox(p, '/admin/report#AdminReport');
        assert.deepEqual(await needTag(report), ['역할·설정']);
        assert.deepEqual((await tipLines(report)).filter((t) => t.startsWith('필요한')), [
          '필요한 역할: ADMIN, OWNER',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN.LIST 에 "ADMIN_REPORT"',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN 있음',
        ]);
        assert.match((await (await screenBox(p, '/help#Help')).getAttribute('class'))!, /s-fail/);
        assert.equal(await statusLine(await screenBox(p, '/help#Help')), '실패 · 불러옴 2', 'untagged tests are counted apart and do not set the status');
        assert.deepEqual(await p.evaluate(() => openNeeds({ access: { settings: [{ from: 'route', unreadable: [], needs: [
          { path: ['SYSTEM', 'MENU'], need: 'present' },
          { path: ['SYSTEM', 'MENU', 'LIST'], need: 'includes', value: 'X' },
        ] }] } }).lines.map((l) => l.text)), ['설정 "X" (MENU.LIST 에) 외 1']);
        assert.deepEqual(await p.evaluate(() => openNeeds({ access: { roleValues: null, unreadableRoleGuards: [] } })), {
          lines: [{ kind: 'role', text: '역할 미확인' }], tips: ['필요한 역할: 미확인'], bare: null,
        });

        const titles = await p.locator('#flow .box.screen').evaluateAll((boxes) => boxes.map((b) => b.getAttribute('title')!.split('\n').at(-1)));
        assert.deepEqual([...new Set(titles)], [PICK_HINT]);
        const heights = await p.$$eval('#flow .box.screen', (els: HTMLElement[]) => els.map((e) => e.offsetHeight));
        assert.ok(Math.max(...heights) < 30, `every screen is one line (${Math.max(...heights)}px)`);
        assert.deepEqual(await textOutside(p), []);
        assert.deepEqual(await layoutErrors(p), []);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a flow box sits midway between its first and last child and stays inside the canvas apart from the boxes in its column, whatever the box heights', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const { trees, gap } = await p.evaluate(() => {
          const sizes: Record<string, { width: number; height: number }> = {};
          const screen = (id: string, height: number, children: object[] = []) => {
            sizes[id] = { width: 100 + id.length * 10, height };
            return { kind: 'screen', id, children, calls: [], guards: [] };
          };
          const [plain, tall, tallest] = [24, 41, 58];
          const shapes = {
            plain: [screen('root', plain, [screen('a', plain), screen('b', plain)])],
            tallFirst: [screen('root', plain, [screen('tall', tall), screen('next', plain, [screen('grandchild', plain)])])],
            tallOverScreens: [screen('root', plain, [screen('p', tallest, [screen('p1', plain)]), screen('q', tallest, [screen('q1', plain)])])],
            tallOverTall: [screen('root', plain, [screen('x', plain), screen('outer', tallest, [screen('inner', tall)])])],
          };
          return {
            gap: GAP,
            trees: Object.fromEntries(Object.entries(shapes).map(([name, roots]) => {
              const { boxes, edges, height } = layoutFlow(roots, sizes);
              return [name, { height, edges: edges.map((e): [string, number, number] => [e.from, e.y1, e.y2]), boxes: boxes.map((b) => ({ id: b.key, x: b.x, y: b.y, bottom: b.y + b.height })) }];
            })),
          };
        });
        for (const [name, { height, edges, boxes }] of Object.entries(trees)) {
          for (const parent of new Set(edges.map(([from]) => from))) {
            const ends = edges.filter(([from]) => from === parent).map(([, , y2]) => y2);
            const [, y1] = edges.find(([from]) => from === parent)!;
            assert.equal(y1, (Math.min(...ends) + Math.max(...ends)) / 2, `${name}: the box at ${parent} sits midway between its children`);
          }
          for (const b of boxes) assert.ok(b.y >= 0 && b.bottom <= height, `${name}: ${b.id} is inside the canvas`);
          for (const a of boxes) for (const b of boxes) {
            if (a !== b && a.x === b.x) assert.ok(a.bottom + gap <= b.y || b.bottom + gap <= a.y, `${name}: ${a.id} and ${b.id} keep a gap between them`);
          }
        }
      }),
    ),
  );
});

test('in a browser, a screen in the flow says on hover when a setting condition could not be turned into a value', { skip: browserMissing }, async () => {
  const edits: [string, string, string][] = [
    ['client/src/components/DocumentDetail.js', 'const helpEnabled = system.HELP_LINK_ENABLED;', 'const helpEnabled = () => system.HELP_LINK_ENABLED;'],
    ['client/src/components/DocumentDetail.js', '{helpEnabled && <Link', '{helpEnabled() && <Link'],
  ];
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const help = await screenBox(p, '/help#Help');
        assert.deepEqual(await needTag(help), ['설정']);
        assert.ok((await tipLines(help)).some((t) => t.startsWith('정하지 못한 설정 조건: helpEnabled()')));
      }, { view: 'flow' }),
    ), edits);
});

const changeData = (edit: (data: PageData) => void) => async (page: Page) => {
  await page.route('**/api/data', async (route) => {
    const res = await route.fetch();
    const data: PageData = await res.json();
    edit(data);
    await route.fulfill({ response: res, json: data });
  });
};

test('in a browser, when the first flow drawing fails the message stays visible and neither view button changes that', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#failed', { state: 'visible' });
        assert.match((await p.textContent('#failed'))!, /^페이지를 그리지 못했습니다: ./);
        assert.equal(await p.isHidden('main'), true);
        assert.equal(await p.isHidden('#flow'), true);
        for (const id of ['#view-flow', '#view-list', '#view-flow']) {
          await p.click(id);
          assert.equal(await p.isVisible('#failed'), true);
          assert.equal(await p.isHidden('main'), true);
          assert.equal(await p.isHidden('#flow'), true);
        }
        assert.equal(await p.locator('main section').count(), 4);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots[0].guards = null; }) }),
    ),
  );
});

test('in a browser, a map with no screens says so in the flow, and the entryPaths hint is only for screens with no entry', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('.flowbar .flowsummary');
        assert.match((await p.textContent('#flow'))!, /entryPaths/);
        assert.doesNotMatch((await p.textContent('#flow'))!, /화면이 없습니다\./);
      }, { view: 'flow', setup: changeData((data) => {
        data.flow = { ...data.flow, roots: [], unreached: [...data.flow.roots, ...data.flow.unreached] };
      }) }),
    );
    fs.writeFileSync(mapFile, JSON.stringify({ ...map, screens: [], entries: [] }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('.flowbar .flowsummary');
        assert.match((await p.textContent('#flow'))!, /화면이 없습니다\./);
        assert.doesNotMatch((await p.textContent('#flow'))!, /entryPaths/);
        assert.equal(await p.textContent('#gaps h2'), '빈틈 0');
        assert.equal(await p.textContent('#gaps p:last-child'), '빈틈이 없습니다.');
      }, { view: 'flow' }),
    );
  });
});

const LONG_ROUTE = '/user-completed-documents/signature-requests/:documentId/participants/history';
const walkFlow = (ns: FlowNode[]): FlowNode[] => ns.flatMap((n) => [n, ...walkFlow(n.children)]);
const withLongRoute = (data: PageData) => {
  walkFlow(data.flow.roots).find((n) => n.id === '/help#Help')!.label = LONG_ROUTE;
};
const leafEntries = (data: PageData, count: number) => {
  const leaves = walkFlow(data.flow.roots).filter((n) => !n.children.length);
  return Array.from({ length: count }, (_, i) => ({ ...structuredClone(leaves[i % leaves.length]), id: `/extra/${i}#Extra${i}`, label: `/extra/${i}`, guards: [] }));
};
const flowBoxes = (p: Page) => p.$$eval('#flow .box', (els: HTMLElement[]) => els.map((e) => {
  const r = e.getBoundingClientRect();
  return { id: e.title.split('\n')[0], left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, grouped: e.classList.contains('grouped') };
}));
const overlapping = (boxes: Awaited<ReturnType<typeof flowBoxes>>) => boxes.flatMap((a, i) => boxes.slice(i + 1)
  .filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
  .map((b) => `${a.id} / ${b.id}`));

test('in a browser, every flow box stands where the layout put it, each line ending at the middle of its box and boxes under one another keeping the layout\'s gap, also with gathered entry screens', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        assert.deepEqual(await layoutErrors(p), []);
        assert.deepEqual(await textOutside(p), []);
        assert.deepEqual(overlapping(await flowBoxes(p)), []);
      }, { view: 'flow', setup: changeData((data) => {
        withLongRoute(data);
        const extras = leafEntries(data, 3);
        extras[0].label = LONG_ROUTE;
        data.flow.roots.push(...extras);
      }) }),
    ),
  );
});

test('in a browser, resizing the window after the review ended throws nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => {} });
    try {
      await withPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async (p) => {
        await p.waitForSelector('#flow .group-head');
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        await p.setViewportSize({ width: 900, height: 700 });
        await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) });
    } finally {
      server.close();
    }
  });
});

test('in a browser, the flow is drawn again on a resize only when gathered entry screens are shown and the number of cells in a row changes', { skip: browserMissing }, async () => {
  const frames = (p: Page) => p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const mark = (p: Page) => p.evaluate(() => { document.querySelector<HTMLElement>('#flow .box')!.dataset.before = ''; });
  const kept = (p: Page) => p.evaluate(() => document.querySelector('#flow .box[data-before]') !== null);
  const resize = async (p: Page, width: number, height: number) => {
    await p.setViewportSize({ width, height });
    await frames(p);
  };
  const perRow = (p: Page) => p.evaluate(() => drawnGrid!.per);
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const wide = await perRow(p);
        await mark(p);
        await resize(p, 1430, 600);
        assert.equal(await perRow(p), wide);
        assert.ok(await kept(p), 'a small change of width that keeps the number of cells in a row keeps the drawing');
        await resize(p, 1000, 600);
        assert.ok(await perRow(p) < wide, 'a narrower window holds fewer cells in a row');
        assert.ok(!(await kept(p)), 'a change that alters the number of cells in a row draws the gathered entry screens again');
        const narrow = await perRow(p);
        await (await screenBox(p, '/home#Home')).click();
        assert.ok(await perRow(p) < narrow, 'picking a screen gives the drawing less room and fewer cells in a row');
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        assert.equal(await p.locator('#flow .group-head').count(), 0);
        await mark(p);
        await resize(p, 900, 900);
        assert.ok(await kept(p), 'with nothing gathered the width does not change the drawing');
      }, { view: 'flow' }),
    ),
  );
});

const paneWidths = (p: Page, ids: string[]) => p.evaluate((ids) => ids.map((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().width)), ids);
const dragEdge = async (p: Page, id: string, dx: number, { off = 3, y }: { off?: number; y?: number } = {}) => {
  const box = (await p.locator(`#${id}`).boundingBox())!;
  const x = box.x + box.width / 2 + off;
  const at = y ?? box.y + box.height / 2;
  await p.mouse.move(x, at);
  await p.mouse.down();
  await p.mouse.move(x + dx, at, { steps: 8 });
  await p.mouse.up();
};
const edgeLine = (p: Page, id: string) => p.evaluate((id) => {
  const edge = document.getElementById(id)!;
  const r = edge.getBoundingClientRect();
  const line = getComputedStyle(edge, '::before');
  return { middle: r.left + r.width / 2, grab: r.width, width: line.width, color: line.backgroundColor, delay: line.transitionDelay, accent:getComputedStyle(document.body).getPropertyValue('--accent').trim() };
}, id);
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const nextFrame = (p: Page) => p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

test('in a browser, the edges on both sides of the middle pane of the list are dragged from a few pixels off the line, each pane stops at its minimum width, and the widths stay until the page is loaded again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const ids = ['left', 'center', 'right'];
        for (const width of [1920, 1440]) {
          await p.setViewportSize({ width, height: 900 });
          await p.reload();
          await toList(p);
          await p.click('#screen-list li:has-text("/lab/result")');
          assert.deepEqual(await paneWidths(p, ids), [300, width - 660, 360]);
          for (const [edge, pane] of [['sash-left', 'center'], ['sash-right', 'right']]) {
            const line = await edgeLine(p, edge);
            const border = await p.evaluate((id) => document.getElementById(id)!.getBoundingClientRect().left + 0.5, pane);
            assert.equal(line.middle, border, `${edge} sits on the border of #${pane}`);
            assert.ok(line.grab >= 8, `${edge} is grabbed across ${line.grab}px`);
            assert.equal(line.width, '1px');
          }

          await dragEdge(p, 'sash-left', 100);
          assert.deepEqual(await paneWidths(p, ids), [400, width - 760, 360], `${width}: the left edge moves with the mouse`);
          await dragEdge(p, 'sash-right', -80, { off: -3 });
          assert.deepEqual(await paneWidths(p, ids), [400, width - 840, 440], `${width}: the right edge moves with the mouse`);
          await dragEdge(p, 'sash-left', -500);
          assert.equal((await paneWidths(p, ids))[0], 300, `${width}: the list stops at its minimum`);
          await dragEdge(p, 'sash-right', 1000);
          assert.equal((await paneWidths(p, ids))[2], 320, `${width}: the right pane stops at its minimum`);
          await dragEdge(p, 'sash-right', -3000);
          assert.deepEqual(await paneWidths(p, ids), [300, 360, width - 660], `${width}: the middle pane stops at its minimum`);
          await dragEdge(p, 'sash-right', width - 660 - 500);
          assert.deepEqual(await paneWidths(p, ids), [300, width - 800, 500]);

          await p.click('#view-flow');
          await toList(p);
          assert.deepEqual(await paneWidths(p, ids), [300, width - 800, 500], `${width}: the widths stay across views`);
        }

        await p.setViewportSize({ width: 1100, height: 900 });
        await nextFrame(p);
        assert.deepEqual(await paneWidths(p, ids), [300, 360, 440], 'a narrower window takes the room for the middle pane from the dragged pane');
        await p.setViewportSize({ width: 1440, height: 900 });
        await nextFrame(p);
        assert.deepEqual(await paneWidths(p, ids), [300, 640, 500], 'a wider window gives the dragged width back');

        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/lab/result")');
        assert.deepEqual(await paneWidths(p, ids), [300, 780, 360], 'loading the page again starts from the first widths');
      }),
    ),
  );
});

test('in a browser, dragging the right edge of the flow before the drawing edge was ever dragged leaves the drawing where it is, and the drawing still grows with the window', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const ids = ['flow', 'center', 'right'];
        await p.setViewportSize({ width: 1440, height: 900 });
        await p.evaluate(() => history.replaceState(null, '', '#flow'));
        await p.reload();
        await p.waitForSelector('#flow .group-head');
        await (await screenBox(p, '/home#Home')).click();
        const [graph, center] = await paneWidths(p, ids);
        await dragEdge(p, 'sash-right', -100, { off: -3 });
        assert.deepEqual(await paneWidths(p, ids), [graph, center - 100, 460]);
        await p.setViewportSize({ width: 1920, height: 900 });
        await p.waitForFunction((w) => Math.round(document.getElementById('flow')!.getBoundingClientRect().width) === w, graph + 240);
        assert.deepEqual(await paneWidths(p, ids), [graph + 240, center + 140, 460]);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
});

test('in a browser, the edges on both sides of the middle pane of the flow are dragged, the drawing is laid out again for the width of its pane, and the drawing stops at its minimum width', { skip: browserMissing }, async () => {
  const perRow = (p: Page) => p.evaluate(() => drawnGrid!.per);
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const ids = ['flow', 'center', 'right'];
        for (const width of [1920, 1440]) {
          await p.setViewportSize({ width, height: 900 });
          await p.evaluate(() => history.replaceState(null, '', '#flow'));
          await p.reload();
          await p.waitForSelector('#flow .group-head');
          assert.equal(await p.locator('.sash:visible').count(), 0, 'with no screen picked the flow has no edge to drag');
          await (await screenBox(p, '/home#Home')).click();
          const half = (width - 360) / 2;
          assert.deepEqual(await paneWidths(p, ids), [half, half, 360]);
          const wide = await perRow(p);

          await dragEdge(p, 'sash-left', -200, { off: -3 });
          await nextFrame(p);
          assert.deepEqual(await paneWidths(p, ids), [half - 200, half + 200, 360], `${width}: the edge between the drawing and the middle pane moves with the mouse`);
          assert.ok(await perRow(p) < wide, `${width}: a narrower drawing holds fewer cells in a row`);
          await dragEdge(p, 'sash-left', -2000);
          assert.equal((await paneWidths(p, ids))[0], 240, `${width}: the drawing stops at its minimum`);
          await dragEdge(p, 'sash-right', -100);
          assert.equal((await paneWidths(p, ids))[2], 460, `${width}: the right pane moves with the mouse`);

          await p.click('#view-list');
          await p.click('#screen-list li:has-text("/home")');
          assert.equal((await paneWidths(p, ['right']))[0], 460, `${width}: the list shows the same right pane width`);
        }
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
});

test('in a browser, an edge takes the accent colour a moment after the mouse rests on it and at once while it is dragged, without getting thicker', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.click('#screen-list li:has-text("/lab/result")');
        const unlit = 'rgba(0, 0, 0, 0)';
        assert.equal((await edgeLine(p, 'sash-right')).color, unlit, 'only the gray border shows until the mouse comes');
        const box = (await p.locator('#sash-right').boundingBox())!;
        const y = box.y + 300;
        await p.mouse.move(box.x + box.width / 2 + 3, y);
        const resting = await edgeLine(p, 'sash-right');
        assert.equal(resting.color, unlit, 'a mouse passing over does not light the edge at once');
        assert.equal(resting.delay, '0.3s', 'the edge lights only once the mouse has rested on it');
        await p.waitForTimeout(600);
        const hovered = await edgeLine(p, 'sash-right');
        assert.equal(hovered.color, rgb(hovered.accent));
        assert.equal(hovered.width, '1px');

        await p.mouse.move(box.x - 200, y);
        await p.waitForTimeout(300);
        assert.equal((await edgeLine(p, 'sash-right')).color, unlit);
        await p.mouse.move(box.x + box.width / 2, y);
        await p.mouse.down();
        const dragged = await edgeLine(p, 'sash-right');
        assert.equal(dragged.color, rgb(dragged.accent), 'a press lights the edge without the wait');
        assert.equal(dragged.width, '1px');
        await p.mouse.move(box.x - 150, y, { steps: 4 });
        assert.equal((await edgeLine(p, 'sash-right')).color, rgb(dragged.accent), 'the edge stays lit while the mouse is off it during the drag');
        await p.mouse.up();
        await p.mouse.move(box.x - 400, y);
        await p.waitForTimeout(300);
        assert.equal((await edgeLine(p, 'sash-right')).color, unlit, 'the edge goes back to gray once let go and left');
      }),
    ),
  );
});

test('in a browser, an edge dragged across the app frame keeps following the mouse, and the frame takes the mouse again once the edge is let go', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.click('#screen-list li:has-text("/home")');
            await p.frameLocator('#center iframe.app').locator('#who:has-text("두루 관리자")').waitFor();
            const frame = (await p.locator('#center iframe.app').boundingBox())!;
            const pointer = () => p.$eval('#center iframe.app', (f) => getComputedStyle(f).pointerEvents);
            assert.equal(await pointer(), 'auto');
            const edge = (await p.locator('#sash-left').boundingBox())!;
            const x = edge.x + edge.width / 2;
            const y = frame.y + frame.height / 2;
            await p.mouse.move(x, y);
            await p.mouse.down();
            assert.equal(await pointer(), 'none', 'the frame lets the mouse through while an edge is dragged');
            await p.mouse.move(x + 300, y, { steps: 15 });
            assert.equal((await paneWidths(p, ['left']))[0], 600, 'the edge followed the mouse across the frame');
            await p.mouse.up();
            assert.equal(await pointer(), 'auto');
            await p.mouse.move(x + 350, y, { steps: 3 });
            assert.equal((await paneWidths(p, ['left']))[0], 600, 'the edge no longer moves once let go');
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a flow box with a long route breaks it only before a slash, its column grows no wider than the longest box needs, and no box cuts or spills its text', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const help = await (await screenBox(p, '/help#Help')).evaluate((box, route) => {
          const texts: Text[] = [];
          const walker = document.createTreeWalker(box.querySelector('.path')!, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) texts.push(walker.currentNode as Text);
          const chars = texts.flatMap((node) => [...node.data].map((ch, i) => {
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            return { ch, top: Math.round(range.getBoundingClientRect().top) };
          }));
          const whole = chars.map((c) => c.ch).join('');
          const lineStarts = chars.filter((c, i) => i > 0 && c.top > chars[i - 1].top).map((c) => c.ch);
          return { whole, routeLines: new Set(chars.map((c) => c.top)).size, lineStarts, width: box.getBoundingClientRect().width };
        }, LONG_ROUTE);
        assert.equal(help.whole, LONG_ROUTE);
        assert.ok(help.routeLines > 1, 'the long route takes more than one line');
        assert.deepEqual([...new Set(help.lineStarts)], ['/']);
        assert.ok(help.width <= 360, `the box stays within 360px (${help.width})`);
        const boxes = await flowBoxes(p);
        const left = boxes.find((b) => b.id === '/help#Help')!.left;
        assert.deepEqual([...new Set(boxes.filter((b) => b.left === left).map((b) => b.width))], [help.width], 'the boxes of a column share its width');

        const cut = await p.$$eval('#flow .box', (els: HTMLElement[]) => els
          .filter((box) => box.textContent.includes('…') || [box, ...box.querySelectorAll('*')].some((e) => getComputedStyle(e).textOverflow === 'ellipsis'))
          .map((box) => box.title.split('\n')[0]));
        assert.deepEqual(cut, []);
        assert.deepEqual(await textOutside(p), []);
        assert.deepEqual(await layoutErrors(p), []);
        assert.deepEqual(overlapping(boxes), []);
      }, { view: 'flow', setup: changeData(withLongRoute) }),
    ),
  );
});

test('in a browser, the zoom buttons shrink and grow the whole drawing around its layout, fit it into view, and keep the level across redraws', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1000, height: 300 });
        await p.waitForSelector('#flow .box.screen');
        const zoom = p.locator('#flow-zoom');
        assert.deepEqual(await zoom.locator('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['그림 전체가 보이게 맞춤', '축소', '확대']);
        assert.equal(await zoom.locator('.zoom-level').inputValue(), '100%');
        const measure = () => p.evaluate(() => {
          const canvas = document.querySelector<HTMLElement>('#flow .canvas')!;
          const box = document.querySelector<HTMLElement>('#flow .box.screen')!;
          return { layoutWidth: canvas.offsetWidth, drawnWidth: canvas.getBoundingClientRect().width, holder: canvas.parentElement!.getBoundingClientRect().width, left: box.style.left, boxWidth: box.getBoundingClientRect().width };
        });
        const full = await measure();
        await zoom.locator('.zoom-out').click();
        await zoom.locator('.zoom-out').click();
        assert.equal(await zoom.locator('.zoom-level').inputValue(), '80%');
        assert.equal(await p.evaluate(() => document.activeElement!.className), 'zoom-out', 'the pressed button keeps the focus');
        const small = await measure();
        assert.equal(small.layoutWidth, full.layoutWidth, 'the layout is worked out at full size');
        assert.equal(small.left, full.left);
        assert.ok(Math.abs(small.drawnWidth - full.layoutWidth * 0.8) <= 1, `${small.drawnWidth} against ${full.layoutWidth}`);
        assert.ok(Math.abs(small.holder - small.drawnWidth) <= 1, 'the room the drawing takes shrinks with it');
        assert.ok(Math.abs(small.boxWidth - full.boxWidth * 0.8) <= 1);
        await p.evaluate(() => renderFlow());
        assert.equal(await zoom.locator('.zoom-level').inputValue(), '80%');

        await zoom.locator('.zoom-fit').click();
        const fit = await p.evaluate(() => {
          const flow = document.getElementById('flow')!;
          return { level: state.zoom, scrollH: flow.scrollHeight, clientH: flow.clientHeight, scrollW: flow.scrollWidth, clientW: flow.clientWidth };
        });
        assert.ok(fit.level < 0.8 && fit.level >= 0.3, `fit chose ${fit.level}`);
        assert.ok(fit.scrollH <= fit.clientH + 1 && fit.scrollW <= fit.clientW + 1, `the whole drawing is in view: ${JSON.stringify(fit)}`);
        for (let i = 0; i < 20; i += 1) if (await zoom.locator('.zoom-in').isEnabled()) await zoom.locator('.zoom-in').click();
        assert.equal(await zoom.locator('.zoom-level').inputValue(), '150%');
        assert.equal(await zoom.locator('.zoom-in').isDisabled(), true);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the zoom control floats at the bottom-left of the drawing pane, stays there when a picked screen narrows the pane, and leaves the last row uncovered', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        for (const width of [1920, 1440]) {
          await p.setViewportSize({ width, height: 320 });
          await p.waitForSelector('#flow .box.screen');
          for (const pick of [false, true]) {
            if (pick) await (await screenBox(p, '/home#Home')).click();
            else if ((await pickedBoxes(p)).length) await p.locator('.flowbar .unpick').click();
            const m = await p.evaluate(() => {
              const flow = document.getElementById('flow')!;
              flow.scrollTop = flow.scrollHeight;
              flow.scrollLeft = 0;
              const pane = flow.getBoundingClientRect();
              const zoom = document.getElementById('flow-zoom')!.getBoundingClientRect();
              const meets = (r: DOMRect) => r.left < zoom.right && r.right > zoom.left && r.top < zoom.bottom && r.bottom > zoom.top;
              const others = ['.flowbar', '#center', '#right', '#gaps'].map((sel) => document.querySelector(sel)!).filter((e) => !(e as HTMLElement).hidden);
              return {
                toLeft: zoom.left - pane.left, toBottom: pane.bottom - zoom.bottom, inside: zoom.right < pane.right && zoom.top > pane.top, width: zoom.width,
                scrolls: flow.scrollHeight > flow.clientHeight,
                covered: [...flow.querySelectorAll<HTMLElement>('.box.screen, .group-head, :scope > h2')].filter((e) => meets(e.getBoundingClientRect())).map((e) => e.dataset.key ?? e.textContent),
                overlaps: others.filter((e) => meets(e.getBoundingClientRect())).map((e) => e.id || e.className),
              };
            });
            const at = `${width}px, ${pick ? 'picked' : 'not picked'}`;
            assert.ok(m.toLeft >= 8 && m.toLeft <= 24, `${at}: ${m.toLeft}px from the pane's left edge`);
            assert.ok(m.toBottom >= 8 && m.toBottom <= 32, `${at}: ${m.toBottom}px from the pane's bottom edge`);
            assert.ok(m.inside, at);
            assert.ok(m.width <= 200, `${at}: the control is ${m.width}px wide`);
            assert.ok(m.scrolls, `${at}: the drawing is taller than the pane`);
            assert.deepEqual(m.covered, [], `${at}: nothing in the drawing sits under the control when scrolled to the end`);
            assert.deepEqual(m.overlaps, [], at);
          }
          assert.deepEqual(await pickedBoxes(p), ['/home#Home']);
          await p.locator('#flow-zoom .zoom-in').click();
          assert.deepEqual(await pickedBoxes(p), ['/home#Home'], 'pressing the control does not let the picked screen go');
          await p.locator('#flow-zoom .zoom-out').click();
          await p.locator('.flowbar .unpick').click();
        }
        await p.click('#view-list');
        assert.equal(await p.locator('#flow-zoom').isVisible(), false, 'the list view has no zoom control');
        await p.click('#view-flow');
        assert.equal(await p.locator('#flow-zoom').isVisible(), true);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a percent typed into the zoom control applies on Enter or on leaving it, snaps to the nearest end when out of range, and Escape or a non-number keeps the level', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const level = p.locator('#flow-zoom .zoom-level');
        const now = () => p.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('#flow-zoom .zoom-level')!;
          return { zoom: state.zoom, value: input.value, focused: document.activeElement === input, selected: input.value.slice(input.selectionStart!, input.selectionEnd!), scale: document.querySelector<HTMLElement>('#flow .canvas')!.style.transform };
        });
        const type = async (text: string, key: string) => {
          await p.keyboard.press('Control+A');
          await p.keyboard.type(text);
          await p.keyboard.press(key);
        };
        assert.equal(await level.getAttribute('aria-label'), '배율 (퍼센트)');

        await level.click();
        assert.deepEqual(await now(), { zoom: 1, value: '100%', focused: true, selected: '100%', scale: '' }, 'pressing the percent selects it');
        await type('75', 'Enter');
        assert.deepEqual(await now(), { zoom: 0.75, value: '75%', focused: true, selected: '75%', scale: 'scale(0.75)' });
        await type('abc', 'Enter');
        assert.deepEqual(await now(), { zoom: 0.75, value: '75%', focused: true, selected: '75%', scale: 'scale(0.75)' }, 'a non-number goes back');
        await type('', 'Enter');
        assert.equal((await now()).value, '75%', 'so does an empty field');
        await p.keyboard.type('60');
        await p.keyboard.press('Escape');
        assert.deepEqual(await now(), { zoom: 0.75, value: '75%', focused: true, selected: '75%', scale: 'scale(0.75)' }, 'Escape goes back');
        await type('500', 'Enter');
        assert.equal((await now()).value, '150%');
        assert.equal(await p.locator('#flow-zoom .zoom-in').isDisabled(), true);
        await type('10%', 'Enter');
        assert.equal((await now()).value, '30%');
        assert.equal(await p.locator('#flow-zoom .zoom-out').isDisabled(), true);

        await type('90', 'Tab');
        assert.equal((await now()).zoom, 0.9, 'leaving the field applies it');
        await level.click();
        await p.keyboard.type('120');
        await p.locator('.flowbar .flowsummary').click();
        assert.deepEqual(await now(), { zoom: 1.2, value: '120%', focused: false, selected: '', scale: 'scale(1.2)' }, 'so does pressing outside it');

        await (await screenBox(p, '/home#Home')).click();
        await level.click();
        await p.keyboard.type('80');
        await p.locator('#flow-zoom .zoom-in').click();
        assert.equal((await now()).value, '90%', 'pressing + right after typing applies both');
        await level.click();
        await p.keyboard.press('Escape');
        assert.deepEqual(await pickedBoxes(p), ['/home#Home'], 'Escape in the field keeps the picked screen');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, pressing a filter, a screen box, 「선택 해제」 or a row of the story list right after typing a percent does what it does and applies the percent', { skip: browserMissing }, async () => {
  await withPathStories({ walk: WALK }, async (p) => {
    const level = p.locator('#flow-zoom .zoom-level');
    const typed = async (text: string) => {
      await level.click();
      await p.keyboard.type(text);
    };
    const zoom = () => p.evaluate(() => [state.zoom, document.querySelector<HTMLInputElement>('#flow-zoom .zoom-level')!.value]);

    await typed('80');
    await filterButton(p, 'fail').click();
    assert.equal(await filterButton(p, 'fail').getAttribute('aria-pressed'), 'true', 'the filter is on');
    assert.deepEqual(await zoom(), [0.8, '80%']);

    await typed('70');
    await (await screenBox(p, '/home#Home')).click();
    assert.deepEqual(await pickedBoxes(p), ['/home#Home'], 'the screen is picked');
    assert.deepEqual(await zoom(), [0.7, '70%']);

    await typed('60');
    await p.locator('.flowbar .unpick').click();
    assert.deepEqual(await pickedBoxes(p), [], 'the screen is let go');
    assert.deepEqual(await zoom(), [0.6, '60%']);

    await typed('90');
    await storyRow(p, 'walk').click();
    assert.equal(await flowPlace(p), '#flow?story=walk', 'the story is picked');
    assert.deepEqual(await zoom(), [0.9, '90%']);
  });
});

test('in a browser, a percent left by a press that ends in a drag applies when the drag ends, and leaves nothing behind for the next press or Tab', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const level = p.locator('#flow-zoom .zoom-level');
        const zoom = () => p.evaluate(() => state.zoom);
        await level.focus();
        await p.keyboard.type('80');
        await p.evaluate(() => {
          const box = document.querySelector('#flow .box.screen')!;
          box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          document.querySelector<HTMLInputElement>('#flow-zoom .zoom-level')!.blur();
          box.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        });
        await p.waitForFunction(() => state.zoom === 0.8);

        await level.focus();
        await p.keyboard.press('Control+A');
        await p.keyboard.type('90');
        await p.keyboard.press('Tab');
        assert.equal(await zoom(), 0.9, 'Tab applies at once after the drag');
        await p.locator('#flow-zoom .zoom-in').click();
        assert.equal(await zoom(), 1, 'no earlier percent comes back after the next press');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the explanation in the flow bar is hidden on opening and an info button shows it on hover, on click and from the keyboard', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        const legend = p.locator('#flowlegend');
        assert.equal(await legend.count(), 1);
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');
        assert.equal(await info.getAttribute('aria-controls'), 'flowlegend');

        await info.hover();
        assert.equal(await legend.isVisible(), true);
        assert.match((await legend.textContent())!, /불러옴 N/);
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), false);

        await info.click();
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), true);
        assert.equal(await info.getAttribute('aria-expanded'), 'true');
        await info.click();
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');

        await info.focus();
        await p.keyboard.press('Enter');
        assert.equal(await legend.isVisible(), true);
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');
        await p.keyboard.press('Space');
        assert.equal(await legend.isVisible(), true);
        await p.keyboard.press('Space');
        assert.equal(await legend.isVisible(), false);

        await p.locator('.flowbar input.flow-search').focus();
        await p.keyboard.press('Tab');
        assert.equal(await info.evaluate((e) => e === document.activeElement), true, 'Tab reaches the info button');
        await p.keyboard.press('Enter');
        assert.equal(await legend.isVisible(), true);
        await p.locator('#flow-zoom .zoom-out').click();
        assert.equal(await legend.isVisible(), true, 'a redraw keeps the explanation open');
        await (await screenBox(p, '/lab#Lab')).click();
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false, 'Escape closes the explanation first');
        assert.deepEqual(await pickedBoxes(p), ['/lab#Lab'], 'and keeps the picked screen');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the explanation shows on hover after a keyboard close and never has a native tooltip', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        const legend = p.locator('#flowlegend');
        assert.equal(await info.getAttribute('title'), null);

        await p.mouse.move(600, 600);
        await info.focus();
        await p.keyboard.press('Enter');
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false);
        await info.hover();
        assert.equal(await legend.isVisible(), true, 'hover shows it after a keyboard close');
        assert.equal(await info.getAttribute('aria-expanded'), 'true', 'aria-expanded says what is displayed on hover');
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), false);
        assert.equal(await info.getAttribute('aria-expanded'), 'false');

        await p.keyboard.press('Enter');
        await p.keyboard.press('Enter');
        await info.hover();
        assert.equal(await legend.isVisible(), true, 'hover shows it after closing with Enter again');

        await info.click();
        assert.equal(await legend.isVisible(), true);
        await info.click();
        assert.equal(await legend.isVisible(), false, 'closing with the pointer on it keeps it closed');
        assert.equal(await info.getAttribute('aria-expanded'), 'false');
        await p.evaluate(() => { renderFlow(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
        assert.equal(await legend.isVisible(), false, 'a redraw keeps the close while the pointer stays on it');
        await p.mouse.move(600, 600);
        await info.hover();
        assert.equal(await legend.isVisible(), true);
      }, { view: 'flow' }),
    ),
  );
});

const inWindow = (p: Page, selector: string) => p.evaluate((sel) => {
  const r = document.querySelector(sel)!.getBoundingClientRect();
  return { left: r.left, right: r.right, width: document.documentElement.clientWidth };
}, selector);

test('in a browser, the explanation stays inside the window at a narrow window, also with a screen picked', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 800, height: 600 });
        await p.waitForSelector('#flow .box');
        for (const pick of [false, true]) {
          if (pick) await (await screenBox(p, '/home#Home')).click();
          await p.locator('.flowbar button.flowinfo-button').hover();
          const e = await inWindow(p, '#flowlegend');
          assert.ok(e.left >= 0, `left edge ${e.left}`);
          assert.ok(e.right <= e.width, `right edge ${e.right} within ${e.width}`);
          await p.mouse.move(400, 500);
        }
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, Escape closes the explanation only while the flow view is showing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        const legend = p.locator('#flowlegend');
        await info.click();
        await p.mouse.move(600, 600);
        assert.equal(await legend.isVisible(), true);
        await p.click('#view-list');
        await p.keyboard.press('Escape');
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.equal(await legend.isVisible(), true, 'Escape in the list view leaves it pinned');
        assert.equal(await info.getAttribute('aria-expanded'), 'true');

        await p.evaluate(() => document.addEventListener('keydown', (e) => e.preventDefault(), { once: true, capture: true }));
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), true, 'an Escape already handled elsewhere does not close it');
        await p.keyboard.press('Escape');
        assert.equal(await legend.isVisible(), false);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, pressing Escape after the review ended throws nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => {} });
    try {
      await withPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async (p) => {
        await p.waitForSelector('#flow .box');
        await (await screenBox(p, '/home#Home')).click();
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        await p.keyboard.press('Escape');
        await p.keyboard.press('Escape');
      }, { view: 'flow' });
    } finally {
      server.close();
    }
  });
});

test('in a browser, the legend and the info icon stand together at the right end of the bar, which spans the whole width above the drawing and the panes', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 800 });
        await p.waitForSelector('#flow .box');
        const info = p.locator('.flowbar button.flowinfo-button');
        assert.equal(await info.getAttribute('aria-label'), '흐름도 읽는 법');
        assert.match((await info.textContent())!.trim(), /^(i|ⓘ)$/, 'the only visible text is the icon glyph');
        for (const pick of [false, true]) {
          if (pick) await (await screenBox(p, '/home#Home')).click();
          const m = await p.evaluate(() => {
            const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
            const bar = rect('.flowbar');
            const main = rect('main');
            const icon = rect('.flowinfo-button');
            const key = [...document.querySelectorAll('.flowkey li')].map((li) => li.getBoundingClientRect());
            const sameRow = [...document.querySelectorAll('.flowbar button, .flowbar input')].map((e) => e.getBoundingClientRect()).filter((r) => r.top < icon.bottom && r.bottom > icon.top);
            return {
              bar: [bar.left, bar.right], main: [main.left, main.right], keyRight: Math.max(...key.map((r) => r.right)), iconLeft: icon.left, iconRight: icon.right,
              toBarEdge: bar.right - icon.right, iconLast: Math.max(...sameRow.map((r) => r.right)) === icon.right, zoomInBar: !!document.querySelector('.flowbar .zoom'),
              round: Math.abs(icon.width - icon.height) < 0.5 && icon.width <= 28, drawingTop: rect('#flow').top, barBottom: bar.bottom,
            };
          });
          assert.deepEqual(m.bar, m.main, 'the bar spans the whole width');
          assert.ok(m.keyRight <= m.iconLeft && m.iconLeft - m.keyRight <= 16, 'the legend sits just left of the icon');
          assert.ok(m.toBarEdge <= 20, `the icon is ${m.toBarEdge}px from the bar's right edge`);
          assert.ok(m.iconLast, 'nothing sits right of the icon');
          assert.equal(m.zoomInBar, false, 'the zoom buttons are not in the bar');
          assert.ok(m.round, 'a small round button');
          assert.ok(Math.abs(m.drawingTop - m.barBottom) <= 1, 'the drawing starts under the bar');
        }
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, scrolling the drawing sideways leaves the bar, its legend and the explanation in place and in view', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 700, height: 600 });
        await p.waitForSelector('#flow .box');
        await (await screenBox(p, '/home#Home')).click();
        const frames = () => p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        const edges = () => p.evaluate(() => {
          const rel = (r: DOMRect) => ({ left: r.left, right: r.right });
          return { width: document.documentElement.clientWidth, icon: rel(document.querySelector('.flowinfo-button')!.getBoundingClientRect()), legend: rel(document.getElementById('flowlegend')!.getBoundingClientRect()), key: [...document.querySelectorAll('.flowkey li')].map((li) => rel(li.getBoundingClientRect())) };
        });
        const before = await edges();
        const scrolled = await p.evaluate(() => {
          const flow = document.getElementById('flow')!;
          flow.scrollLeft = 200;
          return flow.scrollLeft;
        });
        assert.ok(scrolled > 0, 'the drawing scrolls sideways');
        await p.locator('.flowbar button.flowinfo-button').click();
        await p.mouse.move(350, 500);
        await frames();
        const after = await edges();
        assert.deepEqual(after.icon, before.icon);
        assert.deepEqual(after.key, before.key);
        assert.equal(after.key.length, 6);
        for (const r of [after.icon, after.legend, ...after.key]) assert.ok(r.left >= 0 && r.right <= after.width, `${r.left}..${r.right} within ${after.width}`);
      }, { view: 'flow' }),
    ),
  );
});

const travelDown = async (p: Page, info: Locator, legend: Locator, column: 'left' | 'center' | 'right' = 'center') => {
  await info.hover();
  assert.equal(await legend.isVisible(), true);
  const button = (await info.boundingBox())!;
  const text = (await legend.boundingBox())!;
  const x = button.x + { left: 0.5, center: button.width / 2, right: button.width - 0.5 }[column];
  const from = button.y + button.height / 2;
  const to = text.y + 20;
  assert.ok(to > from);
  for (let y = from; y <= to; y += 1) {
    await p.mouse.move(x, y);
    assert.equal(await legend.isVisible(), true, `the explanation is gone with the pointer at x=${x}, y=${y} (icon bottom ${button.y + button.height}, explanation top ${text.y})`);
  }
  assert.equal(await p.evaluate(() => document.getElementById('flowlegend')!.matches(':hover')), true, 'the pointer is on the explanation');
};

test('in a browser, the pointer can travel from the info icon down into the explanation without it disappearing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        for (const column of ['center', 'left', 'right'] as const) await travelDown(p, p.locator('.flowbar button.flowinfo-button'), p.locator('#flowlegend'), column);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the pointer can travel from the info icon into the explanation when the bar wraps onto several lines at a 500px window with a screen picked', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 500, height: 700 });
        await p.waitForSelector('#flow .box');
        await (await screenBox(p, '/home#Home')).click();
        await p.waitForSelector('.flowbar .picking');
        const rows = await p.evaluate(() => new Set([...document.querySelectorAll('.flowbar > *')].map((e) => Math.round(e.getBoundingClientRect().top))).size);
        assert.ok(rows >= 3, `the bar wraps onto ${rows} lines`);
        const info = p.locator('.flowbar button.flowinfo-button');
        await travelDown(p, info, p.locator('#flowlegend'));
        const e = await p.evaluate(() => {
          const legend = document.getElementById('flowlegend')!.getBoundingClientRect();
          const icon = document.querySelector('.flowinfo-button')!.getBoundingClientRect();
          return { width: document.documentElement.clientWidth, left: legend.left, right: legend.right, iconRight: icon.right, iconBottom: icon.bottom, legendTop: legend.top };
        });
        assert.ok(e.left >= 0 && e.right <= e.width, `legend ${e.left}..${e.right} within ${e.width}`);
        assert.ok(e.iconRight <= e.width, 'the icon is in view');
        assert.ok(e.legendTop >= e.iconBottom, 'the explanation opens under the icon');
      }, { view: 'flow' }),
    ),
  );
});

const KEY_LABELS = ['통과', '실패', '보류', '테스트 없음', '조건 걸린 링크', '설정에 적은 이동'];

test('in a browser, the flow bar always shows a legend of six samples next to the info icon', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 800 });
        await p.waitForSelector('#flow .box');
        const key = p.locator('.flowbar ul.flowkey');
        assert.equal(await key.isVisible(), true);
        assert.equal(await key.getAttribute('aria-label'), '흐름도 범례');
        assert.deepEqual(await key.locator('li .key-label').allTextContents(), KEY_LABELS);
        assert.equal(await key.locator('li [aria-hidden="true"]').count(), 6, 'every drawn sample is hidden from a screen reader');
        assert.deepEqual(await key.locator('li').evaluateAll((items) => items.map((li) => li.textContent.trim())), KEY_LABELS);
        const m = await p.evaluate(() => {
          const rect = (e: Element) => e.getBoundingClientRect();
          const items = [...document.querySelectorAll('.flowkey li')].map(rect);
          const icon = rect(document.querySelector('.flowinfo-button')!);
          return { right: Math.max(...items.map((r) => r.right)), tops: new Set(items.map((r) => Math.round(r.top + r.height / 2))).size, iconLeft: icon.left, legendShown: getComputedStyle(document.getElementById('flowlegend')!).display };
        });
        assert.ok(m.right <= m.iconLeft, `the legend ends at ${m.right}, left of the icon at ${m.iconLeft}`);
        assert.ok(m.iconLeft - m.right <= 16, 'the legend sits next to the icon');
        assert.equal(m.tops, 1, 'the six samples are on one line at 1440px');
        assert.equal(m.legendShown, 'none', 'the samples show without opening the explanation');
        const before = await p.evaluate(() => document.querySelector('.canvas')!.getBoundingClientRect().top);
        await p.locator('.flowbar button.flowinfo-button').click();
        assert.equal(await p.evaluate(() => document.querySelector('.canvas')!.getBoundingClientRect().top), before, 'opening the explanation does not move the diagram');
        assert.deepEqual(await key.locator('li .key-label').allTextContents(), KEY_LABELS);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, each legend sample is drawn with the square of the screens and the dash of the guarded links and of the moves it stands for', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const { pairs, dashes } = await p.evaluate(() => {
          const look = (e: Element) => { const c = getComputedStyle(e); return [c.backgroundColor, c.borderTopStyle, c.borderTopStyle === 'none' ? '' : c.borderTopColor, c.borderTopWidth, c.width].join(' '); };
          const out: Record<string, string[]> = {};
          for (const cls of ['s-pass', 's-fail', 's-pending', 's-none']) {
            const box = document.querySelector(`#flow .box.screen.${cls} .sq`);
            if (box) out[cls] = [look(document.querySelector(`.flowkey .sq.${cls}`)!), look(box)];
          }
          const canvas = document.querySelector('.canvas')!;
          const stroke = (e: Element) => { const c = getComputedStyle(e); return [c.stroke, c.strokeDasharray, c.strokeWidth].join(' '); };
          const dashes = [];
          for (const cls of ['guarded', 'moved']) {
            const edge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            edge.setAttribute('class', cls);
            canvas.querySelector('svg')!.append(edge);
            const sample = document.querySelector(`.flowkey svg path.${cls}`)!;
            out[cls] = [stroke(sample), stroke(edge)];
            dashes.push(...[sample, edge].map((e) => getComputedStyle(e).strokeDasharray));
            edge.remove();
          }
          return { pairs: out, dashes };
        });
        assert.deepEqual(Object.keys(pairs).sort(), ['guarded', 'moved', 's-fail', 's-none', 's-pass', 's-pending']);
        assert.notEqual(pairs.guarded[0], pairs.moved[0], 'a move is drawn apart from a guarded link');
        for (const [name, [sample, real]] of Object.entries(pairs)) assert.equal(sample, real, name);
        assert.equal(new Set(['s-pass', 's-fail', 's-pending', 's-none'].map((c) => pairs[c][0])).size, 4, 'the four samples differ');
        for (const dash of dashes) assert.match(dash, /^\d+(\.\d+)?(px)?,? \d+(\.\d+)?(px)?$/, `a dash of two lengths, not ${dash}`);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, the explanation behind the info icon shows each tag a screen can carry, the mark of a screen reached from another branch and the untagged tests, each under its sample', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 800 });
        await p.waitForSelector('#flow .box');
        await p.locator('.flowbar button.flowinfo-button').click();
        const legend = p.locator('#flowlegend');
        assert.equal(await legend.evaluate((e) => e.tagName), 'UL');
        assert.deepEqual(await legend.locator('li').evaluateAll((items) => items.map((li) => [...li.children].map((c) => c.textContent))), [
          ['/주소API 8', '이 화면에서 부르는 API 호출의 수. 화면을 누르면 오른쪽에 호출마다 테스트가 보입니다'],
          ['/주소역할/주소설정', '특정 역할이나 설정에서만 열리는 화면. 무엇이 필요한지는 마우스를 올리면 보입니다'],
          ['/주소', '고른 화면에서 다른 가지에 이미 그린 화면으로 가는 링크나 설정에 적은 이동이 닿는 화면'],
          ['불러옴 N · 지나감 N', '태그 없이 이 화면을 불러오는 단위 테스트와, 도는 동안 이 화면을 연 브라우저 테스트. 마우스를 올리면 보입니다상태 색과 테스트 수에는 넣지 않음'],
        ]);
        const look = (sel: string) => p.$eval(sel, (e) => { const c = getComputedStyle(e); return [c.borderTopStyle, c.borderTopColor, c.color, c.fontSize].join(' '); });
        assert.equal(await look('#flowlegend .tag.api'), await look('#flow .box.screen .tag.api'));
        assert.equal(await look('#flowlegend .tag.need'), await look('#flow .box.screen .tag.need'));
        assert.equal(await legend.locator('.box.jump').count(), 1);
        const box = await p.evaluate(() => {
          const e = document.getElementById('flowlegend')!;
          const r = e.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, window: document.documentElement.clientWidth, overflowing: [...e.querySelectorAll('li')].filter((li) => li.scrollWidth > li.clientWidth).length };
        });
        assert.ok(box.width <= 320, `the explanation is ${box.width}px wide`);
        assert.ok(box.left >= 0 && box.right <= box.window, `explanation ${box.left}..${box.right} within ${box.window}`);
        assert.equal(box.overflowing, 0, 'nothing in the explanation is cut off');
        const rows = await legend.locator('li').evaluateAll((items) => items.map((li) => {
          const [sample, text] = [...li.children].map((c) => c.getBoundingClientRect());
          return { below: text.top >= sample.bottom - 1, text: Math.round(text.width), row: Math.round(li.getBoundingClientRect().width) };
        }));
        for (const r of rows) {
          assert.ok(r.below, 'the description sits under its sample');
          assert.equal(r.text, r.row, 'the description takes the whole width, however long the sample is');
        }
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, at a 500px window the bar with its legend stays within the window, no legend label is split inside a word and the explanation is in view', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 500, height: 700 });
        await p.waitForSelector('#flow .box');
        await p.locator('.flowbar button.flowinfo-button').click();
        const m = await p.evaluate(() => {
          const bar = document.querySelector('.flowbar')!;
          const rel = (e: Element) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
          return {
            width: document.documentElement.clientWidth, barScroll: bar.scrollWidth, barClient: bar.clientWidth,
            labels: [...document.querySelectorAll('.flowkey .key-label')].map((e) => [e.textContent, e.getClientRects().length]),
            items: [...document.querySelectorAll('.flowkey li, .flowbar button, .flowbar input')].map(rel), legend: rel(document.getElementById('flowlegend')!),
          };
        });
        assert.ok(m.barScroll <= m.barClient, `the bar's content is ${m.barScroll}px wide in a ${m.barClient}px bar`);
        assert.deepEqual(m.labels.map(([label]) => label), KEY_LABELS);
        for (const [label, rects] of m.labels) assert.equal(rects, 1, `「${label}」 is on one line`);
        for (const r of [...m.items, m.legend]) assert.ok(r.left >= 0 && r.right <= m.width, `${r.left}..${r.right} within ${m.width}`);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, flow boxes stand in columns by how many links they are from an entry screen, each column as wide as its boxes need and the same for all of them, with no two boxes overlapping', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const boxes = await flowBoxes(p);
        const byId = Object.fromEntries(boxes.map((b) => [b.id, b]));
        const columns = new Map<number, typeof boxes>();
        for (const b of boxes) columns.set(b.left, [...(columns.get(b.left) ?? []), b]);
        for (const [left, column] of columns) assert.equal(new Set(column.map((b) => b.width)).size, 1, `the boxes at ${left} share one width`);
        assert.equal(byId['/home#Home'].left, byId['/help#Help'].left);
        assert.equal(byId['/lab#Lab'].left, byId['/admin/report#AdminReport'].left);
        assert.ok(byId['/lab/result#LabResult'].left > byId['/lab#Lab'].right);
        assert.ok(byId['/signin#SignIn'].width < byId['/help#Help'].width, 'the entry column is narrower than the column holding the long route');
        assert.deepEqual(overlapping(boxes), []);
      }, { view: 'flow', setup: changeData(withLongRoute) }),
    ),
  );
});

test('in a browser, entry screens with nothing drawn under them are gathered under 「딸린 화면이 없는 진입 화면 N」 below the branching ones, its hover saying why, in several columns, each box showing what any box shows', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        assert.equal(await p.textContent('#flow .group-head'), '딸린 화면이 없는 진입 화면 8');
        assert.match((await p.getAttribute('#flow .group-head', 'title'))!, /^밑으로 이어 그린 화면이 없는 진입 화면입니다\./);
        const boxes = await flowBoxes(p);
        const grouped = boxes.filter((b) => b.grouped);
        assert.deepEqual(grouped.map((b) => b.id).sort(), Array.from({ length: 8 }, (_, i) => `/extra/${i}#Extra${i}`).sort());
        const head = await p.$eval('#flow .group-head', (e) => e.getBoundingClientRect().toJSON());
        const tree = boxes.filter((b) => !b.grouped);
        assert.ok(tree.some((b) => b.id === '/signin#SignIn'));
        assert.ok(tree.every((b) => b.bottom <= head.top), 'the branching entry screens come first');
        assert.ok(grouped.every((b) => b.top >= head.bottom), 'the gathered boxes sit under the heading');
        assert.ok(new Set(grouped.map((b) => b.left)).size > 1, 'the gathered boxes stand in more than one column');
        assert.deepEqual(overlapping(boxes), []);

        const failing = await screenBox(p, '/extra/7#Extra7');
        assert.match((await failing.getAttribute('class'))!, /s-fail/);
        assert.equal(await statusLine(failing), '실패 · 불러옴 2');
        assert.deepEqual(await needTag(await screenBox(p, '/extra/3#Extra3')), ['역할']);
        await failing.click();
        assert.deepEqual(await pickedBoxes(p), ['/extra/7#Extra7']);
        assert.equal((await boxesWith(p, 'dim')).length, (await boxCount(p)) - 1, 'a gathered screen has no paths, so every other screen dims');
        assert.equal(await p.textContent('#flow .group-head'), '딸린 화면이 없는 진입 화면 8');
        assert.deepEqual(overlapping(await flowBoxes(p)), []);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        assert.equal(await p.textContent('#flow .group-head'), '딸린 화면이 없는 진입 화면 3');
        const first = await p.$$eval('#flow .canvas', ([canvas]) => [...canvas.querySelectorAll('.box.screen')].map((e) => e.classList.contains('grouped')));
        assert.deepEqual(first, [true, true, true]);
      }, { view: 'flow', setup: changeData((data) => {
        const extras = leafEntries(data, 3);
        data.flow = { ...data.flow, unreached: [...data.flow.roots, ...data.flow.unreached], roots: extras };
      }) }),
    ),
  );
});

test('in a browser, the gathered entry screens take fewer columns once the window gets narrower', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const columns = () => p.$$eval('#flow .box.screen.grouped', (els: HTMLElement[]) => new Set(els.map((e) => e.offsetLeft)).size);
        const wide = await columns();
        assert.ok(wide > 1);
        await p.setViewportSize({ width: 700, height: 900 });
        await p.waitForFunction((n) => new Set([...document.querySelectorAll<HTMLElement>('#flow .box.screen.grouped')].map((e) => e.offsetLeft)).size < n, wide);
        assert.equal(await p.locator('#flow .box.screen.grouped').count(), 8);
        assert.deepEqual(overlapping(await flowBoxes(p)), []);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
});

test('in a browser, redrawing the flow keeps the place the reviewer scrolled to, and picking a screen already in view does not scroll', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.setViewportSize({ width: 1440, height: 300 });
        await p.waitForSelector('#flow .group-head');
        const scrolled = await p.evaluate(() => {
          const flow = document.getElementById('flow')!;
          flow.scrollTop = 200;
          return flow.scrollTop;
        });
        assert.equal(scrolled, 200);
        await p.evaluate(() => renderFlow());
        assert.equal(await p.evaluate(() => document.getElementById('flow')!.scrollTop), 200);
        const visible = await p.$$eval('#flow .box.screen', (els: HTMLElement[]) => {
          const view = document.getElementById('flow')!.getBoundingClientRect();
          return els.find((e) => { const r = e.getBoundingClientRect(); return r.top > view.top + 20 && r.bottom < view.bottom - 20 && r.left > view.left && r.right < view.left + view.width / 2; })!.dataset.key!;
        });
        await (await screenBox(p, visible)).click();
        assert.equal(await p.evaluate(() => document.getElementById('flow')!.scrollTop), 200);
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    ),
  );
});

test('in a browser, the flow layout is worked out from the trees and the box sizes alone, the same every time, and each box\'s width from the widths alone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        const [first, second, columns] = await p.evaluate(() => {
          const screen = (id: string, children: object[] = []) => ({ kind: 'screen', id, children, calls: [], guards: [] });
          const roots = [screen('A', [screen('B'), screen('C')]), screen('D'), screen('E')];
          const sizes = { A: { width: 100, height: 40 }, B: { width: 120, height: 30 }, C: { width: 80, height: 50 }, D: { width: 90, height: 30 }, E: { width: 70, height: 20 } };
          const view = { group: true, width: 300 };
          state.flowPicked = true;
          state.zoom = 0.5;
          const { widths, grouped } = flowColumns(roots, sizes, view);
          return [layoutFlow(roots, sizes, view), layoutFlow(roots, sizes, view), { widths, grouped: [...grouped] }];
        });
        assert.deepEqual(first, second);
        assert.deepEqual(columns, { widths: { A: 100, B: 120, C: 120, D: 90, E: 90 }, grouped: ['D', 'E'] });
        const boxes = Object.fromEntries(first.boxes.map(({ key, ...b }) => [key, b]));
        assert.deepEqual(boxes, {
          A: { x: 0, y: 19, width: 100, height: 40, grouped: false },
          B: { x: 150, y: 0, width: 120, height: 30, grouped: false },
          C: { x: 150, y: 38, width: 120, height: 50, grouped: false },
          D: { x: 0, y: 148, width: 90, height: 30, grouped: true },
          E: { x: 114, y: 148, width: 90, height: 20, grouped: true },
        });
        const edges = Object.fromEntries(first.edges.map(({ from, to, ...e }) => [`${from} ${to}`, e]));
        assert.deepEqual(edges, {
          'A B': { x1: 100, y1: 39, x2: 150, y2: 15, guards: [] },
          'A C': { x1: 100, y1: 39, x2: 150, y2: 63, guards: [] },
        });
        assert.deepEqual(first.group, { x: 0, y: 120, height: 28, count: 2 });
        assert.equal(first.width, 270);
        assert.equal(first.height, 186);
      }, { view: 'flow' }),
    ),
  );
});

const WALK = ['/signin#SignIn', '/home#Home', '/document/:tab_draft_done_#DocumentList', '/document/:id#DocumentDetail', '/help#Help', '/lab#Lab', '/lab/result#LabResult', '/settings#Settings'];
const WALK_ON_MAP = WALK.slice(0, 7);

async function withPathStories(stories: Record<string, string[]>, fn: (p: Page, ctx: { base: string; errors: string[]; writeStory: (id: string, screens: string[]) => void; storyFile: (id: string) => string }) => Promise<void>, edits: [string, string, string][] = []) {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config, copy) => {
    const storyFile = (id: string) => path.join(copy, 'example-stories', `${id}.json`);
    const writeStory = (id: string, screens: string[]) => fs.writeFileSync(storyFile(id), JSON.stringify({ name: `${id} 이야기`, screens, author: 'reviewer', date: '2026-10-05' }));
    for (const [id, screens] of Object.entries(stories)) writeStory(id, screens);
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#flow .box.screen');
        await fn(p, { base, errors, writeStory, storyFile });
      }, { view: 'flow' }));
  }, edits);
}

const flowPlace = (p: Page) => p.evaluate(() => decodeURIComponent(location.hash));
const storyRow = (p: Page, id: string) => p.locator(`#flow-story-list li[data-story="${id}"]`);
const pickPathStory = async (p: Page, id: string) => {
  await storyRow(p, id).click();
  await p.waitForFunction((id) => state.storyPath?.id === id, id);
};
const HOME_TARGETS = ['/document/:tab(draft|done)', '/document/:id', '/admin/member', '/admin/group', '/lab', '/admin/audit', '/admin/report'];
const HOME_GOES_TO = `2 → 3 단계: /home 에서 /help 로 가는 링크가 맵에 없습니다. /home 에서 갈 수 있는 화면: ${HOME_TARGETS.join(', ')}`;
const drawnScreens = (p: Page) => p.$$eval('#flow .box.screen', (els) => [...new Set(els.map((e) => e.dataset.key))].sort());
const lineSteps = (p: Page) => p.$$eval('#flow .story-line [data-step]', (els: HTMLElement[]) => els.map((e) => [e.querySelector('.story-badge')!.textContent, e.dataset.screen]));
const lineHops = (p: Page) => p.$$eval('#flow .story-line .story-hop', (els) => els.map((e) => [e.querySelector('path')!.getAttribute('class'), e.textContent]));
const hopLook = (p: Page, i: number) => p.$eval(`#flow .story-hop[data-hop="${i}"] path`, (e) => { const c = getComputedStyle(e); return [c.stroke, c.strokeWidth, c.strokeDasharray]; });
const cssColor = (p: Page, name: string) => p.evaluate((name) => getComputedStyle(document.body).getPropertyValue(name).trim(), name);
const pathMarks = (p: Page, cls: string) => p.$$eval(`#flow .canvas > .${cls}`, (els) => els.map((e) => [e.dataset.at, e.textContent, ...[...e.classList].filter((c) => /^l-/.test(c))]));
const pillMarks = (p: Page, cls: string) => p.$$eval(`#flow .box.screen .${cls}`, (els) => els.map((e) => [e.closest<HTMLElement>('.box')!.dataset.key, e.textContent, ...[...e.classList].filter((c) => /^(l-.*|exit|entry)$/.test(c))]));
const pathEdges = (p: Page) => p.$$eval('#flow .canvas svg path.story-edge', (els) => els.map((e) => [e.dataset.from, e.dataset.to, [...e.classList].find((c) => c.startsWith('l-'))]).sort());
const ringed = (p: Page) => p.$$eval('#flow .box.story-ring', (els: HTMLElement[]) => els.map((e) => [e.dataset.step, e.dataset.screen]));
const ringBadge = (p: Page) => p.$$eval('#flow .story-line .story-ring .story-badge', (els) => els.map((e) => e.textContent));
const inView = (p: Page, key: string) => p.evaluate((k) => {
  const flow = document.getElementById('flow')!;
  const r = flow.querySelector(`.box.screen[data-key="${CSS.escape(k)}"]`)!.getBoundingClientRect();
  const view = flow.getBoundingClientRect();
  return r.top >= view.top && r.bottom <= view.bottom && r.left >= view.left && r.right <= view.right;
}, key);
const drawOverlay = (p: Page, id: string) => p.evaluate((id) => {
  const st = pathStories().find((s) => s.id === id)!;
  const path = storyTrees(state.data.flow, st);
  const flow = document.getElementById('flow')!;
  const c = canvas(path.roots, { story: { st, hidden: path.hidden } });
  flow.replaceChildren(c.el);
  c.measureWidths();
  c.fit(flowInnerWidth(flow));
  c.measureHeights();
  c.place();
}, id);

test('in a browser, the flow lays out a story\'s link tags just before the box their line enters and keeps room under a box for its hidden-screen count', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box');
        assert.equal(await p.locator('#flow-stories').isVisible(), false, 'no story list without stories');
        const out = await p.evaluate(() => {
          const screen = (id: string, children: object[] = []) => ({ kind: 'screen', id, children, calls: [], guards: [] });
          const roots = [screen('A', [screen('B'), screen('C', [screen('D')])])];
          const sizes = { A: { width: 100, height: 40 }, B: { width: 120, height: 50 }, C: { width: 80, height: 30 }, D: { width: 90, height: 30 } };
          const marks = [
            { key: 'A', kind: 'hidden', width: 80, height: 16 },
            { key: 'C', kind: 'tag', width: 30, height: 18 },
          ];
          const view = { marks };
          const cols = flowColumns(roots, sizes, view);
          return { plain: flowColumns(roots, sizes, {}).xs, xs: cols.xs, layout: layoutFlow(roots, sizes, view, cols) };
        });
        assert.deepEqual(out.plain, [0, 150, 320]);
        assert.deepEqual(out.xs, [0, 100 + 32 + 44, 176 + 120 + 50]);
        const box = Object.fromEntries(out.layout.boxes.map((b) => [b.key, b]));
        const [hidden, tag] = out.layout.marks!;
        assert.deepEqual(hidden, { x: 8, y: box.A.y + 40 + 6 });
        assert.equal(tag.y, box.C.y + 15 - 9, 'the tag sits on the line into its box');
        assert.equal(tag.x, 176 - 10 - 30);
        const toB = out.layout.edges.find((e) => e.to === 'B')!;
        assert.equal(toB.nx, 176 - 44, 'the line bends before the tags of the column it enters');
        assert.ok(out.layout.height >= hidden.y + 16, 'the canvas is tall enough for the hidden-screen count');
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a story picked from the list on the left of the flow is drawn as its steps in order on one line with only its own screens, counts and lists only those, and the same row again or 「경로 끄기」 brings back the flow as it was', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    const stories = await p.evaluate(() => state.data.stories.list.map((st: Story) => [st.id, st.name]));
    assert.equal(await p.locator('.flowbar select').count(), 0, 'the bar above the flow has no story select');
    assert.equal(await p.textContent('#stories-tab'), `스토리 ${stories.length} ◀`);
    assert.deepEqual(await p.$$eval('#flow-story-list li', (els: HTMLElement[]) => els.map((e) => [e.dataset.story, e.querySelector('.name > span')!.textContent])), stories);
    assert.deepEqual(await p.$$eval('#flow-story-list li', (els) => els.map((e) => [...e.querySelectorAll('.chips .chip')].map((c) => c.textContent))), await p.evaluate(() => {
      const list: Story[] = state.data.stories.list;
      return list.map((st) => [st.status === 'pass' ? null : STORY_STATUS[st.status].label, st.broken ? '링크 없음' : null, st.detached ? '화면 없음' : null, st.unjudged ? '판정 못 함' : null].filter(Boolean));
    }), 'a row carries the status and verdict chips of the stories tab');
    const flowBox = await p.locator('#flow').boundingBox();
    const listBox = await p.locator('#flow-stories').boundingBox();
    assert.ok(listBox!.x + listBox!.width <= flowBox!.x + 1, 'the list sits left of the drawing');
    const before = await drawnScreens(p);
    await p.setViewportSize({ width: 1440, height: 400 });
    await p.evaluate(() => Object.assign(document.getElementById('flow')!, { scrollTop: 120 }));
    const scrolled = await p.evaluate(() => document.getElementById('flow')!.scrollTop);
    assert.ok(scrolled > 0, 'the flow was scrolled');

    await pickPathStory(p, 'walk-around');
    assert.equal(await flowPlace(p), '#flow?story=walk-around');
    assert.deepEqual(await p.$$eval('#flow-story-list li.selected', (els: HTMLElement[]) => els.map((e) => e.dataset.story)), ['walk-around']);
    assert.deepEqual(await lineSteps(p), WALK.map((id, i) => [String(i + 1), id]));
    assert.deepEqual(await drawnScreens(p), [...WALK_ON_MAP].sort());
    const middles = await p.$$eval('#flow .story-line [data-step]', (els) => new Set(els.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })).size);
    assert.equal(middles, 1, 'the steps sit on one line');
    const lefts = await p.$$eval('#flow .story-line [data-step]', (els) => els.map((e) => e.getBoundingClientRect().left));
    assert.deepEqual(lefts, [...lefts].sort((a, b) => a - b), 'the steps go from left to right in order');
    assert.equal(await p.locator('#flow .story-line .box.story-off').count(), 1);
    assert.match((await p.textContent('#flow .story-line .box.story-off'))!, /\/settings#Settings.*맵에 없는 화면/);
    assert.equal(await p.textContent('.flowbar .flowsummary'), '테스트 있는 화면 6/7');
    assert.equal(await filterButton(p, 'all').textContent(), '전체 7');
    assert.equal(await p.textContent('#gaps h2'), '빈틈 5');
    assert.match((await p.textContent('#gaps .lead'))!, /이 스토리의 경로/);
    assert.deepEqual(await textOutside(p), []);
    assert.equal(await p.locator('#flow-bar .story-on').count(), 0);
    assert.equal(await p.locator('#flow-head .story-on').count(), 1, 'the picked story is named in the corner of the drawing, not in the bar');

    await storyRow(p, 'walk-around').click();
    assert.equal(await flowPlace(p), '#flow');
    assert.deepEqual(await drawnScreens(p), before);
    assert.equal(await p.locator('#flow-head .story-on, #flow .story-line, #flow .mark, #flow .box.on-story, #flow .story-badge, #flow-story-list li.selected').count(), 0);
    assert.equal(await p.evaluate(() => document.getElementById('flow')!.scrollTop), scrolled, 'the flow comes back where it was scrolled to');

    await pickPathStory(p, 'run-lab');
    assert.deepEqual(await lineSteps(p), [['1', '/home#Home'], ['2', '/lab#Lab'], ['3', '/lab/result#LabResult']]);
    assert.deepEqual(await drawnScreens(p), ['/home#Home', '/lab#Lab', '/lab/result#LabResult'], 'a screen above a step in the flow is not drawn');
    await flowButton(p, '경로 끄기').click();
    assert.equal(await flowPlace(p), '#flow');
    assert.deepEqual(await drawnScreens(p), before);
  });
});

test('in a browser, every two neighbouring steps of a picked story are joined by a line in the style of their verdict, a missing link says where the screen before goes, and a screen visited twice is drawn at each of its steps', { skip: browserMissing }, async () => {
  const stories = { 'walk-around': WALK, twice: ['/signin#SignIn', '/home#Home', '/help#Help', '/home#Home'] };
  await withPathStories(stories, async (p) => {
    await pickPathStory(p, 'walk-around');
    assert.deepEqual(await lineHops(p), [
      ['story-edge l-open', ''], ['story-edge l-open', ''], ['story-edge l-open', ''], ['story-edge l-conditioned', '조건'],
      ['story-edge l-broken', '링크 없음'], ['story-edge l-open', ''], ['story-edge l-off-map', '맵에 없는 화면'],
    ]);
    assert.deepEqual(await hopLook(p, 0), [await cssColor(p, '--text').then(rgb), '3.2px', 'none']);
    assert.deepEqual(await hopLook(p, 3), [await cssColor(p, '--accent').then(rgb), '3.2px', '8px, 5px']);
    assert.deepEqual((await hopLook(p, 4)).slice(0, 2), [await cssColor(p, '--fail').then(rgb), '3.2px']);
    assert.equal(await p.getAttribute('#flow .story-hop[data-hop="4"]', 'title'), '단계 5 → 6 · 링크 없음');
    assert.deepEqual(await p.locator('#flow .story-gaps li').allTextContents(), ['5 → 6 단계: /help 에서 /lab 로 가는 링크가 맵에 없습니다. /help 에서 갈 수 있는 화면이 없습니다.']);

    await pickPathStory(p, 'help-from-home');
    assert.deepEqual(await lineHops(p), [['story-edge l-open', ''], ['story-edge l-broken', '링크 없음']]);
    assert.deepEqual(await p.locator('#flow .story-gaps li').allTextContents(), [HOME_GOES_TO]);
    assert.deepEqual(await p.locator('#flow .story-gaps li .goes-to code').allTextContents(), HOME_TARGETS);

    await pickPathStory(p, 'twice');
    assert.deepEqual(await lineSteps(p), stories.twice.map((id, i) => [String(i + 1), id]));
    assert.equal(await p.locator('#flow .story-hop').count(), 3);
    await p.locator('#flow .story-line .box.screen[data-step="3"]').click();
    assert.deepEqual(await ringBadge(p), ['4'], 'a box rings its own step');
    assert.deepEqual(await ringed(p), [['3', '/home#Home']]);
    assert.equal(await p.textContent('#center h3'), '/home');
    await p.locator('#flow .story-line .box.screen[data-step="1"]').click();
    assert.deepEqual(await ringed(p), [['1', '/home#Home']]);
    assert.deepEqual(await ringBadge(p), ['2']);
    const row = (await p.locator('#flow .story-row').boundingBox())!;
    const flow = (await p.locator('#flow').boundingBox())!;
    await p.mouse.click(Math.max(row.x, flow.x) + 20, row.y + row.height - 4);
    assert.deepEqual(await pickedBoxes(p), [], 'a click on an empty spot of the line lets the screen go');
  });
});

test('in a browser, two steps of a picked story that a move in the config joins are drawn with a green dotted line, like the legend\'s 「설정에 적은 이동」, with the reason on hover', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories', moves: [{ from: '/signin', to: '/lab/result', reason: '로그인 뒤' }] }, (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories/signin-lab.json'), JSON.stringify({ name: '로그인해서 실험 결과를 본다', screens: ['/signin#SignIn', '/lab/result#LabResult'], author: 'a', date: '2026-10-03' }));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        await pickPathStory(p, 'signin-lab');
        assert.deepEqual(await lineHops(p), [['story-edge l-configured moved', '설정에 적은 이동']]);
        const [stroke, width, dashes] = await hopLook(p, 0);
        assert.deepEqual([stroke, width, dashes], [await cssColor(p, '--fine').then(rgb), '3.2px', '3px, 3px']);
        assert.equal(await p.$eval('#flow .story-hop[data-hop="0"] path', (e) => getComputedStyle(e).strokeLinecap), 'butt', 'the dots stay apart on the thick line');
        assert.equal(await p.getAttribute('#flow .story-hop[data-hop="0"]', 'title'), '단계 1 → 2 · 설정에 적은 이동 · 설정의 moves 에 적은 이동으로 이어집니다 · 로그인 뒤');
        assert.equal(await p.locator('#flow .story-gaps').count(), 0);

        await p.locator('#flow-head button.pathinfo-button').click();
        const sample = p.locator('#pathlegend li', { hasText: '설정에 적은 이동' }).locator('path');
        assert.deepEqual(await sample.evaluate((e) => { const c = getComputedStyle(e); return [c.stroke, c.strokeDasharray]; }), [stroke, dashes]);
      }, { view: 'flow' }));
  });
});

test('in a browser, the story list of the flow finds stories by name or ID and filters them like the stories tab, sharing both with it, and keeps its search box while typing', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    const ids = () => p.$$eval('#flow-story-list li[data-story]', (els: HTMLElement[]) => els.map((e) => e.dataset.story));
    const search = p.locator('#flow-stories input[type=search]');
    assert.equal(await search.getAttribute('placeholder'), '이름이나 ID 로 찾기');
    assert.deepEqual(await p.locator('#flow-stories fieldset').evaluateAll((els) => els.map((e) => [...e.querySelectorAll('label')].map((l) => l.textContent))),
      [['테스트 없음', '일부 화면만 테스트', '실패'], ['링크 없음']]);
    await search.click();
    await p.keyboard.type('홈에서');
    assert.deepEqual(await ids(), ['change-settings', 'help-from-home']);
    assert.equal(await p.evaluate(() => document.activeElement === document.querySelector('#flow-stories input[type=search]')), true, 'the box keeps the focus while typing');
    await search.fill('WALK');
    assert.deepEqual(await ids(), ['walk-around'], 'an ID is found too, whatever the case');
    await search.fill('');
    await p.check('#flow-stories input[name=broken]');
    assert.deepEqual(await ids(), await p.evaluate(() => state.data.stories.list.filter((st: Story) => st.broken).map((st: Story) => st.id)));
    await search.fill('없는 이름');
    assert.equal(await p.textContent('#flow-story-list li.muted'), '해당하는 스토리가 없습니다.');
    await search.fill('홈에서');
    assert.deepEqual(await ids(), ['help-from-home']);

    await p.click('#view-list');
    await p.click('#left .views.side button:has-text("스토리")');
    assert.equal(await p.inputValue('#left .filters input[type=search]'), '홈에서');
    assert.equal(await p.isChecked('#left input[name=broken]'), true);
    assert.deepEqual(await p.locator('#story-list li .name .mono').allTextContents(), ['help-from-home']);
    await p.uncheck('#left input[name=broken]');
    assert.deepEqual(await p.locator('#story-list li .name .mono').allTextContents(), ['change-settings', 'help-from-home']);
    await p.locator('#left .filters input[type=search]').click();
    await p.keyboard.press('End');
    await p.keyboard.type(' 바로');
    assert.deepEqual(await p.locator('#story-list li .name .mono').allTextContents(), ['help-from-home']);
    assert.equal(await p.evaluate(() => document.activeElement === document.querySelector('#left .filters input[type=search]')), true);
    await p.fill('#left .filters input[type=search]', 'run-');
    assert.deepEqual(await p.locator('#story-list li .name .mono').allTextContents(), ['run-lab']);

    await p.click('#view-flow');
    assert.equal(await search.inputValue(), 'run-');
    assert.deepEqual(await ids(), ['run-lab']);
  });
});

test('in a browser, the story list of the flow slides shut and open from a button in the top corner of the drawing that rides its edge and covers no box, without changing the picked story\'s drawing, its edge is dragged like the other panes, and its width and fold last until the page is loaded again', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    const ids = ['flow-stories', 'flow', 'gaps'];
    assert.deepEqual(await paneWidths(p, ids), [300, 1440 - 300 - 360, 360]);
    const fold = p.locator('#stories-tab');
    const toggle = async () => {
      await fold.click();
      assert.equal(await p.locator('main').evaluate((m) => m.classList.contains('sliding')), true, 'the list slides');
      await p.waitForFunction(() => !document.querySelector('main')!.classList.contains('sliding'));
    };
    await pickPathStory(p, 'walk-around');
    const steps = await lineSteps(p);
    const tabPlace = () => p.evaluate(() => {
      const tab = document.getElementById('stories-tab')!.getBoundingClientRect();
      const flow = document.getElementById('flow')!.getBoundingClientRect();
      const first = document.querySelector('#flow .box')!.getBoundingClientRect();
      return { left: Math.round(tab.left - flow.left), clear: tab.bottom <= first.top };
    });
    const count = await p.evaluate(() => pathStories().length);
    assert.equal(await fold.textContent(), `스토리 ${count} ◀`);
    assert.equal(await fold.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await tabPlace(), { left: 16, clear: true });
    await toggle();
    assert.equal(await fold.textContent(), `스토리 ${count} ▶`);
    assert.equal(await fold.getAttribute('aria-expanded'), 'false');
    assert.equal(await fold.getAttribute('title'), '스토리 목록 펴기');
    assert.equal(await fold.evaluate((e) => e === document.activeElement), true);
    assert.deepEqual(await paneWidths(p, ids), [0, 1440 - 360, 360], 'a folded list leaves no column');
    assert.equal(await p.locator('#flow-story-list').isVisible(), false);
    assert.deepEqual(await tabPlace(), { left: 16, clear: true }, 'the button moves with the edge of the drawing');
    assert.equal(await p.locator('#sash-stories').isVisible(), false, 'a folded list has no edge to drag');
    assert.deepEqual(await lineSteps(p), steps);
    assert.equal(await flowPlace(p), '#flow?story=walk-around');
    await toggle();
    assert.deepEqual(await paneWidths(p, ids), [300, 1440 - 300 - 360, 360]);

    await dragEdge(p, 'sash-stories', 100);
    assert.deepEqual(await paneWidths(p, ids), [400, 1440 - 400 - 360, 360], 'the list edge moves with the mouse');
    await dragEdge(p, 'sash-stories', -500);
    assert.equal((await paneWidths(p, ids))[0], 240, 'the list stops at its minimum');
    await dragEdge(p, 'sash-stories', 60);
    await toggle();
    await toggle();
    assert.equal((await paneWidths(p, ids))[0], 300, 'the width stays across a fold');

    await (await screenBox(p, '/home#Home')).click();
    const picked = ['flow-stories', 'flow', 'center', 'right'];
    const graph = (1440 - 300 - 360) / 2;
    assert.deepEqual(await paneWidths(p, picked), [300, graph, 1440 - 300 - 360 - graph, 360]);
    await dragEdge(p, 'sash-left', -100, { off: -3 });
    assert.deepEqual(await paneWidths(p, picked), [300, graph - 100, 1440 - 300 - 360 - graph + 100, 360], 'the drawing edge moves beside the list');
    await dragEdge(p, 'sash-stories', 40);
    assert.deepEqual(await paneWidths(p, picked), [340, graph - 100, 1440 - 340 - 360 - graph + 100, 360], 'widening the list takes from the middle pane');

    await fold.click();
    await p.reload();
    await p.waitForSelector('#flow .story-line');
    assert.equal(await fold.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await paneWidths(p, picked), [300, graph, 1440 - 300 - 360 - graph, 360], 'loading the page again starts from the first widths');
    await p.setViewportSize({ width: 600, height: 900 });
    await nextFrame(p);
    assert.equal(new Set(await p.$$eval('#flow-stories, #flow, #center, #right', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))).size, 1, 'a narrow window keeps the panes side by side');
  });
});

test('in a browser, once the story list has slid shut or open, the gathered entry screens of the flow are laid out again for the width the drawing ends at, and a box brought into view lands below the button in the corner', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, async (config, copy) => {
    fs.writeFileSync(path.join(copy, 'example-stories', 'walk-around.json'), JSON.stringify({ name: 'walk-around 이야기', screens: WALK, author: 'reviewer', date: '2026-10-05' }));
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .group-head');
        const perRow = () => p.evaluate(() => drawnGrid!.per);
        const fits = () => p.evaluate(() => cellsPerRow(drawnGrid!.count, drawnGrid!.cellW, flowInnerWidth(document.getElementById('flow')!) / state.zoom));
        const open = await perRow();
        for (const way of ['shut', 'open']) {
          await p.click('#stories-tab');
          await p.waitForFunction(() => !document.querySelector('main')!.classList.contains('sliding'));
          assert.equal(await perRow(), await fits(), `slid ${way}`);
        }
        assert.equal(await perRow(), open);

        await p.evaluate(() => {
          document.getElementById('stories-tab')!.click();
          document.querySelector<HTMLElement>('#flow .box.screen[data-key="/home#Home"]')!.click();
        });
        await p.waitForFunction(() => !document.querySelector('main')!.classList.contains('sliding'), null, { timeout: 2000 });
        assert.equal(await perRow(), await fits(), 'a box picked while the list slides, which cuts the slide short, still ends it');
        await flowButton(p, '선택 해제').click();
        await p.click('#stories-tab');
        await p.waitForFunction(() => !document.querySelector('main')!.classList.contains('sliding'));

        await p.setViewportSize({ width: 1440, height: 400 });
        await p.evaluate(() => { const f = document.getElementById('flow')!; f.scrollTop = f.scrollHeight; });
        const key = await p.$eval('#flow .box.screen', (e: HTMLElement) => e.dataset.key!);
        await p.evaluate((k) => showBox(k), key);
        assert.equal(await p.evaluate((k) => {
          const box = document.querySelector(`#flow .box.screen[data-key="${CSS.escape(k)}"]`)!.getBoundingClientRect();
          return box.top >= document.getElementById('flow-head')!.getBoundingClientRect().bottom;
        }, key), true, 'a box brought into view lands below the button and the story name, not under them');
      }, { view: 'flow', setup: changeData((data) => { data.flow.roots.push(...leafEntries(data, 8)); }) }),
    );
  });
});

test('in a browser, picking a story leaves the bar above the flow and the list beside it where they were, pressing a step of the line rings, picks and shows its box, or only rings a step off the map, and a story wider than its pane scrolls sideways inside it', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    const tops = () => p.$$eval('#flow-bar, #flow-stories', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }));
    const before = await tops();
    await pickPathStory(p, 'walk-around');
    assert.deepEqual(await tops(), before);
    const step = (i: number) => p.locator(`#flow .story-line .box[data-step="${i}"]`);

    await step(6).click();
    assert.deepEqual(await ringed(p), [['6', '/lab/result#LabResult']]);
    assert.deepEqual(await ringBadge(p), ['7']);
    assert.deepEqual(await pickedBoxes(p), ['/lab/result#LabResult']);
    assert.equal(await p.textContent('#center h3'), '/lab/result');
    assert.equal(await inView(p, '/lab/result#LabResult'), true);
    assert.equal(await flowPlace(p), '#flow?story=walk-around&screen=/lab/result#LabResult');
    await step(7).click();
    assert.deepEqual(await ringed(p), [['7', '/settings#Settings']]);
    assert.deepEqual(await ringBadge(p), ['8'], 'the box of a step off the map rings its step');

    await (await screenBox(p, '/home#Home')).click();
    assert.deepEqual(await ringBadge(p), ['2'], 'pressing a box on the path rings its step');
    await flowButton(p, '선택 해제').click();
    assert.deepEqual(await ringBadge(p), []);
    assert.deepEqual(await ringed(p), []);

    await p.setViewportSize({ width: 1280, height: 800 });
    await p.evaluate(() => renderFlow());
    const flow = await p.evaluate(() => { const f = document.getElementById('flow')!; return [f.scrollWidth, f.clientWidth]; });
    assert.ok(flow[0] > flow[1], `the drawing ${flow[0]}px wide scrolls inside its ${flow[1]}px pane`);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'the page itself does not scroll sideways');
  });
});

test('in a browser, the picked story and the picked screen are kept in the address through reloads and back and forward, and a place that is gone falls back to what is there', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p, { base, errors }) => {
    const whole = (await drawnScreens(p)).length;
    await (await screenBox(p, '/lab#Lab')).click();
    await pickPathStory(p, 'walk-around');
    assert.equal(await flowPlace(p), '#flow?story=walk-around&screen=/lab#Lab', 'a picked screen on the path stays picked');
    await p.reload();
    await p.waitForSelector('#flow .story-line');
    assert.equal(await flowPlace(p), '#flow?story=walk-around&screen=/lab#Lab');
    assert.deepEqual(await drawnScreens(p), [...WALK_ON_MAP].sort());
    assert.deepEqual(await pickedBoxes(p), ['/lab#Lab']);
    assert.equal(await p.textContent('#center h3'), '/lab');
    await p.goBack();
    await p.waitForSelector('#flow .story-line', { state: 'detached' });
    assert.equal(await flowPlace(p), '#flow?screen=/lab#Lab');
    assert.equal((await drawnScreens(p)).length, whole);
    await p.goForward();
    await p.waitForSelector('#flow .story-line');
    assert.deepEqual(await p.$$eval('#flow-story-list li.selected', (els: HTMLElement[]) => els.map((e) => e.dataset.story)), ['walk-around']);
    await (await screenBox(p, '/home#Home')).click();
    assert.deepEqual(await ringBadge(p), ['2']);
    await p.goBack();
    await p.waitForFunction(() => decodeURIComponent(location.hash).endsWith('screen=/lab#Lab'));
    assert.deepEqual(await ringBadge(p), ['6'], 'going back to a picked screen rings its step');
    assert.deepEqual(await ringed(p), [['5', '/lab#Lab']]);

    await flowButton(p, '경로 끄기').click();
    assert.equal(await flowPlace(p), '#flow?screen=/lab#Lab');
    await (await screenBox(p, '/admin/group#AdminGroup')).click();
    await pickPathStory(p, 'walk-around');
    assert.equal(await flowPlace(p), '#flow?story=walk-around', 'a picked screen off the path is let go');
    assert.equal(await p.locator('#gaps').isVisible(), true);

    await p.goto(`${base}/#flow?story=gone&screen=${encodeURIComponent('/gone#Gone')}`);
    await p.reload();
    await p.waitForSelector('#flow .box.screen');
    assert.equal(await flowPlace(p), '#flow');
    assert.deepEqual(errors, []);
  });
});

test('in a browser, a picked story whose file changes while the page is open is drawn again from its new steps, and one whose file is removed turns the path view off', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p, { writeStory, storyFile }) => {
    const whole = await drawnScreens(p);
    await pickPathStory(p, 'walk-around');
    await p.locator('#flow .story-line .box[data-step="6"]').click();
    writeStory('walk-around', ['/signin#SignIn', '/help#Help']);
    await p.evaluate(async () => { await load(); render(); });
    assert.deepEqual(await lineSteps(p), [['1', '/signin#SignIn'], ['2', '/help#Help']]);
    assert.deepEqual(await ringBadge(p), [], 'a ringed step past the new end is dropped');
    assert.deepEqual(await pickedBoxes(p), [], 'and its screen, no longer drawn, is let go');
    assert.equal(await p.locator('#gaps').isVisible(), true);

    fs.rmSync(storyFile('walk-around'));
    await p.evaluate(async () => { await load(); render(); });
    assert.equal(await flowPlace(p), '#flow');
    assert.equal(await p.locator('#flow .story-line').count(), 0);
    assert.deepEqual(await drawnScreens(p), whole);
    assert.equal(await storyRow(p, 'walk-around').count(), 0);
  });
});

test('in a browser, a story path laid over the whole flow puts its hops from a box to its child on that link in the style of the story verdict and every other hop as chips with the other step number in both boxes, numbers a screen visited twice with both steps, and covers no box or mark', { skip: browserMissing }, async () => {
  const stories = { 'walk-around': WALK, twice: ['/signin#SignIn', '/home#Home', '/help#Help', '/home#Home'] };
  await withPathStories(stories, async (p) => {
    await drawOverlay(p, 'walk-around');
    assert.deepEqual(await pathEdges(p), [
      ['/home#Home', '/document/:tab_draft_done_#DocumentList', 'l-open'],
      ['/lab#Lab', '/lab/result#LabResult', 'l-open'],
      ['/signin#SignIn', '/home#Home', 'l-open'],
    ]);
    const stroke = (from: string, to: string) => p.$eval(`#flow svg path[data-from="${from}"][data-to="${to}"]`, (e) => { const c = getComputedStyle(e); return [c.strokeWidth, c.strokeDasharray, c.opacity]; });
    assert.deepEqual(await stroke('/signin#SignIn', '/home#Home'), ['3.2px', 'none', '1']);
    assert.deepEqual(await stroke('/signin#SignIn', '/help#Help'), ['1.3px', 'none', '0.35'], 'a guarded link that no hop takes is a thin grey line');
    assert.deepEqual((await pillMarks(p, 'story-badge')).sort(), WALK_ON_MAP.map((id, i) => [id, String(i + 1)]).sort());
    assert.deepEqual(await pathMarks(p, 'story-hidden'), [['/home#Home', '다른 화면 4 숨김']]);
    assert.deepEqual(await pillMarks(p, 'story-chip'), [
      ['/document/:tab_draft_done_#DocumentList', '→ 4', 'exit', 'l-open'],
      ['/document/:id#DocumentDetail', '3 →', 'entry', 'l-open'],
      ['/document/:id#DocumentDetail', '→ 5조건', 'exit', 'l-conditioned'],
      ['/lab#Lab', '✕5 →', 'entry', 'l-broken'],
      ['/lab/result#LabResult', '→ 8맵에 없는 화면', 'exit', 'l-off-map'],
      ['/help#Help', '4 →', 'entry', 'l-conditioned'],
      ['/help#Help', '✕→ 6링크 없음', 'exit', 'l-broken'],
    ]);
    const order = await (await screenBox(p, '/document/:id#DocumentDetail')).evaluate((box) => [...box.children].map((c) => c.className.split(' ')[0]));
    assert.deepEqual(order.filter((c) => c !== 'sr-only'), ['story-chip', 'story-badge', 'sq', 'path', 'tag', 'story-chip'], 'chips from earlier steps and the number come first, chips to later steps last');
    const toHelp = p.locator('#flow .story-chip.exit[data-hop="3"]');
    await toHelp.hover();
    assert.deepEqual(await p.$$eval('#flow .story-chip.hovered', (els) => els.map((e) => e.closest<HTMLElement>('.box')!.dataset.key)), ['/document/:id#DocumentDetail', '/help#Help']);

    const problems = () => p.evaluate(() => {
      const R = (e: Element) => e.getBoundingClientRect();
      const boxes = [...document.querySelectorAll<HTMLElement>('#flow .canvas > .box')];
      const marks = [...document.querySelectorAll<HTMLElement>('#flow .canvas > .mark')];
      const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
      const out = [];
      for (const m of marks) {
        for (const b of boxes) if (hit(R(m), R(b))) out.push(`${m.textContent} covers ${b.dataset.key}`);
        if (R(m).right > R(m.parentElement!).right + 0.5) out.push(`${m.textContent} sticks out of its canvas`);
      }
      marks.forEach((m, i) => marks.slice(i + 1).forEach((o) => { if (hit(R(m), R(o))) out.push(`${m.textContent} covers ${o.textContent}`); }));
      for (const line of document.querySelectorAll<SVGPathElement>('#flow .canvas svg path')) {
        const ctm = line.getScreenCTM()!;
        const len = line.getTotalLength();
        const thick = line.classList.contains('story-edge');
        for (let at = 2; at < len - 2; at += 2) {
          const q = line.getPointAtLength(at);
          const x = ctm.a * q.x + ctm.e;
          const y = ctm.d * q.y + ctm.f;
          const inside = (e: Element) => { const r = R(e); return x > r.left + 1 && x < r.right - 1 && y > r.top + 1 && y < r.bottom - 1; };
          const box = thick && boxes.find(inside);
          const under = marks.find((m) => !m.classList.contains('story-tag') && inside(m))!;
          if (box || under) {
            out.push(`${line.dataset.from} → ${line.dataset.to} runs ${box ? `across ${box.dataset.key}` : `under ${under.textContent}`}`);
            break;
          }
        }
      }
      return out;
    });
    assert.deepEqual(await problems(), []);
    assert.deepEqual(await textOutside(p), []);
    await drawOverlay(p, 'run-lab');
    assert.deepEqual(await pathEdges(p), [['/home#Home', '/lab#Lab', 'l-conditioned'], ['/lab#Lab', '/lab/result#LabResult', 'l-open']]);
    assert.deepEqual(await pathMarks(p, 'story-tag'), [['/lab#Lab', '조건', 'l-conditioned']]);
    assert.deepEqual(await problems(), []);

    await drawOverlay(p, 'twice');
    assert.deepEqual(await pillMarks(p, 'story-badge'), [['/signin#SignIn', '1'], ['/home#Home', '2·4'], ['/help#Help', '3']]);
  });
});

test('in a browser, the info icon beside a picked story opens a legend of the step number and of each kind of line between two steps drawn as small samples with short names, and Escape closes it', { skip: browserMissing }, async () => {
  await withPathStories({ 'walk-around': WALK }, async (p) => {
    assert.equal(await p.locator('#flow-head button.pathinfo-button').count(), 0, 'no legend for a story until one is picked');
    await pickPathStory(p, 'walk-around');
    const info = p.locator('#flow-head button.pathinfo-button');
    const legend = p.locator('#pathlegend');
    assert.equal(await info.getAttribute('aria-label'), '스토리 경로 읽는 법');
    assert.equal(await legend.isVisible(), false);
    await info.click();
    await p.mouse.move(5, 890);
    assert.equal(await legend.isVisible(), true);
    assert.deepEqual(await legend.locator('li > span:last-child').allTextContents(), [
      '단계 번호', '이어짐', '조건', '설정에 적은 이동', '링크 없음', '맵에 없는 화면 · 판정 못 함',
    ]);
    assert.equal(await legend.locator('li > .sample').count(), 6);
    const look = (sel: string) => p.$eval(sel, (e) => { const c = getComputedStyle(e); return [c.stroke, c.strokeWidth, c.strokeDasharray].join(' '); });
    assert.equal(await look('#pathlegend path.l-broken'), await look('#flow .story-hop path.l-broken'));
    assert.equal(await look('#pathlegend path.l-conditioned'), await look('#flow .story-hop path.l-conditioned'));
    const badge = (sel: string) => p.$eval(sel, (e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.height].join(' '); });
    assert.equal(await badge('#pathlegend .story-badge'), await badge('#flow .story-line .story-badge'));
    await p.evaluate(() => renderFlow());
    assert.equal(await legend.isVisible(), true, 'a redraw keeps the legend open');
    const e = await inWindow(p, '#pathlegend');
    assert.ok(e.left >= 0 && e.right <= e.width, `legend ${e.left}..${e.right} within ${e.width}`);
    await p.keyboard.press('Escape');
    assert.equal(await legend.isVisible(), false);
    assert.equal(await p.locator('#flowlegend').isVisible(), false);
  });
});

test('in a browser, 「리뷰 끝」 ends the review and the page says so', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    let ends = 0;
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => { ends++; } });
    try {
      await withPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        assert.match((await p.textContent('#ended'))!, /리뷰를 끝냈습니다/);
        assert.equal(await p.locator('main, #flow, header button').count(), 0);
        assert.equal(ends, 1);
      });
    } finally {
      server.close();
    }
  });
});

test('in a browser, 「리뷰 끝」 asks before throwing away a mark that was picked but not saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    let ends = 0;
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => { ends++; } });
    try {
      await withPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', 'draft note');

        const asked = [];
        p.once('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForTimeout(200);
        assert.equal(asked.length, 1);
        assert.equal(ends, 0);
        assert.equal(await p.locator('#ended').count(), 0);
        assert.equal(await p.inputValue('#right-dock textarea'), 'draft note');

        await p.locator('table.calls td.cell').first().click();
        await p.click('#right .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', 'call note');
        p.once('dialog', (d) => { asked.push(d.message()); d.dismiss(); });
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForTimeout(200);
        assert.equal(asked.length, 2);
        assert.equal(ends, 0);
        assert.equal(await p.inputValue('#right-dock textarea'), 'call note');

        p.once('dialog', (d) => d.accept());
        await p.click('header button:has-text("리뷰 끝")');
        await p.waitForSelector('#ended');
        assert.equal(ends, 1);
      });
    } finally {
      server.close();
    }
  });
});

test('in a browser, 「리뷰 끝」 after the review already ended elsewhere says so rather than reporting a failure', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const server = await startReviewServer(config, { author: signer('reviewer'), onDone: () => () => server.close() });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage();
      await p.goto(base);
      await toList(p);
      await p.waitForSelector('#screen-list li');
      await fetch(`${base}/api/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await new Promise((resolve) => server.on('close', resolve));

      await p.click('header button:has-text("리뷰 끝")');
      await p.waitForSelector('#ended');
      assert.match((await p.textContent('#ended'))!, /이미/);
      assert.equal(await p.locator('#end-error').count(), 0);
    } finally {
      await browser.close();
      server.close();
    }
  });
});

test('in a browser, a link from a screen that needs both a setting and a role shows both marks', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
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
    execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await openScreenInfo(p);
        await openLinkGroups(p.locator('#center .access'));
        const link = p.locator('#center .access li:has-text("/admin/report#AdminReport")');
        assert.match(await link.innerText(), /링크를 건 화면에 필요한 것/);
        assert.deepEqual(await link.locator('.from-kinds .chip').allTextContents(), ['역할', '설정']);
      }),
    );
  });
});

test('in a browser, the chosen screen shows the logged-in app in a frame above its tests, with the address, the account and a new-window link, and a press inside reaches the test server', { skip: browserMissing }, async () => {
  await withFakeApi((api, presses) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin', '/login'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/home")');
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            assert.match((await bar.textContent())!, new RegExp(`${app.url}/home`));
            assert.match((await bar.textContent())!, /duru-admin/);
            assert.match((await bar.textContent())!, /맵에 없는 signedOutPaths: \/login/);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'), `${app.url}/home`);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('target'), '_blank');

            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            assert.equal(await frame.locator('#path').textContent(), '/home');
            await frame.locator('#press').click();
            await frame.locator('#pressed:has-text("pressed")').waitFor();
            assert.equal(presses.length, 1);

            await p.click('#center tr:has-text("API")');
            await p.click('#right .statuses button:has-text("없음")');
            await p.click('#right button.save');
            await p.waitForSelector('#center tr.selected .chip.missing');
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');

            const frameBox = (await p.locator('#center iframe.app').boundingBox())!;
            const tableBox = (await p.locator('#center table').first().boundingBox())!;
            assert.ok(tableBox.y > frameBox.y + frameBox.height - 1);
            assert.ok(await p.locator('#right').isVisible());

            await p.click('#screen-list li:has-text("/signin")');
            assert.match((await bar.textContent())!, /로그아웃 상태/);
            assert.doesNotMatch((await bar.textContent())!, /duru-admin/);
            await p.frameLocator('#center iframe.app').locator('#path:has-text("/signin")').waitFor();
            const signedOutFrame = p.frameLocator('#center iframe.app');
            assert.equal(await signedOutFrame.locator('#who').textContent(), '로그인 전');
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'),
              `${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent('/signin')}`);

            const appFrameHandle = p.frames().find((f) => f.url().startsWith(`${app.signedOutUrl}/signin`))!;
            await appFrameHandle.evaluate(() => {
              localStorage.setItem('FAKE_AUTH', JSON.stringify({ accessToken: 't-123' }));
              location.reload();
            });
            await signedOutFrame.locator('#who:has-text("두루 관리자")').waitFor();
          }),
        ),
      ),
    ),
  );
});

const twoFrames = (p: Page) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const pageOverflow = (p: Page) => p.evaluate(() => document.documentElement.scrollHeight - innerHeight);

async function shownApp(p: Page) {
  await twoFrames(p);
  const [width, height] = await p.frameLocator('#center iframe.app').locator('body').evaluate(() => [innerWidth, innerHeight]);
  const box = (await p.locator('#center iframe.app').boundingBox())!;
  const room = await p.locator('#center .app-stage').evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + e.clientLeft, y: r.y + e.clientTop, width: e.clientWidth, height: e.clientHeight, right: r.right, bottom: r.bottom };
  });
  const scaleText = await p.locator('#center .frame-bar .app-scale').textContent();
  return { width, height, box, room, scaleText, scale: box.width / width };
}

function assertFits(shown: Awaited<ReturnType<typeof shownApp>>) {
  const { box, room } = shown;
  assert.ok(box.x >= room.x - 0.5 && box.x + box.width <= room.x + room.width + 0.5, `app ${box.x}+${box.width} inside ${room.x}+${room.width}`);
  assert.ok(Math.abs(box.y - room.y) < 0.5 && Math.abs(box.height - room.height) < 1, `app ${box.y}+${box.height} fills ${room.y}+${room.height}`);
  assert.ok(Math.abs(shown.height - room.height / shown.scale) < 1.5, `app height ${shown.height} is ${room.height} / ${shown.scale}`);
}

function assertShrunk(shown: Awaited<ReturnType<typeof shownApp>>, width: number) {
  const percent = Math.floor((shown.room.width / width) * 100);
  assert.ok(percent < 100);
  assert.equal(shown.width, width);
  assert.equal(shown.scaleText, `${width}px 화면을 ${percent}%로 줄여서 보여 줍니다`);
  assert.ok(Math.abs(shown.box.width - (width * percent) / 100) < 0.5, `${shown.box.width} is ${width} at ${percent}%`);
  assertFits(shown);
  return percent;
}

test('in a browser, a screen picked in the flow view draws the app 1280 wide shrunk to fit the pane, a chosen width changes only the scale without reloading, and the scale follows the window', { skip: browserMissing }, async () => {
  await withFakeApi((api, presses) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.setViewportSize({ width: 1920, height: 1080 });
            await (await screenBox(p, '/home#Home')).click();
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            const width = p.locator('#center .frame-bar select.app-width');
            assert.deepEqual(await width.locator('option').allTextContents(), ['칸에 맞춤', '375', '768', '1024', '1280', '1440', '직접 입력']);
            assert.equal(await width.inputValue(), '1280');
            let shown = await shownApp(p);
            const at1920 = assertShrunk(shown, 1280);
            assert.equal(await pageOverflow(p), 0, 'the page itself does not scroll');

            await frame.locator('#press').click();
            await frame.locator('#pressed:has-text("pressed")').waitFor();
            assert.equal(presses.length, 1);
            await frame.locator('body').evaluate(() => {
              const field = document.createElement('input');
              field.id = 'typed';
              field.style.cssText = 'position: fixed; left: 1180px; top: 200px; width: 90px; height: 24px';
              document.body.append(field);
            });
            await p.mouse.click(shown.box.x + 1220 * shown.scale, shown.box.y + 212 * shown.scale);
            await p.keyboard.type('오른쪽 끝');
            assert.equal(await frame.locator('#typed').inputValue(), '오른쪽 끝');

            await width.selectOption({ label: '1024' });
            assertShrunk(await shownApp(p), 1024);
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');
            assert.equal(await frame.locator('#typed').inputValue(), '오른쪽 끝');

            await width.selectOption({ label: '칸에 맞춤' });
            shown = await shownApp(p);
            assert.equal(shown.width, shown.room.width);
            assert.equal(shown.scaleText, `칸 너비 그대로 ${shown.room.width}px`);
            assertFits(shown);
            assert.ok(await p.locator('#center .frame-bar select.app-percent').isDisabled());
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');

            await width.selectOption({ label: '1280' });
            await p.setViewportSize({ width: 2600, height: 1080 });
            shown = await shownApp(p);
            assert.ok(assertShrunk(shown, 1280) > at1920);
            await width.selectOption({ label: '1024' });
            shown = await shownApp(p);
            assert.equal(shown.width, 1024);
            assert.equal(shown.scaleText, '1024px 화면을 실제 크기로 보여 줍니다');
            assert.equal(shown.box.width, 1024);
            assertFits(shown);

            await p.setViewportSize({ width: 1920, height: 1080 });
            shown = await shownApp(p);
            assertShrunk(shown, 1024);
            const before = shown.room.height;
            await p.mouse.move(shown.room.right - 4, shown.room.bottom - 4);
            await p.mouse.down();
            await p.mouse.move(shown.room.right - 4, shown.room.bottom + 116, { steps: 5 });
            await p.mouse.up();
            shown = await shownApp(p);
            assert.ok(Math.abs(shown.room.height - before - 120) < 2, `stage grew from ${before} to ${shown.room.height}`);
            assertShrunk(shown, 1024);
            assert.equal(await pageOverflow(p), 0);
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');
          }, { view: 'flow' }),
        ),
      ),
    ),
  );
});

test('in a browser, the list view shrinks the app the same way, and the chosen width stays across screens and views until the page reloads', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/home")');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            assertShrunk(await shownApp(p), 1280);
            assert.equal(await pageOverflow(p), 0, 'the page itself does not scroll');

            await p.selectOption('#center .frame-bar select.app-width', { label: '1440' });
            await p.click('#screen-list li:has-text("/signin")');
            await frame.locator('#path:has-text("/signin")').waitFor();
            assert.equal(await p.locator('#center .frame-bar select.app-width').inputValue(), '1440');
            assertShrunk(await shownApp(p), 1440);

            await p.click('#view-flow');
            await (await screenBox(p, '/home#Home')).click();
            await frame.locator('#path:has-text("/home")').waitFor();
            assertShrunk(await shownApp(p), 1440);

            await p.reload();
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await p.locator('#center .frame-bar select.app-width').inputValue(), '1280');
            assertShrunk(await shownApp(p), 1280);
          }),
        ),
      ),
    ),
  );
});

function assertScaled(shown: Awaited<ReturnType<typeof shownApp>>, width: number, percent: number) {
  assert.equal(shown.width, width);
  assert.ok(Math.abs(shown.box.width - (width * percent) / 100) < 0.5, `${shown.box.width} is ${width} at ${percent}%`);
  assert.ok(Math.abs(shown.box.y - shown.room.y) < 0.5 && Math.abs(shown.box.height - shown.room.height) < 1, `app ${shown.box.y}+${shown.box.height} fills ${shown.room.y}+${shown.room.height}`);
  assert.ok(Math.abs(shown.height - shown.room.height / shown.scale) < 1.5, `app height ${shown.height} is ${shown.room.height} / ${shown.scale}`);
}

test('in a browser, a typed app width and a picked scale draw the app at that size, an app wider than the pane scrolls sideways inside it, and the scale cannot be picked while the width fits the pane', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(appSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.setViewportSize({ width: 1920, height: 1080 });
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/home")');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            const stage = p.locator('#center .app-stage');
            const width = p.locator('#center .frame-bar select.app-width');
            const typedWidth = p.locator('#center .frame-bar input.app-width-typed');
            const percent = p.locator('#center .frame-bar select.app-percent');
            const typedPercent = p.locator('#center .frame-bar input.app-percent-typed');
            const sideways = () => stage.evaluate((e) => ({ wide: e.classList.contains('wide'), overflow: e.scrollWidth - e.clientWidth }));
            const pageSideways = () => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
            assert.deepEqual(await percent.locator('option').allTextContents(), ['칸에 맞춤', '25%', '50%', '75%', '100%', '150%', '직접 입력']);
            assert.equal(await percent.inputValue(), '0');
            assert.ok(await percent.isEnabled());
            assert.ok(await typedWidth.isHidden());

            await width.selectOption({ label: '직접 입력' });
            assert.ok(await typedWidth.isVisible());
            assert.equal(await typedWidth.inputValue(), '1280');
            await typedWidth.fill('2000');
            await typedWidth.press('Enter');
            let shown = await shownApp(p);
            const fit = assertShrunk(shown, 2000);
            assert.deepEqual(await sideways(), { wide: false, overflow: 0 });
            await typedWidth.fill('50');
            await typedWidth.press('Enter');
            assert.equal(await typedWidth.inputValue(), '2000');
            assertShrunk(await shownApp(p), 2000);

            await percent.selectOption({ label: '25%' });
            shown = await shownApp(p);
            assertScaled(shown, 2000, 25);
            assertFits(shown);
            assert.equal(shown.scaleText, '2000px 화면을 25%로 줄여서 보여 줍니다');
            assert.deepEqual(await sideways(), { wide: false, overflow: 0 });

            await percent.selectOption({ label: '100%' });
            shown = await shownApp(p);
            assertScaled(shown, 2000, 100);
            assert.equal(shown.scaleText, '2000px 화면을 실제 크기로 보여 줍니다 · 칸을 넘는 부분은 옆으로 넘겨 봅니다');
            const over = await sideways();
            assert.equal(over.wide, true);
            assert.ok(Math.abs(over.overflow - (2000 - shown.room.width)) <= 1, `scrolls ${over.overflow} past a ${shown.room.width}px pane`);
            await stage.evaluate((e) => { e.scrollLeft = e.scrollWidth; });
            const scrolled = await shownApp(p);
            assert.ok(Math.abs(scrolled.box.x + scrolled.box.width - (scrolled.room.x + scrolled.room.width)) < 1, 'scrolled to the right edge of the app');
            assert.equal(await pageOverflow(p), 0, 'the page itself does not scroll');
            assert.equal(await pageSideways(), 0, 'the page itself does not scroll sideways');

            await percent.selectOption({ label: '150%' });
            shown = await shownApp(p);
            assertScaled(shown, 2000, 150);
            assert.equal(shown.scaleText, '2000px 화면을 150%로 키워서 보여 줍니다 · 칸을 넘는 부분은 옆으로 넘겨 봅니다');
            assert.equal((await sideways()).wide, true);
            assert.equal(await pageSideways(), 0);

            await percent.selectOption({ label: '직접 입력' });
            assert.equal(await typedPercent.inputValue(), '150');
            await typedPercent.fill('20');
            await typedPercent.press('Enter');
            shown = await shownApp(p);
            assertScaled(shown, 2000, 20);
            assertFits(shown);
            assert.equal(shown.scaleText, '2000px 화면을 20%로 줄여서 보여 줍니다');

            await p.click('#screen-list li:has-text("/signin")');
            await frame.locator('#path:has-text("/signin")').waitFor();
            assert.equal(await width.inputValue(), 'typed');
            assert.equal(await typedWidth.inputValue(), '2000');
            assert.equal(await percent.inputValue(), 'typed');
            assert.equal(await typedPercent.inputValue(), '20');
            assertScaled(await shownApp(p), 2000, 20);

            await width.selectOption({ label: '칸에 맞춤' });
            shown = await shownApp(p);
            assert.equal(shown.width, shown.room.width);
            assert.equal(shown.scaleText, `칸 너비 그대로 ${shown.room.width}px`);
            assertFits(shown);
            assert.ok(await percent.isDisabled());
            assert.ok(await typedPercent.isDisabled());
            assert.deepEqual(await sideways(), { wide: false, overflow: 0 });

            await width.selectOption({ label: '768' });
            assert.ok(await percent.isEnabled());
            assertScaled(await shownApp(p), 768, 20);
            await percent.selectOption({ label: '칸에 맞춤' });
            assert.ok(await typedPercent.isHidden());
            await width.selectOption({ label: '1280' });
            assert.ok(assertShrunk(await shownApp(p), 1280) > fit);

            await p.reload();
            await frame.locator('#path:has-text("/signin")').waitFor();
            assert.equal(await width.inputValue(), '1280');
            assert.equal(await percent.inputValue(), '0');
            assert.ok(await typedWidth.isHidden());
            assert.ok(await typedPercent.isHidden());
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen with path variables opens filled with its fixed value or the first value of its list API, and an edited value reopens it', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: 'draft' }, '/document/:id': { id: LIST_API } };
  await withFakeApi((api, presses, logins, listCalls) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...pathValueSettings(api, pathValues).app, signedOutPaths: ['/document/:tab(draft|done)'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            const newWindow = () => bar.locator('a:has-text("새 창")').getAttribute('href');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/document/:tab")');
            await frame.locator('#path:has-text("/document/draft")').waitFor();
            assert.equal(await frame.locator('#who').textContent(), '로그인 전');
            assert.equal(await bar.locator('.mono').textContent(), `${app.signedOutUrl}/document/draft`);
            assert.match((await bar.textContent())!, /로그아웃 상태/);
            assert.equal(await newWindow(), `${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent('/document/draft')}`);
            assert.equal(await bar.locator('input[name=tab]').inputValue(), 'draft');

            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            assert.equal(await bar.locator('input[name=id]').inputValue(), '17');
            assert.equal(await newWindow(), `${app.url}/document/17`);
            assert.doesNotMatch((await bar.textContent())!, /목록에서 골라/);
            assert.deepEqual(listCalls, ['GET /api/v1/documents']);

            await bar.locator('input[name=id]').fill('42');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/42")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${app.url}/document/42`);
            assert.equal(await newWindow(), `${app.url}/document/42`);

            await frame.locator('#press').click();
            await frame.locator('#pressed:has-text("pressed")').waitFor();
            await p.click('#center tr:has-text("API")');
            await p.click('#right .statuses button:has-text("없음")');
            await p.click('#right button.save');
            await p.waitForSelector('#center tr.selected .chip.missing');
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');

            await bar.locator('input[name=id]').fill('43');
            await p.click('#screen-list li:has-text("/home")');
            await frame.locator('#path:has-text("/home")').waitFor();
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/42")').waitFor();
            assert.equal(await bar.locator('input[name=id]').inputValue(), '43');
            await bar.locator('button:has-text("다시 띄우기")').click();
            await frame.locator('#path:has-text("/document/43")').waitFor();
            assert.deepEqual(listCalls, ['GET /api/v1/documents']);
            assert.equal(presses.length, 1);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen with path variables picked in the flow opens filled with the value its list API gives, in the same middle pane as the list', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:id': { id: LIST_API } };
  await withFakeApi((api, _presses, _logins, listCalls) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, pathValues), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#flow .box.screen');
            await (await screenBox(p, '/document/:id#DocumentDetail')).click();
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            assert.equal(await p.locator('#center .frame-bar input[name=id]').inputValue(), '17');
            assert.deepEqual(listCalls, ['GET /api/v1/documents']);
          }, { view: 'flow' }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen without its values opens its list screen with a notice, and a failing list API is shown before the same fallback', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: { ...LIST_API, api: '/api/v1/documents/broken' } }, '/docs/:id': { id: '1' } };
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, pathValues), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${app.url}/home`);
            assert.match((await bar.textContent())!, /목록에서 골라 들어가세요/);
            assert.match((await bar.textContent())!, /맵에 없는 pathValues: \/docs\/:id/);
            assert.equal(await bar.locator('.path-values .error').count(), 0);
            assert.equal(await bar.locator('input[name=id]').inputValue(), '');

            await bar.locator('input[name=id]').fill('42');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/42")').waitFor();
            assert.doesNotMatch((await bar.textContent())!, /목록에서 골라/);

            await p.click('#screen-list li:has-text("/document/:tab")');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.match((await bar.textContent())!, /목록에서 골라 들어가세요/);
            assert.match((await bar.locator('.path-values .error').textContent())!, /^tab: 목록 API GET \/api\/v1\/documents\/broken 요청이 500 로 실패했습니다$/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen without its values falls back to a list screen opened with its fixed values', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, { '/document/:tab(draft|done)': { tab: 'draft' } }), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await p.frameLocator('#center iframe.app').locator('#path:has-text("/document/draft")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${app.url}/document/draft`);
            assert.match((await bar.textContent())!, /목록에서 골라 들어가세요/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen without its values falls back to a linking list screen the frame account can open before one that needs another role', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, pathValues: {} } }, async (config, copy) => {
        const member = path.join(copy, 'client/src/components/AdminMember.js');
        fs.writeFileSync(member, fs.readFileSync(member, 'utf8').replace('Audit log</Link>', 'Audit log</Link>\n      <Link to={`${Option.ROUTE_PATH.DOCUMENT}/7`}>Document</Link>'));
        execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await bar.locator('text=목록에서 골라 들어가세요').waitFor();
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.url}/home`);
            await frameWho(p, '두루 관리자');
          }),
        );
      }),
    ),
  );
});

test('in a browser, a value the reviewer clears does not fall back to a list screen, and the frame says the value is missing', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, { '/document/:id': { id: '42' } }), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/42")').waitFor();

            await bar.locator('input[name=id]').fill('');
            await bar.locator('input[name=id]').press('Enter');
            await p.locator('#center .frame-note:has-text("id 값이 없어 이 화면을 띄울 수 없습니다")').waitFor();
            assert.equal(await p.locator('#center iframe.app').count(), 0);
            assert.doesNotMatch((await bar.textContent())!, /목록에서 골라/);

            await bar.locator('input[name=id]').fill('43');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/43")').waitFor();
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen with a list API opens with the value the list gives to the account the frame logs in as', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:id': { id: LIST_API } };
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            await p.selectOption('#center select.role', 'role:ADMIN');
            await frame.locator('#path:has-text("/document/27")').waitFor();
            assert.equal(await p.locator('#center .frame-bar input[name=id]').inputValue(), '27');
            await p.selectOption('#center select.role', 'auto');
            await frame.locator('#path:has-text("/document/17")').waitFor();
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a list API that failed is called again when its screen is chosen again', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:tab(draft|done)': { tab: { ...LIST_API, api: '/api/v1/documents/flaky' } } };
  await withFakeApi((api, presses, logins, listCalls) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(pathValueSettings(api, pathValues), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:tab")');
            await bar.locator('.path-values .error:has-text("503")').waitFor();
            await p.click('#screen-list li:has-text("/home")');
            await p.click('#screen-list li:has-text("/document/:tab")');
            await frame.locator('#path:has-text("/document/done")').waitFor();
            assert.equal(await bar.locator('.path-values .error').count(), 0);
            assert.equal(listCalls.filter((c) => c.endsWith('/flaky')).length, 2);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen with an issuing API gets a new value each time it is opened, and leaving a mark asks for none', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:id': { id: ISSUING_API } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ ...ALL_PASSWORDS, [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, settingsFile: SETTINGS_FILE, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p, errors) => {
            const issued = () => requests.filter((r) => r === 'POST /api/v2/one-time-code/create').length;
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/c-1")').waitFor();
            await frame.locator('#who:has-text("두루 관리자")').waitFor();
            assert.equal(await bar.locator('input[name=id]').inputValue(), 'c-1');

            await frame.locator('#press').click();
            await frame.locator('#pressed:has-text("pressed")').waitFor();
            await p.click('#center tr:has-text("API")');
            await p.click('#right .statuses button:has-text("없음")');
            await p.click('#right button.save');
            await p.waitForSelector('#center tr.selected .chip.missing');
            assert.equal(await frame.locator('#pressed').textContent(), 'pressed');
            assert.equal(issued(), 1);

            await p.click('#screen-list li:has-text("/home")');
            await frame.locator('#path:has-text("/home")').waitFor();
            await p.click('#screen-list li:has-text("/document/:id")');
            await frame.locator('#path:has-text("/document/c-2")').waitFor();
            assert.equal(await bar.locator('input[name=id]').inputValue(), 'c-2');
            assert.equal(issued(), 2);

            await p.selectOption('#center select.role', 'role:ADMIN');
            await frame.locator('#path:has-text("/document/c-3")').waitFor();
            await p.selectOption('#center select.role', 'auto');
            await frame.locator('#path:has-text("/document/c-4")').waitFor();
            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            await lab.locator('button:has-text("끄기")').click();
            await p.waitForFunction(() => document.querySelector('#center iframe.app')?.getAttribute('src')?.endsWith('/document/c-5'));
            await lab.locator('button:has-text("켜기")').click();
            await frame.locator('#path:has-text("/document/c-6")').waitFor();
            await p.route('**/api/settings', (r) => r.fulfill({ status: 400, body: 'refused' }));
            await lab.locator('button:has-text("끄기")').click();
            await p.locator('#settings-bar .error:has-text("refused")').waitFor();
            await p.unroute('**/api/settings');
            assert.deepEqual(errors.splice(0), ['Failed to load resource: the server responded with a status of 400 (Bad Request)']);
            assert.equal(await frame.locator('#path').textContent(), '/document/c-6');
            assert.equal(issued(), 6);

            await bar.locator('input[name=id]').fill('typed');
            await bar.locator('input[name=id]').press('Enter');
            await frame.locator('#path:has-text("/document/typed")').waitFor();
            assert.equal(issued(), 6);
            assert.ok(!(await p.content()).includes(API_KEY));
          }),
        ), [['client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />',
        '{globalSettings.SYSTEM.LAB_ENABLED ? <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact /> : null}']]),
    ),
  );
});

test('in a browser, 「새 창으로 열기」 and 「다시 띄우기」 ask for a new issued value unless the reviewer typed over it, keep the other typed values, and show a failure without reloading', { skip: browserMissing }, async () => {
  const pathValues = { '/document/:id/:code': { id: '42', code: ISSUING_API } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ [PASSWORD_ENV]: 's3cret', [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p, errors) => {
            const issued = () => requests.filter((r) => r === 'POST /api/v2/one-time-code/create').length;
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            const newTab = async () => {
              const [tab] = await Promise.all([p.context().waitForEvent('page'), bar.locator('a:has-text("새 창")').click()]);
              return tab;
            };
            const reopen = async (name: string, value: string) => {
              await bar.locator(`input[name=${name}]`).fill(value);
              await bar.locator('button:has-text("다시 띄우기")').click();
            };
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/document/:id/:code")');
            await frame.locator('#path:has-text("/document/42/c-1")').waitFor();
            const { app } = await (await fetch(`${base}/api/data`)).json();

            const tab = await newTab();
            await tab.waitForURL(`${app.url}/document/42/c-2`);
            await tab.locator('#path:has-text("/document/42/c-2")').waitFor();
            await tab.close();
            assert.equal(await frame.locator('#path').textContent(), '/document/42/c-1');
            assert.equal(issued(), 2);

            await reopen('id', '43');
            await frame.locator('#path:has-text("/document/43/c-3")').waitFor();
            assert.equal(await bar.locator('input[name=code]').inputValue(), 'c-3');
            assert.equal(issued(), 3);

            await p.route('**/api/path-values', (r) => r.fulfill({ status: 500, body: 'down' }));
            await reopen('id', '44');
            await bar.locator('.path-values .error:has-text("down")').waitFor();
            const failed = await newTab();
            if (!failed.isClosed()) await failed.waitForEvent('close');
            await p.unroute('**/api/path-values');
            assert.equal(await frame.locator('#path').textContent(), '/document/43/c-3');
            assert.equal(issued(), 3);
            assert.deepEqual(errors.splice(0), Array(2).fill('Failed to load resource: the server responded with a status of 500 (Internal Server Error)'));

            await reopen('code', 'mine');
            await frame.locator('#path:has-text("/document/44/mine")').waitFor();
            const typed = await newTab();
            await typed.waitForURL(`${app.url}/document/44/mine`);
            await typed.close();
            assert.equal(issued(), 3);

            let held!: Route;
            await p.route('**/api/path-values', (r) => { held = r; });
            await bar.locator('input[name=code]').fill('c-3');
            await reopen('id', '45');
            await untilSet(() => held, 'the path-values request');
            await p.click('#screen-list li:has-text("/home")');
            await frame.locator('#path:has-text("/home")').waitFor();
            await held.continue();
            await untilSet(() => issued() === 4, 'the new code');
            await p.waitForTimeout(300);
            assert.equal(await p.textContent('#center h3'), '/home');
            assert.equal(await frame.locator('#path').textContent(), '/home');
          }),
        ), [['client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />',
        '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id/:code`} component={waitFor(DocumentDetail)} exact />']]),
    ),
  );
});

test('in a browser, a screen whose address needs an issued query token opens with it, and a typed document id gets the token issued for that id', { skip: browserMissing }, async () => {
  const pathValues = { '/view/:documentId': { documentId: '01a1', '?token': VIEW_TOKEN_API } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ [PASSWORD_ENV]: 's3cret', [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const issued = () => requests.filter((r) => r === 'POST /api/v1/view-token/create').length;
            const bar = p.locator('#center .frame-bar');
            const frame = p.frameLocator('#center iframe.app');
            const field = (name: string) => bar.locator(`input[name="${name}"]`);
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/view/:documentId")');
            await frame.locator('#path:has-text("/view/01a1?token=t-01a1-1")').waitFor();
            assert.equal(await bar.locator('.mono').textContent(), `${(await (await fetch(`${base}/api/data`)).json()).app.url}/view/01a1?token=t-01a1-1`);
            assert.deepEqual([await field('documentId').inputValue(), await field('?token').inputValue()], ['01a1', 't-01a1-1']);
            assert.equal(await bar.locator('label:has(input[name="?token"])').textContent(), '?token ');
            const { app } = await (await fetch(`${base}/api/data`)).json();

            const tab = await Promise.all([p.context().waitForEvent('page'), bar.locator('a:has-text("새 창")').click()]).then(([t]) => t);
            await tab.waitForURL(`${app.url}/view/01a1?token=t-01a1-2`);
            await tab.close();
            assert.equal(issued(), 2);

            await field('documentId').fill('typed7');
            await bar.locator('button:has-text("다시 띄우기")').click();
            await frame.locator('#path:has-text("/view/typed7?token=t-typed7-3")').waitFor();
            assert.equal(await field('?token').inputValue(), 't-typed7-3');
            assert.equal(issued(), 3);

            await field('?token').fill('mine');
            await field('?token').press('Enter');
            await frame.locator('#path:has-text("/view/typed7?token=mine")').waitFor();
            assert.equal(issued(), 3);
            const typedTab = await Promise.all([p.context().waitForEvent('page'), bar.locator('a:has-text("새 창")').click()]).then(([t]) => t);
            await typedTab.waitForURL(`${app.url}/view/typed7?token=mine`);
            await typedTab.close();
            assert.equal(issued(), 3);
            assert.ok(!(await p.content()).includes(API_KEY));
          }),
        ), [VIEW_ROUTE, ['build/app.js', "textContent = location.pathname;", 'textContent = location.pathname + location.search;']]),
    ),
  );
});


test('in a browser, a token that could not be asked for at first is issued once the reviewer types the document id, and the line saying it was not asked for goes away', { skip: browserMissing }, async () => {
  const pathValues = { '/view/:documentId': { '?token': VIEW_TOKEN_API } };
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPasswords({ [PASSWORD_ENV]: 's3cret', [API_KEY_ENV]: API_KEY }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, pathValues } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/view/:documentId")');
            await bar.locator('.error:has-text("?token: documentId 값이 없어 발급 API POST /api/v1/view-token/create 를 부르지 않았습니다")').waitFor();
            assert.equal(requests.filter((r) => r === 'POST /api/v1/view-token/create').length, 0);

            await bar.locator('input[name="documentId"]').fill('typed7');
            await bar.locator('button:has-text("다시 띄우기")').click();
            await p.frameLocator('#center iframe.app').locator('#path:has-text("/view/typed7?token=t-typed7-1")').waitFor();
            assert.equal(await bar.locator('.error').count(), 0);
          }),
        ), [VIEW_ROUTE, ['build/app.js', "textContent = location.pathname;", 'textContent = location.pathname + location.search;']]),
    ),
  );
});

test('in a browser, the sign-out path lands on the signed-out address whatever path it is given', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, signedOutPaths: ['/signin'] } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            for (const [to, landing] of [['/signin', '/signin'], ['/.//evil.example.test', '/'], ['/%2e//evil.example.test', '/'], ['/.\\/evil.example.test', '/']]) {
              await p.goto(`${app.signedOutUrl}${app.signOutPath}?to=${encodeURIComponent(to)}`);
              await p.waitForURL((u) => u.pathname !== app.signOutPath);
              assert.equal(p.url(), `${app.signedOutUrl}${landing}`, to);
            }
          }),
        ),
      ),
    ),
  );
});

const frameWho = (p: Page, name: string) => p.frameLocator('#center iframe.app').locator(`#who:has-text("${name}")`).waitFor();

test('in a browser, a screen under a role condition opens as the first configured role that meets it, and a role picked in the bar reloads the frame and stays picked on other screens', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture(roleSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const [admin, auditor] = app.roles;
            const bar = p.locator('#center .frame-bar');
            const picker = bar.locator('select.role');
            const frameSrc = () => p.locator('#center iframe.app').getAttribute('src');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/admin/member")');
            assert.deepEqual(await picker.locator('option').allTextContents(),
              ['자동', '기본 계정 (duru-admin)', 'ADMIN (duru-boss)', 'AUDITOR (duru-auditor)', 'OWNER — 계정 없음']);
            assert.equal(await picker.locator('option:has-text("OWNER")').isDisabled(), true);
            assert.equal(await picker.inputValue(), 'auto');
            assert.match((await bar.textContent())!, /ADMIN 역할 duru-boss 로 로그인/);
            assert.equal(await frameSrc(), `${admin.url}/admin/member`);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'), `${admin.url}/admin/member`);
            await frameWho(p, '두루 대표');

            await picker.selectOption({ label: 'AUDITOR (duru-auditor)' });
            await frameWho(p, '두루 감사');
            assert.equal(await frameSrc(), `${auditor.url}/admin/member`);
            assert.equal(await bar.locator('a:has-text("새 창")').getAttribute('href'), `${auditor.url}/admin/member`);
            assert.match((await bar.textContent())!, /AUDITOR 역할 duru-auditor 로 로그인/);
            assert.match(await bar.locator('.error').allTextContents().then((t) => t.join('\n')), /이 역할은 화면 조건\(ADMIN\)을 채우지 못합니다/);

            await p.click('#screen-list li:has-text("/admin/report")');
            assert.equal(await picker.inputValue(), 'role:AUDITOR');
            assert.equal(await frameSrc(), `${auditor.url}/admin/report`);
            assert.match((await bar.textContent())!, /이 역할은 화면 조건\(ADMIN, OWNER\)을 채우지 못합니다/);

            await p.click('#screen-list li:has-text("/admin/audit")');
            assert.equal(await frameSrc(), `${auditor.url}/admin/audit`);
            assert.doesNotMatch((await bar.textContent())!, /채우지 못합니다/);

            await picker.selectOption({ label: '기본 계정 (duru-admin)' });
            await frameWho(p, '두루 관리자');
            assert.equal(await frameSrc(), `${app.url}/admin/audit`);
            assert.match((await bar.textContent())!, /duru-admin 로 로그인/);

            await picker.selectOption({ label: '자동' });
            await frameWho(p, '두루 대표');
            assert.equal(await frameSrc(), `${admin.url}/admin/audit`);

            await p.click('#screen-list li:has-text("/home")');
            assert.equal(await frameSrc(), `${app.url}/home`);
            assert.match((await bar.textContent())!, /duru-admin 로 로그인/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a narrow center column puts the address above the role picker instead of squeezing it', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture(roleSettings(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.setViewportSize({ width: 1000, height: 900 });
            await p.waitForSelector('#screen-list li');
            await p.click('#screen-list li:has-text("/admin/member")');
            const bar = (await p.locator('#center .frame-bar').boundingBox())!;
            const address = (await p.locator('#center .frame-bar .mono').boundingBox())!;
            const picker = (await p.locator('#center .frame-bar select.role').boundingBox())!;
            assert.ok(address.width > bar.width * 0.8, `address ${address.width}px in a ${bar.width}px bar`);
            assert.ok(picker.x + picker.width <= bar.x + bar.width, 'the role picker fits in the bar');
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a screen whose role has no account or cannot be read from the map opens as the default account and the bar says why, and signed-out screens have no role picker', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords({ ...ALL_PASSWORDS, [AUDITOR_PASSWORD_ENV]: undefined }, () =>
      withRebuiltFixture({ app: { ...roleSettings(api, { AUDITOR: 'duru-auditor' }).app, signedOutPaths: ['/signin'] } }, async (config, copy) => {
        const home = path.join(copy, 'client/src/components/Home.js');
        fs.writeFileSync(home, fs.readFileSync(home, 'utf8').replace("const isAdmin = memberRole === 'ADMIN';", "const isAdmin = memberRole !== 'MEMBER';"));
        execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/admin/member")');
            assert.deepEqual(await bar.locator('select.role option[disabled]').allTextContents(), ['ADMIN — 계정 없음', 'OWNER — 계정 없음']);
            assert.match((await bar.locator('.error').textContent())!, /조건을 채우는 역할\(ADMIN\)에 계정이 없습니다/);
            assert.match((await bar.textContent())!, /duru-admin 로 로그인/);
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.url}/admin/member`);

            await p.click('#screen-list li:has-text("/admin/group")');
            assert.match((await bar.locator('.error').textContent())!, /어느 역할이 조건을 채우는지 맵에서 정할 수 없습니다: isAdmin/);
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.url}/admin/group`);

            await bar.locator('select.role').selectOption({ label: 'AUDITOR (duru-auditor)' });
            assert.match((await bar.locator('.error').first().textContent())!, new RegExp(AUDITOR_PASSWORD_ENV));
            assert.doesNotMatch((await bar.textContent())!, /AUDITOR 역할 duru-auditor 로 로그인/);

            await p.click('#screen-list li:has-text("/signin")');
            assert.match((await bar.textContent())!, /로그아웃 상태/);
            assert.equal(await bar.locator('select.role').count(), 0);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a screen opens as a role that logged in before one whose login failed, and guards left unread are named even when the values are known', { skip: browserMissing }, async () => {
  const roles = {
    ADMIN: { id: 'duru-auditor', passwordEnv: AUDITOR_PASSWORD_ENV },
    OWNER: { id: 'duru-boss', passwordEnv: ADMIN_PASSWORD_ENV },
  };
  await withFakeApi((api) =>
    withPasswords({ ...ALL_PASSWORDS, [AUDITOR_PASSWORD_ENV]: undefined }, () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, roles } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            const { app } = await (await fetch(`${base}/api/data`)).json();
            const bar = p.locator('#center .frame-bar');
            await p.waitForSelector('#screen-list li');

            await p.click('#screen-list li:has-text("/admin/report")');
            await frameWho(p, '두루 대표');
            assert.equal(await p.locator('#center iframe.app').getAttribute('src'), `${app.roles[1].url}/admin/report`);
            assert.match((await bar.textContent())!, /OWNER 역할 duru-boss 로 로그인/);

            await p.click('#screen-list li:has-text("/admin/group")');
            assert.match((await bar.locator('.error').first().textContent())!, new RegExp(AUDITOR_PASSWORD_ENV));
            assert.match((await bar.textContent())!, /읽지 못한 역할 조건도 있습니다: isAdmin\b/);
          }),
        ),
      ),
    ),
  );
});

const chooseScreen = (p: Page, routePath: string) =>
  p.locator('#screen-list li').filter({ has: p.locator('.name > span:first-child', { hasText: new RegExp(`^${routePath}$`) }) }).click();
const overridesOf = async (base: string) => (await (await fetch(`${base}/api/data`)).json()).app.settings.overrides;
const settingRow = (p: Page, name: string) => p.locator('#settings-bar .setting', { has: p.locator('code', { hasText: new RegExp(`^${name}$`) }) });

test('in a browser, choosing a screen behind a setting opens the frame with the setting on, a toggle reloads it with the new value, and 「기본값으로」 puts every setting back', { skip: browserMissing }, async () => {
  await withFakeApi((api, presses, logins, listCalls, requests) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/home');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.equal(await frame.locator('#help').textContent(), 'true');
            assert.equal(await p.locator('#settings-bar').isHidden(), true);

            await chooseScreen(p, '/lab');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.equal(await frame.locator('#help').textContent(), 'true');
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
            const bar = p.locator('#settings-bar');
            assert.match((await bar.getAttribute('class'))!, /overridden/);
            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            assert.equal(await lab.count(), 1);
            assert.match((await lab.getAttribute('class'))!, /changed/);
            assert.match((await lab.locator('button.on').textContent())!, /켜기/);
            assert.match((await lab.getAttribute('title'))!, /라우트 · \/home#Home 에서 오는 링크/);

            await lab.locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
            assert.doesNotMatch((await bar.getAttribute('class'))!, /overridden/);
            assert.doesNotMatch((await lab.getAttribute('class'))!, /changed/);
            assert.match((await lab.locator('button.on').textContent())!, /끄기/);

            await lab.locator('button:has-text("켜기")').click();
            await frame.locator('#lab:has-text("true")').waitFor();
            await chooseScreen(p, '/home');
            await frame.locator('#path:has-text("/home")').waitFor();
            assert.equal(await frame.locator('#lab').textContent(), 'true');
            assert.equal(await bar.isVisible(), true);
            assert.match((await bar.locator('.others').textContent())!, /SYSTEM\.LAB_ENABLED = true/);

            await bar.locator('button:has-text("기본값으로")').click();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
            assert.equal(await bar.isHidden(), true);
            assert.ok(requests.every((r) => !r.includes('settings')));

            await chooseScreen(p, '/lab/result');
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.equal(await settingRow(p, 'SYSTEM.LAB_ENABLED').getAttribute('title'), '/lab#Lab 에서 물려받음');
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting whose default the source does not show in full is written as the screen needs, even when the reviewer changed it and came back', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', '    LAB_ENABLED: false,', '    LAB_ENABLED: window.LAB_DEFAULT ?? true,');
        rewrite(copy, 'client/src/Routes.js', '{globalSettings.SYSTEM.LAB_ENABLED ? <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact /> : null}',
          '{globalSettings.SYSTEM.LAB_ENABLED ? null : <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact />}');
        rewrite(copy, 'client/src/components/Home.js', '{globalSettings.SYSTEM.LAB_ENABLED && <Link', '{<Link');
        rewrite(copy, 'build/app.js', 'LAB_ENABLED: false,', 'LAB_ENABLED: true,');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#lab:has-text("false")').waitFor();
            const off = [{ path: ['SYSTEM', 'LAB_ENABLED'], value: false }];
            assert.deepEqual(await overridesOf(base), off);

            await settingRow(p, 'SYSTEM.LAB_ENABLED').locator('button:has-text("켜기")').click();
            await frame.locator('#lab:has-text("true")').waitFor();
            await chooseScreen(p, '/home');
            await frame.locator('#path:has-text("/home")').waitFor();
            await chooseScreen(p, '/lab');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), off);

            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            await lab.locator('button:has-text("켜기")').click();
            await frame.locator('#lab:has-text("true")').waitFor();
            await lab.locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), off);
          }),
        );
      }),
    ),
  );
});

test('in a browser, picking in the select the value a setting seems to have keeps it written when its section is not shown in full', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', '    LAB_ENABLED: false,', "    LAB_ENABLED: false,\n    MODE: 'a',\n    ...window.EXTRA,");
        rewrite(copy, 'client/src/Routes.js', '{globalSettings.SYSTEM.LAB_ENABLED ? <Route', "{globalSettings.SYSTEM.MODE === 'a' ? <Route");
        rewrite(copy, 'client/src/components/Home.js', '{globalSettings.SYSTEM.LAB_ENABLED && <Link', '{<Link');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const modeA = [{ path: ['SYSTEM', 'MODE'], value: 'a' }];
            await p.waitForFunction(() => document.querySelector('#settings-bar .setting.changed'));
            assert.deepEqual(await overridesOf(base), modeA);
            const select = settingRow(p, 'SYSTEM.MODE').locator('select');
            assert.doesNotMatch((await select.locator('option').first().textContent())!, /"a"/);

            await select.selectOption({ index: 0 });
            await p.waitForFunction(() => !document.querySelector('#settings-bar .setting.changed'));
            await select.selectOption('"a"');
            await p.waitForFunction(() => document.querySelector('#settings-bar .setting.changed'));
            assert.deepEqual(await overridesOf(base), modeA);
          }),
        );
      }),
    ),
  );
});

test('in a browser, coming back to a screen whose setting the reviewer took away puts the unchanged value back instead of recording a change', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#menu:has-text("ADMIN_REPORT")').waitFor();
            const entry = settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST');
            await entry.locator('input').uncheck();
            await frame.locator('#menu', { hasText: /^ADMIN_ARCHIVE$/ }).waitFor();

            await chooseScreen(p, '/home');
            await frame.locator('#path:has-text("/home")').waitFor();
            await chooseScreen(p, '/admin/report');
            await frame.locator('#menu:has-text("ADMIN_REPORT")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
            assert.doesNotMatch((await p.locator('#settings-bar').getAttribute('class'))!, /overridden/);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting the reviewer changed stays changed when the frame reopens the same screen as another account', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#lab:has-text("true")').waitFor();
            await settingRow(p, 'SYSTEM.LAB_ENABLED').locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();

            await p.locator('#center .frame-bar select.role').selectOption('account');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await p.waitForFunction(() => document.querySelector('#center iframe.app')?.getAttribute('src'));
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting the reviewer changed on a screen with path variables stays changed when another role\'s values are loaded', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPasswords(ALL_PASSWORDS, () =>
      withRebuiltFixture({ app: { ...roleSettings(api).app, login: loginWithHeader, settingsFile: SETTINGS_FILE, pathValues: { '/document/:id': { id: LIST_API } } } }, async (config, copy) => {
        rewrite(copy, 'client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />',
          '{globalSettings.SYSTEM.LAB_ENABLED && <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />}');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/document/:id');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/17")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            await settingRow(p, 'SYSTEM.LAB_ENABLED').locator('button:has-text("끄기")').click();
            await frame.locator('#lab:has-text("false")').waitFor();

            await p.locator('#center .frame-bar select.role').selectOption('role:ADMIN');
            await frame.locator('#path:has-text("/document/27")').waitFor();
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.deepEqual(await overridesOf(base), []);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a screen that falls back to its list screen sets what the list screen needs', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api, { pathValues: { '/document/:tab(draft|done)': { tab: 'draft' } } }), async (config, copy) => {
        rewrite(copy, 'client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />',
          '{globalSettings.SYSTEM.LAB_ENABLED && <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />}');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/document/:id');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/draft")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.match((await p.locator('#center .frame-bar').textContent())!, /목록에서 골라 들어가세요/);
            assert.match((await settingRow(p, 'SYSTEM.LAB_ENABLED').getAttribute('class'))!, /changed/);
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
          }),
        );
      }),
    ),
  );
});

test('in a browser, path values that arrive after the reviewer moved to the story list neither draw the screen over the story nor change settings', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ ...withSettingsFile(api, { pathValues: { '/document/:tab(draft|done)': { tab: 'draft' } } }), storiesDir: 'example-stories' }, async (config, copy) => {
        rewrite(copy, 'client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />',
          '{globalSettings.SYSTEM.LAB_ENABLED && <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:tab(draft|done)`} component={waitFor(DocumentList)} exact />}');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            let release!: () => void;
            const held = new Promise<void>((resolve) => (release = resolve));
            await p.route('**/api/path-values?*', async (route) => {
              await held;
              await route.continue();
            });
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/document/:id');
            await p.click('#left .views.side button:has-text("스토리")');
            release();
            await p.waitForFunction(() => state.pathValues.get(pathValueKey('/document/:id#DocumentDetail', null))?.pending === false);
            const arrived = await p.evaluate(() => state.pathValues.get(pathValueKey('/document/:id#DocumentDetail', null)));
            assert.deepEqual([arrived.errors, arrived.fallbackPath], [[], '/document/draft']);
            await p.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))));
            assert.equal(await p.textContent('#center h3'), '홈에서 개인 설정을 바꾼다');
            assert.equal(await p.locator('#center iframe').count(), 0);
            assert.deepEqual(await overridesOf(base), []);

            await p.click('#left .views.side button:has-text("화면")');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/document/draft")').waitFor();
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a screen reached through a menu built from a settings list takes the menu entry out and back with 「목록에 넣기」', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/admin/report")').waitFor();
            assert.equal(await frame.locator('#menu').textContent(), 'ADMIN_REPORT,ADMIN_ARCHIVE');
            assert.deepEqual(await overridesOf(base), []);

            const entry = settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST');
            assert.match((await entry.textContent())!, /"ADMIN_REPORT".*목록에 넣기/);
            assert.equal(await entry.locator('input[type=checkbox]').isChecked(), true);
            assert.match((await settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN').textContent())!, /기본값에 있음/);

            await entry.locator('input[type=checkbox]').uncheck();
            await frame.locator('#menu:has-text("ADMIN_ARCHIVE")').waitFor();
            await p.waitForFunction(() => document.querySelector('#settings-bar .setting.changed'));
            assert.equal(await frame.locator('#menu').textContent(), 'ADMIN_ARCHIVE');
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'MAIN_MENU', 'ADMIN', 'LIST'], item: 'ADMIN_REPORT', value: false }]);
            assert.match((await entry.getAttribute('class'))!, /changed/);

            await entry.locator('input[type=checkbox]').check();
            await frame.locator('#menu:has-text("ADMIN_REPORT,ADMIN_ARCHIVE")').waitFor();
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting in a section the app does not take from the settings file cannot be changed and says why', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ app: { ...appSettings(api).app, settingsFile: { ...SETTINGS_FILE, merged: ['CUSTOM'] } } }, (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/lab")').waitFor();
            const lab = settingRow(p, 'SYSTEM.LAB_ENABLED');
            assert.match((await lab.locator('.reason').textContent())!, /SYSTEM 섹션을 읽지 않아 바꿀 수 없습니다/);
            assert.equal(await lab.locator('button:has-text("켜기")').isDisabled(), true);
            assert.equal(await frame.locator('#lab').textContent(), 'false');
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a setting read through another settings root and a guard whose value cannot be worked out show why they cannot be changed, and the first link that can be satisfied is', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture({ settingsRoots: ['globalSettings', 'appSettings'], ...withSettingsFile(api) }, async (config, copy) => {
        rewrite(copy, 'client/src/components/Home.js', '{globalSettings.SYSTEM.LAB_ENABLED && <Link', '{appSettings.SYSTEM.LAB_ENABLED && <Link');
        rewrite(copy, 'client/src/components/DocumentDetail.js', '{helpEnabled && <Link', '{helpEnabled !== false && <Link');
        fs.writeFileSync(path.join(copy, 'build/settings.js'), 'window.FAKE_SETTINGS = {};\n');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#lab:has-text("true")').waitFor();
            const rows = settingRow(p, 'SYSTEM.LAB_ENABLED');
            assert.equal(await rows.count(), 2);
            assert.equal(await rows.nth(0).locator('button:has-text("끄기")').isDisabled(), false);
            assert.match((await rows.nth(1).locator('.reason').textContent())!, /appSettings 로 읽는 설정이라/);
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);

            await chooseScreen(p, '/help');
            await p.waitForFunction(() => document.querySelectorAll('#settings-bar > .setting.changed').length === 1 && document.querySelector('#settings-bar .others'));
            const unreadable = settingRow(p, 'helpEnabled !== false');
            assert.match((await unreadable.locator('.reason').textContent())!, /같지 않음/);
            assert.match((await unreadable.getAttribute('title'))!, /\/document\/:id#DocumentDetail/);
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }, { path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: true }]);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a setting the settings file already turns on shows as on, a need for it off writes false, and setting it back to the file value drops the change', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/components/DocumentDetail.js', '{helpEnabled && <Link', '{!helpEnabled && <Link');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/help');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#help:has-text("false")').waitFor();
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'HELP_LINK_ENABLED'], value: false }]);
            const help = settingRow(p, 'SYSTEM.HELP_LINK_ENABLED');
            assert.match((await help.getAttribute('class'))!, /changed/);
            assert.match((await help.locator('button.on').textContent())!, /끄기/);

            await help.locator('button:has-text("켜기")').click();
            await frame.locator('#help:has-text("true")').waitFor();
            await p.waitForFunction(() => !document.querySelector('#settings-bar .setting.changed'));
            assert.deepEqual(await overridesOf(base), []);
            assert.match((await help.locator('button.on').textContent())!, /켜기/);

            fs.writeFileSync(path.join(copy, 'build/settings.js'), 'window.FAKE_SETTINGS = { SYSTEM: { HELP_LINK_ENABLED: document.title !== null } };\n');
            await p.reload();
            await toList(p);
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            await p.waitForSelector('#settings-bar .file-error');
            assert.match((await p.locator('#settings-bar .file-error').textContent())!, /맵의 기본값으로 판단합니다.*document/);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a list inside a default the source does not show in full cannot be changed unless the settings file sets it, and says why', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },", "ADMIN: { LIST: ['ADMIN_REPORT', 'ADMIN_ARCHIVE'] },\n      USER: window.INTO_USER_MENU || {},");
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const entry = settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST');
            await entry.waitFor();
            assert.match((await entry.locator('.reason').textContent())!, /SYSTEM\.MAIN_MENU 기본값을 소스에서 다 읽지 못해/);
            assert.equal(await entry.locator('input[type=checkbox]').isDisabled(), true);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a setting that only has to be present is not met by an empty default', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), async (config, copy) => {
        rewrite(copy, 'client/src/store/settings.js', '    LAB_ENABLED: false,\n', "    LAB_ENABLED: false,\n    BANNER: '',\n");
        rewrite(copy, 'client/src/Routes.js', '{globalSettings.SYSTEM.LAB_ENABLED ? <Route', '{globalSettings.SYSTEM.BANNER ? <Route');
        rebuild(copy);
        await withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/lab');
            const banner = settingRow(p, 'SYSTEM.BANNER');
            await banner.waitFor();
            assert.doesNotMatch((await banner.textContent())!, /기본값에 있음/);
            assert.match((await banner.locator('.reason').textContent())!, /넣을 수 없습니다/);
          }),
        );
      }),
    ),
  );
});

test('in a browser, a failed settings change is shown until another screen is chosen', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await p.route('**/api/settings', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'settings store down' }));
            await chooseScreen(p, '/lab');
            await p.waitForSelector('#settings-bar .error:has-text("설정을 바꾸지 못했습니다")');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/lab")').waitFor();
            await p.unroute('**/api/settings');

            await chooseScreen(p, '/admin/report');
            await frame.locator('#path:has-text("/admin/report")').waitFor();
            await settingRow(p, 'SYSTEM.MAIN_MENU.ADMIN.LIST').waitFor();
            assert.equal(await p.locator('#settings-bar .error').count(), 0);
            assert.deepEqual(await overridesOf(base), []);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, a settings change that throws is shown and does not stop the changes after it', { skip: browserMissing }, async () => {
  await withFakeApi((api) =>
    withPassword('s3cret', () =>
      withRebuiltFixture(withSettingsFile(api), (config) =>
        withServer(config, 'reviewer', (base) =>
          withPage(base, async (p) => {
            await p.waitForSelector('#screen-list li');
            await chooseScreen(p, '/admin/report');
            const frame = p.frameLocator('#center iframe.app');
            await frame.locator('#path:has-text("/admin/report")').waitFor();

            await p.evaluate(() => updateSettings(() => {
              throw new Error('change failed');
            }));
            await p.waitForSelector('#settings-bar .error:has-text("change failed")');
            await p.evaluate(() => updateSettings((list) => [...list, { path: ['SYSTEM', 'LAB_ENABLED'], value: true }]));
            await frame.locator('#lab:has-text("true")').waitFor();
            assert.deepEqual(await overridesOf(base), [{ path: ['SYSTEM', 'LAB_ENABLED'], value: true }]);
            assert.equal(await p.locator('#settings-bar .error').count(), 0);
          }),
        ),
      ),
    ),
  );
});

test('in a browser, without app settings the center column has no frame', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/home")');
        await p.waitForSelector('#center table');
        assert.equal(await p.locator('#center iframe').count(), 0);
        assert.equal(await p.locator('#center .frame-bar').count(), 0);
      }),
    ),
  );
});

test('in a browser, a screen shows the unit tests that import its source files apart from its own tests', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const help = p.locator('#screen-list li:has-text("/help")');
        assert.equal(await help.locator('.importer-count').textContent(), '불러옴 2');
        assert.deepEqual(await p.locator('#screen-list li:has-text("/document/:id") .count').allTextContents(), ['테스트 11', '불러옴 1']);

        await help.click();
        const ownCount = (await p.textContent('#center tbody tr:first-child td:nth-child(2)'))!;
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
        assert.deepEqual(await p.locator('#center .importers .test').allTextContents(), [
          '코드통과 renders the help text components/Help.spec.js:4불러오는 파일 components/Help.js',
          '코드통과 shows the day the help was last updated components/Help.spec.js:8불러오는 파일 components/Help.js',
        ]);
        assert.match(ownCount, /^테스트 \d+개$/);
        assert.doesNotMatch((await p.textContent('#center table'))!, /renders the help text/);

        await p.click('#screen-list li:has-text("/admin/member")');
        assert.equal(await p.locator('#center .importers').count(), 0);
      })));
});

const HOME = '/home#Home';
const LAB = '/lab#Lab';
const LAB_RESULT = '/lab/result#LabResult';
const OWNER_ROLE = { guard: "memberRole === 'OWNER'", kinds: ['role'], roles: ['OWNER'] };
const UNREAD_ROLE = { guard: 'canManage(member)', kinds: ['role'], roles: null };
const UNREAD_SETTING = { guard: 'settingOf(key)', kinds: ['setting'], settings: null, settingsReason: '설정 키를 읽지 못했습니다' };
type Way = { file: string; line: number; conditions: Guard[] };
type Reach = { kind: 'route'; screen: string; file: string; line: number; guards: object[] } | { kind: 'link'; from: string; to: string; ways: Way[] } | { kind: 'start'; screen: string; kinds: string[]; roleValues: string[] | null };
const settingGuard = (guard: string, path: string[], need: string, value?: unknown, root = 'globalSettings') => ({ guard, kinds: ['setting'], settings: [{ root, path, need, ...(value === undefined ? {} : { value }) }] });
const LAB_OFF = settingGuard('!globalSettings.SYSTEM.LAB_ENABLED', ['SYSTEM', 'LAB_ENABLED'], 'off');
const reachRoute = (guards: object[], screen = LAB): Reach => ({ kind: 'route', screen, file: 'Routes.js', line: 44, guards });
const reachLink = (...ways: Guard[][]): Reach => ({ kind: 'link', from: HOME, to: LAB, ways: ways.map((conditions, i) => ({ file: 'components/Home.js', line: 19 + i, conditions })) });

async function withStoryReach(reach: Reach[], fn: (p: Page) => Promise<void>, { access = {} }: { access?: Record<string, object> } = {}) {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const data: PageData = await (await route.fetch()).json();
          const screen = (id: string) => data.map.screens.find((s) => s.id === id)!;
          data.stories.list.find((s) => s.id === 'run-lab')!.reach = reach;
          for (const r of reach.filter((x) => x.kind === 'link')) {
            assert.ok(r.ways.every((w) => w.conditions.every((g) => !g.via)), 'a link step with inherited conditions needs a rebuilt map');
            const to = screen(r.to);
            to.access.links = [...to.access.links.filter((l) => l.from !== r.from), ...r.ways.map((w) => ({ from: r.from, file: w.file, line: w.line, guards: w.conditions.filter((g) => g.kinds.length), fromKinds: [] }))];
          }
          for (const [id, patch] of Object.entries(access)) Object.assign(screen(id).access, patch);
          await route.fulfill({ json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        await fn(p);
      }),
    ),
  );
}

async function withStoryMap(edits: [string, string, string][], story: string, fn: (p: Page) => Promise<void>) {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click(`#story-list li:has-text("${story}")`);
        await fn(p);
      }),
    ), edits);
}

const RUN_LAB = '실험실을 열어';
const READ_REPORTS = '관리자가 보고서를 본다';
const storyScreens = (screens: string[]): [string, string, string] => ['example-stories/read-reports.json', '["/admin/report#AdminReport"]', JSON.stringify(screens)];
const LAB_FILE = 'client/src/components/Lab.js';
const resultHandler = (buttons: (string | null)[], body = 'history.push(Option.ROUTE_PATH.LAB_RESULT)'): [string, string, string][] => [
  [LAB_FILE, "import { Link } from 'react-router-dom';", "import { useHistory } from 'react-router-dom';"],
  [LAB_FILE, 'export default function Lab() {', `export default function Lab({ memberRole, globalSettings, loaded }) {\n  const history = useHistory();\n  const openResult = () => ${body};`],
  [LAB_FILE, '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>', buttons.map((guard, i) => {
    const button = `<button type="button" onClick={openResult}>Results ${i}</button>`;
    return guard ? `{${guard} && ${button}}` : button;
  }).join('\n      ')],
];

const readSummary = (p: Page) => p.locator('#right .reach-summary').evaluate((el) => {
  const text = (e: Element) => [...e.childNodes].map((c) => c.textContent).join(' ');
  return {
    lines: [...el.querySelectorAll(':scope > .need, :scope > .step-roles > li, :scope > .none')].map(text),
    leftOut: [...el.querySelectorAll(':scope > .left-out li')].map(text),
  };
});

test('in a browser, a story that needs a setting and a role shows them as two summary lines under 사전 조건 in the wording of the screen summary, and the raw conditions only once the fold is opened', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LAB_SETTING]), reachRoute([LAB_SETTING, ADMIN_ROLE])], async (p) => {
    assert.deepEqual(await p.locator('#right-info > :not(.talk-scope)').evaluateAll((els) => els.slice(0, 3).map((e) => e.textContent.slice(0, 5))), ['도달 가능', '사전 조건', '역할 AD']);
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
    assert.equal(await p.locator('#right details.reach-raw').evaluate((d: HTMLDetailsElement) => d.open), false);
    assert.equal(await p.locator('#right .reach-raw .reach').isVisible(), false);
    assert.equal(await p.locator('#right .reach-summary .reach').count(), 0);
    await p.click('#right .reach-raw > summary');
    assert.equal(await p.locator('#right .reach-raw .reach').isVisible(), true);
    assert.match((await p.textContent('#right .reach-link'))!, /components\/Home\.js:19.*globalSettings\.SYSTEM\.LAB_ENABLED/);
    assert.match((await p.textContent('#right .reach-route'))!, /Routes\.js:44.*memberRole === 'ADMIN'/);
    assert.equal(await p.locator('#right-info .mark-form').count(), 0);
    assert.equal(await p.locator('#right-dock > .mark-form').count(), 1);
  });
});

test('in a browser, a condition that sits on several steps of a story is in the summary once', { skip: browserMissing }, async () => {
  await withStoryMap([], RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트']);
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE]), reachRoute([LAB_SETTING, ADMIN_ROLE, UNREAD_ROLE]), reachRoute([UNREAD_ROLE, ADMIN_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
});

test('in a browser, a condition inherited from a handler counts in the story summary when the link has no condition of its own and the handler is used in one place under that one condition', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'"]), RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트', '/lab → /lab/result']);
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
});

test('in a browser, a link whose handler is also used without a role condition adds no role to the story summary, while the fold still shows the role condition as written', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'", 'loaded']), RUN_LAB, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /lab', '/lab 라우트', '/lab → /lab/result']);
    assert.match((await p.locator('#right .reach-link').nth(1).textContent())!, /memberRole === 'ADMIN'/);
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
});

test('in a browser, conditions inherited from a handler used in several places, or next to a condition of the link itself, are not counted as needed nor as contradicting, and are listed apart with the handler that carries them', { skip: browserMissing }, async () => {
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'", "memberRole === 'OWNER'"]), RUN_LAB, async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['역할 미확인 (/lab → /lab/result)', "openResult 를 쓰는 곳에 따라 다른 조건: memberRole === 'ADMIN', memberRole === 'OWNER'"],
    });
  });
  await withStoryMap(resultHandler(['globalSettings.SYSTEM.LAB_ENABLED', '!globalSettings.SYSTEM.LAB_ENABLED']), RUN_LAB, async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['openResult 를 쓰는 곳에 따라 다른 조건: globalSettings.SYSTEM.LAB_ENABLED, !globalSettings.SYSTEM.LAB_ENABLED'],
    });
  });
  await withStoryMap(resultHandler(["memberRole === 'ADMIN'", null], 'globalSettings.SYSTEM.LAB_ENABLED && history.push(Option.ROUTE_PATH.LAB_RESULT)'), RUN_LAB, async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['역할 미확인 (/lab → /lab/result)', "openResult 를 쓰는 곳에 따라 다른 조건: memberRole === 'ADMIN'"],
    });
  });
});

test('in a browser, a story whose only conditions are inherited from a handler used in several places does not say that nothing blocks it', { skip: browserMissing }, async () => {
  const home = 'client/src/components/Home.js';
  const edits: [string, string, string][] = [
    [home, "import { Link } from 'react-router-dom';", "import { Link, useHistory } from 'react-router-dom';"],
    [home, "const isAdmin = memberRole === 'ADMIN';", "const isAdmin = memberRole === 'ADMIN';\n  const history = useHistory();\n  const openAudit = () => history.push(Option.ROUTE_PATH.ADMIN_AUDIT);"],
    [home, "{session['member.role'] === 'AUDITOR' && <Link to={Option.ROUTE_PATH.ADMIN_AUDIT}>Audit</Link>}",
      '{globalSettings.SYSTEM.MODE_ON && <button type="button" onClick={openAudit}>Audit</button>}\n      {!globalSettings.SYSTEM.MODE_ON && <button type="button" onClick={openAudit}>Log</button>}'],
    storyScreens(['/home#Home', '/admin/audit#AdminAudit']),
  ];
  await withStoryMap(edits, READ_REPORTS, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['/home → /admin/audit']);
    assert.deepEqual(await readSummary(p), { lines: [], leftOut: ['openAudit 를 쓰는 곳에 따라 다른 조건: globalSettings.SYSTEM.MODE_ON, !globalSettings.SYSTEM.MODE_ON'] });
  });
});

test('in a browser, the first screen of a story needs from its incoming links only what every one of them needs, and is different per link when they need different settings', { skip: browserMissing }, async () => {
  await withStoryMap([storyScreens(['/help#Help'])], READ_REPORTS, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['첫 화면 /help']);
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.HELP_LINK_ENABLED 켬'], leftOut: [] });
  });
  const signIn: [string, string, string] = ['client/src/components/SignIn.js', 'globalSettings.SYSTEM.HELP_LINK_ENABLED &&', 'globalSettings.SYSTEM.LAB_ENABLED &&'];
  await withStoryMap([signIn, storyScreens(['/help#Help'])], READ_REPORTS, async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['첫 화면 /help 링크마다 다름'], leftOut: [] });
  });
  const either: [string, string, string][] = [
    [LAB_FILE, 'export default function Lab() {', 'export default function Lab({ globalSettings }) {'],
    [LAB_FILE, '<Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link>',
      '{globalSettings.SYSTEM.MODE_ON ? <Link to={Option.ROUTE_PATH.LAB_RESULT}>Results</Link> : <Link to={Option.ROUTE_PATH.LAB_RESULT}>Back</Link>}'],
    storyScreens(['/lab/result#LabResult']),
  ];
  await withStoryMap(either, READ_REPORTS, async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['첫 화면 /lab/result 링크마다 다름'], leftOut: [] });
  });
});

test('in a browser, the first screen of a story whose incoming link carries a role condition inherited from a handler that is also used without it does not present the roles of the map as complete', { skip: browserMissing }, async () => {
  const edits = [...resultHandler(["memberRole === 'ADMIN'", null], 'globalSettings.SYSTEM.LAB_ENABLED && history.push(Option.ROUTE_PATH.LAB_RESULT)'), storyScreens(['/lab/result#LabResult'])];
  await withStoryMap(edits, READ_REPORTS, async (p) => {
    assert.deepEqual(await p.locator('#right .reach > li h3').allTextContents(), ['첫 화면 /lab/result']);
    assert.deepEqual(await readSummary(p), {
      lines: ['역할 ADMIN 미확인 1', '설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['역할 일부만 읽음 (첫 화면 /lab/result)', "openResult 를 쓰는 곳에 따라 다른 조건: memberRole === 'ADMIN'"],
    });
  });
});

test('in a browser, a story step that several links reach needs in the summary only what every link needs, and is different per link only when no link needs exactly that', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE], [LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  const isAdmin = { guard: 'isAdmin', kinds: ['role'], roles: ['ADMIN'] };
  await withStoryReach([reachLink([ADMIN_ROLE], [isAdmin])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN'], leftOut: [] });
  });
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE], [OWNER_ROLE, LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 또는 OWNER', '설정 SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  await withStoryReach([reachLink([ADMIN_ROLE], [LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['/home → /lab 링크마다 다름'], leftOut: [] });
  });
  await withStoryReach([reachLink([LAB_SETTING, ADMIN_ROLE], [LAB_SETTING, LONG_SETTING]), reachRoute([LAB_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.LAB_ENABLED 켬', '/home → /lab 링크마다 다름'], leftOut: [] });
  });
});

test('in a browser, a story whose role was not read on one step does not present the role of the other steps as enough', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([UNREAD_ROLE]), reachRoute([ADMIN_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1'], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
  await withStoryReach([{ kind: 'start', screen: HOME, kinds: ['role'], roleValues: null }, reachRoute([ADMIN_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1'], leftOut: ['역할 미확인 (첫 화면 /home)'] });
  }, { access: { [HOME]: { restricted: true, kinds: ['role'], roleValues: null, unreadableRoleGuards: [] } } });
});

test('in a browser, a role condition that was not read on one of several links of a step neither hides what the other links prove nor shows as needed', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([ADMIN_ROLE, UNREAD_ROLE], [ADMIN_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN'], leftOut: [] });
  });
  await withStoryReach([reachLink([UNREAD_ROLE], [ADMIN_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 미확인 1'], leftOut: ['역할 일부만 읽음 (/home → /lab)'] });
  });
  await withStoryReach([reachLink([ADMIN_ROLE, UNREAD_ROLE], [OWNER_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 또는 OWNER 미확인 1'], leftOut: ['역할 일부만 읽음 (/home → /lab)'] });
  });
  await withStoryReach([reachLink([UNREAD_ROLE], [ADMIN_ROLE]), reachRoute([OWNER_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 OWNER 미확인 1'], leftOut: ['역할 일부만 읽음 (/home → /lab)'] });
  });
});

test('in a browser, a story whose steps allow roles that do not overlap says that no role passes every step and lists the roles of each step', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([ADMIN_ROLE]), reachRoute([OWNER_ROLE], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['모든 단계를 지나는 역할 없음', '/lab 라우트: 역할 ADMIN', '/lab/result 라우트: 역할 OWNER'], leftOut: [] });
  });
});

const MODE = ['SYSTEM', 'MODE'];
const modeIs = (value: unknown) => settingGuard(`globalSettings.SYSTEM.MODE === ${JSON.stringify(value)}`, MODE, 'equals', value);

test('in a browser, a story whose steps need the same setting both on and off, or with two different values, says those needs contradict each other instead of listing them as needed', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([LAB_SETTING, modeIs('A'), LONG_SETTING]), reachRoute([LAB_OFF, modeIs('B')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: [
      '설정 SYSTEM.MAIN_MENU.LAB.LIST 에 "LAB_EXPERIMENTS"',
      '서로 어긋나는 설정: SYSTEM.LAB_ENABLED 켬 / SYSTEM.LAB_ENABLED 끔',
      '서로 어긋나는 설정: SYSTEM.MODE = "A" / SYSTEM.MODE = "B"',
    ], leftOut: [] });
  });
});

test('in a browser, a setting needed off contradicts the same setting needed present, holding a value or equal to a true value, and only the needs that contradict leave the need lines', { skip: browserMissing }, async () => {
  const modeOff = settingGuard('!globalSettings.SYSTEM.MODE', MODE, 'off');
  const modeHas = settingGuard("globalSettings.SYSTEM.MODE includes 'A'", MODE, 'includes', 'A');
  const modePresent = settingGuard('globalSettings.SYSTEM.MODE', MODE, 'present');
  await withStoryReach([reachRoute([modeOff]), reachRoute([modeIs('A')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['서로 어긋나는 설정: SYSTEM.MODE 끔 / SYSTEM.MODE = "A"'], leftOut: [] });
  });
  await withStoryReach([reachRoute([modeOff]), reachRoute([modeHas, modePresent], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['서로 어긋나는 설정: SYSTEM.MODE 끔 / SYSTEM.MODE 에 "A" / SYSTEM.MODE 있음'], leftOut: [] });
  });
  const modeOn = settingGuard('globalSettings.SYSTEM.MODE', MODE, 'on');
  await withStoryReach([reachRoute([modeOn]), reachRoute([modeIs('A'), modeIs('B')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.MODE 켬', '서로 어긋나는 설정: SYSTEM.MODE = "A" / SYSTEM.MODE = "B"'], leftOut: [] });
  });
});

test('in a browser, setting needs that a loose comparison can satisfy together are not called a contradiction', { skip: browserMissing }, async () => {
  const modeOn = settingGuard('globalSettings.SYSTEM.MODE', MODE, 'on');
  await withStoryReach([reachRoute([modeOn]), reachRoute([modeIs(0)], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.MODE 켬', '설정 SYSTEM.MODE = 0'], leftOut: [] });
  });
  await withStoryReach([reachRoute([modeIs(1)]), reachRoute([modeIs('1')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 SYSTEM.MODE = 1', '설정 SYSTEM.MODE = "1"'], leftOut: [] });
  });
});

test('in a browser, a story whose settings come from two settings roots names the root of each setting and keeps the same path of two roots apart', { skip: browserMissing }, async () => {
  const appLab = (need: string) => settingGuard(`${need === 'off' ? '!' : ''}appSettings.SYSTEM.LAB_ENABLED`, ['SYSTEM', 'LAB_ENABLED'], need, undefined, 'appSettings');
  await withStoryReach([reachRoute([appLab('on')]), reachRoute([LAB_SETTING], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 appSettings.SYSTEM.LAB_ENABLED 켬', '설정 globalSettings.SYSTEM.LAB_ENABLED 켬'], leftOut: [] });
  });
  await withStoryReach([reachRoute([appLab('on')]), reachRoute([LAB_OFF], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정 appSettings.SYSTEM.LAB_ENABLED 켬', '설정 globalSettings.SYSTEM.LAB_ENABLED 끔'], leftOut: [] });
  });
  await withStoryReach([reachRoute([appLab('on')]), reachRoute([appLab('off')], LAB_RESULT)], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['서로 어긋나는 설정: SYSTEM.LAB_ENABLED 켬 / SYSTEM.LAB_ENABLED 끔'], leftOut: [] });
  });
});

test('in a browser, a story whose conditions are neither a setting nor a role says that no setting or role blocks it', { skip: browserMissing }, async () => {
  const loaded = { guard: 'loaded', kinds: [] };
  await withStoryReach([reachLink([loaded])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['설정이나 역할로 막는 조건 없음'], leftOut: [] });
  });
});

test('in a browser, the story summary names every role and every setting in full', { skip: browserMissing }, async () => {
  const adminOrOwner = { guard: "['ADMIN', 'OWNER'].includes(memberRole)", kinds: ['role'], roles: ['ADMIN', 'OWNER'] };
  await withStoryReach([reachRoute([LAB_SETTING, LONG_SETTING, adminOrOwner])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: ['역할 ADMIN 또는 OWNER', '설정 SYSTEM.LAB_ENABLED 켬', '설정 SYSTEM.MAIN_MENU.LAB.LIST 에 "LAB_EXPERIMENTS"'], leftOut: [] });
  });
});

test('in a browser, story conditions that the summary cannot state are listed apart from it under their own heading, outside the fold', { skip: browserMissing }, async () => {
  await withStoryReach([reachRoute([LAB_SETTING, UNREAD_ROLE, UNREAD_SETTING])], async (p) => {
    assert.deepEqual(await readSummary(p), {
      lines: ['설정 SYSTEM.LAB_ENABLED 켬'],
      leftOut: ['읽지 못한 역할 조건: canManage(member)', '정하지 못한 설정 조건: settingOf(key) (설정 키를 읽지 못했습니다)'],
    });
    const leftOut = p.locator('#right .reach-summary .left-out');
    assert.equal(await leftOut.locator(':scope > :first-child').textContent(), '요약에 넣지 못한 조건');
    assert.equal(await leftOut.locator('xpath=ancestor::details').count(), 0);
    assert.equal(await leftOut.isVisible(), true);
  });
  await withStoryReach([reachRoute([UNREAD_ROLE])], async (p) => {
    assert.deepEqual(await readSummary(p), { lines: [], leftOut: ['읽지 못한 역할 조건: canManage(member)'] });
  });
});

test('in a browser, the fold of a story\'s raw conditions and its long conditions stay open when the right pane is redrawn, and close again on another story', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LONG_SETTING]), reachRoute([LONG_SETTING, LAB_SETTING])], async (p) => {
    assert.equal(await p.locator('#right .reach-raw details.long-guard').count(), 2);
    await p.click('#right .reach-raw > summary');
    await p.locator('#right .reach-link .long-guard > summary').click();
    const openState = () => p.locator('#right').evaluate((r) => ({
      fold: r.querySelector<HTMLDetailsElement>('details.reach-raw')!.open,
      long: [...r.querySelectorAll<HTMLDetailsElement>('details.long-guard')].map((g) => g.open),
    }));
    const expected = { fold: true, long: [true, false] };
    assert.deepEqual(await openState(), expected);
    await p.click('#right .statuses button:has-text("더 필요")');
    assert.deepEqual(await openState(), expected);
    await p.fill('#right-dock textarea', 'redraw');
    await p.click('#right button.save');
    await openHistory(p);
    await p.waitForSelector('#right .history li:has-text("redraw")');
    assert.deepEqual(await openState(), expected);
    await p.click('#story-list li:has-text("보고서")');
    await p.click('#story-list li:has-text("실험실을 열어")');
    assert.deepEqual(await openState(), { fold: false, long: [false, false] });
  });
});

test('in a browser, the story pane and the screen pane keep what is open apart: another story leaves a screen\'s link group open, and another screen leaves a story\'s fold open', { skip: browserMissing }, async () => {
  await withStoryReach([reachLink([LONG_SETTING]), reachRoute([LAB_SETTING])], async (p) => {
    const sideTab = (label: string) => p.click(`#left .views.side button:has-text("${label}")`);
    await sideTab('화면');
    await p.click('#screen-list li:has-text("/lab")');
    await openScreenInfo(p);
    await p.locator('#center details.link-group > summary').first().click();
    await sideTab('스토리');
    await p.click('#story-list li:has-text("보고서")');
    await p.click('#story-list li:has-text("실험실을 열어")');
    await sideTab('화면');
    assert.equal(await p.locator('#center details.link-group').first().evaluate((d: HTMLDetailsElement) => d.open), true);

    await sideTab('스토리');
    await p.click('#right .reach-raw > summary');
    await p.locator('#right .reach-link .long-guard > summary').click();
    const storyOpen = () => p.locator('#right').evaluate((r) => [r.querySelector<HTMLDetailsElement>('details.reach-raw')!.open, r.querySelector<HTMLDetailsElement>('.reach-link details.long-guard')!.open]);
    for (const step of [0, 1]) {
      await p.locator('#center .step.on-map').nth(step).click();
      await p.waitForSelector('#screen-list li.selected');
      await sideTab('스토리');
      assert.deepEqual(await storyOpen(), [true, true]);
    }
  });
});

const CHIP = '서버 대조 안 함';
const CHIP_EXPLANATION = '서버 API 목록(serverEndpoints)이 없거나 비어 있어 API 호출을 서버와 견주지 않았습니다. 목록을 채우고 duru rebuild 를 다시 하면 견줍니다.';

const withoutServerList = (fn: (config: Config, copy: string) => Promise<void>) => withRebuiltFixture({}, async (config, copy) => {
  fs.writeFileSync(path.join(copy, 'server-endpoints.txt'), '');
  fs.writeFileSync(path.join(copy, 'server-endpoints-lab.txt'), '');
  rebuild(copy);
  await fn(config, copy);
});

test('in a browser, with no server API list the header line carries a 「서버 대조 안 함」 chip in both views and nothing sits above the header', { skip: browserMissing }, async () => {
  await withoutServerList((config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const box = (sel: string) => p.evaluate((q) => { const r = document.querySelector(q)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; }, sel);
        assert.equal(await p.locator('#meta .state').isVisible(), true);
        assert.equal(await p.textContent('#meta .state'), CHIP);
        assert.match(await p.innerText('#meta'), /^화면 \d+ · 테스트 있는 화면 \d+ · 맵 .+ · 테스트 연결 .+서버 대조 안 함$/);
        assert.equal(await p.locator('#server-notice').count(), 0);
        assert.equal(await p.evaluate(() => document.body.firstElementChild!.tagName), 'HEADER');
        assert.equal((await box('header')).top, 0);
        assert.equal((await box('main')).top, (await box('header')).bottom);
        assert.equal((await box('main')).bottom, 900);
        assert.equal(await p.locator('input[name=dead]').count(), 0);
        assert.equal(await p.locator('#left input[type=checkbox]').count(), 5);

        await p.click('#screen-list li:has-text("/document/:tab")');
        assert.deepEqual(await p.locator('table.calls td.call .chip').allTextContents(), ['판정 불가', '대조 안 함']);
        assert.equal(await p.locator('table.calls td.call .chip.v-unchecked').count(), 1);
        assert.deepEqual(await p.locator('#center .list-absent').allTextContents(), ['서버 목록 없음']);
        assert.match((await p.textContent('#center h2:has(.list-absent)'))!, /^API 호출 \d+ 서버 목록 없음$/);
        await p.locator('table.calls tr:has(.chip.v-unchecked) td.cell').first().click();
        assert.match((await p.textContent('#center .call-info'))!, /서버 대조 목록 없음\s*대조 안 함/);
        assert.deepEqual(await p.locator('#center .call-info .list-absent').allTextContents(), ['목록 없음']);
        assert.equal(await p.textContent('#center .call-info h2:has(.list-absent)'), '서버 대조 목록 없음');
        const text = () => p.innerText('body');
        assert.doesNotMatch(await text(), /죽은 화면|서버에 없음/);

        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.equal(await p.locator('#meta .state').isVisible(), true);
        assert.equal(await p.locator('#server-notice').count(), 0);
        assert.equal((await box('#flow-bar')).top, (await box('header')).bottom);
        assert.equal((await box('main')).bottom, 900);
        await (await screenBox(p, '/document/:tab_draft_done_#DocumentList')).click();
        assert.equal(await p.locator('#center table.calls td.call .chip.v-unchecked').count(), 1, 'the picked screen\'s calls say they were not compared');
        assert.doesNotMatch(await text(), /죽은 화면|서버에 없음/);
      })));
});

test('in a browser, the 「서버 대조 안 함」 chip explains itself on hover and on keyboard focus, and the popover hangs below the header and stays 16 px inside the window at wide and narrow windows', { skip: browserMissing }, async () => {
  await withoutServerList((config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const chip = p.locator('#meta .state');
        const tip = p.locator('#server-state-tip');
        assert.equal(await chip.evaluate((el) => el.tagName), 'BUTTON');
        assert.equal(await chip.getAttribute('type'), 'button');
        assert.equal(await chip.getAttribute('tabindex'), null);
        assert.equal(await chip.getAttribute('aria-describedby'), 'server-state-tip');
        assert.equal(await chip.getAttribute('title'), null);
        assert.equal(await tip.getAttribute('role'), 'note');
        assert.equal(await tip.textContent(), CHIP_EXPLANATION);
        assert.equal(await tip.isVisible(), false);

        const inside = async (width: number) => {
          const r = await tip.evaluate((el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, h: innerHeight }; });
          assert.ok(r.left >= 16 && r.right <= width - 16 && r.bottom <= r.h, JSON.stringify(r));
          const chipLeft = await chip.evaluate((el) => el.getBoundingClientRect().left);
          assert.ok(Math.abs(r.left - Math.max(16, Math.min(chipLeft, width - 16 - (r.right - r.left)))) < 1, `${JSON.stringify(r)} chip ${chipLeft}`);
          const header = await p.evaluate(() => document.querySelector('header')!.getBoundingClientRect().bottom);
          assert.ok(r.top >= header, `popover ${r.top} sits over the header ${header}`);
          assert.equal(await p.evaluate(() => { const b = document.getElementById('server-state-tip')!.getBoundingClientRect(); return document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)!.closest('#server-state-tip') !== null; }), true);
        };

        for (const width of [1440, 1100, 800, 600]) {
          await p.setViewportSize({ width, height: 900 });
          await p.mouse.move(0, 400);
          assert.equal(await tip.isVisible(), false);
          await chip.hover();
          assert.equal(await tip.isVisible(), true, `hover at ${width}`);
          await inside(width);
          await p.mouse.move(0, 400);
          assert.equal(await tip.isVisible(), false);
          await chip.focus();
          assert.equal(await tip.isVisible(), true, `focus at ${width}`);
          await inside(width);
          await p.evaluate(() => (document.activeElement as HTMLElement).blur());
          assert.equal(await tip.isVisible(), false);
        }

        await p.setViewportSize({ width: 1440, height: 900 });
        await p.focus('#view-flow');
        await p.keyboard.press('Tab');
        assert.equal(await p.evaluate(() => document.activeElement!.className), 'chip state');
        assert.equal(await tip.isVisible(), true);
      })));
});

test('in a browser, with a server API list the page has no chip, no 「목록 없음」 note and keeps the dead-screen filter', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.locator('#meta .state, #server-state-tip, #server-notice').count(), 0);
        assert.doesNotMatch((await p.textContent('#meta'))!, /서버 대조 안 함/);
        assert.equal(await p.locator('input[name=dead]').count(), 1);
        assert.equal(await p.locator('#left input[type=checkbox]').count(), 6);
        await p.click('#screen-list li:has-text("/document/:tab")');
        assert.equal(await p.locator('.list-absent').count(), 0);
        assert.doesNotMatch((await p.textContent('#center'))!, /목록 없음/);
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box');
        assert.equal(await p.locator('#meta .state').count(), 0);
      })));
});

test('in a browser, a 「죽은 화면」 filter left checked does not hide every screen once the map is rebuilt without a server API list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config, copy) => {
    await withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.check('#left input[name=dead]');
        const dead = await p.locator('#screen-list li').count();
        assert.ok(dead > 0 && dead < 11, String(dead));

        fs.writeFileSync(path.join(copy, 'server-endpoints.txt'), '');
        fs.writeFileSync(path.join(copy, 'server-endpoints-lab.txt'), '');
        rebuild(copy);
        await p.click('#screen-list li >> nth=0');
        await p.click('#center tr:has-text("화면 전체")');
        await p.click('#right .statuses button:has-text("충분")');
        await p.click('#right button.save');
        await p.waitForSelector('#center tr.selected td.mark:has-text("충분")');

        assert.equal(await p.locator('#meta .state').isVisible(), true);
        assert.equal(await p.locator('input[name=dead]').count(), 0);
        assert.equal(await p.locator('#screen-list li').count(), 11);
      }));
  });
});

const TRACED = { tests: [
  { format: 'playwright', path: 'results/playwright', depth: 'ui' },
  { format: 'junit', path: 'results/junit', depth: 'api' },
  { format: 'vitest', path: 'results/vitest', depth: 'code' },
  { format: 'verdict', path: 'results/verdict/documents', depth: 'api' },
  { format: 'verdict', path: 'results/verdict/storage', depth: 'data' },
  { format: 'playwright', path: 'results/playwright-traced', depth: 'ui' },
] };

test('in a browser, a screen shows the untagged browser tests that passed through it under its own tests, the ones that checked something first, each with what it did there, its place and its result file', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const testedBefore = (await p.textContent('#meta'))!;
        const help = p.locator('#screen-list li:has-text("/help")');
        assert.equal(await help.locator('.passed-count').textContent(), '지나감 6');
        await help.click();
        assert.equal(await p.textContent('#center .passed h2'), '지나간 테스트 6');
        assert.deepEqual(await p.locator('#center .passed .test').evaluateAll((list) => list.map((el) => el.querySelector('.chip')!.textContent)), ['확인함', '조작함', '조작함', '조작함', '조작함', '지나감']);
        const first = (await p.textContent('#center .passed .test >> nth=0'))!;
        assert.match(first, /확인함 통과 follows a link while waiting for the new address visits\.spec\.ts:\d+ · chromium결과 파일 results\/playwright-traced\/visits\.json/);
        assert.deepEqual(await p.locator('#center .passed .pair-test').first().locator('.judge-row button').allTextContents(), ['제외', '포함']);
        assert.deepEqual(await p.$$eval('#center-body > table, #center .passed, #center .importers', (list) => list.map((el) => el.className || el.localName)), ['table', 'passed', 'importers']);
        assert.match(testedBefore, /테스트 있는 화면 7/);

        await p.click('#view-flow');
        assert.equal(await statusLine(await screenBox(p, '/help#Help')), '실패 · 불러옴 2 · 지나감 6');
      })));
});

test('in a browser, a call shows the untagged browser tests that sent it apart from its own tests: their number in its row, also with the screen picked in the flow, and each of them in its details', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await chooseScreen(p, '/home');
        const row = (id: string) => p.locator('table.calls tbody tr:not(.option)', { hasText: id });
        assert.equal(await row('GET:/api/v1/document/list').locator('.sent-count').textContent(), '호출함 1');
        assert.equal(await row('POST:/api/v1/archive/document').locator('.sent-count').count(), 0);
        assert.match((await row('GET:/api/v1/document/list').locator('td.cell').first().textContent())!, /^✓1\s*$/);

        await row('GET:/api/v1/document/list').locator('td.cell').first().click();
        const headings = await p.locator('#center .call-info h2').allTextContents();
        assert.deepEqual(headings.slice(headings.indexOf('테스트 1'), headings.indexOf('테스트 1') + 2), ['테스트 1', '호출한 테스트 1']);
        assert.equal(await p.locator('#center .call-info .passed .test').count(), 1);
        assert.match((await p.textContent('#center .call-info .passed .test'))!, /^호출함 통과 lists the documents calls\.spec\.ts:\d+ · chromium결과 파일 results\/playwright-traced\/calls\.json$/);
        assert.deepEqual(await p.locator('#center .call-info .passed .judge-row button').allTextContents(), ['제외', '포함']);

        await row('POST:/api/v1/archive/document').locator('td.cell').first().click();
        assert.equal(await p.locator('#center .call-info .passed').count(), 0);

        await p.click('#view-flow');
        await (await screenBox(p, '/home#Home')).click();
        assert.equal(await row('GET:/api/v1/document/list').locator('.sent-count').textContent(), '호출함 1');
      })));
});

test('in a browser, a screen with no tests of its own that browser tests passed through is kept by 「지나간 테스트만 있음」', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          delete data.tests.nodes['/document/:id#DocumentDetail'];
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.check('#left input[name="imported-only"]');
        assert.equal(await p.locator('#screen-list li').count(), 1);
        assert.equal(await p.locator('#screen-list li:has-text("/document/:id")').count(), 1);
      })));
});

const HELP_TEST = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'renders the help text' };

test('a judgment posted from the page is saved as a new file with the server-side author, and a discarded pair moves out of the screen\'s importing tests', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      assert.equal((await postJudgment(base, { test: HELP_TEST, node: '/help#Help', kind: 'discard' })).status, 400);
      const res = await postJudgment(base, { test: HELP_TEST, node: '/help#Help', kind: 'discard', reason: 'only renders a shared header', author: 'someone else' });
      assert.equal(res.status, 201);
      const { judgments } = loadJudgments(config.judgmentsDir);
      assert.deepEqual(judgments.map((j) => [j.test, j.node, j.kind, j.reason, j.author]), [[HELP_TEST, '/help#Help', 'discard', 'only renders a shared header', 'reviewer']]);

      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.tests.importers['/help#Help'].map((t) => t.title), ['shows the day the help was last updated']);
      assert.deepEqual(data.tests.discarded['/help#Help'].map((t) => [t.title, t.judgment.reason]), [['renders the help text', 'only renders a shared header']]);
      assert.equal(walkFlow(data.flow.roots).find((n) => n.id === '/help#Help')!.imported, 1);
    }),
  );
});

test('in a browser, the flow counts the importing tests again after a pair is discarded', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        const helpLine = async () => statusLine(await screenBox(p, '/help#Help'));
        assert.equal(await helpLine(), '실패 · 불러옴 2');

        await p.click('#view-list');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await excludeIn(first, 'only renders a shared header');
        await p.waitForSelector('#center .discarded');

        await p.click('#view-flow');
        assert.equal(await helpLine(), '실패 · 불러옴 1');
      }, { view: 'flow' })));
});

test('in a browser, a test importing a screen is discarded with a reason, stays discarded after a rebuild, and comes back when undone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await excludeIn(first, 'only renders a shared header');
        await p.waitForSelector('#center .discarded');

        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => [j.test, j.node, j.kind, j.reason, j.author]), [
          [HELP_TEST, '/help#Help', 'discard', 'only renders a shared header', 'reviewer'],
        ]);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 1');
        assert.equal(await p.locator('#screen-list li:has-text("/help") .importer-count').textContent(), '불러옴 1');
        assert.equal(await p.textContent('#center .discarded h2'), '제외한 짝 1');
        assert.match((await p.textContent('#center .discarded .importer'))!, /renders the help text.*only renders a shared header · \d/s);

        execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });
        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 1');

        await p.click('#center .discarded button.undo');
        await p.waitForSelector('#center .discarded', { state: 'detached' });
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
        assert.equal(await p.locator('#screen-list li:has-text("/help") .importer-count').textContent(), '불러옴 2');
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['discard', 'undo']);
      })));
});

test('in a browser, the window asking why a pair is excluded names the pair, and a discard without a reason cannot be sent', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        assert.equal(await p.locator(asked).isVisible(), false);
        await first.locator('button.discard').click();
        assert.equal(await p.locator(asked).evaluate((el) => el.matches(':modal')), true);
        assert.equal(await p.textContent(`${asked} h2`), '이 짝을 제외합니다');
        assert.match((await p.textContent(`${asked} .subject`))!, /테스트renders the help text.*Help\.spec\.js.*화면\/help Help/s);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '제외']);
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), true);

        await p.fill(why, '  \n ');
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), true);
        await p.press(why, 'Control+Enter');
        assert.equal(await p.locator(asked).isVisible(), true);
        assert.equal(fs.existsSync(config.judgmentsDir), false);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
      })));
});

test('in a browser, Enter breaks the line of the reason and Ctrl+Enter sends it without the blank ends, and the saved reason keeps its lines', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.locator('#center .importers .importer', { hasText: 'renders the help text' }).locator('button.discard').click();
        await p.keyboard.type(' only renders');
        await p.keyboard.press('Enter');
        await p.keyboard.type('a shared header');
        await p.keyboard.press('Enter');
        assert.equal(await p.inputValue(why), ' only renders\na shared header\n');
        assert.equal(fs.existsSync(config.judgmentsDir), false);

        await p.keyboard.press('Control+Enter');
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.reason), ['only renders\na shared header']);
        assert.equal(await p.locator('#center .discarded .memo').evaluate((el) => getComputedStyle(el).whiteSpace), 'pre-wrap');
      })));
});

const asked = '#reason-ask';
const why = `${asked} textarea`;
const askedFocused = (p: Page) => p.evaluate((sel) => document.activeElement!.matches(sel), why);

async function excludeIn(row: Locator, reason: string) {
  await row.locator('button.discard').click();
  await row.page().fill(why, reason);
  await row.page().click(`${asked} button.discard`);
}

async function excludePicked(p: Page, reason: string) {
  await p.click('#center .bulk-bar button.discard');
  await p.fill(why, reason);
  await p.click(`${asked} button.discard`);
}

const SAVE_REFUSED = ['Failed to load resource: the server responded with a status of 500 (Internal Server Error)'];

test('in a browser, a judgment that fails to save shows its error beside the test whose button was pressed, and each way of leaving that view clears it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.route('**/api/judgments', (route) => route.fulfill({ status: 500, body: 'disk full' }));
        const errorOf = () => p.evaluate(() => state.judgmentError);
        const second = p.locator('#center .importers .importer').nth(1);
        const failToSave = async () => {
          await second.locator('button.hand-over').click();
          await second.locator('.judgment-error').waitFor();
        };
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await failToSave();
        assert.equal(await p.locator('#center .judgment-error').count(), 1);
        assert.equal(await p.locator('#center .importers .importer').first().locator('.judgment-error').count(), 0);

        await p.click('#screen-list li:not(:has-text("/help"))');
        assert.equal(await errorOf(), null);
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await failToSave();
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#left .views.side button:has-text("화면")');
        assert.equal(await errorOf(), null);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await failToSave();
        await p.click('#center table tbody tr:has-text("테스트 ") >> nth=0');
        await p.locator('#center table tbody tr.selected').waitFor();
        assert.equal(await errorOf(), null);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
        assert.deepEqual(errors.splice(0), [...SAVE_REFUSED, ...SAVE_REFUSED, ...SAVE_REFUSED]);
      })));
});

test('in a browser, choosing a story clears a judgment error that failed to save while the story list was open', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        let held!: Route;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer').first();
        await first.locator('button.hand-over').click();
        await untilSet(() => held, 'the first judgment request');
        await p.click('#left .views.side button:has-text("스토리")');
        await held.fulfill({ status: 500, body: 'disk full' });
        await p.waitForFunction(() => state.judgmentError !== null);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        await p.click('#story-list li >> nth=0');
        assert.equal(await p.evaluate(() => state.judgmentError), null);
      })));
});

test('in a browser, a judgment that fails to save after another screen was selected still shows its error', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        let held!: Route;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer').first();
        await first.locator('button.hand-over').click();
        await untilSet(() => held, 'the first judgment request');
        await p.click('#screen-list li:not(:has-text("/help"))');
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
        await held.fulfill({ status: 500, body: 'disk full' });
        await p.locator('#center .judgment-error').waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.match((await p.textContent('#center .judgment-error'))!, /저장하지 못했습니다: disk full/);
        assert.equal(await p.locator('#center .judgment-error').count(), 1);

        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
      })));
});

test('in a browser, a pair included with one press waits for its tag apart from the importing tests, and comes back when undone', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        assert.deepEqual(await first.locator('.judge-row > *').allTextContents(), ['제외', '포함']);
        await first.locator('button.hand-over').click();
        await p.waitForSelector('#center .awaiting-tag');

        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => [j.test, j.node, j.kind, j.reason, j.author]), [
          [HELP_TEST, '/help#Help', 'hand-over', '', 'reviewer'],
        ]);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 1');
        assert.equal(await p.locator('#screen-list li:has-text("/help") .importer-count').textContent(), '불러옴 1');
        assert.equal(await p.textContent('#center .awaiting-tag h2'), '태그 대기 1');
        assert.match((await p.textContent('#center .awaiting-tag .importer'))!, /renders the help text/);
        assert.doesNotMatch((await p.textContent('#center .awaiting-tag .importer'))!, /reviewer/);
        assert.equal(await p.locator('#center .discarded').count(), 0);

        await p.click('#center .awaiting-tag button.undo');
        await p.waitForSelector('#center .awaiting-tag', { state: 'detached' });
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['hand-over', 'undo']);
      })));
});

test('in a browser, a hand-over saved with a note shows the note while it waits for its tag', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    addJudgment(config.judgmentsDir, { test: HELP_TEST, node: '/help#Help', kind: 'hand-over', reason: 'checks the help screen', author: 'earlier reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        assert.match((await p.textContent('#center .awaiting-tag .importer'))!, /renders the help text.*메모 checks the help screen.*earlier reviewer/s);
      }));
  });
});

test('in a browser, a hand-over whose test is no longer found shows apart and is closed by undoing it', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const gone = { source: 'results/vitest/client-unit.json', file: 'components/Help.spec.js', title: 'a title that was renamed' };
    addJudgment(config.judgmentsDir, { test: gone, node: '/help#Help', kind: 'hand-over', reason: 'was about the help text', author: 'someone' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .detached h2'), '떨어져 나감 1');
        assert.match((await p.textContent('#center .detached p.muted'))!, /결과에서 찾을 수 없/);
        assert.match((await p.textContent('#center .detached .importer'))!, /components\/Help\.spec\.js.*a title that was renamed.*was about the help text.*someone/s);
        assert.equal(await p.locator('#center .awaiting-tag').count(), 0);
        assert.equal(await p.textContent('#center .importers h2'), '불러오는 테스트 2');

        await p.click('#center .detached button.undo');
        await p.waitForSelector('#center .detached', { state: 'detached' });
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['hand-over', 'undo']);
      }));
  });
});

const DOCUMENT_TABLE = { source: 'results/vitest/client-unit.json', file: 'components/DocumentTable.spec.js', title: 'DocumentTable › lists the documents it is given' };
const DETAIL_TEST = { source: 'results/vitest/client-unit.json', file: 'components/DocumentDetail.spec.js', title: 'loads the detail screen only when it is needed' };

test('the data carries the untagged tests with the reference a judgment points at them by', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const { tests }: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.equal(tests.untaggedCount, 13);
      assert.equal(tests.untagged!.length, 13);
      assert.deepEqual(tests.untagged!.find((t) => t.title === DOCUMENT_TABLE.title)!.ref, DOCUMENT_TABLE);
    }),
  );
});

test('in a browser, the untagged tab lists every untagged test and a search box narrows the list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent(untaggedTab), '태그 없음 13');
        await p.click(untaggedTab);
        assert.equal(await p.locator('#untagged-list li').count(), 13);
        const detail = p.locator('#untagged-list li', { hasText: 'loads the detail screen only when it is needed' });
        assert.equal(await detail.textContent(), '통과loads the detail screen only when it is needed components/DocumentDetail.spec.js:1');
        assert.match((await p.textContent('#untagged-list li:has-text("DocumentTable")'))!, /^실패/);
        await p.fill('#left input[type=search]', 'help');
        assert.deepEqual(await p.locator('#untagged-list li .title').allTextContents(), ['renders the help text', 'shows the day the help was last updated']);
        await p.fill('#left input[type=search]', 'nothing like this');
        assert.equal(await p.textContent('#untagged-list'), '해당하는 테스트가 없습니다.');
      })));
});

test('in a browser, a chosen untagged test shows the screens it imports with the files it came through, and a click on a screen opens it in the screen list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.equal(await p.textContent('#center h3'), 'DocumentTable › lists the documents it is given');
        assert.equal(await p.locator('#untagged-list li.selected').count(), 1);
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면·호출의 짝 2');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.deepEqual(await pairs.locator('.screen-path').allTextContents(), ['/document/:tab(draft|done)', '/home']);
        assert.deepEqual(await pairs.locator('.via').allTextContents(), ['components/DocumentTable.js', 'components/DocumentTable.js']);
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['불러옴', '불러옴']);
        assert.equal(await p.locator('#center .pair button').count(), 0);

        await pairs.filter({ hasText: '/home' }).click();
        assert.equal(await p.getAttribute('#left .views.side button.on', 'class'), 'on');
        assert.equal(await p.textContent('#left .views.side button.on'), '화면 11');
        assert.equal(await p.textContent('#screen-list li.selected .name'), '/home Home');
      })));
});

test('in a browser, a discarded pair and a handed-over pair show their state under the untagged test', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: '/home#Home', kind: 'discard', reason: 'only lists documents', author: 'reviewer' });
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: '/document/:tab_draft_done_#DocumentList', kind: 'hand-over', reason: 'covers the list', author: 'reviewer' });
        await p.reload();
        await toList(p);
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.deepEqual(await pairs.locator('.screen-path').allTextContents(), ['/document/:tab(draft|done)', '/home']);
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['태그 대기', '제외한 짝']);
        assert.match((await pairs.nth(0).textContent())!, /covers the list · \d/s);
        assert.match((await pairs.nth(1).textContent())!, /only lists documents · \d/s);
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면·호출의 짝 2');
      })));
});

test('in a browser, an untagged test whose imports were read and matched no screen says so', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("formats a date as year-month-day")');
        assert.equal(await p.locator('#center .pair').count(), 0);
        assert.equal(await p.textContent('#center .no-screens'), '이 테스트가 불러오는 파일로 이어진 화면이 없습니다. 화면 넷 이상이 함께 쓰는 파일과 찾지 못한 파일로는 잇지 않습니다.');
      })));
});

test('in a browser, an untagged test whose imports were not read says why instead of claiming it imports nothing', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        const say = async (title: string) => {
          await p.click(`#untagged-list li:has-text("${title}")`);
          assert.equal(await p.locator('#center .pair').count(), 0);
          return p.textContent('#center .no-screens');
        };
        assert.equal(await say('Document service › sends the share mail'), '이 결과 형식(junit)에는 테스트가 불러오는 파일이 적혀 있지 않아, 어느 화면에 이어지는지 읽지 못했습니다.');
        assert.equal(await say('loads without errors'), '이 테스트는 trace 파일 없이 돌아, 어느 화면을 열고 어느 호출을 보냈는지 알 수 없습니다. Playwright 의 trace 옵션을 켜고 다시 돌리면 보입니다.');
        assert.equal(await say('cleanup'), '이 결과 형식(verdict)에는 테스트가 불러오는 파일이 적혀 있지 않아, 어느 화면에 이어지는지 읽지 못했습니다.');
        assert.equal(await say('keeps the old menu'), '테스트가 불러오는 파일을 읽지 못했습니다. 테스트 파일을 소스 폴더에서 찾지 못했습니다.');
      })));
});

test('in a browser, a tests.json without the untagged list shows the count and asks for a rebuild instead of saying there are no untagged tests', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          delete data.tests.untagged;
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.textContent(untaggedTab), '태그 없음 13');
        await p.click(untaggedTab);
        assert.match((await p.textContent('#center-body'))!, /태그 없는 테스트 목록이 없습니다.*duru rebuild/s);
        assert.doesNotMatch((await p.textContent('#center-body'))!, /태그 없는 테스트가 없습니다/);
        assert.equal(await p.locator('#untagged-list li:not(.muted)').count(), 0);
        assert.doesNotMatch((await p.textContent('#untagged-list'))!, /해당하는 테스트가 없습니다/);
      })));
});

test('in a browser, a pair for a screen that is no longer on the map shows as an off-map item that cannot be opened', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data: PageData = await res.json();
          data.map.screens = data.map.screens.filter((s) => s.id !== '/home#Home');
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.equal(await pairs.count(), 2);
        const off = pairs.filter({ hasText: '/home#Home' });
        assert.equal(await off.count(), 1);
        assert.match((await off.getAttribute('class'))!, /off-map/);
        assert.doesNotMatch((await off.getAttribute('class'))!, /on-map/);
        assert.equal(await off.getAttribute('title'), null);
        assert.match((await off.textContent())!, /맵에 없음/);
        assert.match((await off.textContent())!, /components\/DocumentTable\.js/);
        assert.match((await pairs.filter({ hasText: '/document/:tab' }).getAttribute('class'))!, /on-map/);
        await off.click();
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.textContent('#center h3'), 'DocumentTable › lists the documents it is given');
      })));
});

test('in a browser, a hand-over of a test that no longer imports the screen shows under the test as 떨어져 나감, as it does under the screen', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const format = { source: 'results/vitest/client-unit.json', file: 'components/formatDate.spec.js', title: 'formats a date as year-month-day' };
    addJudgment(config.judgmentsDir, { test: format, node: '/help#Help', kind: 'hand-over', reason: 'was about the help date', author: 'someone' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .detached h2'), '떨어져 나감 1');

        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("formats a date as year-month-day")');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.equal(await pairs.count(), 1);
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면·호출의 짝 1');
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['떨어져 나감']);
        assert.equal(await pairs.locator('.screen-path').textContent(), '/help');
        assert.match((await pairs.textContent())!, /메모 was about the help date.*someone/s);
        assert.equal(await pairs.locator('.via').count(), 0);
        assert.equal(await p.locator('#center .no-screens').count(), 0);
      }));
  });
});

test('in a browser, the imported-only filter keeps the screens with importing tests and no tagged test, counts a pair waiting for a tag and ignores a discarded one', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        addJudgment(config.judgmentsDir, { test: DETAIL_TEST, node: '/document/:id#DocumentDetail', kind: 'discard', reason: 'only loads a view', author: 'reviewer' });
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: '/document/:tab_draft_done_#DocumentList', kind: 'hand-over', reason: '', author: 'reviewer' });
        const bare = ['/help#Help', '/document/:id#DocumentDetail', '/document/:tab_draft_done_#DocumentList'];
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data = await res.json();
          for (const id of bare) delete data.tests.nodes[id];
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.locator('#screen-list li').count(), 11);
        assert.equal(await p.locator('#left .filters label:has-text("지나간 테스트만 있음")').count(), 1);
        await p.check('#left input[name="imported-only"]');
        assert.deepEqual(await p.locator('#screen-list li .name > span:first-child').allTextContents(), ['/document/:tab(draft|done)', '/help']);
        const counts = async (path: string) => (await p.locator('#screen-list li', { hasText: path }).locator('.count').allTextContents()).join('');
        assert.equal(await counts('/document/:tab'), '테스트 없음태그 대기 1');
        assert.equal(await counts('/help'), '테스트 없음불러옴 2');
        await p.uncheck('#left input[name="imported-only"]');
        assert.equal(await p.locator('#screen-list li').count(), 11);
      })));
});

const LIST_NODE = '/document/:tab_draft_done_#DocumentList';
const HOME_NODE = '/home#Home';
const pick = '#center .pair-row input.pick';
const bulk = '#center .bulk-bar';

async function openDocumentTable(p: Page) {
  await p.waitForSelector('#screen-list li');
  await p.click(untaggedTab);
  await p.click('#untagged-list li:has-text("DocumentTable")');
}

const untilSet = async <T>(get: () => T, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!get()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return get();
};

const judgedBy = (config: Config) => loadJudgments(config.judgmentsDir).judgments.map((j) => [j.node, j.kind, j.reason, j.author]).sort();

test('in a browser, only the pairs that still import get a checkbox, the bulk buttons stay disabled until a pair is picked and say how many are', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: HOME_NODE, kind: 'discard', reason: 'only lists documents', author: 'reviewer' });
        await p.reload();
        await toList(p);
        await openDocumentTable(p);
        assert.equal(await p.locator('#center .pair').count(), 2);
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair', { hasText: '/home' }).locator('input').count(), 0);
        assert.equal(await p.locator('#center .pair', { hasText: '/home' }).locator('button').count(), 0);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), true);
        assert.equal(await p.locator(`${bulk} button.discard`).isDisabled(), true);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (0)');
        assert.equal(await p.locator(asked).isVisible(), false);

        await p.check(pick);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (1)');
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (1)');
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), false);
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.locator('#screen-list').count(), 0);
        await p.uncheck(pick);
        assert.equal(await p.locator(`${bulk} button.discard`).isDisabled(), true);
      })));
});

test('in a browser, picking a pair does not open its screen, and the pick-all box picks every pair that can be judged', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(pick.concat(' >> nth=0'));
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator(`${bulk} input.pick-all`).isChecked(), false);

        await p.check(`${bulk} input.pick-all`);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (2)');
        await p.uncheck(`${bulk} input.pick-all`);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 0);
        assert.equal(await p.locator(`${bulk} input.pick-all`).isChecked(), false);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), true);
      })));
});

test('in a browser, a pair whose screen is not on the map has no checkbox and is not picked by the pick-all box', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data: PageData = await res.json();
          data.map.screens = data.map.screens.filter((s) => s.id !== HOME_NODE);
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await openDocumentTable(p);
        assert.equal(await p.locator('#center .pair').count(), 2);
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair.off-map input').count(), 0);
        await p.check(`${bulk} input.pick-all`);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (1)');
      })));
});

test('in a browser, several pairs of one untagged test are included in one go, each as its own judgment file', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);

        assert.deepEqual(judgedBy(config), [
          [LIST_NODE, 'hand-over', '', 'reviewer'],
          [HOME_NODE, 'hand-over', '', 'reviewer'],
        ]);
        const files = (fs.readdirSync(config.judgmentsDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.json'));
        assert.equal(files.length, 2);
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['태그 대기', '태그 대기']);
        assert.equal(await p.locator(pick).count(), 0);
        assert.equal(await p.locator(bulk).count(), 0);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        assert.match((await p.textContent('#center .awaiting-tag'))!, /DocumentTable › lists the documents it is given/);
        assert.doesNotMatch((await p.textContent('#center'))!, /불러오는 테스트/);
      })));
});

test('in a browser, several pairs of one untagged test are discarded in one go with one reason, asked for in a window that lists the picked screens', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        assert.equal(await p.textContent(`${asked} h2`), '짝 2개를 제외합니다');
        assert.match((await p.textContent(`${asked} .subject`))!, /lists the documents it is given.*DocumentTable/s);
        assert.deepEqual(await p.locator(`${asked} .subject li`).allTextContents(), ['/document/:tab(draft|done) DocumentList', '/home Home']);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '제외 (2)']);
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${bulk} .bulk-error`).count(), 0);

        await p.press(why, 'Control+Enter');
        assert.equal(fs.existsSync(config.judgmentsDir), false);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);

        await p.fill(why, 'only lists documents');
        await p.press(why, 'Control+Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 2);
        assert.deepEqual(judgedBy(config), [
          [LIST_NODE, 'discard', 'only lists documents', 'reviewer'],
          [HOME_NODE, 'discard', 'only lists documents', 'reviewer'],
        ]);
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(await p.locator(bulk).count(), 0);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        assert.equal(await p.textContent('#center .discarded h2'), '제외한 짝 1');
        assert.equal(await p.locator('#center .importers').filter({ hasText: 'DocumentTable' }).count(), 0);
      })));
});

test('in a browser, the window asking for a reason is put away with 「취소」 or Escape and not by a click outside it, the reason typed goes with it and nothing is sent', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        const focusedButton = () => p.evaluate(() => [document.activeElement!.closest('.bulk-bar, .judge-row')?.className, document.activeElement!.className]);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        await p.fill(why, 'typed and dropped');
        await p.mouse.click(5, 5);
        assert.equal(await p.locator(asked).isVisible(), true);
        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(await focusedButton(), ['bulk-bar', 'discard']);

        await p.click(`${bulk} button.discard`);
        assert.equal(await p.inputValue(why), '');
        await p.click(`${asked} button.cancel`);
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(await focusedButton(), ['bulk-bar', 'discard']);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        const row = p.locator('#center .importers .importer', { hasText: 'DocumentTable' }).locator('.judge-row');
        await row.locator('button.discard').click();
        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(await focusedButton(), ['judge-row', 'discard']);
        assert.equal(fs.existsSync(config.judgmentsDir), false);
      })));
});

test('in a browser, while a discard is being saved the window stays open and locked, Ctrl+Enter and Escape do nothing, and one discard is saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let held!: Route;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          held = route;
        });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await first.locator('button.discard').click();
        await p.fill(why, 'only renders a shared header');
        await p.press(why, 'Control+Enter');
        await untilSet(() => held, 'the judgment request');

        assert.deepEqual(await p.$$eval(`${asked} button`, (list: HTMLButtonElement[]) => list.map((b) => b.disabled)), [true, true]);
        assert.equal(await p.locator(why).evaluate((el: HTMLTextAreaElement) => el.readOnly), true);
        await p.keyboard.press('Control+Enter');
        await p.keyboard.press('Escape');
        await p.keyboard.press('Escape');
        assert.equal(await p.locator(asked).isVisible(), true);
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.inputValue(why), 'only renders a shared header');
        await p.locator(`${asked} button.discard`).click({ force: true });
        assert.equal(calls, 1);

        await held.continue();
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(loadJudgments(config.judgmentsDir).judgments.length, 1);
      })));
});

test('in a browser, a discard that fails to save leaves the window open with its reason and the error, and saves when sent again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const refuse = (route: Route) => route.fulfill({ status: 500, body: 'disk full' });
        await p.route('**/api/judgments', refuse);
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await excludeIn(first, 'only renders a shared header');
        await p.locator(`${asked} .error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.equal(await p.textContent(`${asked} .error`), '저장하지 못했습니다: disk full');
        assert.equal(await p.inputValue(why), 'only renders a shared header');
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), false);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await p.unroute('**/api/judgments', refuse);
        await p.press(why, 'Control+Enter');
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.reason), ['only renders a shared header']);

        await p.locator('#center .importers .importer').first().locator('button.discard').click();
        assert.equal(await p.locator(`${asked} .error`).isVisible(), false);
      })));
});

test('in a browser, 「제외」 does not ask for a reason while the 「포함」 of the same row is being saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        let held!: Route;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const first = p.locator('#center .importers .importer', { hasText: 'renders the help text' });
        await first.locator('button.hand-over').click();
        await untilSet(() => held, 'the judgment request');
        await first.locator('button.discard').click();
        assert.equal(await p.locator(asked).isVisible(), false);
        await held.continue();
        await p.waitForSelector('#center .awaiting-tag');
      })));
});

test('in a browser, a judgment of another row that ends while a reason is being typed leaves the focus and the typing in the window', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        let held!: Route;
        await p.route('**/api/judgments', (route) => { held = route; });
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const rows = p.locator('#center .importers .importer');
        await rows.nth(0).locator('button.hand-over').click();
        await untilSet(() => held, 'the judgment request');
        await rows.nth(1).locator('button.discard').click();
        await p.keyboard.type('second row re');
        await held.fulfill({ status: 500, body: 'disk full' });
        await rows.nth(0).locator('.judgment-error').waitFor();
        await p.keyboard.type('ason');
        assert.equal(await p.inputValue(why), 'second row reason');
        assert.equal(await askedFocused(p), true);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

test('in a browser, every pair judged in bulk is undone one at a time from its screen', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);

        await p.locator('#center .pair', { hasText: '/home' }).click();
        await p.click('#center .awaiting-tag button.undo');
        await p.waitForSelector('#center .awaiting-tag', { state: 'detached' });
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => j.kind).sort(), ['hand-over', 'hand-over', 'undo']);

        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['태그 대기', '불러옴']);
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair-row', { hasText: '/home' }).locator('input.pick').count(), 1);
      })));
});

test('in a browser, the pick survives a redraw, goes when another test is chosen, and drops a pair that is judged elsewhere', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        await p.fill(why, 'typed reason');
        await p.evaluate(() => render());
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
        assert.equal(await p.inputValue(why), 'typed reason');
        await p.click(`${asked} button.cancel`);

        addJudgment(config.judgmentsDir, { test: DOCUMENT_TABLE, node: HOME_NODE, kind: 'discard', reason: 'judged elsewhere', author: 'someone' });
        await p.evaluate(async () => { await load(); render(); });
        assert.equal(await p.locator(pick).count(), 1);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (1)');

        await p.click('#untagged-list li:has-text("loads the detail screen only when it is needed")');
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 0);
        assert.deepEqual(await p.locator(`${bulk} button`).allTextContents(), ['제외 (0)', '포함 (0)']);
      })));
});

test('in a browser, a bulk save that fails midway stops, keeps the unsaved pairs picked and says which pairs were saved and which were not', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        const refuse = async (route: Route) => {
          calls += 1;
          if (calls === 2) await route.fulfill({ status: 500, body: 'disk full' });
          else await route.continue();
        };
        await p.route('**/api/judgments', refuse);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();

        assert.equal(calls, 2);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.deepEqual(judgedBy(config), [[LIST_NODE, 'hand-over', '', 'reviewer']]);
        const message = (await p.textContent(`${bulk} .bulk-error`))!;
        assert.match(message, /^저장하지 못했습니다: disk full\n저장한 짝 1: /);
        assert.match(message, /저장한 짝.*\/document\/:tab\(draft\|done\)/s);
        assert.match(message, /저장하지 못한 짝.*\/home/s);
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['태그 대기', '불러옴']);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator('#center .pair-row', { hasText: '/home' }).locator('input.pick').isChecked(), true);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), false);
        await p.click(`${bulk} button.discard`);
        assert.equal(await p.textContent(`${bulk} .bulk-error`), message);
        await p.click(`${asked} button.cancel`);
        assert.equal(await p.textContent(`${bulk} .bulk-error`), message);

        await p.unroute('**/api/judgments', refuse);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.equal(await p.locator(`${bulk} .bulk-error`).count(), 0);
        assert.equal(judgedBy(config).length, 2);
      })));
});

test('in a browser, the bulk controls stay disabled while the requests are in flight', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        let held!: Route;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 1) held = route;
          else route.continue();
        });
        await p.check(`${bulk} input.pick-all`);
        await excludePicked(p, 'only lists documents');
        await untilSet(() => held, 'the first judgment request');
        for (const sel of [`${bulk} button.discard`, `${bulk} button.hand-over`, `${bulk} input.pick-all`, pick, `${asked} button.discard`, `${asked} button.cancel`]) {
          assert.equal(await p.locator(sel).first().isDisabled(), true, sel);
        }
        assert.equal(await p.locator(why).evaluate((el: HTMLTextAreaElement) => el.readOnly), true);
        await p.locator(`${asked} button.discard`).click({ force: true });
        await p.press(why, 'Control+Enter');
        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), true);
        assert.equal(calls, 1);
        await held.continue();
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 2);
        assert.equal(judgedBy(config).length, 2);
      })));
});

test('in a browser, nothing leaves the test while a bulk is in flight, and the report of a bulk that fails midway is there when it ends', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const ended: string[] = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        let held!: Route;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 1) held = route;
          else route.fulfill({ status: 500, body: 'disk full' });
        });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await untilSet(() => held, 'the first judgment request');

        for (const sel of ['#left .views.side button', '#view-list', '#view-flow', '#end-review']) {
          for (const el of await p.locator(sel).all()) assert.equal(await el.isDisabled(), true, sel);
        }
        const style = (sel: string, prop: keyof CSSStyleDeclaration) => p.locator(sel).first().evaluate((el, name) => getComputedStyle(el)[name], prop);
        const otherTest = '#untagged-list li:has-text("loads the detail screen only when it is needed")';
        const homePair = '#center .pair:has-text("/home")';
        for (const sel of [otherTest, homePair]) {
          assert.equal(await style(sel, 'cursor'), 'default', sel);
          assert.equal(await p.locator(sel).first().getAttribute('title'), null, sel);
        }
        const lineBefore = await style(homePair, 'borderColor');
        await p.hover(homePair, { force: true });
        assert.equal(await style(homePair, 'borderColor'), lineBefore);
        await p.hover(otherTest, { force: true });
        assert.equal(await style(otherTest, 'backgroundColor'), 'rgba(0, 0, 0, 0)');

        await p.locator(otherTest).click({ force: true });
        assert.equal(await p.textContent('#untagged-list li.selected .title'), DOCUMENT_TABLE.title);
        assert.equal(await p.textContent('#center h3'), DOCUMENT_TABLE.title);
        await p.locator(homePair).click({ force: true });
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        assert.equal(await p.locator(`${bulk} button.hand-over`).count(), 1);
        await p.locator('#left .views.side button:not(.on)').first().click({ force: true });
        assert.equal(await p.textContent('#left .views.side button.on'), '태그 없음 13');
        await p.locator('#view-flow').click({ force: true });
        assert.equal(await p.locator('main').isVisible(), true);
        await p.locator('#end-review').click({ force: true });
        assert.deepEqual(ended, []);

        await held.continue();
        await p.locator(`${bulk} .bulk-error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.match((await p.textContent(`${bulk} .bulk-error`))!, /저장한 짝 1.*\/document\/:tab\(draft\|done\).*저장하지 못한 짝 1.*\/home/s);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        assert.equal(await p.locator('#view-flow').isDisabled(), false);
        assert.equal(await p.locator('#left .views.side button').first().isDisabled(), false);
        assert.deepEqual(ended, []);
      })));
});

test('in a browser, while the end request is pending a bulk cannot start and the end button cannot be pressed twice, and a refused end unlocks both', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const ended = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        const judged: string[] = [];
        p.on('request', (r) => r.url().endsWith('/api/judgments') && judged.push(r.url()));
        let held!: Route;
        await p.route('**/api/end', (route) => { held = route; });
        await p.check(`${bulk} input.pick-all`);
        await p.click('#end-review');
        await untilSet(() => held, 'the end request');

        assert.equal(await p.locator('#end-review').isDisabled(), true);
        for (const kind of ['hand-over', 'discard']) {
          assert.equal(await p.locator(`${bulk} button.${kind}`).isDisabled(), true, kind);
          await p.locator(`${bulk} button.${kind}`).click({ force: true });
        }
        await p.locator('#end-review').click({ force: true });
        assert.deepEqual(judged, []);
        assert.equal(ended.length, 1);

        await held.fulfill({ status: 500, body: 'cannot end' });
        await p.waitForFunction(() => !(document.getElementById('end-review') as HTMLButtonElement).disabled);
        assert.match((await p.textContent('#end-error'))!, /cannot end/);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), false);
        assert.equal(await p.locator(`${bulk} button.discard`).isDisabled(), false);
        errors.splice(0);
        await p.unroute('**/api/end');
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.equal(judged.length, 2);
      })));
});

test('in a browser, the page that was told the review ended shows the ended screen without errors when the end request was pending while the buttons were pressed', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        let held!: Route;
        await p.route('**/api/end', (route) => { held = route; });
        await p.check(`${bulk} input.pick-all`);
        await p.click('#end-review');
        await untilSet(() => held, 'the end request');
        await p.locator(`${bulk} button.hand-over`).click({ force: true });
        await held.continue();
        await p.locator('#ended').waitFor();
        assert.match((await p.textContent('#ended'))!, /리뷰를 끝냈습니다/);
        assert.deepEqual(judgedBy(config), []);
      })));
});

test('in a browser, a page that could not read its data still ends the review', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        const ended = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        await p.route('**/api/data', (route) => route.fulfill({ status: 500, body: 'data gone' }));
        await p.reload();
        await p.locator('#failed').waitFor();
        assert.match((await p.textContent('#failed'))!, /data gone/);
        await p.click('#end-review');
        await p.locator('#ended').waitFor({ timeout: 5000 });
        assert.match((await p.textContent('#ended'))!, /리뷰를 끝냈습니다/);
        assert.equal(ended.length, 1);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

type DataSettled = { dataSettled: boolean };
const watchDataSettled = (p: Page) => p.addInitScript(() => {
  const fetch = window.fetch;
  window.fetch = (...args) => {
    const sent = fetch(...args);
    if (String(args[0]).endsWith('/api/data')) {
      // 페이지가 이 응답을 받아 하는 일이 모두 끝난 뒤에 표시하도록 타이머로 미룬다.
      const settled = () => setTimeout(() => { (window as unknown as DataSettled).dataSettled = true; });
      sent.then((res) => {
        const json = res.json.bind(res);
        res.json = () => {
          const body = json();
          body.then(settled, settled);
          return body;
        };
      }, settled);
    }
    return sent;
  };
});

test('in a browser, 「리뷰 끝」 pressed before the data arrived ends the review, and when the end is refused the button is not left locked', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        const data = await (await fetch(`${base}/api/data`)).text();
        const ended = [];
        p.on('request', (r) => r.url().endsWith('/api/end') && ended.push(r.url()));
        let held!: Route | null;
        await p.route('**/api/data', (route) => { held = route; });
        await p.route('**/api/end', (route) => route.fulfill({ status: 500, body: 'cannot end' }));
        await p.reload();
        await untilSet(() => held, 'the data request');
        await p.click('#end-review');
        await p.waitForFunction(() => /cannot end/.test(document.getElementById('end-error')!.textContent), null, { timeout: 5000 });
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        await held!.fulfill({ status: 200, contentType: 'application/json', body: data });
        await toList(p);
        await p.waitForSelector('#screen-list li');
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        assert.equal(ended.length, 1);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);

        held = null;
        await p.unroute('**/api/end');
        await watchDataSettled(p);
        await p.reload();
        await untilSet(() => held, 'the data request');
        await p.click('#end-review');
        await p.locator('#ended').waitFor({ timeout: 5000 });
        assert.match((await p.textContent('#ended'))!, /리뷰를 끝냈습니다/);
        assert.equal(ended.length, 2);
        await held!.fulfill({ status: 200, contentType: 'application/json', body: data });
        await p.waitForFunction(() => (window as unknown as DataSettled).dataSettled);
        assert.equal(await p.locator('#ended').count(), 1);
      })));
});

test('in a browser, the data failing to arrive after the review ended leaves the ended screen without errors', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        let held!: Route;
        await p.route('**/api/data', (route) => { held = route; });
        await watchDataSettled(p);
        await p.reload();
        await untilSet(() => held, 'the data request');
        await p.click('#end-review');
        await p.locator('#ended').waitFor({ timeout: 5000 });
        await held.abort();
        await p.waitForFunction(() => (window as unknown as DataSettled).dataSettled);
        assert.match((await p.textContent('#ended'))!, /리뷰를 끝냈습니다/);
        assert.deepEqual(errors.splice(0), ['Failed to load resource: net::ERR_FAILED']);
      })));
});

test('in a browser, the bulk buttons are locked in place while 「리뷰 끝」 is being sent, so the checkbox that was toggled keeps the focus', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const buttons = `${bulk} button`;
        const picked = `${pick}[data-pair="${LIST_NODE}"]`;
        const disabled = () => p.$$eval(buttons, (list: HTMLButtonElement[]) => list.map((b) => b.disabled));
        let held!: Route | null;
        await p.route('**/api/end', (route) => { held = route; });
        const refuseEnd = async () => {
          held = null;
          await p.evaluate(() => document.getElementById('end-review')!.click());
          await untilSet(() => held, 'the end request');
          assert.deepEqual(await disabled(), [true, true]);
          await held!.fulfill({ status: 500, body: 'cannot end' });
          await p.waitForFunction(() => /cannot end/.test(document.getElementById('end-error')!.textContent));
        };

        await p.check(picked);
        await p.$eval(picked, (el: HTMLInputElement & Kept) => { el.kept = true; });
        await refuseEnd();
        assert.deepEqual(await disabled(), [false, false]);
        assert.equal(await p.evaluate((sel) => document.activeElement!.matches(sel) && (document.activeElement as Element & Kept).kept, picked), true);

        await p.uncheck(picked);
        await refuseEnd();
        assert.deepEqual(await p.locator(buttons).allTextContents(), ['제외 (0)', '포함 (0)']);
        assert.deepEqual(await disabled(), [true, true]);
        assert.deepEqual(errors.splice(0), [...SAVE_REFUSED, ...SAVE_REFUSED]);
      })));
});

test('in a browser, a refused end in the flow view leaves the diagram as it was drawn', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.setViewportSize({ width: 1440, height: 400 });
        await p.click('#view-flow');
        await p.waitForSelector('#flow .box.screen');
        const scrollTop = await p.evaluate(() => {
          for (const box of document.querySelectorAll<HTMLElement>('#flow .box')) box.dataset.drawn = 'before';
          const flow = document.getElementById('flow')!;
          flow.scrollTop = 60;
          return flow.scrollTop;
        });
        assert.ok(scrollTop > 0);
        await p.route('**/api/end', (route) => route.fulfill({ status: 500, body: 'cannot end' }));
        await p.click('#end-review');
        await p.waitForFunction(() => /cannot end/.test(document.getElementById('end-error')!.textContent));
        assert.ok(await p.locator('#flow .box[data-drawn=before]').count() > 0);
        assert.equal(await p.locator('#flow .box:not([data-drawn=before])').count(), 0);
        assert.equal(await p.evaluate(() => document.getElementById('flow')!.scrollTop), scrollTop);
        assert.equal(await p.locator('#end-review').isDisabled(), false);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

test('in a browser, the keyboard focus goes back to the bulk button that was pressed once the bulk ends, to the first control of the bar when that button is off, and stays in the window while a discard is not saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        const active = () => p.evaluate(() => document.activeElement!.className);
        const pressEnterOn = async (sel: string) => {
          await p.focus(sel);
          await p.keyboard.press('Enter');
        };
        await p.check(`${pick}[data-pair="${LIST_NODE}"]`);
        await pressEnterOn(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 1);
        assert.equal(await p.locator(`${bulk} button.hand-over`).isDisabled(), true);
        assert.equal(await active(), 'pick-all');

        await p.check(`${pick}[data-pair="${HOME_NODE}"]`);
        await pressEnterOn(`${bulk} button.discard`);
        assert.equal(await askedFocused(p), true);

        const refuse = (route: Route) => route.fulfill({ status: 500, body: 'disk full' });
        await p.route('**/api/judgments', refuse);
        await p.keyboard.type('only lists documents');
        await p.keyboard.press('Control+Enter');
        await p.locator(`${asked} .error`).waitFor();
        assert.match((await p.textContent(`${asked} .error`))!, /disk full/);
        assert.equal(await askedFocused(p), true);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        await p.keyboard.press('Escape');
        assert.equal(await active(), 'discard');

        await p.unroute('**/api/judgments', refuse);
        await pressEnterOn(`${bulk} button.discard`);
        await p.keyboard.type('only lists documents');
        await p.keyboard.press('Control+Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 1);
        assert.equal(await p.locator(bulk).count(), 0);
        assert.equal(await p.evaluate(() => document.activeElement!.matches('#center .test-pairs h2')), true);
      })));
});

test('in a browser, a bulk that ends while the reviewer types in the search box leaves the focus and the typing there', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let held!: Route;
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 1) held = route;
          else route.fulfill({ status: 500, body: 'disk full' });
        });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await untilSet(() => held, 'the first judgment request');
        const search = '#left input[type=search]';
        await p.click(search);
        await p.keyboard.type('Document');
        await p.$eval(search, (el: HTMLInputElement & Kept) => { el.kept = true; });
        await held.continue();
        await p.locator(`${bulk} .bulk-error`).waitFor();
        assert.equal(await p.evaluate((sel) => document.activeElement!.matches(sel) && (document.activeElement as Element & Kept).kept, search), true);
        await p.keyboard.type(' Table');
        assert.equal(await p.inputValue(search), 'Document Table');
        assert.equal(calls, 2);
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
      })));
});

test('in a browser, a bulk that judges every pair moves the keyboard focus to the heading of the pairs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.check(`${bulk} input.pick-all`);
        await p.focus(`${bulk} button.hand-over`);
        await p.keyboard.press('Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.equal(await p.locator(bulk).count(), 0);
        assert.equal(await p.evaluate(() => document.activeElement!.matches('#center .test-pairs h2')), true);
      })));
});

test('in a browser, a pair saved by a bulk is not picked any more even when reading the data again fails, so a retry sends only the unsaved pairs', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        const refuse = (route: Route) => {
          calls += 1;
          if (calls === 2) route.fulfill({ status: 500, body: 'disk full' });
          else route.continue();
        };
        const unreadable = (route: Route) => route.fulfill({ status: 500, body: 'data gone' });
        await p.route('**/api/judgments', refuse);
        await p.route('**/api/data', unreadable);
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();

        assert.equal(errors.splice(0).length, 2);
        const message = (await p.textContent(`${bulk} .bulk-error`))!;
        assert.match(message, /저장했지만 다시 읽지 못했습니다: data gone/);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        assert.equal(await p.locator('#center .pair-row', { hasText: '/home' }).locator('input.pick').isChecked(), true);
        assert.equal(await p.textContent(`${bulk} button.hand-over`), '포함 (1)');

        await p.unroute('**/api/judgments', refuse);
        await p.unroute('**/api/data', unreadable);
        const sent: string[] = [];
        await p.route('**/api/judgments', (route) => {
          sent.push(route.request().postDataJSON().node);
          route.continue();
        });
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.deepEqual(sent, [HOME_NODE]);
        assert.equal(judgedBy(config).length, 2);
      })));
});

test('in a browser, the message of a failed bulk puts the report in its own line, and says "saved" only when a pair was saved', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        await p.route('**/api/judgments', (route) => route.fulfill({ status: 500, body: 'disk full' }));
        await p.route('**/api/data', (route) => route.fulfill({ status: 500, body: 'data gone' }));
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();

        errors.splice(0);
        const lines = (await p.textContent(`${bulk} .bulk-error`))!.split('\n');
        assert.equal(lines.length, 3);
        assert.match(lines[0], /^저장하지 못했습니다: disk full$/);
        assert.match(lines[1], /^저장한 짝 0: 없음\. 저장하지 못한 짝 2: /);
        assert.equal(lines[2], '다시 읽지 못했습니다: data gone');
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
      })));
});

test('in a browser, a bulk discard that fails midway leaves the window open with the report, the reason and only the pairs not saved, and the rest is saved when sent again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        const refuse = async (route: Route) => {
          calls += 1;
          if (calls === 2) await route.fulfill({ status: 500, body: 'disk full' });
          else await route.continue();
        };
        await p.route('**/api/judgments', refuse);
        await p.check(`${bulk} input.pick-all`);
        await excludePicked(p, 'only lists documents');
        await p.locator(`${asked} .error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);

        const message = (await p.textContent(`${asked} .error`))!;
        assert.match(message, /^저장하지 못했습니다: disk full\n저장한 짝 1: .*저장하지 못한 짝 1: \/home/s);
        assert.equal(await p.textContent(`${bulk} .bulk-error`), message);
        assert.equal(await p.textContent(`${asked} h2`), '이 짝을 제외합니다');
        assert.deepEqual(await p.locator(`${asked} .subject li`).allTextContents(), ['/home Home']);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '제외']);
        assert.equal(await p.inputValue(why), 'only lists documents');
        assert.equal(await askedFocused(p), true);
        assert.deepEqual(await p.locator('#center .pair .pair-state').allTextContents(), ['제외한 짝', '불러옴']);

        await p.unroute('**/api/judgments', refuse);
        await p.press(why, 'Control+Enter');
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.muted').length === 2);
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.deepEqual(judgedBy(config).map((j) => j.slice(1, 3)), [['discard', 'only lists documents'], ['discard', 'only lists documents']]);
      })));
});

test('in a browser, the failure report and the picks of a bulk survive opening a pair\'s screen and coming back, and a click on the same test', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await openDocumentTable(p);
        let calls = 0;
        await p.route('**/api/judgments', (route) => {
          calls += 1;
          if (calls === 2) route.fulfill({ status: 500, body: 'disk full' });
          else route.continue();
        });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await p.locator(`${bulk} .bulk-error`).waitFor();
        errors.splice(0);
        const message = await p.textContent(`${bulk} .bulk-error`);

        const intact = async () => {
          assert.equal(await p.textContent(`${bulk} .bulk-error`), message);
          assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 1);
        };
        await p.locator('#center .pair', { hasText: '/document/' }).click();
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await intact();
        await p.click('#untagged-list li:has-text("DocumentTable")');
        await intact();

        await p.click('#untagged-list li:has-text("loads the detail screen only when it is needed")');
        await p.click('#untagged-list li:has-text("DocumentTable")');
        assert.equal(await p.locator(`${bulk} .bulk-error`).count(), 0);
      })));
});

test('in a browser, picking a pair redraws only the middle and keeps the keyboard focus on the checkbox that was toggled', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await openDocumentTable(p);
        await p.evaluate(() => { document.querySelector<HTMLElement>('#untagged-list li')!.dataset.kept = 'yes'; });
        await p.locator(pick).nth(1).focus();
        await p.keyboard.press('Space');
        assert.equal(await p.evaluate(() => {
          const el = document.activeElement as HTMLInputElement;
          return el.matches('input.pick') && el.checked && [...document.querySelectorAll('input.pick')].indexOf(el);
        }), 1);
        assert.equal(await p.textContent(`${bulk} button.discard`), '제외 (1)');
        assert.equal(await p.evaluate(() => document.querySelector<HTMLElement>('#untagged-list li')!.dataset.kept), 'yes');

        await p.locator(`${bulk} input.pick-all`).focus();
        await p.keyboard.press('Space');
        assert.equal(await p.evaluate(() => document.activeElement!.matches('input.pick-all')), true);
        assert.equal(await p.locator('#center .pair-row input.pick:checked').count(), 2);
      })));
});

const placeOf = (p: Page) => p.evaluate(() => decodeURIComponent(location.hash));
const openAt = async (p: Page, url: string) => {
  await p.goto('about:blank');
  await p.goto(url);
};

test('in a browser, the first drawing writes the place into the address without adding a step to the history, and a redraw of the same place adds none', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        assert.equal(await placeOf(p), '#flow');
        const steps = await p.evaluate(() => history.length);
        await p.evaluate(() => render());
        await filterButton(p, 'fail').click();
        await p.locator('#flow-zoom .zoom-out').click();
        assert.equal(await p.evaluate(() => history.length), steps);

        await p.click('#view-list');
        assert.match(await placeOf(p), /^#screens\?screen=/);
        assert.equal(await p.evaluate(() => history.length), steps + 1);
        await p.check('#left input[name=no-tests]');
        await p.uncheck('#left input[name=no-tests]');
        assert.equal(await p.evaluate(() => history.length), steps + 1);
      }, { view: 'flow' })));
});

test('in a browser, the back and forward buttons go through the screens that were chosen, the left tabs and the two views', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const chosen = () => p.evaluate(() => [state.view, state.side, state.selected, state.story, document.querySelector('#screen-list li.selected, #story-list li.selected, #untagged-list li.selected')?.textContent.slice(0, 12)]);
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.click('#screen-list li:has-text("/signin")');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li >> nth=1');
        const story = await p.evaluate(() => state.story);
        await p.click(untaggedTab);
        await p.click('#view-flow');
        assert.equal(await placeOf(p), '#flow');

        await p.goBack();
        assert.match(await placeOf(p), /^#untagged\?test=/);
        assert.equal(await p.locator('#untagged-list li.selected').count(), 1);
        await p.goBack();
        assert.equal(await placeOf(p), `#stories?story=${story}`);
        assert.equal(await p.locator('#story-list li.selected').count(), 1);
        await p.goBack();
        await p.goBack();
        assert.equal(await placeOf(p), '#screens?screen=/signin#SignIn');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/signin/);
        await p.goBack();
        assert.equal(await placeOf(p), '#screens?screen=/help#Help');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/help/);
        assert.match((await p.textContent('#center'))!, /\/help/);

        await p.goForward();
        assert.deepEqual((await chosen()).slice(0, 3), ['list', 'screens', '/signin#SignIn']);
        await p.goForward();
        await p.goForward();
        await p.goForward();
        await p.goForward();
        assert.equal(await placeOf(p), '#flow');
        assert.equal(await p.locator('#flow').isVisible(), true);
      })));
});

test('in a browser, a screen picked in the flow is a place: back shows the flow with nothing picked and forward the pick', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#flow .box.screen');
        await (await screenBox(p, '/home#Home')).click();
        assert.equal(await placeOf(p), '#flow?screen=/home#Home');
        await (await screenBox(p, '/lab#Lab')).click();
        assert.equal(await placeOf(p), '#flow?screen=/lab#Lab');

        await p.goBack();
        assert.equal(await placeOf(p), '#flow?screen=/home#Home');
        assert.deepEqual(await pickedBoxes(p), ['/home#Home']);
        await p.goBack();
        await p.waitForSelector('#flow .box.picked', { state: 'detached' });
        assert.equal(await placeOf(p), '#flow');
        assert.equal(await p.locator('#gaps').isVisible(), true);
        await p.goForward();
        await p.waitForSelector('#flow .box.picked');
        assert.equal(await placeOf(p), '#flow?screen=/home#Home');
        assert.equal(await p.textContent('#center h3'), '/home');

        await p.click('.flowbar .picking button');
        assert.equal(await placeOf(p), '#flow');
      }, { view: 'flow' })));
});

test('in a browser, a page opened or loaded again with a place in its address shows that place, and a place that is gone falls back to what is there', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.reload();
        await p.waitForSelector('#screen-list li.selected');
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/help/);
        assert.equal(await p.locator('main').isVisible(), true);

        await openAt(p, `${base}/#flow?screen=${encodeURIComponent('/home#Home')}`);
        await p.waitForSelector('#flow .box.picked');
        assert.equal(await p.textContent('.flowbar .picking strong'), '/home');
        assert.equal(await p.textContent('#center h3'), '/home');

        await openAt(p, `${base}/#screens?screen=${encodeURIComponent('/gone#Gone')}`);
        await p.waitForSelector('#screen-list li.selected');
        assert.equal(await placeOf(p), `#screens?screen=${await p.evaluate(() => state.selected)}`);
        assert.notEqual(await p.evaluate(() => state.selected), '/gone#Gone');

        await openAt(p, `${base}/#flow?screen=${encodeURIComponent('/gone#Gone')}`);
        await p.waitForSelector('#flow .box.screen');
        assert.equal(await placeOf(p), '#flow');
        assert.equal(await p.locator('#flow .box.picked').count(), 0);
        assert.deepEqual(errors, []);
      })));
});

test('in a browser, going back to a screen drops a mark that was not saved, as choosing the screen does', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await p.click('#screen-list li:has-text("/signin")');
        await p.fill('#right-dock textarea', 'not saved');
        await p.goBack();
        await p.goForward();
        assert.match((await p.textContent('#screen-list li.selected'))!, /\/signin/);
        assert.equal(await p.inputValue('#right-dock textarea'), '');
      })));
});

test('in a browser, the back button does not leave the test while a bulk is in flight, and works again when it ends', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        await openDocumentTable(p);
        const place = await placeOf(p);
        let held!: Route;
        await p.route('**/api/judgments', (route) => { if (held) route.continue(); else held = route; });
        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.hand-over`);
        await untilSet(() => held, 'the first judgment request');
        await p.goBack();
        assert.equal(await placeOf(p), place);
        assert.equal(await p.textContent('#center h3'), DOCUMENT_TABLE.title);

        await held.continue();
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        await p.goBack();
        await p.waitForFunction((title) => document.querySelector('#center h3')!.textContent !== title, DOCUMENT_TABLE.title);
        assert.match(await placeOf(p), /^#untagged\?test=/);
      })));
});


test('in a browser, a browser test that passed through a screen is included with one press and waits for its tag, one excluded with a reason moves to the excluded pairs, and each comes back when undone', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const help = p.locator('#screen-list li:has-text("/help")');
        await help.click();
        const row = (title: string) => p.locator('#center .passed .pair-test', { hasText: title });
        await row('opens home and then help').locator('button.hand-over').click();
        await p.waitForSelector('#center .awaiting-tag');
        assert.equal(await p.textContent('#center .passed h2'), '지나간 테스트 5');
        assert.equal(await help.locator('.passed-count').textContent(), '지나감 5');
        assert.equal(await help.locator('.awaiting-count').textContent(), '태그 대기 1');
        assert.match((await p.textContent('#center .awaiting-tag .pair-test'))!, /^지나감 통과 opens home and then help visits\.spec\.ts:\d+ · chromium/);

        await excludeIn(row('hovers and uses the keyboard on help'), 'only hovers');
        await p.waitForSelector('#center .discarded');
        assert.equal(await p.textContent('#center .passed h2'), '지나간 테스트 4');
        assert.match((await p.textContent('#center .discarded .pair-test'))!, /^조작함 통과 hovers and uses the keyboard on help.*only hovers · \d/s);
        assert.deepEqual(loadJudgments(config.judgmentsDir).judgments.map((j) => [j.test.source, j.test.file, j.test.title, j.node, j.kind, j.author]).sort(), [
          ['results/playwright-traced/visits.json', 'visits.spec.ts', 'hovers and uses the keyboard on help', '/help#Help', 'discard', 'reviewer'],
          ['results/playwright-traced/visits.json', 'visits.spec.ts', 'opens home and then help', '/help#Help', 'hand-over', 'reviewer'],
        ]);

        await p.click('#view-flow');
        assert.match(await statusLine(await screenBox(p, '/help#Help')), /지나감 4$/);
        await p.click('#view-list');

        await p.click('#center .awaiting-tag button.undo');
        await p.waitForSelector('#center .awaiting-tag', { state: 'detached' });
        await p.click('#center .discarded button.undo');
        await p.waitForSelector('#center .discarded', { state: 'detached' });
        assert.equal(await p.textContent('#center .passed h2'), '지나간 테스트 6');
        assert.equal(await help.locator('.awaiting-count').count(), 0);
      })));
});

const LIST_CALL = 'GET:/api/v1/document/list';
const DETAIL_CALL = 'GET:/api/v1/document/{documentId}';

test('in a browser, the buttons that judge a pair sit at the right end of the row of its test, for a screen and in the call info, and so does the button that undoes a judgment', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click('#screen-list li:has-text("/help")');
        const boxes = (group: string, control: string) => p.locator(`#center ${group} .pair-test`).first().evaluate((row, selector) => {
          const box = (el: Element) => el.getBoundingClientRect();
          const [whole, test, buttons] = [row, row.querySelector('.test')!, row.querySelector(selector)!].map(box);
          return { gapOnRight: whole.right - buttons.right, sameLine: Math.abs(buttons.top - test.top) < 4, afterTest: buttons.left >= test.right };
        }, control);
        assert.deepEqual(await boxes('.passed', '.judge-row'), { gapOnRight: 0, sameLine: true, afterTest: true });
        assert.deepEqual(await boxes('.importers', '.judge-row'), { gapOnRight: 0, sameLine: true, afterTest: true });
        await p.locator('#center .passed .pair-test').first().locator('button.hand-over').click();
        await p.waitForSelector('#center .awaiting-tag');
        assert.deepEqual(await boxes('.awaiting-tag', 'button.undo'), { gapOnRight: 0, sameLine: true, afterTest: true });

        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls tr', { hasText: 'GET:/api/v1/document/{documentId}' }).first().click();
        await p.waitForSelector('#center .call-info .pair-test .judge-row');
        assert.deepEqual(await boxes('.call-info', '.judge-row'), { gapOnRight: 0, sameLine: true, afterTest: true });
        await p.locator('#center .call-info .pair-test button.hand-over').first().click();
        await p.waitForSelector('#center .call-info .awaiting-tag button.undo');
        assert.deepEqual(await boxes('.call-info .awaiting-tag', 'button.undo'), { gapOnRight: 0, sameLine: true, afterTest: true });
      })));
});

test('in a browser, a browser test that sent a call is excluded and included in the details of the call, and the window asking why names the call', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await chooseScreen(p, '/home');
        const callRow = p.locator('table.calls tbody tr:not(.option)', { hasText: LIST_CALL });
        await callRow.locator('td.cell').first().click();
        const sent = p.locator('#center .call-info .passed .pair-test', { hasText: 'lists the documents' });
        assert.deepEqual(await sent.locator('.judge-row button').allTextContents(), ['제외', '포함']);
        assert.match((await sent.locator('button.discard').getAttribute('title'))!, /^이 테스트와 이 호출의 짝/);

        await sent.locator('button.discard').click();
        assert.match((await p.textContent(`${asked} .subject`))!, /테스트lists the documents.*calls\.spec\.ts.*호출GET:\/api\/v1\/document\/list$/s);
        await p.fill(why, 'only loads the page');
        await p.click(`${asked} button.discard`);
        await p.waitForSelector('#center .call-info .discarded');
        assert.equal(await p.locator('#center .call-info .passed').count(), 0);
        assert.equal(await callRow.locator('.sent-count').count(), 0);
        assert.match((await p.textContent('#center .call-info .discarded .pair-test'))!, /^호출함 통과 lists the documents.*only loads the page · \d/s);
        assert.deepEqual(judgedBy(config), [[LIST_CALL, 'discard', 'only loads the page', 'reviewer']]);
        assert.equal(await p.locator('#center .judgment-error').count(), 0);

        await p.click('#center .call-info .discarded button.undo');
        await p.waitForSelector('#center .call-info .discarded', { state: 'detached' });
        assert.equal(await callRow.locator('.sent-count').textContent(), '호출함 1');
        await p.click('#center .call-info .passed .pair-test button.hand-over');
        await p.waitForSelector('#center .call-info .awaiting-tag');
        assert.equal(await p.textContent('#center .call-info .awaiting-tag h2'), '태그 대기 1');
        assert.equal(await p.locator('#center .call-info .passed').count(), 0);
        assert.match(await p.locator('#center .call-info .target-id').innerText(), /GET:\/api\/v1\/document\/list\s+호출 전체/);
      })));
});

test('in a browser, a chosen untagged browser test shows the screens it opened and the calls it sent as pairs, judges them in one go, and a click on a call pair opens the call on a screen that sends it', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("reads a document from the server")');
        assert.equal(await p.textContent('#center .test-pairs h2'), '이 테스트와 화면·호출의 짝 2');
        const pairs = p.locator('#center .test-pairs .pair');
        assert.deepEqual(await pairs.locator('.pair-state').allTextContents(), ['지나감', '호출함']);
        assert.match((await pairs.nth(0).textContent())!, /^\/home Home/);
        assert.match((await pairs.nth(1).textContent())!, /^GET:\/api\/v1\/document\/\{documentId\}/);
        assert.equal(await p.locator('#center .unmatched').count(), 0);

        await p.check(`${bulk} input.pick-all`);
        await p.click(`${bulk} button.discard`);
        assert.equal(await p.textContent(`${asked} h2`), '짝 2개를 제외합니다');
        assert.match((await p.textContent(`${asked} .subject`))!, /화면과 호출\/home Home.*GET:\/api\/v1\/document\/\{documentId\}$/s);
        await p.click(`${asked} button.cancel`);
        await p.click(`${bulk} button.hand-over`);
        await p.waitForFunction(() => document.querySelectorAll('#center .pair .pair-state.wait').length === 2);
        assert.deepEqual(judgedBy(config), [
          ['/home#Home', 'hand-over', '', 'reviewer'],
          [DETAIL_CALL, 'hand-over', '', 'reviewer'],
        ]);

        await pairs.nth(1).click();
        assert.equal(await p.textContent('#screen-list li.selected .name'), '/document/:id DocumentDetail');
        assert.match(await p.locator('#center .call-info .target-id').innerText(), /GET:\/api\/v1\/document\/\{documentId\}\s+호출 전체/);
        assert.match((await p.textContent('#center .call-info .awaiting-tag'))!, /reads a document from the server/);
      })));
});

type Toggled = { toggled: Promise<unknown> };
// 접은 상태는 toggle 이벤트에서 기억하므로, 그 이벤트가 지나간 뒤에 다음 동작으로 넘어간다.
const closeCallInfo = async (p: Page) => {
  const details = p.locator('#center .call-info');
  await details.evaluate((e) => { (window as unknown as Toggled).toggled = new Promise((resolve) => e.addEventListener('toggle', resolve, { once: true })); });
  await details.locator(':scope > summary').click();
  await p.evaluate(() => (window as unknown as Toggled).toggled);
};

test('in a browser, a call reached from another tab opens its details even when they were closed on that same call, and the middle pane scrolls to them', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const details = p.locator('#center .call-info');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls tr', { hasText: DETAIL_CALL }).first().locator('td.cell').first().click();
        await closeCallInfo(p);
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), false);

        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("reads a document from the server")');
        await p.setViewportSize({ width: 1440, height: 400 });
        await p.locator('#center').evaluate((e) => { e.scrollTop = 0; });
        await p.locator('#center .test-pairs .pair').nth(1).click();
        assert.match(await details.locator('.target-id').innerText(), /GET:\/api\/v1\/document\/\{documentId\}\s+호출 전체/);
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), true);
        const placed = await callInfoContentTop(p);
        assert.ok(placed.top > placed.height, `the call info starts at ${placed.top}px, below the ${placed.height}px the pane shows unscrolled`);
        await waitCallInfoInView(p);
        assert.ok((await p.locator('#center').evaluate((e) => e.scrollTop)) > 0);
      })));
});

test('in a browser, a judgment on a call pair that fails after the call details were closed opens them again and shows the error under the pair', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.evaluate(() => {
          const real = window.fetch;
          window.fetch = (url, init) => (String(url).includes('/api/judgments')
            ? new Promise((resolve, reject) => { (window as unknown as FailSave).failSave = () => reject(new Error('disk full')); })
            : real(url, init));
        });
        const details = p.locator('#center .call-info');
        await p.click('#screen-list li:has-text("/document/:id")');
        await p.locator('table.calls tr', { hasText: DETAIL_CALL }).first().locator('td.cell').first().click();
        await details.locator('.pair-test button.hand-over').first().click();
        await closeCallInfo(p);
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), false);
        await p.evaluate(() => (window as unknown as FailSave).failSave());
        await p.waitForSelector('#center .call-info .judgment-error');
        assert.equal(await details.evaluate((e: HTMLDetailsElement) => e.open), true);
        assert.ok(await details.locator('.judgment-error').isVisible());
        assert.match((await details.locator('.judgment-error').textContent())!, /저장하지 못했습니다: disk full/);
      })));
});

test('in a browser, an untagged browser test lists the addresses it opened that fit no screen, and one with no pairs says whether its trace was read, could not be read or was never written', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(untaggedTab);
        const said = async (title: string) => {
          await p.click(`#untagged-list li:has-text("${title}")`);
          return p.textContent('#center .no-screens');
        };
        assert.equal(await said('wanders off the map'), '이 테스트는 도는 동안 맵에 있는 화면을 열지도, 맵에 있는 호출을 보내지도 않았습니다.');
        assert.equal(await p.textContent('#center .unmatched h2'), '맵에 맞는 화면이 없는 주소 1');
        assert.deepEqual(await p.locator('#center .unmatched li').allTextContents(), ['http://127.0.0.1:4598/nowhere']);

        assert.equal(await said('opens help without a trace'), '이 테스트는 trace 파일 없이 돌아, 어느 화면을 열고 어느 호출을 보냈는지 알 수 없습니다. Playwright 의 trace 옵션을 켜고 다시 돌리면 보입니다.');
        assert.equal(await p.locator('#center .unmatched').count(), 0);
        assert.equal(await said('presses the button without snapshots'), '이 테스트의 trace 파일을 읽지 못해, 어느 화면을 열고 어느 호출을 보냈는지 알 수 없습니다. trace 파일에 화면 스냅숏이 없어 테스트가 연 주소를 알 수 없습니다.');

        await p.click('#untagged-list li:has-text("opens home and then help")');
        assert.deepEqual(await p.locator('#center .test-pairs .pair .pair-state').allTextContents(), ['지나감', '지나감']);
        assert.equal(await p.locator('#center .no-screens').count(), 0);
        assert.equal(await p.locator('#center .unmatched').count(), 0);
      })));
});

test('in a browser, a browser test handed over for a screen goes on waiting for its tag when its latest run left no trace, marked as not confirmed this time', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        const untraced = { source: 'results/playwright-traced/visits.json', file: 'untraced.spec.ts', title: 'opens help without a trace' };
        addJudgment(config.judgmentsDir, { test: untraced, node: '/help#Help', kind: 'hand-over', reason: '', author: 'reviewer' });
        await p.reload();
        await toList(p);
        await p.click('#screen-list li:has-text("/help")');
        assert.equal(await p.textContent('#center .awaiting-tag h2'), '태그 대기 1');
        assert.match((await p.textContent('#center .awaiting-tag .pair-test'))!, /^확인 못 함 통과 opens help without a trace untraced\.spec\.ts:5결과 파일 results\/playwright-traced\/visits\.json/);
        assert.equal(await p.locator('#center .detached').count(), 0);
        await p.click('#center .awaiting-tag button.undo');
        await p.waitForSelector('#center .awaiting-tag', { state: 'detached' });
        assert.equal(await p.locator('#center .detached').count(), 0);
      })));
});

test('in a browser, a skipped browser test with no pairs says that it did not run, not that it ran without a trace', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.route('**/api/data', async (route) => {
          const res = await route.fetch();
          const data: PageData = await res.json();
          data.tests.untagged!.find((t) => t.title.startsWith('loads without errors'))!.status = 'pending';
          await route.fulfill({ response: res, json: data });
        });
        await p.reload();
        await toList(p);
        await p.click(untaggedTab);
        await p.click('#untagged-list li:has-text("loads without errors")');
        assert.equal(await p.textContent('#center .no-screens'), '이 테스트는 건너뛰어 돌지 않았으므로, 어느 화면을 열고 어느 호출을 보내는지 알 수 없습니다.');
      })));
});

const postJson = (base: string, url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const CANDIDATES = { storiesDir: 'example-stories', visitRecords: ['example-visits'] };
const HELP_RECORD = 'example-visits/open-help.json';
const HELP_KEY = '/signin#SignIn > /home#Home > /beta/inbox > /help#Help';
const PUBLISH_KEY = '/home#Home > /document/:tab_draft_done_#DocumentList > /document/:id#DocumentDetail > /help#Help';

test('the data carries the story candidates from the visit records, checked against the map, and the files that could not be read', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const { candidates }: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(candidates.list.map((c) => [c.name, c.source.record, c.screens.length, c.links.map((l) => l.verdict)]), [
        ['open-help', HELP_RECORD, 4, ['open', 'off-map', 'off-map']],
        ['publish-document', 'example-visits/publish-document.json', 4, ['open', 'open', 'conditioned']],
      ]);
      assert.deepEqual(candidates.notices, [{ file: 'example-visits/broken-record.json', reason: '2 번째 단계의 url 을 읽지 못했습니다' }]);
    }),
  );
});

test('the candidates from traces come from the screen orders rebuild wrote into tests.json and stored, so the page still offers and accepts them with the reports and traces gone, and also with a tests.json that has none of them', async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, async (config, copy) => {
    const visits = [HELP_KEY, PUBLISH_KEY];
    const drafts = '/home#Home > /document/:tab_draft_done_#DocumentList';
    fs.rmSync(path.join(copy, 'results/playwright-traced'), { recursive: true });
    await withServer(config, 'reviewer', async (base) => {
      const { candidates }: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(candidates.list.map((c) => c.key), [...visits, '/home#Home > /help#Help', drafts]);
      assert.deepEqual(candidates.notices, [{ file: 'example-visits/broken-record.json', reason: '2 번째 단계의 url 을 읽지 못했습니다' }]);
      assert.equal((await postJson(base, '/api/candidates/accept', { key: '/home#Home > /help#Help', id: 'home-help', name: 'x' })).status, 201);
    });
    const testsFile = path.join(config.outDir, 'tests.json');
    const older = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
    delete older.traced;
    fs.writeFileSync(testsFile, JSON.stringify(older));
    await withServer(config, 'reviewer', async (base) => {
      const { candidates }: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(candidates.list.map((c) => c.key), [...visits, drafts]);
      assert.equal((await postJson(base, '/api/candidates/accept', { key: drafts, id: 'drafts', name: 'x' })).status, 201);
      assert.deepEqual((await (await fetch(`${base}/api/data`)).json() as PageData).candidates.list.map((c) => c.key), visits);
    });
  });
});

test('a candidate accepted through the page becomes a story file with the server-side author, and leaves the candidates', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const res = await postJson(base, '/api/candidates/accept', { key: HELP_KEY, id: 'open-help', name: '홈에서 도움말을 연다', author: 'someone else' });
      assert.equal(res.status, 201);
      const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'open-help.json'), 'utf8'));
      assert.equal(saved.author, 'reviewer');
      assert.deepEqual(saved.source, { record: HELP_RECORD, steps: [1, 5] });
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.ok(data.stories.list.some((s) => s.id === 'open-help' && s.name === '홈에서 도움말을 연다'));
      assert.deepEqual(data.candidates.list.map((c) => c.name), ['publish-document']);

      assert.equal((await postJson(base, '/api/candidates/accept', { key: HELP_KEY, id: 'again', name: 'x' })).status, 404);
      const taken = await postJson(base, '/api/candidates/accept', { key: PUBLISH_KEY, id: 'run-lab', name: 'x' });
      assert.equal(taken.status, 400);
      assert.match(await taken.text(), /run-lab\.json 이 이미 씁니다/);
    }),
  );
});

test('a candidate discarded through the page is kept in the discarded folder with the server-side author and does not come back after the map is rebuilt', async () => {
  await withRebuiltFixture(CANDIDATES, async (config, copy) => {
    await withServer(config, 'reviewer', async (base) => {
      assert.equal((await postJson(base, '/api/candidates/discard', { key: HELP_KEY, reason: ' ' })).status, 400);
      assert.equal((await postJson(base, '/api/candidates/discard', { key: HELP_KEY, reason: '베타 화면', author: 'someone else' })).status, 201);
    });
    const [file] = fs.readdirSync(path.join(config.storiesDir, 'discarded'));
    assert.match(file, /^\d{4}-\d{2}-\d{2}-reviewer-[0-9a-f]{8}\.json$/);
    const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'discarded', file), 'utf8'));
    assert.deepEqual([saved.reason, saved.author], ['베타 화면', 'reviewer']);
    rebuild(copy);
    await withServer(config, 'reviewer', async (base) => {
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.candidates.list.map((c) => c.name), ['publish-document']);
      assert.ok(!data.stories.list.some((s) => s.name === 'open-help'));
    });
  });
});

test('a story name and memo edited through the page are written into its file', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const res = await postJson(base, '/api/stories/edit', { id: 'run-lab', name: '실험실 결과를 본다', memo: '실험실 설정을 켠다.' });
      assert.equal(res.status, 200);
      const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'));
      assert.deepEqual([saved.name, saved.memo, saved.author], ['실험실 결과를 본다', '실험실 설정을 켠다.', 'Kim Min']);
      assert.equal((await postJson(base, '/api/stories/edit', { id: 'run-lab', name: '' })).status, 400);
      assert.equal((await postJson(base, '/api/stories/edit', { id: 'nope', name: 'x', memo: '' })).status, 400);
    }),
  );
});

test('story writes that are not JSON requests are refused', async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', async (base) => {
      for (const url of ['/api/candidates/accept', '/api/candidates/discard', '/api/candidates/undiscard', '/api/stories/edit', '/api/stories/unaccept']) {
        const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
        assert.equal(res.status, 415, url);
      }
      assert.ok(!fs.existsSync(path.join(config.storiesDir, 'discarded')));
    }),
  );
});

const chipsIn = (p: Page, list: string) => p.locator(`${list} li`).evaluateAll((items) => items.map((li) => [...li.querySelectorAll('.chip')].map((c) => c.textContent)));
const storiesTab = '#left .views.side button:has-text("스토리")';
const BAD_REQUEST = 'Failed to load resource: the server responded with a status of 400 (Bad Request)';

test('in a browser, the story list has a group of candidates, a chosen candidate shows its path like a story with the record steps behind each screen, and accepting it writes a story file under the name of the record, or under an ID and a name changed in a window, and moves it to the story list', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.match((await p.textContent('#left'))!, /후보 2/);
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['open-help', 'publish-document']);
        assert.deepEqual(await chipsIn(p, '#candidate-list'), [['화면 없음'], []]);
        assert.deepEqual(await p.locator('#candidate-notices li code').allTextContents(), ['example-visits/broken-record.json']);
        assert.match((await p.textContent('#left'))!, /건너뛴 파일 1/);

        await p.click('#candidate-list li:has-text("open-help")');
        assert.equal(await p.locator('#story-list li.selected').count(), 0);
        assert.equal(await p.textContent('#center h3'), 'open-help');
        assert.equal(await p.textContent('#center .source'), 'example-visits/open-help.json · 단계 1–5');
        assert.deepEqual(await p.locator('#center .story-path .step .records').allTextContents(), ['단계 1', '단계 2', '단계 3–4', '단계 5']);
        assert.equal(await p.textContent('#center .story-path .step.off-map .mono'), '/beta/inbox');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['이어짐', '판정 못 함', '판정 못 함']);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['판정 못 함 · 화면 없음']);
        assert.deepEqual(await p.locator('#right-info > :not(.talk-scope)').evaluateAll((els) => els.slice(0, 2).map((e) => e.textContent)), ['판정 못 함 · 화면 없음', '사전 조건']);
        assert.deepEqual(await p.locator('#right-info h2').allTextContents(), ['사전 조건', '받기']);
        assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '후보');
        assert.deepEqual(await p.locator('#right .story-form button').allTextContents(), ['스토리로 받기', '고쳐서 받기', '버리기']);
        assert.equal(await p.locator('#right .story-form :is(input, textarea)').count(), 0);
        assert.equal(await p.textContent('#right button.accept'), '스토리로 받기');

        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['publish-document']);
        assert.equal(await p.textContent('#center h3'), 'open-help');
        assert.match((await p.textContent('#center .source'))!, /^example-visits\/open-help\.json · 단계 1–5$/);
        const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'open-help.json'), 'utf8'));
        assert.deepEqual([saved.name, saved.author, saved.screens.length], ['open-help', 'reviewer', 4]);

        await p.click('#candidate-list li:has-text("publish-document")');
        assert.deepEqual(await p.locator('#right .accepts button').allTextContents(), ['스토리로 받기', '고쳐서 받기']);
        await p.click('#right button.accept-edited');
        await p.waitForSelector('#accept-ask[open]');
        assert.deepEqual([await p.inputValue('#accept-id'), await p.inputValue('#accept-name')], ['publish-document', 'publish-document']);
        assert.equal(await p.isVisible('#accept-ask .invalid'), false);
        await p.keyboard.press('Escape');
        assert.equal(await p.isVisible('#accept-ask'), false);
        assert.equal(await p.evaluate(() => document.activeElement!.className), 'accept-edited');

        await p.click('#right button.accept-edited');
        await p.fill('#accept-name', ' ');
        assert.equal(await p.isDisabled('#accept-ask button.accept'), true);
        await p.fill('#accept-id', 'publish');
        await p.fill('#accept-name', '문서를 발행한다');
        await p.keyboard.press('Enter');
        await p.waitForSelector('#story-list li.selected:has-text("문서를 발행한다")');
        assert.equal(await p.isVisible('#accept-ask'), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'publish.json'), 'utf8')).name, '문서를 발행한다');
      }),
    ),
  );
});

test('in a browser, accepting a candidate asks for an ID in a window only when the name of the record is already the ID of a story or the server refuses it', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) => {
    fs.writeFileSync(path.join(config.storiesDir, 'open-help.json'), JSON.stringify({ name: '도움말', screens: ['/help#Help'], memo: '', author: 'Kim Min', date: '2026-10-01' }));
    fs.writeFileSync(path.join(config.storiesDir, 'publish-document.json'), '{');
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const ask = '#accept-ask';
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        assert.equal(await p.isVisible(ask), false);
        await p.click('#right button.accept');
        await p.waitForSelector(`${ask}[open]`);
        assert.equal(await p.textContent(`${ask} .candidate`), '후보 open-help');
        assert.equal(await p.inputValue('#accept-id'), 'open-help');
        assert.equal(await p.textContent(`${ask} .invalid`), '같은 ID 의 스토리가 이미 있습니다.');
        assert.equal(await p.isDisabled(`${ask} button.accept`), true);
        await p.fill('#accept-id', 'Open Help');
        assert.equal(await p.textContent(`${ask} .invalid`), '영문 소문자, 숫자, -, _ 만 쓸 수 있습니다.');
        assert.equal(await p.isDisabled(`${ask} button.accept`), true);
        await p.keyboard.press('Escape');
        assert.equal(await p.isVisible(ask), false);
        assert.equal(await p.evaluate(() => document.activeElement!.className), 'accept');
        assert.deepEqual(fs.readdirSync(config.storiesDir).filter((f) => f.startsWith('open-help')), ['open-help.json']);

        await p.click('#right button.accept');
        await p.fill('#accept-id', 'open-help-again');
        assert.equal(await p.isVisible(`${ask} .invalid`), false);
        await p.focus(`${ask} button.cancel`);
        await p.keyboard.press('Enter');
        assert.equal(await p.isVisible(ask), false);
        assert.ok(!fs.existsSync(path.join(config.storiesDir, 'open-help-again.json')));

        await p.click('#right button.accept');
        await p.fill('#accept-id', 'open-help-again');
        await p.keyboard.press('Enter');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        assert.equal(await p.isVisible(ask), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'open-help-again.json'), 'utf8')).name, 'open-help');

        await p.click('#candidate-list li:has-text("publish-document")');
        const writes = holdRequests(p, '**/api/candidates/accept');
        await p.click('#right button.accept');
        await p.waitForFunction(() => document.querySelector<HTMLFieldSetElement>('#right .story-form')!.disabled);
        await p.click('#story-list li:has-text("실험실을 열어")');
        writes.release!();
        await p.waitForSelector('#right .story-error');
        assert.match((await p.textContent('#right .story-error'))!, /저장하지 못했습니다: 스토리 ID publish-document 는 .+ 이미 씁니다/);
        assert.equal(await p.isVisible(ask), false);
        assert.deepEqual(errors.splice(0), [BAD_REQUEST]);
        await p.unroute('**/api/candidates/accept');

        await p.click('#candidate-list li:has-text("publish-document")');
        await p.click('#right button.accept');
        await p.waitForSelector(`${ask}[open]`);
        assert.match((await p.textContent(`${ask} .error`))!, /저장하지 못했습니다: 스토리 ID publish-document 는 .+ 이미 씁니다/);
        assert.equal(await p.locator('#right .story-error').count(), 0);
        assert.equal(await p.inputValue('#accept-id'), 'publish-document');
        await p.click(`${ask} button.accept`);
        await p.waitForFunction(() => /저장하지 못했습니다/.test(document.querySelector('#accept-ask .error')!.textContent) && !document.querySelector<HTMLButtonElement>('#accept-ask button.cancel')!.disabled);
        assert.deepEqual(errors.splice(0), [BAD_REQUEST, BAD_REQUEST]);
        await p.fill('#accept-id', 'publish-document-again');
        await p.click(`${ask} button.accept`);
        await p.waitForSelector('#story-list li.selected:has-text("publish-document")');
        assert.equal(await p.isVisible(ask), false);
        assert.ok(fs.existsSync(path.join(config.storiesDir, 'publish-document-again.json')));
      }),
    );
  });
});

async function discardCandidate(p: Page, reason: string) {
  await p.click('#right button.discard');
  await p.fill(why, reason);
  await p.click(`${asked} button.discard`);
}

test('in a browser, discarding a candidate asks for a reason in the same window as excluding a pair, writes the discarded file, and moves on to the next candidate', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        assert.equal(await p.locator(asked).isVisible(), false);
        await p.click('#right button.discard');
        assert.equal(await p.locator(asked).evaluate((el) => el.matches(':modal')), true);
        assert.equal(await p.textContent(`${asked} h2`), '이 후보를 버립니다');
        assert.match((await p.textContent(`${asked} .subject`))!, /^후보open-help.*example-visits\/open-help\.json화면 순서/s);
        assert.deepEqual(await p.locator(`${asked} .subject ol li`).allTextContents(), ['/signin SignIn', '/home Home', '/beta/inbox', '/help Help']);
        assert.deepEqual(await p.locator(`${asked} button`).allTextContents(), ['취소', '버리기']);
        assert.equal(await p.textContent(`${asked} .hint`), 'Ctrl+Enter 로 버리기');
        assert.equal(await p.getAttribute(why, 'placeholder'), '버리는 까닭');
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), true);
        await p.fill(why, '  \n ');
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), true);
        await p.press(why, 'Control+Enter');
        assert.equal(await p.locator(asked).isVisible(), true);

        await p.press(why, 'Escape');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(await p.evaluate(() => document.activeElement!.className), 'discard');
        assert.ok(!fs.existsSync(path.join(config.storiesDir, 'discarded')));

        await p.click('#right button.discard');
        assert.equal(await p.inputValue(why), '');
        await p.keyboard.type('베타 화면');
        await p.keyboard.press('Enter');
        await p.keyboard.type('아직 열지 않는다 ');
        await p.keyboard.press('Control+Enter');
        await p.waitForSelector('#candidate-list li:only-child');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(await p.textContent('#candidate-list li.selected .name > span:first-child'), 'publish-document');
        assert.equal(await p.textContent('#center h3'), 'publish-document');
        const [file] = fs.readdirSync(path.join(config.storiesDir, 'discarded'));
        const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'discarded', file), 'utf8'));
        assert.deepEqual([saved.name, saved.reason, saved.author], ['open-help', '베타 화면\n아직 열지 않는다', 'reviewer']);

        await discardCandidate(p, '중복');
        await p.waitForSelector('#candidate-list', { state: 'detached' });
        assert.match((await p.textContent('#left'))!, /후보 0/);
        assert.equal(await p.locator('#story-list li.selected').count(), 1);
      }),
    ),
  );
});

test('in a browser, a candidate discard that fails to save leaves the window open with its reason and the error, and saves when sent again', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const refuse = (route: Route) => route.fulfill({ status: 500, body: 'disk full' });
        await p.route('**/api/candidates/discard', refuse);
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        await discardCandidate(p, '베타 화면');
        await p.locator(`${asked} .error`).waitFor();
        assert.deepEqual(errors.splice(0), SAVE_REFUSED);
        assert.equal(await p.textContent(`${asked} .error`), '저장하지 못했습니다: disk full');
        assert.equal(await p.inputValue(why), '베타 화면');
        assert.equal(await askedFocused(p), true);
        assert.equal(await p.locator(`${asked} button.discard`).isDisabled(), false);
        assert.equal(await p.locator('#right .story-error').count(), 0);
        assert.equal(await p.textContent('#candidate-list li.selected .name > span:first-child'), 'open-help');

        await p.unroute('**/api/candidates/discard', refuse);
        await p.press(why, 'Control+Enter');
        await p.waitForSelector('#candidate-list li:only-child');
        assert.equal(await p.locator(asked).isVisible(), false);
        assert.equal(fs.readdirSync(path.join(config.storiesDir, 'discarded')).length, 1);

        await p.click('#right button.discard');
        assert.equal(await p.locator(`${asked} .error`).isVisible(), false);
      }),
    ),
  );
});

test('in a browser, a candidate discarded in another tab and read again while the window is open does not shift which candidate comes next', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("publish-document")');
        await p.click('#right button.discard');
        assert.equal((await postJson(base, '/api/candidates/discard', { key: HELP_KEY, reason: '베타 화면' })).status, 201);
        assert.equal((await postMark(base, { target: { node: '/lab#Lab' }, status: 'missing', note: '' })).status, 201);
        await p.waitForSelector('#candidate-list li:has-text("open-help")', { state: 'detached' });
        await p.fill(why, '중복');
        await p.click(`${asked} button.discard`);
        await p.waitForSelector('#candidate-list li:has-text("publish-document")', { state: 'detached' });
        assert.equal(await p.textContent('#candidate-list li.selected .name > span:first-child'), 'opens home and then help');
      }),
    ),
  );
});

test('in a browser, the tests with a trace that passed two screens or more are candidates beside the visit records, one per screen order with the report and every test title of that order as the source and its order in the address, and accepting or discarding one keeps it from coming back', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, (config, copy) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.match((await p.textContent('#left'))!, /후보 4/);
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['open-help', 'publish-document', 'opens home and then help', 'moves to the drafts without loading a page']);
        assert.deepEqual(await p.locator('#candidate-list li .name > .mono').allTextContents(), [HELP_RECORD, 'example-visits/publish-document.json', 'results/playwright-traced/visits.json', 'results/playwright-traced/visits.json']);

        await p.click('#candidate-list li:has-text("opens home and then help")');
        assert.equal(await p.textContent('#center h3'), 'opens home and then help');
        assert.equal(await p.locator('#center .story-path .step.on-map').count(), 2);
        assert.equal(await p.locator('#center .story-path .step .records').count(), 0);
        assert.equal(await p.locator('#center .source').evaluate((e) => e.firstChild!.textContent), 'results/playwright-traced/visits.json');
        const titles = ['opens home and then help', 'follows a link while waiting for the new address', 'uses the mouse right after the address changes', 'clicks a button that appears after the address changes'];
        assert.deepEqual(await p.locator('#center .source li').allTextContents(), titles);
        assert.equal(await placeOf(p), '#stories?candidate=/home#Home+>+/help#Help');
        await p.reload();
        await p.waitForSelector('#candidate-list li.selected:has-text("opens home and then help")');

        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("opens home and then help")');
        assert.deepEqual(await p.locator('#center .source li').allTextContents(), titles);
        const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'opens-home-and-then-help.json'), 'utf8'));
        assert.deepEqual([saved.screens, saved.source], [['/home#Home', '/help#Help'], { report: 'results/playwright-traced/visits.json', tests: titles }]);

        await p.click('#candidate-list li:has-text("moves to the drafts")');
        await discardCandidate(p, '초안 탭만 연다');
        await p.waitForSelector('#candidate-list li:has-text("moves to the drafts")', { state: 'detached' });
        assert.equal(fs.readdirSync(path.join(config.storiesDir, 'discarded')).length, 1);
        rebuild(copy);
        await p.reload();
        await p.waitForSelector('#candidate-list li');
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['open-help', 'publish-document']);
      }),
    ),
  );
});

test('in a browser, after a candidate is accepted the name and memo form and the mark form hold the new story, not the story viewed before', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.inputValue('#story-name'), '실험실을 열어 결과를 본다');
        await p.click('#right-dock .statuses button:has-text("없음")');
        await p.fill('#right-dock textarea', '실험실 스토리에 쓰던 메모');
        await p.click('#candidate-list li:has-text("open-help")');
        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        assert.equal(await p.inputValue('#story-name'), 'open-help');
        assert.equal(await p.inputValue('#story-memo'), '');
        assert.equal(await p.locator('#right-dock .statuses button.on').count(), 0);
        assert.equal(await p.inputValue('#right-dock textarea'), '');
      }),
    ),
  );
});

const enabledControls = (p: Page) => p.locator('#right-info input, #right-info textarea, #right-info button').evaluateAll((els) => els.filter((e) => !e.matches(':disabled')).map((e) => e.id || e.className));

function holdRequests(p: Page, pattern: string) {
  const held: { sent: string[]; gates: (() => void)[]; done?: Promise<unknown>; release?: () => void } = { sent: [], gates: [] };
  held.done = p.route(pattern, async (route) => {
    held.sent.push(new URL(route.request().url()).pathname);
    await new Promise<void>((resolve) => held.gates.push(resolve));
    await route.continue();
  });
  held.release = () => held.gates.splice(0).forEach((open) => open());
  return held;
}

test('in a browser, the whole 받기, 버리기 and 이름 · 메모 form stays disabled while its write and the reload after it are on their way', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        const writes = holdRequests(p, '**/api/{candidates/*,stories/edit}');
        await writes.done;
        await p.click('#right button.accept');
        await p.waitForFunction(() => document.querySelector('#right button.accept')!.matches(':disabled'));
        assert.deepEqual(await enabledControls(p), []);
        const reloads = holdRequests(p, '**/api/data');
        await reloads.done;
        writes.release!();
        await untilSet(() => reloads.sent.length === 1, 'the reload after the accept');
        assert.deepEqual(await enabledControls(p), []);
        reloads.release!();
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        assert.deepEqual(writes.sent, ['/api/candidates/accept']);
        assert.ok((await enabledControls(p)).includes('story-name'));

        await p.fill('#story-name', '도움말을 연다');
        await p.click('#right button.save-story');
        await p.waitForFunction(() => document.querySelector('#story-name')!.matches(':disabled'));
        assert.deepEqual(await enabledControls(p), []);
        await untilSet(() => writes.sent.length === 2, 'the edit request');
        writes.release!();
        await untilSet(() => reloads.sent.length === 2, 'the reload after the edit');
        assert.deepEqual(await enabledControls(p), []);
        reloads.release!();
        await p.waitForSelector('#story-list li.selected:has-text("도움말을 연다")');
        assert.deepEqual(writes.sent, ['/api/candidates/accept', '/api/stories/edit']);
        assert.equal(await p.inputValue('#story-name'), '도움말을 연다');
        assert.equal(await p.locator('#right .error').count(), 0);
      }),
    ),
  );
});

test('in a browser, with visit records and a map built before links carried their conditions, the candidates group asks to rebuild instead of showing none', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ visitRecords: ['example-visits'] }, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) for (const l of s.links) delete l.conditions;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    await withServer(config, 'reviewer', async (base) => {
      const { candidates } = await (await fetch(`${base}/api/data`)).json();
      assert.match(candidates.stale, /후보를 맞춰 보지 못했습니다\. duru rebuild 로 맵을 다시 만드세요$/);
      await withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.match((await p.textContent('#candidates-stale'))!, /후보를 맞춰 보지 못했습니다/);
        assert.equal(await p.locator('#candidate-list').count(), 0);
      });
    });
  });
});

test('in a browser, a chosen story\'s name and memo can be changed on the right, and saving writes them into its file', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await p.locator('#right h2').allTextContents(), ['사전 조건', '이름 · 메모', '에이전트와 대화']);
        assert.equal(await p.inputValue('#story-name'), '실험실을 열어 결과를 본다');
        assert.equal(await p.inputValue('#story-memo'), '실험실은 고객사 설정에서 켜야 보인다.');
        assert.deepEqual(await p.locator('#right .story-form label > span:first-child').allTextContents(), ['이름', '메모']);
        await p.fill('#story-name', '');
        assert.equal(await p.isDisabled('#right button.save-story'), true);
        await p.fill('#story-name', '실험실 결과를 본다');
        await p.fill('#story-memo', '실험실 설정을 켠다.');
        await p.click('#right button.save-story');
        await p.waitForSelector('#story-list li.selected:has-text("실험실 결과를 본다")');
        assert.equal(await p.textContent('#center h3'), '실험실 결과를 본다');
        assert.equal(await p.textContent('#center .memo'), '실험실 설정을 켠다.');
        const saved = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'run-lab.json'), 'utf8'));
        assert.deepEqual([saved.name, saved.memo, saved.author, saved.date], ['실험실 결과를 본다', '실험실 설정을 켠다.', 'Kim Min', '2026-10-01']);
      }),
    ),
  );
});

test('in a browser, a chosen candidate is a place in the address, and the back button returns to the story shown before it', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await placeOf(p), '#stories?story=run-lab');
        await p.click('#candidate-list li:has-text("open-help")');
        assert.equal(await placeOf(p), `#stories?candidate=${HELP_KEY.replaceAll(' ', '+')}`);

        await p.goBack();
        await p.waitForSelector('#story-list li.selected:has-text("실험실을 열어")');
        assert.equal(await p.locator('#candidate-list li.selected').count(), 0);
        assert.equal(await p.textContent('#center h3'), '실험실을 열어 결과를 본다');

        await p.goForward();
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        assert.equal(await p.textContent('#center h3'), 'open-help');
      }),
    ),
  );
});

test('in a browser, a candidate that was accepted but could not be read back says so on the right', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#candidate-list li:has-text("open-help")');
        await p.route('**/api/data', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'down' }));
        await p.click('#right button.accept');
        await p.waitForSelector('#right .story-error');
        assert.equal(await p.textContent('#right .story-error'), '저장했지만 다시 읽지 못했습니다: down');
        assert.ok(fs.existsSync(path.join(config.storiesDir, 'open-help.json')));
        errors.length = 0;
      }),
    ),
  );
});

const HELP_PATH = ['/signin#SignIn', '/home#Home', '/help#Help'];

test('a screen order sent for checking comes back judged like a story, and one that is empty, not a list or off the map is refused', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const res = await postJson(base, '/api/stories/check', { screens: HELP_PATH });
      assert.equal(res.status, 200);
      const checked: Story = await res.json();
      assert.deepEqual([checked.screens, checked.links.map((l) => l.verdict), checked.broken, checked.detached], [HELP_PATH, ['open', 'broken'], true, false]);
      for (const screens of [[], 'x', undefined, ['/home#Home', 3]]) assert.equal((await postJson(base, '/api/stories/check', { screens })).status, 400);
      const offMap = await postJson(base, '/api/stories/check', { screens: ['/home#Home', '/gone#Gone'] });
      assert.deepEqual([offMap.status, await offMap.text()], [400, '맵에 없는 화면입니다: /gone#Gone']);
      const notJson = await fetch(`${base}/api/stories/check`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(notJson.status, 415);
      assert.equal(fs.existsSync(config.storiesDir), false);
    }),
  );
});

test('a new story posted from the page is written with its screens, name, memo and the server-side author, and is refused when its ID is taken or breaks the rule, a screen repeats or a screen is off the map', async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', async (base) => {
      const res = await postJson(base, '/api/stories/add', { id: 'help-from-signin', name: ' 로그인해 도움말을 연다 ', memo: '홈에 링크가 없다.', screens: HELP_PATH, author: 'someone else' });
      assert.equal(res.status, 201);
      const { date, ...saved } = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'help-from-signin.json'), 'utf8'));
      assert.deepEqual(saved, { name: '로그인해 도움말을 연다', screens: HELP_PATH, memo: '홈에 링크가 없다.', author: 'reviewer' });
      assert.match(date, /^\d{4}-\d{2}-\d{2}T/);
      const data: PageData = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.stories.list.map((st) => [st.id, st.broken]), [['help-from-signin', true]]);

      const refused = async (body: object, why: RegExp) => {
        const r = await postJson(base, '/api/stories/add', { id: 'another', name: 'x', screens: ['/home#Home'], ...body });
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.match(await r.text(), why);
      };
      await refused({ id: 'help-from-signin' }, /help-from-signin\.json 이 이미 씁니다/);
      await refused({ id: 'Help From Signin' }, /스토리 ID 는/);
      await refused({ name: ' ' }, /스토리 이름이 필요합니다/);
      await refused({ memo: 3 }, /memo 는 글자여야 합니다/);
      await refused({ screens: ['/home#Home', '/home#Home'] }, /같은 화면입니다/);
      await refused({ screens: ['/gone#Gone'] }, /맵에 없는 화면입니다/);
      assert.deepEqual(fs.readdirSync(config.storiesDir), ['help-from-signin.json']);
      assert.equal((await postJson(base, '/api/stories/add', { id: 'no-memo', name: 'x', screens: ['/home#Home'] })).status, 201);
      assert.equal(JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'no-memo.json'), 'utf8')).memo, '');
    }),
  );
});

const pickScreen = (p: Page, routePath: string) => p.locator('#pick-list li').filter({ has: p.locator('.name > span:first-child', { hasText: new RegExp(`^${routePath}$`) }) }).click();
const composeSteps = (p: Page) => p.locator('#center .compose-step .screen-path').allTextContents();
const composeLinks = (p: Page) => p.locator('#center .story-path .link .link-verdict').allTextContents();
const untilJudged = (p: Page, links: number) => p.waitForFunction((n) => document.querySelectorAll('#center .story-path .link .link-verdict').length === n && !document.querySelector('#center .link.l-pending'), links);
const stepButton = (step: number, cls: string) => `#center .compose-step[data-step="${step}"] button.${cls}`;
const focusedStepButton = (p: Page) => p.evaluate(() => [document.activeElement!.closest<HTMLElement>('.compose-step')?.dataset.step, document.activeElement!.className]);

async function startNewStory(p: Page) {
  await p.waitForSelector('#screen-list li');
  await p.click(storiesTab);
  await p.click('#left button.new-story');
  await p.waitForSelector('#pick-list li');
}

test('in a browser, 「새 스토리」 turns the left column into a screen picker, each screen pressed becomes the next step with the link from the step before judged at once, and saving writes the story file and shows the new story', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await startNewStory(p);
        assert.equal(await p.locator('#pick-list li').count(), 11);
        assert.equal(await p.textContent('#center h3'), '새 스토리');
        assert.equal(await p.textContent('#center .no-steps'), '아직 넣은 화면이 없습니다.');
        assert.equal(await p.isDisabled('#right button.save-compose'), true);
        assert.equal(await p.locator('#right-dock').isVisible(), false);

        await pickScreen(p, '/signin');
        await pickScreen(p, '/home');
        await pickScreen(p, '/help');
        await untilJudged(p, 2);
        assert.deepEqual(await composeSteps(p), ['/signin', '/home', '/help']);
        assert.deepEqual(await composeLinks(p), ['이어짐', '링크 없음']);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 불가 · 링크 없음 1곳']);
        assert.deepEqual(await p.locator('#center .title-row .chip').allTextContents(), ['링크 없음']);
        assert.deepEqual(await p.locator('#pick-list li .count').allTextContents(), ['넣음 1', '넣음 1', '넣음 1']);

        await p.fill('#compose-id', 'Help From Signin');
        assert.equal(await p.isVisible('label:has(#compose-id) .invalid'), true);
        await p.fill('#compose-id', 'help-from-signin');
        assert.equal(await p.isVisible('label:has(#compose-id) .invalid'), false);
        assert.equal(await p.isDisabled('#right button.save-compose'), true);
        await p.fill('#compose-name', '로그인해 도움말을 연다');
        await p.fill('#compose-memo', '홈에 링크가 없다.');
        assert.equal(await p.isDisabled('#right button.save-compose'), false);
        await p.click('#right button.save-compose');
        await p.waitForSelector('#story-list li.selected:has-text("로그인해 도움말을 연다")');

        const { date, ...saved } = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'help-from-signin.json'), 'utf8'));
        assert.deepEqual(saved, { name: '로그인해 도움말을 연다', screens: HELP_PATH, memo: '홈에 링크가 없다.', author: 'reviewer' });
        assert.equal(await p.textContent('#center h3'), '로그인해 도움말을 연다');
        assert.deepEqual(await p.locator('#center .story-path .link .link-verdict').allTextContents(), ['이어짐', '링크 없음']);
        assert.equal(await p.textContent('#left button.new-story'), '새 스토리');
        assert.equal(await p.locator('#pick-list').count(), 0);
      }),
    ),
  );
});

test('in a browser, moving a step of a new story with 「위로」 or 「아래로」 judges the links again at once and keeps the focus on the moved step, a step goes in before another or comes out, and the same screen twice in a row is refused', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await startNewStory(p);
        await pickScreen(p, '/signin');
        await pickScreen(p, '/home');
        await untilJudged(p, 1);
        assert.deepEqual([await composeLinks(p), await p.locator('#right .verdict').allTextContents()], [['이어짐'], ['도달 가능']]);
        assert.deepEqual([await p.isDisabled(stepButton(0, 'up')), await p.isDisabled(stepButton(1, 'down'))], [true, true]);

        await p.click(stepButton(0, 'down'));
        await p.waitForFunction(() => document.querySelector('#center .story-path .link .link-verdict')?.textContent === '링크 없음');
        assert.deepEqual(await composeSteps(p), ['/home', '/signin']);
        assert.deepEqual(await p.locator('#right .verdict').allTextContents(), ['도달 불가 · 링크 없음 1곳']);
        assert.deepEqual(await focusedStepButton(p), ['1', 'up']);
        await p.keyboard.press('Enter');
        await p.waitForFunction(() => document.querySelector('#center .story-path .link .link-verdict')?.textContent === '이어짐');
        assert.deepEqual(await composeSteps(p), ['/signin', '/home']);
        assert.deepEqual(await focusedStepButton(p), ['0', 'down']);

        await pickScreen(p, '/home');
        assert.equal(await p.textContent('#center .compose-error'), '같은 화면을 이어서 넣을 수 없습니다.');
        assert.deepEqual(await composeSteps(p), ['/signin', '/home']);

        await p.click(stepButton(1, 'insert-before'));
        assert.match((await p.textContent('#center .insert-mark'))!, /^다음에 고르는 화면이 여기 들어갑니다/);
        await pickScreen(p, '/help');
        await pickScreen(p, '/lab');
        await untilJudged(p, 3);
        assert.deepEqual(await composeSteps(p), ['/signin', '/help', '/lab', '/home']);
        assert.equal(await p.locator('#center .compose-error').count(), 0);
        await p.click('#center .insert-mark button.insert-at-end');
        assert.equal(await p.locator('#center .insert-mark').count(), 0);

        await p.click(stepButton(1, 'remove'));
        await untilJudged(p, 2);
        assert.deepEqual(await composeSteps(p), ['/signin', '/lab', '/home']);
        assert.deepEqual(await p.locator('#pick-list li .count').allTextContents(), ['넣음 1', '넣음 1', '넣음 1']);
      }),
    ),
  );
});

test('in a browser, a step of a new story is dragged onto another step to take its place, something else dropped on a step moves nothing, and the name being typed is left alone when a verdict arrives', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await startNewStory(p);
        for (const routePath of ['/signin', '/home', '/help']) await pickScreen(p, routePath);
        await untilJudged(p, 2);
        const name = (await p.$('#compose-name'))!;
        await p.fill('#compose-name', '끌어서 옮긴다');

        await p.evaluate(() => {
          const dropped = new DataTransfer();
          dropped.setData('text/plain', '0');
          document.querySelector('#center .compose-step[data-step="1"]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dropped, bubbles: true, cancelable: true }));
        });
        assert.deepEqual(await composeSteps(p), ['/signin', '/home', '/help']);

        await p.locator('#center .compose-step[data-step="2"]').dragTo(p.locator('#center .compose-step[data-step="0"]'));
        await p.waitForFunction(() => document.querySelector('#center .compose-step .screen-path')?.textContent === '/help');
        await untilJudged(p, 2);
        assert.deepEqual(await composeSteps(p), ['/help', '/signin', '/home']);
        assert.deepEqual(await composeLinks(p), ['링크 없음', '이어짐']);
        assert.equal(await name.evaluate((el: HTMLInputElement) => el.isConnected && el.value), '끌어서 옮긴다');
        assert.equal(await p.textContent('#center h3'), '끌어서 옮긴다');
      }),
    ),
  );
});

test('in a browser, a new story being written is a place in the address and is kept while the reviewer looks at the story list, ending the review asks about it first, and 「쓰던 것 버리기」 throws it away', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await startNewStory(p);
        assert.equal(await placeOf(p), '#stories?new=1');
        await pickScreen(p, '/home');
        await p.fill('#compose-name', '쓰다 만 스토리');
        await p.click('#left button.leave-compose');
        assert.equal(await p.textContent('#left button.new-story'), '새 스토리 이어 쓰기');
        assert.match(await placeOf(p), /^#stories\?story=/);
        assert.equal(await p.locator('#story-list li.selected').count(), 1);

        await p.goBack();
        await p.waitForSelector('#pick-list li');
        assert.deepEqual(await composeSteps(p), ['/home']);
        assert.equal(await p.inputValue('#compose-name'), '쓰다 만 스토리');

        let asked: string | null = null;
        p.once('dialog', (dialog) => {
          asked = dialog.message();
          dialog.dismiss();
        });
        await p.click('#end-review');
        assert.match(asked!, /^저장하지 않은 새 스토리가 있습니다/);
        assert.equal(await p.locator('#ended').count(), 0);

        await p.click('#right button.drop-draft');
        await p.waitForSelector('#story-list li');
        assert.equal(await p.textContent('#left button.new-story'), '새 스토리');
        await p.click('#left button.new-story');
        assert.equal(await p.textContent('#center .no-steps'), '아직 넣은 화면이 없습니다.');
        assert.equal(await p.inputValue('#compose-name'), '');
        assert.deepEqual(fs.readdirSync(config.storiesDir).filter((f) => f.includes('쓰다')), []);
      }),
    ),
  );
});

test('in a browser, the notice that the same screen cannot follow itself stays when a verdict asked for earlier arrives, and goes with the next change', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await startNewStory(p);
        const checks = holdRequests(p, '**/api/stories/check');
        await checks.done;
        await pickScreen(p, '/signin');
        await pickScreen(p, '/home');
        await pickScreen(p, '/home');
        assert.equal(await p.textContent('#center .compose-error'), '같은 화면을 이어서 넣을 수 없습니다.');
        assert.equal(await p.textContent('#center .link.l-pending'), '맞춰 보는 중');
        await untilSet(() => checks.sent.length === 2, 'the two checks');
        checks.release!();
        await untilJudged(p, 1);
        assert.equal(await p.textContent('#center .compose-error'), '같은 화면을 이어서 넣을 수 없습니다.');
        await pickScreen(p, '/help');
        assert.equal(await p.locator('#center .compose-error').count(), 0);
        await untilSet(() => checks.sent.length === 3, 'the third check');
        checks.release!();
        await untilJudged(p, 2);
      }),
    ),
  );
});

test('in a browser, a map built before links carried their conditions has no 「새 스토리」, also with no story file yet, and its address opens the story list', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, async (config) => {
    const mapFile = path.join(config.outDir, 'map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    for (const s of map.screens) for (const l of s.links) delete l.conditions;
    fs.writeFileSync(mapFile, JSON.stringify(map));
    await withServer(config, 'reviewer', async (base) => {
      const refused = await postJson(base, '/api/stories/check', { screens: ['/home#Home'] });
      assert.equal(refused.status, 400);
      assert.match(await refused.text(), /스토리를 맞춰 보지 못했습니다\. duru rebuild 로 맵을 다시 만드세요$/);
      await withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.equal(await p.locator('#left button.new-story').count(), 0);
        await p.evaluate(() => { location.hash = '#stories?new=1'; });
        await p.waitForFunction(() => location.hash === '#stories');
        assert.equal(await p.locator('#pick-list').count(), 0);
      });
    });
  });
});

const paneSteps = (p: Page) => p.locator('#flow-stories .compose-step .screen-path').allTextContents();
const paneLinks = (p: Page) => p.locator('#flow-stories .story-path .link .link-verdict').allTextContents();
const untilPaneJudged = (p: Page, links: number) => p.waitForFunction((n) => document.querySelectorAll('#flow-stories .story-path .link .link-verdict').length === n && !document.querySelector('#flow-stories .link.l-pending'), links);
const pressBox = async (p: Page, id: string) => (await screenBox(p, id)).click();

test('in a browser, 「새 스토리」 of the flow sits in the bar while there is no story yet and opens the story column, and while it is open each box pressed becomes the next step instead of opening the screen and stays where it was with the focus on it, numbered on its box over the whole flow with its links kept as drawn and the link between two neighbouring steps drawn in the style of its verdict, the same box twice in a row is refused as in the list, and 「스토리 목록」 lets a box open its screen again', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#flow .box.screen');
        const drawn = await boxCount(p);
        assert.equal(await p.isVisible('#flow-stories'), false);
        await p.click('#flow-bar button.new-story');
        assert.equal(await placeOf(p), '#flow?new=1');
        assert.equal(await p.textContent('#stories-tab'), '스토리 0 ◀');
        assert.equal(await p.locator('#flow-bar button.new-story').count(), 0);
        assert.equal(await p.textContent('#flow-stories .no-steps'), '아직 넣은 화면이 없습니다.');
        assert.match((await (await screenBox(p, '/home#Home')).getAttribute('title'))!, /\n누르면 새 스토리의 단계로 넣습니다$/);

        await pressBox(p, '/home#Home');
        await p.waitForFunction(() => document.querySelector('#flow .story-badge'));
        const member = await screenBox(p, '/admin/member#AdminMember');
        await member.focus();
        const before = (await member.boundingBox())!;
        await p.keyboard.press('Enter');
        await untilPaneJudged(p, 1);
        assert.deepEqual(await pathMarks(p, 'story-tag'), [['/admin/member#AdminMember', '조건', 'l-conditioned']], 'a mark now stands before the box');
        const after = (await (await screenBox(p, '/admin/member#AdminMember')).boundingBox())!;
        assert.deepEqual([Math.round(after.x), Math.round(after.y)], [Math.round(before.x), Math.round(before.y)]);
        assert.equal(await p.evaluate(() => (document.activeElement as HTMLElement).dataset.key), '/admin/member#AdminMember');
        for (const step of [1, 0]) await p.click(`#flow-stories .compose-step[data-step="${step}"] button.remove`);
        await p.waitForSelector('#flow-stories .no-steps');

        await pressBox(p, '/home#Home');
        await p.waitForFunction(() => document.querySelector('#flow .story-badge'));
        const held = holdRequests(p, '**/api/stories/check');
        const twice = await screenBox(p, '/admin/member#AdminMember');
        const spot = (await twice.boundingBox())!;
        await twice.click();
        await twice.click();
        assert.equal(await p.textContent('#flow-stories .compose-error'), '같은 화면을 이어서 넣을 수 없습니다.');
        await untilSet(() => held.sent.length === 1, 'the check');
        held.release!();
        await untilPaneJudged(p, 1);
        await p.unroute('**/api/stories/check');
        assert.deepEqual(await paneSteps(p), ['/home', '/admin/member']);
        const kept = (await (await screenBox(p, '/admin/member#AdminMember')).boundingBox())!;
        assert.deepEqual([Math.round(kept.x), Math.round(kept.y)], [Math.round(spot.x), Math.round(spot.y)], 'a second press on the same box keeps the place of the first');
        for (const step of [1, 0]) await p.click(`#flow-stories .compose-step[data-step="${step}"] button.remove`);
        await p.waitForSelector('#flow-stories .no-steps');

        for (const id of HELP_PATH) await pressBox(p, id);
        await untilPaneJudged(p, 2);
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);
        assert.deepEqual(await paneLinks(p), ['이어짐', '링크 없음']);
        assert.deepEqual(await p.locator('#flow-stories .verdict').allTextContents(), ['도달 불가 · 링크 없음 1곳']);
        assert.equal(await p.isVisible('#center'), false, 'no screen was opened');
        assert.equal(await boxCount(p), drawn, 'the whole flow stays drawn');
        assert.deepEqual((await pillMarks(p, 'story-badge')).sort(), [['/help#Help', '3'], ['/home#Home', '2'], ['/signin#SignIn', '1']]);
        assert.deepEqual(await pathEdges(p), [['/signin#SignIn', '/home#Home', 'l-open']]);
        assert.deepEqual(await pillMarks(p, 'story-chip'), [['/home#Home', '✕→ 3링크 없음', 'exit', 'l-broken'], ['/help#Help', '✕2 →', 'entry', 'l-broken']]);
        const look = (from: string, to: string) => p.$eval(`#flow svg path[data-from="${from}"][data-to="${to}"]`, (e) => { const c = getComputedStyle(e); return [c.strokeDasharray, c.opacity]; });
        assert.deepEqual(await look('/signin#SignIn', '/help#Help'), ['5px, 4px', '0.9'], 'a guarded link keeps its dashes');

        await pressBox(p, '/help#Help');
        assert.equal(await p.textContent('#flow-stories .compose-error'), '같은 화면을 이어서 넣을 수 없습니다.');
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);
        const scrolled = await p.$eval('#flow', (f) => { f.scrollTop = 40; f.scrollLeft = 40; return [f.scrollTop, f.scrollLeft]; });
        await p.click('#flow-stories .compose-step[data-step="2"] button.remove');
        await untilPaneJudged(p, 1);
        assert.deepEqual(await p.$eval('#flow', (f) => [f.scrollTop, f.scrollLeft]), scrolled, 'a refused press leaves no place to scroll back to');
        const pending = holdRequests(p, '**/api/stories/check');
        await pressBox(p, '/help#Help');
        await untilSet(() => pending.sent.length === 1, 'the check');
        const waiting = await p.$eval('#flow', (f) => { f.scrollTop = 20; f.scrollLeft = 20; return [f.scrollTop, f.scrollLeft]; });
        await p.click('#flow-zoom .zoom-in');
        assert.deepEqual(await p.$eval('#flow', (f) => [f.scrollTop, f.scrollLeft]), waiting, 'a redraw before the verdict leaves the scroll alone');
        await p.click('#flow-zoom .zoom-out');
        pending.release!();
        await untilPaneJudged(p, 2);
        await p.unroute('**/api/stories/check');
        const judged = await p.$eval('#flow', (f) => { f.scrollTop = 20; f.scrollLeft = 20; return [f.scrollTop, f.scrollLeft]; });
        await p.click('#flow-zoom .zoom-in');
        assert.deepEqual(await p.$eval('#flow', (f) => [f.scrollTop, f.scrollLeft]), judged, 'and so does one after it');
        await p.click('#flow-zoom .zoom-out');
        await p.click('#flow .story-chip.exit');
        await untilPaneJudged(p, 3);
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help', '/home'], 'a press on the mark inside a box adds that box');
        assert.deepEqual((await pillMarks(p, 'story-badge')).sort(), [['/help#Help', '3'], ['/home#Home', '2·4'], ['/signin#SignIn', '1']]);
        await p.click('#flow-stories .compose-step[data-step="3"] button.remove');
        await untilPaneJudged(p, 2);
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);

        await p.click('#stories-tab');
        await p.click('#view-list');
        await p.click('#left button.leave-compose');
        await p.click('#view-flow');
        assert.equal(await placeOf(p), '#flow');
        assert.equal(await p.isVisible('#flow-stories'), false);
        assert.equal(await p.textContent('#flow-bar button.new-story'), '새 스토리 이어 쓰기');
        assert.deepEqual(await pillMarks(p, 'story-badge'), []);
        await p.click('#flow-bar button.new-story');
        assert.equal(await p.textContent('#stories-tab'), '스토리 0 ◀', 'the folded column opens again');
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);
        await p.click('#flow-stories button.leave-compose');
        await p.goBack();
        await p.waitForSelector('#flow-stories .compose-step');
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);
        await p.goForward();
        await p.waitForSelector('#flow-bar button.new-story');
        await pressBox(p, '/home#Home');
        await p.waitForSelector('#center', { state: 'visible' });
        assert.equal(await placeOf(p), '#flow?screen=/home#Home');
        assert.deepEqual(errors, []);
      }, { view: 'flow' }),
    ),
  );
});

test('in a browser, a new story written in the list goes on in the flow and back with the same steps, its name being typed is left alone when a verdict arrives, and saving it in the flow writes the same story file as the list does and draws the saved story', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await startNewStory(p);
        await pickScreen(p, '/signin');
        await p.fill('#compose-name', '로그인해 도움말을 연다');
        await p.click('#view-flow');
        await p.waitForSelector('#flow-stories .compose-step');
        assert.equal(await placeOf(p), '#flow?new=1');
        assert.deepEqual(await paneSteps(p), ['/signin']);
        const name = (await p.$('#flow-stories #compose-name'))!;
        assert.equal(await name.inputValue(), '로그인해 도움말을 연다');
        await pressBox(p, '/home#Home');
        await untilPaneJudged(p, 1);
        assert.equal(await name.evaluate((el: HTMLInputElement) => el.isConnected), true);

        await p.click('#view-list');
        await untilJudged(p, 1);
        assert.equal(await placeOf(p), '#stories?new=1');
        assert.deepEqual(await composeSteps(p), ['/signin', '/home']);
        await p.click('#view-flow');
        await untilPaneJudged(p, 1);
        const held = holdRequests(p, '**/api/stories/check');
        await pressBox(p, '/help#Help');
        await untilSet(() => held.sent.length === 1, 'the check');
        await p.click('#view-list');
        held.release!();
        await untilJudged(p, 2);
        await p.unroute('**/api/stories/check');
        assert.deepEqual(await composeSteps(p), ['/signin', '/home', '/help']);
        await p.click('#view-flow');
        await untilPaneJudged(p, 2);
        const scrolled = await p.$eval('#flow', (f) => { f.scrollTop = 40; f.scrollLeft = 40; return [f.scrollTop, f.scrollLeft]; });
        await p.click('#flow-stories .compose-step[data-step="2"] button.remove');
        await untilPaneJudged(p, 1);
        assert.deepEqual(await p.$eval('#flow', (f) => [f.scrollTop, f.scrollLeft]), scrolled, 'a box pressed before going to the list is not scrolled back to later');
        await pressBox(p, '/help#Help');
        await untilPaneJudged(p, 2);
        assert.deepEqual(await paneSteps(p), ['/signin', '/home', '/help']);

        await p.fill('#flow-stories #compose-id', 'help-from-signin');
        await p.fill('#flow-stories #compose-memo', '홈에 링크가 없다.');
        await p.click('#flow-stories button.save-compose');
        await p.waitForSelector('#flow .story-line');
        const { date, ...saved } = JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'help-from-signin.json'), 'utf8'));
        assert.deepEqual(saved, { name: '로그인해 도움말을 연다', screens: HELP_PATH, memo: '홈에 링크가 없다.', author: 'reviewer' });
        assert.equal(await placeOf(p), '#flow?story=help-from-signin');
        assert.equal(await p.textContent('#flow-stories button.new-story'), '새 스토리');
        assert.deepEqual(await lineSteps(p), HELP_PATH.map((id, i) => [String(i + 1), id]));
        assert.deepEqual(errors, []);
      }),
    ),
  );
});

const partOf = (node: string, source: string, file: string, title: string) => ({ node, part: { kind: 'test', key: { source, file, title } } });

test('in a browser, the bubble of a tagged, an importing, a passing and a calling test row puts that test in as the tag, a comment saved with it shows its count on the row, also after reloading, and the status buttons stay off', { skip: browserMissing }, async () => {
  await withRebuiltFixture(TRACED, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        const comment = async (row: Locator, title: string, note: string) => {
          await row.hover();
          await row.locator('.bubble').click();
          assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), `테스트 「${title}」`);
          assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
          await p.fill('#right-dock textarea', note);
          await p.click('#right-dock button.save');
          await row.locator('.part-count', { hasText: '코멘트 1' }).waitFor();
        };
        await chooseScreen(p, '/lab');
        await comment(p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ }), 'opens the lab', 'why pending?');
        await chooseScreen(p, '/home');
        await comment(p.locator('#center .importers .part-row', { hasText: 'DocumentTable' }), 'DocumentTable › lists the documents it is given', 'can this carry the tag?');
        await p.locator('table.calls tbody tr:not(.option)', { hasText: 'GET:/api/v1/document/list' }).locator('td.cell').first().click();
        await comment(p.locator('#center .call-info .passed .part-row', { hasText: 'lists the documents' }), 'lists the documents', 'does it check the rows?');
        await chooseScreen(p, '/help');
        await comment(p.locator('#center .passed .part-row', { hasText: 'follows a link while waiting for the new address' }), 'follows a link while waiting for the new address', 'is help checked here?');

        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status ?? null, m.note]).sort((a, b) => String(a[2]).localeCompare(String(b[2]))), [
          [partOf('/home#Home', 'results/vitest/client-unit.json', 'components/DocumentTable.spec.js', 'DocumentTable › lists the documents it is given'), null, 'can this carry the tag?'],
          [partOf('GET:/api/v1/document/list', 'results/playwright-traced/calls.json', 'calls.spec.ts', 'lists the documents'), null, 'does it check the rows?'],
          [partOf('/help#Help', 'results/playwright-traced/visits.json', 'visits.spec.ts', 'follows a link while waiting for the new address'), null, 'is help checked here?'],
          [partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab'), null, 'why pending?'],
        ]);
        await p.reload();
        await chooseScreen(p, '/lab');
        assert.equal(await p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ }).locator('.part-count').textContent(), '코멘트 1');
        assert.deepEqual(errors, []);
      })));
});

test('in a browser, a test row shows the title without its tags, and without a part of it that held only tags, hides the tags of the screen, call, story and depth it sits under, and shows each other tag, from the title or the tag option, as a label of its own; a tests.json without tags reads them from the title', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        const row = async (selector: string, hasText: string) => {
          const item = p.locator(`${selector} .test`, { hasText }).first();
          return { text: (await item.evaluate((e) => [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim())), tags: await item.locator('.test-tag').allTextContents() };
        };
        await chooseScreen(p, '/lab');
        assert.deepEqual(await row('#center-body table .part-row', 'opens the lab'), { text: 'opens the lab', tags: ['smoke', 'screen:/home#Home', 'role:ADMIN'] });
        await chooseScreen(p, '/home');
        assert.deepEqual(await row('#center-body table .part-row', 'opens the lab'), { text: 'opens the lab', tags: ['screen:/lab#Lab', 'smoke', 'role:ADMIN'] });
        await chooseScreen(p, '/admin/member');
        assert.deepEqual(await row('#center-body table .part-row', 'lists members for an admin'), { text: 'lists members for an admin', tags: ['role:ADMIN'] });
        await chooseScreen(p, '/admin/report');
        await p.locator('table.calls td.cell').first().click();
        assert.deepEqual(await row('#center .call-info .part-row', 'exports with history'), { text: 'exports with history', tags: ['option:withHistory=true'] });

        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.deepEqual(await row('#center .story-tests', 'runs the lab'), { text: 'Lab flow › runs the lab and reads the result', tags: ['role:ADMIN'] });

        const testsFile = path.join(config.outDir, 'tests.json');
        const tests = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
        for (const list of Object.values(tests.nodes) as { tags?: string[] }[][]) for (const t of list) delete t.tags;
        fs.writeFileSync(testsFile, JSON.stringify(tests));
        await p.reload();
        await p.click('#left .views.side button:has-text("화면")');
        await chooseScreen(p, '/lab');
        assert.deepEqual(await row('#center-body table .part-row', 'opens the lab'), { text: 'opens the lab', tags: ['smoke', 'screen:/home#Home', 'role:ADMIN'] });
        await chooseScreen(p, '/admin/member');
        assert.deepEqual(await row('#center-body table .part-row', 'lists members for an admin'), { text: 'lists members for an admin', tags: [] });
      })), [
    ['results/playwright/e2e.json', '"title": "opens the lab @screen:/lab#Lab"', '"title": "@smoke › opens the lab @screen:/lab#Lab @depth:ui @screen:/home#Home @role:ADMIN"'],
    ['results/junit/services.xml', 'runs the lab and reads the result @story:run-lab"', 'runs the lab and reads the result @story:run-lab @depth:api @role:ADMIN"'],
  ]);
});

test('in a browser, the conversation of a screen holds the comments on it and on its tests oldest first, each with its tag; the count of a test row narrows it to that test and its replies, and the status buttons work only while the screen itself is the one tag; with every tag taken off the comment is saved with no target', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const lab = partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab');
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'no table test', author: 'reviewer' }, new Date('2026-10-12T01:00:00Z'));
    const asked = addMark(config.marksDir, { target: lab, note: 'why pending?', author: 'reviewer' }, new Date('2026-10-12T02:00:00Z'));
    addReply(config.marksDir, { replyTo: asked.id, note: 'it waits for the lab data' }, new Date('2026-10-12T03:00:00Z'));
    addMark(config.marksDir, { target: { node: '/lab#Lab', depth: 'api' }, note: 'and the API?', author: 'reviewer' }, new Date('2026-10-12T04:00:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await chooseScreen(p, '/lab');
        const said = () => p.locator('#right-info .history > li').evaluateAll((list) => list.map((li) => [li.querySelector(':scope > .tag')?.textContent, li.querySelector(':scope > div')?.textContent]));
        assert.deepEqual(await said(), [['화면 전체', 'no table test'], ['테스트 「opens the lab」', 'why pending?'], ['API 깊이', 'and the API?']]);
        assert.match((await p.textContent('#right-info .history > li:nth-child(2) .replies'))!, /it waits for the lab data/);

        await p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ }).locator('.part-count').click();
        assert.deepEqual(await said(), [['테스트 「opens the lab」', 'why pending?']]);
        assert.equal(await p.textContent('#right-info .history-filter .tag-label'), '테스트 「opens the lab」');
        await p.click('#right-info .history-filter button');
        assert.equal((await said()).length, 3);

        assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '화면 전체');
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 3);
        const row = p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ });
        await row.hover();
        await row.locator('.bubble').click();
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
        await p.click('#right-dock .mark-form .tags .tag button');
        assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '화면 전체');
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 3);
        await p.click('#right-dock .mark-form .tags .tag button');
        assert.equal(await p.locator('#right-dock .mark-form .tags .tag').count(), 0);
        await p.fill('#right-dock textarea', 'about nothing');
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
        await p.click('#right-dock button.save');
        await p.locator('#right-dock .mark-form .tags .tag-label', { hasText: '화면 전체' }).waitFor();
        assert.deepEqual(loadMarks(config.marksDir).filter((m) => m.note === 'about nothing').map((m) => [m.target, m.targets]), [[undefined, []]]);
      }));
  });
});

test('in a browser, a comment takes more tags from bubbles and typed after @ and is saved once with every target: it counts once on each row it is on and once in 「전체」, shows with its reply whichever row narrows the conversation, shows its tags with the screen of a tag from elsewhere, and a status is refused for it; a comment with no target is listed in 「전체」 under 「대상 없음」 with its whole text and replies', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    const lab = partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab');
    addMark(config.marksDir, { targets: [{ node: '/home#Home' }, partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'a test that is gone')], note: 'half lost', author: 'reviewer' }, new Date('2026-10-12T01:00:00Z'));
    const loose = addMark(config.marksDir, { targets: [], note: 'what about the tour?\nsecond line', author: 'reviewer' }, new Date('2026-10-12T02:00:00Z'));
    addReply(config.marksDir, { replyTo: loose.id, note: 'no tour yet' }, new Date('2026-10-12T03:00:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#left .detached li');
        assert.match((await p.textContent('#left .detached li'))!, /a test that is gone/);
        const said = () => p.locator('#right-info .history > li').evaluateAll((list) => list.map((li) => [[...li.querySelectorAll(':scope > .tag')].map((t) => t.textContent), li.querySelector(':scope > div')?.textContent]));
        await chooseScreen(p, '/home');
        assert.deepEqual(await said(), [[['화면 전체', '화면 /lab · 테스트 「a test that is gone」'], 'half lost']]);

        await chooseScreen(p, '/lab');
        const row = p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ });
        const notice = p.locator('#center-body .part-row', { hasText: 'shows the lab notice' });
        for (const r of [row, notice]) {
          await r.hover();
          await r.locator('.bubble').click();
        }
        const field = p.locator('#right-dock textarea');
        await field.pressSequentially('@API');
        assert.equal(await p.locator('#right-dock .tag-pick li[role=option]').first().textContent(), 'API 깊이');
        await field.press('Enter');
        const tags = ['테스트 「opens the lab」', '테스트 「shows the lab notice」', 'API 깊이'];
        assert.deepEqual(await p.locator('#right-dock .mark-form .tags .tag-label').allTextContents(), tags);
        assert.equal(await field.inputValue(), '');
        assert.equal(await p.locator('#right-dock .tag-pick').isHidden(), true);
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
        await field.pressSequentially('both of these');
        await p.click('#right-dock button.save');
        await row.locator('.part-count', { hasText: '코멘트 1' }).waitFor();
        assert.equal(await notice.locator('.part-count').textContent(), '코멘트 1');
        const saved = loadMarks(config.marksDir).filter((m) => m.note === 'both of these');
        assert.deepEqual(saved.map((m) => [m.target, m.status, m.targets!.map((t) => (t.part?.key as { title?: string } | undefined)?.title ?? t.depth)]), [[undefined, undefined, ['opens the lab', 'shows the lab notice', 'api']]]);
        assert.deepEqual(saved[0].targets![0], lab);
        await p.evaluate(async (replyTo) => {
          await fetch('/api/replies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replyTo, note: 'answered once' }) });
        }, saved[0].id);
        await p.locator('#right-info .history .replies', { hasText: 'answered once' }).waitFor();

        const depthRow = (label: string) => p.locator('#center-body > table tbody tr').filter({ has: p.locator('td.depth', { hasText: label }) });
        assert.equal(await depthRow('API').locator('.talk-count').textContent(), '코멘트 1');
        const scope = p.locator('#right-info .talk-scope button');
        assert.deepEqual(await scope.allTextContents(), ['이 화면 1', '전체 3']);
        assert.deepEqual(await said(), [[['화면 /home', '테스트 「a test that is gone」'], 'half lost'], [tags, 'both of these']]);
        for (const narrow of [depthRow('API').locator('.talk-count'), row.locator('.part-count'), notice.locator('.part-count')]) {
          await narrow.click();
          assert.deepEqual(await said(), [[tags, 'both of these']]);
          assert.match((await p.textContent('#right-info .history .replies'))!, /answered once/);
          await p.click('#right-info .history-filter button');
        }

        const res = await fetch(`${base}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targets: [{ node: '/lab#Lab' }, { node: '/home#Home' }], status: 'missing', note: 'both missing' }) });
        assert.deepEqual([res.status, await res.text()], [400, 'a status takes exactly one target; a comment on several targets or none takes no status']);

        await scope.nth(1).click();
        assert.equal(await p.locator('#right-info .talk-line', { hasText: 'both of these' }).count(), 1);
        const general = p.locator('#right-info .talk-group', { has: p.locator('h3', { hasText: '대상 없음' }) });
        assert.equal(await general.locator('button.talk-line').count(), 0);
        assert.match((await general.locator('.talk-line').textContent())!, /what about the tour\?\nsecond line[\s\S]*no tour yet/);
        assert.deepEqual(errors, []);
      }));
  });
});

test('in a browser, the @ list closes when the caret leaves the @ word and keeps the item picked with the arrows while the caret stays, an Enter that ends a composition does not pick, and a list closed with Escape stays closed; a status picked for the screen is not saved on the one tag left once the screen tag is taken off', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'needs-more', author: 'reviewer' }, new Date('2026-10-12T01:00:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await chooseScreen(p, '/lab');
        const field = p.locator('#right-dock textarea');
        const picker = p.locator('#right-dock .tag-pick');
        const tags = () => p.locator('#right-dock .mark-form .tags .tag-label').allTextContents();
        await p.click('#right-dock .statuses button:has-text("없음")');
        await field.pressSequentially('check @AP');
        await field.press('Home');
        assert.equal(await picker.isHidden(), true);
        await field.press('Enter');
        assert.deepEqual(await tags(), ['화면 전체']);
        await field.press('End');
        assert.equal(await picker.isHidden(), true);
        await field.press('Backspace');
        await field.press('Backspace');
        assert.deepEqual((await picker.locator('li[role=option]').allTextContents()).slice(0, 2), ['UI/E2E 깊이', 'API 깊이']);
        assert.equal(await picker.locator('li.on').textContent(), 'API 깊이');
        await p.keyboard.down('Shift');
        await p.keyboard.up('Shift');
        await field.press('End');
        assert.equal(await picker.locator('li.on').textContent(), 'API 깊이');
        await field.pressSequentially('u');
        assert.equal(await picker.locator('li.on').textContent(), 'UI/E2E 깊이');
        await field.press('Backspace');
        assert.equal(await picker.locator('li.on').textContent(), 'UI/E2E 깊이');
        await field.press('ArrowDown');
        await field.pressSequentially('q');
        assert.equal(await picker.locator('li[role=option]').count(), 0);
        await field.press('Backspace');
        assert.equal(await picker.locator('li.on').textContent(), 'API 깊이');
        await field.pressSequentially('i');
        assert.deepEqual((await picker.locator('li[role=option]').allTextContents()).slice(0, 2), ['UI/E2E 깊이', 'API 깊이']);
        assert.equal(await picker.locator('li.on').textContent(), 'API 깊이');
        await field.press('Enter');
        assert.deepEqual(await tags(), ['화면 전체', 'API 깊이']);
        assert.equal(await field.inputValue(), '\ncheck ');

        await field.pressSequentially('@');
        await field.press('ArrowDown');
        await field.press('Escape');
        await field.pressSequentially(' @');
        assert.equal(await picker.locator('li.on').textContent(), 'UI/E2E 깊이');
        await field.press('Backspace');
        await field.press('Backspace');
        await field.evaluate((e) => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
        assert.deepEqual(await tags(), ['화면 전체', 'API 깊이']);
        assert.equal(await picker.isVisible(), true);
        await field.pressSequentially('zz');
        assert.equal(await picker.locator('li[role=option]').count(), 0);
        await field.press('ArrowUp');
        assert.equal(await field.evaluate((e: HTMLTextAreaElement) => e.selectionStart), 0);
        assert.equal(await picker.isHidden(), true);
        await field.press('ArrowDown');
        await field.press('End');
        await field.press('Backspace');
        await field.press('Backspace');
        await field.press('Escape');
        await field.press('ArrowLeft');
        await field.press('ArrowRight');
        assert.equal(await picker.isHidden(), true);
        assert.equal(await field.inputValue(), '\ncheck @');

        await p.locator('#right-dock .mark-form .tags .tag', { hasText: '화면 전체' }).locator('button').click();
        assert.deepEqual(await tags(), ['API 깊이']);
        assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
        await p.fill('#right-dock textarea', 'depth only');
        await p.click('#right-dock button.save');
        await p.locator('#right-info .history li', { hasText: 'depth only' }).waitFor();
        assert.deepEqual(loadMarks(config.marksDir).filter((m) => m.note === 'depth only').map((m) => [m.target, m.status]), [[{ node: '/lab#Lab', depth: 'api' }, undefined]]);
        assert.deepEqual(errors, []);
      }));
  });
});

test('in a browser, 「전체」 groups every attached comment by its screen, call or story, latest first, filters the unanswered ones and each status, hides the form, and a line opens its place in 「이 화면」 with that comment in view; the screen list, depth rows, call cells, story rows and flow boxes show the count with a red dot while a comment waits for a reply', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config, copy) => {
    const lab = partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab');
    addMark(config.marksDir, { target: { node: 'GET:/api/v1/document/list' }, note: 'is this paged?', author: 'reviewer' }, new Date('2026-10-12T00:30:00Z'));
    addMark(config.marksDir, { target: partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'a test that is gone'), note: 'lost one', author: 'reviewer' }, new Date('2026-10-12T00:40:00Z'));
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'needs-more', note: 'old verdict', author: 'reviewer' }, new Date('2026-10-12T00:45:00Z'));
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'no table test', author: 'reviewer' }, new Date('2026-10-12T01:00:00Z'));
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'missing', author: 'reviewer' }, new Date('2026-10-12T01:30:00Z'));
    const asked = addMark(config.marksDir, { target: lab, note: 'why pending?', author: 'reviewer' }, new Date('2026-10-12T02:00:00Z'));
    addReply(config.marksDir, { replyTo: asked.id, note: 'it waits for the lab data' }, new Date('2026-10-12T03:00:00Z'));
    addMark(config.marksDir, { target: { node: '/lab#Lab', depth: 'api' }, note: 'and the API?\nsecond line', author: 'reviewer' }, new Date('2026-10-12T04:00:00Z'));
    const home = addMark(config.marksDir, { target: { node: '/home#Home' }, note: 'home first?', author: 'reviewer' }, new Date('2026-10-12T05:00:00Z'));
    addMark(config.marksDir, { target: { story: 'run-lab' }, note: 'one more step?', author: 'reviewer' }, new Date('2026-10-12T06:00:00Z'));
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const badge = (row: Locator) => row.locator('.talk-count').evaluate((e) => [e.textContent, !!e.querySelector('.unanswered-dot')]);
        const listed = (path: string) => p.locator('#screen-list li').filter({ has: p.locator('.name > span:first-child', { hasText: new RegExp(`^${path}$`) }) });
        await p.waitForSelector('#screen-list li');
        assert.deepEqual(await badge(listed('/lab')), ['코멘트 4', true]);
        assert.deepEqual(await badge(listed('/home')), ['코멘트 1', true]);
        assert.equal(await listed('/help').locator('.talk-count').count(), 0);

        await chooseScreen(p, '/lab');
        const depthRow = (label: string) => p.locator('#center-body > table tbody tr').filter({ has: p.locator('td.depth', { hasText: label }) });
        assert.deepEqual(await badge(depthRow('화면 전체')), ['코멘트 2', false]);
        assert.deepEqual(await badge(depthRow('API')), ['코멘트 1', true]);
        assert.equal(await p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ }).locator('.part-count .unanswered-dot').count(), 0);
        await depthRow('API').locator('.talk-count').click();
        assert.equal(await p.textContent('#right-info .history-filter .tag-label'), 'API 깊이');
        await chooseScreen(p, '/home');
        assert.deepEqual(await badge(p.locator('table.calls tbody tr:not(.option)', { hasText: 'GET:/api/v1/document/list' }).locator('td.cell').first()), ['코멘트 1', true]);

        const scope = p.locator('#right-info .talk-scope button');
        assert.deepEqual(await scope.allTextContents(), ['이 화면 1', '전체 7']);
        await scope.nth(1).click();
        assert.equal(await p.locator('#right-dock textarea').count(), 0);
        const groups = () => p.locator('#right-info .talk-group').evaluateAll((list) => list.map((g) => [g.querySelector('h3')!.textContent, [...g.querySelectorAll('.talk-line .first')].map((e) => e.textContent)]));
        assert.deepEqual(await groups(), [
          ['스토리 실험실을 열어 결과를 본다', ['one more step?']],
          ['/home', ['home first?']],
          ['/lab', ['and the API?', 'why pending?', 'no table test', 'old verdict']],
          ['호출 GET:/api/v1/document/list', ['is this paged?']],
        ]);
        assert.match((await p.textContent('#right-info .talk-line:has-text("why pending?") .meta'))!, /테스트 「opens the lab」.*· 답 1/);
        const filter = (label: string) => p.locator('#right-info .talk-filters button', { hasText: label });
        assert.equal(await filter('답 없는 것만').textContent(), '답 없는 것만 4');
        await filter('답 없는 것만').click();
        assert.deepEqual((await groups()).map(([, lines]) => lines).flat(), ['one more step?', 'home first?', 'and the API?', 'is this paged?']);
        await filter('없음').click();
        assert.deepEqual(await groups(), [['/lab', ['no table test']]]);
        await filter('더 필요').click();
        assert.deepEqual(await groups(), []);
        await filter('모두').click();
        await p.locator('table.calls tbody tr:not(.option)', { hasText: 'GET:/api/v1/document/list' }).locator('td.cell').first().locator('.talk-count').click();
        assert.equal(await scope.first().getAttribute('aria-pressed'), 'true');
        assert.equal(await p.textContent('#right-info .history-filter .tag-label'), '호출 전체');
        await scope.nth(1).click();

        await p.click('#right-info .talk-line:has-text("and the API?")');
        assert.deepEqual(await scope.allTextContents(), ['이 화면 4', '전체 7']);
        assert.equal(await scope.first().getAttribute('aria-pressed'), 'true');
        assert.match((await p.textContent('#screen-list li.selected'))!, /^\/lab/);
        assert.match((await p.textContent('#right-info .history li.reached'))!, /and the API\?/);
        assert.equal(await p.locator('#right-info .history-filter').count(), 0);

        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#left button.new-story');
        await p.click('#left .views.side button:has-text("화면")');
        await chooseScreen(p, '/lab');
        await scope.nth(1).click();
        await p.click('#right-info .talk-line:has-text("one more step?")');
        assert.equal(await p.textContent('#left .views.side button.on .tab-name'), '스토리');
        assert.match((await p.textContent('#right-dock .history li.reached'))!, /one more step\?/);
        assert.deepEqual(await badge(p.locator('#story-list li', { hasText: '실험실을 열어' })), ['코멘트 1', true]);

        await reply(copy, home.id, 'yes, the home comes first', '--server', `${base}/`);
        await p.click('#left .views.side button:has-text("화면")');
        await listed('/home').locator('.talk-count:not(:has(.unanswered-dot))').waitFor();

        await p.click('#view-flow');
        assert.deepEqual(await badge(p.locator('#flow .box.screen[data-key="/lab#Lab"]')), ['코멘트 4', true]);
        assert.deepEqual(await badge(p.locator('#flow .box.screen[data-key="/home#Home"]')), ['코멘트 1', false]);
        assert.deepEqual(errors, []);
      }));
  });
});

test('in a browser, each step of a story and each link between two steps has a bubble that puts it in as the tag with the status buttons off, a comment saved there shows its count, the count narrows the conversation, and the bubble on a step or a link of the story drawn in the flow opens the story there', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ storiesDir: 'example-stories' }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const comment = async (row: Locator, tag: string, note: string) => {
          await row.locator('.part-row').hover();
          await row.locator('.part-row .bubble').click();
          assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), tag);
          assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
          await p.fill('#right-dock textarea', note);
          await p.click('#right-dock button.save');
          await row.locator('.part-count', { hasText: '코멘트 1' }).waitFor();
        };
        await p.waitForSelector('#screen-list li');
        await p.click('#left .views.side button:has-text("스토리")');
        await p.click('#story-list li:has-text("실험실을 열어")');
        await comment(p.locator('#center .story-path .step').nth(1), '단계 2 /lab', 'check the result table here');
        await comment(p.locator('#center .story-path .link').first(), '단계 1 → 2 연결', 'is this link always there?');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => m.target).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
          { story: 'run-lab', part: { kind: 'hop', key: { step: 1, from: '/home#Home', to: '/lab#Lab' } } },
          { story: 'run-lab', part: { kind: 'step', key: { step: 2, screen: '/lab#Lab' } } },
        ]);
        await p.locator('#center .story-path .step').nth(1).locator('.part-count').click();
        assert.equal(await p.textContent('#right .history-filter .tag-label'), '단계 2 /lab');
        assert.match((await p.textContent('#right .history'))!, /check the result table here/);
        assert.doesNotMatch((await p.textContent('#right .history'))!, /is this link always there/);
        await p.click('#story-list li:has-text("홈에서 개인 설정을")');
        await p.click('#right-info .talk-scope button:nth-child(2)');
        await p.click('#right-info .talk-line:has-text("check the result table here")');
        assert.equal(await p.locator('#right .history li.reached').isVisible(), true);

        await p.click('#view-flow');
        await p.click('#flow-story-list li[data-story="run-lab"]');
        const third = p.locator('#flow .story-line .box[data-step="2"]');
        await third.hover();
        await third.locator('.bubble').click();
        assert.equal(await p.textContent('#view-list.on'), '목록');
        assert.equal(await p.textContent('#left .views.side button.on .tab-name'), '스토리');
        assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '단계 3 /lab/result');
        assert.equal(await p.evaluate(() => document.activeElement?.matches('#right-dock textarea')), true);
        await p.click('#view-flow');
        await p.locator('#flow .story-line .story-hop[data-hop="1"] .bubble').click();
        assert.deepEqual(await p.locator('#right-dock .mark-form .tags .tag-label').allTextContents(), ['단계 3 /lab/result', '단계 2 → 3 연결']);
        assert.deepEqual(errors, []);
      })));
});

test('in a browser, each role and each setting under 「접근 조건」 and each incoming link has a bubble that puts it in as the tag, a comment saved with it shows its count there, the count narrows the conversation, and the same works on a screen picked in the flow', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        const tips = p.locator('#center .open-needs .tips li');
        const comment = async (row: Locator, tag: string, note: string) => {
          await row.hover();
          await row.locator('.bubble').click();
          assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), tag);
          assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
          await p.fill('#right-dock textarea', note);
          await p.click('#right-dock button.save');
          await row.locator('.part-count', { hasText: '코멘트 1' }).waitFor();
        };
        await p.waitForSelector('#screen-list li');
        await chooseScreen(p, '/admin/report');
        await openScreenInfo(p);
        assert.deepEqual(await tips.allInnerTexts(), [
          '필요한 역할: ADMIN',
          '필요한 역할: OWNER',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN.LIST 에 "ADMIN_REPORT"',
          '필요한 설정: SYSTEM.MAIN_MENU.ADMIN 있음',
        ]);
        assert.equal(await tips.nth(0).locator('.bubble').isVisible(), false, 'a bubble shows only on hover');
        await comment(tips.nth(1), '역할 OWNER', 'is OWNER really allowed?');
        await comment(tips.nth(3), '설정 SYSTEM.MAIN_MENU.ADMIN=present', 'is the menu enough?');
        await openLinkGroups(p.locator('#center .access'));
        const home = p.locator('#center .access .link-group li .part-row', { has: p.locator('code.from', { hasText: /^\/home#Home$/ }) });
        await comment(home, '/home#Home 에서 오는 링크', 'is this link shown?');

        const node = '/admin/report#AdminReport';
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status ?? null, m.note]).sort((a, b) => String(a[2]).localeCompare(String(b[2]))), [
          [{ node, part: { kind: 'condition', key: 'role:OWNER' } }, null, 'is OWNER really allowed?'],
          [{ node, part: { kind: 'condition', key: 'setting:SYSTEM.MAIN_MENU.ADMIN=present' } }, null, 'is the menu enough?'],
          [{ node, part: { kind: 'link', key: { from: '/home#Home', conditions: ['role:ADMIN', 'role:OWNER', 'setting:SYSTEM.MAIN_MENU.ADMIN.LIST:ADMIN_REPORT', 'setting:SYSTEM.MAIN_MENU.ADMIN=present'] } } }, null, 'is this link shown?'],
        ]);

        await tips.nth(1).locator('.part-count').click();
        const said = () => p.locator('#right-info .history > li').evaluateAll((list) => list.map((li) => [li.querySelector(':scope > .tag')?.textContent, li.querySelector(':scope > div')?.textContent]));
        assert.deepEqual(await said(), [['역할 OWNER', 'is OWNER really allowed?']]);

        await p.click('#view-flow');
        await (await screenBox(p, node)).click();
        await p.waitForSelector('#flow .box.picked');
        await openScreenInfo(p);
        assert.equal(await tips.nth(1).locator('.part-count').textContent(), '코멘트 1');
        await comment(tips.nth(0), '역할 ADMIN', 'and ADMIN?');
        assert.deepEqual(errors, []);
      })));
});

test('in a browser, a comment on a condition or an incoming link that is gone from the map shows under 「떨어져 나감」 with what it was on', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    addMark(config.marksDir, { target: { node: '/lab#Lab', part: { kind: 'condition', key: 'role:ADMIN' } }, note: 'admins only?', author: 'reviewer' });
    addMark(config.marksDir, { target: { node: '/lab#Lab', part: { kind: 'link', key: { from: '/signin#SignIn', guards: [] } } }, note: 'a link from sign-in?', author: 'reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#left .detached li');
        const texts = await p.locator('#left .detached li').allInnerTexts();
        assert.ok(texts.some((t) => /\/lab#Lab · 역할 ADMIN/.test(t)), texts.join('\n'));
        assert.ok(texts.some((t) => /\/lab#Lab · \/signin#SignIn 에서 오는 링크/.test(t)), texts.join('\n'));
      }));
  });
});

test('in a browser, a comment on a test that is no longer among the results shows under 「떨어져 나감」 with the test title', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) => {
    addMark(config.marksDir, { target: partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab before the rename'), note: 'why pending?', author: 'reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#left .detached li');
        assert.match((await p.textContent('#left .detached li'))!, /\/lab#Lab · 테스트 「opens the lab before the rename」/);
      }));
  });
});

test('in a browser, a case kind picked on a screen shows in its conversation with the status the case was given', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ caseKinds: CASE_KINDS }, (config) => {
    const kind = Object.keys(CASE_KINDS)[0];
    addMark(config.marksDir, { target: { node: '/lab#Lab', case: kind }, status: 'needed', author: 'reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await chooseScreen(p, '/lab');
        assert.equal(await p.textContent('#right-info .history > li .chip'), '필요');
      }));
  });
});

test('in a browser, the default tag taken off with its × leaves a note that can be saved with no target, comes back with the note still typed, and after it or after a bubble typing goes on at the end of the note', { skip: browserMissing }, async () => {
  await withRebuiltFixture({}, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await chooseScreen(p, '/lab');
        await p.fill('#right-dock textarea', 'half a thought');
        await p.click('#right-dock .mark-form .tags .tag button');
        assert.equal(await p.isDisabled('#right-dock button.save'), false);
        await p.click('#right-dock .mark-form .tags button.retag');
        assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '화면 전체');
        assert.equal(await p.inputValue('#right-dock textarea'), 'half a thought');
        await p.keyboard.type(' and the rest');
        assert.equal(await p.inputValue('#right-dock textarea'), 'half a thought and the rest');
        const row = p.locator('#center-body table .part-row', { hasText: /opens the lab home\.spec\.ts/ });
        await row.hover();
        await row.locator('.bubble').click();
        await p.keyboard.type('.');
        assert.equal(await p.inputValue('#right-dock textarea'), 'half a thought and the rest.');
        assert.equal(await p.isDisabled('#right-dock button.save'), false);
      })));
});

test('a comment on a test saved while tests.json cannot be read is still saved and announced, with where as null', async () => {
  await withRebuiltFixture({}, async (config) => {
    const lines: unknown[] = [];
    const server = await startReviewServer(config, { author: signer('reviewer'), onMark: (line) => lines.push(line) });
    try {
      fs.writeFileSync(path.join(config.outDir, 'tests.json'), '{"nodes":');
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await postMark(base, { target: partOf('/lab#Lab', 'results/playwright/e2e.json', 'home.spec.ts', 'opens the lab'), note: 'why pending?' });
      assert.equal(res.status, 201);
      const saved = await res.json();
      assert.deepEqual(lines, [{ duru: 'comment', ...saved, where: null }]);
      assert.equal(loadMarks(config.marksDir).length, 1);
    } finally {
      server.close();
    }
  });
});

const TRACE_CANDIDATE = '/home#Home > /help#Help';
const TRACE_TITLES = ['opens home and then help', 'follows a link while waiting for the new address', 'uses the mouse right after the address changes', 'clicks a button that appears after the address changes'];

test('a comment on a candidate from a trace is announced with its result file, test titles and screen order; once the candidate is accepted it is detached under the candidate name and a reply to it is announced with where as null', async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, async (config) => {
    const lines: unknown[] = [];
    const server = await startReviewServer(config, { author: signer('reviewer'), onMark: (line) => lines.push(line) });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const target = { candidate: TRACE_CANDIDATE };
      const saved = await (await postMark(base, { target, note: 'which test gives this?' })).json();
      const where = { name: 'opens home and then help', source: { report: 'results/playwright-traced/visits.json', tests: TRACE_TITLES }, screens: ['/home#Home', '/help#Help'] };
      assert.deepEqual(lines, [{ duru: 'comment', ...saved, where }]);
      let data: PageData & { candidates: { gone: Record<string, string> } } = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.attached.filter((m) => m.key === `candidate(${TRACE_CANDIDATE})`).map((m) => m.target), [target]);

      assert.equal((await postJson(base, '/api/candidates/accept', { key: TRACE_CANDIDATE, id: 'home-help', name: '홈에서 도움말' })).status, 201);
      const answered = await postJson(base, '/api/replies', { replyTo: saved.id, note: 'the first of the four' });
      assert.equal(answered.status, 201);
      assert.deepEqual(lines.slice(1).map((l) => [(l as { duru: string }).duru, (l as { target: unknown }).target, (l as { where: unknown }).where]), [['reply', target, null]]);
      data = await (await fetch(`${base}/api/data`)).json();
      assert.deepEqual(data.marks.detached.map((m) => m.target), [target]);
      assert.equal(data.candidates.gone[TRACE_CANDIDATE], 'opens home and then help');
      assert.equal(taskList(config), taskList({ ...config, marksDir: path.join(config.outDir, 'no-marks') }));
    } finally {
      server.close();
    }
  });
});

test('in a browser, the bubble of a candidate from a visit record and of one from a trace puts that candidate in as the one tag with the status buttons off, keeping a note already typed, and a comment saved there shows its count on the candidate, also after reloading; the count opens its conversation', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        const comment = async (name: string, note: string) => {
          const row = p.locator('#candidate-list li', { hasText: name });
          await row.hover();
          await row.locator('.bubble').click();
          await p.waitForSelector(`#candidate-list li.selected:has-text("${name}")`);
          assert.equal(await p.evaluate(() => document.activeElement!.matches('#right-dock textarea')), true);
          assert.equal(await p.textContent('#right-dock .mark-form .tags .tag-label'), '후보');
          assert.equal(await p.locator('#right-dock .statuses button:not(:disabled)').count(), 0);
          await p.keyboard.type(note);
          await p.click('#right-dock button.save');
          await p.locator('#candidate-list li', { hasText: name }).locator('.part-count', { hasText: '코멘트 1' }).waitFor();
        };
        await comment('open-help', 'why the beta inbox?');
        await p.fill('#right-dock textarea', 'and here: ');
        await comment('opens home and then help', 'which test gives this?');
        assert.deepEqual(loadMarks(config.marksDir).map((m) => [m.target, m.status ?? null, m.note]).sort((a, b) => String(a[2]).localeCompare(String(b[2]))), [
          [{ candidate: TRACE_CANDIDATE }, null, 'and here: which test gives this?'],
          [{ candidate: HELP_KEY }, null, 'why the beta inbox?'],
        ]);

        await p.reload();
        await p.waitForSelector('#candidate-list li .part-count');
        assert.deepEqual(await p.locator('#candidate-list li').evaluateAll((items) => items.map((li) => li.querySelector('.part-count')?.textContent ?? null)), ['코멘트 1', null, '코멘트 1', null]);
        await p.locator('#candidate-list li', { hasText: 'open-help' }).locator('.part-count').click();
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        assert.equal(await p.getAttribute('#right .history-toggle', 'aria-expanded'), 'true');
        assert.deepEqual(await p.locator('#right-dock .history > li').evaluateAll((list) => list.map((li) => [li.querySelector(':scope > .tag')?.textContent, li.querySelector(':scope > div')?.textContent])), [['후보', 'why the beta inbox?']]);
        assert.deepEqual(errors, []);
      })));
});

test('in a browser, a comment on a story candidate shows in 「전체」 under the candidate\'s name, and pressing it opens that candidate on the stories tab with the comment in view and its own 「이 후보」 count', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) => {
    const asked = addMark(config.marksDir, { target: { candidate: HELP_KEY }, note: 'why the beta inbox?', author: 'reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.locator('#screen-list li').first().click();
        await p.click('#right-info .talk-scope button:nth-child(2)');
        const group = p.locator('#right-info .talk-group', { hasText: '후보 open-help' });
        assert.equal(await group.locator('.talk-line .first').textContent(), 'why the beta inbox?');
        await group.locator('.talk-line').click();
        assert.equal(await p.textContent('#left .views.side button.on .tab-name'), '스토리');
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        const reached = p.locator(`#right [data-record="${asked.id}"]`);
        assert.equal(await reached.getAttribute('class'), 'reached');
        assert.equal(await reached.isVisible(), true);
        assert.deepEqual(await p.locator('#right-info .talk-scope button').allTextContents(), ['이 후보 1', '전체 1']);

        await p.fill('#right-dock textarea', 'half a question');
        await p.locator('#candidate-list li.selected .name').click();
        assert.equal(await p.inputValue('#right-dock textarea'), 'half a question');
        await p.click('#right-info .talk-scope button:nth-child(2)');
        assert.equal(await p.locator('#right-dock textarea').count(), 0);
        const row = p.locator('#candidate-list li.selected');
        await row.hover();
        await row.locator('.bubble').click();
        assert.equal(await p.inputValue('#right-dock textarea'), 'half a question');
        assert.deepEqual(errors, []);
      }));
  });
});

test('in a browser, a story accepted from a candidate has 「받기 되돌리기」, which removes its story file and offers the candidate again picked, with the comments left on the story moved under 「떨어져 나감」 as for a story file gone, while a story not accepted from a candidate has none', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await p.locator('#right button.unaccept').count(), 0);
        await p.click('#candidate-list li:has-text("open-help")');
        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        await p.fill('#right-dock textarea', 'is the beta inbox needed?');
        await p.click('#right-dock button.save');
        await untilSet(() => loadMarks(config.marksDir).length === 1, 'the comment');
        assert.deepEqual(await p.locator('#right-info h2').evaluateAll((els) => els.slice(-2).map((e) => e.textContent)), ['이름 · 메모', '받기 되돌리기']);

        await p.click('#right button.unaccept');
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        assert.equal(fs.existsSync(path.join(config.storiesDir, 'open-help.json')), false);
        assert.equal(await p.locator('#story-list li:has-text("open-help")').count(), 0);
        assert.deepEqual(await p.locator('#candidate-list li .name > span:first-child').allTextContents(), ['open-help', 'publish-document']);
        assert.equal(await p.textContent('#center h3'), 'open-help');
        assert.deepEqual(await p.locator('#right .accepts button').allTextContents(), ['스토리로 받기', '고쳐서 받기']);
        assert.deepEqual(await p.locator('#left .detached li').evaluateAll((items) => items.map((li) => [li.querySelector('code')!.textContent, li.querySelector('div')!.textContent])), [
          ['open-help', 'is the beta inbox needed?'],
        ]);
        assert.equal((await postJson(base, '/api/stories/unaccept', { id: 'run-lab' })).status, 400);
        assert.deepEqual(errors, []);
      }),
    ),
  );
});

test('in a browser, the candidates are followed by 「버린 후보 N」, shut until opened and staying open across a redraw, listing each discarded screen order once with its name, steps, reason and date, the latest discard first', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.equal(await p.locator('#left details.discarded-candidates').count(), 0);
        for (const [name, reason] of [['open-help', '베타 받은편지함은 맵에 없다'], ['publish-document', '문서 쪽은 따로 본다']]) {
          await p.click(`#candidate-list li:has-text("${name}")`);
          await discardCandidate(p, reason);
          await p.waitForSelector(`#candidate-list li:has-text("${name}")`, { state: 'detached' });
        }
        const group = p.locator('#left details.discarded-candidates');
        assert.equal(await p.textContent('#left details.discarded-candidates > summary'), '버린 후보 2');
        assert.equal(await group.evaluate((d: HTMLDetailsElement) => d.open), false);
        assert.equal(await p.isVisible('#discarded-list'), false);
        await p.click('#left details.discarded-candidates > summary');
        const rows = () => p.locator('#discarded-list > li').evaluateAll((items) => items.map((li) => [...li.children].map((c) => c.textContent)));
        const listed = await rows();
        assert.deepEqual(listed.map(([name, steps]) => [name, steps]), [
          ['publish-document', '/home → /document/:tab(draft|done) → /document/:id → /help'],
          ['open-help', '/signin → /home → /beta/inbox → /help'],
        ]);
        assert.match(listed[0][2]!, /^까닭 문서 쪽은 따로 본다 · \d/);
        assert.match(listed[1][2]!, /^까닭 베타 받은편지함은 맵에 없다 · \d/);
        await p.click('#story-list li:has-text("실험실을 열어")');
        assert.equal(await group.evaluate((d: HTMLDetailsElement) => d.open), true);
      }),
    ),
  );
});

test('in a browser, 「되돌리기」 on a discarded candidate writes one undo record beside the discard even when double-clicked, offers the candidate again picked and drops it from 「버린 후보 N」, and a refused undo says why under the list', { skip: browserMissing }, async () => {
  await withRebuiltFixture(CANDIDATES, (config) =>
    withServer(config, 'reviewer', (base) =>
      withPage(base, async (p, errors) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        for (const [name, reason] of [['open-help', '베타 받은편지함은 맵에 없다'], ['publish-document', '문서 쪽은 따로 본다']]) {
          await p.click(`#candidate-list li:has-text("${name}")`);
          await discardCandidate(p, reason);
          await p.waitForSelector(`#candidate-list li:has-text("${name}")`, { state: 'detached' });
        }
        await p.click('#left details.discarded-candidates > summary');
        await p.dblclick('#discarded-list > li:has-text("open-help") button.undiscard');
        await p.waitForSelector('#candidate-list li.selected:has-text("open-help")');
        assert.equal(await p.locator('#left .undiscard-error').count(), 0);
        assert.equal(await p.textContent('#left details.discarded-candidates > summary'), '버린 후보 1');
        assert.deepEqual(await p.locator('#discarded-list > li > div:first-child').allTextContents(), ['publish-document']);
        assert.equal(await p.textContent('#center h3'), 'open-help');
        const records = fs.readdirSync(path.join(config.storiesDir, 'discarded')).map((f) => JSON.parse(fs.readFileSync(path.join(config.storiesDir, 'discarded', f), 'utf8')));
        assert.deepEqual(records.filter((r) => r.kind === 'undo').map(({ screens, author }) => [screens.join(' > '), author]), [[HELP_KEY, 'reviewer']]);

        fs.rmSync(path.join(config.storiesDir, 'discarded'), { recursive: true });
        await p.click('#discarded-list > li:has-text("publish-document") button.undiscard');
        await p.waitForSelector('#left .undiscard-error');
        assert.match(await p.textContent('#left .undiscard-error') ?? '', /^저장하지 못했습니다: 버린 후보 .* 가 없습니다$/);
        assert.equal((await postJson(base, '/api/candidates/undiscard', { screens: ['/home#Home'] })).status, 400);
        assert.deepEqual(errors.splice(0), [BAD_REQUEST]);
      }),
    ),
  );
});

test('in a browser, once a candidate with comments is accepted or discarded, its comments show under 「떨어져 나감」 of the stories with the candidate name, and not under the screens', { skip: browserMissing }, async () => {
  await withRebuiltFixture({ ...CANDIDATES, ...TRACED }, (config) => {
    addMark(config.marksDir, { target: { candidate: HELP_KEY }, note: 'why the beta inbox?', author: 'reviewer' });
    addMark(config.marksDir, { target: { candidate: TRACE_CANDIDATE }, note: 'which test gives this?', author: 'reviewer' });
    return withServer(config, 'reviewer', (base) =>
      withPage(base, async (p) => {
        await p.waitForSelector('#screen-list li');
        await p.click(storiesTab);
        assert.equal(await p.locator('#left .detached li').count(), 0);
        await p.click('#candidate-list li:has-text("open-help")');
        await p.click('#right button.accept');
        await p.waitForSelector('#story-list li.selected:has-text("open-help")');
        await p.click('#candidate-list li:has-text("opens home and then help")');
        await discardCandidate(p, '도움말만 연다');
        await p.waitForSelector('#candidate-list li:has-text("opens home and then help")', { state: 'detached' });
        assert.deepEqual(await p.locator('#left .detached li').evaluateAll((items) => items.map((li) => [li.querySelector('code')!.textContent, li.querySelector('div')!.textContent])), [
          ['후보 opens home and then help', 'which test gives this?'],
          ['후보 open-help', 'why the beta inbox?'],
        ]);
        await p.click('#left .views.side button:has-text("화면")');
        await p.waitForSelector('#screen-list li');
        assert.doesNotMatch((await p.textContent('#left'))!, /후보 open/);
      }));
  });
});
