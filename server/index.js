/**
 * Dance-analysis server.
 *
 * Ingests raw PoseFrames from clients over WebSocket (binary frames in the
 * exact serialize format the app already uses), runs a per-dancer
 * BeatDetector server-side, and periodically forms opinions:
 *
 *   → { type: 'welcome', id }                     on connect
 *   → { type: 'profile', bpm, confidence }        the server's read on you
 *   → { type: 'match', partner, bpm, song }       tempo-compatible pairing
 *   → { type: 'unmatch' }                         pairing dissolved
 *
 * Text frames are JSON control messages; binary frames are PoseFrames.
 * Later: relay matched partners' PoseFrames back (they'd render through
 * the client's existing guest-avatar path).
 */
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { deserializePoseFrame } from '../src/pose/poseFormat.js';
import { BeatDetector } from './beatDetector.js';
import { Matcher } from './matcher.js';
import { pickSong } from './songs.js';

export function startServer({ port = 8901, scanIntervalMs = 2000 } = {}) {
  const wss = new WebSocketServer({ port });
  const sessions = new Map(); // id -> { id, ws, detector, matchKey }
  const matcher = new Matcher();

  const send = (s, msg) => {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(msg));
  };

  wss.on('connection', (ws) => {
    const id = randomUUID().slice(0, 8);
    const s = { id, ws, detector: new BeatDetector(), matchKey: null };
    sessions.set(id, s);
    send(s, { type: 'welcome', id });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return; // no client→server JSON messages yet
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      s.detector.update(deserializePoseFrame(buf));
    });
    ws.on('close', () => sessions.delete(id));
  });

  // Opinion scan: profiles out, then tempo-first pairing with a next song.
  const timer = setInterval(() => {
    const profiles = [];
    for (const s of sessions.values()) {
      const { bpm, confidence } = s.detector.state;
      profiles.push({ id: s.id, bpm, confidence });
      send(s, { type: 'profile', bpm, confidence });
    }

    const matched = new Set();
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

  return { wss, sessions, close, get port() { return wss.address().port; } };
}

// Run directly: node index.js [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = startServer({ port: Number(process.argv[2]) || 8901 });
  server.wss.on('listening', () => {
    console.log(`dance-analysis server listening on ws://0.0.0.0:${server.port}`);
  });
}
