import fs from 'node:fs';
import nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import _traverse from '@babel/traverse';
import { importsModule, isTypeOnlyLine, parseSource } from './parse.mjs';
import { importResolver } from './resolve.mjs';

const traverse = _traverse.default ?? _traverse;

const TYPESCRIPT = /\.tsx?$/;

// Node 가 처음 부를 때 실험 기능 경고를 stderr 에 찍는다. 두루의 출력에 섞이지 않게 이 경고만 걸러 낸다.
function stripTypes(file, code) {
  if (!nodeModule.stripTypeScriptTypes) throw new Error(`constants: running ${file} needs Node 22.13 or later, for stripping its types`);
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (!String(warning?.message ?? warning).startsWith('stripTypeScriptTypes')) emit.call(process, warning, ...rest);
  };
  try {
    return nodeModule.stripTypeScriptTypes(code);
  } catch (e) {
    throw new Error(`constants: cannot strip the types of ${file}: ${e.message.split('\n')[0]}`);
  } finally {
    process.emitWarning = emit;
  }
}

const TYPE_PLACES = new Set([
  'TSTypeAnnotation', 'TSTypeParameterInstantiation', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration',
  'TSExpressionWithTypeArguments', 'TSInterfaceHeritage', 'TSClassImplements',
]);
const typeExport = (ref) => ref.parentPath.isExportSpecifier() && (ref.parent.exportKind === 'type' || ref.parentPath.parent.exportKind === 'type');
const inType = (ref) => typeExport(ref) || Boolean(ref.findParent((p) => p.isTSType() || TYPE_PLACES.has(p.type)));

// 타입 자리에서만 쓰이거나 아예 쓰이지 않는 이름은 TypeScript 도 실행 코드에서 지운다.
function typeOnlyImports(ast) {
  const names = new Set();
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

// 상수 모듈은 브라우저 전역에 기대므로 최소한의 window·document 를 깔고 실제로 실행해 값을 얻는다.
export async function loadConstants(config, resolve = importResolver(config).resolve) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-'));
  const copied = new Map();
  const stubbed = new Map();
  const stubOf = new Map();
  const stubs = Object.assign(Object.create(null), config.constantStubs);

  function stubFile(fromFile, spec) {
    const body = stubs[spec] ?? 'export default {};';
    const key = spec.startsWith('.') ? `${path.resolve(path.dirname(fromFile), spec)}\n${body}` : spec;
    if (stubOf.has(key)) return stubOf.get(key);
    const name = `stub_${stubbed.size}_${spec.replace(/[^a-zA-Z0-9]/g, '_')}.mjs`;
    fs.writeFileSync(path.join(outDir, name), body);
    stubbed.set(`./${name}`, spec);
    stubOf.set(key, `./${name}`);
    return `./${name}`;
  }

  function copyModule(absFile) {
    if (copied.has(absFile)) return copied.get(absFile);
    const name = `m_${copied.size}_${path.basename(absFile).replace(/\W/g, '_')}.mjs`;
    copied.set(absFile, `./${name}`);
    const { src, ast } = parseSource(absFile, { asWritten: true });
    const edits = [];
    // 지운 자리의 줄바꿈을 남겨, 실행 오류의 줄 번호가 원래 파일과 맞게 한다.
    const lines = (start, end) => src.slice(start, end).replace(/[^\n]/g, '');
    // 줄을 통째로 지울 때는 세미콜론을 남겨, 세미콜론 없이 쓴 앞뒤 문장이 하나로 붙지 않게 한다.
    const removed = (node) => [node.start, node.end, `;${lines(node.start, node.end)}`];
    const importsValues = ast.program.body.some((n) => n.type === 'ImportDeclaration' && n.importKind !== 'type' && n.specifiers.some((sp) => sp.importKind !== 'type'));
    const unused = TYPESCRIPT.test(absFile) && importsValues ? typeOnlyImports(ast) : new Set();
    for (const node of ast.program.body) {
      if (!importsModule(node)) continue;
      if (isTypeOnlyLine(node)) {
        edits.push(removed(node));
        continue;
      }
      if (node.type === 'ImportDeclaration') {
        const kept = node.specifiers.filter((sp) => sp.importKind !== 'type' && !unused.has(sp.local.name));
        if (!kept.length && node.specifiers.length) {
          edits.push(removed(node));
          continue;
        }
        if (kept.length < node.specifiers.length) {
          const text = (sp) => src.slice(sp.start, sp.end);
          const named = kept.filter((sp) => sp.type === 'ImportSpecifier').map(text);
          const clause = [...kept.filter((sp) => sp.type !== 'ImportSpecifier').map(text), ...(named.length ? [`{ ${named.join(', ')} }`] : [])];
          edits.push([node.start, node.source.start, `import ${clause.join(', ')} from ${lines(node.start, node.source.start)}`]);
        }
      }
      const spec = node.source.value;
      const resolved = !spec.startsWith('.') && Object.hasOwn(stubs, spec) ? null : resolve(absFile, spec);
      const target = resolved ? copyModule(resolved) : stubFile(absFile, spec);
      edits.push([node.source.start, node.source.end, JSON.stringify(target)]);
    }
    let out = src;
    for (const [s, e, text] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + text + out.slice(e);
    if (TYPESCRIPT.test(absFile)) out = stripTypes(absFile, out);
    fs.writeFileSync(path.join(outDir, name), out);
    return `./${name}`;
  }

  globalThis.window ??= { location: { protocol: 'http:', host: 'localhost', origin: 'http://localhost' } };
  globalThis.document ??= { getElementById: () => null };

  const loaded = {};
  try {
    for (const [name, rel] of Object.entries(config.constants)) {
      const rewritten = copyModule(path.join(config.srcRoot, rel));
      let mod;
      try {
        mod = await import(pathToFileURL(path.join(outDir, rewritten)).href);
      } catch (e) {
        let message = String(e?.message ?? e);
        for (const [file, copy] of copied) message = message.replaceAll(path.join(outDir, copy), file).replaceAll(copy, file);
        for (const [stub, spec] of stubbed) message = message.replaceAll(stub, spec);
        const where = String(e?.stack ?? '').match(/[/\\](m_\d+_\w+\.mjs):(\d+)/);
        const source = where && [...copied].find(([, copy]) => copy === `./${where[1]}`)?.[0];
        throw new Error(`constants.${name}: ${source ? `${source}:${where[2]}: ` : ''}${message}`, { cause: e });
      }
      loaded[name] = 'default' in mod ? mod.default : { ...mod };
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  return loaded;
}
