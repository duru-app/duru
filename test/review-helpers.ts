import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { chromium } from 'playwright-core';
import type { Locator, Page } from 'playwright-core';
import { loadJudgments } from '../src/judgments.ts';
import { startReviewServer } from '../src/review.ts';
import type { ReviewAuthor } from '../src/review.ts';

// git exports these to hooks and to rebase --exec; with them set, git in a test folder reads and writes the repository they name.
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];

export const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
export const CLI = path.join(import.meta.dirname, '../src/cli.ts');

export type Config = ReturnType<typeof loadConfig>;

export type Guard = { guard: string; kinds: string[]; roles?: string[] | null; settings?: object[]; via?: unknown };
export type FlowNode = { id: string; imported?: number; label: string; component: string; counts?: object; children: FlowNode[]; calls: { label: string; server?: object; counts?: object }[]; jumps: { to: string; label: string; guards: Guard[] }[]; guards: Guard[] | null };
export type ScreenLink = { from: string; file: string; line: number; guards: Guard[]; fromKinds: string[] };
export type MapScreen = { id: string; path: string; component: string; componentFile?: string; dead?: boolean; routeGuards: string[]; access: { links: ScreenLink[] }; links?: object[]; settingReads?: object[]; apiCalls: object[] };
export type Story = { id: string; name: string; screens: string[]; links: { verdict: string }[]; broken: boolean; detached: boolean; unjudged: boolean; status: string; reach: Reach[]; contentHash: string };
export type Mark = { key: string; target: unknown; current: { status: string; note: string; author: string } };
export type AppData = { url: string; signedOutUrl: string; roles: { role: string; account: string; error: string | null; url: string }[]; settings: { overrides: object[] } };
export type PageData = {
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
  needs: { list: { file: string; name: string; text: string; stories: string[]; contentHash: string }[] };
  candidates: { list: { key: string; name: string; source: { record?: unknown; report?: string; tests?: string[] }; screens: string[]; links: { verdict: string }[] }[]; notices: object[] };
  marks: { attached: Mark[]; detached: Mark[] };
  app: AppData;
};
export type FlowView = { group?: boolean; width?: number; marks?: object[] };
export type FlowBox = { key: string; x: number; y: number; width: number; height: number; grouped: boolean };
export type FlowEdge = { from: string; to: string; x1: number; y1: number; x2: number; y2: number; nx?: number; guards: object[] };
export type FlowColumns = { widths: Record<string, number>; grouped: Set<string>; xs: number[] };

declare const state: any;

export async function withRebuiltFixture<T>(configPatch: object, fn: (config: Config, copy: string) => T | Promise<T>, edits: [string, string, string][] = []) {
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

export const signer = (name: string, source = 'config') => ({ name, source });

export async function withServer<T>(config: Config, author: string | ReviewAuthor | undefined, fn: (base: string) => T | Promise<T>) {
  const server = await startReviewServer(config, { author: typeof author === 'string' ? signer(author) : author });
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

export const postMark = (base: string, body: object) => fetch(`${base}/api/marks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const postJudgment = (base: string, body: object) => fetch(`${base}/api/judgments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const CASE_KINDS = { boundary: '입력 경계: 빈 값, 최대 길이, 특수 문자', legacy: '옛 데이터: 이전 버전에서 만든 문서' };

export function initGitRepoNamed(dir: string, name: string) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', name], { cwd: dir });
}

export const PASSWORD_ENV = 'DURU_TEST_APP_PASSWORD';
export const ADMIN_PASSWORD_ENV = 'DURU_TEST_ADMIN_PASSWORD';
export const AUDITOR_PASSWORD_ENV = 'DURU_TEST_AUDITOR_PASSWORD';
export const ACCOUNTS = {
  'duru-admin': { password: 's3cret', token: 't-123', name: '두루 관리자', documents: [{ id: 17 }, { id: 18 }] },
  'duru-boss': { password: 'b0ss', token: 't-boss', name: '두루 대표', documents: [{ id: 27 }] },
  'duru-auditor': { password: 'aud1t', token: 't-audit', name: '두루 감사', documents: [{ id: 37 }] },
};

export async function withFakeApi<T>(fn: (api: string, presses: string[], logins: string[], listCalls: string[], requests: string[]) => Promise<T>) {
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

export const appSettings = (server: string) => ({
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

export const SETTINGS_FILE = { path: '/settings.js', global: 'window.FAKE_SETTINGS', root: 'globalSettings', merged: ['SYSTEM', 'CUSTOM'] };
export const withSettingsFile = (api: string, extra = {}) => ({ app: { ...appSettings(api).app, settingsFile: SETTINGS_FILE, ...extra } });

export function rewrite(copy: string, rel: string, from: string, to: string) {
  const file = path.join(copy, rel);
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes(from), `${rel} has no ${from}`);
  fs.writeFileSync(file, src.replace(from, to));
}

export const rebuild = (copy: string) => execFileSync(process.execPath, [CLI, 'rebuild', path.join(copy, 'config.json')], { encoding: 'utf8' });

export const LIST_API = { api: '/api/v1/documents', list: 'contents.list', value: 'id' };
export const API_KEY_ENV = 'DURU_TEST_API_KEY';
export const API_KEY = 'k3y-s3cret';
export const ISSUING_API = { api: '/api/v2/one-time-code/create', method: 'POST', header: { 'X-API-KEY': '{key}' }, keyEnv: API_KEY_ENV, body: { memberId: 'duru-admin' }, value: 'contents.code' };
export const VIEW_TOKEN_API = { api: '/api/v1/view-token/create', method: 'POST', header: { 'X-API-KEY': '{key}' }, keyEnv: API_KEY_ENV, body: { referenceType: 'DOCUMENT', referenceId: '{documentId}' }, value: 'contents.accessToken' };
export const VIEW_ROUTE: [string, string, string] = ['client/src/Routes.js', '<Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />',
  "<Route path={'/view/:documentId'} component={waitFor(DocumentDetail)} exact />"];
export const loginWithHeader = { ...appSettings('http://127.0.0.1:1').app.login, header: { Authorization: 'Bearer {token}' } };

export const roleSettings = (server: string, roles: Record<string, string> = { ADMIN: 'duru-boss', AUDITOR: 'duru-auditor' }) => ({
  app: {
    ...appSettings(server).app,
    roles: Object.fromEntries(Object.entries(roles).map(([role, id]) => [role, { id, passwordEnv: id === 'duru-boss' ? ADMIN_PASSWORD_ENV : AUDITOR_PASSWORD_ENV }])),
  },
});

export async function withPasswords<T>(values: Record<string, string | undefined>, fn: () => Promise<T>) {
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

export const withPassword = <T>(value: string | undefined, fn: () => Promise<T>) => withPasswords({ [PASSWORD_ENV]: value }, fn);
export const ALL_PASSWORDS = { [PASSWORD_ENV]: 's3cret', [ADMIN_PASSWORD_ENV]: 'b0ss', [AUDITOR_PASSWORD_ENV]: 'aud1t' };

export const pathValueSettings = (api: string, pathValues: unknown) => ({ app: { ...appSettings(api).app, login: loginWithHeader, pathValues } });

export const browserMissing = fs.existsSync(chromium.executablePath()) ? false : 'Chromium is not installed (npx playwright-core install chromium)';

export const toList = async (p: Page) => {
  await p.waitForSelector('#view-flow.on, #view-list.on');
  await p.click('#view-list');
};

export async function withPage(base: string, fn: (p: Page, errors: string[]) => Promise<void>, { view = 'list', setup }: { view?: string; setup?: (page: Page) => Promise<unknown> } = {}) {
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

export const untaggedTab = '#left .views.side button:has-text("태그 없음")';

export const reply = (copy: string, ...args: string[]) => promisify(execFile)(process.execPath, [CLI, 'reply', path.join(copy, 'config.json'), ...args], { encoding: 'utf8' });
export const decideCase = (copy: string, ...args: string[]) => promisify(execFile)(process.execPath, [CLI, 'case', path.join(copy, 'config.json'), ...args], { encoding: 'utf8' });

export type Kept = { kept?: boolean };

export type FailSave = { failSave: () => void };

export const openScreenInfo = async (p: Page) => {
  const info = p.locator('#center .screen-info');
  await info.waitFor({ state: 'attached' });
  if (!(await info.evaluate((e: HTMLDetailsElement) => e.open))) await info.locator(':scope > summary').click();
};
export const openLinkGroups = (access: Locator) => access.locator('details.link-group').evaluateAll((groups: HTMLDetailsElement[]) => groups.forEach((g) => { g.open = true; }));
export const waitCallInfoInView = async (p: Page) => {
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

// 오른쪽 칸에는 대화만 있으므로, 스크롤할 만큼 긴 대화를 화면과 그 호출마다 미리 남긴다.
export const openDocumentScreenInShortViewport = async (p: Page, base: string) => {
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
export const insideRightPane = (p: Page, selector: string) => p.evaluate((sel) => {
  const pane = document.getElementById('right')!.getBoundingClientRect();
  const box = document.querySelector(sel)!.getBoundingClientRect();
  return box.height > 0 && box.top >= pane.top - 0.5 && box.bottom <= pane.bottom + 0.5;
}, selector);

export const LAB_SETTING = { guard: 'globalSettings.SYSTEM.LAB_ENABLED', kinds: ['setting'], settings: [{ root: 'globalSettings', path: ['SYSTEM', 'LAB_ENABLED'], need: 'on', default: false }] };
export const ADMIN_ROLE = { guard: "memberRole === 'ADMIN'", kinds: ['role'], roles: ['ADMIN'] };
export const LONG_GUARD = `globalSettings.SYSTEM.MAIN_MENU.LAB.LIST includes 'LAB_EXPERIMENTS_${'WITH_A_VERY_LONG_MENU_KEY_'.repeat(4)}END'`;
export const LONG_SETTING = { guard: LONG_GUARD, kinds: ['setting'], settings: [{ root: 'globalSettings', path: ['SYSTEM', 'MAIN_MENU', 'LAB', 'LIST'], need: 'includes', value: 'LAB_EXPERIMENTS' }] };
export const IN_SCREEN_GUARD = "location.pathname.startsWith('/lab/experiments/legacy')";
export const labLink = (from: string, file: string, line: number, guards: Guard[]) => ({ from, file, line, guards, fromKinds: [] });

export async function withLabLinks(fn: (p: Page, open: () => Promise<Locator>, reverse: () => void) => Promise<void>, { only }: { only?: ReturnType<typeof labLink>[] } = {}) {
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

export const screenBox = async (p: Page, id: string) => {
  const box = p.locator(`#flow .box.screen[data-key="${id}"]`).first();
  await box.waitFor({ state: 'attached' });
  return box;
};
export const boxCount = async (p: Page) => p.locator('#flow .box.screen').count();
export const flowButton = (p: Page, label: string) => p.locator('.flowbar button', { hasText: label });
export const filterButton = (p: Page, key: string) => p.locator(`.flowbar .flow-filters button[data-filter="${key}"]`);
export const pickedBoxes = (p: Page) => p.$$eval('#flow .box.screen.picked', (els: HTMLElement[]) => els.map((e) => e.dataset.key));
export const textOutside = (p: Page) => p.$$eval('#flow .box', (els: HTMLElement[]) => els.flatMap((box) => {
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

export const PICK_HINT = '누르면 이 화면에 이어진 길만 진하게 남기고 이 화면을 엽니다';
export const titleLines = async (box: Locator) => (await box.getAttribute('title'))!.split('\n');
export const statusLine = async (box: Locator) => (await titleLines(box))[1];
export const tipLines = async (box: Locator) => (await titleLines(box)).slice(2).filter((line) => line !== PICK_HINT);
export const needTag = (box: Locator) => box.locator('.tag.need').allTextContents();

export const changeData = (edit: (data: PageData) => void) => async (page: Page) => {
  await page.route('**/api/data', async (route) => {
    const res = await route.fetch();
    const data: PageData = await res.json();
    edit(data);
    await route.fulfill({ response: res, json: data });
  });
};
export const walkFlow = (ns: FlowNode[]): FlowNode[] => ns.flatMap((n) => [n, ...walkFlow(n.children)]);
export const leafEntries = (data: PageData, count: number) => {
  const leaves = walkFlow(data.flow.roots).filter((n) => !n.children.length);
  return Array.from({ length: count }, (_, i) => ({ ...structuredClone(leaves[i % leaves.length]), id: `/extra/${i}#Extra${i}`, label: `/extra/${i}`, guards: [] }));
};

export const paneWidths = (p: Page, ids: string[]) => p.evaluate((ids) => ids.map((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().width)), ids);
export const dragEdge = async (p: Page, id: string, dx: number, { off = 3, y }: { off?: number; y?: number } = {}) => {
  const box = (await p.locator(`#${id}`).boundingBox())!;
  const x = box.x + box.width / 2 + off;
  const at = y ?? box.y + box.height / 2;
  await p.mouse.move(x, at);
  await p.mouse.down();
  await p.mouse.move(x + dx, at, { steps: 8 });
  await p.mouse.up();
};
export const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
export const nextFrame = (p: Page) => p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

export const inWindow = (p: Page, selector: string) => p.evaluate((sel) => {
  const r = document.querySelector(sel)!.getBoundingClientRect();
  return { left: r.left, right: r.right, width: document.documentElement.clientWidth };
}, selector);

export const WALK = ['/signin#SignIn', '/home#Home', '/document/:tab#DocumentList', '/document/:id#DocumentDetail', '/help#Help', '/lab#Lab', '/lab/result#LabResult', '/settings#Settings'];
export const WALK_ON_MAP = WALK.slice(0, 7);

export async function withPathStories(stories: Record<string, string[]>, fn: (p: Page, ctx: { base: string; errors: string[]; writeStory: (id: string, screens: string[]) => void; storyFile: (id: string) => string }) => Promise<void>, edits: [string, string, string][] = []) {
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

export const flowPlace = (p: Page) => p.evaluate(() => decodeURIComponent(location.hash));
export const storyRow = (p: Page, id: string) => p.locator(`#story-list li[data-story="${id}"]`);
export const pickPathStory = async (p: Page, id: string) => {
  if (!(await p.locator('#view-story.on').count())) await p.click('#view-story');
  await storyRow(p, id).click();
  await p.waitForFunction((id) => state.view === 'story' && state.story === id && state.candidate === null && state.need === null, id);
};
export const drawnScreens = (p: Page) => p.$$eval('#flow .box.screen', (els) => [...new Set(els.map((e) => e.dataset.key))].sort());
export const lineSteps = (p: Page) => p.$$eval('#center .story-line [data-step]', (els: HTMLElement[]) => els.map((e) => [e.querySelector('.story-badge')!.textContent, e.dataset.screen]));
export const pathMarks = (p: Page, cls: string) => p.$$eval(`#flow .canvas > .${cls}`, (els) => els.map((e) => [e.dataset.at, e.textContent, ...[...e.classList].filter((c) => /^l-/.test(c))]));
export const pillMarks = (p: Page, cls: string) => p.$$eval(`#flow .box.screen .${cls}`, (els) => els.map((e) => [e.closest<HTMLElement>('.box')!.dataset.key, e.textContent, ...[...e.classList].filter((c) => /^(l-.*|exit|entry)$/.test(c))]));
export const pathEdges = (p: Page) => p.$$eval('#flow .canvas svg path.story-edge', (els) => els.map((e) => [e.dataset.from, e.dataset.to, [...e.classList].find((c) => c.startsWith('l-'))]).sort());
export const nowStep = (p: Page) => p.$$eval('#center .story-line .box.now .story-badge', (els) => els.map((e) => e.textContent));

export const chooseScreen = (p: Page, routePath: string) =>
  p.locator('#screen-list li').filter({ has: p.locator('.name > span:first-child', { hasText: new RegExp(`^${routePath}$`) }) }).click();
export const settingRow = (p: Page, name: string) => p.locator('#settings-bar .setting', { has: p.locator('code', { hasText: new RegExp(`^${name}$`) }) });
export type Way = { file: string; line: number; conditions: Guard[] };
export type Reach = { kind: 'route'; screen: string; file: string; line: number; guards: object[] } | { kind: 'link'; from: string; to: string; ways: Way[] } | { kind: 'start'; screen: string; kinds: string[]; roleValues: string[] | null };

export const TRACED = { tests: [
  { format: 'playwright', path: 'results/playwright', depth: 'ui' },
  { format: 'junit', path: 'results/junit', depth: 'api' },
  { format: 'vitest', path: 'results/vitest', depth: 'code' },
  { format: 'verdict', path: 'results/verdict/documents', depth: 'api' },
  { format: 'verdict', path: 'results/verdict/storage', depth: 'data' },
  { format: 'playwright', path: 'results/playwright-traced', depth: 'ui' },
] };

export const asked = '#reason-ask';
export const why = `${asked} textarea`;
export const askedFocused = (p: Page) => p.evaluate((sel) => document.activeElement!.matches(sel), why);

export async function excludeIn(row: Locator, reason: string) {
  await row.locator('button.discard').click();
  await row.page().fill(why, reason);
  await row.page().click(`${asked} button.discard`);
}

export const SAVE_REFUSED = ['Failed to load resource: the server responded with a status of 500 (Internal Server Error)'];

export const DOCUMENT_TABLE = { source: 'results/vitest/client-unit.json', file: 'components/DocumentTable.spec.js', title: 'DocumentTable › lists the documents it is given' };
export const HOME_NODE = '/home#Home';
export const bulk = '#center .bulk-bar';

export async function openDocumentTable(p: Page) {
  await p.waitForSelector('#screen-list li');
  await p.click(untaggedTab);
  await p.click('#untagged-list li:has-text("DocumentTable")');
}

export const untilSet = async <T>(get: () => T, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!get()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return get();
};

export const judgedBy = (config: Config) => loadJudgments(config.judgmentsDir).judgments.map((j) => [j.node, j.kind, j.reason, j.author]).sort();

export const placeOf = (p: Page) => p.evaluate(() => decodeURIComponent(location.hash));
export const DETAIL_CALL = 'GET:/api/v1/document/{documentId}';

export type Toggled = { toggled: Promise<unknown> };
// 접은 상태는 toggle 이벤트에서 기억하므로, 그 이벤트가 지나간 뒤에 다음 동작으로 넘어간다.
export const closeCallInfo = async (p: Page) => {
  const details = p.locator('#center .call-info');
  await details.evaluate((e) => { (window as unknown as Toggled).toggled = new Promise((resolve) => e.addEventListener('toggle', resolve, { once: true })); });
  await details.locator(':scope > summary').click();
  await p.evaluate(() => (window as unknown as Toggled).toggled);
};

export const postJson = (base: string, url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const CANDIDATES = { storiesDir: 'example-stories', visitRecords: ['example-visits'] };
export const HELP_RECORD = 'example-visits/open-help.json';
export const HELP_KEY = '/signin#SignIn > /home#Home > /beta/inbox > /help#Help';
export const PUBLISH_KEY = '/home#Home > /document/:tab#DocumentList > /document/:id#DocumentDetail > /help#Help';
export const storiesTab = '#view-story';
export const BAD_REQUEST = 'Failed to load resource: the server responded with a status of 400 (Bad Request)';

export async function discardCandidate(p: Page, reason: string) {
  await p.click('#center button.discard');
  await p.fill(why, reason);
  await p.click(`${asked} button.discard`);
}

export const storyStack = (p: Page) => p.locator('#center-body > *').evaluateAll((els) => els.map((e) =>
  e.matches('.title-row') ? 'title' : e.matches('.source') ? 'source' : e.matches('details.story-needs') ? 'needs' : e.matches('details.story-gaps') ? 'gaps'
  : e.matches('.story-save') ? 'save' : e.matches(':is(.story-wide, .story-wide-blank)') ? 'whole story' : e.matches('.story-path') ? 'steps' : null).filter(Boolean));

export const rightPane = (p: Page) => p.evaluate(() => ({
  top: [...document.querySelectorAll('#right-info > :not(.talk-scope)')].map((e) => e.className),
  heading: document.querySelector('#right-info .talk h2')?.textContent ?? null,
  bottom: [...document.querySelectorAll('#right-dock > *')].map((e) => e.className),
  folded: document.querySelectorAll('#right-dock :is(.history, .history-toggle)').length,
}));

export function holdRequests(p: Page, pattern: string) {
  const held: { sent: string[]; gates: (() => void)[]; done?: Promise<unknown>; release?: () => void } = { sent: [], gates: [] };
  held.done = p.route(pattern, async (route) => {
    held.sent.push(new URL(route.request().url()).pathname);
    await new Promise<void>((resolve) => held.gates.push(resolve));
    await route.continue();
  });
  held.release = () => held.gates.splice(0).forEach((open) => open());
  return held;
}
