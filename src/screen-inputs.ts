import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import type { CallExpression, ImportDeclaration, JSXAttribute, Node } from '@babel/types';
import { memberChain } from './client.ts';
import { compare } from './config.ts';
import { parseSource } from './parse.ts';

const traverse = _traverse.default ?? _traverse;

export interface InputKey {
  key: string;
  file: string;
  line: number;
}

interface State {
  setter: string;
  keys: InputKey[];
  unknown: string | null;
}

export interface CallInputs {
  // 인자 자리: ['0'] 이거나 ['0', 'data'] 처럼 객체 리터럴의 속성 이름을 잇는다.
  argPath: string[];
  keys: InputKey[];
  unknown: string | null;
}

interface Reading {
  srcRoot: string;
  resolve: (file: string, spec: string) => string | null;
}

const stringOf = (node: Node | null | undefined): string | null => (node?.type === 'StringLiteral' ? node.value : node?.type === 'NumericLiteral' ? String(node.value) : null);

// 적힌 키. 계산한 키는 글자 그대로일 때만 읽는다.
const propertyKey = (prop: any): string | null => (!prop.computed ? (prop.key.type === 'Identifier' ? prop.key.name : stringOf(prop.key)) : stringOf(prop.key));

// `{ ...name, … }` 에서 name 뒤의 속성. 첫 자리가 name 을 펼치지 않으면 null 이다.
function spreadOf(owner: Node | null | undefined, name: string) {
  if (owner?.type !== 'ObjectExpression') return null;
  const [first, ...rest] = owner.properties;
  if (first?.type !== 'SpreadElement' || first.argument.type !== 'Identifier' || first.argument.name !== name) return null;
  return rest;
}

// const F = (a) => … · function F(a) {} 처럼 선언한 함수의 이름 자리에서 그 함수.
function functionAt(binding: Binding | undefined) {
  const declared = binding?.path;
  if (declared?.node.type === 'FunctionDeclaration') return declared;
  const init = declared?.node.type === 'VariableDeclarator' ? declared.node.init : null;
  return declared && init && 'params' in init ? (declared.get('init') as NodePath<any>) : null;
}

// 불러온 이름과 그 파일에서 내보낸 이름.
function importedName(binding: Binding) {
  if (binding.kind !== 'module') return null;
  const declaration = binding.path.parent as ImportDeclaration;
  const specifier = binding.path.node as ImportDeclaration['specifiers'][number];
  if (declaration.importKind === 'type' || (specifier as { importKind?: string }).importKind === 'type') return null;
  if (specifier.type === 'ImportSpecifier') return { spec: declaration.source.value, exported: specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value };
  return { spec: declaration.source.value, exported: 'default' };
}

// props.onChange 이거나, `const { onChange } = props` 처럼 props 에서 꺼낸 이름.
function isProp(p: NodePath<any>, prop: string) {
  const binding = p.scope.getBinding(prop);
  if (binding?.kind === 'param') return true;
  const declarator = binding?.path;
  return Boolean(binding?.kind === 'const' && declarator?.node.type === 'VariableDeclarator' && declarator.node.id.type === 'ObjectPattern' && declarator.node.init?.type === 'Identifier' && declarator.node.init.name === 'props');
}

export function screenInputReader({ srcRoot, resolve }: Reading) {
  const parsed = new Map<string, ReturnType<typeof parseSource>>();
  const states = new Map<string, Map<string, State>>();
  const done = new Set<string>();
  const parse = (file: string) => {
    if (!parsed.has(file)) parsed.set(file, parseSource(file));
    return parsed.get(file)!;
  };
  const rel = (file: string) => path.relative(srcRoot, file);
  const at = (file: string, node: Node) => `${rel(file)}:${node.loc?.start.line ?? 0}`;

  // 파일마다 useState 로 선언한 상태. 초기값의 키는 세지 않는다.
  function statesIn(file: string) {
    if (states.has(file)) return states.get(file)!;
    const found = new Map<string, State>();
    states.set(file, found);
    traverse(parse(file).ast, {
      CallExpression(p) {
        if (p.node.callee.type !== 'Identifier' || p.node.callee.name !== 'useState') return;
        const declarator = p.parentPath;
        if (!declarator.isVariableDeclarator() || declarator.node.id.type !== 'ArrayPattern') return;
        const [state, setter] = declarator.node.id.elements;
        if (state?.type === 'Identifier' && setter?.type === 'Identifier') found.set(state.name, { setter: setter.name, keys: [], unknown: null });
      },
    });
    return found;
  }

  // 그 이름으로 부른 곳. JSX 속성 값 안의 것도 들어 있다.
  function callsOf(file: string, name: string) {
    const calls: NodePath<CallExpression>[] = [];
    traverse(parse(file).ast, {
      CallExpression(p) {
        const callee = p.node.callee;
        if (callee.type === 'Identifier' && callee.name === name) calls.push(p);
      },
    });
    return calls;
  }

  function functionName(fn: NodePath<any>) {
    const owner = fn.parentPath;
    if (owner?.isVariableDeclarator() && owner.node.id.type === 'Identifier') return owner.node.id.name;
    return fn.isFunctionDeclaration() && fn.node.id ? fn.node.id.name : null;
  }

  // F 가 param 번째 매개변수로 받는 값들: F 를 부른 곳마다 그 자리에 건넨 글자. 글자가 아닌 것도 있으면 null 이다.
  function passedAt(file: string, owner: Binding, param: number) {
    const fn = owner.path.getFunctionParent();
    const name = fn && functionName(fn);
    if (!fn || !name || owner.scope !== fn.scope) return null;
    const passed: string[] = [];
    for (const call of callsOf(file, name)) {
      const value = stringOf(call.node.arguments[param]);
      if (value === null) return null;
      passed.push(value);
    }
    return passed.length ? passed : null;
  }

  // 키 자리에 놓인 식의 값들. 문자열 글자 그대로이거나, 이름 있는 함수의 매개변수면 부른 곳에서 건넨 글자다.
  function valuesOf(file: string, node: Node | null | undefined, scope: NodePath<any>): string[] | null {
    const literal = stringOf(node);
    if (literal !== null) return [literal];
    if (node?.type !== 'Identifier') return null;
    const binding = scope.scope.getBinding(node.name);
    if (!binding || binding.kind === 'module' || !binding.path.isIdentifier()) return null;
    const fn = binding.path.getFunctionParent();
    const param = fn ? (fn.get('params') as NodePath<any>[]).findIndex((q) => q.isIdentifier() && q.node.name === (node as { name: string }).name) : -1;
    return fn && param >= 0 ? passedAt(file, binding, param) : null;
  }

  // 이 파일이 relative 파일의 컴포넌트에 상태를 받은 인자를 속성으로 넘긴 자리: 인자 이름, 속성 이름, 그 파일.
  function mergesIn(file: string) {
    const found: { param: string; prop: string; from: string }[] = [];
    traverse(parse(file).ast, {
      JSXAttribute(p: NodePath<JSXAttribute>) {
        const value = p.get('value') as NodePath<any>;
        const expression = value?.isJSXExpressionContainer() ? (value.get('expression') as NodePath<any>) : value;
        if (!expression?.isIdentifier() || p.node.name.type !== 'JSXIdentifier') return;
        const fn = functionAt(expression.scope.getBinding(expression.node.name));
        const param = fn?.node.params[0]?.type === 'Identifier' ? fn.node.params[0].name : null;
        const element = p.parentPath;
        const tag = element.isJSXOpeningElement() && element.node.name.type === 'JSXIdentifier' ? element.node.name.name : null;
        const owner = tag ? element.scope.getBinding(tag) : undefined;
        const from = owner && importedName(owner);
        const target = from?.spec.startsWith('.') ? resolve(file, from.spec) : null;
        if (param && target) found.push({ param, prop: p.node.name.name, from: target });
      },
    });
    return found;
  }

  // 다른 파일의 컴포넌트가 그 속성을 부르는 곳마다 넘기는 키. 그 밖에 쓰면 null 이다.
  function propKeys(file: string, prop: string) {
    const keys: string[] = [];
    let other = false;
    const look = (p: NodePath<any>) => {
      const call = p.parentPath!.isCallExpression() && p.key === 'callee' ? p.parentPath! : null;
      const arg = call?.node.arguments[0];
      // `onChange && onChange(...)` 의 앞자리는 부르는 자리가 아니다.
      if (!call && p.parentPath!.isLogicalExpression() && p.key === 'left') return;
      const first = arg?.type === 'ObjectExpression' ? arg.properties[0] : null;
      const rest = first?.type === 'SpreadElement' && first.argument.type === 'Identifier' ? spreadOf(arg, first.argument.name) : null;
      if (!rest) return void (other = true);
      for (const item of rest) {
        const key = item.type === 'ObjectProperty' ? propertyKey(item) : null;
        const values = key !== null ? [key] : item.type === 'ObjectProperty' ? valuesOf(file, item.key, p) : null;
        if (!values) return void (other = true);
        for (const value of values) if (!keys.includes(value)) keys.push(value);
      }
    };
    traverse(parse(file).ast, {
      MemberExpression(p) {
        if (p.node.computed || (p.node.property as { name?: string }).name !== prop || p.node.object.type !== 'Identifier' || p.node.object.name !== 'props') return;
        look(p);
      },
      Identifier(p) {
        if (p.node.name !== prop || !p.isReferencedIdentifier()) return;
        if (p.parentPath.isMemberExpression() && p.key === 'property' && !p.parentPath.node.computed) return;
        if (!isProp(p, prop)) return;
        look(p);
      },
    });
    return other || !keys.length ? null : keys;
  }

  // 이 파일의 상태마다 그 상태의 set 함수에 쓰인 키.
  function keysIn(file: string) {
    const byState = statesIn(file);
    if (done.has(file)) return byState;
    done.add(file);
    if (!byState.size) return byState;
    const bySetter = new Map([...byState].map(([name, state]) => [state.setter, name]));
    const merges = mergesIn(file);

    const childKeys = (param: string) => {
      const passed = merges.filter((m) => m.param === param);
      if (!passed.length) return null;
      const keys: string[] = [];
      for (const { prop, from } of passed) {
        const read = propKeys(from, prop);
        if (!read) return null;
        for (const key of read) if (!keys.includes(key)) keys.push(key);
      }
      return keys;
    };
    const fail = (name: string, reason: string) => {
      byState.get(name)!.unknown ??= reason;
    };
    const add = (name: string, values: string[], where: Node) => {
      const entry = byState.get(name)!;
      for (const value of values) if (!entry.keys.some((k) => k.key === value && k.file === rel(file) && k.line === where.loc!.start.line)) entry.keys.push({ key: value, file: rel(file), line: where.loc!.start.line });
    };
    traverse(parse(file).ast, {
      CallExpression(p: NodePath<CallExpression>) {
        const callee = p.node.callee;
        const name = callee.type === 'Identifier' ? bySetter.get(callee.name) : undefined;
        const arg = p.node.arguments[0];
        if (!name || !arg) return;
        const param = arg.type === 'ArrowFunctionExpression' && arg.params[0]?.type === 'Identifier' ? arg.params[0].name : '';
        const props = spreadOf(arg, name) ?? (param ? spreadOf(arg.type === 'ArrowFunctionExpression' ? arg.body : null, param) : null);
        if (!props) return;
        for (const prop of props) {
          if (prop.type === 'SpreadElement') {
            const values = prop.argument.type === 'Identifier' ? childKeys(prop.argument.name) : null;
            if (!values) fail(name, `a spread of ${prop.argument.type === 'Identifier' ? prop.argument.name : 'a value'} whose keys duru does not read at ${at(file, p.node)}`);
            else add(name, values, p.node);
            continue;
          }
          if (prop.type !== 'ObjectProperty') continue;
          const key = propertyKey(prop);
          const values = key !== null ? [key] : valuesOf(file, prop.key, p);
          if (!values) fail(name, `the key at ${at(file, p.node)} is not a string literal and not a parameter given a string literal`);
          else add(name, values, p.node);
        }
      },
    });
    return byState;
  }

  // fn(arg) 의 arg 로 넘긴 상태의 이름과 그 인자 자리. arg 가 이 파일의 상태로 이어지지 않으면 null 이다.
  function argumentState(file: string, arg: NodePath<any>) {
    const known = statesIn(file);
    if (arg.isIdentifier()) return known.has(arg.node.name) ? { name: arg.node.name, argPath: [] } : null;
    if (!arg.isObjectExpression()) return null;
    for (const prop of arg.node.properties) {
      if (prop.type !== 'ObjectProperty' || prop.computed) continue;
      const value = prop.value;
      if (value.type !== 'Identifier') continue;
      const name = propertyKey(prop)!;
      if (known.has(value.name)) return { name: value.name, argPath: [name] };
      const binding = arg.scope.getBinding(value.name);
      const init = binding && (binding.kind === 'const' || binding.kind === 'let') ? (binding.path.get('init') as NodePath<any> | undefined) : undefined;
      const first = init?.isObjectExpression() ? init.node.properties[0] : null;
      if (first?.type === 'SpreadElement' && first.argument.type === 'Identifier' && known.has(first.argument.name)) return { name: first.argument.name, argPath: [name] };
    }
    return null;
  }

  // 이 파일이 API 함수 fn 을 부르는 곳마다, 그 인자로 넘긴 상태의 키.
  function callInputs(file: string) {
    const found = new Map<number, CallInputs>();
    if (!statesIn(file).size) return found;
    traverse(parse(file).ast, {
      CallExpression(p: NodePath<CallExpression>) {
        const fn = memberChain(p.node.callee)?.join('.');
        const arg = p.get('arguments')[0] as NodePath<any> | undefined;
        if (!fn || !arg?.node) return;
        const state = argumentState(file, arg);
        if (!state) return;
        const entry = keysIn(file).get(state.name)!;
        const keys = [...entry.keys].sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.key, b.key));
        found.set(p.node.start!, { argPath: state.argPath, keys, unknown: entry.unknown });
      },
    });
    return found;
  }
  return { callInputs };
}
