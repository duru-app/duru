import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { buildMap } from '../src/map.mjs';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const buildFixture = (dir = FIXTURE) => buildMap(loadConfig(path.join(dir, 'config.json')));
const screen = (map, id) => map.screens.find((s) => s.id === id);

test('every route of the fake client becomes a screen, with the guard on its route', async () => {
  const map = await buildFixture();
  assert.deepEqual(
    map.screens.map((s) => s.id),
    ['/signin#SignIn', '/home#Home', '/document/:tab_draft_done_#DocumentList', '/document/:id#DocumentDetail', '/help#Help', '/admin/member#AdminMember', '/admin/group#AdminGroup', '/lab#Lab', '/lab/result#LabResult', '/admin/audit#AdminAudit', '/admin/report#AdminReport'],
  );
  assert.deepEqual(screen(map, '/admin/member#AdminMember').routeGuards, ['isAdminRole(memberRole)']);
  assert.deepEqual(screen(map, '/lab#Lab').routeGuards, ['globalSettings.SYSTEM.LAB_ENABLED']);
  assert.deepEqual(screen(map, '/home#Home').routeGuards, []);
});

test('links carry their own guard, and a handler used under a guard passes it to the link inside it', async () => {
  const map = await buildFixture();
  const homeLinks = screen(map, '/home#Home').links.map((l) => ({ to: l.to, guards: l.guards }));
  assert.deepEqual(homeLinks, [
    { to: '/admin/member', guards: ["memberRole === 'ADMIN'"] },
    { to: '/admin/group', guards: ['isAdmin'] },
    { to: '/lab', guards: ['globalSettings.SYSTEM.LAB_ENABLED'] },
    { to: '/admin/audit', guards: ["session['member.role'] === 'AUDITOR'"] },
    { to: '/document', guards: [] },
    {
      to: '/admin/report',
      guards: ["globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST includes 'ADMIN_REPORT'", "['ADMIN', 'OWNER'].indexOf(session['member.role']) > -1", 'MENUS.ADMIN'],
    },
  ]);

  const help = screen(map, '/signin#SignIn').links.find((l) => l.to === '/help');
  assert.deepEqual(help.guards, []);
  assert.deepEqual(
    help.inheritedGuards.map((g) => ({ via: g.via, guards: g.guards })),
    [{ via: 'openHelp', guards: ['globalSettings.SYSTEM.HELP_LINK_ENABLED'] }],
  );

  const rename = screen(map, '/document/:id#DocumentDetail').apiCalls.find((c) => c.fn === 'ajaxDocumentRename');
  assert.deepEqual(rename.inheritedGuards.map((g) => g.guards), [['canEdit']]);
});

test('each screen lists the settings read by the files it reaches', async () => {
  const map = await buildFixture();
  const keys = (id) => screen(map, id).settingReads.map((r) => `${r.file} ${r.key}`);
  assert.deepEqual(keys('/home#Home'), [
    'components/Home.js SYSTEM.LAB_ENABLED',
    'components/DocumentTable.js DISPLAY.PAGE_SIZE',
    'components/SideMenu.js SYSTEM.MAIN_MENU',
  ]);
  assert.deepEqual(keys('/signin#SignIn'), ['components/SignIn.js SYSTEM.HELP_LINK_ENABLED']);
  assert.deepEqual(keys('/help#Help'), []);
});

async function buildCopy(edit) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true });
    const rewrite = (rel, fn) => fs.writeFileSync(path.join(copy, rel), fn(fs.readFileSync(path.join(copy, rel), 'utf8')));
    edit(rewrite);
    return await buildFixture(copy);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

test('each API call becomes a node named by its method and the server path, or the client URL when the server lacks it', async () => {
  const map = await buildFixture();
  assert.deepEqual(
    map.calls.map((c) => [c.id, c.server.status, (c.server.labels ?? []).join(','), c.apiFunctions.join(','), c.screens.join(',')]),
    [
      ['GET:/api/v1/document/list', 'match', 'core', 'ajaxDocumentList', '/home#Home'],
      ['GET:/api/v1/document/{documentId}', 'match', 'core', 'ajaxDocumentDetail', '/document/:id#DocumentDetail'],
      ['GET:/api/v1/lab/experiment', 'match', 'profile-lab', 'ajaxLabExperiment', '/lab#Lab'],
      ['GET:/api/v1/member/list', 'match', 'core', 'ajaxMemberList', '/admin/member#AdminMember'],
      ['POST:/api/v1/archive/document', 'none', '', 'ajaxDocumentArchive', '/document/:tab_draft_done_#DocumentList,/home#Home'],
      ['POST:/api/v1/auth/sign-in', 'match', 'core', 'ajaxSignIn', '/signin#SignIn'],
      ['POST:/api/v1/report/archive', 'match', 'core', 'ajaxReportArchive', '/admin/audit#AdminAudit,/admin/report#AdminReport'],
      ['POST:/api/v1/report/export', 'match', 'core', 'ajaxReportExport', '/admin/audit#AdminAudit,/admin/report#AdminReport'],
      ['POST:/api/v1/report/schedule', 'match', 'core', 'ajaxReportSchedule', '/admin/audit#AdminAudit,/admin/report#AdminReport'],
      ['PUT:/api/v1/document/{documentId}/name', 'method-mismatch', '', 'ajaxDocumentRename', '/document/:id#DocumentDetail'],
    ],
  );
  const rename = map.calls.find((c) => c.id === 'PUT:/api/v1/document/{documentId}/name');
  assert.deepEqual(rename.server.candidates, ['core POST /api/v1/document/{documentId}/name']);
  assert.equal(rename.method, 'PUT');
  assert.equal(rename.path, '/api/v1/document/{documentId}/name');
});

test('a call is listed once per API function, and each endpoint on a screen points at its call node', async () => {
  const map = await buildFixture();
  assert.deepEqual(
    Object.entries(map.apiFunctions).map(([name, fn]) => `${name} ${fn.endpoints.map((e) => e.callId).join(' ')}`),
    [
      'ajaxSignIn POST:/api/v1/auth/sign-in',
      'ajaxDocumentList GET:/api/v1/document/list',
      'ajaxDocumentDetail GET:/api/v1/document/{documentId}',
      'ajaxDocumentRename PUT:/api/v1/document/{documentId}/name',
      'ajaxDocumentArchive POST:/api/v1/archive/document',
      'ajaxDownload ',
      'ajaxMemberList GET:/api/v1/member/list',
      'ajaxLabExperiment GET:/api/v1/lab/experiment',
      'ajaxReportExport POST:/api/v1/report/export',
      'ajaxReportArchive POST:/api/v1/report/archive',
      'ajaxReportSchedule POST:/api/v1/report/schedule',
    ],
  );
  const detail = screen(map, '/document/:id#DocumentDetail').apiCalls.flatMap((c) => c.endpoints.map((e) => e.callId));
  assert.deepEqual(detail, ['GET:/api/v1/document/{documentId}', 'PUT:/api/v1/document/{documentId}/name']);
});

test('a screen that reaches a call missing on the server is dead; a call whose URL cannot be computed makes no node and no dead screen', async () => {
  const map = await buildFixture();
  assert.deepEqual(map.screens.filter((s) => s.dead).map((s) => s.id), ['/home#Home', '/document/:tab_draft_done_#DocumentList']);

  const download = map.apiFunctions.ajaxDownload.endpoints;
  assert.deepEqual(download.map((e) => [e.server.status, e.callId]), [['unresolved', null]]);
  assert.equal(map.calls.some((c) => c.apiFunctions.includes('ajaxDownload')), false);

  const withoutTable = await buildCopy((rewrite) =>
    rewrite('client/src/components/DocumentList.js', (src) => src.replace("import DocumentTable from './DocumentTable';\n", '').replace('      <DocumentTable />\n', '')),
  );
  const list = screen(withoutTable, '/document/:tab_draft_done_#DocumentList');
  assert.deepEqual(list.apiCalls.map((c) => c.fn), ['ajaxDownload']);
  assert.equal(list.dead, false);
});

test('when several server paths fit a call, the ID takes the closest one, then the first in sorted order', async () => {
  const map = await buildCopy((rewrite) => rewrite('server-endpoints-lab.txt', (src) => `${src}profile-lab\tGET\t/api/v1/document/{docId}\n`));
  const detail = map.calls.find((c) => c.apiFunctions.includes('ajaxDocumentDetail'));
  assert.equal(detail.id, 'GET:/api/v1/document/{docId}');
  assert.deepEqual(detail.server.labels, ['core', 'profile-lab']);
  assert.equal(map.calls.find((c) => c.apiFunctions.includes('ajaxDocumentList')).id, 'GET:/api/v1/document/list');
});

test('a call node carries only the labels that serve its own path, whatever order the API functions come in', async () => {
  const moveListToLab = (rewrite) => {
    rewrite('server-endpoints.txt', (src) => src.replace('core\tGET\t/api/v1/document/list\n', ''));
    rewrite('server-endpoints-lab.txt', (src) => `${src}profile-lab\tGET\t/api/v1/document/list\n`);
  };
  const recent = "export const ajaxDocumentRecent = async () => Ajax.request({ info: { METHOD: 'GET', URL: '/api/v1/document/recent' } });\n";
  const labelsById = (map) => Object.fromEntries(map.calls.map((c) => [c.id, c.server.labels ?? c.server.candidates ?? []]));
  const after = await buildCopy((rewrite) => {
    moveListToLab(rewrite);
    rewrite('client/src/_ajax/AjaxFunc.js', (src) => src + recent);
  });
  const before = await buildCopy((rewrite) => {
    moveListToLab(rewrite);
    rewrite('client/src/_ajax/AjaxFunc.js', (src) => src.replace('export const ajaxSignIn', `${recent}export const ajaxSignIn`));
  });
  assert.deepEqual(labelsById(after)['GET:/api/v1/document/list'], ['profile-lab']);
  assert.deepEqual(labelsById(after)['GET:/api/v1/document/{documentId}'], ['core']);
  assert.deepEqual(labelsById(before), labelsById(after));
});

test('screen and call IDs contain no character a JUnit tag rejects', async () => {
  const map = await buildFixture();
  for (const s of map.screens) assert.doesNotMatch(s.id, /[\s,()&|!]/, s.id);
  for (const c of map.calls) assert.doesNotMatch(c.id, /[\s,()&|!]/, c.id);
  assert.deepEqual(map.duplicateIds, []);

  const odd = await buildCopy((rewrite) => rewrite('client/src/_define/Option.js', (src) => src.replace("'archive/document'", "'archive/document (all)'")));
  const archive = odd.calls.find((c) => c.apiFunctions.includes('ajaxDocumentArchive'));
  assert.equal(archive.id, 'POST:/api/v1/archive/document_all_');
  assert.equal(archive.path, '/api/v1/archive/document (all)');
});

test('two builds from the same input differ only in the generation time', async () => {
  const strip = (map) => ({ ...map, meta: { ...map.meta, generatedAt: null } });
  assert.deepEqual(strip(await buildFixture()), strip(await buildFixture()));
});

test('screen and call IDs stay the same after unrelated files change', async () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true });
    const src = path.join(copy, 'client/src');
    const prepend = (rel, text) => fs.writeFileSync(path.join(src, rel), text + fs.readFileSync(path.join(src, rel), 'utf8'));
    prepend('Routes.js', '// moved\n\n\n');
    prepend('components/Help.js', "import { useState } from 'react';\n\n");
    prepend('_ajax/AjaxFunc.js', '// moved\n');
    fs.writeFileSync(path.join(src, 'components/Unused.js'), 'export default function Unused() { return null; }\n');
    const endpoints = path.join(copy, 'server-endpoints.txt');
    fs.writeFileSync(endpoints, fs.readFileSync(endpoints, 'utf8').trim().split('\n').reverse().join('\n') + '\n');

    const original = await buildFixture();
    const after = await buildFixture(copy);
    assert.deepEqual(after.screens.map((s) => s.id), original.screens.map((s) => s.id));
    assert.notEqual(after.screens[0].line, original.screens[0].line);
    assert.deepEqual(after.calls.map((c) => c.id), original.calls.map((c) => c.id));
    assert.notEqual(after.apiFunctions.ajaxSignIn.endpoints[0].line, original.apiFunctions.ajaxSignIn.endpoints[0].line);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('two routes that end up with the same screen ID are reported', async () => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true });
    const routes = path.join(copy, 'client/src/Routes.js');
    const src = fs.readFileSync(routes, 'utf8');
    fs.writeFileSync(routes, src.replace('    </Switch>\n  );', '      {memberRole && <Route path={Option.ROUTE_PATH.HELP} component={Help} />}\n    </Switch>\n  );'));
    const map = await buildFixture(copy);
    assert.deepEqual(map.duplicateIds, [{ id: '/help#Help', lines: [41, 49] }]);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

async function buildEditedCopy(edits) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true });
    for (const [rel, from, to] of edits) {
      const file = path.join(copy, rel);
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(src.includes(from), `${rel} has no ${from}`);
      fs.writeFileSync(file, src.replace(from, to));
    }
    return await buildFixture(copy);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const setting = (path, need, extra = {}) => ({ root: 'globalSettings', path: path.split('.'), need, ...extra });
const HELP_ON = setting('SYSTEM.HELP_LINK_ENABLED', 'on');
const helpGuard = { guard: 'helpEnabled', kinds: ['setting'], settings: [HELP_ON] };
const MENU_LIST = ['ADMIN_REPORT', 'ADMIN_ARCHIVE'];
const restrictedKinds = (map) => Object.fromEntries(map.screens.filter((s) => s.access.restricted).map((s) => [s.id, s.access.kinds]));

test('a screen opens only under a setting or a role when its route is guarded or every link into it is', async () => {
  const map = await buildFixture();
  assert.deepEqual(restrictedKinds(map), {
    '/help#Help': ['setting'],
    '/admin/member#AdminMember': ['role'],
    '/admin/group#AdminGroup': ['role'],
    '/lab#Lab': ['setting'],
    '/lab/result#LabResult': ['setting'],
    '/admin/audit#AdminAudit': ['role'],
    '/admin/report#AdminReport': ['role', 'setting'],
  });
  const open = map.screens.filter((s) => !s.access.restricted);
  assert.deepEqual(open.map((s) => s.id), ['/signin#SignIn', '/home#Home', '/document/:tab_draft_done_#DocumentList', '/document/:id#DocumentDetail']);
  for (const s of open) assert.deepEqual([s.access.kinds, s.access.route], [[], []], s.id);
});

test('each restricted screen keeps the route guard and the links that decided it', async () => {
  const map = await buildFixture();
  assert.deepEqual(screen(map, '/admin/member#AdminMember').access, {
    restricted: true,
    kinds: ['role'],
    route: [{ guard: 'isAdminRole(memberRole)', kinds: ['role'], roles: null }],
    links: [{ from: '/home#Home', file: 'components/Home.js', line: 17, guards: [{ guard: "memberRole === 'ADMIN'", kinds: ['role'], roles: ['ADMIN'] }], fromKinds: [] }],
    roleValues: ['ADMIN'],
    unreadableRoleGuards: ['isAdminRole(memberRole)'],
  });
  assert.deepEqual(screen(map, '/help#Help').access.links, [
    {
      from: '/document/:id#DocumentDetail',
      file: 'components/DocumentDetail.js',
      line: 20,
      guards: [helpGuard],
      fromKinds: [],
    },
    {
      from: '/signin#SignIn',
      file: 'components/SignIn.js',
      line: 8,
      guards: [{ guard: 'globalSettings.SYSTEM.HELP_LINK_ENABLED', kinds: ['setting'], via: 'openHelp', settings: [HELP_ON] }],
      fromKinds: [],
    },
  ]);
  assert.deepEqual(screen(map, '/lab/result#LabResult').access, {
    restricted: true,
    kinds: ['setting'],
    route: [],
    links: [{ from: '/lab#Lab', file: 'components/Lab.js', line: 14, guards: [], fromKinds: ['setting'] }],
    settings: [],
  });
});

test('a role check held in a local const hides the route and the link, and the screen opens only under a role', async () => {
  const map = await buildFixture();
  assert.deepEqual(screen(map, '/admin/group#AdminGroup').routeGuards, ['isAdmin']);
  assert.deepEqual(screen(map, '/admin/group#AdminGroup').access, {
    restricted: true,
    kinds: ['role'],
    route: [{ guard: 'isAdmin', kinds: ['role'], roles: null }],
    links: [{ from: '/home#Home', file: 'components/Home.js', line: 18, guards: [{ guard: 'isAdmin', kinds: ['role'], roles: ['ADMIN'] }], fromKinds: [] }],
    roleValues: ['ADMIN'],
    unreadableRoleGuards: ['isAdmin'],
  });
});

const roleValues = (map) => Object.fromEntries(map.screens.filter((s) => 'roleValues' in s.access).map((s) => [s.id, s.access.roleValues]));
const roleGuards = (access) => [...access.route, ...access.links.flatMap((l) => l.guards)].filter((g) => g.kinds.includes('role')).map((g) => [g.guard, g.roles]);

test('the role values a role guard compares with are read, and a screen keeps the values every way into it allows', async () => {
  const map = await buildFixture();
  assert.deepEqual(roleValues(map), {
    '/admin/member#AdminMember': ['ADMIN'],
    '/admin/group#AdminGroup': ['ADMIN'],
    '/admin/audit#AdminAudit': ['ADMIN', 'AUDITOR'],
    '/admin/report#AdminReport': ['ADMIN', 'OWNER'],
  });
  const audit = screen(map, '/admin/audit#AdminAudit').access;
  assert.deepEqual(roleGuards(audit), [["session['member.role'] === 'AUDITOR'", ['AUDITOR']]]);
  assert.deepEqual(audit.unreadableRoleGuards, []);
  const report = screen(map, '/admin/report#AdminReport').access;
  assert.deepEqual([...new Set(roleGuards(report).map((g) => JSON.stringify(g)))].map((g) => JSON.parse(g)), [["['ADMIN', 'OWNER'].indexOf(session['member.role']) > -1", ['ADMIN', 'OWNER']]]);
  assert.ok(report.links.flatMap((l) => l.guards).filter((g) => !g.kinds.includes('role')).every((g) => !('roles' in g)));
  assert.ok(!('roleValues' in screen(map, '/lab#Lab').access));
  assert.ok(!('unreadableRoleGuards' in screen(map, '/lab#Lab').access));
});

test('a screen whose role guards are all unreadable has no role values and lists the guards', async () => {
  const map = await buildEditedCopy([['client/src/components/Home.js', "const isAdmin = memberRole === 'ADMIN';", "const isAdmin = memberRole !== 'MEMBER';"]]);
  const group = screen(map, '/admin/group#AdminGroup').access;
  assert.equal(group.roleValues, null);
  assert.deepEqual(group.unreadableRoleGuards, ['isAdmin']);
});

test('a role identifier read as a member of another object, such as props.memberRole, is still read for its value', async () => {
  const map = await buildEditedCopy([
    ['client/src/components/Home.js', 'export default function Home({ memberRole, globalSettings, session }) {', 'export default function Home(props) {\n  const { globalSettings, session } = props;'],
    ['client/src/components/Home.js', "const isAdmin = memberRole === 'ADMIN';", "const isAdmin = props.memberRole === 'ADMIN';"],
    ['client/src/components/Home.js', "{memberRole === 'ADMIN' && <Link", "{props.memberRole === 'ADMIN' && <Link"],
  ]);
  const group = screen(map, '/admin/group#AdminGroup').access;
  assert.deepEqual(group.roleValues, ['ADMIN']);
  const fromHome = group.links.find((l) => l.from === '/home#Home');
  assert.deepEqual(fromHome.guards.map((g) => [g.guard, g.roles]), [['isAdmin', ['ADMIN']]]);
});

test('a guard keeps its own const declarations when another component in the file uses the same guard text', async () => {
  const map = await buildEditedCopy([
    ['client/src/components/Home.js', 'export default function Home(', 'function Banner({ isAdmin }) {\n  return isAdmin ? <Link to={Option.ROUTE_PATH.LAB}>Lab</Link> : <Link to={Option.ROUTE_PATH.HELP}>Help</Link>;\n}\n\nexport default function Home('],
  ]);
  const help = screen(map, '/help#Help').access;
  const fromBanner = help.links.filter((l) => l.from === '/home#Home' && l.file.endsWith('Home.js'));
  assert.ok(fromBanner.length > 0);
  assert.deepEqual(fromBanner.flatMap((l) => l.guards), []);
});

test('a screen whose route and links allow no role in common has no role values', async () => {
  const map = await buildEditedCopy([['client/src/Routes.js', '{isAdminRole(memberRole) && <Route path={Option.ROUTE_PATH.ADMIN_MEMBER}', "{memberRole === 'OWNER' && <Route path={Option.ROUTE_PATH.ADMIN_MEMBER}"]]);
  const member = screen(map, '/admin/member#AdminMember').access;
  assert.equal(member.roleValues, null);
  assert.deepEqual(member.unreadableRoleGuards, []);
});

const SIDE_MENU_ROLE ="['ADMIN', 'OWNER'].indexOf(session['member.role']) > -1";
for (const [guard, roles] of [
  ["['ADMIN', 'OWNER'].includes(session['member.role'])", ['ADMIN', 'OWNER']],
  ["['OWNER', 'ADMIN'].indexOf(session['member.role']) !== -1", ['ADMIN', 'OWNER']],
  ["['ADMIN', 'OWNER'].indexOf(session['member.role']) >= 0", ['ADMIN', 'OWNER']],
  ["'OWNER' == session['member.role'] || session['member.role'] === 'ADMIN'", ['ADMIN', 'OWNER']],
  ["session['member.role'] === 'OWNER' && MENUS.ADMIN", ['OWNER']],
  ["session['member.role'] !== 'MEMBER'", null],
  ["!(session['member.role'] === 'MEMBER')", null],
  ["['ADMIN', 'OWNER'].indexOf(session['member.role']) > 0", null],
  ["session['member.role'] === MENUS.ROLE", null],
  ["session['member.role'] === 'OWNER' || MENUS.OPEN", null],
  ["(MENUS.OPEN || session['member.role'] === 'OWNER') && session['member.role'] === 'ADMIN'", ['ADMIN']],
  ["session['member.role'] === 'OWNER' && session['member.role'] === 'ADMIN'", null],
  ["this.props.memberRole === 'OWNER'", ['OWNER']],
  ["props.memberRole === 'OWNER'", ['OWNER']],
  ["row.memberRole === 'OWNER'", null],
]) {
  test(`the role guard ${guard} allows ${JSON.stringify(roles)}`, async () => {
    const map = await buildEditedCopy([['client/src/components/SideMenu.js', SIDE_MENU_ROLE, guard]]);
    const report = screen(map, '/admin/report#AdminReport').access;
    assert.deepEqual(report.links[0].guards.find((g) => g.kinds.includes('role')).roles, roles);
    assert.deepEqual(report.roleValues, roles);
    assert.deepEqual(report.unreadableRoleGuards, roles ? [] : [guard]);
  });
}

test('a role guard longer than its shown text is read in full', async () => {
  const roles = Array.from({ length: 12 }, (_, i) => `ROLE_NUMBER_${i}`);
  const guard = `[${roles.map((r) => `'${r}'`).join(', ')}].indexOf(session['member.role']) > -1`;
  const map = await buildEditedCopy([['client/src/components/SideMenu.js', SIDE_MENU_ROLE, guard]]);
  const report = screen(map, '/admin/report#AdminReport').access;
  assert.match(report.links[0].guards.find((g) => g.kinds.includes('role')).guard, /…$/);
  assert.deepEqual(report.roleValues, roles.sort());
});

test('a list of constants that are not strings gives no role values', async () => {
  const map = await buildEditedCopy([
    ['client/src/_define/Enum.js', "ROLE: { ADMIN: 'ADMIN', MEMBER: 'MEMBER' },", "ROLE: { ADMIN: 'ADMIN', MEMBER: 'MEMBER' },\n  ADMIN_ROLES: [1, 2],"],
    ['client/src/components/SideMenu.js', "import Option from '_define/Option';\n", "import Option from '_define/Option';\nimport Enum from '_define/Enum';\n"],
    ['client/src/components/SideMenu.js', SIDE_MENU_ROLE, "Enum.ADMIN_ROLES.indexOf(session['member.role']) > -1"],
  ]);
  assert.equal(screen(map, '/admin/report#AdminReport').access.roleValues, null);
});

test('a screen reached through a link whose role guard cannot be read has no role values', async () => {
  const map = await buildEditedCopy([['client/src/components/Home.js', "session['member.role'] === 'AUDITOR'", "session['member.role'] !== 'MEMBER'"]]);
  const audit = screen(map, '/admin/audit#AdminAudit').access;
  assert.equal(audit.roleValues, null);
  assert.deepEqual(audit.unreadableRoleGuards, ["session['member.role'] !== 'MEMBER'"]);
});

test('a role compared with a constant from the constants modules is read as its value', async () => {
  const map = await buildEditedCopy([
    ['client/src/components/Home.js', "import Option from '_define/Option';\n", "import Option from '_define/Option';\nimport Enum from '_define/Enum';\n"],
    ['client/src/components/Home.js', "{memberRole === 'ADMIN' &&", '{memberRole === Enum.ROLE.ADMIN &&'],
  ]);
  assert.deepEqual(roleGuards(screen(map, '/admin/member#AdminMember').access).at(-1), ['memberRole === Enum.ROLE.ADMIN', ['ADMIN']]);
});

test('a setting held in a local const, even through another const, hides a link as a setting condition', async () => {
  const map = await buildFixture();
  const link = screen(map, '/help#Help').access.links.find((l) => l.from === '/document/:id#DocumentDetail');
  assert.deepEqual(link.guards, [helpGuard]);
});

test('a let is not followed, and a const that refers back to itself is followed once', async () => {
  const fromDetail = (map) => screen(map, '/help#Help').access.links.find((l) => l.from === '/document/:id#DocumentDetail');
  const withLet = await buildEditedCopy([['client/src/components/DocumentDetail.js', 'const helpEnabled =', 'let helpEnabled =']]);
  assert.deepEqual(fromDetail(withLet).guards, []);

  const looping = await buildEditedCopy([
    ['client/src/components/DocumentDetail.js', 'const helpEnabled = system.HELP_LINK_ENABLED;', 'const helpEnabled = () => system.HELP_LINK_ENABLED || helpEnabled();'],
    ['client/src/components/DocumentDetail.js', '{helpEnabled && <Link', '{helpEnabled() && <Link'],
  ]);
  assert.deepEqual(fromDetail(looping).guards, [
    { guard: 'helpEnabled()', kinds: ['setting'], settings: null, settingsReason: '함수를 불러 정하는 조건이라 켤 값을 정할 수 없습니다' },
  ]);
});

test('a role read from one member of a store object hides a link as a role condition', async () => {
  const map = await buildFixture();
  assert.deepEqual(screen(map, '/admin/audit#AdminAudit').access, {
    restricted: true,
    kinds: ['role'],
    route: [],
    links: [
      { from: '/admin/member#AdminMember', file: 'components/AdminMember.js', line: 14, guards: [], fromKinds: ['role'] },
      {
        from: '/home#Home',
        file: 'components/Home.js',
        line: 20,
        guards: [{ guard: "session['member.role'] === 'AUDITOR'", kinds: ['role'], roles: ['AUDITOR'] }],
        fromKinds: [],
      },
    ],
    roleValues: ['ADMIN', 'AUDITOR'],
    unreadableRoleGuards: [],
  });
});

test('a guard on another member of the same store object does not block', async () => {
  const map = await buildEditedCopy([['client/src/components/Home.js', "session['member.role'] === 'AUDITOR'", "session['member.id'] === 'AUDITOR'"]]);
  assert.equal(screen(map, '/admin/audit#AdminAudit').access.restricted, false);
  assert.deepEqual(screen(map, '/admin/audit#AdminAudit').access.links.map((l) => l.guards), [[], []]);
});

for (const [name, edits] of [
  ['with optional chaining', [['client/src/components/Home.js', "session['member.role']", "session?.['member.role']"]]],
  ['in double quotes', [['client/src/components/Home.js', "session['member.role']", 'session["member.role"]']]],
  [
    'through a local const',
    [
      ['client/src/components/Home.js', "  const isAdmin = memberRole === 'ADMIN';\n", "  const isAdmin = memberRole === 'ADMIN';\n  const role = session['member.role'];\n"],
      ['client/src/components/Home.js', "{session['member.role'] === 'AUDITOR'", "{role === 'AUDITOR'"],
    ],
  ],
  [
    'as a dot access when the key is a plain name',
    [
      ['config.json', `"session['member.role']"`, `"session['role']"`],
      ['client/src/components/Home.js', "session['member.role']", 'session?.role'],
    ],
  ],
  [
    'as a bracket access when the entry is written with a dot',
    [
      ['config.json', `"session['member.role']"`, '"session.role"'],
      ['client/src/components/Home.js', "session['member.role']", "session['role']"],
    ],
  ],
]) {
  test(`a member role read ${name} is a role condition`, async () => {
    const map = await buildEditedCopy(edits);
    assert.deepEqual(screen(map, '/admin/audit#AdminAudit').access.links.map((l) => l.guards.map((g) => g.kinds)), [[], [['role']]]);
    assert.deepEqual(screen(map, '/admin/audit#AdminAudit').access.kinds, ['role']);
    assert.deepEqual(screen(map, '/admin/audit#AdminAudit').access.roleValues, ['ADMIN', 'AUDITOR']);
  });
}

test('a roleIdentifiers entry that is neither an identifier nor one member of an object is rejected', async () => {
  for (const entry of ["session['member.role'].name", 'session[role]', 'role()', 'session.member.role']) {
    await assert.rejects(buildEditedCopy([['config.json', '"memberRole"', JSON.stringify(entry)]]), (err) => err.message.includes(`roleIdentifiers entry ${JSON.stringify(entry)}`));
  }
});

test('a menu built from a settings list links to each listed screen, under the list and the guards around it', async () => {
  const map = await buildFixture();
  const menuIncludes = setting('SYSTEM.MAIN_MENU.ADMIN.LIST', 'includes', { value: 'ADMIN_REPORT', default: MENU_LIST });
  const adminMenu = setting('SYSTEM.MAIN_MENU.ADMIN', 'present', { default: { LIST: MENU_LIST } });
  assert.deepEqual(screen(map, '/admin/report#AdminReport').access, {
    restricted: true,
    kinds: ['role', 'setting'],
    route: [],
    links: ['/document/:id#DocumentDetail', '/document/:tab_draft_done_#DocumentList', '/home#Home'].map((from) => ({
      from,
      file: 'components/SideMenu.js',
      line: 11,
      guards: [
        { guard: "globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST includes 'ADMIN_REPORT'", kinds: ['setting'], settings: [menuIncludes] },
        { guard: "['ADMIN', 'OWNER'].indexOf(session['member.role']) > -1", kinds: ['role'], roles: ['ADMIN', 'OWNER'] },
        { guard: 'MENUS.ADMIN', kinds: ['setting'], settings: [adminMenu] },
      ],
      fromKinds: [],
    })),
    roleValues: ['ADMIN', 'OWNER'],
    unreadableRoleGuards: [],
    settings: ['/document/:id#DocumentDetail', '/document/:tab_draft_done_#DocumentList', '/home#Home'].map((from) => ({
      from,
      file: 'components/SideMenu.js',
      line: 11,
      needs: [menuIncludes, adminMenu],
      unreadable: [],
    })),
  });
  assert.deepEqual(screen(map, '/home#Home').links.filter((l) => l.file === 'components/SideMenu.js').map((l) => l.to), ['/admin/report']);
});

test('a setting-guarded screen lists the setting values its route and each guarded link into it need, with the defaults', async () => {
  const map = await buildFixture();
  const labOn = setting('SYSTEM.LAB_ENABLED', 'on', { default: false });
  assert.deepEqual(screen(map, '/lab#Lab').access.settings, [
    { from: 'route', needs: [labOn], unreadable: [] },
    { from: '/home#Home', file: 'components/Home.js', line: 19, needs: [labOn], unreadable: [] },
  ]);
  assert.deepEqual(screen(map, '/help#Help').access.settings, [
    { from: '/document/:id#DocumentDetail', file: 'components/DocumentDetail.js', line: 20, needs: [HELP_ON], unreadable: [] },
    { from: '/signin#SignIn', file: 'components/SignIn.js', line: 8, needs: [HELP_ON], unreadable: [] },
  ]);
  assert.equal(screen(map, '/admin/member#AdminMember').access.settings, undefined);
  assert.equal(screen(map, '/home#Home').access.settings, undefined);
  assert.deepEqual(map.settingsDefaults, { globalSettings: { SYSTEM: { LAB_ENABLED: false, MAIN_MENU: { ADMIN: { LIST: MENU_LIST } } } } });
  assert.deepEqual(map.settingsDefaultsIncomplete, { globalSettings: [] });
});

test('defaults that the source does not show in full are listed by section and key, or by section when its keys are unknown', async () => {
  const map = await buildEditedCopy([
    [
      'client/src/store/settings.js',
      "    LAB_ENABLED: false,\n",
      "    LAB_ENABLED: false,\n    FIELDS: window.INTO_SETTINGS?.SYSTEM?.FIELDS || ['NAME'],\n    THEME: { ...base, DARK: true },\n    LABEL: `${'Lab'}`,\n    NAMES: [NAME, 'B'],\n",
    ],
    ['client/src/store/settings.js', 'const defaults = {', "const base = makeTheme();\nconst NAME = 'A';\nconst defaults = {\n  CUSTOM: { [key]: 1 },\n  DISPLAY: makeDisplay(),"],
  ]);
  assert.deepEqual(map.settingsDefaultsIncomplete, { globalSettings: [['CUSTOM'], ['DISPLAY'], ['SYSTEM', 'FIELDS'], ['SYSTEM', 'THEME']] });
  assert.deepEqual(map.settingsDefaults.globalSettings.SYSTEM.NAMES, ['A', 'B']);
});

const LAB_ROUTE = '{globalSettings.SYSTEM.LAB_ENABLED ? <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact /> : null}';
const labRouteUnder = (guard) => LAB_ROUTE.replace('globalSettings.SYSTEM.LAB_ENABLED', guard);

for (const [guard, needs] of [
  ['!globalSettings.SYSTEM.LAB_ENABLED', [setting('SYSTEM.LAB_ENABLED', 'off', { default: false })]],
  ["globalSettings.SYSTEM.THEME === 'dark'", [setting('SYSTEM.THEME', 'equals', { value: 'dark' })]],
  ["'dark' == globalSettings?.SYSTEM?.['THEME']", [setting('SYSTEM.THEME', 'equals', { value: 'dark' })]],
  ['globalSettings.SYSTEM.LEVEL === 2', [setting('SYSTEM.LEVEL', 'equals', { value: 2 })]],
  ['globalSettings.SYSTEM.LAB_ENABLED === false', [setting('SYSTEM.LAB_ENABLED', 'off', { default: false })]],
  [
    'memberRole && globalSettings.SYSTEM.LAB_ENABLED && !globalSettings.SYSTEM.HELP_LINK_ENABLED',
    [setting('SYSTEM.LAB_ENABLED', 'on', { default: false }), setting('SYSTEM.HELP_LINK_ENABLED', 'off')],
  ],
]) {
  test(`a route guard ${guard} needs ${needs.map((n) => `${n.path.join('.')} ${n.need}`).join(', ')}`, async () => {
    const map = await buildEditedCopy([['client/src/Routes.js', LAB_ROUTE, labRouteUnder(guard)]]);
    assert.deepEqual(screen(map, '/lab#Lab').access.route.find((g) => g.kinds.includes('setting')).settings, needs);
  });
}

test('the guard of an else branch needs the opposite of its test', async () => {
  const map = await buildEditedCopy([['client/src/Routes.js', LAB_ROUTE, '{globalSettings.SYSTEM.LAB_ENABLED ? null : <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact />}']]);
  assert.deepEqual(screen(map, '/lab#Lab').access.route, [
    { guard: '!(globalSettings.SYSTEM.LAB_ENABLED)', kinds: ['setting'], settings: [setting('SYSTEM.LAB_ENABLED', 'off', { default: false })] },
  ]);
});

for (const [guard, reason] of [
  ['globalSettings.SYSTEM.LAB_ENABLED !== false', /같지 않음/],
  ['globalSettings.SYSTEM.LAB_ENABLED || memberRole', /또는/],
  ['globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST.includes(memberRole)', /함수를 불러/],
  ['globalSettings.SYSTEM.THEME === memberRole', /고정된 값이 아닌 것과 비교/],
  ['globalSettings.SYSTEM.LEVEL > 1', /크기를 비교/],
  ['!(globalSettings.SYSTEM.LAB_ENABLED && globalSettings.SYSTEM.HELP_LINK_ENABLED)', /부정한 조건/],
  ['!(memberRole && globalSettings.SYSTEM.LAB_ENABLED)', /부정한 조건/],
]) {
  test(`a route guard ${guard} cannot be read, and the screen says why`, async () => {
    const map = await buildEditedCopy([['client/src/Routes.js', LAB_ROUTE, labRouteUnder(guard)]]);
    const { route, settings } = screen(map, '/lab#Lab').access;
    const [read] = route.filter((g) => g.kinds.includes('setting'));
    assert.equal(read.settings, null);
    assert.match(read.settingsReason, reason);
    assert.deepEqual(settings[0], { from: 'route', needs: [], unreadable: [{ guard: read.guard, reason: read.settingsReason }] });
  });
}

test('a long guard is read from its source, not from the shortened text shown for it', async () => {
  const long = `globalSettings.SYSTEM.LAB_ENABLED && globalSettings.SYSTEM.${'VERY_LONG_SETTING_NAME_'.repeat(6)}ON`;
  const map = await buildEditedCopy([['client/src/Routes.js', LAB_ROUTE, labRouteUnder(long)]]);
  const [guard] = screen(map, '/lab#Lab').access.route;
  assert.match(guard.guard, /…$/);
  assert.deepEqual(guard.settings.map((n) => n.path.join('.')), ['SYSTEM.LAB_ENABLED', `SYSTEM.${'VERY_LONG_SETTING_NAME_'.repeat(6)}ON`]);
});

test('a menu rendered with map over the settings list links the same way', async () => {
  const map = await buildEditedCopy([
    [
      'client/src/components/SideMenu.js',
      '      MENUS.ADMIN?.LIST?.forEach((menu) => {\n        items.push({ title: menu, href: Option.ROUTE_PATH[menu] });\n      });',
      '      return MENUS.ADMIN.LIST.map((menu) => <Link to={Option.ROUTE_PATH[menu]}>{menu}</Link>);',
    ],
  ]);
  assert.deepEqual(
    screen(map, '/admin/report#AdminReport').access.links.map((l) => l.guards.map((g) => g.guard)),
    Array(3).fill(["globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST includes 'ADMIN_REPORT'", "['ADMIN', 'OWNER'].indexOf(session['member.role']) > -1", 'MENUS.ADMIN']),
  );
});

test('without settingsDefaults a route picked by a computed key makes no link', async () => {
  const map = await buildEditedCopy([
    ['config.json', '  "settingsDefaults": {\n    "globalSettings": {\n      "file": "store/settings.js",\n      "const": "defaults"\n    }\n  },\n', ''],
  ]);
  assert.deepEqual(screen(map, '/admin/report#AdminReport').access.links, []);
  assert.equal(screen(map, '/admin/report#AdminReport').access.restricted, false);
  assert.deepEqual(map.entries.find((e) => e.screen === '/admin/report#AdminReport').reasons, [{ kind: 'no-incoming-link' }]);
});

test('a settingsDefaults entry must name a settings root and a const holding an object in its file', async () => {
  await assert.rejects(
    buildEditedCopy([['config.json', '"settingsDefaults": {\n    "globalSettings"', '"settingsDefaults": {\n    "appSettings"']]),
    /settingsDefaults root "appSettings" is not listed in settingsRoots/,
  );
  await assert.rejects(
    buildEditedCopy([['config.json', '"const": "defaults"', '"const": "initialState"']]),
    /settingsDefaults\.globalSettings: store\/settings\.js has no top-level const initialState holding an object/,
  );
});

const wrapped = ['/home#Home', '/document/:tab_draft_done_#DocumentList', '/document/:id#DocumentDetail'];
const menuLinks = (map, id) => screen(map, id).links.filter((l) => l.file === 'components/SideMenu.js').map((l) => l.to);

test('a component wrapping routes in the routes file is part of every screen it wraps', async () => {
  const map = await buildFixture();
  for (const id of wrapped) {
    assert.deepEqual(menuLinks(map, id), ['/admin/report'], id);
    assert.ok(screen(map, id).settingReads.some((r) => r.file === 'components/SideMenu.js'), id);
  }
  for (const id of ['/signin#SignIn', '/help#Help', '/admin/report#AdminReport']) assert.deepEqual(menuLinks(map, id), [], id);
});

test('a route wrapped by two components gets both, and a wrapping component that is also a screen keeps its own links', async () => {
  const map = await buildEditedCopy([
    ['client/src/Routes.js', '          <Switch>\n', '          <Lab>\n          <Switch>\n'],
    ['client/src/Routes.js', '          </Switch>\n', '          </Switch>\n          </Lab>\n'],
  ]);
  for (const id of wrapped) {
    assert.deepEqual(menuLinks(map, id), ['/admin/report'], id);
    assert.ok(screen(map, id).links.some((l) => l.file === 'components/Lab.js' && l.to === '/lab/result'), id);
    assert.ok(screen(map, id).apiCalls.some((c) => c.fn === 'ajaxLabExperiment'), id);
  }
  assert.deepEqual(screen(map, '/lab#Lab').links.map((l) => l.to), ['/lab/result']);
});

test('a conditional route inside a wrapping component keeps its guard and gets the wrapper', async () => {
  const map = await buildEditedCopy([
    [
      'client/src/Routes.js',
      '            <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />',
      '            {memberRole && <Route path={`${Option.ROUTE_PATH.DOCUMENT}/:id`} component={waitFor(DocumentDetail)} exact />}',
    ],
  ]);
  assert.deepEqual(screen(map, '/document/:id#DocumentDetail').routeGuards, ['memberRole']);
  assert.deepEqual(menuLinks(map, '/document/:id#DocumentDetail'), ['/admin/report']);
});

test('a guard around the wrapping component guards every screen inside it, so the wrapper links come from restricted screens', async () => {
  const map = await buildEditedCopy([
    ['client/src/Routes.js', '        <Layout session={session} globalSettings={globalSettings}>\n', '        {globalSettings.SYSTEM.NAV_ENABLED && (\n        <Layout session={session} globalSettings={globalSettings}>\n'],
    ['client/src/Routes.js', '        </Layout>\n', '        </Layout>\n        )}\n'],
  ]);
  for (const id of wrapped) assert.deepEqual(screen(map, id).routeGuards, ['globalSettings.SYSTEM.NAV_ENABLED'], id);
  const report = screen(map, '/admin/report#AdminReport').access;
  assert.deepEqual(report.links.map((l) => [l.from, l.guards.length, l.fromKinds]), [
    ['/document/:id#DocumentDetail', 3, ['setting']],
    ['/document/:tab_draft_done_#DocumentList', 3, ['setting']],
    ['/home#Home', 3, ['setting']],
  ]);
  assert.deepEqual(report.kinds, ['role', 'setting']);
});

test('a link to a path without its parameters enters every route that only adds parameters to it', async () => {
  const map = await buildFixture();
  const from = (id) => screen(map, id).access.links.map((l) => l.from);
  assert.deepEqual(from('/document/:tab_draft_done_#DocumentList'), ['/home#Home']);
  assert.deepEqual(from('/document/:id#DocumentDetail'), ['/document/:tab_draft_done_#DocumentList', '/home#Home']);
});

test('a guard that reads neither a setting nor a configured role identifier does not block', async () => {
  const map = await buildEditedCopy([
    ['config.json', '"roleIdentifiers": [\n    "memberRole",\n    "session[\'member.role\']"\n  ],\n', ''],
    ['client/src/components/SignIn.js', '{globalSettings.SYSTEM.HELP_LINK_ENABLED && (', '{showHelp && ('],
  ]);
  assert.deepEqual(restrictedKinds(map), { '/lab#Lab': ['setting'], '/lab/result#LabResult': ['setting'], '/admin/report#AdminReport': ['setting'] });
  assert.deepEqual(screen(map, '/admin/member#AdminMember').access.route, []);
  assert.deepEqual(screen(map, '/help#Help').access.links.map((l) => l.guards), [[helpGuard], []]);
});

test('screens that link only to each other stay open', async () => {
  const map = await buildEditedCopy([
    [
      'client/src/Routes.js',
      '{globalSettings.SYSTEM.LAB_ENABLED ? <Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact /> : null}',
      '<Route path={Option.ROUTE_PATH.LAB} component={waitFor(Lab)} exact />',
    ],
    ['client/src/components/Home.js', '{globalSettings.SYSTEM.LAB_ENABLED && <Link to={Option.ROUTE_PATH.LAB}>Lab</Link>}', ''],
    [
      'client/src/components/LabResult.js',
      'export default function LabResult() {\n  return <section>Lab results</section>;',
      "import { Link } from 'react-router-dom';\nimport Option from '_define/Option';\n\nexport default function LabResult() {\n  return <Link to={Option.ROUTE_PATH.LAB}>Back</Link>;",
    ],
  ]);
  assert.deepEqual(screen(map, '/lab#Lab').access.links.map((l) => l.from), ['/lab/result#LabResult']);
  assert.deepEqual(restrictedKinds(map), {
    '/help#Help': ['setting'],
    '/admin/member#AdminMember': ['role'],
    '/admin/group#AdminGroup': ['role'],
    '/admin/audit#AdminAudit': ['role'],
    '/admin/report#AdminReport': ['role', 'setting'],
  });
});

test('a back link does not open screens that are reached only through a guarded link', async () => {
  const map = await buildEditedCopy([
    ['client/src/components/LabResult.js', 'export default function LabResult() {\n  return <section>Lab results</section>;', "import { Link } from 'react-router-dom';\nimport Option from '_define/Option';\n\nexport default function LabResult() {\n  return <Link to={Option.ROUTE_PATH.LAB}>Back</Link>;"],
    ['client/src/components/Help.js', 'return <article>Help</article>;', 'return <article><Link to={Option.ROUTE_PATH.SIGN_IN}>Back</Link></article>;'],
    ['client/src/components/Help.js', 'export default function Help() {', "import { Link } from 'react-router-dom';\nimport Option from '_define/Option';\n\nexport default function Help() {"],
  ]);
  assert.deepEqual(restrictedKinds(map), {
    '/help#Help': ['setting'],
    '/admin/member#AdminMember': ['role'],
    '/admin/group#AdminGroup': ['role'],
    '/lab#Lab': ['setting'],
    '/lab/result#LabResult': ['setting'],
    '/admin/audit#AdminAudit': ['role'],
    '/admin/report#AdminReport': ['role', 'setting'],
  });
});

for (const [name, use] of [
  ['without a guard', '<a onClick={openHelp}>?</a>'],
  ['under a guard that is neither a setting nor a role', '{form.touched && <a onClick={openHelp}>?</a>}'],
]) {
  test(`a handler also used ${name} leaves its link open`, async () => {
    const map = await buildEditedCopy([['client/src/components/SignIn.js', '    </form>', `      ${use}\n    </form>`]]);
    assert.equal(screen(map, '/help#Help').access.restricted, false);
    assert.deepEqual(screen(map, '/help#Help').access.links.map((l) => l.guards), [[helpGuard], []]);
  });
}

test('entry screens come from redirects in the routes file, screens no link leads to, and the config', async () => {
  const map = await buildFixture();
  assert.deepEqual(map.entries, [{ screen: '/signin#SignIn', reasons: [{ kind: 'redirect', file: 'Routes.js', line: 48 }, { kind: 'no-incoming-link' }] }]);
  assert.deepEqual(map.unknownEntryPaths, []);

  const configured = await buildEditedCopy([['config.json', '"roleIdentifiers"', '"entryPaths": ["/help", "/gone"],\n  "roleIdentifiers"']]);
  assert.deepEqual(configured.entries.map((e) => [e.screen, e.reasons.map((r) => r.kind)]), [
    ['/signin#SignIn', ['redirect', 'no-incoming-link']],
    ['/help#Help', ['config']],
  ]);
  assert.deepEqual(configured.unknownEntryPaths, ['/gone']);
  assert.equal(screen(configured, '/help#Help').access.restricted, false);
});

test('a redirect shown only under a setting or a role does not make its target an entry screen', async () => {
  const map = await buildEditedCopy([
    ['client/src/Routes.js', '      <Redirect to={Option.ROUTE_PATH.SIGN_IN} />', '      {globalSettings.SYSTEM.HELP_ENABLED && <Redirect from="/faq" to={Option.ROUTE_PATH.HELP} />}\n      <Redirect to={Option.ROUTE_PATH.SIGN_IN} />'],
  ]);
  assert.deepEqual(map.entries.map((e) => e.screen), ['/signin#SignIn']);
  assert.deepEqual(screen(map, '/help#Help').access.kinds, ['setting']);
});

const exportSites = (line) => ['/admin/audit#AdminAudit', '/admin/report#AdminReport'].map((s) => ({ screen: s, file: 'components/ExportDialog.js', line }));
const optionsOf = (map, id) => map.calls.find((c) => c.id === id).options;

test('a call node lists the on/off keys the screens put in its request body, with the screens and lines they were found at', async () => {
  const map = await buildFixture();
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/export'), [
    { key: 'withAttachments', values: [true, false], sources: ['source'], sites: exportSites(5) },
    { key: 'withHistory', values: [true, false], sources: ['source'], sites: exportSites(18) },
  ]);
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/archive'), [
    { key: 'signedOnly', values: [true, false], sources: ['source'], sites: exportSites(20) },
    { key: 'withHistory', values: [true, false], sources: ['source'], sites: exportSites(20) },
  ]);
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/archive/document'), []);
});

test('a GET call carries no body, so an on/off key a screen passes to its API function is not an option of it', async () => {
  const map = await buildFixture();
  assert.deepEqual(optionsOf(map, 'GET:/api/v1/member/list'), []);
});

test('when one call site reaches both a GET and a POST call, only the POST call takes the options found there', async () => {
  const map = await buildCopy((rewrite) =>
    rewrite('client/src/_ajax/AjaxFunc.js', (src) =>
      src.replace('info: Option.REST_API.MEMBER.LIST,', "info: page ? Option.REST_API.MEMBER.LIST : { METHOD: 'POST', URL: '/api/v1/member/list' },"),
    ),
  );
  assert.deepEqual(optionsOf(map, 'GET:/api/v1/member/list'), []);
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/member/list'), [
    { key: 'showError', values: [true, false], sources: ['source'], sites: [{ screen: '/admin/member#AdminMember', file: 'components/AdminMember.js', line: 8 }] },
  ]);
});

test('an option written in bodyOptions for a GET call is kept', async () => {
  const map = await buildCopy((rewrite) =>
    rewrite('config.json', (src) => {
      const config = JSON.parse(src);
      return JSON.stringify({ ...config, bodyOptions: { ...config.bodyOptions, 'GET:/api/v1/member/list': ['showError'] } });
    }),
  );
  assert.deepEqual(optionsOf(map, 'GET:/api/v1/member/list'), [{ key: 'showError', values: [true, false], sources: ['config'], sites: [] }]);
});

test('an option written in bodyOptions is added to its call with the config as its source, even when the body comes from another file', async () => {
  const map = await buildFixture();
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/schedule'), [{ key: 'weekly', values: [true, false], sources: ['config'], sites: [] }]);
  assert.deepEqual(map.unknownBodyOptionCalls, []);
});

test('an option both found in the source and written in bodyOptions is one option with both sources', async () => {
  const map = await buildCopy((rewrite) =>
    rewrite('config.json', (src) => {
      const config = JSON.parse(src);
      return JSON.stringify({ ...config, bodyOptions: { ...config.bodyOptions, 'POST:/api/v1/report/export': ['withHistory', 'withHistory', 'watermark'] } });
    }),
  );
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/export'), [
    { key: 'watermark', values: [true, false], sources: ['config'], sites: [] },
    { key: 'withAttachments', values: [true, false], sources: ['source'], sites: exportSites(5) },
    { key: 'withHistory', values: [true, false], sources: ['source', 'config'], sites: exportSites(18) },
  ]);
});

test('a call ID in bodyOptions that is not on the map is listed and adds no option', async () => {
  const map = await buildCopy((rewrite) =>
    rewrite('config.json', (src) => {
      const config = JSON.parse(src);
      return JSON.stringify({ ...config, bodyOptions: { 'POST:/api/v1/report/weekly': ['weekly'], ...config.bodyOptions, 'GET:/api/v1/download': ['inline'] } });
    }),
  );
  assert.deepEqual(map.unknownBodyOptionCalls, ['GET:/api/v1/download', 'POST:/api/v1/report/weekly']);
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/schedule').map((o) => o.key), ['weekly']);
});

test('a key followed by a computed key or a key or getter of the same name is not an option, and a method of another name does not matter', async () => {
  const map = await buildCopy((rewrite) =>
    rewrite('client/src/components/ExportDialog.js', (src) =>
      src
        .replace('withAttachments: true }', 'withAttachments: true, [extraKey]: false }')
        .replace("{ ids, withHistory, format: 'pdf' }", "{ ids, withHistory, format: 'pdf', onDone() {} }")
        .replace('{ ids, signedOnly, withHistory }', '{ ids, signedOnly, withHistory, signedOnly: ids.length > 0, get withHistory() { return ids.length > 0; } }'),
    ),
  );
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/export').map((o) => o.key), ['withHistory']);
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/archive'), []);
});

test('a later spread overrides the keys before it, and of several bodyArgKeys properties the last is read unless a spread follows it', async () => {
  const map = await buildCopy((rewrite) =>
    rewrite('client/src/components/ExportDialog.js', (src) =>
      src
        .replace('withAttachments: true }', 'withAttachments: true, ...extra }')
        .replace("{ ids, withHistory, format: 'pdf' }", '{ data: { ids, withHistory }, data: { ids, signedOnly } }')
        .replace('{ data: { ids, signedOnly, withHistory } }', '{ data: { ids, signedOnly, withHistory }, ...extra }'),
    ),
  );
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/export').map((o) => o.key), ['signedOnly']);
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/archive'), []);
});

test('without bodyArgKeys in the config, only an object written straight into the call is read as the body', async () => {
  const map = await buildCopy((rewrite) => rewrite('config.json', (src) => JSON.stringify({ ...JSON.parse(src), bodyArgKeys: undefined })));
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/archive'), []);
  assert.deepEqual(optionsOf(map, 'POST:/api/v1/report/export').map((o) => o.key), ['withAttachments', 'withHistory']);
});

test('the options and their order come out the same on every run', async () => {
  const options = async () => JSON.stringify((await buildFixture()).calls.map((c) => [c.id, c.options]));
  assert.equal(await options(), await options());
});

test('bodyArgKeys that is not a list of names is rejected', async () => {
  await assert.rejects(
    buildCopy((rewrite) => rewrite('config.json', (src) => JSON.stringify({ ...JSON.parse(src), bodyArgKeys: 'data' }))),
    /bodyArgKeys must be a list of property names/,
  );
});

for (const bodyOptions of [5, ['weekly'], [['weekly']], { 'POST:/api/v1/report/schedule': 'weekly' }, { 'POST:/api/v1/report/schedule': [true] }]) {
  test(`bodyOptions ${JSON.stringify(bodyOptions)} is rejected`, async () => {
    await assert.rejects(
      buildCopy((rewrite) => rewrite('config.json', (src) => JSON.stringify({ ...JSON.parse(src), bodyOptions }))),
      /bodyOptions must map call IDs to lists of body keys/,
    );
  });
}
