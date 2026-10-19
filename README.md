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
node src/cli.ts reply path/to/project-config.json <comment ID> "<text>" [--server <review page address>]   # answer a comment
node src/cli.ts wait path/to/project-config.json --server <review page address>   # exits with the comments not yet answered
npm test
```

Requires Node 22.18 or later (23.6 or later on Node 23), which runs duru's own TypeScript files without a flag. Run
duru from its clone, or link it (`npm link`, or `npm install <path to the clone>`): Node does not run TypeScript
files from inside `node_modules`, so a copy installed there, as from a packed `.tgz`, stops on its first `.ts` file.

## Config

The project config lives **outside this repository** next to the target project's data. Paths in it are
relative to the config file, except the files inside the client source (`routesFile`, `constants`,
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
  the route paths (`"Option.ROUTE_PATH"`). A route with a `path` gives a screen when the screen is written as
  `component={Home}`, `element={<Home />}`, `element={wrap(<Home />)}`, an element wrapped in others
  (`element={<Suspense><Home /></Suspense>}`) or a component passed to another (`element={<Wrapper Page={Signer} />}`).
  `element={<Navigate to=… />}` is a redirect, not a screen. A route without `path` gives no screen, and the path
  of a parent route is not put in front of it. `routeConstant` and `constants` may be left out, or set to `null`
  (`routeConstant` also to `""`), for an app that has no table of its route paths. A `routeConstant` that is not a
  dotted name, or whose first name is not in `constants`, stops the run with an error.
- `redirectElements` — the elements that redirect in the route files (default `Redirect` and
  `Navigate`; a config that lists them uses exactly the names listed).
- `entryPaths` — route paths of further screens users start from when the code does not show them.
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
  order. A kind is a case of a screen or call only where a reviewer picks it on the review page.

### Output and review

- `outDir` — where `map.json` and `tests.json` are written (default: the config's folder).
- `marksDir`, `judgmentsDir` — where the review page keeps marks and judgments on test pairs (default: `marks`
  and `judgments` in `outDir`).
- `author` — the name marks and judgments are signed with (optional; default `git config user.name` in the
  config's folder, else the computer's user name). Leave it out of a config file a team shares.
- `storiesDir` — folder of story files, or a single story file (default: `stories` in `outDir`). The review page
  writes the visits recorded on it into `records/` there.
- `visitRecords` — visit record files or folders that story candidates are made from (optional), as
  `["qa/records"]`. Playwright reports in `tests` whose tests left a trace give candidates too.
- `baselineMap` — the `map.json` of an earlier version of the same client (optional), such as the map kept from
  the last release. `rebuild` and the review page then show what changed since it. Build it with the same duru as
  the current map: a map from another duru can differ for reasons in duru rather than in the client, and one from a
  duru that did not record the roles a route guard lets through is refused.
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
  changed; changes last until the review ends and are never sent to the server.

## The map

`extract` writes `map.json`; `rebuild` writes it and `tests.json`.

**Screens.** Each screen has an ID made of its route path and component name (`/document/:id#DocumentDetail`),
usable as a test tag. The pattern a path variable carries is left out of the ID, so `/document/:tab(draft|done)`
gives `/document/:tab#DocumentList`; the screen's path keeps it. It lists its route file and line, its component
file, its `sourceFiles`, the API calls it reaches, the settings it reads, and its links to other screens with the
conditions guarding them. The settings and links come from every file in `sourceFiles`. The API calls are only
those the screen's code reaches, so a file in `sourceFiles` can hold calls the screen does not list, and a call
sent by a method of a store the screen gets from a React context hook can be written in a file outside them; each
call names the file and line where it is written. A call a saga makes for the screen names the line in the saga
and lists under `actions` each action type that leads to it, with the places the screen dispatches that type
(`dispatchedAt`).
A layout with a side menu around a group of routes gives its calls, settings reads and links to every screen
inside it.

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
- `redux-saga runs from <file>:<line> | watchers N | requests of sagas on screens N` — where the app runs its
  sagas, how many pairs of an action type and the saga code waiting for it those runs reach, and how many
  requests written in sagas come to a screen through an action it dispatches (`sagas` on the map). Printed when
  a source file names redux-saga.
- `redux-saga is imported, but no run of a createSagaMiddleware() result was found, so no request of a saga is put on a screen`
  — the sources name redux-saga, but duru found no `run` of a saga middleware, so no saga request is on the map.
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
  wrapping its route bring.
- `route path not read ← <route file>:<line>: stopped at <piece>` — a route whose path duru could not read in full.
  `<piece>` is the first part of the path whose value it could not read, as written where duru stopped: in the
  route file, or, followed by `in <file>:<line>`, in another file when duru followed a name into that file. `, only
  <text>` follows when a part of the path was read, with `{?}` for the rest. The screen is on the map with that path
  and an ID made from it; when the ID itself holds `{?}`, it changes once that part can be read (`unreadRoutePaths`).
- `settingsFunctions <file>:<line> <what>` — about calls in the files the route files lead to by import: a call
  that duru does not read as settings; a default the function is given that differs from the `settingsDefaults`
  value (the map keeps that value), or that differs from another call's or cannot be compared with it (the map
  leaves the default unknown); and a function called in none of those files (`settingsCallNotices`).
- An alias import that finds no file, with the number of files that write it (`unresolvedAliasImports`).
- Routes that end up with the same ID, each place as `file:line` (`duplicateIds`).
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
nothing on the map, and the tests with no tag as `untagged`. `traced`
lists each Playwright test that passed, with the trace of its passing run, as its report, its title and the screens
it passed in order; an address no screen matches stays in that list as its path.

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
pointing at the same box, so the box can still be found when one of them changes. When those words find more than
one box, such as one memo box per signer, `nth` says which one, counting from 1. `value` is the text to put in.
duru does not look for the box in the code, so the page and the task list mark each input as not checked.

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
fails and one is pending, pass when all pass. Without such tests it is `partial` when a screen on its path has a
test, and `untested` when none has.

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
never changed or deleted; keep the folder in git with the stories. If a file cannot be written, `rebuild` stops
storing and prints why under the candidate line. The candidates listed are these files together with what the
records and traces give now, and for a screen order in both, what they give now is shown. So a candidate stays
after a `rebuild` whose results have no traces, or once its record is gone. An accepted or discarded candidate keeps
its file, and the story or the discarded file keeps it out of the list. When a screen of a stored candidate has left the map, the candidate stays
listed with that step shown as a screen the map does not have. A candidate file that cannot be read is skipped and
noted with its path and why.

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
view. Below the line are the story's cards: its name, tests, 「스토리 전체」 box, then each step and the link into it. The
right column has the story's 「사전 조건」, a folded 「손볼 화면 N」 listing the failing and untested screens on its path, each
bringing up its step card, then the name and memo and the conversation. The address of a story is `#story?story=<ID>`,
with `&step=<N>` added while step N is outlined, so opening that address, going back to it or reloading it outlines
the same step and brings its card into view. Pressing another step changes the address without adding to the browser
history.

**A new story.** 「새 스토리」 is made in the story tab only. The flow tab's bar has a 「새 스토리」 button (「새 스토리 이어
쓰기」 once it has steps) that moves to the story tab's new-story screen, and `#flow?new=1` and `#stories?new=1` open
the same screen. The left column lists the screens, the middle shows the steps chosen so far above the whole flow, and
the right column holds the verdict, and ID, name and memo with 「스토리 저장」. Pressing a screen in the list or a box in
the drawing adds that screen as the next step, and the drawing scrolls to keep the box pressed in place where it can.
Each chosen box carries its step number. Two neighbouring steps are joined in the style of their verdict: on the link
itself when the second box hangs under the first, otherwise by a mark in each of the two boxes with the other step's
number. Pressing a step shows 「이전 단계 추가」 above it, 「다음 단계 추가」 below it and 「제외」 on it, as in 「순서
고치기」; a step is moved by taking it out and adding it again. The same screen twice in a row is refused as in the
list; a box already chosen is added again, since a story can pass a screen twice. 「스토리 목록」 closes the screen and
keeps the steps for 「새 스토리 이어 쓰기」. In the flow tab a box opens its screen. The filters, the search and the
picked screen of the flow tab are left as they were and do not change the drawing in the new-story screen.

**Recording a walk through the app.** When `app` is set, the title row of 「새 스토리」 has 「● 기록」. It opens the app in
the middle column in place of the drawing, and the screens the app passes through stack up as steps in the left column
in place of the screen list, after the steps chosen before. Each address change is read, an address on the same screen
as the step before joins that step, and an address no screen matches becomes a step marked 「맵에 없는 화면」. A value
typed into a box found by its placeholder, label or test ID is kept on its step; a password, a select, a checkbox or a
box with none of these is only counted. The bar above the app chooses the account it is open as: the default
account, each role in `app.roles`, or signed out when `app.signedOutPaths` is set. Choosing another one keeps the
addresses so far as one record and starts a new one. 「기록 끝」 writes the record into `records/` in `storiesDir` as
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
the screen, then shows the tests of each role and setting case by depth under 「경우별 테스트」, the links into it
with their guards, the conditions inside the screen, where its route and component are, the links out of it and the
settings it reads. The links into it and out of it also list the moves written in `moves` as 「설정에 적은 이동」 with their
reason. Once opened it stays open on other screens until it is closed. Choosing a call, in the table or from a link
elsewhere, opens its details under the call table and scrolls the middle pane to them: where its option was found,
the server match, its tests, untagged tests linked to it, where this screen calls it and the screens that use it.
With `caseKinds` set, 「경우별 테스트」 has a button per kind for every screen, and for a call in its details: pressing one
makes the kind a case there, with its tests by depth, and pressing it again takes it out. Each press is listed under
「전체」's 「변경 기록」, not in the conversation of the screen or call. A picked kind with values
has a row per value under it, with that value's tests by depth and result, or 「테스트 없음」. The flow shows the same
middle and right panes for a picked screen.

**Pane widths.** The edge on either side of the middle pane, in the list, in the story tab and beside a picked screen
in the flow, can be dragged to widen or narrow the panes; the line lights up when the
mouse rests on it. The drawing is laid out again for its new width, and the app in the middle pane is shown at the
percent that fits the pane's new width
when 「배율」 is 「칸에 맞춤」 (with the width at 「칸에 맞춤」, the app itself gets the new width). No pane can be dragged narrower than its contents need, and when the window gets too narrow
for the middle pane, the side panes give back the width they were dragged to. The widths last until the page is
loaded again.

**Changes since a baseline.** With `baselineMap` set, the header names the baseline by its folder and path
(「비교 기준」). A screen in the list carries 「생김」, 「조건 바뀜」 (the conditions before and after on hover) or
「호출 +N −N」, and 「바뀐 화면만」 in the box 「<folder> 와 비교」 keeps only those. Below the list come the screens only the
baseline has, and how many screens changed their role or setting conditions and how many calls their server match.
A changed screen opens with a line saying what changed; its call table has a column 「<folder> 와 비교」 with 「생김」 or
「서버 대조 바뀜 (before → after)」, and the calls it no longer sends are listed struck through with 「없어짐」. A
`baselineMap` that cannot be read stops `review` before the page is served.

**Untagged tests.** An untagged test linked to a screen by its imports or its trace has 「제외」, to discard the
pair with a reason asked for in a window, and 「포함」, to hand it over so a coding agent adds the tag. A handed-over
pair waits under 「태그 대기」 until the tag is in the results. The 「태그 없음」 tab lists every untagged test and can
judge several pairs at once.

**Stories.** The story tab lists the stories with their status and link verdicts, a search box by name or ID and
filters by status and missing links; choosing one shows its steps,
the link between each two and its 「사전 조건」, and lets its name and memo be changed. The story's own `needs` and
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
「안내 글 「이메일」 또는 테스트 ID 「login-email」」, with 「· 2 번째」 when it has `nth`, then the value and 「확인 안 됨」:
duru has not looked for that box in the code.
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
asks first, naming what goes with it, with 「제외」 and 「취소」. The right pane shows the verdict and 「사전 조건」 of the
order being changed, with 「순서 저장」 and 「취소」 under the verdict; an order with the
same screen twice in a row or with no step is not saved and says why, and a file changed elsewhere is refused with
「새로 읽기」 and 「덮어쓰기」 as in the table. While the order is open the pencils wait, and while a table is open
「순서 고치기」 waits. A comment on a step whose number no longer holds its screen then shows under 「떨어져 나감」. Candidates are
listed below with 「스토리로 받기」, 「고쳐서 받기」 and 「버리기」; the address of a chosen candidate holds its screen order, as
`#story?candidate=/home#Home+>+/help#Help`. 「버리기」 opens the window that 「제외」 opens, naming the candidate and its
screen order, and the candidate is discarded only once a reason is written there. 「버리기」 in the window or Ctrl+Enter
saves it and moves on to the next candidate; 「취소」 or Escape closes the window, and a click outside it does not. If
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
records a status (`needs-more`, `missing`, `fine`), a note, the author and the date. A mark left with text and no
status is a comment: it shows in the conversation with no status, keeps the current status as it was, and in the task list
follows the open mark it was written after. Pressing a picked status again lets it go, so a comment can be left on
a target that already has one. Each mark and each judgment
is its own new file, `<marksDir>/<node>/<date>-<author>-<short ID>.json`, so marks made on two machines merge in
git without a conflict and the newest is the current state. A mark whose target is gone from a rebuilt map shows
under 「떨어져 나감」. A case kind picked or taken out on a screen or call is kept the same way, as a mark with the
status `needed` or `not-needed`; it puts nothing on the task list, and one whose kind has left `caseKinds` shows
under 「떨어져 나감」.

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
only while the default tag is the one tag on. For a story or a candidate the conversation sits under the
form behind 「대화 N」, and each entry without a status is labelled 「코멘트」 or 「답」.

**All comments.** Two buttons at the top of the right pane switch between 「이 화면 N」 (「이 호출」 for a call, 「이 스토리」 for a
story, 「이 후보」 for a candidate), the conversation described above, and 「전체 N」, every mark and comment with text still
attached anywhere; N counts those, leaving out replies and marks that carry only a status; of those,
only the case kinds picked or taken out are listed, under 「변경 기록」. 「전체」 groups them by the
screen, call, story or candidate they were left on, the group with the latest entry first and the latest entry first
in each group; a line shows the status, the tag, who wrote it and when, the number of replies and the first line of
the text. 「미답변」 keeps the comments without a status that have no reply yet, and 「더 필요」, 「없음」 and 「충분」 keep, for a
place whose current status is that one, the latest mark with that status and text. With `caseKinds` set, the last
filter, 「변경 기록」, lists instead every case kind picked or taken out, as one list by time, the latest first, not
grouped: a line shows 켬 or 끔, the kind, the screen or call, who pressed it and when. Pressing one opens that screen or
call with 「경우별 테스트」 opened and scrolled into view. The form is hidden while 「전체」 is
shown. Pressing a line opens its screen, call, story or candidate in 「이 화면」 and scrolls the conversation to that
entry, outlined. A comment with several tags is a line in each group it is on and is counted once in N. A comment with
no tag is listed under 「대상 없음」 with its whole text and its replies, and pressing it opens nothing. 「전체」 and the
numbers and dots it describes leave out what has come off its target; it stays under
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
`imported`, `passed` or `called`, and `detail` for a verdict line; for a condition or a link,
`{"places":[{"from","file","line",…}]}` with each source line it is read from, `from` being `route` or the screen a
link starts on, and for a condition the `guard` as written, `via` when it sits in a function the link calls,
`roleGuardsKey` when `roleGuards` gave its roles, or `inherited` for a link that passes on the condition of the screen
it starts on; or `null` when the part is no longer found. A failure message is not copied in; it is read from the
result file named in `source`. A comment or reply on a `candidate` carries `"where": {"name","source","screens"}`:
`screens` is the screen order, and `source` is `{"record","steps"}`, the visit record and its first and last step,
with `stepRanges` giving the steps behind each screen, or `{"report","tests"}`, the result file and the titles of the
tests that passed through that order. It is `null` once the candidate is no longer listed. A comment or reply on a
`step` of a story carries `"where": {"file","screen"}`, the story file under `storiesDir` and the step's screen with
its `componentFile`, `routeFile` and route `line` (`"onMap": false` instead when the screen is not on the map); on a
`hop`, `{"file","from","to","verdict","ways","preconditions"}`, the two screens in the same shape, the link's verdict
and where it is written as on the story, and the preconditions of the story that concern that link. It is `null` once
the story no longer has that step or link, and while the story file or the map cannot be read or the map was built
before stories. A coding agent that launched the page can act on it without waiting for the end. Every open page
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

## Task list

`tasks` prints, as Markdown, every screen, API call and story whose current mark is `needs-more` or `missing`.
Each screen comes with its marks, component file and route line, the app address, the settings and roles it
needs, the tests of each role and setting case and of each picked case kind, or of each value of a kind with values,
by depth and status, its API calls and the tests already attached. Calls follow under `# API calls`, with their
picked case kinds the same way, and stories under `# Stories` with their steps, link verdicts and 「사전 조건」. A story's `needs` lines come before its
steps, each step's `link need from step N` (the link from the step before), `need`, `input` and `expect` lines follow
that step, and `expects at the end` follows the last step; a story without them gets none of these lines. An
`input` line reads like `input: placeholder "이메일" or testId "login-email", number 2 → "member@example.com" (not
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
