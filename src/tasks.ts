import path from 'node:path';
import { compare } from './config.ts';
import { reviewData } from './review.ts';
import { SERVER_NOT_COMPARED } from './server.ts';
import { testsAt } from './story-paths.ts';
import { DEPTHS } from './test-links.ts';

const OPEN = ['needs-more', 'missing'];
const KIND_NAMES: Record<string, string> = { setting: 'a setting', role: 'a role' };
const MIXED_KINDS = 'differs by link';

const STORY_STATUS: Record<string, string> = {
  pass: 'pass — every story test passes',
  fail: 'fail — a story test fails',
  pending: 'pending — no story test fails and one is pending',
  partial: 'partial — no story test, and a screen on the path has tests',
  untested: 'untested — no story test, and no screen on the path has a test',
};

interface OptionCell {
  key: string;
  value: unknown;
}

interface TestRow {
  depth: string;
  status: string;
  options?: OptionCell[];
  cases?: string[];
  title?: string;
  file?: string | null;
  line?: number;
  detail?: string;
  project?: string;
}

interface MapInfo {
  screensById: Map<string, any>;
  restricted: Set<string>;
}

const TITLE = '<what it checks>';
const quoted = (tags: string) => JSON.stringify(`${TITLE} ${tags}`);
const EMPTY_TEST: Record<string, (tags: string, method: string) => string> = {
  playwright: (tags) => `test.fixme(${quoted(tags)}, async ({ page }) => {});`,
  junit: (tags, method) => `@Test @Disabled @DisplayName(${quoted(tags)}) void ${method}() {}`,
  vitest: (tags) => `test.todo(${quoted(tags)});`,
  verdict: (tags) => `VERDICT ${TITLE}: <verdict> — <what was seen> ${tags}`,
};

const count = (n: number, word: string, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;

const guardText = (g: { guard: string; via?: string; kinds: string[] }) => `\`${g.guard}\`${g.via ? ` through ${g.via}` : ''}${g.kinds.length ? ` (${g.kinds.join(', ')})` : ''}`;

const optionText = (o: OptionCell) => `${o.key}=${o.value}`;

function cellText({ option, depth }: { option?: OptionCell; depth?: string }, whole?: string) {
  if (!option) return depth ? `${depth} depth` : whole;
  return depth ? `${optionText(option)} at ${depth} depth` : optionText(option);
}

// 여러 줄인 글의 뒷줄을 들여 써서 항목 밖으로 나가 새 제목이나 항목이 되지 않게 한다.
const within = (text: string, indent: string) => text.replace(/\r\n?|\n/g, `\n${indent}`);

// 스토리 경로의 화면 태그는 메서드 이름에 넣지 않는다.
function methodName(tags: string[], used: Set<string>) {
  const base = tags.filter((t, i) => i === 0 || /^(option|depth|role|setting):/.test(t)).join('_').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

function emptyTestLines(formats: string[], tagSets: string[][]) {
  if (!formats.length) return ['- empty tests: none, the config lists no test results'];
  const used = new Set<string>();
  const lines = tagSets.flatMap((tags) => {
    const method = methodName(tags, used);
    return formats.map((f) => `  - ${f}: \`${EMPTY_TEST[f](tags.map((t) => `@${t}`).join(' '), method)}\``);
  });
  return ['- empty tests:', ...lines];
}

type Cell = { node: string; option?: OptionCell; depth?: string };
const cellTags = (kind: string, { node, option, depth }: Cell) => [`${kind}:${node}`, ...(option ? [`option:${optionText(option)}`] : []), ...(depth ? [`depth:${depth}`] : [])];

const quotedNote = (note: string | null | undefined, indent: string) => (note?.trim() ? `"${within(note.trim(), indent)}"` : null);
const byline = (author: string, date: string, indent: string) => `(${within(author, indent)}, ${date.slice(0, 10)})`;

function markLine(mark: any, where?: string) {
  const note = quotedNote(mark.note, '    ');
  return `  - ${mark.status}${where ? `, ${where}` : ''}${note ? ` — ${note}` : ''} ${byline(mark.author, mark.date, '    ')}`;
}

const kindsText = (kinds: string[]) => kinds.map((k) => KIND_NAMES[k]).join(' and ');

const needsText = (kinds: string[]) => (kinds.length ? `needs ${kindsText(kinds)}` : `${MIXED_KINDS}, see each link below`);

function linkInLines(links: any[], restricted: Set<string>) {
  return links.map((l: any) => {
    const from = `  - link from ${l.from} at ${l.file}:${l.line}`;
    const guards = l.guards.length ? `guard ${l.guards.map(guardText).join('; ')}` : 'no guard';
    const fromNeeds = l.fromKinds.length ? ` — ${l.from} itself needs ${kindsText(l.fromKinds)}` : restricted.has(l.from) ? ` — ${l.from} itself ${MIXED_KINDS}` : '';
    return `${from}, ${guards}${fromNeeds}`;
  });
}

function accessLines(access: any, restricted: Set<string>) {
  if (!access.restricted) return ['- access: opens without a setting or role'];
  return [`- access: ${needsText(access.kinds)}`, ...access.route.map((g: any) => `  - route guard ${guardText(g)}`), ...linkInLines(access.links, restricted)];
}

const byDepth = <T extends { depth: string }>(tests: T[]) => [...tests].sort((a, b) => DEPTHS.indexOf(a.depth) - DEPTHS.indexOf(b.depth));

function testSummary(tests: TestRow[] | undefined) {
  if (!tests?.length) return 'no tests';
  const counts = new Map<string, number>();
  for (const t of byDepth(tests)) counts.set(`${t.depth} ${t.status}`, (counts.get(`${t.depth} ${t.status}`) ?? 0) + 1);
  return 'tests: ' + [...counts].map(([k, n]) => `${k} ${n}`).join(', ');
}

const withOption = (tests: TestRow[] | undefined, { key, value }: OptionCell) => (tests ?? []).filter((t) => t.options?.some((o) => o.key === key && o.value === value));

function optionLines(keys: string[], tests: TestRow[]) {
  const rows = keys.flatMap((key) => [true, false].map((value): [string, TestRow[]] => [optionText({ key, value }), withOption(tests, { key, value })]));
  rows.push(['no option tag', tests.filter((t) => !t.options?.length)]);
  return rows.map(([label, matching]) => `    - ${label} — ${testSummary(matching)}`);
}

const CASE_TEXT: Record<string, (c: { opens: boolean }) => string> = {
  role: (c) => (c.opens ? 'opens for this role' : 'blocked for a role that does not open it, named in the test title'),
  setting: (c) => (c.opens ? 'opens with the setting condition met' : 'blocked with the setting condition not met'),
};
const withCase = (tests: TestRow[] | undefined, tag: string) => (tests ?? []).filter((t) => t.cases?.includes(tag));

function caseLines(screen: any, tests: TestRow[] | undefined) {
  if (!screen.cases.length) return [];
  return [
    `- cases (a test of one carries its tag with \`@screen:${screen.id}\`):`,
    ...screen.cases.map((c: any) => `  - \`@${c.tag}\` ${CASE_TEXT[c.kind](c)} — ${testSummary(withCase(tests, c.tag))}`),
    `  - in no case — ${testSummary((tests ?? []).filter((t) => !t.cases?.length))}`,
  ];
}

const untestedCases = (screen: any, tests: TestRow[] | undefined) => screen.cases.filter((c: any) => !withCase(tests, c.tag).length).map((c: any) => [`screen:${screen.id}`, c.tag]);

// 결과를 내주는 호출의 테스트는 세지 않는다.
function resultOptionLines(map: any, tests: Record<string, TestRow[]>) {
  const callsById = new Map<string, any>(map.calls.map((c: any) => [c.id, c]));
  const links = [...(map.callLinks ?? []), ...(map.unknownCallLinks ?? [])];
  return (callId: string, indent: string) => links.filter((l) => l.to === callId).flatMap((l) => {
    const head = `${indent}- options that change this result — set on ${l.from}, "${l.note}"`;
    const from = callsById.get(l.from);
    if (!from) return [`${head}: ${l.from} is not on the map`];
    if (!from.options.length) return [`${head}: none, ${l.from} has no options`];
    const output = (tests[l.from] ?? []).filter((t) => t.depth === 'output');
    return [`${head} (a test for these carries \`@call:${l.from}\`, its \`@option:\` tag and \`@depth:output\`):`, ...from.options.flatMap((o: any) => [true, false].map((value) => {
      const matching = withOption(output, { key: o.key, value });
      return `${indent}  - ${optionText({ key: o.key, value })} — ${matching.length ? testSummary(matching) : 'no tests at output depth'}`;
    }))];
  });
}

function callLines(screen: any, tests: Record<string, TestRow[]>, resultLines: ReturnType<typeof resultOptionLines>) {
  const seen = new Set<string>();
  const lines: string[] = [];
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
      const options = screen.callOptions[e.callId].map((o: any) => o.key);
      lines.push(`  - ${e.callId} — ${server}${testSummary(tests[e.callId])}${options.length ? ` — options: ${options.join(', ')}` : ''}`);
      if (options.length) lines.push(...optionLines(options, tests[e.callId] ?? []));
      lines.push(...resultLines(e.callId, '    '));
    }
  }
  return lines.length ? ['- calls:', ...lines] : ['- calls: none'];
}

function testLine(t: TestRow) {
  const at = t.line ? `${t.file}:${t.line}` : t.file;
  const detail = t.detail ? ` — ${t.detail}` : '';
  return `- ${t.depth} ${t.status} — ${t.title} — ${at}${t.project ? ` (${t.project})` : ''}${detail}`;
}

function testLines(tests: TestRow[] | undefined, label = 'tests') {
  if (!tests?.length) return [`- ${label}: none`];
  return [`- ${label}:`, ...byDepth(tests).map((t) => `  ${testLine(t)}`)];
}

function optionSource(option: any) {
  const sites = new Map<string, string[]>();
  for (const s of option.sites as { file: string; line: number; screen: string }[]) {
    const at = `${s.file}:${s.line}`;
    sites.set(at, [...(sites.get(at) ?? []), s.screen]);
  }
  const found = [...sites].map(([at, screens]) => `${at} (${screens.join(', ')})`).join('; ');
  const also = [option.sources.includes('type') && 'read from the request body type', option.sources.includes('config') && 'set in the config'].filter(Boolean);
  if (!found) return `${also.join('; ')}, not found in the source`;
  return `found at ${found}${also.map((a) => `; also ${a}`).join('')}`;
}

function markedOptionLines(call: any, marks: any[], tests: TestRow[] | undefined) {
  const targets = marks.map((m) => m.target).filter((t) => t.option);
  if (!targets.length) return [];
  const lines = ['- marked options:'];
  for (const option of call.options as any[]) {
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

function serverText(server: any) {
  if (server.status === 'match') return `on the server (${server.labels.join(', ')})`;
  if (server.status === 'method-mismatch') return `method mismatch — the server has ${server.candidates.join('; ')}`;
  if (server.status === 'unchecked') return 'not checked';
  if (server.status === 'none') return 'not on the server';
  return server.status;
}

const place = (p: { file: string; line: number }) => `${p.file}:${p.line}`;
const unreadText = (links: any[]) => links.map((l) => `${place(l)} \`${l.to}\``).join(', ');

function linkText(link: any) {
  if (link.verdict === 'broken') return 'no link';
  if (link.verdict === 'off-map') return 'not judged, a screen is not on the map';
  if (link.verdict === 'configured') return `a move in the config (${link.reasons.join(', ')})`;
  if (link.verdict === 'unknown') return `not judged, links to a path duru cannot read: ${unreadText(link.unknownLinks)}`;
  return `${link.verdict} at ${link.ways.map(place).join(', ')}`;
}

function stepLines(story: any, tests: any) {
  return story.steps.flatMap((step: any, i: number) => {
    const no = `${i + 1}. `;
    const indent = ' '.repeat(2 + no.length);
    const line = `  ${no}${within(step.screen, indent)} — ${step.onMap ? testSummary(testsAt(tests.nodes, step.screen)) : 'not on the map'}`;
    const link = story.links[i];
    return link ? [line, `${indent}- to ${within(link.to, `${indent}  `)}: ${linkText(link)}`] : [line];
  });
}

function reachProblems(story: any) {
  const broken = story.links.filter((l: any) => l.verdict === 'broken').length;
  return [
    broken && `unreachable, no link at ${count(broken, 'step')}`,
    story.detached && 'not judged, a screen is not on the map',
    story.unjudged && 'not judged, a link to a path duru cannot read',
  ].filter(Boolean);
}

function preconditionLines(r: any, { screensById, restricted }: MapInfo) {
  if (r.kind === 'start') {
    const roles = r.roleValues ? `; roles that open it: ${r.roleValues.join(', ')}` : r.roleValues === null ? '; the roles that open it could not be read' : '';
    return [`  - ${r.screen}, the first screen, ${needsText(r.kinds)}${roles}`, ...linkInLines(screensById.get(r.screen).access.links, restricted).map((l) => `  ${l}`)];
  }
  if (r.kind === 'route') return [`  - ${r.screen} route at ${r.file}:${r.line}, guard ${r.guards.map(guardText).join('; ')}`];
  const way = (w: any) => `${place(w)}, guard ${w.conditions.map(guardText).join('; ')}`;
  const head = `  - link ${r.from} → ${r.to}`;
  return [
    ...(r.ways.length === 1 ? [`${head} at ${way(r.ways[0])}`] : [`${head}, one of ${r.ways.length}:`, ...r.ways.map((w: any) => `    - at ${way(w)}`)]),
    ...(r.unknownLinks ? [`    - judged without links to a path duru cannot read: ${unreadText(r.unknownLinks)}`] : []),
  ];
}

function storyLines(story: any, marks: any[], tests: any, mapInfo: MapInfo, formats: string[]) {
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
      ? ['- preconditions:', ...story.reach.flatMap((r: any) => preconditionLines(r, mapInfo))]
      : [`- preconditions: ${problems.length ? 'none where links were found' : 'none'}`]),
    ...emptyTestLines(formats, [[`story:${story.id}`, ...new Set<string>(story.steps.filter((s: any) => s.onMap).map((s: any) => `screen:${s.screen}`))]]),
  ];
}

const TAG_PLACE: Record<string, (tag: string) => string> = {
  playwright: (tag) => `in the test's \`tag\` option (\`{ tag: '${tag}' }\`), leaving the title as it is`,
  vitest: () => "at the end of the test's own title, not a `describe` title",
  junit: () => "at the end of the test's `@DisplayName`",
  verdict: () => 'at the end of its VERDICT line',
};

const TAGGING_INTRO = "A reviewer judged that each of these tests checks a screen or API call it carries no tag for. Add the tag where its format reads it (`where`), changing nothing else in the test, then run the test so its result file is written again and run `duru rebuild`, and read this list again: a test that carries the tag counts as a test of that screen or call, and its item leaves this list. The item also leaves, without being done, if the test's file changes or its title changes in any way other than the added tag. duru does not edit test files.";

export function taggingLines(awaitingTag: Record<string, any[]>, callIds: Set<string>) {
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

export function taskList(config: any) {
  const { map, tests, marks, appLinks, stories } = reviewData(config, null);
  const open = marks.attached.filter((m) => OPEN.includes(m.current.status));
  const marked = (node: any) => open.some((m) => m.target.node === node.id);
  const screens = map.screens.filter(marked).sort((a: any, b: any) => a.id.localeCompare(b.id));
  const calls = map.calls.filter(marked);
  const storyMarks = open.filter((m) => m.target.story !== undefined);
  const restricted = new Set<string>(map.screens.filter((s: any) => s.access.restricted).map((s: any) => s.id));
  const relative = (p: string) => path.relative(config.configDir, p).split(path.sep).join('/');
  const formats = [...new Set<string>(config.tests.map((t: any) => t.format))];
  const resultLines = resultOptionLines(map, tests.nodes);

  const out = [
    `# Test tasks — ${count(screens.length, 'screen')}, ${count(calls.length, 'call')}, ${count(storyMarks.length, 'story', 'stories')}, ${count(open.length, 'open mark')}`,
    '',
    `A reviewer marked these screens, API calls and stories as needing more tests (\`needs-more\`) or as having none (\`missing\`). Write the tests, put \`@screen:<screen ID>\` in each test title (\`@call:<call ID>\` for a test of one API call, with \`@option:<key>=true|false\` for each on/off option the test sets, and for a screen that opens only under a role or a setting the tag of each case under \`cases\` it checks), add \`@depth:<${DEPTHS.join('|')}>\` when the depth of the result source does not fit, then run \`duru rebuild\` and read this list again. For a story, write a test that goes through its screens in order and put \`@story:<story ID>\` in its title as well. Under \`empty tests\`, a screen or call gets one set for each open mark, a screen one more for each case with no tests, and a story one set: an empty test for each test format in the config, with the tags already in its title and held back from passing (\`test.fixme\`, \`test.todo\`, \`@Disabled\` with \`import org.junit.jupiter.api.Disabled;\`, or no verdict word). Copy the one for your runner, keep the tags, remove what holds it back and fill in the data setup and the checks. A screen, call or story stays here until a reviewer marks it \`fine\`.`,
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
      `- component: ${s.componentFile}, route at ${s.routeFile}:${s.line}`,
      ...(appLinks[s.id] ? [`- app: ${appLinks[s.id]}`] : []),
      ...accessLines(s.access, restricted),
      ...caseLines(s, tests.nodes[s.id]),
      ...callLines(s, tests.nodes, resultLines),
      ...testLines(tests.nodes[s.id]),
      ...emptyTestLines(formats, [...marks.map((m) => cellTags('screen', m.target as Cell)), ...untestedCases(s, tests.nodes[s.id])]),
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
      ...resultLines(c.id, ''),
      ...markedOptionLines(c, marks, tests.nodes[c.id]),
      ...testLines(tests.nodes[c.id]),
      ...emptyTestLines(formats, marks.map((m) => cellTags('call', m.target as Cell))),
    );
  }
  if (storyMarks.length) out.push('', '# Stories', '', `Story files are in \`${relative(config.storiesDir)}\`.`);
  if (storyMarks.length && stories.stale) {
    out.push('', 'The map was built by a duru older than stories, so these stories are not checked against it. Run `duru rebuild` and read this list again.');
    for (const m of storyMarks) out.push('', `## ${m.target.story}`, '', '- marks:', markLine(m.current));
  }
  const mapInfo = { screensById: new Map<string, any>(map.screens.map((s: any) => [s.id, s])), restricted };
  for (const id of [...new Set(storyMarks.map((m) => m.target.story))]) {
    const own = storyMarks.filter((m) => m.target.story === id);
    const story = stories.list.find((s) => s.id === id);
    if (story) out.push(...storyLines(story, own, tests, mapInfo, formats));
    else if (!stories.stale) out.push('', `## ${id}`, '', '- marks:', ...own.map((m) => markLine(m.current)), '- story file: could not be read; `duru rebuild` prints why');
  }
  out.push(...taggingLines(tests.awaitingTag, new Set<string>(map.calls.map((c: any) => c.id))));
  return out.join('\n') + '\n';
}
