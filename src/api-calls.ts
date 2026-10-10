import path from 'node:path';
import { Worker } from 'node:worker_threads';
import _traverse from '@babel/traverse';
import type { ClassMethod, ClassPrivateMethod, ClassProperty, TSParameterProperty } from '@babel/types';
import type { AttemptError, FunctionLocation, SentRequest, WorkerData } from './api-calls-worker.ts';
import type { BodyMethod, BodyTypeNotice } from './body-types.ts';
import { UNKNOWN } from './client.ts';
import { moduleCopier } from './constants.ts';
import { parseSource } from './parse.ts';
import { outsideSource } from './resolve.ts';
import type { ImportResolver } from './resolve.ts';

type NameNode = { name?: string; value?: string };
type Failure = { message: string; stack: string };
type Place = ReturnType<ReturnType<typeof moduleCopier>['place']>;

type WorkerMessage =
  | { type: 'end' }
  | { type: 'attempt'; unit: string }
  | { type: 'begin'; unit: string; location?: FunctionLocation | null }
  | { type: 'loaded'; unit: string }
  | { type: 'failed'; unit: string; file: string; error: Failure }
  | { type: 'same'; file: string; exportName: string; as: { file: string; exportName: string } }
  | { type: 'classes'; file: string; exportName: string; locations: FunctionLocation[] }
  | { type: 'called'; unit: string; file: string; exportName: string; member: string | null; location: FunctionLocation | null; requests: SentRequest[]; error: AttemptError | null };

type ReportedMessage = Exclude<WorkerMessage, { type: 'end' | 'attempt' | 'begin' }>;

type Outcome = { done: true } | { done?: undefined; unit: string | null; location: FunctionLocation | null; error: Failure };

interface CalledUnit {
  file: string;
  exportName: string;
  member: string | null;
  location: FunctionLocation | null;
  requests: SentRequest[];
  error: Failure | null;
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
}

const traverse = _traverse.default ?? _traverse;

const CALL_TIMEOUT_MS = 1000;
const LOAD_TIMEOUT_MS = 10000;
// 동기로 도는 메서드는 worker 안의 시간 제한이 듣지 않으므로 바깥에서 이만큼 더 기다린 뒤 worker 를 끊는다.
const STUCK_GRACE_MS = 2000;
const FAKE_MARK = '__duru_fake__';
// 1보다 작은 수라, 이 값만큼 도는 반복은 많아야 한 번 돈다.
const FAKE_NUMBER = 0.7310595213;
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

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

function requestOf({ method, url }: { method: string | null; url: string | null }) {
  const verb = method?.toUpperCase();
  let address = url;
  if (address !== null && SCHEME.test(address)) {
    try {
      const u = new URL(address);
      address = u.pathname + u.search;
    } catch {
      // URL 로 읽히지 않으면 받은 그대로 둔다.
    }
  }
  return { method: verb && /^[A-Z]+$/.test(verb) ? verb : null, url: address === null ? null : unmarked(address) };
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

// functions 는 「export 한 이름.메서드」마다 { file, line, endpoints, error? }, keyOf 는 (파일, export 한 이름) 에서 그 이름을 돌려준다.
export async function recordApiCalls(config: any, resolve: ImportResolver['resolve'], taken = new Set<string>()) {
  const { import: from, name, method, url, body, object } = config.requestFunction ?? {};
  const relative = Boolean(from?.startsWith('.'));
  const target = from ? resolve(path.join(config.srcRoot, 'index.js'), from) : null;
  if (relative && !target) throw new Error(`requestFunction.import ${from} names no file under srcRoot ${config.srcRoot}`);
  let recorded = false;
  const recorder = `const record = globalThis.${object ? '__duruRequestObject' : '__duruRecorder'};\nexport { record as ${name === 'default' ? 'default' : JSON.stringify(name)} };`;
  const copier = moduleCopier(config, resolve, {
    label: 'calledApiModules',
    fillMissing: true,
    replacement: (spec, resolved) => {
      if (!from || !((!relative && spec === from) || (target && resolved === target))) return null;
      recorded = true;
      return recorder;
    },
  });
  const rel = (f: string) => path.relative(config.srcRoot, f);
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
      const outcome = await runWorker({ modules, skip: [...skip], request: { method: method ?? null, url: url ?? '0', body: body ?? null }, timeoutMs: CALL_TIMEOUT_MS, mark: FAKE_MARK, markNumber: FAKE_NUMBER, scheme: SCHEME.source }, onMessage);
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
      throw new Error(`calledApiModules has no requestFunction and no listed file sent a request with fetch, so no request was recorded; name the function the API code sends its requests through in requestFunction${unrun}`);
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
    const bodyMethods: (BodyMethod & { endpoints: ApiEndpoint[] })[] = [];
    for (const c of called) {
      const key = c.member === null ? keyOf.get(`${c.file}\n${c.exportName}`)! : `${keyOf.get(`${c.file}\n${c.exportName}`)}.${c.member}`;
      const copy = c.location && copier.copyOfUrl(c.location.url);
      const place = (copy && copier.place(copy, c.location!.line, c.location!.column + 1)) as Place;
      if (c.member !== null && hiddenOf(`${c.file}\n${c.exportName}`).has(c.member)) continue;
      const line = place?.line ?? null;
      const seen = new Set<string>();
      const endpoints: ApiEndpoint[] = c.requests.map(requestOf).filter((r) => {
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
      };
      const sentBody = new Set(c.requests.filter((r) => r.body).map(requestOf).map((r) => `${r.method} ${r.url}`));
      const withBody = endpoints.filter((e) => e.method !== 'GET' && sentBody.has(`${e.method} ${e.url}`));
      if (line && withBody.length) bodyMethods.push({ key, file: place!.file, line, shownFile: rel(place!.file), endpoints: withBody });
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
    return { functions, keyOf: (file: string, exportName: string) => keyOf.get(`${file}\n${exportName}`) ?? prefixOf(file, exportName), failedModules, bodyTypeNotices, outsideStandIns, silentModules };
  } finally {
    copier.cleanup();
  }
}
