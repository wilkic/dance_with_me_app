import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { fromMediaPipe } from './poseFormat.js';

// WASM runtime and model are vendored in public/ so the app is fully
// self-contained: any static file host works, no CDN or backend needed.
const BASE = import.meta.env.BASE_URL;
const WASM_URL = `${BASE}mediapipe/wasm`;
// "lite" model: best speed/accuracy trade-off for mobile browsers.
const MODEL_URL = `${BASE}models/pose_landmarker_lite.task`;
// Engine + model are ~17 MB (8 MB compressed). They are kept in Cache
// Storage under this name, so a phone downloads them once, not on every
// visit (the HTTP cache is short on GitHub Pages and off entirely on a
// dev server with a self-signed certificate). Bump it when either changes.
const CACHE = 'dwm-pose-v1:tasks-vision-0.10.35:lite';

/**
 * The engine and model files, fetched once per page, from Cache Storage
 * when they are there. Started early (prefetch() on page load) so the
 * download happens while the start screen is up, not after "Start".
 */
let filesPromise = null;
function loadFiles() {
  filesPromise ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const timings = {};
    const [wasm, model] = await Promise.all([
      cachedFetch(fileset.wasmBinaryPath, timings, 'wasm'),
      cachedFetch(MODEL_URL, timings, 'model'),
    ]);
    return { fileset, wasm, model, timings };
  })();
  filesPromise.catch(() => { filesPromise = null; }); // a failed download can be retried
  return filesPromise;
}

/**
 * Wraps MediaPipe PoseLandmarker behind a small interface so the detector
 * can be swapped (e.g. MoveNet, or a native module) without touching the
 * rest of the app. Output is always the standardized PoseFrame.
 */
export class PoseDetector {
  /** Start downloading the engine and model in the background. */
  static prefetch() {
    loadFiles().catch(() => { /* init() reports it */ });
  }

  constructor() {
    this.landmarker = null;
    this.lastVideoTime = -1;
    // Where loading time went, in ms (see init). firstDetect fills in later.
    this.timings = null;
  }

  /**
   * Load the WASM engine and the model. delegate 'GPU' (default) or 'CPU'.
   * The files come from loadFiles() (prefetched, cached); timings say how
   * long this call waited for them ('download'), each file's own fetch
   * time and whether it came from the cache, then 'start' (wasm compile +
   * model and GPU setup); warmUp() adds the first detection.
   */
  async init({ delegate = 'GPU' } = {}) {
    const t0 = performance.now();
    const files = await loadFiles();
    const timings = { delegate, ...files.timings };
    const fileset = { ...files.fileset };
    const wasmUrl = URL.createObjectURL(new Blob([files.wasm], { type: 'application/wasm' }));
    fileset.wasmBinaryPath = wasmUrl;
    const baseOptions = { modelAssetBuffer: new Uint8Array(files.model), delegate };
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
      URL.revokeObjectURL(wasmUrl);
    }
    const t2 = performance.now();
    timings.download = t1 - t0;
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

/**
 * Fetch a file whole — from Cache Storage when it's there, else from the
 * network (then kept) — noting how long it took, how big it was and where
 * it came from. Old cache versions are dropped.
 */
async function cachedFetch(url, timings, key) {
  const t = performance.now();
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    dropOldCaches();
  } catch { /* no Cache Storage (old browser, private mode): plain fetch */ }
  let buf = null;
  let cached = false;
  try {
    const hit = await cache?.match(url);
    if (hit) { buf = await hit.arrayBuffer(); cached = true; }
  } catch { /* unreadable entry: fetch again */ }
  if (!buf) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    buf = await res.arrayBuffer();
    cache?.put(url, new Response(buf.slice(0), { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } })).catch(() => {});
  }
  timings[key] = { ms: performance.now() - t, mb: buf.byteLength / 1e6, cached };
  return buf;
}

let dropped = false;
function dropOldCaches() {
  if (dropped) return;
  dropped = true;
  caches.keys().then((keys) => {
    for (const k of keys) if (k.startsWith('dwm-pose-') && k !== CACHE) caches.delete(k);
  }).catch(() => {});
}
