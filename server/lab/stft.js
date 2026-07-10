/**
 * Short-time Fourier transform on a BPM grid → waterfall matrices.
 *
 * Instead of a radix-2 FFT and awkward bin→BPM mapping, each BPM bin is
 * evaluated directly (Goertzel-style single-bin DFT) over a Hann-windowed,
 * mean-removed slice. O(bins × window) per hop is nothing at lab scale and
 * gives waterfalls with 1-BPM-resolution rows aligned across channels.
 *
 * BPM here means CYCLES per minute of the analyzed series. A position
 * series oscillating at 1 Hz → 60. The detector's energy/speed series for
 * the same movement peaks at 120 (speed doubling) — plot both channels on
 * the same axis and the octave bias is visible directly.
 */

export function waterfall(series, hz, {
  windowS = 8,
  hopS = 0.5,
  bpmMin = 20,
  bpmMax = 260,
  bpmStep = 2,
} = {}) {
  const n = series[0].length;
  const win = Math.round(windowS * hz);
  const hop = Math.round(hopS * hz);
  const bpms = [];
  for (let b = bpmMin; b <= bpmMax; b += bpmStep) bpms.push(b);

  // Precompute Hann window and per-bin oscillators.
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
  const cos = bpms.map((bpm) => {
    const w = (2 * Math.PI * (bpm / 60)) / hz;
    const c = new Float32Array(win);
    for (let i = 0; i < win; i++) c[i] = Math.cos(w * i);
    return c;
  });
  const sin = bpms.map((bpm) => {
    const w = (2 * Math.PI * (bpm / 60)) / hz;
    const s = new Float32Array(win);
    for (let i = 0; i < win; i++) s[i] = Math.sin(w * i);
    return s;
  });

  const times = [];
  const rows = []; // rows[timeIdx][binIdx] = summed power across series
  for (let start = 0; start + win <= n; start += hop) {
    times.push((start + win / 2) / hz);
    const row = new Float64Array(bpms.length);
    for (const s of series) {
      // Window mean removal so DC doesn't leak into low bins.
      let mean = 0;
      for (let i = 0; i < win; i++) mean += s[start + i];
      mean /= win;
      for (let b = 0; b < bpms.length; b++) {
        let re = 0;
        let im = 0;
        const cb = cos[b];
        const sb = sin[b];
        for (let i = 0; i < win; i++) {
          const v = (s[start + i] - mean) * hann[i];
          re += v * cb[i];
          im += v * sb[i];
        }
        row[b] += re * re + im * im;
      }
    }
    rows.push(row);
  }

  // Normalize to [0,1] over the whole waterfall, sqrt-compressed so weak
  // secondary bands stay visible next to a dominant one.
  let max = 0;
  for (const row of rows) for (const v of row) max = Math.max(max, v);
  const mag = rows.map((row) =>
    Array.from(row, (v) => (max > 0 ? Math.sqrt(v / max) : 0)),
  );

  return { times, bpms, mag };
}

/** Strongest bin per time slice → ridge line [{t, bpm, strength}]. */
export function ridge(wf) {
  return wf.times.map((t, ti) => {
    let best = 0;
    let bi = 0;
    wf.mag[ti].forEach((v, i) => {
      if (v > best) {
        best = v;
        bi = i;
      }
    });
    return { t, bpm: wf.bpms[bi], strength: best };
  });
}
