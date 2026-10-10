export const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
export const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
export const WITH_DATA = new Set(['post', 'put', 'patch']);

export const withBase = (url: string | null, base: unknown) => (typeof base !== 'string' || url === null || SCHEME.test(url) ? url : url ? `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}` : base);

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
