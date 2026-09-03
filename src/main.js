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
import { randomRoomName, normalizeRoomName } from './net/roomNames.js';
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
// Two kinds share one path: your own moves replayed on a delay (the
// DelayedLoopbackTransport), and real people in your dance room (relayed
// by the dance server). Settings are live-adjustable from the burger menu.
const GUEST_FADE_MS = 12_000;
const PEER_FADE_MS = 2_000;
const PEER_STALE_MS = 6_000;
const guestCfg = { count: 1, spacingSec: 60, opacity: 0.9 };
const guestTransport = new DelayedLoopbackTransport({
  guests: guestCfg.count,
  spacingMs: guestCfg.spacingSec * 1000,
});

// Dance server (rooms + rhythm analysis). Where it lives:
//   ?server=wss://…   explicit URL
//   ?server=1         Vite dev proxy (wss://<host>/ws → local server)
//   ?server=0         off (fully offline, solo only)
//   otherwise         VITE_SERVER_URL at build time, or the dev proxy
//                     when running under `npm run dev`.
const urlParams = new URLSearchParams(location.search);
const serverParam = urlParams.get('server');
let serverUrl = null;
if (serverParam === '0') serverUrl = null;
else if (serverParam === '1') serverUrl = `wss://${location.host}/ws`;
else if (serverParam) serverUrl = serverParam;
else if (import.meta.env.VITE_SERVER_URL) serverUrl = import.meta.env.VITE_SERVER_URL;
else if (import.meta.env.DEV) serverUrl = `wss://${location.host}/ws`;
const serverLink = serverUrl ? new WebSocketTransport(serverUrl) : null;
if (serverLink) {
  serverLink.onMessage = onServerMessage;
  serverLink.onStatus = onServerStatus;
}

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

// ---- Dance room state ----
// The one thing assessed per room today: tempo. Each member's BPM, and the
// room's consensus BPM, arrive in the server's 'room' opinions.
const roomState = { name: null, bpm: 0, members: [] };
const peerBpm = new Map(); // dancerId -> { bpm, confidence }
let myBpm = 0;

function onServerStatus(state) {
  const el = $('server-status');
  el.classList.remove('online', 'offline');
  if (state === 'open') {
    el.textContent = '● dance server online';
    el.classList.add('online');
  } else if (state === 'connecting') {
    el.textContent = 'connecting to dance server…';
  } else {
    el.textContent = '○ dance server unreachable — rooms unavailable, solo works';
    el.classList.add('offline');
  }
  $('btn-join').disabled = state !== 'open';
}

function onServerMessage(msg) {
  if (msg.type === 'profile') {
    myBpm = msg.bpm > 0 && msg.confidence > 0.25 ? msg.bpm : 0;
    $('hud-bpm').textContent = myBpm ? `${myBpm.toFixed(0)} bpm` : '-- bpm';
  } else if (msg.type === 'joined') {
    roomState.name = msg.room;
    renderRoomLine();
  } else if (msg.type === 'room') {
    if (msg.name !== roomState.name) return;
    roomState.bpm = msg.bpm;
    roomState.members = msg.members;
    peerBpm.clear();
    const present = new Set();
    for (const m of msg.members) {
      present.add(m.id);
      if (!m.you) peerBpm.set(m.id, m);
    }
    // Room-mates who left stop rendering right away.
    for (const [id, g] of guests) if (g.kind === 'peer' && !present.has(id)) guests.delete(id);
    renderRoomLine();
  } else if (msg.type === 'match') {
    $('hud-match').textContent =
      `♪ ${msg.song.title} (${Math.round(msg.song.bpm)} bpm) with ${msg.partner}`;
  } else if (msg.type === 'unmatch') {
    $('hud-match').textContent = '';
  }
}

function renderRoomLine() {
  const hud = $('hud-room');
  const cap = $('capture-room');
  if (!roomState.name) {
    hud.classList.add('hidden');
    cap.classList.add('hidden');
    return;
  }
  const n = roomState.members.length;
  const who = n <= 1 ? 'just you' : `${n} dancing`;
  const tempo = roomState.bpm > 0 ? ` · room ${Math.round(roomState.bpm)} bpm` : '';
  hud.textContent = `⌂ ${roomState.name} · ${who}${tempo}`;
  hud.classList.remove('hidden');
  cap.textContent = `Room “${roomState.name}” · ${who}`;
  cap.classList.remove('hidden');
}

const guests = new Map(); // dancerId -> { avatar, pose, bornAt, lastSeen, kind, slot, dx, dy, scale }

// Distinct tint per guest slot so multiple guests read as different dancers.
const GUEST_COLORS = [
  { color: '#ff7dc5', glow: '#ffc2e4' }, // pink
  { color: '#7dd3ff', glow: '#c2ecff' }, // cyan
  { color: '#ffd27d', glow: '#ffe9c2' }, // amber
];
// Real people get their own palette so replays and room-mates never look alike.
const PEER_COLORS = [
  { color: '#7dffb0', glow: '#c2ffdc' }, // mint
  { color: '#ff9f7d', glow: '#ffd3c2' }, // coral
  { color: '#e07dff', glow: '#f0c2ff' }, // violet
  { color: '#fff37d', glow: '#fffac2' }, // lemon
];
let peersSeen = 0;

function onRemoteFrame(dancerId, frame) {
  let g = guests.get(dancerId);
  if (!g) {
    const m = /^guest-(\d+)-/.exec(dancerId);
    const kind = m ? 'replay' : 'peer';
    const slot = kind === 'replay' ? parseInt(m[1], 10) : ++peersSeen;
    const palette = kind === 'replay' ? GUEST_COLORS : PEER_COLORS;
    g = {
      avatar: new StickFigureAvatar(palette[(slot - 1) % palette.length]),
      pose: null,
      bornAt: performance.now(),
      lastSeen: 0,
      kind,
      slot,
      // A spot behind the dancer: shifted to one side, slightly up + smaller.
      // Room-mates alternate sides so a full room spreads out.
      dx: (0.12 + Math.random() * 0.15) * (kind === 'peer' ? (slot % 2 ? -1 : 1) : (Math.random() < 0.5 ? -1 : 1)),
      dy: -0.05,
      scale: kind === 'peer' ? 0.85 : 0.8,
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
  g.lastSeen = performance.now();
}

// Local dancer avatar. Swappable: any Avatar implementation works here,
// and remote dancers (via channel.subscribe) get their own instances.
const avatar = new StickFigureAvatar();

let mode = 'start';        // start | capture | dance
let ghostMode = true;      // true: show clean plate (user removed); false: live feed
let pendingRoom = null;    // room chosen on the start screen (null = solo)
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
    channel.publish(lastPose); // → guest queues + dance server (room relay + analysis)
    updateFps(raw.t);
  }

  // Guests render first so they stay behind the main dancer, and are
  // capped at guestCfg.opacity (default 90%) so they never crowd it out.
  channel.transport.tick?.();
  const now = performance.now();
  for (const [id, g] of guests) {
    if (!g.pose) continue;
    if (g.kind === 'peer' && now - g.lastSeen > PEER_STALE_MS) { guests.delete(id); continue; }
    const fadeMs = g.kind === 'peer' ? PEER_FADE_MS : GUEST_FADE_MS;
    const fade = Math.min(1, (now - g.bornAt) / fadeMs);
    g.avatar.alpha = fade * guestCfg.opacity;
    g.avatar.render(ctx, g.pose, { width: W, height: H });
    if (g.kind === 'peer') {
      const p = peerBpm.get(id);
      if (p && p.bpm > 0 && p.confidence > 0.25) {
        drawBpmLabel(g.pose, p.bpm, g.avatar.color, g.avatar.alpha, W, H);
      }
    }
  }

  if (lastPose) {
    avatar.render(ctx, lastPose, { width: W, height: H });
    if (roomState.name && myBpm) drawBpmLabel(lastPose, myBpm, avatar.color, 1, W, H);
    $('hud-status').textContent = '';
  } else {
    $('hud-status').textContent = 'step into frame…';
  }

  // HUD (bpm/room/match come from server opinions via onServerMessage)
  $('hud-fps').textContent = `${fpsEma.toFixed(0)} fps`;
}

/** Tempo tag floating above a dancer's head, in that dancer's color. */
function drawBpmLabel(pose, bpm, color, alpha, W, H) {
  const kp = pose.keypoints;
  const nose = { x: kp[KP.NOSE * STRIDE], y: kp[KP.NOSE * STRIDE + 1], v: kp[KP.NOSE * STRIDE + 3] };
  if (nose.v < 0.4) return;
  const size = Math.max(14, H * 0.03);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = size * 0.4;
  ctx.fillStyle = color;
  ctx.fillText(`${Math.round(bpm)}`, nose.x * W, nose.y * H - size * 1.2);
  ctx.restore();
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
    return false;
  }
  setLoading('Loading pose model…');
  try {
    await detector.init();
  } catch (err) {
    setLoading(null);
    alert(`Could not load the pose model (network needed on first run): ${err.message}`);
    return false;
  }
  setLoading(null);
  showScreen('capture');
  if (!rafId) loop();
  return true;
}

/** Start screen → camera, entering a dance room first if one was chosen. */
async function enter(roomName) {
  pendingRoom = roomName;
  setRoomInUrl(roomName);
  // In a room, real people are the guests: replay guests default off
  // (the slider brings them back). Solo keeps the one-replay default.
  setGuestCount(roomName ? 0 : 1);
  if (roomName && serverLink) serverLink.join(roomName);
  const ok = await startCamera();
  if (!ok) leaveRoom();
}

function leaveRoom() {
  if (roomState.name && serverLink) serverLink.leave();
  serverLink && (serverLink.room = null);
  roomState.name = null;
  roomState.bpm = 0;
  roomState.members = [];
  peerBpm.clear();
  pendingRoom = null;
  renderRoomLine();
}

function setRoomInUrl(roomName) {
  const url = new URL(location.href);
  if (roomName) url.searchParams.set('room', roomName);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
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
  leaveRoom();
  smoother.reset();
  lastPose = null;
  myBpm = 0;
  fpsEma = 0;
  lastFrameT = 0;
  $('hud-bpm').textContent = '-- bpm';
  $('hud-match').textContent = '';
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
const roomInput = $('room-name');
roomInput.value = normalizeRoomName(urlParams.get('room')) || randomRoomName();
roomInput.addEventListener('input', () => {
  const cur = roomInput.value;
  const norm = normalizeRoomName(cur);
  // Keep typing fluid: only rewrite when the normalized form differs in
  // more than a trailing dash (the user may be mid-word).
  if (norm !== cur && norm !== cur.replace(/-$/, '')) roomInput.value = norm;
});
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join').click();
});
$('btn-shuffle').addEventListener('click', () => {
  roomInput.value = randomRoomName();
});
$('btn-join').addEventListener('click', () => {
  const name = normalizeRoomName(roomInput.value) || randomRoomName();
  roomInput.value = name;
  enter(name);
});
$('btn-solo').addEventListener('click', () => enter(null));
if (!serverLink) {
  $('room-box').classList.add('hidden');
  $('server-status').textContent = 'No dance server configured — solo only.';
}

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

function setGuestCount(v) {
  guestCfg.count = v;
  guestTransport.configure({ guests: v });
  // Drop replay guests from removed slots immediately.
  for (const [id, g] of guests) if (g.kind === 'replay' && g.slot > v) guests.delete(id);
  $('sl-guests').value = v;
  $('val-guests').textContent = `${v}`;
}

bindSlider('sl-guests', 'val-guests', (v) => `${v}`, setGuestCount);
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
