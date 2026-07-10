/**
 * Tempo-first dancer matching (Tier 1 of the tiered approach).
 *
 * Dancers are matched purely on tempo compatibility — phase is ignored,
 * because the paired "next song" is what syncs them, not phase alignment.
 * Half/double tempo is treated as the same groove (a dancer stepping at 60
 * matches one at 120): tempi are folded into a canonical octave before
 * comparison. Tier 2 (movement-style matching) plugs in here later as an
 * additional score.
 */

const OCTAVE_LO = 90; // canonical tempo octave [90, 180)

function foldTempo(bpm) {
  while (bpm < OCTAVE_LO) bpm *= 2;
  while (bpm >= OCTAVE_LO * 2) bpm /= 2;
  return bpm;
}

export class Matcher {
  constructor({ tolerance = 0.06, minConfidence = 0.3 } = {}) {
    this.tolerance = tolerance;       // max relative tempo gap
    this.minConfidence = minConfidence;
  }

  /**
   * Shared tempo of two dancers if compatible, else null.
   * Compares in the folded octave, including across its wrap point
   * (91 vs 178 ≈ 89×2 should still match).
   */
  sharedTempo(a, b) {
    let [lo, hi] = [foldTempo(a), foldTempo(b)].sort((x, y) => x - y);
    if (hi - lo > (hi + lo) / 2 * this.tolerance) {
      // Retry across the octave boundary.
      [lo, hi] = [hi, lo * 2];
      if (hi - lo > (hi + lo) / 2 * this.tolerance) return null;
    }
    return Math.sqrt(lo * hi); // geometric mean: octave-fair midpoint
  }

  /**
   * Greedily pair dancers with compatible tempi, most-confident first.
   * profiles: [{ id, bpm, confidence }] → [{ a, b, bpm }]
   */
  pair(profiles) {
    const ready = profiles
      .filter((p) => p.bpm > 0 && p.confidence >= this.minConfidence)
      .sort((x, y) => y.confidence - x.confidence);
    const pairs = [];
    const used = new Set();
    for (let i = 0; i < ready.length; i++) {
      if (used.has(ready[i].id)) continue;
      for (let j = i + 1; j < ready.length; j++) {
        if (used.has(ready[j].id)) continue;
        const bpm = this.sharedTempo(ready[i].bpm, ready[j].bpm);
        if (bpm !== null) {
          pairs.push({ a: ready[i].id, b: ready[j].id, bpm });
          used.add(ready[i].id).add(ready[j].id);
          break;
        }
      }
    }
    return pairs;
  }
}
