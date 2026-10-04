import { test, expect } from '@playwright/test';

test('opens home and then help', async ({ page }) => {
  await page.goto('/home');
  await page.goto('/help');
});

test('presses the button on home', async ({ page }) => {
  await page.goto('/home?tab=recent');
  await Promise.all([page.waitForResponse('**/api/v1/press'), page.click('#press')]);
});

test('checks the path of a document', async ({ page }) => {
  await page.goto('/document/42?mode=edit#participants');
  await expect(page.locator('#path')).toHaveText('/document/42');
});

test('moves to the drafts without loading a page', async ({ page }) => {
  await page.goto('/home');
  await page.evaluate(() => history.pushState({}, '', '/document/draft'));
  await expect(page).toHaveURL(/\/document\/draft$/);
});

test('wanders off the map', async ({ page }) => {
  await page.goto('/nowhere');
  await page.click('#press');
});

test('home shows its path @screen:/home#Home', async ({ page }) => {
  await page.goto('/home');
  await expect(page.locator('#path')).toHaveText('/home');
});

test('follows a link while waiting for the new address', async ({ page }) => {
  await page.goto('/home');
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'to-help';
    link.href = '/help';
    link.textContent = 'help';
    document.body.append(link);
  });
  await Promise.all([page.waitForURL('**/help'), page.click('#to-help')]);
  await expect(page.locator('#path')).toHaveText('/help');
});

test('hovers and uses the keyboard on help', async ({ page }) => {
  await page.goto('/help');
  await page.hover('#press');
  await page.keyboard.press('Tab');
});

test('clicks on a blank page after leaving home', async ({ page }) => {
  await page.goto('/home');
  await page.goto('about:blank');
  await page.setContent('<button id="blank">blank</button>');
  await page.click('#blank');
});

test('uses the mouse right after the address changes', async ({ page }) => {
  await page.goto('/home');
  await page.evaluate(() => {
    setTimeout(() => history.pushState({}, '', '/help'), 100);
  });
  await page.waitForURL('**/help');
  await page.mouse.click(35, 99);
});

test('checks a text that appears after the address changes', async ({ page }) => {
  await page.goto('/home');
  await page.evaluate(() => {
    setTimeout(() => {
      history.pushState({}, '', '/document/draft');
      document.getElementById('path').textContent = '/document/draft';
    }, 300);
  });
  await expect(page.locator('#path')).toHaveText('/document/draft');
});

test('clicks a button that appears after the address changes', async ({ page }) => {
  await page.goto('/home');
  await page.evaluate(() => {
    setTimeout(() => {
      history.replaceState({}, '', '/help');
      const late = document.createElement('button');
      late.id = 'late';
      late.textContent = 'late';
      document.body.append(late);
    }, 300);
  });
  await page.click('#late');
});

test('gives up on a button and on a text that are not there', async ({ page }) => {
  await page.goto('/home');
  await page.click('#cookie-accept', { timeout: 300 }).catch(() => {});
  await expect(page.locator('#nope')).toBeVisible({ timeout: 300 }).catch(() => {});
});

test('calls the server without opening a page', async ({ page, request }) => {
  await page.route('**/nothing', (route) => route.abort());
  await request.post('/api/v1/press');
});

test('opens the app from a file', async ({ page }) => {
  await page.goto(new URL('../../build/index.html', import.meta.url).href);
  await page.click('#press');
});

test('moves the mouse and turns the wheel on help', async ({ page }) => {
  await page.goto('/help');
  await page.mouse.move(35, 99);
  await page.mouse.wheel(0, 50);
});

test('types into a field and submits with the keyboard', async ({ page }) => {
  await page.goto('/home');
  await page.evaluate(() => {
    const field = document.createElement('input');
    field.id = 'name';
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') history.pushState({}, '', '/document/draft');
    });
    document.body.append(field);
  });
  await page.fill('#name', 'draft');
  await page.press('#name', 'Enter');
  await page.keyboard.press('Tab');
});

test('gives up on a button that is covered', async ({ page }) => {
  await page.goto('/home');
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.style.cssText = 'position:fixed;inset:0;background:white';
    document.body.append(cover);
  });
  await page.click('#press', { timeout: 500 }).catch(() => {});
});

test('checks a box that refuses to change', async ({ page }) => {
  await page.goto('/home');
  await page.evaluate(() => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'box';
    box.addEventListener('click', (event) => event.preventDefault());
    document.body.append(box);
  });
  await page.check('#box').catch(() => {});
});

test('runs out of time while typing slowly', async ({ page }) => {
  await page.goto('/home');
  await page.evaluate(() => {
    const field = document.createElement('input');
    field.id = 'name';
    document.body.append(field);
  });
  await page.locator('#name').pressSequentially('abcdefghij', { delay: 100, timeout: 500 }).catch(() => {});
});

test('gives up on a field that is switched off', async ({ page }) => {
  await page.goto('/home');
  await page.evaluate(() => {
    const field = document.createElement('input');
    field.id = 'name';
    field.disabled = true;
    document.body.append(field);
  });
  await page.fill('#name', 'draft', { timeout: 500 }).catch(() => {});
});
