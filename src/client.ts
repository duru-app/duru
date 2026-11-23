import fs from 'node:fs';
import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import type { ArrayExpression, CallExpression, Expression, Identifier, ImportSpecifier, ExportSpecifier, JSXAttribute, JSXElement, MemberExpression, Node, ObjectMethod, ObjectProperty, OptionalMemberExpression, Program, StringLiteral, VariableDeclaration, VariableDeclarator } from '@babel/types';
import { routerTargets } from './access.ts';
import type { Constants, GuardInit, Side } from './access.ts';
import { apiModuleInputs, recordApiCalls } from './api-calls.ts';
import { clientCallReader } from './client-calls.ts';
import { clientLinkReader } from './client-links.ts';
import type { RouteTab } from './client-links.ts';
import { clientRouteReader } from './client-routes.ts';
import type { FrameFile, RouteScreen } from './client-routes.ts';
import { compare, ROUTES_FILE } from './config.ts';
import { guardConditionReader } from './guard-conditions.ts';
import { inTypePosition, nameFollower } from './follow-names.ts';
import { pathParts, routePattern } from './path-values.ts';
import { sagaFiles, sourceFiles } from './saga-requests.ts';
import type { CallInputs } from './screen-inputs.ts';
import type { ActionType, Handler, Watch } from './saga-requests.ts';
import { addresses, madeFrom } from './screen-links.ts';
import { importedAs } from './screen-requests.ts';
import type { UnresolvedReason } from './server.ts';
import { typedMembers } from './typed-members.ts';
import { sourceValueReader } from './source-values.ts';

type Span = { start?: number | null; end?: number | null };
type NameNode = { name?: string; value?: string };
export type Note = (text: string, exprPath: NodePath, negated: boolean, source: string) => void;
type Init = { name: string | null; init: string };

interface ConstInits {
  inits: Init[];
  calls: [string, Binding | null][];
}

export interface GuardEntry extends GuardInit {
  source: string | null;
  inits: Init[];
  callees?: Map<string, string | null>;
}

export interface InheritedGuard {
  via: string;
  line: number;
  guards: string[];
  file?: string;
}

interface Site {
  line: number;
  guards: string[];
  inheritedGuards?: InheritedGuard[];
}

export type BodyOption = { key: string; line: number };
type ApiCallSite = Site & { fn: string; options: BodyOption[]; request?: { method: string | null; url: string | null; unresolved?: UnresolvedReason }; navigation?: true; actions?: DispatchedActions; inputs?: CallInputs };
type DispatchedActions = { type: string; dispatchedAt: string[] }[];
type DispatchSite = { line: number; types: () => ActionType[] };
type WatcherSite = { watches: Watch[] };
type SettingRead = Site & { key: string };
export type RouteRef = Site & { route: string; tail?: string | null };
export type RouterLink = Site & { to: string; sides?: Side[] };
// 테이블 항목마다 메뉴 링크를 렌더링하는 요소. 반복문의 항목에서 라우트 경로와 같은 field 를 가져다 쓴다.
type MenuElement = RouterLink & { menu: string };
type FollowedSite = ApiCallSite | DispatchSite | WatcherSite | RouteRef | RouterLink;
type SiteKind = 'apiCalls' | 'settingReads' | 'routeRefs' | 'routerLinks';

export interface Facts {
  imports: string[];
  apiCalls: ApiCallSite[];
  dispatches: DispatchSite[];
  watchers: WatcherSite[];
  settingReads: SettingRead[];
  routeRefs: RouteRef[];
  routerLinks: RouterLink[];
  dynamicOnly?: Set<string>;
}

export interface ModuleEndpoint {
  method: unknown;
  url: unknown;
  line: number;
  via?: string;
}

export interface ModuleFunction {
  file: string;
  line: number;
  endpoints: ModuleEndpoint[];
  delegates?: string[];
}

export type TableItem = { key: string; file: string; line: number };

export interface RouteTable {
  route: string;
  table: { file: string; const: string };
  items: string;
  menus?: string[];
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

export function sliceText(src: string, node: Span) {
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
export function constInits(exprPath: NodePath, src: string, valueOf: (p: NodePath) => unknown) {
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

export const QUERY_PACKAGES = new Set(['react-query', '@tanstack/react-query']);
export const QUERY_HOOKS = new Set(['useQuery', 'useInfiniteQuery', 'useSuspenseQuery', 'useSuspenseInfiniteQuery', 'useQueries', 'useSuspenseQueries']);

export type QueryEnabled = (parent: NodePath, child: NodePath, site: NodePath) => NodePath | null;

export function guardsOf(nodePath: NodePath, src: string, note: Note, queryEnabled?: QueryEnabled, until?: Node) {
  const guards: string[] = [];
  const add = (text: string, exprPath: NodePath, negated: boolean, source: string) => {
    guards.push(text);
    note(text, exprPath, negated, source);
  };
  const enabledSeen = new Set<Node>();
  let child = nodePath;
  let parent = nodePath.parentPath;
  while (parent && parent.node !== until) {
    const p = parent.node;
    if (p.type === 'LogicalExpression' && p.operator === '&&' && child.key === 'right') {
      add(sliceText(src, p.left), parent.get('left') as NodePath, false, src.slice(p.left.start!, p.left.end!));
    } else if ((p.type === 'ConditionalExpression' || p.type === 'IfStatement') && child.key !== 'test') {
      const t = sliceText(src, p.test);
      const s = src.slice(p.test.start!, p.test.end!);
      const negated = child.key !== 'consequent';
      add(negated ? `!(${t})` : t, parent.get('test') as NodePath, negated, negated ? `!(${s})` : s);
    } else if ((p.type === 'ObjectProperty' && child.key === 'value') || (p.type === 'ObjectMethod' && child.key === 'body')) {
      const row = pickedRow(parent as NodePath<ObjectProperty | ObjectMethod>, src);
      if (row) add(row.text, row.at, false, row.text);
    } else if (p.type === 'LogicalExpression' && p.operator !== '&&' && child.key === 'right' && tableLookup(parent.get('left') as NodePath)) {
      const t = sliceText(src, p.left);
      const s = src.slice(p.left.start!, p.left.end!);
      add(`!(${t})`, parent.get('left') as NodePath, true, `!(${s})`);
    } else if (queryEnabled) {
      const enabled = queryEnabled(parent, child, nodePath);
      if (enabled && !enabledSeen.has(enabled.node)) {
        enabledSeen.add(enabled.node);
        guards.push(sliceText(src, enabled.node));
      }
    }
    child = parent;
    parent = parent.parentPath;
  }
  return guards;
}

// 같은 파일에서 `T[k]` 나 `T.name` 으로만 읽는 const 객체 T 와 그것을 읽는 자리
function tableReads(obj: NodePath): NodePath<MemberExpression | OptionalMemberExpression>[] | null {
  const declarator = obj.parentPath!;
  if (!obj.isObjectExpression() || !declarator.isVariableDeclarator() || obj.key !== 'init' || declarator.node.id.type !== 'Identifier' || (declarator.parent as VariableDeclaration).kind !== 'const') return null;
  const reads: NodePath<MemberExpression | OptionalMemberExpression>[] = [];
  for (const ref of declarator.scope.getBinding(declarator.node.id.name)!.referencePaths) {
    const up = ref.parentPath!;
    if (!(up.isMemberExpression() || up.isOptionalMemberExpression()) || up.node.object !== ref.node) return null;
    if ((up.parentPath.isAssignmentExpression() && up.key === 'left') || up.parentPath.isUpdateExpression()) return null;
    reads.push(up);
  }
  return reads;
}

function tableLookup(p: NodePath) {
  if (!(p.isMemberExpression() || p.isOptionalMemberExpression()) || !p.node.computed || p.node.object.type !== 'Identifier') return false;
  const binding = p.scope.getBinding(p.node.object.name);
  return !!binding?.path.isVariableDeclarator() && !!tableReads(binding.path.get('init') as NodePath);
}

function pickedRow(row: NodePath<ObjectProperty | ObjectMethod>, src: string): { text: string; at: NodePath } | null {
  const reads = tableReads(row.parentPath);
  const rows = row.parentPath.get('properties') as NodePath<any>[];
  if (!reads || rows.some((r) => r.isSpreadElement())) return null;
  const written = (key: NodePath<any>, computed: boolean) =>
    (computed && !key.isStringLiteral() && !key.isNumericLiteral() ? (key.isIdentifier() ? key.node.name : sliceText(src, key.node)) : `'${keyName({ key: key.node })}'`);
  const rowKey = (r: NodePath<any>) => written(r.get('key') as NodePath, r.node.computed);
  const keys = new Set(rows.map(rowKey));
  const readKeys = reads.map((r) => written(r.get('property') as NodePath, r.node.computed));
  const pickers = new Set(readKeys.filter((k) => !keys.has(k) && !k.startsWith("'")));
  const own = rowKey(row);
  return pickers.size === 1 && !readKeys.includes(own) ? { text: `${[...pickers][0]} === ${own}`, at: row.get('key') as NodePath } : null;
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

export const lookedUp = (ref: NodePath) => {
  const up = ref.parentPath!;
  return (up.isMemberExpression() || up.isOptionalMemberExpression()) && up.node.object === ref.node && up.node.computed;
};

// 키로 값을 찾기만 하는 표: 그렇다고 알 수 없으면 null, 내보낸 표는 가져다 쓰는 파일까지 볼 이름
function lookupTable(obj: NodePath): { exported: string | null } | null {
  if (obj.isObjectPattern()) return { exported: null };
  const declarator = obj.parentPath!;
  if (!declarator.isVariableDeclarator() || obj.key !== 'init' || declarator.node.id.type !== 'Identifier' || (declarator.parent as VariableDeclaration).kind !== 'const') return null;
  const name = declarator.node.id.name;
  const refs = declarator.scope.getBinding(name)!.referencePaths;
  const exportedAs = refs.filter((r) => r.isExportNamedDeclaration() || r.parentPath!.isExportSpecifier());
  if (!refs.every((r) => lookedUp(r) || exportedAs.includes(r)) || exportedAs.some((r) => !r.isExportNamedDeclaration() && ((r.parent as ExportSpecifier).exported as Identifier).name !== name)) return null;
  return { exported: exportedAs.length ? name : null };
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

function declaredAt(program: Program, name: string): number | null {
  for (const stmt of program.body) {
    if (name === 'default' && stmt.type === 'ExportDefaultDeclaration') return stmt.start!;
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (decl?.type === 'VariableDeclaration') {
      const found = decl.declarations.find((d) => d.id.type === 'Identifier' && d.id.name === name);
      if (found) return found.id.start!;
    } else if (decl && 'id' in decl && decl.id?.type === 'Identifier' && decl.id.name === name) return decl.id.start!;
  }
  return null;
}

// 화면마다 라우트 조건 · 화면이 쓰는 이름으로 닿는 API 호출 · import 로 이어지는 파일의 설정값 읽기와 링크를 모으고, API 모듈의 함수별 endpoint 를 함께 돌려준다.
export async function extractClient(config: any) {
  const {
    imports, components, constants, apiModuleFiles, calledFiles, constantFileOf, routeChain, routeRoot, routeRest, constantModuleFiles, constantFiles, settingsRoots, routeTables, tableFiles, menuTables, tableRoutes, routeFileSet,
    mapOf, programFile, parse, importedFile, programOf, declaredValue, importedName, namespaceMember, textOf, evaluate, lossless,
    constInit, objectLiteral, propertyKey, rootIdentifier, memberName, isCallee, functionName, returnedValues, attributeValue, literalAt, objectAt, fileOf, keysInOrder, propertiesOf, propertyValue, keyedValue,
    declaredFunction, exportedDeclaration, functionAt, importingCalls, namespaceFunction, declaredClass, loopCallback, tagOf, unwrapCalls, rel,
  } = await sourceValueReader({ config, declaration: (file, name) => follower.declaration(file, name) });
  let called: Awaited<ReturnType<typeof recordApiCalls>> | null = null;
  const factCache = new Map<string, Facts>();
  const siteStart = new WeakMap<FollowedSite, number>();
  const siteFile = new WeakMap<FollowedSite, string>();
  const linkSites = (facts: Facts): (RouteRef | RouterLink)[] => [...facts.routeRefs, ...facts.routerLinks];
  const sitesOf = (file: string) => {
    const facts = fileFacts(file);
    return [...facts.apiCalls, ...facts.dispatches, ...facts.watchers, ...linkSites(facts)].map((site) => ({ start: siteStart.get(site)!, site }));
  };
  const follower = nameFollower<FollowedSite>({ parse, resolve: imports.resolve, sitesOf });

  const {
    guardInits, guardSettings, settingsDefaults, settingsDefaultsIncomplete, settingsCallNotices, settingsResult, needs, noteSettings,
    tableLiteral, guardNote, queryEnabled, hookEnabled, settingsPath,
  } = guardConditionReader({ config, resolve: imports.resolve, constants, constantFileOf, mapOf, programFile, importedFile, evaluate, lossless, constInit, objectLiteral, propertyKey, rootIdentifier });

  // ---------- 일반 파일: import · API 호출 · 설정 읽기 · 라우트 참조 ----------

  const { bodyOptions, extractApiModule, sagas, calledOrigin, requestFile, screenRequests, screenInputs } = clientCallReader({ config, resolve: imports.resolve, follower, constants, calledFiles, parse, programFile, evaluate, constInit, objectLiteral, propertyKey });

  const manyLinkBranches: { file: string; line: number; sites: RouterLink[] }[] = [];

  const {
    linkAddressRefs, exportedKeys, importedLater, comparedLists, listReaderFiles, movedTo, madeHistories, usedListed, routeTabNotices,
    lookedUpElsewhere, listReadersCompare, listedRoutes, passThrough, linkReading, routeChainOf, linkAddresses, addressesOf, outsideAddresses, listedAddresses, oneAddress,
    routeTail, comparedOnly, listComparedOnly, fillsPathVariable, screenLinks, exportingFile, listedComponents, listedFunctions, routeTabEntries, listedCall, linkComponentOf,
  } = clientLinkReader({
    config, resolve: imports.resolve, follower, factCache, routeValues: () => routeValues, testSide: (test, on) => testSide(test, on),
    routeChain, routeRoot, routeRest, programFile, programOf, declaredValue, importedName, evaluate, lossless,
    constInit, memberName, isCallee, functionName, returnedValues, objectAt, keysInOrder, declaredFunction, exportedDeclaration, importingCalls, namespaceFunction, declaredClass,
    settingsDefaults, settingsResult, settingsPath, needs,
  });
  function valuesAt(p: NodePath<CallExpression>, place: string): NodePath[] {
    const [index, ...keys] = place.split('.');
    let value = (p.get('arguments') as NodePath<any>[])[Number(index)] as NodePath<any> | undefined;
    for (const key of keys) {
      const prop = value?.isObjectExpression() ? (value.get('properties') as NodePath<any>[]).findLast((x) => (x.isObjectProperty() || x.isObjectMethod()) && !x.node.computed && keyName(x.node) === key) : undefined;
      value = prop?.isObjectMethod() ? prop : (prop?.get('value') as NodePath<any> | undefined);
    }
    if (!value?.node || value.isSpreadElement()) return [];
    return value.isFunction() ? returnedValues(value) : [value];
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
    const localFnRefs = new Map<string, { fnPath: NodePath; items: { kind: SiteKind; site: Site }[] }>();
    const constantAt = new Map<Node, RouteRef[]>();
    const relFile = path.relative(config.srcRoot, file);
    const note = guardNote(relFile, src);

    function record(kind: SiteKind, entry: object, nodePath: NodePath, ownGuards: string[] = [], inherits = true) {
      const guards = [...ownGuards, ...guardsOf(nodePath, src, note, kind === 'apiCalls' ? queryEnabled : undefined)];
      const owner = enclosingFunctionName(nodePath);
      const item = { ...entry, line: nodePath.node.loc!.start.line, guards };
      siteStart.set(item as ApiCallSite, nodePath.node.start!);
      if (kind !== 'settingReads') siteFile.set(item as ApiCallSite, file);
      (facts[kind] as Site[]).push(item);
      if (owner && inherits) {
        if (!localFnRefs.has(owner.name)) localFnRefs.set(owner.name, { fnPath: owner.fnPath, items: [] });
        localFnRefs.get(owner.name)!.items.push({ kind, site: item });
      }
      return item;
    }

    const staticImports = new Set<string>();
    function addImport(spec: string, dynamic = false) {
      const resolved = imports.resolve(file, spec);
      if (resolved) facts.imports.push(resolved);
      if (resolved && dynamic) importedLater.set(file, new Set([...(importedLater.get(file) ?? []), resolved]));
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
        const recordCall = (fn: string | undefined) => record('apiCalls', { fn, options: bodyOptions(p) }, p, hookEnabled(p, fn).map((v) => sliceText(src, v.node)));
        if (callee.type === 'Identifier' && apiNamed.has(callee.name)) {
          recordCall(apiNamed.get(callee.name)!);
        } else if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && apiNamespaces.has(callee.object.name)) {
          recordCall((callee.property as Identifier).name);
        } else {
          const fn = calledFunction(p.get('callee'));
          if (fn) recordCall(fn);
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
          for (const r of listedRoutes(p, (at) => (programFile.get(at.scope.getProgramParent().block) === file ? guardsOf(at, src, note) : []))) {
            if (r.setting) noteSettings(relFile, r.setting.guard, r.setting.settings);
            constantAt.set(p.node, [...(constantAt.get(p.node) ?? []), record('routeRefs', { route: r.route }, p, r.guards, !r.ownerCalls) as RouteRef]);
          }
          return;
        }
        const result = !settingsRoots.has(chain[0]) && chain.length >= 2 && settingsResult(rootIdentifier(p));
        if (settingsRoots.has(chain[0]) && chain.length >= 3) {
          record('settingReads', { key: chain.slice(1).join('.') }, p);
        } else if (result) {
          record('settingReads', { key: [result[1], ...chain.slice(1)].join('.') }, p);
        } else if (chain[0] === routeRoot && chain.length === routeRest.length + 2 && routeRest.every((k: string, i: number) => chain[i + 1] === k)) {
          recordRouteConstant(chain[chain.length - 1], p, p);
        } else if (chain.at(-1) === 'replace' && routeChainOf(chain.slice(0, -2)) && fillsPathVariable(p)) {
          const call = p.parentPath! as NodePath;
          const up = call.parentPath!;
          if ((up.isMemberExpression() || up.isOptionalMemberExpression()) && up.node.object === call.node) return;
          recordRouteConstant(chain.at(-2)!, call, p);
        }
      },
    });

    // at 은 라우트 상수가 주소로 놓인 식이고, 뒤에 이어 붙인 것은 꼬리로 읽는다.
    function recordRouteConstant(route: string, at: NodePath, site: NodePath) {
      const { tail, whole } = routeTail(at);
      if (comparedOnly(whole)) return;
      const list = whole.listKey === 'elements' && whole.parentPath!.isArrayExpression() ? listComparedOnly(whole.parentPath!) : null;
      if (list && list.exported === null) return;
      const member = whole.parentPath!;
      const table = whole.key === 'key' && (member.isObjectProperty() || member.isObjectMethod()) && member.node.computed ? lookupTable(member.parentPath!) : null;
      if (table && table.exported === null) return;
      const ref = record('routeRefs', { route, tail }, site) as RouteRef;
      if (table?.exported) exportedKeys.set(ref, { file, name: table.exported });
      if (list?.exported) comparedLists.set(ref, { file, name: list.exported, comparedHere: list.comparedHere });
      constantAt.set(whole.node, [ref]);
    }

    const routeRefAt = facts.routeRefs.map((r) => siteStart.get(r)!);
    const holdsRouteRef = (p: NodePath) => routeRefAt.some((start) => start >= p.node.start! && start < p.node.end!);
    const addressRefs = (addresses: NodePath[]) => addresses.flatMap((at) => {
      const parts = madeFrom(at);
      const reassignable = parts.findIndex((p) => p.isIdentifier() && p.scope.getBinding(p.node.name)?.kind !== 'const');
      return (reassignable < 0 ? parts : parts.slice(0, reassignable)).flatMap((p) => constantAt.get(p.node) ?? []);
    });
    const recordLinks = (addresses: NodePath[], read = linkAddresses) => {
      for (const ref of addressRefs(addresses)) linkAddressRefs.add(ref);
      const recorded: RouterLink[] = [];
      for (const at of addresses) {
        if (madeFrom(at).some(holdsRouteRef)) continue;
        for (const address of read(at)) recorded.push(record('routerLinks', address, at) as RouterLink);
      }
      return recorded;
    };
    const recordElementLinks = (p: NodePath<JSXElement>) => {
      const component = linkComponentOf(p);
      const target = (p.get('openingElement.attributes') as NodePath<any>[]).find((a) => a.isJSXAttribute() && a.node.name.name === 'target');
      const value = target?.get('value') as NodePath<any> | undefined;
      const newTab = Boolean(value?.node) && evaluate(value!.isJSXExpressionContainer() ? value!.get('expression') : value!) === '_blank';
      recordLinks(screenLinks.element(p, inRouteFile), component && 'listed' in component ? outsideAddresses(newTab) : linkAddresses);
    };
    const recordListedCall = (p: NodePath<CallExpression>) => {
      const listed = listedCall(p);
      if (listed) recordLinks(valuesAt(p, listed.address!).flatMap((v) => addresses(v)), listedAddresses);
      return Boolean(listed);
    };
    const recordHelperLinks = (p: NodePath<CallExpression>) => {
      if (screenLinks.moveOf(p) || (p.get('arguments') as NodePath[]).some((a) => madeFrom(a).some(holdsRouteRef))) return;
      const read = linkReading.helperBranches(p);
      const sites = (read ? addressesOf(read, () => UNKNOWN) : []).map((address) => record('routerLinks', address, p) as RouterLink);
      if (read && 'tooMany' in read) manyLinkBranches.push({ file: relFile, line: p.node.loc!.start.line, sites });
    };
    const recordUseLinks = (p: NodePath<JSXElement>) => {
      const written = (p.get('openingElement.attributes') as NodePath<any>[]).map((a) => (a.isJSXSpreadAttribute() ? a.get('argument') : a.get('value')) as NodePath<any>);
      if (written.some((v) => v.node && madeFrom(v.isJSXExpressionContainer() ? v.get('expression') : v).some(holdsRouteRef))) return;
      const read = linkReading.useBranches(p);
      const sites = (read ? addressesOf(read, () => UNKNOWN) : []).map((address) => record('routerLinks', address, p) as RouterLink);
      if (read && 'tooMany' in read) manyLinkBranches.push({ file: relFile, line: p.node.loc!.start.line, sites });
    };
    const inRouteFile = routeFileSet.has(file);
    const menusHere = menuTables.get(file) ?? [];
    const menuTablesOf = (p: NodePath<JSXElement>) => {
      const fields = itemFieldsRead(p);
      return menusHere.filter((t) => {
        if (!tableRoutes.has(t)) throw new Error(`${t}: ${relFile} was read before the route file of its table`);
        return fields.includes(tableRoutes.get(t)!.field);
      });
    };
    const readers = (holder: NodePath, loop: Node, table: string) => {
      const found: NodePath[] = [];
      holder.traverse({ JSXElement(q) { if (q.findParent(loopCallback)?.node === loop && menuTablesOf(q).includes(table)) found.push(q); } });
      return found;
    };
    const outerLoopReads = (loop: NodePath, table: string) => {
      for (let outer = loop.parentPath?.findParent(loopCallback); outer; outer = outer.parentPath?.findParent(loopCallback)) if (readers(outer, outer.node, table).length) return true;
      return false;
    };
    const inAttributeFunction = (q: NodePath, loop: NodePath) => q.findParent((a) => a === loop || (a.isFunction() && Boolean(a.parentPath?.isJSXExpressionContainer() && a.parentPath.parentPath?.isJSXAttribute()))) !== loop;
    // 같은 반복 함수 안에서 항목의 field 를 읽는 요소가 겹쳐 있으면 가장 안쪽 요소가 메뉴 요소다. 바깥 반복의 항목도 그 field 를 읽으면 안쪽 반복의 요소는 메뉴 요소가 아니다.
    const recordMenuElement = (p: NodePath<JSXElement>) => {
      const tables = menusHere.length ? menuTablesOf(p) : [];
      if (!tables.length) return false;
      const loop = p.findParent(loopCallback)!;
      const own = tables.filter((t) => {
        const all = readers(loop, loop.node, t);
        const outside = all.filter((q) => !inAttributeFunction(q, loop));
        const counted = outside.length ? outside : all;
        return counted.some((q) => q.node === p.node) && !counted.some((q) => q.node !== p.node && q.isDescendant(p)) && !outerLoopReads(loop, t);
      });
      for (const table of own) record('routerLinks', { to: UNKNOWN, menu: table }, p);
      return own.length > 0;
    };
    traverse(ast, {
      JSXElement(p) {
        if (recordMenuElement(p)) return;
        recordElementLinks(p);
        recordUseLinks(p);
      },
      CallExpression(p) {
        const move = screenLinks.moveOf(p);
        const moved = recordLinks(screenLinks.call(p));
        if (move) for (const site of [...moved, ...addressRefs(addresses(move.address))]) movedTo.add(site);
        if (!recordListedCall(p)) recordHelperLinks(p);
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
        let requestOuter: string[] | undefined;
        for (const { kind, site } of target.items) {
          const guards = kind === 'apiCalls' ? (requestOuter ??= guardsOf(p, src, note, queryEnabled)) : outer;
          site.inheritedGuards ??= [];
          site.inheritedGuards.push({ via: p.node.name, line: p.node.loc!.start.line, guards });
        }
      },
    });

    if (screenInputs) {
      const byStart = screenInputs.callInputs(file);
      for (const site of facts.apiCalls) if (siteStart.has(site)) site.inputs = byStart.get(siteStart.get(site)!);
    }
    facts.imports = [...new Set(facts.imports)];
    facts.dynamicOnly = new Set(facts.imports.filter((f) => !staticImports.has(f)));
    factCache.set(file, facts);
    return facts;
  }

  // 다른 화면의 컴포넌트 파일을 동적 import 로만 참조하면 미리 불러 두는 것이라 따라가지 않는다.
  function closureOf(entryFile: string, isOtherScreen: (f: string) => boolean, cut?: Set<string>) {
    const seen = new Set<string>();
    const stack = [entryFile];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f) || apiModuleFiles.has(f) || calledFiles.has(f) || constantFiles.has(f) || (f !== entryFile && tableFiles.has(f)) || cut?.has(f)) continue;
      if (!/\.(jsx?|tsx?)$/.test(f)) continue;
      seen.add(f);
      const { imports, dynamicOnly } = fileFacts(f);
      for (const dep of imports) if (!(dynamicOnly!.has(dep) && isOtherScreen(dep))) stack.push(dep);
    }
    return [...seen];
  }

  // ---------- 라우트 파일: 화면 목록과 화면에 걸린 조건 ----------

  const {
    redirects, unreadRoutePaths, unreadRoutes, framesPickingByAddress,
    readWhole, unreadPiece, readRoutePath, stopOf, extractScreens, testSide, screensTakingAddressesUnder, pathsIn, itemComponents, itemFieldsRead, resolveTag, fillOuterAddresses, routeTree,
  } = clientRouteReader({
    config, resolve: imports.resolve, closureOf, screenFiles: () => screenFiles,
    components, apiModuleFiles, constantModuleFiles, settingsRoots, routeTables, tableRoutes, routeFileSet, programFile, parse, declaredValue, namespaceMember, textOf, evaluate, lossless,
    attributeValue, literalAt, fileOf, keysInOrder, propertiesOf, propertyValue, keyedValue, declaredFunction, functionAt, namespaceFunction, declaredClass, loopCallback, tagOf, unwrapCalls, rel,
    tableLiteral, guardNote,
    passThrough, oneAddress,
  });

  // ---------- 화면마다 모으기 ----------

  const apiFunctions: Record<string, any> = {};
  const moduleExports = new Map<string, { file: string; exportName: string }[]>();
  const apiExports: Record<string, string[]> = {};
  for (const f of apiModuleFiles) {
    const fns = extractApiModule(f);
    Object.assign(apiFunctions, fns);
    apiExports[path.relative(config.srcRoot, f)] = Object.keys(fns);
    for (const name of Object.keys(fns)) moduleExports.set(name, [{ file: f, exportName: name }]);
  }
  for (const { file, exportName, found } of await apiModuleInputs(config, imports.resolve, apiExports)) {
    if (apiFunctions[exportName]?.file === file) apiFunctions[exportName] = { ...apiFunctions[exportName], ...found };
  }
  if (calledFiles.size) called = await recordApiCalls(config, imports.resolve, new Set(Object.keys(apiFunctions)));
  Object.assign(apiFunctions, called?.functions);

  const routeValues = lookupConstant(constants, routeChain) ?? {};

  if (!config.routeFiles.length) throw new Error(`the config has no routesFile, which takes ${ROUTES_FILE}`);
  const drawn = (config.routeFiles as string[]).map((f) => ({ file: path.join(config.srcRoot, f), ...extractScreens(f) }));
  const extracted = drawn.flatMap((d) => d.screens);
  const emptyRouteFiles = (config.routeFiles as string[]).filter((_, i) => !drawn[i].hasRoutes);
  const screenFiles = new Set(extracted.map((s) => s.componentFile).filter(Boolean));
  // beside: 이 화면에게는 다른 화면의 것인 파일들. 탭 화면에게는 다른 탭들의 컴포넌트가 그렇다.
  function sourcedOf({ wrapperFiles, frameFiles, outerFill, ...s }: RouteScreen, beside: Set<string> = new Set()) {
    const entryFiles = [s.componentFile, ...wrapperFiles].filter(Boolean) as string[];
    const isOtherScreen = (f: string) => (screenFiles.has(f) || beside.has(f)) && !entryFiles.includes(f);
    const cut = new Set([...beside].filter((f) => !entryFiles.includes(f)));
    return { s, outerFill, frameFiles, entryFiles, isOtherScreen, cut, files: [...new Set(entryFiles.flatMap((f) => closureOf(f, isOtherScreen, cut)))], drawnUnder: [] as { file: string; unders: Required<InheritedGuard>[] }[], drawnFiles: new Map<string, Required<InheritedGuard>[]>() };
  }
  const sourced = extracted.map((s) => sourcedOf(s));
  type Sourced = ReturnType<typeof sourcedOf>;

  type TabRead = { items: NodePath[]; stoppedAt: NodePath | null };
  const stopTab = (at: NodePath): TabRead => ({ items: [], stoppedAt: at });

  function mergeTabs(reads: TabRead[]): TabRead {
    const items: NodePath[] = [];
    const seen = new Set<Node>();
    for (const read of reads) for (const item of read.items) if (!seen.has(item.node)) { seen.add(item.node); items.push(item); }
    return { items, stoppedAt: reads.find((r) => r.stoppedAt)?.stoppedAt ?? null };
  }

  function tabItemsIn(list: NodePath<ArrayExpression>, binding: Binding | null | undefined, seen: Set<Node>): TabRead {
    const reads: TabRead[] = [];
    for (const element of list.get('elements') as NodePath<any>[]) {
      if (!element.node) continue;
      reads.push(element.isSpreadElement() ? tabItems(element.get('argument') as NodePath, seen) : { items: [element], stoppedAt: null });
    }
    // 목록을 채우는 push 는 어느 갈래에 있든 받는다. 갈래를 가르는 조건은 읽지 않는다.
    for (const ref of binding?.referencePaths ?? []) {
      const member = ref.parentPath;
      const call = member?.parentPath;
      if (!member?.isMemberExpression() || member.node.object !== ref.node || member.node.computed || (member.node.property as Identifier).name !== 'push') continue;
      if (!call?.isCallExpression() || call.node.callee !== member.node) continue;
      for (const arg of call.get('arguments') as NodePath<any>[]) reads.push(arg.isSpreadElement() ? tabItems(arg.get('argument') as NodePath, seen) : tabItems(arg, seen));
    }
    return mergeTabs(reads);
  }

  function tabItems(expr: NodePath<any>, seen: Set<Node>): TabRead {
    if (!expr.node || seen.has(expr.node)) return { items: [], stoppedAt: null };
    seen.add(expr.node);
    if (expr.isObjectExpression()) return { items: [expr], stoppedAt: null };
    if (expr.isArrayExpression()) return tabItemsIn(expr, null, seen);
    if (expr.isFunction()) return mergeTabs(returnedValues(expr).map((value) => tabItems(value, seen)));
    if (expr.isCallExpression() || expr.isOptionalCallExpression()) {
      const callee = expr.get('callee') as NodePath<any>;
      // useMemo(() => getRoutes(…)) 는 첫 인자인 함수를 부른다.
      const fn = callee.isIdentifier() && callee.node.name === 'useMemo' ? unwrapCalls(expr) : callee;
      return fn?.node ? tabItems(fn, seen) : stopTab(expr);
    }
    if (!expr.isIdentifier()) return stopTab(expr);
    const declared = tabValue(expr);
    if (!declared?.node) return stopTab(expr);
    // 목록을 채우는 push 는 그 목록을 선언한 파일에서 찾는다.
    const name = expr.scope.getBinding(expr.node.name)?.kind === 'module' ? importedName(expr.scope.getBinding(expr.node.name)!)?.name ?? expr.node.name : expr.node.name;
    return declared.isArrayExpression() ? tabItemsIn(declared, declared.scope.getBinding(name), seen) : tabItems(declared, seen);
  }

  // 이름이 가리키는 값. 다른 파일에서 import 한 이름이면 그 파일의 선언까지 따라간다.
  function tabValue(expr: NodePath<Identifier>): NodePath<any> | null {
    const binding = expr.scope.getBinding(expr.node.name);
    if (!binding) return null;
    if (binding.path.isVariableDeclarator()) return (binding.path.get('init') as NodePath<any> | undefined)?.node ? (binding.path.get('init') as NodePath<any>) : null;
    if (binding.path.isFunctionDeclaration()) return binding.path;
    if (binding.kind === 'module') return declaredFunction(expr.scope, expr.node.name) ?? declaredValue(expr.scope, expr.node.name);
    return declaredValue(expr.scope, expr.node.name);
  }

  // 이름 지은 컴포넌트를 items prop 과 함께 그리는 요소들. 그것을 그리는 화면이 탭 화면들의 부모다.
  type TabDrawing = { x: Sourced; file: string; element: NodePath<JSXElement>; value: NodePath | null; tag: string; guards: string[] };

  function tabDrawings(entry: RouteTab & { file: string }): TabDrawing[] {
    // 한 파일은 한 번만 읽고, 그 파일을 소스로 갖는 화면마다 찾은 요소를 붙인다.
    const inFile = new Map<string, Omit<TabDrawing, 'x'>[]>();
    function foundIn(file: string) {
      const known = inFile.get(file);
      if (known) return known;
      const { src, ast } = parse(file);
      const note = guardNote(path.relative(config.srcRoot, file), src);
      const found: Omit<TabDrawing, 'x'>[] = [];
      traverse(ast, {
        JSXElement(p) {
          const attr = p.get('openingElement.attributes').find((a) => a.isJSXAttribute() && (a.node as JSXAttribute).name?.name === entry.items);
          if (!attr) return;
          const tag = tagOf(p.node.openingElement.name);
          if (!tag || resolveTag(p.scope, tag, file) !== entry.file) return;
          const written = attr.get('value') as NodePath<any>;
          found.push({ file, element: p, value: written.isJSXExpressionContainer() ? (written.get('expression') as NodePath) : written.node ? written as NodePath : null, tag, guards: guardsOf(p, src, note) });
        },
      });
      inFile.set(file, found);
      return found;
    }
    const drawings: TabDrawing[] = [];
    for (const x of sourced) {
      for (const file of x.files) {
        if (file === entry.file || !/\.(jsx?|tsx?)$/.test(file)) continue;
        for (const found of foundIn(file)) drawings.push({ x, ...found });
      }
    }
    return drawings;
  }

  function addTabScreens() {
    // 라우트가 이미 주는 주소는 그 라우트의 화면이 있다. 탭 화면을 만들지 않고 알리지도 않는다.
    const routePaths = new Set(extracted.map((s) => s.path));
    const madeScreen = new Set<string>();
    const tabs: RouteScreen[] = [];
    for (const entry of routeTabEntries) {
      const drawings = tabDrawings(entry);
      if (!drawings.length) {
        routeTabNotices.push({ file: null, line: null, reason: `${entry.import} ${entry.name} is drawn by no screen` });
        continue;
      }
      // 한 파일을 여러 화면이 그려도 그 목록은 한 번만 읽고, 멈춘 곳도 한 번만 알린다.
      const reads = new Map<Node, TabRead>();
      const told = new Set<Node>();
      for (const { x, file: drawingFile, element, value, tag, guards } of drawings) {
        const line = element.node.loc!.start.line;
        let read = reads.get(element.node);
        if (!read) {
          read = value?.node ? tabItems(value, new Set()) : stopTab(element);
          reads.set(element.node, read);
        }
        const stoppedAt = read.stoppedAt && stopOf(read.stoppedAt);
        if (stoppedAt && !told.has(element.node)) {
          told.add(element.node);
          routeTabNotices.push({ file: stoppedAt.file, line: stoppedAt.line, reason: `its ${entry.items} stopped at ${stoppedAt.text}` });
        }
        // 탭 화면이 받는 틀은 그 탭 컴포넌트를 그리는 화면이 받는 틀과 같다. 그 화면을 감싸는 파일들, 그 화면의 틀들,
        // 그 화면이 자기 라우트 파일에서 물려받는 틀들, 그리고 탭 컴포넌트를 그리는 파일 자체와 그 요소에 걸린 조건.
        const wrappers = x.entryFiles.filter((file) => file !== x.s.componentFile);
        const frameFiles: FrameFile[] = [...x.frameFiles, ...wrappers.map((file) => ({ file, under: null })), ...framesOf(path.join(config.srcRoot, x.s.routeFile)), ...(x.s.componentFile
          ? [{ file: x.s.componentFile, under: guards.length ? { via: tag, line, file: rel(drawingFile)!, guards } : null }] : [])];
        const made: RouteScreen[] = [];
        for (const item of read.items) {
          const itemLine = item.node.loc!.start.line;
          const place = `${fileOf(item)}:${itemLine}`;
          const object = objectAt(item);
          if (!object) {
            routeTabNotices.push({ file: fileOf(item), line: itemLine, reason: `the item at ${place} is not an object written in the source` });
            continue;
          }
          const pathValue = keyedValue(object, entry.path.split('.'));
          const componentValue = keyedValue(object, entry.component.split('.'));
          const values = pathValue ? [...new Set(pathsIn(pathValue).flatMap((onePath) => {
            const written = evaluate(onePath);
            if (readWhole(written)) return [String(written)];
            const called = readRoutePath(onePath).path;
            if (!called.includes(UNKNOWN)) return [called];
            const at = stopOf(unreadPiece(onePath) ?? onePath);
            routeTabNotices.push({ file: at.file, line: at.line, reason: `the item at ${place}: its ${entry.path} stopped at ${at.text}${at.file === fileOf(item) ? '' : ` in ${at.file}:${at.line}`}` });
            return [];
          }))] : [];
          if (!pathValue) routeTabNotices.push({ file: fileOf(item), line: itemLine, reason: `the item at ${place} has no ${entry.path}` });
          // '/' 로 시작하지 않는 주소는 그리는 화면의 경로를 앞에 붙이고, ? 와 # 뒤는 화면을 가르지 않으므로 뗀다.
          const addressOf = (written: string) => {
            const path = written.replace(/[?#].*$/, '');
            return path.startsWith('/') ? path : `${x.s.path.replace(/\/$/, '')}/${path}`;
          };
          const pending = [...new Set(values.map(addressOf))].filter((address) => !routePaths.has(address));
          // 주소가 모두 라우트의 것이면 그 라우트가 이미 준다.
          if (values.length && !pending.length) continue;
          const components = componentValue ? itemComponents([componentValue]) : [];
          if (!componentValue) routeTabNotices.push({ file: fileOf(item), line: itemLine, reason: `the item at ${place} has no ${entry.component}` });
          else if (!components.length) {
            const at = stopOf(componentValue);
            routeTabNotices.push({ file: at.file, line: at.line, reason: `the item at ${place}: its ${entry.component} stopped at ${at.text}${at.file === fileOf(item) ? '' : ` in ${at.file}:${at.line}`}` });
          }
          if (!pending.length || !components.length || components.every((c) => c.redirects)) continue;
          const shown = components[0];
          for (const path of pending) {
            // 같은 탭 화면은 한 번만 만든다. 먼저 그린 화면이 이긴다.
            const key = `${path}\n${shown.component}`;
            if (madeScreen.has(key)) continue;
            madeScreen.add(key);
            made.push({
              path,
              component: shown.component,
              componentFile: shown.componentFile,
              wrapperFiles: [],
              frameFiles,
              routeFile: fileOf(item),
              routeGuards: [],
              line: itemLine,
              outerFill: { startsWithOuterAddress: false, atTopOfRoutes: false, unreadPath: null },
            });
          }
        }
        for (const screen of made) tabs.push(screen);
      }
    }
    // 다른 탭의 컴포넌트 파일은 이 탭의 소스가 아니다. routeTabs 의 모든 탭이 서로의 컴포넌트를 담지 않는다.
    const tabComponents = new Set(tabs.map((s) => s.componentFile).filter(Boolean) as string[]);
    for (const screen of tabs) sourced.push(sourcedOf(screen, tabComponents));
  }
  fillOuterAddresses(sourced);
  const { roots: routeRoots, framesOf } = routeTree(drawn, extracted, sourced);
  // framesOf 를 쓰므로 routeTree 뒤에, 틀을 붙이는 아래 반복보다 앞에 탭 화면을 만든다.
  addTabScreens();
  // 레이아웃 컴포넌트는 경로를 채우고 라우트 트리를 만든 뒤에 붙인다.
  const inheritedFrames = new Map<string, FrameFile[]>();
  for (const x of sourced) {
    const routeFile = path.join(config.srcRoot, x.s.routeFile);
    if (!inheritedFrames.has(routeFile)) inheritedFrames.set(routeFile, framesOf(routeFile));
    const frame = [...x.frameFiles, ...inheritedFrames.get(routeFile)!].filter((e) => !x.entryFiles.includes(e.file));
    if (!frame.length) continue;
    const open = [...new Set(frame.filter((e) => !e.under).map((e) => e.file))];
    const guarded = new Map<string, Required<InheritedGuard>[]>();
    for (const { file, under } of frame) {
      if (!under || open.includes(file)) continue;
      const known = guarded.get(file) ?? [];
      if (!known.some((g) => g.file === under.file && g.line === under.line)) guarded.set(file, [...known, under]);
    }
    x.entryFiles.push(...open);
    const cut = x.cut.size ? new Set([...routeFileSet, ...[...x.cut].filter((f) => !x.entryFiles.includes(f))]) : routeFileSet;
    const frameClosure = (f: string) => closureOf(f, x.isOtherScreen, cut);
    const openFiles = new Set([...x.files, ...open.flatMap(frameClosure)]);
    x.files = [...openFiles];
    for (const [file, unders] of guarded) {
      x.drawnUnder.push({ file, unders });
      for (const f of frameClosure(file)) {
        if (openFiles.has(f)) continue;
        if (!x.drawnFiles.has(f)) x.files.push(f);
        x.drawnFiles.set(f, [...(x.drawnFiles.get(f) ?? []), ...unders]);
      }
    }
  }
  const appWideEntries = ((config.appWideComponents ?? []) as { import: string; name: string }[]).map((c, i) => ({ ...c, file: exportingFile(`appWideComponents[${i}]`, c) }));
  const besideApp = new Set([...routeFileSet, ...screenFiles, ...sourced.flatMap((x) => [...x.entryFiles, ...x.drawnUnder.map((d) => d.file)])] as string[]);
  const appWideClosure = (f: string) => closureOf(f, (g) => screenFiles.has(g), besideApp);
  const appWideFiles = [...new Set(appWideEntries.flatMap(({ file }) => closureOf(file, (g) => screenFiles.has(g), new Set([...besideApp].filter((g) => g !== file)))))];
  const routedScreens = routerTargets(routeRoots);
  const itemLinks = menuLinks();

  function menuLinks() {
    const byTable = new Map<string, { to: string; tableItem: TableItem; screen: number }[]>();
    const active = new Set<MenuElement>();
    for (const table of routeTables.values()) {
      const route = tableRoutes.get(table.at);
      if (!route || !table.menus?.length) continue;
      byTable.set(table.at, sourced.flatMap((x, i) => (x.s.tableItem && x.s.routeFile === table.route && !x.s.path.includes(UNKNOWN) && pathParts(x.s.path).every((part) => typeof part === 'string')
        ? [{ to: x.s.path, tableItem: x.s.tableItem, screen: i }] : [])));
      table.menus.forEach((menu, j) => {
        const at = `${table.at}.menus[${j}]`;
        const file = path.join(config.srcRoot, menu);
        if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`${at}: ${menu} is not a file`);
        const found = fileFacts(file).routerLinks.filter((l): l is MenuElement => (l as MenuElement).menu === table.at);
        const reads = `made for each item of a list that read${found.length > 1 ? '' : 's'} the item's ${route.field}`;
        if (!found.length) throw new Error(`${at}: ${menu} has no element ${reads}, the field the route at ${route.routeFile}:${route.line} reads`);
        if (found.length > 1) throw new Error(`${at}: ${menu} has ${found.length} elements ${reads}, at ${found.map((l) => `${menu}:${l.line}`).join(' and ')}`);
        active.add(found[0]);
      });
    }
    return (element: MenuElement) => {
      if (!active.has(element)) return [];
      const { menu, sides, to, ...site } = element;
      return byTable.get(menu)!.map(({ to: itemTo, tableItem, screen }) => ({ ...site, to: itemTo, tableItem, reaches: [screen] }));
    };
  }
  // 링크 주소 전체로 쓴 라우트 상수는 Routes 에서 그 주소에 맞는 화면이 나오면 문자열 주소처럼 잇되 다른 Routes 의 catch-all 은 빼고, 그 밖에는 라우트 경로에 맞춰 본다.
  const constantLink = (site: RouteRef, from: number) => {
    const { tail, ...ref } = site;
    const value = routeValues[ref.route];
    if (typeof value !== 'string') return { ...ref, to: value ?? UNKNOWN };
    const to = tail ? value + tail : value;
    const routed = tail !== null && linkAddressRefs.has(site) && routedScreens.decidedByRoutes(to);
    return { ...ref, to, ...(tail && { tail }), ...(routed && { reaches: routedScreens.fittingScreens(to, from) }) };
  };
  // 주소의 갈래가 from 이 그려지는 쪽에서 생기지 않으면 null 이다.
  const screenLink = (site: RouteRef | RouterLink, from: number) => {
    if ('route' in site) return constantLink(site, from);
    const { sides, ...link } = site;
    return routedScreens.drawnWith(from, sides) ? { ...link, reaches: routedScreens.screens(link.to, from) } : null;
  };
  // POST 가 아닌 페이지 이동의 주소가 앱의 라우트와 맞으면 서버가 아니라 앱의 다른 화면이 열린다. 고정 문자열 부분이 없는 라우트는 어떤 주소에나 맞으므로 견주지 않는다.
  const screenRoutes = sourced.map((x) => x.s).filter((s) => !s.path.includes(UNKNOWN) && pathParts(s.path).some((part) => typeof part === 'string' && /[^/]/.test(part))).map((s) => routePattern(s.path));
  const opensScreen = (url: string) => screenRoutes.some((route) => route.test(url.replaceAll(UNKNOWN, '\0').split(/[?#]/)[0]));
  const isApiCall = (site: FollowedSite): site is ApiCallSite => 'fn' in site;
  const sends = (c: ApiCallSite, outsideRequestFunction: { has: (site: FollowedSite) => boolean }) => !c.request || (outsideRequestFunction.has(c) && !(c.navigation && c.request.method !== 'POST' && opensScreen(c.request.url!)));

  // saga 는 화면이 import 하지 않는 파일에 있어도 돈다. API · 상수 파일은 화면에서와 같이 그 안으로 들어가지 않는다.
  const sagaScope = (f: string | null) => !apiModuleFiles.has(f!) && !calledFiles.has(f!) && !constantFiles.has(f!);
  const sources = sourceFiles(config.srcRoot);
  const sagaSources = sagaFiles(sources);
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
      listReaderFiles.add(siteFile.get(site)!);
      if (!('watches' in site)) continue;
      for (const w of site.watches) watchesOf.set(w.type.key, [...(watchesOf.get(w.type.key) ?? []), w]);
    }
  }
  // 목록을 읽는 곳을 판단할 때 보는 파일: 링크가 될 수 있는 사실을 가진 파일들이다.
  for (const { files } of sourced) for (const f of files) listReaderFiles.add(f);
  for (const f of [...routeFileSet, ...appWideFiles]) listReaderFiles.add(f);
  // 핸들러가 도달한 파일의 top-level 코드가 saga 를 실행해도, 그 run 에 넘긴 saga 는 탐색하지 않는다.
  const inRun = (file: string, pos: number) => runs.some((r) => r.file === file && pos >= r.span[0] && pos < r.span[1]);
  const comparedAway = (ref: RouteRef) => comparedLists.has(ref) && listReadersCompare(comparedLists.get(ref)!);
  // saga 안에서 이동하는 주소를 읽지 못하면 화면 코드와 달리 {?} 로도 남기지 않는다.
  const readAddress = (l: RouteRef | RouterLink) => ('route' in l ? typeof routeValues[l.route] === 'string' && !comparedAway(l) : l.to !== UNKNOWN);
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

  const members = typedMembers(config.tsconfig, [...new Set([...sourced.flatMap((x) => x.files), ...appWideFiles])], imports.resolve);
  const heldRouteFiles = new Set(sourced.flatMap((x) => x.files).filter((f) => routeFileSet.has(f)));
  const screenFollower = members ? nameFollower<FollowedSite>({ parse, resolve: imports.resolve, sitesOf, members }) : follower;
  const linkSitesOfScreen: Set<FollowedSite>[] = [];
  const screens = sourced.map(({ s, entryFiles, isOtherScreen, files, drawnUnder, drawnFiles }, index) => {
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
    const onlyDrawn = new Map<FollowedSite, Required<InheritedGuard>[]>();
    const outsideDrawn = new Set<FollowedSite>();
    for (const { file, unders } of drawnUnder) {
      const from = [{ file, name: null }];
      for (const site of screenFollower.reach(from, canEnter, { loaded })) if (!reached.has(site)) onlyDrawn.set(site, [...(onlyDrawn.get(site) ?? []), ...unders]);
      if (canEnter(requestFile)) for (const site of screenFollower.reach(from, (f) => canEnter(f) && f !== requestFile, { loaded })) outsideDrawn.add(site);
    }
    const seen = (site: FollowedSite) => reached.has(site) || onlyDrawn.has(site);
    const byComponent = s.componentFile && (entryFiles.length > 1 || drawnUnder.length) ? screenFollower.reach([{ file: s.componentFile, name: null }], canEnter, { loaded }) : null;
    const layout = (site: FollowedSite) => (byComponent && !byComponent.has(site) ? { layout: true as const } : null);
    const outside = canEnter(requestFile) ? { has: (site: FollowedSite) => outsideRequestFunction.has(site) || outsideDrawn.has(site) } : { has: seen };
    const drawnWith = <T extends { inheritedGuards?: InheritedGuard[] }>(item: T, unders: Required<InheritedGuard>[] | undefined): T => (unders ? { ...item, inheritedGuards: [...(item.inheritedGuards ?? []), ...unders] } : item);
    const apiCalls: (ApiCallSite & { file: string | null; layout?: true; actions?: DispatchedActions })[] = [];
    const own = new Set<ApiCallSite>();
    const dispatched = new Map<string, { type: ActionType; at: Set<string> }>();
    const settingReads: (SettingRead & { file: string | null })[] = [];
    const links: (Site & { route?: string; to: unknown; tail?: string; reaches?: number[]; tableItem?: TableItem; file: string | null; layout?: true; actions?: DispatchedActions })[] = [];
    const ownLinks = new Set<FollowedSite>();
    const takeCalls = (f: string, facts: Facts) => {
      for (const c of facts.apiCalls) {
        if (!seen(c) || !sends(c, outside)) continue;
        own.add(c);
        apiCalls.push(drawnWith({ ...c, file: rel(f), ...layout(c) }, onlyDrawn.get(c)));
      }
    };
    for (const f of files) {
      const facts = fileFacts(f);
      takeCalls(f, facts);
      for (const d of watchesOf.size ? facts.dispatches : []) {
        if (!seen(d)) continue;
        for (const type of d.types()) {
          if (!dispatched.has(type.key)) dispatched.set(type.key, { type, at: new Set() });
          dispatched.get(type.key)!.at.add(`${rel(f)}:${d.line}`);
        }
      }
      for (const r of facts.settingReads) settingReads.push(drawnWith({ ...r, file: rel(f) }, drawnFiles.get(f)));
      for (const ref of linkSites(facts)) {
        if (!seen(ref) || ('route' in ref && comparedAway(ref)) || (exportedKeys.has(ref as RouteRef) && lookedUpElsewhere(exportedKeys.get(ref as RouteRef)!))) continue;
        if ('menu' in ref) {
          for (const link of itemLinks(ref as MenuElement)) links.push(drawnWith({ ...link, file: rel(f), ...layout(ref) }, onlyDrawn.get(ref)));
          continue;
        }
        ownLinks.add(ref);
        const link = screenLink(ref, index);
        if (link) links.push(drawnWith({ ...link, file: rel(f), ...layout(ref) }, onlyDrawn.get(ref)));
      }
    }
    // 라우트 파일 본문에서 옮기는 것은 그 파일이 그리는 화면 어디서나 일어난다.
    const drawnBy = path.join(config.srcRoot, s.routeFile);
    for (const site of heldRouteFiles.has(drawnBy) ? [] : linkSites(fileFacts(drawnBy))) {
      if (!movedTo.has(site) || ownLinks.has(site) || ('route' in site && comparedAway(site))) continue;
      ownLinks.add(site);
      const link = screenLink(site, index);
      if (link) links.push({ ...link, file: rel(drawnBy) });
    }
    linkSitesOfScreen[index] = ownLinks;
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
    const sagaLinks = [...movedBySaga].flatMap(([ref, actions]) => {
      const link = screenLink(ref, index);
      return link ? [{ ...link, file: rel(siteFile.get(ref)), actions: byType(actions) }] : [];
    });
    sagaLinks.sort((a, b) => compare(a.file, b.file) || a.line - b.line);
    links.push(...sagaLinks);
    const sent: typeof apiCalls = [...apiCalls, ...sagaCalls];
    return { ...s, componentFile: rel(s.componentFile), closureSize: files.length, sourceFiles: files.map(rel).sort(), apiCalls: sent, settingReads, links };
  });

  const linkNotices = manyLinkBranches
    .map(({ file, line, sites }) => ({ file, line, screens: linkSitesOfScreen.flatMap((own, i) => (sites.some((site) => own.has(site)) ? [i] : [])) }))
    .sort((a, b) => compare(a.file, b.file) || a.line - b.line);

  const appWide = appWideEntries.length ? appWideRequests() : null;
  function appWideRequests() {
    const inFiles = new Set<string | null>(appWideFiles);
    const received = new Set<string>();
    const canEnter = (f: string | null) => inFiles.has(f) || received.has(f!);
    const loaded = (f: string) => inFiles.has(f);
    const starts = appWideEntries.map(({ file, name }) => ({ file, name }));
    let reached: Set<FollowedSite>;
    for (;;) {
      const missed = new Set<string>();
      reached = screenFollower.reach(starts, canEnter, { missed, loaded });
      const more = [...missed].flatMap((f) => appWideClosure(f)).filter((f) => !canEnter(f));
      if (!more.length) break;
      for (const f of more) received.add(f);
    }
    const outside = canEnter(requestFile) ? screenFollower.reach(starts, (f) => canEnter(f) && f !== requestFile, { loaded }) : reached;
    const apiCalls = [...appWideFiles, ...received]
      .flatMap((f) => fileFacts(f).apiCalls.filter((c) => reached.has(c) && sends(c, outside)).map((c) => ({ ...c, file: rel(f) })))
      .sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.fn, b.fn));
    return { components: appWideEntries.map(({ import: from, name, file }) => ({ import: from, name, file: rel(file)! })), sourceFiles: appWideFiles.map((f) => rel(f)!).sort(), apiCalls };
  }

  // 화면이 보내지 않는 API 함수 가운데, API 파일 밖의 앱 소스에서 곧바로도 다른 API 함수를 거쳐서도 닿지 않는 것
  const onScreens = new Set(screens.flatMap((s) => s.apiCalls.map((c) => c.fn)));
  const off = Object.keys(apiFunctions).filter((k) => !onScreens.has(k));
  const unreferencedApiFunctions: string[] = [];
  if (off.length) {
    const exportsOf = new Map([...moduleExports, ...(called?.exportsOf ?? [])]);
    const declarations = new Map<string, { start: number; site: string }[]>();
    const declared = new Set<string>();
    for (const key of off) {
      for (const { file, exportName } of exportsOf.get(key) ?? []) {
        const d = follower.declaration(file, exportName);
        const start = d && follower.readable(d.file) ? declaredAt(parse(d.file).ast.program, d.name) : null;
        if (start === null) continue;
        declared.add(key);
        declarations.set(d!.file, [...(declarations.get(d!.file) ?? []), { start, site: key }]);
      }
    }
    const starts = sources.filter((f) => !apiModuleFiles.has(f) && !calledFiles.has(f) && !declarations.has(f) && follower.readable(f)).map((file) => ({ file, span: [0, Number.MAX_SAFE_INTEGER] as [number, number] }));
    const reached = follower.reach(starts, follower.readable, { sitesOf: (f) => declarations.get(f) ?? [] });
    unreferencedApiFunctions.push(...off.filter((k) => declared.has(k) && !reached.has(k)));
  }

  const sagaRuns = sagaSources.length ? { runs: runs.map(({ file, line }) => `${rel(file)}:${line}`), watchers: [...watchesOf.values()].flat().length } : null;
  // 같은 곳에서 알린 탭 줄은 한 번만 남긴다. 항목의 줄은 그리는 파일을 소스로 갖는 화면마다 다시 읽힌다.
  const routeTabNoticeLines = routeTabNotices.filter((n, i) => !routeTabNotices.slice(0, i).some((m) => m.file === n.file && m.line === n.line && m.reason === n.reason));
  return { screens, appWide, apiFunctions, unreferencedApiFunctions, sagaRuns, unrunApiModules: called?.failedModules ?? null, outsideStandIns: called?.outsideStandIns ?? [], silentApiModules: called?.silentModules ?? [], requestFileError: called?.requestFileError ?? null, bodyTypeNotices: called?.bodyTypeNotices.length ? called.bodyTypeNotices : null, redirects, unreadRoutePaths, unreadRoutes, routeTabNotices: routeTabNoticeLines.length ? routeTabNoticeLines : null, manyLinkBranches: linkNotices, guardInits, constants, guardSettings, settingsDefaults, settingsDefaultsIncomplete, settingsCallNotices, unresolvedAliasImports: imports.unresolved(), unusedListed: listedComponents.length + listedFunctions.length ? [...listedComponents, ...listedFunctions].filter((e) => !usedListed.has(e)).map((e) => `${e.key} ${e.import} ${e.name}`) : null, madeHistories: [...madeHistories].sort(([a], [b]) => compare(a, b)).map(([file, call]) => ({ file, call })), emptyRouteFiles, takingAddressesUnder: screensTakingAddressesUnder(routeRoots, sourced.map((x) => x.s.path)), framesPickingByAddress: [...framesPickingByAddress.values()].map((f) => ({ ...f, componentFile: rel(f.componentFile)! })).sort((a, b) => compare(a.file, b.file) || a.line - b.line) };
}
