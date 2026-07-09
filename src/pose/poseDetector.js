import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { fromMediaPipe } from './poseFormat.js';

const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
// "lite" model: best speed/accuracy trade-off for mobile browsers.
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

/**
 * Wraps MediaPipe PoseLandmarker behind a small interface so the detector
 * can be swapped (e.g. MoveNet, or a native module) without touching the
 * rest of the app. Output is always the standardized PoseFrame.
 */
export class PoseDetector {
  constructor() {
    this.landmarker = null;
    this.lastVideoTime = -1;
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
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
