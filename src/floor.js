/**
 * Dance floor: the big screen next to the dancers (floor.html).
 *
 * Connects to the dance server as a spectator ('watch'), receives every
 * dancer's PoseFrames plus 'floor' opinions (who is online, which room,
 * tempo per dancer and per room, the song the catalog would put on), and
 * draws everyone as glowing stick figures grouped by room — the same
 * avatar the phones use. Music: a local audio file played through this
 * machine's speakers (the room speaker), picked from the top bar.
 *
 * Overlay mode — floor.html?room=NAME&overlay=1 — is for a DJ's stream:
 * one room only, transparent background, no bar, a caption with the
 * room's tempo and crowd, and no sound (OBS already has the DJ's mix).
 * Paste the link into OBS as a Browser Source. ?caption=0 hides the text.
 */
import { StickFigureAvatar } from './avatar/stickFigure.js';
import { WebSocketTransport } from './net/poseChannel.js';
import { resolveServerUrl } from './net/serverUrl.js';
import { deserializePoseFrame, KP, STRIDE } from './pose/poseFormat.js';
import { normalizeRoomName } from './net/roomNames.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ONLY_ROOM = normalizeRoomName(params.get('room') || '') || null;
const OVERLAY = params.get('overlay') === '1';
const CAPTION = params.get('caption') !== '0';
if (OVERLAY) document.body.classList.add('overlay');
const canvas = $('floor');
const ctx = canvas.getContext('2d');

const STALE_MS = 6000;   // drop a dancer this long after their last frame
const CELL_ASPECT = 3 / 4; // width / height of one dancer's cell (phone-ish)
const COLORS = [
  { color: '#8f7dff', glow: '#c9b8ff' }, // the app's own blue-violet
  { color: '#7dffb0', glow: '#c2ffdc' }, // mint
  { color: '#ff9f7d', glow: '#ffd3c2' }, // coral
  { color: '#e07dff', glow: '#f0c2ff' }, // violet
  { color: '#fff37d', glow: '#fffac2' }, // lemon
  { color: '#ff7db8', glow: '#ffc2dd' }, // pink
  { color: '#7de1ff', glow: '#c2f1ff' }, // cyan
  { color: '#ffd27d', glow: '#ffe9c2' }, // amber
];

// dancerId -> { avatar, pose, lastSeen, bpm, confidence, room }
const dancers = new Map();
let colorsUsed = 0;
let floorState = { dancers: [], rooms: [] };

// ---- server link ---------------------------------------------------------
const serverUrl = resolveServerUrl();
$('join-url').textContent = `${location.host}`;
if (ONLY_ROOM) {
  document.title = `${ONLY_ROOM} — Dance With Me`;
  $('empty').querySelector('.hint').textContent = `Dancers join the room “${ONLY_ROOM}” in the app.`;
}
if (!serverUrl) {
  $('status').textContent = 'no dance server configured';
} else {
  const link = new WebSocketTransport(serverUrl);
  link.onOpen = () => link.sendJSON({ type: 'watch' });
  link.onStatus = (state) => {
    const el = $('status');
    el.className = `status ${state}`;
    el.textContent = { open: 'dance server online', connecting: 'connecting…', closed: 'dance server unreachable' }[state];
  };
  link.onMessage = (msg) => {
    if (msg.type !== 'floor') return;
    floorState = msg;
    const known = new Set();
    for (const d of msg.dancers) {
      if (ONLY_ROOM && d.room !== ONLY_ROOM) continue;
      known.add(d.id);
      const e = entry(d.id);
      e.bpm = d.bpm;
      e.confidence = d.confidence;
      e.room = d.room;
    }
    for (const id of dancers.keys()) if (!known.has(id)) dancers.delete(id);
  };
  link.onReceive = (dancerId, buf) => {
    if (ONLY_ROOM && !dancers.has(dancerId)) return; // not in this room (the floor message says who is)
    const e = entry(dancerId);
    e.pose = deserializePoseFrame(buf);
    e.lastSeen = performance.now();
  };
}

function entry(id) {
  let e = dancers.get(id);
  if (!e) {
    e = {
      avatar: new StickFigureAvatar(COLORS[colorsUsed++ % COLORS.length]),
      pose: null, lastSeen: 0, bpm: 0, confidence: 0, room: null,
    };
    dancers.set(id, e);
  }
  return e;
}

// ---- music ---------------------------------------------------------------
const player = $('player');
$('music-select').addEventListener('change', (ev) => {
  if (ev.target.value === 'file') {
    $('music-file').click();
  } else {
    player.pause();
    player.hidden = true;
    $('now-playing').textContent = '';
  }
});
$('music-file').addEventListener('change', (ev) => {
  const file = ev.target.files?.[0];
  if (!file) { $('music-select').value = 'none'; return; }
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(file);
  player.hidden = false;
  $('now-playing').textContent = file.name.replace(/\.[^.]+$/, '');
  player.play().catch(() => { /* user presses play on the control */ });
});

// ---- layout + render -----------------------------------------------------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/** Rooms in lobby order, then a "solo" band for dancers not in any room. */
function bands(now) {
  const live = [...dancers.entries()].filter(([, e]) => e.pose && now - e.lastSeen < STALE_MS);
  const byRoom = new Map();
  for (const [id, e] of live) {
    const key = e.room ?? '';
    (byRoom.get(key) ?? byRoom.set(key, []).get(key)).push({ id, ...e });
  }
  const out = [];
  for (const r of floorState.rooms) {
    if (byRoom.has(r.name)) out.push({ ...r, members: byRoom.get(r.name) });
  }
  if (ONLY_ROOM) return out;
  if (byRoom.has('')) out.push({ name: 'dancing solo', bpm: 0, song: null, members: byRoom.get('') });
  return out;
}

function render() {
  requestAnimationFrame(render);
  const now = performance.now();
  const W = canvas.width / (window.devicePixelRatio || 1);
  const H = canvas.height / (window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, W, H);

  const rows = bands(now);
  const total = rows.reduce((n, r) => n + r.members.length, 0);
  $('empty').hidden = total > 0 || OVERLAY;
  $('count').textContent = total ? `${total} dancing` : '';
  if (OVERLAY) return renderOverlay(rows[0], W, H);
  if (!rows.length) return;

  const headerH = Math.max(22, H * 0.035);
  const bandH = H / rows.length;
  let y = 0;
  for (const row of rows) {
    // Band header: room · dancers · tempo · song
    const parts = [row.name, `${row.members.length} dancing`];
    if (row.bpm) parts.push(`${Math.round(row.bpm)} bpm`);
    if (row.song) parts.push(`♪ ${row.song.title} (${row.song.bpm})`);
    ctx.save();
    ctx.font = `600 ${headerH * 0.6}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(232,230,245,0.75)';
    ctx.textBaseline = 'middle';
    ctx.fillText(parts.join('  ·  '), 16, y + headerH / 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(0, y + bandH); ctx.lineTo(W, y + bandH); ctx.stroke();
    ctx.restore();

    // Cells: as many across as fit, each a phone-shaped viewport.
    const n = row.members.length;
    const areaY = y + headerH;
    const areaH = bandH - headerH;
    let cellW = Math.min(W / n, areaH * CELL_ASPECT);
    let cellH = cellW / CELL_ASPECT;
    const x0 = (W - cellW * n) / 2;
    row.members.forEach((m, i) => {
      const cx = x0 + i * cellW;
      const cy = areaY + (areaH - cellH) / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath(); ctx.rect(0, 0, cellW, cellH); ctx.clip();
      m.avatar.render(ctx, m.pose, { width: cellW, height: cellH }, null);
      if (m.bpm && m.confidence > 0.3) drawBpmLabel(m.pose, m.bpm, m.avatar.color, cellW, cellH);
      ctx.restore();
    });
    y += bandH;
  }
}

/**
 * Overlay: the room's dancers in a row across the whole canvas, and a
 * caption (room · crowd · tempo) bottom-left with a shadow so it reads on
 * any stream. Everything else is transparent.
 */
function renderOverlay(row, W, H) {
  const n = row?.members.length ?? 0;
  if (n) {
    const cellW = Math.min(W / n, H * CELL_ASPECT);
    const cellH = cellW / CELL_ASPECT;
    const x0 = (W - cellW * n) / 2;
    row.members.forEach((m, i) => {
      ctx.save();
      ctx.translate(x0 + i * cellW, H - cellH);
      ctx.beginPath(); ctx.rect(0, 0, cellW, cellH); ctx.clip();
      m.avatar.render(ctx, m.pose, { width: cellW, height: cellH }, null);
      ctx.restore();
    });
  }
  if (!CAPTION) return;
  const parts = [ONLY_ROOM ?? row?.name ?? '', n ? `${n} dancing` : 'waiting for dancers'];
  if (row?.bpm) parts.push(`${Math.round(row.bpm)} bpm`);
  const size = Math.max(14, Math.min(W, H) * 0.045);
  ctx.save();
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = size * 0.5;
  ctx.fillStyle = 'rgba(240,238,255,0.92)';
  ctx.fillText(parts.join('  ·  '), size * 0.8, H - size * 0.5);
  ctx.restore();
}

/** Tempo tag floating above the dancer's head, same look as on the phones. */
function drawBpmLabel(pose, bpm, color, W, H) {
  const at = (i) => ({ x: pose.keypoints[i * STRIDE] * W, y: pose.keypoints[i * STRIDE + 1] * H, v: pose.keypoints[i * STRIDE + 3] });
  const nose = at(KP.NOSE);
  if (nose.v < 0.4) return;
  // Clear the head circle: the avatar draws it with radius 0.28 × torso length.
  const ls = at(KP.LEFT_SHOULDER), rs = at(KP.RIGHT_SHOULDER), lh = at(KP.LEFT_HIP), rh = at(KP.RIGHT_HIP);
  const torsoLen = Math.hypot((ls.x + rs.x - lh.x - rh.x) / 2, (ls.y + rs.y - lh.y - rh.y) / 2);
  const r = Math.max(6, torsoLen * 0.28);
  const size = Math.max(14, H * 0.05);
  ctx.save();
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = size * 0.4;
  ctx.fillStyle = color;
  ctx.fillText(`${Math.round(bpm)}`, nose.x, nose.y - r - size * 0.3);
  ctx.restore();
}

render();
