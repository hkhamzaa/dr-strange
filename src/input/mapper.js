// Turns Controller output (primary hand only) into intents on the bus. This is the only place
// gestures become meaning — it reads pose/openness/pinch/roll/landmarks from the Controller and the
// current sigil state, and emits summon/dismiss/resize/explode/solo/regroup/spin/tilt/pulse. It
// never imports the sigil or the stage; visuals only ever hear about this through the bus.
import { emit } from '../bus/bus.js';
import { CFG, GESTURE_MAP, COMPONENTS } from '../config.js';
import { SnapDetector, handScale, OPEN, PEACE, POINT, THUMB_TIP, MIDDLE_TIP, TIPS } from './gestures.js';
import { DORMANT, DISMISSING } from './stateMachine.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Rising/falling edge with separate arm and release dwell times — hysteresis against pose flicker.
 *  A single noisy frame can't flip `on` in either direction; the raw signal has to hold steady for
 *  the whole dwell window first. */
class DwellGate {
  constructor(armS, releaseS) { this.armS = armS; this.releaseS = releaseS; this.on = false; this.onT = 0; this.offT = 0; }
  update(raw, dt) {
    if (raw) { this.onT += dt; this.offT = 0; if (!this.on && this.onT >= this.armS) this.on = true; }
    else { this.offT += dt; this.onT = 0; if (this.on && this.offT >= this.releaseS) this.on = false; }
    return this.on;
  }
}

export class GestureMapper {
  constructor(ctl, stateMachine) {
    this.ctl = ctl;
    this.sm = stateMachine;
    this.snap = new SnapDetector();

    this.openHoldT = 0;
    this.chargeProgress = 0;

    this.pinchGate = new DwellGate(GESTURE_MAP.explode.armS, GESTURE_MAP.explode.releaseS);
    this.pointGate = new DwellGate(GESTURE_MAP.spin.armS, GESTURE_MAP.spin.releaseS);
    this.peaceGate = new DwellGate(GESTURE_MAP.soloCycle.armS, GESTURE_MAP.soloCycle.releaseS);
    this._peaceWasOn = false;

    this.explodeScaleRef = null;
    this.explodeValue = 0;
    this.explodeRelease = null;        // { from, t0 } while easing back to 0 after the pinch lets go

    this.spinRef = null;
    this.spinValue = 1;
    this.spinRelease = null;           // { from, t0 } while easing back to 1 after leaving the point pose

    this.soloIndex = -1;               // -1 = regrouped; else an index into COMPONENTS
    this.lastSoloT = -1e9;

    this.resizeValue = 0.5;

    this.noHandSince = null;
    this.idleEased = false;

    this.gestureLabel = 'none';
    this.gestureProgress = 0;
    this._lastSmState = DORMANT;
  }

  _fire(name, component) {
    this.gestureLabel = name;
    emit('pulse', component ? { gesture: name, component } : { gesture: name });
  }

  update(t, dt) {
    const ctl = this.ctl, sm = this.sm;
    const vis = ctl.handVisible(t);

    // a snap toggles the state machine from any state it's allowed to (DORMANT<->CASTING is
    // handled inside sm.snap() itself; casting/dismissing already ignore it there)
    if (this.snap.update(ctl.landmarks, t)) { sm.snap(); this._fire('snap'); }
    sm.tick(dt);

    if (sm.state !== this._lastSmState && sm.state === DISMISSING) this._neutralize();
    this._lastSmState = sm.state;

    if (sm.state === DORMANT) { this._updateOpenHold(vis, ctl, dt); return; }
    if (!sm.inGesture) { this.gestureLabel = sm.state; return; }     // CASTING / DISMISSING: gestures ignored

    if (!vis) {
      if (this.noHandSince === null) this.noHandSince = t;
      if (t - this.noHandSince >= CFG.gestures.handLost.idleAfterS && !this.idleEased) {
        this.idleEased = true;
        if (this.spinRef !== null) { this.spinRef = null; this.spinRelease = { from: this.spinValue, t0: t }; }
        this._emitTilt(0, 0);
      }
      this._tickExplodeRelease(t);
      this._tickSpinRelease(t);
      this.gestureLabel = 'none';
      return;
    }
    this.noHandSince = null; this.idleEased = false;

    this._updateResize(ctl, dt);
    this._updateExplode(ctl, t, dt);
    this._updateSoloCycle(ctl, t, dt);
    this._updateSpin(ctl, t, dt);
    this._updateTilt(ctl);
  }

  /** DORMANT-only fallback: an open palm held the whole hold window also summons. */
  _updateOpenHold(vis, ctl, dt) {
    const g = GESTURE_MAP.openHold;
    const holding = vis && ctl.pose === OPEN;
    if (holding) {
      this.openHoldT += dt;
      this.chargeProgress = clamp(this.openHoldT / g.holdS, 0, 1);
      emit('pulse', { gesture: 'openHold', component: 'heart', charging: true, progress: this.chargeProgress });
      if (this.openHoldT >= g.holdS) {
        this.sm.openHoldSummon();
        this._fire('openHold');
        this.openHoldT = 0; this.chargeProgress = 0;
      }
    } else { this.openHoldT = 0; this.chargeProgress = 0; }
    this.gestureLabel = holding ? 'openHold' : 'none';
    this.gestureProgress = this.chargeProgress;
  }

  _updateResize(ctl, dt) {
    if (ctl.pinch) return;    // suspended while pinching so it never fights explode
    const g = GESTURE_MAP.resize;
    const k = 1 - Math.exp(-dt / g.tau);
    this.resizeValue += (ctl.openness - this.resizeValue) * k;
    emit('resize', { t: this.resizeValue });
  }

  _updateExplode(ctl, t, dt) {
    const g = GESTURE_MAP.explode;
    const raw = ctl.pinch;
    const gated = this.pinchGate.update(raw, dt);
    if (gated && raw) {                                     // armed and still pinching: track live
      if (this.explodeScaleRef === null) { this.explodeScaleRef = handScale(ctl.landmarks); this._fire('pinch'); }
      this.explodeRelease = null;
      const ratio = handScale(ctl.landmarks) / this.explodeScaleRef;
      this.explodeValue = clamp((g.dirSign * (ratio - 1)) / g.scaleRange, 0, 1);
      emit('explode', { amount: this.explodeValue });
    } else if (!gated && this.explodeScaleRef !== null) {   // release dwell elapsed: start easing to 0
      this.explodeScaleRef = null;
      this.explodeRelease = { from: this.explodeValue, t0: t };
    }
    // else: mid release-dwell (raw already false, gate still on) — hold steady, don't chase a
    // hand shape that no longer means anything for this gesture
    this._tickExplodeRelease(t);
  }
  _tickExplodeRelease(t) {
    if (!this.explodeRelease) return;
    const g = GESTURE_MAP.explode;
    const local = clamp((t - this.explodeRelease.t0) / g.releaseEaseS, 0, 1);
    this.explodeValue = this.explodeRelease.from * (1 - smoothstep(local));
    emit('explode', { amount: this.explodeValue });
    if (local >= 1) this.explodeRelease = null;
  }

  _updateSoloCycle(ctl, t, dt) {
    const g = GESTURE_MAP.soloCycle;
    const gated = this.peaceGate.update(ctl.pose === PEACE, dt);
    if (gated && !this._peaceWasOn && t - this.lastSoloT >= g.cooldownS) {
      this.lastSoloT = t;
      this.soloIndex++;
      if (this.soloIndex >= COMPONENTS.length) { this.soloIndex = -1; emit('regroup', {}); this._fire('peace'); }
      else { const name = COMPONENTS[this.soloIndex].id; emit('solo', { name }); this._fire('peace', name); }
    }
    this._peaceWasOn = gated;
  }

  _updateSpin(ctl, t, dt) {
    const g = GESTURE_MAP.spin;
    const raw = ctl.pose === POINT;
    const gated = this.pointGate.update(raw, dt);
    if (gated && raw) {                                     // armed and still pointing: track live roll
      if (this.spinRef === null) { this.spinRef = ctl.roll; this._fire('point'); }
      this.spinRelease = null;
      const mul = clamp(1 + (ctl.roll - this.spinRef) * g.gain, g.min, g.max);
      this.spinValue = mul;
      emit('spin', { mul });
    } else if (!gated && this.spinRef !== null) {            // release dwell elapsed: ease back to 1
      this.spinRef = null;
      this.spinRelease = { from: this.spinValue, t0: t };
    }
    // else: mid release-dwell — hold steady rather than tracking the roll of whatever pose follows
    this._tickSpinRelease(t);
  }
  _tickSpinRelease(t) {
    if (!this.spinRelease) return;
    const g = GESTURE_MAP.spin;
    const local = clamp((t - this.spinRelease.t0) / g.easeBackS, 0, 1);
    this.spinValue = this.spinRelease.from + (1 - this.spinRelease.from) * smoothstep(local);
    emit('spin', { mul: this.spinValue });
    if (local >= 1) this.spinRelease = null;
  }

  _updateTilt(ctl) {
    const g = GESTURE_MAP.tilt;
    const ox = clamp((ctl.handY - 0.5) * 2, -1, 1);      // vertical offset -> pitch
    const oy = clamp((ctl.handX - 0.5) * 2, -1, 1);      // horizontal offset -> the other lean axis
    this._emitTilt(clamp(ox * g.clampRad, -g.clampRad, g.clampRad), clamp(-oy * g.clampRad, -g.clampRad, g.clampRad));
  }
  _emitTilt(x, y) { emit('tilt', { x, y }); }

  /** Fired once, the moment ACTIVE gives way to DISMISSING — a fresh summon should not inherit a
   *  half-exploded, soloed, or spun-up sigil from the session that just ended. */
  _neutralize() {
    if (this.soloIndex !== -1) { this.soloIndex = -1; emit('regroup', {}); }
    else if (this.explodeValue > 0.001) emit('explode', { amount: 0 });
    this.explodeValue = 0; this.explodeScaleRef = null; this.explodeRelease = null;
    if (this.spinValue !== 1) emit('spin', { mul: 1 });
    this.spinValue = 1; this.spinRef = null; this.spinRelease = null;
    this.resizeValue = 0.5;
    this._emitTilt(0, 0);
  }

  /** Calibration + gesture-state snapshot for the ?debug=1 HUD. */
  status(t) {
    const lm = this.ctl.landmarks;
    const raw = lm ? {
      openness: +this.ctl.openness.toFixed(3),
      pinchRatio: +(dist(lm[THUMB_TIP], lm[TIPS[0]]) / handScale(lm)).toFixed(3),
      handScale: +handScale(lm).toFixed(4),
      snapRatio: +(dist(lm[THUMB_TIP], lm[MIDDLE_TIP]) / handScale(lm)).toFixed(3),
    } : null;
    const cooling = t - this.lastSoloT < GESTURE_MAP.soloCycle.cooldownS;
    return {
      state: this.sm.state, label: this.gestureLabel, progress: +this.gestureProgress.toFixed(2), raw,
      gates: {
        explode: this.pinchGate.on ? 'active' : this.explodeRelease ? 'releasing' : this.pinchGate.onT > 0 ? 'arming' : 'idle',
        spin: this.pointGate.on ? 'active' : this.spinRelease ? 'releasing' : this.pointGate.onT > 0 ? 'arming' : 'idle',
        soloCycle: cooling ? 'cooldown' : this.peaceGate.onT > 0 ? 'arming' : 'idle',
        resize: this.ctl.pinch ? 'suspended' : 'active',
      },
    };
  }
}
