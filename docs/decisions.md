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
  worker, so a method that keeps allocating is stopped by the time limit alone.
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
  file still brings all of its calls to every screen importing it.
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
