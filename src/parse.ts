import fs from 'node:fs';
import path from 'node:path';
import { parse, parseExpression } from '@babel/parser';
import type { ParserOptions, ParserPlugin } from '@babel/parser';
import type { Node } from '@babel/types';

export type NodeOf<T extends Node['type']> = Extract<Node, { type: T }>;
type Wrapper = NodeOf<'TSAsExpression' | 'TSSatisfiesExpression' | 'TSNonNullExpression' | 'TSTypeAssertion'>;

interface Position {
  line: number;
  column: number;
}

interface ModuleLine {
  type: string;
  source?: unknown;
  importKind?: unknown;
  exportKind?: unknown;
  specifiers?: { type: string; importKind?: unknown; exportKind?: unknown }[] | null;
}

type Cut = [number, number];

interface SyntaxFailure extends Error {
  loc?: Position;
}

const JS_PLUGINS: ParserPlugin[] = ['jsx', 'decorators', 'decoratorAutoAccessors', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport'];
const TS_GRAMMARS: Record<string, ParserPlugin[]> = {
  '.ts': [...JS_PLUGINS.filter((p) => p !== 'jsx'), 'typescript'],
  '.tsx': [...JS_PLUGINS, 'typescript'],
};
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion']);
const isWrapper = (node: Node): node is Wrapper => WRAPPERS.has(node.type);
const NODE_META = new Set(['loc', 'extra', 'comments', 'errors', 'leadingComments', 'trailingComments', 'innerComments']);
export const SOURCE_SYNTAX_ERROR = 'DURU_SOURCE_SYNTAX_ERROR';

const TS_FRAGMENT: ParserOptions = { sourceType: 'module', allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true, allowNewTargetOutsideFunction: true };

const isTypeScript = (file: string) => Object.hasOwn(TS_GRAMMARS, path.extname(file));
const pluginsOf = (file: string) => TS_GRAMMARS[path.extname(file)] ?? JS_PLUGINS;
const fragmentOptions = (file: string): ParserOptions => ({ plugins: pluginsOf(file), ...(isTypeScript(file) && TS_FRAGMENT) });

function eachChild(node: Node, visit: (child: Node, replace: (next: Node) => void) => void) {
  for (const [key, value] of Object.entries(node)) {
    if (NODE_META.has(key)) continue;
    if (Array.isArray(value)) value.forEach((v, i) => typeof v?.type === 'string' && visit(v, (next) => (value[i] = next)));
    else if (typeof value?.type === 'string') visit(value, (next) => ((node as unknown as Record<string, unknown>)[key] = next));
  }
}

export function firstDecorator(root: Node): Position | null {
  let first = null as Node | null;
  const visit = (node: Node) => {
    if (node.type === 'Decorator' && (!first || node.start! < first.start!)) first = node;
    eachChild(node, visit);
  };
  visit(root);
  return first?.loc!.start ?? null;
}

// 안쪽 값이 감싼 식의 위치를 이어받아야, 위치로 잘라 낸 조건식에 타입 문법이 소스에 적힌 대로 남는다.
function unwrapped<T extends Node>(root: T): T {
  const node: Node = root;
  let inner = node;
  while (isWrapper(inner)) inner = inner.expression;
  if (inner !== node) {
    inner.start = node.start;
    inner.end = node.end;
    inner.loc = { ...inner.loc!, start: node.loc!.start, end: node.loc!.end };
    if (node.extra?.parenthesized) inner.extra = { ...inner.extra, parenthesized: true, parenStart: node.extra.parenStart };
  }
  eachChild(inner, (child, replace) => replace(unwrapped(child)));
  return inner as T;
}

const kindOf = (node: ModuleLine): 'importKind' | 'exportKind' | null => (node.type === 'ImportDeclaration' ? 'importKind' : node.type.startsWith('Export') && node.source ? 'exportKind' : null);

export const importsModule = (node: ModuleLine) => Boolean(kindOf(node));

export function isTypeOnlyLine(node: ModuleLine) {
  const kind = kindOf(node);
  return Boolean(kind) && (node[kind!] === 'type' || (node.specifiers?.length! > 0 && node.specifiers!.every((s) => s[kind!] === 'type')));
}

function withoutTypeImports(program: { body: ModuleLine[] }) {
  program.body = program.body.filter((node) => {
    const kind = kindOf(node);
    if (!kind) return true;
    if (isTypeOnlyLine(node)) return false;
    if (node.specifiers) node.specifiers = node.specifiers.filter((s) => s[kind] !== 'type');
    return true;
  });
}

function syntaxError(file: string, err: SyntaxFailure) {
  if (!err.loc) return err;
  const detail = `${err.loc.line}:${err.loc.column + 1}: ${err.message.replace(/ \(\d+:\d+\)$/, '')}`;
  return Object.assign(new Error(`${file}:${detail}`, { cause: err }), { code: SOURCE_SYNTAX_ERROR, detail });
}

export function parseSource(file: string, { asWritten = false }: { asWritten?: boolean } = {}) {
  const src = fs.readFileSync(file, 'utf8');
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(src, { sourceType: 'module', plugins: pluginsOf(file), errorRecovery: true });
  } catch (err) {
    throw syntaxError(file, err as SyntaxFailure);
  }
  if (!isTypeScript(file) || asWritten) return { src, ast };
  withoutTypeImports(ast.program);
  return { src, ast: unwrapped(ast) };
}

const innermost = (node: Node): Node => (isWrapper(node) ? innermost(node.expression) : node);
const isReference = (node: Node): boolean => node.type === 'Identifier' || node.type === 'ThisExpression' || (node.type === 'MemberExpression' && isReference(node.object));

// (x as T).y 의 괄호까지 지워야 x.y 모양을 찾는 정규식에 걸린다.
function parenCuts(node: Node, text: string, cuts: Cut[]) {
  if (!node.extra?.parenthesized || !isReference(innermost(node))) return;
  const open = node.extra!.parenStart as number;
  const close = text.indexOf(')', node.end!);
  if (close < 0 || text.slice(open + 1, node.start!).trim() || text.slice(node.end!, close).trim()) return;
  cuts.push([open, open + 1], [close, close + 1]);
}

function wrapperCuts(node: Wrapper, text: string): Cut[] {
  if (node.type === 'TSNonNullExpression') return [[node.end! - 1, node.end!]];
  const inner = node.expression;
  if (node.type === 'TSTypeAssertion') return [[node.start!, inner.extra?.parenthesized ? inner.extra.parenStart as number : inner.start!]];
  const keyword = node.type === 'TSAsExpression' ? 'as' : 'satisfies';
  const before = text.slice(0, node.typeAnnotation.start!).trimEnd();
  return before.endsWith(keyword) ? [[before.slice(0, -keyword.length).trimEnd().length, node.end!]] : [];
}

function typeCuts(node: Node, text: string, cuts: Cut[]) {
  if (!isWrapper(node)) return eachChild(node, (child) => typeCuts(child, text, cuts));
  parenCuts(node, text, cuts);
  cuts.push(...wrapperCuts(node, text));
  typeCuts(node.expression, text, cuts);
}

export function plainText(text: string, file: string) {
  if (!isTypeScript(file)) return text;
  let node: ReturnType<typeof parseExpression>;
  try {
    node = parseExpression(text, fragmentOptions(file));
  } catch {
    return text;
  }
  const cuts: Cut[] = [];
  typeCuts(node, text, cuts);
  // 지운 자리에 빈칸을 두어야 typeof<T>x 나 x!in y 에서 앞뒤 낱말이 붙지 않는다.
  let out = text;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0])) out = `${out.slice(0, start)} ${out.slice(end)}`;
  return out;
}

// node 의 위치는 받은 문자열이 아니라 함께 돌려주는 text 를 가리킨다.
export function parseFragment(text: string, file: string) {
  const plain = plainText(text, file);
  const node = parseExpression(plain, fragmentOptions(file));
  return { node: isTypeScript(file) ? unwrapped(node) : node, text: plain };
}
