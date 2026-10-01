import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SIGN_OUT_PATH, startAppHost } from './app-host.mjs';
import { UNKNOWN } from './client.mjs';
import { buildFlow } from './flow.mjs';
import { addMark, classifyMarks, loadMarks } from './marks.mjs';
import { DEPTHS } from './test-links.mjs';

const PAGE = path.join(import.meta.dirname, 'review-page.html');
const BODY_LIMIT = 64 * 1024;

export function gitUserName(cwd) {
  try {
    return execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist — run "duru rebuild" first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appLink(appUrl, routePath) {
  if (!appUrl || /[:*]/.test(routePath) || routePath.includes(UNKNOWN)) return null;
  return appUrl.replace(/\/+$/, '') + routePath;
}

function screenCallOptions(screen, callsById) {
  const sent = new Map();
  for (const c of screen.apiCalls) {
    for (const e of c.endpoints ?? []) {
      if (!e.callId) continue;
      if (!sent.has(e.callId)) sent.set(e.callId, new Set());
      for (const o of c.options ?? []) sent.get(e.callId).add(o.key);
    }
  }
  return Object.fromEntries([...sent].map(([id, keys]) => [id, callsById.get(id).options.filter((o) => keys.has(o.key) || o.sources.includes('config'))]));
}

export function reviewData(config, author, app = null) {
  const map = readJson(path.join(config.outDir, 'map.json'));
  const tests = readJson(path.join(config.outDir, 'tests.json'));
  const callsById = new Map(map.calls.map((c) => [c.id, c]));
  for (const s of map.screens) s.callOptions = screenCallOptions(s, callsById);
  return {
    map,
    tests,
    marks: classifyMarks(loadMarks(config.marksDir), map),
    flow: buildFlow(map, tests),
    appUrl: config.appUrl ?? null,
    app: app && {
      url: app.url,
      signedOutUrl: app.signedOutUrl,
      signOutPath: SIGN_OUT_PATH,
      unknownSignedOutPaths: config.app.signedOutPaths.filter((p) => !map.screens.some((s) => s.path === p)),
      account: app.account,
      error: app.error,
    },
    appLinks: Object.fromEntries(map.screens.map((s) => {
      const signedOut = app && config.app.signedOutPaths.includes(s.path);
      return [s.id, appLink(signedOut ? app.signedOutUrl : (app?.url ?? config.appUrl), s.path)];
    })),
    routesFile: config.routesFile,
    depths: DEPTHS,
    author,
  };
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > BODY_LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export async function startReviewServer(config, { port = 0, author = null, onDone = () => {} } = {}) {
  const app = config.app && (await startAppHost(config.app));
  // 다른 사이트가 사용자의 브라우저로 표시를 써 넣거나 리뷰를 끝내거나(JSON 이 아닌 요청), 자기 도메인을 이 주소로 돌려 맵을 읽어 가는 것(다른 Host)을 막는다.
  const ownHosts = () => [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
  const isJson = (req) => req.headers['content-type']?.startsWith('application/json');
  const server = http.createServer(async (req, res) => {
    try {
      if (!ownHosts().includes(req.headers.host)) return send(res, 403, 'text/plain', 'forbidden host');
      if (req.method === 'POST' && req.url === '/api/end') {
        if (!isJson(req)) return send(res, 415, 'text/plain', 'expected application/json');
        // onDone 이 예외를 던지면 리뷰를 끝내지 않고 500 으로 응답한다.
        const finish = onDone();
        if (finish) res.on('close', finish);
        return send(res, 200, 'text/plain', 'review ended');
      }
      if (req.method === 'GET' && req.url === '/') return send(res, 200, 'text/html', fs.readFileSync(PAGE, 'utf8'));
      if (req.method === 'GET' && req.url === '/api/data') return send(res, 200, 'application/json', JSON.stringify(reviewData(config, author, app)));
      const url = new URL(req.url, 'http://host');
      if (req.method === 'GET' && url.pathname === '/api/flow' && url.searchParams.has('from')) {
        const map = readJson(path.join(config.outDir, 'map.json'));
        const from = url.searchParams.get('from');
        if (!map.screens.some((s) => s.id === from)) return send(res, 404, 'text/plain', `unknown screen "${from}"`);
        return send(res, 200, 'application/json', JSON.stringify(buildFlow(map, readJson(path.join(config.outDir, 'tests.json')), { from })));
      }
      if (req.method === 'POST' && req.url === '/api/marks') {
        if (!isJson(req)) return send(res, 415, 'text/plain', 'expected application/json');
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch (err) {
          return send(res, 400, 'text/plain', err.message);
        }
        try {
          const mark = addMark(config.marksDir, { ...input, author: author ?? input.author });
          return send(res, 201, 'application/json', JSON.stringify(mark));
        } catch (err) {
          return send(res, 400, 'text/plain', err.message);
        }
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (err) {
      send(res, 500, 'text/plain', err.message);
    }
  });
  if (app) server.on('close', () => app.close());
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      app?.close();
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
