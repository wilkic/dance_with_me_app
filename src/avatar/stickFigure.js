import { Avatar } from './avatar.js';
import { BONES, KP, getKeypoint } from '../pose/poseFormat.js';

const MIN_VISIBILITY = 0.4;

/**
 * Where a figure's spine is, in pixels: { neck, pelvis, torsoLen,
 * hipsVisible }, or null when the shoulders aren't both in view (only
 * legs: not drawn). Up close — a DJ at the decks, someone at a laptop —
 * the hips are out of frame, so the spine is estimated from the
 * shoulders: it runs down, square to the shoulder line, about 1.3
 * shoulder widths (or twice nose-to-neck when turned sideways).
 */
export function bodyAnchors(frame, W, H) {
  const ls = getKeypoint(frame, KP.LEFT_SHOULDER);
  const rs = getKeypoint(frame, KP.RIGHT_SHOULDER);
  if (ls.v <= MIN_VISIBILITY || rs.v <= MIN_VISIBILITY) return null;
  const lh = getKeypoint(frame, KP.LEFT_HIP);
  const rh = getKeypoint(frame, KP.RIGHT_HIP);
  const neck = { x: ((ls.x + rs.x) / 2) * W, y: ((ls.y + rs.y) / 2) * H };
  if (lh.v > MIN_VISIBILITY && rh.v > MIN_VISIBILITY) {
    const pelvis = { x: ((lh.x + rh.x) / 2) * W, y: ((lh.y + rh.y) / 2) * H };
    return { neck, pelvis, torsoLen: Math.hypot(neck.x - pelvis.x, neck.y - pelvis.y), hipsVisible: true };
  }
  const sx = (rs.x - ls.x) * W;
  const sy = (rs.y - ls.y) * H;
  const width = Math.hypot(sx, sy);
  const nose = getKeypoint(frame, KP.NOSE);
  const up = nose.v > MIN_VISIBILITY ? Math.hypot(nose.x * W - neck.x, nose.y * H - neck.y) : 0;
  const torsoLen = Math.max(width * 1.3, up * 2, 1);
  // Unit vector square to the shoulder line, pointing down the screen.
  let dx = -sy / (width || 1);
  let dy = sx / (width || 1);
  if (width === 0) { dx = 0; dy = 1; }
  if (dy < 0) { dx = -dx; dy = -dy; }
  return { neck, pelvis: { x: neck.x + dx * torsoLen, y: neck.y + dy * torsoLen }, torsoLen, hipsVisible: false };
}

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
 *
 * Glow styles (canvas shadowBlur is the expensive part of drawing a figure —
 * see bench.html):
 *  - 'blur' (default): true shadowBlur glow, one blur pass per figure.
 *  - 'halo': a wide translucent stroke under the bones, no blur at all —
 *    several times cheaper.
 *  - 'none': no glow at all; used for guests.
 */
export class StickFigureAvatar extends Avatar {
  constructor({ color = '#8f7dff', glow = '#c9b8ff', torso = '1d', alpha = 1, glowStyle = 'blur' } = {}) {
    super();
    this.color = color;
    this.glow = glow;
    this.torso = torso;
    this.alpha = alpha; // 0..1, lets guests fade into the room
    this.glowStyle = glowStyle;
  }

  render(ctx, frame, viewport, beat = null) {
    const { width: W, height: H } = viewport;
    const body = bodyAnchors(frame, W, H);
    if (!body) return; // no shoulders in view (legs only): not a dancer we draw
    const { neck, pelvis, torsoLen, hipsVisible } = body;
    // Up close the body fills the frame: cap the line so it stays a stick.
    const lineWidth = Math.max(3, Math.min(torsoLen * 0.14, hipsVisible ? Infinity : H * 0.03));

    // Beat pulse: brief glow swell right after each beat.
    let pulse = 0;
    if (beat && beat.confidence > 0.3 && beat.lastBeatAt) {
      const since = (frame.t - beat.lastBeatAt) / 1000;
      pulse = Math.max(0, 1 - since * 4); // fades over 250ms
    }

    // The whole figure is one path for the bones and one for the head, so
    // the glow is computed once per figure rather than once per bone.
    const bones = new Path2D();
    const kpPx = (i) => {
      const k = getKeypoint(frame, i);
      return k.v < MIN_VISIBILITY ? null : { x: k.x * W, y: k.y * H };
    };
    const push = (a, b) => {
      if (!a || !b) return;
      bones.moveTo(a.x, a.y);
      bones.lineTo(b.x, b.y);
    };

    if (this.torso === '2d') {
      // Anatomical: every detected bone, including the shoulder/hip quad.
      for (const [a, b] of BONES) push(kpPx(a), kpPx(b));
    } else {
      // True stick: limbs attach directly to the spine endpoints.
      for (const [a, b] of LIMB_BONES) push(kpPx(a), kpPx(b));
      push(neck, kpPx(KP.LEFT_ELBOW));
      push(neck, kpPx(KP.RIGHT_ELBOW));
      if (hipsVisible) {
        push(pelvis, kpPx(KP.LEFT_KNEE));
        push(pelvis, kpPx(KP.RIGHT_KNEE));
      }
    }

    // Spine (running off the bottom of the frame when the hips aren't in
    // it), then the head: a circle above the neck, placed via ears/nose.
    push(neck, pelvis);
    let head = null;
    const nose = getKeypoint(frame, KP.NOSE);
    const le = getKeypoint(frame, KP.LEFT_EAR);
    const re = getKeypoint(frame, KP.RIGHT_EAR);
    let c;
    if (le.v > MIN_VISIBILITY && re.v > MIN_VISIBILITY) {
      c = { x: ((le.x + re.x) / 2) * W, y: ((le.y + re.y) / 2) * H };
    } else if (nose.v > MIN_VISIBILITY) {
      c = { x: nose.x * W, y: nose.y * H };
    }
    if (c) {
      const r = Math.max(6, torsoLen * 0.28);
      push(neck, { x: c.x, y: c.y + r * 0.7 }); // neck line up to the chin
      head = new Path2D();
      head.arc(c.x, c.y, r, 0, Math.PI * 2);
    }

    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (this.glowStyle === 'halo') {
      ctx.globalAlpha = this.alpha * (0.35 + pulse * 0.3);
      ctx.strokeStyle = this.glow;
      ctx.lineWidth = lineWidth * 2.6;
      ctx.stroke(bones);
      if (head) ctx.stroke(head); // a ring around the head
      ctx.globalAlpha = this.alpha;
    } else if (this.glowStyle === 'blur') {
      ctx.shadowColor = this.glow;
      ctx.shadowBlur = lineWidth * (1.5 + pulse * 3);
    }

    ctx.strokeStyle = this.color;
    ctx.lineWidth = lineWidth;
    ctx.stroke(bones);
    if (head) {
      ctx.fillStyle = this.color;
      ctx.fill(head);
    }
    ctx.restore();
  }
}
