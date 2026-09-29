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

/** A deterministic stand-in for getUserMedia: an animated 1280x720 canvas stream. Chrome's own fake
 *  capture device can only be opened reliably once per browser process (later opens fail with
 *  NotFoundError / "in use"), which makes any test that (re)starts the camera flaky. */
export async function fakeCamera(page) {
  await page.addInitScript(() => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const g = c.getContext('2d'); let n = 0;
    const draw = () => { g.fillStyle = '#3a6b4a'; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#e8d9a8'; g.fillRect((n * 7) % 1200, 300, 80, 80); n++; };
    draw(); setInterval(draw, 33);
    navigator.mediaDevices.getUserMedia = async () => c.captureStream(30);
  });
}
