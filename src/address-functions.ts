import type { NodePath, Scope } from '@babel/traverse';
import type { ArrowFunctionExpression, FunctionDeclaration, FunctionExpression, Identifier, Node } from '@babel/types';

export const UNREADABLE_PIECE = '\0';

export type AddressFunction = NodePath<ArrowFunctionExpression | FunctionExpression | FunctionDeclaration>;
// value 는 끝까지 읽은 값이고, parts 는 고정 문자열과 읽다 멈춘 지점을 순서대로 담는다.
export type Leaf = { value: unknown } | { parts: (string | NodePath)[] };
export type Branch = { text: string; stops: NodePath[]; made: boolean };

interface Reading {
  leaf: (p: NodePath) => Leaf;
  declaredFunction: (scope: Scope, name: string) => AddressFunction | null;
  namespaceFunction: (scope: Scope, chain: string[]) => AddressFunction | null;
}

type Piece = { text: string; made?: boolean } | { stop: NodePath };
type Out = { pieces: Piece[]; made: boolean };

const text = (value: string): Out => ({ pieces: value ? [{ text: value }] : [], made: false });

function joined(outs: Out[]): Out {
  const pieces: Piece[] = [];
  for (const piece of outs.flatMap((o) => o.pieces)) {
    const last = pieces.at(-1);
    if ('text' in piece && last && 'text' in last && last.text.endsWith('/') && piece.text.startsWith('/') && (last.made || piece.made)) {
      if (piece.text.length > 1) pieces.push({ ...piece, text: piece.text.slice(1) });
    } else pieces.push(piece);
  }
  return { pieces, made: outs.some((o) => o.made) };
}

const product = (lists: Out[][]): Out[] => lists.reduce<Out[][]>((acc, list) => acc.flatMap((a) => list.map((o) => [...a, o])), [[]]).map(joined);

export function addressReader({ leaf, declaredFunction, namespaceFunction }: Reading) {
  const reading = new Set<Node>();

  function fromLeaf(p: NodePath): Out {
    const found = leaf(p);
    if ('parts' in found) return { pieces: found.parts.map((x) => (typeof x === 'string' ? { text: x } : { stop: x })).filter((x) => !('text' in x) || x.text), made: false };
    return typeof found.value === 'string' || typeof found.value === 'number' ? text(String(found.value)) : { pieces: [{ stop: p }], made: false };
  }

  function calledFunction(p: NodePath<any>) {
    const callee = p.get('callee') as NodePath<any>;
    if (callee.isIdentifier()) return declaredFunction(p.scope, callee.node.name);
    const object = callee.isMemberExpression() && !callee.node.computed ? callee.get('object') as NodePath<any> : null;
    return object?.isIdentifier() ? namespaceFunction(p.scope, [object.node.name, (callee.node.property as Identifier).name]) : null;
  }

  function returned(fn: AddressFunction) {
    const body = fn.get('body') as NodePath<any>;
    if (!body.isBlockStatement()) return body;
    const [only, ...rest] = body.get('body') as NodePath<any>[];
    return only?.isReturnStatement() && only.node.argument && !rest.length ? (only.get('argument') as NodePath) : null;
  }

  function call(p: NodePath): Out[] | null {
    const fn = calledFunction(p);
    if (!fn || fn.node.async || fn.node.generator || reading.has(fn.node)) return null;
    const body = returned(fn);
    if (!body) return null;
    reading.add(fn.node);
    try {
      return values(body).map((o) => ({ pieces: o.pieces.map((x) => ('text' in x ? { ...x, made: true } : x)), made: true }));
    } finally {
      reading.delete(fn.node);
    }
  }

  function values(p: NodePath<any>): Out[] {
    if (p.isStringLiteral()) return [text(p.node.value)];
    if (p.isTemplateLiteral()) {
      const quasis = p.node.quasis.map((q) => [text(q.value.cooked ?? '')]);
      return product(quasis.flatMap((q, i) => (i < p.node.expressions.length ? [q, values(p.get(`expressions.${i}`) as NodePath)] : [q])));
    }
    if (p.isBinaryExpression({ operator: '+' })) return product([values(p.get('left')), values(p.get('right'))]);
    if (p.isCallExpression()) return call(p) ?? [fromLeaf(p)];
    return [fromLeaf(p)];
  }

  function branch({ pieces, made }: Out): Branch {
    return {
      text: pieces.map((x) => ('text' in x ? x.text : UNREADABLE_PIECE)).join(''),
      stops: pieces.flatMap((x) => ('stop' in x ? [x.stop] : [])),
      made,
    };
  }

  return { branches: (p: NodePath): Branch[] => values(p).map(branch) };
}
