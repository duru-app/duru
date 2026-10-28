import fs from 'node:fs';
import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath, Scope } from '@babel/traverse';
import type { ArrayExpression, ArrowFunctionExpression, CallExpression, ClassDeclaration, Expression, FunctionDeclaration, FunctionExpression, Identifier, ImportDeclaration, ImportDefaultSpecifier, ImportNamespaceSpecifier, ImportSpecifier, ExportSpecifier, JSXAttribute, JSXElement, JSXIdentifier, JSXMemberExpression, JSXNamespacedName, MemberExpression, Node, ObjectExpression, ObjectProperty, OptionalCallExpression, OptionalMemberExpression, Program, StringLiteral, TemplateLiteral, VariableDeclaration, VariableDeclarator } from '@babel/types';
import { routerTargets } from './access.ts';
import { addressReader, MOST_ADDRESSES, UNREADABLE_PIECE } from './address-functions.ts';
import type { AddressFunction, LinkComponent, Read } from './address-functions.ts';
import type { Branch, Constants, GuardInit, GuardSetting, RouteNode, Side } from './access.ts';
import { recordApiCalls, requestFunctionFile } from './api-calls.ts';
import { componentFileFinder } from './component-file.ts';
import { compare, ROUTES_FILE } from './config.ts';
import { loadConstants } from './constants.ts';
import { inTypePosition, nameFollower } from './follow-names.ts';
import type { Origin } from './follow-names.ts';
import { parseSource } from './parse.ts';
import { pathParts, routePattern } from './path-values.ts';
import { importResolver } from './resolve.ts';
import { sagaFiles, sagaReader, sourceFiles } from './saga-requests.ts';
import type { ActionType, Handler, Watch } from './saga-requests.ts';
import { addresses, FOLLOWED, LINK_ELEMENTS, madeFrom, screenLinkReader } from './screen-links.ts';
import { importedAs, routerImport, screenRequestReader } from './screen-requests.ts';
import { cleanAddress, pathOnSite } from './sent-address.ts';
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
  file?: string;
}

// under 는 컴포넌트를 렌더링한 위치에 걸린 조건이다. 조건 없이 렌더링했으면 null 이다.
interface FrameFile {
  file: string;
  under: Required<InheritedGuard> | null;
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
type RouteRef = Site & { route: string; tail?: string | null };
type RouterLink = Site & { to: string; sides?: Side[] };
// 테이블 항목마다 메뉴 링크를 렌더링하는 요소. 반복문의 항목에서 라우트 경로와 같은 field 를 가져다 쓴다.
type MenuElement = RouterLink & { menu: string };
type FollowedSite = ApiCallSite | DispatchSite | WatcherSite | RouteRef | RouterLink;
type SiteKind = 'apiCalls' | 'settingReads' | 'routeRefs' | 'routerLinks';

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
  frameFiles: FrameFile[];
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
  menus?: string[];
}

interface LoopRoute {
  element: Node;
  line: number;
  page: Page;
  drawnKeys: string[] | null;
  pathExpr: NodePath;
  item: { node: Node; field: string };
  exactField: string | null;
  guards: string[];
  wrappers: string[];
  frame: FrameFile[];
}

interface DrawnNode {
  kind: RouteNode['kind'];
  path: string | null;
  exact: boolean;
  exactUnread?: boolean;
  from: string | null;
  to: string;
  screens: RouteScreen[];
  entry: string | null;
  isRoute: boolean;
  isFragment: boolean;
  redirectAsElement: boolean;
  when: Side | null;
  children: DrawnNode[];
  frame?: () => FrameFile[];
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

const QUERY_PACKAGES = new Set(['react-query', '@tanstack/react-query']);
const QUERY_HOOKS = new Set(['useQuery', 'useInfiniteQuery', 'useSuspenseQuery', 'useSuspenseInfiniteQuery', 'useQueries', 'useSuspenseQueries']);

type QueryEnabled = (parent: NodePath, child: NodePath, site: NodePath) => NodePath | null;

function guardsOf(nodePath: NodePath, src: string, note: Note, queryEnabled?: QueryEnabled, until?: Node) {
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

const exportsOnly = (p: NodePath) => p.parentPath!.isExportSpecifier() || p.parentPath!.isExportDefaultDeclaration();

// `export { f }` · `export default f` · 내보내기에만 쓰는 `const g = f` 는 f 를 부르지 않는다.
function reExported(p: NodePath) {
  if (exportsOnly(p)) return true;
  const declarator = p.parentPath!;
  if (!declarator.isVariableDeclarator() || p.key !== 'init' || declarator.node.id.type !== 'Identifier' || (declarator.parent as VariableDeclaration).kind !== 'const') return false;
  const binding = declarator.scope.getBinding(declarator.node.id.name)!;
  return binding.scope.block.type === 'Program' && binding.referencePaths.every((r) => r.isExportNamedDeclaration() || exportsOnly(r));
}

const lookedUp = (ref: NodePath) => {
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
  // 라우트가 exact 를 표 항목에서 읽는 화면마다 그 항목의 exact. 읽지 못했으면 null 이다.
  const itemExact = new Map<RouteScreen, boolean | null>();
  const tableFiles = new Set((config.routeTables as RouteTable[]).map((t) => path.join(config.srcRoot, t.table.file)));
  const menuTables = new Map<string, string[]>();
  for (const t of routeTables.values()) {
    for (const f of (t.menus ?? []).map((m) => path.join(config.srcRoot, m))) menuTables.set(f, [...(menuTables.get(f) ?? []), t.at]);
  }
  const tableRoutes = new Map<string, { field: string; routeFile: string; line: number }>();
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
  const programFile = new WeakMap<Node, string>();
  const parse = (file: string) => {
    if (!parsed.has(file)) {
      parsed.set(file, parseSource(file));
      programFile.set(parsed.get(file)!.ast.program, file);
    }
    return parsed.get(file)!;
  };
  const siteStart = new WeakMap<FollowedSite, number>();
  const siteFile = new WeakMap<FollowedSite, string>();
  const linkAddressRefs = new WeakSet<RouteRef>();
  const exportedKeys = new WeakMap<RouteRef, { file: string; name: string }>();
  const importedLater = new Map<string, Set<string>>();
  const lookedUpIn = new Map<string, boolean>();
  const lookedUpElsewhere = ({ file, name }: { file: string; name: string }) => {
    const key = JSON.stringify([file, name]);
    if (!lookedUpIn.has(key)) lookedUpIn.set(key, [...factCache].every(([from, facts]) => from === file || !facts.imports.includes(file) || (!importedLater.get(from)?.has(file) && importsLookUp(from, file, name))));
    return lookedUpIn.get(key)!;
  };
  function importsLookUp(from: string, file: string, name: string) {
    const program = programOf(from);
    if (!program) return false;
    let imported = false;
    for (const statement of program.get('body')) {
      if (!(statement.isImportDeclaration() || statement.isExportNamedDeclaration() || statement.isExportAllDeclaration())) continue;
      const source = statement.node.source;
      if (!source || imports.resolve(from, source.value) !== file) continue;
      imported = true;
      if (statement.isExportAllDeclaration()) return false;
      if (statement.isExportNamedDeclaration()) {
        if (statement.node.specifiers.some((x) => x.type === 'ExportNamespaceSpecifier' || keyName({ key: (x as ExportSpecifier).local }) === name)) return false;
        continue;
      }
      for (const x of (statement as NodePath<ImportDeclaration>).get('specifiers')) {
        const refs = x.scope.getBinding(x.node.local.name)!.referencePaths;
        if (x.isImportNamespaceSpecifier()) {
          for (const ref of refs) {
            const up = ref.parentPath!;
            if (!(up.isMemberExpression() || up.isOptionalMemberExpression()) || up.node.object !== ref.node || up.node.computed) return false;
            if (keyName({ key: up.node.property }) === name && !lookedUp(up)) return false;
          }
        } else if (x.isImportSpecifier() && keyName({ key: x.node.imported }) === name && !refs.every(lookedUp)) return false;
      }
    }
    return imported;
  }
  const movedTo = new WeakSet<RouteRef | RouterLink>();
  const linkSites = (facts: Facts): (RouteRef | RouterLink)[] => [...facts.routeRefs, ...facts.routerLinks];
  const sitesOf = (file: string) => {
    const facts = fileFacts(file);
    return [...facts.apiCalls, ...facts.dispatches, ...facts.watchers, ...linkSites(facts)].map((site) => ({ start: siteStart.get(site)!, site }));
  };
  const follower = nameFollower<FollowedSite>({ parse, resolve: imports.resolve, sitesOf });
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

  // 뒤에 펼친 값이 있어도 마지막으로 적힌 값을 읽는다.
  function lastValue(options: NodePath<any> | null, key: string) {
    const obj = options?.node ? objectLiteral(options) : null;
    const prop = obj?.get('properties').findLast((p) => propertyKey(p) === key);
    return prop ? (prop.get('value') as NodePath) : null;
  }

  function enabledIn(options: NodePath<any> | null) {
    const value = lastValue(options, 'enabled');
    return value && !value.isBooleanLiteral({ value: true }) ? value : null;
  }

  // 질의 키를 만드는 자리: v3 처럼 키를 먼저 주는 첫 인자나 옵션의 queryKey
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

  const LIST_CALLBACKS = ['forEach', 'map'];
  type Way = { guards: string[]; through: Node[] };
  type KeyEntry = Way & { value: string; chain: string[] | null };
  type ChainWay = Way & { chain: string[] };
  type KeyWalk = { onPath: Set<Binding>; hops: number; guardsAt: (at: NodePath) => string[]; frames: Map<Node, { call: NodePath; outer: KeyWalk }> };

  function entered<T>(binding: Binding, walk: KeyWalk, read: () => T[]): T[] {
    if (walk.onPath.has(binding)) return [];
    walk.onPath.add(binding);
    try {
      return read();
    } finally {
      walk.onPath.delete(binding);
    }
  }

  const memberName = (p: NodePath) => ((p.isMemberExpression() || p.isOptionalMemberExpression()) && !p.node.computed ? (p.node.property as Identifier).name : null);
  const isCallee = (ref: NodePath) => (ref.parentPath!.isCallExpression() || ref.parentPath!.isOptionalCallExpression()) && ref.key === 'callee';
  const settingsDefault = (chain: string[]) => chain.slice(1).reduce((v: any, k) => v?.[k], settingsDefaults[chain[0]]);

  function functionName(fn: NodePath): Binding | undefined {
    const declarator = fn.parentPath!;
    const id = fn.isFunctionDeclaration() ? fn.node.id : declarator.isVariableDeclarator() && declarator.node.init === fn.node ? declarator.node.id : null;
    return id?.type === 'Identifier' ? declarator.scope.getBinding(id.name) : undefined;
  }

  function argumentFor(binding: Binding, call: NodePath): NodePath | null {
    const param = binding.path;
    const index = param.key as number;
    const args = call.get('arguments') as NodePath[];
    if (args.slice(0, index + 1).some((a) => a.isSpreadElement()) || !args[index]) return null;
    if (param.isIdentifier()) return args[index];
    if (!param.isObjectPattern()) return null;
    const prop = param.get('properties').find((p) => p.isObjectProperty() && !p.node.computed && p.node.value === binding.identifier);
    const passed = prop && objectAt(args[index]);
    if (!passed) return null;
    const key = keyName(prop.node as ObjectProperty);
    const written = keysInOrder(passed).findLast((p) => p === null || keyName(p.node) === key);
    return written ? (written.get('value') as NodePath) : null;
  }

  // 돌려준 값을 읽으러 들어간 함수의 매개변수: 들어간 함수가 아니면 undefined, 그 호출에서 읽지 못하면 null
  function framedArgument(binding: Binding, walk: KeyWalk) {
    const frame = binding.path.listKey === 'params' ? walk.frames.get(binding.path.parentPath!.node) : undefined;
    if (!frame) return undefined;
    const arg = argumentFor(binding, frame.call);
    return arg ? { arg, walk: frame.outer } : null;
  }

  function passedAt<T extends Way>(binding: Binding, walk: KeyWalk, read: (arg: NodePath, walk: KeyWalk) => T[]): T[] {
    const param = binding.path;
    if (param.listKey !== 'params' || walk.hops >= FOLLOWED) return [];
    const fn = param.parentPath!;
    const named = functionName(fn);
    if (!named?.constant) return [];
    const inner = { ...walk, hops: walk.hops + 1 };
    const calls = [...named.referencePaths.filter(isCallee), ...importingCalls(fn, named)].map((ref) => ref.parentPath!);
    return entered(binding, walk, () => calls.flatMap((call) => {
      const arg = argumentFor(binding, call);
      if (!arg) return [];
      const guards = walk.guardsAt(call);
      return read(arg, inner).map((e) => ({ ...e, guards: [...guards, ...e.guards], through: [fn.node, ...e.through] }));
    }));
  }

  function keyEntries(key: NodePath, walk: KeyWalk): KeyEntry[] {
    if (key.isStringLiteral()) return [{ value: key.node.value, chain: null, guards: [], through: [] }];
    if (!key.isIdentifier()) return [];
    const binding = key.scope.getBinding(key.node.name);
    if (binding?.kind === 'const') {
      const init = constInit(key, key.node.name, new Set());
      return init ? entered(binding, walk, () => keyEntries(init as NodePath, walk)) : [];
    }
    if (binding?.kind !== 'param') return [];
    const framed = framedArgument(binding, walk);
    if (framed !== undefined) return framed ? keyEntries(framed.arg, framed.walk) : [];
    const fn = binding.path.parentPath!;
    const call = fn.parentPath!;
    if (binding.path.listKey === 'params' && binding.path.key === 0 && fn.listKey === 'arguments' && fn.key === 0 && (call.isCallExpression() || call.isOptionalCallExpression())) {
      const callee = call.get('callee') as NodePath;
      if (LIST_CALLBACKS.includes(memberName(callee) ?? '')) return listEntries(callee.get('object') as NodePath, walk);
    }
    return passedAt(binding, walk, keyEntries);
  }

  function settingsChains(expr: NodePath, walk: KeyWalk, rest: ChainWay[]): ChainWay[] {
    if (expr.isMemberExpression() || expr.isOptionalMemberExpression()) {
      const property = expr.get('property') as NodePath;
      const segments: ChainWay[] = !expr.node.computed && property.isIdentifier() ? [{ chain: [property.node.name], guards: [], through: [] }]
        : property.isStringLiteral() ? [{ chain: [property.node.value], guards: [], through: [] }]
          : expr.node.computed ? keyEntries(property, walk).map(({ value, guards, through }) => ({ chain: [value], guards, through })) : [];
      const longer = segments.flatMap((s) => rest.map((r) => ({ chain: [...s.chain, ...r.chain], guards: [...s.guards, ...r.guards], through: [...s.through, ...r.through] })));
      return longer.length ? settingsChains(expr.get('object') as NodePath, walk, longer) : [];
    }
    if (!expr.isIdentifier()) return [];
    const prefix = Object.hasOwn(settingsDefaults, expr.node.name) ? [expr.node.name] : settingsResult(expr);
    const found: ChainWay[] = [];
    const unread: ChainWay[] = [];
    for (const r of rest) {
      const chain = prefix ? [...prefix, ...r.chain] : null;
      if (chain && settingsDefault(chain) !== undefined) found.push({ ...r, chain });
      else unread.push(r);
    }
    if (!unread.length) return found;
    const binding = expr.scope.getBinding(expr.node.name);
    if (binding?.kind === 'const') {
      const init = constInit(expr, expr.node.name, new Set());
      return [...found, ...(init ? entered(binding, walk, () => settingsChains(init as NodePath, walk, unread)) : [])];
    }
    if (binding?.kind !== 'param') return found;
    const framed = framedArgument(binding, walk);
    if (framed !== undefined) return [...found, ...(framed ? settingsChains(framed.arg, framed.walk, unread) : [])];
    return [...found, ...passedAt(binding, walk, (arg, inner) => settingsChains(arg, inner, unread))];
  }

  function listEntries(list: NodePath, walk: KeyWalk): KeyEntry[] {
    const chain = settingsPath(list);
    const listed = chain && settingsDefault(chain);
    if (Array.isArray(listed)) return listed.filter((v) => typeof v === 'string').map((value) => ({ value, chain, guards: [], through: [] }));
    if (list.isMemberExpression() || list.isOptionalMemberExpression()) {
      return settingsChains(list, walk, [{ chain: [], guards: [], through: [] }]).flatMap(({ chain, guards, through }) => {
        const values = settingsDefault(chain);
        return Array.isArray(values) ? values.filter((v) => typeof v === 'string').map((value) => ({ value, chain, guards, through })) : [];
      });
    }
    if (list.isArrayExpression()) {
      const elements = list.get('elements');
      if (!elements.every((e) => e.isStringLiteral() || e.isSpreadElement())) return [];
      return elements.flatMap((e) => (e.isSpreadElement() ? listEntries(e.get('argument'), walk) : [{ value: (e.node as StringLiteral).value, chain: null, guards: [], through: [] }]));
    }
    if (list.isLogicalExpression() && ['||', '??'].includes(list.node.operator)) return [...listEntries(list.get('left'), walk), ...listEntries(list.get('right'), walk)];
    if (list.isCallExpression() || list.isOptionalCallExpression()) {
      const callee = list.get('callee') as NodePath;
      return memberName(callee) === 'filter' ? listEntries(callee.get('object') as NodePath, walk) : returnedEntries(list, walk);
    }
    if (!list.isIdentifier()) return [];
    const binding = list.scope.getBinding(list.node.name);
    if (binding?.kind === 'const') {
      const init = constInit(list, list.node.name, new Set());
      return init ? entered(binding, walk, () => listEntries(init as NodePath, walk)) : [];
    }
    if (binding?.kind === 'let') return assignedEntries(binding, walk);
    if (binding?.kind !== 'param') return [];
    const framed = framedArgument(binding, walk);
    if (framed !== undefined) return framed ? listEntries(framed.arg, framed.walk) : [];
    return passedAt(binding, walk, listEntries);
  }

  function assignedEntries(binding: Binding, walk: KeyWalk): KeyEntry[] {
    const declarator = binding.path;
    const writes = binding.constantViolations;
    if (!declarator.isVariableDeclarator() || !declarator.get('id').isIdentifier() || !writes.every((w) => w.isAssignmentExpression({ operator: '=' }) && w.get('left').isIdentifier())) return [];
    const init = declarator.get('init') as NodePath;
    return entered(binding, walk, () => [
      ...(init.node ? listEntries(init, walk) : []),
      ...writes.flatMap((w) => {
        const guards = walk.guardsAt(w);
        return listEntries(w.get('right') as NodePath, walk).map((e) => ({ ...e, guards: [...guards, ...e.guards] }));
      }),
    ]);
  }

  function returnedEntries(call: NodePath<CallExpression | OptionalCallExpression>, walk: KeyWalk): KeyEntry[] {
    const callee = call.get('callee') as NodePath;
    const binding = callee.isIdentifier() ? callee.scope.getBinding(callee.node.name) : undefined;
    if (!binding?.constant || walk.hops >= FOLLOWED) return [];
    const init = binding.kind === 'const' && binding.path.isVariableDeclarator() ? (binding.path.get('init') as NodePath) : null;
    const fn = binding.path.isFunctionDeclaration() ? binding.path : init?.isArrowFunctionExpression() || init?.isFunctionExpression() ? init : null;
    if (!fn) return [];
    const inner = { ...walk, hops: walk.hops + 1, frames: new Map(walk.frames).set(fn.node, { call, outer: walk }) };
    return entered(binding, walk, () => returnedValues(fn).flatMap((value) => {
      const guards = walk.guardsAt(value);
      return listEntries(value, inner).map((e) => ({ ...e, guards: [...guards, ...e.guards], through: [fn.node, ...e.through] }));
    }));
  }

  function listedRoutes(p: NodePath<MemberExpression | OptionalMemberExpression>, guardsAt: (at: NodePath) => string[]) {
    if (!routeChain || memberChain(p.node.object)?.join('.') !== config.routeConstant) return [];
    const key = p.get('property') as NodePath;
    const binding = key.isIdentifier() ? key.scope.getBinding(key.node.name) : undefined;
    if (binding?.kind !== 'param' || binding.path.listKey !== 'params') return [];
    const owner = p.getFunctionParent()?.node;
    const byRoute = new Map<string, { chain: string[] | null; guards: string[]; ownerCalls: boolean }>();
    for (const { value, chain, guards, through } of keyEntries(key, { onPath: new Set(), hops: 0, guardsAt, frames: new Map() })) {
      if (!Object.hasOwn(routeValues, value)) continue;
      const ownerCalls = Boolean(owner && through.includes(owner));
      const before = byRoute.get(value);
      if (!before) byRoute.set(value, { chain, guards: [...new Set(guards)], ownerCalls });
      else {
        if (before.chain?.join('.') !== chain?.join('.')) before.chain = null;
        before.guards = before.guards.filter((g) => guards.includes(g));
        before.ownerCalls &&= ownerCalls;
      }
    }
    const own = new Set(guardsAt(p));
    return [...byRoute].map(([route, { chain, guards, ownerCalls }]) => {
      const setting = chain ? { guard: `${chain.join('.')} includes '${route}'`, settings: needs.includes(chain, route) } : null;
      return { route, guards: [...(setting ? [setting.guard] : []), ...guards.filter((g) => !own.has(g))], setting, ownerCalls };
    });
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
  const linkReading = addressReader({
    leaf(p) {
      if (lossless(p)) return { value: evaluate(p) };
      const value = evaluate(p);
      return { parts: [p], withheld: typeof value === 'number' || (typeof value === 'string' && !value.includes(UNKNOWN)) };
    },
    declaredValue,
    declaredFunction,
    namespaceFunction,
    declaredClass,
    passThrough,
    mergesSlashes: false,
    testSide,
    moves: {
      moveOf: (p) => screenLinks.moveOf(p),
      component: (p) => linkComponentOf(p),
      linked: (p) => addresses(p).length > 0 && linkAddresses(p).length > 0,
      linkedCall: (p) => addressesOf(linkReading.helperBranches(p) ?? { branches: [] }, () => UNKNOWN).length > 0,
      linkedUse: (p) => addressesOf(linkReading.useBranches(p) ?? { branches: [] }, () => UNKNOWN).length > 0,
      isHistory: (p) => screenLinks.isHistory(p),
      holdsRouteConstant: (p) => Boolean(routeChain) && holdsRouteConstant(p),
    },
  });

  const routeChainOf = (chain: string[] | null) => chain !== null && chain[0] === routeRoot && chain.length === routeRest.length + 1 && routeRest.every((k: string, i: number) => chain[i + 1] === k);
  const isRouteConstant = (p: NodePath<any>) => (p.isMemberExpression() || p.isOptionalMemberExpression()) && routeChainOf(memberChain(p.node.object));

  // 식 안이나, 식이 쓴 이름의 초기값을 따라간 곳에 라우트 상수가 있는가
  function holdsRouteConstant(p: NodePath<any>, depth = 0): boolean {
    if (depth > FOLLOWED) return false;
    if (isRouteConstant(p)) return true;
    const names: NodePath[] = p.isIdentifier() ? [p] : [];
    let found = false;
    p.traverse({
      'MemberExpression|OptionalMemberExpression'(m: NodePath<any>) {
        if (!isRouteConstant(m)) return;
        found = true;
        m.stop();
      },
      Identifier(i) {
        if (i.isReferencedIdentifier()) names.push(i);
      },
    });
    return found || names.some((i) => madeFrom(i).slice(1).some((x) => holdsRouteConstant(x, depth + 1)));
  }

  const writtenAddress = (text: string) => {
    const segments = pathSegments(text);
    return segments ? `/${segments.map((s) => (s.includes(UNREADABLE_PIECE) ? VARIABLE_SEGMENT : s)).join('/')}` : UNKNOWN;
  };

  // 링크 요소의 to 나 history 이동에 적은 주소. 동적 세그먼트는 {*} 로 두고, 값으로 시작하는 주소는 {?} 다.
  // 갈래가 너무 많으면 함수를 따라가지 않고, 호출마다 읽지 못한 조각으로 둔 주소 하나를 준다.
  const linkAddresses = (p: NodePath) => addressesOf(linkReading.branches(p), () => writtenAddress(tailText(p)));

  // 주소 함수가 돌려준 갈래 가운데 끝까지 읽었는데 / 로 시작하지 않는 것은 링크가 아니고, // 가 생기는 것은 {?} 다.
  // sides 는 그 주소를 내는 갈래가 모두 같은 쪽에서만 생길 때 그 설정 값들이다.
  function addressesOf(read: Read, tooMany: () => string): { to: string; sides?: Side[] }[] {
    if ('tooMany' in read) return [{ to: tooMany() }];
    const found = new Map<string, Side[] | null>();
    const add = (to: string, sides: Side[] | null) => {
      const before = found.get(to);
      found.set(to, !found.has(to) ? sides : before && sides ? before.filter((a) => sides.some((b) => a.key === b.key && a.on === b.on)) : null);
    };
    for (const { text, made, whole, sides } of read.branches) {
      if (made && whole && !addresses(whole).length) continue;
      if (made && text.split(/[?#]/)[0].includes('//')) add(UNKNOWN, null);
      else if (pathSegments(text)) add(writtenAddress(text), sides ?? null);
      else if (!made || text.includes(UNREADABLE_PIECE)) add(UNKNOWN, null);
    }
    if (found.size > MOST_ADDRESSES) return [{ to: tooMany() }];
    return [...found].map(([to, sides]) => (sides?.length ? { to, sides } : { to }));
  }

  const keptBranches = (read: Read, keep: (text: string) => boolean): Read => ('tooMany' in read ? read : { branches: read.branches.filter((b) => keep(b.text)) });
  // linkComponents 의 컴포넌트는 바깥 사이트도 연다.
  const outsideAddresses = (newTab: boolean) => (p: NodePath) => addressesOf(keptBranches(linkReading.branches(p), (text) => !/^https?:\/\//i.test(text)), () => writtenAddress(tailText(p)))
    .filter(({ to }) => !newTab || (to !== UNKNOWN && !/\.\w+$/.test(to.split(/[?#]/)[0])));
  const listedAddresses = (p: NodePath) => addressesOf(keptBranches(linkReading.branches(p), (text) => text !== ''), () => writtenAddress(tailText(p)));

  const oneAddress = (p: NodePath) => {
    const [only, ...more] = linkAddresses(p);
    return more.length || only === undefined ? UNKNOWN : only.to;
  };

  // 라우트 상수 뒤에 이어 붙은 주소와, 상수부터 그 주소까지 이어 붙인 식. 꼬리는 마디마다 글자 그대로이거나 변수 하나이면 '/…',
  // 붙은 것이 없거나 쿼리와 # 뿐이면 '', 그 밖에는 null 이다.
  function routeTail(p: NodePath): { tail: string | null; whole: NodePath } {
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
    if (['', '/'].includes(tail.split(/[?#]/)[0])) return { tail: '', whole };
    const segments = pathSegments(tail)?.map((s) => (s === UNREADABLE_PIECE ? VARIABLE_SEGMENT : s));
    return { tail: segments?.every((s) => s && !s.includes(UNREADABLE_PIECE)) ? `/${segments.join('/')}` : null, whole };
  }

  // ---------- API 모듈: 내보낸 함수마다 호출하는 endpoint ----------

  function extractApiModule(file: string) {
    const sentUrl = (url: unknown) => {
      if (typeof url !== 'string') return (url ?? null) as string | null;
      const clean = cleanAddress(url);
      return pathOnSite(clean, config.app?.server ?? null, UNKNOWN) ?? clean;
    };
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
              endpoints.push({ method: value?.METHOD ?? null, url: sentUrl(value?.URL), line: obj.node.loc!.start.line });
            },
            MemberExpression(m) {
              if (m.parentPath.isMemberExpression({ object: m.node })) return;
              const value = lookupConstant(constants, memberChain(m.node));
              if (value && typeof value === 'object' && 'URL' in value) {
                endpoints.push({ method: value.METHOD ?? null, url: sentUrl(value.URL), line: m.node.loc!.start.line });
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
  const historyFile = config.history ? exportingFile('history', config.history) : null;
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
    routerElement(p) {
      const found = linkComponentOf(p);
      return found && 'router' in found ? found.router : null;
    },
  });
  const madeHistories = new Map<string, string>();

  function exportingFile(at: string, { import: from, name }: { import: string; name: string }) {
    const file = imports.resolve(path.join(config.srcRoot, 'index.js'), from);
    if (!file || !file.startsWith(config.srcRoot + path.sep)) throw new Error(`${at}.import ${from} names no file under srcRoot ${config.srcRoot}`);
    if (!follower.declaration(file, name)) throw new Error(`${at}.name ${name} is not exported by ${path.relative(config.srcRoot, file)}`);
    return file;
  }

  // file 은 import 가 srcRoot 안의 파일일 때 그 파일이고, 아니면 import 에 적힌 글자 그대로 맞춘다.
  type Listed = { key: 'linkComponents' | 'linkFunctions'; import: string; name: string; address?: string; file: string | null };
  const listedEntries = (key: Listed['key']): Listed[] => ((config[key] ?? []) as Omit<Listed, 'key' | 'file'>[]).map((entry) => ({ ...entry, key, file: listedFile(key, entry) }));
  function listedFile(key: Listed['key'], { import: from, name }: { import: string; name: string }) {
    const file = imports.resolve(path.join(config.srcRoot, 'index.js'), from);
    if (!file || !file.startsWith(config.srcRoot + path.sep)) {
      if (from.startsWith('.')) throw new Error(`${key} import ${from} names no file under srcRoot ${config.srcRoot}`);
      return null;
    }
    if (!follower.declaration(file, name)) throw new Error(`${key} ${from} ${name}: ${name} is not exported by ${path.relative(config.srcRoot, file)}`);
    return file;
  }
  const listedComponents = listedEntries('linkComponents');
  const listedFunctions = listedEntries('linkFunctions');
  const usedListed = new Set<Listed>();
  const listedImports = new Map<string, boolean>();
  // keys 는 import 한 이름에서 꺼낸 속성의 이름이다(<ads.Link> 의 Link).
  function listedAs(binding: Binding | undefined, keys: string[], entries: Listed[]): Listed | null {
    const from = binding && entries.length ? importedAs(binding) : null;
    const name = !from ? null : from.name === '*' ? (keys.length === 1 ? keys[0] : null) : keys.length ? null : from.name;
    if (!name) return null;
    const file = programFile.get(binding!.scope.getProgramParent().block);
    const resolved = file ? imports.resolve(file, from!.spec) : null;
    const found = entries.find((entry) => {
      if (!entry.file) return from!.spec === entry.import && name === entry.name;
      const key = `${resolved}\0${name}\0${entry.file}`;
      if (!listedImports.has(key)) listedImports.set(key, Boolean(resolved) && follower.origin(resolved, name, (f) => f === entry.file)?.name === entry.name);
      return listedImports.get(key)!;
    }) ?? null;
    if (found) usedListed.add(found);
    return found;
  }
  function listedCall(p: NodePath<CallExpression>): Listed | null {
    const callee = p.get('callee') as NodePath<any>;
    if (callee.isIdentifier()) return listedAs(callee.scope.getBinding(callee.node.name), [], listedFunctions);
    const object = callee.isMemberExpression() && !callee.node.computed ? callee.get('object') : null;
    return object?.isIdentifier() ? listedAs(object.scope.getBinding(object.node.name), [(callee.node.property as Identifier).name], listedFunctions) : null;
  }
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
          const { tail, whole } = routeTail(p);
          const member = whole.parentPath!;
          const table = whole.key === 'key' && (member.isObjectProperty() || member.isObjectMethod()) && member.node.computed ? lookupTable(member.parentPath!) : null;
          if (table && table.exported === null) return;
          const ref = record('routeRefs', { route: chain[chain.length - 1], tail }, p) as RouteRef;
          if (table?.exported) exportedKeys.set(ref, { file, name: table.exported });
          constantAt.set(whole.node, [ref]);
        }
      },
    });

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
      for (const address of read ? addressesOf(read, () => UNKNOWN) : []) record('routerLinks', address, p);
    };
    const recordUseLinks = (p: NodePath<JSXElement>) => {
      const written = (p.get('openingElement.attributes') as NodePath<any>[]).map((a) => (a.isJSXSpreadAttribute() ? a.get('argument') : a.get('value')) as NodePath<any>);
      if (written.some((v) => v.node && madeFrom(v.isJSXExpressionContainer() ? v.get('expression') : v).some(holdsRouteRef))) return;
      const read = linkReading.useBranches(p);
      for (const address of read ? addressesOf(read, () => UNKNOWN) : []) record('routerLinks', address, p);
    };
    const inRouteFile = routeFileSet.has(file);
    const menusHere = menuTables.get(file) ?? [];
    const recordMenuElement = (p: NodePath<JSXElement>) => {
      const fields = menusHere.length ? itemFieldsRead(p) : [];
      const tables = menusHere.filter((t) => {
        if (!tableRoutes.has(t)) throw new Error(`${t}: ${relFile} was read before the route file of its table`);
        return fields.includes(tableRoutes.get(t)!.field);
      });
      for (const table of tables) record('routerLinks', { to: UNKNOWN, menu: table }, p);
      return tables.length > 0;
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
    declaredClass,
    passThrough,
    mergesSlashes: true,
  });

  // 주소 함수가 돌려준 갈래 가운데 쿼리를 붙이는 것과, 고정된 마디가 있는 갈래 옆에서 경로 변수만 남은 것은 경로가 아니다.
  function readRoutePath(p: NodePath): { path: string; stops: NodePath[]; paths?: string[]; manyPaths?: true } {
    const calledAt = piecesOf(p).find((x) => x.isCallExpression()) ?? p;
    const lead = leadingPiece(p);
    const unread = lead.node !== p.node && readsMatchedRoute(lead) ? UNKNOWN + UNKNOWN : UNKNOWN;
    const found = routeReading.branches(p);
    if ('tooMany' in found) return { path: unread, stops: [calledAt], manyPaths: true };
    const segments = (b: { text: string }) => b.text.split('/').filter(Boolean);
    const fixed = (b: { text: string }) => segments(b).some((x) => !x.startsWith(':') && !x.includes(UNREADABLE_PIECE) && x !== '*');
    let read = found.branches.filter((b) => !b.made || !b.text.replace(/:\w+(\([^)]*\))?\?/g, '').includes('?'));
    if (read.some(fixed)) read = read.filter((b) => !b.made || fixed(b) || !segments(b).length || !segments(b).every((x) => x.startsWith(':')));
    const paths = [...new Set(read.map((b) => b.text.replaceAll(UNREADABLE_PIECE, UNKNOWN)))];
    if (paths.length === 1) return { path: paths[0], stops: read[0].stops };
    if (!paths.length) return { path: unread, stops: [p] };
    return { path: unread, stops: [calledAt], ...(paths.length > MOST_ADDRESSES ? { manyPaths: true as const } : { paths }) };
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
    const unreadLoopRoutes: { line: number; field: string }[] = [];
    const placed: { element: Node; screen: RouteScreen; grouped: boolean }[] = [];
    const frames = frameReader(absFile, routeFile, src, note);
    let loopAt = -1;
    let hasRoutes = false;
    traverse(ast, {
      JSXElement(p) {
        const tag = tagOf(p.node.openingElement.name);
        if (!tag) return;
        if (config.routeElements.includes(tag) || config.redirectElements.includes(tag)) hasRoutes = true;
        const attr = (name: string) => p.get('openingElement.attributes').find((a) => (a.node as JSXAttribute).name?.name === name) as NodePath<JSXAttribute> | undefined;
        if (config.redirectElements.includes(tag)) {
          const toValue = attr('to')?.get('value');
          const toExpr = toValue?.node ? (toValue.isJSXExpressionContainer() ? toValue.get('expression') : toValue) as NodePath : null;
          // 글자 값으로 끝까지 읽히는 to 는 그 값을 쓰고, 아니면 링크로 읽는다. 링크로도 읽지 못하면 글자 값을 남긴다.
          const written = toExpr ? evaluate(toExpr) : undefined;
          const read = typeof written === 'string' && !written.includes(UNKNOWN) ? written : toExpr ? oneAddress(toExpr) : UNKNOWN;
          redirects.push({ to: read === UNKNOWN && typeof written === 'string' ? written : read, file: routeFile, line: p.node.loc!.start.line, guards: guardsOf(p, src, note) });
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
        const drawnBy = (takesItem = false) => (renderAttr ? renderPage(renderAttr, absFile, takesItem) : childrenPage(p, absFile, takesItem));
        if (!pathAttr) {
          if (spread) return unread(`the path may be in ${sliceText(src, spread.node)}`);
          if (holdsRoutes(p)) return;
          const drawn = compAttr ? componentAttrPage(compAttr, absFile) : elementAttr ? elementPage(elementAttr, absFile) : drawnBy();
          if (typeof drawn === 'string') return unread(drawn);
          if (drawn && drawn !== REDIRECT) unread('no path');
          return;
        }
        const pathWritten = pathAttr.get('value');
        const pathExpr = (pathWritten.isJSXExpressionContainer() ? pathWritten.get('expression') : pathWritten) as NodePath;
        const item = table ? loopItem(p, pathExpr) : null;
        const missed = () => void (item && unreadLoopRoutes.push({ line, field: item.field }));
        let page: Page | null;
        let drawnInFunctionOrChildren = false;
        if (compAttr) page = componentAttrPage(compAttr, absFile);
        else if (elementAttr) page = elementPage(elementAttr, absFile);
        else {
          if (holdsRoutes(p) || definesRouteElement(p)) return;
          const drawn = drawnBy(Boolean(item));
          if (drawn === REDIRECT) return;
          if (typeof drawn === 'string') {
            missed();
            return unread(drawn);
          }
          if (!drawn) {
            missed();
            return spread ? unread(`the screen may be in ${sliceText(src, spread.node)}`) : undefined;
          }
          page = drawn;
          drawnInFunctionOrChildren = true;
        }
        if (!page) return missed();
        if (item) {
          if (loopAt < 0) loopAt = screens.length;
          const exactValue = attr('exact')?.get('value');
          const exactField = exactValue?.isJSXExpressionContainer() ? loopItem(p, exactValue.get('expression') as NodePath)?.field ?? null : null;
          loopRoutes.push({ element: p.node, line, page, drawnKeys: drawnItemKeys(page, p.scope, p.findParent(loopCallback)), pathExpr, item, exactField, guards: guardsOf(p, src, note), ...frames.of(p) });
          return;
        }
        const routeGuards = guardsOf(p, src, note);
        const { wrappers, frame } = frames.of(p);
        const wrapperFiles = [...page.files, ...wrappers];
        const grouped = Boolean(p.findParent((up) => up.isJSXElement() && ['Switch', 'Routes'].includes(tagOf(up.node.openingElement.name) ?? '')));
        const made: RouteScreen[] = [];
        for (const onePath of pathsIn(pathExpr)) {
          const { path: routePath, stops, ...gives } = readRoutePath(onePath);
          if (!routePath.includes(UNKNOWN) && made.some((m) => m.path === routePath)) continue;
          let unreadPath: OuterFill['unreadPath'] = null;
          const outerAddress = routePath.startsWith(UNKNOWN) ? leadingPiece(onePath) : null;
          if (routePath.includes(UNKNOWN)) {
            const stoppedAt = stopOf(stops[0] ?? onePath);
            if (drawnInFunctionOrChildren && madeInLoop(p)) {
              unread(`made for each item of a list, and its path stopped at ${stoppedAt.text}`);
              continue;
            }
            const outerStops = outerAddress && new Set(readRoutePath(outerAddress).stops.map((x) => x.node));
            const rest = outerStops && stops.find((x) => !outerStops.has(x.node));
            unreadPath = { entry: { file: routeFile, line, path: routePath, stoppedAt, ...gives }, restStoppedAt: rest ? stopOf(rest) : null };
            unreadRoutePaths.push(unreadPath.entry);
          }
          const screen: RouteScreen = {
            path: routePath,
            component: page.component,
            componentFile: page.componentFile,
            wrapperFiles: [...wrapperFiles],
            frameFiles: frame,
            routeFile,
            routeGuards: [...routeGuards],
            line,
            outerFill: { startsWithOuterAddress: Boolean(outerAddress) && readsMatchedRoute(outerAddress!), unreadPath },
          };
          screens.push(screen);
          made.push(screen);
          placed.push({ element: p.node, screen, grouped });
        }
        elementScreens.set(p.node, made);
      },
    });
    // 모달로 한 번 더 그리려고 Switch · Routes 밖에 적은 라우트는, 경로와 컴포넌트가 같은 묶음 안의 라우트와 한 화면이다.
    for (const { element, screen, grouped } of placed) {
      const same = grouped || screen.path.includes(UNKNOWN) ? null : placed.find((o) => o.grouped && o.screen.path === screen.path && o.screen.component === screen.component && o.screen.componentFile === screen.componentFile);
      if (!same) continue;
      const at = screens.indexOf(screen);
      screens.splice(at, 1);
      if (loopAt > at) loopAt--;
      elementScreens.set(element, elementScreens.get(element)!.map((s) => (s === screen ? same.screen : s)));
    }
    if (table) {
      const listed = tableScreens(table, loopRoutes, unreadLoopRoutes, routeFile);
      elementScreens.set(loopRoutes[0].element, listed);
      screens.splice(loopAt < 0 ? screens.length : loopAt, 0, ...listed);
    }
    return { screens, roots: drawnTree(ast, absFile, elementScreens, frames), hasRoutes };
  }

  function testSide(test: NodePath<any>, on: boolean): Side | null {
    while (test.isUnaryExpression({ operator: '!' })) {
      test = test.get('argument');
      on = !on;
    }
    const chain = memberChain(test.node);
    return chain && settingsRoots.has(chain[0]) ? { key: chain.join('.'), on } : null;
  }

  function drawnSide(p: NodePath<JSXElement>): Side | null {
    const up = p.parentPath;
    if (up.isConditionalExpression() && (p.key === 'consequent' || p.key === 'alternate')) return testSide(up.get('test'), p.key === 'consequent');
    if (up.isLogicalExpression() && up.node.operator !== '??' && p.key === 'right') return testSide(up.get('left'), up.node.operator === '&&');
    return null;
  }

  function drawnTree(ast: ReturnType<typeof parseSource>['ast'], absFile: string, elementScreens: Map<Node, RouteScreen[]>, frames: ReturnType<typeof frameReader>) {
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
        const exactValue = exact ? evaluate(exact) : undefined;
        const text = (p: NodePath | undefined | null) => (p ? readRoutePath(p).path : UNKNOWN);
        const node: DrawnNode = { kind: 'route', path: null, exact: exact === null || exactValue === true, exactUnread: Boolean(exact) && typeof exactValue !== 'boolean', from: null, to: UNKNOWN, screens: elementScreens.get(p.node) ?? [], entry: null, isRoute: false, isFragment: false, redirectAsElement: false, when: drawnSide(p), children: [] };
        const binding = p.scope.getBinding(tag);
        const reactAs = (b: Binding | undefined) => {
          const from = b && importedAs(b);
          return from?.spec === 'react' ? from.name : null;
        };
        node.isFragment = tag === 'Fragment' ? reactAs(binding) === 'Fragment' : tag === 'React.Fragment' && ['default', '*'].includes(reactAs(p.scope.getBinding('React')) ?? '');
        const group = groupKind(p);
        if (group) node.kind = group;
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
          let frame: FrameFile[] | undefined;
          node.frame = () => {
            if (!frame) {
              const { wrappers, frame: beside } = frames.of(p);
              frame = [...wrappers.map((file) => ({ file, under: null })), ...beside];
            }
            return frame;
          };
        }
        nodes.set(p.node, node);
        const parent = p.findParent((a) => a.isJSXElement() && nodes.has(a.node));
        (parent ? nodes.get(parent.node)!.children : roots).push(node);
      },
    });
    return roots;
  }

  function tableScreens(table: RouteTable & { at: string }, routes: LoopRoute[], unreadLoops: { line: number; field: string }[], routeFile: string): RouteScreen[] {
    if (!routes.length && unreadLoops.length) {
      const [{ line, field }] = unreadLoops;
      throw new Error(`${table.at}: the route at ${routeFile}:${line} is made for each item of a list and its path reads the item's ${field}, but the screen it draws is not read`);
    }
    if (!routes.length) throw new Error(`${table.at}: ${routeFile} has no route made for each item of a list whose path reads a field of the item`);
    if (routes.length > 1) throw new Error(`${table.at}: ${routeFile} has ${routes.length} routes made for each item of a list, at ${routes.map((r) => `${routeFile}:${r.line}`).join(' and ')}; a route file takes one table`);
    const [{ line, page, drawnKeys, pathExpr, item, exactField, guards, wrappers, frame }] = routes;
    tableRoutes.set(table.at, { field: item.field, routeFile, line });
    const { file, const: name } = table.table;
    const literal = tableLiteral(table, file, name);
    const items = tableItems(literal, table.items.split('.')).map((it) => ({ ...it, field: it.object && propertyValue(it.object, item.field) }));
    if (!items.some((it) => it.field)) throw new Error(`${table.at}: items "${table.items}" finds no item with a ${item.field} in ${name}, which the route at ${routeFile}:${line} reads`);
    return items.flatMap(({ key, line: itemLine, file: itemFile, object: itemObject, field }): RouteScreen[] => {
      const place = `table item ${key} at ${itemFile}:${itemLine}`;
      if (!itemObject) {
        unreadRoutes.push({ file: routeFile, line, reason: `${place} is not an object written in the source` });
        return [];
      }
      if (!field) {
        unreadRoutes.push({ file: routeFile, line, reason: `${place} has no ${item.field}` });
        return [];
      }
      const values = [...new Set(pathsIn(field).flatMap((onePath) => {
        const value = evaluate(onePath);
        if (readWhole(value)) return [String(value)];
        const called = readRoutePath(onePath).path;
        if (!called.includes(UNKNOWN)) return [called];
        const at = stopOf(unreadPiece(onePath) ?? onePath);
        unreadRoutes.push({ file: routeFile, line, reason: `${place}: its ${item.field} stopped at ${at.text}${at.file === itemFile ? '' : ` in ${at.file}:${at.line}`}` });
        return [];
      }))];
      if (!values.length) return [];
      const drawn = drawnKeys && keyedValue(itemObject, drawnKeys);
      if (drawnKeys && !drawn) {
        unreadRoutes.push({ file: routeFile, line, reason: `${place} has no ${drawnKeys.join('.')}` });
        return [];
      }
      const components = itemComponents(drawn ? [drawn] : componentValues(itemObject, new Set()));
      if (drawn && !components.length) {
        const at = stopOf(drawn);
        unreadRoutes.push({ file: routeFile, line, reason: `${place}: its ${drawnKeys!.join('.')} stopped at ${at.text}${at.file === itemFile ? '' : ` in ${at.file}:${at.line}`}` });
        return [];
      }
      if (components.length && components.every((c) => c.redirects)) return [];
      const shown = components[0] ?? page;
      const exact = exactField ? itemExactValue(itemObject, exactField) : null;
      return values.map((value): RouteScreen => {
        const routePath = pathText(pathExpr, item.node, value);
        const outerAddress = routePath.startsWith(UNKNOWN) ? leadingPiece(pathExpr) : null;
        let unreadPath: OuterFill['unreadPath'] = null;
        if (routePath.includes(UNKNOWN)) {
          const rest = outerAddress && unreadPiece(pathExpr, new Set(), [outerAddress.node, item.node]);
          unreadPath = { entry: { file: routeFile, line, path: routePath, stoppedAt: stopOf(unreadPiece(pathExpr, new Set(), [item.node])!) }, restStoppedAt: rest ? stopOf(rest) : null };
          unreadRoutePaths.push(unreadPath.entry);
        }
        const screen: RouteScreen = {
          path: routePath,
          component: shown.component,
          componentFile: shown.componentFile,
          wrapperFiles: [...new Set([page.componentFile, ...page.files, ...components.map((c) => c.componentFile), ...wrappers].filter(Boolean) as string[])],
          frameFiles: frame,
          routeFile,
          routeGuards: guards,
          line,
          tableItem: { key, file: itemFile, line: itemLine },
          outerFill: { startsWithOuterAddress: Boolean(outerAddress) && readsMatchedRoute(outerAddress!), unreadPath },
        };
        if (exactField) itemExact.set(screen, exact);
        return screen;
      });
    });
  }

  // 마지막에 적힌 field 뒤에 읽지 못한 펼치기나 계산된 키가 있으면 값을 모른다.
  function itemExactValue(item: NodePath<ObjectExpression>, field: string) {
    const keys = keysInOrder(item);
    const at = keys.findLastIndex((prop) => prop !== null && keyName(prop.node) === field);
    if (keys.slice(at + 1).includes(null)) return null;
    const value = at < 0 ? false : evaluate(keys[at]!.get('value'));
    return typeof value === 'boolean' ? value : null;
  }

  // exact 가 아닌 라우트의 화면과 경로를 적힌 차례로 준다. depth 는 감싼 라우트 수다.
  function screensTakingAddressesUnder(roots: RouteNode[], paths: string[]) {
    const found = new Map<number, { path: string; depth: number }>();
    const seen = new Set<RouteNode>();
    const walk = (nodes: RouteNode[], depth: number) => {
      for (const node of nodes) {
        if (seen.has(node)) continue;
        seen.add(node);
        if (node.kind === 'switch') walk(node.children, depth);
        else if (node.kind === 'routes') {
          for (const { chain } of node.branches) chain.forEach((r, i) => walk(r.children, depth + i + 1));
        } else if (node.kind === 'route') {
          if (!node.exactUnread && !node.exact) for (const i of node.screens) if (!found.has(i)) found.set(i, { path: paths[i], depth });
          walk(node.children, depth + 1);
        }
      }
    };
    walk(roots, 0);
    return [...found].map(([screen, taker]) => ({ screen, ...taker }));
  }

  const pathText = (p: NodePath, filled: Node, value: string): string => (p.node === filled ? value
    : p.isTemplateLiteral() ? p.node.quasis.map((q, i) => (i ? pathText(p.get(`expressions.${i - 1}`) as NodePath, filled, value) : '') + q.value.cooked).join('')
      : p.isBinaryExpression({ operator: '+' }) ? pathText(p.get('left'), filled, value) + pathText(p.get('right'), filled, value)
        : textOf(evaluate(p)));

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

  // 따라가지 못한 스프레드와 빈 항목은 값이 없는 항목 하나로 센다.
  function elementsOf(list: NodePath<ArrayExpression>, seen = new Set<Node>([list.node])): { value: NodePath | null; line: number; file: string }[] {
    return list.get('elements').flatMap((e) => {
      const line = (e.node ?? list.node).loc!.start.line;
      if (!e.isSpreadElement()) return [{ value: e.node ? e as NodePath : null, line, file: fileOf(list) }];
      const spread = literalAt(e.get('argument'));
      return spread?.isArrayExpression() && !seen.has(spread.node) ? elementsOf(spread, new Set(seen).add(spread.node)) : [{ value: null, line, file: fileOf(list) }];
    });
  }

  // 주소 목록이 아니면 null 을 돌려준다. 값을 알 수 없는 `...` spread 는 주소 하나로 친다.
  function listedPaths(p: NodePath, seen = new Set<Node>()): NodePath[] | null {
    const list = literalAt(p);
    if (!list?.isArrayExpression() || seen.has(list.node)) return null;
    const inside = new Set(seen).add(list.node);
    return list.get('elements').flatMap((e) => {
      if (!e.node) return [];
      if (!e.isSpreadElement()) return [e as NodePath];
      return listedPaths(e.get('argument'), inside) ?? [e.get('argument')];
    });
  }

  const pathsIn = (p: NodePath) => {
    const listed = listedPaths(p);
    return listed?.length ? listed : [p];
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

  function tableItems(table: NodePath<ObjectExpression | ArrayExpression>, segments: string[], keys: string[] = []): { key: string; line: number; file: string; object: NodePath<ObjectExpression> | null }[] {
    const [first, ...rest] = segments;
    const entries = (table.isObjectExpression()
      ? propertiesOf(table).map((prop) => ({ name: keyName(prop.node), value: prop.get('value') as NodePath | null, line: prop.node.loc!.start.line, file: fileOf(prop) }))
      : elementsOf(table as NodePath<ArrayExpression>).map((e, i) => ({ name: String(i), ...e }))).filter(({ name }) => first === '*' || first === name);
    if (rest.length) return entries.flatMap(({ name, value }) => {
      const inner = value && literalAt(value);
      return inner ? tableItems(inner, rest, [...keys, name]) : [];
    });
    const leaves = entries.map(({ name, value, line, file }) => {
      const inner = value && literalAt(value);
      return { key: [...keys, name].join('.'), line, file, object: inner?.isObjectExpression() ? inner : null };
    });
    return table.isArrayExpression() && leaves.some((l) => l.object) ? leaves : leaves.filter((l) => l.object);
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

  function itemComponents(values: NodePath[]) {
    const found = new Map<string, Omit<Page, 'files'> & { redirects: boolean }>();
    for (const written of values) {
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

  // 내보낸 이름을 따라가 그 이름을 선언한 자리. default 면 export default 뒤에 적힌 것이다.
  function exportedDeclaration(file: string | null, name: string): NodePath | null {
    const found = file ? follower.declaration(file, name) : null;
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

  const linkComponents = new WeakMap<Node, LinkComponent | null>();
  function linkComponentOf(element: NodePath<JSXElement>): LinkComponent | null {
    if (linkComponents.has(element.node)) return linkComponents.get(element.node)!;
    const opening = element.get('openingElement');
    const as = (opening.get('attributes') as NodePath<any>[]).find((a) => a.isJSXAttribute() && a.node.name.name === 'as');
    const value = as?.get('value') as NodePath<any> | undefined;
    const name = opening.get('name') as NodePath<any>;
    const found = as ? (value?.isJSXExpressionContainer() ? componentAt(value.get('expression'), [], 0) : null)
      : name.isJSXIdentifier() && /^[a-z]/.test(name.node.name) ? null : componentAt(name, [], 0);
    linkComponents.set(element.node, found);
    return found;
  }

  // 컴포넌트를 선언까지 따라간다. keys 는 그 앞까지 따라간 것에서 꺼낼 객체 속성 · 클래스 static 속성의 이름이다.
  function componentAt(p: NodePath<any> | null | undefined, keys: string[], depth: number): LinkComponent | null {
    if (!p?.node) return null;
    if (p.isTSAsExpression() || p.isTSSatisfiesExpression() || p.isTSNonNullExpression() || p.isParenthesizedExpression()) return componentAt(p.get('expression') as NodePath, keys, depth);
    if (p.isIdentifier() || p.isJSXIdentifier()) return componentNamed(p.scope.getBinding(p.node.name), keys, depth);
    if (p.isImportSpecifier() || p.isImportDefaultSpecifier() || p.isImportNamespaceSpecifier()) return componentNamed(p.scope.getBinding(p.node.local.name), keys, depth);
    if ((p.isMemberExpression() && !p.node.computed) || p.isJSXMemberExpression()) return componentAt(p.get('object') as NodePath, [(p.node.property as Identifier).name, ...keys], depth);
    if (p.isVariableDeclarator()) return p.get('id').isIdentifier() && (p.parent as VariableDeclaration).kind === 'const' ? componentAt(p.get('init') as NodePath, keys, depth) : null;
    if (keys.length) {
      const [key, ...rest] = keys;
      const members = (p.isObjectExpression() ? p.get('properties') : p.isClassDeclaration() || p.isClassExpression() ? (p.get('body.body') as NodePath[]).filter((m) => m.isClassProperty({ static: true })) : []) as NodePath<any>[];
      const member = members.findLast((m) => (m.isObjectProperty() || m.isClassProperty()) && !m.node.computed && keyName(m.node) === key);
      return member ? componentAt(member.get('value') as NodePath, rest, depth) : null;
    }
    if (p.isFunctionDeclaration() || p.isArrowFunctionExpression() || p.isFunctionExpression()) return { fn: p };
    if (p.isTaggedTemplateExpression()) return componentAt(p.get('tag'), [], depth);
    if (!p.isCallExpression()) return null;
    const callee = p.get('callee');
    return componentAt(p.get('arguments.0') as NodePath, [], depth) ?? (callee.isCallExpression() ? componentAt(callee, [], depth) : null);
  }

  function componentNamed(binding: Binding | undefined, keys: string[], depth: number): LinkComponent | null {
    if (!binding || binding.kind === 'param' || depth >= FOLLOWED) return null;
    if (listedAs(binding, keys, listedComponents)) return { router: 'Link', listed: true };
    if (routerImport(binding)) {
      const { name } = importedAs(binding)!;
      const tag = name === '*' ? keys.length === 1 && keys[0] : !keys.length && name;
      return tag && LINK_ELEMENTS.has(tag) ? { router: tag } : null;
    }
    if (binding.kind !== 'module') return componentAt(binding.path, keys, depth + 1);
    const from = importedName(binding);
    if (!from || (from.name === '*' && !keys.length)) return null;
    return from.name === '*' ? componentAt(exportedDeclaration(from.file, keys[0]), keys.slice(1), depth + 1) : componentAt(exportedDeclaration(from.file, from.name), keys, depth + 1);
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

  function holdsRoutes(route: NodePath<JSXElement>, redirects = false) {
    let found = false;
    route.traverse({
      JSXElement(e) {
        const tag = tagOf(e.node.openingElement.name);
        if (tag && (config.routeElements.includes(tag) || (redirects && config.redirectElements.includes(tag)))) {
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

  // 기본값을 주었거나 중첩 패턴으로 받은 이름은 넣지 않는다.
  function itemFields(param: NodePath) {
    const fields = new Map<string, string>();
    if (!param.isObjectPattern()) return fields;
    for (const prop of param.node.properties) {
      if (prop.type === 'ObjectProperty' && !prop.computed && prop.value.type === 'Identifier') fields.set(prop.value.name, keyName(prop));
    }
    return fields;
  }

  // `map`, `flatMap`, `forEach` 에 넘긴 함수가 받는 항목에서, key 를 뺀 요소 속성에 값으로 넣는 field.
  // 항목은 첫 매개변수이거나, 첫 매개변수를 `([key, item])` 처럼 배열로 풀어 받은 둘째 이름이다.
  // 첫 매개변수를 `({ url })` 로 풀어 받았다면 그 키가 field 다.
  function itemFieldsRead(p: NodePath<JSXElement>): string[] {
    const fields = new Set<string>();
    for (const a of p.get('openingElement.attributes') as NodePath<any>[]) {
      if (!a.isJSXAttribute() || a.node.name.name === 'key' || !a.get('value').isJSXExpressionContainer()) continue;
      for (const x of piecesOf(a.get('value').get('expression') as NodePath)) {
        const field = loopItemField(x);
        if (field) fields.add(field);
      }
    }
    return [...fields];
  }

  function loopItemField(x: NodePath): string | null {
    const read = x.isMemberExpression() && !x.node.computed && x.get('object').isIdentifier() ? x.get('object') as NodePath<Identifier> : x.isIdentifier() ? x : null;
    const binding = read && x.scope.getBinding(read.node.name);
    const fn = binding?.kind === 'param' ? binding.scope.path : null;
    const method = fn && loopCallback(fn) ? (((fn.parent as CallExpression).callee as MemberExpression).property as Identifier).name : null;
    if (!fn || !method || method === 'reduce') return null;
    const first = (fn.get('params') as NodePath[])[0];
    if (read === x) return first.isObjectPattern() && first.node.properties.some((prop) => prop.type === 'ObjectProperty' && prop.value === binding!.identifier) ? itemFields(first).get(read.node.name) ?? null : null;
    const isItem = first.node === binding!.identifier || (first.isArrayPattern() && first.node.elements[1] === binding!.identifier);
    return isItem ? ((x.node as MemberExpression).property as Identifier).name : null;
  }

  // 배열을 순회하는 함수가 받는 항목에서 꺼낸 프로퍼티 하나(`item.url`, 또는 `({ url })` 로 구조 분해한 `url`)를 경로에 한 번 쓰는 라우트의 그 프로퍼티.
  function loopItem(route: NodePath, pathExpr: NodePath) {
    const fn = route.findParent(loopCallback);
    const param = fn && (fn.get('params') as NodePath[])[0];
    if (param?.isObjectPattern()) {
      const fields = itemFields(param);
      const reads = piecesOf(pathExpr).filter((x): x is NodePath<Identifier> => x.isIdentifier() && fields.has(x.node.name) && x.scope.getBinding(x.node.name)?.path.node === param.node);
      return reads.length === 1 ? { node: reads[0].node, field: fields.get(reads[0].node.name)! } : null;
    }
    if (!param?.isIdentifier()) return null;
    const { name } = param.node;
    const binding = fn!.scope.getBinding(name);
    const reads = piecesOf(pathExpr).filter((x): x is NodePath<MemberExpression> => x.isMemberExpression() && !x.node.computed && x.get('object').isIdentifier({ name }) && x.scope.getBinding(name) === binding);
    return reads.length === 1 ? { node: reads[0].node, field: (reads[0].node.property as Identifier).name } : null;
  }

  // 라우트가 렌더링하는 컴포넌트가 배열을 순회하는 함수가 받은 항목의 프로퍼티(`route.component`, 또는 `({ component: Page })` 로 구조 분해한 `Page`)이면, 항목에서 그 프로퍼티까지 가는 키 경로를 돌려준다.
  function drawnItemKeys(page: Page, scope: Scope, loop: NodePath | null = null): string[] | null {
    if (!page.component) return null;
    const [root, ...rest] = page.component.split('.');
    const binding = scope.getBinding(root);
    const fn = binding?.kind === 'param' ? binding.scope.path : null;
    if (!fn || !loopCallback(fn) || (loop && loop.node !== fn.node) || (fn.node as ArrowFunctionExpression).params[0] !== binding!.path.node) return null;
    if (binding!.path.isIdentifier()) return rest.length ? rest : null;
    const field = itemFields(binding!.path).get(root);
    return field && !rest.length ? [field] : null;
  }

  function packageImport(binding: Binding) {
    const spec = importedAs(binding)?.spec;
    if (!spec || spec.startsWith('.')) return false;
    const file = programFile.get(binding.scope.getProgramParent().block);
    return file !== undefined && imports.resolve(file, spec) === null;
  }

  function groupKind(p: NodePath<JSXElement>): 'switch' | 'routes' | null {
    const tag = tagOf(p.node.openingElement.name);
    const binding = tag ? p.scope.getBinding(tag) : undefined;
    if (tag === 'Switch') return !binding || routerImport(binding) || !packageImport(binding) || holdsRoutes(p, true) ? 'switch' : null;
    return routerImport(binding) && importedAs(binding!)!.name === 'Routes' ? 'routes' : null;
  }

  const drawsRoute = (e: NodePath<JSXElement>, redirects: boolean) => {
    const tag = tagOf(e.node.openingElement.name);
    return Boolean(tag) && (config.routeElements.includes(tag!) || (redirects && config.redirectElements.includes(tag!)) || groupKind(e) !== null);
  };
  const routeVisitor = (redirects: boolean, found: () => void) => ({
    JSXElement(e: NodePath<JSXElement>) {
      if (!drawsRoute(e, redirects)) return;
      found();
      e.stop();
    },
  });
  function holdsRouteElement(p: NodePath, redirects: boolean) {
    if (p.isJSXElement() && drawsRoute(p, redirects)) return true;
    let found = false;
    p.traverse(routeVisitor(redirects, () => (found = true)));
    return found;
  }
  const routesDrawnIn = new Map<string, boolean>();
  const drawsOwnRoutes = (file: string) => {
    if (!routesDrawnIn.has(file)) {
      let found = false;
      if (/\.(jsx?|tsx?)$/.test(file)) traverse(parse(file).ast, routeVisitor(false, () => (found = true)));
      routesDrawnIn.set(file, found);
    }
    return routesDrawnIn.get(file)!;
  };
  const framesPickingByAddress = new Map<string, { component: string; file: string; line: number; componentFile: string }>();

  // 함수 안에서 렌더링한 라우트는, 같은 파일에서 그 함수를 JSX 로 렌더링하거나 JSX 안에서 호출하는 곳에서도 상위로 거슬러 올라가 본다.
  function frameReader(absFile: string, routeFile: string, src: string, note: Note) {
    const besideAt = new Map<Node, Map<Node, FrameFile[]>>();
    const drawnFrom = new Map<Node, FrameFile[] | null>();
    const besideIn = (child: NodePath, at: NodePath): FrameFile[] => {
      const found: FrameFile[] = [];
      const take = (e: NodePath<JSXElement>) => {
        const tag = tagOf(e.node.openingElement.name);
        const file = tag && resolveTag(e.scope, tag, absFile);
        if (!file || routeFileSet.has(file)) return;
        const line = e.node.loc!.start.line;
        if (drawsOwnRoutes(file)) {
          framesPickingByAddress.set(`${routeFile}:${line}`, { component: tag!, file: routeFile, line, componentFile: file });
          return;
        }
        const guards = guardsOf(e, src, note, undefined, at.node);
        found.push({ file, under: guards.length ? { via: tag!, line, file: routeFile, guards } : null });
      };
      if (child.isJSXElement()) take(child);
      child.traverse({
        JSXAttribute(x) {
          x.skip();
        },
        JSXElement: take,
      });
      return found;
    };
    const localRoutes = (binding: Binding | undefined) => {
      const declared = binding?.path.isVariableDeclarator() ? (binding.path.get('init') as NodePath) : binding?.path;
      return Boolean(declared?.node) && (declared!.isFunction() || declared!.isClass()) && holdsRouteElement(declared!, true);
    };
    const drawsRouteFile = (e: NodePath<JSXElement>) => {
      const tag = tagOf(e.node.openingElement.name);
      const file = tag && resolveTag(e.scope, tag, absFile);
      if (!file || !routeFileSet.has(file)) return false;
      return file !== absFile || localRoutes(e.scope.getBinding(tag!.split('.')[0]));
    };
    const holdsRoutes = (c: NodePath) => {
      if (holdsRouteElement(c, true) || (c.isJSXElement() && drawsRouteFile(c))) return true;
      let found = false;
      const stop = (x: NodePath) => {
        found = true;
        x.stop();
      };
      c.traverse({
        JSXElement(e) {
          if (drawsRouteFile(e)) stop(e);
        },
        CallExpression(call) {
          const callee = call.get('callee');
          if (callee.isIdentifier() && localRoutes(callee.scope.getBinding(callee.node.name))) stop(call);
        },
      });
      return found;
    };
    const besideOf = (at: NodePath, on: NodePath) => {
      if (!besideAt.has(at.node)) besideAt.set(at.node, new Map());
      const known = besideAt.get(at.node)!;
      if (!known.has(on.node)) known.set(on.node, (at.get('children') as NodePath[]).flatMap((c) => (c.node === on.node || holdsRoutes(c) ? [] : besideIn(c, at))));
      return known.get(on.node)!;
    };
    const drawnAt = (fn: NodePath): NodePath[] => {
      const id = fn.isFunctionDeclaration() ? fn.node.id : fn.parentPath?.isVariableDeclarator() && fn.key === 'init' ? fn.parentPath.node.id : null;
      if (id?.type !== 'Identifier') return [];
      return (fn.parentPath!.scope.getBinding(id.name)?.referencePaths ?? []).flatMap((r) => {
        const up = r.parentPath!;
        if (up.isJSXOpeningElement() && r.key === 'name') return [up.parentPath!];
        return up.isCallExpression() && r.key === 'callee' && up.parentPath?.isJSXExpressionContainer() ? [up] : [];
      });
    };
    const climb = (from: NodePath, stop: Node | null = null, seenFns = new Set<Node>()) => {
      const wrappers: string[] = [];
      const frame: FrameFile[] = [];
      for (let on = from, a = from.parentPath; a && a.node !== stop; on = a, a = a.parentPath) {
        const tag = a.isJSXElement() && tagOf(a.node.openingElement.name);
        const file = tag && resolveTag(a.scope, tag, absFile);
        if (file) wrappers.push(file);
        if ((a.isJSXElement() || a.isJSXFragment()) && on.listKey === 'children' && !(a.isJSXElement() && groupKind(a))) frame.push(...besideOf(a, on));
        if (a.isFunction()) frame.push(...drawnFromCalls(a));
        for (const fn of a.isJSXElement() ? layoutFunctions(a) : []) {
          if (seenFns.has(fn.node) || from.isDescendant(fn)) continue;
          seenFns.add(fn.node);
          const param = fn.get('params')[0];
          if (!param?.isIdentifier()) continue;
          for (const drawn of fn.scope.getBinding(param.node.name)?.referencePaths ?? []) {
            if (!drawnAsChild(drawn)) continue;
            const inside = climb(drawn, fn.node, seenFns);
            wrappers.push(...inside.wrappers);
            frame.push(...inside.frame);
          }
        }
      }
      return { wrappers, frame };
    };
    const drawnFromCalls = (fn: NodePath) => {
      if (!drawnFrom.has(fn.node)) {
        drawnFrom.set(fn.node, null);
        drawnFrom.set(fn.node, drawnAt(fn).flatMap((at) => {
          const { wrappers, frame } = climb(at);
          return [...wrappers.filter((f) => !routeFileSet.has(f)).map((file) => ({ file, under: null })), ...frame];
        }));
      }
      return drawnFrom.get(fn.node) ?? [];
    };
    return { of: climb };
  }

  const drawnAsChild = (ref: NodePath) => ref.parentPath!.isJSXExpressionContainer() && (ref.parentPath!.parentPath!.isJSXElement() || ref.parentPath!.parentPath!.isJSXFragment());

  function layoutFunctions(element: NodePath<JSXElement>) {
    return element.get('openingElement.attributes').flatMap((attr) => {
      const value = attr.isJSXAttribute() ? attr.get('value') : null;
      const written = value?.isJSXExpressionContainer() ? (value.get('expression') as NodePath) : null;
      const fn = functionAt(written?.isIdentifier() ? written.scope.getBinding(written.node.name)?.path : written);
      return fn ? [fn] : [];
    });
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

  function renderPage(renderAttr: NodePath<JSXAttribute>, routesFile: string, takesItem: boolean): Page | typeof REDIRECT | string | null {
    const value = renderAttr.get('value');
    const fn = value.isJSXExpressionContainer() ? (value.get('expression') as NodePath) : null;
    if (!fn?.isArrowFunctionExpression() && !fn?.isFunctionExpression()) return 'render is not a function written in the route';
    const element = onlyReturned(fn);
    if (element?.isJSXElement() && holdsValue(element)) return null;
    const page = element?.isJSXElement() ? pageOf(element, routesFile) : null;
    if (isPage(page) && !isAppScreen(page, renderAttr.scope) && !(takesItem && drawnItemKeys(page, renderAttr.scope))) return null;
    return page ?? 'render does not return one component';
  }

  function childrenPage(route: NodePath<JSXElement>, routesFile: string, takesItem: boolean): Page | typeof REDIRECT | string | null {
    if (holdsValue(route)) return null;
    const read = route.get('children').flatMap(elementsIn).map((e) => pageOf(e, routesFile));
    if (!read.length) return null;
    const pages = read.filter(isPage);
    const screens = pages.filter((c) => isAppScreen(c, route.scope) || (takesItem && drawnItemKeys(c, route.scope)));
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
    const outers = new Map<number, string>();
    const filling = new Set<number>();
    const behind = (outer: string, rest: string) => outer.replace(/\/$/, '') + rest || '/';
    const addressOf = (i: number): string => {
      const { s, outerFill } = sourced[i];
      if (!outerFill.startsWithOuterAddress || filling.has(i)) return s.path;
      if (!filled.has(i)) {
        filling.add(i);
        const rest = s.path.slice(UNKNOWN.length);
        const outer = joinedPaths([...new Set(outersOf(i).map(addressOf))], rest);
        filling.delete(i);
        if (outer !== null) outers.set(i, outer);
        filled.set(i, outer === null ? s.path : behind(outer, rest));
      }
      return filled.get(i)!;
    };
    sourced.forEach((x, i) => {
      const address = addressOf(i);
      const { unreadPath } = x.outerFill;
      if (address === x.s.path) return;
      x.s.path = address;
      if (!unreadPath) return;
      const outer = outers.get(i)!;
      const paths = unreadPath.entry.paths?.map((p) => (p.startsWith(UNKNOWN) ? behind(outer, p.slice(UNKNOWN.length)) : p));
      if (address.includes(UNKNOWN)) Object.assign(unreadPath.entry, { path: address, stoppedAt: unreadPath.restStoppedAt ?? unreadPath.entry.stoppedAt, ...(paths && { paths }) });
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
    const holders = new Map<string, { frame: FrameFile[]; from: string }[]>();
    let around: string[] = [];
    const convert = (n: DrawnNode, file: string, base = ''): RouteNode[] => {
      const nodes = convertNode(n, file, base);
      for (const node of nodes) if (n.when && node.kind !== 'redirect') node.when = n.when;
      return nodes;
    };
    const convertNode = (n: DrawnNode, file: string, base: string): RouteNode[] => {
      if (n.kind === 'routes') {
        const branches: Branch[] = [];
        const unwrapped = (nodes: DrawnNode[]): DrawnNode[] => nodes.flatMap((c) => (c.isFragment ? unwrapped(c.children) : [c]));
        const indexes: string[] = [];
        const flatten = (routes: DrawnNode[], outerPath: string, chain: Branch['chain']) => {
          for (const r of unwrapped(routes).filter((c) => c.isRoute)) {
            const drawnBy = unwrapped(r.children).filter((c) => !c.isRoute && (c.kind !== 'redirect' || c.redirectAsElement));
            const leaf = drawnBy.length === unwrapped(r.children).length;
            for (const node of convert({ ...r, children: drawnBy }, file, outerPath) as Branch['chain']) {
              const own = node.path === null ? null : node.path.startsWith('/') ? node.path : `${outerPath}/${node.path}`.replace(/\/{2,}/g, '/');
              flatten(r.children, own ?? outerPath, [...chain, node]);
              if (own !== null) branches.push({ path: own, chain: [...chain, node] });
              else if (leaf) indexes.push(outerPath);
            }
          }
        };
        flatten(n.children, base, []);
        return [{ kind: 'routes', branches, indexes }];
      }
      if (n.kind === 'switch') return [{ kind: 'switch', children: n.children.flatMap((c) => convert(c, file, base)) }];
      if (n.kind === 'redirect') return [{ kind: 'redirect', from: n.from, exact: n.exact, to: n.to }];
      const byPath = new Map<string, { routePath: string | null; itemValue: boolean | null | undefined; screens: number[] }>();
      for (const i of n.screens.map((s) => indexOf.get(s)!)) {
        const itemValue = itemExact.get(extracted[i]);
        const key = JSON.stringify([sourced[i].s.path, itemValue]);
        if (!byPath.has(key)) byPath.set(key, { routePath: sourced[i].s.path, itemValue, screens: [] });
        byPath.get(key)!.screens.push(i);
      }
      if (!byPath.size) byPath.set('', { routePath: n.path, itemValue: undefined, screens: [] });
      return [...byPath.values()].map(({ routePath, itemValue, screens }) => {
        const entries = screens.length ? screens.flatMap((i) => sourced[i].s.componentFile ?? []) : n.entry ? [n.entry] : [];
        const full = routePath === null || routePath.startsWith('/') ? routePath : `${base}/${routePath}`.replace(/\/{2,}/g, '/');
        const inner = full === null ? base : full.endsWith('/*') ? full.slice(0, -2) : '';
        const fromItem = typeof itemValue === 'boolean';
        const node = { kind: 'route' as const, path: routePath, exact: fromItem ? itemValue : n.exact, exactUnread: fromItem ? false : n.exactUnread, screens, children: n.children.flatMap((c) => convert(c, file, inner)) };
        const held = heldFiles(entries, file);
        if (held.length) holding.set(node, { files: held, base: inner, around });
        const frame = screens.length ? screens.flatMap((i) => [...extracted[i].wrapperFiles.map((f) => ({ file: f, under: null })), ...extracted[i].frameFiles]) : n.frame?.() ?? [];
        for (const f of held) holders.set(f, [...(holders.get(f) ?? []), { frame, from: file }]);
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
    const framesOf = (f: string, outer: Set<string> = new Set()): FrameFile[] => {
      if (outer.has(f)) return [];
      const around = new Set([...outer, f]);
      const found = (holders.get(f) ?? []).flatMap(({ frame, from }) => [...frame, ...framesOf(from, around)]);
      return found.filter((e) => e.file !== f && !routeFileSet.has(e.file) && !closure(e.file).has(f));
    };
    return { roots: roots.length ? roots : rootsOf.get(drawn[0].file)!, framesOf };
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
  const moduleExports = new Map<string, { file: string; exportName: string }[]>();
  for (const f of apiModuleFiles) {
    const fns = extractApiModule(f);
    Object.assign(apiFunctions, fns);
    for (const name of Object.keys(fns)) moduleExports.set(name, [{ file: f, exportName: name }]);
  }
  if (calledFiles.size) called = await recordApiCalls(config, imports.resolve, new Set(Object.keys(apiFunctions)));
  Object.assign(apiFunctions, called?.functions);

  const routeValues = lookupConstant(constants, routeChain) ?? {};
  const rel = (f: string | null | undefined) => (f ? path.relative(config.srcRoot, f) : null);

  if (!config.routeFiles.length) throw new Error(`the config has no routesFile, which takes ${ROUTES_FILE}`);
  const drawn = (config.routeFiles as string[]).map((f) => ({ file: path.join(config.srcRoot, f), ...extractScreens(f) }));
  const extracted = drawn.flatMap((d) => d.screens);
  const emptyRouteFiles = (config.routeFiles as string[]).filter((_, i) => !drawn[i].hasRoutes);
  const screenFiles = new Set(extracted.map((s) => s.componentFile).filter(Boolean));
  const sourced = extracted.map(({ wrapperFiles, frameFiles, outerFill, ...s }) => {
    const entryFiles = [s.componentFile, ...wrapperFiles].filter(Boolean) as string[];
    const isOtherScreen = (f: string) => screenFiles.has(f) && !entryFiles.includes(f);
    return { s, outerFill, frameFiles, entryFiles, isOtherScreen, files: [...new Set(entryFiles.flatMap((f) => closureOf(f, isOtherScreen)))], drawnUnder: [] as { file: string; unders: Required<InheritedGuard>[] }[], drawnFiles: new Map<string, Required<InheritedGuard>[]>() };
  });
  fillOuterAddresses(sourced);
  const { roots: routeRoots, framesOf } = routeTree(drawn, extracted, sourced);
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
    const frameClosure = (f: string) => closureOf(f, x.isOtherScreen, routeFileSet);
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

  const members = typedMembers(config.tsconfig, [...new Set([...sourced.flatMap((x) => x.files), ...appWideFiles])], imports.resolve);
  const heldRouteFiles = new Set(sourced.flatMap((x) => x.files).filter((f) => routeFileSet.has(f)));
  const screenFollower = members ? nameFollower<FollowedSite>({ parse, resolve: imports.resolve, sitesOf, members }) : follower;
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
    const links: (Site & { route?: string; to: unknown; tail?: string; reaches?: number[]; tableItem?: TableItem; file: string | null; actions?: DispatchedActions })[] = [];
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
        if (!seen(ref) || (exportedKeys.has(ref as RouteRef) && lookedUpElsewhere(exportedKeys.get(ref as RouteRef)!))) continue;
        if ('menu' in ref) {
          for (const link of itemLinks(ref as MenuElement)) links.push(drawnWith({ ...link, file: rel(f) }, onlyDrawn.get(ref)));
          continue;
        }
        ownLinks.add(ref);
        const link = screenLink(ref, index);
        if (link) links.push(drawnWith({ ...link, file: rel(f) }, onlyDrawn.get(ref)));
      }
    }
    // 라우트 파일 본문에서 옮기는 것은 그 파일이 그리는 화면 어디서나 일어난다.
    const drawnBy = path.join(config.srcRoot, s.routeFile);
    for (const site of heldRouteFiles.has(drawnBy) ? [] : linkSites(fileFacts(drawnBy))) {
      if (!movedTo.has(site) || ownLinks.has(site)) continue;
      ownLinks.add(site);
      const link = screenLink(site, index);
      if (link) links.push({ ...link, file: rel(drawnBy) });
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
    const sagaLinks = [...movedBySaga].flatMap(([ref, actions]) => {
      const link = screenLink(ref, index);
      return link ? [{ ...link, file: rel(siteFile.get(ref)), actions: byType(actions) }] : [];
    });
    sagaLinks.sort((a, b) => compare(a.file, b.file) || a.line - b.line);
    links.push(...sagaLinks);
    const sent: typeof apiCalls = [...apiCalls, ...sagaCalls];
    return { ...s, componentFile: rel(s.componentFile), closureSize: files.length, sourceFiles: files.map(rel).sort(), apiCalls: sent, settingReads, links };
  });

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
  return { screens, appWide, apiFunctions, unreferencedApiFunctions, sagaRuns, unrunApiModules: called?.failedModules ?? null, outsideStandIns: called?.outsideStandIns ?? [], silentApiModules: called?.silentModules ?? [], bodyTypeNotices: called?.bodyTypeNotices.length ? called.bodyTypeNotices : null, redirects, unreadRoutePaths, unreadRoutes, guardInits, constants, guardSettings, settingsDefaults, settingsDefaultsIncomplete, settingsCallNotices, unresolvedAliasImports: imports.unresolved(), unusedListed: listedComponents.length + listedFunctions.length ? [...listedComponents, ...listedFunctions].filter((e) => !usedListed.has(e)).map((e) => `${e.key} ${e.import} ${e.name}`) : null, madeHistories: [...madeHistories].sort(([a], [b]) => compare(a, b)).map(([file, call]) => ({ file, call })), emptyRouteFiles, takingAddressesUnder: screensTakingAddressesUnder(routeRoots, sourced.map((x) => x.s.path)), framesPickingByAddress: [...framesPickingByAddress.values()].map((f) => ({ ...f, componentFile: rel(f.componentFile)! })).sort((a, b) => compare(a.file, b.file) || a.line - b.line) };
}
