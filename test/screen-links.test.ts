import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { buildMap } from '../src/map.ts';
import type { ScreenMap } from '../src/map.ts';
import { checkStories } from '../src/story-paths.ts';

const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const copies: string[] = [];
after(() => copies.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const page = (name: string) => `export default function ${name}() {\n  return <main>${name}</main>;\n}\n`;

const ROUTES = `import { Redirect, Route, Switch } from 'react-router-dom';
import Home from './Home';
import Team from './Team';
import Help from './Help';
import Login from './Login';
import Start from './Start';

export default function Routes() {
  return (
    <Switch>
      <Route path="/login" component={Login} exact />
      <Route path="/help/:page?" component={Help} />
      <Route path="/home" component={Home} exact />
      <Route path="/team/:team" component={Team} />
      <Route path="/start" component={Start} exact />
      <Redirect to="/home" />
    </Switch>
  );
}
`;

function writeApp(files: Record<string, string>, keys: Record<string, unknown> = {}) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'duru-test-'));
  copies.push(copy);
  const src = path.join(copy, 'src');
  const all = { 'Routes.js': ROUTES, ...Object.fromEntries(['Home', 'Team', 'Help', 'Login', 'Start'].map((n) => [`${n}.js`, page(n)])), ...files };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  }
  const configFile = path.join(copy, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ srcRoot: 'src', routesFile: 'Routes.js', routeElements: ['Route'], apiModules: [], settingsRoots: [], outDir: 'out', ...keys }, null, 2));
  return configFile;
}

const build = (configFile: string) => buildMap(loadConfig(configFile));
const linksOf = (map: ScreenMap, id: string) => map.screens.find((s) => s.id === id)!.links.map((l) => [l.to, l.line, l.guards, l.targets]);
const lineOf = (text: string, part: string) => text.split('\n').findIndex((l) => l.includes(part)) + 1;

const HOME = `import { Link, NavLink, useHistory } from 'react-router-dom';
import { Link as Other } from './ui';
import { Spring } from 'react-spring';

const BASE = '/team';

export default function Home({ flag, team, location }) {
  const history = useHistory();
  const kept = { ...location, state: { open: true } };
  const go = () => {
    if (flag.on) history.push('/help');
  };
  return (
    <div>
      <Link to="/login">login</Link>
      <Link to={\`/team/\${team}/settings\`}>settings</Link>
      <NavLink to={BASE + '/' + team}>team</NavLink>
      <Link to={{ pathname: '/help/faq', search: '?q=1' }}>faq</Link>
      <Link to="/help?topic=x#top">help</Link>
      <Link to={flag.admin ? '/login' : '/start'}>either</Link>
      <Link to={team.url}>somewhere</Link>
      <Other to="/login">not a router link</Other>
      <Spring to={{ opacity: 1 }} />
      <button onClick={go}>go</button>
      <button onClick={() => history.push({ pathname: location.pathname, state: { page: 2 } })}>next page</button>
      <button onClick={() => history.replace({ search: '?sort=name' })}>sort</button>
      <button onClick={() => history.replace(\`\${location.pathname}?tab=2\`)}>tab</button>
      <button onClick={() => history.push(kept)}>keep</button>
    </div>
  );
}
`;

test('router links and history moves become links to the screen the router draws for their address', async () => {
  const map = await build(writeApp({ 'Home.js': HOME, 'ui.js': 'export const Link = (props) => <a {...props} />;\n' }));
  const at = (part: string) => lineOf(HOME, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/help', at("history.push('/help')"), ['flag.on'], ['/help/:page?#Help']],
    ['/login', at('"/login">login'), [], ['/login#Login']],
    ['/team/{*}/settings', at('/settings`}'), [], ['/team/:team#Team']],
    ['/team/{*}', at("BASE + '/'"), [], ['/team/:team#Team']],
    ['/help/faq', at("pathname: '/help/faq'"), [], ['/help/:page?#Help']],
    ['/help', at('topic=x'), [], ['/help/:page?#Help']],
    ['/login', at('flag.admin ?'), ['flag.admin'], ['/login#Login']],
    ['/start', at('flag.admin ?'), ['!(flag.admin)'], ['/start#Start']],
    ['{?}', at('team.url'), [], []],
  ]);
});

test('a move through the history of props, this.props or a history taken out of this.props becomes a link, and a history given to a function is not read', async () => {
  const team = `import { Component } from 'react';

export default class Team extends Component {
  open = () => this.props.history.push('/home');

  render() {
    const { history } = this.props;
    return <div onClick={() => history.replace('/login')} onKeyDown={this.open} />;
  }
}
`;
  const help = `function leave(history) {
  history.push('/start');
}

export default function Help(props) {
  return <a onClick={() => props.history.push('/team/' + props.team)} onBlur={() => leave(props.history)} />;
}
`;
  const map = await build(writeApp({ 'Team.js': team, 'Help.js': help }));
  assert.deepEqual(linksOf(map, '/team/:team#Team'), [
    ['/home', 4, [], ['/home#Home']],
    ['/login', 8, [], ['/login#Login']],
  ]);
  assert.deepEqual(linksOf(map, '/help/:page?#Help'), [['/team/{*}', 6, [], ['/team/:team#Team']]]);
});

test('a router Redirect outside the route files is a link, and the one in the route file is not', async () => {
  const login = `import { Redirect } from 'react-router-dom';

export default function Login({ signedIn }) {
  return signedIn ? <Redirect to="/start" /> : <form />;
}
`;
  const map = await build(writeApp({ 'Login.js': login }));
  assert.deepEqual(linksOf(map, '/login#Login'), [['/start', 4, ['signedIn'], ['/start#Start']]]);
  assert.ok(map.screens.every((s) => s.links.every((l) => l.file !== 'Routes.js')));
});

const ORDERED_ROUTES = `import { Redirect, Route, Switch } from 'react-router-dom';
import Start from './Start';
import AdminHome from './AdminHome';
import Users from './Users';
import UsersNoLicense from './UsersNoLicense';
import Claim from './Claim';
import Team from './Team';
import Never from './Never';

export default function Routes() {
  return (
    <Switch>
      <Route path="/start" component={Start} exact />
      <Route path="/admin" component={AdminHome} exact />
      <Route path="/admin">
        <Switch>
          <Route path="/admin/users" component={Users} exact />
          <Route path="/admin/users" component={UsersNoLicense} exact />
        </Switch>
      </Route>
      <Route path="/claim" component={Claim} />
      <Redirect from="/old" to="/admin" />
      <Route path="/:team" component={Team} />
      <Route path="/never" component={Never} />
      <Redirect to="/start" />
    </Switch>
  );
}
`;

const CLAIM = `import { Route, Switch, useRouteMatch } from 'react-router-dom';
import ClaimEmail from './ClaimEmail';
import ClaimHome from './ClaimHome';

export default function Claim() {
  const { path } = useRouteMatch();
  return (
    <Switch>
      <Route path={\`\${path}/email\`} component={ClaimEmail} exact />
      <Route path={path} component={ClaimHome} exact />
    </Switch>
  );
}
`;

test('a link goes to the screens the router draws: the first fitting child of each Switch, every screen whose path fits the whole address, or else the innermost one', async () => {
  const addresses = ['/admin', '/admin/users', '/claim', '/claim/email', '/claim/other', '/never', '/x/y', '/old', '/'];
  const start = `import { Link } from 'react-router-dom';\n\nexport default function Start() {\n  return <nav>${addresses.map((a) => `<Link to="${a}">${a}</Link>`).join('')}</nav>;\n}\n`;
  const pages = Object.fromEntries(['AdminHome', 'Users', 'UsersNoLicense', 'ClaimEmail', 'ClaimHome', 'Never'].map((n) => [`${n}.js`, page(n)]));
  const map = await build(writeApp({ ...pages, 'Routes.js': ORDERED_ROUTES, 'Claim.js': CLAIM, 'Start.js': start }, { routesFile: ['Routes.js', 'Claim.js'] }));
  assert.deepEqual(Object.fromEntries(map.screens.find((s) => s.id === '/start#Start')!.links.map((l) => [l.to, l.targets])), {
    '/admin': ['/admin#AdminHome'],
    '/admin/users': ['/admin/users#Users', '/admin/users#UsersNoLicense'],
    '/claim': ['/claim#Claim', '/claim#ClaimHome'],
    '/claim/email': ['/claim/email#ClaimEmail'],
    '/claim/other': ['/claim#Claim'],
    '/never': ['/:team#Team'],
    '/x/y': ['/:team#Team'],
    '/old': ['/admin#AdminHome'],
    '/': ['/start#Start'],
  });
});

const MADE_HISTORY = `import { createBrowserHistory } from 'history';

const made = createBrowserHistory();

export function getHistory() {
  return made;
}

export const appHistory = made;
`;

const MOVING_HOME = `import { getHistory, appHistory } from './utils/browser_history';

export default function Home() {
  return <div onClick={() => getHistory().push('/login')} onBlur={() => appHistory.replace('/start')} />;
}
`;

const madeApp = (keys: Record<string, unknown> = {}) => writeApp({ 'utils/browser_history.js': MADE_HISTORY, 'Home.js': MOVING_HOME }, keys);

test('a move through the history the app made becomes a link when the history key names it, whether the name is a function or the history itself', async () => {
  const called = await build(madeApp({ history: { import: './utils/browser_history', name: 'getHistory' } }));
  assert.deepEqual(linksOf(called, '/home#Home'), [['/login', 4, [], ['/login#Login']]]);
  const itself = await build(madeApp({ history: { import: './utils/browser_history', name: 'appHistory' } }));
  assert.deepEqual(linksOf(itself, '/home#Home'), [['/start', 4, [], ['/start#Start']]]);
  const unset = await build(madeApp());
  assert.deepEqual(linksOf(unset, '/home#Home'), []);
});

test('a history key of the wrong shape, or one whose import names no file of the source, stops the run naming the key and what is wrong', async () => {
  assert.throws(() => loadConfig(madeApp({ history: { import: './utils/browser_history' } })), /^Error: history must be \{ "import", "name" \}/);
  assert.throws(() => loadConfig(madeApp({ history: 'getHistory' })), /^Error: history must be \{ "import", "name" \}/);
  await assert.rejects(build(madeApp({ history: { import: './utils/no_history', name: 'getHistory' } })), /^Error: history\.import \.\/utils\/no_history names no file under srcRoot /);
  await assert.rejects(build(madeApp({ history: { import: './utils/browser_history', name: 'history' } })), /^Error: history\.name history is not exported by utils\/browser_history\.js$/);
});

test('without the history key, the summary names each file that calls createBrowserHistory, and with the key it does not', () => {
  const extract = (configFile: string) => {
    const result = spawnSync(process.execPath, [CLI, 'extract', configFile], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const line = /^ {2}history is not set; utils\/browser_history\.js calls createBrowserHistory, and moves through the history it makes are not read as links$/m;
  assert.match(extract(madeApp()), line);
  assert.doesNotMatch(extract(madeApp({ history: { import: './utils/browser_history', name: 'getHistory' } })), /history is not set/);
});

test('an address built from a constant another file exports, even through a re-export, reaches its screen', async () => {
  const home = `import { Link } from 'react-router-dom';
import { HELP, TEAM } from './routes';

export default function Home({ id }) {
  return <nav><Link to={HELP}>help</Link><Link to={\`\${TEAM}/\${id}\`}>team</Link></nav>;
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'routes/paths.js': "export const HELP = '/help';\nexport const TEAM = '/team';\n", 'routes/index.js': "export * from './paths';\n" }));
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/help', 5, [], ['/help/:page?#Help']],
    ['/team/{*}', 5, [], ['/team/:team#Team']],
  ]);
});

test('a link written in a file several screens share goes only to the screens whose code reaches the component holding it', async () => {
  const nav = `import { Link } from 'react-router-dom';

export function TeamLink() {
  return <Link to="/team/a">team</Link>;
}

export function LoginLink() {
  return <Link to="/login">login</Link>;
}
`;
  const map = await build(writeApp({
    'nav.js': nav,
    'Home.js': "import { TeamLink } from './nav';\n\nexport default function Home() {\n  return <TeamLink />;\n}\n",
    'Start.js': "import { LoginLink } from './nav';\n\nexport default function Start() {\n  return <LoginLink />;\n}\n",
  }));
  assert.deepEqual(linksOf(map, '/home#Home'), [['/team/a', 4, [], ['/team/:team#Team']]]);
  assert.deepEqual(linksOf(map, '/start#Start'), [['/login', 8, [], ['/login#Login']]]);
});

test('a story step, the links into a screen and the entry screens take router links', async () => {
  const home = `import { Link } from 'react-router-dom';

export default function Home({ flags }) {
  return <nav>{flags.team && <Link to="/team/a">team</Link>}<Link to={flags.where}>away</Link></nav>;
}
`;
  const map = await build(writeApp({ 'Home.js': home }, { entryPaths: ['/home'] }));
  const [story] = checkStories(map, [{ screens: ['/home#Home', '/team/:team#Team', '/login#Login'] }]);
  assert.deepEqual(story.links.map((l) => [l.verdict, l.ways.map((w) => [w.file, w.line, w.conditions.map((c) => c.guard)])]), [
    ['conditioned', [['Home.js', 4, ['flags.team']]]],
    ['broken', []],
  ]);
  assert.deepEqual(map.screens.find((s) => s.id === '/team/:team#Team')!.access.links.map((l) => [l.from, l.file, l.line]), [['/home#Home', 'Home.js', 4]]);
  assert.deepEqual(map.entries.map((e) => e.screen), ['/login#Login', '/help/:page?#Help', '/home#Home', '/start#Start']);
});
