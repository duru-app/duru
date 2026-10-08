import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildFlow } from '../src/flow.ts';
import { buildMap } from '../src/map.ts';
import { linkTests } from '../src/test-links.ts';

const config = loadConfig(path.join(import.meta.dirname, 'fixtures/app/config.json'));
const map = await buildMap(config);
const flow = buildFlow(map, linkTests(config, map));

const outline = (node, depth = 0) => [
  `${'  '.repeat(depth)}${node.label}${node.guards.length ? ` [${node.guards.map((alt) => alt.map((g) => g.guard).join(' & ')).join(' 또는 ')}]` : ''}${node.jumps.map((j) => ` → ${j.label}`).join('')}`,
  ...node.children.flatMap((c) => outline(c, depth + 1)),
];

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
  const find = (nodes, id) => nodes.map((n) => (n.id === id ? n : find(n.children, id))).find(Boolean);
  const home = find(flow.roots, '/home#Home');
  assert.deepEqual(home.counts, { pass: 5, fail: 2, pending: 1 });
  assert.equal(home.dead, true);
  assert.deepEqual(home.calls.map((c) => [c.id, c.server.status]), [
    ['GET:/api/v1/document/list', 'match'],
    ['POST:/api/v1/archive/document', 'none'],
  ]);
  assert.deepEqual(find(flow.roots, '/lab/result#LabResult').kinds, ['setting']);
  assert.deepEqual(find(flow.roots, '/document/:id#DocumentDetail').calls.find((c) => c.id.startsWith('PUT:')).counts, { pass: 0, fail: 1, pending: 0 });
});

test('each screen box carries the roles and settings its screen needs, and an open screen carries none', () => {
  const find = (nodes, id) => nodes.map((n) => (n.id === id ? n : find(n.children, id))).find(Boolean);
  assert.deepEqual(find(flow.roots, '/home#Home').access, {});
  assert.deepEqual(find(flow.roots, '/admin/audit#AdminAudit').access, { roleValues: ['ADMIN', 'AUDITOR'], unreadableRoleGuards: [] });
  assert.deepEqual(find(flow.roots, '/admin/group#AdminGroup').access, { roleValues: ['ADMIN'], unreadableRoleGuards: ['isAdmin'] });
  const report = find(flow.roots, '/admin/report#AdminReport').access;
  assert.deepEqual(report.roleValues, ['ADMIN', 'OWNER']);
  assert.deepEqual([...new Set(report.settings.flatMap((x) => x.needs.map((n) => n.path.join('.'))))].sort(), ['SYSTEM.MAIN_MENU.ADMIN', 'SYSTEM.MAIN_MENU.ADMIN.LIST']);
});

test('a flow grown from one screen reaches every screen below it, including ones the full flow placed under another branch', () => {
  const focused = buildFlow(map, linkTests(config, map), { from: '/document/:tab_draft_done_#DocumentList' });
  assert.deepEqual(focused.roots.flatMap((r) => outline(r)), [
    '/document/:tab(draft|done)',
    '  /document/:id → /admin/report',
    '    /help [helpEnabled]',
    "  /admin/report [globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST includes 'ADMIN_REPORT' & ['ADMIN', 'OWNER'].indexOf(session['member.role']) > -1 & MENUS.ADMIN]",
  ]);
  assert.deepEqual(focused.unreached, []);
  assert.throws(() => buildFlow(map, { nodes: {} }, { from: '/nowhere#Nowhere' }), /unknown screen/);
});

test('screens no entry screen reaches are grown into their own trees', () => {
  const withoutEntries = buildFlow({ ...map, entries: [] }, { nodes: {} });
  assert.deepEqual(withoutEntries.roots, []);
  assert.deepEqual(withoutEntries.unreached.map((r) => r.label), ['/signin']);
});

test('links from one screen to another that carry different guards are alternatives, and one open link makes the way open', () => {
  const screen = (id, links) => ({ id, path: id, component: id, apiCalls: [], access: { kinds: [], links } });
  const guard = (g) => ({ guard: g, kinds: ['setting'] });
  const tiny = (links) => ({ screens: [screen('a', []), screen('b', links)], entries: [{ screen: 'a' }] });
  const guardsOf = (links) => buildFlow(tiny(links), { nodes: {} }).roots[0].children[0].guards;
  assert.deepEqual(guardsOf([{ from: 'a', guards: [guard('X')] }, { from: 'a', guards: [guard('Y')] }]), [[guard('X')], [guard('Y')]]);
  assert.deepEqual(guardsOf([{ from: 'a', guards: [guard('X')] }, { from: 'a', guards: [] }]), []);
});

test('the flow counts the screens with tagged tests, with a failing test and with only imported tests, and each box carries its imported tests', () => {
  assert.deepEqual(flow.summary, { screens: 11, tested: 7, failing: 5, importedOnly: 0 });
  const find = (nodes, id) => nodes.map((n) => (n.id === id ? n : find(n.children, id))).find(Boolean);
  assert.equal(find(flow.roots, '/help#Help').imported, 2);
  assert.equal(find(flow.roots, '/home#Home').imported, 1);
  assert.equal(find(flow.roots, '/admin/group#AdminGroup').imported, 0);
});

test('a screen with only imported tests counts as such, and one that also has a tagged test does not', () => {
  const screen = (id, links = []) => ({ id, path: id, component: id, apiCalls: [], access: { kinds: [], links } });
  const tiny = { screens: [screen('a'), screen('b', [{ from: 'a', guards: [] }]), screen('c', [{ from: 'a', guards: [] }])], entries: [{ screen: 'a' }] };
  const imported = { title: 'unit', status: 'pass' };
  const tests = { nodes: { a: [{ status: 'fail' }], b: [{ status: 'pass' }] }, importers: { b: [imported], c: [imported, imported] } };
  const built = buildFlow(tiny, tests);
  assert.deepEqual(built.summary, { screens: 3, tested: 2, failing: 1, importedOnly: 1 });

test('a screen that only untagged browser tests passed through counts with the screens that have only imported tests, and its box carries how many passed', () => {
  const screen = (id, links) => ({ id, path: id, component: id, apiCalls: [], access: { kinds: [], links } });
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
  const map = { screens: [{ id: 'a', path: 'a', component: 'a', apiCalls: [{ endpoints }], access: { kinds: [], links: [] } }], calls: [{ id: 'GET:/x', server: {} }, { id: 'POST:/y', server: {} }], entries: [{ screen: 'a' }] };
  const sent = { title: 'browser', status: 'fail', level: 'call' };
  const built = buildFlow(map, { nodes: { 'POST:/y': [{ status: 'pass' }] }, passed: { 'GET:/x': [sent, sent] } });
  assert.deepEqual(built.roots[0].calls.map((c) => [c.id, c.passed, c.counts]), [['GET:/x', 2, { pass: 0, fail: 0, pending: 0 }], ['POST:/y', 0, { pass: 1, fail: 0, pending: 0 }]]);
  assert.deepEqual(built.summary, { screens: 1, tested: 0, failing: 0, importedOnly: 0 });
});
