import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const RECORDER = path.join(import.meta.dirname, '../recorders/cypress.js');
const APP = 'http://localhost:3000';
const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');

type Move = { visit: string } | { pushState: string };
type FakeTest = { titles: string[]; moves: Move[]; state?: 'passed' | 'failed'; attempts?: FakeTest[] };
type Hook = (this: { currentTest: unknown }) => void;

type Options = { settings?: Record<string, string>; before16?: boolean; recorder?: boolean };

function runSpec(projectRoot: string, spec: string, tests: FakeTest[], { settings = {}, before16 = false, recorder = true }: Options = {}) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((fn) => fn(...args));
  const before: Hook[] = [];
  const after: Hook[] = [];
  const fakeCypress = {
    on: (event: string, fn: (...args: unknown[]) => void) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
    ...(before16 ? { env: (key: string) => settings[key] } : {
      expose: (key: string) => settings[key],
      env: () => {
        throw new Error('`Cypress.env()` was removed in Cypress version 16.0.0.');
      },
    }),
    spec: { name: path.basename(spec), relative: spec, absolute: path.join(projectRoot, spec) },
  };
  const cy = {
    writeFile: (file: string, contents: unknown) => {
      const target = path.resolve(projectRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
    },
  };
  if (recorder) {
    vm.runInNewContext(fs.readFileSync(RECORDER, 'utf8'), {
      Cypress: fakeCypress, cy, beforeEach: (fn: Hook) => before.push(fn), afterEach: (fn: Hook) => after.push(fn),
    });
  }
  for (const t of tests) {
    for (const attempt of t.attempts ?? [t]) {
      const currentTest = { title: t.titles.at(-1), titlePath: () => t.titles, fullTitle: () => t.titles.join(' '), state: undefined as string | undefined };
      emit('url:changed', 'about:blank');
      before.forEach((fn) => fn.call({ currentTest }));
      for (const move of attempt.moves) {
        if ('visit' in move) {
          emit('window:before:load');
          emit('url:changed', APP + move.visit);
          emit('window:load');
        } else emit('url:changed', APP + move.pushState);
      }
      currentTest.state = attempt.state ?? 'passed';
      after.forEach((fn) => fn.call({ currentTest }));
    }
  }
}

function withProject(fn: (dir: string, configFile: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, dir, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const configFile = path.join(dir, 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ ...config, visitRecords: ['cypress/visits'] }));
    fn(dir, configFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const rebuild = (configFile: string) => execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
const storedCandidates = (dir: string) => {
  const folder = path.join(dir, 'out/stories/candidates');
  return fs.readdirSync(folder).map((f) => JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')));
};
const filesUnder = (dir: string) => (fs.existsSync(dir) ? (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.json')).sort() : []);

test('a Cypress test with the recorder that passes three screens gives, after rebuild, a candidate with those screens in that order, named after the test', () => {
  withProject((dir, configFile) => {
    runSpec(dir, 'cypress/e2e/help.cy.js', [
      { titles: ['help', 'signs in and opens help @screen:/help#Help'], moves: [{ visit: '/signin' }, { visit: '/home' }, { visit: '/help' }] },
    ]);
    assert.match(rebuild(configFile), /^story candidates 1 \| from traces 0 \| newly stored 1 \| files skipped 0$/m);
    assert.deepEqual(storedCandidates(dir).map((c) => [c.name, c.screens, c.source]), [[
      'help -- signs in and opens help',
      ['/signin#SignIn', '/home#Home', '/help#Help'],
      { record: 'cypress/visits/cypress/e2e/help.cy.js/help -- signs in and opens help.json', steps: [1, 3] },
    ]]);
  });
});

test('moves a single page app makes with pushState alone, after one visit, are steps of the record and screens of the candidate', () => {
  withProject((dir, configFile) => {
    runSpec(dir, 'cypress/e2e/documents.cy.js', [
      { titles: ['opens a draft'], moves: [{ visit: '/home' }, { pushState: '/home?tab=recent' }, { pushState: '/document/draft' }, { pushState: '/document/42' }] },
    ]);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'cypress/visits/cypress/e2e/documents.cy.js/opens a draft.json'), 'utf8'));
    assert.deepEqual(record, { steps: ['/home', '/home?tab=recent', '/document/draft', '/document/42'].map((p) => ({ url: APP + p })) });
    rebuild(configFile);
    assert.deepEqual(storedCandidates(dir).map((c) => c.screens), [['/home#Home', '/document/:tab#DocumentList', '/document/:id#DocumentDetail']]);
  });
});

test('the recorder writes nothing for a failed test or one that opened no page, and writes the attempt that passed for a test passed on a retry', () => {
  withProject((dir) => {
    runSpec(dir, 'cypress/e2e/mixed.cy.js', [
      { titles: ['fails'], moves: [{ visit: '/home' }, { pushState: '/help' }], state: 'failed' },
      { titles: ['opens nothing'], moves: [] },
      { titles: ['passes on a retry'], moves: [], attempts: [
        { titles: [], moves: [{ visit: '/home' }, { pushState: '/lab' }], state: 'failed' },
        { titles: [], moves: [{ visit: '/home' }, { pushState: '/help' }] },
      ] },
    ]);
    assert.deepEqual(filesUnder(path.join(dir, 'cypress/visits')), [path.join('cypress/e2e/mixed.cy.js', 'passes on a retry.json')]);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'cypress/visits/cypress/e2e/mixed.cy.js/passes on a retry.json'), 'utf8'));
    assert.deepEqual(record.steps.map((s: { url: string }) => s.url), [APP + '/home', APP + '/help']);
  });
});

test('the recorder writes into the folder duruVisitRecords names, read with Cypress.expose from Cypress 16 on and with Cypress.env before it', () => {
  for (const before16 of [false, true]) {
    withProject((dir) => {
      runSpec(dir, 'cypress/e2e/help.cy.js', [{ titles: ['opens help'], moves: [{ visit: '/home' }, { pushState: '/help' }] }], { settings: { duruVisitRecords: 'qa/records' }, before16 });
      assert.deepEqual(filesUnder(path.join(dir, 'cypress/visits')), []);
      assert.deepEqual(filesUnder(path.join(dir, 'qa/records')), [path.join('cypress/e2e/help.cy.js', 'opens help.json')]);
    });
  }
});

test('a title with characters a file name cannot hold is written under a name with them replaced', () => {
  withProject((dir) => {
    runSpec(dir, 'cypress/e2e/odd.cy.js', [{ titles: ['a/b: c?', 'd*e'], moves: [{ visit: '/home' }, { pushState: '/help' }] }]);
    assert.deepEqual(filesUnder(path.join(dir, 'cypress/visits')), [path.join('cypress/e2e/odd.cy.js', 'a-b- c- -- d-e.json')]);
  });
});
