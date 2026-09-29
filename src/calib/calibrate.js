// Silent calibration. No prompts, no screens: while the user plays, a rolling window records the
// min/max openness (and hand scale) their hands actually reach, and the fist/open bounds that
// normalize openness -> size chase those, so a half-open hand reads as half size on this particular
// hand and camera. The adapted profile persists; ?recalibrate=1 throws it away and starts fresh.
import { CFG, FLAGS } from '../config.js';

const KEY = 'sigil.calib.v2';
const DEFAULTS = { opennessFist: 0.05, opennessOpen: 0.95, scaleRef: 0.14 };

export function loadCalibration() {
  try {
    if (FLAGS.recalibrate) { localStorage.removeItem(KEY); return null; }
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveCalibration(profile) {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* private mode / storage full — just don't persist */ }
}

export function applyProfile(profile) {
  CFG.calib.openness.fist = profile.opennessFist;
  CFG.calib.openness.open = profile.opennessOpen;
  CFG.calib.scaleRef = profile.scaleRef;
}

export function resetCalibration() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  applyProfile(DEFAULTS);
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export class AutoCalib {
  constructor() {
    const a = CFG.calib.adapt;
    this.n = Math.round(a.windowS / a.binS);
    this.lo = new Float32Array(this.n);               // per-bin min / max openness and hand scale
    this.hi = new Float32Array(this.n);
    this.sLo = new Float32Array(this.n);
    this.sHi = new Float32Array(this.n);
    this.binT = new Float64Array(this.n).fill(-1e9);
    this.bin = -1;
    this.filled = 0;                                   // bins inside the window, as of the last update()
    this.lastSaveT = 0;
    this.dirty = false;
    this.win = { oMin: NaN, oMax: NaN, sMin: NaN, sMax: NaN };
  }

  /** One hand's filtered raw openness + scale, at detection rate. */
  sample(openness, scale, t) {
    const a = CFG.calib.adapt;
    const b = Math.floor(t / a.binS) % this.n;
    if (b !== this.bin || t - this.binT[b] >= a.binS) {
      this.bin = b; this.binT[b] = t;
      this.lo[b] = this.hi[b] = openness; this.sLo[b] = this.sHi[b] = scale;
    } else {
      if (openness < this.lo[b]) this.lo[b] = openness;
      if (openness > this.hi[b]) this.hi[b] = openness;
      if (scale < this.sLo[b]) this.sLo[b] = scale;
      if (scale > this.sHi[b]) this.sHi[b] = scale;
    }
  }

  /** Once per render frame: ease the live bounds toward the window's min/max. */
  update(t, dt) {
    const a = CFG.calib.adapt;
    let oMin = 1, oMax = 0, sMin = 1e9, sMax = 0, filled = 0;
    for (let i = 0; i < this.n; i++) {
      if (t - this.binT[i] > a.windowS) continue;    // empty, or older than the window
      filled++;
      if (this.lo[i] < oMin) oMin = this.lo[i];
      if (this.hi[i] > oMax) oMax = this.hi[i];
      if (this.sLo[i] < sMin) sMin = this.sLo[i];
      if (this.sHi[i] > sMax) sMax = this.sHi[i];
    }
    this.filled = filled;
    if (filled * a.binS < a.warmupS) return;
    this.win.oMin = oMin; this.win.oMax = oMax; this.win.sMin = sMin; this.win.sMax = sMax;
    const k = 1 - Math.exp(-dt / a.tau);
    const o = CFG.calib.openness;
    o.fist += (clamp(oMin + a.margin, 0, a.fistMax) - o.fist) * k;
    o.open += (clamp(oMax - a.margin, a.openMin, 1) - o.open) * k;
    CFG.calib.scaleRef += ((sMin + sMax) / 2 - CFG.calib.scaleRef) * k;
    this.dirty = true;
    if (t - this.lastSaveT >= a.saveEveryS) this.save(t);
  }

  save(t = this.lastSaveT) {
    if (!this.dirty) return;
    this.lastSaveT = t; this.dirty = false;
    saveCalibration({ opennessFist: CFG.calib.openness.fist, opennessOpen: CFG.calib.openness.open, scaleRef: CFG.calib.scaleRef });
  }

  reset() {
    this.binT.fill(-1e9);
    this.filled = 0; this.bin = -1;
    resetCalibration();
  }

  status() {
    return {
      fist: +CFG.calib.openness.fist.toFixed(3), open: +CFG.calib.openness.open.toFixed(3), scaleRef: +CFG.calib.scaleRef.toFixed(4),
      windowS: +(this.filled * CFG.calib.adapt.binS).toFixed(1),
      winMin: +(this.win.oMin || 0).toFixed(3), winMax: +(this.win.oMax || 0).toFixed(3),
    };
  }
}
