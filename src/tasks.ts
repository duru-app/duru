import fs from 'node:fs';
import path from 'node:path';
import type { Described } from './access.ts';
import { readSettingsFile, settingsFilePlace } from './app-host.ts';
import { newUndecided } from './baseline.ts';
import { compareTests, nodeIds, passedInFolder, readBaselineTests, wholeFines } from './baseline-tests.ts';
import type { TestComparison } from './baseline-tests.ts';
import type { BaselineChanges } from './baseline.ts';
import type { AppAccount } from './app-host.ts';
import { acceptsProposal, casesWithoutTests, kindTags } from './case-targets.ts';
import type { CaseTarget, KindTargets } from './case-targets.ts';
import type { TableItem } from './client.ts';
import { compare } from './config.ts';
import type { CaseKind } from './config.ts';
import { GENERAL, orderKey, recordKind } from './marks.ts';
import type { MarkEntry } from './marks.ts';
import { findNeed, needPath } from './needs.ts';
import { reviewData } from './review.ts';
import { SERVER_NOT_COMPARED } from './server.ts';
import { settingChange } from './setting-changes.ts';
import type { MapDefaults, SettingsFileValues } from './setting-changes.ts';
import type { SettingNeed } from './setting-needs.ts';
import { BOX_WORDS } from './stories.ts';
import { fillCode } from './playwright-trace.ts';
import { testsAt } from './story-paths.ts';
import { escapeText, readableRoute, routePattern } from './path-values.ts';
import { DEPTHS } from './test-links.ts';

const KIND_NAMES: Record<string, string> = { setting: 'a setting', role: 'a role' };
const MIXED_KINDS = 'differs by link';
const REGRESSION_ONLY = '- marks: none, listed for comments on regressed tests';

const STORY_STATUS: Record<string, string> = {
  pass: 'pass — every story test passes',
  'part-pass': 'part-pass — every story test passes, but none went through every screen of the story in order',
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

export interface MapInfo {
  screensById: Map<string, any>;
  restricted: Set<string>;
}

const TITLE = '<what it checks>';
const inTitle = (tags: string[]) => tags.join(' ');
const quoted = (tags: string[]) => JSON.stringify(`${TITLE} ${inTitle(tags)}`);
const tagOption = (tags: string[]) => `{ tag: [${tags.map((t) => JSON.stringify(t)).join(', ')}] }`;
const EMPTY_TEST: Record<string, (tags: string[], method: string) => string> = {
  playwright: (tags) => `test.fixme(${JSON.stringify(TITLE)}, ${tagOption(tags)}, async ({ page }) => {});`,
  junit: (tags, method) => `@Test @Disabled @DisplayName(${quoted(tags)}) void ${method}() {}`,
  vitest: (tags) => `test.todo(${quoted(tags)});`,
  verdict: (tags) => `VERDICT ${TITLE}: <verdict> — <what was seen> ${inTitle(tags)}`,
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
  const base = tags.filter((t, i) => i === 0 || /^(option|depth|role|setting|case):/.test(t)).join('_').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
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
    return formats.map((f) => `  - ${f}: \`${EMPTY_TEST[f](tags.map((t) => `@${t}`), method)}\``);
  });
  return ['- empty tests:', ...lines];
}

type Cell = { node: string; option?: OptionCell; depth?: string };
const cellTags = (kind: string, { node, option, depth }: Cell) => [`${kind}:${node}`, ...(option ? [`option:${optionText(option)}`] : []), ...(depth ? [`depth:${depth}`] : [])];

const quotedNote = (note: string | null | undefined, indent: string) => (note?.trim() ? `"${within(note.trim(), indent)}"` : null);
const byline = (author: string, date: string, indent: string) => `(${within(author, indent)}, ${date.slice(0, 10)})`;

function targetText(t: any) {
  if (t.candidate !== undefined) return `story candidate ${t.candidate}`;
  if (t.screens !== undefined) return `screen order ${orderKey(t.screens)}`;
  const part = t.part && (t.part.kind === 'step' ? `step ${t.part.key.step}`
    : t.part.kind === 'hop' ? `link from step ${t.part.key.step}`
    : t.part.kind === 'test' ? `test "${t.part.key.title}"`
    : t.part.kind === 'condition' ? `condition \`${t.part.key}\``
    : `link from ${t.part.key.from}`);
  const head = t.story !== undefined ? `story ${t.story}` : t.node;
  return [head, t.option && `option ${optionText(t.option)}`, t.depth && `${t.depth} depth`, part].filter(Boolean).join(', ');
}

function markLine(mark: any, where?: string, indent = '  ') {
  const note = quotedNote(mark.note, `${indent}  `);
  const also = mark.replyTo === undefined && mark.targets?.length > 1 ? `, left on ${mark.targets.length} targets: ${within(mark.targets.map(targetText).join('; '), `${indent}  `)}` : '';
  return `${indent}- ${mark.status ?? recordKind(mark)}${where ? `, ${where}` : ''}${also}${note ? ` — ${note}` : ''} ${byline(mark.author, mark.date, `${indent}  `)}`;
}

const laterComments = (m: any) => m.history.slice(0, m.history.indexOf(m.current)).reverse().filter((r: any) => r.replyTo === undefined);
const repliesTo = (m: any, record: any) => m.history.filter((r: any) => r.replyTo === record.id).reverse();
const entryLines = (m: any, where?: string) => [m.current, ...laterComments(m)].flatMap((r) => [markLine(r, where), ...repliesTo(m, r).map((reply: any) => markLine(reply, undefined, '    '))]);

const RELATION_TEXT: Record<string, (word: string) => string> = {
  tagged: (word) => `tagged with this ${word}`,
  imported: (word) => `imports a source file of this ${word} without its tag`,
  passed: (word) => `opened this ${word} while running, without its tag`,
  called: (word) => `sent this ${word} while running, without its tag`,
};

function testHead(m: any, word: string, passedIn?: string) {
  const { title } = m.target.part.key;
  const { file, line, status, relation, source, detail } = m.where;
  const at = file ? ` at ${line ? `${file}:${line}` : file}` : '';
  return `  - test "${within(title, '    ')}"${at} — ${status}, ${RELATION_TEXT[relation](word)}, from ${source}${passedIn ? `, passed in ${passedIn}` : ''}${detail ? ` — ${within(detail, '    ')}` : ''}`;
}

function placeText(p: any) {
  const at = `${p.from === 'route' ? 'route' : `link from ${p.from}`} at ${p.file}:${p.line}`;
  if (p.inherited) return `${at}, inherited from the screen it starts on`;
  return `${at} (\`${within(p.guard, '    ')}\`${p.via ? ` in ${p.via}` : ''}${p.roleGuardsKey ? ', roles from `roleGuards`' : ''})`;
}

function conditionHead(m: any) {
  const { places } = m.where;
  return `  - condition \`${m.target.part.key}\`${places.length ? ` — ${places.map(placeText).join('; ')}` : ''}`;
}

function linkHead(m: any) {
  const { from, conditions, guards } = m.target.part.key;
  const read = conditions ? `reading ${conditions.map((c: string) => `\`${c}\``).join(', ')}` : guards.length ? `with guards duru could not read: ${guards.map((g: string) => `\`${within(g, '    ')}\``).join(', ')}` : 'with no condition';
  return `  - link from ${from} ${read}, at ${m.where.places.map((p: any) => `${p.file}:${p.line}`).join(', ')}`;
}

type PartSection = [string, string, (m: any, word: string, passedIn?: string) => string];

const PART_SECTIONS: PartSection[] = [
  ['test', 'comments on tests', testHead],
  ['condition', 'comments on opening conditions', conditionHead],
  ['link', 'comments on incoming links', linkHead],
];

export const atTableItem = ({ tableItem: t }: { tableItem?: TableItem }) => (t ? `, table item ${t.key} at ${t.file}:${t.line}` : '');

const screenAt = (s: any) => (s.onMap === false ? `${s.id}, not on the map` : `${s.id}, component ${s.componentFile ?? 'file not found'}, route at ${s.routeFile}:${s.line}${atTableItem(s)}`);

function stepHead(m: any) {
  return `  - step ${m.target.part.key.step}: ${within(screenAt(m.where.screen), '    ')}`;
}

function hopHead(m: any) {
  const { step } = m.target.part.key;
  const { from, to } = m.where;
  return `  - step ${step} → ${step + 1}: from ${within(screenAt(from), '    ')} to ${within(screenAt(to), '    ')} — ${linkText(m.where)}`;
}

const STORY_PART_SECTIONS: PartSection[] = [
  ['step', 'comments on steps', stepHead],
  ['hop', 'comments on links between steps', hopHead],
];

function partLines(entries: any[], word: string, sections = PART_SECTIONS, passedIn = new Map<unknown, string>()) {
  return sections.flatMap(([kind, title, head]) => {
    const own = entries.filter((m) => m.target.part.kind === kind);
    if (!own.length) return [];
    return [`- ${title}:`, ...own.flatMap((m) => {
      const comments = [...m.history].reverse().filter((r: any) => r.replyTo === undefined);
      return [head(m, word, passedIn.get(m)), ...comments.flatMap((c: any) => [markLine(c, undefined, '    '), ...repliesTo(m, c).map((reply: any) => markLine(reply, undefined, '      '))])];
    })];
  });
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

const kindOf = (c: { kind: string; tag: string }, caseKinds: Record<string, CaseKind>) => (c.kind === 'case' ? caseKinds[c.tag.slice('case:'.length)] : null);
const caseTags = (c: { kind: string; tag: string }, caseKinds: Record<string, CaseKind>) => {
  const kind = kindOf(c, caseKinds);
  return kind ? kindTags(c.tag.slice('case:'.length), kind) : [c.tag];
};

function caseLines(nodeTag: string, cases: any[], tests: TestRow[] | undefined, caseKinds: Record<string, CaseKind>) {
  if (!cases.length) return [];
  const tags = new Set(cases.flatMap((c) => caseTags(c, caseKinds)));
  const tagLine = (tag: string, text: string, indent: string) => `${indent}- \`@${tag}\`${text && ` ${text}`} — ${testSummary(withCase(tests, tag))}`;
  return [
    `- cases (a test of one carries its tag with \`@${nodeTag}\`):`,
    ...cases.flatMap((c) => {
      const kind = kindOf(c, caseKinds);
      if (!kind) return [tagLine(c.tag, CASE_TEXT[c.kind](c), '  ')];
      if (!kind.values.length) return [tagLine(c.tag, kind.text, '  ')];
      return [`  - ${kind.text}, a case for each value:`, ...caseTags(c, caseKinds).map((tag) => tagLine(tag, '', '    '))];
    }),
    `  - in no case — ${testSummary((tests ?? []).filter((t) => !t.cases?.some((tag) => tags.has(tag))))}`,
  ];
}

const untestedCases = (nodeTag: string, cases: any[], tests: TestRow[] | undefined, caseKinds: Record<string, CaseKind>) => cases.flatMap((c) => caseTags(c, caseKinds)).filter((tag) => !withCase(tests, tag).length).map((tag) => [nodeTag, tag]);

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

export function linkText(link: any) {
  if (link.verdict === 'broken') return 'no link';
  if (link.verdict === 'off-map') return 'not judged, a screen is not on the map';
  if (link.verdict === 'configured') return `a move in the config (${link.reasons.join(', ')})`;
  if (link.verdict === 'unknown') return `not judged, links to a path duru cannot read: ${unreadText(link.unknownLinks)}`;
  return `${link.verdict} at ${link.ways.map(place).join(', ')}`;
}

const writtenLines = (label: string, lines: string[] | undefined, indent: string) => (lines ?? []).map((text) => `${indent}- ${label}${within(text, `${indent}  `)}`);
const writtenList = (head: string, lines: string[] | undefined) => (lines?.length ? [head, ...writtenLines('', lines, '  ')] : []);
const boxText = (box: any) => BOX_WORDS.filter((k) => box[k] !== undefined).map((k) => `${k} ${JSON.stringify(box[k])}`).join(' and ') + (box.nth ? `, number ${box.nth}` : '');
const codeSpan = (code: string) => {
  const fence = '`'.repeat(Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return `${fence}${code}${fence}`;
};
const inputLines = (inputs: any[] | undefined, indent: string, brief?: StoryBrief) => (inputs ?? []).flatMap((x) => [
  `${indent}- input: ${boxText(x.box)} → ${JSON.stringify(x.value)} (not checked against the code)`,
  ...(brief ? [`${indent}  - fill: ${codeSpan(fillCode(x))} (duru did not try it on the screen)`] : []),
]);

function needText(need: any, needs: any) {
  if (typeof need === 'string') return need;
  const found = findNeed(needs, need.use);
  if (!found) return `${needPath(need.use)} — the file is missing`;
  if ('unread' in found) return `${needPath(need.use)} — the file could not be read; \`duru rebuild\` prints why`;
  return `${found.need.name} (${needPath(need.use)}): ${found.need.text}`;
}

const needTexts = (list: any[] | undefined, needs: any) => list?.map((n) => needText(n, needs));

export interface Conditions {
  accounts: Record<string, AppAccount>;
  settings: SettingsFileValues | null;
  defaults: MapDefaults;
  judged: (need: SettingNeed) => string;
}

export interface StoryBrief {
  screensById: Map<string, any>;
  appUrl: string | null;
  base: string;
  conditions: Conditions;
}

const ROUTE_END = '(?:\\/(?=$))?$';

function arrivalLine(screen: any, base: string) {
  if (!readableRoute(screen.path)) return `not written, the route path was not read at ${screen.routeFile}:${screen.line}`;
  const { source, flags } = routePattern(screen.path);
  const body = source.slice(1, -ROUTE_END.length).replace(/\[\^([^\]]*)\]\+\?/g, '[^$1?#]+?');
  return `\`await expect(page).toHaveURL(/^[a-z]+:\\/\\/[^\\/]+${base}${body}\\/?(?:[?#].*)?$/${flags});\``;
}

function appBase(appUrl: string | null) {
  const rest = appUrl?.match(/^https?:\/\/[^/?#]+(.*)$/i)?.[1];
  return rest ? escapeText(rest.replace(/\/+$/, '')) : '';
}

function briefLines(step: any, first: boolean, brief: StoryBrief, indent: string) {
  const screen = brief.screensById.get(step.screen);
  if (!screen) return [`${indent}- arrives: none, the screen is not on the map`];
  const open = first ? [`${indent}- open: ${(brief.appUrl ?? '').replace(/\/+$/, '')}${screen.path}`] : [];
  return [...open, `${indent}- arrives: ${arrivalLine(screen, brief.base)}`];
}

function stepLines(story: any, tests: any, needs: any, brief?: StoryBrief) {
  return story.steps.flatMap((step: any, i: number) => {
    const no = `${i + 1}. `;
    const indent = ' '.repeat(2 + no.length);
    const line = `  ${no}${within(step.screen, indent)} — ${step.onMap ? testSummary(testsAt(tests.nodes, step.screen)) : 'not on the map'}`;
    const fields = story.stepFields?.[i] ?? {};
    const written = [...writtenLines(`link need from step ${i}: `, needTexts(fields.linkNeeds, needs), indent), ...writtenLines('need: ', needTexts(fields.needs, needs), indent), ...inputLines(fields.inputs, indent, brief), ...writtenLines('expect: ', fields.expects, indent)];
    const link = story.links[i];
    const pressed = brief && link && !['broken', 'off-map', 'configured'].includes(link.verdict) ? [`${indent}  - what to press: duru does not know`] : [];
    return [line, ...(brief ? briefLines(step, i === 0, brief, indent) : []), ...written, ...(link ? [`${indent}- to ${within(link.to, `${indent}  `)}: ${linkText(link)}`, ...pressed] : [])];
  });
}

const isWritten = (fields: any) => Boolean(fields?.needs?.length || fields?.linkNeeds?.length || fields?.expects?.length);
const hasInputs = (story: any) => Boolean(story.stepFields?.some((f: any) => f.inputs?.length));
const hasWritten = (story: any) => isWritten(story) || Boolean(story.stepFields?.some(isWritten));
const picksNeedFile = (story: any) => [...(story.needs ?? []), ...(story.stepFields ?? []).flatMap((f: any) => [...(f.needs ?? []), ...(f.linkNeeds ?? [])])].some((n) => typeof n !== 'string');

function reachProblems(story: any) {
  const broken = story.links.filter((l: any) => l.verdict === 'broken').length;
  return [
    broken && `unreachable, no link at ${count(broken, 'step')}`,
    story.detached && 'not judged, a screen is not on the map',
    story.unjudged && 'not judged, a link to a path duru cannot read',
  ].filter(Boolean);
}

const SETTING_REASON: Record<string, string> = {
  call: 'it calls a function, so duru cannot tell which value meets it',
  'not-equal': 'it checks that a value is not equal to another, so no one value meets it',
  or: 'its parts are joined by "or", so no one value meets it',
  'non-literal': 'it compares with something that is not a fixed value',
  order: 'it compares sizes, so no one value meets it',
  negated: 'it is a negated condition, so no one value meets it',
  other: 'duru does not read a condition of this shape',
  conflict: 'another condition in the same file has the same text and reads a different setting',
  'not-found': 'duru did not find where it reads a setting',
};

const hasAccounts = (c: Conditions) => Object.keys(c.accounts).length > 0;

function accountsText(roles: string[], accounts: Record<string, AppAccount>) {
  return roles.map((r) => (Object.hasOwn(accounts, r) ? `${r} ${accounts[r].id}, password in ${accounts[r].passwordEnv}` : `${r} no account in app.roles`)).join('; ');
}

const needName = (n: SettingNeed) => `${n.path.join('.')} ${n.need === 'equals' ? `= ${JSON.stringify(n.value)}` : n.need === 'includes' ? `includes ${JSON.stringify(n.value)}` : n.need}`;

function settingLine(n: SettingNeed, c: Conditions) {
  const change = settingChange(n, c.settings, c.defaults);
  const { set } = change;
  const toSet = !set ? 'duru does not know which value to put' : set.item !== undefined ? `put ${JSON.stringify(set.item)} in the list` : `set it to ${JSON.stringify(set.value)}`;
  const now = ['on', 'off', 'equals'].includes(n.need) && change.unchanged !== undefined ? ` (${JSON.stringify(change.unchanged)})` : '';
  const verdict = change.met ? 'met with no change' : change.met === false ? `not met with no change${now}; ${toSet}` : `not known, its default was not read in full; ${toSet}`;
  return `setting ${needName(n)}: ${verdict} (${c.judged(n)})`;
}

function conditionLines(g: Described, c: Conditions, indent: string, shownRoles: string[] = []) {
  const lines: string[] = [];
  if (g.kinds.includes('role')) {
    if (!g.roles) lines.push('role not read: duru does not know which accounts pass it');
    else if (!hasAccounts(c)) lines.push(`role ${g.roles.join(' or ')}`);
    else if (g.roles.every((r) => shownRoles.includes(r))) lines.push(`role ${g.roles.join(' or ')}: the accounts are on the first screen line`);
    else lines.push(`role ${g.roles.join(' or ')}: ${accountsText(g.roles, c.accounts)}`);
  }
  if (g.kinds.includes('setting')) {
    if (g.settings) lines.push(...g.settings.map((n) => settingLine(n, c)));
    else lines.push(`setting not read: ${SETTING_REASON[g.settingsReason!] ?? g.settingsReason}`);
  }
  return lines.map((l) => `${indent}- ${l}`);
}

const guardsOf = (r: any): Described[] => (r.kind === 'route' ? r.guards : r.kind === 'start' ? [] : r.ways.flatMap((w: any) => w.conditions));

function noAccountsLine(story: any, c?: Conditions) {
  const roles = story.reach.some((r: any) => r.roleValues?.length || guardsOf(r).some((g) => g.kinds.includes('role') && g.roles));
  return c && roles && !hasAccounts(c) ? ['  - accounts: no app.roles in the config'] : [];
}

function preconditionLines(r: any, { screensById, restricted }: MapInfo, c?: Conditions, start?: any) {
  const under = (guards: Described[], indent: string, shownRoles?: string[]) => (c ? guards.flatMap((g) => conditionLines(g, c, indent, shownRoles)) : []);
  if (r.kind === 'start') {
    const roles = r.roleValues ? `; roles that open it: ${r.roleValues.join(', ')}` : r.roleValues === null ? '; the roles that open it could not be read' : '';
    const accounts = c && r.roleValues && hasAccounts(c) ? [`    - accounts: ${accountsText(r.roleValues, c.accounts)}`] : [];
    return [`  - ${r.screen}, the first screen, ${needsText(r.kinds)}${roles}`, ...accounts, ...linkInLines(screensById.get(r.screen).access.links, restricted).map((l) => `  ${l}`)];
  }
  if (r.kind === 'route') {
    const shownRoles = start?.screen === r.screen ? start.roleValues ?? [] : [];
    return [`  - ${r.screen} route at ${r.file}:${r.line}, guard ${r.guards.map(guardText).join('; ')}`, ...under(r.guards, '    ', shownRoles)];
  }
  const way = (w: any) => `${place(w)}, guard ${w.conditions.map(guardText).join('; ')}`;
  const head = `  - link ${r.from} → ${r.to}`;
  return [
    ...(r.ways.length === 1
      ? [`${head} at ${way(r.ways[0])}`, ...under(r.ways[0].conditions, '    ')]
      : [`${head}, one of ${r.ways.length}:`, ...r.ways.flatMap((w: any) => [`    - at ${way(w)}`, ...under(w.conditions, '      ')])]),
    ...(r.unknownLinks ? [`    - judged without links to a path duru cannot read: ${unreadText(r.unknownLinks)}`] : []),
  ];
}

export function storyLines(story: any, marks: any[] | null, parts: any[], tests: any, needs: any, mapInfo: MapInfo, formats: string[], brief?: StoryBrief) {
  const problems = reachProblems(story);
  return [
    '',
    `## ${story.id}`,
    '',
    `- name: ${within(story.name, '  ')}`,
    ...(marks ? ['- marks:', ...marks.flatMap((m) => entryLines(m)), ...partLines(parts, 'story', STORY_PART_SECTIONS)] : []),
    `- story file: ${story.file} (${within(story.author, '  ')}, ${story.date.slice(0, 10)})`,
    ...(story.memo ? [`- memo: ${within(story.memo, '  ')}`] : []),
    `- status: ${STORY_STATUS[story.status]}`,
    ...testLines(testsAt(tests.stories, story.id), 'story tests'),
    ...writtenList('- needs:', needTexts(story.needs, needs)),
    '- screens:',
    ...stepLines(story, tests, needs, brief),
    ...writtenList('- expects at the end:', story.expects),
    `- reach: ${problems.length ? problems.join('; ') : 'reachable'}`,
    ...(story.reach.length
      ? ['- preconditions:', ...noAccountsLine(story, brief?.conditions), ...story.reach.flatMap((r: any) => preconditionLines(r, mapInfo, brief?.conditions, story.reach.find((x: any) => x.kind === 'start')))]
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

const CODE_CHANGED_INTRO = 'duru keeps a hash of the code of the screen or call with each mark, and of that code and the test file with each judgment of a test pair. The code changed after each of these was left, and the review page shows them as 「코드 바뀜」. They stay as they were: tell the user which ones they are, since the user decides whether to look at them again, and do not mark or judge them yourself.';
const JUDGED: Record<string, string> = { discard: 'discarded', 'hand-over': 'handed over for tagging' };

function codeChangedLines(attached: MarkEntry[], tests: { discarded: Record<string, any[]>; awaitingTag: Record<string, any[]> }) {
  const marks = attached.filter((m) => m.codeChanged);
  const pairs = [tests.discarded, tests.awaitingTag].flatMap((byNode) => Object.entries(byNode).flatMap(([node, list]) => list.filter((t) => t.codeChanged).map((t) => ({ node, t }))));
  if (!marks.length && !pairs.length) return [];
  pairs.sort((a, b) => compare(a.node, b.node) || compare(a.t.ref.file, b.t.ref.file) || compare(a.t.ref.title, b.t.ref.title));
  const note = (text: string) => quotedNote(text, '  ');
  return [
    '',
    '# Code changed after a mark or a judgment',
    '',
    CODE_CHANGED_INTRO,
    '',
    ...marks.map(({ target, current }) => `- ${targetText(target)} — marked \`${current!.status}\`${note(current!.note) ? ` ${note(current!.note)}` : ''} ${byline(current!.author, current!.date, '  ')}`),
    ...pairs.map(({ node, t }) => `- ${node} — test "${within(t.ref.title, '  ')}" in ${t.ref.file ?? t.ref.source} ${JUDGED[t.judgment.kind]}${note(t.judgment.reason) ? ` ${note(t.judgment.reason)}` : ''} ${byline(t.judgment.author, t.judgment.date, '  ')}`),
  ];
}

const CASE_KINDS_INTRO = 'Each kind of case in the config\'s `caseKinds` follows. A screen or call is a candidate of a kind when the kind has no rules, or when its rules pick that side, screens or calls. A candidate is `undecided` while no rule picks it and no mark says whether the kind needs testing there; a `not-needed` mark without a note counts as undecided. Read the source of each undecided candidate, write requests first as they are listed, and decide it: run `duru case <config> <kind> <ID> needed` when that kind of case can happen there and should be tested, or `duru case <config> <kind> <ID> not-needed --note "<why>"` when it cannot or need not; then run `duru undecided <config>` again. An undecided candidate that ends with `so only a person can decide it` carries a mark a person left, which `duru case` does not change. When you cannot tell from the code, leave the candidate undecided. Stop running `duru undecided` again once it exits with 0 or every candidate it still lists is one only a person can decide or one you could not tell from the code, tell the user which are left, and go on with `cases with no tests`.';
const NO_TESTS_INTRO = ' Under `cases with no tests`, each screen or call a rule, a reviewer or an agent picked the kind for and whose case of that kind no test carries yet follows under its own heading, with who picked it, the tags a test of it carries and an empty test for each; one already listed above under its marks is not repeated. Write those tests as for a mark above, then run `duru rebuild` and read this list again.';
const NEW_ONLY_INTRO = ' When the user said to leave the older undecided candidates of a kind for later, run `duru undecided <config> <kind> --new` for that kind instead: it lists only the undecided candidates that the map named by `baselineMap` does not have, and exits with 0 once none of them is left, even while older ones are. Do not use `--new` for a kind added to `caseKinds` after that map was built: its candidates on that map count as older, so `--new` ends at once.';
const UNDER_REVIEW_INTRO = ' Under `under review`, each candidate carries a `not-needed` an agent wrote with `duru case`, which waits for a reviewer to accept or revert it on the review page; until then the candidate counts as it did before, a target of a rule stays a target, and it is not undecided. Do not write it again.';

const nodeText = (node: any, isCall: boolean) => (isCall
  ? `call, sent from ${node.screens.length ? node.screens.join(', ') : 'no screen'}`
  : `screen, component ${node.componentFile ?? 'file not found'}, route at ${node.routeFile}:${node.line}`);

function pickedByText(kind: string, target: CaseTarget) {
  if (target.state === 'rule') return `a rule, ${target.rules.map((i) => `\`caseKinds.${kind}.picks[${i}]\``).join(', ')}`;
  const { mark } = target;
  const note = quotedNote(mark!.note, '  ');
  return `${within(mark!.author, '  ')}, ${mark!.date.slice(0, 10)}${note ? ` — ${note}` : ''}`;
}

function nodesById(map: any) {
  const calls = new Set<string>(map.calls.map((c: any) => c.id));
  const byId = new Map<string, any>([...map.screens, ...map.calls].map((n: any) => [n.id, n]));
  return (id: string) => ({ node: byId.get(id), isCall: calls.has(id) });
}

function undecidedText(map: any, attached: MarkEntry[], kind: string) {
  const nodeOf = nodesById(map);
  const byPerson = new Map(attached.filter((e) => e.target.case === kind && e.current && e.current.via === undefined).map((e) => [e.target.node!, e]));
  return (id: string) => {
    const { node, isCall } = nodeOf(id);
    const entry = byPerson.get(id);
    const mark = entry?.current;
    const what = mark?.of !== undefined && !acceptsProposal(mark, entry!.history) ? 'took back the agent\'s not-needed' : mark?.rule ? 'took it out of a rule that no longer picks it' : 'marked it not-needed without a note';
    return `${id} — ${nodeText(node, isCall)}${mark ? ` — ${within(mark.author, '    ')} ${what} on ${mark.date.slice(0, 10)}, so only a person can decide it` : ''}`;
  };
}

const underReview = (n: number) => (n ? `, ${n} under review` : '');

function reviewText(map: any, targets: KindTargets) {
  const nodeOf = nodesById(map);
  return (id: string) => {
    const { node, isCall } = nodeOf(id);
    const { author, date, note } = targets.nodes[id].review!;
    return `${id} — ${nodeText(node, isCall)} — ${within(author, '    ')}, ${date.slice(0, 10)} — ${quotedNote(note, '    ') ?? 'no note'}`;
  };
}

export function undecidedLines(map: any, caseKinds: Record<string, CaseKind>, targets: Record<string, KindTargets>, attached: MarkEntry[], since: { file: string; changes: BaselineChanges } | null = null) {
  const lines = Object.keys(caseKinds).flatMap((kind) => {
    const text = undecidedText(map, attached, kind);
    const { undecided, review } = targets[kind];
    if (!since) return [`case kind ${kind}: ${undecided.length} undecided${underReview(review.length)}`, ...undecided.map((id) => `  ${text(id)}`)];
    const fresh = newUndecided(since.changes, undecided);
    return [`case kind ${kind}: ${fresh.length} new undecided since ${since.file} (${undecided.length} undecided in all)`, ...fresh.map((id) => `  ${text(id)}`)];
  });
  const waiting = Object.keys(caseKinds).reduce((n, kind) => n + targets[kind].review.length, 0);
  return waiting ? [...lines, `${waiting} under review: not-needed marks of the agent that wait for a reviewer to accept or revert them on the review page`] : lines;
}

function caseKindLines(map: any, caseKinds: Record<string, CaseKind>, targets: Record<string, KindTargets>, attached: MarkEntry[], tests: Record<string, TestRow[]>, listed: Set<string>, formats: string[], hasBaseline: boolean) {
  const nodeOf = nodesById(map);
  const lines = ['', '# Case kinds', '', CASE_KINDS_INTRO + (hasBaseline ? NEW_ONLY_INTRO : '') + NO_TESTS_INTRO];
  let undecided = 0;
  let untested = 0;
  let review = 0;
  for (const [kind, caseKind] of Object.entries(caseKinds)) {
    const own = targets[kind];
    const all = casesWithoutTests(kind, caseKind, own, tests);
    const cells = all.filter((c) => !listed.has(c.node));
    const cellCount = all.reduce((n, c) => n + c.tags.length, 0);
    const above = cellCount - cells.reduce((n, c) => n + c.tags.length, 0);
    const text = undecidedText(map, attached, kind);
    const waiting = reviewText(map, own);
    undecided += own.undecided.length;
    untested += cellCount;
    review += own.review.length;
    lines.push(
      '',
      `## ${kind}`,
      '',
      `- description: ${caseKind.text}`,
      ...(caseKind.values.length ? [`- values: ${caseKind.values.join(', ')}`] : []),
      ...(caseKind.picks.length ? ['- rules:', ...caseKind.picks.map((p, i) => `  - \`picks[${i}]\` ${JSON.stringify(p)}`)] : ['- rules: none, so every screen and call is a candidate']),
      `- undecided: ${own.undecided.length || 'none'}`,
      ...own.undecided.map((id) => `  - ${text(id)}`),
      ...(own.review.length ? [`- under review: ${own.review.length}`, ...own.review.map((id) => `  - ${waiting(id)}`)] : []),
      `- cases with no tests: ${cellCount || 'none'}${above ? `, ${above} of them under screens and calls listed above` : ''}`,
    );
    for (const c of cells) {
      const { node, isCall } = nodeOf(c.node);
      lines.push(
        '',
        `### ${c.node}`,
        '',
        `- ${nodeText(node, isCall)}`,
        `- picked by: ${pickedByText(kind, c.target)}`,
        `- no tests: ${c.tags.map((tag) => `\`@${tag}\``).join(', ')}`,
        ...emptyTestLines(formats, c.tags.map((tag) => [`${isCall ? 'call' : 'screen'}:${c.node}`, tag])),
      );
    }
  }
  if (review) lines[3] += UNDER_REVIEW_INTRO;
  return { lines, undecided, untested, review };
}

export function taskList(config: any) {
  const { map, tests, marks, appLinks, stories, needs, caseTargets } = reviewData(config, null);
  const open = marks.attached.filter((m) => m.current?.status === 'needs-more');
  let comparison: TestComparison | null = null;
  try {
    if (config.baselineTests) comparison = compareTests(readBaselineTests(config), tests, nodeIds(map));
  } catch {}
  const passedIn = new Map<MarkEntry, string>();
  const fines = wholeFines(marks.attached.flatMap((m) => m.history));
  for (const m of marks.attached) {
    const folder = comparison && m.history.filter((r) => r.replyTo === undefined).map((r) => passedInFolder(comparison, fines, m.target, r.date)).find(Boolean);
    if (folder) passedIn.set(m, folder);
  }
  const regressed = new Set([...passedIn.keys()].map((m) => m.target.node));
  const marked = (node: any) => open.some((m) => m.target.node === node.id);
  const listed = (node: any) => marked(node) || regressed.has(node.id);
  const screens = map.screens.filter(listed).sort((a: any, b: any) => a.id.localeCompare(b.id));
  const calls = map.calls.filter(listed);
  const storyMarks = open.filter((m) => m.target.story !== undefined);
  const restricted = new Set<string>(map.screens.filter((s: any) => s.access.restricted).map((s: any) => s.id));
  const relative = (p: string) => path.relative(config.configDir, p).split(path.sep).join('/');
  const formats = [...new Set<string>(config.tests.map((t: any) => t.format))];
  const resultLines = resultOptionLines(map, tests.nodes);
  const hasKinds = Object.keys(config.caseKinds).length > 0;
  const hasValues = Object.values<CaseKind>(config.caseKinds).some((k) => k.values.length > 0);
  const hasPicks = Object.values<CaseKind>(config.caseKinds).some((k) => k.picks.length > 0);
  const partsOf = (id: string) => marks.attached.filter((m) => m.target.part && m.target.node === id);
  const storyPartsOf = (id: string) => marks.attached.filter((m) => m.target.part && m.target.story === id && m.where);
  const caseKinds = hasKinds ? caseKindLines(map, config.caseKinds, caseTargets, marks.attached, tests.nodes, new Set([...screens, ...calls].filter(marked).map((n: any) => n.id)), formats, config.baselineMap !== null) : null;
  const caseWork = caseKinds && caseKinds.undecided + caseKinds.untested + caseKinds.review > 0 ? caseKinds : null;

  const out = [
    `# Test tasks — ${count(screens.length, 'screen')}, ${count(calls.length, 'call')}, ${count(storyMarks.length, 'story', 'stories')}, ${count(open.length, 'open mark')}${passedIn.size ? `, ${count(passedIn.size, 'commented regression')}` : ''}${caseWork ? `, ${count(caseWork.undecided, 'undecided case candidate')}${underReview(caseWork.review)}, ${count(caseWork.untested, 'case')} with no tests` : ''}`,
    '',
    `A reviewer marked these screens, API calls and stories as needing tests (\`needs-more\`). Write the tests, put \`@screen:<screen ID>\` on each test, in its \`tag\` option for Playwright and in its title for the other formats (\`@call:<call ID>\` for a test of one API call, with \`@option:<key>=true|false\` for each on/off option the test sets, and ${hasKinds ? 'the tag of each case under `cases` it checks: a role or setting case of a screen that opens only under one, or a kind of case ' + (hasPicks ? 'a reviewer or a rule in the config' : 'a reviewer') + ' picked for the screen or call, tagged `@case:<kind>`' + (hasValues ? ', or `@case:<kind>=<value>` for a value of a kind with values' : '') : 'for a screen that opens only under a role or a setting the tag of each case under `cases` it checks'}), add \`@depth:<${DEPTHS.join('|')}>\` when the depth of the result source does not fit, then run \`duru rebuild\` and read this list again. For a story, write a test that goes through its screens in order and put \`@story:<story ID>\` on it as well. Under \`empty tests\`, a screen or call gets one set for each open mark${hasKinds ? ' and one more for each case with no tests' : ', a screen one more for each case with no tests'}, and a story one set: an empty test for each test format in the config, with the tags already in place and held back from passing (\`test.fixme\`, \`test.todo\`, \`@Disabled\` with \`import org.junit.jupiter.api.Disabled;\`, or no verdict word). Copy the one for your runner, keep the tags, put what the test checks in place of \`<what it checks>\` (the Playwright ones of an item all carry that title), remove what holds it back and fill in the data setup and the checks. A screen, call or story stays here until a reviewer marks it \`fine\`.`,
    '',
    `Source files are under \`${relative(config.srcRoot)}\`.`,
  ];
  if (passedIn.size) {
    const regression = `A test under \`comments on tests\` that ends with \`, passed in ${comparison!.folder}\` passed in that earlier release and fails or is pending now, and a reviewer commented on it after that release's run. Do not write a new test for it: fix the code or the test as the comment says, then run the tests and \`duru rebuild\`, and read this list again. A screen or API call whose marks line reads \`none, listed for comments on regressed tests\` is here only for such comments, and leaves this list once those tests pass again or a reviewer marks the whole screen or call \`fine\`.`;
    out[2] = open.length ? `${out[2]} ${regression}` : regression;
  }
  if (open.some((m) => laterComments(m).length)) out[2] += ' A `comment` line under a mark is a comment a reviewer left on the same target after that mark.';
  if (open.some((m) => laterComments(m).some((c: any) => repliesTo(m, c).length))) out[2] += ' A `reply` line under a comment is an answer to that comment.';
  const partKinds = new Set([...screens, ...calls].flatMap((n) => partsOf(n.id).map((m) => m.target.part!.kind)));
  if (partKinds.has('test')) {
    out[2] += ' Under `comments on tests`, each test a reviewer left a comment on is named with its file and line, its status, how it is linked to the screen or call and the result file it was read from; read the result file for why it failed.';
  }
  if (storyMarks.some((m) => storyPartsOf(m.target.story!).length)) {
    out[2] += ' Under `comments on steps` and `comments on links between steps`, each step of a story and each link between two of its steps a reviewer left a comment on is named with the screen\'s component file and route line, and a link also with its verdict and where it is written; add what the comment asks to the story test, and if the verdict is wrong, tell the user it is a duru defect.';
  }
  if (stories.list.some((s) => storyMarks.some((m) => m.target.story === s.id) && hasWritten(s))) {
    out[2] += ' A person wrote the `needs` and `expects at the end` lines of a story and the `link need from step N`, `need` and `expect` lines under a step: what has to hold before the story or the step starts, what has to hold on the link from step N, the step before, for the story to take it into this step, what should be seen at that step, and what should hold once the last step is done. duru only carries them and does not check them against the code; set up each need and each link need from a step in the story test and check each expect there.';
  }
  if (stories.list.some((s) => storyMarks.some((m) => m.target.story === s.id) && hasInputs(s))) {
    out[2] += ' An `input` line under a step names a box to fill at that step by the words on the screen it is found by, `placeholder`, `label` or `testId`, several joined by `and` for a box that has all of them, with `number N` when it is the Nth of the elements that have them all, and the value to put in it as a JSON string. duru did not look for the box in the code; if the test cannot find it by all the words, try each word alone, and if it still cannot, suspect the story first and tell the user which input it is.';
  }
  if (stories.list.some((s) => storyMarks.some((m) => m.target.story === s.id) && picksNeedFile(s))) {
    out[2] += ' A need written `<name> (needs/<file>): <text>` is one a person keeps as a file in the `needs` folder of the story folder and picks for several stories: set it up from its text the same way in every story test that has it, and on a `link need from step N` line set it up before step N so the test can take that link. A need that says the file is missing or could not be read points at a need file duru did not find or could not read; tell the user and do not guess what it holds.';
  }
  if (partKinds.has('condition') || partKinds.has('link')) {
    out[2] += ' Under `comments on opening conditions` and `comments on incoming links`, each role or setting condition and each link into the screen a reviewer left a comment on is named with the source file and line it is written at; if the app does not do what duru read there, tell the user it is a duru defect, and otherwise answer with that line.';
  }
  if (marks.attached.some((m) => [...m.history].some((r: any) => r.targets?.length > 1))) {
    out[2] += ' A comment left on several targets shows under each of them, with the list of all of them; answer it once.';
  }
  const general = marks.attached.find((m) => m.key === GENERAL);
  if (general) {
    out[2] += ' Under `# Comments with no target`, a reviewer asked something without pointing at a screen, call or story; answer it from the whole review.';
    const comments = [...general.history].reverse().filter((r: any) => r.replyTo === undefined);
    out.push('', '# Comments with no target', '', ...comments.flatMap((c: any) => [markLine(c, undefined, ''), ...repliesTo(general, c).map((reply: any) => markLine(reply, undefined, '  '))]));
  }
  if (map.serverNotCompared) out.push('', `${SERVER_NOT_COMPARED}, so no call below is written as missing on the server.`);
  const caseLeft = caseWork && (caseWork.undecided + caseWork.untested ? 'No open marks, but the case kinds below still have undecided candidates or cases with no tests.' : 'No open marks, but the case kinds below still have candidates under review.');
  if (!open.length && !passedIn.size) out.push('', caseLeft || 'No open marks.');
  for (const s of screens) {
    const marks = open.filter((m) => m.target.node === s.id);
    out.push(
      '',
      `## ${s.id}`,
      '',
      marks.length ? '- marks:' : REGRESSION_ONLY,
      ...marks.flatMap((m) => entryLines(m, cellText(m.target, 'whole screen'))),
      ...partLines(partsOf(s.id), 'screen', PART_SECTIONS, passedIn),
      `- component: ${s.componentFile}, route at ${s.routeFile}:${s.line}${atTableItem(s)}`,
      ...(appLinks[s.id] ? [`- app: ${appLinks[s.id]}`] : []),
      ...accessLines(s.access, restricted),
      ...caseLines(`screen:${s.id}`, s.cases, tests.nodes[s.id], config.caseKinds),
      ...callLines(s, tests.nodes, resultLines),
      ...testLines(tests.nodes[s.id]),
      ...(marks.length ? emptyTestLines(formats, [...marks.map((m) => cellTags('screen', m.target as Cell)), ...untestedCases(`screen:${s.id}`, s.cases, tests.nodes[s.id], config.caseKinds)]) : []),
    );
  }
  if (calls.length) out.push('', '# API calls');
  for (const c of calls) {
    const marks = open.filter((m) => m.target.node === c.id);
    out.push(
      '',
      `## ${c.id}`,
      '',
      marks.length ? '- marks:' : REGRESSION_ONLY,
      ...marks.flatMap((m) => entryLines(m, cellText(m.target, 'whole call'))),
      ...partLines(partsOf(c.id), 'call', PART_SECTIONS, passedIn),
      `- called from: ${c.screens.length ? c.screens.join(', ') : 'no screen'}`,
      `- server: ${serverText(c.server)}`,
      ...resultLines(c.id, ''),
      ...caseLines(`call:${c.id}`, c.cases, tests.nodes[c.id], config.caseKinds),
      ...markedOptionLines(c, marks, tests.nodes[c.id]),
      ...testLines(tests.nodes[c.id]),
      ...(marks.length ? emptyTestLines(formats, [...marks.map((m) => cellTags('call', m.target as Cell)), ...untestedCases(`call:${c.id}`, c.cases, tests.nodes[c.id], config.caseKinds)]) : []),
    );
  }
  if (storyMarks.length) out.push('', '# Stories', '', `Story files are in \`${relative(config.storiesDir)}\`.`);
  if (storyMarks.length && stories.stale) {
    out.push('', 'The map was built by a duru older than stories, so these stories are not checked against it. Run `duru rebuild` and read this list again.');
    for (const m of storyMarks) out.push('', `## ${m.target.story}`, '', '- marks:', ...entryLines(m));
  }
  const mapInfo = { screensById: new Map<string, any>(map.screens.map((s: any) => [s.id, s])), restricted };
  for (const id of [...new Set(storyMarks.map((m) => m.target.story))]) {
    const own = storyMarks.filter((m) => m.target.story === id);
    const story = stories.list.find((s) => s.id === id);
    if (story) out.push(...storyLines(story, own, storyPartsOf(id!), tests, needs, mapInfo, formats));
    else if (!stories.stale) out.push('', `## ${id}`, '', '- marks:', ...own.flatMap((m) => entryLines(m)), '- story file: could not be read; `duru rebuild` prints why');
  }
  out.push(...codeChangedLines(marks.attached, tests));
  if (caseKinds) out.push(...caseKinds.lines);
  out.push(...taggingLines(tests.awaitingTag, new Set<string>(map.calls.map((c: any) => c.id))));
  return out.join('\n') + '\n';
}

const STORY_INTRO = "Write a test that goes through the screens of this story in order, and put `@story:<story ID>` on it. The lines under each step come from the map: `open` is the address to open for the first step, with a route variable left as it is in the route path, and `arrives` is the line to check that the step's screen is open. `what to press` says duru does not know which element moves from one screen to the next, and appears only under a link that exists in the source, not under a link marked `no link` or `not judged, a screen is not on the map`, or a move written in the config's `moves`; the link's verdict and where it is written are on the `to` line. A `fill` line under an `input` line is Playwright code that finds the box with every word written for it, each matched exactly, takes the Nth of those boxes when the input has a number, and puts the value in; duru did not try it on the screen, so when it finds no box, try each word alone, and when that finds none either, tell the user which input it is. The `need`, `link need from step N`, `input` and `expect` lines, and the `needs` and `expects at the end` lists, are text a person wrote that duru did not check against the code; a need written `<name> (needs/<file>): <text>` is kept as a file and picked by several stories. The `reach` and `preconditions` lines say why a step may not open. Under a precondition, an `accounts` line and a `role` line name, for each role that passes, the account in `app.roles` and the environment variable that holds its password; duru never prints a password, and you pick the account. A `setting` line covers one setting the condition reads, not the whole condition: met with no change, or not met or not known with the value to put, and in brackets what it was judged against, the settings file in `app.settingsFile` or the source default; when deployed settings were not checked, check the setting in the app before trusting the line. A `setting not read` line says why duru could not tell the value. `story tests` are the tests already tagged with this story. Under `empty tests` are the empty tests with the `@story:` tag and the `@screen:` tag of each screen on the map already in place and held back from passing (`test.fixme`, `test.todo`, `@Disabled` with `import org.junit.jupiter.api.Disabled;`, or no verdict word): copy the one for your runner, put what the test checks in place of `<what it checks>`, remove what holds it back and fill in the data setup and the checks.";

async function storyConditions(config: any, map: MapDefaults): Promise<Conditions> {
  const accounts = config.app?.roles ?? {};
  const settingsFile = config.app?.settingsFile;
  if (!settingsFile) return { accounts, settings: null, defaults: map, judged: () => 'source default; deployed settings not checked' };
  const app = { files: config.app.files, settingsFile };
  const at = settingsFilePlace(app);
  const where = /^https?:/.test(at) ? at : path.relative(config.configDir, at).split(path.sep).join('/');
  const { file, fileError, found } = await readSettingsFile(app);
  const why = fileError !== null ? `, ${where} could not be run: ${fileError}` : !found ? `, ${where} not found` : null;
  const read = (n: SettingNeed) => n.root === settingsFile.root && n.path.length >= 2 && settingsFile.merged.includes(n.path[0]);
  return {
    accounts,
    settings: { root: settingsFile.root, merged: settingsFile.merged, file },
    defaults: map,
    judged: (n) => (!read(n) ? 'source default; deployed settings not checked' : why === null ? `checked against ${where}` : `source default; deployed settings not checked${why}`),
  };
}

export async function storyBrief(config: any, id: string): Promise<{ text: string } | { error: string }> {
  const { map, tests, stories, needs } = reviewData(config, null);
  if (stories.stale) return { error: stories.stale };
  const story = stories.list.find((s) => s.id === id);
  if (!story) {
    const unread = fs.existsSync(path.join(config.storiesDir, `${id}.json`));
    return { error: unread ? `story ${id} could not be read; \`duru rebuild\` prints why` : `no story ${id} in ${path.relative(config.configDir, config.storiesDir)}` };
  }
  const screensById = new Map<string, any>(map.screens.map((s: any) => [s.id, s]));
  const mapInfo = { screensById, restricted: new Set<string>(map.screens.filter((s: any) => s.access.restricted).map((s: any) => s.id)) };
  const formats = [...new Set<string>(config.tests.map((t: any) => t.format))];
  const relative = (p: string) => path.relative(config.configDir, p).split(path.sep).join('/');
  const out = [
    `# Story ${story.id}`,
    '',
    STORY_INTRO,
    '',
    `Source files are under \`${relative(config.srcRoot)}\`. Story files are in \`${relative(config.storiesDir)}\`.`,
    ...storyLines(story, null, [], tests, needs, mapInfo, formats, { screensById, appUrl: config.appUrl ?? null, base: appBase(config.appUrl ?? null), conditions: await storyConditions(config, map) }),
  ];
  return { text: out.join('\n') + '\n' };
}
