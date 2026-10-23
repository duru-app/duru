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

test('a move through the history of props, this.props or a history taken out of this.props becomes a link, and a function given that history is a link where it is called', async () => {
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
  assert.deepEqual(linksOf(map, '/help/:page?#Help'), [['/team/{*}', 6, [], ['/team/:team#Team']], ['/start', 6, [], ['/start#Start']]]);
});

test('a move through the history a function component takes out of its first parameter becomes a link, the move in a lowercase function that takes it out of its parameter is a link where that function is called, and one taken out of a later parameter or a function wrapped in a call is not read', async () => {
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
    ['/login', 14, [], ['/login#Login']],
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

test('an address a router link or a move takes from a function parameter or props gives no link there, nor one made from a route constant through a variable or an object field, which is a link where the constant is written', async () => {
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
    ['/start', lineOf(home, "goTo('/start')")],
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

const addressesAt = (map: ScreenMap, id: string) => linksOf(map, id).map(([to, line]) => [to, line]);

test('an argument whose value duru cannot read is a {*} piece of the address the function returns, and an address that starts with such a value is {?}', async () => {
  const home = `import { Link } from 'react-router-dom';
import { ownPath, teamPath } from './paths';

export default function Home({ team, base }) {
  return (
    <nav>
      <Link to={teamPath(team.id)}>team</Link>
      <Link to={teamPath('a')}>team a</Link>
      <Link to={ownPath(base)}>own</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': 'export const teamPath = (team) => `/team/${team}`;\nexport const ownPath = (base) => `${base}/own`;\n' }));
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/team/{*}', lineOf(home, 'team.id'), [], ['/team/:team#Team']],
    ['/team/a', lineOf(home, "teamPath('a')"), [], ['/team/:team#Team']],
    ['{?}', lineOf(home, 'ownPath(base)'), [], []],
  ]);
});

test('an address function that adds pieces to a let or joins its rest arguments is read, and a condition on an argument left out or on the number of rest arguments picks its branch', async () => {
  const paths = `export function settingsPath(...args) {
  return '/settings' + (args.length > 0 ? \`/\${args.join('/')}\` : '');
}

export function helpPath(page, anchor) {
  let url = '/help';
  if (page) url += \`/\${page}\`;
  if (anchor !== undefined) url += \`#\${anchor}\`;
  return url;
}

export function teamPath(team) {
  let url;
  if (team === 'new') {
    url = '/team/new';
  } else {
    url = \`/team/\${team}\`;
  }
  return url;
}
`;
  const home = `import { Link } from 'react-router-dom';
import { helpPath, settingsPath, teamPath } from './paths';

export default function Home() {
  return (
    <nav>
      <Link to={settingsPath()}>settings</Link>
      <Link to={settingsPath('groups', ':id', 'members')}>members</Link>
      <Link to={helpPath()}>help</Link>
      <Link to={helpPath('faq')}>faq</Link>
      <Link to={helpPath('faq', 'top')}>top</Link>
      <Link to={teamPath('new')}>new team</Link>
      <Link to={teamPath('x')}>team x</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), [
    ['/settings', at('settingsPath()')],
    ['/settings/groups/:id/members', at("'members')")],
    ['/help', at('helpPath()')],
    ['/help/faq', at("helpPath('faq')")],
    ['/help/faq', at("'top')")],
    ['/team/new', at("teamPath('new')")],
    ['/team/x', at("teamPath('x')")],
  ]);
});

test('an address function that calls another address function is read through it', async () => {
  const paths = `const base = () => '/team';
export const teamPath = (id) => \`\${base()}/\${id}\`;
export const membersPath = (id) => teamPath(id) + '/members';
`;
  const home = `import { Link } from 'react-router-dom';
import { membersPath } from './paths';

export default function Home() {
  return <nav><Link to={membersPath('a')}>members</Link></nav>;
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  assert.deepEqual(addressesAt(map, '/home#Home'), [['/team/a/members', 5]]);
});

test('a parameter with a default or written as an object pattern takes the default when the argument is left out, and the property of the object given otherwise', async () => {
  const paths = `export const templatePath = ({ id }) => \`/templates/\${id}\`;
export const adminPath = ({ category, selected } = {}) => (selected ? \`/admin/\${category}/\${selected}\` : \`/admin/\${category}\`);
export function searchPath({ query, page = 1 } = {}) {
  return query ? \`/search/\${query}/\${page}\` : '/search';
}
`;
  const home = `import { Link } from 'react-router-dom';
import { adminPath, searchPath, templatePath } from './paths';

export default function Home({ id }) {
  return (
    <nav>
      <Link to={templatePath({ id: 'a' })}>a</Link>
      <Link to={templatePath({ id })}>template</Link>
      <Link to={adminPath({ category: 'users' })}>users</Link>
      <Link to={adminPath({ category: 'users', selected: 'x' })}>user x</Link>
      <Link to={searchPath()}>search</Link>
      <Link to={searchPath({ query: 'q' })}>q</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), [
    ['/templates/a', at("id: 'a'")],
    ['/templates/{*}', at('templatePath({ id })')],
    ['/admin/users', at("category: 'users' })")],
    ['/admin/users/x', at("selected: 'x'")],
    ['/search', at('searchPath()')],
    ['/search/q/1', at("query: 'q'")],
  ]);
});

test('an address function reads a const or let of its body with the arguments it is given, and a name holding what an address function returns is read through the call', async () => {
  const paths = `export const newDocPath = (parentId) => {
  const search = parentId ? \`?parentId=\${parentId}\` : '';
  return \`/doc/new\${search}\`;
};
export const searchPath = () => '/search';
`;
  const home = `import { Link, useHistory } from 'react-router-dom';
import { newDocPath, searchPath } from './paths';

export default function Home() {
  const history = useHistory();
  const base = searchPath();
  return (
    <nav>
      <Link to={newDocPath()}>new</Link>
      <Link to={newDocPath('p')}>new inside</Link>
      <button onClick={() => history.push(base)}>search</button>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), [['/doc/new', at('newDocPath()')], ['/doc/new', at("newDocPath('p')")], ['/search', at('push(base)')]]);
});

test('an address function that returns a location object gives the address of its pathname', async () => {
  const paths = `export const getEditLocation = (id) => ({ pathname: \`/team/\${id}\`, state: { from: 'list' } });
export function getCreateLocation() {
  return { search: '?from=list', pathname: '/team/new' };
}
`;
  const home = `import { useHistory } from 'react-router-dom';
import { getCreateLocation, getEditLocation } from './paths';

export default function Home({ row }) {
  const history = useHistory();
  return <nav><a onClick={() => history.push(getEditLocation(row.id))} /><a onClick={() => history.push(getCreateLocation())} /></nav>;
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  assert.deepEqual(linksOf(map, '/home#Home'), [['/team/{*}', 6, [], ['/team/:team#Team']], ['/team/new', 6, [], ['/team/:team#Team']]]);
});

test('an address function that picks its address by a condition duru cannot read, written with if and a return below it, if and else, or ? :, gives a link for each branch, with the conditions of the place it is called and none from inside the function', async () => {
  const paths = `import { env } from 'app-env';
import { store } from './store';

export const helpPath = () => (env.cloud ? '/help/cloud' : '/help');

export function teamPath(user) {
  if (user.admin) return '/team/admin';
  return \`/team/\${user.team}\`;
}

export function homePath() {
  if (store.signedIn) {
    return '/home';
  } else {
    return '/login';
  }
}
`;
  const home = `import { Link, useHistory } from 'react-router-dom';
import { helpPath, homePath, teamPath } from './paths';

export default function Home({ user, open }) {
  const history = useHistory();
  return (
    <nav>
      <Link to={helpPath()}>help</Link>
      {open && <Link to={teamPath(user)}>team</Link>}
      <button onClick={() => history.push(homePath())}>home</button>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths, 'store.js': 'export const store = { signedIn: window.signedIn };\n' }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/help/cloud', at('helpPath()'), [], ['/help/:page?#Help']],
    ['/help', at('helpPath()'), [], ['/help/:page?#Help']],
    ['/team/admin', at('teamPath(user)'), ['open'], ['/team/:team#Team']],
    ['/team/{*}', at('teamPath(user)'), ['open'], ['/team/:team#Team']],
    ['/home', at('homePath()'), [], ['/home#Home']],
    ['/login', at('homePath()'), [], ['/login#Login']],
  ]);
});

test('a branch not written from / gives no link, and branches that give the same address give one link', async () => {
  const paths = `export const relativePath = (flag) => (flag.relative ? 'settings' : '/settings');
export const emptyPath = (flag) => (flag.none ? '' : '/start');
export const samePath = (flag) => (flag.query ? '/help?x=1' : '/help#top');
`;
  const home = `import { Link } from 'react-router-dom';
import { emptyPath, relativePath, samePath } from './paths';

export default function Home({ flag }) {
  return (
    <nav>
      <Link to={relativePath(flag)}>settings</Link>
      <Link to={emptyPath(flag)}>start</Link>
      <Link to={samePath(flag)}>help</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), [['/settings', at('relativePath(flag)')], ['/start', at('emptyPath(flag)')], ['/help', at('samePath(flag)')]]);
});

test('an address whose leading piece is the empty text an address function returns in one branch is {?} in that branch, so that branch goes to no screen', async () => {
  const routes = `import { Route, Switch } from 'react-router-dom';
import Home from './Home';
import Team from './Team';
import Login from './Login';

export default function Routes() {
  return (
    <Switch>
      <Route path="/login" component={Login} exact />
      <Route path="/home" component={Home} exact />
      <Route path="/:team" component={Team} />
    </Switch>
  );
}
`;
  const paths = `export function teamUrl(team) {
  if (!team) return '';
  return \`/\${team.name}\`;
}

export const channelUrl = (team, channel) => teamUrl(team) + '/channels/' + channel.name;
`;
  const home = `import { useHistory } from 'react-router-dom';
import { channelUrl } from './paths';

export default function Home({ team, channel }) {
  const history = useHistory();
  return <a onClick={() => history.push(channelUrl(team, channel))}>channel</a>;
}
`;
  const map = await build(writeApp({ 'Routes.js': routes, 'Home.js': home, 'paths.js': paths }));
  assert.deepEqual(linksOf(map, '/home#Home'), [['{?}', 6, [], []], ['/{*}/channels/{*}', 6, [], ['/:team#Team']]]);
});

test('more than 8 different addresses at one place give one {?} link', async () => {
  const tabs = (name: string, count: number) => `export function ${name}(tab) {\n${Array.from({ length: count - 1 }, (_, i) => `  if (tab.is${i}) return '/team/${i}';\n`).join('')}  return '/team/last';\n}\n`;
  const home = `import { Link } from 'react-router-dom';
import { eight, nine } from './tabs';

export default function Home({ tab }) {
  return (
    <nav>
      <Link to={eight(tab)}>eight</Link>
      <Link to={nine(tab)}>nine</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'tabs.js': tabs('eight', 8) + tabs('nine', 9) }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), [
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => [`/team/${i}`, at('eight(tab)')]),
    ['/team/last', at('eight(tab)')],
    ['{?}', at('nine(tab)')],
  ]);
});

test('an address function that comes back to a function it is reading, or calls more than 8 deep, stops with {?}', async () => {
  const chain = Array.from({ length: 8 }, (_, i) => `export const f${i + 1} = () => f${i + 2}();\n`).join('');
  const paths = `export const ping = () => pong();
const pong = () => ping();
${chain}const f9 = () => '/team/deep';
`;
  const home = `import { Link } from 'react-router-dom';
import { f1, f2, ping } from './paths';

export default function Home() {
  return (
    <nav>
      <Link to={ping()}>ping</Link>
      <Link to={f2()}>eight deep</Link>
      <Link to={f1()}>nine deep</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), [['{?}', at('ping()')], ['/team/deep', at('f2()')], ['{?}', at('f1()')]]);
});

test('a function that takes its address out of a table by a computed key or from a package function stays {?}', async () => {
  const paths = `import { generatePath } from 'react-router-dom';

const TABLE = { a: '/team/a', b: '/team/b' };
export const tablePath = (key) => TABLE[key];
export const packagePath = (id) => generatePath('/team/:id', { id });
`;
  const home = `import { Link } from 'react-router-dom';
import { packagePath, tablePath } from './paths';

export default function Home() {
  return <nav><Link to={tablePath('a')}>a</Link><Link to={packagePath('b')}>b</Link></nav>;
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  assert.deepEqual(addressesAt(map, '/home#Home'), [['{?}', 5], ['{?}', 5]]);
});

test('a name in passThroughCalls is read as its first argument even when a function of that name is declared in the source', async () => {
  const home = `import { Link } from 'react-router-dom';

const wrap = (address) => '/login';

export default function Home() {
  return <Link to={wrap('/start')}>start</Link>;
}
`;
  const map = await build(writeApp({ 'Home.js': home }, { passThroughCalls: ['wrap'] }));
  assert.deepEqual(addressesAt(map, '/home#Home'), [['/start', 6]]);
});

test('an address function that returns its argument whole gives no link when the argument comes from props or a parameter', async () => {
  const home = `import { Link, useHistory } from 'react-router-dom';

const same = (url) => url;
const fallback = (url) => url || '/home';

export default function Home(props) {
  const history = useHistory();
  const goTo = (href) => history.push(same(href));
  return (
    <nav>
      <Link to={same(props.next)}>next</Link>
      <button onClick={() => goTo('/team/a')}>team</button>
      <Link to={same('/start')}>start</Link>
      <Link to={fallback(props.back)}>back</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), [['/team/a', at("goTo('/team/a')")], ['/start', at("same('/start')")], ['/home', at('fallback(')]]);
});

test('the decision record says that duru reads the address a function declared in the source returns, the usage guide and the agent skill say what a route path not read line adds when that function gives several paths, and the usage guide does not say how such a call is read', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
  assert.doesNotMatch(read('README.md'), /a call of a function declared in the source/);
  assert.match(read('README.md'), /`, which gives <paths>`/);
  assert.match(read('skills/duru/SKILL.md'), /`, which gives <paths>`/);
  const decisions = read('docs/decisions.md');
  assert.match(decisions, /\*\*A link address or route path that calls a function declared in the source is read through the function's body/);
  assert.doesNotMatch(decisions, /What an imported function\s+returns \(`draftsPath\(\)`, `settingsPath\("groups", ":id"\)`\) is not read/);
});

test('an address function whose body changes a value of its own through a call, a callback, an assignment inside an expression or ++ stays {?}', async () => {
  const paths = `export function pushed(tab) {
  const parts = ['', 'team'];
  if (tab) parts.push(tab);
  return parts.join('/');
}

export function guarded(tab) {
  let url = '/team';
  tab && (url = \`/team/\${tab}\`);
  return url;
}

export function assigned(tab) {
  const o = { path: '/team' };
  Object.assign(o, { path: \`/team/\${tab}\` });
  return o.path;
}

export function looped(tabs) {
  let target = '/team';
  tabs.forEach((t) => {
    if (t.on) target = \`/team/\${t.id}\`;
  });
  return target;
}

export function counted() {
  let n = 0;
  n++;
  return \`/team/\${n}\`;
}

export function logged(tab) {
  console.info('moving');
  return '/login';
}
`;
  const home = `import { Link } from 'react-router-dom';
import { assigned, counted, guarded, logged, looped, pushed } from './paths';

export default function Home({ tab, tabs }) {
  return (
    <nav>
      <Link to={pushed(tab)}>pushed</Link>
      <Link to={guarded(tab)}>guarded</Link>
      <Link to={assigned(tab)}>assigned</Link>
      <Link to={looped(tabs)}>looped</Link>
      <Link to={counted()}>counted</Link>
      <Link to={logged(tab)}>logged</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), [
    ['{?}', at('pushed(tab)')],
    ['{?}', at('guarded(tab)')],
    ['{?}', at('assigned(tab)')],
    ['{?}', at('looped(tabs)')],
    ['{?}', at('counted()')],
    ['/login', at('logged(tab)')],
  ]);
});

const MOVES = `import { getHistory } from './utils/browser_history';

export function leaveTo(address) {
  getHistory().push(address);
}
`;

test('a call of a function the source declares that moves to the address it is given is a link at the call, with the conditions of the call, whether the function is declared by name, held by a const, written inside the component or imported from another file', async () => {
  const home = `import { useNavigate } from 'react-router-dom';
import { getHistory } from './utils/browser_history';
import { leaveTo } from './moves';

function moveTo(address) {
  getHistory().push(address);
}

const replaceWith = (address) => getHistory().replace(address);

export default function Home({ flag }) {
  const navigate = useNavigate();
  const goTo = (href) => navigate(href);
  return (
    <nav>
      <a onClick={() => flag.a && moveTo('/start')}>a</a>
      <a onClick={() => flag.b && replaceWith('/login')}>b</a>
      <a onClick={() => flag.c && goTo('/help')}>c</a>
      <a onClick={() => flag.d && leaveTo('/team/a')}>d</a>
      <a onClick={() => navigate(goTo('/start'))}>e</a>
    </nav>
  );
}
`;
  const map = await build(writeApp(
    { 'Home.js': home, 'moves.js': MOVES, 'utils/browser_history.js': MADE_HISTORY },
    { history: { import: './utils/browser_history', name: 'getHistory' } },
  ));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/start', at("moveTo('/start')"), ['flag.a'], ['/start#Start']],
    ['/login', at("replaceWith('/login')"), ['flag.b'], ['/login#Login']],
    ['/help', at("goTo('/help')"), ['flag.c'], ['/help/:page?#Help']],
    ['/team/a', at("leaveTo('/team/a')"), ['flag.d'], ['/team/:team#Team']],
    ['{?}', at("navigate(goTo('/start'))"), [], []],
  ]);
});

test('an argument from props or a parameter that a helper moves to as it is gives no link, nor a move in the helper whose address is a parameter of a function inside it', async () => {
  const home = `import { useHistory } from 'react-router-dom';

export default function Home(props) {
  const history = useHistory();
  const open = (url) => history.push(url);
  const openAll = (urls) => urls.forEach((u) => history.push(u));
  const renderMenu = (menu) => {
    const { href } = menu;
    return <a onClick={() => open(href)}>{menu.title}</a>;
  };
  return (
    <nav>
      <a onClick={() => open(props.next)}>next</a>
      {props.menus.map(renderMenu)}
      <a onClick={() => openAll(['/start'])}>all</a>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home }));
  assert.deepEqual(linksOf(map, '/home#Home'), []);
});

test('a helper whose move is already a link in its own body, or stays on the screen, adds no link at its calls', async () => {
  const home = `import { useHistory, useLocation } from 'react-router-dom';

export default function Home() {
  const history = useHistory();
  const location = useLocation();
  const openTeam = (id) => history.push(\`/team/\${id}\`);
  const openSplit = (search) => history.push({ pathname: location.pathname, search });
  return (
    <nav>
      <a onClick={() => openTeam('a')}>team</a>
      <a onClick={() => openSplit('?side=1')}>split</a>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home }));
  assert.deepEqual(linksOf(map, '/home#Home'), [['/team/{*}', lineOf(home, 'history.push(`/team/'), [], ['/team/:team#Team']]]);
});

test('a helper call in a file several screens share goes only to the screens whose code reaches the component holding the call', async () => {
  const nav = `import { useHistory } from 'react-router-dom';

export function TeamButton() {
  const history = useHistory();
  const go = (to) => history.push(to);
  return <a onClick={() => go('/team/a')}>team</a>;
}

export function LoginButton() {
  const history = useHistory();
  const go = (to) => history.push(to);
  return <a onClick={() => go('/login')}>login</a>;
}
`;
  const map = await build(writeApp({
    'nav.js': nav,
    'Home.js': "import { TeamButton } from './nav';\n\nexport default function Home() {\n  return <TeamButton />;\n}\n",
    'Start.js': "import { LoginButton } from './nav';\n\nexport default function Start() {\n  return <LoginButton />;\n}\n",
  }));
  assert.deepEqual(linksOf(map, '/home#Home'), [['/team/a', lineOf(nav, "go('/team/a')"), [], ['/team/:team#Team']]]);
  assert.deepEqual(linksOf(map, '/start#Start'), [['/login', lineOf(nav, "go('/login')"), [], ['/login#Login']]]);
});

const PICKERS = `import { getHistory } from './utils/browser_history';

export const onSelect = (type, payload) => {
  switch (type) {
    case 'dispatch':
      store.dispatch(payload);
      break;
    case 'redirect':
      if (getHistory().location.pathname !== payload.path) {
        getHistory().push(payload.path);
      }
      break;
    default:
  }
};

export function pushWithQuery(path, query) {
  if (query) {
    getHistory().push({ pathname: path, search: query.toString() });
  } else {
    getHistory().push(path);
  }
}

export function openFrom(payload) {
  const { path } = payload;
  getHistory().push(path);
}
`;

test('a helper that moves to a property of what it is given, or to a location whose pathname it is given, reads it from each call, and a call that does not give it gives no link', async () => {
  const home = `import { onSelect, pushWithQuery, openFrom } from './pickers';

export default function Home({ query }) {
  return (
    <nav>
      <a onClick={() => onSelect('redirect', { path: '/start' })}>a</a>
      <a onClick={() => onSelect('dispatch', { type: 'x' })}>b</a>
      <a onClick={() => onSelect('redirect', { path: null })}>c</a>
      <a onClick={() => pushWithQuery('/login', query)}>d</a>
      <a onClick={() => openFrom({ path: '/help/faq' })}>e</a>
    </nav>
  );
}
`;
  const map = await build(writeApp(
    { 'Home.js': home, 'pickers.js': PICKERS, 'utils/browser_history.js': MADE_HISTORY },
    { history: { import: './utils/browser_history', name: 'getHistory' } },
  ));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/start', at("path: '/start'"), [], ['/start#Start']],
    ['/login', at("pushWithQuery('/login'"), [], ['/login#Login']],
    ['/help/faq', at("openFrom("), [], ['/help/:page?#Help']],
  ]);
});

const LEAVERS = `import { getHistory } from './utils/browser_history';

export function logOut(redirectTo = '/login', signal = true) {
  clearCookie(signal);
  getHistory().push(redirectTo);
}

export function switchTo(url, team) {
  if (team) {
    selectTeam(team);
  } else {
    getHistory().push(url);
  }
}

export function openIf(page, on) {
  on && getHistory().push(page);
}

export function openTeam(path) {
  path = '/team' + path;
  getHistory().push(path);
}
`;

test('a helper parameter left out takes its default, a condition in the helper that the arguments decide keeps only the move it leads to while one they cannot decide keeps every move without its text, and a parameter the helper changes is not read from the call', async () => {
  const home = `import { logOut, switchTo, openIf, openTeam } from './leavers';

export default function Home({ team }) {
  return (
    <nav>
      <a onClick={() => logOut()}>a</a>
      <a onClick={() => logOut('/start')}>b</a>
      <a onClick={() => switchTo('/team/a')}>c</a>
      <a onClick={() => switchTo('/team/b', team)}>d</a>
      <a onClick={() => switchTo('/help', { id: 1 })}>e</a>
      <a onClick={() => openIf('/start', false)}>f</a>
      <a onClick={() => openTeam('/a')}>g</a>
    </nav>
  );
}
`;
  const map = await build(writeApp(
    { 'Home.js': home, 'leavers.js': LEAVERS, 'utils/browser_history.js': MADE_HISTORY },
    { history: { import: './utils/browser_history', name: 'getHistory' } },
  ));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/login', at('logOut()'), [], ['/login#Login']],
    ['/start', at("logOut('/start')"), [], ['/start#Start']],
    ['/team/a', at("switchTo('/team/a')"), [], ['/team/:team#Team']],
    ['/team/b', at("switchTo('/team/b'"), [], ['/team/:team#Team']],
  ]);
});

test('a helper given the history it moves with is a link at each call that hands it a history by the rules for a move, whether as an argument or a property of one, and none where it hands something else', async () => {
  const home = `import { useHistory } from 'react-router-dom';

function openTeam(history, data) {
  history.push(\`/team/\${data.id}\`);
}

function leave({ history }) {
  history.replace('/login');
}

function relay(history) {
  openTeam(history, { id: 'b' });
}

export default function Home({ flag }) {
  const history = useHistory();
  return (
    <nav>
      <a onClick={() => openTeam(history, { id: 'a' })}>a</a>
      <a onClick={() => flag && leave({ history })}>b</a>
      <a onClick={() => openTeam(window.history, { id: 'c' })}>c</a>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/team/a', at("id: 'a'"), [], ['/team/:team#Team']],
    ['/login', at('flag && leave'), ['flag'], ['/login#Login']],
  ]);
});

test('a helper call that holds a route constant, or whose move in the helper holds one, gives only the route constant link where the constant is written', async () => {
  const home = `import { useHistory } from 'react-router-dom';
import Option from './Option';

const TEAM_ROUTES = { a: Option.ROUTE_PATH.TEAM, b: Option.ROUTE_PATH.HELP };

function openMeta(history, data) {
  const route = TEAM_ROUTES[data.type];
  if (route) history.push(\`\${route}/\${data.id}\`);
}

export default function Home() {
  const history = useHistory();
  const login = Option.ROUTE_PATH.LOGIN;
  const go = (href) => history.push(href);
  return (
    <nav>
      <a onClick={() => go(login)}>a</a>
      <a onClick={() => openMeta(history, { type: 'a', id: 1 })}>b</a>
    </nav>
  );
}
`;
  const map = await build(writeApp(
    { 'Home.js': home, 'Option.js': "export default { ROUTE_PATH: { TEAM: '/team', HELP: '/help', LOGIN: '/login' } };\n" },
    { routeConstant: 'Option.ROUTE_PATH', constants: { Option: 'Option.js' } },
  ));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home').map(([to, line]) => [to, line]), [
    ['/team', at('TEAM_ROUTES = ')],
    ['/help', at('TEAM_ROUTES = ')],
    ['/login', at('ROUTE_PATH.LOGIN')],
  ]);
});

const THUNKS = `import { getHistory } from './utils/browser_history';

export function switchTeam(url, team) {
  return (dispatch) => {
    if (team) {
      dispatch({ type: 'select', team });
    } else {
      getHistory().push(url);
    }
  };
}

export function logOut(redirectTo = '/login') {
  dispatch(logout()).then(() => {
    getHistory().push(redirectTo);
  }).catch(() => {
    getHistory().push(redirectTo);
  });
}
`;

test('a helper that returns a function moving to the address it was given, as a redux thunk does, or moves inside a callback, is a link at the call of the helper', async () => {
  const home = `import { useDispatch } from 'react-redux';
import { switchTeam, logOut } from './thunks';

export default function Home({ team }) {
  const dispatch = useDispatch();
  return (
    <nav>
      <a onClick={() => dispatch(switchTeam('/team/a'))}>a</a>
      <a onClick={() => dispatch(switchTeam('/team/b', team))}>b</a>
      <a onClick={() => dispatch(switchTeam('/help', { id: 1 }))}>c</a>
      <a onClick={() => logOut()}>d</a>
      <a onClick={() => logOut('/start')}>e</a>
    </nav>
  );
}
`;
  const map = await build(writeApp(
    { 'Home.js': home, 'thunks.js': THUNKS, 'utils/browser_history.js': MADE_HISTORY },
    { history: { import: './utils/browser_history', name: 'getHistory' } },
  ));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/team/a', at("switchTeam('/team/a')"), [], ['/team/:team#Team']],
    ['/team/b', at("switchTeam('/team/b'"), [], ['/team/:team#Team']],
    ['/login', at('logOut()'), [], ['/login#Login']],
    ['/start', at("logOut('/start')"), [], ['/start#Start']],
  ]);
});

test('a call of a function taken from props or a parameter is not read as a helper', async () => {
  const home = `import { useHistory } from 'react-router-dom';

export default function Home(props) {
  const history = useHistory();
  const { go } = props;
  const run = (open) => open('/start');
  return (
    <nav>
      <a onClick={() => props.go('/start')}>a</a>
      <a onClick={() => props.actions.go('/login')}>b</a>
      <a onClick={() => go('/help')}>c</a>
      <a onClick={() => run((u) => history.push(u))}>d</a>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home }));
  assert.deepEqual(linksOf(map, '/home#Home'), []);
});

test('a helper that hands what it is given to another helper is read through both, up to 8 deep, a helper that comes back to one it is reading stops there, and a call in a helper that does not use what the helper is given, or is already a link where it is written, stays a link only there', async () => {
  const steps = Array.from({ length: 8 }, (_, i) => `const step${i + 2} = (u) => step${i + 1}(u);`).join('\n');
  const home = `import { useHistory } from 'react-router-dom';

export default function Home() {
  const history = useHistory();
  const step1 = (u) => history.push(u);
${steps}
  const again = (u) => {
    history.push(u);
    again(u);
  };
  const ping = (u) => pong(u);
  const pong = (u) => {
    ping(u);
    history.replace(u);
  };
  const both = (u) => {
    step1('/login');
    step1(u);
  };
  const team = (id) => step1(\`/team/\${id}\`);
  return (
    <nav>
      <a onClick={() => step8('/start')}>a</a>
      <a onClick={() => step9('/login')}>b</a>
      <a onClick={() => again('/help')}>c</a>
      <a onClick={() => ping('/team/a')}>d</a>
      <a onClick={() => both('/start')}>e</a>
      <a onClick={() => team('b')}>f</a>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/login', at("step1('/login')"), [], ['/login#Login']],
    ['/team/{*}', at('step1(`/team/'), [], ['/team/:team#Team']],
    ['/start', at("step8('/start')"), [], ['/start#Start']],
    ['/help', at("again('/help')"), [], ['/help/:page?#Help']],
    ['/team/a', at("ping('/team/a')"), [], ['/team/:team#Team']],
    ['/start', at("both('/start')"), [], ['/start#Start']],
  ]);
});

test('a helper call whose arguments pass the branch limit is {?} only when the helper moves with a history it does not take from the call, so a string replace or an array push on a parameter never gives a link', async () => {
  const home = `import { useHistory } from 'react-router-dom';

const strip = (label) => label.replace(/^Doc /, '');

function titleOf(ctx) {
  return strip(ctx.title);
}

function createModel({ type, title }) {
  const ctx = { title, a: type === 1 ? 'a' : 'A', b: type === 2 ? 'b' : 'B', c: type === 3 ? 'c' : 'C', d: type === 4 ? 'd' : 'D', e: type === 5 ? 'e' : 'E', f: type === 6 ? 'f' : 'F', g: type === 7 ? 'g' : 'G' };
  return { title: titleOf(ctx) };
}

const addRow = (rows, a, b, c, d, e, f, g) => {
  rows.push([a, b, c, d, e, f, g]);
};

function open(history, url, a, b, c, d, e, f, g) {
  history.push(url);
}

export default function Home({ type, doc, x }) {
  const history = useHistory();
  const leave = (url, a, b, c, d, e, f, g) => history.push(url);
  const model = createModel({ type, title: doc.title });
  const rows = [];
  addRow(rows, x.a ? 'a' : 'A', x.b ? 'b' : 'B', x.c ? 'c' : 'C', x.d ? 'd' : 'D', x.e ? 'e' : 'E', x.f ? 'f' : 'F', x.g ? 'g' : 'G');
  return (
    <nav>
      <a onClick={() => open(history, '/start', x.a ? 'a' : 'A', x.b ? 'b' : 'B', x.c ? 'c' : 'C', x.d ? 'd' : 'D', x.e ? 'e' : 'E', x.f ? 'f' : 'F', x.g ? 'g' : 'G')}>{model.title}</a>
      <a onClick={() => leave('/login', x.a ? 'a' : 'A', x.b ? 'b' : 'B', x.c ? 'c' : 'C', x.d ? 'd' : 'D', x.e ? 'e' : 'E', x.f ? 'f' : 'F', x.g ? 'g' : 'G')}>{rows.length}</a>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home }));
  assert.deepEqual(linksOf(map, '/home#Home'), [['{?}', lineOf(home, "leave('/login'"), [], []]]);
});

test('a ? : in the address a helper moves to keeps only the branch the arguments of the call lead to', async () => {
  const home = `import { useHistory } from 'react-router-dom';

function afterSave(history, isNew, id) {
  history.push(isNew ? '/start' : \`/team/\${id}\`);
}

export default function Home() {
  const history = useHistory();
  const open = (path, fallback) => history.push(path ? path : fallback);
  const goDoc = (doc, edit) => history.push({ pathname: edit ? doc.editUrl : doc.url });
  const leave = (to, back) => history.push(back ? '/home' : to);
  return (
    <nav>
      <a onClick={() => open('/start', '/login')}>a</a>
      <a onClick={() => goDoc({ url: '/help', editUrl: '/team/e' }, false)}>b</a>
      <a onClick={() => leave('/start', true)}>c</a>
      <a onClick={() => afterSave(history, false, 'a')}>d</a>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/home', at("back ? '/home'"), ['back'], ['/home#Home']],
    ['/start', at("open('/start'"), [], ['/start#Start']],
    ['/help', at('goDoc({'), [], ['/help/:page?#Help']],
    ['/team/a', at('afterSave(history, false'), [], ['/team/:team#Team']],
  ]);
});

test('a helper call that hands a member of a constant object into the address the helper builds is {?}, as an address function call with it is', async () => {
  const routes = `import { Route, Switch } from 'react-router-dom';
import Home from './Home';
import Team from './Team';
import Help from './Help';

export default function Routes() {
  return (
    <Switch>
      <Route path="/home" component={Home} exact />
      <Route path="/settings/general" component={Help} exact />
      <Route path="/settings/:tab" component={Team} />
    </Switch>
  );
}
`;
  const home = `import { useHistory } from 'react-router-dom';
import { openTab, openTabByPlus } from './nav';
import { TABS } from './tabs';

function openGeneral(history) {
  openTab(history, TABS.GENERAL);
}

export default function Home() {
  const history = useHistory();
  return (
    <nav>
      <a onClick={() => openTab(history, TABS.GENERAL)}>a</a>
      <a onClick={() => openTabByPlus(history, TABS.GENERAL)}>b</a>
      <a onClick={() => openGeneral(history)}>c</a>
    </nav>
  );
}
`;
  const nav = 'export function openTab(history, tab) {\n  history.push(`/settings/${tab}`);\n}\n\nexport function openTabByPlus(history, tab) {\n  history.push(\'/settings/\' + tab);\n}\n';
  const map = await build(writeApp({ 'Routes.js': routes, 'Home.js': home, 'nav.js': nav, 'tabs.js': `export const TABS = { GENERAL: 'general' };\n` }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['{?}', at('=> openTab(history'), [], []],
    ['{?}', at('openTabByPlus('), [], []],
    ['{?}', at('=> openGeneral(history)'), [], []],
  ]);
});

test('the decision record says that a call of a function that moves to an address or with a history it is given is a link at the call', () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
  const decisions = read('docs/decisions.md');
  assert.match(decisions, /\*\*A call of a function declared in the source that moves to an address it is given, or with a history it is given,\s+is a link at the call/);
  assert.doesNotMatch(decisions, /A history a\s+function is given as an argument is not read/);
  assert.doesNotMatch(decisions, /will need that inner reading exported/);
});

test('an address function whose body changes a value of its own through an index or a destructuring assignment stays {?}', async () => {
  const paths = `export function indexed(id) {
  const parts = ['team', 'me'];
  if (id) parts[1] = id;
  return '/' + parts.join('/');
}

export function destructured(opts) {
  let base = '/login';
  ({ base } = opts);
  return base;
}
`;
  const home = `import { Link } from 'react-router-dom';
import { destructured, indexed } from './paths';

export default function Home({ id, opts }) {
  return (
    <nav>
      <Link to={indexed(id)}>indexed</Link>
      <Link to={destructured(opts)}>destructured</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), [['{?}', at('indexed(id)')], ['{?}', at('destructured(opts)')]]);
});

test('an address function whose declaration, return or if test changes a value of its own stays {?}', async () => {
  const paths = `export function declared(tab) {
  const parts = ['', 'team'];
  const n = parts.push(tab);
  return parts.join('/');
}

export function returned(tab) {
  const parts = ['', 'team'];
  return parts.push(tab) && parts.join('/');
}

export function tested(tab) {
  const parts = ['', 'team'];
  if (parts.push(tab)) return parts.join('/');
  return '/home';
}

export function assigned(tab) {
  const o = { path: '/team' };
  const same = Object.assign(o, { path: \`/team/\${tab}\` });
  return o.path;
}

export function found(tabs) {
  let target = '/team';
  const on = tabs.find((t) => {
    target = \`/team/\${t.id}\`;
    return t.on;
  });
  return target;
}

export function conditioned(tab) {
  let url = '/team';
  if (tab && (url = \`/team/\${tab}\`)) return url;
  return url;
}

export function reassigned(tab) {
  const parts = ['', 'team'];
  let n = 0;
  n = parts.push(tab);
  return parts.join('/');
}

export const arrowed = (tab, parts = ['', 'team']) => parts.push(tab) && parts.join('/');
`;
  const home = `import { Link } from 'react-router-dom';
import { arrowed, assigned, conditioned, declared, found, reassigned, returned, tested } from './paths';

export default function Home({ tab, tabs }) {
  return (
    <nav>
      <Link to={declared(tab)}>declared</Link>
      <Link to={returned(tab)}>returned</Link>
      <Link to={tested(tab)}>tested</Link>
      <Link to={assigned(tab)}>assigned</Link>
      <Link to={found(tabs)}>found</Link>
      <Link to={conditioned(tab)}>conditioned</Link>
      <Link to={reassigned(tab)}>reassigned</Link>
      <Link to={arrowed(tab)}>arrowed</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), ['declared(tab)', 'returned(tab)', 'tested(tab)', 'assigned(tab)', 'found(tabs)', 'conditioned(tab)', 'reassigned(tab)', 'arrowed(tab)'].map((call) => ['{?}', at(call)]));
});

test('a property read with ?. on an argument left out or given as null is undefined, so a condition on it picks its branch', async () => {
  const paths = `export function helpUrl(options) {
  return options?.page ? \`/team/\${options.page}\` : '/help';
}

export function startUrl(options) {
  const team = options?.team;
  if (team) return '/team/' + team;
  return '/start';
}
`;
  const home = `import { Link } from 'react-router-dom';
import { helpUrl, startUrl } from './paths';

export default function Home() {
  return (
    <nav>
      <Link to={helpUrl()}>a</Link>
      <Link to={helpUrl(null)}>b</Link>
      <Link to={startUrl()}>c</Link>
      <Link to={helpUrl({ page: 'x' })}>d</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  assert.deepEqual(addressesAt(map, '/home#Home'), [['/help', 7], ['/help', 8], ['/start', 9], ['/team/x', 10]]);
});

test('an object argument with a spread duru cannot read leaves every key unknown that the spread may give, but a key written after the spread keeps its value', async () => {
  const paths = `export function docUrl({ edit }) {
  return edit ? '/login' : '/start';
}

export const entryUrl = (loc) => loc;

export function memberUrl(o) {
  if (!o.id) return '/login';
  return '/team/' + o.id;
}
`;
  const home = `import { Link } from 'react-router-dom';
import { docUrl, entryUrl, memberUrl } from './paths';

export default function Home({ member, next, ...props }) {
  return (
    <nav>
      <Link to={docUrl({ edit: false, ...props })}>a</Link>
      <Link to={entryUrl({ pathname: '/start', ...next })}>b</Link>
      <Link to={memberUrl({ ...member })}>c</Link>
      <Link to={docUrl({ ...props, edit: false })}>d</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'paths.js': paths }));
  const at = (part: string) => lineOf(home, part);
  assert.deepEqual(addressesAt(map, '/home#Home'), [
    ['/login', at('edit: false, ...props')],
    ['/start', at('edit: false, ...props')],
    ['{?}', at('entryUrl(')],
    ['/login', at('memberUrl(')],
    ['/team/{*}', at('memberUrl(')],
    ['/start', at('...props, edit: false')],
  ]);
});

test('a / an address function returns followed by a piece written from / gives {?} for that branch of a link, since the app would build //', async () => {
  const routes = `import { Route, Switch } from 'react-router-dom';
import Home from './Home';
import Team from './Team';
import Login from './Login';

export default function Routes() {
  return (
    <Switch>
      <Route path="/home" component={Home} exact />
      <Route path="/:team/channels/:channel" component={Login} />
      <Route path="/:team" component={Team} />
    </Switch>
  );
}
`;
  const teams = `export function relativeTeamUrl(state, teamId) {
  const team = state.teams[teamId];
  if (!team) {
    return '/';
  }
  return \`/\${team.name}\`;
}
`;
  const home = `import { useHistory } from 'react-router-dom';
import { relativeTeamUrl } from './teams';

export default function Home({ state, teamId, channel }) {
  const history = useHistory();
  return <a onClick={() => history.push(relativeTeamUrl(state, teamId) + '/channels/' + channel.name)}>channel</a>;
}
`;
  const map = await build(writeApp({ 'Routes.js': routes, 'Home.js': home, 'teams.js': teams }));
  const line = lineOf(home, 'relativeTeamUrl(state');
  assert.deepEqual(linksOf(map, '/home#Home'), [['{?}', line, [], []], ['/{*}/channels/{*}', line, [], ['/:team/channels/:channel#Login']]]);
});

test('an empty text an address function body puts in front of its address, by ? :, by a let it changes or by a const, makes that branch {?}', async () => {
  const routes = `import { Route, Switch } from 'react-router-dom';
import Home from './Home';
import Team from './Team';
import Login from './Login';

export default function Routes() {
  return (
    <Switch>
      <Route path="/home" component={Home} exact />
      <Route path="/:team/channels/:channel" component={Login} />
      <Route path="/:team" component={Team} />
    </Switch>
  );
}
`;
  const urls = `export function byTernary(team, channel) {
  return \`\${team ? \`/\${team.name}\` : ''}/channels/\${channel.name}\`;
}

export function byLet(team, channel) {
  let prefix = '';
  if (team) prefix = \`/\${team.name}\`;
  return \`\${prefix}/channels/\${channel.name}\`;
}

export function byConst(team, channel) {
  const prefix = team ? '/' + team.name : '';
  return prefix + '/channels/' + channel.name;
}

export function middle(team, channel) {
  return \`/\${team.name}\${channel ? '' : '/none'}/channels\`;
}
`;
  const home = `import { Link } from 'react-router-dom';
import { byConst, byLet, byTernary, middle } from './urls';

export default function Home({ team, channel }) {
  return (
    <nav>
      <Link to={byTernary(team, channel)}>a</Link>
      <Link to={byLet(team, channel)}>b</Link>
      <Link to={byConst(team, channel)}>c</Link>
      <Link to={middle(team, channel)}>d</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Routes.js': routes, 'Home.js': home, 'urls.js': urls }));
  const both = (line: number) => [['/{*}/channels/{*}', line, [], ['/:team/channels/:channel#Login']], ['{?}', line, [], []]];
  const links = linksOf(map, '/home#Home');
  for (const name of ['byTernary', 'byLet', 'byConst']) {
    const line = lineOf(home, `${name}(`);
    assert.deepEqual(links.filter((l) => l[1] === line).sort(), both(line).sort(), name);
  }
  const line = lineOf(home, 'middle(');
  assert.deepEqual(links.filter((l) => l[1] === line).map((l) => l[0]).sort(), ['/{*}/channels', '/{*}/none/channels']);
});

test('an address function call with a member of a constant object as its argument is {?} in a link, while a route path reads it whole', async () => {
  const routes = `import { Route, Switch } from 'react-router-dom';
import Home from './Home';
import Team from './Team';
import Help from './Help';
import { settingsPath } from './paths';
import { TABS } from './tabs';

export default function Routes() {
  return (
    <Switch>
      <Route path="/home" component={Home} exact />
      <Route path={settingsPath(TABS.GENERAL)} component={Help} exact />
      <Route path="/settings/:tab" component={Team} />
    </Switch>
  );
}
`;
  const home = `import { useHistory } from 'react-router-dom';
import { settingsPath } from './paths';
import { TABS } from './tabs';

export default function Home() {
  const history = useHistory();
  return <a onClick={() => history.push(settingsPath(TABS.GENERAL))}>general</a>;
}
`;
  const files = { 'Routes.js': routes, 'Home.js': home, 'tabs.js': `export const TABS = { GENERAL: 'general' };\n`, 'paths.js': 'export function settingsPath(tab) {\n  return `/settings/${tab}`;\n}\n' };
  const map = await build(writeApp(files));
  assert.equal(map.screens.find((s) => s.component === 'Help')!.path, '/settings/general');
  assert.deepEqual(linksOf(map, '/home#Home'), [['{?}', lineOf(home, 'history.push('), [], []]]);
});

test('an address function call that gives more than 8 different addresses inside a longer address is one {*} piece of it, as are two calls whose addresses together pass 8', async () => {
  const segments = (name: string, count: number) => `export function ${name}(kind) {\n${Array.from({ length: count - 1 }, (_, i) => `  if (kind === ${i}) return '${name}${i}';\n`).join('')}  return '${name}-last';\n}\n`;
  const home = `import { Link } from 'react-router-dom';
import { nine, three, other } from './segments';

export default function Home({ team, kind, mode }) {
  return (
    <nav>
      <Link to={\`/team/\${team}/\${nine(kind)}\`}>nine</Link>
      <Link to={\`/team/\${team}/\${three(kind)}/\${other(mode)}\`}>three by three</Link>
    </nav>
  );
}
`;
  const map = await build(writeApp({ 'Home.js': home, 'segments.js': segments('nine', 9) + segments('three', 3) + segments('other', 3) }));
  assert.deepEqual(linksOf(map, '/home#Home'), [
    ['/team/{*}/{*}', lineOf(home, 'nine(kind)'), [], ['/team/:team#Team']],
    ['/team/{*}/{*}/{*}', lineOf(home, 'three(kind)'), [], ['/team/:team#Team']],
  ]);
});
