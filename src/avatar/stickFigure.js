import { Avatar } from './avatar.js';
import { BONES, KP, getKeypoint } from '../pose/poseFormat.js';

const MIN_VISIBILITY = 0.4;

/**
 * The MVP avatar: a glowing stick figure. Bone thickness scales with the
 * figure's apparent size so it looks right whether the dancer is near or
 * far from the camera. Pulses subtly on detected beats.
 */
export class StickFigureAvatar extends Avatar {
  constructor({ color = '#8f7dff', glow = '#c9b8ff' } = {}) {
    super();
    this.color = color;
    this.glow = glow;
  }

  render(ctx, frame, viewport, beat = null) {
    const { width: W, height: H } = viewport;
    const px = (kp) => ({ x: kp.x * W, y: kp.y * H });

    const ls = getKeypoint(frame, KP.LEFT_SHOULDER);
    const rs = getKeypoint(frame, KP.RIGHT_SHOULDER);
    const lh = getKeypoint(frame, KP.LEFT_HIP);
    const rh = getKeypoint(frame, KP.RIGHT_HIP);

    // Apparent size: shoulder-to-hip span in pixels drives line width.
    const torso = Math.hypot(
      ((ls.x + rs.x) / 2 - (lh.x + rh.x) / 2) * W,
      ((ls.y + rs.y) / 2 - (lh.y + rh.y) / 2) * H,
    );
    const lineWidth = Math.max(3, torso * 0.14);

    // Beat pulse: brief glow swell right after each beat.
    let pulse = 0;
    if (beat && beat.confidence > 0.3 && beat.lastBeatAt) {
      const since = (frame.t - beat.lastBeatAt) / 1000;
      pulse = Math.max(0, 1 - since * 4); // fades over 250ms
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = this.color;
    ctx.lineWidth = lineWidth;
    ctx.shadowColor = this.glow;
    ctx.shadowBlur = lineWidth * (1.5 + pulse * 3);

    // Bones
    for (const [a, b] of BONES) {
      const ka = getKeypoint(frame, a);
      const kb = getKeypoint(frame, b);
      if (ka.v < MIN_VISIBILITY || kb.v < MIN_VISIBILITY) continue;
      const pa = px(ka);
      const pb = px(kb);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    // Spine: neck (shoulder midpoint) to pelvis (hip midpoint)
    if (ls.v > MIN_VISIBILITY && rs.v > MIN_VISIBILITY &&
        lh.v > MIN_VISIBILITY && rh.v > MIN_VISIBILITY) {
      const neck = { x: ((ls.x + rs.x) / 2) * W, y: ((ls.y + rs.y) / 2) * H };
      const pelvis = { x: ((lh.x + rh.x) / 2) * W, y: ((lh.y + rh.y) / 2) * H };
      ctx.beginPath();
      ctx.moveTo(neck.x, neck.y);
      ctx.lineTo(pelvis.x, pelvis.y);
      ctx.stroke();

      // Head: circle above the neck, positioned via nose/ears when visible.
      const nose = getKeypoint(frame, KP.NOSE);
      const le = getKeypoint(frame, KP.LEFT_EAR);
      const re = getKeypoint(frame, KP.RIGHT_EAR);
      let head;
      if (le.v > MIN_VISIBILITY && re.v > MIN_VISIBILITY) {
        head = { x: ((le.x + re.x) / 2) * W, y: ((le.y + re.y) / 2) * H };
      } else if (nose.v > MIN_VISIBILITY) {
        head = { x: nose.x * W, y: nose.y * H };
      }
      if (head) {
        const r = Math.max(6, torso * 0.28);
        // Neck line up to the chin
        ctx.beginPath();
        ctx.moveTo(neck.x, neck.y);
        ctx.lineTo(head.x, head.y + r * 0.7);
        ctx.stroke();
        ctx.beginPath();
        ctx.fillStyle = this.color;
        ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }
}
