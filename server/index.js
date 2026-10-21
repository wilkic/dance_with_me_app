/**
 * Dance-analysis server + dance rooms + guests.
 *
 * Ingests raw PoseFrames from clients over WebSocket (binary frames in the
 * exact serialize format the app already uses), runs a per-dancer
 * BeatDetector server-side, relays frames between the members of a dance
 * room, brings guests into a dancer's space (and, only when RECORD_DIR is
 * set, records sessions into the dance library), and periodically forms
 * opinions:
 *
 *   → { type: 'welcome', id }                     on connect
 *   → { type: 'rooms', rooms }                    lobby: open rooms to pick from
 *   → { type: 'joined', room, created, host }     after a join (host: you can play music)
 *   → { type: 'room', name, bpm, members, host, music }   who's in your room + tempo;
 *                                                 host = the host's id, music = { label } while playing
 *   → { type: 'rtc', from, data }                 WebRTC signalling for room music (host ↔ member)
 *   → { type: 'profile', bpm, confidence, warming, musicBpm, musicConfidence }
 *                                                 bpm: your movement's tempo (0 until it locks;
 *                                                 warming: you're moving, not locked yet);
 *                                                 musicBpm: the music's (room music, else your mic)
 *   → { type: 'guests', people, ai, library }     who is dancing in your space
 *   → { type: 'match', partner, bpm, song }       tempo-compatible pairing
 *   → { type: 'schedule', bookings }              approved DJ sets (see schedule.js)
 *   → { type: 'booked', booking, token }          your request is in, waiting for approval
 *   → { type: 'mine', bookings }                  your own requests, with status
 *   → { type: 'cancelled', id }                   your booking was cancelled
 *   → { type: 'waiting', bookings }               admin only: requests to approve
 *   → { type: 'live-rooms', rooms }               admin only: open rooms, dancers, music
 *   → { type: 'stats', days, online }             admin only: daily visit totals (see stats.js)
 *
 * OBS streaming (whip.js): POST /whip on the same port takes a DJ's WebRTC
 * offer; the server then plays that audio to the room itself ('room'
 * messages carry music { label, live: true }, and 'rtc' offers come from
 * 'live:<room>'). The room's host can't play anything else meanwhile and
 * stopping from their phone ends the stream.
 *   → { type: 'music-stopped' }                   host: an admin stopped your room's music
 *   → { type: 'room-ended' }                      an admin closed your room (you're solo now)
 *   → { type: 'error', error, for }               e.g. for: 'book' — why it was refused
 *   → { type: 'unmatch' }                         pairing dissolved
 *
 *   ← { type: 'join', room, hostKey, bookingToken }   enter a room (creates it; see Rooms)
 *   ← { type: 'leave' }                           back to solo
 *   ← { type: 'guests', people, ai, aspect, variation }   guests wanted in my space
 *   ← { type: 'room-music', on, label }           host: music to the room started/stopped
 *   ← { type: 'rtc', to, data }                   WebRTC signalling, relayed host ↔ member only
 *   ← { type: 'level', video, music, w, h }       what this session shares (see recorder.js)
 *   ← { type: 'music', t0, hz, e, from }          onset envelope of what this phone hears: from 'room'
 *                                                 = the room's music it plays (host or listener),
 *                                                 else its mic (music level beat/audio)
 *   ← { type: 'media', kind, mime, data }         MediaRecorder chunk, base64 (level audio/video)
 *   ← { type: 'label', clickBpm }                 dance-lab ground truth
 *   ← { type: 'watch' }                           become a spectator (dance floor)
 *   ← { type: 'book', dj, start, minutes, setInfo, bio, link }   book a DJ set (/schedule)
 *   ← { type: 'cancel', id, token }               cancel one of your bookings
 *   ← { type: 'mine', tokens }                    follow your own bookings ({ id: token })
 *   ← { type: 'admin', key }                      sign in to approve bookings
 *   ← { type: 'approve' | 'reject', id }          admin: decide on a request
 *   ← { type: 'visit', page, ref, phone }         a page was opened (counted, nothing kept about who)
 *   ← { type: 'stats' }                           admin: send the visit totals again
 *   ← { type: 'stop-music', room }                admin: stop a room's music, no more until it closes
 *   ← { type: 'end-room', room }                  admin: send everyone in a room back to solo
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
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserializePoseFrame, serializePoseFrame } from '../src/pose/poseFormat.js';
import { encodeEnvelope } from '../src/net/envelope.js';
import { BeatDetector } from './beatDetector.js';
import { Matcher } from './matcher.js';
import { Rooms, roomTempo } from './rooms.js';
import { pickSong } from './songs.js';
import { Library } from './library.js';
import { AiDancer, CALM_ENERGY } from './aiDancer.js';
import { SessionRecorder } from './recorder.js';
import { StyleWindow, energyOf } from './style.js';
import { EnvelopeTempo, tempoGap } from './tempo.js';
import { Schedule } from './schedule.js';
import { Stats } from './stats.js';
import { WhipIngest } from './whip.js';
import { normalizeRoomName } from '../src/net/roomNames.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAX_GUESTS = 3;
const ACTIVE_MS = 6000;         // "dancing" = a frame arrived this recently
const ENDED_ROOM_MS = 60 * 60_000; // an ended room's name stays closed this long
const AI_TICK_MS = 33;          // AI dancers stream at ~30 fps
const AI_REFRESH_MS = 120_000;  // an AI dancer moves on to a fresh base clip this often
const MAX_BOOKINGS_PER_SESSION = 10;
const MAX_ADMIN_TRIES = 5;
const MAX_RTC_BYTES = 16_000; // one SDP or ICE candidate
const ROOM_BEAT_MS = 4000;    // a phone's room-music envelope counts this long after its last batch

/**
 * The key that approves DJ bookings: ADMIN_KEY, else server/data/admin-key,
 * created on first start (deploy.sh leaves data/ alone; `deploy.sh admin`
 * prints the admin link).
 */
function loadAdminKey(file, log) {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY;
  try { return readFileSync(file, 'utf8').trim(); } catch { /* first start */ }
  const key = randomBytes(18).toString('base64url');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${key}\n`, { mode: 0o600 });
    log(`admin key created in ${file}`);
  } catch (e) {
    log(`could not save the admin key (${e.message}) — booking approval is off`);
    return null;
  }
  return key;
}
const LEVELS = { video: ['points', 'video'], music: ['motion', 'beat', 'audio'] };

export function startServer({
  port = 8901,
  scanIntervalMs = 2000,
  // Nothing a dancer does is kept by default (see /privacy/). RECORD_DIR=dir
  // records sessions (frames + tempo + what they chose to share) as library
  // material — for your own test sessions; the public server leaves it unset.
  recordDir = process.env.RECORD_DIR && process.env.RECORD_DIR !== '0' ? process.env.RECORD_DIR : null,
  // The dance library behind AI dancers: a Library, null = load the
  // default one (recordings, recordings_web, library/sessions), false = none.
  library = null,
  // DJ bookings (JSON file). SCHEDULE_FILE=0 keeps them in memory only.
  scheduleFile = process.env.SCHEDULE_FILE === '0' ? null : (process.env.SCHEDULE_FILE || join(HERE, 'data', 'schedule.json')),
  // Daily visit totals (stats.js). STATS_FILE=0 keeps them in memory only.
  statsFile = process.env.STATS_FILE === '0' ? null : (process.env.STATS_FILE || join(HERE, 'data', 'stats.json')),
  // OBS streaming (whip.js): UDP port range, and the public IP behind 1:1 NAT.
  whipPorts = process.env.WHIP_PORTS || '50000-50999',
  whipPublicIp = process.env.WHIP_PUBLIC_IP || null,
  // Approves DJ bookings; null = read or create server/data/admin-key.
  adminKey = null,
  log = console.log,
} = {}) {
  // One HTTP server: WebSocket upgrades for the app, plain HTTP for WHIP.
  const http = createServer((req, res) => { if (!whip.handle(req, res)) { res.writeHead(404); res.end(); } });
  const wss = new WebSocketServer({ server: http });
  http.listen(port);
  const sessions = new Map(); // id -> session (see connection handler)
  const rooms = new Rooms();
  const matcher = new Matcher();
  const schedule = new Schedule(scheduleFile, { log });
  const stats = new Stats(statsFile, { log });
  const statsMsg = () => ({ type: 'stats', days: stats.recent(14), online: sessions.size });
  const theAdminKey = adminKey ?? loadAdminKey(join(HERE, 'data', 'admin-key'), log);
  const isAdminKey = (k) => {
    if (!theAdminKey || typeof k !== 'string') return false;
    const a = Buffer.from(k);
    const b = Buffer.from(theAdminKey);
    return a.length === b.length && timingSafeEqual(a, b);
  };
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
  const heard = (st) => (st.bpm > 0 && st.confidence >= 0.3 ? st : null);
  /**
   * The tempo of a room's music: every phone playing it (the host, each
   * listener) measures what it plays; the clearest reading wins.
   */
  const roomMusicBeat = (name) => {
    if (!name || !musicOf(name)) return null;
    let best = null;
    for (const m of rooms.members(name)) {
      const st = now() - m.roomBeatAt < ROOM_BEAT_MS ? heard(m.roomBeat.state) : null;
      if (st && (!best || st.confidence > best.confidence)) best = st;
    }
    return best;
  };
  /** The music this dancer hears, if we can tell its tempo: the room's, else their own mic's. */
  const musicBeat = (s) => roomMusicBeat(s.room) ?? heard(s.music.state);
  /**
   * One beat for everything (AI dancers, guests, pairing, a room's tempo):
   * the music if we hear it, else the dancer's movement.
   */
  const beatOf = (s) => {
    const m = musicBeat(s) ?? heard(s.detector.state);
    return { id: s.id, bpm: m?.bpm ?? 0, confidence: m?.confidence ?? 0 };
  };
  const targetBpm = (s) => beatOf(s).bpm;
  /** A room's tempo: its music's, else the consensus of its dancers' movement. */
  const roomBpm = (name) => roomMusicBeat(name)?.bpm ?? roomTempo(rooms.members(name).map(profileOf));
  const dancing = (s) => !s.watching && s.lastFrameAt > 0 && now() - s.lastFrameAt < ACTIVE_MS;

  // Room host: the one member who can play music to the room. During a
  // booked set it is the DJ (whoever holds the booking's token); otherwise
  // the room's creator (see Rooms.createdBy).
  const isHost = (s, name = s.room) => {
    if (!name || s.room !== name) return false;
    const dj = schedule.djToken(name);
    return dj ? s.bookingToken === dj : rooms.createdBy(s, name);
  };
  const hostOf = (name) => rooms.members(name).find((m) => isHost(m, name)) ?? null;
  const roomMusic = new Map(); // room name -> { label } while its host plays music
  const musicOf = (name) => {
    const live = whip.liveIn(name);
    if (live) return live; // an OBS stream beats anything the host's phone plays
    const m = roomMusic.get(name);
    if (m && !hostOf(name)) roomMusic.delete(name); // host left: the music stopped with them
    return roomMusic.get(name) ?? null;
  };
  // DJs stream from OBS with a key: a booking token (the booked DJ) or the
  // host key of a room shared from a computer (shown in its music sheet).
  const whip = new WhipIngest({
    log,
    ports: whipPorts,
    publicIp: whipPublicIp,
    resolveKey: (key) => {
      const booked = schedule.roomForToken(key);
      if (booked) return silenced.has(booked) ? null : booked;
      // A room's creator — unless a booked DJ has the room right now.
      for (const name of rooms.names) if (rooms.hostKeys.get(name) === key) return silenced.has(name) || schedule.djToken(name) ? null : name;
      return null;
    },
    send: (sid, msg) => { const s = sessions.get(sid); if (s) send(s, msg); },
    onStart: (name) => { roomMusic.delete(name); stats.count('music'); if (rooms.members(name).length) { broadcastRoom(name); broadcastLiveRooms(); } },
    onStop: (name) => { if (rooms.members(name).length) { broadcastRoom(name); broadcastLiveRooms(); } },
  });
  // Everyone in the room but its host listens to the live stream.
  const syncLive = (name) => whip.sync(name, rooms.members(name).filter((m) => !isHost(m, name)).map((m) => m.id));
  const roomMates = (a, b) => !!a.room && a.room === b.room;
  // Acting on reports (see /terms/): an admin can silence a room (no music
  // until it closes) or end it (everyone back to solo; the name stays
  // closed for ENDED_ROOM_MS so it can't simply be reopened).
  const silenced = new Set();   // room names
  const endedRooms = new Map(); // room name -> closed until (ms)
  const roomClosed = (name) => (endedRooms.get(name) ?? 0) > Date.now();

  // Lobby: every open room with how many are dancing and its tempo, so the
  // start screen can list rooms to join. Sent to everyone on connect, on
  // every scan, and immediately when any room's membership changes.
  const lobby = () => ({
    type: 'rooms',
    rooms: rooms.names
      .map((name) => {
        return { name, dancers: rooms.members(name).length, bpm: roomBpm(name) };
      })
      .sort((a, b) => b.dancers - a.dancers || a.name.localeCompare(b.name)),
  });
  const broadcastLobby = () => {
    const msg = lobby();
    for (const s of sessions.values()) send(s, msg);
    broadcastFloor();
    broadcastLiveRooms();
  };

  // Admin: every open room with its dancers and music, to act on reports.
  const liveRooms = () => ({
    type: 'live-rooms',
    rooms: rooms.names.map((name) => ({
      name,
      dancers: rooms.members(name).length,
      music: musicOf(name)?.label ?? null,
      silenced: silenced.has(name),
      live: !!whip.liveIn(name),
    })),
  });
  const broadcastLiveRooms = () => {
    let msg = null;
    for (const s of sessions.values()) if (s.admin) send(s, (msg ??= liveRooms()));
  };

  // DJ schedule: everyone gets the list on connect and whenever it changes
  // (a booking, a cancellation, a set ending — checked on every scan).
  // Approved sets go to everyone; each DJ also follows their own requests
  // (any status), and signed-in admins get the queue waiting for approval.
  const scheduleMsg = () => ({ type: 'schedule', bookings: schedule.list() });
  const broadcastSchedule = () => {
    const msg = scheduleMsg();
    let waiting = null;
    for (const s of sessions.values()) {
      send(s, msg);
      if (s.myBookings) send(s, { type: 'mine', bookings: schedule.mine(s.myBookings) });
      if (s.admin) send(s, (waiting ??= { type: 'waiting', bookings: schedule.waiting() }));
    }
  };

  // Dance floor: what a spectator screen shows — every dancer (with room
  // and tempo) and every room with its consensus tempo and the song the
  // catalog would put on for it. Sent to watchers with every lobby update.
  const dancersOnline = () => [...sessions.values()].filter((s) => !s.watching);
  const floor = () => ({
    type: 'floor',
    dancers: dancersOnline().map((s) => ({ ...profileOf(s), room: s.room })),
    rooms: rooms.names.map((name) => {
      const bpm = roomBpm(name);
      return { name, dancers: rooms.members(name).length, bpm, song: bpm ? pickSong(bpm) : null };
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
    syncLive(name);
    if (!members.length) return;
    const profiles = members.map(profileOf);
    const bpm = roomBpm(name);
    const host = hostOf(name);
    const music = musicOf(name);
    for (const s of members) {
      send(s, {
        type: 'room',
        name,
        bpm,
        host: host?.id ?? null,
        music,
        members: profiles.map((p) => ({ ...p, you: p.id === s.id, host: p.id === host?.id })),
      });
    }
  };

  // ---- Guests: who is dancing in this session's space ----
  const guestsMsg = (s) => ({
    type: 'guests',
    people: s.people.map((p) => ({ ...profileOf(p), room: p.room })),
    ai: s.ai.map((d) => d.info),
    library: lib ? { clips: lib.size } : null,
    target: { bpm: targetBpm(s), music: !!musicBeat(s) },
  });

  /** How busy an AI dancer should look: as busy as this dancer, calm until we know. */
  const wantEnergy = (s) => energyOf(s.style.vector) || CALM_ENERGY;
  /** A library clip for this dancer: their beat, their style, not one already on their floor. */
  const pickClip = (s, exclude) => {
    const desc = lib.pick({ bpm: targetBpm(s), energy: wantEnergy(s), style: s.style.vector, exclude });
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
        targetBpm: targetBpm(s), wantEnergy: wantEnergy(s), aspect: s.aspect, variation: s.wants.variation, now: now(),
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
      roomBeat: new EnvelopeTempo(), roomBeatAt: 0, // the room's music, as this phone plays it
      lastFrameAt: 0, lastFrameT: 0, aspect: 9 / 16, level: { video: 'points', music: 'motion' },
      wants: { people: 0, ai: 0, variation: 0.5 },
      people: [],          // sessions dancing in my space as "other people"
      hosts: new Set(),    // sessions whose space I dance in
      ai: [],              // AiDancer[]
      rec: recordDir ? new SessionRecorder(recordDir, { id }) : null,
      booked: 0,           // bookings made on this connection (rate limit)
      myBookings: null,    // { id: token } — this DJ's requests, followed for status
      admin: false, adminTries: 0,
    };
    sessions.set(id, s);
    send(s, { type: 'welcome', id });
    send(s, lobby());
    send(s, scheduleMsg());
    log(`+ ${id} connected (${sessions.size} online)`);
    stats.online(sessions.size);
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
          const str = (v) => (typeof v === 'string' && v ? v.slice(0, 64) : null);
          s.hostKey = str(msg.hostKey);
          s.bookingToken = str(msg.bookingToken);
          if (roomClosed(normalizeRoomName(msg.room))) {
            return send(s, { type: 'error', for: 'join', error: 'That room was closed. Try another one.' });
          }
          const res = rooms.join(s, msg.room);
          if (!res) return send(s, { type: 'error', error: 'bad room name' });
          send(s, { type: 'joined', room: res.name, created: res.created, host: isHost(s) });
          if (res.created || before !== res.name) stats.count(res.created ? 'shared' : 'joined');
          log(`> ${id} ${res.created ? 'opened' : 'joined'} room ${res.name} (${rooms.members(res.name).length} dancing)`);
          s.rec?.label({ room: res.name });
          if (before && before !== res.name) broadcastRoom(before);
          broadcastRoom(res.name);
          if (res.created || before !== res.name) broadcastLobby();
        } else if (msg.type === 'room-music') {
          if (!isHost(s)) return;
          if (msg.on && silenced.has(s.room)) return send(s, { type: 'music-stopped' });
          if (whip.liveIn(s.room)) {
            // While OBS streams, the host's phone only has a stop button.
            if (!msg.on) whip.end(s.room, 'host stopped it');
            return;
          }
          if (msg.on && !roomMusic.has(s.room)) stats.count('music');
          if (msg.on) roomMusic.set(s.room, { label: String(msg.label ?? '').slice(0, 80) });
          else roomMusic.delete(s.room);
          log(`♪ ${id} ${msg.on ? `plays music to room ${s.room}` : `stopped the music in room ${s.room}`}`);
          broadcastRoom(s.room);
          broadcastLiveRooms();
        } else if (msg.type === 'rtc') {
          if (JSON.stringify(msg.data ?? null).length > MAX_RTC_BYTES) return;
          // To the live stream: the server itself is the other end.
          if (typeof msg.to === 'string' && msg.to === `live:${s.room}`) return void whip.onSignal(s.room, id, msg.data);
          // Signalling for room music: only between a room's host and its members (not while OBS streams).
          if (whip.liveIn(s.room)) return;
          const to = sessions.get(String(msg.to));
          if (!to || !s.room || to.room !== s.room || !(isHost(s) || isHost(to)) || silenced.has(s.room)) return;
          send(to, { type: 'rtc', from: id, data: msg.data });
        } else if (msg.type === 'leave') {
          const wasHost = isHost(s);
          const left = rooms.leave(s);
          if (left && wasHost) roomMusic.delete(left);
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
          stats.count('booked');
          (s.myBookings ??= {})[res.booking.id] = res.token;
          log(`♫ ${id} asked for ${res.booking.dj} (${res.booking.room}) at ${new Date(res.booking.start).toISOString()} for ${res.booking.minutes} min — waiting for approval`);
          send(s, { type: 'booked', booking: res.booking, token: res.token });
          broadcastSchedule();
        } else if (msg.type === 'mine') {
          s.myBookings = msg.tokens && typeof msg.tokens === 'object' ? { ...msg.tokens } : null;
          send(s, { type: 'mine', bookings: schedule.mine(s.myBookings) });
        } else if (msg.type === 'admin') {
          if (s.adminTries >= MAX_ADMIN_TRIES) return;
          if (!isAdminKey(msg.key)) {
            s.adminTries++;
            log(`! ${id} wrong admin key`);
            return send(s, { type: 'error', for: 'admin', error: 'That admin key isn’t right.' });
          }
          s.admin = true;
          log(`♛ ${id} signed in as admin`);
          send(s, { type: 'waiting', bookings: schedule.waiting() });
          send(s, liveRooms());
          send(s, statsMsg());
        } else if (msg.type === 'approve' || msg.type === 'reject') {
          if (!s.admin) return;
          const bid = String(msg.id);
          if (msg.type === 'approve') {
            const res = schedule.approve(bid);
            if (res.error) return send(s, { type: 'error', for: 'approve', error: res.error });
            log(`♫ ${id} approved ${res.booking.dj} (${res.booking.room})`);
          } else if (schedule.reject(bid)) {
            log(`♫ ${id} rejected booking ${bid}`);
          }
          broadcastSchedule();
        } else if (msg.type === 'stop-music' || msg.type === 'end-room') {
          if (!s.admin) return;
          const name = String(msg.room ?? '');
          const members = rooms.members(name);
          if (!members.length) return broadcastLiveRooms();
          if (msg.type === 'stop-music') {
            silenced.add(name);
            roomMusic.delete(name);
            whip.end(name, 'stopped by an admin');
            const host = hostOf(name);
            if (host) send(host, { type: 'music-stopped' });
            log(`♛ ${id} stopped the music in room ${name}`);
            broadcastRoom(name);
          } else {
            endedRooms.set(name, Date.now() + ENDED_ROOM_MS);
            roomMusic.delete(name);
            whip.end(name, 'room ended by an admin');
            for (const m of members) {
              rooms.leave(m);
              send(m, { type: 'room-ended' });
            }
            silenced.delete(name);
            log(`♛ ${id} ended room ${name} (${members.length} dancing)`);
          }
          broadcastLobby();
        } else if (msg.type === 'cancel') {
          if (!schedule.cancel(String(msg.id), String(msg.token))) return send(s, { type: 'error', for: 'cancel', error: 'That booking is already gone.' });
          log(`♫ ${id} cancelled booking ${msg.id}`);
          if (s.myBookings) delete s.myBookings[msg.id];
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
        } else if (msg.type === 'visit') {
          if (s.visited) return; // once per page load
          s.visited = true;
          stats.visit({ page: msg.page, ref: typeof msg.ref === 'string' ? msg.ref : '', phone: !!msg.phone });
        } else if (msg.type === 'stats') {
          if (s.admin) send(s, statsMsg());
        } else if (msg.type === 'music') {
          if (msg.from === 'room') {
            if (!s.room) return;
            if (now() - s.roomBeatAt > ROOM_BEAT_MS) s.roomBeat.reset(); // a new song or a new room
            s.roomBeat.push(msg);
            s.roomBeatAt = now();
          } else {
            s.music.push(msg);
          }
          s.rec?.music(msg);
        } else if (msg.type === 'media') {
          if (typeof msg.data === 'string') s.rec?.mediaChunk(msg.kind, msg.mime, Buffer.from(msg.data, 'base64'));
        }
        return;
      }
      if (s.watching) return; // spectators don't dance
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const frame = deserializePoseFrame(buf);
      if (!s.lastFrameAt) stats.count('danced');
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
      if (isHost(s)) roomMusic.delete(s.room);
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
      const energy = wantEnergy(s);
      for (const d of s.ai) {
        d.setTarget({ bpm, energy, aspect: s.aspect, variation: s.wants.variation });
        const f = d.frame(t);
        if (f) sendFrame(s, d.id, serializePoseFrame(f));
      }
    }
  }, AI_TICK_MS);

  // Opinion scan: profiles out, room tempo per room, guests, then
  // tempo-first pairing (within a room) with a next song.
  const timer = setInterval(() => {
    for (const s of dancersOnline()) {
      const m = musicBeat(s) ?? { bpm: 0, confidence: 0 };
      send(s, { type: 'profile', ...profileOf(s), warming: s.detector.state.warming, musicBpm: m.bpm, musicConfidence: m.confidence });
      if (dancing(s)) {
        s.rec?.tempo({ t: s.lastFrameT, ...s.detector.state, musicBpm: m.bpm, musicConfidence: m.confidence });
      }
    }
    broadcastLobby();
    if (schedule.prune()) broadcastSchedule();
    for (const name of silenced) if (!rooms.members(name).length) silenced.delete(name);
    for (const [name, until] of endedRooms) if (until <= Date.now()) endedRooms.delete(name);
    stats.save();
    assignPeople();
    for (const s of sessions.values()) {
      if (!s.wants.ai && !s.wants.people) continue;
      refreshAi(s);
      send(s, guestsMsg(s));
    }

    const matched = new Set();
    for (const name of rooms.names) {
      broadcastRoom(name);
      for (const { a, b, bpm } of matcher.pair(rooms.members(name).filter(dancing).map(beatOf))) {
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
    stats.save(Date.now(), true);
    whip.close();
    http.close();
    clearInterval(timer);
    clearInterval(aiTimer);
    for (const s of sessions.values()) s.ws.terminate();
    wss.close();
  };
  wss.on('close', () => { clearInterval(timer); clearInterval(aiTimer); });

  return { wss, http, whip, sessions, rooms, schedule, stats, library: lib, close, get port() { return wss.address().port; } };
}

// Run directly: node index.js [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = startServer({ port: Number(process.argv[2]) || 8901 });
  server.wss.on('listening', () => {
    console.log(`dance server listening on ws://0.0.0.0:${server.port}`);
    if (server.library) console.log(`library: ${server.library.size} clips — ${server.library.tags.slice(0, 6).map(([t, n]) => `${t} ${n}`).join(', ')}…`);
  });
  // systemd restarts (deploys) send SIGTERM: write the visit totals first.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.stats.save(Date.now(), true); process.exit(0); });
}
