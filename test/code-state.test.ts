import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeHasher, codeState } from '../src/code-state.ts';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import { linkTests } from '../src/test-links.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const VERSION = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8')).version;

function withTempDir<T>(fn: (dir: string) => T) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

test('the code state of a folder outside any git repository has its commit unknown and says nothing of uncommitted changes', () =>
  withTempDir((dir) => {
    assert.deepEqual({ ...codeState(dir), duruCommit: undefined }, { commit: 'unknown', duruVersion: VERSION, duruCommit: undefined });
  }));

test('the code state of a git repository names its commit and whether a file under the folder was changed, added or not committed, and leaves out changes outside the folder', () =>
  withTempDir((dir) => {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'x\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'first');
    const head = git(dir, 'rev-parse', 'HEAD');
    assert.equal(codeState(src).commit, head);
    assert.equal(codeState(src).uncommitted, false);
    fs.writeFileSync(path.join(dir, 'outside.txt'), 'y\n');
    assert.equal(codeState(src).uncommitted, false);
    fs.writeFileSync(path.join(src, 'b.js'), 'export const b = 2;\n');
    assert.equal(codeState(src).uncommitted, true);
    fs.rmSync(path.join(src, 'b.js'));
    fs.writeFileSync(path.join(src, 'a.js'), 'export const a = 2;\n');
    assert.equal(codeState(src).uncommitted, true);
  }));

test('a code hash changes with the content or the name of a file, and not with line endings, the order of the files or how a path is separated', () =>
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub/a.js'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'b.js'), 'three\n');
    const before = codeHasher(dir)(['sub/a.js', 'b.js']);
    assert.match(before, /^[0-9a-f]{64}$/);
    assert.equal(codeHasher(dir)(['b.js', 'sub\\a.js', 'b.js']), before);
    fs.writeFileSync(path.join(dir, 'sub/a.js'), 'one\r\ntwo\r\n');
    assert.equal(codeHasher(dir)(['sub/a.js', 'b.js']), before);
    fs.writeFileSync(path.join(dir, 'sub/a.js'), 'one\ntwo!\n');
    assert.notEqual(codeHasher(dir)(['sub/a.js', 'b.js']), before);
    fs.writeFileSync(path.join(dir, 'sub/a.js'), 'one\ntwo\n');
    fs.renameSync(path.join(dir, 'b.js'), path.join(dir, 'c.js'));
    assert.notEqual(codeHasher(dir)(['sub/a.js', 'c.js']), before);
  }));

test('the map records the code state of srcRoot and the duru that built it, and a code hash for each screen from its source files and for each call from the files its requests are written in', () =>
  withTempDir(async (copy) => {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const config = loadConfig(path.join(copy, 'config.json'));
    const before = await buildMap(config);
    assert.equal(before.meta.commit, 'unknown');
    assert.equal(before.meta.duruVersion, VERSION);
    assert.equal('uncommitted' in before.meta, false);
    const hash = codeHasher(config.srcRoot);
    const help = before.screens.find((s) => s.id === '/help#Help')!;
    assert.equal(help.codeHash, hash(['components/Help.js', 'components/formatDate.js']));
    const list = before.calls.find((c) => c.id === 'GET:/api/v1/document/list')!;
    assert.equal(list.codeHash, hash(['_ajax/AjaxFunc.js']));

    const file = path.join(config.srcRoot, 'components/formatDate.js');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n// changed\n`);
    const after = await buildMap(config);
    const changed = (kind: 'screens' | 'calls') => after[kind].filter((n) => n.codeHash !== before[kind].find((b) => b.id === n.id)!.codeHash).map((n) => n.id);
    assert.deepEqual(changed('screens'), ['/signin#SignIn', '/help#Help', '/admin/member#AdminMember', '/lab/result#LabResult']);
    assert.deepEqual(changed('calls'), []);
  }));

test('the test links keep a code hash of each test file found under srcRoot, by its path there', () =>
  withTempDir(async (copy) => {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const config = loadConfig(path.join(copy, 'config.json'));
    const links = linkTests(config, await buildMap(config));
    const hash = codeHasher(config.srcRoot);
    assert.deepEqual(links.testFileHashes, Object.fromEntries(['components/DocumentDetail.spec.js', 'components/DocumentTable.spec.js', 'components/Help.spec.js', 'components/formatDate.spec.js', 'store/settings.spec.js'].map((f) => [f, hash([f])])));
  }));
