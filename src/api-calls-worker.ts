import { AsyncLocalStorage } from 'node:async_hooks';
import inspector from 'node:inspector';
import { parentPort, workerData } from 'node:worker_threads';
import { cleanAddress, PAGE_ORIGIN, placeUnknown, sentAddress, staysInBrowser, VERBS, WITH_DATA, withBase } from './sent-address.ts';

declare global {
  var __duruNothing: () => void;
  var __duruRecorder: unknown;
  var __duruRequestObject: unknown;
  var __duruFunction: unknown;
  var __duruArgument: (queryKey?: unknown) => unknown;
  var __duruWait: (sent: unknown) => void;
}

export interface WorkerData {
  modules: { file: string; url: string }[];
  skip: string[];
  request: { method: string | null; url: string; body: string | null };
  timeoutMs: number;
  mark: string;
  markNumber: number;
  inputsOnly?: boolean;
  readInputs?: boolean;
  exports?: Record<string, Record<string, string>>;
}

export interface SentRequest {
  method: string | null;
  url: string | null;
  body: boolean | undefined;
  sent?: unknown;
}

export interface FunctionInputs {
  sent: string[][];
  spread: string[][];
}

interface SentRecord {
  list: SentRequest[];
  flooded: boolean;
  waits: Promise<unknown>[];
}

interface Tagged {
  spread: (path: string[]) => void;
  born: (value: object, path: string[]) => void;
  pathOf: (value: unknown) => string[] | undefined;
}

export interface AttemptError {
  message: string;
  stack: string;
  late?: boolean;
}

interface Attempt {
  requests: SentRequest[];
  error: AttemptError | null;
  inputs?: FunctionInputs;
  inputsUnknown?: string;
}

export interface FunctionLocation {
  url: string | null;
  line: number;
  column: number;
}

type Callable = Function;

const { modules, skip, request, timeoutMs, mark, markNumber, inputsOnly, readInputs, exports: exportsWanted }: WorkerData = workerData;
const skipped = new Set(skip);
const send = (message: object) => parentPort!.postMessage(message);

// 호출해 본 메서드가 나중에 throw 하거나 reject 돼도 worker 가 멈추지 않게 한다.
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
const browserGlobals = globalThis as { window?: unknown; document?: unknown; self?: unknown };
browserGlobals.window ??= {};
browserGlobals.document ??= { getElementById: () => null };
// 번들러가 채워 넣는 NODE_ENV 와 브라우저에만 있는 self 를 앱 코드가 모듈을 불러올 때 읽는다.
process.env.NODE_ENV ??= 'production';
browserGlobals.self ??= globalThis;

// 스텁에 없는 외부 패키지 이름을 채우는 값. 문자열로 바꾸면 mark 가 되어 URL 에서 {?} 로 남는다.
globalThis.__duruNothing = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => mark : typeof k === 'symbol' || k === 'then' ? undefined : globalThis.__duruNothing),
  apply: () => globalThis.__duruNothing,
  construct: () => globalThis.__duruNothing,
});

function standIn(named: (k: string) => unknown = () => undefined) {
  const value: () => void = new Proxy(function () {}, {
    get: (t, k) => {
      if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf' || k === 'toJSON') return () => mark;
      if (k === Symbol.iterator) return function* () {};
      if (typeof k === 'symbol' || k === 'then') return undefined;
      return named(k) ?? value;
    },
    has: () => true,
    apply: () => value,
    construct: () => value,
  });
  return value;
}
const fake = standIn();

const ID_KEY = /^id$|Id$|ID$/;
// 경로가 붙은 값의 마커 형식은 `${mark}\u0001<n>\u0002` 이며, n 은 경로 인덱스이다.
const TAG_START = '\u0001';
const TAG_END = '\u0002';
const TAG = new RegExp(`${TAG_START}(\\d+)${TAG_END}`, 'g');
const TAG_IN_URL = new RegExp(`%0?1(\\d+)%0?2`, 'g');
const untag = (value: string) => value.replace(TAG_IN_URL, `${TAG_START}$1${TAG_END}`);
const tagText = (paths: string[][], t: Tagged, path: string[]) => {
  const key = JSON.stringify(path);
  let n = paths.findIndex((p) => JSON.stringify(p) === key);
  if (n < 0) n = paths.push(path) - 1;
  return `${mark}${TAG_START}${n}${TAG_END}`;
};

function taggedValue(t: Tagged, paths: string[][], path: string[], kind: 'fake' | 'leaves' | 'idsAsText') {
  const made = new Map<string, unknown>();
  const value: any = new Proxy(() => {}, {
    get: (target, k) => {
      if (k === Symbol.toPrimitive || k === 'toString' || k === 'valueOf' || k === 'toJSON') return () => tagText(paths, t, path);
      if (k === Symbol.iterator) return function* () {};
      if (typeof k === 'symbol' || k === 'then') return undefined;
      const at = [...path, String(k)];
      if (kind === 'leaves' || (kind === 'idsAsText' && ID_KEY.test(String(k)))) return tagText(paths, t, at);
      const key = JSON.stringify(at);
      if (!made.has(key)) made.set(key, taggedValue(t, paths, at, kind));
      return made.get(key);
    },
    has: () => true,
    ownKeys: () => {
      t.spread(path);
      return [];
    },
    getOwnPropertyDescriptor: () => undefined,
    apply: () => value,
    construct: () => value,
  });
  t.born(value, path);
  return value;
}

function scanValue(value: unknown, t: Tagged, paths: string[][], into: (path: string[]) => void) {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || !v) return;
    if (typeof v === 'string') return scanText(v, paths, into);
    const path = t.pathOf(v);
    if (path) return into(path);
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
    else if (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k], depth + 1);
  };
  walk(value, 0);
}
const scanText = (value: string, paths: string[][], into: (path: string[]) => void) => {
  for (const [, n] of value.matchAll(TAG)) if (paths[Number(n)]) into(paths[Number(n)]);
};
const letters = String.prototype[Symbol.iterator];
String.prototype[Symbol.iterator] = function (this: string) {
  return this === mark ? [mark][Symbol.iterator]() : letters.call(this);
};
const idsAsText = standIn((k) => (ID_KEY.test(k) ? mark : undefined));

const firstLine = (text: string) => text.split('\n')[0];
const at = (args: unknown[], dotted: string) => dotted.split('.').reduce<any>((v, k) => (v == null ? undefined : v[k]), args);
const text = (v: unknown) => {
  try {
    return v == null ? null : String(v);
  } catch {
    return null;
  }
};

const current = new AsyncLocalStorage<{ argument: () => unknown }>();
const sent = new Map<object | undefined, SentRecord>();
// 가짜 값만큼 도는 반복이 요청을 쏟아내면 그 시도를 버린다.
const REQUEST_LIMIT = 20;
// body 는 요청에 본문이 실렸는지이고, requestFunction 에 body 자리가 없으면 undefined 다.
const keep = (method: string | null, url: string | null, body?: boolean, scanned?: unknown) => {
  const record = sent.get(current.getStore());
  if (record && record.list.length >= REQUEST_LIMIT) {
    record.flooded = true;
    throw new Error(`sent more than ${REQUEST_LIMIT} requests`);
  }
  if (record) record.list.push({ method, url, body, sent: scanned });
  return Promise.resolve(fake);
};
const recorder = (...args: unknown[]) => keep(request.method ? text(at(args, request.method)) : null, text(at(args, request.url)), request.body ? at(args, request.body) != null : undefined, args);
globalThis.__duruRecorder = recorder;

const standIns = new WeakSet<object>();
const duruValues = new WeakSet<object>([fake, idsAsText, globalThis.__duruNothing]);
const recordedFetch = (input: unknown, init?: { method?: unknown }) => {
  const asked = input instanceof Request ? input : null;
  const options = init && duruValues.has(init) ? undefined : init;
  return keep(text(options?.method) ?? asked?.method ?? 'GET', asked ? asked.url : text(input));
};
standIns.add(recordedFetch);
(globalThis as { fetch: unknown }).fetch = recordedFetch;
(browserGlobals.window as { fetch?: unknown }).fetch = recordedFetch;

const FAKES = [mark, String(markNumber)];
function navigate(address: unknown) {
  const given = text(address);
  const url = given === null ? null : cleanAddress(given);
  if (url && !staysInBrowser(url) && !placeUnknown(url, FAKES)) keep('GET', sentAddress(url));
}
// 현재 페이지 URL 은 알 수 없어 가짜 값으로 둔다.
const location = Object.defineProperty(
  { protocol: new URL(PAGE_ORIGIN).protocol, host: new URL(PAGE_ORIGIN).host, origin: PAGE_ORIGIN, pathname: mark, search: mark, hash: mark, toString: () => mark, assign: navigate, replace: navigate },
  'href',
  { get: () => mark, set: navigate, enumerable: true },
);
const page = browserGlobals.window as { open?: unknown };
const locationProperty = { get: () => location, set: navigate, enumerable: true, configurable: true };
Object.defineProperty(page, 'location', locationProperty);
Object.defineProperty(globalThis, 'location', locationProperty);
page.open = (address: unknown) => {
  navigate(address);
  return null;
};
function element(tag: unknown) {
  const own: Record<string | symbol, unknown> = {
    href: '',
    style: {},
    setAttribute: (name: unknown, value: unknown) => {
      own[String(name)] = text(value) ?? '';
    },
    getAttribute: (name: unknown) => own[String(name)] ?? null,
    click: () => {
      if (String(tag).toLowerCase() === 'a') navigate(own.href);
    },
  };
  return new Proxy(own, { get: (t, k) => (k in t ? t[k] : typeof k === 'symbol' || k === 'then' ? undefined : globalThis.__duruNothing) });
}
Object.assign(browserGlobals.document as object, { createElement: element, body: element('body') });
// 요청 메서드와 create 가 아닌 속성은 아무 일도 하지 않는 값이라, interceptors 같은 설정 코드가 멈추지 않는다.
function requestObject(base: unknown): unknown {
  const baseOf = (config: unknown) => {
    if (duruValues.has(config as object)) return base;
    const given = (config as { baseURL?: unknown } | null | undefined)?.baseURL;
    if (given === undefined) return base;
    if (!given) return null;
    return typeof given === 'string' ? given : mark;
  };
  type Config = { method?: unknown; url?: unknown; baseURL?: unknown };
  const fromConfig = (config: Config | undefined) => keep(text(config?.method) ?? 'get', withBase(text(config?.url), baseOf(config)));
  const sendAny = (first: string | Config | undefined, second?: Config) => (typeof first === 'string' ? fromConfig({ ...second, url: first }) : fromConfig(first));
  const verbs: Record<string | symbol, (...args: never[]) => unknown> = Object.fromEntries(
    VERBS.map((verb) => [verb, (url: unknown, ...rest: unknown[]) => keep(verb, withBase(text(url), baseOf(rest[WITH_DATA.has(verb) ? 1 : 0])))]),
  );
  verbs.request = sendAny;
  verbs.create = (options?: { baseURL?: unknown }) => requestObject(options?.baseURL === undefined ? base : options.baseURL);
  for (const fn of Object.values(verbs)) standIns.add(fn);
  const made = new Proxy(Object.assign(function () {}, verbs), {
    get: (t, k) => (Object.hasOwn(verbs, k) ? verbs[k] : typeof k === 'symbol' || k === 'then' ? undefined : globalThis.__duruNothing),
    apply: (t, self, [first, second]) => sendAny(first, second),
  });
  standIns.add(made);
  return made;
}
globalThis.__duruRequestObject = requestObject(undefined);

const session = new inspector.Session();
session.connect();
const post = (method: string, params?: object) => new Promise<any>((resolve, reject) => session.post(method, params, (e, r) => (e ? reject(e) : resolve(r))));
const scripts = new Map<string, string>();
session.on('Debugger.scriptParsed', ({ params }) => scripts.set(params.scriptId, params.url));
await post('Debugger.enable');
await post('Debugger.setSkipAllPauses', { skip: true });

async function locationOf(fn: unknown): Promise<FunctionLocation | null> {
  globalThis.__duruFunction = fn;
  try {
    const { result } = await post('Runtime.evaluate', { expression: 'globalThis.__duruFunction' });
    const { internalProperties = [] } = await post('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
    const where = internalProperties.find((p: { name: string; value?: { value?: any } }) => p.name === '[[FunctionLocation]]')?.value?.value;
    return where ? { url: scripts.get(where.scriptId) ?? null, line: where.lineNumber + 1, column: where.columnNumber } : null;
  } finally {
    delete globalThis.__duruFunction;
  }
}

const describe = (e: any) => ({ message: String(e?.message ?? e), stack: String(e?.stack ?? '') });
// 생성자에 넘긴 기록 함수가 객체의 속성으로 남아도 호출하지 않는다.
const isStandIn = (v: object) => v === recorder || v === globalThis.__duruNothing || standIns.has(v);
const isClass = (fn: unknown) => /^class\b/.test(Function.prototype.toString.call(fn));
const isNative = (fn: unknown) => typeof fn === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn));

// 객체 자신과, 앱이 만든 클래스의 프로토타입에 든 메서드. getter 는 호출하지 않는다.
function methodsOf(obj: object): [string, Callable][] {
  if (Array.isArray(obj)) return [];
  const found = new Map<string, Callable>();
  for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    if (o !== obj && isNative(o.constructor)) break;
    for (const name of Object.getOwnPropertyNames(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (name !== 'constructor' && !found.has(name) && typeof d!.value === 'function' && !isStandIn(d!.value)) found.set(name, d!.value);
    }
  }
  return [...found];
}

// getter 와, 정적 필드에 든 클래스는 호출하지 않는다.
function staticsOf(chain: Callable[]): [string, Callable][] {
  const found = new Map<string, Callable>();
  for (const K of chain) {
    for (const name of Object.getOwnPropertyNames(K)) {
      const d = Object.getOwnPropertyDescriptor(K, name);
      if (!['length', 'name', 'prototype'].includes(name) && !found.has(name) && typeof d!.value === 'function' && !isStandIn(d!.value) && !isClass(d!.value)) found.set(name, d!.value);
    }
  }
  return [...found];
}

function classChain(C: unknown) {
  const chain: Callable[] = [];
  for (let K = C; typeof K === 'function' && !isNative(K) && isClass(K); K = Object.getPrototypeOf(K)) chain.push(K);
  return chain;
}

const leaves = (leaf: unknown) => {
  const argument = new Proxy({}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => mark : typeof k === 'symbol' || k === 'then' ? undefined : leaf),
    has: () => true,
  });
  duruValues.add(argument);
  return argument;
};
// 앞의 모양이 오류로 끝나거나 요청 없이 끝나면 다음 모양을 넣어 본다. URL 변수 값이 문자열이나 숫자인지 검사하는 앱은 키마다 문자열이나 숫자가 나와야 통과한다.
// 마지막 시도에서는 이름이 id 이거나 Id · ID 로 끝나는 키만 문자열이고, 다른 키를 읽으면 몇 단계를 내려가도 이 값이 다시 나온다. URL 경로 값과 함께 받은 body 에 `in` 을 쓰거나 배열 메서드를 호출하는 메서드도 그래야 요청까지 간다.
const ARGUMENT_SHAPES: (() => unknown)[] = [() => fake, () => leaves(mark), () => leaves(markNumber), () => idsAsText];
const SHAPE_NAMES = ['fake', 'leaves(mark)', 'leaves(markNumber)', 'idsAsText'];

globalThis.__duruArgument = (queryKey) => {
  const given: any = current.getStore()?.argument() ?? fake;
  if (queryKey == null) return given;
  const context = new Proxy({ queryKey }, { get: (t, k) => (k === 'queryKey' ? queryKey : given?.[k]), has: () => true });
  duruValues.add(context);
  return context;
};
globalThis.__duruWait = (value) => {
  sent.get(current.getStore())?.waits.push(Promise.resolve(value));
};

async function attempt(self: unknown, fn: Callable, args: () => unknown): Promise<Attempt> {
  const record: SentRecord = { list: [], flooded: false, waits: [] };
  const token = { argument: args };
  sent.set(token, record);
  let error: AttemptError | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const given = Array.from({ length: Math.max(fn.length, 1) }, args);
    const result = current.run(token, () => fn.apply(self, given));
    const late = new Promise<{ late?: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ late: true }), timeoutMs);
    });
    const ended: { late?: boolean } = await Promise.race([Promise.resolve(result).then(() => Promise.all(record.waits)).then(() => ({})), late]);
    if (ended.late) error = { message: `did not finish within ${timeoutMs} ms`, stack: '', late: true };
  } catch (e) {
    error = describe(e);
  } finally {
    clearTimeout(timer);
    sent.delete(token);
  }
  if (record.flooded) return { requests: [], error: { message: `sent more than ${REQUEST_LIMIT} requests`, stack: '' } };
  return { requests: record.list, error };
}

const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

function inputsOf(requests: SentRequest[], t: Tagged, paths: string[][], spread: string[][]) {
  const sent: string[][] = [];
  const add = (path: string[]) => {
    if (!sent.some((p) => samePath(p, path))) sent.push(path);
  };
  for (const recorded of requests) {
    if (recorded.url) scanText(untag(recorded.url), paths, add);
    const from = recorded.sent;
    if (Array.isArray(from) && request.url) scanText(untag(text(at(from, request.url)) ?? ''), paths, add);
    if (!Array.isArray(from) || !request.body) continue;
    const body = at(from, request.body);
    if (typeof body === 'string') scanText(untag(body), paths, add);
    else scanValue(body, t, paths, add);
  }
  const spreadPaths = spread.filter((path) => !sent.some((p) => samePath(p, path)));
  return { sent, spread: spreadPaths };
}

async function withInputs(tried: Attempt, kind: string, unit: string, self: unknown, fn: Callable): Promise<Attempt> {
  if (!readInputs) return tried;
  // 이미 요청을 보낸 모양은 다시 시도하지 않는다.
  const kinds: ('fake' | 'leaves' | 'idsAsText')[] = kind === 'idsAsText' ? ['idsAsText', 'leaves'] : kind === 'fake' ? ['fake', 'leaves'] : ['leaves'];
  let reason = '';
  for (const shape of kinds) {
    const paths: string[][] = [];
    const tagged = new Map<object, string[]>();
    const spread: string[][] = [];
    const t: Tagged = {
      spread: (path) => {
        if (!spread.some((p) => samePath(p, path))) spread.push(path);
      },
      born: (value, path) => tagged.set(value, path),
      pathOf: (value) => (value && (typeof value === 'object' || typeof value === 'function') ? tagged.get(value as object) : undefined),
    };
    const args = Array.from({ length: Math.max(fn.length, 1) }, (_, i) => taggedValue(t, paths, [String(i)], shape));
    let next = 0;
    send({ type: 'attempt', unit });
    const ran = await attempt(self, fn, () => args[Math.min(next++, args.length - 1)]);
    if (ran.error) {
      reason = `threw with tagged values: ${firstLine(ran.error.message)}`;
      continue;
    }
    // 요청 함수가 받은 설정에서만 인자를 읽으므로, 요청을 보내지 않는 함수는 인자를 알 수 없다.
    if (!ran.requests.length || ran.requests.length !== tried.requests.length) {
      reason = ran.requests.length ? `sent ${ran.requests.length} ${ran.requests.length === 1 ? 'request' : 'requests'} with tagged values instead of ${tried.requests.length}` : 'sent no request with tagged values';
      continue;
    }
    // 요청 함수 밖으로 보낸 요청은 그 요청에 실린 키를 읽을 수 없다.
    if (ran.requests.some((r) => r.sent === undefined)) return { ...tried, inputsUnknown: 'sent a request outside requestFunction' };
    return { ...tried, inputs: inputsOf(ran.requests, t, paths, spread) };
  }
  return { ...tried, inputsUnknown: reason || 'no clean run' };
}

async function call(unit: string, self: unknown, fn: Callable): Promise<Attempt> {
  let best: Attempt | null = null;
  let chosen = -1;
  let index = -1;
  const errors: (string | undefined)[] = [];
  for (const argument of ARGUMENT_SHAPES) {
    index++;
    send({ type: 'attempt', unit });
    const tried = await attempt(self, fn, argument);
    if (!tried.error && tried.requests.length) return withInputs(tried, SHAPE_NAMES[index], unit, self, fn);
    errors[index] = tried.error?.message;
    const more = !best || tried.requests.length > best.requests.length || (tried.requests.length === best.requests.length && best.error && !tried.error);
    if (more) {
      best = tried;
      chosen = index;
    }
    if (tried.error?.late) break;
  }
  const picked = best!;
  if (picked.requests.length) return withInputs(picked, SHAPE_NAMES[chosen], unit, self, fn);
  const failure = picked.error;
  const valueErrors = failure && !failure.late && errors.every((message) => message !== undefined) && !errors.some((message) => message?.startsWith('sent more than'));
  if (!failure || !valueErrors) return picked;
  if (errors.every((message) => message === errors[0])) return { ...picked, inputsUnknown: `throws the same error whatever it is given: ${firstLine(failure.message)}` };
  return { ...picked, inputsUnknown: `threw with tagged values: ${firstLine(failure.message)}` };
}

async function locationsOf(chain: Callable[]) {
  const found: (FunctionLocation | null)[] = [];
  for (const C of chain) found.push(await locationOf(C));
  return found.filter(Boolean);
}

async function callExport(file: string, exportName: string, value: object) {
  const chain = typeof value === 'function' && isClass(value) ? classChain(value) : null;
  let targets: [string | null, Callable, unknown][] = [];
  try {
    if (chain) targets = staticsOf(chain).map(([member, fn]) => [member, fn, value]);
    else targets = typeof value === 'function' ? [[null, value, undefined]] : methodsOf(value).map(([member, fn]) => [member, fn, value]);
  } catch {
    // 속성을 읽다 던지는 값(Proxy 같은 것)은 호출할 메서드가 없는 것으로 본다.
  }
  if (typeof value === 'object' || chain) {
    let locations: (FunctionLocation | null)[] = [];
    try {
      locations = await locationsOf(chain ?? classChain(Object.getPrototypeOf(value)?.constructor));
    } catch {
      // 프로토타입을 읽다 던지면 감출 멤버가 없는 것으로 본다.
    }
    send({ type: 'classes', file, exportName, locations });
  }
  for (const [member, fn, self] of targets) {
    const unit = `call\n${file}\n${exportName}\n${member ?? ''}`;
    if (skipped.has(unit)) continue;
    const location = await locationOf(fn);
    send({ type: 'begin', unit, location });
    const { requests, error, inputs, inputsUnknown } = await call(unit, self, fn);
    send({ type: 'called', unit, file, exportName, member, location, requests: requests.map((r) => ({ method: r.method, url: r.url, body: r.body })), error, ...(inputs && { inputs }), ...(inputsUnknown && { inputsUnknown }) });
  }
}

const seen = new Map<unknown, { file: string; exportName: string }>();
// 정적 메서드에는 주소나 토큰을 바꾸는 것(setBaseURL 같은 것)이 있어, 다른 export 를 모두 호출한 뒤에 호출한다.
const classes: [string, string, Callable][] = [];
for (const { file, url } of modules) {
  const loading = `load\n${file}`;
  if (skipped.has(loading)) continue;
  send({ type: 'begin', unit: loading });
  let mod;
  try {
    mod = await import(url);
  } catch (e) {
    send({ type: 'failed', unit: loading, file, error: describe(e) });
    continue;
  }
  send({ type: 'loaded', unit: loading });
  for (const [exportName, value] of Object.entries(mod)) {
    if (!value || !['object', 'function'].includes(typeof value) || isStandIn(value)) continue;
    if (inputsOnly) {
      const valueName = exportsWanted?.[file]?.[exportName];
      if (!valueName) continue;
      if (valueName !== exportName) {
        const unit = `call\n${file}\n${exportName}\n`;
        if (skipped.has(unit)) continue;
        send({ type: 'begin', unit, location: null });
        const { requests, error, inputs, inputsUnknown } = await call(unit, undefined, value as Callable);
        send({ type: 'called', unit, file, exportName, member: null, location: null, requests: requests.map((r) => ({ method: r.method, url: r.url, body: r.body })), error, ...(inputs && { inputs }), ...(inputsUnknown && { inputsUnknown }) });
        continue;
      }
    }
    if (seen.has(value)) {
      send({ type: 'same', file, exportName, as: seen.get(value) });
      continue;
    }
    seen.set(value, { file, exportName });
    if (typeof value === 'function' && isClass(value)) classes.push([file, exportName, value]);
    else await callExport(file, exportName, value);
  }
}
for (const [file, exportName, C] of classes) await callExport(file, exportName, C);
send({ type: 'end' });
