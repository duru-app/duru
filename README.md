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

- `apiModules`, `passThroughCalls` — where API functions live and which wrappers pass a URL through.
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
  `fetch` lists its files in `calledApiModules` and leaves `requestFunction` out. Outside packages that
  `constantStubs` does not give are filled with values that do nothing. A call stopped after one second counts as
  failed. Two listed files exporting different objects under one name, or a name `apiModules` already has, get the
  file path in front of the name. On into-sign 2.0.0:

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
  that reloads after sign-in and lets a redirect choose the screen. Story steps use them like links.
- `callLinks` — calls whose on/off options change what another call gives back (optional), each
  `{ "from", "to", "note" }` with two call IDs as in the map, such as an export option that only shows in the
  file a download call delivers.

### Server and tests

- `serverEndpoints`, `apiPathPrefix` — one or more server endpoint lists (`<label>\t<METHOD>\t<path>` per line,
  `{var}` for path variables). Without them no call is compared with the server and no screen is dead.
- `tests` — test results to attach, each `{ "format": <playwright|junit|vitest|verdict>, "path": <file or folder>, "depth": <ui|api|render|code|data|output> }`.
  A folder is searched for `.json` files (Playwright, Vitest), `.xml` files (JUnit) or `.txt` and `.log` files
  (verdict).

### Output and review

- `outDir` — where `map.json` and `tests.json` are written (default: the config's folder).
- `marksDir`, `judgmentsDir` — where the review page keeps marks and judgments on test pairs (default: `marks`
  and `judgments` in `outDir`).
- `author` — the name marks and judgments are signed with (optional; default `git config user.name` in the
  config's folder, else the computer's user name). Leave it out of a config file a team shares.
- `storiesDir` — folder of story files, or a single story file (default: `stories` in `outDir`).
- `visitRecords` — visit record files or folders that story candidates are made from (optional), as
  `["qa/records"]`.
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
usable as a test tag. It lists its route file and line, its component file, its `sourceFiles`, the API calls it
reaches, the settings it reads, and its links to other screens with the conditions guarding them. The settings
and links come from every file in `sourceFiles`. The API calls are only those the screen's code reaches, so a file
in `sourceFiles` can hold calls the screen does not list; each call names the file and line where it is written.
A layout with a side menu around a group of routes gives its calls, settings reads and links to every screen
inside it.

**Calls.** Each API call is a node under `calls` with an ID `<METHOD>:<path>`
(`GET:/api/v1/document/{documentId}`), its server match, the API functions that make it, the screens that reach
it, and the on/off `options` of its request body. The server match is one of:

- `match` — on the server, with the endpoint list labels
- `method-mismatch` — the server has the path with another method
- `none` — not on the server; a screen that reaches such a call is `dead: true`
- `unresolved` — the URL cannot be worked out from the source, so there is no call node
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
- `api method <name> ← <file>:<line>: <error>` — a called function or method that gave no address, where it is
  declared and the first line of what stopped it (`did not finish within 1000 ms` for one stopped after a
  second). Its calls are missing from the map. A method that sends no request is not printed.
- `calledApiModules <file> did not run: <file>:<line>: <error>` — a listed file that failed to run, so none of
  its functions or methods are on the map.
- `calledApiModules <file> recorded no request; without requestFunction only requests sent with fetch are recorded`
  — with `requestFunction` left out, a listed file none of whose methods sent a request with `fetch`. Its API code
  may send through a function or object that `requestFunction` should name, or its methods may have stopped on the
  fake values (`silentApiModules`). When no listed file sends a request with `fetch`, the run stops with an error
  that also gives the cause for each listed file that did not run.
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
- `rebuild` also prints the story and candidate counts and the files skipped, the links from untagged tests to
  screens and the trace or test files it could not read, the judged test pairs, and each judgment file it could
  not read or whose screen is gone from the map.

## Tests

A test declares the node it covers by putting `@screen:<id>` or `@call:<id>` in its title — for JUnit, in the
test's or the test class's `@DisplayName`, since `@Tag` does not reach the result XML; for Vitest, in the test
title, a `describe` title or the test's `tags` option. A test takes the depth of its result source unless it
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

`tests.json` lists the tests per node and per story with depth and status (pass, fail, pending; skipped and todo
count as pending), the tags that point at nothing on the map, and the tests with no tag as `untagged`.

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
  "screens": ["/signin#SignIn", "/home#Home", "/document/:tab_draft_done_#DocumentList", "/document/:id#DocumentDetail"],
  "memo": "초안 탭에 문서가 하나 이상 있어야 한다.",
  "author": "Kim Min",
  "date": "2026-10-02"
}
```

- `name` — what the user gets done, in one short sentence
- `screens` — the screen IDs of the steps, first step first, one entry per screen the user lands on, so the same
  screen never comes twice in a row
- `memo` (optional) — what the steps do not say, such as the account or the data the flow needs
- `author`, `date` — who wrote the story and when (`2026-10-02`)
- `source` (optional) — for a story accepted from a candidate, the visit record and its steps

No other keys are allowed. A file that breaks these rules is skipped and noted with its path and why.

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
with the list in `steps`, each step with the `url` it was at. Other keys are ignored.

```json
{
  "steps": [
    { "action": "open", "url": "http://localhost:3000/home" },
    { "action": "open drafts", "url": "/document/draft?page=2" }
  ]
}
```

duru turns each record named in `visitRecords` into a story candidate: each address goes to the screen whose
route path matches it, steps in a row on the same screen become one step, and an address no screen matches stays
as it is. A candidate with the screen order of a story or of a discarded candidate is not offered. A record that
cannot be read is skipped and noted with its path and why.

On the review page a candidate is accepted, which writes a story file into `storiesDir`, or discarded with a
reason, which writes a file into `discarded/` in `storiesDir` so the same order does not come back.

## Review page

`review` serves a local page that reads `map.json` and `tests.json` from `outDir` (run `rebuild` first) and writes
only marks, judgments and story files. The page keeps the place being looked at in its address, so the back
button, a reload and a copied address work.

**Flow.** The page opens on the flow: one box per screen, in columns by how many links they are from an entry
screen, with its tests and a dashed line for a link under a setting or role condition. 「빈틈만 펼치기」 opens only
the way to boxes whose tests are missing or failing. A box can fold its branch, open its API calls or show its
branch alone. The 「스토리」 picker draws one story's path on the flow.

**List.** The left column lists screens with filters for no tests, dead screens, screens that open only under a
setting or a role, and screens with only untagged tests. With `app` set, the middle shows the chosen screen's app
in a frame, already logged in, with a role picker, boxes for path values and a line for the settings the screen's
conditions name, which can be turned on and off. Below come the screen's tests by depth and its API calls, with
a row per option value. The right says what it takes to open the screen, with the tests of each role and setting
case by depth, and lists the links into it with their guards.

**Untagged tests.** An untagged test linked to a screen by its imports or its trace has 「제외」, to discard the
pair with a reason, and 「포함」, to hand it over so a coding agent adds the tag. A handed-over pair waits under
「태그 대기」 until the tag is in the results. The 「태그 없음」 tab lists every untagged test and can judge several
pairs at once.

**Stories.** The stories tab lists the stories with their status and link verdicts; choosing one shows its steps,
the link between each two and its 「사전 조건」, and lets its name and memo be changed. Candidates are listed below
with 「스토리로 받기」, 「고쳐서 받기」 and 「버리기」. 「새 스토리」 puts a story together from screens of the map.

**Marks.** A mark targets a screen, a call, one depth of either, one value of a call's option, or a story, and
records a status (`needs-more`, `missing`, `fine`), a note, the author and the date. Each mark and each judgment
is its own new file, `<marksDir>/<node>/<date>-<author>-<short ID>.json`, so marks made on two machines merge in
git without a conflict and the newest is the current state. A mark whose target is gone from a rebuilt map shows
under 「떨어져 나감」.

**Ending.** Pressing 「리뷰 끝」, or Ctrl+C in the terminal, closes the server and prints the task list on standard
output, so a coding agent that launched the page receives it as soon as the reviewer is done.

## Task list

`tasks` prints, as Markdown, every screen, API call and story whose current mark is `needs-more` or `missing`.
Each screen comes with its marks, component file and route line, the app address, the settings and roles it
needs, the tests of each role and setting case by depth and status, its API calls and the tests already attached.
Calls follow under `# API calls` and stories under `# Stories` with their steps, link verdicts and 「사전 조건」.

Each item ends with `empty tests`: one empty test per test format in the config, with the item's tags already in
its title and held back so a copy run as it is does not pass (`test.fixme` for Playwright, `test.todo` for
Vitest, `@Disabled` for JUnit, a verdict line with `<verdict>` for a check script). A screen gets one more set for
each role or setting case with no tests. The writer fills in the data setup and the checks, and the test attaches
after a `rebuild`. Pairs handed over on the review page follow under `# Tagging`, each with the test, the tag to
add and where it goes. duru never edits a test file.

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
