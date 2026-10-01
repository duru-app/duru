import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { addMark } from '../src/marks.mjs';
import { reviewData } from '../src/review.mjs';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.mjs');

function withFixtureCopy(fn) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), marksDir: 'example-marks' }));
    const cli = (...args) => execFileSync(process.execPath, [CLI, ...args, configFile], { encoding: 'utf8' });
    return fn({ copy, configFile, cli });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const EXPECTED = `# Test tasks — 4 screens, 1 call, 5 open marks

A reviewer marked these screens and API calls as needing more tests (\`needs-more\`) or as having none (\`missing\`). Write the tests, put \`@screen:<screen ID>\` in each test title (\`@call:<call ID>\` for a test of one API call, with \`@option:<key>=true|false\` for each on/off option the test sets), add \`@depth:<ui|api|render|code|data|output>\` when the depth of the result source does not fit, then run \`duru rebuild\` and read this list again. A screen or call stays here until a reviewer marks it \`fine\`.

Source files are under \`client/src\`.

## /admin/member#AdminMember

- marks:
  - missing, whole screen — "No test signs in as an admin." (Kim Min, 2026-09-29)
- component: components/AdminMember.js, route at Routes.js:42
- access: needs a role
  - route guard \`isAdminRole(memberRole)\` (role)
  - link from /home#Home at components/Home.js:17, guard \`memberRole === 'ADMIN'\` (role)
- calls:
  - GET:/api/v1/member/list — no tests
- tests:
  - ui fail — admin @screen:/admin/member#AdminMember › lists members — home.spec.ts:11 (chromium)
  - api pass — Help service › links the member page @screen:/admin/member#AdminMember — com.example.help.HelpServiceTest

## /help#Help

- marks:
  - needs-more, api depth — "The help index test fails." (reviewer, 2026-09-28)
- component: components/Help.js, route at Routes.js:41
- access: needs a setting
  - link from /document/:id#DocumentDetail at components/DocumentDetail.js:20, guard \`helpEnabled\` (setting)
  - link from /signin#SignIn at components/SignIn.js:8, guard \`globalSettings.SYSTEM.HELP_LINK_ENABLED\` through openHelp (setting)
- calls: none
- tests:
  - ui pass — help link opens help @screen:/signin#SignIn @screen:/help#Help — sign-in.spec.ts:5 (chromium)
  - api fail — Help service › loads the help index @screen:/help#Help @depth:e2e — com.example.help.HelpServiceTest
  - code pending — searches help @screen:/help#Help — /work/app/src/home/home.test.js:17

## /home#Home

- marks:
  - needs-more, data depth — "Moving a draft fails; add a data check once it is fixed." (reviewer, 2026-09-29)
- component: components/Home.js, route at Routes.js:35
- access: opens without a setting or role
- calls:
  - GET:/api/v1/document/list — no tests
  - POST:/api/v1/archive/document — not on the server, no tests
- tests:
  - ui pass — shows the document list @screen:/home#Home — home.spec.ts:3 (chromium)
  - ui pass — shows the document list @screen:/home#Home — home.spec.ts:3 (firefox)
  - api pass — Home service @screen:/home#Home › lists recent documents — com.example.home.HomeServiceTest
  - api pending — Home service @screen:/home#Home › hides archived documents — com.example.home.HomeServiceTest
  - render fail — Home @screen:/home#Home › filters › keeps the draft filter @depth:render — /work/app/src/home/home.test.js:9
  - code pass — Home @screen:/home#Home › renders the list — /work/app/src/home/home.test.js:4
  - data fail — Home service @screen:/home#Home › moves a draft & keeps the list order @depth:data — com.example.home.HomeServiceTest

## /lab/result#LabResult

- marks:
  - missing, whole screen (Kim Min, 2026-09-30)
- component: components/LabResult.js, route at Routes.js:45
- access: needs a setting
  - link from /lab#Lab at components/Lab.js:14, no guard — /lab#Lab itself needs a setting
- calls: none
- tests: none

# API calls

## POST:/api/v1/archive/document

- marks:
  - missing, api depth — "The server has no archive endpoint; check what the archive button gets back." (Kim Min, 2026-09-30)
- called from: /document/:tab_draft_done_#DocumentList, /home#Home
- server: not on the server
- tests: none
`;

test('the task list holds the needs-more and missing marks of the fake client, leaving out fine and detached ones', () => {
  withFixtureCopy(({ cli }) => {
    cli('rebuild');
    assert.equal(cli('tasks'), EXPECTED);
  });
});

test('a tagged Playwright test added for a listed screen shows on the page and in the task list after a rebuild', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.writeFileSync(
      path.join(copy, 'results/playwright/lab-result.json'),
      JSON.stringify({
        config: { projects: [] },
        suites: [
          {
            title: 'lab-result.spec.ts',
            file: 'lab-result.spec.ts',
            specs: [
              {
                title: 'shows the experiment result @screen:/lab/result#LabResult',
                tags: ['screen:/lab/result#LabResult'],
                tests: [{ expectedStatus: 'passed', projectName: 'chromium', results: [], status: 'expected' }],
                file: 'lab-result.spec.ts',
                line: 3,
              },
            ],
          },
        ],
      }),
    );
    cli('rebuild');

    const page = reviewData(loadConfig(configFile), null);
    assert.deepEqual(page.tests.nodes['/lab/result#LabResult'].map((t) => [t.title, t.depth, t.status]), [
      ['shows the experiment result @screen:/lab/result#LabResult', 'ui', 'pass'],
    ]);
    const labResult = cli('tasks').split('## /lab/result#LabResult\n')[1];
    assert.match(labResult, /^- tests:\n {2}- ui pass — shows the experiment result @screen:\/lab\/result#LabResult — lab-result\.spec\.ts:3 \(chromium\)$/m);
  });
});

test('with no open marks the task list says so', () => {
  withFixtureCopy(({ copy, cli }) => {
    fs.rmSync(path.join(copy, 'example-marks'), { recursive: true });
    cli('rebuild');
    assert.match(cli('tasks'), /^# Test tasks — 0 screens, 0 calls, 0 open marks\n[\s\S]*\nNo open marks\.\n$/);
  });
});

test('a note over several lines stays inside its mark, and a call whose API function was not found still shows', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    cli('rebuild');
    const config = loadConfig(configFile);
    addMark(config.marksDir, { target: { node: '/lab#Lab' }, status: 'missing', note: 'Check the start.\n## /fake#Fake\n- tests: none', author: 'a' }, new Date('2026-09-30T05:00:00Z'));
    const mapFile = path.join(copy, 'out/map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    map.screens.find((s) => s.id === '/lab#Lab').apiCalls[0].endpoints = null;
    fs.writeFileSync(mapFile, JSON.stringify(map));

    const lab = cli('tasks').split('## /lab#Lab\n')[1].split('\n## ')[0];
    assert.match(lab, /^ {2}- missing, whole screen — "Check the start\.\n {4}## \/fake#Fake\n {4}- tests: none" \(a, 2026-09-30\)$/m);
    assert.match(lab, /^ {2}- ajaxLabExperiment at components\/Lab\.js:\d+ — not found among the API functions$/m);
  });
});

test('a result source configured with the output depth shows its tests and an output-depth mark in the task list', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.mkdirSync(path.join(copy, 'results/verdict/exports'));
    fs.writeFileSync(
      path.join(copy, 'results/verdict/exports/export-checks.log'),
      'VERDICT result file: UPHOLDS — the exported file holds every experiment row @screen:/lab/result#LabResult\n' +
        'VERDICT list file: BROKEN — the exported list misses archived documents @call:GET:/api/v1/document/list\n',
    );
    const own = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...own, tests: [...own.tests, { format: 'verdict', path: 'results/verdict/exports', depth: 'output' }] }));
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/lab/result#LabResult', depth: 'output' }, status: 'needs-more', note: 'Open the file.', author: 'a' }, new Date('2026-10-01T05:00:00Z'));

    const tasks = cli('tasks');
    const labResult = tasks.split('## /lab/result#LabResult\n')[1].split('\n## ')[0];
    assert.match(labResult, /^ {2}- needs-more, output depth — "Open the file\." \(a, 2026-10-01\)$/m);
    assert.match(labResult, /^- tests:\n {2}- output pass — result file — export-checks\.log:1 — the exported file holds every experiment row$/m);
    const home = tasks.split('## /home#Home\n')[1].split('\n## ')[0];
    assert.match(home, /^ {2}- GET:\/api\/v1\/document\/list — tests: output fail 1$/m);
  });
});

test('a guarded link from a screen that opens only under a setting says so after its guards', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    const routes = path.join(copy, 'client/src/Routes.js');
    const original = fs.readFileSync(routes, 'utf8');
    const wrapped = original
      .replace('        <Layout session={session} globalSettings={globalSettings}>\n', '        {globalSettings.SYSTEM.NAV_ENABLED && (\n        <Layout session={session} globalSettings={globalSettings}>\n')
      .replace('        </Layout>\n', '        </Layout>\n        )}\n');
    assert.ok(wrapped.includes('NAV_ENABLED && (\n') && wrapped.includes('</Layout>\n        )}\n'));
    fs.writeFileSync(routes, wrapped);
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/report#AdminReport' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const report = cli('tasks').split('## /admin/report#AdminReport\n')[1].split('\n## ')[0];
    const fromHome = report.split('\n').find((l) => l.startsWith('  - link from /home#Home'));
    assert.match(fromHome, /, guard `[^`]+` \(setting\); `[^`]+` \(role\); `MENUS\.ADMIN` \(setting\) — \/home#Home itself needs a setting$/);
  });
});

test('a call line in the task list names the on/off options of its request body, including those set in the config, with the tests of each option value by depth', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/report#AdminReport' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const report = cli('tasks').split('## /admin/report#AdminReport\n')[1].split('\n## ')[0];
    assert.equal(
      report.slice(report.indexOf('- calls:')),
      [
        '- calls:',
        '  - POST:/api/v1/report/export — tests: ui pass 4, ui fail 1 — options: withAttachments, withHistory',
        '    - withAttachments=true — tests: ui fail 1',
        '    - withAttachments=false — no tests',
        '    - withHistory=true — tests: ui pass 2',
        '    - withHistory=false — tests: ui fail 1',
        '    - no option tag — tests: ui pass 2',
        '  - POST:/api/v1/report/archive — tests: ui pass 1 — options: signedOnly, withHistory',
        '    - signedOnly=true — tests: ui pass 1',
        '    - signedOnly=false — no tests',
        '    - withHistory=true — tests: ui pass 1',
        '    - withHistory=false — no tests',
        '    - no option tag — no tests',
        '  - POST:/api/v1/report/schedule — no tests — options: weekly',
        '    - weekly=true — no tests',
        '    - weekly=false — no tests',
        '    - no option tag — no tests',
        '- tests: none',
        '',
      ].join('\n'),
    );
  });
});

test('screens that share an ID each keep the options they send themselves', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    cli('rebuild');
    const mapFile = path.join(copy, 'out/map.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    const report = map.screens.find((s) => s.id === '/admin/report#AdminReport');
    const plainExport = { ...report.apiCalls.find((c) => c.fn === 'ajaxReportExport'), options: [] };
    map.screens.push({ ...report, line: 99, apiCalls: [plainExport] });
    fs.writeFileSync(mapFile, JSON.stringify(map));
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/report#AdminReport' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const sections = cli('tasks').split('## /admin/report#AdminReport\n').slice(1).map((s) => s.split('\n## ')[0]);
    assert.equal(sections.length, 2);
    assert.match(sections[0], /^ {2}- POST:\/api\/v1\/report\/export — tests: ui pass 4, ui fail 1 — options: withAttachments, withHistory$/m);
    assert.match(sections[1], /^- calls:\n {2}- POST:\/api\/v1\/report\/export — tests: ui pass 4, ui fail 1\n- tests: none$/m);
  });
});

test('a link from a screen that opens only under a role says so', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/audit#AdminAudit' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const audit = cli('tasks').split('## /admin/audit#AdminAudit\n')[1].split('\n## ')[0];
    assert.match(audit, /^ {2}- link from \/admin\/member#AdminMember at components\/AdminMember\.js:14, no guard — \/admin\/member#AdminMember itself needs a role$/m);
  });
});

test('a link from a screen that needs both a setting and a role names both', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
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
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/help#Help' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const help = cli('tasks').split('## /help#Help\n')[1].split('\n## ')[0];
    assert.match(help, /^ {2}- link from \/admin\/report#AdminReport at components\/AdminReport\.js:10, no guard — \/admin\/report#AdminReport itself needs a role and a setting$/m);
  });
});

test('a call line names only the options its own screen sends in the source', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.writeFileSync(
      path.join(copy, 'client/src/components/AdminAudit.js'),
      "import { ajaxReportExport } from '_ajax/AjaxFunc';\n\nexport default function AdminAudit() {\n  return <button onClick={() => ajaxReportExport({ ids: [] })}>Export</button>;\n}\n",
    );
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/audit#AdminAudit' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const audit = cli('tasks').split('## /admin/audit#AdminAudit\n')[1].split('\n## ')[0];
    assert.match(audit, /^- calls:\n {2}- POST:\/api\/v1\/report\/export — tests: ui pass 4, ui fail 1\n- tests: none$/m);
  });
});

test('a test whose option tags name only options this screen does not send counts on no option line of the call', () => {
  withFixtureCopy(({ copy, configFile, cli }) => {
    fs.writeFileSync(
      path.join(copy, 'client/src/components/AdminAudit.js'),
      "import { ajaxReportExport } from '_ajax/AjaxFunc';\n\nexport default function AdminAudit() {\n  return <button onClick={() => ajaxReportExport({ ids: [], withAttachments: true })}>Export</button>;\n}\n",
    );
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: '/admin/audit#AdminAudit' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    const audit = cli('tasks').split('## /admin/audit#AdminAudit\n')[1].split('\n## ')[0];
    assert.equal(
      audit.slice(audit.indexOf('- calls:')),
      [
        '- calls:',
        '  - POST:/api/v1/report/export — tests: ui pass 4, ui fail 1 — options: withAttachments',
        '    - withAttachments=true — tests: ui fail 1',
        '    - withAttachments=false — no tests',
        '    - no option tag — tests: ui pass 2',
        '- tests: none',
        '',
      ].join('\n'),
    );
  });
});

test('a mark on an option value of a call is listed with the option key, value and depth, where the option was found, and the tests of that cell', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    const at = new Date('2026-10-01T05:00:00Z');
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withHistory', value: true } }, status: 'needs-more', note: 'Only the UI is tested.', author: 'a' }, at);
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withHistory', value: true }, depth: 'output' }, status: 'missing', note: 'Open the exported file.', author: 'a' }, at);
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withAttachments', value: false }, depth: 'ui' }, status: 'fine', author: 'a' }, at);
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/schedule', option: { key: 'weekly', value: true } }, status: 'missing', author: 'a' }, at);

    const tasks = cli('tasks');
    assert.match(tasks, /^# Test tasks — 4 screens, 3 calls, 8 open marks$/m);
    const section = (id) => tasks.split(`\n## ${id}\n`)[1].split('\n## ')[0];
    assert.equal(
      section('POST:/api/v1/report/export'),
      [
        '',
        '- marks:',
        '  - needs-more, withHistory=true — "Only the UI is tested." (a, 2026-10-01)',
        '  - missing, withHistory=true at output depth — "Open the exported file." (a, 2026-10-01)',
        '- called from: /admin/audit#AdminAudit, /admin/report#AdminReport',
        '- server: on the server (core)',
        '- marked options:',
        '  - withHistory — found at components/ExportDialog.js:18 (/admin/audit#AdminAudit, /admin/report#AdminReport)',
        '    - withHistory=true:',
        '      - ui pass — exports with history @call:POST:/api/v1/report/export @option:withHistory=true — export.spec.ts:3 (chromium)',
        '      - ui pass — archives signed reports with history, then exports them @call:POST:/api/v1/report/archive @call:POST:/api/v1/report/export @option:signedOnly=true @option:withHistory=true — export.spec.ts:24 (chromium)',
        '    - withHistory=true at output depth: no tests',
        '- tests:',
        '  - ui pass — exports with history @call:POST:/api/v1/report/export @option:withHistory=true — export.spec.ts:3 (chromium)',
        '  - ui fail — exports a package with attachments and without history @call:POST:/api/v1/report/export @option:withAttachments=true @option:withHistory=false — export.spec.ts:10 (chromium)',
        '  - ui pass — exports the selected reports @call:POST:/api/v1/report/export — export.spec.ts:17 (chromium)',
        '  - ui pass — archives signed reports with history, then exports them @call:POST:/api/v1/report/archive @call:POST:/api/v1/report/export @option:signedOnly=true @option:withHistory=true — export.spec.ts:24 (chromium)',
        '  - ui pass — exports signed reports only @call:POST:/api/v1/report/export @option:signedOnly=true @option:withHistory=yes — export.spec.ts:31 (chromium)',
        '',
      ].join('\n'),
    );
    assert.equal(
      section('POST:/api/v1/report/schedule'),
      [
        '',
        '- marks:',
        '  - missing, weekly=true (a, 2026-10-01)',
        '- called from: /admin/audit#AdminAudit, /admin/report#AdminReport',
        '- server: on the server (core)',
        '- marked options:',
        '  - weekly — set in the config, not found in the source',
        '    - weekly=true: no tests',
        '- tests: none',
        '',
      ].join('\n'),
    );
  });
});

test('an option mark whose option is gone from the map stays out of the task list', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    addMark(loadConfig(configFile).marksDir, { target: { node: 'POST:/api/v1/report/export', option: { key: 'withComments', value: true } }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    assert.equal(cli('tasks'), EXPECTED);
  });
});

test('an API call with an open mark is listed once under API calls with its screens, server match and tests, and a call marked fine is left out', () => {
  withFixtureCopy(({ configFile, cli }) => {
    cli('rebuild');
    const { marksDir } = loadConfig(configFile);
    addMark(marksDir, { target: { node: 'PUT:/api/v1/document/{documentId}/name' }, status: 'needs-more', note: 'Rename uses the wrong method.', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    addMark(marksDir, { target: { node: 'POST:/api/v1/report/archive', depth: 'ui' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    addMark(marksDir, { target: { node: 'GET:/api/v1/member/list' }, status: 'missing', author: 'a' }, new Date('2026-10-01T05:00:00Z'));
    addMark(marksDir, { target: { node: 'GET:/api/v1/member/list' }, status: 'fine', author: 'a' }, new Date('2026-10-01T06:00:00Z'));

    const tasks = cli('tasks');
    assert.match(tasks, /^# Test tasks — 4 screens, 3 calls, 7 open marks$/m);
    assert.equal(
      tasks.slice(tasks.indexOf('\n# API calls\n')),
      [
        '',
        '# API calls',
        '',
        '## POST:/api/v1/archive/document',
        '',
        '- marks:',
        '  - missing, api depth — "The server has no archive endpoint; check what the archive button gets back." (Kim Min, 2026-09-30)',
        '- called from: /document/:tab_draft_done_#DocumentList, /home#Home',
        '- server: not on the server',
        '- tests: none',
        '',
        '## POST:/api/v1/report/archive',
        '',
        '- marks:',
        '  - missing, ui depth (a, 2026-10-01)',
        '- called from: /admin/audit#AdminAudit, /admin/report#AdminReport',
        '- server: on the server (core)',
        '- tests:',
        '  - ui pass — archives signed reports with history, then exports them @call:POST:/api/v1/report/archive @call:POST:/api/v1/report/export @option:signedOnly=true @option:withHistory=true — export.spec.ts:24 (chromium)',
        '',
        '## PUT:/api/v1/document/{documentId}/name',
        '',
        '- marks:',
        '  - needs-more, whole call — "Rename uses the wrong method." (a, 2026-10-01)',
        '- called from: /document/:id#DocumentDetail',
        '- server: method mismatch — the server has core POST /api/v1/document/{documentId}/name',
        '- tests:',
        '  - ui fail — rename is refused by the server @call:PUT:/api/v1/document/{documentId}/name — document.spec.ts:4 (chromium)',
        '',
      ].join('\n'),
    );
  });
});
