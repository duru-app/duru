import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importResolver, resolveImport } from '../src/resolve.mjs';
import { loadAliases } from '../src/tsconfig.mjs';

function inFolder(files, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-resolve-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    }
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tsconfig = (paths, extra = {}) => JSON.stringify({ compilerOptions: { paths, ...extra } });
const SOURCES = ['config/app.js', 'domains/user/Form.js', 'domains/user/index.js', 'generated/user/Form.js', 'shared/format.ts', 'components/Help.js'];
const sources = Object.fromEntries(SOURCES.map((f) => [`src/${f}`, '']));
const resolveIn = (dir, spec, { from = 'src/Routes.js', tsconfigFile = 'tsconfig.json' } = {}) => {
  const resolved = resolveImport(path.join(dir, 'src'), path.join(dir, from), spec, loadAliases(path.join(dir, tsconfigFile)));
  return resolved && path.relative(path.join(dir, 'src'), resolved);
};

test('a name written exactly as a paths entry resolves to its target', () => {
  inFolder({ ...sources, 'tsconfig.json': tsconfig({ '@config': ['src/config/app.js'] }) }, (dir) => {
    assert.equal(resolveIn(dir, '@config'), 'config/app.js');
    assert.equal(resolveIn(dir, '@config/other'), null);
  });
});

test('a name with one * resolves to the target with the matched part put in, trying the usual extensions and index files', () => {
  inFolder({ ...sources, 'tsconfig.json': tsconfig({ '@domains/*': ['src/domains/*'], '@shared/*': ['src/shared/*'] }) }, (dir) => {
    assert.equal(resolveIn(dir, '@domains/user/Form'), 'domains/user/Form.js');
    assert.equal(resolveIn(dir, '@domains/user'), 'domains/user/index.js');
    assert.equal(resolveIn(dir, '@shared/format'), 'shared/format.ts');
  });
});

test('a * in the middle of a name keeps the part after it', () => {
  inFolder({ ...sources, 'tsconfig.json': tsconfig({ '@d/*/Form': ['src/domains/*/Form.js'] }) }, (dir) => {
    assert.equal(resolveIn(dir, '@d/user/Form'), 'domains/user/Form.js');
    assert.equal(resolveIn(dir, '@d/user/Other'), null);
  });
});

test('a matched part with a dollar sign reaches the target as it is written', () => {
  inFolder({ 'src/a$&b.js': '', 'tsconfig.json': tsconfig({ '@x/*': ['src/*'] }) }, (dir) => {
    assert.equal(resolveIn(dir, '@x/a$&b'), 'a$&b.js');
  });
});

test('several targets are tried in the order they are written', () => {
  const paths = { '@user/*': ['src/generated/*', 'src/domains/*'] };
  inFolder({ ...sources, 'tsconfig.json': tsconfig(paths) }, (dir) => {
    assert.equal(resolveIn(dir, '@user/user/Form'), 'generated/user/Form.js');
    assert.equal(resolveIn(dir, '@user/user'), 'domains/user/index.js');
  });
});

test('an exact name wins over a name with *, and of two names with * the longer part before the * wins', () => {
  const paths = { '@a/*': ['src/domains/*'], '@a/user/*': ['src/generated/user/*'], '@a/user/Form': ['src/components/Help.js'] };
  inFolder({ ...sources, 'tsconfig.json': tsconfig(paths) }, (dir) => {
    assert.equal(resolveIn(dir, '@a/user/Form'), 'components/Help.js');
    assert.equal(resolveIn(dir, '@a/user/Form.js'), 'generated/user/Form.js');
  });
  inFolder({ ...sources, 'tsconfig.json': tsconfig({ '@a/*': ['src/domains/*'], '@a/user/*': ['src/generated/user/*'] }) }, (dir) => {
    assert.equal(resolveIn(dir, '@a/user/Form'), 'generated/user/Form.js');
  });
});

test('paths are relative to baseUrl when there is one, else to the folder of the tsconfig file', () => {
  const files = { ...sources, 'tsconfig.json': tsconfig({ '@d/*': ['domains/*'] }, { baseUrl: 'src' }), 'app/tsconfig.json': tsconfig({ '@d/*': ['../src/domains/*'] }) };
  inFolder(files, (dir) => {
    assert.equal(resolveIn(dir, '@d/user/Form'), 'domains/user/Form.js');
    assert.equal(resolveIn(dir, '@d/user/Form', { tsconfigFile: 'app/tsconfig.json' }), 'domains/user/Form.js');
  });
});

test('a tsconfig with comments, trailing commas and slashes inside strings is read', () => {
  const text = `{
    // where the aliases live
    "compilerOptions": {
      /* "paths": { "@gone/*": ["src/config/*"] }, */
      "paths": {
        "@app/*": ["src/*"], // "https://example.com/*" is just text
        "@url": ["src/domains/user/index.js",],
      },
      "types": ["https://x"],
    },
  }`;
  inFolder({ ...sources, 'tsconfig.json': text }, (dir) => {
    assert.equal(resolveIn(dir, '@app/config/app'), 'config/app.js');
    assert.equal(resolveIn(dir, '@url'), 'domains/user/index.js');
    assert.equal(resolveIn(dir, '@gone/app'), null);
  });
});

test('a tsconfig that extends another reads the paths from the extended file, relative to it', () => {
  const files = {
    ...sources,
    'config/base.json': tsconfig({ '@d/*': ['../src/domains/*'] }),
    'tsconfig.json': JSON.stringify({ extends: './config/base' }),
  };
  inFolder(files, (dir) => {
    assert.equal(resolveIn(dir, '@d/user/Form'), 'domains/user/Form.js');
  });
});

test('the paths of the file that extends replace the paths of the extended file entirely', () => {
  const files = {
    ...sources,
    'base.json': tsconfig({ '@d/*': ['src/domains/*'], '@c/*': ['src/config/*'] }),
    'tsconfig.json': JSON.stringify({ extends: './base.json', compilerOptions: { paths: { '@d/*': ['src/generated/*'] } } }),
  };
  inFolder(files, (dir) => {
    assert.equal(resolveIn(dir, '@d/user/Form'), 'generated/user/Form.js');
    assert.equal(resolveIn(dir, '@c/app'), null);
  });
});

test('baseUrl of an extended file is relative to that file, and paths of the extending file follow it', () => {
  const files = {
    ...sources,
    'config/base.json': JSON.stringify({ compilerOptions: { baseUrl: '../src' } }),
    'tsconfig.json': JSON.stringify({ extends: './config/base.json', compilerOptions: { paths: { '@d/*': ['domains/*'] } } }),
  };
  inFolder(files, (dir) => {
    assert.equal(resolveIn(dir, '@d/user/Form'), 'domains/user/Form.js');
  });
});

test('when extends lists several files the later one wins, and a chain of extends is followed', () => {
  const files = {
    ...sources,
    'a.json': tsconfig({ '@d/*': ['src/domains/*'] }),
    'b.json': tsconfig({ '@d/*': ['src/generated/*'] }),
    'c.json': JSON.stringify({ extends: './a.json' }),
    'tsconfig.json': JSON.stringify({ extends: ['./b.json', './c.json'] }),
    'other.json': JSON.stringify({ extends: ['./c.json', './b.json'] }),
  };
  inFolder(files, (dir) => {
    assert.equal(resolveIn(dir, '@d/user/Form'), 'domains/user/Form.js');
    assert.equal(resolveIn(dir, '@d/user/Form', { tsconfigFile: 'other.json' }), 'generated/user/Form.js');
  });
});

test('a target outside the source folder is an outside package, even when the file exists', () => {
  const files = { ...sources, 'shared/money.js': '', 'tsconfig.json': tsconfig({ '@shared/*': ['shared/*'], '@inside/*': ['src/domains/*'] }) };
  inFolder(files, (dir) => {
    assert.equal(resolveIn(dir, '@shared/money'), null);
    assert.equal(resolveIn(dir, '@inside/user/Form'), 'domains/user/Form.js');
  });
});

test('a target outside the source folder is not followed and not collected, whether or not anything is there', () => {
  const paths = { react: ['node_modules/@types/react'], '@mui/*': ['node_modules/@mui/*'], '@both/*': ['src/missing/*', 'packages/both/*'] };
  inFolder({ ...sources, 'tsconfig.json': tsconfig(paths) }, (dir) => {
    const srcRoot = path.join(dir, 'src');
    const { resolve, unresolved } = importResolver({ srcRoot, aliases: loadAliases(path.join(dir, 'tsconfig.json')) });
    for (const spec of ['react', '@mui/material', '@both/x']) assert.equal(resolve(path.join(srcRoot, 'a.js'), spec), null, spec);
    assert.deepEqual(unresolved(), []);
  });
});

test('a target outside the source folder with nothing there, or one that holds only a type declaration, gives way to a later target and to a folder of the source folder', () => {
  const paths = { '*': ['node_modules/*', 'src/types/*'], '@shared/*': ['packages/shared/*', 'src/shared/*'], '@t/*': ['src/types/*', 'src/generated/*'], '@pkg/*': ['packages/*', 'src/shared/*'] };
  const files = { ...sources, 'src/types/user/Form.d.ts': '', 'packages/format.ts': '', 'tsconfig.json': tsconfig(paths) };
  inFolder(files, (dir) => {
    const srcRoot = path.join(dir, 'src');
    const { resolve, unresolved } = importResolver({ srcRoot, aliases: loadAliases(path.join(dir, 'tsconfig.json')) });
    const from = path.join(srcRoot, 'a.js');
    assert.equal(resolve(from, 'components/Help'), path.join(srcRoot, 'components/Help.js'));
    assert.equal(resolve(from, '@shared/format'), path.join(srcRoot, 'shared/format.ts'));
    assert.equal(resolve(from, '@t/user/Form'), path.join(srcRoot, 'generated/user/Form.js'));
    assert.equal(resolve(from, '@pkg/format'), null);
    assert.equal(resolve(from, 'react'), null);
    assert.deepEqual(unresolved(), []);
  });
});

test('a target that holds only a type declaration file is not followed and not collected', () => {
  const files = { ...sources, 'src/types/api.d.ts': '', 'src/types/models/index.d.ts': '', 'tsconfig.json': tsconfig({ '@t/*': ['src/types/*'] }) };
  inFolder(files, (dir) => {
    const srcRoot = path.join(dir, 'src');
    const { resolve, unresolved } = importResolver({ srcRoot, aliases: loadAliases(path.join(dir, 'tsconfig.json')) });
    for (const spec of ['@t/api', '@t/models']) assert.equal(resolve(path.join(srcRoot, 'a.js'), spec), null, spec);
    assert.equal(resolve(path.join(srcRoot, 'a.js'), '@t/gone'), null);
    assert.deepEqual(unresolved(), [{ spec: '@t/gone', files: 1 }]);
  });
});

test('a source folder reached through a symbolic link takes the alias targets of the real folder as its own files', (t) => {
  inFolder({ 'app/src/domains/user/Form.js': '', 'app/tsconfig.json': tsconfig({ '@d/*': ['src/domains/*'], '@/*': ['./*'] }) }, (dir) => {
    const srcRoot = path.join(dir, 'linked');
    try {
      fs.symlinkSync(path.join(dir, 'app/src'), srcRoot, 'dir');
    } catch {
      return t.skip('symbolic links cannot be made here');
    }
    const aliases = loadAliases(path.join(dir, 'app/tsconfig.json'));
    assert.equal(resolveImport(srcRoot, path.join(srcRoot, 'Routes.js'), '@d/user/Form', aliases), path.join(srcRoot, 'domains/user/Form.js'));
    assert.equal(resolveImport(srcRoot, path.join(srcRoot, 'Routes.js'), '@/src/domains/user/Form', aliases), path.join(srcRoot, 'domains/user/Form.js'));
  });
});

test('${configDir} in paths and baseUrl of an extended file stands for the folder of the tsconfig file named in the config', () => {
  const files = {
    ...sources,
    'tsconfig.json': JSON.stringify({ extends: './shared/base.json' }),
    'shared/base.json': tsconfig({ '@d/*': ['${configDir}/src/domains/*'] }),
    'other.json': JSON.stringify({ extends: './shared/with-base.json' }),
    'shared/with-base.json': tsconfig({ '@d/*': ['generated/*'] }, { baseUrl: '${configDir}/src' }),
  };
  inFolder(files, (dir) => {
    assert.equal(resolveIn(dir, '@d/user/Form'), 'domains/user/Form.js');
    assert.equal(resolveIn(dir, '@d/user/Form', { tsconfigFile: 'other.json' }), 'generated/user/Form.js');
  });
  inFolder({ 'src/${configDir}/user/Form.js': '', 'tsconfig.json': tsconfig({ '@d/*': ['./src/${configDir}/*'] }) }, (dir) => {
    assert.equal(resolveIn(dir, '@d/user/Form'), path.join('${configDir}', 'user/Form.js'));
  });
});

test('extends that names a package folder reads the tsconfig.json inside it', () => {
  const files = {
    ...sources,
    'tsconfig.json': JSON.stringify({ extends: '@acme/tsconfig-base', compilerOptions: { paths: { '@d/*': ['src/domains/*'] } } }),
    'node_modules/@acme/tsconfig-base/tsconfig.json': '{ "compilerOptions": { "strict": true } }',
  };
  inFolder(files, (dir) => assert.equal(resolveIn(dir, '@d/user/Form'), 'domains/user/Form.js'));
});

test('a relative path stays first, the alias comes before a folder name under the source folder, and anything else is an outside package', () => {
  const files = { ...sources, 'tsconfig.json': tsconfig({ 'components/*': ['src/generated/*'], '@c/*': ['src/components/*'] }) };
  inFolder(files, (dir) => {
    assert.equal(resolveIn(dir, './components/Help', { from: 'src/Routes.js' }), 'components/Help.js');
    assert.equal(resolveIn(dir, 'components/Help'), 'components/Help.js');
    assert.equal(resolveIn(dir, 'components/user/Form'), 'generated/user/Form.js');
    assert.equal(resolveIn(dir, 'domains/user/Form'), 'domains/user/Form.js');
    assert.equal(resolveIn(dir, '@c/Help'), 'components/Help.js');
    assert.equal(resolveIn(dir, '@unknown/Help'), null);
    assert.equal(resolveIn(dir, 'react'), null);
  });
});

test('without aliases a name starting with @ is an outside package, as before', () => {
  inFolder({ ...sources }, (dir) => {
    assert.equal(resolveImport(path.join(dir, 'src'), path.join(dir, 'src/Routes.js'), '@domains/user/Form'), null);
    assert.equal(resolveImport(path.join(dir, 'src'), path.join(dir, 'src/Routes.js'), 'domains/user/Form'), path.join(dir, 'src/domains/user/Form.js'));
  });
});

test('imports that match an alias but find no file are collected with the number of files that wrote them', () => {
  const files = { ...sources, 'shared/money.js': '', 'tsconfig.json': tsconfig({ '@d/*': ['src/domains/*'], '@shared/*': ['shared/*'], '@c/*': ['src/components/*', 'src/missing/*'] }) };
  inFolder(files, (dir) => {
    const srcRoot = path.join(dir, 'src');
    const { resolve, unresolved } = importResolver({ srcRoot, aliases: loadAliases(path.join(dir, 'tsconfig.json')) });
    const [a, b] = [path.join(srcRoot, 'a.js'), path.join(srcRoot, 'b.js')];
    for (const [from, spec] of [[a, '@d/gone'], [b, '@d/gone'], [b, '@d/gone'], [a, '@d/other/gone'], [a, '@d/user/Form'], [a, '@shared/money'], [a, '@c/Help'], [a, '@nothing/x'], [a, './missing'], [a, 'react']]) {
      resolve(from, spec);
    }
    assert.deepEqual(unresolved(), [{ spec: '@d/gone', files: 2 }, { spec: '@d/other/gone', files: 1 }]);
  });
});

test('an import found under a folder of the source folder after its alias found nothing is not collected', () => {
  inFolder({ ...sources, 'tsconfig.json': tsconfig({ 'domains/*': ['src/generated/*'] }) }, (dir) => {
    const srcRoot = path.join(dir, 'src');
    const { resolve, unresolved } = importResolver({ srcRoot, aliases: loadAliases(path.join(dir, 'tsconfig.json')) });
    assert.equal(resolve(path.join(srcRoot, 'a.js'), 'domains/user/Form'), path.join(srcRoot, 'generated/user/Form.js'));
    assert.equal(resolve(path.join(srcRoot, 'a.js'), 'domains/config'), null);
    assert.deepEqual(unresolved(), [{ spec: 'domains/config', files: 1 }]);
  });
});

test('a tsconfig that does not exist, cannot be read or is wrongly written is an error that says what is wrong', () => {
  const failing = (files, pattern) => inFolder({ 'tsconfig.json': '{}', ...files }, (dir) => assert.throws(() => loadAliases(path.join(dir, 'tsconfig.json')), pattern));
  assert.throws(() => loadAliases(path.join(os.tmpdir(), 'duru-no-such-tsconfig.json')), /tsconfig file .*duru-no-such-tsconfig\.json does not exist/);
  failing({ 'tsconfig.json': '{ "compilerOptions": ' }, /tsconfig file .*tsconfig\.json cannot be read as JSON/);
  failing({ 'tsconfig.json': '[1]' }, /must hold a JSON object, not \[1\]/);
  failing({ 'tsconfig.json': tsconfig(['src/*']) }, /compilerOptions\.paths in .*tsconfig\.json must map names to lists of paths, such as .*, not \["src\/\*"\]/);
  failing({ 'tsconfig.json': tsconfig({ '@a': 'src/a.js' }) }, /compilerOptions\.paths in .* must map names to lists of paths/);
  failing({ 'tsconfig.json': tsconfig({ '@a/*/*': ['src/*'] }) }, /at most one "\*".*"@a\/\*\/\*" has more/);
  failing({ 'tsconfig.json': tsconfig({ '@a/*': ['src/*/*'] }) }, /at most one "\*".*"@a\/\*" has more/);
  failing({ 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 3 } }) }, /compilerOptions\.baseUrl in .* must be a folder path such as "src", not 3/);
  failing({ 'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }', 'tsconfig.app.json': tsconfig({ '@a/*': ['src/*'] }) },
    /tsconfig file .*tsconfig\.json declares no import aliases: compilerOptions\.paths is missing or empty.*name the tsconfig file that holds them/);
  failing({ 'tsconfig.json': JSON.stringify({ extends: './base.json' }), 'base.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }) }, /declares no import aliases/);
  failing({ 'tsconfig.json': tsconfig({}) }, /declares no import aliases/);
  failing({ 'tsconfig.json': JSON.stringify({ extends: './gone.json' }) }, /extends "\.\/gone\.json", which was not found/);
  failing({ 'tsconfig.json': JSON.stringify({ extends: 3 }) }, /extends in .* must be a file path or a list of them.*not 3/);
  failing({ 'tsconfig.json': JSON.stringify({ extends: '@acme/tsconfig-base' }) }, /extends "@acme\/tsconfig-base", which was not found/);
  failing({ 'tsconfig.json': JSON.stringify({ extends: './a.json' }), 'a.json': JSON.stringify({ extends: './tsconfig.json' }) }, /extends itself through .*tsconfig\.json → .*a\.json → .*tsconfig\.json/);
});
