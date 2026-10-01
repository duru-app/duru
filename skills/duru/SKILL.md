---
name: duru
description: Run a duru review of a web client's screens and write the tests the reviewer asks for. Use only when the user asks for a duru review; do not use it for other code reviews or test work.
---

# duru review

duru computes the screens of a web client, attaches test results to them, and serves a local page where a
person marks the screens that need more tests. duru never calls a model: the reviewer decides what is missing,
and you write the tests.

## Before you start

- The project config: the JSON file `duru` reads (it names the client source, the server endpoint lists and
  the test result files). Ask the user for its path if you do not know it.
- The command: `duru` when it is installed, otherwise `node <duru checkout>/src/cli.mjs`.

## Sequence

1. **Rebuild the map.** Run `duru rebuild <config>`. It writes `map.json` and `tests.json` and prints a summary.
   Stop and report if it fails.
2. **Open the review page.** Run `duru review <config>` (add `--port <n>` if port 4400 is taken). It prints
   `review page http://127.0.0.1:<port>/` on standard error; give that address to the user and ask them to
   mark the screens and press 「리뷰 끝」 when they are done.
   The command blocks until the reviewer ends the review, so run it in a way that lets you read its standard
   output when it exits, for example as a background command whose output you read afterwards. Do not kill it
   or treat it as hung while the user is reviewing.
   When the reviewer presses 「리뷰 끝」 (or presses Ctrl+C in its terminal), the process exits with code 0 and its
   standard output is exactly the task list, the same text `duru tasks <config>` prints. Any other exit is an
   error: show its standard error to the user.
3. **Write the tests.** In the target project, write tests for each screen and API call in the task list,
   following its marks and notes. The top of the list says how to tag a test so that it attaches to a screen or call
   (`@screen:<screen ID>`, `@call:<call ID>`, `@depth:<depth>`); every new test needs those tags. A test of a
   call that sets an on/off option listed under it also carries `@option:<key>=true|false`; a mark on an
   option value (`withHistory=true at output depth`) asks for a test with that option tag at that depth. Do not edit
   or add marks: they are the reviewer's.
4. **Confirm the tests attached.** Run the new tests so that their results are written where the config's
   `tests` entries point, then run `duru rebuild <config>` again. Check the summary: the screens with tests
   should have gone up, and no `unknown` line should name one of your tags. Fix and repeat until they attach.
   A screen or call stays in `duru tasks` until a reviewer marks it `fine`, so an unchanged list is expected;
   offer the user another review round instead.
