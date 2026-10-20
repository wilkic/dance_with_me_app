/**
 * Movement style, from keypoints alone.
 *
 * Everything the AI dancers do starts here: a pose is first moved into
 * "body space" — pelvis-centred, aspect-corrected and measured in torso
 * lengths — so a dancer filmed far away in a landscape video and a kid
 * on a propped-up phone compare like for like. A clip's *style* is then
 * a small vector of how much each body part travels and how fast, which
 * is enough to tell a hip-led groove from arm-led popping without any
 * music. When music is present its tempo joins in (see tempo.js), but
 * the descriptor itself never needs a sound.
 */
import { KP, STRIDE, N_KEYPOINTS } from '../src/pose/poseFormat.js';

export const PARTS = {
  arms: [KP.LEFT_WRIST, KP.RIGHT_WRIST, KP.LEFT_ELBOW, KP.RIGHT_ELBOW],
  legs: [KP.LEFT_ANKLE, KP.RIGHT_ANKLE, KP.LEFT_KNEE, KP.RIGHT_KNEE],
  hips: [KP.LEFT_HIP, KP.RIGHT_HIP],
  head: [KP.NOSE],
};

/** Joint → the joint it hangs off (used when borrowing a limb's moves). */
export const ANCHOR = {
  [KP.LEFT_ELBOW]: KP.LEFT_SHOULDER, [KP.LEFT_WRIST]: KP.LEFT_SHOULDER,
  [KP.RIGHT_ELBOW]: KP.RIGHT_SHOULDER, [KP.RIGHT_WRIST]: KP.RIGHT_SHOULDER,
  [KP.LEFT_KNEE]: KP.LEFT_HIP, [KP.LEFT_ANKLE]: KP.LEFT_HIP,
  [KP.LEFT_HEEL]: KP.LEFT_HIP, [KP.LEFT_FOOT]: KP.LEFT_HIP,
  [KP.RIGHT_KNEE]: KP.RIGHT_HIP, [KP.RIGHT_ANKLE]: KP.RIGHT_HIP,
  [KP.RIGHT_HEEL]: KP.RIGHT_HIP, [KP.RIGHT_FOOT]: KP.RIGHT_HIP,
};

/** Left/right joint pairs (MediaPipe topology), for mirroring a clip. */
export const MIRROR_PAIRS = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16],
  [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];

export const MIN_VIS = 0.5;
export const STYLE_DIMS = ['arms', 'legs', 'hips', 'head', 'armsSpeed', 'legsSpeed'];

/** True when shoulders and hips are all confidently visible. */
export function torsoVisible(kp) {
  return [KP.LEFT_SHOULDER, KP.RIGHT_SHOULDER, KP.LEFT_HIP, KP.RIGHT_HIP]
    .every((j) => kp[j * STRIDE + 3] >= MIN_VIS);
}

/**
 * Pose → body space. `aspect` is the source image's width/height, so x is
 * measured in the same units as y. Returns null if the torso isn't visible.
 *   { X, Y, V: Float32Array(33), torso, cx, cy }  (X/Y in torso lengths,
 *   relative to the pelvis; cx/cy = pelvis in normalized image coords)
 */
export function toBodySpace(kp, aspect = 1, center = null, torsoLen = null) {
  if (!torsoVisible(kp)) return null;
  const px = (j) => kp[j * STRIDE] * aspect;
  const py = (j) => kp[j * STRIDE + 1];
  const neckX = (px(KP.LEFT_SHOULDER) + px(KP.RIGHT_SHOULDER)) / 2;
  const neckY = (py(KP.LEFT_SHOULDER) + py(KP.RIGHT_SHOULDER)) / 2;
  const pelX = (px(KP.LEFT_HIP) + px(KP.RIGHT_HIP)) / 2;
  const pelY = (py(KP.LEFT_HIP) + py(KP.RIGHT_HIP)) / 2;
  const torso = torsoLen ?? Math.max(1e-3, Math.hypot(neckX - pelX, neckY - pelY));
  const cx = center ? center.x : pelX;
  const cy = center ? center.y : pelY;
  const X = new Float32Array(N_KEYPOINTS);
  const Y = new Float32Array(N_KEYPOINTS);
  const V = new Float32Array(N_KEYPOINTS);
  for (let j = 0; j < N_KEYPOINTS; j++) {
    X[j] = (px(j) - cx) / torso;
    Y[j] = (py(j) - cy) / torso;
    V[j] = kp[j * STRIDE + 3];
  }
  return { X, Y, V, torso, cx: pelX, cy: pelY };
}

/**
 * Style descriptor of a frame sequence: per part, RMS excursion around the
 * part's mean position (torso lengths) and, for arms/legs, mean speed
 * (torso lengths per second). Also reports pose coverage (fraction of
 * frames with a visible torso). Frames: [{ t, keypoints }].
 */
export function styleOf(frames, aspect = 1) {
  const body = [];
  for (const f of frames) {
    const b = toBodySpace(f.keypoints, aspect);
    if (b) body.push({ t: f.t, ...b });
  }
  const coverage = frames.length ? body.length / frames.length : 0;
  const vec = new Array(STYLE_DIMS.length).fill(0);
  if (body.length < 10) return { vector: vec, coverage, frames: body.length };

  const excursion = (joints) => {
    let acc = 0;
    let n = 0;
    for (const j of joints) {
      let mx = 0, my = 0, m = 0;
      for (const b of body) if (b.V[j] >= MIN_VIS) { mx += b.X[j]; my += b.Y[j]; m++; }
      if (m < 5) continue;
      mx /= m; my /= m;
      let s = 0;
      for (const b of body) if (b.V[j] >= MIN_VIS) s += (b.X[j] - mx) ** 2 + (b.Y[j] - my) ** 2;
      acc += Math.sqrt(s / m);
      n++;
    }
    return n ? acc / n : 0;
  };
  const speed = (joints) => {
    let acc = 0;
    let n = 0;
    for (let i = 1; i < body.length; i++) {
      const a = body[i - 1];
      const b = body[i];
      const dt = (b.t - a.t) / 1000;
      if (dt <= 0 || dt > 0.5) continue;
      for (const j of joints) {
        if (a.V[j] < MIN_VIS || b.V[j] < MIN_VIS) continue;
        acc += Math.hypot(b.X[j] - a.X[j], b.Y[j] - a.Y[j]) / dt;
        n++;
      }
    }
    return n ? acc / n : 0;
  };
  vec[0] = excursion(PARTS.arms);
  vec[1] = excursion(PARTS.legs);
  vec[2] = excursion(PARTS.hips);
  vec[3] = excursion(PARTS.head);
  vec[4] = speed(PARTS.arms);
  vec[5] = speed(PARTS.legs);
  return { vector: vec.map((v) => +v.toFixed(4)), coverage: +coverage.toFixed(3), frames: body.length };
}

/**
 * How much a dancer moves, from a style vector: mean limb speed (torso
 * lengths per second), arms and legs counted equally, arms alone when no
 * legs are seen. Same mix as clipEnergy() in aiDancer.js.
 */
export function energyOf(vector) {
  if (!vector) return 0;
  const arms = vector[4] ?? 0;
  const legs = vector[5] ?? 0;
  return legs > 0 ? (arms + legs) / 2 : arms;
}

/** Distance between two style vectors (log-compressed so calm vs wild is fair). */
export function styleDistance(a, b) {
  if (!a || !b) return 1;
  let s = 0;
  for (let i = 0; i < STYLE_DIMS.length; i++) {
    s += (Math.log1p(3 * (a[i] ?? 0)) - Math.log1p(3 * (b[i] ?? 0))) ** 2;
  }
  return Math.sqrt(s);
}

/**
 * Live style: keeps the last `windowMs` of a dancer's frames and answers
 * with the same descriptor the library uses, so "dancers like you" means
 * the same thing for a person and for a clip.
 */
export class StyleWindow {
  constructor({ windowMs = 8000, aspect = 9 / 16 } = {}) {
    this.windowMs = windowMs;
    this.aspect = aspect;
    this.frames = [];
    this.cached = null;
    this.cachedAt = -Infinity;
  }

  push(frame) {
    this.frames.push({ t: frame.t, keypoints: frame.keypoints });
    const cutoff = frame.t - this.windowMs;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
  }

  /** Style vector of the recent window (null until ~2 s of visible pose). */
  get vector() {
    const last = this.frames[this.frames.length - 1]?.t ?? 0;
    if (last - this.cachedAt > 1000) {
      const s = styleOf(this.frames, this.aspect);
      this.cached = s.frames >= 40 ? s.vector : null;
      this.cachedAt = last;
    }
    return this.cached;
  }
}
