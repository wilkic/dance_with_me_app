/**
 * Dance-analysis server + dance rooms.
 *
 * Ingests raw PoseFrames from clients over WebSocket (binary frames in the
 * exact serialize format the app already uses), runs a per-dancer
 * BeatDetector server-side, relays frames between the members of a dance
 * room, and periodically forms opinions:
 *
 *   → { type: 'welcome', id }                     on connect
 *   → { type: 'rooms', rooms }                    lobby: open rooms to pick from
 *   → { type: 'joined', room, created }           after a join
 *   → { type: 'room', name, bpm, members }        who's in your room + tempo
 *   → { type: 'profile', bpm, confidence }        the server's read on you
 *   → { type: 'match', partner, bpm, song }       tempo-compatible pairing
 *   → { type: 'unmatch' }                         pairing dissolved
 *
 *   ← { type: 'join', room }                      enter a room (creates it)
 *   ← { type: 'leave' }                           back to solo
 *   ← { type: 'label', clickBpm }                 dance-lab ground truth
 *
 * Text frames are JSON control messages. Binary frames are PoseFrames from
 * the client; binary frames to the client are relay envelopes
 * ([id][PoseFrame], see src/net/envelope.js) carrying room-mates' poses.
 */
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { deserializePoseFrame } from '../src/pose/poseFormat.js';
import { encodeEnvelope } from '../src/net/envelope.js';
import { BeatDetector } from './beatDetector.js';
import { Matcher } from './matcher.js';
import { Rooms, roomTempo } from './rooms.js';
import { pickSong } from './songs.js';

export function startServer({
  port = 8901,
  scanIntervalMs = 2000,
  // Dance-lab data capture: when set (e.g. RECORD_DIR=recordings npm start),
  // every session's frames + label messages are appended to a JSONL file,
  // ready for `node lab/run.js analyze <file>`.
  recordDir = process.env.RECORD_DIR,
} = {}) {
  const wss = new WebSocketServer({ port });
  const sessions = new Map(); // id -> { id, ws, detector, matchKey, room }
  const rooms = new Rooms();
  const matcher = new Matcher();
  if (recordDir) mkdirSync(recordDir, { recursive: true });

  const send = (s, msg) => {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(msg));
  };

  const profileOf = (s) => {
    const { bpm, confidence } = s.detector.state;
    return { id: s.id, bpm, confidence };
  };

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

  wss.on('connection', (ws) => {
    const id = randomUUID().slice(0, 8);
    const s = { id, ws, detector: new BeatDetector(), matchKey: null, room: null };
    sessions.set(id, s);
    send(s, { type: 'welcome', id });
    send(s, lobby());

    let rec = null;
    if (recordDir) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      rec = createWriteStream(join(recordDir, `${stamp}-${id}.jsonl`), { flags: 'a' });
    }

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.type === 'label') {
          // Metronome BPM from ?click=…, kept with the frames as ground truth.
          rec?.write(JSON.stringify(msg) + '\n');
        } else if (msg.type === 'join') {
          const before = s.room;
          const res = rooms.join(s, msg.room);
          if (!res) return send(s, { type: 'error', error: 'bad room name' });
          send(s, { type: 'joined', room: res.name, created: res.created });
          if (before && before !== res.name) broadcastRoom(before);
          broadcastRoom(res.name);
          if (res.created || before !== res.name) broadcastLobby();
        } else if (msg.type === 'leave') {
          const left = rooms.leave(s);
          if (left) { broadcastRoom(left); broadcastLobby(); }
          if (s.matchKey) { s.matchKey = null; send(s, { type: 'unmatch' }); }
        }
        return;
      }
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const frame = deserializePoseFrame(buf);
      rec?.write(JSON.stringify({
        t: Math.round(frame.t),
        k: Array.from(frame.keypoints, (v) => +v.toFixed(4)),
      }) + '\n');
      s.detector.update(frame);

      // Relay to room-mates: they render this dancer through the same
      // avatar path as their delayed-replay guests.
      const peers = rooms.peersOf(s);
      if (peers.length) {
        const env = encodeEnvelope(s.id, new Uint8Array(buf));
        for (const p of peers) {
          if (p.ws.readyState === p.ws.OPEN) p.ws.send(env, { binary: true });
        }
      }
    });
    ws.on('close', () => {
      rec?.end();
      const left = rooms.leave(s);
      sessions.delete(id);
      if (left) { broadcastRoom(left); broadcastLobby(); }
    });
  });

  // Opinion scan: profiles out, room tempo per room, then tempo-first
  // pairing (within a room) with a next song.
  const timer = setInterval(() => {
    for (const s of sessions.values()) send(s, { type: 'profile', ...profileOf(s) });
    broadcastLobby();

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
    for (const s of sessions.values()) s.ws.terminate();
    wss.close();
  };
  wss.on('close', () => clearInterval(timer));

  return { wss, sessions, rooms, close, get port() { return wss.address().port; } };
}

// Run directly: node index.js [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = startServer({ port: Number(process.argv[2]) || 8901 });
  server.wss.on('listening', () => {
    console.log(`dance server listening on ws://0.0.0.0:${server.port}`);
  });
}
