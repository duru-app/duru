import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callFinder } from '../src/address-match.ts';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/ts-app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const CALLED = {
  calledApiModules: ['contracts/api/index.ts'],
  requestFunction: { import: './contracts/api/request', name: 'executeRequest', method: '0.endpoint.method', url: '0.url' },
  serverEndpoints: 'contract-server-endpoints.txt',
};

function fixtureCopy(keys: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(copy, 'client/src', rel), text);
  const configFile = path.join(copy, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.routesFile.push('contracts/ContractRoutes.tsx');
  fs.writeFileSync(configFile, JSON.stringify({ ...config, ...keys }, null, 2));
  return configFile;
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
let calledMap: Promise<ScreenMap> | undefined;
const called = () => (calledMap ??= build(fixtureCopy(CALLED)));
const screen = (map: ScreenMap, id: string) => map.screens.find((s) => s.id === id)!;
const endpointsOf = (map: ScreenMap, name: string) => map.apiFunctions[name].endpoints.map((e) => [e.method, e.url, e.server.status, e.callId]);

test('a method of an API class, given the request function and the address tables in its constructor, comes out as the request it sends with the prefix the app adds, whether it names the table by two names or passes a cell of it', async () => {
  const map = await called();
  assert.deepEqual(endpointsOf(map, 'contractApi.loadList'), [
    ['GET', '/internal/v2/workspace/{?}/contract/list', 'match', 'GET:/internal/v2/workspace/{workspaceId}/contract/list'],
  ]);
  assert.deepEqual(endpointsOf(map, 'contractApi.loadDetail'), [
    ['GET', '/internal/v2/workspace/{?}/contract/{?}', 'match', 'GET:/internal/v2/workspace/{workspaceId}/contract/{contractId}'],
  ]);
  assert.deepEqual(
    [map.apiFunctions['contractApi.loadList'].file, map.apiFunctions['contractApi.loadList'].line],
    ['contracts/api/contract.api.ts', 34],
  );
});

test('a method sending two requests gives both, a method whose prefix depends on a value it is given gives the prefix of the fake value, and an API exported as a function is called the same way', async () => {
  const map = await called();
  assert.deepEqual(endpointsOf(map, 'contractApi.archiveAndReload').map(([method, url]) => `${method} ${url}`), [
    'POST /internal/v2/workspace/{?}/contract/{?}/archive',
    'GET /internal/v2/workspace/{?}/contract/list',
  ]);
  assert.deepEqual(endpointsOf(map, 'contractApi.loadParticipant'), [
    ['GET', '/workflow/view/participant/{?}', 'match', 'GET:/workflow/view/participant/{contractId}'],
  ]);
  assert.deepEqual(endpointsOf(map, 'fetchNotices'), [['GET', '/internal/v2/notice/list', 'match', 'GET:/internal/v2/notice/list']]);
});

test('the calls of an API object attach to the screen whose sources call its methods, through a named import or a namespace import', async () => {
  const map = await called();
  const callsOf = (id: string) => screen(map, id).apiCalls.map((c) => [c.fn, c.file, c.line, (c.endpoints ?? []).map((e) => e.callId)]);
  assert.deepEqual(callsOf('/contracts#Contracts'), [
    ['contractApi.loadList', 'contracts/Contracts.tsx', 4, ['GET:/internal/v2/workspace/{workspaceId}/contract/list']],
    ['contractApi.archiveAndReload', 'contracts/Contracts.tsx', 5, ['POST:/internal/v2/workspace/{workspaceId}/contract/{contractId}/archive', 'GET:/internal/v2/workspace/{workspaceId}/contract/list']],
    ['fetchNotices', 'contracts/Contracts.tsx', 7, ['GET:/internal/v2/notice/list']],
  ]);
  assert.deepEqual(callsOf('/contracts/:contractId#ContractDetail'), [
    ['contractApi.loadDetail', 'contracts/ContractDetail.tsx', 4, ['GET:/internal/v2/workspace/{workspaceId}/contract/{contractId}']],
    ['contractApi.loadParticipant', 'contracts/ContractDetail.tsx', 5, ['GET:/workflow/view/participant/{contractId}']],
    ['contractApi.exportContract', 'contracts/ContractDetail.tsx', 6, []],
  ]);
  assert.deepEqual(map.calls.find((c) => c.id === 'GET:/internal/v2/workspace/{workspaceId}/contract/list')!.screens, ['/contract-board#ContractBoard', '/contracts#Contracts']);
});

const sitesOf = (map: ScreenMap, id: string) => screen(map, id).apiCalls.map((c) => [c.fn, c.file, c.line]);

test('two screens importing the same hook file get only the calls of the hooks each of them uses, with the file and line of each call', async () => {
  const map = await called();
  assert.deepEqual(sitesOf(map, '/contract-board#ContractBoard'), [
    ['contractApi.loadList', 'contracts/queries/contract.queries.ts', 7],
    ['contractApi.archiveAndReload', 'contracts/queries/contract.queries.ts', 14],
  ]);
  assert.deepEqual(sitesOf(map, '/contract-summary#ContractSummary'), [
    ['contractApi.loadDetail', 'contracts/queries/contract.queries.ts', 11],
    ['fetchNotices', 'contracts/queries/contract.queries.ts', 17],
  ]);
  assert.deepEqual(map.calls.find((c) => c.id === 'GET:/internal/v2/notice/list')!.screens, ['/contract-summary#ContractSummary', '/contracts#Contracts']);
});

test('a hook a function-making function returns brings the calls of the function given to it, and an API function handed over as a value counts as called', async () => {
  const map = await called();
  const archive = screen(map, '/contract-board#ContractBoard').apiCalls.find((c) => c.fn === 'contractApi.archiveAndReload')!;
  assert.deepEqual(archive.endpoints!.map((e) => e.callId), ['POST:/internal/v2/workspace/{workspaceId}/contract/{contractId}/archive', 'GET:/internal/v2/workspace/{workspaceId}/contract/list']);
  const notices = screen(map, '/contract-summary#ContractSummary').apiCalls.find((c) => c.fn === 'fetchNotices')!;
  assert.deepEqual(notices.endpoints!.map((e) => e.callId), ['GET:/internal/v2/notice/list']);
});

test('an API object imported through a file that re-exports it is joined to its methods where the screen calls them', async () => {
  const map = await called();
  assert.deepEqual(sitesOf(map, '/notes#Notes'), [['noteApi.loadNotes', 'contracts/Notes.tsx', 4]]);
  assert.deepEqual(screen(map, '/notes#Notes').apiCalls[0].endpoints!.map((e) => e.url), ['{?}/internal/v2/note/list']);
});

test('the static methods of an exported class, its own and those it takes from the classes above it, are called as API functions and joined where a screen calls them, while private ones, classes kept in static fields and the methods of its instances are not, and they are called after the other exports so a static setter does not change their addresses', async () => {
  const userApi = [
    "import { executeRequest } from './request';",
    '',
    'class BaseApi {',
    '  static get(url: string) {',
    "    return executeRequest({ endpoint: { method: 'GET', path: '' }, url });",
    '  }',
    '}',
    '',
    'export class UserApi extends BaseApi {',
    '  static fetchUser(id: string) {',
    '    return BaseApi.get(`/users/${id}`);',
    '  }',
    '  private static secret() {',
    "    return BaseApi.get('/secret');",
    '  }',
    '  load() {',
    "    return BaseApi.get('/instance');",
    '  }',
    '}',
    '',
    'export default class ProfileApi extends UserApi {}',
    '',
    'export class Http {',
    "  static base = '/api';",
    '  static Failure = class extends Error {};',
    '  static setBase(url: string) {',
    '    Http.base = url;',
    '  }',
    '}',
    '',
    "export const http = { list: () => executeRequest({ endpoint: { method: 'GET', path: '' }, url: `${Http.base}/list` }) };",
    '',
  ].join('\n');
  const map = await build(fixtureCopy(
    { ...CALLED, calledApiModules: ['contracts/api/user.api.ts', ...CALLED.calledApiModules] },
    {
      'contracts/api/user.api.ts': userApi,
      'contracts/Notes.tsx': "import { UserApi } from './api/user.api';\n\nexport default function Notes() {\n  return <main onLoad={() => UserApi.fetchUser('u1')} />;\n}\n",
    },
  ));
  const sent = Object.entries(map.apiFunctions).filter(([, f]) => f.file === 'contracts/api/user.api.ts').map(([name, f]) => [name, f.line, f.endpoints.map((e) => `${e.method} ${e.url}`)]);
  assert.deepEqual(sent, [
    ['http.list', 31, ['GET /api/list']],
    ['Http.setBase', 26, []],
    ['UserApi.fetchUser', 10, ['GET /users/{?}']],
    ['UserApi.get', 4, ['GET {?}']],
    ['default.fetchUser', 10, ['GET /users/{?}']],
    ['default.get', 4, ['GET {?}']],
  ]);
  assert.deepEqual(sitesOf(map, '/notes#Notes'), [['UserApi.fetchUser', 'contracts/Notes.tsx', 4]]);
});

test('a file that re-exports an imported API function makes no call of it, but a constant holding it that the file itself hands over does', async () => {
  const map = await build(fixtureCopy(CALLED, {
    'contracts/shared/index.ts': "import { fetchNotices } from '../api';\nexport { noteApi } from '../api';\nexport { fetchNotices };\nconst notices = fetchNotices;\nexport const load = () => [notices];\n",
    'contracts/Notes.tsx': "import { noteApi, load } from './shared';\n\nexport default function Notes() {\n  return <main onLoad={() => [noteApi.loadNotes(), load()]} />;\n}\n",
  }));
  assert.deepEqual(sitesOf(map, '/notes#Notes'), [['noteApi.loadNotes', 'contracts/Notes.tsx', 4], ['fetchNotices', 'contracts/shared/index.ts', 4]]);
});

test('an API object or function re-exported as the default or under a constant of another name is joined where the screen calls it', async () => {
  const map = await build(fixtureCopy(CALLED, {
    'contracts/shared/index.ts': "import { noteApi, fetchNotices } from '../api';\nexport default noteApi;\nexport const notices = fetchNotices;\n",
    'contracts/Notes.tsx': "import notes, { notices } from './shared';\n\nexport default function Notes() {\n  return <main onLoad={() => [notes.loadNotes(), notices()]} />;\n}\n",
  }));
  assert.deepEqual(sitesOf(map, '/notes#Notes'), [['noteApi.loadNotes', 'contracts/Notes.tsx', 4], ['fetchNotices', 'contracts/Notes.tsx', 4]]);
});

test('a call at the top level of an imported file attaches to the screen even when the screen uses none of its names', async () => {
  const map = await build(fixtureCopy(CALLED, {
    'contracts/shared/index.ts': "import { noteApi } from '../api';\nexport const x = 1;\nnoteApi.loadNotes();\n",
    'contracts/Notes.tsx': "import { x } from './shared';\n\nexport default function Notes() {\n  return <main />;\n}\n",
  }));
  assert.deepEqual(sitesOf(map, '/notes#Notes'), [['noteApi.loadNotes', 'contracts/shared/index.ts', 3]]);
});

test('a file whose names are used in a way that cannot be followed brings all of its calls', async () => {
  const map = await build(fixtureCopy(CALLED, {
    'contracts/ContractSummary.tsx': "import * as queries from './queries/contract.queries';\n\nconst hooks = Object.values(queries);\n\nexport default function ContractSummary() {\n  return <main>{hooks.length}</main>;\n}\n",
  }));
  assert.deepEqual(sitesOf(map, '/contract-summary#ContractSummary').map(([fn, , line]) => [fn, line]), [
    ['contractApi.loadList', 7],
    ['contractApi.loadDetail', 11],
    ['contractApi.archiveAndReload', 14],
    ['fetchNotices', 17],
  ]);
});

test('a method that sends nothing for the first fake value is tried with the next, and a piece of an address coming from an outside package without a stand-in, imported by name or by default, is a variable piece', async () => {
  const map = await called();
  assert.deepEqual(endpointsOf(map, 'contractApi.loadSigned').map(([method, url]) => `${method} ${url}`), ['GET /internal/v2/workspace/{?}/contract/{?}/signed']);
  assert.deepEqual(endpointsOf(map, 'contractApi.loadByDay').map(([method, url]) => `${method} ${url}`), ['GET /internal/v2/workspace/{?}/contract/day/{?}']);
  assert.deepEqual(endpointsOf(map, 'contractApi.loadReports').map(([method, url]) => `${method} ${url}`), ['GET {?}/report/list']);
});

test('a public method a subclass declares over a protected one is called while the protected ones are not, a value a method that sends nothing stores turns into a variable piece in a later address, and a loop as long as a value it is given ends at once', async () => {
  const map = await called();
  const urls = (name: string) => endpointsOf(map, name).map(([method, url]) => `${method} ${url}`);
  assert.deepEqual(Object.keys(map.apiFunctions).filter((name) => name.startsWith('noteApi.')), ['noteApi.search', 'noteApi.setBase', 'noteApi.loadNotes', 'noteApi.loadNumbered', 'noteApi.fetchItems', 'noteApi.sendForever', 'noteApi.fetchPages', 'noteApi.removeNotes', 'noteApi.tagNotes']);
  assert.deepEqual(urls('noteApi.search'), ['GET /internal/v2/note/search?q={?}']);
  assert.deepEqual(urls('noteApi.loadNotes'), ['GET {?}/internal/v2/note/list']);
  assert.deepEqual(urls('noteApi.fetchPages'), ['GET /internal/v2/note/page/0']);
});

test('a method that sends only for a number gets a number below 1, so a loop up to it runs once, and an attempt sending more than 20 requests is dropped', async () => {
  const map = await called();
  assert.deepEqual(endpointsOf(map, 'noteApi.loadNumbered').map(([method, url]) => `${method} ${url}`), ['GET /internal/v2/note/{?}']);
  assert.deepEqual(endpointsOf(map, 'noteApi.fetchItems').map(([method, url]) => `${method} ${url}`), ['GET /internal/v2/note/item/0']);
  assert.deepEqual(map.apiFunctions['noteApi.sendForever'], { file: 'contracts/api/note.api.ts', line: 44, endpoints: [], error: 'sent more than 20 requests' });
});

test('a method sending one request for each id in a set made from the fake value sends one request, not one for each of its letters, while a set made from any other text still holds its letters', async () => {
  const map = await called();
  assert.deepEqual(endpointsOf(map, 'noteApi.removeNotes').map(([method, url]) => `${method} ${url}`), ['POST /internal/v2/note/{?}/delete']);
  assert.deepEqual(endpointsOf(map, 'noteApi.tagNotes').map(([method, url]) => `${method} ${url}`), ['POST /internal/v2/note/tag/a', 'POST /internal/v2/note/tag/b']);
});

test('a method checking that its address values are strings or numbers while it uses `in` and an array method on the body it is given gets strings only for the keys named like an id, and sends its request', async () => {
  const map = await called();
  assert.deepEqual(map.apiFunctions['contractApi.updateTerms'], {
    file: 'contracts/api/contract.api.ts',
    line: 83,
    endpoints: [{ method: 'POST', url: '/internal/v2/workspace/{?}/contract/{?}/update', line: 83, server: { status: 'none' }, callId: 'POST:/internal/v2/workspace/{?}/contract/{?}/update' }],
    inputs: { sent: [['0', 'workspaceId'], ['0', 'contractId']], spread: [] },
  });
});

test('an API function named like an apiModules function keeps the file in front of its name and leaves the apiModules function as it was', async () => {
  const map = await called();
  assert.deepEqual(endpointsOf(map, 'contracts/api/index.ts#ajaxReportSchedule').map(([method, url]) => `${method} ${url}`), ['POST /internal/v2/report/schedule']);
  assert.deepEqual(endpointsOf(map, 'ajaxReportSchedule').map(([method, url]) => `${method} ${url}`), ['POST /api/v1/report/schedule']);
});

test('a request a browser test recorded with the prefix and real values finds the call of the method that sends it', async () => {
  const find = callFinder(await called());
  assert.equal(find('GET', 'http://localhost:5173/internal/v2/workspace/w7/contract/list?page=2'), 'GET:/internal/v2/workspace/{workspaceId}/contract/list');
  assert.equal(find('POST', 'http://localhost:5173/internal/v2/workspace/w7/contract/c9/archive'), 'POST:/internal/v2/workspace/{workspaceId}/contract/{contractId}/archive');
  assert.equal(find('GET', 'http://localhost:5173/internal/v2/workspace/w7/contract/c9/archive'), null);
});

test('a method failing on the fake value or never finishing, asynchronously or in a loop, keeps its name, file and line and the first line of the error, a method sending no request is not called out, and private members, whether methods, bound methods or functions given to the constructor, are not called, and the outside package names no stand-in gives do not stop the run', async () => {
  const map = await called();
  const failed = Object.entries(map.apiFunctions).filter(([, f]) => f.error).map(([name, f]) => [name, `${f.file}:${f.line}`, f.error, f.endpoints.length]);
  assert.deepEqual(failed, [
    ['contractApi.exportContract', 'contracts/api/contract.api.ts:50', 'Unknown export format: {?}', 0],
    ['contractApi.waitForSigners', 'contracts/api/contract.api.ts:59', 'did not finish within 1000 ms', 0],
    ['contractApi.countSigners', 'contracts/api/contract.api.ts:63', 'did not finish within 1000 ms', 0],
    ['noteApi.sendForever', 'contracts/api/note.api.ts:44', 'sent more than 20 requests', 0],
  ]);
  assert.deepEqual(map.apiFunctions['contractApi.buildDownloadUrl'], { file: 'contracts/api/contract.api.ts', line: 55, endpoints: [] });
  assert.deepEqual(Object.keys(map.apiFunctions).filter((name) => /\.(run|onUnauthorized|send|tables)$/.test(name)), []);
  assert.deepEqual(map.unrunApiModules, []);
});

test('extract prints one line for each method that gave no address, and counts the called methods among the api functions', () => {
  const configFile = fixtureCopy(CALLED);
  const result = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^screens 15 \| api functions 25 \| endpoints match 6 /m);
  assert.deepEqual(result.stdout.split('\n').filter((l) => l.includes('api method')), [
    '  api method contractApi.exportContract ← contracts/api/contract.api.ts:50: Unknown export format: {?}',
    '  api method contractApi.waitForSigners ← contracts/api/contract.api.ts:59: did not finish within 1000 ms',
    '  api method contractApi.countSigners ← contracts/api/contract.api.ts:63: did not finish within 1000 ms',
    '  api method noteApi.sendForever ← contracts/api/note.api.ts:44: sent more than 20 requests',
  ]);
});

test('without the new keys, the screens of the example have the same links, setting reads and conditions, and the API object calls are not read', async () => {
  const [plain, map] = await Promise.all([build(fixtureCopy()), called()]);
  const shape = (m: ScreenMap) => m.screens.map((s) => [s.id, s.links, s.settingReads, s.access]);
  assert.deepEqual(shape(plain), shape(map));
  assert.deepEqual(screen(plain, '/contracts#Contracts').apiCalls, []);
  assert.deepEqual(Object.keys(plain.apiFunctions), ['ajaxReportArchive', 'ajaxReportSchedule']);
  assert.equal('unrunApiModules' in plain, false);
  assert.equal('callsOnNoScreen' in plain, false);
});

test('a listed file that fails to run is reported with the place of the error, and the methods of the other files still give their requests', async () => {
  const configFile = fixtureCopy(
    { ...CALLED, calledApiModules: ['contracts/api/broken.ts', ...CALLED.calledApiModules] },
    { 'contracts/api/broken.ts': "import { executeRequest } from './request';\n\nthrow new Error('no session');\nexport const brokenApi = { load: () => executeRequest({ endpoint: { method: 'GET', path: '' }, url: '/x' }) };\n" },
  );
  const map = await build(configFile);
  assert.deepEqual(map.unrunApiModules, [{ file: 'contracts/api/broken.ts', error: `${path.join(path.dirname(configFile), 'client/src/contracts/api/broken.ts')}:3: no session` }]);
  assert.equal(map.apiFunctions['contractApi.loadList'].endpoints.length, 1);
});

test('a file that a listed file reaches by import, directly or through `export *`, and that holds JSX or a decorator is run as a stand-in, so the listed file still gives its requests, and a listed file with a decorator of its own is reported', async () => {
  const send = (name: string, url: string) => `export const ${name} = { load: () => executeRequest({ endpoint: { method: 'GET', path: '' }, url: '${url}' }) };\n`;
  const configFile = fixtureCopy(
    { ...CALLED, calledApiModules: ['contracts/api/drawn.ts', 'contracts/api/storedThrough.ts', 'contracts/api/decorated.ts', ...CALLED.calledApiModules] },
    {
      'contracts/api/icons.tsx': 'export interface Kind { name: string }\nexport const Icon = () => <svg><path /></svg>;\nexport const { Badge, sizes: [Small] } = { Badge: () => <>{Icon()}</>, sizes: [16] };\n',
      'contracts/api/ui.ts': "export * from './icons';\nexport * from './kinds';\n",
      'contracts/api/kinds.ts': "export const Kind = { name: 'drawn' };\n",
      'contracts/api/drawn.ts': `import { executeRequest } from './request';\nimport { Icon, Kind, Small } from './ui';\n\nconst icon = Icon(Small);\nexport const drawnApi = { load: () => executeRequest({ endpoint: { method: 'GET', path: '' }, url: '/' + Kind.name }) };\n`,
      'contracts/api/store.ts': 'const dec = (v: unknown) => v;\nexport class Store {\n  @dec count = 0;\n}\n',
      'contracts/api/stores.ts': "export { Store } from './store';\n",
      'contracts/api/storedThrough.ts': `import { executeRequest } from './request';\nimport { Store } from './stores';\n\nconst store = new Store();\n${send('storedApi', '/stored')}`,
      'contracts/api/decorated.ts': `import { executeRequest } from './request';\n\nconst dec = (v: unknown) => v;\nexport class Own {\n  @dec count = 0;\n}\n${send('ownApi', '/own')}`,
    },
  );
  const map = await build(configFile);
  assert.deepEqual([endpointsOf(map, 'drawnApi.load'), endpointsOf(map, 'storedApi.load')].map((e) => e.map(([method, url]) => `${method} ${url}`)), [['GET /drawn'], ['GET /stored']]);
  const error = `calledApiModules: ${path.join(path.dirname(configFile), 'client/src/contracts/api/decorated.ts')}:5:3: a decorator is not JavaScript that Node runs, so duru cannot run this file`;
  assert.deepEqual(map.unrunApiModules, [{ file: 'contracts/api/decorated.ts', error }]);
  assert.equal(map.apiFunctions['contractApi.loadList'].endpoints.length, 1);
});

test('a listed file that calls require() for a package, reads process.env.NODE_ENV or uses self runs, as does one that calls require() for a file of the app only in a function it does not run, and one that runs such a call is reported with the line', async () => {
  const send = (name: string, url: string) => `export const ${name} = { load: () => executeRequest({ endpoint: { method: 'GET', path: '' }, url: \`${url}\` }) };\n`;
  const configFile = fixtureCopy(
    { ...CALLED, calledApiModules: ['contracts/api/required.ts', 'contracts/api/local.ts', 'contracts/api/later.ts', ...CALLED.calledApiModules] },
    {
      'contracts/api/paths.ts': "const { match } = require('path-to-regexp');\nexport const matcher = match('/x');\nexport const mode = process.env.NODE_ENV.slice(0, 4);\nexport const later = self.setTimeout;\n",
      'contracts/api/required.ts': `import { executeRequest } from './request';\nimport { mode } from './paths';\n\n${send('requiredApi', '/required/${mode}')}`,
      'contracts/api/local.ts': `import { executeRequest } from './request'\nconst base = '/local'\nrequire('./endpoints')\n${send('localApi', '/local')}`,
      'contracts/api/later.ts': `import { executeRequest } from './request';\n\nfunction devtools() {\n  require('./endpoints').debug = true;\n  const { endpointTables } = require('./endpoints');\n  return endpointTables;\n}\n${send('laterApi', '/later')}`,
    },
  );
  const map = await build(configFile);
  assert.deepEqual([endpointsOf(map, 'requiredApi.load'), endpointsOf(map, 'laterApi.load')].map((e) => e.map(([method, url]) => `${method} ${url}`)), [['GET /required/prod'], ['GET /later']]);
  const error = `${path.join(path.dirname(configFile), 'client/src/contracts/api/local.ts')}:3: \`require(…)\` of a file of the app is CommonJS, which duru cannot run as an ES module`;
  assert.deepEqual(map.unrunApiModules, [{ file: 'contracts/api/local.ts', error }]);
});

test('a file of the app that sets module.exports, imported by default from a listed file, gives that value, so the listed file runs and gives its requests', async () => {
  const configFile = fixtureCopy(
    { ...CALLED, calledApiModules: ['contracts/api/events.ts', ...CALLED.calledApiModules] },
    {
      'contracts/api/eventPaths.js': "const prefix = '/events';\n\nmodule.exports = {\n  list: prefix + '/list',\n};\n",
      'contracts/api/events.ts': "import { executeRequest } from './request';\nimport eventPaths from './eventPaths';\n\nexport const eventApi = { load: () => executeRequest({ endpoint: { method: 'GET', path: '' }, url: eventPaths.list }) };\n",
    },
  );
  const map = await build(configFile);
  assert.deepEqual(endpointsOf(map, 'eventApi.load').map(([method, url]) => `${method} ${url}`), ['GET /events/list']);
  assert.deepEqual(map.unrunApiModules, []);
});

const REMOTE_API = "import { executeRequest } from '../../../client/src/contracts/api/request';\nimport type * as Shapes from './shapes';\n\nexport { Shapes };\nexport class RemoteApi {\n  load() {\n    return executeRequest({ endpoint: { method: 'GET', path: '' }, url: '/remote' });\n  }\n}\n";
const remoteCopy = (keys: Record<string, unknown>, files: Record<string, string>) => {
  const configFile = fixtureCopy({ ...CALLED, ...keys }, files);
  const remote = path.join(path.dirname(configFile), 'packages/remote-api/src');
  fs.mkdirSync(remote, { recursive: true });
  fs.writeFileSync(path.join(remote, 'index.ts'), REMOTE_API);
  return configFile;
};

test('a package named in sourcePackages is read from its folder outside srcRoot, so an API class there runs and gives its requests, even when the package exports again a name imported only as a type', async () => {
  const configFile = remoteCopy(
    { calledApiModules: ['contracts/api/remote.ts', ...CALLED.calledApiModules], sourcePackages: { '@acme/remote-api': 'packages/remote-api/src' } },
    { 'contracts/api/remote.ts': "import { RemoteApi } from '@acme/remote-api';\n\nexport const remoteApi = new RemoteApi();\n" },
  );
  const map = await build(configFile);
  assert.deepEqual(endpointsOf(map, 'remoteApi.load').map(([method, url]) => `${method} ${url}`), ['GET /remote']);
  assert.equal('outsideStandIns' in map, false);
  assert.equal('unresolvedAliasImports' in map, false);
});

test('a package linked to a folder outside srcRoot, or an alias pointing outside srcRoot, that runs as a stand-in is reported with where it is and the files importing it, while a library an alias points at in node_modules is not', async () => {
  const configFile = remoteCopy(
    { calledApiModules: ['contracts/api/remote.ts', 'contracts/api/aliased.ts', ...CALLED.calledApiModules], tsconfig: 'client/tsconfig.json' },
    {
      'contracts/api/remote.ts': "import { RemoteApi } from '@acme/remote-api';\nimport pad from 'left-pad';\n\nexport const remoteApi = new RemoteApi(pad);\n",
      'contracts/api/aliased.ts': "import { RemoteApi } from '@remote/index';\n\nexport const aliasedApi = new RemoteApi();\n",
    },
  );
  const copy = path.dirname(configFile);
  fs.writeFileSync(path.join(copy, 'client/tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: 'src', paths: { '@remote/*': ['../../packages/remote-api/src/*'], '*': ['../../node_modules/*', '../../types/*'] } } }));
  fs.mkdirSync(path.join(copy, 'types'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'types/left-pad.d.ts'), 'export default function pad(s: string): string;\n');
  fs.mkdirSync(path.join(copy, 'node_modules/left-pad'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'node_modules/left-pad/index.js'), 'module.exports = (s) => s;\n');
  fs.mkdirSync(path.join(copy, 'node_modules/@acme'), { recursive: true });
  fs.symlinkSync(path.join(copy, 'packages/remote-api'), path.join(copy, 'node_modules/@acme/remote-api'));
  const map = await build(configFile);
  assert.deepEqual(map.outsideStandIns, [
    { spec: '@acme/remote-api', file: '../../packages/remote-api', importedBy: ['contracts/api/remote.ts'] },
    { spec: '@remote/index', file: '../../packages/remote-api/src/index.ts', importedBy: ['contracts/api/aliased.ts'] },
  ]);
  const result = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter((l) => l.includes('as a stand-in')), [
    '  calledApiModules ran @acme/remote-api as a stand-in, though it is ../../packages/remote-api outside srcRoot, imported by contracts/api/remote.ts',
    '  calledApiModules ran @remote/index as a stand-in, though it is ../../packages/remote-api/src/index.ts outside srcRoot, imported by contracts/api/aliased.ts',
  ]);
});

test('sourcePackages that is not an object of package names and folders, or names a folder that is not there, is refused', () => {
  assert.throws(() => loadConfig(fixtureCopy({ sourcePackages: ['packages'] })), /^Error: sourcePackages must map package names/);
  assert.throws(() => loadConfig(fixtureCopy({ sourcePackages: { 'not a name': 'packages' } })), /^Error: sourcePackages must map package names/);
  assert.throws(() => loadConfig(fixtureCopy({ sourcePackages: { '@acme/remote-api': 'packages/none' } })), /sourcePackages @acme\/remote-api: packages\/none is not a folder/);
});

const FETCHED_API = [
  'export const fetchedApi = {',
  '  load: (id: string) => fetch(`/fetched/${id}`).then((r) => r.json()),',
  "  save: (id: string) => fetch(`/fetched/${id}`, { method: 'PUT', body: JSON.stringify({ id }) }),",
  "  remove: () => fetch(new Request('http://localhost/fetched/all', { method: 'DELETE' })),",
  '  pass: (id: string, init?: RequestInit) => fetch(`/passed/${id}`, init),',
  '  inner: (id: string, options?: { method?: string }) => fetch(`/inner/${id}`, { headers: {}, method: options?.method }),',
  "  win: () => window.fetch('/window'),",
  '  fetch,',
  '};',
  '',
].join('\n');
const fetchedRequests = (map: ScreenMap) => ['load', 'save', 'remove', 'pass', 'inner', 'win'].map((m) => map.apiFunctions[`fetchedApi.${m}`].endpoints.map((e) => `${e.method} ${e.url}`));

test('a request a listed file sends with the global fetch is recorded with its method and address, with requestFunction or without it, and without requestFunction a listed file none of whose methods sent one is named, and a run where none sent one stops', async () => {
  const fetched = { 'contracts/api/fetched.ts': FETCHED_API };
  const both = await build(fixtureCopy({ ...CALLED, calledApiModules: ['contracts/api/fetched.ts', ...CALLED.calledApiModules] }, fetched));
  const sent = [['GET /fetched/{?}'], ['PUT /fetched/{?}'], ['DELETE /fetched/all'], ['GET /passed/{?}'], ['null /inner/{?}'], ['GET /window']];
  assert.deepEqual(fetchedRequests(both), sent);
  assert.equal('silentApiModules' in both, false);
  assert.equal('fetchedApi.fetch' in both.apiFunctions, false);
  assert.equal(both.apiFunctions['contractApi.loadList'].endpoints.length, 1);
  const alone = await build(fixtureCopy({ calledApiModules: ['contracts/api/fetched.ts'] }, fetched));
  assert.deepEqual(fetchedRequests(alone), sent);
  const mixedConfig = fixtureCopy({ calledApiModules: ['contracts/api/fetched.ts', ...CALLED.calledApiModules] }, fetched);
  assert.deepEqual((await build(mixedConfig)).silentApiModules, ['contracts/api/index.ts']);
  const reExported = fixtureCopy({ calledApiModules: ['contracts/api/fetched.ts', 'contracts/api/again.ts'] }, { ...fetched, 'contracts/api/again.ts': "export { fetchedApi } from './fetched';\n" });
  assert.equal('silentApiModules' in await build(reExported), false);
  await assert.rejects(build(fixtureCopy({ calledApiModules: CALLED.calledApiModules })), /calledApiModules has no requestFunction and no listed file sent a request with fetch or by moving the browser/);
  const broken = { 'contracts/api/broken.ts': "throw new Error('no session');\nexport const brokenApi = { load: () => fetch('/x') };\n" };
  await assert.rejects(build(fixtureCopy({ calledApiModules: ['contracts/api/broken.ts'] }, broken)), /no request was recorded.*; contracts\/api\/broken\.ts did not run: .*no session/);
  await assert.rejects(build(fixtureCopy({ calledApiModules: ['contracts/api/broken.ts', ...CALLED.calledApiModules] }, broken)), /no request was recorded.*; contracts\/api\/broken\.ts did not run: .*no session/);
  await assert.rejects(build(fixtureCopy({ calledApiModules: ['contracts/api/missing.ts', ...CALLED.calledApiModules] })), /no request was recorded.*; contracts\/api\/missing\.ts did not run/);
  const brokenAndSending = await build(fixtureCopy({ calledApiModules: ['contracts/api/broken.ts', 'contracts/api/fetched.ts'] }, { ...fetched, ...broken }));
  assert.deepEqual(brokenAndSending.unrunApiModules!.map((m) => m.file), ['contracts/api/broken.ts']);
  const result = spawnSync(process.execPath, [CLI, 'extract', mixedConfig], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter((l) => l.includes('recorded no request')), ['  calledApiModules contracts/api/index.ts recorded no request; without requestFunction only requests sent with fetch or by moving the browser are recorded']);
});

const NAVIGATED_API = [
  'export const navigatedApi = {',
  '  link: (id: string) => {',
  "    const link = document.createElement('a');",
  '    link.href = `http://localhost/files/${id}/download?name=all&token=secret`;',
  "    link.style.display = 'none';",
  '    document.body.appendChild(link);',
  '    link.click();',
  '    link.remove();',
  '  },',
  "  attribute: (id: string) => { const link = document.createElement('a'); link.setAttribute('href', `/files/${id}?access_token=t`); link.click(); },",
  '  opened: (id: string) => { window.open(`/opened/${id}?accessToken=t#top`); },',
  '  assigned: (id: string) => { window.location.href = `/assigned/${id}`; },',
  "  bareAssigned: () => { (globalThis as any).location = '/bare-assigned'; },",
  "  bare: () => { location.assign('/bare?token=t'); },",
  "  replaced: () => { (window as any).location = '/replaced'; },",
  "  blob: () => { const link = document.createElement('a'); link.href = 'blob:http://localhost/1'; link.click(); },",
  "  button: () => { const button = document.createElement('button'); button.setAttribute('href', '/button'); button.click(); },",
  "  saved: (url: string) => { const link = document.createElement('a'); link.href = url; link.click(); },",
  "  paged: () => { location.href = '?page=2'; },",
  "  fileUrl: (file: { url: string }) => { const link = document.createElement('a'); link.href = file.url; link.click(); },",
  '  destructured: ({ url }: { url: string }) => { window.open(url); },',
  "  based: (url: string) => { window.open('/api' + url); },",
  "  tabbed: () => { window.location.href = window.location.pathname + '?tab=2'; },",
  '  reloaded: () => { window.location.href = window.location.href; },',
  '  reopened: () => { window.open(window.location as any); },',
  '};',
  '',
].join('\n');

test('a link a listed method makes and clicks, window.open and an address given to location are recorded as GET requests to that address, without the query values whose name ends in token and without what follows #, and a blob address, an address that is only a query, an address whose path the arguments of the method or the current page decide, or a click on another element is not', async () => {
  const map = await build(fixtureCopy({ calledApiModules: ['contracts/api/navigated.ts'] }, { 'contracts/api/navigated.ts': NAVIGATED_API }));
  const requests = Object.fromEntries(Object.entries(map.apiFunctions).filter(([name]) => name.startsWith('navigatedApi.')).map(([name, f]) => [name, [f.endpoints.map((e) => `${e.method} ${e.url}`), f.error ?? null]]));
  assert.deepEqual(requests, {
    'navigatedApi.link': [['GET /files/{?}/download?name=all'], null],
    'navigatedApi.attribute': [['GET /files/{?}'], null],
    'navigatedApi.opened': [['GET /opened/{?}'], null],
    'navigatedApi.assigned': [['GET /assigned/{?}'], null],
    'navigatedApi.bareAssigned': [['GET /bare-assigned'], null],
    'navigatedApi.bare': [['GET /bare'], null],
    'navigatedApi.replaced': [['GET /replaced'], null],
    'navigatedApi.blob': [[], null],
    'navigatedApi.button': [[], null],
    'navigatedApi.saved': [[], null],
    'navigatedApi.paged': [[], null],
    'navigatedApi.fileUrl': [[], null],
    'navigatedApi.destructured': [[], null],
    'navigatedApi.based': [[], null],
    'navigatedApi.tabbed': [[], null],
    'navigatedApi.reloaded': [[], null],
    'navigatedApi.reopened': [[], null],
  });
});

test('a file in both API lists is refused, as is a place that is not a number followed by keys, or a relative import that names no file', async () => {
  const refused = (keys: Record<string, unknown>) => assert.throws(() => loadConfig(fixtureCopy(keys)));
  refused({ ...CALLED, calledApiModules: ['_ajax/AjaxFunc.ts'] });
  refused({ ...CALLED, requestFunction: { ...CALLED.requestFunction, url: 'url' } });
  refused({ ...CALLED, requestFunction: { ...CALLED.requestFunction, body: 'body' } });
  refused({ ...CALLED, requestFunction: { ...CALLED.requestFunction, headers: '0.headers' } });
  await assert.rejects(build(fixtureCopy({ ...CALLED, requestFunction: { ...CALLED.requestFunction, import: './contracts/api/missing' } })), /requestFunction\.import \.\/contracts\/api\/missing names no file/);
  await assert.rejects(build(fixtureCopy({ ...CALLED, requestFunction: { ...CALLED.requestFunction, import: '@/send' } })), /is imported by none of the files/);
});

test('the usage guide and the agent skill name the new keys and the lines extract prints for methods that gave no address', () => {
  const readme = fs.readFileSync(path.join(import.meta.dirname, '../README.md'), 'utf8');
  const skill = fs.readFileSync(path.join(import.meta.dirname, '../skills/duru/SKILL.md'), 'utf8');
  for (const text of ['`calledApiModules`', '`requestFunction`', '`api method <name> ← <file>:<line>: <error>`', '`calledApiModules <file> did not run']) {
    assert.ok(readme.includes(text), `README lacks ${text}`);
    assert.ok(skill.includes(text), `SKILL lacks ${text}`);
  }
  assert.ok(readme.includes('"requestFunction": { "import": "axios", "name": "default", "object": true }'), 'README lacks a request object example');
});

const INVOICES = { calledApiModules: ['invoices/api/index.ts'], serverEndpoints: 'invoice-server-endpoints.txt' };
const invoiceCopy = (requestFunction: unknown) => {
  const configFile = fixtureCopy({ ...INVOICES, requestFunction });
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.routesFile.push('invoices/InvoiceRoutes.tsx');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  return configFile;
};
const requestsOf = (map: ScreenMap) => Object.fromEntries(Object.entries(map.apiFunctions).filter(([name]) => !name.startsWith('ajax')).map(([name, f]) => [name, f.endpoints.map((e) => `${e.method} ${e.url}`)]));

test('API functions calling get, post, put, patch and delete of a request object made by a factory, the object itself or its request with a config, give their method and address, with the base address given to the factory or to the object a create came from in front, when the factory\'s package is the request object; a base address from the build environment is left out, and a method taken out of the object is not an API function', async () => {
  const map = await build(invoiceCopy({ import: 'axios', name: 'default', object: true }));
  assert.deepEqual(requestsOf(map), {
    'invoiceApi.list': ['GET /internal/v2/billing/invoices?page={?}'],
    'invoiceApi.detail': ['GET /internal/v2/billing/invoices/{?}'],
    'invoiceApi.create': ['POST /internal/v2/billing/invoices'],
    'invoiceApi.replace': ['PUT /internal/v2/billing/invoices/{?}'],
    'invoiceApi.rename': ['PATCH /internal/v2/billing/invoices/{?}'],
    'invoiceApi.remove': ['DELETE /internal/v2/billing/invoices/{?}'],
    fetchInvoiceSummary: ['GET /internal/v2/billing/invoices/summary'],
    'invoiceApi.send': ['POST /internal/v2/billing/invoices/{?}/send'],
    'invoiceApi.archive': ['POST /internal/v2/billing/invoices/{?}/archive'],
    'reportApi.monthly': ['GET /internal/v2/reports/monthly'],
    fetchAudit: ['GET /internal/v2/audit'],
    fetchRates: ['GET /internal/v2/rates'],
  });
  assert.ok(Object.values(map.apiFunctions).filter((f) => f.file?.startsWith('invoices/')).every((f) => f.endpoints.every((e) => e.server.status === 'match')));
  const callsOf = (id: string) => screen(map, id).apiCalls.map((c) => [c.fn, (c.endpoints ?? []).map((e) => e.callId)]);
  assert.deepEqual(callsOf('/invoices/:invoiceId#InvoiceDetail'), [
    ['invoiceApi.detail', ['GET:/internal/v2/billing/invoices/{invoiceId}']],
    ['invoiceApi.rename', ['PATCH:/internal/v2/billing/invoices/{invoiceId}']],
    ['invoiceApi.remove', ['DELETE:/internal/v2/billing/invoices/{invoiceId}']],
  ]);
  assert.deepEqual(map.unrunApiModules, []);
});

test('the same API functions give the addresses as they call them when the object the factory made is the request object, and a call through the package itself is then not recorded', async () => {
  const map = await build(invoiceCopy({ import: './invoices/api/http', name: 'http', object: true }));
  assert.deepEqual(requestsOf(map), {
    'invoiceApi.list': ['GET /invoices?page={?}'],
    'invoiceApi.detail': ['GET /invoices/{?}'],
    'invoiceApi.create': ['POST /invoices'],
    'invoiceApi.replace': ['PUT /invoices/{?}'],
    'invoiceApi.rename': ['PATCH /invoices/{?}'],
    'invoiceApi.remove': ['DELETE /invoices/{?}'],
    fetchInvoiceSummary: ['GET /invoices/summary'],
    'invoiceApi.send': ['POST /invoices/{?}/send'],
    'invoiceApi.archive': ['POST /invoices/{?}/archive'],
    'reportApi.monthly': [],
    fetchAudit: ['GET /internal/v2/audit'],
    fetchRates: [],
  });
  assert.deepEqual(map.unrunApiModules, []);
});

test('a base address given with one request goes in front of that request\'s address over the one given to create, an empty one puts none, one duru cannot know shows as unknown, and an absolute address, or a config that is an argument duru tried or a stand-in for a package, keeps the address as before', async () => {
  const module = [
    "import axios from 'axios';",
    "import { authConfig } from '@org/http-config';",
    "const plain = axios.create();",
    "const inst = axios.create({ baseURL: '/inst' });",
    'export const perRequestApi = {',
    "  get: () => plain.get('v1/x', { baseURL: '/api/' }),",
    "  delete: () => plain.delete('/x', { baseURL: '/api' }),",
    "  head: () => plain.head('/x', { baseURL: '/api' }),",
    "  options: () => plain.options('/x', { baseURL: '/api' }),",
    "  post: (body: object) => plain.post('/x', body, { baseURL: '/api/' }),",
    "  put: (body: object) => plain.put('/x', body, { baseURL: '/api' }),",
    "  patch: (body: object) => plain.patch('/x', body, { baseURL: '/api' }),",
    "  request: () => plain.request({ url: '/x', method: 'put', baseURL: '/api' }),",
    "  called: () => plain({ url: '/x', method: 'delete', baseURL: '/api' }),",
    "  calledWithUrl: () => plain('/x', { method: 'patch', baseURL: '/api' }),",
    "  over: () => inst.get('/x', { baseURL: '/req' }),",
    "  absolute: () => plain.get('https://h/x', { baseURL: '/api' }),",
    "  nullBase: () => inst.get('/x', { baseURL: null }),",
    "  falseBase: () => inst.get('/x', { baseURL: false }),",
    "  zeroBase: () => inst.get('/x', { baseURL: 0 }),",
    "  emptyBase: () => inst.get('/x', { baseURL: '' }),",
    "  notText: () => inst.get('/x', { baseURL: 3 }),",
    "  notConfig: () => inst.post('/x', { baseURL: '/data' }),",
    "  passedOn: (params: { page: unknown }) => {",
    "    if (typeof params.page !== 'string') throw new Error('page');",
    "    return inst.get('/x', params);",
    '  },',
    "  passedAsIs: (config: object) => inst.get('/x', config),",
    "  builtFrom: (params: { root: unknown }) => {",
    "    if (typeof params.root !== 'string') throw new Error('root');",
    "    return inst.get('/x', { baseURL: `${params.root}/v2` });",
    '  },',
    "  fromField: (params: { root: unknown }) => {",
    "    if (typeof params.root !== 'string') throw new Error('root');",
    "    return inst.get('/x', { baseURL: params.root });",
    '  },',
    "  fromDefaults: () => inst.get('/x', { baseURL: inst.defaults.baseURL }),",
    "  fromPackage: () => inst.get('/x', authConfig),",
    "  fromEnv: () => inst.get('/x', { baseURL: import.meta.env.VITE_API }),",
    "  none: () => inst.get('/x'),",
    '};',
    '',
  ].join('\n');
  const configFile = fixtureCopy({ calledApiModules: ['invoices/api/perRequest.ts'], requestFunction: { import: 'axios', name: 'default', object: true }, serverEndpoints: 'invoice-server-endpoints.txt' }, { 'invoices/api/perRequest.ts': module });
  assert.deepEqual(requestsOf(await build(configFile)), {
    'perRequestApi.get': ['GET /api/v1/x'],
    'perRequestApi.delete': ['DELETE /api/x'],
    'perRequestApi.head': ['HEAD /api/x'],
    'perRequestApi.options': ['OPTIONS /api/x'],
    'perRequestApi.post': ['POST /api/x'],
    'perRequestApi.put': ['PUT /api/x'],
    'perRequestApi.patch': ['PATCH /api/x'],
    'perRequestApi.request': ['PUT /api/x'],
    'perRequestApi.called': ['DELETE /api/x'],
    'perRequestApi.calledWithUrl': ['PATCH /api/x'],
    'perRequestApi.over': ['GET /req/x'],
    'perRequestApi.absolute': ['GET https://h/x'],
    'perRequestApi.nullBase': ['GET /x'],
    'perRequestApi.falseBase': ['GET /x'],
    'perRequestApi.zeroBase': ['GET /x'],
    'perRequestApi.emptyBase': ['GET /x'],
    'perRequestApi.notText': ['GET {?}/x'],
    'perRequestApi.notConfig': ['POST /inst/x'],
    'perRequestApi.passedOn': ['GET /inst/x'],
    'perRequestApi.passedAsIs': ['GET /inst/x'],
    'perRequestApi.builtFrom': ['GET {?}/v2/x'],
    'perRequestApi.fromField': ['GET {?}/x'],
    'perRequestApi.fromDefaults': ['GET {?}/x'],
    'perRequestApi.fromPackage': ['GET /inst/x'],
    'perRequestApi.fromEnv': ['GET {?}/x'],
    'perRequestApi.none': ['GET /inst/x'],
  });
});

test('a request object setting is refused when it also gives the places of the method or the address', () => {
  const refused = (requestFunction: unknown) => assert.throws(() => loadConfig(fixtureCopy({ ...INVOICES, requestFunction })), /"object": true/);
  refused({ import: 'axios', name: 'default', object: true, url: '0' });
  refused({ import: 'axios', name: 'default', object: true, method: '0.method' });
  refused({ import: 'axios', name: 'default', object: true, body: '1' });
  refused({ import: 'axios', name: 'default', object: 'yes' });
  refused({ import: 'axios', name: 'default' });
});

const APP = {
  files: 'build',
  server: 'http://localhost:8080',
  apiPaths: ['/internal/'],
  login: { path: '/auth/login', body: { id: '{id}', password: '{password}' }, token: 'token', storage: { key: 'auth', value: '{token}' } },
  account: { id: 'duru', passwordEnv: 'DURU_PASSWORD' },
};

const HOSTS_API = [
  "import axios from 'axios';",
  'export const hostApi = {',
  "  outside: () => axios.get('https://api.example.org/repos/acme/releases/latest'),",
  "  noScheme: () => axios.get('//cdn.example.org/internal/v2/rates'),",
  '  spacedOutside: (version: string) => axios.get(`',
  '      https://cms.example.org/api/changelogs?version=${version}&sort=asc',
  '    `),',
  '  spaced: () => axios.get(`',
  '      /internal/v2/rates',
  '    `),',
  "  server: () => axios.get('http://localhost:8080/internal/v2/rates'),",
  '  page: (id: string) => {',
  "    const link = document.createElement('a');",
  '    link.href = new URL(`/internal/v2/billing/invoices/${id}`, window.location.origin).toString();',
  '    link.click();',
  '  },',
  "  mailed: () => { const link = document.createElement('a'); link.href = ' \\n  mailto:team@example.org'; link.click(); },",
  '};',
  '',
].join('\n');
const HOSTS_AJAX = [
  'const request = async (info: unknown) => ({ info });',
  "export const ajaxOutside = async () => request({ METHOD: 'GET', URL: 'https://api.example.org/notes' });",
  "export const ajaxServer = async () => request({ METHOD: 'GET', URL: 'http://localhost:8080/internal/v2/rates' });",
  "export const ajaxSpaced = async () => request({ METHOD: 'GET', URL: '  /internal/v2/rates\\n' });",
  '',
].join('\n');

test('an address an API function sends to another host than the page or app.server keeps the host and is not read, so no call is made of it, while one on the page or on app.server is the path, and spaces and line breaks around an address are dropped as the browser drops them', async () => {
  const files = { 'invoices/api/hosts.ts': HOSTS_API, '_ajax/Hosts.ts': HOSTS_AJAX };
  const keys = { calledApiModules: ['invoices/api/hosts.ts'], apiModules: ['_ajax/AjaxFunc.ts', '_ajax/Hosts.ts'], requestFunction: { import: 'axios', name: 'default', object: true }, serverEndpoints: 'invoice-server-endpoints.txt' };
  const read = (map: ScreenMap) => Object.fromEntries(['hostApi.outside', 'hostApi.noScheme', 'hostApi.spacedOutside', 'hostApi.spaced', 'hostApi.server', 'hostApi.page', 'hostApi.mailed', 'ajaxOutside', 'ajaxServer', 'ajaxSpaced']
    .map((name) => [name, map.apiFunctions[name].endpoints.map((e) => [`${e.method} ${e.url}`, e.server.status === 'unresolved' ? e.server.reason : e.callId])]));
  const outside = {
    'hostApi.outside': [['GET https://api.example.org/repos/acme/releases/latest', 'other-host']],
    'hostApi.noScheme': [['GET //cdn.example.org/internal/v2/rates', 'other-host']],
    'hostApi.spacedOutside': [['GET https://cms.example.org/api/changelogs?version={?}&sort=asc', 'other-host']],
    'hostApi.spaced': [['GET /internal/v2/rates', 'GET:/internal/v2/rates']],
    'hostApi.page': [['GET /internal/v2/billing/invoices/{?}', 'GET:/internal/v2/billing/invoices/{invoiceId}']],
    'hostApi.mailed': [],
    ajaxOutside: [['GET https://api.example.org/notes', 'other-host']],
    ajaxSpaced: [['GET /internal/v2/rates', 'GET:/internal/v2/rates']],
  };
  const alone = await build(fixtureCopy(keys, files));
  assert.deepEqual(read(alone), {
    ...outside,
    'hostApi.server': [['GET http://localhost:8080/internal/v2/rates', 'other-host']],
    ajaxServer: [['GET http://localhost:8080/internal/v2/rates', 'other-host']],
  });
  const served = await build(fixtureCopy({ ...keys, app: APP }, files));
  assert.deepEqual(read(served), {
    ...outside,
    'hostApi.server': [['GET /internal/v2/rates', 'GET:/internal/v2/rates']],
    ajaxServer: [['GET /internal/v2/rates', 'GET:/internal/v2/rates']],
  });
  for (const map of [alone, served]) assert.deepEqual(map.calls.map((c) => c.id).filter((id) => /:\/\/|example\.org|\/_/.test(id)), []);
});

const CHANNEL_FETCHER = `export const request = ({ url, method, data }: { url: string; method: string; data?: unknown; signal?: unknown }) => fetch(url, { method, body: data === undefined ? undefined : JSON.stringify(data) });\n`;

const channelsApi = (from: string, hooks: string, names = '') => `import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, useSuspenseQuery${names} } from '${from}';
import type { QueryClient } from '${from}';
import { request } from './fetcher';

export const listChannels = (signal?: unknown) => request({ url: '/api/channels', method: 'GET', signal });
export const listChannelPage = (page: unknown) => request({ url: \`/api/channels?page=\${page}\`, method: 'GET' });
export const getChannel = (id: string) => request({ url: \`/api/channels/\${id}\`, method: 'GET' });
export const createChannel = (data: object) => request({ url: '/api/channels', method: 'POST', data });
export const listUsers = () => request({ url: '/api/users', method: 'GET' });
export const exportChannel = (format: string) => {
  if (!['csv', 'json'].includes(format)) throw new Error(\`Unknown export format: \${format}\`);
  return request({ url: \`/api/channels/export.\${format}\`, method: 'GET' });
};
export const getListChannelsQueryKey = () => ['/api/channels'];
export const invalidateListChannels = async (queryClient: QueryClient) => {
  await queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey() });
  return queryClient;
};
${hooks}`;

const OBJECT_NAMES = ', infiniteQueryOptions, mutationOptions, queryOptions, useSuspenseInfiniteQuery, useSuspenseQueries';
const OBJECT_HOOKS = `
export function useListChannels(options?: { query?: object }, queryClient?: QueryClient) {
  const queryKey = getListChannelsQueryKey();
  const query = useQuery({ queryKey, queryFn: ({ signal }: { signal?: unknown }) => listChannels(signal), ...options?.query }, queryClient) as { queryKey?: unknown };
  query.queryKey = queryKey;
  return query;
}
export const useGetChannel = (id: string) => useQuery(queryOptions({ queryKey: ['/api/channels', id], queryFn: () => getChannel(id) }));
export const useChannelSuspense = (id: string) => useSuspenseQuery({ queryKey: ['/api/channels', id], queryFn: () => getChannel(id) });
export const useChannelPages = () => useInfiniteQuery(infiniteQueryOptions({ queryKey: ['/api/channels', 'pages'], queryFn: ({ pageParam }: { pageParam: unknown }) => listChannelPage(pageParam), initialPageParam: 0, getNextPageParam: () => null }));
export const useCreateChannel = (queryClient?: QueryClient) => {
  const client = useQueryClient();
  return useMutation(mutationOptions({ mutationFn: (props: { data: object }) => createChannel(props.data), onSuccess: () => invalidateListChannels(client) }), queryClient);
};
export const useChannelsAndUsers = () => useQueries({ queries: [{ queryKey: ['/api/channels'], queryFn: () => listChannels() }, { queryKey: ['/api/users'], queryFn: () => listUsers() }] });
export const useExportChannel = (format: string) => useQuery({ queryKey: ['/api/channels/export', format], queryFn: async () => exportChannel(format) });
export const useChannelPagesSuspense = () => useSuspenseInfiniteQuery({ queryKey: ['/api/channels', 'pages'], queryFn: ({ pageParam }: { pageParam: unknown }) => listChannelPage(pageParam), initialPageParam: 0, getNextPageParam: () => null });
export const useChannelsAndUsersSuspense = () => useSuspenseQueries({ queries: [{ queryKey: ['/api/channels'], queryFn: () => listChannels() }, { queryKey: ['/api/users'], queryFn: () => listUsers() }] });
`;

const POSITIONAL_HOOKS = `
export function useListChannels(options?: object) {
  const queryKey = getListChannelsQueryKey();
  const query = useQuery(queryKey, ({ signal }: { signal?: unknown }) => listChannels(signal), options) as { queryKey?: unknown };
  query.queryKey = queryKey;
  return query;
}
export const useGetChannel = (id: string) => useQuery(['/api/channels', id], () => getChannel(id));
export const useChannelSuspense = (id: string) => useQuery(['/api/channels', id], () => getChannel(id), { suspense: true });
export const useChannelPages = () => useInfiniteQuery(['/api/channels', 'pages'], ({ pageParam }: { pageParam: unknown }) => listChannelPage(pageParam));
export const useCreateChannel = () => {
  const client = useQueryClient();
  return useMutation(['channels', 'create'], (props: { data: object }) => createChannel(props.data), { onSuccess: () => invalidateListChannels(client) });
};
export const useChannelsAndUsers = () => useQueries([{ queryKey: ['/api/channels'], queryFn: () => listChannels() }, { queryKey: ['/api/users'], queryFn: () => listUsers() }]);
export const useExportChannel = (format: string) => useQuery(['/api/channels/export', format], async () => exportChannel(format));
`;

const channelsCopy = (from: string, hooks: string, names: string, keys: Record<string, unknown> = {}) => fixtureCopy(
  { calledApiModules: ['contracts/api/channels.ts'], ...keys },
  { 'contracts/api/fetcher.ts': CHANNEL_FETCHER, 'contracts/api/channels.ts': channelsApi(from, hooks, names) },
);
const channelRequests = (map: ScreenMap) => Object.fromEntries(Object.entries(map.apiFunctions).filter(([name]) => !name.startsWith('ajax')).map(([name, f]) => [name, f.endpoints.map((e) => `${e.method} ${e.url}`)]));
const CHANNEL_REQUESTS = {
  listChannels: ['GET /api/channels'],
  listChannelPage: ['GET /api/channels?page={?}'],
  getChannel: ['GET /api/channels/{?}'],
  createChannel: ['POST /api/channels'],
  listUsers: ['GET /api/users'],
  exportChannel: [],
  getListChannelsQueryKey: [],
  invalidateListChannels: [],
  useListChannels: ['GET /api/channels'],
  useGetChannel: ['GET /api/channels/{?}'],
  useChannelSuspense: ['GET /api/channels/{?}'],
  useChannelPages: ['GET /api/channels?page={?}'],
  useCreateChannel: ['POST /api/channels'],
  useChannelsAndUsers: ['GET /api/channels', 'GET /api/users'],
  useExportChannel: [],
};

test('a react-query hook an API file calls gives the requests of the query, mutation or queries functions it is given, called with the fake values API functions get, the same for react-query 3 with arguments in place and for @tanstack/react-query with an options object, made by queryOptions, infiniteQueryOptions or mutationOptions or not, and for the suspense forms of the hooks, while a function that only invalidates queries gives none', async () => {
  const [object, positional] = await Promise.all([build(channelsCopy('@tanstack/react-query', OBJECT_HOOKS, OBJECT_NAMES)), build(channelsCopy('react-query', POSITIONAL_HOOKS, ''))]);
  assert.deepEqual(channelRequests(object), { ...CHANNEL_REQUESTS, useChannelPagesSuspense: ['GET /api/channels?page={?}'], useChannelsAndUsersSuspense: ['GET /api/channels', 'GET /api/users'] });
  assert.deepEqual(channelRequests(positional), CHANNEL_REQUESTS);
  const callsOf = (map: ScreenMap) => map.calls.filter((c) => /\/api\/(channels|users)/.test(c.id)).map((c) => [c.id, c.apiFunctions]);
  assert.deepEqual(callsOf(object), [
    ['GET:/api/channels', ['listChannels', 'useChannelsAndUsers', 'useChannelsAndUsersSuspense', 'useListChannels']],
    ['GET:/api/channels/{?}', ['getChannel', 'useChannelSuspense', 'useGetChannel']],
    ['GET:/api/channels?page={?}', ['listChannelPage', 'useChannelPages', 'useChannelPagesSuspense']],
    ['GET:/api/users', ['listUsers', 'useChannelsAndUsers', 'useChannelsAndUsersSuspense']],
    ['POST:/api/channels', ['createChannel', 'useCreateChannel']],
  ]);
  assert.deepEqual(callsOf(positional), [
    ['GET:/api/channels', ['listChannels', 'useChannelsAndUsers', 'useListChannels']],
    ['GET:/api/channels/{?}', ['getChannel', 'useChannelSuspense', 'useGetChannel']],
    ['GET:/api/channels?page={?}', ['listChannelPage', 'useChannelPages']],
    ['GET:/api/users', ['listUsers', 'useChannelsAndUsers']],
    ['POST:/api/channels', ['createChannel', 'useCreateChannel']],
  ]);
});

const KEY_HOOKS = (positional: boolean) => `
const byKey = ({ queryKey }: { queryKey: unknown[] }) => { const [, id] = queryKey; return getChannel(id as string); };
const byKeyObject = ({ queryKey }: { queryKey: unknown[] }) => { const [, { id }] = queryKey as [string, { id: string }]; return getChannel(id); };
export const useChannelByKey = (id: string) => ${positional ? `useQuery(['/api/channels', id], byKey)` : `useQuery({ queryKey: ['/api/channels', id], queryFn: byKey })`};
export const useChannelByKeyObject = (id: string) => ${positional ? `useQuery(['/api/channels', { id }], byKeyObject)` : `useQuery({ queryKey: ['/api/channels', { id }], queryFn: byKeyObject })`};
export const useChannelsByKey = (id: string) => useQueries(${positional ? '' : '{ queries: '}[{ queryKey: ['/api/channels', id], queryFn: byKey }]${positional ? '' : ' }'});
const byUrl = ({ queryKey: [url] }: { queryKey: unknown[] }) => request({ url: url as string, method: 'GET' });
export const useChannelsByUrl = () => ${positional ? `useQuery('/api/channels', byUrl)` : `useQuery({ queryKey: ['/api/channels'], queryFn: byUrl })`};
const fetchWith = (init?: object) => fetch('/api/channels', init);
export const useChannelsWithInit = () => ${positional ? `useQuery(['/api/channels'], fetchWith)` : `useQuery({ queryKey: ['/api/channels'], queryFn: fetchWith })`};
`;

test('a query function gets the key the hook was given, an array for a react-query 3 text key, so variables read back out of it reach the address, and the rest of what it gets still counts as no options when passed on to fetch', async () => {
  const [object, positional] = await Promise.all([build(channelsCopy('@tanstack/react-query', KEY_HOOKS(false), '')), build(channelsCopy('react-query', KEY_HOOKS(true), ''))]);
  for (const map of [object, positional]) {
    const requests = channelRequests(map);
    assert.deepEqual(
      [requests.useChannelByKey, requests.useChannelByKeyObject, requests.useChannelsByKey, requests.useChannelsByUrl, requests.useChannelsWithInit],
      [['GET /api/channels/{?}'], ['GET /api/channels/{?}'], ['GET /api/channels/{?}'], ['GET /api/channels'], ['GET /api/channels']],
    );
  }
});

test('a stand-in for react-query in constantStubs is used in place of the one duru gives', async () => {
  const map = await build(channelsCopy('@tanstack/react-query', OBJECT_HOOKS, OBJECT_NAMES, { constantStubs: { '@tanstack/react-query': 'export const useQuery = () => ({});' } }));
  const requests = channelRequests(map);
  assert.deepEqual([requests.listChannels, requests.useListChannels, requests.useCreateChannel, requests.useChannelsAndUsers], [['GET /api/channels'], [], [], []]);
});

test('extract prints the api method line for a hook whose query function stops on the fake value it is given', () => {
  const result = spawnSync(process.execPath, [CLI, 'extract', channelsCopy('@tanstack/react-query', OBJECT_HOOKS, OBJECT_NAMES)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter((l) => l.includes('api method')), [
    '  api method exportChannel ← contracts/api/channels.ts:10: Unknown export format: {?}',
    '  api method useExportChannel ← contracts/api/channels.ts:34: Unknown export format: {?}',
  ]);
});

const LONE_GET = "import { executeRequest } from './request';\n\nconst get = (url: string) => executeRequest({ endpoint: { method: 'GET', path: '' }, url });\n";
const OFF_SCREEN = {
  'contracts/api/lone.ts': `${LONE_GET}
export const loneUnused = () => get('/lone/unused');
export const loneElsewhere = () => get('/lone/elsewhere');
export const loneTested = () => get('/lone/tested');
export const loneApi = { typed: () => get('/lone/typed') };
export class LoneService {
  static picked() {
    return get('/lone/picked');
  }
}
export const loneReexported = () => get('/lone/reexported');
`,
  'contracts/api/keys.ts': `${LONE_GET}
export const fetchKeys = () => get('/lone/keys');
export const fetchValues = () => get('/lone/values');
`,
  'contracts/api/suggest.ts': `import { executeRequest } from './request';
import { fetchKeys, fetchValues } from './keys';

export const suggestKeys = (q: string) => (q === 'keys' ? fetchKeys() : executeRequest({ endpoint: { method: 'GET', path: '' }, url: '/lone/suggest/keys' }));
export const suggestValues = (q: string) => (q === 'values' ? fetchValues() : executeRequest({ endpoint: { method: 'GET', path: '' }, url: '/lone/suggest/values' }));
`,
  'contracts/api/publish.api.ts': `${LONE_GET}
export const publishApi = { create: () => get('/lone/publish/create'), remove: () => get('/lone/publish/remove') };
`,
  'contracts/api/documents.ts': `import { publishApi } from './publish.api';

const documents = (publish: typeof publishApi) => ({ publish: (id: string) => (id === 'now' ? publish.create() : null) });
export const documentApi = documents(publishApi);
`,
  'contracts/api/generated.ts': `import { useQuery } from '@tanstack/react-query';
${LONE_GET}
export const listThings = () => get('/lone/things');
export const useListThings = () => useQuery({ queryKey: ['things'], queryFn: () => listThings() });
export const getThing = () => get('/lone/thing');
export const getThingQueryOptions = () => ({ queryKey: ['thing'], queryFn: () => getThing() });
`,
  'contracts/Orphan.ts': `import { loneElsewhere } from './api/lone';
import { suggestKeys } from './api/suggest';
import { documentApi } from './api/documents';
import { getThingQueryOptions } from './api/generated';

export const orphan = (q: string) => [loneElsewhere(), suggestKeys(q), documentApi.publish(q), getThingQueryOptions()];
`,
  'contracts/lone.test.ts': "import { loneTested } from './api/lone';\n\nloneTested();\n",
  'contracts/lone.spec.ts': "import { loneTested } from './api/lone';\n\nloneTested();\n",
  'contracts/loneTypes.ts': "import { loneApi, LoneService } from './api/lone';\n\nexport type Typed = typeof loneApi.typed;\nexport type Picked = Pick<typeof LoneService, 'picked'>;\n",
  'contracts/loneBarrel.ts': "export { loneReexported } from './api/lone';\nexport * from './api/lone';\n",
  'contracts/Broken.ts': 'export const broken = (;\n',
  'contracts/UsesBroken.ts': "import { broken } from './Broken';\n\nexport const usesBroken = () => broken;\n",
};
const OFF_SCREEN_MODULES = ['lone', 'keys', 'suggest', 'publish.api', 'documents', 'generated'].map((f) => `contracts/api/${f}.ts`);
let offScreenRun: { status: number | null; stdout: string; stderr: string; map: ScreenMap } | undefined;
const offScreen = () => {
  if (!offScreenRun) {
    const configFile = fixtureCopy({ ...CALLED, calledApiModules: [...OFF_SCREEN_MODULES, ...CALLED.calledApiModules] }, OFF_SCREEN);
    const { status, stdout, stderr } = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
    offScreenRun = { status, stdout, stderr, map: JSON.parse(fs.readFileSync(path.join(path.dirname(configFile), 'out/map.json'), 'utf8')) };
  }
  return offScreenRun;
};
const lonely = (ids: string[]) => ids.filter((id) => id.startsWith('GET:/lone/'));

test('a call no screen sends is unused by app code when no source outside the API files reaches its API function, and other when a file no route draws imports and calls it', () => {
  const { map } = offScreen();
  assert.ok(map.callsOnNoScreen!.unused.includes('GET:/lone/unused'));
  assert.ok(map.callsOnNoScreen!.other.includes('GET:/lone/elsewhere'));
});

test('an API function another API function calls only in a branch the fake value does not take is other when app code reaches the caller, and unused when nothing does', () => {
  const { map } = offScreen();
  assert.deepEqual(map.apiFunctions.suggestKeys.endpoints.map((e) => e.url), ['/lone/suggest/keys']);
  assert.ok(map.callsOnNoScreen!.other.includes('GET:/lone/keys'));
  assert.ok(map.callsOnNoScreen!.unused.includes('GET:/lone/values'));
});

test('the methods of an API object an API file hands whole to a function at load time are other when app code reaches what that file exports', () => {
  const { map } = offScreen();
  assert.ok(map.callsOnNoScreen!.other.includes('GET:/lone/publish/create'));
  assert.ok(map.callsOnNoScreen!.other.includes('GET:/lone/publish/remove'));
});

test('a generated hook naming its request function in the same API file does not make that function used, while a query options function the app calls does', () => {
  const { map } = offScreen();
  assert.deepEqual(map.apiFunctions.useListThings.endpoints.map((e) => e.url), ['/lone/things']);
  assert.ok(map.callsOnNoScreen!.unused.includes('GET:/lone/things'));
  assert.ok(map.callsOnNoScreen!.other.includes('GET:/lone/thing'));
});

test('an API function used only in test files, in types or in re-exports is unused by app code, and the line lists both parts with the first three of each', () => {
  const { status, stderr, stdout, map } = offScreen();
  assert.equal(status, 0, stderr);
  assert.deepEqual(lonely(map.callsOnNoScreen!.unused), ['GET:/lone/picked', 'GET:/lone/reexported', 'GET:/lone/suggest/values', 'GET:/lone/tested', 'GET:/lone/things', 'GET:/lone/typed', 'GET:/lone/unused', 'GET:/lone/values']);
  assert.deepEqual(lonely(map.callsOnNoScreen!.other), ['GET:/lone/elsewhere', 'GET:/lone/keys', 'GET:/lone/publish/create', 'GET:/lone/publish/remove', 'GET:/lone/suggest/keys', 'GET:/lone/thing']);
  const { unused, other } = map.callsOnNoScreen!;
  assert.deepEqual(stdout.split('\n').filter((l) => /calls? reach(es)? no screen/.test(l)), [
    `  ${unused.length + other.length} calls reach no screen: ${unused.length} unused by app code (${unused.slice(0, 3).join(', ')}, …), ${other.length} other (${other.slice(0, 3).join(', ')}, …)`,
  ]);
});

test('a source file that does not parse, on its own or imported by a file no route draws, does not stop extract', () => {
  const { status, stderr, stdout } = offScreen();
  assert.equal(status, 0, stderr);
  assert.match(stdout, /^ {2}\d+ calls reach no screen: /m);
});

const AJAX_MORE = "const request = async (info: unknown) => info;\n\nexport const ajaxRestore = async () => request({ URL: '/api/v1/trash/restore', METHOD: 'POST' });\nexport const ajaxPurge = async () => request({ URL: '/api/v1/trash/purge', METHOD: 'POST' });\nexport const ajaxPublish = async () => request({ URL: '/api/v1/publish', METHOD: 'POST' });\nexport const ajaxLone = async () => request({ URL: '/api/v1/lone', METHOD: 'POST' });\n";
const TRASH_ACTIONS = "import * as Ajax from '../_ajax/More';\nimport { ajaxRestore, ajaxPurge } from '../_ajax/More';\n\nexport const trashAction = (restore: boolean) => (restore ? ajaxRestore : ajaxPurge);\nexport const handlers = { publish: Ajax.ajaxPublish };\n";

test('an apiModules function picked by a condition or handed over as an object value through a namespace import is other, a part with no call is left out, and one call reads as one', () => {
  const extract = (files: Record<string, string>) => spawnSync(process.execPath, [CLI, 'extract', fixtureCopy({ apiModules: ['_ajax/AjaxFunc.ts', '_ajax/More.ts'] }, files)], { encoding: 'utf8' });
  const lines = (stdout: string) => stdout.split('\n').filter((l) => /calls? reach(es)? no screen/.test(l));
  const picked = extract({ '_ajax/More.ts': AJAX_MORE, 'pages/TrashActions.ts': TRASH_ACTIONS });
  assert.equal(picked.status, 0, picked.stderr);
  assert.deepEqual(lines(picked.stdout), ['  4 calls reach no screen: 1 unused by app code (POST:/api/v1/lone), 3 other (POST:/api/v1/publish, POST:/api/v1/trash/purge, POST:/api/v1/trash/restore)']);
  const lone = extract({ '_ajax/More.ts': "const request = async (info: unknown) => info;\n\nexport const ajaxLone = async () => request({ URL: '/api/v1/lone', METHOD: 'POST' });\n" });
  assert.deepEqual(lines(lone.stdout), ['  1 call reaches no screen: 1 unused by app code (POST:/api/v1/lone)']);
  const other = extract({ '_ajax/More.ts': AJAX_MORE.replace(/^export const ajaxLone.*\n/m, ''), 'pages/TrashActions.ts': TRASH_ACTIONS });
  assert.deepEqual(lines(other.stdout), ['  3 calls reach no screen: 3 other (POST:/api/v1/publish, POST:/api/v1/trash/purge, POST:/api/v1/trash/restore)']);
});

test('a source file nothing imports that declares the same name twice is left out of the walk instead of stopping extract', () => {
  const run = spawnSync(process.execPath, [CLI, 'extract', fixtureCopy({ apiModules: ['_ajax/AjaxFunc.ts', '_ajax/More.ts'] }, { '_ajax/More.ts': "const request = async (info: unknown) => info;\n\nexport const ajaxLone = async () => request({ URL: '/api/v1/lone', METHOD: 'POST' });\n", 'pages/Collides.ts': 'export const a = 1;\nexport const a = 2;\n' })], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.split('\n').filter((l) => /calls? reach(es)? no screen/.test(l)), ['  1 call reaches no screen: 1 unused by app code (POST:/api/v1/lone)']);
});

test('an API function declared in a file the listed barrel re-exports from is unused when nothing calls it, and other when app code does', () => {
  const get = "import { executeRequest } from './request';\n\nconst get = (url: string) => executeRequest({ endpoint: { method: 'GET', path: '' }, url });\n";
  const configFile = fixtureCopy({ ...CALLED, calledApiModules: ['contracts/api/people.ts', ...CALLED.calledApiModules] }, {
    'contracts/api/people.ts': "export * from './peopleUsers';\nexport { getPersonOrder } from './peopleOrders';\n",
    'contracts/api/peopleUsers.ts': `${get}export const getPersonUnused = () => get('/people/unused');\nexport const getPersonUsed = () => get('/people/used');\n`,
    'contracts/api/peopleOrders.ts': `${get}export const getPersonOrder = () => get('/people/order');\n`,
    'contracts/PeopleUses.ts': "import { getPersonUsed } from './api/people';\n\nexport const peopleUse = () => getPersonUsed();\n",
  });
  const { status, stderr } = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  const { callsOnNoScreen } = JSON.parse(fs.readFileSync(path.join(path.dirname(configFile), 'out/map.json'), 'utf8')) as ScreenMap;
  const people = (ids: string[]) => ids.filter((id) => id.startsWith('GET:/people/'));
  assert.deepEqual(people(callsOnNoScreen!.unused), ['GET:/people/order', 'GET:/people/unused']);
  assert.deepEqual(people(callsOnNoScreen!.other), ['GET:/people/used']);
});

test('the usage guide names the line for calls that reach no screen with both of its parts, the agent guide says which part to look at, and the decision record names the splits it was compared with', () => {
  const readme = fs.readFileSync(path.join(import.meta.dirname, '../README.md'), 'utf8');
  const skill = fs.readFileSync(path.join(import.meta.dirname, '../skills/duru/SKILL.md'), 'utf8');
  const decisions = fs.readFileSync(path.join(import.meta.dirname, '../docs/decisions.md'), 'utf8');
  assert.match(decisions, /\*\*Calls that reach no screen are named in one line, split by whether any app source reaches their API functions\.\*\*[^]*?Compared:\n- The places the source calls an API function: [^]*?\n- References from app code one level deep[^]*?\n- Sorting the calls by what extract read of them/);
  assert.match(readme, /^- `N calls reach no screen: N unused by app code \(<call IDs>, …\), N other \(<call IDs>, …\)` — [^]*?\(`callsOnNoScreen`\)[^]*?`unused by app code`: [^]*?`other`: /m);
  assert.match(skill, /A `N calls reach no screen: …` line [^]*?The `other` ones are where a screen may be missing a request/);
});

// requestFunction 에 body 자리를 더한 설정. 인자가 요청에 어떻게 실렸는지 보려면 본문까지 봐야 한다.
const WITH_BODY = { ...CALLED, requestFunction: { ...CALLED.requestFunction, body: '0.body' } };
const inputsCopy = (module: string, keys: Record<string, unknown> = {}) =>
  fixtureCopy({ ...WITH_BODY, calledApiModules: ['invoices/api/inputs.ts'], ...keys }, { 'invoices/api/inputs.ts': module });
const inputsOf = async (module: string, keys?: Record<string, unknown>) =>
  (await build(inputsCopy(module, keys))).apiFunctions['inputsApi.save'].inputs;

test('the input keys a screen passes and the API function copies one by one into the body are the ones the request carries, and no other key of the same object is', async () => {
  const module = [
    "import { executeRequest } from '../../contracts/api/request';",
    'export const inputsApi = {',
    '  save(params: { data: Record<string, unknown> }) {',
    "    const { data } = params;",
    "    const body: Record<string, unknown> = {};",
    "    ['user.name', 'user.email'].forEach((k) => { if (k in data) body[k.split('.').pop()!] = data[k]; });",
    "    return executeRequest({ endpoint: { method: 'POST', path: '/save' }, url: '/save', body });",
    '  },',
    '};',
    '',
  ].join('\n');
  assert.deepEqual(await inputsOf(module), { sent: [['0', 'data', 'user.name'], ['0', 'data', 'user.email']], spread: [] });
});

test('the input key a screen passes whole as the body is the one the request carries', async () => {
  const module = [
    "import { executeRequest } from '../../contracts/api/request';",
    'export const inputsApi = {',
    '  save(params: { data: Record<string, unknown> }) {',
    "    return executeRequest({ endpoint: { method: 'POST', path: '/save' }, url: '/save', body: params.data });",
    '  },',
    '};',
    '',
  ].join('\n');
  assert.deepEqual(await inputsOf(module), { sent: [['0', 'data']], spread: [] });
});

test('the input key a screen passes into the address of the request is the one the request carries, and the rest of the address is not a key', async () => {
  const module = [
    "import { executeRequest } from '../../contracts/api/request';",
    'export const inputsApi = {',
    '  save({ params }: { params: { page: unknown; size: unknown } }) {',
    "    return executeRequest({ endpoint: { method: 'GET', path: '/list' }, url: '/list?page=' + String(params.page) });",
    '  },',
    '};',
    '',
  ].join('\n');
  assert.deepEqual(await inputsOf(module), { sent: [['0', 'params', 'page']], spread: [] });
});

test('the input key a screen passes under another name in a smaller object of the body is the one the request carries', async () => {
  const module = [
    "import { executeRequest } from '../../contracts/api/request';",
    'export const inputsApi = {',
    '  save({ data }: { data: Record<string, unknown> }) {',
    "    return executeRequest({ endpoint: { method: 'POST', path: '/save' }, url: '/save', body: { profile: { nick: data['user.nickname'] } } });",
    '  },',
    '};',
    '',
  ].join('\n');
  assert.deepEqual(await inputsOf(module), { sent: [['0', 'data', 'user.nickname']], spread: [] });
});

test('the input object a screen spreads into the body is reported as spread rather than as each of its keys', async () => {
  const module = [
    "import { executeRequest } from '../../contracts/api/request';",
    'export const inputsApi = {',
    '  save({ data }: { data: Record<string, unknown> }) {',
    "    return executeRequest({ endpoint: { method: 'POST', path: '/save' }, url: '/save', body: { ...data } });",
    '  },',
    '};',
    '',
  ].join('\n');
  assert.deepEqual(await inputsOf(module), { sent: [], spread: [['0', 'data']] });
});

test('an API function that fails only when a value it is given is itself a stand-in it cannot read says the input keys are unknown, and its addresses stay as they were', async () => {
  const module = [
    "import { executeRequest } from '../../contracts/api/request';",
    'export const inputsApi = {',
    '  save({ data }: { data: { kind: unknown } }) {',
    '    const given = data.kind as { value: unknown };',
    "    if (given.value === given) throw new Error('kind must hold a value');",
    "    return executeRequest({ endpoint: { method: 'POST', path: '/save' }, url: '/save', body: { kind: String(given) } });",
    '  },',
    '};',
    '',
  ].join('\n');
  const map = await build(inputsCopy(module));
  const without = await build(inputsCopy(module, { requestFunction: CALLED.requestFunction }));
  const fn = map.apiFunctions['inputsApi.save'];
  assert.equal(fn.inputsUnknown, 'threw with tagged values: kind must hold a value');
  assert.equal(fn.inputs, undefined);
  assert.deepEqual(endpointsOf(map, 'inputsApi.save'), endpointsOf(without, 'inputsApi.save'));
});

test('an API function that needs a number where it reads the input it is given says the input keys are unknown rather than guessing them', async () => {
  const module = [
    "import { executeRequest } from '../../contracts/api/request';",
    'export const inputsApi = {',
    '  save({ data }: { data: { count: unknown } }) {',
    "    if (typeof data.count !== 'number') throw new Error('count must be a number');",
    "    return executeRequest({ endpoint: { method: 'GET', path: '/count' }, url: '/count?limit=' + data.count });",
    '  },',
    '};',
    '',
  ].join('\n');
  const map = await build(inputsCopy(module));
  const without = await build(inputsCopy(module, { requestFunction: CALLED.requestFunction }));
  const fn = map.apiFunctions['inputsApi.save'];
  assert.equal(fn.inputsUnknown, 'needs numbers');
  assert.equal(fn.inputs, undefined);
  assert.deepEqual(endpointsOf(map, 'inputsApi.save'), endpointsOf(without, 'inputsApi.save'));
});
