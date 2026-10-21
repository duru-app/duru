# duru

## Where things are written

- `README.md` is for people who install and run duru: what it does, how to set it up, each config key, each
  command, and what each line it prints means for the map. It does not say how each source shape is judged,
  and it does not tell the history of a change.
- Which source shape gives which result is fixed by the tests under `test/`.
- Why a choice was made, and what it was compared with, goes in `docs/decisions.md`.
- `skills/duru/SKILL.md` is for an agent that runs duru: what to run and how to read what comes out.
- When README and the code disagree on how a shape is judged, take the rule out of README instead of adding
  the shape to it.

## Running the tests

- CI runs the whole suite (`npm test`) on every pull request except one that changes only `CLAUDE.md`.
- Locally, run the two type checks and only the tests the change touches, by file and name:
  `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.browser-tests.json`, then
  `node --test --test-name-pattern="<part of the test name>" test/<file>.test.ts`. `node --test` alone does not
  check types.
- After changing a file in `src/review-page/` or the data the review server sends, run
  `node --test test/review-page-types.test.ts`: the page is JavaScript checked from its type comments, and `tsc`
  does not read it.
- `README.md`, `skills/duru/SKILL.md` and `docs/decisions.md` are read by tests. After changing one, run the
  tests that name it, with the changed file's name in the pattern:
  `node --test $(grep -l 'README\.md' test/*.test.ts)`, `'SKILL\.md'` or `'decisions\.md'`.
- Tests that open a browser need Chromium and the system libraries it loads, installed once on the machine:
  `npx playwright-core install --with-deps chromium` (the libraries are installed with `sudo`).

## Writing the review page

- The data from `/api/data` has the type `PageData` in `src/review.ts`. Give a new field the server sends a type
  there, not a cast in the page.
- A field repeated in a list or a table gets a `name` that stays the same for its row when rows are added or
  removed. The page redraws while a reviewer types and puts the focus back in a field that looks the same, so fields
  that look alike lose the focus as soon as the number of rows changes.
- A button, tab, count or chip on the page is named with one or two words or an icon, not a phrase: 「새 3」, not
  「그중 새로 3」 or 「새로 생긴 것 3」; ✓ and ✕, not 「받아들이기 (2)」. What it means goes in `title` and `aria-label`.
- A picture that asks the driver to choose between ways of drawing a part of the page crops that part only and puts the
  options side by side, so the difference shows at a glance.
