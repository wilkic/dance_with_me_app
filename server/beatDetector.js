import { KP, getKeypoint } from '../src/pose/poseFormat.js';

// Joints that carry the most rhythmic information, weighted accordingly.
const TRACKED = [
  { i: KP.LEFT_WRIST, w: 1.0 },
  { i: KP.RIGHT_WRIST, w: 1.0 },
  { i: KP.LEFT_ANKLE, w: 1.0 },
  { i: KP.RIGHT_ANKLE, w: 1.0 },
  { i: KP.LEFT_ELBOW, w: 0.5 },
  { i: KP.RIGHT_ELBOW, w: 0.5 },
  { i: KP.LEFT_KNEE, w: 0.5 },
  { i: KP.RIGHT_KNEE, w: 0.5 },
  { i: KP.NOSE, w: 0.7 },
  { i: KP.LEFT_HIP, w: 0.7 },
  { i: KP.RIGHT_HIP, w: 0.7 },
];

const SAMPLE_HZ = 30;           // uniform grid the energy signal is resampled to
const WINDOW_S = 6;             // analysis window
const MIN_BPM = 50;
const MAX_BPM = 200;

/**
 * BeatDetector: estimates tempo and beats purely from body motion — no
 * audio. This is the seed of the Phase 3+ rhythm engine.
 *
 * How it works:
 *  1. Each PoseFrame contributes a scalar "motion energy" (weighted joint
 *     speeds, normalized by body size so distance from camera doesn't
 *     matter).
 *  2. The energy signal is resampled onto a uniform 30 Hz grid.
 *  3. About once a second, autocorrelation over a 6 s window finds the
 *     dominant repetition period in the 50–200 BPM range → tempo +
 *     confidence.
 *  4. Beats are marked at energy peaks (adaptive threshold), which also
 *     gives beat phase for future cross-dancer sync.
 *
 * Output (`.state`): { bpm, confidence, lastBeatAt, energy }
 */
export class BeatDetector {
  constructor() {
    this.prevFrame = null;
    this.samples = [];       // { t, e } raw energy samples
    this.grid = [];          // uniform 30 Hz energy values
    this.gridStartT = null;
    this.lastAnalysis = 0;
    this.emaEnergy = 0;
    this.emaAbsDev = 0.05;
    this.state = { bpm: 0, confidence: 0, lastBeatAt: null, energy: 0 };
  }

  update(frame) {
    if (this.prevFrame) {
      const dt = (frame.t - this.prevFrame.t) / 1000;
      if (dt > 0 && dt < 0.5) {
        const e = this.#motionEnergy(frame, this.prevFrame, dt);
        this.state.energy = e;
        this.#pushSample(frame.t, e);
        this.#detectBeat(frame.t, e);
        if (frame.t - this.lastAnalysis > 1000) {
          this.lastAnalysis = frame.t;
          this.#analyzeTempo();
        }
      }
    }
    this.prevFrame = { t: frame.t, keypoints: frame.keypoints.slice() };
    return this.state;
  }

  reset() {
    this.prevFrame = null;
    this.samples = [];
    this.grid = [];
    this.gridStartT = null;
    this.state = { bpm: 0, confidence: 0, lastBeatAt: null, energy: 0 };
  }

  /** Weighted joint speed, normalized by torso length (body-size invariant). */
  #motionEnergy(frame, prev, dt) {
    const ls = getKeypoint(frame, KP.LEFT_SHOULDER);
    const lh = getKeypoint(frame, KP.LEFT_HIP);
    const torso = Math.hypot(ls.x - lh.x, ls.y - lh.y) || 0.25;

    let sum = 0;
    let wsum = 0;
    for (const { i, w } of TRACKED) {
      const a = getKeypoint(frame, i);
      const o = i * 4;
      const pv = prev.keypoints[o + 3];
      if (a.v < 0.4 || pv < 0.4) continue;
      const dx = a.x - prev.keypoints[o];
      const dy = a.y - prev.keypoints[o + 1];
      sum += (w * Math.hypot(dx, dy)) / dt;
      wsum += w;
    }
    if (wsum === 0) return 0;
    return sum / wsum / torso; // torso-lengths per second
  }

  #pushSample(t, e) {
    this.samples.push({ t, e });
    if (this.gridStartT === null) this.gridStartT = t;
    // Resample onto uniform grid via linear interpolation.
    const step = 1000 / SAMPLE_HZ;
    let nextT = this.gridStartT + this.grid.length * step;
    while (this.samples.length >= 2 && nextT <= t) {
      let k = this.samples.length - 2;
      while (k > 0 && this.samples[k].t > nextT) k--;
      const s0 = this.samples[k];
      const s1 = this.samples[k + 1];
      const f = Math.min(1, Math.max(0, (nextT - s0.t) / Math.max(1, s1.t - s0.t)));
      this.grid.push(s0.e + f * (s1.e - s0.e));
      nextT += step;
    }
    // Trim buffers to the analysis window.
    const maxGrid = WINDOW_S * SAMPLE_HZ;
    if (this.grid.length > maxGrid) {
      const drop = this.grid.length - maxGrid;
      this.grid.splice(0, drop);
      this.gridStartT += drop * step;
    }
    while (this.samples.length > 4 && this.samples[1].t < this.gridStartT) {
      this.samples.shift();
    }
  }

  /** Mark a beat when energy spikes above an adaptive threshold. */
  #detectBeat(t, e) {
    const a = 0.05;
    this.emaEnergy += a * (e - this.emaEnergy);
    this.emaAbsDev += a * (Math.abs(e - this.emaEnergy) - this.emaAbsDev);
    const threshold = this.emaEnergy + 1.2 * this.emaAbsDev;
    const refractory = this.state.bpm > 0 ? (60000 / this.state.bpm) * 0.6 : 250;
    const sinceLast = this.state.lastBeatAt ? t - this.state.lastBeatAt : Infinity;
    if (e > threshold && sinceLast > refractory) {
      this.state.lastBeatAt = t;
    }
  }

  /** Autocorrelation of the energy signal → dominant tempo. */
  #analyzeTempo() {
    const n = this.grid.length;
    if (n < SAMPLE_HZ * 3) return; // need ≥3s of motion

    const mean = this.grid.reduce((s, v) => s + v, 0) / n;
    const sig = this.grid.map((v) => v - mean);
    const norm = sig.reduce((s, v) => s + v * v, 0);
    if (norm < 1e-6) {
      this.state.bpm = 0;
      this.state.confidence = 0;
      return;
    }

    const minLag = Math.round((60 / MAX_BPM) * SAMPLE_HZ);
    const maxLag = Math.min(Math.round((60 / MIN_BPM) * SAMPLE_HZ), n - 1);
    let bestLag = 0;
    let bestVal = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = 0; i + lag < n; i++) acc += sig[i] * sig[i + lag];
      const val = acc / norm;
      if (val > bestVal) {
        bestVal = val;
        bestLag = lag;
      }
    }

    if (bestLag > 0 && bestVal > 0.15) {
      const bpm = 60 / (bestLag / SAMPLE_HZ);
      // Smooth tempo estimate to avoid HUD flicker.
      this.state.bpm = this.state.bpm > 0
        ? this.state.bpm * 0.7 + bpm * 0.3
        : bpm;
      this.state.confidence = bestVal;
    } else {
      this.state.confidence *= 0.8;
      if (this.state.confidence < 0.1) this.state.bpm = 0;
    }
  }
}
