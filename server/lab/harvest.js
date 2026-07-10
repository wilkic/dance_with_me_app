/**
 * Dance-library harvester — build a keypoint library from public videos.
 *
 *   node lab/harvest.js --minutes 115 [--per-video 75]
 *
 * Round-robins ~30 genre searches on YouTube, ingesting the first
 * unseen solo-ish result each pass: yt-dlp downloads ≤480p (trimmed to
 * --per-video seconds), lab/ingest_video.py extracts pose keypoints
 * with the app's own model, the video is deleted. What's kept per clip:
 *
 *   recordings_web/<tag>-<id>.jsonl   keypoints + label {source url,
 *                                     title, tag, sectionS} — the stick
 *                                     figure is tagged to its clip
 *   recordings_web/library.jsonl      append-only manifest (the library
 *                                     index: link, time window, tag,
 *                                     frame count, fps, ingestedAt)
 *
 * Every SWEEP_EVERY successful ingests (and once at the end) the full
 * stack runs: RECORD_DIR=recordings_web node lab/drop.js → replay
 * videos, waterfall reports, gallery. Log lines (stdout) are the
 * heartbeat: OK/FAIL per clip, PROGRESS every 5, SWEEP, DONE — a
 * monitor can filter these. Hard deadline via --minutes; the loop
 * checks the clock before every download and stops in time for a
 * final sweep.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(LAB_DIR, '..', 'recordings_web');
const MANIFEST = join(OUT_DIR, 'library.jsonl');
const TMP = join(LAB_DIR, 'out', 'harvest-tmp');

const QUERIES = {
  ballet: 'ballet solo variation stage performance',
  hiphop: 'hip hop freestyle dance solo',
  popping: 'popping freestyle solo dance',
  locking: 'locking dance solo freestyle',
  breaking: 'bboy solo battle round',
  house: 'house dance solo freestyle footwork',
  salsa: 'salsa solo shines footwork',
  bachata: 'bachata lady styling solo footwork',
  tango: 'argentine tango solo practice',
  swing: 'solo jazz charleston dance',
  tap: 'tap dance solo performance',
  contemporary: 'contemporary dance solo improvisation',
  jazz: 'jazz dance solo performance',
  waacking: 'waacking freestyle solo',
  vogue: 'vogue femme performance solo',
  krump: 'krump solo session',
  tutting: 'tutting dance solo',
  shuffle: 'melbourne shuffle solo dance',
  irish: 'irish step dance solo hard shoe',
  flamenco: 'flamenco solo baile',
  kathak: 'kathak solo dance performance',
  bharatanatyam: 'bharatanatyam solo dance',
  dancehall: 'dancehall steps solo tutorial',
  afrobeats: 'afrobeats dance solo freestyle',
  kpop: 'kpop dance cover one person solo',
  disco: 'disco dance solo moves',
  robot: 'robot dance solo performance',
  mj: 'michael jackson dance moves solo cover',
  bellydance: 'belly dance solo performance',
  folk: 'hopak solo dance performance',
};

const args = process.argv.slice(2);
const argVal = (k, dflt) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const MINUTES = argVal('--minutes', 115);
const PER_VIDEO_S = argVal('--per-video', 75);
const SWEEP_EVERY = 6;
const DEADLINE = Date.now() + MINUTES * 60_000;
// Reserve time for the final render sweep (~45s per unrendered clip).
const timeLeft = () => DEADLINE - Date.now();

function sh(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: 'utf8', timeout: 240_000, ...opts });
}

/** IDs already in the library (manifest + any existing jsonl names). */
function seenIds() {
  const seen = new Set();
  if (existsSync(MANIFEST)) {
    for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
      if (line.trim()) seen.add(JSON.parse(line).id);
    }
  }
  for (const f of readdirSync(OUT_DIR)) {
    const m = f.match(/-([\w-]{11})\.jsonl$/);
    if (m) seen.add(m[1]);
  }
  return seen;
}

function search(tag, query) {
  const r = sh('yt-dlp', ['--flat-playlist', '--print', '%(id)s\t%(duration)s\t%(title).80s',
    `ytsearch25:${query}`]);
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').flatMap((line) => {
    const [id, dur, title] = line.split('\t');
    const d = Number(dur);
    // Long enough that the first PER_VIDEO_S seconds contain dancing,
    // short enough to be a single performance, not a compilation.
    if (!id || !Number.isFinite(d) || d < 45 || d > 480) return [];
    return [{ tag, id, title: title ?? '', url: `https://www.youtube.com/watch?v=${id}` }];
  });
}

function ingest(cand) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const dl = sh('yt-dlp', ['-f', 'mp4[height<=480]/best[height<=480]/best', '--no-playlist',
    '--download-sections', `*0-${PER_VIDEO_S}`, '--force-keyframes-at-cuts',
    '-o', join(TMP, 'video.%(ext)s'), cand.url]);
  if (dl.status !== 0) return { fail: 'download' };
  const video = readdirSync(TMP).find((f) => f.startsWith('video.'));
  if (!video) return { fail: 'no-file' };

  const name = `${cand.tag}-${cand.id}`;
  const out = join(OUT_DIR, `${name}.jsonl`);
  const ing = sh('python3', [join(LAB_DIR, 'ingest_video.py'), join(TMP, video), out,
    '--source', cand.url, '--title', cand.title, '--tag', cand.tag,
    '--max-s', String(PER_VIDEO_S)]);
  rmSync(TMP, { recursive: true, force: true });
  if (ing.status !== 0) {
    rmSync(out, { force: true });
    return { fail: 'ingest' };
  }
  const m = ing.stdout.match(/(\d+) pose frames .*source fps (\d+)/);
  const frames = m ? Number(m[1]) : 0;
  if (frames < 300) { // want ≥10s of actual dancing, not a talking head
    rmSync(out, { force: true });
    return { fail: `low-pose(${frames})` };
  }
  return { name, frames, fps: m ? Number(m[2]) : 0 };
}

function sweep() {
  console.log(`SWEEP starting (render + reports + gallery)`);
  const r = sh('node', [join(LAB_DIR, 'drop.js')], {
    env: { ...process.env, RECORD_DIR: OUT_DIR },
    timeout: 3_000_000,
  });
  const tail = (r.stdout ?? '').trim().split('\n').pop();
  console.log(`SWEEP done: ${tail}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const seen = seenIds();
console.log(`HARVEST start: ${MINUTES} min budget, ${Object.keys(QUERIES).length} genres, ${seen.size} clips already known`);

const pools = new Map(); // tag → candidates not yet tried
let ok = 0;
let fail = 0;
let sinceSweep = 0;
outer:
while (timeLeft() > 5 * 60_000) {
  let any = false;
  for (const [tag, query] of Object.entries(QUERIES)) {
    if (timeLeft() <= 5 * 60_000 + sinceSweep * 45_000) break outer;
    if (!pools.has(tag)) pools.set(tag, search(tag, query));
    const pool = pools.get(tag);
    const cand = pool.find((c) => !seen.has(c.id));
    if (!cand) continue;
    seen.add(cand.id);
    pool.splice(pool.indexOf(cand), 1);
    any = true;

    const res = ingest(cand);
    if (res.fail) {
      fail++;
      console.log(`FAIL [${tag}] ${cand.id} ${res.fail} — ${cand.title.slice(0, 50)}`);
      continue;
    }
    ok++;
    sinceSweep++;
    appendFileSync(MANIFEST, JSON.stringify({
      ingestedAt: new Date().toISOString(),
      name: res.name,
      tag,
      id: cand.id,
      url: cand.url,
      title: cand.title,
      sectionS: [0, PER_VIDEO_S],
      frames: res.frames,
      fps: res.fps,
    }) + '\n');
    console.log(`OK [${tag}] ${res.name} frames=${res.frames} — ${cand.title.slice(0, 50)}`);
    if (ok % 5 === 0) {
      console.log(`PROGRESS ok=${ok} fail=${fail} elapsed=${((MINUTES * 60_000 - timeLeft()) / 60_000).toFixed(0)}min left=${(timeLeft() / 60_000).toFixed(0)}min`);
    }
    if (sinceSweep >= SWEEP_EVERY) {
      sweep();
      sinceSweep = 0;
    }
  }
  if (!any) {
    console.log('PROGRESS all search pools exhausted');
    break;
  }
}

sweep();
console.log(`DONE ok=${ok} fail=${fail} library=${MANIFEST}`);
