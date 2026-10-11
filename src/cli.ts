#!/usr/bin/env node
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { storyCandidates } from './candidates.ts';
import { loadConfig } from './config.ts';
import { buildMap } from './map.ts';
import { applyJudgments, judgmentFile, loadJudgments } from './judgments.ts';
import { SOURCE_SYNTAX_ERROR } from './parse.ts';
import { reviewAuthor, startReviewServer } from './review.ts';
import { SERVER_NOT_COMPARED } from './server.ts';
import { checkStoryFiles } from './story-paths.ts';
import { taskList } from './tasks.ts';
import { linkTests } from './test-links.ts';

const COMMANDS = ['extract', 'rebuild', 'review', 'tasks'];
const DEFAULT_PORT = 4400;
const AUTHOR_SOURCES: Record<string, string> = { config: 'config', git: 'git user.name', user: 'computer user name' };
const KEPT_BY: Record<string, string> = { source: 'the source', config: 'bodyOptions' };
const [, , command, configPath, ...extra] = process.argv;
const portArg = command === 'review' && extra[0] === '--port' && extra.length === 2 ? Number(extra[1]) : null;
if (!COMMANDS.includes(command) || !configPath || (extra.length > 0 && !Number.isInteger(portArg))) {
  console.error(`usage: duru <extract|rebuild|tasks> <config.json>\n       duru review <config.json> [--port <n>]`);
  process.exit(2);
}

const config = loadConfig(configPath);

if (command === 'tasks') {
  process.stdout.write(taskList(config));
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
  const server = await startReviewServer(config, { port: portArg ?? DEFAULT_PORT, author, onDone: end });
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
  fs.mkdirSync(config.outDir, { recursive: true });
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
  console.log(`wrote ${write('map.json', map)}`);
  const allEndpoints = Object.values<any>(map.apiFunctions).flatMap((f) => f.endpoints);
  const count = (st: string) => allEndpoints.filter((e) => e.server.status === st).length;
  console.log(`screens ${map.screens.length} | api functions ${Object.keys(map.apiFunctions).length} | endpoints match ${count('match')} method-mismatch ${count('method-mismatch')} none ${count('none')} unresolved ${count('unresolved')}${map.serverNotCompared ? ` unchecked ${count('unchecked')}` : ''}`);
  if (map.serverNotCompared) console.log(`  ${SERVER_NOT_COMPARED}`);
  for (const m of map.unrunApiModules ?? []) console.log(`  calledApiModules ${m.file} did not run: ${m.error}`);
  for (const f of map.silentApiModules ?? []) console.log(`  calledApiModules ${f} recorded no request; without requestFunction only requests sent with fetch or by moving the browser are recorded`);
  const direct = new Map<string, any>(map.screens.flatMap((s: any) => s.apiCalls.filter((c: any) => c.direct).map((c: any) => [`${c.file}\n${c.line}\n${c.fn}\n${c.endpoints[0].method} ${c.endpoints[0].url}`, c])));
  if (direct.size) console.log(`requests and navigations written in screen sources ${direct.size} | address not read ${map.unreadRequests?.length ?? 0}`);
  for (const r of map.unreadRequests ?? []) console.log(`  request ${r.fn} ← ${r.file}:${r.line}: address not read${r.url === null ? '' : `, only ${r.url}`}`);
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
  for (const s of map.screens.filter((s: any) => !s.componentFile)) console.log(`  component file not found for ${s.id} ← ${s.routeFile}:${s.line}`);

  if (command === 'rebuild') {
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
    for (const n of links.traceNotices) console.log(`  trace ${n.file} ← ${n.test.file}:${n.test.line} ${n.test.title}: ${n.reason}`);
    for (const m of links.missingSources) console.log(`  missing test results ${m}`);
    for (const u of unknownTags) console.log(`  unknown ${u.tag} ← ${u.test.file}:${u.test.line} ${u.test.title}`);

    const unjudged = list.flatMap((s) => s.links).filter((l) => l.verdict === 'unknown').length;
    console.log(`stories ${list.length} | broken paths ${list.filter((s) => s.broken).length} | detached ${list.filter((s) => s.detached).length} | unjudged steps ${unjudged} | story files skipped ${notices.length}`);
    const inStatus = (status: string) => list.filter((s) => s.status === status).length;
    console.log(`stories passing ${inStatus('pass')} | failing ${inStatus('fail')} | pending ${inStatus('pending')} | partly covered ${inStatus('partial')} | no tests ${inStatus('untested')}`);
    for (const n of notices) console.log(`  story file ${n.file}: ${n.reason}`);
    if (stale) console.log(`  ${stale}`);
    const candidates = storyCandidates(config, map, path.join(config.outDir, 'map.json'));
    console.log(`story candidates ${candidates.list.length} | files skipped ${candidates.notices.length}`);
    for (const n of candidates.notices) console.log(`  ${n.file}: ${n.reason}`);
  }
}
