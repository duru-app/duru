import fs from 'node:fs';
import path from 'node:path';
import _traverse from '@babel/traverse';
import { parseSource } from './parse.mjs';
import { resolveImport } from './resolve.mjs';

const traverse = _traverse.default ?? _traverse;
// 이보다 많은 화면에 딸린 소스 파일은 여러 화면이 함께 쓰는 파일로 보고 근거로 치지 않는다.
const MAX_SCREENS_PER_FILE = 3;
// vi.mock(import('./X')) 처럼 가짜로 바꿔 끼우려고 적은 파일은 불러오는 것으로 치지 않는다.
const MOCKERS = new Set(['vi', 'vitest', 'jest']);
const MOCKS = new Set(['mock', 'doMock', 'unmock', 'doUnmock']);

const isFile = (file) => fs.existsSync(file) && fs.statSync(file).isFile();

const isAbsolute = (file) => path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file);

function findUnder(srcRoot, realRoot, file) {
  if (path.isAbsolute(file) && isFile(file)) {
    const rel = path.relative(realRoot, fs.realpathSync(file));
    const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    return outside ? null : path.join(srcRoot, rel);
  }
  const parts = path.posix.normalize(file.replace(/\\/g, '/')).split('/').filter((part) => part && part !== '.');
  if (parts.includes('..')) return null;
  for (let i = 0; i < parts.length; i += 1) {
    const nameOnly = i === parts.length - 1;
    const anchored = i > 0 ? parts[i - 1] === path.basename(srcRoot) : !isAbsolute(file);
    // 다른 폴더에 있는 같은 이름의 파일을 잘못 고르지 않으려는 것이다.
    if (nameOnly && !anchored) break;
    const candidate = path.join(srcRoot, ...parts.slice(i));
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function importsOf(srcRoot, file, aliases) {
  const { ast } = parseSource(file);
  const found = new Set();
  const add = (spec) => {
    const resolved = typeof spec === 'string' ? resolveImport(srcRoot, file, spec, aliases) : null;
    if (resolved) found.add(resolved);
  };
  traverse(ast, {
    ImportDeclaration(p) {
      add(p.node.source.value);
    },
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (callee.type !== 'Import' && !(callee.type === 'Identifier' && callee.name === 'require')) return;
      const outer = p.parentPath.isCallExpression() ? p.parentPath.node.callee : null;
      if (outer?.type === 'MemberExpression' && MOCKERS.has(outer.object.name) && MOCKS.has(outer.property.name)) return;
      add(args[0]?.value);
    },
  });
  return [...found];
}

// 돌려주는 함수는 테스트 파일 하나를 받아 { file: 소스 폴더 기준 경로, screens: 화면 ID → 근거가 된 소스 파일들 } 을, 읽지 못하면 { reason } 을 돌려준다.
export function importLinker(srcRoot, map, aliases = null) {
  const realRoot = fs.existsSync(srcRoot) ? fs.realpathSync(srcRoot) : srcRoot;
  const screensOf = new Map();
  for (const screen of map.screens) {
    for (const file of screen.sourceFiles ?? []) screensOf.set(file, (screensOf.get(file) ?? new Set()).add(screen.id));
  }

  function link(testFile) {
    const file = testFile ? findUnder(srcRoot, realRoot, testFile) : null;
    if (!file) return { reason: '테스트 파일을 소스 폴더에서 찾지 못했습니다' };
    let imports;
    try {
      imports = importsOf(srcRoot, file, aliases);
    } catch (err) {
      return { reason: `테스트 파일을 읽지 못했습니다: ${err.detail ?? err.message}` };
    }
    const screens = new Map();
    for (const imported of imports.map((f) => path.relative(srcRoot, f)).sort()) {
      const ids = screensOf.get(imported) ?? new Set();
      if (ids.size > MAX_SCREENS_PER_FILE) continue;
      for (const id of ids) screens.set(id, [...(screens.get(id) ?? []), imported]);
    }
    return { file: path.relative(srcRoot, file), screens };
  }

  const results = new Map();
  return (testFile) => {
    if (!results.has(testFile)) results.set(testFile, link(testFile));
    return results.get(testFile);
  };
}
