import { UNKNOWN } from './client.mjs';
import { routePattern } from './path-values.ts';
import { toSegments } from './server.ts';

interface MapScreen {
  id: string;
  path: string;
}

interface MapEndpoint {
  callId?: string;
  method: string;
  url: string;
}

interface AddressMap {
  screens: MapScreen[];
  apiFunctions?: Record<string, { endpoints: MapEndpoint[] }>;
}

interface CallRoute {
  id: string | undefined;
  segments: string[];
  method: string;
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

// 읽지 못하는 주소면 null 이다.
export function pathOf(url: string) {
  if (!SCHEME.test(url)) return url.split(/[?#]/)[0];
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

export function screenFinder(map: AddressMap) {
  const routes = map.screens.filter((s) => !s.path.includes(UNKNOWN)).map((s) => ({ id: s.id, pattern: routePattern(s.path) }));
  return (url: string) => {
    const address = pathOf(url);
    return (address !== null && routes.find((r) => r.pattern.test(address))?.id) || null;
  };
}

// 맞는 호출이 없으면 null 이다. 여러 호출에 맞으면 변수 자리가 가장 적은 호출을 고른다. document/list 요청은 document/{0} 보다 document/list 에 가깝다.
export function callFinder(map: AddressMap) {
  const variables = (e: CallRoute) => e.segments.filter((s) => s === '*').length;
  const endpoints = Object.values(map.apiFunctions ?? {})
    .flatMap((fn) => fn.endpoints)
    .filter((e) => e.callId)
    .map((e) => ({ id: e.callId, method: e.method, segments: toSegments(e.url) }))
    .sort((a, b) => variables(a) - variables(b));
  return (method: string, url: string) => {
    const segments = pathOf(url)?.split('/').filter(Boolean);
    if (!segments) return null;
    const fits = (e: CallRoute) => e.method === method && e.segments.length === segments.length && e.segments.every((s, i) => s === '*' || s === segments[i]);
    return endpoints.find(fits)?.id ?? null;
  };
}
