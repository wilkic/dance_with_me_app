/**
 * Where this phone's tempo comes from, told to the dance server:
 *
 *   music:  motion  → no microphone; tempo comes from your movement only
 *           beat    → microphone on, but only an onset envelope leaves the
 *                     phone (30 numbers/s) — enough for the server to hear
 *                     the tempo, never the sound
 *
 * Nothing is kept: the server uses it live and forgets it (see /privacy/).
 * Sharing camera video or mic audio to train AI dancers is gone until it
 * comes back as an explicit opt-in. The video level stays 'points' (the
 * PoseFrames already streamed for rooms and guests).
 *
 * Everyone uses motion; ?beat=1 switches the mic on (testing only — not
 * in the menu).
 *
 * Goes over the existing server link as JSON control messages ('level',
 * 'music'); see server/index.js.
 */
export const VIDEO_LEVELS = ['points'];
export const MUSIC_LEVELS = ['motion', 'beat'];
const ENVELOPE_HZ = 30;

export class SessionShare {
  /**
   * @param link       WebSocketTransport (sendJSON) — null when offline
   * @param music      'motion' or 'beat'
   */
  constructor(link, { music = 'motion', onStatus = () => {} } = {}) {
    this.link = link;
    this.onStatus = onStatus;
    this.level = { video: 'points', music: MUSIC_LEVELS.includes(music) ? music : 'motion' };
    // The old menu dials were remembered here; they're gone.
    try { localStorage.removeItem('dwm.share'); } catch { /* storage unavailable */ }
    this.active = false;
    this.mic = null;        // { stream, ctx, analyser, timer, prev, batch, t0 }
    this.dims = null;
  }

  /** Change a level; takes effect immediately if a session is running. */
  configure(level) {
    if (level.video && VIDEO_LEVELS.includes(level.video)) this.level.video = level.video;
    if (level.music && MUSIC_LEVELS.includes(level.music)) this.level.music = level.music;
    this.announce();
    if (this.active) this.#apply();
  }

  /** Tell the server what this session shares (also resent on reconnect). */
  announce(dims = this.dims) {
    if (dims) this.dims = dims;
    this.link?.sendJSON({ type: 'level', ...this.level, ...(this.dims ?? {}) });
  }

  /** Dancing started: switch on whatever the levels ask for. */
  async start(dims) {
    this.active = true;
    this.announce(dims);
    await this.#apply();
  }

  /** Dancing stopped: microphone off. */
  stop() {
    this.active = false;
    this.#stopMic();
  }

  async #apply() {
    if (!this.link) return;
    if (this.level.music === 'motion') this.#stopMic();
    else await this.#startMic();
  }

  async #startMic() {
    if (this.mic) return true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      this.onStatus(`microphone unavailable: ${err.message}`);
      this.level.music = 'motion';
      this.announce();
      return false;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    src.connect(analyser);
    const bins = Math.min(analyser.frequencyBinCount, Math.ceil(5000 / (ctx.sampleRate / analyser.fftSize)));
    const cur = new Uint8Array(analyser.frequencyBinCount);
    const mic = { stream, ctx, analyser, prev: new Uint8Array(analyser.frequencyBinCount), batch: [], t0: performance.now(), timer: null };
    // Spectral flux at 30 Hz: how much louder each band got since the last
    // tick, summed — the classic onset signal. Batched once per second.
    mic.timer = setInterval(() => {
      analyser.getByteFrequencyData(cur);
      let flux = 0;
      for (let i = 0; i < bins; i++) { const d = cur[i] - mic.prev[i]; if (d > 0) flux += d; }
      mic.prev.set(cur);
      mic.batch.push(+(flux / bins / 255).toFixed(3));
      if (mic.batch.length >= ENVELOPE_HZ) {
        this.link?.sendJSON({ type: 'music', t0: Math.round(mic.t0), hz: ENVELOPE_HZ, e: mic.batch });
        mic.batch = [];
        mic.t0 = performance.now();
      }
    }, 1000 / ENVELOPE_HZ);
    this.mic = mic;
    ctx.resume?.();
    this.onStatus('listening for the beat');
    return true;
  }

  #stopMic() {
    const m = this.mic;
    if (!m) return;
    clearInterval(m.timer);
    for (const t of m.stream.getTracks()) t.stop();
    m.ctx.close?.();
    this.mic = null;
  }
}
