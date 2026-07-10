import { Camera } from './camera.js';
import { PoseDetector } from './pose/poseDetector.js';
import { PoseSmoother } from './pose/smoothing.js';
import { RoomModel } from './room/roomModel.js';
import { StickFigureAvatar } from './avatar/stickFigure.js';
import {
  PoseChannel,
  DelayedLoopbackTransport,
  WebSocketTransport,
  CompositeTransport,
} from './net/poseChannel.js';
import { KP, STRIDE } from './pose/poseFormat.js';
import { Metronome } from './audio/metronome.js';

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

// Guest dancers: "remote" dancers whose frames arrive via the channel.
// Today that's the user's own moves replayed on a delay; later, real peers
// and AI variants arrive through the exact same subscribe() path.
// Settings are live-adjustable from the burger menu while dancing.
const GUEST_FADE_MS = 12_000;
const guestCfg = { count: 1, spacingSec: 60, opacity: 0.9 };
const guestTransport = new DelayedLoopbackTransport({
  guests: guestCfg.count,
  spacingMs: guestCfg.spacingSec * 1000,
});

// Dance-analysis server (optional): rhythm/BPM analysis lives there now.
// ?server=1 uses the Vite dev proxy (wss://<host>/ws → local server);
// ?server=wss://… connects directly. Without it the app is fully offline
// and shows no BPM.
const urlParams = new URLSearchParams(location.search);
const serverParam = urlParams.get('server');
const serverUrl = serverParam === '1' ? `wss://${location.host}/ws` : serverParam;
const serverLink = serverUrl ? new WebSocketTransport(serverUrl) : null;
if (serverLink) serverLink.onMessage = onServerMessage;

// Dance-lab calibration: ?click=120 plays a metronome once dancing starts
// and labels the server session with the ground-truth BPM (the server
// records labeled sessions when started with RECORD_DIR — see server/).
const clickBpm = Number(urlParams.get('click')) || 0;
const metronome = clickBpm > 0 ? new Metronome(clickBpm) : null;
if (serverLink && clickBpm > 0) {
  serverLink.onOpen = () => serverLink.sendJSON({ type: 'label', clickBpm });
}

const channel = new PoseChannel(
  serverLink ? new CompositeTransport([guestTransport, serverLink]) : guestTransport,
);
channel.subscribe(onRemoteFrame);

function onServerMessage(msg) {
  if (msg.type === 'profile') {
    $('hud-bpm').textContent = msg.bpm > 0 && msg.confidence > 0.25
      ? `${msg.bpm.toFixed(0)} bpm`
      : '-- bpm';
  } else if (msg.type === 'match') {
    $('hud-match').textContent =
      `♪ ${msg.song.title} (${Math.round(msg.song.bpm)} bpm) with ${msg.partner}`;
  } else if (msg.type === 'unmatch') {
    $('hud-match').textContent = '';
  }
}
const guests = new Map(); // dancerId -> { avatar, pose, bornAt, slot, dx, dy, scale }

// Distinct tint per guest slot so multiple guests read as different dancers.
const GUEST_COLORS = [
  { color: '#ff7dc5', glow: '#ffc2e4' }, // pink
  { color: '#7dd3ff', glow: '#c2ecff' }, // cyan
  { color: '#ffd27d', glow: '#ffe9c2' }, // amber
];

function onRemoteFrame(dancerId, frame) {
  let g = guests.get(dancerId);
  if (!g) {
    const slot = parseInt(/^guest-(\d+)-/.exec(dancerId)?.[1] ?? '1', 10);
    g = {
      avatar: new StickFigureAvatar(GUEST_COLORS[(slot - 1) % GUEST_COLORS.length]),
      pose: null,
      bornAt: performance.now(),
      slot,
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
    channel.publish(lastPose); // → guest queues + dance-analysis server
    updateFps(raw.t);
  }

  // Guests render first so they stay behind the main dancer, and are
  // capped at guestCfg.opacity (default 90%) so they never crowd it out.
  channel.transport.tick?.();
  for (const g of guests.values()) {
    if (!g.pose) continue;
    const fade = Math.min(1, (performance.now() - g.bornAt) / GUEST_FADE_MS);
    g.avatar.alpha = fade * guestCfg.opacity;
    g.avatar.render(ctx, g.pose, { width: W, height: H });
  }

  if (lastPose) {
    avatar.render(ctx, lastPose, { width: W, height: H });
    $('hud-status').textContent = '';
  } else {
    $('hud-status').textContent = 'step into frame…';
  }

  // HUD (bpm/match come from server opinions via onServerMessage)
  $('hud-fps').textContent = `${fpsEma.toFixed(0)} fps`;
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
  showScreen('capture');
  if (!rafId) loop();
}

function exitToStart() {
  $('menu-panel').classList.add('hidden');
  metronome?.stop();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  camera.stop();
  room.clear();
  guestTransport.clear();
  guests.clear();
  smoother.reset();
  lastPose = null;
  fpsEma = 0;
  lastFrameT = 0;
  ctx.clearRect(0, 0, stage.width, stage.height);
  showScreen('start');
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
  lastPose = null;
  fpsEma = 0;
  lastFrameT = 0;
  showScreen('dance');
  metronome?.start();
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
  guestTransport.clear();
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

// ---- Burger menu ----
$('btn-menu').addEventListener('click', () => {
  $('menu-panel').classList.toggle('hidden');
});
$('btn-exit').addEventListener('click', exitToStart);

function bindSlider(id, valId, format, apply) {
  const el = $(id);
  const val = $(valId);
  el.addEventListener('input', () => {
    const v = Number(el.value);
    val.textContent = format(v);
    apply(v);
  });
}

bindSlider('sl-guests', 'val-guests', (v) => `${v}`, (v) => {
  guestCfg.count = v;
  guestTransport.configure({ guests: v });
  // Drop guests from removed slots immediately.
  for (const [id, g] of guests) if (g.slot > v) guests.delete(id);
});
bindSlider('sl-spacing', 'val-spacing', (v) => `${v}s`, (v) => {
  guestCfg.spacingSec = v;
  guestTransport.configure({ spacingMs: v * 1000 });
});
bindSlider('sl-opacity', 'val-opacity', (v) => `${v}%`, (v) => {
  guestCfg.opacity = v / 100;
});

// Keep the camera alive across tab switches (mobile browsers may pause it).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && camera.stream && video.paused) video.play();
});
