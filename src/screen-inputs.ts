import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import type { CallExpression, ImportDeclaration, JSXAttribute, JSXElement, Node } from '@babel/types';
import { memberChain } from './client.ts';
import { compare } from './config.ts';
import { parseSource } from './parse.ts';

const traverse = _traverse.default ?? _traverse;

export interface InputKey {
  key: string;
  file: string;
  line: number;
  // 키를 글자로 적은 자리. 다른 파일의 컴포넌트가 적었으면 그 파일이다.
  at: string;
}

interface State {
  setter: string;
  keys: InputKey[];
  unknown: string | null;
}

export interface CallInputs {
  // 인자 위치: ['0'] 또는 ['0', 'data'] 처럼 객체 리터럴의 속성 이름을 이어 적는다.
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

function spreadOf(owner: Node | null | undefined, name: string) {
  if (owner?.type !== 'ObjectExpression') return null;
  const [first, ...rest] = owner.properties;
  if (first?.type !== 'SpreadElement' || first.argument.type !== 'Identifier' || first.argument.name !== name) return null;
  return rest;
}

function functionAt(binding: Binding | undefined) {
  const declared = binding?.path;
  if (declared?.node.type === 'FunctionDeclaration') return declared;
  const init = declared?.node.type === 'VariableDeclarator' ? declared.node.init : null;
  return declared && init && 'params' in init ? (declared.get('init') as NodePath<any>) : null;
}

function importedName(binding: Binding) {
  if (binding.kind !== 'module') return null;
  const declaration = binding.path.parent as ImportDeclaration;
  const specifier = binding.path.node as ImportDeclaration['specifiers'][number];
  if (declaration.importKind === 'type' || (specifier as { importKind?: string }).importKind === 'type') return null;
  if (specifier.type === 'ImportSpecifier') return { spec: declaration.source.value, exported: specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value };
  return { spec: declaration.source.value, exported: 'default' };
}

function isProp(p: NodePath<any>, prop: string) {
  const binding = p.scope.getBinding(prop);
  if (binding?.kind === 'param') return true;
  const declarator = binding?.path;
  return Boolean(binding?.kind === 'const' && declarator?.node.type === 'VariableDeclarator' && declarator.node.id.type === 'ObjectPattern' && declarator.node.init?.type === 'Identifier' && declarator.node.init.name === 'props');
}

const MAX_DEPTH = 3;

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

  function passedAt(file: string, owner: Binding, param: number) {
    const fn = owner.path.getFunctionParent();
    const name = fn && functionName(fn);
    if (!fn || !name || owner.scope !== fn.scope) return null;
    const passed: { value: string; line: number }[] = [];
    for (const call of callsOf(file, name)) {
      const value = stringOf(call.node.arguments[param]);
      if (value === null) return null;
      passed.push({ value, line: call.node.loc!.start.line });
    }
    return passed.length ? passed : null;
  }

  function valuesOf(file: string, node: Node | null | undefined, scope: NodePath<any>): InputKey[] | null {
    const literal = stringOf(node);
    if (literal !== null) return [{ key: literal, file: rel(file), line: node!.loc!.start.line, at: at(file, node!) }];
    if (node?.type !== 'Identifier') return null;
    const binding = scope.scope.getBinding(node.name);
    if (!binding || binding.kind === 'module' || !binding.path.isIdentifier()) return null;
    const fn = binding.path.getFunctionParent();
    const param = fn ? (fn.get('params') as NodePath<any>[]).findIndex((q) => q.isIdentifier() && q.node.name === (node as { name: string }).name) : -1;
    const passed = fn && param >= 0 ? passedAt(file, binding, param) : null;
    return passed?.map(({ value, line }) => ({ key: value, file: rel(file), line: node.loc!.start.line, at: `${at(file, node)} → ${rel(file)}:${line}` })) ?? null;
  }

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

  function forwardedKeys(file: string, prop: string, depth: number, seen: string[]): InputKey[] | null {
    let found = false;
    let keys: InputKey[] | null = null;
    traverse(parse(file).ast, {
      Identifier(p: NodePath<any>) {
        if (found || p.node.name !== prop || !p.isReferencedIdentifier() || !isProp(p, prop)) return;
        const inside = p.parentPath?.isJSXExpressionContainer() && p.parentPath.node.expression === p.node ? p.parentPath.parentPath : null;
        const attribute = inside?.isJSXAttribute() ? inside : null;
        if (!attribute || attribute.node.name.type !== 'JSXIdentifier') return;
        const element = attribute.parentPath as NodePath<any> | null;
        const tag = element?.isJSXOpeningElement() && element.node.name.type === 'JSXIdentifier' ? element.node.name.name : null;
        const owner = tag ? element!.scope.getBinding(tag) : undefined;
        const imported = owner && importedName(owner);
        const target = imported?.spec.startsWith('.') ? resolve(file, imported.spec) : null;
        if (!imported || !target || depth + 1 >= MAX_DEPTH || seen.includes(target)) return;
        found = true;
        keys = propKeys(target, attribute.node.name.name, depth + 1, [...seen, file]);
      },
    });
    return found ? keys : null;
  }

  function jsxFor(file: string, attribute: string, from: string): NodePath<JSXElement> | null {
    let found: NodePath<JSXElement> | null = null;
    traverse(parse(file).ast, {
      JSXAttribute(p: NodePath<JSXAttribute>) {
        if (found || p.node.name.type !== 'JSXIdentifier' || p.node.name.name !== attribute) return;
        const value = p.get('value') as NodePath<any>;
        const expression = value?.isJSXExpressionContainer() ? (value.get('expression') as NodePath<any>) : value;
        if (!expression?.isIdentifier() || expression.node.name !== from) return;
        const element = p.parentPath as NodePath<any> | null;
        if (element?.isJSXOpeningElement()) found = element.parentPath as NodePath<JSXElement>;
      },
    });
    return found;
  }

  // 키를 알 수 없는 자리가 있으면 null 이다.
  function propKeys(file: string, prop: string, depth = 0, seen: string[] = []): InputKey[] | null {
    const bindings = new WeakMap<NodePath<any>, Map<string, Binding | undefined>>();
    const functions = new Map<NodePath<any>, string | null>();
    const bindingAt = (p: NodePath<any>, name: string) => {
      let found = bindings.get(p);
      if (!found) bindings.set(p, (found = new Map()));
      if (!found.has(name)) found.set(name, p.scope.getBinding(name));
      return found.get(name);
    };
    const named = (fn: NodePath<any> | null) => {
      if (!fn) return null;
      if (!functions.has(fn)) functions.set(fn, functionName(fn));
      return functions.get(fn)!;
    };
    const fromProps = (binding: Binding | undefined) =>
      binding?.kind === 'const' && binding.path.node.type === 'VariableDeclarator' && binding.path.node.id.type === 'ObjectPattern' && binding.path.node.init?.type === 'Identifier' && binding.path.node.init.name === 'props';
    const given = (name: string) => (name === prop || name === 'props' ? 'props' : name === 'state' ? 'state' : null);
    let unsure = false;
    const argumentOf = (p: NodePath<any>): NodePath<any> | null => {
      const arguments_ = (p.parentPath as NodePath<any>).get('arguments') as NodePath<any>[];
      return arguments_[0] ?? null;
    };

    const forward = (name: string, attribute: string): InputKey[] | null => {
      const element = jsxFor(file, attribute, name);
      const tag = element?.node.openingElement.name;
      const owner = tag?.type === 'JSXIdentifier' ? element!.scope.getBinding(tag.name) : undefined;
      const imported = owner && importedName(owner);
      const target = imported?.spec.startsWith('.') ? resolve(file, imported.spec) : null;
      if (!imported || !target || depth + 1 >= MAX_DEPTH || seen.includes(target)) return null;
      return propKeys(target, attribute, depth + 1, [...seen, file]);
    };

    const through = (p: NodePath<any>, name: string): InputKey[] | null => {
      const parent = p.parentPath as NodePath<any> | null;
      const member = parent?.isMemberExpression() && parent.node.object === p.node ? parent : null;
      const key = member && (member.node.computed ? stringOf(member.node.property) : (member.node.property as { name?: string }).name);
      const inside = parent?.isJSXExpressionContainer() && parent.node.expression === p.node ? parent.parentPath : null;
      const attribute = inside?.isJSXAttribute() ? inside : null;
      const as = attribute ? (attribute.node.name.type === 'JSXIdentifier' ? attribute.node.name.name : null) : key;
      return as ? forward(name, as) : null;
    };

    const read = (p: NodePath<any>): InputKey[] | null => {
      if (p.isObjectExpression()) {
        const found: InputKey[] = [];
        for (const item of p.get('properties') as NodePath<any>[]) {
          if (item.isSpreadElement()) {
            const argument = item.get('argument') as NodePath<any>;
            const name = argument.isIdentifier() ? argument.node.name : null;
            const binding = name ? bindingAt(argument, name) : undefined;
            if ((binding?.kind === 'param' || fromProps(binding)) && !given(name!)) continue;
            const inner = name ? model(argument, name, binding) : null;
            if (!inner) return null;
            for (const value of inner) if (!found.some((k) => k.key === value.key)) found.push(value);
            continue;
          }
          if (!item.isObjectProperty()) return null;
          const key = propertyKey(item.node);
          const values = key !== null ? [{ key, file: rel(file), line: item.node.loc!.start.line, at: at(file, item.node) }] : valuesOf(file, item.node.key, p);
          if (!values) return null;
          for (const value of values) if (!found.some((k) => k.key === value.key)) found.push(value);
        }
        return found;
      }
      if (!p.isIdentifier()) return null;
      const b = bindingAt(p, p.node.name);
      return model(p, p.node.name, b);
    };

    const model = (p: NodePath<any>, name: string, binding: Binding | undefined): InputKey[] | null => {
      if (binding?.kind === 'module' || given(name) || (fromProps(binding) && name === prop)) return through(p, name);
      if (binding && (binding.kind === 'let' || binding.kind === 'const')) return assigned(binding);
      if (binding?.kind === 'param') return passed(binding);
      return through(p, name);
    };

    const passed = (binding: Binding): InputKey[] | null => {
      const fn = binding.path.getFunctionParent();
      const name = fn && named(fn);
      if (!fn || !name || binding.scope !== fn.scope) return null;
      const param = (fn.get('params') as NodePath<any>[]).findIndex((q) => q.isIdentifier() && q.node.name === (binding.identifier as { name?: string }).name);
      if (param < 0) return null;
      const owner = binding.path.getFunctionParent()?.parentPath;
      const calls = callsOf(file, name).filter((call) => call.scope.getBinding(name) === owner?.scope.getBinding(name));
      const found: InputKey[] = [];
      for (const call of calls) {
        const arg = call.get('arguments')[param] as NodePath<any> | undefined;
        const inner = arg?.node && !Array.isArray(arg) ? read(arg) : null;
        if (!inner) return null;
        for (const value of inner) if (!found.some((k) => k.key === value.key)) found.push(value);
      }
      return calls.length ? found : null;
    };

    const assigned = (binding: Binding): InputKey[] | null => {
      const fn = binding.path.getFunctionParent();
      if (!fn || binding.scope !== fn.scope) return null;
      const name = binding.identifier.name;
      const placed: NodePath<any>[] = [];
      const found: InputKey[] = [];
      let other = false;
      traverse(parse(file).ast, {
        Identifier(p: NodePath<any>) {
          if (p.node.name !== name || bindingAt(p, name) !== binding || !p.isReferencedIdentifier() || !fn.isAncestor(p)) return;
          const parent = p.parentPath;
          const assignment = parent.parentPath?.isAssignmentExpression() && p.key === 'object' && parent.parentPath.node.left === parent.node ? parent.parentPath : null;
          if (parent.isAssignmentExpression() && parent.node.left === p.node) {
            placed.push(parent.get('right') as NodePath<any>);
            return;
          }
          if (parent.isMemberExpression() && assignment) {
            const key = propertyKey(parent.node);
            const values = key !== null ? [{ key, file: rel(file), line: parent.node.property.loc!.start.line, at: at(file, parent.node.property) }] : valuesOf(file, parent.node.property, p);
            if (!values) return void (other = true);
            for (const value of values) if (!found.some((k) => k.key === value.key)) found.push(value);
            return;
          }
          if (parent.isCallExpression() && parent.node.callee.type === 'Identifier' && parent.node.callee.name === prop && parent.node.arguments[0] === p.node) return;
          other = true;
        },
      });
      if (binding.path.isVariableDeclarator()) placed.unshift(binding.path.get('init') as NodePath<any>);
      for (const value of placed) {
        const inner = value?.node ? read(value) : null;
        if (!inner) return null;
        for (const one of inner) if (!found.some((k) => k.key === one.key)) found.push(one);
      }
      return other ? null : found;
    };
    const found: InputKey[] = [];
    let called = false;
    traverse(parse(file).ast, {
      Identifier(p: NodePath<any>) {
        if (p.node.name !== prop || !p.isReferencedIdentifier() || !isProp(p, prop)) return;
        if (p.parentPath.isMemberExpression() && p.key === 'property' && !p.parentPath.node.computed) return;
        if (!(p.parentPath as NodePath<any> | null)?.isCallExpression() || p.key !== 'callee') return;
        called = true;
        const arg = argumentOf(p);
        const inner = arg?.node && !Array.isArray(arg) ? read(arg) : null;
        if (!inner) return void (unsure = true);
        for (const value of inner) if (!found.some((k) => k.key === value.key)) found.push(value);
      },
      MemberExpression(p: NodePath<any>) {
        if (p.node.computed || p.node.object.type !== 'Identifier' || p.node.object.name !== 'props' || (p.node.property as { name?: string }).name !== prop) return;
        if (!(p.parentPath as NodePath<any> | null)?.isCallExpression() || p.key !== 'callee') return;
        called = true;
        const arg = argumentOf(p);
        const inner = arg?.node && !Array.isArray(arg) ? read(arg) : null;
        if (!inner) return void (unsure = true);
        for (const value of inner) if (!found.some((k) => k.key === value.key)) found.push(value);
      },
    });
    const forwarded = forwardedKeys(file, prop, depth, seen);
    if (unsure || (forwarded === null && !found.length)) return null;
    for (const key of forwarded ?? []) if (!found.some((k) => k.key === key.key)) found.push(key);
    return called || found.length ? found : null;
  }
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
      const keys: InputKey[] = [];
      for (const { prop, from } of passed) {
        const read = propKeys(from, prop);
        if (!read) return null;
        for (const key of read) if (!keys.some((k) => k.key === key.key)) keys.push(key);
      }
      return keys;
    };
    const fail = (name: string, reason: string) => {
      byState.get(name)!.unknown ??= reason;
    };
    const add = (name: string, values: InputKey[], where: Node) => {
      const entry = byState.get(name)!;
      for (const value of values) if (!entry.keys.some((k) => k.key === value.key && k.at === value.at)) entry.keys.push({ ...value, file: rel(file), line: where.loc!.start.line });
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
          const values = key !== null ? [{ key, file: rel(file), line: p.node.loc!.start.line, at: at(file, p.node) }] : valuesOf(file, prop.key, p);
          if (!values) fail(name, `the key at ${at(file, p.node)} is not a string literal and not a parameter given a string literal`);
          else add(name, values, p.node);
        }
      },
    });
    return byState;
  }

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
