import fs from 'node:fs';
import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath, Scope } from '@babel/traverse';
import type { CallExpression, Expression, Identifier, ImportDeclaration, ImportSpecifier, JSXAttribute, JSXElement, JSXIdentifier, JSXMemberExpression, JSXNamespacedName, MemberExpression, Node, ObjectExpression, ObjectProperty, OptionalMemberExpression, StringLiteral, TemplateLiteral, VariableDeclaration, VariableDeclarator } from '@babel/types';
import type { Constants, GuardInit, GuardSetting } from './access.ts';
import { recordApiCalls } from './api-calls.ts';
import { componentFileFinder } from './component-file.ts';
import { ROUTES_FILE } from './config.ts';
import { loadConstants } from './constants.ts';
import { inTypePosition, nameFollower } from './follow-names.ts';
import type { Origin } from './follow-names.ts';
import { parseSource } from './parse.ts';
import { importResolver } from './resolve.ts';
import { settingNeeds } from './setting-needs.ts';
import { addCallDefaults, findSettingsCalls, settingsResultFinder } from './settings-functions.ts';

type Span = { start?: number | null; end?: number | null };
type NameNode = { name?: string; value?: string };
type Note = (text: string, exprPath: NodePath, negated: boolean, source: string) => void;
type Init = { name: string | null; init: string };

interface ConstInits {
  inits: Init[];
  calls: [string, Binding | null][];
}

interface Helper {
  params: string[];
  body: string;
}

interface GuardEntry extends GuardInit {
  source: string | null;
  inits: Init[];
  callees?: Map<string, string | null>;
}

interface Page {
  component: string;
  componentFile: string | null | undefined;
  files: string[];
}

interface InheritedGuard {
  via: string;
  line: number;
  guards: string[];
}

interface Site {
  line: number;
  guards: string[];
  inheritedGuards?: InheritedGuard[];
}

type BodyOption = { key: string; line: number };
type ApiCallSite = Site & { fn: string; options: BodyOption[] };
type SettingRead = Site & { key: string };
type RouteRef = Site & { route: string; tail?: string };

interface Facts {
  imports: string[];
  apiCalls: ApiCallSite[];
  settingReads: SettingRead[];
  routeRefs: RouteRef[];
  dynamicOnly?: Set<string>;
}

interface ModuleEndpoint {
  method: unknown;
  url: unknown;
  line: number;
  via?: string;
}

interface ModuleFunction {
  file: string;
  line: number;
  endpoints: ModuleEndpoint[];
  delegates?: string[];
}

interface RouteScreen {
  path: string;
  component: string;
  componentFile: string | null | undefined;
  wrapperFiles: string[];
  routeFile: string;
  routeGuards: string[];
  line: number;
}

const traverse = _traverse.default ?? _traverse;
export const UNKNOWN = '{?}';
export const VARIABLE_SEGMENT = '{*}';
const UNREADABLE_PIECE = '\0';
const GUARD_TEXT_LIMIT = 160;

export function memberChain(node: { type: string }) {
  const names: string[] = [];
  let cur: any = node;
  while (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
    if (cur.computed) return null;
    names.unshift(cur.property.name);
    cur = cur.object;
  }
  if (cur.type !== 'Identifier') return null;
  names.unshift(cur.name);
  return names;
}

function sliceText(src: string, node: Span) {
  const text = src.slice(node.start!, node.end!).replace(/\s+/g, ' ').trim();
  return text.length > GUARD_TEXT_LIMIT ? text.slice(0, GUARD_TEXT_LIMIT) + '…' : text;
}

export function lookupConstant(constants: Constants, chain: string[] | null | undefined) {
  if (!chain || !Object.hasOwn(constants, chain[0])) return undefined;
  let value: any = constants[chain[0]];
  for (const key of chain.slice(1)) {
    if (value == null) return undefined;
    value = value[key];
  }
  return value;
}

const initCache = new WeakMap<Node, ConstInits>();

function constInits(exprPath: NodePath, src: string) {
  if (initCache.has(exprPath.node)) return initCache.get(exprPath.node)!;
  const found: Init[] = [];
  const calls: [string, Binding | null][] = [];
  const seen = new Set<Binding>();
  const follow = (p: NodePath) => {
    const ids: NodePath<Identifier>[] = p.isIdentifier() ? [p] : [];
    p.traverse({ Identifier: (id) => void ids.push(id) });
    for (const id of ids) {
      const binding = id.isReferencedIdentifier() && id.scope.getBinding(id.node.name);
      if (id.parentPath.isCallExpression() && id.key === 'callee') calls.push([id.node.name, binding || null]);
      if (!binding || binding.kind !== 'const' || seen.has(binding)) continue;
      seen.add(binding);
      const init = (binding.path.isVariableDeclarator() && binding.path.get('init')) as NodePath<Expression | null | undefined> | undefined;
      if (!init?.node) continue;
      const declared = (binding.path.node as VariableDeclarator).id;
      found.push({ name: declared.type === 'Identifier' ? declared.name : null, init: src.slice(init.node.start!, init.node.end!) });
      follow(init as NodePath);
    }
  };
  follow(exprPath);
  const result = { inits: found, calls };
  initCache.set(exprPath.node, result);
  return result;
}

function guardsOf(nodePath: NodePath, src: string, note: Note) {
  const guards: string[] = [];
  const add = (text: string, exprPath: NodePath, negated: boolean, source: string) => {
    guards.push(text);
    note(text, exprPath, negated, source);
  };
  let child = nodePath;
  let parent = nodePath.parentPath;
  while (parent) {
    const p = parent.node;
    if (p.type === 'LogicalExpression' && p.operator === '&&' && child.key === 'right') {
      add(sliceText(src, p.left), parent.get('left') as NodePath, false, src.slice(p.left.start!, p.left.end!));
    } else if ((p.type === 'ConditionalExpression' || p.type === 'IfStatement') && child.key !== 'test') {
      const t = sliceText(src, p.test);
      const s = src.slice(p.test.start!, p.test.end!);
      const negated = child.key !== 'consequent';
      add(negated ? `!(${t})` : t, parent.get('test') as NodePath, negated, negated ? `!(${s})` : s);
    }
    child = parent;
    parent = parent.parentPath;
  }
  return guards;
}

const exportsOnly = (p: NodePath) => p.parentPath!.isExportSpecifier() || p.parentPath!.isExportDefaultDeclaration();

// `export { f }` · `export default f` · 내보내기에만 쓰는 `const g = f` 는 f 를 부르지 않는다.
function reExported(p: NodePath) {
  if (exportsOnly(p)) return true;
  const declarator = p.parentPath!;
  if (!declarator.isVariableDeclarator() || p.key !== 'init' || declarator.node.id.type !== 'Identifier' || (declarator.parent as VariableDeclaration).kind !== 'const') return false;
  const binding = declarator.scope.getBinding(declarator.node.id.name)!;
  return binding.scope.block.type === 'Program' && binding.referencePaths.every((r) => r.isExportNamedDeclaration() || exportsOnly(r));
}

function enclosingFunctionName(nodePath: NodePath) {
  const fn = nodePath.getFunctionParent();
  if (!fn) return null;
  if (fn.parentPath?.isVariableDeclarator() && fn.parentPath.node.id.type === 'Identifier') {
    return { name: fn.parentPath.node.id.name, fnPath: fn };
  }
  if (fn.isFunctionDeclaration() && fn.node.id) return { name: fn.node.id.name, fnPath: fn };
  return null;
}

// 화면마다 라우트 조건 · 화면이 쓰는 이름으로 닿는 API 호출 · import 로 이어지는 파일의 설정값 읽기와 링크를 모으고, API 모듈의 함수별 endpoint 를 함께 돌려준다.
export async function extractClient(config: any) {
  const imports = importResolver(config);
  const components = componentFileFinder(imports.resolve);
  const constants = await loadConstants(config, imports.resolve);
  const apiModuleFiles = new Set<string>(config.apiModules.map((rel: string) => path.join(config.srcRoot, rel)));
  const calledFiles = new Set<string>(config.calledApiModules.map((rel: string) => path.join(config.srcRoot, rel)));
  let called: Awaited<ReturnType<typeof recordApiCalls>> | null = null;
  const constantFileOf = new Map(Object.entries<string>(config.constants).map(([name, rel]): [string, string] => [name, path.join(config.srcRoot, rel)]));
  const settingsOnly = new Set(Object.values<any>(config.settingsDefaults ?? {}).map((d) => d.constant?.split('.')[0]).filter(Boolean));
  const routeChain: string[] | null = config.routeConstant?.split('.') ?? null;
  if (routeChain) settingsOnly.delete(routeChain[0]);
  const constantModuleFiles = new Set(constantFileOf.values());
  const constantFiles = new Set([...constantFileOf].filter(([name]) => !settingsOnly.has(name)).map(([, file]) => file));
  const settingsRoots = new Set<string>(config.settingsRoots);
  const [routeRoot, ...routeRest] = routeChain ?? [];
  const guardInits = new Map<string, Map<string, GuardEntry>>();
  const guardSettings = new Map<string, Map<string, GuardSetting | null>>();
  const mapOf = <V>(maps: Map<string, Map<string, V>>, file: string) => {
    if (!maps.has(file)) maps.set(file, new Map());
    return maps.get(file)!;
  };

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

  function evaluateIdentifier(scope: Scope, name: string): any {
    const binding = scope.getBinding(name);
    if (!binding || binding.kind !== 'const' || !binding.path.isVariableDeclarator()) return undefined;
    const init = binding.path.get('init');
    return init.node ? evaluate(init) : undefined;
  }

  const isJsonValue = (v: any): boolean =>
    v === null || ['string', 'boolean'].includes(typeof v) || Number.isFinite(v)
    || (Array.isArray(v) ? v.every(isJsonValue) : typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every(isJsonValue));

  // evaluate 는 모르는 조각을 빼거나 UNKNOWN 으로 바꾸므로, 값이 소스 그대로 다 읽히는지는 따로 본다.
  function lossless(p: NodePath<any>, seen = new Set<Binding>()): boolean {
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
      case 'Identifier': {
        const init = constInit(p, p.node.name, seen);
        return Boolean(init) && lossless(init!, seen);
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const value = lookupConstant(constants, memberChain(p.node));
        return value !== undefined && isJsonValue(value);
      }
      case 'CallExpression':
        return p.node.callee.type === 'Identifier' && (config.passThroughCalls ?? []).includes(p.node.callee.name) && Boolean(p.node.arguments[0]) && lossless(p.get('arguments.0') as NodePath, seen);
      default:
        return false;
    }
  }

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
      const { ast } = parseSource(path.join(config.srcRoot, file));
      let init: NodePath<ObjectExpression> | null = null;
      traverse(ast, {
        VariableDeclarator(p) {
          if ((p.parent as VariableDeclaration).kind !== 'const' || !p.scope.path.isProgram() || !p.get('id').isIdentifier({ name })) return;
          if (p.get('init').isObjectExpression()) init = p.get('init') as NodePath<ObjectExpression>;
          p.stop();
        },
      });
      if (!init) throw new Error(`settingsDefaults.${root}: ${file} has no top-level const ${name} holding an object`);
      values[root] = evaluate(init);
      incomplete[root] = incompleteDefaults(init);
    }
    return { values, incomplete };
  }

  const { values: settingsDefaults, incomplete: settingsDefaultsIncomplete } = loadSettingsDefaults();
  const settingsCalls = config.settingsFunctions.length ? findSettingsCalls(config) : { calls: [], unread: [], notices: [] };
  const settingsCallNotices = [...settingsCalls.notices, ...addCallDefaults(settingsCalls.calls, settingsDefaults, settingsDefaultsIncomplete, { evaluate, lossless }, config.srcRoot), ...settingsCalls.unread];
  const programFile = new WeakMap<Node, string>();
  const resultOf = settingsResultFinder(settingsCalls as ReturnType<typeof findSettingsCalls>);
  const settingsResult = (id: NodePath) => resultOf(id, programFile.get(id.scope.getProgramParent().block));
  const needs = settingNeeds(config.settingsRoots ?? [], settingsDefaults, settingsResult);
  const CONFLICT = { reason: '같은 파일에 글자는 같고 읽는 설정이 다른 조건이 있어 켤 값을 정할 수 없습니다' };

  function noteSettings(file: string, text: string, result: GuardSetting | null) {
    const known = mapOf(guardSettings, file);
    if (!known.has(text)) known.set(text, result);
    else if (JSON.stringify(known.get(text)) !== JSON.stringify(result)) known.set(text, CONFLICT);
  }

  const importedFile = new WeakMap<Node, string | null>();
  const constantRoot = (id: NodePath<Identifier>, file: string) => {
    const { name } = id.node;
    const binding = id.scope.getBinding(name);
    if (!constantFileOf.has(name) || !id.parentPath.isMemberExpression({ object: id.node }) || !binding?.path.isImportDefaultSpecifier()) return false;
    const declaration = binding.path.parent as ImportDeclaration;
    if (!importedFile.has(declaration)) importedFile.set(declaration, imports.resolve(file, declaration.source.value));
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

  // 같은 글자의 조건이 부르는 이름이 자리마다 다른 선언을 가리키면 어느 함수인지 모르므로 그 이름은 읽지 않는다.
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
    // source 는 줄이지 않은 조건이다. 다른 조건이 같은 글자로 줄어들면 어느 것인지 모르므로 비운다.
    return (text, exprPath, negated, source) => {
      const { inits: found, calls } = constInits(exprPath, src);
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

  const keyName = (node: ObjectProperty) => String((node.key as NameNode).name ?? (node.key as NameNode).value);
  const propertyKey = (prop: NodePath<any>) => (prop.isObjectProperty() && !prop.node.computed ? keyName(prop.node) : undefined);
  const isUseState = (callee: CallExpression['callee']) =>
    (callee.type === 'Identifier' && callee.name === 'useState') || (callee.type === 'MemberExpression' && !callee.computed && (callee.property as Identifier).name === 'useState');

  function isToggle(value: NodePath) {
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

  const mayOverride = (later: NodePath<any>, key: string | undefined) => later.isSpreadElement() || later.node.computed || keyName(later.node) === key;
  function overridden(props: NodePath<any>[], i: number) {
    const key = propertyKey(props[i]);
    return props.slice(i + 1).some((later) => mayOverride(later, key));
  }

  const assignedKey = ({ computed, property }: MemberExpression) => (!computed ? (property as Identifier).name : property.type === 'StringLiteral' ? property.value : undefined);

  // 본문이 거쳐 온 const 마다, 호출보다 위에서 `body.key = …` 나 `body['key'] = …` 로 대입한 자리
  function assignments(nodePath: NodePath<any>, before: number) {
    const found: { key: string; value: NodePath; start: number; line: number }[] = [];
    const seen = new Set<Binding>();
    for (let at: NodePath<any> | null = nodePath; at?.isIdentifier(); ) {
      const binding = at.scope.getBinding(at.node.name);
      at = constInit(at, at.node.name, seen);
      if (!at) break;
      for (const ref of binding!.referencePaths) {
        const assign = ref.parentPath!.parentPath!;
        if (ref.key !== 'object' || !ref.parentPath!.isMemberExpression() || ref.parentPath.key !== 'left') continue;
        if (!assign.isAssignmentExpression({ operator: '=' }) || assign.node.start! > before) continue;
        const key = assignedKey(ref.parentPath.node);
        if (key !== undefined) found.push({ key, value: assign.get('right'), start: assign.node.start!, line: assign.node.loc!.start.line });
      }
    }
    return found.sort((a, b) => a.start - b.start);
  }

  function bodyOptions(callPath: NodePath<CallExpression>) {
    const options: BodyOption[] = [];
    for (const arg of callPath.get('arguments')) {
      const obj = objectLiteral(arg);
      if (!obj) continue;
      const outer = obj.get('properties');
      const at = outer.findLastIndex((p) => config.bodyArgKeys.includes(propertyKey(p)));
      if (at >= 0 && overridden(outer, at)) continue;
      const written = at >= 0 ? outer[at].get('value') as NodePath : arg;
      const body = objectLiteral(written);
      if (!body) continue;
      const props = body.get('properties');
      const found: BodyOption[] = [];
      props.forEach((prop, i) => {
        const key = propertyKey(prop);
        if (key !== undefined && isToggle(prop.get('value') as NodePath) && !overridden(props, i)) found.push({ key, line: prop.node.loc!.start.line });
      });
      for (const { key, value, line } of assignments(written, callPath.node.start!)) {
        if (isToggle(value) && !found.some((o) => o.key === key)) found.push({ key, line });
      }
      options.push(...found);
    }
    return options;
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

  const rootIdentifier = (p: NodePath): NodePath => (p.isMemberExpression() || p.isOptionalMemberExpression() ? rootIdentifier(p.get('object') as NodePath) : p);

  function listedRoutes(p: NodePath<MemberExpression | OptionalMemberExpression>) {
    if (!routeChain || memberChain(p.node.object)?.join('.') !== config.routeConstant) return [];
    const key = p.get('property');
    const binding = (key.isIdentifier() && key.scope.getBinding(key.node.name)) as Binding | undefined;
    if (binding?.kind !== 'param' || binding.path.listKey !== 'params' || binding.path.key !== 0) return [];
    const fn = binding.path.parentPath!;
    const call = fn.parentPath!;
    if (!(call.isCallExpression() || call.isOptionalCallExpression()) || fn.listKey !== 'arguments' || fn.key !== 0) return [];
    const callee = call.get('callee') as NodePath;
    if (!(callee.isMemberExpression() || callee.isOptionalMemberExpression()) || callee.node.computed) return [];
    if (!['forEach', 'map'].includes((callee.node.property as Identifier).name)) return [];
    const chain = settingsPath(callee.get('object') as NodePath);
    const list = chain?.slice(1).reduce((v: any, k) => v?.[k], settingsDefaults[chain[0]]);
    if (!Array.isArray(list)) return [];
    return [...new Set(list)]
      .filter((entry) => typeof entry === 'string' && Object.hasOwn(routeValues, entry))
      .map((entry) => ({ route: entry, guard: `${chain!.join('.')} includes '${entry}'`, settings: needs.includes(chain!, entry) }));
  }

  function tailText(p: NodePath<any>): string {
    if (p.isStringLiteral()) return p.node.value;
    if (p.isTemplateLiteral()) return p.node.quasis.map((q, i) => (i ? tailText(p.get(`expressions.${i - 1}`) as NodePath) : '') + q.value.cooked).join('');
    if (p.isBinaryExpression({ operator: '+' })) return tailText(p.get('left')) + tailText(p.get('right'));
    const value = lossless(p) ? evaluate(p) : undefined;
    return typeof value === 'string' || typeof value === 'number' ? String(value) : UNREADABLE_PIECE;
  }

  // 라우트 상수 뒤에 '/' 로 이어 붙은 주소. 조각마다 글자 그대로이거나 변수 하나일 때만 돌려주고, 아니면 '' 을 돌려준다.
  function routeTail(p: NodePath) {
    let tail = '';
    let whole = p;
    for (;;) {
      const parent = whole.parentPath!;
      if (parent.isTemplateLiteral() && parent.node.expressions[0] === whole.node && parent.node.quasis[0].value.cooked === '') {
        tail += parent.node.quasis.slice(1).map((q, i) => (i ? tailText(parent.get(`expressions.${i}`) as NodePath) : '') + q.value.cooked).join('');
      } else if (parent.isBinaryExpression({ operator: '+' }) && parent.node.left === whole.node) {
        tail += tailText(parent.get('right'));
      } else break;
      whole = parent;
    }
    const tailPath = tail.split(/[?#]/)[0].replace(/\/$/, '');
    if (!tailPath.startsWith('/')) return '';
    const segments = tailPath.slice(1).split('/').map((s) => (s === UNREADABLE_PIECE ? VARIABLE_SEGMENT : s));
    return segments.every((s) => s && !s.includes(UNREADABLE_PIECE)) ? `/${segments.join('/')}` : '';
  }

  // ---------- API 모듈: 내보낸 함수마다 호출하는 endpoint ----------

  function extractApiModule(file: string) {
    const { ast } = parseSource(file);
    const fns: Record<string, ModuleFunction> = {};
    traverse(ast, {
      ExportNamedDeclaration(exp) {
        const decl = exp.get('declaration');
        if (!decl.isVariableDeclaration()) return;
        for (const d of decl.get('declarations')) {
          const name = (d.node.id as Identifier).name;
          const endpoints: ModuleEndpoint[] = [];
          const delegates = new Set<string>();
          d.traverse({
            ObjectExpression(obj) {
              const keys = obj.node.properties.map((p) => (p as { key?: NameNode }).key?.name ?? (p as { key?: NameNode }).key?.value);
              if (!keys.includes('URL')) return;
              const value = evaluate(obj);
              endpoints.push({ method: value?.METHOD ?? null, url: value?.URL ?? null, line: obj.node.loc!.start.line });
            },
            MemberExpression(m) {
              if (m.parentPath.isMemberExpression({ object: m.node })) return;
              const value = lookupConstant(constants, memberChain(m.node));
              if (value && typeof value === 'object' && 'URL' in value) {
                endpoints.push({ method: value.METHOD ?? null, url: value.URL, line: m.node.loc!.start.line });
              }
            },
            CallExpression(c) {
              if (c.node.callee.type === 'Identifier') delegates.add(c.node.callee.name);
            },
          });
          fns[name] = { file: path.relative(config.srcRoot, file), line: d.node.loc!.start.line, endpoints, delegates: [...delegates] };
        }
      },
    });
    for (const fn of Object.values(fns)) {
      for (const callee of fn.delegates!) {
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

  const factCache = new Map<string, Facts>();
  const parsed = new Map<string, ReturnType<typeof parseSource>>();
  const parse = (file: string) => {
    if (!parsed.has(file)) parsed.set(file, parseSource(file));
    return parsed.get(file)!;
  };
  const siteStart = new WeakMap<Site, number>();
  const follower = nameFollower({ parse, resolve: imports.resolve, sitesOf: (file) => fileFacts(file).apiCalls.map((site) => ({ start: siteStart.get(site)!, site })) });
  const origins = new Map<string, Origin | null>();
  const calledOrigin = (file: string | null | undefined, name: string) => {
    const key = `${file}\0${name}`;
    if (!origins.has(key)) origins.set(key, follower.origin(file, name, (f) => calledFiles.has(f)));
    return origins.get(key);
  };

  function fileFacts(file: string): Facts {
    if (factCache.has(file)) return factCache.get(file)!;
    const { src, ast } = parse(file);
    programFile.set(ast.program, file);
    const facts: Facts = { imports: [], apiCalls: [], settingReads: [], routeRefs: [] };
    const apiNamed = new Map<string, string>();
    const apiNamespaces = new Set<string>();
    const calledNamed = new Map<string, { file: string; exportName: string }>();
    const calledNamespaces = new Map<string, string>();
    const localFnRefs = new Map<string, { fnPath: NodePath; items: Site[] }>();
    const relFile = path.relative(config.srcRoot, file);
    const note = guardNote(relFile, src);

    function record(kind: 'apiCalls' | 'settingReads' | 'routeRefs', entry: object, nodePath: NodePath, ownGuards: string[] = []) {
      const guards = [...ownGuards, ...guardsOf(nodePath, src, note)];
      const owner = enclosingFunctionName(nodePath);
      const item = { ...entry, line: nodePath.node.loc!.start.line, guards };
      siteStart.set(item, nodePath.node.start!);
      (facts[kind] as Site[]).push(item);
      if (owner) {
        if (!localFnRefs.has(owner.name)) localFnRefs.set(owner.name, { fnPath: owner.fnPath, items: [] });
        localFnRefs.get(owner.name)!.items.push(item);
      }
    }

    const staticImports = new Set<string>();
    function addImport(spec: string, dynamic = false) {
      const resolved = imports.resolve(file, spec);
      if (resolved) facts.imports.push(resolved);
      if (resolved && !dynamic) staticImports.add(resolved);
      return resolved;
    }

    traverse(ast, {
      ImportDeclaration(p) {
        const resolved = addImport(p.node.source.value);
        if (calledFiles.size && resolved && p.node.importKind !== 'type' && !apiModuleFiles.has(resolved) && !constantModuleFiles.has(resolved)) {
          for (const s of p.node.specifiers) {
            if ((s as ImportSpecifier).importKind === 'type') continue;
            if (s.type === 'ImportNamespaceSpecifier') {
              calledNamespaces.set(s.local.name, resolved);
              continue;
            }
            const found = calledOrigin(resolved, s.type === 'ImportDefaultSpecifier' ? 'default' : (s.imported as Identifier).name ?? (s.imported as StringLiteral).value);
            if (found) calledNamed.set(s.local.name, { file: found.file, exportName: found.name });
          }
        }
        if (!apiModuleFiles.has(resolved!)) return;
        for (const s of p.node.specifiers) {
          if (s.type === 'ImportSpecifier') apiNamed.set(s.local.name, (s.imported as Identifier).name);
          else apiNamespaces.add(s.local.name);
        }
      },
      Import(p) {
        const arg = (p.parentPath.node as CallExpression).arguments?.[0];
        if (arg?.type === 'StringLiteral') addImport(arg.value, true);
      },
      'ExportNamedDeclaration|ExportAllDeclaration'(p: NodePath<any>) {
        if (p.node.source) addImport(p.node.source.value);
      },
    });

    // import 한 API 함수 `f(…)`, API 객체의 메서드 `o.m(…)`, 네임스페이스로 import 한 것 `ns.f(…)` · `ns.o.m(…)`
    function calledFunction(callee: NodePath) {
      const chain = memberChain(callee.node);
      if (!chain || chain.length > 3) return null;
      const [first, ...rest] = chain;
      const binding = callee.scope.getBinding(first);
      if (binding?.kind !== 'module') return null;
      const named = calledNamed.get(first);
      const through = !named && calledNamespaces.has(first) && rest.length ? calledOrigin(calledNamespaces.get(first), rest[0]) : null;
      const [file, exportName, member]: [string?, string?, string[]?] = named ? [named.file, named.exportName, rest] : through ? [through.file, through.name, rest.slice(1)] : [];
      if (!file || !exportName || member!.length > 1) return null;
      const key = called!.keyOf(file, exportName);
      return member!.length ? `${key}.${member![0]}` : key;
    }

    traverse(ast, {
      CallExpression(p) {
        const callee = p.node.callee;
        if (callee.type === 'Identifier' && apiNamed.has(callee.name)) {
          record('apiCalls', { fn: apiNamed.get(callee.name), options: bodyOptions(p) }, p);
        } else if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && apiNamespaces.has(callee.object.name)) {
          record('apiCalls', { fn: (callee.property as Identifier).name, options: bodyOptions(p) }, p);
        } else {
          const fn = calledFunction(p.get('callee'));
          if (fn) record('apiCalls', { fn, options: bodyOptions(p) }, p);
        }
      },
      // 부르지 않고 값으로 넘긴 API 함수나 메서드 `queryFn: fetchNotices` · `queryFn: api.load`
      Identifier(p) {
        if (!called || !(calledNamed.has(p.node.name) || calledNamespaces.has(p.node.name)) || !p.isReferencedIdentifier() || inTypePosition(p)) return;
        let used: { at: NodePath; fn: string } | null = null;
        for (let at: NodePath = p, depth = 0; depth < 3; at = at.parentPath!, depth += 1) {
          const fn = calledFunction(at);
          if (fn && Object.hasOwn(called.functions, fn)) used = { at, fn };
          const up = at.parentPath!;
          if (!(up.isMemberExpression() || up.isOptionalMemberExpression()) || up.node.object !== at.node) break;
        }
        if (!used || ((used.at.parentPath!.isCallExpression() || used.at.parentPath!.isOptionalCallExpression()) && used.at.key === 'callee')) return;
        if (used.at === p && reExported(p)) return;
        record('apiCalls', { fn: used.fn, options: [] }, used.at);
      },
      'MemberExpression|OptionalMemberExpression'(p: NodePath<any>) {
        const parent = p.parentPath!;
        if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === p.node) return;
        const chain = memberChain(p.node);
        if (!chain) {
          if (!p.node.computed) return;
          for (const r of listedRoutes(p)) {
            noteSettings(relFile, r.guard, r.settings);
            record('routeRefs', { route: r.route }, p, [r.guard]);
          }
          return;
        }
        const result = !settingsRoots.has(chain[0]) && chain.length >= 2 && settingsResult(rootIdentifier(p));
        if (settingsRoots.has(chain[0]) && chain.length >= 3) {
          record('settingReads', { key: chain.slice(1).join('.') }, p);
        } else if (result) {
          record('settingReads', { key: [result[1], ...chain.slice(1)].join('.') }, p);
        } else if (chain[0] === routeRoot && chain.length === routeRest.length + 2 && routeRest.every((k: string, i: number) => chain[i + 1] === k)) {
          record('routeRefs', { route: chain[chain.length - 1], tail: routeTail(p) }, p);
        }
      },
    });

    // 지역 함수가 조건 안에서 이름으로 쓰이면(예: onClick={openHelp}) 그 조건을 함수 안의 참조에도 붙인다.
    traverse(ast, {
      Identifier(p) {
        const target = localFnRefs.get(p.node.name);
        if (!target || !p.isReferencedIdentifier()) return;
        if (p.findParent((a) => a === target.fnPath)) return;
        const outer = guardsOf(p, src, note);
        for (const item of target.items) {
          item.inheritedGuards ??= [];
          item.inheritedGuards.push({ via: p.node.name, line: p.node.loc!.start.line, guards: outer });
        }
      },
    });

    facts.imports = [...new Set(facts.imports)];
    facts.dynamicOnly = new Set(facts.imports.filter((f) => !staticImports.has(f)));
    factCache.set(file, facts);
    return facts;
  }

  // 다른 화면의 컴포넌트 파일을 동적 import 로만 참조하면 미리 불러 두는 것이라 따라가지 않는다.
  function closureOf(entryFile: string, isOtherScreen: (f: string) => boolean) {
    const seen = new Set<string>();
    const stack = [entryFile];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f) || apiModuleFiles.has(f) || calledFiles.has(f) || constantFiles.has(f)) continue;
      if (!/\.(jsx?|tsx?)$/.test(f)) continue;
      seen.add(f);
      const { imports, dynamicOnly } = fileFacts(f);
      for (const dep of imports) if (!(dynamicOnly!.has(dep) && isOtherScreen(dep))) stack.push(dep);
    }
    return [...seen];
  }

  // ---------- 라우트 파일: 화면 목록과 화면에 걸린 조건 ----------

  const redirects: { to: string; file: string; line: number; guards: string[] }[] = [];

  function extractScreens(routeFile: string) {
    const absFile = path.join(config.srcRoot, routeFile);
    if (!fs.statSync(absFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`routesFile names ${JSON.stringify(routeFile)}, but ${absFile} is not a file`);
    const { src, ast } = parseSource(absFile);
    programFile.set(ast.program, absFile);
    const note = guardNote(routeFile, src);
    const screens: RouteScreen[] = [];
    traverse(ast, {
      JSXElement(p) {
        const tag = tagOf(p.node.openingElement.name);
        if (!tag) return;
        const attr = (name: string) => p.get('openingElement.attributes').find((a) => (a.node as JSXAttribute).name?.name === name) as NodePath<JSXAttribute> | undefined;
        if (config.redirectElements.includes(tag)) {
          const toValue = attr('to')?.get('value');
          const to = toValue && evaluate(toValue.isJSXExpressionContainer() ? toValue.get('expression') : toValue);
          redirects.push({ to: typeof to === 'string' ? to : UNKNOWN, file: routeFile, line: p.node.loc!.start.line, guards: guardsOf(p, src, note) });
          return;
        }
        if (!config.routeElements.includes(tag)) return;
        const pathAttr = attr('path');
        const compAttr = attr('component');
        if (!pathAttr) return;
        const page = compAttr ? componentAttrPage(compAttr, absFile) : elementPage(attr('element'), absFile);
        if (!page) return;
        const pathWritten = pathAttr.get('value');
        const pathValue = evaluate(pathWritten.isJSXExpressionContainer() ? pathWritten.get('expression') : pathWritten);
        screens.push({
          path: typeof pathValue === 'string' ? pathValue : UNKNOWN,
          component: page.component,
          componentFile: page.componentFile,
          wrapperFiles: [...page.files, ...wrappersOf(p, absFile)],
          routeFile,
          routeGuards: guardsOf(p, src, note),
          line: p.node.loc!.start.line,
        });
      },
    });
    return screens;
  }

  function wrappersOf(routePath: NodePath, routesFile: string) {
    const files: string[] = [];
    for (let a = routePath.parentPath; a; a = a.parentPath) {
      const tag = a.isJSXElement() && tagOf(a.node.openingElement.name);
      if (!tag) continue;
      const file = resolveTag(a.scope, tag, routesFile);
      if (file) files.push(file);
    }
    return files;
  }

  const tagOf = (name: JSXIdentifier | JSXMemberExpression | JSXNamespacedName): string | null => (name.type === 'JSXIdentifier' ? name.name
    : name.type === 'JSXMemberExpression' ? `${tagOf(name.object)}.${name.property.name}` : null);
  const resolveTag = (scope: Scope, tag: string, fromFile: string) => components.find(scope, tag, fromFile).file;
  const fromPackage = (scope: Scope, tag: string, fromFile: string) => {
    const binding = scope.getBinding(tag.split('.')[0]);
    return binding?.kind === 'module' && !imports.resolve(fromFile, (binding.path.parent as ImportDeclaration).source.value);
  };

  const unwrapCalls = (p: NodePath<any> | undefined) => {
    while (p?.isCallExpression()) p = p.get('arguments.0');
    return p;
  };

  function componentAttrPage(compAttr: NodePath<JSXAttribute>, routesFile: string): Page {
    const written = compAttr.get('value.expression') as NodePath;
    const compExpr = unwrapCalls(written)!;
    const component = compExpr.node && memberChain(compExpr.node)?.join('.');
    const componentFile = component ? components.find(compExpr.scope, component, routesFile, written.isCallExpression()).file : null;
    return { component, componentFile, files: [] };
  }

  const REDIRECT = Symbol('redirect');
  const isPage = (page: Page | typeof REDIRECT | null): page is Page => (page && page !== REDIRECT) as boolean;
  const innerPageOf = (pages: Page[]) => pages.find((c) => c.componentFile) ?? pages.find((c) => c.component.includes('.'));
  const pickPage = (pages: Page[]) => innerPageOf(pages) ?? pages[0];
  const withFiles = (page: Omit<Page, 'files'> | null | undefined, files: string[]): Page | null => (page ? { ...page, files } : null);

  function elementPage(elementAttr: NodePath<JSXAttribute> | undefined, routesFile: string) {
    const pages = elementsIn(elementAttr?.get('value')).map((e) => pageOf(e, routesFile)).filter(isPage);
    return withFiles(pickPage(pages), pages.flatMap((c) => c.files));
  }

  function elementsIn(p: NodePath<any> | undefined): NodePath<JSXElement>[] {
    p = unwrapCalls(p);
    if (!p) return [];
    if (p.isJSXExpressionContainer()) return elementsIn(p.get('expression'));
    if (p.isJSXElement()) return [p];
    if (p.isJSXFragment()) return p.get('children').flatMap(elementsIn);
    if (p.isConditionalExpression()) return [...elementsIn(p.get('consequent')), ...elementsIn(p.get('alternate'))];
    if (p.isLogicalExpression()) return elementsIn(p.get('right'));
    return [];
  }

  function pageOf(element: NodePath<JSXElement>, routesFile: string): Page | typeof REDIRECT | null {
    const tag = tagOf(element.node.openingElement.name);
    if (!tag) return null;
    if (config.redirectElements.includes(tag)) return REDIRECT;
    const insides = element.get('children').flatMap(elementsIn).map((e) => pageOf(e, routesFile));
    const inner = insides.filter(isPage);
    const onlyRedirect = insides.length > 0 && insides.every((c) => c === REDIRECT);
    const innerFiles = inner.flatMap((c) => c.files);
    const htmlLike = /^[a-z]/.test(tag.split('.').pop()!) && (!tag.includes('.') || fromPackage(element.scope, tag, routesFile));
    if (htmlLike) return onlyRedirect ? REDIRECT : withFiles(pickPage(inner), innerFiles);
    if (onlyRedirect) return REDIRECT;

    const candidate = (component: string) => ({ component, componentFile: resolveTag(element.scope, component, routesFile) });
    const { file: outerFile, followed } = components.find(element.scope, tag, routesFile);
    const outer = { component: tag, componentFile: outerFile };
    const props = (element.get('openingElement.attributes') as NodePath<JSXAttribute>[]).flatMap((a) => {
      const expr = a.node.value?.type === 'JSXExpressionContainer' ? a.node.value.expression : null;
      const named = /^[A-Z]/.test(a.node.name?.name as string);
      if (expr?.type !== 'Identifier' || !(named || /^[A-Z].*[a-z]/.test(expr.name))) return [];
      return [{ ...candidate(expr.name), named }];
    });
    const passed = [...props.filter((c) => c.named), ...props.filter((c) => !c.named)]
      .filter((c) => !constantModuleFiles.has(c.componentFile!) && !apiModuleFiles.has(c.componentFile!))
      .map(({ named, ...c }) => c);
    const files = ([outer, ...passed].map((c) => c.componentFile).filter(Boolean) as string[]).concat(innerFiles);
    const innerPage = innerPageOf(inner);
    if (innerPage) return withFiles(innerPage, files);
    const binding = !tag.includes('.') && element.scope.getBinding(tag);
    const declaredHere = Boolean(binding) && (binding as Binding).kind !== 'module';
    const page = [...(followed ? [] : [outer]), ...passed].find((c) => c.componentFile) ?? (declaredHere ? passed[0] : null) ?? inner[0] ?? outer;
    return withFiles(page, files);
  }

  // ---------- 화면마다 모으기 ----------

  const apiFunctions: Record<string, any> = {};
  for (const f of apiModuleFiles) Object.assign(apiFunctions, extractApiModule(f));
  if (calledFiles.size) called = await recordApiCalls(config, imports.resolve, new Set(Object.keys(apiFunctions)));
  Object.assign(apiFunctions, called?.functions);

  const routeValues = lookupConstant(constants, routeChain) ?? {};
  const rel = (f: string | null | undefined) => (f ? path.relative(config.srcRoot, f) : null);

  if (!config.routeFiles.length) throw new Error(`the config has no routesFile, which takes ${ROUTES_FILE}`);
  const extracted = (config.routeFiles as string[]).flatMap(extractScreens);
  const screenFiles = new Set(extracted.map((s) => s.componentFile).filter(Boolean));
  const screens = extracted.map(({ wrapperFiles, ...s }) => {
    const entryFiles = [s.componentFile, ...wrapperFiles].filter(Boolean) as string[];
    const isOtherScreen = (f: string) => screenFiles.has(f) && !entryFiles.includes(f);
    const files = [...new Set(entryFiles.flatMap((f) => closureOf(f, isOtherScreen)))];
    const inSources = new Set<string | null>(files);
    const reached = follower.reach(entryFiles.map((file) => ({ file, name: null })), (f) => inSources.has(f));
    const apiCalls: (ApiCallSite & { file: string | null })[] = [];
    const settingReads: (SettingRead & { file: string | null })[] = [];
    const links: (Omit<RouteRef, 'tail'> & { to: unknown; tail?: string; file: string | null })[] = [];
    for (const f of files) {
      const facts = fileFacts(f);
      for (const c of facts.apiCalls) if (reached.has(c)) apiCalls.push({ ...c, file: rel(f) });
      for (const r of facts.settingReads) settingReads.push({ ...r, file: rel(f) });
      for (const { tail, ...r } of facts.routeRefs) {
        const value = routeValues[r.route];
        links.push(typeof value === 'string' && tail ? { ...r, to: value + tail, tail, file: rel(f) } : { ...r, to: value ?? UNKNOWN, file: rel(f) });
      }
    }
    return { ...s, componentFile: rel(s.componentFile), closureSize: files.length, sourceFiles: files.map(rel).sort(), apiCalls, settingReads, links };
  });

  return { screens, apiFunctions, unrunApiModules: called?.failedModules ?? null, outsideStandIns: called?.outsideStandIns ?? [], bodyTypeNotices: called?.bodyTypeNotices.length ? called.bodyTypeNotices : null, redirects, guardInits, constants, guardSettings, settingsDefaults, settingsDefaultsIncomplete, settingsCallNotices, unresolvedAliasImports: imports.unresolved() };
}
