import { extractClient, UNKNOWN } from './client.ts';
import { clientPath, loadServerEndpoints, matchEndpoint } from './server.ts';
import { linkTargets, screenAccess } from './access.ts';
import { compare } from './config.ts';
import { removeExcludedFields } from './body-type-exclusions.ts';
import type { AccessConfig } from './access.ts';
import type { RemovedField, UnknownExclusion } from './body-type-exclusions.ts';
import type { AliasRule } from './resolve.ts';
import type { EndpointMatch } from './server.ts';

type Client = Awaited<ReturnType<typeof extractClient>>;
type ClientScreen = Client['screens'][number];
type Access = ReturnType<typeof screenAccess>;

interface MapConfig extends AccessConfig {
  srcRoot: string;
  clientRef?: string;
  serverRef?: string;
  serverEndpoints: string[];
  apiPathPrefix?: string;
  bodyOptions?: Record<string, string[]>;
  bodyTypeExclusions?: Record<string, string[]>;
  callLinks?: CallLink[];
  moves?: { from: string; to: string; reason: string }[];
  settingsFunctions: unknown[];
  aliases?: AliasRule[] | null;
}

export interface Endpoint {
  method: string | null;
  url: string | null;
  line: number | null;
  via?: string;
  server: EndpointMatch & { path?: string; candidates?: string[]; labels?: string[] };
  callId: string | null;
  bodyOptions?: string[];
}

export interface ApiFunction {
  file: string | null;
  line: number | null;
  endpoints: Endpoint[];
  error?: string;
}

interface ApiFunctions {
  [name: string]: ApiFunction;
}

export type MapScreen = Omit<ClientScreen, 'apiCalls' | 'links'> & {
  id: string;
  apiCalls: (ClientScreen['apiCalls'][number] & { endpoints: Endpoint[] | null })[];
  links: (ClientScreen['links'][number] & { conditions: Access['linkConditions'][number][number] })[];
  access: Access['access'][number];
  dead: boolean;
};

interface OptionSite {
  screen: string;
  file: string;
  line: number;
}

interface CallOption {
  sources: Set<string>;
  sites: Map<string, OptionSite>;
}

interface CallLink {
  from: string;
  to: string;
  note: string;
  missing?: string[];
}

export interface MapCall {
  id: string;
  method: string;
  path: string;
  server: Endpoint['server'];
  apiFunctions: string[];
  screens: string[];
  options: { key: string; values: boolean[]; sources: string[]; sites: OptionSite[] }[];
}

export type ScreenMap = {
  meta: { generatedAt: string; srcRoot: string; clientRef: string | null; serverRef: string | null };
  screens: MapScreen[];
  apiFunctions: ApiFunctions;
  unrunApiModules?: NonNullable<Client['unrunApiModules']>;
  bodyTypeNotices?: NonNullable<Client['bodyTypeNotices']>;
  deadCalls: { screen: string; fn: string; method: string | null; url: string | null; callSite: string }[];
  duplicateIds: { id: string; places: { file: string; line: number }[] }[];
  calls: MapCall[];
  unknownBodyOptionCalls: string[];
  leftOutBodyTypeFields?: RemovedField[];
  keptBodyTypeExclusions?: (RemovedField & { keptBy: string[] })[];
  unknownBodyTypeExclusions?: UnknownExclusion[];
  serverNotCompared?: true;
  entries: Access['entries'];
  unknownEntryPaths: string[];
  unknownRoleGuards?: string[];
  settingsDefaults: Client['settingsDefaults'];
  settingsDefaultsIncomplete: Client['settingsDefaultsIncomplete'];
  settingsCallNotices?: Client['settingsCallNotices'];
  unresolvedAliasImports?: Client['unresolvedAliasImports'];
} & ReturnType<typeof configuredCallLinks> & ReturnType<typeof configuredMoves>;

// JUnit 태그에 쓸 수 없는 문자. 이 문자만 없으면 Playwright · Vitest 제목에서도 그대로 태그로 쓸 수 있다.
const TAG_FORBIDDEN = /[\s,()&|!]+/g;

export function screenId(routePath: string, component: string) {
  return `${routePath}#${component}`.replace(TAG_FORBIDDEN, '_');
}

function callOf(e: Endpoint, apiPathPrefix: string) {
  if (e.server.status === 'unresolved') return null;
  const method = e.method ?? UNKNOWN;
  const p = e.server.path ?? clientPath(e.url!, apiPathPrefix);
  return { id: `${method}:${p}`.replace(TAG_FORBIDDEN, '_'), method, path: p };
}

function configuredMoves(screens: { id: string; path: string }[], moves: { from: string; to: string; reason: string }[]) {
  const targetsOf = linkTargets(screens);
  const joined = new Map<string, { from: string; to: string; reason: string }>();
  const unknownPaths = new Set<string>();
  for (const { from, to, reason } of moves) {
    const [froms, tos] = [from, to].map((p) => {
      const found = targetsOf(p);
      if (!found.length) unknownPaths.add(p);
      return found;
    });
    for (const i of froms) {
      for (const j of tos) {
        const move = { from: screens[i].id, to: screens[j].id, reason };
        joined.set(JSON.stringify(move), move);
      }
    }
  }
  return { moves: [...joined.values()], unknownMovePaths: [...unknownPaths] };
}

function configuredCallLinks(calls: { id: string }[], callLinks: CallLink[]) {
  const onMap = new Set(calls.map((c) => c.id));
  const joined = new Map<string, CallLink>();
  for (const { from, to, note } of callLinks) {
    const missing = [from, to].filter((id) => !onMap.has(id));
    joined.set(JSON.stringify([from, to, note]), missing.length ? { from, to, note, missing } : { from, to, note });
  }
  const links = [...joined.values()].sort((a, b) => compare(a.to, b.to) || compare(a.from, b.from) || compare(a.note, b.note));
  return { callLinks: links.filter((l) => !l.missing), unknownCallLinks: links.filter((l): l is CallLink & { missing: string[] } => Boolean(l.missing)) };
}

const bySite = (a: OptionSite, b: OptionSite) => compare(a.screen, b.screen) || compare(a.file, b.file) || a.line - b.line;
const OPTION_SOURCES = ['source', 'type', 'config'];

function buildCalls(apiFunctions: ApiFunctions, screens: any[], apiPathPrefix: string, bodyOptions: Record<string, string[]>, bodyTypeExclusions: Record<string, string[]>) {
  const calls = new Map<string, any>();
  const typeFields = new Map<string, Set<string>>();
  for (const [name, fn] of Object.entries(apiFunctions)) {
    for (const e of fn.endpoints) {
      const call = callOf(e, apiPathPrefix);
      if (!call) continue;
      if (!calls.has(call.id)) {
        calls.set(call.id, { ...call, server: { ...e.server }, apiFunctions: new Set(), screens: new Set(), options: new Map() });
        typeFields.set(call.id, new Set());
      }
      const node = calls.get(call.id);
      node.apiFunctions.add(name);
      for (const key of e.bodyOptions ?? []) typeFields.get(call.id)!.add(key);
      if (e.server.candidates) node.server.candidates = [...new Set([...node.server.candidates, ...e.server.candidates])].sort();
    }
  }
  const optionOf = (node: any, key: string): CallOption => {
    if (!node.options.has(key)) node.options.set(key, { sources: new Set(), sites: new Map() });
    return node.options.get(key);
  };
  const { removed, unknown } = removeExcludedFields(typeFields, bodyTypeExclusions);
  for (const [id, keys] of typeFields) for (const key of keys) optionOf(calls.get(id), key).sources.add('type');
  for (const s of screens) {
    for (const c of s.apiCalls) {
      for (const e of c.endpoints ?? []) {
        if (!e.callId) continue;
        const node = calls.get(e.callId);
        node.screens.add(s.id);
        if (e.method === 'GET') continue;
        for (const o of c.options) {
          const option = optionOf(node, o.key);
          option.sources.add('source');
          option.sites.set(`${s.id}\n${c.file}\n${o.line}`, { screen: s.id, file: c.file, line: o.line });
        }
      }
    }
  }
  const unknownBodyOptionCalls: string[] = [];
  for (const [id, keys] of Object.entries(bodyOptions)) {
    const node = calls.get(id);
    if (!node) unknownBodyOptionCalls.push(id);
    else for (const key of keys) optionOf(node, key).sources.add('config');
  }
  const leftOutBodyTypeFields: RemovedField[] = [];
  const keptBodyTypeExclusions: (RemovedField & { keptBy: string[] })[] = [];
  for (const r of removed) {
    const option = calls.get(r.call).options.get(r.field);
    if (option) keptBodyTypeExclusions.push({ ...r, keptBy: OPTION_SOURCES.filter((src) => option.sources.has(src)) });
    else leftOutBodyTypeFields.push(r);
  }
  const nodes = [...calls.values()]
    .sort((a, b) => compare(a.id, b.id))
    .map((c) => ({
      ...c,
      apiFunctions: [...c.apiFunctions].sort(),
      screens: [...c.screens].sort(),
      options: [...c.options]
        .sort(([a], [b]) => compare(a, b))
        .map(([key, o]: [string, CallOption]) => ({ key, values: [true, false], sources: OPTION_SOURCES.filter((src) => o.sources.has(src)), sites: [...o.sites.values()].sort(bySite) })),
    }));
  return { calls: nodes, unknownBodyOptionCalls: unknownBodyOptionCalls.sort(), leftOutBodyTypeFields, keptBodyTypeExclusions, unknownBodyTypeExclusions: unknown };
}

export async function buildMap(config: MapConfig): Promise<ScreenMap> {
  const { screens, apiFunctions, unrunApiModules, bodyTypeNotices, redirects, guardInits, constants, guardSettings, settingsDefaults, settingsDefaultsIncomplete, settingsCallNotices, unresolvedAliasImports } = await extractClient(config);
  const server = config.serverEndpoints.flatMap(loadServerEndpoints);
  const apiPathPrefix = config.apiPathPrefix ?? '/';

  for (const fn of Object.values(apiFunctions)) {
    for (const e of fn.endpoints) {
      e.server = matchEndpoint(server, e.method, e.url, apiPathPrefix);
      e.callId = callOf(e, apiPathPrefix)?.id ?? null;
    }
  }

  const mapped: any[] = screens.map((s) => ({
    id: screenId(s.path, s.component),
    ...s,
    apiCalls: s.apiCalls.map((c) => ({ ...c, endpoints: apiFunctions[c.fn]?.endpoints ?? null })),
  }));
  const { access, entries, unknownEntryPaths, unknownRoleGuards, linkConditions } = screenAccess(mapped, redirects, config, guardInits, constants, guardSettings);
  mapped.forEach((s, i) => {
    s.access = access[i];
    s.links = s.links.map((l: object, j: number) => ({ ...l, conditions: linkConditions[i][j] }));
  });

  const placesById = new Map<string, { file: string; line: number }[]>();
  for (const s of mapped) placesById.set(s.id, [...(placesById.get(s.id) ?? []), { file: s.routeFile, line: s.line }]);
  const duplicateIds = [...placesById].filter(([, places]) => places.length > 1).map(([id, places]) => ({ id, places }));

  for (const s of mapped) s.dead = s.apiCalls.some((c: { endpoints: Endpoint[] | null }) => (c.endpoints ?? []).some((e) => e.server.status === 'none'));

  const deadCalls: ScreenMap['deadCalls'] = [];
  for (const s of mapped) {
    for (const c of s.apiCalls) {
      for (const e of c.endpoints ?? []) {
        if (e.server.status === 'none') deadCalls.push({ screen: s.id, fn: c.fn, method: e.method, url: e.url, callSite: `${c.file}:${c.line}` });
      }
    }
  }

  const bodyTypeExclusions = config.bodyTypeExclusions ?? {};
  const { calls, unknownBodyOptionCalls, leftOutBodyTypeFields, keptBodyTypeExclusions, unknownBodyTypeExclusions } = buildCalls(apiFunctions, mapped, apiPathPrefix, config.bodyOptions ?? {}, bodyTypeExclusions);

  return {
    meta: { generatedAt: new Date().toISOString(), srcRoot: config.srcRoot, clientRef: config.clientRef ?? null, serverRef: config.serverRef ?? null },
    screens: mapped,
    apiFunctions,
    ...(unrunApiModules && { unrunApiModules }),
    ...(bodyTypeNotices && { bodyTypeNotices }),
    deadCalls,
    duplicateIds,
    calls,
    unknownBodyOptionCalls,
    ...(Object.keys(bodyTypeExclusions).length > 0 && { leftOutBodyTypeFields, keptBodyTypeExclusions, unknownBodyTypeExclusions }),
    ...configuredCallLinks(calls, config.callLinks ?? []),
    ...(server.length === 0 && { serverNotCompared: true }),
    entries,
    unknownEntryPaths,
    ...(Object.keys(config.roleGuards ?? {}).length > 0 && { unknownRoleGuards }),
    ...configuredMoves(mapped, config.moves ?? []),
    settingsDefaults,
    settingsDefaultsIncomplete,
    ...(config.settingsFunctions.length > 0 && { settingsCallNotices }),
    ...(config.aliases && { unresolvedAliasImports }),
  };
}
