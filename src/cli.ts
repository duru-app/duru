#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { baselineLine, compareMaps, readBaseline } from './baseline.ts';
import { storeCandidates, storyCandidates } from './candidates.ts';
import { casesWithoutTests, picksCalls, rulePicks } from './case-targets.ts';
import { isPlainObject, loadConfig } from './config.ts';
import type { CaseKind } from './config.ts';
import { UNKNOWN } from './client.ts';
import { buildMap, unreadSites } from './map.ts';
import { applyJudgments, judgmentFile, loadJudgments } from './judgments.ts';
import { addReply } from './marks.ts';
import { checkNeeds } from './needs.ts';
import { CANDIDATES } from './stories.ts';
import { SOURCE_SYNTAX_ERROR } from './parse.ts';
import { readCaseTargets, reviewAuthor, startReviewServer, writeCaseMark, writeCommentCandidate } from './review.ts';
import type { AnnouncedMark } from './review.ts';
import { SERVER_NOT_COMPARED } from './server.ts';
import { checkStoryFiles } from './story-paths.ts';
import { atTableItem, linkText, storyBrief, taskList, undecidedLines } from './tasks.ts';
import { linkTests } from './test-links.ts';

const COMMANDS = ['extract', 'rebuild', 'review', 'tasks', 'story', 'reply', 'wait', 'case', 'undecided', 'candidate'];
const DEFAULT_PORT = 4400;
const CASE_OPTIONS = ['--note', '--author', '--server'];
const UNDECIDED_LEFT = 3;
const AUTHOR_SOURCES: Record<string, string> = { config: 'config', git: 'git user.name', user: 'computer user name' };
const KEPT_BY: Record<string, string> = { source: 'the source', config: 'bodyOptions' };
const [, , command, configPath, ...extra] = process.argv;
const unreadText = (r: { url: string | null; reason: string }) => `address not read (${r.reason})${r.url === null ? '' : `, only ${r.url}`}`;
const portArg = command === 'review' && extra[0] === '--port' && extra.length === 2 ? Number(extra[1]) : null;
const replyArgs = command === 'reply' && (extra.length === 2 || (extra.length === 4 && extra[2] === '--server')) ? { id: extra[0], text: extra[1], server: extra[3] ?? null } : null;
const waitServer = command === 'wait' && extra.length === 2 && extra[0] === '--server' ? extra[1] : null;
const caseArgs = command === 'case' ? caseArgsOf(extra) : null;
const candidateArgs = command === 'candidate' && (extra.length === 2 || (extra.length === 4 && extra[2] === '--server' && extra[3])) && extra[1] ? { comment: extra[0], from: extra[1], server: extra[3] ?? null } : null;
const argsFit = command === 'story' ? extra.length === 1 && extra[0] !== '' : command === 'reply' ? replyArgs : command === 'wait' ? waitServer : command === 'case' ? caseArgs : command === 'undecided' ? extra.length <= 1 : command === 'candidate' ? candidateArgs : extra.length === 0 || Number.isInteger(portArg);
if (!COMMANDS.includes(command) || !configPath || !argsFit) {
  console.error(`usage: duru <extract|rebuild|tasks> <config.json>\n       duru story <config.json> <story ID>\n       duru review <config.json> [--port <n>]\n       duru reply <config.json> <comment ID> <text> [--server <review page address>]\n       duru wait <config.json> --server <review page address>\n       duru case <config.json> <kind> <screen or call ID> needed|not-needed [--note <why>] [--author <name> | --server <review page address>]\n       duru undecided <config.json> [<kind>]\n       duru candidate <config.json> <comment ID> <candidate.json | -> [--server <review page address>]`);
  process.exit(2);
}
if (caseArgs && caseArgs.server !== null && caseArgs.author !== null) {
  console.error('a case sent with --server is always by agent; leave out --author');
  process.exit(2);
}

function caseArgsOf(args: string[]) {
  const [kind, node, status, ...rest] = args;
  if (!kind || !node || !['needed', 'not-needed'].includes(status)) return null;
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!CASE_OPTIONS.includes(rest[i]) || rest[i + 1] === undefined || (rest[i] === '--server' && !rest[i + 1]) || Object.hasOwn(options, rest[i])) return null;
    options[rest[i]] = rest[i + 1];
  }
  return { kind, node, status, note: options['--note'] ?? '', author: options['--author'] ?? null, server: options['--server'] ?? null };
}

async function sendToReview(server: string, route: string, body: unknown) {
  const res = await fetch(new URL(route, server), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .catch((err) => Promise.reject(new Error(`could not reach the review page at ${server}: ${err.cause?.message ?? err.message}`)));
  if (!res.ok) throw new Error(await res.text());
  return res;
}

function readCandidate(from: string) {
  const where = from === '-' ? 'stdin' : from;
  let text;
  try {
    text = fs.readFileSync(from === '-' ? 0 : from, 'utf8');
  } catch (err: any) {
    throw new Error(`could not read the candidate from ${where}: ${err.message}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (err: any) {
    throw new Error(`the candidate in ${where} is not JSON: ${err.message}`);
  }
  if (!isPlainObject(body)) throw new Error(`the candidate in ${where} must be a JSON object with "name" and "screens"`);
  return body;
}

const config = loadConfig(configPath);

if (command === 'tasks') {
  process.stdout.write(taskList(config));
} else if (command === 'story') {
  let brief;
  try {
    brief = await storyBrief(config, extra[0]);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
  if ('error' in brief) {
    console.error(brief.error);
    process.exit(1);
  }
  process.stdout.write(brief.text);
} else if (command === 'case') {
  const { kind, node, status, note, author, server } = caseArgs!;
  try {
    if (server) await sendToReview(server, 'api/cases', { kind, node, status, note });
    else writeCaseMark(config, { kind, node, status, note }, author ?? 'agent');
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
} else if (command === 'candidate') {
  const { comment, from, server } = candidateArgs!;
  let written: ReturnType<typeof writeCommentCandidate>;
  try {
    const input = { ...readCandidate(from), comment };
    written = server ? await (await sendToReview(server, 'api/candidates/add', input)).json() as typeof written : writeCommentCandidate(config, input);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
  const steps = written.links.map((l, i) => `step ${i + 1} → ${i + 2}: from ${l.from} to ${l.to} — ${linkText(l)}`);
  process.stdout.write([`wrote ${written.file}`, ...steps].map((l) => `${l}\n`).join(''));
} else if (command === 'undecided') {
  let read: ReturnType<typeof readCaseTargets>;
  try {
    read = readCaseTargets(config);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
  const [only] = extra;
  if (only !== undefined && !Object.hasOwn(config.caseKinds, only)) {
    console.error(`"${only}" is not a kind in caseKinds`);
    process.exit(2);
  }
  const kinds = only === undefined ? config.caseKinds : { [only]: config.caseKinds[only] };
  if (!Object.keys(kinds).length) console.error('caseKinds names no kind, so nothing is undecided');
  const left = Object.keys(kinds).some((kind) => read.targets[kind].undecided.length);
  const done = () => process.exit(left ? UNDECIDED_LEFT : 0);
  process.stdout.on('error', done);
  process.stdout.write(undecidedLines(read.map, kinds, read.targets, read.attached).map((l) => `${l}\n`).join(''), done);
} else if (command === 'reply') {
  const { id, text, server } = replyArgs!;
  try {
    if (!server) addReply(config.marksDir, { replyTo: id, note: text });
    else await sendToReview(server, 'api/replies', { replyTo: id, note: text });
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
} else if (command === 'wait') {
  const server = waitServer!;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
  const connect = async () => {
    for (const until = Date.now() + 10_000; ;) {
      try {
        return await fetch(new URL('api/events?unanswered', server));
      } catch (err: any) {
        if (Date.now() >= until) {
          console.error(`could not reach the review page at ${server}: ${err.cause?.message ?? err.message}`);
          process.exit(1);
        }
        await pause();
      }
    }
  };
  let printed: string | null = null;
  let ended = false;
  while (printed === null && !ended) {
    const res = await connect();
    if (!res.ok) {
      console.error(await res.text());
      process.exit(1);
    }
    const backlog: string[] = [];
    let live = false;
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      read: for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let cut; (cut = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(cut + 2)) {
          const fields = Object.fromEntries(buffer.slice(0, cut).split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trimStart()]));
          if (fields.event === 'end') {
            ended = true;
            break read;
          }
          if (fields.event === 'unanswered-sent') {
            if (backlog.length) {
              printed = backlog.map((l) => `${l}\n`).join('');
              break read;
            }
            live = true;
            console.error(`waiting for a comment at ${server}`);
          } else if (fields.event !== undefined) continue;
          else if (!live) backlog.push(fields.data);
          else if (JSON.parse(fields.data).duru === 'comment') {
            printed = `${fields.data}\n`;
            break read;
          }
        }
      }
    } catch {}
    if (printed === null && !ended) await pause();
  }
  if (printed === null) console.error('review ended');
  process.stdout.write(printed ?? '', () => process.exit(0));
} else if (command === 'review') {
  const author = reviewAuthor(config);
  let ended = false;
  const end = () => {
    if (ended) return null;
    const list = taskList(config);
    ended = true;
    return () => {
      server.close();
      process.stdout.write(list, () => process.exit(0));
    };
  };
  // Claude Code 2.1.296 에서 세션에 들어오는 것을 확인한 비공식 메시지 형식이다.
  const toSession = (line: AnnouncedMark) => {
    const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    if (!socket) return;
    const failed = (err: Error) => console.error(`could not send the comment to the Claude Code session: ${err.message}`);
    try {
      const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
      const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const reply = `duru reply ${JSON.stringify(path.resolve(configPath))} ${line.id} "<answer>" --server ${address}`;
      const content = `duru review comment; answer it with ${reply}\n${JSON.stringify(line)}`;
      const conn = net.createConnection(socket, () => {
        if (token) conn.write(`${JSON.stringify({ type: 'auth', token })}\n`);
        conn.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
      });
      conn.on('error', failed);
    } catch (err: any) {
      failed(err);
    }
  };
  const onMark = (line: AnnouncedMark) => {
    console.error(JSON.stringify(line));
    if (line.duru === 'comment') toSession(line);
  };
  const server = await startReviewServer(config, { port: portArg ?? DEFAULT_PORT, author, onDone: end, onMark });
  process.on('SIGINT', () => {
    try {
      end()?.();
    } catch (err: any) {
      console.error(`could not build the task list: ${err.message}`);
    }
  });
  // 표준 출력에는 작업 목록만 나가야 리뷰를 띄운 에이전트가 그대로 읽을 수 있다.
  console.error(`review page http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  console.error(`marks ${config.marksDir} | stories ${config.storiesDir} | author ${author.name} (${AUTHOR_SOURCES[author.source]})`);
} else {
  let baseline = null;
  try {
    if (command === 'rebuild' && config.baselineMap) baseline = readBaseline(config.baselineMap);
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
  fs.mkdirSync(config.outDir, { recursive: true });
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const write = (name: string, data: unknown) => {
    const file = path.join(config.outDir, name);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    return file;
  };

  const map = await buildMap(config).catch((err) => {
    if (err.code !== SOURCE_SYNTAX_ERROR) throw err;
    console.error(err.message);
    process.exit(1);
  });
  const changes = baseline && baselineLine(config.baselineMap, compareMaps(baseline, map));
  console.log(`wrote ${write('map.json', map)}`);
  const allEndpoints = Object.values<any>(map.apiFunctions).flatMap((f) => f.endpoints);
  const count = (st: string) => allEndpoints.filter((e) => e.server.status === st).length;
  console.log(`screens ${map.screens.length} | api functions ${Object.keys(map.apiFunctions).length} | endpoints match ${count('match')} method-mismatch ${count('method-mismatch')} none ${count('none')} unresolved ${count('unresolved')}${map.serverNotCompared ? ` unchecked ${count('unchecked')}` : ''}`);
  if (map.serverNotCompared) console.log(`  ${SERVER_NOT_COMPARED}`);
  for (const r of unreadSites(map.screens, false)) console.log(`  api call ${r.fn} ← ${r.file}:${r.line}: ${unreadText(r)}`);
  for (const m of map.unrunApiModules ?? []) console.log(`  calledApiModules ${m.file} did not run: ${m.error}`);
  for (const f of map.silentApiModules ?? []) console.log(`  calledApiModules ${f} recorded no request; without requestFunction only requests sent with fetch or by moving the browser are recorded`);
  const direct = new Map<string, any>(map.screens.flatMap((s: any) => s.apiCalls.filter((c: any) => c.direct).map((c: any) => [`${c.file}\n${c.line}\n${c.fn}\n${c.endpoints[0].method} ${c.endpoints[0].url}`, c])));
  if (direct.size) console.log(`requests and navigations written in screen sources ${direct.size} | address not read ${map.unreadRequests?.length ?? 0}`);
  for (const r of map.unreadRequests ?? []) console.log(`  request ${r.fn} ← ${r.file}:${r.line}: ${unreadText(r)}`);
  if (map.sagas && !map.sagas.runs.length) console.log('redux-saga is imported, but no run of a createSagaMiddleware() result was found, so no request of a saga is put on a screen');
  else if (map.sagas) {
    const bySaga = new Set(map.screens.flatMap((s: any) => s.apiCalls.filter((c: any) => c.actions).map((c: any) => `${c.file}\n${c.line}\n${c.fn}`)));
    console.log(`redux-saga runs from ${map.sagas.runs.join(', ')} | watchers ${map.sagas.watchers} | requests of sagas on screens ${bySaga.size}`);
  }
  for (const s of map.outsideStandIns ?? []) console.log(`  calledApiModules ran ${s.spec} as a stand-in, though it is ${s.file} outside srcRoot, imported by ${s.importedBy.join(', ')}`);
  for (const n of map.bodyTypeNotices ?? []) {
    console.log(`  body type ${n.method}: ${n.field ? `${n.field} goes with ${n.beside}, so it is not taken as an on/off option` : n.reason}`);
  }
  for (const { call, field } of map.leftOutBodyTypeFields ?? []) console.log(`  bodyTypeExclusions ${call} leaves out ${field}`);
  for (const { call, field, keptBy } of map.keptBodyTypeExclusions ?? []) {
    console.log(`  bodyTypeExclusions ${call} ${field} stays an option, given by ${keptBy.map((src: string) => KEPT_BY[src]).join(' and ')}`);
  }
  for (const [name, fn] of Object.entries<any>(map.apiFunctions)) if (fn.error && !fn.endpoints.length) console.log(`  api method ${name} ← ${fn.file ?? '?'}${fn.line ? `:${fn.line}` : ''}: ${fn.error}`);
  console.log(`dead calls reachable from screens: ${map.deadCalls.length}`);
  console.log(`calls ${map.calls.length} | dead screens ${map.screens.filter((s: any) => s.dead).length}`);
  console.log(`entry screens ${map.entries.length} | screens opening only under a setting or role ${map.screens.filter((s: any) => s.access.restricted).length}`);
  for (const p of map.unknownEntryPaths) console.log(`  entryPaths ${p} matches no route`);
  for (const p of map.unknownMovePaths) console.log(`  moves ${p} matches no route`);
  for (const id of map.unknownBodyOptionCalls) console.log(`  bodyOptions ${id} matches no call`);
  for (const { call, field } of map.unknownBodyTypeExclusions ?? []) {
    console.log(`  bodyTypeExclusions ${call}${field === undefined ? ' matches no call' : ` ${field} matches no on/off option read from its body type`}`);
  }
  for (const g of map.unknownRoleGuards ?? []) console.log(`  roleGuards ${g} matches no role guard`);
  for (const l of map.unknownCallLinks) for (const id of l.missing) console.log(`  callLinks ${l.from} → ${l.to}: ${id} matches no call`);
  for (const n of map.settingsCallNotices ?? []) console.log(`  settingsFunctions ${n.file ? `${n.file}:${n.line} ` : ''}${n.reason}`);
  for (const { spec, files } of map.unresolvedAliasImports ?? []) console.log(`  tsconfig import ${spec} matches an alias but no file, imported in ${files} file${files === 1 ? '' : 's'}`);
  for (const d of map.duplicateIds) console.log(`  duplicate screen ID ${d.id} ← ${d.places.map((p: { file: string; line: number }) => `${p.file}:${p.line}`).join(', ')}`);
  for (const s of map.screens.filter((s: any) => !s.componentFile)) console.log(`  component file not found for ${s.id} ← ${s.routeFile}:${s.line}${atTableItem(s)}`);
  for (const { file, line, path: routePath, stoppedAt: at } of map.unreadRoutePaths ?? []) {
    const elsewhere = at.file === file ? '' : ` in ${at.file}:${at.line}`;
    console.log(`  route path not read ← ${file}:${line}: stopped at ${at.text}${elsewhere}${routePath === UNKNOWN ? '' : `, only ${routePath}`}`);
  }
  for (const { file, line, reason } of map.unreadRoutes ?? []) console.log(`  route not read ← ${file}:${line}: ${reason}`);

  if (command === 'rebuild') {
    if (changes) console.log(changes);
    for (const [kind, caseKind] of Object.entries<CaseKind>(config.caseKinds)) {
      if (!caseKind.picks.length) continue;
      const rules = rulePicks(map, caseKind);
      const picked = (list: typeof rules, side: 'screens' | 'calls') => new Set(list.flatMap((r) => r[side]));
      const [screens, calls] = [picked(rules, 'screens'), picked(rules, 'calls')];
      const before = baseline && rulePicks(baseline, caseKind);
      const [wasScreens, wasCalls] = before ? [picked(before, 'screens'), picked(before, 'calls')] : [new Set(), new Set()];
      const added = [...screens].filter((id) => !wasScreens.has(id)).length + [...calls].filter((id) => !wasCalls.has(id)).length;
      console.log(`case kind ${kind}: rules pick ${plural(screens.size, 'screen')}, ${plural(calls.size, 'call')}${before ? ` | new since ${config.baselineMap} ${added}` : ''}`);
      rules.forEach((r, i) => {
        if (!r.screens.length && !r.calls.length) console.log(`  caseKinds ${kind} picks[${i}] matches no ${picksCalls(r.pick) ? 'call' : 'screen'}: ${JSON.stringify(r.pick)}`);
      });
    }
    const links = linkTests(config, map);
    console.log(`wrote ${write('tests.json', links)}`);
    const { list, notices, stale, unknownTags: unknownStories } = checkStoryFiles(map, config.storiesDir, path.join(config.outDir, 'map.json'), links);
    const unknownTags = [...links.unknownTags, ...unknownStories];
    const covered = map.screens.filter((s: any) => links.nodes[s.id]).length;
    console.log(`screens with tests ${covered}/${map.screens.length} | tags pointing outside the map ${unknownTags.length} | tests without a node or story tag ${links.untaggedCount}`);
    console.log(`calls with tests ${map.calls.filter((c: any) => links.nodes[c.id]).length}/${map.calls.length}`);
    const { judgments, notices: judgmentNotices } = loadJudgments(config.judgmentsDir);
    const judged = applyJudgments(links, judgments);
    const pairs = (byScreen: Record<string, unknown[]>) => Object.values(byScreen).reduce((n, tests) => n + tests.length, 0);
    console.log(`links from unit tests to screens by the files they import ${pairs(judged.importers)} | test files not read ${links.importNotices.length}`);
    console.log(`links from browser tests to screens they passed through and calls they sent ${pairs(judged.passed)} | traces not read ${links.traceNotices.length} | browser tests that ran without a trace ${links.untracedCount}`);
    console.log(`pairs discarded by reviewers ${pairs(judged.discarded)} | judgment files skipped ${judgmentNotices.length}`);
    const onMap = new Set([...map.screens, ...map.calls].map((n) => n.id));
    let detachedOnMap = 0;
    const offMap = [];
    for (const [node, list] of Object.entries(judged.detachedHandOvers)) {
      if (onMap.has(node)) detachedOnMap += list.length;
      else for (const d of list) offMap.push(`  handed over for ${node}, which is not on the map ← ${[d.ref.file, d.ref.title].filter(Boolean).join(' ')} (delete ${path.join(config.judgmentsDir, judgmentFile(d.judgment))} to clear it)`);
    }
    console.log(`pairs handed over for tagging waiting for the tag ${pairs(judged.awaitingTag)} | handed over but no longer found among the tests importing, passing through or tagged with the screen or call ${detachedOnMap}`);
    for (const line of offMap) console.log(line);
    for (const n of judgmentNotices) console.log(`  judgment file ${n.file}: ${n.reason}`);
    if (Object.keys(config.caseKinds).length) {
      try {
        const { targets } = readCaseTargets(config);
        for (const [kind, caseKind] of Object.entries<CaseKind>(config.caseKinds)) {
          const untested = casesWithoutTests(kind, caseKind, targets[kind], judged.nodes).reduce((n, c) => n + c.tags.length, 0);
          console.log(`case kind ${kind}: undecided ${targets[kind].undecided.length} | cases with no tests ${untested}`);
        }
      } catch (err: any) {
        console.log(`  case kinds not counted: ${err.message}`);
      }
    }
    for (const n of links.traceNotices) console.log(`  trace ${n.file} ← ${n.test.file}:${n.test.line} ${n.test.title}: ${n.reason}`);
    for (const m of links.missingSources) console.log(`  missing test results ${m}`);
    for (const u of unknownTags) console.log(`  unknown ${u.tag} ← ${u.test.file}:${u.test.line} ${u.test.title}`);

    const unjudged = list.flatMap((s) => s.links).filter((l) => l.verdict === 'unknown').length;
    console.log(`stories ${list.length} | broken paths ${list.filter((s) => s.broken).length} | detached ${list.filter((s) => s.detached).length} | unjudged steps ${unjudged} | story files skipped ${notices.length}`);
    const inStatus = (status: string) => list.filter((s) => s.status === status).length;
    console.log(`stories passing ${inStatus('pass')} | passing on part of the path ${inStatus('part-pass')} | failing ${inStatus('fail')} | pending ${inStatus('pending')} | partly covered ${inStatus('partial')} | no tests ${inStatus('untested')}`);
    console.log(`passing stories not known to go through every step, for want of a trace or a screen on the map ${list.filter((s) => s.walked === 'unknown').length}`);
    for (const s of list) {
      s.links.forEach((l, i) => {
        if (l.passedBy) console.log(`  story ${s.id} step ${i + 1} → ${i + 2}: no link on the map, but ${l.passedBy} passing test${l.passedBy > 1 ? 's' : ''} went from ${l.from} to ${l.to}; a move may be missing from moves`);
      });
    }
    for (const n of notices) console.log(`  story file ${n.file}: ${n.reason}`);
    if (stale) console.log(`  ${stale}`);
    const needs = checkNeeds(config.storiesDir, list);
    console.log(`need files ${needs.list.length} | needs picking a need file that is not there ${needs.missing} | need files skipped ${needs.notices.length}`);
    for (const n of needs.notices) console.log(`  need file ${n.file}: ${n.reason}`);
    const candidates = storyCandidates(config, map, path.join(config.outDir, 'map.json'), links.traced);
    const stored = storeCandidates(config.storiesDir, candidates.list);
    console.log(`story candidates ${candidates.list.length} | from traces ${candidates.list.filter((c) => 'report' in c.source).length} | newly stored ${stored.written} | files skipped ${candidates.notices.length}`);
    for (const n of candidates.notices) console.log(`  ${n.file}: ${n.reason}`);
    if (stored.reason) console.log(`  ${path.relative(config.configDir, path.join(config.storiesDir, CANDIDATES)).split(path.sep).join('/')}: ${stored.reason}`);
  }
}
