/**
 * WebAudio metronome for dance-lab calibration sessions (?click=BPM).
 * Accents every 4th click so the "1" is feelable. Scheduled with a short
 * lookahead so timer jitter never reaches the audio clock.
 */
export class Metronome {
  constructor(bpm) {
    this.bpm = bpm;
    this.ctx = null;
    this.timer = null;
    this.nextT = 0;
    this.n = 0;
  }

  start() {
    this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    this.ctx.resume();
    this.nextT = this.ctx.currentTime + 0.1;
    this.n = 0;
    this.timer ??= setInterval(() => this.#schedule(), 25);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  #schedule() {
    const period = 60 / this.bpm;
    while (this.nextT < this.ctx.currentTime + 0.15) {
      this.#click(this.nextT, this.n % 4 === 0);
      this.nextT += period;
      this.n++;
    }
  }

  #click(t, accent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1100;
    gain.gain.setValueAtTime(accent ? 0.5 : 0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
  }
}
