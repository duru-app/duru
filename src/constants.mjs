import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSource } from './parse.mjs';
import { resolveImport } from './resolve.mjs';

// 상수 모듈은 브라우저 전역에 기대므로 최소한의 window·document 를 깔고 실제로 실행해 값을 얻는다.
export async function loadConstants(config) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-'));
  const copied = new Map();
  const stubs = config.constantStubs ?? {};

  function stubFile(spec) {
    const name = `stub_${copied.size}_${spec.replace(/[^a-zA-Z0-9]/g, '_')}.mjs`;
    const body = stubs[spec] ?? 'export default {};';
    fs.writeFileSync(path.join(outDir, name), body);
    return `./${name}`;
  }

  function copyModule(absFile) {
    if (copied.has(absFile)) return copied.get(absFile);
    const name = `m_${copied.size}_${path.basename(absFile).replace(/\W/g, '_')}.mjs`;
    copied.set(absFile, `./${name}`);
    const { src, ast } = parseSource(absFile);
    const edits = [];
    for (const node of ast.program.body) {
      if (node.type !== 'ImportDeclaration') continue;
      const spec = node.source.value;
      const resolved = resolveImport(config.srcRoot, absFile, spec);
      const target = resolved ? copyModule(resolved) : stubFile(spec);
      edits.push([node.source.start, node.source.end, JSON.stringify(target)]);
    }
    let out = src;
    for (const [s, e, text] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + text + out.slice(e);
    fs.writeFileSync(path.join(outDir, name), out);
    return `./${name}`;
  }

  globalThis.window ??= { location: { protocol: 'http:', host: 'localhost', origin: 'http://localhost' } };
  globalThis.document ??= { getElementById: () => null };

  const loaded = {};
  try {
    for (const [name, rel] of Object.entries(config.constants)) {
      const rewritten = copyModule(path.join(config.srcRoot, rel));
      const mod = await import(pathToFileURL(path.join(outDir, rewritten)).href);
      loaded[name] = mod.default;
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  return loaded;
}
