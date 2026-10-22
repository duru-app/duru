import { settingConditionName } from './access.ts';
import type { Described, SettingSource } from './access.ts';
import { testRef } from './judgments.ts';
import type { TableItem } from './client.ts';
import type { Part } from './marks.ts';
import { checkStories, linksFromOldDuru } from './story-paths.ts';

interface LinkedTest {
  title: string;
  file: string | null;
  line?: number | null;
  source: string;
  status: string;
  testFile?: string;
  detail?: string;
  level?: string;
}

type ByNode = Record<string, LinkedTest[]> | undefined;

interface LinkRow {
  from: string;
  file: string;
  line: number;
  guards: Described[];
}

export interface PartScreen {
  id: string;
  routeFile?: string;
  line?: number;
  componentFile?: string | null;
  tableItem?: TableItem;
  access?: { restricted?: boolean; roleValues?: string[] | null; route?: Described[]; links?: LinkRow[]; settings?: SettingSource[] };
}

export interface PartContext {
  tests: { nodes?: ByNode; importers?: ByNode; passed?: ByNode };
  screens?: PartScreen[];
  roleGuards?: Record<string, string[]>;
}

export interface TestPlace {
  file: string | null;
  line: number | null;
  source: string;
  status: string;
  relation: string;
  detail?: string;
}

export interface SourcePlace {
  from: string;
  file: string;
  line: number;
  guard?: string;
  via?: string;
  roleGuardsKey?: string;
  inherited?: true;
}

export interface SourcePlaces {
  places: SourcePlace[];
}

export type LinkKey = { from: string; conditions: string[] } | { from: string; guards: string[] };

const STATUS_RANK: Record<string, number> = { pass: 0, pending: 1, fail: 2 };

const relationOf = (list: string, t: LinkedTest) => (list === 'nodes' ? 'tagged' : list === 'importers' ? 'imported' : t.level === 'call' ? 'called' : 'passed');

function locateTest(node: string, key: unknown, { tests }: PartContext): TestPlace | null {
  const wanted = JSON.stringify(key);
  for (const list of ['nodes', 'importers', 'passed'] as const) {
    const found = (tests[list]?.[node] ?? []).filter((t) => JSON.stringify(testRef(t)) === wanted);
    if (!found.length) continue;
    const [t] = found;
    const status = found.reduce((worst, x) => (STATUS_RANK[x.status] > STATUS_RANK[worst] ? x.status : worst), t.status);
    return { file: t.testFile ?? t.file, line: t.line ?? null, source: t.source, status, relation: relationOf(list, t), ...(t.detail && { detail: t.detail }) };
  }
  return null;
}

const sortedSet = (items: string[]) => [...new Set(items)].sort();

export const guardConditions = (g: Described) => [
  ...(g.kinds.includes('role') ? (g.roles ?? []).map((r) => `role:${r}`) : []),
  ...(g.kinds.includes('setting') ? (g.settings ?? []).map(settingConditionName) : []),
];

export function linkKey({ from, guards }: { from: string; guards: Described[] }): LinkKey {
  const conditions = sortedSet(guards.flatMap(guardConditions));
  return conditions.length ? { from, conditions } : { from, guards: sortedSet(guards.map((g) => g.guard)) };
}

const shownConditions = ({ access }: PartScreen) => new Set([
  ...(access?.restricted ? (access.roleValues ?? []).map((r) => `role:${r}`) : []),
  ...(access?.settings ?? []).flatMap((s) => s.needs.map(settingConditionName)),
]);

function locateCondition(screen: PartScreen, key: unknown, screens: PartScreen[], roleGuards: Record<string, string[]>): SourcePlaces | null {
  if (typeof key !== 'string' || !shownConditions(screen).has(key)) return null;
  const access = screen.access!;
  const at = (from: string, file: string, line: number, g: Described): SourcePlace => ({
    from, file, line, guard: g.guard,
    ...(g.via && { via: g.via }),
    ...(g.kinds.includes('role') && Object.hasOwn(roleGuards, g.guard) && { roleGuardsKey: g.guard }),
  });
  const asks = (g: Described) => guardConditions(g).includes(key);
  const places = (access.route ?? []).filter(asks).map((g) => at('route', screen.routeFile!, screen.line!, g));
  const role = key.startsWith('role:') ? key.slice('role:'.length) : null;
  for (const l of access.links ?? []) {
    const own = l.guards.filter(asks);
    places.push(...own.map((g) => at(l.from, l.file, l.line, g)));
    const start = screens.find((s) => s.id === l.from);
    if (role && !l.guards.some((g) => g.kinds.includes('role')) && start?.access?.restricted && start.access.roleValues?.includes(role)) {
      places.push({ from: l.from, file: l.file, line: l.line, inherited: true });
    }
  }
  for (const s of access.settings ?? []) {
    if (s.inherited && s.needs.some((n) => settingConditionName(n) === key)) places.push({ from: s.from, file: s.file!, line: s.line!, inherited: true });
  }
  return { places };
}

function locateLink(screen: PartScreen, key: unknown): SourcePlaces | null {
  const wanted = JSON.stringify(key);
  const rows = (screen.access?.links ?? []).filter((l) => JSON.stringify(linkKey(l)) === wanted);
  return rows.length ? { places: rows.map((l) => ({ from: l.from, file: l.file, line: l.line })) } : null;
}

export function locatePart({ node, part }: { node?: string; part?: Part }, context: PartContext): TestPlace | SourcePlaces | null {
  if (part!.kind === 'test') return locateTest(node!, part!.key, context);
  const screen = context.screens?.find((s) => s.id === node);
  if (!screen) return null;
  return part!.kind === 'condition' ? locateCondition(screen, part!.key, context.screens!, context.roleGuards ?? {}) : locateLink(screen, part!.key);
}

export const STORY_PART_KINDS = ['step', 'hop'];

export interface StepKey {
  step: number;
  screen: string;
}

export interface HopKey {
  step: number;
  from: string;
  to: string;
}

interface StoryLink {
  verdict: string;
  ways: unknown[];
  reasons?: string[];
  unknownLinks?: unknown[];
}

export interface StoryPath {
  id: string;
  file: string;
  screens: string[];
  links: StoryLink[];
  reach: { kind: string; from?: string; to?: string; screen?: string }[];
}

type ScreenPlace = { id: string; componentFile: string | null; routeFile: string | null; line: number | null; tableItem?: TableItem } | { id: string; onMap: false };

export interface StepPlace {
  file: string;
  screen: ScreenPlace;
}

export interface HopPlace extends StoryLink {
  file: string;
  from: ScreenPlace;
  to: ScreenPlace;
  preconditions: StoryPath['reach'];
}

function screenPlace(id: string, screens: PartScreen[]): ScreenPlace {
  const s = screens.find((x) => x.id === id);
  return s ? { id, componentFile: s.componentFile ?? null, routeFile: s.routeFile ?? null, line: s.line ?? null, ...(s.tableItem && { tableItem: s.tableItem }) } : { id, onMap: false };
}

export function locateStoryPart(part: Part, story: StoryPath, screens: PartScreen[]): StepPlace | HopPlace | null {
  const at = (part.key as StepKey | HopKey).step - 1;
  if (part.kind === 'step') {
    const { screen } = part.key as StepKey;
    return story.screens[at] === screen ? { file: story.file, screen: screenPlace(screen, screens) } : null;
  }
  const { from, to } = part.key as HopKey;
  if (story.screens[at] !== from || story.screens[at + 1] !== to) return null;
  const { verdict, ways, reasons, unknownLinks } = story.links[at];
  const preconditions = [...new Map(story.reach.map((r) => [JSON.stringify(r), r])).values()].filter((r) => (r.kind === 'link' && r.from === from && r.to === to) || (r.kind === 'route' && r.screen === to) || (r.kind === 'start' && at === 0 && r.screen === from));
  return { file: story.file, from: screenPlace(from, screens), to: screenPlace(to, screens), verdict, ways, ...(reasons && { reasons }), ...(unknownLinks && { unknownLinks }), preconditions };
}

export interface OrderPlace {
  screens: ScreenPlace[];
  links: ({ from: string; to: string } & StoryLink)[];
}

export function locateOrder(screens: string[], map: { screens: PartScreen[] }): OrderPlace | null {
  if (linksFromOldDuru(map)) return null;
  const [{ links }] = checkStories(map, [{ screens }]);
  return { screens: screens.map((id) => screenPlace(id, map.screens)), links };
}
