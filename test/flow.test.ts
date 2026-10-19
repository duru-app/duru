import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildFlow } from '../src/flow.ts';
import type { FlowAccess, FlowMap, FlowMapScreen, FlowScreenNode, FlowTests } from '../src/flow.ts';
import { buildMap } from '../src/map.ts';
import { linkTests } from '../src/test-links.ts';

const config = loadConfig(path.join(import.meta.dirname, 'fixtures/app/config.json'));
const map = await buildMap(config);
const flow = buildFlow(map, linkTests(config, map));

const outline = (node: FlowScreenNode, depth = 0): string[] => [
  `${'  '.repeat(depth)}${node.label}${node.guards.length ? ` [${node.guards.map((alt) => alt.map((g) => g.guard).join(' & ')).join(' 또는 ')}]` : ''}${node.jumps.map((j) => ` → ${j.label}`).join('')}`,
  ...node.children.flatMap((c) => outline(c, depth + 1)),
];
const find = (nodes: FlowScreenNode[], id: string): FlowScreenNode | undefined => nodes.map((n) => (n.id === id ? n : find(n.children, id))).find(Boolean);

test('the flow starts at the entry screens and places each screen once, with the guard of the link that reaches it', () => {
  assert.deepEqual(flow.roots.flatMap((r) => outline(r)), [
    '/signin',
    '  /home',
    '    /document/:tab(draft|done) → /document/:id → /admin/report',
    '    /document/:id → /help → /admin/report',
    "    /admin/member [memberRole === 'ADMIN'] → /admin/audit",
    '    /admin/group [isAdmin]',
    '    /lab [globalSettings.SYSTEM.LAB_ENABLED]',
    '      /lab/result',
    "    /admin/audit [session['member.role'] === 'AUDITOR']",
    "    /admin/report [globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST includes 'ADMIN_REPORT' & ['ADMIN', 'OWNER'].indexOf(session['member.role']) > -1 & MENUS.ADMIN]",
    '  /help [globalSettings.SYSTEM.HELP_LINK_ENABLED]',
  ]);
  assert.deepEqual(flow.unreached, []);
});

test('each screen box carries its test counts, its calls and whether it is dead or opens only under a condition', () => {
  const home = find(flow.roots, '/home#Home')!;
  assert.deepEqual(home.counts, { pass: 5, fail: 2, pending: 1 });
  assert.equal(home.dead, true);
  assert.deepEqual(home.calls.map((c) => [c.id, c.server.status]), [
    ['GET:/api/v1/document/list', 'match'],
    ['POST:/api/v1/archive/document', 'none'],
  ]);
  assert.deepEqual(find(flow.roots, '/lab/result#LabResult')!.kinds, ['setting']);
  assert.deepEqual(find(flow.roots, '/document/:id#DocumentDetail')!.calls.find((c) => c.id.startsWith('PUT:'))!.counts, { pass: 0, fail: 1, pending: 0 });
});

test('each screen box carries the roles and settings its screen needs, and an open screen carries none', () => {
  assert.deepEqual(find(flow.roots, '/home#Home')!.access, {});
  assert.deepEqual(find(flow.roots, '/admin/audit#AdminAudit')!.access, { roleValues: ['ADMIN', 'AUDITOR'], unreadableRoleGuards: [] });
  assert.deepEqual(find(flow.roots, '/admin/group#AdminGroup')!.access, { roleValues: ['ADMIN'], unreadableRoleGuards: ['isAdmin'] });
  const report = find(flow.roots, '/admin/report#AdminReport')!.access;
  assert.deepEqual(report.roleValues, ['ADMIN', 'OWNER']);
  assert.deepEqual([...new Set(report.settings!.flatMap((x) => x.needs.map((n) => n.path.join('.'))))].sort(), ['SYSTEM.MAIN_MENU.ADMIN', 'SYSTEM.MAIN_MENU.ADMIN.LIST']);
});

test('screens no entry screen reaches are grown into their own trees', () => {
  const withoutEntries = buildFlow({ ...map, entries: [] }, { nodes: {} });
  assert.deepEqual(withoutEntries.roots, []);
  assert.deepEqual(withoutEntries.unreached.map((r) => r.label), ['/signin']);
});

test('an entry screen listed twice under one ID, as two routes with the same ID give, is one box', () => {
  const twice = buildFlow({ ...map, entries: [...map.entries, ...map.entries] }, { nodes: {} });
  assert.deepEqual(twice.roots.map((r) => r.id), ['/signin#SignIn']);
  assert.equal(twice.summary.screens, 11);
});

test('links from one screen to another that carry different guards are alternatives, and one open link makes the way open', () => {
  const screen = (id: string, links: FlowAccess['links']): FlowMapScreen => ({ id, path: id, component: id, apiCalls: [], access: { restricted: false, kinds: [], links } });
  const guard = (g: string) => ({ guard: g, kinds: ['setting'] });
  const tiny = (links: FlowAccess['links']): FlowMap => ({ screens: [screen('a', []), screen('b', links)], entries: [{ screen: 'a' }] });
  const guardsOf = (links: FlowAccess['links']) => buildFlow(tiny(links), { nodes: {} }).roots[0].children[0].guards;
  assert.deepEqual(guardsOf([{ from: 'a', guards: [guard('X')] }, { from: 'a', guards: [guard('Y')] }]), [[guard('X')], [guard('Y')]]);
  assert.deepEqual(guardsOf([{ from: 'a', guards: [guard('X')] }, { from: 'a', guards: [] }]), []);
});

test('the flow counts the screens with tagged tests, with a failing test and with only imported tests, and each box carries its imported tests', () => {
  assert.deepEqual(flow.summary, { screens: 11, tested: 7, failing: 5, importedOnly: 0 });
  assert.equal(find(flow.roots, '/help#Help')!.imported, 2);
  assert.equal(find(flow.roots, '/home#Home')!.imported, 1);
  assert.equal(find(flow.roots, '/admin/group#AdminGroup')!.imported, 0);
});

test('a screen with only imported tests counts as such, and one that also has a tagged test does not', () => {
  const screen = (id: string, links: FlowAccess['links'] = []): FlowMapScreen => ({ id, path: id, component: id, apiCalls: [], access: { restricted: false, kinds: [], links } });
  const tiny = { screens: [screen('a'), screen('b', [{ from: 'a', guards: [] }]), screen('c', [{ from: 'a', guards: [] }])], entries: [{ screen: 'a' }] };
  const imported = { title: 'unit', status: 'pass' };
  const tests: FlowTests = { nodes: { a: [{ status: 'fail' }], b: [{ status: 'pass' }] }, importers: { b: [imported], c: [imported, imported] } };
  const built = buildFlow(tiny, tests);
  assert.deepEqual(built.summary, { screens: 3, tested: 2, failing: 1, importedOnly: 1 });

test('a screen that only untagged browser tests passed through counts with the screens that have only imported tests, and its box carries how many passed', () => {
  const screen = (id: string, links: FlowAccess['links']): FlowMapScreen => ({ id, path: id, component: id, apiCalls: [], access: { restricted: false, kinds: [], links } });
  const map = { screens: [screen('a', []), screen('b', [{ from: 'a', guards: [] }]), screen('c', [{ from: 'a', guards: [] }])], entries: [{ screen: 'a' }] };
  const passed = { title: 'browser', status: 'pass', level: 'visit' };
  const built = buildFlow(map, { nodes: { b: [{ status: 'pass' }] }, passed: { b: [passed], c: [passed, passed] } });
  assert.deepEqual(built.summary, { screens: 3, tested: 1, failing: 0, importedOnly: 1 });
  assert.deepEqual([built.roots[0].passed, ...built.roots[0].children.map((n) => n.passed)], [0, 1, 2]);
});
  assert.deepEqual(built.roots[0].children.map((n) => [n.id, n.imported, n.counts.pass]), [['b', 1, 1], ['c', 2, 0]]);
});

test('the box of a call carries how many untagged browser tests sent it, apart from its own tests', () => {
  const endpoints = [{ callId: 'GET:/x' }, { callId: 'POST:/y' }];
  const map: FlowMap = { screens: [{ id: 'a', path: 'a', component: 'a', apiCalls: [{ endpoints }], access: { restricted: false, kinds: [], links: [] } }], calls: [{ id: 'GET:/x', server: { status: 'unchecked' } }, { id: 'POST:/y', server: { status: 'unchecked' } }], entries: [{ screen: 'a' }] };
  const sent = { title: 'browser', status: 'fail', level: 'call' };
  const built = buildFlow(map, { nodes: { 'POST:/y': [{ status: 'pass' }] }, passed: { 'GET:/x': [sent, sent] } });
  assert.deepEqual(built.roots[0].calls.map((c) => [c.id, c.passed, c.counts]), [['GET:/x', 2, { pass: 0, fail: 0, pending: 0 }], ['POST:/y', 0, { pass: 1, fail: 0, pending: 0 }]]);
  assert.deepEqual(built.summary, { screens: 1, tested: 0, failing: 0, importedOnly: 0 });
});

test('a move in the config places a screen no link reached yet under the screen it leaves, marked as a move with its reason', () => {
  const screen = (id: string, links: FlowAccess['links'] = []): FlowMapScreen => ({ id, path: id, component: id, apiCalls: [], access: { restricted: false, kinds: [], links } });
  const tiny = { screens: [screen('a'), screen('b', [{ from: 'a', guards: [] }]), screen('c', [{ from: 'b', guards: [] }])], entries: [{ screen: 'a' }], moves: [{ from: 'a', to: 'c', reason: '로그인 뒤' }] };
  const built = buildFlow(tiny, { nodes: {} });
  assert.deepEqual(built.roots.flatMap((r) => outline(r)), ['a', '  b → c', '  c']);
  assert.deepEqual(built.roots[0].children.map((n) => [n.id, n.guards, n.moved]), [['b', [], undefined], ['c', [], ['로그인 뒤']]]);
  assert.equal(built.roots[0].children[0].jumps[0].moved, undefined);
});

test('a move to a screen already placed in another branch leaves it there and is kept as a jump marked as a move, and entry screens stay entry screens', () => {
  const screen = (id: string): FlowMapScreen => ({ id, path: `/${id}`, component: id, apiCalls: [], access: { restricted: false, kinds: [], links: [] } });
  const tiny = { screens: [screen('signin'), screen('home')], entries: [{ screen: 'signin' }, { screen: 'home' }], moves: [{ from: 'signin', to: 'home', reason: '로그인 뒤' }, { from: 'signin', to: 'home', reason: '새로 고침 뒤' }] };
  const built = buildFlow(tiny, { nodes: {} });
  assert.deepEqual(built.roots.map((r) => [r.id, r.children.length]), [['signin', 0], ['home', 0]]);
  assert.deepEqual(built.roots[0].jumps, [{ to: 'home', label: '/home', guards: [], moved: ['로그인 뒤', '새로 고침 뒤'] }]);
});

test('a link with no guard between the two screens of a move draws the link, and a move between screens joined only by a guarded link is drawn as the move without the guard of the link, also when it reaches a screen in another branch', () => {
  const screen = (id: string, links: FlowAccess['links'] = []): FlowMapScreen => ({ id, path: id, component: id, apiCalls: [], access: { restricted: false, kinds: [], links } });
  const guard = { guard: 'X', kinds: ['setting'] };
  const childOf = (guards: FlowAccess['links'][number]['guards']) => {
    const tiny = { screens: [screen('a'), screen('b', [{ from: 'a', guards }])], entries: [{ screen: 'a' }], moves: [{ from: 'a', to: 'b', reason: '로그인 뒤' }] };
    const { guards: drawn, moved } = buildFlow(tiny, { nodes: {} }).roots[0].children[0];
    return [drawn, moved];
  };
  assert.deepEqual(childOf([]), [[], undefined]);
  assert.deepEqual(childOf([guard]), [[], ['로그인 뒤']]);
  const elsewhere = { screens: [screen('a'), screen('b', [{ from: 'a', guards: [guard] }])], entries: [{ screen: 'a' }, { screen: 'b' }], moves: [{ from: 'a', to: 'b', reason: '로그인 뒤' }] };
  assert.deepEqual(buildFlow(elsewhere, { nodes: {} }).roots[0].jumps, [{ to: 'b', label: 'b', guards: [], moved: ['로그인 뒤'] }]);
});
