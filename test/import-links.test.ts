import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { importLinker } from '../src/import-links.ts';
import { buildMap } from '../src/map.ts';
import { linkTests } from '../src/test-links.ts';

type Linked = Extract<ReturnType<ReturnType<typeof importLinker>>, { file: string }>;

const config = loadConfig(path.join(import.meta.dirname, 'fixtures/app/config.json'));
const map = await buildMap(config);
const links = linkTests(config, map);
const importers = (id: string) => (links.importers[id] ?? []).map((t) => `${t.title} | ${t.via.join(', ')}`);

function linksOf(assertionResults: unknown[], name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-imports-'));
  try {
    const file = path.join(dir, 'results.json');
    fs.writeFileSync(file, JSON.stringify({ testResults: [{ assertionResults, name }] }));
    return linkTests({ ...config, tests: [{ format: 'vitest', path: file, depth: 'code' }] }, map);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a test whose file imports a source file of one screen is linked to that screen, with the file it came through', () => {
  assert.deepEqual(importers('/help#Help'), ['renders the help text | components/Help.js', 'shows the day the help was last updated | components/Help.js']);
  const [first] = links.importers['/help#Help'];
  assert.deepEqual(
    { file: first.file, testFile: first.testFile, line: first.line, source: first.source, format: first.format, depth: first.depth, status: first.status },
    { file: '/builds/client/src/components/Help.spec.js', testFile: 'components/Help.spec.js', line: 4, source: 'results/vitest/client-unit.json', format: 'vitest', depth: 'code', status: 'pass' },
  );
});

test('a source file two screens use links the test to both', () => {
  const expected = ['DocumentTable › lists the documents it is given | components/DocumentTable.js'];
  assert.deepEqual(importers('/home#Home'), expected);
  assert.deepEqual(importers('/document/:tab_draft_done_#DocumentList'), expected);
});

test('a file loaded with require inside a test counts like an import', () => {
  assert.deepEqual(importers('/document/:id#DocumentDetail'), ['loads the detail screen only when it is needed | components/DocumentDetail.js']);
});

test('a source file more than three screens use links nothing', () => {
  const titles = Object.values(links.importers).flat().map((t) => t.title);
  assert.equal(titles.includes('formats a date as year-month-day'), false);
  assert.deepEqual(Object.keys(links.importers).sort(), ['/document/:id#DocumentDetail', '/document/:tab_draft_done_#DocumentList', '/help#Help', '/home#Home']);
});

test('a source file no screen uses links nothing', () => {
  assert.equal(Object.values(links.importers).flat().some((t) => t.title === 'the lab is off by default'), false);
});

test('a test file is found in the source folder whether the results name it by this path or by another computer\'s', () => {
  const linkOf = importLinker(config.srcRoot, map) as (testFile: string) => Linked;
  const here = linkOf(path.join(config.srcRoot, 'components/Help.spec.js'));
  const elsewhere = linkOf('C:\\builds\\client\\src\\components\\Help.spec.js');
  assert.deepEqual([...here.screens], [['/help#Help', ['components/Help.js']]]);
  assert.deepEqual(elsewhere, here);
  assert.equal(here.file, 'components/Help.spec.js');
});

test('a test already tagged with the screen is left out of the tests that import that screen\'s files', () => {
  const tagged = linksOf(
    [
      { ancestorTitles: [], title: 'renders the help text @screen:/help#Help', status: 'passed' },
      { ancestorTitles: [], title: 'renders it again', status: 'passed' },
    ],
    '/builds/client/src/components/Help.spec.js',
  );
  assert.deepEqual(tagged.nodes['/help#Help'].map((t) => t.title), ['renders the help text @screen:/help#Help']);
  assert.deepEqual(tagged.importers['/help#Help'].map((t) => t.title), ['renders it again']);
});

test('tests linked by imports do not count as tests of the screen', () => {
  assert.equal((links.nodes['/document/:id#DocumentDetail'] ?? []).some((t) => t.title === 'loads the detail screen only when it is needed'), false);
  assert.equal(links.nodes['/help#Help'].some((t) => t.title === 'renders the help text'), false);
});

test('only unit test results are linked by imports', () => {
  assert.deepEqual([...new Set(Object.values(links.importers).flat().map((t) => t.format))], ['vitest']);
});

test('a test file that is not in the source folder is reported once, with the reason', () => {
  assert.deepEqual(links.importNotices, [
    { file: '/builds/client/src/components/Gone.spec.js', reason: '테스트 파일을 소스 폴더에서 찾지 못했습니다' },
    { file: '/work/app/src/home/home.test.js', reason: '테스트 파일을 소스 폴더에서 찾지 못했습니다' },
  ]);
});

test('every screen of the map carries the source files it is made of', () => {
  const help = map.screens.find((s: { id: string }) => s.id === '/help#Help');
  assert.deepEqual(help.sourceFiles, ['components/Help.js', 'components/formatDate.js']);
});

function inTempSource(files: Record<string, string>, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-imports-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const NOT_FOUND = { reason: '테스트 파일을 소스 폴더에서 찾지 못했습니다' };
const helpMap = { screens: [{ id: '/help#Help', sourceFiles: ['Help.js'] }] };

test('a test file of another package on this computer is not taken for the file of the same name in the source folder', () =>
  inTempSource(
    {
      'mono/packages/app/src/Help.js': 'export default 1;\n',
      'mono/packages/app/src/index.spec.js': "import Help from './Help';\n",
      'mono/packages/app/src/..well/known.spec.js': "import Help from '../Help';\n",
      'mono/packages/lib/src/index.spec.js': "test('lib', () => {});\n",
    },
    (dir: string) => {
      const srcRoot = path.join(dir, 'mono/packages/app/src');
      const linkOf = importLinker(srcRoot, helpMap) as (testFile: string) => Linked;
      assert.deepEqual([...linkOf(path.join(srcRoot, 'index.spec.js')).screens.keys()], ['/help#Help']);
      assert.equal(linkOf(path.join(srcRoot, '..well/known.spec.js')).file, '..well/known.spec.js');
      assert.deepEqual(linkOf(path.join(dir, 'mono/packages/lib/src/index.spec.js')), NOT_FOUND);
      fs.symlinkSync(path.join(dir, 'mono'), path.join(dir, 'link'));
      assert.equal(linkOf(path.join(dir, 'link/packages/app/src/index.spec.js')).file, 'index.spec.js');
      assert.deepEqual(linkOf(path.join(dir, 'link/packages/lib/src/index.spec.js')), NOT_FOUND);
    },
  ));

test('a path from another computer is matched by its longest trailing part, and by the file name alone only right under a folder named like the source folder', () =>
  inTempSource(
    {
      'app/Help.js': 'export default 1;\n',
      'app/Other.js': 'export default 2;\n',
      'app/Help.spec.js': "import Other from './Other';\n",
      'app/features/app/Help.spec.js': "import Help from '../../Help';\n",
    },
    (dir: string) => {
      const linkOf = importLinker(path.join(dir, 'app'), { screens: [{ id: '/help#Help', sourceFiles: ['Help.js'] }, { id: '/other#Other', sourceFiles: ['Other.js'] }] }) as (testFile: string) => Linked;
      assert.equal(linkOf('/ci/app/features/app/Help.spec.js').file, 'features/app/Help.spec.js');
      assert.equal(linkOf('features/app/Help.spec.js').file, 'features/app/Help.spec.js');
      assert.equal(linkOf('/builds/group/client/features/app/Help.spec.js').file, 'features/app/Help.spec.js');
      assert.equal(linkOf('/ci/app/Help.spec.js').file, 'Help.spec.js');
      assert.equal(linkOf('Help.spec.js').file, 'Help.spec.js');
      assert.deepEqual(linkOf('/ci/app/tests/unit/Help.spec.js'), NOT_FOUND);
      assert.equal(linkOf('/ci/app/tests/../Help.spec.js').file, 'Help.spec.js');
      assert.deepEqual(linkOf('/ci/lib/app/../Help.spec.js'), NOT_FOUND);
      assert.deepEqual(linkOf('../Help.spec.js'), NOT_FOUND);
      assert.deepEqual(linkOf('/Help.spec.js'), NOT_FOUND);
      assert.deepEqual(linkOf('C:\\Help.spec.js'), NOT_FOUND);
    },
  ));

test('a file named only to mock it does not link the test', () =>
  inTempSource(
    {
      'src/Help.js': 'export default 1;\n',
      'src/vi.spec.js': "vi.mock(import('./Help'), () => ({ default: () => null }));\ntest('x', () => {});\n",
      'src/jest.spec.js': "jest.mock('./Help');\ntest('x', () => {});\n",
      'src/real.spec.js': "test('x', async () => { await import('./Help'); });\n",
      'src/sinon.spec.js': "const spy = sinon.mock(require('./Help'));\n",
      'src/vitest.spec.js': "vitest.mock(import('./Help'));\n",
    },
    (dir: string) => {
      const linkOf = importLinker(path.join(dir, 'src'), helpMap) as (testFile: string) => Linked;
      assert.deepEqual([...linkOf('/ci/src/vi.spec.js').screens], []);
      assert.deepEqual([...linkOf('/ci/src/jest.spec.js').screens], []);
      assert.deepEqual([...linkOf('/ci/src/vitest.spec.js').screens], []);
      assert.deepEqual([...linkOf('/ci/src/real.spec.js').screens], [['/help#Help', ['Help.js']]]);
      assert.deepEqual([...linkOf('/ci/src/sinon.spec.js').screens], [['/help#Help', ['Help.js']]]);
    },
  ));

test('a source folder that does not exist reports the test file as not found', () => {
  assert.deepEqual(importLinker(path.join(os.tmpdir(), 'duru-no-such-folder'), helpMap)(import.meta.filename), NOT_FOUND);
});

test('a screen ID the map lists twice counts as one screen', () =>
  inTempSource({ 'src/Help.js': 'export default 1;\n', 'src/Help.spec.js': "import Help from './Help';\n" }, (dir: string) => {
    const twice = { id: '/a#Help', sourceFiles: ['Help.js'] };
    const linkOf = importLinker(path.join(dir, 'src'), { screens: [twice, twice, twice, { id: '/b#Help', sourceFiles: ['Help.js'] }] }) as (testFile: string) => Linked;
    assert.deepEqual([...linkOf('/ci/src/Help.spec.js').screens], [['/a#Help', ['Help.js']], ['/b#Help', ['Help.js']]]);
  }));
