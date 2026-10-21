import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DURU_ROOT = path.join(import.meta.dirname, '..');
export const UNKNOWN_COMMIT = 'unknown';

export interface CodeState {
  commit: string;
  uncommitted?: boolean;
  duruVersion: string;
  duruCommit?: string;
}

function git(cwd: string, args: string[]) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

const realPath = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// duru 가 다른 저장소 안에 설치되어 있으면 그 저장소의 커밋은 duru 의 것이 아니다.
function duruCommit() {
  const top = git(DURU_ROOT, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top || realPath(top) !== realPath(DURU_ROOT)) return null;
  return git(DURU_ROOT, ['rev-parse', 'HEAD'])?.trim() || null;
}

const duruVersion = () => JSON.parse(fs.readFileSync(path.join(DURU_ROOT, 'package.json'), 'utf8')).version as string;

export function codeState(srcRoot: string): CodeState {
  const commit = fs.existsSync(srcRoot) ? git(srcRoot, ['rev-parse', 'HEAD'])?.trim() : null;
  const status = commit ? git(srcRoot, ['status', '--porcelain', '--', '.']) : null;
  const own = duruCommit();
  return {
    commit: commit || UNKNOWN_COMMIT,
    ...(status !== null && { uncommitted: status.trim() !== '' }),
    duruVersion: duruVersion(),
    ...(own && { duruCommit: own }),
  };
}

const slashed = (p: string) => p.replaceAll('\\', '/');

// 줄 끝을 \n 으로 맞춰야 git 의 autocrlf 로 줄 끝만 다르게 받은 컴퓨터에서도 같은 코드가 같은 해시가 된다.
function fileDigest(file: string) {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return 'unreadable';
  }
  const text = bytes.includes(13) ? Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : bytes;
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function codeHasher(root: string) {
  const digests = new Map<string, string>();
  const digestOf = (file: string) => {
    if (!digests.has(file)) digests.set(file, fileDigest(path.join(root, file)));
    return digests.get(file)!;
  };
  return (files: Iterable<string | null | undefined>) => {
    const hash = crypto.createHash('sha256');
    const named = [...new Set([...files].filter((f): f is string => typeof f === 'string' && f !== '').map(slashed))].sort();
    for (const file of named) hash.update(`${file}\0${digestOf(file)}\n`);
    return hash.digest('hex');
  };
}

interface HashedNodes {
  screens: { id: string; codeHash?: string }[];
  calls?: { id: string; codeHash?: string }[];
}

export const nodeHashes = (map: HashedNodes) => new Map<string, string>([...map.screens, ...(map.calls ?? [])].filter((n) => typeof n.codeHash === 'string').map((n) => [n.id, n.codeHash!]));

export const differs = (saved: string | undefined, now: string | undefined) => typeof saved === 'string' && typeof now === 'string' && saved !== now;
