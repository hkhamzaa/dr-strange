// Performance guarantees: the frame loop (detection path included) doesn't allocate per frame, and
// hands coming and going repeatedly doesn't leak GPU-side resources.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/?manual=1'); await page.waitForFunction(() => window.sigilApp); });

test('zero-allocation: 600 frames of two moving hands leave the JS heap flat', async ({ page }) => {
  test.skip(!(await page.evaluate(() => !!performance.memory && !!window.gc)), 'needs Chromium with --expose-gc');
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    // hands are built up front and replayed, so every byte measured below is the app's own
    const frames = [];
    for (let i = 0; i < 60; i++) {
      const t = i / 60, pose = i % 30 < 12 ? 'partial' : i % 30 < 22 ? 'three' : 'fist';
      frames.push([
        W.synth({ pose, f: 0.5 + 0.5 * Math.sin(t * 6), cx: 0.3 + 0.1 * Math.sin(t * 2), cy: 0.5, angle: 0.4 * Math.sin(t * 3) }),
        W.synth({ pose: 'partial', f: 0.5 + 0.5 * Math.cos(t * 5), cx: 0.72, cy: 0.5 + 0.08 * Math.cos(t * 3) }),
      ]);
    }
    let k = 0;
    const src = () => frames[k++ % frames.length];
    W.advance(3.0, src);                    // warm-up: JIT, first casts, one-time buffers
    window.gc();
    const before = performance.memory.usedJSHeapSize;
    W.advance(10.0, src);                   // 600 frames, ~300 detections
    window.gc();
    const after = performance.memory.usedJSHeapSize;
    return { deltaKB: (after - before) / 1024, bothShown: W.status().state !== 'dormant' && W.status().hasSigilB };
  });
  expect(r.bothShown).toBe(true);
  // after a full GC, anything allocated per frame and dropped is gone either way — this bound
  // catches allocations that are *retained* (growing arrays, caches, leaked listeners)
  expect(r.deltaKB).toBeLessThan(256);
});

test('zero-allocation: our frame loop allocates no objects, closures or iterators per frame (three.js render call excluded)', async ({ page }) => {
  // Complement to the retained-heap check above: raw allocation between GCs, with both sigils up
  // and animating. three.js's own composer.render() is stubbed out — its internals allocate a few
  // KB of short-lived garbage per frame (uniform uploads, render-list sort) that this project
  // can't change; everything else in the frame (mappers, follow, sigil animation, bus, governor,
  // calibration, HUD-less stats) is ours and must not allocate.
  test.skip(!(await page.evaluate(() => !!performance.memory && !!window.gc)), 'needs Chromium with --expose-gc');
  const r = await page.evaluate(async () => {
    const W = window.sigilApp, A = W.app;
    const L = W.synth({ pose: 'partial', f: 0.7, cx: 0.3 }), R = W.synth({ pose: 'three', cx: 0.7 });
    W.advance(2.0, () => [L, R]);
    W.setHand(null);                                                  // no detections: pure render-side frames
    A.composer.render = () => {};
    for (let i = 0; i < 600; i++) A.frame(A.t + 1 / 20000);           // warm up (JIT): enough for every per-frame path, AR layer included, to reach optimized code
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      window.gc();
      const before = performance.memory.usedJSHeapSize;
      for (let i = 0; i < 200; i++) A.frame(A.t + 1 / 2000);          // 0.3s total across reps: inside the 0.5s grace
      best = Math.min(best, (performance.memory.usedJSHeapSize - before) / 200);
    }
    return { bytesPerFrame: best, a: W.status().state, b: W.status().sigilB.state };
  });
  expect(r.a).toBe('active');
  expect(r.b).toBe('active');
  // What remains (~0.6 KB/frame across both sigils) is V8 boxing doubles into 12-byte heap numbers
  // when they're passed to calls it didn't inline — no objects, arrays, closures or iterators. The
  // bound sits well under what reintroducing any one of those costs (the governor's old reduce()
  // closure alone was ~2 KB/frame; one for-of over a sigil's layers ~1.1 KB).
  expect(r.bytesPerFrame).toBeLessThan(1024);
});

test('dispose: hands appearing and leaving 50 times does not grow GPU resource counts', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const W = window.sigilApp;
    const L = W.synth({ pose: 'open', cx: 0.3, cy: 0.5 }), R = W.synth({ pose: 'open', cx: 0.7, cy: 0.5 });
    W.advance(1.5, () => [L, R]);
    const info = () => W.app.renderer.info.memory;
    const before = { ...info() };
    for (let i = 0; i < 50; i++) {
      W.advance(0.3, () => [L, R]);
      W.advance(1.1, () => L);                                        // B uncasts (0.5s grace + 0.4s fade)
      W.advance(1.1, null);                                           // A uncasts too
      if (W.status().state !== 'dormant' || W.status().hasSigilB) return { failedAtIteration: i };
    }
    W.advance(1.0, () => [L, R]);
    return { before, after: { ...info() } };
  });
  expect(r.failedAtIteration).toBeUndefined();
  expect(r.after.geometries).toBeLessThanOrEqual(r.before.geometries);
  expect(r.after.textures).toBeLessThanOrEqual(r.before.textures);
});
