import fs from 'node:fs';
import nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { SourceMap } from 'node:module';
import { pathToFileURL } from 'node:url';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type { File } from '@babel/types';
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
  specifiers: CopySpecifier[];
  source: { value: string; start: number; end: number };
  moduleReference: { type: string };
}

type ParseNode = Parameters<typeof importsModule>[0];
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

const NOTHING_SOURCE = 'const nothing = globalThis.__duruNothing;';

function exportedNames(body: string) {
  let ast;
  try {
    ast = parse(body, { sourceType: 'module' });
  } catch {
    return null;
  }
  const names = new Set();
  for (const node of ast.program.body) {
    if (node.type === 'ExportAllDeclaration') return null;
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    if (node.type !== 'ExportNamedDeclaration') continue;
    for (const sp of node.specifiers) names.add((sp.exported as unknown as Named).name ?? (sp.exported as unknown as Named).value);
    const decl = node.declaration as { id?: { name: string }; declarations?: { id: { type: string; name: string } }[] } | null | undefined;
    if (decl?.id) names.add(decl.id.name);
    for (const d of decl?.declarations ?? []) {
      if (d.id.type === 'Identifier') names.add(d.id.name);
      else return null;
    }
  }
  return names;
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
    const decorator = src.includes('@') ? firstDecorator(ast.program as unknown as ParseNode) : null;
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
      if (!importsModule(node as unknown as ParseNode)) continue;
      if (isTypeOnlyLine(node as unknown as ParseNode)) {
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
      const target = replacing !== null ? stubFile(absFile, spec, replacing, names)
        : resolved ? copy(resolved) : stubFile(absFile, spec, stubs[spec] ?? (fillMissing ? '' : 'export default {};'), names);
      edits.push([node.source.start, node.source.end, JSON.stringify(target)]);
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
