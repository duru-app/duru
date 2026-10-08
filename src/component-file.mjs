import _traverse from '@babel/traverse';
import { parseSource } from './parse.ts';

const traverse = _traverse.default ?? _traverse;
const SOURCE_FILE = /\.(jsx?|tsx?)$/;
const KEY_LIMIT = 8;
const HOP_LIMIT = 200;
const LOST = { end: 'lost' };
const ABSENT = { end: 'absent' };
const NO_KEY = { end: 'no-key' };
const UNREAD_ENTRY = { end: 'lost' };
const loaded = (file) => ({ end: 'loaded', file });
const made = (file) => ({ end: 'made', file });

const keyOf = (node) => (node.computed ? (node.key.type === 'StringLiteral' ? node.key.value : null) : String(node.key.name ?? node.key.value));
const memberKey = ({ computed, property }) => (!computed ? property.name : property.type === 'StringLiteral' ? property.value : null);
const nameOf = (node) => node.name ?? node.value;

function patternKeys(pattern, identifier) {
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

function returnedBy(fn) {
  const body = fn.get('body');
  if (!body.isBlockStatement()) return [body];
  const values = [];
  body.traverse({
    Function(p) {
      p.skip();
    },
    ReturnStatement(p) {
      if (p.node.argument) values.push(p.get('argument'));
    },
  });
  return values;
}

function keepsModule(handler) {
  const fromParam = (value) => {
    if (value.isLogicalExpression()) return fromParam(value.get('left')) && fromParam(value.get('right'));
    let root = value;
    while (root.isMemberExpression() || root.isOptionalMemberExpression()) root = root.get('object');
    const binding = root.isIdentifier() ? root.scope.getBinding(root.node.name) : null;
    return binding?.kind === 'param' && binding.scope.path.node === handler.node;
  };
  return returnedBy(handler).some((value) => {
    const held = !value.isObjectExpression() ? null : value.get('properties').find((p) => !p.isSpreadElement() && keyOf(p.node) === 'default');
    return Boolean(held?.isObjectProperty()) && fromParam(held.get('value'));
  });
}

const returnsNothing = (value) => !value || value.type === 'NullLiteral' || (value.type === 'Identifier' && value.name === 'undefined');

// followed 는 라우트 파일에 적힌 것만으로는 파일이 나오지 않아, 따라가서야 찾았다는 뜻이다.
export function componentFileFinder(resolve) {
  const programs = new Map();

  function programOf(file) {
    if (!programs.has(file)) {
      let program = null;
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

  const importedFile = (importPath, file) => {
    const arg = importPath.parentPath.node.arguments?.[0];
    return arg?.type === 'StringLiteral' ? resolve(file, arg.value) : undefined;
  };

  function writtenFile(scope, name, fromFile) {
    const binding = scope.getBinding(name);
    if (!binding) return null;
    if (binding.kind === 'module') return resolve(fromFile, binding.path.parent.source.value);
    let found = null;
    binding.path.traverse({
      Import(p) {
        const target = importedFile(p, fromFile);
        if (target !== undefined) found = target;
      },
    });
    return found;
  }

  function moduleOf(value, file) {
    if (value.isAwaitExpression()) return moduleOf(value.get('argument'), file);
    if (!value.isCallExpression()) return null;
    const callee = value.get('callee');
    if (callee.isImport()) return importedFile(callee, file) ?? null;
    if (!callee.isMemberExpression() || callee.node.computed) return null;
    const method = callee.node.property.name;
    const handler = value.get('arguments')[0];
    const kept = method === 'catch' || method === 'finally' || (method === 'then' && Boolean(handler?.isFunction()) && keepsModule(handler));
    return kept ? moduleOf(callee.get('object'), file) : null;
  }

  function loadedBy(fn, file, strict) {
    if (fn.node.params.length) return null;
    const returned = returnedBy(fn);
    if (returned.every((value) => returnsNothing(value.node))) return null;
    if (strict) {
      const direct = returned.map((value) => moduleOf(value, file)).filter((target) => target && SOURCE_FILE.test(target)).pop();
      return direct ? loaded(direct) : null;
    }
    const own = (p) => p.getFunctionParent().node === fn.node;
    const inReturn = new Set(returned.map((value) => value.node));
    const returnedWith = (p) => {
      for (let above = p.parentPath; above.node !== fn.node; above = above.parentPath) if (inReturn.has(above.node)) return true;
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

  function broughtIn(target, exported, keys, ctx, viaCall) {
    const reached = fromExport(target, exported, keys, ctx, viaCall);
    if (keys.length) return reached === ABSENT ? LOST : reached;
    return reached.end === 'loaded' ? reached : made(target);
  }

  function fromExport(file, name, keys, ctx, viaCall) {
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

  function exportedBy(program, file, name, keys, ctx, viaCall) {
    const declaredHere = (reached) => (keys.length || reached.end === 'loaded' ? reached : made(file));
    const local = (localName) => {
      const reached = fromName(program.scope, localName, keys, file, ctx, viaCall);
      return program.scope.getBinding(localName)?.kind === 'module' ? reached : declaredHere(reached);
    };
    const stars = [];
    for (const stmt of program.get('body')) {
      if (stmt.isExportAllDeclaration()) stars.push(stmt.node.source.value);
      else if (stmt.isExportDefaultDeclaration() && name === 'default') {
        const declaration = stmt.get('declaration');
        return declaration.isIdentifier() ? local(declaration.node.name) : declaredHere(fromValue(declaration, keys, file, ctx, viaCall));
      } else if (stmt.isExportNamedDeclaration()) {
        const source = stmt.node.source?.value;
        for (const spec of stmt.get('specifiers')) {
          if (nameOf(spec.node.exported) !== name) continue;
          if (!source) return local(spec.node.local.name);
          const target = resolve(file, source);
          if (!target) return LOST;
          if (!spec.isExportNamespaceSpecifier()) return broughtIn(target, nameOf(spec.node.local), keys, ctx, viaCall);
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

  function fromName(scope, name, keys, file, ctx, viaCall) {
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

  function declaredBy(binding, keys, file, ctx, viaCall) {
    const declared = binding.path;
    if (binding.kind === 'module') {
      const target = resolve(file, declared.parent.source.value);
      if (!target) return LOST;
      if (!declared.isImportNamespaceSpecifier()) return broughtIn(target, declared.isImportDefaultSpecifier() ? 'default' : nameOf(declared.node.imported), keys, ctx, viaCall);
      const reached = keys.length ? fromExport(target, keys[0], keys.slice(1), ctx, viaCall) : LOST;
      return reached === ABSENT ? LOST : reached;
    }
    if (declared.isFunctionDeclaration() || declared.isClassDeclaration()) return fromValue(declared, keys, file, ctx, viaCall);
    if (!declared.isVariableDeclarator() || !binding.constant || !declared.node.init) return LOST;
    const id = declared.get('id');
    const taken = id.isIdentifier() ? [] : patternKeys(id, binding.identifier);
    return taken ? fromValue(declared.get('init'), [...taken, ...keys], file, ctx, viaCall) : LOST;
  }

  function fromProperty(object, keys, file, ctx, viaCall) {
    for (const prop of object.get('properties').reverse()) {
      if (prop.isSpreadElement()) {
        const reached = fromValue(prop.get('argument'), keys, file, ctx, viaCall);
        if (reached !== LOST && reached !== NO_KEY) return reached;
        continue;
      }
      const key = keyOf(prop.node);
      if (key === null) return UNREAD_ENTRY;
      if (key !== keys[0]) continue;
      const reached = fromValue(prop.isObjectMethod() ? prop : prop.get('value'), keys.slice(1), file, ctx, viaCall);
      return reached === LOST || reached === NO_KEY ? UNREAD_ENTRY : reached;
    }
    return NO_KEY;
  }

  function fromValue(value, keys, file, ctx, viaCall) {
    if (value.isIdentifier()) return fromName(value.scope, value.node.name, keys, file, ctx, viaCall);
    if (value.isMemberExpression() || value.isOptionalMemberExpression()) {
      const key = memberKey(value.node);
      return key === null ? LOST : fromValue(value.get('object'), [key, ...keys], file, ctx, viaCall);
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

  function find(scope, name, fromFile, viaCall = false) {
    const [root, ...keys] = name.split('.');
    const written = keys.length ? null : writtenFile(scope, root, fromFile);
    if (written && scope.getBinding(root).kind !== 'module') return { file: written, followed: false };
    const reached = fromName(scope, root, keys, fromFile, { path: new Set(), absent: new Set(), strict: Boolean(written) }, viaCall);
    if (reached.end === 'loaded') return { file: reached.file, followed: !written };
    if (written) return { file: written, followed: false };
    const file = reached.end === 'made' && reached.file !== fromFile ? reached.file : null;
    return { file, followed: Boolean(file) };
  }

  return { find };
}
