// The intent bus must deliver a handState intent, carrying pose/palm/roll/openness/pinch, whenever
// the controller is fed a synthetic hand — this is the seam Phase 2's gesture mapping plugs into.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/?manual=1'); await page.waitForFunction(() => window.sigilApp); });

test('bus: handState intent carries pose, palm, roll, openness and pinch from a synthetic hand', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { emit, on } = await import('/src/bus/bus.js');
    const { Controller } = await import('/src/input/controller.js');
    const { hand } = await import('/src/input/synth.js');
    const received = [];
    const off = on('handState', (payload) => received.push(payload));
    const c = new Controller();
    let t = 0;
    for (let i = 0; i < 8; i++) { c.onHand(hand({ pose: 'open', cx: 0.4, cy: 0.5 }), t); emit('handState', c.snapshot(t)); t += 1 / 30; }
    off();
    emit('handState', c.snapshot(t));    // after off(): must NOT be received
    return received;
  });
  expect(r.length).toBe(8);
  const last = r[r.length - 1];
  expect(last.visible).toBe(true);
  expect(last.pose).toBe('open');
  expect(Math.abs(last.palm.x - 0.4)).toBeLessThan(0.05);
  expect(typeof last.roll).toBe('number');
  expect(typeof last.openness).toBe('number');
  expect(last.pinch).toBe(false);
});

test('bus: app.js wires handState into the sigil follow rule end to end', async ({ page }) => {
  // Phase 2 gates the follow rule to ACTIVE; forceActive() jumps the state machine there without
  // a snap, so this test stays focused on the follow rule rather than re-testing summon (see
  // gestures.spec.js for that).
  await page.evaluate(async () => { window.sigilApp.forceActive(); await window.sigilApp.advance(1.5); });
  const before = await page.evaluate(() => window.sigilApp.status().sigilPos);
  await page.evaluate(async () => { await window.sigilApp.advance(0.6, () => window.sigilApp.synth({ pose: 'open', cx: 0.75, cy: 0.5 })); });
  const after = await page.evaluate(() => window.sigilApp.status().sigilPos);
  expect(after[0]).toBeGreaterThan(before[0]);    // palm moved right -> sigil drifted right
});
