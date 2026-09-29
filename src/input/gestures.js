// Hand pose, continuous openness and the split (three-finger) pose from MediaPipe's 21 landmarks.
// Every test is a ratio of distances, so it's rotation-invariant — but only if x and y are in the
// same units. MediaPipe normalizes them separately (x by width, y by height), so callers must pass
// aspect-corrected landmarks (x * width/height); the Controller does that before classifying.
export const WRIST = 0, THUMB_TIP = 4, MIDDLE_MCP = 9, MIDDLE_TIP = 12;
export const TIPS = [8, 12, 16, 20], PIPS = [6, 10, 14, 18], MCPS = [5, 9, 13, 17];
export const OPEN = 'open', FIST = 'fist', PEACE = 'peace', POINT = 'point', THREE = 'three', OTHER = 'other', NONE = 'none';

const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const handScale = (lm) => Math.max(d(lm[WRIST], lm[MIDDLE_MCP]), 1e-6);

// [strict, loose] thresholds — the loose set is what the split pose uses once it's already on, so
// a borderline frame can't knock it off (hysteresis on the shape itself, on top of the dwell gate).
const EXT = [1.1, 1.0], CURL = [1.25, 1.45], THUMB = [0.55, 0.42];

const ext = (lm, i, k = EXT[0]) => d(lm[TIPS[i]], lm[WRIST]) > d(lm[PIPS[i]], lm[WRIST]) * k;
const curled = (lm, i, k = CURL[0]) => d(lm[TIPS[i]], lm[WRIST]) < d(lm[MCPS[i]], lm[WRIST]) * k;

/** Thumb out: tip well clear of the index knuckle, and farther from the wrist than its own IP joint. */
export function thumbOut(lm, k = THUMB[0]) {
  return d(lm[THUMB_TIP], lm[5]) > handScale(lm) * k && d(lm[THUMB_TIP], lm[WRIST]) > d(lm[3], lm[WRIST]);
}

/** Thumb + index + middle extended, ring + pinky curled. `loose` widens every threshold. */
export function isThree(lm, loose = false) {
  if (!lm) return false;
  const j = loose ? 1 : 0;
  return thumbOut(lm, THUMB[j]) && ext(lm, 0, EXT[j]) && ext(lm, 1, EXT[j]) && curled(lm, 2, CURL[j]) && curled(lm, 3, CURL[j]);
}

/** Instant pose. OPEN = at least 4 of 5 digits out (so the thumb is optional). */
export function classify(lm) {
  if (!lm) return NONE;
  const e0 = ext(lm, 0), e1 = ext(lm, 1), e2 = ext(lm, 2), e3 = ext(lm, 3);
  const th = thumbOut(lm);
  const c0 = curled(lm, 0), c1 = curled(lm, 1), c2 = curled(lm, 2), c3 = curled(lm, 3);
  if (th && e0 && e1 && c2 && c3) return THREE;
  if (e0 + e1 + e2 + e3 + th >= 4) return OPEN;
  if (c0 && c1 && c2 && c3) return FIST;
  if (e0 && e1 && c2 && c3) return PEACE;
  if (e0 && c1 && c2 && c3) return POINT;
  return OTHER;
}

/** Pinch: thumb tip touching the index tip (not a fist, where they are also close). */
export function pinched(lm) {
  if (!lm) return false;
  return d(lm[THUMB_TIP], lm[8]) / handScale(lm) < 0.32 && classify(lm) !== FIST;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** How open the hand is, 0 = tight fist .. 1 = fully open (fingers 80 %, thumb 20 %). */
export function openness(lm) {
  if (!lm) return 0;
  let f = 0;
  for (let i = 0; i < 4; i++) {
    const ratio = d(lm[TIPS[i]], lm[WRIST]) / Math.max(d(lm[MCPS[i]], lm[WRIST]), 1e-6);
    f += clamp01((ratio - 1.05) / (1.75 - 1.05));
  }
  const thumb = clamp01((d(lm[THUMB_TIP], lm[17]) / handScale(lm) - 0.9) / (1.55 - 0.9));
  return 0.8 * (f / 4) + 0.2 * thumb;
}

/** A pose must be seen for `hold` consecutive frames before it becomes the stable pose. */
export class PoseDebouncer {
  constructor(hold = 3, holdFor = {}) {
    this.hold = hold; this.holdFor = holdFor;
    this.stable = NONE; this.cand = NONE; this.n = 0;
  }
  update(pose) {
    if (pose === this.cand) this.n += 1;
    else { this.cand = pose; this.n = 1; }
    let changed = false;
    if (this.n >= (this.holdFor[pose] ?? this.hold) && pose !== this.stable) { this.stable = pose; changed = true; }
    return [this.stable, changed];
  }
}
