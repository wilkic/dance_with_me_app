/**
 * Drop-folder sweep — Chris's unit-test pipeline for real recordings.
 *
 *   node lab/drop.js            process everything in ../recordings
 *   node lab/drop.js --force    re-render even if outputs are up to date
 *
 * Convention: dance with ?click=BPM (or copy any labeled JSONL into
 * server/recordings/), then run this. Every recording with enough frames
 * gets, under lab/out/drop/:
 *   <name>.mp4    stick-figure replay of what the pose detector saw,
 *                 with a click track at the labeled BPM. Tempo is true;
 *                 PHASE is arbitrary (recordings store clickBpm but not
 *                 the metronome's start epoch) — judge speed, not sync.
 *   <name>.html   the waterfall analysis report (same as run.js analyze)
 *   index.html    combined gallery: video + stats + report link per
 *                 session, newest first
 *
 * Incremental: a recording is skipped when its mp4 is newer than the
 * JSONL, so month-long accumulation only pays for new drops.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecording, runAnalyze, detectorTrace, settledBpm } from './run.js';
import { renderClip } from './video.js';

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const REC_DIR = process.env.RECORD_DIR ?? join(LAB_DIR, '..', 'recordings');
// Each recordings folder gets its own gallery (web ingests via
// RECORD_DIR=recordings_web don't mix into Chris's metronome tests).
const DROP_DIR = join(LAB_DIR, 'out',
  basename(REC_DIR) === 'recordings' ? 'drop' : `drop-${basename(REC_DIR)}`);
const FPS = 30;
const MIN_FRAMES = 90; // same floor as run.js analyze — a few seconds

/** Resample recorded frames (jittery ~25 fps) onto a uniform 30 fps grid
 *  (nearest previous frame) so video wall-clock time stays true. */
function uniformFrames(frames) {
  const durMs = frames[frames.length - 1].t;
  const out = [];
  let i = 0;
  for (let t = 0; t <= durMs; t += 1000 / FPS) {
    while (i < frames.length - 1 && frames[i + 1].t <= t) i++;
    out.push({ t, k: Array.from(frames[i].keypoints) });
  }
  return out;
}

function processRecording(path, force) {
  const name = basename(path).replace(/\.jsonl$/, '');
  const mp4 = join(DROP_DIR, `${name}.mp4`);
  const { frames, label } = loadRecording(path);
  if (frames.length < MIN_FRAMES) {
    console.log(`skip ${name}: only ${frames.length} frames`);
    return null;
  }
  const durS = frames[frames.length - 1].t / 1000;
  const fps = frames.length / durS;
  const trace = detectorTrace(frames);
  const settled = settledBpm(trace);
  const clickBpm = label?.clickBpm ?? null;

  const fresh = existsSync(mp4) && statSync(mp4).mtimeMs > statSync(path).mtimeMs;
  if (fresh && !force) {
    console.log(`up to date: ${name}`);
  } else {
    const clickTimes = [];
    if (clickBpm) {
      for (let t = 0; t <= durS; t += 60 / clickBpm) clickTimes.push(+t.toFixed(4));
    }
    renderClip({
      name,
      title: label?.title ? String(label.title).slice(0, 48) : name,
      partLines: [
        `recorded ${durS.toFixed(0)}s at ~${fps.toFixed(0)} fps`,
        clickBpm ? `label: click ${clickBpm} BPM (phase arbitrary)` : 'no click label',
      ],
      click: clickBpm ? { bpm: clickBpm, note: 'labeled tempo; phase not recorded — judge speed, not sync' } : null,
      clickTimes,
      frames: uniformFrames(frames),
      outDir: DROP_DIR,
      fps: FPS,
    });
    runAnalyze(path, undefined); // waterfall report → lab/out/<name>.html
    const report = join(LAB_DIR, 'out', `${name}.html`);
    if (existsSync(report)) renameSync(report, join(DROP_DIR, `${name}.html`));
  }

  return {
    name,
    title: label?.title ?? null,
    source: label?.source ?? null,
    tag: label?.tag ?? null,
    durS,
    fps,
    frames: frames.length,
    clickBpm,
    settled,
    mtime: statSync(path).mtimeMs,
  };
}

function writeIndex(entries) {
  const cards = entries
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => {
      const verdictColor = e.clickBpm && Math.abs(e.settled - e.clickBpm) <= 8 ? '#7fd9a2'
        : e.clickBpm && Math.abs(e.settled - e.clickBpm / 2) <= 5 ? '#e8d98a' : '#e08a8a';
      return `
  <section class="card">
    <video src="${e.name}.mp4" controls preload="metadata"></video>
    <div class="info">
      <h2>${e.tag ? `<span style="color:#e8a8d8">[${e.tag}]</span> ` : ''}${e.name}</h2>
      <p class="meta">${e.durS.toFixed(0)}s · ${e.frames} frames · ~${e.fps.toFixed(0)} fps
        · label ${e.clickBpm ?? '—'} BPM</p>
      <p class="meta">detector settled at
        <b style="color:${verdictColor}">${e.settled.toFixed(0)} BPM</b>
        ${e.clickBpm ? `(target ${e.clickBpm})` : ''}</p>
      ${e.title ? `<p>${e.title}${e.source ? ` — <a href="${e.source}">source ↗</a>` : ''}</p>` : ''}
      <p><a href="${e.name}.html">waterfall analysis report →</a></p>
    </div>
  </section>`;
    }).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dance Lab — recorded sessions</title>
<style>
  body { margin: 0; padding: 24px; background: #0c0e16; color: #cfd4e2;
         font: 15px/1.5 system-ui, sans-serif; }
  h1 { font-size: 22px; color: #96ffbe; }
  .intro { max-width: 62em; color: #9aa2b5; }
  .card { display: flex; flex-wrap: wrap; gap: 20px; margin: 28px 0;
          padding: 16px; background: #12151f; border-radius: 10px; }
  video { width: 300px; max-width: 100%; border-radius: 6px; background: #000; }
  .info { flex: 1 1 22em; max-width: 46em; }
  h2 { margin: 2px 0 8px; font-size: 17px; color: #e8ecf5; }
  .meta { color: #7fd9a2; font-size: 13px; margin: 2px 0; }
  a { color: #8ab8e8; }
</style></head><body>
<h1>Dance Lab — recorded sessions (drop folder)</h1>
<p class="intro">Every labeled JSONL dropped into <code>server/recordings/</code>, replayed
as the stick figure the pose detector actually saw, with a click track at the labeled
tempo. Click <em>phase</em> is arbitrary (recordings don’t store the metronome’s start
epoch) — judge whether the speed feels right, not whether clicks land on hits. The
settled-BPM verdict is green when the current detector agrees with the label (±8),
amber at the half-tempo octave, red otherwise. Newest first. Regenerate with
<code>node lab/drop.js</code>.</p>
${cards}
</body></html>\n`;
  const out = join(DROP_DIR, 'index.html');
  writeFileSync(out, html);
  console.log(`gallery: ${out}`);
}

const force = process.argv.includes('--force');
mkdirSync(DROP_DIR, { recursive: true });
const files = readdirSync(REC_DIR).filter((f) => f.endsWith('.jsonl'));
if (!files.length) {
  console.log(`no .jsonl recordings in ${REC_DIR}`);
  process.exit(0);
}
const entries = [];
for (const f of files) {
  const e = processRecording(join(REC_DIR, f), force);
  if (e) entries.push(e);
}
writeIndex(entries);
console.log(`${entries.length} session(s) in the gallery, ${files.length - entries.length} skipped`);
