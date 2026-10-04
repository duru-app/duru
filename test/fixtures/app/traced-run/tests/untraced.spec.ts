import { test } from '@playwright/test';

test.use({ trace: 'off' });

test('opens help without a trace', async ({ page }) => {
  await page.goto('/help');
});
