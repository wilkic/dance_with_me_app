/**
 * DJ schedule: rooms booked in advance. A booking is a DJ's set at a time;
 * its room is the DJ name, normalized like any room name, so "DJ Funk"
 * plays in `dj-funk`. Shared by the server (validation, storage) and the
 * pages (the /schedule form, Upcoming rooms on the start screen).
 */
import { normalizeRoomName } from './roomNames.js';

export const LIMITS = { dj: 40, setInfo: 1000, bio: 1000, link: 200 };
export const LENGTHS = [30, 60, 90, 120, 180, 240]; // minutes, offered by the form
export const MAX_MINUTES = 480;
export const MAX_AHEAD_DAYS = 90;
export const OPEN_EARLY_MS = 10 * 60_000; // the room can be joined this long before the set

const MIN = 60_000;
const text = (v, max) => String(v ?? '').trim().slice(0, max).trim();

/**
 * Validate a booking request. → { booking } (without id) or { error }.
 * `now` in ms since the epoch.
 */
export function checkBooking(raw, now = Date.now()) {
  const dj = text(raw?.dj, LIMITS.dj).replace(/\s+/g, ' ');
  const room = normalizeRoomName(dj);
  if (!room) return { error: 'The DJ name needs some letters or numbers.' };
  const start = Math.round(Number(raw?.start) / MIN) * MIN;
  if (!Number.isFinite(start) || start <= 0) return { error: 'Pick a date and start time.' };
  if (start < now - 5 * MIN) return { error: 'That start time has already passed.' };
  if (start > now + MAX_AHEAD_DAYS * 24 * 60 * MIN) return { error: `Book at most ${MAX_AHEAD_DAYS} days ahead.` };
  const minutes = Math.round(Number(raw?.minutes));
  if (!(minutes >= 15 && minutes <= MAX_MINUTES)) return { error: `A set lasts 15 minutes to ${MAX_MINUTES / 60} hours.` };
  let link = text(raw?.link, LIMITS.link);
  if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
  if (link) {
    try { new URL(link); } catch { return { error: 'That link doesn’t look like a web address.' }; }
  }
  return {
    booking: {
      dj, room, start, minutes,
      setInfo: text(raw?.setInfo, LIMITS.setInfo),
      bio: text(raw?.bio, LIMITS.bio),
      link,
    },
  };
}

export const endOf = (b) => b.start + b.minutes * MIN;
/** 'upcoming' → 'open' (joinable, OPEN_EARLY_MS before the start) → 'live' → 'over'. */
export function phase(b, now = Date.now()) {
  if (now >= endOf(b)) return 'over';
  if (now >= b.start) return 'live';
  if (now >= b.start - OPEN_EARLY_MS) return 'open';
  return 'upcoming';
}
export const joinable = (b, now) => ['open', 'live'].includes(phase(b, now));
export const overlaps = (a, b) => a.start < endOf(b) && b.start < endOf(a);

/** "Sat 18 Oct, 21:00–22:30" in the viewer's own time zone. */
export function whenText(b, locale = undefined) {
  const s = new Date(b.start);
  const e = new Date(endOf(b));
  const day = s.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const t = (d) => d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${t(s)}–${t(e)}`;
}

/**
 * A page open, for the daily visit totals (server/stats.js): which page,
 * which site sent you (host name only), phone or not. Nothing about who.
 */
export function visitMsg(page) {
  let ref = '';
  try { const h = new URL(document.referrer).hostname; if (h !== location.hostname) ref = h; } catch { /* no referrer */ }
  return { type: 'visit', page, ref, phone: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) };
}

export const FINE_PRINT =
  'Please don’t share music you don’t own. wilkinscoffee is not liable for your ' +
  'public broadcasting of unlicensed copyrighted material. We’re here to dance to ' +
  'music, not steal it. To report a room, email Chris@wilkinscoffee.be.';
