// One-Euro filter (Casiez, Roussel & Vogel 2012): a low-pass whose cutoff rises with the signal's
// speed — heavy smoothing while the hand holds still, almost no lag while it moves fast.
const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export class OneEuro {
  constructor({ minCutoff = 1, beta = 0, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = 0; this.dx = 0; this.t = 0; this.ready = false;
  }

  reset() { this.ready = false; }

  filter(v, t) {
    if (!this.ready) { this.x = v; this.dx = 0; this.t = t; this.ready = true; return v; }
    const dt = t - this.t;
    if (dt <= 0) return this.x;
    this.t = t;
    this.dx += ((v - this.x) / dt - this.dx) * alpha(this.dCutoff, dt);
    this.x += (v - this.x) * alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    return this.x;
  }
}
