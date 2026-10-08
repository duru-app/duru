import { AsyncLocalStorage } from 'node:async_hooks';
import inspector from 'node:inspector';
import { parentPort, workerData } from 'node:worker_threads';

declare global {
  var window: { location: { protocol: string; host: string; origin: string } };
  var document: { getElementById: () => null };
  var __duruNothing: () => void;
  var __duruRecorder: unknown;
  var __duruRequestObject: unknown;
  var __duruFunction: unknown;
}

interface WorkerData {
  modules: { file: string; url: string }[];
  skip: string[];
  request: { method: string | null; url: string; body: string | null };
  timeoutMs: number;
  mark: string;
  markNumber: number;
  scheme: string;
}

interface SentRequest {
  method: string | null;
  url: string | null;
  body: boolean | undefined;
}

interface SentRecord {
  list: SentRequest[];
  flooded: boolean;
}

interface AttemptError {
  message: string;
  stack: string;
  late?: boolean;
}

interface Attempt {
  requests: SentRequest[];
  error: AttemptError | null;
}

interface FunctionLocation {
  url: string | null;
  line: number;
  column: number;
}

type Callable = Function;

const { modules, skip, request, timeoutMs, mark, markNumber, scheme }: WorkerData = workerData;
const skipped = new Set(skip);
const send = (message: object) => parentPort!.postMessage(message);

// 호출해 본 메서드가 나중에 throw 하거나 reject 돼도 worker 가 멈추지 않게 한다.
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
globalThis.window ??= { location: { protocol: 'http:', host: 'localhost', origin: 'http://localhost' } };
globalThis.document ??= { getElementById: () => null };

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
const letters = String.prototype[Symbol.iterator];
String.prototype[Symbol.iterator] = function (this: string) {
  return this === mark ? [mark][Symbol.iterator]() : letters.call(this);
};
const ID_KEY = /^id$|Id$|ID$/;
const idsAsText = standIn((k) => (ID_KEY.test(k) ? mark : undefined));

const at = (args: unknown[], dotted: string) => dotted.split('.').reduce<any>((v, k) => (v == null ? undefined : v[k]), args);
const text = (v: unknown) => {
  try {
    return v == null ? null : String(v);
  } catch {
    return null;
  }
};

const current = new AsyncLocalStorage<object>();
const sent = new Map<object | undefined, SentRecord>();
// 가짜 값만큼 도는 반복이 요청을 쏟아내면 그 시도를 버린다.
const REQUEST_LIMIT = 20;
// body 는 요청에 본문이 실렸는지이고, requestFunction 에 body 자리가 없으면 undefined 다.
const keep = (method: string | null, url: string | null, body?: boolean) => {
  const record = sent.get(current.getStore());
  if (record && record.list.length >= REQUEST_LIMIT) {
    record.flooded = true;
    throw new Error(`sent more than ${REQUEST_LIMIT} requests`);
  }
  if (record) record.list.push({ method, url, body });
  return Promise.resolve(fake);
};
const recorder = (...args: unknown[]) => keep(request.method ? text(at(args, request.method)) : null, text(at(args, request.url)), request.body ? at(args, request.body) != null : undefined);
globalThis.__duruRecorder = recorder;

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const SCHEME = new RegExp(scheme, 'i');
const standIns = new WeakSet<object>();
// 요청 메서드와 create 가 아닌 속성은 아무 일도 하지 않는 값이라, interceptors 같은 설정 코드가 멈추지 않는다.
function requestObject(base: unknown): unknown {
  const join = (url: string | null) => (typeof base !== 'string' || url === null || SCHEME.test(url) ? url : url ? `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}` : base);
  const fromConfig = (config: { method?: unknown; url?: unknown } | undefined) => keep(text(config?.method) ?? 'get', join(text(config?.url)));
  const sendAny = (first: string | { method?: unknown; url?: unknown } | undefined, second?: { method?: unknown }) => (typeof first === 'string' ? fromConfig({ ...second, url: first }) : fromConfig(first));
  const verbs: Record<string | symbol, (...args: never[]) => unknown> = Object.fromEntries(VERBS.map((verb) => [verb, (url: unknown) => keep(verb, join(text(url)))]));
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

const leaves = (leaf: unknown) => new Proxy({}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => mark : typeof k === 'symbol' || k === 'then' ? undefined : leaf),
  has: () => true,
});
// 앞의 모양이 오류로 끝나거나 요청 없이 끝나면 다음 모양을 넣어 본다. URL 변수 값이 문자열이나 숫자인지 검사하는 앱은 키마다 문자열이나 숫자가 나와야 통과한다.
// 마지막 시도에서는 이름이 id 이거나 Id · ID 로 끝나는 키만 문자열이고, 다른 키를 읽으면 몇 단계를 내려가도 이 값이 다시 나온다. URL 경로 값과 함께 받은 body 에 `in` 을 쓰거나 배열 메서드를 호출하는 메서드도 그래야 요청까지 간다.
const ARGUMENT_SHAPES: (() => unknown)[] = [() => fake, () => leaves(mark), () => leaves(markNumber), () => idsAsText];

async function attempt(self: unknown, fn: Callable, argument: () => unknown): Promise<Attempt> {
  const record: SentRecord = { list: [], flooded: false };
  const token = {};
  sent.set(token, record);
  let error: AttemptError | null = null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const args = Array.from({ length: Math.max(fn.length, 1) }, argument);
    const result = current.run(token, () => fn.apply(self, args));
    const late = new Promise<{ late?: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ late: true }), timeoutMs);
    });
    const ended: { late?: boolean } = await Promise.race([Promise.resolve(result).then(() => ({})), late]);
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

async function call(unit: string, self: unknown, fn: Callable): Promise<Attempt> {
  let best: Attempt | null = null;
  for (const argument of ARGUMENT_SHAPES) {
    send({ type: 'attempt', unit });
    const tried = await attempt(self, fn, argument);
    if (!tried.error && tried.requests.length) return tried;
    const more = !best || tried.requests.length > best.requests.length || (tried.requests.length === best.requests.length && best.error && !tried.error);
    if (more) best = tried;
    if (tried.error?.late) break;
  }
  return best!;
}

async function classesOf(obj: object) {
  const found: (FunctionLocation | null)[] = [];
  for (let o = Object.getPrototypeOf(obj); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    const C = o.constructor;
    if (typeof C !== 'function' || isNative(C) || !isClass(C)) break;
    found.push(await locationOf(C));
  }
  return found.filter(Boolean);
}

const seen = new Map<unknown, { file: string; exportName: string }>();
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
    if (!value || !['object', 'function'].includes(typeof value) || isStandIn(value) || (typeof value === 'function' && isClass(value))) continue;
    if (seen.has(value)) {
      send({ type: 'same', file, exportName, as: seen.get(value) });
      continue;
    }
    seen.set(value, { file, exportName });
    let targets: [string | null, Callable, unknown][] = [];
    try {
      targets = typeof value === 'function' ? [[null, value, undefined]] : methodsOf(value).map(([member, fn]) => [member, fn, value]);
    } catch {
      // 속성을 읽다 던지는 값(Proxy 같은 것)은 호출할 메서드가 없는 것으로 본다.
    }
    if (typeof value === 'object') {
      let locations: (FunctionLocation | null)[] = [];
      try {
        locations = await classesOf(value);
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
      const { requests, error } = await call(unit, self, fn);
      send({ type: 'called', unit, file, exportName, member, location, requests, error });
    }
  }
}
send({ type: 'end' });
