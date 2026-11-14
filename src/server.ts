import fs from 'node:fs';
import { OTHER_SITE } from './sent-address.ts';

export interface ServerEndpoint {
  label: string;
  method: string;
  path: string;
  segments: string[];
}

// not-written 은 보내는 곳에 주소 글자가 없는 것이고, unknown-piece 는 값을 모르는 조각이 주소 앞이나 글자 사이에 들어간 것이다.
export type UnresolvedReason = 'not-written' | 'imported-piece' | 'unknown-piece' | 'other-host' | 'no-path';

export type EndpointMatch =
  | { status: 'unresolved'; reason: UnresolvedReason }
  | { status: 'unchecked' | 'none' }
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

export const GLUED_UNKNOWN = '\0';

// {?} 의 물음표에서 쿼리로 잘리지 않게 그 자리를 먼저 감춰 둔다.
export function writtenSegments(p: string): string[] {
  return p
    .replaceAll('{?}', GLUED_UNKNOWN)
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .map((s) => (/^\{.*\}$/.test(s) || !s.replaceAll(GLUED_UNKNOWN, '') ? '*' : s));
}

export const toSegments = (p: string) => writtenSegments(p).map((s) => (s.includes(GLUED_UNKNOWN) ? '*' : s));

// written 은 writtenSegments 의 한 칸이고, 값을 모르는 조각이 붙은 자리에는 무엇이든 들어갈 수 있다.
export function gluedFits(written: string, actual: string) {
  const [first, ...rest] = written.split(GLUED_UNKNOWN);
  const last = rest.pop() ?? '';
  if (!actual.startsWith(first)) return false;
  let at = first.length;
  for (const piece of rest) {
    const found = actual.indexOf(piece, at);
    if (found < 0) return false;
    at = found + piece.length;
  }
  return actual.length - last.length >= at && actual.endsWith(last);
}

function segmentFits(server: string, call: string) {
  if (server === '*' || call === '*') return true;
  return call.includes(GLUED_UNKNOWN) ? gluedFits(call, server) : server === call;
}

function sameShape(server: string[], call: string[]) {
  return server.length === call.length && server.every((s, i) => segmentFits(s, call[i]));
}

export function clientPath(url: string, apiPathPrefix: string) {
  const p = url.startsWith(apiPathPrefix) ? url.slice(apiPathPrefix.length) : url;
  return p.startsWith('/') ? p : '/' + p;
}

// document/{0} 은 document/list 보다 document/{documentId} 에 가깝고, document/list{?} 는 그 반대다.
function closestPath(entries: ServerEndpoint[], segs: string[]) {
  const score = (e: ServerEndpoint) => e.segments.filter((s, i) => (s === '*') === (segs[i] === '*')).length;
  const best = Math.max(...entries.map(score));
  return entries.filter((e) => score(e) === best).map((e) => e.path).sort()[0];
}

export function matchEndpoint(server: ServerEndpoint[], method: string | null | undefined, url: unknown, apiPathPrefix: string): EndpointMatch {
  if (typeof url !== 'string') return { status: 'unresolved', reason: 'not-written' };
  if (OTHER_SITE.test(url)) return { status: 'unresolved', reason: 'other-host' };
  const written = writtenSegments(clientPath(url, apiPathPrefix));
  const segs = written.map((s) => (s.includes(GLUED_UNKNOWN) ? '*' : s));
  if (segs.length === 0) return { status: 'unresolved', reason: 'no-path' };
  if (segs[0] === '*') return { status: 'unresolved', reason: segs.every((s) => s === '*') ? 'not-written' : 'unknown-piece' };
  if (server.length === 0) return { status: 'unchecked' };
  const byPath = server.filter((e) => sameShape(e.segments, written));
  if (byPath.length === 0) return { status: 'none' };
  const byMethod = method ? byPath.filter((e) => e.method === method) : byPath;
  if (byMethod.length === 0) return { status: 'method-mismatch', candidates: byPath.map((e) => `${e.label} ${e.method} ${e.path}`), path: closestPath(byPath, written) };
  const p = closestPath(byMethod, written);
  const shape = toSegments(p).join('/');
  return { status: 'match', labels: [...new Set(byMethod.filter((e) => e.segments.join('/') === shape).map((e) => e.label))], path: p };
}
