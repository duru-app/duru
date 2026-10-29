import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// 요청 함수에 본문 자리까지 준다. 인자가 요청에 실렸는지 보려면 본문까지 봐야 한다.
const REQUEST = { import: './_ajax/Ajax', name: 'request', method: '0.info.METHOD', url: '0.info.URL', body: '0.data' };

// fixture 사본에 화면과 상태, API 함수를 적는다. 상대 경로로 불러온 자식 컴포넌트의 파일도 함께 놓는다.
function fixtureCopy(files: Record<string, string>, keys: Record<string, unknown> = { requestFunction: REQUEST }) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(copy, 'client/src', rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  const configFile = path.join(copy, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.writeFileSync(configFile, JSON.stringify({ ...config, ...keys }, null, 2));
  const routes = path.join(copy, 'client/src/Routes.js');
  fs.writeFileSync(routes, fs.readFileSync(routes, 'utf8')
    .replace("const AdminReport = lazy(() => import('./components/AdminReport'));", "const AdminReport = lazy(() => import('./components/AdminReport'));\nconst SignerEdit = lazy(() => import('./components/SignerEdit'));\nconst Search = lazy(() => import('./components/Search'));")
    .replace("<Route path={Option.ROUTE_PATH.ADMIN_REPORT} component={AdminReport} exact />", "<Route path={Option.ROUTE_PATH.ADMIN_REPORT} component={AdminReport} exact />\n      <Route path={'/signer'} component={SignerEdit} exact />\n      <Route path={'/search'} component={Search} exact />"));
  return configFile;
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const AJAX = "export const request = async (params) => ({ params });\n";

// 서명자 정보를 고정된 키 목록으로만 옮기는 API 함수. 화면이 쓴 나머지 키는 요청에 실리지 않는다.
const AJAX_FUNC = `import * as Ajax from './Ajax';
import Option from '_define/Option';

export const ajaxUpdateSigner = async ({ id, data }) => {
  const body = {};
  ['signer.name', 'signer.email'].forEach((k) => { if (k in data) body[k] = data[k]; });
  return Ajax.request({ info: Option.REST_API.MEMBER.LIST, data: body });
};

export const ajaxList = async ({ data }) => Ajax.request({ info: Option.REST_API.MEMBER.LIST, data: { status: data.status } });

export const ajaxSpread = async ({ data }) => Ajax.request({ info: Option.REST_API.MEMBER.LIST, data: { ...data } });
`;

// 실제 화면처럼 부모가 자식이 넘긴 키를 상태에 합치고, 저장할 때 그 상태를 API 함수에 넘긴다.
const SIGNER_EDIT = `import { useState } from 'react';
import { ajaxUpdateSigner, ajaxSpread } from '_ajax/AjaxFunc';
import SignerPki from './SignerPki';

export default function SignerEdit({ id }) {
  const [data, setData] = useState({});

  const handleChange = (newData) => {
    setData({ ...data, ...newData });
  };

  const update = async () => {
    const ajaxData = { ...data };
    await ajaxUpdateSigner({ id, data: ajaxData });
  };

  const send = async () => {
    await ajaxSpread({ data });
  };

  return (
    <div>
      <SignerPki data={data} onChange={handleChange} />
      <button onClick={update}>save</button>
      <button onClick={send}>send</button>
    </div>
  );
}
`;

const SIGNER_PKI = `export default function SignerPki({ data, onChange }) {
  const handleChange = (type, value) => {
    onChange({ ...data, [type]: value });
  };

  return (
    <div>
      <button onClick={() => handleChange('signer.attribute.pkiSignType', 'KICA')}>pki</button>
      <input onChange={(e) => handleChange('signer.name', e.target.value)} />
    </div>
  );
}
`;

const base = { 'components/SignerEdit.js': SIGNER_EDIT, 'components/SignerPki.js': SIGNER_PKI, '_ajax/Ajax.js': AJAX, '_ajax/AjaxFunc.js': AJAX_FUNC };

const checked = (map: ScreenMap, fn: string) => map.inputsToCheck!.filter((k) => k.fn === fn && k.screen.includes('SignerEdit')).map((k) => k.key);

test('a key a child component writes into the parent state and that the API function does not copy is listed to check, the one it copies is not', async () => {
  const map = await build(fixtureCopy(base));
  assert.deepEqual(checked(map, 'ajaxUpdateSigner'), ['signer.attribute.pkiSignType']);
  assert.deepEqual(map.unknownInputs!.filter((u) => u.fn === 'ajaxUpdateSigner'), []);
});

test('a key the screen writes into its search state, which the API function sends only one of, is listed to check', async () => {
  const map = await build(fixtureCopy({
    ...base,
    'components/Search.js': `import { useState } from 'react';
import { ajaxList } from '_ajax/AjaxFunc';

export default function Search() {
  const [search, setSearch] = useState({ keyword: '', status: '' });

  const handleSearch = (type, value) => {
    setSearch({ ...search, [type]: value });
  };

  const list = async () => {
    await ajaxList({ data: search });
  };

  return (
    <div>
      <input onChange={(e) => handleSearch('keyword', e.target.value)} />
      <input onChange={(e) => handleSearch('status', e.target.value)} />
      <button onClick={list}>list</button>
    </div>
  );
}
`,
  }));
  const calls = map.screens.find((s) => s.id.includes('Search'))!.apiCalls.filter((c) => c.fn === 'ajaxList');
  assert.equal(calls.length, 1);
  assert.deepEqual(map.inputsToCheck!.filter((k) => k.fn === 'ajaxList').map((k) => k.key), ['keyword']);
});

test('a call whose argument the API function spreads whole is unknown rather than a list of keys to check', async () => {
  const map = await build(fixtureCopy(base));
  const spread = map.unknownInputs!.filter((u) => u.fn === 'ajaxSpread');
  assert.equal(spread.length, 1);
  assert.match(spread[0].reason, /spread/);
  assert.equal(map.inputsToCheck!.filter((k) => k.fn === 'ajaxSpread').length, 0);
});

test('a key parameter given a variable at one call makes the keys of that state unknown, not a list to check', async () => {
  const map = await build(fixtureCopy({
    ...base,
    // 자식이 고르는 키를 이름이 아니라 값으로 받으면 어느 키인지 알 수 없다.
    'components/SignerPki.js': `export default function SignerPki({ data, onChange }) {
  const field = 'signer.name';
  const handleChange = (type, value) => {
    onChange({ ...data, [type]: value });
  };

  return (
    <div>
      <button onClick={() => handleChange(field, 'a')}>by variable</button>
      <button onClick={() => handleChange('signer.attribute.pkiSignType', 'KICA')}>pki</button>
    </div>
  );
}
`,
  }));
  // 자식이 키를 읽지 못하면 그 키를 합치는 부모의 상태도 알 수 없다.
  const unknown = map.unknownInputs!.filter((u) => u.fn === 'ajaxUpdateSigner');
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].reason, /spread of newData/);
  assert.equal(map.inputsToCheck!.filter((k) => k.fn === 'ajaxUpdateSigner').length, 0);
});

test('a screen function whose key parameter is given a variable at one call leaves the keys of that state unknown', async () => {
  const map = await build(fixtureCopy({
    ...base,
    'components/Search.js': `import { useState } from 'react';
import { ajaxList } from '_ajax/AjaxFunc';

export default function Search() {
  const [search, setSearch] = useState({});

  const handleSearch = (type, value) => {
    setSearch({ ...search, [type]: value });
  };

  const field = 'keyword';
  const list = async () => {
    await ajaxList({ data: search });
  };

  return (
    <div>
      <input onChange={(e) => handleSearch('status', e.target.value)} />
      <input onChange={(e) => handleSearch(field, e.target.value)} />
      <button onClick={list}>list</button>
    </div>
  );
}
`,
  }));
  const unknown = map.unknownInputs!.filter((u) => u.fn === 'ajaxList');
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].reason, /string literal/);
  assert.equal(map.inputsToCheck!.filter((k) => k.fn === 'ajaxList').length, 0);
});

test('without requestFunction the map has neither input keys to check nor unknown inputs', async () => {
  const map = await build(fixtureCopy(base, { requestFunction: undefined }));
  assert.equal(map.inputsToCheck, undefined);
  assert.equal(map.unknownInputs, undefined);
});

test('the rebuild output has one line counting the keys to check with a line per key, and one line counting the unknown calls with their reasons', async () => {
  const configFile = fixtureCopy(base);
  const output = execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' });
  const lines = output.split('\n');
  assert.ok(lines.some((l) => /^input keys to check \d+$/.test(l)), output);
  assert.ok(lines.some((l) => /^ {2}\S+ ajaxUpdateSigner signer\.attribute\.pkiSignType components\/SignerEdit\.js:\d+$/.test(l)), output);
  assert.ok(lines.some((l) => /^input keys unknown \d+.*spread/.test(l)), output);
});
