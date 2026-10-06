import fs from 'node:fs';
import path from 'node:path';
import { parse, parseExpression } from '@babel/parser';

const JS_PLUGINS = ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport'];
const TS_GRAMMARS = {
  '.ts': [...JS_PLUGINS.filter((p) => p !== 'jsx'), 'typescript'],
  '.tsx': [...JS_PLUGINS, 'typescript'],
};
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);
const NODE_META = new Set(['loc', 'extra', 'comments', 'errors', 'leadingComments', 'trailingComments', 'innerComments']);
export const SOURCE_SYNTAX_ERROR = 'DURU_SOURCE_SYNTAX_ERROR';

const TS_FRAGMENT = { sourceType: 'module', allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true, allowNewTargetOutsideFunction: true };

const isTypeScript = (file) => Object.hasOwn(TS_GRAMMARS, path.extname(file));
const pluginsOf = (file) => TS_GRAMMARS[path.extname(file)] ?? JS_PLUGINS;
const fragmentOptions = (file) => ({ plugins: pluginsOf(file), ...(isTypeScript(file) && TS_FRAGMENT) });

function eachChild(node, visit) {
  for (const [key, value] of Object.entries(node)) {
    if (NODE_META.has(key)) continue;
    if (Array.isArray(value)) value.forEach((v, i) => typeof v?.type === 'string' && visit(v, (next) => (value[i] = next)));
    else if (typeof value?.type === 'string') visit(value, (next) => (node[key] = next));
  }
}

// 안쪽 값이 감싼 식의 위치를 이어받아야, 위치로 잘라 낸 조건식에 타입 문법이 소스에 적힌 대로 남는다.
function unwrapped(node) {
  let inner = node;
  while (WRAPPERS.has(inner.type)) inner = inner.expression;
  if (inner !== node) {
    inner.start = node.start;
    inner.end = node.end;
    inner.loc = { ...inner.loc, start: node.loc.start, end: node.loc.end };
    if (node.extra?.parenthesized) inner.extra = { ...inner.extra, parenthesized: true, parenStart: node.extra.parenStart };
  }
  eachChild(inner, (child, replace) => replace(unwrapped(child)));
  return inner;
}

const isTypeOnly = (node, kind) => node[kind] === 'type' || (node.specifiers?.length > 0 && node.specifiers.every((s) => s[kind] === 'type'));

function withoutTypeImports(program) {
  program.body = program.body.filter((node) => {
    const kind = node.type === 'ImportDeclaration' ? 'importKind' : node.type.startsWith('Export') && node.source ? 'exportKind' : null;
    if (!kind) return true;
    if (isTypeOnly(node, kind)) return false;
    if (node.specifiers) node.specifiers = node.specifiers.filter((s) => s[kind] !== 'type');
    return true;
  });
}

function syntaxError(file, err) {
  if (!err.loc) return err;
  const detail = `${err.loc.line}:${err.loc.column + 1}: ${err.message.replace(/ \(\d+:\d+\)$/, '')}`;
  return Object.assign(new Error(`${file}:${detail}`, { cause: err }), { code: SOURCE_SYNTAX_ERROR, detail });
}

export function parseSource(file) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(src, { sourceType: 'module', plugins: pluginsOf(file), errorRecovery: true });
  } catch (err) {
    throw syntaxError(file, err);
  }
  if (!isTypeScript(file)) return { src, ast };
  withoutTypeImports(ast.program);
  return { src, ast: unwrapped(ast) };
}

const innermost = (node) => (WRAPPERS.has(node.type) ? innermost(node.expression) : node);
const isReference = (node) => node.type === 'Identifier' || node.type === 'ThisExpression' || (node.type === 'MemberExpression' && isReference(node.object));

// (x as T).y 의 괄호까지 지워야 x.y 모양을 찾는 정규식에 걸린다.
function parenCuts(node, text, cuts) {
  if (!node.extra?.parenthesized || !isReference(innermost(node))) return;
  const open = node.extra.parenStart;
  const close = text.indexOf(')', node.end);
  if (close < 0 || text.slice(open + 1, node.start).trim() || text.slice(node.end, close).trim()) return;
  cuts.push([open, open + 1], [close, close + 1]);
}

function wrapperCuts(node, text) {
  if (node.type === 'TSNonNullExpression') return [[node.end - 1, node.end]];
  const inner = node.expression;
  if (node.type === 'TSTypeAssertion') return [[node.start, inner.extra?.parenthesized ? inner.extra.parenStart : inner.start]];
  const keyword = node.type === 'TSAsExpression' ? 'as' : 'satisfies';
  const before = text.slice(0, node.typeAnnotation.start).trimEnd();
  return before.endsWith(keyword) ? [[before.slice(0, -keyword.length).trimEnd().length, node.end]] : [];
}

function typeCuts(node, text, cuts) {
  if (!WRAPPERS.has(node.type)) return eachChild(node, (child) => typeCuts(child, text, cuts));
  parenCuts(node, text, cuts);
  cuts.push(...wrapperCuts(node, text));
  typeCuts(node.expression, text, cuts);
}

export function plainText(text, file) {
  if (!isTypeScript(file)) return text;
  let node;
  try {
    node = parseExpression(text, fragmentOptions(file));
  } catch {
    return text;
  }
  const cuts = [];
  typeCuts(node, text, cuts);
  // 지운 자리에 빈칸을 두어야 typeof<T>x 나 x!in y 에서 앞뒤 낱말이 붙지 않는다.
  let out = text;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0])) out = `${out.slice(0, start)} ${out.slice(end)}`;
  return out;
}

// node 의 위치는 받은 문자열이 아니라 함께 돌려주는 text 를 가리킨다.
export function parseFragment(text, file) {
  const plain = plainText(text, file);
  const node = parseExpression(plain, fragmentOptions(file));
  return { node: isTypeScript(file) ? unwrapped(node) : node, text: plain };
}
