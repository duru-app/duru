import path from 'node:path';
import { compare } from './config.mjs';
import { reviewData } from './review.mjs';
import { SERVER_NOT_COMPARED } from './server.mjs';
import { testsAt } from './story-paths.mjs';
import { DEPTHS } from './test-links.mjs';

const OPEN = ['needs-more', 'missing'];
const KIND_NAMES = { setting: 'a setting', role: 'a role' };
const MIXED_KINDS = 'differs by link';

const STORY_STATUS = {
  pass: 'pass — every story test passes',
  fail: 'fail — a story test fails',
  pending: 'pending — no story test fails and one is pending',
  partial: 'partial — no story test, and a screen on the path has tests',
  untested: 'untested — no story test, and no screen on the path has a test',
};

const TITLE = '<what it checks>';
const quoted = (tags) => JSON.stringify(`${TITLE} ${tags}`);
const EMPTY_TEST = {
  playwright: (tags) => `test.fixme(${quoted(tags)}, async ({ page }) => {});`,
  junit: (tags, method) => `@Test @Disabled @DisplayName(${quoted(tags)}) void ${method}() {}`,
  vitest: (tags) => `test.todo(${quoted(tags)});`,
  verdict: (tags) => `VERDICT ${TITLE}: <verdict> — <what was seen> ${tags}`,
};

const count = (n, word, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;

const guardText = (g) => `\`${g.guard}\`${g.via ? ` through ${g.via}` : ''}${g.kinds.length ? ` (${g.kinds.join(', ')})` : ''}`;

const optionText = (o) => `${o.key}=${o.value}`;

function cellText({ option, depth }, whole) {
  if (!option) return depth ? `${depth} depth` : whole;
  return depth ? `${optionText(option)} at ${depth} depth` : optionText(option);
}

// 여러 줄인 글의 뒷줄을 들여 써서 항목 밖으로 나가 새 제목이나 항목이 되지 않게 한다.
const within = (text, indent) => text.replace(/\r\n?|\n/g, `\n${indent}`);

// 스토리 경로의 화면 태그는 메서드 이름에 넣지 않는다.
function methodName(tags, used) {
  const base = tags.filter((t, i) => i === 0 || /^(option|depth):/.test(t)).join('_').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

function emptyTestLines(formats, tagSets) {
  if (!formats.length) return ['- empty tests: none, the config lists no test results'];
  const used = new Set();
  const lines = tagSets.flatMap((tags) => {
    const method = methodName(tags, used);
    return formats.map((f) => `  - ${f}: \`${EMPTY_TEST[f](tags.map((t) => `@${t}`).join(' '), method)}\``);
  });
  return ['- empty tests:', ...lines];
}

const cellTags = (kind, { node, option, depth }) => [`${kind}:${node}`, ...(option ? [`option:${optionText(option)}`] : []), ...(depth ? [`depth:${depth}`] : [])];

const quotedNote = (note, indent) => (note?.trim() ? `"${within(note.trim(), indent)}"` : null);
const byline = (author, date, indent) => `(${within(author, indent)}, ${date.slice(0, 10)})`;

function markLine(mark, where) {
  const note = quotedNote(mark.note, '    ');
  return `  - ${mark.status}${where ? `, ${where}` : ''}${note ? ` — ${note}` : ''} ${byline(mark.author, mark.date, '    ')}`;
}

const kindsText = (kinds) => kinds.map((k) => KIND_NAMES[k]).join(' and ');

const needsText = (kinds) => (kinds.length ? `needs ${kindsText(kinds)}` : `${MIXED_KINDS}, see each link below`);

function linkInLines(links, restricted) {
  return links.map((l) => {
    const from = `  - link from ${l.from} at ${l.file}:${l.line}`;
    const guards = l.guards.length ? `guard ${l.guards.map(guardText).join('; ')}` : 'no guard';
    const fromNeeds = l.fromKinds.length ? ` — ${l.from} itself needs ${kindsText(l.fromKinds)}` : restricted.has(l.from) ? ` — ${l.from} itself ${MIXED_KINDS}` : '';
    return `${from}, ${guards}${fromNeeds}`;
  });
}

function accessLines(access, restricted) {
  if (!access.restricted) return ['- access: opens without a setting or role'];
  return [`- access: ${needsText(access.kinds)}`, ...access.route.map((g) => `  - route guard ${guardText(g)}`), ...linkInLines(access.links, restricted)];
}

const byDepth = (tests) => [...tests].sort((a, b) => DEPTHS.indexOf(a.depth) - DEPTHS.indexOf(b.depth));

function testSummary(tests) {
  if (!tests?.length) return 'no tests';
  const counts = new Map();
  for (const t of byDepth(tests)) counts.set(`${t.depth} ${t.status}`, (counts.get(`${t.depth} ${t.status}`) ?? 0) + 1);
  return 'tests: ' + [...counts].map(([k, n]) => `${k} ${n}`).join(', ');
}

const withOption = (tests, { key, value }) => (tests ?? []).filter((t) => t.options?.some((o) => o.key === key && o.value === value));

function optionLines(keys, tests) {
  const rows = keys.flatMap((key) => [true, false].map((value) => [optionText({ key, value }), withOption(tests, { key, value })]));
  rows.push(['no option tag', tests.filter((t) => !t.options?.length)]);
  return rows.map(([label, matching]) => `    - ${label} — ${testSummary(matching)}`);
}

function callLines(screen, tests) {
  const seen = new Set();
  const lines = [];
  for (const call of screen.apiCalls) {
    if (!call.endpoints) {
      lines.push(`  - ${call.fn} at ${call.file}:${call.line} — not found among the API functions`);
      continue;
    }
    for (const e of call.endpoints) {
      if (!e.callId) {
        lines.push(`  - ${call.fn} at ${call.file}:${call.line} — address not resolved`);
        continue;
      }
      if (seen.has(e.callId)) continue;
      seen.add(e.callId);
      const server = e.server.status === 'none' ? 'not on the server, ' : '';
      const options = screen.callOptions[e.callId].map((o) => o.key);
      lines.push(`  - ${e.callId} — ${server}${testSummary(tests[e.callId])}${options.length ? ` — options: ${options.join(', ')}` : ''}`);
      if (options.length) lines.push(...optionLines(options, tests[e.callId] ?? []));
    }
  }
  return lines.length ? ['- calls:', ...lines] : ['- calls: none'];
}

function testLine(t) {
  const at = t.line ? `${t.file}:${t.line}` : t.file;
  const detail = t.detail ? ` — ${t.detail}` : '';
  return `- ${t.depth} ${t.status} — ${t.title} — ${at}${t.project ? ` (${t.project})` : ''}${detail}`;
}

function testLines(tests, label = 'tests') {
  if (!tests?.length) return [`- ${label}: none`];
  return [`- ${label}:`, ...byDepth(tests).map((t) => `  ${testLine(t)}`)];
}

function optionSource(option) {
  const sites = new Map();
  for (const s of option.sites) {
    const at = `${s.file}:${s.line}`;
    sites.set(at, [...(sites.get(at) ?? []), s.screen]);
  }
  const found = [...sites].map(([at, screens]) => `${at} (${screens.join(', ')})`).join('; ');
  const config = option.sources.includes('config');
  if (!found) return 'set in the config, not found in the source';
  return `found at ${found}${config ? '; also set in the config' : ''}`;
}

function markedOptionLines(call, marks, tests) {
  const targets = marks.map((m) => m.target).filter((t) => t.option);
  if (!targets.length) return [];
  const lines = ['- marked options:'];
  for (const option of call.options) {
    const cells = targets
      .filter((t) => t.option.key === option.key)
      .sort((a, b) => Number(b.option.value) - Number(a.option.value) || DEPTHS.indexOf(a.depth) - DEPTHS.indexOf(b.depth));
    if (!cells.length) continue;
    lines.push(`  - ${option.key} — ${optionSource(option)}`);
    for (const t of cells) {
      const matching = withOption(tests, t.option).filter((x) => !t.depth || x.depth === t.depth);
      const label = `    - ${cellText(t)}:`;
      lines.push(...(matching.length ? [label, ...byDepth(matching).map((x) => `      ${testLine(x)}`)] : [`${label} no tests`]));
    }
  }
  return lines;
}

function serverText(server) {
  if (server.status === 'match') return `on the server (${server.labels.join(', ')})`;
  if (server.status === 'method-mismatch') return `method mismatch — the server has ${server.candidates.join('; ')}`;
  if (server.status === 'unchecked') return 'not checked';
  if (server.status === 'none') return 'not on the server';
  return server.status;
}

const place = (p) => `${p.file}:${p.line}`;
const unreadText = (links) => links.map((l) => `${place(l)} \`${l.to}\``).join(', ');

function linkText(link) {
  if (link.verdict === 'broken') return 'no link';
  if (link.verdict === 'off-map') return 'not judged, a screen is not on the map';
  if (link.verdict === 'unknown') return `not judged, links to a path duru cannot read: ${unreadText(link.unknownLinks)}`;
  return `${link.verdict} at ${link.ways.map(place).join(', ')}`;
}

function stepLines(story, tests) {
  return story.steps.flatMap((step, i) => {
    const no = `${i + 1}. `;
    const indent = ' '.repeat(2 + no.length);
    const line = `  ${no}${within(step.screen, indent)} — ${step.onMap ? testSummary(testsAt(tests.nodes, step.screen)) : 'not on the map'}`;
    const link = story.links[i];
    return link ? [line, `${indent}- to ${within(link.to, `${indent}  `)}: ${linkText(link)}`] : [line];
  });
}

function reachProblems(story) {
  const broken = story.links.filter((l) => l.verdict === 'broken').length;
  return [
    broken && `unreachable, no link at ${count(broken, 'step')}`,
    story.detached && 'not judged, a screen is not on the map',
    story.unjudged && 'not judged, a link to a path duru cannot read',
  ].filter(Boolean);
}

function preconditionLines(r, { screensById, routesFile, restricted }) {
  if (r.kind === 'start') {
    const roles = r.roleValues ? `; roles that open it: ${r.roleValues.join(', ')}` : r.roleValues === null ? '; the roles that open it could not be read' : '';
    return [`  - ${r.screen}, the first screen, ${needsText(r.kinds)}${roles}`, ...linkInLines(screensById.get(r.screen).access.links, restricted).map((l) => `  ${l}`)];
  }
  if (r.kind === 'route') return [`  - ${r.screen} route at ${routesFile}:${r.line}, guard ${r.guards.map(guardText).join('; ')}`];
  const way = (w) => `${place(w)}, guard ${w.conditions.map(guardText).join('; ')}`;
  const head = `  - link ${r.from} → ${r.to}`;
  return [
    ...(r.ways.length === 1 ? [`${head} at ${way(r.ways[0])}`] : [`${head}, one of ${r.ways.length}:`, ...r.ways.map((w) => `    - at ${way(w)}`)]),
    ...(r.unknownLinks ? [`    - judged without links to a path duru cannot read: ${unreadText(r.unknownLinks)}`] : []),
  ];
}

function storyLines(story, marks, tests, mapInfo, formats) {
  const problems = reachProblems(story);
  return [
    '',
    `## ${story.id}`,
    '',
    `- name: ${within(story.name, '  ')}`,
    '- marks:',
    ...marks.map((m) => markLine(m.current)),
    `- story file: ${story.file} (${within(story.author, '  ')}, ${story.date.slice(0, 10)})`,
    ...(story.memo ? [`- memo: ${within(story.memo, '  ')}`] : []),
    `- status: ${STORY_STATUS[story.status]}`,
    ...testLines(testsAt(tests.stories, story.id), 'story tests'),
    '- screens:',
    ...stepLines(story, tests),
    `- reach: ${problems.length ? problems.join('; ') : 'reachable'}`,
    ...(story.reach.length
      ? ['- preconditions:', ...story.reach.flatMap((r) => preconditionLines(r, mapInfo))]
      : [`- preconditions: ${problems.length ? 'none where links were found' : 'none'}`]),
    ...emptyTestLines(formats, [[`story:${story.id}`, ...new Set(story.steps.filter((s) => s.onMap).map((s) => `screen:${s.screen}`))]]),
  ];
}

const TAG_PLACE = {
  playwright: (tag) => `in the test's \`tag\` option (\`{ tag: '${tag}' }\`), leaving the title as it is`,
  vitest: () => "at the end of the test's own title, not a `describe` title",
  junit: () => "at the end of the test's `@DisplayName`",
  verdict: () => 'at the end of its VERDICT line',
};

const TAGGING_INTRO = "A reviewer judged that each of these tests checks a screen or API call it carries no tag for. Add the tag where its format reads it (`where`), changing nothing else in the test, then run the test so its result file is written again and run `duru rebuild`, and read this list again: a test that carries the tag counts as a test of that screen or call, and its item leaves this list. The item also leaves, without being done, if the test's file changes or its title changes in any way other than the added tag. duru does not edit test files.";

export function taggingLines(awaitingTag, callIds) {
  const items = Object.entries(awaitingTag).flatMap(([node, tests]) => tests.map((t) => ({ node, t })));
  if (!items.length) return [];
  items.sort((a, b) =>
    compare(a.t.ref.file, b.t.ref.file) || (a.t.line ?? 0) - (b.t.line ?? 0) || compare(a.t.ref.title, b.t.ref.title) || compare(a.t.ref.source, b.t.ref.source) || compare(a.node, b.node));
  return ['', '# Tagging', '', TAGGING_INTRO].concat(items.flatMap(({ node, t }) => {
    const tag = `@${callIds.has(node) ? 'call' : 'screen'}:${node}`;
    const { reason, author, date } = t.judgment;
    return [
      '',
      `## ${t.line ? `${t.ref.file}:${t.line}` : t.ref.file} → ${node}`,
      '',
      `- title: ${within(t.title, '  ')}`,
      `- tag to add: \`${tag}\``,
      `- where: ${TAG_PLACE[t.format](tag)}`,
      `- note: ${quotedNote(reason, '  ') ?? 'none'} ${byline(author, date, '  ')}`,
    ];
  }));
}

export function taskList(config) {
  const { map, tests, marks, appLinks, stories } = reviewData(config, null);
  const open = marks.attached.filter((m) => OPEN.includes(m.current.status));
  const marked = (node) => open.some((m) => m.target.node === node.id);
  const screens = map.screens.filter(marked).sort((a, b) => a.id.localeCompare(b.id));
  const calls = map.calls.filter(marked);
  const storyMarks = open.filter((m) => m.target.story !== undefined);
  const restricted = new Set(map.screens.filter((s) => s.access.restricted).map((s) => s.id));
  const relative = (p) => path.relative(config.configDir, p).split(path.sep).join('/');
  const formats = [...new Set(config.tests.map((t) => t.format))];

  const out = [
    `# Test tasks — ${count(screens.length, 'screen')}, ${count(calls.length, 'call')}, ${count(storyMarks.length, 'story', 'stories')}, ${count(open.length, 'open mark')}`,
    '',
    `A reviewer marked these screens, API calls and stories as needing more tests (\`needs-more\`) or as having none (\`missing\`). Write the tests, put \`@screen:<screen ID>\` in each test title (\`@call:<call ID>\` for a test of one API call, with \`@option:<key>=true|false\` for each on/off option the test sets), add \`@depth:<${DEPTHS.join('|')}>\` when the depth of the result source does not fit, then run \`duru rebuild\` and read this list again. For a story, write a test that goes through its screens in order and put \`@story:<story ID>\` in its title as well. Under \`empty tests\`, a screen or call gets one set for each open mark and a story one set: an empty test for each test format in the config, with the tags already in its title and held back from passing (\`test.fixme\`, \`test.todo\`, \`@Disabled\` with \`import org.junit.jupiter.api.Disabled;\`, or no verdict word). Copy the one for your runner, keep the tags, remove what holds it back and fill in the data setup and the checks. A screen, call or story stays here until a reviewer marks it \`fine\`.`,
    '',
    `Source files are under \`${relative(config.srcRoot)}\`.`,
  ];
  if (map.serverNotCompared) out.push('', `${SERVER_NOT_COMPARED}, so no call below is written as missing on the server.`);
  if (!open.length) out.push('', 'No open marks.');
  for (const s of screens) {
    const marks = open.filter((m) => m.target.node === s.id);
    out.push(
      '',
      `## ${s.id}`,
      '',
      '- marks:',
      ...marks.map((m) => markLine(m.current, cellText(m.target, 'whole screen'))),
      `- component: ${s.componentFile}, route at ${config.routesFile}:${s.line}`,
      ...(appLinks[s.id] ? [`- app: ${appLinks[s.id]}`] : []),
      ...accessLines(s.access, restricted),
      ...callLines(s, tests.nodes),
      ...testLines(tests.nodes[s.id]),
      ...emptyTestLines(formats, marks.map((m) => cellTags('screen', m.target))),
    );
  }
  if (calls.length) out.push('', '# API calls');
  for (const c of calls) {
    const marks = open.filter((m) => m.target.node === c.id);
    out.push(
      '',
      `## ${c.id}`,
      '',
      '- marks:',
      ...marks.map((m) => markLine(m.current, cellText(m.target, 'whole call'))),
      `- called from: ${c.screens.length ? c.screens.join(', ') : 'no screen'}`,
      `- server: ${serverText(c.server)}`,
      ...markedOptionLines(c, marks, tests.nodes[c.id]),
      ...testLines(tests.nodes[c.id]),
      ...emptyTestLines(formats, marks.map((m) => cellTags('call', m.target))),
    );
  }
  if (storyMarks.length) out.push('', '# Stories', '', `Story files are in \`${relative(config.storiesDir)}\`.`);
  if (storyMarks.length && stories.stale) {
    out.push('', 'The map was built by a duru older than stories, so these stories are not checked against it. Run `duru rebuild` and read this list again.');
    for (const m of storyMarks) out.push('', `## ${m.target.story}`, '', '- marks:', markLine(m.current));
  }
  const mapInfo = { screensById: new Map(map.screens.map((s) => [s.id, s])), routesFile: config.routesFile, restricted };
  for (const id of [...new Set(storyMarks.map((m) => m.target.story))]) {
    const own = storyMarks.filter((m) => m.target.story === id);
    const story = stories.list.find((s) => s.id === id);
    if (story) out.push(...storyLines(story, own, tests, mapInfo, formats));
    else if (!stories.stale) out.push('', `## ${id}`, '', '- marks:', ...own.map((m) => markLine(m.current)), '- story file: could not be read; `duru rebuild` prints why');
  }
  out.push(...taggingLines(tests.awaitingTag, new Set(map.calls.map((c) => c.id))));
  return out.join('\n') + '\n';
}
