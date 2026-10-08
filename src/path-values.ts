import { UNKNOWN } from './client.ts';

interface PathVariable {
  name: string;
  prefix: string;
  optional: boolean;
  pattern: string | null;
  repeat?: boolean;
}

export type PathPart = string | PathVariable;

interface ValueSpec {
  api: string;
  method?: string;
  header?: Record<string, string>;
  keyEnv?: string;
  body?: unknown;
  list?: string;
  value?: string;
}

type Given = Record<string, (string & { keyEnv?: undefined; body?: undefined }) | ValueSpec>;

interface PathScreen {
  id: string;
  path: string;
  access: { roleValues?: string[] | null; links: { from: string }[] };
}

interface PathMap {
  screens: PathScreen[];
}

type ApiFetch = (api: string, init: { method: string; body?: unknown; headers?: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

interface RequestFailure extends Error {
  cause?: { code?: string };
}

interface PreparedPathValues {
  parts: PathPart[] | null;
  values: Record<string, string>;
  queryNames: string[];
  errors: string[];
  path: string | null;
  fallback: string | null;
  fallbackPath: string | null;
  issued?: string[];
}

// React Router v5 가 쓰는 path-to-regexp 1.x 의 경로 문법을 그대로 따른다.
const TOKEN = /(\\.)|([/.])?(?:(?::(\w+)(?:\(((?:\\.|[^\\()])+)\))?|\(((?:\\.|[^\\()])+)\))([+*?])?|(\*))/g;
const API_TIMEOUT_MS = 15_000;

const isVariable = (part: PathPart): part is PathVariable => typeof part !== 'string';

export function pathParts(routePath: string): PathPart[] {
  const parts: PathPart[] = [];
  let text = '';
  let last = 0;
  let unnamed = 0;
  for (const m of routePath.matchAll(TOKEN)) {
    const [, escaped, prefix = '', name, pattern, group, modifier, asterisk] = m;
    text += routePath.slice(last, m.index);
    last = m.index + m[0].length;
    if (escaped) {
      text += escaped[1];
      continue;
    }
    if (text) parts.push(text);
    text = '';
    const repeat = modifier === '+' || modifier === '*';
    parts.push({ name: name ?? String(unnamed++), prefix, optional: modifier === '?' || modifier === '*', pattern: pattern ?? group ?? (asterisk ? '.*' : null), ...(repeat ? { repeat } : {}) });
  }
  text += routePath.slice(last);
  if (text) parts.push(text);
  return parts;
}

const encode = (p: PathVariable, value: string) => (p.repeat || p.pattern === '.*' ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value));

function fill(parts: PathPart[], values: Record<string, unknown>) {
  let out = '';
  for (const p of parts) {
    if (!isVariable(p)) out += p;
    else if (values[p.name]) out += p.prefix + encode(p, values[p.name] as string);
    else if (!p.optional) return null;
  }
  return out || '/';
}

export const fillPath = (routePath: string, values: Record<string, unknown>) => fill(pathParts(routePath), values);

const isQuery = (name: string) => name.length > 1 && name.startsWith('?');
const queryNamesOf = (given: Record<string, unknown>) => Object.keys(given).filter(isQuery);

function withQuery(path: string | null, names: string[], values: Record<string, unknown>) {
  if (path === null) return null;
  const pairs: string[] = [];
  for (const name of names) {
    if (!values[name]) return null;
    pairs.push(`${encodeURIComponent(name.slice(1))}=${encodeURIComponent(values[name] as string)}`);
  }
  return pairs.length ? `${path}?${pairs.join('&')}` : path;
}

const escapeText = (s: string) => s.replace(/[.+*?=^!:${}()[\]|/\\]/g, '\\$&');

// exact 라우트처럼 경로 전체가 맞아야 하고, path-to-regexp 1.x 처럼 끝의 / 하나와 대소문자는 가리지 않는다.
export function routePattern(routePath: string) {
  let source = '';
  for (const p of pathParts(routePath)) {
    if (!isVariable(p)) {
      source += escapeText(p);
      continue;
    }
    const prefix = escapeText(p.prefix);
    let capture = `(?:${p.pattern ?? `[^${escapeText(p.prefix || '/')}]+?`})`;
    if (p.repeat) capture += `(?:${prefix}${capture})*`;
    source += p.optional ? `(?:${prefix}${capture})?` : prefix + capture;
  }
  return new RegExp(`^${source.replace(/\\\/$/, '')}(?:\\/(?=$))?$`, 'i');
}

export const opensAsIs = (routePath: string, given: Given = {}) => !routePath.includes(UNKNOWN) && !pathParts(routePath).some(isVariable) && queryNamesOf(given).every((n) => typeof given[n] === 'string' && given[n]);
export const asIsPath = (routePath: string, given: Given = {}) => withQuery(fillPath(routePath, {}), queryNamesOf(given), given);

export function fallbackScreen(map: PathMap, screen: PathScreen, pathValues: Record<string, Given> = {}, role: string | null = null) {
  const byId = new Map(map.screens.map((s) => [s.id, s]));
  const found: { id: string; path: string; opens: boolean }[] = [];
  for (const { from } of screen.access.links) {
    const s = byId.get(from);
    if (!s || s.path.includes(UNKNOWN)) continue;
    const given = pathValues[s.path] ?? {};
    const fixed = Object.fromEntries(Object.entries(given).filter(([, v]) => typeof v === 'string'));
    const path = withQuery(fillPath(s.path, fixed), queryNamesOf(given), fixed);
    if (path) found.push({ id: s.id, path, opens: s.access.roleValues === undefined || Boolean(role && s.access.roleValues?.includes(role)) });
  }
  const { id, path } = found.find((f) => f.opens) ?? found[0] ?? {};
  return id ? { id, path } : null;
}

export function unknownPathValues(map: PathMap, pathValues: Record<string, Given>) {
  return Object.entries(pathValues).flatMap(([routePath, variables]) => {
    if (!map.screens.some((s) => s.path === routePath)) return [routePath];
    const names = pathParts(routePath).filter(isVariable).map((p) => p.name);
    return Object.keys(variables).filter((n) => !names.includes(n) && !isQuery(n)).map((n) => `${routePath} 의 ${n}`);
  });
}

const at = (value: unknown, dotted?: string): unknown => (dotted ? dotted.split('.').reduce((o, k) => (o as Record<string, unknown> | undefined)?.[k], value) : value);
const isPathValue = (v: unknown): v is string | number => (typeof v === 'string' && v !== '') || Number.isFinite(v);

async function replyOf(label: string, request: (signal: AbortSignal) => Promise<Response>) {
  let res;
  let json;
  try {
    res = await request(AbortSignal.timeout(API_TIMEOUT_MS));
    if (res.ok) json = await res.json();
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') return { error: `${label} 요청에 ${API_TIMEOUT_MS / 1000}초 안에 응답이 없었습니다` };
    if (err instanceof SyntaxError) return { error: `${label} 의 응답이 JSON 이 아닙니다` };
    return { error: `${label} 요청을 보내지 못했습니다 (${(err as RequestFailure).cause?.code ?? (err as Error).message})` };
  }
  if (!res.ok) return { error: `${label} 요청이 ${res.status} 로 실패했습니다` };
  return { json };
}

const labelOf = ({ api, method = 'GET', keyEnv }: ValueSpec) => `${keyEnv ? '발급' : '목록'} API ${method} ${api}`;

async function listValue(spec: ValueSpec, fetchApi: ApiFetch | null) {
  const { api, method = 'GET', body, list, value } = spec;
  const label = labelOf(spec);
  if (!fetchApi) return { error: `로그인하지 못해 ${label} 를 부르지 않았습니다` };
  const { json, error } = await replyOf(label, (signal) => fetchApi(api, { method, body, signal }));
  if (error) return { error };
  const items = at(json, list);
  if (!Array.isArray(items)) return { error: list ? `${label} 응답의 ${list} 에 목록이 없습니다` : `${label} 의 응답이 목록이 아닙니다` };
  if (!items.length) return { error: `${label} 가 빈 목록을 돌려주었습니다` };
  const found = at(items[0], value);
  if (!isPathValue(found)) return { error: `${label} 의 첫 항목에 ${value} 값이 없습니다` };
  return { value: String(found) };
}

async function issuedValue(spec: ValueSpec, fetchServer: ApiFetch | null) {
  const { api, method = 'GET', header, keyEnv, body, value } = spec;
  const label = labelOf(spec);
  const key = process.env[keyEnv!];
  if (key === undefined) return { error: `환경 변수 ${keyEnv} 에 키가 없어 ${label} 를 부르지 않았습니다` };
  const headers = Object.fromEntries(Object.entries(header!).map(([name, v]) => [name, v.replaceAll('{key}', () => key)]));
  // fetch 는 header 에 넣을 수 없는 값을 오류 문구에 그대로 실으므로, 키가 오류에 섞여 나가지 않게 보내기 전에 확인한다.
  try {
    new Headers(headers);
  } catch {
    return { error: `환경 변수 ${keyEnv} 의 키를 header 에 넣을 수 없습니다` };
  }
  const { json, error } = await replyOf(label, (signal) => fetchServer!(api, { method, headers, body, signal }));
  if (error) return { error };
  const found = at(json, value);
  if (!isPathValue(found)) return { error: value ? `${label} 응답의 ${value} 에 값이 없습니다` : `${label} 의 응답이 값 하나가 아닙니다` };
  return { value: String(found) };
}

const PLACEHOLDER = /\{(\w+)\}/g;
const stringsOf = (v: unknown): string[] => (typeof v === 'string' ? [v] : v !== null && typeof v === 'object' ? Object.values(v).flatMap(stringsOf) : []);
const mapStrings = (v: unknown, f: (text: string) => unknown): unknown => {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
};

const namedIn = (body: unknown, names: string[]) => [...new Set(stringsOf(body).flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1])))].filter((n) => names.includes(n));
const fillBody = (body: unknown, names: string[], values: Record<string, string>) => mapStrings(body, (text) => text.replace(PLACEHOLDER, (all: string, name: string) => (names.includes(name) ? values[name] : all)));

// 필수 경로 변수나 설정한 쿼리 값에 값이 없으면 path 는 null 이다. typed 는 리뷰하는 사람이 칸에 적은 값으로, 설정값 대신 쓴다.
export async function preparePathValues(map: PathMap, screen: PathScreen, pathValues: Record<string, Given>, fetchApi: ApiFetch | null, role: string | null = null, fetchServer: ApiFetch | null = null, typed: Record<string, string> = {}): Promise<PreparedPathValues> {
  const given = pathValues[screen.path] ?? {};
  const found = opensAsIs(screen.path, given) ? null : fallbackScreen(map, screen, pathValues, role);
  const fallback = found?.id ?? null;
  const fallbackPath = found?.path ?? null;
  if (screen.path.includes(UNKNOWN)) return { parts: null, values: {}, queryNames: [], errors: [], path: null, fallback, fallbackPath };
  const parts = pathParts(screen.path);
  const variables = parts.filter(isVariable).map((p) => p.name);
  const query = queryNamesOf(given);
  const all = [...variables, ...query];
  const specOf = (name: string): Given[string] => (typeof typed[name] === 'string' ? typed[name] : given[name]);
  const needs = new Map<string, string[]>(all.map((name): [string, string[]] => [name, specOf(name)?.keyEnv ? namedIn(specOf(name).body, variables) : []]));
  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const valueOf = async (name: string): Promise<{ value?: string; error?: string }> => {
    const spec = specOf(name);
    if (typeof spec === 'string') return spec ? { value: spec } : {};
    if (!spec) return {};
    if (!spec.keyEnv) return listValue(spec, fetchApi);
    const missing = needs.get(name)!.filter((n) => !values[n]);
    if (missing.length) return { error: `${missing.join(', ')} 값이 없어 ${labelOf(spec)} 를 부르지 않았습니다` };
    return issuedValue({ ...spec, body: fillBody(spec.body, needs.get(name)!, values) }, fetchServer);
  };
  const settle = async (batch: string[]) => {
    const results = await Promise.all(batch.map(valueOf));
    results.forEach((f, i) => {
      if (f.value !== undefined) values[batch[i]] = f.value;
      if (f.error) errors[batch[i]] = f.error;
    });
  };
  await settle(all.filter((n) => !needs.get(n)!.length));
  await settle(all.filter((n) => needs.get(n)!.length));
  const issued = all.filter((n) => specOf(n)?.keyEnv);
  return {
    parts,
    values,
    queryNames: query,
    errors: all.filter((n) => errors[n]).map((n) => `${n}: ${errors[n]}`),
    path: withQuery(fill(parts, values), query, values),
    fallback,
    fallbackPath,
    ...(issued.length ? { issued } : {}),
  };
}
