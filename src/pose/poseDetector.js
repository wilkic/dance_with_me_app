import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { fromMediaPipe } from './poseFormat.js';

// WASM runtime and model are vendored in public/ so the app is fully
// self-contained: any static file host works, no CDN or backend needed.
const BASE = import.meta.env.BASE_URL;
const WASM_URL = `${BASE}mediapipe/wasm`;
// "lite" model: best speed/accuracy trade-off for mobile browsers.
const MODEL_URL = `${BASE}models/pose_landmarker_lite.task`;

/**
 * Wraps MediaPipe PoseLandmarker behind a small interface so the detector
 * can be swapped (e.g. MoveNet, or a native module) without touching the
 * rest of the app. Output is always the standardized PoseFrame.
 */
export class PoseDetector {
  constructor() {
    this.landmarker = null;
    this.lastVideoTime = -1;
    // Where loading time went, in ms (see init). firstDetect fills in later.
    this.timings = null;
  }

  /**
   * Load the WASM engine and the model. delegate 'GPU' (default) or 'CPU'.
   * With timed=true the engine and model are downloaded first, on their
   * own, so each step can be timed: download wasm, download model, start
   * (wasm compile + model and GPU setup), then the first detection. Without
   * it MediaPipe streams and compiles the engine as it downloads.
   */
  async init({ delegate = 'GPU', timed = false } = {}) {
    const t0 = performance.now();
    const timings = { delegate };
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const baseOptions = { modelAssetPath: MODEL_URL, delegate };
    let wasmUrl = null;
    if (timed) {
      const [wasm, model] = await Promise.all([
        timedFetch(fileset.wasmBinaryPath, timings, 'wasm'),
        timedFetch(MODEL_URL, timings, 'model'),
      ]);
      wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
      fileset.wasmBinaryPath = wasmUrl;
      delete baseOptions.modelAssetPath;
      baseOptions.modelAssetBuffer = new Uint8Array(model);
    }
    const t1 = performance.now();
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions,
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    } finally {
      if (wasmUrl) URL.revokeObjectURL(wasmUrl);
    }
    const t2 = performance.now();
    if (timed) timings.download = t1 - t0;
    timings.start = t2 - t1;
    timings.total = t2 - t0;
    this.timings = timings;
  }

  /**
   * Run one detection right after loading, so the first-frame setup (on
   * the GPU that often still means compiling shaders) happens behind the
   * loading screen instead of as a hitch when dancing starts. Timed.
   */
  warmUp(video) {
    if (!this.landmarker || this.timings?.firstDetect !== undefined) return;
    const t = performance.now();
    try {
      this.landmarker.detectForVideo(video, t);
    } catch {
      // No frame yet: the real loop will do the setup instead.
    }
    if (this.timings) this.timings.firstDetect = performance.now() - t;
    this.onTimings?.(this.timings);
  }

  /**
   * Detect the pose in the current video frame.
   * Returns a PoseFrame, or null if the frame was already processed or no
   * person is visible.
   */
  detect(video, mirrored) {
    if (!this.landmarker || video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;
    const t = performance.now();
    const result = this.landmarker.detectForVideo(video, t);
    if (!result.landmarks || result.landmarks.length === 0) return null;
    return fromMediaPipe(result.landmarks[0], t, mirrored);
  }

  close() {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

/** Fetch a file whole, noting how long it took and how big it was. */
async function timedFetch(url, timings, key) {
  const t = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  timings[key] = { ms: performance.now() - t, mb: buf.byteLength / 1e6 };
  return buf;
}
