import { UNKNOWN } from './client.ts';
import { routePattern } from './path-values.ts';
import { toSegments } from './server.ts';

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
  segments: string[];
  method: string | null;
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
export function callFinder(map: Partial<AddressMap>) {
  const variables = (e: CallRoute) => e.segments.filter((s) => s === '*').length;
  const direct = (map.screens ?? []).flatMap((s) => s.apiCalls ?? []).filter((c) => c.direct);
  const sent = [...Object.values(map.apiFunctions ?? {}), ...direct].flatMap((fn) => fn.endpoints ?? []);
  const endpoints = [...new Map(sent.map((e) => [`${e.callId}\n${e.method}\n${e.url}`, e])).values()]
    .filter((e) => e.callId)
    .map((e) => ({ id: e.callId, method: e.method, segments: toSegments(e.url!) }))
    .sort((a, b) => variables(a) - variables(b));
  return (method: string, url: string) => {
    const segments = pathOf(url)?.split('/').filter(Boolean);
    if (!segments) return null;
    const fits = (e: CallRoute) => e.method === method && e.segments.length === segments.length && e.segments.every((s, i) => s === '*' || s === segments[i]);
    return endpoints.find(fits)?.id ?? null;
  };
}
