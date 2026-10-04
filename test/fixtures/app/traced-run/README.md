The reports and trace files in `../results/playwright-traced` come from running these tests against the
fake app in `../build` with Playwright 1.60.0 (trace format version 8).

To make them again, copy this folder and `../build` side by side, add a `package.json` to the copy, install
`@playwright/test` at the version you want to cover, run `npx playwright test`, then put `report.json` in
place of `visits.json` and copy `test-results/*/trace.zip` over. `visits.json` is that report trimmed, with
its attachment paths pointing at a folder that does not exist (`/builds/app/test-results/...`), the way a
report looks after the results were moved.
