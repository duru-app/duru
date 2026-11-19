import fs from 'node:fs';
import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath, Scope } from '@babel/traverse';
import type { ArrayExpression, ArrowFunctionExpression, CallExpression, FunctionDeclaration, FunctionExpression, Identifier, ImportDeclaration, JSXAttribute, JSXElement, MemberExpression, Node, ObjectExpression, ObjectProperty } from '@babel/types';
import type { Branch, RouteNode, Side } from './access.ts';
import { addressReader, MOST_ADDRESSES, UNREADABLE_PIECE } from './address-functions.ts';
import type { AddressFunction } from './address-functions.ts';
import { guardsOf, keyName, memberChain, sliceText, UNKNOWN } from './client.ts';
import type { InheritedGuard, Note, RouteTable, TableItem } from './client.ts';
import type { clientLinkReader } from './client-links.ts';
import type { guardConditionReader } from './guard-conditions.ts';
import { parseSource } from './parse.ts';
import { joinRoutePath } from './path-values.ts';
import { importedAs, routerImport } from './screen-requests.ts';
import type { sourceValueReader } from './source-values.ts';

type SourceValues = Awaited<ReturnType<typeof sourceValueReader>>;
type GuardConditions = ReturnType<typeof guardConditionReader>;
type ClientLinks = ReturnType<typeof clientLinkReader>;

interface Reading
  extends Pick<SourceValues, 'components' | 'apiModuleFiles' | 'constantModuleFiles' | 'settingsRoots' | 'routeTables' | 'tableRoutes' | 'routeFileSet' | 'programFile' | 'parse' | 'declaredValue' | 'namespaceMember' | 'textOf' | 'evaluate' | 'lossless' | 'attributeValue' | 'literalAt' | 'fileOf' | 'keysInOrder' | 'propertiesOf' | 'propertyValue' | 'keyedValue' | 'declaredFunction' | 'functionAt' | 'namespaceFunction' | 'declaredClass' | 'loopCallback' | 'tagOf' | 'unwrapCalls' | 'rel'>,
    Pick<GuardConditions, 'tableLiteral' | 'guardNote'>,
    Pick<ClientLinks, 'passThrough' | 'oneAddress'> {
  config: any;
  resolve: (fromFile: string, spec: string) => string | null;
  closureOf: (entryFile: string, isOtherScreen: (f: string) => boolean, cut?: Set<string>) => string[];
  // 화면의 컴포넌트 파일은 라우트 파일을 모두 읽은 뒤에 정해지므로 읽을 때마다 받아 온다.
  screenFiles: () => Set<string | null | undefined>;
}

interface Page {
  component: string;
  componentFile: string | null | undefined;
  files: string[];
}

// under 는 컴포넌트를 렌더링한 위치에 걸린 조건이다. 조건 없이 렌더링했으면 null 이다.
export interface FrameFile {
  file: string;
  under: Required<InheritedGuard> | null;
}

export interface RouteScreen {
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
  componentInRouteFile?: true;
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
  // component= 로 리다이렉트만 하는 컴포넌트를 그리는 라우트가 보내는 주소
  componentRedirect?: string;
  when: Side | null;
  children: DrawnNode[];
  frame?: () => FrameFile[];
}

type StoppedAt = { text: string; file: string | null; line: number };
type UnreadRoutePath = { file: string; line: number; path: string; stoppedAt: StoppedAt; paths?: string[]; manyPaths?: true };

interface OuterFill {
  startsWithOuterAddress: boolean;
  // 자기 파일에서 어느 라우트 안에도 없는 상대 경로다. 다른 라우트 파일의 화면이 이 라우트 파일을 렌더링하지 않으면 / 기준으로 해석한다.
  atTopOfRoutes: boolean;
  unreadPath: { entry: UnreadRoutePath; restStoppedAt: StoppedAt | null } | null;
}

const traverse = _traverse.default ?? _traverse;

export function clientRouteReader({
  config, resolve, closureOf, screenFiles,
  components, apiModuleFiles, constantModuleFiles, settingsRoots, routeTables, tableRoutes, routeFileSet, programFile, parse, declaredValue, namespaceMember, textOf, evaluate, lossless,
  attributeValue, literalAt, fileOf, keysInOrder, propertiesOf, propertyValue, keyedValue, declaredFunction, functionAt, namespaceFunction, declaredClass, loopCallback, tagOf, unwrapCalls, rel,
  tableLiteral, guardNote,
  passThrough, oneAddress,
}: Reading) {
  // 라우트가 exact 를 라우트 테이블 항목에서 읽는 화면마다 그 항목의 exact. 읽지 못했으면 null 이다.
  const itemExact = new Map<RouteScreen, boolean | null>();
  const redirects: { to: string; file: string; line: number; guards: string[] }[] = [];
  const topRedirects = new Set<(typeof redirects)[number]>();
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

  // 주소 함수가 돌려준 갈래 가운데 쿼리를 붙이는 것과, 고정된 세그먼트가 있는 갈래 옆에서 경로 변수만 남은 것은 경로가 아니다.
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

  function isReactFragment(p: NodePath<JSXElement>) {
    const tag = tagOf(p.node.openingElement.name);
    const reactAs = (b: Binding | undefined) => {
      const from = b && importedAs(b);
      return from?.spec === 'react' ? from.name : null;
    };
    return tag === 'Fragment' ? reactAs(p.scope.getBinding(tag)) === 'Fragment' : tag === 'React.Fragment' && ['default', '*'].includes(reactAs(p.scope.getBinding('React')) ?? '');
  }

  // 라우트의 children 에 적힌 라우트만 그 라우트 안에 있다. element 나 render 안의 라우트는 그 라우트가 렌더링하는 다른 Routes 의 것이다.
  function routeAround(p: NodePath<JSXElement>): NodePath<JSXElement> | null {
    let up: NodePath | null = p.parentPath;
    while (up && !up.isJSXElement()) {
      if (up.isJSXAttribute()) return null;
      up = up.parentPath;
    }
    if (!up) return null;
    if (isReactFragment(up as NodePath<JSXElement>)) return routeAround(up as NodePath<JSXElement>);
    const tag = tagOf((up.node as JSXElement).openingElement.name);
    return tag && config.routeElements.includes(tag) ? up as NodePath<JSXElement> : null;
  }

  type JoinedPath = { path: string; stops: NodePath[]; lead: NodePath };
  const outerRoutes = new Map<Node, JoinedPath | null>();
  function outerRoutePath(route: NodePath<JSXElement>): JoinedPath | null {
    if (!outerRoutes.has(route.node)) {
      const parent = routeAround(route);
      const at = parent && attributeValue(parent, 'path');
      outerRoutes.set(route.node, !parent ? null : at ? joinedRoutePath(parent, readRoutePath(at), at) : outerRoutePath(parent));
    }
    return outerRoutes.get(route.node)!;
  }

  // lead 는 경로의 첫 세그먼트가 적힌 곳이다.
  function joinedRoutePath<T extends { path: string; stops: NodePath[]; paths?: string[] }>(route: NodePath<JSXElement>, read: T, at: NodePath): T & { lead: NodePath } {
    const outer = read.path.startsWith('/') || read.path.startsWith(UNKNOWN) ? null : outerRoutePath(route);
    if (!outer) return { ...read, lead: at };
    const paths = read.paths?.map((p) => joinRoutePath(outer.path, p));
    return { ...read, path: joinRoutePath(outer.path, read.path), stops: [...outer.stops, ...read.stops], lead: outer.lead, ...(paths && { paths }) };
  }

  function atTopOfRoutes(routePath: string, route: NodePath<JSXElement>) {
    if (routePath.startsWith('/') || routePath.startsWith(UNKNOWN) || routePath === '*') return false;
    let top = route;
    for (let up = routeAround(top); up; up = routeAround(top)) top = up;
    // 함수가 돌려주는 라우트처럼 Routes 밖에 있으면 그 함수를 부르는 쪽의 라우트 아래에 놓일 수 있다.
    let group: NodePath | null = top.parentPath;
    while (group && !(group.isJSXElement() && !isReactFragment(group as NodePath<JSXElement>))) {
      if (group.isJSXAttribute()) return false;
      group = group.parentPath;
    }
    return Boolean(group) && groupKind(group as NodePath<JSXElement>) === 'routes'
      && !group!.findParent((up) => up.isJSXElement() && config.routeElements.includes(tagOf(up.node.openingElement.name) ?? ''));
  }

  function redirectTarget(p: NodePath<JSXElement>) {
    const toExpr = attributeValue(p, 'to') ?? null;
    const written = toExpr ? evaluate(toExpr) : undefined;
    const read = typeof written === 'string' && !written.includes(UNKNOWN) ? written : toExpr ? oneAddress(toExpr) : UNKNOWN;
    return read === UNKNOWN && typeof written === 'string' ? written : read;
  }

  // 라우트 파일의 리다이렉트는 그 파일을 읽을 때 두므로, 다른 파일에 선언된 컴포넌트의 리다이렉트만 둔다.
  const importedRedirects = new WeakSet<Node>();
  function addImportedRedirects(reached: NodePath<JSXElement>[]) {
    for (const p of reached) {
      const file = programFile.get(p.scope.getProgramParent().block);
      if (!file || routeFileSet.has(file) || importedRedirects.has(p.node)) continue;
      importedRedirects.add(p.node);
      const { src } = parse(file);
      const relFile = path.relative(config.srcRoot, file);
      redirects.push({ to: redirectTarget(p), file: relFile, line: p.node.loc!.start.line, guards: guardsOf(p, src, guardNote(relFile, src)) });
    }
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
          const to = redirectTarget(p);
          const holder = p.parentPath.isJSXExpressionContainer() ? p.parentPath.parentPath : null;
          const route = holder?.isJSXAttribute() && holder.node.name.name === 'element' ? holder.parentPath.parentPath as NodePath<JSXElement> : null;
          const routeAt = route && config.routeElements.includes(tagOf(route.node.openingElement.name) ?? '') && !/^[/.]|[{:]/.test(to) ? route : null;
          const at = routeAt && attributeValue(routeAt, 'path');
          const outer = routeAt && (at ? joinedRoutePath(routeAt, readRoutePath(at), at) : outerRoutePath(routeAt));
          const base = outer?.path.replace(/(^|\/)\*$/, '');
          const redirect = { to: base ? joinRoutePath(base, to) : to, file: routeFile, line: p.node.loc!.start.line, guards: guardsOf(p, src, note) };
          redirects.push(redirect);
          if (routeAt && atTopOfRoutes(redirect.to, routeAt)) topRedirects.add(redirect);
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
        if (compAttr) {
          const drawn = componentAttrPage(compAttr, absFile);
          if (drawn === REDIRECT) return;
          page = drawn;
        } else if (elementAttr) page = elementPage(elementAttr, absFile);
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
        const madeHere = !page.componentFile && Boolean(page.component) && components.find(p.scope, page.component, absFile).madeHere;
        const { wrappers, frame } = frames.of(p);
        const wrapperFiles = [...page.files, ...wrappers];
        const grouped = Boolean(p.findParent((up) => up.isJSXElement() && ['Switch', 'Routes'].includes(tagOf(up.node.openingElement.name) ?? '')));
        const made: RouteScreen[] = [];
        for (const onePath of pathsIn(pathExpr)) {
          const { path: routePath, stops, lead, ...gives } = joinedRoutePath(p, readRoutePath(onePath), onePath);
          if (!routePath.includes(UNKNOWN) && made.some((m) => m.path === routePath)) continue;
          let unreadPath: OuterFill['unreadPath'] = null;
          const outerAddress = routePath.startsWith(UNKNOWN) ? leadingPiece(lead) : null;
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
            outerFill: { startsWithOuterAddress: Boolean(outerAddress) && readsMatchedRoute(outerAddress!), atTopOfRoutes: atTopOfRoutes(routePath, p), unreadPath },
            ...(madeHere && { componentInRouteFile: true as const }),
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

  const isElementAttribute = (p: NodePath<JSXElement>) => {
    const holder = p.parentPath.isJSXExpressionContainer() ? p.parentPath.parentPath : null;
    return Boolean(holder?.isJSXAttribute() && holder.node.name.name === 'element');
  };

  const forwarding = (reached: NodePath<JSXElement>[]) => {
    const [only, ...more] = reached;
    const to = more.length ? null : attributeValue(only, 'to');
    return { kind: 'redirect' as const, to: to ? oneAddress(to) : UNKNOWN, redirectAsElement: true };
  };

  function drawnTree(ast: ReturnType<typeof parseSource>['ast'], absFile: string, elementScreens: Map<Node, RouteScreen[]>, frames: ReturnType<typeof frameReader>) {
    const nodes = new Map<Node, DrawnNode>();
    const roots: DrawnNode[] = [];
    traverse(ast, {
      JSXElement(p) {
        const tag = tagOf(p.node.openingElement.name);
        if (!tag || definesRouteElement(p)) return;
        const attr = (name: string) => attributeValue(p, name);
        const exact = attr('exact');
        const exactValue = exact ? evaluate(exact) : undefined;
        const text = (p: NodePath | undefined | null) => (p ? readRoutePath(p).path : UNKNOWN);
        const node: DrawnNode = { kind: 'route', path: null, exact: exact === null || exactValue === true, exactUnread: Boolean(exact) && typeof exactValue !== 'boolean', from: null, to: UNKNOWN, screens: elementScreens.get(p.node) ?? [], entry: null, isRoute: false, isFragment: false, redirectAsElement: false, when: drawnSide(p), children: [] };
        node.isFragment = isReactFragment(p);
        const group = groupKind(p);
        const redirectsAsElement = componentTag(tag) && isElementAttribute(p) ? redirectsReturned(p.scope, tag) : null;
        if (group) node.kind = group;
        else if (config.redirectElements.includes(tag)) {
          const from = attr('from');
          const to = attr('to');
          Object.assign(node, { kind: 'redirect', from: from === undefined ? null : text(from), to: to ? oneAddress(to) : UNKNOWN, redirectAsElement: isElementAttribute(p) });
        } else if (redirectsAsElement) {
          Object.assign(node, forwarding(redirectsAsElement));
        } else if (config.routeElements.includes(tag)) {
          const at = attr('path');
          node.isRoute = true;
          node.path = node.screens.length ? node.screens[0].path : at === undefined ? null : at ? joinedRoutePath(p, readRoutePath(at), at).path : UNKNOWN;
          const component = unwrapCalls(attr('component') ?? undefined);
          const reached = component?.isIdentifier() ? redirectsReturned(component.scope, component.node.name) : null;
          if (reached) node.componentRedirect = forwarding(reached).to;
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
          outerFill: { startsWithOuterAddress: Boolean(outerAddress) && readsMatchedRoute(outerAddress!), atTopOfRoutes: false, unreadPath },
        };
        if (exactField) itemExact.set(screen, exact);
        return screen;
      });
    });
  }

  // 마지막에 적힌 field 뒤에 읽지 못한 spread 나 computed key 가 있으면 값을 모른다.
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

  const onlyRedirects = (expr: NodePath) => Boolean(expr.isIdentifier() && redirectsReturned(expr.scope, expr.node.name));
  const componentTag = (tag: string | null): tag is string => Boolean(tag) && /^[A-Z]/.test(tag!) && !tag!.includes('.');

  // 함수 컴포넌트가 돌려주는 값이 모두 다른 주소로 보내는 요소이거나 그런 컴포넌트일 때, 끝까지 따라가 닿는 그 요소들. 다른 파일에 있으면 그 파일의 선언을 읽는다.
  function redirectsReturned(scope: Scope, name: string, seen = new Set<Node>()): NodePath<JSXElement>[] | null {
    const fn = declaredFunction(scope, name);
    const values = fn && !seen.has(fn.node) ? returnedElements(fn) : null;
    if (!values) return null;
    const reached: NodePath<JSXElement>[] = [];
    const inner = new Set(seen).add(fn!.node);
    for (const value of values) {
      const tag = tagOf(value.node.openingElement.name)!;
      const through = config.redirectElements.includes(tag) ? [value] : redirectsReturned(value.scope, tag, inner);
      if (!through) return null;
      reached.push(...through);
    }
    return reached;
  }

  const bothSides = (p: NodePath): NodePath[] => (p.isConditionalExpression() ? [...bothSides(p.get('consequent')), ...bothSides(p.get('alternate'))] : [p]);
  const redirectOrComponent = (p: NodePath): p is NodePath<JSXElement> => {
    const tag = p.isJSXElement() ? tagOf(p.node.openingElement.name) : null;
    return Boolean(tag) && (config.redirectElements.includes(tag!) || componentTag(tag));
  };

  // 함수 안의 함수를 빼고 return 마다 돌려주는 요소. 리다이렉트 요소나 컴포넌트가 아닌 값을 돌려줄 수 있으면 null 이다.
  // return 없이 본문 끝까지 가는 경로와 값 없는 return 은 undefined 를 돌려준다.
  function returnedElements(fn: AddressFunction): NodePath<JSXElement>[] | null {
    const body = fn.get('body') as NodePath;
    const elementsOf = (p: NodePath | null) => {
      const sides = p?.node ? bothSides(p) : [];
      return sides.length && sides.every(redirectOrComponent) ? sides : null;
    };
    if (!body.isBlockStatement()) return elementsOf(body);
    if (!endsInReturn(body)) return null;
    let found: NodePath<JSXElement>[] | null = [];
    body.traverse({
      Function: (p) => p.skip(),
      ReturnStatement(p) {
        const sides = elementsOf(p.get('argument') as NodePath);
        if (sides) found!.push(...sides);
        else {
          found = null;
          p.stop();
        }
      },
    });
    return found;
  }

  function endsInReturn(statement: NodePath): boolean {
    if (statement.isReturnStatement()) return true;
    if (statement.isBlockStatement()) {
      const last = statement.get('body').at(-1);
      return Boolean(last) && endsInReturn(last!);
    }
    return statement.isIfStatement() && Boolean(statement.node.alternate) && endsInReturn(statement.get('consequent')) && endsInReturn(statement.get('alternate') as NodePath);
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
  // 요소를 감싼 가장 가까운 반복 함수의 항목만 센다. 사이에 반복이 아닌 함수가 있어도 된다.
  // 항목은 첫 매개변수이거나, 첫 매개변수를 `([key, item])` 처럼 배열로 풀어 받은 둘째 이름이다.
  // 첫 매개변수를 `({ url })` 로 풀어 받았다면 그 키가 field 다.
  function itemFieldsRead(p: NodePath<JSXElement>): string[] {
    const fields = new Set<string>();
    const loop = p.findParent(loopCallback);
    for (const a of p.get('openingElement.attributes') as NodePath<any>[]) {
      if (!a.isJSXAttribute() || a.node.name.name === 'key' || !a.get('value').isJSXExpressionContainer()) continue;
      for (const x of piecesOf(a.get('value').get('expression') as NodePath)) {
        const field = loop && loopItemField(x, loop.node);
        if (field) fields.add(field);
      }
    }
    return [...fields];
  }

  function loopItemField(x: NodePath, loop: Node): string | null {
    const read = x.isMemberExpression() && !x.node.computed && x.get('object').isIdentifier() ? x.get('object') as NodePath<Identifier> : x.isIdentifier() ? x : null;
    const binding = read && x.scope.getBinding(read.node.name);
    const fn = binding?.kind === 'param' && binding.scope.path.node === loop ? binding.scope.path : null;
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
    return file !== undefined && resolve(file, spec) === null;
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
        if (tag && config.routeElements.includes(tag) && on.listKey === 'children') wrappers.push(...routeElementFiles(a as NodePath<JSXElement>));
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
    const routeElementFiles = (route: NodePath<JSXElement>) => {
      const attr = (name: string) => route.get('openingElement.attributes').find((x) => x.isJSXAttribute() && x.node.name.name === name) as NodePath<JSXAttribute> | undefined;
      const compAttr = attr('component');
      const page = compAttr ? componentAttrPage(compAttr, absFile) : elementPage(attr('element'), absFile);
      return isPage(page) ? [page.componentFile, ...page.files].filter((f): f is string => Boolean(f)) : [];
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

  const resolveTag = (scope: Scope, tag: string, fromFile: string) => components.find(scope, tag, fromFile).file;
  const fromPackage = (scope: Scope, tag: string, fromFile: string) => {
    const binding = scope.getBinding(tag.split('.')[0]);
    return binding?.kind === 'module' && !resolve(fromFile, (binding.path.parent as ImportDeclaration).source.value);
  };

  function componentAttrPage(compAttr: NodePath<JSXAttribute>, routesFile: string): Page | typeof REDIRECT {
    const written = compAttr.get('value.expression') as NodePath;
    const compExpr = unwrapCalls(written)!;
    const reached = compExpr.isIdentifier() ? redirectsReturned(compExpr.scope, compExpr.node.name) : null;
    if (reached) {
      addImportedRedirects(reached);
      return REDIRECT;
    }
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

  // 문장이 return 하나뿐이 아니면 undefined 이다.
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
    const reached = componentTag(tag) ? redirectsReturned(element.scope, tag) : null;
    if (reached) {
      addImportedRedirects(reached);
      return REDIRECT;
    }
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
    const wrapperFn = !tag.includes('.') ? functionBound(element.scope.getBinding(tag)) : null;
    const jsxPages = (wrapperFn ? (element.get('openingElement.attributes') as NodePath[]) : []).flatMap((a) => {
      if (!a.isJSXAttribute() || a.node.value?.type !== 'JSXExpressionContainer' || a.node.name.type !== 'JSXIdentifier') return [];
      const held = a.get('value.expression') as NodePath;
      if (!held.isJSXElement() || !rendersProp(wrapperFn!, a.node.name.name)) return [];
      const page = pageOf(held, routesFile);
      return isPage(page) && page.componentFile ? [page] : [];
    });
    const jsxProps = jsxPages.map((p) => ({ component: p.component, componentFile: p.componentFile, named: true }));
    const passed = [...props.filter((c) => c.named), ...jsxProps, ...props.filter((c) => !c.named)]
      .filter((c) => !constantModuleFiles.has(c.componentFile!) && !apiModuleFiles.has(c.componentFile!))
      .map(({ named, ...c }) => c);
    const files = ([outer, ...passed].map((c) => c.componentFile).filter(Boolean) as string[]).concat(innerFiles, jsxPages.flatMap((p) => p.files));
    const innerPage = innerPageOf(inner);
    if (innerPage) return withFiles(innerPage, files);
    const binding = !tag.includes('.') && element.scope.getBinding(tag);
    const declaredHere = Boolean(binding) && (binding as Binding).kind !== 'module';
    const page = [...(followed ? [] : [outer]), ...passed].find((c) => c.componentFile) ?? (declaredHere ? passed[0] : null) ?? inner[0] ?? outer;
    return withFiles(page, files);
  }

  function functionBound(binding: Binding | undefined) {
    if (!binding || binding.kind === 'module') return null;
    const fn = binding.path.isVariableDeclarator() ? binding.path.get('init') : binding.path;
    return fn.isFunction() ? (fn as NodePath<ArrowFunctionExpression | FunctionExpression | FunctionDeclaration>) : null;
  }

  function rendersProp(fn: NodePath<ArrowFunctionExpression | FunctionExpression | FunctionDeclaration>, name: string) {
    const [param] = fn.get('params') as NodePath[];
    if (!param) return false;
    if (param.isObjectPattern()) {
      return param.get('properties').some((q) => q.isObjectProperty() && !q.node.computed && ((q.node.key.type === 'Identifier' && q.node.key.name === name) || (q.node.key.type === 'StringLiteral' && q.node.key.value === name)) && q.get('value').isIdentifier() && Boolean(fn.scope.getBinding((q.node.value as Identifier).name)?.referenced));
    }
    if (!param.isIdentifier()) return false;
    return Boolean(fn.scope.getBinding(param.node.name)?.referencePaths.some((r) => r.parentPath?.isMemberExpression() && r.parentPath.node.object === r.node && !r.parentPath.node.computed && r.parentPath.get('property').isIdentifier({ name })));
  }

  function fillOuterAddresses(sourced: { s: { path: string; routeFile: string }; outerFill: OuterFill; files: string[] }[]) {
    const holds = sourced.map((x) => new Set(x.files));
    const routeFileOf = (i: number) => path.join(config.srcRoot, sourced[i].s.routeFile);
    const outersOf = (i: number) => {
      const around = sourced.flatMap((x, j) => (x.s.routeFile !== sourced[i].s.routeFile && holds[j].has(routeFileOf(i)) ? [j] : []));
      return around.filter((j) => !around.some((k) => sourced[k].s.routeFile !== sourced[j].s.routeFile && holds[j].has(routeFileOf(k))));
    };
    const heldElsewhere = (routeFile: string) => sourced.some((x, j) => x.s.routeFile !== routeFile && holds[j].has(path.join(config.srcRoot, routeFile)));
    for (const r of topRedirects) if (!heldElsewhere(r.file)) r.to = joinRoutePath('', r.to);
    sourced.forEach((x) => {
      if (!x.outerFill.atTopOfRoutes || heldElsewhere(x.s.routeFile)) return;
      x.s.path = joinRoutePath('', x.s.path);
      const entry = x.outerFill.unreadPath?.entry;
      if (entry) Object.assign(entry, { path: x.s.path, ...(entry.paths && { paths: entry.paths.map((p) => joinRoutePath('', p)) }) });
    });
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
      if (!closures.has(f)) closures.set(f, new Set(closureOf(f, (g) => screenFiles().has(g) && g !== f)));
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
    // base 는 경로가 / 로 시작하지 않을 때 앞에 붙는 경로이고, outer 는 경로가 없는 라우트 안에서 다른 라우트 파일의 경로 앞에 붙는 경로다.
    const convert = (n: DrawnNode, file: string, base = '', outer = base): RouteNode[] => {
      const nodes = convertNode(n, file, base, outer);
      for (const node of nodes) if (n.when && node.kind !== 'redirect') node.when = n.when;
      return nodes;
    };
    const convertNode = (n: DrawnNode, file: string, base: string, outer: string): RouteNode[] => {
      if (n.kind === 'routes') {
        const branches: Branch[] = [];
        const unwrapped = (nodes: DrawnNode[]): DrawnNode[] => nodes.flatMap((c) => (c.isFragment ? unwrapped(c.children) : [c]));
        const indexes: string[] = [];
        const flatten = (routes: DrawnNode[], outerPath: string, chain: Branch['chain']) => {
          for (const r of unwrapped(routes).filter((c) => c.isRoute)) {
            const drawnBy = unwrapped(r.children).filter((c) => !c.isRoute && (c.kind !== 'redirect' || c.redirectAsElement));
            const leaf = drawnBy.length === unwrapped(r.children).length;
            for (const node of convert({ ...r, children: drawnBy }, file, base, outerPath) as Branch['chain']) {
              const own = node.path === null ? null : joinRoutePath(base, node.path);
              flatten(r.children, own ?? outerPath, [...chain, node]);
              if (own !== null) branches.push({ path: own, chain: [...chain, node] });
              else if (leaf) indexes.push(outerPath);
            }
          }
        };
        flatten(n.children, base, []);
        return [{ kind: 'routes', branches, indexes }];
      }
      // Switch 안에서 리다이렉트만 하는 컴포넌트를 그리는 라우트는 그 경로에서 보내는 Redirect 와 같다.
      const redirectOf = (c: DrawnNode): RouteNode[] => [{ kind: 'redirect', from: c.path === null ? null : joinRoutePath(base, c.path), exact: c.exact, to: c.componentRedirect! }];
      if (n.kind === 'switch') return [{ kind: 'switch', children: n.children.flatMap((c) => (c.componentRedirect === undefined ? convert(c, file, base) : redirectOf(c))) }];
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
        const full = routePath === null ? null : joinRoutePath(base, routePath);
        const inner = full === null ? outer : full.endsWith('/*') ? full.slice(0, -2) : '';
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

  return {
    redirects, unreadRoutePaths, unreadRoutes, framesPickingByAddress,
    readWhole, unreadPiece, readRoutePath, stopOf, extractScreens, testSide, screensTakingAddressesUnder, pathsIn, itemComponents, itemFieldsRead, resolveTag, fillOuterAddresses, routeTree,
  };
}
