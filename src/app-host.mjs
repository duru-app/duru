import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream';
import vm from 'node:vm';

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

const fillIn = (template, values) =>
  JSON.parse(JSON.stringify(template), (_, v) => (typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m) : v));

const join = (base, rest) => base.replace(/\/+$/, '') + rest;
const LOGIN_TIMEOUT_MS = 15_000;

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

async function logIn(app, account) {
  const password = process.env[account.passwordEnv];
  if (password === undefined) return { error: `환경 변수 ${account.passwordEnv} 에 비밀번호가 없어 로그인하지 않았습니다` };
  let res;
  try {
    res = await fetch(join(app.server, app.login.path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fillIn(app.login.body, { id: account.id, password })),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') return { error: `로그인 요청에 ${LOGIN_TIMEOUT_MS / 1000}초 안에 응답이 없었습니다` };
    return { error: `로그인 요청을 보내지 못했습니다 (${err.cause?.code ?? err.message})` };
  }
  if (!res.ok) return { error: `로그인 요청이 ${res.status} 로 실패했습니다` };
  const token = app.login.token.split('.').reduce((o, k) => o?.[k], await res.json().catch(() => null));
  if (typeof token !== 'string') return { error: `로그인 응답의 ${app.login.token} 에 토큰이 없습니다` };
  const value = fillIn(app.login.storage.value, { token });
  return { token, storage: { key: app.login.storage.key, value: typeof value === 'string' ? value : JSON.stringify(value) } };
}

const literal = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function withScript(html, code) {
  const script = `<script>${code}</script>`;
  const head = html.match(/<head(\s[^>]*)?>/i);
  return head ? html.replace(head[0], () => head[0] + script) : script + html;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
const SETTINGS_RUN_MS = 1000;

function checkedOverrides(list, merged) {
  const fail = (why) => {
    throw new Error(`settings overrides must be a list of { "path", "value" } or { "path", "item", "value" }: ${why}`);
  };
  if (!Array.isArray(list)) fail('not a list');
  return list.map((o) => {
    if (!isObject(o) || !('value' in o) || Object.keys(o).some((k) => !['path', 'item', 'value'].includes(k))) fail(JSON.stringify(o));
    const { path: at, item, value } = o;
    if (!Array.isArray(at) || at.length < 2 || !at.every((k) => typeof k === 'string' && k)) fail(`path ${JSON.stringify(at)} is not a section and a key or more`);
    const unsafe = at.find((k) => UNSAFE_KEYS.includes(k));
    if (unsafe) fail(`path ${JSON.stringify(at)} goes through ${unsafe}`);
    if (!merged.includes(at[0])) fail(`the app does not read section ${at[0]} from the settings file`);
    if (item !== undefined && (!['string', 'number', 'boolean'].includes(typeof item) || typeof value !== 'boolean')) fail(`list item ${JSON.stringify(o)}`);
    return item === undefined ? { path: at, value } : { path: at, item, value };
  });
}

// 설정 파일 뒤에 붙어 브라우저에서 따로 돌기 때문에 바깥 스코프의 변수를 쓰지 않는다.
// 앱이 섹션 아래 한 단계만 합치므로, 키 안쪽만 바꿀 때는 그 키의 값 전체(파일에 있으면 파일 값, 없으면 기본값)를 복사해 고쳐 쓴다.
export function applyOverrides(names, defaults, overrides) {
  const unsafe = ['__proto__', 'constructor', 'prototype'];
  const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const into = (o, k) => {
    if (unsafe.includes(k)) return {};
    return Object.hasOwn(o, k) && isObject(o[k]) ? o[k] : (o[k] = {});
  };
  let target = globalThis;
  for (const n of names) target = into(target, n);
  const copied = new Set();
  for (const { path: [section, ...keys], item, value } of overrides) {
    if ([section, ...keys].some((k) => unsafe.includes(k))) continue;
    const s = into(target, section);
    const id = JSON.stringify([section, keys[0]]);
    if ((keys.length > 1 || item !== undefined) && !copied.has(id)) {
      s[keys[0]] = clone(Object.hasOwn(s, keys[0]) ? s[keys[0]] : defaults[section]?.[keys[0]]);
      copied.add(id);
    }
    let at = s;
    for (const k of keys.slice(0, -1)) at = into(at, k);
    const last = keys[keys.length - 1];
    if (item === undefined) {
      at[last] = clone(value);
      continue;
    }
    const list = Array.isArray(at[last]) ? at[last] : [];
    at[last] = value ? (list.includes(item) ? list : [...list, item]) : list.filter((x) => x !== item);
  }
}

const WINDOW_NAMES = ['window', 'globalThis', 'self'];

// 페이지마다 지우면 앱이 로그인하고 새로 고칠 때 다시 로그아웃되므로, 이 경로로 열 때만 토큰을 지운다.
export const SIGN_OUT_PATH = '/__duru/sign-out';

// incomplete 는 맵의 settingsDefaultsIncomplete 가운데 이 root 에 해당하는 목록이다.
export async function startAppHost(app, { port = 0, rootDefaults = () => ({ values: {}, incomplete: [] }) } = {}) {
  const roles = Object.entries(app.roles ?? {});
  // 동시 로그인을 막는 앱에서 다른 로그인이 끊기지 않도록, 여러 역할이 같은 계정을 써도 계정마다 여기서 한 번만 로그인한다.
  const logins = new Map();
  const logInOnce = (account) => {
    if (!logins.has(account.id)) logins.set(account.id, logIn(app, account));
    return logins.get(account.id);
  };
  const [main, ...roleLogins] = await Promise.all([app.account, ...roles.map(([, account]) => account)].map(logInOnce));
  const fromFolder = !/^https?:/.test(app.files);
  const key = literal(app.login.storage.key);
  const { settingsFile } = app;
  const globalNames = settingsFile?.global.split('.').filter((n, i) => i > 0 || !WINDOW_NAMES.includes(n));
  let overrides = [];

  // 앱 스크립트보다 먼저 돌아야, 앱이 처음 읽을 때 localStorage 에 토큰이 들어 있다.
  const withToken = (html, login) =>
    (login?.storage ? withScript(html, `localStorage.setItem(${key}, ${literal(login.storage.value)});`) : html);

  function signOutPage(res, search) {
    const base = 'http://app.invalid';
    const raw = new URLSearchParams(search).get('to') ?? '/';
    const to = URL.canParse(raw, base) ? new URL(raw, base) : null;
    const target = to?.origin === base && !to.pathname.startsWith('//') ? to.pathname + to.search + to.hash : '/';
    send(res, 200, 'text/html', `<!doctype html><script>localStorage.removeItem(${key});location.replace(location.origin + ${literal(target)});</script>`);
  }

  function withOverrides(text) {
    if (!overrides.length) return text;
    const { values } = rootDefaults();
    const used = {};
    for (const { path: [section, k] } of overrides) {
      if (values[section]?.[k] !== undefined) (used[section] ??= {})[k] = values[section][k];
    }
    return `${text}\n;(${applyOverrides})(${literal(globalNames)}, ${literal(used)}, ${literal(overrides)});\n`;
  }

  async function settingsText() {
    if (fromFolder) {
      const file = path.join(app.files, settingsFile.path);
      return isFile(file) ? fs.readFileSync(file, 'utf8') : '';
    }
    const r = await fetch(join(app.files, settingsFile.path));
    return r.ok ? r.text() : '';
  }

  async function serveSettings(res) {
    send(res, 200, 'application/javascript', withOverrides(await settingsText()));
  }

  async function fileSettings() {
    try {
      const context = vm.createContext({}, { microtaskMode: 'afterEvaluate' });
      vm.runInContext('var window = globalThis, self = globalThis;', context);
      vm.runInContext(await settingsText(), context, { timeout: SETTINGS_RUN_MS });
      const pick = `(() => {
        let o = globalThis;
        for (const n of ${literal(globalNames)}) o = o == null ? undefined : o[n];
        const out = {};
        for (const s of ${literal(settingsFile.merged)}) if (o != null && typeof o[s] === 'object' && o[s] !== null) out[s] = o[s];
        return JSON.stringify(out);
      })()`;
      return { file: JSON.parse(vm.runInContext(pick, context, { timeout: SETTINGS_RUN_MS })), fileError: null };
    } catch (err) {
      return { file: null, fileError: `설정 파일을 돌려 보지 못해 맵의 기본값으로 판단합니다 (${err.message})` };
    }
  }

  // 기본값을 다 읽지 못한 키는 안쪽만 바꾸면 복사본에서 읽지 못한 부분이 빠진다.
  async function checkPartial(list) {
    const { incomplete } = rootDefaults();
    const partial = list.filter(({ path: at, item }) => (at.length > 2 || item !== undefined) && incomplete.some((p) => p.every((k, i) => k === at[i])));
    if (!partial.length) return;
    const { file } = await fileSettings();
    const missing = partial.find(({ path: [section, key] }) => !(isObject(file?.[section]) && Object.hasOwn(file[section], key)));
    if (missing) {
      const [section, key] = missing.path;
      throw new Error(`the default of ${section}.${key} was not read in full from the source and the settings file does not set it, so only the whole of ${section}.${key} can be replaced`);
    }
  }

  function forward(req, res) {
    const target = new URL(join(app.server, req.url));
    const client = target.protocol === 'https:' ? https : http;
    const up = client.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      pipeline(r, res, () => {});
    });
    up.on('error', (err) => {
      if (!res.headersSent) send(res, 502, 'text/plain', err.message);
      else if (!res.writableEnded) res.destroy();
    });
    res.on('close', () => {
      if (!res.writableEnded) up.destroy();
    });
    pipeline(req, up, () => {});
  }

  function serveFolder(res, pathname, login) {
    let file;
    try {
      file = path.join(app.files, decodeURIComponent(pathname));
    } catch {
      file = null;
    }
    // 화면 주소는 앱이 브라우저 안에서 처리하므로, 파일이 없는 주소에는 첫 페이지를 내준다.
    if (!file?.startsWith(app.files + path.sep) || !isFile(file)) file = path.join(app.files, 'index.html');
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    if (type === 'text/html') return send(res, 200, type, withToken(fs.readFileSync(file, 'utf8'), login));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    pipeline(fs.createReadStream(file), res, () => {});
  }

  async function serveDeployed(req, res, login) {
    const r = await fetch(join(app.files, req.url), { headers: { accept: req.headers.accept ?? '*/*' } });
    const type = r.headers.get('content-type') ?? 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': 'no-store' };
    if (type.startsWith('text/html')) {
      res.writeHead(r.status, headers);
      return res.end(withToken(await r.text(), login));
    }
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  }

  // login 이 null 인 포트는 로그아웃 상태로 띄운다.
  async function listen(port, login) {
    const ownHosts = () => [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
    const server = http.createServer(async (req, res) => {
      try {
        if (!ownHosts().includes(req.headers.host)) return send(res, 403, 'text/plain', 'forbidden host');
        const { pathname, search } = new URL(req.url, 'http://host');
        if (!login && pathname === SIGN_OUT_PATH) return signOutPage(res, search);
        if (settingsFile && pathname === settingsFile.path) return await serveSettings(res);
        if (app.apiPaths.some((p) => pathname.startsWith(p))) return forward(req, res);
        if (fromFolder) return serveFolder(res, pathname, login);
        await serveDeployed(req, res, login);
      } catch (err) {
        if (!res.headersSent) send(res, 502, 'text/plain', err.message);
        else res.destroy();
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return server;
  }

  const close = (server) => {
    server.closeAllConnections();
    server.close();
  };
  const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;
  const servers = [];
  const open = async (port, login) => {
    try {
      servers.push(await listen(port, login));
    } catch (err) {
      servers.forEach(close);
      throw err;
    }
    return servers.at(-1);
  };
  // localStorage 는 포트마다 따로 있어서, 포트마다 다른 계정으로 로그인한 앱이 뜬다.
  const signedInServer = await open(port, main);
  const signedOutServer = app.signedOutPaths.length ? await open(0, null) : null;
  const roleServers = [];
  for (const login of roleLogins) roleServers.push(await open(0, login));
  const fetchServer = (apiPath, { method = 'GET', headers = {}, body, signal } = {}) => fetch(join(app.server, apiPath), {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const apiCaller = ({ token }) => (token
    ? (apiPath, options) => fetchServer(apiPath, { ...options, headers: fillIn(app.login.header ?? {}, { token }) })
    : null);
  const fetchApi = apiCaller(main);
  const roleIndex = new Map(roles.map(([role], i) => [role, i]));
  return {
    url: urlOf(signedInServer),
    signedOutUrl: signedOutServer && urlOf(signedOutServer),
    account: app.account.id,
    error: main.error ?? null,
    roles: roles.map(([role, account], i) => ({ role, account: account.id, url: urlOf(roleServers[i]), error: roleLogins[i].error ?? null })),
    fetchApi,
    fetchApiAs: (role) => (roleIndex.has(role) ? apiCaller(roleLogins[roleIndex.get(role)]) : undefined),
    fetchServer,
    get overrides() {
      return overrides;
    },
    async setOverrides(list) {
      if (!settingsFile) throw new Error('app.settingsFile is not set, so settings cannot be changed');
      const checked = checkedOverrides(list, settingsFile.merged);
      await checkPartial(checked);
      overrides = checked;
      return overrides;
    },
    fileSettings,
    close() {
      servers.forEach(close);
    },
  };
}
