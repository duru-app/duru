import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { buildMap } from '../src/map.mjs';
import { linkTests } from '../src/test-links.mjs';

const FIXTURE_CONFIG = path.join(import.meta.dirname, 'fixtures/app/config.json');
const config = loadConfig(FIXTURE_CONFIG);
const links = linkTests(config, await buildMap(config));
const summary = (id, format = 'playwright') =>
  (links.nodes[id] ?? []).filter((t) => t.format === format).map((t) => [t.project, t.depth, t.status].filter(Boolean).join(' '));

test('a tagged Playwright test attaches to its screen with the configured depth and its status', () => {
  assert.deepEqual(summary('/home#Home'), ['chromium ui pass', 'firefox ui pass']);
  assert.deepEqual(summary('/admin/member#AdminMember'), ['chromium ui fail']);
  const [home] = links.nodes['/home#Home'];
  assert.equal(home.title, 'shows the document list @screen:/home#Home');
  assert.equal(home.file, 'home.spec.ts');
  assert.equal(home.line, 3);
  assert.equal(home.source, 'results/playwright/e2e.json');
});

test('a skipped test is pending', () => {
  assert.deepEqual(summary('/lab#Lab'), ['chromium ui pending']);
});

test('a test tagged with two screens attaches to both', () => {
  assert.deepEqual(summary('/signin#SignIn'), ['chromium ui pass']);
  assert.deepEqual(summary('/help#Help'), ['chromium ui pass']);
});

test('tags pointing outside the map and tests without a node tag are reported separately, once per test across projects', () => {
  assert.deepEqual(
    links.unknownTags.map((u) => `${u.tag} ${u.test.file}:${u.test.line}`),
    [
      'screen:/settings#Settings home.spec.ts:26',
      'call:DELETE:/api/v1/document/{documentId} document.spec.ts:12',
      'option:signedOnly=true export.spec.ts:31',
      'option:withHistory=yes export.spec.ts:31',
      'depth:e2e com.example.help.HelpServiceTest:null',
    ],
  );
  assert.equal(links.untaggedCount, 6);
  assert.equal(Object.keys(links.nodes).includes('/settings#Settings'), false);
  assert.deepEqual(links.missingSources, []);
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
    ['playwright ui', 'playwright ui', 'junit api', 'junit data', 'junit api', 'vitest code', 'vitest render'],
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
