import fs from 'node:fs';
import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath, Scope } from '@babel/traverse';
import type { ArrowFunctionExpression, CallExpression, Expression, FunctionDeclaration, FunctionExpression, Identifier, ImportDeclaration, ImportDefaultSpecifier, ImportNamespaceSpecifier, ImportSpecifier, JSXAttribute, JSXElement, JSXIdentifier, JSXMemberExpression, JSXNamespacedName, MemberExpression, Node, ObjectExpression, ObjectProperty, OptionalMemberExpression, Program, StringLiteral, TemplateLiteral, VariableDeclaration, VariableDeclarator } from '@babel/types';
import { routerTargets } from './access.ts';
import { addressReader, MOST_ADDRESSES, UNREADABLE_PIECE } from './address-functions.ts';
import type { AddressFunction } from './address-functions.ts';
import type { Branch, Constants, GuardInit, GuardSetting, RouteNode } from './access.ts';
import { recordApiCalls, requestFunctionFile } from './api-calls.ts';
import { componentFileFinder } from './component-file.ts';
import { compare, ROUTES_FILE } from './config.ts';
import { loadConstants } from './constants.ts';
import { inTypePosition, nameFollower } from './follow-names.ts';
import type { Origin } from './follow-names.ts';
import { parseSource } from './parse.ts';
import { pathParts, routePattern } from './path-values.ts';
import { importResolver } from './resolve.ts';
import { sagaFiles, sagaReader } from './saga-requests.ts';
import type { ActionType, Handler, Watch } from './saga-requests.ts';
import { addresses, madeFrom, screenLinkReader } from './screen-links.ts';
import { importedAs, routerImport, screenRequestReader } from './screen-requests.ts';
import type { UnresolvedReason } from './server.ts';
import { typedMembers } from './typed-members.ts';
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
type ApiCallSite = Site & { fn: string; options: BodyOption[]; request?: { method: string | null; url: string | null; unresolved?: UnresolvedReason }; navigation?: true; actions?: DispatchedActions };
type DispatchedActions = { type: string; dispatchedAt: string[] }[];
type DispatchSite = { line: number; types: () => ActionType[] };
type WatcherSite = { watches: Watch[] };
type SettingRead = Site & { key: string };
type RouteRef = Site & { route: string; tail?: string };
type RouterLink = Site & { to: string };
type FollowedSite = ApiCallSite | DispatchSite | WatcherSite | RouteRef | RouterLink;

interface Facts {
  imports: string[];
  apiCalls: ApiCallSite[];
  dispatches: DispatchSite[];
  watchers: WatcherSite[];
  settingReads: SettingRead[];
  routeRefs: RouteRef[];
  routerLinks: RouterLink[];
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
  tableItem?: TableItem;
  outerFill: OuterFill;
}

export type TableItem = { key: string; file: string; line: number };

interface RouteTable {
  route: string;
  table: { file: string; const: string };
  items: string;
}

interface LoopRoute {
  element: Node;
  line: number;
  page: Page;
  pathExpr: NodePath;
  item: { node: Node; field: string };
  guards: string[];
  wrappers: string[];
}

interface DrawnNode {
  kind: RouteNode['kind'];
  path: string | null;
  exact: boolean;
  from: string | null;
  to: string;
  screens: RouteScreen[];
  entry: string | null;
  isRoute: boolean;
  isFragment: boolean;
  redirectAsElement: boolean;
  children: DrawnNode[];
}

type StoppedAt = { text: string; file: string | null; line: number };
type UnreadRoutePath = { file: string; line: number; path: string; stoppedAt: StoppedAt; paths?: string[]; manyPaths?: true };

interface OuterFill {
  startsWithOuterAddress: boolean;
  unreadPath: { entry: UnreadRoutePath; restStoppedAt: StoppedAt | null } | null;
}

const traverse = _traverse.default ?? _traverse;
export const UNKNOWN = '{?}';
export const VARIABLE_SEGMENT = '{*}';
const GUARD_TEXT_LIMIT = 160;
const HISTORY_MAKERS = ['createBrowserHistory', 'createHashHistory'];

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

export const keyName = (node: { key: object }) => String((node.key as NameNode).name ?? (node.key as NameNode).value);

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

// import 한 이름이나 그 멤버(`Roles.ADMIN`)는 선언한 파일에서 읽은 값을 글자로 적어 둔다.
function constInits(exprPath: NodePath, src: string, valueOf: (p: NodePath) => unknown) {
  if (initCache.has(exprPath.node)) return initCache.get(exprPath.node)!;
  const found: Init[] = [];
  const calls: [string, Binding | null][] = [];
  const seen = new Set<Binding>();
  const noteImported = (id: NodePath<Identifier>) => {
    let top: NodePath = id;
    while ((top.parentPath!.isMemberExpression() || top.parentPath!.isOptionalMemberExpression()) && top.key === 'object' && !(top.parent as MemberExpression).computed) top = top.parentPath!;
    const name = memberChain(top.node)?.join('.');
    const value = valueOf(top);
    const text = typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
    if (name && text && !found.some((f) => f.name === name)) found.push({ name, init: JSON.stringify(value) });
  };
  const follow = (p: NodePath) => {
    const ids: NodePath<Identifier>[] = p.isIdentifier() ? [p] : [];
    p.traverse({ Identifier: (id) => void ids.push(id) });
    for (const id of ids) {
      const binding = id.isReferencedIdentifier() && id.scope.getBinding(id.node.name);
      if (id.parentPath.isCallExpression() && id.key === 'callee') calls.push([id.node.name, binding || null]);
      if (binding && binding.kind === 'module') noteImported(id);
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
  const routeTables = new Map<string, RouteTable & { at: string }>((config.routeTables as RouteTable[]).map((t, i) => [t.route, { ...t, at: `routeTables[${i}]` }]));
  const tableFiles = new Set((config.routeTables as RouteTable[]).map((t) => path.join(config.srcRoot, t.table.file)));
  // 라우트 파일에 적은 표는 그 라우트 파일을 그리는 화면의 소스에 남는다.
  for (const f of config.routeFiles as string[]) tableFiles.delete(path.join(config.srcRoot, f));
  const [routeRoot, ...routeRest] = routeChain ?? [];
  const guardInits = new Map<string, Map<string, GuardEntry>>();
  const guardSettings = new Map<string, Map<string, GuardSetting | null>>();
  const mapOf = <V>(maps: Map<string, Map<string, V>>, file: string) => {
    if (!maps.has(file)) maps.set(file, new Map());
    return maps.get(file)!;
  };

  const factCache = new Map<string, Facts>();
  const parsed = new Map<string, ReturnType<typeof parseSource>>();
  const parse = (file: string) => {
    if (!parsed.has(file)) parsed.set(file, parseSource(file));
    return parsed.get(file)!;
  };
  const siteStart = new WeakMap<FollowedSite, number>();
  const siteFile = new WeakMap<FollowedSite, string>();
  const linkSites = (facts: Facts): (RouteRef | RouterLink)[] => [...facts.routeRefs, ...facts.routerLinks];
  const sitesOf = (file: string) => {
    const facts = fileFacts(file);
    return [...facts.apiCalls, ...facts.dispatches, ...facts.watchers, ...linkSites(facts)].map((site) => ({ start: siteStart.get(site)!, site }));
  };
  const follower = nameFollower<FollowedSite>({ parse, resolve: imports.resolve, sitesOf });
  const programFile = new WeakMap<Node, string>();
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
    const found = file ? follower.declaration(file, name) : null;
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

  // srcRoot 아래 파일 맨 위의 `const <name> = { … }`. 그런 선언이 없거나 값이 객체 리터럴이 아니면 null 이다.
  function topLevelObject(file: string, name: string): NodePath<ObjectExpression> | null {
    const absFile = path.join(config.srcRoot, file);
    const { ast } = parseSource(absFile);
    programFile.set(ast.program, absFile);
    let init: NodePath<ObjectExpression> | null = null;
    traverse(ast, {
      VariableDeclarator(p) {
        if ((p.parent as VariableDeclaration).kind !== 'const' || !p.scope.path.isProgram() || !p.get('id').isIdentifier({ name })) return;
        if (p.get('init').isObjectExpression()) init = p.get('init') as NodePath<ObjectExpression>;
        p.stop();
      },
    });
    return init;
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
      const init = topLevelObject(file, name);
      if (!init) throw new Error(`settingsDefaults.${root}: ${file} has no top-level const ${name} holding an object`);
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

  function pathSegments(text: string) {
    const pathText = text.split(/[?#]/)[0];
    if (!pathText.startsWith('/')) return null;
    return pathText === '/' ? [] : pathText.replace(/\/$/, '').slice(1).split('/');
  }

  const passThrough = (name: string) => (config.passThroughCalls ?? []).includes(name);
  const linkReading = addressReader({ leaf: (p) => (lossless(p) ? { value: evaluate(p) } : { parts: [p] }), declaredValue, declaredFunction, namespaceFunction, passThrough });

  // 링크 요소의 to 나 history 이동에 적은 주소. 동적 세그먼트는 {*} 로 두고, 값으로 시작하는 주소는 {?} 다.
  // 주소 함수가 돌려준 갈래 가운데 끝까지 읽었는데 / 로 시작하지 않는 것은 링크가 아니다.
  function linkAddresses(p: NodePath) {
    const read = linkReading.branches(p);
    if ('tooMany' in read) return [UNKNOWN];
    const found = new Set<string>();
    for (const { text, made, whole } of read.branches) {
      if (made && whole && !addresses(whole).length) continue;
      const segments = pathSegments(text);
      if (segments) found.add(`/${segments.map((s) => (s.includes(UNREADABLE_PIECE) ? VARIABLE_SEGMENT : s)).join('/')}`);
      else if (!made || text.includes(UNREADABLE_PIECE)) found.add(UNKNOWN);
    }
    return found.size > MOST_ADDRESSES ? [UNKNOWN] : [...found];
  }

  const oneAddress = (p: NodePath) => {
    const [only, ...more] = linkAddresses(p);
    return more.length ? UNKNOWN : only;
  };

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
    const segments = pathSegments(tail)?.map((s) => (s === UNREADABLE_PIECE ? VARIABLE_SEGMENT : s));
    return segments?.length && segments.every((s) => s && !s.includes(UNREADABLE_PIECE)) ? `/${segments.join('/')}` : '';
  }

  // ---------- API 모듈: 내보낸 함수마다 호출하는 endpoint ----------

  function extractApiModule(file: string) {
    const { ast } = parseSource(file);
    programFile.set(ast.program, file);
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

  const sagas = sagaReader({ parse, resolve: imports.resolve, declaration: follower.declaration });
  const origins = new Map<string, Origin | null>();
  const calledOrigin = (file: string | null | undefined, name: string) => {
    const key = `${file}\0${name}`;
    if (!origins.has(key)) origins.set(key, follower.origin(file, name, (f) => calledFiles.has(f)));
    return origins.get(key);
  };

  const requestFile = requestFunctionFile(config, imports.resolve);
  const requestImports = new Map<string, boolean>();
  const screenRequests = screenRequestReader({
    requestFunction: config.requestFunction,
    evaluate,
    objectLiteral,
    server: config.app?.server ?? null,
    isRequestFunction(file, spec, name) {
      const { import: from, name: exported } = config.requestFunction;
      if (!from.startsWith('.') && spec === from && name === exported) return true;
      if (!requestFile) return false;
      const resolved = imports.resolve(file, spec);
      const key = `${resolved}\0${name}`;
      if (!requestImports.has(key)) requestImports.set(key, follower.origin(resolved, name, (f) => f === requestFile)?.name === exported);
      return requestImports.get(key)!;
    },
  });

  const routeFileSet = new Set((config.routeFiles as string[]).map((f) => path.join(config.srcRoot, f)));
  const historyFile = config.history ? madeHistoryFile(config.history) : null;
  const historyImports = new Map<string, boolean>();
  const screenLinks = screenLinkReader({
    configuredHistory(binding) {
      const from = historyFile ? importedAs(binding) : null;
      const file = from && from.name !== '*' ? programFile.get(binding.scope.getProgramParent().block) : null;
      if (!file) return false;
      const resolved = imports.resolve(file, from!.spec);
      const key = `${resolved}\0${from!.name}`;
      if (!historyImports.has(key)) historyImports.set(key, Boolean(resolved) && follower.origin(resolved, from!.name, (f) => f === historyFile)?.name === config.history.name);
      return historyImports.get(key)!;
    },
  });
  const madeHistories = new Map<string, string>();

  function madeHistoryFile({ import: from, name }: { import: string; name: string }) {
    const file = imports.resolve(path.join(config.srcRoot, 'index.js'), from);
    if (!file || !file.startsWith(config.srcRoot + path.sep)) throw new Error(`history.import ${from} names no file under srcRoot ${config.srcRoot}`);
    if (!follower.declaration(file, name)) throw new Error(`history.name ${name} is not exported by ${path.relative(config.srcRoot, file)}`);
    return file;
  }

  function fileFacts(file: string): Facts {
    if (factCache.has(file)) return factCache.get(file)!;
    const { src, ast } = parse(file);
    programFile.set(ast.program, file);
    const facts: Facts = { imports: [], apiCalls: [], dispatches: [], watchers: [], settingReads: [], routeRefs: [], routerLinks: [] };
    const apiNamed = new Map<string, string>();
    const apiNamespaces = new Set<string>();
    const calledNamed = new Map<string, { file: string; exportName: string }>();
    const calledNamespaces = new Map<string, string>();
    const localFnRefs = new Map<string, { fnPath: NodePath; items: Site[] }>();
    const relFile = path.relative(config.srcRoot, file);
    const note = guardNote(relFile, src);

    function record(kind: 'apiCalls' | 'settingReads' | 'routeRefs' | 'routerLinks', entry: object, nodePath: NodePath, ownGuards: string[] = []) {
      const guards = [...ownGuards, ...guardsOf(nodePath, src, note)];
      const owner = enclosingFunctionName(nodePath);
      const item = { ...entry, line: nodePath.node.loc!.start.line, guards };
      siteStart.set(item as ApiCallSite, nodePath.node.start!);
      if (kind !== 'settingReads') siteFile.set(item as ApiCallSite, file);
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

    function recordRequest(found: ReturnType<typeof screenRequests.call>, at: NodePath) {
      if (!found) return;
      const { fn, navigation, ...request } = found;
      record('apiCalls', { fn, options: [], request, ...(navigation && { navigation }) }, at);
    }

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
        const types = sagas.dispatched(p, file);
        if (types) {
          const site = { line: p.node.loc!.start.line, types };
          siteStart.set(site, p.node.start!);
          facts.dispatches.push(site);
        }
        const watches = sagas.watches(p, file);
        if (watches?.length) {
          const site = { watches };
          siteStart.set(site, p.node.start!);
          facts.watchers.push(site);
        }
        const callee = p.node.callee;
        if (callee.type === 'Identifier' && apiNamed.has(callee.name)) {
          record('apiCalls', { fn: apiNamed.get(callee.name), options: bodyOptions(p) }, p);
        } else if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && apiNamespaces.has(callee.object.name)) {
          record('apiCalls', { fn: (callee.property as Identifier).name, options: bodyOptions(p) }, p);
        } else {
          const fn = calledFunction(p.get('callee'));
          if (fn) record('apiCalls', { fn, options: bodyOptions(p) }, p);
          else recordRequest(screenRequests.call(p, file), p);
        }
      },
      AssignmentExpression(p) {
        recordRequest(screenRequests.assignment(p), p);
      },
      JSXAttribute(p) {
        recordRequest(screenRequests.attribute(p), p);
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

    const routeRefAt = facts.routeRefs.map((r) => siteStart.get(r)!);
    const holdsRouteRef = (p: NodePath) => routeRefAt.some((start) => start >= p.node.start! && start < p.node.end!);
    const recordLinks = (addresses: NodePath[]) => {
      for (const at of addresses) {
        if (madeFrom(at).some(holdsRouteRef)) continue;
        for (const to of linkAddresses(at)) record('routerLinks', { to }, at);
      }
    };
    const inRouteFile = routeFileSet.has(file);
    traverse(ast, {
      JSXElement(p) {
        recordLinks(screenLinks.element(p, inRouteFile));
      },
      CallExpression(p) {
        recordLinks(screenLinks.call(p));
        const callee = p.get('callee');
        const binding = !config.history && callee.isIdentifier() ? callee.scope.getBinding(callee.node.name) : undefined;
        const from = binding ? importedAs(binding) : null;
        if (from?.spec === 'history' && HISTORY_MAKERS.includes(from.name) && !madeHistories.has(relFile)) madeHistories.set(relFile, from.name);
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
      if (seen.has(f) || apiModuleFiles.has(f) || calledFiles.has(f) || constantFiles.has(f) || (f !== entryFile && tableFiles.has(f))) continue;
      if (!/\.(jsx?|tsx?)$/.test(f)) continue;
      seen.add(f);
      const { imports, dynamicOnly } = fileFacts(f);
      for (const dep of imports) if (!(dynamicOnly!.has(dep) && isOtherScreen(dep))) stack.push(dep);
    }
    return [...seen];
  }

  // ---------- 라우트 파일: 화면 목록과 화면에 걸린 조건 ----------

  const redirects: { to: string; file: string; line: number; guards: string[] }[] = [];
  const unreadRoutePaths: UnreadRoutePath[] = [];
  const unreadRoutes: { file: string; line: number; reason: string }[] = [];
  const readWhole = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && !v.includes(UNKNOWN));

  // filled 말고 읽지 못한 부분이 없으면 null 이다.
  function unreadPiece(p: NodePath, seen = new Set<Node>(), filled: Node[] = []): NodePath | null {
    if (filled.includes(p.node)) return null;
    const pieces = p.isTemplateLiteral() ? (p.get('expressions') as NodePath[]) : p.isBinaryExpression({ operator: '+' }) ? [p.get('left'), p.get('right')] : null;
    if (pieces) {
      for (const x of pieces) {
        const found = !readWhole(evaluate(x)) && unreadPiece(x, seen, filled);
        if (found) return found;
      }
      return filled.length ? null : p;
    }
    const chain = p.isIdentifier() || p.isMemberExpression() ? memberChain(p.node) : null;
    const value = chain?.length === 1 ? declaredValue(p.scope, chain[0]) : chain?.length === 2 ? namespaceMember(p.scope, chain) : null;
    if (!value || seen.has(value.node)) return p;
    seen.add(value.node);
    return unreadPiece(value, seen, filled) ?? p;
  }

  const routeReading = addressReader({
    leaf(p) {
      const value = evaluate(p);
      if (value === undefined || (typeof value !== 'string' && !lossless(p))) return { parts: [unreadPiece(p) ?? p] };
      if (typeof value !== 'string' || !value.includes(UNKNOWN)) return { value };
      const stop = unreadPiece(p) ?? p;
      return { parts: value.split(UNKNOWN).flatMap((part, i) => (i ? [stop, part] : [part])) };
    },
    declaredValue,
    declaredFunction,
    namespaceFunction,
    passThrough,
  });

  // 주소 함수가 돌려준 갈래 가운데 쿼리를 붙이는 것과, 고정된 마디가 있는 갈래 옆에서 경로 변수만 남은 것은 경로가 아니다.
  function readRoutePath(p: NodePath): { path: string; stops: NodePath[]; paths?: string[]; manyPaths?: true } {
    const calledAt = piecesOf(p).find((x) => x.isCallExpression()) ?? p;
    const found = routeReading.branches(p);
    if ('tooMany' in found) return { path: UNKNOWN, stops: [calledAt], manyPaths: true };
    const segments = (b: { text: string }) => b.text.split('/').filter(Boolean);
    const fixed = (b: { text: string }) => segments(b).some((x) => !x.startsWith(':') && !x.includes(UNREADABLE_PIECE) && x !== '*');
    let read = found.branches.filter((b) => !b.made || !b.text.replace(/:\w+(\([^)]*\))?\?/g, '').includes('?'));
    if (read.some(fixed)) read = read.filter((b) => !b.made || fixed(b) || !segments(b).length || !segments(b).every((x) => x.startsWith(':')));
    const paths = [...new Set(read.map((b) => b.text.replaceAll(UNREADABLE_PIECE, UNKNOWN)))];
    if (paths.length === 1) return { path: paths[0], stops: read[0].stops };
    if (!paths.length) return { path: UNKNOWN, stops: [p] };
    return { path: UNKNOWN, stops: [calledAt], ...(paths.length > MOST_ADDRESSES ? { manyPaths: true as const } : { paths }) };
  }

  function stopOf(p: NodePath) {
    const file = programFile.get(p.scope.getProgramParent().block) ?? null;
    return { text: file ? sliceText(parse(file).src, p.node) : '?', file: rel(file), line: p.node.loc!.start.line };
  }

  function extractScreens(routeFile: string) {
    const absFile = path.join(config.srcRoot, routeFile);
    if (!fs.statSync(absFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`routesFile names ${JSON.stringify(routeFile)}, but ${absFile} is not a file`);
    const { src, ast } = parseSource(absFile);
    programFile.set(ast.program, absFile);
    const note = guardNote(routeFile, src);
    const screens: RouteScreen[] = [];
    const table = routeTables.get(routeFile);
    const elementScreens = new Map<Node, RouteScreen[]>();
    const loopRoutes: LoopRoute[] = [];
    let loopAt = -1;
    traverse(ast, {
      JSXElement(p) {
        const tag = tagOf(p.node.openingElement.name);
        if (!tag) return;
        const attr = (name: string) => p.get('openingElement.attributes').find((a) => (a.node as JSXAttribute).name?.name === name) as NodePath<JSXAttribute> | undefined;
        if (config.redirectElements.includes(tag)) {
          const toValue = attr('to')?.get('value');
          const to = toValue?.node ? oneAddress((toValue.isJSXExpressionContainer() ? toValue.get('expression') : toValue) as NodePath) : UNKNOWN;
          redirects.push({ to, file: routeFile, line: p.node.loc!.start.line, guards: guardsOf(p, src, note) });
          return;
        }
        if (!config.routeElements.includes(tag)) return;
        const line = p.node.loc!.start.line;
        const unread = (reason: string) => void (definesRouteElement(p) || unreadRoutes.push({ file: routeFile, line, reason }));
        const pathAttr = attr('path');
        const compAttr = attr('component');
        const elementAttr = attr('element');
        const renderAttr = attr('render');
        const spread = p.get('openingElement.attributes').find((a) => a.isJSXSpreadAttribute());
        const drawnBy = () => (renderAttr ? renderPage(renderAttr, absFile) : childrenPage(p, absFile));
        if (!pathAttr) {
          if (spread) return unread(`the path may be in ${sliceText(src, spread.node)}`);
          if (holdsRoutes(p)) return;
          const drawn = compAttr ? componentAttrPage(compAttr, absFile) : elementAttr ? elementPage(elementAttr, absFile) : drawnBy();
          if (typeof drawn === 'string') return unread(drawn);
          if (drawn && drawn !== REDIRECT) unread('no path');
          return;
        }
        let page: Page | null;
        let drawnInFunctionOrChildren = false;
        if (compAttr) page = componentAttrPage(compAttr, absFile);
        else if (elementAttr) page = elementPage(elementAttr, absFile);
        else {
          if (holdsRoutes(p) || definesRouteElement(p)) return;
          const drawn = drawnBy();
          if (drawn === REDIRECT) return;
          if (typeof drawn === 'string') return unread(drawn);
          if (!drawn) return spread ? unread(`the screen may be in ${sliceText(src, spread.node)}`) : undefined;
          page = drawn;
          drawnInFunctionOrChildren = true;
        }
        if (!page) return;
        const pathWritten = pathAttr.get('value');
        const pathExpr = (pathWritten.isJSXExpressionContainer() ? pathWritten.get('expression') : pathWritten) as NodePath;
        const item = table ? loopItem(p, pathExpr) : null;
        if (item) {
          if (loopAt < 0) loopAt = screens.length;
          loopRoutes.push({ element: p.node, line, page, pathExpr, item, guards: guardsOf(p, src, note), wrappers: wrappersOf(p, absFile) });
          return;
        }
        const { path: routePath, stops, ...gives } = readRoutePath(pathExpr);
        let unreadPath: OuterFill['unreadPath'] = null;
        const outerAddress = routePath.startsWith(UNKNOWN) ? leadingPiece(pathExpr) : null;
        if (routePath.includes(UNKNOWN)) {
          const stoppedAt = stopOf(stops[0] ?? pathExpr);
          if (drawnInFunctionOrChildren && madeInLoop(p)) return unread(`made for each item of a list, and its path stopped at ${stoppedAt.text}`);
          const outerStops = outerAddress && new Set(readRoutePath(outerAddress).stops.map((x) => x.node));
          const rest = outerStops && stops.find((x) => !outerStops.has(x.node));
          unreadPath = { entry: { file: routeFile, line, path: routePath, stoppedAt, ...gives }, restStoppedAt: rest ? stopOf(rest) : null };
          unreadRoutePaths.push(unreadPath.entry);
        }
        const screen: RouteScreen = {
          path: routePath,
          component: page.component,
          componentFile: page.componentFile,
          wrapperFiles: [...page.files, ...wrappersOf(p, absFile)],
          routeFile,
          routeGuards: guardsOf(p, src, note),
          line,
          outerFill: { startsWithOuterAddress: Boolean(outerAddress) && readsMatchedRoute(outerAddress!), unreadPath },
        };
        screens.push(screen);
        elementScreens.set(p.node, [screen]);
      },
    });
    if (table) {
      const listed = tableScreens(table, loopRoutes, routeFile);
      elementScreens.set(loopRoutes[0].element, listed);
      screens.splice(loopAt < 0 ? screens.length : loopAt, 0, ...listed);
    }
    return { screens, roots: drawnTree(ast, absFile, elementScreens) };
  }

  function drawnTree(ast: ReturnType<typeof parseSource>['ast'], absFile: string, elementScreens: Map<Node, RouteScreen[]>) {
    const nodes = new Map<Node, DrawnNode>();
    const roots: DrawnNode[] = [];
    traverse(ast, {
      JSXElement(p) {
        const tag = tagOf(p.node.openingElement.name);
        if (!tag || definesRouteElement(p)) return;
        const attr = (name: string) => {
          const found = p.get('openingElement.attributes').find((a) => (a.node as JSXAttribute).name?.name === name) as NodePath<JSXAttribute> | undefined;
          if (!found) return undefined;
          const value = found.get('value') as NodePath<any>;
          return value.node ? (value.isJSXExpressionContainer() ? value.get('expression') as NodePath : value) : null;
        };
        const exact = attr('exact');
        const text = (p: NodePath | undefined | null) => (p ? readRoutePath(p).path : UNKNOWN);
        const node: DrawnNode = { kind: 'route', path: null, exact: exact === null || (Boolean(exact) && evaluate(exact!) === true), from: null, to: UNKNOWN, screens: elementScreens.get(p.node) ?? [], entry: null, isRoute: false, isFragment: false, redirectAsElement: false, children: [] };
        const binding = p.scope.getBinding(tag);
        const reactAs = (b: Binding | undefined) => {
          const from = b && importedAs(b);
          return from?.spec === 'react' ? from.name : null;
        };
        node.isFragment = tag === 'Fragment' ? reactAs(binding) === 'Fragment' : tag === 'React.Fragment' && ['default', '*'].includes(reactAs(p.scope.getBinding('React')) ?? '');
        if (tag === 'Switch') node.kind = 'switch';
        else if (routerImport(binding) && importedAs(binding!)!.name === 'Routes') node.kind = 'routes';
        else if (config.redirectElements.includes(tag)) {
          const from = attr('from');
          const to = attr('to');
          const holder = p.parentPath.isJSXExpressionContainer() ? p.parentPath.parentPath : null;
          Object.assign(node, { kind: 'redirect', from: from === undefined ? null : text(from), to: to ? oneAddress(to) : UNKNOWN, redirectAsElement: Boolean(holder?.isJSXAttribute() && holder.node.name.name === 'element') });
        } else if (config.routeElements.includes(tag)) {
          const at = attr('path');
          node.isRoute = true;
          node.path = node.screens.length ? node.screens[0].path : at === undefined ? null : text(at);
        } else if (!/^[a-z]/.test(tag.split('.').pop()!) || (tag.includes('.') && !fromPackage(p.scope, tag, absFile))) {
          node.entry = resolveTag(p.scope, tag, absFile) ?? null;
        }
        nodes.set(p.node, node);
        const parent = p.findParent((a) => a.isJSXElement() && nodes.has(a.node));
        (parent ? nodes.get(parent.node)!.children : roots).push(node);
      },
    });
    return roots;
  }

  function tableScreens(table: RouteTable & { at: string }, routes: LoopRoute[], routeFile: string): RouteScreen[] {
    if (!routes.length) throw new Error(`${table.at}: ${routeFile} has no route made for each item of a list whose path reads a field of the item`);
    if (routes.length > 1) throw new Error(`${table.at}: ${routeFile} has ${routes.length} routes made for each item of a list, at ${routes.map((r) => `${routeFile}:${r.line}`).join(' and ')}; a route file takes one table`);
    const [{ line, page, pathExpr, item, guards, wrappers }] = routes;
    const { file, const: name } = table.table;
    const object = topLevelObject(file, name);
    if (!object) throw new Error(`${table.at}: ${file} has no top-level const ${name} holding an object`);
    const items = tableItems(object, table.items.split('.')).map((it) => ({ ...it, field: propertyValue(it.object, item.field) }));
    if (!items.some((it) => it.field)) throw new Error(`${table.at}: items "${table.items}" finds no item with a ${item.field} in ${name}, which the route at ${routeFile}:${line} reads`);
    return items.flatMap(({ key, line: itemLine, object: itemObject, field }): RouteScreen[] => {
      const place = `table item ${key} at ${file}:${itemLine}`;
      if (!field) {
        unreadRoutes.push({ file: routeFile, line, reason: `${place} has no ${item.field}` });
        return [];
      }
      const value = evaluate(field);
      if (!readWhole(value)) {
        const at = stopOf(unreadPiece(field) ?? field);
        unreadRoutes.push({ file: routeFile, line, reason: `${place}: its ${item.field} stopped at ${at.text}${at.file === file ? '' : ` in ${at.file}:${at.line}`}` });
        return [];
      }
      const components = itemComponents(itemObject);
      if (components.length && components.every((c) => c.redirects)) return [];
      const routePath = pathText(pathExpr, item.node, String(value));
      const outerAddress = routePath.startsWith(UNKNOWN) ? leadingPiece(pathExpr) : null;
      let unreadPath: OuterFill['unreadPath'] = null;
      if (routePath.includes(UNKNOWN)) {
        const rest = outerAddress && unreadPiece(pathExpr, new Set(), [outerAddress.node, item.node]);
        unreadPath = { entry: { file: routeFile, line, path: routePath, stoppedAt: stopOf(unreadPiece(pathExpr, new Set(), [item.node])!) }, restStoppedAt: rest ? stopOf(rest) : null };
        unreadRoutePaths.push(unreadPath.entry);
      }
      const shown = components[0] ?? page;
      return [{
        path: routePath,
        component: shown.component,
        componentFile: shown.componentFile,
        wrapperFiles: [...new Set([page.componentFile, ...page.files, ...components.map((c) => c.componentFile), ...wrappers].filter(Boolean) as string[])],
        routeFile,
        routeGuards: guards,
        line,
        tableItem: { key, file, line: itemLine },
        outerFill: { startsWithOuterAddress: Boolean(outerAddress) && readsMatchedRoute(outerAddress!), unreadPath },
      }];
    });
  }

  const pathText = (p: NodePath, filled: Node, value: string): string => (p.node === filled ? value
    : p.isTemplateLiteral() ? p.node.quasis.map((q, i) => (i ? pathText(p.get(`expressions.${i - 1}`) as NodePath, filled, value) : '') + q.value.cooked).join('')
      : p.isBinaryExpression({ operator: '+' }) ? pathText(p.get('left'), filled, value) + pathText(p.get('right'), filled, value)
        : textOf(evaluate(p)));

  // 이름은 같은 파일의 const 나 import 한 값으로 따라간다.
  function objectAt(p: NodePath, seen = new Set<Node>()): NodePath<ObjectExpression> | null {
    if (p.isObjectExpression()) return p;
    if (!p.isIdentifier() || seen.has(p.node)) return null;
    seen.add(p.node);
    const declared = declaredValue(p.scope, p.node.name);
    return declared ? objectAt(declared, seen) : null;
  }

  function propertiesOf(object: NodePath<ObjectExpression>, seen = new Set<Node>()): NodePath<ObjectProperty>[] {
    return object.get('properties').flatMap((prop) => {
      if (prop.isSpreadElement()) {
        const spread = objectAt(prop.get('argument'));
        return spread && !seen.has(spread.node) ? propertiesOf(spread, seen.add(spread.node)) : [];
      }
      return prop.isObjectProperty() && !prop.node.computed ? [prop] : [];
    });
  }

  const propertyValue = (object: NodePath<ObjectExpression>, key: string) => propertiesOf(object).findLast((prop) => keyName(prop.node) === key)?.get('value') as NodePath | undefined;

  function tableItems(object: NodePath<ObjectExpression>, segments: string[], keys: string[] = [], line = object.node.loc!.start.line): { key: string; line: number; object: NodePath<ObjectExpression> }[] {
    if (!segments.length) return [{ key: keys.join('.'), line, object }];
    const [first, ...rest] = segments;
    return propertiesOf(object).flatMap((prop) => {
      const name = keyName(prop.node);
      const inner = (first === '*' || first === name) && objectAt(prop.get('value'));
      return inner ? tableItems(inner, rest, [...keys, name], prop.node.loc!.start.line) : [];
    });
  }

  function componentValues(p: NodePath, seen: Set<Node>): NodePath[] {
    if (seen.has(p.node)) return [];
    seen.add(p.node);
    if (p.isIdentifier()) {
      const declared = declaredValue(p.scope, p.node.name);
      return declared ? componentValues(declared, seen) : [];
    }
    if (p.isObjectExpression()) {
      return p.get('properties').flatMap((prop) => (prop.isSpreadElement() ? componentValues(prop.get('argument'), seen)
        : !prop.isObjectProperty() || prop.node.computed ? []
          : keyName(prop.node) === 'component' ? [prop.get('value') as NodePath] : componentValues(prop.get('value') as NodePath, seen)));
    }
    if (p.isArrayExpression()) return p.get('elements').flatMap((e) => (!e.node ? [] : componentValues(e.isSpreadElement() ? e.get('argument') : e as NodePath, seen)));
    return [];
  }

  // 항목 안 어느 깊이에 있든 `component:` 에 적은 컴포넌트를 적힌 차례대로 모은다.
  function itemComponents(object: NodePath<ObjectExpression>) {
    const found = new Map<string, Omit<Page, 'files'> & { redirects: boolean }>();
    for (const written of componentValues(object, new Set())) {
      const expr = unwrapCalls(written)!;
      const component = expr.node && memberChain(expr.node)?.join('.');
      const fromFile = component && programFile.get(expr.scope.getProgramParent().block);
      if (!fromFile) continue;
      const componentFile = components.find(expr.scope, component, fromFile, written.isCallExpression()).file;
      if (!found.has(`${component}\0${componentFile}`)) found.set(`${component}\0${componentFile}`, { component, componentFile, redirects: onlyRedirects(expr) });
    }
    return [...found.values()];
  }

  // 함수 컴포넌트가 돌려주는 것이 다른 주소로 보내는 요소 하나뿐인가. 다른 파일에 있으면 그 파일의 선언을 읽는다.
  function onlyRedirects(expr: NodePath) {
    const fn = expr.isIdentifier() ? declaredFunction(expr.scope, expr.node.name) : null;
    const element = fn && onlyReturned(fn);
    const tag = element?.isJSXElement() && tagOf(element.node.openingElement.name);
    return Boolean(tag) && config.redirectElements.includes(tag);
  }

  function declaredFunction(scope: Scope, name: string): AddressFunction | null {
    const binding = scope.getBinding(name);
    if (binding?.path.isFunctionDeclaration()) return binding.path;
    const from = binding?.kind === 'module' ? importedName(binding) : null;
    const exported = from && from.name !== '*' ? exportedFunction(from.file, from.name) : null;
    if (exported) return exported;
    const value = declaredValue(scope, name);
    return value?.isArrowFunctionExpression() || value?.isFunctionExpression() ? value : null;
  }

  function exportedFunction(file: string | null, name: string): AddressFunction | null {
    const found = file ? follower.declaration(file, name) : null;
    const program = found && programOf(found.file);
    const declared = !program ? null : found!.name === 'default' ? program.get('body').find((s) => s.isExportDefaultDeclaration())?.get('declaration') as NodePath | undefined : program.scope.getBinding(found!.name)?.path;
    if (declared?.isFunctionDeclaration()) return declared;
    const value = declared?.isVariableDeclarator() && declared.get('id').isIdentifier() && (declared.parent as VariableDeclaration).kind === 'const' ? declared.get('init') as NodePath : declared;
    return value?.isArrowFunctionExpression() || value?.isFunctionExpression() ? value : null;
  }

  function namespaceFunction(scope: Scope, chain: string[]) {
    const binding = scope.getBinding(chain[0]);
    const from = binding?.kind === 'module' ? importedName(binding) : null;
    return from?.name === '*' ? exportedFunction(from.file, chain[1]) : null;
  }

  const leadingPiece = (p: NodePath): NodePath => (p.isTemplateLiteral() && p.node.quasis[0].value.cooked === '' && p.node.expressions.length ? leadingPiece(p.get('expressions.0') as NodePath)
    : p.isBinaryExpression({ operator: '+' }) ? leadingPiece(p.get('left')) : p);

  // 바깥 라우트가 매치한 주소: match.url · props.match.path · useRouteMatch().url, 또는 거기서 꺼낸 url · path.
  const MATCHED_ADDRESS = ['url', 'path'];
  function readsMatchedRoute(p: NodePath): boolean {
    if (p.isMemberExpression() && !p.node.computed) return MATCHED_ADDRESS.includes((p.node.property as Identifier).name) && isRouteMatch(p.get('object'));
    if (!p.isIdentifier()) return false;
    const binding = p.scope.getBinding(p.node.name);
    if (!binding) return false;
    const property = (pattern: Node | null | undefined, keys: string[]) => (pattern?.type === 'ObjectPattern'
      ? pattern.properties.find((x): x is ObjectProperty => x.type === 'ObjectProperty' && keys.includes(keyName(x)))
      : undefined);
    const taken = (pattern: Node | null | undefined) => property(pattern, MATCHED_ADDRESS)?.value === binding.identifier;
    const takenFromMatch = (pattern: Node | null | undefined) => taken(property(pattern, ['match'])?.value);
    if (binding.path.isVariableDeclarator() && binding.path.get('id').isIdentifier()) return binding.kind === 'const' && readsMatchedRoute(binding.path.get('init') as NodePath);
    if (binding.path.isVariableDeclarator()) return takenFromMatch(binding.path.node.id) || (taken(binding.path.node.id) && isRouteMatch(binding.path.get('init') as NodePath));
    return binding.kind === 'param' && binding.path.isObjectPattern() && takenFromMatch(binding.path.node);
  }

  function isRouteMatch(p: NodePath): boolean {
    if (p.isCallExpression()) return p.get('callee').isIdentifier({ name: 'useRouteMatch' }) && !p.node.arguments.length;
    if (p.isMemberExpression() && !p.node.computed) return (p.node.property as Identifier).name === 'match';
    if (!p.isIdentifier({ name: 'match' })) return false;
    const binding = p.scope.getBinding('match');
    return !binding?.path.isVariableDeclarator() || !binding.path.get('id').isIdentifier() || isRouteMatch(binding.path.get('init') as NodePath);
  }

  function holdsRoutes(route: NodePath<JSXElement>) {
    let found = false;
    route.traverse({
      JSXElement(e) {
        const tag = tagOf(e.node.openingElement.name);
        if (tag && config.routeElements.includes(tag)) {
          found = true;
          e.stop();
        }
      },
    });
    return found;
  }

  function definesRouteElement(route: NodePath) {
    let owner: NodePath | null = route.getFunctionParent();
    if (owner?.isClassMethod()) owner = owner.parentPath.parentPath;
    while (owner && (owner.isFunction() || owner.isCallExpression() || owner.isClassExpression()) && !owner.isFunctionDeclaration()) owner = owner.parentPath;
    const id = owner && (owner.isVariableDeclarator() || owner.isFunctionDeclaration() || owner.isClassDeclaration()) ? owner.node.id : null;
    return id?.type === 'Identifier' && config.routeElements.includes(id.name);
  }

  const LOOP_METHODS = ['map', 'flatMap', 'forEach', 'reduce'];
  const loopCallback = (a: NodePath) => {
    const callee = a.isFunction() && a.listKey === 'arguments' && (a.parent as CallExpression).callee;
    return Boolean(callee) && (callee as Node).type.endsWith('MemberExpression') && LOOP_METHODS.includes(((callee as MemberExpression).property as Identifier).name);
  };
  const madeInLoop = (route: NodePath) => Boolean(route.findParent(loopCallback));

  const piecesOf = (p: NodePath): NodePath[] => (p.isTemplateLiteral() ? (p.get('expressions') as NodePath[]).flatMap(piecesOf)
    : p.isBinaryExpression({ operator: '+' }) ? [...piecesOf(p.get('left')), ...piecesOf(p.get('right'))] : [p]);

  // 목록을 도는 함수가 받는 항목에서 꺼낸 칸 하나(`item.url`)를 경로에 한 번 쓰는 라우트의 그 칸.
  function loopItem(route: NodePath, pathExpr: NodePath) {
    const fn = route.findParent(loopCallback);
    const param = fn && (fn.get('params') as NodePath[])[0];
    if (!param?.isIdentifier()) return null;
    const { name } = param.node;
    const binding = fn!.scope.getBinding(name);
    const reads = piecesOf(pathExpr).filter((x): x is NodePath<MemberExpression> => x.isMemberExpression() && !x.node.computed && x.get('object').isIdentifier({ name }) && x.scope.getBinding(name) === binding);
    return reads.length === 1 ? { node: reads[0].node, field: (reads[0].node.property as Identifier).name } : null;
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

  // 함수 본문이 돌려주는 값 하나. 문장이 return 하나뿐이 아니면 undefined 이다.
  function onlyReturned(fn: NodePath<ArrowFunctionExpression | FunctionExpression | FunctionDeclaration>) {
    const body = fn.get('body') as NodePath;
    const statements = body.isBlockStatement() ? body.get('body') : null;
    const returned = statements ? (statements.length === 1 && statements[0].isReturnStatement() ? (statements[0].get('argument') as NodePath) : null) : body;
    return unwrapCalls(returned ?? undefined);
  }

  function renderPage(renderAttr: NodePath<JSXAttribute>, routesFile: string): Page | typeof REDIRECT | string | null {
    const value = renderAttr.get('value');
    const fn = value.isJSXExpressionContainer() ? (value.get('expression') as NodePath) : null;
    if (!fn?.isArrowFunctionExpression() && !fn?.isFunctionExpression()) return 'render is not a function written in the route';
    const element = onlyReturned(fn);
    if (element?.isJSXElement() && holdsValue(element)) return null;
    const page = element?.isJSXElement() ? pageOf(element, routesFile) : null;
    if (isPage(page) && !isAppScreen(page, renderAttr.scope)) return null;
    return page ?? 'render does not return one component';
  }

  function childrenPage(route: NodePath<JSXElement>, routesFile: string): Page | typeof REDIRECT | string | null {
    if (holdsValue(route)) return null;
    const read = route.get('children').flatMap(elementsIn).map((e) => pageOf(e, routesFile));
    if (!read.length) return null;
    const pages = read.filter(isPage);
    const screens = pages.filter((c) => isAppScreen(c, route.scope));
    if (screens.length) return withFiles(pickPage(screens), pages.flatMap((c) => c.files));
    if (pages.length) return null;
    return read.every((c) => c === REDIRECT) ? REDIRECT : "the route's children hold no component";
  }

  function holdsValue(p: NodePath<any>): boolean {
    if (p.isJSXText() || p.isJSXEmptyExpression() || p.isLiteral()) return false;
    if (p.isJSXExpressionContainer()) return holdsValue(p.get('expression'));
    if (p.isJSXElement() || p.isJSXFragment()) return (p.get('children') as NodePath[]).some(holdsValue);
    if (p.isConditionalExpression()) return holdsValue(p.get('consequent')) || holdsValue(p.get('alternate'));
    if (p.isLogicalExpression()) return holdsValue(p.get('right'));
    return true;
  }

  function isAppScreen(page: Page, scope: Scope) {
    if (page.componentFile) return true;
    const binding = scope.getBinding(page.component.split('.')[0]);
    if (!binding || binding.kind === 'module' || binding.kind === 'param') return false;
    let init = binding.path.isVariableDeclarator() ? (binding.path.get('init') as NodePath) : null;
    while (init?.isMemberExpression()) init = init.get('object');
    return !(init?.isCallExpression() && init.get('callee').isIdentifier({ name: 'require' }));
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

  function fillOuterAddresses(sourced: { s: { path: string; routeFile: string }; outerFill: OuterFill; files: string[] }[]) {
    const holds = sourced.map((x) => new Set(x.files));
    const routeFileOf = (i: number) => path.join(config.srcRoot, sourced[i].s.routeFile);
    const outersOf = (i: number) => {
      const around = sourced.flatMap((x, j) => (x.s.routeFile !== sourced[i].s.routeFile && holds[j].has(routeFileOf(i)) ? [j] : []));
      return around.filter((j) => !around.some((k) => sourced[k].s.routeFile !== sourced[j].s.routeFile && holds[j].has(routeFileOf(k))));
    };
    const filled = new Map<number, string>();
    const filling = new Set<number>();
    const addressOf = (i: number): string => {
      const { s, outerFill } = sourced[i];
      if (!outerFill.startsWithOuterAddress || filling.has(i)) return s.path;
      if (!filled.has(i)) {
        filling.add(i);
        const rest = s.path.slice(UNKNOWN.length);
        const outer = joinedPaths([...new Set(outersOf(i).map(addressOf))], rest);
        filling.delete(i);
        filled.set(i, outer === null ? s.path : outer.replace(/\/$/, '') + rest || '/');
      }
      return filled.get(i)!;
    };
    sourced.forEach((x, i) => {
      const address = addressOf(i);
      const { unreadPath } = x.outerFill;
      if (address === x.s.path) return;
      x.s.path = address;
      if (!unreadPath) return;
      if (address.includes(UNKNOWN)) Object.assign(unreadPath.entry, { path: address, stoppedAt: unreadPath.restStoppedAt ?? unreadPath.entry.stoppedAt });
      else unreadRoutePaths.splice(unreadRoutePaths.indexOf(unreadPath.entry), 1);
    });
  }

  function routeTree(drawn: { file: string; roots: DrawnNode[] }[], extracted: RouteScreen[], sourced: { s: { path: string; componentFile: string | null | undefined } }[]) {
    const indexOf = new Map(extracted.map((s, i) => [s, i]));
    const closures = new Map<string, Set<string>>();
    const closure = (f: string) => {
      if (!closures.has(f)) closures.set(f, new Set(closureOf(f, (g) => screenFiles.has(g) && g !== f)));
      return closures.get(f)!;
    };
    // 다른 라우트 파일을 거쳐서 닿는 라우트 파일은 그 파일에 둔다.
    const heldFiles = (entries: string[], own: string) => {
      const reached = new Set(entries.flatMap((e) => [...closure(e)]));
      const held = [...routeFileSet].filter((f) => f !== own && reached.has(f));
      return held.filter((f) => !held.some((g) => g !== f && closure(g).has(f)));
    };
    const holding = new Map<RouteNode & { kind: 'route' }, { files: string[]; base: string; around: string[] }>();
    let around: string[] = [];
    const convert = (n: DrawnNode, file: string, base = ''): RouteNode[] => {
      if (n.kind === 'routes') {
        const branches: Branch[] = [];
        const unwrapped = (nodes: DrawnNode[]): DrawnNode[] => nodes.flatMap((c) => (c.isFragment ? unwrapped(c.children) : [c]));
        const flatten = (routes: DrawnNode[], outerPath: string, chain: Branch['chain']) => {
          for (const r of unwrapped(routes).filter((c) => c.isRoute)) {
            const drawnBy = unwrapped(r.children).filter((c) => !c.isRoute && (c.kind !== 'redirect' || c.redirectAsElement));
            for (const node of convert({ ...r, children: drawnBy }, file, outerPath) as Branch['chain']) {
              const own = node.path === null ? null : node.path.startsWith('/') ? node.path : `${outerPath}/${node.path}`.replace(/\/{2,}/g, '/');
              flatten(r.children, own ?? outerPath, [...chain, node]);
              if (own !== null) branches.push({ path: own, chain: [...chain, node] });
            }
          }
        };
        flatten(n.children, base, []);
        return [{ kind: 'routes', branches }];
      }
      if (n.kind === 'switch') return [{ kind: 'switch', children: n.children.flatMap((c) => convert(c, file, base)) }];
      if (n.kind === 'redirect') return [{ kind: 'redirect', from: n.from, exact: n.exact, to: n.to }];
      const byPath = new Map<string | null, number[]>();
      for (const i of n.screens.map((s) => indexOf.get(s)!)) byPath.set(sourced[i].s.path, [...(byPath.get(sourced[i].s.path) ?? []), i]);
      if (!byPath.size) byPath.set(n.path, []);
      return [...byPath].map(([routePath, screens]) => {
        const entries = screens.length ? screens.flatMap((i) => sourced[i].s.componentFile ?? []) : n.entry ? [n.entry] : [];
        const full = routePath === null || routePath.startsWith('/') ? routePath : `${base}/${routePath}`.replace(/\/{2,}/g, '/');
        const inner = full === null ? base : full.endsWith('/*') ? full.slice(0, -2) : '';
        const node = { kind: 'route' as const, path: routePath, exact: n.exact, screens, children: n.children.flatMap((c) => convert(c, file, inner)) };
        const held = heldFiles(entries, file);
        if (held.length) holding.set(node, { files: held, base: inner, around });
        return node;
      });
    };
    const converted = (file: string, roots: DrawnNode[], base: string, outer: string[]) => {
      around = [...outer, file];
      return roots.flatMap((r) => convert(r, file, base));
    };
    const rootsOf = new Map(drawn.map((d) => [d.file, converted(d.file, d.roots, '', [])]));
    const drawnRoots = new Map(drawn.map((d) => [d.file, d.roots]));
    const based = new Map<string, RouteNode[]>();
    const rootsUnder = (f: string, base: string, outer: string[]) => {
      if (!base || outer.includes(f)) return rootsOf.get(f)!;
      const key = `${f}\0${base}`;
      if (!based.has(key)) based.set(key, converted(f, drawnRoots.get(f)!, base, outer));
      return based.get(key)!;
    };
    const held = new Set<string>();
    for (const [node, { files, base, around: outer }] of holding) {
      for (const f of files) {
        node.children.push(...rootsUnder(f, base, outer));
        held.add(f);
      }
    }
    const roots = drawn.filter((d) => !held.has(d.file)).flatMap((d) => rootsOf.get(d.file)!);
    return roots.length ? roots : rootsOf.get(drawn[0].file)!;
  }

  function joinedPaths(paths: string[], rest: string) {
    if (!paths.length || paths.some((p) => p.includes(UNKNOWN))) return null;
    if (paths.length === 1) return paths[0];
    const split = paths.map((p) => p.split('/'));
    if (split.some((parts) => parts.length !== split[0].length)) return null;
    const differ = split[0].flatMap((_, at) => (split.some((parts) => parts[at] !== split[0][at]) ? [at] : []));
    const words = split.map((parts) => parts[differ[0]]);
    if (differ.length !== 1 || !words.every((w) => /^[\w-]+$/.test(w))) return null;
    let name = 'section';
    for (let n = 2; [...paths, rest].some((p) => new RegExp(`:${name}\\b`).test(p)); n++) name = `section${n}`;
    return split[0].map((part, at) => (at === differ[0] ? `:${name}(${words.join('|')})` : part)).join('/');
  }

  // ---------- 화면마다 모으기 ----------

  const apiFunctions: Record<string, any> = {};
  for (const f of apiModuleFiles) Object.assign(apiFunctions, extractApiModule(f));
  if (calledFiles.size) called = await recordApiCalls(config, imports.resolve, new Set(Object.keys(apiFunctions)));
  Object.assign(apiFunctions, called?.functions);

  const routeValues = lookupConstant(constants, routeChain) ?? {};
  const rel = (f: string | null | undefined) => (f ? path.relative(config.srcRoot, f) : null);

  if (!config.routeFiles.length) throw new Error(`the config has no routesFile, which takes ${ROUTES_FILE}`);
  const drawn = (config.routeFiles as string[]).map((f) => ({ file: path.join(config.srcRoot, f), ...extractScreens(f) }));
  const extracted = drawn.flatMap((d) => d.screens);
  const screenFiles = new Set(extracted.map((s) => s.componentFile).filter(Boolean));
  const sourced = extracted.map(({ wrapperFiles, outerFill, ...s }) => {
    const entryFiles = [s.componentFile, ...wrapperFiles].filter(Boolean) as string[];
    const isOtherScreen = (f: string) => screenFiles.has(f) && !entryFiles.includes(f);
    return { s, outerFill, entryFiles, isOtherScreen, files: [...new Set(entryFiles.flatMap((f) => closureOf(f, isOtherScreen)))] };
  });
  fillOuterAddresses(sourced);
  const routedScreens = routerTargets(routeTree(drawn, extracted, sourced));
  // POST 가 아닌 페이지 이동의 주소가 앱의 라우트와 맞으면 서버가 아니라 앱의 다른 화면이 열린다. 고정 문자열 부분이 없는 라우트는 어떤 주소에나 맞으므로 견주지 않는다.
  const screenRoutes = sourced.map((x) => x.s).filter((s) => !s.path.includes(UNKNOWN) && pathParts(s.path).some((part) => typeof part === 'string' && /[^/]/.test(part))).map((s) => routePattern(s.path));
  const opensScreen = (url: string) => screenRoutes.some((route) => route.test(url.replaceAll(UNKNOWN, '\0').split(/[?#]/)[0]));
  const isApiCall = (site: FollowedSite): site is ApiCallSite => 'fn' in site;
  const sends = (c: ApiCallSite, outsideRequestFunction: Set<FollowedSite>) => !c.request || (outsideRequestFunction.has(c) && !(c.navigation && c.request.method !== 'POST' && opensScreen(c.request.url!)));

  // saga 는 화면이 import 하지 않는 파일에 있어도 돈다. API · 상수 파일은 화면에서와 같이 그 안으로 들어가지 않는다.
  const sagaScope = (f: string | null) => !apiModuleFiles.has(f!) && !calledFiles.has(f!) && !constantFiles.has(f!);
  const sagaSources = sagaFiles(config.srcRoot);
  const runs = sagaSources.flatMap((file) => {
    try {
      return sagas.runs(file);
    } catch {
      return [];
    }
  });
  const watchesOf = new Map<string, Watch[]>();
  if (runs.length) {
    for (const site of follower.reach(runs, sagaScope)) {
      if (!('watches' in site)) continue;
      for (const w of site.watches) watchesOf.set(w.type.key, [...(watchesOf.get(w.type.key) ?? []), w]);
    }
  }
  // 핸들러가 도달한 파일의 top-level 코드가 saga 를 실행해도, 그 run 에 넘긴 saga 는 탐색하지 않는다.
  const inRun = (file: string, pos: number) => runs.some((r) => r.file === file && pos >= r.span[0] && pos < r.span[1]);
  // saga 안에서 이동하는 주소를 읽지 못하면 화면 코드와 달리 {?} 로도 남기지 않는다.
  const readAddress = (l: RouteRef | RouterLink) => ('route' in l ? typeof routeValues[l.route] === 'string' : l.to !== UNKNOWN);
  const handled = new Map<string, { sent: ApiCallSite[]; moves: (RouteRef | RouterLink)[] }>();
  const byHandler = ({ file, span }: Handler) => {
    const key = `${file}\0${span.join('-')}`;
    if (!handled.has(key)) {
      const starts = [{ file, span }];
      const reached = follower.reach(starts, sagaScope, { cut: inRun });
      const outside = requestFile && sagaScope(requestFile) ? follower.reach(starts, (f) => sagaScope(f) && f !== requestFile, { cut: inRun }) : reached;
      const moves = [...reached].filter((l): l is RouteRef | RouterLink => 'route' in l || 'to' in l).filter(readAddress);
      handled.set(key, { sent: [...reached].filter(isApiCall).filter((c) => sends(c, outside)), moves });
    }
    return handled.get(key)!;
  };

  const members = typedMembers(config.tsconfig, [...new Set(sourced.flatMap((x) => x.files))], imports.resolve);
  const screenFollower = members ? nameFollower<FollowedSite>({ parse, resolve: imports.resolve, sitesOf, members }) : follower;
  const screens = sourced.map(({ s, entryFiles, isOtherScreen, files }) => {
    const inSources = new Set<string | null>(files);
    // 화면이 import 하지 않고 context 훅에서 받은 스토어를 거쳐서만 닿는 파일. 화면의 소스는 아니지만, 화면이 호출한 스토어 메서드를 추적할 때 들어간다.
    const received = new Set<string>();
    const canEnter = (f: string | null) => inSources.has(f) || received.has(f!);
    const loaded = (f: string) => inSources.has(f);
    const starts = entryFiles.map((file) => ({ file, name: null }));
    let reached: Set<FollowedSite>;
    for (;;) {
      const missed = new Set<string>();
      reached = screenFollower.reach(starts, canEnter, { missed, loaded });
      const more = [...missed].flatMap((f) => closureOf(f, isOtherScreen)).filter((f) => !canEnter(f));
      if (!more.length) break;
      for (const f of more) received.add(f);
    }
    // 요청 함수의 파일을 거쳐야만 이어지는 요청은 그 함수가 받은 주소로 보내는 것이라, 화면 코드에서 나가는 요청이 아니다.
    const outsideRequestFunction = canEnter(requestFile) ? screenFollower.reach(starts, (f) => canEnter(f) && f !== requestFile, { loaded }) : reached;
    const apiCalls: (ApiCallSite & { file: string | null })[] = [];
    const own = new Set<ApiCallSite>();
    const dispatched = new Map<string, { type: ActionType; at: Set<string> }>();
    const settingReads: (SettingRead & { file: string | null })[] = [];
    const links: (Site & { route?: string; to: unknown; tail?: string; reaches?: number[]; file: string | null; actions?: DispatchedActions })[] = [];
    const ownLinks = new Set<FollowedSite>();
    const takeCalls = (f: string, facts: Facts) => {
      for (const c of facts.apiCalls) {
        if (!reached.has(c) || !sends(c, outsideRequestFunction)) continue;
        own.add(c);
        apiCalls.push({ ...c, file: rel(f) });
      }
    };
    for (const f of files) {
      const facts = fileFacts(f);
      takeCalls(f, facts);
      for (const d of watchesOf.size ? facts.dispatches : []) {
        if (!reached.has(d)) continue;
        for (const type of d.types()) {
          if (!dispatched.has(type.key)) dispatched.set(type.key, { type, at: new Set() });
          dispatched.get(type.key)!.at.add(`${rel(f)}:${d.line}`);
        }
      }
      for (const r of facts.settingReads) settingReads.push({ ...r, file: rel(f) });
      for (const ref of linkSites(facts)) {
        if (!reached.has(ref)) continue;
        ownLinks.add(ref);
        if (!('route' in ref)) {
          links.push({ ...ref, file: rel(f), reaches: routedScreens(ref.to) });
          continue;
        }
        const { tail, ...r } = ref;
        const value = routeValues[r.route];
        links.push(typeof value === 'string' && tail ? { ...r, to: value + tail, tail, file: rel(f) } : { ...r, to: value ?? UNKNOWN, file: rel(f) });
      }
    }
    // 훅으로만 받은 스토어 파일의 dispatch 는 읽지 않는다.
    for (const f of received) takeCalls(f, fileFacts(f));
    const bySaga = new Map<ApiCallSite, DispatchedActions>();
    const movedBySaga = new Map<RouteRef | RouterLink, DispatchedActions>();
    for (const { type, at } of dispatched.values()) {
      const handlers = (watchesOf.get(type.key) ?? []).map((w) => byHandler(w.handler));
      const action = { type: type.name, dispatchedAt: [...at].sort() };
      for (const c of new Set(handlers.flatMap((h) => h.sent))) {
        if (own.has(c)) continue;
        if (!bySaga.has(c)) bySaga.set(c, []);
        bySaga.get(c)!.push(action);
      }
      for (const l of new Set(handlers.flatMap((h) => h.moves))) {
        if (ownLinks.has(l)) continue;
        if (!movedBySaga.has(l)) movedBySaga.set(l, []);
        movedBySaga.get(l)!.push(action);
      }
    }
    const byType = (actions: DispatchedActions) => actions.sort((a, b) => compare(a.type, b.type) || compare(a.dispatchedAt[0], b.dispatchedAt[0]));
    const sagaCalls = [...bySaga].map(([c, actions]) => ({ ...c, file: rel(siteFile.get(c)), actions: byType(actions) }));
    sagaCalls.sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.fn, b.fn));
    const sagaLinks = [...movedBySaga].map(([ref, actions]) => {
      const file = rel(siteFile.get(ref));
      if (!('route' in ref)) return { ...ref, file, reaches: routedScreens(ref.to), actions: byType(actions) };
      const { tail, ...r } = ref;
      const value = routeValues[r.route] as string;
      return tail ? { ...r, to: value + tail, tail, file, actions: byType(actions) } : { ...r, to: value, file, actions: byType(actions) };
    });
    sagaLinks.sort((a, b) => compare(a.file, b.file) || a.line - b.line);
    links.push(...sagaLinks);
    return { ...s, componentFile: rel(s.componentFile), closureSize: files.length, sourceFiles: files.map(rel).sort(), apiCalls: [...apiCalls, ...sagaCalls], settingReads, links };
  });

  const sagaRuns = sagaSources.length ? { runs: runs.map(({ file, line }) => `${rel(file)}:${line}`), watchers: [...watchesOf.values()].flat().length } : null;
  return { screens, apiFunctions, sagaRuns, unrunApiModules: called?.failedModules ?? null, outsideStandIns: called?.outsideStandIns ?? [], silentApiModules: called?.silentModules ?? [], bodyTypeNotices: called?.bodyTypeNotices.length ? called.bodyTypeNotices : null, redirects, unreadRoutePaths, unreadRoutes, guardInits, constants, guardSettings, settingsDefaults, settingsDefaultsIncomplete, settingsCallNotices, unresolvedAliasImports: imports.unresolved(), madeHistories: [...madeHistories].sort(([a], [b]) => compare(a, b)).map(([file, call]) => ({ file, call })) };
}
