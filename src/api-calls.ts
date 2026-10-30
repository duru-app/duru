import path from 'node:path';
import { Worker } from 'node:worker_threads';
import _traverse from '@babel/traverse';
import type { ClassMethod, ClassPrivateMethod, ClassProperty, TSParameterProperty } from '@babel/types';
import type { AttemptError, FunctionInputs, FunctionLocation, SentRequest, WorkerData } from './api-calls-worker.ts';
import type { BodyMethod, BodyTypeNotice } from './body-types.ts';
import { UNKNOWN } from './client.ts';
import { moduleCopier } from './constants.ts';
import { parseSource } from './parse.ts';
import { outsideSource } from './resolve.ts';
import type { ImportResolver } from './resolve.ts';
import { cleanAddress, pathOnSite } from './sent-address.ts';

type NameNode = { name?: string; value?: string };
type Failure = { message: string; stack: string; late?: boolean };
type Place = ReturnType<ReturnType<typeof moduleCopier>['place']>;

type WorkerMessage =
  | { type: 'end' }
  | { type: 'attempt'; unit: string }
  | { type: 'begin'; unit: string; location?: FunctionLocation | null }
  | { type: 'loaded'; unit: string }
  | { type: 'failed'; unit: string; file: string; error: Failure }
  | { type: 'same'; file: string; exportName: string; as: { file: string; exportName: string } }
  | { type: 'classes'; file: string; exportName: string; locations: FunctionLocation[] }
  | { type: 'called'; unit: string; file: string; exportName: string; member: string | null; location: FunctionLocation | null; requests: SentRequest[]; error: AttemptError | null; inputs?: FunctionInputs; inputsUnknown?: string };

type ReportedMessage = Exclude<WorkerMessage, { type: 'end' | 'attempt' | 'begin' }>;

type Outcome = { done: true } | { done?: undefined; unit: string | null; location: FunctionLocation | null; error: Failure };

interface CalledUnit {
  file: string;
  exportName: string;
  member: string | null;
  location: FunctionLocation | null;
  requests: SentRequest[];
  error: Failure | null;
  inputs?: FunctionInputs;
  inputsUnknown?: string;
}

export interface ApiEndpoint {
  method: string | null;
  url: string | null;
  line: number | null;
  bodyOptions?: string[];
}

export interface ApiFunction {
  file: string | null;
  line: number | null;
  endpoints: ApiEndpoint[];
  error?: string;
  inputs?: FunctionInputs;
  inputsUnknown?: string;
}

const traverse = _traverse.default ?? _traverse;

const CALL_TIMEOUT_MS = 1000;
const LOAD_TIMEOUT_MS = 10000;
// 동기로 도는 메서드는 worker 안의 시간 제한이 듣지 않으므로 바깥에서 이만큼 더 기다린 뒤 worker 를 끊는다.
const STUCK_GRACE_MS = 2000;
const FAKE_MARK = '__duru_fake__';
// 1보다 작은 수라, 이 값만큼 도는 반복은 많아야 한 번 돈다.
const FAKE_NUMBER = 0.7310595213;

// react-query 의 훅은 받은 질의 함수나 변경 함수를 한 번 불러, 그 함수가 보내는 요청이 훅을 부른 API 함수의 요청이 된다.
// 첫 인자가 키이면 v3 처럼 그다음 자리를 보고, 아니면 첫 인자를 옵션 객체로 본다.
const REACT_QUERY = `const run = (fn, key) => {
  if (typeof fn !== 'function') return;
  let sent;
  try {
    sent = fn(globalThis.__duruArgument(typeof key === 'string' ? [key] : key));
  } catch (e) {
    sent = Promise.reject(e);
  }
  globalThis.__duruWait(sent);
};
const isKey = (value) => typeof value === 'string' || Array.isArray(value);
const fnAfterKey = (value, name) => (typeof value === 'function' ? value : value?.[name]);
export const useQuery = (first, second) => {
  const [fn, key] = isKey(first) ? [fnAfterKey(second, 'queryFn'), first] : [first?.queryFn, first?.queryKey];
  run(fn, key);
  return globalThis.__duruNothing;
};
export const useInfiniteQuery = useQuery;
export const useSuspenseQuery = useQuery;
export const useSuspenseInfiniteQuery = useQuery;
export const useMutation = (first, second) => {
  run(isKey(first) ? fnAfterKey(second, 'mutationFn') : fnAfterKey(first, 'mutationFn'));
  return globalThis.__duruNothing;
};
export const useQueries = (options) => {
  const queries = Array.isArray(options) ? options : options?.queries;
  if (Array.isArray(queries)) for (const query of queries) run(query?.queryFn, query?.queryKey);
  return globalThis.__duruNothing;
};
export const useSuspenseQueries = useQueries;
export const queryOptions = (options) => options;
export const infiniteQueryOptions = queryOptions;
export const mutationOptions = queryOptions;`;
const PACKAGE_STAND_INS = { 'react-query': REACT_QUERY, '@tanstack/react-query': REACT_QUERY };

const firstLine = (text: string) => text.split('\n')[0];
const unmarked = (text: string) => text.replaceAll(FAKE_MARK, UNKNOWN).replaceAll(String(FAKE_NUMBER), UNKNOWN);

function classesIn(file: string) {
  let ast;
  try {
    ({ ast } = parseSource(file));
  } catch {
    return [];
  }
  const hidden = (node: ClassMethod | ClassPrivateMethod | ClassProperty | TSParameterProperty) => ['private', 'protected'].includes(node.accessibility as string);
  const nameOf = (key: NameNode | null | undefined) => key?.name ?? key?.value;
  const found: { start: number; end: number; members: Map<string | undefined, boolean> }[] = [];
  traverse(ast, {
    Class(p) {
      const members = new Map<string | undefined, boolean>();
      for (const member of p.node.body.body) {
        if (member.type === 'ClassMethod' || member.type === 'ClassProperty') members.set(nameOf(member.key as NameNode), hidden(member));
        if (member.type === 'ClassMethod' && member.kind === 'constructor') {
          for (const param of member.params) {
            if (param.type === 'TSParameterProperty') members.set(nameOf((param.parameter.type === 'AssignmentPattern' ? param.parameter.left : param.parameter) as NameNode), hidden(param));
          }
        }
      }
      found.push({ start: p.node.loc!.start.line, end: p.node.loc!.end.line, members });
    },
  });
  return found;
}

function requestOf({ method, url }: { method: string | null; url: string | null }, server: string | null) {
  const verb = method?.toUpperCase();
  const address = url === null ? null : cleanAddress(url);
  return { method: verb && /^[A-Z]+$/.test(verb) ? verb : null, url: address === null ? null : unmarked(pathOnSite(address, server) ?? address) };
}

function runWorker(workerData: WorkerData, onMessage: (m: ReportedMessage) => void) {
  return new Promise<Outcome>((resolve) => {
    const worker = new Worker(new URL('./api-calls-worker.ts', import.meta.url), { workerData, stdout: true, stderr: true });
    worker.stdout.resume();
    worker.stderr.resume();
    let unit: string | null = null;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const finish = (outcome: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer!);
      worker.terminate();
      resolve(outcome);
    };
    let location: FunctionLocation | null = null;
    const watch = () => {
      const allowed = unit!.startsWith('load\n') ? LOAD_TIMEOUT_MS : CALL_TIMEOUT_MS;
      const waited = unit!.startsWith('load\n') ? LOAD_TIMEOUT_MS : CALL_TIMEOUT_MS + STUCK_GRACE_MS;
      timer = setTimeout(() => finish({ unit, location, error: { message: `did not finish within ${allowed} ms`, stack: '' } }), waited);
    };
    worker.on('message', (m: WorkerMessage) => {
      clearTimeout(timer!);
      if (m.type === 'end') return finish({ done: true });
      if (m.type === 'attempt') return watch();
      if (m.type === 'begin') {
        unit = m.unit;
        location = m.location ?? null;
        return watch();
      }
      unit = null;
      return onMessage(m);
    });
    worker.on('error', (e: any) => finish({ unit, location, error: { message: String(e?.message ?? e), stack: String(e?.stack ?? '') } }));
    worker.on('exit', () => finish({ unit, location, error: { message: 'stopped the run before finishing', stack: '' } }));
  });
}

// requestFunction.import 가 패키지면 null 이다.
export function requestFunctionFile(config: any, resolve: ImportResolver['resolve']) {
  const from: string | undefined = config.requestFunction?.import;
  const target = from ? resolve(path.join(config.srcRoot, 'index.js'), from) : null;
  if (from?.startsWith('.') && !target) throw new Error(`requestFunction.import ${from} names no file under srcRoot ${config.srcRoot}`);
  return target;
}

function exportedValues(file: string, names: string[]) {
  const values = new Map(names.map((name) => [name, name]));
  let ast;
  try {
    ({ ast } = parseSource(file));
  } catch {
    return values;
  }
  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue;
    if (!node.source) {
      for (const sp of node.specifiers) {
        if (sp.type !== 'ExportSpecifier' || sp.exportKind === 'type') continue;
        const exported = sp.exported.type === 'Identifier' ? sp.exported.name : sp.exported.value;
        if (values.has(exported)) values.set(exported, sp.local.name);
      }
    }
    if (node.declaration?.type === 'VariableDeclaration') {
      for (const d of node.declaration.declarations) {
        if (d.id.type !== 'Identifier' || d.init?.type !== 'Identifier') continue;
        if (values.get(d.id.name) === d.id.name) values.set(d.id.name, d.init.name);
      }
    }
  }
  return values;
}

export async function apiModuleInputs(config: any, resolve: ImportResolver['resolve'], exports: Record<string, string[]>) {
  const { import: from, name, method, url, body, object } = config.requestFunction ?? {};
  if (!from) return [];
  const relative = Boolean(from.startsWith('.'));
  const target = requestFunctionFile(config, resolve);
  const recorder = `const record = globalThis.${object ? '__duruRequestObject' : '__duruRecorder'};\nexport { record as ${name === 'default' ? 'default' : JSON.stringify(name)} };`;
  const copier = moduleCopier({ ...config, constantStubs: { ...PACKAGE_STAND_INS, ...config.constantStubs } }, resolve, {
    label: 'apiModules',
    fillMissing: true,
    replacement: (spec, resolved) => (!((!relative && spec === from) || (target && resolved === target)) ? null : recorder),
  });
  const apiOf = new Map<string, Map<string, string>>();
  const reasons = new Map<string, string>();
  const found = new Map<string, { inputs?: FunctionInputs; inputsUnknown?: string }>();
  const put = (file: string, name: string, inputs: { inputs?: FunctionInputs; inputsUnknown?: string }) => {
    found.set(`${file}\n${name}`, inputs);
  };
  try {
    const modules: { file: string; url: string }[] = [];
    const wanted: Record<string, Record<string, string>> = {};
    for (const [relFile, names] of Object.entries(exports)) {
      if (!names.length) continue;
      const file = path.join(config.srcRoot, relFile);
      apiOf.set(file, exportedValues(file, names));
      wanted[file] = Object.fromEntries(apiOf.get(file)!);
      try {
        modules.push({ file, url: copier.url(copier.copy(file)) });
      } catch (e: any) {
        reasons.set(file, firstLine(String(e?.message ?? e)));
      }
    }
    copier.finish();
    const staticName = new Map([...apiOf].flatMap(([file, names]) => [...names].map(([name, value]) => [`${file}\n${value}`, name])));
    const read = (m: ReportedMessage) => {
      if (m.type !== 'called') return;
      const name = m.member === null || m.member === undefined ? staticName.get(`${m.file}\n${m.exportName}`) : apiOf.get(m.file)?.has(m.member) ? m.member : undefined;
      if (name === undefined) return;
      put(m.file, name, { ...(m.inputs && { inputs: m.inputs }), ...(m.inputsUnknown && { inputsUnknown: m.inputsUnknown }) });
    };
    const gaveUp = new Map<string, { file: string; reason: string }>();
    const retry = new Map<string, { file: string; reason: string }>();
    const skip = new Set<string>();
    const run: WorkerData = { modules, skip: [], request: { method: method ?? null, url: url ?? '0', body: body ?? null }, timeoutMs: CALL_TIMEOUT_MS, mark: FAKE_MARK, markNumber: FAKE_NUMBER, inputsOnly: true, exports: wanted };
    for (;;) {
      const outcome = await runWorker({ ...run, skip: [...skip] }, (m) => {
        if ('unit' in m && gaveUp.has(m.unit)) return;
        read(m);
      });
      if (outcome.done) break;
      if (!outcome.unit) throw new Error(`apiModules: the run stopped outside any module or function: ${firstLine(outcome.error.message)}`);
      skip.add(outcome.unit);
      const [kind, file] = outcome.unit.split('\n');
      const reason = firstLine(copier.rename(outcome.error.message));
      if (kind === 'load' && outcome.error?.late) retry.set(outcome.unit, { file, reason });
      else gaveUp.set(outcome.unit, { file, reason });
    }
    for (const [file, names] of apiOf) {
      const reason = reasons.get(file) ?? [...retry.values(), ...gaveUp.values()].find((s) => s.file === file)?.reason;
      for (const name of names.keys()) if (!found.has(`${file}\n${name}`)) put(file, name, { inputsUnknown: reason ?? `the file exports no ${name}` });
    }
    for (const { file } of new Set([...retry.values(), ...gaveUp.values()])) {
      const outcome = await runWorker({ ...run, modules: [{ file, url: modules.find((m) => m.file === file)!.url }] }, read);
      if (!outcome.done && !outcome.unit && outcome.error) for (const name of apiOf.get(file)!.keys()) if (!found.has(`${file}\n${name}`)) put(file, name, { inputsUnknown: firstLine(copier.rename(outcome.error.message)) });
    }
    const rel = (f: string) => path.relative(config.srcRoot, f);
    return [...found].flatMap(([key, inputs]) => {
      const [file, name] = key.split('\n');
      return name === '' || !apiOf.get(file)?.has(name) ? [] : [{ file: rel(file), exportName: name, found: inputs }];
    });
  } finally {
    copier.cleanup();
  }
}

// functions 는 「export 한 이름.메서드」마다 { file, line, endpoints, error? }, keyOf 는 (파일, export 한 이름) 에서 그 이름을 돌려준다.
export async function recordApiCalls(config: any, resolve: ImportResolver['resolve'], taken = new Set<string>()) {
  const { import: from, name, method, url, body, object } = config.requestFunction ?? {};
  const relative = Boolean(from?.startsWith('.'));
  const target = requestFunctionFile(config, resolve);
  let recorded = false;
  const recorder = `const record = globalThis.${object ? '__duruRequestObject' : '__duruRecorder'};\nexport { record as ${name === 'default' ? 'default' : JSON.stringify(name)} };`;
  const copier = moduleCopier({ ...config, constantStubs: { ...PACKAGE_STAND_INS, ...config.constantStubs } }, resolve, {
    label: 'calledApiModules',
    fillMissing: true,
    replacement: (spec, resolved) => {
      if (!from || !((!relative && spec === from) || (target && resolved === target))) return null;
      recorded = true;
      return recorder;
    },
  });
  const rel = (f: string) => path.relative(config.srcRoot, f);
  const server: string | null = config.app?.server ?? null;
  const failedModules: { file: string; error: string }[] = [];
  const modules: { file: string; url: string }[] = [];
  try {
    for (const relFile of config.calledApiModules) {
      const file = path.join(config.srcRoot, relFile);
      try {
        modules.push({ file, url: copier.url(copier.copy(file)) });
      } catch (e: any) {
        failedModules.push({ file: relFile, error: firstLine(String(e?.message ?? e)) });
      }
    }
    copier.finish();
    if (from && modules.length && !recorded) {
      throw new Error(`requestFunction.import ${from} is imported by none of the files that calledApiModules runs, so no request would be recorded`);
    }

    const called: CalledUnit[] = [];
    const same = new Map<string, string>();
    const classes = new Map<string, FunctionLocation[]>();
    const skip = new Set<string>();
    const onMessage = (m: ReportedMessage) => {
      if (m.type === 'failed' || m.type === 'called') skip.add(m.unit);
      if (m.type === 'failed') failedModules.push({ file: rel(m.file), error: firstLine(copier.explain(m.error)) });
      else if (m.type === 'same') same.set(`${m.file}\n${m.exportName}`, `${m.as.file}\n${m.as.exportName}`);
      else if (m.type === 'called') called.push(m);
      else if (m.type === 'classes') classes.set(`${m.file}\n${m.exportName}`, m.locations);
    };
    for (;;) {
      const outcome = await runWorker({ modules, skip: [...skip], request: { method: method ?? null, url: url ?? '0', body: body ?? null }, timeoutMs: CALL_TIMEOUT_MS, mark: FAKE_MARK, markNumber: FAKE_NUMBER }, onMessage);
      if (outcome.done) break;
      if (!outcome.unit) throw new Error(`calledApiModules: the run stopped outside any module or method: ${firstLine(outcome.error.message)}`);
      skip.add(outcome.unit);
      const [kind, file, exportName, member] = outcome.unit.split('\n');
      if (kind === 'load') failedModules.push({ file: rel(file), error: firstLine(copier.rename(outcome.error.message)) });
      else called.push({ file, exportName, member: member || null, location: outcome.location ?? null, requests: [], error: outcome.error });
    }
    const failed = new Set(failedModules.map((f) => f.file));
    const sent = called.filter((c) => c.requests.length);
    const sentOwners = new Set(sent.map((c) => `${c.file}\n${c.exportName}`));
    const sendingFiles = new Set([...sent.map((c) => c.file), ...[...same].filter(([, owner]) => sentOwners.has(owner)).map(([alias]) => alias.split('\n')[0])]);
    const ran = [...new Set(modules.map((m) => m.file))].filter((file) => !failed.has(rel(file)));
    const silentModules = from ? [] : ran.filter((file) => !sendingFiles.has(file)).map(rel);
    if (!from && !sendingFiles.size && (ran.length || failedModules.length)) {
      const unrun = failedModules.map((f) => `; ${f.file} did not run: ${f.error}`).join('');
      throw new Error(`calledApiModules has no requestFunction and no listed file sent a request with fetch or by moving the browser, so no request was recorded; name the function the API code sends its requests through in requestFunction${unrun}`);
    }

    const owners = new Map<string, Set<string>>();
    for (const c of called) {
      const owner = `${c.file}\n${c.exportName}`;
      if (!owners.has(c.exportName)) owners.set(c.exportName, new Set());
      owners.get(c.exportName)!.add(owner);
    }
    const prefixOf = (file: string, exportName: string) => ((owners.get(exportName)?.size as number) > 1 || taken.has(exportName) ? `${rel(file)}#${exportName}` : exportName);
    const keyOf = new Map<string, string>();
    for (const c of called) keyOf.set(`${c.file}\n${c.exportName}`, prefixOf(c.file, c.exportName));
    for (const [alias, first] of same) if (keyOf.has(first)) keyOf.set(alias, keyOf.get(first)!);

    // TypeScript 의 private · protected 멤버는 외부에서 호출할 수 없으므로 API 로 보지 않는다. 하위 클래스가 다시 선언하면 그 선언을 따른다.
    const parsed = new Map<string, ReturnType<typeof classesIn>>();
    const membersAt = (file: string, line: number) => {
      if (!parsed.has(file)) parsed.set(file, classesIn(file));
      return parsed.get(file)!.filter((c) => c.start <= line && line <= c.end).at(-1)?.members ?? new Map();
    };
    const hidden = new Map<string, Set<string | undefined>>();
    const hiddenOf = (owner: string) => {
      if (!hidden.has(owner)) {
        const decided = new Map<string | undefined, boolean>();
        for (const l of classes.get(owner) ?? []) {
          const copy = copier.copyOfUrl(l.url);
          const place = (copy && copier.place(copy, l.line, l.column + 1)) as Place;
          if (!place?.line) continue;
          for (const [name, isHidden] of membersAt(place.file, place.line)) if (!decided.has(name)) decided.set(name, isHidden);
        }
        hidden.set(owner, new Set([...decided].filter(([, isHidden]) => isHidden).map(([name]) => name)));
      }
      return hidden.get(owner)!;
    };
    const functions: Record<string, ApiFunction> = {};
    const exportsOf = new Map<string, { file: string; exportName: string }[]>();
    const exported = (key: string, file: string, exportName: string) => exportsOf.set(key, [...(exportsOf.get(key) ?? []), { file, exportName }]);
    const bodyMethods: (BodyMethod & { endpoints: ApiEndpoint[] })[] = [];
    for (const c of called) {
      const key = c.member === null ? keyOf.get(`${c.file}\n${c.exportName}`)! : `${keyOf.get(`${c.file}\n${c.exportName}`)}.${c.member}`;
      const copy = c.location && copier.copyOfUrl(c.location.url);
      const place = (copy && copier.place(copy, c.location!.line, c.location!.column + 1)) as Place;
      if (c.member !== null && hiddenOf(`${c.file}\n${c.exportName}`).has(c.member)) continue;
      const line = place?.line ?? null;
      const seen = new Set<string>();
      const endpoints: ApiEndpoint[] = c.requests.map((r) => requestOf(r, server)).filter((r) => {
        const k = `${r.method} ${r.url}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).map((r) => ({ ...r, line }));
      functions[key] = {
        file: place ? rel(place.file) : null,
        line,
        endpoints,
        ...(c.error && { error: unmarked(firstLine(copier.rename(c.error.message))) }),
        ...(c.inputs && { inputs: c.inputs }),
        ...(c.inputsUnknown && { inputsUnknown: c.inputsUnknown }),
      };
      exported(key, c.file, c.exportName);
      const sentBody = new Set(c.requests.filter((r) => r.body).map((r) => requestOf(r, server)).map((r) => `${r.method} ${r.url}`));
      const withBody = endpoints.filter((e) => e.method !== 'GET' && sentBody.has(`${e.method} ${e.url}`));
      if (line && withBody.length) bodyMethods.push({ key, file: place!.file, line, shownFile: rel(place!.file), endpoints: withBody });
    }
    for (const [alias, first] of same) {
      const owner = keyOf.get(first);
      const [file, exportName] = alias.split('\n');
      if (owner) for (const key of Object.keys(functions)) if (key === owner || key.startsWith(`${owner}.`)) exported(key, file, exportName);
    }
    const bodyTypeNotices: BodyTypeNotice[] = [];
    if (config.tsconfig && body && config.bodyArgKeys.length && bodyMethods.length) {
      const { readBodyFields } = await import('./body-types.ts');
      const { fields, notices } = readBodyFields(config.tsconfig, config.bodyArgKeys, bodyMethods);
      for (const m of bodyMethods) if (fields.has(m.key)) for (const e of m.endpoints) e.bodyOptions = fields.get(m.key);
      bodyTypeNotices.push(...notices);
    }
    const outside = new Map<string, { spec: string; file: string; importedBy: Set<string> }>();
    for (const { spec, from } of copier.standIns()) {
      const file = outsideSource(config.srcRoot, from, spec, config.aliases);
      if (!file) continue;
      if (!outside.has(spec)) outside.set(spec, { spec, file: rel(file), importedBy: new Set() });
      outside.get(spec)!.importedBy.add(rel(from));
    }
    const outsideStandIns = [...outside.values()].map((s) => ({ ...s, importedBy: [...s.importedBy].sort() }));
    return { functions, exportsOf, keyOf: (file: string, exportName: string) => keyOf.get(`${file}\n${exportName}`) ?? prefixOf(file, exportName), failedModules, bodyTypeNotices, outsideStandIns, silentModules };
  } finally {
    copier.cleanup();
  }
}
