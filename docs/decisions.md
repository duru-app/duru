# Decisions so far

Early-stage record of what has been decided, why, and what is still open. Read this before writing the
PRD or changing the extractor's output shape.

## The loop duru is for

1. Build a screen map of an app: entry points → menus → screens → buttons/actions, covering every screen
   reachable under **any** configuration value, and flagging dead screens (the screen calls an API the
   server does not have).
2. Attach to each node the tests that cover it, their depth (UI/E2E, API, render-only, code, data,
   output — the content of what the app produces) and their status (pass, fail, pending).
3. A person reviews the map and marks nodes or test cells: "needs tests" or "fine", with a note.
4. A coding agent (a Claude Code session) reads the marks, writes and runs the missing tests, and
   regenerates the map.

Constraints: the loop runs on a PC (mobile is not required). The first target is an in-house product,
but the tool must be reusable for any project's QA.

## Decided

**Compute the map from source; do not observe a running instance.**
The target products are installed per customer. There is no production traffic to learn from, and each
customer runs a different configuration. Crawling one deployment or replaying traffic only shows the
screens of that one configuration. Reading the source shows every screen and the condition that opens it.
A local test stack is used to confirm the computed map, not to build it.

**A program extracts the skeleton; the agent fills in meaning; the program checks the agent.**
- The program extracts facts that can be read mechanically and must be reproducible: routes, the API calls
  reachable from each screen, the server endpoint list, where settings are read, links between screens and
  the conditions guarding them. It also assigns node IDs.
- The agent fills in what the program cannot follow in general: conditions threaded through hooks, props
  or stores, button-level conditions, and grouping screens into user flows. Every claim carries the source
  location it rests on.
- The program then checks the agent's additions: every cited location exists, and no screen in the
  skeleton is missing from the result.
Reason: an agent working alone gives slightly different results on every run, which would detach human
marks from their nodes, and its omissions are silent. In the first hand-drawn map, the agent checked the
condition on a link but not whether the server still had the API behind it; a reviewer had to catch it.

**Two files, joined on stable node IDs.**
A generated `map.json` (nodes, guarded edges, calls per screen, tests per node with depth and status) and a
separate marks folder (one file per reviewer mark, keyed by node or cell ID: status, note, author, date). Regeneration
rewrites the first and never touches the second. Node IDs come from route and component names, not DOM
hashes, so they survive regeneration.

**The review surface is replaceable.**
Everything hard runs in the repository on the PC (extraction, the client/server join, test runs). The
review page only renders `map.json` and writes marks. A local page is the default; a claude.ai
Artifact page can be one optional front end. Making the Artifact the architecture would tie the tool to
claude.ai: its stored marks and its "send to Claude" comments are claude.ai features that only a Claude
Code session can read.

**Route files are listed in the config.**
`routesFile` takes one route file or a list of them, and duru reads those files and no others. Every screen,
redirect and route condition carries the route file it is written in, and everything shown about a route
(the map, the review page, the task list, the evidence of an access verdict, the duplicate-ID notice) names
that file.
Alternative compared: give one root route file and follow its imports to find the others.
Reason: what is read is visible in the config. Following imports would have to read code that builds routes by
mapping over arrays or spreading lists of routes, which is easy to miss silently: a route file that is not
followed leaves screens off the map and nothing says so. With a list, a missing file is a visible gap in the
config that the reader of the config can see.

**Project-specific data never lives in this repository.**
Each target project's config, exported source, endpoint lists and generated maps live outside this repo.
The repository holds only generic code.

**The first version maps screens and the API calls made from them.**
Buttons, option controls, the menu tree and roots without a screen come later. On/off options carried in a
request body, and the output depth, are specified in https://github.com/Inte-H/duru/issues/29
Reason: most defects sit in actions, and a screen-only map shows a screen with a single render test as
covered. API calls are the action unit the program can extract reproducibly and already joins with the
server.

**A test declares the node it covers with a tag.**
Test runners carry it in the title; standalone check scripts carry it on their verdict line.
Reason: putting case IDs in test titles is the most common traceability practice; a sidecar file drifts
when tests are moved or renamed. A check script can print several verdicts, so the tag belongs to the
verdict, not to the file. Recording which screens a test visited at run time can come later as a
separate signal for "passed through but not asserted".
The confirmed link between a test and a node lives only in the test code's tag. What a test merely passes
through (today, the source files it imports) is recomputed on every rebuild and shown apart from the tests
that carry the tag. duru stores only the reviewer's judgments on such a pair: hand it over for tagging,
discard it, or undo either. A handed-over pair goes to the task list, and a coding agent adds the tag; once
the tag is read the pair is an ordinary tagged test and the judgment closes by itself. duru never edits test
files.
Reason: one source of truth for the link. A stored link beside the tag could disagree with it, and one more
place would have to be kept in step. Renaming or moving a test does not orphan a stored link, because none is
stored: a judgment names the test by result source, file and title without tags, and one that no longer finds
its test shows as detached instead of silently counting. Each judgment is its own file, so judgments from two
reviewers merge without conflict.

**The review page has its own layout; prior art supplies ideas only.**
The data on this map (configuration conditions, dead screens, test depth) differs from what other tools
show, so their layouts do not carry over.

Scope, node ID rules, tag syntax, depth and status mapping, and the page layout are specified in the
first-version PRD: https://github.com/Inte-H/duru/issues/1

**Import aliases are read from the project's tsconfig; the duru config has no item for aliases written by hand.**
The duru config names the tsconfig file (`tsconfig`), and duru reads its `paths`, `baseUrl` and `extends`.
Alternatives compared:
- Aliases written by hand in the duru config: a second copy of what the project already declares, which has to
  be typed in whenever duru is attached to a project and drifts when the project changes its aliases.
- Both: two keys that can disagree need a rule for which wins, and a reader of the config can no longer tell
  where an alias comes from.
Reason: the tsconfig is already the one place the client's aliases are written, so there is nothing to copy by
hand when attaching duru to a project, and one source needs no precedence rule. A key for aliases written by
hand is added if an app turns up that keeps its aliases only in its bundler config.

**Settings defaults a function builds are read by running a `constants` module; a shape the config cannot point
at is reached through a small module beside the duru config.**
`settingsDefaults` names a `constants` name, optionally with a dotted path into its value, like `routeConstant`.
Alternatives compared:
- A `constants` name alone, its whole default export: cannot reach defaults kept in one member of an object or
  in a named export, and a dotted path already covers it.
- Arguments written in the duru config to call an exported function with: works only for arguments JSON can
  write, and each new way of building defaults would need another key.
Reason: a dotted path covers every value a module holds once it has run, and a module the person attaching duru
writes covers every other shape (a function never called at load, one that needs arguments, several calls
combined) with no key per shape and without touching the client's source.

**TypeScript files a `constants` module runs are turned into JavaScript by Node's transform mode, and the line of
a failure is put back on the file as written through the source map that comes with it.**
Alternatives compared:
- Stripping the types only, Node's default mode: every line stays where it was, but an `enum`, a `namespace` or a
  constructor parameter property stops the extraction, and a client cannot be asked to rewrite its constants for
  duru.
- Bundling with an outside compiler such as TypeScript or esbuild: reads every syntax, JSX too, but adds a
  dependency for what Node already ships, and its compile options have to be kept in step with the client's.
Reason: transform mode comes with the same Node 22.13 that duru already needs and runs what stripping refused. It
prints the code anew, so lines move, and the source map puts a failure's line back on the source; a failure on a
line that has no mapping of its own names the file without a line. JSX still stops the extraction in both modes
(a file holding it that a `calledApiModules` file only reaches by import is now stood in, as written below),
and a CommonJS `import x = require(…)` or `export =` is stopped before running with its line, since transform
mode turns it into `require` and `module.exports`, which the module duru runs cannot use; an `import type x =
require(…)` is let through, because transform mode drops it. Measured: the two examples, the into-sign 1.5.0 map
and the into-sign 2.0.0 source, with its own constants files and with the stand-ins kept beside its config, give
the same maps before and after.

**A component's name is followed further than the line that imports it only when it leads to a dynamic import;
otherwise the component file is the file that line names.**
A screen kept in a table of lazy components gets the file its own entry loads. A component imported by name
from an index file keeps the index file as its component file, as before.
Alternatives compared:
- Following every name to the file that declares it, through index files too: the same screen gets the same
  file however it is imported, but the component file and the sources of screens on existing maps can move, an
  index file that does work of its own drops out of the screen (its API calls were lost in a trial), and it
  contradicts the documented rule that a file is followed whole.
- Keeping the imported file for every name that is imported: a module of `export const X = lazy(…)` lines stays
  the one component file of all its screens, which is the defect this lookup exists to remove.
Reason: maps that exist do not move. Measured before and after the change: the JavaScript example (11 screens)
and the into-sign 1.5.0 map (45 screens) are identical, and on the into-sign 2.0.0 source 43 of 44 screens go
from no component file to their own. The screen ID does not hold the file, so changing this later costs a few
lines and no marks, judgments or stories.
What counts as a dynamic import a name leads to is decided by where a function stands, the first argument of
a call, and by how sure the answer has to be. A name the route file imports by a plain `import` already has a
file, so that file is replaced only when the function returns the module it loads. Every other name has no file
from the route file alone, so a loader of any shape is read there, and the file is the last source file among
the dynamic imports in its own statements and in what it returns. A function whose imports all sit in callbacks
written in statements of their own is neither: a component keeping a callback for later and a loader passing
through `retry(…)` look alike there, so a table entry of that shape is reported as having no component file
instead of being given the file holding the table.
Alternatives compared:
- One wide test for every name: a screen component wrapped in a call (`export default memo(Home)`) lost its
  file to a module its body imports, which changes maps that exist.
- One narrow test for every name: each loader shape it did not list (a preload before the import, a
  condition, a promise built by hand) fell back to the file holding the table, which gives one screen the
  sources of every screen in it.
- Choosing the test by where the function sits (table entry or whole export) instead of by the name at the
  route: a `lazy(loader)` declared in the route file around a loader imported from another module then stayed
  on the module of loaders.
Reason: where the route file already answers, a wrong guess costs a map that exists, and where it does not, a
wrong guess costs nothing that exists. The price is that one component can get two files under two names
(`import { Home }` keeps the file holding `export const Home = lazy(() => retry(…))`, `Pages.Home` reaches the
screen), and that a loader passed as a later argument, or inside an object under another key than `loader`, is
left unread, because those places also hold options and lifecycle callbacks of a wrapped component.

**When the screen is picked among an element, the components inside it and the components passed to it, an
outer element whose file is found only by following its value counts as one without a file.**
The components inside and the passed components use the file the lookup finds.
Alternatives compared:
- Using the found file for the outer element too: one rule, but `<Guarded Page={Home} />` with
  `const Guarded = withAuth(Layout)` changes from `…#Home` to `…#Guarded`, and marks, judgments and stories hang
  on the ID, so they come loose on the change and again if it is taken back.
- Not using a newly found file for picking at all: no ID ever changes, but a screen taken from a table and put
  inside a wrapper is named after the wrapper, so every such screen of an app carries the same name.
Reason: a wrapper keeps the name the screen has today, and screens from a table get their own names. An ID
still changes where a component inside, or one passed as a prop, gains a file and stands before the one named
today (`<Layout><Pages.Admin /><Home /></Layout>` was `…#Home` and is `…#Pages.Admin`). A route written
`component={pages.Home}` was named `undefined` and is now named `pages.Home`, so its ID changes too. Measured: no
ID changes on the two examples, the into-sign 1.5.0 map and the into-sign 2.0.0 source.

**A screen's sources do not follow a dynamic import into the component file of another screen.**
While collecting the files a screen reaches through imports, duru does not follow an `import(…)` that leads to a
file that is the component file of a different screen on the routes, unless the same file also imports it with
a plain `import`. The files the screen starts from, its own component file and the components wrapped around
its route, are always read. There is no config key for it.
Alternatives compared:
- Stopping at another screen's component file however it is imported: the same numbers on into-sign, but a
  screen that renders another screen's component, or uses a hook or helper that file exports, loses its calls,
  setting reads and links, and so does every screen importing through an index file that is a screen's
  component file.
- Stopping at every file that the sources of another screen contain: a navigation helper or a component shared
  by several screens drops out of all of them, with its calls, setting reads and links.
- A config key listing files not to follow: it fixes the one table at hand, but every project has to find and
  list such files, and a table added later brings the defect back until someone updates the list.
Reason: a dynamic import of another screen's component loads that screen ahead of a move to it, so what the
file holds belongs to that screen, while a plain import runs the file inside the importing screen. On the
into-sign 2.0.0 source (`release/2.0.0` at `0f436776f`) a navigation helper imports a table that preloads
screens, and every screen using the helper took in the files of every screen in the table. Measured before and
after: link rows 2,273 → 411, distinct links (from screen, to address) 1,030 → 268, setting-read rows 2,546 →
451, entry screens 17 → 24 (screens only their own sources link to), distinct setting keys 15 and screen IDs
unchanged. The into-sign 1.5.0 map and the JavaScript example map are identical apart from the time they were
written. The price is that a screen which lazily loads another screen's component to render inside itself
loses that component's links, setting reads and calls.

**API methods that find their address in another table are called, and the request they send is recorded.**
`calledApiModules` lists files exporting API objects or API functions; `requestFunction` names the function
the app sends its requests through, as the API code imports it, and where the method and the address are among
the values it is given. duru runs those files with that import replaced by a recorder, calls every exported
function and every method of every exported object once, and keeps the method and address each call hands
to the recorder. The prefix comes in as the app adds it. A piece of the address that came from the fake value
is written `{?}`, which the server comparison already reads as a path variable. `apiModules` stays as it was.
Alternatives compared (driver's decision, 2026-10-07, recorded in the planning issue):
- Running only the address tables and joining them to the methods by reading the source: every project would
  have to write how its methods point into the tables and which prefix each table gets (five or more on
  into-sign), the rules grow with each app, and a client that builds addresses from pieces is not read at all.
- Replacing the HTTP library with a recorder: on into-sign the app stops in its session check before any
  request, so 0 of 290 methods were recorded.
Choices made inside it:
- The fake value is tried in three shapes, one after another, and the first call that sends a request and ends
  without an error is kept, else the one with the most requests: a value that gives itself back for any key
  and can be called, then an object whose every key gives a text, then one whose every key gives the number
  0.7310595213. into-sign checks that a path value is a text or a number, so the first shape alone left 256 of
  309 methods without an address; with the three, 51. The number is below 1 so that a loop running up to it
  stops after one round: a whole number large enough to stand out in an address made such loops run billions
  of rounds, and a small one flooded the map with an address per round. An attempt sending more than 20
  requests is still dropped; the most any into-sign method sends is 8. A memory limit on the worker was not
  set: measured, a worker filling its heap with small arrays ended the whole duru process instead of only the
  worker, so a method that keeps allocating is stopped by the time limit alone. A fourth shape, tried last, came
  later; see the entry on keys named like an id.
- The run happens in a worker thread. A method that waits forever, or loops, is stopped after one second, the
  worker is started again and the run goes on after it. In the main thread a looping method would hang the
  extraction and a late failure of a called method would end the process.
- An outside package name that `constantStubs` does not give, default exports included, is filled with a value
  that does nothing and turns into `{?}` in an address, only in this run; constants and settings defaults still stop on it, so a wrong value cannot slip into the map quietly.
- TypeScript `private` and `protected` members are not called, whether methods, methods bound in the
  constructor or functions given to it: they cannot be called from a screen, and calling them with fake values
  gave the only address the server list did not have.
- A method that gave at least one address and then failed keeps its addresses and is not printed; the printed
  lines are for methods the map has no address of. 20 methods on into-sign record their request and then fail on
  the fake response.
- A screen's sources do not go into the listed files, like `apiModules`. A call attaches to a screen where a
  file of the screen calls `object.method(…)`, `function(…)` or the same through a namespace import, so a hook
  file brought all of its calls to every screen importing it, until the entry below.
- Two listed files exporting different objects under one name, or a name `apiModules` already has, get the file
  path in front of the name (`domains/signing/api/index.ts#linkDocumentApi.search`); into-sign has two such names.
Measured on into-sign 2.0.0 (`release/2.0.0` at `0f436776f`), ten `domains/*/api/index.ts` files and
`executeRequest` from `@domains/_shared/api/axiosInstance`, before and after: API functions 0 → 309, calls
0 → 196, screens with a call 0 → 42 of 44, screen–call pairs 0 → 2,656; 231 methods gave an address, 51 gave
none and are printed, 27 sent no request. With the 1.5.0 server endpoint list added for the measurement only,
all 245 addresses match a server endpoint. Links (411 rows), entry screens (24), conditions and screen IDs are
unchanged; setting-read rows go 451 → 408 because the request-encryption setting read inside the request
module, and a menu setting reached only through the API files, no longer attach to screens. The into-sign 1.5.0
map and the JavaScript example map are identical apart from the time they were written.
The limits: a method whose address depends on a value it is given shows only the branch the fake value takes;
a method that copies its argument with `...` copies no key, because the fake value cannot know its keys; a
namespace import of an outside package without a stand-in gives no names; a dynamic `import(…)` inside a listed
file does not run.

**API code that calls `get` or `post` of a request object is read through `requestFunction` with `"object": true`.**
`{ "import", "name", "object": true }` says that what the API code imports is an object whose `get`, `post`,
`put`, `patch` and `delete` it calls with the address first. duru puts in its place an object that records the
name called as the method and the first value as the address; `head` and `options` are recorded the same way,
and `request` or calling the object itself takes them from `method` and `url` in the config, or the address
from a first value that is text, as axios does. `create` on it gives another such object, which puts the
`baseURL` it is given in front of every address without a scheme, when that `baseURL` is text in the run; given
no `baseURL`, it keeps that of the object it was made from, and given one that is not text, it puts none. Any
other property is the value that does nothing, so `interceptors.request.use(…)` and the like run through. The
functions on this object are not API functions, so `export const { get } = http` puts none on the map.
In the files duru runs to call API methods, `import.meta.env`, however it is written, is the value that does
nothing: a Vite app's `axios.create({ baseURL: import.meta.env.VITE_API })` otherwise stops the whole file at
load.
Alternatives compared:
- A key of its own, such as `requestObject`: `import` and `name` mean the same as in `requestFunction`, and a
  second key would need its own rules against the first (one of the two, either one with `calledApiModules`).
- A list of the method names to record: the five are those the planning issue names, and no client at hand calls
  others. An optional list can still be added later without changing a config written now.
- Leaving out the `baseURL` given to `create`: a client made by `axios.create({ baseURL })` then gets addresses
  without the prefix, and none of them match the server list.
Naming `axios` here replaces the HTTP library itself, which the decision above set aside. That was for an app
whose own request function stands between the API code and axios; such an app still names that function.
Measured before and after: the into-sign 1.5.0 map, the into-sign 2.0.0 map with the function-shaped
`requestFunction` above and the JavaScript example map are identical apart from the time they were written, and
the extract output is the same (2.0.0: 309 API functions, 196 calls, 42 of 44 screens with a call, 51 methods
printed). into-sign has no API code calling a request object directly, so this has nothing to change there.
The limits: naming the made object (`./api/http`) instead of the package gives the addresses without the
`baseURL`, because that file is then not run; a `baseURL` set after `create` is not seen; a protocol-relative
address (`//host/path`) gets the `baseURL` in front, where axios would not; what a recorded call returns is a
resolved promise of the fake value, so `axios.all(…).then(…)` or a library whose calls are chained, such as
ky's `.json()`, ends in an error printed for that method, and ky's `prefixUrl` is not read; the constants run
does not stand in for `import.meta.env`, so a constants file reading it still fails there.

**A `baseURL` given with one request goes in front of that request's address in place of the one given to
`create`.**
The config is read where axios takes it: `get`, `delete`, `head` and `options` after the address, `post`, `put`
and `patch` after the body, and `request` or a call of the object itself as the config. As in axios, a text
`baseURL` replaces the one of `create`, and an empty one (`null`, `false`, `0`, `""`) puts none. A `baseURL` duru
cannot know, such as one read from an argument it tried, a stand-in for a package or `import.meta.env`, or text built
from them, shows as `{?}`, as an unknown part of an address does. The base of `create` stays, as before this rule,
when the config is itself an argument duru tried, passed on whole by an API method, or a stand-in for a package or
`import.meta.env`: duru cannot see a `baseURL` in it, so the address stays what it was before a per-request
`baseURL` was read. `defaults.baseURL` is not modelled and shows as `{?}`. Compared with keeping the base of `create` for every value duru cannot
know: the map would then show an address the app does not send as if it were known.
appsmith's `api/Api.ts`, one of the open-source apps measured for real use, makes its client with `axios.create()`
and gives `baseURL: "/api/"` with each request. The into-sign maps and the two example maps, which give no `baseURL`
with a request, are identical to main's apart from the time they were written.

**Settings read from the object a function returns are found by naming the function in the config, and the
object passed to it is read as setting defaults.**
`settingsFunctions` lists functions as the app imports them, each with the settings root and the key under it
that the returned object stands for. Before reading any condition, duru follows imports from the route files,
written `import`, `export … from` or `import('…')`, and looks in the files it reaches for calls written
`const name = fn({ … })` or `export default fn({ … })`, the function imported directly or through files that
re-export it. A read of that name, in that file or in a file importing it, directly or through such files, is a
read of `<section>.<key>` under that root, and the keys and values of the object passed in become defaults of
that section.
Alternatives compared (driver's decision, 2026-10-07, recorded in the issue):
- Listing the files that hold such calls (22 on into-sign 2.0.0): the list has to grow whenever the app adds one,
  while the function's name already finds them all.
- Reading the keys without the defaults: the conditions would name the setting that opens a screen but not
  whether it is on after a fresh install; 84 of the 96 defaults known on into-sign come from these objects.
- An app-specific function name built into duru: the config names it, so any app that wraps its settings in a
  function of its own is read the same way.
Choices made inside it:
- A key the `settingsDefaults` source also has keeps that value, and a different value passed to the function is
  printed. There are none on into-sign 2.0.0.
- Two calls passing different defaults for one key leave that default unknown on the map, with both places
  printed: each screen gets its own default at run time, and one value on the map would be wrong for the others.
  When the source does not show both values in full, the line says the map cannot tell whether they match, not
  that they differ: two calls passing the same imported constant would otherwise be said to differ.
- Only calls in the files the route files lead to count, for the defaults and for every printed line. A test,
  story or mock passing its own values would otherwise change the defaults the screens are shown with, and on
  into-sign the 17 calls written another way, all in test files, would bury the lines that matter. The screens'
  sources would be the narrower scope, but the defaults are needed while the screens' conditions are read, before
  those sources are known; the import walk also takes in the route files, whose conditions read settings too.
  On into-sign 2.0.0 it finds the same 22 calls as looking through every file did, and none of the 17.
Measured on into-sign 2.0.0 (`release/2.0.0` at `0f436776f`) with `readSystemSettings` under `settings.SYSTEM`,
before and after: setting keys read by screens 15 → 111, setting-read rows 408 → 881, link rows with a setting
condition 0 → 4, defaults known under `settings.SYSTEM` 12 → 96 (6 marked as not shown in full). Of the 89 keys
passed to the function, screens read 84; the other 5 are upload size limits that screens read from a server
response, not from the returned object. The other 12 of the 96 new keys are reads such as
`signing.SIGN_LIST.length`, counted with the method name as reads under `settings` already are. One screen's access changed (two links into
it now carry the setting condition); restricted screens stay 12, and screen IDs, the 411 link rows, the 24 entry
screens and the calls are unchanged. The 1.5.0 map, the 2.0.0 map without the key, and both example maps are
identical to before apart from the time they were written. Three runs took 2.9 to 3.6 seconds without the key
and 3.5 to 3.7 seconds with it; the import walk parses each file it reaches once more.
The limits: a name taken apart (`const { SIGN_LIST } = signing`), read as `signing['SIGN_LIST']` or passed on
whole is not followed; a call assigned with `let` is printed, not read; a call through a namespace import
(`settings.read({ … })`) is not found at all, and a result read through one (`import * as S`, then
`S.signing.SIGN_LIST`) is not read; `section` is a single key. A condition written with the same text twice in
one file is a setting condition at both places when one of them reads the returned object. A call in a file the
route files do not lead to, such as an app shell or a provider rendered around the routes, gives no defaults.

**A screen gets the API calls and the links that the names it uses reach; its setting reads still come from every
file of its sources.**
duru reads the screen's component file and the components wrapped around its route whole, and follows each name
they use to its declaration, through files that re-export it (`export *` included), then the names that
declaration uses, and so on. A call attaches to the screen when it is written inside a declaration reached this
way, or where a reached file runs it as soon as it is imported: in a top-level statement, or in a call that a
top-level declaration makes while the file loads, in its value or a destructuring default
(`const warm = load()`, `export default register(…)`), its arguments, a class's `extends`, static fields, static
blocks and computed member names included. A top-level `X.y = …` belongs to `X`, apart from the calls written
in it, which run on import too. A file a reached file imports or re-exports from is reached too, even when
none of its names is used, because importing it runs its top-level statements. Function bodies and a class's
methods and instance fields, wherever they are written, are taken to run only when called and stay with the
declaration: a function handed to a function that makes hooks (`createMutation((args) => api.archive(args))`)
comes with the hook. A function that a call runs at once (`KEYS.map((k) => api.label(k))`,
`(function () { … }).call(this)`) stays there too, so its calls come only with the declaration; only a function
called right where it is written (`(() => load())()`) counts as running on import. Names used only in types are
not followed. Following stays inside the screen's `sourceFiles`, so no screen gets a call it did not have before.
Each call keeps the file and line it is written at, so a call reached through a hook shows the line in the hook
file. The following lives in `src/follow-names.ts`, which takes a file and a name and gives back the call sites
they reach; the screen extraction only asks it.
Where duru cannot tell which names are used, the whole file counts as used: a namespace import used other than
as `ns.name`, a dynamic `import(…)`, an import for side effects only, a name the file does not export (a CommonJS
file, for one), and `export * as ns`.
For `calledApiModules` two more shapes are read. A name imported through files that re-export it from a listed
file counts as imported from that file, so `object.method(…)` on it joins the method's call; a file re-exports a
name by `export { name }`, `export default name`, or a constant holding it (`export const notes = noteApi`). An
API function or method handed over as a value without being called (`queryFn: fetchNotices`) counts as a call at
that place, but re-exporting it in one of those ways does not.
`apiModules` imports are read as before, only directly from a listed file.
Alternatives compared (driver's decision, 2026-10-07, recorded in the planning issue):
- Whole files, as before: on into-sign 2.0.0 one hook file holds 46 hooks calling different methods and 53
  files import it, so most screens carried the same 74 calls.
- Following names for calls, links and setting reads alike: the links and setting reads of the 1.5.0 map would
  move too, and the work is about three times as large; on 2.0.0 the stop at other screens' component files had
  already cleared the links and setting reads. Neither claim about links was measured. When links came to follow
  names (#359), the 1.5.0 map's links did not change, and 2.0.0 still had 72 link rows from shared files whose
  declarations the screens do not reach.
Choices made inside it:
- Starting from the whole component file rather than from the component's name: the file's other declarations
  are mostly helpers of that component, and reading it whole cannot drop a call the screen's own file writes.
- Taking the whole file where a shape cannot be followed, rather than nothing: a call missing from a screen
  looks like a screen that does not make it, while an extra call shows in the screen's list with its file and
  line.
Measured before and after, counting for each screen the distinct calls it reaches. On into-sign 1.5.0 one call
site changes: `common/Form/components/FormSelectLabel.js:49` (`ajaxWorkspaceLabelListType`) leaves 34 screens
that import other form components through `common/Form/index.js` but never render `FormSelectLabel`, and stays
on `/admin-member`, whose member create and update modals render it. 32 of those screens lose the call, listed
below, and the two `admin-settings` screens reach the same address from another file. Screen–call pairs go
538 → 506; the call counts of the other 13 screens, those two among them, are unchanged.

| Screen (1.5.0) | Calls before | Calls after |
|---|---|---|
| `/participant/s/:documentId/:participantId#ParticipantSigner` | 24 | 23 |
| `/book/:documentId/:metaSignerId#ParticipantSignerMetaBook` | 20 | 19 |
| `/link/:documentId#ParticipantSignerMetaLink` | 19 | 18 |
| `/reset-password#ResetPassContainer` | 4 | 3 |
| `/publish/document-basic/:id#PublishBasicDocument` | 8 | 7 |
| `/publish/document-link/:id#PublishLinkDocument` | 7 | 6 |
| `/publish/document-flexible/:id#PublishFlexibleDocument` | 6 | 5 |
| `/edit/template-document/:id#DesignTemplateDocumentView` | 6 | 5 |
| `/edit/draft-document/:id#DesignDraftDocumentView` | 7 | 6 |
| `/detail/document/:id#DetailDocument` | 26 | 25 |
| `/detail/document-flexible/:id#DetailFlexibleDocument` | 24 | 23 |
| `/detail/document-link/:id#DetailLinkDocument` | 21 | 20 |
| `/user-home#UserHome` | 9 | 8 |
| `/user-info#UserInfo` | 11 | 10 |
| `/user-sign/:type#UserSign` | 13 | 12 |
| `/user-sign#UserSign` | 13 | 12 |
| `/user-draft-document#UserDraftDocument` | 11 | 10 |
| `/user-document/:type#UserDocument` | 10 | 9 |
| `/user-document#UserDocument` | 10 | 9 |
| `/user-document-basic/:type#UserMetaDocumentBasic` | 17 | 16 |
| `/user-document-basic#UserMetaDocumentBasic` | 17 | 16 |
| `/user-document-batch#UserMetaDocumentBatch` | 8 | 7 |
| `/user-document-link#UserMetaDocumentLink` | 8 | 7 |
| `/user-document-flexible#UserMetaDocumentFlexible` | 8 | 7 |
| `/user-completed-document#UserCompletedDocument` | 18 | 17 |
| `/admin-template#AdminTemplate` | 13 | 12 |
| `/admin-meta-document#AdminMetaDocument` | 8 | 7 |
| `/admin-progress-document#AdminProgressDocument` | 17 | 16 |
| `/admin-complete-document/:type#AdminCompletedDocument` | 19 | 18 |
| `/admin-complete-document#AdminCompletedDocument` | 19 | 18 |
| `/trash/:tab?#Trash` | 8 | 7 |
| `/system-settings/:type?#SystemSetting` | 20 | 19 |

On into-sign 2.0.0 (`release/2.0.0` at `0f436776f`, the ten `calledApiModules` files of the entry above),
screen–call pairs go 2,656 → 552 and call sites on screens 3,935 → 759. Two calls leave every screen, both
rightly: `POST /internal/v2/user-token/temp-user-token/create` is made by `useLoginByTempToken`, used only in
`session/SessionLoad.tsx`, which no screen's sources hold, and `POST /internal/v2/workspace/create` by
`useCreateWorkspace`, used only by a test and by a modal that only `SessionLoad.tsx` loads; some screens hold
that modal's file because they import another modal from the same index file.

| Screen (2.0.0) | Calls before | Calls after |
|---|---|---|
| `/signin#SignInContainer` | 4 | 2 |
| `/user-home#UserHome` | 74 | 10 |
| `/user-info#UserInfo` | 82 | 13 |
| `/user-sign/:type?#UserSign` | 79 | 13 |
| `/user-draft-document#UserDraftDocument` | 74 | 11 |
| `/user-document/:type?#UserDocument` | 74 | 9 |
| `/user-document-basic/:type?#MetaDocumentBasic` | 74 | 16 |
| `/user-document-batch#MetaDocumentBatch` | 74 | 9 |
| `/user-document-link#MetaDocumentLink` | 74 | 9 |
| `/user-document-flexible#MetaDocumentFlexible` | 74 | 9 |
| `/user-completed-document/:type?#UserCompletedDocument` | 74 | 17 |
| `/department-template#DepartmentTemplate` | 87 | 14 |
| `/department-draft-document#DepartmentDraftDocument` | 76 | 12 |
| `/department-progress-document#DepartmentProgressDocument` | 87 | 18 |
| `/department-complete-document/:type?#DepartmentCompletedDocument` | 76 | 19 |
| `/admin-member#AdminMember` | 93 | 26 |
| `/admin-template#AdminTemplate` | 97 | 25 |
| `/admin-settings/:type?#AdminSpaceData` | 74 | 16 |
| `/admin-meta-document#AdminMetaDocument` | 74 | 9 |
| `/admin-progress-document#AdminProgressDocument` | 74 | 17 |
| `/admin-complete-document/:type?#AdminCompletedDocument` | 74 | 18 |
| `/system-settings/:type?#SystemSetting` | 81 | 21 |
| `/trash/:tab?#Trash` | 76 | 10 |
| `/publish/document-basic/:id#PublishBasicDocument` | 76 | 8 |
| `/publish/document-link/:id#PublishLinkDocument` | 69 | 6 |
| `/publish/document-flexible/:id#PublishFlexibleDocument` | 69 | 6 |
| `/edit/template-document/:id#EditTemplateDocument` | 68 | 5 |
| `/edit/draft-document/:id#EditDraftDocument` | 68 | 5 |
| `/detail/document/:id#DetailDocument` | 73 | 21 |
| `/detail/document-basic/:id#DetailBasicDocument` | 26 | 1 |
| `/detail/document-batch/:id#DetailBatchDocument` | 73 | 19 |
| `/detail/document-flexible/:id#DetailFlexibleDocument` | 60 | 18 |
| `/detail/document-link/:id#DetailLinkDocument` | 60 | 13 |
| `/participant/s/:documentId/:participantId#ParticipantSigner` | 51 | 23 |
| `/flexible-document/:flexibleDocumentId#ParticipantSignerMetaBook` | 45 | 17 |
| `/book/:documentId#ParticipantSignerMetaBook` | 45 | 17 |
| `/book/:documentId/*#ParticipantSignerMetaBook` | 45 | 17 |
| `/link/:documentId#ParticipantSignerMetaLink` | 44 | 16 |
| `/participant/:participantType/:documentId/:participantId#ParticipantViewer` | 16 | 16 |
| `/view/:documentId#ParticipantExternalViewer` | 0 | 0 |
| `/customer/view/:documentId#ParticipantExternalViewer` | 0 | 0 |
| `/external/view/document/:code/:documentId#ExternalDocViewer` | 34 | 13 |
| `/external/view/draft-document/:code/:documentId#ExternalDraftDocViewer` | 4 | 4 |
| `/external/view/template-document/:code/:documentId#ExternalTemplateDocViewer` | 4 | 4 |

On both maps links, setting reads, conditions, entry screens and screen IDs are unchanged, and the JavaScript
example map is identical apart from the time it was written. A screen whose sources hold the file of a hook it
does not use no longer shows that hook's calls, though `sourceFiles` still lists the file. Extraction takes
about a second longer on either version (1.5.0 2.1 → 3.0 s, 2.0.0 2.8 → 3.6 s).
The limits: a declaration reached is reached whole, so using one member of an exported object or class brings
the calls of all its members; a name written in a branch that never runs still counts; a top-level statement
of a reached file brings every name it uses.

Links written with `routeConstant` follow the same rule since #359 (2026-10-21). A link written in a file the
screen's sources hold is the screen's only when the screen's code reaches the declaration it is written in, or the
file runs it on import; where a shape cannot be followed, the file's links all count, as its calls do. Setting
reads still come from every file of the sources, and `inheritedGuards` is still gathered from the whole file, so
each link keeps the conditions it had; narrowing either is left undecided.
Measured on main 29fae93 against the branch: the two example maps and the into-sign 1.5.0 map (571 link rows) are
identical apart from the time they were written. On into-sign 2.0.0 link rows go 411 → 339 on 23 screens, and none
is added: 69 rows of `utils/route/navigationUtils.ts`, and 3 of `utils/domain/member/menuUtils.ts:205`, where
`Option.ROUTE_PATH.SYSTEM_SETTINGS` is compared in a menu function the publish screens do not call. Of the 247
pairs of screens joined by a link, 244 remain; the three that go lead from the basic, link and flexible publish
screens to `/system-settings/:type?#SystemSetting`. The conditions of the remaining pairs, the entry screens and
each screen's kinds and role values are unchanged, and in the flow every screen keeps its place; only those three
jumps go (227 → 224).

**The roles that pass a role guard can be written in the config (`roleGuards`), with the kind of role before
the name.**
In the 2.0.0 client every role screen is guarded by a member of `menuPolicy` (`canAccessAdminRoutes`,
`canAccessDepartmentRoutes`, `canAccessSystemSettings`, `canAccessTrash`), which a function in another file
builds by comparing the user's roles with lists in `config/permissions.ts`. duru reads only comparisons in the
file of the guard, so all 12 role screens had their roles unread, while 10 of the 11 in 1.5.0 were read. The
name `ADMINISTRATOR` is a member role, a user role and a role in a department, and a department screen opens
for a member administrator or for an administrator of the chosen department, so the config writes
`member:ADMINISTRATOR` and `department:ADMINISTRATOR`. Compared: writing the bare names (the tags look as in
1.5.0, but the two administrators of a department screen are one), and following the policy function into
`permissions.ts` without a config (the largest change, and the shared names stay shared). The roles written
replace what duru reads for a guard with the same text, wherever it is, rather than being merged with it: a
written role and a read one never match as text, so mixing the two on one screen would leave it no roles; when
that happens, the screen lists the guards missing from `roleGuards` as unreadable.
A key that guards no route or link with a role is listed like an unknown `bodyOptions` call.
Measured on main 8a62577 against the branch: with the four guards written, the 2.0.0 map gives roles for all 12
screens and leaves no guard unread, and nothing else on the map changes; without `roleGuards`, the 1.5.0 and
2.0.0 maps are identical to main's apart from the time they were written.

**A screen that opens only under a role or a setting has a case for each condition, and a test names its case
with `@role:` or `@setting:`.**
Each role that opens the screen is a case where it opens, and one more case, `role:other`, is a role that does not
open it being kept out. Each setting condition is two cases, written `=true` for a test that meets the condition
and `=false` for one that does not, whatever the condition asks, so `=true` is always the case where the screen
opens. The setting tag carries the setting's path and, for a list that must hold a value or a setting that must
equal one, the value after a colon. In 1.5.0 each of the 12 setting screens asks two conditions, that a menu slot
is there and that its list holds the screen's entry; with the path alone a tag would not say which entry a test
left out, and two entries asked of one list would fall into one case. Compared: the path alone (shorter, and in
1.5.0 no list is asked for more than one entry).
The blocked role case is `role:other` rather than a real role. The issue reports a tag that names a role outside
the screen's condition, and a real role there would either be reported or have to be written somewhere first:
the plain member role a blocked test would sign in with appears nowhere on the 1.5.0 map. Which role a blocked
test used belongs in its title, which the review page and the task list show; a Playwright tag is not shown at
all. Compared: any role the map or `review.roles` names (keeps the role in the tag, but the plain member role must
be added to the config first), and any role that does not open the screen (also counts a misspelt role as
blocked).
A setting condition on only some of the links into a screen is no case, since the screen still opens through the
others. A test with both kinds of tag counts for each case it names. A tag that is not a case of a screen the test
is tagged with is reported with the tags that point at nothing, and the test still counts for the screen. Cases are
worked out from each screen's access when tests are linked and when the review page and the task list read the map,
as the options of a call are, so the map does not change.
Measured on main 8a62577 against the branch: on the 1.5.0 map each of the 14 screens that open only under a role
or a setting gets cases, 78 in all, and the one role screen whose roles are unread has `role:other` as its only
role case; on the 2.0.0
map the 12 role screens get 39 cases with `roleGuards` written and 12 without it. Without tests that carry these
tags, `map.json`, `tests.json` and what `rebuild` prints for both maps are identical to main's apart from the
time they were written. In the task list a marked screen without a condition comes out as on main, and a marked
screen with one gains its case lines and an empty test set for each case with no tests.

**Kinds of test case the source cannot show are named in the config, a reviewer picks them per screen or call on
the review page, and a test names its kind with `@case:`.**
Input limits, data from an older version, failure and recovery, or time and state are cases no source shape shows,
and which screen or call needs which of them is not in the source either. So the config only names the kinds,
`caseKinds`, each mapped to the description the review page shows, and a kind becomes a case of a screen or call
only where a reviewer picks it (since #312 also where a rule in the kind's `picks` picks it, see the entry on rules
below). Compared for the config: a list of names (shorter, but the page would show a bare
name such as `boundary` with nothing saying what to test), and an object per kind that also says which screens or
calls it applies to (puts in the config the judgment the review is for, and has to be kept up as screens are added
or renamed; it still holds for a list of screens and calls, but rules that pick by shape were not compared here). A name has no spaces, `:` or `=` so it reads as one tag, and starts with a letter, since a JSON object
puts keys that read as whole numbers first and the author's order would be lost.
A pick is a mark in `marksDir` with the target `{ node, case }` and the status `needed` or `not-needed`, and the
latest mark of a node and kind is the current pick. Compared: one file of picks the page overwrites (two reviewers
saving at once lose one another's picks, and the file keeps no author or date), and picks written by hand into the
config (no record of who picked what when, and a reviewer would leave the page to edit a file). Marks already keep
the author, the date and the history, merge in git without a conflict because each is a new file, and come through
the same reader, which marks a pick detached when its node leaves the map or its kind leaves `caseKinds`.
The buttons sit under 「경우별 테스트」, where the role and setting cases already show their tests: for a screen in
its screen info, and for a call in the call's details (both in the right pane until the right pane was given to the
conversation, see below). Compared: a column in the middle table (the table is laid out by
depth and option value, and a kind applies to the whole screen or call), and the status buttons of the mark form
(a pick is no judgment of the tests, and would take the place of the status the form records). The middle pane is
the same in the list and beside the flow, so a pick works the same in both.
A picked kind alone does not put a screen or call on the task list, as a role or setting case does not: the list
is what a reviewer marked `needs-more` (since #314 a picked kind with a case no test carries is listed under
`# Case kinds`, see the entry on deciding kinds by command below). A `@case:` tag counts for its kind on every screen and call
the test is tagged with, whether or not a reviewer has picked the kind there, because picks are only known when the
review page and the task list read the marks; a tag whose kind is not in `caseKinds`, or on a test with no screen
or call tag, is reported with the tags that point at nothing. Without `caseKinds` a `@case:` tag is not read at
all, so a project that already uses such a tag for its own runner sees nothing new until it names kinds.
Measured on main 4fff519 against the branch with the example client: without `caseKinds`, `map.json`, `tests.json`,
what `rebuild` prints and the task list are identical to main's apart from the time they were written; with
`caseKinds` and no picks, the map and `tests.json` are the same, and the task list differs only in its opening
paragraph, which names `@case:<kind>`. On into-sign 1.5.0 and 2.0.0 without `caseKinds`, the maps
and the task lists, with five marks on three role-guarded screens, an open screen and a call, are identical to
main's.

**A method that checks its address values and also reads the body it is given gets a fourth fake value, in which
only keys named like an id are texts.**
On the into-sign 2.0.0 map 30 methods had no address, all printed with `Invalid V2 endpoint param: workspaceId`.
Each takes one object holding both the address values and a body or a list. With the first shape the id is a
function and the app's address check refuses it; with the second and third every key is a text or a number, so
the body is one too, and the method stops on `'key' in data`, `.map` or `.join` before it sends. No value can be a
text and an object at once, so the fourth shape tells the keys apart by name: `id`, or a key ending in `Id` or
`ID` (`templateUUID` included), gives the text, and any other key gives the fourth shape's value again, so an id
key is a text at any depth. It comes after the other three under the same rule: the first attempt that sends a
request and ends without an error is kept, else the one with the most requests, one without an error winning a
tie, and an attempt that runs out of time ends the tries. Not covered: keys named otherwise (`uuid`, `slug`),
ids the app checks to be numbers, and keys ending in `Id` that hold an object or a function (`byId`).
Compared: making the first shape give texts for those keys (no extra attempt, but the first shape then gets
through `include?.length` to `include.join(…)`, and 24 methods that already had an address gain `?include={?}`,
which changes their call IDs); taking each argument's type from the TypeScript source (whether duru can resolve
those types is not measured); and deciding each key by how the earlier attempts used it, a text for one only
turned into text and an object for one read into (no name rule, but each key's use has to be recorded across
attempts; not tried).
Measured on main 37f0709 against the branch, into-sign 2.0.0: methods printed with that error 30 → 7, methods
with any error 71 → 49, addresses 245 → 267, calls 196 → 206, none lost. Compared method by method, the 25 that
change all had no request on main. Of the 30, 21 give their address, 3 of them still ending in `Aborted` after
the request because the fake response reads as aborted; 2 (`getAllDownload`, `getBatchDownload`) build an
address and return it without sending, so they show neither an address nor an error. The other 7 download by
clicking a link they make with the address, not through the request function, so nothing is recorded; they stop
on `document.createElement`, which the run does not give, and keep the first shape's error. Two methods outside
the 30, printed with `Invalid V2 endpoint param: documentId`, now end without an error, one of them with its
address. The into-sign 1.5.0 map is identical apart from the time it was written.

**Iterating the fake text gives the fake text once, not its letters.**
On the into-sign 2.0.0 map 16 calls had a single letter in one place of their address, 8 each for
`departmentApi.deleteDepartments` (`department/<letter>/delete`) and
`templateDocumentApi.assignTemplateDocumentsDepartment` (`template-document/<letter>/update`). Both take a list of
ids, make it unique with `[...new Set(ids)]` and send one request per id. With the second shape the list is the
fake text, which a `Set` splits into `_ d u r f a k e`, so one request went out per letter. In the worker the
string iterator now gives the fake text itself once when the text iterated is exactly the fake text, and works as
before for any other text. Not covered: code that splits the text another way, such as `split('')` or a loop over
its indexes, and a text that has the fake text as one part among others, such as `prefix + ids`. Every other use
of the string iterator on the fake text changes too: `for … of` runs once, `[first, ...rest] = text` gives the
whole text and an empty rest, and `[...text].length` is 1. The 2.0.0 map took 11.5 s against main's 11.0 s, in two
runs on each side; that the replaced string iterator causes the gap is a guess, not measured apart.
Also tried: making the first shape's value give itself once when iterated, which needs no change to strings. The
2.0.0 map stays as it was, with the 16 one-letter calls. Read from the into-sign source: with the first shape
`workspaceId` is a function too, and the app's address check refuses it before any request goes out.
Compared, each measured to give the same 2.0.0 and 1.5.0 maps as this one: rewriting an address place that is
one letter of the fake text to `{?}` when the request is recorded (the requests still go out per letter and count
towards the limit of 20, and a real one-letter place such as `/v1/a/list` in another app becomes `/v1/{?}/list`);
giving a list holding the fake value to keys named `ids` or ending in `Ids` in the second and third shapes (a list
under any other name is still split); and giving that list to every key ending in `s` (`status`, `address` and
`settings` turn into lists too, and an app checking that such a value is a text fails that shape).
Measured on main 997ba38 against the branch, into-sign 2.0.0: calls 206 → 190, one-letter calls 16 → 0; each of
the two methods sends one request, `.../department/{?}/delete` and `.../template-document/{?}/update`, both calls
the map already had; no other method changes. `/admin-member` gains `.../department/{?}/delete` in place of its
8 letter calls, and `/admin-template` loses its 8. The into-sign 1.5.0 map is identical apart from the time it
was written.

**duru's code is moved to TypeScript without a build step: Node runs `.ts` by dropping the types, `tsc --noEmit`
checks them, and `.mjs` and `.ts` live side by side until every file is moved.**
Alternatives compared:
- Compiling to JavaScript before running: any syntax works, but every run and test waits on a build, and what runs
  is not the file a failure names.
- Keeping Node 22.13 and passing `--experimental-strip-types`: every command in README, the `bin` entry and each
  test run would need the flag.
- TypeScript 7, the current release: its checker runs in a separate native process and is offered only under
  `typescript/unstable/*`. TypeScript 6.0.3 is the last release whose checker runs in the same process with a
  stable API, which reading the on/off fields of a client's request body types needs; it is pinned exactly,
  since TypeScript minor releases change what is reported. `@types/node` is pinned the same way, at 22.18, so a
  Node API missing from the lowest version is reported.
Reason: measured on a module importing a `.ts` file that imports an `.mjs` one, run directly, from a test file of
each kind and inside a worker thread. Node 22.13.0 and 22.17.1 stop with `ERR_UNKNOWN_FILE_EXTENSION`; 22.18.0 is
the first 22 release that runs them without a flag, and prints no warning. On Node 23, 23.5.0 stops the same way and
23.6.0 runs them with an experimental warning; 24.14.0 runs them without one. The lowest version is therefore
`^22.18.0 || >=23.6.0`. A `.ts` file imports others with their `.ts` ending (`allowImportingTsExtensions`), and
syntax that cannot just be dropped, such as `enum`, is refused by `erasableSyntaxOnly`. While the two kinds lived
side by side, `allowJs` let a `.ts` file import an `.mjs` one and `checkJs` stayed off; no `.mjs` file is left
outside `test/fixtures`, so both are gone (the page script in `src/review-page/` stays JavaScript). The
example apps under `test/fixtures` stay JavaScript and TypeScript as they are, since they are what duru reads. Not
covered: Node does not drop types from files under `node_modules`; duru linked there from its clone runs, since Node
follows the link, but a copy installed from a packed `.tgz` stops with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. The type check took about 3 s when it was added; with `src` and the
tests moved it takes about 19 s, and the browser tests add a second program of about the same time, below.
Measured on main 38f87f3 against the branch: the into-sign 1.5.0 and 2.0.0 maps and the two example maps are
identical apart from the time they were written.

**The browser tests are type-checked in a program of their own, `tsconfig.browser-tests.json`, which adds the DOM
types; `src` and the other tests are checked without them.**
The review page tests run code inside the page (`p.evaluate(() => document…)`), which needs `document`, `window`
and the element types. Alternatives compared:
- Adding `dom` to the one `tsconfig.json`: one check, but every file under `src` is then checked as if browser
  globals were there, so a Node module reading `document` or `location` by mistake is no longer reported.
- Writing narrow types for the page by hand in the test file: no second check, but nothing compares those types
  with the real DOM, so a wrong one stays unnoticed.
Reason: the code duru runs is checked against what Node has, and the page code against the real DOM. The second
program also reads every `src` file the test imports, so `src` has to pass under the DOM types too: the stand-ins
for `window` and `document` that `src/constants.ts` and `src/api-calls-worker.ts` put on the global object are typed
in those files instead of being declared for the whole program, where they clashed with the DOM's. `npm test` runs
the type check twice; measured one after the other on this change, each takes about 19 s. Measured: the into-sign
1.5.0 and 2.0.0 maps and the two example maps are identical to main's apart from the time they were written.

**The on/off values a request body carries are read from the TypeScript type of the body each API method sends,
with the TypeScript checker, and become options of the method's calls named by their path in the body.**
In into-sign 2.0.0 a screen puts its values under dotted form keys, and a conversion function inside the API
method turns them into the body, so the call site the map reads shows no body keys. Alternatives compared, each
scored against the 53 on/off keys the nine document calls carry (correct / wrong / missed):
- Keys read by conversion functions listed in the config: 28 / 11 / 25, a dozen functions to list, and the option
  is named by the form key rather than by what is sent.
- Fixed values at the screen's `mutate` call: 4 / 0 / 49; the publish screens' keys are all missed until hooks are
  joined to the API calls.
Reason: the type names what is sent, which is what a test's `@option:` tag names, and needs no screen code. The
body is the value an API method gives under a `bodyArgKeys` name, or the one a method it calls on `this` gives,
since into-sign sends a signer update through a private method shared with notify and delete. Only objects given
to a call count, so an object built from the answer is not taken for the body. Running the method tells which
requests carried a body (`requestFunction.body`, without which no type is read), so notify and delete, which send
none, get no options.
A true/false field next to a field of two or more fixed texts named after the same thing (`enabledAuth` and
`authType: 'CONTACT' | 'PASSWORD'`) picks among more than two values, is left out and printed; next to a single
fixed text (`authType: 'PASSWORD'` on a link document) it stays an option. A field typed only `true` or only
`false` is not an option.
Measured on into-sign 2.0.0 (`release/2.0.0` at `0f436776f`), the nine calls: before leaving fields out, 52 of the
53 keys are found, the same as reading the type files by hand; the one missed is the cc update, whose body is typed
`Record<string, unknown>` and is printed. 12 fields are found that no screen sets, against 9 counted by hand:
`enabledOrderedSigning`, `enabledPkiSign` and `viewExpiration.enabledViewExpire` of the flexible publish, which
always sends `false`; `enabledLinkAble` of the link publish, always `null`; seven per-item `required` fields
(five counted by hand); and `document.signers[].authConfig.enabledAuth` of the flexible publish. The authentication
fields of signers, cc and the flexible document, and the view expiry of the link publish (`viewExpireType: 'DAYS'
| 'DATE'`), are left out as more than two values. Outside the nine, the system settings update gets five options
and the label create and update one each. Not covered: a body built where the type is lost (`any`), a body given
positionally rather than under a key, a method reaching its body through a function outside its object, and an
options object put in a variable before the call; a method that sent a body duru did not find is printed (five
on into-sign 2.0.0, each building its body in a helper function). An object built from the
answer and given to another call, such as `JSON.stringify({ body: answer })`, is read as a body, and a method
sending two different bodies gives each of its calls the fields of both.
Measured on main 38f87f3 against the branch: the 2.0.0 map with `"bodyArgKeys": ["body"]` and `"body": "0.body"`
took 12.7 and 11.7 s against main's 9.8 and 10.5 s without them, in two runs on each side; apart from the new
options and `bodyTypeNotices` it is the same as main's. The into-sign 1.5.0 map, the 2.0.0 map without the
two keys and the two example maps are identical to main's apart from the time they were written.

**The on/off fields read from a body type that no screen lets the user change are taken out by hand, per call ID,
in `bodyTypeExclusions`.**
The type cannot tell a field the screens always send with one value from a real option, and the other readings
compared above miss far more keys, so a person lists them. Alternatives compared:
- One list of field paths for every call: the same path is fixed on one call and a real option on another
  (`enabledLinkAble` is always `null` on the link publish and set by a screen on the link update), so it would take a
  real option away.
- A reason written beside each field: the config is already the place a person reads it, so it adds little.
- Showing the left-out fields on the review page: a larger change for the same notice.
Only what was read from the type is taken out; a key that the source or `bodyOptions` also gives the call stays an
option with that source, so a screen that starts to set the field at the call keeps it. Each field the config names
is printed on every run, as taken out or as still an option and from where, so a field that a screen starts to set
shows up as an entry to remove; a call or field the config names that is not there is printed like an unknown
`bodyOptions` call. Without the key the map has none of `leftOutBodyTypeFields`, `keptBodyTypeExclusions` and
`unknownBodyTypeExclusions`, so maps of configs that do not use it stay as they were.
Measured on into-sign 2.0.0 (`release/2.0.0` at `0f436776f`) with the 12 fields of the measurement above: 11 are
taken out, and `document.signers[].authConfig.enabledAuth` of the flexible publish, which already goes with
`authType` and is not an option, is printed as matching no option. Apart from the 11 options and those three lists the
map is the same as without the key. Without the key, the into-sign 1.5.0 map, the 2.0.0 map with and without the
body type keys and the two example maps are identical to main's apart from the time they were written.

**Source files are read with Babel's standard `decorators` plugin, always on for `.js`, `.jsx`, `.ts` and `.tsx`.**
A client using a decorator library (MobX, an inversion container) writes `@observable x = 1`, `@action method() {}`,
`@dec export class` and `constructor(@Inject() private x: X)`. One such file in a screen's import range stopped the
whole map with `DURU_SOURCE_SYNTAX_ERROR`. Alternatives compared:
- The `decorators-legacy` plugin: it parses the same field, method and `@dec export class` shapes, but throws on
  `export @dec class A {}`, which `decorators` reads.
- A config item choosing the plugin: the two plugins read the same files of every app measured, so the item would
  make a person decide something that changes no result, and a missing item would stop the map again.
Parameter decorators are the one shape where the two differ the other way: `decorators-legacy` parses them, and
`decorators` reports a recovered error. duru parses with `errorRecovery: true` and never reads the errors it
recovered, so it goes on. `decoratorAutoAccessors` is on with it, for `@observable accessor x = 1`, the form MobX 6
takes with standard decorators; a field or method named `accessor` still reads as before. The plugins only add
grammar; what duru reads from a file without decorators does not change.
Reading is not running: Node cannot run a decorator. A decorated file that a `constants` module imports still stops
the map, with the file, line and column of the first decorator. A decorated file that a `calledApiModules` file
reaches by import is run as a stand-in instead (see below); a listed file with a decorator of its own gets that
error.
Measured with @babel/parser 7.29.9: the two files that stopped the map of outline (`DocumentContext.tsx`) and
appsmith (`WidgetProvider/factory/index.tsx`) parse with either plugin; over the 852 app files and 368 shared files
of outline, the 4579 client files of appsmith and the 4307 webapp files of mattermost, both plugins give no
failure, against 73, 1, 1 and 0 failures with neither. The two example maps and the into-sign 1.5.0 and 2.0.0 maps
are identical to main's.

**`constants` and `routeConstant` may be left out of the config.**
An app can write its route paths in place (`path="/signin"`) and have no table of them; outline and mattermost, in the
measurement that found the stop, had to write `"constants": {}` and a route constant that names nothing to get past a
`TypeError`. Making the keys required with a clear error would turn that stop into a message and still make every such
app write two made-up values, so they are optional: without `constants` nothing is run, and without `routeConstant`
no member chain is taken for a route reference. `null`, and for `routeConstant` an empty name, count as left out. A
key that is present but of the wrong shape (`constants` not an object of file paths, `routeConstant` not a dotted
name, or one whose first name is not in `constants`, as `settingsDefaults.<root>.constant` is checked) stops the
run in the config check with a message in the style of the other keys, so it does not reach the extraction as a
`TypeError`. Compared with taking any text as `routeConstant`, as main did: a name with a stray space or a typo in
its first name matches no reference, and measured on `test/fixtures/app`, `"Option.ROUTE_PATH "` builds a map with
the same 11 screens and none of its 14 links, with nothing printed. A config that used such a name to name nothing
now gets the error, and an empty name or leaving the key out does the same job. So `constants` can be left out only
together with `routeConstant`. A typo after the first name still matches nothing without a word, since the names
inside a constants module are known only once it runs.
Measured with `test/fixtures/app` and its route file rewritten to literal paths: each of the config without
`routeConstant` and without both keys builds the map and gives a screen to every literal route. The
two example maps and the into-sign 1.5.0 and 2.0.0 maps, which set both keys, are identical to main's apart from the
time they were written.

**`apiModules` may be left out of the config.**
An app with no hand-written module of API functions (outline, appsmith and mattermost, in the measurement that
found the stop) had to write `"apiModules": []` to get past a `TypeError`. As with `constants`, a required key with a
clear error would still make every such app write an empty list, so leaving the key out, or `null`, is the same as
`[]`. A value that is present but not a list of paths stops the run in the config check. Unlike `calledApiModules`,
a file listed twice is not refused: the files are gathered into a set, so such a config works and keeps working.
Measured on `test/fixtures/app`: without the key, or with `null`, the map is the one `[]` gives; outline, appsmith
and mattermost were not rebuilt. `test/fixtures/app` and `test/fixtures/ts-app`, which list `apiModules`, give the
same map as main's apart from the time it was written.

**A route written as a property of what a call returns (`Drafts.Component`, with `const Drafts =
createLazyComponent(() => import('./Drafts'))`) points at the file that the function given to the call loads,
whatever the property is called.**
The call is read the way a call around a loader already is: by its first argument, never by the name of the function
called. With a property left over, the function counts only when what it returns is the loaded module, the test
already used for a component the route file imports by name (the import, awaited, with `.catch` or `.finally`, or
`.then` giving `{ default: … }`), since a function that builds a table of loaders (`definePages(() => ({ Archive:
lazy(…), … }))`) also holds dynamic imports, and the last one there belongs to another screen. Before, the property
name left over at the loader stopped the lookup, so outline, which wraps every screen in `createLazyComponent`
returning `{ Component, preload }`, had 16 of its 30 routes without a component file.
Alternatives compared:
- A config item naming the functions whose result holds the component: it takes only the names listed, so each
  app needs one more line, and an app that forgets it gets the same silence as before.
Reason: the first argument already decides the file of `lazy(…)` and its wrappers without a name, and the property
only says which part of the result the route uses. The price is that a route written with a property that is not a
component (`X.preload`) also gets the loaded file, and that a table spreading such a call (`{ Archive: …,
...extra(() => import('./Profile')) }`) gives its file to the names written before the spread and to names the table
does not hold; a route never renders such a property, and a lazy component is not spread into a table, so neither is
expected. A loader that wraps the import (`() => retry(() => import('./X'))`) is not read with a property left over.
Measured: on outline the routes without a component file go from 16 to 2; the two left are a component declared in
the route file and a route built from a list of settings entries (`config.component`). The two example maps and the
into-sign 1.5.0 and 2.0.0 maps are identical to main's apart from the time they were written.

**A file that a `calledApiModules` file reaches by import and that holds JSX or a decorator is run as a stand-in:
each name it exports, and each name imported from it, is a value that does nothing. A `require()` of a package reads
as such a value too, and the worker gives the app `process.env.NODE_ENV` as `"production"` and `self` as the global
object.**
Node runs neither JSX nor a decorator, and a file of the app reaching one of them, often an icon or a widget far
down the imports, left every API file above it unrun. Measured on appsmith, whose ten API files all stopped: the
first stop was a `.tsx` icon file, then a decorated widget factory, then `require("path-to-regexp")`, then
`process.env.NODE_ENV.slice`, then `self.setTimeout`; with the five handled, all ten run.
Alternatives compared:
- Turning JSX into calls, with TypeScript's `transpileModule` and the stand-in as the element factory, and running
  the file: the file's own values stay real, but it reaches further into the app, where it met an `.svg` file read
  as code; with that also stood in, the calls recorded on appsmith (counted with static methods called) were the
  same 115 as with the stand-in, apart from a time stamp in one address. It costs a second way of turning files into
  JavaScript, with its own source maps.
- Standing in for the whole file that calls a package with `require()`: the file's other values are lost for one
  call, and in the measurement, made before a stand-in carried the names of its file, a file re-exporting from it
  missed names (`does not provide an export named`), which stopped every API file again.
Reason: a file of components or decorated classes rarely holds a piece of an address, and a stand-in is how duru
already treats a package. A listed file holding JSX or a decorator itself is still reported, since its own functions
are the ones to call. The stand-in leaves out the names Babel marks as types, since an index exporting `*` from it
and from a file with a value of the same name would otherwise make that name ambiguous. A `require()` naming a file
of the app fails with its line when it runs, because its values may matter and a stand-in would hide them; one in a
function the module never calls does not stop it, as on main. `NODE_ENV` is the one variable every bundler fills in;
other `process.env` names stay unset as before.
Measured: the two example maps and the into-sign 1.5.0 and 2.0.0 maps are identical to main's apart from the time
they were written.

**The static methods of a class a `calledApiModules` file exports are called as API functions, those the class
declares and those it takes from the classes above it, named `<export>.<method>` like the methods of an exported
object.**
Before, an exported class was skipped, so an API file of `class UserApi extends Api { static fetchUser() { … } }`
gave no call. On appsmith every API file has this shape, and the class a screen imports is often an empty
subclass (`class UserApi extends CE_UserApi {}` in `ee/api/UserApi.tsx`), whose static methods all come from above.
Alternatives compared:
- Only the static methods the class declares itself: the empty subclass then gives nothing. On appsmith, with the
  listed files as they are, the calls are the same 115 either way; taking the ones from above adds 44 API functions
  (`get`, `post` and the like of the shared base class under each subclass), whose addresses are the same `{?}`.
Reason: methods of an exported object are already taken from its classes above, and a screen calls a static method
through the class it imports, whichever class declares it. A `private` or `protected` static method is left out as
an instance one is, and instance methods of a class are not called, since duru does not make an instance. Static
methods are called after every other export of every listed file, because some set what other calls read
(`static setBaseURL(url)`); called first with a fake value, they changed the address of an exported object that
main read right. A class kept in a static field is not called.
Measured on appsmith: API functions go from 0 to 169, calls from 0 to 115, and calls a screen reaches from 0 to 6.
The two example maps and the into-sign 1.5.0 and 2.0.0 maps are identical to main's apart from the time they were
written.


**A package of the repository outside `srcRoot` is read from the folder `sourcePackages` gives it, and a
`calledApiModules` run that stands in for a real file or folder outside `srcRoot` says so.**
On mattermost the API class `Client4` is in the workspace package `@mattermost/client` (`webapp/platform/client`),
and `channels/src/packages/mattermost-redux/src/client/index.ts`, inside `srcRoot`, makes the instance the app
calls. duru took the package name for an outside package and ran a value doing nothing in its place, with nothing
printed. Alternatives compared, on that checkout with a link under `node_modules` made as an install makes it and
global `fetch` recorded as in the #169 measurement:
- A wider `srcRoot` (`webapp`): the import is a package name, not a path, so it still did not reach the folder;
  0 calls, as before. Every path in the config also moves.
- A list of folders read beside `srcRoot`: the same, since nothing ties the name `@mattermost/client` to a folder.
- `sourcePackages`, a package name with its folder: `Client4` runs, with 667 API functions and 533 calls.
Reason: only the name-to-folder pair reaches the class, and it is the same pair a workspace link or a tsconfig
alias holds. An import of a listed package, or of a path under it, is read from that folder everywhere duru reads
imports, as an alias is.
The notice covers two kinds of import duru stands in for although they lead to the repository's own files: a
tsconfig alias whose first target holding a source file is outside `srcRoot` and outside every `node_modules`, so a
catch-all `"*": ["node_modules/*"]` alias names no library, and a package whose entry under `node_modules` is a link
to a folder outside every `node_modules`, as a workspace install makes. Other packages are not named, because the
summary would list every library: 48 on appsmith, and two on into-sign 2.0.0, whose map would then change. The
notice lives in the map as `outsideStandIns` only when there is one, so maps of apps without such an import stay as
they were.
A file running `Client4` also met `export { WebSocketMessages }` of a name imported with
`import type * as`, which TypeScript drops and Node's type stripping keeps; a name imported only as a type is now
left out of such an `export { … }`.
Measured: the two example maps and the into-sign 1.5.0 and 2.0.0 maps are identical to main's apart from the time
they were written.

**Requests a `calledApiModules` run sends with the global `fetch` are recorded with their method and address, and
`requestFunction` may be left out.**
On mattermost every request of `Client4` goes through `fetch(url, options)`, so no request function of the app's own
could be named, and the one the #169 measurement named (`Client4` as a request object) replaced the very class that
builds the addresses. With `fetch` recorded and `requestFunction` left out, the mattermost run with `sourcePackages`
records 667 API functions and 533 calls, 483 of them reached from screens; with the #169 `requestFunction` kept, it
records none, before and after this change.
Alternatives compared:
- A config value naming `fetch` (a `requestFunction` of `{ "fetch": true }` or similar): one more line for every
  app that sends this way, and an app that forgets it sends the requests to Node's real `fetch`.
Reason: `fetch` is one global with one shape, `fetch(input, init)`, whose method and address duru can read without
being told where they are, and in a run Node's own `fetch` only tries the network. A `Request` given to `fetch`
gives its method and address. The fake answer is the same value the request function recorder gives. Apps whose
API code does not call `fetch` give the same requests as before. Without `requestFunction`, a listed file none of
whose methods sent a request with `fetch`, itself or through an object another listed file exports, is named in the
summary (`silentApiModules`), so an app that sends through axios and forgot the key is told which files gave
nothing, while the files that did send keep their calls; when no listed file sent one, the run stops with an error,
as a missing `requestFunction` did before. Stopping only in that case, and not naming files, was tried first: one
file sending with `fetch` was then enough to let the others pass in silence. The error also gives the cause for each
listed file that did not run, since otherwise it points at `requestFunction` while the cause is a file that failed
to load. Letting a run with such a file go on and print its `did not run` line was compared: it showed the cause too,
but an app that sends through axios, left out `requestFunction` and has one file that fails to load then got an
empty map and a success exit, where a missing `requestFunction` used to stop. A value duru made up and passed as
the options of `fetch` counts as no options, so a wrapper handing its options through records `GET`; a made-up
`method` inside options the app wrote stays unknown, since a real caller may pass any method there.
Measured: the two example maps and the into-sign 1.5.0 and 2.0.0 maps are identical to main's apart from the time
they were written.

**A request a `calledApiModules` method sends by moving the browser — a link it makes and clicks, `window.open`, an
address given to `location` — is recorded as a `GET` to that address, without the query values whose name ends in
`token` and without what follows `#`.**
into-sign 2.0.0 downloads zip files with `downloadByNavigation`, which builds a link with the access token in its
query and clicks it, since a navigation cannot carry the header the request function would add. Its methods stopped
at `document.createElement` and the map kept only the error of the first try. With the link recorded, nine methods
give their download address: the seven the #169 measurement listed, and the signer's and viewer's zip download,
which reach the same function with a participant token.
Alternatives compared:
- Keeping the whole query, as other recorded requests do: the token value would be in the call ID and in the map
  file, and it is a value of the run, not of the call. Other requests carry their token in a header, so only
  navigation loses it.
- Dropping every query value of a navigation: `domains` and `ids` in the into-sign download addresses are part of
  what the server is asked for, as the query of a `fetch` address is.
- Reading the navigations written in screen files (`<a href>`, `window.open` in a component, `location.href` in a
  saga) as well: those are what the #169 measurement counted in outline, appsmith and mattermost, but reading them
  means reading screen files without running them, the work #171 does, so they go with #171.
Reason: the browser globals were already stand-ins in the run; a click, `open` and the `location` setters now record,
and an address with another scheme (`blob:`, `data:`, `mailto:`) or starting with `#` is not a request to the
server, so a clicked link that saves a file already downloaded records nothing. The path of the current page is
unknown in the run, so its `location` reads give the fake value, and an address starting with `?`, which goes to
the current page, is not recorded. Nor is an address with no path left once the fake values are taken out
(`window.open(url)`, `window.open(file.url)`, `location.href = location.href`, and so `'/'` too), or with a fake
value at the start of the path or right after something other than `/` (`'/api' + url`). Such a helper opens what
its caller gives it, and recording it would put a `GET {?}` on the map where there was none; a fake value right
after a `/` of a fixed path (`/files/{?}/download`) is a path variable and stays. A click on an element other than a link records nothing.
`window.open` and `location` are not used in the API files of outline, appsmith, mattermost or into-sign 2.0.0;
they are recorded because they are the same request as a clicked link.
Known limits: the address is judged from its text, so the rule above has cases each way. A helper that adds a
slash before what it is given (`'/api/' + path`) records `GET /api/{?}`, which reads the same as a path variable;
an endpoint whose last piece has fixed text before the id (`/export/report-{?}.xlsx`) or whose base comes from the
build environment is left out. A method that moves to a screen of the app (`location.href = '/login'` after a
logout) gets that screen's address as a call, which the server list then shows unmatched. Dropping addresses that
match a route was compared and left out: a catch-all route matches every download address too. A download fired
by `dispatchEvent`, an `iframe` or a submitted form is not recorded, and `window.open` returns `null`, so a method
that sets the address of the window it opened stops there.
Measured: the two example maps and the into-sign 1.5.0 map are identical to main's apart from the time they were
written; the 2.0.0 map differs only in those nine methods, their nine calls and the screens that call them.

**A request a screen sends from its own source, by `fetch`, axios or the function or object `requestFunction`
names, is read from the source and put on that screen as a call of its own, with no API function. A form that
posts is read the same way; another move of the browser is a call only when the server list or `app.apiPaths`
shows that its path goes to the server.**
The #169 measurement counted 23 requests that outline sends from scenes, components and hooks, 7 in mattermost,
and 34 moves of the browser written in the screen files of outline, appsmith and mattermost. duru read none of
them: a screen's calls were only the API functions its sources call by name. The requests are now read in every
file a screen reaches, as API calls are, without running the file, so the address is what the source spells there:
text, a template, a concatenation, a local constant, with `{?}` for a piece taken from a value.
Alternatives compared:
- An entry in `apiFunctions` for each such request, under a name made of its file and line: every reader of the
  map would work unchanged, but the list of API functions and its count would hold places in screen files, and a
  name with a line in it changes with any edit above that line. The screen's own `apiCalls` entry carries the
  endpoint instead, marked `direct`, with how the request is sent where the function name would be; `calls`, the
  server match, the dead calls and the matching of browser test requests read endpoints from both places.
- A config key of its own for the function screens send through: it is the same function the API files send
  through, so `requestFunction` names it, and no longer needs `calledApiModules` beside it.
- Leaving out every file the request function's file imports: into-sign 2.0.0 sends again with `axios(config)`
  in the file behind its request function, and that request has no address of its own. But a request function
  that imports a store for the token would take the requests of every file the store reaches with it. A request
  is left out only when no screen file reaches it except through the request function's file.
- Recording every move to a path that is no route of the app, as the moves inside API methods are: on the measured
  apps this put `GET /admin_console/system_attributes/membership_policies` on the mattermost map and
  `GET /settings/ai` on the appsmith map, both screens of the app whose routes duru had not read, and with a
  server list each would be a dead call on its screen. A form that posts cannot open a screen, so it is always a
  request; for the rest duru cannot tell a screen from a server address, so the config has to.
- Reading `"/api/v1/" + LOGIN_SUBMIT_PATH`, with the name imported, as `/api/v1/{?}`: four forms of appsmith
  became one call `POST /api/v1/{?}`, a path variable where there is a fixed word. Following the import to the
  constant was compared: it is a reading of named constants across files, which route paths and conditions would
  use too, and belongs to a change of its own. An address with a piece from an imported name, or from a function
  imported by name, counts as not read.
- Listing the moves duru could not read beside the requests: an `href` or a `window.open` given a value is mostly
  a link to another site or to a screen, and the lines would bury the requests. Only requests and posting forms
  are listed.
Reason: a request whose address was not read stays on its screen without an address and is listed in
`unreadRequests` and in the summary, since a request missing without a word reads as a screen that sends nothing.
Known limits: the address is judged from its text. An address chosen by a condition
(`client.post(on ? '/a' : '/b')`) is not read and is listed. A request sent through a function of the app that
`requestFunction` does not name is listed once, inside that function, and the addresses its callers give are
not read. `XMLHttpRequest`, `sendBeacon`, other request libraries and a `fetch` imported from a package are
neither read nor listed. The address is as the source writes it: a base address the request object gets in its
own file is not in front (`/documents.list` on outline, where the server has `/api/documents.list`). An address
on another host is a call only when the host is `app.server`, and is listed as not read otherwise: taking the
host off every such address, as the API files' requests have it, made a request to another service a dead call
on its screen, so an app that writes its own server's host into its requests needs `app.server` to see them. A
value joined to a word of a path (`/api/users${query}`, `/api/v${n}/users`) leaves the address not read, since
the word with the value after it matched whatever path of that length the server list had first. An API function written in
the same file as the request object it sends through is behind the request function and left out. An options
object kept in a constant and given its `method` afterwards reads as `GET`. A form on an element that hangs off a
value the file does not import (`fetcher.Form`, a local `S.Form`) is not read, since it may be a Form of the
router. Without a server list and without `app.apiPaths`, no move by `GET` is a call (`/auth/passkey` on outline), and with a server list a download link
whose endpoint the server no longer has is left out, not shown as dead; with `apiPathPrefix`, the list counts
only for an address that starts with the prefix.
Measured on the #169 copies: of the 23 outline requests 18 are calls, 4 are listed as not read (three places: an
image address from a value, an address chosen by a condition, the `action` of the form being submitted) and 1 is
absent (`client.batch`); of the 7 mattermost requests 6 are listed as not read, their address starting with what
a `Client4` method returns, and 1 is absent (`XMLHttpRequest`). Of the 34 moves 4 are calls (outline's posting
forms), 4 are listed as not read (appsmith's posting forms, whose path ends in an imported name) and 26 are
absent: 13 in mattermost start with what a `Client4` method returns, and the rest take their address from a
server answer, a prop or a function, sit in a saga no screen reaches, or are `GET` moves with no server list
given. With `client` named as the request object, outline has 100 such places in all, the stores and models its
screens import among them, and 85 of them give an address. The two example maps and the into-sign 1.5.0 and
2.0.0 maps are identical to main's apart from the time they were written.

**The flow draws each screen as one line, a picked screen keeps only its paths strong and opens the list
view's own middle and right panes beside the drawing, and the bar counts the screens by status on buttons.**
Three drafts were drawn on the into-sign map (45 screens) and compared side by side:
- A, grouped cards (from the GitHub Actions run graph): screens that lead nowhere become rows of one card, API
  calls open inside a row. Closest to the old code and the flow stays visible, but a group of 16 rows is still
  tall and the whole map fits only at 30%, and where 「이 가지만」 would go was left open.
- B, path focus (from the dbt Explorer and Dagster lineage graphs): a screen is a one-line pill, pressing one
  dims what is not connected to it, and a side pane shows the details. 45 screens nearly fit one screen height
  and it looked the tidiest, but conditions and API calls are seen one screen at a time, and the side pane did
  the work of the list's middle and right panes.
- C, status table (from the Airflow grid and the Cypress views list, with the counted filter buttons of the
  Playwright report): the fastest way to find a gap, one press of 「테스트 없음 18」 or 「실패 5」, but it is not a flow
  diagram: a link into another branch is only a text tag, and it repeats the left list.
With a story path drawn on each, B was the shortest: the path took 215px against 629px for A, 672px for C and
1,328px before, and showed all 11 of its screens on the first screen against 5 before.
Reason: B keeps the picture of where each screen leads and fits the most on one screen; C's counted buttons
give the one-press gap finding B lacked; the overlap of B's pane with the list is gone because the pane is the
list's panes. Measured on the into-sign map with sample test statuses (26 of 45 screens tested) at 1440×900:
the flow first opens 1,082px tall with 31 of 45 screens fully in view, against 32,603px and 2 before (the old
「빈틈만 펼치기」 start opened every untested API call); 「맞춤」 shows all 45 at 68%; the story path is 259px tall
against 1,340px, with 8 of its 11 screens fully in view against 5 (the path is 1,201px wide in a 1,080px area).
How it is built, and what each choice was weighed against:
- The side of the drawing is the list's `#center` and `#right` sections themselves, filled by the same
  functions, over a new panel like the drafts': the panes stay one thing to keep right. A picked screen also
  becomes the list's chosen screen. Against showing only the 360px right pane, which keeps the drawing wider
  but leaves the screen's tests and API calls in the list; with both panes the drawing gets half of what is
  left (540px at 1440px).
- A story's step numbers and the chips to steps further away sit inside the pill, as in the story draft of B,
  over the lanes beside the boxes the old boxes used: with one-line pills there is no room in the lanes, and on
  into-sign five step numbers piled up under their column.
- A pill is an element with the button role, not a `<button>`, because the chips inside it are buttons.
- The status buttons and the search fade the screens they leave out over removing them: a tree with screens
  taken out loses the paths between the ones that stay, and every screen keeps its place.
- The condition tag names the kind (역할, 설정, 역할·설정, 링크마다 다름) over the values the old box wrote, so a
  screen stays one line; the values are in the hover text and the right pane.
- Zoom scales the finished drawing and gives its outer box the scaled size, over laying it out at the zoomed
  size: the layout measures each box on the page, which a scale would distort, so the layout code is the same
  at every level.
- Folding, API call boxes, 「이 가지만」 and the `/api/flow?from=` request it used are gone: the per-box buttons
  were their only callers, and a picked screen's paths take the place of a branch shown alone. A screen has no
  buttons of its own, so the question of words or icons on them is closed; the zoom buttons are symbols with a
  name for screen readers.

**The zoom control floats at the bottom-left corner of the drawing, and its percent is a field a level can be typed
into.**
At the right end of the bar above, the control stood over the right pane rather than the drawing, and an app frame
shown scaled down would put a second percent on the page with nothing saying which was the drawing's. The
bottom-left is where Excalidraw and tldraw put zoom, and it is away from the app frame, which a picked screen opens
to the right of the drawing; a mock that put the control at the bottom-right was turned down for that. The field
follows draw.io: Enter or leaving the field applies, Escape or anything not a number puts the level back, and a level
outside 30–150% becomes the nearer end. Alternatives compared: Excalidraw's percent, a button that goes back to 100%,
and Figma's, which opens a menu with a field in it; a field reaches any level in one step and 100% is one number
away. The level still lasts until the page is reloaded.
- The control sits in the same cell of the page's grid as the drawing, not inside the drawing's scrolling box, so it
  stays put while the drawing scrolls and follows the cell when a picked screen narrows it.
- The drawing keeps 60px empty below its last row, so scrolled to the end no screen sits under the control; 「맞춤」
  counts that space as well.
- A press that takes the focus out of the field applies the typed level and must still do what it does, though the
  redraw would take the pressed thing off the page. The control is made once and a redraw changes only its values, so
  − and + stay; a change of level redraws the drawing but not the bar above it, so a filter, 「선택 해제」 and the story
  picker stay; and a press anywhere else applies the level only after the mouse button comes up, so a screen box gets
  its click before it is drawn again.

**A request a redux-saga saga sends is a call of each screen that dispatches an action type the saga's watcher
waits for. No config key turns this on: the sagas are those a `createSagaMiddleware()` result runs, and a type
matches when the screen and the watcher name the same declared constant, or the same text.**
The #194 measurement found 186 requests that appsmith sends only from sagas, and duru put none of them on a
screen: the sagas sit in files the screens do not import, and a screen reaches them only through `dispatch`. duru
now reads, in every file a screen reaches, what the screen gives `dispatch` (an object, or a call of an action
creator that returns one) and the action creators it hands to `connect`, and finds the watchers waiting for that
type: `takeEvery`, `takeLatest`, `takeLeading`, `debounce`, `throttle`, a `take` repeated in a loop (from an
`actionChannel` too), and an object keyed by action type whose values a watcher picks. The saga code a watcher
starts is followed by names, as a screen's code is, to the API functions and requests it reaches.
Alternatives compared:
- A config key naming the saga root or the effect functions: the import from `redux-saga/effects` already names
  the effects and `createSagaMiddleware()` from `redux-saga` names the root, so a key would repeat the source.
  `@redux-saga/core` and the effects of typed-redux-saga are read under their own package names.
- Every watcher in the files that name redux-saga, instead of those a run reaches: on appsmith both give the same
  388 watchers. The run is kept because a watcher no run starts never listens, and without a run the summary can
  say why no saga request is on the map. Test files are left out of the search for a run. The middleware may be
  made in one file and run in another, so the search also reads the files that call a `run`.
- Matching by the value of the type (`"FETCH_ALL_WORKSPACES_INIT"`) instead of where it is declared: appsmith's
  `ReduxActionTypes` is about seventy objects spread into one, and reading its values means evaluating them.
  Matching by declaration makes `ReduxActionTypes.X` imported from `ee/` and from `ce/` one type, since `ee/`
  re-exports `ce/`. A constant that holds a single string also matches its text, so `dispatch({ type: 'X' })`
  meets `takeLatest(X, …)` when `const X = 'X'`.
- A `take` outside a loop counted as a watcher, with the code after it as what it starts: it is where a running
  saga waits, not where one starts. Counting it adds 85 watchers on appsmith and no request on any screen.
- Attaching every saga in a screen's import closure, or counting every action creator defined in a screen's files
  as dispatched: measured in #194, the first puts all 186 requests on 4 screens and none on the other 20, the
  second makes the requests per screen 4.7 times as many.
- One entry per pair of a request and an action type in the screen's `apiCalls`: on appsmith with the measured
  config, 4251 entries, 830 of them on the editor for 33 API functions. One entry per request with its action types
  under `actions` gives 570.
Measured on appsmith 4f8e991. With the config of the measurement (10 API files in `calledApiModules`), the screens'
`apiCalls` go from 22 entries to 570 and the calls with a screen from 6 to 39; 92 requests written in sagas reach
a screen, 55 of them `Api.get`, `Api.post` and the like inside API classes that are not listed, which a saga
reaches whole when it uses one of their methods. With all 25 API class files listed, the calls with a screen go
from 12 to 134, and 143 requests in sagas (123 calls) reach a screen: workspace settings 0 to 9 calls, admin
settings 10 to 24, password reset 0 to 2, the application list 1 to 58, the editor 1 to 96; the landing, login
and signup screens stay at 0. #194 counted 129 of the 186 with a script that took whole files as a screen's
scope; duru follows names, so its counts per screen are smaller and the two sets are not the same list. Outline,
the two example maps and the into-sign 1.5.0 and 2.0.0 maps are identical to main's apart from the time they
were written; two runs of extract on appsmith took 22.4 s and 24.9 s on main, 24.5 s and 24.7 s with sagas.
Known limits: Redux Toolkit slice actions (`x.actions.y()`, `[x.y.type]`) and a saga that another saga starts with
`put` are not followed (#194 counted 26 and 13 to 18 more requests there). A `dispatch` under another name, an
action creator that does not return an object literal (a thunk, `createAction`), effects imported as a namespace,
and a type written as text on one side and as a constant holding something else on the other are not read.
With `apiModules`, a saga that hands an API function to `call` sends nothing on the map, as a screen that passes
one as a value does; `calledApiModules` reads it. Two `take`s of different types in one loop give the code after
the second to the first type as well. A file that holds the saga run, or the middleware it runs, and cannot be
parsed is passed over, and the summary then says no run was found; so is a middleware run as a member of another
value (`store.sagaMiddleware.run(…)`). A
watcher registered only under a condition (appsmith's admin sagas run only for a super user) gives its requests
to the screen without that condition. Saga code is followed by names like a screen's, so a saga that uses one
member of a class reaches every member: appsmith's logout calls one static method of its usage pulse class and
gets the page fetch and the `fetch` of the pulse that other methods of the class send.

**A request sent inside a method of the class a React context hook gives, of a class held in one of its fields,
or of their parent classes, is a call of the screens that use that method, found from the TypeScript types of the
source. A screen that gets the store only from the hook reaches those methods, though the store files do not join
its sources.**
Before, a class was reached whole by its name. On outline the 23 screens whose sources hold the store files, through
the global `stores` instance the command menu's actions import, each carried all 58 requests written in the store
files, and the 7 screens that know the stores only through `useStores()`, whose return type is imported with
`import type`, carried none. Now a function named `use…` that calls `useContext` and is typed to return a class
instance names a root class (on outline `RootStore`, and two classes of the sidebar and the selection with no
request in them); that class, the classes typed on its fields (the 34 stores) and their
parent classes (`Store`, `IndexedStore`) are split into one region per method, getter, setter and function-valued
field, and a region is reached only where the screen's code reads that member. Which class a read means is asked of
the TypeScript checker: `documents.fetch`, `const { documents } = useStores()`, `this.rootStore.documents.fetch()`,
`this[key].clear()` over a union of stores. A member read on a parent class's type reaches the definition found
going up and every child class's override; inside a method reached that way, `this` is the class it was read on.
A member read by a computed name (`folders[action]()`) reaches every member of the class; writing to a computed
name (`this[key] = value`) reads none. Constructors, field values and static members stay with the class, so
making the store still runs them.
Alternatives compared:
- Attaching a store's requests to every screen that uses the store at all, or to every screen whose sources hold
  the store file: the #193 measurement found these put 55–59 more requests on each screen behind the login and
  gave `Logout`, which calls only `auth.logout()`, all nine requests of the auth store. Driver's decision in #193:
  only screens that call the method.
- Following the type annotations by hand instead of the checker: the receiver's type comes through destructuring,
  generic parents (`Store<T>`), unions from `this[key]` and `instanceof` narrowing, which the checker already
  answers and `src/body-types.ts` already uses. Measured cost on outline: 6.2 → 12.4–12.8 s per extract, of which
  making the TypeScript program took 2.6 s in an earlier run; no program is made when no file that calls
  `useContext`, nor a file it imports or one that file imports, declares a class, so the into-sign and example maps
  take the same time as before (1.5.0 7.3 s both, 2.0.0 11.7 → 11.3 s).
- A value the checker cannot type. The outline copy has no `node_modules`, so a package type such as `Optional<…>`
  in `createAction` is `any` and the actions' `({ stores }) => stores.notifications.markAllAsRead()` lose their
  types. Dropping such reads: 1,711 screen–call pairs, and the screens behind the login lose the requests their
  command menu actions send (6 each, `markAllAsRead` among them), which main had. Matching the member name on
  every followed class: 1,835, with `params.delete`, `DecorationSet.create` and `debounced.cancel` taken for
  store methods, and `DesktopRedirect`, which only reads the auth store, getting a call. Chosen: the value counts as
  a store when the name it is read under is a field of the root class (`stores.notifications`, `documents`):
  1,815.
- A value whose type holds no followed class under another name: an untyped prop (`({ store }) => store.create()`
  in a `.jsx` file), an untyped parameter, or a value typed by an interface. Main reached these methods, because
  a screen that imports the store reached the whole class; leaving them out, as 1,815 did, drops those requests.
  Chosen: such a value counts as every followed class its type can hold (all of them when untyped; for a typed
  value, the classes whose instance is assignable to that type, so `{ archive: boolean }` takes no store), and the
  method is followed only in a store file the screen imports, so a screen that knows the store only through the
  hook gets nothing from a bare name: 1,827. The 12 pairs added come from `move`, `duplicate` and `search` read on
  values the checker cannot type, and main had all of them. Taking a computed name (`obj[key]`) on such a value as
  every member of every followed class as well: 1,995, every one of the 23 screens back at main's count, because
  `obj[key]` on untyped values is everywhere; such a read is not followed.
- Loading the store files a screen reaches only through the hook, as an import would: `AuthStore.logout` calls
  `deleteAllDatabases`, whose file imports the global instance, so loading runs `new RootStore()`, every store's
  constructor, every model class those constructors are given, and every store method a model calls. `Logout`
  went 0 → 44 calls, `DesktopRedirect` 0 → 44, `Login` 8 → 51. Not loading them: the screen follows only the
  members it reads and the names they use; `Logout` 0 → 1 (`POST /auth.delete`), `DesktopRedirect` stays 0.
  The app made those stores at start, not the screen.
- Following a store method called from inside a class read whole (a model, a class component) into a store file
  the screen does not import: `Login` reaches the `User` model by name, its parent `Model.save()` calls
  `this.store.save()` typed as the parent `Store`, and that reaches every store's `create`; `Login` went 8 → 27.
  Followed only in files the screen imports: `Login` 8 → 9, the one added being `auth.fetchConfig()`, which it
  calls.
- Taking a computed write for a read: `UiStore.set` writes `this[key] = data[key]`, which brought every `UiStore`
  member and, through them, the `Document` model; `TemplateNew` got 6 calls against 1 (`templates.create`).
Known limits: model classes and every class not reached from the hook are still read whole, so a store method a
model method calls comes with the model, whether or not the screen calls that model method. Leaving out every
member read written inside a class read whole, as a measure of this, takes 306 screen–call pairs off the 23 screens
(12 to 18 each, `GroupMembers` 45 → 28); some of them the screens do send through a model (`document.move()`).
Following the model classes by type belongs to the model-method issue: they read their own fields by computed names
(`this[key]` in `Model`), which reaches every member. A value whose type holds no followed class is followed only
in store files the screen imports, and a computed name read on it is not followed. In such a file, a name that only
matches a store method is taken for it: a callback prop destructured from untyped props (`({ create }) => …`) or
`this.save()` in a plain JavaScript function brings every followed store's `create` or `save`, and so does a value
typed by a type parameter whose constraint a store fits (`<T extends { rename(): unknown }>`) even when only plain
objects are passed to it. A union that holds a followed class as well as an interface (`FolderStore | Reader`) is
read as that class alone. A method inherited from a parent is walked once for each followed class that inherits it.
A method taken out of an instance in a way other than `a.b`, `a['b']` or destructuring, and a member a framework
calls by itself are not followed. A store reached only through a global instance, with no context hook in the app,
is read whole as before. The types are read only when a class is declared in a file that calls `useContext`, in a
file it imports, in a file that one imports, or in a file those re-export with `export … from`; when none is, every
store of the app is read whole. Setting reads and links written in a store file the screen reaches only through the
hook are not on the screen. A plain assignment to a member (`store.load = fn`) counts as reading it.
Measured on the #169 outline copy (`requestFunction` naming `client`), main 59fb9d7 against the branch:
screen–call pairs 1,990 → 1,827 and calls 81 → 80 (`POST /collections.import`, which nothing in the app calls,
leaves every screen). Each of the 23 screens loses 2 to 26 requests: `GroupMembers` 72 → 46, `Template` 79 → 63,
`Shared` 83 → 72, the screens behind the login 87–92 → 83–90; the 7 others gain at most one each, the request of
the store method they call (`Login` `auth.fetchConfig()`, `Logout` `auth.logout()`, `TemplateNew`
`templates.create()`). The screens' `sourceFiles`, links and setting reads are unchanged. Of the 168 screen–call
pairs that left, none has a call of that method on its store (`documents.search`, `{ search } = documents`) in the
screen's source files. The two example maps and the into-sign 1.5.0 and 2.0.0 maps are identical to main's apart
from the time they were written, and the appsmith map apart from the `?v=` value appsmith puts in one address with
`+new Date()`.
Measured again after the redux-saga change reached main (c428464): the two example maps, the into-sign 1.5.0 and
2.0.0 maps and the appsmith map are identical to main's apart from those same values, and outline keeps 1,827
screen–call pairs. A request both the screen and a saga waiting for the screen's action reach is the screen's own
call and is not listed again under the saga. A saga handler is still walked without the store types, as on main, so
a handler that calls back into the store instance reads every store whole and the screens that dispatch its action
get those stores' requests. An action dispatched in a store file the screen gets only through the hook is not read,
so that whole read does not also reach every screen that calls the dispatching method; the saga's requests are then
missing from those screens, as they are on main.

**A comment on the review page is a mark with no status, and each mark or comment is printed on standard error as one
JSON line the moment it is saved.**
The status of a mark decides the task list; its note only says why. A comment needed the same target, author, date
and file per record as a mark, and a second kind of record would have needed its own folder, its own reading and
its own place in the history. So the note became the comment and the status became optional: the current status
of a target is its newest mark that has one.
Alternatives compared:
- A comment as its own record next to the marks, with the mark's note kept: two text boxes on one form, and a
  reviewer has to pick which one a sentence goes in. Driver's decision in #215: one live comment.
- The live lines on standard output, as #215 first wrote: standard output is exactly the task list when the review
  ends (`skills/duru/SKILL.md`, since #27), and an agent compares it with `duru tasks`. Standard error already
  carries the page address; a Claude Code background command shows both streams in one output, in order.
- Sending the agent's answer back to the page in the same change: the page reads its data once and has no way to
  be told of a new record, so that needs a command for the agent and a push to the open page. This change carries
  records one way, from the page to the agent.

**An agent answers a comment with `duru reply … --server <review page address>`: the running review saves the reply
like a page save, and every open page receives each saved mark, comment and reply over Server-Sent Events.**
A reply is a mark with no status and a `replyTo` naming the comment, so it needs no folder or reading of its own,
and in the history and the task list it goes under the comment it answers. Without `--server` the file is written
directly and shows on the next load; this is for a review that is no longer running.
Alternatives compared:
- The agent writes the reply file itself and each page asks the server for new records every few seconds: it works
  only where the agent can write into the review's marks folder. In the shared-server mode of #42 the agent runs on
  another machine than the server, so its file never reaches the server's folder; a request to the server reaches
  it from anywhere, and the other reviewers' saves already go through the server. Polling also reads the whole
  review data again when nothing changed.
- The agent writes the file and the server watches the marks folder: the same reach problem for a remote agent, and
  Node's documentation says `fs.watch` does not behave the same on every system, so a missed or doubled event would
  decide what a reviewer sees.
- A WebSocket instead of Server-Sent Events: records only flow from the server to the page, which keeps sending
  saves as ordinary requests, so a one-way stream over plain HTTP is enough and needs no package or upgrade
  handling. The page reads the review data again on each event rather than inserting the record, because a case
  mark also changes the cases the server works out for a screen or call.
Known limit: behind a reverse proxy the event stream needs response buffering turned off (`proxy_buffering off` in
nginx, or `X-Accel-Buffering: no`), or events wait in the proxy until the buffer fills. A page that loses the
stream reconnects and reads the data again, so saves made while it was cut off still show.

**An agent sends a case decision to a running review with `duru case … --server <review page address>`: the review
checks and writes it with the function the command uses directly, always signed `agent`, and every open page shows
it at once; a case written without `--server` still shows only on the next load.**
Asked for in #350 (2026-10-21), a part of #310; the driver chose the author and kept files written directly off the
open pages. One function in `src/review.ts` reads the case targets, checks a person's mark and the rules, and writes
the mark with `"via": "duru case"`; the command and `/api/cases` both call it, so a refusal reads the same either
way. Nothing in it waits, so on the server no reviewer's save lands between the check and the write. The command
sends the kind, the ID, the status and the note, and reads neither the map nor the marks itself. Sending and its
failures (`could not reach the review page at <address>: …`, or the server's refusal, with exit code 1 and nothing
written) are one function shared with `reply --server`. `/api/cases` checks the body itself: an object, kind, ID and
note as text, and a status of `needed` or `not-needed`, or 400 with nothing written, so a note that is a number is a
refusal and not a failure further down. The page needs no change: it already reads the data again on each mark it
did not save itself.
The author of a case sent to the review is always `agent`, whatever the body says, and `--author` with `--server` is
a usage error (exit code 2) that says to leave the name out. A reviewer tells a person from an agent by the chip, and
the page does not show `via`, so a request from the same computer could otherwise sign with any name, the
reviewer's included. The cost: an agent that names itself drops the name while a page is open. The page's own saves
are still signed with the reviewer's name and drop `via`.
Alternatives compared:
- The name the agent gives, else `agent`: what the issue asked to prevent, a request that changes who wrote a mark.
- The server also watching the marks folder, so a case written without `--server` shows at once: the reasons the
  entry above gives for replies hold here too (`fs.watch` misses or doubles events on some systems, and an agent on
  another machine writes into a folder the server never sees). The driver kept it to `--server`; a case written
  directly shows on the next load, as a reply does.
Known limits: a review started by an older duru has no `/api/cases` and answers `not found`, and the command does
not say to start it again. When `caseKinds` changes in the config during a review, `--server` judges with the kinds
the review read at its start and a direct write with the new ones; the page shows the kinds of the start too, so page
and server agree. Each case makes every open page read the whole review data again (about 2.5 MB, 0.18–0.32 s on
into-sign, measured while planning #350), and the server does nothing else for about 0.1 s per case: reading the
case targets took 76–94 ms, and the rest is estimated to be small. After the page draws again, the focus does not
return to a button, as after a reply; inputs, text areas and selects keep it.

**The agent learns of comments with `duru wait`, a background command that exits as soon as a comment has no
reply, printing every such comment; the agent answers them and starts it again.**
A background command wakes the agent only when it exits, so the review's own standard error lines reached the agent
only when the review ended. Ending on each comment turns that wake-up into the delivery, needs no watching tool and
has no time limit. Because `wait` starts by sending the comments that have no reply yet (`/api/events?unanswered`),
a comment saved before it started, between two runs, or while the review was being restarted still arrives. It
prints all unanswered comments at once, so a reviewer who leaves several in a row is answered in one round. The
same shape as `gh run watch` or `kubectl wait`: a command that waits for something and ends when it happens.
Only the review's `end` event means the review has ended. When the connection drops without it, `wait` connects
again, so a review stopped and started again on the same address within about 10 seconds still delivers to the
`wait` already running. The cost: a review that crashed, or takes longer than that to come back, ends `wait` with
`could not reach the review page` and exit code 1, instead of reading as a finished review; the skill tells the agent
to start `wait` again after starting the review again.
Alternatives compared:
- The review's standard error sent to a file and watched with a Claude Code Monitor (`tail -F`), as #242 first
  wrote: on 2026-10-13 a comment saved at 09:41 was written to the log at once but reached the agent only when the
  Monitor stopped after 30 minutes, and restarting the review overwrote the log, losing a comment saved at 09:08.
  A Monitor also stops every 30 minutes and must be started again.
- Taking a dropped connection as the end of the review: a crash would read as a normal end, but a `wait` running
  while the review is restarted would end with nothing, and the agent would stop waiting.
- A Monitor on the marks folder instead of the log: the files survive a restart, but the 30-minute limit and the
  watching setup stay.
- The review writing each comment into the Claude Code session through its message socket instead of `wait`: it
  is added on top of `wait`, not in its place; see the next entry.

**In a Claude Code session the review also sends each comment into the session through its message socket, and the
agent keeps `duru wait` running as well.**
A Claude Code session passes its inbox socket to Bash commands as `CLAUDE_CODE_MESSAGING_SOCKET`, and `duru review`
inherits it. A message there wakes the session with no command left running. The documentation
(code.claude.com/docs/en/cross-session-messaging.md) gives the socket, an optional first auth line and a size limit,
but not the shape of a message. On 2026-10-13 with Claude Code 2.1.296, a line
`{"type":"user","message":{"role":"user","content":"…"}}` after the auth line reached the session, while
`{"type":"message","text":"…"}` and a plain line did not, and the socket answered nothing in all three cases.
So a later Claude Code that changes the shape would drop the comments without a sign to duru, and `wait` stays the
path that is known to deliver. A comment that comes both ways is answered once by its `id`.
Alternatives compared:
- The socket alone in Claude Code, with no `wait`: the simplest skill, but a changed message shape would lose every
  comment silently.
- Asking for the shape to be documented before using it: the driver chose to measure what works and use it.

**The review page keeps drawing itself with its own code; a UI library is weighed again when the shared-server mode
of #42 is started.** Since records arrive on their own, the page redraws while a reviewer may be typing, and a
redraw replaces the fields: the page puts the focus and caret back in the field at the same place and holds the
redraw while a Korean syllable is being composed.
Alternatives compared:
- Rewriting the page with a library that redraws only what changed (React, Preact, Vue, Svelte): it keeps fields by
  itself, but every part of the page is rewritten and a build step or a downloaded library is added, for a problem
  that a few dozen lines solve today.
- Keeping the drawing code and replacing the redraw with a library that patches the new page into the old one
  (idiomorph, morphdom): the smallest step that keeps fields without restoring them by hand. Not taken while the
  page redraws on its own only when a record arrives.
The page reads and writes only through the server's requests (`/api/data`, `/api/events` and the saves), and the
files it saves do not depend on how it is drawn, so changing this later changes the page alone; what grows with
each feature added meanwhile is the amount of page to rewrite.

**The edges on either side of the review page's middle pane are dragged to change the pane widths; each stays the
1px line it was, grabbed across a 9px strip laid over it and drawn in the accent colour only under the mouse or while
dragged.**
Alternatives compared: a 6px edge that is always shown, which is found without a strip over it but takes room from
the panes and draws a heavy bar between them all the time. The thin line follows VS Code (a 4px strip, the accent
line drawn separately, lit 300ms after the mouse rests on it), Chrome DevTools (a 1px line under a 6px clear strip)
and JupyterLab (a clear overlay of at least 8px, darker on hover). While an edge is dragged no frame on the page
takes the mouse, as in VS Code, since the app frame in the middle pane would otherwise take it as it passes over and
the drag would stop there. Both views have the two edges, as the right pane is as fixed in the list as beside a
picked screen in the flow; the right pane is one width in both, and the drawing keeps the width it was dragged to
instead of half of what is left. Until it is dragged, the drawing takes half of what the right pane leaves at its
starting width, so dragging the right edge moves only the middle pane while the drawing still grows with the
window. The widths last only until the page is loaded again, since the page keeps nothing
in browser storage, and there is no keyboard resizing. Each pane has a floor: 300px for the list, where its three
tabs fit with three-digit counts and a classic scrollbar; 240px for the drawing, which scrolls sideways anyway;
360px for the middle pane, where the address bar over the app frame and the screen's title fit, while the table of
tests may still scroll sideways when a test's name holds a long unbroken word such as `@screen:/home#Home`, which no
fixed floor could cover; 320px for the right pane, where the comment form's status buttons stay on one line and its
placeholder fits on one line (302px measured). When the window gets too narrow for the middle pane's floor, the
side panes give up the width they were dragged to, each in proportion to what it has above its own floor; the
dragged widths are kept, so a window made wide again gets them back.

**A Playwright test whose trace passes two screens or more gives a story candidate, and a story accepted from it
keeps `{ "report", "tests" }` as its source.**
duru already reads the addresses each test opened from its trace for 「지나간 시험」, so a suite that runs with traces
on needs no code of its own to write visit records. The source of a visit record candidate, `{ "record", "steps" }`,
points at a file and a step range a reviewer can open; a trace candidate has neither, since several tests share one
candidate and the trace steps are not numbered for a reader. The report file and the test titles are what a reviewer
can find the tests by, so the source names those, and a story file takes either shape. duru versions before this
shape skip such a story file as breaking the rules. Tests passing the same order give one candidate, because a suite
whose tests all log in first would otherwise list 「로그인 → 홈 → 시험 화면」 once per test. Since the source names
one report, the tests of a report read later with the same order are not added (reports are read in the order of
`tests`, and by path within one entry); a run split into shards and kept as several reports names the tests of one
shard only. A test that passed a single screen gives no candidate,
since a story of one screen says nothing a screen does not. A candidate is chosen on the review page and in its
address by a key, the record file for a visit record and the screen order for a trace, as two trace candidates can
come from one report. Since candidates are kept in files, the key is the screen order for both; the entry on
keeping candidates says why.

**`rebuild` writes the screen order of each traced test into `tests.json` as `traced`, and the review page makes
trace candidates from it instead of reading the reports and traces itself.**
The candidates then change only at `rebuild`, together with the 「지나간 시험」 links read from the same traces, so
the two never disagree about a run. Reading them in the review server would unzip every trace on each load of the
page's data, and a page that reloads its data whenever a reviewer writes a record would repeat that for every
record. A cache in the server's memory would avoid the repeated reads, but it would still show runs newer than the
map and the links, and it would need its own rule for when a report changed. `rebuild` already reads each trace
once for the links, so the order is kept from that read. Only a run that passed is kept, since a failed run's trace
stops where the test failed and its order would offer a story cut short; a test marked to fail whose run passed is
left out too, as duru shows it failing. A `tests.json` from a duru before this key has no `traced` and gives no
trace candidates until the next `rebuild`.

**`baselineMap` names an earlier `map.json`, and what changed since it is worked out from the two files each time it
is shown, not stored.**
Alternatives compared: a git ref, from which duru would check out the old source, and writing the comparison into
`map.json`. A ref would make duru fetch the old source and the server API list of that version too, while a kept map
is already at hand. Storing the comparison would make `map.json` and `tests.json` differ with and without a baseline;
reading two maps when `rebuild` prints its line and when the page loads its data costs little next to reading the map
itself. Screens are matched by ID and calls by their ID, so a component renamed in place, or a route variable made
optional, shows as one screen gone and one added. A screen's conditions are only what stands between a user and the
screen: whether it is restricted, the kinds, each route guard with its kinds and roles, and the set of guard texts on
the links into it. Comparing the whole `access` object was tried on into-sign 1.4.2 → 1.5.0: it flagged 23 screens
whose guards had only moved to other lines, and comparing links with the screen they come from flagged 17, because a
new side menu adds a link into every screen; the guards alone flagged none, which was the true answer. A screen that
is not `restricted` on either map has no change of conditions: the comparison takes the map's own verdict that nothing
stands between a user and the screen, so a guard appearing, going or changing on a link into it is not counted. A
screen on both maps whose calls differ (by each call's `screens`) is a change of its own: a call gone from the map
does not say which screen to check again, and a call can leave a screen while staying on the map, as two calls left
the basic publish screen in 1.5.0 while other screens still send them. A call `unchecked` on either side is not
counted, since one side has nothing to compare. A map from a duru that did not record the roles a route guard lets
through is refused rather than read with what it has: an into-sign 1.5.0 map built that way from the same source as
the current one showed 12 screens with changed conditions and 32 with changed calls, all from duru reading more and
none from the client.

**A comment can be about one part of a screen or call, kept as the screen or call target plus
`part: { kind, key }`; the first kind is one test row, named by the result file, test file and title without tags.**
Driver's decision in #226. The key is made only from what the map, the test results or the stories give, never from
where the row sits on the page, so a comment stays on its test across `rebuild`s, 「떨어져 나감」 works as it does for
a target, and the task list can place it under its screen or call. A test is named the way a judgment already names
it, so a test is the same test to both, and a line moved above it or a tag added to its title does not lose it.
Whether a test is still there is looked up in the links before the reviewers' judgments are applied, so a comment on
a pair that is later discarded or handed over stays on its test. A part takes comments only: a status decides
whether its screen or call is on the task list, and a part has no status of its own apart from that. The field is
named `part` and not `cell`, since cell already means a depth or option cell of a call in this code.
Alternatives compared:
- Keeping the place pressed on the page, as a comment on a claude.ai artifact does: any spot could take a comment,
  but a change of layout breaks the place, an agent has to read the page to learn what it is on the map, and
  neither 「떨어져 나감」 nor the task list could place it.
- Making a test a new kind of target on its own: smaller, but the other parts (an opening condition, an incoming
  link, a story step) would still take none.
Known limit: if the choice proves wrong, the shape of the saved mark files and of the line an agent reads changes;
a mark with no part is the same as before either way.

**The bottom of the right pane is one conversation with the agent, and a bubble on a row puts that row in as the
tag of the comment being written.**
Driver's decision in #226, after trying five ways on a clickable mock-up. The conversation holds everything left
on the chosen screen or call, oldest first, each with its tag; the count on a row narrows it to that row, which is
that row's thread.
Alternatives compared:
- Keeping the form as it was: a test row could not take a comment, and nothing showed where one could go.
- Bubbles alone: the places show, but a comment can only ever point at one of them.
- A thread opened under the row, as in a GitHub review: the most page work, and open threads push the list down.
- A conversation with `@` tags alone: nothing shows where a comment can go, and whether the agent learns the place
  depends on the reviewer adding a tag.
Opening a row's comments under the row is left out; it changes neither the saved files nor the agent's line, so it
can be added to the page later. A comment carries one tag until #231 adds several or none.

**The right pane of a screen or call holds only the conversation; the screen info and a chosen call's details move
under the tables of the middle pane.**
The info above the conversation took most of the pane: on `/publish/document-basic/:id` the access summary sat at
the top and 142 settings read below it, while the conversation was held to 160px under the form, so a long answer
from the agent was cut after about five lines. Now the conversation fills the pane, open from the start, with the
form at its bottom. The screen info is a fold under the call table with the link and setting counts on its closed
line, and it stays as it was left from screen to screen; a chosen call's details open under the call table, since a
call is chosen to be looked at. Choosing a call scrolls the middle pane to its details, which would otherwise open
below the table out of sight; the driver compared that scroll, the call's name in the right pane's tag, and both,
and chose the scroll. 「이 화면을 열려면」 became 「접근 조건」, and the name in the middle carries 「역할」
or 「설정」 as the flow box does, so whether a screen is conditioned shows while the fold is closed. Replies lose the
「답」 label and their indent and are told apart by author and a light background; the tag of where a comment was left
stays. Figma's comment mode gives the whole right sidebar to the file's comments, Google Docs opens comments in a
panel of their own and can show every reply unfolded, and GitHub keeps the conversation and the code in separate
tabs: each puts the conversation where nothing else competes for its space, and shows replies unfolded. The labels
and the name 「접근 조건」 were the driver's choice on a clickable mock-up (#244).
Alternatives compared:
- Keeping the info on top and giving the conversation more height: both still share one 360px pane, and the longer
  either gets, the less of the other shows.
- Switching between info and conversation inside the right pane: either is one click away, but the conversation is
  hidden while the info is read, and the middle pane already has room under its tables.
The story tab's right pane is not changed here: its steps and 「사전 조건」 stay above, and its conversation stays
under the form behind 「대화 N」, until #358 unfolded it at the top of the right pane (see below).

**The line an agent gets for a comment on a test names the result file instead of carrying the failure message.**
The Playwright, Vitest and JUnit readers keep only each test's status, and only a verdict line keeps the text after
its verdict, which is passed on as `detail`. Reading the message of each format into `tests.json` would make that
file grow with every failure and add a reader per format for every format added later, while the agent that gets
the line can open the result file and find the test by its title itself.

**A comment on an opening condition is keyed by the role, or by the setting's case name with the state the
condition asks; a comment on an incoming link by the screen it starts on and the roles and settings read from it;
the source lines go only in `where`.**
Driver's decisions in #228, made on a page that changed the example source and showed what each choice did to a
comment. A role is `role:<role>`, as its case tag. A setting is the name its case tags carry (the path, and the
value after a colon for a list that must hold it or a setting that must equal it), with `=on`, `=off` or `=present`
after a path that is asked a state. The case tag itself is not used as it is: its `=true` and `=false` say whether a
test met the condition, not what the condition asks, so `settings.X` and `!settings.X` give the same two tags, and a
comment on one would show on the other; reusing `=false` to mean "asks off" would make one spelling mean two things.
A list value and an equal value share a name, as the case tags do. A link is named by what duru read from it rather
than by its guard as written, so a guard moved into a variable or onto another line keeps its comments; only when
nothing was read is the guard text the key, and links from one screen that read the same share one key. No line
number is in either key, so a change that only moves lines keeps the comment, and 「떨어져 나감」 means the condition
or the link is gone. The lines given to the agent are the route line of the screen and the line of each link the
condition is read from: duru reads a condition only where it is written there, so that line is the evidence, and the
map stays as it is. A guard in a function a link calls gives that function's name (`via`), and roles written in
`roleGuards` give that key.
Alternatives compared:
- The case tag as it is (`setting:<path>=true`): one spelling for a comment and its test, but on, off and present
  of one path fall into one slot.
- The path alone: shorter, but every value of a setting with several, and on with off, share one slot.
- A link named by its guard as written: needs no reading, but a guard moved into a variable detaches its comments.
- Adding the line of each condition's own expression to the map: more exact only for a condition inside another
  function, at the cost of changing the extractor and `map.json`.

**A comment on a story candidate has a target of its own, `{ candidate: <key> }` with nothing else, and is saved in
`stories/candidates/<key>/` in the marks folder, apart from the marks on stories.**
Driver's decision on 2026-10-13, for #230. The key is the one the page already gives a candidate and puts in its
address: the screen order joined with ` > `, for a candidate from a visit record as for one from a trace. A candidate
is not a story yet, so a comment on it takes no status, never enters the task list, and reaches the agent only as the
line printed while the review runs, which carries the record and its steps or the result file and the test titles,
and the screen order. When the candidate is accepted or discarded it leaves the list, and its comments show under
「떨어져 나감」 with the name it had, which the candidate data keeps for the candidates that left.
Alternatives compared:
- Putting the key in `target.story`: no new kind of target, but a story ID may hold only `a-z`, `0-9`, `-` and `_`,
  and a screen order does not fit, so the check on every story mark would have to loosen; once it did, a key could
  be the ID of a story, and the comments on that candidate would share one history with the marks on the story,
  also after the candidate is accepted under that ID.
The screen order soon passes the 255-byte limit of a folder name (six screens like
`/settings/users/:userId/edit#UserEditPage` already do), so a key whose file-safe form is longer than 80 characters
names its folder by the first 71 characters of that form and a short hash of the whole key; which candidate a comment
is on is read from its target, so the folder name decides nothing else.

**The review page draws the app at a width picked above the frame, 1280 at first, and by default shows it smaller
when the pane is narrower; a percent picked beside it shows it at that size instead.**
With a screen picked in the flow view, the frame gave the app 747px at a 1920px window and 507px at 1440px, so an
app laid out for a desktop width lost its right side or wrapped into a layout its users never see. The app now gets
the picked width and is scaled down by the largest whole percent that fits the pane: 1280px at 58% at a 1920px
window and at 39% at 1440px. This is how Chrome DevTools' device mode fits a device to the window. The app's height
is the frame's visible height divided by the scale, so the visible part is all of the app's window. The scale is
worked out again whenever the frame's box changes size, whether the window or a pane boundary moved.
Alternatives compared:
- Giving the app the pane's width, as before: nothing to build, but it is the layout above, and the reviewer judges
  a screen the users do not get. It stays as 「칸에 맞춤」 for an app that is built to fit any width.
- Drawing the app at its real width and letting the frame scroll sideways: text keeps its real size, but the whole
  screen is never in view at once, and what sits on the right needs a scroll before it can be seen.
Choices inside it:
- The scale is shown as a sentence beside the pickers, and the percent is a select rather than − and + buttons: the
  flow drawing's zoom already shows a percent with − and +, and a second such control would read as the same zoom.
  Responsively App puts −, percent and + in its status bar and has no fit mode; here fitting is the first choice.
- The percent is not lowered further to make width × scale whole pixels, as DevTools does: for 1024 only multiples
  of 25% do that, so a fit just under 100% would drop to 75% for sharper edges.
- The picked width and percent last until the page reloads, like the drawing's zoom, since the page keeps nothing in
  browser storage.

**The width can be typed, and the percent can be picked: 「칸에 맞춤」 first, then 25, 50, 75, 100, 150% or a typed
one, with the frame scrolling sideways when the app is wider than the pane.**
Fitting alone left a 1280px app at 38% in a 486px middle pane, too small to read, and 1024, 1280 and 1440 gave no
way to see a phone or tablet layout. The width list gains 375 and 768 and a typed width; the percent list starts at
「칸에 맞춤」, which keeps the fitting above, and a picked percent holds whatever the pane's width. Unreadable text
weighs more than the worry above that a percent control reads as the flow drawing's zoom, so the percent is now
pickable, as a select beside the width rather than − and + buttons. When the width is 「칸에 맞춤」 the percent cannot be
picked, since the app is the pane's own width and only its real size fits. The frame scrolls sideways inside itself
and the page does not, and the app's height still follows the frame's. The scrollable width is the app's shown
width, not its drawn width, so a percent below 100 does not leave blank room to scroll into.
Alternatives compared:
- Typing a width only, with the scale still worked out from the pane: a phone width would fit, but a desktop width
  in a narrow pane stays as small as before.
- Leaving it as it was: nothing to build, but a 1280px screen in a narrow pane stays unreadable and a phone layout
  cannot be seen.

**A story candidate's name and a test row's title leave out the test's tags; a test row shows the tags other than
those of the place it sits under as labels of their own, read from a `tags` list each test in `tests.json` now
carries; the Playwright empty test puts its tags in the `tag` option.**
In #248 a candidate came out as 「… 부서는 그대로 @screen:/admin-member#AdminMember @depth:ui」, and 「고쳐서 받기」 offered
that as the story's name and ID. The tags read as part of the title. The Playwright HTML report shows a test's tags
as separate labels after its title, without the `@`, and Allure removes such marks from the name it shows; neither
mixes tags into a title. Hiding the tags of the screen, call, story and depth a row sits under comes from neither:
the row already sits there, and the driver asked why those tags were shown.
The labels need the tags written in Playwright's `tag` option too, which the title does not hold, so `tests.json`
carries each test's tags (driver's decision). A `tests.json` written before that has no list, and the page then
reads the tags from the title.
Alternatives compared:
- Reading the labels from the title only: `tests.json` stays as it is, but a test whose tags moved into the `tag`
  option, as the task list now asks, loses its role and setting labels.
- Taking the tags off the title in `tests.json` itself: the title is also what judgments, comments and the untagged
  list match on, so every match would have to change with it.
The test's identity is unchanged: a judgment or comment names the test by its result file, test file and title
without tags, so moving a tag from the title into the `tag` option keeps what was left on it.
The Vitest empty test keeps its tags at the end of the title (driver's decision): the Vitest reader also reads Jest
results, and Jest has no tag option, while Vitest's own `tags` option exists only from 4.1.0 and stops the run on a
tag its config does not define.
Known limits: every word starting with `@` counts as a tag, as it already did when tags were read, so a title word
such as 「@Valid 검증」 is left out of what is shown. The `tag` option came in Playwright 1.42, so an older project
puts the tags in the title as before. With the tags out of the title, the Playwright empty tests of one item share
the title `<what it checks>` until the writer replaces it, which README and the agent skill ask for.

**Discarding a story candidate asks for its reason in the window that excluding a test pair uses, and both use
that one window.**
A candidate showed a reason field and a 「버리기」 button under their own heading all the time, while 「고쳐서 받기」 and the
pair's 「제외」 on the same page asked in a window. The window now takes what is being discarded, the button's name
and where the reason is saved, so a later place that asks for a reason uses it too. GitHub asks for the reason only
after 「Hide」 on a comment is pressed, and Jira shows a comment screen when a workflow button is pressed; neither keeps
a reason field beside the item.
Alternatives compared:
- Keeping the field and only dropping the heading: nothing to build, but the page would still ask for a reason in
  two ways.
- A second window for candidates: the look, Ctrl+Enter, Escape and the error after a failed save would have to be
  kept the same in two places by hand.

**CI runs on pull requests only, not again on main after a merge.**
Since CI was added (#183, 2026-10-09), every change has reached main through a pull request whose branch was first
moved onto the tip of main, and its CI run tested that exact content. The run that `push` to main started after each
merge tested the same content a second time. The costs: a commit pushed to main directly is not tested, and nothing
in GitHub stops a pull request from being merged without first moving onto the tip of main (main has no branch
protection), so that habit is what keeps main tested. The npm cache that every pull request shares is saved only by
runs on main, so after `package-lock.json` changes, or once GitHub deletes that cache after seven days unread, each
pull request's first run downloads the packages again.
A pull request that changes only `CLAUDE.md` does not run CI: no test reads that file, and the run would test the
code main already holds. `README.md`, `skills/duru/SKILL.md` and `docs/decisions.md` are read by tests and stay in.
Alternatives compared:
- Keeping both runs: main is tested whatever reaches it, at the cost of a second run of about ten minutes per merge.

**A story candidate is kept as a file in `candidates/` in `storiesDir` from the first `rebuild` that finds it, and
every candidate is keyed by its screen order.**
Candidates used to be worked out on each `rebuild` and page load from the visit records and the `traced` orders in
`tests.json`, and kept nowhere. A `rebuild` after running only part of the tests left `traced` empty and every trace
candidate gone; that happened in the into-sign 1.5.0 check on 2026-10-13. An accepted candidate was already kept as a
story file and a discarded one as a file in `discarded/`; only the ones not yet chosen were lost. `rebuild` now writes
one file per screen order that has none, holding the name, the screens, the source and the date first seen, and,
like `discarded/`, never changes or deletes one, so files written on two computers merge in git without a conflict
(two files with the same order are listed once). A file is named by the date and eight letters of a random ID; it
has no author, as no one chose it. The list is the files together with what the records and traces give now, and
when both have an order the fresh one is shown, so its name follows the current test titles. Accepting or
discarding leaves the file, and the story or the discarded file keeps the order out of the list. A candidate whose
screen has left the map stays listed with that step off the map, as a candidate from a record already did when an
address matched no screen.

Keeping candidates is also why the key changed. A visit record candidate was keyed by its record file, but once the
map changes a record can give a new screen order while the stored candidate from its old order stays listed, so two
candidates would share one key and the page, the address and accepting would pick whichever came first. The screen
order is unique in the list, since the list already offers one candidate per order, and it stays the same whether a
candidate comes from its file or is worked out again, and when a record file is renamed. An address copied before
the change that names a record file no longer selects the candidate.

Alternatives compared:
- Merging the `traced` orders of each `rebuild` into those of the last: candidates are worked out as before, but the
  orders of a test that was deleted or renamed stay, and when to drop them would need a rule of its own.
- Only showing on the page why there are no candidates: nothing about the data changes, and the candidates still
  disappear.
- Keeping the record file as the key of a visit record candidate and hiding a stored candidate when a record gives
  the same key with a new order: the record's reading now replaces the old one, but a candidate whose screen left the
  map would not stay listed with that step marked, and the hidden files pile up.
- Keeping the record file as the key and giving a stored candidate whose key is taken its file path as the key: the
  key of that candidate would change once its fresh twin is gone, so a copied address, or anything else that names
  it by key, would stop finding it.

**Undoing an accepted candidate deletes its story file; the discarded candidates are listed, folded, below the
candidates.**
#249 asked for a way back from 「스토리로 받기」 and 「버리기」. A story file is already rewritten in place when its name
or memo is edited, so it is not an add-only folder, and deleting it is what undoes the acceptance: the candidate comes
back from its records, its traces or its file in `candidates/`, and the comments on the story come off their target
as they do for any story file that is gone, so they show under 「떨어져 나감」. Only a story whose file has a `source` has
the button, since a story written by hand or with 「새 스토리」 came from no candidate. The page does not ask first, like
Dependabot's and code scanning's 「Reopen」. The discarded candidates are listed below the candidates, folded, like the
closed alerts on GitHub that are hidden until 「Closed」 is opened, with each screen order once, by its latest discard,
since the latest record of an order is its state.
If `candidates/` has no file for the order yet, which happens when a candidate was accepted before a `rebuild` stored
it, undoing writes one before deleting the story, so the candidate still comes back once its record or trace is gone.
It is named by the story's ID: the ID was made from the candidate's name and stays a valid ID, while the story's name
is often Korean and would give 「스토리로 받기」 an empty ID. If writing that file fails, the undo is refused and the
story file stays; when `candidates` in `storiesDir` is a file, nothing is written there, as `rebuild` writes nothing
there either, and the undo goes on.
Alternatives compared:
- Writing a record that the acceptance was undone, in a folder that is only added to: a story file is not
  add-only, so nothing would merge better, and every place that reads stories (the story list, the task list, the
  stories of the flow) would have to leave the undone ones out.

**Undoing a discard writes an undo record into `discarded/`, with `"kind": "undo"` and no reason.**
Driver's decision in #249. `discarded/` is only added to, so files written on two computers merge in git without a
conflict, and the undo keeps that: it writes a new file beside the discard instead of deleting it, the latest file of
a screen order is its state, and the reason the order was discarded stays in its file. The record is marked with
`"kind": "undo"`, the name the pair judgments already use for their 「되돌리기」, so one word reads the same in both
folders; a discard keeps having no `kind`. No reason is asked, like Dependabot's and code scanning's 「Reopen」. As
undoing an acceptance does, the undo writes the order into `candidates/` first, under the name the discard kept, so
the candidate comes back once its record or trace is gone. A duru older than this reads an undo record as a discard
with no reason, skips it, and keeps the order out of its list.
Alternatives compared:
- `"undo": true` on the record: leaves the discard's shape as it is, but writes the same undo in two ways across
  the pair judgments and the discards.
- A separate `restored/` folder: leaves `discarded/` alone, but the latest record of an order would have to be found
  across two folders, and there would be one more folder to read.

**A story picked in the flow is drawn as its steps alone, left to right on one line, with the link verdict on the
line between each two; the stories are picked from a list left of the drawing.**
Driver's decision in #250. The story view of #131 kept the main flow and cut away every screen that was neither a
step nor above one. The main flow places each screen once, where it is first found from an entry, so a step often
sits under a screen unrelated to the story. On into-sign 1.5.0 with its 6 stories, only one (deleting a member) ran
straight down the tree: in three, two neighbouring steps were drawn as siblings and joined only by number chips; the
signer's story drew `/view/:documentId`, which is not a step, because `ParticipantViewer` had been placed under that
entry first; and the sign-in story's two steps are both entry screens, so the move written in `moves` between them
had no line. #131 took the flow drawing as it was, and no other way was compared then. Drawing the steps alone
gives every two neighbouring steps a line of their own, so the verdict can always be drawn there, and a screen the
story passes twice is simply drawn twice. Where the map has no link, the drawing does not bring the tree back,
since the tree has no path between the two screens either; it lists the screens the step before does lead to. This
follows Maze, which draws only the expected paths, and Amplitude's funnels and Momentic's app graph, which lay
steps out in order and mark trouble between two steps or at a step; Katalon TrueTest paints a path over the large
map, which is what #131 did. The code that lays a story over the whole flow stays, for writing a new story by
pressing boxes in the flow (#252), where the next step has to be picked from the whole drawing.
The list replaces a select in the bar above the flow, which had to be opened to be seen, showed names only, cut
long names at 300px and could not be searched. It goes on the left, as Figma's presentation view and Playwright's
trace viewer list what can be picked on the left and show the picked one beside it, and as the list view already
does; the right column holds the gaps list and the picked screen's panes, and is to hold the conversation with the
agent. The list's rows, filters and search are those of the stories tab and are shared with it. It is shown only
when there are stories, as the select was, so a flow with no story files keeps its whole width. One button folds
and opens it, in the top corner of the drawing as the zoom buttons are in the bottom corner, so it rides the list's
edge as the list slides and stays in the same corner of the drawing either way; the drawing starts below it.
The picked story's name, 「경로 끄기」 and the legend sit beside that button rather than in the bar, so picking a story
does not make the bar taller and push the list down. The strip of steps #131 put under the bar is gone: it showed
the steps and the verdict between each two in order, which the line drawing now does itself.
Alternatives compared:
- Keeping the cut-down tree: nothing to build, but neighbouring steps keep landing on separate branches, and a
  screen that is not a step keeps being drawn.
- The select in the bar, widened and given a search box: the status and verdicts still do not show until it is
  opened, and a native select cannot show chips on its options.
- The list in the right column: it would push out the gaps list and the picked screen's panes it already holds.
- Folding the list to a strip with its name written down it: Korean stands upright in vertical writing but the
  count lies on its side, and the driver found the vertical name hard to read.
- A button at the left end of the bar above the flow to open the folded list: the button that folded it sat at
  the head of the list, so the place to press moved from one row to another with each fold.
- Keeping the strip of steps in the bar: pressing a step there brought a far step of a long story into view, which
  scrolling or zooming the drawing does as well, and the strip added a row to the bar each time a story was picked.
Known limit: the line drawing shows no link from a step to screens outside the story; the flow, with the story
turned off, still does.

**The flow follows the moves in `moves` by the rule it follows links by, and a move never moves the screen it
reaches.**
Only the story verdict read `moves`, so a move written in the config left the flow as it was. Now a move places a
screen not yet drawn under the screen it leaves, with a green dotted line, and a move to a screen already drawn in
another branch is kept with the links into other branches: nothing is drawn, and picking the screen it leaves
marks the screen it reaches. On into-sign 1.5.0 the move written for sign-in is of the second kind: `/signin` and
`/user-home` are both entry screens, and `/user-home` is reached by five redirects in `Routes.js`, so it stays a
root and picking `/signin` marks it. Between the same two screens a link with no guard is drawn as a link, and
otherwise a move is drawn over a guarded link and the link's guard is left out, in the order the story verdict
uses. The dotted green line is the one the story drawing is to use between two steps a move
joins, so a move will look the same in both.
Alternatives compared:
- Moving the screen a move reaches under the screen it leaves, even when it is drawn elsewhere: the move would show
  as a line, but `/user-home` would leave the root it holds for five redirects and sit under `/signin` as if it
  were reached only from there.
- Leaving the flow to links only: nothing to build, but a move written for the stories would say nothing in the
  flow, and a screen reached only by a move would be drawn as a tree of its own.

**「전체」 groups comments by the screen, call or story they were left on, and a screen's count covers only its own
conversation.**
「이 화면」 already treats a call as a conversation of its own, so 「전체」 gives a call its own group and a screen's number in
the list and the flow counts what its own conversation holds, leaving out what has come off its target as 「전체」 does;
pressing a line or a number therefore lands on a conversation that holds every entry counted. A comment waits for a
reply when it has no status and no reply, the rule `wait` and `GET /api/events?unanswered` already use, though those
also count a comment that has come off its target: a status is a verdict, not a question to the agent. A mark that
carries only a status is left out of the numbers and of 「전체」, apart from case kind picks, which 「전체」 lists under
「변경 기록」 only (see the next entry): the status chip on the same row already shows it, and counting it would call a
pressed status button a comment.
Alternatives compared:
- A call's comments under its screen: a call can be called from several screens, so its comments would sit in
  several groups or in one picked at random, and pressing them would open a conversation that does not hold them.
- A screen's number counting the comments on its calls too: the list would show comments the screen's own
  conversation does not show.
- Counting a mark with no text: a screen marked 「충분」 would read 「코멘트 1」 though nothing was written, and the
  badge would repeat what the status chip beside it says.

**A case kind picked or taken out is left out of the conversation of its screen or call and out of every count, and
「전체」 lists the picks under a filter of its own, 「변경 기록」, as one list by time.**
A pick is kept as a mark so that who picked which kind where and when is not lost (see the entry on kinds of test case
named in the config). Shown in the conversation, every press of a kind button added a 「필요」 or 「필요 없음」 line that
could not itself be pressed, so turning a kind on and off filled the conversation with lines that are not talk with
the agent; the current state is what the buttons under 「경우별 테스트」 show. So the conversation of a screen or call
leaves out every mark whose target names a case, and so do 「이 화면 N」, 「전체 N」 and the counts in the list, the flow and
the rows. This narrows the rule above that 「전체」 leaves out marks carrying only a status: the picks are status-only
marks too, and they show only under 「변경 기록」. The mark files are written as before, and the task list and what the
review prints do not change. A pick is told apart by its target naming a case, not by an empty note, so a pick that
later carries a reason stays out of the conversation as well.
「변경 기록」 is the last button of 「전체」's filter row, shown only when `caseKinds` is set. It lists every pick on its own
line, latest first, across screens and calls rather than grouped like the other filters, because what it answers is
who changed which kind and when; each line names its screen or call, 켬 or 끔, the kind, and always its author, even on
a page only one reviewer has signed, where other lines leave the author out. 「미답변 N」 keeps counting the
comments while 「변경 기록」 is chosen. Pressing a line opens the screen or call, opens the fold that holds
「경우별 테스트」 and scrolls the middle pane to it, since that is where the pick lives now.
Alternatives compared:
- Keeping picks in the conversation: the lines pile up with each press and cannot be pressed to change the pick.
- Dropping the records from the page: nothing on the page would say who picked a kind or when.
- A 「코멘트만」 filter beside 「모두」: the conversation would still show the picks until the filter is chosen.
- Showing the history with the comments by default or in a tab of its own, as GitLab (system notes with 「Show history
  only」), Jira (「History」 beside 「Comments」) and GitHub (`labeled` / `unlabeled` events in the timeline) do: duru's
  conversation is talk with the agent, and its default filter is 「모두」, so the picks would be back in the default view.
- A 「변경 기록」 row in each screen's or call's own conversation: every screen would get a new row above its
  conversation, and 「전체」 already has the filter row.

**A comment on a step of a story is keyed by the step's number and its screen, and one on the link between two steps
by the number of the step it leaves and both screens, under the story's own target as parts `step` and `hop`.**
#229 asked for the number and the screen: duru writes a story's screens once and edits only its name and memo, so the
number of a step does not move, and the screen beside it tells a step apart when someone edits the file by hand; a
comment whose number now points at another screen comes off rather than moving to a step it was not written on.
Numbers count from 1, as the page and the task list show them. The link part is named `hop`, not `link`, since
`link` is already the part for a link into a screen. The story drawn in the flow gets the bubbles but not the counts:
its boxes already carry the count of the screen's own conversation, and a second number on the same box would not
say which is which.
Alternatives compared:
- The screen alone: a story may pass a screen twice, so the key would not name one step.
- The number alone: a comment would move silently to another screen when the file is edited.

**A comment on several targets or none is saved once with a `targets` list, and a comment on one target keeps
`target`.**
#231 asked that one comment carry several tags or none. A single file keeps one record for one question, so a reply
answers it once and the agent answers it once; the page and the task list place it under each of its targets and count
it once wherever it is listed. Keeping `target` for one tag leaves every mark saved before readable as it is, with no
file moved, and a mark with one tag is still the only kind that takes a status, since a status is the verdict on one
place. The file goes to the folder of its first target, so marks on a screen stay together in git, and a comment with
no target goes to `general/`, beside `stories/`; which targets a mark is on is read from the file, never from its
folder.
Alternatives compared:
- Always `targets`, also for one tag: one shape to read, but every mark already saved would need moving or a second
  reader, and the status rule would turn into a length check on a list.
- One file per target: each conversation would see a copy, a reply would land on one copy only, and the agent would
  answer the same question several times.
- Every comment with several targets in `general/`: the files of a screen would be split between two folders by the
  number of tags.

**The review server watches the stories folder and tells the open pages over the same event stream, as a named
`stories` event that carries a hash of the folder's contents; a page skips the event when the data it last read has
the same hash.**
Story files change from outside the page as part of the work: edited in an editor, brought in by `git pull`, written
by another duru command. Unlike a reply, which an agent sends through the server, those changes never pass through
it, so watching the folder is the only way to hear of them. The worry noted against watching the marks folder (that
`fs.watch` does not behave the same on every system) costs less here: a missed event leaves a page showing the old
stories until the next change or load, and nothing is lost. A burst of writes is told once, 100ms after the last.
A named event goes to the page's own listener, so the comment lines stay as they were: `duru wait` reads only events
without a name (before this it would have failed to read the line and connected again), `onMark` and the review's
standard error are not called, and the agent sees no folder change. Each folder is watched on its own, and the
nearest folder above `storiesDir` that exists is watched for its name, so a folder made later, or deleted and made
again, is watched again; `storiesDir` naming one file is watched through its folder the same way. One recursive
watch is not used: on Linux Node keeps it on each file, so after `git checkout` or an editor's save by rename
replaces a file, no later change to that file is heard, while a folder's own watch reports every name in it.
A folder deleted and made again is told by its path being reported by the folder above, not by its inode number:
on Linux the folder made again can get the same number.
A page's own story save is skipped on the page: the server sends the hash of the folder with each event and with
`/api/data` (measured before the data is read), and the page ignores an event whose hash equals that of the data it
holds, or, during its own save, compares after the save's own reading. Comparing contents rather than remembering
who saved keeps a second open page updated by the first page's save, and makes an editor that writes the same
content again send nothing.
Alternatives compared:
- Skipping on the server, by holding back the notice while a story save is being handled: the saving page reads the
  data again anyway, but every other open page would miss the change.
- Polling `/api/data` every few seconds: it reads the whole review data again when nothing changed, as noted for
  the replies.
- Unnamed `data:` lines with a `duru` kind of their own: `duru wait` and any other reader of the comment lines would
  have to learn to skip them.

**A story's needs and expected results are written in its own file: `needs` and `expects` at the top for the whole
story, and the same two inside a step, which is then an object `{ "screen", "needs", "expects" }` in `screens`.**
Driver's decision in #275, built in #279. The memo of #66 already carried what the code does not show, such as the
data a flow needs, but as one free text the task list could only pass on whole. A need or an expected result is now
a line of its own, placed on the whole story or on one step. Putting them inside the step keeps each with its step
when steps are added or removed, and a screen the story passes twice has a separate object for each pass. A step
with nothing written stays a screen ID, so every story file written before reads as it did. In this first part a
line is plain text: duru carries it to the page and the task list and judges nothing; pointing a need at a shared
setup file, conditions on the link into a step and input values come later on the same shape. The story read from
the file keeps `screens` as the list of screen IDs, and the step objects' lines go into a list beside it, since the
candidate comparison, the place of a comment on a step and the path check all read the screen order as that list
and stay as they were. On the page the 「스토리」 box shows only when the story has lines of its own; its own labels
(「조건」, 「끝난 뒤 기대 결과」) and its place in the center keep it apart from 「사전 조건」, which duru reads from the code
and shows on the right.
This follows three tools read on 2026-10-15. TestRail keeps a test's preconditions in one text field
(`custom_preconds`), and its 「Test Case (Steps)」 template keeps the steps as an ordered list of
`{content, expected, ...}` objects, so the expected result sits in the step
(https://support.testrail.com/hc/en-us/articles/15760060756116). Gherkin puts preconditions that several scenarios
share in a Background and a scenario's own in its Given steps (https://cucumber.io/docs/gherkin/reference/). Xray
treats a test's precondition as its 「step 0」 (https://docs.getxray.app/display/XRAYCLOUD/Precondition). Hence
fields at the top of the story, which is one test, and inside each step, with the expected result in the step as
TestRail has it.
Alternatives compared:
- Lines kept apart from `screens` and pointing at a step by its number (`at`, `between`): `screens` stays a list of
  IDs, but whoever edits the file by hand has to renumber them when a step is added or removed.
- Lines kept apart and pointing at a step by its screen ID: no numbers to keep, but a story that passes a screen
  twice cannot say which pass is meant.
- BPMN, Gherkin or a language of our own: each would need its own extension to hold screen IDs and the lines on
  steps and links, and brings the rest of the borrowed format along; Gherkin steps are free sentences, so the same
  shape could not be filled without an agent.

**A condition on the link into a step is written in that step as `linkNeeds`, a list beside its `needs` and
`expects`, and the first step cannot have it.**
Driver's decision in #275, built in #280. The same two screens can be joined in more than one case, such as 「반려된
경우」, and which case the story takes belongs to the link, not to either screen. Camunda keeps a condition inside the
link (`conditionExpression` in a `sequenceFlow`,
https://docs.camunda.org/manual/7.16/reference/bpmn20/gateways/sequence-flow), Stately puts a guard on the
transition and its editor writes the guards on the arrow in the order they are checked
(https://stately.ai/docs/guards, https://stately.ai/docs/editor-states-and-transitions), and GraphWalker's model
JSON gives the edge its own `guard`
(https://github.com/GraphWalker/graphwalker-project/wiki/JSON-file-format:-edge), all read on 2026-10-15. Hence the
condition on the link rather than on the step before, and written under the line in the flow's one-line story as
Stately's editor shows it. In all three the condition is an expression the tool runs; no tool was found that hangs a
condition a person writes in words on a link, and duru keeps it as text, or as a pick of a need file like a step's
own need, because it judges nothing. A story file has
no object for a link, so the link's lines sit in the step the link comes into: they move with that step, and the
first step, which nothing comes into, has none. The task list puts them first under their step, before the step's
own needs, in the order a test meets them. On the page they show on the link row of the stories tab and not in the
step card, and the step's count in the flow leaves them out, since they are already written under the line before
the box.
Alternatives compared:
- `linkNeeds` on the step the link leaves: the line would show under the step before, and a step with two ways out in
  two stories could not say which link it means.
- A list of links beside `screens` pointing at a step by its number: whoever edits the file by hand has to renumber
  it when a step is added or removed, the reason step lines went into the step objects.

**An input a person writes for a step is a box and a value, `{ "box": { "placeholder" | "label" | "testId", "nth"? },
"value" }`, and duru shows and carries it as not checked against the code.**
Driver's decision in #275, built in #281. Both directions that will use an input later, filling a candidate's inputs
from a test record and drafting a test from a story, need "which box, found by what, gets which value" as it is; a
line of text such as 「이메일 칸에 member@example.com」 is easier to write, but each direction would have to guess the
box out of the sentence. The mockup showed both, and the box shape was chosen. The box is found by the words the
screen shows, because a reviewer writes it while looking at the screen and does not know translation keys or code
names: Playwright recommends finding a box by its label or placeholder rather than by CSS or XPath
(https://playwright.dev/docs/locators), and Testing Library ranks role, label, placeholder and, last, test ID
(https://testing-library.com/docs/queries/about/). Writing which kind of words they are lets a test pick
`getByPlaceholder`, `getByLabel` or `getByTestId` without guessing. Several kinds may be written for one box, as the
Chrome DevTools Recorder keeps several selectors for one step
(https://developer.chrome.com/docs/devtools/recorder/reference), so the review page can still find the box when one
of them changes. The code `duru story` writes for an input needs a box that has every word (the entry on that code
below), so an agent whose code finds no box tries each word alone. `nth`, counted from 1, names one of several boxes
the same words find, as Maestro picks the Nth match
(https://docs.maestro.dev/api-reference/selectors); all read on 2026-10-15. A file with a box that has no words,
empty words, a kind duru does not know, or an `nth` below 1 is not read, like any other malformed story file, so
a test never gets a box it cannot look for. duru does not look for the box in the code, so the task list writes
`(not checked against the code)`; since #300 the page looks for it in the running app when its line is pressed (the
next entry). The task list writes the words and the value as JSON strings, so spaces at the ends of a value and quotes
inside the words stay visible.
Alternatives compared:
- One line of text per input: easier to write, but a test or a record would have to turn the sentence into a box.
- The field names of the request the screen sends: into-sign 1.5.0 has no TypeScript, so duru cannot read the body
  types, and a box whose value is never sent to the server could not be written.
- A CSS or XPath selector: a reviewer cannot write it from the screen, and Playwright advises against it.

**Pressing an input line looks for its box in the app duru serves, through the script duru already puts into every
app page, and whether it was found shows only on the page.**
Asked for in #300 (2026-10-19). On the card alone a reviewer cannot tell which box on the screen
「라벨 「서명자 메모」 · 2 번째」 is. The app runs on a port of its own for each account, since the browser keeps storage per port, so the review
page cannot read inside the app frame. It posts the box to the script duru puts after `<head>`, the one that reports a
walk, and the script answers with where each matching `input` or `textarea` sits and which of the written kinds
matched it, never a value. It answers only a request from its parent window at one of the review page's origins, as
the walk report goes only there. The script compares the words of each `input` and `textarea` with the written ones after
cutting spaces at the ends and making runs of spaces one: the placeholder, `data-testid`, and for a label the first
`<label>`'s text, `aria-label` or the text of the elements `aria-labelledby` names (the last two since #348; before,
`aria-label` counted only for a box without a `<label>`). It takes the boxes that have every written word; when fewer
boxes have them all than `nth`, it takes the boxes that have any one of them. `nth` counts in document order within
the boxes it took. A walk writes `nth` among every element of the page that has all its words, as the code
`duru story` writes counts them (the entry on that code below), and takes a label only from the first of
`aria-labelledby`, `aria-label` and `<label>` that a box has, while the page counts only inputs and textareas and
takes a label word from any of the three. Where a button or a wrapper carries the words too, as a search box and a
search button with one `aria-label`, or where a box's `<label>` has the word and its `aria-label` another, as a box
with the `<label>` 「메모」 and the `aria-label` 「서명자 메모」 before a box with only the `<label>` 「메모」,
the page's number can differ from the walk's and the code's: the driver chose
in #348 to keep the page's lookup as it was, and this is a known limit. Several kinds are written so that the box can
still be found when one of them changes (the entry above). The task list joined them with `or` until the code
`duru story` writes for an input needed a box with every word (the entry on that code below); it now joins them with
`and`. The script counts once the page has had no change for 300 ms, waiting at most 3 s, so a box the app draws when
its data arrives is counted, and the count does not depend on how fast the data came.
The cut is the live app in a frame of its own at the app width, made taller, up to 4000 px, only as far as the counted
box and the boxes within one cut's height of it need; the frame is scaled and moved so that their region fills the
right pane. Boxes with the same words are cut together only while the app's text can still be read: the app is shown at
no less than three quarters of its size, where the browser's default 16 px text is 12 px, the size of the review
page's own small text. Driver's decision in #300 (2026-10-19), chosen from screenshots of the demo app, where the three
「서명자 메모」 boxes sat at 234, 257 and 1926 px and cutting them together shrank the app to a fifth of its size, so
that only the numbers could be seen: when the boxes do not fit together at that size, the cut stays around the counted
box, the boxes near it that fit still show with their numbers, and the note under the cut says on which side of it the
others are, as in 「3번은 이 그림 아래쪽에 있습니다」. When no box is found, the top left of the app screen is shown at
that size rather than the whole width shrunk into the pane. The outlines and numbers are drawn by the
review page over the frame, so nothing is drawn inside the app and the box shows empty, as the app has it, with the
value on the line above. The small picture is a rectangle in the page's proportions with the cut marked, worked out from
the page size the script sends. The frame is apart from the middle pane's and sits in a place of its own above the
right pane's content, so typing a comment or a live reload does not reload it, and another line on the same screen and
account asks again in the same frame. Driver's decision in #300 (2026-10-19): 「앱 화면」 is a block at the top of the
right pane with 「닫기」 and the story's pane below it, not a tab beside the story's pane, and 「가운데에 앱 화면 전체 열기」
opens the whole app in the story tab's middle pane, with 「단계 카드로 돌아가기」, rather than switching to the list view.
In the mockup the driver also chose that lines on a new story's cards cannot be pressed, as their values were typed in
the app while it was recorded; lines on a screen not on the map and in 「순서 고치기」 cannot be pressed either, since the
first has no address to open and the second shows an order not yet saved.
Driver's decision in #300 (2026-10-19): whether the box was found shows only on the page, until it is reloaded, and is
written to no file and not to the task list, which keeps `(not checked against the code)`. Whether a box can be found
depends on the data in the running app, a second signer's memo only when there is a second signer, so a kept result
would soon be stale. For the same reason `skills/duru/SKILL.md` still tells the agent that duru did not look for the
box: the agent reads the task list, not the page.
Showing the target on the screen as it is follows Playwright's trace viewer, the issue's reference, which colours only
the target element on the screen of each action.
Alternatives compared:
- Keeping the result in the story file or the task list: stale as soon as the app's data changes, and pressing a line
  would change a story file.
- A screenshot taken by the review server with Playwright: `playwright-core` becomes a dependency with a browser to
  download, and the picture is not the app the reviewer has open.
- The review server passing the app through its own port so that the page can read the frame: turned down for
  recording (below) for the same reasons.
- Drawing the outline inside the app page: the app's own styles could hide or move it, and the script would change
  what the app shows.
- A second frame of the app for the small picture: the app would load twice for each press.
- Counting only boxes that have every written word: a box with one word out of date would not be found, which is what
  writing several kinds is for.
- Counting every box any written word finds: a walk that wrote `placeholder` 「메모」 and `testId` 「memo-b」 without
  `nth`, because only that box had both, would point at the first box with the placeholder 「메모」.
- Cutting only the counted box whenever the boxes do not all fit in one cut: the numbers 1, 2, 3 are there to show
  which of the boxes with the same words the line means, so the boxes near it stay in the cut and the note names the
  others.
- Shrinking the cut until every box with the same words fits, as the first version did: boxes 1700 px apart left the
  app at a fifth of its size, with only the numbers to be seen.
- A separate cut for each group of boxes, stacked in the pane: the pane grows with every scattered group, pushing the
  story's own pane further down.

**What several stories need alike is kept once, one file per need in `needs/` inside the story folder, and a
condition picks it by its path under that folder: `{ "use": "member-account.json" }`.**
Driver's decision in #275, built in #282. Stories pick the file, not the need's `name`, so renaming a need breaks
nothing. A need has no parameters: two accounts are two needs, and a story picks the one it starts with. The file name
follows the story ID rule, and `use` is the path as written, with `.json`, as the approved mock-up has it. `needs/` is
left out of the stories the way `candidates/` and `discarded/` are. A condition that picks a file that is not there
leaves the story readable and only that condition is shown as missing, as a broken link is shown rather than refused;
`rebuild` counts such conditions. A pick of a file that exists but could not be read is shown as 「읽지 못함」 rather
than 「없음」, because the file is there and the reason is listed with the need files that could not be read, so the
two counts do not overlap. A condition on the link into a step picks a need file the same way, as it is a condition
too. In this first part the page only shows a need; writing one comes later on the same shape.
This follows three tools read on 2026-10-15. Xray keeps a precondition as an item of its own that many tests link to
(https://docs.getxray.app/display/XRAYCLOUD/Precondition). Playwright's setup project saves a signed-in state per role
as a storageState file that each test picks (https://playwright.dev/docs/auth). Cypress keeps shared data as JSON
files in its fixtures folder, loaded by their path (https://docs.cypress.io/api/commands/fixture).
Alternatives compared:
- Picking a need by its name: shorter to write, but renaming the need would break every story that picks it.
- A need with parameters, such as one account need taking a role: one file fewer per account, but a story would no
  longer say in one word what it starts with, and the task list would have to fill the text in.
- Refusing a story whose need file is missing: the file would be found sooner, but a story would vanish from the list
  over one line, and a need file renamed by hand would hide every story that picks it.

**The review page is kept as several files in `src/review-page/`, and the review server joins them, in the order
listed once in `src/review.ts`, into the one page it sends for `GET /`.**
One file of more than 5,000 lines meant that two changes to the page, made at the same time, touched the same file.
The first split only moves text: the HTML around the style and the script, the style, and the script, which is still
one file. The joined page is the old file byte for byte, which is how the split is checked, and nothing in the
browser changes: the script still runs as one classic script, so its top-level names still reach each other. A later
file is one more line in the list. The script is then cut the same way, in its own order, at the boundaries between
areas of the page, into files named for their area, so that changes to different areas touch different files. The
files are read again on every request, as the one file was, so an edit shows on the next load. No build step and no
dependency is added.
Alternatives compared:
- The browser loading each file itself, as modules: every file would have to import and export the names it shares,
  so hundreds of top-level functions and constants would be edited, and the split would no longer be a move only.
- A bundling step, as Playwright builds its HTML report: the page script could then be type-checked, but duru would
  no longer run straight from its source without a build.
- Gathering the helpers several areas share into the common file before cutting the script: each file would then hold
  only its own area, but lines would change order, so the joined page could no longer be checked against the old file
  byte for byte. Cut in place, a few shared helpers stay in the file of the area they stood in, such as the test status
  words and the story path state in the first flow file.

**The review page script stays JavaScript and is type-checked from type comments, against the type of what the server
sends for `/api/data`; `test/review-page-types.test.ts` checks each file, and the files joined in the order they are
sent.** The server's data is `PageData` in `src/review.ts`, and the page's `state.data` is declared with it, so a page
that reads a field the server does not send fails the check. The map in it is `ScreenMap` with no field made optional
for older maps: a map built by the duru of 2026-10-05, the first whose maps the server accepts, has every field the
type requires on both example apps, and an older map has no route file on its screens and is refused before it is
read. `tsconfig.review-page.json` turns strict checking off, since with it on the page has 1,620 errors, most of them
parameters with no type; the server files the page's types come from would read differently with it off, so the test
counts only errors in the page files, and `tsc` keeps checking the server files strictly. Checked one by one, the
files cannot show a constant used at the top level of a file before a later file defines it, which stops the page as
it loads; the joined check reports it at the file and line of the use.
Alternatives compared:
- Writing the page in TypeScript and turning it into JavaScript when the server sends it: it catches the same faults,
  adds a transform to every request and a rewrite of every file, and the page sent is no longer the source. That
  agents write TypeScript more easily than type comments was not measured; if agents writing the story tab keep
  casting wrongly or leave types empty to pass the check, the page moves to it, keeping this configuration, the
  server's types and the joined check.
- A UI library and a build step: not needed for type checking, and weighed again with the shared-server mode of #42.

**The review page has three tabs at the top, 목록, 흐름 and 스토리, and a story is read only in the story tab: its steps on
one line kept at the top and its cards below.** Before, one story was split over two places: picked in the flow, it
was drawn as a line of steps with nothing below it, while its cards and its conversation were in the list's story
pane, so a story comment pressed in the flow moved to the list. The line shows only the step number, the screen, its
test status and where a link is missing, since the cards right below say the rest; the counts of written lines and the
link conditions it showed before repeated them. The flow tab keeps everything about screens; a new story is made in
the story tab. The step marked on the line is the
one pressed, and the cards scroll only when its card is out of view. The pressed step is kept in the address, so that
the same address always marks the same step, after a reload or a fresh visit too: kept only in the open page, it
stayed after a tab change or going back but was lost on a reload. It is dropped when another story, a candidate or a
need file is shown, and when the story file changes so that the step is gone or holds another screen. This follows
Playwright's trace viewer, a strip of actions over the details of the one chosen
(https://playwright.dev/docs/trace-viewer), and the step bar of a form in several steps, which shows only where each
step is and how it stands. Addresses saved before, `#stories?story=<ID>` and `#flow?story=<ID>`, open the story in the
story tab, so that links kept from earlier reviews still reach it.
Alternatives compared:
- Cards under the line in the flow tab: the flow tab would switch between two layouts, and the story list would sit
  beside a drawing replaced by the line.
- The flow cut down to the story's screens and the screens above them, as the flow drew a picked story before, or a
  button putting the whole flow with the story laid over it in place of the cards: a story laid over the flow drew
  screens that are not steps and lost the line between two entry screens, which is why the line of steps replaced it;
  the whole flow is drawn under a story only while a new one is written, where the next step is picked from it.
- Marking the first step card in view as the cards scroll: the last cards cannot scroll up to the line, so a blank
  had to follow the cards, which made a short story scroll; a smooth scroll to a far step marked each step it passed;
  and keeping a pressed step marked meant telling a scroll the reviewer made from one the page made, where every rule
  tried had cases that marked the wrong step.


**A new story is made in the story tab only, on a screen with the screen list on the left and the whole flow under the
steps in the middle; the flow tab keeps only a button that goes there.** A new story could be begun in two places that
shared one draft: the flow tab, where a pane opened beside the drawing and a box pressed became a step, and the story
tab, where the left column became a screen list. The two held the same steps in different layouts, so a reviewer
switching tabs met the same draft in a form they had not left it in, and every change to the draft had two layouts to
keep right. Now the story tab is the only place. Its left column and right column are those of the tab already; the
middle holds the steps in the same cards as a saved story, with 「이전 단계 추가」, 「다음 단계 추가」 and 「제외」, and
the flow drawing under them, so a box pressed in the drawing adds a step as the list does. The code that lays a story
over the whole flow stays for this drawing, as the entry above says; only the place it is drawn in changed, from the
flow tab to the middle of the story tab. The old addresses `#flow?new=1`, `#story?new=1` and `#stories?new=1` open
this screen, so links kept from earlier reviews still reach it.
Alternatives compared:
- Keeping both entries: nothing to build, but two layouts of one draft, and the flow tab bar and the story list each
  had to offer to start, and to hide the offer once the draft was open.
- Making it only in the flow tab, with the list of screens in the pane: the story tab would lose its way to begin, and
  the cards of a saved story and of a new one would be drawn in two places.
- Only the list and no drawing in the story tab: a reviewer who thinks in the map loses the way to pick the next
  step from where the screens lie.
Known limit: the search box and the status filters of the flow tab bar are not on this screen; the list has its own
search by name.

**A route variable whose pattern duru could not read (`/:team({?})/drafts`) takes what a variable written without a
pattern takes, both when a link address is matched to a route and when a browser test
address is matched to a screen.** Before, the `{?}` went into the regular expression as the pattern, so the variable
took only `}` or `{}`, and an address finding its screen skipped every route with `{?}` anywhere in it. A route with
`{?}` in its fixed text (`/{?}/settings`) still takes no address, and one with `{?}` in a group without a name
(`/lab({?})`) still takes no browser test address. A browser test address goes to the first route in the map's
screen list that fits the whole address. That list joins the route files in order, and a React Router v5 `<Switch>`
renders a route without `exact` when only the start of the address fits, so the screen can differ from the one the
app renders. The stand-in is not the real pattern either, so such a route can take an address the app sends to
another route, or miss one the app renders on it.
Alternatives compared:
- Leaving such routes unmatched: no link address and no browser test address ever reaches the screen.
- Guessing from the other routes, as a tail that fits no route falls back to what the route constant alone reaches:
  the link went to the list screen (`/lab`) where the app goes to the detail screen.
- Trying such a route only after every other route, or only when the other route that fits is `*`: each order kept
  some addresses on the screen they reached before and moved others, and which route is narrower cannot be told
  from the path text alone, so every rule had cases where it picked a screen the app would not render.

**A write of a story's conditions, inputs or expected results carries the SHA-256 of the story file the page read, and
the server writes only while the file still has it; otherwise it answers 409 and leaves the file as it is.** The hash
is sent with each story in `/api/data` as `contentHash`, taken from the same bytes the story was read from, so a page
drawn from one content cannot pass with the hash of another. The write itself is checked by the rules a story file is
read by, so a field the page could save is a field the next read accepts. On a refusal the page keeps what was typed,
reads the stories again and offers 「새로 읽기」, which fills the table from the changed file, and 「덮어쓰기」, which writes what
was typed over the change with the new hash. The names say which happens, where pressing 「저장」 a second time to
overwrite looked the same as the save that was refused.
Alternatives compared:
- The file's modification time: cheaper to read, but a file written again with the same text would refuse a save for
  nothing, and two writes within the time resolution of the file system could share one time and let a change pass.
- No guard, the last write winning: a change made in an editor or pulled with git while the table was open would be
  lost without a word, which #275 asks to prevent.

**A saved story's steps are changed only by putting a step in before another or at the end and by taking one out;
a step is never moved, and the steps kept stay in the order the file had them.**
Driver's decision in #283 (2026-10-16). Moving one step changes the links on both sides of it, which usually breaks
them, and an order that is really wrong is fixed by taking the step out and putting it in again at the right place. A
screen the app added in between, or a screen of a detour mixed into a record, is fixed the same way. The Chrome DevTools
Recorder offers the same two, 「Add step before」 and 「Remove step」, and no move
(https://developer.chrome.com/docs/devtools/recorder/reference, read on 2026-10-15). 「새 스토리」 keeps 「위로」,
「아래로」 and dragging, since a story being put together has nothing written on its steps yet and loses nothing by a
move. The page sends the new order as the kept steps by their number and screen, `{ "step", "screen" }`, and the new
ones by their screen alone, `{ "screen" }`, with the `contentHash` of the file it read, as a write of the fields does.
The server takes each kept step from the file, so its `needs`, `inputs` and `expects` go with it and a new step has
none; it refuses a kept step whose number now holds another screen, one named twice, or one out of the file's order. A
kept step's `linkNeeds` stay only while the step before it is the step it had: the conditions were written on the link
from that step, and after another step comes in front, or the step before is taken out, that link is gone. The page
says so on the link row before the order is saved. A comment on a step or a link follows the rule it already has: one
whose number no longer holds its screen goes under 「떨어져 나감」.
Alternatives compared:
- 「위로」 · 「아래로」 and dragging, as BrowserStack and Testiny give each test step: each move would break the links on
  both sides, and two ways to reach the same order would be one more thing to keep in step with the fields.
- Sending the whole new `screens` with every step object: a page holding fields read before a change made elsewhere
  would write them back over that change when the reviewer chose to overwrite only the order.
- Keeping `linkNeeds` on a step whose step before changed: they would describe a link the story no longer takes.

**A step shows 「이전 단계 추가」, 「다음 단계 추가」 and 「제외」 only once it is pressed, the first two as dashed lines above
and below it; 「새 스토리」 drops 「위로」, 「아래로」 and dragging, so both editors move a step the same way.**
User's decision on 2026-10-18. Pressing a step, or Enter on it, shows the two lines and 「제외」; a line marks where the
next screen picked goes, as the buttons did. In 「새 스토리」 a step is now moved as in 「순서 고치기」, by taking it out
and adding it again, which replaces the part of the entry above that kept 「위로」, 「아래로」 and dragging there: two ways
to move a step in two editors that otherwise look alike were one more thing to learn.
Alternatives compared:
- The three buttons on every step, as before: each step carried a row of buttons, and in the column beside the flow
  drawing they wrapped into a second row under the screen name.
- The three buttons only on the step pressed: tidier, but still three buttons in a row on one step, and 「이전 단계 추가」
  sitting below the step it adds before.

**An address duru could not work out carries why, as `reason` inside its `unresolved` server match: `not-written`,
`imported-piece`, `unknown-piece`, `other-host` or `no-path`.**
Asked for in #327 (2026-10-18); the codes come from the places in the source where duru gives up on an address. The
reason sits beside the status, so everything that reads a server match — a screen's calls, an API function's endpoints,
`unreadRequests`, the row of the review page and the lines of the summary — gets it with no list of its own to keep in
step. The codes are kept to what tells the user a different thing to do: look at the caller or name a request
function, follow an import, give a base address, give `app.server`, or nothing. An address on another host and one
with `app.server` not given share `other-host`, since either is answered by giving `app.server` when that host is the
app's server. The relative address of a form that posts is `unknown-piece`: it hangs on the current page, a value duru
does not know. The summary prints a line for each place a screen calls an API function with such an address, as it
does for requests, but the map adds no list for them: the screens' calls already hold them.
Alternatives compared:
- A separate top-level list of the addresses not read, with their reasons: a second place for the same fact, which the
  page and an agent would have to join to the screens' calls by file and line.
- Free text in English: readable in the summary, but the page and an agent could tell the cases apart only by parsing
  the sentence, and the page would show English or keep a translation keyed by it.

**A name that a route path, a redirect, a request address or a role condition imports from another file is read
from the source of the file that declares it, with no config key for it.**
Driver's decision in #306 (2026-10-18). Until then a route path was read only from constants written in its own
file and from the object `routeConstant` names, run through `constants`, so an app that writes `path={BASE_URL}`
with `BASE_URL` imported had `{?}` paths: all 34 screens of appsmith, and 8 screens of mattermost and 9 of outline
whose paths join imported constants. duru now finds where the
name is declared with the import resolution it already has, tsconfig aliases included, and through `export *`,
`export { … } from`, `export { X as Y }` and an import exported again, then reads the value there as it reads a
constant written beside the route: literals, templates and joins of constants of that file, objects, enum members,
`as const`, `satisfies` and a default export. The 26 constants behind those paths on the three apps were all
literals or templates of constants of their own file. A name two `export *` give from different declarations is
not exported, as in ES modules, and a name whose value leads back to itself is not read. What an imported function
returns (`draftsPath()`, `settingsPath("groups", ":id")`) is not read; each route path left with `{?}` gets a
`route path not read` line in the summary that names where duru stopped. The same reading serves route paths,
redirects, the request addresses in screen sources and API modules, and role conditions, so a request address with an
imported constant in it is read too, and `imported-piece` is left to a function's result or a name whose declaration
duru could not read. The defaults given to calls of `settingsFunctions` are read from files parsed apart from these
and still do not follow imports.
Alternatives compared:
- Running the declaring module, as `constants` does: it would read values that functions build, but every such
  module would have to be listed, with stand-ins for what it imports, and the files these apps declare paths in
  import far more than the paths need. Reading the source needs nothing in the config and gave every constant
  measured.
- A config key listing the files that hold path constants: one more key to keep in step with the code, while the
  import already says where each name is declared.

**The pattern a path variable carries is left out of the screen ID; the screen's path keeps it.**
Driver's decision in #306 (2026-10-18). `/:team([a-z0-9\-_]+)/drafts` gives the ID `/:team/drafts#Drafts`. The
ID names the screen for test tags and stories, while the pattern only says which addresses open it, and the
characters a tag cannot hold turned a pattern into a run of underscores (`/:team_[a-z0-9\-_]+_/drafts`). Matching an
address to a screen still uses the pattern. IDs of routes that carry a pattern change once, which the driver
accepted; two routes that differ only by their patterns and show the same component now share an ID and are
reported as a duplicate ID.
Alternative compared: keeping the pattern in the ID, which keeps such routes apart but gives IDs nobody can type as
a tag.

**A candidate from a trace carries the values its `fill` actions put into boxes found by label, placeholder or test ID,
taken from the first trace read for that screen order.**
Asked for in #277 (2026-10-18), on the input box of #275. The trace's `before` line for a `fill` holds the locator as
`internal:label="…"i`, `internal:attr=[placeholder="…"i]` or `internal:testid=[data-testid="…"s]` and the text as
`value` (read from a trace recorded with Playwright 1.60.0, format 8), so the three forms map to the story box's `label`,
`placeholder` and `testId`. The trailing `i` or `s` (not exact or exact) is ignored, since the story box has no place
for it. The words of a locator that was not exact may be only part of what the screen shows, or differ in case, while
the code `duru story` writes for an input matches them exactly (the entry on that code below), so that code may find
no box, or with `nth` another box, since the trace counted `nth` among the boxes the inexact locator found; this is a
known limit. `>> nth=N` is carried as `nth` N + 1, since the trace counts from 0 and the story
from 1; a locator with anything else chained (`nth=-1`, a filter, a parent) is not a box the story can name. A fill found
by CSS or role, a fill with a blank value (a story value must have text), a fill whose box words are blank, and a locator
of another shape are counted as skipped, and the candidate page shows the count. A role locator is skipped because it
could be turned into a box only by guessing which words the screen shows. The other actions that write a value (`type`,
`selectOption`, `check`, `uncheck`, `setInputFiles`; `setChecked` is recorded as `check`) are counted as skipped too: the
input box cannot hold them, and the count tells the reviewer that the test did more than the candidate shows. A key
press has no place in the input box and changes no value a story would write, so presses are ignored without being
counted. When traces share a screen order the candidate keeps the inputs and count of the first trace
read; merging them would invent a story no single run walked. Inputs sit in `stepFields` of the candidate, the shape a
story has, so the page draws them with the code that draws a story's steps, and a stored candidate keeps them.
Alternatives compared:
- Counting a press as skipped: it would raise the count on nearly every login-like test with nothing a reviewer could
  add by hand.
- One candidate per distinct set of inputs: the same path would be offered again and again, against the rule that a
  screen order is offered once.
- Reading CSS or role locators by guessing the visible words: wrong guesses would write a box the page cannot find.

**A kind of case can list values, each counted as a case of its own and named with `@case:<kind>=<value>`; a tag
without a value on such a kind fills no value.**
Asked for in #311 (2026-10-19), the first part of #310. Some kinds are covered only once each of a few values has a
test: an ended document is cancelled, rejected, completed or expired, and a test on a cancelled one says nothing of a
rejected one, yet one test was enough to fill the kind. So a kind in `caseKinds` may be `{ "text", "values" }`, and
wherever a reviewer picks it, each value is a case with its own tests by depth and status, as each value of an
on/off option and each side of a setting condition already is; the tag follows theirs. The kind is still what a
reviewer picks per screen or call, a picked kind still puts nothing on the task list by itself (until #314, below), and on a listed screen
or call each value with no tests gets its own empty test. A tag without a value on a kind with values, a value the
kind does not list, and a value on a kind without values are reported with the tags that point at nothing, so a typo
in a value shows. A value follows the rule of a kind's name, so `=` cannot appear in either. The description-only form
stays; the loaded config and the review page data carry every kind as `{ text, values }`, with no values for a kind
written as text. Counting each value on its own comes from Xray's parameterized tests and Gherkin's Examples tables,
where each row of values is a run of its own, and naming each value without tests from NIST's combinatorial coverage
measurement, which lists what is missing by name.
Alternatives compared:
- A kind per value (`ended-cancelled`, `ended-rejected`): as many buttons as values, the description written again in
  each, and nothing on the page or in the task list shows they belong together.
- A tag without a value counting for every value: one test would fill every value, which is what the values are there
  to stop.
Measured on main bddb370 against the branch with both example clients, with no `caseKinds` and with description-only
kinds (on the first client with four picks, two `@case:` tests and one tag of an unknown kind): `map.json`, `tests.json`,
what `rebuild` prints and the task list are identical apart from the time they were written.

**A kind of case can carry rules that pick its screens or calls by screen path, request method and request path;
a rule's pick is taken out only by a `not-needed` mark that names the rule and gives a reason.**
Asked for in #312 (2026-10-19), the second part of #310. The entry above has a reviewer pick each kind per screen or
call, but some kinds belong to every member of a group a rule defines: 「when a document ends while the signing
screen is open, every write request that screen sends must be refused」. Picked one by one, members of such a group
are missed, and a miss shows nowhere. The into-sign 1.5.0 check did exactly that: of the nine write requests of the
participant signing screens only submitting and issuing a new token were tested on a cancelled document, and one of
the others later had a defect of its own. The earlier comparison put a list per kind beside picking by hand and never
compared rules. So a kind written as an object may carry `picks`, a list of rules with the keys `screen`, `methods`
and `api` (the config's word for a request path in `app.pathValues`); a rule picks what every key it writes matches,
a rule with `screen` alone picks screens and one with `methods` or `api` picks the calls the matching screens send,
or any call without `screen`. In a pattern `*` is one whole path part and `**` any number of parts, none included, so
`/document/**` also picks `/document`; a `*` inside a part is refused, so a pattern means one thing. A kind without
`picks` works as before, and the loaded config carries every kind with `picks: []`.
One module (`case-targets.ts`) takes the map, the kinds and the attached marks and gives, for each kind and each
candidate, one state: picked by a rule, picked (`needed`) by a person or agent, `not-needed`, or undecided, with the
rules and the mark behind it. The review data and the task list, which is made from that data, read it; the review
server's check of a `not-needed` mark and `rebuild` call the same rule matcher (`rulePicks`) without the marks, so
none of them can pick differently. A candidate is every screen and call for a kind without rules, and otherwise the side its rules
name; a mark on the other side still counts, so picking by hand outside the rules works as before.
A `not-needed` mark on a target a rule picks needs a note, and the server writes `rule`, `{ index, pick }`, into it:
the rule's place in `picks`, from 0, and the rule as it was written. Only such a mark takes a target out of a rule;
the newest mark wins as before, so a later `needed` puts it back in the name of whoever pressed it. A `not-needed`
mark without `rule`, such as a kind pressed off before the rule was written, leaves the rule's pick in place, and the
page shows 「규칙」. When no rule picks the target any more, also when the kind has lost every rule, a mark with
`rule` is listed as no longer used and the target counts as undecided; a plain `not-needed` on a target no rule picks
keeps meaning what it meant (since #314 only when it has a note; without one the target is undecided). The index and the rule are both kept because either alone can mislead after the config
changes: the index after a rule is added in front, the rule after it is edited. Old mark files are read unchanged.
On the page the row of a kind says who picked it, 「규칙」 with the rule on hover or the author with the date on hover,
on every kind whether it has rules or not, and a kind taken out of a rule shows as 「불필요 · <author>」 with the reason
under it. 「이 요청은 규칙에서 빼기…」 on the row of a kind a rule picks, while it is picked by anyone, and the pressed kind
button both open the reason dialog the discard flows use, which saves nothing without a reason; a kind button that
is off picks the kind back with no reason.
`rebuild` prints, for each kind with rules, how many screens and calls they pick, each rule that picks nothing with
its place and text, and with `baselineMap` how many of the picks the same rules did not make on the baseline map.
Reference cases: GitHub CODEOWNERS shows on hover which line of the file made someone an owner, which is where the
rule on hover comes from; RESTler's `UseAfterFreeChecker` and Schemathesis's `use_after_free` apply a check wherever
its condition holds instead of to requests a person lists; SonarQube's analysis scope picks files by path patterns.
Alternatives compared (from #310):
- Picking by hand only, as before: members of a group are missed and the misses show nowhere.
- A list of screens and calls per kind in the config: has to be edited whenever a screen is added or renamed; a rule
  picks by shape and does not.
- Suggesting a request from the tests of the other requests of the same screen: nothing is suggested when none of
  them has a test.
- A kind per value: see the entry on values above.
- Expressions or regular expressions in a rule: out of scope; matching by shape only.
- Telling a taken-out mark apart without a new field, by calling every `not-needed` on a target no rule picks no
  longer used: a reviewer's `not-needed` on a candidate outside the rules would be shown as unused too.
- Any `not-needed` mark beating a rule: every kind pressed off before the rule was added would take a target out of
  it without a reason.
Measured on main 6920481 against the branch with both example clients, with no `caseKinds` and with kinds without
`picks` (with four picks of kinds and two open marks): `map.json`, `tests.json`, what `rebuild` prints and the task
list are identical apart from the time they were written.

**A reviewer records the screens they move through in the app pane: the app host puts a script into every app page
that reports each new address to the review page, and 「기록 끝」 saves the addresses as a visit record.**
Driver's decision in #261. The app pane loads the app from another origin than the review page, so the page cannot
read the pane's address itself. With `app` set duru already serves the app's pages and puts a script after `<head>`
to store the login token; a few more lines there wrap `history.pushState` and `history.replaceState`, listen for
`popstate` and `hashchange`, and post the address to the parent window on load and on each change. The app is not
changed, the reviewer stays on the review page, and no dependency is added. The script posts only to the review
page's own origins, so another site that frames the app cannot read its addresses, and the page takes a message only
from the frame it shows and only from the origin of the app address it opened.
The record holds the path, the query and what follows `#`, without host and port: every pane has a port of its own,
and candidates are matched by path anyway. Every change of address is a step, also one of the query or after `#`
alone, and steps on the same screen are merged into one as for any record. The signed-out pane and each role's pane
are separate records, since each is another account: choosing another pane saves the record so far and begins a new
one, while the story being written keeps all its steps. Recording needs `app`; with only `appUrl` duru does not serve
the app and the page says so. An app whose security policy blocks inline scripts sends no address, and the page says
it got none. A window the app opens with `window.open` is outside the pane and is not recorded; in into-sign that is
only the password reset page.
Tools that record a person's moves were checked on 2026-10-15. Playwright codegen opens a browser of its own: "When
running the `codegen` command two windows will be opened." (https://playwright.dev/docs/codegen). QA Wolf's recorder
did the same in its public repository: `npx qawolf record <url>` opens a browser and "Your browser actions are
converted to Playwright and Jest code" (https://github.com/tchigher/qawolf). Cypress Studio records inside the
browser that runs the tests: "Studio translates each action into a Cypress command in real time and adds it to your
spec file." (https://docs.cypress.io/app/guides/cypress-studio), "Cypress tests run inside of the browser!"
(https://docs.cypress.io/app/references/trade-offs); that it sends the app through a proxy to share the origin was
not found in its documents and is a guess. The into-sign client was read but not run: it moves between screens with
`history.push` and `replace` of react-router 5, keeps its token in localStorage and no cookie, writes no absolute
app address, and has no web socket, service worker or framing rule in its own code, and it is already reviewed with
`app`.
Alternatives compared:
- The review server passes the app through itself so the origins match: a reverse proxy with cookies, absolute
  addresses, web sockets and headers to handle, and into-sign mounts its routes at `/`, so it could not share a path
  prefix and would need a port of its own anyway (a guess). Close to Cypress, as far as could be found.
- duru opens a browser with Playwright and reads its address: catches new windows and full reloads too, but the
  reviewer moves around in a window apart from the review page, `playwright-core` becomes a dependency of the
  package with a browser to download, and WSL needs a display for the window (a guess). The way of Playwright codegen
  and QA Wolf.
- A short script in the app's development build: almost nothing in duru, but the app's `index.html` has to change and
  recording works only on a branch that has the change. No tool found does this.

**A recorded visit is written once into `records/` in `storiesDir` and read with the records in `visitRecords`.**
Driver's decision in #261. It works with no `visitRecords` in the config, which into-sign's has none of, and the
records a person made do not mix with the ones a test run writes and may clear. Like `candidates/` and `discarded/`,
a file is named by the date and eight letters of a random ID and never changed or deleted, so records made on two
computers merge in git without a conflict, and the folder is not read as stories. A recorded visit becomes a
candidate the way any record does, named by its file, with its path from the config folder as its source, so a walk
whose story was never saved is still offered.

**Recording is started from 「새 스토리」 and fills the story being written, and a typed value is kept as an input of
its step when the box has a placeholder, a label or a test ID.**
Driver's decision in #261. The reviewer walks the app to write a story, so the steps go straight into the draft,
after the steps already chosen, and the record file is the copy kept in case the story is not saved. While recording
the app takes the whole middle column and the steps stack where the screen list was, because the flow drawing is not
used then. After 「기록 끝」 the path is drawn on one line as a saved story is, since the whole flow hides a walk of a
few screens among many; 「전체 그림에서 보기」 brings the whole flow back for adding steps by pressing boxes. A value is
read from the `change` event of a text-like `input` or a `textarea`, found by the words a story box finds it by, in
the order placeholder, label, test ID, with `nth` when the same words name more than one element; since #348 the words
are read and `nth` is counted as Playwright's locators do (the entry on the code `duru story` writes), so that code
finds the box the walk recorded. A password is never
read, and a select, a checkbox or a box with none of those words cannot be named by a story box, so each is only
counted as `skipped`, as for a trace. A later value in the same box takes the place of the earlier one, the last value
being what the screen was left with. Emptying a box whose value was recorded takes the value off the step and off each
record entry of that screen back to where the step began, since the candidate joins a screen's inputs and would bring
it back; emptying a box never recorded writes nothing. A box without those words is counted once for each address it
is changed at, not once for each change, since a checkbox ticked on and off is still one input left out; the script
in the app does not know which addresses the page joins into one screen step, so the address is as far as it can
tell. When the story tab is left during a recording and opened again, the app opens at the last address received in
that pane, straight and not through the sign-out address even in the signed-out pane, so the reviewer goes on where
they were, still logged in if they logged in there, and that address adds no step. If no address has arrived yet, it
opens where the recording started, through the sign-out address in the signed-out pane, as at the start. A recorded
address no screen matches becomes a step marked 「맵에 없는 화면」, and the story is saved with it, so `/api/stories/check`
and `/api/stories/add` take such steps, as a story file written by hand may hold them. A visit record step may now
carry `inputs` and `skipped`; a record with a value of the wrong shape there is noted as unreadable rather than read
without it, so a broken value is seen.
Alternatives compared:
- A button above the app pane of the list view that only saves a record, as first built in #287: the reviewer then accepts the
  candidate and writes the conditions in a second place.
- Reading every keystroke: each letter would be a value, and the box's last value is what the story needs.
- Keeping the select and checkbox values with a guessed box: the story box has no field for an option, and a guess
  would write a box the page cannot find.
- Keeping an emptied box as an input with an empty value: a story value must have text, so the record would be
  refused.
- Counting a box without words once per screen step: the script in the app would need the map's screens.
- Keeping the app frame while another tab is shown: the middle column is drawn anew for each view, so the frame would
  need a place of its own outside it.
- Opening the signed-out pane through the sign-out address again when the story tab comes back: a login made during
  the recording would be lost, and the app would send the reviewer to the sign-in screen, a step never walked.

**A route whose `render=` function returns one element, or whose screen is its child element, is read as
`element=` is read; every other route that draws a screen duru cannot read prints `route not read`.**
Driver's decision in #339 (2026-10-19). Routes written `render={() => <X />}`, `render={(props) => (<X {...props} />)}`,
`render={() => { return <X />; }}`, `render={() => wrap(<X />)}` or `<Route path=…><X /></Route>` used to leave the
map with nothing said, 12 of the 69 single screen routes of mattermost among them. The returned element, or the
children, go through the same reading as `element=`, and the screen read there, also one found inside wrappers,
counts only when it resolves to a component file in the app or is a component declared in the routes file itself;
then the map is the one `component={X}` gives. When a child anywhere among the elements drawn there is a value in
braces and not an element, such as `{adminRoutes}`, `{renderRoutes(x)}` or `{children}`, duru does not know what is
drawn there, so the route gives no screen and no line, as on main, also when an app component such as `<Layout>`
holds that value. A render
function or children that hold route elements anywhere, on either side of a branch too, only wrap those routes and say
nothing, as the pathless `<Route>` around the layout of `test/fixtures/app` does. The rest gets a line with the
route file, the line and the reason, and the key `unreadRoutes` in `map.json`: a route with no path that draws a
screen (a catch-all `<Route component={NotFound} />`, an index route), a route whose path or screen may be in a
spread (`{...route}`, as appsmith's `MainPane.tsx` passes its route table), a render function that branches,
returns something other than one element or is not written in the route, and child elements none of which is a
component. Any other screen, such as a package element (`<Switch>{adminRoutes}</Switch>`, `<Suspense>`,
`<ErrorBoundary>`, a page imported from a package), gives no screen and no line, like children that are a bare value
such as `<Route>{routes}</Route>`, as on main, which reads neither `render=` nor children. Known limits, each giving
no screen and no line, as on main: a package component bound with `require`, an import duru cannot resolve, and a
screen whose element has value children such as `<About>{label}</About>`. A
`render=` or child-element route built in a loop over a list whose path is not read, such as mattermost's admin
console route per settings page (`path={`${props.match.url}/${item.url}`}`), is a line and not a `{?}` screen:
every item would share one ID, as in #304, and that ID would change once reading tables is settled in #305, so
the review marks put on it would come loose. For routes, this ends the silence that the entry "Route files are
listed in the config" names for code that spreads lists of routes. Inside a component whose name is in
`routeElements`, such as the react-router 5 `PrivateRoute` that passes `{...rest}` on to `<Route>`, a route that
draws its screen with `render=` or a child element gives no screen and no line, as on main, since each place
that component is used is already read as a route, so a line would report a screen missing that is on the map, and a
screen would add one `{?}` screen that stands for all of those uses. A `component=` or `element=` route there gives
what it gave on main.
Measured: the maps of `test/fixtures/app`, `test/fixtures/ts-app`, into-sign 2.0.0 (`config-role.json`, 44 screens)
and into-sign 1.5.0 (45 screens) are the same on main and on this change apart from `generatedAt`, and none of them
prints a `route not read` line.
Alternatives compared:
- Only reporting render routes: rejected by the driver, since 12 mattermost screens would stay missing.
- Reading a branching render function as `element={cond ? <A /> : <B />}` is read: the driver chose to report it.
  So the common react-router 5 guard `render={(props) => ok ? <X {...props} /> : <Redirect … />}` stays off the map
  with a line, while the same branch written in `element=` gives a screen.
- Taking only the tag of the returned element as `component=` does: the same on every shape measured, and it would
  not read `wrap(<X />)` or a component passed to a wrapper as `element=` does.
- Reading every element as `element=` does and setting aside only the ones that hold a value: a page imported from a
  package would still be a screen. Reading only app files and components declared in the routes file without that
  check: `<Layout><Switch>{adminRoutes}</Switch></Layout>` would be a `Layout` screen main never had. Both are kept,
  so where either one cannot tell, the route is "unknown". The cost is that `<Route path=…><ExtPage /></Route>` with
  `ExtPage` from a package gives no screen, where `component={ExtPage}` gives one.
- Putting list-built render routes on the map with `{?}` in the path, as `component=` routes built in a loop still
  are: not chosen for the reason above. `component=` and `element=` routes keep their screens, since taking them off
  would move IDs on maps already reviewed.

**A reviewer's status is 「테스트 필요」 or 「충분」; a mark an older duru saved as `missing` reads as 「테스트 필요」.**
Driver's decision in #343. 「없음」 and 「더 필요」 both meant that tests have to be written, and the only difference, whether
any test exists, is what duru already counts and shows on the same row as 「테스트 없음」 or 「테스트 N」, so a row read
「없음 | 테스트 없음」, saying it twice, or 「없음 | 테스트 3」, saying two things that disagree. The reviewer now gives a
verdict and duru gives the count beside it. A new 「테스트 필요」 is saved under the name it had, `needs-more`, so an older
duru reads the new files as open marks and going back is a plain revert. Old `missing` files are read as `needs-more`
where the review page's data and the task list read the marks, not in the page, so the page, its filters and the
task list know one status, and the task list prints `needs-more` for both. The server still accepts `missing` in a
posted mark, since refusing it would only break a caller nothing in duru is; the page never sends it. 「충분」 can
still be put on a screen or call with no tests: that is how a reviewer says it needs none.
Reference cases: Jira Xray computes a requirement's coverage status, UNCOVERED and NOTRUN among them, from the linked
tests and never lets a person pick it; TestRail and Zephyr compute coverage from links and let a person set only the
scope and each test's own status; GitHub reviews and Gerrit keep a person's verdict (Approve or Request changes,
Code-Review) beside the computed result (status checks, Verified) under another name, and no verdict value tells
"none" from "too weak"; SonarQube's statuses that a person sets do not repeat what the tool computed, and keep an
"accept as it is" verdict with its reason.
Alternatives compared:
- Saving the new status under a new name (`needs-tests`): the page looks the same, but code that reads old files as
  the new name stays for good, and an older duru reading a new file drops that item from the task list without a word,
  which makes going back hard.
- Keeping three statuses under new names (「보강 필요 · 새로 필요 · 충분」): the repeated words go, but the reviewer still
  picks between two buttons that mean the same thing, and none of the cases above does this.
- Showing `missing` as 「테스트 필요」 in the page only: the page would compare the picked status with the saved one in
  several places, each needing both names, and the task list would still print two words for one verdict.

**A route file that another screen draws gets that screen's path in front of each route path that starts with the
address the outer route matched; two outer paths that differ in one piece are joined into one path.**
Driver's decision in #304 (2026-10-19). Route files that build their paths from the matched address
(`${props.match.url}/confirm`, `const { path } = useRouteMatch()`) got `{?}` in front, so two different addresses
could share an ID: mattermost's `/:team/integrations/confirm` and `/:team/integrations/commands/confirm` both
became `{?}/confirm#ConfirmIntegration`, and the flow showed one box fewer than its count. The outer screen is found
among the screens duru already collected: those whose source files hold the inner route file, keeping the ones that
do not also hold the route file of another such screen, so the innermost one wins and two levels (team, then
integrations, then slash commands) fill in turn. Only a path whose first piece reads the matched address is filled:
`url` or `path` of `props.match`, `this.props.match`, a `match` taken from props, or `useRouteMatch()`, and a `url`
or `path` taken from one of these. A first piece that is a function's result (`${settingsPath()}/groups`, as outline
writes its routes) stays `{?}` with its `route path not read` line. When the innermost outer screens have two paths
that differ in one plain piece, as mattermost draws its integrations under both `/:team/integrations` and
`/:team/emoji`, the inner screen gets one path with that piece as a variable,
`/:team/:section(integrations|emoji)/bots`, the way mattermost itself writes `/:team/:path(channels|messages)`.
Outer paths that differ in any other way, or are not read in full themselves, leave the inner path `{?}`. This
reverses the rule of the PRDs in #134 and #140 that the path of a parent route is not put in front, and README no
longer states it. An ID that held `{?}` changes once it is filled, as README already says; the into-sign 2.0.0 and
1.5.0 maps have no `{?}` screen, so none of their IDs change.
The flow, the screen list and the task list also count one screen ID once when two routes still give it, keeping the
last of them on the map, as the baseline comparison does, so that comparing with a baseline map built before does
not report a change; before, the flow planted an entry screen listed twice as two roots.
Measured with mattermost 4d94455 (8 route files), appsmith 4f8e991 and outline d460341: `{?}` screens went from 27 to
0, 10 to 0 and 12 to 12 (all function results), with no duplicate ID and the same number of screens (57, 44, 30);
apart from path, ID, access and links, every screen is the same as on main.
Known limits: a screen that imports the inner route file only for a constant counts as an outer screen too, which can
join a wrong path or leave the path unread; react-router 6 child routes written with a relative path are not joined;
the inner screens do not take on the route conditions of the outer screen.
Alternatives compared:
- One screen with two routes, marked 「라우트 2곳」, as first planned for this case: dropped once measuring showed the
  two routes are two addresses duru read wrongly, not one screen.
- A screen for each outer path (two boxes for each integrations screen): the driver chose one box with one joined
  path, so the number of screens does not grow.

**A story whose story tests all pass is 「일부 단계만 통과」 when the traces rebuild already reads show that none
of them went through its screens from end to end.**
Driver's decision in #262 (2026-10-19). into-sign 1.5.0's story 「서명자가 받은 링크로 문서를 열어 서명하고 서명한 문서를
본다」 passes on its `@story` test, but that test checks the signature through the server API and never opens the
signed document's screen; none of the 90 passing runs with a trace goes from the signing screen to it. Such a story
gets its own status, `part-pass` 「일부 단계만 통과」, each link shows how many story tests went across it, in grey
when none did, and a story whose passing story tests include one without a trace, with none of the traced ones
going through, stays 「통과」 with 「단계 확인 못 함」 beside it. A trace that holds no screen on the map counts as no
trace: the map rather than the test may be missing the screen, and an empty trace may be one that could not see where
the test went. A story test that opens no page at all therefore leaves its story 「통과」 with 「단계 확인 못 함」.
Only a run that goes from one screen straight to the next counts for that link, and the whole story counts only when
one run holds every screen one after another.
- A story test and its trace are paired in rebuild, where the test's result line and its trace are read together:
  the story test's entry in `tests.json` carries `screens`, the screens its passing run went through. The issue
  planned to pair them by title, since a trace holds no file and line; the result line has both, so two tests with
  one title stay apart, and a `tests.json` from an older duru, without `screens`, reads as not known.
- An address the map has no screen for is left out before counting, so a run that goes A → an address off the map
  → B crosses from A to B. A story can only name screens on the map. Measured on into-sign 1.5.0: none of the 90
  passing traces holds an address off the map, so the choice changes no story there.
- When the map has no link between two steps but passing runs with a trace went straight across, the link row and
  rebuild say how many and that a move may be missing from `moves`. This counts every passing traced run, not only
  story tests: into-sign 1.5.0's sign-in story has no story test, and 57 of the 90 runs go from sign-in to the
  user home with no link on the map.
Left out: tests that go through a whole story without its tag are not offered as tests to tag (57 runs would be
offered for the sign-in story, and passing on one would need a judgment kind of its own); ranking by how often
people use a path (no data for it yet); calls between steps (a trace order holds no calls).
Alternatives compared:
- 「통과」 kept with 「끝까지 지나간 테스트 없음」 beside it, as the driver first chose in #262: dropped on 2026-10-20 once
  the page showed it, since 「통과」 next to 「테스트 없음」 reads as two answers that contradict each other. Codecov
  marks a line `partial` (yellow, not counted as hit) when only some of its branches ran, Cucumber shows a step that
  did not run as `skipped` and a scenario passes only when every step passes, and Xray gives a requirement its own
  `UNKNOWN`. The status and the grey links follow the first two; 「단계 확인 못 함」 follows the third.
- One chip 「통과 · 일부 단계만」: shorter, but the status filters and rebuild's counts could not pick these stories out.

**`duru story <config> <story ID>` prints a story in the text shape of `duru tasks`, plus the lines duru computes for each step, rather than JSON or a test code draft.**
An agent that writes a test already reads the story part of `duru tasks`, so the same code makes the same lines and
a story that no reviewer marked is read the same way. What duru can compute (the address to open, a `toHaveURL`
line from the route path, the code that fills an input's box from its words) is given as lines; what it cannot
(which element to press) is said to be unknown, and the agent fills it from the source the line names.
Alternatives compared:
- JSON for the agent to read: each field is exact, but it is a second shape to keep beside the task list's text, and
  the text of reasons and verdicts would be written twice.
- A test code draft with the computed lines in place: the agent gets one file, but a draft hides which lines duru is
  sure of and which it guessed, and a step with no readable path or no known link would need comments inside code.

**An agent decides a kind of case for a screen or call with `duru case`, which writes the same mark the page does,
marked as written by the command; `duru undecided` lists what nobody decided and exits with 3 while anything is
left; the task list carries both the undecided candidates and the picked cases with no tests.**
Asked for in #314 (2026-10-19), the third part of #310; the driver chose what goes in the list, the extra field, and
how a reasoned and an unreasoned 「불필요」 outside the rules count. A rule picks what its shape says, so whatever it
misses has to be decided one by one, and on into-sign 1.5.0 one kind with a rule on the participant write requests
left 182 candidates undecided (78 of them write requests), a kind without rules 243. Nobody clicks through that many
on the page, so an agent decides them from the source, and the reviewer checks the reasons afterwards. The names are
`case` and `undecided`, not `judge`, which `src/judgments.ts` already uses for discarding or handing over a test
pair. `case` writes into the marks folder directly, as `reply` does without `--server`, and an open page sees the
mark once reloaded; `--server` (#350, after the entry on `reply --server`) sends it through a running review
instead. The author is `agent` unless `--author` names one, and never the config's `author` or the git name, so an
agent's decision is not signed with the reviewer's name. A mark the command writes carries `"via": "duru case"`, the one field the page
does not write, so the count of rule, person and agent picks and a later hold on agent picks can tell them apart;
the page's own saves drop such a field. The command refuses, with the reason and exit code 1, a kind not in the
config, an ID not on the map, a 「불필요」 without a note whether a rule picks the target or not, a target whose
current mark a person left, and a 「불필요」 off the side the rules pick unless there is a mark there to take
back (so a hand-picked 「필요」 can still be withdrawn). A 「필요」 is written also where a rule already picks the
target, so the pick stays when the rule changes.
A 「불필요」 outside the rules now counts only with a note: a kind pressed on and off again on the page leaves a mark
with no note, and calling that a decision would hide the candidate. Such a candidate stays undecided and is handed to
a person: its mark is a person's, and the agent never changes a person's mark, also where the mark leaves the target
undecided, since the command would otherwise silently reverse what the reviewer pressed. It keeps `undecided` at 3,
and its line says only a person can decide it, so the agent tells the user instead of looping; a place on the page
to add the reason comes with the case kind tab (#313). The buttons work as before, and a rule's pick is still taken
out only with a reason. A reasoned 「불필요」 outside the rules shows in 「경우별 테스트」 as 「불필요 · <author>」 with the
reason, as one taken out of a rule does; one without a reason shows no row, as before.
`undecided` exits with 0 when nothing is left, 3 while something is, 1 when the config, the map or the marks cannot be
read, and 2 when called wrongly, since duru already uses 1 for failure and 2 for misuse, and grep, diff, ESLint and
`terraform plan -detailed-exitcode` also keep "found something" apart from "failed". It needs no `tests.json`. The
undecided candidates come write requests first (a request whose method was not read among them), then the other
calls, then the screens, each by ID; `caseTargets` carries that order in the review data, so the page can use it
without importing a TypeScript module. The task list gets `# Case kinds` before `# Tagging` whenever the config
names kinds: each kind's undecided candidates, and each screen or call the kind is picked for with a case no test
carries, with an empty test tagged `@case:<kind>=<value>`; one already listed under its marks is not repeated, but its
cases still count, so the section and `rebuild` give the same number. This
changes the earlier entries' "a picked kind alone does not put a screen or call on the task list": a rule's pick
whose cases nobody tests would otherwise never reach the agent, and the rule would be there for nothing. When the
section has work the head of the list counts it and 「No open marks.」 says the case kinds still have work, so an agent
does not stop at that line. `rebuild` prints the undecided count and the cases with no tests for each kind.
Reference cases: SonarQube security hotspots start as 「To review」 and are set to 「Safe」 with a comment, and its
quality gate fails until every new hotspot is reviewed, which is where an undecided candidate staying listed until
someone decides it comes from; SARIF 2.1.0 keeps `notApplicable`, `open` and `review` apart, which is why undecided
and 「불필요」 are different states; Semgrep keeps ignored findings with their reason instead of dropping them.
Alternatives compared:
- Listing only the undecided write requests: the kind without rules would never get decided, and the driver chose
  every candidate.
- Telling agent marks apart by the author `agent`: a person can type that name on the page, and `--author` can name
  anything, so the field is the only thing that says how the mark was written.
- Counting a 「불필요」 without a note as decided: the candidates a reviewer only pressed off would never be offered.
- Going through the review server only, as `reply --server` does: needs a running review, while an agent mostly
  decides in bulk between reviews, so the server came later as an option (#350), not as the only way.
- One exit code for both "something is left" and "something failed": an agent could not tell a broken config from
  work to do.
Measured on main 36d357f against the branch with both example clients and into-sign 1.5.0, with no `caseKinds` and
each with two open screen marks, an open call mark and a `needed` and a `not-needed` case mark of a kind not in the
config (into-sign also with the five marks of the case-kind check of 2026-10-11): the task lists and what `rebuild`
prints are identical.

**A route made for each item of a table gives screens for its items when the config names the table in `routeTables`,
and a table file of its own is in no screen's sources.**
Driver's decisions in #305 (2026-10-19 and 2026-10-20). mattermost's admin console makes one route for each item of
`AdminDefinition` (`admin_definition.tsx`, 113 items) with `path={`${props.match.url}/${item.url}`}`. On main that route
was one `route not read` line, `/admin_console#AdminConsole` held the code of every admin page (1658 source files),
and a test opened at `/admin_console/about/license` matched no screen. The config now names only the route file, the
table file and its top-level const, and the keys from that const to the items (`"*.subsections.*"`). duru reads the
rest: the field of the item the route path uses, and every value under a `component` key at any depth of the item,
following consts, imports, lists and spreads. The first component names the screen, and an item that names none
takes the component the route draws (`SchemaAdminSettings`). An item screen holds the code of the route's component
and of every component the item names, and gets the outer screen's path in front as in #304.
- Leaving the table file out of screen sources is a rule of its own, not the `constants` rule: a table file need not
  be listed in `constants`, and the `constants` rule keeps a module that only gives settings defaults. The driver
  chose to leave it out of the outer `/admin_console` screen too: its source files go from 1658 to 1033 and its
  requests from 5 to 2, and the three requests that leave (workspace optimization twice, brand image) show only on
  the admin page screens that send them. Kept, each page's code would show twice, and a reviewer marking
  `/admin_console` 「충분」 would vouch for 112 pages they never opened.
- An item whose components all only redirect gives no screen. duru reads the component's declaration, in another
  file too, and takes it as a redirect when it is a function component whose one returned value is a redirect
  element, as mattermost's `user_attributes_redirect` is.
- An item that has no value for the field the route reads, or whose value could not be read in full, gives no screen
  and a `route not read` line naming the item.
- Two routes made for each item of a list in one route file named in `routeTables` stop the run, with the entry and
  both route lines. No measured app has two, so there is no key yet for choosing one; such a key would be optional, so
  a config written now keeps working.
- The review page shows nothing new for these screens. The map's `tableItem`, the summary lines and the task list
  name the item's place in the table.
Measured on mattermost f38678d: 69 screens become 181 (113 items, less the one that only redirects), with 181
distinct IDs and no `admin_console.tsx:179` line; the other 68 screens are the same as on main. The maps of
`test/fixtures/app`, `test/fixtures/ts-app`, into-sign 2.0.0 (`config-role.json`) and into-sign 1.5.0 are the same on
main and on this change apart from `generatedAt`.
Known limits: the conditions written in an item (`isHidden`, `isDisabled`) are not read, so the item screens open as
`/admin_console` does, which had no condition on main either. The 25 items with no component of their own share one
set of sources and are named `SchemaAdminSettings`, so the review does not tell their settings apart. An item whose
first component only wraps a section (`LicensedSectionContainer`, two items) is named after it, and its ID changes when
the order inside the item changes. Thirteen addresses are shared by two items, the page for a licensed server and its
feature-discovery page, and a test opened at such an address goes to the first matching screen. No link into an item
screen is read, so each is an entry screen. On mattermost the run with the table no longer fits Node's default heap
(2240 MB on the machine measured): main already peaks close to it while TypeScript reads the types, and following the
items' components into about a hundred files keeps some 60 MB more, so `extract` stops with `JavaScript heap out of
memory`; with `NODE_OPTIONS=--max-old-space-size=4096` it ends in 47 s. When the outer address cannot be filled, each item gives its own `route
path not read` line at the same route line. A table written in a route file, or in a screen's own component file, stays
with all it imports in the sources of every screen that holds that file. outline builds its settings table inside a hook from lazy component
constants (`Profile.Component`), with no top-level const, and appsmith passes its route tables by spread
(`{...route}`); neither is read.
Alternatives compared:
- Writing the component fields in the config (`schema.component`, `schema.settings[].component`), as planned on
  2026-10-19: on mattermost it misses seven components of five items without a word (membership and permission
  policies, mobile security, posts, recaps).
- Writing each screen in the config: it goes stale whenever the app changes, and the map's screens are meant to be
  rebuilt by the program.
- duru finding the tables itself: in mattermost, outline and appsmith the list reaches the route through a store
  selector or a hook, and none was found.
- One screen with each page as a sub-address under it: mattermost's and outline's items each have their own
  component, address, sidebar entry and condition, which fits a screen per item; appsmith's editor table picks panes
  inside one screen and would fit sub-addresses, but duru does not read it.

**`duru story` writes under each input a Playwright line that finds the box with every word written for it, each
matched exactly, joined by `.and()` in the order placeholder, label, test ID, with `.nth(N - 1)` for `nth`, and marks
the line as not tried on the screen.**
Driver's decision in #348 (2026-10-20). The line is
`await page.getByPlaceholder("<placeholder>", { exact: true }).and(page.getByLabel("<label>", { exact: true })).and(page.getByTestId("<test ID>")).nth(N - 1).fill("<value>");`
without the words the input does not have. Each kind sits in one table in `src/playwright-trace.ts` with the locator
the code uses and the selector a trace's `fill` records, so reading inputs from a trace and writing code for them
cannot drift apart. The order is fixed, so one box written with its words in any order gives the same code.
Measured with playwright-core 1.60.0 and Chromium on a test page of boxes that share words: one label inside another
(「메모」, 「서명자 메모」), the same label twice, labels that differ in case and spaces, a box with a placeholder before one
without, a `<label>` and an `aria-label` that disagree, `aria-labelledby`, a label around the box, a search box and a
button with the same `aria-label`, a test ID on a wrapper and on its box, three boxes with the placeholder 「메모장」 of
which one also has a test ID, a hidden box, a select with the same label, and two labels on one box. The code reached
each of the 25 boxes recorded by a walk that reads words and counts `nth` as Playwright does, and no other box; with the
walk as it then read words, 7 of the 24 boxes it recorded were reached as another box or not at all. `exact` is needed
because 「메모」 without it also finds 「서명자 메모」. With `exact`, Playwright compares a label after collapsing spaces but
a placeholder and a test ID as written, so the words a trace keeps are not trimmed. The inputs read from
`test/fixtures/app/traces/inputs.zip` fill the boxes the recorded test filled when their code runs on the recorded page,
which a browser test keeps. `.and()` needs Playwright 1.34 or later (from Playwright's documents, not measured).
A walk therefore reads the words the way these locators match them: the label from the elements `aria-labelledby`
names, else `aria-label`, else the box's `<label>`s, taking the first that has text, with spaces made one as Playwright
does; the placeholder and the test ID as written, spaces at the ends included. `nth` counts every element of the page
that has all the words, in document order, as `.nth()` counts what `.and()` finds, so a search button with the same
`aria-label` as its box counts too. Such a button, or a list the app shows while a box is typed in, can come and go
while the box keeps its value, so one box can be sent with a different `nth` from one change to the next; the walk then
also sends the box it last sent for that element, and the review page moves the value and the row recorded under that
box to the new one, or drops both when the box is cleared (measured in Chromium with a search button shown only while
its box has text). The walk does not send that box when another element has sent it since, as when a row of boxes with
the same words is removed or added above and the rows are typed in again: what the page holds under it is then the other
element's value, so the page keeps it, as it did before the walk sent the box last sent. A browser test walks a page of the measured shapes and a few more, placeholders and a test ID
written with extra spaces, two search boxes, a box with `data-qa` and a textarea, 28 boxes in all, and runs the code of
each one it recorded. To count `nth` for a label the walk collects the boxes the matching `<label>`s point at (`control`) once,
rather than reading `labels` of every element: on a page of 35,000 elements reading `labels` made the first typed value
take 1.7 s, and collecting them once takes 22 ms (measured in Chromium). The page saves a word a walk or the story file
gave as it is, and cuts spaces at the ends only from a word typed or changed in the table, so the spaces a walk kept
reach the story file.
duru does not run the code, so the line ends `(duru did not try it on the screen)`, and `duru tasks` gets no such line;
its input lines keep `(not checked against the code)` and now join the words with `and`, as the code needs all of them.
The review page still finds a box by any one word (the entry on pressing an input line), so a box the page points at
may be one the code does not find: the intro and the skill tell the agent to try each word alone when the code finds
no box, and then to tell the user which input it is. Code that holds a backtick is put in a longer code span, so the
line still reads as one span.
Known limits: a project whose Playwright config sets `testIdAttribute` gets `getByTestId` looking at that attribute,
while a walk, the page and a trace read only `data-testid`, so its test ID lines may find no box. No config key was
added for it: none of the projects on hand is known to set it (a guess; into-sign was not measured), and a key can be
added later without changing story files. A `<style>`, `<script>` or `<noscript>` inside a `<label>` or inside an
element `aria-labelledby` names is read by the walk, which takes its `textContent`, but left out by Playwright, so such
a label is written with that text and the code finds no box (measured for `<style>` inside a `<label>`; the rest read
from Playwright's source). The page compares a label word with the first `<label>` of a box only, so a box whose first
`<label>` has no text and a later one has is recorded with the later one's text and not found on the page.
A box inside an open shadow root is found by Playwright, which looks inside it, but not counted by the walk (read from
Playwright's source, not measured). Stories recorded before keep `nth` counted the old way, among the inputs and
textareas with exactly the same words; they are not rewritten, since no story in use is known to have `nth` (a
guess).
Alternatives compared:
- `.or()` between the words: Playwright's strict mode stops the fill as soon as another box shares one word; the three
  「메모장」 boxes were all matched at once.
- The first word alone in the fixed order: the 「메모장」 box with its own test ID would need `nth` to be told from the
  other two, which a walk does not write for it.
- Locators without `exact`: a word that is part of another box's word finds both.
- Keeping `or` on the input line and changing only its explanation: the input line would say `or` above code that needs
  every word.
- A `testIdAttribute` config key read by the walk, the page and the trace reader: those projects would work, but it is
  a setting users write and duru keeps, with no project known to need it.
- Counting `nth` only among inputs and textareas, as before: one box would keep one number, but the code for a search
  box beside a search button with the same `aria-label` would find both.
- Taking a box with `nth` 1 and the same box without `nth` as one: misses a button drawn before its box, and would
  join two boxes with the same words once the first of them is removed.

**The setting changes the review page's settings bar shows and the `setting` lines of `duru story` are worked out in one server module, `src/setting-changes.ts`, and the page reads its results.**
For each setting a guard reads, the module gives the value with no change, whether that already meets the guard (or
that it is not known, when the source default was not read in full), the change to write, and why the settings file
cannot write it. The review server puts the result on each setting need it sends the page, and `duru story` calls the
same module on the settings file it reads without logging in. The page keeps only the check of a value the reviewer
just picked against the guard, since that changes with every click. The map holds the reason a guard could not be
read as a code, which the page turns into Korean and `duru story` into English, as the page already does for the codes
of calls whose address was not read.
The settings file is read only when `app.settingsFile` is set, since apps take their settings in different ways
(mattermost asks the `/config/client` API); otherwise the line says the deployed settings were not checked. Accounts
go under links between steps, route guards and the first-screen line, but not under links into the first screen from
screens outside the story, which the test does not take.
Alternatives compared:
- The page runs the same function, pasted into it as duru already pastes its settings-file rewrite into the app page:
  one copy and the same screen, but the page's type check cannot see the pasted function, so a renamed field there
  would be caught only by the browser tests.
- The page keeps its own calculation and `duru story` gets a copy: nothing to move, but two copies of the same rules
  drift apart.

**The story tab shows the conversation unfolded at the top of the right pane, as a screen does, and stacks the
verdict, 「사전 조건」, 「손볼 화면」, the save fields and the accept buttons in the middle.**
Asked for in #358 (2026-10-20); the driver chose the shape on mock-ups of a new story, a saved story and a candidate.
Before, those filled the top of the right pane and the conversation was folded into the form behind 「대화 N」, or
left out while a new story was written. The verdict is a chip beside the name, 「사전 조건 N」 and 「손볼 화면 N」 are
folded lines, and the accept buttons sit at the right end of a candidate's title row. On the mock-ups this moves the
step order down by 320px for a new story, 347px for a saved story and 39px for a candidate. Details settled on the way:
- A new story has no ID until it is saved, so its conversation form is greyed out with a line saying a conversation
  can be left once the story is saved; #365 gives the story being written a conversation.
- While 「● 기록」 fills the middle with the app there is no room for the save fields, so they are put away and come
  back after 「기록 끝」 with what was typed; saving already waited for 「기록 끝」. The verdict and 「사전 조건 N」 of the
  steps so far move to the top of the left column, above the steps passed, so they stay in sight while recording as
  they did in the right pane before.
- 「순서 저장」 and 「취소」 take the place of 「순서 고치기」 in the 「화면 순서」 heading, beside the order being changed.
- Beside the name only the verdict chip stays, not the link chips: 「도달 불가 · 링크 없음 N곳」 already says what
  「링크 없음」 says, and the same goes for 「화면 없음」 and 「판정 못 함」 (the driver's decision, 2026-10-21). The story
  list has no verdict chip, so it keeps the link chips.
- The middle pane is now drawn again while a name or memo is typed, when a verdict arrives or a save fails, so those
  fields carry a `name` and the redraw waits while a Korean syllable is being composed.
Alternatives compared:
- Splitting the middle into the info beside the steps: the driver chose one column, stacked.
- Keeping the info at the top of the right pane and unfolding the conversation under it: the two would share one
  360px pane, as #244 found for a screen.

## Why this is worth building — prior art (checked 2026-09-29)

Four research passes examined 84 tools, repositories, agent skills, MCP servers and papers. None
implements the whole loop. The closest:

| Candidate | Has | Lacks |
|---|---|---|
| Momentic (verified) | alpha app graph from test-run traces, coverage per journey variant; humans approve, reject or ignore graph items; local MCP lets Claude Code create and run tests | screens no test visited never appear; no notes on nodes; no config or dead-screen notion |
| Katalon TrueTest (verified) | journey maps from production traffic; gap analysis; generates tests for uncovered flows after a human selects them; MCP access | needs production traffic; no notes on nodes; vendor-side generation |
| QA Wolf Mapping Agent (not verified) | page graph and coverage outline; rejected flows keep their reason across re-mapping | managed service; no coding-agent integration found |
| Autonoma (not verified) | derives pages and flows from source; runs as a Claude Code skill | no per-node marks, no config guards, no client/server check |
| Cypress UI Coverage (not verified) | coverage painted on real screens per element; read-only MCP | Cypress only; no annotation layer |
| Playwright Test Agents | planner / generator / healer loop inside Claude Code | the plan is Markdown, not a map |

Missing everywhere:
1. Reachability computed across every configuration value. The only config-aware work found (PREFEST)
   is Android-only and works per test case, not per screen graph.
2. Dead-screen detection by joining each screen's API calls with the server's endpoint list.
3. Test depth per node. Every existing map has one layer.
4. Reviewer marks keyed to stable node IDs that an external agent can read.

1 and 2 are missing because every existing map is observed from one running instance. That is the gap
duru targets.

Reusable pieces: Playwright and its MCP/test agents for confirmation crawls and test generation;
springdoc-openapi or an existing endpoint inventory for the server side; Cypress UI Coverage's
views × elements data model and GraphWalker's "name tests after nodes" convention as design references.

## First extraction spike — result

On a React Router client with 45 routes:
- The extractor reproduced every route of a hand-drawn map and found 5 live screens the map had missed.
- It found, without being told, the condition on a login-page link (a system setting that must be true),
  following it through the click handler the link calls.
- It flagged 2 dead screens: 4 API calls with no endpoint anywhere on the server.
- Two calls looked dead but belonged to a customer-specific server module built only under one profile.
  The shared endpoint inventory did not include those modules. After adding them with a profile label, the
  calls showed as profile-only instead of dead. So server-side conditions exist too, and endpoint lists
  need labels.
- One run takes about 1.6 seconds.

## Open

- **Order of the deferred layers.** Cross-file button conditions filled in by the agent, the menu tree,
  and roots without a screen all come after the first version; which comes first is not decided.

Next step: split the first-version PRD into issues.
