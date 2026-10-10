import fs from 'node:fs';
import nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { SourceMap } from 'node:module';
import { pathToFileURL } from 'node:url';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type { File, Node, Statement } from '@babel/types';
import { parse } from '@babel/parser';
import { firstDecorator, importsModule, isTypeOnlyLine, parseSource } from './parse.ts';
import { importResolver } from './resolve.ts';
import type { AliasRule, ImportResolver } from './resolve.ts';

interface ConstantsConfig {
  constantStubs?: Record<string, string>;
  constants: Record<string, string>;
  srcRoot: string;
  aliases?: AliasRule[] | null;
}

interface CopierOptions {
  label?: string;
  fillMissing?: boolean;
  replacement?: (spec: string, resolved: string | null) => string | null;
}

interface Transformed {
  code: string;
  map: SourceMap;
}

type Named = { name: string; value: string };

interface CopySpecifier {
  type: string;
  start: number;
  end: number;
  importKind?: string;
  exportKind?: string;
  local: Named;
  imported: Named;
}

interface CopyNode {
  type: string;
  start: number;
  end: number;
  loc: { start: { line: number } };
  importKind?: string;
  exportKind?: string;
  specifiers: CopySpecifier[];
  source: { value: string; start: number; end: number };
  moduleReference: { type: string };
}

type Edit = [number, number, string];

const traverse = _traverse.default ?? _traverse;

const TYPESCRIPT = /\.tsx?$/;

const SOURCE_MAP = /\n\/\/# sourceMappingURL=data:application\/json;base64,(\S+)\s*$/;

// 바꿔 쓴 코드는 줄이 원래 파일과 어긋나므로 소스 맵을 함께 돌려준다.
// Node 가 처음 부를 때 실험 기능 경고를 stderr 에 찍는다. 두루의 출력에 섞이지 않게 이 경고만 걸러 낸다.
function toJavaScript(file: string, code: string, label: string) {
  if (!nodeModule.stripTypeScriptTypes) throw new Error(`${label}: running ${file} needs Node 22.13 or later, for turning it into JavaScript`);
  const emit = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    if (!String((warning as Error)?.message ?? warning).startsWith('stripTypeScriptTypes')) (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
  try {
    const out = nodeModule.stripTypeScriptTypes(code, { mode: 'transform', sourceMap: true });
    const map = out.match(SOURCE_MAP);
    return { code: out.slice(0, map!.index), map: new nodeModule.SourceMap(JSON.parse(Buffer.from(map![1], 'base64').toString())) };
  } catch (e) {
    throw new Error(`${label}: cannot turn ${file} into JavaScript: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    process.emitWarning = emit;
  }
}

function sourceLine({ code, map }: Transformed, line: number, column: number | string | undefined) {
  const text = code.split('\n')[line - 1] ?? '';
  for (let col = column ? Number(column) - 1 : Math.max(text.search(/\S/), 0); col <= text.length; col++) {
    const entry = map.findEntry(line - 1, col) as { generatedLine: number; originalLine: number } | undefined;
    if (entry?.generatedLine === line - 1) return entry.originalLine + 1;
  }
  return null;
}

const TYPE_PLACES = new Set([
  'TSTypeAnnotation', 'TSTypeParameterInstantiation', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration',
  'TSExpressionWithTypeArguments', 'TSInterfaceHeritage', 'TSClassImplements',
]);
const typeExport = (ref: NodePath) => ref.parentPath!.isExportSpecifier() && ((ref.parent as { exportKind?: string }).exportKind === 'type' || (ref.parentPath!.parent as { exportKind?: string }).exportKind === 'type');
const inType = (ref: NodePath) => typeExport(ref) || Boolean(ref.findParent((p: NodePath) => p.isTSType() || TYPE_PLACES.has(p.type)));

// 타입 자리에서만 쓰이거나 아예 쓰이지 않는 이름은 TypeScript 도 실행 코드에서 지운다.
function typeOnlyImports(ast: File) {
  const names = new Set<string>();
  traverse(ast, {
    Program(p) {
      for (const [name, binding] of Object.entries(p.scope.bindings)) {
        if (binding.kind === 'module' && binding.referencePaths.every(inType)) names.add(name);
      }
      p.stop();
    },
  });
  return names;
}

function hasJsx(ast: File) {
  let found = false;
  traverse(ast, {
    'JSXElement|JSXFragment'(p) {
      found = true;
      p.stop();
    },
  });
  return found;
}

function boundNames(node: Node | null): string[] {
  if (node?.type === 'Identifier') return [node.name];
  if (node?.type === 'ObjectPattern') return node.properties.flatMap((p) => boundNames(p.type === 'RestElement' ? p.argument : (p.value as Node)));
  if (node?.type === 'ArrayPattern') return node.elements.flatMap(boundNames);
  if (node?.type === 'AssignmentPattern') return boundNames(node.left);
  if (node?.type === 'RestElement') return boundNames(node.argument);
  return [];
}

// export * from 과 export import 로 내보내는 이름은 읽지 않는다.
function ownExports(body: Statement[]) {
  const names: string[] = [];
  for (const node of body) {
    if (node.type === 'ExportDefaultDeclaration') names.push('default');
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue;
    for (const sp of node.specifiers) if ((sp as { exportKind?: string }).exportKind !== 'type') names.push(sp.exported.type === 'Identifier' ? sp.exported.name : sp.exported.value);
    const declaration = node.declaration;
    if (declaration?.type === 'VariableDeclaration') names.push(...declaration.declarations.flatMap((d) => boundNames(d.id)));
    else if (declaration && 'id' in declaration) names.push(...boundNames(declaration.id ?? null));
  }
  return names;
}

const APP_REQUIRE = '`require(…)` of a file of the app is CommonJS, which duru cannot run as an ES module';
const NOTHING_SOURCE = 'const nothing = globalThis.__duruNothing;';

function exportedNames(body: string) {
  let ast;
  try {
    ast = parse(body, { sourceType: 'module' });
  } catch {
    return null;
  }
  return ast.program.body.some((node) => node.type === 'ExportAllDeclaration') ? null : new Set(ownExports(ast.program.body));
}

// 상수 모듈과 API 모듈을 임시 폴더에 ES 모듈로 옮겨 적는다. 바깥 패키지는 constantStubs 의 스텁으로 바꾼다.
// fillMissing 이면 스텁에 없는 이름을 아무 일도 하지 않는 값으로 채우고, replacement 가 돌려준 문자열이 있으면 그 import 를 그 문자열로 바꾼다.
export function moduleCopier(config: ConstantsConfig, resolve: ImportResolver['resolve'], { label = 'constants', fillMissing = false, replacement = () => null }: CopierOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-'));
  const copied = new Map<string, string>();
  const failed = new Map<string, unknown>();
  const stubbed = new Map<string, string>();
  const stubOf = new Map<string, string>();
  const stubNames = new Map<string, { body: string; names: Set<string> }>();
  const transformed = new Map<string, Transformed>();
  const stubs = Object.assign(Object.create(null), config.constantStubs);
  const standIns = new Map<string, string[] | null>();
  const filled: { spec: string; from: string }[] = [];

  // JSX 나 데코레이터는 Node 가 실행하지 못하므로, import 로 닿은 그런 파일은 그 파일이 export 하는 이름마다 아무 일도 하지 않는 값을 준다.
  // 실행할 수 있는 파일이면 null 이다.
  function standInNames(file: string) {
    if (!standIns.has(file)) {
      let names = null;
      try {
        const { src, ast } = parseSource(file, { asWritten: true });
        if ((src.includes('<') && hasJsx(ast)) || (src.includes('@') && firstDecorator(ast.program))) names = ownExports(ast.program.body);
      } catch {
        // 읽지 못하는 파일은 그대로 옮겨 적어, 실행할 때 나는 오류로 알린다.
      }
      standIns.set(file, names);
    }
    return standIns.get(file)!;
  }

  function stubFile(fromFile: string, spec: string, body: string, names: string[]) {
    const key = spec.startsWith('.') ? `${path.resolve(path.dirname(fromFile), spec)}\n${body}` : `${spec}\n${body}`;
    if (!stubOf.has(key)) {
      const name = `stub_${stubbed.size}_${spec.replace(/[^a-zA-Z0-9]/g, '_')}.mjs`;
      stubbed.set(`./${name}`, spec);
      stubOf.set(key, `./${name}`);
      stubNames.set(`./${name}`, { body, names: new Set() });
    }
    const stub = stubOf.get(key)!;
    for (const n of names) stubNames.get(stub)!.names.add(n);
    return stub;
  }

  function writeStubs() {
    for (const [stub, { body, names }] of stubNames) {
      const given = fillMissing ? exportedNames(body) : null;
      const missing = given ? [...names].filter((n) => !given.has(n)) : [];
      const fill = missing.length ? [NOTHING_SOURCE, ...missing.map((n) => `export { nothing as ${n === 'default' ? 'default' : JSON.stringify(n)} };`)] : [];
      fs.writeFileSync(path.join(dir, stub), [body, ...fill].join('\n'));
    }
  }

  const importedNames = (node: { specifiers: CopySpecifier[] }) => node.specifiers.flatMap((sp) => {
    if (sp.type === 'ImportDefaultSpecifier') return ['default'];
    if (sp.type === 'ImportSpecifier') return [sp.imported.name ?? sp.imported.value];
    if (sp.type === 'ExportSpecifier') return [sp.local.name ?? sp.local.value];
    return [];
  });

  function copy(absFile: string): string {
    if (failed.has(absFile)) throw failed.get(absFile);
    if (copied.has(absFile)) return copied.get(absFile)!;
    const name = `m_${copied.size}_${path.basename(absFile).replace(/\W/g, '_')}.mjs`;
    copied.set(absFile, `./${name}`);
    try {
      return copyAs(absFile, name);
    } catch (e) {
      failed.set(absFile, e);
      throw e;
    }
  }

  function copyAs(absFile: string, name: string): string {
    const { src, ast } = parseSource(absFile, { asWritten: true });
    const decorator = src.includes('@') ? firstDecorator(ast.program) : null;
    if (decorator) throw new Error(`${label}: ${absFile}:${decorator.line}:${decorator.column + 1}: a decorator is not JavaScript that Node runs, so duru cannot run this file`);
    const edits: Edit[] = [];
    // 지운 자리의 줄바꿈을 남겨, 실행 오류의 줄 번호가 원래 파일과 맞게 한다.
    const lines = (start: number, end: number) => src.slice(start, end).replace(/[^\n]/g, '');
    // 줄을 통째로 지울 때는 세미콜론을 남겨, 세미콜론 없이 쓴 앞뒤 문장이 하나로 붙지 않게 한다.
    const removed = (node: CopyNode): Edit => [node.start, node.end, `;${lines(node.start, node.end)}`];
    const importsValues = ast.program.body.some((n) => n.type === 'ImportDeclaration' && n.importKind !== 'type' && n.specifiers.some((sp) => (sp as { importKind?: string }).importKind !== 'type'));
    const unused = TYPESCRIPT.test(absFile) && importsValues ? typeOnlyImports(ast) : new Set();
    for (const node of ast.program.body as unknown as CopyNode[]) {
      const commonJS = node.type === 'TSExportAssignment' ? '`export =`'
        : node.type === 'TSImportEqualsDeclaration' && node.importKind !== 'type' && node.moduleReference.type === 'TSExternalModuleReference' ? '`import … = require(…)`'
          : null;
      if (commonJS) throw new Error(`${label}: ${absFile}:${node.loc.start.line}: ${commonJS} is CommonJS, which duru cannot run as an ES module`);
      if (!importsModule(node)) continue;
      if (isTypeOnlyLine(node)) {
        edits.push(removed(node));
        continue;
      }
      let kept = node.specifiers ?? [];
      if (node.type === 'ImportDeclaration') {
        kept = node.specifiers.filter((sp) => sp.importKind !== 'type' && !unused.has(sp.local.name));
        if (!kept.length && node.specifiers.length) {
          edits.push(removed(node));
          continue;
        }
        if (kept.length < node.specifiers.length) {
          const text = (sp: CopySpecifier) => src.slice(sp.start, sp.end);
          const named = kept.filter((sp) => sp.type === 'ImportSpecifier').map(text);
          const clause = [...kept.filter((sp) => sp.type !== 'ImportSpecifier').map(text), ...(named.length ? [`{ ${named.join(', ')} }`] : [])];
          edits.push([node.start, node.source.start, `import ${clause.join(', ')} from ${lines(node.start, node.source.start)}`]);
        }
      }
      const spec = node.source.value;
      const stubbedSpec = !spec.startsWith('.') && Object.hasOwn(stubs, spec);
      const resolved = stubbedSpec ? null : resolve(absFile, spec);
      const replacing = replacement(spec, resolved);
      const names = importedNames({ specifiers: kept.filter((sp) => sp.exportKind !== 'type') });
      const exported = replacing === null && resolved && fillMissing ? standInNames(resolved) : null;
      const target = replacing !== null ? stubFile(absFile, spec, replacing, names)
        : exported ? stubFile(absFile, spec, '', [...exported, ...names])
        : resolved ? copy(resolved) : stubFile(absFile, spec, stubs[spec] ?? (fillMissing ? '' : 'export default {};'), names);
      if (replacing === null && !resolved && !(spec in stubs)) filled.push({ spec, from: absFile });
      edits.push([node.source.start, node.source.end, JSON.stringify(target)]);
    }
    if (fillMissing && src.includes('require')) {
      // 패키지를 부르는 require() 는 import 한 패키지처럼 아무 일도 하지 않는 값으로 읽는다. 앱 파일을 부르는 것은 그 줄이 실행될 때 오류가 된다.
      traverse(ast, {
        CallExpression(p) {
          if (!p.get('callee').isIdentifier({ name: 'require' }) || p.scope.hasBinding('require')) return;
          const [arg] = p.node.arguments;
          const value = arg?.type === 'StringLiteral' && resolve(absFile, arg.value) ? `Reflect.apply(() => { throw new Error(${JSON.stringify(APP_REQUIRE)}); }, null, [])` : 'globalThis.__duruNothing';
          edits.push([p.node.start!, p.node.end!, `${value}${lines(p.node.start!, p.node.end!)}`]);
        },
      });
    }
    if (TYPESCRIPT.test(absFile)) {
      // 타입으로만 가져온 이름을 export { X } 로 다시 내보내면 TypeScript 는 지우지만 Node 의 type stripping 은 그대로 둬서 오류가 난다.
      const typeNames = new Set((ast.program.body as unknown as CopyNode[]).flatMap((n) => (n.type === 'ImportDeclaration' ? n.specifiers.filter((sp) => n.importKind === 'type' || sp.importKind === 'type').map((sp) => sp.local.name) : [])));
      for (const node of ast.program.body as unknown as CopyNode[]) {
        if (!typeNames.size || node.type !== 'ExportNamedDeclaration' || node.source || node.exportKind === 'type' || !node.specifiers.length) continue;
        const kept = node.specifiers.filter((sp) => !typeNames.has(sp.local.name));
        if (kept.length < node.specifiers.length) edits.push([node.start, node.end, kept.length ? `export { ${kept.map((sp) => src.slice(sp.start, sp.end)).join(', ')} };${lines(node.start, node.end)}` : removed(node)[2]]);
      }
    }
    if (fillMissing && src.includes('import.meta')) {
      // 빌드 도구가 채우는 환경 값은 실행할 때 없으므로 아무 일도 하지 않는 값으로 읽는다.
      traverse(ast, {
        MetaProperty(p) {
          if (p.node.meta.name === 'import') edits.push([p.node.start!, p.node.end!, '({ ...import.meta, env: globalThis.__duruNothing })']);
        },
      });
    }
    let out = src;
    for (const [s, e, text] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + text + out.slice(e);
    if (TYPESCRIPT.test(absFile)) {
      const js = toJavaScript(absFile, out, label);
      transformed.set(`./${name}`, js);
      out = js.code;
    }
    fs.writeFileSync(path.join(dir, name), out);
    return `./${name}`;
  }

  function place(copyName: string, line: number, column?: number | string) {
    const source = [...copied].find(([, c]) => c === copyName)?.[0];
    if (!source) return null;
    const js = transformed.get(copyName);
    return { file: source, line: js ? sourceLine(js, line, column) : line };
  }

  function rename(text: string) {
    let out = text;
    for (const [file, c] of copied) out = out.replaceAll(path.join(dir, c), file).replaceAll(c, file);
    for (const [stub, spec] of stubbed) out = out.replaceAll(path.join(dir, stub), spec).replaceAll(stub, spec);
    return out;
  }

  function explain(e: unknown) {
    const message = rename(String((e as Error)?.message ?? e));
    const where = String((e as Error)?.stack ?? '').match(/[/\\](m_\d+_\w+\.mjs):(\d+)(?::(\d+))?/);
    const at = where && place(`./${where[1]}`, Number(where[2]), where[3]);
    return `${at ? `${at.file}${at.line ? `:${at.line}` : ''}: ` : ''}${message}`;
  }

  return {
    dir,
    copy,
    url: (copyName: string) => pathToFileURL(path.join(dir, copyName)).href,
    copyOfUrl: (url: unknown) => {
      const m = String(url).match(/[/\\](m_\d+_\w+\.mjs)$/);
      return m ? `./${m[1]}` : null;
    },
    place,
    rename,
    explain,
    finish: writeStubs,
    standIns: () => filled,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// 상수 모듈은 브라우저 전역에 기대므로 최소한의 window·document 를 깔고 실제로 실행해 값을 얻는다.
export async function loadConstants(config: ConstantsConfig, resolve: ImportResolver['resolve'] = importResolver(config).resolve) {
  const copier = moduleCopier(config, resolve);
  const browserGlobals = globalThis as { window?: unknown; document?: unknown };
  browserGlobals.window ??= { location: { protocol: 'http:', host: 'localhost', origin: 'http://localhost' } };
  browserGlobals.document ??= { getElementById: () => null };

  const loaded: Record<string, unknown> = {};
  try {
    for (const [name, rel] of Object.entries(config.constants)) {
      const rewritten = copier.copy(path.join(config.srcRoot, rel));
      copier.finish();
      let mod;
      try {
        mod = await import(copier.url(rewritten));
      } catch (e) {
        throw new Error(`constants.${name}: ${copier.explain(e)}`, { cause: e });
      }
      loaded[name] = 'default' in mod ? mod.default : { ...mod };
    }
  } finally {
    copier.cleanup();
  }
  return loaded;
}
