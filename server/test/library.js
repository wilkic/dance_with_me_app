/**
 * Unit tests for the guest machinery: tempo from any signal, style
 * descriptors, the dance library, AI dancers, and the session recorder.
 * Uses a tiny synthetic library written to a temp dir — no real clips needed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyPoseFrame, KP, STRIDE, N_KEYPOINTS } from '../../src/pose/poseFormat.js';
import { dominantTempo, EnvelopeTempo, foldTempo, tempoGap } from '../tempo.js';
import { styleOf, styleDistance, toBodySpace, StyleWindow } from '../style.js';
import { Library, describeRecording } from '../library.js';
import { AiDancer, prepareClip, playbackRate, clipEnergy } from '../aiDancer.js';
import { SessionRecorder } from '../recorder.js';

let failed = 0;
const test = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.message}`); }
};

// ---- synthetic dancers -----------------------------------------------------
const setKp = (f, i, x, y, v = 1) => { const o = i * STRIDE; f.keypoints[o] = x; f.keypoints[o + 1] = y; f.keypoints[o + 3] = v; };
/** A dancer at (cx, cy) in a frame of the given aspect; arms swing at `bpm` (speed peaks 2×/cycle). */
function dancerFrame(tMs, { bpm = 120, cx = 0.5, cy = 0.6, torso = 0.25, aspect = 1, armSwing = 0.5, legSwing = 0.1, walk = 0 } = {}) {
  const f = emptyPoseFrame();
  f.t = tMs;
  const s = Math.sin(2 * Math.PI * (bpm / 120) * (tMs / 1000)); // bpm/60/2 Hz position
  const x = (dx) => cx + (dx * torso) / aspect + walk * (tMs / 1000) / aspect;
  const y = (dy) => cy + dy * torso;
  setKp(f, KP.NOSE, x(0), y(-1.4));
  setKp(f, KP.LEFT_EAR, x(-0.15), y(-1.35)); setKp(f, KP.RIGHT_EAR, x(0.15), y(-1.35));
  setKp(f, KP.LEFT_SHOULDER, x(-0.4), y(-1)); setKp(f, KP.RIGHT_SHOULDER, x(0.4), y(-1));
  setKp(f, KP.LEFT_ELBOW, x(-0.7 - 0.3 * armSwing * s), y(-0.6)); setKp(f, KP.RIGHT_ELBOW, x(0.7 + 0.3 * armSwing * s), y(-0.6));
  setKp(f, KP.LEFT_WRIST, x(-0.9 - armSwing * s), y(-0.3 - armSwing * s)); setKp(f, KP.RIGHT_WRIST, x(0.9 + armSwing * s), y(-0.3 + armSwing * s));
  setKp(f, KP.LEFT_HIP, x(-0.3), y(0)); setKp(f, KP.RIGHT_HIP, x(0.3), y(0));
  setKp(f, KP.LEFT_KNEE, x(-0.3), y(0.9)); setKp(f, KP.RIGHT_KNEE, x(0.3), y(0.9));
  setKp(f, KP.LEFT_ANKLE, x(-0.3 + legSwing * s), y(1.8)); setKp(f, KP.RIGHT_ANKLE, x(0.3 - legSwing * s), y(1.8));
  setKp(f, KP.LEFT_HEEL, x(-0.3), y(1.9)); setKp(f, KP.RIGHT_HEEL, x(0.3), y(1.9));
  setKp(f, KP.LEFT_FOOT, x(-0.2), y(1.95)); setKp(f, KP.RIGHT_FOOT, x(0.4), y(1.95));
  return f;
}
const clip = (seconds, opts) => { const out = []; for (let t = 0; t <= seconds * 1000; t += 33) out.push(dancerFrame(t, opts)); return out; };
const writeClip = (dir, name, frames, label) => {
  const lines = [];
  if (label) lines.push(JSON.stringify({ type: 'label', ...label }));
  for (const f of frames) lines.push(JSON.stringify({ t: f.t, k: Array.from(f.keypoints, (v) => +v.toFixed(4)) }));
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
};

// ---- tempo.js --------------------------------------------------------------
test('dominantTempo finds a 2 Hz envelope (120 bpm) and reports flat signals', () => {
  const hz = 30;
  const grid = Array.from({ length: hz * 6 }, (_, i) => Math.max(0, Math.sin(2 * Math.PI * 2 * (i / hz))));
  const { bpm, confidence } = dominantTempo(grid, hz);
  assert.ok(Math.abs(bpm - 120) < 3, `got ${bpm}`);
  assert.ok(confidence > 0.5);
  assert.equal(dominantTempo(new Array(200).fill(0.3), hz).flat, true);
  assert.equal(dominantTempo([1, 2, 3], hz).bpm, 0);
});

test('EnvelopeTempo: mic onset batches → music tempo (100 bpm), reset clears', () => {
  const et = new EnvelopeTempo();
  const hz = 30;
  for (let b = 0; b < 8; b++) {
    const e = Array.from({ length: hz }, (_, i) => { const t = (b * hz + i) / hz; return (t * (100 / 60)) % 1 < 0.15 ? 1 : 0.05; });
    et.push({ t0: b * 1000, hz, e });
  }
  assert.ok(Math.abs(et.state.bpm - 100) < 4, `got ${et.state.bpm}`);
  assert.ok(et.state.confidence > 0.3);
  et.reset();
  assert.equal(et.state.bpm, 0);
});

test('foldTempo / tempoGap treat half and double time as one groove', () => {
  assert.equal(foldTempo(60), 120);
  assert.equal(foldTempo(240), 120);
  assert.ok(tempoGap(60, 120) < 1e-9);
  assert.ok(tempoGap(120, 126) > 0.04 && tempoGap(120, 126) < 0.06);
  assert.ok(tempoGap(178, 91) < 0.03, 'across the octave wrap');
  assert.equal(tempoGap(0, 120), 1);
});

// ---- style.js --------------------------------------------------------------
test('toBodySpace is aspect- and distance-invariant', () => {
  const near = toBodySpace(dancerFrame(0, { torso: 0.3, aspect: 1 }).keypoints, 1);
  const far = toBodySpace(dancerFrame(0, { torso: 0.1, aspect: 16 / 9, cx: 0.2 }).keypoints, 16 / 9);
  for (const j of [KP.NOSE, KP.LEFT_WRIST, KP.RIGHT_ANKLE]) {
    assert.ok(Math.abs(near.X[j] - far.X[j]) < 1e-3 && Math.abs(near.Y[j] - far.Y[j]) < 1e-3, `joint ${j}`);
  }
  assert.ok(Math.abs(near.Y[KP.NOSE] + 1.4) < 1e-3, 'nose 1.4 torso lengths above the pelvis');
  const hidden = dancerFrame(0); setKp(hidden, KP.LEFT_HIP, 0.4, 0.6, 0.1);
  assert.equal(toBodySpace(hidden.keypoints), null);
});

test('styleOf tells arm-led from leg-led dancing; distance orders neighbours', () => {
  const arms = styleOf(clip(6, { armSwing: 0.8, legSwing: 0.05 }));
  const legs = styleOf(clip(6, { armSwing: 0.1, legSwing: 0.6 }));
  const armsToo = styleOf(clip(6, { armSwing: 0.7, legSwing: 0.05 }));
  assert.ok(arms.vector[0] > arms.vector[1], 'arms clip: arms travel more than legs');
  assert.ok(legs.vector[1] > legs.vector[0], 'legs clip: legs travel more than arms');
  assert.ok(styleDistance(arms.vector, armsToo.vector) < styleDistance(arms.vector, legs.vector));
  assert.equal(arms.coverage, 1);
  const w = new StyleWindow({ aspect: 1 });
  for (const f of clip(4, { armSwing: 0.8 })) w.push(f);
  assert.ok(w.vector && w.vector[0] > 0.3, 'live window has a style after a few seconds');
});

// ---- library.js ------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'dance-lib-'));
const pClick = writeClip(dir, 'lab-click', clip(20, { bpm: 90, armSwing: 0.6 }), { clickBpm: 90 });
const pWeb = writeClip(dir, 'salsa-web', clip(20, { bpm: 150, aspect: 16 / 9, torso: 0.12, cx: 0.3, walk: 0.15, legSwing: 0.5, armSwing: 0.2 }), { ingest: 'video', tag: 'salsa', title: 'Salsa clip' });
writeClip(dir, 'short', clip(3), null);
writeClip(dir, 'hiphop-web', clip(20, { bpm: 100, aspect: 16 / 9, armSwing: 0.9 }), { ingest: 'video', tag: 'hiphop' });

test('describeRecording: tempo from click label or motion, style, aspect, coverage', () => {
  const d = describeRecording(pClick);
  assert.equal(d.bpm, 90); assert.equal(d.tempoSource, 'click'); assert.equal(d.tag, 'lab');
  assert.ok(Math.abs(d.aspect - 9 / 16) < 1e-3);
  const w = describeRecording(pWeb);
  assert.equal(w.tempoSource, 'motion');
  assert.ok(Math.abs(w.bpm - 150) < 8, `web clip settled at ${w.bpm}`);
  assert.equal(w.tag, 'salsa'); assert.equal(w.kind, 'web');
  assert.ok(Math.abs(w.aspect - 16 / 9) < 1e-3);
  assert.equal(describeRecording(join(dir, 'short.jsonl')), null, 'too short');
});

const cache = join(dir, 'index.json');
const lib = new Library({ dirs: [dir], cacheFile: cache }).load();
test('Library loads usable clips, caches descriptors, picks by tempo/style/tag', () => {
  assert.deepEqual(lib.clips.map((c) => c.name).sort(), ['hiphop-web', 'lab-click', 'salsa-web']);
  assert.ok(existsSync(cache));
  const r0 = () => 0; // no randomness: the scores alone decide
  assert.equal(lib.pick({ bpm: 92, rng: r0 }).name, 'lab-click', 'nearest tempo');
  assert.equal(lib.pick({ bpm: 75, rng: r0 }).name, 'salsa-web', '75 ≈ 150 half time');
  assert.equal(lib.pick({ bpm: 100, tag: 'hiphop', rng: r0 }).name, 'hiphop-web');
  assert.equal(lib.pick({ bpm: 100, exclude: new Set(['hiphop-web']), rng: r0 }).name, 'lab-click');
  // Energy: a calm dancer gets the calmest clip of equal tempo fit.
  const byEnergy = [...lib.clips].sort((a, b) => a.energy - b.energy);
  assert.ok(byEnergy.every((c) => c.energy > 0), 'every clip rated');
  assert.equal(lib.pick({ energy: byEnergy[0].energy, rng: r0 }).name, byEnergy[0].name, 'calm dancer → calm clip');
  assert.equal(lib.pick({ energy: byEnergy[2].energy, rng: r0 }).name, byEnergy[2].name, 'busy dancer → busy clip');
  const armsy = styleOf(clip(6, { armSwing: 0.9 })).vector;
  assert.equal(lib.pick({ style: armsy, rng: () => 0 }).name, 'hiphop-web', 'style only, no tempo');
  assert.ok(lib.pick({}), 'nothing known → still a dancer');
  assert.equal(lib.frames(lib.clips[0]).length, 607);
  const again = new Library({ dirs: [dir], cacheFile: cache }).load();
  assert.equal(again.size, 3);
});

test('Library.add indexes a freshly recorded session', () => {
  const p = writeClip(dir, 'sess-1', clip(15, { bpm: 110 }), { session: true, id: 'abc' });
  const d = lib.add(p);
  assert.ok(d && d.kind === 'session' && d.tag === 'you');
  assert.equal(lib.size, 4);
});

// ---- aiDancer.js -----------------------------------------------------------
test('playbackRate lands a clip on the target tempo within √2', () => {
  assert.ok(Math.abs(playbackRate(120, 100) - 1.2) < 1e-9);
  assert.ok(Math.abs(playbackRate(60, 100) - 1.2) < 1e-9, 'half time = same groove');
  assert.ok(Math.abs(playbackRate(100, 150) - 4 / 3) < 1e-9, '100 vs 150: play 75-ish at 4/3 rather than 2/3');
  assert.equal(playbackRate(0, 100), 1);
  assert.ok(Math.abs(playbackRate(120, 100, { clipEnergy: 3, wantEnergy: 0.8 }) - 0.6) < 1e-9, 'a busy clip next to a calm dancer: half time');
  assert.ok(Math.abs(playbackRate(120, 100, { clipEnergy: 0.8, wantEnergy: 0.8 }) - 1.2) < 1e-9, 'matching energy: normal time');
});

test('clipEnergy: busier clips rate higher; walking does not count', () => {
  const calm = clipEnergy(clip(10, { armSwing: 0.15, legSwing: 0.05 }), 1);
  const busy = clipEnergy(clip(10, { armSwing: 0.8, legSwing: 0.5 }), 1);
  const walking = clipEnergy(clip(10, { armSwing: 0.15, legSwing: 0.05, walk: 0.3 }), 1);
  assert.ok(calm > 0 && busy > 2 * calm, `calm ${calm}, busy ${busy}`);
  assert.ok(Math.abs(walking - calm) < 0.3 * calm, `walking ${walking} vs calm ${calm}`);
});

test('prepareClip removes walking, keeps the body, loops near the start pose', () => {
  const frames = clip(20, { walk: 0.3, aspect: 16 / 9, torso: 0.12, cx: 0.1 });
  const p = prepareClip(frames, { aspect: 16 / 9 });
  assert.ok(p.frames.length > 500);
  assert.equal(p.frames[0].t, 0);
  const hipX = p.frames.map((f) => (f.X[KP.LEFT_HIP] + f.X[KP.RIGHT_HIP]) / 2);
  assert.ok(Math.max(...hipX.map(Math.abs)) < 0.05, 'pelvis pinned sideways');
  assert.ok(p.loopMs >= 13000 && p.loopMs <= 20000, `loop ${p.loopMs}`);
  const glitchy = frames.map((f) => f);
  const bad = dancerFrame(5000, { torso: 0.02 }); glitchy[150] = bad; // collapsed torso
  const q = prepareClip(glitchy, { aspect: 16 / 9 });
  assert.equal(q.frames.length, p.frames.length - 1, 'glitch frame dropped');
});

test('AiDancer streams sane frames: on screen, right size, hips steady, borrowed moves in play', () => {
  const base = lib.clips.find((c) => c.name === 'salsa-web');
  const moves = lib.clips.find((c) => c.name === 'hiphop-web');
  let seed = 1;
  const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const d = new AiDancer({ id: 'ai-1-t', base: { desc: base, frames: lib.frames(base) }, moves: { desc: moves, frames: lib.frames(moves) },
    targetBpm: 110, aspect: 9 / 16, variation: 1, rng, now: 0 });
  assert.ok(d.base && d.moves);
  assert.equal(d.info.kind, 'ai'); assert.equal(d.info.tag, 'salsa'); assert.equal(d.info.base, 'salsa-web');
  let borrowed = 0;
  const hips = [];
  for (let t = 0; t < 30000; t += 33) {
    const f = d.frame(t);
    assert.equal(f.keypoints.length, N_KEYPOINTS * STRIDE);
    for (let j = 0; j < N_KEYPOINTS; j++) {
      const x = f.keypoints[j * STRIDE], y = f.keypoints[j * STRIDE + 1];
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
      if (f.keypoints[j * STRIDE + 3] >= 0.5) assert.ok(x > -0.3 && x < 1.3 && y > -0.2 && y < 1.2, `joint ${j} at ${x},${y} (t=${t})`);
    }
    hips.push((f.keypoints[KP.LEFT_HIP * STRIDE] + f.keypoints[KP.RIGHT_HIP * STRIDE]) / 2);
    if (d.info.borrowing.length) borrowed++;
  }
  assert.ok(Math.max(...hips) - Math.min(...hips) < 0.05, 'AI dancer dances on the spot');
  assert.ok(borrowed > 100, `borrowed moves during ${borrowed} frames`);
  const f = d.frame(30033);
  const torso = Math.abs(f.keypoints[KP.LEFT_HIP * STRIDE + 1] - f.keypoints[KP.LEFT_SHOULDER * STRIDE + 1]);
  assert.ok(torso > 0.12 && torso < 0.24, `torso on screen ${torso}`);
  // Tempo change: no jump.
  const before = d.frame(30066);
  d.setTarget({ bpm: 150 });
  const after = d.frame(30099);
  assert.ok(Math.abs(after.keypoints[KP.LEFT_WRIST * STRIDE] - before.keypoints[KP.LEFT_WRIST * STRIDE]) < 0.1, 'rate change is continuous');
  // Base switch crossfades.
  assert.ok(d.setBase({ desc: lib.clips.find((c) => c.name === 'lab-click'), frames: lib.frames(lib.clips.find((c) => c.name === 'lab-click')) }, 30099));
  const mid = d.frame(30132);
  assert.ok(Math.abs(mid.keypoints[KP.NOSE * STRIDE + 1] - after.keypoints[KP.NOSE * STRIDE + 1]) < 0.1, 'crossfade is continuous');
  assert.equal(d.info.base, 'lab-click');
});

// ---- recorder.js -----------------------------------------------------------
test('SessionRecorder keeps dances, drops blips, writes media sidecars + manifest', () => {
  const rdir = join(dir, 'sessions');
  const short = new SessionRecorder(rdir, { id: 'blip', minFrames: 50 });
  for (const f of clip(1)) short.frame(f);
  const r1 = short.close();
  assert.equal(r1.kept, false); assert.ok(!existsSync(r1.path));

  const rec = new SessionRecorder(rdir, { id: 'kept', minFrames: 50 });
  rec.label({ level: { video: 'video', music: 'audio' }, video: { w: 720, h: 1280 }, room: 'funky-otter' });
  rec.label({ clickBpm: 100 });
  for (const f of clip(4, { bpm: 100 })) rec.frame(f);
  rec.tempo({ t: 4000, bpm: 99.4, confidence: 0.8, musicBpm: 100.2, musicConfidence: 0.6 });
  rec.music({ t0: 3000, hz: 30, e: [0.1, 0.9, 0.2] });
  rec.mediaChunk('audio', 'audio/webm;codecs=opus', Buffer.from('abc'));
  rec.mediaChunk('audio', 'audio/webm;codecs=opus', Buffer.from('def'));
  rec.mediaChunk('video', 'video/mp4', Buffer.from('xyz'));
  const r2 = rec.close({ bpm: 99.4 });
  assert.equal(r2.kept, true);
  const lines = readFileSync(r2.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'label'); assert.equal(lines[0].session, true);
  assert.ok(lines.some((l) => l.type === 'label' && l.clickBpm === 100));
  assert.ok(lines.some((l) => l.type === 'tempo' && l.musicBpm === 100.2));
  assert.ok(lines.some((l) => l.type === 'music' && l.e.length === 3));
  assert.equal(lines.filter((l) => Array.isArray(l.k)).length, 122);
  assert.equal(readFileSync(join(rdir, `${rec.name}.audio.webm`), 'utf8'), 'abcdef');
  assert.equal(readFileSync(join(rdir, `${rec.name}.video.mp4`), 'utf8'), 'xyz');
  const manifest = readFileSync(join(rdir, 'sessions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].room, 'funky-otter'); assert.equal(manifest[0].media.audio.bytes, 6); assert.equal(manifest[0].bpm, 99.4);
  // …and the library understands the session it just wrote.
  const d = describeRecording(r2.path, { minFrames: 50 });
  assert.equal(d.kind, 'session'); assert.equal(d.tempoSource, 'click'); assert.ok(Math.abs(d.aspect - 720 / 1280) < 1e-6);
});

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) failed` : '\nall library/AI tests passed');
process.exit(failed ? 1 : 0);
