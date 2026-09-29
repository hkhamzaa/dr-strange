// Final QA: one synthetic run through the whole gesture set — hand appears, size, roll, split,
// regroup, a second hand and its own sigil, that hand leaving, the first leaving — asserting no
// console errors and no leaked GPU resources across the whole thing.
import { test, expect } from '@playwright/test';
import { watchErrors } from './helpers.js';

test('full lifecycle: presence, size, roll, split, two hands, hands leaving — no errors, no leaks', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/?manual=1');
  await page.waitForFunction(() => window.sigilApp);

  const log = await page.evaluate(async () => {
    const W = window.sigilApp, out = {};
    const S = () => W.status();

    W.advance(0.1, () => W.synth({ pose: 'open', cx: 0.4, cy: 0.5 }));
    out.appeared = S().state;
    W.advance(1.0);
    out.cast = S().state;
    window.__gpuBefore = { ...W.app.renderer.info.memory };

    W.advance(0.8, () => W.synth({ pose: 'fist', cx: 0.4, cy: 0.5 }));
    out.fistScale = S().sigilScale;
    W.advance(0.8, () => W.synth({ pose: 'open', cx: 0.4, cy: 0.5, angle: 0.6 }));
    out.openScale = S().sigilScale; out.roll = S().sigilRoll;

    W.advance(0.5, () => W.synth({ pose: 'three', cx: 0.4, cy: 0.5 }));
    out.split = S().sigil.exploded;
    W.advance(0.8, () => W.synth({ pose: 'open', cx: 0.4, cy: 0.5 }));
    out.regrouped = S().sigil.exploded;

    W.advance(1.2, () => [W.synth({ pose: 'open', cx: 0.3, cy: 0.5 }), W.synth({ pose: 'fist', cx: 0.75, cy: 0.5 })]);
    out.two = { a: S().state, b: S().sigilB.state, bScale: S().sigilBScale, bX: S().sigilBPos[0] };

    W.advance(1.2, () => W.synth({ pose: 'open', cx: 0.3, cy: 0.5 }));
    out.secondLeft = { a: S().state, b: S().sigilB.state };

    W.advance(1.2, null);
    out.allGone = { a: S().state, b: S().sigilB.state, hidden: !W.app.sessionList[0].sigil.root.visible };
    return out;
  });

  expect(log.appeared).toBe('casting');
  expect(log.cast).toBe('active');
  expect(log.openScale).toBeGreaterThan(log.fistScale + 0.6);
  expect(Math.abs(log.roll + 0.6)).toBeLessThan(0.05);
  expect(log.split).toBe(1);
  expect(log.regrouped).toBe(0);
  expect(log.two.a).toBe('active');
  expect(log.two.b).toBe('active');
  expect(log.two.bX).toBeGreaterThan(0.3);
  expect(log.two.bScale).toBeLessThan(0.7);
  expect(log.secondLeft).toEqual({ a: 'active', b: 'dormant' });
  expect(log.allGone).toEqual({ a: 'dormant', b: 'dormant', hidden: true });

  const { before, after } = await page.evaluate(() => ({ before: window.__gpuBefore, after: { ...window.sigilApp.app.renderer.info.memory } }));
  expect(after.geometries).toBeLessThanOrEqual(before.geometries + 2);
  expect(after.textures).toBeLessThanOrEqual(before.textures + 2);

  noErrors();
});
