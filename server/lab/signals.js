import { KP, STRIDE } from '../../src/pose/poseFormat.js';

/**
 * Per-body-part signal extraction from a PoseFrame sequence.
 *
 * The production BeatDetector collapses the whole body into ONE scalar
 * (weighted joint speed) before any frequency analysis — so the fastest,
 * biggest-moving limb dominates and slower layers (hips, weight shifts)
 * are drowned out. The lab instead extracts channels per part:
 *
 *  - `pos`: detrended x/y position series per joint. Oscillation shows up
 *    at its TRUE frequency (a 0.5 Hz sway is a 0.5 Hz line).
 *  - `speed`: mean joint speed per part — what the detector actually sees.
 *    |velocity| peaks twice per cycle, so the same sway reads at 1 Hz here
 *    (the octave-doubling bias under investigation).
 */

export const PARTS = {
  arms: [KP.LEFT_WRIST, KP.RIGHT_WRIST, KP.LEFT_ELBOW, KP.RIGHT_ELBOW],
  legs: [KP.LEFT_ANKLE, KP.RIGHT_ANKLE, KP.LEFT_KNEE, KP.RIGHT_KNEE],
  hips: [KP.LEFT_HIP, KP.RIGHT_HIP],
  head: [KP.NOSE],
};
PARTS.all = [...new Set(Object.values(PARTS).flat())];

// Shoulders ride along for torso-length normalization.
const GRID_JOINTS = [...new Set([...PARTS.all, KP.LEFT_SHOULDER, KP.RIGHT_SHOULDER])];

export const SAMPLE_HZ = 30;

/**
 * Resample frames onto a uniform grid: per joint, x[] and y[] arrays.
 * Returns { hz, t0, n, x: Map<joint, Float32Array>, y: Map<joint, ...> }.
 */
export function resample(frames, joints = GRID_JOINTS, hz = SAMPLE_HZ) {
  const t0 = frames[0].t;
  const t1 = frames[frames.length - 1].t;
  const n = Math.floor(((t1 - t0) / 1000) * hz) + 1;
  const x = new Map();
  const y = new Map();
  for (const j of joints) {
    x.set(j, new Float32Array(n));
    y.set(j, new Float32Array(n));
  }
  let k = 0;
  for (let s = 0; s < n; s++) {
    const t = t0 + (s / hz) * 1000;
    while (k < frames.length - 2 && frames[k + 1].t <= t) k++;
    const a = frames[k];
    const b = frames[Math.min(k + 1, frames.length - 1)];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    for (const j of joints) {
      const o = j * STRIDE;
      x.get(j)[s] = a.keypoints[o] + f * (b.keypoints[o] - a.keypoints[o]);
      y.get(j)[s] = a.keypoints[o + 1] + f * (b.keypoints[o + 1] - a.keypoints[o + 1]);
    }
  }
  return { hz, t0, n, x, y };
}

/** Subtract a moving average (window seconds) — removes drift/stance. */
export function detrend(series, hz, windowS = 2) {
  const w = Math.max(1, Math.round(windowS * hz));
  const out = new Float32Array(series.length);
  let acc = 0;
  const q = [];
  for (let i = 0; i < series.length; i++) {
    acc += series[i];
    q.push(series[i]);
    if (q.length > w) acc -= q.shift();
    out[i] = series[i] - acc / q.length;
  }
  return out;
}

/**
 * Position channel for a part: detrended x and y series for each joint.
 * Spectra are computed per series and summed, so oscillation along any
 * axis registers at its true frequency.
 */
export function positionChannel(grid, part) {
  const series = [];
  for (const j of PARTS[part]) {
    series.push(detrend(grid.x.get(j), grid.hz));
    series.push(detrend(grid.y.get(j), grid.hz));
  }
  return series;
}

/**
 * Speed channel for a part: one series, mean |velocity| across the part's
 * joints, torso-normalized — mirrors BeatDetector's energy definition.
 */
export function speedChannel(grid, part) {
  const joints = PARTS[part];
  const out = new Float32Array(grid.n);
  const lsx = grid.x.get(KP.LEFT_SHOULDER) ?? grid.x.get(KP.LEFT_HIP);
  const lsy = grid.y.get(KP.LEFT_SHOULDER) ?? grid.y.get(KP.LEFT_HIP);
  const lhx = grid.x.get(KP.LEFT_HIP);
  const lhy = grid.y.get(KP.LEFT_HIP);
  for (let s = 1; s < grid.n; s++) {
    let sum = 0;
    for (const j of joints) {
      const dx = grid.x.get(j)[s] - grid.x.get(j)[s - 1];
      const dy = grid.y.get(j)[s] - grid.y.get(j)[s - 1];
      sum += Math.hypot(dx, dy) * grid.hz;
    }
    const torso = lsx && lhx
      ? Math.hypot(lsx[s] - lhx[s], lsy[s] - lhy[s]) || 0.25
      : 0.25;
    out[s] = sum / joints.length / torso;
  }
  out[0] = out[1] ?? 0;
  return [out];
}
