import { chromium } from '@playwright/test';
const b = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await b.newContext({ permissions: ['camera'], viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage(); if (process.env.NOWORKER) await p.addInitScript(() => { window.Worker = undefined; });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('http://localhost:' + (process.env.PORT || 5173) + '/?autostart=1&perf=1');
await p.waitForFunction(() => window.sigilApp?.status().camera?.running, null, { timeout: 30000 });
const tStart = Date.now(); for (let i = 0; i < 2; i++) { await p.waitForTimeout(2500); console.log(JSON.stringify(await p.evaluate(() => { const s = window.sigilApp.status(); return { t: +s.t.toFixed(1), renderFps: +s.fps.toFixed(1), detFps: +(s.camera.fps).toFixed(1), frames: s.camera.frames, detectMs: +window.sigilApp.app.cam.detectMs.toFixed(1), lat: +s.camera.latencyMs.toFixed(0), hint: s.hint }; }))); }
const s = await p.evaluate(() => { const s = window.sigilApp.status(); return { mode: window.sigilApp.app.cam.mode, camera: s.camera, fps: s.fps, tier: s.quality, hint: s.hint, hintVisible: getComputedStyle(document.getElementById('hint')).opacity, video: [document.getElementById('cam').videoWidth, document.getElementById('cam').videoHeight], perf: document.querySelector('div[style*="c8ffea"]')?.textContent }; });
console.log(JSON.stringify(s, null, 1)); console.log('errors:', errs);
await b.close();
