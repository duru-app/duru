import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { addMark } from '../src/marks.ts';
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
// 자식은 키를 넘기는 세 가지 모양으로 부모의 handleChange 를 부른다.
const SIGNER_EDIT = `import { useState } from 'react';
import { ajaxUpdateSigner, ajaxSpread } from '_ajax/AjaxFunc';
import SignerPki from './SignerPki';
import SignerInfo from './SignerInfo';
import SignerAuth from './SignerAuth';
import SignerNotification from './SignerNotification';

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
      <SignerInfo data={data} onChange={handleChange} />
      <SignerAuth data={data} onChange={handleChange} />
      <SignerNotification data={data} onChange={handleChange} />
      <button onClick={update}>save</button>
      <button onClick={send}>send</button>
    </div>
  );
}
`;

// 속성으로 받은 handleChange 를 그대로 부르는 자식. 키를 이름이 아니라 객체로 넘긴다.
const SIGNER_INFO = `export default function SignerInfo({ data, onChange }) {
  const handleChange = (data) => {
    onChange && onChange(data);
  };

  return <input onChange={(e) => handleChange({ 'signer.name': e.target.value })} />;
}
`;

// 키를 매개변수로 받아 let 으로 둔 객체에 담아 넘기는 자식.
const SIGNER_AUTH = `export default function SignerAuth({ data, onChange }) {
  const handleChange = (type, value) => {
    let newData = {};
    newData[type] = value;
    onChange && onChange(newData);
  };

  return <input onChange={(e) => handleChange('signer.email', e.target.value)} />;
}
`;

// 속성을 그대로 손자에게 넘기는 자식.
const SIGNER_NOTIFICATION = `import FormNotificationType from './FormNotificationType';

export default function SignerNotification({ data, onChange }) {
  return <FormNotificationType data={data} onChange={onChange} />;
}
`;

const FORM_NOTIFICATION_TYPE = `export default function FormNotificationType({ data, onChange }) {
  const handleChange = (type, value) => {
    onChange({ ...data, [type]: value });
  };

  return <button onClick={() => handleChange('signer.notify.extra', true)}>extra</button>;
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

const base = {
  'components/SignerEdit.js': SIGNER_EDIT,
  'components/SignerPki.js': SIGNER_PKI,
  'components/SignerInfo.js': SIGNER_INFO,
  'components/SignerAuth.js': SIGNER_AUTH,
  'components/SignerNotification.js': SIGNER_NOTIFICATION,
  'components/FormNotificationType.js': FORM_NOTIFICATION_TYPE,
  '_ajax/Ajax.js': AJAX,
  '_ajax/AjaxFunc.js': AJAX_FUNC,
};

const checked = (map: ScreenMap, fn: string) => map.inputsToCheck!.filter((k) => k.fn === fn && k.screen.includes('SignerEdit')).map((k) => k.key);

test('a key a child component writes into the parent state and that the API function does not copy is listed to check, the one it copies is not', async () => {
  const map = await build(fixtureCopy(base));
  // 이름과 메일은 API 함수가 그대로 옮기고, PKI 와 알림의 키는 옮기지 않는다.
  assert.deepEqual(checked(map, 'ajaxUpdateSigner'), ['signer.attribute.pkiSignType', 'signer.notify.extra']);
  assert.deepEqual(map.unknownInputs!.filter((u) => u.fn === 'ajaxUpdateSigner'), []);
});

test('a key a child component writes is listed at the literal it is written as, in the child file, not at where the parent merges it', async () => {
  const map = await build(fixtureCopy(base));
  const place = (key: string) => map.inputsToCheck!.find((k) => k.fn === 'ajaxUpdateSigner' && k.key === key)!;
  // 매개변수로 받은 키는 부른 자리의 글자다. 자식 파일 안의 자리라도 그 글자의 줄을 가리킨다.
  assert.equal(place('signer.attribute.pkiSignType').at, 'components/SignerPki.js:3 → components/SignerPki.js:8');
  assert.equal(place('signer.notify.extra').at, 'components/FormNotificationType.js:3 → components/FormNotificationType.js:6');
  // 고정된 목록이 그대로 옮기는 키는 확인할 목록에 없다.
  assert.equal(map.inputsToCheck!.find((k) => k.fn === 'ajaxUpdateSigner' && k.key === 'signer.name'), undefined);
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

test('a key a screen function takes as a parameter is listed at the literal the function is called with, and the parent state it is merged into says the same', async () => {
  const map = await build(fixtureCopy({
    ...base,
    'components/Child.js': `export default function Child({ data, onChange }) {
  const handleChange = (type, value) => {
    onChange({ [type]: value });
  };

  return <button onClick={() => handleChange('keyword', 'x')}>go</button>;
}
`,
    'components/Search.js': `import { useState } from 'react';
import { ajaxList } from '_ajax/AjaxFunc';
import Child from './Child';

export default function Search() {
  const [search, setSearch] = useState({});
  const handleChange = (newData) => setSearch({ ...search, ...newData });
  const list = async () => { await ajaxList({ data: search }); };

  return <div><Child data={search} onChange={handleChange} /><button onClick={list}>list</button></div>;
}
`,
  }));
  const checked = map.inputsToCheck!.filter((k) => k.fn === 'ajaxList');
  assert.deepEqual(checked.map(({ key, file, at }) => ({ key, file, at })), [{ key: 'keyword', file: 'components/Search.js', at: 'components/Child.js:3 → components/Child.js:6' }]);
  // 목록의 자리는 부모가 그 키를 합치는 곳이다. 글자를 읽는 곳은 at 이다.
  assert.equal(checked[0].line, 7);
});

test('a call whose argument the API function spreads whole is unknown rather than a list of keys to check', async () => {
  const map = await build(fixtureCopy(base));
  const spread = map.unknownInputs!.filter((u) => u.fn === 'ajaxSpread');
  assert.equal(spread.length, 1);
  assert.match(spread[0].reason, /spread/);
  assert.equal(map.inputsToCheck!.filter((k) => k.fn === 'ajaxSpread').length, 0);
});

test('a child that hands the parent state a value it computes rather than an object literal leaves that call unknown', async () => {
  const map = await build(fixtureCopy({
    ...base,
    // 자식이 넘기는 값을 다른 함수가 만든다면, 그 값이 어떤 키를 더하는지 이 파일에서 알 수 없다.
    'components/SignerInfo.js': `const compute = (x) => ({ 'signer.computed': x });

export default function SignerInfo({ data, onChange }) {
  return <input onChange={(e) => onChange(compute(e.target.value))} />;
}
`,
  }));
  const unknown = map.unknownInputs!.filter((u) => u.fn === 'ajaxUpdateSigner');
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].reason, /spread of newData/);
});

test('a child that fills the object it hands the parent with Object.assign leaves that call unknown', async () => {
  const map = await build(fixtureCopy({
    ...base,
    // Object.assign 으로 더한 키는 적힌 자리가 없어 이 파일에서 읽을 수 없다.
    'components/SignerAuth.js': `export default function SignerAuth({ data, onChange }) {
  const handleChange = (type, value) => {
    let newData = {};
    Object.assign(newData, { [type]: value });
    onChange && onChange(newData);
  };

  return <input onChange={(e) => handleChange('signer.email', e.target.value)} />;
}
`,
  }));
  const unknown = map.unknownInputs!.filter((u) => u.fn === 'ajaxUpdateSigner');
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].reason, /spread of newData/);
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
  assert.ok(lines.some((l) => /^ {2}\S+ ajaxUpdateSigner signer\.attribute\.pkiSignType components\/SignerPki\.js:\d+ → components\/SignerPki\.js:\d+$/.test(l)), output);
  assert.ok(lines.some((l) => /^input keys unknown \d+.*spread/.test(l)), output);
});

// 검색 화면을 놓고 확인할 키 keyword 를 표시로 덜어 보는 사본.
const SEARCH = `import { useState } from 'react';
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
`;

// 사본의 marksDir 에 표시를 하나 남긴다. codeHash 를 주면 그 화면 코드의 해시다.
function markSearch(configFile: string, status: string, key = 'keyword') {
  const config = loadConfig(configFile);
  const map = JSON.parse(fs.readFileSync(path.join(config.outDir, 'map.json'), 'utf8'));
  const screen = map.screens.find((s: { id: string }) => s.id.includes('Search')).id;
  const part = { kind: 'input', key: { fn: 'ajaxList', key } };
  addMark(config.marksDir, { target: { node: screen, part }, status, note: '', author: 'a', codeHash: map.screens.find((s: { id: string }) => s.id === screen).codeHash });
  return screen;
}

const searchCopy = () => fixtureCopy({ ...base, 'components/Search.js': SEARCH });
const rebuildLines = (configFile: string) => execFileSync(process.execPath, [CLI, 'rebuild', configFile], { encoding: 'utf8' }).split('\n');
const keywordLines = (lines: string[]) => lines.filter((l) => /^ {2}\S+ ajaxList keyword /.test(l));
const checkedCount = (lines: string[]) => lines.find((l) => l.startsWith('input keys to check '))!;

test('a key marked fine leaves the list of keys to check, its count and its line, and the count says how many were left out', () => {
  const configFile = searchCopy();
  const before = rebuildLines(configFile);
  assert.equal(keywordLines(before).length, 1, before.join('\n'));
  assert.match(checkedCount(before), /^input keys to check (\d+)$/);
  const count = Number(checkedCount(before).split(' ')[4]);
  markSearch(configFile, 'fine');
  const after = rebuildLines(configFile);
  assert.deepEqual(keywordLines(after), []);
  assert.equal(checkedCount(after), `input keys to check ${count - 1} (1 marked fine)`);
});

test('a key marked needs-more stays in the list of keys to check, and the count says nothing was left out', () => {
  const configFile = searchCopy();
  const before = rebuildLines(configFile);
  const count = Number(checkedCount(before).split(' ')[4]);
  markSearch(configFile, 'needs-more');
  const after = rebuildLines(configFile);
  assert.equal(keywordLines(after).length, 1, after.join('\n'));
  assert.equal(checkedCount(after), `input keys to check ${count}`);
  assert.ok(!after.some((l) => /marked fine/.test(l)), after.join('\n'));
});

test('a key marked fine comes back once the code of its screen changes', () => {
  const configFile = searchCopy();
  const count = Number(checkedCount(rebuildLines(configFile)).split(' ')[4]);
  markSearch(configFile, 'fine');
  assert.deepEqual(keywordLines(rebuildLines(configFile)), []);
  const search = path.join(path.dirname(configFile), 'client/src/components/Search.js');
  fs.appendFileSync(search, '\n// a line the mark was not saved with\n');
  const after = rebuildLines(configFile);
  assert.equal(keywordLines(after).length, 1, after.join('\n'));
  assert.equal(checkedCount(after), `input keys to check ${count}`);
});

test('a key the screen writes into the state is not listed to check when the API function passes the object it is given whole into the body', async () => {
  // fixture 의 AjaxFunc.ajaxReportArchive 는 받은 data 를 통째로 본문에 싣는다.
  const map = await build(fixtureCopy({
    'components/Search.js': `import { useState } from 'react';
import { ajaxReportArchive } from '_ajax/AjaxFunc';

export default function Search() {
  const [search, setSearch] = useState({ keyword: '', status: '' });

  const handleSearch = (type, value) => {
    setSearch({ ...search, [type]: value });
  };

  const archive = async () => {
    await ajaxReportArchive({ data: search });
  };

  return (
    <div>
      <input onChange={(e) => handleSearch('keyword', e.target.value)} />
      <input onChange={(e) => handleSearch('status', e.target.value)} />
      <button onClick={archive}>archive</button>
    </div>
  );
}
`,
  }, { requestFunction: { ...REQUEST, body: '0.body' } }));
  const calls = map.screens.find((s) => s.id.includes('Search'))!.apiCalls.filter((c) => c.fn === 'ajaxReportArchive');
  assert.equal(calls.length, 1);
  assert.deepEqual(map.apiFunctions.ajaxReportArchive.inputs, { sent: [['0', 'data']], spread: [] });
  assert.deepEqual(map.inputsToCheck!.filter((k) => k.fn === 'ajaxReportArchive'), []);
});

test('a screen key is unknown rather than listed to check when the API function sends its request with fetch instead of requestFunction', async () => {
  const map = await build(fixtureCopy({
    ...base,
    // requestFunction 이 아닌 길로 보낸 요청은 본문에 실린 키를 읽을 수 없다.
    '_ajax/AjaxFunc.js': `${AJAX_FUNC}
export const ajaxFetchOnly = async ({ data }) => { await fetch('/report/fetch', { method: 'POST', body: JSON.stringify(data) }); };
`,
    'components/Search.js': `import { useState } from 'react';
import { ajaxFetchOnly } from '_ajax/AjaxFunc';

export default function Search() {
  const [search, setSearch] = useState({ keyword: '' });

  const handleSearch = (type, value) => {
    setSearch({ ...search, [type]: value });
  };

  const send = async () => {
    await ajaxFetchOnly({ data: search });
  };

  return (
    <div>
      <input onChange={(e) => handleSearch('keyword', e.target.value)} />
      <button onClick={send}>send</button>
    </div>
  );
}
`,
  }));
  assert.equal(map.apiFunctions.ajaxFetchOnly.inputsUnknown, 'sent a request outside requestFunction');
  assert.deepEqual(map.inputsToCheck!.filter((k) => k.fn === 'ajaxFetchOnly'), []);
  const unknown = map.unknownInputs!.filter((u) => u.fn === 'ajaxFetchOnly');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].reason, 'sent a request outside requestFunction');
});

// 요청 본문 자리가 없는 requestFunction. 인자가 요청에 실렸는지 볼 수 없어 입력 키 목록을 만들지 않는다.
const NO_BODY = { import: './_ajax/Ajax', name: 'request', method: '0.info.METHOD', url: '0.info.URL' };

test('without body in requestFunction the map has no input keys to check, no unknown input calls and no calls whose values were not read, and rebuild says to give body', async () => {
  const configFile = fixtureCopy(base, { requestFunction: NO_BODY });
  const map = await build(configFile);
  assert.equal(map.inputsToCheck, undefined);
  assert.equal(map.unknownInputs, undefined);
  assert.equal(map.unreadInputCalls, undefined);
  const lines = rebuildLines(configFile);
  assert.ok(lines.includes('input keys not checked: give body in requestFunction, the place of the request body among the values the request function is given, such as "body": "0.data"'), lines.join('\n'));
});

// 본문에 키를 싣지 않는 API 함수. 이런 함수를 부르는 호출은 세지 않는다.
const AJAX_NO_BODY = `${AJAX_FUNC}
export const ajaxPing = async (value) => Ajax.request({ info: { METHOD: 'GET', URL: '/ping' } });
`;

// 화면 상태가 아니라 매개변수로 받은 값을 API 함수에 넘기는 화면. 어떤 키가 실렸는지 읽을 수 없다.
const PROPS_SIGNER = `import { useState } from 'react';
import { ajaxUpdateSigner, ajaxList, ajaxPing } from '_ajax/AjaxFunc';

export default function SignerEdit(props) {
  const [data, setData] = useState({});

  const save = async () => {
    await ajaxUpdateSigner({ id: props.id, data: props.values });
  };

  const list = async () => {
    await ajaxList();
  };

  const ping = async () => {
    await ajaxPing(props.values);
  };

  return (
    <div>
      <button onClick={save}>save</button>
      <button onClick={list}>list</button>
      <button onClick={ping}>ping</button>
    </div>
  );
}
`;

test('a call whose argument is not screen state but whose API function puts keys in the body is counted as a call duru did not read, while one with no argument or with no body key is not', async () => {
  const map = await build(fixtureCopy({ ...base, 'components/SignerEdit.js': PROPS_SIGNER, '_ajax/AjaxFunc.js': AJAX_NO_BODY }));
  const screen = map.screens.find((s) => s.id.includes('SignerEdit'))!;
  assert.deepEqual(screen.apiCalls.map((c) => c.fn).sort(), ['ajaxList', 'ajaxPing', 'ajaxUpdateSigner']);
  assert.deepEqual(map.unreadInputCalls, [{ screen: screen.id, calls: [{ fn: 'ajaxUpdateSigner', callSite: 'components/SignerEdit.js:8' }] }]);
  assert.ok(map.apiFunctions.ajaxUpdateSigner.inputs!.sent.length > 0);
  assert.equal(map.apiFunctions.ajaxPing.inputs!.sent.length, 0);
});

// useState 가 없는 클래스 컴포넌트 화면. 상태는 this.state 에 있어 인자를 읽지 못한다.
const CLASS_SIGNER = `import { Component } from 'react';
import { ajaxUpdateSigner } from '_ajax/AjaxFunc';

export default class SignerEdit extends Component {
  state = { form: {} };

  save = async () => {
    await ajaxUpdateSigner(this.state.form);
  };

  render() {
    return <button onClick={this.save}>save</button>;
  }
}
`;

test('a class component screen that hands its own state to an API function is counted though the file has no useState state', async () => {
  const map = await build(fixtureCopy({ ...base, 'components/SignerEdit.js': CLASS_SIGNER }));
  const screen = map.screens.find((s) => s.id.includes('SignerEdit'))!;
  assert.deepEqual(map.unreadInputCalls, [{ screen: screen.id, calls: [{ fn: 'ajaxUpdateSigner', callSite: 'components/SignerEdit.js:8' }] }]);
});

test('the rebuild output counts the calls whose screen values were not read, on the screens that have them, and prints the count when it is 0 too', () => {
  const configFile = fixtureCopy({ ...base, 'components/SignerEdit.js': PROPS_SIGNER, '_ajax/AjaxFunc.js': AJAX_NO_BODY });
  const lines = rebuildLines(configFile);
  assert.ok(lines.includes('input calls not read 1 on 1 screens'), lines.join('\n'));
  assert.ok(rebuildLines(fixtureCopy(base)).includes('input calls not read 0 on 0 screens'));
});
