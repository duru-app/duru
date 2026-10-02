---
name: duru
description: Run a duru review of a web client's screens and write the tests the reviewer asks for. Use only when the user asks for a duru review; do not use it for other code reviews or test work.
---

# duru review

duru computes the screens of a web client, attaches test results to them, and serves a local page where a
person marks the screens and the stories (a named order of screens a user goes through) that need more tests.
duru never calls a model: the reviewer decides what is missing, and you write the tests.

## Before you start

- The project config: the JSON file `duru` reads (it names the client source, the server endpoint lists and
  the test result files). Ask the user for its path if you do not know it.
- The command: `duru` when it is installed, otherwise `node <duru checkout>/src/cli.mjs`.

## Sequence

1. **Rebuild the map.** Run `duru rebuild <config>`. It writes `map.json` and `tests.json` and prints a summary.
   Stop and report if it fails.
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
