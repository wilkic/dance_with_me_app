/**
 * A made-up dancer for looking at figure styles without a camera
 * (avatar/preview.js): a jointed puppet cycling through a few moves on a
 * beat, giving PoseFrames with everything a real one has — including the
 * finger, heel and toe points that hands and feet are drawn from.
 */
import { emptyPoseFrame, KP, STRIDE } from '../pose/poseFormat.js';

const D = Math.PI / 180;
// Joint angles in degrees: 0 hangs straight down, 90 points out to the
// side, 180 straight up. [upper arm, forearm, hand, thigh, shin, foot]
// per side, plus lean (torso), tilt (head), bounce and sway.
const MOVES = [
  // Hands in the air, waving side to side.
  (s, c) => ({ L: [150 + 12 * s, 185 + 25 * s, 185 + 45 * s, 6, -2, 75], R: [150 - 12 * s, 185 - 25 * s, 185 - 45 * s, 6, -2, 75], lean: 5 * s, tilt: 8 * s, bounce: Math.abs(c), sway: 0.25 * s }),
  // Disco: one arm up and out, the other down across the hip, swapping.
  (s, c) => ({ L: [95 + 60 * s, 110 + 75 * s, 110 + 90 * s, 10 + 6 * s, -4, 80], R: [95 - 60 * s, 110 - 75 * s, 110 - 90 * s, 10 - 6 * s, -4, 80], lean: -7 * s, tilt: -10 * s, bounce: Math.abs(s), sway: -0.3 * s }),
  // Pumping elbows, knees coming up in turn.
  (s, c) => ({ L: [40 + 25 * s, 150 - 40 * s, 160 - 40 * s, 14 + 32 * Math.max(0, s), -6 - 40 * Math.max(0, s), 70 - 30 * Math.max(0, s)], R: [40 - 25 * s, 150 + 40 * s, 160 + 40 * s, 14 + 32 * Math.max(0, -s), -6 - 40 * Math.max(0, -s), 70 - 30 * Math.max(0, -s)], lean: 3 * s, tilt: 4 * c, bounce: Math.abs(c), sway: 0.1 * s }),
  // Arms wide, rolling like a wave from one hand to the other.
  (s, c) => ({ L: [92 + 22 * s, 95 + 40 * c, 95 + 70 * c, 16, -6, 80], R: [92 - 22 * s, 95 - 40 * c, 95 - 70 * c, 16, -6, 80], lean: 9 * s, tilt: 12 * s, bounce: 0.5 * Math.abs(s), sway: 0.45 * s }),
];
const mix = (a, b, t) => {
  if (typeof a === 'number') return a + (b - a) * t;
  if (Array.isArray(a)) return a.map((v, i) => mix(v, b[i], t));
  return Object.fromEntries(Object.keys(a).map((k) => [k, mix(a[k], b[k], t)]));
};

/**
 * The dancer's PoseFrame at time tMs. Coordinates are normalized to a
 * frame `aspect` wide for 1 high; the dancer's hips rest at (cx, cy) and
 * `size` is the torso length as a fraction of the frame height.
 */
export function demoPose(tMs, { bpm = 112, aspect = 0.75, cx = 0.5, cy = 0.56, size = 0.19 } = {}) {
  const beats = (tMs / 60000) * bpm;
  const ph = beats * Math.PI; // one side-to-side per two beats
  const s = Math.sin(ph), c = Math.cos(ph);
  const BARS = 8; // beats per move
  const at = beats / BARS;
  const i = Math.floor(at) % MOVES.length;
  const f = at - Math.floor(at);
  const blend = f > 0.85 ? (f - 0.85) / 0.15 : 0;
  const k = blend * blend * (3 - 2 * blend);
  const m = mix(MOVES[i](s, c), MOVES[(i + 1) % MOVES.length](s, c), k);

  const frame = emptyPoseFrame();
  frame.t = tMs;
  // Work in torso lengths, y down, then place in the frame.
  const set = (idx, p) => frame.keypoints.set([cx + (p.x * size) / aspect, cy + p.y * size, 0, 1], idx * STRIDE);
  const dir = (deg, side) => ({ x: side * Math.sin(deg * D), y: Math.cos(deg * D) });
  const add = (p, d, len) => ({ x: p.x + d.x * len, y: p.y + d.y * len });

  const pelvis = { x: m.sway, y: -0.1 * m.bounce };
  const up = { x: Math.sin(m.lean * D), y: -Math.cos(m.lean * D) };
  const across = { x: -up.y, y: up.x };
  const neck = add(pelvis, up, 1);
  // Hips tilt against the lean, as they do in a sway.
  const hipLine = { x: Math.cos(-m.lean * 1.6 * D), y: Math.sin(-m.lean * 1.6 * D) };
  const headUp = { x: Math.sin((m.lean + m.tilt) * D), y: -Math.cos((m.lean + m.tilt) * D) };
  const nose = add(neck, headUp, 0.42);
  set(KP.NOSE, nose);
  set(KP.LEFT_EAR, add(nose, { x: -headUp.y, y: headUp.x }, -0.13));
  set(KP.RIGHT_EAR, add(nose, { x: -headUp.y, y: headUp.x }, 0.13));

  for (const [side, a, J] of [
    [-1, m.L, { sh: KP.LEFT_SHOULDER, el: KP.LEFT_ELBOW, wr: KP.LEFT_WRIST, ix: KP.LEFT_INDEX, pk: KP.LEFT_PINKY, hip: KP.LEFT_HIP, kn: KP.LEFT_KNEE, an: KP.LEFT_ANKLE, he: KP.LEFT_HEEL, toe: KP.LEFT_FOOT }],
    [1, m.R, { sh: KP.RIGHT_SHOULDER, el: KP.RIGHT_ELBOW, wr: KP.RIGHT_WRIST, ix: KP.RIGHT_INDEX, pk: KP.RIGHT_PINKY, hip: KP.RIGHT_HIP, kn: KP.RIGHT_KNEE, an: KP.RIGHT_ANKLE, he: KP.RIGHT_HEEL, toe: KP.RIGHT_FOOT }],
  ]) {
    const shoulder = add(neck, across, side * 0.36);
    const elbow = add(shoulder, dir(a[0], side), 0.58);
    const wrist = add(elbow, dir(a[1], side), 0.52);
    const hand = dir(a[2], side);
    const knuckles = add(wrist, hand, 0.2);
    set(J.sh, shoulder); set(J.el, elbow); set(J.wr, wrist);
    set(J.ix, add(knuckles, { x: -hand.y, y: hand.x }, 0.05));
    set(J.pk, add(knuckles, { x: -hand.y, y: hand.x }, -0.05));
    const hip = add(pelvis, hipLine, side * 0.2);
    const knee = add(hip, dir(a[3], side), 0.85);
    const ankle = add(knee, dir(a[4], side), 0.8);
    const foot = dir(a[5], side);
    set(J.hip, hip); set(J.kn, knee); set(J.an, ankle);
    set(J.he, add(ankle, { x: -foot.x * 0.08, y: 0.1 }, 1));
    set(J.toe, add(add(ankle, { x: 0, y: 0.1 }, 1), foot, 0.3));
  }
  return frame;
}
