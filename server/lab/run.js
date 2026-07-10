/**
 * Dance lab runner — "dance unit tests" for the rhythm engine.
 *
 *   node lab/run.js                  run the synthetic scenario suite,
 *                                    print checks, write lab/out/report.html
 *   node lab/run.js analyze <f.jsonl> [--bpm N]
 *                                    waterfall report for a recorded session
 *                                    (see RECORD_DIR in ../index.js); --bpm
 *                                    is the metronome ground truth if the
 *                                    recording carries no label message
 *
 * Scenario checks are two-tier: PASS/FAIL verify current behavior the
 * detector is supposed to have, KNOWN GAP marks behavior we've measured,
 * understand, and intend to fix (they don't fail the run — they're the
 * research agenda).
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BeatDetector } from '../beatDetector.js';
import { emptyPoseFrame } from '../../src/pose/poseFormat.js';
import { makeDancer, beatBpmOfPosHz } from './synthDancer.js';
import { resample, positionChannel, speedChannel } from './signals.js';
import { waterfall, ridge } from './stft.js';
import { renderReport } from './report.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

// ---------------------------------------------------------------------------
// Analysis plumbing

function detectorTrace(frames) {
  const det = new BeatDetector();
  const trace = [];
  let lastSampled = -Infinity;
  for (const f of frames) {
    const state = det.update(f);
    if (f.t - lastSampled >= 500) {
      lastSampled = f.t;
      trace.push({ t: +(f.t / 1000).toFixed(2), bpm: +state.bpm.toFixed(1), conf: +state.confidence.toFixed(2) });
    }
  }
  return trace;
}

/** Median of the last few non-zero detector estimates — the "verdict" BPM. */
function settledBpm(trace) {
  const tail = trace.filter((p) => p.bpm > 0).slice(-7).map((p) => p.bpm).sort((a, b) => a - b);
  return tail.length ? tail[Math.floor(tail.length / 2)] : 0;
}

/** Spread (max−min) of the estimate over the last ~10s — 0 means locked. */
function wander(trace) {
  const tail = trace.filter((p) => p.bpm > 0).slice(-20).map((p) => p.bpm);
  return tail.length ? Math.max(...tail) - Math.min(...tail) : 0;
}

/** Mean reported confidence over the last ~10s. */
function tailConf(trace) {
  const tail = trace.slice(-20);
  return tail.length ? tail.reduce((s, p) => s + p.conf, 0) / tail.length : 0;
}

const near = (a, b, tol = 8) => Math.abs(a - b) <= tol;

/** Strongest sustained band of a waterfall (median ridge over time). */
function dominantBand(wf) {
  const r = ridge(wf).filter((p) => p.strength > 0.3);
  if (!r.length) return { bpm: 0, strength: 0 };
  const bpms = r.map((p) => p.bpm).sort((a, b) => a - b);
  return {
    bpm: bpms[Math.floor(bpms.length / 2)],
    strength: r.reduce((s, p) => s + p.strength, 0) / r.length,
  };
}

function chartsFor(frames, { moving, trace }) {
  const grid = resample(frames);
  const stftOpts = { windowS: 8, hopS: 0.5, bpmMin: 20, bpmMax: 260, bpmStep: 2 };
  const truthBeat = Object.entries(moving).map(([part, hz]) => ({
    bpm: Math.round(beatBpmOfPosHz(hz)),
    label: `${part} beat ${Math.round(beatBpmOfPosHz(hz))}`,
  }));
  const charts = [{
    key: 'all-speed',
    label: 'Detector view',
    sub: 'whole-body speed, one scalar — what BeatDetector analyzes',
    wf: waterfall(speedChannel(grid, 'all'), grid.hz, stftOpts),
    overlays: truthBeat,
    trace,
  }];
  for (const part of ['arms', 'hips', 'legs']) {
    const hz = moving[part];
    charts.push({
      key: `${part}-pos`,
      label: `${part} — position`,
      sub: 'detrended joint positions; true movement frequency, no speed doubling',
      wf: waterfall(positionChannel(grid, part), grid.hz, stftOpts),
      overlays: hz
        ? [{ bpm: Math.round(hz * 60), label: `${part} cycle ${Math.round(hz * 60)} (beat ${Math.round(beatBpmOfPosHz(hz))})` }]
        : [],
    });
  }
  return { charts, grid };
}

// ---------------------------------------------------------------------------
// Scenario suite

// `moving`: part → position Hz (beat BPM = 120 × Hz, see synthDancer.js).
// `click`: the design metronome — the tempo a human observer should feel
// (used by video.js to overlay audio; refHz phase-aligns clicks to that
// part's movement extremes, where motion beats are perceived).
export const SCENARIOS = [
  {
    name: 'arms-only-120',
    title: 'Arm wave at 120 BPM',
    desc: 'Baseline: only the arms move (1.0 Hz swing → 120 BPM beat). The case that already works in the wild.',
    parts: { arms: { hz: 1.0, amp: 0.10 } },
    click: { bpm: 120, refHz: 1.0, note: 'metronome on the arm beat' },
    checks: (ctx) => [
      verdict('detector locks ~120', near(ctx.bpm, 120), `settled at ${ctx.bpm.toFixed(0)} BPM`),
    ],
  },
  {
    name: 'hips-only-96',
    title: 'Hip sway at 96 BPM, nothing else',
    desc: 'Hips (and shoulders riding along) sway laterally at 0.8 Hz → 96 BPM beat. In isolation the slow layer is the only signal — can the detector see it at all?',
    parts: { hips: { hz: 0.8, amp: 0.045, axis: 'x' } },
    click: { bpm: 96, refHz: 0.8, note: 'metronome on the hip beat' },
    checks: (ctx) => [
      verdict('detector locks ~96', near(ctx.bpm, 96), `settled at ${ctx.bpm.toFixed(0)} BPM`),
    ],
  },
  {
    name: 'layered-150-over-60',
    title: 'Layered: arm flourish at 150 over a 60 BPM groove',
    desc: 'The reported bug, synthesized: hips and feet carry a slow groove (0.5 Hz → 60 BPM beat) while the arms flourish on top (1.25 Hz → 150 BPM beat). A human feels the groove; the detector hears the arms.',
    parts: {
      arms: { hz: 1.25, amp: 0.10 },
      hips: { hz: 0.5, amp: 0.05, axis: 'x' },
      legs: { hz: 0.5, amp: 0.035 },
    },
    click: { bpm: 60, refHz: 0.5, note: 'metronome on the GROOVE (hips/legs), not the arm flourish' },
    checks: (ctx) => [
      gapUnless('detector locks onto the groove (60, or its 120 octave)',
        ctx.wander < 15 && (near(ctx.bpm, 60) || near(ctx.bpm, 120)),
        `locks the arms at 150 first, then wanders (spread ${ctx.wander.toFixed(0)} BPM over the last 10s) — the single autocorrelation is bistable between bands and the EMA smoothing averages them into noise`),
      gapUnless('confidence drops when the estimate is ambiguous',
        ctx.wander < 15 || ctx.conf < 0.5,
        `confidence holds ~${ctx.conf.toFixed(2)} while the estimate wanders — it measures periodicity, not estimate trustworthiness`),
      verdict('hips position channel resolves the 30 c/min groove band',
        near(ctx.band('hips-pos').bpm, 30, 6),
        `dominant band ${ctx.band('hips-pos').bpm} c/min — per-part decomposition sees what the scalar misses`),
      verdict('arms position channel resolves the 75 c/min flourish band',
        near(ctx.band('arms-pos').bpm, 75, 6),
        `dominant band ${ctx.band('arms-pos').bpm} c/min`),
    ],
  },
  {
    name: 'nyquist-half-tempo',
    title: 'Half-tempo (Nyquist) dancing to a 120 BPM song',
    desc: 'Whole body moves on every other beat — 0.5 Hz everywhere → 60 BPM movement against 120 BPM music. Dancing at the Nyquist of the song is idiomatic, not an error; the matcher folds octaves so 60 should be fine downstream.',
    parts: {
      arms: { hz: 0.5, amp: 0.08 },
      hips: { hz: 0.5, amp: 0.04, axis: 'x' },
      legs: { hz: 0.5, amp: 0.04 },
    },
    click: { bpm: 120, refHz: 0.5, note: 'metronome is the SONG at 120; body hits every other click' },
    checks: (ctx) => [
      verdict('detector reports the movement octave (~60)', near(ctx.bpm, 60),
        `settled at ${ctx.bpm.toFixed(0)} BPM; matcher folds 60⇄120⇄240 into one octave, so matching still works`),
    ],
  },
  {
    name: 'slow-sway-42',
    title: 'Slow sway at 42 BPM — below the detector floor',
    desc: 'Gentle full-body sway at 0.35 Hz → 42 BPM beat, under MIN_BPM = 50. The energy signal is clean and periodic; the search range just refuses to look there.',
    parts: {
      hips: { hz: 0.35, amp: 0.05, axis: 'x' },
      arms: { hz: 0.35, amp: 0.06 },
    },
    click: { bpm: 42, refHz: 0.35, note: 'metronome on the sway beat, below the detector floor' },
    checks: (ctx) => [
      gapUnless('detector reports ~42 — or at least stays silent', near(ctx.bpm, 42, 5) || ctx.bpm === 0,
        `reports ${ctx.bpm ? ctx.bpm.toFixed(0) : 'nothing'} BPM (spread ${ctx.wander.toFixed(0)}, conf ~${ctx.conf.toFixed(2)}) — below-floor motion doesn't read as silence: near the floor it pins to the 50 BPM range edge, further below it wanders across random in-range tempos, either way clearing the 0.15 accept threshold`),
      verdict('hips position channel resolves the 21 c/min band',
        near(ctx.band('hips-pos').bpm, 21, 5),
        `dominant band ${ctx.band('hips-pos').bpm} c/min — the signal is there, the search range just excludes it`),
    ],
  },
  {
    name: 'jitter-arms-120',
    title: 'Arm wave at 120 BPM with pose jitter',
    desc: 'Baseline plus gaussian keypoint noise (σ = 0.004 image units) at the level a phone pose detector wobbles. Speed-based energy amplifies white noise (differentiation), so jitter robustness is a real calibration axis.',
    parts: { arms: { hz: 1.0, amp: 0.10 } },
    noise: 0.004,
    click: { bpm: 120, refHz: 1.0, note: 'metronome on the arm beat; keypoints jittered' },
    checks: (ctx) => [
      gapUnless('detector locks ~120 under realistic jitter', near(ctx.bpm, 120, 10) && ctx.wander < 20,
        `settled at ${ctx.bpm.toFixed(0)} BPM, spread ${ctx.wander.toFixed(0)} — differentiating positions amplifies white noise, so jitter lands in the exact signal the detector analyzes; smoothing or position-domain analysis is the fix direction`),
    ],
  },
];

const verdict = (label, ok, note) => ({ label, status: ok ? 'pass' : 'fail', note });
const gapUnless = (label, ok, note) => ({ label, status: ok ? 'pass' : 'gap', note });

function runSuite() {
  const scenarios = [];
  let failed = false;

  for (const sc of SCENARIOS) {
    const dancer = makeDancer({ parts: sc.parts, noise: sc.noise });
    const frames = dancer.frames(40);
    const trace = detectorTrace(frames);
    const moving = Object.fromEntries(Object.entries(sc.parts).map(([p, v]) => [p, v.hz]));
    const { charts } = chartsFor(frames, { moving, trace });

    const bands = new Map(charts.map((c) => [c.key, dominantBand(c.wf)]));
    const ctx = {
      bpm: settledBpm(trace),
      wander: wander(trace),
      conf: tailConf(trace),
      trace,
      band: (k) => bands.get(k),
    };
    const checks = sc.checks(ctx);

    console.log(`\n■ ${sc.title}`);
    for (const c of checks) {
      const tag = { pass: 'PASS', gap: 'GAP ', fail: 'FAIL' }[c.status];
      console.log(`  ${tag}  ${c.label}${c.note ? ` — ${c.note}` : ''}`);
      if (c.status === 'fail') failed = true;
    }

    scenarios.push({ name: sc.name, title: sc.title, desc: sc.desc, checks, charts });
  }

  const html = renderReport({
    title: 'Dance Lab — BPM calibration report',
    intro: 'Synthetic dancers with independent per-body-part oscillators, analyzed three ways: '
      + 'the production BeatDetector (red trace), its whole-body speed scalar (“Detector view” waterfall), '
      + 'and per-part position STFT waterfalls. Position frequency is in cycles/min; speed signals read one octave up '
      + '(|velocity| peaks twice per cycle). Dashed lines mark ground truth.',
    scenarios,
  });
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, 'report.html');
  writeFileSync(out, html);
  console.log(`\nreport: ${out}`);
  return failed;
}

// ---------------------------------------------------------------------------
// Recording analysis

function loadRecording(path) {
  const frames = [];
  let label = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.type === 'label') { label = o; continue; }
    const f = emptyPoseFrame();
    f.t = o.t;
    f.keypoints.set(o.k);
    frames.push(f);
  }
  if (frames.length) {
    const t0 = frames[0].t;
    for (const f of frames) f.t -= t0;
  }
  return { frames, label };
}

function runAnalyze(path, argBpm) {
  const { frames, label } = loadRecording(path);
  if (frames.length < 90) {
    console.error(`only ${frames.length} frames in ${path} — need a few seconds of dancing`);
    process.exit(1);
  }
  const clickBpm = argBpm ?? label?.clickBpm;
  const trace = detectorTrace(frames);
  const { charts } = chartsFor(frames, { moving: {}, trace });
  if (clickBpm) {
    for (const c of charts) {
      c.overlays = [
        { bpm: Math.round(clickBpm), label: `metronome ${Math.round(clickBpm)}` },
        { bpm: Math.round(clickBpm / 2), label: `½× ${Math.round(clickBpm / 2)}` },
      ];
    }
  }
  const durS = ((frames[frames.length - 1].t - frames[0].t) / 1000).toFixed(0);
  const html = renderReport({
    title: `Dance Lab — ${basename(path)}`,
    intro: `Recorded session: ${frames.length} frames over ${durS}s`
      + (clickBpm ? `, metronome at ${clickBpm} BPM (dashed).` : ', no metronome label.')
      + ' Red trace is the production detector; waterfalls are whole-body speed plus per-part position STFTs.',
    scenarios: [{
      name: basename(path),
      title: 'Recorded session',
      desc: `Detector settled at ${settledBpm(trace).toFixed(0)} BPM.`,
      checks: [],
      charts,
    }],
  });
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, basename(path).replace(/\.jsonl$/, '') + '.html');
  writeFileSync(out, html);
  console.log(`report: ${out}`);
}

// ---------------------------------------------------------------------------

// Only dispatch when executed directly — video.js imports SCENARIOS.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'analyze') {
    const bpmIdx = rest.indexOf('--bpm');
    const bpm = bpmIdx >= 0 ? Number(rest[bpmIdx + 1]) : undefined;
    runAnalyze(rest[0], bpm);
  } else {
    process.exit(runSuite() ? 1 : 0);
  }
}
