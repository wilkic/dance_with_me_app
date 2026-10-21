import { Camera } from './camera.js';
import { PoseDetector } from './pose/poseDetector.js';
import { PoseSmoother } from './pose/smoothing.js';
import { RoomModel } from './room/roomModel.js';
import { StickFigureAvatar } from './avatar/stickFigure.js';
import {
  PoseChannel,
  WebSocketTransport,
  CompositeTransport,
  DelayedLoopbackTransport,
} from './net/poseChannel.js';
import { randomRoomName } from './net/roomNames.js';
import { resolveServerUrl, whipUrl } from './net/serverUrl.js';
import { KP, STRIDE } from './pose/poseFormat.js';
import { Metronome } from './audio/metronome.js';
import { joinable, phase, whenText, FINE_PRINT, visitMsg } from './net/schedule.js';
import { RoomMusic, canShareScreenAudio, listSoundInputs } from './net/roomMusic.js';

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
//   peer    — room-mates (always shown, and they take seats)
//   replay  — you, replayed on a delay (DelayedLoopbackTransport): the
//             guests when there's no music
//   ai      — AI dancers the server builds from the dance library (a real
//             person's recorded dance on the music's beat, as busy as you,
//             with borrowed moves): the guests when music plays — the
//             room's, or alone, your own (♫ Play music)
// The dancer only picks HOW MANY guests (one slider on the dance screen);
// planGuests() decides who. Seats open one per spacingSec.
const GUEST_FADE_MS = { replay: 12_000, peer: 2_000, ai: 4_000 };
const PEER_STALE_MS = 6_000;
const MAX_GUESTS = 3;
const guestCfg = { count: 1, spacingSec: 15, opacity: 0.9, variation: 0.5, styleLabels: false };
const guestTransport = new DelayedLoopbackTransport();
const guestPlan = { open: 0, ai: 0, replays: 0, nextAt: 0 }; // what planGuests() last decided
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

if (serverLink) {
  let visitSent = false;
  serverLink.onOpen = () => {
    if (!visitSent) { serverLink.sendJSON(visitMsg('app')); visitSent = true; } // daily totals, once per page load
    // Every (re)connect: resend session state.
    if (clickBpm > 0) serverLink.sendJSON({ type: 'label', clickBpm });
    lastWants = '';
    planGuests();
  };
}

const channel = new PoseChannel(
  serverLink ? new CompositeTransport([guestTransport, serverLink]) : guestTransport,
);
channel.subscribe(onRemoteFrame);

// ---- Dance room + guest state ----
// The server's 'room' opinions: members (who is dancing), host, music, and
// the music's BPM (heard by the phones playing it).
const roomState = { name: null, bpm: 0, members: [], host: false, hostId: null, music: null };

// Room music (net/roomMusic.js): the room's host — whoever shared it, or
// the booked DJ — plays music; everyone else in the room hears it. This
// browser's host key lets the server recognise the host after a reconnect
// or reload; a booking token (saved by /schedule in this browser) makes
// the DJ the host of their booked room. The key is kept for good (one per
// browser, not per tab) because it's also the OBS stream key: set up once
// in OBS, it streams into whichever room this browser shares.
const hostKey = (() => {
  try {
    let k = localStorage.getItem('dwm.hostKey') || sessionStorage.getItem('dwm.hostKey');
    if (!k) k = crypto.randomUUID();
    localStorage.setItem('dwm.hostKey', k);
    return k;
  } catch { return crypto.randomUUID(); }
})();
// This tab's id: a reconnect joins again under it, and the server drops the
// old connection instead of keeping it in the room as a ghost.
const tabId = (() => {
  try {
    let t = sessionStorage.getItem('dwm.tab');
    if (!t) sessionStorage.setItem('dwm.tab', (t = crypto.randomUUID()));
    return t;
  } catch { return crypto.randomUUID(); }
})();
function joinExtra(room) {
  let tokens = {};
  try { tokens = JSON.parse(localStorage.getItem('dwm.bookings') || '{}') || {}; } catch { /* storage unavailable */ }
  const mine = bookings.find((b) => b.room === room && tokens[b.id]);
  return { hostKey, tab: tabId, ...(mine ? { bookingToken: tokens[mine.id] } : {}) };
}
const music = new RoomMusic({
  send: (msg) => serverLink?.sendJSON(msg),
  onState: () => { renderMusic(); planGuests(); }, // own music on/off: AI dancers ⇄ delayed-yous
});
if (urlParams.has('debug')) window.dwm = { music, roomState }; // console poking / browser tests
let lobby = []; // open rooms from the server: [{ name, dancers, bpm }] (bpm: its music's, 0 = none)
let bookings = []; // DJ sets booked ahead (see net/schedule.js), soonest first
const aiInfo = new Map(); // ai dancer id -> { tag, title, bpm, base, moves, borrowing }
let libraryClips = null;
let musicBpm = 0; // the music I dance to (the room's, or my own), 0 until heard

function onServerStatus(state) {
  const el = $('server-status');
  el.classList.remove('online', 'offline');
  serverOnline = state === 'open';
  // Online is the normal case — only say something when it isn't.
  if (state === 'open' || state === 'connecting') {
    el.textContent = '';
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
  const key = JSON.stringify([lobby.map((r) => [r.name, r.dancers, Math.round(r.bpm || 0)]), sets.map((b) => b.id)]);
  if (key === joinKey) return;
  joinKey = key;
  const placeholder = new Option('Join a room', '', true, true);
  placeholder.disabled = true;
  placeholder.hidden = true;
  const opts = [placeholder];
  if (!lobby.length && !sets.length) {
    const none = new Option('No rooms yet', '');
    none.disabled = true;
    opts.push(none);
  }
  for (const r of lobby) {
    const dj = bookings.find((b) => b.room === r.name && joinable(b, now));
    // The room's music tempo, when music plays there and it's been heard.
    const bpm = r.bpm > 0 ? ` · ${Math.round(r.bpm)} BPM` : '';
    opts.push(new Option(`${r.name} · ${r.dancers} dancing${bpm}${dj ? ' · DJ set' : ''}`, r.name));
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
  if (msg.type === 'tempo') {
    musicBpm = msg.bpm > 0 && msg.confidence > 0.25 ? msg.bpm : 0;
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
    roomState.host = !!msg.host;
    if (!roomState.host) music.stop();
    else music.rejoined(); // after a reconnect: announce the music again, fresh connections
    renderRoomLine();
    renderRoomButton();
    renderMusic();
  } else if (msg.type === 'room') {
    if (msg.name !== roomState.name) return;
    roomState.bpm = msg.bpm;
    roomState.members = msg.members;
    roomState.host = !!msg.members.find((m) => m.you)?.host;
    roomState.hostId = msg.host;
    roomState.music = msg.music;
    // An OBS stream (whip.js) is the server playing to the room: listeners
    // take it from 'live:<room>'; the host's own music gives way.
    const live = msg.music?.live ? `live:${msg.name}` : null;
    if (!roomState.host) music.stop();
    else if (live) music.stop(false);
    music.setHost(roomState.host ? null : (live ?? msg.host));
    if (live && roomState.host) $('music-sheet').classList.add('hidden');
    music.syncMembers(msg.members.filter((m) => !m.you).map((m) => m.id));
    renderMusic();
    pruneReal();
    renderRoomLine();
    planGuests(); // room-mates take guest seats
  } else if (msg.type === 'guests') {
    aiInfo.clear();
    for (const a of msg.ai) aiInfo.set(a.id, a);
    libraryClips = msg.library?.clips ?? null;
    for (const [id, g] of guests) if (g.kind === 'ai' && !aiInfo.has(id)) guests.delete(id);
    pruneReal();
    renderGuestLine();
    planGuests();
  } else if (msg.type === 'rtc') {
    music.onSignal(msg.from, msg.data).catch((err) => console.warn('room music:', err));
  } else if (msg.type === 'music-stopped') {
    // An admin acted on a report (see /terms/).
    music.stop();
    renderMusic();
    notice('Music in this room was stopped by the moderator.');
  } else if (msg.type === 'room-ended') {
    leaveRoom();
    notice('This room was closed by the moderator. You’re dancing on your own now.');
  } else if (msg.type === 'error' && msg.for === 'join') {
    leaveRoom();
    notice(msg.error);
  }
}

/** Real people who are no longer room-mates stop rendering right away. */
function pruneReal() {
  const present = new Set(roomState.members.map((m) => m.id));
  for (const [id, g] of guests) if (g.kind === 'peer' && !present.has(id)) guests.delete(id);
}

/** Top of the dance screen: the music's tempo once it's heard; nothing without music. */
function renderBpm() {
  const el = $('hud-bpm');
  el.textContent = musicBpm ? `♫ ${musicBpm.toFixed(0)} bpm` : '';
  el.classList.toggle('hidden', !musicBpm);
}

function renderRoomLine() {
  const hud = $('hud-room');
  const cap = $('capture-room');
  if (!roomState.name) {
    hud.classList.add('hidden');
    cap.classList.add('hidden');
    return;
  }
  // Room-mates count once their movement arrives (someone still setting
  // up, or a dropped phone, isn't dancing yet).
  const n = 1 + roomState.members.filter((m) => !m.you && m.dancing).length;
  const who = n <= 1 ? 'just you' : `${n} dancing`;
  hud.textContent = who; // the name is on the room button; the music's bpm is in hud-bpm
  hud.classList.remove('hidden');
  cap.textContent = `Room “${roomState.name}” · ${who}`;
  cap.classList.remove('hidden');
}

/** HUD: the AI dancers' styles. */
function renderGuestLine() {
  const el = $('hud-guests');
  const parts = [];
  for (const a of aiInfo.values()) parts.push(`✨ ${a.tag ?? 'dancer'}${a.borrowing?.length ? ` +${a.borrowing.join('+')}` : ''}`);
  el.textContent = parts.join(' · ');
  el.classList.toggle('hidden', !parts.length);
}

const guests = new Map(); // dancerId -> { avatar, pose, bornAt, lastSeen, kind, slot, dx, dy, scale }

// Delayed-yous: a tint per seat so several read as different dancers.
const REPLAY_COLORS = [
  { color: '#ff7dc5', glow: '#ffc2e4' }, // pink
  { color: '#7dd3ff', glow: '#c2ecff' }, // cyan
  { color: '#ffd27d', glow: '#ffe9c2' }, // amber
];
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
    const replay = /^guest-(\d+)-/.exec(dancerId);
    const ai = /^ai-(\d+)-/.exec(dancerId);
    const kind = replay ? 'replay' : ai ? 'ai' : 'peer';
    if (kind === 'ai' && !aiInfo.has(dancerId) && parseInt(ai[1], 10) > guestPlan.ai) return; // no longer wanted
    if (kind === 'replay' && parseInt(replay[1], 10) > guestPlan.replays) return;
    const slot = replay ? parseInt(replay[1], 10) : ai ? parseInt(ai[1], 10) : ++peersSeen;
    const palette = kind === 'replay' ? REPLAY_COLORS : kind === 'ai' ? AI_COLORS : PEER_COLORS;
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
  // Each file: its own fetch time (it starts on page load) and where from;
  // "waited" is how long tapping Start actually waited for the two.
  const file = (f) => `${s(f.ms)} (${f.mb.toFixed(1)} MB${f.cached ? ', saved' : ''})`;
  if (t.wasm) lines.push(`engine      ${file(t.wasm)}`);
  if (t.model) lines.push(`model       ${file(t.model)}`);
  if (t.download !== undefined) lines.push(`waited      ${s(t.download)}`);
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
    channel.publish(lastPose); // → delayed-yous + dance server (relay, library)
    updateFps(raw.t);
  }

  // Guests render first so they stay behind the main dancer, and are
  // capped at guestCfg.opacity (default 90%) so they never crowd it out.
  const now = performance.now();
  if (now >= guestPlan.nextAt) planGuests();
  guestTransport.tick(now); // delayed-yous whose time has come
  for (const [id, g] of guests) {
    if (!g.pose) continue;
    if (g.kind !== 'replay' && now - g.lastSeen > PEER_STALE_MS) { guests.delete(id); continue; }
    const fade = Math.min(1, (now - g.bornAt) / GUEST_FADE_MS[g.kind]);
    g.avatar.alpha = fade * guestCfg.opacity;
    g.avatar.render(ctx, g.pose, { width: W, height: H });
    if (g.kind === 'ai') {
      const a = aiInfo.get(id);
      if (guestCfg.styleLabels && a?.tag) drawLabel(g.pose, a.tag, g.avatar.color, g.avatar.alpha, W, H);
    }
  }
  perf.guests = ema(perf.guests, performance.now() - now);

  if (lastPose) {
    avatar.render(ctx, lastPose, { width: W, height: H });
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
      await detector.init({ delegate: urlParams.has('cpu') ? 'CPU' : 'GPU' });
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
  if (roomName && serverLink) serverLink.join(roomName, joinExtra(roomName));
  const ok = await startCamera();
  if (!ok) leaveRoom();
}

function leaveRoom() {
  if (roomState.name && serverLink) serverLink.leave();
  serverLink && (serverLink.room = null);
  music.reset();
  roomState.name = null;
  roomState.bpm = 0;
  roomState.members = [];
  roomState.host = false;
  roomState.hostId = null;
  roomState.music = null;
  pruneReal();
  pendingRoom = null;
  renderRoomLine();
  renderRoomButton();
  renderMusic();
}

/**
 * Music controls. Alone, or as a room's host: "♫ Play music" (opens the
 * source picker) or "■ Stop music · <what's playing>". Alone, the music
 * stays on this phone; only its beat (numbers) goes to the server, for
 * your AI dancers. In a room, everyone else hears it: they see what's
 * playing in the HUD, and "Tap to hear the music" if autoplay was blocked.
 */
const canPlayMusic = () => !roomState.name || roomState.host;
function renderMusic() {
  const st = music.state;
  const btn = $('btn-music');
  const live = !!roomState.music?.live;
  btn.classList.toggle('hidden', !canPlayMusic());
  btn.classList.toggle('playing', st.hosting || live);
  btn.textContent = live ? '■ Stop the OBS stream' : st.hosting ? `■ Stop music · ${st.label}` : '♫ Play music';
  // The ☰ menu has the same button (where the old "record audio" chip was).
  const menuBtn = $('menu-music');
  menuBtn.classList.toggle('hidden', !canPlayMusic());
  menuBtn.classList.toggle('playing', st.hosting || live);
  menuBtn.textContent = live ? '■ Stop the OBS stream' : st.hosting ? `■ Stop music · ${st.label}` : roomState.name ? '♫ Play music to the room' : '♫ Play music';
  $('btn-hear').classList.toggle('hidden', !st.needsTap);
  const hud = $('hud-music');
  const label = roomState.music && (!roomState.host || roomState.music.live) ? roomState.music.label : '';
  hud.textContent = label ? `♫ ${label}` : '';
  hud.classList.toggle('hidden', !label);
}

function openMusicSheet() {
  $('music-msg').textContent = '';
  $('music-title').textContent = roomState.name ? 'Play music to your room' : 'Play music';
  $('music-solo-hint').classList.toggle('hidden', !!roomState.name);
  $('src-screen').classList.toggle('hidden', !canShareScreenAudio());
  $('src-obs').classList.toggle('hidden', !canShareScreenAudio() || !roomState.name); // OBS plays to a room
  $('music-inputs').classList.add('hidden');
  $('music-obs').classList.add('hidden');
  $('music-sheet').classList.remove('hidden');
}
// "Mic or line in": on a computer with several inputs, let the host pick one
// (a DJ's virtual cable carries their mix); phones go straight to the mic.
const INPUT_KEY = 'dwm.musicInput';
async function pickMicOrInput() {
  const inputs = canShareScreenAudio() ? await listSoundInputs() : [];
  if (inputs.length < 2) return startMusic('mic');
  const sel = $('music-input');
  let saved = null;
  try { saved = localStorage.getItem(INPUT_KEY); } catch { /* storage unavailable */ }
  sel.replaceChildren(...inputs.map((d) => new Option(d.label, d.id, false, d.id === saved)));
  $('music-inputs').classList.remove('hidden');
  $('music-msg').textContent = '';
}
async function startMusic(kind, files, opts) {
  $('music-msg').textContent = kind === 'screen' ? 'Pick what to share…' : 'Starting…';
  try {
    await music.start(kind, files, opts);
    music.syncMembers(roomState.members.filter((m) => !m.you).map((m) => m.id));
    $('music-sheet').classList.add('hidden');
  } catch (err) {
    $('music-msg').textContent = err.message;
  }
  renderMusic();
}

/** Open your own space to others: a fresh room name nobody is using. */
function shareRoom() {
  if (!serverLink || !serverOnline) return;
  const taken = new Set(lobby.map((r) => r.name));
  let name = randomRoomName();
  for (let i = 0; i < 20 && taken.has(name); i++) name = randomRoomName();
  pendingRoom = name;
  serverLink.join(name, joinExtra(name));
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

/** A message with just an OK button (the confirm popup, one button). */
function notice(message) {
  $('confirm-no').classList.add('hidden');
  const yes = $('confirm-yes');
  const label = yes.textContent;
  yes.textContent = 'OK';
  confirmPopup(message).then(() => {
    $('confirm-no').classList.remove('hidden');
    yes.textContent = label;
  });
}

function exitToStart() {
  $('menu-panel').classList.add('hidden');
  metronome?.stop();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  camera.stop();
  room.clear();
  showPlate(false);
  resetGuests();
  leaveRoom();
  smoother.reset();
  lastPose = null;
  musicBpm = 0;
  fpsEma = 0;
  lastFrameT = 0;
  renderBpm();
  ctx.clearRect(0, 0, stage.width, stage.height);
  showScreen('start');
  planGuests(); // mode is 'start' → the server clears our guests
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
/** Is there music to dance to: the room's, or (alone) my own ♫ Play music? */
const hasMusic = () => (roomState.name ? !!roomState.music : music.state.hosting);

/**
 * Decide who fills the guest seats, from the slider count and the time
 * since dancing started. Room-mates sit in seats first (always shown).
 * The other seats open one every spacingSec — seat 1 after one spacing,
 * seat 2 after two, … With music they go to AI dancers on its beat;
 * without music (or no dance server) to delayed-yous: seat N replays you
 * from N spacings ago, so it appears on time by itself.
 * Called on every input change and once a second from loop().
 */
function planGuests() {
  const now = performance.now();
  const dancing = mode === 'dance';
  const roomMates = roomState.members.filter((m) => !m.you && m.dancing).length;
  const seats = dancing ? Math.max(0, guestCfg.count - roomMates) : 0;
  const spacing = guestCfg.spacingSec * 1000;
  const elapsed = now - danceStartedAt;
  const aiOk = hasMusic() && serverLink && serverOnline && libraryClips !== 0;
  const open = Math.min(seats, Math.floor(elapsed / spacing));
  const ai = aiOk ? open : 0;
  const replayDelaysMs = aiOk ? [] : Array.from({ length: seats }, (_, i) => (i + 1) * spacing);
  guestPlan.open = open;
  guestPlan.ai = ai;
  guestPlan.replays = replayDelaysMs.length;
  guestPlan.nextAt = now + 1000;
  guestPlan.opensIn = open < seats ? (open + 1) * spacing - elapsed : 0;

  guestTransport.configure({ delaysMs: replayDelaysMs });
  for (const [id, g] of guests) {
    if (g.kind === 'ai' && g.slot > ai) guests.delete(id);
    if (g.kind === 'replay' && g.slot > replayDelaysMs.length) guests.delete(id);
  }
  sendGuestWants(ai);
  renderGuestSlider();
}

let lastWants = '';
/** Tell the server how many AI dancers to bring in (sent only on change). */
function sendGuestWants(ai = 0) {
  if (!serverLink) return;
  const msg = {
    type: 'guests',
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
  guestTransport.clear();
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

// The pose engine and model download while the start screen is up (and
// come from the phone's own storage after the first visit).
PoseDetector.prefetch();

// ---- Wire up UI ----
$('btn-start-room').addEventListener('click', () => enter(null));
$('sel-join').addEventListener('change', (e) => {
  if (e.target.value) enter(e.target.value);
});
$('btn-music').addEventListener('click', () => {
  if (roomState.music?.live) serverLink?.sendJSON({ type: 'room-music', on: false }); // ends the OBS stream
  else if (music.state.hosting) music.stop();
  else openMusicSheet();
  renderMusic();
});
// Stream from OBS: show where OBS should send and this room's key (see /dj/).
$('src-obs').addEventListener('click', () => {
  const extra = joinExtra(roomState.name);
  $('obs-server').textContent = whipUrl(serverUrl) ?? '—';
  $('obs-key').textContent = extra.bookingToken ?? extra.hostKey;
  $('music-obs').classList.remove('hidden');
  $('music-msg').textContent = '';
});
for (const [btn, src] of [['obs-copy-server', 'obs-server'], ['obs-copy-key', 'obs-key']]) {
  $(btn).addEventListener('click', (e) => navigator.clipboard?.writeText($(src).textContent).then(() => { e.target.textContent = 'Copied ✓'; }, () => {}));
}
$('menu-music').addEventListener('click', () => {
  $('menu-panel').classList.add('hidden');
  $('btn-music').click();
});
$('btn-hear').addEventListener('click', () => music.tapToHear());
$('src-file').addEventListener('click', () => $('music-file').click());
$('music-file').addEventListener('change', (e) => {
  if (e.target.files.length) startMusic('file', e.target.files);
  e.target.value = '';
});
$('src-mic').addEventListener('click', () => { $('music-msg').textContent = 'Looking for sound inputs…'; pickMicOrInput(); });
$('src-input-go').addEventListener('click', () => {
  const deviceId = $('music-input').value;
  try { localStorage.setItem(INPUT_KEY, deviceId); } catch { /* storage unavailable */ }
  startMusic('mic', [], { deviceId });
});
$('src-screen').addEventListener('click', () => startMusic('screen'));
$('music-cancel').addEventListener('click', () => $('music-sheet').classList.add('hidden'));
$('btn-room').addEventListener('click', async () => {
  if (!roomState.name && !pendingRoom) return shareRoom();
  if (await confirmPopup('Exit room and return to main menu?')) exitToStart();
});
renderJoinPicker();
renderUpcoming();
setInterval(() => { renderUpcoming(); renderJoinPicker(); }, 30_000);
renderRoomButton();
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
