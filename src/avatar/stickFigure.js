import { Avatar } from './avatar.js';
import { BONES, KP, getKeypoint } from '../pose/poseFormat.js';

const MIN_VISIBILITY = 0.4;

// Bones drawn identically in both torso styles (below the shoulders/hips).
const LIMB_BONES = [
  [KP.LEFT_ELBOW, KP.LEFT_WRIST],
  [KP.RIGHT_ELBOW, KP.RIGHT_WRIST],
  [KP.LEFT_KNEE, KP.LEFT_ANKLE],
  [KP.RIGHT_KNEE, KP.RIGHT_ANKLE],
  [KP.LEFT_ANKLE, KP.LEFT_FOOT],
  [KP.RIGHT_ANKLE, KP.RIGHT_FOOT],
];

/**
 * The MVP avatar: a glowing stick figure. Bone thickness scales with the
 * figure's apparent size so it looks right whether the dancer is near or
 * far from the camera. Pulses subtly on detected beats.
 *
 * Torso styles:
 *  - '1d' (default): a true stick — single spine line; arms hang off the
 *    neck, legs off the pelvis.
 *  - '2d': anatomical torso — shoulder line, hip line, and side bones
 *    forming a quad (the original MVP look).
 */
export class StickFigureAvatar extends Avatar {
  constructor({ color = '#8f7dff', glow = '#c9b8ff', torso = '1d' } = {}) {
    super();
    this.color = color;
    this.glow = glow;
    this.torso = torso;
  }

  render(ctx, frame, viewport, beat = null) {
    const { width: W, height: H } = viewport;

    const ls = getKeypoint(frame, KP.LEFT_SHOULDER);
    const rs = getKeypoint(frame, KP.RIGHT_SHOULDER);
    const lh = getKeypoint(frame, KP.LEFT_HIP);
    const rh = getKeypoint(frame, KP.RIGHT_HIP);
    const torsoVisible =
      ls.v > MIN_VISIBILITY && rs.v > MIN_VISIBILITY &&
      lh.v > MIN_VISIBILITY && rh.v > MIN_VISIBILITY;

    // Synthetic joints shared by both styles.
    const neck = { x: ((ls.x + rs.x) / 2) * W, y: ((ls.y + rs.y) / 2) * H };
    const pelvis = { x: ((lh.x + rh.x) / 2) * W, y: ((lh.y + rh.y) / 2) * H };

    // Apparent size: shoulder-to-hip span in pixels drives line width.
    const torsoLen = Math.hypot(neck.x - pelvis.x, neck.y - pelvis.y);
    const lineWidth = Math.max(3, torsoLen * 0.14);

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

    // Segments to draw, as pixel-space point pairs.
    const segments = [];
    const kpPx = (i) => {
      const k = getKeypoint(frame, i);
      return k.v < MIN_VISIBILITY ? null : { x: k.x * W, y: k.y * H };
    };
    const push = (a, b) => { if (a && b) segments.push([a, b]); };

    if (this.torso === '2d') {
      // Anatomical: every detected bone, including the shoulder/hip quad.
      for (const [a, b] of BONES) push(kpPx(a), kpPx(b));
    } else {
      // True stick: limbs attach directly to the spine endpoints.
      for (const [a, b] of LIMB_BONES) push(kpPx(a), kpPx(b));
      if (torsoVisible) {
        push(neck, kpPx(KP.LEFT_ELBOW));
        push(neck, kpPx(KP.RIGHT_ELBOW));
        push(pelvis, kpPx(KP.LEFT_KNEE));
        push(pelvis, kpPx(KP.RIGHT_KNEE));
      }
    }
    if (torsoVisible) segments.push([neck, pelvis]); // spine

    for (const [a, b] of segments) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Head: circle above the neck, positioned via ears/nose when visible.
    if (torsoVisible) {
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
        const r = Math.max(6, torsoLen * 0.28);
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
