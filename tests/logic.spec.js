// Pure input logic (gestures + controller), ported from WonderSnap's tests/logic.spec.js and
// trimmed to what Phase 1 actually uses: no state machine, no snap detector wiring — just pose
// classification, openness, debouncing, and the controller's primary/secondary hand + roll logic.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/?manual=1'); await page.waitForFunction(() => window.sigilApp); });

test('gestures: poses at 4 rotations, openness monotonic, pose debouncer', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const G = await import('/src/input/gestures.js');
    const { hand } = await import('/src/input/synth.js');
    const poses = [0, 0.5, -0.6, 1.2].map((angle) => ['open', 'fist', 'point', 'peace', 'three'].map((pose) => G.classify(hand({ pose, angle }))));
    const open = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((f) => G.openness(hand({ pose: 'partial', f })));
    const deb = new G.PoseDebouncer(4);
    const seq = [...Array(5).fill('open'), 'fist', 'open', ...Array(4).fill('fist')];
    const changes = seq.map((p) => deb.update(p)).filter(([, c]) => c).map(([s]) => s);
    return { poses, none: G.classify(null), open, changes };
  });
  for (const row of r.poses) expect(row).toEqual(['open', 'fist', 'point', 'peace', 'three']);
  expect(r.none).toBe('none');
  expect(r.open[0]).toBeLessThan(0.05);
  expect(r.open[6]).toBeGreaterThan(0.95);
  for (let i = 1; i < r.open.length; i++) expect(r.open[i]).toBeGreaterThanOrEqual(r.open[i - 1]);
  expect(r.changes).toEqual(['open', 'fist']);        // 1-frame fist blip ignored
});

test('open: any 4 of 5 digits out counts (thumb optional), at any roll', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const G = await import('/src/input/gestures.js');
    const { hand } = await import('/src/input/synth.js');
    const out = [];
    for (const angle of [0, 0.7, -1.1, 1.57, 3.0]) {
      const open = hand({ pose: 'open', angle }), fist = hand({ pose: 'fist', angle });
      const thumbTucked = open.map((p, i) => (i >= 1 && i <= 4 ? fist[i] : p));
      const pinkyCurled = open.map((p, i) => (i >= 18 ? fist[i] : p));
      const twoDown = open.map((p, i) => (i >= 14 ? fist[i] : p));          // ring + pinky curled, thumb out: that's the split pose, not open
      out.push([G.classify(thumbTucked), G.classify(pinkyCurled), G.classify(twoDown)]);
    }
    return out;
  });
  for (const row of r) expect(row).toEqual(['open', 'open', 'three']);
});

test('regression: an upright open hand from a 16:9 camera classifies OPEN once aspect-corrected', async ({ page }) => {
  // The first-run calibration used to stall on "Hold your hand open": MediaPipe normalizes x by
  // width and y by height, which squashed a sideways thumb on a 16:9 feed below the thumb test.
  const r = await page.evaluate(async () => {
    const G = await import('/src/input/gestures.js');
    const { Controller } = await import('/src/input/controller.js');
    const { hand } = await import('/src/input/synth.js');
    const A = 16 / 9;
    const reported = hand({ pose: 'open' }).map(([x, y]) => [0.5 + (x - 0.5) / A, y]);   // what the tracker delivers
    const corrected = reported.map(([x, y]) => [x * A, y]);
    const c = new Controller(); c.aspect = A;
    let t = 0;
    for (let i = 0; i < 6; i++) { c.onHands([reported], t); t += 1 / 30; }
    return {
      naiveThumb: G.thumbOut(reported), correctedThumb: G.thumbOut(corrected),
      naiveOpenness: G.openness(reported), controller: c.pose, openness: c.rawOpenness,
    };
  });
  expect(r.naiveThumb).toBe(false);           // the distortion itself: the sideways thumb reads as tucked
  expect(r.correctedThumb).toBe(true);
  expect(r.controller).toBe('open');
  expect(r.openness).toBeGreaterThan(r.naiveOpenness + 0.1);
  expect(r.openness).toBeGreaterThan(0.95);
});

test('controller: palm centre, pinch, openness track a single hand', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { Controller } = await import('/src/input/controller.js');
    const { hand } = await import('/src/input/synth.js');
    const c = new Controller();
    let t = 0;
    for (let i = 0; i < 10; i++) { c.onHand(hand({ pose: 'open', cx: 0.3, cy: 0.6 }), t); t += 1 / 30; }
    const openSnap = { pose: c.pose, x: c.handX, y: c.handY, pinch: c.pinch };
    for (let i = 0; i < 5; i++) { c.onHand(hand({ pose: 'pinch', cx: 0.3, cy: 0.6 }), t); t += 1 / 30; }
    const pinchSnap = { pinch: c.pinch };
    return { openSnap, pinchSnap };
  });
  expect(r.openSnap.pose).toBe('open');
  expect(Math.abs(r.openSnap.x - 0.3)).toBeLessThan(0.05);
  expect(Math.abs(r.openSnap.y - 0.6)).toBeLessThan(0.05);
  expect(r.openSnap.pinch).toBe(false);
  expect(r.pinchSnap.pinch).toBe(true);
});

test('controller: hand twist (roll) at any pose and aspect, and smoothed', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { Controller } = await import('/src/input/controller.js');
    const { hand } = await import('/src/input/synth.js');
    const angles = [-1.0, -0.4, 0, 0.3, 0.9];
    const raw = angles.map((a) => ['open', 'fist', 'partial'].map((pose) => Controller.rollOf(hand({ pose, angle: a, f: 0.5 }))));
    const squeezed = hand({ pose: 'open', angle: 0.5 }).map(([x, y]) => [0.5 + (x - 0.5) / (16 / 9), y]);
    const c = new Controller(); let t = 0;
    for (let i = 0; i < 20; i++) { c.onHand(hand({ pose: 'fist', angle: 0.6 }), t); t += 1 / 30; }
    return { angles, raw, aspect: Controller.rollOf(squeezed, 16 / 9), smoothed: c.roll };
  });
  r.raw.forEach((row, i) => row.forEach((v) => expect(Math.abs(v - r.angles[i])).toBeLessThan(1e-6)));
  expect(Math.abs(r.aspect - 0.5)).toBeLessThan(1e-6);
  expect(Math.abs(r.smoothed - 0.6)).toBeLessThan(1e-3);
});

test('controller: primary hand tracks the nearest previous wrist when a second hand appears', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { Controller } = await import('/src/input/controller.js');
    const { hand } = await import('/src/input/synth.js');
    const c = new Controller();
    let t = 0;
    const left = hand({ pose: 'open', cx: 0.25, cy: 0.5 });
    for (let i = 0; i < 6; i++) { c.onHands([left], t); t += 1 / 30; }
    const before = { x: c.handX, second: c.second };
    const right = hand({ pose: 'open', cx: 0.75, cy: 0.5 });
    c.onHands([right, left], t);      // order swapped: controller must still pick the hand nearest the old primary
    return { before, afterX: c.handX, secondPresent: !!c.second };
  });
  expect(Math.abs(r.before.x - 0.25)).toBeLessThan(0.05);
  expect(r.before.second).toBeNull();
  expect(Math.abs(r.afterX - 0.25)).toBeLessThan(0.05);   // primary stayed with the left hand
  expect(r.secondPresent).toBe(true);
});
