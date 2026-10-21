import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { screenCases, settingConditionName } from './access.ts';
import { SIGN_OUT_PATH, startAppHost } from './app-host.ts';
import { baselineLabel, compareMaps, readBaseline } from './baseline.ts';
import { screenRoutes } from './address-match.ts';
import { acceptCandidate, addCommentCandidate, candidatePlace, discardCandidate, pickCandidateLine, saveVisitRecord, storyCandidates, unacceptStory, undiscardCandidate } from './candidates.ts';
import { answerProposal, casesWithoutTests, caseTargets, commandCaseRule, exclusionOf, pickedKinds, ProposalChanged } from './case-targets.ts';
import { isPlainObject } from './config.ts';
import type { CaseKind } from './config.ts';
import { nodeHashes, recordedState } from './code-state.ts';
import { buildFlow } from './flow.ts';
import type { MapCall, MapScreen, ScreenMap } from './map.ts';
import { addJudgment, applyJudgments, loadJudgments, reference } from './judgments.ts';
import { addMark, addReply, CASE_STATUSES, classifyMarks, loadMarks, mergedStatus, recordKind, targetsOf } from './marks.ts';
import { addNeed, checkNeeds, editNeed } from './needs.ts';
import type { Mark } from './marks.ts';
import { linkKey, locateOrder, locatePart, locateStoryPart } from './parts.ts';
import type { StoryPath } from './parts.ts';
import { asIsPath, opensAsIs, preparePathValues, unknownPathValues } from './path-values.ts';
import { settingChange } from './setting-changes.ts';
import { addStory, editStory, FileChanged, writeStoryFields, writeStorySteps } from './stories.ts';
import { checkScreens, checkStoryFiles } from './story-paths.ts';
import { DEPTHS } from './test-links.ts';

const PAGE_DIR = path.join(import.meta.dirname, 'review-page');
export const PAGE_PARTS = [
  'start.html',
  'style.css',
  'body.html',
  'script-common.js',
  'script-header-screens.js',
  'script-story-list.js',
  'script-tests-tags-verdicts.js',
  'script-app-pane.js',
  'script-settings-bar.js',
  'script-step-cards.js',
  'script-story-fields.js',
  'script-story-steps.js',
  'script-untagged-center.js',
  'script-case-kinds.js',
  'script-story-center.js',
  'script-new-story.js',
  'script-walk.js',
  'script-point-box.js',
  'script-center-right.js',
  'script-talk.js',
  'script-access-links.js',
  'script-saving.js',
  'script-flow-needs.js',
  'script-flow-layout.js',
  'script-flow-boxes.js',
  'script-flow-canvas.js',
  'script-flow-controls.js',
  'script-flow-render.js',
  'script-render-live.js',
  'end.html',
];
const BODY_LIMIT = 64 * 1024;
const STORIES_SETTLE_MS = 100;
const STORY_POSTS = ['/api/candidates/add', '/api/candidates/accept', '/api/candidates/discard', '/api/candidates/lines', '/api/candidates/undiscard', '/api/stories/edit', '/api/stories/fields', '/api/stories/steps', '/api/stories/unaccept', '/api/stories/check', '/api/stories/add', '/api/needs/add', '/api/needs/edit', '/api/records'];

function gitUserName(cwd: string) {
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

export interface ReviewAuthor {
  name: string;
  source: string;
}

export function reviewAuthor(config: any, { gitName = gitUserName, userName = computerUserName }: { gitName?: (cwd: string) => string | null; userName?: () => string } = {}): ReviewAuthor {
  if (config.author) return { name: config.author, source: 'config' };
  const git = gitName(config.configDir);
  if (git) return { name: git, source: 'git' };
  return { name: userName(), source: 'user' };
}

type AppHost = Awaited<ReturnType<typeof startAppHost>>;

function readJson(file: string) {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist — run "duru rebuild" first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appLink(appUrl: string | null | undefined, routePath: string, given: any) {
  if (!appUrl || !opensAsIs(routePath, given)) return null;
  return appUrl.replace(/\/+$/, '') + asIsPath(routePath, given);
}

function screenCallOptions(screen: MapScreen, callsById: Map<string, MapCall>) {
  const sent = new Map<string, Set<string>>();
  for (const c of screen.apiCalls) {
    for (const e of c.endpoints ?? []) {
      if (!e.callId) continue;
      if (!sent.has(e.callId)) sent.set(e.callId, new Set());
      for (const o of c.options ?? []) sent.get(e.callId)!.add(o.key);
    }
  }
  return Object.fromEntries([...sent].map(([id, keys]) => [id, callsById.get(id)!.options.filter((o) => keys.has(o.key) || o.sources.includes('type') || o.sources.includes('config'))]));
}

const isStaleMap = (map: any) => Array.isArray(map?.screens) && map.screens.some((s: any) => !s.routeFile);
const staleMapError = (mapFile: string) => new Error(`${mapFile} was built by a duru that did not record the route file of each screen — run "duru rebuild"`);

function readMap(mapFile: string): ScreenMap {
  const map = readJson(mapFile);
  if (isStaleMap(map)) throw staleMapError(mapFile);
  return map;
}

const readTests = (config: any) => readJson(path.join(config.outDir, 'tests.json'));

export function readCaseTargets(config: any) {
  const map = readMap(path.join(config.outDir, 'map.json'));
  const caseMarks = loadMarks(config.marksDir).filter((m) => targetsOf(m).some((t) => t.case !== undefined));
  const { attached } = classifyMarks(caseMarks, map, [], Object.keys(config.caseKinds));
  return { map, attached, targets: caseTargets(map, config.caseKinds, attached) };
}

export interface CaseDecision {
  kind: string;
  node: string;
  status: string;
  note: string;
}

export function writeCaseMark(config: any, { kind, node, status, note }: CaseDecision, author: string) {
  const { map, attached } = readCaseTargets(config);
  const rule = commandCaseRule(map, config.caseKinds, attached, { kind, node, status, note });
  return addMark(config.marksDir, { target: { node, case: kind }, status, note, rule, author, via: 'duru case', codeHash: nodeHashes(map).get(node) });
}

export function writeCaseAnswer(config: any, input: unknown, author: string) {
  const { kind, node, of, answer } = (isPlainObject(input) ? input : {}) as Record<string, unknown>;
  if (typeof kind !== 'string' || typeof node !== 'string' || typeof of !== 'string' || (answer !== 'accept' && answer !== 'revert')) {
    throw new Error('expected { "kind", "node", "of", "answer" } with the kind, the screen or call ID and the ID of the agent\'s mark as text and the answer accept or revert');
  }
  const { map, attached } = readCaseTargets(config);
  return addMark(config.marksDir, { ...answerProposal(map, config.caseKinds, attached, { kind, node, of, answer }), author, codeHash: nodeHashes(map).get(node) });
}

export function writeCommentCandidate(config: any, input: unknown) {
  const mapFile = path.join(config.outDir, 'map.json');
  const traced = fs.existsSync(path.join(config.outDir, 'tests.json')) ? readTests(config).traced : [];
  return addCommentCandidate(config, readMap(mapFile), mapFile, traced, isPlainObject(input) ? input as Record<string, unknown> : {});
}

function caseDecision(input: unknown): CaseDecision {
  const { kind, node, status, note = '' } = (isPlainObject(input) ? input : {}) as Record<string, unknown>;
  if (typeof kind !== 'string' || typeof node !== 'string' || !CASE_STATUSES.includes(status as string) || typeof note !== 'string') {
    throw new Error('expected { "kind", "node", "status", "note" } with the kind, the screen or call ID and the note as text and the status needed or not-needed');
  }
  return { kind, node, status: status as string, note };
}

export function reviewData(config: any, author: ReviewAuthor | null, app: AppHost | null = null, fileSettings: Awaited<ReturnType<AppHost['fileSettings']>> | null = null) {
  const mapFile = path.join(config.outDir, 'map.json');
  const read = readMap(mapFile);
  const map = { ...read, screens: [...new Map(read.screens.map((s) => [s.id, s])).values()] };
  const linked = readTests(config);
  const { traced, ...tests } = applyJudgments(linked, loadJudgments(config.judgmentsDir).judgments, nodeHashes(map));
  const callsById = new Map(map.calls.map((c) => [c.id, c]));
  const { ids: storyIds, ...stories } = checkStoryFiles(map, config.storiesDir, mapFile, { ...tests, traced });
  const caseKinds: Record<string, CaseKind> = config.caseKinds;
  const kinds = Object.keys(caseKinds);
  const candidates = storyCandidates(config, map, mapFile, traced);
  const marks = classifyMarks(loadMarks(config.marksDir).map(mergedStatus), map, storyIds, kinds, linked, config.roleGuards, candidates.list.map((c) => c.key), stories.list as StoryPath[]);
  const targets = caseTargets(map, caseKinds, marks.attached);
  const pickedCases = (id: string) => pickedKinds(targets, id);
  const settingsFile = config.app?.settingsFile ? { root: config.app.settingsFile.root, merged: config.app.settingsFile.merged, file: fileSettings?.file ?? null } : null;
  const screens = map.screens.map((s) => ({
    ...s,
    callOptions: screenCallOptions(s, callsById),
    cases: [...screenCases(s.access), ...pickedCases(s.id)],
    access: {
      ...s.access,
      ...(s.access.settings && { settings: s.access.settings.map((source) => ({ ...source, needs: source.needs.map((need) => ({ ...need, condition: settingConditionName(need), change: settingChange(need, settingsFile, map) })) })) }),
      links: s.access.links.map((l) => ({ ...l, part: linkKey(l) })),
    },
  }));
  const calls = map.calls.map((c) => ({ ...c, cases: pickedCases(c.id) }));
  const reviewMap = { ...map, screens, calls };
  return {
    map: reviewMap,
    tests,
    marks,
    caseKinds,
    caseTargets: targets,
    caseGaps: Object.fromEntries(Object.entries(caseKinds).map(([kind, caseKind]) => [kind, casesWithoutTests(kind, caseKind, targets[kind], tests.nodes).map(({ node, tags }) => ({ node, tags }))])),
    stories,
    needs: checkNeeds(config.storiesDir, stories.list),
    candidates,
    storiesDir: config.storiesDir,
    flow: buildFlow(reviewMap, tests),
    screenRoutes: screenRoutes(map).map(({ id, pattern }) => ({ id, source: pattern.source, flags: pattern.flags })),
    appUrl: config.appUrl ?? null,
    app: app && {
      url: app.url,
      signedOutUrl: app.signedOutUrl,
      signOutPath: SIGN_OUT_PATH,
      signedOutPaths: config.app.signedOutPaths,
      unknownSignedOutPaths: config.app.signedOutPaths.filter((p: string) => !map.screens.some((s: any) => s.path === p)),
      unknownPathValues: unknownPathValues(map, config.app.pathValues),
      account: app.account,
      roles: app.roles,
      error: app.error,
      settings: config.app.settingsFile && { root: config.app.settingsFile.root, merged: config.app.settingsFile.merged, overrides: app.overrides, ...fileSettings },
    },
    appLinks: Object.fromEntries(map.screens.map((s: any) => {
      const signedOut = app && config.app.signedOutPaths.includes(s.path);
      return [s.id, appLink(signedOut ? app.signedOutUrl : (app?.url ?? config.appUrl), s.path, config.app?.pathValues?.[s.path])];
    })),
    depths: DEPTHS,
    author: author?.name ?? null,
    authorSource: author?.source ?? null,
  };
}

function pageData(config: any, data: ReturnType<typeof reviewData>, baseline: ReturnType<typeof readBaseline> | null, version: ReturnType<typeof storiesVersion>) {
  const fromConfig = baseline && path.relative(config.configDir, config.baselineMap);
  const changes = baseline && { file: fromConfig!.startsWith('..') ? config.baselineMap : fromConfig, label: baselineLabel(config.baselineMap), code: recordedState(baseline.meta), ...compareMaps(baseline, data.map) };
  return { ...data, baseline: changes, storiesVersion: version };
}

export type PageData = ReturnType<typeof pageData>;

function send(res: http.ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
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

function storiesTree(dir: string) {
  const folders: string[] = [];
  const files: string[] = [];
  const walk = (folder: string) => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    folders.push(folder);
    for (const entry of entries) {
      const found = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(found);
      else files.push(found);
    }
  };
  walk(dir);
  return { folders, files };
}

function storiesVersion(dir: string) {
  const hash = crypto.createHash('sha1');
  const add = (file: string, name: string) => {
    try {
      const text = fs.readFileSync(file);
      hash.update(`${name}\0${text.length}\0`).update(text);
    } catch {}
  };
  try {
    if (!fs.statSync(dir).isDirectory()) add(dir, '');
    else for (const file of storiesTree(dir).files.sort()) add(file, path.relative(dir, file));
  } catch {}
  return hash.digest('hex');
}

function watchStories(dir: string, changed: () => void) {
  const watchers = new Map<string, fs.FSWatcher>();
  let below = dir;
  const forget = (folder: string) => {
    watchers.get(folder)?.close();
    watchers.delete(folder);
  };
  const heard = (folder: string, name: string | null) => {
    if (folder === path.dirname(below) && name !== null && name !== path.basename(below)) return;
    const named = name === null ? null : path.join(folder, name);
    for (const watched of [...watchers.keys()]) {
      if (named === null || watched === named || watched.startsWith(named + path.sep)) forget(watched);
    }
    rewatch();
    changed();
  };
  const folders = () => {
    below = dir;
    while (path.dirname(below) !== below && !fs.existsSync(path.dirname(below))) below = path.dirname(below);
    return [path.dirname(below), ...storiesTree(dir).folders];
  };
  const rewatch = () => {
    const wanted = new Set(folders());
    for (const folder of [...watchers.keys()]) if (!wanted.has(folder)) forget(folder);
    for (const folder of wanted) {
      if (watchers.has(folder)) continue;
      try {
        const watcher = fs.watch(folder, (_, name) => heard(folder, name));
        watcher.on('error', () => {
          watcher.close();
          if (watchers.get(folder) === watcher) watchers.delete(folder);
        });
        watchers.set(folder, watcher);
      } catch {}
    }
  };
  rewatch();
  return () => {
    for (const watcher of watchers.values()) watcher.close();
  };
}

type Where = ReturnType<typeof locatePart> | ReturnType<typeof locateStoryPart> | ReturnType<typeof candidatePlace> | ReturnType<typeof locateOrder> | null;
type Target = NonNullable<Mark['target']>;
export type AnnouncedMark = Mark & { duru: string; where?: Where; wheres?: Where[] };

export async function startReviewServer(config: any, { port = 0, author = reviewAuthor(config), onDone = () => {}, onMark = () => {} }: { port?: number; author?: ReviewAuthor; onDone?: () => (() => void) | void | null; onMark?: (line: AnnouncedMark) => void } = {}) {
  const mapFile = path.join(config.outDir, 'map.json');
  // 없거나 아직 쓰는 중인 맵은 페이지가 요청할 때 알리고, 예전 형식의 맵만 서버를 띄우기 전에 알린다.
  let onDisk: any = null;
  try {
    onDisk = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  } catch {}
  if (isStaleMap(onDisk)) throw staleMapError(mapFile);
  const baseline = config.baselineMap ? readBaseline(config.baselineMap) : null;
  const rootDefaults = () => {
    const map = readMap(mapFile);
    const root = config.app.settingsFile?.root;
    return { values: map.settingsDefaults?.[root] ?? {}, incomplete: map.settingsDefaultsIncomplete?.[root] ?? [] };
  };
  let pageOrigins: string[] = [];
  const app = config.app && (await startAppHost(config.app, { rootDefaults, pageOrigins: () => pageOrigins }));
  // 다른 사이트가 사용자의 브라우저로 표시를 써 넣거나 리뷰를 끝내거나(JSON 이 아닌 요청), 자기 도메인을 이 주소로 돌려 맵을 읽어 가는 것(다른 Host)을 막는다.
  const ownHosts = () => [`127.0.0.1:${(server.address() as AddressInfo).port}`, `localhost:${(server.address() as AddressInfo).port}`];
  const isJson = (req: http.IncomingMessage) => req.headers['content-type']?.startsWith('application/json');
  const streams = new Set<http.ServerResponse>();
  let streamsEnded = false;
  // 열린 스트림이 남아 있으면 서버가 닫히지 않으므로, 끝났다고 알리고 닫는다.
  const endStreams = () => {
    if (streamsEnded) return;
    streamsEnded = true;
    for (const stream of streams) stream.end('event: end\ndata: review ended\n\n');
    streams.clear();
  };
  const readOrNull = <T>(read: () => T) => {
    try {
      return read();
    } catch {
      return null;
    }
  };
  const codeHashOf = (node: unknown) => (typeof node === 'string' ? nodeHashes(readOrNull(() => readMap(mapFile)) ?? { screens: [] }).get(node) : undefined);
  const markHash = (input: any) => (isPlainObject(input) && isPlainObject(input.target) ? codeHashOf(input.target.node) : undefined);
  const judgmentHashes = (input: any) => {
    const test = isPlainObject(input) && isPlainObject(input.test) && typeof input.test.file === 'string' ? reference(input.test) : null;
    return { codeHash: isPlainObject(input) ? codeHashOf(input.node) : undefined, testFileHash: test ? readOrNull(() => readTests(config))?.testFileHashes?.[test.file!] : undefined };
  };
  const storyPartWhere = ({ story, part }: Target) => {
    const map = readOrNull(() => readMap(mapFile));
    const found = map && readOrNull(() => (checkStoryFiles(map, config.storiesDir, mapFile).list as StoryPath[]).find((s) => s.id === story));
    return found ? locateStoryPart(part!, found, map.screens) : null;
  };
  const partWhere = (target: Target) => (target.story !== undefined ? storyPartWhere(target) : locatePart(target, {
    tests: (target.part!.kind === 'test' && readOrNull(() => readTests(config))) || {},
    screens: (target.part!.kind !== 'test' && readOrNull(() => readMap(mapFile))?.screens) || [],
    roleGuards: config.roleGuards,
  }));
  const findCandidate = (key: unknown) => storyCandidates(config, readMap(mapFile), mapFile, readTests(config).traced).list.find((c) => c.key === key);
  const candidateWhere = (key: string) => {
    try {
      const found = findCandidate(key);
      return found ? candidatePlace(found) : null;
    } catch {
      return null;
    }
  };
  const orderWhere = (screens: string[]) => readOrNull(() => locateOrder(screens, readMap(mapFile)));
  const whereOf = (target: Target) => (target.part ? partWhere(target) : target.candidate !== undefined ? candidateWhere(target.candidate) : target.screens !== undefined ? orderWhere(target.screens) : undefined);
  const lineOf = (mark: Mark): AnnouncedMark => {
    if (mark.targets) return { duru: recordKind(mark), ...mark, wheres: mark.targets.map((t) => whereOf(t) ?? null) };
    const where = whereOf(mark.target!);
    return { duru: recordKind(mark), ...mark, ...(where !== undefined && { where }) };
  };
  const unanswered = () => {
    const marks = loadMarks(config.marksDir);
    const answered = new Set(marks.map((m) => m.replyTo));
    return marks.filter((m) => recordKind(m) === 'comment' && !answered.has(m.id)).sort((a, b) => a.date.localeCompare(b.date));
  };
  // 스토리 폴더의 변화는 이름을 붙인 이벤트로 보내, 이름 없는 코멘트 줄만 읽는 duru wait 에 섞이지 않게 한다.
  let storiesSent = storiesVersion(config.storiesDir);
  let settling: NodeJS.Timeout | undefined;
  const stopWatching = watchStories(config.storiesDir, () => {
    clearTimeout(settling);
    settling = setTimeout(() => {
      const version = storiesVersion(config.storiesDir);
      if (version === storiesSent) return;
      storiesSent = version;
      for (const stream of streams) stream.write(`event: stories\ndata: ${version}\n\n`);
    }, STORIES_SETTLE_MS);
  });
  const announce = (mark: Mark) => {
    const line = lineOf(mark);
    onMark(line);
    for (const stream of streams) stream.write(`data: ${JSON.stringify(line)}\n\n`);
    return mark;
  };
  // 답글의 작성자는 페이지를 띄운 사람이 아니라 답한 에이전트다.
  const saves: Record<string, (input: any) => unknown> = {
    '/api/marks': (input) => announce(addMark(config.marksDir, { ...input, author: author.name, rule: isPlainObject(input) ? exclusionOf(() => readMap(mapFile), config.caseKinds, input) : undefined, via: undefined, of: undefined, codeHash: markHash(input) })),
    '/api/replies': (input) => announce(addReply(config.marksDir, { replyTo: input?.replyTo, note: input?.note })),
    '/api/judgments': (input) => addJudgment(config.judgmentsDir, { ...input, author: author.name, ...judgmentHashes(input) }),
    '/api/cases': (input) => announce(writeCaseMark(config, caseDecision(input), 'agent')),
    '/api/cases/answer': (input) => announce(writeCaseAnswer(config, input, author.name)),
  };
  const sendPathValues = async (res: http.ServerResponse, id: string | null, role: string | null, typed = {}) => {
    const map = readMap(mapFile);
    const screen = map.screens.find((s: any) => s.id === id);
    if (!screen) return send(res, 404, 'text/plain', `unknown screen "${id}"`);
    const fetchApi = role ? app?.fetchApiAs(role) : app?.fetchApi;
    if (fetchApi === undefined && role) return send(res, 404, 'text/plain', `unknown role "${role}"`);
    return send(res, 200, 'application/json', JSON.stringify(await preparePathValues(map, screen, config.app?.pathValues ?? {}, fetchApi ?? null, role, app?.fetchServer, typed)));
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (!ownHosts().includes(req.headers.host!)) return send(res, 403, 'text/plain', 'forbidden host');
      if (req.method === 'POST' && req.url === '/api/end') {
        if (!isJson(req)) return send(res, 415, 'text/plain', 'expected application/json');
        // onDone 이 예외를 던지면 리뷰를 끝내지 않고 500 으로 응답한다.
        const finish = onDone();
        if (finish) res.on('close', finish);
        send(res, 200, 'text/plain', 'review ended');
        endStreams();
        return;
      }
      if (req.method === 'GET' && req.url === '/') return send(res, 200, 'text/html', PAGE_PARTS.map((part) => fs.readFileSync(path.join(PAGE_DIR, part), 'utf8')).join(''));
      if (req.method === 'GET' && (req.url === '/api/events' || req.url === '/api/events?unanswered')) {
        const backlog = req.url.endsWith('?unanswered') ? unanswered().map(lineOf) : null;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
        if (streamsEnded) return res.end('event: end\ndata: review ended\n\n');
        res.flushHeaders();
        if (backlog) res.write(`${backlog.map((line) => `data: ${JSON.stringify(line)}\n\n`).join('')}event: unanswered-sent\ndata: \n\n`);
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/data') {
        const fileSettings = app && config.app.settingsFile ? await app.fileSettings() : null;
        // 해시를 데이터보다 먼저 구해 두어야, 그 사이에 바뀐 스토리가 다른 해시의 이벤트로 와서 다시 읽힌다.
        const version = storiesVersion(config.storiesDir);
        return send(res, 200, 'application/json', JSON.stringify(pageData(config, reviewData(config, author, app, fileSettings), baseline, version)));
      }
      const url = new URL(req.url!, 'http://host');
      if (req.method === 'GET' && url.pathname === '/api/path-values' && url.searchParams.has('screen')) {
        return await sendPathValues(res, url.searchParams.get('screen'), url.searchParams.get('role'));
      }
      if (req.method === 'POST' && req.url === '/api/path-values') {
        if (!isJson(req)) return send(res, 415, 'text/plain', 'expected application/json');
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch (err: any) {
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
        } catch (err: any) {
          return send(res, 400, 'text/plain', err.message);
        }
      }
      if (req.method === 'POST' && STORY_POSTS.includes(req.url!)) {
        if (!isJson(req)) return send(res, 415, 'text/plain', 'expected application/json');
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch (err: any) {
          return send(res, 400, 'text/plain', err.message);
        }
        if (!isPlainObject(input)) return send(res, 400, 'text/plain', 'expected a JSON object');
        if (req.url === '/api/stories/fields' || req.url === '/api/stories/steps' || req.url === '/api/needs/edit') {
          try {
            const written = req.url === '/api/needs/edit' ? editNeed(config.storiesDir, input)
              : req.url === '/api/stories/steps' ? writeStorySteps(config.storiesDir, input.id, input) : writeStoryFields(config.storiesDir, input.id, input);
            return send(res, 200, 'application/json', JSON.stringify(written));
          } catch (err: any) {
            return send(res, err instanceof FileChanged ? 409 : 400, 'text/plain', err.message);
          }
        }
        if (req.url === '/api/needs/add') {
          try {
            return send(res, 201, 'application/json', JSON.stringify(addNeed(config.storiesDir, input)));
          } catch (err: any) {
            return send(res, 400, 'text/plain', err.message);
          }
        }
        if (req.url === '/api/stories/edit' || req.url === '/api/stories/unaccept') {
          try {
            const written = req.url === '/api/stories/edit' ? editStory(config.storiesDir, input.id, input) : unacceptStory(config.storiesDir, input.id);
            return send(res, 200, 'application/json', JSON.stringify(written));
          } catch (err: any) {
            return send(res, 400, 'text/plain', err.message);
          }
        }
        if (req.url === '/api/stories/check' || req.url === '/api/stories/add') {
          try {
            const { id, name, memo, needs, screens, expects } = input;
            const checked = checkScreens(readMap(mapFile), mapFile, Array.isArray(screens) ? screens.map((s) => (isPlainObject(s) ? s.screen : s)) : screens);
            if (req.url === '/api/stories/check') return send(res, 200, 'application/json', JSON.stringify(checked));
            return send(res, 201, 'application/json', JSON.stringify(addStory(config.storiesDir, { id, name, memo, needs, screens, expects, author: author.name })));
          } catch (err: any) {
            return send(res, 400, 'text/plain', err.message);
          }
        }
        if (req.url === '/api/records') {
          if (!app) return send(res, 404, 'text/plain', 'no app is served');
          let file;
          try {
            file = saveVisitRecord(config.storiesDir, input.steps);
          } catch (err: any) {
            return send(res, 400, 'text/plain', err.message);
          }
          return send(res, 201, 'application/json', JSON.stringify({ record: path.relative(config.configDir, path.join(config.storiesDir, file)).split(path.sep).join('/') }));
        }
        if (req.url === '/api/candidates/add') {
          try {
            return send(res, 201, 'application/json', JSON.stringify(writeCommentCandidate(config, input)));
          } catch (err: any) {
            return send(res, 400, 'text/plain', err.message);
          }
        }
        if (req.url === '/api/candidates/undiscard') {
          try {
            return send(res, 201, 'application/json', JSON.stringify(undiscardCandidate(config.storiesDir, input.screens, { author: author.name })));
          } catch (err: any) {
            return send(res, 400, 'text/plain', err.message);
          }
        }
        const candidate = findCandidate(input.key);
        if (!candidate) return send(res, 404, 'text/plain', `후보 ${input.key} 가 없습니다`);
        if (req.url === '/api/candidates/lines') {
          try {
            return send(res, 200, 'application/json', JSON.stringify(pickCandidateLine(config.storiesDir, candidate, input)));
          } catch (err: any) {
            return send(res, 400, 'text/plain', err.message);
          }
        }
        try {
          const written = req.url === '/api/candidates/accept'
            ? acceptCandidate(config.storiesDir, candidate, { id: input.id, name: input.name, author: author.name })
            : discardCandidate(config.storiesDir, candidate, { reason: input.reason, author: author.name });
          return send(res, 201, 'application/json', JSON.stringify(written));
        } catch (err: any) {
          return send(res, 400, 'text/plain', err.message);
        }
      }
      if (req.method === 'POST' && Object.hasOwn(saves, req.url!)) {
        if (!isJson(req)) return send(res, 415, 'text/plain', 'expected application/json');
        let input;
        try {
          input = JSON.parse(await readBody(req));
        } catch (err: any) {
          return send(res, 400, 'text/plain', err.message);
        }
        try {
          const saved = saves[req.url!](input);
          return send(res, 201, 'application/json', JSON.stringify(saved));
        } catch (err: any) {
          return send(res, err instanceof ProposalChanged ? 409 : 400, 'text/plain', err.message);
        }
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (err: any) {
      send(res, 500, 'text/plain', err.message);
    }
  });
  if (app) server.on('close', () => app.close());
  // 「리뷰 끝」을 거치지 않고 서버를 닫을 때도 열린 페이지가 다시 연결하지 않게 끝을 알린다.
  const close = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    stopWatching();
    clearTimeout(settling);
    endStreams();
    return close(callback);
  }) as typeof server.close;
  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', (err) => {
      stopWatching();
      app?.close();
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      const { port: own } = server.address() as AddressInfo;
      pageOrigins = [`http://127.0.0.1:${own}`, `http://localhost:${own}`];
      resolve(server);
    });
  });
}
