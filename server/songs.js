/**
 * Stub song catalog for "next song" pairing. Each entry only needs a title
 * and a BPM — the matcher picks the song whose tempo best bridges two
 * dancers. Replace with a real catalog / streaming API later.
 */
export const SONGS = [
  { title: 'Slow Orbit', bpm: 65 },
  { title: 'Velvet Hours', bpm: 74 },
  { title: 'Low Tide', bpm: 82 },
  { title: 'Night Bus', bpm: 90 },
  { title: 'Copper Sky', bpm: 98 },
  { title: 'Glasshouse', bpm: 105 },
  { title: 'Neon Steps', bpm: 112 },
  { title: 'Mirror Move', bpm: 118 },
  { title: 'Pulse Garden', bpm: 124 },
  { title: 'Static Bloom', bpm: 130 },
  { title: 'Wire Dancer', bpm: 138 },
  { title: 'Redline', bpm: 148 },
  { title: 'Skitter', bpm: 160 },
  { title: 'Overdrive', bpm: 174 },
];

/** Song whose tempo is closest to the target, on a log scale (octave-fair). */
export function pickSong(bpm, songs = SONGS) {
  let best = songs[0];
  let bestDist = Infinity;
  for (const s of songs) {
    const d = Math.abs(Math.log2(s.bpm / bpm));
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}
