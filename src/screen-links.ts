import type { Binding, NodePath } from '@babel/traverse';
import type { CallExpression, Identifier, JSXAttribute, JSXElement, MemberExpression, ObjectProperty } from '@babel/types';
import { keyName } from './client.ts';
import { importedAs, routerImport } from './screen-requests.ts';

interface Reading {
  configuredHistory: (binding: Binding) => boolean;
  routerElement: (p: NodePath<JSXElement>) => string | null;
}

export const LINK_ELEMENTS = new Set(['Link', 'NavLink', 'Redirect', 'Navigate']);
const REDIRECTS = new Set(['Redirect', 'Navigate']);
const MOVES = new Set(['push', 'replace']);
export const FOLLOWED = 8;

const named = (p: NodePath<any>, name: string) => (p.isMemberExpression() || p.isOptionalMemberExpression()) && !p.node.computed && (p.node.property as Identifier).name === name;
const isProps = (p: NodePath<any>) => (named(p, 'props') && (p.get('object') as NodePath<any>).isThisExpression()) || p.isIdentifier({ name: 'props' });

function lastValue(object: NodePath<any>, key: string) {
  const prop = (object.get('properties') as NodePath<any>[]).findLast((x) => x.isObjectProperty() && !x.node.computed && keyName(x.node) === key);
  return prop?.get('value') as NodePath<any> | undefined;
}

function declaredInit(p: NodePath<Identifier>) {
  const binding = p.scope.getBinding(p.node.name);
  if (!binding?.path.isVariableDeclarator() || !['const', 'let', 'var'].includes(binding.kind)) return null;
  const init = binding.path.get('init') as NodePath<any>;
  return init.node ? { id: binding.path.node.id, init } : null;
}

function takenFrom(p: NodePath<Identifier>, key: string, from: (init: NodePath<any>) => boolean) {
  const declared = declaredInit(p);
  if (declared?.id.type !== 'ObjectPattern') return false;
  const prop = declared.id.properties.find((x): x is ObjectProperty => x.type === 'ObjectProperty' && !x.computed && keyName(x) === key);
  return prop?.value.type === 'Identifier' && prop.value.name === p.node.name && from(declared.init);
}

const isComponent = (fn: NodePath<any>) => {
  if (fn.parentPath?.isExportDefaultDeclaration()) return true;
  const id = fn.isFunctionDeclaration() ? fn.node.id : fn.key === 'init' && fn.parentPath?.isVariableDeclarator() ? fn.parentPath.node.id : null;
  return id?.type === 'Identifier' && /^[A-Z]/.test(id.name);
};

function takenFromComponentProps(p: NodePath<Identifier>, binding: Binding) {
  const param = binding.path;
  if (!param.isObjectPattern() || param.listKey !== 'params' || param.key !== 0 || !isComponent(param.parentPath!)) return false;
  return param.node.properties.some((x) => x.type === 'ObjectProperty' && !x.computed && keyName(x) === 'history' && x.value.type === 'Identifier' && x.value.name === p.node.name);
}

const isLocation = (p: NodePath<any>): boolean => p.isIdentifier({ name: 'location' }) || named(p, 'location')
  || (p.isCallExpression() && p.get('callee').isIdentifier({ name: 'useLocation' }));

const neverAssigned = (p: NodePath<any>) => p.isIdentifier() && Boolean(p.scope.getBinding(p.node.name)?.constant);

function readsLocation(p: NodePath<any>, key: string, depth = 0): boolean {
  if (named(p, key)) return isLocation(p.get('object') as NodePath<any>);
  if (!neverAssigned(p) || depth > FOLLOWED) return false;
  const declared = declaredInit(p);
  if (declared?.id.type === 'Identifier') return readsLocation(declared.init, key, depth + 1);
  return takenFrom(p, key, isLocation);
}

const readsPathname = (p: NodePath<any>) => readsLocation(p, 'pathname');

const isNumber = (p: NodePath<any>) => p.isNumericLiteral() || (p.isUnaryExpression({ operator: '-' }) && p.get('argument').isNumericLiteral());

const queryOrHash = (text: string | null | undefined) => text === '' || /^[?#]/.test(text ?? '-');

function startsWithQueryOrHash(p: NodePath<any>, depth = 0): boolean {
  if (p.isStringLiteral()) return /^[?#]/.test(p.node.value);
  if (p.isTemplateLiteral()) return /^[?#]/.test(p.node.quasis[0].value.cooked ?? '');
  if (readsLocation(p, 'search') || readsLocation(p, 'hash')) return true;
  const declared = neverAssigned(p) && depth <= FOLLOWED ? declaredInit(p as NodePath<Identifier>) : null;
  return declared?.id.type === 'Identifier' && startsWithQueryOrHash(declared.init, depth + 1);
}
const afterPathname = (p: NodePath<any>) => (p.isStringLiteral() ? queryOrHash(p.node.value)
  : p.isTemplateLiteral() ? queryOrHash(p.node.quasis[0].value.cooked) : startsWithQueryOrHash(p));

function staysHere(p: NodePath<any>) {
  if (readsPathname(p) || startsWithQueryOrHash(p)) return true;
  if (p.isTemplateLiteral()) return p.node.quasis[0].value.cooked === '' && readsPathname(p.get('expressions.0') as NodePath) && queryOrHash(p.node.quasis[1].value.cooked);
  let left = p;
  let right: NodePath<any> | null = null;
  while (left.isBinaryExpression({ operator: '+' })) {
    right = left.get('right');
    left = left.get('left');
  }
  return right !== null && (startsWithQueryOrHash(left) || (readsPathname(left) && afterPathname(right)));
}

const isMember = (p: NodePath<any>) => p.isMemberExpression() || p.isOptionalMemberExpression();

function handedIn(p: NodePath<any>, depth = 0): boolean {
  if (isProps(p)) return true;
  if (depth > FOLLOWED) return false;
  if (isMember(p)) return handedIn(p.get('object') as NodePath<any>, depth + 1);
  if (!p.isIdentifier()) return false;
  if (p.scope.getBinding(p.node.name)?.kind === 'param') return true;
  const declared = declaredInit(p);
  return Boolean(declared) && handedIn(declared!.init, depth + 1);
}

export function madeFrom(p: NodePath<any>, depth = 0): NodePath[] {
  if (depth > FOLLOWED) return [p];
  if (isMember(p)) return [p, ...madeFrom(p.get('object') as NodePath<any>, depth + 1)];
  const declared = p.isIdentifier() ? declaredInit(p) : null;
  return declared ? [p, ...madeFrom(declared.init, depth + 1)] : [p];
}

export function addresses(p: NodePath<any>, keepHandedIn = false): NodePath[] {
  if (p.isConditionalExpression()) return [...addresses(p.get('consequent'), keepHandedIn), ...addresses(p.get('alternate'), keepHandedIn)];
  if (p.isObjectExpression()) {
    const pathname = lastValue(p, 'pathname');
    return pathname ? addresses(pathname, keepHandedIn) : [];
  }
  const declared = p.isIdentifier() ? declaredInit(p) : null;
  if (declared?.id.type === 'Identifier' && declared.init.isObjectExpression()) return addresses(declared.init, keepHandedIn);
  return staysHere(p) || (!keepHandedIn && handedIn(p)) ? [] : [p];
}

// history 는 useNavigate() 가 돌려준 함수로 옮길 때 null 이다.
export type Move = { address: NodePath; history: NodePath | null; recognized: boolean };

export function toOf(p: NodePath<JSXElement>): NodePath<any> | null {
  const to = (p.get('openingElement.attributes') as NodePath<any>[]).find((a) => a.isJSXAttribute() && a.node.name.name === 'to') as NodePath<JSXAttribute> | undefined;
  const value = to?.get('value') as NodePath<any> | undefined;
  if (!value?.node) return null;
  return value.isJSXExpressionContainer() ? value.get('expression') : value;
}

export function screenLinkReader({ configuredHistory, routerElement }: Reading) {
  function isHistory(p: NodePath<any>, depth = 0): boolean {
    if (named(p, 'history')) return isProps(p.get('object') as NodePath<any>);
    if (p.isCallExpression()) {
      const callee = p.get('callee');
      const binding = callee.isIdentifier() ? callee.scope.getBinding(callee.node.name) : undefined;
      if (!binding) return false;
      return (routerImport(binding) && importedAs(binding)!.name === 'useHistory') || (!p.node.arguments.length && configuredHistory(binding));
    }
    if (!p.isIdentifier() || depth > FOLLOWED) return false;
    const binding = p.scope.getBinding(p.node.name);
    if (binding?.kind === 'module') return configuredHistory(binding);
    if (binding?.kind === 'param') return takenFromComponentProps(p, binding);
    const declared = declaredInit(p);
    if (declared?.id.type === 'Identifier') return isHistory(declared.init, depth + 1);
    return takenFrom(p, 'history', isProps);
  }

  function element(p: NodePath<JSXElement>, inRouteFile: boolean): NodePath[] {
    const tag = routerElement(p);
    const to = tag && !(REDIRECTS.has(tag) && inRouteFile) ? toOf(p) : null;
    return to ? addresses(to) : [];
  }

  function isNavigate(p: NodePath<any>, depth = 0): boolean {
    if (p.isCallExpression()) {
      const callee = p.get('callee');
      const binding = callee.isIdentifier() ? callee.scope.getBinding(callee.node.name) : undefined;
      return routerImport(binding) && importedAs(binding!)!.name === 'useNavigate';
    }
    if (!p.isIdentifier() || depth > FOLLOWED) return false;
    const declared = declaredInit(p);
    return declared?.id.type === 'Identifier' && isNavigate(declared.init, depth + 1);
  }

  function moveOf(p: NodePath<CallExpression>): Move | null {
    const callee = p.get('callee') as NodePath<any>;
    const [address] = p.get('arguments') as NodePath<any>[];
    if (!address || address.isSpreadElement()) return null;
    if (callee.isIdentifier()) return isNavigate(callee) && !isNumber(address) ? { address, history: null, recognized: true } : null;
    if (!callee.isMemberExpression() || callee.node.computed || !MOVES.has(((callee.node as MemberExpression).property as Identifier).name)) return null;
    const history = callee.get('object');
    return { address, history, recognized: isHistory(history) };
  }

  function call(p: NodePath<CallExpression>): NodePath[] {
    const move = moveOf(p);
    return move?.recognized ? addresses(move.address) : [];
  }

  return { element, call, moveOf, isHistory };
}
