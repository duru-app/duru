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
      <Link to={urlOf(team)}>somewhere</Link>
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
    ['{?}', at('urlOf(team)'), [], []],
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

test('a move through the history a function component takes out of its first parameter becomes a link, and one taken out of a lowercase function, a later parameter or a function wrapped in a call is not read', async () => {
  const help = `function leave({ history }) {
  history.push('/login');
}

const Back = ({ history: back }) => <a onClick={() => back.replace('/home')} />;

function Pick(team, { history }) {
  return <a onClick={() => history.push('/login')} />;
}

const Wrapped = withRouter(({ history }) => <a onClick={() => history.push('/login')} />);

export default function Help({ history, team }) {
  return <div onClick={() => history.push('/start')} onBlur={() => leave({ history })}><Back /><Pick /><Wrapped /><Panel /></div>;
}

function Panel({ history }) {
  return <a onClick={() => history.push('/login')} />;
}
`;
  const start = `export default ({ history }) => <a onClick={() => history.push('/help')} />;
`;
  const map = await build(writeApp({ 'Help.js': help, 'Start.js': start }));
  assert.deepEqual(linksOf(map, '/help/:page?#Help'), [
    ['/home', 5, [], ['/home#Home']],
    ['/start', 14, [], ['/start#Start']],
    ['/login', 18, [], ['/login#Login']],
  ]);
  assert.deepEqual(linksOf(map, '/start#Start'), [['/help', 1, [], ['/help/:page?#Help']]]);
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

const LAYOUT_ROUTES = `import { Route, Switch } from 'react-router-dom';
import Start from './Start';
import Admin from './Admin';
import Layout from './Layout';

export default function Routes() {
  return (
    <Switch>
      <Route path="/start" component={Start} exact />
      <Route path="/admin" component={Admin} />
      <Route path="/" component={Layout} />
    </Switch>
  );
}
`;

const LAYOUT = `import { Route, Switch } from 'react-router-dom';
import Users from './Users';

export default function Layout() {
  return (
    <Switch>
      <Route path="/users" component={Users} exact />
    </Switch>
  );
}
`;

const ADMIN = `import { Route, Switch } from 'react-router-dom';
import AdminDefinition from './definition';
import SchemaSettings from './SchemaSettings';

export default function Admin(props) {
  const schemas = Object.values(AdminDefinition).flatMap((section) => Object.values(section.subsections));
  return (
    <Switch>
      {schemas.map((item) => (
        <Route key={item.url} path={\`\${props.match.url}/\${item.url}\`} render={() => <SchemaSettings schema={item.schema} />} />
      ))}
    </Switch>
  );
}
`;

const DEFINITION = `import About from './About';
import Teams from './Teams';

const AdminDefinition = {
  site: {
    subsections: {
      about: { url: 'about', schema: { id: 'About', component: About } },
      teams: { url: 'teams', schema: { id: 'Teams', component: Teams } },
    },
  },
};

export default AdminDefinition;
`;

test('a route without exact at "/" holds every address, and each item of a route table is a route of its own', async () => {
  const addresses = ['/users', '/admin/about', '/admin/teams'];
  const start = `import { Link } from 'react-router-dom';\n\nexport default function Start() {\n  return <nav>${addresses.map((a) => `<Link to="${a}">${a}</Link>`).join('')}</nav>;\n}\n`;
  const pages = Object.fromEntries(['Users', 'About', 'Teams'].map((n) => [`${n}.js`, page(n)]));
  const schemaSettings = 'export default function SchemaSettings({ schema }) {\n  const Component = schema.component;\n  return <Component />;\n}\n';
  const map = await build(writeApp(
    { ...pages, 'Routes.js': LAYOUT_ROUTES, 'Layout.js': LAYOUT, 'Admin.js': ADMIN, 'definition.js': DEFINITION, 'SchemaSettings.js': schemaSettings, 'Start.js': start },
    { routesFile: ['Routes.js', 'Layout.js', 'Admin.js'], routeTables: [{ route: 'Admin.js', table: { file: 'definition.js', const: 'AdminDefinition' }, items: '*.subsections.*' }] },
  ));
  assert.deepEqual(Object.fromEntries(map.screens.find((s) => s.id === '/start#Start')!.links.map((l) => [l.to, l.targets])), {
    '/users': ['/users#Users'],
    '/admin/about': ['/admin/about#About'],
    '/admin/teams': ['/admin/teams#Teams'],
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

test('an address a router link or a move takes from a function parameter or props gives no link, nor one made from a route constant through a variable or an object field, which is a link where the constant is written', async () => {
  const home = `import { Link, useHistory } from 'react-router-dom';
import Option from './Option';

export default function Home(props) {
  const { menus, backUrl = '' } = props;
  const history = useHistory();
  const items = [];
  menus.forEach((menu) => {
    items.push({ title: menu, href: Option.ROUTE_PATH[menu] });
  });
  const help = Option.ROUTE_PATH.HELP;
  const login = { href: Option.ROUTE_PATH.LOGIN };
  const { href: signIn } = login;
  const goTo = (href) => history.push(href);
  const open = (pathname) => history.push({ pathname, state: { open: true } });
  return (
    <nav>
      {items.map((item) => <Link key={item.href} to={item.href}>{item.title}</Link>)}
      <Link to={help}>help</Link>
      <Link to={{ pathname: help }}>help again</Link>
      <Link to={login.href}>login</Link>
      <Link to={signIn}>sign in</Link>
      <button onClick={() => goTo('/start')}>start</button>
      <button onClick={() => open(props.next)}>next</button>
      <button onClick={() => history.replace(backUrl)}>back</button>
    </nav>
  );
}
`;
  const map = await build(writeApp(
    { 'Home.js': home, 'Option.js': "export default { ROUTE_PATH: { HELP: '/help', LOGIN: '/login' } };\n" },
    { routeConstant: 'Option.ROUTE_PATH', constants: { Option: 'Option.js' } },
  ));
  assert.deepEqual(linksOf(map, '/home#Home').map(([to, line]) => [to, line]), [
    ['/help', lineOf(home, 'ROUTE_PATH.HELP')],
    ['/login', lineOf(home, 'ROUTE_PATH.LOGIN')],
  ]);
});

test('a move to a query or a hash alone, or to the pathname followed by any query or hash, stays on the screen and gives no link, while a name given another value later is left unread', async () => {
  const home = `import { Link, useHistory, useLocation } from 'react-router-dom';
import qs from 'qs';

export default function Home({ query }) {
  const history = useHistory();
  const location = useLocation();
  const { pathname, search } = location;
  const second = '?page=2';
  let target = '?tab=1';
  if (query.edit) target = '/login';
  return (
    <div>
      <Link to="#top">top</Link>
      <Link to={\`?page=\${query.page + 1}\`}>next</Link>
      <button onClick={() => history.push('?page=2')}>page 2</button>
      <button onClick={() => history.push('?' + qs.stringify(query))}>query</button>
      <button onClick={() => history.push(location.pathname + '?' + qs.stringify(query))}>filter</button>
      <button onClick={() => history.replace(location.pathname + location.search)}>reload</button>
      <button onClick={() => history.replace(location.pathname + location.search + location.hash)}>same</button>
      <button onClick={() => history.replace(location.search)}>search</button>
      <button onClick={() => history.push(search)}>taken search</button>
      <button onClick={() => history.push(pathname + search)}>taken pathname</button>
      <button onClick={() => history.push(second)}>named query</button>
      <button onClick={() => history.push(target)}>assigned again</button>
      <Link to="/login">login</Link>
    </div>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home }));
  assert.deepEqual(linksOf(map, '/home#Home'), [['{?}', lineOf(home, 'push(target)'), [], []], ['/login', lineOf(home, '"/login"'), [], ['/login#Login']]]);
});

const V6_ROUTES = `import { Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Home from './Home';
import Team from './Team';
import Help from './Help';
import Login from './Login';
import Start from './Start';

export default function AppRoutes() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/help/:page?" element={<Help />} />
        <Route path="/home" element={<Home />} />
        <Route path="/team/:team" element={<Team />} />
        <Route path="/team/new" element={<Start />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </Suspense>
  );
}
`;

test('with React Router 6, a move through the function useNavigate() returns and a Navigate outside the route files become links to the screen Routes draws', async () => {
  const home = `import { Navigate, useNavigate } from 'react-router-dom';

export default function Home({ flag, back }) {
  const navigate = useNavigate();
  const go = navigate;
  if (flag.out) return <Navigate to="/login" replace />;
  return (
    <div>
      <button onClick={() => navigate('/team/new')}>new</button>
      <button onClick={() => go(\`/team/\${flag.id}\`, { replace: true })}>team</button>
      <button onClick={() => navigate({ pathname: '/help', search: '?q=1' })}>help</button>
      <button onClick={() => navigate('/nowhere')}>caught</button>
      <button onClick={() => navigate(-1)}>back</button>
      <button onClick={() => back(navigate)}>given</button>
    </div>
  );
}
`;
  const help = `import { useNavigate } from 'react-router-dom';

function leave(navigate) {
  navigate('/start');
}

export default function Help() {
  const navigate = useNavigate();
  return <a onClick={() => leave(navigate)} />;
}
`;
  const map = await build(writeApp({ 'Routes.js': V6_ROUTES, 'Home.js': home, 'Help.js': help }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/login', at('"/login"'), ['flag.out'], ['/login#Login']],
    ['/team/new', at("'/team/new'"), [], ['/team/new#Start']],
    ['/team/{*}', at('flag.id'), [], ['/team/:team#Team']],
    ['/help', at("pathname: '/help'"), [], ['/help/:page?#Help']],
    ['/nowhere', at("'/nowhere'"), [], ['/home#Home']],
  ]);
  assert.deepEqual(linksOf(map, '/help/:page?#Help'), []);
});

test('with React Router 6, a link goes on to a Navigate that is the element of the route it reaches, not to one the element shows only under a condition', async () => {
  const routes = `import { Navigate, Route, Routes } from 'react-router-dom';
import Home from './Home';
import Login from './Login';
import Start from './Start';

export default function AppRoutes({ user }) {
  return (
    <Routes>
      <Route path="/login" element={!user ? <Login /> : <Navigate to="/home" />} />
      <Route path="/home" element={user ? <Home /> : <Navigate to="/login" replace />} />
      <Route path="/old" element={<Navigate to="/home" replace />} />
      <Route path="/start" element={<Start />} />
    </Routes>
  );
}
`;
  const start = `import { Link } from 'react-router-dom';

export default function Start() {
  return <nav><Link to="/home">home</Link><Link to="/login">login</Link><Link to="/old">old</Link></nav>;
}
`;
  const map = await build(writeApp({ 'Routes.js': routes, 'Start.js': start }));
  assert.deepEqual(linksOf(map, '/start#Start').map(([to, , , targets]) => [to, targets]), [
    ['/home', ['/home#Home']],
    ['/login', ['/login#Login']],
    ['/old', ['/home#Home']],
  ]);
});

test('Routes picks the most specific path whatever the order, and a path fits only the whole address unless it ends in /*', async () => {
  const routes = `import { Route, Routes } from 'react-router-dom';
import Docs from './Docs';
import Doc from './Doc';
import NewDoc from './NewDoc';
import Files from './Files';
import OtherFiles from './OtherFiles';
import Start from './Start';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/docs/*" element={<Docs />} />
      <Route path="/docs/:id" element={<Doc />} />
      <Route path="/docs/new" element={<NewDoc />} />
      <Route path="/files" element={<Files />} />
      <Route path="/files" element={<OtherFiles />} />
      <Route path="/start" element={<Start />} />
    </Routes>
  );
}
`;
  const addresses = ['/docs/new', '/docs/a', '/docs/a/b', '/docs', '/files', '/files/x'];
  const start = `import { Link } from 'react-router-dom';\n\nexport default function Start() {\n  return <nav>${addresses.map((a) => `<Link to="${a}">${a}</Link>`).join('')}</nav>;\n}\n`;
  const pages = Object.fromEntries(['Docs', 'Doc', 'NewDoc', 'Files', 'OtherFiles'].map((n) => [`${n}.js`, page(n)]));
  const map = await build(writeApp({ ...pages, 'Routes.js': routes, 'Start.js': start }));
  assert.deepEqual(Object.fromEntries(map.screens.find((s) => s.id === '/start#Start')!.links.map((l) => [l.to, l.targets])), {
    '/docs/new': ['/docs/new#NewDoc'],
    '/docs/a': ['/docs/:id#Doc'],
    '/docs/a/b': ['/docs/*#Docs'],
    '/docs': ['/docs/*#Docs'],
    '/files': ['/files#Files', '/files#OtherFiles'],
    '/files/x': [],
  });
});

test('a React Router 6 address not written from / stays {?} and goes to no screen', async () => {
  const home = `import { Navigate, useNavigate } from 'react-router-dom';

export default function Home({ flag }) {
  const navigate = useNavigate();
  if (flag.up) return <Navigate to="../team" />;
  return <button onClick={() => navigate('help')}>help</button>;
}
`;
  const map = await build(writeApp({ 'Routes.js': V6_ROUTES, 'Home.js': home }));
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['{?}', 5, ['flag.up'], []],
    ['{?}', 6, [], []],
  ]);
});

test('Routes takes the routes a Fragment or React.Fragment wraps, at whatever depth', async () => {
  const routes = `import React, { Fragment } from 'react';
import { Route, Routes } from 'react-router-dom';
import Home from './Home';
import Team from './Team';
import Help from './Help';
import Login from './Login';
import Start from './Start';

export default function AppRoutes({ auth }) {
  return (
    <Routes>
      <Route path="/home" element={<Home />} />
      {auth && (
        <Fragment>
          <Route path="/team" element={<Team />} />
        </Fragment>
      )}
      <React.Fragment>
        <Route path="/rf" element={<Help />} />
      </React.Fragment>
      <Route path="/admin">
        <Fragment key="admin">
          <Route path="login" element={<Login />} />
        </Fragment>
      </Route>
      <Route path="/start" element={<Start />} />
    </Routes>
  );
}
`;
  const home = `import { Link } from 'react-router-dom';\n\nexport default function Home() {\n  return <nav><Link to="/team">team</Link><Link to="/rf">rf</Link><Link to="/admin/login">login</Link></nav>;\n}\n`;
  const map = await build(writeApp({ 'Routes.js': routes, 'Home.js': home }));
  const login = map.screens.find((s) => s.id.endsWith('#Login'))!.id;
  assert.deepEqual(Object.fromEntries(map.screens.find((s) => s.id === '/home#Home')!.links.map((l) => [l.to, l.targets])), {
    '/team': ['/team#Team'],
    '/rf': ['/rf#Help'],
    '/admin/login': [login],
  });
  assert.deepEqual(map.entries.map((e) => e.screen), ['/home#Home', '/start#Start']);
});

test('a nested Routes joins a relative path to the outer /* route\'s path, and matches a path written from / against the whole address', async () => {
  const routes = `import { Route, Routes } from 'react-router-dom';
import App from './App';
import Help from './Help';
import Team from './Team';
import Start from './Start';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/app/*" element={<App />} />
      <Route path="/x/*" element={<Routes><Route path="y" element={<Team />} /></Routes>} />
      <Route path="/full/*" element={<Routes><Route path="/full/help" element={<Help />} /></Routes>} />
      <Route path="/start" element={<Start />} />
    </Routes>
  );
}
`;
  const app = `import { Route, Routes } from 'react-router-dom';
import Settings from './Settings';
import Login from './Login';

export default function App() {
  return (
    <Routes>
      <Route path="settings" element={<Settings />} />
      <Route path="/login" element={<Login />} />
    </Routes>
  );
}
`;
  const addresses = ['/app/settings', '/settings', '/x/y', '/y', '/full/help', '/login'];
  const start = `import { Link } from 'react-router-dom';\n\nexport default function Start() {\n  return <nav>${addresses.map((a) => `<Link to="${a}">${a}</Link>`).join('')}</nav>;\n}\n`;
  const map = await build(writeApp({ 'Routes.js': routes, 'App.js': app, 'Settings.js': page('Settings'), 'Start.js': start }, { routesFile: ['Routes.js', 'App.js'] }));
  const id = (name: string) => map.screens.find((s) => s.id.endsWith(`#${name}`))!.id;
  assert.deepEqual(Object.fromEntries(map.screens.find((s) => s.id === '/start#Start')!.links.map((l) => [l.to, l.targets])), {
    '/app/settings': [id('Settings')],
    '/settings': [],
    '/x/y': [id('Team')],
    '/y': [],
    '/full/help': [id('Help')],
    '/login': [],
  });
});

test('a route file drawn again inside a route file it holds does not join the outer path again', async () => {
  const routes = `import { Route, Routes } from 'react-router-dom';
import Section from './Section';
import Start from './Start';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="a/*" element={<Section />} />
      <Route path="/start" element={<Start />} />
    </Routes>
  );
}
`;
  const section = `import { Route, Routes } from 'react-router-dom';
import Back from './Back';
import Team from './Team';

export default function Section() {
  return (
    <Routes>
      <Route path="b/*" element={<Back />} />
      <Route path="team" element={<Team />} />
    </Routes>
  );
}
`;
  const back = `import AppRoutes from './Routes';\n\nexport default function Back() {\n  return <AppRoutes />;\n}\n`;
  const start = `import { Link } from 'react-router-dom';\n\nexport default function Start() {\n  return <nav><Link to="/a/team">team</Link></nav>;\n}\n`;
  const map = await build(writeApp({ 'Routes.js': routes, 'Section.js': section, 'Back.js': back, 'Start.js': start }, { routesFile: ['Routes.js', 'Section.js'] }));
  assert.deepEqual(map.screens.find((s) => s.id === '/start#Start')!.links.map((l) => l.targets), [[map.screens.find((s) => s.id.endsWith('#Team'))!.id]]);
});

test('the screen of an outer /* route stays a link\'s screen beside the screen of an inner * route, unless a screen drawn inside it fits the whole address', async () => {
  const inner = '<Routes><Route path="profile" element={<Profile />} /><Route path="*" element={<NotFound />} /></Routes>';
  const routes = (element: string) => `import { Route, Routes } from 'react-router-dom';
import SettingsPage from './SettingsPage';
import Profile from './Profile';
import NotFound from './NotFound';
import Start from './Start';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/settings/*" element={${element}} />
      <Route path="/start" element={<Start />} />
    </Routes>
  );
}
`;
  const settingsFile = `import { Route, Routes } from 'react-router-dom';
import Profile from './Profile';
import NotFound from './NotFound';

export default function SettingsPage() {
  return (
    ${inner}
  );
}
`;
  const start = `import { Link } from 'react-router-dom';\n\nexport default function Start() {\n  return <nav><Link to="/settings/zzz">zzz</Link><Link to="/settings/profile">profile</Link></nav>;\n}\n`;
  const pages = Object.fromEntries(['SettingsPage', 'Profile', 'NotFound'].map((n) => [`${n}.js`, page(n)]));
  for (const [shape, files, keys] of [
    ['in a route file', { 'Routes.js': routes('<SettingsPage />'), 'SettingsPage.js': settingsFile }, { routesFile: ['Routes.js', 'SettingsPage.js'] }],
    ['in the element', { 'Routes.js': routes(`<SettingsPage>${inner}</SettingsPage>`) }, {}],
  ] as const) {
    const map = await build(writeApp({ ...pages, ...files, 'Start.js': start }, keys));
    const id = (name: string) => map.screens.find((s) => s.id.endsWith(`#${name}`))!.id;
    assert.deepEqual(Object.fromEntries(map.screens.find((s) => s.id === '/start#Start')!.links.map((l) => [l.to, l.targets])), {
      '/settings/zzz': [id('SettingsPage'), id('NotFound')],
      '/settings/profile': [id('Profile')],
    }, shape);
  }
});

test('Routes drawn side by side each give their screen, so a /* route\'s screen stays beside one of the other Routes that fits the whole address', async () => {
  const imports = `import { Route, Routes } from 'react-router-dom';
import Docs from './Docs';
import Doc from './Doc';
import Start from './Start';
`;
  const docs = `<Routes>
        <Route path="/docs/*" element={<Docs />} />
        <Route path="/start" element={<Start />} />
      </Routes>`;
  const doc = `<Routes>
        <Route path="/docs/:id" element={<Doc />} />
      </Routes>`;
  const file = (name: string, ...drawn: string[]) => `${imports}
export default function ${name}() {
  return (
    <>
      ${drawn.join('\n      ')}
    </>
  );
}
`;
  const start = `import { Link } from 'react-router-dom';\n\nexport default function Start() {\n  return <nav><Link to="/docs/1">doc</Link><Link to="/docs">docs</Link></nav>;\n}\n`;
  const pages = Object.fromEntries(['Docs', 'Doc'].map((n) => [`${n}.js`, page(n)]));
  for (const [shape, files, keys] of [
    ['in one file', { 'Routes.js': file('AppRoutes', docs, doc) }, {}],
    ['in one file, the other Routes first', { 'Routes.js': file('AppRoutes', doc, docs) }, {}],
    ['in two route files', { 'Routes.js': file('AppRoutes', docs), 'Extra.js': file('Extra', doc) }, { routesFile: ['Routes.js', 'Extra.js'] }],
    ['in two route files, the other file first', { 'Routes.js': file('AppRoutes', docs), 'Extra.js': file('Extra', doc) }, { routesFile: ['Extra.js', 'Routes.js'] }],
  ] as const) {
    const map = await build(writeApp({ ...pages, ...files, 'Start.js': start }, keys));
    assert.deepEqual(Object.fromEntries(map.screens.find((s) => s.id === '/start#Start')!.links.map((l) => [l.to, [...l.targets].sort()])), {
      '/docs/1': ['/docs/*#Docs', '/docs/:id#Doc'],
      '/docs': ['/docs/*#Docs'],
    }, shape);
  }
});

test('a catch-all * or /* route in a Routes drawn beside another is a link\'s screen beside the other Routes\' screen, but not beside a route of its own Routes that wins', async () => {
  for (const star of ['*', '/*']) {
    const users = `<Routes>
        <Route path="/users" element={<Users />} />
        <Route path="/start" element={<Start />} />
      </Routes>`;
    const admin = `<Routes>
        <Route path="/admin" element={<Admin />} />
        <Route path="${star}" element={<NotFound />} />
      </Routes>`;
    const file = (name: string, ...drawn: string[]) => `import { Route, Routes } from 'react-router-dom';
import Users from './Users';
import Admin from './Admin';
import NotFound from './NotFound';
import Start from './Start';

export default function ${name}() {
  return (
    <>
      ${drawn.join('\n      ')}
    </>
  );
}
`;
    const start = `import { Link } from 'react-router-dom';\n\nexport default function Start() {\n  return <nav><Link to="/users">users</Link><Link to="/admin">admin</Link><Link to="/zzz">zzz</Link></nav>;\n}\n`;
    const pages = Object.fromEntries(['Users', 'Admin', 'NotFound'].map((n) => [`${n}.js`, page(n)]));
    for (const [shape, files, keys] of [
      ['in one file', { 'Routes.js': file('AppRoutes', users, admin) }, {}],
      ['in one file, the catch-all Routes first', { 'Routes.js': file('AppRoutes', admin, users) }, {}],
      ['in two route files', { 'Routes.js': file('AppRoutes', users), 'Extra.js': file('Extra', admin) }, { routesFile: ['Routes.js', 'Extra.js'] }],
      ['in two route files, the catch-all file first', { 'Routes.js': file('AppRoutes', users), 'Extra.js': file('Extra', admin) }, { routesFile: ['Extra.js', 'Routes.js'] }],
    ] as const) {
      const map = await build(writeApp({ ...pages, ...files, 'Start.js': start }, keys));
      const notFound = `${star}#NotFound`;
      assert.deepEqual(Object.fromEntries(map.screens.find((s) => s.id === '/start#Start')!.links.map((l) => [l.to, [...l.targets].sort()])), {
        '/users': [notFound, '/users#Users'].sort(),
        '/admin': ['/admin#Admin'],
        '/zzz': [notFound],
      }, `${star} ${shape}`);
    }
  }
});

test('a move or a link whose address is a call of a function the source declares takes the address the function returns, whether the function is in the same file or imported from another', async () => {
  const home = `import { Link, useHistory } from 'react-router-dom';
import { helpPath } from './paths';
import * as paths from './paths';
import { teamPath } from './more';

const loginPath = () => '/login';
function startPath() {
  return '/start';
}

export default function Home() {
  const history = useHistory();
  return (
    <nav>
      <Link to={loginPath()}>login</Link>
      <button onClick={() => history.push(startPath())}>start</button>
      <Link to={helpPath()}>help</Link>
      <Link to={\`\${paths.teamsPath()}/a\`}>team a</Link>
      <Link to={teamPath()}>team b</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({
    'Home.js': home,
    'paths.js': "export const helpPath = () => '/help';\n\nexport function teamsPath() {\n  return '/team';\n}\n",
    'more.js': "export { teamPath } from './team-path';\n",
    'team-path.js': "export const teamPath = function () {\n  return '/team/b';\n};\n",
  }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/login', at('loginPath()}'), [], ['/login#Login']],
    ['/start', at('startPath())'), [], ['/start#Start']],
    ['/help', at('helpPath()'), [], ['/help/:page?#Help']],
    ['/team/a', at('teamsPath()'), [], ['/team/:team#Team']],
    ['/team/b', at('teamPath()}'), [], ['/team/:team#Team']],
  ]);
});

test('an address function call in a file several screens share goes only to the screens whose code reaches the component holding it, with the conditions of that place', async () => {
  const nav = `import { Link, useHistory } from 'react-router-dom';
import { teamPath } from './paths';

const loginPath = () => '/login';

export function TeamLink({ open }) {
  return open ? <Link to={teamPath()}>team</Link> : null;
}

export function LoginLink() {
  const history = useHistory();
  return <a onClick={() => history.push(loginPath())}>login</a>;
}
`;
  const map = await build(writeApp({
    'nav.js': nav,
    'paths.js': "export const teamPath = () => '/team/a';\n",
    'Home.js': "import { TeamLink } from './nav';\n\nexport default function Home() {\n  return <TeamLink open />;\n}\n",
    'Start.js': "import { LoginLink } from './nav';\n\nexport default function Start() {\n  return <LoginLink />;\n}\n",
  }));
  assert.deepEqual(linksOf(map, '/home#Home'), [['/team/a', lineOf(nav, 'teamPath()'), ['open'], ['/team/:team#Team']]]);
  assert.deepEqual(linksOf(map, '/start#Start'), [['/login', lineOf(nav, 'loginPath()'), [], ['/login#Login']]]);
});

test('a route path whose function returns a path not written from / is joined to the outer route\'s path', async () => {
  const routes = `import { Route, Routes } from 'react-router-dom';
import App from './App';
import Start from './Start';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/app/*" element={<App />} />
      <Route path="/start" element={<Start />} />
    </Routes>
  );
}
`;
  const app = `import { Route, Routes } from 'react-router-dom';
import Settings from './Settings';
import { settingsTab } from './tabs';

export default function App() {
  return (
    <Routes>
      <Route path={settingsTab()} element={<Settings />} />
    </Routes>
  );
}
`;
  const start = `import { Link } from 'react-router-dom';\n\nexport default function Start() {\n  return <Link to="/app/settings">settings</Link>;\n}\n`;
  const map = await build(writeApp({ 'Routes.js': routes, 'App.js': app, 'tabs.js': "export const settingsTab = () => 'settings';\n", 'Settings.js': page('Settings'), 'Start.js': start }, { routesFile: ['Routes.js', 'App.js'] }));
  const settings = map.screens.find((s) => s.id.endsWith('#Settings'))!;
  assert.equal(settings.path, 'settings');
  assert.deepEqual(linksOf(map, '/start#Start'), [['/app/settings', 4, [], [settings.id]]]);
});

test('a route file Redirect whose from or to is a call of a function the source declares sends a link to the screen of the address the function returns and makes that screen an entry', async () => {
  const routes = `import { Redirect, Route, Switch } from 'react-router-dom';
import { oldPath, startPath } from './paths';
import Home from './Home';
import Start from './Start';
import Login from './Login';

export default function Routes() {
  return (
    <Switch>
      <Route path="/login" component={Login} exact />
      <Route path="/home" component={Home} exact />
      <Route path="/start" component={Start} exact />
      <Redirect from={oldPath()} to={startPath()} />
    </Switch>
  );
}
`;
  const home = `import { Link } from 'react-router-dom';\n\nexport default function Home() {\n  return <Link to="/old">old</Link>;\n}\n`;
  const map = await build(writeApp({ 'Routes.js': routes, 'Home.js': home, 'paths.js': "export const oldPath = () => '/old';\nexport const startPath = () => '/start';\n" }));
  assert.deepEqual(linksOf(map, '/home#Home'), [['/old', 4, [], ['/start#Start']]]);
  assert.deepEqual(map.entries.find((e) => e.screen === '/start#Start')!.reasons, [{ kind: 'redirect', file: 'Routes.js', line: lineOf(routes, '<Redirect') }]);
});
