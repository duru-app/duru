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
  await assert.rejects(build(fixtureCopy({ calledApiModules: CALLED.calledApiModules })), /calledApiModules has no requestFunction and no listed file sent a request with fetch/);
  const broken = { 'contracts/api/broken.ts': "throw new Error('no session');\nexport const brokenApi = { load: () => fetch('/x') };\n" };
  await assert.rejects(build(fixtureCopy({ calledApiModules: ['contracts/api/broken.ts'] }, broken)), /no request was recorded.*; contracts\/api\/broken\.ts did not run: .*no session/);
  await assert.rejects(build(fixtureCopy({ calledApiModules: ['contracts/api/broken.ts', ...CALLED.calledApiModules] }, broken)), /no request was recorded.*; contracts\/api\/broken\.ts did not run: .*no session/);
  await assert.rejects(build(fixtureCopy({ calledApiModules: ['contracts/api/missing.ts', ...CALLED.calledApiModules] })), /no request was recorded.*; contracts\/api\/missing\.ts did not run/);
  const brokenAndSending = await build(fixtureCopy({ calledApiModules: ['contracts/api/broken.ts', 'contracts/api/fetched.ts'] }, { ...fetched, ...broken }));
  assert.deepEqual(brokenAndSending.unrunApiModules!.map((m) => m.file), ['contracts/api/broken.ts']);
  const result = spawnSync(process.execPath, [CLI, 'extract', mixedConfig], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter((l) => l.includes('recorded no request')), ['  calledApiModules contracts/api/index.ts recorded no request; without requestFunction only requests sent with fetch are recorded']);
});

test('requestFunction is refused without calledApiModules, as is a file in both API lists, a place that is not a number followed by keys, or a relative import that names no file', async () => {
  const refused = (keys: Record<string, unknown>) => assert.throws(() => loadConfig(fixtureCopy(keys)));
  refused({ requestFunction: CALLED.requestFunction });
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
    'perRequestApi.absolute': ['GET /x'],
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
