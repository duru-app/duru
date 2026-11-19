import fs from 'node:fs';
import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath, Scope } from '@babel/traverse';
import type { ArrayExpression, CallExpression, ClassDeclaration, Identifier, ImportDeclaration, ImportDefaultSpecifier, ImportNamespaceSpecifier, ImportSpecifier, JSXAttribute, JSXElement, JSXIdentifier, JSXMemberExpression, JSXNamespacedName, MemberExpression, Node, ObjectExpression, ObjectProperty, Program, StringLiteral, TemplateLiteral, VariableDeclaration } from '@babel/types';
import type { AddressFunction } from './address-functions.ts';
import { keyName, lookupConstant, memberChain, UNKNOWN } from './client.ts';
import type { RouteTable } from './client.ts';
import { componentFileFinder } from './component-file.ts';
import { loadConstants } from './constants.ts';
import type { Origin } from './follow-names.ts';
import { parseSource } from './parse.ts';
import { importResolver } from './resolve.ts';
import { sourceFiles } from './saga-requests.ts';

type NameNode = { name?: string; value?: string };

interface Reading {
  config: any;
  // export 한 이름을 선언한 파일과 그 파일에서의 이름
  declaration: (file: string | null | undefined, name: string) => Origin | null;
}

const traverse = _traverse.default ?? _traverse;

export async function sourceValueReader({ config, declaration }: Reading) {
  const imports = importResolver(config);
  const components = componentFileFinder(imports.resolve);
  const constants = await loadConstants(config, imports.resolve);
  const apiModuleFiles = new Set<string>(config.apiModules.map((rel: string) => path.join(config.srcRoot, rel)));
  const calledFiles = new Set<string>(config.calledApiModules.map((rel: string) => path.join(config.srcRoot, rel)));
  const constantFileOf = new Map(Object.entries<string>(config.constants).map(([name, rel]): [string, string] => [name, path.join(config.srcRoot, rel)]));
  const settingsOnly = new Set(Object.values<any>(config.settingsDefaults ?? {}).map((d) => d.constant?.split('.')[0]).filter(Boolean));
  const routeChain: string[] | null = config.routeConstant?.split('.') ?? null;
  if (routeChain) settingsOnly.delete(routeChain[0]);
  const constantModuleFiles = new Set(constantFileOf.values());
  const constantFiles = new Set([...constantFileOf].filter(([name]) => !settingsOnly.has(name)).map(([, file]) => file));
  const settingsRoots = new Set<string>(config.settingsRoots);
  const routeTables = new Map<string, RouteTable & { at: string }>((config.routeTables as RouteTable[]).map((t, i) => [t.route, { ...t, at: `routeTables[${i}]` }]));
  const tableFiles = new Set((config.routeTables as RouteTable[]).map((t) => path.join(config.srcRoot, t.table.file)));
  const menuTables = new Map<string, string[]>();
  for (const t of routeTables.values()) {
    for (const f of (t.menus ?? []).map((m) => path.join(config.srcRoot, m))) menuTables.set(f, [...(menuTables.get(f) ?? []), t.at]);
  }
  const tableRoutes = new Map<string, { field: string; routeFile: string; line: number }>();
  // 라우트 파일에 적은 표는 그 라우트 파일을 그리는 화면의 소스에 남는다.
  for (const f of config.routeFiles as string[]) tableFiles.delete(path.join(config.srcRoot, f));
  const [routeRoot, ...routeRest] = routeChain ?? [];

  const mapOf = <V>(maps: Map<string, Map<string, V>>, file: string) => {
    if (!maps.has(file)) maps.set(file, new Map());
    return maps.get(file)!;
  };

  const parsed = new Map<string, ReturnType<typeof parseSource>>();
  const programFile = new WeakMap<Node, string>();
  const parse = (file: string) => {
    if (!parsed.has(file)) {
      parsed.set(file, parseSource(file));
      programFile.set(parsed.get(file)!.ast.program, file);
    }
    return parsed.get(file)!;
  };

  const importedFile = new WeakMap<Node, string | null>();
  const programs = new Map<string, NodePath<Program> | null>();
  const programOf = (file: string) => {
    if (!programs.has(file)) {
      let program: NodePath<Program> | null = null;
      try {
        const { ast } = parse(file);
        programFile.set(ast.program, file);
        traverse(ast, {
          Program(p) {
            program = p;
            p.stop();
          },
        });
      } catch {}
      programs.set(file, program);
    }
    return programs.get(file)!;
  };

  function declaredValue(scope: Scope, name: string): NodePath | null {
    const binding = scope.getBinding(name);
    if (!binding) {
      const program = scope.getProgramParent().path as NodePath<Program>;
      const declared = program.get('body').map((s) => (s.isExportNamedDeclaration() ? (s.get('declaration') as NodePath) : s));
      return declared.find((d) => d.isTSEnumDeclaration() && d.node.id.name === name) ?? null;
    }
    if (binding.kind === 'const' && binding.path.isVariableDeclarator() && binding.path.get('id').isIdentifier()) {
      const init = binding.path.get('init') as NodePath;
      return init.node ? init : null;
    }
    const from = binding.kind === 'module' ? importedName(binding) : null;
    return from && from.name !== '*' ? exportedValue(from.file, from.name) : null;
  }

  function importedName(binding: Binding) {
    if (!binding.path.parentPath?.isImportDeclaration()) return null;
    const spec = binding.path.node as ImportSpecifier | ImportDefaultSpecifier | ImportNamespaceSpecifier;
    const declaration = binding.path.parent as ImportDeclaration;
    const file = programFile.get(binding.scope.getProgramParent().block);
    if (!file) return null;
    if (!importedFile.has(declaration)) importedFile.set(declaration, imports.resolve(file, declaration.source.value));
    const name = spec.type === 'ImportNamespaceSpecifier' ? '*' : spec.type === 'ImportDefaultSpecifier' ? 'default' : (spec.imported as Identifier).name ?? (spec.imported as StringLiteral).value;
    return { file: importedFile.get(declaration)!, name };
  }

  function exportedValue(file: string | null, name: string): NodePath | null {
    const found = file ? declaration(file, name) : null;
    const program = found && programOf(found.file);
    if (!program) return null;
    if (found!.name !== 'default') return declaredValue(program.scope, found!.name);
    const value = program.get('body').find((s) => s.isExportDefaultDeclaration())?.get('declaration') as NodePath | undefined;
    return value?.isExpression() ? value : null;
  }

  function namespaceMember(scope: Scope, chain: string[]) {
    const binding = scope.getBinding(chain[0]);
    const from = binding?.kind === 'module' ? importedName(binding) : null;
    return from?.name === '*' ? exportedValue(from.file, chain[1]) : null;
  }

  // 따라가는 중인 선언을 다시 만나면 값을 읽지 못한 것으로 본다.
  const evaluating = new Set<Node>();
  function valueAt(p: NodePath | null) {
    if (!p || evaluating.has(p.node)) return undefined;
    evaluating.add(p.node);
    try {
      return evaluate(p);
    } finally {
      evaluating.delete(p.node);
    }
  }

  const textOf = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : UNKNOWN);
  // 상수·템플릿·문자열 결합·지역 const 까지만 따라가 값을 만든다. 모르는 조각은 UNKNOWN 으로 남긴다.
  function evaluate(nodePath: NodePath<any>): any {
    const node = nodePath.node;
    switch (node.type) {
      case 'StringLiteral':
        return node.value;
      case 'NumericLiteral':
      case 'BooleanLiteral':
        return node.value;
      case 'NullLiteral':
        return null;
      case 'TemplateLiteral': {
        let out = '';
        node.quasis.forEach((q: TemplateLiteral['quasis'][number], i: number) => {
          out += q.value.cooked;
          if (i < node.expressions.length) {
            const v = evaluate(nodePath.get(`expressions.${i}`) as NodePath);
            out += textOf(v);
          }
        });
        return out;
      }
      case 'BinaryExpression': {
        if (node.operator !== '+') return undefined;
        const l = evaluate(nodePath.get('left') as NodePath);
        const r = evaluate(nodePath.get('right') as NodePath);
        return textOf(l) + textOf(r);
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const chain = memberChain(node);
        const direct = lookupConstant(constants, chain);
        if (direct !== undefined) return direct;
        if (!chain || chain.length < 2) return undefined;
        const member = namespaceMember(nodePath.scope, chain);
        let value = member ? valueAt(member) : valueAt(declaredValue(nodePath.scope, chain[0]));
        for (const key of chain.slice(member ? 2 : 1)) value = value !== null && typeof value === 'object' ? value[key] : undefined;
        return value;
      }
      case 'Identifier':
        return valueAt(declaredValue(nodePath.scope, node.name));
      case 'TSEnumDeclaration': {
        const members: Record<string, unknown> = {};
        for (const m of nodePath.get('members') as NodePath<any>[]) {
          const init = m.get('initializer') as NodePath;
          members[(m.node.id as NameNode).name ?? (m.node.id as NameNode).value!] = init.node ? evaluate(init) : undefined;
        }
        return members;
      }
      case 'ArrayExpression':
        return (nodePath.get('elements') as NodePath[]).map((e) => (e.node ? evaluate(e) : undefined));
      case 'ObjectExpression': {
        const obj: Record<string, unknown> = {};
        (nodePath.get('properties') as NodePath[]).forEach((p) => {
          if (p.isSpreadElement()) {
            const spread = evaluate(p.get('argument') as NodePath);
            if (spread && typeof spread === 'object') Object.assign(obj, spread);
            return;
          }
          if (p.node.type !== 'ObjectProperty' || p.node.computed) return;
          const key = (p.node.key as NameNode).name ?? (p.node.key as NameNode).value;
          obj[key!] = evaluate(p.get('value') as NodePath);
        });
        return obj;
      }
      case 'CallExpression': {
        if (node.callee.type === 'Identifier' && (config.passThroughCalls ?? []).includes(node.callee.name)) {
          return evaluate(nodePath.get('arguments.0') as NodePath);
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }

  const isJsonValue = (v: any): boolean =>
    v === null || ['string', 'boolean'].includes(typeof v) || Number.isFinite(v)
    || (Array.isArray(v) ? v.every(isJsonValue) : typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every(isJsonValue));

  // evaluate 는 모르는 조각을 빼거나 UNKNOWN 으로 바꾸므로, 값이 소스 그대로 다 읽히는지는 따로 본다.
  function lossless(p: NodePath<any>, seen = new Set<Node>()): boolean {
    switch (p.node.type) {
      case 'StringLiteral':
      case 'NumericLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
        return true;
      case 'TemplateLiteral':
        return (p.get('expressions') as NodePath[]).every((e) => lossless(e, seen) && ['string', 'number'].includes(typeof evaluate(e)));
      case 'ArrayExpression':
        return (p.get('elements') as NodePath[]).every((e) => e.node && !e.isSpreadElement() && lossless(e, seen));
      case 'ObjectExpression':
        return (p.get('properties') as NodePath[]).every((prop) => prop.isObjectProperty() && !prop.node.computed && lossless(prop.get('value'), seen));
      case 'Identifier':
        return declaredLossless(declaredValue(p.scope, p.node.name), seen);
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const chain = memberChain(p.node);
        const value = lookupConstant(constants, chain);
        if (value !== undefined) return isJsonValue(value);
        return chain?.length === 2 && declaredLossless(namespaceMember(p.scope, chain), seen);
      }
      case 'CallExpression':
        return p.node.callee.type === 'Identifier' && (config.passThroughCalls ?? []).includes(p.node.callee.name) && Boolean(p.node.arguments[0]) && lossless(p.get('arguments.0') as NodePath, seen);
      default:
        return false;
    }
  }

  function declaredLossless(value: NodePath | null, seen: Set<Node>) {
    if (!value || seen.has(value.node)) return false;
    seen.add(value.node);
    const whole = lossless(value, seen);
    seen.delete(value.node);
    return whole;
  }

  function constInit(nodePath: NodePath, name: string, seen: Set<Binding>) {
    const binding = nodePath.scope.getBinding(name);
    if (binding?.kind !== 'const' || seen.has(binding) || !binding.path.isVariableDeclarator() || !binding.path.get('id').isIdentifier()) return null;
    seen.add(binding);
    const init = binding.path.get('init');
    return init.node ? init : null;
  }

  function objectLiteral(nodePath: NodePath<any>, seen = new Set<Binding>()): NodePath<ObjectExpression> | null {
    if (nodePath.isObjectExpression()) return nodePath;
    const init = nodePath.isIdentifier() && constInit(nodePath, nodePath.node.name, seen);
    return init ? objectLiteral(init, seen) : null;
  }

  const propertyKey = (prop: NodePath<any>) => (prop.isObjectProperty() && !prop.node.computed ? keyName(prop.node) : undefined);

  const rootIdentifier = (p: NodePath): NodePath => (p.isMemberExpression() || p.isOptionalMemberExpression() ? rootIdentifier(p.get('object') as NodePath) : p);

  const memberName = (p: NodePath) => ((p.isMemberExpression() || p.isOptionalMemberExpression()) && !p.node.computed ? (p.node.property as Identifier).name : null);
  const isCallee = (ref: NodePath) => (ref.parentPath!.isCallExpression() || ref.parentPath!.isOptionalCallExpression()) && ref.key === 'callee';

  function functionName(fn: NodePath): Binding | undefined {
    const declarator = fn.parentPath!;
    const id = fn.isFunctionDeclaration() ? fn.node.id : declarator.isVariableDeclarator() && declarator.node.init === fn.node ? declarator.node.id : null;
    return id?.type === 'Identifier' ? declarator.scope.getBinding(id.name) : undefined;
  }

  const routeFileSet = new Set((config.routeFiles as string[]).map((f) => path.join(config.srcRoot, f)));

  function returnedValues(fn: NodePath<any>): NodePath[] {
    const body = fn.get('body') as NodePath<any>;
    if (!body.isBlockStatement()) return [body];
    const returned: NodePath[] = [];
    body.traverse({
      Function: (f) => f.skip(),
      ReturnStatement: (r) => {
        if (r.node.argument) returned.push(r.get('argument') as NodePath);
      },
    });
    return returned;
  }

  function attributeValue(p: NodePath<JSXElement>, name: string): NodePath | null | undefined {
    const found = p.get('openingElement.attributes').find((a) => (a.node as JSXAttribute).name?.name === name) as NodePath<JSXAttribute> | undefined;
    if (!found) return undefined;
    const value = found.get('value') as NodePath<any>;
    return value.node ? (value.isJSXExpressionContainer() ? value.get('expression') as NodePath : value) : null;
  }

  // 이름은 같은 파일의 const 나 import 한 값으로 따라간다.
  function literalAt(p: NodePath, seen = new Set<Node>()): NodePath<ObjectExpression | ArrayExpression> | null {
    if (p.isObjectExpression() || p.isArrayExpression()) return p;
    if (!p.isIdentifier() || seen.has(p.node)) return null;
    seen.add(p.node);
    const declared = declaredValue(p.scope, p.node.name);
    return declared ? literalAt(declared, seen) : null;
  }

  const objectAt = (p: NodePath) => {
    const found = literalAt(p);
    return found?.isObjectExpression() ? found : null;
  };

  const fileOf = (p: NodePath) => path.relative(config.srcRoot, programFile.get(p.scope.getProgramParent().block)!);

  // 읽지 못한 펼치기와 계산된 키는 null 로 그 자리에 둔다.
  function keysInOrder(object: NodePath<ObjectExpression>, seen = new Set<Node>()): (NodePath<ObjectProperty> | null)[] {
    return object.get('properties').flatMap((prop) => {
      if (prop.isObjectProperty()) return [prop.node.computed ? null : prop];
      if (!prop.isSpreadElement()) return [];
      const spread = objectAt(prop.get('argument'));
      if (!spread) return [null];
      return seen.has(spread.node) ? [] : keysInOrder(spread, seen.add(spread.node));
    });
  }

  const propertiesOf = (object: NodePath<ObjectExpression>) => keysInOrder(object).filter((prop) => prop !== null);

  const propertyValue = (object: NodePath<ObjectExpression>, key: string) => propertiesOf(object).findLast((prop) => keyName(prop.node) === key)?.get('value') as NodePath | undefined;

  const keyedValue = (object: NodePath<ObjectExpression>, keys: string[]) => keys.reduce<NodePath | undefined>((at, key) => {
    const inner = at && objectAt(at);
    return inner ? propertyValue(inner, key) : undefined;
  }, object);

  function declaredFunction(scope: Scope, name: string): AddressFunction | null {
    const binding = scope.getBinding(name);
    if (binding?.path.isFunctionDeclaration()) return binding.path;
    const from = binding?.kind === 'module' ? importedName(binding) : null;
    const exported = from && from.name !== '*' ? exportedFunction(from.file, from.name) : null;
    if (exported) return exported;
    const value = declaredValue(scope, name);
    return value?.isArrowFunctionExpression() || value?.isFunctionExpression() ? value : null;
  }

  function exportedDeclaration(file: string | null, name: string): NodePath | null {
    const found = file ? declaration(file, name) : null;
    const program = found && programOf(found.file);
    if (!program) return null;
    if (found!.name !== 'default') return program.scope.getBinding(found!.name)?.path ?? null;
    return (program.get('body').find((s) => s.isExportDefaultDeclaration())?.get('declaration') as NodePath | undefined) ?? null;
  }

  const exportedFunction = (file: string | null, name: string) => functionAt(exportedDeclaration(file, name));

  function functionAt(declared: NodePath | null | undefined): AddressFunction | null {
    if (declared?.isFunctionDeclaration()) return declared;
    const value = declared?.isVariableDeclarator() && declared.get('id').isIdentifier() && (declared.parent as VariableDeclaration).kind === 'const' ? declared.get('init') as NodePath : declared;
    return value?.isArrowFunctionExpression() || value?.isFunctionExpression() ? value : null;
  }

  let scripts: string[] | null = null;
  const importingCache = new WeakMap<Node, NodePath[]>();
  function importingCalls(fn: NodePath, named: Binding): NodePath[] {
    if (importingCache.has(fn.node)) return importingCache.get(fn.node)!;
    const calls: NodePath[] = [];
    const own = named.scope.path.isProgram() ? programFile.get(named.scope.block) : undefined;
    const names = own ? exportedNames(named) : [];
    for (const file of names.length ? (scripts ??= sourceFiles(config.srcRoot)) : []) {
      if (file === own) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!names.some((name) => text.includes(name))) continue;
      const program = programOf(file);
      for (const line of program?.get('body') ?? []) {
        if (!line.isImportDeclaration()) continue;
        for (const spec of line.get('specifiers')) {
          if (!spec.isImportSpecifier() || spec.node.importKind === 'type' || !names.includes(keyName({ key: spec.node.imported }))) continue;
          const binding = program!.scope.getBinding(spec.node.local.name);
          const from = binding && importedName(binding);
          if (from && exportedFunction(from.file, from.name)?.node === fn.node) calls.push(...binding!.referencePaths.filter(isCallee).sort((a, b) => a.node.start! - b.node.start!));
        }
      }
    }
    importingCache.set(fn.node, calls);
    return calls;
  }

  function exportedNames(named: Binding): string[] {
    const local = named.identifier.name;
    const declaration = named.path.isFunctionDeclaration() ? named.path : named.path.parentPath;
    const names = declaration?.parentPath?.isExportNamedDeclaration() ? [local] : [];
    for (const line of (named.scope.path as NodePath<Program>).get('body')) {
      if (!line.isExportNamedDeclaration() || line.node.source) continue;
      for (const spec of line.node.specifiers) if (spec.type === 'ExportSpecifier' && spec.local.name === local) names.push(keyName({ key: spec.exported }));
    }
    return names.filter((name) => name !== 'default');
  }

  function namespaceFunction(scope: Scope, chain: string[]) {
    const binding = scope.getBinding(chain[0]);
    const from = binding?.kind === 'module' ? importedName(binding) : null;
    return from?.name === '*' ? exportedFunction(from.file, chain[1]) : null;
  }

  // 파일을 적힌 그대로 다시 읽어, 타입으로만 가져온 이름마다 가져온 파일과 그 파일에서의 이름
  const typeImports = new Map<string, Map<string, { file: string | null; name: string }>>();
  function typeImport(file: string, name: string) {
    if (!typeImports.has(file)) {
      const found = new Map<string, { file: string | null; name: string }>();
      try {
        for (const line of parseSource(file, { asWritten: true }).ast.program.body) {
          if (line.type !== 'ImportDeclaration') continue;
          for (const spec of line.specifiers) {
            if (spec.type === 'ImportNamespaceSpecifier' || (line.importKind !== 'type' && (spec.type !== 'ImportSpecifier' || spec.importKind !== 'type'))) continue;
            const imported = spec.type === 'ImportDefaultSpecifier' ? 'default' : spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
            found.set(spec.local.name, { file: imports.resolve(file, line.source.value), name: imported });
          }
        }
      } catch {}
      typeImports.set(file, found);
    }
    return typeImports.get(file)!.get(name) ?? null;
  }

  function declaredClass(scope: Scope, name: string): NodePath<ClassDeclaration> | null {
    const binding = scope.getBinding(name);
    if (binding?.path.isClassDeclaration()) return binding.path;
    const file = binding ? null : programFile.get(scope.getProgramParent().block);
    const from = binding?.kind === 'module' ? importedName(binding) : file ? typeImport(file, name) : null;
    const declared = from && from.name !== '*' ? exportedDeclaration(from.file, from.name) : null;
    return declared?.isClassDeclaration() ? declared : null;
  }

  const LOOP_METHODS = ['map', 'flatMap', 'forEach', 'reduce'];
  const loopCallback = (a: NodePath) => {
    const callee = a.isFunction() && a.listKey === 'arguments' && (a.parent as CallExpression).callee;
    return Boolean(callee) && (callee as Node).type.endsWith('MemberExpression') && LOOP_METHODS.includes(((callee as MemberExpression).property as Identifier).name);
  };

  const tagOf = (name: JSXIdentifier | JSXMemberExpression | JSXNamespacedName): string | null => (name.type === 'JSXIdentifier' ? name.name
    : name.type === 'JSXMemberExpression' ? `${tagOf(name.object)}.${name.property.name}` : null);

  const unwrapCalls = (p: NodePath<any> | undefined) => {
    while (p?.isCallExpression()) p = p.get('arguments.0');
    return p;
  };

  const rel = (f: string | null | undefined) => (f ? path.relative(config.srcRoot, f) : null);

  return {
    imports, components, constants, apiModuleFiles, calledFiles, constantFileOf, routeChain, routeRoot, routeRest, constantModuleFiles, constantFiles, settingsRoots, routeTables, tableFiles, menuTables, tableRoutes, routeFileSet,
    mapOf, programFile, parse, importedFile, programOf, declaredValue, importedName, namespaceMember, textOf, evaluate, lossless,
    constInit, objectLiteral, propertyKey, rootIdentifier, memberName, isCallee, functionName, returnedValues, attributeValue, literalAt, objectAt, fileOf, keysInOrder, propertiesOf, propertyValue, keyedValue,
    declaredFunction, exportedDeclaration, functionAt, importingCalls, namespaceFunction, declaredClass, loopCallback, tagOf, unwrapCalls, rel,
  };
}
