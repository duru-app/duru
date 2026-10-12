import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locatePart } from '../src/parts.ts';

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

const at = (node: string, key: object) => locatePart({ node, part: { kind: 'test', key } as never }, { tests: TESTS });

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
