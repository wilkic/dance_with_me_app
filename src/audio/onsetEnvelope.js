/**
 * The beat of a sound, as numbers: spectral flux at 30 Hz — how much louder
 * each band got since the last tick, summed (the classic onset signal) —
 * batched once a second as { t0, hz, e } for the dance server's
 * EnvelopeTempo (server/tempo.js). The sound itself never leaves the phone.
 *
 * Works on any MediaStream: the microphone, a file being played, a shared
 * tab, or room music arriving over WebRTC.
 */
const HZ = 30;

export class OnsetEnvelope {
  /** onBatch({ t0, hz, e }) about once a second. */
  constructor(stream, onBatch) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const src = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    src.connect(analyser); // analysed only, never played from here
    const bins = Math.min(analyser.frequencyBinCount, Math.ceil(5000 / (this.ctx.sampleRate / analyser.fftSize)));
    const cur = new Uint8Array(analyser.frequencyBinCount);
    const prev = new Uint8Array(analyser.frequencyBinCount);
    let batch = [];
    let t0 = performance.now();
    this.timer = setInterval(() => {
      analyser.getByteFrequencyData(cur);
      let flux = 0;
      for (let i = 0; i < bins; i++) { const d = cur[i] - prev[i]; if (d > 0) flux += d; }
      prev.set(cur);
      batch.push(+(flux / bins / 255).toFixed(3));
      if (batch.length >= HZ) {
        onBatch({ t0: Math.round(t0), hz: HZ, e: batch });
        batch = [];
        t0 = performance.now();
      }
    }, 1000 / HZ);
    this.resume();
  }

  /** Browsers start audio suspended without a tap: call again from one. */
  resume() {
    this.ctx.resume?.().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.ctx.close?.().catch(() => {});
  }
}
