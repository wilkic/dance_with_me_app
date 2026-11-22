/**
 * Selector channels (issue #34): standing rooms that always have music.
 *
 * Each channel is a playlist of Creative Commons tracks around one tempo
 * (made by tools/music/publish.mjs, copied here by `deploy.sh music`):
 *   <dir>/channels.json   { channels: [{ id, name, bpm, seconds, tracks: [{ file, sec, bpm }] }] }
 *   <dir>/<file>          the Opus files, served at /music/<file>
 *   <dir>/credits.html    who made what, served at /music/credits.html
 *
 * A channel never stops and never starts: what plays is worked out from the
 * clock (the playlist loops from EPOCH), so everyone who joins hears the
 * same moment of the same track. Nothing runs while nobody listens: the
 * phones in the room fetch the audio themselves, and the server only says
 * which file and where in it. The room's tempo is the track's known BPM.
 */
import { readFileSync, statSync, createReadStream, existsSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';

const EPOCH = Date.UTC(2026, 0, 1);
const TYPES = { '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };

export class Channels {
  /** dir: where channels.json and the music are; missing → no channels. */
  constructor(dir, { log = () => {} } = {}) {
    this.dir = dir;
    this.list = [];
    try {
      const file = join(dir, 'channels.json');
      if (existsSync(file)) {
        this.list = JSON.parse(readFileSync(file, 'utf8')).channels
          .filter((c) => c.tracks?.length && c.seconds > 0)
          .map((c) => ({ ...c, ms: c.tracks.reduce((a, t) => a + t.sec * 1000, 0) }));
      }
    } catch (e) { log(`channels: can't read ${dir}/channels.json (${e.message})`); }
    this.byId = new Map(this.list.map((c) => [c.id, c]));
    if (this.list.length) log(`channels: ${this.list.map((c) => `${c.id} (${c.tracks.length})`).join(', ')}`);
  }

  has(id) { return this.byId.has(id); }

  /**
   * What channel `id` plays at time t (ms): { track, start, end, next } with
   * start/end as wall-clock ms, or null for an unknown channel.
   */
  at(id, t = Date.now()) {
    const c = this.byId.get(id);
    if (!c) return null;
    const loopStart = t - ((t - EPOCH) % c.ms + c.ms) % c.ms;
    let start = loopStart;
    for (let i = 0; ; i++) {
      const track = c.tracks[i % c.tracks.length];
      const end = start + track.sec * 1000;
      if (end > t) return { track, start, end, next: c.tracks[(i + 1) % c.tracks.length] };
      start = end;
    }
  }

  /**
   * The room's music, as the 'room' message carries it: the channel's name
   * (no song titles anywhere) and what to play, from where.
   */
  music(id, t = Date.now()) {
    const c = this.byId.get(id);
    const now = this.at(id, t);
    if (!c || !now) return null;
    return {
      label: c.name,
      channel: id,
      bpm: now.track.bpm,
      src: `/music/${now.track.file}`,
      start: now.start,
      sec: now.track.sec,
      next: `/music/${now.next.file}`,
      now: t, // the server's clock, so phones can line up with it
    };
  }

  /** For the lobby: every channel with its name and what it plays now. */
  lobby(t = Date.now()) {
    return this.list.map((c) => ({ name: c.id, title: c.name, bpm: this.at(c.id, t).track.bpm }));
  }

  /**
   * Resident DJ sets: each channel with a `daily` slot ({ at: 'HH:MM',
   * minutes, tz }) gets an approved booking every day, made here rather
   * than at /schedule. The room plays the whole day; the set is the time
   * it's on the schedule. → the next `count` sets that haven't ended,
   * shaped like a booking (src/net/schedule.js), soonest first.
   */
  residentSets(now = Date.now(), count = 2) {
    const out = [];
    for (const c of this.list) {
      const d = c.daily;
      const m = /^(\d{1,2}):(\d{2})$/.exec(d?.at ?? '');
      if (!m || !(d.minutes > 0)) continue;
      const tz = d.tz || 'UTC';
      let day = localDate(now, tz);
      day = { ...day, d: day.d - 1 }; // yesterday's set may still run past midnight
      const sets = [];
      for (let i = 0; i < count + 2 && sets.length < count; i++, day = { ...day, d: day.d + 1 }) {
        const start = zonedMs(day.y, day.mo, day.d, Number(m[1]), Number(m[2]), tz);
        if (start + d.minutes * 60_000 <= now) continue;
        const date = new Date(Date.UTC(day.y, day.mo - 1, day.d)).toISOString().slice(0, 10);
        sets.push({
          id: `${c.id}-${date}`, status: 'approved', resident: true, daily: true,
          dj: c.name, room: c.id, start, minutes: d.minutes,
          setInfo: c.setInfo ?? c.story ?? '', bio: c.bio ?? '', link: '', booth: false,
        });
      }
      out.push(...sets);
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /**
   * GET/HEAD /music/<file>: the audio (with Range, so phones can start in
   * the middle) and the credits page. True if handled.
   */
  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/music/')) return false;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Headers': 'Range' }); res.end(); return true; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, cors); res.end(); return true; }
    let rel;
    try { rel = decodeURIComponent(url.pathname.slice('/music/'.length)); } catch { rel = ''; }
    const file = normalize(join(this.dir, rel));
    const type = TYPES[extname(file).toLowerCase()];
    // Only music and the credits page, only inside the music folder.
    if (!rel || !type || rel === 'channels.json' || !file.startsWith(normalize(this.dir) + sep) || !existsSync(file)) {
      res.writeHead(404, cors); res.end(); return true;
    }
    const size = statSync(file).size;
    const head = { ...cors, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (m && (m[1] || m[2])) {
      let a = m[1] ? Number(m[1]) : size - Number(m[2]);
      let b = m[1] && m[2] ? Number(m[2]) : size - 1;
      a = Math.max(0, a); b = Math.min(size - 1, b);
      if (a > b) { res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` }); res.end(); return true; }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
      if (req.method === 'HEAD') res.end(); else createReadStream(file, { start: a, end: b }).pipe(res);
      return true;
    }
    res.writeHead(200, { ...head, 'Content-Length': size });
    if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
    return true;
  }
}

/** The calendar date at time t in time zone tz → { y, mo, d }. */
function localDate(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day };
}

/** How far tz is ahead of UTC at time t, in ms. */
function offsetMs(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** Wall-clock y-mo-d h:mi in tz → ms since the epoch (days may overflow, like Date.UTC). */
function zonedMs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz); // again, in case the offset changes in between (summer time)
}
