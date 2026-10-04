import { UNKNOWN } from './client.mjs';

// React Router v5 가 쓰는 path-to-regexp 1.x 의 경로 문법을 그대로 따른다.
const TOKEN = /(\\.)|([/.])?(?:(?::(\w+)(?:\(((?:\\.|[^\\()])+)\))?|\(((?:\\.|[^\\()])+)\))([+*?])?|(\*))/g;
const LIST_TIMEOUT_MS = 15_000;

const isVariable = (part) => typeof part !== 'string';

export function pathParts(routePath) {
  const parts = [];
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

const encode = (p, value) => (p.repeat || p.pattern === '.*' ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value));

function fill(parts, values) {
  let out = '';
  for (const p of parts) {
    if (!isVariable(p)) out += p;
    else if (values[p.name]) out += p.prefix + encode(p, values[p.name]);
    else if (!p.optional) return null;
  }
  return out || '/';
}

export const fillPath = (routePath, values) => fill(pathParts(routePath), values);

const escapeText = (s) => s.replace(/[.+*?=^!:${}()[\]|/\\]/g, '\\$&');

// exact 라우트처럼 경로 전체가 맞아야 하고, path-to-regexp 1.x 처럼 끝의 / 하나와 대소문자는 가리지 않는다.
export function routePattern(routePath) {
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

export const opensAsIs = (routePath) => !routePath.includes(UNKNOWN) && !pathParts(routePath).some(isVariable);

export function fallbackScreen(map, screen, pathValues = {}, role = null) {
  const byId = new Map(map.screens.map((s) => [s.id, s]));
  const found = [];
  for (const { from } of screen.access.links) {
    const s = byId.get(from);
    if (!s || s.path.includes(UNKNOWN)) continue;
    const fixed = Object.fromEntries(Object.entries(pathValues[s.path] ?? {}).filter(([, v]) => typeof v === 'string'));
    const path = fillPath(s.path, fixed);
    if (path) found.push({ id: s.id, path, opens: s.access.roleValues === undefined || Boolean(role && s.access.roleValues?.includes(role)) });
  }
  const { id, path } = found.find((f) => f.opens) ?? found[0] ?? {};
  return id ? { id, path } : null;
}

export function unknownPathValues(map, pathValues) {
  return Object.entries(pathValues).flatMap(([routePath, variables]) => {
    if (!map.screens.some((s) => s.path === routePath)) return [routePath];
    const names = pathParts(routePath).filter(isVariable).map((p) => p.name);
    return Object.keys(variables).filter((n) => !names.includes(n)).map((n) => `${routePath} 의 ${n}`);
  });
}

const at = (value, dotted) => (dotted ? dotted.split('.').reduce((o, k) => o?.[k], value) : value);

async function listValue({ api, method = 'GET', body, list, value }, fetchApi) {
  const label = `목록 API ${method} ${api}`;
  if (!fetchApi) return { error: `로그인하지 못해 ${label} 를 부르지 않았습니다` };
  let res;
  let json;
  try {
    res = await fetchApi(api, { method, body, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (res.ok) json = await res.json();
  } catch (err) {
    if (err.name === 'TimeoutError') return { error: `${label} 요청에 ${LIST_TIMEOUT_MS / 1000}초 안에 응답이 없었습니다` };
    if (err instanceof SyntaxError) return { error: `${label} 의 응답이 JSON 이 아닙니다` };
    return { error: `${label} 요청을 보내지 못했습니다 (${err.cause?.code ?? err.message})` };
  }
  if (!res.ok) return { error: `${label} 요청이 ${res.status} 로 실패했습니다` };
  const items = at(json, list);
  if (!Array.isArray(items)) return { error: list ? `${label} 응답의 ${list} 에 목록이 없습니다` : `${label} 의 응답이 목록이 아닙니다` };
  if (!items.length) return { error: `${label} 가 빈 목록을 돌려주었습니다` };
  const found = at(items[0], value);
  if (!(typeof found === 'string' && found) && !Number.isFinite(found)) return { error: `${label} 의 첫 항목에 ${value} 값이 없습니다` };
  return { value: String(found) };
}

// 필수 경로 변수에 값이 없으면 path 는 null 이다.
export async function preparePathValues(map, screen, pathValues, fetchApi, role = null) {
  const found = opensAsIs(screen.path) ? null : fallbackScreen(map, screen, pathValues, role);
  const fallback = found?.id ?? null;
  const fallbackPath = found?.path ?? null;
  if (screen.path.includes(UNKNOWN)) return { parts: null, values: {}, errors: [], path: null, fallback, fallbackPath };
  const parts = pathParts(screen.path);
  const variables = parts.filter(isVariable);
  const given = pathValues[screen.path] ?? {};
  const results = await Promise.all(variables.map(({ name }) => {
    const spec = given[name];
    if (typeof spec === 'string') return { value: spec };
    return spec ? listValue(spec, fetchApi) : {};
  }));
  const values = {};
  const errors = [];
  results.forEach((f, i) => {
    if (f.value !== undefined) values[variables[i].name] = f.value;
    if (f.error) errors.push(`${variables[i].name}: ${f.error}`);
  });
  return { parts, values, errors, path: fill(parts, values), fallback, fallbackPath };
}
