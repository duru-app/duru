import _traverse from '@babel/traverse';
import type { Binding, NodePath, Scope } from '@babel/traverse';
import type { CallExpression, ExportSpecifier, Function as FunctionNode, Identifier, ImportDeclaration, ImportSpecifier, MemberExpression, Node, ObjectExpression, ObjectMethod, ObjectProperty, OptionalMemberExpression, Program, StringLiteral } from '@babel/types';
import { parseSource } from './parse.ts';
import type { ImportResolver } from './resolve.ts';

type Ending = { end: 'lost' | 'absent' | 'no-key' };
type Landed = { end: 'loaded' | 'made'; file: string };
type Reached = Ending | Landed;

interface Walk {
  path: Set<string>;
  absent: Set<string>;
  strict: boolean;
}

type Found = { file: string | null | undefined; followed: boolean };
type Resolve = ImportResolver['resolve'];
type NameNode = { name?: string; value?: string };

const traverse = _traverse.default ?? _traverse;
const SOURCE_FILE = /\.(jsx?|tsx?)$/;
const KEY_LIMIT = 8;
const HOP_LIMIT = 200;
const LOST: Ending = { end: 'lost' };
const ABSENT: Ending = { end: 'absent' };
const NO_KEY: Ending = { end: 'no-key' };
const UNREAD_ENTRY: Ending = { end: 'lost' };
const loaded = (file: string): Landed => ({ end: 'loaded', file });
const made = (file: string): Landed => ({ end: 'made', file });

const keyOf = (node: ObjectProperty | ObjectMethod) => (node.computed ? (node.key.type === 'StringLiteral' ? node.key.value : null) : String((node.key as NameNode).name ?? (node.key as NameNode).value));
const memberKey = ({ computed, property }: MemberExpression | OptionalMemberExpression) => (!computed ? (property as Identifier).name : property.type === 'StringLiteral' ? property.value : null);
const nameOf = (node: NameNode) => node.name ?? node.value as string;

function patternKeys(pattern: NodePath, identifier: Identifier): string[] | null {
  if (!pattern.isObjectPattern()) return null;
  for (const prop of pattern.get('properties')) {
    if (!prop.isObjectProperty()) continue;
    const key = keyOf(prop.node);
    const value = prop.get('value');
    const target = value.isAssignmentPattern() ? value.get('left') : value;
    if (target.node === identifier) return key === null ? null : [key];
    const deeper = patternKeys(target, identifier);
    if (deeper) return key === null ? null : [key, ...deeper];
  }
  return null;
}

function returnedBy(fn: NodePath<FunctionNode>) {
  const body = fn.get('body');
  if (!body.isBlockStatement()) return [body];
  const values: NodePath[] = [];
  body.traverse({
    Function(p) {
      p.skip();
    },
    ReturnStatement(p) {
      if (p.node.argument) values.push(p.get('argument') as NodePath);
    },
  });
  return values;
}

function keepsModule(handler: NodePath<FunctionNode>) {
  const fromParam = (value: NodePath): boolean => {
    if (value.isLogicalExpression()) return fromParam(value.get('left')) && fromParam(value.get('right'));
    let root = value;
    while (root.isMemberExpression() || root.isOptionalMemberExpression()) root = root.get('object') as NodePath;
    const binding = root.isIdentifier() ? root.scope.getBinding(root.node.name) : null;
    return binding?.kind === 'param' && binding.scope.path.node === handler.node;
  };
  return returnedBy(handler).some((value) => {
    const held = !value.isObjectExpression() ? null : value.get('properties').find((p) => !p.isSpreadElement() && keyOf(p.node as ObjectProperty) === 'default');
    return Boolean(held?.isObjectProperty()) && fromParam(held!.get('value') as NodePath);
  });
}

const returnsNothing = (value: Node | null | undefined) => !value || value.type === 'NullLiteral' || (value.type === 'Identifier' && value.name === 'undefined');

// followed 는 라우트 파일에 적힌 것만으로는 파일이 나오지 않아, 따라가서야 찾았다는 뜻이다.
export function componentFileFinder(resolve: Resolve) {
  const programs = new Map<string, NodePath<Program> | null>();

  function programOf(file: string) {
    if (!programs.has(file)) {
      let program: NodePath<Program> | null = null;
      if (SOURCE_FILE.test(file)) {
        traverse(parseSource(file).ast, {
          Program(p) {
            program = p;
            p.stop();
          },
        });
      }
      programs.set(file, program);
    }
    return programs.get(file);
  }

  const importedFile = (importPath: NodePath, file: string) => {
    const arg = (importPath.parentPath!.node as CallExpression).arguments?.[0];
    return arg?.type === 'StringLiteral' ? resolve(file, arg.value) : undefined;
  };

  function writtenFile(scope: Scope, name: string, fromFile: string) {
    const binding = scope.getBinding(name);
    if (!binding) return null;
    if (binding.kind === 'module') return resolve(fromFile, (binding.path.parent as ImportDeclaration).source.value);
    let found: string | null | undefined = null;
    binding.path.traverse({
      Import(p) {
        const target = importedFile(p, fromFile);
        if (target !== undefined) found = target;
      },
    });
    return found;
  }

  function moduleOf(value: NodePath, file: string): string | null | undefined {
    if (value.isAwaitExpression()) return moduleOf(value.get('argument'), file);
    if (!value.isCallExpression()) return null;
    const callee = value.get('callee');
    if (callee.isImport()) return importedFile(callee, file) ?? null;
    if (!callee.isMemberExpression() || callee.node.computed) return null;
    const method = (callee.node.property as Identifier).name;
    const handler = value.get('arguments')[0];
    const kept = method === 'catch' || method === 'finally' || (method === 'then' && Boolean(handler?.isFunction()) && keepsModule(handler as NodePath<FunctionNode>));
    return kept ? moduleOf(callee.get('object'), file) : null;
  }

  function loadedBy(fn: NodePath<FunctionNode>, file: string, strict: boolean): Landed | Ending | null {
    if (fn.node.params.length) return null;
    const returned = returnedBy(fn);
    if (returned.every((value) => returnsNothing(value.node))) return null;
    if (strict) {
      const direct = returned.map((value) => moduleOf(value, file)).filter((target) => target && SOURCE_FILE.test(target)).pop();
      return direct ? loaded(direct) : null;
    }
    const own = (p: NodePath) => p.getFunctionParent()!.node === fn.node;
    const inReturn = new Set(returned.map((value) => value.node));
    const returnedWith = (p: NodePath) => {
      for (let above = p.parentPath!; above.node !== fn.node; above = above.parentPath!) if (inReturn.has(above.node)) return true;
      return false;
    };
    let component = false;
    let deferred = false;
    let any = false;
    let last = null;
    fn.traverse({
      'JSXElement|JSXFragment'(p) {
        if (!own(p)) return;
        component = true;
        p.stop();
      },
      Import(p) {
        if (!own(p) && !returnedWith(p)) {
          deferred = true;
          return;
        }
        any = true;
        const target = importedFile(p, file);
        if (target && SOURCE_FILE.test(target)) last = target;
      },
    });
    if (component) return null;
    if (!any) return deferred ? LOST : null;
    return last ? loaded(last) : LOST;
  }

  function broughtIn(target: string, exported: string, keys: string[], ctx: Walk, viaCall: boolean): Reached {
    const reached = fromExport(target, exported, keys, ctx, viaCall);
    if (keys.length) return reached === ABSENT ? LOST : reached;
    return reached.end === 'loaded' ? reached : made(target);
  }

  function fromExport(file: string, name: string, keys: string[], ctx: Walk, viaCall: boolean): Reached {
    const program = programOf(file);
    if (!program) return keys.length ? LOST : made(file);
    const mark = `${file}#${name}#${keys.join('.')}#${viaCall}`;
    if (ctx.path.has(mark) || ctx.absent.has(mark)) return ABSENT;
    ctx.path.add(mark);
    try {
      const reached = exportedBy(program, file, name, keys, ctx, viaCall);
      if (reached === ABSENT) ctx.absent.add(mark);
      return reached;
    } finally {
      ctx.path.delete(mark);
    }
  }

  function exportedBy(program: NodePath<Program>, file: string, name: string, keys: string[], ctx: Walk, viaCall: boolean): Reached {
    const declaredHere = (reached: Reached) => (keys.length || reached.end === 'loaded' ? reached : made(file));
    const local = (localName: string): Reached => {
      const reached = fromName(program.scope, localName, keys, file, ctx, viaCall);
      return program.scope.getBinding(localName)?.kind === 'module' ? reached : declaredHere(reached);
    };
    const stars: string[] = [];
    for (const stmt of program.get('body')) {
      if (stmt.isExportAllDeclaration()) stars.push(stmt.node.source.value);
      else if (stmt.isExportDefaultDeclaration() && name === 'default') {
        const declaration = stmt.get('declaration');
        return declaration.isIdentifier() ? local(declaration.node.name) : declaredHere(fromValue(declaration, keys, file, ctx, viaCall));
      } else if (stmt.isExportNamedDeclaration()) {
        const source = stmt.node.source?.value;
        for (const spec of stmt.get('specifiers')) {
          if (nameOf(spec.node.exported) !== name) continue;
          if (!source) return local((spec.node as ExportSpecifier).local.name);
          const target = resolve(file, source);
          if (!target) return LOST;
          if (!spec.isExportNamespaceSpecifier()) return broughtIn(target, nameOf((spec.node as ExportSpecifier).local), keys, ctx, viaCall);
          const reached = keys.length ? fromExport(target, keys[0], keys.slice(1), ctx, viaCall) : LOST;
          return reached === ABSENT ? LOST : reached;
        }
        const declaration = stmt.get('declaration');
        if (declaration.node && Object.hasOwn(declaration.getBindingIdentifiers(), name)) return local(name);
      }
    }
    if (name === 'default') return ABSENT;
    for (const source of stars) {
      const target = resolve(file, source);
      const reached = target ? fromExport(target, name, keys, ctx, viaCall) : ABSENT;
      if (reached !== ABSENT) return reached;
    }
    return ABSENT;
  }

  function fromName(scope: Scope, name: string, keys: string[], file: string, ctx: Walk, viaCall: boolean): Reached {
    const binding = scope.getBinding(name);
    if (!binding || keys.length > KEY_LIMIT || ctx.path.size > HOP_LIMIT) return LOST;
    const mark = `${file}:${binding.identifier.start}#${keys.join('.')}#${viaCall}`;
    if (ctx.path.has(mark)) return LOST;
    ctx.path.add(mark);
    try {
      return declaredBy(binding, keys, file, ctx, viaCall);
    } finally {
      ctx.path.delete(mark);
    }
  }

  function declaredBy(binding: Binding, keys: string[], file: string, ctx: Walk, viaCall: boolean): Reached {
    const declared = binding.path;
    if (binding.kind === 'module') {
      const target = resolve(file, (declared.parent as ImportDeclaration).source.value);
      if (!target) return LOST;
      if (!declared.isImportNamespaceSpecifier()) return broughtIn(target, declared.isImportDefaultSpecifier() ? 'default' : nameOf((declared.node as ImportSpecifier).imported), keys, ctx, viaCall);
      const reached = keys.length ? fromExport(target, keys[0], keys.slice(1), ctx, viaCall) : LOST;
      return reached === ABSENT ? LOST : reached;
    }
    if (declared.isFunctionDeclaration() || declared.isClassDeclaration()) return fromValue(declared, keys, file, ctx, viaCall);
    if (!declared.isVariableDeclarator() || !binding.constant || !declared.node.init) return LOST;
    const id = declared.get('id');
    const taken = id.isIdentifier() ? [] : patternKeys(id, binding.identifier);
    return taken ? fromValue(declared.get('init') as NodePath, [...taken, ...keys], file, ctx, viaCall) : LOST;
  }

  function fromProperty(object: NodePath<ObjectExpression>, keys: string[], file: string, ctx: Walk, viaCall: boolean): Reached {
    for (const prop of object.get('properties').reverse()) {
      if (prop.isSpreadElement()) {
        const reached = fromValue(prop.get('argument'), keys, file, ctx, viaCall);
        if (reached !== LOST && reached !== NO_KEY) return reached;
        continue;
      }
      const key = keyOf(prop.node as ObjectProperty);
      if (key === null) return UNREAD_ENTRY;
      if (key !== keys[0]) continue;
      const reached = fromValue(prop.isObjectMethod() ? prop : prop.get('value'), keys.slice(1), file, ctx, viaCall);
      return reached === LOST || reached === NO_KEY ? UNREAD_ENTRY : reached;
    }
    return NO_KEY;
  }

  function fromValue(value: NodePath, keys: string[], file: string, ctx: Walk, viaCall: boolean): Reached {
    if (value.isIdentifier()) return fromName(value.scope, value.node.name, keys, file, ctx, viaCall);
    if (value.isMemberExpression() || value.isOptionalMemberExpression()) {
      const key = memberKey(value.node);
      return key === null ? LOST : fromValue(value.get('object') as NodePath, [key, ...keys], file, ctx, viaCall);
    }
    if (value.isObjectExpression()) {
      if (keys.length) return fromProperty(value, keys, file, ctx, viaCall);
      const reached = viaCall && !ctx.strict ? fromProperty(value, ['loader'], file, ctx, true) : LOST;
      return reached.end === 'loaded' ? reached : LOST;
    }
    if (value.isCallExpression()) {
      const first = value.get('arguments')[0];
      return first && !first.isSpreadElement() ? fromValue(first, keys, file, ctx, true) : LOST;
    }
    if (keys.length) return LOST;
    if (value.isFunction()) return (viaCall && loadedBy(value, file, ctx.strict)) || made(file);
    return value.isClass() || value.isTaggedTemplateExpression() ? made(file) : LOST;
  }

  function find(scope: Scope, name: string, fromFile: string, viaCall = false): Found {
    const [root, ...keys] = name.split('.');
    const written = keys.length ? null : writtenFile(scope, root, fromFile);
    if (written && scope.getBinding(root)!.kind !== 'module') return { file: written, followed: false };
    const reached = fromName(scope, root, keys, fromFile, { path: new Set(), absent: new Set(), strict: Boolean(written) }, viaCall);
    if (reached.end === 'loaded') return { file: reached.file, followed: !written };
    if (written) return { file: written, followed: false };
    const file = reached.end === 'made' && reached.file !== fromFile ? reached.file : null;
    return { file, followed: Boolean(file) };
  }

  return { find };
}
