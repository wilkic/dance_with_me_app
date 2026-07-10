import { Camera } from './camera.js';
import { PoseDetector } from './pose/poseDetector.js';
import { PoseSmoother } from './pose/smoothing.js';
import { RoomModel } from './room/roomModel.js';
import { StickFigureAvatar } from './avatar/stickFigure.js';
import { BeatDetector } from './rhythm/beatDetector.js';
import { PoseChannel, DelayedLoopbackTransport } from './net/poseChannel.js';
import { KP, STRIDE } from './pose/poseFormat.js';

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const ctx = stage.getContext('2d');
const screens = {
  start: $('screen-start'),
  capture: $('screen-capture'),
  dance: $('screen-dance'),
};

// ---- App state ----
const camera = new Camera(video);
const detector = new PoseDetector();
const smoother = new PoseSmoother();
const room = new RoomModel();
const beat = new BeatDetector();
let channel = new PoseChannel(); // rebuilt at start if guest dancers enabled

// Guest dancers: "remote" dancers whose frames arrive via the channel.
// Today that's the user's own moves replayed on a delay; later, real peers
// and AI variants arrive through the exact same subscribe() path.
const GUEST_DELAY_MS = 60_000;
const GUEST_FADE_MS = 12_000;
const guests = new Map(); // dancerId -> { avatar, pose, bornAt, dx, dy, scale }

function onRemoteFrame(dancerId, frame) {
  let g = guests.get(dancerId);
  if (!g) {
    g = {
      avatar: new StickFigureAvatar({ color: '#ff7dc5', glow: '#ffc2e4' }),
      pose: null,
      bornAt: performance.now(),
      // A spot behind the dancer: shifted to one side, slightly up + smaller
      dx: (0.12 + Math.random() * 0.15) * (Math.random() < 0.5 ? -1 : 1),
      dy: -0.05,
      scale: 0.8,
    };
    guests.set(dancerId, g);
  }
  // Place the guest "behind": shrink about the hip midpoint, then shift.
  const kp = frame.keypoints;
  const cx = (kp[KP.LEFT_HIP * STRIDE] + kp[KP.RIGHT_HIP * STRIDE]) / 2;
  const cy = (kp[KP.LEFT_HIP * STRIDE + 1] + kp[KP.RIGHT_HIP * STRIDE + 1]) / 2;
  for (let i = 0; i < kp.length; i += STRIDE) {
    kp[i] = cx + (kp[i] - cx) * g.scale + g.dx;
    kp[i + 1] = cy + (kp[i + 1] - cy) * g.scale + g.dy;
  }
  g.pose = frame;
}

// Local dancer avatar. Swappable: any Avatar implementation works here,
// and remote dancers (via channel.subscribe) would get their own instances.
const avatar = new StickFigureAvatar();

let mode = 'start';        // start | capture | dance
let ghostMode = true;      // true: show clean plate (user removed); false: live feed
let lastPose = null;
let rafId = null;
let fpsEma = 0;
let lastFrameT = 0;

// ---- Screen management ----
function showScreen(name) {
  mode = name;
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
}

function setLoading(msg) {
  $('loading').classList.toggle('hidden', !msg);
  if (msg) $('loading-msg').textContent = msg;
}

function syncStageSize() {
  if (camera.width && (stage.width !== camera.width || stage.height !== camera.height)) {
    stage.width = camera.width;
    stage.height = camera.height;
  }
}

// ---- Render loop ----
function loop() {
  rafId = requestAnimationFrame(loop);
  if (!camera.width) return;
  syncStageSize();

  const W = stage.width;
  const H = stage.height;

  if (mode === 'capture') {
    // Live preview so the user can aim the phone.
    drawVideo();
    return;
  }

  if (mode !== 'dance') return;

  // Background: the room model (user removed) or the live feed for debugging.
  if (ghostMode && room.isCaptured) {
    ctx.drawImage(room.plate, 0, 0, W, H);
  } else {
    drawVideo();
  }

  // Pose detection on the live feed (independent of what's displayed).
  const raw = detector.detect(video, camera.mirrored);
  if (raw) {
    lastPose = smoother.apply(raw);
    beat.update(lastPose);
    channel.publish(lastPose); // networking seam: no-op in single player
    updateFps(raw.t);
  }

  // Guests render first so they appear behind the main dancer.
  channel.transport.tick?.();
  for (const g of guests.values()) {
    if (!g.pose) continue;
    g.avatar.alpha = Math.min(1, (performance.now() - g.bornAt) / GUEST_FADE_MS);
    g.avatar.render(ctx, g.pose, { width: W, height: H });
  }

  if (lastPose) {
    avatar.render(ctx, lastPose, { width: W, height: H }, beat.state);
    $('hud-status').textContent = '';
  } else {
    $('hud-status').textContent = 'step into frame…';
  }

  // HUD
  $('hud-fps').textContent = `${fpsEma.toFixed(0)} fps`;
  $('hud-bpm').textContent = beat.state.bpm > 0 && beat.state.confidence > 0.25
    ? `${beat.state.bpm.toFixed(0)} bpm`
    : '-- bpm';
}

function drawVideo() {
  const W = stage.width;
  const H = stage.height;
  if (camera.mirrored) {
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -W, 0, W, H);
    ctx.restore();
  } else {
    ctx.drawImage(video, 0, 0, W, H);
  }
}

function updateFps(t) {
  if (lastFrameT) {
    const fps = 1000 / (t - lastFrameT);
    fpsEma = fpsEma ? fpsEma * 0.9 + fps * 0.1 : fps;
  }
  lastFrameT = t;
}

// ---- Flows ----
async function startCamera() {
  setLoading('Starting camera…');
  try {
    await camera.start();
  } catch (err) {
    setLoading(null);
    alert(`Camera access failed: ${err.message}\n\nCheck browser permissions and reload.`);
    return;
  }
  setLoading('Loading pose model…');
  try {
    await detector.init();
  } catch (err) {
    setLoading(null);
    alert(`Could not load the pose model (network needed on first run): ${err.message}`);
    return;
  }
  setLoading(null);
  if ($('chk-guests').checked) {
    channel = new PoseChannel(new DelayedLoopbackTransport(GUEST_DELAY_MS));
    channel.subscribe(onRemoteFrame);
  }
  showScreen('capture');
  if (!rafId) loop();
}

async function captureRoom() {
  // Countdown gives the user time to step out of frame.
  const cd = $('countdown');
  cd.classList.remove('hidden');
  for (let n = 5; n > 0; n--) {
    cd.textContent = n;
    await new Promise((r) => setTimeout(r, 1000));
  }
  cd.textContent = '📷';
  await room.capture(video, { mirrored: camera.mirrored });
  cd.classList.add('hidden');

  smoother.reset();
  beat.reset();
  lastPose = null;
  fpsEma = 0;
  lastFrameT = 0;
  showScreen('dance');
}

// ---- Wire up UI ----
$('btn-start').addEventListener('click', startCamera);
$('btn-capture').addEventListener('click', captureRoom);
$('btn-flip').addEventListener('click', async () => {
  setLoading('Switching camera…');
  try {
    await camera.flip();
  } catch (err) {
    alert(`Could not switch camera: ${err.message}`);
  }
  setLoading(null);
});
$('btn-rescan').addEventListener('click', () => {
  room.clear();
  channel.transport.clear?.();
  guests.clear();
  showScreen('capture');
});
$('btn-ghost').addEventListener('click', (e) => {
  ghostMode = !ghostMode;
  e.target.textContent = `Ghost: ${ghostMode ? 'ON' : 'OFF'}`;
});
$('btn-torso').addEventListener('click', (e) => {
  avatar.torso = avatar.torso === '1d' ? '2d' : '1d';
  e.target.textContent = `Torso: ${avatar.torso.toUpperCase()}`;
});

// Keep the camera alive across tab switches (mobile browsers may pause it).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && camera.stream && video.paused) video.play();
});
