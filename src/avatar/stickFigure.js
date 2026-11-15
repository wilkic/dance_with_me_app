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
 * A spine that bends, from the four points we do have. The pose engine
 * gives nothing between shoulders and hips, but the spine leaves the neck
 * square to the shoulder line and arrives at the pelvis square to the hip
 * line; when those two lines tilt differently (a hip sway, a side bend)
 * the curve between them is the bend. Returns points from neck to pelvis;
 * the middle one is the "core", the one a quarter down the "chest".
 * Turned side-on the lines are too short to trust, and the spine goes
 * straight again.
 */
export function spineOf(frame, W, H, body = bodyAnchors(frame, W, H), steps = 8) {
  const { neck, pelvis, torsoLen } = body;
  const px = (i) => { const k = getKeypoint(frame, i); return { x: k.x * W, y: k.y * H }; };
  const down = unit(neck, pelvis);
  // The direction square to a line (a→b), pointing down the body; `trust`
  // fades it out as the line gets short.
  const square = (a, b) => {
    const l = unit(a, b);
    let n = { x: -l.y, y: l.x };
    if (n.x * down.x + n.y * down.y < 0) n = { x: -n.x, y: -n.y };
    const trust = Math.max(0, Math.min(1, (l.d / torsoLen - 0.25) / 0.25));
    const m = { x: down.x + (n.x - down.x) * trust, y: down.y + (n.y - down.y) * trust };
    const d = Math.hypot(m.x, m.y) || 1;
    return { x: m.x / d, y: m.y / d };
  };
  const out = square(px(KP.LEFT_SHOULDER), px(KP.RIGHT_SHOULDER));
  const into = square(px(KP.LEFT_HIP), px(KP.RIGHT_HIP));
  const c1 = { x: neck.x + out.x * torsoLen * 0.4, y: neck.y + out.y * torsoLen * 0.4 };
  const c2 = { x: pelvis.x - into.x * torsoLen * 0.4, y: pelvis.y - into.y * torsoLen * 0.4 };
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, s = 1 - t;
    pts.push({
      x: s * s * s * neck.x + 3 * s * s * t * c1.x + 3 * s * t * t * c2.x + t * t * t * pelvis.x,
      y: s * s * s * neck.y + 3 * s * s * t * c1.y + 3 * s * t * t * c2.y + t * t * t * pelvis.y,
    });
  }
  return pts;
}

/** The ways a figure can be drawn (see StickFigureAvatar). */
export const FIGURE_STYLES = ['stick', 'hands', 'shoulders', 'curved'];
export const FIGURE_NAMES = { stick: 'Stick', hands: 'Hands + feet', shoulders: 'Hands + shoulders', curved: 'Curved' };

const unit = (a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d, d };
};
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * Add a limb to `path` as a filled shape: it runs through `pts`, its
 * thickness going evenly from w0 at the start to w1 at the end, with
 * round ends and round joints. All pieces wind the same way, so the
 * whole figure fills as one shape without holes.
 */
function addTaper(path, pts, w0, w1) {
  const n = pts.length;
  if (n < 2) return;
  const r = (i) => (w0 + (w1 - w0) * (i / (n - 1))) / 2;
  for (let i = 0; i < n; i++) {
    path.moveTo(pts[i].x + r(i), pts[i].y);
    path.arc(pts[i].x, pts[i].y, r(i), 0, Math.PI * 2);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const u = unit(a, b);
    const nx = -u.y, ny = u.x;
    const ra = r(i), rb = r(i + 1);
    // This order winds the same way as the circles (clockwise on screen).
    path.moveTo(a.x - nx * ra, a.y - ny * ra);
    path.lineTo(b.x - nx * rb, b.y - ny * rb);
    path.lineTo(b.x + nx * rb, b.y + ny * rb);
    path.lineTo(a.x + nx * ra, a.y + ny * ra);
    path.closePath();
  }
}

/** Points along a smooth bend from a to b that swings out through the joint between them. */
function bend(a, joint, b, steps = 10) {
  const mid = lerp(a, b, 0.5);
  const c = { x: joint.x + (joint.x - mid.x) * 0.8, y: joint.y + (joint.y - mid.y) * 0.8 };
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, s = 1 - t;
    out.push({ x: s * s * a.x + 2 * s * t * c.x + t * t * b.x, y: s * s * a.y + 2 * s * t * c.y + t * t * b.y });
  }
  return out;
}

/**
 * The dancer's figure. Bone thickness scales with the figure's apparent
 * size so it looks right whether the dancer is near or far from the
 * camera. Pulses subtly on detected beats.
 *
 * Figure styles (FIGURE_STYLES):
 *  - 'stick' (default): the glowing stick figure.
 *  - 'hands': the stick figure with mitten hands and shoe feet — which
 *    way a hand or foot points makes a pose much easier to read.
 *  - 'shoulders': 'hands', with the arms hanging off real shoulders that
 *    round over from the neck, instead of off the neck itself.
 *  - 'curved': a chunky silhouette — a bean of a torso, arms that bend
 *    in a curve and taper to the wrist, tapered legs, a floating head.
 *
 * Torso styles (stick and hands):
 *  - '1d' (default): a true stick — single spine line; arms hang off the
 *    neck, legs off the pelvis.
 *  - '2d': anatomical torso — shoulder line, hip line, and side bones
 *    forming a quad (the original MVP look).
 *
 * Spine (an experiment, see spineOf): 'straight' (default), or 'bent' —
 * the spine curves when the shoulders tilt one way and the hips another.
 *
 * Glow styles (canvas shadowBlur is the expensive part of drawing a figure —
 * see bench.html):
 *  - 'blur' (default): true shadowBlur glow, one blur pass per figure.
 *  - 'halo': a wide translucent stroke under the bones, no blur at all —
 *    several times cheaper.
 *  - 'none': no glow at all; used for guests.
 */
export class StickFigureAvatar extends Avatar {
  constructor({ color = '#8f7dff', glow = '#c9b8ff', torso = '1d', alpha = 1, glowStyle = 'blur', style = 'stick', spine = 'straight' } = {}) {
    super();
    this.color = color;
    this.glow = glow;
    this.torso = torso;
    this.alpha = alpha; // 0..1, lets guests fade into the room
    this.glowStyle = glowStyle;
    this.style = style;
    this.spine = spine;
  }

  render(ctx, frame, viewport, beat = null) {
    const { width: W, height: H } = viewport;
    const body = bodyAnchors(frame, W, H);
    if (!body) return; // no shoulders in view (legs only): not a dancer we draw
    const { neck, pelvis, torsoLen, hipsVisible } = body;
    // Up close the body fills the frame: cap the line so it stays a stick.
    const lineWidth = Math.max(3, Math.min(torsoLen * 0.14, hipsVisible ? Infinity : H * 0.03));
    // The size hands, feet and the curved figure are measured in: the
    // torso, capped the same way up close.
    const u = Math.max(20, Math.min(torsoLen, hipsVisible ? Infinity : H * 0.2));

    // Beat pulse: brief glow swell right after each beat.
    let pulse = 0;
    if (beat && beat.confidence > 0.3 && beat.lastBeatAt) {
      const since = (frame.t - beat.lastBeatAt) / 1000;
      pulse = Math.max(0, 1 - since * 4); // fades over 250ms
    }

    // The whole figure is one stroked path (bones) and one filled path
    // (head, hands, feet — or everything, for the curved figure), so the
    // glow is computed once per figure rather than once per bone.
    const bones = new Path2D();
    const solid = new Path2D();
    const kpPx = (i) => {
      const k = getKeypoint(frame, i);
      return k.v < MIN_VISIBILITY ? null : { x: k.x * W, y: k.y * H };
    };
    const push = (a, b) => {
      if (!a || !b) return;
      bones.moveTo(a.x, a.y);
      bones.lineTo(b.x, b.y);
    };

    // Head: a circle above the neck, placed via ears/nose.
    const le = kpPx(KP.LEFT_EAR);
    const re = kpPx(KP.RIGHT_EAR);
    const headAt = le && re ? lerp(le, re, 0.5) : kpPx(KP.NOSE);

    // The spine as points from neck to pelvis: two for a straight one.
    const spine = this.spine === 'bent' && hipsVisible ? spineOf(frame, W, H, body) : [neck, pelvis];

    if (this.style === 'curved') {
      this.#curved(solid, { neck, pelvis, spine, hipsVisible, headAt, u, kpPx });
    } else {
      const hands = this.style !== 'stick';
      const ls = kpPx(KP.LEFT_SHOULDER), rs = kpPx(KP.RIGHT_SHOULDER);
      if (this.torso === '2d') {
        // Anatomical: every detected bone, including the shoulder/hip quad.
        for (const [a, b] of BONES) if (!hands || (b !== KP.LEFT_FOOT && b !== KP.RIGHT_FOOT)) push(kpPx(a), kpPx(b));
      } else {
        // True stick: limbs attach directly to the spine endpoints.
        for (const [a, b] of LIMB_BONES) if (!hands || (b !== KP.LEFT_FOOT && b !== KP.RIGHT_FOOT)) push(kpPx(a), kpPx(b));
        for (const [s, elbow] of [[ls, kpPx(KP.LEFT_ELBOW)], [rs, kpPx(KP.RIGHT_ELBOW)]]) {
          if (this.style === 'shoulders' && s && elbow) {
            // Out along the shoulder line, rounding over into the upper arm.
            bones.moveTo(neck.x, neck.y);
            bones.arcTo(s.x, s.y, elbow.x, elbow.y, u * 0.14);
            bones.lineTo(elbow.x, elbow.y);
          } else {
            push(neck, elbow);
          }
        }
        if (hipsVisible) {
          push(pelvis, kpPx(KP.LEFT_KNEE));
          push(pelvis, kpPx(KP.RIGHT_KNEE));
        }
      }
      // Spine (running off the bottom of the frame when the hips aren't in it).
      bones.moveTo(spine[0].x, spine[0].y);
      for (const p of spine.slice(1)) bones.lineTo(p.x, p.y);
      if (headAt) {
        const r = Math.max(6, torsoLen * 0.28);
        push(neck, { x: headAt.x, y: headAt.y + r * 0.7 }); // neck line up to the chin
        solid.moveTo(headAt.x + r, headAt.y);
        solid.arc(headAt.x, headAt.y, r, 0, Math.PI * 2);
      }
      // Barely thicker than the limbs they end: it's the direction that reads.
      if (hands) this.#handsAndFeet(solid, u, kpPx, lineWidth * 1.15);
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
      ctx.lineWidth = lineWidth * 1.6;
      ctx.stroke(solid); // a ring around the head (and the hands, feet, body)
      ctx.globalAlpha = this.alpha;
    } else if (this.glowStyle === 'blur') {
      ctx.shadowColor = this.glow;
      ctx.shadowBlur = lineWidth * (1.5 + pulse * 3);
    }

    ctx.strokeStyle = this.color;
    ctx.lineWidth = lineWidth;
    ctx.stroke(bones);
    ctx.fillStyle = this.color;
    ctx.fill(solid);
    ctx.restore();
  }

  /**
   * Mitten hands and shoe feet. A hand points where the fingers are (or
   * on along the forearm when they aren't seen); a foot runs from the
   * heel to the toes, never shorter than a shoe seen from the front.
   */
  #handsAndFeet(solid, u, kpPx, thick) {
    for (const [elbow, wrist, index, pinky] of [
      [KP.LEFT_ELBOW, KP.LEFT_WRIST, KP.LEFT_INDEX, KP.LEFT_PINKY],
      [KP.RIGHT_ELBOW, KP.RIGHT_WRIST, KP.RIGHT_INDEX, KP.RIGHT_PINKY],
    ]) {
      const w = kpPx(wrist);
      if (!w) continue;
      const i = kpPx(index), p = kpPx(pinky), e = kpPx(elbow);
      const fingers = i && p ? lerp(i, p, 0.5) : i ?? p;
      const dir = fingers && Math.hypot(fingers.x - w.x, fingers.y - w.y) > u * 0.03 ? unit(w, fingers) : e ? unit(e, w) : null;
      if (!dir) continue;
      const len = u * 0.24;
      addTaper(solid, [w, { x: w.x + dir.x * len, y: w.y + dir.y * len }], thick, thick * 1.15);
    }
    for (const [ankle, heel, toe] of [
      [KP.LEFT_ANKLE, KP.LEFT_HEEL, KP.LEFT_FOOT],
      [KP.RIGHT_ANKLE, KP.RIGHT_HEEL, KP.RIGHT_FOOT],
    ]) {
      const a = kpPx(ankle);
      const t = kpPx(toe);
      if (!a || !t) continue;
      const from = kpPx(heel) ?? a;
      const dir = unit(from, t);
      const len = Math.max(dir.d, u * 0.22);
      addTaper(solid, [from, { x: from.x + dir.x * len, y: from.y + dir.y * len }], thick * 1.15, thick);
    }
  }

  /** The chunky silhouette: everything is a filled, tapered shape. */
  #curved(solid, { neck, pelvis, spine, hipsVisible, headAt, u, kpPx }) {
    const chest = u * 0.5;
    addTaper(solid, spine, chest, u * 0.4);
    // Arms: from just inside the shoulder, bending through the elbow.
    for (const [shoulder, elbow, wrist] of [
      [KP.LEFT_SHOULDER, KP.LEFT_ELBOW, KP.LEFT_WRIST],
      [KP.RIGHT_SHOULDER, KP.RIGHT_ELBOW, KP.RIGHT_WRIST],
    ]) {
      const s = kpPx(shoulder), e = kpPx(elbow), w = kpPx(wrist);
      if (!s || !e) continue;
      const from = lerp(neck, s, 0.7);
      if (w) addTaper(solid, bend(from, e, w), u * 0.25, u * 0.14);
      else addTaper(solid, [from, e], u * 0.25, u * 0.19);
    }
    // Legs: straight thigh and shin, tapering to the ankle; a small foot.
    if (hipsVisible) {
      for (const [hip, knee, ankle, heel, toe] of [
        [KP.LEFT_HIP, KP.LEFT_KNEE, KP.LEFT_ANKLE, KP.LEFT_HEEL, KP.LEFT_FOOT],
        [KP.RIGHT_HIP, KP.RIGHT_KNEE, KP.RIGHT_ANKLE, KP.RIGHT_HEEL, KP.RIGHT_FOOT],
      ]) {
        const h = kpPx(hip), k = kpPx(knee), a = kpPx(ankle);
        if (!h || !k) continue;
        const from = lerp(pelvis, h, 0.6);
        if (!a) { addTaper(solid, [from, k], u * 0.29, u * 0.22); continue; }
        // Three points along thigh and shin each, so the taper is even.
        addTaper(solid, [from, lerp(from, k, 0.5), k, lerp(k, a, 0.5), a], u * 0.29, u * 0.15);
        const t = kpPx(toe);
        if (t) {
          const start = kpPx(heel) ?? a;
          const dir = unit(start, t);
          const len = Math.max(dir.d, u * 0.2);
          addTaper(solid, [start, { x: start.x + dir.x * len, y: start.y + dir.y * len }], u * 0.16, u * 0.12);
        }
      }
    }
    // Head: floating clear of the shoulders, leaning the way the real one does.
    if (headAt) {
      const r = u * 0.3;
      const dir = unit(neck, headAt);
      const c = { x: neck.x + dir.x * (chest / 2 + r + u * 0.07), y: neck.y + dir.y * (chest / 2 + r + u * 0.07) };
      solid.moveTo(c.x + r, c.y);
      solid.arc(c.x, c.y, r, 0, Math.PI * 2);
    }
  }
}
