# duru verifier

A fresh agent that did not write the code judges one commit of duru. Nobody tells it what the author thinks the
change does. The comparison it runs builds a private client's map, so its results stay on the PC that ran it.

## How to start one

Spawn a new subagent (`general-purpose`, in the background) with exactly this prompt, filling in the five values and
adding nothing else — no summary of the change, no pull request number, no review notes:

```
Follow docs/verifier.md in <checkout>, section "Instructions for the verifier".
commit: <full head SHA>
base: <the pull request's base branch as origin/<name>, or the full SHA of the commit it should be compared with>
issue: <issue number in duru-app/duru>
scratch: <a new empty folder in the caller's scratchpad>
```

`<checkout>` is a clone of duru with this file, normally `~/duru`.

Default: one verifier. A new feature from a PRD issue gets three on its first pull request, each started the same
way, and the caller counts a block from any of them. One run measured about 8 minutes and 145,000 tokens.

## After the report

The report is a claim until the caller has run it. Before acting on a block, run the command it quotes. On a stacked
pull request, also run it at the top of the stack: a problem fixed higher up does not hold this pull request as long
as the stack lands together, and a problem still there at the top is reported to whoever owns the stack. Whether a
block changes the code or the document is the driver's decision when the issue does not settle it.

## Instructions for the verifier

You did not write this code. Judge it only from the commit, the issue and what you run. Report in English.

Rules:

- Read the issue with `gh issue view <n> --repo duru-app/duru --json title,body`. Do not read the pull request's
  body, its comments, its review history, or the issue's comments: they carry the author's account of the change.
- Change nothing outside `scratch` and `~/duru-verify-out/compare/`. No commits, no pushes, no comments or labels on
  GitHub, no edits to any existing checkout. Other sessions may be working in other checkouts on this PC.
- Nothing you found goes to GitHub. The comparison results name a private client; they stay on this PC.

Steps:

1. Unpack the commit and the commit it branched from:
   ```
   cd <checkout> && git fetch origin --quiet
   git archive <commit> | tar -x -C <scratch>/head
   git merge-base <base> <commit>
   ```
   Then `npm ci` in `<scratch>/head`. Create `<scratch>/head` first. Read the change with
   `git diff <merge-base> <commit>`.
2. In `<scratch>/head`, run the type checks: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.browser-tests.json`.
3. In the same folder, run the tests the change touches, keeping the output in a file:
   `node --test test/<file>.test.ts > <scratch>/tests.log 2>&1`. Take every test file the diff changes, and the
   test files that name a changed source file. If `README.md`, `skills/duru/SKILL.md` or `docs/decisions.md` changed,
   run the tests that name it (`grep -l` over `test/*.test.ts`). If `src/review-page/` changed, also run
   `test/review-page-types.test.ts`. Do not run the whole suite; the merge queue does. A test that cannot start
   because Chromium is missing is reported as not run, never as passed.
4. If the diff changes anything under `src/`, run the comparison:
   `node <checkout>/scripts/compare-maps.mjs <commit> --base <base>`. Exit 0 means no difference, 3 means a
   difference, 1 means it could not run, 2 means it was started wrongly or the client config is missing. Read
   `report.txt` and, for anything it lists, `output.diff` and `json-details.txt` in the folder it names. If only
   `src/review-page/` changed, skip it and say so.
5. For each item in the issue's acceptance criteria, find what shows it: a test you ran, a line of the comparison, or
   a line of the diff. Mark each one shown, not shown, or a human step (for example the driver looking at a screen).
6. Judge the comparison against the issue: does every difference follow from what the issue asks for, and does
   anything the issue asks for fail to appear where this client has the shape it describes? A difference on the map
   the issue does not explain is a finding. No difference is not itself a finding: this client may not have the shape.

What blocks the merge — only a problem you can show:

- a run that fails at this commit (type check, test, comparison exit 1 or 2), with the command and the output;
- a document line this change made wrong, quoting the line and showing the behaviour that contradicts it;
- a difference in the comparison that contradicts the issue, or an acceptance criterion that a run shows is not met.

A problem the base already has does not block unless this change copies it or newly reaches it: check by running the
same thing at the merge-base. Everything else — style, naming, a test you would have added, an unshown criterion with
no failing run — is a follow-up, not a block.

Final report, in this order:

```
verdict: PASS | BLOCK
commit: <sha>
ran: <each command, with its result; what did not run, and why>
comparison: <result line, the changes-since counts, and which differences the issue explains>
criteria: <each acceptance criterion: shown by what / not shown / human step>
blocks: <each with the command and output, or the quoted line; "none" if none>
follow-ups: <one line each; "none" if none>
```
