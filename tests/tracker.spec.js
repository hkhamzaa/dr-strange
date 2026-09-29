// The hand tracker must never hang on "Loading hand tracker…": a bad or slow asset ends in a clear
// on-screen error naming the URL, a console log of it, and a Retry that works once the asset is fixed.
import { test, expect } from '@playwright/test';
import { fakeCamera } from './helpers.js';

const MODEL = '**/vendor/models/hand_landmarker.task';

test('a truncated model (200 + a few bytes) fails fast, names the URL, and Retry recovers', async ({ page }) => {
  test.setTimeout(180_000);
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  await fakeCamera(page);
  await page.route(MODEL, (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'Not Found' }));

  await page.goto('/?autostart=1&dpr=1');
  await page.waitForFunction(() => window.sigilApp);
  await expect(page.locator('#bRetryCam')).toBeVisible({ timeout: 60_000 });

  const msg = await page.locator('#startMsg').textContent();
  expect(msg).toContain('hand tracker');
  expect(msg).toContain('hand_landmarker.task');
  expect(msg).toMatch(/only \d+ bytes/);
  expect(await page.locator('#start').isVisible()).toBe(true);
  expect(logs.join('\n')).toContain('failing URL');
  expect(logs.join('\n')).toContain('hand_landmarker.task');

  // fix the asset, press Retry: the tracker comes up and the start screen closes
  await page.unroute(MODEL);
  await page.locator('#bRetryCam').click();
  await page.waitForFunction(() => window.sigilApp.status().camera?.running, null, { timeout: 90_000 });
  await expect(page.locator('#start')).toBeHidden();
});

test('a model that never arrives times out (not a forever spinner) with the URL in the message', async ({ page }) => {
  test.setTimeout(120_000);
  await fakeCamera(page);
  await page.route(MODEL, () => { /* never answered */ });
  const t0 = Date.now();
  await page.goto('/?autostart=1&dpr=1&loadtimeout=3');
  await page.waitForFunction(() => window.sigilApp);
  await expect(page.locator('#bRetryCam')).toBeVisible({ timeout: 60_000 });
  const msg = await page.locator('#startMsg').textContent();
  expect(msg).toContain("didn't load within 3 s");
  expect(msg).toContain('hand_landmarker.task');
  expect(Date.now() - t0).toBeLessThan(60_000);
});
