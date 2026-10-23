import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SKILL = fs.readFileSync(path.join(import.meta.dirname, '../skills/duru/SKILL.md'), 'utf8');

test('the agent skill says how to work through the stories in the task list and how to tag a story test', () => {
  assert.match(SKILL, /`# Stories`/);
  assert.match(SKILL, /`@story:<story ID>`/);
});

test('the agent skill says to copy the empty test for its runner from the task list and keep its tags where they are, in the tag option for Playwright', () => {
  assert.match(SKILL, /`empty tests`/);
  assert.match(SKILL, /keep every tag where it is/);
  assert.match(SKILL, /For Playwright,\s+put the tags in the test's `tag` option/);
  assert.match(SKILL, /already in place: in the `tag` option for Playwright, in the title for\s+the other formats/);
  assert.match(SKILL, /`test\.fixme`[\s\S]*`test\.todo`[\s\S]*`@Disabled`/);
  assert.match(SKILL, /`import org\.junit\.jupiter\.api\.Disabled;`/);
  assert.match(SKILL, /`<verdict>` \(`UPHOLDS`, `FIXED`, `HEALTHY`\s+pass;/);
});

test('the agent skill says how to tag a test for an option that changes what another call gives back', () => {
  assert.match(SKILL, /`options that change this result — set on <call ID>`/);
  assert.match(SKILL, /`@call:<that other call ID>`, its `@option:<key>=true\|false` and\s+`@depth:output`/);
});

test('the agent skill says how to tag a test of a role or setting case of a screen', () => {
  assert.match(SKILL, /`cases`/);
  assert.match(SKILL, /`@role:other` signs in as a role that does not open it[\s\S]*its title names that role/);
  assert.match(SKILL, /`@setting:<path>=true` meets that setting condition[\s\S]*`=false` breaks it/);
  assert.match(SKILL, /a screen one more for each case with no\s+tests/);
});

test('the agent skill says how to tag a test of a kind of case a reviewer picked for a screen or call', () => {
  assert.match(SKILL, /`@case:<kind>`/);
  assert.match(SKILL, /carries that tag next to `@screen:` or `@call:`/);
  assert.match(SKILL, /a call one more for each picked kind with no tests/);
});

test('the agent skill says how to tag a test of one value of a kind of case with values', () => {
  assert.match(SKILL, /`@case:<kind>=<value>`; a test of one value carries that tag/);
  assert.match(SKILL, /carries\s+the kind without a value counts for none of them/);
  assert.match(SKILL, /for a kind with values, one for each value with no\s+tests/);
});

test('the agent skill says what an unchecked server match means when there is no server API list', () => {
  assert.match(SKILL, /`unchecked`/);
  assert.match(SKILL, /no call is dead and no screen is a dead screen/);
  assert.match(SKILL, /`server: not checked`/);
});

test('the agent skill says what an importing test is and how to add the tag a Tagging item asks for', () => {
  assert.match(SKILL, /importing[\s\S]*not counted as tests of the screen until they carry the screen's tag/);
  assert.match(SKILL, /`# Tagging`/);
  assert.match(SKILL, /add exactly\s+the tag in `tag to add`[\s\S]*change nothing else in the test/);
  assert.match(SKILL, /`tag` option of the test for Playwright[\s\S]*Vitest[\s\S]*`@DisplayName` for JUnit[\s\S]*`VERDICT` line/);
  assert.match(SKILL, /item leaves the\s+list once the tag is read/);
  assert.match(SKILL, /item stays when the result\s+file was not rewritten or the tag is not the one given/);
  assert.match(SKILL, /left the list is done only if the test now\s+appears as a tagged test[\s\S]*count did not\s+go up[\s\S]*change nothing in the title except appending the tag, and do not move the file/);
});

test('the agent skill says what the tsconfig item of the config is for and what the alias lines of the summary mean', () => {
  assert.match(SKILL, /The `tsconfig` item of the config/);
  assert.match(SKILL, /takes them for outside packages and a screen's sources stop at the first one/);
  assert.match(SKILL, /There is no item for aliases written by\s+hand/);
  assert.match(SKILL, /lines starting with `tsconfig import`/);
});

test('the agent skill says how settings defaults a function builds are given', () => {
  assert.match(SKILL, /`\{ "constant": "<constants name>\[\.<path>\]" \}`/);
  assert.match(SKILL, /small module beside the config that calls it/);
});

test('the agent skill gives the Node version duru needs and says a copy installed into node_modules stops', () => {
  assert.match(SKILL, /Node\s+22\.18\s+or\s+later\s+\(23\.6\s+or\s+later\s+on\s+Node\s+23\)/);
  assert.match(SKILL, /A\s+copy\s+of\s+duru\s+installed\s+into\s+`node_modules`,\s+as\s+from\s+a\s+packed\s+`\.tgz`,\s+stops\s+on\s+its\s+first\s+`\.ts`\s+file/);
});

test('the agent skill says to keep one duru wait running for each review, answer what it prints and start it again, and start a new one when the review is started again', () => {
  assert.match(SKILL, /A background command wakes you only when it exits, so while a review runs, keep one\s+`duru wait <config> --server <the review page address>` running as a background command, on the address that\s+review printed/);
  assert.match(SKILL, /Answer each one as below, then, if the review command is\s+still running, start `duru wait` again the same way/);
  assert.match(SKILL, /a comment without a reply\s+comes back at once/);
  assert.match(SKILL, /When it exits with code 0 and nothing on standard output, that review has ended; read the task list from the\s+review command and start no more `duru wait` for it/);
  assert.match(SKILL, /A non-zero exit means it got no comments from the review\s+page: show its standard error to the user, unless you stopped it yourself or were starting the review again just\s+then/);
  assert.match(SKILL, /Once the review has ended, as the review command exiting or\s+`duru wait` exiting with code 0 and nothing on standard output tells you, run the same `duru reply` without\s+`--server`/);
  assert.match(SKILL, /If you start the review again, whatever the reason, start `duru wait` again on the address the new review\s+prints, after stopping the earlier `duru wait` if it is still running/);
  assert.doesNotMatch(SKILL, /read its output as it grows/);
});

test('the agent skill says that in Claude Code comments also arrive as session messages and to keep duru wait running, answering each id once', () => {
  assert.match(SKILL, /In Claude Code the review also sends each comment into your session as a message from another session: its first\s+line starts with `duru review comment;`/);
  assert.match(SKILL, /keep `duru wait` running all the same; when the same comment `id` comes both\s+ways, answer it once/);
});

test('the agent skill says how to answer a comment on the open review page and what a reply line is', () => {
  assert.match(SKILL, /`duru reply <config> <the comment's id> "<answer>" --server <the review page address>`/);
  assert.match(SKILL, /on the review's standard error as a\s+`"reply"` line with `replyTo` set to the comment's `id`; it asks for nothing/);
});

test('the agent skill says what a comment on a part of a screen or call carries and what to do for a comment on a test', () => {
  assert.match(SKILL, /`target\.part`/);
  assert.match(SKILL, /`where`[\s\S]*`relation`/);
  assert.match(SKILL, /`"kind": "test"`[\s\S]*read\s+why\s+it\s+failed\s+from\s+that\s+result\s+file[\s\S]*fix\s+the\s+test\s+or\s+the\s+app/);
  assert.match(SKILL, /`imported`, `passed` or\s+`called`[\s\S]*whether the tag may\s+be\s+added[\s\S]*add it only when the\s+comment asks/);
  assert.match(SKILL, /`comments on tests`/);
});

test('the agent skill says what a comment on an opening condition or an incoming link carries and what to do for it', () => {
  assert.match(SKILL, /`"kind": "condition"`[\s\S]*`role:<role>`[\s\S]*`setting:<path>=on`[\s\S]*`places`/);
  assert.match(SKILL, /`"kind": "link"`[\s\S]*`from`[\s\S]*`conditions`[\s\S]*`guards`/);
  assert.match(SKILL, /read\s+(?:the|that)\s+line[\s\S]*duru\s+defect[\s\S]*answer\s+with\s+(?:the|that)\s+line/);
  assert.match(SKILL, /`comments on opening conditions`[\s\S]*`comments on incoming links`/);
});

test('the agent skill says what a comment on a step or on the link between two steps of a story carries and what to do for it', () => {
  assert.match(SKILL, /`"kind": "step"`[\s\S]*`step`[\s\S]*`screen`[\s\S]*`componentFile`[\s\S]*story's test/);
  assert.match(SKILL, /`"kind": "hop"`[\s\S]*`from` and `to`[\s\S]*`verdict`[\s\S]*`preconditions`[\s\S]*duru defect/);
  assert.match(SKILL, /`comments on steps` and\s+`comments on links between steps`/);
});

test('the agent skill says how to read the needs and expects a person wrote for a story and its steps in the task list', () => {
  assert.match(SKILL, /`needs` before `screens`[\s\S]*a `need` line under a step[\s\S]*an `expect` line under a step[\s\S]*`expects at the end`/);
  assert.match(SKILL, /Set up each need[\s\S]*check each expect[\s\S]*tell the user which one/);
});

test('the agent skill says how to read the conditions a person wrote for the link into a step in the task list', () => {
  assert.match(SKILL, /a `link need from step N` line\s+under a step what has to hold on the link from step N, the step before/);
  assert.match(SKILL, /make the test take the link a\s+`link need from step N` line names/);
});

test('the agent skill says how to read the inputs a person wrote for a step in the task list and what to do when the test cannot find the box', () => {
  assert.match(SKILL, /An `input` line under a step names a box to fill at that step and the value to put in it/);
  assert.match(SKILL, /`placeholder`[\s\S]*`label`[\s\S]*`testId`, several joined by `and`\s+for a box that has all of them, with `number N` when it is the Nth of the elements that have them all/);
  assert.match(SKILL, /Find the box in the test by those words as they are, all of them, each matched exactly/);
  assert.match(SKILL, /cannot find the box by all the words, try each word alone, and when it still cannot, tell the user which input\s+it is/);
});

test('the agent skill says what the fill line under an input of one story is and what to do when it finds no box', () => {
  assert.match(SKILL, /under an `input` line, `fill`, the Playwright\s+code that finds the box with all its words[\s\S]*which duru did not try on\s+the screen: use it as it is, and when it finds no box, try each word alone/);
});

test('the agent skill says how to read a need file a story picks in the task list, and what to do when the file is missing or could not be read', () => {
  assert.match(SKILL, /`<name> \(needs\/<file>\): <text>`[\s\S]*set it up from its text, and the same way in every story test/);
  assert.match(SKILL, /on a `link need from step N` line, set it up before step N so the test can take that link/);
  assert.match(SKILL, /`needs\/<file> — the file is missing` or `— the file could not be read`[\s\S]*tell the user which one rather than guess/);
});

test('the agent skill says what a comment on a screen order carries and that it is answered with a candidate posted by duru candidate for the gaps picked, keeping what the reviewer typed and filling only empty fields, then a reply, or a reply alone when no way joins them, never writing a story or a candidate file', () => {
  assert.match(SKILL, /`\{ "screens": \[ … \] \}`[\s\S]*`gaps`[\s\S]*`steps`[\s\S]*`componentFile`[\s\S]*`links`[\s\S]*`verdict`/);
  assert.match(SKILL, /Follow the links of the\s+map[\s\S]*with `gaps`, fill only those\s+gaps[\s\S]*Keep what the reviewer typed in\s+`steps`[\s\S]*fill in only the fields left\s+empty/);
  assert.match(SKILL, /`duru candidate <config> <the comment's id> - --server <the review page address>`[\s\S]*`reason`[\s\S]*Then answer the comment with `duru reply`/);
  assert.match(SKILL, /If no way joins two of them, post no candidate and say so in the\s+reply/);
  assert.match(SKILL, /Never write a story file or a candidate file yourself/);
});

test('the agent skill says what a comment on a story candidate carries and that it is answered from the record or the test, outside the task list', () => {
  assert.match(SKILL, /`\{ "candidate": "<key>" \}`/);
  assert.match(SKILL, /`\{ "record", "steps" \}` with `stepRanges`[\s\S]*`\{ "report", "tests" \}`/);
  assert.match(SKILL, /answer why that order came out,\s+citing the record and the steps behind each screen, or the test by its title/);
  assert.match(SKILL, /never appears in the task list/);
});

test('the agent skill says what a comment on several targets or none carries, that it is answered once, and where the task list puts it', () => {
  assert.match(SKILL, /several targets or on none[\s\S]*`targets`[\s\S]*`wheres`[\s\S]*Answer it once/);
  assert.match(SKILL, /empty `targets`[\s\S]*answer from the map, the task list and the tests/);
  assert.match(SKILL, /`left on N targets:`[\s\S]*`# Comments with no target`/);
});

test('the agent skill says how to read the account and setting lines under the preconditions of one story', () => {
  assert.match(SKILL, /an `accounts` or `role` line[\s\S]*pick one of these accounts yourself[\s\S]*duru never prints a\s+password/);
  assert.match(SKILL, /A `setting` line speaks for one setting, not for the whole\s+guard[\s\S]*`deployed settings not\s+checked`[\s\S]*check the setting in the app before trusting the line[\s\S]*`setting not read`/);
});

test('the agent skill says an agent\'s not-needed waits under review, how undecided and the task list count it, that it may go over a person\'s mark, and that after a revert only a person decides', () => {
  assert.match(SKILL, /A `not-needed` you write does not take the candidate out: it waits\s+under review until a reviewer accepts or reverts it on the review page/);
  assert.match(SKILL, /You may write `not-needed` on a candidate a person\s+already decided[\s\S]*the person's mark holds while it waits/);
  assert.match(SKILL, /`needed` over a\s+person's mark, also while your `not-needed` waits on top of it, anything where a reviewer\s+reverted your\s+`not-needed`/);
  assert.match(SKILL, /Candidates under\s+review are not undecided[\s\S]*`, N under review`[\s\S]*exits with 0 when only those are\s+left; in the task list they are under `under review`/);
  assert.match(SKILL, /`\| under review N`/);
});

test('the agent skill says how to read the rebuild regression lines, not to fit a test to the current result for a regression alone, what to do for an item listed for comments on regressed tests and for a comment whose where carries passedIn, that such a list starts with the regression sentence without No open marks, and to tell the user when baselineTests could not be read', () => {
  const flat = SKILL.replace(/\s+/g, ' ');
  assert.match(flat, /`test results since <folder> \| …` line, and under it `pass→fail ←`, `pass→pending ←` and `only in baseline ←` lines or a `no test was compared` line, [^.]*; they ask nothing of you/);
  assert.match(flat, /Do not change a test to match the current result only because it regressed/);
  assert.match(flat, /A run that stops with a line starting with `baselineTests` names results that are missing, unreadable or hold no test: tell the user/);
  assert.match(flat, /When `where` also carries `passedIn`[^:]*: do not write a new test for it; fix the app or the test as the comment says/);
  assert.match(flat, /with `, passed in <folder>` right after its result file is such a regressed test, and an item whose marks line reads `marks: none, listed for comments on regressed tests`[^:]*: write no new test for them; fix the app or the test as each comment says, run the tests and `duru rebuild`, and read the list again/);
  assert.match(flat, /`N commented regressions`[^;]*; with no open mark it starts with that instead of `No open marks\.`, so do not stop there/);
  assert.match(flat, /`baselineTests <path> could not be read: <why>; screens and calls a reviewer sent by commenting on a regressed test are not listed`, means [^:]*: tell the user/);
  assert.match(flat, /One listed only for comments on regressed tests also leaves once those tests pass again after a `rebuild`/);
});
