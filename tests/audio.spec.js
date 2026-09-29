// The synthesized audio engine: the ambient hum never builds a new AudioNode after unlock() (only
// nudges existing params), and the one-shot voice pool respects its polyphony cap.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => { await page.goto('/?manual=1'); await page.waitForFunction(() => window.sigilApp); });

test('audio: ambient hum updates every frame without ever creating a new node', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/engine.js');
    const engine = new AudioEngine();
    engine.unlock();
    let created = 0;
    const ctx = engine.ctx;
    for (const name of ['createOscillator', 'createGain', 'createBufferSource', 'createBiquadFilter']) {
      const orig = ctx[name].bind(ctx);
      ctx[name] = (...a) => { created++; return orig(...a); };
    }
    for (let i = 0; i < 600; i++) engine.setHum(0.3 + 0.2 * Math.sin(i * 0.1), 1 + 0.05 * i);
    return { created, hasHum: !!engine.hum };
  });
  expect(r.hasHum).toBe(true);
  expect(r.created).toBe(0);
});

test('audio: one-shot voices respect the configured polyphony cap', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/engine.js');
    const { CFG } = await import('/src/config.js');
    const engine = new AudioEngine();
    engine.unlock();
    for (let i = 0; i < CFG.audio.maxPolyphony + 15; i++) engine.chime(i % 5);
    return { voices: engine.voices.size, cap: CFG.audio.maxPolyphony };
  });
  expect(r.voices).toBeLessThanOrEqual(r.cap);
  expect(r.voices).toBeGreaterThan(0);
});

test('audio: muting schedules the master gain toward 0 and unmuting schedules it back', async ({ page }) => {
  // Waiting on a real AudioContext's currentTime to actually advance by some wall-clock margin is
  // inherently flaky under headless CI (throttled timers, no real audio device). Spying on the
  // scheduling call itself is deterministic and tests the same thing: what target did we ask for.
  const r = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/engine.js');
    const { CFG } = await import('/src/config.js');
    const engine = new AudioEngine();
    engine.unlock();
    const calls = [];
    const orig = engine.master.gain.setTargetAtTime.bind(engine.master.gain);
    engine.master.gain.setTargetAtTime = (target, ...rest) => { calls.push(target); return orig(target, ...rest); };
    const before = engine.master.gain.value;
    engine.setMuted(true);
    engine.setMuted(false);
    return { before, calls, muted: engine.muted, masterGain: CFG.audio.masterGain };
  });
  expect(r.before).toBeGreaterThan(0);
  expect(r.calls).toEqual([0, r.masterGain]);
  expect(r.muted).toBe(false);
});
