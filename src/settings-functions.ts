import fs from 'node:fs';
import path from 'node:path';
import _traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import type { ExportSpecifier, Identifier, ImportDeclaration, ObjectExpression, Program, VariableDeclaration, VariableDeclarator } from '@babel/types';
import { compare } from './config.ts';
import { parseSource, SOURCE_SYNTAX_ERROR } from './parse.ts';
import { resolveImport } from './resolve.ts';

const traverse = _traverse.default ?? _traverse;

interface ImportEntry {
  from: string;
  name: string;
}

interface ExportEntry {
  local?: string;
  from?: string;
  name?: string;
}

interface ModuleTable {
  specs: string[];
  imported: Map<string, ImportEntry>;
  exported: Map<string, ExportEntry>;
  stars: string[];
}

interface SettingsFunction {
  import: string;
  name: string;
  root: string;
  section: string;
  origin: string | null;
  called: boolean;
}

export interface SettingsCall {
  file: string;
  line: number;
  start: number | null;
  root: string;
  section: string;
  exports: string[];
  arg: NodePath<ObjectExpression>;
}

interface FoundCall extends SettingsCall {
  binding: Binding | null | undefined;
}

interface CallNotice {
  file: string | null;
  line: number | null;
  reason: string;
}

type ModuleReader = ReturnType<typeof moduleReader>;

const SOURCE = /\.(jsx?|tsx?)$/;
const nameOf = (node: { name?: string; value?: string }) => (node.name ?? node.value) as string;
const importedName = (spec: NodePath) => (spec.isImportDefaultSpecifier() ? 'default' : spec.isImportSpecifier() ? nameOf(spec.node.imported) : null);

function dynamicImports(node: any, specs: string[]) {
  if (Array.isArray(node)) {
    for (const child of node) dynamicImports(child, specs);
    return;
  }
  if (typeof node?.type !== 'string') return;
  if (node.type === 'CallExpression' && node.callee.type === 'Import' && node.arguments[0]?.type === 'StringLiteral') specs.push(node.arguments[0].value);
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'loc' && key !== 'extra' && !key.endsWith('Comments') && value && typeof value === 'object') dynamicImports(value, specs);
  }
}

function moduleTable(program: Program): ModuleTable {
  const specs: string[] = [];
  const imported = new Map<string, ImportEntry>();
  const exported = new Map<string, ExportEntry>();
  const stars: string[] = [];
  for (const node of program.body as any[]) {
    if (node.source) specs.push(node.source.value);
    if (node.type === 'ImportDeclaration') {
      for (const s of node.specifiers) {
        if (s.type !== 'ImportNamespaceSpecifier') imported.set(s.local.name, { from: node.source.value, name: s.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(s.imported) });
      }
    } else if (node.type === 'ExportAllDeclaration') stars.push(node.source.value);
    else if (node.type === 'ExportDefaultDeclaration') {
      exported.set('default', node.declaration.type === 'Identifier' ? { local: node.declaration.name } : {});
    } else if (node.type === 'ExportNamedDeclaration') {
      for (const s of node.specifiers) {
        if (s.type !== 'ExportSpecifier') continue;
        exported.set(nameOf(s.exported), node.source ? { from: node.source.value, name: nameOf(s.local) } : { local: s.local.name });
      }
      const declared = node.declaration?.declarations?.map((d: any) => d.id.name) ?? [node.declaration?.id?.name];
      for (const name of declared) if (name) exported.set(name, {});
    }
  }
  for (const [name, entry] of exported) if (entry.local && imported.has(entry.local)) exported.set(name, imported.get(entry.local)!);
  dynamicImports(program.body, specs);
  return { specs, imported, exported, stars };
}

function moduleReader(config: any) {
  const tables = new Map<string, ModuleTable | null>();
  const resolved = new Map<string, string | null>();
  const resolve = (file: string, spec: string): string | null => {
    const key = `${file}\n${spec}`;
    if (!resolved.has(key)) resolved.set(key, resolveImport(config.srcRoot, file, spec, config.aliases));
    return resolved.get(key) as string | null;
  };
  const read = (file: string): ModuleTable | null => {
    if (!tables.has(file)) {
      let table: ModuleTable | null = null;
      try {
        if (SOURCE.test(file)) table = moduleTable(parseSource(file).ast.program);
      } catch (err) {
        if ((err as { code?: string }).code !== SOURCE_SYNTAX_ERROR) throw err;
      }
      tables.set(file, table);
    }
    return tables.get(file) as ModuleTable | null;
  };
  const origin = (file: string, name: string, seen = new Set<string>()): string | null => {
    const mark = `${file}#${name}`;
    if (seen.has(mark)) return null;
    seen.add(mark);
    const table = read(file);
    const entry = table?.exported.get(name);
    if (entry) return entry.from ? originOf(file, entry.from, entry.name!, seen) : mark;
    if (!table || name === 'default') return null;
    for (const spec of table.stars) {
      const target = resolve(file, spec);
      const found = target && origin(target, name, seen);
      if (found) return found;
    }
    return null;
  };
  const originOf = (file: string, spec: string, name: string, seen = new Set<string>()): string => {
    const target = resolve(file, spec);
    return target ? origin(target, name, seen) ?? `${target}#${name}` : `${spec}#${name}`;
  };
  return { read, resolve, originOf };
}

function reachedFiles(config: any, modules: ModuleReader) {
  const reached: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = config.routeFiles.map((f: string) => path.join(config.srcRoot, f));
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const table = fs.statSync(file, { throwIfNoEntry: false })?.isFile() && modules.read(file);
    if (!table) continue;
    reached.push(file);
    for (const spec of table.specs) {
      const target = modules.resolve(file, spec);
      if (target) stack.push(target);
    }
  }
  return reached;
}

// 라우트 파일에서 import 를 따라 닿는 파일만 본다.
export function findSettingsCalls(config: any) {
  const modules = moduleReader(config);
  const fns: SettingsFunction[] = config.settingsFunctions.map((fn: Omit<SettingsFunction, 'origin' | 'called'>) => {
    const target = resolveImport(config.srcRoot, path.join(config.srcRoot, 'index.js'), fn.import, config.aliases);
    if (fn.import.startsWith('.') && !target) throw new Error(`settingsFunctions import ${fn.import} names no file under srcRoot ${config.srcRoot}`);
    return { ...fn, origin: modules.originOf(path.join(config.srcRoot, 'index.js'), fn.import, fn.name), called: false };
  });
  const calls: SettingsCall[] = [];
  const unread: { file: string; line: number; reason: string }[] = [];
  const notices: CallNotice[] = [];
  const rel = (f: string) => path.relative(config.srcRoot, f);
  const fnOf = (file: string, { from, name }: { from: string; name: string }) => {
    const origin = modules.originOf(file, from, name);
    return fns.find((fn) => fn.origin === origin);
  };
  for (const file of reachedFiles(config, modules).sort(compare)) {
    if (![...modules.read(file)!.imported.values()].some((i) => fnOf(file, i))) continue;
    const { ast } = parseSource(file);
    const found: FoundCall[] = [];
    traverse(ast, {
      CallExpression(p) {
        const callee = p.get('callee');
        if (!callee.isIdentifier()) return;
        const spec = p.scope.getBinding(callee.node.name)?.path;
        if (!spec || !(spec.isImportDefaultSpecifier() || spec.isImportSpecifier())) return;
        const fn = fnOf(file, { from: (spec.parent as ImportDeclaration).source.value, name: importedName(spec)! });
        if (!fn) return;
        fn.called = true;
        const declarator = p.parentPath;
        const named = declarator.isVariableDeclarator() && (declarator.parent as VariableDeclaration).kind === 'const' && declarator.get('id').isIdentifier();
        const readable = (named || declarator.isExportDefaultDeclaration()) && p.node.arguments.length === 1 && p.get('arguments.0').isObjectExpression();
        const line = p.node.loc!.start.line;
        if (!readable) {
          unread.push({ file: rel(file), line, reason: `${callee.node.name} is called here but not as const <name> = ${callee.node.name}({ … }) or export default ${callee.node.name}({ … }), so what it returns is not read as settings` });
          return;
        }
        const binding = named ? p.scope.getBinding(((declarator.node as VariableDeclarator).id as Identifier).name) : null;
        found.push({ file, line, start: binding?.identifier.start ?? null, root: fn.root, section: fn.section, binding, exports: named ? [] : ['default'], arg: p.get('arguments.0') as NodePath<ObjectExpression> });
      },
    });
    traverse(ast, {
      ExportDefaultDeclaration(p) {
        const d = p.get('declaration');
        const call = d.isIdentifier() && found.find((c) => c.binding && c.binding === p.scope.getBinding(d.node.name));
        if (call) call.exports.push('default');
      },
      ExportNamedDeclaration(p) {
        if (p.node.source) return;
        for (const call of found) {
          if (call.binding?.path.parentPath!.parentPath === p) call.exports.push(call.binding.identifier.name);
        }
        for (const s of p.node.specifiers as ExportSpecifier[]) {
          const call = s.local && found.find((c) => c.binding && c.binding === p.scope.getBinding(s.local.name));
          if (call) call.exports.push(nameOf(s.exported));
        }
      },
    });
    calls.push(...found.map(({ binding, ...c }) => c));
  }
  for (const fn of fns.filter((f) => !f.called)) notices.push({ file: null, line: null, reason: `${fn.name} from ${fn.import} is called in no file the route files lead to by import` });
  return { calls, unread, notices, originOf: modules.originOf };
}

// 상수 모듈의 기본값과 값이 다르면 상수 모듈 쪽을 남기고, 두 자리에서 넘긴 값이 서로 다르면 그 키의 기본값은 모르는 것으로 둔다.
export function addCallDefaults(calls: SettingsCall[], values: Record<string, any>, incomplete: Record<string, string[][]>, { evaluate, lossless }: { evaluate: (p: NodePath<any>) => unknown; lossless: (p: NodePath<any>) => boolean }, srcRoot: string) {
  const notices: { file: string; line: number; reason: string }[] = [];
  const fromCalls = new Map<string, { value: unknown; exact: boolean; at: string; dropped?: boolean }>();
  const copied = new Set<string>();
  const sectionOf = (root: string, section: string) => {
    if (!copied.has(root)) {
      values[root] = { ...values[root] };
      incomplete[root] = [...(incomplete[root] ?? [])];
      copied.add(root);
    }
    if (!copied.has(`${root}\0${section}`)) {
      values[root][section] = { ...values[root][section] };
      copied.add(`${root}\0${section}`);
    }
    return values[root][section];
  };
  const markIncomplete = (root: string, at: string[]) => {
    if (!incomplete[root].some((p) => p.join('.') === at.join('.'))) incomplete[root].push(at);
  };
  const configured = { ...values };
  for (const call of calls) {
    const { root, section } = call;
    const target = sectionOf(root, section);
    for (const prop of call.arg.get('properties')) {
      if (!prop.isObjectProperty() || prop.node.computed) {
        markIncomplete(root, [section]);
        continue;
      }
      const key = String((prop.node.key as { name?: string; value?: unknown }).name ?? (prop.node.key as { name?: string; value?: unknown }).value);
      const at = `${path.relative(srcRoot, call.file)}:${prop.node.loc!.start.line}`;
      const value = evaluate(prop.get('value'));
      const exact = lossless(prop.get('value'));
      const name = `${root}.${section}.${key}`;
      const kept = configured[root]?.[section];
      if (kept && typeof kept === 'object' && Object.hasOwn(kept, key)) {
        if (exact && JSON.stringify(kept[key]) !== JSON.stringify(value)) {
          notices.push({ file: path.relative(srcRoot, call.file), line: prop.node.loc!.start.line, reason: `default of ${name} differs from settingsDefaults, whose value the map keeps` });
        }
        continue;
      }
      const prior = fromCalls.get(name);
      if (prior) {
        const comparable = prior.exact && exact;
        if (prior.dropped || (comparable && JSON.stringify(prior.value) === JSON.stringify(value))) continue;
        const reason = comparable
          ? `default of ${name} differs from the one at ${prior.at}, so the map leaves it unknown`
          : `the map cannot tell whether the default of ${name} here is the one at ${prior.at}, since the source does not show both in full, so it leaves the default unknown`;
        notices.push({ file: path.relative(srcRoot, call.file), line: prop.node.loc!.start.line, reason });
        prior.dropped = true;
        delete target[key];
        markIncomplete(root, [section, key]);
        continue;
      }
      fromCalls.set(name, { value, exact, at });
      if (value !== undefined) target[key] = value;
      if (!exact) markIncomplete(root, [section, key]);
    }
  }
  return notices;
}

export function settingsResultFinder({ calls, originOf }: { calls: SettingsCall[]; originOf: ModuleReader['originOf'] }): (id: NodePath | null | undefined, file?: string) => [string, string] | null {
  if (!calls.length) return () => null;
  const declared = new Map<string, SettingsCall>(calls.filter((c) => c.start !== null).map<[string, SettingsCall]>((c) => [`${c.file}:${c.start}`, c]));
  const exported = new Map<string, SettingsCall>(calls.flatMap((c) => c.exports.map<[string, SettingsCall]>((name) => [`${c.file}#${name}`, c])));
  return (id, file) => {
    if (!file || !id?.isIdentifier()) return null;
    const binding = id.scope.getBinding(id.node.name);
    if (!binding) return null;
    let call: SettingsCall | null | undefined = null;
    if (binding.path.isVariableDeclarator()) call = declared.get(`${file}:${binding.identifier.start}`);
    else if (binding.kind === 'module') {
      const name = importedName(binding.path);
      call = (name && exported.get(originOf(file, (binding.path.parent as ImportDeclaration).source.value, name))) as SettingsCall | undefined;
    }
    return call ? [call.root, call.section] : null;
  };
}
