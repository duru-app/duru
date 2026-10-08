import fs from 'node:fs';
import path from 'node:path';

export interface AliasRule {
  name: string;
  targets: string[];
}

interface AliasMatch {
  rule: AliasRule;
  captured: string;
}

interface Resolution {
  file: string | null;
  missedAlias?: boolean;
}

interface AliasTargetResult {
  file: string | null;
  outside?: boolean;
  quiet?: boolean;
}

export interface ImportResolver {
  resolve: (fromFile: string, spec: string) => string | null;
  unresolved: () => { spec: string; files: number }[];
}

const EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];

function firstFile(base: string): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export const isInside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

const DECLARATIONS = ['.d.ts', '/index.d.ts'];

// 정확히 같은 이름이 먼저고, 그다음이 `*` 앞부분이 가장 긴 규칙이다. 맞는 규칙이 없으면 null.
function matchRule(aliases: AliasRule[], spec: string): AliasMatch | null {
  let best: (AliasMatch & { prefix: string }) | null = null;
  for (const rule of aliases) {
    if (rule.name === spec) return { rule, captured: '' };
    const star = rule.name.indexOf('*');
    if (star === -1) continue;
    const prefix = rule.name.slice(0, star);
    const suffix = rule.name.slice(star + 1);
    const fits = spec.length >= prefix.length + suffix.length && spec.startsWith(prefix) && spec.endsWith(suffix);
    if (fits && (!best || prefix.length > best.prefix.length)) best = { rule, prefix, captured: spec.slice(prefix.length, spec.length - suffix.length) };
  }
  return best;
}

function underSrcRoot(srcRoot: string, target: string) {
  if (isInside(srcRoot, target) || !fs.existsSync(srcRoot)) return target;
  let dir = target;
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const real = path.join(fs.realpathSync(dir), path.relative(dir, target));
  const realRoot = fs.realpathSync(srcRoot);
  return isInside(realRoot, real) ? path.join(srcRoot, path.relative(realRoot, real)) : target;
}

const hasDeclaration = (base: string) => DECLARATIONS.some((ext) => fs.existsSync(base + ext));
const holdsSomething = (base: string) => fs.existsSync(base) || Boolean(firstFile(base)) || hasDeclaration(base);

function aliasTarget(srcRoot: string, { rule, captured }: AliasMatch): AliasTargetResult {
  let quiet = false;
  for (const target of rule.targets) {
    const base = underSrcRoot(srcRoot, target.replace('*', () => captured));
    if (!isInside(srcRoot, base)) {
      if (holdsSomething(base)) return { file: null, outside: true };
      quiet = true;
      continue;
    }
    const file = firstFile(base);
    if (file) return { file };
    if (hasDeclaration(base)) quiet = true;
  }
  return { file: null, quiet };
}

function resolveDetailed(srcRoot: string, fromFile: string, spec: string, aliases: AliasRule[] | null): Resolution {
  if (spec.startsWith('.')) return { file: firstFile(path.resolve(path.dirname(fromFile), spec)) };
  const matched = aliases && matchRule(aliases, spec);
  const aliased: AliasTargetResult = matched ? aliasTarget(srcRoot, matched) : { file: null, quiet: true };
  if (aliased.file || aliased.outside) return { file: aliased.file };
  const first = spec.split('/')[0];
  const file = first.startsWith('@') || !fs.existsSync(path.join(srcRoot, first)) ? null : firstFile(path.join(srcRoot, spec));
  return { file, missedAlias: !aliased.quiet && !file };
}

// 상대 경로, tsconfig 의 paths 별칭, srcRoot 바로 아래 폴더 이름으로 시작하는 경로 순으로 찾는다. 외부 패키지와 srcRoot 밖의 파일은 null.
export function resolveImport(srcRoot: string, fromFile: string, spec: string, aliases: AliasRule[] | null = null): string | null {
  return resolveDetailed(srcRoot, fromFile, spec, aliases).file;
}

export function importResolver({ srcRoot, aliases = null }: { srcRoot: string; aliases?: AliasRule[] | null }): ImportResolver {
  const missed = new Map<string, Set<string>>();
  const resolve = (fromFile: string, spec: string) => {
    const { file, missedAlias } = resolveDetailed(srcRoot, fromFile, spec, aliases);
    if (missedAlias) missed.set(spec, (missed.get(spec) ?? new Set()).add(fromFile));
    return file;
  };
  const unresolved = () => [...missed].sort(([a], [b]) => (a < b ? -1 : 1)).map(([spec, files]) => ({ spec, files: files.size }));
  return { resolve, unresolved };
}
