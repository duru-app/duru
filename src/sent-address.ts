const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
export const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
export const WITH_DATA = new Set(['post', 'put', 'patch']);

// 브라우저처럼 앞뒤의 공백과 제어 문자를 떼고 탭과 줄바꿈을 지운다.
export const cleanAddress = (url: string) => url.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');

export const withBase = (given: string | null, base: unknown) => {
  const url = given === null ? null : cleanAddress(given);
  return typeof base !== 'string' || url === null || SCHEME.test(url) ? url : url ? `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}` : base;
};

// 현재 페이지의 주소는 알 수 없어 그 자리에 두는 가짜 값
export const PAGE_ORIGIN = 'http://localhost';
export const OTHER_SITE = /^(?:[a-z][a-z\d+.-]*:)?\/\//i;

// 현재 페이지나 app.server 가 아닌 호스트로 가는 주소면 null 을 돌려준다.
// unknown 은 주소 안에서 값을 모르는 자리에 들어 있는 문자열로, URL 로 읽는 동안 감춰 둔다.
export function pathOnSite(url: string, server: string | null, unknown?: string) {
  if (!OTHER_SITE.test(url)) return url;
  const hidden = '__duru_hidden__';
  const hide = (s: string) => (unknown ? s.replaceAll(unknown, hidden) : s);
  try {
    const u = new URL(hide(url.startsWith('//') ? `http:${url}` : url));
    if (u.origin !== PAGE_ORIGIN && (server === null || u.host !== new URL(server).host)) return null;
    const path = u.pathname + u.search;
    return unknown ? path.replaceAll(hidden, unknown) : path;
  } catch {
    return null;
  }
}

const NOT_SENT = /^(?:(?!https?:)[a-z][a-z\d+.-]*:|[#?])/i;
const TOKEN_KEY = /token$/i;

// blob: · mailto: 같은 다른 스킴과, 지금 페이지 안에서만 움직이는 # · ? 는 서버로 가지 않는다.
export const staysInBrowser = (url: string) => NOT_SENT.test(url);

export function sentAddress(url: string) {
  const [sent] = url.split('#');
  const query = sent.indexOf('?');
  if (query < 0) return sent;
  const kept = sent.slice(query + 1).split('&').filter((pair) => !TOKEN_KEY.test(pair.split('=')[0]));
  return sent.slice(0, query) + (kept.length ? `?${kept.join('&')}` : '');
}

// unknowns 는 값을 모르는 자리에 들어 있는 문자열이다.
export function placeUnknown(url: string, unknowns: string[]) {
  const path = url.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, '').split(/[?#]/)[0];
  if (unknowns.some((unknown) => path.split(unknown).slice(0, -1).some((before) => !before.endsWith('/')))) return true;
  return !/[^/]/.test(unknowns.reduce((rest, unknown) => rest.replaceAll(unknown, ''), path));
}
