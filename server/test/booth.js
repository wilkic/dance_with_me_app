/**
 * The DJ booth (src/avatar/booth.js): wherever the DJ is in their own
 * camera, and however big, the figure lands small, up and in the middle.
 */
import assert from 'node:assert/strict';
import { placeAtBooth, BOOTH } from '../../src/avatar/booth.js';
import { bodyAnchors } from '../../src/avatar/stickFigure.js';
import { emptyPoseFrame, KP, STRIDE } from '../../src/pose/poseFormat.js';

let failed = 0;
const test = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.message}`); }
};

const W = 720, H = 1280;
const set = (f, i, x, y, v = 1) => { f.keypoints.set([x, y, 0, v], i * STRIDE); };
/** A standing figure: shoulders at (cx ± w, top), hips `torso` below (hips unseen when hips=false). */
function figure({ cx, top, w, torso, hips = true, t = 0 }) {
  const f = emptyPoseFrame();
  f.t = t;
  set(f, KP.NOSE, cx, top - torso * 0.35);
  set(f, KP.LEFT_SHOULDER, cx - w, top);
  set(f, KP.RIGHT_SHOULDER, cx + w, top);
  set(f, KP.LEFT_HIP, cx - w * 0.7, top + torso, hips ? 1 : 0);
  set(f, KP.RIGHT_HIP, cx + w * 0.7, top + torso, hips ? 1 : 0);
  return f;
}
const near = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const placed = (f) => {
  const b = bodyAnchors(f, W, H);
  return { x: (b.neck.x + b.pelvis.x) / 2 / W, y: (b.neck.y + b.pelvis.y) / 2 / H, torso: b.torsoLen / H };
};

test('a whole body off to one side lands small, up and in the middle', () => {
  const f = figure({ cx: 0.75, top: 0.4, w: 0.08, torso: 0.25 });
  assert.equal(placeAtBooth(f, {}, W, H), true);
  const p = placed(f);
  near(p.x, BOOTH.x); near(p.y, BOOTH.y); near(p.torso, BOOTH.torso);
});

test('head and shoulders at a laptop lands at the same place and size', () => {
  const f = figure({ cx: 0.4, top: 0.7, w: 0.3, torso: 0.5, hips: false });
  assert.equal(placeAtBooth(f, {}, W, H), true);
  const p = placed(f);
  near(p.x, BOOTH.x); near(p.y, BOOTH.y); near(p.torso, BOOTH.torso);
});

test('dancing survives, wandering does not', () => {
  const st = {};
  placeAtBooth(figure({ cx: 0.3, top: 0.4, w: 0.08, torso: 0.25, t: 0 }), st, W, H);
  // A quick step to the side shows at the booth…
  const step = figure({ cx: 0.4, top: 0.4, w: 0.08, torso: 0.25, t: 33 });
  placeAtBooth(step, st, W, H);
  assert.ok(placed(step).x > BOOTH.x + 0.02);
  // …but having stood there for a while, they're back in the middle.
  let f;
  for (let t = 66; t < 10_000; t += 33) placeAtBooth((f = figure({ cx: 0.4, top: 0.4, w: 0.08, torso: 0.25, t })), st, W, H);
  near(placed(f).x, BOOTH.x);
});

test('nothing to place until the shoulders have been seen; then the last spot holds', () => {
  const st = {};
  const legs = emptyPoseFrame();
  assert.equal(placeAtBooth(legs, st, W, H), false);
  placeAtBooth(figure({ cx: 0.5, top: 0.4, w: 0.08, torso: 0.25 }), st, W, H);
  assert.equal(placeAtBooth(emptyPoseFrame(), st, W, H), true);
});

process.exit(failed ? 1 : 0);
