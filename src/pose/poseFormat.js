/**
 * Standardized pose data format.
 *
 * This is the contract for everything downstream: avatar rendering, rhythm
 * analysis, and (later) network transmission to other dancers. Keep it
 * stable and serializable.
 *
 * A PoseFrame:
 *   {
 *     t: number,          // capture timestamp, ms (performance.now() domain)
 *     keypoints: Float32Array of length N_KEYPOINTS * 4,
 *                         // per keypoint: x, y, z, visibility
 *                         // x, y normalized to [0,1] in image space
 *                         // z roughly meters relative to hip midpoint
 *     mirrored: boolean,  // whether x is already mirrored for display
 *   }
 *
 * Keypoint indices follow the MediaPipe BlazePose 33-landmark topology so
 * different detectors can be adapted to this ordering later.
 */

export const N_KEYPOINTS = 33;
export const STRIDE = 4; // x, y, z, visibility

// Named indices for the joints the app reasons about directly.
export const KP = {
  NOSE: 0,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30,
  LEFT_FOOT: 31, RIGHT_FOOT: 32,
};

/** Bone list used for stick-figure rendering and motion analysis. */
export const BONES = [
  [KP.LEFT_SHOULDER, KP.RIGHT_SHOULDER],
  [KP.LEFT_SHOULDER, KP.LEFT_ELBOW],
  [KP.LEFT_ELBOW, KP.LEFT_WRIST],
  [KP.RIGHT_SHOULDER, KP.RIGHT_ELBOW],
  [KP.RIGHT_ELBOW, KP.RIGHT_WRIST],
  [KP.LEFT_SHOULDER, KP.LEFT_HIP],
  [KP.RIGHT_SHOULDER, KP.RIGHT_HIP],
  [KP.LEFT_HIP, KP.RIGHT_HIP],
  [KP.LEFT_HIP, KP.LEFT_KNEE],
  [KP.LEFT_KNEE, KP.LEFT_ANKLE],
  [KP.RIGHT_HIP, KP.RIGHT_KNEE],
  [KP.RIGHT_KNEE, KP.RIGHT_ANKLE],
  [KP.LEFT_ANKLE, KP.LEFT_FOOT],
  [KP.RIGHT_ANKLE, KP.RIGHT_FOOT],
];

export function emptyPoseFrame() {
  return { t: 0, keypoints: new Float32Array(N_KEYPOINTS * STRIDE), mirrored: false };
}

/** Build a PoseFrame from a MediaPipe PoseLandmarker result (first pose). */
export function fromMediaPipe(landmarks, t, mirrored) {
  const frame = emptyPoseFrame();
  frame.t = t;
  frame.mirrored = mirrored;
  for (let i = 0; i < N_KEYPOINTS && i < landmarks.length; i++) {
    const lm = landmarks[i];
    const o = i * STRIDE;
    frame.keypoints[o] = mirrored ? 1 - lm.x : lm.x;
    frame.keypoints[o + 1] = lm.y;
    frame.keypoints[o + 2] = lm.z ?? 0;
    frame.keypoints[o + 3] = lm.visibility ?? 1;
  }
  return frame;
}

export function getKeypoint(frame, i) {
  const o = i * STRIDE;
  return {
    x: frame.keypoints[o],
    y: frame.keypoints[o + 1],
    z: frame.keypoints[o + 2],
    v: frame.keypoints[o + 3],
  };
}

/**
 * Serialize a PoseFrame to a compact ArrayBuffer for future network
 * transmission: [float64 t][uint8 mirrored][float32 * N*4 keypoints].
 */
export function serializePoseFrame(frame) {
  const buf = new ArrayBuffer(8 + 1 + frame.keypoints.byteLength);
  const view = new DataView(buf);
  view.setFloat64(0, frame.t, true);
  view.setUint8(8, frame.mirrored ? 1 : 0);
  // Keypoints start at byte 9 (unaligned), so copy via DataView.
  const kp = frame.keypoints;
  for (let i = 0; i < kp.length; i++) view.setFloat32(9 + i * 4, kp[i], true);
  return buf;
}

export function deserializePoseFrame(buf) {
  const view = new DataView(buf);
  const frame = emptyPoseFrame();
  frame.t = view.getFloat64(0, true);
  frame.mirrored = view.getUint8(8) === 1;
  for (let i = 0; i < frame.keypoints.length; i++) {
    frame.keypoints[i] = view.getFloat32(9 + i * 4, true);
  }
  return frame;
}
