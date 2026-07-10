/**
 * Self-contained HTML report: STFT waterfall heatmaps (time × BPM) per
 * body part, ground-truth overlays, the BeatDetector's live estimate, and
 * the scenario check table. No external assets; light/dark theme aware.
 *
 * Written as a body fragment (no <html>/<head>) so it renders both as a
 * plain file and wrapped by artifact hosting.
 */

const quantize = (wf) => ({
  times: wf.times.map((t) => +t.toFixed(2)),
  bpms: wf.bpms,
  mag: wf.mag.map((row) => row.map((v) => Math.round(v * 255))),
});

export function renderReport({ title, intro, scenarios }) {
  const data = {
    scenarios: scenarios.map((s) => ({
      ...s,
      charts: s.charts.map((c) => ({ ...c, wf: quantize(c.wf) })),
    })),
  };

  const checksRows = (s) =>
    s.checks
      .map((c) => {
        const cls = { pass: 'st-pass', gap: 'st-gap', fail: 'st-fail' }[c.status];
        const icon = { pass: '✓', gap: '◆', fail: '✗' }[c.status];
        const word = { pass: 'PASS', gap: 'KNOWN GAP', fail: 'FAIL' }[c.status];
        return `<tr>
          <td><span class="status ${cls}">${icon} ${word}</span></td>
          <td>${c.label}</td>
          <td class="note">${c.note ?? ''}</td>
        </tr>`;
      })
      .join('\n');

  const scenarioSections = data.scenarios
    .map(
      (s, si) => `
  <section class="scenario">
    <h2>${s.title}</h2>
    <p class="desc">${s.desc}</p>
    <table class="checks">
      <thead><tr><th>Result</th><th>Check</th><th>Note</th></tr></thead>
      <tbody>${checksRows(s)}</tbody>
    </table>
    <div class="charts">
      ${s.charts
        .map(
          (c, ci) => `
      <figure class="wf">
        <figcaption><strong>${c.label}</strong> <span class="sub">${c.sub}</span></figcaption>
        <canvas id="wf-${si}-${ci}" data-si="${si}" data-ci="${ci}"></canvas>
      </figure>`,
        )
        .join('\n')}
    </div>
  </section>`,
    )
    .join('\n');

  return `<title>${title}</title>
<style>
  .lab {
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --ink-1: #0b0b0b;
    --ink-2: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --trace: #e34948;
    --good: #0ca30c;
    --warn-ink: #8a5a00;
    --crit: #d03b3b;
    --ramp: #fcfcfb,#cde2fb,#b7d3f6,#9ec5f4,#86b6ef,#6da7ec,#5598e7,#3987e5,#2a78d6,#256abf,#1c5cab,#184f95,#104281,#0d366b;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--ink-1);
    background: var(--page);
    line-height: 1.45;
    padding: 24px;
    max-width: 1180px;
    margin: 0 auto;
  }
  @media (prefers-color-scheme: dark) { .lab { ${''}
    --surface-1: #1a1a19; --page: #0d0d0d; --ink-1: #ffffff; --ink-2: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --axis: #383835;
    --border: rgba(255,255,255,0.10); --trace: #e66767;
    --warn-ink: #fab219; --crit: #e66767;
    --ramp: #1a1a19,#0d366b,#104281,#184f95,#1c5cab,#256abf,#2a78d6,#3987e5,#5598e7,#6da7ec,#86b6ef,#9ec5f4,#b7d3f6,#cde2fb;
  } }
  :root[data-theme="dark"] .lab {
    --surface-1: #1a1a19; --page: #0d0d0d; --ink-1: #ffffff; --ink-2: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --axis: #383835;
    --border: rgba(255,255,255,0.10); --trace: #e66767;
    --warn-ink: #fab219; --crit: #e66767;
    --ramp: #1a1a19,#0d366b,#104281,#184f95,#1c5cab,#256abf,#2a78d6,#3987e5,#5598e7,#6da7ec,#86b6ef,#9ec5f4,#b7d3f6,#cde2fb;
  }
  :root[data-theme="light"] .lab {
    --surface-1: #fcfcfb; --page: #f9f9f7; --ink-1: #0b0b0b; --ink-2: #52514e;
    --muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7;
    --border: rgba(11,11,11,0.10); --trace: #e34948;
    --warn-ink: #8a5a00; --crit: #d03b3b;
    --ramp: #fcfcfb,#cde2fb,#b7d3f6,#9ec5f4,#86b6ef,#6da7ec,#5598e7,#3987e5,#2a78d6,#256abf,#1c5cab,#184f95,#104281,#0d366b;
  }
  .lab h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .lab h2 { font-size: 1.15rem; margin: 0 0 4px; }
  .lab .intro, .lab .desc { color: var(--ink-2); max-width: 72ch; margin: 0 0 12px; }
  .lab .legend { display: flex; gap: 20px; align-items: center; flex-wrap: wrap;
    margin: 12px 0 4px; font-size: 0.85rem; color: var(--ink-2); }
  .lab .legend .sw { display: inline-block; vertical-align: -2px; margin-right: 6px; }
  .lab .colorbar { width: 140px; height: 10px; border-radius: 4px;
    border: 1px solid var(--border); }
  .scenario { background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 18px 20px; margin: 20px 0; }
  .checks { border-collapse: collapse; font-size: 0.875rem; margin: 8px 0 14px; width: 100%; }
  .checks th { text-align: left; color: var(--muted); font-weight: 500;
    border-bottom: 1px solid var(--grid); padding: 4px 10px 4px 0; }
  .checks td { border-bottom: 1px solid var(--grid); padding: 5px 10px 5px 0;
    vertical-align: top; }
  .checks .note { color: var(--ink-2); }
  .status { font-weight: 600; white-space: nowrap; font-size: 0.8rem; }
  .st-pass { color: var(--good); }
  .st-gap { color: var(--warn-ink); }
  .st-fail { color: var(--crit); }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 16px; }
  .wf { margin: 0; }
  .wf figcaption { font-size: 0.85rem; margin-bottom: 4px; }
  .wf .sub { color: var(--muted); }
  .wf canvas { width: 100%; height: auto; display: block; border-radius: 6px; }
  #tip { position: fixed; pointer-events: none; z-index: 10; display: none;
    background: var(--surface-1); color: var(--ink-1); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 8px; font: 0.78rem system-ui, sans-serif;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18); white-space: nowrap; }
  #tip .k { color: var(--ink-2); }
</style>
<div class="lab">
  <h1>${title}</h1>
  <p class="intro">${intro}</p>
  <div class="legend">
    <span><span class="sw" style="border-top:2px solid var(--trace);width:18px;"></span>detector estimate (live BPM)</span>
    <span><span class="sw" style="border-top:2px dashed var(--muted);width:18px;"></span>ground truth</span>
    <span><span class="colorbar sw" id="colorbar"></span>motion power (low → high)</span>
  </div>
  ${scenarioSections}
  <div id="tip"></div>
</div>
<script>
const DATA = ${JSON.stringify(data)};

const cssVar = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function rampStops(el) {
  return cssVar(el, '--ramp').split(',').map((s) => hex2rgb(s.trim()));
}
function rampColor(stops, v) {
  const x = Math.max(0, Math.min(1, v)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const c = stops[i].map((a, k) => Math.round(a + f * (stops[i + 1][k] - a)));
  return \`rgb(\${c[0]},\${c[1]},\${c[2]})\`;
}

const M = { l: 46, r: 10, t: 8, b: 26 }; // plot margins in CSS px
const W = 520, H = 240;

function drawChart(canvas) {
  const root = canvas.closest('.lab');
  const c = DATA.scenarios[+canvas.dataset.si].charts[+canvas.dataset.ci];
  const { times, bpms, mag } = c.wf;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const stops = rampStops(root);
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const t0 = times[0], t1 = times[times.length - 1];
  const b0 = bpms[0], b1 = bpms[bpms.length - 1];
  const xOf = (t) => M.l + ((t - t0) / (t1 - t0)) * pw;
  const yOf = (b) => M.t + (1 - (b - b0) / (b1 - b0)) * ph;

  ctx.fillStyle = cssVar(root, '--surface-1');
  ctx.fillRect(0, 0, W, H);

  // Heatmap cells
  const cw = pw / times.length, ch = ph / bpms.length;
  for (let ti = 0; ti < times.length; ti++) {
    for (let bi = 0; bi < bpms.length; bi++) {
      ctx.fillStyle = rampColor(stops, mag[ti][bi] / 255);
      ctx.fillRect(M.l + ti * cw, M.t + ph - (bi + 1) * ch, cw + 0.5, ch + 0.5);
    }
  }

  // Axes + ticks
  ctx.strokeStyle = cssVar(root, '--axis');
  ctx.lineWidth = 1;
  ctx.strokeRect(M.l, M.t, pw, ph);
  ctx.fillStyle = cssVar(root, '--muted');
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let b = Math.ceil(b0 / 40) * 40; b <= b1; b += 40) {
    ctx.fillText(String(b), M.l - 5, yOf(b));
  }
  ctx.save();
  ctx.translate(12, M.t + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('cycles/min (BPM)', 0, 0);
  ctx.restore();
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let t = Math.ceil(t0 / 5) * 5; t <= t1; t += 5) {
    ctx.fillText(t + 's', xOf(t), M.t + ph + 4);
  }

  // Ground-truth dashed lines, direct-labeled
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = cssVar(root, '--muted');
  ctx.lineWidth = 1.5;
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  for (const o of c.overlays ?? []) {
    if (o.bpm < b0 || o.bpm > b1) continue;
    ctx.beginPath();
    ctx.moveTo(M.l, yOf(o.bpm)); ctx.lineTo(M.l + pw, yOf(o.bpm));
    ctx.stroke();
    ctx.fillStyle = cssVar(root, '--ink-2');
    ctx.fillText(o.label, M.l + 4, yOf(o.bpm) - 2);
  }
  ctx.setLineDash([]);

  // Detector estimate trace
  if (c.trace?.length) {
    ctx.strokeStyle = cssVar(root, '--trace');
    ctx.lineWidth = 2;
    ctx.beginPath();
    let pen = false;
    for (const p of c.trace) {
      if (p.bpm <= 0 || p.t < t0 || p.t > t1) { pen = false; continue; }
      const x = xOf(p.t), y = yOf(Math.min(b1, Math.max(b0, p.bpm)));
      pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    const last = [...c.trace].reverse().find((p) => p.bpm > 0);
    if (last) {
      ctx.fillStyle = cssVar(root, '--trace');
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(\`detector \${Math.round(last.bpm)}\`, Math.min(xOf(last.t) + 4, M.l + pw - 70), yOf(Math.min(b1, Math.max(b0, last.bpm))));
    }
  }
  canvas._geom = { t0, t1, b0, b1 };
}

const tip = document.getElementById('tip');
function hover(ev) {
  const canvas = ev.target;
  const g = canvas._geom;
  if (!g) return;
  const r = canvas.getBoundingClientRect();
  const sx = W / r.width, sy = H / r.height;
  const px = (ev.clientX - r.left) * sx, py = (ev.clientY - r.top) * sy;
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  if (px < M.l || px > M.l + pw || py < M.t || py > M.t + ph) { tip.style.display = 'none'; return; }
  const c = DATA.scenarios[+canvas.dataset.si].charts[+canvas.dataset.ci];
  const ti = Math.min(c.wf.times.length - 1, Math.floor(((px - M.l) / pw) * c.wf.times.length));
  const bi = Math.min(c.wf.bpms.length - 1, Math.floor((1 - (py - M.t) / ph) * c.wf.bpms.length));
  tip.innerHTML = \`<span class="k">t</span> \${c.wf.times[ti].toFixed(1)}s
    <span class="k">·</span> \${c.wf.bpms[bi]} <span class="k">BPM</span>
    <span class="k">· power</span> \${(c.wf.mag[ti][bi] / 255).toFixed(2)}\`;
  tip.style.display = 'block';
  tip.style.left = (ev.clientX + 14) + 'px';
  tip.style.top = (ev.clientY + 14) + 'px';
}

function drawAll() {
  const root = document.querySelector('.lab');
  const stops = rampStops(root);
  const bar = document.getElementById('colorbar');
  bar.style.background = \`linear-gradient(to right, \${[0, .2, .4, .6, .8, 1].map((v) => rampColor(stops, v)).join(',')})\`;
  for (const canvas of document.querySelectorAll('canvas[data-si]')) {
    drawChart(canvas);
    canvas.onmousemove = hover;
    canvas.onmouseleave = () => { tip.style.display = 'none'; };
  }
}
drawAll();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawAll);
new MutationObserver(drawAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
</script>
`;
}
