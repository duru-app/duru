import type { Binding, NodePath } from '@babel/traverse';
import type { CallExpression, Identifier, JSXAttribute, JSXElement, MemberExpression, ObjectProperty } from '@babel/types';
import { keyName } from './client.ts';
import { importedAs, routerImport } from './screen-requests.ts';

interface Reading {
  configuredHistory: (binding: Binding) => boolean;
}

const LINK_ELEMENTS = new Set(['Link', 'NavLink', 'Redirect']);
const MOVES = new Set(['push', 'replace']);
const FOLLOWED = 8;

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

const isLocation = (p: NodePath<any>): boolean => p.isIdentifier({ name: 'location' }) || named(p, 'location')
  || (p.isCallExpression() && p.get('callee').isIdentifier({ name: 'useLocation' }));

function readsPathname(p: NodePath<any>, depth = 0): boolean {
  if (named(p, 'pathname')) return isLocation(p.get('object') as NodePath<any>);
  if (!p.isIdentifier() || depth > FOLLOWED) return false;
  const declared = declaredInit(p);
  if (declared?.id.type === 'Identifier') return readsPathname(declared.init, depth + 1);
  return takenFrom(p, 'pathname', isLocation);
}

const queryOrHash = (text: string | null | undefined) => text === '' || /^[?#]/.test(text ?? '-');

function staysHere(p: NodePath<any>) {
  if (readsPathname(p)) return true;
  if (p.isTemplateLiteral()) return p.node.quasis[0].value.cooked === '' && readsPathname(p.get('expressions.0') as NodePath) && queryOrHash(p.node.quasis[1].value.cooked);
  if (!p.isBinaryExpression({ operator: '+' }) || !readsPathname(p.get('left'))) return false;
  const right = p.get('right');
  return right.isStringLiteral() ? queryOrHash(right.node.value) : right.isTemplateLiteral() && queryOrHash(right.node.quasis[0].value.cooked);
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

function addresses(p: NodePath<any>): NodePath[] {
  if (p.isConditionalExpression()) return [...addresses(p.get('consequent')), ...addresses(p.get('alternate'))];
  if (p.isObjectExpression()) {
    const pathname = lastValue(p, 'pathname');
    return pathname ? addresses(pathname) : [];
  }
  const declared = p.isIdentifier() ? declaredInit(p) : null;
  if (declared?.id.type === 'Identifier' && declared.init.isObjectExpression()) return addresses(declared.init);
  return staysHere(p) || handedIn(p) ? [] : [p];
}

export function screenLinkReader({ configuredHistory }: Reading) {
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
    const declared = declaredInit(p);
    if (declared?.id.type === 'Identifier') return isHistory(declared.init, depth + 1);
    return takenFrom(p, 'history', isProps);
  }

  function element(p: NodePath<JSXElement>, inRouteFile: boolean): NodePath[] {
    const name = p.node.openingElement.name;
    const binding = name.type === 'JSXIdentifier' ? p.scope.getBinding(name.name) : undefined;
    const tag = binding && routerImport(binding) ? importedAs(binding)!.name : null;
    if (!tag || !LINK_ELEMENTS.has(tag) || (tag === 'Redirect' && inRouteFile)) return [];
    const to = (p.get('openingElement.attributes') as NodePath<any>[]).find((a) => a.isJSXAttribute() && a.node.name.name === 'to') as NodePath<JSXAttribute> | undefined;
    const value = to?.get('value') as NodePath<any> | undefined;
    if (!value?.node) return [];
    return addresses(value.isJSXExpressionContainer() ? value.get('expression') : value);
  }

  function call(p: NodePath<CallExpression>): NodePath[] {
    const callee = p.get('callee') as NodePath<any>;
    if (!callee.isMemberExpression() || callee.node.computed || !MOVES.has(((callee.node as MemberExpression).property as Identifier).name)) return [];
    const [address] = p.get('arguments') as NodePath<any>[];
    if (!address || address.isSpreadElement() || !isHistory(callee.get('object'))) return [];
    return addresses(address);
  }

  return { element, call };
}
