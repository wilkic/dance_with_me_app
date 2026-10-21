/**
 * End-to-end synthetic test: start the server, connect two WebSocket
 * clients streaming synthetic PoseFrames in the same dance room, plus a
 * solo dancer who plays their own music (beat numbers only) and asks for
 * an AI dancer. Asserts frames are relayed between room-mates and to the
 * dance floor, the lobby and rooms carry no tempo from dancing (no music
 * there), the solo dancer's AI dancer follows their music, and sessions
 * are recorded into the library.
 *
 * Synthesis note: motion energy is joint *speed*, so a joint oscillating
 * at 1 Hz produces two energy peaks per cycle → 2 Hz → 120 BPM.
 */
import WebSocket from 'ws';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../index.js';
import { Library } from '../library.js';
import { serializePoseFrame, deserializePoseFrame, emptyPoseFrame, KP, STRIDE } from '../../src/pose/poseFormat.js';
import { decodeEnvelope } from '../../src/net/envelope.js';

const setKp = (frame, i, x, y) => {
  const o = i * STRIDE;
  frame.keypoints[o] = x;
  frame.keypoints[o + 1] = y;
  frame.keypoints[o + 3] = 1; // fully visible
};

function makeFrame(tMs, beatBpm) {
  const f = emptyPoseFrame();
  f.t = tMs;
  const oscHz = beatBpm / 60 / 2; // position freq; speed peaks at 2× → beatBpm
  const s = Math.sin(2 * Math.PI * oscHz * (tMs / 1000));
  // Static torso (torso length 0.3 for energy normalization)
  setKp(f, KP.NOSE, 0.5, 0.15);
  setKp(f, KP.LEFT_SHOULDER, 0.42, 0.3);
  setKp(f, KP.RIGHT_SHOULDER, 0.58, 0.3);
  setKp(f, KP.LEFT_ELBOW, 0.38, 0.42);
  setKp(f, KP.RIGHT_ELBOW, 0.62, 0.42);
  setKp(f, KP.LEFT_HIP, 0.44, 0.6);
  setKp(f, KP.RIGHT_HIP, 0.56, 0.6);
  setKp(f, KP.LEFT_KNEE, 0.44, 0.75);
  setKp(f, KP.RIGHT_KNEE, 0.56, 0.75);
  // Oscillating wrists and ankles: the dance
  setKp(f, KP.LEFT_WRIST, 0.34, 0.5 + 0.1 * s);
  setKp(f, KP.RIGHT_WRIST, 0.66, 0.5 - 0.1 * s);
  setKp(f, KP.LEFT_ANKLE, 0.44, 0.92 + 0.03 * s);
  setKp(f, KP.RIGHT_ANKLE, 0.56, 0.92 - 0.03 * s);
  return f;
}

function connectDancer(port, bpm) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const dancer = { bpm, ws, id: null, tempo: null, room: null, relayed: new Map() };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Room-mates' frames, relayed: count them per sender.
        const { dancerId, frameBytes } = decodeEnvelope(new Uint8Array(data));
        const f = deserializePoseFrame(frameBytes);
        const r = dancer.relayed.get(dancerId) ?? { n: 0, lastT: 0 };
        r.n++;
        r.lastT = f.t;
        dancer.relayed.set(dancerId, r);
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === 'welcome') {
        dancer.id = msg.id;
        ws.send(JSON.stringify({ type: 'join', room: 'Test Floor' }));
      } else if (msg.type === 'joined') {
        dancer.joined = msg;
        resolve(dancer);
      } else if (msg.type === 'room') {
        dancer.room = msg;
      } else if (msg.type === 'rooms') {
        dancer.lobby = msg.rooms;
      } else if (msg.type === 'tempo') {
        dancer.tempo = msg;
      } else if (msg.type === 'guests') {
        dancer.guests = msg;
      }
    });
    ws.on('error', reject);
  });
}

/** A solo dancer (no room) who plays their own music and asks for an AI dancer. */
function connectHost(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const h = { ws, id: null, guests: null, relayed: new Map(), tempo: null };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const { dancerId, frameBytes } = decodeEnvelope(new Uint8Array(data));
        const f = deserializePoseFrame(frameBytes);
        const r = h.relayed.get(dancerId) ?? { n: 0, minX: 1, maxX: 0, minY: 1, maxY: 0 };
        r.n++;
        for (let j = 0; j < 33; j++) {
          if (f.keypoints[j * STRIDE + 3] < 0.5) continue;
          r.minX = Math.min(r.minX, f.keypoints[j * STRIDE]); r.maxX = Math.max(r.maxX, f.keypoints[j * STRIDE]);
          r.minY = Math.min(r.minY, f.keypoints[j * STRIDE + 1]); r.maxY = Math.max(r.maxY, f.keypoints[j * STRIDE + 1]);
        }
        h.relayed.set(dancerId, r);
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === 'welcome') {
        h.id = msg.id;
        resolve(h);
      } else if (msg.type === 'guests') {
        h.guests = msg;
      } else if (msg.type === 'tempo') {
        h.tempo = msg;
      }
    });
    ws.on('error', reject);
  });
}

// A throwaway library (two synthetic clips) and recording dir, so the test
// never touches the real one.
const tmp = mkdtempSync(join(tmpdir(), 'dance-e2e-'));
const writeClip = (name, bpm, label) => {
  const lines = [JSON.stringify({ type: 'label', ...label })];
  for (let t = 0; t <= 20000; t += 33) lines.push(JSON.stringify({ t, k: Array.from(makeFrame(t, bpm).keypoints, (v) => +v.toFixed(4)) }));
  writeFileSync(join(tmp, `${name}.jsonl`), lines.join('\n') + '\n');
};
writeClip('salsa-a', 120, { ingest: 'video', tag: 'salsa' });
writeClip('waltz-b', 90, { clickBpm: 90 });
const library = new Library({ dirs: [tmp], cacheFile: null, log: () => {} }).load();
const recordDir = join(tmp, 'sessions');

const server = startServer({ port: 0, scanIntervalMs: 500, library, recordDir, scheduleFile: null, statsFile: null, adminKey: 'test-admin', log: () => {} });
await new Promise((r) => server.wss.on('listening', r));
console.log(`server on port ${server.port}`);

const dancers = await Promise.all([
  connectDancer(server.port, 120),
  connectDancer(server.port, 118),
]);

// A spectator (the big-screen dance floor) watching before anyone dances.
const watcher = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const w = { ws, floor: null, relayed: new Map() };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const { dancerId } = decodeEnvelope(new Uint8Array(data));
      w.relayed.set(dancerId, (w.relayed.get(dancerId) ?? 0) + 1);
      return;
    }
    const msg = JSON.parse(data.toString());
    if (msg.type === 'welcome') ws.send(JSON.stringify({ type: 'watch' }));
    else if (msg.type === 'floor') { w.floor = msg; resolve(w); }
  });
  ws.on('error', reject);
});

// A third dancer, alone in their own space (no room).
const host = await connectHost(server.port);

// Stream 15 virtual seconds of dancing at ~30 fps (frame.t is synthetic,
// so this can be sent as fast as the socket allows).
for (const d of dancers) {
  for (let t = 0; t <= 15000; t += 33) {
    d.ws.send(serializePoseFrame(makeFrame(t, d.bpm)));
  }
}
// The host dances too, and plays their own music at 120 bpm (Play music
// without a room: only the onset envelope reaches the server).
for (let t = 0; t <= 15000; t += 33) host.ws.send(serializePoseFrame(makeFrame(t, 120)));
for (let b = 0; b < 8; b++) {
  const e = Array.from({ length: 30 }, (_, i) => ((((b * 30 + i) / 30) * 2) % 1) < 0.15 ? 1 : 0.05);
  host.ws.send(JSON.stringify({ type: 'music', t0: b * 1000, hz: 30, e }));
}

// Wait for opinion scans to run on the streamed data.
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !(host.tempo?.bpm > 0)) {
  await new Promise((r) => setTimeout(r, 100));
}
// Now that the server knows the host's music, ask for an AI dancer, and
// let it dance for a couple of seconds.
host.ws.send(JSON.stringify({ type: 'guests', ai: 1, aspect: 720 / 1280, variation: 0.7 }));
await new Promise((r) => setTimeout(r, 1500));
// The room dancers keep dancing: 5 more seconds.
for (const d of dancers) {
  for (let t = 15033; t <= 20000; t += 33) d.ws.send(serializePoseFrame(makeFrame(t, d.bpm)));
}
await new Promise((r) => setTimeout(r, 700));

let failed = false;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed = true;
};

check('no tempo from dancing: room-mates without music get bpm 0',
  dancers.every((d) => d.tempo && d.tempo.bpm === 0 && d.room?.bpm === 0));

// ---- Dance floor (spectator) checks ----
{
  const ids = [...dancers.map((d) => d.id), host.id].sort();
  const seen = [...watcher.relayed.keys()].sort();
  check(
    `floor: spectator received frames from all three dancers (${[...watcher.relayed.values()].join('/')})`,
    seen.join() === ids.join() && [...watcher.relayed.values()].every((n) => n >= 455),
  );
  const fd = watcher.floor?.dancers ?? [];
  const fr = watcher.floor?.rooms?.find((r) => r.name === 'test-floor');
  check(
    `floor: lists ${fd.length} dancers (2 in room test-floor, no music so bpm ${fr?.bpm}, host solo)`,
    fd.length === 3 && fd.filter((d) => d.room === 'test-floor').length === 2 && fd.some((d) => d.id === host.id && !d.room) &&
      fr?.dancers === 2 && fr.bpm === 0 && !fd.some((d) => 'bpm' in d),
  );
  check('floor: spectator is not listed as a dancer', !fd.some((d) => d.id === watcher.id));
}

// ---- AI dancer in a solo dancer's space, following their own music ----
{
  const g = host.guests;
  const aiIds = [...host.relayed.keys()].filter((k) => k.startsWith('ai-1-'));
  check(
    `ai: the solo dancer's music heard at ${host.tempo?.bpm?.toFixed?.(1)} bpm`,
    Math.abs((host.tempo?.bpm ?? 0) - 120) < 5 && host.tempo.confidence > 0.3,
  );
  check(
    `ai: 1 AI dancer picked the music-matching clip (${g?.ai?.[0]?.base} — salsa-a @120) from ${g?.library?.clips} clips`,
    g?.ai?.length === 1 && g.ai[0].kind === 'ai' && g.ai[0].base === 'salsa-a' && g.library.clips === 2 && g.target?.music === true,
  );
  const ai = host.relayed.get(aiIds[0]);
  check(
    `ai: streamed ${ai?.n ?? 0} frames, on screen (x ${ai?.minX.toFixed(2)}–${ai?.maxX.toFixed(2)}, y ${ai?.minY.toFixed(2)}–${ai?.maxY.toFixed(2)})`,
    aiIds.length === 1 && ai?.n > 40 && ai.minX > -0.3 && ai.maxX < 1.3 && ai.minY > -0.2 && ai.maxY < 1.2,
  );
  check(
    'ai: only AI dancers came in — no strangers (the room dancers never reached the host)',
    [...host.relayed.keys()].every((k) => k.startsWith('ai-')) && !dancers.some((d) => d.relayed.has(host.id)),
  );
  const before = host.relayed.get(aiIds[0])?.n ?? 0;
  host.ws.send(JSON.stringify({ type: 'guests', ai: 0 }));
  await new Promise((r) => setTimeout(r, 300));
  const mid = host.relayed.get(aiIds[0])?.n ?? 0;
  await new Promise((r) => setTimeout(r, 300));
  check(
    'ai: asking for 0 stops the AI stream',
    host.guests.ai.length === 0 && (host.relayed.get(aiIds[0])?.n ?? 0) === mid && mid >= before,
  );
}

// ---- Dance room checks ----
const [d0, d1] = dancers;
// ---- Lobby checks: the start screen's room list ----
const lob = d0.lobby?.find((r) => r.name === 'test-floor');
check(
  `lobby: lists test-floor with ${lob?.dancers} dancing, no music so bpm ${lob?.bpm}`,
  d0.lobby?.length === 1 && lob?.dancers === 2 && lob.bpm === 0,
);
// A newcomer (not in any room) gets the lobby on connect, before joining.
const newcomer = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.type === 'rooms') { resolve({ ws, lobby: msg.rooms }); }
  });
  ws.on('error', reject);
});
check(
  'lobby: newcomer sees the open room on connect',
  newcomer.lobby.length === 1 && newcomer.lobby[0].name === 'test-floor' && newcomer.lobby[0].dancers === 2,
);
newcomer.ws.close();

check(
  `room: first dancer created "test-floor", second joined it`,
  d0.joined?.room === 'test-floor' && d0.joined.created === true &&
  d1.joined?.room === 'test-floor' && d1.joined.created === false,
);
const nFrames = 455 + 151; // 0..15000 then 15033..20000, both at 33 ms
for (const [me, other] of [[d0, d1], [d1, d0]]) {
  const r = me.relayed.get(other.id);
  check(
    `room: dancer@${me.bpm} received ${r?.n ?? 0}/${nFrames} of dancer@${other.bpm}'s frames (last t=${r?.lastT})`,
    r?.n === nFrames && r.lastT === 19983 && me.relayed.size === 1,
  );
}
check(
  'room: opinion lists both members, both dancing, no tempo per member',
  d0.room?.name === 'test-floor' && d0.room.members.length === 2 &&
  d0.room.members.some((m) => m.you && m.id === d0.id) &&
  d0.room.members.some((m) => !m.you && m.id === d1.id && m.dancing && !('bpm' in m)),
);
// Leaving: the room shrinks for the one who stays.
d1.ws.send(JSON.stringify({ type: 'leave' }));
await new Promise((r) => setTimeout(r, 200));
check(
  'room: after one leaves, the other sees a room of one',
  d0.room?.members.length === 1 && d0.room.members[0].you,
);

for (const d of dancers) d.ws.close();
host.ws.close();
watcher.ws.close();
await new Promise((r) => setTimeout(r, 300));

// ---- Recording checks: every session became library material ----
{
  const files = readdirSync(recordDir).filter((f) => f.endsWith('.jsonl') && f !== 'sessions.jsonl');
  const hostFile = files.find((f) => f.endsWith(`-${host.id}.jsonl`));
  const lines = hostFile ? readFileSync(join(recordDir, hostFile), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  check(
    `recording: ${files.length} dancer sessions kept (spectator/newcomer dropped), host's has frames + music tempo + envelope`,
    files.length === 3 && lines.filter((l) => Array.isArray(l.k)).length === 455 &&
      lines.some((l) => l.type === 'tempo' && l.musicBpm > 100) && lines.some((l) => l.type === 'music'),
  );
  check(`recording: closed sessions joined the library (${library.size} clips now)`, library.size === 5);
}
rmSync(tmp, { recursive: true, force: true });
server.close();
process.exit(failed ? 1 : 0);
