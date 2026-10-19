---
name: duru
description: Run a duru review of a web client's screens and write the tests the reviewer asks for. Use only when the user asks for a duru review; do not use it for other code reviews or test work.
---

# duru review

duru computes the screens of a web client, attaches test results to them, and serves a local page where a
person marks the screens and the stories (a named order of screens a user goes through) that need more tests.
duru never calls a model: the reviewer decides what is missing, and you write the tests.

A screen's own tests are the tests that carry its tag. duru also finds *importing* tests: a
test linked to a screen only by the source files it imports, shown on the review page under 「불러오는 테스트」. They
are not counted as tests of the screen until they carry the screen's tag, and duru recomputes them on every
rebuild. The same holds for *passed-through* tests: a Playwright test whose trace shows that it opened a screen
(「지나간 테스트」) or sent an API call (「호출한 테스트」) without carrying that tag. Opening a screen or sending a
call is not checking it, so never report such a test as a test of the screen or call. The reviewer can discard
such a pair or hand it over for tagging; a handed-over pair appears in the task list under `# Tagging`.

## Before you start

- The project config: the JSON file `duru` reads (it names the client source, the server endpoint lists and
  the test result files). Ask the user for its path if you do not know it.
- The `tsconfig` item of the config (optional): the tsconfig file that declares the app's import aliases such as
  `@domains/...`, relative to the config file. When the app writes imports with such names and the config has
  no `tsconfig`, duru takes them for outside packages and a screen's sources stop at the first one, so its
  API calls, settings reads and links are missing from the map. Add the item, pointing at the tsconfig file
  of the client that holds `paths` (when `tsconfig.json` only lists `references`, the referenced file such as
  `tsconfig.app.json`); duru reads `paths`, `baseUrl` and `extends` from it. There is no item for aliases written by
  hand.
- Settings defaults: `settingsDefaults` gives each settings root either `{ "file", "const" }`, an object literal
  written in a file, or `{ "constant": "<constants name>[.<path>]" }`, the value a `constants` module gives when
  run, for defaults a function builds. duru runs `constants` modules, `.ts` ones after turning them into
  JavaScript. When the defaults come from a function the app never calls at load, or that needs arguments, add a
  small module beside the config that calls it and exports the result, and list it in `constants`.
- Settings read through a function: when the app reads its settings from the object a function returns, such as
  `const signing = readSystemSettings({ SIGN_LIST: [] })` and then `signing.SIGN_LIST`, add the function to
  `settingsFunctions` as `{ "import", "name", "root", "section" }`, with the settings root and the key under it
  the function reads. Without it those reads and the conditions on them are missing from the map. The object
  passed to the function gives the defaults. Lines starting with `settingsFunctions` in the `extract` summary
  name a call duru did not read in the files the route files lead to, a default that differs from another one or
  cannot be compared with it, or a function called in none of those files; tell the user, since the settings
  behind them are missing or their defaults unknown.
- The command: `duru` when `npm link` put it on the path, otherwise `node <duru checkout>/src/cli.ts`, on Node
  22.18 or later (23.6 or later on Node 23). A copy of duru installed into `node_modules`, as from a packed `.tgz`,
  stops on its first `.ts` file.
- The route files: `routesFile` in the config is one route file or a list of them, and duru reads only the files
  listed, so an app that splits its routes over several files needs each of them in the list. A screen on the map,
  and the `route at <file>:<line>` in the task list, name the route file the route is written in. When a screen
  you expect is missing from the map, check that the file holding its route is listed before reading the code
  for another cause. A `duplicate screen ID` line in the `rebuild` summary names the file and line of every
  route that makes the same ID.
- The route shapes duru reads: `component={Home}`, `element={<Home />}`, `element={wrap(<Home />)}`,
  `element={<Suspense><Home /></Suspense>}`, where the screen is the element inside the wrapping ones, and
  `element={<Wrapper Page={Signer} />}`, where the screen is the first of the wrapper and the passed components whose
  file is found, or the passed component when the wrapper is declared in the route file itself,
  `render={() => <Home />}`, a render function that returns one element, read as `element=` reads it, and
  `<Route path=…><Home /></Route>`, a child element read the same way. A route whose render function or children
  hold other routes only wraps them. A route whose element is `element={<Navigate to=… />}` is a redirect, not a
  screen. The redirect element names come from
  `redirectElements` in the config, default `Redirect` and `Navigate`; a config that lists them uses only the
  names listed. A route file that another screen draws, whose paths start with the address that screen's route
  matched (`${match.url}/…`, `useRouteMatch().path`), gets that screen's path in front; a nested route written with
  a relative path shows on the map with that relative path.
- API code whose methods find their address in a table, or get a prefix when the request is sent, is read through
  `calledApiModules` and `requestFunction`: duru calls each method with fake values and records the request it hands
  to the app's request function, or to `get`, `post`, `put`, `patch` and `delete` of the app's request object when
  `requestFunction` has `"object": true`, every request sent with the global `fetch` (for API code that sends
  only through `fetch`, `requestFunction` is left out), and every link a method clicks, `window.open` or address
  given to `location`, as a `GET`. An `api method <name> ← <file>:<line>: <error>` line in the summary names a
  method that gave no address, so its calls are missing from the map and from every screen that calls it; a
  `calledApiModules <file> did not run` line means none of that file's methods are on the map, and a
  `calledApiModules ran <import> as a stand-in, though it is <path> outside srcRoot` line names a package of the
  repository whose API code was not run; ask the user to add its folder to `sourcePackages`. A `calledApiModules
  <file> recorded no request` line means that file sent nothing with `fetch` or by moving the browser while
  `requestFunction` is left out: check whether it sends through something `requestFunction` should name. Tell the
  user which methods are missing; do not write tests or fixes for them as if their endpoints were gone. Most come
  from the fake values, for example a method that checks a value it is given or picks its address by it. A `{?}` in
  a call's address is a piece that came from a fake value, a path variable.
- A request a screen sends from its own source, by `fetch`, axios or the function or object `requestFunction`
  names, is among that screen's `apiCalls` with `"direct": true` and how it is sent (`fetch`, `axios.post`,
  `<form action>`) where an API function's name would be. A form that posts is there too, and another move of the
  browser (`href`, `window.open`, an address given to `location`) only when the server list holds its path or
  `app.apiPaths` covers it. A `request <how> ← <file>:<line>: address not read (<reason>)` line in the summary
  names a request whose address duru could not work out; it is on the screen without an address, in no call, and
  listed under `unreadRequests`. An `api call <name> ← <file>:<line>: address not read (<reason>)` line is the same
  for a screen's call of an API function at that place. Tell the user which requests and calls those are and why,
  from the reason, which is also the `reason` of the call's `unresolved` server match on the map:
  `not-written` — no address is written where it is sent, so it comes from the caller or is missing; when the line
  points into a function of the app that other requests go through, ask the user to name that function in
  `requestFunction`. `imported-piece` — part of the address is what a function imported from another file
  returns, or an imported name whose value duru could not read where it is declared. `unknown-piece` — a value duru does not know stands in front of the address or inside its text, such as
  a base address it could not read. `no-path` — the address is only the top of the site. `other-host` — the whole
  address after `only` is on a host duru does not take for the app's server; when that host is the app's server,
  ask the user to give it in `app.server`. None of these is a call missing on the server: do not treat it as dead.
- In an app that uses redux-saga, a call with `actions` is sent by a saga, written at the line it names in the
  saga, and comes to the screen because the screen dispatches one of those action types at the places under
  `dispatchedAt`. A test of that call for the screen does what the code at a `dispatchedAt` place answers to.
  When the summary says `redux-saga is imported, but no run of a createSagaMiddleware() result was found`, no
  saga request is on any screen: tell the user that the screens' requests sent through sagas are missing.
- On/off options read from request body types: with `tsconfig`, `bodyArgKeys` (such as `["body"]`) and
  `requestFunction.body` (such as `"0.body"`), a call gets an option for each true/false field of the body its API
  method sends, named by the field's path in the body. A `body type <name>: <field> goes with <other field>` line names a field that
  picks among more than two values with that other field, such as an authentication that is off, by contact or by
  password; it is not an option, so tell the user it needs a test per value. A `body type <name>: the body is
  typed …` or `body type <name>: it sent a body, but no …` line names a method whose body fields duru could not
  read, so its options are missing from the map.
  A `bodyTypeExclusions <call ID> leaves out <field>` line names a field the config took out of that call's
  options; if a screen lets the user set that field, tell the user to remove it from `bodyTypeExclusions`. A
  `bodyTypeExclusions <call ID> <field> stays an option, given by …` line names an entry the screen code or
  `bodyOptions` overrides, so tell the user it can be removed. A `bodyTypeExclusions` line ending in
  `matches no call` or `matches no on/off option …` names an entry that took nothing out.
- A screen's API calls are the ones its code reaches, each with the file and line where it is written,
  while its `sourceFiles` hold whole files. A call written in one of those files is not the screen's when the
  screen does not use the function holding it, so do not write a test of that call for the screen.
  A call whose file is a store class the screen gets from a React context hook (`useStores()`) can sit outside
  `sourceFiles`: the screen calls the store method that sends it, so it is the screen's to test like any other.
- A `component file not found` line in the `extract` summary names a screen whose component file duru could
  not find and the route it is written at. The map then holds only what the components wrapping that route
  bring: the screen's own source files, API calls, setting reads and links are missing.
- A `route path not read ← <route file>:<line>: stopped at <piece>` line names a route whose path holds `{?}`,
  with the first piece duru could not read where it stopped; an `in <file>:<line>` after it appears only when duru
  followed a name into another file and stopped there. An address a browser test passes through is not matched to
  that screen, and when its ID holds `{?}` the ID changes once that part is read, so do not tag tests with such an
  ID; tell the user which routes these are and where each one stopped.
- A `route not read ← <route file>:<line>: <reason>` line names a route that draws a screen missing from the map,
  with where it is written and why duru could not read it. There is no ID for that screen, so no test can be tagged
  with it; tell the user which routes these are and why each one was not read. A line whose reason starts with `made for
  each item of a list` stands for one screen per item.

## Sequence

1. **Rebuild the map.** Run `duru rebuild <config>`. It writes `map.json` and `tests.json` and prints a summary.
   Stop and report if it fails.
   When the summary also prints an `unchecked` count and a line saying the server API list is absent, the
   config has no server endpoint list (or one with no endpoint lines), so no call was compared with the server:
   a call's server match is `unchecked`, no call is dead and no screen is a dead screen. The task list then
   says under its intro that the comparison was skipped, and a task-list line `server: not checked` means the same; it does not mean the
   endpoint is missing, so do not write a test or a fix for a missing endpoint from it. Tell the user the list
   is missing.
   When it prints a line `caseKinds <kind> picks[<i>] matches no screen` (or `no call`), that rule of the kind
   picks nothing on this map, most likely a typo in its pattern or method; tell the user, with the rule as printed.
   When it prints lines starting with `tsconfig import`, each names an import that matches an alias of the
   `tsconfig` file whose targets are inside the client source but finds no file, with the number of files that write it: the alias or the import is wrong, or
   the file is missing. Tell the user, because the screens that use those files miss what they would reach.
   When the config names `baselineMap`, the summary also prints a `changes since <file> | …` line
   counting what changed since that earlier map; it asks nothing of you. A run that stops with a line starting with
   `baselineMap` names a file that is missing, unreadable or built by an older duru: tell the user.
2. **Open the review page.** Run `duru review <config>` (add `--port <n>` if port 4400 is taken). It prints
   `review page http://127.0.0.1:<port>/` on standard error; give that address to the user and ask them to
   mark the screens and stories and press 「리뷰 끝」 when they are done.
   The command blocks until the reviewer ends the review, so run it in a way that lets you read its standard
   output when it exits, for example as a background command whose output you read afterwards. Do not kill it
   or treat it as hung while the user is reviewing.
   A background command wakes you only when it exits, so while a review runs, keep one
   `duru wait <config> --server <the review page address>` running as a background command, on the address that
   review printed. It exits as soon as there is a comment nobody has replied to, and its standard output then holds
   every such comment, oldest first, one JSON line each. Answer each one as below, then, if the review command is
   still running, start `duru wait` again the same way. Reply to every comment it brings, even only to say what you
   could not do: a comment without a reply comes back at once. It also brings comments saved before it started or
   between two runs, so none is lost while it is not running.
   When it exits with code 0 and nothing on standard output, that review has ended; read the task list from the
   review command and start no more `duru wait` for it. A non-zero exit means it got no comments from the review
   page: show its standard error to the user, unless you stopped it yourself or were starting the review again just
   then.
   If you start the review again, whatever the reason, start `duru wait` again on the address the new review
   prints, after stopping the earlier `duru wait` if it is still running.
   In Claude Code the review also sends each comment into your session as a message from another session: its first
   line starts with `duru review comment;` and names the `duru reply` to run, and its second line is the comment's
   JSON line. Answer it as below, and keep `duru wait` running all the same; when the same comment `id` comes both
   ways, answer it once.
   Each mark or comment the reviewer saves also comes out on the review's standard error at once, and `duru wait`
   prints comments in the same shape: one JSON line starting with `{"duru":`: `"comment"` (no `status`) or
   `"mark"`, with its `id`, `target` (a screen or call ID under `node`, or a story ID under `story`; `targets` for a
   comment on several targets or none, see below), `note`, `author`
   and `date`. Act on a
   comment when it arrives: it is the reviewer asking about or for something on that target, so answer the
   question or do what it asks (a missing test is written as in step 3, with the target's tags). Then answer it on
   the page with `duru reply <config> <the comment's id> "<answer>" --server <the review page address>`, using the
   address the review printed; the reply shows under the comment on the reviewer's open page at once. Keep the
   answer to what you found or did, in a sentence or two. Once the review has ended, as the review command exiting or
   `duru wait` exiting with code 0 and nothing on standard output tells you, run the same `duru reply` without
   `--server`; the reply is then written to the marks folder. If `reply` exits with a non-zero code, show its
   standard error to the user. Each reply sent with `--server` also comes out on the review's standard error as a
   `"reply"` line with `replyTo` set to the comment's `id`; it asks for nothing. A mark with `needs-more`
   (「테스트 필요」 on the page) will be in the task list, and you may start on it now. A
   target can also carry a `depth` or an `option` of a call, and a mark whose target has a `case` (status `needed`
   or `not-needed`) or whose status is `fine` asks for nothing by itself. A `not-needed` case mark that also carries
   `rule`, `{ "index", "pick" }`, took that screen or call out of the rule at that place in the kind's `picks`
   (counted from 0, `pick` as the rule was written); its `note` says why, and no test of that kind is wanted there.
   A comment can also be about one part of a screen or call, named in `target.part` as `{ "kind", "key" }`. Such a
   line carries `where`, saying where that part is now, or `null` when it is no longer found or `tests.json` (for a
   test) or `map.json` could not be read at that moment (a `rebuild` was writing it), so check the task list before taking it as gone; a reply to the comment
   carries the same `target` and `where`. A part takes comments only, never a status. By kind:
   - `"kind": "test"`: one test row under the screen or call. `key` names the test by its result file (`source`),
     test file and title without tags. `where` gives the test `file` and `line`, the result file `source`, its
     `status`, a `detail` for a verdict line, and its `relation` to the target: `tagged` (it carries the tag),
     `imported` (a unit test that imports a source file of the screen), `passed` (a browser test that opened the
     screen while running) or `called` (a browser test that sent the call while running). For a failing test,
     find the test by its title in that result file, read why it failed from that result file, find the cause
     and fix the test or the app in the target project. For a test whose relation is `imported`, `passed` or
     `called`, answer whether the tag may be added, judging from what the test checks, and add it only when the
     comment asks you to, as in a `# Tagging` item.
   - `"kind": "condition"`: one role or setting under 「접근 조건」 of a screen. `key` is `role:<role>`, or for a
     setting its path with the state the condition asks (`setting:<path>=on`, `=off` or `=present`) or, for a
     list that must hold a value or a setting that must equal one, the value after a colon
     (`setting:<path>:<value>`). `where` has `places`, one for each line the condition is read from: `from` is
     `route` (the route line of the screen) or the ID of the screen a link into it starts on, with `file`,
     `line` and the `guard` as written there, `via` when the guard sits in a function the link calls, and
     `roleGuardsKey` when the config's `roleGuards` gave its roles. A place with `inherited` and no `guard` is a
     link that asks nothing itself, so the screen it starts on passes its own condition on.
   - `"kind": "link"`: one link into the screen. `key` has `from`, the screen the link starts on, and
     `conditions`, the roles and settings duru read from its guards in the names above, or `guards`, the guards
     as written when duru read no role or setting from them (empty when the link has no guard). Links from one
     screen that read the same are one part. `where` has `places`, each with `from`, `file` and `line` of such a
     link.
   For both, read the line in the target project. If the app does not do what duru read there (a wrong role or
   setting, a link that is not there, a condition duru missed), tell the user it is a duru defect, naming the
   line and what duru read; otherwise answer with the line that shows the app does what duru read.
   A comment can also be on one step of a story or on the link between two of its steps, with `target` set to
   `{ "story": "<ID>", "part": … }`:
   - `"kind": "step"`: `key` has `step`, the step's number counted from 1, and `screen`. `where` has `file`, the
     story file under the config's `storiesDir`, and `screen` with its `componentFile`, `routeFile` and route
     `line` (`"onMap": false` when the screen is not on the map). Add what the comment asks to check on that
     screen to the story's test.
   - `"kind": "hop"`: `key` has `step`, the number of the step the link leaves, and `from` and `to`, the two
     screens. `where` has `file`, `from` and `to` in the same shape, the link's `verdict` and `ways` (where it is
     written and its conditions) as the story shows them, and `preconditions`, the story's preconditions that
     concern this link. Write a test that checks that move or those preconditions; if the link is not where duru
     says or the verdict is wrong, tell the user it is a duru defect, naming the line.
   `where` is `null` once the story no longer has that screen at that step, and while the story file or the map
   cannot be read or the map is older than stories; then answer from the key, and tell the user what
   `duru rebuild` reports about the story file or the map.
   A comment can also be on a story candidate, with `target` set to `{ "candidate": "<key>" }` and nothing else.
   The key is its screen IDs joined with ` > `, for a candidate from a visit record as for one from a Playwright
   trace. Its line carries `where` with the candidate's `name`, its `screens` in order and its
   `source`: `{ "record", "steps" }` with `stepRanges`, the steps of the record behind each screen, or
   `{ "report", "tests" }`, the result file and the titles of the tests that passed through that order. `where` is
   `null` once the candidate has been accepted or discarded, or when the map or `tests.json` could not be read at
   that moment. Such a comment asks about the order before the reviewer accepts it: answer why that order came out,
   citing the record and the steps behind each screen, or the test by its title and the steps it takes in the
   target project. A comment on a candidate takes no status and never appears in the task list, so act on it when
   its line arrives.
   A comment can also be on several targets or on none. Its line then has `targets`, a list of targets in the shapes
   above, in place of `target`, and `wheres`, the `where` of each target in the same order (`null` for one that has
   none or is no longer found). Answer it once, covering every target it names. With an empty `targets` the reviewer
   asks without pointing at anything: answer from the map, the task list and the tests as a whole. Such a comment
   takes no status, and a reply to it carries the same `targets`.
   After you have answered or fixed it, reply to the comment as above.
   When the reviewer presses 「리뷰 끝」 (or presses Ctrl+C in its terminal), the process exits with code 0 and its
   standard output is exactly the task list, the same text `duru tasks <config>` prints. Any other exit is an
   error: show its standard error to the user. In the task list a `reply` line sits under the `comment` line it
   answers, and under an open screen or call `comments on tests` lists each test a comment was left on, with its
   place, status, relation and result file, then those comments and their replies; under an open screen
   `comments on opening conditions` and `comments on incoming links` list each condition and link the same way,
   with the source lines they are read from; under an open story `comments on steps` and
   `comments on links between steps` list each step and link with its screen files and the link's verdict; act
   on them as above. A comment on several targets shows under each of them that is listed, ending with
   `left on N targets:` and all of them; answer it once. Comments with no target come first, under
   `# Comments with no target`.
3. **Write the tests.** In the target project, write tests for each screen, API call and story in the task list,
   following its marks and notes. The top of the list says how to tag a test so that it attaches to a screen or call
   (`@screen:<screen ID>`, `@call:<call ID>`, `@depth:<depth>`); every new test needs those tags. For Playwright,
   put the tags in the test's `tag` option (`test('<what it checks>', { tag: ['@screen:<screen ID>'] }, …)`) and
   keep them out of the title (before Playwright 1.42, which has no `tag` option, put them at the end of the
   title); for Vitest put them at the end of the test's own title, for JUnit at the end of its
   `@DisplayName`, and for a check script at the end of the `VERDICT` line. The review page and the story
   candidates show a title without its tags either way. A test of a
   call that sets an on/off option listed under it also carries `@option:<key>=true|false`; a mark on an
   option value (`withHistory=true at output depth`) asks for a test with that option tag at that depth.
   Under a call, `options that change this result — set on <call ID>` lists the options of that other call
   which change what this call gives back. Each value counts only the tests of that other call at output depth,
   so a test for such a value carries `@call:<that other call ID>`, its `@option:<key>=true|false` and
   `@depth:output`, and checks what the first call gives back.
   A screen that opens only under a role or a setting lists its `cases` with the tests of each. A test of a case
   carries the case's tag next to `@screen:` as the list writes it: `@role:<role>` signs in as that role and
   checks the screen opens; `@role:other` signs in as a role that does not open it and checks it stays shut, and
   its title names that role, since the tag does not; `@setting:<path>=true` meets that setting condition and
   checks the screen opens, `=false` breaks it and checks the screen stays shut. A tag that is not one of the
   screen's cases does not attach and `rebuild` prints it as `unknown`.
   A screen or call can also list under `cases` a kind of case a reviewer, or a rule in the config's `caseKinds`
   `picks`, picked for it, written `@case:<kind>`
   followed by what to test; a test of it carries that tag next to `@screen:` or `@call:` and checks what the
   description asks. A kind with values is listed by its description followed by a case per value, written
   `@case:<kind>=<value>`; a test of one value carries that tag and sets up that value, and a test that carries
   the kind without a value counts for none of them. When the config names `caseKinds`, a `@case:` tag whose kind is
   not among them, a kind with values tagged without one, a value the kind does not list, or a value on a kind
   without values is printed as `unknown`.
   Under `empty tests`, a screen or call has one set for each open mark, a screen one more for each case with no
   tests, a call one more for each picked kind with no tests (for a kind with values, one for each value with no
   tests), and a story one set: an empty test per
   test format in the config, with those tags already in place: in the `tag` option for Playwright, in the title for
   the other formats. Copy the one for the runner you write the test in and keep every tag where it is (you may
   add words around the tags in a title). Replace `<what it checks>` with what the test checks: the Playwright
   empty tests of an item all carry that same title, and no two tests in a file should share one. Each is held back so that a copy left as it is does not pass: take `.fixme` off `test.fixme`, turn
   `test.todo` into `test` with a function, remove `@Disabled` (while it stays, the class needs
   `import org.junit.jupiter.api.Disabled;`), then fill in the data setup and the checks. For a check script,
   print the `VERDICT` line with what was seen and a word in place of `<verdict>` (`UPHOLDS`, `FIXED`, `HEALTHY`
   pass; `REPRODUCES`, `VIOLATE`, `VIOLATES`, `REGRESSED`, `BROKEN` fail; any other word, such as `PASS`, stays
   pending); the test name runs up to the first `: `, so keep `: ` out of it.
   The items under `# Stories` are stories. For each, write one test that goes through its `screens` in that
   order and meets its `preconditions` (the settings, roles and link conditions it lists, with where each is
   checked), and give it `@story:<story ID>` together with the `@screen:` tags of every screen on its path that is
   on the map, in the place its format takes tags, as its empty test has them.
   A story item may also carry lines a person wrote in the story file, which duru does not check against the
   code: `needs` before `screens` lists what has to hold before the story starts, a `link need from step N` line
   under a step what has to hold on the link from step N, the step before, for the story to come into this step
   (which of several ways between the same two screens it takes), a `need` line under a step what has to hold at
   that step, an `expect` line under a step what should be seen there, and `expects at the end` what should hold
   once the last step is done. Set up each need in the test's data setup or its steps before the step it belongs
   to, make the test take the link a `link need from step N` line names, check each expect at that step or at the
   end, and when one cannot be set up or checked in the app, tell the user which one instead of leaving it out.
   An `input` line under a step names a box to fill at that step and the value to put in it. The box is named by
   the words the screen shows: `placeholder` (the hint inside the box), `label` or `testId`, several joined by `or`
   all pointing at the same box, with `number N` when it is the Nth box those words find; the value is a JSON
   string. Find the box in the test by those words as they are (a placeholder, label or test ID locator, taking the
   Nth match when there is a number), fill in the value at that step, and do not swap the words for a CSS or XPath
   selector. duru did not look for the box in the code, so the story may name a box the screen does not have:
   when the test cannot find the box, tell the user which input it is instead of guessing another box.
   A need written `<name> (needs/<file>): <text>` is a need file of the story folder that several stories pick,
   such as an account to sign in with: set it up from its text, and the same way in every story test that picks the
   same file; on a `link need from step N` line, set it up before step N so the test can take that link. A need
   written `needs/<file> — the file is missing` or `— the file could not be read` points at a need
   file duru did not find or could not read; tell the user which one rather than guess what it holds.
   The items under `# Tagging` (they can be listed even when no mark is open) are tests the reviewer judged to
   check a screen or API call they carry no tag for. For each, open the test at its file and line and add exactly
   the tag in `tag to add`, in the place its `where` line names, and change nothing else in the test: not its
   title when the tag goes in the test's tag option, not its body, not its name. By format, the tag goes in the
   `tag` option of the test for Playwright (`{ tag: '@screen:<screen ID>' }`, the title stays as it is), at the end
   of the test's own title for Vitest (never a `describe` title), at the end of its `@DisplayName` for JUnit, and at
   the end of the `VERDICT` line for a check script. Do not write a new test for the item and do not edit the
   reviewer's `note`. Run the test so its result is written again, then `duru rebuild <config>`: the item leaves the
   list once the tag is read, and the test counts as a test of that screen or call. The item stays when the result
   file was not rewritten or the tag is not the one given. An item that left the list is done only if the test now
   appears as a tagged test of that screen or call and `rebuild`'s "handed over but no longer found" count did not
   go up: a test whose file or title no longer matches the result also leaves the list, as a detached pair. So
   change nothing in the title except appending the tag, and do not move the file.
   Its story tests and the tests already on each screen show what is covered. A story whose `reach` is
   `unreachable` or `not judged` (a step with `no link`, a screen `not on the map`) may not be walkable as
   written: when a step cannot be taken, tell the user which one instead of writing a test that skips it. Do not
   edit or add marks, and do not change a story file to fit a test: they are the reviewer's.
4. **Confirm the tests attached.** Run the new tests so that their results are written where the config's
   `tests` entries point, then run `duru rebuild <config>` again. Check the summary: the screens with tests
   should have gone up, the stories you wrote tests for should have moved out of `partly covered` and `no tests`,
   and no `unknown` line should name one of your tags. Fix and repeat until they attach.
   A screen, call or story stays in `duru tasks` until a reviewer marks it `fine`, so an unchanged list is expected;
   offer the user another review round instead.
