// The gesture engine: state machine transitions, and every row of the gesture map, driven with
// synthetic hands exactly the way a real camera frame would be. Nothing here calls a Sigil method
// directly — every assertion reads state that only a correctly-wired intent could have produced.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/?manual=1'); await page.waitForFunction(() => window.sigilApp); });

test('snap toggles DORMANT -> CASTING -> ACTIVE -> DISMISSING -> DORMANT', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    const out = { start: W.status().state };
    const press = () => W.synth({ pose: 'snap_pressed', cx: 0.5, cy: 0.5 });
    const release = () => W.synth({ pose: 'snap_released', cx: 0.5, cy: 0.5 });
    await W.advance(0.14, press); await W.advance(0.2, release);
    out.afterSnap1 = W.status().state;
    await W.advance(1.3, null);
    out.afterCastWait = W.status().state;
    await W.advance(0.14, press); await W.advance(0.2, release);
    out.afterSnap2 = W.status().state;
    await W.advance(1.3, null);
    out.afterDismissWait = W.status().state;
    return out;
  });
  expect(r).toEqual({ start: 'dormant', afterSnap1: 'casting', afterCastWait: 'active', afterSnap2: 'dismissing', afterDismissWait: 'dormant' });
});

test('open palm held 0.5s while DORMANT summons as a fallback', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    const out = {};
    await W.advance(0.35, () => W.synth({ pose: 'open', cx: 0.5, cy: 0.5 }));
    out.beforeHoldDone = W.status().state;                    // debounce settling + partway through the hold
    await W.advance(0.4, () => W.synth({ pose: 'open', cx: 0.5, cy: 0.5 }));
    out.afterHoldDone = W.status().state;
    return out;
  });
  expect(r.beforeHoldDone).toBe('dormant');
  expect(r.afterHoldDone).toBe('casting');
});

test('openness maps continuously to size between smol and full', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    W.forceActive();
    await W.advance(0.1);
    await W.advance(1.8, () => W.synth({ pose: 'fist', cx: 0.5, cy: 0.5 }));
    const smolScale = W.status().sigilScale;
    await W.advance(1.8, () => W.synth({ pose: 'open', cx: 0.5, cy: 0.5 }));
    const fullScale = W.status().sigilScale;
    return { smolScale, fullScale, smolPreset: W.CFG.sizePresets.smol, fullPreset: W.CFG.sizePresets.full };
  });
  expect(r.smolScale).toBeLessThan(r.fullScale);
  expect(Math.abs(r.smolScale - r.smolPreset)).toBeLessThan(0.1);
  expect(Math.abs(r.fullScale - r.fullPreset)).toBeLessThan(0.1);
});

test('pinch + hand-scale change drives explode; releasing eases into regroup', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    W.forceActive();
    await W.advance(0.1);
    await W.advance(0.15, () => W.synth({ pose: 'pinch', cx: 0.5, cy: 0.5, s: 0.085 }));       // arm at a reference scale
    await W.advance(0.6, () => W.synth({ pose: 'pinch', cx: 0.5, cy: 0.5, s: 0.085 * 0.5 }));  // hand "moves back" (shrinks)
    const mid = W.status().sigil.exploded;
    await W.advance(1.0, () => W.synth({ pose: 'open', cx: 0.5, cy: 0.5 }));                   // let go
    const after = W.status().sigil.exploded;
    return { mid, after };
  });
  expect(r.mid).toBeGreaterThan(0.6);
  expect(r.after).toBeLessThan(0.05);
});

test('peace cycles solo through every component in order, then regroups, respecting the cooldown', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    W.forceActive();
    await W.advance(0.1);
    const seen = [];
    for (let i = 0; i < 6; i++) {
      await W.advance(0.3, () => W.synth({ pose: 'peace', cx: 0.5, cy: 0.5 }));
      await W.advance(0.8, () => W.synth({ pose: 'open', cx: 0.5, cy: 0.5 }));   // release + clear the cooldown
      seen.push(W.status().sigil.solo);
    }
    // a peace held continuously past its cooldown must NOT re-trigger without a release in between
    await W.advance(0.3, () => W.synth({ pose: 'peace', cx: 0.5, cy: 0.5 }));
    const first = W.status().sigil.solo;
    await W.advance(1.0, () => W.synth({ pose: 'peace', cx: 0.5, cy: 0.5 }));    // still held, cooldown alone elapses
    const stillHeld = W.status().sigil.solo;
    return { seen, first, stillHeld };
  });
  expect(r.seen).toEqual(['outerSeal', 'tickRing', 'starCore', 'innerSeal', 'heart', null]);
  expect(r.stillHeld).toBe(r.first);     // no release edge -> no second trigger, even once cooldown alone has passed
});

test('jitter: noisy landmarks around a pose boundary do not flip the stable pose more than once', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { Controller } = await import('/src/input/controller.js');
    const { hand } = await import('/src/input/synth.js');
    const c = new Controller();
    const trace = [];
    let t = 0;
    // a short noisy burst flickering between two different poses, too short to satisfy the 4-frame
    // hold either way, followed by a long clean run that should settle exactly once
    const burst = Array.from({ length: 6 }, (_, i) => hand({ pose: i % 2 === 0 ? 'open' : 'fist', cx: 0.5, cy: 0.5 }));
    const settle = Array.from({ length: 20 }, () => hand({ pose: 'open', cx: 0.5, cy: 0.5 }));
    for (const lm of [...burst, ...settle]) { c.onHand(lm, t); t += 1 / 30; trace.push(c.pose); }
    const transitions = trace.reduce((n, p, i) => n + (i > 0 && p !== trace[i - 1] ? 1 : 0), 0);
    return { trace, transitions, final: trace[trace.length - 1] };
  });
  expect(r.final).toBe('open');
  expect(r.transitions).toBe(1);     // exactly the one clean none -> open transition, no flicker from the burst
});

test('keeps Phase 1 boot behaviour: ?nocam=1 still forces ACTIVE and casts with no gesture', async ({ page }) => {
  await page.goto('/?manual=1&nocam=1');
  await page.waitForFunction(() => window.sigilApp);
  await page.evaluate(async () => { await window.sigilApp.advance(1.6); });
  const s = await page.evaluate(() => window.sigilApp.status());
  expect(s.state).toBe('active');
  expect(s.sigil.components.heart.reveal).toBeGreaterThan(0.9);
});
