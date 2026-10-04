import { test } from '@playwright/test';

test.use({ trace: { mode: 'on', screenshots: false, sources: false, snapshots: false } });

test('presses the button without snapshots', async ({ page }) => {
  await page.goto('/home');
  await page.click('#press');
});
