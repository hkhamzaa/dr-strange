// A named group of layers with its own transform. Every setter here animates toward its target by
// exponential smoothing each update(dt) — nothing snaps, which is what makes explode/regroup/solo
// and the size presets read as motion rather than a jump cut.
import { CFG } from '../config.js';

const EASE_TAU = 0.2;      // explode/regroup lands ~95% of the way in 0.6s

export const ease = (cur, target, dt, tau = EASE_TAU) => cur + (target - cur) * (1 - Math.exp(-dt / tau));

export class SigilPart {
  constructor(THREE, layers) {
    this.THREE = THREE;
    this.layers = layers;                       // array of Layer
    this.group = new THREE.Group();
    for (const l of layers) this.group.add(l.mesh);

    this.spinMul = 1; this.spinMulTarget = 1;
    this.scale = 1; this.scaleTarget = 1;
    this.tilt = 0; this.tiltTarget = 0;          // rotation.x
    this.leanY = 0; this.leanYTarget = 0;        // rotation.y — the other half of "leans toward the hand"
    this.intensity = 1; this.intensityTarget = 1;
    this.pos = [0, 0, 0]; this.posTarget = [0, 0, 0];
    this.flashAmt = 0;                           // decaying brightness surge from a `pulse` intent
  }

  setSpinMul(m) { this.spinMulTarget = m; }
  setScale(s) { this.scaleTarget = s; }
  setTilt(rad) { this.tiltTarget = rad; }
  setLeanY(rad) { this.leanYTarget = rad; }
  setPosition(x, y, z) { this.posTarget[0] = x; this.posTarget[1] = y; this.posTarget[2] = z; }
  setIntensity(v) { this.intensityTarget = v; }
  setReveal(v) { for (const l of this.layers) l.setReveal(v); }
  flash(amount = CFG.gestures.pulse.amount) { this.flashAmt = Math.max(this.flashAmt, amount); }

  update(dt, time) {
    this.spinMul = ease(this.spinMul, this.spinMulTarget, dt);
    this.scale = ease(this.scale, this.scaleTarget, dt);
    this.tilt = ease(this.tilt, this.tiltTarget, dt);
    this.leanY = ease(this.leanY, this.leanYTarget, dt);
    this.intensity = ease(this.intensity, this.intensityTarget, dt);
    for (let i = 0; i < 3; i++) this.pos[i] = ease(this.pos[i], this.posTarget[i], dt);
    this.flashAmt *= Math.exp(-dt / CFG.gestures.pulse.flashTau);
    if (this.flashAmt < 0.002) this.flashAmt = 0;

    this.group.scale.setScalar(this.scale);
    this.group.rotation.x = this.tilt;
    this.group.rotation.y = this.leanY;
    this.group.position.set(this.pos[0], this.pos[1], this.pos[2]);

    const shownIntensity = this.intensity * (1 + this.flashAmt);
    for (let i = 0; i < this.layers.length; i++) {      // indexed: a for-of here allocates an iterator every frame
      const l = this.layers[i];
      l.spin(dt, this.spinMul);
      l.setTime(time);
      l.setIntensity(shownIntensity);
    }
  }
}

export class Component extends SigilPart {
  constructor(THREE, id, layers, explodeCfg) {
    super(THREE, layers);
    this.id = id;
    this.explodeOut = explodeCfg.explodeOut;
    this.explodeZ = explodeCfg.explodeZ;
    this.reveal = 0;
  }

  dispose() { for (const l of this.layers) l.dispose(); }
}
