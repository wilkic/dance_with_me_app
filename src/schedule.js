/**
 * /schedule — DJs book a room in advance. Talks to the dance server over
 * the same WebSocket as the app ('book' / 'cancel' in, 'schedule' /
 * 'booked' / 'cancelled' / 'error' out; see server/index.js). The cancel
 * token for each booking made here is kept in this browser.
 */
import { WebSocketTransport } from './net/poseChannel.js';
import { resolveServerUrl } from './net/serverUrl.js';
import { normalizeRoomName } from './net/roomNames.js';
import { LENGTHS, phase, whenText, FINE_PRINT } from './net/schedule.js';

const $ = (id) => document.getElementById(id);
const TOKENS_KEY = 'dwm.bookings'; // { [bookingId]: token }

let bookings = [];
let online = false;
let tokens = {};
try { tokens = JSON.parse(localStorage.getItem(TOKENS_KEY) || '{}') || {}; } catch { /* storage unavailable */ }
const saveTokens = () => {
  try { localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens)); } catch { /* ignore */ }
};

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
try { $('f-dj').value = localStorage.getItem('dwm.dj') || ''; } catch { /* ignore */ }

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
    if (online) setStatus('● dance server online', 'online');
    else if (state === 'connecting') setStatus('connecting to the dance server…');
    else setStatus('○ dance server unreachable — try again in a moment', 'offline');
    $('btn-book').disabled = !online;
  };
  link.onMessage = onMessage;
}

function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${cls}`;
}
function setMsg(text, cls = '') {
  const el = $('form-msg');
  el.textContent = text;
  el.className = `msg ${cls}`;
}

function onMessage(msg) {
  if (msg.type === 'schedule') {
    bookings = msg.bookings;
    // Bookings that ended or were cancelled elsewhere: forget their tokens.
    for (const id of Object.keys(tokens)) if (!bookings.some((b) => b.id === id)) delete tokens[id];
    saveTokens();
    render();
  } else if (msg.type === 'booked') {
    tokens[msg.booking.id] = msg.token;
    saveTokens();
    $('btn-book').disabled = !online;
    setMsg(`Booked! “${msg.booking.room}” opens ${whenText(msg.booking)}.`, 'ok');
    $('f-set').value = $('f-bio').value = $('f-link').value = '';
  } else if (msg.type === 'cancelled') {
    delete tokens[msg.id];
    saveTokens();
    render();
  } else if (msg.type === 'error' && (msg.for === 'book' || msg.for === 'cancel')) {
    $('btn-book').disabled = !online;
    setMsg(msg.error, 'err');
  }
}

$('book').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!online) return;
  const start = new Date(`${$('f-date').value}T${$('f-time').value}`).getTime(); // local time
  if (!Number.isFinite(start)) return setMsg('Pick a date and start time.', 'err');
  const dj = $('f-dj').value.trim();
  try { localStorage.setItem('dwm.dj', dj); } catch { /* ignore */ }
  $('btn-book').disabled = true;
  setMsg('Booking…');
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

// ---- Lists ----
function item(b, { cancel = false } = {}) {
  const li = document.createElement('li');
  const p = phase(b);
  li.className = `set ${p}`;
  const head = document.createElement('div');
  const dj = document.createElement('b');
  dj.textContent = b.dj;
  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = `${p === 'live' ? 'LIVE · ' : ''}${whenText(b)} · ⌂ ${b.room}`;
  head.append(dj, when);
  li.append(head);
  if (b.setInfo) {
    const info = document.createElement('p');
    info.textContent = b.setInfo;
    li.append(info);
  }
  if (cancel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'danger';
    btn.textContent = 'Cancel';
    btn.addEventListener('click', () => {
      if (!confirm(`Cancel ${b.dj}’s set (${whenText(b)})?`)) return;
      link?.sendJSON({ type: 'cancel', id: b.id, token: tokens[b.id] });
    });
    li.append(btn);
  }
  return li;
}

function render() {
  const mine = bookings.filter((b) => tokens[b.id]);
  $('mine').classList.toggle('hidden', !mine.length);
  $('mine-list').replaceChildren(...mine.map((b) => item(b, { cancel: true })));
  const all = bookings.map((b) => item(b));
  if (!all.length) {
    const none = document.createElement('li');
    none.className = 'none';
    none.textContent = 'Nothing booked yet — be the first.';
    all.push(none);
  }
  $('all-list').replaceChildren(...all);
}
setInterval(render, 60_000);
