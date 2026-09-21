/**
 * Tempo from any periodic signal — body motion energy (beatDetector.js)
 * or a music onset envelope streamed from a phone's microphone. One
 * autocorrelation, two sources: that is what lets a silent dancer and a
 * dancer with music be matched by the same number.
 */

/**
 * Dominant period of `grid` (uniformly sampled at `hz`) within the BPM
 * range. Returns { bpm, confidence } — bpm 0 when nothing periodic.
 */
export function dominantTempo(grid, hz, { minBpm = 50, maxBpm = 200, minPeak = 0.15, minSeconds = 3 } = {}) {
  const n = grid.length;
  if (n < hz * minSeconds) return { bpm: 0, confidence: 0 };
  let mean = 0;
  for (const v of grid) mean += v;
  mean /= n;
  const sig = new Float64Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) { sig[i] = grid[i] - mean; norm += sig[i] * sig[i]; }
  if (norm < 1e-6) return { bpm: 0, confidence: 0, flat: true };

  const minLag = Math.round((60 / maxBpm) * hz);
  const maxLag = Math.min(Math.round((60 / minBpm) * hz), n - 1);
  let bestLag = 0;
  let bestVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += sig[i] * sig[i + lag];
    const val = acc / norm;
    if (val > bestVal) { bestVal = val; bestLag = lag; }
  }
  if (bestLag > 0 && bestVal > minPeak) return { bpm: 60 / (bestLag / hz), confidence: bestVal };
  return { bpm: 0, confidence: 0 };
}

/**
 * Music tempo from an onset envelope. The phone (music level "beat" or
 * "audio") sends ~1 s batches of spectral-flux samples — no raw audio at
 * the "beat" level — and this keeps a window of them, re-estimating the
 * tempo on every batch. Smoothed like the motion detector so the value
 * is steady enough to drive AI dancers and song picking.
 */
export class EnvelopeTempo {
  constructor({ windowS = 8, hz = 30 } = {}) {
    this.hz = hz;
    this.max = windowS * hz;
    this.grid = [];
    this.state = { bpm: 0, confidence: 0, at: 0 };
  }

  /** batch: { t0, hz, e: number[] } */
  push(batch) {
    if (!Array.isArray(batch.e) || !batch.e.length) return this.state;
    if (batch.hz && batch.hz !== this.hz) {
      // Resample crudely by nearest sample onto our grid rate.
      const ratio = batch.hz / this.hz;
      const out = [];
      for (let i = 0; i < batch.e.length / ratio; i++) out.push(+batch.e[Math.min(batch.e.length - 1, Math.round(i * ratio))] || 0);
      this.grid.push(...out);
    } else {
      for (const v of batch.e) this.grid.push(+v || 0);
    }
    if (this.grid.length > this.max) this.grid.splice(0, this.grid.length - this.max);
    const { bpm, confidence } = dominantTempo(this.grid, this.hz, { minBpm: 60, maxBpm: 200 });
    if (bpm > 0) {
      this.state.bpm = this.state.bpm > 0 ? this.state.bpm * 0.7 + bpm * 0.3 : bpm;
      this.state.confidence = confidence;
    } else {
      this.state.confidence *= 0.8;
      if (this.state.confidence < 0.1) this.state.bpm = 0;
    }
    this.state.at = batch.t0 ?? 0;
    return this.state;
  }

  reset() {
    this.grid.length = 0;
    this.state = { bpm: 0, confidence: 0, at: 0 };
  }
}

const OCTAVE_LO = 90;
/** Fold a tempo into the canonical octave [90, 180) — half/double time are one groove. */
export function foldTempo(bpm) {
  if (!(bpm > 0)) return 0;
  while (bpm < OCTAVE_LO) bpm *= 2;
  while (bpm >= OCTAVE_LO * 2) bpm /= 2;
  return bpm;
}

/** Relative gap between two tempi in the folded octave (0 = same groove). */
export function tempoGap(a, b) {
  if (!(a > 0) || !(b > 0)) return 1;
  let lo = foldTempo(a);
  let hi = foldTempo(b);
  if (lo > hi) [lo, hi] = [hi, lo];
  return Math.min((hi - lo) / ((hi + lo) / 2), (lo * 2 - hi) / ((lo * 2 + hi) / 2));
}
