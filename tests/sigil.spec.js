// explode(1) must move every component away from its assembled transform, and regroup() must bring
// them all back within tolerance. Constructs a Sigil directly (off the running app) since the page's
// import map makes `three` resolvable from any module loaded on it.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/?manual=1'); await page.waitForFunction(() => window.sigilApp); });

test('sigil: explode(1) separates every component, regroup() reassembles within tolerance', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const THREE = window.sigilApp.THREE;
    const { Sigil } = await import('/src/sigil/sigil.js');
    const sig = new Sigil(THREE);
    for (let i = 0; i < 60; i++) sig.update(1 / 60);   // settle to assembled rest state

    const assembled = [...sig.components.values()].map((c) => ({ pos: c.group.position.toArray(), scale: c.group.scale.x }));

    sig.explode(1);
    for (let i = 0; i < 240; i++) sig.update(1 / 60);   // 4s: plenty for the 0.35s ease to converge
    const exploded = [...sig.components.values()].map((c) => ({ pos: c.group.position.toArray(), scale: c.group.scale.x }));

    sig.regroup();
    for (let i = 0; i < 240; i++) sig.update(1 / 60);
    const regrouped = [...sig.components.values()].map((c) => ({ pos: c.group.position.toArray(), scale: c.group.scale.x }));

    return { assembled, exploded, regrouped };
  });

  for (let i = 0; i < r.assembled.length; i++) {
    const a = r.assembled[i], e = r.exploded[i], g = r.regrouped[i];
    const moved = Math.hypot(...e.pos.map((v, k) => v - a.pos[k])) + Math.abs(e.scale - a.scale);
    expect(moved).toBeGreaterThan(0.02);                              // every component visibly separated

    const back = Math.hypot(...g.pos.map((v, k) => v - a.pos[k])) + Math.abs(g.scale - a.scale);
    expect(back).toBeLessThan(0.01);                                  // regroup returns within tolerance
  }
});
