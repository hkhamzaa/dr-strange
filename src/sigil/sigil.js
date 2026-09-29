// The public face of the whole magic circle: assembling components from config, casting/uncasting
// with a staggered draw-in sweep, exploded-view, solo/regroup, size presets, and the whole-sigil
// setters (position/scale/tilt/roll/intensity/spin) that anchor mode and the dev harness drive.
import { CFG, LAYERS, COMPONENTS, CAST_ORDER } from '../config.js';
import { Layer } from './layer.js';
import { Component, ease } from './component.js';
import { buildRuneAtlas } from './glyphs.js';

const smoothstep = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// The detail layers dropped first as layerFrac decreases (Phase 4's per-tier "second sigil layer
// count" lever) — rune bands and the tick ring are the fine ornamental detail, never the main
// rings/stars, so a lower tier reads as "simpler" rather than "broken".
const OPTIONAL_LAYERS = ['tickRing', 'outerRune', 'innerRune'];

export class Sigil {
  /** opts (Phase 3/4, all optional): seed override, a {core,mid,outer} colorRamp override, spinFlip
   *  (-1 mirrors every layer's spin direction), and layerFrac (0..1, drops OPTIONAL_LAYERS as it
   *  falls below 1 — the quality governor's lever for the second sigil). Called with just
   *  `new Sigil(THREE)`, behaviour is identical to Phase 1/2. */
  constructor(THREE, opts = {}) {
    this.THREE = THREE;
    this.root = new THREE.Group();
    const seed = opts.seed ?? CFG.seed;
    const spinFlip = opts.spinFlip ?? 1;
    this.atlas = buildRuneAtlas(THREE, seed);

    const dropCount = Math.round(OPTIONAL_LAYERS.length * (1 - (opts.layerFrac ?? 1)));
    const dropped = new Set(OPTIONAL_LAYERS.slice(0, dropCount));

    this.components = new Map();
    let seedCounter = 0;
    for (const compCfg of COMPONENTS) {
      const layers = compCfg.layers.filter((id) => !dropped.has(id)).map((id) => {
        const layerCfg = LAYERS.find((l) => l.id === id);
        const layerSeed = (seed + seedCounter++ * 97) % 997;
        const flipped = spinFlip === -1 ? { ...layerCfg, spinny: -layerCfg.spinny } : layerCfg;
        return new Layer(THREE, flipped, this.atlas, layerSeed, opts.colorRamp);
      });
      const comp = new Component(THREE, compCfg.id, layers, compCfg);
      this.components.set(compCfg.id, comp);
      this.root.add(comp.group);
    }
    this._comps = [...this.components.values()];                   // per-frame iteration without Map iterators
    this._castComps = CAST_ORDER.map((id) => this.components.get(id));
    this._sweepFrom = new Float32Array(this._castComps.length);

    this._effect = null;            // { kind: 'shatter' | 'dissolve', t0, durationS } while dismissing that way

    // root (whole-sigil) transform
    this.scale = CFG.sizePresets.mid; this.scaleTarget = CFG.sizePresets.mid;
    this.base = 1; this.baseTarget = 1;          // AR: hand-size multiplier on top of the openness-driven scale
    this.pos = [0, 0, 0]; this.posTarget = [0, 0, 0];
    this.tilt = 0; this.tiltTarget = 0;          // rotation.x — a literal tilt (parallax)
    this.leanY = 0; this.leanYTarget = 0;        // rotation.y — the other axis of "leans toward the hand"
    this.roll = 0; this.rollTarget = 0;          // rotation.z — hand-twist follow
    this.spinMul = 1; this.spinMulTarget = 1;    // multiplies a slow whole-sigil idle drift
    this.intensity = 1; this.intensityTarget = 1;
    this.posTau = CFG.anchor.followTau;          // anchor mode swaps this between follow/release speeds
    this._rootSpinAngle = 0;
    this._flashAmt = 0;                          // decaying whole-sigil brightness surge (pulse with no component)

    this._clock = 0;
    this._cast = null;             // { dir: 1 | -1, t0 }
    this._explodeTarget = 0;
    this._solo = null;             // component id or null

    this._applyExplode();
    this._applySolo();
  }

  part(name) {
    const c = this.components.get(name);
    if (!c) throw new Error(`unknown sigil component: ${name}`);
    return c;
  }

  /** Draw-in sweep, outer to inner. Starts from each component's current reveal, so casting over a
   *  half-finished uncast reverses it smoothly instead of popping back to empty. */
  cast(durationS = CFG.reveal.castS) { this._sweep(1, durationS); }
  uncast(durationS = CFG.reveal.castS) { this._sweep(-1, durationS); }
  _sweep(dir, durationS) {
    this._effect = null;
    for (let i = 0; i < this._castComps.length; i++) this._sweepFrom[i] = this._castComps[i].reveal;
    this._cast = { dir, t0: this._clock, durationS };
  }

  /** Jump (no easing) to a position/roll — used when a sigil casts in on a hand that just appeared. */
  snapTo(x, y, z, roll = this.rollTarget) {
    this.pos[0] = this.posTarget[0] = x; this.pos[1] = this.posTarget[1] = y; this.pos[2] = this.posTarget[2] = z;
    this.roll = this.rollTarget = roll;
  }

  /** Every layer breaks into a shard field (fragment-shader cell displacement, see shaders.js) and
   *  fades, with a bright ignition flash at the start. Cancels any in-progress cast/uncast sweep —
   *  shatter is a full replacement for the reveal animation, not layered on top of it. */
  shatter() {
    this._cast = null;
    this._effect = { kind: 'shatter', t0: this._clock, durationS: CFG.dismiss.shatter.durationS };
  }
  /** Reverses an in-progress or just-finished shatter — shards fly back and reassemble. */
  reassemble() {
    this._effect = { kind: 'shatter', t0: this._clock, durationS: CFG.dismiss.shatter.reassembleS, reverse: true };
    for (const c of this.components.values()) { c.reveal = 1; c.setReveal(1); }
  }
  /** Ember-erosion dismissal: layers dissolve via a noise threshold instead of the angular sweep. */
  dissolve() {
    this._cast = null;
    this._effect = { kind: 'dissolve', t0: this._clock, durationS: CFG.dismiss.dissolve.durationS };
  }

  explode(amount) { this._explodeTarget = Math.min(1, Math.max(0, amount)); this._applyExplode(); }
  solo(name) { this._solo = name; this._applySolo(); }
  regroup() { this._explodeTarget = 0; this._solo = null; this._applyExplode(); this._applySolo(); }
  get explodeAmount() { return this._explodeTarget; }

  setSize(preset) {
    const s = CFG.sizePresets[preset];
    if (s === undefined) throw new Error(`unknown size preset: ${preset}`);
    this.scaleTarget = s;
  }
  /** Continuous size: t=0 -> smol, t=1 -> full. Interpolates the same radii setSize() presets use. */
  setSizeT(t) {
    t = Math.min(1, Math.max(0, t));
    this.scaleTarget = CFG.sizePresets.smol + (CFG.sizePresets.full - CFG.sizePresets.smol) * t;
  }

  /** Base size from the hand's size in frame (AR). `scale` stays the openness-driven part. */
  setBase(b, snap = false) { this.baseTarget = b; if (snap) this.base = b; }
  /** World-space outer radius of the drawn sigil. */
  get radius() { return this.scale * this.base; }

  setSpinMul(m) { this.spinMulTarget = m; }
  setScale(s) { this.scaleTarget = s; }
  setTilt(rad) { this.tiltTarget = rad; }
  /** The other half of "leans toward the hand" — setTilt is rotation.x, this is rotation.y. */
  setLeanY(rad) { this.leanYTarget = rad; }
  setRoll(rad) { this.rollTarget = rad; }
  setPosition(x, y, z) { this.posTarget[0] = x; this.posTarget[1] = y; this.posTarget[2] = z; }
  setIntensity(v) { this.intensityTarget = v; }
  setPosTau(tau) { this.posTau = tau; }
  /** Quality-governor lever: fewer/more shard cells for the shatter effect (cost scales with cell
   *  count, since each cell is a per-pixel branch, not real geometry). */
  setShatterCellDensity(angular, radial) {
    for (const c of this.components.values()) for (const l of c.layers) l.setShatterCells(angular, radial);
  }

  /** A short brightness surge on one component (name given) or the whole sigil (name omitted). */
  pulse(name) {
    if (name) this.part(name).flash();
    else this._flashAmt = Math.max(this._flashAmt, CFG.gestures.pulse.amount);
  }

  /** Releases every layer's geometry/material plus the shared rune atlas — call once, when a sigil
   *  is gone for good (a merged-away sigil B). The root itself must still be removed from the scene
   *  by the caller; disposing doesn't do that, it only frees GPU-side resources. */
  dispose() {
    for (const c of this.components.values()) c.dispose();
    this.atlas.dispose();
  }

  _applyExplode() {
    for (const c of this.components.values()) {
      c.setScale(1 + c.explodeOut * this._explodeTarget);
      c.setPosition(0, 0, c.explodeZ * this._explodeTarget);
    }
  }
  _applySolo() {
    for (const [id, c] of this.components) c.setIntensity(this._solo === null || this._solo === id ? 1 : 0.08);
  }

  /** State snapshot for the debug HUD's component list. */
  status() {
    const out = {};
    for (const [id, c] of this.components) {
      out[id] = { reveal: +c.reveal.toFixed(2), intensity: +c.intensity.toFixed(2), scale: +c.scale.toFixed(2), soloed: this._solo === id };
    }
    return {
      components: out, exploded: +this._explodeTarget.toFixed(2), solo: this._solo, casting: !!this._cast,
      spinMul: +this.spinMul.toFixed(3), tilt: +this.tilt.toFixed(3), leanY: +this.leanY.toFixed(3), size: +this.scale.toFixed(3),
      effect: this._effect ? this._effect.kind : null,
    };
  }

  update(dt) {
    this._clock += dt;
    const time = this._clock;

    if (this._cast) {
      const comps = this._castComps, n = comps.length, total = this._cast.durationS;
      const span = total * CFG.reveal.staggerFrac;
      const stepStagger = n > 1 ? span / (n - 1) : 0;
      const dur = Math.max(0.05, total - span + stepStagger);
      const target = this._cast.dir > 0 ? 1 : 0;
      let allDone = true;
      for (let i = 0; i < n; i++) {
        const local = Math.min(1, Math.max(0, (time - this._cast.t0 - i * stepStagger) / dur));
        if (local < 1) allDone = false;
        const from = this._sweepFrom[i];
        comps[i].reveal = from + (target - from) * smoothstep(local);
        comps[i].setReveal(comps[i].reveal);
      }
      if (allDone) this._cast = null;
    }

    let shatterV = 0, dissolveV = 0;
    if (this._effect) {
      const local = Math.min(1, Math.max(0, (time - this._effect.t0) / this._effect.durationS));
      if (this._effect.kind === 'shatter') shatterV = this._effect.reverse ? 1 - smoothstep(local) : smoothstep(local);
      else dissolveV = smoothstep(local);
      if (local >= 1) {
        if (this._effect.kind === 'shatter' && !this._effect.reverse) for (const c of this._comps) { c.reveal = 0; c.setReveal(0); }
        this._effect = null;
      }
    }

    this.scale = ease(this.scale, this.scaleTarget, dt, CFG.sizeTransitionS);
    this.base = ease(this.base, this.baseTarget, dt, CFG.sizeTransitionS);
    for (let i = 0; i < 3; i++) this.pos[i] = ease(this.pos[i], this.posTarget[i], dt, this.posTau);
    this.tilt = ease(this.tilt, this.tiltTarget, dt, CFG.anchor.tiltTau);
    this.leanY = ease(this.leanY, this.leanYTarget, dt, CFG.anchor.tiltTau);
    this.roll = ease(this.roll, this.rollTarget, dt, CFG.anchor.rollTau);
    this.spinMul = ease(this.spinMul, this.spinMulTarget, dt);
    this.intensity = ease(this.intensity, this.intensityTarget, dt);
    this._rootSpinAngle += 0.02 * this.spinMul * dt;
    this._flashAmt *= Math.exp(-dt / CFG.gestures.pulse.flashTau);
    if (this._flashAmt < 0.002) this._flashAmt = 0;

    this.root.scale.setScalar(this.scale * this.base);
    this.root.position.set(this.pos[0], this.pos[1], this.pos[2]);
    this.root.rotation.x = this.tilt;
    this.root.rotation.y = this.leanY;
    this.root.rotation.z = this.roll + this._rootSpinAngle;

    const rootShown = this.intensity * (1 + this._flashAmt);
    for (let i = 0; i < this._comps.length; i++) {
      const c = this._comps[i];
      c.update(dt, time);
      for (let j = 0; j < c.layers.length; j++) {
        const l = c.layers[j];
        l.material.uniforms.uIntensity.value *= rootShown;
        l.setShatter(shatterV);
        l.setDissolve(dissolveV);
      }
    }
  }
}
