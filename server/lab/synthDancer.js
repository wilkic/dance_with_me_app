import { emptyPoseFrame, KP, STRIDE } from '../../src/pose/poseFormat.js';

/**
 * Synthetic multi-frequency dancer for the dance lab.
 *
 * Real dancers layer frequencies: hips carry the groove, arms flourish on
 * top, feet step somewhere in between. Each body part here is a sinusoidal
 * oscillator with its own POSITION frequency (hz), amplitude (in normalized
 * image units), axis, and phase.
 *
 * Frequency convention (matches test/synthetic.js): motion *energy* is
 * joint speed, and |velocity| of a sinusoid peaks twice per position cycle,
 * so a part oscillating at P Hz shows up in the detector's energy signal at
 * 2P Hz → beatBpm = 120 * P. Helpers below convert both ways.
 */

export const beatBpmOfPosHz = (hz) => 120 * hz;
export const posHzOfBeatBpm = (bpm) => bpm / 120;

// Rest pose: a person standing centered, torso length 0.3.
const REST = {
  [KP.NOSE]: [0.5, 0.15],
  [KP.LEFT_SHOULDER]: [0.42, 0.3],
  [KP.RIGHT_SHOULDER]: [0.58, 0.3],
  [KP.LEFT_ELBOW]: [0.38, 0.42],
  [KP.RIGHT_ELBOW]: [0.62, 0.42],
  [KP.LEFT_WRIST]: [0.34, 0.5],
  [KP.RIGHT_WRIST]: [0.66, 0.5],
  [KP.LEFT_HIP]: [0.44, 0.6],
  [KP.RIGHT_HIP]: [0.56, 0.6],
  [KP.LEFT_KNEE]: [0.44, 0.75],
  [KP.RIGHT_KNEE]: [0.56, 0.75],
  [KP.LEFT_ANKLE]: [0.44, 0.92],
  [KP.RIGHT_ANKLE]: [0.56, 0.92],
};

// Which joints each part's oscillator drives, with per-joint gain and
// left/right sign (arms and legs alternate, hips/head move as one).
const PART_JOINTS = {
  arms: [
    { i: KP.LEFT_WRIST, gain: 1, sign: 1 },
    { i: KP.RIGHT_WRIST, gain: 1, sign: -1 },
    { i: KP.LEFT_ELBOW, gain: 0.5, sign: 1 },
    { i: KP.RIGHT_ELBOW, gain: 0.5, sign: -1 },
  ],
  legs: [
    { i: KP.LEFT_ANKLE, gain: 1, sign: 1 },
    { i: KP.RIGHT_ANKLE, gain: 1, sign: -1 },
    { i: KP.LEFT_KNEE, gain: 0.5, sign: 1 },
    { i: KP.RIGHT_KNEE, gain: 0.5, sign: -1 },
  ],
  hips: [
    { i: KP.LEFT_HIP, gain: 1, sign: 1 },
    { i: KP.RIGHT_HIP, gain: 1, sign: 1 },
    { i: KP.LEFT_SHOULDER, gain: 0.4, sign: 1 },
    { i: KP.RIGHT_SHOULDER, gain: 0.4, sign: 1 },
  ],
  head: [{ i: KP.NOSE, gain: 1, sign: 1 }],
};

/**
 * spec: { parts: { arms: { hz, amp, axis?, phase? }, hips: {...}, ... },
 *         noise? } — noise is per-frame gaussian keypoint jitter (σ in
 * normalized units), simulating pose-detector wobble.
 */
export function makeDancer(spec) {
  const parts = Object.entries(spec.parts ?? {});
  const noise = spec.noise ?? 0;

  // Seeded RNG (mulberry32) so noisy scenarios are reproducible run to run.
  let seed = spec.seed ?? 0x9e3779b9;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    // Box–Muller; fine for test jitter.
    const u = rand() || 1e-9;
    const v = rand() || 1e-9;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  return {
    spec,
    frameAt(tMs) {
      const f = emptyPoseFrame();
      f.t = tMs;
      for (const [i, [x, y]] of Object.entries(REST)) {
        const o = i * STRIDE;
        f.keypoints[o] = x;
        f.keypoints[o + 1] = y;
        f.keypoints[o + 3] = 1;
      }
      for (const [name, p] of parts) {
        const s = Math.sin(2 * Math.PI * p.hz * (tMs / 1000) + (p.phase ?? 0));
        const axis = p.axis === 'x' ? 0 : 1;
        for (const { i, gain, sign } of PART_JOINTS[name]) {
          f.keypoints[i * STRIDE + axis] += p.amp * gain * sign * s;
        }
      }
      if (noise > 0) {
        for (const i of Object.keys(REST)) {
          const o = i * STRIDE;
          f.keypoints[o] += noise * gauss();
          f.keypoints[o + 1] += noise * gauss();
        }
      }
      return f;
    },
    /** All frames for a session: durationS at fps, starting at t=0. */
    frames(durationS, fps = 30) {
      const out = [];
      const step = 1000 / fps;
      for (let t = 0; t <= durationS * 1000; t += step) out.push(this.frameAt(t));
      return out;
    },
  };
}
