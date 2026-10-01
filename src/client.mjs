import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { loadConstants } from './constants.mjs';
import { resolveImport } from './resolve.mjs';

const traverse = _traverse.default ?? _traverse;
const PARSER_PLUGINS = ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport'];
export const UNKNOWN = '{?}';
const GUARD_TEXT_LIMIT = 160;

function parseFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  return { src, ast: parse(src, { sourceType: 'module', plugins: PARSER_PLUGINS, errorRecovery: true }) };
}

export function memberChain(node) {
  const names = [];
  let cur = node;
  while (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
    if (cur.computed) return null;
    names.unshift(cur.property.name);
    cur = cur.object;
  }
  if (cur.type !== 'Identifier') return null;
  names.unshift(cur.name);
  return names;
}

function sliceText(src, node) {
  const text = src.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
  return text.length > GUARD_TEXT_LIMIT ? text.slice(0, GUARD_TEXT_LIMIT) + '…' : text;
}

export function lookupConstant(constants, chain) {
  if (!chain || !Object.hasOwn(constants, chain[0])) return undefined;
  let value = constants[chain[0]];
  for (const key of chain.slice(1)) {
    if (value == null) return undefined;
    value = value[key];
  }
  return value;
}

const initCache = new WeakMap();

function constInits(exprPath, src) {
  if (initCache.has(exprPath.node)) return initCache.get(exprPath.node);
  const found = [];
  const seen = new Set();
  const follow = (p) => {
    const ids = p.isIdentifier() ? [p] : [];
    p.traverse({ Identifier: (id) => void ids.push(id) });
    for (const id of ids) {
      const binding = id.isReferencedIdentifier() && id.scope.getBinding(id.node.name);
      if (!binding || binding.kind !== 'const' || seen.has(binding)) continue;
      seen.add(binding);
      const init = binding.path.isVariableDeclarator() && binding.path.get('init');
      if (!init?.node) continue;
      const declared = binding.path.node.id;
      found.push({ name: declared.type === 'Identifier' ? declared.name : null, init: src.slice(init.node.start, init.node.end) });
      follow(init);
    }
  };
  follow(exprPath);
  initCache.set(exprPath.node, found);
  return found;
}

// 이 노드가 렌더되거나 실행되려면 참이어야 하는 조건들을 파일 안에서 거슬러 올라가며 모은다.
function guardsOf(nodePath, src, inits) {
  const guards = [];
  // source 는 줄이지 않은 조건이다. 다른 조건이 같은 글자로 줄어들면 어느 것인지 모르므로 비운다.
  const add = (text, exprPath, source) => {
    guards.push(text);
    const found = constInits(exprPath, src);
    const known = inits.get(text);
    if (!known) return void inits.set(text, { source, inits: [...found] });
    if (known.source !== source) known.source = null;
    known.inits.push(...found.filter((f) => !known.inits.some((k) => k.name === f.name && k.init === f.init)));
  };
  let child = nodePath;
  let parent = nodePath.parentPath;
  while (parent) {
    const p = parent.node;
    if (p.type === 'LogicalExpression' && p.operator === '&&' && child.key === 'right') {
      add(sliceText(src, p.left), parent.get('left'), src.slice(p.left.start, p.left.end));
    } else if ((p.type === 'ConditionalExpression' || p.type === 'IfStatement') && child.key !== 'test') {
      const t = sliceText(src, p.test);
      const s = src.slice(p.test.start, p.test.end);
      if (child.key === 'consequent') add(t, parent.get('test'), s);
      else add(`!(${t})`, parent.get('test'), `!(${s})`);
    }
    child = parent;
    parent = parent.parentPath;
  }
  return guards;
}

function enclosingFunctionName(nodePath) {
  const fn = nodePath.getFunctionParent();
  if (!fn) return null;
  if (fn.parentPath?.isVariableDeclarator() && fn.parentPath.node.id.type === 'Identifier') {
    return { name: fn.parentPath.node.id.name, fnPath: fn };
  }
  if (fn.isFunctionDeclaration() && fn.node.id) return { name: fn.node.id.name, fnPath: fn };
  return null;
}

// 화면마다 라우트 조건 · import 로 이어지는 파일의 API 호출 · 설정값 읽기 · 링크를 모으고, API 모듈의 함수별 endpoint 를 함께 돌려준다.
export async function extractClient(config) {
  const constants = await loadConstants(config);
  const apiModuleFiles = new Set(config.apiModules.map((rel) => path.join(config.srcRoot, rel)));
  const constantFiles = new Set(Object.values(config.constants).map((rel) => path.join(config.srcRoot, rel)));
  const settingsRoots = new Set(config.settingsRoots);
  const [routeRoot, ...routeRest] = config.routeConstant.split('.');
  const guardInits = new Map();
  const initsOf = (file) => {
    if (!guardInits.has(file)) guardInits.set(file, new Map());
    return guardInits.get(file);
  };

  // 상수·템플릿·문자열 결합·지역 const 까지만 따라가 값을 만든다. 모르는 조각은 UNKNOWN 으로 남긴다.
  function evaluate(nodePath) {
    const node = nodePath.node;
    switch (node.type) {
      case 'StringLiteral':
        return node.value;
      case 'NumericLiteral':
        return String(node.value);
      case 'TemplateLiteral': {
        let out = '';
        node.quasis.forEach((q, i) => {
          out += q.value.cooked;
          if (i < node.expressions.length) {
            const v = evaluate(nodePath.get(`expressions.${i}`));
            out += typeof v === 'string' ? v : UNKNOWN;
          }
        });
        return out;
      }
      case 'BinaryExpression': {
        if (node.operator !== '+') return undefined;
        const l = evaluate(nodePath.get('left'));
        const r = evaluate(nodePath.get('right'));
        return (typeof l === 'string' ? l : UNKNOWN) + (typeof r === 'string' ? r : UNKNOWN);
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const chain = memberChain(node);
        const direct = lookupConstant(constants, chain);
        if (direct !== undefined) return direct;
        if (chain && chain.length > 1) {
          const base = evaluateIdentifier(nodePath.scope, chain[0]);
          if (base && typeof base === 'object') {
            let value = base;
            for (const key of chain.slice(1)) value = value?.[key];
            return value;
          }
        }
        return undefined;
      }
      case 'Identifier':
        return evaluateIdentifier(nodePath.scope, node.name);
      case 'ArrayExpression':
        return nodePath.get('elements').map((e) => (e.node ? evaluate(e) : undefined));
      case 'ObjectExpression': {
        const obj = {};
        nodePath.get('properties').forEach((p) => {
          if (p.isSpreadElement()) {
            const spread = evaluate(p.get('argument'));
            if (spread && typeof spread === 'object') Object.assign(obj, spread);
            return;
          }
          if (p.node.type !== 'ObjectProperty' || p.node.computed) return;
          const key = p.node.key.name ?? p.node.key.value;
          obj[key] = evaluate(p.get('value'));
        });
        return obj;
      }
      case 'CallExpression': {
        if (node.callee.type === 'Identifier' && (config.passThroughCalls ?? []).includes(node.callee.name)) {
          return evaluate(nodePath.get('arguments.0'));
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }

  function evaluateIdentifier(scope, name) {
    const binding = scope.getBinding(name);
    if (!binding || binding.kind !== 'const' || !binding.path.isVariableDeclarator()) return undefined;
    const init = binding.path.get('init');
    return init.node ? evaluate(init) : undefined;
  }

  function loadSettingsDefaults() {
    const values = {};
    for (const [root, { file, const: name }] of Object.entries(config.settingsDefaults ?? {})) {
      const { ast } = parseFile(path.join(config.srcRoot, file));
      let init = null;
      traverse(ast, {
        VariableDeclarator(p) {
          if (p.parent.kind !== 'const' || !p.scope.path.isProgram() || !p.get('id').isIdentifier({ name })) return;
          if (p.get('init').isObjectExpression()) init = p.get('init');
          p.stop();
        },
      });
      if (!init) throw new Error(`settingsDefaults.${root}: ${file} has no top-level const ${name} holding an object`);
      values[root] = evaluate(init);
    }
    return values;
  }

  const settingsDefaults = loadSettingsDefaults();

  function constInit(nodePath, name, seen) {
    const binding = nodePath.scope.getBinding(name);
    if (binding?.kind !== 'const' || seen.has(binding) || !binding.path.isVariableDeclarator() || !binding.path.get('id').isIdentifier()) return null;
    seen.add(binding);
    const init = binding.path.get('init');
    return init.node ? init : null;
  }

  function objectLiteral(nodePath, seen = new Set()) {
    if (nodePath.isObjectExpression()) return nodePath;
    const init = nodePath.isIdentifier() && constInit(nodePath, nodePath.node.name, seen);
    return init ? objectLiteral(init, seen) : null;
  }

  const keyName = (node) => String(node.key.name ?? node.key.value);
  const propertyKey = (prop) => (prop.isObjectProperty() && !prop.node.computed ? keyName(prop.node) : undefined);
  const isUseState = (callee) =>
    (callee.type === 'Identifier' && callee.name === 'useState') || (callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'useState');

  function isToggle(value) {
    if (value.isBooleanLiteral()) return true;
    if (!value.isIdentifier()) return false;
    const binding = value.scope.getBinding(value.node.name);
    if (binding?.kind !== 'const' || !binding.path.isVariableDeclarator()) return false;
    const { id, init } = binding.path.node;
    if (id.type === 'Identifier') return init?.type === 'BooleanLiteral';
    return (
      id.type === 'ArrayPattern' &&
      id.elements[0]?.type === 'Identifier' &&
      id.elements[0].name === value.node.name &&
      init?.type === 'CallExpression' &&
      isUseState(init.callee) &&
      init.arguments[0]?.type === 'BooleanLiteral'
    );
  }

  const mayOverride = (later, key) => later.isSpreadElement() || later.node.computed || keyName(later.node) === key;
  function overridden(props, i) {
    const key = propertyKey(props[i]);
    return props.slice(i + 1).some((later) => mayOverride(later, key));
  }

  function bodyOptions(callPath) {
    const options = [];
    for (const arg of callPath.get('arguments')) {
      const obj = objectLiteral(arg);
      if (!obj) continue;
      const outer = obj.get('properties');
      const at = outer.findLastIndex((p) => config.bodyArgKeys.includes(propertyKey(p)));
      if (at >= 0 && overridden(outer, at)) continue;
      const body = at >= 0 ? objectLiteral(outer[at].get('value')) : obj;
      const props = body?.get('properties') ?? [];
      props.forEach((prop, i) => {
        const key = propertyKey(prop);
        if (key !== undefined && isToggle(prop.get('value')) && !overridden(props, i)) options.push({ key, line: prop.node.loc.start.line });
      });
    }
    return options;
  }

  // MENUS.ADMIN?.LIST → globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST
  function settingsPath(nodePath, seen = new Set()) {
    const chain = memberChain(nodePath.node);
    if (!chain) return null;
    if (Object.hasOwn(settingsDefaults, chain[0])) return chain;
    const init = constInit(nodePath, chain[0], seen);
    const base = init && settingsPath(init, seen);
    return base ? [...base, ...chain.slice(1)] : null;
  }

  function listedRoutes(p) {
    if (memberChain(p.node.object)?.join('.') !== config.routeConstant) return [];
    const key = p.get('property');
    const binding = key.isIdentifier() && key.scope.getBinding(key.node.name);
    if (binding?.kind !== 'param' || binding.path.listKey !== 'params' || binding.path.key !== 0) return [];
    const fn = binding.path.parentPath;
    const call = fn.parentPath;
    if (!(call.isCallExpression() || call.isOptionalCallExpression()) || fn.listKey !== 'arguments' || fn.key !== 0) return [];
    const callee = call.get('callee');
    if (!(callee.isMemberExpression() || callee.isOptionalMemberExpression()) || callee.node.computed) return [];
    if (!['forEach', 'map'].includes(callee.node.property.name)) return [];
    const chain = settingsPath(callee.get('object'));
    const list = chain?.slice(1).reduce((v, k) => v?.[k], settingsDefaults[chain[0]]);
    if (!Array.isArray(list)) return [];
    return [...new Set(list)]
      .filter((entry) => typeof entry === 'string' && Object.hasOwn(routeValues, entry))
      .map((entry) => ({ route: entry, guard: `${chain.join('.')} includes '${entry}'` }));
  }

  // ---------- API 모듈: 내보낸 함수마다 호출하는 endpoint ----------

  function extractApiModule(file) {
    const { ast } = parseFile(file);
    const fns = {};
    traverse(ast, {
      ExportNamedDeclaration(exp) {
        const decl = exp.get('declaration');
        if (!decl.isVariableDeclaration()) return;
        for (const d of decl.get('declarations')) {
          const name = d.node.id.name;
          const endpoints = [];
          const delegates = new Set();
          d.traverse({
            ObjectExpression(obj) {
              const keys = obj.node.properties.map((p) => p.key?.name ?? p.key?.value);
              if (!keys.includes('URL')) return;
              const value = evaluate(obj);
              endpoints.push({ method: value?.METHOD ?? null, url: value?.URL ?? null, line: obj.node.loc.start.line });
            },
            MemberExpression(m) {
              if (m.parentPath.isMemberExpression({ object: m.node })) return;
              const value = lookupConstant(constants, memberChain(m.node));
              if (value && typeof value === 'object' && 'URL' in value) {
                endpoints.push({ method: value.METHOD ?? null, url: value.URL, line: m.node.loc.start.line });
              }
            },
            CallExpression(c) {
              if (c.node.callee.type === 'Identifier') delegates.add(c.node.callee.name);
            },
          });
          fns[name] = { file: path.relative(config.srcRoot, file), line: d.node.loc.start.line, endpoints, delegates: [...delegates] };
        }
      },
    });
    for (const fn of Object.values(fns)) {
      for (const callee of fn.delegates) {
        if (fns[callee] && fns[callee] !== fn) fn.endpoints.push(...fns[callee].endpoints.map((e) => ({ ...e, via: callee })));
      }
      delete fn.delegates;
      const seen = new Set();
      fn.endpoints = fn.endpoints.filter((e) => {
        const key = JSON.stringify([e.method, e.url, e.via ?? null]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return fns;
  }

  // ---------- 일반 파일: import · API 호출 · 설정 읽기 · 라우트 참조 ----------

  const factCache = new Map();

  function fileFacts(file) {
    if (factCache.has(file)) return factCache.get(file);
    const { src, ast } = parseFile(file);
    const facts = { imports: [], apiCalls: [], settingReads: [], routeRefs: [] };
    const apiNamed = new Map();
    const apiNamespaces = new Set();
    const localFnRefs = new Map();
    const inits = initsOf(path.relative(config.srcRoot, file));

    function record(kind, entry, nodePath, ownGuards = []) {
      const guards = [...ownGuards, ...guardsOf(nodePath, src, inits)];
      const owner = enclosingFunctionName(nodePath);
      const item = { ...entry, line: nodePath.node.loc.start.line, guards };
      facts[kind].push(item);
      if (owner) {
        if (!localFnRefs.has(owner.name)) localFnRefs.set(owner.name, { fnPath: owner.fnPath, items: [] });
        localFnRefs.get(owner.name).items.push(item);
      }
    }

    traverse(ast, {
      ImportDeclaration(p) {
        const spec = p.node.source.value;
        const resolved = resolveImport(config.srcRoot, file, spec);
        if (!resolved) return;
        facts.imports.push(resolved);
        if (apiModuleFiles.has(resolved)) {
          for (const s of p.node.specifiers) {
            if (s.type === 'ImportSpecifier') apiNamed.set(s.local.name, s.imported.name);
            else apiNamespaces.add(s.local.name);
          }
        }
      },
      Import(p) {
        const arg = p.parentPath.node.arguments?.[0];
        if (arg?.type !== 'StringLiteral') return;
        const resolved = resolveImport(config.srcRoot, file, arg.value);
        if (resolved) facts.imports.push(resolved);
      },
    });

    traverse(ast, {
      CallExpression(p) {
        const callee = p.node.callee;
        if (callee.type === 'Identifier' && apiNamed.has(callee.name)) {
          record('apiCalls', { fn: apiNamed.get(callee.name), options: bodyOptions(p) }, p);
        } else if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && apiNamespaces.has(callee.object.name)) {
          record('apiCalls', { fn: callee.property.name, options: bodyOptions(p) }, p);
        }
      },
      'MemberExpression|OptionalMemberExpression'(p) {
        const parent = p.parentPath;
        if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === p.node) return;
        const chain = memberChain(p.node);
        if (!chain) {
          if (p.node.computed) for (const r of listedRoutes(p)) record('routeRefs', { route: r.route }, p, [r.guard]);
          return;
        }
        if (settingsRoots.has(chain[0]) && chain.length >= 3) {
          record('settingReads', { key: chain.slice(1).join('.') }, p);
        } else if (chain[0] === routeRoot && chain.length === routeRest.length + 2 && routeRest.every((k, i) => chain[i + 1] === k)) {
          record('routeRefs', { route: chain[chain.length - 1] }, p);
        }
      },
    });

    // 지역 함수가 조건 안에서 이름으로 쓰이면(예: onClick={openHelp}) 그 조건을 함수 안의 참조에도 붙인다.
    traverse(ast, {
      Identifier(p) {
        const target = localFnRefs.get(p.node.name);
        if (!target || !p.isReferencedIdentifier()) return;
        if (p.findParent((a) => a === target.fnPath)) return;
        const outer = guardsOf(p, src, inits);
        for (const item of target.items) {
          item.inheritedGuards ??= [];
          item.inheritedGuards.push({ via: p.node.name, line: p.node.loc.start.line, guards: outer });
        }
      },
    });

    facts.imports = [...new Set(facts.imports)];
    factCache.set(file, facts);
    return facts;
  }

  function closureOf(entryFile) {
    const seen = new Set();
    const stack = [entryFile];
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f) || apiModuleFiles.has(f) || constantFiles.has(f)) continue;
      if (!/\.(jsx?|tsx?)$/.test(f)) continue;
      seen.add(f);
      for (const dep of fileFacts(f).imports) stack.push(dep);
    }
    return [...seen];
  }

  // ---------- 라우트 파일: 화면 목록과 화면에 걸린 조건 ----------

  const redirects = [];

  function extractScreens(routesFile) {
    const { src, ast } = parseFile(routesFile);
    const inits = initsOf(config.routesFile);
    const screens = [];
    traverse(ast, {
      JSXElement(p) {
        const opening = p.node.openingElement;
        if (opening.name.type !== 'JSXIdentifier') return;
        const attr = (name) => p.get('openingElement.attributes').find((a) => a.node.name?.name === name);
        if (config.redirectElements.includes(opening.name.name)) {
          const toValue = attr('to')?.get('value');
          const to = toValue && evaluate(toValue.isJSXExpressionContainer() ? toValue.get('expression') : toValue);
          redirects.push({ to: typeof to === 'string' ? to : UNKNOWN, line: p.node.loc.start.line, guards: guardsOf(p, src, inits) });
          return;
        }
        if (!config.routeElements.includes(opening.name.name)) return;
        const pathAttr = attr('path');
        const compAttr = attr('component');
        if (!pathAttr || !compAttr) return;
        const pathValue = evaluate(pathAttr.get('value.expression')) ?? evaluate(pathAttr.get('value'));
        let compExpr = compAttr.get('value.expression');
        if (compExpr.isCallExpression()) compExpr = compExpr.get('arguments.0');
        const compName = compExpr.node.name;
        screens.push({
          path: typeof pathValue === 'string' ? pathValue : UNKNOWN,
          component: compName,
          componentFile: resolveComponent(p.scope, compName, routesFile),
          wrapperFiles: wrappersOf(p, routesFile),
          routeGuards: guardsOf(p, src, inits),
          line: p.node.loc.start.line,
        });
      },
    });
    return screens;
  }

  function wrappersOf(routePath, routesFile) {
    const files = [];
    for (let a = routePath.parentPath; a; a = a.parentPath) {
      const name = a.isJSXElement() && a.node.openingElement.name;
      if (name?.type !== 'JSXIdentifier') continue;
      const file = resolveComponent(a.scope, name.name, routesFile);
      if (file) files.push(file);
    }
    return files;
  }

  function resolveComponent(scope, name, fromFile) {
    const binding = scope.getBinding(name);
    if (!binding) return null;
    if (binding.kind === 'module') {
      return resolveImport(config.srcRoot, fromFile, binding.path.parent.source.value);
    }
    let found = null;
    binding.path.traverse({
      Import(p) {
        const arg = p.parentPath.node.arguments?.[0];
        if (arg?.type === 'StringLiteral') found = resolveImport(config.srcRoot, fromFile, arg.value);
      },
    });
    return found;
  }

  // ---------- 화면마다 모으기 ----------

  const apiFunctions = {};
  for (const f of apiModuleFiles) Object.assign(apiFunctions, extractApiModule(f));

  const routeValues = lookupConstant(constants, config.routeConstant.split('.')) ?? {};
  const rel = (f) => (f ? path.relative(config.srcRoot, f) : null);

  const screens = extractScreens(path.join(config.srcRoot, config.routesFile)).map(({ wrapperFiles, ...s }) => {
    const files = [...new Set([s.componentFile, ...wrapperFiles].filter(Boolean).flatMap(closureOf))];
    const apiCalls = [];
    const settingReads = [];
    const links = [];
    for (const f of files) {
      const facts = fileFacts(f);
      for (const c of facts.apiCalls) apiCalls.push({ ...c, file: rel(f) });
      for (const r of facts.settingReads) settingReads.push({ ...r, file: rel(f) });
      for (const r of facts.routeRefs) links.push({ ...r, to: routeValues[r.route] ?? UNKNOWN, file: rel(f) });
    }
    return { ...s, componentFile: rel(s.componentFile), closureSize: files.length, apiCalls, settingReads, links };
  });

  return { screens, apiFunctions, redirects, guardInits, constants };
}
