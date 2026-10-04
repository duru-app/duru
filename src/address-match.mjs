import { UNKNOWN } from './client.mjs';
import { routePattern } from './path-values.mjs';

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
