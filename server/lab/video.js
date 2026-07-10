/**
 * Scenario videos — render each dance-lab scenario as a watchable clip:
 * the synthetic stick figure, app-style, with a metronome click track at
 * the scenario's DESIGN tempo (scenario.click) overlaid.
 *
 *   node lab/video.js                 all scenarios → lab/out/videos/*.mp4
 *   node lab/video.js slow-sway-42    just one
 *
 * Clicks land on the reference part's movement extremes (direction
 * reversals — where humans perceive motion beats): first click at
 * 0.25/refHz seconds, then every 60/bpm. So in nyquist-half-tempo the
 * body visibly hits every other click, and in layered-150-over-60 the
 * arms flourish faster than the click on purpose.
 *
 * Rendering is delegated to render_video.py (PIL) + ffmpeg; both checked
 * present on this machine.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SCENARIOS } from './run.js';
import { makeDancer, beatBpmOfPosHz } from './synthDancer.js';

const LAB_DIR = dirname(fileURLToPath(import.meta.url));
const VID_DIR = join(LAB_DIR, 'out', 'videos');

const DURATION_S = 12;
const FPS = 30;
const SIZE = [480, 640];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed:\n${r.stderr?.toString().slice(-2000)}`);
  }
}

function makeVideo(sc) {
  const dancer = makeDancer({ parts: sc.parts, noise: sc.noise });
  const frames = dancer.frames(DURATION_S, FPS).map((f) => ({
    t: f.t,
    k: Array.from(f.keypoints),
  }));

  const clickTimes = [];
  if (sc.click) {
    const period = 60 / sc.click.bpm;
    for (let t = 0.25 / sc.click.refHz; t <= DURATION_S; t += period) {
      clickTimes.push(+t.toFixed(4));
    }
  }

  const partLines = Object.entries(sc.parts).map(
    ([p, v]) => `${p}: ${v.hz} Hz -> ${Math.round(beatBpmOfPosHz(v.hz))} BPM beat`,
  );
  if (sc.noise) partLines.push(`keypoint jitter s=${sc.noise}`);

  const tmp = join(VID_DIR, 'tmp', sc.name);
  const framesDir = join(tmp, 'frames');
  mkdirSync(framesDir, { recursive: true });

  const job = {
    title: sc.title,
    partLines,
    click: sc.click ?? null,
    clickTimes,
    fps: FPS,
    size: SIZE,
    frames,
  };
  const jobPath = join(tmp, 'job.json');
  const wavPath = join(tmp, 'click.wav');
  writeFileSync(jobPath, JSON.stringify(job));

  run('python3', [join(LAB_DIR, 'render_video.py'), jobPath, framesDir, wavPath]);

  const out = join(VID_DIR, `${sc.name}.mp4`);
  run('ffmpeg', [
    '-y',
    '-framerate', String(FPS), '-i', join(framesDir, '%05d.png'),
    '-i', wavPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    out,
  ]);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`video: ${out}  (click ${sc.click?.bpm ?? '—'} BPM: ${sc.click?.note ?? 'none'})`);
}

// What a human should watch/listen for, per scenario (gallery only).
const WATCH_FOR = {
  'arms-only-120': 'The baseline. Clicks on the arm reversals — this one should simply feel on-beat.',
  'hips-only-96': 'Only the hips (with shoulders riding along) move. If you can feel 96 from this alone, so should a detector.',
  'layered-150-over-60': 'The click follows the hips/legs GROOVE at 60, while the arms flourish at 150 on top. A human feels the click is right; the current detector chases the arms — this is the reported bug, synthesized.',
  'nyquist-half-tempo': 'The click is the SONG at 120; the body moves on every other click. Should look like normal relaxed dancing — half-tempo is idiomatic, not an error.',
  'slow-sway-42': 'A clean slow beat below the detector’s 50 BPM search floor. The motion is obviously periodic; the detector refuses to look there.',
  'jitter-arms-120': 'Same as the baseline plus realistic pose-detector wobble — a subtle shimmer to the eye, yet it currently breaks the tempo lock.',
};

/** Self-contained gallery page next to the mp4s (relative src). */
function writeGallery() {
  const cards = SCENARIOS.map((sc) => {
    const parts = Object.entries(sc.parts)
      .map(([p, v]) => `${p} ${v.hz} Hz → ${Math.round(beatBpmOfPosHz(v.hz))} BPM beat`)
      .concat(sc.noise ? [`keypoint jitter σ=${sc.noise}`] : [])
      .join(' · ');
    return `
  <section class="card">
    <video src="${sc.name}.mp4" controls preload="metadata" loop></video>
    <div class="info">
      <h2>${sc.title}</h2>
      <p class="meta">${parts}</p>
      <p class="meta">click ${sc.click.bpm} BPM — ${sc.click.note}</p>
      <p>${sc.desc}</p>
      <p class="watch">${WATCH_FOR[sc.name] ?? ''}</p>
    </div>
  </section>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dance Lab — scenario videos</title>
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
  .watch { color: #e8d98a; }
</style></head><body>
<h1>Dance Lab — the 6 dance unit tests, watchable</h1>
<p class="intro">Each clip is the exact synthetic keypoint stream the scenario feeds the
detector, drawn as the app’s stick figure, with a metronome at the scenario’s
<em>design</em> tempo. The yellow dot flashes on every click, so sync is judgeable muted.
Clicks are placed at movement extremes (direction reversals — the literature’s motion
beats). Known caveat from watching these: the oscillators are pure sinusoids, but real
dancers have a non-linear speed profile between reversals (asymmetric acceleration/jerk),
so phase can be spot-on while the movement still doesn’t <em>feel</em> human.</p>
${cards}
</body></html>\n`;
  mkdirSync(VID_DIR, { recursive: true });
  const out = join(VID_DIR, 'index.html');
  writeFileSync(out, html);
  console.log(`gallery: ${out}`);
}

const names = process.argv.slice(2);
if (!names.includes('--gallery')) {
  const picked = names.length
    ? SCENARIOS.filter((s) => names.includes(s.name))
    : SCENARIOS;
  if (!picked.length) {
    console.error(`no scenario matches ${names}; have: ${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(1);
  }
  for (const sc of picked) makeVideo(sc);
}
writeGallery();
