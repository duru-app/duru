import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import type { ArrayExpression, CallExpression, Identifier, ImportDeclaration, ObjectExpression, ObjectProperty, VariableDeclaration } from '@babel/types';
import type { GuardSetting } from './access.ts';
import { constInits, keyName, lookupConstant, memberChain, QUERY_HOOKS, QUERY_PACKAGES } from './client.ts';
import type { GuardEntry, Note, QueryEnabled } from './client.ts';
import { parseSource } from './parse.ts';
import { importedAs } from './screen-requests.ts';
import { settingNeeds } from './setting-needs.ts';
import { addCallDefaults, findSettingsCalls, settingsResultFinder } from './settings-functions.ts';
import type { sourceValueReader } from './source-values.ts';

type NameNode = { name?: string; value?: string };

interface Helper {
  params: string[];
  body: string;
}

type SourceValues = Awaited<ReturnType<typeof sourceValueReader>>;

interface Reading extends Pick<SourceValues, 'constants' | 'constantFileOf' | 'mapOf' | 'programFile' | 'importedFile' | 'evaluate' | 'lossless' | 'constInit' | 'objectLiteral' | 'propertyKey' | 'rootIdentifier'> {
  config: any;
  resolve: (fromFile: string, spec: string) => string | null;
}

const traverse = _traverse.default ?? _traverse;

export function guardConditionReader({ config, resolve, constants, constantFileOf, mapOf, programFile, importedFile, evaluate, lossless, constInit, objectLiteral, propertyKey, rootIdentifier }: Reading) {
  const guardInits = new Map<string, Map<string, GuardEntry>>();
  const guardSettings = new Map<string, Map<string, GuardSetting | null>>();

  // [] 는 섹션을 다 알 수 없다는 뜻, [섹션] 은 그 섹션의 키를 다 알 수 없다는 뜻, [섹션, 키] 는 그 키의 값을 다 읽지 못했다는 뜻이다.
  function incompleteDefaults(init: NodePath<ObjectExpression>) {
    const found: string[][] = [];
    const add = (at: string[]) => {
      if (!found.some((f) => f.join('.') === at.join('.'))) found.push(at);
    };
    const name = (prop: NodePath<ObjectProperty>) => String((prop.node.key as NameNode).name ?? (prop.node.key as NameNode).value);
    for (const section of init.get('properties')) {
      if (!section.isObjectProperty() || section.node.computed) return [[]];
      const obj = objectLiteral(section.get('value'));
      if (!obj) {
        add([name(section)]);
        continue;
      }
      for (const prop of obj.get('properties')) {
        if (!prop.isObjectProperty() || prop.node.computed) add([name(section)]);
        else if (!lossless(prop.get('value'))) add([name(section), name(prop)]);
      }
    }
    return found;
  }

  // srcRoot 아래 파일 맨 위의 `const <name> = { … }` 나 `[ … ]` 의 값. 그런 선언이 없거나 값이 그 둘이 아니면 null 이다.
  function topLevelLiteral(file: string, name: string): NodePath<ObjectExpression | ArrayExpression> | null {
    const absFile = path.join(config.srcRoot, file);
    const { ast } = parseSource(absFile);
    programFile.set(ast.program, absFile);
    let init: NodePath<ObjectExpression | ArrayExpression> | null = null;
    traverse(ast, {
      VariableDeclarator(p) {
        if ((p.parent as VariableDeclaration).kind !== 'const' || !p.scope.path.isProgram() || !p.get('id').isIdentifier({ name })) return;
        const value = p.get('init');
        if (value.isObjectExpression() || value.isArrayExpression()) init = value;
        p.stop();
      },
    });
    return init;
  }

  function tableLiteral(table: { at: string }, file: string, name: string): NodePath<ObjectExpression | ArrayExpression> {
    const absFile = path.join(config.srcRoot, file);
    const { ast } = parseSource(absFile);
    programFile.set(ast.program, absFile);
    const top: NodePath[] = [];
    const inner: NodePath[] = [];
    traverse(ast, {
      VariableDeclarator(p) {
        if ((p.parent as VariableDeclaration).kind !== 'const' || !p.get('id').isIdentifier({ name })) return;
        const init = p.get('init') as NodePath;
        if (p.scope.path.isProgram()) top.push(init);
        else if (init.isObjectExpression() || init.isArrayExpression()) inner.push(init);
      },
    });
    const [found] = top.length ? top : inner.length === 1 ? inner : [];
    if (found?.isObjectExpression() || found?.isArrayExpression()) return found;
    const more = !top.length && inner.length > 1 ? `, and ${inner.length} consts of that name inside functions` : '';
    throw new Error(`${table.at}: ${file} has no top-level const ${name} holding an object or a list${more}`);
  }

  function loadSettingsDefaults() {
    const values: Record<string, any> = {};
    const incomplete: Record<string, string[][]> = {};
    for (const [root, { file, const: name, constant }] of Object.entries<any>(config.settingsDefaults ?? {})) {
      if (constant) {
        const value = lookupConstant(constants, constant.split('.'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          const found = typeof value === 'function'
            ? 'a function: point at the value it returns, or call it from a module listed in constants'
            : Array.isArray(value) ? 'a list' : typeof value === 'string' ? JSON.stringify(value) : String(value);
          throw new Error(`settingsDefaults.${root}: constant ${constant} is not an object but ${found}`);
        }
        values[root] = value;
        incomplete[root] = [];
        continue;
      }
      const init = topLevelLiteral(file, name);
      if (!init?.isObjectExpression()) throw new Error(`settingsDefaults.${root}: ${file} has no top-level const ${name} holding an object`);
      values[root] = evaluate(init);
      incomplete[root] = incompleteDefaults(init);
    }
    return { values, incomplete };
  }

  const { values: settingsDefaults, incomplete: settingsDefaultsIncomplete } = loadSettingsDefaults();
  const settingsCalls = config.settingsFunctions.length ? findSettingsCalls(config) : { calls: [], unread: [], notices: [] };
  const settingsCallNotices = [...settingsCalls.notices, ...addCallDefaults(settingsCalls.calls, settingsDefaults, settingsDefaultsIncomplete, { evaluate, lossless }, config.srcRoot), ...settingsCalls.unread];
  const resultOf = settingsResultFinder(settingsCalls as ReturnType<typeof findSettingsCalls>);
  const settingsResult = (id: NodePath) => resultOf(id, programFile.get(id.scope.getProgramParent().block));
  const needs = settingNeeds(config.settingsRoots ?? [], settingsDefaults, settingsResult);
  const CONFLICT: GuardSetting = { reason: 'conflict' };

  function noteSettings(file: string, text: string, result: GuardSetting | null) {
    const known = mapOf(guardSettings, file);
    if (!known.has(text)) known.set(text, result);
    else if (JSON.stringify(known.get(text)) !== JSON.stringify(result)) known.set(text, CONFLICT);
  }

  const constantRoot = (id: NodePath<Identifier>, file: string) => {
    const { name } = id.node;
    const binding = id.scope.getBinding(name);
    if (!constantFileOf.has(name) || !id.parentPath.isMemberExpression({ object: id.node }) || !binding?.path.isImportDefaultSpecifier()) return false;
    const declaration = binding.path.parent as ImportDeclaration;
    if (!importedFile.has(declaration)) importedFile.set(declaration, resolve(file, declaration.source.value));
    return importedFile.get(declaration) === constantFileOf.get(name);
  };

  const helperCache = new WeakMap<Binding, Helper | null>();
  // 파일 맨 위의 const 에 담긴 함수가 식 하나만 돌려주고 그 식이 매개변수와 상수 모듈만 읽으면 { params, body } 를, 아니면 null 을 준다.
  function helperOf(binding: Binding, file: string, src: string) {
    if (helperCache.has(binding)) return helperCache.get(binding)!;
    const fn = binding.kind === 'const' && binding.scope.path.isProgram() && binding.path.isVariableDeclarator() ? binding.path.get('init') as NodePath<any> : null;
    let body: NodePath | null = null;
    if ((fn?.isArrowFunctionExpression() || fn?.isFunctionExpression()) && !fn.node.async && !fn.node.generator && fn.node.params.every((p) => p.type === 'Identifier')) {
      const block = fn.get('body') as NodePath;
      const [only, ...rest] = block.isBlockStatement() ? block.node.body : [];
      if (!block.isBlockStatement()) body = block;
      else if (only?.type === 'ReturnStatement' && only.argument && !rest.length && !block.node.directives.length) body = block.get('body.0.argument') as NodePath;
    }
    const isParam = (id: NodePath<Identifier>) => fn!.node.params.includes(id.scope.getBinding(id.node.name)?.path.node);
    const readable = (p: NodePath) => !p.isThisExpression() && !p.isFunction() && !p.isClass() && !p.isJSX() && !p.isMetaProperty() && !p.isImport() && (!p.isIdentifier() || isParam(p) || constantRoot(p, file));
    let ok = Boolean(body) && readable(body!);
    if (ok) body!.traverse({
      enter(p) {
        if (p.isIdentifier() && !p.isReferencedIdentifier()) return;
        if (readable(p)) return;
        ok = false;
        p.stop();
      },
    });
    const helper = ok ? { params: fn!.node.params.map((p: Identifier) => p.name), body: src.slice(body!.node.start!, body!.node.end!) } : null;
    helperCache.set(binding, helper);
    return helper;
  }

  // 같은 문자열의 조건에서 호출하는 이름이 자리마다 다른 선언을 가리키면 어느 함수인지 모르므로 그 이름은 읽지 않는다.
  // 같은 파일을 다시 파싱하면 Binding 객체가 달라지므로 선언 위치로 견준다.
  function noteHelpers(entry: GuardEntry, calls: [string, Binding | null][], file: string, src: string) {
    entry.callees ??= new Map();
    entry.helpers ??= new Map();
    for (const [name, binding] of calls) {
      const key = binding && `${file}:${binding.identifier.start}`;
      if (!entry.callees.has(name)) {
        entry.callees.set(name, key);
        entry.helpers.set(name, binding && helperOf(binding, file, src));
      } else if (entry.callees.get(name) !== key) entry.helpers.set(name, null);
    }
  }

  function guardNote(file: string, src: string): Note {
    const inits = mapOf(guardInits, file);
    // source 는 자르지 않은 조건이다. 다른 조건이 잘려서 같은 문자열이 되면 어느 것인지 모르므로 비운다.
    return (text, exprPath, negated, source) => {
      const { inits: found, calls } = constInits(exprPath, src, evaluate);
      const known = inits.get(text);
      if (!known) inits.set(text, { source, inits: [...found] });
      else {
        if (known.source !== source) known.source = null;
        known.inits.push(...found.filter((f) => !known.inits.some((k) => k.name === f.name && k.init === f.init)));
      }
      noteHelpers(inits.get(text)!, calls, path.join(config.srcRoot, file), src);
      if (needs.readsResult(exprPath)) inits.get(text)!.readsSettingsResult = true;
      noteSettings(file, text, negated ? needs.readNegated(exprPath) : needs.read(exprPath));
    };
  }

  // 뒤에 spread 한 값이 있어도 마지막으로 적힌 값을 읽는다.
  function lastValue(options: NodePath<any> | null, key: string) {
    const obj = options?.node ? objectLiteral(options) : null;
    const prop = obj?.get('properties').findLast((p) => propertyKey(p) === key);
    return prop ? (prop.get('value') as NodePath) : null;
  }

  function enabledIn(options: NodePath<any> | null) {
    const value = lastValue(options, 'enabled');
    return value && !value.isBooleanLiteral({ value: true }) ? value : null;
  }

  // 쿼리 키를 만드는 자리: v3 처럼 키를 먼저 주는 첫 인자나 옵션의 queryKey
  function inQueryKey(call: NodePath<CallExpression>, arg: NodePath, site: NodePath) {
    if (arg.key === 0 && call.node.arguments.length > 1 && !arg.isObjectExpression()) return true;
    return site !== arg && site.findParent((a) => a === arg || (a.isObjectProperty() && propertyKey(a) === 'queryKey')) !== arg;
  }

  const queryEnabled: QueryEnabled = (parent, child, site) => {
    if (parent.isObjectExpression() && (child.isObjectProperty() || child.isObjectMethod()) && !child.node.computed && keyName(child.node) === 'queryFn') return enabledIn(parent);
    if (!parent.isCallExpression() || child.listKey !== 'arguments') return null;
    const callee = parent.get('callee');
    const binding = callee.isIdentifier() ? callee.scope.getBinding(callee.node.name) : undefined;
    const hook = binding && importedAs(binding);
    if (!hook || !QUERY_PACKAGES.has(hook.spec) || !QUERY_HOOKS.has(hook.name) || inQueryKey(parent, child, site)) return null;
    if (hook.name.endsWith('Queries')) {
      const query = site.findParent((a) => a === parent || (a.isObjectExpression() && a.parentPath!.isArrayExpression()));
      return query !== parent ? enabledIn(query) : null;
    }
    for (const arg of parent.get('arguments')) {
      const enabled = enabledIn(arg);
      if (enabled) return enabled;
    }
    return null;
  };

  function hookEnabled(callPath: NodePath<CallExpression>, fn: string | undefined) {
    if (!fn || !/^use[A-Z0-9]/.test(fn.split(/[#.]/).at(-1)!)) return [];
    return callPath.get('arguments').map((arg) => enabledIn(lastValue(arg, 'query'))).filter((v) => v !== null);
  }

  // MENUS.ADMIN?.LIST → globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST
  function settingsPath(nodePath: NodePath<any>, seen = new Set<Binding>()): string[] | null {
    const chain = memberChain(nodePath.node);
    if (!chain) return null;
    if (Object.hasOwn(settingsDefaults, chain[0])) return chain;
    const result = settingsResult(rootIdentifier(nodePath));
    if (result) return [...result, ...chain.slice(1)];
    const init = constInit(nodePath, chain[0], seen);
    const base = init && settingsPath(init, seen);
    return base ? [...base, ...chain.slice(1)] : null;
  }

  return {
    guardInits, guardSettings, settingsDefaults, settingsDefaultsIncomplete, settingsCallNotices, settingsResult, needs, noteSettings,
    tableLiteral, guardNote, queryEnabled, hookEnabled, settingsPath,
  };
}
