/**
 * RoomModel: the session-persistent representation of the user's space.
 *
 * MVP reality check: mobile web browsers do not expose LiDAR or depth
 * sensors, so a true Teleport-style 3D scan isn't possible in a web app
 * today. Instead we capture a "clean plate" — a photo of the room with the
 * user out of frame, taken from the exact camera position used for the
 * session. Rendering that plate as the background *is* user removal: the
 * live feed is only ever used for pose detection.
 *
 * The structure is deliberately shaped so richer geometry (WebXR depth on
 * Android, a native LiDAR wrapper, or multi-view reconstruction) can be
 * added later without changing consumers: `geometry` is reserved for that.
 */
export class RoomModel {
  constructor() {
    this.plate = null;        // OffscreenCanvas | HTMLCanvasElement clean plate
    this.width = 0;
    this.height = 0;
    this.mirrored = false;    // capture-time mirroring (front camera)
    this.capturedAt = null;   // Date
    this.orientation = null;  // device orientation at capture, if available
    this.geometry = null;     // reserved: future 3D mesh / plane estimates
  }

  get isCaptured() { return this.plate !== null; }

  /**
   * Capture a clean plate by averaging several video frames. Averaging
   * suppresses sensor noise and momentary flicker so the plate looks
   * stable as a persistent background.
   */
  async capture(video, { frames = 8, intervalMs = 90, mirrored = false } = {}) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    const acc = new Float32Array(w * h * 4);
    const work = document.createElement('canvas');
    work.width = w;
    work.height = h;
    const ctx = work.getContext('2d', { willReadFrequently: true });

    for (let f = 0; f < frames; f++) {
      ctx.drawImage(video, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      for (let i = 0; i < data.length; i++) acc[i] += data[i];
      if (f < frames - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }

    const out = ctx.createImageData(w, h);
    for (let i = 0; i < acc.length; i++) out.data[i] = acc[i] / frames;
    ctx.putImageData(out, 0, 0);

    if (mirrored) {
      const flipped = document.createElement('canvas');
      flipped.width = w;
      flipped.height = h;
      const fctx = flipped.getContext('2d');
      fctx.scale(-1, 1);
      fctx.drawImage(work, -w, 0);
      this.plate = flipped;
    } else {
      this.plate = work;
    }

    this.width = w;
    this.height = h;
    this.mirrored = mirrored;
    this.capturedAt = new Date();
    this.orientation = await captureOrientation();
    return this;
  }

  clear() {
    this.plate = null;
    this.capturedAt = null;
    this.orientation = null;
    this.geometry = null;
  }
}

/** Best-effort snapshot of device orientation (useful metadata for future 3D). */
function captureOrientation() {
  return new Promise((resolve) => {
    if (typeof DeviceOrientationEvent === 'undefined') return resolve(null);
    const timer = setTimeout(() => {
      window.removeEventListener('deviceorientation', handler);
      resolve(null);
    }, 500);
    const handler = (e) => {
      clearTimeout(timer);
      window.removeEventListener('deviceorientation', handler);
      resolve({ alpha: e.alpha, beta: e.beta, gamma: e.gamma });
    };
    window.addEventListener('deviceorientation', handler);
  });
}
