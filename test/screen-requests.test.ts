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

function fixtureCopy(files: Record<string, string>, keys: Record<string, unknown> = {}, serverEndpoints: string[] = []) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(copy, 'client/src', rel)), { recursive: true });
    fs.writeFileSync(path.join(copy, 'client/src', rel), text);
  }
  const configFile = path.join(copy, 'config.json');
  const config = { ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ...keys };
  if (serverEndpoints.length) {
    fs.writeFileSync(path.join(copy, 'server.txt'), serverEndpoints.map((line) => line.split(' ').join('\t')).join('\n'));
    config.serverEndpoints = 'server.txt';
  }
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  return configFile;
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const INBOX = '/inbox#Inbox';
const OUTBOX = '/outbox#Outbox';
const ARCHIVE = '/archive#Archive';
const sent = (map: ScreenMap, id: string) => map.screens.find((s) => s.id === id)!.apiCalls.map((c) => [c.fn, ...c.endpoints!.map((e) => `${e.method} ${e.url}`), c.direct ?? false]);
const callsOf = (map: ScreenMap, id: string) => map.calls.filter((c) => c.screens.includes(id)).map((c) => c.id);

const APP = {
  files: 'build',
  server: 'http://localhost:8080',
  apiPaths: ['/api/'],
  login: { path: '/auth/login', body: { id: '{id}', password: '{password}' }, token: 'token', storage: { key: 'auth', value: '{token}' } },
  account: { id: 'duru', passwordEnv: 'DURU_PASSWORD' },
};

const FETCHING_INBOX = `import axios from 'axios';
import * as http from 'axios';
import { useEffect } from 'react';

const LIST = '/api/mail';

export default function Inbox({ id, options, query, config, port }: { id: string; options: RequestInit; query: string; config: object; port: number }) {
  useEffect(() => {
    fetch('/api/mail/unread');
    fetch(\`\${LIST}/\${id}\`, { method: 'delete' });
    fetch('http://localhost:8080/api/mail/flags?kind=all', { ...options, method: 'POST' });
    window.fetch(LIST + '/seen', options);
    fetch('/api/mail/sorted', { method: 'PUT', ...options });
    axios.get('/api/folders');
    axios.post(\`/api/folders/\${id}/move\`, {});
    axios({ url: '/api/labels', method: 'put' });
    axios('/api/labels/all');
    axios.request({ url: '/api/labels/' + id });
    http.patch('/api/labels/color', {}, { baseURL: '/v2' });
    fetch(\`/api/mail\${query}\`);
    axios.get('/api/folders/all', config);
    axios.post('/api/folders/new', {}, { ...config });
    axios({ url: '/api/labels/up', method: 'post', onUploadProgress() {} });
    fetch('//cdn.example.com/lib.js');
    fetch(\`http://localhost:\${port}/api/mail/port\`);
  }, [id]);
  return <main />;
}
`;

test('a request a screen source sends with fetch or axios to an address written in it is a call of that screen, with the method the source gives, GET when it gives none, and no method when the options hide it, while an address on another host, or one with a value joined to its last word, is not read unless the host is the server of the app', async () => {
  const map = await build(fixtureCopy({ 'screens/Inbox.tsx': FETCHING_INBOX }, {}, ['unread GET /api/mail/unread', 'folders POST /api/folders']));
  assert.deepEqual(sent(map, INBOX), [
    ['fetch', 'GET /api/mail/unread', true],
    ['fetch', 'DELETE /api/mail/{?}', true],
    ['fetch', 'POST http://localhost:8080/api/mail/flags?kind=all', true],
    ['window.fetch', 'null /api/mail/seen', true],
    ['fetch', 'null /api/mail/sorted', true],
    ['axios.get', 'GET /api/folders', true],
    ['axios.post', 'POST /api/folders/{?}/move', true],
    ['axios', 'PUT /api/labels', true],
    ['axios', 'GET /api/labels/all', true],
    ['axios.request', 'GET /api/labels/{?}', true],
    ['http.patch', 'PATCH /v2/api/labels/color', true],
    ['fetch', 'GET /api/mail{?}', true],
    ['axios.get', 'GET /api/folders/all', true],
    ['axios.post', 'POST /api/folders/new', true],
    ['axios', 'POST /api/labels/up', true],
    ['fetch', 'GET //cdn.example.com/lib.js', true],
    ['fetch', 'GET http://localhost:{?}/api/mail/port', true],
  ]);
  const inbox = map.screens.find((s) => s.id === INBOX)!;
  assert.deepEqual(inbox.apiCalls[0], {
    fn: 'fetch',
    options: [],
    line: 9,
    guards: [],
    file: 'screens/Inbox.tsx',
    direct: true,
    endpoints: [{ method: 'GET', url: '/api/mail/unread', line: 9, server: { status: 'match', labels: ['unread'], path: '/api/mail/unread' }, callId: 'GET:/api/mail/unread' }],
  });
  assert.deepEqual(map.calls.find((c) => c.id === 'GET:/api/mail/unread'), { id: 'GET:/api/mail/unread', method: 'GET', path: '/api/mail/unread', server: { status: 'match', labels: ['unread'], path: '/api/mail/unread' }, apiFunctions: [], screens: [INBOX], options: [] });
  assert.deepEqual(map.deadCalls.filter((d) => d.screen === INBOX).map((d) => [d.fn, d.method, d.url, d.callSite]).slice(0, 2), [
    ['window.fetch', null, '/api/mail/seen', 'screens/Inbox.tsx:12'],
    ['fetch', null, '/api/mail/sorted', 'screens/Inbox.tsx:13'],
  ]);
  assert.deepEqual(inbox.apiCalls.find((c) => c.fn === 'axios.get')!.endpoints![0].server, { status: 'method-mismatch', candidates: ['folders POST /api/folders'], path: '/api/folders' });
  assert.equal(inbox.dead, true);
  assert.deepEqual(Object.keys(map.apiFunctions), ['ajaxReportArchive', 'ajaxReportSchedule']);
  assert.deepEqual(map.unreadRequests!.map((r) => [r.line, r.url]), [
    [11, 'http://localhost:8080/api/mail/flags?kind=all'],
    [20, '/api/mail{?}'],
    [24, '//cdn.example.com/lib.js'],
    [25, 'http://localhost:{?}/api/mail/port'],
  ]);
  assert.equal(callFinder(map)('POST', 'http://localhost:8080/api/folders/7/move'), 'POST:/api/folders/{?}/move');

  const served = await build(fixtureCopy({ 'screens/Inbox.tsx': FETCHING_INBOX }, { app: APP }));
  assert.deepEqual(sent(served, INBOX)[2], ['fetch', 'POST /api/mail/flags?kind=all', true]);
  assert.deepEqual(served.unreadRequests!.map((r) => r.line), [20, 24, 25]);
});

const MAIL_HOOKS = `import axios from 'axios';

export function useUnread() {
  return fetch('/api/mail/unread');
}

export const useSent = (enabled: boolean) => (enabled ? axios.get('/api/mail/sent') : null);
`;

test('a request in a hook file is a call of the screen that uses the hook and carries the condition it is sent under, and a screen importing the file for another hook does not get it', async () => {
  const map = await build(fixtureCopy({
    'screens/mailHooks.ts': MAIL_HOOKS,
    'screens/Inbox.tsx': `import { useUnread } from './mailHooks';\nexport default function Inbox() {\n  useUnread();\n  return <main />;\n}\n`,
    'screens/Outbox.tsx': `import { useSent } from './mailHooks';\nexport default function Outbox() {\n  useSent(true);\n  return <main />;\n}\n`,
  }));
  assert.deepEqual(sent(map, INBOX), [['fetch', 'GET /api/mail/unread', true]]);
  assert.deepEqual(sent(map, OUTBOX), [['axios.get', 'GET /api/mail/sent', true]]);
  assert.deepEqual(map.screens.find((s) => s.id === OUTBOX)!.apiCalls.map((c) => [c.file, c.line, c.guards]), [['screens/mailHooks.ts', 7, ['enabled']]]);
  assert.deepEqual(map.calls.find((c) => c.id === 'GET:/api/mail/sent')!.screens, [OUTBOX]);
});

const UNREAD_INBOX = `import { buildUrl } from './urls';

export default function Inbox({ url, base }: { url: string; base: string }) {
  const load = () => fetch(url);
  const loadAll = () => Promise.all([fetch(buildUrl('all')), fetch(\`\${base}/mail\`, { method: 'POST' })]);
  return <button onClick={load} onDoubleClick={loadAll} />;
}
`;

test('a request whose address the source does not spell stays on the screen as a call without an address, is listed once in unreadRequests however many screens send it, and extract prints a line for it', async () => {
  const files = {
    'screens/urls.ts': `export const buildUrl = (kind: string) => '/api/' + kind;\n`,
    'screens/Inbox.tsx': UNREAD_INBOX,
    'screens/Outbox.tsx': `import Inbox from './Inbox';\nexport default function Outbox() {\n  return <Inbox url="" base="" />;\n}\n`,
  };
  const configFile = fixtureCopy(files);
  const map = await build(configFile);
  assert.deepEqual(sent(map, INBOX), [['fetch', 'GET null', true], ['fetch', 'GET null', true], ['fetch', 'POST {?}/mail', true]]);
  assert.deepEqual(map.screens.find((s) => s.id === INBOX)!.apiCalls.map((c) => [c.endpoints![0].server.status, c.endpoints![0].callId]), [['unresolved', null], ['unresolved', null], ['unresolved', null]]);
  assert.deepEqual(sent(map, OUTBOX), sent(map, INBOX));
  assert.deepEqual(callsOf(map, INBOX), []);
  assert.deepEqual(map.unreadRequests, [
    { fn: 'fetch', file: 'screens/Inbox.tsx', line: 4, url: null },
    { fn: 'fetch', file: 'screens/Inbox.tsx', line: 5, url: null },
    { fn: 'fetch', file: 'screens/Inbox.tsx', line: 5, url: '{?}/mail' },
  ]);

  const result = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter((l) => l.includes('request')), [
    'requests and navigations written in screen sources 3 | address not read 3',
    '  request fetch ← screens/Inbox.tsx:4: address not read',
    '  request fetch ← screens/Inbox.tsx:5: address not read',
    '  request fetch ← screens/Inbox.tsx:5: address not read, only {?}/mail',
  ]);
  assert.match(result.stdout, /^screens 10 \| api functions 2 \| endpoints match 0 method-mismatch 0 none 0 unresolved 0 unchecked 2$/m);
});

const HTTP = `import axios from 'axios';

export const http = axios.create({ baseURL: '/api' });

http.interceptors.response.use(undefined, (error) => http(error.config));
`;

const OBJECT_INBOX = `import axios from 'axios';
import { http } from '../lib/http';
import { defaults, VERSION } from '../lib/version';

const local = axios.create({ baseURL: '/internal/' });
const nested = local.create();
const elsewhere = local.create({ baseURL: process.env.MAIL_API });
const versioned = axios.create({ baseURL: '/api/' + VERSION });
const preset = axios.create({ ...defaults, timeout: 1 });

export default function Inbox({ id }: { id: string }) {
  const load = () => Promise.all([http.get('/mail'), local.delete(\`mail/\${id}\`), nested.head('/mail'), elsewhere.get('/mail'), versioned.get('/mail'), preset.get('/mail')]);
  return <button onClick={load} />;
}
`;

test('a call of the request object requestFunction names, imported from its file or through a file that exports it again, is read in screen sources without calledApiModules, as is an object made with create with its base address in front, while a request inside the file that makes the request object is not a call of the screen, a base address with an imported name in it, or one hidden in options duru cannot read, leaves the address not read, and an import that names no file is refused', async () => {
  const map = await build(fixtureCopy({
    'lib/http.ts': HTTP,
    'lib/index.ts': `export { http as client } from './http';\n`,
    'lib/version.ts': `export const VERSION = 'v2';\nexport const defaults = { baseURL: '/internal' };\n`,
    'screens/Inbox.tsx': OBJECT_INBOX,
    'screens/Outbox.tsx': `import { client } from '../lib';\nexport default function Outbox() {\n  return <button onClick={() => client.post('/mail/send', {})} />;\n}\n`,
  }, { requestFunction: { import: './lib/http', name: 'http', object: true } }));
  assert.deepEqual(sent(map, INBOX), [
    ['http.get', 'GET /mail', true],
    ['local.delete', 'DELETE /internal/mail/{?}', true],
    ['nested.head', 'HEAD /internal/mail', true],
    ['elsewhere.get', 'GET {?}/mail', true],
    ['versioned.get', 'GET {?}/mail', true],
    ['preset.get', 'GET {?}/mail', true],
  ]);
  assert.deepEqual(sent(map, OUTBOX), [['client.post', 'POST /mail/send', true]]);
  assert.deepEqual(map.unreadRequests, ['elsewhere.get', 'preset.get', 'versioned.get'].map((fn) => ({ fn, file: 'screens/Inbox.tsx', line: 12, url: '{?}/mail' })));
  await assert.rejects(build(fixtureCopy({}, { requestFunction: { import: './lib/htp', name: 'http', object: true } })), /requestFunction\.import \.\/lib\/htp names no file/);
});

const CALLED = {
  calledApiModules: ['contracts/api/index.ts'],
  requestFunction: { import: './contracts/api/request', name: 'executeRequest', method: '0.endpoint.method', url: '0.url' },
};

const PLACED_INBOX = `import { executeRequest } from '../contracts/api/request';
import { contractApi } from '../contracts/api';
import { MAIL, mailPath } from './urls';

const ROOT = '/internal/v2';

export default function Inbox({ id }: { id: string }) {
  const load = () => executeRequest({ endpoint: { method: 'get', path: '' }, url: \`/internal/v2/mail/\${id}\` });
  const loadAny = (url: string) => executeRequest({ endpoint: { method: 'GET', path: '' }, url });
  const named = () => [executeRequest({ endpoint: { method: 'POST', path: '' }, url: '/internal/v2/' + MAIL }), fetch(\`\${ROOT}/\${mailPath(id)}/mail\`), fetch(\`\${ROOT}/mail\`)];
  return <button onClick={() => [load(), loadAny(''), named(), contractApi.loadList()]} />;
}
`;

test('a call of the request function requestFunction names gives the method and address at the places the config names, beside the calls of the API methods the same screen makes, and an address with a piece from an imported name or from a function imported by name is not read, since that piece is text and not a path variable', async () => {
  const map = await build(fixtureCopy({ 'screens/urls.ts': `export const MAIL = 'mail';\nexport const mailPath = (id: string) => 'box/' + id;\n`, 'screens/Inbox.tsx': PLACED_INBOX }, CALLED));
  assert.deepEqual(sent(map, INBOX), [
    ['executeRequest', 'GET /internal/v2/mail/{?}', true],
    ['executeRequest', 'GET null', true],
    ['executeRequest', 'POST /internal/v2/{?}', true],
    ['fetch', 'GET /internal/v2/{?}/mail', true],
    ['fetch', 'GET /internal/v2/mail', true],
    ['contractApi.loadList', 'GET /internal/v2/workspace/{?}/contract/list', false],
  ]);
  assert.deepEqual(map.unreadRequests, [
    { fn: 'executeRequest', file: 'screens/Inbox.tsx', line: 9, url: null },
    { fn: 'executeRequest', file: 'screens/Inbox.tsx', line: 10, url: '/internal/v2/{?}' },
    { fn: 'fetch', file: 'screens/Inbox.tsx', line: 10, url: '/internal/v2/{?}/mail' },
  ]);
  assert.deepEqual(callsOf(map, INBOX).filter((id) => id.includes('mail')), ['GET:/internal/v2/mail', 'GET:/internal/v2/mail/{?}']);
});

const MOVING_INBOX = `import { useFetcher, useLocation } from 'react-router-dom';
import { Form as RouteForm } from 'react-router-dom';
import { Form } from './Form';
import { EXPORT, exportPath } from './urls';

const IMPORT = '/api/mail/import';

export default function Inbox({ id, token, url, base }: { id: string; token: string; url: string; base: string }) {
  const print = () => window.open('/api/mail/print');
  const start = () => {
    location.href = '/oauth/start';
  };
  const raw = () => window.location.assign(\`/api/mail/\${id}/raw\`);
  const leave = () => {
    document.location = '/signout';
  };
  const elsewhere = () => [window.open(url), window.open(base + '/mail'), window.location.replace(\`/api/mail/report-\${id}.xlsx\`)];
  return (
    <main>
      <a href="/api/mail/export">Export</a>
      <a href={\`/api/mail/\${id}/download?token=\${token}&kind=zip#top\`}>Download</a>
      <form action="/api/mail/import" method="post" />
      <Form action={IMPORT} />
      <Form.Inline action="/api/mail/filter" method={url} />
      <Form action="/outbox" method="POST" />
      <RouteForm action="/api/mail/route" method="post" />
      <a href="/files/terms.pdf">Terms</a>
      <a href={'/api/mail/' + EXPORT}>Named</a>
      <a href={\`/api/mail/\${exportPath(id)}\`}>Built</a>
      <form action={'/api/mail/' + EXPORT} method="post" />
      <form action={url} method="POST" />
      <form action="https://pay.example.com/charge" method="post" />
      <a href="https://example.com/api/mail/export">Docs</a>
      <a href="//cdn.example.com/api/mail/export">Guide</a>
      <a href="api/mail/export">Beside</a>
      <Form action="import" />
      <a href="#top">Top</a>
      <a href="?page=2">Next</a>
      <a href="mailto:mail@example.com">Mail</a>
      <a href={url}>Open</a>
      <a href="/outbox">Outbox</a>
      <a href={\`/archive?from=\${id}\`}>Archive</a>
      <a href="/">Home</a>
      <a href="http://localhost:8080/api/mail/own">Own</a>
      <S.Form action="/api/mail/styled" method="post" />
      <Elsewhere />
      <button onClick={() => [print(), start(), raw(), leave(), elsewhere()]} />
    </main>
  );
}

const S = { Form };

export function Elsewhere() {
  const location = useLocation();
  const fetcher = useFetcher();
  const { Form: FetcherForm } = useFetcher();
  location.href = '/api/mail/local';
  return [<fetcher.Form action="/api/mail/fetched" method="post" />, <FetcherForm action="/api/mail/fetched" method="post" />];
}
`;

const MOVING_FILES = {
  'screens/Form.tsx': `export const Form = () => null;\n`,
  'screens/urls.ts': `export const EXPORT = 'export';\nexport const exportPath = (id: string) => id + '/export';\n`,
  'screens/Inbox.tsx': MOVING_INBOX,
};
const SERVER = ['print GET /api/mail/print', 'oauth GET /oauth/start', 'raw GET /api/mail/{id}/raw', 'signout POST /signout', 'export GET /api/mail/export', 'download GET /api/mail/{id}/download', 'import POST /api/mail/import', 'filter GET /api/mail/filter', 'outbox GET /outbox', 'archive GET /archive', 'local GET /api/mail/local', 'route POST /api/mail/route', 'fetched POST /api/mail/fetched', 'styled POST /api/mail/styled', 'own GET /api/mail/own'];

test('an address a screen source moves the browser to, by href, the action of a form, window.open or an address given to location, is a call when it is a path from the top of the site that the server list holds, with GET or the method of the form, while a path the list lacks, another site, an address read from the current page, a route of the app, an address a value or an imported name decides, a Form of react-router, of what useFetcher gives or of any value that is not imported, and a local variable named location are not, except that a form posting to an address not read stays as a request without an address', async () => {
  const map = await build(fixtureCopy(MOVING_FILES, {}, SERVER));
  assert.deepEqual(sent(map, INBOX), [
    ['window.open', 'GET /api/mail/print', true],
    ['location.href', 'GET /oauth/start', true],
    ['window.location.assign', 'GET /api/mail/{?}/raw', true],
    ['document.location', 'GET /signout', true],
    ['<a href>', 'GET /api/mail/export', true],
    ['<a href>', 'GET /api/mail/{?}/download?kind=zip', true],
    ['<form action>', 'POST /api/mail/import', true],
    ['<Form action>', 'GET /api/mail/import', true],
    ['<Form.Inline action>', 'null /api/mail/filter', true],
    ['<Form action>', 'POST /outbox', true],
    ['<form action>', 'POST /api/mail/{?}', true],
    ['<form action>', 'POST null', true],
  ]);
  assert.deepEqual(map.unreadRequests, [{ fn: '<form action>', file: 'screens/Inbox.tsx', line: 30, url: '/api/mail/{?}' }, { fn: '<form action>', file: 'screens/Inbox.tsx', line: 31, url: null }]);
  assert.deepEqual(callsOf(map, INBOX), ['GET:/api/mail/export', 'GET:/api/mail/import', 'GET:/api/mail/print', 'GET:/api/mail/{id}/download', 'GET:/api/mail/{id}/raw', 'GET:/oauth/start', 'GET:/signout', 'POST:/api/mail/import', 'POST:/outbox', '{?}:/api/mail/filter']);
  assert.deepEqual(map.deadCalls.filter((d) => d.screen === INBOX), []);
});

test('without a server list, a move by GET or by a method the source does not give is a call only under a path of app.apiPaths, on this site or written with the host of app.server, while a form posting is a call wherever it goes', async () => {
  const bare = await build(fixtureCopy(MOVING_FILES));
  assert.deepEqual(sent(bare, INBOX), [['<form action>', 'POST /api/mail/import', true], ['<Form action>', 'POST /outbox', true], ['<form action>', 'POST /api/mail/{?}', true], ['<form action>', 'POST null', true]]);
  const prefixed = await build(fixtureCopy(MOVING_FILES, { app: APP }));
  assert.deepEqual(sent(prefixed, INBOX).map(([fn, request]) => `${fn} ${request}`), [
    'window.open GET /api/mail/print',
    'window.location.assign GET /api/mail/{?}/raw',
    '<a href> GET /api/mail/export',
    '<a href> GET /api/mail/{?}/download?kind=zip',
    '<form action> POST /api/mail/import',
    '<Form action> GET /api/mail/import',
    '<Form.Inline action> null /api/mail/filter',
    '<Form action> POST /outbox',
    '<form action> POST /api/mail/{?}',
    '<form action> POST null',
    '<a href> GET /api/mail/own',
  ]);
});

test('with apiPathPrefix, a path the server list holds without the prefix is not a move to the server unless the address starts with the prefix', async () => {
  const files = { 'screens/Inbox.tsx': `export default function Inbox() {\n  return [<a href="/settings/ai" />, <a href="/api/settings/ai" />];\n}\n` };
  const map = await build(fixtureCopy(files, { apiPathPrefix: '/api/' }, ['settings GET /settings/ai']));
  assert.deepEqual(map.screens.find((s) => s.id === INBOX)!.apiCalls.map((c) => [c.endpoints![0].url, c.endpoints![0].callId]), [['/api/settings/ai', 'GET:/settings/ai']]);
});

test('a screen whose sources send no request of their own has the same calls with or without a request function, and the usage guide and the agent skill name the line extract prints for a request it could not read', async () => {
  const plain = await build(fixtureCopy({}));
  const withFunction = await build(fixtureCopy({ 'lib/http.ts': HTTP }, { requestFunction: { import: './lib/http', name: 'http', object: true } }));
  assert.deepEqual(withFunction.screens.map((s) => s.apiCalls), plain.screens.map((s) => s.apiCalls));
  assert.equal(plain.screens.some((s) => s.apiCalls.some((c) => c.direct)), false);
  assert.deepEqual(sent(plain, ARCHIVE), []);

  const readme = fs.readFileSync(path.join(import.meta.dirname, '../README.md'), 'utf8');
  const skill = fs.readFileSync(path.join(import.meta.dirname, '../skills/duru/SKILL.md'), 'utf8');
  for (const text of ['`request <how> ← <file>:<line>: address not read`', '`unreadRequests`', '`"direct": true`']) {
    assert.ok(readme.includes(text), `README lacks ${text}`);
    assert.ok(skill.includes(text), `SKILL lacks ${text}`);
  }
});
