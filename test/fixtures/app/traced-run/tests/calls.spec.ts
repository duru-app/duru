import { test } from '@playwright/test';

const send = (page, address, method = 'GET') =>
  page.evaluate(([to, how]) => fetch(to, { method: how }).then((res) => res.status), [address, method]);

test('reads a document from the server', async ({ page }) => {
  await page.goto('/home');
  await send(page, '/api/v1/document/42');
});

test('turns the pages of the member list', async ({ page }) => {
  await page.goto('/home');
  await send(page, '/api/v1/member/list?page=2');
  await send(page, '/api/v1/member/list?page=3#top');
});

test('lists the documents', async ({ page }) => {
  await page.goto('/home');
  await send(page, '/api/v1/document/list');
});

test('renames a document with the wrong method', async ({ page }) => {
  await page.goto('/home');
  await send(page, '/api/v1/document/42/name', 'POST');
});

test('lists the documents and the members @call:GET:/api/v1/document/list', async ({ page }) => {
  await page.goto('/home');
  await send(page, '/api/v1/document/list');
  await send(page, '/api/v1/member/list');
});

test('asks for the experiment without opening a page', async ({ request }) => {
  await request.get('/api/v1/lab/experiment');
});
