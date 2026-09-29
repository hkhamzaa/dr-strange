// Calibration never blocks: the app casts the moment a hand shows up, and silently adapts the
// openness range to what the user's hand actually does. ?recalibrate=1 resets the adapted profile.
import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

test('no setup step: a fresh profile-less start casts as soon as a hand is in view', async ({ page }) => {
  await page.goto('/?manual=1&recalibrate=1');
  await page.waitForFunction(() => window.sigilApp);
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    W.advance(0.1, () => W.synth({ pose: 'open' }));
    return { state: W.status().state, panels: document.body.innerText.includes('Calibration') };
  });
  expect(r.state).toBe('casting');
  expect(r.panels).toBe(false);
});

test('auto-adapt: a hand that only half-closes and half-opens still spans the full size range', async ({ page }) => {
  await page.goto('/?manual=1&recalibrate=1');
  await page.waitForFunction(() => window.sigilApp);
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    const { openness } = await import('/src/input/gestures.js');
    // f 0.4 .. 0.65 reads as openness ~0.33 .. ~0.77: a hand that never fully closes or opens
    const lo = openness(W.synth({ pose: 'partial', f: 0.4 })), hi = openness(W.synth({ pose: 'partial', f: 0.65 }));
    const before = { ...W.status().calib };
    W.advance(12, (t) => W.synth({ pose: 'partial', f: 0.525 + 0.125 * Math.sin(t * 3) }));
    const after = W.status().calib;
    W.advance(0.8, () => W.synth({ pose: 'partial', f: 0.65 }));
    const topSize = W.status().sigilScale;
    W.advance(0.8, () => W.synth({ pose: 'partial', f: 0.4 }));
    const bottomSize = W.status().sigilScale;
    W.app.calib.save(W.app.t);
    return { lo, hi, before, after, topSize, bottomSize, stored: localStorage.getItem('sigil.calib.v2'), presets: W.CFG.sizePresets };
  });
  expect(r.after.fist).toBeGreaterThan(r.before.fist + 0.1);        // bounds moved in toward what the hand really does
  expect(r.after.open).toBeLessThan(r.before.open - 0.05);
  expect(r.topSize).toBeGreaterThan(r.presets.full - 0.12);         // its widest shape now reads as (nearly) full size
  expect(r.bottomSize).toBeLessThan(r.presets.smol + 0.2);          // and its tightest as (nearly) smallest
  expect(r.stored).toBeTruthy();
});

test('the adapted profile persists across reloads, and ?recalibrate=1 resets it', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('sigil.calib.v2', JSON.stringify({ opennessFist: 0.3, opennessOpen: 0.7, scaleRef: 0.2 })));
  await page.goto('/?manual=1');
  await page.waitForFunction(() => window.sigilApp);
  const kept = await page.evaluate(() => window.sigilApp.status().calib);
  await page.goto('/?manual=1&recalibrate=1');
  await page.waitForFunction(() => window.sigilApp);
  const reset = await page.evaluate(() => ({ calib: window.sigilApp.status().calib, stored: localStorage.getItem('sigil.calib.v2') }));
  expect(kept.fist).toBeCloseTo(0.3, 3);
  expect(kept.open).toBeCloseTo(0.7, 3);
  expect(reset.stored).toBeNull();
  expect(reset.calib.fist).toBeCloseTo(0.05, 3);
  expect(reset.calib.open).toBeCloseTo(0.95, 3);
});

test('distance tolerance: pose and openness are unaffected by hand scale (0.6x and 1.6x)', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const G = await import('/src/input/gestures.js');
    const { hand } = await import('/src/input/synth.js');
    const out = {};
    for (const s of [0.06, 0.1, 0.16]) {
      out[s] = ['open', 'fist', 'three'].map((pose) => G.classify(hand({ pose, s })));
      out[`${s}o`] = G.openness(hand({ pose: 'partial', f: 0.5, s }));
    }
    return out;
  });
  expect(r['0.06']).toEqual(['open', 'fist', 'three']);
  expect(r['0.16']).toEqual(['open', 'fist', 'three']);
  expect(Math.abs(r['0.06o'] - r['0.1o'])).toBeLessThan(1e-6);
  expect(Math.abs(r['0.16o'] - r['0.1o'])).toBeLessThan(1e-6);
});
