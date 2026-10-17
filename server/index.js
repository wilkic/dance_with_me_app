/**
 * Dance-analysis server + dance rooms + guests.
 *
 * Ingests raw PoseFrames from clients over WebSocket (binary frames in the
 * exact serialize format the app already uses), runs a per-dancer
 * BeatDetector server-side, relays frames between the members of a dance
 * room, brings guests into a dancer's space, records every session into
 * the dance library, and periodically forms opinions:
 *
 *   → { type: 'welcome', id }                     on connect
 *   → { type: 'rooms', rooms }                    lobby: open rooms to pick from
 *   → { type: 'joined', room, created }           after a join
 *   → { type: 'room', name, bpm, members }        who's in your room + tempo
 *   → { type: 'profile', bpm, confidence, musicBpm, musicConfidence }
 *   → { type: 'guests', people, ai, library }     who is dancing in your space
 *   → { type: 'match', partner, bpm, song }       tempo-compatible pairing
 *   → { type: 'schedule', bookings }              DJ sets booked ahead (see schedule.js)
 *   → { type: 'booked', booking, token }          your booking went through
 *   → { type: 'cancelled', id }                   your booking was cancelled
 *   → { type: 'error', error, for }               e.g. for: 'book' — why it was refused
 *   → { type: 'unmatch' }                         pairing dissolved
 *
 *   ← { type: 'join', room }                      enter a room (creates it)
 *   ← { type: 'leave' }                           back to solo
 *   ← { type: 'guests', people, ai, aspect, variation }   guests wanted in my space
 *   ← { type: 'level', video, music, w, h }       what this session shares (see recorder.js)
 *   ← { type: 'music', t0, hz, e }                mic onset envelope (music level beat/audio)
 *   ← { type: 'media', kind, mime, data }         MediaRecorder chunk, base64 (level audio/video)
 *   ← { type: 'label', clickBpm }                 dance-lab ground truth
 *   ← { type: 'watch' }                           become a spectator (dance floor)
 *   ← { type: 'book', dj, start, minutes, setInfo, bio, link }   book a DJ set (/schedule)
 *   ← { type: 'cancel', id, token }               cancel one of your bookings
 *
 * Guests. Two kinds can dance in someone's space. "Other people" are real
 * dancers online right now, assigned by the server (tempo-compatible
 * first) and relayed exactly like room-mates — you can be dancing in
 * someone's space while dancing alone in yours. "AI dancers" are built
 * from the dance library (library.js + aiDancer.js): a recorded person
 * retimed to your beat, with moves borrowed from a similar dancer, streamed
 * as PoseFrames under an `ai-<slot>-<id>` dancer id.
 *
 * Spectators (the big-screen dance floor, floor.html) send no frames; they
 * receive every dancer's frames as relay envelopes plus:
 *   → { type: 'floor', dancers, rooms }           everyone online + per-room tempo/song
 *
 * Text frames are JSON control messages. Binary frames are PoseFrames from
 * the client; binary frames to the client are relay envelopes
 * ([id][PoseFrame], see src/net/envelope.js) carrying other dancers' poses.
 */
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserializePoseFrame, serializePoseFrame } from '../src/pose/poseFormat.js';
import { encodeEnvelope } from '../src/net/envelope.js';
import { BeatDetector } from './beatDetector.js';
import { Matcher } from './matcher.js';
import { Rooms, roomTempo } from './rooms.js';
import { pickSong } from './songs.js';
import { Library } from './library.js';
import { AiDancer } from './aiDancer.js';
import { SessionRecorder } from './recorder.js';
import { StyleWindow } from './style.js';
import { EnvelopeTempo, tempoGap } from './tempo.js';
import { Schedule } from './schedule.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAX_GUESTS = 3;
const ACTIVE_MS = 6000;         // "dancing" = a frame arrived this recently
const AI_TICK_MS = 33;          // AI dancers stream at ~30 fps
const AI_REFRESH_MS = 120_000;  // an AI dancer moves on to a fresh base clip this often
const MAX_BOOKINGS_PER_SESSION = 10;
const LEVELS = { video: ['points', 'video'], music: ['motion', 'beat', 'audio'] };

export function startServer({
  port = 8901,
  scanIntervalMs = 2000,
  // Every session is library material: frames + tempo (+ what the dancer
  // chose to share) go to library/sessions/. RECORD_DIR=0 turns it off.
  recordDir = process.env.RECORD_DIR === '0' ? null : (process.env.RECORD_DIR || join(HERE, 'library', 'sessions')),
  // The dance library behind AI dancers: a Library, null = load the
  // default one (recordings, recordings_web, library/sessions), false = none.
  library = null,
  // DJ bookings (JSON file). SCHEDULE_FILE=0 keeps them in memory only.
  scheduleFile = process.env.SCHEDULE_FILE === '0' ? null : (process.env.SCHEDULE_FILE || join(HERE, 'data', 'schedule.json')),
  log = console.log,
} = {}) {
  const wss = new WebSocketServer({ port });
  const sessions = new Map(); // id -> session (see connection handler)
  const rooms = new Rooms();
  const matcher = new Matcher();
  const schedule = new Schedule(scheduleFile, { log });
  const lib = library === false ? null : (library ?? new Library({ log }).load());
  const now = () => performance.now();

  const send = (s, msg) => {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(msg));
  };
  const sendFrame = (s, dancerId, buf) => {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(encodeEnvelope(dancerId, new Uint8Array(buf)), { binary: true });
  };

  const profileOf = (s) => {
    const { bpm, confidence } = s.detector.state;
    return { id: s.id, bpm, confidence };
  };
  /** The beat an AI dancer or a guest match should follow: music if we hear it, else motion. */
  const targetBpm = (s) => {
    const m = s.music.state;
    if (m.bpm > 0 && m.confidence >= 0.3) return m.bpm;
    const d = s.detector.state;
    return d.bpm > 0 && d.confidence >= 0.3 ? d.bpm : 0;
  };
  const dancing = (s) => !s.watching && now() - s.lastFrameAt < ACTIVE_MS;
  const roomMates = (a, b) => !!a.room && a.room === b.room;

  // Lobby: every open room with how many are dancing and its tempo, so the
  // start screen can list rooms to join. Sent to everyone on connect, on
  // every scan, and immediately when any room's membership changes.
  const lobby = () => ({
    type: 'rooms',
    rooms: rooms.names
      .map((name) => {
        const profiles = rooms.members(name).map(profileOf);
        return { name, dancers: profiles.length, bpm: roomTempo(profiles) };
      })
      .sort((a, b) => b.dancers - a.dancers || a.name.localeCompare(b.name)),
  });
  const broadcastLobby = () => {
    const msg = lobby();
    for (const s of sessions.values()) send(s, msg);
    broadcastFloor();
  };

  // DJ schedule: everyone gets the list on connect and whenever it changes
  // (a booking, a cancellation, a set ending — checked on every scan).
  const scheduleMsg = () => ({ type: 'schedule', bookings: schedule.list() });
  const broadcastSchedule = () => {
    const msg = scheduleMsg();
    for (const s of sessions.values()) send(s, msg);
  };

  // Dance floor: what a spectator screen shows — every dancer (with room
  // and tempo) and every room with its consensus tempo and the song the
  // catalog would put on for it. Sent to watchers with every lobby update.
  const dancersOnline = () => [...sessions.values()].filter((s) => !s.watching);
  const floor = () => ({
    type: 'floor',
    dancers: dancersOnline().map((s) => ({ ...profileOf(s), room: s.room })),
    rooms: rooms.names.map((name) => {
      const profiles = rooms.members(name).map(profileOf);
      const bpm = roomTempo(profiles);
      return { name, dancers: profiles.length, bpm, song: bpm ? pickSong(bpm) : null };
    }),
  });
  const broadcastFloor = () => {
    let msg = null;
    for (const s of sessions.values()) {
      if (s.watching) send(s, (msg ??= floor()));
    }
  };

  // Room opinion: membership + everyone's tempo + the room's consensus.
  // Sent on every scan and immediately when membership changes.
  const broadcastRoom = (name) => {
    const members = rooms.members(name);
    if (!members.length) return;
    const profiles = members.map(profileOf);
    const bpm = roomTempo(profiles);
    for (const s of members) {
      send(s, {
        type: 'room',
        name,
        bpm,
        members: profiles.map((p) => ({ ...p, you: p.id === s.id })),
      });
    }
  };

  // ---- Guests: who is dancing in this session's space ----
  const guestsMsg = (s) => ({
    type: 'guests',
    people: s.people.map((p) => ({ ...profileOf(p), room: p.room })),
    ai: s.ai.map((d) => d.info),
    library: lib ? { clips: lib.size } : null,
    target: { bpm: targetBpm(s), music: s.music.state.bpm > 0 && s.music.state.confidence >= 0.3 },
  });

  /** A library clip for this dancer: their beat, their style, not one already on their floor. */
  const pickClip = (s, exclude) => {
    const desc = lib.pick({ bpm: targetBpm(s), style: s.style.vector, exclude });
    return desc ? { desc, frames: lib.frames(desc) } : null;
  };
  const inUse = (s) => new Set(s.ai.flatMap((d) => [d.info.base, d.info.moves]).filter(Boolean));

  /** Create/remove AI dancers to match what the session asked for. */
  const ensureAi = (s) => {
    if (!lib || !lib.size) { s.ai.length = 0; return; }
    while (s.ai.length > s.wants.ai) s.ai.pop();
    let tries = 0;
    while (s.ai.length < s.wants.ai && tries++ < 4) {
      const slot = s.ai.length + 1;
      const used = inUse(s);
      const base = pickClip(s, used);
      if (!base) break;
      used.add(base.desc.name);
      const moves = pickClip(s, used);
      const d = new AiDancer({
        id: `ai-${slot}-${s.id}`, slot, base, moves,
        targetBpm: targetBpm(s), aspect: s.aspect, variation: s.wants.variation, now: now(),
      });
      if (!d.base) continue; // unusable clip — try another
      s.ai.push(d);
      log(`✨ ${s.id} AI dancer ${slot}: ${base.desc.name} (${base.desc.bpm || '?'} bpm, ${base.desc.tag}) + moves of ${moves?.desc.name ?? '—'}`);
    }
  };

  /** Every so often an AI dancer moves on to another person's dance. */
  const refreshAi = (s) => {
    for (const d of s.ai) {
      if (now() - d.baseSince < AI_REFRESH_MS) continue;
      const used = inUse(s);
      const base = pickClip(s, used);
      if (base && d.setBase(base, now())) {
        used.add(base.desc.name);
        const moves = pickClip(s, used);
        if (moves) d.setMoves(moves);
        log(`✨ ${s.id} AI dancer ${d.slot} now dancing ${base.desc.name}`);
      }
    }
  };

  /**
   * Other people as guests: fill each session's wish with dancers who are
   * online and moving right now — those already there stay (stability),
   * newcomers ranked by tempo compatibility, then by how many spaces they
   * are already in (spread the load). Room-mates are never double-booked.
   */
  const assignPeople = (only = null) => {
    const pool = dancersOnline().filter(dancing);
    for (const s of only ? [only] : sessions.values()) {
      if (s.watching) continue;
      const want = Math.min(MAX_GUESTS, s.wants.people);
      const keep = s.people.filter((p) => sessions.has(p.id) && dancing(p) && !roomMates(s, p));
      const have = new Set(keep);
      const tb = targetBpm(s);
      const score = new Map();
      const cands = pool.filter((p) => p !== s && !have.has(p) && !roomMates(s, p));
      for (const p of cands) score.set(p, tempoGap(tb, targetBpm(p)) + 0.1 * p.hosts.size + 0.05 * Math.random());
      cands.sort((a, b) => score.get(a) - score.get(b));
      const next = [...keep, ...cands].slice(0, want);
      for (const p of s.people) if (!next.includes(p)) p.hosts.delete(s);
      for (const p of next) p.hosts.add(s);
      const changed = next.length !== s.people.length || next.some((p, i) => p !== s.people[i]);
      s.people = next;
      if (changed) send(s, guestsMsg(s));
    }
  };

  wss.on('connection', (ws) => {
    const id = randomUUID().slice(0, 8);
    const s = {
      id, ws, room: null, watching: false, matchKey: null,
      detector: new BeatDetector(), style: new StyleWindow(), music: new EnvelopeTempo(),
      lastFrameAt: 0, lastFrameT: 0, aspect: 9 / 16, level: { video: 'points', music: 'motion' },
      wants: { people: 0, ai: 0, variation: 0.5 },
      people: [],          // sessions dancing in my space as "other people"
      hosts: new Set(),    // sessions whose space I dance in
      ai: [],              // AiDancer[]
      rec: recordDir ? new SessionRecorder(recordDir, { id }) : null,
      booked: 0,           // bookings made on this connection (rate limit)
    };
    sessions.set(id, s);
    send(s, { type: 'welcome', id });
    send(s, lobby());
    send(s, scheduleMsg());
    log(`+ ${id} connected (${sessions.size} online)`);
    broadcastFloor();

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'label') {
          // Metronome BPM from ?click=…, kept with the frames as ground truth.
          if (msg.clickBpm > 0) s.rec?.label({ clickBpm: msg.clickBpm });
        } else if (msg.type === 'join') {
          const before = s.room;
          const res = rooms.join(s, msg.room);
          if (!res) return send(s, { type: 'error', error: 'bad room name' });
          send(s, { type: 'joined', room: res.name, created: res.created });
          log(`> ${id} ${res.created ? 'opened' : 'joined'} room ${res.name} (${rooms.members(res.name).length} dancing)`);
          s.rec?.label({ room: res.name });
          if (before && before !== res.name) broadcastRoom(before);
          broadcastRoom(res.name);
          if (res.created || before !== res.name) broadcastLobby();
        } else if (msg.type === 'leave') {
          const left = rooms.leave(s);
          if (left) { log(`< ${id} left room ${left}`); broadcastRoom(left); broadcastLobby(); }
          if (s.matchKey) { s.matchKey = null; send(s, { type: 'unmatch' }); }
        } else if (msg.type === 'watch') {
          // Spectator: leaves any room, is not a dancer, sees everyone.
          const left = rooms.leave(s);
          s.watching = true;
          log(`* ${id} is watching the dance floor`);
          if (left) { broadcastRoom(left); broadcastLobby(); } else broadcastFloor();
        } else if (msg.type === 'book') {
          if (s.booked >= MAX_BOOKINGS_PER_SESSION) return send(s, { type: 'error', for: 'book', error: 'That’s a lot of bookings — reload the page to book more.' });
          const res = schedule.book(msg);
          if (res.error) return send(s, { type: 'error', for: 'book', error: res.error });
          s.booked++;
          log(`♫ ${id} booked ${res.booking.dj} (${res.booking.room}) at ${new Date(res.booking.start).toISOString()} for ${res.booking.minutes} min`);
          send(s, { type: 'booked', booking: res.booking, token: res.token });
          broadcastSchedule();
        } else if (msg.type === 'cancel') {
          if (!schedule.cancel(String(msg.id), String(msg.token))) return send(s, { type: 'error', for: 'cancel', error: 'That booking is already gone.' });
          log(`♫ ${id} cancelled booking ${msg.id}`);
          send(s, { type: 'cancelled', id: msg.id });
          broadcastSchedule();
        } else if (msg.type === 'guests') {
          const n = (v) => Math.max(0, Math.min(MAX_GUESTS, Math.round(Number(v) || 0)));
          s.wants.people = n(msg.people);
          s.wants.ai = n(msg.ai);
          if (msg.variation !== undefined) s.wants.variation = Math.max(0, Math.min(1, Number(msg.variation) || 0));
          if (msg.aspect > 0) { s.aspect = msg.aspect; s.style.aspect = msg.aspect; }
          ensureAi(s);
          assignPeople(s);
          send(s, guestsMsg(s));
          log(`~ ${id} wants guests: ${s.wants.people} people, ${s.wants.ai} AI`);
        } else if (msg.type === 'level') {
          if (LEVELS.video.includes(msg.video)) s.level.video = msg.video;
          if (LEVELS.music.includes(msg.music)) s.level.music = msg.music;
          const dims = msg.w > 0 && msg.h > 0 ? { w: msg.w, h: msg.h } : null;
          if (dims) { s.aspect = dims.w / dims.h; s.style.aspect = s.aspect; }
          s.rec?.label({ level: { ...s.level }, ...(dims ? { video: dims } : {}) });
          if (s.level.music === 'motion') s.music.reset();
        } else if (msg.type === 'music') {
          s.music.push(msg);
          s.rec?.music(msg);
        } else if (msg.type === 'media') {
          if (typeof msg.data === 'string') s.rec?.mediaChunk(msg.kind, msg.mime, Buffer.from(msg.data, 'base64'));
        }
        return;
      }
      if (s.watching) return; // spectators don't dance
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const frame = deserializePoseFrame(buf);
      s.lastFrameAt = now();
      s.lastFrameT = frame.t;
      s.rec?.frame(frame);
      s.detector.update(frame);
      s.style.push(frame);

      // Relay to everyone who has this dancer on their floor: room-mates,
      // spectators, and people who took this dancer in as a guest. They all
      // render it through the same avatar path as delayed-replay guests.
      const peers = rooms.peersOf(s);
      for (const w of sessions.values()) if (w.watching) peers.push(w);
      for (const h of s.hosts) if (!peers.includes(h)) peers.push(h);
      if (peers.length) {
        const env = encodeEnvelope(s.id, new Uint8Array(buf));
        for (const p of peers) {
          if (p.ws.readyState === p.ws.OPEN) p.ws.send(env, { binary: true });
        }
      }
    });
    ws.on('close', () => {
      const left = rooms.leave(s);
      sessions.delete(id);
      for (const p of s.people) p.hosts.delete(s);
      for (const h of s.hosts) {
        h.people = h.people.filter((p) => p !== s);
        send(h, guestsMsg(h));
      }
      const r = s.rec?.close({ bpm: +s.detector.state.bpm.toFixed(1), musicBpm: +s.music.state.bpm.toFixed(1) });
      if (r?.kept) {
        log(`● ${id} session kept for the library (${r.frames} frames)`);
        lib?.add(r.path);
      }
      log(`- ${id} disconnected${left ? ` (was in room ${left})` : ''} (${sessions.size} online)`);
      if (left) { broadcastRoom(left); broadcastLobby(); } else broadcastFloor();
    });
  });

  // AI dancers: stream each one's pose to its host at ~30 fps.
  const aiTimer = setInterval(() => {
    const t = now();
    for (const s of sessions.values()) {
      if (!s.ai.length) continue;
      const bpm = targetBpm(s);
      for (const d of s.ai) {
        d.setTarget({ bpm, aspect: s.aspect, variation: s.wants.variation });
        const f = d.frame(t);
        if (f) sendFrame(s, d.id, serializePoseFrame(f));
      }
    }
  }, AI_TICK_MS);

  // Opinion scan: profiles out, room tempo per room, guests, then
  // tempo-first pairing (within a room) with a next song.
  const timer = setInterval(() => {
    for (const s of dancersOnline()) {
      const m = s.music.state;
      send(s, { type: 'profile', ...profileOf(s), musicBpm: m.bpm, musicConfidence: m.confidence });
      if (dancing(s)) {
        s.rec?.tempo({ t: s.lastFrameT, ...s.detector.state, musicBpm: m.bpm, musicConfidence: m.confidence });
      }
    }
    broadcastLobby();
    if (schedule.prune()) broadcastSchedule();
    assignPeople();
    for (const s of sessions.values()) {
      if (!s.wants.ai && !s.wants.people) continue;
      refreshAi(s);
      send(s, guestsMsg(s));
    }

    const matched = new Set();
    for (const name of rooms.names) {
      broadcastRoom(name);
      const profiles = rooms.members(name).map(profileOf);
      for (const { a, b, bpm } of matcher.pair(profiles)) {
        const song = pickSong(bpm);
        const key = `${[a, b].sort().join('+')}:${song.title}`;
        for (const [me, partner] of [[a, b], [b, a]]) {
          const s = sessions.get(me);
          if (!s) continue;
          matched.add(me);
          if (s.matchKey !== key) {
            s.matchKey = key;
            send(s, { type: 'match', partner, bpm, song });
          }
        }
      }
    }
    for (const s of sessions.values()) {
      if (!matched.has(s.id) && s.matchKey) {
        s.matchKey = null;
        send(s, { type: 'unmatch' });
      }
    }
  }, scanIntervalMs);

  const close = () => {
    clearInterval(timer);
    clearInterval(aiTimer);
    for (const s of sessions.values()) s.ws.terminate();
    wss.close();
  };
  wss.on('close', () => { clearInterval(timer); clearInterval(aiTimer); });

  return { wss, sessions, rooms, schedule, library: lib, close, get port() { return wss.address().port; } };
}

// Run directly: node index.js [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = startServer({ port: Number(process.argv[2]) || 8901 });
  server.wss.on('listening', () => {
    console.log(`dance server listening on ws://0.0.0.0:${server.port}`);
    if (server.library) console.log(`library: ${server.library.size} clips — ${server.library.tags.slice(0, 6).map(([t, n]) => `${t} ${n}`).join(', ')}…`);
  });
}
