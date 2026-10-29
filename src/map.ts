import path from 'node:path';
import type { FunctionInputs } from './api-calls-worker.ts';
import { extractClient, UNKNOWN } from './client.ts';
import { clientPath, loadServerEndpoints, matchEndpoint } from './server.ts';
import { addressesUnderRoutes, linkTargets, screenAccess } from './access.ts';
import { compare } from './config.ts';
import { removeExcludedFields } from './body-type-exclusions.ts';
import { codeHasher, codeState } from './code-state.ts';
import type { CodeState } from './code-state.ts';
import { withoutPatterns } from './path-values.ts';
import type { AccessConfig } from './access.ts';
import type { RemovedField, UnknownExclusion } from './body-type-exclusions.ts';
import type { AliasRule } from './resolve.ts';
import type { EndpointMatch, UnresolvedReason } from './server.ts';

type Client = Awaited<ReturnType<typeof extractClient>>;
type ClientScreen = Client['screens'][number];
type Access = ReturnType<typeof screenAccess>;

interface MapConfig extends AccessConfig {
  requestFunction: unknown;
  srcRoot: string;
  outDir?: string;
  marksDir?: string;
  judgmentsDir?: string;
  storiesDir?: string;
  clientRef?: string;
  serverRef?: string;
  serverEndpoints: string[];
  apiPathPrefix?: string;
  bodyOptions?: Record<string, string[]>;
  bodyTypeExclusions?: Record<string, string[]>;
  callLinks?: CallLink[];
  moves?: { from: string; to: string; reason: string }[];
  settingsFunctions: unknown[];
  linkComponents?: unknown[];
  linkFunctions?: unknown[];
  app?: { apiPaths: string[] } | null;
  tsconfig?: string | null;
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
  // 요청에 실린 인자의 자리, 펼쳐 넘긴 인자의 자리. 알아내지 못했으면 inputsUnknown 에 그 까닭이 있다.
  inputs?: FunctionInputs;
  inputsUnknown?: string;
}

interface ApiFunctions {
  [name: string]: ApiFunction;
}

type MapApiCall = Omit<ClientScreen['apiCalls'][number], 'request' | 'navigation'> & { direct?: true; endpoints: Endpoint[] | null };
type CallInputs = NonNullable<ClientScreen['apiCalls'][number]['inputs']>;

export type MapScreen = Omit<ClientScreen, 'apiCalls' | 'links'> & {
  id: string;
  apiCalls: MapApiCall[];
  links: (Omit<ClientScreen['links'][number], 'reaches'> & { targets: string[]; conditions: Access['linkConditions'][number][number] })[];
  access: Access['access'][number];
  dead: boolean;
  codeHash?: string;
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
  codeHash?: string;
}

export type ScreenMap = {
  meta: { generatedAt: string; srcRoot: string; clientRef: string | null; serverRef: string | null } & Partial<CodeState>;
  screens: MapScreen[];
  appWide?: Omit<NonNullable<Client['appWide']>, 'apiCalls'> & { apiCalls: MapApiCall[] };
  apiFunctions: ApiFunctions;
  unrunApiModules?: NonNullable<Client['unrunApiModules']>;
  outsideStandIns?: Client['outsideStandIns'];
  silentApiModules?: Client['silentApiModules'];
  unreadRequests?: UnreadSite[];
  unreadRoutePaths?: Client['unreadRoutePaths'];
  unreadRoutes?: Client['unreadRoutes'];
  sagas?: NonNullable<Client['sagaRuns']>;
  bodyTypeNotices?: NonNullable<Client['bodyTypeNotices']>;
  deadCalls: { screen: string; fn: string; method: string | null; url: string | null; callSite: string }[];
  // 화면이 상태에 써서 API 함수에 넘긴 키 가운데 그 함수가 요청에 싣는지 알 수 없는 것과, 키를 알 수 없는 호출.
  inputsToCheck?: { screen: string; fn: string; key: string; file: string; line: number }[];
  unknownInputs?: { screen: string; fn: string; callSite: string; reason: string }[];
  duplicateIds: { id: string; places: { file: string; line: number }[] }[];
  calls: MapCall[];
  unknownBodyOptionCalls: string[];
  leftOutBodyTypeFields?: RemovedField[];
  keptBodyTypeExclusions?: (RemovedField & { keptBy: string[] })[];
  unknownBodyTypeExclusions?: UnknownExclusion[];
  serverNotCompared?: true;
  entries: Access['entries'];
  unknownEntryPaths: string[];
  unusedLinkEntries?: string[];
  unknownRoleGuards?: string[];
  openRouteGuards?: Access['openRouteGuards'];
  unreadRoleGuards?: Access['unreadRoleGuards'];
  settingsDefaults: Client['settingsDefaults'];
  settingsDefaultsIncomplete: Client['settingsDefaultsIncomplete'];
  settingsCallNotices?: Client['settingsCallNotices'];
  unresolvedAliasImports?: Client['unresolvedAliasImports'];
  madeHistories?: Client['madeHistories'];
  addressesUnderRoutes?: ReturnType<typeof addressesUnderRoutes>;
  callsOnNoScreen?: { unused: string[]; other: string[] };
  emptyRouteFiles?: Client['emptyRouteFiles'];
  framesPickingByAddress?: Client['framesPickingByAddress'];
} & ReturnType<typeof configuredCallLinks> & ReturnType<typeof configuredMoves>;

// JUnit 태그에 쓸 수 없는 문자. 이 문자만 없으면 Playwright · Vitest 제목에서도 그대로 태그로 쓸 수 있다.
const TAG_FORBIDDEN = /[\s,()&|!]+/g;

type UnreadSite = { fn: string; file: string | null; line: number; url: string | null; reason: UnresolvedReason };

// 다른 호스트로 가는 주소는 일부만 읽었어도 읽은 것으로 센다.
export const readsAnAddress = (screens: { apiCalls: MapApiCall[] }[]) =>
  screens.some((s) => s.apiCalls.some((c) => (c.endpoints ?? []).some((e) => e.server.status !== 'unresolved' || e.server.reason === 'other-host')));

export const sendingParts = <S, A>(map: { screens: S[]; appWide?: A | null }): (S | A)[] => [...map.screens, ...(map.appWide ? [map.appWide] : [])];

export const sentAtAppStart = (appWide: { apiCalls: MapApiCall[] } | null | undefined) => new Set((appWide?.apiCalls ?? []).flatMap((c) => (c.endpoints ?? []).flatMap((e) => (e.callId ? [e.callId] : []))));

export function unreadSites(screens: { apiCalls: MapApiCall[] }[], direct: boolean): UnreadSite[] {
  const unread = new Map<string, UnreadSite>();
  for (const s of screens) {
    for (const c of s.apiCalls) {
      if (Boolean(c.direct) !== direct) continue;
      for (const e of c.endpoints ?? []) {
        if (e.server.status === 'unresolved') unread.set(`${c.file}\n${c.line}\n${c.fn}\n${e.url}`, { fn: c.fn, file: c.file, line: c.line, url: e.url, reason: e.server.reason });
      }
    }
  }
  return [...unread.values()].sort((a, b) => compare(a.file ?? '', b.file ?? '') || a.line - b.line || compare(a.fn, b.fn) || compare(a.url ?? '', b.url ?? ''));
}

export function screenId(routePath: string, component: string) {
  return `${withoutPatterns(routePath)}#${component}`.replace(TAG_FORBIDDEN, '_');
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

function buildCalls(apiFunctions: ApiFunctions, screens: any[], appWide: { apiCalls: MapApiCall[] } | null | undefined, apiPathPrefix: string, bodyOptions: Record<string, string[]>, bodyTypeExclusions: Record<string, string[]>) {
  const calls = new Map<string, any>();
  const typeFields = new Map<string, Set<string>>();
  const nodeOf = (e: Endpoint) => {
    const call = callOf(e, apiPathPrefix);
    if (!call) return null;
    if (!calls.has(call.id)) {
      calls.set(call.id, { ...call, server: { ...e.server }, apiFunctions: new Set(), screens: new Set(), options: new Map() });
      typeFields.set(call.id, new Set());
    }
    const node = calls.get(call.id);
    if (e.server.candidates) node.server.candidates = [...new Set([...node.server.candidates, ...e.server.candidates])].sort();
    return node;
  };
  for (const [name, fn] of Object.entries(apiFunctions)) {
    for (const e of fn.endpoints) {
      const node = nodeOf(e);
      if (!node) continue;
      node.apiFunctions.add(name);
      for (const key of e.bodyOptions ?? []) typeFields.get(node.id)!.add(key);
    }
  }
  for (const c of sendingParts({ screens, appWide }).flatMap((s) => s.apiCalls)) if (c.direct) c.endpoints!.forEach(nodeOf);
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

// 화면이 상태에 써서 넘긴 키를 API 함수가 요청에 싣는지 본다. 실는지 알 수 없으면 확인할 키로, 키를 알 수 없는 호출은 unknownInputs 로 남긴다.
function checkInputs(screens: { id: string; apiCalls: (ClientScreen['apiCalls'][number] & { inputs?: CallInputs })[] }[], apiFunctions: ApiFunctions) {
  const toCheck = new Map<string, NonNullable<ScreenMap['inputsToCheck']>[number]>();
  const unknown = new Map<string, NonNullable<ScreenMap['unknownInputs']>[number]>();
  const precededBy = (short: string[], long: string[]) => short.length <= long.length && short.every((k, i) => k === long[i]);
  for (const s of screens) {
    for (const c of s.apiCalls) {
      const api = apiFunctions[c.fn];
      if (!c.inputs || (!api?.inputs && !api?.inputsUnknown)) continue;
      const callSite = `${c.file}:${c.line}`;
      const reason = c.inputs.unknown ?? api.inputsUnknown;
      if (reason) {
        unknown.set(JSON.stringify([s.id, c.fn, callSite]), { screen: s.id, fn: c.fn, callSite, reason });
        continue;
      }
      for (const { key, file, line } of c.inputs.keys) {
        const input = ['0', ...c.inputs.argPath, key];
        if (api.inputs!.sent.some((p) => precededBy(input, p))) continue;
        // 펼쳐 넘긴 자리 아래의 키는 함수가 키를 읽지 않으므로 키마다가 아니라 호출 하나로 남긴다.
        const spread = api.inputs!.spread.find((p) => precededBy(p, input));
        if (spread) {
          const reason = `the function spreads ${spread.join('.')} without reading its keys`;
          unknown.set(JSON.stringify([s.id, c.fn, callSite, reason]), { screen: s.id, fn: c.fn, callSite, reason });
          continue;
        }
        toCheck.set(JSON.stringify([s.id, c.fn, key, file, line]), { screen: s.id, fn: c.fn, key, file, line });
      }
    }
  }
  return {
    inputsToCheck: [...toCheck.values()].sort((a, b) => compare(a.screen, b.screen) || compare(a.fn, b.fn) || compare(a.key, b.key) || compare(a.file, b.file) || a.line - b.line),
    unknownInputs: [...unknown.values()].sort((a, b) => compare(a.screen, b.screen) || compare(a.fn, b.fn) || compare(a.callSite, b.callSite)),
  };
}

export async function buildMap(config: MapConfig): Promise<ScreenMap> {
  const { screens, appWide, apiFunctions, unreferencedApiFunctions, sagaRuns, unrunApiModules, outsideStandIns, silentApiModules, bodyTypeNotices, redirects, unreadRoutePaths, unreadRoutes, guardInits, constants, guardSettings, settingsDefaults, settingsDefaultsIncomplete, settingsCallNotices, unresolvedAliasImports, unusedListed, madeHistories, emptyRouteFiles, takingAddressesUnder, framesPickingByAddress } = await extractClient(config);
  const server = config.serverEndpoints.flatMap(loadServerEndpoints);
  const apiPathPrefix = config.apiPathPrefix ?? '/';

  for (const fn of Object.values(apiFunctions)) {
    for (const e of fn.endpoints) {
      e.server = matchEndpoint(server, e.method, e.url, apiPathPrefix);
      e.callId = callOf(e, apiPathPrefix)?.id ?? null;
    }
  }

  // POST 가 아닌 페이지 이동은 앱의 화면이 열리는 것일 수 있어, 서버 목록에 그 경로가 있거나 app.apiPaths 로 시작할 때만 서버로 가는 요청으로 본다.
  // 서버 목록은 apiPathPrefix 를 뗀 경로라, 그 접두사 없이 적힌 주소가 목록과 맞는 것은 같은 경로가 아니다.
  const listed = (e: { url: string | null; server: EndpointMatch }) => ['match', 'method-mismatch'].includes(e.server.status) && e.url!.startsWith(apiPathPrefix);
  const goesToServer = (e: { url: string | null; server: EndpointMatch }) => listed(e) || (config.app?.apiPaths ?? []).some((prefix) => e.url!.startsWith(prefix));
  const withEndpoints = (apiCalls: ClientScreen['apiCalls']): MapApiCall[] => apiCalls.flatMap(({ request, navigation, inputs, ...c }) => {
    if (!request) return [{ ...c, endpoints: apiFunctions[c.fn]?.endpoints ?? null }];
    const { unresolved, ...sent } = request;
    const e = { ...sent, line: c.line, server: unresolved ? { status: 'unresolved' as const, reason: unresolved } : matchEndpoint(server, sent.method, sent.url, apiPathPrefix), callId: null as string | null };
    if (navigation && sent.method !== 'POST' && !goesToServer(e)) return [];
    e.callId = callOf(e, apiPathPrefix)?.id ?? null;
    return [{ ...c, direct: true as const, endpoints: [e] }];
  });
  const mapped: any[] = screens.map((s) => ({ id: screenId(s.path, s.component), ...s, apiCalls: withEndpoints(s.apiCalls) }));
  const appWideMapped = appWide && { ...appWide, apiCalls: withEndpoints(appWide.apiCalls) };
  const unreadRequests = unreadSites(sendingParts({ screens: mapped, appWide: appWideMapped }), true);
  const { access, entries, unknownEntryPaths, unknownRoleGuards, openRouteGuards, unreadRoleGuards, linkConditions, linkScreens } = screenAccess(mapped, redirects, config, guardInits, constants, guardSettings);
  mapped.forEach((s, i) => {
    s.access = access[i];
    s.links = s.links.map(({ reaches, ...l }: { reaches?: number[] }, j: number) => ({ ...l, targets: [...new Set(linkScreens[i][j].map((k) => mapped[k].id))], conditions: linkConditions[i][j] }));
  });

  const underRoutes = addressesUnderRoutes(mapped, takingAddressesUnder);

  const placesById = new Map<string, { file: string; line: number }[]>();
  for (const s of mapped) placesById.set(s.id, [...(placesById.get(s.id) ?? []), s.tableItem ? { file: s.tableItem.file, line: s.tableItem.line } : { file: s.routeFile, line: s.line }]);
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
  // 입력 키는 지도의 호출에서 빠지므로, 옮기기 전 화면의 호출에서 읽는다.
  const inputCheck = config.requestFunction ? checkInputs(screens.map((s, i) => ({ id: mapped[i].id, apiCalls: s.apiCalls })), apiFunctions) : null;

  const { calls, unknownBodyOptionCalls, leftOutBodyTypeFields, keptBodyTypeExclusions, unknownBodyTypeExclusions } = buildCalls(apiFunctions, mapped, appWideMapped, apiPathPrefix, config.bodyOptions ?? {}, bodyTypeExclusions);

  const unreferenced = new Set(unreferencedApiFunctions);
  const sentForApp = sentAtAppStart(appWideMapped);
  const noScreen = calls.filter((c) => !c.screens.length && !sentForApp.has(c.id));
  const unusedCall = (c: MapCall) => c.apiFunctions.length > 0 && c.apiFunctions.every((name) => unreferenced.has(name));
  const callsOnNoScreen = { unused: noScreen.filter(unusedCall).map((c) => c.id), other: noScreen.filter((c) => !unusedCall(c)).map((c) => c.id) };

  const hash = codeHasher(config.srcRoot);
  for (const s of mapped) s.codeHash = hash(s.sourceFiles ?? []);
  const requestFiles = new Map<string, (string | null)[]>(calls.map((c) => [c.id, c.apiFunctions.map((name: string) => apiFunctions[name]?.file ?? null)]));
  for (const c of sendingParts({ screens: mapped, appWide: appWideMapped }).flatMap((s) => s.apiCalls)) if (c.direct) for (const e of c.endpoints) if (e.callId) requestFiles.get(e.callId)?.push(c.file);
  for (const c of calls) c.codeHash = hash(requestFiles.get(c.id)!);

  return {
    meta: { generatedAt: new Date().toISOString(), srcRoot: config.srcRoot, clientRef: config.clientRef ?? null, serverRef: config.serverRef ?? null, ...codeState(config.srcRoot, [...(config.outDir ? [config.outDir, ...['map.json', 'tests.json'].map((name) => path.join(config.outDir!, name))] : []), config.marksDir, config.judgmentsDir, config.storiesDir].filter((p): p is string => typeof p === 'string')) },
    screens: mapped,
    ...(appWideMapped && { appWide: appWideMapped }),
    apiFunctions,
    ...(unrunApiModules && { unrunApiModules }),
    ...(outsideStandIns.length && { outsideStandIns }),
    ...(silentApiModules.length && { silentApiModules }),
    ...(unreadRequests.length && { unreadRequests }),
    ...(unreadRoutePaths.length && { unreadRoutePaths }),
    ...(unreadRoutes.length && { unreadRoutes }),
    ...(sagaRuns && { sagas: sagaRuns }),
    ...(bodyTypeNotices && { bodyTypeNotices }),
    deadCalls,
    ...inputCheck,
    duplicateIds,
    calls,
    unknownBodyOptionCalls,
    ...(Object.keys(bodyTypeExclusions).length > 0 && { leftOutBodyTypeFields, keptBodyTypeExclusions, unknownBodyTypeExclusions }),
    ...configuredCallLinks(calls, config.callLinks ?? []),
    ...(server.length === 0 && { serverNotCompared: true }),
    entries,
    unknownEntryPaths,
    ...(unusedListed && { unusedLinkEntries: unusedListed }),
    ...(Object.keys(config.roleGuards ?? {}).length > 0 && { unknownRoleGuards }),
    ...(openRouteGuards.length && { openRouteGuards }),
    ...(unreadRoleGuards.length && { unreadRoleGuards }),
    ...configuredMoves(mapped, config.moves ?? []),
    settingsDefaults,
    settingsDefaultsIncomplete,
    ...(config.settingsFunctions.length > 0 && { settingsCallNotices }),
    ...(config.tsconfig && { unresolvedAliasImports }),
    ...(madeHistories.length > 0 && { madeHistories }),
    ...(underRoutes.length > 0 && { addressesUnderRoutes: underRoutes }),
    ...(noScreen.length > 0 && { callsOnNoScreen }),
    ...(emptyRouteFiles.length > 0 && { emptyRouteFiles }),
    ...(framesPickingByAddress.length > 0 && { framesPickingByAddress }),
  };
}
