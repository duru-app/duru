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
through the verdict lines they print. A local review page lets a person mark gaps on screens, and a task list
hands the marked screens to a coding agent.

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
  (`<label>\t<METHOD>\t<path>` per line, `{var}` for path variables)
- `tests` — test results to attach, each `{ "format": <playwright|junit|vitest|verdict>, "path": <file or folder>, "depth": <ui|api|render|code|data|output> }`.
  A folder is searched for `.json` files (Playwright, Vitest), `.xml` files (JUnit) or `.txt` and `.log`
  files (verdict); files in another format are skipped
- `outDir` — where `map.json` and `tests.json` are written (default: the config's folder)
- `marksDir` — folder where review marks are kept (default: `marks` in `outDir`)
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
routes. The wrapper's API calls, settings reads and links therefore belong to each screen it wraps. A guard
around the wrapper is a route guard of every screen inside it, so the wrapper's links count as coming from
restricted screens and do not repeat that guard.

A menu built from a settings list, where the route is picked by the first parameter of a `forEach` or
`map` callback over the list (`MENUS.ADMIN?.LIST?.forEach((menu) => ... Option.ROUTE_PATH[menu])`), gives one
link per entry of the list's default value when the list is read from a `settingsDefaults` root, directly or
through local consts. Each of these links also carries the setting guard
`globalSettings.SYSTEM.MAIN_MENU.ADMIN.LIST includes 'ADMIN_REPORT'`. Entries that are not route names are
skipped, and a route picked by any other computed key is left out.

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

When several server paths fit one call, the one whose path variables and fixed names line up with the
client URL wins, then the first in sorted order. The same character replacement as for screen IDs applies.
Each call node lists its `method`, `path`, `server` match, the API functions that make it and the screens
that reach it. Every endpoint under `apiFunctions` carries the `callId` of its node (`null` when unresolved),
and a screen is marked `dead: true` when it reaches a call whose server match is `none`. An unresolved call
alone does not make a screen dead.

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
handler it sits in is guarded. A link enters the route with the
same path, or, when there is none, every route that only adds parameter segments to it (`/document` enters
`/document/:id`); links to a partly unknown path, and a screen's links to itself, are left out. `access`
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

`tests.json` lists the tests per node ID, each with its own depth and status (pass, fail,
pending; skipped and todo count as pending), the tags that point at IDs not on the map, name an unknown
depth, or are option tags with no call of the test to attach to or a value other than `true` or `false`,
how many tests carry no node tag, and configured result paths that do not exist yet.
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
tags go at the end of the line.

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
the notes with a count of stories, broken paths, detached stories and `unknown` steps, and the review page
lists them under the stories. The other stories are read as usual.

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

A `map.json` written by a duru whose links did not carry `conditions` yet cannot be checked: while there are
stories, the review data lists no story and carries one message asking to run `rebuild` as `stories.stale`,
apart from the notes on story files; the rest of the review page and `tasks` work as usual.

`test/fixtures/app/example-stories` holds example stories for the fake client: one that connects end to end,
one through a link guarded by a setting, one with no link between two of its screens, one with a screen that
is not on the map, and one malformed file.

## Review page

`review` serves a local page that reads `map.json` and `tests.json` from `outDir` (run `rebuild` first) and
writes only into the marks folder. The left column lists the screens with a "no tests" filter, a "dead
screens" filter, which keeps the screens that call an API missing on the server, and "opens only under a
setting" and "opens only under a role" filters read from `access.kinds`; a screen that needs both shows under
either, and a restricted screen with empty `kinds` shows under 「링크마다 다름」 instead. With `app` set, the middle starts with the chosen screen's app in a frame, served by duru on an address of
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
per call with its server match (on the server with its labels, method mismatch, not on the server, or
unresolved) and one cell per depth counting the call's tests. Under a call with on/off options, each option
has an on row and an off row, holding the tests that set it to that value, and one more row counts the tests
with no option tag. The options are the same as in the task list: those this screen sends in the source and
those added to the call in `bodyOptions`, the latter tagged 「설정」. An on or off row with no tests at all
stands out in red; the no-option row takes no marks. A call whose address could not be worked out
from the source has no node, so it shows without cells. The right holds the mark form and, for a screen, why
it opens only under a setting or a role (the blocking route guards and every link into it with its guards,
their kinds and, when the screen it comes from is restricted itself, what that screen needs, marked 「설정」 and 「역할」 like the guards; a screen whose links ask for different kinds
shows 「링크마다 다름」 here, on the links it makes and on its box in the flow view), its source location, route
guards, links and settings reads, or, for a call, where an option value's option was found (file and line
per screen, and whether it is set in the config), its server match, its tests, where the screen calls it and
the screens using it.

Next to the screen list, the left column has a tab with the stories: each with its name, ID and number of
screens, 「링크 없음」 when two neighbouring screens have no link between them, 「화면 없음」 when a screen is not on the
map and 「판정 못 함」 when a step is `unknown`, and below the list the story files that could not be read, with
why. When `stories.stale` is set, the request to run `rebuild` replaces the empty-list text and is not counted
as a story file that could not be read. Choosing a story shows in the middle its name, ID, file, author, date and memo, then its screens in order
with the verdict of the link between each two: 「이어짐」, 「조건」 or 「링크 없음」, or 「판정 못 함」 next to a screen the map does
not have or where no link joins the two but the first screen has links to a path duru cannot read (listed
with their source locations and paths), with the source location and conditions of every link; a `conditioned`
step also lists, as left out of the verdict, the first screen's links to a path duru cannot read. Pressing a
screen on the map opens it in the screen list. The right shows first the verdict on every line that applies —
「도달 불가 · 링크 없음 N곳」 with the number of `broken` steps, 「판정 못 함 · 화면 없음」 when a screen is not on the map,
「판정 못 함 · 주소 못 읽은 링크」 when a step is `unknown`, or 「도달 가능」 when none of these is so — and says when a
`conditioned` step was judged with such links left out, then under 「사전 조건」 the source location of each condition,
with 「링크 N개 중 하나」 over a step that several links reach.
Stories are read again whenever the page loads its data, so a story file written during the review shows after
a reload.
`/api/data` carries the checked stories as `stories.list` and the notes as `stories.notices`.

A mark targets a screen or an API call, or one depth of either, or one value of a call's option, or one depth
of that value (`{ "node": "POST:/api/v1/report/export", "option": { "key": "withHistory", "value": true },
"depth": "output" }`), and records a status (`needs-more`, `missing`,
`fine`), a note, the author and the date. The author is `git config user.name` on the machine serving the
page; when it is not set, the page asks for a name. Marks are never overwritten: marking a target again
adds to its history, and the latest mark is its current state.

Each mark is its own file, `<marksDir>/<node>/<date>-<author>-<short ID>.json`, and saving a mark only
creates a new file. Marks added on two machines therefore never touch the same file and merge in git without
a conflict, and the file list of a pull request reads as which screens and calls were marked, by whom and when.
The folder is the screen or call ID with characters that file names cannot hold replaced by `_`; which node a
mark belongs to is read from the `target` inside the file, not from the folder. `rebuild` never touches the
marks folder. A mark whose screen or call is gone from a rebuilt map, or whose option is no longer among the
call's options, stays where it is and shows up under "detached" until someone deals with it.

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
node, on one depth or on an option value is `needs-more` or `missing`. Marks whose current state is `fine` and detached marks are left out. Each
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
(file and line with the screens, or set in the config), and each marked cell lists the tests already in it. The list starts with how to tag new tests so that they attach after a
`rebuild`. Adding tests does not take a screen or call off the list; a reviewer marking it `fine` does.
`test/fixtures/app/example-marks` holds example marks for the fake client.

## Agent skill

`skills/duru/SKILL.md` is a skill for a coding agent such as Claude Code. When the user asks for a duru review,
it has the agent rebuild the map, launch `review` and hand the address to the user, write the tests in the
target project from the task list it receives when the review ends, and rebuild again to confirm they attach.
duru itself never calls a model. Install it by copying or symlinking the folder into the project's
`.claude/skills` folder, or into `~/.claude/skills` for every project:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/duru" ~/.claude/skills/duru   # run from this repository
```

## License

MIT
