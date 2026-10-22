import type { Binding, NodePath, Scope } from '@babel/traverse';
import type { ArrowFunctionExpression, ClassDeclaration, ClassMethod, FunctionDeclaration, FunctionExpression, Identifier, Node, StringLiteral } from '@babel/types';
import { FOLLOWED } from './screen-links.ts';

export const UNREADABLE_PIECE = '\0';
export const MOST_ADDRESSES = 8;
const MOST_BRANCHES = 64;

export type AddressFunction = NodePath<ArrowFunctionExpression | FunctionExpression | FunctionDeclaration>;
type Followable = AddressFunction | NodePath<ClassMethod>;
// value 는 끝까지 읽은 값이고, parts 는 고정 문자열과 읽다 멈춘 지점을 순서대로 담는다.
// withheld 는 값을 알지만 이 읽기가 받지 않는 조각이라, 함수 호출을 거쳐 주소에 들어가면 그 호출을 읽지 못한 조각으로 둔다.
export type Leaf = { value: unknown } | { parts: (string | NodePath)[]; withheld?: boolean };
// whole 은 함수가 받은 인자를 그대로 돌려준 갈래의, 부른 곳에 적힌 그 인자다.
export type Branch = { text: string; stops: NodePath[]; made: boolean; whole?: NodePath };
export type Read = { branches: Branch[] } | { tooMany: true };

interface Reading {
  leaf: (p: NodePath) => Leaf;
  declaredValue: (scope: Scope, name: string) => NodePath | null;
  declaredFunction: (scope: Scope, name: string) => AddressFunction | null;
  namespaceFunction: (scope: Scope, chain: string[]) => AddressFunction | null;
  declaredClass: (scope: Scope, name: string) => NodePath<ClassDeclaration> | null;
  passThrough: (name: string) => boolean;
  mergesSlashes: boolean;
}

// empty 는 함수가 돌려준 빈 문자열이다. 주소 맨 앞에 오면 읽지 못한 조각으로 본다.
type Piece = { text: string; made?: boolean } | { stop: NodePath; withheld?: boolean } | { empty: NodePath };
type Val =
  | { pieces: Piece[] }
  | { value: unknown }
  | { props: Map<string, Out>; open: boolean }
  | { items: Out[] }
  | { unknown: NodePath };
type Out = { val: Val; made: boolean; whole?: NodePath };
type Env = Map<Binding, Out>;
interface At { env: Env | null; fn: Followable | null; branching: boolean; depth: number }

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

// 갈래로 고르거나 이름에 넣는 빈 문자열. 함수 몸통에서 이것이 주소 맨 앞에 오면 함수가 돌려준 빈 문자열처럼 읽지 못한 조각으로 본다.
function choosesText(p: NodePath): boolean {
  const { parentPath: parent, key } = p;
  if (!parent) return false;
  if (parent.isParenthesizedExpression() || parent.isTSAsExpression()) return choosesText(parent);
  if (parent.isConditionalExpression()) return key !== 'test';
  if (parent.isLogicalExpression() || parent.isAssignmentExpression() || parent.isAssignmentPattern()) return key === 'right';
  return parent.isVariableDeclarator() || parent.isReturnStatement() || parent.isArrowFunctionExpression();
}

// 읽지 못한 조각만으로 되어 있어 무슨 값인지 모르는 값
const opaque = ({ val }: Out) => 'unknown' in val || ('pieces' in val && val.pieces.length > 0 && val.pieces.every((x) => 'stop' in x));

const unwrapped = (p: NodePath<any>): NodePath<any> => (p.isTSAsExpression() || p.isTSSatisfiesExpression() || p.isTSNonNullExpression() || p.isTypeCastExpression() || p.isParenthesizedExpression() ? unwrapped(p.get('expression') as NodePath<any>) : p);

export function addressReader({ leaf, declaredValue, declaredFunction, namespaceFunction, declaredClass, passThrough, mergesSlashes }: Reading) {
  const reading = new Set<Node>();
  const join = (parts: [Out, NodePath][]) => joined(parts, mergesSlashes);

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
    if (binding && at.fn && binding.path.isDescendant(at.fn)) return [unknownAt(p)];
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
      return followed(getter, p, () => returnedValues(getter, new Map(), p, at.depth + 1));
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
    return at.env ? outs : outs.map((o) => (o.made || o.whole || 'pieces' in o.val && o.val.pieces.some((x) => 'text' in x) ? o : { ...o, whole: p }));
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
    if (p.isConditionalExpression() && at.branching) return choose(values(p.get('test'), at), truth, () => values(p.get('consequent'), at), () => values(p.get('alternate'), at));
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
    return product(lists).map((outs) => {
      const found = new Map<string, Out>();
      let open = false;
      props.forEach((prop, i) => {
        const out = outs[i];
        if (prop.isObjectProperty() && !prop.node.computed) found.set(keyOf(prop.node.key), out);
        else if (prop.isSpreadElement() && 'props' in out.val) {
          if (out.val.open) found.clear();
          for (const [key, value] of out.val.props) found.set(key, value);
          open ||= out.val.open;
        } else {
          found.clear();
          open = true;
        }
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

  return { branches };
}
