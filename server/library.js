/**
 * The dance library: every recorded dance the server knows, described
 * so AI dancers can be built from it.
 *
 * Sources (all keypoints-only JSONL, one frame per line — the lab format):
 *   recordings_web/   web clips harvested by lab/harvest.js (tagged by genre)
 *   recordings/       metronome sessions from the lab
 *   library/sessions/ every session recorded from now on (recorder.js)
 *
 * Each clip gets a descriptor — tempo (from motion, or the label's click /
 * music tempo when present), a style vector (style.js), coverage, source
 * aspect — cached in library/index.json so restarts are instant. Frames
 * are loaded lazily when a clip is actually danced.
 *
 * pick() is tempo-first, style-second, tag-third — the same order the
 * dancer matcher uses — and works with no music at all.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyPoseFrame } from '../src/pose/poseFormat.js';
import { BeatDetector } from './beatDetector.js';
import { styleOf, styleDistance } from './style.js';
import { tempoGap } from './tempo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIRS = ['recordings_web', 'recordings', 'library/sessions'].map((d) => join(HERE, d));
export const DEFAULT_CACHE = join(HERE, 'library', 'index.json');

const LANDSCAPE = 16 / 9;
const PORTRAIT = 9 / 16;

/** Read a lab-format recording: { frames: [{t, keypoints}], label, extras } (t rebased to 0). */
export function readRecording(path) {
  const frames = [];
  let label = null;
  const tempo = [];   // {t, bpm, confidence, musicBpm, musicConfidence} lines from recorder.js
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'label') { label = { ...(label ?? {}), ...o }; continue; }
    if (o.type === 'tempo') { tempo.push(o); continue; }
    if (!Array.isArray(o.k) || o.k.length !== 33 * 4) continue;
    const f = emptyPoseFrame();
    f.t = o.t;
    f.keypoints.set(o.k);
    frames.push(f);
  }
  if (frames.length) {
    const t0 = frames[0].t;
    for (const f of frames) f.t -= t0;
  }
  return { frames, label, tempo };
}

/** Settled motion tempo of a clip: median of the detector's last estimates. */
function motionTempo(frames) {
  const det = new BeatDetector();
  const trace = [];
  let last = -Infinity;
  for (const f of frames) {
    const st = det.update(f);
    if (f.t - last >= 500) { last = f.t; trace.push({ bpm: st.bpm, conf: st.confidence }); }
  }
  const tail = trace.filter((p) => p.bpm > 0).slice(-7);
  if (!tail.length) return { bpm: 0, confidence: 0 };
  const bpms = tail.map((p) => p.bpm).sort((a, b) => a - b);
  return {
    bpm: +bpms[Math.floor(bpms.length / 2)].toFixed(1),
    confidence: +(tail.reduce((s, p) => s + p.conf, 0) / tail.length).toFixed(2),
  };
}

function aspectOf(label, dir) {
  if (label?.video?.w && label?.video?.h) return label.video.w / label.video.h;
  if (label?.ingest === 'video') return LANDSCAPE;
  if (basename(dir) === 'recordings_web') return LANDSCAPE;
  return PORTRAIT;
}

/** Build the descriptor of one recording file (null if unusable). */
export function describeRecording(path, { minFrames = 300 } = {}) {
  const { frames, label, tempo } = readRecording(path);
  if (frames.length < minFrames) return null;
  const aspect = aspectOf(label, dirname(path));
  const style = styleOf(frames, aspect);
  const durationS = frames[frames.length - 1].t / 1000;
  // Tempo: a metronome label is ground truth; a recorded music tempo (from
  // the phone mic) is next best; otherwise what the motion detector settles on.
  let bpm = 0, tempoConf = 0, tempoSource = 'motion';
  if (label?.clickBpm > 0) {
    bpm = label.clickBpm; tempoConf = 1; tempoSource = 'click';
  } else {
    const music = tempo.filter((l) => l.musicBpm > 0 && l.musicConfidence >= 0.3);
    if (music.length >= 3) {
      const b = music.map((l) => l.musicBpm).sort((a, c) => a - c);
      bpm = +b[Math.floor(b.length / 2)].toFixed(1);
      tempoConf = +(music.reduce((s, l) => s + l.musicConfidence, 0) / music.length).toFixed(2);
      tempoSource = 'music';
    } else {
      ({ bpm, confidence: tempoConf } = motionTempo(frames));
    }
  }
  return {
    path,
    name: basename(path).replace(/\.jsonl$/, ''),
    kind: label?.ingest === 'video' ? 'web' : label?.session ? 'session' : 'lab',
    tag: label?.tag ?? (label?.session ? 'you' : 'lab'),
    title: label?.title ?? basename(path),
    source: label?.source ?? label?.url ?? null,
    frames: frames.length,
    durationS: +durationS.toFixed(1),
    fps: +(frames.length / Math.max(1, durationS)).toFixed(1),
    aspect: +aspect.toFixed(4),
    bpm, tempoConf, tempoSource,
    style: style.vector,
    coverage: style.coverage,
  };
}

export class Library {
  constructor({ dirs = DEFAULT_DIRS, cacheFile = DEFAULT_CACHE, minFrames = 300, minCoverage = 0.6, log = () => {} } = {}) {
    this.dirs = dirs;
    this.cacheFile = cacheFile;
    this.minFrames = minFrames;
    this.minCoverage = minCoverage;
    this.log = log;
    this.clips = [];              // descriptors usable for AI dancing
    this.index = {};              // path -> { size, mtimeMs, desc|null }
    this.frameCache = new Map();  // path -> frames (LRU-ish, small)
  }

  /** Scan the source dirs, (re)describing files that are new or changed. */
  load() {
    if (this.cacheFile && existsSync(this.cacheFile)) {
      try { this.index = JSON.parse(readFileSync(this.cacheFile, 'utf8')); } catch { this.index = {}; }
    }
    let described = 0;
    const seen = new Set();
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.jsonl') || f === 'library.jsonl' || f === 'sessions.jsonl') continue;
        const path = join(dir, f);
        seen.add(path);
        if (this.#describe(path)) described++;
      }
    }
    for (const p of Object.keys(this.index)) if (!seen.has(p)) delete this.index[p];
    this.#rebuild();
    if (described) this.#saveCache();
    this.log(`library: ${this.clips.length} clips ready for AI dancers (${described} newly described)`);
    return this;
  }

  /** Index one new recording (a just-closed session). Returns its descriptor or null. */
  add(path) {
    if (!existsSync(path)) return null;
    this.#describe(path, true);
    this.#rebuild();
    this.#saveCache();
    const d = this.index[path]?.desc;
    if (d) this.log(`library: +${d.name} (${d.frames} frames, ${d.bpm || '?'} bpm, ${d.tag}) → ${this.clips.length} clips`);
    return d;
  }

  #describe(path, force = false) {
    let st;
    try { st = statSync(path); } catch { return false; }
    const prev = this.index[path];
    if (!force && prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) return false;
    let desc = null;
    try { desc = describeRecording(path, { minFrames: this.minFrames }); } catch (e) { this.log(`library: skip ${path}: ${e.message}`); }
    this.index[path] = { size: st.size, mtimeMs: st.mtimeMs, desc };
    return true;
  }

  #rebuild() {
    this.clips = Object.values(this.index)
      .map((e) => e.desc)
      .filter((d) => d && d.coverage >= this.minCoverage && d.frames >= this.minFrames)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  #saveCache() {
    if (!this.cacheFile) return;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(this.index));
    } catch (e) { this.log(`library: cache not written: ${e.message}`); }
  }

  get size() { return this.clips.length; }

  /** Tags present, with clip counts. */
  get tags() {
    const m = new Map();
    for (const c of this.clips) m.set(c.tag, (m.get(c.tag) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }

  /**
   * Best clip for a dancer: closest tempo (folded octave), then closest
   * style, a nudge for a wanted tag, a little randomness so two AI
   * dancers don't pick the same clip every time. Any of bpm/style/tag may
   * be missing — a silent, still dancer still gets a dancer.
   */
  pick({ bpm = 0, style = null, tag = null, exclude = new Set(), rng = Math.random } = {}) {
    let best = null;
    let bestScore = Infinity;
    for (const c of this.clips) {
      if (exclude.has(c.name)) continue;
      const tGap = bpm > 0 && c.bpm > 0 ? tempoGap(bpm, c.bpm) : 0.25;
      const sDist = style ? styleDistance(style, c.style) : 0.5;
      const tagBonus = tag && c.tag === tag ? -0.3 : 0;
      const score = 3 * tGap + sDist + tagBonus + rng() * 0.25;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /** Frames of a clip (cached). */
  frames(desc) {
    let fr = this.frameCache.get(desc.path);
    if (!fr) {
      fr = readRecording(desc.path).frames;
      this.frameCache.set(desc.path, fr);
      if (this.frameCache.size > 12) this.frameCache.delete(this.frameCache.keys().next().value);
    }
    return fr;
  }
}
