import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { screenCases } from './access.mjs';
import { SIGN_OUT_PATH, startAppHost } from './app-host.ts';
import { acceptCandidate, discardCandidate, storyCandidates } from './candidates.mjs';
import { isPlainObject } from './config.mjs';
import { buildFlow } from './flow.ts';
import { addJudgment, applyJudgments, loadJudgments } from './judgments.mjs';
import { addMark, classifyMarks, loadMarks } from './marks.mjs';
import { asIsPath, opensAsIs, preparePathValues, unknownPathValues } from './path-values.mjs';
import { addStory, editStory } from './stories.mjs';
import { checkScreens, checkStoryFiles } from './story-paths.mjs';
import { DEPTHS } from './test-links.ts';

const PAGE = path.join(import.meta.dirname, 'review-page.html');
const BODY_LIMIT = 64 * 1024;
const STORY_POSTS = ['/api/candidates/accept', '/api/candidates/discard', '/api/stories/edit', '/api/stories/check', '/api/stories/add'];

function gitUserName(cwd) {
  try {
    return execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function computerUserName() {
  let name = '';
  try {
    name = os.userInfo().username?.trim() ?? '';
  } catch {}
  return name || process.env.USER?.trim() || process.env.USERNAME?.trim() || 'unknown';
}

export function reviewAuthor(config, { gitName = gitUserName, userName = computerUserName } = {}) {
  if (config.author) return { name: config.author, source: 'config' };
  const git = gitName(config.configDir);
  if (git) return { name: git, source: 'git' };
  return { name: userName(), source: 'user' };
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist — run "duru rebuild" first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appLink(appUrl, routePath, given) {
  if (!appUrl || !opensAsIs(routePath, given)) return null;
  return appUrl.replace(/\/+$/, '') + asIsPath(routePath, given);
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
  return Object.fromEntries([...sent].map(([id, keys]) => [id, callsById.get(id).options.filter((o) => keys.has(o.key) || o.sources.includes('type') || o.sources.includes('config'))]));
}

const isStaleMap = (map) => Array.isArray(map?.screens) && map.screens.some((s) => !s.routeFile);
const staleMapError = (mapFile) => new Error(`${mapFile} was built by a duru that did not record the route file of each screen — run "duru rebuild"`);

function readMap(mapFile) {
  const map = readJson(mapFile);
  if (isStaleMap(map)) throw staleMapError(mapFile);
  return map;
}

const judgedTests = (config) => applyJudgments(readJson(path.join(config.outDir, 'tests.json')), loadJudgments(config.judgmentsDir).judgments);

export function reviewData(config, author, app = null, fileSettings = null) {
  const mapFile = path.join(config.outDir, 'map.json');
  const map = readMap(mapFile);
  const tests = judgedTests(config);
  const callsById = new Map(map.calls.map((c) => [c.id, c]));
  for (const s of map.screens) {
    s.callOptions = screenCallOptions(s, callsById);
    s.cases = screenCases(s.access);
  }
  const { ids: storyIds, ...stories } = checkStoryFiles(map, config.storiesDir, mapFile, tests);
  return {
    map,
    tests,
    marks: classifyMarks(loadMarks(config.marksDir), map, storyIds),
    stories,
    candidates: storyCandidates(config, map, mapFile),
    storiesDir: config.storiesDir,
    flow: buildFlow(map, tests),
    appUrl: config.appUrl ?? null,
    app: app && {
      url: app.url,
      signedOutUrl: app.signedOutUrl,
      signOutPath: SIGN_OUT_PATH,
      signedOutPaths: config.app.signedOutPaths,
      unknownSignedOutPaths: config.app.signedOutPaths.filter((p) => !map.screens.some((s) => s.path === p)),
      unknownPathValues: unknownPathValues(map, config.app.pathValues),
      account: app.account,
      roles: app.roles,
      error: app.error,
      settings: config.app.settingsFile && { root: config.app.settingsFile.root, merged: config.app.settingsFile.merged, overrides: app.overrides, ...fileSettings },
    },
    appLinks: Object.fromEntries(map.screens.map((s) => {
      const signedOut = app && config.app.signedOutPaths.includes(s.path);
      return [s.id, appLink(signedOut ? app.signedOutUrl : (app?.url ?? config.appUrl), s.path, config.app?.pathValues?.[s.path])];
    })),
    depths: DEPTHS,
    author: author?.name ?? null,
    authorSource: author?.source ?? null,
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

export async function startReviewServer(config, { port = 0, author = reviewAuthor(config), onDone = () => {} } = {}) {
  const mapFile = path.join(config.outDir, 'map.json');
  // 없거나 아직 쓰는 중인 맵은 페이지가 요청할 때 알리고, 예전 형식의 맵만 서버를 띄우기 전에 알린다.
  let onDisk = null;
  try {
    onDisk = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  } catch {}
  if (isStaleMap(onDisk)) throw staleMapError(mapFile);
  const rootDefaults = () => {
    const map = readMap(mapFile);
    const root = config.app.settingsFile?.root;
    return { values: map.settingsDefaults?.[root] ?? {}, incomplete: map.settingsDefaultsIncomplete?.[root] ?? [] };
  };
  const app = config.app && (await startAppHost(config.app, { rootDefaults }));
  // 다른 사이트가 사용자의 브라우저로 표시를 써 넣거나 리뷰를 끝내거나(JSON 이 아닌 요청), 자기 도메인을 이 주소로 돌려 맵을 읽어 가는 것(다른 Host)을 막는다.
  const ownHosts = () => [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
  const isJson = (req) => req.headers['content-type']?.startsWith('application/json');
  const saves = { '/api/marks': (input) => addMark(config.marksDir, input), '/api/judgments': (input) => addJudgment(config.judgmentsDir, input) };
  const sendPathValues = async (res, id, role, typed = {}) => {
    const map = readMap(mapFile);
    const screen = map.screens.find((s) => s.id === id);
    if (!screen) return send(res, 404, 'text/plain', `unknown screen "${id}"`);
    const fetchApi = role ? app?.fetchApiAs(role) : app?.fetchApi;
    if (fetchApi === undefined && role) return send(res, 404, 'text/plain', `unknown role "${role}"`);
    return send(res, 200, 'application/json', JSON.stringify(await preparePathValues(map, screen, config.app?.pathValues ?? {}, fetchApi ?? null, role, app?.fetchServer, typed)));
  };
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
      if (req.method === 'GET' && req.url === '/api/data') {
        const fileSettings = app && config.app.settingsFile ? await app.fileSettings() : null;
        return send(res, 200, 'application/json', JSON.stringify(reviewData(config, author, app, fileSettings)));
      }
      const url = new URL(req.url, 'http://host');
      if (req.method === 'GET' && url.pathname === '/api/flow' && url.searchParams.has('from')) {
        const map = readMap(mapFile);
        const from = url.searchParams.get('from');
        if (!map.screens.some((s) => s.id === from)) return send(res, 404, 'text/plain', `unknown screen "${from}"`);
        return send(res, 200, 'application/json', JSON.stringify(buildFlow(map, judgedTests(config), { from })));
      }
      if (req.method === 'GET' && url.pathname === '/api/path-values' && url.searchParams.has('screen')) {
        return await sendPathValues(res, url.searchParams.get('screen'), url.searchParams.get('role'));
      }
      if (req.method === 'POST' && req.url === '/api/path-values') {
        if (!isJson(req)) return send(res, 415, 'text/plain', 'expected application/json');
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch (err) {
          return send(res, 400, 'text/plain', err.message);
        }
        const { screen, role = null, typed } = isPlainObject(input) ? input : {};
        if (typeof screen !== 'string' || !(role === null || typeof role === 'string') || !isPlainObject(typed) || !Object.values(typed).every((v) => typeof v === 'string')) {
          return send(res, 400, 'text/plain', 'expected { "screen", "role", "typed" } with the typed values as text');
        }
        return await sendPathValues(res, screen, role, typed);
      }
      if (req.method === 'POST' && req.url === '/api/settings') {
        if (!isJson(req)) return send(res, 415, 'text/plain', 'expected application/json');
        if (!app) return send(res, 404, 'text/plain', 'no app is served');
        try {
          const overrides = await app.setOverrides(JSON.parse(await readBody(req))?.overrides);
          return send(res, 200, 'application/json', JSON.stringify({ overrides }));
        } catch (err) {
          return send(res, 400, 'text/plain', err.message);
        }
      }
      if (req.method === 'POST' && STORY_POSTS.includes(req.url)) {
        if (!isJson(req)) return send(res, 415, 'text/plain', 'expected application/json');
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch (err) {
          return send(res, 400, 'text/plain', err.message);
        }
        if (!isPlainObject(input)) return send(res, 400, 'text/plain', 'expected a JSON object');
        if (req.url === '/api/stories/edit') {
          try {
            return send(res, 200, 'application/json', JSON.stringify(editStory(config.storiesDir, input.id, input)));
          } catch (err) {
            return send(res, 400, 'text/plain', err.message);
          }
        }
        if (req.url === '/api/stories/check' || req.url === '/api/stories/add') {
          try {
            const checked = checkScreens(readMap(mapFile), mapFile, input.screens);
            if (req.url === '/api/stories/check') return send(res, 200, 'application/json', JSON.stringify(checked));
            const { id, name, memo, screens } = input;
            return send(res, 201, 'application/json', JSON.stringify(addStory(config.storiesDir, { id, name, memo, screens, author: author.name })));
          } catch (err) {
            return send(res, 400, 'text/plain', err.message);
          }
        }
        const candidate = storyCandidates(config, readMap(mapFile), mapFile).list.find((c) => c.source.record === input.record);
        if (!candidate) return send(res, 404, 'text/plain', `후보 ${input.record} 가 없습니다`);
        try {
          const written = req.url === '/api/candidates/accept'
            ? acceptCandidate(config.storiesDir, candidate, { id: input.id, name: input.name, author: author.name })
            : discardCandidate(config.storiesDir, candidate, { reason: input.reason, author: author.name });
          return send(res, 201, 'application/json', JSON.stringify(written));
        } catch (err) {
          return send(res, 400, 'text/plain', err.message);
        }
      }
      if (req.method === 'POST' && Object.hasOwn(saves, req.url)) {
        if (!isJson(req)) return send(res, 415, 'text/plain', 'expected application/json');
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch (err) {
          return send(res, 400, 'text/plain', err.message);
        }
        try {
          const saved = saves[req.url]({ ...input, author: author.name });
          return send(res, 201, 'application/json', JSON.stringify(saved));
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
