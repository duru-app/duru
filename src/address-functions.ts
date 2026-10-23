import type { Binding, NodePath, Scope } from '@babel/traverse';
import type { ArrowFunctionExpression, CallExpression, ClassDeclaration, ClassMethod, FunctionDeclaration, FunctionExpression, Identifier, JSXElement, Node, StringLiteral } from '@babel/types';
import { addresses, FOLLOWED, toOf } from './screen-links.ts';
import type { Move } from './screen-links.ts';
import type { Side } from './access.ts';

export const UNREADABLE_PIECE = '\0';
export const MOST_ADDRESSES = 8;
const MOST_BRANCHES = 64;

export type AddressFunction = NodePath<ArrowFunctionExpression | FunctionExpression | FunctionDeclaration>;
type Followable = AddressFunction | NodePath<ClassMethod>;
// JSX 요소가 그리는 것: router 는 react-router 의 링크 요소 이름, fn 은 소스에 선언한 함수 컴포넌트다.
export type LinkComponent = { router: string } | { fn: AddressFunction };
// value 는 끝까지 읽은 값이고, parts 는 고정 문자열과 읽다 멈춘 지점을 순서대로 담는다.
// withheld 는 값을 알지만 이 읽기가 받지 않는 조각이다.
export type Leaf = { value: unknown } | { parts: (string | NodePath)[]; withheld?: boolean };
// whole 은 함수가 받은 인자를 그대로 돌려준 갈래의, 부른 곳에 적힌 그 인자다.
// sides 는 그 갈래가 생기는 배포마다 정해지는 설정 값이다.
export type Branch = { text: string; stops: NodePath[]; made: boolean; whole?: NodePath; sides?: Side[] };
export type Read = { branches: Branch[] } | { tooMany: true };

interface Reading {
  leaf: (p: NodePath) => Leaf;
  declaredValue: (scope: Scope, name: string) => NodePath | null;
  declaredFunction: (scope: Scope, name: string) => AddressFunction | null;
  namespaceFunction: (scope: Scope, chain: string[]) => AddressFunction | null;
  declaredClass: (scope: Scope, name: string) => NodePath<ClassDeclaration> | null;
  passThrough: (name: string) => boolean;
  mergesSlashes: boolean;
  moves?: Moves;
  testSide?: (test: NodePath<any>, on: boolean) => Side | null;
}

// linked 는 주소 자리 하나가, linkedCall 은 옮겨 주는 함수를 부른 자리 하나가, linkedUse 는 링크 컴포넌트를 쓴 자리 하나가
// 그 자리에 링크를 내는가다.
interface Moves {
  moveOf: (p: NodePath<CallExpression>) => Move | null;
  component: (p: NodePath<JSXElement>) => LinkComponent | null;
  linked: (p: NodePath) => boolean;
  linkedCall: (p: NodePath<CallExpression>) => boolean;
  linkedUse: (p: NodePath<JSXElement>) => boolean;
  isHistory: (p: NodePath) => boolean;
  holdsRouteConstant: (p: NodePath) => boolean;
}

// empty 는 함수가 돌려준 빈 문자열이다. 주소 맨 앞에 오면 읽지 못한 조각으로 본다.
type Piece = { text: string; made?: boolean } | { stop: NodePath; withheld?: boolean } | { empty: NodePath };
type Val =
  | { pieces: Piece[] }
  | { value: unknown }
  | { props: Map<string, Out>; open: boolean; rest?: Out }
  | { items: Out[] }
  | { unknown: NodePath };
type Out = { val: Val; made: boolean; whole?: NodePath; sides?: Side[] };
type Env = Map<Binding, Out>;
// consts 이면 fn 안에서 const 로 선언한 이름을 그 초기값으로 읽는다.
interface At { env: Env | null; fn: Followable | null; branching: boolean; depth: number; consts?: boolean }
// history 는 함수가 매개변수로 받은 history 로 옮기는 자리의 그 매개변수다.
type MovePlace = { at: NodePath<CallExpression>; addresses: NodePath[]; history: NodePath | null };
// elements 는 react-router 링크 요소, uses 는 받은 것을 속성으로 넘기는 링크 컴포넌트의 요소다.
type Places = {
  moves: MovePlace[];
  calls: { at: NodePath<CallExpression>; fn: AddressFunction }[];
  elements: { at: NodePath<JSXElement>; addresses: NodePath[] }[];
  uses: { at: NodePath<JSXElement>; fn: AddressFunction }[];
};

const OUTSIDE: At = { env: null, fn: null, branching: false, depth: 0 };
const NOT_KNOWN = Symbol('not known');
const COMPARE: Record<string, (a: any, b: any) => boolean> = {
  '===': (a, b) => a === b,
  '!==': (a, b) => a !== b,
  '==': (a, b) => a == b,
  '!=': (a, b) => a != b,
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
};

class Unreadable extends Error {}
class TooMany extends Error {}

const textOut = (text: string): Out => ({ val: { pieces: text ? [{ text }] : [] }, made: false });
const known = (value: unknown): Out => (typeof value === 'string' ? textOut(value) : { val: { value }, made: false });
const unknownAt = (at: NodePath): Out => ({ val: { unknown: at }, made: false });
const keyOf = (key: Node) => (key as Identifier).name ?? (key as StringLiteral).value;

function piecesOf({ val }: Out, at: NodePath): Piece[] {
  if ('pieces' in val) return val.pieces;
  if ('value' in val && typeof val.value === 'number') return [{ text: String(val.value) }];
  return [{ stop: 'unknown' in val ? val.unknown : at }];
}

function joined(parts: [Out, NodePath][], mergesSlashes: boolean): Out {
  const pieces: Piece[] = [];
  for (const piece of parts.flatMap(([out, at]) => piecesOf(out, at))) {
    const last = pieces.at(-1);
    if ('empty' in piece && pieces.length) continue;
    if ('text' in piece && last && 'text' in last && last.text.endsWith('/') && piece.text.startsWith('/') && (last.made || piece.made) && mergesSlashes) {
      if (piece.text.length > 1) pieces.push({ ...piece, text: piece.text.slice(1) });
    } else pieces.push(piece);
  }
  const sides = parts.flatMap(([out]) => out.sides ?? []);
  return { val: { pieces }, made: parts.some(([out]) => out.made), ...(sides.length && { sides }) };
}

function product<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])), [[]]);
}

// 다 읽은 값이면 그 값, 아니면 NOT_KNOWN
function plain({ val }: Out): unknown {
  if ('pieces' in val) return val.pieces.some((x) => 'stop' in x) ? NOT_KNOWN : val.pieces.map((x) => ('text' in x ? x.text : '')).join('');
  return 'value' in val ? val.value : NOT_KNOWN;
}

function truth(out: Out): boolean | undefined {
  const { val } = out;
  if ('props' in val || 'items' in val || ('pieces' in val && val.pieces.some((x) => 'text' in x && x.text))) return true;
  const value = plain(out);
  return value === NOT_KNOWN ? undefined : Boolean(value);
}

function member(out: Out, key: string, at: NodePath): Out {
  const { val } = out;
  if ('props' in val) return val.props.get(key) ?? (val.open ? val.rest ?? unknownAt(at) : known(undefined));
  if (at.isOptionalMemberExpression() && 'value' in val && (val.value === undefined || val.value === null)) return known(undefined);
  if ('items' in val) return key === 'length' ? known(val.items.length) : unknownAt(at);
  if ('unknown' in val) return out;
  const value = plain(out);
  if (typeof value === 'string' && key === 'length') return known(value.length);
  return value !== null && typeof value === 'object' ? known((value as Record<string, unknown>)[key]) : unknownAt(at);
}

function withheldIn({ val }: Out): boolean {
  if ('pieces' in val) return val.pieces.some((x) => 'withheld' in x && x.withheld);
  if ('props' in val) return [...val.props.values()].some(withheldIn);
  return 'items' in val && val.items.some(withheldIn);
}

const keyOfOut = ({ val, made, whole, sides }: Out) => ('pieces' in val ? `${made}\0${whole?.node.start}\0${sides?.map((x) => `${x.key}=${x.on}`).join() ?? ''}\0${val.pieces.map((x) => ('text' in x ? x.text : 'stop' in x ? UNREADABLE_PIECE : '\u0001')).join('')}` : null);

function distinct(outs: Out[]) {
  const seen = new Set<string>();
  return outs.filter((o) => {
    const key = keyOfOut(o);
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function limited<T>(list: T[], merge: (list: T[]) => T[] = (x) => x) {
  const kept = list.length > MOST_BRANCHES ? merge(list) : list;
  if (kept.length > MOST_BRANCHES) throw new TooMany();
  return kept;
}

function touchesOwn(x: NodePath<any>, fn: Followable): boolean {
  const own = (p: NodePath<any>) => Boolean(p.scope.getBinding(p.node.name)?.path.isDescendant(fn));
  if (x.isIdentifier()) return own(x);
  let found = false;
  x.traverse({
    Identifier(p) {
      if (!own(p)) return;
      found = true;
      p.stop();
    },
  });
  return found;
}

const CHANGING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);

function changesOwn(x: NodePath<any>, fn: Followable): boolean {
  const changes = (p: NodePath<any>): boolean => {
    if (p.isAssignmentExpression()) return touchesOwn(p.get('left'), fn);
    if (p.isUpdateExpression() || p.isUnaryExpression({ operator: 'delete' })) return touchesOwn(p.get('argument') as NodePath<any>, fn);
    if (!p.isCallExpression() && !p.isOptionalCallExpression()) return false;
    const callee = p.get('callee') as NodePath<any>;
    if ((!callee.isMemberExpression() && !callee.isOptionalMemberExpression()) || callee.node.computed) return false;
    const name = (callee.node.property as Identifier).name;
    const object = callee.get('object') as NodePath<any>;
    if (object.isIdentifier({ name: 'Object' }) && name === 'assign') {
      const [target] = p.get('arguments') as NodePath<any>[];
      return Boolean(target && touchesOwn(target, fn));
    }
    return CHANGING_METHODS.has(name) && touchesOwn(object, fn);
  };
  if (changes(x)) return true;
  let found = false;
  x.traverse({
    enter(p) {
      if (!changes(p)) return;
      found = true;
      p.stop();
    },
  });
  return found;
}

// 갈래로 고르거나 이름에 넣는 빈 문자열.
function choosesText(p: NodePath): boolean {
  const { parentPath: parent, key } = p;
  if (!parent) return false;
  if (parent.isParenthesizedExpression() || parent.isTSAsExpression()) return choosesText(parent);
  if (parent.isConditionalExpression()) return key !== 'test';
  if (parent.isLogicalExpression() || parent.isAssignmentExpression() || parent.isAssignmentPattern()) return key === 'right';
  return parent.isVariableDeclarator() || parent.isReturnStatement() || parent.isArrowFunctionExpression();
}

const hasText = ({ val }: Out) => 'pieces' in val && val.pieces.some((x) => 'text' in x);
// 부른 곳에 적힌 값 그대로인 것에는 그 식을 whole 로 단다.
const wholeOr = (o: Out, p: NodePath): Out => (o.made || o.whole || hasText(o) ? o : { ...o, whole: p });

// 읽지 못한 조각만으로 되어 있어 무슨 값인지 모르는 값
const opaque = ({ val }: Out) => 'unknown' in val || ('pieces' in val && val.pieces.length > 0 && val.pieces.every((x) => 'stop' in x));

const unwrapped = (p: NodePath<any>): NodePath<any> => (p.isTSAsExpression() || p.isTSSatisfiesExpression() || p.isTSNonNullExpression() || p.isTypeCastExpression() || p.isParenthesizedExpression() ? unwrapped(p.get('expression') as NodePath<any>) : p);

export function addressReader({ leaf, declaredValue, declaredFunction, namespaceFunction, declaredClass, passThrough, mergesSlashes, moves, testSide }: Reading) {
  const reading = new Set<Node>();
  const sided = (outs: Out[], test: NodePath<any>, on: boolean) => {
    const side = testSide?.(test, on);
    return side ? outs.map((o) => ({ ...o, sides: [...(o.sides ?? []), side] })) : outs;
  };
  const join = (parts: [Out, NodePath][]) => joined(parts, mergesSlashes);
  const placesFound = new WeakMap<Node, Places>();
  const helperFound = new WeakMap<Node, boolean>();
  const componentFound = new WeakMap<Node, boolean>();
  const placeLinked = new WeakMap<Node, boolean>();

  function leafOut(p: NodePath): Out {
    const found = leaf(p);
    const withheld = 'withheld' in found && found.withheld ? { withheld: true } : {};
    if ('parts' in found) return { val: { pieces: found.parts.flatMap((x): Piece[] => (typeof x !== 'string' ? [{ stop: x, ...withheld }] : x ? [{ text: x }] : [])) }, made: false };
    return found.value === undefined ? unknownAt(p) : known(found.value);
  }

  const inEnv = (p: NodePath<any>, at: At): boolean => {
    if (p.isMemberExpression() || p.isOptionalMemberExpression()) return !p.node.computed && inEnv(p.get('object') as NodePath<any>, at);
    const binding = p.isIdentifier() ? p.scope.getBinding(p.node.name) : undefined;
    return Boolean(binding && at.env?.has(binding));
  };

  function identifier(p: NodePath<Identifier>, at: At): Out[] {
    const binding = p.scope.getBinding(p.node.name);
    if (binding && at.env?.has(binding)) return [at.env.get(binding)!];
    if (binding && at.fn && binding.path.isDescendant(at.fn)) return at.consts ? constValues(p, binding, at) : [unknownAt(p)];
    if (!binding && p.node.name === 'undefined') return [known(undefined)];
    const out = leafOut(p);
    if (plain(out) !== NOT_KNOWN || 'value' in out.val) return [out];
    const declared = declaredValue(p.scope, p.node.name);
    if (!declared || !unwrapped(declared).isCallExpression() || reading.has(declared.node)) return [out];
    reading.add(declared.node);
    try {
      return values(declared, { ...OUTSIDE, depth: at.depth });
    } finally {
      reading.delete(declared.node);
    }
  }

  function constValues(p: NodePath<Identifier>, binding: Binding, at: At): Out[] {
    const declarator = binding.path;
    if (binding.kind !== 'const' || !declarator.isVariableDeclarator() || !declarator.node.init || reading.has(declarator.node)) return [unknownAt(p)];
    reading.add(declarator.node);
    try {
      const inner = (env: Env): At => ({ ...at, env });
      return values(declarator.get('init') as NodePath, at).flatMap((o) => bind(declarator.get('id'), o, [new Map(at.env)], inner).map((e) => e.get(binding) ?? unknownAt(p)));
    } finally {
      reading.delete(declarator.node);
    }
  }

  function calledFunction(p: NodePath<any>, at: At) {
    const callee = p.get('callee') as NodePath<any>;
    if (inEnv(callee, at)) return null;
    if (callee.isIdentifier()) return declaredFunction(p.scope, callee.node.name);
    const object = callee.isMemberExpression() && !callee.node.computed ? callee.get('object') as NodePath<any> : null;
    return object?.isIdentifier() ? namespaceFunction(p.scope, [object.node.name, (callee.node.property as Identifier).name]) : null;
  }

  function joinedItems(list: Out, separator: Out, at: NodePath): Out {
    const glue = plain(separator);
    if (typeof glue !== 'string') return unknownAt(at);
    if ('items' in list.val) return join(list.val.items.flatMap((item, i): [Out, NodePath][] => (i ? [[textOut(glue), at], [item, at]] : [[item, at]])));
    const value = plain(list);
    return Array.isArray(value) ? known(value.join(glue)) : unknownAt(at);
  }

  function call(p: NodePath<any>, at: At): Out[] {
    const callee = p.get('callee') as NodePath<any>;
    const args = p.get('arguments') as NodePath<any>[];
    const given = { ...at, branching: true };
    if (callee.isMemberExpression() && !callee.node.computed && (callee.node.property as Identifier).name === 'join' && inEnv(callee.get('object'), at)) {
      const separators = args[0] ? values(args[0], given) : [textOut(',')];
      return product([values(callee.get('object'), at), separators]).map(([list, separator]) => joinedItems(list, separator, p));
    }
    if (callee.isIdentifier() && passThrough(callee.node.name)) return args[0] ? values(args[0], at) : [leafOut(p)];
    const fn = calledFunction(p, at);
    if (fn && (reading.has(fn.node) || at.depth >= FOLLOWED)) return [unknownAt(p)];
    if (!fn || fn.node.async || fn.node.generator) return [leafOut(p)];
    const spread = args.findIndex((a) => a.isSpreadElement());
    const lists = limited(product((spread < 0 ? args : args.slice(0, spread)).map((a) => values(a, given))));
    return followed(fn, p, () => lists.flatMap((list) => bound(fn, list, spread < 0 ? null : args[spread], at.depth + 1).flatMap((e) => returnedValues(fn, e, p, at.depth + 1))));
  }

  // 따라 읽은 함수나 getter 가 돌려준 갈래에, 그 안에서 만든 조각이라는 표시를 붙인다.
  function followed(fn: Followable, p: NodePath<any>, read: () => Out[]): Out[] {
    reading.add(fn.node);
    try {
      const outs = distinct(read());
      if (outs.some(withheldIn)) return [unknownAt(p)];
      return limited(outs).map((o) => {
        const whole = { ...(o.whole && { whole: o.whole }), ...(o.sides && { sides: o.sides }) };
        if (!('pieces' in o.val)) return { val: o.val, made: true, ...whole };
        const pieces = o.val.pieces.every((x) => 'empty' in x) ? [{ empty: p }] : o.val.pieces.map((x) => ('text' in x ? { ...x, made: true } : x));
        return { val: { pieces }, made: true, ...whole };
      });
    } catch (error) {
      if (error instanceof Unreadable) return [unknownAt(p)];
      throw error;
    } finally {
      reading.delete(fn.node);
    }
  }

  // 매개변수에 클래스 이름 하나가 타입으로 적혀 있으면, 그 클래스 몸통에 직접 적힌 같은 이름의 getter
  function getterOf(object: NodePath<any>, key: string): NodePath<ClassMethod> | null {
    const binding = object.isIdentifier() ? object.scope.getBinding(object.node.name) : undefined;
    const annotation = binding?.kind === 'param' && binding.path.isIdentifier() ? binding.path.node.typeAnnotation : null;
    const type = annotation?.type === 'TSTypeAnnotation' ? annotation.typeAnnotation : null;
    const found = type?.type === 'TSTypeReference' && type.typeName.type === 'Identifier' ? declaredClass(binding!.scope, type.typeName.name) : null;
    const getter = found?.get('body.body').find((m) => m.isClassMethod({ kind: 'get', static: false, computed: false }) && keyOf(m.node.key) === key);
    return (getter as NodePath<ClassMethod> | undefined) ?? null;
  }

  function memberValues(p: NodePath<any>, at: At): Out[] {
    const key = (p.node.property as Identifier).name;
    const object = p.get('object') as NodePath;
    return values(object, at).flatMap((o) => {
      const getter = opaque(o) ? getterOf(object, key) : null;
      if (!getter) return [member(o, key, p)];
      if (reading.has(getter.node) || at.depth >= FOLLOWED) return [unknownAt(p)];
      const read = followed(getter, p, () => returnedValues(getter, new Map(), p, at.depth + 1));
      return p.isOptionalMemberExpression() ? [...read, known(undefined)] : read;
    });
  }

  function bound(fn: AddressFunction, given: Out[], spread: NodePath | null, depth: number): Env[] {
    let envs: Env[] = [new Map()];
    const inner = (env: Env): At => ({ env, fn, branching: true, depth });
    (fn.get('params') as NodePath<any>[]).forEach((param, i) => {
      if (param.isRestElement()) envs = bind(param.get('argument'), spread ? unknownAt(spread) : { val: { items: given.slice(i) }, made: false }, envs, inner);
      else envs = bind(param, spread && i >= given.length ? unknownAt(spread) : given[i], envs, inner);
    });
    return envs;
  }

  function bind(pattern: NodePath<any>, out: Out | undefined, envs: Env[], inner: (env: Env) => At): Env[] {
    if (pattern.isIdentifier()) {
      const binding = pattern.scope.getBinding(pattern.node.name)!;
      return envs.map((e) => new Map(e).set(binding, out ?? known(undefined)));
    }
    if (pattern.isAssignmentPattern()) {
      if (out && plain(out) !== undefined) return bind(pattern.get('left'), out, envs, inner);
      return envs.flatMap((e) => values(pattern.get('right'), inner(e)).flatMap((d) => bind(pattern.get('left'), d, [e], inner)));
    }
    if (pattern.isObjectPattern()) {
      const named = new Set(pattern.node.properties.flatMap((x) => (x.type === 'ObjectProperty' && !x.computed ? [keyOf(x.key)] : [])));
      for (const prop of pattern.get('properties') as NodePath<any>[]) {
        if (prop.isObjectProperty() && !prop.node.computed) envs = bind(prop.get('value'), out ? member(out, keyOf(prop.node.key), prop) : unknownAt(prop), envs, inner);
        else if (prop.isRestElement() && out && 'props' in out.val) {
          const rest = { val: { ...out.val, props: new Map([...out.val.props].filter(([key]) => !named.has(key))) }, made: out.made };
          envs = bind(prop.get('argument'), rest, envs, inner);
        } else envs = bind((prop.isRestElement() ? prop.get('argument') : prop.get('value')) as NodePath<any>, unknownAt(prop), envs, inner);
      }
      return envs;
    }
    const names = Object.keys(pattern.getBindingIdentifiers());
    return envs.map((e) => {
      const next = new Map(e);
      for (const name of names) next.set(pattern.scope.getBinding(name)!, unknownAt(pattern));
      return next;
    });
  }

  function returnedValues(fn: Followable, env: Env, at: NodePath, depth: number): Out[] {
    const body = fn.get('body') as NodePath<any>;
    if (!body.isBlockStatement()) {
      if (changesOwn(body, fn)) throw new Unreadable();
      return values(body, { env, fn, branching: true, depth });
    }
    const { returned, open } = walk(body.get('body'), [env], fn, depth);
    return [...returned, ...open.map(() => unknownAt(at))];
  }

  function walk(statements: NodePath<any>[], envs: Env[], fn: Followable, depth: number): { returned: Out[]; open: Env[] } {
    const returned: Out[] = [];
    const inner = (env: Env): At => ({ env, fn, branching: true, depth });
    for (const s of statements) {
      if (!envs.length) break;
      if (s.isReturnStatement()) {
        if (s.node.argument && changesOwn(s.get('argument') as NodePath<any>, fn)) throw new Unreadable();
        for (const e of envs) returned.push(...(s.node.argument ? values(s.get('argument'), inner(e)) : [known(undefined)]));
        envs = [];
      } else if (s.isIfStatement()) {
        if (changesOwn(s.get('test'), fn)) throw new Unreadable();
        const next: Env[] = [];
        for (const e of envs) {
          const truths = values(s.get('test'), inner(e)).map(truth);
          for (const [taken, branch] of [[true, s.get('consequent')], [false, s.get('alternate')]] as const) {
            if (!truths.includes(taken) && !truths.includes(undefined)) continue;
            if (!branch.node) {
              next.push(e);
              continue;
            }
            const found = walk([branch as NodePath], [new Map(e)], fn, depth);
            returned.push(...sided(found.returned, s.get('test'), taken));
            next.push(...found.open);
          }
        }
        envs = next;
      } else if (s.isBlockStatement()) {
        const found = walk(s.get('body'), envs, fn, depth);
        returned.push(...found.returned);
        envs = found.open;
      } else if (s.isVariableDeclaration()) {
        for (const d of s.get('declarations')) {
          const init = d.get('init') as NodePath<any>;
          if (init.node && changesOwn(init, fn)) throw new Unreadable();
          envs = envs.flatMap((e) => (init.node ? values(init, inner(e)) : [known(undefined)]).flatMap((o) => bind(d.get('id'), o, [e], inner)));
        }
      } else if (s.isExpressionStatement()) {
        const x = s.get('expression') as NodePath<any>;
        if (!x.isAssignmentExpression()) {
          if (touchesOwn(x, fn)) throw new Unreadable();
          continue;
        }
        const left = x.get('left') as NodePath<any>;
        const binding = left.isIdentifier() ? left.scope.getBinding(left.node.name) : undefined;
        if ((!left.isIdentifier() && touchesOwn(left, fn)) || changesOwn(x.get('right'), fn)) throw new Unreadable();
        if (!binding?.path.isDescendant(fn)) continue;
        envs = envs.flatMap((e) => values(x.get('right'), inner(e)).map((o) => {
          const before = e.get(binding) ?? unknownAt(left);
          const after = x.node.operator === '=' ? o : x.node.operator === '+=' ? added(before, o, left, x.get('right')) : unknownAt(x);
          return new Map(e).set(binding, after);
        }));
      } else if (s.isThrowStatement()) envs = [];
      else if (!s.isEmptyStatement() && !(s.isDeclaration() && !s.isVariableDeclaration())) throw new Unreadable();
      envs = limited(envs);
    }
    return { returned, open: envs };
  }

  function added(left: Out, right: Out, leftAt: NodePath, rightAt: NodePath): Out {
    const [a, b] = [plain(left), plain(right)];
    return typeof a === 'number' && typeof b === 'number' ? known(a + b) : join([[left, leftAt], [right, rightAt]]);
  }

  function choose(outs: Out[], pick: (out: Out) => boolean | undefined, then: (out: Out) => Out[], otherwise: (out: Out) => Out[]): Out[] {
    return outs.flatMap((o) => {
      const picked = pick(o);
      if (picked === undefined) return [...then(o), ...otherwise(o)];
      return picked ? then(o) : otherwise(o);
    });
  }

  function values(p: NodePath<any>, at: At): Out[] {
    const outs = limited(valuesOf(unwrapped(p), at), distinct);
    return at.env ? outs : outs.map((o) => wholeOr(o, p));
  }

  function valuesOf(p: NodePath<any>, at: At): Out[] {
    if (p.isStringLiteral()) return [at.fn && !p.node.value && choosesText(p) ? { val: { pieces: [{ empty: p }] }, made: false } : textOut(p.node.value)];
    if (p.isNumericLiteral() || p.isBooleanLiteral()) return [known(p.node.value)];
    if (p.isNullLiteral()) return [known(null)];
    if (p.isTemplateLiteral()) {
      const lists = p.node.quasis.flatMap((q, i): [Out, NodePath][][] => {
        const quasi: [Out, NodePath][] = [[textOut(q.value.cooked ?? ''), p]];
        if (i === p.node.expressions.length) return [quasi];
        const expression = p.get(`expressions.${i}`) as NodePath;
        return [quasi, values(expression, at).map((o): [Out, NodePath] => [o, expression])];
      });
      return product(lists).map(join);
    }
    if (p.isBinaryExpression()) {
      const [left, right] = [p.get('left') as NodePath, p.get('right') as NodePath];
      const operator = p.node.operator;
      if (operator !== '+' && !Object.hasOwn(COMPARE, operator)) return [leafOut(p)];
      return product([values(left, at), values(right, at)]).map(([l, r]) => {
        if (operator === '+') return added(l, r, left, right);
        const [a, b] = [plain(l), plain(r)];
        return a === NOT_KNOWN || b === NOT_KNOWN ? unknownAt(p) : known(COMPARE[operator](a, b));
      });
    }
    if (p.isUnaryExpression({ operator: '!' })) {
      return values(p.get('argument'), at).map((o) => {
        const t = truth(o);
        return t === undefined ? unknownAt(p) : known(!t);
      });
    }
    if (p.isConditionalExpression() && at.branching) {
      const test = p.get('test');
      return choose(values(test, at), truth, () => sided(values(p.get('consequent'), at), test, true), () => sided(values(p.get('alternate'), at), test, false));
    }
    if (p.isLogicalExpression() && at.branching) {
      const right = () => values(p.get('right'), at);
      const left = values(p.get('left'), at);
      if (p.node.operator === '??') return choose(left, (o) => (plain(o) === NOT_KNOWN && !truth(o) ? undefined : plain(o) === null || plain(o) === undefined), right, (o) => [o]);
      return choose(left, truth, p.node.operator === '||' ? (o) => [o] : right, p.node.operator === '||' ? right : (o) => [o]);
    }
    if (p.isIdentifier()) return identifier(p, at);
    if ((p.isMemberExpression() || p.isOptionalMemberExpression()) && inEnv(p, at)) return memberValues(p, at);
    if (p.isCallExpression()) return call(p, at);
    if (p.isObjectExpression()) return objectValues(p, at);
    return [leafOut(p)];
  }

  function objectValues(p: NodePath<any>, at: At): Out[] {
    const props = p.get('properties') as NodePath<any>[];
    const lists = props.map((prop): Out[] => (prop.isObjectProperty() ? values(prop.get('value'), at) : prop.isSpreadElement() ? values(prop.get('argument'), at) : [unknownAt(prop)]));
    return product(lists).map((outs) => merged(props.map((prop, i) => [prop.isObjectProperty() && !prop.node.computed ? keyOf(prop.node.key) : null, outs[i]]), () => undefined));
  }

  // 적힌 차례대로 키를 넣은 객체. 키가 null 인 것은 펼친 값이고, 읽지 못한 펼친 값은 그 앞의 키를 모두 가리며 그 뒤에 적히지 않은
  // 키는 restOf 가 준 값(없으면 읽지 못한 값)으로 읽힌다.
  function merged(entries: [string | null, Out][], restOf: (spread: Out) => Out | undefined): Out {
    const found = new Map<string, Out>();
    let open = false;
    let rest: Out | undefined;
    for (const [key, out] of entries) {
      if (key !== null) found.set(key, out);
      else if ('props' in out.val) {
        if (out.val.open) {
          found.clear();
          rest = out.val.rest;
        }
        for (const [k, value] of out.val.props) found.set(k, value);
        open ||= out.val.open;
      } else {
        found.clear();
        open = true;
        rest = restOf(out);
      }
    }
    return { val: { props: found, open, ...(rest && { rest }) }, made: false };
  }

  // 링크 컴포넌트를 쓴 요소의 속성을 그 컴포넌트가 받는 props 로 읽는다. 값 없이 적은 속성은 true 이고, 쓰는 곳에서 그대로 넘긴
  // 값을 펼치면 그 뒤에 적히지 않은 키는 그 값을 그대로 넘긴 것으로 본다.
  function attributeValues(e: NodePath<JSXElement>, at: At): Out[] {
    const attributes = e.get('openingElement.attributes') as NodePath<any>[];
    const lists = attributes.map((a): Out[] => {
      const value = (a.isJSXSpreadAttribute() ? a.get('argument') : a.get('value')) as NodePath<any>;
      if (!value.node) return [known(true)];
      const x = unwrapped(value.isJSXExpressionContainer() ? value.get('expression') : value);
      return x.isJSXEmptyExpression() ? [known(undefined)] : values(x, at).map((o) => wholeOr(o, x));
    });
    const keys = attributes.map((a) => (a.isJSXSpreadAttribute() ? null : a.node.name.type === 'JSXIdentifier' ? a.node.name.name as string : ''));
    const withChildren = (out: Out): Out => {
      const { val } = out;
      return e.node.children.length && 'props' in val && !val.props.has('children') ? { ...out, val: { ...val, props: new Map(val.props).set('children', unknownAt(e)) } } : out;
    };
    return product(lists).map((outs) => withChildren(merged(keys.map((key, i) => [key, outs[i]]), (spread) => spread.whole && { ...unknownAt(spread.whole), whole: spread.whole })));
  }

  function address(out: Out, at: NodePath): Out | null {
    const { val } = out;
    if ('props' in val) {
      const pathname = val.props.get('pathname');
      if (pathname) return address({ ...pathname, made: out.made || pathname.made }, at);
      return val.open ? { ...unknownAt(at), made: out.made } : null;
    }
    const value = 'value' in val ? val.value : undefined;
    if (value === null || typeof value !== 'object') return out;
    const pathname = (value as Record<string, unknown>).pathname;
    return typeof pathname === 'string' ? { ...known(pathname), made: out.made } : 'pathname' in value ? { ...unknownAt(at), made: out.made } : null;
  }

  function branch(out: Out, at: NodePath): Branch {
    const all = piecesOf(out, at);
    const [first] = all;
    const pieces = first && 'empty' in first && all.length > 1 ? [{ stop: first.empty }, ...all.slice(1)] : all;
    return {
      text: pieces.map((x) => ('text' in x ? x.text : 'stop' in x ? UNREADABLE_PIECE : '')).join(''),
      stops: pieces.flatMap((x) => ('stop' in x ? [x.stop] : [])),
      made: out.made,
      ...(out.whole && { whole: out.whole }),
      ...(out.sides && { sides: out.sides }),
    };
  }

  function branches(p: NodePath): Read {
    let outs: Out[];
    try {
      outs = values(p, OUTSIDE);
    } catch (error) {
      if (error instanceof TooMany) return { tooMany: true };
      throw error;
    }
    const found = new Map<string, Branch>();
    for (const out of outs) {
      const located = address(out, p);
      const read = located && branch(located, p);
      const key = `${read?.made}\0${read?.whole?.node.start}\0${read?.text}`;
      if (read && !found.has(key)) found.set(key, read);
    }
    return { branches: [...found.values()] };
  }

  // 함수 몸통에서 지금 규칙으로 링크가 나오지 않는 이동 자리와 그 주소 후보
  // 몸통 어디든(돌려주는 함수와 콜백 안 포함) 지금 규칙으로 링크가 나오지 않는 이동 자리와, 소스에 선언한 함수를 부르는 자리
  function placesOf(fn: AddressFunction): Places {
    if (placesFound.has(fn.node)) return placesFound.get(fn.node)!;
    const outer = [...reading];
    reading.clear();
    const found: Places = { moves: [], calls: [], elements: [], uses: [] };
    try {
      const visit = (c: NodePath<CallExpression>) => {
        if (inAddress(c)) return;
        const move = moves!.moveOf(c);
        if (!move) {
          const callee = c.get('callee') as NodePath<any>;
          const given = (c.get('arguments') as NodePath<any>[]).some((a) => usesParam(a, fn));
          const called = !given || (callee.isIdentifier() && passThrough(callee.node.name)) ? null : calledFunction(c, OUTSIDE);
          if (called && !called.node.generator) found.calls.push({ at: c, fn: called });
          return;
        }
        const history = move.recognized ? null : givenHistory(move.history, fn);
        if (!move.recognized && !history) return;
        const kept = addresses(move.address, true).filter((a) => !moves!.holdsRouteConstant(a) && (history || !moves!.linked(a)));
        if (kept.length) found.moves.push({ at: c, addresses: kept, history });
      };
      const visitElement = (e: NodePath<JSXElement>) => {
        const component = moves!.component(e);
        if (component && 'fn' in component) {
          const attributes = e.get('openingElement.attributes') as NodePath<any>[];
          if (!component.fn.node.generator && attributes.some((a) => usesParam(a, fn))) found.uses.push({ at: e, fn: component.fn });
          return;
        }
        const to = component && toOf(e);
        const kept = to ? addresses(to, true).filter((a) => !moves!.holdsRouteConstant(a) && !moves!.linked(a)) : [];
        if (kept.length) found.elements.push({ at: e, addresses: kept });
      };
      const body = fn.get('body') as NodePath<any>;
      if (body.isCallExpression()) visit(body);
      if (body.isJSXElement()) visitElement(body);
      body.traverse({ CallExpression: visit, JSXElement: visitElement });
    } finally {
      for (const node of outer) reading.add(node);
    }
    placesFound.set(fn.node, found);
    return found;
  }

  // 읽는 중에 같은 자리로 되돌아오면 링크가 있는 것으로 보고 따라가지 않는다.
  function linkedWhereWritten<T extends Node>(c: NodePath<T>, linkedAt: (c: NodePath<T>) => boolean): boolean {
    if (placeLinked.has(c.node)) return placeLinked.get(c.node)!;
    placeLinked.set(c.node, true);
    const outer = [...reading];
    reading.clear();
    try {
      const linked = linkedAt(c);
      placeLinked.set(c.node, linked);
      return linked;
    } finally {
      reading.clear();
      for (const node of outer) reading.add(node);
    }
  }

  // x 가 fn 의 매개변수를, 바로 또는 fn 안 const 의 초기값을 거쳐 쓰는가. followed 는 이미 따라간 const 와 그때의 깊이다.
  function usesParam(x: NodePath<any>, fn: AddressFunction, depth = 0, followed = new Map<Node, number>()): boolean {
    const names: NodePath<Identifier>[] = x.isIdentifier() ? [x] : [];
    x.traverse({
      Identifier(i) {
        if (i.isReferencedIdentifier()) names.push(i);
      },
    });
    return names.some((i) => {
      const binding = i.scope.getBinding(i.node.name);
      if (binding?.kind === 'param') return binding.scope.block === fn.node;
      const init = binding?.kind === 'const' && binding.path.isVariableDeclarator() && binding.path.isDescendant(fn) ? binding.path.get('init') as NodePath<any> : null;
      if (!init?.node || depth >= FOLLOWED || (followed.get(init.node) ?? Infinity) <= depth) return false;
      followed.set(init.node, depth);
      return usesParam(init, fn, depth + 1, followed);
    });
  }

  // 이동 자리가 있거나, 그런 함수를 부르는 함수인가. 되돌아오거나 깊이에서 끊겨 정한 거짓은 담아 두지 않는다.
  function helperState(fn: AddressFunction, trail: Set<Node>): { helper: boolean; cut: boolean } {
    if (helperFound.has(fn.node)) return { helper: helperFound.get(fn.node)!, cut: false };
    const { moves: found, calls } = placesOf(fn);
    let helper = found.length > 0;
    let cut = false;
    if (!helper && trail.size >= FOLLOWED) cut = calls.length > 0;
    else if (!helper) {
      trail.add(fn.node);
      for (const call of calls) {
        const inner = trail.has(call.fn.node) ? { helper: false, cut: true } : helperState(call.fn, trail);
        cut ||= inner.cut;
        if ((helper = inner.helper)) break;
      }
      trail.delete(fn.node);
    }
    if (helper || !cut) helperFound.set(fn.node, helper);
    return { helper, cut };
  }

  const isHelper = (fn: AddressFunction) => helperState(fn, new Set()).helper;

  function componentState(fn: AddressFunction, trail: Set<Node>): { link: boolean; cut: boolean } {
    if (componentFound.has(fn.node)) return { link: componentFound.get(fn.node)!, cut: false };
    const { moves: found, elements, calls, uses } = placesOf(fn);
    let link = found.length > 0 || elements.length > 0 || calls.some((call) => isHelper(call.fn));
    let cut = false;
    if (!link && trail.size >= FOLLOWED) cut = uses.length > 0;
    else if (!link) {
      trail.add(fn.node);
      for (const use of uses) {
        const inner = trail.has(use.fn.node) ? { link: false, cut: true } : componentState(use.fn, trail);
        cut ||= inner.cut;
        if ((link = inner.link)) break;
      }
      trail.delete(fn.node);
    }
    if (link || !cut) componentFound.set(fn.node, link);
    return { link, cut };
  }

  const isLinkComponent = (fn: AddressFunction) => componentState(fn, new Set()).link;

  // fn 이나 fn 이 부르는 옮겨 주는 함수에, 받은 것이 아닌 history 로 옮기는 자리가 있는가
  function movesItself(fn: AddressFunction, trail: Set<Node> = new Set()): boolean {
    const { moves: found, calls } = placesOf(fn);
    if (found.some((place) => !place.history)) return true;
    if (trail.has(fn.node) || trail.size >= FOLLOWED) return false;
    trail.add(fn.node);
    try {
      return calls.some((call) => isHelper(call.fn) && movesItself(call.fn, trail));
    } finally {
      trail.delete(fn.node);
    }
  }

  function givenHistory(history: NodePath | null, fn: AddressFunction): NodePath | null {
    const binding = history?.isIdentifier() ? history.scope.getBinding(history.node.name) : undefined;
    return binding?.kind === 'param' && binding.scope.block === fn.node ? history : null;
  }

  // 몸통에서 다시 대입하는 매개변수는 부른 곳의 값으로 읽지 않는다. 값이 undefined · null 로 정해진 주소는 버린다.
  // asComponent 이면 fn 을 JSX 로 쓴 것이라, 몸통의 링크 요소와 링크 컴포넌트의 요소도 읽는다.
  function placeOuts(fn: AddressFunction, env: Env, depth: number, asComponent = false): Out[] {
    const at: At = { env: new Map([...env].map(([b, o]) => [b, b.constant ? o : unknownAt(b.path)])), fn, branching: true, depth, consts: true };
    const outs: Out[] = [];
    const { moves: places, calls, elements, uses } = placesOf(fn);
    for (const call of calls) {
      if (reached(call.at, fn, at) && isHelper(call.fn) && !linkedWhereWritten(call.at, moves!.linkedCall)) outs.push(...helperOuts(call.at, call.fn, at));
    }
    for (const use of asComponent ? uses : []) {
      if (reached(use.at, fn, at) && isLinkComponent(use.fn) && !linkedWhereWritten(use.at, moves!.linkedUse)) outs.push(...useOuts(use.at, use.fn, at));
    }
    for (const place of [...places, ...(asComponent ? elements : [])]) {
      if (!reached(place.at, fn, at)) continue;
      if ('history' in place && place.history && !values(place.history, at).some((o) => o.whole && moves!.isHistory(o.whole))) continue;
      for (const a of place.addresses) {
        if (a.isDescendant(fn) && !reached(a, fn, at)) continue;
        for (const o of values(a, at)) {
          const located = address(wholeOr(o, a), a);
          const value = located && plain(located);
          if (located && value !== undefined && value !== null) outs.push(located);
        }
      }
    }
    return limited(outs, distinct);
  }

  // fn 안에서 p 를 둘러싼 if · ? : · && · || 가운데 값이 정해져 p 로 가지 않는 것이 있으면 거짓이다.
  function reached(p: NodePath, fn: AddressFunction, at: At): boolean {
    for (let child = p, up = p.parentPath; up && up.node !== fn.node; child = up, up = up.parentPath) {
      let test: NodePath<any>;
      let wanted: boolean;
      if ((up.isIfStatement() || up.isConditionalExpression()) && (child.key === 'consequent' || child.key === 'alternate')) {
        test = up.get('test') as NodePath<any>;
        wanted = child.key === 'consequent';
      } else if (up.isLogicalExpression() && up.node.operator !== '??' && child.key === 'right') {
        test = up.get('left');
        wanted = up.node.operator === '&&';
      } else continue;
      let truths: (boolean | undefined)[];
      try {
        truths = values(test, at).map(truth);
      } catch (error) {
        if (error instanceof TooMany) continue;
        throw error;
      }
      if (!truths.includes(wanted) && !truths.includes(undefined)) return false;
    }
    return true;
  }

  function helperOuts(p: NodePath<CallExpression>, fn: AddressFunction, at: At): Out[] {
    if (reading.has(fn.node) || at.depth >= FOLLOWED) return [];
    const args = p.get('arguments') as NodePath<any>[];
    const spread = args.findIndex((a) => a.isSpreadElement());
    const given = { ...at, branching: true };
    const lists = limited(product((spread < 0 ? args : args.slice(0, spread)).map((a) => values(a, given).map((o) => wholeOr(o, a)))));
    reading.add(fn.node);
    try {
      const outs = lists.flatMap((list) => bound(fn, list, spread < 0 ? null : args[spread], at.depth + 1).flatMap((env) => placeOuts(fn, env, at.depth + 1)));
      return outs.some(withheldIn) ? [unknownAt(p)] : outs;
    } finally {
      reading.delete(fn.node);
    }
  }

  function useOuts(e: NodePath<JSXElement>, fn: AddressFunction, at: At): Out[] {
    if (reading.has(fn.node) || at.depth >= FOLLOWED) return [];
    const lists = limited(attributeValues(e, { ...at, branching: true }));
    reading.add(fn.node);
    try {
      const outs = lists.flatMap((props) => bound(fn, [props], null, at.depth + 1).flatMap((env) => placeOuts(fn, env, at.depth + 1, true)));
      return outs.some(withheldIn) ? [unknownAt(e)] : outs;
    } finally {
      reading.delete(fn.node);
    }
  }

  function madeBranches(outs: Out[], p: NodePath): Read {
    const found = new Map<string, Branch>();
    for (const out of outs) {
      const read = { ...branch(out, p), made: true };
      const key = `${read.whole?.node.start}\0${read.text}`;
      if (!found.has(key)) found.set(key, read);
    }
    return { branches: [...found.values()] };
  }

  // 링크 컴포넌트를 쓴 요소에서, 그 컴포넌트 안의 링크와 이동이 가는 주소를 요소의 속성으로 읽는다. 링크 컴포넌트가 아니면 null 이다.
  function useBranches(e: NodePath<JSXElement>): Read | null {
    const component = moves?.component(e);
    if (!component || !('fn' in component) || component.fn.node.generator || !isLinkComponent(component.fn)) return null;
    try {
      return madeBranches(useOuts(e, component.fn, OUTSIDE), e);
    } catch (error) {
      if (error instanceof TooMany) return { tooMany: true };
      throw error;
    }
  }

  // 받은 주소로 옮기는 함수를 부른 곳에서, 그 이동이 가는 주소를 부른 곳의 인자로 읽는다. 그런 함수가 아니면 null 이다.
  // 갈래가 너무 많으면 {?} 를 주되, 받은 history 로만 옮기는 함수면 null 이다.
  function helperBranches(p: NodePath<CallExpression>): Read | null {
    if (!moves || inAddress(p)) return null;
    const callee = p.get('callee') as NodePath<any>;
    if (callee.isIdentifier() && passThrough(callee.node.name)) return null;
    const fn = calledFunction(p, OUTSIDE);
    if (!fn || fn.node.generator || !isHelper(fn)) return null;
    let outs: Out[];
    try {
      outs = helperOuts(p, fn, OUTSIDE);
    } catch (error) {
      if (error instanceof TooMany) return movesItself(fn) ? { tooMany: true } : null;
      throw error;
    }
    return madeBranches(outs, p);
  }

  // 이동의 주소 자리나 링크 요소의 to 안에 있는 호출
  function inAddress(p: NodePath<any>): boolean {
    for (let child = p, up = p.parentPath; up && !up.isFunction() && !up.isStatement(); child = up, up = up.parentPath) {
      if (up.isCallExpression() && child.listKey === 'arguments' && child.key === 0 && moves!.moveOf(up)) return true;
      if (up.isJSXAttribute() && up.node.name.name === 'to') return true;
    }
    return false;
  }

  return { branches, helperBranches, useBranches };
}
