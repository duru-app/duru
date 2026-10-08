import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import { linkTests } from '../src/test-links.ts';
import { readVerdicts } from '../src/verdict.ts';

const FIXTURE_CONFIG = path.join(import.meta.dirname, 'fixtures/app/config.json');
const config = loadConfig(FIXTURE_CONFIG);
const map = await buildMap(config);
const links = linkTests(config, map);
const LIST = '/document/:tab_draft_done_#DocumentList';
const DETAIL = '/document/:id#DocumentDetail';
const verdicts = Object.values(links.nodes).flat().filter((t) => t.format === 'verdict');
const byTitle = (title) => verdicts.find((t) => t.title === title);

test('every word in the verdict table maps to its status and keeps the description after the em dash', () => {
  const rows = [
    ['list paging', 'pass', 'page size stays at 20 on every tab'],
    ['empty form save', 'pass', 'saving an empty form shows a validation message'],
    ['detail reload', 'pass', 'reload keeps the open tab'],
    ['duplicate submit', 'fail', 'a second click creates a second draft'],
    ['title length', 'fail', 'titles over 200 characters are cut without a warning'],
    ['sort by date', 'fail', 'sorting ignores the time of day'],
    ['attachment preview', 'fail', 'the preview opens blank'],
    ['export', 'fail', 'the exported file is empty'],
    ['upload timeout', 'pending', 'the timer did not fire within the wait window'],
    ['old versions', 'pending', 'versions older than a day are dropped by design'],
    ['first page load', 'pending', 'only the first page was reached'],
    ['bulk import', 'pending', '3 of 5 files imported'],
  ];
  assert.deepEqual(
    rows.map(([title]) => [title, byTitle(title)?.status, byTitle(title)?.detail]),
    rows,
  );
});

test('a word outside the table is pending and keeps the whole text after the colon', () => {
  assert.deepEqual(
    ['BATCH', 'row growth', 'quota check'].map((title) => [byTitle(title).status, byTitle(title).detail]),
    [
      ['pending', 'part-a REPRODUCES(quadratic) · part-b linear'],
      ['pending', 'REPRODUCES(quadratic) — time doubles with each row'],
      ['pending', 'SKIPPED — no quota configured'],
    ],
  );
});

test('a verdict without an em dash has no description', () => {
  for (const title of ['thumbnail cache', 'storage size']) {
    assert.equal(byTitle(title).status, 'pass');
    assert.equal('detail' in byTitle(title), false);
  }
});

test('the verdicts of one script attach separately to the nodes they name', () => {
  const lines = (id) => links.nodes[id].filter((t) => t.file === 'document-checks.log').map((t) => t.line);
  assert.deepEqual(lines(LIST), [3, 9, 11, 12]);
  assert.deepEqual(lines(DETAIL), [4, 5, 7, 8, 10]);
  assert.deepEqual(byTitle('empty form save'), {
    title: 'empty form save',
    file: 'document-checks.log',
    line: 4,
    project: null,
    source: 'results/verdict/documents/document-checks.log',
    format: 'verdict',
    depth: 'api',
    status: 'pass',
    detail: 'saving an empty form shows a validation message',
  });
});

test('depth comes from the config entry of each script folder', () => {
  assert.deepEqual(
    [...new Set(verdicts.map((t) => `${path.dirname(t.source)} ${t.depth}`))].sort(),
    ['results/verdict/documents api', 'results/verdict/storage data'],
  );
});

test('each untagged verdict line counts as an untagged test, and other files in the folder are not read', () => {
  const own = { ...config, tests: config.tests.filter((t) => t.format === 'verdict') };
  const result = linkTests(own, map);
  assert.equal(result.untaggedCount, 3);
  assert.equal(result.unknownTags.length, 0);
  assert.equal(verdicts.some((t) => t.source.endsWith('README.md')), false);
});

test('untagged verdicts in logs of the same name in different folders are counted separately', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    for (const sub of ['a', 'b']) {
      fs.mkdirSync(path.join(dir, sub));
      fs.writeFileSync(path.join(dir, sub, 'checks.log'), 'VERDICT cleanup: HEALTHY\n');
    }
    const tests = ['a', 'b'].map((sub) => ({ format: 'verdict', path: path.join(dir, sub), depth: 'api' }));
    assert.equal(linkTests({ ...config, configDir: dir, tests }, { screens: [] }).untaggedCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withLog(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    const file = path.join(dir, 'checks.log');
    fs.writeFileSync(file, body);
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('tags lose their @ and every tag after the colon is returned, including depth tags', () => {
  withLog('VERDICT a: FIXED — mail user@example.com @screen:/home#Home @depth:ui\n', (file) => {
    const [v] = readVerdicts(file);
    assert.deepEqual(v.tags, ['screen:/home#Home', 'depth:ui']);
    assert.equal(v.detail, 'mail user@example.com');
  });
});

test('a log without verdict lines gives no tests, and a line with no colon is a pending verdict', () => {
  withLog('build ok\r\nVERDICTS follow\r\n', (file) => assert.deepEqual(readVerdicts(file), []));
  withLog('VERDICT half written\n', (file) => {
    assert.deepEqual(readVerdicts(file), [{ title: 'half written', file: 'checks.log', line: 1, project: null, tags: [], status: 'pending' }]);
  });
});

test('extra spaces around the name are not part of the title', () => {
  withLog('VERDICT  spaced name : FIXED\n', (file) => assert.equal(readVerdicts(file)[0].title, 'spaced name'));
});

test('a log that cannot be read names the file', () => {
  const file = path.join(os.tmpdir(), 'duru-missing', 'checks.log');
  assert.throws(() => readVerdicts(file), (err) => err.message.includes(file));
});
