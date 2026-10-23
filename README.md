# duru (두루)

*Every screen of your app, under every configuration.*

duru computes a screen map of a web client **from its source code** — not by crawling one running
instance or by watching production traffic. That lets it see what observation-based tools cannot:

- **Screens reachable only under certain settings.** Every link and route carries the condition that
  guards it (a feature flag, a system setting, a role), so a screen that only appears when a setting is on
  still shows up, labelled with that setting.
- **Dead screens.** Each screen's API calls are joined with the server's endpoint inventory. A screen
  whose backing endpoint does not exist on the server is reported as dead.
- **Server-side conditions.** Endpoint lists can carry a label (for example a build profile), so a call that
  only works in one build shows up as conditional rather than dead.

It is aimed at products installed per customer with many configurations, where there is no production
traffic to learn from and "every screen under any configuration" is exactly what QA needs to cover.

## Status

Early. The extractor handles a React Router client whose routes, API calls and settings reads follow
consistent patterns. API calls are nodes of their own next to screens. Playwright, JUnit XML and Vitest
JSON results attach to screens and calls through tags in their test names, and check scripts attach
through the verdict lines they print. A local review page lets a person mark gaps on screens and stories, and
a task list hands what was marked to a coding agent.

## Usage

```bash
npm install
npm run rebuild -- path/to/project-config.json   # map.json + tests.json
npm run extract -- path/to/project-config.json   # map.json only
node src/cli.ts review path/to/project-config.json [--port 4400]   # review page on 127.0.0.1, task list when it ends
node src/cli.ts tasks path/to/project-config.json > tasks.md        # task list for a coding agent
node src/cli.ts story path/to/project-config.json <story ID>   # one story for a coding agent: addresses, arrival lines, empty tests
node src/cli.ts reply path/to/project-config.json <comment ID> "<text>" [--server <review page address>]   # answer a comment
node src/cli.ts wait path/to/project-config.json --server <review page address>   # exits with the comments not yet answered
node src/cli.ts case path/to/project-config.json <kind> <screen or call ID> needed|not-needed [--note "<why>"] [--author <name> | --server <review page address>]   # decide a case kind for one screen or call
node src/cli.ts undecided path/to/project-config.json [<kind>] [--new]   # exits with 3 while a candidate of a case kind is undecided; with --new, only while one missing from baselineMap is
node src/cli.ts candidate path/to/project-config.json <comment ID> <candidate.json | -> [--server <review page address>]   # post a story candidate answering a comment on a screen order
npm test
```

Requires Node 22.18 or later (23.6 or later on Node 23), which runs duru's own TypeScript files without a flag. Run
duru from its clone, or link it (`npm link`, or `npm install <path to the clone>`): Node does not run TypeScript
files from inside `node_modules`, so a copy installed there, as from a packed `.tgz`, stops on its first `.ts` file.
A run over a large app can stop with `JavaScript heap out of memory`; run it again with a larger Node heap, such as
`NODE_OPTIONS=--max-old-space-size=4096 node src/cli.ts rebuild path/to/project-config.json`.

## Config

The project config lives **outside this repository** next to the target project's data. Paths in it are
relative to the config file, except the files inside the client source (`routesFile`, `routeTables`, `constants`,
`apiModules`, `calledApiModules`, `settingsDefaults`), which are relative to `srcRoot`. `test/fixtures/app` holds a small fake
client with example results and a config to start from.

### Client source

- `srcRoot` — the client source folder.
- `routesFile` — `routesFile` is one route file as text (`"Routes.js"`) or a list of them
  (`["Routes.js", "admin/Routes.js"]`) for an app that splits its routes over several files. duru reads exactly
  the files listed and does not follow imports to find more, so a route file left out of the list gives no
  screens. An empty list, an entry that is not text or a file listed twice stops the run with an error, and a
  listed file that is not there stops the map build with its name.
- `routeElements`, `routeConstant` — the elements that declare routes (`["Route"]`) and the object that holds
  the route paths (`"Option.ROUTE_PATH"`). A route with a `path` gives a screen when duru can read which component
  it draws. When duru sees a route that draws a screen it cannot read, it prints a `route not read` line saying why
  (see "What extract and rebuild print").
  `element={<Navigate to=… />}` is a redirect, not a screen. A route without `path` gives no screen.
  `routeConstant` and `constants` may be left out, or set to `null` (`routeConstant` also to `""`), for an app that
  has no table of its route paths. A `routeConstant` that is not a dotted name, or whose first name is not in
  `constants`, stops the run with an error.
- `routeTables` — route files that make one route for each item of a table (optional), such as mattermost's
  admin console, which draws one route per settings page:

  ```json
  "routeTables": [{
    "route": "components/admin_console/admin_console.tsx",
    "table": { "file": "components/admin_console/admin_definition.tsx", "const": "AdminDefinition" },
    "items": "*.subsections.*"
  }]
  ```

  `route` is a file listed in `routesFile`, `table` the file and the top-level `const` that hold the table, and
  `items` the keys from that const to each item, with `*` for every key at that place. The items give screens
  whose sources hold the components each item names, with the path of the screen that draws the route file in
  front. The conditions written in an item are not read. Without the
  entry, such a route gives a `route not read` line whose reason starts with `made for each item of a list`. An entry of another shape, one naming a file not in `routesFile`, or a route file
  named twice stops the run with an error, as does an entry whose route file has no such route or more than one,
  whose table const is not there, or none of whose items has the field the route reads.
- `redirectElements` — the elements that redirect in the route files (default `Redirect` and
  `Navigate`; a config that lists them uses exactly the names listed).
- `entryPaths` — route paths of further screens users start from when the code does not show them.
- `history` — a history the app makes itself and moves through, such as mattermost's `getHistory().push(…)`
  (optional): `{ "import": "utils/browser_history", "name": "getHistory" }`. `import` is the module as the app
  imports it, resolved like an import in the source, and `name` what that module exports, a function that returns
  the history or the history itself. Its `push` and `replace` calls become links. A key of another shape, an
  `import` that names no file under `srcRoot` or a `name` that file does not export stops the run with an error
  naming the key. Without it, a file that makes a history with `createBrowserHistory` or `createHashHistory` gets a
  `history is not set` line (see "What extract and rebuild print").
- `tsconfig` — the tsconfig file that declares the app's import aliases (optional), such as
  `"client/tsconfig.json"`, relative to the config file like `srcRoot`. Name the file that holds `paths`, itself
  or through `extends`: in a project whose `tsconfig.json` only lists `references`, that is the referenced file,
  such as `"client/tsconfig.app.json"`. Without it an import such as `@domains/user/Form` is taken for an outside
  package and the screen's sources stop at that import. Aliases are read from this file only; there is no config
  key for writing them by hand. A tsconfig that cannot be used (missing, not JSON, a broken `extends`, no
  `paths`) stops the command with an error that names the file and what is wrong.
- `constants`, `constantStubs` — modules run for route paths, API endpoint definitions and settings defaults,
  and stand-in source for imports they cannot run. `constants` is optional unless `routeConstant` or a settings
  default names one of its modules, and when it is there it must be an object of file paths, or the run stops with
  an error. A module's value is what it exports by default, or, without a
  default export, an object of its named exports. A module and every file it imports, `.ts` files included, are
  run as written, so a value a function builds is read like a literal one. An import that finds no file gets an
  empty stand-in; when the extraction stops on one with a file and line, give that import a `constantStubs`
  entry, the source text of a stand-in module, keyed by the package name or by the relative import as written
  (`"./gone"`). Point `constants` at the smallest module that builds the value, not at one that sets up the whole
  app. When the value is built by a function that the module never calls, needs arguments or reads browser
  globals, write a small module beside the duru config that calls the function, and list it with a path relative
  to `srcRoot`:

  ```ts
  // duru/defaults.ts, listed as "Defaults": "../../duru/defaults.ts"
  import { createSettings } from '../client/src/store/createSettings';

  export default createSettings();
  ```

- `apiModules`, `passThroughCalls` — where API functions live and which wrappers pass a URL through. Both may be left
  out; leaving out `apiModules` is the same as `[]`, for an app whose API code is read through `calledApiModules`
  or sits in the screens. An `apiModules` that is not a list of paths from `srcRoot` stops the run with an error.
- `calledApiModules`, `requestFunction` — for API code whose methods find their address somewhere else, such as in a
  table or through a prefix added when the request is sent. `calledApiModules` lists the files that export the API
  objects, API functions or API classes. `requestFunction` names the function the app sends its requests through:
  `import` and `name` as the API code imports it, and `method` and `url`, the place of each among the values that
  function is given, written as the position of the value counted from 0 followed by the keys inside it. An `import`
  starting with `.` is a path from `srcRoot`. duru runs the listed files with that function replaced by a recorder,
  calls every exported function, every method of every exported object and every static method of every exported
  class once with fake values, and puts the method and address of each request on the map as that function's or
  method's call, with the prefix the app adds. A piece of an address that comes from a fake value is written `{?}`.
  Requests the listed files send with the global `fetch` are recorded too, so API code that sends only through
  `fetch` lists its files in `calledApiModules` and leaves `requestFunction` out. So are the requests a method sends
  by moving the browser (a link it makes and clicks, `window.open`, an address given to `location`), each as a
  `GET`. Outside packages that `constantStubs` does not give are filled with values that do nothing. A call stopped
  after one second counts as failed. Two listed files exporting different objects under one name, or a name
  `apiModules` already has, get the file path in front of the name. On into-sign 2.0.0:

  ```json
  "calledApiModules": ["domains/user/api/index.ts", "domains/document/api/index.ts", "domains/signing/api/index.ts"],
  "requestFunction": {
    "import": "@domains/_shared/api/axiosInstance",
    "name": "executeRequest",
    "method": "0.endpoint.method",
    "url": "0.url"
  }
  ```

  where `domains/user/api/index.ts` is `export const userApi = new UserApi(executeRequest);` and the methods call
  `this.executeRequest({ endpoint, url, body })`.

  When the API code sends its requests through a request object such as axios, write `"object": true` in place
  of `method` and `url`. When the object is made by a package's `create`, `import` and `name` give that package,
  as below. For API code that does

  ```ts
  // api/http.ts
  export const http = axios.create({ baseURL: '/api/v2' });
  // api/index.ts
  export const invoiceApi = { list: () => http.get('/invoices'), remove: (id) => http.delete(`/invoices/${id}`) };
  ```

  write `"calledApiModules": ["api/index.ts"]` and

  ```json
  "requestFunction": { "import": "axios", "name": "default", "object": true }
  ```

  to get `GET /api/v2/invoices` and `DELETE /api/v2/invoices/{?}`.

  A request a screen sends from its own source, with no API file in between, is read from the source without
  running it: a call of the global `fetch`, of axios, or of the function or object `requestFunction` names, in a
  file the screen reaches. `requestFunction` alone is enough for this, without `calledApiModules`. Such a request
  is a call of the screen, marked `"direct": true` among its `apiCalls`, with how it is sent (`fetch`,
  `axios.post`, `<form action>`) where an API function's name would be, and it joins `calls` by its method and
  address like the calls of API functions. A piece of the address that the source takes from a value is written
  `{?}`. A form that posts is read the same way. Any other move of the browser written in a screen source is a
  call only when the config shows that its path goes to the server: the server list holds the path, or the path
  starts with one of `app.apiPaths`. An address on another host is read only when that host is `app.server`.

  In an app that uses redux-saga, a request a saga sends is a call of each screen that dispatches an action the
  saga waits for, among the sagas the app runs with a `createSagaMiddleware()` result. No key turns this on. The
  requests are those of the API functions and of `requestFunction` that the saga reaches, as a screen's are.

  A request sent by a method of a store the screens get from a React context hook, such as a MobX store from
  `useStores()`, is a call of the screens that call that method. duru reads which method is called from the
  TypeScript types of the source, with the options of `tsconfig` when the config names one. A screen that gets the
  store only from the hook gets those calls too, though the store files are not in its `sourceFiles` and their
  setting reads and links are not on the screen.
- `sourcePackages` — packages of the same repository whose source duru reads like the app's own (optional),
  each package name with its source folder as a path from the config file. An import of a package that is not
  listed here runs as a value that does nothing, as an outside package does. For a client whose API class lives in
  a workspace package:

  ```json
  "sourcePackages": { "@mattermost/client": "webapp/platform/client/src" }
  ```

- `bodyArgKeys` — properties of a call argument that hold the request body (optional), such as `data` in
  `ajaxExport({ data: { withHistory } })`. With `tsconfig`, `calledApiModules` and `body` in `requestFunction` (the
  place of the body among the values the request function is given, such as `"body": "0.body"`), duru also reads
  the TypeScript type of the value a called method gives under one of these keys, such as
  `this.request({ operation: 'update', body })`. Its true/false fields become on/off options of the calls the
  method sent with a body, named by their path in the body, with `[]` for a list (`signers[].notify`).
- `bodyOptions` — on/off keys to add to a call's request body, per call ID (optional), as
  `{ "POST:/api/v1/report/export": ["withHistory"] }`, for a body the source does not show.
- `bodyTypeExclusions` — on/off fields read from the body type to leave out of a call's options, per call ID
  (optional), as `{ "POST:/api/v1/documents": ["enabledPkiSign", "signers[].required"] }` with the field paths as
  the map names them, for a field no screen lets the user change.
- `settingsRoots` — identifiers through which settings are read.
- `settingsDefaults` — where the default values of a settings root are written (optional), as
  `{ "globalSettings": { "file": "store/settings.js", "const": "defaults" } }`: the object literal that a
  top-level `const` of that name holds. When a function builds the defaults, write
  `{ "constant": "Settings.appSettings" }` instead: a name in `constants`, alone or followed by a dotted path into
  its value. The root must also be listed in `settingsRoots`.
- `settingsFunctions` — functions whose returned object holds settings (optional), such as
  `readSystemSettings({ SIGN_LIST: [] })`. Each entry is `{ "import", "name", "root", "section" }`: `import` and
  `name` as the app imports the function (`"default"` for a default export; an `import` starting with `.` is a
  path from `srcRoot`), and `root` and `section`, the `settingsRoots` entry and the key under it whose settings
  the function returns. What screens read from the returned object is on the map as settings under that key, and
  the object passed to the function gives their defaults, next to the ones `settingsDefaults` gives. On into-sign
  2.0.0:

  ```json
  "settingsFunctions": [
    { "import": "@config/settings/readSystemSettings", "name": "readSystemSettings", "root": "settings", "section": "SYSTEM" }
  ]
  ```

- `roleIdentifiers` — where the user's role is read (optional): an identifier (`memberRole`) or one member of an
  object (`workspace['member.role']`).
- `roleGuards` — the roles that pass a role guard (optional), keyed by the guard as the map writes it, such as
  `{ "menuPolicy.canAccessAdminRoutes": ["member:ADMINISTRATOR", "member:WORKSPACE_ADMINISTRATOR"] }`. Use it
  for a guard whose roles the source does not show where it is written. The roles listed replace what duru reads
  for that guard everywhere it appears, and they are compared as written, so give the kind of role before the
  name when two kinds share a name, and list every role guard of a screen once you list one of them.
- `moves` — screen moves the code shows no link for (optional), each `{ "from", "to", "reason" }` with route
  paths as in the map, such as `[{ "from": "/signin", "to": "/user-home", "reason": "로그인 뒤" }]` for an app
  that reloads after sign-in and lets a redirect choose the screen. Story steps and the review page's flow use them
  like links.
- `callLinks` — calls whose on/off options change what another call gives back (optional), each
  `{ "from", "to", "note" }` with two call IDs as in the map, such as an export option that only shows in the
  file a download call delivers.

### Server and tests

- `serverEndpoints`, `apiPathPrefix` — one or more server endpoint lists (`<label>\t<METHOD>\t<path>` per line,
  `{var}` for path variables). Without them no call is compared with the server and no screen is dead.
- `tests` — test results to attach, each `{ "format": <playwright|junit|vitest|verdict>, "path": <file or folder>, "depth": <ui|api|render|code|data|output> }`.
  A folder is searched for `.json` files (Playwright, Vitest), `.xml` files (JUnit) or `.txt` and `.log` files
  (verdict).
- `caseKinds` — kinds of test case the source cannot show, such as input limits or data from an older version
  (optional), each name mapped to the description the review page shows for it:
  `{ "boundary": "입력 경계: 빈 값, 최대 길이, 특수 문자", "legacy": "옛 데이터: 이전 버전에서 만든 문서" }`. A kind
  that needs a test for each of a few values is written `{ "text": <description>, "values": [<value>, …] }`, such as
  `"ended": { "text": "끝난 문서", "values": ["cancelled", "rejected", "completed", "expired"] }`, and each value is
  then a case of its own. A name or a value starts with a letter followed by letters, digits, `.`, `_` or `-`, a
  description is one line, and `values` lists at least one value, each once. The page and the task list keep this
  order. A kind written as an object can also carry `picks`, a list of rules that pick its screens or calls, such as
  `"ended": { "text": "끝난 문서", "values": ["cancelled", "rejected"], "picks": [{ "screen": "/participant/**",
  "methods": ["POST", "PUT", "PATCH", "DELETE"] }] }`. A rule writes one or more of `screen` (a pattern of the screen
  path as in the map), `methods` (a list of request methods in capitals) and `api` (a pattern of the request path as
  in the map), and picks only what every key it writes matches. In a pattern, `*` stands for one whole part between
  `/`s and `**` for any number of parts, none included. A rule with `screen` alone picks screens; a rule with
  `methods` or `api` picks the calls that the screens its `screen` matches send, or any call when it has no `screen`.
  A kind is a case of a screen or call where one of its rules picks it or a reviewer picks it on the review page; a
  rule's pick is taken out only by a mark that names the rule (see **Marks**).

### Output and review

- `outDir` — where `map.json` and `tests.json` are written (default: the config's folder).
- `marksDir`, `judgmentsDir` — where the review page keeps marks and judgments on test pairs (default: `marks`
  and `judgments` in `outDir`).
- `author` — the name marks and judgments are signed with (optional; default `git config user.name` in the
  config's folder, else the computer's user name). Leave it out of a config file a team shares.
- `storiesDir` — folder of story files, or a single story file (default: `stories` in `outDir`). The review page
  writes the visits recorded on it into `records/` there.
- `visitRecords` — visit record files or folders that story candidates are made from (optional), as
  `["qa/records"]`; duru's Cypress recorder writes such a folder (see **Story candidates**). Playwright reports in
  `tests` whose tests left a trace give candidates too.
- `baselineMap` — the `map.json` of an earlier version of the same client (optional), such as the map kept from
  the last release. `rebuild` and the review page then show what changed since it. Build it with the same duru as
  the current map: a map from another duru can differ for reasons in duru rather than in the client, and one from a
  duru that did not record the roles a route guard lets through is refused.
- `baselineTests` — the test results of an earlier version of the same client (optional), written like `tests`,
  such as `[{ "format": "playwright", "path": "releases/1.5.0/e2e.json", "depth": "ui" }]`. `rebuild` then compares
  them with the current results and prints the tests that passed there and fail or are pending now (see **What
  extract and rebuild print**), and the review page marks them (see **Review page**). It works with or without `baselineMap`. An empty list compares nothing and prints no
  line about it. To keep the results of a release, run the whole suite on that version and copy its result files
  straight into that version's folder, such as `releases/1.5.0/`; copy JUnit XML and verdict logs with their modified
  time kept (`cp -p`), since that is the time duru takes for when they ran. In a git checkout, where that time is
  the checkout's, such a file unchanged since its last commit takes the author date of that commit when it is earlier. Keeping the results of a run of only some
  of the tests leaves the rest out of the comparison: those under a screen or call now count as `only now`. Tests of the two results are matched by their title without
  tags, their Playwright project and their test file, so a test renamed or moved to another file counts once in
  `only in baseline` and once in `only now`.
- `appUrl` — address of a running instance of the app; the review page links each screen without path
  variables to it.
- `app` — what the review page needs to show the app itself, logged in, in a frame (optional; replaces the
  `appUrl` link):

  ```json
  "app": {
    "files": "../client/build",
    "server": "http://localhost:8080",
    "apiPaths": ["/api/"],
    "login": {
      "path": "/auth/login",
      "body": { "loginId": "{id}", "password": "{password}" },
      "token": "result.accessToken",
      "storage": { "key": "auth", "value": { "accessToken": "{token}" } },
      "header": { "Authorization": "Bearer {token}" }
    },
    "account": { "id": "duru-reviewer", "passwordEnv": "DURU_REVIEWER_PASSWORD" },
    "roles": {
      "ADMIN": { "id": "duru-admin", "passwordEnv": "DURU_ADMIN_PASSWORD" }
    },
    "signedOutPaths": ["/signin"],
    "pathValues": {
      "/document/:tab(draft|done)": { "tab": "draft" },
      "/document/:id": { "id": { "api": "/api/v1/documents", "list": "contents.list", "value": "id" } }
    },
    "settingsFile": { "path": "/settings.js", "global": "window.INTO_SETTINGS", "root": "globalSettings", "merged": ["SYSTEM", "CUSTOM"] }
  }
  ```

  `files` is the app's build folder (relative to the config file) or the address it is deployed at; requests
  whose path starts with one of `apiPaths` go to `server`. When the review starts, duru posts `login.body` to
  `server` + `login.path` with `{id}` and `{password}` filled in, reads the token at the dotted `login.token`
  path of the reply, and stores `login.storage.value` under `login.storage.key` in the app's localStorage. The
  password is read from the environment variable named by `account.passwordEnv` and never written anywhere.
  Give duru an account of its own: an app that allows one login per account logs out whoever else uses it.

  `roles` gives an account per role, keyed by the role as the map writes it: the value the app compares the role
  with (`"ADMIN"` for `memberRole === 'ADMIN'`), or the role as written in `roleGuards` (`"member:ADMINISTRATOR"`)
  for a guard listed there; `account` stays the account for screens without a role condition.
  `signedOutPaths` lists route paths to show signed out, such as a sign-in screen.

  `pathValues` fills the path variables of a screen, keyed by its route path as in the map. Each variable takes a
  fixed value or a list API: duru calls `server` + `api` (with `method` and a JSON `body` when it is not GET),
  finds the list at the dotted `list` path of the reply and takes the dotted `value` path of its first item; a
  list API is called with the token in `login.header`. A variable can also take an API that issues the value,
  such as a one-time code an outside service opens a screen with:
  `{ "api": "/api/v2/one-time-code/create", "method": "POST", "header": { "X-API-KEY": "{key}" }, "keyEnv": "APP_API_KEY", "body": { … }, "value": "contents.code" }`.
  It is sent with only `header`, `{key}` filled from the environment variable named by `keyEnv`, and called again
  every time the screen opens. A key that starts with `?` fills a query parameter instead of a path variable
  (`"?token"` gives `?token=<value>`), and `{documentId}` in the `body` of an issuing API is replaced with the
  value of that path variable of the same route.

  `settingsFile` is the static settings file the app downloads, which duru rewrites to show a screen under other
  settings without touching the test server: `path` is where the app requests it, `global` the object the file
  assigns, `root` the `settingsRoots` entry it feeds (it needs a `settingsDefaults` entry too), and `merged` the
  top-level sections the app merges one level deep over its defaults. Only settings in a `merged` section can be
  changed; changes last until the review ends and are never sent to the server. `story` reads the same file, without
  logging in, to say whether each setting a story needs is already met; a file at a web address that does not answer
  in 10 seconds counts as not read.

## The map

`extract` writes `map.json`; `rebuild` writes it and `tests.json`.

**Code state.** `meta` names the commit of the git repository `srcRoot` is in (`commit`, `unknown` when `srcRoot` is
not in one), whether a file under `srcRoot` had changes not committed then (`uncommitted`, only with a commit; the folders duru
writes, `outDir`, `marksDir`, `judgmentsDir` and `storiesDir`, do not count), and the
duru that built the map (`duruVersion`, and `duruCommit` when duru runs from a git checkout of its own). duru reads the
files as they are, changes not committed included. Each screen and call has `codeHash`, a hash of the code it was read
from: the screen's `sourceFiles`, and for a call the files its requests are written in. `tests.json` has
`testFileHashes`, a hash of each test file found under `srcRoot`, by its path there.

**Screens.** Each screen has an ID made of its route path and component name (`/document/:id#DocumentDetail`),
usable as a test tag. The pattern a path variable carries is left out of the ID, so `/document/:tab(draft|done)`
gives `/document/:tab#DocumentList`; the screen's path keeps it. It lists its route file and line, its component
file, its `sourceFiles`, the API calls it reaches, the settings it reads, and its links to other screens with the
conditions guarding them. A screen made from an item of a table in `routeTables` also has `tableItem`: the item's
keys joined with `.`, the table file and the item's line. The settings come from every file in `sourceFiles`. The
API calls and links are only those the screen's code reaches, so a file in `sourceFiles` can hold calls and links
the screen does not list, and a call sent by a method of a store the screen gets from a React context hook can be
written in a file outside them; each call and link names the file and line where it is written. A call or link a
saga makes for the screen names the line in the saga and lists under `actions` each action type that leads to it,
with the places the screen dispatches that type (`dispatchedAt`).
A layout with a side menu around a group of routes gives its calls, settings reads and links to every screen
inside it.

**Links.** A screen's links come from the route constants written in its code, the `to` of react-router's `Link`,
`NavLink`, `Redirect` and `Navigate` outside the route files, the addresses given to `push` and `replace` of a
history react-router hands to the screen or of the one named in `history`, and the addresses given to the function
`useNavigate()` returns. A link can also sit on the line of a call of a function in the source that moves the
history, with the address that call leads to. Each link has its address `to`, with `{*}` for a piece that comes from a value, the file
and line, the conditions guarding it, and `targets`, the IDs of the screens it goes to. A link whose address duru
cannot read has `to` `{?}` and empty `targets`. In an app that uses redux-saga, a route constant or a move of the
history named in `history` written in a saga is a link of each screen that dispatches an action the saga waits for,
with the action types under `actions`; a move in a saga whose address duru cannot read is not on the map, not even
as `{?}`.

**Calls.** Each API call is a node under `calls` with an ID `<METHOD>:<path>`
(`GET:/api/v1/document/{documentId}`), its server match, the API functions that make it, the screens that reach
it, and the on/off `options` of its request body. The server match is one of:

- `match` — on the server, with the endpoint list labels
- `method-mismatch` — the server has the path with another method
- `none` — not on the server; a screen that reaches such a call is `dead: true`
- `unresolved` — the URL cannot be worked out from the source, so there is no call node. Its `reason` says what
  stood in the way:
  - `not-written` — no address is written where the request is sent: it is given to the function, or there is none
  - `imported-piece` — a piece of the address is what a function imported by name returns, or a name imported from
    another file whose value duru could not read in the file that declares it
  - `unknown-piece` — a piece whose value is not known stands in front of the address or inside its text, such as
    a base address that could not be read, or the current page a relative address hangs on
  - `other-host` — the address is on a host other than `app.server`, or on any host when `app.server` is not given
  - `no-path` — the address has no path
- `unchecked` — there is no server endpoint list (`serverNotCompared: true` on the map). Call IDs then use the
  client's URL with `{0}`, `{1}` for path variables, and may change once a server list is added.

**Access.** Each screen's `access` says whether it opens only under a setting or a role: `restricted`, the
`kinds` (`setting`, `role`), the blocking route guards, the links into it, `roleValues` (the role values that
can open it, or `null` when they cannot be read) and the setting values it needs. A restricted screen with empty
`kinds` is one whose links ask for different kinds. Entry screens are listed under `entries` with their reasons:
the target of a redirect in the route files, a screen no link leads to, or `entryPaths`. A screen is open when an
entry screen reaches it without a setting or role guard on the way.

**Settings defaults.** The evaluated `settingsDefaults` are on the map, with `settingsDefaultsIncomplete`
listing the places whose value the source does not show in full.

### What extract and rebuild print

- `screens N | api functions N | endpoints match N method-mismatch N none N unresolved N unchecked N` — the
  screens and the server match of the calls. The API functions include the functions and methods
  `calledApiModules` called.
- `api call <name> ← <file>:<line>: address not read (<reason>)` — a screen calls the API function at that
  place, and an address it sends to could not be worked out; `<reason>` is the `reason` of its `unresolved`
  server match, and `, only <text>` follows when a part of the address was read. The call stays on the screen
  and is in no call. A function called from several places has a line for each.
- `api method <name> ← <file>:<line>: <error>` — a called function or method that gave no address, where it is
  declared and the first line of what stopped it (`did not finish within 1000 ms` for one stopped after a
  second). Its calls are missing from the map. A method that sends no request is not printed.
- `calledApiModules <file> did not run: <file>:<line>: <error>` — a listed file that failed to run, so none of
  its functions or methods are on the map.
- `calledApiModules <file> recorded no request; without requestFunction only requests sent with fetch or by moving the browser are recorded`
  — with `requestFunction` left out, a listed file none of whose methods sent a request with `fetch` or by moving
  the browser. Its API code may send through a function or object that `requestFunction` should name, or its
  methods may have stopped on the fake values (`silentApiModules`). When no listed file sends one, the run stops
  with an error that also gives the cause for each listed file that did not run.
- `requests and navigations written in screen sources N | address not read N` — the requests and the moves of
  the browser read from the sources of the screens and of the sagas that send for them, and how many of them gave
  no address. Printed when there is one.
- `request <how> ← <file>:<line>: address not read (<reason>)` — a request in a screen source whose address could
  not be worked out, with the `reason` of its `unresolved` server match; `, only <text>` follows when a part of
  it was read. The request stays on the screen without an address and is in no call (`unreadRequests`, each
  with its `reason`). A `not-written` line inside a function of the app that its other requests go through means
  the address comes from the callers: name that function in `requestFunction`. An `other-host` line has the
  address in full after `only`: when that host is the app's server, give it in `app.server`.
- `redux-saga runs from <file>:<line> | watchers N | requests of sagas on screens N | links of sagas on screens N` —
  where the app runs its sagas, how many pairs of an action type and the saga code waiting for it those runs
  reach, and how many requests and links written in sagas come to a screen through an action it dispatches
  (`sagas` on the map). Printed when a source file names redux-saga.
- `redux-saga is imported, but no run of a createSagaMiddleware() result was found, so no request or link of a saga is put on a screen`
  — the sources name redux-saga, but duru found no `run` of a saga middleware, so no saga request or link is on
  the map.
- `calledApiModules ran <import> as a stand-in, though it is <path> outside srcRoot, imported by <files>` — an
  import the listed files reach that duru ran as a value doing nothing, although it is a file or folder of the
  repository outside `srcRoot`, reached through a tsconfig alias or a workspace link under `node_modules`. What it
  holds is missing from the map; name its folder in `sourcePackages` to read it (`outsideStandIns`).
- `body type <name>: <field> goes with <other field>, so it is not taken as an on/off option` — a true/false body
  field left out because it picks among more than two values with that other field. The other `body type <name>:`
  lines name what duru could not read, so those on/off options are missing from the map: `the body is typed
  <type>, …` or `the body field <path> is typed <type>, …`, a body or a field of it whose type gives no field
  names, such as `Record<string, unknown>` or `any`; `it sent a body, but no <key> was found …`, a method whose
  body is not written in an object it gives to a call, such as one put in a variable first; and `no function was
  found at <file>:<line>` (`bodyTypeNotices`).
- `bodyTypeExclusions <call ID> leaves out <field>` — a field read from the body type that the config takes out
  of that call's options (`leftOutBodyTypeFields`).
- `bodyTypeExclusions <call ID> <field> stays an option, given by <where>` — a field the config names that is
  still an option of that call, with where it comes from: `the source`, `bodyOptions`, or both joined by `and`. The
  entry can come out of the config (`keptBodyTypeExclusions`).
- `component file not found for <id> ← <route file>:<line>` — the screen holds only what the components
  wrapping its route bring. For a screen made from a table item, `, table item <key> at <file>:<line>` follows.
- `history is not set; <file> calls createBrowserHistory, and moves through the history it makes are not read as
  links` — a file that makes a history (`createHashHistory` likewise) while the config has no `history` key, so
  the `push` and `replace` calls on it are not links on the map. Name it in `history` (`madeHistories`).
- `route path not read ← <route file>:<line>: stopped at <piece>` — a route whose path duru could not read in full.
  `<piece>` is the first part of the path whose value it could not read, as written where duru stopped: in the
  route file, or, followed by `in <file>:<line>`, in another file when duru followed a name into that file. When the
  path is a call of a function that gives two or more different paths, `<piece>` is that call and
  `, which gives <paths>` follows: the paths, or `more than 8 paths`. `, only <text>` follows when a part of the
  path was read, with `{?}` for the rest. The screen is on the map with that path and an ID made from it; when the
  ID itself holds `{?}`, it changes once that part can be read (`unreadRoutePaths`).
- `route not read ← <route file>:<line>: <reason>` — printed when duru sees a route that draws a screen it cannot
  read, with the reason. For an item of a table in `routeTables`, the reason starts with `table item <key> at
  <file>:<line>` and goes on with `has no <field>`, or with `: its <field> stopped at <piece>` when its value could
  not be read in full, `<piece>` written as for `route path not read`.
  That screen is missing from the map and has no ID, so no test can be tagged with it; look at the route at that
  line to see which screen it draws (`unreadRoutes`).
- `settingsFunctions <file>:<line> <what>` — about calls in the files the route files lead to by import: a call
  that duru does not read as settings; a default the function is given that differs from the `settingsDefaults`
  value (the map keeps that value), or that differs from another call's or cannot be compared with it (the map
  leaves the default unknown); and a function called in none of those files (`settingsCallNotices`).
- An alias import that finds no file, with the number of files that write it (`unresolvedAliasImports`).
- Routes that end up with the same ID, each place as `file:line`, the table item's place for a screen made from a
  table item (`duplicateIds`).
- `bodyOptions` call IDs that are not on the map (`unknownBodyOptionCalls`), `bodyTypeExclusions` call IDs that are
  not on the map and fields that are not an on/off option read from that call's body type
  (`unknownBodyTypeExclusions`), `moves` paths that match no route
  (`unknownMovePaths`), `callLinks` call IDs that are not on the map (`unknownCallLinks`) and `roleGuards`
  guards that guard no route or link with a role (`unknownRoleGuards`).
- `changes since <file> | screens new N removed N condition N calls-changed N | calls new N removed N server N` —
  printed by `rebuild` when the config names `baselineMap`: the screens the baseline does not have, the ones it has
  that are gone, the screens on both whose role or setting conditions differ, the screens on both that send calls
  they did not or no longer send the ones they did, and the same for calls, with the calls whose server match
  differs. A `baselineMap` that is missing, unreadable or not such a map stops `rebuild` with a line naming the file,
  before anything is written.
- `test results since <folder> | compared N | pass→fail N pass→pending N | not on a screen or call now N | only in baseline N | only now N` —
  printed by `rebuild` when the config names `baselineTests`, after the `changes since` line when there is one.
  `<folder>` is the nearest folder holding every `baselineTests` path, from the config's folder. Each count takes a
  test once, however many screens and calls it is on. `compared`: the tests under a screen or call now that a
  baseline test matches, whether a tag, an import, a trace or a reviewer's hand-over puts them there; a pair a
  reviewer discarded does not. `pass→fail` and `pass→pending`: those that passed in the baseline and now fail, or now
  did not run or gave no verdict; a `pass→pending` test may have been skipped because a test before it in a `serial`
  group, or a `setup` project it depends on, failed. `not on a screen or call now`: baseline tests that match a
  current test which is on no screen or call now, such as an untagged test, one only under a story, one whose tags
  name only screens or calls the map does not have, or one whose pairs a reviewer all discarded. When
  `not on a screen or call now` is large, those tests could not be compared because nothing links them to a screen
  or call now; a browser test linked only by its trace, for one, is not linked when it was skipped and left no
  trace. `only in baseline`: baseline tests no current test matches.
  `only now`: tests under a screen or call now that no baseline test matches; they are not regressions.
  `compared`, `not on a screen or call now` and `only in baseline` add up to the tests of the baseline.
- `  no test was compared: no baseline test matches a test under a screen or call now` — follows when `compared` is 0,
  so that no regression is not read as nothing broken.
- `  pass→fail ← <test file>:<line> <title> (<project>) — screen <id>, call <id>, …` — one line for each test that
  passed in the baseline and fails now, and `  pass→pending ← …` for each that is pending now, naming every screen
  and call the test is on. `:<line>` is left out when the result gives no line (JUnit), and `(<project>)` when the
  test has no Playwright project.
- `  only in baseline ← <file>: N tests, none of this file's tests are in the current results` — a test file of the
  baseline with no test in the current results: it no longer loads, or the current run left it out. `<file>` is its
  path in the baseline results, from the folder holding all of their test files when the paths are absolute.
- A `baselineTests` path that is missing, a result file that cannot be read, or an entry that gives no test stops
  `rebuild` with `baselineTests <path> could not be read: <why>`, before anything is written, and `review` with the
  same line and exit code 1, before the page is served. Files of another format
  in a folder, and verdict logs with no verdict line, are skipped as in `tests`.
- `case kind <kind>: rules pick N screens, N calls` — printed by `rebuild` for each kind in `caseKinds` with
  `picks`: how many screens and calls its rules pick on this map. With `baselineMap`, `| new since <file> N` follows:
  how many of them the same rules did not pick on the baseline map.
- `caseKinds <kind> picks[<i>] matches no screen|call: <rule>` — a rule of that kind, counted from 0 and shown as
  written, that picks nothing on this map.
- `case kind <kind>: undecided N | cases with no tests N` — printed by `rebuild` for each kind in `caseKinds`, after
  the tests are read: how many of its candidates are undecided (see **Task list**), and how many cases of the
  screens and calls it is picked for no test carries yet, a case for each value of a kind with values. When an
  agent's `not-needed` waits for a reviewer on any of its candidates (see **Case kinds tab**), `| under review N`
  follows with how many. With `baselineMap`, the undecided count is followed by `, M of them new since <file>`: how
  many of those undecided candidates are screens or calls the baseline map does not have. When the marks cannot be read, `  case kinds not counted: <why>` takes the place of these
  lines.
- `rebuild` also prints the story and candidate counts, how many of the candidates came from traces, how many it
  newly stored in `candidates/`, and the files skipped, the need files in `needs/`, how many conditions pick a need
  file that is not there and each need file it could not read with why, the links from untagged tests to screens and the trace or test files it could not read, the judged test
  pairs, and each judgment file it could not read or whose screen is gone from the map.

## Tests

A test declares the node it covers with `@screen:<id>` or `@call:<id>`. For Playwright, put the tags in the test's
`tag` option (`test('opens help', { tag: ['@screen:/help#Help'] }, …)`) and leave the title as it is; a tag in
the title or a `describe` title is read too, which is where the tags go before Playwright 1.42, the version that
added the `tag` option. For JUnit, put them in the test's or the test class's
`@DisplayName`, since `@Tag` does not reach the result XML. For Vitest or Jest, put them at the end of the test
title; a `describe` title or Vitest's `tags` option is read too. A test takes the depth of its result source unless it
carries `@depth:<ui|api|render|code|data|output>`. `output` is for a test that checks the content of what the app
produces, such as an exported file.

A test of a call that sets on/off options of its request body declares each with `@option:<key>=true|false`
(`@call:POST:/api/v1/report/export @option:withHistory=true`). A test that walks a whole story declares it with
`@story:<story ID>`; it may carry node tags too and then counts for each.

A test of a screen that opens only under a role or a setting declares the case it checks next to its `@screen:`
tag. Each role that opens the screen is a case, `@role:<role>` with the role as the map writes it (`@role:ADMIN`,
`@role:member:ADMINISTRATOR`). `@role:other` is the case where a role that does not open the screen is kept out;
the tag does not say which role, so put it in the test's title. Each setting condition is two cases:
`@setting:<path>=true` for a test that meets the condition, so the screen opens, and `=false` for one that does
not. The path is the setting's path as the map writes it, without its root; for a condition that a list holds a
value or that a setting equals a value, the value follows a colon
(`@setting:SYSTEM.MAIN_MENU.ADMIN_SETTING.LIST:ADMIN_MEMBER=false`). `=true` means the condition is met, also when
the condition is that a setting is off. A test with both tags counts for each case. A role or setting tag that is
not a case of a screen the test is tagged with is listed with the tags that point at nothing on the map.

A test of a kind from `caseKinds` declares it with `@case:<kind>` (`@screen:/home#Home @case:boundary`), and a test
of a kind with values declares the value it checks with `@case:<kind>=<value>`
(`@call:POST:/api/v1/sign @case:ended=cancelled`). It counts for that kind or value on every screen and call the
test is tagged with, and shows under that case wherever a reviewer has picked the kind. A tag without a value on a
kind with values, with a value the kind does not list, or with a value on a kind without values counts for no case
and is listed with the tags that point at nothing on the map.

`tests.json` lists the tests per node and per story with depth, status (pass, fail, pending; skipped and todo
count as pending) and `tags`, every tag read for the test, without the `@`. It also lists the tags that point at
nothing on the map, and the tests with no tag as `untagged`. An untagged Playwright test carries the projects it ran
in as `projects`, each with the worst status of the test's runs in it. `traced`
lists each Playwright test that passed, with the trace of its passing run, as its report, its title, its file and
line, and the screens it passed in order; an address no screen matches stays in that list as its path. A story test whose passing run left a trace
carries the same order as `screens`.

Two kinds of untagged tests are shown next to a screen without counting as its tests. A unit test (Vitest or
Jest JSON) is listed under `importers` when its test file imports one of the screen's source files; a file that
more than three screens share does not link. A Playwright test whose report holds traces (Playwright's `trace`
option) is listed under `passed` for each screen it opened and each call it sent, as `visit`, `interact`,
`assert` or `call`.

A check script that is not a test framework reports through verdict lines in its output, one test per line;
other lines are ignored:

```
VERDICT empty form save: FIXED — saving an empty form shows a message @screen:/document/:id#DocumentDetail
```

The name runs up to the first `: `. The word after it decides the status: `UPHOLDS`, `FIXED`, `HEALTHY` pass;
`REPRODUCES`, `VIOLATE`, `VIOLATES`, `REGRESSED`, `BROKEN` fail; any other word is pending. The text after `— `
(an em dash) is kept as the detail. Tags go at the end of the line.

## Stories

A story is something a user gets done, written as the screens they pass through in order. Stories are kept in
`storiesDir`, one JSON file per story, so a story nobody has tested yet is still listed. The file name without
`.json` is the story ID, made of lowercase letters, digits, `-` and `_`.

```json
{
  "name": "로그인해 문서 목록에서 문서를 연다",
  "screens": ["/signin#SignIn", "/home#Home", "/document/:tab#DocumentList", "/document/:id#DocumentDetail"],
  "memo": "문서를 처음 여는 사람이 가장 자주 지나는 길이다.",
  "author": "Kim Min",
  "date": "2026-10-02"
}
```

- `name` — what the user gets done, in one short sentence
- `screens` — the screen IDs of the steps, first step first, one entry per screen the user lands on, so the same
  screen never comes twice in a row
- `memo` (optional) — a free note on the story that fits none of the other keys; what has to hold before the story
  starts goes in `needs`
- `author`, `date` — who wrote the story and when (`2026-10-02`)
- `source` (optional) — for a story accepted from a candidate, the visit record and its steps
  (`{ "record", "steps" }`), or the Playwright report and the titles of its tests that passed those screens
  (`{ "report", "tests" }`)
- `needs` (optional) — a list of things that have to hold before the story starts, each a text or a need file
  picked as `{ "use": "<file name>" }` (see below)
- `expects` (optional) — a list of texts, each a thing that should hold once the last step is done

A step of `screens` that has its own needs or expected results is written as an object instead of the screen ID:
`{ "screen": "<screen ID>", "needs": [...], "linkNeeds": [...], "inputs": [...], "expects": [...] }`, where `screen`
is required and the others are optional. `needs` and `linkNeeds` are lists of texts or picked need files, as the
story's own `needs` is, and `expects` is a list of texts. `linkNeeds` holds what has to hold on the link from the
step before for the story to come into this step, such as 「반려된 경우」 when the same two screens are joined in more
than one case; the first step has no link coming into it, so it cannot have `linkNeeds`. A step without any of them
stays a screen ID.

`inputs` lists the boxes to fill at that step, each as `{ "box": { ... }, "value": "<what to type>" }`. `box` finds
the box by what the screen shows: `placeholder` (the hint text inside the box), `label` (its label) or `testId` (its
test ID). Write the words as they read on the screen, not a translation key; give one or more of the three, all
on the same box. The review page finds the box by any one of them, so it still finds a box when one word changes, but
the code `duru story` writes for an input needs a box that has every word written. When more than one element has
all those words, such as one memo box per signer, `nth` says which one, counting from 1 in the order of the page.
`value` is the text to put in. duru does not look for the box in the code, so the page and the task list mark each
input as not checked.

```json
{
  "name": "로그인해 문서 목록에서 문서를 연다",
  "needs": [{ "use": "member-account.json" }, "완료된 문서가 하나 있다"],
  "screens": [
    { "screen": "/signin#SignIn", "inputs": [
      { "box": { "placeholder": "이메일", "testId": "login-email" }, "value": "member@example.com" },
      { "box": { "placeholder": "비밀번호" }, "value": "test1234" }
    ] },
    "/home#Home",
    { "screen": "/document/:tab#DocumentList", "needs": ["「완료」 탭을 고른다"] },
    { "screen": "/document/:id#DocumentDetail", "linkNeeds": ["상태가 「완료」인 줄을 누른 경우"], "expects": ["문서 제목과 서명자 목록이 보인다"] }
  ],
  "expects": ["열람 기록에 이 문서가 한 줄 늘어난다"],
  "memo": "",
  "author": "Kim Min",
  "date": "2026-10-02"
}
```

duru does not check these lines against the code: the review page shows them and the task list carries them to
whoever writes the story's test.

What several stories need alike, such as an account to sign in with or data that has to be there, is kept once in
the `needs` folder inside `storiesDir`, one JSON file per need, with a `name` and a `text` and nothing else:

```json
{ "name": "일반 회원 계정", "text": "역할 USER 로 가입한 계정. 이메일 member@example.com, 비밀번호 test1234" }
```

Its file name follows the story ID rule, and a condition, at the top of the story or in a step, picks it by its path
under `needs/`, as `{ "use": "member-account.json" }` for `needs/member-account.json`, so its `name` can change
without breaking the stories that pick it. The files in `needs/` are not read as stories. A condition
that picks a file that is not there, or one that could not be read, does not stop the story from being read: the
condition alone shows as 「needs/… 없음」 or 「needs/… 읽지 못함」. A need file that breaks these rules is skipped and
noted with its path and why.

No other keys are allowed, at the top or in a step object. A file that breaks these rules is skipped and noted with its
path and why.

Each story is checked against the map. Between two neighbouring steps the link is `open` when a map link without
a condition joins them, `conditioned` when every such link has a condition, `configured` when only a move in
`moves` joins them, `broken` when nothing does, and `unknown` when the first screen has links duru cannot read the
address of. A story with a screen the map does not have is detached. 「사전 조건」 gathers what it takes to get to
the end: what the first screen needs and the conditions on the way.

A story also gets a status from its tests: fail when a test tagged `@story:<its ID>` fails, pending when none
fails and one is pending, pass when all pass. When all pass but the traces of its Playwright story tests show that
none of them opened its screens one after another, it is `part-pass`, and each link says how many story tests went
across it. Whether they went through is not known, and the story stays `pass`, when a story test has no trace (a
test that is not a Playwright test never has one), its trace holds no screen on the map (also when the test opened
no page at all), or a screen of the story is not on the map. Without story tests
it is `partial` when a screen on its path has a test, and `untested` when none has.

Where the map has no link between two steps but passing tests went straight across, the link says how
many: the config's `moves` may be missing that move.

## Story candidates

A test that walks through the app can leave a visit record: a JSON file holding a list of steps, or an object
with the list in `steps`, each step with the `url` it was at. A step may also carry `inputs`, the values typed there
in the shape a story step's `inputs` has, and `skipped`, how many inputs were left out; other keys are ignored.

```json
{
  "steps": [
    { "action": "open", "url": "http://localhost:3000/home" },
    { "action": "open drafts", "url": "/document/draft?page=2" }
  ]
}
```

duru turns each record named in `visitRecords`, and each file in `records/` in `storiesDir`, into a story candidate:
each address goes to the screen whose route path matches it, steps in a row on the same screen become one step, and
an address no screen matches stays as it is. The inputs of the steps of one screen step are joined, a later value for
the same box taking the place of the earlier one, and the counts in `skipped` are added up. A candidate with the screen order of a story or of a discarded candidate is not offered. A record that
cannot be read is skipped and noted with its path and why.

A Cypress suite writes these records with the recorder duru ships, added by one line in its support file
(`cypress/support/e2e.js`):

```js
import 'duru/recorders/cypress.js';
```

`duru` resolves once duru is installed in the Cypress project with `npm install <path to the clone>`; without that,
import the file by its path in the clone. Each test that passes writes `cypress/visits/<spec>/<titles>.json`, where
`<spec>` is the spec's path in the project and `<titles>` the titles of its `describe` blocks and its own joined by
` -- `, without the words starting with `@` and cut at 200 bytes. Its steps are the addresses the app was at without
their query or what follows `#`, one for each change, also when the app changed the address with
`history.pushState` without loading a page; addresses the spec's own `afterEach` opens are steps too. A test that
passes again replaces its file, and a test passed on a retry writes the attempt that passed. A test that fails or
opens no page writes nothing and leaves the file an earlier run wrote, so delete the folder before a run whose
records should be the only ones. Name another folder, relative to the Cypress project, with `duruVisitRecords` under
`expose` in the Cypress config, or under `env` before Cypress 16. List the folder in `visitRecords`, as
`["../e2e/cypress/visits"]`.

A Playwright test needs no visit record when its report is listed in `tests` and the test ran with Playwright's
`trace` option on: the screens it passed through, read from its trace by `rebuild`, become a candidate whose source
names the report and the test titles. The candidate is named after the first of those titles without its tags. Only a passing run counts: a test that failed gives no candidate, and a test
that passed on a retry gives the screens of the retry that passed. The steps of such a candidate may come with the values the test typed in, shown before the candidate is accepted and
written into the story file with it; a line on the page says how many inputs were not carried over. These candidates
follow the limits of reading traces:

- Only trace format version 8 is read. A trace of another version is skipped and listed with the traces
  `rebuild` could not read.
- Only the path of an address is matched to a screen, and what follows `#` is dropped. An app that changes screens
  by the part after `#`, or a modal or tab that opens without changing the address, does not show as a step.

On the review page a candidate is accepted, which writes a story file into `storiesDir`, or discarded with a
reason, which writes a file into `discarded/` in `storiesDir` so the same order does not come back. Undoing an
acceptance deletes that story file, and the candidate is listed again; if `candidates/` has no file for its screen
order yet, one is written first, under the story's ID, so it comes back even once its record is gone. Undoing a
discard writes another file into `discarded/`, `{ "screens", "kind": "undo", "author", "date" }`, with no reason, and
leaves the discard as it is: the latest file of a screen order in `discarded/` is its state, so the order is offered
again until it is discarded again. If `candidates/` has no file for that order, one is written first under the name
the discard kept.

`rebuild` keeps each candidate as a file in `candidates/` in `storiesDir`, one for each screen order that has no
file there yet, holding the name, the screens, the source and the date it was first seen. Files are only added,
never deleted, and changed only where the review page keeps the lines switched off on a candidate from a comment;
keep the folder in git with the stories. If a file cannot be written, `rebuild` stops
storing and prints why under the candidate line. The candidates listed are these files together with what the
records and traces give now, and for a screen order in both, what they give now is shown. So a candidate stays
after a `rebuild` whose results have no traces, or once its record is gone. An accepted or discarded candidate keeps
its file, and the story or the discarded file keeps it out of the list. When a screen of a stored candidate has left the map, the candidate stays
listed with that step shown as a screen the map does not have. A candidate file that cannot be read is skipped and
noted with its path and why.

**Candidates from a comment.** A coding agent that answers a comment on a screen order (see **Comments on a screen
order**) posts the story it found with `candidate <config> <comment ID> <candidate.json>`, or `-` in place of the
file to read it from standard input. The candidate is a JSON object with `name` and `screens`, each step a screen ID
or an object with `screen` and any of `needs`, `linkNeeds`, `inputs` and `expects`, as in a story file. A screen the
agent put in carries `reason`, one line saying why it is there:

```json
{
  "name": "로그인해 실험을 연다",
  "screens": [
    "/signin#SignIn",
    { "screen": "/home#Home", "reason": "로그인하면 홈으로만 갑니다 (components/SignIn.js:12)" },
    { "screen": "/lab#Lab", "expects": ["실험 목록이 보인다"] }
  ]
}
```

It is written into `candidates/` in `storiesDir` with its source, `{ "comment": <comment ID>, "added": [{ "step",
"reason" }, …], "written": [{ "step", <field>: [ … ] }, …] }`: the steps the agent put in with their reasons and the
lines the agent wrote, numbered by the steps of the candidate. The lines of each step, the reviewer's and the
agent's, are in `stepFields`. The lines of `written` switched off on the review page are kept in the same file as
`offLines`, `[{ "step", "field", "line" }, …]`, each naming its step, its field and its place in that field from 1. A
story accepted from it gets the reviewer's lines and the agent's lines still on, and keeps that source with only
those lines in `written`. With
`--server` and the address the review printed, the running review writes the file and every open page lists the
candidate at once; without it, the file is written directly. The command prints `wrote <file>`, then one line for
each link between two steps, `step 1 → 2: from <screen> to <screen> — <verdict>`, worded as in the task list. A
candidate it does not take is not written: the command prints why on standard error and exits with code 1. A map
built before links carried their conditions must be rebuilt first. A wrong call exits with 2.

## Review page

`review` serves a local page that reads `map.json` and `tests.json` from `outDir` (run `rebuild` first) and writes
only marks, judgments, story files and the visits recorded on it. The page keeps the place being looked at in its address, so the back
button, a reload and a copied address work.

**Flow.** The page opens on the flow: one line per screen, in columns by how many links or moves they are from an
entry screen, with a square for the status of its tagged tests, the number of its API calls, and 「역할」 or 「설정」 when
it opens only under a role or a setting; hovering shows what it needs and its untagged tests. A dashed line is a
link under a setting or role condition, and a green dotted line is a move written in `moves`, whose reason shows on
hovering the screen it leads to. The flow follows a move as it follows a link: a screen not yet drawn goes under the
screen the move leaves, and one already drawn in another branch stays where it is. Entry screens with no screen
drawn under them are gathered below the rest under
「딸린 화면이 없는 진입 화면 N」, whose hover says why they are there. The bar above counts the drawn screens by status on buttons
(「테스트 없음 4」, 「실패 5」 …); pressing one fades the other screens, and the search box does the same by route or
component. With nothing picked, the right column lists the failing screens and then the ones without a tagged
test. Pressing a screen keeps strong only the paths through it, marks the screens its links and moves reach in other
branches, and shows the list view's middle and right panes for it beside the drawing; 「선택 해제」, Escape or a click
on an empty spot of the drawing lets it go. The zoom control at the bottom-left corner of the drawing fits, shrinks
or grows it; a percent typed into it takes effect on Enter or on clicking elsewhere, a level below 30% or above 150%
becomes the nearer end, and Escape or anything not a number puts the level back.

**Story tab.** The third tab at the top, 「스토리」, shows one story at a time. The left column lists the stories, the
candidates and the need files. In the middle, the chosen story's steps are drawn left to right on one line that stays
at the top while the rest scrolls: each step is a box with its step number, its screen and the colour of its test
status, and a step not on the map is drawn dashed. The line between two steps shows how they are joined: solid for a
link with no condition, blue dashed for a link under a condition, green dotted for a move written in `moves`, red
dashed with 「링크 없음」 where the map has no link, and orange dotted where a step is not on the map or a link's address
could not be read; the 「i」 above the line shows these. Pressing a box outlines it and that step's card, scrolling the
cards only when that card is out of view; pressing the line between two steps brings that link's row into view. The
outline stays on the pressed step while the cards scroll, and a line wider than the pane slides sideways to keep it in
view. Below the line are the story's cards: its name with its link verdict beside it, a folded 「사전 조건 N」, a folded
「손볼 화면 N」 listing the failing and untested screens on its path, each bringing up its step card, the name and memo
with 「저장」, the 「스토리 전체」 box, its tests, then each step and the link into it. The right column holds the
story's conversation, as for a screen. The address of a story is `#story?story=<ID>`,
with `&step=<N>` added while step N is outlined, so opening that address, going back to it or reloading it outlines
the same step and brings its card into view. Pressing another step changes the address without adding to the browser
history.

**A new story.** 「새 스토리」 is made in the story tab only. The flow tab's bar has a 「새 스토리」 button (「새 스토리 이어
쓰기」 once it has steps) that moves to the story tab's new-story screen, and `#flow?new=1` and `#stories?new=1` open
the same screen. The left column lists the screens, and the middle shows the verdict beside the title, a folded
「사전 조건 N」, and ID, name and memo with 「스토리 저장」 above the steps chosen so far and the whole flow. The right column
shows 「에이전트와 대화」 on the screen order chosen so far, and its form carries that order as the tag 「화면 순서 /signin →
/home」, which follows each step added or taken out (see **Comments on a screen order**); before the first step the form
is greyed out, with a line saying the order chosen becomes its tag.
Pressing a screen in the list or a box in the drawing adds that screen as the next step, and the drawing scrolls to
keep the box pressed in place where it can.
Each chosen box carries its step number. Two neighbouring steps are joined in the style of their verdict: on the link
itself when the second box hangs under the first, otherwise by a mark in each of the two boxes with the other step's
number. Pressing a step shows 「이전 단계 추가」 above it, 「다음 단계 추가」 below it and 「제외」 on it, as in 「순서
고치기」; a step is moved by taking it out and adding it again. The same screen twice in a row is refused as in the
list; a box already chosen is added again, since a story can pass a screen twice. 「스토리 목록」 closes the screen and
keeps the steps for 「새 스토리 이어 쓰기」. In the flow tab a box opens its screen. The filters, the search and the
picked screen of the flow tab are left as they were and do not change the drawing in the new-story screen.

**Recording a walk through the app.** When `app` is set, the title row of 「새 스토리」 has 「● 기록」. It opens the app in
the middle column in place of the drawing, and the screens the app passes through stack up as steps in the left column
in place of the screen list, after the steps chosen before, under the verdict and a folded 「사전 조건 N」 of the steps
so far. While the app is open the ID, name and memo are put away, and 「기록 끝」 shows them again as they were typed.
Each address change is read, an address on the same screen as the step before joins that step, and an address no
screen matches becomes a step marked 「맵에 없는 화면」. A value typed into a box found by its placeholder, label or test
ID is kept on its step; a password, a select, a checkbox or a box with none of these is only counted. The bar above
the app chooses the account it is open as: the default account, each role in `app.roles`, or signed out when
`app.signedOutPaths` is set. Choosing another one keeps the addresses so far as one record and starts a new one.
「기록 끝」 writes the record into `records/` in `storiesDir` as
`{ "steps": [{ "url": "/home" }, { "url": "/signin", "inputs": [...], "skipped": 1 }] }`, with the path, the query and
what follows `#` and no host or port, in a file named by the date and a random ID (`2026-10-15-1a2b3c4d.json`) that is
never changed or deleted; keep the folder in git with the stories. The record is listed as a candidate even if the
page is closed before saving. 「기록 끝」 also draws the steps on one line as a story's
steps are drawn; 「전체 그림에서 보기」 shows them on the whole flow, where pressing a box adds a step, and 「한 줄로
보기」 goes back. If no address came, as when the app's Content Security Policy blocks inline scripts, the page says so
and writes no record. A window the app opens with `window.open` is not
recorded. With only `appUrl` set, the page says that recording needs `app`.

The pencil on 「스토리 전체」 and on each step opens a table for the conditions, the inputs and the expected results,
written like those of a saved story and saved into the story file with it; 「닫기」 closes the table and keeps what was
written. A recorded value is changed there like any other input.

**List.** The left column lists screens with filters for no tests, dead screens, screens that open only under a
setting or a role, and screens with only untagged tests. With `app` set, the middle shows the chosen screen's app
in a frame, already logged in, with a role picker, boxes for path values and a line for the settings the screen's
conditions name, which can be turned on and off. 「앱 너비」 above the frame sets the width the app is drawn at:
1280 at first, 375, 768, 1024 or 1440, 「직접 입력」 for a width from 200 to 3840 typed into the box beside it, or
「칸에 맞춤」 for the pane's own width. 「배율」 beside it sets how large that width is shown. At 「칸에 맞춤」, the
first choice, a pane narrower than the width shows the app smaller to fit, and a wider pane shows it at its real
size. 25%, 50%, 75%, 100%, 150%, or a percent from 10 to 200 typed after 「직접 입력」, shows it at that size
whatever the pane's width; when that is wider than the pane, the frame scrolls sideways while the page itself stays
put. A typed value takes effect on Enter or on clicking elsewhere, and one outside its range goes back to the value
before. With the width at 「칸에 맞춤」 the app is always at its real size and 「배율」 cannot be picked. The words
beside the pickers say what is shown: 「1280px 화면을 58%로 줄여서 보여 줍니다」,
「1280px 화면을 실제 크기로 보여 줍니다」, 「1280px 화면을 150%로 키워서 보여 줍니다」 or 「칸 너비 그대로 745px」,
followed by 「칸을 넘는 부분은 옆으로 넘겨 봅니다」 when the frame scrolls sideways. Dragging the frame's bottom
corner makes it taller or shorter, and the app
gets the height shown divided by the percent. The width and percent picked stay, in both views, until the page is
reloaded. Below come the
screen's tests by depth and its API calls, with
a row per option value. A screen that opens only under a role or a setting carries 「역할」 or 「설정」 next to its
name, as its line in the flow does. Under the tables, 「화면 정보」 starts folded, with the number of links into the
screen, links out of it and settings it reads on its line. Opened, it says under 「접근 조건」 what it takes to open
the screen, then shows the tests of each role and setting case by depth under 「관점별 테스트」, the links into it
with their guards, the conditions inside the screen, where its route and component are, the links out of it and the
settings it reads. The links into it and out of it also list the moves written in `moves` as 「설정에 적은 이동」 with their
reason. Once opened it stays open on other screens until it is closed. Choosing a call, by its name or a count in
the table or from a link elsewhere, opens its details under the call table and scrolls the middle pane to them: where
its option was found, the server match, its tests, untagged tests linked to it, where this screen calls it and the
screens that use it.
With `caseKinds` set, 「관점별 테스트」 has a button per kind for every screen, and for a call in its details: pressing one
makes the kind a case there, with its tests by depth, and pressing it again takes it out. Each press is listed under
「전체」's 「변경 기록」, not in the conversation of the screen or call. A picked kind with values
has a row per value under it, with that value's tests by depth and result, or 「테스트 없음」. Next to each picked
kind a chip says who picked it: 「규칙」 when a rule in `picks` did, with the rule shown on hover, or the name of the
person or agent who did, with the date on hover and, when a rule picks it too, the rule. A kind a rule picks starts
out picked, and while it is picked, whoever picked it, its row has 「이 요청은 규칙에서 빼기…」 (「이 화면은 규칙에서 빼기…」 on a screen);
that and pressing its button both open a dialog that saves only with a reason. The kind then shows as 「대상 아님 ·
<author>」 with the date and the rule on hover and the reason on the line below, and pressing its button again picks
it back in that person's name. A kind marked 「대상 아님」 with a reason on a screen or call no rule picks, as `case` writes
it, shows the same row, with the date on hover; one pressed off with no reason shows no such row. Each kind
still undecided on that screen or call (see **Task list**) has its own lines under the others: the kind, and below it
「「미판정」 아직 아무도 정하지 않았습니다」, with 「신규」 after 「미판정」 for a screen or call the baseline map does not have (see
**Case kinds tab**), and two icon buttons: ✓ saves 「대상」 at once, and ✕ asks for a reason, as 「대상 아님…」 does, and
saves nothing without one. Hovering over them, or a screen reader, gives 「대상 — 이 요청에서 이 경우를 시험합니다」 and
「대상 아님… — 이유를 적고 이 요청에서는 시험하지 않습니다」 (「화면」 for a screen). Where a mark, a person's or an agent's,
keeps the kind undecided, the line says who left it instead of 「아직 아무도 정하지 않았습니다」, in the words of the
「테스트 관점」 tab: 「<author> 가 <date> 에 이유 없이 뺐습니다」 for a kind pressed off, or 「… 에 규칙에서 뺐지만 규칙이 더는
고르지 않습니다」 with the old reason for a kind taken out of a rule that no longer picks that screen or call. Only where
the kind no longer takes that screen or call as a candidate at all does a kind taken out of a rule keep its 「대상
아님」 row, which then says 「규칙이 이 요청을 더는 고르지 않아, 이 표시는 쓰이지 않습니다」. A kind an agent marked 「대상 아님」
with `case` waits for a reviewer and has its own lines too: the kind, and below it 「검토 중」 with ✓ and ✕, the agent with
the date, and the agent's reason. Hovering over them, or a screen reader, gives 「받아들이기 — 에이전트의 이유로 이 요청을 「대상
아님」으로 둡니다」 and 「되돌리기 — 에이전트의 「대상 아님」을 지우고 그 전의 판정으로 돌아갑니다」 (「화면」 for a screen). Until then the kind
stays as it was before the agent's mark, so one a rule picks stays picked with its tests. ✓ makes it 「대상 아님 ·
<reviewer>」 with the agent's reason; ✕ puts back the mark a person left before the agent's, or, with none, leaves it
to the rule or undecided, its 「미판정」 line then saying 「<reviewer> 가 <date> 에 에이전트 판정을 되돌렸습니다」. Pressing the kind
button, 「이 요청은 규칙에서 빼기…」 or ✓ ✕ of a 「미판정」 line instead saves the reviewer's own mark, which also ends the wait.
The kind buttons below stay as they are. The flow shows the same middle and right panes for a picked screen.

**Case kinds tab.** With `caseKinds` set, the list has a third tab, 「테스트 관점 N」, after 「화면」 and 「태그 없음」; N adds
up the undecided candidates of every kind and those waiting for a reviewer, and is 0 when none is left. Hovering
over it gives the two apart, 「미판정 U · 검토 중 R」. When the three do not fit on one line, as in a
narrow list with three-digit counts, 「테스트 관점 N」 moves to a second line. The tab lists the kinds in config order, each
with its text, `case:<kind>` and 「대상 N · 미판정 N · 빈칸 N」, where 빈칸 is the number of cases with no tests that
`rebuild` prints, and 「검토 중 N」 before 「미판정」 while any wait for a reviewer. With `baselineMap`, 「(신규 M)」 follows
「미판정 N」 while M of the undecided candidates are screens or calls the baseline map does not have; the tab's own number
stays the same. A chosen kind shows four numbers:
「대상」 with how many a rule, a person and an agent (`duru case`) picked, 「대상 아님」, 「미판정」 and 「시험 없는 값 칸」, and
「검토 중」 too while any wait; 「미판정」 has 「신규 M」 under it while M of them are new to the baseline map. A screen or call a rule picks and a person or agent then marked
「대상」 counts as theirs, so the rule's number can be smaller than what the rule picks. Under them each rule has a line
with what it picks, how many it picks and how many of those were taken out as 「대상 아님」, and 「아무것도 고르지 못함」
when it picks nothing; a kind without rules says every screen and call is a candidate. Pressing a rule's line shows
only what it picks in the 「대상」 list, until 「모두 보기」 or the line is pressed again. 「대상 N」 and 「대상 아님 N」 start
folded and stay as they were left when the page is drawn again; 「대상 아님」 shows who, when and why. Above 「미판정 N」,
「검토 중 N」 lists, open and in the same three groups, the candidates on which an agent's 「대상 아님」 waits for a
reviewer: each line has 「검토 중」, the chip of what holds until then (「규칙」 or the name of whoever picked it), the
agent with the date and the agent's reason. These count only here, not under 「미판정」. Check boxes on the lines, on
the group titles and its own 「모두 고르기」 choose them; once one is chosen, 「✓ N」 accepts and 「✕ N」 reverts them all,
with 「받아들이기」 and 「되돌리기」 on hover, as ✓ and ✕ of 「관점별 테스트」 do. One the agent wrote again after the page read
it is not saved, and the line under the buttons says which were saved and which were not. 「미판정 N」 lists the
undecided candidates in three groups, 「쓰기 요청」 (a request whose method was not read among them), 「조회 요청」 and
「화면」, leaving out an empty group; each request carries its method in colour (GET blue, POST green, PUT orange, PATCH
teal, DELETE red). A candidate kept undecided by a person's mark has a line under it: 「<author> 가 <date> 에 이유 없이
뺐습니다」, or 「… 에 규칙에서 뺐지만 규칙이 더는 고르지 않습니다」 with the old reason. These are the ones `duru case`
leaves to a person; a button above the list with a person icon and their number, 「직접 판정」 on hover, shows only
them. With `baselineMap`, each candidate the baseline map does not have carries 「신규」 in the colour of the screen
list's 「신규」, with 「<folder> 지도에 없던 요청입니다」 (or 「화면」) on hover and for a screen reader, and 「신규 M」 beside
the person button shows only those. Pressing either button again, or choosing another kind, shows every candidate.
A check box on each line, on each group title and 「모두 고르기」 choose candidates; once one of the lines shown is
chosen, 「대상 (N)」 or 「대상 아님… (N)」 shows and decides the chosen ones among the lines shown, each with its own
mark, while one chosen and then hidden by a button stays chosen and is not saved; 「대상 아님…」 asks for one reason and saves nothing without one. The marks are saved one by one; if
one fails, saving stops, a line says which were saved and which were not, and those not saved stay checked. While saving, the other tabs and
views are locked. Pressing a line shows that screen or call's conversation and comment form on the right, kept apart
from the one chosen in 「화면」; a comment left unsaved there is asked about at 「리뷰 끝」. Pressing the name opens the
screen, or the call on the screen that sends it. The address is `#cases?kind=<kind>&node=<ID>`; an unknown kind
goes to 「화면」. A kind decided here is listed under 「전체」's 「변경 기록」, where 「대상」 reads 켬 and 「대상 아님」 reads 끔, and
a reviewer's answer to an agent's 「대상 아님」 reads 받아들임 or 되돌림.

**Pane widths.** The edge on either side of the middle pane, in the list, in the story tab and beside a picked screen
in the flow, can be dragged to widen or narrow the panes; the line lights up when the
mouse rests on it. The drawing is laid out again for its new width, and the app in the middle pane is shown at the
percent that fits the pane's new width
when 「배율」 is 「칸에 맞춤」 (with the width at 「칸에 맞춤」, the app itself gets the new width). No pane can be dragged narrower than its contents need, and when the window gets too narrow
for the middle pane, the side panes give back the width they were dragged to. The widths last until the page is
loaded again.

**Changes since a baseline.** With `baselineMap` set, the header names the baseline by its folder, with the map's path on
hover (「비교 기준」). A screen in the list carries 「신규」 (one the baseline does not have), 「조건 바뀜」 (the conditions before and after on hover) or
「호출 +N −N」, and 「바뀐 화면만」 in the box 「<folder> 와 비교」 keeps only those. Below the list come the screens only the
baseline has, and how many screens changed their role or setting conditions and how many calls their server match.
A changed screen opens with a line saying what changed; its call table has a column 「<folder> 와 비교」 with 「생김」 or
「서버 대조 바뀜 (before → after)」, and the calls it no longer sends are listed struck through with 「없어짐」. A
`baselineMap` that cannot be read stops `review` before the page is served.

**Regressions since a baseline's test results.** With `baselineTests` set, the 「비교 기준」 box in the header names the
baseline by its last folder, such as 「1.5.0」 (the whole path on hover), and 「결과 N」, how many result files it has;
hovering 「결과 N」 lists them with the time each run started. With `baselineMap` as well, the box shows both. A test
row that passed in the baseline and fails or is pending now carries 「통과→실패」 or 「통과→보류」 when the row itself
fails or is pending, under the tags of a screen or call and under 「불러오는 테스트」, 「지나간 테스트」,
「호출한 테스트」 and 「태그 대기」 alike; hovering it names the baseline folder and the result file the test was
compared with. In the screen list a screen carries 「회귀 N」, the regressed tests tagged on it, importing its source,
waiting for its tag, or that pressed, typed or checked something on it by their trace. Hovering splits N into
failing and pending and says how many regressions of tests that only passed through the screen were not counted:
those show on their rows when the screen is opened, not in the list. A regressed test tagged only on calls puts a
dashed 「호출 회귀 N」 on each screen that sends one of those calls, apart from 「회귀 N」, naming the calls on hover; a
screen whose 「회귀 N」 already counts the test does not count it again. 「회귀만 N」 in the box 「<folder> 와 비교」
keeps the screens with either; checked with 「바뀐 화면만」, only screens that are both stay, and the 「신규」 and
「조건 바뀜」 marks show in the same list. Without `baselineMap` it is the box's only filter, and the box and the
column below take the `baselineTests` folder's name. The call table has the column 「<folder> 와 비교」 with
「회귀 N」 for a call whose tagged, importing or handed-over tests regressed; a test that only sent the call by its
trace is not counted. A test only in the baseline whose tags name a screen or call on the map is listed, folded, under
「기준에만 N」 in that screen or call, and below the screen list 「기준에만 N」 lists every test only in the baseline,
folded by test file, with 「파일 없음」 on a file none of whose tests are in the current results. Those rows take no
comment: to have a deleted test written again, mark the screen 「테스트 필요」. The counts are those of the
`test results since` line `rebuild` prints for the same results; the page compares on each load with the pairs as
judged then, and keeps nothing.

**Code state.** The header follows the map's date with its commit (「커밋 <first 7 characters>」, 「커밋 모름」 when
`srcRoot` is not in a git repository), 「+ 커밋 안 한 수정」 when files under `srcRoot` had changes not committed, and
the duru version; hovering shows the commits in full, duru's own among them. The 「비교 기준」 box shows the same for the baseline
map. A map built by a duru that did not record them shows none. After a `rebuild`, a mark whose screen or call
code hash differs from the one saved with it shows 「코드 바뀜」 beside its status in the screen list and
the tables, and so does a judged pair, under 「제외한 짝」 or 「태그 대기」 and in the 「태그 없음」 tab, when the hash of
its screen or call or of its test file differs. The mark or judgment stays as it was; whether to look again is the
reviewer's call. A mark or judgment saved without a hash shows as it always did.

**Untagged tests.** An untagged test linked to a screen by its imports or its trace has 「제외」, to discard the
pair with a reason asked for in a window, and 「포함」, to hand it over so a coding agent adds the tag. A handed-over
pair waits under 「태그 대기」 until the tag is in the results. The 「태그 없음」 tab lists every untagged test and can
judge several pairs at once.

**Stories.** The story tab lists the stories with their status and link verdicts, a search box by name or ID and
filters by status and missing links; `part-pass` shows as 「일부 단계만 통과」, and a passing story whose steps are
not known shows 「단계 확인 못 함」. Choosing one shows its steps,
the link between each two with how many story tests went across it, in grey when none did, and its 「사전 조건」, and lets its name and memo be
changed. The story's own `needs` and
`expects` show in a 「스토리 전체」 box, apart from the 「사전 조건」 duru found in the code, a step's own ones and its `inputs`
show inside its card, and its `linkNeeds` show as 「들어오는 링크 조건」 on the link row before it. The pencil on the box, a
card or a link row, shown while the pointer is over it or the keyboard is on it and always on a touch screen, opens a
table there to add, change and remove these lines;
「저장」 writes them into the story file and names the file, and 「취소」 leaves the file as it is. If the file changed
elsewhere after the table opened, the save is refused and what was typed stays; 「새로 읽기」 then fills the table from the
changed file and drops what was typed, and 「덮어쓰기」 writes what was typed over the change. Each condition line chooses
「글로 적기」, to type the condition, or 「공통 조건 고르기」, to pick one of the need files in `needs/` by its name and file; it is
saved as `{ "use": "<file>" }`. The last choice, 「새 공통 조건 만들기…」, opens fields there for a file name (`.json` is
added), a name and a text: 「만들기」 writes the need file and the line picks it, and 「그만두기」 closes the fields. A file name
that breaks the story ID rule or is already in `needs/` is refused with why. A line picking a file that is not there
shows 「needs/… 없음」 and can pick another need file or be removed. A link row where the map has no link lists the
screens the step before leads to, here and while a new story is written. Each input reads like
「안내 글 「이메일」 또는 테스트 ID 「login-email」」, with 「· 2 번째」 when it has `nth`, then the value and 「확인 안 됨」.
With `app` set, pressing an input line on a story's or a candidate's card puts 「앱 화면」 at the top of the right pane,
above the story's own pane: the app at that step's screen, the account it is opened with, and the app cut down to the
boxes those words find, zoomed in. When the words find several boxes they are numbered 1, 2, 3 and only the one the
line counts to has the strong outline. When they lie too far apart to be cut together with the app's text still
readable, the cut stays around the box the line counts to and the boxes near it, and the note under the cut says where
the others are, such as 「3번은 이 그림 아래쪽에 있습니다」. When no box is found, 「앱 화면」 shows the top left of the
app screen at that same readable size. The box is shown empty, as the app has it; the value stays on the line above the
cut. A small picture beside the address shows where the cut sits in the whole app screen, 「가운데에 앱 화면 전체 열기」
opens the whole app in the middle pane until 「단계 카드로 돌아가기」, and 「닫기」 closes 「앱 화면」. The line then says
「화면에서 찾음」, or 「못 찾음」 with why under it: no box has those words, or fewer boxes have them than the number
written. A box that shows only with certain data, such as a second signer's memo, is found only when the running app
has that data, so the result lasts only until the page is reloaded and is written to no file and not to the task list.
The line keeps 「확인 안 됨」, and 「앱 화면」 says why, when the step's screen needs path values that are missing, when the
app moves to another screen, when the app never answers, as an app whose security policy blocks inline scripts
does not, or when the box is not found while the account the app is opened with could not sign in or no account meets
the screen's role condition; 「앱 화면」 shows that sign-in error or account note in red, as the middle pane does. Lines on a screen not on the map, on the cards of a new story and in 「순서 고치기」 cannot be pressed, and
hovering says why; without `app`, hovering 「확인 안 됨」 says that finding the box needs `app`.
A picked need file shows as 「공통 조건」 and its name, hovering shows its file and text, and pressing it opens it.
At the bottom of the story tab, 「공통 조건 N」 lists the need files with their name, file and how many stories pick them, followed
by the need files that could not be read and why. Pressing one shows its name, its text, the stories that pick it and
the file itself in the middle, with its file name in the address, as `#story?need=member-account.json`. 「고치기」 there
opens its name and text; 「저장」 writes them into the need file, and every story that picks it shows the new name and
text, since stories pick it by its file name. If the need file changed elsewhere since it was opened, the save is
refused and 「새로 읽기」 and 「덮어쓰기」 are offered, as in the story table. If it is deleted or can no longer be
read, the editor closes with a note that what was typed was not saved. 「스토리 파일」 at the bottom unfolds
the story in the shape of its file, with the steps that have any of these lines written as objects. 「순서 고치기」 at the
end of the 「화면 순서」 heading changes which screens the story passes: the left column becomes a screen picker.
Pressing a step, or Enter on it, shows 「이전 단계 추가」 above it and 「다음 단계 추가」 below it, which mark where the
next screen picked goes (「취소」 on the mark sends it to the end again), and 「제외」 on it. Steps are not moved or
dragged; a step in the wrong place is taken out and put in again. A kept step keeps its conditions, inputs and
expected results, a step put in has none, and the conditions of the link into a step stay only while the step
before it is the one it had, which its link row says before the order is saved. Taking out a step with lines written
asks first, naming what goes with it, with 「제외」 and 「취소」. The verdict chip beside the name and
「사전 조건 N」 follow the order being changed, and 「순서 저장」 and 「취소」 take the place of 「순서 고치기」 in the
「화면 순서」 heading; an order with the same screen twice in a row or with no step is not saved and says why, and a
file changed elsewhere is refused with
「새로 읽기」 and 「덮어쓰기」 as in the table. While the order is open the pencils wait, and while a table is open
「순서 고치기」 waits. A comment on a step whose number no longer holds its screen then shows under 「떨어져 나감」. Candidates are
listed below; a chosen one has 「스토리로 받기」, 「고쳐서 받기」 and 「버리기」 at the right end of its title row; the
address of a chosen candidate holds its screen order, as `#story?candidate=/home#Home+>+/help#Help`. A candidate
posted with `candidate` has a purple 「에이전트」 chip beside its name in the list and in the title, and under the title,
in place of the record file, the first line of the comment that asked for it, who left it and the day; pressing that
line opens 「전체」 of the conversation at the comment. Each screen the agent put in has the same chip beside its name
and, below its ID, 「이유」 in bold with the reason. The screens and lines the reviewer chose carry no mark. Each line
the agent wrote, an input, a condition of the link into a step, a condition or an expected result, has a box in
front of it, on at first. A line switched off is struck through, and above 「스토리로 받기」 the number of lines on
shows out of all the agent's lines, as 「3 / 4」. Each press is saved into the candidate file, so a line switched off
stays off after a reload or when the page is opened again. 「스토리로 받기」 and 「고쳐서 받기」 then write into the
story file only the lines on, together with the reviewer's lines, which have no box. A screen the agent put in is
taken out after accepting, with 「순서 고치기」. A story accepted from it shows the same comment line under its name. 「버리기」 opens
the window that 「제외」 opens, naming the candidate and its screen order, and the candidate is discarded only once a
reason is written there. 「버리기」 in the window or Ctrl+Enter saves it and moves on to the next candidate; 「취소」 or
Escape closes the window, and a click outside it does not. If
the discard is not saved, the window stays open with the reason and the error. A story accepted from a candidate has
「받기 되돌리기」 below its name and memo: it deletes the story file and the candidate is listed again and chosen. It
asks first only when conditions, inputs or expected results are written in the story, and its title then says they go
with the file. The comments left on that story then show under 「떨어져 나감」, as for any story file that is gone. A story
made with 「새 스토리」 or written by hand has no such button. Below the candidates, 「버린 후보 N」 opens the discarded
candidates, newest first, each with its name, its screens, the reason and the date; a screen order discarded more
than once shows its latest discard. Each has 「되돌리기」: it writes the undo file, without asking, and the
candidate is listed again and chosen; if the undo is refused, why shows under the list. 「새 스토리」 puts a story together from screens of the map, picked from the list
that takes the place of the stories or from boxes in the flow drawn in the middle.

**Changes to the stories folder.** While the review runs it watches `storiesDir` and every folder in it, such as
`candidates/` and `discarded/`, and every open page reads the stories again a moment after files there change from
outside the page: edited in an editor, brought in by `git pull`, or written by another duru command. A story file
added or deleted comes and goes in the lists, and the chosen story and the flow follow its new content, with no
reload. A name or memo being typed keeps what was typed, while one not touched shows the file's new value, and while
a Korean syllable is being composed the page waits until it is done. A `storiesDir` that does not exist yet is
watched once it is made. These changes are not printed on standard error, and `wait` does not exit for them.

**Marks.** A mark targets a screen, a call, one depth of either, one value of a call's option, or a story, and
records a status, a note, the author and the date. The status buttons are 「테스트 필요」, saved as `needs-more`, and
「충분」, saved as `fine`; 「충분」 can be put on a screen or call with no tests, for one that needs none. A mark saved as
`missing` by an older duru shows and counts as 「테스트 필요」. A mark left with text and no
status is a comment: it shows in the conversation with no status, keeps the current status as it was, and in the task list
follows the open mark it was written after. Pressing a picked status again lets it go, so a comment can be left on
a target that already has one. Each mark and each judgment
is its own new file, `<marksDir>/<node>/<date>-<author>-<short ID>.json`, so marks made on two machines merge in
git without a conflict and the newest is the current state. A mark on a screen or call, or on a depth, option,
case or part of one, also keeps `codeHash`, the screen's or call's hash on the map when it was saved; a judgment keeps
`codeHash` for its screen or call and `testFileHash` for its test file when the test file was found under
`srcRoot`. A mark whose target is gone from a rebuilt map shows
under 「떨어져 나감」. A case kind picked or taken out on a screen or call is kept the same way, as a mark with the
status `needed` or `not-needed`, and one whose kind has left `caseKinds` shows under 「떨어져 나감」. A `not-needed`
mark on a screen or call that a rule of its kind picks needs a note, and the
review server refuses one without; it also carries `rule`, `{ "index": <place in picks, from 0>, "pick": <the
rule as written> }`, naming the rule it took the target out of. Only such a mark wins over a rule; a `not-needed`
mark without `rule`, such as a kind pressed off before the rule was written, leaves the rule's pick in place. On a
screen or call no rule picks, a `not-needed` mark with a note says the kind is not needed there, and one without a
note leaves the kind undecided there. A mark written by `case` also carries `"via": "duru case"`; its `not-needed`
takes nothing out until a reviewer accepts it. The mark a reviewer saves by accepting or reverting it also carries
`"of": "<ID of the agent's mark>"`: accepting saves `not-needed` with the agent's note, and reverting saves again the
mark a person left before the agent's, or a `not-needed` without a note when there was none.

**Test rows.** A test row under a screen, call or story shows the test's title without its tags. The tags of the screen, call, story and depth
the row sits under are left out, and every other tag (a role, a setting, a story, another screen …) follows the
title as a small label of its own.

**Comments on a test row.** A test row under a screen or call (its own tests, 「불러오는 테스트」, 「지나간 테스트」
and 「호출한 테스트」) has a speech bubble that shows on hover. Pressing it puts that test in as the tag of the comment
being written; the comment is saved with the screen or call as its target plus
`"part": { "kind": "test", "key": { "source", "file", "title" } }`, naming the test by its result file, test file and
title without tags, as a judgment does. A part takes a comment only: a status sent with one is refused with the
reason, and it never changes the current status of the screen or call. A row with comments shows their number;
pressing it narrows the conversation to that test. A comment whose test is no longer among the results after a
`rebuild` (its title or file changed, or it left the results) shows under 「떨어져 나감」 with the test title.

**Comments on a condition or an incoming link.** Under 「접근 조건」 in 「화면 정보」, each role (「필요한 역할: …」, one
line per role) and each setting (「필요한 설정: …」) has the same bubble and count, and so has the head line of each
incoming link (the screen it starts on and its file and line), also when the screen is picked in the flow. A
condition is saved as `"part": { "kind": "condition", "key": … }` with the key `role:<role>`, or for a setting its
path with the state it asks, `setting:<path>=on`, `=off` or `=present`, or with the value for a list that must hold
it or a setting that must equal it, `setting:<path>:<value>`. A link is saved as
`"part": { "kind": "link", "key": { "from", "conditions" } }`, the screen it starts on and the roles and settings
read from it in the same names, or `{ "from", "guards" }` with its guards as written when none was read; links from
one screen that read the same share one count. No line number is in either key, so a comment stays when only the
lines move; it shows under 「떨어져 나감」 once a `rebuild` no longer finds the condition on the screen or such a link
into it.

**Comments on a candidate.** Each story candidate has a speech bubble that shows on hover. Pressing it chooses the
candidate and puts it in as the tag of the comment being written; the comment is saved with `"target": { "candidate":
"<key>" }` and nothing else in its target. The key is the candidate's screen IDs joined with ` > `, the same key the
page puts in its address. The comment is written to `<marksDir>/stories/candidates/<key>/`, with each character a file
name cannot hold replaced by `_` and a key longer than 80 characters cut and given a short hash, apart from the marks
on stories. A candidate takes comments only: a status sent with one is refused with the reason, and its comments never
enter the task list, so they reach a coding agent only as the lines printed while the review runs. A candidate with
comments shows their number; pressing it opens the candidate's conversation. Once the candidate is accepted or
discarded and leaves the list, its comments show under 「떨어져 나감」 of the story tab with the candidate's name.

**Comments on a screen order.** While a new story is written, the form under 「에이전트와 대화」 carries the steps
chosen so far as the tag 「화면 순서 …」, so the reviewer can ask the coding agent to fill in the way between them, often
after choosing only its ends. Pressing 「링크 없음」 between two steps, or the mark 「✕」 that stands for it on the two
boxes of the flow diagram, adds that gap to the tag as 「2-3 링크 없음」, to ask for that gap only, and pressing it again
takes it out; a gap moves with its two steps, also when a rebuilt map drops a step before them, and leaves the tag when
one of them is taken out, when a step is put in between them, or when the link between them is checked again and is no
longer 「링크 없음」. 「남기기」 saves the comment with
`"target": { "screens": [ … ] }`, the screen IDs in order, with `"gaps": [[2, 3]]` for the gaps pressed and
`"steps": [{ "step": 3, "expects": [ … ] }]` for the conditions, values and expected results typed at each step so
far, under the names a story file uses. It is written to
`<marksDir>/stories/orders/<key>/`, the key being the IDs joined with ` > ` and shortened as for a candidate, so
comments on the same order share one conversation whatever gaps they carry. A screen order takes comments only: a
status sent with one is refused with the reason, and its comments never enter the task list, so they reach a coding
agent only as the lines printed while the review runs. The new story stays open with what was typed, and the comment
shows at the top of 「에이전트와 대화」 while the same order is chosen. Under 「전체」 it shows under the order with its
replies in place. The coding agent answers with a reply, and with a story candidate posted by `candidate` when it
finds a way (see **Candidates from a comment**). Once a screen of the order leaves the map, the comment shows under 「떨어져 나감」 of the screens list
with the order.

**Comments on a step or a link of a story.** In the story tab each step of the chosen story and each link between
two of its steps has the same bubble and count. Pressing such a comment under 「전체」 opens the story and brings its
card up under the line. A step is saved as `"part": {
"kind": "step", "key": { "step", "screen" } }`, its number counted from 1 and its screen; a link as `"part": { "kind":
"hop", "key": { "step", "from", "to" } }`, the number of the step it leaves and the screens it leaves and reaches,
both with the story's ID in `target.story`. A step or link takes comments only; a status sent with one is refused with
the reason. The comment stays while the story has that screen at that step, and shows under 「떨어져 나감」 of the stories
tab, named with the step or link, once the story file has another screen there or is gone; while the story file cannot
be read it stays under 「목록 밖 스토리 코멘트」.

**Comments on several places or on none.** A comment can carry more than one tag, or none. It is saved once, with
`"targets": [ … ]` in place of `"target"`, each entry in the shape a single target has; a comment with one tag keeps
`"target"`, so marks saved before are read as they were. A comment with several tags is written to the folder of its
first target, and one with no tag, saved with `"targets": []`, to `<marksDir>/general/`. Such a comment takes no
status, and none of its targets may be a case kind or appear twice; a save that breaks this is refused with the
reason. A reply carries the targets of the comment it answers. A comment with several tags counts once on each row,
screen, call and story it is on and shows in each of their conversations; when a `rebuild` no longer finds one of its
targets, it stays on the others and shows under 「떨어져 나감」 with the target that is gone.

**Conversation.** For a screen or call the right pane holds only the conversation: every mark, comment and reply left
on it apart from the case kinds picked or taken out there, oldest first, open from the start and filling the pane, scrolling inside it when it is longer, with the form to
write in at the bottom. Each mark and comment carries the tags of where it was left; a reply sits under its comment,
set apart by its author and a light background. A tag from another screen, call or story is shown after the name of
that place. What is chosen in the middle is the default tag. A bubble replaces it while it is the only tag and adds
to the tags otherwise. Typing `@` in the text lists the depths of the place and the rows with a bubble in the middle;
one is added with the arrow keys and Enter or with a click, and Escape closes the list. Each tag's × takes it off:
taking off the last tag that is not the default brings the default back, and taking off the default as well leaves
「없음」, so the comment is saved with no target, until 「… 다시 붙이기」 puts the default back. A status can be picked
only while the default tag is the one tag on. A story and a candidate show their conversation the same way.

**All comments.** Two buttons at the top of the right pane switch between 「이 화면 N」 (「이 호출」 for a call, 「이 스토리」 for a
story, 「이 후보」 for a candidate), the conversation described above, and 「전체 N」, every mark and comment with text still
attached anywhere; N counts those, leaving out replies and marks that carry only a status; of those,
only the case kinds picked or taken out are listed, under 「변경 기록」. 「전체」 groups them by the
screen, call, story or candidate they were left on, the group with the latest entry first and the latest entry first
in each group; a line shows the status, the tag, who wrote it and when, the number of replies and the first line of
the text. 「미답변」 keeps the comments without a status that have no reply yet, and 「테스트 필요」 and 「충분」 keep, for a
place whose current status is that one, the latest mark with that status and text. With `caseKinds` set, the last
filter, 「변경 기록」, lists instead every case kind picked or taken out, as one list by time, the latest first, not
grouped: a line shows 켬 or 끔, the kind, the screen or call, who pressed it and when. Pressing one opens that screen or
call with 「관점별 테스트」 opened and scrolled into view. The form is hidden while 「전체」 is
shown. Pressing a line opens its screen, call, story or candidate in 「이 화면」 and scrolls the conversation to that
entry, outlined. While 「전체」 is shown the address carries `&talk=all`, and `&filter=<filter>` for a filter other than
「모두」, so going back after pressing a line shows 「전체」 with the same filter and the pressed line outlined in view,
and going forward opens the line's place again. Changing the filter or switching between the two buttons rewrites the
address without adding to the browser history. A comment with several tags is a line in each group it is on and is
counted once in N. A comment with no tag is listed under 「대상 없음」 with its whole text and its replies, and pressing it
opens nothing. 「전체」 and the numbers and dots it describes leave out what has come off its target; it stays under
「떨어져 나감」 and, unless it is a case kind picked or taken out, in the conversation of its screen or call.

A screen in the list and in the flow, a story in the story tab, a depth row and a call cell show 「코멘트 N」 when marks or
comments with text were left there, with a red dot while one of the comments has no reply; a test, condition or link
row shows the dot on its count too. The screen's number covers its whole conversation, as 「이 화면 N」 does, a row's
number only what carries that row as its tag, and pressing a row's number narrows the conversation to it. A comment or
reply saved in another window updates the numbers and dots without a reload.

**While the review runs.** Each mark, comment or reply is printed on standard error the moment it is saved, as one
JSON line:
`{"duru":"mark"|"comment"|"reply","id":…,"target":{…},"status":…,"replyTo":…,"note":…,"author":…,"date":…}`, with no
`status` for a comment or a reply and `replyTo` only on a reply. A comment or reply on several targets or none has
`"targets"` in place of `"target"` and `"wheres"`, one entry for each of its targets in the same order, each the
`where` that target alone would carry below, or `null` for a target that carries none. A comment or reply whose target has a `part` also
carries `"where"`: for a test, `{"file","line","source","status","relation"}` with `relation` one of `tagged`,
`imported`, `passed` or `called`, `detail` for a verdict line, and `passedIn`, the `baselineTests` folder, when the
test passed in that earlier release and fails or is pending now and the comment was left after that release's run, as
in the task list; for a condition or a link,
`{"places":[{"from","file","line",…}]}` with each source line it is read from, `from` being `route` or the screen a
link starts on, and for a condition the `guard` as written, `via` when it sits in a function the link calls,
`roleGuardsKey` when `roleGuards` gave its roles, or `inherited` for a link that passes on the condition of the screen
it starts on; or `null` when the part is no longer found. A failure message is not copied in; it is read from the
result file named in `source`. A comment or reply on a `candidate` carries `"where": {"name","source","screens"}`:
`screens` is the screen order, and `source` is `{"record","steps"}`, the visit record and its first and last step,
with `stepRanges` giving the steps behind each screen, or `{"report","tests"}`, the result file and the titles of the
tests that passed through that order. It is `null` once the candidate is no longer listed. A comment or reply on a
`step` of a story carries `"where": {"file","screen"}`, the story file under `storiesDir` and the step's screen with
its `componentFile`, `routeFile` and route `line`, with `tableItem` for a screen made from a table item (`"onMap": false`
instead when the screen is not on the map); on a
`hop`, `{"file","from","to","verdict","ways","preconditions"}`, the two screens in the same shape, the link's verdict
and where it is written as on the story, and the preconditions of the story that concern that link. It is `null` once
the story no longer has that step or link, and while the story file or the map cannot be read or the map was built
before stories. A comment or reply on a screen order carries `"where": {"screens","links"}`: `screens` has each screen
in the order in the shape of a step's screen, and `links` has, for each two neighbouring screens, `from`, `to`, the
verdict of the link between them and `ways`, as for a link between two steps of a story; the gaps and fields picked
come in its `target`. It is `null` while the map cannot be read or was built before stories. A coding agent that
launched the page can act on it without waiting for the end. Every open page
receives the same save at once and shows it without a reload, so a mark left in one window appears in another.

**Replies.** `reply <config> <comment ID> "<text>"` answers a comment. The reply is a mark with no status, saved as
its own new file next to the comment, with the comment's target, `replyTo` set to the comment's ID and the author
`agent`; the page shows it under the comment in the conversation, and the task list puts it under the comment
it answers. With `--server` and the address the review printed, the reply goes through the running review: it is
saved, printed on standard error as a `"reply"` line and shown on every open page at once. Without `--server` the
file is written directly and shows the next time the page is loaded. An ID that is not a comment in the marks stops
with `no comment with ID "<id>"` and exit code 1, and nothing is written. A reply prints nothing when it is saved.

**Waiting for comments.** `wait <config> --server <review page address>` connects to the running review and exits
as soon as there is a comment with no reply. Its standard output then holds every such comment, oldest first, one
JSON line each in the same shape as the review's standard error lines; marks, replies and answered comments are left
out. With none, it says `waiting for a comment at <address>` on standard error and exits with the next comment
saved. When the review ends first, it exits with code 0, nothing on standard output and `review ended` on standard
error. It keeps trying to connect for about 10 seconds, so it can be started while the review is starting; after
that it stops with `could not reach the review page at <address>: …` and exit code 1. When the connection drops
without the review ending, as when the review is stopped and started again, it connects again the same way, for
about 10 seconds. A coding agent runs it in the background, answers what it prints and runs it again, so a comment
saved while it was not running still reaches the agent on the next run.

**Claude Code sessions.** When the review runs with `CLAUDE_CODE_MESSAGING_SOCKET` in its environment, as when a
Claude Code session started it, each saved comment is also sent into that session as a message: a first line
`duru review comment; answer it with duru reply <config> <comment ID> "<answer>" --server <review page address>`,
then the comment's JSON line. Marks and replies are not sent. When the socket cannot be reached, the review prints
`could not send the comment to the Claude Code session: …` on standard error and goes on.

**Ending.** Pressing 「리뷰 끝」, or Ctrl+C in the terminal, closes the server and prints the task list on standard
output, so a coding agent that launched the page receives it as soon as the reviewer is done. Open pages stop
listening for new saves when the review ends.

## One story

`story <config> <story ID>` prints one story as text for a coding agent, marked or not. It has the lines of a story
under `# Stories` in the task list, without `marks`, and under each step: `open`, on the first step, the route path
(after `appUrl` when the config has it) with a route variable left as it is; `arrives`, a `toHaveURL` line matching the whole address for the
step's screen, or the reason when its route path was not read or it is not on the map; `what to press`, under a
link, saying duru does not know which element to press (only under a link that exists in the source, not under `no link`, a screen not on the map, or a move written in `moves`); and `fill`, under each `input` line,
Playwright code that finds the box with every word written for it, each matched exactly, takes the Nth of them for
`number N`, and puts the value in, such as
`await page.getByPlaceholder("이메일", { exact: true }).and(page.getByTestId("login-email")).fill("member@example.com");`
in a code span, followed by `(duru did not try it on the screen)`. The lines a person wrote (`need`, `link need from step N`,
`input`, `expect`, `needs`, `expects at the end`) are not checked by duru. Under `preconditions`, the first-screen
line gets an `accounts` line when the roles that open it were read, and each guard of a link between steps (under each way when there are several) and of a
route gets lines of its own; `tasks` does not print these lines. A role guard gets `role <roles>:` with, for each role,
the account in `app.roles` and the environment variable that holds its password (`no account in app.roles` when it
has none); the password is never printed. When the config has no `app.roles`, `preconditions` starts with one
`accounts: no app.roles in the config` line, and the role lines and the first-screen line name no accounts. On the route of
the first screen, a role whose accounts the first-screen line already gives says so instead of repeating them. A
setting guard gets one `setting` line for each setting it reads, which speaks for that setting only, not for other
checks joined to it with `&&`: `met with no change`, `not met with no change` with the value to put, or `not known,
its default was not read in full` with the value to put; a setting that only has to be there has no value to put. In
brackets it says what it was judged against: `checked against <file>` when `app.settingsFile` is set and its file ran
(read and run the way the review page does), or `source default; deployed settings not checked`, followed by the file
and why when the file is not found or could not be run. A role guard whose roles duru could not read gets `role not read:`, and a setting guard duru could not read gets
`setting not read:` and the reason. A guard that is neither a role nor a setting stays as its text on the precondition line. The text ends with empty tests carrying
`@story:` and the `@screen:` of each screen on the map. Standard output holds only that text; for a story ID that is
not there, a story file that could not be read or a map that must be rebuilt, one line goes to standard error and the
exit code is 1; a wrong call exits with 2.

## Task list

`tasks` prints, as Markdown, every screen, API call and story whose current mark is 「테스트 필요」, written `needs-more`.
Each screen comes with its marks, component file and route line (followed by `table item <key> at <file>:<line>` for
a screen made from a table item), the app address, the settings and roles it
needs, the tests of each role and setting case and of each case kind picked by a reviewer or a rule, or of each value of a kind with values,
by depth and status, its API calls and the tests already attached. Calls follow under `# API calls`, with their
picked case kinds the same way, and stories under `# Stories` with their steps, link verdicts and 「사전 조건」. A story's `needs` lines come before its
steps, each step's `link need from step N` (the link from the step before), `need`, `input` and `expect` lines follow
that step, and `expects at the end` follows the last step; a story without them gets none of these lines. An
`input` line reads like `input: placeholder "이메일" and testId "login-email", number 2 → "member@example.com" (not
checked against the code)`, with `number N` only when the input has `nth`. A picked need file is written as
`<name> (needs/<file>): <text>`, and one that is not there or could not be read as `needs/<file> — the file is
missing` or `needs/<file> — the file could not be read`. Under an open
screen or call, `comments on tests` lists each test a comment was left on, with its file and line, status, how it is
linked and its result file, followed by those comments and their replies. Under an open screen, `comments on opening conditions`
and `comments on incoming links` list each condition and link a comment was left on the same way, with the source
lines each is read from. Under an open story, `comments on steps` and `comments on links between steps` list each
step and each link between two steps a comment was left on, with the screen's component file and route line, and for
a link its verdict and where it is written. A comment left on several targets shows under each of them that is
listed, followed by `left on N targets:` and all of them. Comments with no target and their replies come first, under
`# Comments with no target`.

Each item ends with `empty tests`: one empty test per test format in the config, with the item's tags already in
place (in the `tag` option for Playwright, in the title for the other formats) and held back so a copy run as it is does not pass (`test.fixme` for Playwright, `test.todo` for
Vitest, `@Disabled` for JUnit, a verdict line with `<verdict>` for a check script). A screen gets one more set for
each case with no tests, and a call one for each picked case kind with no tests; for a kind with values that is one
for each value with no tests, carrying `@case:<kind>=<value>`. The writer puts what the test
checks in place of `<what it checks>`, since the Playwright empty tests of an item all carry that same title, fills
in the data setup and the checks, and the test attaches after a `rebuild`. Pairs handed over on the review page follow under
`# Tagging`, each with the test, the tag to add and where it goes. duru never edits a test file.
Before `# Case kinds` and `# Tagging`, `# Code changed after a mark or a judgment` lists each mark, with its target
and status, and each discarded or handed-over pair whose code changed after it was left, as the review page shows
「코드 바뀜」; it is left out while there is none.

**Comments on regressed tests.** With `baselineTests` in the config, it also lists each screen and API call with a
test that passed in that earlier release and fails or is pending now, when a reviewer commented on that test's row
after the release's run. Such an item starts with `- marks: none, listed for comments on regressed tests` when it
has no open mark, and then has no `empty tests`; its cases with no tests stay under `# Case kinds`. Under
`comments on tests` the line of that test has `, passed in <folder>` right after its result file, the `baselineTests` folder as the
`test results since` line names it, the head of the list adds `N commented regressions`, and the intro says to fix
the code or the test as the comment says rather than write a new test. With no open mark the list starts with that
and does not say `No open marks.` An item listed this way leaves once those tests pass again after a `rebuild`, or
once a reviewer marks the whole screen or call `fine`; a comment after that brings it back. A comment left before
the baseline ran does not count, which is why JUnit XML and verdict logs are kept with their modified time. When
`baselineTests` cannot be read, the line right under the head says
`baselineTests <path> could not be read: <why>; screens and calls a reviewer sent by commenting on a regressed test are not listed`,
the rest of the list is as without it, and `tasks` does not stop.

**Case kinds.** With `caseKinds` set, `# Case kinds` comes before `# Tagging`, with a `## <kind>` for each kind: its
description, its values and rules, `undecided: N` with a line for each undecided candidate, and `cases with no
tests: N`. A candidate is any screen or call for a kind without rules, and otherwise one on the side its rules pick
(screens or calls); it is undecided while no rule picks it and its current mark of that kind is none, or a
`not-needed` with no note. A candidate line is `<ID> — call, sent from <screens>` or `<ID> — screen, component
<file>, route at <file>:<line>`, requests other than `GET` first (a request whose method was not read among them),
then the other calls, then the screens, each group by ID. A candidate whose current mark a person left ends with
`— <author> marked it not-needed without a note on <date>, so only a person can decide it` (`took it out of a rule
that no longer picks it` for a mark whose rule no longer picks it, `took back the agent's not-needed` for one a
reviewer reverted): `case` does not change that mark. While an agent's `not-needed` waits for a reviewer on any
candidate, `under review: N` follows `undecided`, with a line for each such candidate ending with the agent, the
date and its note; it is not counted as undecided. Each screen or
call the kind is picked for, by a rule or a mark, with a case no test carries follows as `### <ID>` with `picked by:`
(a rule and its place in `picks`, or the author, date and note of the mark), `no tests:` with the tags, and `empty
tests` for each; one listed above under its own marks is not repeated, and `cases with no tests: N` counts its cases
too, adding `, N of them under screens and calls listed above`. When this section has anything to do, the head of
the list adds `N undecided case candidates, N cases with no tests`, with `, N under review` after the first while
any wait, and with no open marks the list says the case kinds below still have work instead of `No open marks.`
With `baselineMap`, the section's intro also says when to run `undecided --new` instead; the counts and lines do not
change, and the task list does not read that map. Without `caseKinds` the list has no such section.

`case <config> <kind> <screen or call ID> needed|not-needed [--note "<why>"] [--author <name> | --server <review page address>]`
writes a case mark of that kind for that screen or call, as the review page would, directly into `marksDir`: the
author is `agent` unless `--author` names one, and the file also carries `"via": "duru case"`. Written this way, an
open review page shows it the next time it is loaded. With `--server` and the address the review printed, the mark
goes through the running review instead, which checks it and writes the same file with the author always `agent`,
prints it on standard error as a `"mark"` line and shows it on every open page at once; the command itself then
reads neither the map nor the marks. `--author` with `--server` stops with `a case sent with --server is always by
agent; leave out --author` and exit code 2. It prints nothing when the mark is written, and stops with a line saying
why and exit code 1, writing nothing, for a kind not in `caseKinds`, an ID not on the map, `not-needed` without
`--note`, `needed` on a screen or call where a mark of that kind a person left holds (any mark without `via`), also
one that leaves it undecided or one under an agent's `not-needed` waiting for a reviewer, either status where a
reviewer reverted an agent's `not-needed` of that kind (`<reviewer> took back the agent's not-needed for <kind> on
<ID> on <date>, so only a person decides it now`), and `not-needed` on a screen or call off the side the kind's rules
pick that has no mark of that kind to take back, the same line with or without `--server`. A `not-needed` over a
person's mark is written and waits for a reviewer, with that person's mark holding until then.
A review that cannot be reached stops it with `could
not reach the review page at <address>: …` and exit code 1, and a review started by an older duru answers `not
found`. `needed` is also
written where a rule already picks the target, so it stays picked when the rule changes. A `not-needed` where a rule
picks the target carries `rule` like one saved on the page.

`undecided <config> [<kind>]` prints, for every kind or the one named, `case kind <kind>: N undecided` followed by its
undecided candidates as in the task list. While an agent's `not-needed` waits for a reviewer, the kind's line ends
with `, N under review` and a last line says `N under review: not-needed marks of the agent that wait for a reviewer
to accept or revert them on the review page`; those are not undecided.
It exits with 0 when none is left, 3 while any is, 1 when the config, the
map or a mark file cannot be read (a missing map is one line asking for `rebuild`), and 2 when it is called wrongly
or names a kind not in `caseKinds`. `tests.json` is not needed, and neither is the map `baselineMap` names.

With `--new` it lists only the undecided candidates that are screens or calls the map named by `baselineMap` does
not have, under `case kind <kind>: M new undecided since <file> (N undecided in all)`, and exits with 3 while any of
those is left and with 0 once none is, even while older candidates are still undecided. This is for a kind whose
older candidates are left for later: the new ones still have to be decided. Without `baselineMap` it prints
`--new needs baselineMap in the config` and exits with 2; a `baselineMap` that cannot be read exits with 1, naming
the file.

## Agent skill

`skills/duru/SKILL.md` is a skill for a coding agent such as Claude Code. When the user asks for a duru review,
it has the agent rebuild the map, launch `review` and hand the address to the user, write the tests in the
target project from the task list it receives when the review ends (for a story, one test tagged
`@story:<story ID>` that goes through its screens), starting from the item's empty test for its runner with
the title tags kept, and rebuild again to confirm they attach.
duru itself never calls a model. Install it by copying or symlinking the folder into the project's
`.claude/skills` folder, or into `~/.claude/skills` for every project:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/duru" ~/.claude/skills/duru   # run from this repository
```

## License

MIT
