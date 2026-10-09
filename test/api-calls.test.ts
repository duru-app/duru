import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callFinder } from '../src/address-match.ts';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/ts-app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

type Endpoint = { method: string; url: string; callId?: string; server: { status: string } };
type ApiCall = { fn: string; file: string; line: number; endpoints: Endpoint[] };
type ApiFunction = { file?: string; line?: number; error?: string; endpoints: Endpoint[] };
type Screen = { id: string; path: string; links: unknown; settingReads: unknown; access: unknown; apiCalls: ApiCall[] };
type MapData = { screens: Screen[]; apiFunctions: Record<string, ApiFunction>; calls: { id: string; screens: string[] }[]; unrunApiModules?: string[] };

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

const build = (configFile: string): Promise<MapData> => buildMap(loadConfig(configFile));
let calledMap: Promise<MapData> | undefined;
const called = () => (calledMap ??= build(fixtureCopy(CALLED)));
const screen = (map: MapData, id: string) => map.screens.find((s) => s.id === id)!;
const endpointsOf = (map: MapData, name: string) => map.apiFunctions[name].endpoints.map((e) => [e.method, e.url, e.server.status, e.callId]);

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

const sitesOf = (map: MapData, id: string) => screen(map, id).apiCalls.map((c) => [c.fn, c.file, c.line]);

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
  assert.deepEqual(archive.endpoints.map((e) => e.callId), ['POST:/internal/v2/workspace/{workspaceId}/contract/{contractId}/archive', 'GET:/internal/v2/workspace/{workspaceId}/contract/list']);
  const notices = screen(map, '/contract-summary#ContractSummary').apiCalls.find((c) => c.fn === 'fetchNotices')!;
  assert.deepEqual(notices.endpoints.map((e) => e.callId), ['GET:/internal/v2/notice/list']);
});

test('an API object imported through a file that re-exports it is joined to its methods where the screen calls them', async () => {
  const map = await called();
  assert.deepEqual(sitesOf(map, '/notes#Notes'), [['noteApi.loadNotes', 'contracts/Notes.tsx', 4]]);
  assert.deepEqual(screen(map, '/notes#Notes').apiCalls[0].endpoints.map((e) => e.url), ['{?}/internal/v2/note/list']);
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
  const shape = (m: MapData) => m.screens.map((s) => [s.id, s.links, s.settingReads, s.access]);
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

test('each listed file importing a decorated class, directly or through another module, is reported with the file, line and column of the decorator, and the other files still run', async () => {
  const importer = (name: string, from: string) => `import { Store } from './${from}';\nexport const ${name} = { load: () => new Store() };\n`;
  const listed = ['stored', 'storedAgain', 'storedThrough', 'storedThroughAgain'];
  const configFile = fixtureCopy(
    { ...CALLED, calledApiModules: [...listed.map((f) => `contracts/api/${f}.ts`), ...CALLED.calledApiModules] },
    {
      ...Object.fromEntries(listed.map((f) => [`contracts/api/${f}.ts`, importer(`${f}Api`, f.startsWith('storedThrough') ? 'stores' : 'store')])),
      'contracts/api/stores.ts': "export { Store } from './store';\n",
      'contracts/api/store.ts': 'const dec = (v: unknown) => v;\nexport class Store {\n  @dec count = 0;\n}\n',
    },
  );
  const map = await build(configFile);
  const error = `calledApiModules: ${path.join(path.dirname(configFile), 'client/src/contracts/api/store.ts')}:3:3: a decorator is not JavaScript that Node runs, so duru cannot run this file`;
  assert.deepEqual(map.unrunApiModules, listed.map((f) => ({ file: `contracts/api/${f}.ts`, error })));
  assert.equal(map.apiFunctions['contractApi.loadList'].endpoints.length, 1);
});

test('the new keys are refused when one comes without the other, a file is in both API lists, a place is not a number followed by keys, or a relative import names no file', async () => {
  const refused = (keys: Record<string, unknown>) => assert.throws(() => loadConfig(fixtureCopy(keys)));
  refused({ calledApiModules: CALLED.calledApiModules });
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
const requestsOf = (map: MapData) => Object.fromEntries(Object.entries(map.apiFunctions).filter(([name]) => !name.startsWith('ajax')).map(([name, f]) => [name, f.endpoints.map((e) => `${e.method} ${e.url}`)]));

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
