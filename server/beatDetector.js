import { KP, getKeypoint } from '../src/pose/poseFormat.js';
import { dominantTempo, tempoGap } from './tempo.js';

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
// Before a tempo is reported at all ("locking"): people opening the app
// aren't dancing yet — setting the phone down and stepping back reads as a
// confident, steady and wrong tempo. So the last LOCK_N estimates must
// agree (within LOCK_GAP, half/double time being one groove) and the
// movement must be even across a full window, with the same beat in its
// recent half on its own (dancing now, not a few steps up to the phone and
// then standing still).
const LOCK_N = 3;
const LOCK_GAP = 0.1;
const MIN_MOVE = 0.05;          // window mean energy (torso-lengths/s) below which nobody is dancing
const MAX_UNEVEN = 3;           // louder half of the window ÷ quieter half

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
 *  4. No tempo is reported until it has locked: the last few estimates
 *     agree and the movement is steady (see LOCK_N) — until then `warming`
 *     says someone is moving but we don't trust a tempo yet.
 *  5. Beats are marked at energy peaks (adaptive threshold), which also
 *     gives beat phase for future cross-dancer sync.
 *
 * Output (`.state`): { bpm, confidence, lastBeatAt, energy, warming }
 */
export class BeatDetector {
  /** lock=false: report from the first estimate (rating library clips, which are dancing from the first frame). */
  constructor({ lock = true } = {}) {
    this.lock = lock;
    this.prevFrame = null;
    this.samples = [];       // { t, e } raw energy samples
    this.grid = [];          // uniform 30 Hz energy values
    this.gridStartT = null;
    this.lastAnalysis = 0;
    this.emaEnergy = 0;
    this.emaAbsDev = 0.05;
    this.recent = [];        // last raw estimates (bpm, 0 = none), for locking
    this.state = { bpm: 0, confidence: 0, lastBeatAt: null, energy: 0, warming: false };
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
    this.recent = [];
    this.state = { bpm: 0, confidence: 0, lastBeatAt: null, energy: 0, warming: false };
  }

  /** Weighted joint speed, normalized by torso length (body-size invariant). */
  #motionEnergy(frame, prev, dt) {
    const ls = getKeypoint(frame, KP.LEFT_SHOULDER);
    const lh = getKeypoint(frame, KP.LEFT_HIP);
    // Hips out of frame (close to the camera): size from the shoulders.
    const rs = getKeypoint(frame, KP.RIGHT_SHOULDER);
    const torso = (lh.v >= 0.4 ? Math.hypot(ls.x - lh.x, ls.y - lh.y) : 1.3 * Math.hypot(ls.x - rs.x, ls.y - rs.y)) || 0.25;

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

  /** Autocorrelation of the energy signal → dominant tempo (see tempo.js), once locked. */
  #analyzeTempo() {
    if (this.grid.length < SAMPLE_HZ * 3) return; // need ≥3s of motion
    const { bpm, confidence, flat } = dominantTempo(this.grid, SAMPLE_HZ, { minBpm: MIN_BPM, maxBpm: MAX_BPM });
    this.recent.push(confidence >= 0.3 ? bpm : 0);
    if (this.recent.length > LOCK_N) this.recent.shift();
    const moving = this.#steadyMovement();
    if (flat) {
      this.state.bpm = 0;
      this.state.confidence = 0;
    } else if (!this.state.bpm) {
      // Not locked: report nothing until the estimates agree while dancing.
      const agreed = this.lock && moving ? this.#agreed() : 0;
      const lock = this.lock ? (agreed && this.#recentlyAt(agreed) ? agreed : 0) : bpm;
      if (lock) {
        this.state.bpm = lock;
        this.state.confidence = confidence;
      }
    } else if (bpm > 0) {
      // Smooth tempo estimate to avoid HUD flicker.
      this.state.bpm = this.state.bpm * 0.7 + bpm * 0.3;
      this.state.confidence = confidence;
    } else {
      this.state.confidence *= 0.8;
      if (this.state.confidence < 0.1) this.state.bpm = 0;
    }
    this.state.warming = moving !== null && !this.state.bpm;
  }

  /**
   * Is the window someone dancing? true: moving, evenly; false: moving but
   * unevenly (walking up, settling in); null: not moving at all.
   */
  #steadyMovement() {
    const g = this.grid;
    const half = Math.floor(g.length / 2);
    let a = 0;
    let b = 0;
    for (let i = 0; i < half; i++) a += g[i];
    for (let i = half; i < g.length; i++) b += g[i];
    a /= half;
    b /= g.length - half;
    if ((a + b) / 2 < MIN_MOVE) return null;
    if (g.length < WINDOW_S * SAMPLE_HZ) return false; // not a full window yet
    return Math.max(a, b) / Math.max(1e-6, Math.min(a, b)) <= MAX_UNEVEN;
  }

  /** Does the recent half of the window, on its own, beat at `bpm`? */
  #recentlyAt(bpm) {
    const recent = this.grid.slice(-Math.floor(this.grid.length / 2));
    const r = dominantTempo(recent, SAMPLE_HZ, { minBpm: MIN_BPM, maxBpm: MAX_BPM });
    return r.bpm > 0 && r.confidence >= 0.3 && tempoGap(r.bpm, bpm) <= LOCK_GAP;
  }

  /** The median of the last LOCK_N estimates if they all agree with it, else 0. */
  #agreed() {
    if (this.recent.length < LOCK_N || this.recent.some((b) => !b)) return 0;
    const mid = [...this.recent].sort((x, y) => x - y)[LOCK_N >> 1];
    return this.recent.every((b) => tempoGap(b, mid) <= LOCK_GAP) ? mid : 0;
  }
}
