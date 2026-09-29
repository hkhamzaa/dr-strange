// Raw landmarks -> filtered, classified hand state. Two slots, one per hand, each keeping its
// identity across frames by nearest-wrist matching — so when one hand leaves, the other keeps its
// own slot (and its own sigil) instead of being renumbered. Called once per detection frame; the
// render loop only ever reads the fields this leaves behind.
//
// Everything a sigil follows (palm, roll, openness, scale) goes through its own One-Euro filter.
// Pose classification runs on aspect-corrected, lightly filtered landmarks — MediaPipe normalizes x
// by width and y by height, which squashes a sideways thumb on a 16:9 feed enough to break OPEN.
import { CFG, GESTURE_MAP } from '../config.js';
import { classify, isThree, openness, pinched, handScale, PoseDebouncer, NONE } from './gestures.js';
import { OneEuro } from './oneEuro.js';

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const pts = () => Array.from({ length: 21 }, () => [0, 0]);
const HIST = 16;

export class HandTrack {
  constructor(holdFrames = 3) {
    this.debounce = new PoseDebouncer(holdFrames);
    this.lm = pts(); this.iso = pts();
    this.fx = Array.from({ length: 21 }, () => new OneEuro(CFG.filter.landmark));
    this.fy = Array.from({ length: 21 }, () => new OneEuro(CFG.filter.landmark));
    this.fPalmX = new OneEuro(CFG.filter.palm); this.fPalmY = new OneEuro(CFG.filter.palm);
    this.fRoll = new OneEuro(CFG.filter.roll);
    this.fOpen = new OneEuro(CFG.filter.openness);
    this.fScale = new OneEuro(CFG.filter.scale);

    this.present = false;        // in the most recent detection frame
    this.streak = 0;             // consecutive detection frames present
    this.lastHandT = -1e9;
    this.pose = NONE; this.rawPose = NONE;
    this.openness = 0;           // normalized by the adapted fist/open bounds, filtered
    this.rawOpenness = 0;        // filtered, not normalized
    this.scale = 0;
    this.handX = 0.5; this.handY = 0.5;
    this.vx = 0; this.vy = 0;    // palm velocity, image units / s (filtered) — the renderer leads the sigil by it
    this.roll = 0;
    this.pinch = false; this._pinchN = 0;
    this.three = false; this.threeArming = false; this._threeOnT = 0; this._threeOffT = 0;
    this.wrist = [0, 0];         // aspect-corrected, raw — for slot matching
    this._rawRoll = 0; this._unrolled = 0;
    this._histT = new Float64Array(HIST); this._histO = new Float32Array(HIST); this._histI = 0;
  }

  get landmarks() { return this.present ? this.lm : null; }
  handVisible(t) { return t - this.lastHandT < 0.35; }

  /** Highest normalized openness seen in the last `windowS` — what the split pose freezes size at. */
  recentMaxOpenness(t, windowS) {
    let m = this.openness;
    for (let i = 0; i < HIST; i++) if (t - this._histT[i] <= windowS && this._histO[i] > m) m = this._histO[i];
    return m;
  }

  update(raw, t, aspect) {
    if (!raw) { this.present = false; this.streak = 0; return; }
    const fresh = t - this.lastHandT > GESTURE_MAP.presence.graceS;
    if (fresh) this._resetFilters();
    const dt = fresh ? 0 : t - this.lastHandT;

    for (let i = 0; i < 21; i++) {
      const x = this.fx[i].filter(raw[i][0], t), y = this.fy[i].filter(raw[i][1], t);
      this.lm[i][0] = x; this.lm[i][1] = y;
      this.iso[i][0] = x * aspect; this.iso[i][1] = y;
    }
    this.wrist[0] = raw[0][0] * aspect; this.wrist[1] = raw[0][1];

    const rp = classify(this.iso);
    this.rawPose = rp;
    this.pose = this.debounce.update(rp)[0];
    this._pinchN = pinched(this.iso) ? this._pinchN + 1 : 0;
    this.pinch = this._pinchN >= 3;

    const g = GESTURE_MAP.split;
    const raw3 = isThree(this.iso, this.three);
    if (raw3) { this._threeOnT += dt; this._threeOffT = 0; if (!this.three && this._threeOnT >= g.armS) this.three = true; }
    else { this._threeOffT += dt; this._threeOnT = 0; if (this.three && this._threeOffT >= g.releaseS) this.three = false; }
    this.threeArming = raw3 && !this.three;

    // palm/roll/openness/scale come from the raw landmarks through their own filters — running
    // them off the already-filtered landmarks would stack two lags for no extra stability
    const px = this.handX, py = this.handY;
    this.handX = this.fPalmX.filter((raw[0][0] + raw[9][0]) / 2, t);
    this.handY = this.fPalmY.filter((raw[0][1] + raw[9][1]) / 2, t);
    if (fresh || dt < 1e-3) { this.vx = 0; this.vy = 0; }
    else {
      const k = 1 - Math.exp(-dt / CFG.ar.predict.velTau);
      this.vx += ((this.handX - px) / dt - this.vx) * k;
      this.vy += ((this.handY - py) / dt - this.vy) * k;
    }
    const r = Controller.rollOf(raw, aspect);
    this._unrolled = fresh ? r : this._unrolled + wrap(r - this._rawRoll);   // continuous across ±π
    this._rawRoll = r;
    this.roll = this.fRoll.filter(this._unrolled, t);
    this.rawOpenness = this.fOpen.filter(opennessIso(raw, aspect), t);
    const lo = CFG.calib.openness.fist, hi = CFG.calib.openness.open;
    this.openness = clamp01((this.rawOpenness - lo) / Math.max(hi - lo, 0.05));
    this.scale = this.fScale.filter(handScale(this.iso), t);

    this._histT[this._histI] = t; this._histO[this._histI] = this.openness; this._histI = (this._histI + 1) % HIST;
    this.present = true; this.streak++;
    this.lastHandT = t;
  }

  _resetFilters() {
    for (let i = 0; i < 21; i++) { this.fx[i].reset(); this.fy[i].reset(); }
    this.fPalmX.reset(); this.fPalmY.reset(); this.fRoll.reset(); this.fOpen.reset(); this.fScale.reset();
    this.three = false; this._threeOnT = 0; this._threeOffT = 0;
    this._histT.fill(-1e9);
  }
}

const _tmp = pts();
function opennessIso(raw, aspect) {
  for (let i = 0; i < 21; i++) { _tmp[i][0] = raw[i][0] * aspect; _tmp[i][1] = raw[i][1]; }
  return openness(_tmp);
}

const _dist = (w, h, aspect) => Math.hypot(w[0] - h[0][0] * aspect, w[1] - h[0][1]);

export class Controller {
  constructor(holdFrames = 3) {
    this.tracks = [new HandTrack(holdFrames), new HandTrack(holdFrames)];
    this.aspect = 1;            // image width / height
    this._snap = { visible: false, pose: NONE, rawPose: NONE, palm: { x: 0.5, y: 0.5 }, roll: 0, openness: 0, pinch: false, three: false, second: null, t: 0 };
    this._second = { landmarks: null };
  }

  /** Hand twist from the wrist -> middle-knuckle direction; unaffected by opening/closing the fingers. */
  static rollOf(lm, aspect = 1) {
    return Math.atan2((lm[9][0] - lm[0][0]) * aspect, -(lm[9][1] - lm[0][1]));
  }

  /** All hands of one detection frame (at most two). Each goes to the slot whose last wrist is
   *  nearest; a slot whose hand is gone stays empty rather than being refilled by the other hand. */
  onHands(hands, t) {
    const A = this.tracks[0], B = this.tracks[1], a = this.aspect;
    const liveA = t - A.lastHandT < 1, liveB = t - B.lastHandT < 1;
    let h0 = null, h1 = null;
    if (hands.length >= 2) {
      const p = hands[0], q = hands[1];
      if (liveA && liveB) {
        const straight = _dist(A.wrist, p, a) + _dist(B.wrist, q, a), swapped = _dist(A.wrist, q, a) + _dist(B.wrist, p, a);
        if (straight <= swapped) { h0 = p; h1 = q; } else { h0 = q; h1 = p; }
      } else if (liveB) {
        if (_dist(B.wrist, p, a) <= _dist(B.wrist, q, a)) { h1 = p; h0 = q; } else { h1 = q; h0 = p; }
      } else if (liveA) {
        if (_dist(A.wrist, p, a) <= _dist(A.wrist, q, a)) { h0 = p; h1 = q; } else { h0 = q; h1 = p; }
      } else { h0 = p; h1 = q; }
    } else if (hands.length === 1) {
      const p = hands[0];
      if (liveA && liveB) { if (_dist(A.wrist, p, a) <= _dist(B.wrist, p, a)) h0 = p; else h1 = p; }
      else if (liveB && _dist(B.wrist, p, a) < 0.3) h1 = p;
      else h0 = p;
    }
    A.update(h0, t, a);
    B.update(h1, t, a);
    return A.pose;
  }

  /** Single-hand feed straight into the primary slot (the second slot is left alone). */
  onHand(lm, t) { this.tracks[0].update(lm, t, this.aspect); return this.tracks[0].pose; }

  // primary-hand fields, read by the mapper, the HUD and the tests
  get pose() { return this.tracks[0].pose; }
  get rawPose() { return this.tracks[0].rawPose; }
  get openness() { return this.tracks[0].openness; }
  get rawOpenness() { return this.tracks[0].rawOpenness; }
  get handX() { return this.tracks[0].handX; }
  get handY() { return this.tracks[0].handY; }
  get roll() { return this.tracks[0].roll; }
  get pinch() { return this.tracks[0].pinch; }
  get three() { return this.tracks[0].three; }
  get landmarks() { return this.tracks[0].landmarks; }
  get lastHandT() { return this.tracks[0].lastHandT; }
  handVisible(t) { return this.tracks[0].handVisible(t); }

  // second-hand fields
  get second() { return this.tracks[1].landmarks; }
  get secondPose() { return this.tracks[1].pose; }
  get secondOpenness() { return this.tracks[1].openness; }
  get secondPinch() { return this.tracks[1].pinch; }
  get secondScale() { return this.tracks[1].scale; }
  get secondX() { return this.tracks[1].handX; }
  get secondY() { return this.tracks[1].handY; }
  get secondRoll() { return this.tracks[1].roll; }
  get secondThree() { return this.tracks[1].three; }
  secondVisible(t) { return this.tracks[1].handVisible(t); }

  /** `handState` payload. One reused object — read it, don't keep it. */
  snapshot(t) {
    const A = this.tracks[0], s = this._snap, vis = A.handVisible(t);
    s.visible = vis;
    s.pose = vis ? A.pose : NONE;
    s.rawPose = vis ? A.rawPose : NONE;
    s.palm.x = A.handX; s.palm.y = A.handY;
    s.roll = A.roll;
    s.openness = vis ? A.openness : 0;
    s.pinch = vis && A.pinch;
    s.three = vis && A.three;
    this._second.landmarks = this.second;
    s.second = this.secondVisible(t) ? this._second : null;
    s.t = t;
    return s;
  }
}
