import { N_KEYPOINTS, STRIDE } from './poseFormat.js';

/**
 * One Euro filter: adaptive low-pass that smooths jitter when still but
 * tracks fast movement with low lag — ideal for dance.
 * https://gery.casiez.net/1euro/
 */
class OneEuro {
  constructor(minCutoff = 1.5, beta = 0.05, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, tMs) {
    if (this.x === null) {
      this.x = x;
      this.t = tMs;
      return x;
    }
    const dt = Math.max((tMs - this.t) / 1000, 1e-3);
    this.t = tMs;
    const dxRaw = (x - this.x) / dt;
    const aD = OneEuro.alpha(this.dCutoff, dt);
    this.dx = aD * dxRaw + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = OneEuro.alpha(cutoff, dt);
    this.x = a * x + (1 - a) * this.x;
    return this.x;
  }

  reset() { this.x = null; this.dx = 0; this.t = null; }
}

/** Smooths every coordinate of a PoseFrame in place. */
export class PoseSmoother {
  constructor() {
    // x and y get full smoothing; z is noisier so smooth it harder.
    this.filters = [];
    for (let i = 0; i < N_KEYPOINTS; i++) {
      this.filters.push([
        new OneEuro(1.5, 0.3),  // x
        new OneEuro(1.5, 0.3),  // y
        new OneEuro(0.5, 0.05), // z
      ]);
    }
  }

  apply(frame) {
    for (let i = 0; i < N_KEYPOINTS; i++) {
      const o = i * STRIDE;
      const f = this.filters[i];
      frame.keypoints[o] = f[0].filter(frame.keypoints[o], frame.t);
      frame.keypoints[o + 1] = f[1].filter(frame.keypoints[o + 1], frame.t);
      frame.keypoints[o + 2] = f[2].filter(frame.keypoints[o + 2], frame.t);
    }
    return frame;
  }

  reset() {
    for (const f of this.filters) f.forEach((c) => c.reset());
  }
}
