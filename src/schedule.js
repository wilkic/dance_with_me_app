/**
 * /schedule — DJs request a room in advance; an admin approves it before
 * it shows on the start page. Talks to the dance server over the same
 * WebSocket as the app (see server/index.js):
 *
 *   DJ:    'book' / 'cancel' / 'mine' in; 'schedule' / 'booked' / 'mine' /
 *          'cancelled' / 'error' out. The token for each request made here
 *          is kept in this browser, so the DJ can follow and cancel it.
 *   Admin: open /schedule/#admin=KEY once (the key moves to this browser
 *          and out of the address bar); 'admin' / 'approve' / 'reject' /
 *          'stop-music' / 'end-room' in, 'waiting' / 'live-rooms' out. `server/deploy/deploy.sh admin` prints the link.
 */
import { WebSocketTransport } from './net/poseChannel.js';
import { resolveServerUrl } from './net/serverUrl.js';
import { normalizeRoomName } from './net/roomNames.js';
import { LENGTHS, phase, whenText, FINE_PRINT, visitMsg } from './net/schedule.js';

const $ = (id) => document.getElementById(id);
const TOKENS_KEY = 'dwm.bookings'; // { [bookingId]: token }
const ADMIN_KEY = 'dwm.adminKey';
const STATUS = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Not approved' };

const store = {
  get(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

let bookings = []; // approved, public
let mine = [];     // this browser's requests, any status
let waiting = [];  // admin: requests to decide on
let liveRooms = []; // admin: open rooms, to act on reports
let online = false;
let tokens = store.get(TOKENS_KEY, {});

// Admin key from the address (#admin=KEY) → this browser, out of the URL.
// Also when the link is opened on an already-open /schedule (a hash change).
let adminKey = store.get(ADMIN_KEY, null);
function takeAdminKey() {
  const key = new URLSearchParams(location.hash.slice(1)).get('admin');
  if (!key) return false;
  adminKey = key;
  store.set(ADMIN_KEY, adminKey);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
takeAdminKey();
addEventListener('hashchange', () => {
  if (takeAdminKey()) link?.sendJSON({ type: 'admin', key: adminKey });
});

// ---- Form defaults: today, the next full hour, an hour long ----
for (const m of LENGTHS) $('f-minutes').append(new Option(m < 60 ? `${m} min` : `${m / 60} h`.replace('.5 h', '½ h'), m, m === 60, m === 60));
const pad = (n) => String(n).padStart(2, '0');
const next = new Date(Date.now() + 60 * 60_000);
next.setMinutes(0, 0, 0);
$('f-date').value = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
$('f-date').min = $('f-date').value;
$('f-time').value = `${pad(next.getHours())}:00`;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
$('tz-hint').textContent = `Times are in your time zone (${tz}); dancers see them in theirs.`;
for (const el of document.querySelectorAll('[data-fine-print]')) el.textContent = FINE_PRINT;
$('f-dj').value = store.get('dwm.dj', '');

const renderRoom = () => { $('room-preview').textContent = normalizeRoomName($('f-dj').value) || '—'; };
$('f-dj').addEventListener('input', renderRoom);
renderRoom();

// ---- Server link ----
const url = resolveServerUrl();
const link = url ? new WebSocketTransport(url) : null;
if (!link) {
  setStatus('No dance server configured — booking is unavailable.', 'offline');
} else {
  link.onStatus = (state) => {
    online = state === 'open';
    // Online is the normal case — only say something when it isn't.
    if (online || state === 'connecting') setStatus('');
    else setStatus('○ dance server unreachable — try again in a moment', 'offline');
    $('btn-book').disabled = !online;
  };
  // Every (re)connect: follow my requests, and sign in if this is the admin's browser.
  let visitSent = false;
  link.onOpen = () => {
    if (!visitSent) { link.sendJSON(visitMsg('schedule')); visitSent = true; } // daily totals, once per page load
    link.sendJSON({ type: 'mine', tokens });
    if (adminKey) link.sendJSON({ type: 'admin', key: adminKey });
  };
  link.onMessage = onMessage;
}

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${cls}`;
}
function setMsg(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `msg ${cls}`;
}

function onMessage(msg) {
  if (msg.type === 'schedule') {
    bookings = msg.bookings;
    render();
  } else if (msg.type === 'mine') {
    mine = msg.bookings;
    // Requests that ended or were cancelled: forget their tokens.
    for (const id of Object.keys(tokens)) if (!mine.some((b) => b.id === id)) delete tokens[id];
    store.set(TOKENS_KEY, tokens);
    render();
  } else if (msg.type === 'booked') {
    tokens[msg.booking.id] = msg.token;
    store.set(TOKENS_KEY, tokens);
    $('btn-book').disabled = !online;
    setMsg('form-msg', `Thanks! Your request for “${msg.booking.room}” (${whenText(msg.booking)}) is waiting for approval. It shows on the start page once it’s approved.`, 'ok');
    $('f-set').value = $('f-bio').value = $('f-link').value = '';
  } else if (msg.type === 'cancelled') {
    delete tokens[msg.id];
    store.set(TOKENS_KEY, tokens);
    mine = mine.filter((b) => b.id !== msg.id);
    render();
  } else if (msg.type === 'waiting') {
    waiting = msg.bookings;
    $('admin').classList.remove('hidden');
    renderWaiting();
  } else if (msg.type === 'stats') {
    renderStats(msg);
  } else if (msg.type === 'live-rooms') {
    liveRooms = msg.rooms;
    renderLiveRooms();
  } else if (msg.type === 'error') {
    if (msg.for === 'book' || msg.for === 'cancel') {
      $('btn-book').disabled = !online;
      setMsg('form-msg', msg.error, 'err');
    } else if (msg.for === 'admin') {
      adminKey = null;
      store.set(ADMIN_KEY, null);
      $('admin').classList.add('hidden');
    } else if (msg.for === 'approve') {
      setMsg('admin-msg', msg.error, 'err');
    }
  }
}

$('book').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!online) return;
  const start = new Date(`${$('f-date').value}T${$('f-time').value}`).getTime(); // local time
  if (!Number.isFinite(start)) return setMsg('form-msg', 'Pick a date and start time.', 'err');
  const dj = $('f-dj').value.trim();
  store.set('dwm.dj', dj);
  $('btn-book').disabled = true;
  setMsg('form-msg', 'Sending…');
  link.sendJSON({
    type: 'book',
    dj,
    start,
    minutes: Number($('f-minutes').value),
    setInfo: $('f-set').value,
    bio: $('f-bio').value,
    link: $('f-link').value,
  });
});

$('btn-admin-out').addEventListener('click', () => {
  adminKey = null;
  store.set(ADMIN_KEY, null);
  location.reload();
});

// ---- Lists ----
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const button = (cls, text, onClick) => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

/** One set: DJ, when, room; plus status, full details and buttons as asked. */
function item(b, { status = false, details = false, actions = [] } = {}) {
  const p = phase(b);
  const li = el('li', `set ${b.status === 'approved' ? p : ''}`);
  const head = el('div');
  head.append(el('b', '', b.dj), el('span', 'when', `${p === 'live' && b.status === 'approved' ? 'LIVE · ' : ''}${whenText(b)} · ⌂ ${b.room}`));
  li.append(head);
  if (status) li.append(el('span', `status-pill ${b.status}`, STATUS[b.status] ?? b.status));
  if (details) {
    if (b.setInfo) li.append(el('h3', '', 'The set'), el('p', '', b.setInfo));
    if (b.bio) li.append(el('h3', '', `About ${b.dj}`), el('p', '', b.bio));
    if (b.link) {
      const a = el('a', '', b.link);
      a.href = b.link;
      a.target = '_blank';
      a.rel = 'noopener nofollow';
      li.append(el('h3', '', 'Link'), a);
    }
    if (b.createdAt) li.append(el('span', 'when', `asked ${new Date(b.createdAt).toLocaleString()}`));
  } else if (b.setInfo) {
    li.append(el('p', '', b.setInfo));
  }
  if (actions.length) {
    const row = el('div', 'actions');
    row.append(...actions);
    li.append(row);
  }
  return li;
}

function render() {
  $('mine').classList.toggle('hidden', !mine.length);
  $('mine-list').replaceChildren(...mine.map((b) => item(b, {
    status: true,
    actions: [
      // Approved: the OBS overlay link for this room (see floor.js, /dj/).
      ...(b.status === 'approved' ? [button('', 'Copy OBS overlay link', (e) => {
        const url = new URL(`../floor.html?room=${encodeURIComponent(b.room)}&overlay=1`, location.href).href;
        navigator.clipboard?.writeText(url).then(() => { e.target.textContent = 'Copied ✓'; }, () => prompt('Overlay link:', url));
      })] : []),
      button('danger', b.status === 'rejected' ? 'Remove' : 'Cancel', () => {
        if (b.status !== 'rejected' && !confirm(`Cancel ${b.dj}’s set (${whenText(b)})?`)) return;
        link?.sendJSON({ type: 'cancel', id: b.id, token: tokens[b.id] });
      }),
    ],
  })));
  const all = bookings.map((b) => item(b));
  if (!all.length) all.push(el('li', 'none', 'Nothing on the schedule yet — be the first.'));
  $('all-list').replaceChildren(...all);
}

function renderWaiting() {
  setMsg('admin-msg', '');
  const items = waiting.map((b) => item(b, {
    details: true,
    actions: [
      button('ok', 'Approve', () => link?.sendJSON({ type: 'approve', id: b.id })),
      button('danger', 'Reject', () => link?.sendJSON({ type: 'reject', id: b.id })),
    ],
  }));
  if (!items.length) items.push(el('li', 'none', 'Nothing waiting.'));
  $('waiting-list').replaceChildren(...items);
}

/** Admin: visit totals — today at a glance, 14 days in a table, where people came from. */
function renderStats({ days, online }) {
  const today = days[0];
  const now = el('div', 'stats-now');
  for (const [n, label] of [[online, 'online now'], [today.app, 'app opens today'], [today.danced, 'danced today'], [today.shared + today.joined, 'in rooms today']]) {
    const span = el('span');
    span.append(el('b', '', String(n)), label);
    now.append(span);
  }
  const cols = [['app', 'Opens'], ['phone', 'Phone'], ['computer', 'PC'], ['danced', 'Danced'], ['shared', 'Shared'], ['joined', 'Joined'], ['music', 'Music'], ['schedule', 'Sched.'], ['booked', 'Booked'], ['peak', 'Peak']];
  const table = el('table', 'stats-table');
  const head = el('tr');
  head.append(el('th', '', 'Day'), ...cols.map(([, label]) => el('th', '', label)));
  table.append(head);
  const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  for (const d of days) {
    const tr = el('tr');
    tr.append(el('td', '', dayName(d.day)), ...cols.map(([k]) => el('td', d[k] ? '' : 'zero', String(d[k] ?? 0))));
    table.append(tr);
  }
  const wrap = el('div', 'stats-wrap');
  wrap.append(table);
  // Where people came from, over the 14 days.
  const refs = {};
  for (const d of days) for (const [h, n] of Object.entries(d.ref ?? {})) refs[h] = (refs[h] ?? 0) + n;
  const top = Object.entries(refs).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const refLine = el('p', 'stats-refs', top.length ? `Came from: ${top.map(([h, n]) => `${h} ${n}`).join(' · ')}` : 'Came from: nothing yet');
  $('stats').replaceChildren(now, wrap, refLine);
}
$('btn-stats').addEventListener('click', () => link?.sendJSON({ type: 'stats' }));

function renderLiveRooms() {
  const items = liveRooms.map((r) => {
    const li = el('li', 'set');
    const head = el('div');
    const what = r.silenced ? 'music stopped' : r.music ? `♫ ${r.music}` : 'no music';
    head.append(el('b', '', r.name), el('span', 'when', `${r.dancers} dancing · ${what}`));
    const actions = [];
    if (r.music) actions.push(button('danger', 'Stop music', () => link?.sendJSON({ type: 'stop-music', room: r.name })));
    actions.push(button('danger', 'End room', () => {
      if (confirm(`End “${r.name}”? Everyone in it goes back to dancing alone.`)) link?.sendJSON({ type: 'end-room', room: r.name });
    }));
    const row = el('div', 'actions');
    row.append(...actions);
    li.append(head, row);
    return li;
  });
  if (!items.length) items.push(el('li', 'none', 'No rooms open right now.'));
  $('live-list').replaceChildren(...items);
}

setInterval(render, 60_000);
