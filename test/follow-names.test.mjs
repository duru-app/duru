import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import _traverse from '@babel/traverse';
import { nameFollower } from '../src/follow-names.mjs';
import { parseSource } from '../src/parse.mjs';

const traverse = _traverse.default ?? _traverse;
const dirs = [];
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function follow(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-follow-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const resolve = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = path.join(path.dirname(from), spec);
    return ['', '.ts', '.tsx', '.js'].map((ext) => base + ext).find((f) => fs.existsSync(f) && fs.statSync(f).isFile()) ?? null;
  };
  const parsed = new Map();
  const parse = (file) => {
    if (!parsed.has(file)) parsed.set(file, parseSource(file));
    return parsed.get(file);
  };
  const sitesOf = (file) => {
    const found = [];
    traverse(parse(file).ast, {
      CallExpression(p) {
        if (p.node.callee.type === 'Identifier' && p.node.callee.name === 'send') found.push({ start: p.node.start, site: p.node.arguments[0].value });
      },
    });
    return found;
  };
  const follower = nameFollower({ parse, resolve, sitesOf });
  const at = (file) => path.join(dir, file);
  const reached = (file, name = null, closed = []) => [...follower.reach([{ file: at(file), name }], (f) => !closed.map(at).includes(f))].sort();
  return { at, reached, origin: (file, name, end) => follower.origin(at(file), name, (f) => f === at(end)) };
}

test('a name reaches its declaration, the declarations it uses, top-level statements of its file and assignments to its members, and nothing else', () => {
  const { reached } = follow({
    'hooks.ts': [
      "const helper = () => send('helper');",
      "export function useA() { return helper(); }",
      "export function useB() { return send('b'); }",
      "useB.label = send('b-label');",
      "send('top');",
      '',
    ].join('\n'),
    'screen.tsx': "import { useA } from './hooks';\nexport default function Screen() { useA(); return <div />; }\n",
  });
  assert.deepEqual(reached('screen.tsx'), ['b-label', 'helper', 'top']);
  assert.deepEqual(reached('hooks.ts', 'useB'), ['b', 'b-label', 'top']);
});

test('a name passes through files that re-export it by name, under another name, by default or through export *', () => {
  const { at, reached, origin } = follow({
    'a.ts': "export const one = () => send('one');\nexport const two = () => send('two');\nexport default () => send('default');\n",
    'b.ts': "export * from './a';\n",
    'c.ts': "export { one as first } from './b';\nexport { default as fallback } from './a';\nimport { two } from './a';\nexport { two };\n",
    'screen.tsx': "import { first, fallback, two } from './c';\nexport const run = () => [first(), fallback()];\n",
  });
  assert.deepEqual(reached('screen.tsx'), ['default', 'one']);
  assert.deepEqual(reached('c.ts', 'two'), ['two']);
  assert.deepEqual(origin('c.ts', 'first', 'a.ts'), { file: at('a.ts'), name: 'one' });
  assert.deepEqual(origin('c.ts', 'two', 'a.ts'), { file: at('a.ts'), name: 'two' });
  assert.equal(origin('c.ts', 'missing', 'a.ts'), null);
});

test('a name the file does not export, a namespace used as a value, a dynamic import and an import for its side effects bring the whole file', () => {
  const { reached } = follow({
    'cjs.js': "module.exports = { load: () => send('cjs') };\n",
    'ns.ts': "export const x = () => send('ns-x');\nexport const y = () => send('ns-y');\n",
    'lazy.ts': "export const z = () => send('lazy');\n",
    'effect.ts': "export const w = () => send('effect');\n",
    'screen.tsx': [
      "import { load } from './cjs';",
      "import * as ns from './ns';",
      "import './effect';",
      'export const run = () => [load(), Object.values(ns), import(\'./lazy\')];',
      '',
    ].join('\n'),
  });
  assert.deepEqual(reached('screen.tsx'), ['cjs', 'effect', 'lazy', 'ns-x', 'ns-y']);
});

test('a namespace member reaches only that name, a name used only as a type reaches nothing, and files importing each other end', () => {
  const { reached } = follow({
    'ns.ts': "import { back } from './screen';\nexport const x = () => [send('ns-x'), back];\nexport const y = () => send('ns-y');\nexport interface Shape { id: string }\n",
    'types.ts': "export const value = () => send('typed');\n",
    'screen.tsx': [
      "import * as ns from './ns';",
      "import { value } from './types';",
      'export const back = 1;',
      'export const run = (arg: typeof value): ns.Shape => ns.x();',
      '',
    ].join('\n'),
  });
  assert.deepEqual(reached('screen.tsx'), ['ns-x']);
});

test('a file the caller does not let it enter adds nothing', () => {
  const { reached } = follow({
    'hooks.ts': "export const useA = () => send('a');\n",
    'screen.tsx': "import { useA } from './hooks';\nexport const run = () => [useA(), send('own')];\n",
  });
  assert.deepEqual(reached('screen.tsx'), ['a', 'own']);
  assert.deepEqual(reached('screen.tsx', null, ['hooks.ts']), ['own']);
});

test('importing a file runs its top-level statements, and those of the files it re-exports from, even when no name of it is used', () => {
  const { reached } = follow({
    'effect.ts': "export const unused = () => send('unused');\nsend('effect-top');\n",
    'typed.ts': "export interface Shape { id: string }\nexport const v = 1;\nsend('typed-top');\n",
    'only-type.ts': "export interface Other { id: string }\nsend('type-only');\n",
    'barrel.ts': "export { a } from './a';\nexport { b } from './b';\n",
    'a.ts': "export const a = () => send('a');\n",
    'b.ts': "export const b = () => send('b');\nsend('b-top');\n",
    'screen.tsx': [
      "import { unused } from './effect';",
      "import { type Shape, v } from './typed';",
      "import type { Other } from './only-type';",
      "import { a } from './barrel';",
      'export const run = (s: Shape, o: Other) => a();',
      '',
    ].join('\n'),
  });
  assert.deepEqual(reached('screen.tsx'), ['a', 'b-top', 'effect-top', 'typed-top']);
});

test('a name re-exported as the default or through a constant that holds an import leads back to that import', () => {
  const { at, reached, origin } = follow({
    'a.ts': "export const one = () => send('one');\nexport const two = () => send('two');\n",
    'c.ts': "import { one } from './a';\nexport default one;\nconst alias = one;\nexport const other = alias;\nexport { alias as renamed };\n",
    'screen.tsx': "import first from './c';\nexport const run = () => first();\n",
  });
  for (const name of ['default', 'other', 'renamed']) assert.deepEqual(origin('c.ts', name, 'a.ts'), { file: at('a.ts'), name: 'one' });
  assert.deepEqual(reached('screen.tsx'), ['one']);
});

test('a file the caller does not let it enter is never read, and one that cannot be read ends a re-export lookup without failing', () => {
  const { at, reached, origin } = follow({
    'broken.ts': 'export const = ;\n',
    'a.ts': "export const one = () => send('one');\n",
    'hooks.ts': "import './broken';\nexport * from './broken';\nexport const useA = () => send('a');\n",
    'bar.ts': "export * from './broken';\nexport * from './a';\n",
    'dead-end.ts': "export * from './broken';\n",
    'screen.tsx': "import { useA } from './hooks';\nimport { one } from './bar';\nexport const run = () => [useA(), one()];\n",
  });
  assert.deepEqual(reached('screen.tsx', null, ['broken.ts']), ['a', 'one']);
  assert.deepEqual(origin('bar.ts', 'one', 'a.ts'), { file: at('a.ts'), name: 'one' });
  assert.equal(origin('dead-end.ts', 'one', 'a.ts'), null);
});

test('importing a file runs the top-level statements of the files it re-exports through export *', () => {
  const { reached } = follow({
    'barrel.ts': "export * from './a';\nexport * from './b';\n",
    'a.ts': "export const a = () => send('a');\n",
    'b.ts': "export const b = () => send('b');\nsend('b-top');\n",
    'screen.tsx': "import { a } from './barrel';\nexport const run = () => a();\n",
  });
  assert.deepEqual(reached('screen.tsx'), ['a', 'b-top']);
});

test('a call that runs when its file is imported counts even inside a declaration, while functions passed to it stay with the declaration', () => {
  const { reached } = follow({
    'warm.ts': [
      "import { load } from './api';",
      'export const v = 1;',
      "const warm = send('warm');",
      "export const p = load(send('arg'));",
      "export const useQ = create(() => send('hook'), { key: send('key') });",
      "export const run = () => send('run');",
      "export class Store extends base(send('super')) { load() { return send('method'); } }",
      "export default register(send('default'), function () { return send('default-fn'); });",
      '',
    ].join('\n'),
    'api.ts': "export const load = (x) => send('load');\n",
    'screen.tsx': "import { v } from './warm';\nexport const run = () => v;\n",
    'hook-screen.tsx': "import { useQ } from './warm';\nexport const run = () => useQ();\n",
  });
  assert.deepEqual(reached('screen.tsx'), ['arg', 'default', 'key', 'load', 'super', 'warm']);
  assert.deepEqual(reached('hook-screen.tsx'), ['arg', 'default', 'hook', 'key', 'load', 'super', 'warm']);
});

test('calls in a destructuring default, a static class member, a computed member name and a top-level `X.y =` run when the file is imported', () => {
  const { reached } = follow({
    'warm.ts': [
      'export const v = 1;',
      "export const { timeout = send('default-key') } = config;",
      "export class Api { static inst = send('static'); static { send('block'); } [send('key')]() {} load() { return send('method'); } }",
      'export function Foo() {}',
      "Foo.defaultProps = make(send('assign'), () => send('assign-fn'));",
      "Foo[send('left')] = 1;",
      "export const o = { [send('object-key')]() { return send('object-method'); }, get [send('getter-key')]() { return 1; } };",
      "export const a = make({ [send('key-in-call')]() { return send('method-in-call'); } });",
      "Foo.x = make({ get [send('getter-in-call')]() { return 1; } });",
      "export const b = make(class { static s = send('static-in-call'); [send('class-key-in-call')]() { return send('class-method-in-call'); } f = send('field-in-call'); });",
      "export const c = make(class extends mix(send('super-in-call')) { static { send('block-in-call'); } static t = class { static u = send('nested-static'); }; });",
      "export const d = make((() => send('arrow-run'))(), new function () { send('new-run'); }(), ((s) => send('tag-run'))`x`);",
      '',
    ].join('\n'),
    'screen.tsx': "import { v } from './warm';\nexport const run = () => v;\n",
    'foo-screen.tsx': "import { Foo } from './warm';\nexport const run = () => Foo();\n",
  });
  const onImport = [
    'arrow-run', 'assign', 'block', 'block-in-call', 'class-key-in-call', 'default-key', 'getter-in-call', 'getter-key',
    'key', 'key-in-call', 'left', 'nested-static', 'new-run', 'object-key', 'static', 'static-in-call', 'super-in-call',
    'tag-run',
  ];
  assert.deepEqual(reached('screen.tsx'), onImport);
  assert.deepEqual(reached('foo-screen.tsx'), [...onImport, 'assign-fn'].sort());
});
