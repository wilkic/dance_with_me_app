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
