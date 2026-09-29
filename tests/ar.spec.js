// AR is the default: the mirrored camera fills the screen and the sigil is pinned to the palm with
// the same cover-fit transform as the picture. These tests check that end to end, on real pixels.
import { test, expect } from '@playwright/test';
import { watchErrors, openApp, status } from './helpers.js';

test('a palm coordinate lands on the same screen pixel as the same video pixel, at any window aspect', async ({ page }) => {
  const noErrors = watchErrors(page);
  await openApp(page);

  // A 640x360 "camera frame" with a red dot at video pixel (400, 150), shown through the real composite.
  await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#f00'; g.beginPath(); g.arc(400, 150, 14, 0, Math.PI * 2); g.fill();
    window.sigilApp.setBackdrop(c);
  });

  for (const [w, h] of [[1280, 800], [1600, 600], [800, 1000], [900, 900], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForFunction(([ww, hh]) => Math.abs(window.sigilApp.app.camera.aspect - ww / hh) < 1e-3, [w, h]);   // the app has caught up with the new window
    const r = await page.evaluate(() => {
      const W = window.sigilApp;
      W.advance(2 / 60);
      const gl = W.app.renderer.getContext(), cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight;
      const px = new Uint8Array(cw * ch * 4);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let n = 0, sx = 0, sy = 0;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        if (px[i] > 180 && px[i + 1] < 60 && px[i + 2] < 60) { n++; sx += x + 0.5; sy += ch - (y + 0.5); }   // GL rows run bottom-up
      }
      // the feed is mirrored: video pixel (400, 150) is at mirrored image coords (1 - 400/640, 150/360)
      const want = W.palmToScreen(1 - 400 / 640, 150 / 360);
      return { n, got: [sx / n / cw, sy / n / ch], want, cw, ch };
    });
    expect(Math.abs(r.cw / r.ch - w / h), `canvas is ${w}x${h}`).toBeLessThan(0.01);
    expect(r.n, `dot visible at ${w}x${h}`).toBeGreaterThan(50);
    // within 2 px of where the sigil would be drawn for a palm at that video pixel
    expect(Math.abs(r.got[0] - r.want[0]) * r.cw, `x at ${w}x${h}`).toBeLessThan(2);
    expect(Math.abs(r.got[1] - r.want[1]) * r.ch, `y at ${w}x${h}`).toBeLessThan(2);
  }
  noErrors();
});

test('the sigil sits on the palm: its world position projects to the palm\'s screen position', async ({ page }) => {
  await openApp(page);
  for (const [w, h] of [[1280, 800], [700, 1000]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForFunction(([ww, hh]) => Math.abs(window.sigilApp.app.camera.aspect - ww / hh) < 1e-3, [w, h]);   // the app has caught up with the new window
    const r = await page.evaluate(() => {
      const W = window.sigilApp, c = document.createElement('canvas'); c.width = 640; c.height = 360;
      W.setBackdrop(c);
      W.advance(1.2, () => W.synth({ pose: 'open', cx: 0.62, cy: 0.4 }));
      const s = W.status(), a = W.app, h2 = a.halfH * 2;
      const uv = [0.5 + s.sigilPos[0] / (h2 * a.camera.aspect), 0.5 - s.sigilPos[1] / h2];   // world -> normalized screen, y down
      return { uv, want: W.palmToScreen(s.palm.x, s.palm.y) };
    });
    expect(Math.abs(r.uv[0] - r.want[0])).toBeLessThan(0.004);
    expect(Math.abs(r.uv[1] - r.want[1])).toBeLessThan(0.004);
  }
});

test('boot in AR with the fake camera: the canvas shows the live picture, not black', async ({ page }) => {
  test.setTimeout(120_000);
  const noErrors = watchErrors(page);
  await page.goto('/?autostart=1&dpr=1');
  await page.waitForFunction(() => window.sigilApp);
  await page.waitForFunction(() => window.sigilApp.app.background.hasVideo, null, { timeout: 60_000 });
  await page.waitForFunction(() => window.sigilApp.status().camera?.running, null, { timeout: 90_000 });
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => {
    const W = window.sigilApp, gl = W.app.renderer.getContext();
    const cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight;
    const px = new Uint8Array(4 * 64), out = { sum: 0, n: 0 };
    for (let k = 0; k < 64; k++) {              // an 8x8 grid of samples across the frame
      gl.readPixels(Math.floor(((k % 8) + 0.5) * cw / 8), Math.floor((Math.floor(k / 8) + 0.5) * ch / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px.subarray(k * 4, k * 4 + 4));
    }
    for (let k = 0; k < 64; k++) { out.sum += px[k * 4] + px[k * 4 + 1] + px[k * 4 + 2]; if (px[k * 4] + px[k * 4 + 1] + px[k * 4 + 2] > 30) out.n++; }
    return { ...out, mode: W.CFG.background.mode, floor: W.app.floor.visible, video: [W.app.video.videoWidth, W.app.video.videoHeight], aspect: W.app.background.videoAspect };
  });
  expect(r.mode).toBe('ar');
  expect(r.floor).toBe(false);
  expect(r.n, 'most sampled pixels are lit by the camera picture').toBeGreaterThan(32);
  expect(r.sum / 64 / 3).toBeGreaterThan(20);
  expect(r.video[0]).toBeGreaterThanOrEqual(640);                       // the visible feed asks for 720p, not the 480p detection copy

  expect(await page.locator('#start').isHidden()).toBe(true);
  expect(await page.locator('#hint').evaluate((el) => el.classList.contains('show'))).toBe(true);   // no hand yet -> the one line of text
  expect(await page.locator('#hud, .hud').count()).toBe(0);              // no HUD in normal mode
  noErrors();
});

test('?bg=void is the dev override: dark stage, floor back', async ({ page }) => {
  await openApp(page, 'bg=void');
  const s = await status(page);
  expect(s.bgMode).toBe('void');
  expect(await page.evaluate(() => window.sigilApp.app.floor.visible)).toBe(true);
});

test('AR: floor hidden, embers ride on the sigil, base size follows hand size', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(() => {
    const W = window.sigilApp, a = W.app;
    W.advance(1.2, () => W.synth({ pose: 'open', cx: 0.7, cy: 0.4, s: 0.1 }));
    const far = { base: a.sessionList[0].sigil.base, scale: W.status().sigilScale };
    const sp = a.sparkList[0].points;
    const emberAtSigil = { x: sp.position.x, sigilX: W.status().sigilPos[0], visible: sp.visible };
    W.advance(1.2, () => W.synth({ pose: 'open', cx: 0.7, cy: 0.4, s: 0.2 }));
    const near = { base: a.sessionList[0].sigil.base, scale: W.status().sigilScale };
    return { floor: a.floor.visible, far, near, emberAtSigil };
  });
  expect(r.floor).toBe(false);
  expect(r.emberAtSigil.visible).toBe(true);
  expect(Math.abs(r.emberAtSigil.x - r.emberAtSigil.sigilX)).toBeLessThan(0.02);
  expect(r.near.base).toBeGreaterThan(r.far.base * 1.8);                 // twice as close -> about twice as big
  expect(Math.abs(r.near.scale - r.far.scale)).toBeLessThan(0.03);       // ...while openness sizing is untouched
});

test('AR: the sigil leads a moving palm, and stays put on a still one', async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(() => {
    const W = window.sigilApp, a = W.app;
    const c = document.createElement('canvas'); c.width = 640; c.height = 360; W.setBackdrop(c);
    let x = 0.5;
    W.advance(1.0, () => W.synth({ pose: 'open', cx: 0.5, cy: 0.5 }));
    const still = [0, 0], stillRaw = [0, 0], tr = a.ctl.tracks[0];
    a.palmTarget(tr, still); a.palmToWorld(tr.handX, tr.handY, stillRaw);
    W.advance(0.6, () => { x += 0.5 / 30; return W.synth({ pose: 'open', cx: x, cy: 0.5 }); });   // 0.5 image widths / s to the right
    const moving = [0, 0], movingRaw = [0, 0];
    a.palmTarget(tr, moving); a.palmToWorld(tr.handX, tr.handY, movingRaw);
    return { stillGap: Math.abs(still[0] - stillRaw[0]), lead: moving[0] - movingRaw[0], vx: tr.vx };
  });
  expect(r.stillGap).toBeLessThan(1e-4);
  expect(r.vx).toBeGreaterThan(0.3);
  expect(r.lead).toBeGreaterThan(0.02);                                  // ahead of the (stale) palm, in the direction of motion
  expect(r.lead).toBeLessThan(0.25);                                     // ...but only lightly
});

test('occlusion (?occlusion=1): fingers are in the mask, the palm centre is not', async ({ page }) => {
  await openApp(page, 'occlusion=1');
  const r = await page.evaluate(() => {
    const W = window.sigilApp, a = W.app;
    const c = document.createElement('canvas'); c.width = 640; c.height = 360; W.setBackdrop(c);
    W.advance(0.5, () => W.synth({ pose: 'open', cx: 0.5, cy: 0.5, s: 0.15 }));
    const cv = a.mask.texture.image, g = cv.getContext('2d');
    const at = (x, y) => g.getImageData(Math.round(x * cv.width), Math.round(y * cv.height), 1, 1).data[0];
    const lm = a.ctl.tracks[0].lm;
    return { tip: at(lm[12][0], lm[12][1]), mid: at(lm[10][0], lm[10][1]), palm: at(a.ctl.tracks[0].handX, a.ctl.tracks[0].handY), far: at(0.05, 0.05), on: a.background.material.uniforms.uOcclusion.value };
  });
  expect(r.on).toBeGreaterThan(0);
  expect(r.tip).toBeGreaterThan(200);
  expect(r.mid).toBeGreaterThan(200);
  expect(r.palm).toBeLessThan(40);
  expect(r.far).toBeLessThan(10);
});
