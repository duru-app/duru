import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { buildFlow } from '../src/flow.mjs';
import { buildMap } from '../src/map.mjs';
import { linkTests } from '../src/test-links.mjs';

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
  assert.deepEqual(home.counts, { pass: 4, fail: 2, pending: 1 });
  assert.equal(home.dead, true);
  assert.deepEqual(home.calls.map((c) => [c.id, c.server.status]), [
    ['GET:/api/v1/document/list', 'match'],
    ['POST:/api/v1/archive/document', 'none'],
  ]);
  assert.deepEqual(find(flow.roots, '/lab/result#LabResult').kinds, ['setting']);
  assert.deepEqual(find(flow.roots, '/document/:id#DocumentDetail').calls.find((c) => c.id.startsWith('PUT:')).counts, { pass: 0, fail: 1, pending: 0 });
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
