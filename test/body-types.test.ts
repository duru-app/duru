import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { readBodyFields } from '../src/body-types.ts';
import { buildMap } from '../src/map.mjs';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/ts-app');
const CLI = path.join(import.meta.dirname, '../src/cli.mjs');
const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const SETTING_API = `import type { RequestOptions } from './request';

type Send = (options: RequestOptions) => Promise<unknown>;
type ExpireType = 'DAYS' | 'DATE';

interface SettingBody {
  enabledNotice: boolean;
  expiry: { enabledExpire?: boolean | null; expireType: ExpireType };
  members: { enabledAlert: boolean }[];
  fixed: false;
  title: string;
}

interface MemberBody {
  enabledInvite: boolean;
}

interface Answer {
  enabledCache: boolean;
}

export class SettingApi {
  constructor(private readonly send: Send) {}

  saveSetting(body: SettingBody) {
    return this.send({ endpoint: { method: 'POST', path: '' }, url: '/internal/v2/setting/save', body });
  }

  private runMember(operation: 'notify' | 'update', data: MemberBody) {
    return this.send({ endpoint: { method: 'POST', path: '' }, url: \`/internal/v2/member/\${operation}\`, ...(operation === 'update' ? { body: data } : {}) });
  }

  updateMember(data: MemberBody) {
    return this.runMember('update', data);
  }

  notifyMember(data: MemberBody) {
    return this.runMember('notify', data);
  }

  async publishMember(data: MemberBody) {
    await this.send({ endpoint: { method: 'POST', path: '' }, url: '/internal/v2/member/lock' });
    return this.send({ endpoint: { method: 'POST', path: '' }, url: '/internal/v2/member/publish', body: data });
  }

  saveLabel(body: { enabledPin: boolean; tags: Record<string, string>; marks: Record<string, 'on' | 'off'> }) {
    return this.send({ endpoint: { method: 'POST', path: '' }, url: '/internal/v2/label/save', body }).then((answer) => ({ body: answer as Answer }));
  }

  saveLoose(data: Record<string, unknown>) {
    return this.send({ endpoint: { method: 'POST', path: '' }, url: '/internal/v2/loose/save', body: data });
  }

  loadSetting(filter: { enabledDraft: boolean }) {
    return this.send({ endpoint: { method: 'GET', path: '' }, url: '/internal/v2/setting/load', body: filter });
  }
}
`;

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', jsx: 'react-jsx', paths: { '@contracts/*': ['./src/contracts/*'] } }, include: ['src'] });

const CALLED = {
  calledApiModules: ['contracts/api/index.ts'],
  requestFunction: { import: './contracts/api/request', name: 'executeRequest', method: '0.endpoint.method', url: '0.url', body: '0.body' },
  serverEndpoints: 'contract-server-endpoints.txt',
  tsconfig: 'client/tsconfig.json',
  bodyArgKeys: ['data', 'body'],
};

function fixtureCopy(keys: Record<string, unknown>) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
  const api = path.join(copy, 'client/src/contracts/api');
  fs.writeFileSync(path.join(api, 'setting.api.ts'), SETTING_API);
  fs.appendFileSync(path.join(api, 'index.ts'), "\nimport { SettingApi } from './setting.api';\n\nexport const settingApi = new SettingApi(executeRequest);\n");
  fs.writeFileSync(path.join(copy, 'client/tsconfig.json'), TSCONFIG);
  const configFile = path.join(copy, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.routesFile.push('contracts/ContractRoutes.tsx');
  const merged: Record<string, unknown> = { ...config, ...keys };
  for (const [k, v] of Object.entries(keys)) if (v === undefined) delete merged[k];
  fs.writeFileSync(configFile, JSON.stringify(merged, null, 2));
  return configFile;
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
let readMap: ReturnType<typeof build> | undefined;
const read = () => (readMap ??= build(fixtureCopy(CALLED)));
type CallOption = { key: string; sources: string[] };
const optionsOf = (map: Awaited<ReturnType<typeof build>>, id: string): [string, string[]][] | undefined =>
  map.calls.find((c: { id: string }) => c.id === id)?.options.map((o: CallOption): [string, string[]] => [o.key, o.sources]);

test('the on/off fields of the body an API method sends, read from its type, come out as options of its call, with arrays written as []', async () => {
  const map = await read();
  assert.deepEqual(optionsOf(map, 'POST:/internal/v2/setting/save'), [['enabledNotice', ['type']], ['members[].enabledAlert', ['type']]]);
});

test('a field that can only be one value, or that goes with a field of fixed choices named after the same thing, is not an option, and the second is reported', async () => {
  const map = await read();
  const keys = optionsOf(map, 'POST:/internal/v2/setting/save')?.map(([key]) => key);
  assert.ok(!keys?.includes('fixed') && !keys?.includes('expiry.enabledExpire'));
  assert.deepEqual(map.bodyTypeNotices.filter((n: { method: string }) => n.method === 'settingApi.saveSetting'), [{ method: 'settingApi.saveSetting', field: 'expiry.enabledExpire', beside: 'expiry.expireType' }]);
});

test('a body given in a method this method calls is read, but not for a call that sent no body', async () => {
  const map = await read();
  assert.deepEqual(optionsOf(map, 'POST:/internal/v2/member/update'), [['enabledInvite', ['type']]]);
  assert.deepEqual(optionsOf(map, 'POST:/internal/v2/member/notify'), []);
});

test('a GET call gets no body options, and a body typed with no field names is reported', async () => {
  const map = await read();
  assert.deepEqual(optionsOf(map, 'GET:/internal/v2/setting/load'), []);
  assert.deepEqual(optionsOf(map, 'POST:/internal/v2/loose/save'), []);
  assert.deepEqual(map.bodyTypeNotices.filter((n: { method: string }) => n.method === 'settingApi.saveLoose'), [{ method: 'settingApi.saveLoose', reason: 'the body is typed Record<string, unknown>, which names no fields' }]);
});

test('of two requests a method sends, only the one that carried the body gets its options', async () => {
  const map = await read();
  assert.deepEqual(optionsOf(map, 'POST:/internal/v2/member/publish'), [['enabledInvite', ['type']]]);
  assert.deepEqual(optionsOf(map, 'POST:/internal/v2/member/lock'), []);
});

test('an object the method builds from the answer is not read as the body, and a field of texts by name is not reported', async () => {
  const map = await read();
  assert.deepEqual(optionsOf(map, 'POST:/internal/v2/label/save'), [['enabledPin', ['type']]]);
  assert.deepEqual(map.bodyTypeNotices.filter((n: { method: string }) => n.method === 'settingApi.saveLabel'), []);
});

test('without tsconfig, or without the body place of the request function, no body type is read', async () => {
  for (const keys of [{ tsconfig: undefined }, { requestFunction: { ...CALLED.requestFunction, body: undefined } }]) {
    const map = await build(fixtureCopy({ ...CALLED, ...keys }));
    assert.deepEqual(optionsOf(map, 'POST:/internal/v2/setting/save'), []);
    assert.equal(map.bodyTypeNotices, undefined);
  }
});

test('a decorated method is found by the line of its name, its body is read through `as`, and a notice names its file from srcRoot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(dir);
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, experimentalDecorators: true } }));
  fs.writeFileSync(path.join(dir, 'api.ts'), [
    'declare function logged(target: object, name: string): void;',
    'declare function send(options: { url: string; body?: unknown }): Promise<unknown>;',
    'export class Api {',
    '  @logged',
    '  save(body: { enabledDraft: boolean }) {',
    "    return send({ url: '/save', body } as { url: string; body: unknown });",
    '  }',
    '}',
    '',
  ].join('\n'));
  const file = path.join(dir, 'api.ts');
  const { fields, notices } = readBodyFields(path.join(dir, 'tsconfig.json'), ['body'], [
    { key: 'api.save', file, line: 5, shownFile: 'api.ts' },
    { key: 'api.gone', file, line: 9, shownFile: 'api.ts' },
  ]);
  assert.deepEqual([...fields], [['api.save', ['enabledDraft']]]);
  assert.deepEqual(notices, [{ method: 'api.gone', reason: 'no function was found at api.ts:9' }]);
});

test('extract prints the fields left out for going with a field of fixed choices, and the bodies with no field names', () => {
  const run = spawnSync(process.execPath, [CLI, 'extract', fixtureCopy(CALLED)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ {2}body type settingApi\.saveSetting: expiry\.enabledExpire goes with expiry\.expireType, so it is not taken as an on\/off option$/m);
  assert.match(run.stdout, /^ {2}body type settingApi\.saveLoose: the body is typed Record<string, unknown>, which names no fields$/m);
});

test('a body is found through satisfies, !, new, the result of a condition or a comma, and a quoted key, but not in the condition, and a method sending a body without one is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(dir);
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  const lines = [
    'type B = { enabledA: boolean };',
    'type Options = { url: string; body?: unknown };',
    'declare function send(options: Options): Promise<unknown>;',
    'declare function log(n: number): void;',
    'declare class Request { constructor(options: Options) }',
    'export const api = {',
    "  viaSatisfies: (body: B) => send({ url: '/a', body } satisfies Options),",
    "  viaNonNull: (body: B) => send({ url: '/b', body }!),",
    "  viaNew: (body: B) => new Request({ url: '/c', body }),",
    "  viaComma: (body: B) => send((log(1), { url: '/d', body })),",
    "  viaQuote: (data: B) => send({ url: '/e', 'body': data }),",
    "  inCondition: (body: B) => send(({ body } as unknown as boolean) ? { url: '/f' } : { url: '/g' }),",
    "  inVariable: (body: B) => { const options = { url: '/h', body }; return send(options); },",
    '  overload(body: B): Promise<unknown>;',
    "  overload(body: B) { return send({ url: '/i', body }); },",
    '};',
    '',
  ];
  fs.writeFileSync(path.join(dir, 'api.ts'), lines.join('\n'));
  const file = path.join(dir, 'api.ts');
  const methods = ['viaSatisfies', 'viaNonNull', 'viaNew', 'viaComma', 'viaQuote', 'inCondition', 'inVariable', 'overload'].map((name) => (
    { key: `api.${name}`, file, line: lines.findIndex((l) => l.includes(`${name}`) && !l.endsWith(';')) + 1, shownFile: 'api.ts' }
  ));
  const { fields, notices } = readBodyFields(path.join(dir, 'tsconfig.json'), ['body'], methods);
  assert.deepEqual([...fields.keys()], ['api.viaSatisfies', 'api.viaNonNull', 'api.viaNew', 'api.viaComma', 'api.viaQuote', 'api.overload']);
  assert.deepEqual(notices, ['api.inCondition', 'api.inVariable'].map((method) => ({ method, reason: 'it sent a body, but no body was found in an object it gives to a call' })));
});
