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
  JavaScript, which needs Node 22.13 or later. When the defaults come from a function the app never calls at
  load, or that needs arguments, add a small module beside the config that calls it and exports the result, and
  list it in `constants`.
- The command: `duru` when it is installed, otherwise `node <duru checkout>/src/cli.mjs`.
- The route files: `routesFile` in the config is one route file or a list of them, and duru reads only the files
  listed, so an app that splits its routes over several files needs each of them in the list. A screen on the map,
  and the `route at <file>:<line>` in the task list, name the route file the route is written in. When a screen
  you expect is missing from the map, check that the file holding its route is listed before reading the code
  for another cause. A `duplicate screen ID` line in the `rebuild` summary names the file and line of every
  route that makes the same ID.
- The route shapes duru reads: `component={Home}`, `element={<Home />}`, `element={wrap(<Home />)}`,
  `element={<Suspense><Home /></Suspense>}`, where the screen is the element inside the wrapping ones, and
  `element={<Wrapper Page={Signer} />}`, where the screen is the first of the wrapper and the passed components whose
  file is found, or the passed component when the wrapper is declared in the route file itself. A route whose
  element is `element={<Navigate to=… />}` is a redirect, not a screen. The redirect element names come from
  `redirectElements` in the config, default `Redirect` and `Navigate`; a config that lists them uses only the
  names listed. Paths are read as written in each route, without the path of a parent route in front, so a
  nested route written with a relative path shows on the map with that relative path.
- API code whose methods find their address in a table, or get a prefix when the request is sent, is read
  through `calledApiModules` and `requestFunction`: duru calls each method with fake values and records the
  request it hands to the app's request function. An `api method <name> ← <file>:<line>: <error>` line in the
  summary names a method that gave no address, so its calls are missing from the map and from every screen that
  calls it; a `calledApiModules <file> did not run` line means none of that file's methods are on the map. Tell
  the user which methods are missing; do not write tests or fixes for them as if their endpoints were gone.
  Most come from the fake values, for example a method that checks a value it is given or picks its address by
  it. A `{?}` in a call's address is a piece that came from a fake value, a path variable.
- A `component file not found` line in the `extract` summary names a screen whose component file duru could
  not find and the route it is written at. The map then holds only what the components wrapping that route
  bring: the screen's own source files, API calls, setting reads and links are missing.

## Sequence

1. **Rebuild the map.** Run `duru rebuild <config>`. It writes `map.json` and `tests.json` and prints a summary.
   Stop and report if it fails.
   When the summary also prints an `unchecked` count and a line saying the server API list is absent, the
   config has no server endpoint list (or one with no endpoint lines), so no call was compared with the server:
   a call's server match is `unchecked`, no call is dead and no screen is a dead screen. The task list then
   says under its intro that the comparison was skipped, and a task-list line `server: not checked` means the same; it does not mean the
   endpoint is missing, so do not write a test or a fix for a missing endpoint from it. Tell the user the list
   is missing.
   When it prints lines starting with `tsconfig import`, each names an import that matches an alias of the
   `tsconfig` file whose targets are inside the client source but finds no file, with the number of files that write it: the alias or the import is wrong, or
   the file is missing. Tell the user, because the screens that use those files miss what they would reach.
2. **Open the review page.** Run `duru review <config>` (add `--port <n>` if port 4400 is taken). It prints
   `review page http://127.0.0.1:<port>/` on standard error; give that address to the user and ask them to
   mark the screens and stories and press 「리뷰 끝」 when they are done.
   The command blocks until the reviewer ends the review, so run it in a way that lets you read its standard
   output when it exits, for example as a background command whose output you read afterwards. Do not kill it
   or treat it as hung while the user is reviewing.
   When the reviewer presses 「리뷰 끝」 (or presses Ctrl+C in its terminal), the process exits with code 0 and its
   standard output is exactly the task list, the same text `duru tasks <config>` prints. Any other exit is an
   error: show its standard error to the user.
3. **Write the tests.** In the target project, write tests for each screen, API call and story in the task list,
   following its marks and notes. The top of the list says how to tag a test so that it attaches to a screen or call
   (`@screen:<screen ID>`, `@call:<call ID>`, `@depth:<depth>`); every new test needs those tags. A test of a
   call that sets an on/off option listed under it also carries `@option:<key>=true|false`; a mark on an
   option value (`withHistory=true at output depth`) asks for a test with that option tag at that depth.
   Under a call, `options that change this result — set on <call ID>` lists the options of that other call
   which change what this call gives back. Each value counts only the tests of that other call at output depth,
   so a test for such a value carries `@call:<that other call ID>`, its `@option:<key>=true|false` and
   `@depth:output`, and checks what the first call gives back.
   Under `empty tests`, a screen or call has one set for each open mark and a story one set: an empty test per
   test format in the config, with those tags already in its title. Copy the one for the runner you write the
   test in and keep every tag in its title as it is (you may replace `<what it checks>` and add words around the
   tags). Each is held back so that a copy left as it is does not pass: take `.fixme` off `test.fixme`, turn
   `test.todo` into `test` with a function, remove `@Disabled` (while it stays, the class needs
   `import org.junit.jupiter.api.Disabled;`), then fill in the data setup and the checks. For a check script,
   print the `VERDICT` line with what was seen and a word in place of `<verdict>` (`UPHOLDS`, `FIXED`, `HEALTHY`
   pass; `REPRODUCES`, `VIOLATE`, `VIOLATES`, `REGRESSED`, `BROKEN` fail; any other word, such as `PASS`, stays
   pending); the test name runs up to the first `: `, so keep `: ` out of it.
   The items under `# Stories` are stories. For each, write one test that goes through its `screens` in that
   order and meets its `preconditions` (the settings, roles and link conditions it lists, with where each is
   checked), and put `@story:<story ID>` in its title together with the `@screen:` tags of every screen on its
   path that is on the map, as its empty test has them.
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
