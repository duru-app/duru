import { escapeText, readableRoute, routePattern } from './path-values.ts';
import { GLUED_UNKNOWN, writtenSegments } from './server.ts';

interface MapEndpoint {
  callId?: string | null;
  method: string | null;
  url: string | null;
}

interface MapScreen {
  id: string;
  path: string;
  apiCalls?: { direct?: boolean; endpoints?: MapEndpoint[] | null }[];
}

interface AddressMap {
  screens: MapScreen[];
  apiFunctions?: Record<string, { endpoints: MapEndpoint[] }>;
}

interface CallRoute {
  id: string | null | undefined;
  segments: (string | RegExp)[];
  method: string | null;
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

export const isAppPath = (url: unknown): url is string => typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');

// 읽지 못하는 주소면 null 이다.
export function pathOf(url: string) {
  if (!SCHEME.test(url)) return url.split(/[?#]/)[0];
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

export const screenRoutes = (map: AddressMap) => map.screens.filter((s) => readableRoute(s.path)).map((s) => ({ id: s.id, pattern: routePattern(s.path) }));

export function screenFinder(map: AddressMap) {
  const routes = screenRoutes(map);
  return (url: string) => {
    const address = pathOf(url);
    return (address !== null && routes.find((r) => r.pattern.test(address))?.id) || null;
  };
}

const gluedPattern = (s: string) => new RegExp(`^${s.split(GLUED_UNKNOWN).map(escapeText).join('.*')}$`);

export function callFinder(map: Partial<AddressMap>) {
  const variables = (e: CallRoute) => e.segments.filter((s) => s === '*').length;
  const glued = (e: CallRoute) => e.segments.filter((s) => s instanceof RegExp).length;
  const direct = (map.screens ?? []).flatMap((s) => s.apiCalls ?? []).filter((c) => c.direct);
  const sent = [...Object.values(map.apiFunctions ?? {}), ...direct].flatMap((fn) => fn.endpoints ?? []);
  const endpoints = [...new Map(sent.map((e) => [`${e.callId}\n${e.method}\n${e.url}`, e])).values()]
    .filter((e) => e.callId)
    .map((e) => ({ id: e.callId, method: e.method, segments: writtenSegments(e.url!).map((s) => (s.includes(GLUED_UNKNOWN) ? gluedPattern(s) : s)) }))
    .sort((a, b) => variables(a) - variables(b) || glued(a) - glued(b));
  return (method: string, url: string) => {
    const segments = pathOf(url)?.split('/').filter(Boolean);
    if (!segments) return null;
    const fits = (e: CallRoute) => e.method === method && e.segments.length === segments.length && e.segments.every((s, i) => s === '*' || (s instanceof RegExp ? s.test(segments[i]) : s === segments[i]));
    return endpoints.find(fits)?.id ?? null;
  };
}
