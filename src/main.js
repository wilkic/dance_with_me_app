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
import { resolveServerUrl } from './net/serverUrl.js';
import { KP, STRIDE } from './pose/poseFormat.js';
import { Metronome } from './audio/metronome.js';
import { SessionShare, VIDEO_LEVELS, MUSIC_LEVELS } from './share/sessionShare.js';

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
// Three kinds share one path:
//   replay  — your own moves replayed on a delay (DelayedLoopbackTransport)
//   people  — real dancers: room-mates, or anyone online the server brings
//             into your space when you ask for "other people"
//   ai      — AI dancers the server builds from the dance library (a real
//             person's recorded dance on your beat, with borrowed moves)
// Settings are live-adjustable from the start screen and the burger menu.
const GUEST_FADE_MS = { replay: 12_000, peer: 2_000, ai: 4_000 };
const PEER_STALE_MS = 6_000;
const MAX_GUESTS = 3;
const guestCfg = { replay: 1, people: 0, ai: 1, spacingSec: 60, opacity: 0.9, variation: 0.5 };
const GUEST_KINDS = [
  { key: 'replay', icon: '⏱', label: 'Delayed you', hint: 'your own moves, a minute later', local: true },
  { key: 'people', icon: '👥', label: 'Other people', hint: 'real dancers online right now' },
  { key: 'ai', icon: '✨', label: 'AI dancers', hint: 'real dances from the library, on your beat' },
];
const guestTransport = new DelayedLoopbackTransport({
  guests: guestCfg.replay,
  spacingMs: guestCfg.spacingSec * 1000,
});

// Dance server (rooms, guests, rhythm analysis, the dance library) — see
// net/serverUrl.js for how the URL is chosen.
const urlParams = new URLSearchParams(location.search);
const serverUrl = resolveServerUrl(urlParams);
const serverLink = serverUrl ? new WebSocketTransport(serverUrl) : null;
let serverOnline = false;
if (serverLink) {
  serverLink.onMessage = onServerMessage;
  serverLink.onStatus = onServerStatus;
}

// Dance-lab calibration: ?click=120 plays a metronome once dancing starts
// and labels the server session with the ground-truth BPM.
const clickBpm = Number(urlParams.get('click')) || 0;
const metronome = clickBpm > 0 ? new Metronome(clickBpm) : null;

// What this phone shares for the library (see share/sessionShare.js).
const share = new SessionShare(serverLink, {
  videoTrack: () => camera.stream?.getVideoTracks()[0] ?? null,
  onStatus: (m) => { $('share-status').textContent = m; renderChips(); },
});

if (serverLink) {
  serverLink.onOpen = () => {
    // Every (re)connect: resend session state.
    if (clickBpm > 0) serverLink.sendJSON({ type: 'label', clickBpm });
    share.announce();
    sendGuestWants();
  };
}

const channel = new PoseChannel(
  serverLink ? new CompositeTransport([guestTransport, serverLink]) : guestTransport,
);
channel.subscribe(onRemoteFrame);

// ---- Dance room + guest state ----
// The one thing assessed per room today: tempo. Each member's BPM, and the
// room's consensus BPM, arrive in the server's 'room' opinions.
const roomState = { name: null, bpm: 0, members: [] };
let lobby = []; // open rooms from the server: [{ name, dancers, bpm }]
const peerBpm = new Map(); // dancerId -> { bpm, confidence } (room-mates + people guests)
const peopleGuests = new Set(); // dancer ids the server brought into my space
const aiInfo = new Map(); // ai dancer id -> { tag, title, bpm, base, moves, borrowing }
let libraryClips = null;
let myBpm = 0;
let musicBpm = 0;

function onServerStatus(state) {
  const el = $('server-status');
  el.classList.remove('online', 'offline');
  serverOnline = state === 'open';
  if (state === 'open') {
    el.textContent = '● dance server online';
    el.classList.add('online');
  } else if (state === 'connecting') {
    el.textContent = 'connecting to dance server…';
  } else {
    el.textContent = '○ dance server unreachable — rooms, other people and AI dancers unavailable; delayed you works';
    el.classList.add('offline');
  }
  $('btn-join').disabled = state !== 'open';
  if (state !== 'open') {
    lobby = [];
    renderRoomList(state === 'connecting' ? 'Looking for rooms…' : 'No dance server — rooms unavailable.');
  }
  renderPickers();
}

/** Start screen: the list of open rooms (tap to join). */
function renderRoomList(emptyText = 'No rooms open yet — start one below and tell your friends its name.') {
  const list = $('room-list');
  list.replaceChildren();
  if (!lobby.length) {
    const p = document.createElement('p');
    p.className = 'room-list-empty';
    p.textContent = emptyText;
    list.append(p);
    return;
  }
  const typed = normalizeRoomName($('room-name').value);
  for (const r of lobby) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'room-row';
    row.setAttribute('role', 'option');
    if (r.name === typed) row.classList.add('current');
    const name = document.createElement('span');
    name.className = 'room-row-name';
    name.textContent = r.name;
    const meta = document.createElement('span');
    meta.className = 'room-row-meta';
    const who = r.dancers === 1 ? '1 dancing' : `${r.dancers} dancing`;
    meta.textContent = r.bpm > 0 ? `${who} · ${Math.round(r.bpm)} bpm` : who;
    row.append(name, meta);
    row.addEventListener('click', () => {
      $('room-name').value = r.name;
      enter(r.name);
    });
    list.append(row);
  }
}

function onServerMessage(msg) {
  if (msg.type === 'profile') {
    myBpm = msg.bpm > 0 && msg.confidence > 0.25 ? msg.bpm : 0;
    musicBpm = msg.musicBpm > 0 && msg.musicConfidence > 0.25 ? msg.musicBpm : 0;
    renderBpm();
  } else if (msg.type === 'rooms') {
    lobby = msg.rooms;
    if (mode === 'start') renderRoomList();
  } else if (msg.type === 'joined') {
    roomState.name = msg.room;
    renderRoomLine();
  } else if (msg.type === 'room') {
    if (msg.name !== roomState.name) return;
    roomState.bpm = msg.bpm;
    roomState.members = msg.members;
    for (const m of msg.members) if (!m.you) peerBpm.set(m.id, m);
    pruneReal();
    renderRoomLine();
  } else if (msg.type === 'guests') {
    peopleGuests.clear();
    for (const p of msg.people) { peopleGuests.add(p.id); peerBpm.set(p.id, p); }
    aiInfo.clear();
    for (const a of msg.ai) aiInfo.set(a.id, a);
    libraryClips = msg.library?.clips ?? null;
    for (const [id, g] of guests) if (g.kind === 'ai' && !aiInfo.has(id)) guests.delete(id);
    pruneReal();
    renderGuestLine();
    renderPickers();
  } else if (msg.type === 'match') {
    $('hud-match').textContent =
      `♪ ${msg.song.title} (${Math.round(msg.song.bpm)} bpm) with ${msg.partner}`;
  } else if (msg.type === 'unmatch') {
    $('hud-match').textContent = '';
  }
}

/** Real people who are neither room-mates nor assigned guests stop rendering right away. */
function pruneReal() {
  const present = new Set(peopleGuests);
  for (const m of roomState.members) present.add(m.id);
  for (const [id, g] of guests) if (g.kind === 'peer' && !present.has(id)) guests.delete(id);
  for (const id of peerBpm.keys()) if (!present.has(id)) peerBpm.delete(id);
}

function renderBpm() {
  const you = myBpm ? `${myBpm.toFixed(0)} bpm` : '-- bpm';
  $('hud-bpm').textContent = musicBpm ? `${you} · ♫ ${musicBpm.toFixed(0)}` : you;
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

/** HUD: who the server put in your space (people count, AI dancers' styles). */
function renderGuestLine() {
  const el = $('hud-guests');
  const parts = [];
  if (peopleGuests.size) parts.push(`👥 ${peopleGuests.size}`);
  for (const a of aiInfo.values()) parts.push(`✨ ${a.tag ?? 'dancer'}${a.borrowing?.length ? ` +${a.borrowing.join('+')}` : ''}`);
  el.textContent = parts.join(' · ');
  el.classList.toggle('hidden', !parts.length);
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
// AI dancers: whites — ghosts of dancers who were here before.
const AI_COLORS = [
  { color: '#ffffff', glow: '#d8ccff' },
  { color: '#e6f4ff', glow: '#b8e8ff' },
  { color: '#fff2e0', glow: '#ffd9b0' },
];
let peersSeen = 0;

function onRemoteFrame(dancerId, frame) {
  let g = guests.get(dancerId);
  if (!g) {
    const replay = /^guest-(\d+)-/.exec(dancerId);
    const ai = /^ai-(\d+)-/.exec(dancerId);
    const kind = replay ? 'replay' : ai ? 'ai' : 'peer';
    if (kind === 'ai' && !aiInfo.has(dancerId) && parseInt(ai[1], 10) > guestCfg.ai) return; // no longer wanted
    const slot = replay ? parseInt(replay[1], 10) : ai ? parseInt(ai[1], 10) : ++peersSeen;
    const palette = kind === 'replay' ? GUEST_COLORS : kind === 'ai' ? AI_COLORS : PEER_COLORS;
    g = {
      avatar: new StickFigureAvatar(palette[(slot - 1) % palette.length]),
      pose: null,
      bornAt: performance.now(),
      lastSeen: 0,
      kind,
      slot,
      // A spot behind the dancer: shifted to one side, slightly up + smaller.
      // Real people and AI dancers alternate sides so a full floor spreads out.
      dx: (0.12 + Math.random() * 0.15) * (kind === 'replay' ? (Math.random() < 0.5 ? -1 : 1) : (slot % 2 ? -1 : 1)),
      dy: -0.05,
      scale: kind === 'replay' ? 0.8 : 0.85,
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
let guestsTouched = false; // the user set guest counts themselves (don't override on room entry)
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
    channel.publish(lastPose); // → guest queues + dance server (relay, analysis, library)
    updateFps(raw.t);
  }

  // Guests render first so they stay behind the main dancer, and are
  // capped at guestCfg.opacity (default 90%) so they never crowd it out.
  channel.transport.tick?.();
  const now = performance.now();
  for (const [id, g] of guests) {
    if (!g.pose) continue;
    if (g.kind !== 'replay' && now - g.lastSeen > PEER_STALE_MS) { guests.delete(id); continue; }
    const fade = Math.min(1, (now - g.bornAt) / GUEST_FADE_MS[g.kind]);
    g.avatar.alpha = fade * guestCfg.opacity;
    g.avatar.render(ctx, g.pose, { width: W, height: H });
    if (g.kind === 'peer') {
      const p = peerBpm.get(id);
      if (p && p.bpm > 0 && p.confidence > 0.25) {
        drawLabel(g.pose, `${Math.round(p.bpm)}`, g.avatar.color, g.avatar.alpha, W, H);
      }
    } else if (g.kind === 'ai') {
      const a = aiInfo.get(id);
      if (a?.tag) drawLabel(g.pose, `✨ ${a.tag}`, g.avatar.color, g.avatar.alpha, W, H);
    }
  }

  if (lastPose) {
    avatar.render(ctx, lastPose, { width: W, height: H });
    if (roomState.name && myBpm) drawLabel(lastPose, `${Math.round(myBpm)}`, avatar.color, 1, W, H);
    $('hud-status').textContent = '';
  } else {
    $('hud-status').textContent = 'step into frame…';
  }

  // HUD (bpm/room/match come from server opinions via onServerMessage)
  $('hud-fps').textContent = `${fpsEma.toFixed(0)} fps`;
}

/** Tag floating above a dancer's head (tempo, or an AI dancer's style), in that dancer's color. */
function drawLabel(pose, text, color, alpha, W, H) {
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
  ctx.fillText(text, nose.x * W, nose.y * H - size * 1.2);
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
  // (the picker brings them back). Solo keeps the one-replay default.
  if (!guestsTouched) setGuestKind('replay', roomName ? 0 : 1, { quiet: true });
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
  pruneReal();
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
  share.stop();
  camera.stop();
  room.clear();
  guestTransport.clear();
  guests.clear();
  leaveRoom();
  smoother.reset();
  lastPose = null;
  myBpm = 0;
  musicBpm = 0;
  fpsEma = 0;
  lastFrameT = 0;
  renderBpm();
  $('hud-match').textContent = '';
  ctx.clearRect(0, 0, stage.width, stage.height);
  showScreen('start');
  sendGuestWants(); // mode is 'start' → the server clears our guests
  peopleGuests.clear();
  aiInfo.clear();
  renderGuestLine();
  if (serverLink) renderRoomList();
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
  sendGuestWants();
  share.start({ w: camera.width, h: camera.height });
}

// ---- Guests: what we want in our space ----
/** Tell the server how many real people and AI dancers to bring in (0/0 off the dance screen). */
function sendGuestWants() {
  if (!serverLink) return;
  const dancing = mode === 'dance';
  serverLink.sendJSON({
    type: 'guests',
    people: dancing ? guestCfg.people : 0,
    ai: dancing ? guestCfg.ai : 0,
    aspect: camera.width && camera.height ? camera.width / camera.height : 9 / 16,
    variation: guestCfg.variation,
  });
}

function setGuestKind(kind, v, { quiet = false } = {}) {
  v = Math.max(0, Math.min(MAX_GUESTS, v));
  guestCfg[kind] = v;
  if (!quiet) guestsTouched = true;
  if (kind === 'replay') {
    guestTransport.configure({ guests: v });
    for (const [id, g] of guests) if (g.kind === 'replay' && g.slot > v) guests.delete(id);
  } else if (kind === 'ai') {
    for (const [id, g] of guests) if (g.kind === 'ai' && g.slot > v) guests.delete(id);
  }
  renderPickers();
  if (kind !== 'replay' && mode === 'dance') sendGuestWants();
}

/** The three-kind guest picker, rendered into every .guest-picker container. */
function buildPickers() {
  for (const box of document.querySelectorAll('.guest-picker')) {
    box.replaceChildren();
    for (const k of GUEST_KINDS) {
      const row = document.createElement('div');
      row.className = 'guest-row';
      row.dataset.kind = k.key;
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.innerHTML = `${k.icon} ${k.label}<small></small>`;
      const stepper = document.createElement('span');
      stepper.className = 'stepper';
      const minus = document.createElement('button');
      minus.type = 'button';
      minus.textContent = '−';
      minus.setAttribute('aria-label', `fewer ${k.label}`);
      const val = document.createElement('span');
      const plus = document.createElement('button');
      plus.type = 'button';
      plus.textContent = '+';
      plus.setAttribute('aria-label', `more ${k.label}`);
      minus.addEventListener('click', () => setGuestKind(k.key, guestCfg[k.key] - 1));
      plus.addEventListener('click', () => setGuestKind(k.key, guestCfg[k.key] + 1));
      stepper.append(minus, val, plus);
      row.append(kind, stepper);
      box.append(row);
    }
  }
  renderPickers();
}

function renderPickers() {
  for (const row of document.querySelectorAll('.guest-row')) {
    const k = GUEST_KINDS.find((x) => x.key === row.dataset.kind);
    const available = k.local || (serverLink && serverOnline);
    row.classList.toggle('unavailable', !available);
    const small = row.querySelector('small');
    if (!serverLink && !k.local) small.textContent = 'needs the dance server';
    else if (!available) small.textContent = 'dance server offline';
    else if (k.key === 'ai' && libraryClips === 0) small.textContent = 'library is empty — dance to fill it';
    else if (k.key === 'ai' && libraryClips) small.textContent = `${k.hint} (${libraryClips} dances)`;
    else small.textContent = k.hint;
    row.querySelector('.stepper span').textContent = `${guestCfg[k.key]}`;
    row.querySelector('.stepper button:first-child').disabled = guestCfg[k.key] <= 0;
    row.querySelector('.stepper button:last-child').disabled = guestCfg[k.key] >= MAX_GUESTS || !available;
  }
}

// ---- Sharing levels (what feeds the library) ----
const LEVEL_LABELS = {
  video: { points: 'points', video: 'video' },
  music: { motion: 'motion', beat: 'beat (mic only)', audio: 'audio' },
};
function buildChips() {
  for (const [dial, levels] of [['video', VIDEO_LEVELS], ['music', MUSIC_LEVELS]]) {
    const box = $(`chips-${dial}`);
    box.replaceChildren();
    for (const lv of levels) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.level = lv;
      b.textContent = LEVEL_LABELS[dial][lv];
      b.addEventListener('click', () => { share.configure({ [dial]: lv }); renderChips(); });
      box.append(b);
    }
  }
  renderChips();
}
function renderChips() {
  for (const dial of ['video', 'music']) {
    for (const b of $(`chips-${dial}`).querySelectorAll('.chip')) b.classList.toggle('on', b.dataset.level === share.level[dial]);
  }
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
  if (lobby.length) renderRoomList();
});
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join').click();
});
$('btn-shuffle').addEventListener('click', () => {
  roomInput.value = randomRoomName();
  if (lobby.length) renderRoomList();
});
$('btn-join').addEventListener('click', () => {
  const name = normalizeRoomName(roomInput.value) || randomRoomName();
  roomInput.value = name;
  enter(name);
});
$('btn-solo').addEventListener('click', () => enter(null));
buildPickers();
buildChips();
if (!serverLink) {
  $('room-box').classList.add('hidden');
  $('share-box').classList.add('hidden');
  $('server-status').textContent = 'No dance server configured — delayed-you guests only.';
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

bindSlider('sl-spacing', 'val-spacing', (v) => `${v}s`, (v) => {
  guestCfg.spacingSec = v;
  guestTransport.configure({ spacingMs: v * 1000 });
});
bindSlider('sl-opacity', 'val-opacity', (v) => `${v}%`, (v) => {
  guestCfg.opacity = v / 100;
});
bindSlider('sl-variation', 'val-variation', (v) => `${v}%`, (v) => {
  guestCfg.variation = v / 100;
  if (mode === 'dance') sendGuestWants();
});

// Keep the camera alive across tab switches (mobile browsers may pause it).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && camera.stream && video.paused) video.play();
});
