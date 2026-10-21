import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkKey, locateOrder, locatePart } from '../src/parts.ts';
import type { TestPlace } from '../src/parts.ts';

const SCREEN = '/document/:id#DocumentDetail';
const CALL = 'GET:/api/v1/document/:id';

const tagged = { title: 'detail opens @screen:/document/:id#DocumentDetail', file: 'e2e/detail.spec.ts', line: 12, project: 'chromium', source: 'results/playwright/report.json', format: 'playwright', depth: 'ui', status: 'pass' };
const TESTS = {
  nodes: {
    [SCREEN]: [tagged, { ...tagged, project: 'firefox', status: 'fail' }],
    [CALL]: [{ title: 'detail is read', file: null, line: null, source: 'results/verdict/documents/run.txt', format: 'verdict', depth: 'api', status: 'fail', detail: 'got 500' }],
  },
  importers: {
    [SCREEN]: [{ title: 'formats the date', file: '/ci/work/client/src/util.test.ts', line: 4, source: 'results/vitest/report.json', format: 'vitest', depth: 'code', status: 'pass', testFile: 'client/src/util.test.ts', via: ['util.js'] }],
  },
  passed: {
    [SCREEN]: [{ title: 'inbox opens a document', file: 'e2e/inbox.spec.ts', line: 30, project: null, source: 'results/playwright/report.json', format: 'playwright', depth: 'ui', status: 'pending', level: 'visit' }],
    [CALL]: [{ title: 'inbox opens a document', file: 'e2e/inbox.spec.ts', line: 30, project: null, source: 'results/playwright/report.json', format: 'playwright', depth: 'ui', status: 'pass', level: 'call' }],
  },
};

const at = (node: string, key: object) => locatePart({ node, part: { kind: 'test', key } as never }, { tests: TESTS }) as TestPlace | null;

test('a test tagged with the screen is found with its test file and line, result file, status and relation, failing if it fails under any project', () => {
  assert.deepEqual(at(SCREEN, { source: 'results/playwright/report.json', file: 'e2e/detail.spec.ts', title: 'detail opens' }), {
    file: 'e2e/detail.spec.ts', line: 12, source: 'results/playwright/report.json', status: 'fail', relation: 'tagged',
  });
});

test('a verdict line test keeps the text after its verdict, and a test with no file or line is found with them as null', () => {
  assert.deepEqual(at(CALL, { source: 'results/verdict/documents/run.txt', file: null, title: 'detail is read' }), {
    file: null, line: null, source: 'results/verdict/documents/run.txt', status: 'fail', relation: 'tagged', detail: 'got 500',
  });
});

test('a unit test importing a file of the screen is found at the test file under srcRoot, and a browser test is found as passing through the screen or calling the call', () => {
  assert.deepEqual(at(SCREEN, { source: 'results/vitest/report.json', file: 'client/src/util.test.ts', title: 'formats the date' }), {
    file: 'client/src/util.test.ts', line: 4, source: 'results/vitest/report.json', status: 'pass', relation: 'imported',
  });
  const inbox = { source: 'results/playwright/report.json', file: 'e2e/inbox.spec.ts', title: 'inbox opens a document' };
  assert.equal(at(SCREEN, inbox)!.relation, 'passed');
  assert.equal(at(SCREEN, inbox)!.status, 'pending');
  assert.equal(at(CALL, inbox)!.relation, 'called');
  assert.equal(at(CALL, inbox)!.status, 'pass');
});

test('a test is not found once its title or file changes, under another node, or from another result file', () => {
  const key = { source: 'results/playwright/report.json', file: 'e2e/detail.spec.ts', title: 'detail opens' };
  assert.equal(at(SCREEN, { ...key, title: 'detail opens fast' }), null);
  assert.equal(at(SCREEN, { ...key, file: 'e2e/moved/detail.spec.ts' }), null);
  assert.equal(at(SCREEN, { ...key, source: 'results/playwright/other.json' }), null);
  assert.equal(at(CALL, key), null);
  assert.equal(at('/gone#Gone', key), null);
});

const ON = (path: string[]) => ({ root: 'globalSettings', path, need: 'on' });
const REPORT_LIST = { root: 'globalSettings', path: ['MENU', 'LIST'], need: 'includes', value: 'REPORT' };
const SCREENS = [
  {
    id: '/home#Home', routeFile: 'Routes.js', line: 10,
    access: { restricted: false, kinds: [], route: [], links: [] },
  },
  {
    id: '/admin/member#AdminMember', routeFile: 'Routes.js', line: 12,
    access: {
      restricted: true, kinds: ['role'], roleValues: ['ADMIN'],
      route: [{ guard: 'isAdminRole(memberRole)', kinds: ['role'], roles: ['ADMIN'] }],
      links: [{ from: '/home#Home', file: 'components/Home.js', line: 17, guards: [{ guard: "memberRole === 'ADMIN'", kinds: ['role'], roles: ['ADMIN'] }], fromKinds: [] }],
    },
  },
  {
    id: '/admin/audit#AdminAudit', routeFile: 'Routes.js', line: 14,
    access: {
      restricted: true, kinds: ['role'], roleValues: ['ADMIN', 'AUDITOR'], route: [],
      links: [
        { from: '/admin/member#AdminMember', file: 'components/AdminMember.js', line: 14, guards: [], fromKinds: ['role'] },
        { from: '/home#Home', file: 'components/Home.js', line: 20, guards: [{ guard: 'canAudit', kinds: ['role'], roles: ['AUDITOR'], via: 'openAudit' }], fromKinds: [] },
      ],
    },
  },
  {
    id: '/lab#Lab', routeFile: 'Routes.js', line: 16,
    access: {
      restricted: true, kinds: ['setting'],
      route: [{ guard: 'globalSettings.LAB', kinds: ['setting'], settings: [ON(['LAB'])] }],
      links: [
        { from: '/home#Home', file: 'components/Home.js', line: 19, guards: [{ guard: 'globalSettings.LAB', kinds: ['setting'], settings: [ON(['LAB'])] }, { guard: "menu.includes('REPORT')", kinds: ['setting'], settings: [REPORT_LIST] }], fromKinds: [] },
        { from: '/home#Home', file: 'components/Home.js', line: 30, guards: [{ guard: "menu.includes('REPORT')", kinds: ['setting'], settings: [REPORT_LIST] }, { guard: 'labOn', kinds: ['setting'], settings: [ON(['LAB'])] }], fromKinds: [] },
        { from: '/admin/member#AdminMember', file: 'components/AdminMember.js', line: 22, guards: [{ guard: 'checkLab()', kinds: ['setting'], settingsReason: 'call' }, { guard: 'canSee(x)', kinds: ['role'], roles: null }], fromKinds: ['role'] },
      ],
      settings: [
        { from: 'route', needs: [ON(['LAB'])], unreadable: [] },
        { from: '/home#Home', file: 'components/Home.js', line: 19, needs: [ON(['LAB']), REPORT_LIST], unreadable: [] },
      ],
    },
  },
  {
    id: '/lab/result#LabResult', routeFile: 'Routes.js', line: 18,
    access: {
      restricted: true, kinds: ['setting'], route: [],
      links: [{ from: '/lab#Lab', file: 'components/Lab.js', line: 14, guards: [], fromKinds: ['setting'] }],
      settings: [{ from: '/lab#Lab', file: 'components/Lab.js', line: 14, inherited: true, needs: [ON(['LAB'])], unreadable: [] }],
    },
  },
];

const slot = (node: string, kind: string, key: unknown, roleGuards: Record<string, string[]> = {}) => locatePart({ node, part: { kind, key } as never }, { tests: {}, screens: SCREENS, roleGuards }) as { places: { line: number }[] } | null;

test('a role condition is found at the route line of the screen and at each link that asks it, with the function a guard sits in and the roleGuards key that gave its roles', () => {
  assert.deepEqual(slot('/admin/member#AdminMember', 'condition', 'role:ADMIN', { 'isAdminRole(memberRole)': ['ADMIN'] }), {
    places: [
      { from: 'route', file: 'Routes.js', line: 12, guard: 'isAdminRole(memberRole)', roleGuardsKey: 'isAdminRole(memberRole)' },
      { from: '/home#Home', file: 'components/Home.js', line: 17, guard: "memberRole === 'ADMIN'" },
    ],
  });
  assert.deepEqual(slot('/admin/audit#AdminAudit', 'condition', 'role:AUDITOR'), {
    places: [{ from: '/home#Home', file: 'components/Home.js', line: 20, guard: 'canAudit', via: 'openAudit' }],
  });
});

test('a role a screen gets from the screen its link starts on is found at that link, marked as inherited', () => {
  assert.deepEqual(slot('/admin/audit#AdminAudit', 'condition', 'role:ADMIN'), {
    places: [{ from: '/admin/member#AdminMember', file: 'components/AdminMember.js', line: 14, inherited: true }],
  });
});

test('a setting condition is named by its path with the state it asks, or with the value for a list or an equality, and is found at the route and at each link that asks it', () => {
  assert.deepEqual(slot('/lab#Lab', 'condition', 'setting:LAB=on'), {
    places: [
      { from: 'route', file: 'Routes.js', line: 16, guard: 'globalSettings.LAB' },
      { from: '/home#Home', file: 'components/Home.js', line: 19, guard: 'globalSettings.LAB' },
      { from: '/home#Home', file: 'components/Home.js', line: 30, guard: 'labOn' },
    ],
  });
  assert.deepEqual(slot('/lab#Lab', 'condition', 'setting:MENU.LIST:REPORT')!.places.map((p) => p.line), [19, 30]);
  assert.deepEqual(slot('/lab/result#LabResult', 'condition', 'setting:LAB=on'), {
    places: [{ from: '/lab#Lab', file: 'components/Lab.js', line: 14, inherited: true }],
  });
});

test('a condition is not found once the screen no longer asks it, asks the opposite state, or is gone', () => {
  assert.equal(slot('/lab#Lab', 'condition', 'setting:LAB=off'), null);
  assert.equal(slot('/lab#Lab', 'condition', 'role:ADMIN'), null);
  assert.equal(slot('/home#Home', 'condition', 'role:ADMIN'), null);
  assert.equal(slot('/admin/member#AdminMember', 'condition', 'role:OWNER'), null);
  assert.equal(slot('/gone#Gone', 'condition', 'role:ADMIN'), null);
});

test('an incoming link is named by its start screen and the roles and settings read from it, so links that read the same share one slot, and by its guard text when none was read', () => {
  assert.deepEqual(linkKey(SCREENS[3].access.links[0]), { from: '/home#Home', conditions: ['setting:LAB=on', 'setting:MENU.LIST:REPORT'] });
  assert.deepEqual(slot('/lab#Lab', 'link', { from: '/home#Home', conditions: ['setting:LAB=on', 'setting:MENU.LIST:REPORT'] }), {
    places: [{ from: '/home#Home', file: 'components/Home.js', line: 19 }, { from: '/home#Home', file: 'components/Home.js', line: 30 }],
  });
  assert.deepEqual(linkKey(SCREENS[3].access.links[2]), { from: '/admin/member#AdminMember', guards: ['canSee(x)', 'checkLab()'] });
  assert.deepEqual(slot('/lab#Lab', 'link', { from: '/admin/member#AdminMember', guards: ['canSee(x)', 'checkLab()'] }), {
    places: [{ from: '/admin/member#AdminMember', file: 'components/AdminMember.js', line: 22 }],
  });
  assert.deepEqual(linkKey(SCREENS[4].access.links[0]), { from: '/lab#Lab', guards: [] });
  assert.equal(slot('/lab#Lab', 'link', { from: '/home#Home', conditions: ['setting:LAB=on'] }), null);
  assert.equal(slot('/lab#Lab', 'link', { from: '/signin#SignIn', guards: [] }), null);
});

test('a screen order is located with the files of each screen and the verdict between each two neighbours, and not at all on a map whose links carry no conditions', () => {
  const screen = (id: string, links: object[]) => ({ id, path: id, routeFile: 'Routes.js', line: 3, componentFile: `components${id}.js`, access: { route: [] }, links });
  const map = { screens: [screen('/a', [{ to: '/b', file: 'components/a.js', line: 7, conditions: [] }]), screen('/b', []), screen('/c', [])] };
  assert.deepEqual(locateOrder(['/a', '/b', '/c'], map), {
    screens: [
      { id: '/a', componentFile: 'components/a.js', routeFile: 'Routes.js', line: 3 },
      { id: '/b', componentFile: 'components/b.js', routeFile: 'Routes.js', line: 3 },
      { id: '/c', componentFile: 'components/c.js', routeFile: 'Routes.js', line: 3 },
    ],
    links: [
      { from: '/a', to: '/b', verdict: 'open', ways: [{ file: 'components/a.js', line: 7, conditions: [] }] },
      { from: '/b', to: '/c', verdict: 'broken', ways: [] },
    ],
  });
  const old = { screens: [screen('/a', [{ to: '/b', file: 'components/a.js', line: 7 }]), screen('/b', [])] };
  assert.equal(locateOrder(['/b', '/a'], old), null);
});
