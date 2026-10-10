import type { Binding, NodePath } from '@babel/traverse';
import type { AssignmentExpression, CallExpression, ImportDeclaration, JSXAttribute, JSXOpeningElement, ObjectExpression, StringLiteral } from '@babel/types';
import { keyName, memberChain, UNKNOWN } from './client.ts';
import { placeUnknown, sentAddress, staysInBrowser, VERBS, WITH_DATA, withBase } from './sent-address.ts';

export interface ScreenRequest {
  fn: string;
  method: string | null;
  url: string | null;
  navigation?: true;
  // url 에서 읽은 문자열이 있어도 어느 경로인지는 알 수 없다.
  unresolved?: true;
}

interface RequestFunction {
  import: string;
  name: string;
  object?: boolean;
  method?: string;
  url?: string;
}

interface Reading {
  requestFunction: RequestFunction | null;
  evaluate: (p: NodePath<any>) => any;
  objectLiteral: (p: NodePath<any>) => NodePath<ObjectExpression> | null;
  isRequestFunction: (file: string, spec: string, name: string) => boolean;
  server: string | null;
}

type Base = string | null | undefined;

const PAGE_OBJECTS = new Set(['window', 'globalThis', 'self']);
const OTHER_SITE = /^(?:[a-z][a-z\d+.-]*:)?\/\//i;
const ROUTER_PACKAGES = new Set(['react-router', 'react-router-dom', '@remix-run/react']);
// URL 로 읽거나 ? · # 에서 자를 때 {?} 의 물음표가 걸리지 않게 잠시 바꿔 두는 문자열
const MASK = '__duru_unknown__';

const masked = (url: string) => url.replaceAll(UNKNOWN, MASK);
const unmasked = (url: string) => url.replaceAll(MASK, UNKNOWN);
const verbOf = (method: unknown) => (typeof method === 'string' && /^[a-z]+$/i.test(method) ? method.toUpperCase() : null);

// 사이트 루트부터 시작하는 경로만 돌려준다. 다른 사이트 주소, 현재 페이지 기준 상대 주소, 경로를 알 수 없는 값으로 정해지는 주소는 null 이다.
function navigatedAddress(url: unknown) {
  if (typeof url !== 'string' || !/^\/(?!\/)/.test(url)) return null;
  const address = masked(url);
  return placeUnknown(address, [MASK]) ? null : unmasked(sentAddress(address));
}

export function screenRequestReader({ requestFunction, evaluate, objectLiteral, isRequestFunction, server }: Reading) {
  const serverHost = server && new URL(server).host;
  const tagName = (name: JSXOpeningElement['name']): string => (name.type === 'JSXIdentifier' ? name.name : name.type === 'JSXMemberExpression' ? `${tagName(name.object)}.${name.property.name}` : `${name.namespace.name}:${name.name.name}`);
  const text = (v: unknown) => (typeof v === 'string' ? v : null);

  // 객체 리터럴에 적힌 값. 키가 없으면 undefined, 펼친 값이나 계산한 키에 가려 알 수 없으면 null 이다.
  function written(options: NodePath<any> | undefined, key: string) {
    if (!options?.node) return undefined;
    const props = objectLiteral(options)?.get('properties');
    if (!props) return null;
    const named = (p: NodePath<any>) => ((p.isObjectProperty() || p.isObjectMethod()) && !p.node.computed ? keyName(p.node) : null);
    const at = props.findLastIndex((p) => named(p) === key);
    if (props.slice(at + 1).some((p) => named(p) === null)) return null;
    if (at < 0) return undefined;
    return props[at].isObjectProperty() ? (props[at].get('value') as NodePath) : null;
  }

  function methodIn(options: NodePath<any> | undefined) {
    const method = written(options, 'method');
    return method === undefined ? 'GET' : method && verbOf(evaluate(method));
  }

  // 요청 하나에 준 옵션은 읽지 못해도 base 를 바꾸지 않는다고 보고, create 에 준 옵션은 읽지 못하면 base 를 모른다고 본다.
  function baseIn(options: NodePath<any> | undefined, inherited: Base, creating = false): Base {
    const given = written(options, 'baseURL');
    if (given === null && creating) return UNKNOWN;
    if (!given) return inherited;
    const base = hidesText(given) ? undefined : evaluate(given);
    return typeof base === 'string' ? base || null : UNKNOWN;
  }

  function importedAs(binding: Binding) {
    if (binding.kind !== 'module') return null;
    const declaration = binding.path.parent as ImportDeclaration;
    const specifier = binding.path.node as ImportDeclaration['specifiers'][number];
    if (declaration.importKind === 'type') return null;
    if (specifier.type === 'ImportNamespaceSpecifier') return { spec: declaration.source.value, name: '*' };
    if (specifier.type === 'ImportDefaultSpecifier') return { spec: declaration.source.value, name: 'default' };
    if (specifier.importKind === 'type') return null;
    return { spec: declaration.source.value, name: (specifier.imported as { name?: string }).name ?? (specifier.imported as StringLiteral).value };
  }

  const routerImport = (binding: Binding | undefined) => Boolean(binding && ROUTER_PACKAGES.has(importedAs(binding)?.spec ?? ''));

  function makingCall(binding: Binding | undefined) {
    const init = binding?.path.isVariableDeclarator() ? (binding.path.get('init') as NodePath<any>) : null;
    return init?.isCallExpression() ? (init as NodePath<CallExpression>) : null;
  }

  function fromRouter(binding: Binding | undefined) {
    const callee = makingCall(binding)?.get('callee') as NodePath<any> | undefined;
    return routerImport(binding) || (Boolean(callee?.isIdentifier()) && routerImport(callee!.scope.getBinding(callee!.node.name)));
  }

  function configured(p: NodePath<any>, file: string) {
    const binding = p.isIdentifier() && p.scope.getBinding(p.node.name);
    const from = binding && importedAs(binding);
    return Boolean(from && isRequestFunction(file, from.spec, from.name));
  }

  // axios 와 설정에 적은 요청 객체, 그리고 그 create() 로 만들어 const 에 담은 객체. base 는 create 에 준 baseURL 이다.
  function requestObject(p: NodePath<any>, file: string, seen = new Set<Binding>()): { base: Base } | null {
    const binding = p.isIdentifier() && p.scope.getBinding(p.node.name);
    if (!binding || seen.has(binding)) return null;
    seen.add(binding);
    if (binding.kind === 'module') {
      const from = importedAs(binding);
      const axios = from?.spec === 'axios' && ['default', '*'].includes(from.name);
      return axios || (requestFunction?.object && configured(p, file)) ? { base: undefined } : null;
    }
    const making = binding.kind === 'const' && (binding.path.node as { id?: { type: string } }).id?.type === 'Identifier' ? makingCall(binding) : null;
    const callee = making?.get('callee') as NodePath<any> | undefined;
    if (!callee?.isMemberExpression() || callee.node.computed || (callee.node.property as { name?: string }).name !== 'create') return null;
    const made = requestObject(callee.get('object'), file, seen);
    return made && { base: baseIn(making!.get('arguments')[0], made.base, true) };
  }

  // 페이지의 전역 객체를 가리키는 `a.b.c` 꼴의 식. window · globalThis · self 는 떼고 돌려준다.
  function pageChain(p: NodePath<any>) {
    const chain = memberChain(p.node);
    if (!chain || p.scope.getBinding(chain[0])) return null;
    return PAGE_OBJECTS.has(chain[0]) && chain.length > 1 ? chain.slice(1) : chain;
  }

  const isLocation = (chain: string[]) => chain[0] === 'location' || (chain[0] === 'document' && chain[1] === 'location');
  const afterLocation = (chain: string[]) => chain.slice(chain[0] === 'document' ? 2 : 1);

  const imported = (p: NodePath<any>): boolean => (p.isIdentifier() ? p.scope.getBinding(p.node.name)?.kind === 'module' : (p.isMemberExpression() || p.isOptionalMemberExpression()) && imported(p.get('object') as NodePath));

  // 주소를 이루는 조각 가운데 값을 읽지 못한, import 한 이름이나 그 이름으로 부른 함수의 결과가 있는지
  function hidesText(p: NodePath<any> | undefined, seen = new Set<Binding>()): boolean {
    if (!p?.node) return false;
    if (p.isTemplateLiteral()) return (p.get('expressions') as NodePath[]).some((e) => hidesText(e, seen));
    if (p.isBinaryExpression({ operator: '+' })) return hidesText(p.get('left'), seen) || hidesText(p.get('right'), seen);
    const binding = p.isIdentifier() && p.scope.getBinding(p.node.name);
    if (binding && binding.kind === 'const' && binding.path.isVariableDeclarator() && binding.path.get('id').isIdentifier()) {
      if (seen.has(binding)) return false;
      seen.add(binding);
      return hidesText(binding.path.get('init') as NodePath, seen);
    }
    if (['string', 'number'].includes(typeof evaluate(p))) return false;
    return imported(p.isCallExpression() || p.isOptionalCallExpression() ? (p.get('callee') as NodePath) : p);
  }

  function navigation(fn: string, address: NodePath<any> | undefined, method: string | null = 'GET'): ScreenRequest | null {
    if (!address?.node) return null;
    const raw = evaluate(address);
    const value = typeof raw === 'string' ? pathOnServer(raw) : raw;
    const url = hidesText(address) ? null : navigatedAddress(value);
    if (url !== null) return { fn, method, url, navigation: true };
    // POST 하는 form 은 앱 안에서 화면만 여는 페이지 이동일 수 없으므로, 주소를 다 읽지 못해도 요청으로 남긴다.
    if (method !== 'POST') return null;
    if (typeof raw !== 'string') return { fn, method, url: null, navigation: true };
    return !value || staysInBrowser(value) ? null : { fn, method, url: value, navigation: true, unresolved: true };
  }

  function pathOnServer(url: string) {
    if (!OTHER_SITE.test(url)) return url;
    try {
      const u = new URL(masked(url.startsWith('//') ? `http:${url}` : url));
      return u.host === serverHost ? unmasked(u.pathname + u.search) : null;
    } catch {
      return null;
    }
  }

  function sent(fn: string, method: string | null, address: NodePath<any> | undefined, base: Base = undefined): ScreenRequest {
    const whole = withBase(address?.node ? text(evaluate(address)) : null, base);
    if (whole === null) return { fn, method, url: null };
    const url = pathOnServer(whole);
    if (url === null) return { fn, method, url: whole, unresolved: true };
    return { fn, method, url, ...((hidesText(address) || placeUnknown(masked(url), [MASK])) && { unresolved: true as const }) };
  }

  const fromConfig = (fn: string, config: NodePath<any> | undefined, base: Base) => sent(fn, methodIn(config), written(config, 'url') ?? undefined, baseIn(config, base));

  // requestFunction 의 「0.endpoint.method」 같은 자리에 적힌 식. 객체 리터럴을 따라 내려가다 끊기면 undefined 다.
  function placed(args: NodePath<any>[], place: string) {
    const [index, ...keys] = place.split('.');
    let at: NodePath<any> | null | undefined = args[Number(index)];
    for (const key of keys) at = at && written(at, key);
    return at ?? undefined;
  }

  function call(p: NodePath<CallExpression>, file: string): ScreenRequest | null {
    const callee = p.get('callee') as NodePath<any>;
    const args = p.get('arguments') as NodePath<any>[];
    const fn = memberChain(callee.node)?.join('.');
    if (!fn) return null;
    const page = pageChain(callee);
    if (page?.join('.') === 'fetch') return sent(fn, methodIn(args[1]), args[0]);
    if (page?.join('.') === 'open') return navigation(fn, args[0]);
    if (page && isLocation(page) && ['assign', 'replace'].includes(afterLocation(page).join('.'))) return navigation(fn, args[0]);

    if (callee.isIdentifier()) {
      const object = requestObject(callee, file);
      if (object) return args[0] && objectLiteral(args[0]) ? fromConfig(fn, args[0], object.base) : sent(fn, methodIn(args[1]), args[0], baseIn(args[1], object.base));
      if (!requestFunction || requestFunction.object || !configured(callee, file)) return null;
      const method = requestFunction.method ? placed(args, requestFunction.method) : undefined;
      return sent(fn, method ? verbOf(evaluate(method)) : null, placed(args, requestFunction.url!));
    }
    if (!callee.isMemberExpression() || callee.node.computed) return null;
    const object = requestObject(callee.get('object'), file);
    const member = (callee.node.property as { name: string }).name;
    if (!object) return null;
    if (member === 'request') return fromConfig(fn, args[0], object.base);
    if (!VERBS.includes(member)) return null;
    return sent(fn, member.toUpperCase(), args[0], baseIn(args[WITH_DATA.has(member) ? 2 : 1], object.base));
  }

  function assignment(p: NodePath<AssignmentExpression>): ScreenRequest | null {
    if (p.node.operator !== '=') return null;
    const left = p.get('left') as NodePath<any>;
    const page = (left.isIdentifier() || left.isMemberExpression()) && pageChain(left);
    if (!page || !isLocation(page) || !['', 'href'].includes(afterLocation(page).join('.'))) return null;
    return navigation(memberChain(left.node)!.join('.'), p.get('right'));
  }

  function attribute(p: NodePath<JSXAttribute>): ScreenRequest | null {
    const name = p.node.name.name;
    if (name !== 'href' && name !== 'action') return null;
    const element = p.parent as JSXOpeningElement;
    const owner = p.scope.getBinding(tagName(element.name).split(/[.:]/)[0]);
    // react-router 의 Form 과 그 훅(useFetcher)이 돌려준 Form 은 서버가 아니라 라우트의 action 으로 보낸다.
    // prop 으로 받은 fetcher 처럼 import 하지 않은 값에 달린 요소는 그런 Form 인지 알 수 없다.
    if (name === 'action' && (fromRouter(owner) || (element.name.type === 'JSXMemberExpression' && owner?.kind !== 'module'))) return null;
    const valueOf = (attr: NodePath<any> | undefined) => {
      const value = attr?.get('value') as NodePath<any> | undefined;
      return value?.isJSXExpressionContainer() ? (value.get('expression') as NodePath<any>) : value;
    };
    let method: string | null = 'GET';
    if (name === 'action') {
      const given = (p.parentPath.get('attributes') as NodePath<any>[]).find((a) => a.isJSXAttribute() && a.node.name.name === 'method');
      const value = valueOf(given);
      if (value?.node) method = verbOf(evaluate(value));
    }
    return navigation(`<${tagName(element.name)} ${name}>`, valueOf(p), method);
  }

  return { call, assignment, attribute };
}
