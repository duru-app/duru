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
