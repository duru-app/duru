import fs from 'node:fs';
import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import type { CallExpression, ImportDeclaration, Node, Program } from '@babel/types';
import type { ParseResult } from '@babel/parser';
import { memberChain } from './client.ts';
import type { Origin } from './follow-names.ts';

const traverse = (_traverse.default ?? _traverse) as typeof _traverse.default;

export interface ActionType {
  key: string;
  name: string;
}

export interface Handler {
  file: string;
  span: [number, number];
}

export interface Watch {
  type: ActionType;
  handler: Handler;
}

interface Reading {
  parse: (file: string) => { ast: ParseResult };
  resolve: (from: string, spec: string) => string | null;
  declaration: (file: string | null | undefined, name: string) => Origin | null;
}

const EFFECT_PACKAGES = new Set(['redux-saga/effects', 'redux-saga', '@redux-saga/core/effects', '@redux-saga/core', 'typed-redux-saga', 'typed-redux-saga/macro']);
const MIDDLEWARE_PACKAGES = new Set(['redux-saga', '@redux-saga/core']);
// watch effect 마다 패턴과 saga 가 몇 번째 인자인지
const WATCHERS: Record<string, [number, number]> = { takeEvery: [0, 1], takeLatest: [0, 1], takeLeading: [0, 1], debounce: [1, 2], throttle: [1, 2] };
const LOOPS = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement']);
const SCRIPT = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /(^|[\\/])__(tests|mocks)__[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/;

function importOf(binding: Binding | undefined) {
  if (binding?.kind !== 'module') return null;
  const spec = binding.path.node;
  const source = (binding.path.parent as ImportDeclaration).source.value;
  if (spec.type === 'ImportNamespaceSpecifier') return { source, name: '*' };
  if (spec.type === 'ImportDefaultSpecifier') return { source, name: 'default' };
  if (spec.type !== 'ImportSpecifier') return null;
  const imported = spec.imported;
  return { source, name: imported.type === 'Identifier' ? imported.name : imported.value };
}

const effectOf = (callee: NodePath) => {
  if (!callee.isIdentifier()) return null;
  const from = importOf(callee.scope.getBinding(callee.node.name));
  return from && EFFECT_PACKAGES.has(from.source) && from.name !== '*' ? from.name : null;
};

const initOf = (binding: Binding | undefined) => (binding?.path.isVariableDeclarator() ? (binding.path.get('init') as NodePath) : null);

// 미들웨어를 만든 파일과 run 하는 파일이 다를 수 있어 `.run(` 이 있는 파일도 포함한다.
export function sagaFiles(srcRoot: string) {
  const found: string[] = [];
  let named = false;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && SCRIPT.test(e.name) && !e.name.endsWith('.d.ts') && !TEST_FILE.test(path.relative(srcRoot, full))) {
        const text = fs.readFileSync(full, 'utf8');
        named ||= text.includes('redux-saga');
        if (text.includes('redux-saga') || text.includes('.run(')) found.push(full);
      }
    }
  };
  walk(srcRoot);
  return named ? found.sort() : [];
}

export function sagaReader({ parse, resolve, declaration }: Reading) {
  const programs = new Map<string, NodePath<Program>>();
  const programOf = (file: string) => {
    if (!programs.has(file)) {
      traverse(parse(file).ast, {
        Program(p) {
          programs.set(file, p);
          p.stop();
        },
      });
    }
    return programs.get(file)!;
  };

  function declared(binding: Binding, file: string, members: string[]): [Origin, string[]] | null {
    const from = importOf(binding);
    if (!from) return binding.scope.path.isProgram() ? [{ file, name: binding.identifier.name }, members] : null;
    const target = resolve(file, from.source);
    if (from.name !== '*') {
      const found = declaration(target, from.name);
      return found && [found, members];
    }
    const found = members.length ? declaration(target, members[0]) : null;
    return found && [found, members.slice(1)];
  }

  function literal(value: string): ActionType {
    return { key: JSON.stringify(value), name: value };
  }

  // 액션 타입을 선언한 곳을 키로 삼는다. 같은 상수를 어느 파일에서 어떤 경로로 import 해도 같은 키가 된다.
  function typeOf(p: NodePath, file: string, seen = new Set<Node>()): ActionType | null {
    if (seen.has(p.node)) return null;
    seen.add(p.node);
    if (p.isStringLiteral()) return literal(p.node.value);
    if (p.isTemplateLiteral() && !p.node.expressions.length) return literal(p.node.quasis[0].value.cooked ?? '');
    const chain = p.isIdentifier() || p.isMemberExpression() ? memberChain(p.node) : null;
    if (!chain) return null;
    const [root, ...members] = chain;
    const binding = p.scope.getBinding(root);
    if (!binding) return null;
    if (binding.kind === 'module' || binding.scope.path.isProgram()) {
      const found = declared(binding, file, members);
      if (!found) return null;
      const [origin, rest] = found;
      if (!rest.length && origin.name !== 'default') {
        const init = initOf(programOf(origin.file).scope.getBinding(origin.name));
        if (init?.isStringLiteral()) return literal(init.node.value);
      }
      return { key: [`${origin.file}#${origin.name}`, ...rest].join('.'), name: [origin.name, ...rest].join('.') };
    }
    const init = binding.kind === 'const' && !members.length ? initOf(binding) : null;
    return init?.node ? typeOf(init, file, seen) : null;
  }

  function objectType(p: NodePath, file: string) {
    if (!p.isObjectExpression()) return null;
    const prop = p.get('properties').find((q) => q.isObjectProperty() && !q.node.computed && (q.node.key.type === 'Identifier' ? q.node.key.name : (q.node.key as { value?: unknown }).value) === 'type');
    return prop ? typeOf(prop.get('value') as NodePath, file) : null;
  }

  function returnedTypes(fn: NodePath, file: string) {
    if (!fn.isFunction()) return [];
    const body = fn.get('body') as NodePath;
    if (!body.isBlockStatement()) return [objectType(body, file)].filter((t) => t !== null);
    const found: ActionType[] = [];
    body.traverse({
      Function(inner) {
        inner.skip();
      },
      ReturnStatement(r) {
        const arg = r.get('argument');
        const t = arg.node ? objectType(arg as NodePath, file) : null;
        if (t) found.push(t);
      },
    });
    return found;
  }

  const creators = new Map<string, ActionType[]>();
  function creatorTypes({ file, name }: Origin) {
    const key = `${file}\0${name}`;
    if (creators.has(key)) return creators.get(key)!;
    creators.set(key, []);
    const program = programOf(file);
    let fn: NodePath | null = null;
    if (name === 'default') {
      const exp = program.get('body').find((s) => s.isExportDefaultDeclaration());
      fn = exp ? (exp.get('declaration') as NodePath) : null;
    } else {
      const binding = program.scope.getBinding(name);
      fn = binding?.path.isFunctionDeclaration() ? binding.path : initOf(binding);
    }
    const found = fn ? returnedTypes(fn, file) : [];
    creators.set(key, found);
    return found;
  }

  function creatorOf(callee: NodePath, file: string) {
    const chain = callee.isIdentifier() || callee.isMemberExpression() ? memberChain(callee.node) : null;
    if (!chain) return null;
    const binding = callee.scope.getBinding(chain[0]);
    if (!binding) return null;
    const found = declared(binding, file, chain.slice(1));
    return found && !found[1].length ? found[0] : null;
  }

  function dispatchedTypes(action: NodePath, file: string, seen = new Set<Node>()): ActionType[] {
    if (seen.has(action.node)) return [];
    seen.add(action.node);
    if (action.isObjectExpression()) return [objectType(action, file)].filter((t) => t !== null);
    if (action.isCallExpression()) {
      const creator = creatorOf(action.get('callee') as NodePath, file);
      return creator ? creatorTypes(creator) : [];
    }
    if (action.isIdentifier()) {
      const binding = action.scope.getBinding(action.node.name);
      const init = binding?.kind === 'const' ? initOf(binding) : null;
      return init?.node ? dispatchedTypes(init, file, seen) : [];
    }
    return [];
  }

  const isConnect = (callee: NodePath) => {
    if (!callee.isIdentifier()) return false;
    const from = importOf(callee.scope.getBinding(callee.node.name));
    return from?.source === 'react-redux' && from.name === 'connect';
  };

  function dispatched(call: NodePath<CallExpression>, file: string): (() => ActionType[]) | null {
    const callee = call.get('callee');
    const args = call.get('arguments');
    const name = callee.isIdentifier() ? callee.node.name : callee.isMemberExpression() && !callee.node.computed && callee.node.property.type === 'Identifier' ? callee.node.property.name : null;
    if (name === 'dispatch' && args[0]) return () => dispatchedTypes(args[0], file);
    if (!isConnect(callee) || !args[1]) return null;
    return () => {
      let props = args[1] as NodePath;
      if (props.isIdentifier()) props = initOf(props.scope.getBinding(props.node.name)) ?? props;
      if (!props.isObjectExpression()) return [];
      return props.get('properties').flatMap((q) => {
        if (!q.isObjectProperty()) return [];
        const value = q.get('value') as NodePath;
        const creator = value.isIdentifier() || value.isMemberExpression() ? creatorOf(value, file) : null;
        return creator ? creatorTypes(creator) : [];
      });
    };
  }

  function tableWatches(table: NodePath, file: string): Watch[] | null {
    if (!table.isIdentifier()) return null;
    const init = initOf(table.scope.getBinding(table.node.name));
    if (!init?.isObjectExpression()) return null;
    return init.get('properties').flatMap((q) => {
      if (!q.isObjectProperty()) return [];
      const key = q.get('key') as NodePath;
      const type = q.node.computed ? typeOf(key, file) : key.isIdentifier() ? literal(key.node.name) : key.isStringLiteral() ? literal(key.node.value) : null;
      return type ? [{ type, handler: handlerOf(q.get('value') as NodePath, file) }] : [];
    });
  }

  // 감시하는 함수 안에서 선언한 saga 는 이름만으로는 따라갈 수 없어 그 선언을 넘긴다.
  function handlerOf(saga: NodePath, file: string): Handler {
    const binding = saga.isIdentifier() ? saga.scope.getBinding(saga.node.name) : null;
    if (binding && !binding.scope.path.isProgram()) {
      const fn = binding.path.isFunctionDeclaration() ? binding.path : initOf(binding);
      if (fn?.isFunction()) return { file, span: [fn.node.start!, fn.node.end!] };
    }
    return { file, span: [saga.node.start!, saga.node.end!] };
  }

  function patternWatches(pattern: NodePath, file: string, handler: Handler | null): Watch[] {
    if (pattern.isArrayExpression()) return pattern.get('elements').flatMap((e) => (e.node ? patternWatches(e as NodePath, file, handler) : []));
    if (pattern.isCallExpression()) {
      const callee = pattern.node.callee;
      const keysOf = callee.type === 'MemberExpression' && memberChain(callee)?.join('.') === 'Object.keys';
      if (keysOf) return tableWatches(pattern.get('arguments')[0] as NodePath, file) ?? [];
      return [];
    }
    if (pattern.isIdentifier()) {
      const init = initOf(pattern.scope.getBinding(pattern.node.name));
      const made = init?.isYieldExpression() ? (init.get('argument') as NodePath) : init;
      if (made?.isCallExpression() && effectOf(made.get('callee')) === 'actionChannel') return patternWatches(made.get('arguments')[0] as NodePath, file, handler);
    }
    const type = typeOf(pattern, file);
    return type && handler ? [{ type, handler }] : [];
  }

  // 반복문 밖의 take 는 saga 가 기다리는 자리라 watcher 로 보지 않는다.
  function afterTake(call: NodePath, file: string): Handler | null {
    const fn = call.getFunctionParent();
    for (let at = call.parentPath; at && at !== fn; at = at.parentPath) {
      if (!LOOPS.has(at.node.type)) continue;
      const body = (at.get('body') as NodePath).node;
      return { file, span: [Math.max(call.node.end!, body.start!), body.end!] };
    }
    return null;
  }

  function watches(call: NodePath<CallExpression>, file: string): Watch[] | null {
    const effect = effectOf(call.get('callee'));
    if (!effect) return null;
    const args = call.get('arguments') as NodePath[];
    if (effect === 'take') {
      const handler = args[0] && afterTake(call, file);
      return handler ? patternWatches(args[0], file, handler) : null;
    }
    if (!Object.hasOwn(WATCHERS, effect)) return null;
    const [patternAt, sagaAt] = WATCHERS[effect];
    const [pattern, saga] = [args[patternAt], args[sagaAt]];
    if (!pattern || !saga) return null;
    if (saga.isMemberExpression() && saga.node.computed) {
      const table = tableWatches(saga.get('object'), file);
      if (table) return table;
    }
    return patternWatches(pattern, file, handlerOf(saga, file));
  }

  const madeByMiddleware = (init: NodePath | null | undefined) => {
    const maker = init?.isCallExpression() ? init.get('callee') : null;
    const made = maker?.isIdentifier() ? importOf(maker.scope.getBinding(maker.node.name)) : null;
    return Boolean(made && MIDDLEWARE_PACKAGES.has(made.source) && made.name === 'default');
  };

  function isMiddleware(binding: Binding | undefined, file: string) {
    const from = importOf(binding);
    if (!from) return madeByMiddleware(initOf(binding));
    const origin = from.name === '*' ? null : declaration(resolve(file, from.source), from.name);
    if (!origin) return false;
    try {
      const program = programOf(origin.file);
      if (origin.name !== 'default') return madeByMiddleware(initOf(program.scope.getBinding(origin.name)));
      const exp = program.get('body').find((st) => st.isExportDefaultDeclaration());
      return madeByMiddleware(exp?.get('declaration') as NodePath | undefined);
    } catch {
      return false;
    }
  }

  function runs(file: string) {
    const found: (Handler & { line: number })[] = [];
    programOf(file).traverse({
      CallExpression(p) {
        const callee = p.get('callee');
        const arg = p.node.arguments[0];
        if (!arg || !callee.isMemberExpression() || callee.node.computed || (callee.node.property as { name?: string }).name !== 'run') return;
        const object = callee.get('object');
        if (object.isIdentifier() && isMiddleware(object.scope.getBinding(object.node.name), file)) found.push({ file, span: [arg.start!, arg.end!], line: p.node.loc!.start.line });
      },
    });
    return found;
  }

  return { dispatched, watches, runs };
}
