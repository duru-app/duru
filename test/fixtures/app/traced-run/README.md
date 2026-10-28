The reports and trace files in `../results/playwright-traced` come from running these tests against the
fake app in `../build` with Playwright 1.60.0 (trace format version 8).

To make them again, copy this folder and `../build` side by side, add a `package.json` to the copy, install
`@playwright/test` at the version you want to cover, run `npx playwright test`, then put `report.json` in
place of `visits.json` and copy `test-results/*/trace.zip` over. `visits.json` is that report trimmed, with
its attachment paths pointing at a folder that does not exist (`/builds/app/test-results/...`), the way a
report looks after the results were moved. `calls.json` is the report of `tests/calls.spec.ts` alone
(`npx playwright test calls.spec.ts`), trimmed the same way; keep that spec out of the run for `visits.json`.

`../traces/inputs.zip` is not from these tests. It is one page recorded with `playwright-core` 1.60.0
(`context.tracing.start({ snapshots: true })`, a page served by `page.route`) on which a test fills, types into,
selects in, checks and clicks boxes found by label, placeholder, test ID, CSS and role. To make it again, record
the same calls and put the zip there.

`../results/playwright-steps/report.json` is written by hand, not by Playwright. Its tests point at copies of traces
from this folder and of `../traces/inputs.zip`, put under `test-results/` with the folder names the report gives, and
are tagged with the home screen so the review page lists them there. One test runs in two projects with different
traces, one runs without a trace, one has a trace recorded without snapshots in one project and runs without a trace in
another, and one is skipped.
