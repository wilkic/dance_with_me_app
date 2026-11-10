/**
 * The DJ booth: where a room's DJ stands on everyone else's screen —
 * small, up and in the middle, so they read as being at the back of the
 * room (see main.js: the room's host while their music plays, when the
 * room shares its booth).
 *
 * Whatever the DJ's own camera sees — a whole body across the room, or
 * head and shoulders at a laptop — the figure lands on the same spot at
 * the same size: its torso is scaled to BOOTH.torso of the screen height
 * and its middle pinned to (BOOTH.x, BOOTH.y). Size and position follow
 * slowly, so dancing survives and wandering or leaning in doesn't.
 */
import { bodyAnchors } from './stickFigure.js';
import { STRIDE } from '../pose/poseFormat.js';

export const BOOTH = {
  x: 0.5,       // middle of the screen
  y: 0.34,      // torso middle, as a fraction of the screen height (up)
  torso: 0.08,  // torso length, as a fraction of the screen height (far away)
  followMs: 1500,
};

/**
 * Move a PoseFrame to the booth, in place. `st` is this dancer's follower
 * state ({} to start; kept by the caller between frames). Returns false
 * while the figure can't be placed yet (shoulders never seen).
 */
export function placeAtBooth(frame, st, W, H) {
  const body = bodyAnchors(frame, W, H);
  if (body) {
    const cx = (body.neck.x + body.pelvis.x) / 2 / W;
    const cy = (body.neck.y + body.pelvis.y) / 2 / H;
    const len = body.torsoLen / H;
    if (st.len === undefined) {
      Object.assign(st, { cx, cy, len });
    } else {
      const dt = Math.min(1000, Math.max(1, frame.t - st.t));
      const k = 1 - Math.exp(-dt / BOOTH.followMs);
      st.cx += k * (cx - st.cx);
      st.cy += k * (cy - st.cy);
      st.len += k * (len - st.len);
    }
    st.t = frame.t;
  }
  if (st.len === undefined) return false;
  const scale = BOOTH.torso / Math.max(st.len, 0.01);
  const kp = frame.keypoints;
  for (let i = 0; i < kp.length; i += STRIDE) {
    kp[i] = BOOTH.x + (kp[i] - st.cx) * scale;
    kp[i + 1] = BOOTH.y + (kp[i + 1] - st.cy) * scale;
  }
  return true;
}
