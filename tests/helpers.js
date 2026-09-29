// Shared helpers: open the app with a deterministic clock, watch for console errors, take shots.
import { expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

export const SHOTS = 'screenshots';
mkdirSync(SHOTS, { recursive: true });

export function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return () => expect(errors, errors.join('\n')).toEqual([]);
}

/** Open the app in manual-clock mode (frames only advance through sigilApp.advance()). */
export async function openApp(page, query = '') {
  await page.goto(`/?manual=1&dpr=1&${query}`);
  await page.waitForFunction(() => window.sigilApp);
  await page.evaluate(() => window.sigilApp.advance(1 / 60));
}

export async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

export const status = (page) => page.evaluate(() => window.sigilApp.status());
