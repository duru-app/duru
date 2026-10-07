import path from 'node:path';
import { Worker } from 'node:worker_threads';
import _traverse from '@babel/traverse';
import { UNKNOWN } from './client.mjs';
import { moduleCopier } from './constants.mjs';
import { parseSource } from './parse.mjs';

const traverse = _traverse.default ?? _traverse;

const CALL_TIMEOUT_MS = 1000;
const LOAD_TIMEOUT_MS = 10000;
// 동기로 도는 메서드는 worker 안의 시간 제한이 듣지 않으므로 바깥에서 이만큼 더 기다린 뒤 worker 를 끊는다.
const STUCK_GRACE_MS = 2000;
const FAKE_MARK = '__duru_fake__';
// 1보다 작은 수라, 이 값만큼 도는 반복은 많아야 한 번 돈다.
const FAKE_NUMBER = 0.7310595213;
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

const firstLine = (text) => text.split('\n')[0];
const unmarked = (text) => text.replaceAll(FAKE_MARK, UNKNOWN).replaceAll(String(FAKE_NUMBER), UNKNOWN);

function classesIn(file) {
  let ast;
  try {
    ({ ast } = parseSource(file));
  } catch {
    return [];
  }
  const hidden = (node) => ['private', 'protected'].includes(node.accessibility);
  const nameOf = (key) => key?.name ?? key?.value;
  const found = [];
  traverse(ast, {
    Class(p) {
      const members = new Map();
      for (const member of p.node.body.body) {
        if (member.type === 'ClassMethod' || member.type === 'ClassProperty') members.set(nameOf(member.key), hidden(member));
        if (member.type === 'ClassMethod' && member.kind === 'constructor') {
          for (const param of member.params) {
            if (param.type === 'TSParameterProperty') members.set(nameOf(param.parameter.type === 'AssignmentPattern' ? param.parameter.left : param.parameter), hidden(param));
          }
        }
      }
      found.push({ start: p.node.loc.start.line, end: p.node.loc.end.line, members });
    },
  });
  return found;
}

function requestOf({ method, url }) {
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

function runWorker(workerData, onMessage) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./api-calls-worker.mjs', import.meta.url), { workerData, stdout: true, stderr: true });
    worker.stdout.resume();
    worker.stderr.resume();
    let unit = null;
    let timer = null;
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(outcome);
    };
    let location = null;
    const watch = () => {
      const allowed = unit.startsWith('load\n') ? LOAD_TIMEOUT_MS : CALL_TIMEOUT_MS;
      const waited = unit.startsWith('load\n') ? LOAD_TIMEOUT_MS : CALL_TIMEOUT_MS + STUCK_GRACE_MS;
      timer = setTimeout(() => finish({ unit, location, error: { message: `did not finish within ${allowed} ms`, stack: '' } }), waited);
    };
    worker.on('message', (m) => {
      clearTimeout(timer);
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
    worker.on('error', (e) => finish({ unit, location, error: { message: String(e?.message ?? e), stack: String(e?.stack ?? '') } }));
    worker.on('exit', () => finish({ unit, location, error: { message: 'stopped the run before finishing', stack: '' } }));
  });
}

// functions 는 「export 한 이름.메서드」마다 { file, line, endpoints, error? }, keyOf 는 (파일, export 한 이름) 에서 그 이름을 돌려준다.
export async function recordApiCalls(config, resolve, taken = new Set()) {
  const { import: from, name, method, url } = config.requestFunction;
  const relative = from.startsWith('.');
  const target = resolve(path.join(config.srcRoot, 'index.js'), from);
  if (relative && !target) throw new Error(`requestFunction.import ${from} names no file under srcRoot ${config.srcRoot}`);
  let recorded = false;
  const recorder = `const record = globalThis.__duruRecorder;\nexport { record as ${name === 'default' ? 'default' : JSON.stringify(name)} };`;
  const copier = moduleCopier(config, resolve, {
    label: 'calledApiModules',
    fillMissing: true,
    replacement: (spec, resolved) => {
      if (!((!relative && spec === from) || (target && resolved === target))) return null;
      recorded = true;
      return recorder;
    },
  });
  const rel = (f) => path.relative(config.srcRoot, f);
  const failedModules = [];
  const modules = [];
  try {
    for (const relFile of config.calledApiModules) {
      const file = path.join(config.srcRoot, relFile);
      try {
        modules.push({ file, url: copier.url(copier.copy(file)) });
      } catch (e) {
        failedModules.push({ file: relFile, error: firstLine(String(e?.message ?? e)) });
      }
    }
    copier.finish();
    if (modules.length && !recorded) {
      throw new Error(`requestFunction.import ${from} is imported by none of the files that calledApiModules runs, so no request would be recorded`);
    }

    const called = [];
    const same = new Map();
    const classes = new Map();
    const skip = new Set();
    const onMessage = (m) => {
      if (m.type === 'failed' || m.type === 'called') skip.add(m.unit);
      if (m.type === 'failed') failedModules.push({ file: rel(m.file), error: firstLine(copier.explain(m.error)) });
      else if (m.type === 'same') same.set(`${m.file}\n${m.exportName}`, `${m.as.file}\n${m.as.exportName}`);
      else if (m.type === 'called') called.push(m);
      else if (m.type === 'classes') classes.set(`${m.file}\n${m.exportName}`, m.locations);
    };
    for (;;) {
      const outcome = await runWorker({ modules, skip: [...skip], request: { method: method ?? null, url }, timeoutMs: CALL_TIMEOUT_MS, mark: FAKE_MARK, markNumber: FAKE_NUMBER }, onMessage);
      if (outcome.done) break;
      if (!outcome.unit) throw new Error(`calledApiModules: the run stopped outside any module or method: ${firstLine(outcome.error.message)}`);
      skip.add(outcome.unit);
      const [kind, file, exportName, member] = outcome.unit.split('\n');
      if (kind === 'load') failedModules.push({ file: rel(file), error: firstLine(copier.rename(outcome.error.message)) });
      else called.push({ file, exportName, member: member || null, location: outcome.location ?? null, requests: [], error: outcome.error });
    }

    const owners = new Map();
    for (const c of called) {
      const owner = `${c.file}\n${c.exportName}`;
      if (!owners.has(c.exportName)) owners.set(c.exportName, new Set());
      owners.get(c.exportName).add(owner);
    }
    const prefixOf = (file, exportName) => (owners.get(exportName)?.size > 1 || taken.has(exportName) ? `${rel(file)}#${exportName}` : exportName);
    const keyOf = new Map();
    for (const c of called) keyOf.set(`${c.file}\n${c.exportName}`, prefixOf(c.file, c.exportName));
    for (const [alias, first] of same) if (keyOf.has(first)) keyOf.set(alias, keyOf.get(first));

    // TypeScript 의 private · protected 멤버는 외부에서 호출할 수 없으므로 API 로 보지 않는다. 하위 클래스가 다시 선언하면 그 선언을 따른다.
    const parsed = new Map();
    const membersAt = (file, line) => {
      if (!parsed.has(file)) parsed.set(file, classesIn(file));
      return parsed.get(file).filter((c) => c.start <= line && line <= c.end).at(-1)?.members ?? new Map();
    };
    const hidden = new Map();
    const hiddenOf = (owner) => {
      if (!hidden.has(owner)) {
        const decided = new Map();
        for (const l of classes.get(owner) ?? []) {
          const copy = copier.copyOfUrl(l.url);
          const place = copy && copier.place(copy, l.line, l.column + 1);
          if (!place?.line) continue;
          for (const [name, isHidden] of membersAt(place.file, place.line)) if (!decided.has(name)) decided.set(name, isHidden);
        }
        hidden.set(owner, new Set([...decided].filter(([, isHidden]) => isHidden).map(([name]) => name)));
      }
      return hidden.get(owner);
    };
    const functions = {};
    for (const c of called) {
      const key = c.member === null ? keyOf.get(`${c.file}\n${c.exportName}`) : `${keyOf.get(`${c.file}\n${c.exportName}`)}.${c.member}`;
      const copy = c.location && copier.copyOfUrl(c.location.url);
      const place = copy && copier.place(copy, c.location.line, c.location.column + 1);
      if (c.member !== null && hiddenOf(`${c.file}\n${c.exportName}`).has(c.member)) continue;
      const line = place?.line ?? null;
      const seen = new Set();
      const endpoints = c.requests.map(requestOf).filter((r) => {
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
    }
    return { functions, keyOf: (file, exportName) => keyOf.get(`${file}\n${exportName}`) ?? prefixOf(file, exportName), failedModules };
  } finally {
    copier.cleanup();
  }
}
