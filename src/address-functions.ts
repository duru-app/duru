import type { Binding, NodePath, Scope } from '@babel/traverse';
import type { ArrowFunctionExpression, CallExpression, FunctionDeclaration, FunctionExpression, Identifier, Node, StringLiteral } from '@babel/types';
import { addresses, FOLLOWED } from './screen-links.ts';
import type { Move } from './screen-links.ts';

export const UNREADABLE_PIECE = '\0';
export const MOST_ADDRESSES = 8;
const MOST_BRANCHES = 64;

export type AddressFunction = NodePath<ArrowFunctionExpression | FunctionExpression | FunctionDeclaration>;
// value 는 끝까지 읽은 값이고, parts 는 고정 문자열과 읽다 멈춘 지점을 순서대로 담는다.
export type Leaf = { value: unknown } | { parts: (string | NodePath)[] };
// whole 은 함수가 받은 인자를 그대로 돌려준 갈래의, 부른 곳에 적힌 그 인자다.
export type Branch = { text: string; stops: NodePath[]; made: boolean; whole?: NodePath };
export type Read = { branches: Branch[] } | { tooMany: true };

interface Reading {
  leaf: (p: NodePath) => Leaf;
  declaredValue: (scope: Scope, name: string) => NodePath | null;
  declaredFunction: (scope: Scope, name: string) => AddressFunction | null;
  namespaceFunction: (scope: Scope, chain: string[]) => AddressFunction | null;
  passThrough: (name: string) => boolean;
  moves?: Moves;
}

// linked 는 주소 자리 하나가, linkedCall 은 옮겨 주는 함수를 부른 자리 하나가 그 자리에 링크를 내는가다.
interface Moves {
  moveOf: (p: NodePath<CallExpression>) => Move | null;
  linked: (p: NodePath) => boolean;
  linkedCall: (p: NodePath<CallExpression>) => boolean;
  isHistory: (p: NodePath) => boolean;
  holdsRouteConstant: (p: NodePath) => boolean;
}

// empty 는 함수가 돌려준 빈 문자열이다. 주소 맨 앞에 오면 읽지 못한 조각으로 본다.
type Piece = { text: string; made?: boolean } | { stop: NodePath } | { empty: NodePath };
type Val =
  | { pieces: Piece[] }
  | { value: unknown }
  | { props: Map<string, Out>; open: boolean }
  | { items: Out[] }
  | { unknown: NodePath };
type Out = { val: Val; made: boolean; whole?: NodePath };
type Env = Map<Binding, Out>;
// consts 이면 fn 안에서 const 로 선언한 이름을 그 초기값으로 읽는다.
interface At { env: Env | null; fn: AddressFunction | null; branching: boolean; depth: number; consts?: boolean }
// history 는 함수가 매개변수로 받은 history 로 옮기는 자리의 그 매개변수다.
type MovePlace = { at: NodePath<CallExpression>; addresses: NodePath[]; history: NodePath | null };
type Places = { moves: MovePlace[]; calls: { at: NodePath<CallExpression>; fn: AddressFunction }[] };

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

function joined(parts: [Out, NodePath][]): Out {
  const pieces: Piece[] = [];
  for (const piece of parts.flatMap(([out, at]) => piecesOf(out, at))) {
    const last = pieces.at(-1);
    if ('empty' in piece && pieces.length) continue;
    if ('text' in piece && last && 'text' in last && last.text.endsWith('/') && piece.text.startsWith('/') && (last.made || piece.made)) {
      if (piece.text.length > 1) pieces.push({ ...piece, text: piece.text.slice(1) });
    } else pieces.push(piece);
  }
  return { val: { pieces }, made: parts.some(([out]) => out.made) };
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
  if ('props' in val) return val.props.get(key) ?? (val.open ? unknownAt(at) : known(undefined));
  if ('items' in val) return key === 'length' ? known(val.items.length) : unknownAt(at);
  if ('unknown' in val) return out;
  const value = plain(out);
  if (typeof value === 'string' && key === 'length') return known(value.length);
  return value !== null && typeof value === 'object' ? known((value as Record<string, unknown>)[key]) : unknownAt(at);
}

const keyOfOut = ({ val, made, whole }: Out) => ('pieces' in val ? `${made}\0${whole?.node.start}\0${val.pieces.map((x) => ('text' in x ? x.text : 'stop' in x ? UNREADABLE_PIECE : '\u0001')).join('')}` : null);

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

function touchesOwn(x: NodePath<any>, fn: AddressFunction): boolean {
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

const hasText = ({ val }: Out) => 'pieces' in val && val.pieces.some((x) => 'text' in x);
// 부른 곳에 적힌 값 그대로인 것에는 그 식을 whole 로 단다.
const wholeOr = (o: Out, p: NodePath): Out => (o.made || o.whole || hasText(o) ? o : { ...o, whole: p });

const unwrapped = (p: NodePath<any>): NodePath<any> => (p.isTSAsExpression() || p.isTSSatisfiesExpression() || p.isTSNonNullExpression() || p.isTypeCastExpression() || p.isParenthesizedExpression() ? unwrapped(p.get('expression') as NodePath<any>) : p);

export function addressReader({ leaf, declaredValue, declaredFunction, namespaceFunction, passThrough, moves }: Reading) {
  const reading = new Set<Node>();
  const placesFound = new WeakMap<Node, Places>();
  const helperFound = new WeakMap<Node, boolean>();
  const callLinked = new WeakMap<Node, boolean>();

  function leafOut(p: NodePath): Out {
    const found = leaf(p);
    if ('parts' in found) return { val: { pieces: found.parts.flatMap((x): Piece[] => (typeof x !== 'string' ? [{ stop: x }] : x ? [{ text: x }] : [])) }, made: false };
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
    if ('items' in list.val) return joined(list.val.items.flatMap((item, i): [Out, NodePath][] => (i ? [[textOut(glue), at], [item, at]] : [[item, at]])));
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
    reading.add(fn.node);
    try {
      const outs = distinct(lists.flatMap((list) => bound(fn, list, spread < 0 ? null : args[spread], at.depth + 1).flatMap((e) => returnedValues(fn, e, p, at.depth + 1))));
      return limited(outs).map((o) => {
        const whole = o.whole && { whole: o.whole };
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
      for (const prop of pattern.get('properties') as NodePath<any>[]) {
        if (prop.isObjectProperty() && !prop.node.computed) envs = bind(prop.get('value'), out ? member(out, keyOf(prop.node.key), prop) : unknownAt(prop), envs, inner);
        else envs = bind((prop.isRestElement() ? prop.get('argument') : prop.get('value')) as NodePath<any>, unknownAt(prop), envs, inner);
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

  function returnedValues(fn: AddressFunction, env: Env, at: NodePath, depth: number): Out[] {
    const body = fn.get('body') as NodePath<any>;
    if (!body.isBlockStatement()) return values(body, { env, fn, branching: true, depth });
    const { returned, open } = walk(body.get('body'), [env], fn, depth);
    return [...returned, ...open.map(() => unknownAt(at))];
  }

  function walk(statements: NodePath<any>[], envs: Env[], fn: AddressFunction, depth: number): { returned: Out[]; open: Env[] } {
    const returned: Out[] = [];
    const inner = (env: Env): At => ({ env, fn, branching: true, depth });
    for (const s of statements) {
      if (!envs.length) break;
      if (s.isReturnStatement()) {
        for (const e of envs) returned.push(...(s.node.argument ? values(s.get('argument'), inner(e)) : [known(undefined)]));
        envs = [];
      } else if (s.isIfStatement()) {
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
            returned.push(...found.returned);
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
        if (!left.isIdentifier() && inEnv(left, inner(envs[0]))) throw new Unreadable();
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
    return typeof a === 'number' && typeof b === 'number' ? known(a + b) : joined([[left, leftAt], [right, rightAt]]);
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
    if (p.isStringLiteral()) return [textOut(p.node.value)];
    if (p.isNumericLiteral() || p.isBooleanLiteral()) return [known(p.node.value)];
    if (p.isNullLiteral()) return [known(null)];
    if (p.isTemplateLiteral()) {
      const lists = p.node.quasis.flatMap((q, i): [Out, NodePath][][] => {
        const quasi: [Out, NodePath][] = [[textOut(q.value.cooked ?? ''), p]];
        if (i === p.node.expressions.length) return [quasi];
        const expression = p.get(`expressions.${i}`) as NodePath;
        return [quasi, values(expression, at).map((o): [Out, NodePath] => [o, expression])];
      });
      return product(lists).map(joined);
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
    if (p.isConditionalExpression() && at.branching) return choose(values(p.get('test'), at), truth, () => values(p.get('consequent'), at), () => values(p.get('alternate'), at));
    if (p.isLogicalExpression() && at.branching) {
      const right = () => values(p.get('right'), at);
      const left = values(p.get('left'), at);
      if (p.node.operator === '??') return choose(left, (o) => (plain(o) === NOT_KNOWN && !truth(o) ? undefined : plain(o) === null || plain(o) === undefined), right, (o) => [o]);
      return choose(left, truth, p.node.operator === '||' ? (o) => [o] : right, p.node.operator === '||' ? right : (o) => [o]);
    }
    if (p.isIdentifier()) return identifier(p, at);
    if ((p.isMemberExpression() || p.isOptionalMemberExpression()) && inEnv(p, at)) {
      const key = (p.node.property as Identifier).name;
      return values(p.get('object') as NodePath, at).map((o) => member(o, key, p));
    }
    if (p.isCallExpression()) return call(p, at);
    if (p.isObjectExpression()) return objectValues(p, at);
    return [leafOut(p)];
  }

  function objectValues(p: NodePath<any>, at: At): Out[] {
    const props = p.get('properties') as NodePath<any>[];
    const lists = props.map((prop): Out[] => (prop.isObjectProperty() ? values(prop.get('value'), at) : prop.isSpreadElement() ? values(prop.get('argument'), at) : [unknownAt(prop)]));
    return product(lists).map((outs) => {
      const found = new Map<string, Out>();
      let open = false;
      props.forEach((prop, i) => {
        const out = outs[i];
        if (prop.isObjectProperty() && !prop.node.computed) found.set(keyOf(prop.node.key), out);
        else if (prop.isSpreadElement() && 'props' in out.val) {
          for (const [key, value] of out.val.props) found.set(key, value);
          open ||= out.val.open;
        } else open = true;
      });
      return { val: { props: found, open }, made: false };
    });
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
    const found: Places = { moves: [], calls: [] };
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
      const body = fn.get('body') as NodePath<any>;
      if (body.isCallExpression()) visit(body);
      body.traverse({ CallExpression: visit });
    } finally {
      for (const node of outer) reading.add(node);
    }
    placesFound.set(fn.node, found);
    return found;
  }

  // 읽는 중에 같은 호출로 되돌아오면 링크가 있는 것으로 보고 따라가지 않는다.
  function linkedWhereWritten(c: NodePath<CallExpression>): boolean {
    if (callLinked.has(c.node)) return callLinked.get(c.node)!;
    callLinked.set(c.node, true);
    const outer = [...reading];
    reading.clear();
    try {
      const linked = moves!.linkedCall(c);
      callLinked.set(c.node, linked);
      return linked;
    } finally {
      reading.clear();
      for (const node of outer) reading.add(node);
    }
  }

  // x 가 fn 의 매개변수를, 바로 또는 fn 안 const 의 초기값을 거쳐 쓰는가
  function usesParam(x: NodePath<any>, fn: AddressFunction, depth = 0): boolean {
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
      return Boolean(init?.node) && depth < FOLLOWED && usesParam(init!, fn, depth + 1);
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

  function givenHistory(history: NodePath | null, fn: AddressFunction): NodePath | null {
    const binding = history?.isIdentifier() ? history.scope.getBinding(history.node.name) : undefined;
    return binding?.kind === 'param' && binding.scope.block === fn.node ? history : null;
  }

  // 몸통에서 다시 대입하는 매개변수는 부른 곳의 값으로 읽지 않는다. 값이 undefined · null 로 정해진 주소는 버린다.
  function placeOuts(fn: AddressFunction, env: Env, depth: number): Out[] {
    const at: At = { env: new Map([...env].map(([b, o]) => [b, b.constant ? o : unknownAt(b.path)])), fn, branching: true, depth, consts: true };
    const outs: Out[] = [];
    const { moves: places, calls } = placesOf(fn);
    for (const call of calls) {
      if (reached(call.at, fn, at) && isHelper(call.fn) && !linkedWhereWritten(call.at)) outs.push(...helperOuts(call.at, call.fn, at));
    }
    for (const place of places) {
      if (!reached(place.at, fn, at)) continue;
      if (place.history && !values(place.history, at).some((o) => o.whole && moves!.isHistory(o.whole))) continue;
      for (const a of place.addresses) {
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
      return lists.flatMap((list) => bound(fn, list, spread < 0 ? null : args[spread], at.depth + 1).flatMap((env) => placeOuts(fn, env, at.depth + 1)));
    } finally {
      reading.delete(fn.node);
    }
  }

  // 받은 주소로 옮기는 함수를 부른 곳에서, 그 이동이 가는 주소를 부른 곳의 인자로 읽는다. 그런 함수가 아니면 null 이다.
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
      if (error instanceof TooMany) return { tooMany: true };
      throw error;
    }
    const found = new Map<string, Branch>();
    for (const out of outs) {
      const read = { ...branch(out, p), made: true };
      const key = `${read.whole?.node.start}\0${read.text}`;
      if (!found.has(key)) found.set(key, read);
    }
    return { branches: [...found.values()] };
  }

  // 이동의 주소 자리나 링크 요소의 to 안에 있는 호출
  function inAddress(p: NodePath<any>): boolean {
    for (let child = p, up = p.parentPath; up && !up.isFunction() && !up.isStatement(); child = up, up = up.parentPath) {
      if (up.isCallExpression() && child.listKey === 'arguments' && child.key === 0 && moves!.moveOf(up)) return true;
      if (up.isJSXAttribute() && up.node.name.name === 'to') return true;
    }
    return false;
  }

  return { branches, helperBranches };
}
