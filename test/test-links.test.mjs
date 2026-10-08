import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { screenCases } from '../src/access.mjs';
import { loadConfig } from '../src/config.mjs';
import { buildMap } from '../src/map.mjs';
import { readPlaywright } from '../src/playwright.ts';
import { linkTests } from '../src/test-links.ts';

const FIXTURE_CONFIG = path.join(import.meta.dirname, 'fixtures/app/config.json');
const config = loadConfig(FIXTURE_CONFIG);
const links = linkTests(config, await buildMap(config));
const summary = (id, format = 'playwright') =>
  (links.nodes[id] ?? []).filter((t) => t.format === format).map((t) => [t.project, t.depth, t.status].filter(Boolean).join(' '));

test('a tagged Playwright test attaches to its screen with the configured depth and its status', () => {
  assert.deepEqual(summary('/home#Home'), ['chromium ui pass', 'firefox ui pass', 'chromium ui pass']);
  assert.deepEqual(summary('/admin/member#AdminMember'), ['chromium ui fail', 'chromium ui pass', 'chromium ui pass', 'chromium ui pass']);
  const [home] = links.nodes['/home#Home'];
  assert.equal(home.title, 'shows the document list @screen:/home#Home');
  assert.equal(home.file, 'home.spec.ts');
  assert.equal(home.line, 3);
  assert.equal(home.source, 'results/playwright/e2e.json');
});

test('a skipped test is pending', () => {
  assert.deepEqual(summary('/lab#Lab'), ['chromium ui pending', 'chromium ui pass', 'chromium ui pass']);
});

test('a test tagged with two screens attaches to both', () => {
  assert.deepEqual(summary('/signin#SignIn'), ['chromium ui pass']);
  assert.deepEqual(summary('/help#Help'), ['chromium ui pass', 'chromium ui fail']);
});

test('tags pointing outside the map and tests without a node tag are reported separately, once per test across projects', () => {
  assert.deepEqual(
    links.unknownTags.map((u) => `${u.tag} ${u.test.file}:${u.test.line}`),
    [
      'screen:/settings#Settings home.spec.ts:26',
      'call:DELETE:/api/v1/document/{documentId} document.spec.ts:12',
      'option:signedOnly=true export.spec.ts:31',
      'option:withHistory=yes export.spec.ts:31',
      'role:OWNER access.spec.ts:23',
      'role:ADMIN access.spec.ts:28',
      'setting:SYSTEM.LAB_ENABLED access.spec.ts:33',
      'depth:e2e com.example.help.HelpServiceTest:null',
    ],
  );
  assert.equal(links.untaggedCount, 13);
  assert.equal(Object.keys(links.nodes).includes('/settings#Settings'), false);
  assert.deepEqual(links.missingSources, []);
});

const casesAt = (id) => links.nodes[id].filter((t) => t.cases).map((t) => [t.title, t.cases]);

test('a role or setting tag attaches its test to that case of the screen it is tagged with', () => {
  assert.deepEqual(casesAt('/admin/member#AdminMember'), [
    ['lists members for an admin', ['role:ADMIN']],
    ['sends a member signed in as MEMBER back home', ['role:other']],
  ]);
  assert.deepEqual(casesAt('/help#Help'), [['opens help from the sign-in page while the help link is on', ['setting:SYSTEM.HELP_LINK_ENABLED=true']]]);
  assert.deepEqual(casesAt('/lab#Lab'), [['keeps the lab closed while it is off', ['setting:SYSTEM.LAB_ENABLED=false']]]);
});

test('a test with a role tag and a setting tag counts for each case, and the setting case of a list names the value', () => {
  const access = {
    restricted: true,
    kinds: ['role', 'setting'],
    roleValues: ['ADMIN'],
    links: [],
    settings: [{ from: 'route', needs: [{ root: 'globalSettings', path: ['MENU', 'LIST'], need: 'includes', value: 'REPORT' }, { root: 'globalSettings', path: ['MENU'], need: 'present' }], unreadable: [] }],
  };
  const report = reportOf([{ title: 'a.spec.ts', specs: [{ title: 'x', tags: ['screen:/report#Report', 'role:ADMIN', 'setting:MENU.LIST:REPORT=false'], file: 'a.spec.ts', line: 1, tests: [{ status: 'expected' }] }] }]);
  withResults({ 'report.json': report }, (own) => {
    const result = linkTests(own, { screens: [{ id: '/report#Report', access }] });
    assert.deepEqual(result.nodes['/report#Report'].map((t) => t.cases), [['role:ADMIN', 'setting:MENU.LIST:REPORT=false']]);
    assert.deepEqual(result.unknownTags, []);
  });
});

const need = (path, extra = {}) => ({ root: 'globalSettings', path: path.split('.'), need: 'on', ...extra });
const settingTags = (access) => screenCases({ restricted: true, kinds: ['setting'], ...access }).map((c) => c.tag);

test('a screen reached only through links has setting cases only for the conditions every link asks, and its route conditions always', () => {
  const links = [{ from: '/a' }, { from: '/b' }];
  assert.deepEqual(
    settingTags({ links, settings: [{ from: '/a', needs: [need('LAB'), need('MENU')] }, { from: '/b', needs: [need('LAB')] }] }),
    ['setting:LAB=true', 'setting:LAB=false'],
  );
  assert.deepEqual(settingTags({ links, settings: [{ from: '/a', needs: [need('LAB')] }] }), []);
  assert.deepEqual(
    settingTags({ links, settings: [{ from: 'route', needs: [need('MENU.LIST', { need: 'includes', value: 'REPORT' })] }, { from: '/a', needs: [need('LAB')] }] }),
    ['setting:MENU.LIST:REPORT=true', 'setting:MENU.LIST:REPORT=false'],
  );
});

test('a role or setting tag that is no case of its screen is reported, and its test still counts for the screen without a case', () => {
  assert.deepEqual(
    links.unknownTags.filter((u) => /^(role|setting):/.test(u.tag)).map((u) => `${u.tag} ${u.test.title}`),
    ['role:OWNER lists members for an owner', 'role:ADMIN shows the home page to an admin', 'setting:SYSTEM.LAB_ENABLED opens the lab with the setting named but no value'],
  );
  const owner = links.nodes['/admin/member#AdminMember'].find((t) => t.title === 'lists members for an owner');
  assert.equal(owner.status, 'pass');
  assert.ok(!('cases' in owner));
  assert.ok(links.nodes['/home#Home'].every((t) => !t.cases));
});

test('a role tag on a test with no screen tag is reported', () => {
  const report = reportOf([{ title: 'a.spec.ts', specs: [{ title: 'x', tags: ['call:GET:/x', 'role:ADMIN'], file: 'a.spec.ts', line: 1, tests: [{ status: 'expected' }] }] }]);
  withResults({ 'report.json': report }, (own) => {
    const result = linkTests(own, { screens: [], calls: [{ id: 'GET:/x' }] });
    assert.deepEqual(result.unknownTags.map((u) => u.tag), ['role:ADMIN']);
    assert.equal(result.nodes['GET:/x'].length, 1);
  });
});

test('a Playwright test tagged with a call ID attaches to that call node', () => {
  const id = 'PUT:/api/v1/document/{documentId}/name';
  assert.deepEqual(summary(id), ['chromium ui fail']);
  assert.equal(links.nodes[id][0].title, `rename is refused by the server @call:${id}`);
  assert.equal(Object.keys(links.nodes).includes('DELETE:/api/v1/document/{documentId}'), false);
});

test('tagged JUnit tests attach with their status, reading tags from the suite and test names', () => {
  assert.deepEqual(summary('/home#Home', 'junit'), ['api pass', 'data fail', 'api pending']);
  assert.deepEqual(summary('/document/:id#DocumentDetail', 'junit'), ['api pass']);
  assert.deepEqual(summary('/admin/member#AdminMember', 'junit'), ['api pass']);
  const [home] = links.nodes['/home#Home'].filter((t) => t.format === 'junit');
  assert.equal(home.title, 'Home service @screen:/home#Home › lists recent documents');
  assert.equal(home.file, 'com.example.home.HomeServiceTest');
  assert.equal(home.line, null);
  assert.equal(home.project, null);
  assert.equal(home.source, 'results/junit/TEST-com.example.home.HomeServiceTest.xml');
});

test('entities in JUnit names come out decoded', () => {
  const titles = links.nodes['/home#Home'].filter((t) => t.format === 'junit').map((t) => t.title);
  assert.ok(titles.includes('Home service @screen:/home#Home › moves a draft & keeps the list order @depth:data'));
});

test('tagged Vitest tests attach with their status, reading the tags field and the titles', () => {
  assert.deepEqual(summary('/home#Home', 'vitest'), ['code pass', 'render fail']);
  assert.deepEqual(summary('/signin#SignIn', 'vitest'), ['code pass']);
  assert.deepEqual(summary('/help#Help', 'vitest'), ['code pending']);
  assert.deepEqual(summary('/lab#Lab', 'vitest'), ['code pending']);
  const [home] = links.nodes['/home#Home'].filter((t) => t.format === 'vitest');
  assert.equal(home.title, 'Home @screen:/home#Home › renders the list');
  assert.equal(home.file, '/work/app/src/home/home.test.js');
  assert.equal(home.line, 4);
  assert.equal(home.source, 'results/vitest/unit.json');
});

test('tests of several formats on one node each carry their own depth', () => {
  assert.deepEqual(
    links.nodes['/home#Home'].map((t) => `${t.format} ${t.depth}`),
    ['playwright ui', 'playwright ui', 'playwright ui', 'junit api', 'junit data', 'junit api', 'vitest code', 'vitest render'],
  );
});

test('only tests tagged with a known @depth come out with a depth other than the configured one', () => {
  const configured = (t) => config.tests.find((s) => path.join(config.configDir, t.source).startsWith(s.path)).depth;
  const overridden = Object.values(links.nodes)
    .flat()
    .filter((t) => t.depth !== configured(t))
    .map((t) => `${t.format} ${t.depth} ${t.title}`);
  assert.deepEqual(overridden, [
    'junit data Home service @screen:/home#Home › moves a draft & keeps the list order @depth:data',
    'vitest render Home @screen:/home#Home › filters › keeps the draft filter @depth:render',
  ]);
});

test('an unknown @depth value keeps the configured depth and is reported as an unknown tag', () => {
  assert.deepEqual(summary('/help#Help', 'junit'), ['api fail']);
  assert.deepEqual(
    links.unknownTags.filter((u) => u.tag.startsWith('depth:')).map((u) => u.test.title),
    ['Help service › loads the help index @screen:/help#Help @depth:e2e'],
  );
});

function withResults(files, fn, formats = ['playwright']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'results'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'results', name), body);
    const tests = formats.map((format) => ({ format, path: path.join(dir, 'results'), depth: 'ui' }));
    const own = { ...config, configDir: dir, tests };
    return fn(own, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const reportOf = (suites) => JSON.stringify({ suites });

test('without a tags field, tags are read from the test title and the titles of its describe blocks', () => {
  const report = reportOf([
    {
      title: 'a.spec.ts',
      specs: [{ title: 'opens help @screen:/help#Help', file: 'a.spec.ts', line: 1, tests: [{ projectName: 'chromium', status: 'expected' }] }],
      suites: [
        {
          title: 'home @screen:/home#Home',
          specs: [{ title: 'loads', file: 'a.spec.ts', line: 5, tests: [{ projectName: 'chromium', status: 'unexpected' }] }],
        },
      ],
    },
  ]);
  withResults({ 'report.json': report }, (own) => {
    const result = linkTests(own, { screens: [{ id: '/help#Help' }, { id: '/home#Home' }] });
    assert.deepEqual(result.nodes['/help#Help'].map((t) => t.status), ['pass']);
    assert.deepEqual(result.nodes['/home#Home'].map((t) => t.status), ['fail']);
  });
});

test('JSON in a results folder that is not a Playwright report is skipped', () => {
  const report = reportOf([{ title: 'a.spec.ts', specs: [{ title: 'x @screen:/help#Help', file: 'a.spec.ts', line: 1, tests: [{ status: 'expected' }] }] }]);
  withResults({ 'report.json': report, '.last-run.json': '{"status":"passed"}' }, (own) => {
    const result = linkTests(own, { screens: [{ id: '/help#Help' }] });
    assert.equal(result.nodes['/help#Help'].length, 1);
    assert.equal(result.untaggedCount, 0);
  });
});

test('a broken report names the file it could not read', () => {
  withResults({ 'broken.json': '{"suites": [' }, (own, dir) => {
    assert.throws(() => linkTests(own, { screens: [] }), (err) => err.message.includes(path.join(dir, 'results', 'broken.json')));
  });
});

const vitestReportOf = (assertionResults) => JSON.stringify({ numTotalTests: assertionResults.length, testResults: [{ name: '/work/app/a.test.js', status: 'passed', assertionResults }] });

test('Playwright and Vitest reports in one folder are each read only by their own format', () => {
  const playwright = reportOf([{ title: 'a.spec.ts', specs: [{ title: 'x @screen:/help#Help', file: 'a.spec.ts', line: 1, tests: [{ status: 'expected' }] }] }]);
  const vitest = vitestReportOf([{ ancestorTitles: [], title: 'y @screen:/help#Help', status: 'passed', tags: [] }]);
  withResults({ 'e2e.json': playwright, 'unit.json': vitest }, (own) => {
    const result = linkTests(own, { screens: [{ id: '/help#Help' }] });
    assert.deepEqual(result.nodes['/help#Help'].map((t) => `${t.format} ${t.source} ${t.line}`), ['playwright results/e2e.json 1', 'vitest results/unit.json null']);
    assert.equal(result.untaggedCount, 0);
  }, ['playwright', 'vitest']);
});

test('call IDs with colons, slashes and braces attach from every result format', () => {
  const id = 'GET:/api/v1/document/{documentId}';
  const files = {
    'e2e.json': reportOf([{ title: 'a.spec.ts', specs: [{ title: `x @call:${id}`, file: 'a.spec.ts', line: 1, tests: [{ status: 'expected' }] }] }]),
    'unit.json': vitestReportOf([{ ancestorTitles: [], title: 'y', status: 'passed', tags: [`@call:${id}`] }]),
    'TEST-c.xml': `<testsuite name="S"><testcase name="z @call:${id}" classname="c"/></testsuite>`,
    'checks.log': `VERDICT detail loads: UPHOLDS — ok @call:${id}\n`,
  };
  withResults(files, (own) => {
    const result = linkTests(own, { screens: [], calls: [{ id }] });
    assert.deepEqual(result.nodes[id].map((t) => t.format), ['playwright', 'vitest', 'junit', 'verdict']);
    assert.deepEqual(result.unknownTags, []);
  }, ['playwright', 'vitest', 'junit', 'verdict']);
});

test('a test whose only tag is a depth tag counts as untagged', () => {
  withResults({ 'unit.json': vitestReportOf([{ ancestorTitles: [], title: 'formats a date @depth:api', status: 'passed', tags: [] }]) }, (own) => {
    const result = linkTests(own, { screens: [] });
    assert.deepEqual(result.nodes, {});
    assert.equal(result.untaggedCount, 1);
    assert.deepEqual(result.unknownTags, []);
  }, ['vitest']);
});

test('numeric character references in JUnit names are decoded, so a tag before a line break still attaches', () => {
  const junit = '<testsuite name="S"><testcase name="it&#39;s open @screen:/help#Help&#10;second line" classname="c"/></testsuite>';
  withResults({ 'TEST-c.xml': junit }, (own) => {
    const [t] = linkTests(own, { screens: [{ id: '/help#Help' }] }).nodes['/help#Help'];
    assert.equal(t.title, "S › it's open @screen:/help#Help\nsecond line");
  }, ['junit']);
});

test('nested JUnit suites are read with their names joined into the title', () => {
  const junit = '<testsuites><testsuite name="Outer @screen:/help#Help"><testsuite name="Inner"><testcase name="x" classname="c"/></testsuite></testsuite></testsuites>';
  withResults({ 'TEST-c.xml': junit }, (own) => {
    const result = linkTests(own, { screens: [{ id: '/help#Help' }] });
    assert.deepEqual(result.nodes['/help#Help'].map((t) => t.title), ['Outer @screen:/help#Help › Inner › x']);
  }, ['junit']);
});

test('XML in a results folder that is not a JUnit report is skipped', () => {
  const junit = '<testsuite name="S"><testcase name="x @screen:/help#Help" classname="c"/></testsuite>';
  withResults({ 'TEST-c.xml': junit, 'pom.xml': '<project><name>x @screen:/help#Help</name></project>' }, (own) => {
    const result = linkTests(own, { screens: [{ id: '/help#Help' }] });
    assert.deepEqual(result.nodes['/help#Help'].map((t) => t.source), ['results/TEST-c.xml']);
  }, ['junit']);
});

test('a broken JUnit report names the file it could not read', () => {
  withResults({ 'broken.xml': '<testsuite><testcase name="x"></testsuite>' }, (own, dir) => {
    assert.throws(() => linkTests(own, { screens: [] }), (err) => err.message.includes(path.join(dir, 'results', 'broken.xml')));
  }, ['junit']);
});

test('a configured results path that does not exist yet is reported instead of stopping the rebuild', () => {
  const own = { ...config, tests: [{ format: 'playwright', path: path.join(config.configDir, 'results/not-run-yet'), depth: 'api' }] };
  const result = linkTests(own, { screens: [] });
  assert.deepEqual(result.missingSources, ['results/not-run-yet']);
  assert.deepEqual(result.nodes, {});
});

test('an unknown depth in the config is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ srcRoot: '.', serverEndpoints: [], tests: [{ format: 'playwright', path: 'r', depth: 'e2e' }] }));
    assert.throws(() => loadConfig(file), /unknown depth "e2e"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a @depth:output tag sets the output depth for one test', () => {
  const report = reportOf([{ title: 'a.spec.ts', specs: [{ title: 'exports the report @screen:/help#Help @depth:output', file: 'a.spec.ts', line: 1, tests: [{ status: 'expected' }] }] }]);
  withResults({ 'e2e.json': report }, (own) => {
    const result = linkTests(own, { screens: [{ id: '/help#Help' }] });
    assert.deepEqual(result.nodes['/help#Help'].map((t) => t.depth), ['output']);
    assert.deepEqual(result.unknownTags, []);
  });
});

const EXPORT = 'POST:/api/v1/report/export';
const ARCHIVE = 'POST:/api/v1/report/archive';
const optionsOf = (id) => links.nodes[id].map((t) => [t.line, t.options.map((o) => `${o.key}=${o.value}`).join(' ')]);

test('an @option tag attaches the test to that value of the option on its call', () => {
  assert.deepEqual(links.nodes[EXPORT][0].options, [{ key: 'withHistory', value: true }]);
  assert.equal(links.nodes[EXPORT][0].title, `exports with history @call:${EXPORT} @option:withHistory=true`);
});

test('a test with two @option tags carries both values, and a test without one carries none', () => {
  assert.deepEqual(optionsOf(EXPORT), [
    [3, 'withHistory=true'],
    [10, 'withAttachments=true withHistory=false'],
    [17, ''],
    [24, 'withHistory=true'],
    [31, ''],
  ]);
});

test('an @option tag attaches only to the calls of the same test that have that option', () => {
  assert.deepEqual(optionsOf(ARCHIVE), [[24, 'signedOnly=true withHistory=true']]);
  assert.equal(Object.hasOwn(links.nodes['/home#Home'][0], 'options'), false);
});

test('an @option tag with no call of its test to attach to is reported, and the test still counts as untagged without a node tag', () => {
  const report = reportOf([
    {
      title: 'a.spec.ts',
      specs: [
        { title: 'opens help @screen:/help#Help @option:withHistory=true', file: 'a.spec.ts', line: 1, tests: [{ status: 'expected' }] },
        { title: 'exports @option:withHistory=true', file: 'a.spec.ts', line: 5, tests: [{ status: 'expected' }] },
        { title: 'exports @call:POST:/gone @option:withHistory=false', file: 'a.spec.ts', line: 9, tests: [{ status: 'expected' }] },
        { title: 'exports @call:GET:/plain @option:withHistory=true', file: 'a.spec.ts', line: 13, tests: [{ status: 'expected' }] },
      ],
    },
  ]);
  withResults({ 'e2e.json': report }, (own) => {
    const result = linkTests(own, { screens: [{ id: '/help#Help' }], calls: [{ id: 'GET:/plain', options: [] }] });
    assert.deepEqual(result.unknownTags.map((u) => `${u.tag} ${u.test.line}`), [
      'option:withHistory=true 1',
      'option:withHistory=true 5',
      'option:withHistory=false 9',
      'call:POST:/gone 9',
      'option:withHistory=true 13',
    ]);
    assert.equal(result.untaggedCount, 1);
    assert.deepEqual(result.nodes['GET:/plain'].map((t) => t.options), [[]]);
  });
});

test('an @option tag whose value is not true or false, or that has no value, is reported', () => {
  const report = reportOf([
    {
      title: 'a.spec.ts',
      specs: [{ title: 'exports @call:GET:/x @option:withHistory=TRUE @option:withHistory @option:withHistory=false', file: 'a.spec.ts', line: 1, tests: [{ status: 'expected' }] }],
    },
  ]);
  withResults({ 'e2e.json': report }, (own) => {
    const result = linkTests(own, { screens: [], calls: [{ id: 'GET:/x', options: [{ key: 'withHistory' }] }] });
    assert.deepEqual(result.unknownTags.map((u) => u.tag), ['option:withHistory=TRUE', 'option:withHistory']);
    assert.deepEqual(result.nodes['GET:/x'][0].options, [{ key: 'withHistory', value: false }]);
  });
});

test('a test lists its option values for a call by key, whatever order its title gives the tags in', () => {
  const report = reportOf([
    {
      title: 'a.spec.ts',
      specs: [{ title: 'exports @call:GET:/x @option:withHistory=false @option:withAttachments=true', file: 'a.spec.ts', line: 1, tests: [{ status: 'expected' }] }],
    },
  ]);
  withResults({ 'e2e.json': report }, (own) => {
    const result = linkTests(own, { screens: [], calls: [{ id: 'GET:/x', options: [{ key: 'withHistory' }, { key: 'withAttachments' }] }] });
    assert.deepEqual(result.nodes['GET:/x'][0].options, [
      { key: 'withAttachments', value: true },
      { key: 'withHistory', value: false },
    ]);
  });
});

const storySummary = (id) => (links.stories[id] ?? []).map((t) => [t.format, t.project, t.depth, t.status].filter(Boolean).join(' '));

test('a test tagged with @story: is kept under that story ID with its depth and status, from every result format, whether or not a story file has the ID', () => {
  assert.deepEqual(Object.keys(links.stories).sort(), ['help-from-home', 'open-document', 'print-document', 'run-lab']);
  assert.deepEqual(storySummary('open-document'), ['playwright chromium ui pass']);
  assert.deepEqual(storySummary('run-lab'), ['junit api fail', 'verdict api pass']);
  assert.deepEqual(storySummary('help-from-home'), ['vitest code pending']);
  assert.deepEqual(storySummary('print-document'), ['playwright chromium ui pass']);
  const [open] = links.stories['open-document'];
  assert.equal(open.title, 'signs in and opens a document @story:open-document @screen:/document/:id#DocumentDetail');
  assert.equal(open.file, 'stories.spec.ts');
  assert.equal(open.line, 3);
  assert.equal(open.source, 'results/playwright/e2e.json');
});

test('a test tagged with a story and a screen counts on both sides', () => {
  const [open] = links.stories['open-document'];
  assert.ok(links.nodes['/document/:id#DocumentDetail'].some((t) => t.title === open.title && t.status === 'pass'));
});

test('a test whose tags only point at stories is not counted as untagged, and its story tags are not reported as tags outside the map', () => {
  const vitest = (title) => vitestReportOf([{ ancestorTitles: [], title, status: 'passed', tags: [] }]);
  withResults({ 'unit.json': vitest('goes on @story:open-document'), 'other.json': vitest('goes away @story:gone') }, (own) => {
    const result = linkTests(own, { screens: [] });
    assert.deepEqual(Object.keys(result.stories).sort(), ['gone', 'open-document']);
    assert.deepEqual(result.unknownTags, []);
    assert.equal(result.untaggedCount, 0);
    assert.deepEqual(result.nodes, {});
  }, ['vitest']);
});

test('story IDs that are names of object members are kept like any other story ID', () => {
  withResults({ 'checks.log': 'VERDICT odd ids: UPHOLDS — ok @story:constructor @story:__proto__ @story:toString @story:hasOwnProperty\n' }, (own) => {
    const result = linkTests(own, { screens: [] });
    assert.deepEqual(Object.keys(result.stories).sort(), ['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
    assert.deepEqual(Object.values(result.stories).map((tests) => tests.map((t) => t.title)), [['odd ids'], ['odd ids'], ['odd ids'], ['odd ids']]);
    assert.equal(JSON.parse(JSON.stringify(result)).stories.constructor.length, 1);
  }, ['verdict']);
});

test('a story tag repeated in one test attaches that test to the story once', () => {
  withResults({ 'checks.log': 'VERDICT twice: UPHOLDS — ok @story:open-document @story:open-document\n' }, (own) => {
    assert.deepEqual(linkTests(own, { screens: [] }).stories['open-document'].map((t) => t.title), ['twice']);
  }, ['verdict']);
});

test('every untagged test of the fixture is listed once, ordered by test file, line and title, and the count equals the list length', () => {
  assert.equal(links.untaggedCount, links.untagged.length);
  const row = (t) => `${t.format} ${t.testFile ?? t.file}:${t.line} ${t.title}`;
  assert.deepEqual(links.untagged.map(row), [
    'vitest /builds/client/src/components/Gone.spec.js:2 keeps the old menu',
    'vitest /work/app/src/home/home.test.js:20 formats a date @depth:api',
    'junit com.example.document.DocumentServiceTest:null Document service › sends the share mail',
    'vitest components/DocumentDetail.spec.js:1 loads the detail screen only when it is needed',
    'vitest components/DocumentTable.spec.js:6 DocumentTable › lists the documents it is given',
    'vitest components/Help.spec.js:4 renders the help text',
    'vitest components/Help.spec.js:8 shows the day the help was last updated',
    'vitest components/formatDate.spec.js:3 formats a date as year-month-day',
    'verdict document-checks.log:14 cleanup',
    'verdict document-checks.log:15 teardown',
    'playwright home.spec.ts:32 loads without errors @smoke',
    'verdict storage-checks.txt:10 orphan files',
    'vitest store/settings.spec.js:3 the lab is off by default',
  ]);
});

test('an untagged list entry carries its result source, status and, for a Vitest test found under srcRoot, the test file', () => {
  const byTitle = (title) => links.untagged.find((t) => t.title === title);
  assert.deepEqual(byTitle('DocumentTable › lists the documents it is given'), {
    title: 'DocumentTable › lists the documents it is given',
    file: '/builds/client/src/components/DocumentTable.spec.js',
    line: 6,
    source: 'results/vitest/client-unit.json',
    format: 'vitest',
    status: 'fail',
    testFile: 'components/DocumentTable.spec.js',
  });
  assert.equal('testFile' in byTitle('keeps the old menu'), false);
});

test('an untagged test that ran in two projects is listed once, with the worst status of its runs', () => {
  const run = (projectName, status) => ({ projectName, status });
  const spec = (title, line, runs) => ({ title, file: 'a.spec.ts', line, tests: runs });
  const report = reportOf([
    {
      title: 'a.spec.ts',
      specs: [
        spec('passes then fails', 1, [run('chromium', 'expected'), run('firefox', 'unexpected')]),
        spec('fails then passes', 2, [run('chromium', 'unexpected'), run('firefox', 'expected')]),
        spec('passes then waits', 3, [run('chromium', 'expected'), run('firefox', 'skipped')]),
        spec('waits then fails', 4, [run('chromium', 'skipped'), run('firefox', 'unexpected')]),
        spec('passes twice', 5, [run('chromium', 'expected'), run('firefox', 'expected')]),
      ],
    },
  ]);
  withResults({ 'e2e.json': report }, (own) => {
    const result = linkTests(own, { screens: [] });
    assert.equal(result.untaggedCount, 5);
    assert.deepEqual(result.untagged.map((t) => [t.title, t.status]), [
      ['passes then fails', 'fail'],
      ['fails then passes', 'fail'],
      ['passes then waits', 'pending'],
      ['waits then fails', 'fail'],
      ['passes twice', 'pass'],
    ]);
  });
});

test('the untagged list is ordered by the test file the page shows, not by the path of the machine that ran the tests', () => {
  const vitestFiles = JSON.stringify({
    testResults: [
      { name: '/z/client/src/components/Help.spec.js', assertionResults: [{ ancestorTitles: [], title: 'renders the help text', status: 'passed', location: { line: 4, column: 1 } }] },
      { name: '/a/client/src/store/settings.spec.js', assertionResults: [{ ancestorTitles: [], title: 'the lab is off by default', status: 'passed', location: { line: 3, column: 1 } }] },
    ],
  });
  withResults({ 'unit.json': vitestFiles }, (own) => {
    const result = linkTests(own, { screens: [] });
    assert.deepEqual(result.untagged.map((t) => t.testFile), ['components/Help.spec.js', 'store/settings.spec.js']);
  }, ['vitest']);
});

const traced = { ...config, tests: [...config.tests, { format: 'playwright', path: path.join(path.dirname(FIXTURE_CONFIG), 'results/playwright-traced'), depth: 'ui' }] };
const tracedLinks = linkTests(traced, await buildMap(traced));
const passedAt = (id) => tracedLinks.passed[id].map((t) => `${t.level} ${t.title}`);

test('a browser test is linked to each screen it opened with the highest of what it did there: opening, acting or checking', () => {
  assert.deepEqual(passedAt('/help#Help'), [
    'visit opens home and then help',
    'assert follows a link while waiting for the new address',
    'interact hovers and uses the keyboard on help',
    'interact uses the mouse right after the address changes',
    'interact clicks a button that appears after the address changes',
    'interact moves the mouse and turns the wheel on help',
  ]);
  assert.ok(passedAt('/home#Home').includes('interact presses the button on home'));
  assert.ok(passedAt('/home#Home').includes('visit opens home and then help'));
});

test('an address with a value in it or a query after it is linked to the screen of its route', () => {
  assert.deepEqual(passedAt('/document/:id#DocumentDetail'), ['assert checks the path of a document']);
  assert.ok(passedAt('/home#Home').includes('interact presses the button on home'));
});

test('a passed test carries its place, its result file, its project, its depth and its status', () => {
  const [t] = tracedLinks.passed['/document/:id#DocumentDetail'];
  assert.deepEqual(t, { title: 'checks the path of a document', file: 'visits.spec.ts', line: t.line, project: 'chromium', source: 'results/playwright-traced/visits.json', format: 'playwright', depth: 'ui', status: 'pass', level: 'assert' });
  assert.equal(typeof t.line, 'number');
});

test('a test already tagged with a screen is not among the tests that passed through it, and an address off the map is linked to nothing', () => {
  assert.equal(passedAt('/home#Home').some((t) => t.includes('home shows its path')), false);
  assert.ok(tracedLinks.nodes['/home#Home'].some((t) => t.title.startsWith('home shows its path')));
  assert.equal(Object.values(tracedLinks.passed).flat().some((t) => t.title === 'wanders off the map'), false);
});

test('tests that passed through a screen leave the tests of the screens, the untagged list of the other results and the screens with tests as they were', () => {
  const covered = (l) => Object.keys(l.nodes).filter((id) => !id.includes(':/')).sort();
  assert.deepEqual(covered(tracedLinks), covered(links));
  for (const id of Object.keys(links.nodes)) {
    const own = (l) => l.nodes[id].filter((t) => !t.source.startsWith('results/playwright-traced/'));
    assert.deepEqual(own(tracedLinks), own(links), id);
  }
  assert.deepEqual(links.passed, {});
  assert.deepEqual(links.traceNotices, []);
});

test('a trace that cannot be read is noticed with its file and the reason, and a browser test that ran without a trace is only counted', () => {
  assert.deepEqual(tracedLinks.traceNotices, [
    { file: 'results/playwright-traced/test-results/no-snapshots-presses-the-button-without-snapshots-chromium/trace.zip', test: { title: 'presses the button without snapshots', file: 'no-snapshots.spec.ts', line: 5 }, reason: 'trace 파일에 화면 스냅숏이 없어 테스트가 연 주소를 알 수 없습니다' },
  ]);
  const untraced = (l) => l.untracedCount;
  assert.equal(untraced(tracedLinks) - untraced(links), 1);
});

test('browser tests that were skipped are not counted as run without a trace, and the tests of other formats never are', () => {
  const all = ['e2e.json', 'export.json', 'screen-cases.json'].flatMap((file) => readPlaywright(path.join(path.dirname(FIXTURE_CONFIG), 'results/playwright', file)));
  const ran = all.filter((t) => t.status !== 'pending');
  assert.ok(ran.length < all.length);
  assert.equal(links.untracedCount, ran.length);
});

test('a browser test is linked to each call it sent a request for, whatever value or query the address carries and with or without a page', () => {
  assert.deepEqual(passedAt('GET:/api/v1/document/{documentId}'), ['call reads a document from the server']);
  assert.deepEqual(passedAt('GET:/api/v1/document/list'), ['call lists the documents']);
  assert.deepEqual(passedAt('GET:/api/v1/lab/experiment'), ['call asks for the experiment without opening a page']);
  assert.equal(passedAt('GET:/api/v1/member/list')[0], 'call turns the pages of the member list');
  const [t] = tracedLinks.passed['GET:/api/v1/document/{documentId}'];
  assert.deepEqual(t, { title: 'reads a document from the server', file: 'calls.spec.ts', line: t.line, project: 'chromium', source: 'results/playwright-traced/calls.json', format: 'playwright', depth: 'ui', status: 'pass', level: 'call' });
});

test('a request with another method than the call, or for a path no call has, links the test to no call', () => {
  const callPairs = Object.values(tracedLinks.passed).flat().filter((t) => t.level === 'call').map((t) => t.title);
  assert.equal(callPairs.includes('renames a document with the wrong method'), false);
  assert.equal(tracedLinks.passed['PUT:/api/v1/document/{documentId}/name'], undefined);
  assert.equal(callPairs.includes('presses the button on home'), false);
  assert.ok(passedAt('/home#Home').includes('visit renames a document with the wrong method'));
});

test('a test already tagged with a call is not among the tests that sent it, stays among those of the other calls it sent, and the tests of the call are as the tags say', () => {
  const tagged = 'lists the documents and the members @call:GET:/api/v1/document/list';
  assert.equal(passedAt('GET:/api/v1/document/list').some((t) => t.includes(tagged)), false);
  assert.deepEqual(passedAt('GET:/api/v1/member/list'), ['call turns the pages of the member list', `call ${tagged}`]);
  assert.deepEqual(tracedLinks.nodes['GET:/api/v1/document/list'].map((t) => t.title), [tagged]);
  assert.equal(tracedLinks.nodes['GET:/api/v1/member/list'], links.nodes['GET:/api/v1/member/list']);
});

test('a browser test whose trace was read carries the addresses it opened that fit no screen, tagged or not, and one whose trace was not read carries no such list', () => {
  const untagged = (title) => tracedLinks.untagged.find((t) => t.title === title);
  assert.deepEqual(untagged('wanders off the map').unmatched, ['http://127.0.0.1:4598/nowhere']);
  assert.deepEqual(untagged('opens home and then help').unmatched, []);
  assert.deepEqual(untagged('checks the path of a document').unmatched, []);
  assert.match(untagged('opens the app from a file').unmatched.join(' '), /^file:\/\/\S+\/build\/index\.html$/);
  assert.equal('unmatched' in untagged('presses the button without snapshots'), false);
  assert.equal('unmatched' in untagged('opens help without a trace'), false);
  assert.equal(links.untagged.some((t) => 'unmatched' in t), false);
  assert.deepEqual(tracedLinks.nodes['/home#Home'].find((t) => t.title.startsWith('home shows its path')).unmatched, []);
  assert.equal(links.nodes['/home#Home'].some((t) => 'unmatched' in t), false);
});

test('the tests that passed through the screens come out in the same order every time', async () => {
  const again = linkTests(traced, await buildMap(traced));
  assert.deepEqual(again.passed, tracedLinks.passed);
  assert.deepEqual(Object.keys(again.passed), Object.keys(tracedLinks.passed));
});

