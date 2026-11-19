import path from 'node:path';
import type { Binding, NodePath } from '@babel/traverse';
import type { CallExpression, ExportSpecifier, Identifier, ImportDeclaration, JSXElement, MemberExpression, Node, ObjectProperty, OptionalCallExpression, OptionalMemberExpression, StringLiteral, VariableDeclaration } from '@babel/types';
import type { Side } from './access.ts';
import { addressReader, MOST_ADDRESSES, UNREADABLE_PIECE } from './address-functions.ts';
import type { LinkComponent, Read } from './address-functions.ts';
import { keyName, lookedUp, memberChain, UNKNOWN, VARIABLE_SEGMENT } from './client.ts';
import type { Facts, RouteRef, RouterLink } from './client.ts';
import type { nameFollower } from './follow-names.ts';
import type { guardConditionReader } from './guard-conditions.ts';
import { addresses, FOLLOWED, LINK_ELEMENTS, madeFrom, screenLinkReader } from './screen-links.ts';
import { importedAs, routerImport } from './screen-requests.ts';
import type { sourceValueReader } from './source-values.ts';

type SourceValues = Awaited<ReturnType<typeof sourceValueReader>>;
type GuardConditions = ReturnType<typeof guardConditionReader>;

interface Reading
  extends Pick<SourceValues, 'routeChain' | 'routeRoot' | 'routeRest' | 'programFile' | 'programOf' | 'declaredValue' | 'importedName' | 'evaluate' | 'lossless' | 'constInit' | 'memberName' | 'isCallee' | 'functionName' | 'returnedValues' | 'objectAt' | 'keysInOrder' | 'declaredFunction' | 'exportedDeclaration' | 'importingCalls' | 'namespaceFunction' | 'declaredClass'>,
    Pick<GuardConditions, 'settingsDefaults' | 'settingsResult' | 'settingsPath' | 'needs'> {
  config: any;
  resolve: (fromFile: string, spec: string) => string | null;
  follower: Pick<ReturnType<typeof nameFollower>, 'declaration' | 'origin'>;
  factCache: Map<string, Facts>;
  // 라우트 상수의 값은 이 함수를 부른 뒤에 정해지므로 읽을 때마다 받아 온다.
  routeValues: () => Record<string, unknown>;
  testSide: (test: NodePath<any>, on: boolean) => Side | null;
}

// 주소에 따라 탭을 고르는 컴포넌트. 목록은 그 컴포넌트를 그리는 화면이 넘겨주는 prop 에서 읽는다.
export type RouteTab = { import: string; name: string; items: string; path: string; component: string };

export function clientLinkReader({
  config, resolve, follower, factCache, routeValues, testSide,
  routeChain, routeRoot, routeRest, programFile, programOf, declaredValue, importedName, evaluate, lossless,
  constInit, memberName, isCallee, functionName, returnedValues, objectAt, keysInOrder, declaredFunction, exportedDeclaration, importingCalls, namespaceFunction, declaredClass,
  settingsDefaults, settingsResult, settingsPath, needs,
}: Reading) {
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
      if (!source || resolve(from, source.value) !== file) continue;
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
  const comparedLists = new WeakMap<RouteRef, { file: string; name: string; comparedHere: boolean }>();
  const listReaderFiles = new Set<string>();
  const listVerdicts = new Map<string, boolean>();
  // 목록을 import 하는 파일마다 그 이름을 비교에만 쓰는가. 네임스페이스로 import 하거나 re-export 하면 링크로 본다.
  function listReadersCompare({ file, name, comparedHere }: { file: string; name: string; comparedHere: boolean }): boolean {
    const key = `${file}\0${name}`;
    if (listVerdicts.has(key)) return listVerdicts.get(key)!;
    let compares = true;
    let compared = comparedHere;
    for (const from of listReaderFiles) {
      if (from === file || !compares) continue;
      const program = programOf(from);
      if (!program) continue;
      for (const statement of program.get('body')) {
        if (!(statement.isImportDeclaration() || statement.isExportNamedDeclaration() || statement.isExportAllDeclaration())) continue;
        const source = statement.node.source;
        if (!source || resolve(from, source.value) !== file) continue;
        if (!statement.isImportDeclaration()) {
          const named = statement.isExportNamedDeclaration() ? statement.node.specifiers : [];
          if (statement.isExportAllDeclaration() || named.some((x) => x.type === 'ExportNamespaceSpecifier' || (x.type === 'ExportSpecifier' && keyName({ key: (x as ExportSpecifier).local }) === name))) compares = false;
          continue;
        }
        for (const x of (statement as NodePath<ImportDeclaration>).get('specifiers')) {
          const binding = x.scope.getBinding(x.node.local.name);
          if (x.isImportNamespaceSpecifier()) compares = false;
          else if (x.isImportSpecifier() && keyName({ key: x.node.imported }) === name) {
            if (!binding?.referencePaths.every((r) => compareReadOfList(r))) compares = false;
            else if (binding.referencePaths.length) compared = true;
          }
        }
      }
    }
    listVerdicts.set(key, compares && compared);
    return compares && compared;
  }
  const movedTo = new WeakSet<RouteRef | RouterLink>();

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

  const settingsDefault = (chain: string[]) => chain.slice(1).reduce((v: any, k) => v?.[k], settingsDefaults[chain[0]]);

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
      if (!Object.hasOwn(routeValues(), value)) continue;
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

  function tailText(p: NodePath<any>, stops: NodePath[] = []): string {
    if (p.isStringLiteral()) return p.node.value;
    if (p.isTemplateLiteral()) return p.node.quasis.map((q, i) => (i ? tailText(p.get(`expressions.${i - 1}`) as NodePath, stops) : '') + q.value.cooked).join('');
    if (p.isBinaryExpression({ operator: '+' })) return tailText(p.get('left'), stops) + tailText(p.get('right'), stops);
    const value = lossless(p) ? evaluate(p) : undefined;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    stops.push(p);
    return UNREADABLE_PIECE;
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
      // 붙은 값 때문에 링크를 내지 않는 자리도 링크가 있는 자리로 보아, 함수를 부른 곳에서 앞에 붙인 값을 읽지 않는다.
      linked: (p) => addresses(p).length > 0 && linkAddresses(p, true).length > 0,
      linkedCall: (p) => addressesOf(linkReading.helperBranches(p) ?? { branches: [] }, () => UNKNOWN, true).length > 0,
      linkedUse: (p) => addressesOf(linkReading.useBranches(p) ?? { branches: [] }, () => UNKNOWN, true).length > 0,
      isHistory: (p) => screenLinks.isHistory(p),
      holdsRouteConstant: (p) => Boolean(routeChain) && holdsRouteConstant(p),
    },
  });

  const routeChainOf = (chain: string[] | null) => chain !== null && chain[0] === routeRoot && chain.length === routeRest.length + 1 && routeRest.every((k: string, i: number) => chain[i + 1] === k);
  const isRouteConstant = (p: NodePath<any>) => (p.isMemberExpression() || p.isOptionalMemberExpression()) && routeChainOf(memberChain(p.node.object));

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

  // 분기마다 빈 문자열이거나 ? · # 로 시작하는 문자열이라서 경로가 끝난 뒤에만 붙는 값
  function afterPath(p: NodePath<any>, depth = 0): boolean {
    if (depth > FOLLOWED) return false;
    if (p.isStringLiteral()) return /^([?#]|$)/.test(p.node.value);
    if (p.isTemplateLiteral()) return /^[?#]/.test(p.node.quasis[0].value.cooked ?? '') || (!p.node.expressions.length && p.node.quasis[0].value.cooked === '');
    if (p.isConditionalExpression()) return afterPath(p.get('consequent'), depth + 1) && afterPath(p.get('alternate'), depth + 1);
    if (p.isLogicalExpression() && p.node.operator !== '&&') return afterPath(p.get('left'), depth + 1) && afterPath(p.get('right'), depth + 1);
    const init = p.isIdentifier() ? declaredValue(p.scope, p.node.name) : null;
    return Boolean(init) && afterPath(init!, depth + 1);
  }

  // 알 수 없는 값 바로 뒤에 / 없이 또 알 수 없는 값이 붙은 경로는 뒤의 값이 어디서 끝나는지 알 수 없어 어느 라우트와 맞는지도 알 수 없다.
  // stops 에는 text 에서 읽지 못한 조각마다 그 조각의 표현식을 담는다.
  const gluedUnknowns = (text: string, stops: NodePath[] = []) => {
    const pathText = text.split(/[?#]/)[0];
    if (!pathText.startsWith('/')) return false;
    let piece = -1;
    for (let i = 0; i < pathText.length; i++) {
      if (pathText[i] !== UNREADABLE_PIECE) continue;
      piece++;
      if (pathText[i - 1] === UNREADABLE_PIECE && !(stops[piece] && afterPath(stops[piece]))) return true;
    }
    return false;
  };

  // 링크 요소의 to 나 history 이동에 적은 주소. 동적 세그먼트는 {*} 로 두고, 값으로 시작하는 주소는 {?} 로 둔다.
  // 분기가 너무 많으면 함수를 따라가지 않고, 호출마다 읽지 못한 조각으로 둔 주소 하나를 준다.
  const linkAddresses = (p: NodePath, keepGlued = false) => addressesOf(linkReading.branches(p), (stops) => tailText(p, stops), keepGlued);

  // 주소 함수가 돌려준 분기 가운데 끝까지 읽었는데 / 로 시작하지 않는 것은 링크가 아니고, // 가 생기는 것은 {?} 로 둔다.
  // sides 에는 그 주소가 나오는 분기가 모두 같은 쪽에서만 생길 때 그 설정 값들을 담는다.
  function addressesOf(read: Read, tooMany: (stops: NodePath[]) => string, keepGlued = false): { to: string; sides?: Side[] }[] {
    const linkable = (text: string, stops?: NodePath[]) => keepGlued || !gluedUnknowns(text, stops);
    const one = () => {
      const stops: NodePath[] = [];
      const text = tooMany(stops);
      return linkable(text, stops) ? [{ to: writtenAddress(text) }] : [];
    };
    if ('tooMany' in read) return one();
    const found = new Map<string, Side[] | null>();
    const add = (to: string, sides: Side[] | null) => {
      const before = found.get(to);
      found.set(to, !found.has(to) ? sides : before && sides ? before.filter((a) => sides.some((b) => a.key === b.key && a.on === b.on)) : null);
    };
    for (const { text, stops, made, whole, sides } of read.branches) {
      if (made && whole && !addresses(whole).length) continue;
      if (made && text.split(/[?#]/)[0].includes('//')) add(UNKNOWN, null);
      else if (pathSegments(text)) {
        if (linkable(text, stops)) add(writtenAddress(text), sides ?? null);
      } else if (!made || text.includes(UNREADABLE_PIECE)) add(UNKNOWN, null);
    }
    if (found.size > MOST_ADDRESSES) return one();
    return [...found].map(([to, sides]) => (sides?.length ? { to, sides } : { to }));
  }

  const keptBranches = (read: Read, keep: (text: string) => boolean): Read => ('tooMany' in read ? read : { branches: read.branches.filter((b) => keep(b.text)) });
  // linkComponents 의 컴포넌트는 바깥 사이트도 연다.
  const outsideAddresses = (newTab: boolean) => (p: NodePath) => addressesOf(keptBranches(linkReading.branches(p), (text) => !/^https?:\/\//i.test(text)), (stops) => tailText(p, stops))
    .filter(({ to }) => !newTab || (to !== UNKNOWN && !/\.\w+$/.test(to.split(/[?#]/)[0])));
  const listedAddresses = (p: NodePath) => addressesOf(keptBranches(linkReading.branches(p), (text) => text !== ''), (stops) => tailText(p, stops));

  // 라우트 파일의 Redirect · Navigate 가 이동시키는 곳은 링크가 아니라서 붙은 부분도 {*} 로 둔다.
  const oneAddress = (p: NodePath) => {
    const [only, ...more] = linkAddresses(p, true);
    return more.length || only === undefined ? UNKNOWN : only.to;
  };

  // 라우트 상수 뒤에 이어 붙은 주소와, 상수부터 그 주소까지 이어 붙인 표현식. tail 은 이어 붙인 조각마다 문자열 그대로이거나 변수 하나이면 '/…',
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

  function comparedOnly(at: NodePath): boolean {
    const up = at.parentPath!;
    if (up.isBinaryExpression() && ['===', '!==', '==', '!='].includes(up.node.operator)) return true;
    if (up.isSwitchCase() && at.key === 'test') return true;
    const calleeOf = (arg: NodePath) => {
      const call = arg.parentPath!;
      return arg.listKey === 'arguments' && (call.isCallExpression() || call.isOptionalCallExpression()) ? call.node.callee : null;
    };
    const matching = (arg: NodePath) => {
      const callee = calleeOf(arg);
      return callee?.type === 'Identifier' && ['matchPath', 'useRouteMatch', 'useMatch'].includes(callee.name);
    };
    if (up.isObjectProperty() && at.key === 'value' && !up.node.computed && keyName(up.node) === 'path') return matching(up.parentPath!);
    const callee = calleeOf(at);
    if ((callee?.type === 'MemberExpression' || callee?.type === 'OptionalMemberExpression') && !callee.computed) {
      return ['startsWith', 'endsWith', 'includes', 'indexOf'].includes((callee.property as Identifier).name);
    }
    return matching(at);
  }

  function compareReadOfList(ref: NodePath): boolean {
    const member = ref.parentPath!;
    if (!(member.isMemberExpression() || member.isOptionalMemberExpression()) || member.node.object !== ref.node || member.node.computed) return false;
    const call = member.parentPath!;
    if (!(call.isCallExpression() || call.isOptionalCallExpression()) || call.node.callee !== member.node) return false;
    const method = (member.node.property as Identifier).name;
    if (!['some', 'every', 'find', 'filter', 'findIndex', 'includes', 'indexOf', 'lastIndexOf'].includes(method)) return false;
    if (!['some', 'every', 'find', 'filter', 'findIndex'].includes(method)) return true;
    const fn = (call.get('arguments') as NodePath<any>[])[0];
    if (!fn?.isFunction() || fn.node.params.length !== 1) return false;
    const param = fn.get('params.0') as NodePath<any>;
    const binding = param.isIdentifier() ? fn.scope.getBinding(param.node.name) : null;
    if (!binding || !binding.referencePaths.every((r) => comparedOnly(r))) return false;
    return !['find', 'filter'].includes(method) || comparedValue(call);
  }

  // find · filter 가 돌려준 값을 이동 주소가 아니라 참 · 거짓으로만 쓰는가
  function comparedValue(call: NodePath): boolean {
    const up = call.parentPath!;
    const at = (up.isMemberExpression() || up.isOptionalMemberExpression()) && !up.node.computed && (up.node.property as Identifier).name === 'length' ? up : call;
    const parent = at.parentPath!;
    if (parent.isUnaryExpression({ operator: '!' })) return true;
    if ((parent.isCallExpression() || parent.isOptionalCallExpression()) && parent.node.callee.type === 'Identifier' && parent.node.callee.name === 'Boolean') return true;
    if ((parent.isIfStatement() || parent.isWhileStatement() || parent.isConditionalExpression()) && at.key === 'test') return true;
    if (parent.isLogicalExpression()) return (parent.node.operator === '&&' && at.key === 'left') || comparedValue(parent);
    return parent.isBinaryExpression() && ['===', '!==', '==', '!=', '>', '>=', '<', '<='].includes(parent.node.operator);
  }

  // 라우트 상수가 든 목록이 비교에만 쓰이는가. export 한 목록은 import 하는 파일까지 본다.
  function listComparedOnly(list: NodePath): { exported: string | null; comparedHere: boolean } | null {
    if (compareReadOfList(list)) return { exported: null, comparedHere: true };
    const declarator = list.parentPath!;
    if (!declarator.isVariableDeclarator() || list.key !== 'init' || declarator.node.id.type !== 'Identifier' || (declarator.parent as VariableDeclaration).kind !== 'const') return null;
    const name = declarator.node.id.name;
    const binding = declarator.scope.getBinding(name);
    if (!binding) return null;
    const exportedAs = binding.referencePaths.filter((r) => r.isExportNamedDeclaration() || r.parentPath!.isExportSpecifier());
    if (exportedAs.some((r) => !r.isExportNamedDeclaration() && ((r.parent as ExportSpecifier).exported as Identifier).name !== name)) return null;
    if (!binding.referencePaths.every((r) => exportedAs.includes(r) || compareReadOfList(r))) return null;
    const comparedHere = binding.referencePaths.length > exportedAs.length;
    if (!exportedAs.length && !comparedHere) return null;
    return { exported: exportedAs.length ? name : null, comparedHere };
  }

  function fillsPathVariable(p: NodePath<any>) {
    const call = p.parentPath!;
    if (!(call.isCallExpression() || call.isOptionalCallExpression()) || call.node.callee !== p.node) return false;
    const first = call.node.arguments[0];
    return first?.type === 'StringLiteral' && first.value.startsWith(':');
  }

  const historyFile = config.history ? exportingFile('history', config.history) : null;
  const historyImports = new Map<string, boolean>();
  const screenLinks = screenLinkReader({
    configuredHistory(binding) {
      const from = historyFile ? importedAs(binding) : null;
      const file = from && from.name !== '*' ? programFile.get(binding.scope.getProgramParent().block) : null;
      if (!file) return false;
      const resolved = resolve(file, from!.spec);
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
    const file = resolve(path.join(config.srcRoot, 'index.js'), from);
    if (!file || !file.startsWith(config.srcRoot + path.sep)) throw new Error(`${at}.import ${from} names no file under srcRoot ${config.srcRoot}`);
    if (!follower.declaration(file, name)) throw new Error(`${at}.name ${name} is not exported by ${path.relative(config.srcRoot, file)}`);
    return file;
  }

  // file 에는 import 가 srcRoot 안의 파일이면 그 파일을 담고, 아니면 import 에 적힌 문자열 그대로 맞춘다.
  type Listed = { key: 'linkComponents' | 'linkFunctions'; import: string; name: string; address?: string; file: string | null };
  const listedEntries = (key: Listed['key']): Listed[] => ((config[key] ?? []) as Omit<Listed, 'key' | 'file'>[]).map((entry) => ({ ...entry, key, file: listedFile(key, entry) }));
  function listedFile(key: Listed['key'], { import: from, name }: { import: string; name: string }) {
    const file = resolve(path.join(config.srcRoot, 'index.js'), from);
    if (!file || !file.startsWith(config.srcRoot + path.sep)) {
      if (from.startsWith('.')) throw new Error(`${key} import ${from} names no file under srcRoot ${config.srcRoot}`);
      return null;
    }
    if (!follower.declaration(file, name)) throw new Error(`${key} ${from} ${name}: ${name} is not exported by ${path.relative(config.srcRoot, file)}`);
    return file;
  }
  const listedComponents = listedEntries('linkComponents');
  const listedFunctions = listedEntries('linkFunctions');
  const routeTabEntries = ((config.routeTabs ?? []) as RouteTab[]).map((entry, i) => ({ ...entry, file: exportingFile(`routeTabs[${i}]`, entry) }));
  const routeTabNotices: { file: string | null; line: number | null; reason: string }[] = [];
  const usedListed = new Set<Listed>();
  const listedImports = new Map<string, boolean>();
  // keys 는 import 한 이름에서 꺼낸 속성의 이름이다(<ads.Link> 의 Link).
  function listedAs(binding: Binding | undefined, keys: string[], entries: Listed[]): Listed | null {
    const from = binding && entries.length ? importedAs(binding) : null;
    const name = !from ? null : from.name === '*' ? (keys.length === 1 ? keys[0] : null) : keys.length ? null : from.name;
    if (!name) return null;
    const file = programFile.get(binding!.scope.getProgramParent().block);
    const resolved = file ? resolve(file, from!.spec) : null;
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

  return {
    linkAddressRefs, exportedKeys, importedLater, comparedLists, listReaderFiles, movedTo, madeHistories, usedListed, routeTabNotices,
    lookedUpElsewhere, listReadersCompare, listedRoutes, passThrough, linkReading, routeChainOf, linkAddresses, addressesOf, outsideAddresses, listedAddresses, oneAddress,
    routeTail, comparedOnly, listComparedOnly, fillsPathVariable, screenLinks, exportingFile, listedComponents, listedFunctions, routeTabEntries, listedCall, linkComponentOf,
  };
}
