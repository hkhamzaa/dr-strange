// Fully synthesized sound, no audio files. One shared AudioContext -> master gain -> a soft
// limiter (a DynamicsCompressorNode leaned hard into limiter territory) -> speakers. The ambient
// hum is the only long-lived sound: two detuned oscillators and filtered noise, all created once
// at unlock() and left running — every frame just nudges their existing params, nothing new is
// ever built for it. One-shot sounds (summon, chime, grab click…) are short voices spawned per
// event and cut loose once their envelope finishes; a voice pool caps how many can overlap.
import { CFG } from '../config.js';

const clamp01 = (x) => Math.min(1, Math.max(0, x));

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.voices = new Set();
    this.hum = null;
    this._humLevelTarget = 0;
  }

  /** Must be called from a user gesture (the start-panel click) — browsers require it. Blocked or
   *  missing WebAudio (old browser, locked-down environment) leaves ctx null — every other method
   *  already no-ops on that, so the app just runs silently instead of throwing. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    let ctx;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
    } catch (e) { console.warn('AudioContext unavailable, running silently', e); return; }
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = CFG.audio.muted ? 0 : CFG.audio.masterGain;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = CFG.audio.limiterThresholdDb;
    limiter.knee.value = 6; limiter.ratio.value = 16; limiter.attack.value = 0.002; limiter.release.value = 0.15;
    master.connect(limiter); limiter.connect(ctx.destination);
    this.master = master;

    this.noiseBuffer = this._makeNoiseBuffer(2.0);
    this._startHum();
  }

  setMuted(muted) {
    CFG.audio.muted = muted;
    if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : CFG.audio.masterGain, this.ctx.currentTime, 0.05);
  }
  get muted() { return CFG.audio.muted; }

  _makeNoiseBuffer(seconds) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // ---------------------------------------------------------------- voice pool (one-shot sounds)
  _spawn(build) {
    if (!this.ctx) return null;
    if (this.voices.size >= CFG.audio.maxPolyphony) {
      const oldest = this.voices.values().next().value;
      if (oldest) { try { oldest.node.stop(); } catch { /* already stopped */ } this.voices.delete(oldest); }
    }
    const voice = build(this.ctx, this.master);
    this.voices.add(voice);
    const done = () => this.voices.delete(voice);
    voice.node.onended = done;
    setTimeout(done, (voice.durationS + 0.3) * 1000);      // belt-and-suspenders, in case onended never fires
    return voice;
  }

  _tone(freq0, freq1, durationS, { gain = 0.22, type = 'sine', attack = 0.03, harmonics = [] } = {}) {
    return this._spawn((ctx, dest) => {
      const g = ctx.createGain(); g.gain.value = 0;
      const t0 = ctx.currentTime;
      g.gain.linearRampToValueAtTime(gain, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + durationS);
      g.connect(dest);
      const osc = ctx.createOscillator();
      osc.type = type; osc.frequency.setValueAtTime(freq0, t0); osc.frequency.exponentialRampToValueAtTime(Math.max(freq1, 1), t0 + durationS);
      osc.connect(g); osc.start(t0); osc.stop(t0 + durationS + 0.05);
      for (const h of harmonics) {
        const hg = ctx.createGain(); hg.gain.value = 0;
        hg.gain.linearRampToValueAtTime(gain * h.gain, t0 + attack + h.delay);
        hg.gain.exponentialRampToValueAtTime(0.0001, t0 + durationS);
        hg.connect(dest);
        const ho = ctx.createOscillator();
        ho.type = h.type || type; ho.frequency.setValueAtTime(freq0 * h.ratio, t0); ho.frequency.exponentialRampToValueAtTime(Math.max(freq1 * h.ratio, 1), t0 + durationS);
        ho.connect(hg); ho.start(t0 + h.delay); ho.stop(t0 + durationS + 0.05);
      }
      return { node: osc, durationS };
    });
  }

  _noiseBurst(durationS, { gain = 0.25, filterType = 'lowpass', freq0 = 200, freq1 = 2000, q = 0.7 } = {}) {
    return this._spawn((ctx, dest) => {
      const t0 = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer; src.loop = true;
      const filt = ctx.createBiquadFilter(); filt.type = filterType; filt.Q.value = q;
      filt.frequency.setValueAtTime(freq0, t0); filt.frequency.exponentialRampToValueAtTime(Math.max(freq1, 20), t0 + durationS);
      const g = ctx.createGain(); g.gain.value = 0;
      g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.04, durationS * 0.2));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + durationS);
      src.connect(filt); filt.connect(g); g.connect(dest);
      src.start(t0); src.stop(t0 + durationS + 0.05);
      return { node: src, durationS };
    });
  }

  // ---------------------------------------------------------------- ambient hum (persistent)
  _startHum() {
    const ctx = this.ctx, [f0, f1] = CFG.audio.humBaseHz;
    const bus = ctx.createGain(); bus.gain.value = 0; bus.connect(this.master);

    const oscA = ctx.createOscillator(); oscA.type = 'sine'; oscA.frequency.value = f0;
    const oscB = ctx.createOscillator(); oscB.type = 'sine'; oscB.frequency.value = f1;
    const oscGain = ctx.createGain(); oscGain.gain.value = 0.5;
    oscA.connect(oscGain); oscB.connect(oscGain); oscGain.connect(bus);

    const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuffer; noise.loop = true;
    const noiseFilt = ctx.createBiquadFilter(); noiseFilt.type = 'bandpass'; noiseFilt.frequency.value = 220; noiseFilt.Q.value = 0.6;
    const noiseGain = ctx.createGain(); noiseGain.gain.value = CFG.audio.humNoiseGain;
    noise.connect(noiseFilt); noiseFilt.connect(noiseGain); noiseGain.connect(bus);

    oscA.start(); oscB.start(); noise.start();
    this.hum = { bus, oscA, oscB, baseA: f0, baseB: f1 };
  }
  /** Called every frame — only ever nudges existing node params, never builds new ones. */
  setHum(intensity, spinMul) {
    if (!this.hum) return;
    const target = clamp01(intensity) * 0.16;
    this.hum.bus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.15);
    const drift = 1 + (spinMul - 1) * 0.12;
    this.hum.oscA.frequency.setTargetAtTime(this.hum.baseA * drift, this.ctx.currentTime, 0.2);
    this.hum.oscB.frequency.setTargetAtTime(this.hum.baseB * drift, this.ctx.currentTime, 0.2);
  }

  // ---------------------------------------------------------------- sound events (bus-driven only)
  summon() { this._tone(220, 660, 1.0, { gain: 0.26, attack: 0.08, harmonics: [{ ratio: 2, gain: 0.35, delay: 0.15 }, { ratio: 3.02, gain: 0.18, delay: 0.35, type: 'triangle' }] }); }
  dismiss() { this._tone(520, 160, 0.7, { gain: 0.22, attack: 0.02, harmonics: [{ ratio: 0.5, gain: 0.3, delay: 0.05 }] }); }
  explode() { this._noiseBurst(0.5, { gain: 0.24, filterType: 'lowpass', freq0: 1200, freq1: 90, q: 0.5 }); }
  regroup() { this._noiseBurst(0.45, { gain: 0.2, filterType: 'lowpass', freq0: 90, freq1: 1000, q: 0.5 }); }
  chime(componentIndex = 0) {
    const scale = [523.25, 587.33, 659.25, 783.99, 880.0];    // C major pentatonic-ish, one note per component
    this._tone(scale[componentIndex % scale.length], scale[componentIndex % scale.length], 0.6, { gain: 0.2, type: 'triangle', attack: 0.01 });
  }
  grabClick() { this._noiseBurst(0.06, { gain: 0.18, filterType: 'highpass', freq0: 3000, freq1: 5000, q: 1.2 }); }
  releaseThump() { this._tone(110, 60, 0.25, { gain: 0.2, type: 'sine', attack: 0.005 }); }
  shatter() {
    this._noiseBurst(0.6, { gain: 0.28, filterType: 'bandpass', freq0: 2500, freq1: 900, q: 1.4 });
    for (let i = 0; i < 3; i++) setTimeout(() => this._tone(1800 + Math.random() * 1400, 400, 0.35, { gain: 0.08, type: 'triangle', attack: 0.002 }), i * 35);
  }
}
