import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapFitnessLine } from '../src/map-fitness.ts';
import type { Walks } from '../src/trace-links.ts';

const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const TRACED = path.join(import.meta.dirname, 'fixtures/app/results/playwright-traced');
const NOT_FIT = 'map not yet fit for story candidates or test matching: ';

const screen = (routePath: string, name: string) => ({ id: `${routePath}#${name}`, path: routePath });
const SHELF_MAP = { screens: [screen('/shelf', 'Shelf'), screen('/docs/*', 'Docs'), screen('*', 'Lost')] };
const opens = (...lines: { path: string; screen?: string }[]): Walks => ({ run: { '': [...lines.map((l) => ({ kind: 'open' as const, ...l })), { kind: 'press' as const, path: '/shelf' }] } });

test('the line counts the addresses opened by browser tests and visit records that reached only a catch-all screen or no screen, a visit record address once while it stays the same, and prints from half of them up', () => {
  const walks = opens({ path: '/nowhere', screen: '*#Lost' }, { path: '/gone' });
  assert.equal(mapFitnessLine(SHELF_MAP, walks, [['/shelf', '/shelf', '/void']]), `${NOT_FIT}3 of 4 addresses opened by browser tests and visit records reached only a catch-all screen or no screen`);
  assert.equal(mapFitnessLine(SHELF_MAP, opens({ path: '/shelf', screen: '/shelf#Shelf' }, { path: '/void', screen: '*#Lost' }), []), `${NOT_FIT}1 of 2 addresses opened by browser tests and visit records reached only a catch-all screen or no screen`);
  assert.equal(mapFitnessLine(SHELF_MAP, opens({ path: '/void', screen: '*#Lost' }), [['/shelf', '/docs/intro']]), null);
  assert.equal(mapFitnessLine(SHELF_MAP, {}, []), null);
});

test('a visit record address that reached no screen counts on a map without a catch-all, and an address the record leaves and comes back to counts again', () => {
  const noCatchAll = { screens: [screen('/shelf', 'Shelf'), screen('/docs/*', 'Docs')] };
  assert.equal(mapFitnessLine(noCatchAll, {}, [['/nowhere', '/shelf']]), `${NOT_FIT}1 of 2 addresses opened by browser tests and visit records reached only a catch-all screen or no screen`);
  assert.equal(mapFitnessLine(SHELF_MAP, {}, [['/void', '/shelf', '/void']]), `${NOT_FIT}2 of 3 addresses opened by browser tests and visit records reached only a catch-all screen or no screen`);
});

test('a screen whose path is * or /* is a catch-all, and one whose path ends in * after a path is not', () => {
  const rooted = { screens: [screen('/shelf', 'Shelf'), screen('/*', 'Lost')] };
  assert.match(mapFitnessLine(rooted, opens({ path: '/a', screen: '/*#Lost' }), [])!, /1 of 1 addresses/);
  assert.equal(mapFitnessLine(SHELF_MAP, opens({ path: '/docs/a', screen: '/docs/*#Docs' }, { path: '/docs/b', screen: '/docs/*#Docs' }), []), null);
});

test('the line also counts the screens whose path is relative or starts with the unknown marker, with or without opened addresses, from half of the screens up, and names both counts when both are reached', () => {
  const unread = { screens: [screen('/shelf', 'Shelf'), screen('shelf/:id', 'Item'), screen('{?}/recent', 'Recent'), screen('*', 'Lost')] };
  assert.equal(mapFitnessLine(unread, {}, []), `${NOT_FIT}2 of 4 screen paths are relative or start with {?}`);
  assert.equal(mapFitnessLine(unread, opens({ path: '/shelf', screen: '/shelf#Shelf' }), []), `${NOT_FIT}2 of 4 screen paths are relative or start with {?}`);
  assert.equal(mapFitnessLine(unread, opens({ path: '/x', screen: '*#Lost' }), []), `${NOT_FIT}1 of 1 addresses opened by browser tests and visit records reached only a catch-all screen or no screen; 2 of 4 screen paths are relative or start with {?}`);
  assert.equal(mapFitnessLine({ screens: [...unread.screens, screen('/a', 'A')] }, {}, []), null);
});

const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const page = (name: string) => `export default function ${name}() {\n  return <main>${name}</main>;\n}\n`;
const ROUTES = `import { Route, Routes } from 'react-router-dom';
import Shelf from './Shelf';
import Lost from './Lost';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/shelf" element={<Shelf />} />
      <Route path="*" element={<Lost />} />
    </Routes>
  );
}
`;

function rebuildApp(records: Record<string, string[]>, keys: Record<string, unknown> = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  fs.cpSync(TRACED, path.join(copy, 'traced'), { recursive: true });
  for (const [rel, text] of Object.entries({ 'Routes.js': ROUTES, 'Shelf.js': page('Shelf'), 'Lost.js': page('Lost') })) fs.writeFileSync(path.join(copy, rel), text);
  fs.mkdirSync(path.join(copy, 'visits'));
  for (const [name, urls] of Object.entries(records)) fs.writeFileSync(path.join(copy, 'visits', `${name}.json`), JSON.stringify(urls.map((url) => ({ url }))));
  const configFile = path.join(copy, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ srcRoot: '.', routesFile: 'Routes.js', routeElements: ['Route'], apiModules: [], settingsRoots: [], serverEndpoints: [], outDir: 'out', visitRecords: ['visits'], ...keys }));
  return execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
}

test('rebuild prints the line when half of the addresses visit records opened reached only a catch-all screen, and not when fewer did', () => {
  const lost = rebuildApp({ lost: ['/nowhere', '/elsewhere/2'], shelf: ['/shelf'] });
  assert.match(lost, /^map not yet fit for story candidates or test matching: 2 of 3 addresses opened by browser tests and visit records reached only a catch-all screen or no screen$/m);
  const found = rebuildApp({ lost: ['/nowhere'], shelf: ['/shelf', '/shelf?page=2'], again: ['/shelf'] });
  assert.doesNotMatch(found, /not yet fit/);
});

test('rebuild counts the addresses browser tests opened, and a trace whose screens are all catch-alls gives no story candidate and is counted on its own in the candidate line', () => {
  const stdout = rebuildApp({}, { tests: [{ format: 'playwright', path: 'traced', depth: 'ui' }] });
  assert.match(stdout, /^map not yet fit for story candidates or test matching: 32 of 32 addresses opened by browser tests and visit records reached only a catch-all screen or no screen$/m);
  assert.match(stdout, /^story candidates 0 \| from traces 0 \| traces only on a catch-all 25 \| newly stored 0 \| files skipped 0$/m);
});

test('README says what the line and the catch-all count mean, the usage guide says to stop before story and test work when the line appears, and docs/decisions.md says what the counts were weighed against', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8').replace(/\s+/g, ' ');
  const readme = read('README.md');
  assert.match(readme, /`map not yet fit for story candidates or test matching: <what>` — printed by `rebuild`[^]*?`\/docs\/\*` is not a catch-all[^]*?`N of M screen paths are relative or start with \{\?\}`/);
  assert.match(readme, /`traces only on a catch-all N`, only when N is not 0/);
  assert.match(readme, /A test whose screens are all catch-alls \(a route whose path is `\*` or `\/\*`\) gives no candidate/);
  const skill = read('skills/duru/SKILL.md');
  assert.match(skill, /`map not yet fit for story candidates or test matching`[^]*?Stop before any story or test work, tell the user the line as printed/);
  const decisions = read('docs/decisions.md');
  assert.match(decisions, /not yet fit for story candidates or test matching[^]*?share of entry screens[^]*?did not move with the fix[^]*?rest on that one failing app[^]*?`candidateSkipScreens` with `"where": "any"`[^]*?Known limits: a route whose first segment is only a parameter/);
});
