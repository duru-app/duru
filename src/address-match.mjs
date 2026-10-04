import { UNKNOWN } from './client.mjs';
import { routePattern } from './path-values.mjs';
import { toSegments } from './server.mjs';

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

function pathOf(url) {
  if (!SCHEME.test(url)) return url.split(/[?#]/)[0];
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// 돌려주는 함수는 주소에서 쿼리와 해시를 떼고, 라우트 경로가 맞는 첫 화면의 ID 를 돌려준다. 맞는 화면이 없으면 null 이다.
export function screenFinder(map) {
  const routes = map.screens.filter((s) => !s.path.includes(UNKNOWN)).map((s) => ({ id: s.id, pattern: routePattern(s.path) }));
  return (url) => {
    const address = pathOf(url);
    return (address !== null && routes.find((r) => r.pattern.test(address))?.id) || null;
  };
}

// 맞는 호출이 없으면 null 이다. 여러 호출에 맞으면 변수 자리가 가장 적은 호출을 고른다. document/list 요청은 document/{0} 보다 document/list 에 가깝다.
export function callFinder(map) {
  const variables = (e) => e.segments.filter((s) => s === '*').length;
  const endpoints = Object.values(map.apiFunctions ?? {})
    .flatMap((fn) => fn.endpoints)
    .filter((e) => e.callId)
    .map((e) => ({ id: e.callId, method: e.method, segments: toSegments(e.url) }))
    .sort((a, b) => variables(a) - variables(b));
  return (method, url) => {
    const segments = pathOf(url)?.split('/').filter(Boolean);
    if (!segments) return null;
    const fits = (e) => e.method === method && e.segments.length === segments.length && e.segments.every((s, i) => s === '*' || s === segments[i]);
    return endpoints.find(fits)?.id ?? null;
  };
}
