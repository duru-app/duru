import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream';

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

// 페이지마다 지우면 앱이 로그인하고 새로 고칠 때 다시 로그아웃되므로, 이 경로로 열 때만 토큰을 지운다.
export const SIGN_OUT_PATH = '/__duru/sign-out';

export async function startAppHost(app, { port = 0 } = {}) {
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
  const apiCaller = ({ token }) => (token
    ? (apiPath, { method = 'GET', body, signal } = {}) => fetch(join(app.server, apiPath), {
      method,
      headers: { ...fillIn(app.login.header ?? {}, { token }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
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
    close() {
      servers.forEach(close);
    },
  };
}
