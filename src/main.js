import { Camera } from './camera.js';
import { PoseDetector } from './pose/poseDetector.js';
import { PoseSmoother } from './pose/smoothing.js';
import { RoomModel } from './room/roomModel.js';
import { StickFigureAvatar } from './avatar/stickFigure.js';
import {
  PoseChannel,
  LoopbackTransport,
  WebSocketTransport,
} from './net/poseChannel.js';
import { randomRoomName } from './net/roomNames.js';
import { resolveServerUrl } from './net/serverUrl.js';
import { KP, STRIDE } from './pose/poseFormat.js';
import { Metronome } from './audio/metronome.js';
import { SessionShare, VIDEO_LEVELS, MUSIC_LEVELS } from './share/sessionShare.js';
import { joinable, phase, whenText, FINE_PRINT } from './net/schedule.js';

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
// Two kinds share one path:
//   people  — real dancers: room-mates, or anyone online the server brings
//             into your space
//   ai      — AI dancers the server builds from the dance library (a real
//             person's recorded dance on your beat, with borrowed moves)
// The dancer only picks HOW MANY guests (one slider on the dance screen);
// planGuests() decides who. Seats open one per spacingSec; real people
// take an open seat first, AI dancers fill the rest. Room-mates are always
// shown and count against the seats.
const GUEST_FADE_MS = { peer: 2_000, ai: 4_000 };
const PEER_STALE_MS = 6_000;
const MAX_GUESTS = 3;
const guestCfg = { count: 1, spacingSec: 15, opacity: 0.9, variation: 0.5, styleLabels: false };
const guestPlan = { open: 0, ai: 0, nextAt: 0 }; // what planGuests() last decided
let danceStartedAt = 0; // performance.now() when the dance screen opened

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
    lastWants = '';
    planGuests();
  };
}

const channel = new PoseChannel(
  serverLink ?? new LoopbackTransport(),
);
channel.subscribe(onRemoteFrame);

// ---- Dance room + guest state ----
// The one thing assessed per room today: tempo. Each member's BPM, and the
// room's consensus BPM, arrive in the server's 'room' opinions.
const roomState = { name: null, bpm: 0, members: [] };
let lobby = []; // open rooms from the server: [{ name, dancers, bpm }]
let bookings = []; // DJ sets booked ahead (see net/schedule.js), soonest first
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
    el.textContent = '○ dance server unreachable — no rooms or guests for now';
    el.classList.add('offline');
  }
  if (state !== 'open') lobby = [];
  renderJoinPicker();
  renderUpcoming();
  renderRoomButton();
  planGuests();
}

/**
 * Start screen: "Join a room" is a native <select> of the open rooms, so
 * each phone shows its own picker (a spinning wheel on iOS). Rebuilt only
 * when the rooms or their head counts change, so an open picker isn't
 * yanked around by the server's regular lobby updates.
 */
let joinKey = null;
function renderJoinPicker() {
  const sel = $('sel-join');
  // DJ sets that are open (10 min before) or live join the list even
  // before anyone is in them.
  const now = Date.now();
  const sets = bookings.filter((b) => joinable(b, now) && !lobby.some((r) => r.name === b.room));
  const key = JSON.stringify([lobby.map((r) => [r.name, r.dancers]), sets.map((b) => b.id)]);
  if (key === joinKey) return;
  joinKey = key;
  const placeholder = new Option('Join a room', '', true, true);
  placeholder.disabled = true;
  placeholder.hidden = true;
  const opts = [placeholder];
  if (!lobby.length && !sets.length) {
    const none = new Option('None', '');
    none.disabled = true;
    opts.push(none);
  }
  for (const r of lobby) {
    const dj = bookings.find((b) => b.room === r.name && joinable(b, now));
    opts.push(new Option(`${r.name} · ${r.dancers} dancing${dj ? ' · DJ set' : ''}`, r.name));
  }
  for (const b of sets) opts.push(new Option(`${b.room} · DJ set`, b.room));
  sel.replaceChildren(...opts);
  sel.classList.toggle('empty', !lobby.length && !sets.length);
}

/**
 * Start screen, below the buttons: DJ sets booked at /schedule. Tap one for
 * the DJ bio and set info; from 10 min before the start it has a Join
 * button. Rebuilt when the schedule changes and once a minute (phases move
 * on with the clock), keeping whichever sets were open.
 */
let upcomingKey = null;
function renderUpcoming() {
  const list = $('upcoming-list');
  const now = Date.now();
  const key = JSON.stringify([bookings, bookings.map((b) => phase(b, now)), serverOnline]);
  if (key === upcomingKey) return;
  upcomingKey = key;
  const open = new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.id));
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const items = bookings.map((b) => {
    const p = phase(b, now);
    const li = el('li');
    const d = el('details', `set ${p}`);
    d.dataset.id = b.id;
    d.open = open.has(b.id);
    const sum = el('summary');
    const head = el('div', 'set-head');
    const dj = el('div', 'set-dj', b.dj);
    if (p === 'live') dj.append(el('span', 'set-badge', 'LIVE'));
    const when = el('div', 'set-when', `${whenText(b)} · `);
    when.append(el('span', 'set-room', `⌂ ${b.room}`));
    head.append(dj, when);
    sum.append(head);
    if (joinable(b, now)) {
      const btn = el('button', 'primary', 'Join');
      btn.disabled = !serverOnline;
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); enter(b.room); });
      sum.append(btn);
    }
    const body = el('div', 'set-body');
    if (b.setInfo) body.append(el('h3', '', 'The set'), el('p', '', b.setInfo));
    if (b.bio) body.append(el('h3', '', `About ${b.dj}`), el('p', '', b.bio));
    if (b.link) {
      const a = el('a', '', b.link.replace(/^https?:\/\//, ''));
      a.href = b.link;
      a.target = '_blank';
      a.rel = 'noopener nofollow';
      body.append(el('h3', '', 'Link'), a);
    }
    if (!body.childElementCount) body.append(el('p', '', 'No details yet.'));
    d.append(sum, body);
    li.append(d);
    return li;
  });
  if (!items.length) items.push(el('li', 'none', serverOnline ? 'No DJ sets booked yet.' : 'Schedule unavailable while the dance server is offline.'));
  list.replaceChildren(...items);
}

/** Dance screen, top left: "Share your room", or the room's name once you're in one. */
function renderRoomButton() {
  const btn = $('btn-room');
  const name = roomState.name ?? pendingRoom;
  btn.textContent = name ? `⌂ ${name}` : 'Share your room';
  btn.classList.toggle('shared', !!name);
  btn.disabled = !name && !(serverLink && serverOnline);
}

function onServerMessage(msg) {
  if (msg.type === 'profile') {
    myBpm = msg.bpm > 0 && msg.confidence > 0.25 ? msg.bpm : 0;
    musicBpm = msg.musicBpm > 0 && msg.musicConfidence > 0.25 ? msg.musicBpm : 0;
    renderBpm();
  } else if (msg.type === 'rooms') {
    lobby = msg.rooms;
    renderJoinPicker();
  } else if (msg.type === 'schedule') {
    bookings = msg.bookings;
    renderJoinPicker();
    renderUpcoming();
  } else if (msg.type === 'joined') {
    roomState.name = msg.room;
    renderRoomLine();
    renderRoomButton();
  } else if (msg.type === 'room') {
    if (msg.name !== roomState.name) return;
    roomState.bpm = msg.bpm;
    roomState.members = msg.members;
    for (const m of msg.members) if (!m.you) peerBpm.set(m.id, m);
    pruneReal();
    renderRoomLine();
    planGuests(); // room-mates take guest seats
  } else if (msg.type === 'guests') {
    peopleGuests.clear();
    for (const p of msg.people) { peopleGuests.add(p.id); peerBpm.set(p.id, p); }
    aiInfo.clear();
    for (const a of msg.ai) aiInfo.set(a.id, a);
    libraryClips = msg.library?.clips ?? null;
    for (const [id, g] of guests) if (g.kind === 'ai' && !aiInfo.has(id)) guests.delete(id);
    pruneReal();
    renderGuestLine();
    planGuests();
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
  hud.textContent = `${who}${tempo}`; // the name is on the room button
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

// Real people get their own palette so they never look like AI dancers.
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
    const ai = /^ai-(\d+)-/.exec(dancerId);
    const kind = ai ? 'ai' : 'peer';
    if (kind === 'ai' && !aiInfo.has(dancerId) && parseInt(ai[1], 10) > guestPlan.ai) return; // no longer wanted
    const slot = ai ? parseInt(ai[1], 10) : ++peersSeen;
    const palette = kind === 'ai' ? AI_COLORS : PEER_COLORS;
    g = {
      // Guests are drawn without any glow: plain and cheap (bench.html),
      // so you stay the one that shines.
      avatar: new StickFigureAvatar({ ...palette[(slot - 1) % palette.length], glowStyle: 'none' }),
      pose: null,
      bornAt: performance.now(),
      lastSeen: 0,
      kind,
      slot,
      // A spot behind the dancer: shifted to one side, slightly up + smaller.
      // Real people and AI dancers alternate sides so a full floor spreads out.
      dx: (0.12 + Math.random() * 0.15) * (slot % 2 ? -1 : 1),
      dy: -0.05,
      scale: 0.85,
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
let pendingRoom = null;    // room asked for (joined from the start screen, or shared) until the server confirms
let lastPose = null;
let rafId = null;
let fpsEma = 0;
let lastFrameT = 0;

// ?perf=1: HUD shows where each frame's time goes (pose detection, drawing
// the guests, whole loop) so guest cost can be read off a real phone.
const perfHud = urlParams.has('perf');
const perf = { detect: 0, guests: 0, loop: 0, lastLoopAt: 0 };
const ema = (prev, v) => (prev ? prev * 0.9 + v * 0.1 : v);

// ?perf=1 also shows where the loading time went (issue #1); ?cpu=1 runs
// pose detection on the CPU instead of the GPU, to compare.
let cameraMs = 0;
detector.onTimings = (t) => {
  const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const lines = [`camera      ${s(cameraMs)}`];
  if (t.wasm) lines.push(`engine      ${s(t.wasm.ms)} (${t.wasm.mb.toFixed(1)} MB)`);
  if (t.model) lines.push(`model       ${s(t.model.ms)} (${t.model.mb.toFixed(1)} MB)`);
  if (t.download !== undefined) lines.push(`download    ${s(t.download)} total`);
  lines.push(`start ${t.delegate}   ${s(t.start)}`);
  lines.push(`1st frame   ${s(t.firstDetect)}`);
  lines.push(`gpu: ${gpuName()}`);
  const text = lines.join('\n');
  console.log(`[load]\n${text}`);
  if (!perfHud) return;
  $('perf-load').textContent = text;
  $('perf-load').classList.remove('hidden');
};

/** The graphics chip's name, when the browser tells (iOS often says just "Apple GPU"). */
function gpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER)) ?? 'no WebGL';
  } catch {
    return 'unknown';
  }
}

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
  const loopStart = performance.now();
  if (perf.lastLoopAt) perf.loop = ema(perf.loop, loopStart - perf.lastLoopAt);
  perf.lastLoopAt = loopStart;

  // Background: the room photo sits on its own canvas under the stage (drawn
  // once at capture), so the stage only holds the dancers. Ghost off draws
  // the live feed over it for debugging.
  if (ghostMode && room.isCaptured) {
    ctx.clearRect(0, 0, W, H);
  } else {
    drawVideo();
  }

  // Pose detection on the live feed (independent of what's displayed).
  const raw = detector.detect(video, camera.mirrored);
  const detected = performance.now();
  if (raw) {
    perf.detect = ema(perf.detect, detected - loopStart);
    lastPose = smoother.apply(raw);
    channel.publish(lastPose); // → dance server (relay, analysis, library)
    updateFps(raw.t);
  }

  // Guests render first so they stay behind the main dancer, and are
  // capped at guestCfg.opacity (default 90%) so they never crowd it out.
  const now = performance.now();
  if (now >= guestPlan.nextAt) planGuests();
  for (const [id, g] of guests) {
    if (!g.pose) continue;
    if (now - g.lastSeen > PEER_STALE_MS) { guests.delete(id); continue; }
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
      if (guestCfg.styleLabels && a?.tag) drawLabel(g.pose, a.tag, g.avatar.color, g.avatar.alpha, W, H);
    }
  }
  perf.guests = ema(perf.guests, performance.now() - now);

  if (lastPose) {
    avatar.render(ctx, lastPose, { width: W, height: H });
    if (roomState.name && myBpm) drawLabel(lastPose, `${Math.round(myBpm)}`, avatar.color, 1, W, H);
    $('hud-status').textContent = '';
  } else {
    $('hud-status').textContent = 'step into frame…';
  }

  // HUD (bpm/room/match come from server opinions via onServerMessage)
  $('hud-fps').textContent = perfHud
    ? `${fpsEma.toFixed(0)} fps · pose ${perf.detect.toFixed(1)} · guests ${perf.guests.toFixed(1)} · loop ${perf.loop.toFixed(0)} ms`
    : `${fpsEma.toFixed(0)} fps`;
}

/**
 * Tag floating above a dancer's head (tempo, or an AI dancer's style), in
 * that dancer's color. Bare-bones on purpose: plain text, no shadow or emoji.
 */
function drawLabel(pose, text, color, alpha, W, H) {
  const kp = pose.keypoints;
  const nose = { x: kp[KP.NOSE * STRIDE], y: kp[KP.NOSE * STRIDE + 1], v: kp[KP.NOSE * STRIDE + 3] };
  if (nose.v < 0.4) return;
  const size = Math.max(14, H * 0.03);
  ctx.globalAlpha = alpha;
  ctx.font = `${size}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = color;
  ctx.fillText(text, nose.x * W, nose.y * H - size * 1.2);
  ctx.globalAlpha = 1;
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
  const t0 = performance.now();
  try {
    await camera.start();
  } catch (err) {
    setLoading(null);
    alert(`Camera access failed: ${err.message}\n\nCheck browser permissions and reload.`);
    return false;
  }
  cameraMs = performance.now() - t0;
  setLoading('Loading pose model…');
  try {
    // Loaded once per page: coming back from the start screen reuses it.
    if (!detector.landmarker) {
      await detector.init({ delegate: urlParams.has('cpu') ? 'CPU' : 'GPU', timed: perfHud });
      detector.warmUp(video);
    }
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
  renderRoomButton();
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
  renderRoomButton();
}

/** Open your own space to others: a fresh room name nobody is using. */
function shareRoom() {
  if (!serverLink || !serverOnline) return;
  const taken = new Set(lobby.map((r) => r.name));
  let name = randomRoomName();
  for (let i = 0; i < 20 && taken.has(name); i++) name = randomRoomName();
  pendingRoom = name;
  serverLink.join(name);
  renderRoomButton();
}

/** The in-app confirm pop-up. Resolves true for the confirming button. */
function confirmPopup(message) {
  return new Promise((resolve) => {
    $('confirm-msg').textContent = message;
    $('confirm').classList.remove('hidden');
    const done = (answer) => {
      $('confirm').classList.add('hidden');
      $('confirm-yes').onclick = $('confirm-no').onclick = null;
      resolve(answer);
    };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
  });
}

function exitToStart() {
  $('menu-panel').classList.add('hidden');
  metronome?.stop();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  share.stop();
  camera.stop();
  room.clear();
  showPlate(false);
  resetGuests();
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
  planGuests(); // mode is 'start' → the server clears our guests
  peopleGuests.clear();
  aiInfo.clear();
  renderGuestLine();
  $('sel-join').value = '';
}

async function captureRoom() {
  // Countdown gives the user time to step out of frame.
  const cd = $('countdown');
  cd.classList.remove('hidden');
  for (let n = 3; n > 0; n--) {
    cd.textContent = n;
    await new Promise((r) => setTimeout(r, 1000));
  }
  cd.textContent = '📷';
  await room.capture(video, { mirrored: camera.mirrored });
  cd.classList.add('hidden');
  showPlate(true);

  smoother.reset();
  lastPose = null;
  fpsEma = 0;
  lastFrameT = 0;
  showScreen('dance');
  resetGuests();
  danceStartedAt = performance.now();
  planGuests();
  metronome?.start();
  share.start({ w: camera.width, h: camera.height });
}

/** The room photo layer under the stage (see loop()). */
function showPlate(on) {
  const el = $('plate');
  if (on && room.isCaptured) {
    el.width = room.plate.width;
    el.height = room.plate.height;
    el.getContext('2d').drawImage(room.plate, 0, 0);
  }
  el.classList.toggle('hidden', !on);
}

// ---- Guests: who dances in our space ----
/**
 * Decide who fills the guest seats, from the slider count and the time
 * since dancing started. Room-mates sit in seats first (always shown).
 * The other seats open one every spacingSec — seat 1 after one spacing,
 * seat 2 after two, … An open seat goes to a real person the server found,
 * otherwise to an AI dancer. No server, no guests.
 * Called on every input change and once a second from loop().
 */
function planGuests() {
  const now = performance.now();
  const dancing = mode === 'dance';
  const roomMates = roomState.members.filter((m) => !m.you).length;
  const seats = dancing && serverLink && serverOnline ? Math.max(0, guestCfg.count - roomMates) : 0;
  const spacing = guestCfg.spacingSec * 1000;
  const elapsed = now - danceStartedAt;
  const open = Math.min(seats, Math.floor(elapsed / spacing));
  const people = Math.min(peopleGuests.size, open);
  const ai = libraryClips !== 0 ? open - people : 0;
  guestPlan.open = open;
  guestPlan.ai = ai;
  guestPlan.nextAt = now + 1000;
  guestPlan.opensIn = open < seats ? (open + 1) * spacing - elapsed : 0;

  for (const [id, g] of guests) if (g.kind === 'ai' && g.slot > ai) guests.delete(id);
  sendGuestWants(open, ai);
  renderGuestSlider();
}

let lastWants = '';
/** Tell the server how many real people and AI dancers to bring in (sent only on change). */
function sendGuestWants(people = 0, ai = 0) {
  if (!serverLink) return;
  const msg = {
    type: 'guests',
    people,
    ai,
    aspect: camera.width && camera.height ? camera.width / camera.height : 9 / 16,
    variation: guestCfg.variation,
  };
  const key = JSON.stringify(msg);
  if (key === lastWants) return;
  lastWants = key;
  serverLink.sendJSON(msg);
}

function resetGuests() {
  guests.clear();
  danceStartedAt = performance.now();
}

/** Bottom-of-screen guest slider: count, plus when the next seat opens. */
function renderGuestSlider() {
  const n = guestCfg.count;
  const label = n === 0 ? 'no guests' : n === 1 ? '1 guest' : `${n} guests`;
  const s = Math.ceil((guestPlan.opensIn ?? 0) / 1000);
  const next = mode === 'dance' && s > 0 ? ` · next in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
  $('val-guests').textContent = label + next;
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
  // Sharing the actual sound: remind about whose music it is.
  $('audio-fine-print').classList.toggle('hidden', share.level.music !== 'audio');
}

// ---- Wire up UI ----
$('btn-start-room').addEventListener('click', () => enter(null));
$('sel-join').addEventListener('change', (e) => {
  if (e.target.value) enter(e.target.value);
});
$('btn-room').addEventListener('click', async () => {
  if (!roomState.name && !pendingRoom) return shareRoom();
  if (await confirmPopup('Exit room and return to main menu?')) exitToStart();
});
renderJoinPicker();
renderUpcoming();
setInterval(() => { renderUpcoming(); renderJoinPicker(); }, 30_000);
renderRoomButton();
buildChips();
for (const el of document.querySelectorAll('[data-fine-print]')) el.textContent = FINE_PRINT;
if (!serverLink) {
  $('upcoming').classList.add('hidden');
  $('sel-join').disabled = true;
  $('btn-room').classList.add('hidden');
  $('share-box').classList.add('hidden');
  $('server-status').textContent = 'No dance server configured — no rooms or guests.';
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
  showPlate(false);
  resetGuests();
  showScreen('capture');
  planGuests(); // off the dance screen → no server guests until the next capture
});
$('btn-ghost').addEventListener('click', (e) => {
  ghostMode = !ghostMode;
  e.target.textContent = `Ghost: ${ghostMode ? 'ON' : 'OFF'}`;
});
$('btn-torso').addEventListener('click', (e) => {
  avatar.torso = avatar.torso === '1d' ? '2d' : '1d';
  e.target.textContent = `Torso: ${avatar.torso.toUpperCase()}`;
});

$('perf-load').addEventListener('click', (e) => e.target.classList.add('hidden'));

// ---- Burger menu ----
$('btn-menu').addEventListener('click', () => {
  $('menu-panel').classList.toggle('hidden');
});
// A tap anywhere on the dance floor opens (or closes) the menu too. The
// controls catch their own taps; everything else falls through to the stage.
stage.addEventListener('click', () => {
  if (mode === 'dance') $('menu-panel').classList.toggle('hidden');
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
  planGuests();
});
bindSlider('sl-opacity', 'val-opacity', (v) => `${v}%`, (v) => {
  guestCfg.opacity = v / 100;
});
bindSlider('sl-variation', 'val-variation', (v) => `${v}%`, (v) => {
  guestCfg.variation = v / 100;
  planGuests();
});
$('cb-style-labels').addEventListener('change', (e) => {
  guestCfg.styleLabels = e.target.checked;
});
bindSlider('sl-guests', 'val-guests', () => '', (v) => {
  guestCfg.count = v;
  planGuests(); // also rewrites the label
});

// Keep the camera alive across tab switches (mobile browsers may pause it).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && camera.stream && video.paused) video.play();
});
