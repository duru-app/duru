#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { storyCandidates } from './candidates.mjs';
import { loadConfig } from './config.mjs';
import { buildMap } from './map.mjs';
import { applyJudgments, judgmentFile, loadJudgments } from './judgments.mjs';
import { reviewAuthor, startReviewServer } from './review.mjs';
import { SERVER_NOT_COMPARED } from './server.mjs';
import { checkStoryFiles } from './story-paths.mjs';
import { taskList } from './tasks.mjs';
import { linkTests } from './test-links.mjs';

const COMMANDS = ['extract', 'rebuild', 'review', 'tasks'];
const DEFAULT_PORT = 4400;
const AUTHOR_SOURCES = { config: 'config', git: 'git user.name', user: 'computer user name' };
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
    } catch (err) {
      console.error(`could not build the task list: ${err.message}`);
    }
  });
  // 표준 출력에는 작업 목록만 나가야 리뷰를 띄운 에이전트가 그대로 읽을 수 있다.
  console.error(`review page http://127.0.0.1:${server.address().port}/`);
  console.error(`marks ${config.marksDir} | stories ${config.storiesDir} | author ${author.name} (${AUTHOR_SOURCES[author.source]})`);
} else {
  fs.mkdirSync(config.outDir, { recursive: true });
  const write = (name, data) => {
    const file = path.join(config.outDir, name);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    return file;
  };

  const map = await buildMap(config);
  console.log(`wrote ${write('map.json', map)}`);
  const allEndpoints = Object.values(map.apiFunctions).flatMap((f) => f.endpoints);
  const count = (st) => allEndpoints.filter((e) => e.server.status === st).length;
  console.log(`screens ${map.screens.length} | api functions ${Object.keys(map.apiFunctions).length} | endpoints match ${count('match')} method-mismatch ${count('method-mismatch')} none ${count('none')} unresolved ${count('unresolved')}${map.serverNotCompared ? ` unchecked ${count('unchecked')}` : ''}`);
  if (map.serverNotCompared) console.log(`  ${SERVER_NOT_COMPARED}`);
  console.log(`dead calls reachable from screens: ${map.deadCalls.length}`);
  console.log(`calls ${map.calls.length} | dead screens ${map.screens.filter((s) => s.dead).length}`);
  console.log(`entry screens ${map.entries.length} | screens opening only under a setting or role ${map.screens.filter((s) => s.access.restricted).length}`);
  for (const p of map.unknownEntryPaths) console.log(`  entryPaths ${p} matches no route`);
  for (const p of map.unknownMovePaths) console.log(`  moves ${p} matches no route`);
  for (const id of map.unknownBodyOptionCalls) console.log(`  bodyOptions ${id} matches no call`);
  for (const l of map.unknownCallLinks) for (const id of l.missing) console.log(`  callLinks ${l.from} → ${l.to}: ${id} matches no call`);
  for (const d of map.duplicateIds) console.log(`  duplicate screen ID ${d.id} ← ${d.lines.map((l) => `${config.routesFile}:${l}`).join(', ')}`);

  if (command === 'rebuild') {
    const links = linkTests(config, map);
    console.log(`wrote ${write('tests.json', links)}`);
    const { list, notices, stale, unknownTags: unknownStories } = checkStoryFiles(map, config.storiesDir, path.join(config.outDir, 'map.json'), links);
    const unknownTags = [...links.unknownTags, ...unknownStories];
    const covered = map.screens.filter((s) => links.nodes[s.id]).length;
    console.log(`screens with tests ${covered}/${map.screens.length} | tags pointing outside the map ${unknownTags.length} | tests without a node or story tag ${links.untaggedCount}`);
    console.log(`calls with tests ${map.calls.filter((c) => links.nodes[c.id]).length}/${map.calls.length}`);
    const { judgments, notices: judgmentNotices } = loadJudgments(config.judgmentsDir);
    const judged = applyJudgments(links, judgments);
    const pairs = (byScreen) => Object.values(byScreen).reduce((n, tests) => n + tests.length, 0);
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
    const inStatus = (status) => list.filter((s) => s.status === status).length;
    console.log(`stories passing ${inStatus('pass')} | failing ${inStatus('fail')} | pending ${inStatus('pending')} | partly covered ${inStatus('partial')} | no tests ${inStatus('untested')}`);
    for (const n of notices) console.log(`  story file ${n.file}: ${n.reason}`);
    if (stale) console.log(`  ${stale}`);
    const candidates = storyCandidates(config, map, path.join(config.outDir, 'map.json'));
    console.log(`story candidates ${candidates.list.length} | files skipped ${candidates.notices.length}`);
    for (const n of candidates.notices) console.log(`  ${n.file}: ${n.reason}`);
  }
}
