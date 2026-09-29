// ?nocam=1 must boot straight into the idle, casting sigil with no camera and no permission prompt —
// used for visual tuning, and here to assert the center of the screen actually lights up.
import { test, expect } from '@playwright/test';
import { watchErrors, shot } from './helpers.js';

test('nocam boot: idle sigil casts and lights the centre of the screen', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/?manual=1&nocam=1&dpr=1');
  await page.waitForFunction(() => window.sigilApp);
  await page.evaluate(async () => { await window.sigilApp.advance(1.6); });   // let cast() finish its 1.2s sweep

  const px = await page.evaluate(() => window.sigilApp.centerPixel());
  expect(px[0] + px[1] + px[2]).toBeGreaterThan(20);      // not black: the core/heart glow is lit

  const s = await page.evaluate(() => window.sigilApp.status());
  expect(s.sigil.casting).toBe(false);
  expect(s.sigil.components.heart.reveal).toBeGreaterThan(0.9);
  expect(await page.locator('#start').isHidden()).toBe(true);

  await shot(page, 'boot-nocam-idle-sigil');
  noErrors();
});
