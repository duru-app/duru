import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/ts-app');
const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const PAGES = ['Simple', 'Satisfied', 'Joined', 'Enumed', 'Defaulted', 'Spaced', 'Objected', 'Starred', 'Renamed', 'Passed', 'Aliased', 'Twice', 'Circled', 'Called', 'Packaged'];

function fixtureCopy(files: Record<string, string>, keys: Record<string, unknown> = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
  const pages = Object.fromEntries(PAGES.map((name) => [`pages/${name}.tsx`, `export default function ${name}() {\n  return <main />;\n}\n`]));
  for (const [rel, text] of Object.entries({ ...pages, ...files })) {
    fs.mkdirSync(path.dirname(path.join(copy, 'client/src', rel)), { recursive: true });
    fs.writeFileSync(path.join(copy, 'client/src', rel), text);
  }
  fs.writeFileSync(path.join(copy, 'client/tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: 'src', paths: { '@paths/*': ['paths/*'] } } }));
  const configFile = path.join(copy, 'config.json');
  const config = { ...JSON.parse(fs.readFileSync(configFile, 'utf8')), routesFile: ['ImportedRoutes.tsx'], tsconfig: 'client/tsconfig.json', ...keys };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  return configFile;
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const pathsOf = (map: ScreenMap) => Object.fromEntries(map.screens.map((s) => [s.component, s.path]));

const PATH_FILES = {
  'paths/simple.ts': `const ROOT = '/team';
export const HOME = '/home' as const;
export const LIST = '/list' satisfies string;
export const JOINED = \`\${ROOT}/joined\`;
export const PATHS = { OBJECT: '/object', NESTED: { DEEP: ROOT + '/deep' } };
export enum Section {
  Mail = '/mail',
}
`,
  'paths/base.ts': `export default '/base';\n`,
  'paths/inner.ts': `export const INNER = '/inner';\nexport const PASSED = '/passed';\n`,
  'paths/carry.ts': `import { PASSED } from './inner';\nexport { PASSED };\n`,
  'paths/index.ts': `export * from './simple';\nexport { INNER as RENAMED } from './inner';\nexport * from './carry';\n`,
  'paths/aliased.ts': `export const ALIASED = '/aliased';\n`,
  'paths/one.ts': `export const TWICE = '/one';\n`,
  'paths/two.ts': `export const TWICE = '/two';\n`,
  'paths/both.ts': `export * from './one';\nexport * from './two';\n`,
  'paths/ping.ts': `import { PONG } from './pong';\nexport const PING = \`\${PONG}/ping\`;\n`,
  'paths/pong.ts': `import { PING } from './ping';\nexport const PONG = \`\${PING}/pong\`;\n`,
  'paths/build.ts': `export const draftsPath = () => '/drafts';\n`,
};

const ROUTES = `import { Navigate, Route, Routes } from 'react-router-dom';
import { HOME, LIST, JOINED, PATHS, Section } from './paths/simple';
import * as P from './paths/simple';
import Base from './paths/base';
import { HOME as STARRED_HOME, RENAMED, PASSED } from './paths';
import { ALIASED } from '@paths/aliased';
import { TWICE } from './paths/both';
import { PING } from './paths/ping';
import { draftsPath } from './paths/build';
import { OUTSIDE } from 'outside-package';
import Simple from './pages/Simple';
import Satisfied from './pages/Satisfied';
import Joined from './pages/Joined';
import Enumed from './pages/Enumed';
import Defaulted from './pages/Defaulted';
import Spaced from './pages/Spaced';
import Objected from './pages/Objected';
import Starred from './pages/Starred';
import Renamed from './pages/Renamed';
import Passed from './pages/Passed';
import Aliased from './pages/Aliased';
import Twice from './pages/Twice';
import Circled from './pages/Circled';
import Called from './pages/Called';
import Packaged from './pages/Packaged';

export default function ImportedRoutes() {
  return (
    <Routes>
      <Route path={HOME} element={<Simple />} />
      <Route path={LIST} element={<Satisfied />} />
      <Route path={\`\${JOINED}/:id\`} element={<Joined />} />
      <Route path={Section.Mail} element={<Enumed />} />
      <Route path={Base} element={<Defaulted />} />
      <Route path={P.PATHS.NESTED.DEEP} element={<Spaced />} />
      <Route path={PATHS.OBJECT} element={<Objected />} />
      <Route path={STARRED_HOME + '/starred'} element={<Starred />} />
      <Route path={RENAMED} element={<Renamed />} />
      <Route path={PASSED} element={<Passed />} />
      <Route path={ALIASED} element={<Aliased />} />
      <Route path={TWICE} element={<Twice />} />
      <Route path={PING} element={<Circled />} />
      <Route path={draftsPath()} element={<Called />} />
      <Route path={OUTSIDE} element={<Packaged />} />
      <Route path="*" element={<Navigate to={P.HOME} replace />} />
    </Routes>
  );
}
`;

test('a route path written with a name imported from another file is read from the source of the file that declares it, through export *, export { … } from, export { X as Y }, an import exported again and a tsconfig alias, with as const, satisfies, enum members, a default export, a namespace import, members of an exported object and templates of constants of the same file', async () => {
  const map = await build(fixtureCopy({ ...PATH_FILES, 'ImportedRoutes.tsx': ROUTES }));
  const paths = pathsOf(map);
  assert.deepEqual(
    Object.fromEntries(['Simple', 'Satisfied', 'Joined', 'Enumed', 'Defaulted', 'Spaced', 'Objected', 'Starred', 'Renamed', 'Passed', 'Aliased'].map((c) => [c, paths[c]])),
    { Simple: '/home', Satisfied: '/list', Joined: '/team/joined/:id', Enumed: '/mail', Defaulted: '/base', Spaced: '/team/deep', Objected: '/object', Starred: '/home/starred', Renamed: '/inner', Passed: '/passed', Aliased: '/aliased' },
  );
  assert.deepEqual(map.entries.find((e) => e.screen === '/home#Simple')!.reasons[0], { kind: 'redirect', file: 'ImportedRoutes.tsx', line: 45 });
});

test('a route path is not read when the name is exported by two export * of different values, when following the names comes back to a name it is reading, when it is what an imported function returns, or when it comes from a package', async () => {
  const map = await build(fixtureCopy({ ...PATH_FILES, 'ImportedRoutes.tsx': ROUTES }));
  const paths = pathsOf(map);
  assert.deepEqual([paths.Twice, paths.Called, paths.Packaged], ['{?}', '{?}', '{?}']);
  assert.match(paths.Circled, /\{\?\}/);
});

const ROLE_ROUTES = `import { Route, Routes } from 'react-router-dom';
import { ADMIN } from './roles/names';
import * as Roles from './roles/names';
import Simple from './pages/Simple';
import Satisfied from './pages/Satisfied';

export default function ImportedRoutes({ memberRole }: { memberRole: string }) {
  return (
    <Routes>
      {memberRole === ADMIN && <Route path="/admin" element={<Simple />} />}
      {memberRole === Roles.MANAGER && <Route path="/manager" element={<Satisfied />} />}
    </Routes>
  );
}
`;

test('a role a route condition compares with a name imported from another file, by itself or through a namespace import, is read from the file that declares it', async () => {
  const map = await build(fixtureCopy({ 'roles/names.ts': `export const ADMIN = 'admin';\nexport const MANAGER = 'manager';\n`, 'ImportedRoutes.tsx': ROLE_ROUTES }));
  assert.deepEqual(map.screens.map((s) => [s.id, s.access.roleValues]), [['/admin#Simple', ['admin']], ['/manager#Satisfied', ['manager']]]);
});
