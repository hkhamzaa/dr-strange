// Two hands, two sigils: each hand drives its own sigil through the same map, and losing a hand
// removes only its sigil — the other hand keeps its slot rather than being renumbered.
import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

test.beforeEach(async ({ page }) => { await openApp(page); });

test('two hands create two independent sigils, each on its own palm with its own size and split', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    const both = (left, right) => () => [W.synth({ cx: 0.25, cy: 0.5, ...left }), W.synth({ cx: 0.75, cy: 0.5, ...right })];
    W.advance(1.3, both({ pose: 'fist' }, { pose: 'open' }));
    const s1 = W.status();
    W.advance(0.5, both({ pose: 'fist' }, { pose: 'three' }));
    const s2 = W.status();
    return {
      a: { state: s1.state, x: s1.sigilPos[0], scale: s1.sigilScale, exploded: s2.sigil.exploded },
      b: { state: s1.sigilB.state, x: s1.sigilBPos[0], scale: s1.sigilBScale, exploded: s2.sigilB.sigil.exploded },
      presets: W.CFG.sizePresets,
    };
  });
  expect(r.a.state).toBe('active');
  expect(r.b.state).toBe('active');
  expect(r.a.x).toBeLessThan(-0.3);
  expect(r.b.x).toBeGreaterThan(0.3);
  expect(Math.abs(r.a.scale - r.presets.smol)).toBeLessThan(0.03);     // fist hand: small
  expect(Math.abs(r.b.scale - r.presets.full)).toBeLessThan(0.03);     // open hand: full
  expect(r.a.exploded).toBe(0);                                         // only B's hand made the split pose
  expect(r.b.exploded).toBe(1);
});

test('losing one hand removes only its sigil — whichever hand it is', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    const L = () => W.synth({ pose: 'open', cx: 0.25, cy: 0.5 }), R = () => W.synth({ pose: 'open', cx: 0.75, cy: 0.5 });
    W.advance(1.3, () => [L(), R()]);
    W.advance(1.2, () => L());                      // right hand (B) leaves
    const bGone = { a: W.status().state, b: W.status().sigilB.state, aX: W.status().sigilPos[0] };
    W.advance(1.3, () => [L(), R()]);               // it comes back
    const bBack = W.status().sigilB.state;
    W.advance(1.2, () => R());                      // now the LEFT hand (A) leaves; the right one keeps its own sigil
    const aGone = { a: W.status().state, b: W.status().sigilB.state, bX: W.status().sigilBPos[0] };
    return { bGone, bBack, aGone };
  });
  expect(r.bGone).toMatchObject({ a: 'active', b: 'dormant' });
  expect(r.bGone.aX).toBeLessThan(-0.3);           // A stayed on the left hand, didn't jump
  expect(r.bBack).toBe('active');
  expect(r.aGone).toMatchObject({ a: 'dormant', b: 'active' });
  expect(r.aGone.bX).toBeGreaterThan(0.3);
});

test('hand identity survives the tracker reporting the two hands in either order', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    let flip = false;
    W.advance(1.0, () => [W.synth({ pose: 'open', cx: 0.25, cy: 0.5 }), W.synth({ pose: 'fist', cx: 0.75, cy: 0.5 })]);
    W.advance(1.0, () => {
      flip = !flip;
      const a = W.synth({ pose: 'open', cx: 0.25, cy: 0.5 }), b = W.synth({ pose: 'fist', cx: 0.75, cy: 0.5 });
      return flip ? [b, a] : [a, b];
    });
    const s = W.status();
    return { aX: s.sigilPos[0], bX: s.sigilBPos[0], aScale: s.sigilScale, bScale: s.sigilBScale };
  });
  expect(r.aX).toBeLessThan(-0.3);
  expect(r.bX).toBeGreaterThan(0.3);
  expect(r.aScale).toBeGreaterThan(r.bScale + 0.5);
});
