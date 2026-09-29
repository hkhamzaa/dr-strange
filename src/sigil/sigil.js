// The public face of the whole magic circle: assembling components from config, casting/uncasting
// with a staggered draw-in sweep, exploded-view, solo/regroup, size presets, and the whole-sigil
// setters (position/scale/tilt/roll/intensity/spin) that anchor mode and the dev harness drive.
import { CFG, LAYERS, COMPONENTS, CAST_ORDER, GESTURE_MAP } from '../config.js';
import { Layer } from './layer.js';
import { Component, ease } from './component.js';
import { buildRuneAtlas } from './glyphs.js';

const smoothstep = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

export class Sigil {
  constructor(THREE) {
    this.THREE = THREE;
    this.root = new THREE.Group();
    this.atlas = buildRuneAtlas(THREE, CFG.seed);

    this.components = new Map();
    let seedCounter = 0;
    for (const compCfg of COMPONENTS) {
      const layers = compCfg.layers.map((id) => {
        const layerCfg = LAYERS.find((l) => l.id === id);
        const seed = (CFG.seed + seedCounter++ * 97) % 997;
        return new Layer(THREE, layerCfg, this.atlas, seed);
      });
      const comp = new Component(THREE, compCfg.id, layers, compCfg);
      this.components.set(compCfg.id, comp);
      this.root.add(comp.group);
    }

    // root (whole-sigil) transform
    this.scale = CFG.sizePresets.mid; this.scaleTarget = CFG.sizePresets.mid;
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

  cast() { this._cast = { dir: 1, t0: this._clock }; }
  uncast() { this._cast = { dir: -1, t0: this._clock }; }

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

  setSpinMul(m) { this.spinMulTarget = m; }
  setScale(s) { this.scaleTarget = s; }
  setTilt(rad) { this.tiltTarget = rad; }
  /** The other half of "leans toward the hand" — setTilt is rotation.x, this is rotation.y. */
  setLeanY(rad) { this.leanYTarget = rad; }
  setRoll(rad) { this.rollTarget = rad; }
  setPosition(x, y, z) { this.posTarget = [x, y, z]; }
  setIntensity(v) { this.intensityTarget = v; }
  setPosTau(tau) { this.posTau = tau; }

  /** A short brightness surge on one component (name given) or the whole sigil (name omitted). */
  pulse(name) {
    if (name) this.part(name).flash();
    else this._flashAmt = Math.max(this._flashAmt, CFG.gestures.pulse.amount);
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
    };
  }

  update(dt) {
    this._clock += dt;
    const time = this._clock;

    if (this._cast) {
      const ids = CAST_ORDER, n = ids.length;
      const span = CFG.reveal.castS * CFG.reveal.staggerFrac;
      const stepStagger = n > 1 ? span / (n - 1) : 0;
      const dur = Math.max(0.05, CFG.reveal.castS - span + stepStagger);
      let allDone = true;
      ids.forEach((id, i) => {
        const start = i * stepStagger;
        const local = Math.min(1, Math.max(0, (time - this._cast.t0 - start) / dur));
        if (local < 1) allDone = false;
        const eased = smoothstep(local);
        const comp = this.components.get(id);
        comp.reveal = this._cast.dir > 0 ? eased : 1 - eased;
        comp.setReveal(comp.reveal);
      });
      if (allDone) this._cast = null;
    }

    this.scale = ease(this.scale, this.scaleTarget, dt, CFG.sizeTransitionS);
    for (let i = 0; i < 3; i++) this.pos[i] = ease(this.pos[i], this.posTarget[i], dt, this.posTau);
    this.tilt = ease(this.tilt, this.tiltTarget, dt, GESTURE_MAP.tilt.tau);
    this.leanY = ease(this.leanY, this.leanYTarget, dt, GESTURE_MAP.tilt.tau);
    this.roll = ease(this.roll, this.rollTarget, dt, CFG.anchor.rollTau);
    this.spinMul = ease(this.spinMul, this.spinMulTarget, dt);
    this.intensity = ease(this.intensity, this.intensityTarget, dt);
    this._rootSpinAngle += 0.02 * this.spinMul * dt;
    this._flashAmt *= Math.exp(-dt / CFG.gestures.pulse.flashTau);
    if (this._flashAmt < 0.002) this._flashAmt = 0;

    this.root.scale.setScalar(this.scale);
    this.root.position.set(this.pos[0], this.pos[1], this.pos[2]);
    this.root.rotation.x = this.tilt;
    this.root.rotation.y = this.leanY;
    this.root.rotation.z = this.roll + this._rootSpinAngle;

    const rootShown = this.intensity * (1 + this._flashAmt);
    for (const c of this.components.values()) {
      c.update(dt, time);
      for (const l of c.layers) l.material.uniforms.uIntensity.value *= rootShown;
    }
  }
}
