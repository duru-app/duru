import fs from 'node:fs';

export interface ServerEndpoint {
  label: string;
  method: string;
  path: string;
  segments: string[];
}

export type EndpointMatch =
  | { status: 'unresolved' | 'unchecked' | 'none' }
  | { status: 'method-mismatch'; candidates: string[]; path: string }
  | { status: 'match'; labels: string[]; path: string };

export const SERVER_NOT_COMPARED = 'Server comparison skipped: the server API list is absent or has no endpoint lines';

// 한 줄에 「라벨<TAB>METHOD<TAB>경로」. 경로 변수 {id} 는 한 칸짜리 자리로 본다.
export function loadServerEndpoints(file: string): ServerEndpoint[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [label, method, p] = l.split('\t');
      return { label, method, path: p, segments: toSegments(p) };
    });
}

// 변수 자리 {?} 의 물음표에서 쿼리로 잘리지 않게, 그 자리를 먼저 감춰 둔다.
export function toSegments(p: string): string[] {
  return p
    .replaceAll('{?}', '\0')
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .map((s) => (/^\{.*\}$/.test(s) || s.includes('\0') ? '*' : s));
}

function sameShape(a: string[], b: string[]) {
  return a.length === b.length && a.every((s, i) => s === '*' || b[i] === '*' || s === b[i]);
}

export function clientPath(url: string, apiPathPrefix: string) {
  const p = url.startsWith(apiPathPrefix) ? url.slice(apiPathPrefix.length) : url;
  return p.startsWith('/') ? p : '/' + p;
}

// document/{0} 은 document/list 보다 document/{documentId} 에 가깝다.
function closestPath(entries: ServerEndpoint[], segs: string[]) {
  const score = (e: ServerEndpoint) => e.segments.filter((s, i) => (s === '*') === (segs[i] === '*')).length;
  const best = Math.max(...entries.map(score));
  return entries.filter((e) => score(e) === best).map((e) => e.path).sort()[0];
}

export function matchEndpoint(server: ServerEndpoint[], method: string | null | undefined, url: unknown, apiPathPrefix: string): EndpointMatch {
  if (typeof url !== 'string') return { status: 'unresolved' };
  const segs = toSegments(clientPath(url, apiPathPrefix));
  if (segs.length === 0 || segs[0] === '*') return { status: 'unresolved' };
  if (server.length === 0) return { status: 'unchecked' };
  const byPath = server.filter((e) => sameShape(e.segments, segs));
  if (byPath.length === 0) return { status: 'none' };
  const byMethod = method ? byPath.filter((e) => e.method === method) : byPath;
  if (byMethod.length === 0) return { status: 'method-mismatch', candidates: byPath.map((e) => `${e.label} ${e.method} ${e.path}`), path: closestPath(byPath, segs) };
  const p = closestPath(byMethod, segs);
  const shape = toSegments(p).join('/');
  return { status: 'match', labels: [...new Set(byMethod.filter((e) => e.segments.join('/') === shape).map((e) => e.label))], path: p };
}
