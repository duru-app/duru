import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { importLinker } from '../src/import-links.ts';
import { buildMap } from '../src/map.mjs';
import { linkTests } from '../src/test-links.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.mjs');
const TSCONFIG = `{
  // paths are relative to this file, one folder above the source folder
  "compilerOptions": {
    "paths": { "@app/*": ["src/*"], },
  },
}
`;
const screen = (map, id) => map.screens.find((s) => s.id === id);
const withoutRun = ({ meta, ...rest }) => rest;

async function inApp(callback, { rewrite = false, tsconfig = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-alias-'));
  try {
    fs.cpSync(FIXTURE, dir, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const src = path.join(dir, 'client/src');
    if (rewrite) {
      for (const file of fs.readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.js'))) {
        alias(path.join(src, file), src);
      }
    }
    fs.writeFileSync(path.join(dir, 'client/tsconfig.json'), TSCONFIG);
    if (tsconfig) edit(path.join(dir, 'config.json'), (config) => ({ ...config, tsconfig: 'client/tsconfig.json' }));
    return await callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const edit = (file, change) => fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8')))));

function alias(file, src) {
  const text = fs.readFileSync(file, 'utf8').replace(/(from |import\(|require\()'(\.\.?\/[^']*)'/g, (_, head, spec) => {
    return `${head}'@app/${path.relative(src, path.resolve(path.dirname(file), spec)).split(path.sep).join('/')}'`;
  });
  fs.writeFileSync(file, text);
}

const baseline = await buildMap(loadConfig(path.join(FIXTURE, 'config.json')));

test('a client that writes every import as a tsconfig alias gives the same map as one that writes them as relative paths', async () => {
  await inApp(async (dir) => {
    assert.match(fs.readFileSync(path.join(dir, 'client/src/Routes.js'), 'utf8'), /from '@app\/components\/Home'/);
    const map = await buildMap(loadConfig(path.join(dir, 'config.json')));
    assert.deepEqual(map.unresolvedAliasImports, []);
    const { unresolvedAliasImports, ...rest } = withoutRun(map);
    assert.deepEqual(rest, withoutRun(baseline));
  }, { rewrite: true });
});

test('without a tsconfig entry an import written as an alias is an outside package that the screen does not follow', async () => {
  await inApp(async (dir) => {
    const home = path.join(dir, 'client/src/components/Home.js');
    fs.writeFileSync(home, fs.readFileSync(home, 'utf8').replace("'./DocumentTable'", "'@app/components/DocumentTable'"));
    const map = await buildMap(loadConfig(path.join(dir, 'config.json')));
    assert.equal('unresolvedAliasImports' in map, false);
    assert.equal(screen(map, '/home#Home').sourceFiles.includes('components/DocumentTable.js'), false);
  }, { tsconfig: false });
});

test('a screen takes the API calls, settings reads and links of a file it imports through an alias', async () => {
  await inApp(async (dir) => {
    const home = path.join(dir, 'client/src/components/Home.js');
    const text = fs.readFileSync(home, 'utf8');
    fs.writeFileSync(home, text.replace("'./DocumentTable'", "'@app/components/DocumentTable'"));
    const map = await buildMap(loadConfig(path.join(dir, 'config.json')));
    const expected = screen(baseline, '/home#Home');
    assert.deepEqual(screen(map, '/home#Home'), expected);
    assert.ok(expected.sourceFiles.includes('components/DocumentTable.js'));
    assert.ok(expected.apiCalls.some((c) => c.file === 'components/DocumentTable.js'));
    assert.ok(expected.settingReads.some((r) => r.file === 'components/DocumentTable.js'));
    assert.ok(expected.links.some((l) => l.file === 'components/DocumentTable.js'));
  });
});

test('a constants module that imports through an alias still gets the values it imports', async () => {
  await inApp(async (dir) => {
    const option = path.join(dir, 'client/src/_define/Option.js');
    fs.writeFileSync(option, fs.readFileSync(option, 'utf8').replace("'./Enum'", "'@app/_define/Enum'"));
    const map = await buildMap(loadConfig(path.join(dir, 'config.json')));
    assert.deepEqual(withoutRun(map).apiFunctions, withoutRun(baseline).apiFunctions);
    assert.deepEqual(map.screens.map((s) => s.id), baseline.screens.map((s) => s.id));
  });
});

test('a constantStubs entry for an import is used even when a tsconfig alias would find a file for it', async () => {
  await inApp(async (dir) => {
    const option = path.join(dir, 'client/src/_define/Option.js');
    fs.writeFileSync(option, fs.readFileSync(option, 'utf8').replace("'./Enum'", "'@app/_define/Enum'"));
    fs.writeFileSync(path.join(dir, 'client/src/_define/Enum.js'), "throw new Error('the real module was run');\n");
    const enumSource = fs.readFileSync(path.join(FIXTURE, 'client/src/_define/Enum.js'), 'utf8');
    edit(path.join(dir, 'config.json'), ({ constants: { Option }, ...config }) => ({ ...config, constants: { Option }, constantStubs: { '@app/_define/Enum': enumSource } }));
    const map = await buildMap(loadConfig(path.join(dir, 'config.json')));
    assert.deepEqual(map.screens.map((s) => s.path), baseline.screens.map((s) => s.path));
  });
});

test('a constantStubs entry for a relative import is not used while the file it names is there, as before', async () => {
  await inApp(async (dir) => {
    edit(path.join(dir, 'config.json'), (config) => ({ ...config, constantStubs: { './Enum': "throw new Error('the stub was run');" } }));
    const map = await buildMap(loadConfig(path.join(dir, 'config.json')));
    assert.deepEqual(map.screens.map((s) => s.path), baseline.screens.map((s) => s.path));
  });
});

test('a unit test that imports a screen file through an alias is linked to the screen like one that imports it by a relative path', async () => {
  await inApp(async (dir) => {
    const config = loadConfig(path.join(dir, 'config.json'));
    const map = await buildMap(config);
    const links = linkTests(config, map);
    const expected = linkTests(loadConfig(path.join(FIXTURE, 'config.json')), baseline);
    assert.ok(Object.keys(expected.importers).length > 0);
    assert.deepEqual(Object.keys(links.importers).sort(), Object.keys(expected.importers).sort());
    assert.deepEqual(links.importers['/help#Help'].map((t) => t.via), [['components/Help.js'], ['components/Help.js']]);
    assert.deepEqual(links.importNotices, expected.importNotices);

    const spec = path.join(config.srcRoot, 'components/Help.spec.js');
    assert.deepEqual([...importLinker(config.srcRoot, map, config.aliases)(spec).screens.keys()], ['/help#Help']);
    assert.deepEqual([...importLinker(config.srcRoot, map)(spec).screens.keys()], []);
  }, { rewrite: true });
});

test('extract prints each import that matches an alias but finds no file, with the number of files that import it', async () => {
  await inApp(async (dir) => {
    const src = path.join(dir, 'client/src/components');
    for (const name of ['Home', 'Help', 'AdminMember']) {
      const file = path.join(src, `${name}.js`);
      fs.writeFileSync(file, `import Gone from '@app/components/Gone';\nimport Outside from '@elsewhere/pkg';\n${fs.readFileSync(file, 'utf8')}`);
    }
    fs.appendFileSync(path.join(src, 'Home.js'), "\nexport const lazyGone = () => import('@app/components/Lazy');\n");
    const config = path.join(dir, 'config.json');
    const stdout = execFileSync(process.execPath, [CLI, 'extract', config], { encoding: 'utf8' });
    assert.match(stdout, /^ {2}tsconfig import @app\/components\/Gone matches an alias but no file, imported in 3 files$/m);
    assert.match(stdout, /^ {2}tsconfig import @app\/components\/Lazy matches an alias but no file, imported in 1 file$/m);
    assert.doesNotMatch(stdout, /elsewhere/);
    const map = JSON.parse(fs.readFileSync(path.join(dir, 'out/map.json'), 'utf8'));
    assert.deepEqual(map.unresolvedAliasImports, [{ spec: '@app/components/Gone', files: 3 }, { spec: '@app/components/Lazy', files: 1 }]);
  });
});

test('a config without tsconfig prints no alias lines and puts no alias list on the map', async () => {
  await inApp(async (dir) => {
    const stdout = execFileSync(process.execPath, [CLI, 'extract', path.join(dir, 'config.json')], { encoding: 'utf8' });
    assert.doesNotMatch(stdout, /tsconfig/);
    assert.equal('unresolvedAliasImports' in JSON.parse(fs.readFileSync(path.join(dir, 'out/map.json'), 'utf8')), false);
  }, { tsconfig: false });
});

test('a tsconfig entry that names no file, is not a path or holds nothing readable ends in an error that says what is wrong', () =>
  inApp((dir) => {
    const config = path.join(dir, 'config.json');
    const set = (tsconfig) => edit(config, (c) => ({ ...c, tsconfig }));
    set('client/missing.json');
    assert.throws(() => loadConfig(config), /tsconfig file .*client\/missing\.json does not exist/);
    set(['client/tsconfig.json']);
    assert.throws(() => loadConfig(config), /tsconfig must be the path of the tsconfig file that declares the import aliases, such as "client\/tsconfig\.json", not \["client\/tsconfig\.json"\]/);
    set('');
    assert.throws(() => loadConfig(config), /tsconfig must be the path/);
    fs.writeFileSync(path.join(dir, 'client/tsconfig.json'), '{ "compilerOptions": { "paths": ');
    set('client/tsconfig.json');
    assert.throws(() => loadConfig(config), /tsconfig file .*client\/tsconfig\.json cannot be read as JSON/);
    fs.writeFileSync(path.join(dir, 'client/tsconfig.json'), '{ "extends": "./gone" }');
    assert.throws(() => loadConfig(config), /extends "\.\/gone", which was not found/);
    fs.writeFileSync(path.join(dir, 'client/tsconfig.json'), '{ "compilerOptions": { "paths": { "@app/*": "src/*" } } }');
    assert.throws(() => loadConfig(config), /compilerOptions\.paths in .*client\/tsconfig\.json must map names to lists of paths/);
  }));

test('the command line stops with the reason when the tsconfig cannot be used', () => {
  return inApp((dir) => {
    edit(path.join(dir, 'config.json'), (c) => ({ ...c, tsconfig: 'client/missing.json' }));
    const run = spawnSync(process.execPath, [CLI, 'extract', path.join(dir, 'config.json')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /tsconfig file .*client\/missing\.json does not exist/);
  });
});

test('tsconfig is read relative to the folder of the config file, like srcRoot', () => {
  return inApp((dir) => {
    const config = loadConfig(path.join(dir, 'config.json'));
    assert.equal(config.tsconfig, path.join(dir, 'client/tsconfig.json'));
    assert.deepEqual(config.aliases, [{ name: '@app/*', targets: [path.join(dir, 'client/src/*')] }]);
  });
});
