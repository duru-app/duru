# Decisions so far

Early-stage record of what has been decided, why, and what is still open. Read this before writing the
PRD or changing the extractor's output shape.

## The loop duru is for

1. Build a screen map of an app: entry points → menus → screens → buttons/actions, covering every screen
   reachable under **any** configuration value, and flagging dead screens (the screen calls an API the
   server does not have).
2. Attach to each node the tests that cover it, their depth (UI/E2E, API, render-only, code, data,
   output — the content of what the app produces) and their status (pass, fail, pending).
3. A person reviews the map and marks nodes or test cells: "needs more", "missing", "fine", with a note.
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
line that has no mapping of its own names the file without a line. JSX still stops the extraction in both modes,
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
ky's `.json()`, ends in an error printed for that method, and ky's `prefixUrl` is not read; a `baseURL` given
to one request rather than to `create` is not read; the constants run does not stand in for `import.meta.env`,
so a constants file reading it still fails there.

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

**A screen gets the API calls that the names it uses reach; its links and setting reads still come from every
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
file. The following lives in `src/follow-names.mjs`, which takes a file and a name and gives back the call sites
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
  already cleared the links and setting reads.
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
the first 22 release that runs them without a flag, and prints no warning. On Node 23, 23.5.0 stops the same way
and 23.6.0 runs them with an experimental warning; 24.14.0 runs them without one. The lowest version is
therefore `^22.18.0 || >=23.6.0`. A `.ts` file imports others with their `.ts` ending
(`allowImportingTsExtensions`), and syntax that cannot just be dropped, such as `enum`, is refused by
`erasableSyntaxOnly`. `allowJs` lets a `.ts` file import an `.mjs` one; `checkJs` stays off, so `.mjs` files are
only parsed, and a function from one is typed loosely: calling it with an argument missing is not reported until
it is moved. Not covered: Node does not drop types from files under `node_modules`; duru linked there from its
clone runs, since Node follows the link, but a copy installed from a packed `.tgz` stops with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. The type check adds about 3 s to `npm test`.
Measured on main 38f87f3 against the branch: the into-sign 1.5.0 and 2.0.0 maps and the two example maps are
identical apart from the time they were written.

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
