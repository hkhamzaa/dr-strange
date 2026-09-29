// Watches a rolling frame-time window and steps the quality tier down after sustained misses,
// back up only after long stability — hysteresis on both the threshold gap and the hold time, so
// it can't oscillate. ?quality=high|mid|low disables the governor and pins a tier instead.
import { CFG, QUALITY_TIERS, FLAGS } from '../config.js';

const TIERS = ['high', 'mid', 'low'];

export class QualityGovernor {
  constructor(onChange) {
    this.onChange = onChange;
    this.pinned = FLAGS.quality && QUALITY_TIERS[FLAGS.quality] ? FLAGS.quality : null;
    // touch devices default to mid (still governed from there, just a sensibler starting point
    // than assuming desktop-GPU headroom) unless ?quality= pins something explicitly
    const touch = typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 2);
    this.tier = this.pinned || (touch ? 'mid' : 'high');
    // fixed ring + running sum: sample() runs every frame and must not allocate
    this.ring = new Float64Array(CFG.perf.windowFrames);
    this.count = 0; this.head = 0; this.sum = 0;
    this.belowSinceT = null;
    this.aboveSinceT = null;
    onChange(this.tier, QUALITY_TIERS[this.tier]);
  }

  get locked() { return !!this.pinned; }

  /** dtS: this frame's real duration in seconds. t: running clock. */
  sample(dtS, t) {
    if (this.pinned) return;
    const n = this.ring.length;
    if (this.count === n) this.sum -= this.ring[this.head]; else this.count++;
    this.ring[this.head] = dtS; this.sum += dtS;
    this.head = (this.head + 1) % n;
    if (this.count < Math.min(20, n)) return;

    const avgFps = this.count / Math.max(this.sum, 1e-9);

    if (avgFps < CFG.perf.stepDownFps) {
      this.aboveSinceT = null;
      if (this.belowSinceT === null) this.belowSinceT = t;
      if (t - this.belowSinceT >= CFG.perf.stepDownHoldS) this._step(-1, t);
    } else if (avgFps >= CFG.perf.stepUpFps) {
      this.belowSinceT = null;
      if (this.aboveSinceT === null) this.aboveSinceT = t;
      if (t - this.aboveSinceT >= CFG.perf.stepUpHoldS) this._step(1, t);
    } else {
      this.belowSinceT = null; this.aboveSinceT = null;
    }
  }

  _step(dir, t) {
    const i = TIERS.indexOf(this.tier);
    const next = TIERS[Math.min(TIERS.length - 1, Math.max(0, i - dir))];   // dir=-1 (down) moves to a LATER (lower) tier
    if (next === this.tier) return;
    this.tier = next;
    this.belowSinceT = null; this.aboveSinceT = null; this.count = 0; this.head = 0; this.sum = 0;
    this.onChange(this.tier, QUALITY_TIERS[this.tier]);
  }

  status() { return { tier: this.tier, locked: this.locked, samples: this.count }; }
}
