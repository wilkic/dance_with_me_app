/**
 * AI dancer = a real person's recorded dance, replayed on your beat, with
 * moves borrowed from another dancer of a similar tempo and style.
 *
 * No choreography is generated. The base clip is someone's actual
 * dancing, retimed so its tempo lands on yours (half/double time
 * allowed, see foldTempo in tempo.js). Variation comes from a second clip — the
 * "moves" clip — whose arms or legs are grafted onto the base for a
 * phrase at a time, plus a little extra swing on the limbs. Everything is
 * done in body space (style.js), so a clip filmed in landscape from far
 * away dances at the same size, in the same place, on a portrait phone.
 *
 * Music never enters here: the beat comes in as a number. That is what
 * makes it work for silent dancers; the music just makes the number
 * better and the style match tighter.
 */
import { N_KEYPOINTS, STRIDE, KP, emptyPoseFrame } from '../src/pose/poseFormat.js';
import { toBodySpace, ANCHOR, MIRROR_PAIRS, MIN_VIS, PARTS } from './style.js';
import { foldTempo } from './tempo.js';

const TARGET_TORSO = 0.17;  // torso length as a fraction of the phone's frame height
const PELVIS_Y = 0.58;      // where the AI dancer's hips sit on screen
const RAMP_MS = 400;        // blend ramp when a borrowed limb comes and goes
const SWITCH_MS = 1200;     // crossfade when the base clip is swapped
const MAX_REACH = 3.5;      // torso lengths from the pelvis a joint can honestly be
const MAX_JUMP = 1.2;       // torso lengths a joint may move between consecutive frames
const SMOOTH = 0.55;        // output EMA weight on the newest sample (web footage jitters)
const KEY_JOINTS = [...PARTS.arms, ...PARTS.legs, KP.NOSE];
const MIN_RATE = 0.5;       // half time: the same groove, half as busy
const MAX_RATE = 1.6;
export const CALM_ENERGY = 0.8; // limb speed to aim for before we've seen the dancer move (torso lengths/s)

/**
 * Prepare a clip for replay: body-space frames with a slowly following
 * centre (locomotion and camera pans removed, bounces kept), optional
 * mirroring, and a loop point chosen where the pose comes back near the
 * start so the loop doesn't jump.
 */
export function prepareClip(frames, { aspect = 1, mirror = false } = {}) {
  const out = [];
  // Start the torso-length follower on the clip's median torso, so a
  // glitchy first frame can't poison the whole clip.
  const torsos = [];
  for (const f of frames) { const r = toBodySpace(f.keypoints, aspect); if (r) torsos.push(r.torso); }
  if (torsos.length < 2) return null;
  torsos.sort((a, b) => a - b);
  let torso = torsos[torsos.length >> 1];
  let cx = null, cy = null;
  let prevT = null;
  let last = null;     // last kept frame, for teleport rejection
  let rejected = 0;    // consecutive torso rejections → resync
  for (const f of frames) {
    const raw = toBodySpace(f.keypoints, aspect);
    if (!raw) continue;
    // Pose glitch: the torso suddenly collapses or balloons → drop the
    // frame. A long run of rejections means the person really changed
    // size (walked closer): resync on it.
    if (Math.abs(raw.torso - torso) > 0.4 * torso && rejected++ < 30) continue;
    rejected = 0;
    const dt = prevT === null ? 1000 : Math.max(1, f.t - prevT);
    prevT = f.t;
    // Sideways: pin the pelvis (travelling steps and camera pans vanish —
    // the AI dancer dances on the spot). Vertically: follow with ~1.5 s
    // lag so bounces and drops survive. Torso length follows with ~3 s lag
    // so a zooming camera reads as a slow drift, not a pumping figure.
    const kc = 1 - Math.exp(-dt / 1500);
    const kt = 1 - Math.exp(-dt / 3000);
    cx = raw.cx;
    cy = cy === null ? raw.cy : cy + kc * (raw.cy - cy);
    torso = torso === null ? raw.torso : torso + kt * (raw.torso - torso);
    const b = toBodySpace(f.keypoints, aspect, { x: cx, y: cy }, torso);
    if (!b) continue;
    // Reach clamp: a joint further than a body can reach is a detector
    // error — pull it in and hide it. Teleport: a key joint jumping more
    // than a limb's length in one frame is a glitch too (unless there was
    // a gap, e.g. the dancer was out of frame).
    for (let j = 0; j < N_KEYPOINTS; j++) {
      const r = Math.hypot(b.X[j], b.Y[j]);
      if (r > MAX_REACH) { b.X[j] *= MAX_REACH / r; b.Y[j] *= MAX_REACH / r; b.V[j] = Math.min(b.V[j], 0.2); }
    }
    if (last && f.t - last.t < 150) {
      let jump = 0;
      for (const j of KEY_JOINTS) {
        if (b.V[j] < MIN_VIS || last.V[j] < MIN_VIS) continue;
        jump = Math.max(jump, Math.hypot(b.X[j] - last.X[j], b.Y[j] - last.Y[j]));
      }
      if (jump > MAX_JUMP) continue;
    }
    if (mirror) {
      for (let j = 0; j < N_KEYPOINTS; j++) b.X[j] = -b.X[j];
      for (const [l, r] of MIRROR_PAIRS) {
        [b.X[l], b.X[r]] = [b.X[r], b.X[l]];
        [b.Y[l], b.Y[r]] = [b.Y[r], b.Y[l]];
        [b.V[l], b.V[r]] = [b.V[r], b.V[l]];
      }
    }
    last = { t: f.t, X: b.X, Y: b.Y, V: b.V };
    out.push(last);
  }
  if (out.length < 2) return null;
  // Rebase time on the first kept frame (loop time starts at 0).
  const t0 = out[0].t;
  for (const f of out) f.t -= t0;
  // Loop point: in the last third, the frame whose pose is nearest frame 0.
  const key = [...PARTS.arms, ...PARTS.legs, KP.NOSE];
  const first = out[0];
  let loopEnd = out[out.length - 1].t;
  let best = Infinity;
  const from = out[out.length - 1].t * 0.66;
  for (let i = Math.floor(out.length / 2); i < out.length; i++) {
    const f = out[i];
    if (f.t < from) continue;
    let d = 0;
    for (const j of key) d += (f.X[j] - first.X[j]) ** 2 + (f.Y[j] - first.Y[j]) ** 2;
    if (d < best) { best = d; loopEnd = f.t; }
  }
  return { frames: out, loopMs: Math.max(1000, loopEnd) };
}

/** Pose of a prepared clip at time tau (ms, wrapped into the loop). */
function sampleClip(clip, tau, into) {
  const fr = clip.frames;
  const t = ((tau % clip.loopMs) + clip.loopMs) % clip.loopMs;
  let lo = 0, hi = fr.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fr[mid].t <= t) lo = mid; else hi = mid - 1; }
  const a = fr[lo];
  const b = fr[Math.min(lo + 1, fr.length - 1)];
  const span = b.t - a.t;
  const w = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
  for (let j = 0; j < N_KEYPOINTS; j++) {
    into.X[j] = a.X[j] + w * (b.X[j] - a.X[j]);
    into.Y[j] = a.Y[j] + w * (b.Y[j] - a.Y[j]);
    into.V[j] = Math.min(a.V[j], b.V[j]);
  }
  return into;
}

const pose = () => ({ X: new Float32Array(N_KEYPOINTS), Y: new Float32Array(N_KEYPOINTS), V: new Float32Array(N_KEYPOINTS) });

/**
 * Playback rate that lands a clip's tempo on the target, within ~√2.
 * Given how much the clip moves (clipEnergy, see clipEnergy()) and how
 * much the dancer moves (wantEnergy), half or double time is taken when
 * it brings the AI dancer's limb speed closer to the dancer's own — a
 * web pro hitting every eighth note reads as frantic next to someone
 * swaying on the beat, but at half time it's the same groove.
 */
export function playbackRate(targetBpm, clipBpm, { clipEnergy = 0, wantEnergy = 0 } = {}) {
  if (!(targetBpm > 0) || !(clipBpm > 0)) return 1;
  let r = foldTempo(targetBpm) / foldTempo(clipBpm);
  if (r > Math.SQRT2) r /= 2;
  if (r < Math.SQRT1_2) r *= 2;
  if (clipEnergy > 0 && wantEnergy > 0) {
    const cost = (c) => Math.abs(Math.log((clipEnergy * c) / wantEnergy)) + 0.5 * Math.abs(Math.log(c));
    let best = r;
    for (const c of [r / 2, r * 2]) if (c >= MIN_RATE && c <= MAX_RATE && cost(c) < cost(best)) best = c;
    r = best;
  }
  return Math.min(MAX_RATE, Math.max(MIN_RATE, r));
}

/**
 * How much a clip moves as an AI dancer shows it: mean speed of the
 * wrists and elbows, and of the ankles and knees, in torso lengths per
 * second at playback rate 1, after the same clean-up and smoothing as
 * frame(). Arms and legs count equally (arms alone when no legs are
 * seen), the same mix as energyOf() for a live dancer.
 */
export function clipEnergy(frames, aspect = 1) {
  const p = prepareClip(frames, { aspect });
  if (!p) return 0;
  const X = new Float32Array(N_KEYPOINTS);
  const Y = new Float32Array(N_KEYPOINTS);
  const acc = { arms: [0, 0], legs: [0, 0] };
  let prev = null;
  for (const f of p.frames) {
    if (!prev) { X.set(f.X); Y.set(f.Y); prev = f; continue; }
    const dt = (f.t - prev.t) / 1000;
    prev = f;
    if (dt <= 0 || dt > 0.5) { X.set(f.X); Y.set(f.Y); continue; }
    for (const part of ['arms', 'legs']) {
      for (const j of PARTS[part]) {
        const nx = X[j] + SMOOTH * (f.X[j] - X[j]);
        const ny = Y[j] + SMOOTH * (f.Y[j] - Y[j]);
        if (f.V[j] >= MIN_VIS) { acc[part][0] += Math.hypot(nx - X[j], ny - Y[j]) / dt; acc[part][1]++; }
        X[j] = nx; Y[j] = ny;
      }
    }
  }
  const arms = acc.arms[1] ? acc.arms[0] / acc.arms[1] : 0;
  const legs = acc.legs[1] ? acc.legs[0] / acc.legs[1] : 0;
  return +(legs > 0 ? (arms + legs) / 2 : arms).toFixed(3);
}

export class AiDancer {
  /**
   * @param base   { desc, frames }  the person being replayed
   * @param moves  { desc, frames }  where borrowed moves come from (may be null)
   */
  constructor({ id, slot = 1, base, moves = null, targetBpm = 0, wantEnergy = CALM_ENERGY, aspect = 9 / 16, variation = 0.5, rng = Math.random, now = 0 }) {
    this.id = id;
    this.slot = slot;
    this.rng = rng;
    this.aspect = aspect;
    this.variation = variation;
    this.targetBpm = targetBpm;
    this.wantEnergy = wantEnergy;
    this.bornAt = now;
    this.base = null;
    this.prev = null;          // previous base during a crossfade
    this.switchAt = -Infinity;
    this.moves = null;
    this.phrase = { until: -Infinity, arms: false, legs: false, start: 0 };
    this.buf = { a: pose(), b: pose(), m: pose(), out: pose() };
    this.smooth = null;        // EMA of the output pose
    this.lastNow = null;
    this.baseSince = now;
    this.setBase(base, now);
    if (moves) this.setMoves(moves);
  }

  #prep(clip) {
    const prepared = prepareClip(clip.frames, { aspect: clip.desc.aspect ?? 1, mirror: this.rng() < 0.5 });
    if (!prepared) return null;
    return { desc: clip.desc, ...prepared, tau: prepared.loopMs * this.rng(), rate: 1 };
  }

  #rateOf(clip) {
    return playbackRate(this.targetBpm, clip.desc.bpm, { clipEnergy: clip.desc.energy, wantEnergy: this.wantEnergy });
  }

  /** Swap the person being replayed (crossfades over SWITCH_MS). */
  setBase(clip, now = 0) {
    const p = this.#prep(clip);
    if (!p) return false;
    p.rate = this.#rateOf(p);
    if (this.base) { this.prev = this.base; this.switchAt = now; }
    this.base = p;
    this.baseSince = now;
    return true;
  }

  setMoves(clip) {
    const p = this.#prep(clip);
    if (!p) return false;
    p.rate = this.#rateOf(p);
    this.moves = p;
    return true;
  }

  /** Live target: the dancer's tempo and limb speed, and the phone's aspect ratio. */
  setTarget({ bpm, energy, aspect, variation } = {}) {
    if (aspect > 0) this.aspect = aspect;
    if (variation !== undefined) this.variation = Math.min(1, Math.max(0, variation));
    let changed = false;
    if (bpm !== undefined && Math.abs((bpm || 0) - this.targetBpm) > 1) { this.targetBpm = bpm || 0; changed = true; }
    if (energy > 0 && Math.abs(Math.log(energy / this.wantEnergy)) > 0.1) { this.wantEnergy = energy; changed = true; }
    if (changed) for (const c of [this.base, this.prev, this.moves]) if (c) c.rate = this.#rateOf(c);
  }

  get info() {
    return {
      id: this.id,
      slot: this.slot,
      kind: 'ai',
      tag: this.base?.desc.tag ?? null,
      title: this.base?.desc.title ?? null,
      bpm: this.base?.desc.bpm ?? 0,
      rate: +(this.base?.rate ?? 1).toFixed(2),
      energy: this.base?.desc.energy ?? 0,
      base: this.base?.desc.name ?? null,
      moves: this.moves?.desc.name ?? null,
      borrowing: [this.phrase.arms && 'arms', this.phrase.legs && 'legs'].filter(Boolean),
    };
  }

  #phraseMs() {
    return this.targetBpm > 0 ? (8 * 60000) / this.targetBpm : 4000;
  }

  /** Decide, once per 8-beat phrase, which limbs come from the moves clip. */
  #updatePhrase(now) {
    if (now < this.phrase.until) return;
    const v = this.variation;
    const has = !!this.moves;
    this.phrase = {
      start: now,
      until: now + this.#phraseMs(),
      arms: has && this.rng() < v,
      legs: has && this.rng() < 0.6 * v,
    };
  }

  /** Blend weight of borrowed limbs: ramps in and out at phrase edges. */
  #borrowWeight(now) {
    const p = this.phrase;
    const inW = Math.min(1, (now - p.start) / RAMP_MS);
    const outW = Math.min(1, (p.until - now) / RAMP_MS);
    return Math.max(0, Math.min(inW, outW));
  }

  /** The AI dancer's pose right now, as a PoseFrame in the phone's image space. */
  frame(now) {
    if (!this.base) return null;
    // Each clip has its own clock, advanced at its playback rate, so a
    // tempo change speeds the dancer up or down without a jump.
    const dt = this.lastNow === null ? 0 : Math.max(0, Math.min(200, now - this.lastNow));
    this.lastNow = now;
    for (const c of [this.base, this.prev, this.moves]) if (c) c.tau += dt * c.rate;
    const { a, b, m, out } = this.buf;
    const cur = sampleClip(this.base, this.base.tau, a);
    let src = cur;
    if (this.prev && now - this.switchAt < SWITCH_MS) {
      const old = sampleClip(this.prev, this.prev.tau, b);
      const w = (now - this.switchAt) / SWITCH_MS;
      for (let j = 0; j < N_KEYPOINTS; j++) {
        out.X[j] = old.X[j] + w * (cur.X[j] - old.X[j]);
        out.Y[j] = old.Y[j] + w * (cur.Y[j] - old.Y[j]);
        out.V[j] = Math.min(old.V[j], cur.V[j]);
      }
      src = out;
    } else {
      this.prev = null;
      out.X.set(cur.X); out.Y.set(cur.Y); out.V.set(cur.V);
      src = out;
    }

    // Variation, in the "dance moves" sense: limbs swing a bit further,
    // and for a phrase at a time an arm pair or leg pair is the other
    // dancer's, hung off this dancer's shoulders/hips.
    this.#updatePhrase(now);
    const w = this.#borrowWeight(now);
    const mv = this.moves && (this.phrase.arms || this.phrase.legs) && w > 0
      ? sampleClip(this.moves, this.moves.tau, m)
      : null;
    const swing = 1 + 0.2 * this.variation;
    const base = { X: Float32Array.from(src.X), Y: Float32Array.from(src.Y), V: src.V };
    for (const jStr of Object.keys(ANCHOR)) {
      const j = +jStr;
      const an = ANCHOR[j];
      const isArm = PARTS.arms.includes(j) || j === KP.LEFT_WRIST || j === KP.RIGHT_WRIST;
      const borrow = mv && ((isArm && this.phrase.arms) || (!isArm && this.phrase.legs)) && mv.V[j] >= MIN_VIS && mv.V[an] >= MIN_VIS;
      const ox = (base.X[j] - base.X[an]) * swing;
      const oy = (base.Y[j] - base.Y[an]) * swing;
      if (borrow) {
        const bx = mv.X[j] - mv.X[an];
        const by = mv.Y[j] - mv.Y[an];
        out.X[j] = base.X[an] + (1 - w) * ox + w * bx;
        out.Y[j] = base.Y[an] + (1 - w) * oy + w * by;
        out.V[j] = Math.min(base.V[an], (1 - w) * base.V[j] + w * mv.V[j]);
      } else {
        out.X[j] = base.X[an] + ox;
        out.Y[j] = base.Y[an] + oy;
      }
    }

    // Light smoothing: web footage jitters, and a guest may lag a little.
    if (!this.smooth) { this.smooth = pose(); this.smooth.X.set(out.X); this.smooth.Y.set(out.Y); }
    const sm = this.smooth;
    for (let j = 0; j < N_KEYPOINTS; j++) {
      sm.X[j] += SMOOTH * (out.X[j] - sm.X[j]);
      sm.Y[j] += SMOOTH * (out.Y[j] - sm.Y[j]);
    }

    // Body space → the phone's normalized image space.
    const f = emptyPoseFrame();
    f.t = now;
    f.mirrored = true;
    const kp = f.keypoints;
    for (let j = 0; j < N_KEYPOINTS; j++) {
      const o = j * STRIDE;
      kp[o] = 0.5 + (sm.X[j] * TARGET_TORSO) / this.aspect;
      kp[o + 1] = PELVIS_Y + sm.Y[j] * TARGET_TORSO;
      kp[o + 2] = 0;
      kp[o + 3] = out.V[j];
    }
    return f;
  }
}
