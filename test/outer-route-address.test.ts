import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';

for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key];

const FIXTURE = path.join(import.meta.dirname, 'fixtures/app');
const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const LAST_ROUTE = '      <Redirect to={Option.ROUTE_PATH.SIGN_IN} />';

const page = (name: string) => `export default function ${name}() {
  return <article>${name}</article>;
}
`;

const INNER: Record<string, string> = {
  'outer/Backstage.js': `import { Route, Switch } from 'react-router-dom';
import Commands from './Commands';
import Confirm from './Confirm';
import Bots from './Bots';

export default function Backstage(props) {
  const url = props.match.url;
  return (
    <Switch>
      <Route path={\`\${props.match.url}/commands\`} component={Commands} />
      <Route path={\`\${url}/confirm\`} component={Confirm} />
      <Route path={props.match.url + '/bots'} component={Bots} />
    </Switch>
  );
}
`,
  'outer/Commands.js': `import { Component } from 'react';
import { Route, Switch } from 'react-router-dom';
import AddCommand from './AddCommand';
import Confirm from './Confirm';

export default class Commands extends Component {
  render() {
    const { match } = this.props;
    return (
      <Switch>
        <Route path={\`\${this.props.match.url}/add\`} component={AddCommand} />
        <Route path={\`\${match.url}/confirm\`} component={Confirm} />
      </Switch>
    );
  }
}
`,
  'outer/Claim.js': `import { Route, Switch, useRouteMatch } from 'react-router-dom';
import OAuthToEmail from './OAuthToEmail';
import ClaimHome from './ClaimHome';

export default function Claim() {
  const { path } = useRouteMatch();
  return (
    <Switch>
      <Route path={\`\${path}/oauth_to_email\`} component={OAuthToEmail} />
      <Route path={path} component={ClaimHome} exact />
    </Switch>
  );
}
`,
  'outer/Mfa.js': `import { Route } from 'react-router-dom';
import MfaSetup from './MfaSetup';

export default function Mfa({ match: { url } }) {
  return <Route path={\`\${url}/setup\`} component={MfaSetup} />;
}
`,
  'outer/Settings.js': `import { Route } from 'react-router-dom';
import { settingsPath } from './paths';
import Groups from './Groups';

export default function Settings() {
  return <Route path={\`\${settingsPath()}/groups\`} component={Groups} />;
}
`,
  'outer/paths.js': `export const settingsPath = () => '/settings';
`,
};
const PAGES = ['Confirm', 'Bots', 'AddCommand', 'OAuthToEmail', 'ClaimHome', 'MfaSetup', 'Groups'];
const ROUTE_FILES = ['outer/Backstage.js', 'outer/Commands.js', 'outer/Claim.js', 'outer/Mfa.js', 'outer/Settings.js'];
const OUTER_ROUTES = [
  '<Route path="/:team/integrations" component={Backstage} />',
  '<Route path="/:team/emoji" component={Backstage} />',
  '<Route path="/claim" component={Claim} />',
  '<Route path="/mfa" component={Mfa} />',
  '<Route path="/settings" component={Settings} />',
];

async function withOuterRoutes<T>(fn: (copy: { configFile: string; src: string }) => T | Promise<T>, outerRoutes = OUTER_ROUTES, backstageRoutes = ''): Promise<T> {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  try {
    fs.cpSync(FIXTURE, copy, { recursive: true, filter: (src) => !src.startsWith(path.join(FIXTURE, 'out')) });
    const src = path.join(copy, 'client/src');
    const routes = path.join(src, 'Routes.js');
    const imports = ['Backstage', 'Claim', 'Mfa', 'Settings'].map((name) => `import ${name} from './outer/${name}';\n`).join('');
    fs.writeFileSync(routes, imports + fs.readFileSync(routes, 'utf8').replace(LAST_ROUTE, [...outerRoutes.map((r) => `      ${r}`), LAST_ROUTE].join('\n')));
    fs.mkdirSync(path.join(src, 'outer'));
    for (const [file, text] of Object.entries(INNER)) fs.writeFileSync(path.join(src, file), file === 'outer/Backstage.js' ? text.replace('    </Switch>', `${backstageRoutes}    </Switch>`) : text);
    for (const name of PAGES) fs.writeFileSync(path.join(src, `outer/${name}.js`), page(name));
    const configFile = path.join(copy, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), routesFile: ['Routes.js', ...ROUTE_FILES] }));
    return await fn({ configFile, src });
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const innerScreens = (map: ScreenMap) => map.screens.filter((s) => s.routeFile !== 'Routes.js').map((s) => [s.path, s.id]);

function routeLines(configFile: string) {
  const result = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => line.includes('route path not read') || line.includes('duplicate screen ID'));
}

test('a route path that starts with the address the outer route matched gets the path of the screen that draws its route file, two levels deep too', async () => {
  await withOuterRoutes(async ({ configFile, src }) => {
    const map = await build(configFile);
    assert.deepEqual(innerScreens(map), [
      ['/:team/:section(integrations|emoji)/commands', '/:team/:section/commands#Commands'],
      ['/:team/:section(integrations|emoji)/confirm', '/:team/:section/confirm#Confirm'],
      ['/:team/:section(integrations|emoji)/bots', '/:team/:section/bots#Bots'],
      ['/:team/:section(integrations|emoji)/commands/add', '/:team/:section/commands/add#AddCommand'],
      ['/:team/:section(integrations|emoji)/commands/confirm', '/:team/:section/commands/confirm#Confirm'],
      ['/claim/oauth_to_email', '/claim/oauth_to_email#OAuthToEmail'],
      ['/claim', '/claim#ClaimHome'],
      ['/mfa/setup', '/mfa/setup#MfaSetup'],
      ['{?}/groups', '{?}/groups#Groups'],
    ]);
    assert.deepEqual(map.duplicateIds, []);
    const settingsLine = fs.readFileSync(path.join(src, 'outer/Settings.js'), 'utf8').split('\n').findIndex((l) => l.includes('<Route')) + 1;
    assert.deepEqual(routeLines(configFile), [`  route path not read ← outer/Settings.js:${settingsLine}: stopped at settingsPath(), only {?}/groups`]);
  });
});

test('outer addresses that differ in more than one piece leave the inner path unread', async () => {
  const apart = OUTER_ROUTES.map((r) => r.replace('"/:team/emoji"', '"/admin/emoji"'));
  await withOuterRoutes(async ({ configFile }) => {
    const map = await build(configFile);
    assert.deepEqual(innerScreens(map).slice(0, 3), [
      ['{?}/commands', '{?}/commands#Commands'],
      ['{?}/confirm', '{?}/confirm#Confirm'],
      ['{?}/bots', '{?}/bots#Bots'],
    ]);
    assert.equal(map.unreadRoutePaths!.filter((u) => u.file === 'outer/Backstage.js').length, 3);
  }, apart);
});

test('a route file no listed screen draws keeps the address of its outer route unread', async () => {
  await withOuterRoutes(async ({ configFile }) => {
    const map = await build(configFile);
    assert.deepEqual(innerScreens(map).find(([, id]) => id.endsWith('#MfaSetup')), ['{?}/setup', '{?}/setup#MfaSetup']);
    assert.ok(map.unreadRoutePaths!.some((u) => u.file === 'outer/Mfa.js' && u.stoppedAt.text === 'url'));
  }, OUTER_ROUTES.filter((r) => !r.includes('Mfa')));
});

const backstageEntries = (map: ScreenMap) => (map.unreadRoutePaths ?? []).filter((u) => u.file === 'outer/Backstage.js').map((u) => [u.path, u.stoppedAt.text]);

test('a filled path that still holds an unread piece is reported with the outer path in front, stopped at that piece', async () => {
  const route = '      <Route path={`${props.match.url}/${props.tab}/edit`} component={Bots} />\n';
  await withOuterRoutes(async ({ configFile }) => {
    const map = await build(configFile);
    assert.deepEqual(backstageEntries(map), [['/:team/:section(integrations|emoji)/{?}/edit', 'props.tab']]);
  }, OUTER_ROUTES, route);
});

test('two routes on one line keep the report of the one whose path is still unread', async () => {
  const routes = '      <Route path={`${props.match.url}/${props.tab}/edit`} component={Bots} /><Route path={`${props.match.url}/hooks`} component={Confirm} />\n';
  await withOuterRoutes(async ({ configFile }) => {
    const map = await build(configFile);
    assert.deepEqual(backstageEntries(map).map(([p]) => p), ['/:team/:section(integrations|emoji)/{?}/edit']);
    assert.ok(map.screens.some((s) => s.path === '/:team/:section(integrations|emoji)/hooks'));
  }, OUTER_ROUTES, routes);
});

test('the variable that joins two outer paths takes a name the inner path does not use', async () => {
  const route = '      <Route path={`${props.match.url}/:section/edit`} component={Bots} />\n';
  await withOuterRoutes(async ({ configFile }) => {
    const map = await build(configFile);
    assert.ok(map.screens.some((s) => s.path === '/:team/:section2(integrations|emoji)/:section/edit'), JSON.stringify(map.screens.map((s) => s.path)));
  }, OUTER_ROUTES, route);
});
