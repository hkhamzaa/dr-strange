// The single-hand map: presence casts/uncasts, openness sizes, roll rotates, the three-finger pose
// splits. Synthetic hands go through the real Controller -> GestureMapper -> bus -> Sigil path.
import { test, expect } from '@playwright/test';
import { openApp, watchErrors } from './helpers.js';

test.beforeEach(async ({ page }) => { await openApp(page); });

test('hand appears -> casts immediately on the palm; hand lost -> uncasts after the grace period', async ({ page }) => {
  const noErrors = watchErrors(page);
  const r = await page.evaluate(async () => {
    const W = window.sigilApp, out = {};
    out.start = W.status().state;
    W.advance(0.1, () => W.synth({ pose: 'open', cx: 0.3, cy: 0.5 }));
    out.after100ms = { state: W.status().state, x: W.status().sigilPos[0] };
    W.advance(1.0);
    out.settled = W.status().state;
    W.advance(0.35, null);
    out.inGrace = W.status().state;                           // still there: a 0.35s dropout is survivable
    W.advance(0.3, () => W.synth({ pose: 'open', cx: 0.3, cy: 0.5 }));
    out.backFromDropout = W.status().state;
    W.advance(0.6, null);
    out.afterGrace = W.status().state;                       // 0.6s > 0.5s grace: dismissing
    W.advance(0.5, null);
    out.gone = W.status().state;
    return out;
  });
  expect(r.start).toBe('dormant');
  expect(r.after100ms.state).toBe('casting');
  expect(r.after100ms.x).toBeLessThan(-0.3);                 // cast in on the left-hand palm, not the centre
  expect(r.settled).toBe('active');
  expect(r.inGrace).toBe('active');
  expect(r.backFromDropout).toBe('active');
  expect(r.afterGrace).toBe('dismissing');
  expect(r.gone).toBe('dormant');
  noErrors();
});

test('openness drives size monotonically; a fist gives the smallest (smol) size', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    W.advance(1.2, () => W.synth({ pose: 'fist' }));
    const fist = W.status().sigilScale;
    const sizes = [];
    for (const f of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      W.advance(0.6, () => W.synth({ pose: 'partial', f }));
      sizes.push(W.status().sigilScale);
    }
    return { fist, sizes, presets: W.CFG.sizePresets };
  });
  expect(Math.abs(r.fist - r.presets.smol)).toBeLessThan(0.02);
  // non-decreasing (the first steps of a curling hand all still read as a fist), strictly rising overall
  for (let i = 1; i < r.sizes.length; i++) expect(r.sizes[i]).toBeGreaterThanOrEqual(r.sizes[i - 1] - 1e-4);
  expect(r.sizes[2]).toBeGreaterThan(r.sizes[0] + 0.05);
  expect(Math.abs(r.sizes[r.sizes.length - 1] - r.presets.full)).toBeLessThan(0.03);
  const half = r.sizes[3];                                   // f = 0.6: somewhere strictly in between
  expect(half).toBeGreaterThan(r.presets.smol + 0.1);
  expect(half).toBeLessThan(r.presets.full - 0.1);
});

test('hand roll drives the sigil rotation one to one (screen direction preserved)', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp, out = [];
    for (const angle of [0.5, -0.8, 1.3]) {
      W.advance(0.8, () => W.synth({ pose: 'open', angle }));
      out.push({ angle, roll: W.status().sigilRoll, handRoll: W.status().roll });
    }
    return out;
  });
  for (const { angle, roll, handRoll } of r) {
    expect(Math.abs(handRoll - angle)).toBeLessThan(0.02);
    expect(Math.abs(roll + angle)).toBeLessThan(0.03);       // image clockwise = three.js negative z
  }
});

test('three-finger pose splits the sigil, holding keeps it split, releasing regroups in ~0.6s', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp, out = {};
    W.advance(1.2, () => W.synth({ pose: 'open' }));
    out.sizeBefore = W.status().sigilScale;
    W.advance(0.1, () => W.synth({ pose: 'three' }));
    out.beforeDwell = W.status().sigil.exploded;            // 0.1s < 0.15s dwell: not yet
    W.advance(0.3);
    out.split = W.status().sigil.exploded;
    W.advance(1.5);
    out.held = W.status().sigil.exploded;
    out.sizeDuring = W.status().sigilScale;                  // frozen, not shrunk toward the three-finger openness
    W.advance(0.2, () => W.synth({ pose: 'open' }));
    out.released = W.status().sigil.exploded;
    W.advance(0.6);
    out.heartScale = W.part('heart').scale;                  // 1 = assembled
    return out;
  });
  expect(r.beforeDwell).toBe(0);
  expect(r.split).toBe(1);
  expect(r.held).toBe(1);
  expect(Math.abs(r.sizeDuring - r.sizeBefore)).toBeLessThan(0.03);
  expect(r.released).toBe(0);
  expect(Math.abs(r.heartScale - 1)).toBeLessThan(0.08);
});

test('jitter: noisy landmarks never flicker the split on or off', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    const { on } = await import('/src/bus/bus.js');
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const noisy = (pose) => () => W.synth({ pose, s: 0.1 }).map(([x, y]) => [x + rnd() * 0.012, y + rnd() * 0.012]);
    const amounts = [];
    on('explode', (p) => { if ((p.sigil ?? 'A') === 'A') amounts.push(p.amount); });
    W.advance(1.2, noisy('open'));
    const openFlips = amounts.length;
    W.advance(2.0, noisy('three'));
    const threeFlips = amounts.slice(openFlips);
    const heldSplit = W.status().sigil.exploded;
    W.advance(1.0, noisy('peace'));
    return { openFlips, threeFlips, heldSplit, after: amounts.slice(openFlips + threeFlips.length) };
  });
  expect(r.openFlips).toBe(0);                  // a jittery open hand never splits
  expect(r.threeFlips).toEqual([1]);            // one split, no on/off/on
  expect(r.heldSplit).toBe(1);
  expect(r.after).toEqual([0]);                 // one regroup when the pose changes to peace
});

test('?nocam=1 still boots straight into a cast sigil with no hand and keeps it', async ({ page }) => {
  await page.goto('/?manual=1&nocam=1');
  await page.waitForFunction(() => window.sigilApp);
  const s = await page.evaluate(async () => { window.sigilApp.advance(3.0); return window.sigilApp.status(); });
  expect(s.state).toBe('active');
  expect(s.sigil.components.heart.reveal).toBeGreaterThan(0.9);
});
