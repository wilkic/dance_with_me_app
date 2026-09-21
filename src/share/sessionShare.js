/**
 * What this phone shares with the dance server for the library — the
 * material AI dancers are built from. Two dials, each from "minimal" to
 * "everything":
 *
 *   video:  points  → the PoseFrames already streamed (nothing extra)
 *           video   → the camera feed too (MediaRecorder chunks)
 *   music:  motion  → no microphone; tempo comes from your movement only
 *           beat    → microphone on, but only an onset envelope leaves the
 *                     phone (30 numbers/s) — enough for the server to hear
 *                     the tempo, never the sound
 *           audio   → the microphone recording too
 *
 * Everything goes over the existing server link as JSON control messages
 * ('level', 'music', 'media'); see server/index.js and server/recorder.js.
 */
export const VIDEO_LEVELS = ['points', 'video'];
export const MUSIC_LEVELS = ['motion', 'beat', 'audio'];
const STORE_KEY = 'dwm.share';
const ENVELOPE_HZ = 30;

function pickMime(cands) {
  if (typeof MediaRecorder === 'undefined') return null;
  return cands.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

function toBase64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export class SessionShare {
  /**
   * @param link       WebSocketTransport (sendJSON) — null when offline
   * @param videoTrack () => MediaStreamTrack | null   the camera's video track
   */
  constructor(link, { videoTrack, onStatus = () => {} } = {}) {
    this.link = link;
    this.videoTrack = videoTrack;
    this.onStatus = onStatus;
    this.level = { video: 'points', music: 'motion' };
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved && VIDEO_LEVELS.includes(saved.video) && MUSIC_LEVELS.includes(saved.music)) this.level = saved;
    } catch { /* storage unavailable */ }
    this.active = false;
    this.mic = null;        // { stream, ctx, analyser, timer, prev, batch, t0 }
    this.recorders = {};    // kind -> MediaRecorder
    this.seq = 0;
    this.dims = null;
  }

  /** Change a level; takes effect immediately if a session is running. */
  configure(level) {
    if (level.video && VIDEO_LEVELS.includes(level.video)) this.level.video = level.video;
    if (level.music && MUSIC_LEVELS.includes(level.music)) this.level.music = level.music;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.level)); } catch { /* ignore */ }
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

  /** Dancing stopped: microphone off, recorders stopped. */
  stop() {
    this.active = false;
    this.#stopRecorder('video');
    this.#stopRecorder('audio');
    this.#stopMic();
  }

  async #apply() {
    if (!this.link) return;
    // Music: mic for beat/audio, plus a recorder for audio.
    if (this.level.music === 'motion') {
      this.#stopRecorder('audio');
      this.#stopMic();
    } else {
      const ok = await this.#startMic();
      if (ok && this.level.music === 'audio') this.#startRecorder('audio', this.mic.stream, ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'], { audioBitsPerSecond: 48_000 });
      else this.#stopRecorder('audio');
    }
    // Video: recorder on the camera track.
    if (this.level.video === 'video') {
      const track = this.videoTrack?.();
      if (track) this.#startRecorder('video', new MediaStream([track]), ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'], { videoBitsPerSecond: 600_000 });
    } else {
      this.#stopRecorder('video');
    }
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

  #startRecorder(kind, stream, mimes, opts) {
    if (this.recorders[kind]) return;
    const mimeType = pickMime(mimes);
    if (!mimeType) { this.onStatus(`${kind} recording not supported here`); return; }
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType, ...opts }); } catch (err) { this.onStatus(`${kind} recorder failed: ${err.message}`); return; }
    rec.ondataavailable = async (ev) => {
      if (!ev.data?.size || !this.recorders[kind]) return;
      const data = toBase64(await ev.data.arrayBuffer());
      this.link?.sendJSON({ type: 'media', kind, mime: mimeType, seq: this.seq++, data });
    };
    rec.start(1000);
    this.recorders[kind] = rec;
    this.onStatus(`sharing ${kind}`);
  }

  #stopRecorder(kind) {
    const rec = this.recorders[kind];
    if (!rec) return;
    delete this.recorders[kind];
    try { rec.stop(); } catch { /* already stopped */ }
  }
}
