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
node src/cli.mjs review path/to/project-config.json [--port 4400]   # review page on 127.0.0.1, task list when it ends
node src/cli.mjs tasks path/to/project-config.json > tasks.md        # task list for a coding agent
npm test
```

Requires Node 22 or later.

The project config lives **outside this repository** next to the target project's data. Paths in it are
relative to the config file, except the files inside the client source (`routesFile`, `constants`,
`apiModules`, `settingsDefaults`), which are relative to `srcRoot`. It names:

- `srcRoot`, `routesFile`, `routeElements`, `routeConstant` — the client source and how routes are declared
- `constants`, `constantStubs` — modules evaluated for route paths and API endpoint definitions, and
  stand-in source for outside packages they import
- `apiModules`, `passThroughCalls` — where API functions live and which wrappers pass a URL through
- `bodyArgKeys` — properties of a call argument that hold the request body (optional, default none), such
  as `data` in `ajaxExport({ data: { withHistory } })`. Without it only an object written straight into the
  call is read as the body
- `bodyOptions` — on/off keys to add to a call's request body, per call ID (optional), as
  `{ "POST:/api/v1/report/export": ["withHistory"] }`, for a body the source does not show, such as one built
  in another file and passed as a variable. A call ID that is not on the map is listed under
  `unknownBodyOptionCalls` and printed by `extract` and `rebuild`
- `settingsRoots` — identifiers through which settings are read
- `settingsDefaults` — where the default values of a settings root are written (optional), as
  `{ "globalSettings": { "file": "store/settings.js", "const": "defaults" } }`: the object literal that a
  top-level `const` of that name in the file holds, such as a reducer's initial state. Changes the file makes to
  it afterwards are not seen. The root must also be listed in `settingsRoots`
- `roleIdentifiers` — where the user's role is read (optional, default none): an identifier (`memberRole`) or
  one member of an object (`workspace['member.role']`)
- `redirectElements`, `entryPaths` — how fallback redirects are declared in the routes file (default
  `Redirect`), and route paths of further screens users start from when the code does not show them
- `serverEndpoints`, `apiPathPrefix` — one or more server endpoint lists
  (`<label>\t<METHOD>\t<path>` per line, `{var}` for path variables); `serverEndpoints` may be left out, see
  `unchecked` below
- `tests` — test results to attach, each `{ "format": <playwright|junit|vitest|verdict>, "path": <file or folder>, "depth": <ui|api|render|code|data|output> }`.
  A folder is searched for `.json` files (Playwright, Vitest), `.xml` files (JUnit) or `.txt` and `.log`
  files (verdict); files in another format are skipped
- `outDir` — where `map.json` and `tests.json` are written (default: the config's folder)
- `marksDir` — folder where review marks are kept (default: `marks` in `outDir`)
- `judgmentsDir` — folder where the review page keeps judgments on pairs of a test and a screen, such as a test importing the screen that is discarded or handed over for tagging (default: `judgments` in `outDir`)
- `storiesDir` — folder of story files, or a single story file (default: `stories` in `outDir`); see
  [Stories](#stories)
- `appUrl` — address of a running instance of the app; the review page links each screen without path
  variables to it
- `app` — what the review page needs to show the app itself, logged in, in a frame (optional; replaces the
  `appUrl` link on the page):

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
  path of the JSON reply, and puts `login.storage.value` with `{token}` filled in under `login.storage.key` in
  the app's localStorage (an object value is stored as JSON). The password is read from the environment
  variable named by `account.passwordEnv` and never written to the config, the map or any page. Give duru an
  account of its own: an app that allows one login per account logs out whoever else uses it.
  `roles` (optional) gives an account per role, keyed by the role value the app compares the role with
  (`"ADMIN"` for `memberRole === 'ADMIN'`), each written like `account`. `account` stays the account for
  screens without a role condition. duru logs in once per account when the review starts, all at the same
  time and once for an account several roles share, and keeps each token for the whole review; each role is served on a port of `127.0.0.1` of its own
  with its token, since localStorage is kept per port. A role whose login fails keeps its own error and the
  other accounts are not affected.
  `signedOutPaths` (optional) lists route paths to show signed out, such as a sign-in screen that an app
  leaves for its main screen when someone is logged in: those screens open on a second port of `127.0.0.1`
  that never gets the token. Opening such a screen from the review page first clears `login.storage.key` on
  that port, so a login left there earlier is gone, while the app can still log in and reload in the frame. An
  app that keeps the login in a cookie instead of localStorage stays logged in on that port too. A path that
  matches no screen path in the map exactly is listed in red above the frame.
  `pathValues` (optional) fills the path variables of a screen, keyed by its route path exactly as in the map.
  Each variable takes either a fixed value or a list API: duru calls `server` + `api` (with `method`, GET by
  default, and a JSON `body` for any other method), finds the list at the dotted `list` path of the JSON reply
  (`""` when the reply is the list itself) and takes the dotted `value` path of its first item (`""` for the
  item itself, such as a list of bare ids). A list API is
  called with the token of the account the frame opens the screen as (`account`, or the role picked for it) in
  `login.header` (`{token}` filled in), which is then required. An optional
  variable (`:tab?`) without a value is left out of the address, and a variable that spans several segments
  (`*`, `:path+`) keeps the `/` in its value. An entry or a variable that matches no screen
  path or no variable of that path is listed in red above the frame.
  `settingsFile` (optional) is the static settings file the app downloads, which duru rewrites to show a
  screen under other settings without touching the test server: `path` is where the app requests it, `global`
  the object the file assigns (`window.INTO_SETTINGS = { ... }`), `root` the `settingsRoots` entry it feeds
  (it needs a `settingsDefaults` entry too), and `merged` the top-level sections the app merges one level deep
  over its defaults (`{ ...defaults.SYSTEM, ...window.INTO_SETTINGS.SYSTEM }`). duru serves that file, from the
  build folder or the deployed address, with code appended that writes the settings changed on the review page.
  Because the app merges only one level, changing `SYSTEM.MAIN_MENU.ADMIN.LIST` writes all of
  `SYSTEM.MAIN_MENU`: a copy of the file's own value when it has one, else the default, with only the list
  changed. Changes last until the review ends, apply to every app address duru serves, and are never sent to
  the test server. Only settings in a `merged` section read through `root` can be changed. A change inside a
  key (a longer path, or a list entry) whose default the map lists under `settingsDefaultsIncomplete` is
  refused unless the settings file sets that key itself, since the copy of the default would lose what the
  source does not show; replacing the whole key is still allowed. Path keys `__proto__`, `constructor` and
  `prototype` are refused. To show the values the page starts from, duru also runs the file as served,
  without the changes, in a `node:vm` context with `window` as its global and a one-second limit, and
  keeps the JSON values of the `merged` sections of `global`. This is not a sandbox: it runs the app's own
  file, the same one the browser runs. The review page reads `app.settings` from `/api/data` as `{ root,
  merged, overrides, file, fileError }` (`file` is `null` and `fileError` says why when the file could not be
  run) and posts its changes to `/api/settings` as `{ "overrides": [{ "path": [section, key, ...], "value" }
  or { "path", "item", "value": true|false }] }`, which replaces the whole list.

`map.json` lists screens with their route guards, the API calls reachable from each screen with the
server match, the settings each screen reads, and links to other screens with the conditions guarding
them. A screen reaches the files its route component imports, directly or in turn, and the files of every
component that wraps its route in the routes file, such as a layout with a side menu around a group of
routes. The wrapper's API calls, settings reads and links therefore belong to each screen it wraps. Files
are followed whole, not name by name: a screen that imports one name from a barrel file reaches every file
that barrel re-exports, and their API calls, settings reads and links belong to the screen too. An API
function that a file imports through a barrel instead of from the API module is not read as an API call. A guard
around the wrapper is a route guard of every screen inside it, so the wrapper's links count as coming from
restricted screens and do not repeat that guard.

A menu built from a settings list, where the route is picked by the first parameter of a `forEach` or
`map` callback over the list (`MENUS.ADMIN?.LIST?.forEach((menu) => ... Option.ROUTE_PATH[menu])`), gives one
link per entry of the list's default value when the list is read from a `settingsDefaults` root, directly or
through local consts. Each of these links also carries the setting guard
`globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST includes 'ADMIN_REPORT'`. Entries that are not route names are
skipped, and a route picked by any other computed key is left out.

A route constant followed by more path is read as the address it spells, with `{*}` for each variable segment:
`` `${Option.ROUTE_PATH.USER_SIGN}/${id}` ``, `Option.ROUTE_PATH.USER_SIGN + '/' + id` and
`Option.ROUTE_PATH.USER_SIGN + '/ALL'` become links to `/user-sign/{*}` and `/user-sign/ALL`, so they enter
`/user-sign/:type` and not the plain `/user-sign`. Nested concatenation is followed to the end
(`` `${ROUTE + '/' + id}/edit` `` spells `/route/{*}/edit`), and a tab name taken from a const in the same file
(`const TOPIC = 'faq'`) is fixed text; a tab name read from a member of an object in the screen's own files, even
a const object literal in the same file (`LOCAL.RESULT`), is a variable segment, while a member of the
configured constants files (`Enum.TAB.READY`) is fixed text. A variable segment fits only a route segment that is a
parameter, optional and repeated ones included (`/help/{*}` fits `/help/:topic/:section?`); a fixed segment fits a
parameter whose pattern (`:tab(draft|done)`) allows it, or the same fixed segment, both without letter case, as
React Router compares them. Anything after `?` or `#` is ignored. An address whose tail is
not made of whole segments is read as the bare constant, a link to the route without the parameter: a variable
glued to the constant or to other text in one segment (`` `${ROUTE}${x}` ``, `ROUTE + location.search`,
`` `${ROUTE}/page-${x}` ``, `` `${ROUTE}/${id}${location.search}` ``), a conditional tail
(`ROUTE + (x ? '/' + x : '')`), and an address joined any other way (`[ROUTE, x].join('/')`). Only a constant whose
value is a string takes a tail, and a variable segment never enters a route whose segment is fixed
(`${ROUTE}/${x}` does not enter `/lab/result`; it falls back to `/lab`). A table of tab addresses counts only
where it is written in a screen's own files, and only through the shapes above; the `ROUTE_PATH_GROUP`-style
table that a constants file keeps for highlighting the active menu entry is not read, because that file is not a
screen file. A menu list that is filtered or defaulted before it is looped over
(`(MENUS.X?.LIST || []).filter(...).forEach(...)`) is not read as a menu, so the screens only that menu leads to
keep no incoming link.

Each screen has an ID made of its route path and component name (`/document/:id#DocumentDetail`),
with spaces and `, ( ) & | !` replaced so it works as a JUnit tag too. Routes that end up with the same
ID are listed under `duplicateIds`.

Each API call is also a node under `calls`, with an ID of the form `<METHOD>:<path>`
(`GET:/api/v1/document/{documentId}`). The server match decides the path:

- `match` — the path as written in the server endpoint list, also kept as `server.path`, with the
  endpoint list labels in `server.labels`
- `method-mismatch` — the client's method with the server path (`server.path`); the server's entries are
  in `server.candidates`
- `none` — the client's URL without `apiPathPrefix`, starting with `/`
- `unresolved` — the URL cannot be computed from the source, so there is no call node
- `unchecked` — the call was not compared with the server because there is no server endpoint list: no
  `serverEndpoints` setting, or lists with no endpoint line. `map.json` then carries a top-level
  `serverNotCompared: true` (the field is left out when a list is read), and `rebuild` adds the unchecked count
  to its server line and prints a line saying the comparison was skipped. The task list says so too, in a
  line under its intro. An unchecked call's ID is the client's URL without `apiPathPrefix`, as for `none`,
  with `{0}`, `{1}` for path variables (`GET:/api/v1/document/{0}`), so once a server list is added the ID of
  a call with path variables can change to the server's path (`GET:/api/v1/document/{documentId}`); tags and
  option keys written against the earlier ID then point outside the map. A call whose URL cannot be computed
  stays `unresolved`.

When several server paths fit one call, the one whose path variables and fixed names line up with the
client URL wins, then the first in sorted order. The same character replacement as for screen IDs applies.
Each call node lists its `method`, `path`, `server` match, the API functions that make it and the screens
that reach it. Every endpoint under `apiFunctions` carries the `callId` of its node (`null` when unresolved),
and a screen is marked `dead: true` when it reaches a call whose server match is `none`. An unresolved call
alone does not make a screen dead. Neither does an `unchecked` one: without a server list no call is dead and
no screen is a dead screen, and the task list does not write such a call as missing on the server.

Each call node also lists the on/off `options` of its request body, read where a screen calls the API
function. The body is an object written into the call's arguments, or the object under a `bodyArgKeys`
property of one; either may be a const of the same file. A body key is an option when its value is `true` or
`false`, a const initialised to one of them, or the first value of `useState(true)` or `useState(false)`.
A GET call carries no body, so it takes no options found in the code, only those written in `bodyOptions`;
when the API function makes both a GET and another call, the keys found go to the other call alone.
Each option has its `key`, the `values` to test it with (always `[true, false]`, whatever the screen sends),
`sources` (`source` for one found in the code, `config` for one written in `bodyOptions`, both when it is
both) and the `sites` it was found at (`screen`, `file`, `line` of the key; none for an option only in the
config), sorted by key. The keys found in the code and their lines are also under each screen's API call as
`options`. A key
followed in the same body by a key or method of the same name, a computed key or a spread
(`{ withHistory: false, ...prefs }`) is not an option, because the later one may be what is sent; a spread itself
is not followed. A `bodyArgKeys` property followed in the same way gives no options at all.

Each screen's `access` says whether it opens only under a setting or a role. A guard that reads a member of
a `settingsRoots` identifier is a `setting` condition, one that reads a `roleIdentifiers` entry is a `role`
condition (it can be both), and any other guard (UI state such as `selected.length > 0`) does not block. An
identifier entry matches as a whole identifier. An object entry matches only a read of that member:
`workspace['member.role']` also matches `workspace?.['member.role']` and the double-quoted form, a key that is a
plain name matches the dot form too (`session.role`, `session?.role`), and `workspace['member.id']` does not match.
A `const` declared in the same file that a guard uses is judged by its initializer too, and so are
the consts that initializer uses in turn: after `const isAdmin = isAdminRole(memberRole)`, the guard
`isAdmin` is a role condition and is still listed as `isAdmin`. The walk starts from entry screens, listed under `entries` with their `reasons`: the targets of
redirects in the routes file that no setting or role guards (`redirect`), screens no link leads to (`no-incoming-link`, such as pages
opened from an e-mail), and `entryPaths` (`config`; paths that match no route go to `unknownEntryPaths`).
A screen is open when an entry screen reaches it through links and routes without such a guard, and
`restricted` otherwise; a screen no entry screen reaches at all stays open, since nothing shows what would
block it. A link counts as guarded when it has such a guard itself, or when every place that uses the
handler it sits in is guarded. A link enters the route with the same path. When there is none, a link with a tail
after its route constant enters the routes that begin with the constant's own path and whose further segments fit
the tail (`/document/{*}` and `/document/draft` enter `/document/:id`; a trailing slash in the route path does not
count, and a route such as `*` or `/:section/:id` takes no tail link); when none fits, and for every other address,
it enters every route that only adds parameter segments to it (`/document` enters `/document/:id`). A link with a
tail that still reaches no route is read once more as its bare constant: it enters the route with that same path,
or, when there is none, every route that only adds parameter segments to it (`/lab/{*}` enters `/lab`). When
adding parameters or reading the bare constant reaches only the screen the link sits in, the next of these rules
is tried. Links to a partly unknown path, and a screen's links to itself, are left out. `access`
lists `kinds` (`setting`, `role`), the blocking `route` guards, and every incoming link in `links` with the
screen it comes `from`, its source location, its blocking `guards` (`via` names the handler an inherited
guard came from) and `fromKinds`, the `kinds` of the screen it comes from (empty when that screen is open or its own links ask for different
kinds).
A restricted screen's `kinds` are those of its route guards and, when it is not an entry screen and every link
into it is blocked, each kind that every one of those links asks for: a link asks for a kind when one of its guards has it, or when the
screen it comes from is restricted and needs it. A kind only some links ask for is left out, since another
link opens the screen without it, so a screen whose links ask for different kinds (a role on one, a setting on
another) is restricted with empty `kinds`. An entry screen opens without a link, so the links into it add
nothing to its `kinds`, `roleValues` or `settings`.
Every link in a screen's own `links` also has `conditions`: all the guards around it, counted by the same
handler rule, each with `kinds`, `roles` and `settings` as in `access` and with empty `kinds` when it is
neither a setting nor a role guard.

Each `role` guard also has `roles`: the role values that pass it, read from the guard and the consts it uses,
or `null` when they cannot be read or no value passes. duru reads a comparison of a `roleIdentifiers` entry with a string
(`memberRole === 'ADMIN'`, `==`, either side) or with a constant from `constants` (`Enum.ROLE.ADMIN`), a list
lookup (`['ADMIN', 'OWNER'].indexOf(role) > -1`, `>= 0`, `!== -1`, `!= -1`, or `.includes(role)`), and `&&` / `||`
of those. A call to a function held in a `const` at the top level of the same file is read as the expression
the function returns, with the call's arguments in place of the parameters, when the function is an arrow
function or a function expression whose parameters are plain names, whose body is that expression or a lone
`return` of it, and when that expression reads nothing but the parameters and the default import of a
`constants` module under its configured name: after `const isAdminRole = (role) => { return [Enum.ROLE.ADMIN,
Enum.ROLE.OWNER].includes(role); }`, `isAdminRole(this.props.memberRole)` allows `ADMIN` and `OWNER`. A guard that reads the role only inside a function declaration or another file is not seen as a role
condition at all, because those functions are not followed. Anything else
that reads the role is unreadable: a call that passes the role to a function declaration, an imported function or
a function declared inside another function, a function with more than a `return` in its body, one whose expression reads
any other name (another function, a variable of the file, a local that hides the `constants` import, a default
import from another module under the same name) or uses `this`, `arguments`, `new.target`, JSX, `import()`
or a function of its own, an `async` or generator one, one with default, rest or destructured parameters, one
called with a different number of arguments or with a spread, a call whose name means different things at
different places with the same guard text in one file, or a call inside a larger expression
(`roleTabs(memberRole).length > 0`); `!==`, a negation, a comparison with a value that is not a string or
constant, or `||` with a guard that does not read the role. A screen whose `kinds` include `role` gets `roleValues`, the values that can open it: those
every readable route guard allows, and of those, the ones some blocked incoming link allows (the link's
readable `role` guards, or, for a link with no `role` guard from a screen that needs a role, that screen's
`roleValues`); when one of those links cannot be read, the links are left out, since it may let any role in.
Guards are read in full, though the map shows a long guard cut short. Unreadable guards are left out when something else is readable; when nothing is, or no
value is left, `roleValues` is `null`. `unreadableRoleGuards` lists the guards left out.
A `setting` guard also says which setting values it needs, read from the guard's source and through the
consts it uses (`helpEnabled` after `const system = globalSettings.SYSTEM; const helpEnabled =
system.HELP_LINK_ENABLED` needs `SYSTEM.HELP_LINK_ENABLED` on). `settings` lists one entry per setting:
`{ "root", "path", "need", "value", "default" }`, where `need` is `on` for a bare read (or `=== true`), `off`
for `!read` (or `=== false`, or the else branch of a bare read), `equals` with `value` for `=== 'V'` or `==` with
a string or number, `includes` with `value` for the menu guard `<list> includes 'V'`, and `present` for a bare
read whose default is not `true` or `false` (such as an object). Reads joined by `&&` give one entry each, and
parts that read no setting (a role check) are left out. `default` is the value in `settingsDefaults`, when
known. Any other form (a function call, `!==`, `||`, a comparison with a non-literal or by size, a negated
`&&`) gives `settings: null` and a Korean `settingsReason`. A screen whose `kinds` include `setting` also has
`access.settings`: one entry for its route guards (`from: "route"`) and, when its links count as above, one per
link into it that carries a setting guard (`from` the screen, `file`, `line`), each with the `needs` of its readable guards and the
`unreadable` guards with their `reason`. Among those links, one with no setting guard of its own from a screen whose `kinds`
include `setting` carries what that screen needs: its route guards' needs and the needs every way into it shares. Its entry
has `inherited: true` when it carries any, and an unreadable guard is passed on only when every way into that screen has one. The evaluated `settingsDefaults` are written to `map.json` too, with
`settingsDefaultsIncomplete`, which lists per root the places the source does not show in full: `[section,
key]` for a key whose value holds something duru cannot read (such as `window.X || [...]`, a call, a spread,
a computed key, or a constant that is not configured), `[section]` for a section whose keys cannot all be
known, and `[]` when the sections themselves cannot.

A test declares the node it covers by putting `@screen:<id>` or `@call:<id>` in its title — for JUnit, in
the test's or the test class's display name (`@DisplayName`), since `@Tag` annotations do not reach the
result XML; for Vitest, in the test title, a `describe` title or the test's `tags` option. A test takes the
depth of its result source unless it carries `@depth:<ui|api|render|code|data|output>`, which sets the depth for
that test alone. `output` is for a test that checks the content of what the app produces, such as an
exported file, rather than only the response; the depth is taken as declared, without checking what the test
opened.

A test of a call that sets on/off options of its request body declares each with
`@option:<key>=true|false` (`@call:POST:/api/v1/report/export @option:withHistory=true`). An option tag
attaches to every call among the same test's `@call:` tags that has that key in its `options`; a test that
turns on two options carries two option tags and counts under both. Under each call, a test lists the
`options` it attaches to that call as `{ key, value }`, sorted by key; an empty list means the test names no
option for that call. Screens take no option values.

A test that walks a whole story declares it with `@story:<story ID>` (see [Stories](#stories)), in the
same places as the node tags. A test may carry `@story:` together with `@screen:` and `@call:` tags; it
then counts for the story and for each node. A story tag takes the test's depth too.

`tests.json` lists the tests per node ID and, under `stories`, per story ID as the tag writes it, each with
its own depth and status (pass, fail, pending; skipped and todo count as pending), the tags that point at IDs
not on the map, name an unknown depth, or are option tags with no call of the test to attach to or a value
other than `true` or `false`, the tests that carry neither a node tag nor a story tag, as `untagged` (each with
`title`, `file`, `line`, `source`, `format`, `status` and, for a Vitest test found under `srcRoot`, `testFile`;
a test that ran in several projects is listed once with the worst of their statuses, fail before pending before
pass; sorted by `testFile` or else `file`, then line, title and result source) with their number in
`untaggedCount`, and configured result
paths that do not exist yet. A test lists under a story once however many times its tags name it. Story
tags are matched against the story files whenever the stories are read, not when `tests.json` is written:
`rebuild` prints a story tag that no story file has with the other tags pointing outside the map.
A unit test that carries no tag for a screen is still shown next to it when its test file imports one of
the screen's source files. Each screen in `map.json` lists its `sourceFiles`: the files reached by `import`,
`import()` and re-exports (`export ... from`, so a file used through a barrel file counts; `require()` is not
followed) from its component and from the components wrapped around its route, leaving out the API modules and the
constants files. For every test of a `vitest` result source (a Jest JSON report has the same shape and is
read the same way), duru finds the test file under `srcRoot`, also when the report was written on another
computer, and reads the files it imports (`import`, `import()` and
`require()`; a file named only to mock it, as in `jest.mock()` or `vi.mock(import())`, does not count).
`tests.json` lists the test under `importers` for each screen
that has one of those files among its `sourceFiles`, with the test file's path under `srcRoot` in `testFile`
and the files it came through in `via`. A source file
that more than three screens share is not taken as a link (every file a barrel re-exports is shared by all
the screens that import from that barrel), and a test already tagged with the screen is
left out there. These tests do not count as tests of the screen: `nodes`, the story statuses and the counts
of screens with tests stay as the tags make them. A test file that is not found under `srcRoot` is listed
once in `importNotices` with the reason; `rebuild` prints how many links from a test to a screen it made
this way and how many test files it could not read. An absolute report path that exists on this computer is
taken only when it lies under `srcRoot`; any other path is looked up under `srcRoot` by its longest trailing
part that names a file there, and by the bare file name only when the folder before it is named like
`srcRoot` or the report gives nothing but the file name. A
report from another computer that names a file of another package can still match a file with the same
trailing path under `srcRoot`.

`test/fixtures/app` holds a small fake client with example results and a config.

A check script that is not a test framework reports through verdict lines in its output, one test per line;
other lines are ignored:

```
VERDICT empty form save: FIXED — saving an empty form shows a message @screen:/document/:id#DocumentDetail
```

The name runs up to the first `: ` and may contain spaces. The word right after it decides the status:
`UPHOLDS`, `FIXED`, `HEALTHY` pass; `REPRODUCES`, `VIOLATE`, `VIOLATES`, `REGRESSED`, `BROKEN` fail;
`INCONCLUSIVE`, `KNOWN_DROP`, `ENTRY_HEALTHY`, `PARTIAL` and any other word are pending. The text after
`— ` (an em dash; a plain hyphen does not count) is kept as `detail` so the reason for a failure or a
pending result can be shown; for a word outside the table, `detail` is everything after the colon. Node
and story tags go at the end of the line.

## Stories

A story is something a user gets done, written as the screens they pass through in order. Stories are
kept in `storiesDir`, one JSON file per story, apart from the tests, so a story nobody has tested yet is
still listed. duru reads them and never writes them.

The file name without `.json` is the story ID: `open-document.json` is the story `open-document`. An ID
uses only lowercase letters, digits, `-` and `_`, so it can go into a test tag and a file name as it is.
Files may sit in subfolders; the subfolder does not change the ID. Symbolic links to a story file or a folder
are followed. When `storiesDir` is a file, that file is
the only story.

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
- `screens` — the screen IDs of the steps, first step first: one entry per screen the user lands on, written
  once however many things they do there, so the same screen never comes twice in a row. Screen IDs are the
  `id` of `screens` in `map.json`, also shown under the title of the chosen screen on the review page
- `memo` (optional) — what the steps do not say, such as the account or the data the flow needs
- `author` — who wrote the story
- `date` — when, as `2026-10-02` (a full ISO date and time such as `2026-10-02T09:30:00Z` is accepted too)

No other keys are allowed, `id` included. To write a story from a flow someone describes: find each place
they go in `map.json` by its route path (and component, when one path has several), list those screen IDs
in order, and save the file under a new ID that says what the flow does.

A file that is not valid JSON, leaves out `name`, `screens`, `author` or `date`, has a value of the wrong
kind, has another key, has a name outside the ID rule, or has an ID that a file earlier in path order already
uses, whether or not that file could be read, is skipped and noted with its path and why. So is a symbolic
link named `*.json` that points nowhere or cannot be followed, and so is a story folder that cannot be listed
(one note on the folder). `rebuild` prints
the notes with a count of stories, broken paths, detached stories and `unknown` steps and a count of stories
in each status, and the review page lists them under the stories. The other stories are read as usual.

Each story is checked against the map, with the same result every time for the same story files and map:

- Each step's screen is looked up on the map. A story with a screen the map does not have is detached, and
  the two links next to that screen are not judged (`off-map`).
- Between two neighbouring steps, duru lists every map link from the first screen to the second with its
  source location and conditions. The step is `open` when one of those links has no condition, `conditioned`
  when every one has, and `broken` when there is no such link: duru found no link in the map that joins the two
  screens. When there is none but the first screen has links to a path duru cannot read, duru cannot tell where
  those lead, so the step is `unknown` instead, not broken, with those links' source locations and `to` in
  `unknownLinks`. A story with such a step has `unjudged`. When links join the two and every one has a
  condition, such links are left out of the verdict and still listed in `unknownLinks`; next to an `open` step
  they could not change anything and are not listed. A link to a path duru can read but no screen has is not a
  link to the next screen. Redirects in the routes file are not followed, so a step whose only way goes
  through such a redirect shows as `broken` (「링크 없음」 on the review page).
  Conditions here are the link's `conditions` on the map: all the guards around the link, not only setting
  and role guards, so a guard such as `doc.type !== 'FLEX'` is a condition too, with empty `kinds`.
- 「사전 조건」 (what it takes to get to the end) gathers, in step order: what the first screen needs when
  it opens only under a setting or a role (its `kinds` and `roleValues`), then for each step the conditions
  of the links into it when they are `conditioned` (with the step's `unknownLinks`, if any), and the setting
  and role guards of its route with the route's line in `routesFile`.

Each story also gets a `status` from the tests in `tests.json`, apart from the link verdicts above. A
story with tests tagged `@story:<its ID>` fails when one of them fails, is `pending` when none fails and
one is pending, and passes when all pass. A story without such tests is `partial` (「일부 화면만 테스트」) when a
screen on its path has a test of any status, and `untested` (「테스트 없음」) when none has. A screen not
on the map has no tests. A story file written after `rebuild` takes the tests already tagged with its ID.

A `map.json` written by a duru whose links did not carry `conditions` yet cannot be checked: while there are
stories, the review data lists no story and carries one message asking to run `rebuild` as `stories.stale`,
apart from the notes on story files; the rest of the review page and `tasks` work as usual.

`test/fixtures/app/example-stories` holds example stories for the fake client: one that connects end to end,
one through a link guarded by a setting, one with no link between two of its screens, one with a screen that
is not on the map, one of a single screen, and one malformed file. With the example results they pass,
fail, are pending, are partly covered and have no tests, and one result carries a story tag that points at
no story file.

## Review page

`review` serves a local page that reads `map.json` and `tests.json` from `outDir` (run `rebuild` first) and
writes only into the marks folder. It opens on the flow view, with only the way to boxes whose tests are
missing or failing opened (as 「빈틈만 펼치기」 does) on first load; after that the branches stay as the reviewer
leaves them, also across visits to the list. A line on top reads 「테스트 있는 화면 n/전체 · 실패 n · 태그 없는
테스트만 있는 화면 n」: screens with a tagged test, screens with a failing one, and screens with no tagged test
but with tests linked by import (`flow.summary` in `/api/data`); a box adds 「불러옴 N」 for those (`imported` on
each flow node) right after its test counts, which neither its border nor 「빈틈만 펼치기」 counts. A box is sized
to what it says: its route breaks only before a `/`, its component name is never split and no line is cut. Boxes
stand in columns by how many links they are from an entry screen, each column as wide as its widest box. A box
wraps its route once the box's content would pass 360px, and is wider than that when its component name or one
route segment needs more room. A box with something to open or fold puts its buttons on a line of their own under the
name, written as words (「접기」/「펼치기」 to hide what hangs below the screen and bring it back as it was, 「전부 펼치기」 for the
branch and its API calls, 「처음으로」 for the branch's screens opened and its API calls closed, 「이 가지만」 to show
only that branch); the row takes part in the box's measured width, so a box is never narrower than its buttons
(the longest row, four buttons, is about 240px, well inside the 360px cap). How to read the picture is shown
with samples, not sentences. At the right of the bar's button row a legend is always visible (a list named
「흐름도 범례」): four box outlines drawn with the border rules of the boxes themselves, labelled 「통과」, 「실패」,
「보류」 and 「테스트 없음」, and a dashed line drawn in the style of a link under a setting or role condition, labelled
「조건 걸린 링크」. No label breaks inside a word; in a narrow window the legend wraps onto a line of its own. Right
of the legend stands a round ⓘ icon, the bar's last control, with the accessible name 「흐름도 읽는 법」 and no native
tooltip. Hovering or pressing it opens a small list under it, aligned to the bar's right edge, with the two things
a one-word sample cannot say: 「→ /주소」 is a link to a screen already drawn in another branch, and 「불러옴 N」
counts the unit tests that import the screen without a tag and is not part of the border or the test count. The icon
is a real button (`aria-expanded`, `aria-controls`) that Tab reaches, Enter or Space opens and closes, and Escape
closes while the flow view is showing; the pointer can move from the icon down into the list without it closing,
also when the bar wraps onto several lines. The bar stays in view when the flow is scrolled in either direction, so
the legend, the icon and the list stay inside the visible area. A screen box's tooltip ends with a line saying that
pressing it opens the screen in the list.
Entry screens that lead to no other screen are gathered under
「더 뻗지 않는 진입 화면 N」 below the branching ones, in as many columns as the window holds, each as wide as the
widest gathered screen, so opening a box's API calls keeps every cell's width and column but pushes the rows below it
down; the calls stack under the box, indented within the column, and every line of a call breaks even inside a word
too long for it; when one branch is shown on its
own, nothing is gathered. 「목록」 switches to the list described
here. The left column lists the screens with a "no tests" filter, a "dead
screens" filter, which keeps the screens that call an API missing on the server (left out when there is no
server list, which also adds a 「서버 대조 안 함」 chip to the header line, with the reason in a popover on
hover or keyboard focus, and shows the calls as 「대조 안 함」), and "opens only under a
setting" and "opens only under a role" filters read from `access.kinds`; a screen that needs both shows under
either, and a restricted screen with empty `kinds` shows under 「링크마다 다름」 instead. A 「지나간 테스트만 있음」
filter keeps the screens that have no test tagged with the screen but at least one test importing their source
files: a pair waiting for the tag counts as importing, a discarded pair does not. The screen's row shows
「불러옴 N」 for the importing tests and 「태그 대기 N」 for the pairs waiting for the tag. (API calls have no importing tests, so the
filter applies to the screen list only.) With `app` set, the middle starts with the chosen screen's app in a frame, served by duru on an address of
its own and already logged in, so the reviewer can use it while marking; the line above the frame shows its
address, a role picker, who the frame is logged in as (「ADMIN 역할 duru-admin 로 로그인」, or why that login
failed, or 「로그아웃 상태」 for a screen in `signedOutPaths`, which has no picker), in red any
`signedOutPaths` entry that matches no screen path in the map, and a link that opens it in a new window. The
picker starts at 「자동」: a screen without a role condition opens as `account`, and one with
`roleValues` as the first role in `roles` whose value is in them, preferring one whose login worked. When no role in `roles` meets them, the
screen opens as `account` and the line says 「조건을 채우는 역할(…)에 계정이 없습니다」; when `roleValues` is
`null`, it opens as `account` and the line lists the unreadable guards; when it is not, any unreadable
guards are still named, in grey. The picker also offers `account`,
each role in `roles`, and, unselectable, each value in some screen's `roleValues` with no account (「계정
없음」). A role picked there stays picked on other screens until 「자동」 is picked again, and the line
says when it does not meet the screen's `roleValues`; the screen still opens as that role. Picking a role
reloads the frame on that role's address with the same path. Marking does not reload the frame. A screen with
path variables opens with its `pathValues` filled in; the line above the frame
shows each variable in a box that the reviewer can change and reopen with Enter or 「다시 띄우기」, and what was
filled or typed stays with the screen and the account it opened as while the page is open; a screen whose list API failed calls it again
when it is chosen again, unless the reviewer has opened it with a typed value. When a required variable has no value, because
none was given or the list API failed or was empty, the frame opens a screen linking to it whose
address its fixed `pathValues` can fill (one without path variables needs none): the first one the account opening the
screen can open (no role condition, or one its role meets), else the first one, as the account the picker gives that screen, with 「목록에서 골라 들어가세요」 and the list API's error; with no such screen it shows
「주소에 값이 필요한 화면」 instead of the frame. A required variable the reviewer clears and reopens does not fall
back: the frame says 「<variable> 값이 없어 이 화면을 띄울 수 없습니다」. The page reads these from `GET /api/path-values?screen=<id>`,
with `&role=<role>` when the frame opens the screen as one of `roles`,
which answers `{ "parts", "values", "errors", "path", "fallback", "fallbackPath" }`: the route path split into text and
variables (`{ "name", "prefix", "optional", "pattern" }`, with `"repeat": true` for `+` and `*`), the value found for each variable, why a value could
not be found, the filled path (`null` while a required variable has no value) and the screen to open instead with its
filled path (both `null` when there is none); an unknown screen or role is 404.
For a screen with setting conditions (the screen opened instead, when the frame falls back to one), a second
line shows the settings named in its route and link conditions, and only those: 「켜기」 and 「끄기」 for one that needs on or off, a select for one that
needs a value, 「목록에 넣기」 for a menu list entry, and 「기본값에 있음」 for one that only has to be present.
Choosing the screen sets what its route guards and the first link into it whose conditions can all be met
need; changing a setting reloads the frame with it. A changed setting and the whole line turn purple, settings
changed on other screens stay changed and are listed there, and 「기본값으로」 puts them all back. A setting
read through another settings root, in a section that is not `merged`, without `app.settingsFile`, or from a
guard whose value cannot be worked out is shown greyed with the reason, and so is a change inside a default
listed under `settingsDefaultsIncomplete` that the settings file does not set. A setting is shown with the
value the app would read without the changes: the settings file's value of the section's key when the file
sets it, else the default in the map, then down the rest of the path. A setting set back to that value is no
longer counted as changed. A setting that only has to be present is met by a truthy value. When the
settings file could not be run, the line says so and the page uses the map's defaults. Below
that, the middle shows the chosen screen's tests grouped by depth and, below them, its API calls: one row
per call with its server match (on the server with its labels, method mismatch, not on the server,
unresolved, or 「대조 안 함」 when there is no server list) and one cell per depth counting the call's tests.
Under a call with on/off options, each option has an on row and an off row, holding the tests that set it to that value, and one more row counts the tests
with no option tag. The options are the same as in the task list: those this screen sends in the source and
those added to the call in `bodyOptions`, the latter tagged 「설정」. An on or off row with no tests at all
stands out in red; the no-option row takes no marks. A call whose address could not be worked out
from the source has no node, so it shows without cells. For a screen, the right starts with 「이 화면을 열려면」:
the settings and roles it needs, in the same words as its box in the flow view (「설정이나 역할 없이 열립니다」 when
it needs neither), every needed value in full, and the blocking route guards. The right then holds, for a screen,
the links into it grouped by the set of guards they carry: the group without guards first, then larger groups
before smaller and, among groups of one size, by the guards' text. Each group shows what its guards need in those
same words and its number of links, and opens to each link, ordered by the screen it comes from, file and line,
with its source location, its guards with their kinds and, when the screen it comes from is restricted itself, what that screen needs, marked 「설정」 and 「역할」 like the guards; a screen whose links ask for different kinds
shows 「링크마다 다름」 here, on the links it makes, in its 「이 화면을 열려면」 and on its box in the flow view.
Route guards that are neither a setting nor a role follow under 「화면 안 조건」, whose heading says they do not
block opening the screen. A guard longer than 80 characters is folded to its start and opens to its full text.
Then come the screen's source location, links and settings reads, or, for a call, where an option value's option was found (file and line
per screen, and whether it is set in the config), its server match, its tests, where the screen calls it and
the screens using it. Between the two, under 「불러오는 테스트」, the page lists the unit tests linked to the screen by the files they import (`importers` in `tests.json`), each with its test file and the source files it came through; the left column shows their number as 「불러옴 N」 under the screen's test count, which they do not add to.
Each of them has 「버리기」 and 「태그 달기로 넘기기」 beside one field: a reviewer who finds that the test only passes
through the screen discards the pair with a reason (required), and it leaves 「불러오는 테스트」 and the 「불러옴 N」
counts (in the list and on the flow boxes, a branch shown on its own included) for 「버린 짝」 below, which shows the
reason, author and date with 「되돌리기」 to bring the pair back. A
reviewer who finds that the test does check the screen hands the pair over for tagging, with a note that may be
left empty: it moves to 「태그 달기 대기」, which shows the note, author and date with 「되돌리기」, and goes to the
task list under `# Tagging` for a coding agent to add the screen's tag to the test. Once the test carries the tag
and `rebuild` has read it, the pair is closed: the test is an ordinary tagged test of the screen and nothing is
shown for the judgment. A handed-over test that the results no longer hold (its file or title changed, or it no
longer imports the screen's files) shows under 「떨어져 나감」 with its test file, title and note, and 「되돌리기」
closes it. A judgment names its test by result source, test file
(its path under `srcRoot`) and title with the tags taken out, never by line or Playwright project, so a discarded or
handed-over pair stays so after a rebuild when lines are added above the test, the title gains a tag or the results
come from another computer; a discarded pair whose test is no longer in the results shows nowhere. Like a mark, each judgment is a new file, `<judgmentsDir>/<node>/<date>-<author>-<short ID>.json`
holding `test` (`source`, `file`, `title`), `node`, `kind` (`discard`, `hand-over` or `undo`), `reason` (the note of a
hand-over, which may be empty), `author` and `date`;
saving never changes an existing file, and the newest judgment of a pair wins. duru stores only these judgments:
the link between a test and a screen is confirmed by the tag in the test code, and what a test passes through is
recomputed on every rebuild. Judgments are applied whenever the
page loads its data and when `rebuild` counts the links made by imports, never to `tests.json` itself; `/api/data`
carries the discarded pairs as `tests.discarded`, the handed-over pairs as `tests.awaitingTag` and the ones no longer
found as `tests.detachedHandOvers`, each with its `judgment`. `rebuild` prints how many pairs are
discarded, how many are waiting for the tag and how many handed over are no longer found among the tests importing
or tagged with their screen. A hand-over whose screen is no longer on the map is not in that count; `rebuild` names
its screen, test and judgment file on a line of its own, because the page has nowhere to show it and only deleting
that file clears it. A hand-over for an API call counts, since calls are on the map. `rebuild` also names each
judgment file it could not read with the reason, without stopping.
The right is split in two. Everything above is in its upper part, the only part that scrolls; the mark form is docked
below it, always in view, for a screen, a call, an option, a depth and a story alike. On a window too short for the
form and a few lines of the upper part, the whole right scrolls instead, so the form can still be reached. The form
has the status buttons,
a memo of about two lines (which can be dragged taller, up to a limit) and the 「표시 남기기」 button; the target's
history is not listed there but sits behind 「이력 N」 next to that button, closed by default, and opens inside the
form to a list with its own scroll. The fold stays open while the pane is redrawn and closes when another target is
chosen. Choosing another screen, call or story opens the upper part at its top, while choosing another depth or
option of the same node keeps its scroll offset. Long addresses and conditions wrap inside the column, and
neither part scrolls sideways.

Next to the screen list, the left column has a tab with the stories: each with its name, ID and number of
screens, its status unless it passes (「실패」, 「보류」, 「일부 화면만 테스트」, 「테스트 없음」), 「링크 없음」 when two
neighbouring screens have no link between them, 「화면 없음」 when a screen is not on the map and 「판정 못 함」
when a step is `unknown`, and below the list the story files that could not be read, with why. The list is
filtered by 「테스트 없음」, 「일부 화면만 테스트」 and 「실패」 under 「상태 · 하나라도 맞으면」, keeping a story in any of the
checked statuses, and by 「링크 없음」 under 「그리고」, which keeps only the stories with a `broken` step on top of that. When `stories.stale` is set,
the request to run `rebuild` replaces the empty-list text and is not counted as a story file that could not
be read. Choosing a story shows in the middle its name with its status (「통과」 too), ID, file, author, date
and memo, its story tests with their depth and status, then its screens in order, each with the number of
its tests per depth and status (the titles show on hover) or 「화면 테스트 없음」, and the verdict of the link
between each two: 「이어짐」, 「조건」 or 「링크 없음」, or 「판정 못 함」 next to a screen the map does
not have or where no link joins the two but the first screen has links to a path duru cannot read (listed
with their source locations and paths), with the source location and conditions of every link; a `conditioned`
step also lists, as left out of the verdict, the first screen's links to a path duru cannot read. Pressing a
screen on the map opens it in the screen list. The right shows first the verdict on every line that applies —
「도달 불가 · 링크 없음 N곳」 with the number of `broken` steps, 「판정 못 함 · 화면 없음」 when a screen is not on the map,
「판정 못 함 · 주소 못 읽은 링크」 when a step is `unknown`, or 「도달 가능」 when none of these is so — and says when a
`conditioned` step was judged with such links left out, then under 「사전 조건」 a summary of what the story needs that states
only what the map proves, in the words of the screen's 「이 화면을 열려면」 but never shortened: one line for the role naming
every value that passes (「역할 ADMIN 또는 OWNER」) and one line per setting (「설정 SYSTEM.LAB_ENABLED 켬」, with the settings
root in front when the story's settings come from more than one root). A story passes every step, so the summary holds
each setting any step needs, once, and only the roles every step allows. A route step needs all its setting and role
guards. A step that several links reach needs only what every link needs and the roles any of its links allow; when the
links differ in more than their roles and no link needs only the shared part, the step shows 「링크마다 다름」 after its
name. A first screen needs its route guards and, when it can be entered only through blocked links, what every incoming
link needs; it shows 「링크마다 다름」 when its incoming links differ in their setting conditions or its 「이 화면을 열려면」
says only that, 「설정 필요」 when the map says a setting blocks it but none of its setting conditions could be stated, and
its roles are those of 「이 화면을 열려면」. A guard a link inherits from a handler counts only when the link has no
guard of its own and inherits exactly one, since only then is the handler used in a single place, under that guard; any
other inherited guard is neither needed nor contradicting, and is listed apart. Steps whose role values hold every role
that can pass them but share no value show 「모든 단계를 지나는 역할 없음」 with each such step's roles. Setting needs on one
path that cannot hold together show as 「서로 어긋나는 설정」 instead of as needs: off with on, present, a value in a list or
equality to a true value, and equality to two different values of the same type; the other needs on that path stay need
lines. Under 「요약에 넣지 못한 조건」 the summary lists what it cannot state: role conditions whose roles were not read (for a
step that several links reach, only those on every link), steps whose role is not known (「역할 미확인」) or was read only in
part (「역할 일부만 읽음」, also a first screen with an incoming link that inherits a role guard counted as not decided),
setting conditions that could not be decided, and the inherited guards that depend on where their handler is used, named
with the handler; the role line, when there is one, then carries 「미확인 N」 with the number of role entries listed there.
The summary says 「설정이나 역할로 막는 조건 없음」 only when it has no line and lists nothing apart. A fold,
closed by default, holds the source location of each condition as written, with 「링크 N개 중 하나」 over a step that several
links reach; the fold and its long conditions stay open while the pane is redrawn or a screen is opened, and close when
another story is chosen. Below the right's scrolling upper part, the docked mark form
is for the story, with its history behind 「이력 N」; the story list shows each story's current mark, and under the list 「떨어져 나감」 holds the marks
whose story file is gone (the screen list's 「떨어져 나감」 holds only marks on screens and calls). Marks on
stories missing from the list because their file cannot be read, or while `stories.stale` is set, are listed
under 「목록 밖 스토리 표시」 below the story files that could not be read; choosing one opens its mark form, alone
at the top of the right.
Stories are read again whenever the page loads its data, so a story file written during the review shows after
a reload.
`/api/data` carries the checked stories, each with its `status`, as `stories.list`, the notes as
`stories.notices` and the story tags that no story file has as `stories.unknownTags`.

The left column has a third tab, 「태그 없는 테스트 N」, listing the tests that carry no node tag and no story tag
(`untagged` in `tests.json`) with their status and test file and line, and a search box over their titles and
files. Choosing a test shows in the middle its title, status, test file and line, result source and format, then
its pairs with screens (the screens it reaches through the files it imports, and the screens it was judged
against), each with the source files it came through and the state of the pair: 「불러옴」 for a plain importing test, 「태그 달기 대기」 for a pair handed over for tagging (with its note,
author and date), 「떨어져 나감」 for a hand-over of a test that no longer imports the screen (with its note, author
and date) and 「버린 짝」 for a discarded one (with its reason, author and date). Pressing a screen opens it
in the screen list; a screen no longer on the map shows as 「맵에 없는 화면」 and cannot be opened. A test whose
imports were read and lead to no screen says so, adding that a file shared by more than three screens and an
import that was not found link nothing. A test whose imports were not read, because its result format
(JUnit, Playwright, verdict) carries no imports or because its test file was not found under `srcRoot`, says
that instead. A `tests.json` from before the list existed has the count but no list: the tab shows the count and
the middle asks for `duru rebuild`. Every 「불러옴」 pair whose screen is on the map has a checkbox, and a 「모두 고르기」 box picks all of
them; with pairs picked, one reason or note and the buttons 「버리기」 (the reason is required) and 「태그 달기로 넘기기」
(the note is optional) judge them all at once, each button showing how many pairs are picked. The page sends one
judgment per picked pair, one after another in the order shown, so the result is the same as judging them one by one
on the screen, and each can be undone there with 「되돌리기」. While the pairs are being sent, the checkboxes and buttons, the
other tests, the left tabs, the 목록/흐름 switch, the pair rows and 「리뷰 끝」 are disabled, and the whole bulk is
signed with the author read when it started; while 「리뷰 끝」 is being sent, the two bulk buttons are disabled too. When the bulk ends,
the keyboard focus returns to the button that was pressed, or to the first control of the bar when that button is off. If a request fails midway the rest are not sent, the data is
read again, the unsaved pairs stay picked, and the message beside the buttons names the pairs that were saved and
those that were not. The picks, the note and that message stay when the reviewer opens a pair's screen and comes back
to the same test, and go when another test is chosen. A pair for a screen that is not on the map cannot be picked, as it cannot be judged on the screen
either. 「리뷰 끝」 works on a page whose data has not arrived or could not be read. `/api/data` carries the list as `tests.untagged`, each entry with its `ref`, the
same reference a judgment names the test by.

A mark targets a screen or an API call, or one depth of either, or one value of a call's option, or one depth
of that value (`{ "node": "POST:/api/v1/report/export", "option": { "key": "withHistory", "value": true },
"depth": "output" }`), or a story (`{ "story": "run-lab" }`, with no `node`, `option` or `depth`: a story has
no cells), and records a status (`needs-more`, `missing`,
`fine`), a note, the author and the date. The author is `git config user.name` on the machine serving the
page; when it is not set, the page has a name field in the header and warns above the 「표시 남기기」 button only when a mark
is saved without a name, saving nothing. A save that fails, or goes through but cannot reload the data, is reported
in the same place; if another target is shown by then, the message names the target the save was for (「스토리」 and
the story's name, or the node ID with the option and depth as the form heading writes them), and a status or memo
picked after the reviewer chooses another target, there or back on the first one, is kept when the save goes
through, while a form left untouched after coming back shows the saved mark. Marks are never overwritten: marking a
target again adds to its history, and the latest mark is its current state.

Each mark is its own file, `<marksDir>/<node>/<date>-<author>-<short ID>.json`, or
`<marksDir>/stories/<story ID>/<date>-<author>-<short ID>.json` for a story, and saving a mark only
creates a new file. Marks added on two machines therefore never touch the same file and merge in git without
a conflict, and the file list of a pull request reads as which screens, calls and stories were marked, by whom
and when.
The folder is the screen or call ID with characters that file names cannot hold replaced by `_`; which node a
mark belongs to is read from the `target` inside the file, not from the folder. `rebuild` never touches the
marks folder. A mark whose screen or call is gone from a rebuilt map, or whose option is no longer among the
call's options, stays where it is and shows up under "detached" until someone deals with it. A mark on a story
is detached only when no file for that story ID is left in `storiesDir`: one whose file is there but cannot be
read stays attached, and so do marks on stories while `stories.stale` is set.

`review` prints the page address and the marks folder on standard error and keeps running until the review
ends. Pressing 「리뷰 끝」 on the page, or Ctrl+C in the terminal, closes the server, prints the task list on
standard output (the same text as `tasks`, with the marks made during the review) and exits with code 0. A
coding agent that launched the page therefore receives the task list as soon as the reviewer is done. If the
list cannot be built at that moment (a mark file that is not valid JSON, for example), the page or the terminal
shows why and the review keeps running, so it can be ended again once that is fixed. Like
saving a mark, ending the review needs a JSON request to the page's own address, so another site open in the
same browser cannot end it.

## Task list

`tasks` prints, as Markdown on standard output, every screen and API call whose current mark on the whole
node, on one depth or on an option value is `needs-more` or `missing`, and every story whose current mark is. Marks whose current state is `fine` and detached marks are left out. Each
screen comes with its open marks and notes, the component file and route line, the app address when `appUrl`
is set, the settings and roles it needs and where they are checked (with each link in, its guards and what
the screen it comes from needs itself when it is restricted; `differs by link` for a screen, or the screen a link comes from, whose links
ask for different kinds), the API calls it makes with their tests
and their on/off options (those this screen sends in the source and those added in `bodyOptions`), and the tests already attached with their depth and status. Under a
call with options, one line per option value (`withHistory=true`, `withHistory=false`) and one for tests with
no option tag (`no option tag`) count the tests by depth and status. API calls with an open mark follow under
`# API calls`, each once however many screens call it, with its marks, the screens calling it, its server
match and the tests already attached. A mark on an option value reads `withHistory=true` or
`withHistory=true at output depth`; under `marked options`, each marked option says where it was found
(file and line with the screens, or set in the config), and each marked cell lists the tests already in it.

Stories with an open mark follow under `# Stories`, in ID order, below a line naming the story folder. A story
is listed for its mark, never for having no tests. Each comes with its name, its open mark and note, its
file with author and date, its memo, its status, its story tests with depth and status, its screens in order,
each with its tests counted by depth and status (or `not on the map`) and the link to the next screen (`open`
or `conditioned` with each link's source location, `no link`, or `not judged` with why), then `reach`
(`reachable`, `unreachable, no link at N steps`, or `not judged` with why) and `preconditions`: the
「사전 조건」 of the review page, with the setting and role guards and every link into the first screen when it
opens only under one, the route guards with their line, and the guards of `conditioned` links with their source
locations. A story whose file is there but cannot be read lists only its mark and says so; `rebuild` prints
why. While `stories.stale` is set, each story lists only its mark, under a request to run `rebuild`.

A screen, call or story ends with `empty tests`: for every test format in the config's `tests`, in the
order the formats first appear there, one empty test with the item's tags already in its title, so the writer
fills in only the data setup and the checks. A screen or call gets one set per open mark, with
`@screen:<screen ID>` or `@call:<call ID>`, plus `@option:<key>=true|false` and `@depth:<depth>` when the mark
is on an option value or a depth; a whole-node mark leaves the depth to the result source. A story gets one
set with `@story:<story ID>` and the `@screen:` tag of each screen on its path that is on the map, once each.
Each empty test is held back so that a copy run as it is does not pass: Playwright gets `test.fixme(...)`,
Vitest `test.todo(...)` with no function, JUnit a `@Test @Disabled` method (which needs
`import org.junit.jupiter.api.Disabled;`) with the title in `@DisplayName` and a name made from the item and
the marked cell, and a check script one verdict line, `VERDICT <what it checks>: <verdict> — <what was seen>`
with the tags at the end, whose `<verdict>` counts as pending. Filling one in means removing `.fixme` or
`@Disabled`, or turning `test.todo` into `test` with a function, or writing one of the verdict words above in
place of `<verdict>`; a verdict name ends at the first `: `, so the filled name must not hold one. A test that
keeps those tags in its title attaches to the item after a `rebuild`. With no `tests` in the config, the item
says so instead. A story listed only with its mark, because its file could not be read or the map is stale,
gets no empty tests. duru writes only these empty tests, never their contents.

Pairs handed over for tagging on the review page follow last under `# Tagging`, whether or not a mark is open, one
item per pair in the order of test file, line, title, result source and node. Each says `<test file>:<line> → <node>`
and holds the test's `title`, the `tag to add` (`@screen:<screen ID>` or `@call:<call ID>`), `where` the tag goes in
the test's format and the reviewer's `note` with author and date. The tag goes in the test's `tag` option for
Playwright (the title stays as it is), at the end of the test's own title for Vitest, at the end of its
`@DisplayName` for JUnit and at the end of its `VERDICT` line for a check script. An item leaves the list once the
test carries the tag, the test has been run again so its result file holds the tag, and `rebuild` has read it. An
item also leaves, without being done, if the test's file changes or its title changes in any way other than the
added tag. Only pairs waiting for the tag are listed; duru never edits the test file.

The list starts with how to tag new tests so that they attach after a `rebuild`. Adding tests does not take a
screen, call or story off the list; a reviewer marking it `fine` does.
`test/fixtures/app/example-marks` holds example marks for the fake client, among them marks on the example
stories and one on a story that has no file.

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
